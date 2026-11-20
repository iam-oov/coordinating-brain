import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createGoogleCodeExchange, createGoogleVerifier } from './google.ts';
import type { GoogleAuth } from './google.ts';
import { buildServer } from './server.ts';
import { requeueStuck } from './store.ts';
import { ClaudeCliRunner } from './worker/runner.ts';
import type { WorkerHandle } from './worker/worker.ts';
import { startWorker } from './worker/worker.ts';

const config = loadConfig();
const db = openDb(config.dbPath);

const requeued = requeueStuck(db);
if (requeued) console.log(`${requeued} request(s) left running by a previous crash were queued again.`);

const { webClientId, webClientSecret } = config.google;
let google: GoogleAuth | undefined;
if (webClientId && webClientSecret) {
  google = {
    clientId: webClientId,
    verifier: createGoogleVerifier(webClientId),
    exchange: createGoogleCodeExchange(webClientId, webClientSecret),
  };
} else {
  console.warn('GOOGLE_WEB_CLIENT_ID or GOOGLE_WEB_CLIENT_SECRET is missing: sign-in is disabled.');
}
if (config.adminEmails.length === 0) console.warn('ADMIN_EMAILS is empty: nobody can open /admin.');

let worker: WorkerHandle | null = null;
if (config.workerEnabled) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (config.claude.bare && !apiKey) console.warn('ANTHROPIC_API_KEY is missing: Claude Code runs will fail in --bare mode.');
  worker = startWorker({ db, config, runner: new ClaudeCliRunner(config.claude, apiKey) }, config.workerPollMs);
}

const server = buildServer({ config, db, google, wakeWorker: () => worker?.wake() });
await server.listen({ port: config.port, host: config.host });
console.log(`coordinating-brain listening on http://${config.host}:${config.port} (worker ${worker ? 'on' : 'off'})`);

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down after the current request…`);
  await server.close();
  await worker?.stop();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
