import type { SettingsSchema, SettingProperty } from './manifest'

export type SettingValue = string | number | boolean
export type SettingsValues = Record<string, SettingValue>

/** Placeholder returned instead of a stored secret; sending it back keeps the stored value. */
export const SECRET_PLACEHOLDER = '********'

export interface SettingsValidation {
  ok: boolean
  values: SettingsValues
  errors: Record<string, string>
}

/** The default value of every property that declares one. */
export function settingsDefaults(schema: SettingsSchema | undefined): SettingsValues {
  const out: SettingsValues = {}
  for (const [k, p] of Object.entries(schema?.properties ?? {})) if (p.default !== undefined) out[k] = p.default
  return out
}

function validateOne(p: SettingProperty, raw: unknown): { value?: SettingValue; error?: string } {
  switch (p.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : { error: 'Must be true or false' }
    case 'number':
    case 'integer': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
      if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'Must be a number' }
      if (p.type === 'integer' && !Number.isInteger(n)) return { error: 'Must be a whole number' }
      if (p.minimum !== undefined && n < p.minimum) return { error: `Must be at least ${p.minimum}` }
      if (p.maximum !== undefined && n > p.maximum) return { error: `Must be at most ${p.maximum}` }
      return { value: n }
    }
    case 'string': {
      if (typeof raw !== 'string') return { error: 'Must be text' }
      if (p.enum && !p.enum.includes(raw)) return { error: `Must be one of: ${p.enum.join(', ')}` }
      if (p.minLength !== undefined && raw.length < p.minLength) return { error: `Must be at least ${p.minLength} characters` }
      if (p.maxLength !== undefined && raw.length > p.maxLength) return { error: `Must be at most ${p.maxLength} characters` }
      if (p.pattern) {
        let re: RegExp | null = null
        try { re = new RegExp(p.pattern) } catch { /* a bad pattern in a manifest must not crash validation */ }
        if (re && !re.test(raw)) return { error: 'Does not match the required format' }
      }
      if (p.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { error: 'Must be an email address' }
      if (p.format === 'url') {
        try { const u = new URL(raw); if (!/^https?:$/.test(u.protocol)) throw new Error() } catch { return { error: 'Must be an http(s) URL' } }
      }
      return { value: raw }
    }
  }
}

/**
 * Validates submitted settings against the manifest schema. Unknown keys are rejected, defaults fill
 * missing optional values, `required` is enforced after defaults, and a secret submitted as the
 * placeholder keeps its `existing` value.
 */
export function validateSettings(schema: SettingsSchema | undefined, input: unknown, existing: SettingsValues = {}): SettingsValidation {
  const errors: Record<string, string> = {}
  const values: SettingsValues = {}
  if (!schema) {
    if (input && typeof input === 'object' && Object.keys(input).length) errors._ = 'This module has no settings'
    return { ok: Object.keys(errors).length === 0, values, errors }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, values, errors: { _: 'Settings must be an object' } }
  }
  const obj = input as Record<string, unknown>
  for (const k of Object.keys(obj)) if (!schema.properties[k]) errors[k] = 'Unknown setting'
  for (const [k, p] of Object.entries(schema.properties)) {
    let raw = obj[k]
    if (p.type === 'string' && p.secret && raw === SECRET_PLACEHOLDER && existing[k] !== undefined) raw = existing[k]
    if (raw === undefined || raw === null || (raw === '' && p.type !== 'string')) {
      if (p.default !== undefined) values[k] = p.default
      continue
    }
    if (raw === '' && p.type === 'string' && (p.minLength ?? 0) === 0 && !(schema.required ?? []).includes(k)) {
      continue // an empty optional text field means "not set"
    }
    const r = validateOne(p, raw)
    if (r.error) errors[k] = r.error
    else values[k] = r.value!
  }
  for (const k of schema.required ?? []) {
    if (values[k] === undefined && !errors[k]) errors[k] = 'This setting is required'
  }
  return { ok: Object.keys(errors).length === 0, values, errors }
}

/** Replaces stored secrets by the placeholder so they never leave the server. */
export function redactSettings(schema: SettingsSchema | undefined, values: SettingsValues): SettingsValues {
  const out: SettingsValues = { ...values }
  for (const [k, p] of Object.entries(schema?.properties ?? {})) {
    if (p.type === 'string' && p.secret && out[k] !== undefined && out[k] !== '') out[k] = SECRET_PLACEHOLDER
  }
  return out
}
