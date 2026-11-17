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
  /** Empty when the admin panel is disabled. */
  adminPassword: string;
  sessionDays: number;
  workerEnabled: boolean;
  workerPollMs: number;
  claude: ClaudeConfig;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

const MIN_ADMIN_PASSWORD = 16;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  const admin = env.ADMIN_PASSWORD ?? '';
  return {
    port: Number(env.PORT ?? 8791),
    host: env.HOST ?? '127.0.0.1',
    trustProxy: env.TRUST_PROXY === '1',
    publicUrl: (env.PUBLIC_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, ''),
    dataDir,
    dbPath: path.join(dataDir, 'brain.db'),
    apksDir: path.join(dataDir, 'apks'),
    workDir: path.join(dataDir, 'work'),
    adminPassword: admin.length >= MIN_ADMIN_PASSWORD ? admin : '',
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
