import { git } from './exec.ts';

/**
 * Checks the AI's uncommitted changes before trusting them (midu's tuweb.dev
 * did the same): only allowed paths, a cap on changed lines, no binary files,
 * and no new line that touches keys, secrets or process/env access.
 */

/** Never writable by the AI, whatever the app config says. */
export const ALWAYS_FORBIDDEN: RegExp[] = [
  /^android\//,
  /^ios\//,
  /^\.github\//,
  /^\.claude\//,
  /^pubspec\.(yaml|lock)$/,
  /(^|\/)(CLAUDE|AGENTS)\.md$/,
  /(^|\/)secrets/i,
  /(^|\/)\.env/,
  /\.(jks|keystore|p12|pem|key)$/i,
];

/** Patterns no added line may contain. */
export const FORBIDDEN_LINES: { label: string; pattern: RegExp }[] = [
  { label: 'una llave de Anthropic', pattern: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { label: 'una llave de Google', pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  { label: 'una llave privada', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY/ },
  { label: 'el archivo de secretos', pattern: /secrets\.json/ },
  { label: 'variables de compilación', pattern: /String\.fromEnvironment|dart-define/ },
  { label: 'variables de entorno', pattern: /Platform\.environment/ },
  { label: 'ejecución de procesos', pattern: /\bProcess\.(run|start)/ },
  { label: 'datos codificados largos', pattern: /[A-Za-z0-9+/]{120,}={0,2}/ },
  { label: 'datos codificados largos', pattern: /\b[0-9a-fA-F]{64,}\b/ },
];

export const DEFAULT_MAX_LINES = 800;

export interface GateResult {
  ok: boolean;
  problems: string[];
  files: string[];
  added: number;
  removed: number;
}

export function isProtected(file: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/** Stages everything in [cwd] and checks the staged diff against HEAD. */
export async function checkDiff(
  cwd: string,
  allowedPaths: string[],
  protectedPaths: string[] = [],
  maxLines = DEFAULT_MAX_LINES,
): Promise<GateResult> {
  await git(cwd, 'add', '-A');
  const numstat = await git(cwd, 'diff', '--cached', '--numstat', '--no-renames');
  const problems: string[] = [];
  const files: string[] = [];
  let added = 0;
  let removed = 0;

  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, r, file] = line.split('\t');
    files.push(file);
    if (a === '-' || r === '-') {
      problems.push(`${file}: archivo binario`);
      continue;
    }
    added += Number(a);
    removed += Number(r);
    if (ALWAYS_FORBIDDEN.some((p) => p.test(file))) problems.push(`${file}: archivo protegido`);
    else if (isProtected(file, protectedPaths)) problems.push(`${file}: núcleo protegido, no se puede cambiar`);
    else if (!allowedPaths.some((p) => file.startsWith(p))) {
      problems.push(`${file}: fuera de las carpetas permitidas (${allowedPaths.join(', ')})`);
    }
  }

  if (added + removed > maxLines) problems.push(`demasiadas líneas cambiadas: ${added + removed} (máximo ${maxLines})`);

  const patch = await git(cwd, 'diff', '--cached', '-U0', '--no-renames', '--no-color');
  let current = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) current = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      for (const rule of FORBIDDEN_LINES) {
        if (rule.pattern.test(line)) problems.push(`${current}: una línea nueva toca ${rule.label}`);
      }
    }
  }

  return { ok: problems.length === 0 && files.length > 0, problems: [...new Set(problems)], files, added, removed };
}
