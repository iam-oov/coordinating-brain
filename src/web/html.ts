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
  --bg:#edf1ec; --card:#f7f9f6; --fg:#17231c; --muted:#56665c; --line:#c9d3cb; --field:#75877b;
  --branch:#2557d6; --branch-fg:#ffffff; --node:#e2a62a; --node-text:#7a4f00; --bad:#b3261e; --bad-fg:#ffffff;
  --ok:#2e7d4f; --focus:#2557d6; --add:#1f6b3d; --del:#a3271d; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#0f1712; --card:#16211a; --fg:#e4ece6; --muted:#93a49a; --line:#2a3a30; --field:#5f7768;
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
select.select { font:inherit; min-height:48px; padding:0 14px; border-radius:12px; border:1px solid var(--field); background:var(--bg); color:var(--fg); width:100%; }
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
.status { display:inline-block; font-size:.76rem; font-weight:600; line-height:1.4; padding:2px 7px; border-radius:5px;
  white-space:nowrap; color:var(--muted); background:color-mix(in srgb, currentColor 10%, transparent); }
.status.built { color:var(--ok); }
.status.failed, .status.rejected, .status.discarded { color:var(--bad); }
.status.review { color:var(--node-text); }
.version { font-size:.8rem; font-weight:600; color:var(--node-text); white-space:nowrap; }
.flag { color:var(--bad); font-size:.88rem; }
.all-clear { display:flex; align-items:center; gap:8px; margin:16px 0; color:var(--muted); font-size:.95rem; font-weight:600; }
.error { color:var(--bad); }
ul.list { list-style:none; padding:0; margin:0; } ul.list > li { padding:12px 0; border-top:1px solid var(--line); }
ul.list > li:first-child { border-top:0; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.75rem; max-height:240px; overflow:auto; background:var(--bg);
  padding:10px; border-radius:10px; border:1px solid var(--line); }
pre.diff { max-height:480px; }
details.log, details.earlier { margin-top:10px; }
details.log > summary, details.earlier > summary { cursor:pointer; list-style:none; display:inline-flex; align-items:center; gap:6px;
  min-height:36px; font-size:.9rem; font-weight:600; color:var(--muted); }
details.log > summary::-webkit-details-marker, details.earlier > summary::-webkit-details-marker { display:none; }
details.log > summary .icon, details.earlier > summary .icon { width:16px; height:16px; transition:transform .2s ease-out; }
details.log[open] > summary .icon, details.earlier[open] > summary .icon { transform:rotate(180deg); }
details.log[open] > summary { margin-bottom:6px; color:var(--fg); }
@media (prefers-reduced-motion: reduce) { details.log > summary .icon, details.earlier > summary .icon { transition:none; } }
.log-panel { border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--bg); }
.log-list { list-style:none; margin:0; padding:6px 0; max-height:380px; overflow:auto; font-size:.86rem; line-height:1.45; }
.log-list li { display:grid; grid-template-columns:6.6rem minmax(0, 1fr); gap:0 12px; padding:5px 14px; }
.log-list li.step { margin-top:6px; padding-top:10px; border-top:1px solid var(--line); }
.log-list li.step:first-child { margin-top:0; border-top:0; }
.log-list time { color:var(--muted); font-size:.78rem; font-variant-numeric:tabular-nums; padding-top:2px; white-space:nowrap; }
.log-msg { min-width:0; overflow-wrap:anywhere; }
.log-msg code { font-size:.8rem; background:var(--card); border:1px solid var(--line); border-radius:5px; padding:0 5px; }
.log-list li.step .log-msg { font-weight:700; }
.log-list li.err .log-msg { color:var(--bad); font-weight:600; }
.log-list li.ok .log-msg { color:var(--ok); font-weight:600; }
.log-detail { margin:6px 0 2px; max-height:220px; font-size:.74rem; background:var(--card); }
.log-list li.err .log-detail, .log-list li.ok .log-detail { color:var(--fg); font-weight:400; }
.log-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:6px 6px 6px 12px;
  background:var(--card); border-bottom:1px solid var(--line); font-size:.82rem; color:var(--muted); }
.log-bar button.copy { min-height:32px; padding:0 12px; font-size:.85rem; gap:6px; }
.log-bar button.copy .icon { width:15px; height:15px; }
.run-label { margin:12px 0 6px; font-size:.82rem; font-weight:600; color:var(--muted); }
.build-row { display:flex; align-items:center; justify-content:space-between; gap:12px 16px; flex-wrap:wrap; }
.build-info { flex:1 1 260px; min-width:0; }
.build-title { margin:0; font-weight:600; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.build-meta { margin:2px 0 0; font-size:.85rem; color:var(--muted); font-variant-numeric:tabular-nums; }
.whats-new { border-radius:12px; background:var(--bg); padding:12px 14px; }
.whats-new .label { margin:0 0 2px; font-size:.82rem; font-weight:700; color:var(--node-text); }
.whats-new p { margin:0; }
pre.diff .add { color:var(--add); } pre.diff .del { color:var(--del); } pre.diff .meta { color:var(--muted); font-weight:600; }
.notice { background:var(--card); border:1px solid var(--ok); color:var(--fg); border-radius:12px; padding:12px 14px; margin:12px 0; }
.includes { margin:10px 0 4px; padding-left:20px; } .includes li { margin:2px 0; }
details.confirm > summary { cursor:pointer; color:var(--bad); font-weight:600; list-style:none; display:inline-flex; padding:8px 0; }
details.confirm > summary::-webkit-details-marker { display:none; }
details.confirm[open] { border:1px solid var(--bad); border-radius:12px; padding:4px 14px 14px; margin-top:8px; }
.decision { margin-top:16px; padding:14px 16px; border:1px solid var(--line); border-radius:14px; background:var(--bg);
  display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px 20px; }
.decision.risky { border-color:var(--bad); }
.decision-field { flex:1 1 100%; display:grid; gap:6px; }
.decision-field label { font-weight:600; font-size:.92rem; }
.decision-field input { background:var(--card); }
.decision-text { flex:1 1 240px; min-width:0; display:grid; gap:2px; }
.decision-text span { color:var(--muted); font-size:.9rem; }
.decision-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.decision-actions form { margin:0; }
.also-main { display:inline-flex; align-items:center; gap:8px; min-height:44px; font-size:.92rem; font-weight:600; margin-right:4px; }
.also-main input { width:18px; height:18px; accent-color:var(--branch); }
details.changes > summary { cursor:pointer; font-weight:600; }
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
.portal-head { margin:44px 0 28px; } .portal-head p { margin:0 0 6px; color:var(--muted); }
.portal-head h1 { font-size:clamp(2.2rem, 6vw, 2.75rem); line-height:1.05; letter-spacing:-.03em; font-weight:800; margin:0; }
.app-block { margin-bottom:56px; }
.app-title { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:22px; }
.app-title h2 { margin:0; font-size:1.6rem; letter-spacing:-.02em; font-weight:700; }
.app-title .more { font-weight:600; font-size:.95rem; }
.app-grid { display:grid; gap:24px 28px; grid-template-columns:minmax(0, 1fr);
  grid-template-areas:"version" "idea" "branch"; }
.panel { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:24px; display:flex; flex-direction:column; gap:14px; }
.panel h3 { margin:0; font-size:1.35rem; font-weight:700; color:var(--fg); }
.panel p { margin:0; }
.panel-version { grid-area:version; }
.panel-version .when { color:var(--muted); font-size:.92rem; }
.panel-version .actions { display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
.panel-version .button { min-height:48px; padding:0 24px; }
.panel-empty { grid-area:version; border:1.5px dashed var(--field); border-radius:20px; padding:24px; display:flex; gap:16px; align-items:flex-start; }
.panel-empty h3 { margin:0 0 6px; font-size:1.35rem; font-weight:700; color:var(--fg); }
.panel-empty p { margin:0 0 12px; color:var(--muted); }
.panel-idea { grid-area:idea; }
.panel-idea label.field { margin:6px 0 0; }
.panel-idea button { min-height:48px; justify-content:center; }
.idea-toggle { grid-area:idea; }
.idea-toggle > summary { list-style:none; cursor:pointer; display:flex; justify-content:center; align-items:center; gap:10px;
  min-height:48px; border-radius:999px; border:1px solid var(--line); background:var(--card); font-weight:600; }
.idea-toggle > summary::-webkit-details-marker { display:none; }
.idea-toggle[open] > summary { display:none; }
.hint > summary { min-height:44px; display:inline-flex; align-items:center; }
.public-note { display:flex; gap:10px; align-items:flex-start; font-size:.88rem; color:var(--muted); }
.public-note svg { flex:none; margin-top:2px; }
.branch { grid-area:branch; }
.branch h3 { margin:0 0 16px; font-size:1.35rem; font-weight:700; color:var(--fg); }
.timeline { list-style:none; margin:0; padding:0; position:relative; display:flex; flex-direction:column; gap:26px; }
.timeline::before { content:""; position:absolute; left:11px; top:14px; bottom:14px; width:2px; background:var(--branch); }
.timeline li { position:relative; display:flex; gap:16px; }
.timeline .node { flex:none; width:24px; height:24px; border-radius:50%; box-sizing:border-box; margin-top:2px;
  background:var(--bg); border:3px solid var(--node-text); display:grid; place-items:center; }
.timeline .node.in { background:var(--node); border-color:var(--node); }
.timeline .node.off { border-color:var(--field); }
.timeline .node.root { background:var(--fg); border-color:var(--fg); }
.timeline .node.trunk { background:var(--fg); border-color:var(--fg); box-shadow:inset 0 0 0 3px var(--bg); }
.timeline .meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:4px; }
.timeline .when { font-size:.82rem; color:var(--muted); }
.timeline .idea { margin:0; font-weight:500; color:var(--fg); }
.timeline .off-text { color:var(--muted); }
.note { margin:4px 0 0; color:var(--muted); font-size:.92rem; }
.timeline .note { font-size:.94rem; }
.note-text { margin:0; overflow-wrap:anywhere; }
.note-text code { font-size:.86em; padding:0 4px; border-radius:4px; color:var(--fg);
  background:color-mix(in srgb, var(--fg) 7%, transparent); }
.note.clamp:not(:has(> details[open])) > .note-text { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; }
details.more-text > summary { cursor:pointer; list-style:none; display:inline-flex; align-items:center; gap:4px; min-height:32px;
  font-size:.86rem; font-weight:600; color:var(--branch); }
details.more-text > summary::-webkit-details-marker { display:none; }
details.more-text > summary .icon { width:16px; height:16px; transition:transform .2s ease-out; }
details.more-text[open] > summary .icon { transform:rotate(180deg); }
details.more-text:not([open]) .less, details.more-text[open] .more { display:none; }
@media (prefers-reduced-motion: reduce) { details.more-text > summary .icon { transition:none; } }
.timeline .base { margin:0; color:var(--muted); font-size:.94rem; align-self:center; white-space:nowrap; }
.pill-in { display:inline-block; font-size:.76rem; font-weight:700; line-height:1.4; color:#17231c; background:var(--node); border-radius:5px; padding:2px 7px; white-space:nowrap; }
.icon { flex:none; }
.switcher { display:flex; gap:10px; overflow-x:auto; padding:2px 28px 8px 2px; margin:0 0 28px; list-style:none; scrollbar-width:thin;
  mask-image:linear-gradient(to right, #000 calc(100% - 28px), transparent); }
.switcher li { flex:none; display:flex; align-items:center; border:1px solid var(--line); border-radius:16px; background:transparent; }
.switcher li.current { border-color:var(--branch); background:var(--card); box-shadow:0 1px 2px rgba(23,35,28,.06), 0 4px 14px rgba(23,35,28,.06); }
.switcher a { display:flex; align-items:center; gap:10px; min-height:52px; padding:0 4px 0 10px; color:var(--fg); text-decoration:none; font-weight:600; }
.switcher .app-icon { width:34px; height:34px; border-radius:9px; }
.switcher .app-icon svg { width:20px; height:20px; }
.switcher .count { font-size:.78rem; font-weight:700; color:var(--branch-fg); background:var(--branch); border-radius:5px; padding:0 6px; }
.fav { display:grid; place-items:center; width:44px; height:44px; padding:0; border:0; border-radius:12px; background:transparent;
  color:var(--muted); cursor:pointer; }
.fav:hover { color:var(--bad); filter:none; }
.fav.on { color:var(--bad); }
.filters { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 18px; }
.filters a { display:inline-flex; align-items:center; min-height:36px; padding:0 12px; border-radius:8px; text-decoration:none; color:var(--muted);
  font-size:.9rem; font-weight:600; }
.filters a[aria-current="true"] { background:var(--card); color:var(--fg); box-shadow:inset 0 0 0 1px var(--line); }
.more-row { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:18px; color:var(--muted); font-size:.9rem; }
details.fold > summary { cursor:pointer; list-style:none; display:flex; align-items:center; justify-content:space-between; gap:12px; }
details.fold > summary::-webkit-details-marker { display:none; }
details.fold > summary h2 { margin:0; }
details.fold > summary .icon { transition:transform .2s ease-out; color:var(--muted); }
details.fold[open] > summary .icon { transform:rotate(180deg); }
details.fold[open] > summary { margin-bottom:14px; }
@media (prefers-reduced-motion: reduce) { details.fold > summary .icon { transition:none; } }
body.portal main { max-width:1000px; }
@media (min-width: 860px) {
  .app-grid { grid-template-columns:minmax(0, 1.1fr) minmax(0, 1fr); grid-template-rows:auto 1fr;
    grid-template-areas:"version idea" "branch idea"; align-items:start; }
  .panel, .panel-empty { padding:28px; }
}
@media (min-width: 860px) and (min-height: 760px) {
  .panel-idea, .idea-toggle { position:sticky; top:24px; align-self:start; }
}
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

const FONTS =
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' +
  '<link rel="preload" href="/fonts/bricolage-grotesque-latin.woff2" as="font" type="font/woff2" crossorigin>';

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
<html lang="en">
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

export const API_STATUS_LABEL: Record<string, string> = {
  pending: 'Esperando aprobación',
  approved: 'Aprobada, en cola',
  rejected: 'Rechazada',
  running: 'Programándose',
  review: 'El dueño revisa el código',
  built: 'Lista',
  failed: 'No se pudo publicar',
  discarded: 'Descartada',
};

export const USER_STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved, queued',
  rejected: 'Rejected',
  running: 'Being built',
  review: 'Owner is reviewing the code',
  built: 'In the base version',
  failed: 'Could not be published',
  discarded: 'Discarded',
};

const LOG_ENTRY_START = /^(?:\d{4}-\d{2}-\d{2}T|…$)/;

export const FORCED_LOG_LINE =
  'Forzada por el admin: núcleo, dependencias y permisos de Android desbloqueados; pide revisión antes de publicar';
const RUN_START = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z ${FORCED_LOG_LINE.split(':')[0]}`);

export function splitRuns(log: string): string[] {
  const runs: string[][] = [[]];
  for (const line of log.replace(/\n+$/, '').split('\n')) {
    if (RUN_START.test(line) && runs[runs.length - 1].length > 0) runs.push([]);
    runs[runs.length - 1].push(line);
  }
  return runs.map((lines) => `${lines.join('\n')}\n`);
}

export function newestFirst(log: string): string {
  const entries: string[] = [];
  for (const line of log.replace(/\n+$/, '').split('\n')) {
    if (entries.length === 0 || LOG_ENTRY_START.test(line)) entries.push(line);
    else entries[entries.length - 1] += `\n${line}`;
  }
  return entries.reverse().join('\n');
}

export interface LogEntry {
  at: string;
  text: string;
  detail: string;
  kind: 'err' | 'ok' | 'step' | '';
}

const LOG_ERR = /(fallaron|Terminado sin publicar|rechazada|No llegó|no pasó|no compiló|ya no aplica|Error inesperado)/i;
const LOG_OK = /(APK publicado|Pruebas aprobadas|^Push a )/;
const LOG_STEP = /^(Intento \d+\/\d+|Forzada por el admin|Aplicando el diff revisado)/;

export function parseLog(run: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of run.replace(/\n+$/, '').split('\n')) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/);
    if (m) {
      const text = m[2];
      const kind = LOG_ERR.test(text) ? 'err' : LOG_OK.test(text) ? 'ok' : LOG_STEP.test(text) ? 'step' : '';
      entries.push({ at: m[1], text, detail: '', kind });
    } else if (entries.length) {
      const e = entries[entries.length - 1];
      e.detail = e.detail ? `${e.detail}\n${line}` : line;
    }
  }
  return entries.reverse();
}

export function renderDiff(patch: string): Raw {
  const lines = patch.split('\n').map((line) => {
    const kind = /^(diff --git|\+\+\+|---|@@)/.test(line) ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    return kind ? `<span class="${kind}">${esc(line)}</span>` : esc(line);
  });
  return raw(lines.join('\n'));
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  approved: 'Queued',
  rejected: 'Rejected',
  running: 'Building',
  review: 'To review',
  built: 'Built',
  failed: 'Failed',
  discarded: 'Discarded',
};

export function fmtDay(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-US', { dateStyle: 'medium' });
}

export function fmtDate(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function capitalizeFirst(text: string): string {
  const [first = '', ...rest] = text;
  return first.toUpperCase() + rest.join('');
}

export function fmtWhen(ms: number | null, now = Date.now()): string {
  if (!ms) return '';
  return new Date(ms).toDateString() === new Date(now).toDateString() ? fmtDate(ms) : fmtDay(ms);
}

function noteLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*```/.test(line))
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*[-*•]\s+/, '')
        .replaceAll('**', '')
        .trim(),
    )
    .filter(Boolean);
}

export function richText(text: string): Raw {
  return raw(
    noteLines(text)
      .map((line) => esc(line).replace(/`([^`]+)`/g, '<code>$1</code>'))
      .join('<br>'),
  );
}

export function richTextRows(text: string, charsPerRow = 72): number {
  return noteLines(text).reduce((rows, line) => rows + Math.max(1, Math.ceil(line.replaceAll('`', '').length / charsPerRow)), 0);
}
