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
import type { App, Build, Request, RequestStatus } from './store.ts';
import {
  appendLog,
  appsForUser,
  countRequests,
  favoriteApps,
  setFavorite,
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
  awaitsBranchCarry,
  isUserBranch,
  queueBranchSync,
  retryBranchCarry,
  upsertGoogleUser,
  userBranch,
  userCanUseApp,
} from './store.ts';
import { appPage } from './web/catalog.ts';
import { errorMessage, flagLabel } from './web/copy.ts';
import { FAVICON_SVG, ICONS } from './web/icons.ts';
import {
  API_STATUS_LABEL,
  FORCED_LOG_LINE,
  RETRY_LOG_PREFIX,
  STATUS_LABEL,
  USER_STATUS_LABEL,
  capitalizeFirst,
  html,
  page,
  parseLog,
  raw,
  renderDiff,
  richText,
  richTextRows,
  splitRuns,
  timeTag,
} from './web/html.ts';
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
const NOTE_ROWS = 3;

function aiNote(text: string | null) {
  if (!text) return '';
  const body = html`<p class="note-text">${richText(text)}</p>`;
  if (richTextRows(text) <= NOTE_ROWS) return html`<div class="note">${body}</div>`;
  return html`<div class="note clamp">${body}<details class="more-text"><summary>${ICONS.more}<span class="more">Show more</span><span class="less">Show less</span></summary></details></div>`;
}

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
    statusLabel: API_STATUS_LABEL[r.status] ?? r.status,
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
    if (!FONT_FILES.has(req.params.file)) return reply.code(404).send('Not found');
    reply.type('font/woff2').header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(path.join(FONTS_DIR, req.params.file)));
  });

  app.get('/favicon.svg', async (_req, reply) =>
    reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(FAVICON_SVG),
  );
  app.get('/favicon.ico', async (_req, reply) => reply.redirect('/favicon.svg', 301));
  app.get('/', async (req, reply) => {
    if (portalUser(req) !== null) return reply.redirect('/apks', 303);
    return reply.type('text/html; charset=utf-8').send(page('Cerebro', landingPage(google !== undefined), { bodyClass: 'landing' }));
  });

  for (const route of ['/privacy', '/privacidad']) {
    app.get(route, async (req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send(page('Privacy · Cerebro', privacyPage(google !== undefined, portalUser(req) !== null), { bodyClass: 'landing' })),
    );
  }

  app.get<{ Params: { slug: string } }>('/apps/:slug', async (req, reply) => {
    const info = appPage(req.params.slug);
    const a = getApp(db, req.params.slug);
    if (!info || !a) {
      return reply.code(404).type('text/html; charset=utf-8').send(page('Cerebro', html`<div class="card">That app does not exist. <a href="/">Go back</a></div>`));
    }
    const hasBuild = !!latestBuildOn(db, a.slug, a.branch);
    const body = appDetailPage(info, hasBuild, google !== undefined, portalUser(req) !== null);
    return reply.type('text/html; charset=utf-8').send(page(`${info.name} · Cerebro`, body, { bodyClass: 'landing' }));
  });

  app.get<{ Params: { slug: string } }>('/apps/:slug/apk', async (req, reply) => {
    const a = getApp(db, req.params.slug);
    const b = a && appPage(a.slug) ? latestBuildOn(db, a.slug, a.branch) : null;
    const file = a && b ? path.join(config.apksDir, a.slug, b.apkFile) : '';
    if (!a || !b || !fs.existsSync(file)) return reply.code(404).send('There is no published APK of this app yet.');
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

  interface PortalView {
    app?: string;
    sentTo?: string;
    ideas?: string;
    shown?: number;
    draft?: Draft;
  }

  const IDEA_FILTERS: { key: string; label: string; statuses?: RequestStatus[] }[] = [
    { key: 'all', label: 'All' },
    { key: 'built', label: 'Published', statuses: ['built'] },
    { key: 'open', label: 'In progress', statuses: ['pending', 'approved', 'running', 'review'] },
    { key: 'closed', label: 'Not published', statuses: ['failed', 'discarded', 'rejected'] },
  ];
  const IDEAS_PAGE = 5;

  function portalHref(slug: string, extra: Record<string, string | number> = {}): string {
    const q = new URLSearchParams({ app: slug, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
    return `/apks?${q.toString()}`;
  }

  function renderPortal(req: FastifyRequest, uid: number, view: PortalView = {}) {
    const name = capitalizeFirst(getUser(db, uid)?.name ?? '');
    const apps = appsForUser(db, uid);
    const favorites = favoriteApps(db, uid);
    const current = apps.find((a) => a.slug === (view.draft?.slug ?? view.app)) ?? apps[0];
    const sentTo = view.sentTo ? apps.find((a) => a.slug === view.sentTo) : undefined;
    return page(
      'Your apps · Cerebro',
      html`
        <header class="topbar">
          <a class="brand" href="/apks">${BRAND_MARK}Cerebro</a>
          <div class="row">
            ${isAdmin(req) ? html`<a class="button secondary" href="/admin">${ICONS.shield}Admin</a>` : ''}
            <form method="post" action="/apks/logout"><button class="secondary">${ICONS.signOut}Sign out</button></form>
          </div>
        </header>
        <div class="portal-head">
          <p>Hi, ${name}</p>
          <h1>Your apps</h1>
        </div>
        ${apps.length > 1 ? appSwitcher(apps, favorites, current?.slug, '/apks') : ''}
        ${sentTo
          ? html`<p class="notice" role="status">Idea sent for ${sentTo.name}. The owner will review it; its status shows up in Your ideas.</p>`
          : ''}
        ${current
          ? portalAppCard(current, apps, favorites, uid, view)
          : html`<div class="card">Your account has no apps yet.</div>`}
        ${footer()}
        <script>if (matchMedia('(min-width: 860px)').matches) document.querySelectorAll('details.idea-toggle').forEach(function (d) { d.open = true; });</script>
      `,
      { bodyClass: 'portal' },
    );
  }

  function appSwitcher(apps: App[], favorites: Set<string>, currentSlug: string | undefined, base: string, counts?: Map<string, number>) {
    return html`<nav aria-label="Apps"><ul class="switcher">
      ${apps.map((a) => {
        const fav = favorites.has(a.slug);
        const info = appPage(a.slug);
        const n = counts?.get(a.slug) ?? 0;
        return html`<li class="${a.slug === currentSlug ? 'current' : ''}">
          <a href="${base}?app=${encodeURIComponent(a.slug)}" aria-current="${a.slug === currentSlug ? 'page' : 'false'}">
            <span class="app-icon">${info ? info.icon : ICONS.apps}</span>${a.name}${n ? html`<span class="count" aria-label="${n} pending">${n}</span>` : ''}
          </a>
          <form method="post" action="/apks/${a.slug}/favorite">
            <input type="hidden" name="favorite" value="${fav ? '0' : '1'}">
            <input type="hidden" name="back" value="${base}">
            <button class="fav ${fav ? 'on' : ''}" aria-label="${fav ? `Remove ${a.name} from favorites` : `Add ${a.name} to favorites`}"
              aria-pressed="${fav ? 'true' : 'false'}">${fav ? ICONS.heartFilled : ICONS.heart}</button>
          </form>
        </li>`;
      })}
    </ul></nav>`;
  }

  app.get<{ Querystring: { app?: string; sent?: string; enviada?: string; ideas?: string; shown?: string } }>('/apks', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    const uid = portalUser(req);
    if (uid === null) return reply.redirect('/', 303);
    const sent = req.query.sent ?? req.query.enviada;
    return renderPortal(req, uid, {
      app: req.query.app ?? sent,
      sentTo: sent,
      ideas: req.query.ideas,
      shown: Number(req.query.shown) || undefined,
    });
  });

  function buildSummary(b: Build): string {
    const r = getRequest(db, b.requestId);
    if (!r) return `Version ${b.versionCode}`;
    if (r.kind === 'revert') return `Undoes change ${r.revertSha?.slice(0, 7) ?? ''}`.trim();
    if (r.kind === 'sync') return 'Updated with the base app';
    if (r.userId === null) return 'Base version, built by hand';
    return r.text;
  }

  function versionPanel(a: App, b: Build, included: number) {
    return html`<div class="panel panel-version">
      <div class="row" style="justify-content:space-between; align-items:baseline">
        <h3>Your version ${b.versionCode}</h3>
        <span class="when">Published ${timeTag(b.createdAt, 'day')}</span>
      </div>
      <div class="whats-new">
        <p class="label">What's new</p>
        <p>${buildSummary(b)}</p>
      </div>
      <p class="muted">It has ${included} ${included === 1 ? 'idea of yours' : 'ideas of yours'} on top of the base version. It installs over
        the one you have, without losing your data.</p>
      <div class="actions">
        <a class="button" href="/apks/${a.slug}/latest.apk">${ICONS.download}Download version ${b.versionCode}</a>
        <details class="hint"><summary>How do I install it?</summary>
          <p>If Android asks, let your browser install apps just for this install.</p>
        </details>
      </div>
    </div>`;
  }

  function emptyPanel(a: App) {
    const base = latestBuildOn(db, a.slug, a.branch);
    return html`<div class="panel-empty">
      ${SEED_BRANCH}
      <div>
        <h3>You don't have your version yet</h3>
        <p>You'll get it when the owner approves and publishes your first idea. Meanwhile, use the base version of ${a.name}.</p>
        ${base && appPage(a.slug) ? html`<a class="button secondary" href="/apps/${a.slug}/apk">${ICONS.download}Download the base version</a>` : ''}
      </div>
    </div>`;
  }

  function ideaPanel(current: App, apps: App[], firstIdea: boolean, primary: boolean, draft?: Draft) {
    const fieldId = `idea-${current.slug}`;
    const form = html`<form class="panel panel-idea" method="post" action="/apks/requests">
      <h3>${firstIdea ? 'Your first idea' : 'New idea'}</h3>
      <p class="muted">One idea per request. If the owner approves it, it reaches your version.</p>
      ${apps.length > 1
        ? html`<label class="field" for="${fieldId}-app">App</label>
            <select id="${fieldId}-app" name="app" class="select">${apps.map(
              (a) => html`<option value="${a.slug}" ${a.slug === current.slug ? 'selected' : ''}>${a.name}</option>`,
            )}</select>`
        : html`<input type="hidden" name="app" value="${current.slug}">`}
      <label class="field" for="${fieldId}">What would you change?</label>
      <textarea id="${fieldId}" name="text" rows="6" minlength="${MIN_LENGTH}" maxlength="${MAX_LENGTH}" required
        aria-describedby="${fieldId}-help" placeholder="For example: add a dark mode"
        oninput="this.form.querySelector('.count').textContent = this.value.length + ' / ${MAX_LENGTH}'">${draft?.text ?? ''}</textarea>
      <div class="field-foot">
        <span id="${fieldId}-help" class="hint">Between ${MIN_LENGTH} and ${MAX_LENGTH} characters</span>
        <span class="count hint" aria-hidden="true">${(draft?.text ?? '').length} / ${MAX_LENGTH}</span>
      </div>
      <p class="public-note">${ICONS.globe}Your idea and the code it produces will be public on GitHub. Don't write personal data.</p>
      ${draft ? html`<p class="error" role="alert">${errorMessage(draft.error)}</p>` : ''}
      <button class="${primary ? '' : 'secondary'}">${ICONS.send}Send idea</button>
    </form>`;
    if (firstIdea || draft) return form;
    return html`<details class="idea-toggle"><summary>${ICONS.plus}New idea</summary>${form}</details>`;
  }

  function ideasSection(a: App, uid: number, view: PortalView, versionOf: (r: Request) => number | undefined) {
    const total = countRequests(db, { userId: uid, appSlug: a.slug });
    if (total === 0) return '';
    const filter = IDEA_FILTERS.find((f) => f.key === view.ideas) ?? IDEA_FILTERS[0];
    const shown = Math.min(Math.max(view.shown ?? IDEAS_PAGE, IDEAS_PAGE), 500);
    const where = { userId: uid, appSlug: a.slug, statuses: filter.statuses };
    const matching = countRequests(db, where);
    const reqs = listRequests(db, { ...where, limit: shown });
    return html`<section class="branch" aria-labelledby="ideas-${a.slug}">
      <h3 id="ideas-${a.slug}">Your ideas</h3>
      <nav class="filters" aria-label="Filter ideas">${IDEA_FILTERS.map(
        (f) => html`<a href="${portalHref(a.slug, { ideas: f.key })}#ideas-${a.slug}" aria-current="${f.key === filter.key ? 'true' : 'false'}">${f.label}</a>`,
      )}</nav>
      ${reqs.length
        ? html`<ol class="timeline">
            ${reqs.map((r) => ideaItem(r, versionOf(r)))}
            ${reqs.length === matching ? html`<li aria-hidden="true"><span class="node root"></span><p class="base">Built on the base version</p></li>` : ''}
          </ol>`
        : html`<p class="muted">No ideas here yet.</p>`}
      ${reqs.length < matching
        ? html`<div class="more-row"><span>Showing ${reqs.length} of ${matching}</span>
            <a class="button secondary" href="${portalHref(a.slug, { ideas: filter.key, shown: shown + 10 })}#ideas-${a.slug}">${ICONS.more}Show older ideas</a></div>`
        : ''}
    </section>`;
  }

  function ideaItem(r: Request, v: number | undefined) {
    const off = ['failed', 'discarded', 'rejected'].includes(r.status);
    const mine = r.status === 'built' && v !== undefined;
    const node = mine ? 'in' : r.status === 'built' ? 'trunk' : off ? 'off' : '';
    return html`<li>
      <span class="node ${node}" aria-hidden="true">${off ? ICONS.cross : ''}</span>
      <div style="flex:1; min-width:0">
        <div class="meta">
          ${mine
            ? html`<span class="pill-in">In your version ${v}</span>`
            : html`<span class="status ${r.status === 'built' ? 'trunk' : r.status}">${USER_STATUS_LABEL[r.status] ?? r.status}</span>`}
          <span class="when">${timeTag(r.createdAt, 'day')}</span>
        </div>
        <p class="idea ${off ? 'off-text' : ''}">${r.text}</p>
        ${aiNote(r.reason)}
      </div>
    </li>`;
  }

  function portalAppCard(a: App, apps: App[], favorites: Set<string>, uid: number, view: PortalView) {
    const b = latestBuildFor(db, a, uid);
    const branch = userBranch(uid);
    const versionOf = (r: Request) => (r.status === 'built' ? buildForRequest(db, r.id, branch)?.versionCode : undefined);
    const included = b
      ? listRequests(db, { userId: uid, appSlug: a.slug, statuses: ['built'], limit: 500 }).filter((r) => {
          const v = versionOf(r);
          return v !== undefined && v <= b.versionCode;
        }).length
      : 0;
    const hasIdeas = countRequests(db, { userId: uid, appSlug: a.slug }) > 0;
    const info = appPage(a.slug);
    const fav = favorites.has(a.slug);
    const draft = view.draft?.slug === a.slug ? view.draft : undefined;
    return html`
      <section class="app-block" aria-labelledby="app-${a.slug}">
        <div class="app-title">
          ${info ? html`<span class="app-icon">${info.icon}</span>` : ''}
          <h2 id="app-${a.slug}">${a.name}</h2>
          ${apps.length === 1
            ? html`<form method="post" action="/apks/${a.slug}/favorite">
                <input type="hidden" name="favorite" value="${fav ? '0' : '1'}"><input type="hidden" name="back" value="/apks">
                <button class="fav ${fav ? 'on' : ''}" aria-pressed="${fav ? 'true' : 'false'}"
                  aria-label="${fav ? `Remove ${a.name} from favorites` : `Add ${a.name} to favorites`}">${fav ? ICONS.heartFilled : ICONS.heart}</button>
              </form>`
            : ''}
          ${info ? html`<a class="more" href="/apps/${a.slug}">About the app</a>` : ''}
        </div>
        <div class="app-grid">
          ${b ? versionPanel(a, b, included) : emptyPanel(a)}
          ${ideaPanel(a, apps, !hasIdeas, !b, draft)}
          ${ideasSection(a, uid, view, versionOf)}
        </div>
      </section>`;
  }

  app.get<{ Querystring: { next?: string; app?: string } }>('/auth/google/start', async (req, reply) => {
    if (!google) return reply.code(503).send('Google sign-in is not configured.');
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
      reply.code(status).send(page('Cerebro', html`<div class="card"><p class="error">${message}</p><p><a href="/">Go back</a></p></div>`));
    if (!google) return fail(503, 'Google sign-in is not configured.');
    const blocked = blockedError(req.ip);
    if (blocked) return fail(429, 'Too many attempts. Try again in a few minutes.');
    const state = req.query.state ? consumeOAuthState(db, req.query.state, cookies(req)[OAUTH_COOKIE]) : null;
    if (!state || !req.query.code) return fail(400, 'The sign-in expired or is not valid. Try again.');
    let identity: GoogleIdentity;
    try {
      const idToken = await google.exchange.exchange(req.query.code, state.verifier, `${config.publicUrl}/auth/google/callback`);
      identity = await google.verifier.verify(idToken, state.nonce);
    } catch {
      recordFailure(db, req.ip);
      return fail(401, 'Your Google account could not be verified.');
    }
    clearFailures(db, req.ip);
    const res = startSession(identity, state.appSlug);
    if (!res.ok) return fail(res.status, res.status === 403 ? 'Your account is disabled.' : 'The admin account is not linked yet: run user:link on the server.');
    setCookie(reply, config, SESSION_COOKIE, res.token, config.sessionDays * 86400, '/');
    setCookie(reply, config, OAUTH_COOKIE, '', 0, OAUTH_COOKIE_PATH);
    return reply.redirect(state.next, 303);
  });

  app.post('/apks/logout', async (req, reply) => {
    deleteSession(db, cookies(req)[SESSION_COOKIE]);
    setCookie(reply, config, SESSION_COOKIE, '', 0, '/');
    return reply.redirect('/apks', 303);
  });

  async function submitIdea(req: FastifyRequest, reply: FastifyReply, slug: string) {
    const uid = portalUser(req);
    if (uid === null || !userCanUseApp(db, uid, slug)) return reply.redirect('/apks', 303);
    const text = String((req.body as { text?: unknown } | undefined)?.text ?? '');
    const res = createRequest(db, uid, slug, text);
    if (!res.ok) {
      reply.code(400).type('text/html; charset=utf-8');
      return renderPortal(req, uid, { draft: { slug, text, error: res.error } });
    }
    return reply.redirect(`/apks?app=${encodeURIComponent(slug)}&sent=${encodeURIComponent(slug)}`, 303);
  }

  app.post('/apks/requests', async (req, reply) =>
    submitIdea(req, reply, String((req.body as { app?: unknown } | undefined)?.app ?? '')),
  );

  app.post<{ Params: { slug: string } }>('/apks/:slug/requests', async (req, reply) => submitIdea(req, reply, req.params.slug));

  app.post<{ Params: { slug: string } }>('/apks/:slug/favorite', async (req, reply) => {
    const uid = portalUser(req);
    const body = (req.body ?? {}) as { favorite?: unknown; back?: unknown };
    const back = body.back === '/admin' ? '/admin' : '/apks';
    if (uid !== null && back === '/admin' && isAdmin(req) && getApp(db, req.params.slug)) grantApps(db, uid, [req.params.slug]);
    if (uid !== null) setFavorite(db, uid, req.params.slug, body.favorite === '1');
    return reply.redirect(`${back}?app=${encodeURIComponent(req.params.slug)}`, 303);
  });

  app.get<{ Params: { slug: string }; Querystring: { dl?: string } }>('/apks/:slug/latest.apk', async (req, reply) => {
    const slug = req.params.slug;
    let uid = portalUser(req);
    if (uid === null && req.query.dl) uid = useDownloadToken(db, req.query.dl, slug);
    const a = getApp(db, slug);
    if (uid === null || !a || !userCanUseApp(db, uid, slug)) return reply.code(404).send('Not found');
    const b = latestBuildFor(db, a, uid);
    if (!b) return reply.code(404).send("You don't have your own version of this app yet.");
    const file = path.join(config.apksDir, slug, b.apkFile);
    if (!fs.existsSync(file)) return reply.code(404).send('The APK file is not on the server.');
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

  const HISTORY_FILTERS: { key: string; label: string; statuses: RequestStatus[] }[] = [
    { key: 'all', label: 'All', statuses: ['built', 'failed', 'discarded', 'rejected'] },
    { key: 'built', label: 'Built', statuses: ['built'] },
    { key: 'failed', label: 'Failed', statuses: ['failed'] },
    { key: 'discarded', label: 'Discarded', statuses: ['discarded'] },
    { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  ];
  const HISTORY_PAGE = 10;

  function adminHref(appSlug: string | undefined, extra: Record<string, string | number> = {}): string {
    const q = new URLSearchParams(Object.entries({ ...(appSlug ? { app: appSlug } : {}), ...extra }).map(([k, v]) => [k, String(v)]));
    const qs = q.toString();
    return qs ? `/admin?${qs}` : '/admin';
  }

  app.get<{ Querystring: { app?: string; hist?: string; shown?: string } }>('/admin', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    if (!isAdmin(req)) {
      if (portalUser(req) !== null) {
        reply.code(403);
        return page('Admin · Cerebro', html`<div class="card">Your account is not an admin. <a href="/apks">Go to your apps</a></div>`);
      }
      return page('Admin · Cerebro', loginPage('Admin', '/admin', google !== undefined));
    }
    const adminId = portalUser(req)!;
    const favorites = favoriteApps(db, adminId);
    const pendingBy = new Map<string, number>();
    for (const r of listRequests(db, { statuses: ['pending', 'review'], limit: 500 })) {
      pendingBy.set(r.appSlug, (pendingBy.get(r.appSlug) ?? 0) + 1);
    }
    const apps = listApps(db).sort(
      (x, y) =>
        Number(favorites.has(y.slug)) - Number(favorites.has(x.slug)) ||
        (pendingBy.get(y.slug) ?? 0) - (pendingBy.get(x.slug) ?? 0) ||
        x.name.localeCompare(y.name),
    );
    const current = apps.find((a) => a.slug === req.query.app);
    const appSlug = current?.slug;
    const pending = listRequests(db, { appSlug, statuses: ['pending'], limit: 100 });
    const review = listRequests(db, { appSlug, statuses: ['review'], limit: 100 });
    const queue = listRequests(db, { appSlug, statuses: ['approved', 'running'], limit: 100 });
    const histFilter = HISTORY_FILTERS.find((f) => f.key === req.query.hist) ?? HISTORY_FILTERS[0];
    const shown = Math.min(Math.max(Number(req.query.shown) || HISTORY_PAGE, HISTORY_PAGE), 500);
    const histWhere = { appSlug, statuses: histFilter.statuses };
    const histTotal = countRequests(db, histWhere);
    const history = listRequests(db, { ...histWhere, limit: shown });
    const historyOpen = req.query.hist !== undefined || req.query.shown !== undefined;
    return page(
      'Admin · Cerebro',
      html`
        <header class="topbar">
          <a class="brand" href="/apks">${BRAND_MARK}Cerebro</a>
          <div class="row">
            <a class="button secondary" href="/apks">${ICONS.apps}Your apps</a>
            <form method="post" action="/apks/logout"><button class="secondary">${ICONS.signOut}Sign out</button></form>
          </div>
        </header>
        <h1>Admin</h1>
        ${apps.length > 1
          ? html`<nav aria-label="Filter by app"><ul class="switcher">
              <li class="${current ? '' : 'current'}"><a href="/admin" aria-current="${current ? 'false' : 'page'}" style="padding-right:14px">
                <span class="app-icon">${ICONS.apps}</span>All apps</a></li>
              ${apps.map((a) => adminAppChip(a, favorites.has(a.slug), a.slug === appSlug, pendingBy.get(a.slug) ?? 0))}
            </ul></nav>`
          : ''}
        ${pending.length
          ? html`<section class="card"><h2>Pending approval (${pending.length})</h2>
              <ul class="list">${pending.map(adminPendingItem)}</ul></section>`
          : html`<p class="all-clear">${ICONS.check}Nothing to approve</p>`}
        ${review.length
          ? html`<section class="card"><h2>To review (${review.length})</h2>
              <p class="muted">Forced requests that passed the sandbox tests. Read the changes before publishing them.</p>
              <ul class="list">${review.map(adminReviewItem)}</ul></section>`
          : ''}
        ${queue.length
          ? html`<section class="card"><h2>Queued or building (${queue.length})</h2>
              <p class="hint">This page refreshes every ${ADMIN_REFRESH_SEC} s, except while you type.</p>
              <ul class="list">${queue.map((r) => adminHistoryItem(r, true))}</ul></section>`
          : ''}
        ${(current ? [current] : apps).map((a) => adminBuildsCard(a, !!current))}
        <details class="card fold" ${historyOpen ? 'open' : ''} id="history">
          <summary><h2>History (${countRequests(db, { appSlug, statuses: HISTORY_FILTERS[0].statuses })})</h2>${ICONS.more}</summary>
          <nav class="filters" aria-label="Filter history">${HISTORY_FILTERS.map(
            (f) => html`<a href="${adminHref(appSlug, { hist: f.key })}#history" aria-current="${f.key === histFilter.key ? 'true' : 'false'}">${f.label}</a>`,
          )}</nav>
          ${history.length ? html`<ul class="list">${history.map((r) => adminHistoryItem(r))}</ul>` : html`<p class="muted">Nothing here.</p>`}
          ${history.length < histTotal
            ? html`<div class="more-row"><span>Showing ${history.length} of ${histTotal}</span>
                <a class="button secondary" href="${adminHref(appSlug, { hist: histFilter.key, shown: shown + HISTORY_PAGE })}#history">${ICONS.more}Show older</a></div>`
            : ''}
        </details>
      `,
      { refreshSec: queue.length ? ADMIN_REFRESH_SEC : undefined },
    );
  });

  function adminAppChip(a: App, fav: boolean, current: boolean, pendingCount: number) {
    const info = appPage(a.slug);
    return html`<li class="${current ? 'current' : ''}">
      <a href="/admin?app=${encodeURIComponent(a.slug)}" aria-current="${current ? 'page' : 'false'}">
        <span class="app-icon">${info ? info.icon : ICONS.apps}</span>${a.name}${pendingCount
          ? html`<span class="count" aria-label="${pendingCount} waiting">${pendingCount}</span>`
          : ''}
      </a>
      <form method="post" action="/apks/${a.slug}/favorite">
        <input type="hidden" name="favorite" value="${fav ? '0' : '1'}"><input type="hidden" name="back" value="/admin">
        <button class="fav ${fav ? 'on' : ''}" aria-pressed="${fav ? 'true' : 'false'}"
          aria-label="${fav ? `Remove ${a.name} from favorites` : `Add ${a.name} to favorites`}">${fav ? ICONS.heartFilled : ICONS.heart}</button>
      </form>
    </li>`;
  }

  function runTime(run: string, which: 'first' | 'last') {
    const stamps = run.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/gm) ?? [];
    const stamp = which === 'first' ? stamps[0] : stamps.at(-1);
    return stamp ? timeTag(Date.parse(stamp), 'time') : '';
  }

  function logMessage(text: string) {
    const step = text.match(/^(Preparación|Pruebas|Compilación): (.+)$/);
    return step ? html`${step[1]} <code>${step[2]}</code>` : text;
  }

  function logList(run: string) {
    return html`<ol class="log-list">${parseLog(run).map(
      (e) => html`<li class="${e.kind}">
        ${timeTag(Date.parse(e.at), 'clock')}
        <div class="log-msg">${logMessage(e.text)}${e.detail ? html`<pre class="log-detail">${e.detail}</pre>` : ''}</div>
      </li>`,
    )}</ol>`;
  }

  function logBlock(log: string, open = false) {
    const runs = splitRuns(log);
    const current = runs[runs.length - 1];
    const earlier = runs.slice(0, -1).reverse();
    const entries = parseLog(current).length;
    const lastAt = runTime(current, 'last');
    return html`<details class="log" ${open ? 'open' : ''}>
      <summary>${ICONS.more}Log</summary>
      <div class="log-panel">
        <div class="log-bar">
          <span>${runs.length > 1 ? `Run ${runs.length} · ` : ''}${entries} ${entries === 1 ? 'step' : 'steps'}${lastAt ? html`, last at ${lastAt}` : ''}</span>
          <button type="button" class="secondary copy" data-log="${current}" aria-label="Copy this run's log"
            onclick="var b = this; navigator.clipboard.writeText(b.dataset.log).then(function () { b.lastChild.textContent = 'Copied'; setTimeout(function () { b.lastChild.textContent = 'Copy'; }, 2000); });">${ICONS.copy}<span>Copy</span></button>
        </div>
        ${logList(current)}
      </div>
      ${earlier.length
        ? html`<details class="earlier"><summary>${ICONS.more}Earlier runs (${earlier.length})</summary>
            ${earlier.map(
              (run, i) => html`<p class="run-label">Run ${runs.length - 1 - i}, started at ${runTime(run, 'first')}</p>
                <div class="log-panel">${logList(run)}</div>`,
            )}
          </details>`
        : ''}
    </details>`;
  }

  function authorIsAdmin(r: Request): boolean {
    return r.userId !== null && isAdminEmail(config, getUser(db, r.userId)?.email);
  }

  function diffStats(patch: string): string {
    const files = (patch.match(/^diff --git /gm) ?? []).length;
    const added = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
    const removed = (patch.match(/^-(?!--)/gm) ?? []).length;
    return `${files} ${files === 1 ? 'file' : 'files'}, +${added} −${removed}`;
  }

  function appName(slug: string): string {
    return getApp(db, slug)?.name ?? slug;
  }

  function adminPendingItem(r: Request) {
    const risky = r.flags.length > 0;
    const rejectForm = `reject-${r.id}`;
    return html`<li>
      <div><strong>#${r.id} ${appName(r.appSlug)}</strong> <span class="muted">by ${r.userName ?? 'system'}, ${timeTag(r.createdAt, 'date')}</span></div>
      <p>${r.text}</p>
      ${r.flags.map((f) => html`<div class="flag" role="note">⚠ ${flagLabel(f)}</div>`)}
      <form id="${rejectForm}" method="post" action="/admin/requests/${r.id}/reject"></form>
      <form id="approve-${r.id}" method="post" action="/admin/requests/${r.id}/approve"></form>
      <div class="decision ${risky ? 'risky' : ''}">
        <div class="decision-field">
          <label for="reason-${r.id}">Reason, if you reject it</label>
          <input id="reason-${r.id}" form="${rejectForm}" type="text" name="reason" placeholder="Optional. For example: not part of this app">
        </div>
        <div class="decision-text">
          <strong>Approve #${r.id}?</strong>
          <span>${risky
            ? 'This idea has warnings. Read it carefully before approving it.'
            : `Claude builds it on ${r.branch}. Nothing reaches the app until the tests and the build pass.`}</span>
        </div>
        <div class="decision-actions">
          ${authorIsAdmin(r)
            ? html`<label class="also-main"><input type="checkbox" form="approve-${r.id}" name="alsoMain" value="on"> Also to main</label>`
            : ''}
          <button form="${rejectForm}" class="${risky ? 'danger' : 'quiet'}">${ICONS.x}Reject</button>
          <button form="approve-${r.id}" class="${risky ? 'secondary' : ''}">${ICONS.check}Approve</button>
        </div>
      </div>
    </li>`;
  }

  function adminReviewItem(r: Request) {
    return html`<li>
      <div><strong>#${r.id} ${appName(r.appSlug)}</strong> <span class="muted">by ${r.userName ?? 'system'}</span></div>
      <p>${r.text}</p>
      ${aiNote(r.reason)}
      <details open class="changes"><summary>Code changes <span class="muted">${diffStats(r.reviewPatch ?? '')}</span></summary>
        <pre class="diff">${renderDiff(r.reviewPatch ?? '')}</pre></details>
      ${r.log ? logBlock(r.log) : ''}
      <div class="decision">
        <div class="decision-text">
          <strong>Publish #${r.id}?</strong>
          <span>Builds the APK, then pushes to main and to ${r.branch}. You can undo it later with a revert.</span>
        </div>
        <div class="decision-actions">
          <form method="post" action="/admin/requests/${r.id}/discard"
            onsubmit="return confirm('Discard #${r.id}? The change will not reach the repo.')"><button class="quiet">${ICONS.x}Discard</button></form>
          <form method="post" action="/admin/requests/${r.id}/publish"><button>${ICONS.publish}Publish</button></form>
        </div>
      </div>
    </li>`;
  }

  function retryableCarry(r: Request): boolean {
    const a = getApp(db, r.appSlug);
    return !!a && awaitsBranchCarry(r, a.branch);
  }

  function adminHistoryItem(r: Request, openLog = false) {
    const forceable = r.kind === 'change' && (r.status === 'failed' || r.status === 'discarded');
    const at = r.finishedAt ?? r.decidedAt ?? r.createdAt;
    return html`<li>
      <div class="row" style="justify-content:space-between">
        <span><strong>#${r.id} ${appName(r.appSlug)}</strong> <span class="muted">by ${r.userName ?? 'system'}${r.alsoMain ? ', also to main' : ''}
          · ${timeTag(at, 'when')}</span></span>
        <span class="status ${r.status}">${STATUS_LABEL[r.status]}</span>
      </div>
      <div>${r.text}</div>
      ${aiNote(r.reason)}
      ${r.log ? logBlock(r.log, openLog) : ''}
      ${forceable
        ? html`<details class="confirm"><summary>${ICONS.bolt}Force…</summary>
            <p>Builds #${r.id} again with the core, dependencies and Android permissions unlocked. It goes to main, for
              everyone. You will review the changes before publishing.</p>
            <form method="post" action="/admin/requests/${r.id}/force"><button class="danger">${ICONS.bolt}Force #${r.id}</button></form>
          </details>`
        : ''}
      ${retryableCarry(r)
        ? html`<div class="decision">
            <div class="decision-text">
              <strong>Reached main but not ${r.branch}.</strong>
              <span>Applies the change already on main to ${r.branch} and builds its APK. Claude does not run again.</span>
            </div>
            <div class="decision-actions">
              <form method="post" action="/admin/requests/${r.id}/retry-branch"><button class="secondary">${ICONS.publish}Retry on ${r.branch}</button></form>
            </div>
          </div>`
        : ''}
    </li>`;
  }

  function syncBar(a: App, branch: string) {
    return html`<div class="decision">
      <div class="decision-text">
        <strong>Sync ${branch} with ${a.branch}?</strong>
        <span>Brings ${a.branch}'s core, build files and dependencies to ${branch} and builds its APK. The branch keeps its own features.</span>
      </div>
      <div class="decision-actions">
        <form method="post" action="/admin/apps/${a.slug}/sync"><input type="hidden" name="branch" value="${branch}"><button class="secondary">${ICONS.arrowRight}Sync with ${a.branch}</button></form>
      </div>
    </div>`;
  }

  function adminBuildsCard(a: App, open: boolean) {
    const byBranch = new Map<string, Build[]>();
    for (const b of listBuilds(db, a.slug, 40)) byBranch.set(b.branch, [...(byBranch.get(b.branch) ?? []), b]);
    const branches = [...byBranch.keys()].sort((x, y) => (x === a.branch ? -1 : y === a.branch ? 1 : x.localeCompare(y)));
    return html`<details class="card fold" ${open ? 'open' : ''}>
      <summary><h2>${a.name} APKs</h2>${ICONS.more}</summary>
      ${branches.length
        ? branches.map(
            (branch) => html`<h3>${branch}</h3>${isUserBranch(branch) ? syncBar(a, branch) : ''}<ul class="list">${byBranch
              .get(branch)!
              .slice(0, 5)
              .map(
                (b, i) => html`<li class="build-row">
                  <div class="build-info">
                    <p class="build-title">${buildSummary(b)}</p>
                    <p class="build-meta">v${b.versionCode} · ${b.commitSha.slice(0, 7)} · ${timeTag(b.createdAt, 'date')}
                      ${i === 0 ? html` <span class="status built">current</span>` : ''}</p>
                  </div>
                  <form method="post" action="/admin/builds/${b.id}/revert"
                    onsubmit="return confirm('Revert v${b.versionCode} on ${branch}? This makes a new commit and a new APK.')">
                    <button class="secondary">${ICONS.undo}Revert v${b.versionCode}</button></form>
                </li>`,
              )}</ul>`,
          )
        : html`<p class="muted">No builds yet.</p>`}
    </details>`;
  }

  app.post<{ Params: { id: string } }>('/admin/requests/:id/approve', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
    const r = getRequest(db, Number(req.params.id));
    const alsoMain = (req.body as { alsoMain?: unknown } | undefined)?.alsoMain === 'on' && !!r && authorIsAdmin(r);
    if (r && decideRequest(db, r.id, { approve: true, alsoMain })) wakeWorker?.();
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/reject', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
    const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '').trim();
    decideRequest(db, Number(req.params.id), { approve: false, reason: reason || null });
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/force', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
    const id = Number(req.params.id);
    if (forceRequest(db, id)) {
      appendLog(db, id, FORCED_LOG_LINE);
      wakeWorker?.();
    }
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/retry-branch', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
    const r = getRequest(db, Number(req.params.id));
    if (r && retryBranchCarry(db, r.id)) {
      appendLog(db, r.id, `${RETRY_LOG_PREFIX} ${r.branch} por el admin`);
      wakeWorker?.();
    }
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/publish', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
    if (decideReview(db, Number(req.params.id), true)) wakeWorker?.();
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/requests/:id/discard', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
    decideReview(db, Number(req.params.id), false);
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { slug: string } }>('/admin/apps/:slug/sync', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
    const branch = String((req.body as { branch?: unknown } | undefined)?.branch ?? '');
    if (queueBranchSync(db, req.params.slug, branch)) wakeWorker?.();
    return reply.redirect('/admin', 303);
  });

  app.post<{ Params: { id: string } }>('/admin/builds/:id/revert', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send('Forbidden');
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
      <p class="muted">Only Google accounts authorized as admins can sign in.</p>
      ${enabled ? signInButton(next) : html`<p class="error">Google sign-in is not configured.</p>`}
    </div>`;
}
