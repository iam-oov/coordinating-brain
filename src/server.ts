import fs from 'node:fs';
import path from 'node:path';

import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from './config.ts';
import type { Db } from './db.ts';
import {
  createDownloadToken,
  createSession,
  deleteSession,
  getSession,
  loginAdmin,
  loginWithCode,
  useDownloadToken,
} from './auth.ts';
import type { App, Build, Request } from './store.ts';
import {
  appsForUser,
  buildForRequest,
  createRequest,
  createRevertRequest,
  decideRequest,
  getApp,
  getBuild,
  latestBuild,
  listApps,
  listBuilds,
  listRequests,
  userCanUseApp,
} from './store.ts';
import { STATUS_LABEL, fmtDate, html, page } from './web/html.ts';
import { MAX_LENGTH, MIN_LENGTH } from './worker/moderation.ts';

const USER_COOKIE = 'cb_session';
const ADMIN_COOKIE = 'cb_admin';

export interface ServerDeps {
  config: Config;
  db: Db;
  /** Called after the admin approves something, so the worker starts now. */
  wakeWorker?: () => void;
}

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

function appJson(db: Db, a: App) {
  return { slug: a.slug, name: a.name, latest: buildJson(latestBuild(db, a.slug)) };
}

// -------------------------------------------------------------- server

export function buildServer({ config, db, wakeWorker }: ServerDeps): FastifyInstance {
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
      reply.code(401).send({ error: 'Sesión vencida. Vuelve a poner tu código.' });
      return null;
    }
    return s.userId;
  }

  function allowedApp(uid: number, slug: string, reply: FastifyReply): App | null {
    const a = getApp(db, slug);
    if (!a || !userCanUseApp(db, uid, slug)) {
      reply.code(404).send({ error: 'Esa app no existe o tu código no tiene acceso.' });
      return null;
    }
    return a;
  }

  // ------------------------------------------------------------ API

  app.post('/api/login', async (req, reply) => {
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? '');
    const res = loginWithCode(db, code, req.ip);
    if (res.kind === 'blocked') {
      reply.header('retry-after', String(res.retryAfter));
      return reply.code(429).send({
        error: `Demasiados intentos. Espera ${Math.ceil(res.retryAfter / 60)} min.`,
        retryAfter: res.retryAfter,
      });
    }
    if (res.kind === 'invalid') return reply.code(401).send({ error: 'Código incorrecto.' });
    const token = createSession(db, res.user.id, false, config.sessionDays);
    return {
      token,
      user: { name: res.user.name },
      apps: appsForUser(db, res.user.id).map((a) => appJson(db, a)),
    };
  });

  app.get('/api/apps', async (req, reply) => {
    const uid = apiUser(req, reply);
    if (uid === null) return reply;
    return { apps: appsForUser(db, uid).map((a) => appJson(db, a)) };
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
    if (!allowedApp(uid, req.params.slug, reply)) return reply;
    if (!latestBuild(db, req.params.slug)) return reply.code(404).send({ error: 'Todavía no hay un APK de esta app.' });
    const token = createDownloadToken(db, uid, req.params.slug);
    return { url: `${config.publicUrl}/apks/${req.params.slug}/latest.apk?dl=${token}` };
  });

  // --------------------------------------------------------- portal

  function portalUser(req: FastifyRequest): number | null {
    return getSession(db, cookies(req)[USER_COOKIE])?.userId ?? null;
  }

  app.get('/apks', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    const uid = portalUser(req);
    if (uid === null) return page('Cerebro · APKs', loginForm('/apks/login', 'Escribe tu código de 4 dígitos.'));
    const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(uid) as { name: string }).name;
    const apps = appsForUser(db, uid);
    return page(
      'Cerebro · APKs',
      html`
        <div class="row" style="justify-content:space-between">
          <div><h1>Tus apps</h1><div class="muted">Hola, ${name}.</div></div>
          <form method="post" action="/apks/logout"><button class="secondary">Salir</button></form>
        </div>
        ${apps.length === 0 ? html`<div class="card">Tu código todavía no tiene apps asignadas.</div>` : ''}
        ${apps.map((a) => portalAppCard(a, uid))}
      `,
    );
  });

  function portalAppCard(a: App, uid: number) {
    const b = latestBuild(db, a.slug);
    const reqs = listRequests(db, { userId: uid, appSlug: a.slug, limit: 5 });
    return html`
      <section class="card">
        <h2>${a.name}</h2>
        ${b
          ? html`<p><a class="button" href="/apks/${a.slug}/latest.apk">Descargar APK v${b.versionCode}</a>
              <span class="muted">· ${fmtDate(b.createdAt)} · ${b.commitSha.slice(0, 7)}</span></p>`
          : html`<p class="muted">Todavía no hay un APK de esta app.</p>`}
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

  app.post('/apks/login', async (req, reply) => {
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? '');
    const res = loginWithCode(db, code, req.ip);
    reply.type('text/html; charset=utf-8');
    if (res.kind === 'blocked') {
      reply.code(429);
      return page('Cerebro', loginForm('/apks/login', `Demasiados intentos. Espera ${Math.ceil(res.retryAfter / 60)} min.`, true));
    }
    if (res.kind === 'invalid') {
      reply.code(401);
      return page('Cerebro', loginForm('/apks/login', 'Código incorrecto.', true));
    }
    const token = createSession(db, res.user.id, false, config.sessionDays);
    setCookie(reply, config, USER_COOKIE, token, config.sessionDays * 86400, '/');
    return reply.redirect('/apks', 303);
  });

  app.post('/apks/logout', async (req, reply) => {
    deleteSession(db, cookies(req)[USER_COOKIE]);
    setCookie(reply, config, USER_COOKIE, '', 0, '/');
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
    if (uid === null || !userCanUseApp(db, uid, slug)) return reply.code(404).send('No encontrado');
    const b = latestBuild(db, slug);
    if (!b) return reply.code(404).send('Todavía no hay un APK de esta app.');
    const file = path.join(config.apksDir, slug, b.apkFile);
    if (!fs.existsSync(file)) return reply.code(404).send('El archivo del APK no está en el servidor.');
    reply
      .type('application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="${slug}-v${b.versionCode}.apk"`)
      .header('cache-control', 'no-store');
    return reply.send(fs.createReadStream(file));
  });

  // ---------------------------------------------------------- admin

  function isAdmin(req: FastifyRequest): boolean {
    return getSession(db, cookies(req)[ADMIN_COOKIE])?.isAdmin === true;
  }

  app.get('/admin', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    if (!config.adminPassword) {
      return page('Cerebro · admin', html`<div class="card">El panel está apagado: falta ADMIN_PASSWORD (16+ caracteres).</div>`);
    }
    if (!isAdmin(req)) return page('Cerebro · admin', adminLoginForm(''));
    const all = listRequests(db, { limit: 60 });
    const pending = all.filter((r) => r.status === 'pending');
    const queue = all.filter((r) => r.status === 'approved' || r.status === 'running');
    const done = all.filter((r) => !['pending', 'approved', 'running'].includes(r.status));
    return page(
      'Cerebro · admin',
      html`
        <div class="row" style="justify-content:space-between">
          <h1>Cerebro · admin</h1>
          <form method="post" action="/admin/logout"><button class="secondary">Salir</button></form>
        </div>
        <section class="card"><h2>Por aprobar (${pending.length})</h2>
          ${pending.length ? html`<ul class="list">${pending.map(adminPendingItem)}</ul>` : html`<p class="muted">Nada pendiente.</p>`}
        </section>
        <section class="card"><h2>En cola / implementando (${queue.length})</h2>
          ${queue.length ? html`<ul class="list">${queue.map(adminHistoryItem)}</ul>` : html`<p class="muted">Vacía.</p>`}
        </section>
        ${listApps(db).map(adminBuildsCard)}
        <section class="card"><h2>Historial</h2>
          ${done.length ? html`<ul class="list">${done.map(adminHistoryItem)}</ul>` : html`<p class="muted">Sin historial.</p>`}
        </section>
      `,
    );
  });

  function adminPendingItem(r: Request) {
    return html`<li>
      <div><strong>${r.appSlug}</strong> · ${r.userName ?? 'sistema'} · <span class="muted">${fmtDate(r.createdAt)}</span></div>
      <p>${r.text}</p>
      ${r.flags.map((f) => html`<div class="flag">⚠ ${f}</div>`)}
      <div class="row">
        <form method="post" action="/admin/requests/${r.id}/approve"><button>Aprobar</button></form>
        <form method="post" action="/admin/requests/${r.id}/reject" class="row">
          <input type="text" name="reason" placeholder="Motivo (opcional)" style="width:auto">
          <button class="danger">Rechazar</button>
        </form>
      </div>
    </li>`;
  }

  function adminHistoryItem(r: Request) {
    return html`<li>
      <div class="row" style="justify-content:space-between">
        <span><strong>#${r.id}</strong> ${r.appSlug} · ${r.userName ?? 'sistema'}</span>
        <span class="status ${r.status}">${STATUS_LABEL[r.status]}</span>
      </div>
      <div>${r.text}</div>
      ${r.reason ? html`<div class="muted">${r.reason}</div>` : ''}
      ${r.log ? html`<details><summary class="muted">Log</summary><pre>${r.log}</pre></details>` : ''}
    </li>`;
  }

  function adminBuildsCard(a: App) {
    const builds = listBuilds(db, a.slug, 10);
    return html`<section class="card"><h2>APKs de ${a.name}</h2>
      ${builds.length
        ? html`<ul class="list">${builds.map(
            (b, i) => html`<li class="row" style="justify-content:space-between">
              <span>v${b.versionCode} · ${b.commitSha.slice(0, 7)} · <span class="muted">${fmtDate(b.createdAt)}</span>
                ${i === 0 ? html` <span class="status built">actual</span>` : ''}</span>
              <form method="post" action="/admin/builds/${b.id}/revert"><button class="secondary">Revertir este cambio</button></form>
            </li>`,
          )}</ul>`
        : html`<p class="muted">Sin builds todavía.</p>`}
    </section>`;
  }

  app.post('/admin/login', async (req, reply) => {
    const password = String((req.body as { password?: unknown } | undefined)?.password ?? '');
    const res = loginAdmin(db, config.adminPassword, password, req.ip);
    reply.type('text/html; charset=utf-8');
    if (res === 'disabled') return reply.code(404).send('No encontrado');
    if (typeof res === 'object') {
      reply.code(429);
      return page('Cerebro · admin', adminLoginForm(`Demasiados intentos. Espera ${Math.ceil(res.retryAfter / 60)} min.`));
    }
    if (res === 'invalid') {
      reply.code(401);
      return page('Cerebro · admin', adminLoginForm('Clave incorrecta.'));
    }
    const token = createSession(db, null, true, 1);
    setCookie(reply, config, ADMIN_COOKIE, token, 86400, '/admin');
    return reply.redirect('/admin', 303);
  });

  app.post('/admin/logout', async (req, reply) => {
    deleteSession(db, cookies(req)[ADMIN_COOKIE]);
    setCookie(reply, config, ADMIN_COOKIE, '', 0, '/admin');
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/approve', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    if (decideRequest(db, Number(req.params.id), true, null)) wakeWorker?.();
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/reject', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Prohibido');
    const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '').trim();
    decideRequest(db, Number(req.params.id), false, reason || null);
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

function loginForm(action: string, message: string, isError = false) {
  return html`
    <h1>Cerebro</h1>
    <form class="card" method="post" action="${action}">
      <p class="${isError ? 'error' : 'muted'}">${message}</p>
      <div class="row">
        <input class="code" type="password" name="code" inputmode="numeric" pattern="\\d{4}" maxlength="4"
          autocomplete="one-time-code" required autofocus>
        <button>Entrar</button>
      </div>
    </form>`;
}

function adminLoginForm(message: string) {
  return html`
    <h1>Cerebro · admin</h1>
    <form class="card" method="post" action="/admin/login">
      ${message ? html`<p class="error">${message}</p>` : ''}
      <div class="row">
        <input type="password" name="password" autocomplete="current-password" required autofocus style="flex:1">
        <button>Entrar</button>
      </div>
    </form>`;
}
