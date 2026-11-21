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
  latestBuildOn,
  listApps,
  listBuilds,
  listRequests,
  upsertGoogleUser,
  userBranch,
  userCanUseApp,
} from './store.ts';
import { appPage } from './web/catalog.ts';
import { STATUS_LABEL, USER_STATUS_LABEL, fmtDate, fmtDay, html, page, raw, renderDiff } from './web/html.ts';
import { BRAND_MARK, appDetailPage, footer, landingPage, privacyPage, signInButton } from './web/landing.ts';
import { MAX_LENGTH, MIN_LENGTH } from './worker/moderation.ts';

const FONTS_DIR = path.join(import.meta.dirname, '..', 'public', 'fonts');
const SESSION_COOKIE = 'cb_session';
const OAUTH_COOKIE = 'cb_oauth';
const OAUTH_COOKIE_PATH = '/auth/google';
const LOGIN_NEXT = ['/apks', '/admin'];
const DOWNLOAD_ICON = raw(
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>',
);
const GLOBE_ICON = raw(
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>',
);
const PLUS_ICON = raw(
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
);
const CROSS_ICON = raw(
  '<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>',
);
const SEED_BRANCH = raw(
  '<svg width="40" height="56" viewBox="0 0 40 56" fill="none" stroke-linecap="round" aria-hidden="true" style="flex:none"><path d="M8 2v52" stroke="var(--fg)" stroke-width="3"/><path d="M8 16c0 10 22 6 22 18v20" stroke="var(--branch)" stroke-width="3" stroke-dasharray="4 6"/><circle cx="30" cy="46" r="5" fill="var(--bg)" stroke="var(--branch)" stroke-width="2.5"/></svg>',
);
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
    statusLabel: USER_STATUS_LABEL[r.status] ?? r.status,
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

  const FONT_FILES = new Set(['bricolage-grotesque-latin.woff2', 'bricolage-grotesque-latin-ext.woff2']);
  app.get<{ Params: { file: string } }>('/fonts/:file', async (req, reply) => {
    if (!FONT_FILES.has(req.params.file)) return reply.code(404).send('No encontrado');
    reply.type('font/woff2').header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(path.join(FONTS_DIR, req.params.file)));
  });
  app.get('/', async (req, reply) => {
    if (portalUser(req) !== null) return reply.redirect('/apks', 303);
    return reply.type('text/html; charset=utf-8').send(page('Cerebro', landingPage(google !== undefined), { bodyClass: 'landing' }));
  });

  app.get('/privacidad', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(page('Cerebro · Privacidad', privacyPage(google !== undefined), { bodyClass: 'landing' })),
  );

  app.get<{ Params: { slug: string } }>('/apps/:slug', async (req, reply) => {
    const info = appPage(req.params.slug);
    const a = getApp(db, req.params.slug);
    if (!info || !a) return reply.code(404).type('text/html; charset=utf-8').send(page('Cerebro', html`<div class="card">Esa app no existe. <a href="/">Volver</a></div>`));
    const hasBuild = !!latestBuildOn(db, a.slug, a.branch);
    return reply.type('text/html; charset=utf-8').send(page(`${info.name} · Cerebro`, appDetailPage(info, hasBuild, google !== undefined), { bodyClass: 'landing' }));
  });

  app.get<{ Params: { slug: string } }>('/apps/:slug/apk', async (req, reply) => {
    const a = getApp(db, req.params.slug);
    const b = a && appPage(a.slug) ? latestBuildOn(db, a.slug, a.branch) : null;
    const file = a && b ? path.join(config.apksDir, a.slug, b.apkFile) : '';
    if (!a || !b || !fs.existsSync(file)) return reply.code(404).send('Todavía no hay un APK publicado de esta app.');
    reply
      .type('application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="${a.slug}.apk"`)
      .header('cache-control', 'no-store');
    return reply.send(fs.createReadStream(file));
  });

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

  interface Draft {
    slug: string;
    text: string;
    error: string;
  }

  function renderPortal(req: FastifyRequest, uid: number, notice: { sentTo?: string; draft?: Draft } = {}) {
    const name = getUser(db, uid)?.name ?? '';
    const apps = appsForUser(db, uid);
    const sentTo = notice.sentTo ? apps.find((a) => a.slug === notice.sentTo) : undefined;
    return page(
      'Cerebro · Tus apps',
      html`
        <header class="topbar">
          <a class="brand" href="/apks">${BRAND_MARK}Cerebro</a>
          <div class="row">
            ${isAdmin(req) ? html`<a class="button secondary" href="/admin">Admin</a>` : ''}
            <form method="post" action="/apks/logout"><button class="secondary">Salir</button></form>
          </div>
        </header>
        <div class="portal-head">
          <p>Hola, ${name}</p>
          <h1>Tus apps</h1>
        </div>
        ${sentTo
          ? html`<p class="notice" role="status">Idea enviada para ${sentTo.name}. El dueño la revisará; su estado aparece en Tus ideas.</p>`
          : ''}
        ${apps.length === 0 ? html`<div class="card">Tu cuenta todavía no tiene apps asignadas.</div>` : ''}
        ${apps.map((a) => portalAppCard(a, uid, notice.draft?.slug === a.slug ? notice.draft : undefined))}
        ${footer()}
        <script>if (matchMedia('(min-width: 860px)').matches) document.querySelectorAll('details.idea-toggle').forEach(function (d) { d.open = true; });</script>
      `,
      { bodyClass: 'portal' },
    );
  }

  app.get<{ Querystring: { enviada?: string } }>('/apks', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    const uid = portalUser(req);
    if (uid === null) return reply.redirect('/', 303);
    return renderPortal(req, uid, { sentTo: req.query.enviada });
  });

  function versionPanel(a: App, b: Build, included: number) {
    return html`<div class="panel panel-version">
      <div class="row" style="justify-content:space-between; align-items:baseline">
        <h3>Tu versión ${b.versionCode}</h3>
        <span class="when">Publicada el ${fmtDay(b.createdAt)}</span>
      </div>
      <p class="muted">Trae ${included} ${included === 1 ? 'idea tuya' : 'ideas tuyas'} sobre la versión base. Se instala encima de la que
        tienes, sin perder tus datos.</p>
      <div class="actions">
        <a class="button" href="/apks/${a.slug}/latest.apk">${DOWNLOAD_ICON}Descargar versión ${b.versionCode}</a>
        <details class="hint"><summary>¿Cómo instalarla?</summary>
          <p>Si Android pregunta, permite que el navegador instale apps solo para esta instalación.</p>
        </details>
      </div>
    </div>`;
  }

  function emptyPanel(a: App) {
    const base = latestBuildOn(db, a.slug, a.branch);
    return html`<div class="panel-empty">
      ${SEED_BRANCH}
      <div>
        <h3>Aún no tienes tu versión</h3>
        <p>La tendrás cuando el dueño apruebe y publique tu primera idea. Mientras tanto, usa la versión base de ${a.name}.</p>
        ${base && appPage(a.slug) ? html`<a class="button secondary" href="/apps/${a.slug}/apk">Descargar la versión base</a>` : ''}
      </div>
    </div>`;
  }

  function ideaPanel(a: App, firstIdea: boolean, primary: boolean, draft?: Draft) {
    const fieldId = `idea-${a.slug}`;
    const form = html`<form class="panel panel-idea" method="post" action="/apks/${a.slug}/requests">
      <h3>${firstIdea ? 'Tu primera idea' : 'Nueva idea'}</h3>
      <p class="muted">Una idea por solicitud. Si el dueño la aprueba, llega a tu versión.</p>
      <label class="field" for="${fieldId}">¿Qué cambiarías de ${a.name}?</label>
      <textarea id="${fieldId}" name="text" rows="6" minlength="${MIN_LENGTH}" maxlength="${MAX_LENGTH}" required
        aria-describedby="${fieldId}-help" placeholder="Por ejemplo: agregar un modo oscuro"
        oninput="this.form.querySelector('.count').textContent = this.value.length + ' / ${MAX_LENGTH}'">${draft?.text ?? ''}</textarea>
      <div class="field-foot">
        <span id="${fieldId}-help" class="hint">Entre ${MIN_LENGTH} y ${MAX_LENGTH} caracteres</span>
        <span class="count hint" aria-hidden="true">${(draft?.text ?? '').length} / ${MAX_LENGTH}</span>
      </div>
      <p class="public-note">${GLOBE_ICON}Tu idea y el código que genere serán públicos en GitHub. No escribas datos personales.</p>
      ${draft ? html`<p class="error" role="alert">${draft.error}</p>` : ''}
      <button class="${primary ? '' : 'secondary'}">Enviar idea</button>
    </form>`;
    if (firstIdea || draft) return form;
    return html`<details class="idea-toggle"><summary>${PLUS_ICON}Nueva idea</summary>${form}</details>`;
  }

  function branchTimeline(a: App, reqs: Request[], versionOf: (r: Request) => number | undefined) {
    if (reqs.length === 0) return '';
    return html`<section class="branch" aria-labelledby="ideas-${a.slug}">
      <h3 id="ideas-${a.slug}">Tus ideas</h3>
      <ol class="timeline">
        ${reqs.map((r) => {
          const v = versionOf(r);
          const off = ['failed', 'discarded', 'rejected'].includes(r.status);
          const node = r.status === 'built' ? 'in' : off ? 'off' : '';
          return html`<li>
            <span class="node ${node}" aria-hidden="true">${off ? CROSS_ICON : ''}</span>
            <div style="flex:1; min-width:0">
              <div class="meta">
                ${r.status === 'built'
                  ? html`<span class="pill-in">${v ? `En tu versión ${v}` : USER_STATUS_LABEL.built}</span>`
                  : html`<span class="status ${r.status}">${USER_STATUS_LABEL[r.status] ?? r.status}</span>`}
                <span class="when">${fmtDay(r.createdAt)}</span>
              </div>
              <p class="idea ${off ? 'off-text' : ''}">${r.text}</p>
              ${r.reason ? html`<p class="note">${r.reason}</p>` : ''}
            </div>
          </li>`;
        })}
        <li aria-hidden="true"><span class="node root"></span><p class="base">Parten de la versión base</p></li>
      </ol>
    </section>`;
  }

  function portalAppCard(a: App, uid: number, draft?: Draft) {
    const b = latestBuildFor(db, a, uid);
    const branch = userBranch(uid);
    const reqs = listRequests(db, { userId: uid, appSlug: a.slug, limit: 8 });
    const versionOf = (r: Request) => (r.status === 'built' ? buildForRequest(db, r.id, branch)?.versionCode : undefined);
    const included = b
      ? listRequests(db, { userId: uid, appSlug: a.slug, limit: 200 }).filter((r) => {
          const v = versionOf(r);
          return v !== undefined && v <= b.versionCode;
        }).length
      : 0;
    const info = appPage(a.slug);
    return html`
      <section class="app-block" aria-labelledby="app-${a.slug}">
        <div class="app-title">
          ${info ? html`<span class="app-icon">${info.icon}</span>` : ''}
          <h2 id="app-${a.slug}">${a.name}</h2>
          ${info ? html`<a class="more" href="/apps/${a.slug}">Ver la app</a>` : ''}
        </div>
        <div class="app-grid">
          ${b ? versionPanel(a, b, included) : emptyPanel(a)}
          ${ideaPanel(a, reqs.length === 0, !b, draft)}
          ${branchTimeline(a, reqs, versionOf)}
        </div>
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
      return renderPortal(req, uid, { draft: { slug: req.params.slug, text, error: res.error } });
    }
    return reply.redirect(`/apks?enviada=${encodeURIComponent(req.params.slug)}`, 303);
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
      return page('Cerebro · admin', loginPage('Administración', '/admin', google !== undefined));
    }
    const all = listRequests(db, { limit: 60 });
    const pending = all.filter((r) => r.status === 'pending');
    const review = all.filter((r) => r.status === 'review');
    const queue = all.filter((r) => r.status === 'approved' || r.status === 'running');
    const done = all.filter((r) => !['pending', 'approved', 'running', 'review'].includes(r.status));
    return page(
      'Cerebro · admin',
      html`
        <header class="topbar">
          <a class="brand" href="/admin">${BRAND_MARK}Cerebro</a>
          <div class="row">
            <a class="button secondary" href="/apks">Mis APKs</a>
            <form method="post" action="/apks/logout"><button class="secondary">Salir</button></form>
          </div>
        </header>
        <h1>Administración</h1>
        <section class="card"><h2>Por aprobar (${pending.length})</h2>
          ${pending.length ? html`<ul class="list">${pending.map(adminPendingItem)}</ul>` : html`<p class="muted">Nada pendiente.</p>`}
        </section>
        ${review.length
          ? html`<section class="card"><h2>Por revisar (${review.length})</h2>
              <p class="muted">Solicitudes forzadas: pasaron las pruebas en el sandbox. Lee los cambios antes de publicarlas.</p>
              <ul class="list">${review.map(adminReviewItem)}</ul></section>`
          : ''}
        ${queue.length
          ? html`<section class="card"><h2>En cola o programándose (${queue.length})</h2>
              <p class="hint">La página se actualiza sola cada ${ADMIN_REFRESH_SEC} s, salvo mientras escribes.</p>
              <ul class="list">${queue.map((r) => adminHistoryItem(r, true))}</ul></section>`
          : ''}
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

  function appName(slug: string): string {
    return getApp(db, slug)?.name ?? slug;
  }

  function adminPendingItem(r: Request) {
    const risky = r.flags.length > 0;
    const rejectForm = `reject-${r.id}`;
    return html`<li>
      <div><strong>#${r.id} ${appName(r.appSlug)}</strong> <span class="muted">de ${r.userName ?? 'sistema'}, ${fmtDate(r.createdAt)}</span></div>
      <p>${r.text}</p>
      ${r.flags.map((f) => html`<div class="flag" role="note">⚠ ${f}</div>`)}
      <div class="decide">
        <form id="${rejectForm}" method="post" action="/admin/requests/${r.id}/reject"></form>
        <label class="field" for="reason-${r.id}" style="margin:0">Motivo si la rechazas (opcional)</label>
        <input id="reason-${r.id}" form="${rejectForm}" type="text" name="reason" placeholder="Por ejemplo: no es parte de esta app">
        <div class="row">
          <form method="post" action="/admin/requests/${r.id}/approve" class="row">
            ${authorIsAdmin(r)
              ? html`<label class="row"><input type="checkbox" name="alsoMain" value="on" style="width:auto"> También a main</label>`
              : ''}
            <button class="${risky ? 'secondary' : ''}">Aprobar #${r.id}</button>
          </form>
          <button form="${rejectForm}" class="${risky ? 'danger' : 'quiet'}">Rechazar #${r.id}</button>
        </div>
      </div>
    </li>`;
  }

  function adminReviewItem(r: Request) {
    return html`<li>
      <div><strong>#${r.id} ${appName(r.appSlug)}</strong> <span class="muted">de ${r.userName ?? 'sistema'}</span></div>
      <p class="target">Va a main y a ${r.branch}.</p>
      <p>${r.text}</p>
      ${r.reason ? html`<p class="muted">${r.reason}</p>` : ''}
      <details open><summary>Cambios en el código</summary><pre class="diff">${renderDiff(r.reviewPatch ?? '')}</pre></details>
      ${r.log ? html`<details><summary class="muted">Log</summary><pre>${r.log}</pre></details>` : ''}
      <div class="row">
        <form method="post" action="/admin/requests/${r.id}/publish"><button>Publicar en main y ${r.branch}</button></form>
        <form method="post" action="/admin/requests/${r.id}/discard"
          onsubmit="return confirm('¿Descartar #${r.id}? El cambio no llegará al repo.')"><button class="quiet">Descartar #${r.id}</button></form>
      </div>
    </li>`;
  }

  function adminHistoryItem(r: Request, openLog = false) {
    const forceable = r.kind === 'change' && (r.status === 'failed' || r.status === 'discarded');
    return html`<li>
      <div class="row" style="justify-content:space-between">
        <span><strong>#${r.id} ${appName(r.appSlug)}</strong> <span class="muted">de ${r.userName ?? 'sistema'}, ${r.branch}${r.alsoMain ? ' y main' : ''}</span></span>
        <span class="status ${r.status}">${STATUS_LABEL[r.status]}</span>
      </div>
      <div>${r.text}</div>
      ${r.reason ? html`<div class="muted">${r.reason}</div>` : ''}
      ${r.log ? html`<details ${openLog ? 'open' : ''}><summary class="muted">Log</summary><pre>${r.log}</pre></details>` : ''}
      ${forceable
        ? html`<details class="confirm"><summary>Forzar…</summary>
            <p>Vuelve a programar #${r.id} con el núcleo, las dependencias y los permisos de Android desbloqueados. Va a
              main, para todos. Antes de publicar vas a revisar los cambios.</p>
            <form method="post" action="/admin/requests/${r.id}/force"><button class="danger">Forzar #${r.id}</button></form>
          </details>`
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
                  <span>v${b.versionCode} <span class="muted">${b.commitSha.slice(0, 7)}, ${fmtDate(b.createdAt)}</span>
                    ${i === 0 ? html` <span class="status built">actual</span>` : ''}</span>
                  <form method="post" action="/admin/builds/${b.id}/revert"
                    onsubmit="return confirm('¿Revertir v${b.versionCode} en ${branch}? Se crea un commit nuevo y un APK nuevo.')">
                    <button class="secondary">Revertir v${b.versionCode}</button></form>
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
    <header class="topbar"><a class="brand" href="/">${BRAND_MARK}Cerebro</a></header>
    <h1>${title}</h1>
    <div class="card">
      <p class="muted">Solo pueden entrar las cuentas de Google autorizadas como administradoras.</p>
      ${enabled ? signInButton(next) : html`<p class="error">El inicio de sesión con Google no está configurado.</p>`}
    </div>`;
}
