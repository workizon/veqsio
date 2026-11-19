/**
 * LLM provider abstraction. Two wire formats cover practically every backend:
 *  - `openai`: any OpenAI-compatible /chat/completions endpoint (OpenAI, Azure gateways, Ollama, vLLM, LM Studio, llama.cpp)
 *  - `anthropic`: the Anthropic Messages API
 *
 * Security rules enforced here: https only (private hosts need AI_ALLOW_PRIVATE_HOSTS=true), no credentials in the URL,
 * no redirects, 30 s timeout, one retry on 429/5xx, and prompts, keys and response bodies are never logged or put into errors.
 */
import { isIP } from 'net';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface CompleteInput { system: string; messages: ChatMessage[]; maxTokens: number; signal?: AbortSignal }
export interface CompleteResult { text: string; tokensIn?: number; tokensOut?: number }
export interface AiProvider { complete(input: CompleteInput): Promise<CompleteResult> }

export type ProviderKind = 'openai' | 'anthropic';
export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'anthropic'];

/** A provider failure whose message is safe to show (never contains prompt, key or response body). */
export class AiProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2_000_000;

/* ------------------------------ URL validation ------------------------------ */

function isPrivateIPv4(h: string): boolean {
  const p = h.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const ver = isIP(h);
  if (ver === 4) return isPrivateIPv4(h);
  if (ver === 6) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('::ffff:')) {
      const v4 = h.slice(7);
      return isIP(v4) === 4 ? isPrivateIPv4(v4) : true; // hex-form mapped addresses: be conservative
    }
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  return !h.includes('.'); // single-label names (docker service names such as `ollama`)
}

function isLinkLocal(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h.startsWith('169.254.') || /^fe[89ab]/.test(h) || h === 'metadata.google.internal';
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Validates and normalises an admin-supplied base URL (trailing slashes removed). */
export function validateBaseUrl(raw: string, env: NodeJS.ProcessEnv = process.env): UrlCheck {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: 'Base URL is not a valid URL' }; }
  if (u.username || u.password) return { ok: false, error: 'Base URL must not contain credentials' };
  if (u.search || u.hash) return { ok: false, error: 'Base URL must not contain a query string or fragment' };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Base URL must use https' };
  if (isLinkLocal(u.hostname)) return { ok: false, error: 'Base URL host is not allowed' };
  const allowPrivate = env.AI_ALLOW_PRIVATE_HOSTS === 'true';
  const priv = isPrivateHost(u.hostname);
  if (priv && !allowPrivate) return { ok: false, error: 'Private and localhost hosts require AI_ALLOW_PRIVATE_HOSTS=true on the server' };
  if (u.protocol === 'http:' && !priv) return { ok: false, error: 'Base URL must use https' };
  return { ok: true, url: u.toString().replace(/\/+$/, '') };
}

/* --------------------------------- Providers --------------------------------- */

export interface ProviderConfig { provider: ProviderKind; baseUrl: string | null; model: string; apiKey: string | null }
export interface ProviderOptions { fetchImpl?: typeof fetch; timeoutMs?: number; retryDelayMs?: number; env?: NodeJS.ProcessEnv }

async function postJson(url: string, headers: Record<string, string>, body: unknown, opts: ProviderOptions, outer?: AbortSignal): Promise<any> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (outer) signals.push(outer);
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
    } catch (err: any) {
      if (outer?.aborted) throw new AiProviderError('AI request cancelled');
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new AiProviderError('AI provider timed out');
      throw new AiProviderError('AI provider is unreachable');
    }
    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (attempt === 0) { await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 500)); continue; }
      throw new AiProviderError(`AI provider returned status ${lastStatus}`, lastStatus);
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new AiProviderError(`AI provider returned status ${res.status}`, res.status);
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new AiProviderError('AI provider response too large');
    try { return JSON.parse(text); } catch { throw new AiProviderError('AI provider returned an invalid response'); }
  }
  throw new AiProviderError(`AI provider returned status ${lastStatus}`, lastStatus);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

export function createOpenAiProvider(cfg: ProviderConfig, opts: ProviderOptions = {}): AiProvider {
  const base = cfg.baseUrl ?? 'https://api.openai.com/v1';
  return {
    async complete({ system, messages, maxTokens, signal }) {
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const json = await postJson(`${base}/chat/completions`, headers, {
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        stream: false,
        messages: [{ role: 'system', content: system }, ...messages],
      }, opts, signal);
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new AiProviderError('AI provider returned no text');
      return { text, tokensIn: num(json?.usage?.prompt_tokens), tokensOut: num(json?.usage?.completion_tokens) };
    },
  };
}

export function createAnthropicProvider(cfg: ProviderConfig, opts: ProviderOptions = {}): AiProvider {
  const base = cfg.baseUrl ?? 'https://api.anthropic.com';
  return {
    async complete({ system, messages, maxTokens, signal }) {
      const json = await postJson(`${base}/v1/messages`, {
        'x-api-key': cfg.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      }, { model: cfg.model, max_tokens: maxTokens, temperature: 0.2, system, messages }, opts, signal);
      const blocks: unknown = json?.content;
      const text = Array.isArray(blocks)
        ? blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('')
        : '';
      if (!text) throw new AiProviderError('AI provider returned no text');
      return { text, tokensIn: num(json?.usage?.input_tokens), tokensOut: num(json?.usage?.output_tokens) };
    },
  };
}

export function createProvider(cfg: ProviderConfig, opts: ProviderOptions = {}): AiProvider {
  if (cfg.baseUrl) {
    const check = validateBaseUrl(cfg.baseUrl, opts.env);
    if (!check.ok) throw new AiProviderError(check.error);
    cfg = { ...cfg, baseUrl: check.url };
  }
  return cfg.provider === 'anthropic' ? createAnthropicProvider(cfg, opts) : createOpenAiProvider(cfg, opts);
}
