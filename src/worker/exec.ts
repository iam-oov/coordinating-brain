import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  /** Combined stdout + stderr, capped to the last MAX_OUTPUT characters. */
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 200_000;

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.slice(-MAX_OUTPUT), timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Runs a trusted command line from the app config (never text from a user or the AI). */
export function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return run('/bin/sh', ['-c', command], opts);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, timeoutMs: 10 * 60 * 1000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.output.trim().slice(-2000)}`);
  return r.output.trim();
}

/** The last [max] characters of a long output, for logs and AI feedback. */
export function tail(s: string, max = 6000): string {
  return s.length <= max ? s : `…${s.slice(-max)}`;
}
