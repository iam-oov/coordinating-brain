import { readFileSync } from 'node:fs';

import type { AppPage } from './catalog.ts';
import { APP_PAGES } from './catalog.ts';
import type { Raw } from './html.ts';
import { html, raw } from './html.ts';

const GITHUB_URL = 'https://github.com/iam-oov';
const APP_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export const BRAND_MARK = raw(`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-linecap="round">
  <path d="M7 3v18" stroke="currentColor" stroke-width="2.4"/>
  <path d="M7 8c0 4 10 2 10 7v6" stroke="var(--branch)" stroke-width="2.4"/>
  <circle cx="17" cy="16" r="2.6" fill="var(--node)"/>
</svg>`);

export const GOOGLE_G = raw(`<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`);

const BRANCHES = raw(`<svg class="branches" viewBox="0 0 420 356" role="img"
  aria-label="Tu versión de la app sale de la versión base como una rama propia, con los cambios que pediste.">
  <g fill="none" stroke-linecap="round">
    <path class="trunk draw" d="M60 20V320" stroke-width="6"/>
    <path class="other draw" d="M60 200c0 40 70 30 70 70v50" stroke-width="4"/>
    <path class="mine draw" d="M60 92c0 54 170 28 170 84v144" stroke-width="6"/>
  </g>
  <circle class="stem" cx="60" cy="56" r="7"/>
  <circle class="stem" cx="60" cy="150" r="7"/>
  <circle class="stem" cx="60" cy="262" r="7"/>
  <g class="late">
    <circle class="ghost" cx="130" cy="292" r="7"/>
    <circle class="node" cx="230" cy="214" r="10"/>
    <circle class="node" cx="230" cy="282" r="10"/>
    <text class="faint" x="76" y="34">versión base</text>
    <text x="246" y="166">tu versión</text>
    <text x="250" y="219">Modo oscuro</text>
    <text x="250" y="287">Botón de micrófono</text>
    <text class="faint" x="130" y="348" text-anchor="middle">otra persona</text>
  </g>
</svg>`);

export function signInButton(next: string, label = 'Entrar con Google'): Raw {
  return html`<a class="button" href="/auth/google/start?next=${encodeURIComponent(next)}">${GOOGLE_G}${label}</a>`;
}

export function topbar(signInEnabled: boolean): Raw {
  return html`<header class="topbar">
    <a class="brand" href="/">${BRAND_MARK}Cerebro</a>
    ${signInEnabled ? html`<a class="button secondary" href="/auth/google/start?next=%2Fapks">Entrar</a>` : ''}
  </header>`;
}

export function footer(): Raw {
  return html`<footer class="footer">
    <span>v${APP_VERSION}</span>
    <span>Cerebro es un proyecto personal de <a href="${GITHUB_URL}">Osvaldo Hinojosa</a> 🧡</span>
    <a href="/privacidad">Privacidad</a>
  </footer>`;
}

function appLink(a: AppPage): Raw {
  return html`<a class="app-link" href="/apps/${a.slug}">
    <span class="app-icon">${a.icon}</span>
    <span class="app-name">${a.name}</span>
    <span class="app-line">${a.line}</span>
  </a>`;
}

export function landingPage(signInEnabled: boolean): Raw {
  const cta = signInEnabled
    ? signInButton('/apks')
    : html`<p class="error">El inicio de sesión con Google no está configurado.</p>`;
  return html`
    ${topbar(signInEnabled)}

    <section class="hero">
      <div>
        <h1>Tu app, con los cambios que tú pides.</h1>
        <p class="lead">
          Cerebro recibe las ideas de quienes usan una app, como Jeep OBD2. Si el dueño aprueba tu idea, una IA la
          programa, se prueba y te llega como tu propia versión de la app.
        </p>
        ${cta}
        <p class="muted note">Solo usamos tu nombre y tu correo de Google.</p>
      </div>
      ${BRANCHES}
    </section>

    <section class="section">
      <h2>Las apps de Cerebro</h2>
      <div class="apps">${APP_PAGES.map(appLink)}</div>
      <p class="scope muted">
        Cerebro solo funciona con las apps de este proyecto. No sirve para apps de la Play Store ni de otros
        desarrolladores: solo puede cambiar el código de las apps que viven aquí.
      </p>
    </section>

    <section class="section">
      <h2>Cómo funciona</h2>
      <ol class="steps">
        <li><strong>Escribe tu idea</strong>Desde el botón de sugerencias de la app o desde esta página. Hasta 280 caracteres.</li>
        <li><strong>El dueño la revisa</strong>Nada se programa sin su aprobación.</li>
        <li><strong>Una IA la programa y la prueba</strong>Si las pruebas o la compilación fallan, no se publica nada.</li>
        <li><strong>Descargas tu versión</strong>Tus cambios viven en tu propia rama. Los de otras personas no te afectan.</li>
      </ol>
    </section>

    <section class="section">
      <h2>Lo que no cambia</h2>
      <div class="promises">
        <p><strong>El núcleo está protegido</strong>Las partes esenciales de cada app quedan fuera del alcance de cualquier solicitud.</p>
        <p><strong>Todo es público</strong>Tus solicitudes y el código de tu versión están en <a href="${GITHUB_URL}">GitHub</a>. No escribas datos personales.</p>
        <p><strong>El código nuevo corre aislado</strong>Las pruebas corren sin internet y sin acceso a llaves ni contraseñas.</p>
      </div>
    </section>

    ${signInEnabled
      ? html`<section class="closing">
          <h2>¿Tienes una idea para una de estas apps?</h2>
          <p class="muted">Entra con tu cuenta de Google y envíala. Te avisamos aquí cuando esté lista tu versión.</p>
          ${signInButton('/apks')}
        </section>`
      : ''}

    ${footer()}
  `;
}

export function appDetailPage(a: AppPage, hasBuild: boolean, signInEnabled: boolean): Raw {
  return html`
    ${topbar(signInEnabled)}
    <article class="prose">
      <div class="row"><span class="app-icon">${a.icon}</span><h1>${a.name}</h1></div>
      <p class="lead">${a.summary}</p>
      ${hasBuild
        ? html`<p><a class="button" href="/apps/${a.slug}/apk" download>Descargar ${a.name} para Android</a></p>
            <p class="hint">Es la versión base. Al abrirla, entra con Google; desde el botón de sugerencias puedes pedir
              cambios y recibir tu propia versión.</p>`
        : html`<p class="muted">Todavía no hay un APK publicado de ${a.name}.</p>`}
      <details class="hint"><summary>¿Cómo instalar un APK?</summary>
        <p>La app no está en la Play Store. Al abrir el archivo descargado, Android te pedirá permitir que el navegador
          instale apps. Acepta solo para esta instalación; después puedes volver a desactivarlo.</p>
      </details>
      <h2>Qué hace</h2>
      <ul class="facts">${a.features.map((f) => html`<li>${f}</li>`)}</ul>
      <h2>Qué necesitas</h2>
      <ul class="facts">${a.requirements.map((f) => html`<li>${f}</li>`)}</ul>
    </article>
    ${footer()}
  `;
}

export function privacyPage(signInEnabled: boolean): Raw {
  return html`
    ${topbar(signInEnabled)}
    <article class="prose">
      <h1>Privacidad</h1>
      <p class="muted">Cerebro (cerebro.valdoh.com) y sus apps. Última actualización: 21 de noviembre de 2026.</p>

      <h2>Qué datos guardamos</h2>
      <ul>
        <li>De tu cuenta de Google: tu nombre, tu correo y el identificador de tu cuenta. No pedimos acceso a nada más.</li>
        <li>Las ideas que envías, su estado y las versiones de la app que se generan para ti.</li>
        <li>Una cookie de sesión para que no tengas que entrar cada vez.</li>
      </ul>

      <h2>Qué es público</h2>
      <p>El texto de tus ideas no lleva tu nombre, pero el código que se genera a partir de ellas se publica en GitHub,
        en una rama con tu número de usuario. Por eso no debes escribir datos personales en tus ideas.</p>

      <h2>Para qué los usamos</h2>
      <p>Solo para que puedas entrar, enviar ideas y descargar tu versión. No vendemos ni compartimos tus datos, no hay
        publicidad y no usamos rastreadores. Las ideas aprobadas se envían a Anthropic (Claude) para programarlas.</p>

      <h2>En las apps</h2>
      <p>Jeep OBD2 guarda tus vehículos y tus llaves de API solo en tu teléfono, cifradas. Las llaves solo se envían a
        Anthropic y a YouTube cuando buscas videos de reparación.</p>

      <h2>Dónde viven y cómo borrarlos</h2>
      <p>Los datos están en un servidor propio. Para borrar tu cuenta y tus datos, escribe a
        <a href="mailto:osvaldo.javier14@gmail.com">osvaldo.javier14@gmail.com</a>. El código ya publicado en GitHub
        se puede eliminar junto con tu rama.</p>
    </article>
    ${footer()}
  `;
}
