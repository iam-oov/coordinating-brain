import fs from 'node:fs';
import path from 'node:path';

import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from './config.ts';
import { isAdminEmail } from './config.ts';
import type { Db } from './db.ts';
import {
  clearFailures,
  consumeOAuthState,
  createDownloadToken,
  createOAuthState,
  createSession,
  deleteSession,
  getSession,
  pkceChallenge,
  recordFailure,
  retryAfterSeconds,
  useDownloadToken,
} from './auth.ts';
import type { GoogleAuth, GoogleIdentity } from './google.ts';
import { authorizeUrl } from './google.ts';
import type { App, Build, Request } from './store.ts';
import {
  appendLog,
  appsForUser,
  buildForRequest,
  createRequest,
  createRevertRequest,
  decideRequest,
  decideReview,
  forceRequest,
  getApp,
  getBuild,
  getRequest,
  getUser,
  grantApps,
  latestBuildFor,
  listApps,
  listBuilds,
  listRequests,
  upsertGoogleUser,
  userCanUseApp,
} from './store.ts';
import { STATUS_LABEL, fmtDate, html, page } from './web/html.ts';
import { MAX_LENGTH, MIN_LENGTH } from './worker/moderation.ts';

const SESSION_COOKIE = 'cb_session';
const OAUTH_COOKIE = 'cb_oauth';
const OAUTH_COOKIE_PATH = '/auth/google';
const LOGIN_NEXT = ['/apks', '/admin'];
const ADMIN_REFRESH_SEC = 10;

export interface ServerDeps {
  config: Config;
  db: Db;
  google?: GoogleAuth;
  /** Called after the admin approves something, so the worker starts now. */
  wakeWorker?: () => void;
}

type LoginOutcome = { ok: true; token: string; userId: number; userName: string } | { ok: false; status: number; error: string };

// ------------------------------------------------------------- helpers

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(reply: FastifyReply, config: Config, name: string, value: string, maxAgeSec: number, cookiePath: string) {
  const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';
  reply.header(
    'set-cookie',
    `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`,
  );
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

function buildJson(b: Build | null) {
  return b ? { versionCode: b.versionCode, commit: b.commitSha.slice(0, 7), createdAt: b.createdAt } : null;
}

function requestJson(db: Db, r: Request) {
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status] ?? r.status,
    reason: r.reason,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    build: buildJson(buildForRequest(db, r.id)),
  };
}

function appJson(db: Db, a: App, uid: number) {
  return { slug: a.slug, name: a.name, latest: buildJson(latestBuildFor(db, a, uid)) };
}

// -------------------------------------------------------------- server

export function buildServer({ config, db, google, wakeWorker }: ServerDeps): FastifyInstance {
  const app = Fastify({ trustProxy: config.trustProxy, logger: false, bodyLimit: 64 * 1024 });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/', async (_req, reply) => reply.redirect('/apks'));

  /** User id from the API bearer token, or a 401. */
  function apiUser(req: FastifyRequest, reply: FastifyReply): number | null {
    const s = getSession(db, bearer(req));
    if (!s?.userId) {
      reply.code(401).send({ error: 'Sesión vencida. Vuelve a entrar.' });
      return null;
    }
    return s.userId;
  }

  function allowedApp(uid: number, slug: string, reply: FastifyReply): App | null {
    const a = getApp(db, slug);
    if (!a || !userCanUseApp(db, uid, slug)) {
      reply.code(404).send({ error: 'Esa app no existe o tu cuenta no tiene acceso.' });
      return null;
    }
    return a;
  }

  // ------------------------------------------------------------ API

  function blockedError(ip: string): string | null {
    const wait = retryAfterSeconds(db, ip);
    return wait > 0 ? `Demasiados intentos. Espera ${Math.ceil(wait / 60)} min.` : null;
  }

  /** Signs in (or signs up) a verified Google identity and opens a brain session. */
  function startSession(identity: GoogleIdentity, appSlug: string | null): LoginOutcome {
    const admin = isAdminEmail(config, identity.email);
    const res = upsertGoogleUser(db, identity, admin);
    if (!res.ok) {
      return res.error === 'disabled'
        ? { ok: false, status: 403, error: 'Tu cuenta está desactivada.' }
        : { ok: false, status: 409, error: 'La cuenta de admin todavía no está vinculada: ejecuta user:link en el servidor.' };
    }
    if (appSlug && getApp(db, appSlug)) grantApps(db, res.user.id, [appSlug]);
    const token = createSession(db, res.user.id, admin, config.sessionDays);
    return { ok: true, token, userId: res.user.id, userName: res.user.name };
  }

  app.post('/api/login', async (_req, reply) =>
    reply.code(410).send({ error: 'Actualiza la app: ahora se entra con tu cuenta de Google.' }),
  );

  app.post('/api/login/google', async (req, reply) => {
    if (!google) return reply.code(503).send({ error: 'El inicio de sesión con Google no está configurado.' });
    const blocked = blockedError(req.ip);
    if (blocked) return reply.code(429).send({ error: blocked });
    const body = (req.body ?? {}) as { idToken?: unknown; app?: unknown };
    const appSlug = typeof body.app === 'string' ? body.app : null;
    if (appSlug && !getApp(db, appSlug)) return reply.code(404).send({ error: 'Esa app no existe.' });
    let identity: GoogleIdentity;
    try {
      identity = await google.verifier.verify(String(body.idToken ?? ''));
    } catch {
      recordFailure(db, req.ip);
      return reply.code(401).send({ error: 'No se pudo verificar tu cuenta de Google.' });
    }
    clearFailures(db, req.ip);
    const res = startSession(identity, appSlug);
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return {
      token: res.token,
      user: { name: res.userName },
      apps: appsForUser(db, res.userId).map((a) => appJson(db, a, res.userId)),
    };
  });

  app.get('/api/apps', async (req, reply) => {
    const uid = apiUser(req, reply);
    if (uid === null) return reply;
    return { apps: appsForUser(db, uid).map((a) => appJson(db, a, uid)) };
  });

  app.get<{ Params: { slug: string } }>('/api/apps/:slug/requests', async (req, reply) => {
    const uid = apiUser(req, reply);
    if (uid === null) return reply;
    if (!allowedApp(uid, req.params.slug, reply)) return reply;
    return {
      requests: listRequests(db, { userId: uid, appSlug: req.params.slug, limit: 20 }).map((r) => requestJson(db, r)),
    };
  });

  app.post<{ Params: { slug: string } }>('/api/apps/:slug/requests', async (req, reply) => {
    const uid = apiUser(req, reply);
    if (uid === null) return reply;
    if (!allowedApp(uid, req.params.slug, reply)) return reply;
    const text = String((req.body as { text?: unknown } | undefined)?.text ?? '');
    const res = createRequest(db, uid, req.params.slug, text);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return reply.code(201).send({ request: requestJson(db, res.request) });
  });

  app.post<{ Params: { slug: string } }>('/api/apps/:slug/download-link', async (req, reply) => {
    const uid = apiUser(req, reply);
    if (uid === null) return reply;
    const a = allowedApp(uid, req.params.slug, reply);
    if (!a) return reply;
    if (!latestBuildFor(db, a, uid)) return reply.code(404).send({ error: 'Todavía no tienes una versión propia de esta app.' });
    const token = createDownloadToken(db, uid, req.params.slug);
    return { url: `${config.publicUrl}/apks/${req.params.slug}/latest.apk?dl=${token}` };
  });

  // --------------------------------------------------------- portal

  function portalUser(req: FastifyRequest): number | null {
    return getSession(db, cookies(req)[SESSION_COOKIE])?.userId ?? null;
  }

  app.get('/apks', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    const uid = portalUser(req);
    if (uid === null) return page('Cerebro · APKs', loginPage('Cerebro', '/apks', google !== undefined));
    const name = getUser(db, uid)?.name ?? '';
    const apps = appsForUser(db, uid);
    return page(
      'Cerebro · APKs',
      html`
        <div class="row" style="justify-content:space-between">
          <div><h1>Tus apps</h1><div class="muted">Hola, ${name}.</div></div>
          <div class="row">
            ${isAdmin(req) ? html`<a class="button" href="/admin">Admin</a>` : ''}
            <form method="post" action="/apks/logout"><button class="secondary">Salir</button></form>
          </div>
        </div>
        ${apps.length === 0 ? html`<div class="card">Tu cuenta todavía no tiene apps asignadas.</div>` : ''}
        <p class="muted">Tus solicitudes y tu versión de cada app son públicas en GitHub.</p>
        ${apps.map((a) => portalAppCard(a, uid))}
      `,
    );
  });

  function portalAppCard(a: App, uid: number) {
    const b = latestBuildFor(db, a, uid);
    const reqs = listRequests(db, { userId: uid, appSlug: a.slug, limit: 5 });
    return html`
      <section class="card">
        <h2>${a.name}</h2>
        ${b
          ? html`<p><a class="button" href="/apks/${a.slug}/latest.apk">Descargar APK v${b.versionCode}</a>
              <span class="muted">· ${fmtDate(b.createdAt)} · ${b.commitSha.slice(0, 7)}</span></p>`
          : html`<p class="muted">Todavía no tienes una versión propia de ${a.name}. Envía una solicitud y, cuando se publique, podrás descargarla aquí.</p>`}
        <form method="post" action="/apks/${a.slug}/requests">
          <textarea name="text" rows="2" minlength="${MIN_LENGTH}" maxlength="${MAX_LENGTH}"
            placeholder="¿Qué mejorarías de ${a.name}?" required></textarea>
          <p><button>Enviar solicitud</button></p>
        </form>
        ${reqs.length
          ? html`<ul class="list">${reqs.map(
              (r) => html`<li><div class="row" style="justify-content:space-between">
                <span>${r.text}</span><span class="status ${r.status}">${STATUS_LABEL[r.status]}</span></div>
                ${r.reason ? html`<div class="muted">${r.reason}</div>` : ''}</li>`,
            )}</ul>`
          : ''}
      </section>`;
  }

  app.get<{ Querystring: { next?: string; app?: string } }>('/auth/google/start', async (req, reply) => {
    if (!google) return reply.code(503).send('El inicio de sesión con Google no está configurado.');
    const next = LOGIN_NEXT.includes(req.query.next ?? '') ? (req.query.next as string) : '/apks';
    const appSlug = req.query.app && getApp(db, req.query.app) ? req.query.app : null;
    const start = createOAuthState(db, next, appSlug);
    setCookie(reply, config, OAUTH_COOKIE, start.browserToken, 600, OAUTH_COOKIE_PATH);
    return reply.redirect(
      authorizeUrl(google.clientId, `${config.publicUrl}/auth/google/callback`, start.state, start.nonce, pkceChallenge(start.verifier)),
      302,
    );
  });

  app.get<{ Querystring: { code?: string; state?: string } }>('/auth/google/callback', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    const fail = (status: number, message: string) =>
      reply.code(status).send(page('Cerebro', html`<div class="card"><p class="error">${message}</p><p><a href="/apks">Volver</a></p></div>`));
    if (!google) return fail(503, 'El inicio de sesión con Google no está configurado.');
    const blocked = blockedError(req.ip);
    if (blocked) return fail(429, blocked);
    const state = req.query.state ? consumeOAuthState(db, req.query.state, cookies(req)[OAUTH_COOKIE]) : null;
    if (!state || !req.query.code) return fail(400, 'El inicio de sesión venció o no es válido. Intenta de nuevo.');
    let identity: GoogleIdentity;
    try {
      const idToken = await google.exchange.exchange(req.query.code, state.verifier, `${config.publicUrl}/auth/google/callback`);
      identity = await google.verifier.verify(idToken, state.nonce);
    } catch {
      recordFailure(db, req.ip);
      return fail(401, 'No se pudo verificar tu cuenta de Google.');
    }
    clearFailures(db, req.ip);
    const res = startSession(identity, state.appSlug);
    if (!res.ok) return fail(res.status, res.error);
    setCookie(reply, config, SESSION_COOKIE, res.token, config.sessionDays * 86400, '/');
    setCookie(reply, config, OAUTH_COOKIE, '', 0, OAUTH_COOKIE_PATH);
    return reply.redirect(state.next, 303);
  });

  app.post('/apks/logout', async (req, reply) => {
    deleteSession(db, cookies(req)[SESSION_COOKIE]);
    setCookie(reply, config, SESSION_COOKIE, '', 0, '/');
    return reply.redirect('/apks', 303);
  });

  app.post<{ Params: { slug: string } }>('/apks/:slug/requests', async (req, reply) => {
    const uid = portalUser(req);
    if (uid === null || !userCanUseApp(db, uid, req.params.slug)) return reply.redirect('/apks', 303);
    const text = String((req.body as { text?: unknown } | undefined)?.text ?? '');
    const res = createRequest(db, uid, req.params.slug, text);
    if (!res.ok) {
      reply.code(400).type('text/html; charset=utf-8');
      return page('Cerebro', html`<div class="card"><p class="error">${res.error}</p><p><a href="/apks">Volver</a></p></div>`);
    }
    return reply.redirect('/apks', 303);
  });

  app.get<{ Params: { slug: string }; Querystring: { dl?: string } }>('/apks/:slug/latest.apk', async (req, reply) => {
    const slug = req.params.slug;
    let uid = portalUser(req);
    if (uid === null && req.query.dl) uid = useDownloadToken(db, req.query.dl, slug);
    const a = getApp(db, slug);
    if (uid === null || !a || !userCanUseApp(db, uid, slug)) return reply.code(404).send('No encontrado');
    const b = latestBuildFor(db, a, uid);
    if (!b) return reply.code(404).send('Todavía no tienes una versión propia de esta app.');
    const file = path.join(config.apksDir, slug, b.apkFile);
    if (!fs.existsSync(file)) return reply.code(404).send('El archivo del APK no está en el servidor.');
    reply
      .type('application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="${slug}-v${b.versionCode}.apk"`)
      .header('cache-control', 'no-store');
    return reply.send(fs.createReadStream(file));
  });

  // ---------------------------------------------------------- admin

  /** Admin rights need the session flag and an email still listed in ADMIN_EMAILS. */
  function isAdmin(req: FastifyRequest): boolean {
    const s = getSession(db, cookies(req)[SESSION_COOKIE]);
    return !!s?.isAdmin && isAdminEmail(config, getUser(db, s.userId)?.email);
  }

  app.get('/admin', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    if (!isAdmin(req)) {
      if (portalUser(req) !== null) {
        reply.code(403);
        return page('Cerebro · admin', html`<div class="card">Tu cuenta no es de administrador. <a href="/apks">Volver</a></div>`);
      }
      return page('Cerebro · admin', loginPage('Cerebro · admin', '/admin', google !== undefined));
    }
    const all = listRequests(db, { limit: 60 });
    const pending = all.filter((r) => r.status === 'pending');
    const review = all.filter((r) => r.status === 'review');
    const queue = all.filter((r) => r.status === 'approved' || r.status === 'running');
    const done = all.filter((r) => !['pending', 'approved', 'running', 'review'].includes(r.status));
    return page(
      'Cerebro · admin',
      html`
        <div class="row" style="justify-content:space-between">
          <h1>Cerebro · admin</h1>
          <div class="row">
            <a class="button" href="/apks">Mis APKs</a>
            <form method="post" action="/apks/logout"><button class="secondary">Salir</button></form>
          </div>
        </div>
        <section class="card"><h2>Por aprobar (${pending.length})</h2>
          ${pending.length ? html`<ul class="list">${pending.map(adminPendingItem)}</ul>` : html`<p class="muted">Nada pendiente.</p>`}
        </section>
        ${review.length
          ? html`<section class="card"><h2>Por revisar (${review.length})</h2>
              <p class="muted">Solicitudes forzadas: pasaron las pruebas en el sandbox. Lee el diff antes de compilar y publicar.</p>
              <ul class="list">${review.map(adminReviewItem)}</ul></section>`
          : ''}
        <section class="card"><h2>En cola / implementando (${queue.length})</h2>
          ${queue.length ? html`<ul class="list">${queue.map((r) => adminHistoryItem(r, true))}</ul>` : html`<p class="muted">Vacía.</p>`}
        </section>
        ${listApps(db).map(adminBuildsCard)}
        <section class="card"><h2>Historial</h2>
          ${done.length ? html`<ul class="list">${done.map((r) => adminHistoryItem(r))}</ul>` : html`<p class="muted">Sin historial.</p>`}
        </section>
      `,
      { refreshSec: queue.length ? ADMIN_REFRESH_SEC : undefined },
    );
  });

  function authorIsAdmin(r: Request): boolean {
    return r.userId !== null && isAdminEmail(config, getUser(db, r.userId)?.email);
  }

  function adminPendingItem(r: Request) {
    return html`<li>
      <div><strong>${r.appSlug}</strong> · ${r.userName ?? 'sistema'} · <span class="muted">${fmtDate(r.createdAt)}</span></div>
      <p>${r.text}</p>
      ${r.flags.map((f) => html`<div class="flag">⚠ ${f}</div>`)}
      <div class="row">
        <form method="post" action="/admin/requests/${r.id}/approve" class="row">
          ${authorIsAdmin(r)
            ? html`<label class="row"><input type="checkbox" name="alsoMain" value="on" style="width:auto"> También a main</label>`
            : ''}
          <button>Aprobar</button>
        </form>
        <form method="post" action="/admin/requests/${r.id}/reject" class="row">
          <input type="text" name="reason" placeholder="Motivo (opcional)" style="width:auto">
          <button class="danger">Rechazar</button>
        </form>
      </div>
    </li>`;
  }

  function adminReviewItem(r: Request) {
    return html`<li>
      <div><strong>#${r.id}</strong> ${r.appSlug} · ${r.userName ?? 'sistema'} · <span class="muted">main + ${r.branch}</span></div>
      <p>${r.text}</p>
      ${r.reason ? html`<p class="muted">${r.reason}</p>` : ''}
      <details open><summary>Diff</summary><pre style="max-height:480px">${r.reviewPatch ?? ''}</pre></details>
      ${r.log ? html`<details><summary class="muted">Log</summary><pre>${r.log}</pre></details>` : ''}
      <div class="row">
        <form method="post" action="/admin/requests/${r.id}/publish"><button>Publicar</button></form>
        <form method="post" action="/admin/requests/${r.id}/discard"><button class="danger">Descartar</button></form>
      </div>
    </li>`;
  }

  function adminHistoryItem(r: Request, openLog = false) {
    return html`<li>
      <div class="row" style="justify-content:space-between">
        <span><strong>#${r.id}</strong> ${r.appSlug} · ${r.userName ?? 'sistema'} · <span class="muted">${r.branch}${r.alsoMain ? ' + main' : ''}</span></span>
        <span class="status ${r.status}">${STATUS_LABEL[r.status]}</span>
      </div>
      <div>${r.text}</div>
      ${r.reason ? html`<div class="muted">${r.reason}</div>` : ''}
      ${r.log ? html`<details ${openLog ? 'open' : ''}><summary class="muted">Log</summary><pre>${r.log}</pre></details>` : ''}
      ${r.kind === 'change' && (r.status === 'failed' || r.status === 'discarded')
        ? html`<form method="post" action="/admin/requests/${r.id}/force" class="row">
            <button class="secondary">Forzar</button>
            <span class="muted">Desbloquea el núcleo, dependencias y permisos de Android. Va a main y pide revisar el diff antes de publicar.</span>
          </form>`
        : ''}
    </li>`;
  }

  function adminBuildsCard(a: App) {
    const byBranch = new Map<string, Build[]>();
    for (const b of listBuilds(db, a.slug, 40)) byBranch.set(b.branch, [...(byBranch.get(b.branch) ?? []), b]);
    const branches = [...byBranch.keys()].sort((x, y) => (x === a.branch ? -1 : y === a.branch ? 1 : x.localeCompare(y)));
    return html`<section class="card"><h2>APKs de ${a.name}</h2>
      ${branches.length
        ? branches.map(
            (branch) => html`<h3>${branch}</h3><ul class="list">${byBranch
              .get(branch)!
              .slice(0, 5)
              .map(
                (b, i) => html`<li class="row" style="justify-content:space-between">
                  <span>v${b.versionCode} · ${b.commitSha.slice(0, 7)} · <span class="muted">${fmtDate(b.createdAt)}</span>
                    ${i === 0 ? html` <span class="status built">actual</span>` : ''}</span>
                  <form method="post" action="/admin/builds/${b.id}/revert"><button class="secondary">Revertir este cambio</button></form>
                </li>`,
              )}</ul>`,
          )
        : html`<p class="muted">Sin builds todavía.</p>`}
    </section>`;
  }

  app.post<{ Params: { id: string } }>('/admin/requests/:id/approve', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    const r = getRequest(db, Number(req.params.id));
    const alsoMain = (req.body as { alsoMain?: unknown } | undefined)?.alsoMain === 'on' && !!r && authorIsAdmin(r);
    if (r && decideRequest(db, r.id, { approve: true, alsoMain })) wakeWorker?.();
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/reject', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '').trim();
    decideRequest(db, Number(req.params.id), { approve: false, reason: reason || null });
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/force', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    const id = Number(req.params.id);
    if (forceRequest(db, id)) {
      appendLog(db, id, 'Forzada por el admin: núcleo, dependencias y permisos de Android desbloqueados; pide revisión antes de publicar');
      wakeWorker?.();
    }
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/publish', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    if (decideReview(db, Number(req.params.id), true)) wakeWorker?.();
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/discard', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    decideReview(db, Number(req.params.id), false);
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/builds/:id/revert', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    const b = getBuild(db, Number(req.params.id));
    if (b) {
      createRevertRequest(db, b);
      wakeWorker?.();
    }
    return reply.redirect('/admin', 303);
  });

  return app;
}

function loginPage(title: string, next: string, enabled: boolean) {
  return html`
    <h1>${title}</h1>
    <div class="card">
      ${enabled
        ? html`<p><a class="button" href="/auth/google/start?next=${encodeURIComponent(next)}">Entrar con Google</a></p>`
        : html`<p class="error">El inicio de sesión con Google no está configurado.</p>`}
    </div>`;
}
