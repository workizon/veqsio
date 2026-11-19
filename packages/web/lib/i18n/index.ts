/**
 * Interface language. The UI text in the code is English and doubles as the translation key: `tr('Create issue')`
 * returns the translation for the current language, or the English text when there is none (so a missing
 * translation never shows an empty label and a new string needs no dictionary entry to work).
 * Only visible words are translated; API fields, JQL, URLs and issue keys never go through here.
 */
import { de } from './de'
import { es } from './es'
import { ru } from './ru'

export const LOCALES = [
  { id: 'en', name: 'English' },
  { id: 'de', name: 'Deutsch' },
  { id: 'es', name: 'Español' },
  { id: 'ru', name: 'Русский' },
] as const
export type LocaleId = (typeof LOCALES)[number]['id']
export const DEFAULT_LOCALE: LocaleId = 'en'

export const DICTIONARIES: Record<Exclude<LocaleId, 'en'>, Record<string, string>> = { de, es, ru }

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

/** BCP 47 tag for Intl and date formatting. */
export const intlLocale = (locale: LocaleId): string => ({ en: 'en-US', de: 'de-DE', es: 'es-ES', ru: 'ru-RU' })[locale]
