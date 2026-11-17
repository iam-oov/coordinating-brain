/** Minimal server-rendered HTML for the portal and the admin panel. UI text is Spanish. */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Tagged template that escapes every interpolated value unless it is `raw()`. */
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
:root { color-scheme: light dark; --bg:#f6f5f1; --fg:#1d1d1b; --muted:#6b6a64; --card:#fff; --line:#dedcd3;
  --accent:#4b5320; --accent-fg:#fff; --bad:#a3271d; --ok:#2f6b2a; }
@media (prefers-color-scheme: dark) { :root { --bg:#151612; --fg:#ecebe4; --muted:#a3a197; --card:#1f201b;
  --line:#34352e; --accent:#c3cf7d; --accent-fg:#151612; --bad:#ff8a7a; --ok:#9bd68f; } }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.5 system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--fg); }
main { max-width:760px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:1.5rem; margin:0 0 4px; } h2 { font-size:1.15rem; margin:0 0 8px; }
.muted { color:var(--muted); font-size:.9rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:16px 0; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
input[type=text], input[type=password], textarea { font:inherit; padding:10px 12px; border-radius:8px;
  border:1px solid var(--line); background:var(--bg); color:var(--fg); width:100%; }
input.code { width:8ch; letter-spacing:.4em; text-align:center; font-size:1.4rem; }
button, .button { font:inherit; padding:10px 16px; border-radius:999px; border:0; cursor:pointer;
  background:var(--accent); color:var(--accent-fg); text-decoration:none; display:inline-block; }
button.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
button.danger { background:var(--bad); color:#fff; }
.status { font-size:.8rem; padding:2px 8px; border-radius:999px; border:1px solid var(--line); white-space:nowrap; }
.status.built { color:var(--ok); border-color:var(--ok); }
.status.failed, .status.rejected, .status.discarded { color:var(--bad); border-color:var(--bad); }
.flag { color:var(--bad); font-size:.85rem; }
.error { color:var(--bad); }
ul.list { list-style:none; padding:0; margin:0; } ul.list li { padding:10px 0; border-top:1px solid var(--line); }
ul.list li:first-child { border-top:0; }
pre { white-space:pre-wrap; font-size:.75rem; max-height:240px; overflow:auto; background:var(--bg); padding:8px; border-radius:8px; }
`;

export function page(title: string, body: Raw): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body.value}</main></body>
</html>`;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Esperando aprobación',
  approved: 'En cola',
  rejected: 'Rechazada',
  running: 'Implementando',
  built: 'Lista',
  failed: 'Falló',
  discarded: 'Descartada',
};

export function fmtDate(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}
