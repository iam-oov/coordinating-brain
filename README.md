# coordinating-brain

Backend that lets the users of an app ask for improvements. The owner approves each request, Claude Code implements it, the brain verifies and builds the app, pushes the change to the user's own branch of the app (`users/<id>`), and publishes that user's APK at a fixed URL. Every user gets their own version of the app.

Inspired by [midudev/tuweb.dev](https://github.com/midudev/tuweb.dev), taken from one website to several apps and users. First app: [jeep-obd2](https://github.com/iam-oov/jeep-obd2).

> The web UI (portal and admin panel) is in Spanish. Code, comments and docs are in English.

## How it works

```
 app "Buzón" / portal        admin (/admin)            worker                         GitHub + portal
┌──────────────────┐     ┌──────────────────┐     ┌───────────────────────────┐     ┌──────────────────┐
│ user signs in    │     │ owner approves   │     │ Claude Code edits files   │     │ commit pushed to │
│ with Google and  │ ──▶ │ or rejects each  │ ──▶ │ diff gate · tests · build │ ──▶ │ users/<id> · APK │
│ sends a request  │     │ request          │     │ up to 3 attempts          │     │ for that user    │
└──────────────────┘     └──────────────────┘     └───────────────────────────┘     └──────────────────┘
```

1. **Request.** A user sends 16–280 characters to one of their apps, from the app's "Buzón" or from the portal. One open request per user and app.
2. **First filter.** A local heuristic refuses empty, oversized or fence-breaking text, and flags suspicious text (prompt injection, secrets, commands, build files) for the admin.
3. **Approval.** Only the owner, at `/admin`, approves or rejects. Nothing runs before that.
4. **Implementation.** The worker clones the app and runs Claude Code with file tools only (`Read`, `Edit`, `Write`, `Glob`, `Grep`): no shell, no network, no MCP, `--bare` (no user hooks or settings), and a budget cap. The request is passed **fenced as data**, never as instructions. The AI may refuse with `RECHAZO:`.
5. **Diff gate.** Only the app's allowed folders (`lib/`, `test/`, `assets/` for jeep-obd2), minus its **protected core** (`lib/core/`, `test/core/`, `lib/main.dart`: Google sign-in and the suggestions button); never `android/`, `ios/`, `pubspec.*`, CI, `CLAUDE.md`, secrets or key files; at most 800 changed lines; no binary files; no new line with keys, long encoded blobs, `String.fromEnvironment`, `Platform.environment` or `Process.run`.
6. **Verification.** The worker (not the AI) runs the app's prepare, test and build commands. On failure, the output goes back to the AI for another attempt (3 in total). If it never passes, nothing is pushed.
7. **Publish.** The worker bumps the build number (one counter per app, across all branches), commits, and pushes to the author's branch `users/<id>`. If the branch moved meanwhile, the local commit is rebased and verified again. Never a force push. Only then is the APK copied to `apks/<app>/users/<id>/`. Commits name the request, never its author: the app repo is public.
8. **Branches.** A new branch starts from `main`. Improvements on `main` do not reach existing branches, except the protected core and everything outside the allowed folders (build files, dependencies), which are synced from `main` before each change (`chore(core): sync from main`). The branch keeps its own features and version number.
9. **Also to main.** When the admin approves their own request with "También a main", it lands on `main` first and is then cherry-picked onto the admin's branch. No other request can push to `main` (checked at approval and again before the push).
10. **Downloads.** Each user gets the latest APK of their branch, or `main`'s if they have none yet; never another user's.
11. **Rollback.** From `/admin`, "Revertir este cambio" creates a new `git revert` commit and a new APK on that build's branch. History is never rewritten.
12. **Forcing.** The admin can force a failed or discarded request from `/admin`. It runs again with the protected core, new dependencies in `pubspec.yaml` and permissions in `AndroidManifest.xml` unlocked (Gradle, signing, CI and keys stay locked; tests still run in the sandbox). It lands on `main` first. Because a new dependency's Gradle code runs in the build, outside the sandbox, a forced request stops at **Por revisar** after its tests: the admin reads the diff and only then publishes it (the exact reviewed diff is applied, the AI is not called again) or discards it.
13. **Restarts.** Each pushed SHA is saved on the request. A request picked up again after a restart only republishes; it never calls the AI twice.

Every step is logged on the request, visible in `/admin`.

## Access

- **Users** sign in with Google. The app sends a Google ID token to `/api/login/google`; the web portal uses the authorization code flow with PKCE, state and nonce. ID tokens are verified against Google's keys (issuer, audience = the web client ID, verified email). Sign-up is open: a new account gets the app it signed in from. After 5 invalid tokens an IP is blocked for 15 minutes.
- Each user sees only the apps granted to them (`user_apps`), in the portal and the API.
- **Admin** is any account whose email is in `ADMIN_EMAILS`, checked on every request.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/login/google` | Google ID token | Session token and the user's apps (`{idToken, app}`) |
| GET | `/api/apps` | bearer | Apps and their latest APK |
| GET | `/api/apps/:slug/requests` | bearer | The user's requests for an app |
| POST | `/api/apps/:slug/requests` | bearer | New request `{ "text": "…" }` |
| POST | `/api/apps/:slug/download-link` | bearer | One-time URL (10 min) to download the latest APK in a browser |
| GET | `/apks` | cookie | Portal: Google sign-in, then apps, latest APK, requests |
| GET | `/apks/:slug/latest.apk` | cookie or `?dl=` | Always the latest APK of the app |
| GET | `/admin` | admin cookie | Approve/reject, queue, APKs, history, revert |
| GET | `/health` | — | Liveness |

## Run locally

Requires Node 24+ (uses the built-in `node:sqlite` and TypeScript type stripping).

```
npm install
npm test
cp .env.example .env            # set the GOOGLE_* ids and ADMIN_EMAILS; WORKER_ENABLED=0 to skip Claude runs
npm run cli -- app:jeep         # register jeep-obd2
node --env-file=.env src/main.ts
```

Other CLI commands: `user:link`, `user:grant`, `user:revoke`, `user:enable`, `user:disable`, `user:list`, `app:list`, `build:import`.

## Deploy (Linux server)

1. Create an unprivileged user `coordinating-brain` and clone this repo to `/home/coordinating-brain/coordinating-brain`; `npm ci --omit=dev`.
2. Install, for the `coordinating-brain` user: Node 26.13.1, git, JDK 17, the Flutter SDK in `/opt/flutter` (owned by `coordinating-brain`), the Android SDK (`platforms`, `build-tools`, accepted licenses) and Claude Code.
3. Give the worker push access to each app repo: a GitHub **deploy key with write access** in `~coordinating-brain/.ssh`, and `github.com` in `known_hosts`.
4. Copy the signing key the app is already installed with. jeep-obd2's release build is signed with the debug keystore, so copy `~/.android/debug.keystore` from the machine that built the installed APK to `~coordinating-brain/.android/debug.keystore`. Otherwise Android refuses to update the app and asks to uninstall it, which loses its data.
5. Create `/home/coordinating-brain/coordinating-brain/.env` from `.env.example`: `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_WEB_CLIENT_SECRET`, `ADMIN_EMAILS`, `ANTHROPIC_API_KEY` (Claude Code in `--bare` mode only accepts an API key), `PUBLIC_URL=https://cerebro.valdoh.com`, `TRUST_PROXY=1`.
6. Register apps with the CLI, as the `coordinating-brain` user (`app:jeep`). Users sign up themselves with Google; a user created before Google sign-in is linked with `user:link <name> <email>`.
7. Install the test sandbox: `sudo deploy/sandbox/install.sh`, then set `SANDBOX=systemd` in `.env`. Repeat it after updating Flutter in `/opt/flutter`.
8. Install `deploy/coordinating-brain.service` in `/etc/systemd/system/` and enable it.
9. In the Cloudflare Tunnel (Zero Trust dashboard), add the public hostname `cerebro.valdoh.com → http://localhost:8791`. The tunnel terminates TLS; no reverse proxy or open ports are needed.

Set a monthly spend limit on the Anthropic API key. `CLAUDE_MAX_BUDGET_USD` caps each Claude Code run (default 3).

## Sandbox

The AI writes code and the tests run it, so `testCmd` never runs as the brain. It runs in `cb-test@<n>.service` (`deploy/sandbox/`): user `cb-build`, no network, no `/home` (no `.env`, SSH or signing keys), read-only system and SDK, 3 GB of memory, 30 minutes. The brain copies the working copy (without `.git` or `build/`) to `/var/lib/cb-sandbox/<n>` and starts the unit through a polkit rule that allows only that. `prepareCmd` (`flutter pub get`, needs the network) and `buildCmd` run outside, as trusted app config, with the same SDK and pub cache (`/var/lib/cb-cache/pub-cache`).

Claude Code itself runs with file tools only and with `--settings` rules that deny reading or editing the brain's secrets: `~/.ssh`, `~/.android`, `~/.gradle`, `~/.claude`, `~/.config`, any `.env`, the database and the published APKs.

The worker does not start unless `SANDBOX` is `systemd` (or `none`, only for local development).

## Layout

- `src/server.ts` — API, portal and admin panel (Fastify).
- `src/auth.ts` — sessions, OAuth state, lockout, download tokens.
- `src/google.ts` — Google ID token verification and the OAuth code exchange.
- `src/store.ts`, `src/db.ts` — SQLite schema and queries.
- `src/worker/` — queue (`worker.ts`), pipeline (`pipeline.ts`), Claude Code runner (`runner.ts`), diff gate (`diffGate.ts`), first-pass moderation (`moderation.ts`), test sandbox (`sandbox.ts`).
- `src/cli.ts` — admin CLI.
- `test/` — tests with a fake Claude and a local git remote; no API calls.
