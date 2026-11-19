/**
 * AI settings storage. One row (id = 1). Off by default. The API key is encrypted with the shared AES-256-GCM
 * helper (auth/secrets.ts) and is never returned: callers only see `hasKey`.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@veqsio/db';
import { db } from '../db';
import { decryptSecret, encryptSecret, secretsConfigured } from '../auth/secrets';
import { createProvider, PROVIDER_KINDS, validateBaseUrl, type AiProvider, type ProviderKind } from './provider';
import { DEFAULT_MAX_INPUT_CHARS, MAX_MAX_INPUT_CHARS, MIN_MAX_INPUT_CHARS } from './prompts';

export const FEATURE_KEYS = ['classify', 'summarize', 'similar', 'release_notes', 'review', 'rule_draft'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;
export const DEFAULT_FEATURES: Features = { classify: true, summarize: true, similar: true, release_notes: true, review: true, rule_draft: true };

export interface AiSettings {
  enabled: boolean;
  provider: ProviderKind;
  baseUrl: string | null;
  model: string | null;
  apiKeyEncrypted: string | null;
  maxInputChars: number;
  dailyRequestLimitPerUser: number;
  features: Features;
  updatedAt: Date | null;
}

export const DEFAULT_SETTINGS: AiSettings = {
  enabled: false, provider: 'openai', baseUrl: null, model: null, apiKeyEncrypted: null,
  maxInputChars: DEFAULT_MAX_INPUT_CHARS, dailyRequestLimitPerUser: 50, features: DEFAULT_FEATURES, updatedAt: null,
};

export function normalizeFeatures(raw: unknown): Features {
  const out = { ...DEFAULT_FEATURES };
  if (raw && typeof raw === 'object') for (const k of FEATURE_KEYS) if (typeof (raw as any)[k] === 'boolean') out[k] = (raw as any)[k];
  return out;
}

export async function loadSettings(): Promise<AiSettings> {
  const [row] = await db.select().from(schema.aiSettings).where(eq(schema.aiSettings.id, 1)).limit(1);
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    enabled: row.enabled,
    provider: (PROVIDER_KINDS as readonly string[]).includes(row.provider) ? (row.provider as ProviderKind) : 'openai',
    baseUrl: row.baseUrl, model: row.model, apiKeyEncrypted: row.apiKeyEncrypted,
    maxInputChars: row.maxInputChars, dailyRequestLimitPerUser: row.dailyRequestLimitPerUser,
    features: normalizeFeatures(row.features), updatedAt: row.updatedAt,
  };
}

/** The shape returned by admin endpoints. Never contains the key. */
export function toAdminView(s: AiSettings) {
  return {
    enabled: s.enabled, provider: s.provider, baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKeyEncrypted,
    maxInputChars: s.maxInputChars, dailyRequestLimitPerUser: s.dailyRequestLimitPerUser, features: s.features,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  };
}

/** LLM features are usable only when explicitly enabled AND a model is configured. */
export const isConfigured = (s: AiSettings) => s.enabled && !!s.model && (s.provider === 'anthropic' ? !!s.apiKeyEncrypted : true);

/** What any authenticated user may learn: which features to show. `similar` works without an LLM. */
export function publicFeatures(s: AiSettings): { enabled: boolean; features: Features } {
  const on = isConfigured(s);
  return {
    enabled: on,
    features: {
      classify: on && s.features.classify,
      summarize: on && s.features.summarize,
      release_notes: on && s.features.release_notes,
      review: on && s.features.review,
      rule_draft: on && s.features.rule_draft,
      similar: s.features.similar,
    },
  };
}

export const settingsInput = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['openai', 'anthropic']).optional(),
  baseUrl: z.string().max(500).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  /** string = set/replace, null or '' = remove, omitted = keep */
  apiKey: z.string().max(2000).nullable().optional(),
  maxInputChars: z.number().int().min(MIN_MAX_INPUT_CHARS).max(MAX_MAX_INPUT_CHARS).optional(),
  dailyRequestLimitPerUser: z.number().int().min(1).max(10_000).optional(),
  features: z.object({
    classify: z.boolean().optional(), summarize: z.boolean().optional(),
    similar: z.boolean().optional(), release_notes: z.boolean().optional(), review: z.boolean().optional(), rule_draft: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type SettingsInput = z.infer<typeof settingsInput>;

export async function saveSettings(input: SettingsInput, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; settings: AiSettings } | { ok: false; error: string }> {
  const cur = await loadSettings();
  const next: AiSettings = { ...cur, features: { ...cur.features } };
  if (input.enabled !== undefined) next.enabled = input.enabled;
  if (input.provider !== undefined) next.provider = input.provider;
  if (input.baseUrl !== undefined) {
    if (input.baseUrl === null || input.baseUrl.trim() === '') next.baseUrl = null;
    else {
      const check = validateBaseUrl(input.baseUrl, env);
      if (!check.ok) return { ok: false, error: check.error };
      next.baseUrl = check.url;
    }
  }
  if (input.model !== undefined) next.model = input.model;
  if (input.apiKey !== undefined) {
    const key = input.apiKey === null ? '' : input.apiKey.trim();
    if (key === '') next.apiKeyEncrypted = null;
    else {
      if (!secretsConfigured(env)) return { ok: false, error: 'SECRETS_ENCRYPTION_KEY is required to store the API key' };
      next.apiKeyEncrypted = encryptSecret(key);
    }
  }
  if (input.maxInputChars !== undefined) next.maxInputChars = input.maxInputChars;
  if (input.dailyRequestLimitPerUser !== undefined) next.dailyRequestLimitPerUser = input.dailyRequestLimitPerUser;
  if (input.features) for (const k of FEATURE_KEYS) if (input.features[k] !== undefined) next.features[k] = input.features[k]!;
  if (next.enabled && !next.model) return { ok: false, error: 'A model is required to enable AI' };
  if (next.enabled && next.provider === 'anthropic' && !next.apiKeyEncrypted) return { ok: false, error: 'An API key is required for the Anthropic provider' };

  const values = {
    id: 1, enabled: next.enabled, provider: next.provider, baseUrl: next.baseUrl, model: next.model,
    apiKeyEncrypted: next.apiKeyEncrypted, maxInputChars: next.maxInputChars,
    dailyRequestLimitPerUser: next.dailyRequestLimitPerUser, features: next.features, updatedAt: new Date(),
  };
  await db.insert(schema.aiSettings).values(values).onConflictDoUpdate({ target: schema.aiSettings.id, set: values });
  return { ok: true, settings: { ...next, updatedAt: values.updatedAt } };
}

/* Provider resolution. Tests inject a fake; production builds one from the stored settings. */
let override: AiProvider | null = null;
export function setProviderOverride(p: AiProvider | null): void { override = p; }

export function resolveProvider(s: AiSettings): AiProvider {
  if (override) return override;
  let apiKey: string | null = null;
  if (s.apiKeyEncrypted) apiKey = decryptSecret(s.apiKeyEncrypted);
  return createProvider({ provider: s.provider, baseUrl: s.baseUrl, model: s.model ?? '', apiKey });
}
