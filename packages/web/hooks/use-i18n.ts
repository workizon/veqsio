import { useCallback, useSyncExternalStore } from 'react'
import { usePublicSettings } from '@/hooks/use-instance-settings'
import { resolveLocale, translate, type LocaleId } from '@/lib/i18n'

const KEY = 'veqsio.locale'
const listeners = new Set<() => void>()
const read = () => (typeof window === 'undefined' ? null : window.localStorage.getItem(KEY))

/** The user's own language choice, or null to follow the instance default / browser language. */
export function setUserLocale(locale: LocaleId | null) {
  if (locale) window.localStorage.setItem(KEY, locale); else window.localStorage.removeItem(KEY)
  listeners.forEach((l) => l())
}

/**
 * Current interface language and the `tr()` function: `tr('Create issue')`. Order of precedence: personal choice,
 * instance default language, browser language, English. Missing translations fall back to the English text.
 */
export function useI18n() {
  const stored = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, read, () => null)
  const instance = usePublicSettings().data?.defaultLanguage
  const browser = typeof navigator === 'undefined' ? null : navigator.language
  const locale = resolveLocale(stored, instance, browser)
  const tr = useCallback((text: string) => translate(locale, text), [locale])
  return { locale, tr, stored }
}
