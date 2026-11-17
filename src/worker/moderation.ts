/**
 * Local first-pass moderation of a request's text (midu's tuweb.dev did the
 * same before asking a model). Two outcomes:
 *
 * - `reject`: never reaches the admin (empty, too short/long, or tries to
 *   break the fence that marks the request as data).
 * - `flags`: suspicious but possibly legitimate; shown to the admin next to
 *   the approve button. The admin decides.
 */

export const MIN_LENGTH = 16;
export const MAX_LENGTH = 280;

export interface Moderation {
  reject?: string;
  flags: string[];
}

const FENCE = /<\/?\s*(solicitud|request|system|instructions?)\b|```/i;

const FLAG_RULES: { label: string; pattern: RegExp }[] = [
  {
    label: 'intenta cambiar las instrucciones de la IA',
    pattern:
      /\b(ignora|olvida|ignore|disregard|forget)\b.{0,40}\b(instruccion|instruction|regla|rule|prompt|anterior|previous)|system prompt|eres ahora|you are now|act as|actúa como/i,
  },
  {
    label: 'menciona llaves, contraseñas o secretos',
    pattern: /\b(api[\s_-]?key|llave|token|contraseñ|password|secret|credencial|credential)/i,
  },
  {
    label: 'pide ejecutar comandos o borrar cosas',
    pattern: /\b(rm\s+-|curl\b|wget\b|bash\b|sudo\b|chmod\b|eval\b|borra(r)? todo|delete all|drop table)/i,
  },
  {
    label: 'pide tocar compilación, firma o despliegue',
    pattern: /\b(gradle|keystore|firma|signing|github actions|workflow|pubspec|dependencia|dependency|paquete nuevo)/i,
  },
  { label: 'incluye un enlace', pattern: /https?:\/\//i },
];

export function moderate(text: string): Moderation {
  const t = text.trim();
  if (t.length < MIN_LENGTH) return { reject: `Muy corta: mínimo ${MIN_LENGTH} caracteres.`, flags: [] };
  if (t.length > MAX_LENGTH) return { reject: `Muy larga: máximo ${MAX_LENGTH} caracteres.`, flags: [] };
  if (FENCE.test(t)) return { reject: 'Contiene etiquetas o bloques de código que no se permiten.', flags: [] };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) {
    return { reject: 'Contiene caracteres de control.', flags: [] };
  }
  return { flags: FLAG_RULES.filter((r) => r.pattern.test(t)).map((r) => r.label) };
}
