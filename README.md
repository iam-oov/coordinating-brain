# coordinating-brain

Backend that lets the users of an app ask for improvements. The owner approves each request, Claude Code implements it, the brain verifies and builds the app, pushes the change to the app's `main` branch, and publishes the new APK at a fixed URL.

Inspired by [midudev/tuweb.dev](https://github.com/midudev/tuweb.dev), taken from one website to several apps and users. First app: [jeep-obd2](https://github.com/iam-oov/jeep-obd2).

> The web UI (portal and admin panel) is in Spanish. Code, comments and docs are in English.

## How it works

```
 app "Buzón" / portal        admin (/admin)            worker                         GitHub + portal
┌──────────────────┐     ┌──────────────────┐     ┌───────────────────────────┐     ┌──────────────────┐
│ user enters their│     │ owner approves   │     │ Claude Code edits files   │     │ commit pushed to │
│ 4-digit code and │ ──▶ │ or rejects each  │ ──▶ │ diff gate · tests · build │ ──▶ │ main · APK at    │
│ sends a request  │     │ request          │     │ up to 3 attempts          │     │ /apks/<app>/...  │
└──────────────────┘     └──────────────────┘     └───────────────────────────┘     └──────────────────┘
```

1. **Request.** A user sends 16–280 characters to one of their apps, from the app's "Buzón" or from the portal. One open request per user and app.
2. **First filter.** A local heuristic refuses empty, oversized or fence-breaking text, and flags suspicious text (prompt injection, secrets, commands, build files) for the admin.
3. **Approval.** Only the owner, at `/admin`, approves or rejects. Nothing runs before that.
4. **Implementation.** The worker clones the app and runs Claude Code with file tools only (`Read`, `Edit`, `Write`, `Glob`, `Grep`): no shell, no network, no MCP, `--bare` (no user hooks or settings), and a budget cap. The request is passed **fenced as data**, never as instructions. The AI may refuse with `RECHAZO:`.
5. **Diff gate.** Only the app's allowed folders (`lib/`, `test/`, `assets/` for jeep-obd2); never `android/`, `ios/`, `pubspec.*`, CI, `CLAUDE.md`, secrets or key files; at most 800 changed lines; no binary files; no new line with keys, `String.fromEnvironment`, `Platform.environment` or `Process.run`.
6. **Verification.** The worker (not the AI) runs the app's test and build commands. On failure, the output goes back to the AI for another attempt (3 in total). If it never passes, nothing is pushed.
7. **Publish.** The worker bumps the build number, commits, and pushes to `main`. If `main` moved meanwhile, the local commit is rebased and verified again. Never a force push. Only then is the APK copied to the portal.
8. **Rollback.** From `/admin`, "Revertir este cambio" creates a new `git revert` commit and a new APK. History is never rewritten.

Every step is logged on the request, visible in `/admin`.

## Access

- **Users** log in with a 4-digit code. Codes are stored as scrypt hashes. After 5 failed attempts an IP is blocked for 15 minutes, even if the next code is right.
- Each code sees only the apps granted to it (`user_apps`), in the portal and the API.
- **Admin** logs in at `/admin` with `ADMIN_PASSWORD` (16+ characters; the panel is off otherwise).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/login` | code | Session token and the apps the code may use |
| GET | `/api/apps` | bearer | Apps and their latest APK |
| GET | `/api/apps/:slug/requests` | bearer | The user's requests for an app |
| POST | `/api/apps/:slug/requests` | bearer | New request `{ "text": "…" }` |
| POST | `/api/apps/:slug/download-link` | bearer | One-time URL (10 min) to download the latest APK in a browser |
| GET | `/apks` | cookie | Portal: code form, then apps, latest APK, requests |
| GET | `/apks/:slug/latest.apk` | cookie or `?dl=` | Always the latest APK of the app |
| GET | `/admin` | admin cookie | Approve/reject, queue, APKs, history, revert |
| GET | `/health` | — | Liveness |

## Run locally

Requires Node 24+ (uses the built-in `node:sqlite` and TypeScript type stripping).

```
npm install
npm test
cp .env.example .env            # set ADMIN_PASSWORD; WORKER_ENABLED=0 to skip Claude runs
npm run cli -- app:jeep         # register jeep-obd2
npm run cli -- user:add osvaldo jeep-obd2   # prints the user's 4-digit code once
node --env-file=.env src/main.ts
```

Other CLI commands: `user:grant`, `user:revoke`, `user:reset-code`, `user:enable`, `user:disable`, `user:list`, `app:list`.

## Deploy (Linux server)

1. Create an unprivileged user `brain` and clone this repo to `/opt/coordinating-brain`; `npm ci --omit=dev`.
2. Install, for the `brain` user: Node 24+, git, JDK 17, the Flutter SDK, the Android SDK (`platforms`, `build-tools`, accepted licenses) and Claude Code.
3. Give the worker push access to each app repo: a GitHub **deploy key with write access** in `~brain/.ssh`, and `github.com` in `known_hosts`.
4. Copy the signing key the app is already installed with. jeep-obd2's release build is signed with the debug keystore, so copy `~/.android/debug.keystore` from the machine that built the installed APK to `~brain/.android/debug.keystore`. Otherwise Android refuses to update the app and asks to uninstall it, which loses its data.
5. Create `/opt/coordinating-brain/.env` from `.env.example`: `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY` (Claude Code in `--bare` mode only accepts an API key), `PUBLIC_URL=https://cerebro.valdoh.com`, `TRUST_PROXY=1`.
6. Register apps and users with the CLI, as the `brain` user.
7. Install `deploy/coordinating-brain.service` in `/etc/systemd/system/` and enable it.
8. Point `cerebro.valdoh.com` at the server and use `deploy/Caddyfile` with Caddy for TLS.

Set a monthly spend limit on the Anthropic API key. `CLAUDE_MAX_BUDGET_USD` caps each Claude Code run (default 3).

## Layout

- `src/server.ts` — API, portal and admin panel (Fastify).
- `src/auth.ts` — codes, sessions, lockout, download tokens.
- `src/store.ts`, `src/db.ts` — SQLite schema and queries.
- `src/worker/` — queue (`worker.ts`), pipeline (`pipeline.ts`), Claude Code runner (`runner.ts`), diff gate (`diffGate.ts`), first-pass moderation (`moderation.ts`).
- `src/cli.ts` — admin CLI.
- `test/` — tests with a fake Claude and a local git remote; no API calls.
