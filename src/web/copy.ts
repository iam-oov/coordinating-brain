import { MAX_LENGTH, MIN_LENGTH } from '../worker/moderation.ts';

const FLAGS: Record<string, string> = {
  'intenta cambiar las instrucciones de la IA': 'tries to change the AI instructions',
  'menciona llaves, contraseñas o secretos': 'mentions keys, passwords or secrets',
  'pide ejecutar comandos o borrar cosas': 'asks to run commands or delete things',
  'pide tocar compilación, firma o despliegue': 'asks to touch the build, signing or deployment',
  'incluye un enlace': 'includes a link',
};

const ERRORS: [RegExp, string][] = [
  [/^Muy corta/, `Too short: at least ${MIN_LENGTH} characters.`],
  [/^Muy larga/, `Too long: at most ${MAX_LENGTH} characters.`],
  [/^Contiene etiquetas/, 'Tags or code blocks are not allowed.'],
  [/^Contiene caracteres de control/, 'Control characters are not allowed.'],
  [/^Ya tienes una solicitud en curso/, 'You already have an idea in progress for this app. Wait until it finishes.'],
];

export function flagLabel(flag: string): string {
  return FLAGS[flag] ?? flag;
}

export function errorMessage(message: string): string {
  return ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? message;
}
