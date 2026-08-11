import pino from 'pino';

/**
 * Structured logging with hard redaction.
 *
 * Two rules this module enforces:
 *  1. Secrets never reach a transport. Redaction is by key path AND by a
 *     value-level scrub of anything that looks like key material.
 *  2. Untrusted external strings (token names, symbols, API error text) are
 *     never used as a format string and are always length-capped.
 */

const REDACT_PATHS = [
  'apiKey',
  'api_key',
  'secret',
  'secretKey',
  'privateKey',
  'keypair',
  'password',
  'token',
  'authorization',
  '*.apiKey',
  '*.secret',
  '*.privateKey',
  '*.authorization',
  'headers.authorization',
  'headers["x-api-key"]',
  'env.HELIUS_API_KEY',
  'env.JUPITER_API_KEY',
  'env.TELEGRAM_BOT_TOKEN',
  'env.GOPLUS_ACCESS_TOKEN',
];

/** Strip anything resembling a key from a URL or free string. */
export function scrubSecrets(input: string): string {
  return input
    .replace(/([?&](api-key|api_key|apiKey|access_token|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, '[REDACTED_KEYLIKE]');
}

const MAX_EXTERNAL_STRING = 120;

/**
 * Sanitize a string that came from outside our trust boundary.
 * Control characters are stripped so a token "name" cannot forge log lines,
 * and length is capped so it cannot flood storage.
 */
export function sanitizeExternal(value: unknown, max = MAX_EXTERNAL_STRING): string {
  if (typeof value !== 'string') return '';
  // Control chars, bidi overrides and zero-width marks are log-forging and
  // homoglyph-spoofing primitives when they arrive inside a token name.
  let stripped = '';
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    const hostile =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff;
    if (!hostile) stripped += ch;
  }
  const capped = stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
  return scrubSecrets(capped);
}

const level = process.env['LOG_LEVEL'] ?? 'info';

export const logger = pino({
  level,
  base: { pid: process.pid },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  hooks: {
    logMethod(args, method) {
      // Scrub any top-level message string before it is emitted.
      const copy = [...args];
      for (let i = 0; i < copy.length; i++) {
        if (typeof copy[i] === 'string') copy[i] = scrubSecrets(copy[i] as string);
      }
      return method.apply(this, copy as Parameters<typeof method>);
    },
  },
});

export type Logger = typeof logger;

export function child(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings) as Logger;
}

/** Human-readable console line, kept separate from the JSON stream. */
export function console_(line: string): void {
  process.stdout.write(`${scrubSecrets(line)}\n`);
}
