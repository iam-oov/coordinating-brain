export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

export class Raw {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function raw(s: string): Raw {
  return new Raw(s);
}

function render(v: unknown): string {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

const STYLE = `
@font-face { font-family:"Bricolage Grotesque"; font-style:normal; font-weight:400 800; font-display:swap;
  src:url("/fonts/bricolage-grotesque-latin.woff2") format("woff2");
  unicode-range:U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family:"Bricolage Grotesque"; font-style:normal; font-weight:400 800; font-display:swap;
  src:url("/fonts/bricolage-grotesque-latin-ext.woff2") format("woff2");
  unicode-range:U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF; }
:root { color-scheme: light dark;
  --bg:#edf1ec; --card:#f7f9f6; --fg:#17231c; --muted:#56665c; --line:#c9d3cb; --field:#8a9b90;
  --branch:#2557d6; --branch-fg:#ffffff; --node:#e2a62a; --node-text:#875800; --bad:#b3261e; --bad-fg:#ffffff;
  --ok:#2e7d4f; --focus:#2557d6; --add:#1f6b3d; --del:#a3271d; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#0f1712; --card:#16211a; --fg:#e4ece6; --muted:#93a49a; --line:#2a3a30; --field:#4f6457;
  --branch:#7ea0ff; --branch-fg:#0f1712; --node:#f2c14e; --node-text:#f2c14e; --bad:#ff8a7a; --bad-fg:#0f1712;
  --ok:#86d3a3; --focus:#7ea0ff; --add:#86d3a3; --del:#ff9d90; } }
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; font:400 1rem/1.55 "Bricolage Grotesque", system-ui, sans-serif; font-optical-sizing:auto;
  background:var(--bg); color:var(--fg); caret-color:var(--branch); }
::selection { background:var(--branch); color:var(--branch-fg); }
h1, h2, h3 { text-wrap:balance; }
p, li { text-wrap:pretty; }
main { max-width:780px; margin:0 auto; padding:24px 16px 72px; }
h1 { font-size:1.95rem; line-height:1.1; letter-spacing:-.02em; font-weight:700; margin:0 0 4px; }
h2 { font-size:1.25rem; line-height:1.25; letter-spacing:-.01em; font-weight:650; margin:0 0 10px; }
h3 { font-size:1rem; font-weight:650; margin:16px 0 6px; color:var(--muted); }
a { color:var(--branch); text-underline-offset:.18em; }
:focus-visible { outline:3px solid var(--focus); outline-offset:2px; border-radius:6px; }
.muted { color:var(--muted); font-size:.92rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px; margin:16px 0; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
input[type=text], textarea { font:inherit; padding:12px 14px; border-radius:12px; border:1px solid var(--field);
  background:var(--bg); color:var(--fg); width:100%; }
::placeholder { color:var(--muted); opacity:1; }
textarea { resize:vertical; }
label.field { display:block; font-weight:600; margin:14px 0 6px; }
.field-foot { display:flex; justify-content:space-between; gap:12px; margin-top:6px; }
.count { font-variant-numeric:tabular-nums; white-space:nowrap; }
button, .button { font:inherit; font-weight:600; padding:10px 18px; border-radius:999px; border:1px solid transparent;
  cursor:pointer; background:var(--branch); color:var(--branch-fg); text-decoration:none; display:inline-flex;
  align-items:center; gap:10px; line-height:1.2; }
button:hover, .button:hover { filter:brightness(1.08); }
button.secondary, .button.secondary { background:transparent; color:var(--fg); border-color:var(--line); }
button.danger { background:var(--bad); color:var(--bad-fg); }
button.quiet { background:transparent; color:var(--bad); border-color:var(--bad); }
.status { font-size:.8rem; padding:2px 10px; border-radius:999px; border:1px solid var(--line); white-space:nowrap; }
.status.built { color:var(--ok); border-color:var(--ok); }
.status.failed, .status.rejected, .status.discarded { color:var(--bad); border-color:var(--bad); }
.status.review { color:var(--node-text); border-color:var(--node-text); }
.status.pending, .status.approved, .status.running { color:var(--muted); }
.version { font-size:.8rem; font-weight:600; color:var(--node-text); white-space:nowrap; }
.flag { color:var(--bad); font-size:.88rem; }
.error { color:var(--bad); }
ul.list { list-style:none; padding:0; margin:0; } ul.list li { padding:12px 0; border-top:1px solid var(--line); }
ul.list li:first-child { border-top:0; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.75rem; max-height:240px; overflow:auto; background:var(--bg);
  padding:10px; border-radius:10px; border:1px solid var(--line); }
pre.diff { max-height:480px; }
pre.diff .add { color:var(--add); } pre.diff .del { color:var(--del); } pre.diff .meta { color:var(--muted); font-weight:600; }
.notice { background:var(--card); border:1px solid var(--ok); color:var(--fg); border-radius:12px; padding:12px 14px; margin:12px 0; }
.includes { margin:10px 0 4px; padding-left:20px; } .includes li { margin:2px 0; }
details.confirm > summary { cursor:pointer; color:var(--bad); font-weight:600; list-style:none; display:inline-flex; padding:8px 0; }
details.confirm > summary::-webkit-details-marker { display:none; }
details.confirm[open] { border:1px solid var(--bad); border-radius:12px; padding:4px 14px 14px; margin-top:8px; }
.decide { display:grid; gap:10px; margin-top:10px; }
.target { font-weight:600; }
.hint { font-size:.92rem; color:var(--muted); }
.hint summary { cursor:pointer; color:var(--branch); }
.topbar { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
.brand { display:inline-flex; align-items:center; gap:8px; font-weight:700; font-size:1.1rem; color:var(--fg);
  text-decoration:none; letter-spacing:-.01em; }
.brand svg { width:22px; height:22px; }
.g-logo { width:18px; height:18px; background:#fff; border-radius:50%; padding:2px; flex:none; }

.landing main { max-width:1040px; padding-top:20px; }
.hero { display:grid; grid-template-columns:1fr; gap:8px 48px; align-items:center; padding:32px 0 24px; }
.hero h1 { font-size:clamp(2.4rem, 7vw, 3.8rem); line-height:1.02; letter-spacing:-.035em; font-weight:800;
  max-width:16ch; margin-bottom:20px; }
.hero .lead { font-size:1.2rem; line-height:1.5; max-width:34ch; margin:0 0 28px; }
.hero .button { font-size:1.05rem; padding:14px 22px; }
.hero .note { margin-top:12px; }
.branches { width:100%; max-width:500px; justify-self:center; }
.branches .trunk { stroke:var(--fg); }
.branches .mine { stroke:var(--branch); }
.branches .other { stroke:var(--muted); opacity:.55; }
.branches .node { fill:var(--node); stroke:var(--bg); stroke-width:3; }
.branches .stem { fill:var(--bg); stroke:var(--fg); stroke-width:3; }
.branches .ghost { fill:var(--bg); stroke:var(--muted); stroke-width:3; }
.branches text { fill:var(--fg); font:500 15px "Bricolage Grotesque", system-ui, sans-serif; }
.branches text.faint { fill:var(--muted); }
.branches .draw { stroke-dasharray:420; stroke-dashoffset:420; animation:grow 1.4s .2s cubic-bezier(.3,.7,.2,1) forwards; }
.branches .late { opacity:0; animation:appear .4s 1.3s forwards; }
@keyframes grow { to { stroke-dashoffset:0; } }
@keyframes appear { to { opacity:1; } }
@media (prefers-reduced-motion: reduce) { .branches .draw { animation:none; stroke-dashoffset:0; }
  .branches .late { animation:none; opacity:1; } }
.steps { list-style:none; margin:8px 0 0; padding:0 0 0 30px; position:relative; max-width:60ch; }
.steps::before { content:""; position:absolute; left:11px; top:8px; bottom:8px; width:2px; background:var(--fg); }
.steps li { position:relative; padding:0 0 24px 16px; }
.steps li::before { content:counter(step); counter-increment:step; position:absolute; left:-30px; top:0; width:24px; height:24px;
  border-radius:50%; background:var(--bg); border:2px solid var(--fg); font-size:.78rem; font-weight:700;
  display:grid; place-items:center; }
.steps li:last-child::before { background:var(--node); border-color:var(--node); color:#17231c; }
.steps { counter-reset:step; }
.steps strong { display:block; font-size:1.1rem; font-weight:650; }
.section { padding:40px 0 8px; border-top:1px solid var(--line); margin-top:32px; }
.promises { display:grid; gap:20px; grid-template-columns:1fr; max-width:900px; }
.promises p { margin:0; max-width:36ch; }
.promises strong { display:block; margin-bottom:4px; }
.footer { margin-top:56px; color:var(--muted); font-size:.9rem; display:flex; gap:16px; flex-wrap:wrap; }
.footer a { color:var(--muted); }
.closing { padding:40px 0 0; }
.closing p { max-width:46ch; }
.apps { display:grid; gap:12px; grid-template-columns:1fr; margin-top:8px; }
.app-link { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; align-items:center; padding:16px; border:1px solid var(--line);
  border-radius:16px; text-decoration:none; color:var(--fg); background:var(--card); max-width:520px; }
.app-link:hover { border-color:var(--branch); }
.app-link .app-name { font-weight:650; font-size:1.1rem; }
.app-link .app-line { grid-column:2; color:var(--muted); font-size:.95rem; }
.app-icon { grid-row:span 2; width:44px; height:44px; border-radius:12px; display:grid; place-items:center;
  background:var(--fg); color:var(--bg); }
.app-icon svg { width:26px; height:26px; }
.scope { margin-top:18px; max-width:60ch; }
.prose { max-width:66ch; } .prose h2 { margin-top:32px; } .prose ul { padding-left:20px; }
.prose p, .prose li { max-width:56ch; } .prose .lead { max-width:44ch; font-size:1.15rem; }
.facts { list-style:none; padding:0; margin:18px 0 0; display:grid; gap:6px; max-width:60ch; }
.facts li { padding-left:18px; position:relative; }
.facts li::before { content:""; position:absolute; left:0; top:.6em; width:8px; height:8px; border-radius:50%; background:var(--node); }
@media (min-width: 820px) {
  .hero { grid-template-columns:1.1fr .9fr; padding:56px 0 40px; }
  .promises { grid-template-columns:repeat(3, 1fr); }
}
`;

const FONTS = '<link rel="preload" href="/fonts/bricolage-grotesque-latin.woff2" as="font" type="font/woff2" crossorigin>';

function refreshScript(seconds: number): string {
  return `<script data-refresh="${seconds}">setInterval(function () {
  var busy = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  var typed = Array.prototype.some.call(document.querySelectorAll('input[type=text], textarea'), function (e) { return e.value; });
  var open = document.querySelector('details.confirm[open]');
  if (!busy && !typed && !open) location.reload();
}, ${seconds * 1000});</script>`;
}

export function page(title: string, body: Raw, opts: { refreshSec?: number; bodyClass?: string } = {}): string {
  const refresh = opts.refreshSec ? refreshScript(opts.refreshSec) : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
${FONTS}
<style>${STYLE}</style>
</head>
<body${opts.bodyClass ? ` class="${esc(opts.bodyClass)}"` : ''}><main>${body.value}</main>${refresh}</body>
</html>`;
}

export const USER_STATUS_LABEL: Record<string, string> = {
  pending: 'Esperando aprobación',
  approved: 'Aprobada, en cola',
  rejected: 'Rechazada',
  running: 'Programándose',
  review: 'El dueño revisa el código',
  built: 'Lista',
  failed: 'No se pudo publicar',
  discarded: 'Descartada',
};

export function renderDiff(patch: string): Raw {
  const lines = patch.split('\n').map((line) => {
    const kind = /^(diff --git|\+\+\+|---|@@)/.test(line) ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    return kind ? `<span class="${kind}">${esc(line)}</span>` : esc(line);
  });
  return raw(lines.join('\n'));
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Esperando aprobación',
  approved: 'En cola',
  rejected: 'Rechazada',
  running: 'Implementando',
  review: 'Por revisar',
  built: 'Lista',
  failed: 'Falló',
  discarded: 'Descartada',
};

export function fmtDate(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}
