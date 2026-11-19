/**
 * Plugin manifest: the contract between Veqsio and an external plugin service.
 * Pure validation only (no I/O); every object is `.strict()` so unknown fields are rejected.
 */
import { z } from 'zod';
import { VALID_SCOPES } from '../middleware/token-scopes';
import { PLUGIN_EVENT_NAMES } from './event-names';

/** Scopes a plugin may request. Wildcards and `admin` are never available to plugins. */
export const PLUGIN_SCOPES = VALID_SCOPES.filter((s) => s.includes(':') && !s.endsWith('*')) as readonly string[];
export const PLUGIN_EVENTS = PLUGIN_EVENT_NAMES as readonly string[];
export const UI_LOCATIONS = ['issue.sidebar', 'issue.tab', 'project.page', 'admin.page'] as const;
export const CONFIG_TYPES = ['text', 'secret', 'select', 'boolean', 'number'] as const;
export type UiLocation = (typeof UI_LOCATIONS)[number];

export const MAX_MANIFEST_BYTES = 64 * 1024;

const KEY_RE = /^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){2,7}$/; // reverse DNS: at least three labels
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const CONFIG_KEY_RE = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;

export function allowInsecurePluginHosts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLUGINS_ALLOW_PRIVATE_HOSTS === 'true';
}

/** A path on the plugin host: absolute, no query/fragment/backslash/dot segments, not protocol-relative. */
const pathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => p.startsWith('/') && !p.startsWith('//'), 'must start with a single /')
  .refine((p) => !/[?#\\\s\u0000-\u001f]/.test(p), 'must not contain query, fragment, backslash, whitespace or control characters')
  .refine((p) => !p.split('/').some((seg) => seg === '.' || seg === '..' || /^%2e(%2e)?$/i.test(seg)), 'must not contain dot segments');

const httpsUrl = (insecureOk: boolean) =>
  z
    .string()
    .max(2048)
    .superRefine((val, ctx) => {
      let u: URL;
      try {
        u = new URL(val);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be a valid URL' });
        return;
      }
      if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) {
        ctx.addIssue({ code: 'custom', message: 'must use https' });
      }
      if (u.username || u.password) ctx.addIssue({ code: 'custom', message: 'must not contain credentials' });
      if (u.search || u.hash) ctx.addIssue({ code: 'custom', message: 'must not contain a query string or fragment' });
    });

const configField = z
  .object({
    key: z.string().regex(CONFIG_KEY_RE, 'invalid config key'),
    label: z.string().trim().min(1).max(100),
    type: z.enum(CONFIG_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type === 'select' && !f.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'select fields need options' });
    if (f.type !== 'select' && f.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'only select fields have options' });
  });

const uiPanel = z
  .object({
    location: z.enum(UI_LOCATIONS),
    title: z.string().trim().min(1).max(60),
    path: pathSchema,
  })
  .strict();

function unique<T>(arr: T[], by: (t: T) => string): boolean {
  return new Set(arr.map(by)).size === arr.length;
}

export function buildManifestSchema(opts: { allowInsecure?: boolean } = {}) {
  const insecure = opts.allowInsecure ?? allowInsecurePluginHosts();
  return z
    .object({
      schemaVersion: z.literal(1),
      key: z.string().max(128).regex(KEY_RE, 'key must be reverse-DNS, e.g. com.acme.foo (lower case, at least three labels)'),
      name: z.string().trim().min(1).max(100),
      version: z.string().max(64).regex(SEMVER_RE, 'version must be semver'),
      description: z.string().trim().max(1000).default(''),
      vendor: z.object({ name: z.string().trim().min(1).max(100), url: httpsUrl(false) }).strict(),
      baseUrl: httpsUrl(insecure),
      scopes: z.array(z.enum(PLUGIN_SCOPES as [string, ...string[]])).max(PLUGIN_SCOPES.length).default([]),
      events: z.array(z.enum(PLUGIN_EVENTS as [string, ...string[]])).max(PLUGIN_EVENTS.length).default([]),
      webhookPath: pathSchema.optional(),
      config: z.array(configField).max(50).default([]),
      uiPanels: z.array(uiPanel).max(20).default([]),
    })
    .strict()
    .superRefine((m, ctx) => {
      if (!unique(m.scopes, (s) => s)) ctx.addIssue({ code: 'custom', path: ['scopes'], message: 'duplicate scopes' });
      if (!unique(m.events, (s) => s)) ctx.addIssue({ code: 'custom', path: ['events'], message: 'duplicate events' });
      if (!unique(m.config, (f) => f.key)) ctx.addIssue({ code: 'custom', path: ['config'], message: 'duplicate config keys' });
      if (m.events.length > 0 && !m.webhookPath) ctx.addIssue({ code: 'custom', path: ['webhookPath'], message: 'webhookPath is required when events are subscribed' });
      if (m.uiPanels.length > 0 && !unique(m.uiPanels, (p) => `${p.location}|${p.path}`)) {
        ctx.addIssue({ code: 'custom', path: ['uiPanels'], message: 'duplicate panels' });
      }
    });
}

export type PluginManifest = z.infer<ReturnType<typeof buildManifestSchema>>;

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] };

export function validateManifest(input: unknown, opts: { allowInsecure?: boolean } = {}): ManifestResult {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(input) ?? '');
  } catch {
    return { ok: false, errors: ['manifest is not serialisable JSON'] };
  }
  if (size > MAX_MANIFEST_BYTES) return { ok: false, errors: [`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`] };
  const parsed = buildManifestSchema(opts).safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`),
  };
}

export function parseManifestText(text: string, opts: { allowInsecure?: boolean } = {}): ManifestResult {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) return { ok: false, errors: [`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['manifest is not valid JSON'] };
  }
  return validateManifest(json, opts);
}

export interface ManifestDiff {
  versionFrom: string;
  versionTo: string;
  scopes: { added: string[]; removed: string[] };
  events: { added: string[]; removed: string[] };
  baseUrlChanged: boolean;
  /** True when the update widens what the plugin can do and therefore needs explicit admin approval. */
  needsApproval: boolean;
}

export function diffManifests(prev: PluginManifest, next: PluginManifest): ManifestDiff {
  const delta = (a: string[], b: string[]) => ({
    added: b.filter((x) => !a.includes(x)),
    removed: a.filter((x) => !b.includes(x)),
  });
  const scopes = delta(prev.scopes, next.scopes);
  const events = delta(prev.events, next.events);
  const baseUrlChanged = prev.baseUrl !== next.baseUrl;
  return {
    versionFrom: prev.version,
    versionTo: next.version,
    scopes,
    events,
    baseUrlChanged,
    needsApproval: scopes.added.length > 0 || baseUrlChanged,
  };
}

/** Scopes required to receive an event, so a plugin never gets a signal about data it may not read. */
export function scopeForEvent(event: string): string {
  return event.startsWith('sprint.') ? 'read:projects' : 'read:issues';
}

/** Does a granted scope list satisfy a needed `read:x` scope (`write:x` implies `read:x`)? */
export function scopeSatisfies(granted: string[], needed: string): boolean {
  if (granted.includes(needed)) return true;
  const [verb, family] = needed.split(':');
  return verb === 'read' && granted.includes(`write:${family}`);
}
