/**
 * Interface language. The UI text in the code is English and doubles as the translation key: `tr('Create issue')`
 * returns the translation for the current language, or the English text when there is none (so a missing
 * translation never shows an empty label and a new string needs no dictionary entry to work).
 * Only visible words are translated; API fields, JQL, URLs and issue keys never go through here.
 */
import { de } from './de'
import { es } from './es'
import { ru } from './ru'
import { autoDe } from './auto-de'
import { autoEs } from './auto-es'
import { autoRu } from './auto-ru'
import { autoFr } from './auto-fr'
import { autoPt } from './auto-pt'
import { autoZh } from './auto-zh'
import { autoJa } from './auto-ja'

export const LOCALES = [
  { id: 'en', name: 'English' },
  { id: 'de', name: 'Deutsch' },
  { id: 'es', name: 'Español' },
  { id: 'ru', name: 'Русский' },
  { id: 'fr', name: 'Français' },
  { id: 'pt', name: 'Português (Brasil)' },
  { id: 'zh', name: '中文（简体）' },
  { id: 'ja', name: '日本語' },
] as const
export type LocaleId = (typeof LOCALES)[number]['id']
export const DEFAULT_LOCALE: LocaleId = 'en'

export const DICTIONARIES: Record<Exclude<LocaleId, 'en'>, Record<string, string>> = { de: { ...autoDe, ...de }, es: { ...autoEs, ...es }, ru: { ...autoRu, ...ru }, fr: autoFr, pt: autoPt, zh: autoZh, ja: autoJa }

export function isLocale(v: unknown): v is LocaleId {
  return typeof v === 'string' && LOCALES.some((l) => l.id === v)
}

/** Best supported locale for a browser language such as "de-AT" or "ru". */
export function matchLocale(language: string | null | undefined): LocaleId | null {
  const base = (language ?? '').toLowerCase().split(/[-_]/)[0]
  return isLocale(base) ? base : null
}

/** Chooses: the user's own choice, else the instance default, else the browser language, else English. */
export function resolveLocale(userChoice: string | null | undefined, instanceDefault: string | null | undefined, browser: string | null | undefined): LocaleId {
  if (isLocale(userChoice)) return userChoice
  if (isLocale(instanceDefault) && instanceDefault !== 'en') return instanceDefault
  return matchLocale(browser) ?? (isLocale(instanceDefault) ? instanceDefault : DEFAULT_LOCALE)
}

export function translate(locale: LocaleId, text: string): string {
  if (locale === 'en') return text
  return DICTIONARIES[locale][text] ?? text
}

/** Replaces {name} placeholders: `fill('Delete "{name}"?', { name })`. A placeholder without a value is left as it is. */
export type I18nVars = Record<string, string | number | null | undefined>
/** A null/undefined value (data that is not there) fills in as an empty string. */
export function fill(text: string, vars?: I18nVars): string {
  return vars ? text.replace(/\{([a-zA-Z]+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m)) : text
}

/** BCP 47 tag for Intl and date formatting. */
export const intlLocale = (locale: LocaleId): string => ({ en: 'en-US', de: 'de-DE', es: 'es-ES', ru: 'ru-RU', fr: 'fr-FR', pt: 'pt-BR', zh: 'zh-CN', ja: 'ja-JP' })[locale]

/**
 * The interface language as a BCP 47 tag for dates and numbers. The hook in hooks/use-i18n.ts publishes it on every
 * render, so plain functions (lib/*.ts, formatters outside components) format with the app's language instead of the
 * browser's: `date.toLocaleDateString(getIntlLocale(), ...)`.
 */
let activeIntl = 'en-US'
export const setActiveLocale = (locale: LocaleId): void => { activeIntl = intlLocale(locale) }
export const getIntlLocale = (): string => activeIntl

/** Time units that `relativeIntl` accepts. */
export type RelUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year'
/**
 * "5 minutes ago" / "in 2 days" in the interface language, with the plural forms of that language (Intl does it, no dictionary entries).
 * `value` is negative for the past. Returns null for English so callers keep their own English wording (and tests stay stable).
 */
export function relativeIntl(value: number, unit: RelUnit, style: 'long' | 'short' = 'long'): string | null {
  if (activeIntl.toLowerCase().startsWith('en')) return null
  try { return new Intl.RelativeTimeFormat(activeIntl, { numeric: 'auto', style }).format(value, unit) } catch { return null }
}
