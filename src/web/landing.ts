import { readFileSync } from 'node:fs';

import type { AppPage } from './catalog.ts';
import { APP_PAGES } from './catalog.ts';
import type { Raw } from './html.ts';
import { html, raw } from './html.ts';
import { ICONS } from './icons.ts';

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
  aria-label="Your version of the app grows out of the base version as a branch of its own, with the changes you asked for.">
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
    <text class="faint" x="76" y="34">base version</text>
    <text x="246" y="166">your version</text>
    <text x="250" y="219">Dark mode</text>
    <text x="250" y="287">Microphone button</text>
    <text class="faint" x="130" y="348" text-anchor="middle">someone else</text>
  </g>
</svg>`);

export function signInButton(next: string, label = 'Sign in with Google'): Raw {
  return html`<a class="button" href="/auth/google/start?next=${encodeURIComponent(next)}">${GOOGLE_G}${label}</a>`;
}

export function topbar(signInEnabled: boolean, signedIn = false): Raw {
  return html`<header class="topbar">
    <a class="brand" href="${signedIn ? '/apks' : '/'}">${BRAND_MARK}Cerebro</a>
    ${signedIn
      ? html`<a class="button secondary" href="/apks">${ICONS.apps}Your apps</a>`
      : signInEnabled
        ? html`<a class="button secondary" href="/auth/google/start?next=%2Fapks">${ICONS.login}Sign in</a>`
        : ''}
  </header>`;
}

export function footer(): Raw {
  return html`<footer class="footer">
    <span>v${APP_VERSION}</span>
    <span>Cerebro is a personal project by <a href="${GITHUB_URL}">Osvaldo Hinojosa</a> 🧡</span>
    <a href="/privacy">Privacy</a>
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
    : html`<p class="error">Google sign-in is not configured.</p>`;
  return html`
    ${topbar(signInEnabled)}

    <section class="hero">
      <div>
        <h1>Your app, with the changes you ask for.</h1>
        <p class="lead">
          Cerebro collects ideas from the people who use an app, like Jeep OBD2. If the owner approves your idea, an AI
          builds it, tests it and delivers it as your own version of the app.
        </p>
        ${cta}
        <p class="muted note">We only use your Google name and email.</p>
      </div>
      ${BRANCHES}
    </section>

    <section class="section">
      <h2>Cerebro's apps</h2>
      <div class="apps">${APP_PAGES.map(appLink)}</div>
      <p class="scope muted">
        Cerebro only works with this project's apps. It does not work with Play Store apps or apps from other
        developers: it can only change the code of the apps that live here.
      </p>
    </section>

    <section class="section">
      <h2>How it works</h2>
      <ol class="steps">
        <li><strong>Write your idea</strong>From the app's suggestions button or from this page. Up to 280 characters.</li>
        <li><strong>The owner reviews it</strong>Nothing gets built without their approval.</li>
        <li><strong>An AI builds and tests it</strong>If the tests or the build fail, nothing is published.</li>
        <li><strong>Download your version</strong>Your changes live in your own branch. Other people's changes don't affect you.</li>
      </ol>
    </section>

    <section class="section">
      <h2>What never changes</h2>
      <div class="promises">
        <p><strong>The core is protected</strong>The essential parts of each app are out of reach for any request.</p>
        <p><strong>Everything is public</strong>Your ideas and your version's code are on <a href="${GITHUB_URL}">GitHub</a>. Don't write personal data.</p>
        <p><strong>New code runs isolated</strong>Tests run without internet and without access to keys or passwords.</p>
      </div>
    </section>

    ${signInEnabled
      ? html`<section class="closing">
          <h2>Have an idea for one of these apps?</h2>
          <p class="muted">Sign in with your Google account and send it. You'll see here when your version is ready.</p>
          ${signInButton('/apks')}
        </section>`
      : ''}

    ${footer()}
  `;
}

export function appDetailPage(a: AppPage, hasBuild: boolean, signInEnabled: boolean, signedIn: boolean): Raw {
  return html`
    ${topbar(signInEnabled, signedIn)}
    <article class="prose">
      <div class="row"><span class="app-icon">${a.icon}</span><h1>${a.name}</h1></div>
      <p class="lead">${a.summary}</p>
      ${hasBuild
        ? html`<p><a class="button" href="/apps/${a.slug}/apk" download>${ICONS.download}Download ${a.name} for Android</a></p>
            <p class="hint">This is the base version. When you open it, sign in with Google; from the suggestions button you
              can ask for changes and get your own version.</p>`
        : html`<p class="muted">There is no published APK of ${a.name} yet.</p>`}
      <details class="hint"><summary>How do I install an APK?</summary>
        <p>The app is not on the Play Store. When you open the downloaded file, Android will ask you to let your browser
          install apps. Allow it just for this install; you can turn it off again afterwards.</p>
      </details>
      <h2>What it does</h2>
      <ul class="facts">${a.features.map((f) => html`<li>${f}</li>`)}</ul>
      <h2>What you need</h2>
      <ul class="facts">${a.requirements.map((f) => html`<li>${f}</li>`)}</ul>
    </article>
    ${footer()}
  `;
}

export function privacyPage(signInEnabled: boolean, signedIn: boolean): Raw {
  return html`
    ${topbar(signInEnabled, signedIn)}
    <article class="prose">
      <h1>Privacy</h1>
      <p class="muted">Cerebro (cerebro.valdoh.com) and its apps. Last updated: November 21, 2026.</p>

      <h2>What we store</h2>
      <ul>
        <li>From your Google account: your name, your email and your account ID. We ask for nothing else.</li>
        <li>The ideas you send, their status and the versions of the app built for you.</li>
        <li>A session cookie so you don't have to sign in every time.</li>
      </ul>

      <h2>What is public</h2>
      <p>The text of your ideas does not carry your name, but the code built from them is published on GitHub, in a
        branch named after your user number. That is why you should not write personal data in your ideas.</p>

      <h2>What we use it for</h2>
      <p>Only to let you sign in, send ideas and download your version. We don't sell or share your data, there are no
        ads and no trackers. Approved ideas are sent to Anthropic (Claude) to be built.</p>

      <h2>In the apps</h2>
      <p>Jeep OBD2 keeps your vehicles and your API keys only on your phone, encrypted. The keys are only sent to
        Anthropic and YouTube when you search for repair videos.</p>

      <h2>Where it lives and how to delete it</h2>
      <p>The data is on a private server. To delete your account and your data, write to
        <a href="mailto:osvaldo.javier14@gmail.com">osvaldo.javier14@gmail.com</a>. Code already published on GitHub can
        be removed along with your branch.</p>
    </article>
    ${footer()}
  `;
}
