/** Redaction and capping of payloads kept in the delivery log: credentials never end up in the database. */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api[-_]?key|cookie|signature|credential|private|session|bearer|auth/i;
const SENSITIVE_VALUE = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;

export const MAX_STORED_PAYLOAD = 8192;
const MAX_DEPTH = 8;
const MAX_ITEMS = 50;

function walk(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.replace(SENSITIVE_VALUE, '[redacted]').slice(0, 2000);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (++n > MAX_ITEMS) { out['...'] = 'truncated'; break; }
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : walk(val, depth + 1);
  }
  return out;
}

/** Redacts credentials and caps the size; non-JSON text only gets the value patterns removed. */
export function redactPayload(raw: string, max = MAX_STORED_PAYLOAD): string {
  let text: string;
  try { text = JSON.stringify(walk(JSON.parse(raw), 0), null, 1); }
  catch { text = raw.replace(SENSITIVE_VALUE, '[redacted]'); }
  return text.length > max ? text.slice(0, max) + '\n... [truncated]' : text;
}
