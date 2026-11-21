import type { Raw } from './html.ts';
import { raw } from './html.ts';

function icon(paths: string, extra = ''): Raw {
  return raw(
    `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${paths}</svg>`,
  );
}

export const ICONS = {
  download: icon('<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  send: icon('<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>'),
  heart: icon('<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z"/>'),
  heartFilled: icon('<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z" fill="currentColor"/>'),
  signOut: icon('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>'),
  shield: icon('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
  apps: icon('<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>'),
  check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  publish: icon('<path d="M12 20V8"/><path d="M7 12l5-5 5 5"/><path d="M5 4h14"/>'),
  undo: icon('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  bolt: icon('<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>'),
  more: icon('<path d="M6 9l6 6 6-6"/>'),
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
  globe: icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>'),
  arrowRight: icon('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  login: icon('<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M14 16l4-4-4-4"/><path d="M18 12H8"/>'),
  cross: raw(
    '<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>',
  ),
};

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="#17231c"/>
<path d="M11 6v20" stroke="#edf1ec" stroke-width="3" stroke-linecap="round"/>
<path d="M11 12c0 5 11 3 11 9v5" stroke="#7ea0ff" stroke-width="3" stroke-linecap="round" fill="none"/>
<circle cx="22" cy="20" r="3.4" fill="#f2c14e"/>
</svg>`;
