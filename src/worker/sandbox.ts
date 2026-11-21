import fs from 'node:fs';
import path from 'node:path';

import type { ExecResult } from './exec.ts';
import { run, runShell } from './exec.ts';

/** Runs a trusted command line against code the AI wrote. */
export interface TestSandbox {
  run(cwd: string, command: string, timeoutMs: number): Promise<ExecResult>;
}

/** No isolation: for tests and local development only (SANDBOX=none). */
export class DirectSandbox implements TestSandbox {
  run(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> {
    return runShell(command, { cwd, timeoutMs });
  }
}

const SKIPPED = new Set(['.git', 'build']);

/**
 * Copies the working copy to <root>/<id> and runs the command there through the
 * cb-test@<id> systemd unit: another user, no network, no /home, read-only system.
 */
export class SystemdSandbox implements TestSandbox {
  readonly root: string;
  readonly systemctl: string;
  private last = 0;

  constructor(root: string, systemctl = 'systemctl') {
    this.root = root;
    this.systemctl = systemctl;
  }

  private nextId(): string {
    this.last = Math.max(Date.now(), this.last + 1);
    return String(this.last);
  }

  async run(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const id = this.nextId();
    const box = path.join(this.root, id);
    try {
      fs.mkdirSync(box);
      fs.cpSync(cwd, box, { recursive: true, filter: (src) => src === cwd || !SKIPPED.has(path.relative(cwd, src)) });
      fs.writeFileSync(path.join(box, '.cmd'), `${command}\n`);
      await run('chmod', ['-R', 'g+rwX', box], { cwd: box });
      const r = await run(this.systemctl, ['start', '--wait', `cb-test@${id}.service`], { cwd: box, timeoutMs });
      const outFile = path.join(box, '.out');
      const output = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      return { code: r.code, output: r.code === 0 ? output : `${output}\n${r.output}`.trim(), timedOut: r.timedOut };
    } finally {
      removeBestEffort(box);
    }
  }
}

/** Files the sandbox user leaves behind may not be removable here; systemd-tmpfiles ages them out. */
function removeBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    return;
  }
}
