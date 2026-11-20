import path from 'node:path';

export interface ClaudeConfig {
  bin: string;
  model: string;
  /** --bare: no user hooks, plugins or CLAUDE.md; auth only via ANTHROPIC_API_KEY. */
  bare: boolean;
  maxBudgetUsd: number;
}

export interface Config {
  port: number;
  host: string;
  trustProxy: boolean;
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  apksDir: string;
  workDir: string;
  google: { webClientId: string; webClientSecret: string };
  adminEmails: string[];
  sandbox: 'systemd' | 'none' | '';
  sandboxDir: string;
  sessionDays: number;
  workerEnabled: boolean;
  workerPollMs: number;
  claude: ClaudeConfig;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

function emailList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function sandboxMode(value: string | undefined): Config['sandbox'] {
  return value === 'systemd' || value === 'none' ? value : '';
}

export function isAdminEmail(config: Config, email: string | null | undefined): boolean {
  return !!email && config.adminEmails.includes(email.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  return {
    port: Number(env.PORT ?? 8791),
    host: env.HOST ?? '127.0.0.1',
    trustProxy: env.TRUST_PROXY === '1',
    publicUrl: (env.PUBLIC_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, ''),
    dataDir,
    dbPath: path.join(dataDir, 'brain.db'),
    apksDir: path.join(dataDir, 'apks'),
    workDir: path.join(dataDir, 'work'),
    google: { webClientId: env.GOOGLE_WEB_CLIENT_ID ?? '', webClientSecret: env.GOOGLE_WEB_CLIENT_SECRET ?? '' },
    adminEmails: emailList(env.ADMIN_EMAILS),
    sandbox: sandboxMode(env.SANDBOX),
    sandboxDir: env.SANDBOX_DIR ?? '/var/lib/cb-sandbox',
    sessionDays: 30,
    workerEnabled: env.WORKER_ENABLED !== '0',
    workerPollMs: Number(env.WORKER_POLL_SECONDS ?? 15) * 1000,
    claude: {
      bin: env.CLAUDE_BIN ?? 'claude',
      model: env.CLAUDE_MODEL ?? 'claude-opus-5-5',
      bare: env.CLAUDE_BARE !== '0',
      maxBudgetUsd: Number(env.CLAUDE_MAX_BUDGET_USD ?? 3),
    },
    gitAuthorName: env.GIT_AUTHOR_NAME ?? 'coordinating-brain[bot]',
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? 'coordinating-brain@users.noreply.github.com',
  };
}
