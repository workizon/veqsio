import { useCallback, useSyncExternalStore } from 'react'
import { usePublicSettings } from '@/hooks/use-instance-settings'
import { setActiveTr } from '@/lib/tr'
import { resolveLocale, translate, fill, setActiveLocale, type I18nVars, type LocaleId } from '@/lib/i18n'

export type { Tr } from '@/lib/tr'

const KEY = 'veqsio.locale'
const listeners = new Set<() => void>()
const read = () => (typeof window === 'undefined' ? null : window.localStorage.getItem(KEY))

/** The user's own language choice, or null to follow the instance default / browser language. */
export function setUserLocale(locale: LocaleId | null) {
  if (locale) window.localStorage.setItem(KEY, locale); else window.localStorage.removeItem(KEY)
  listeners.forEach((l) => l())
}

/**
 * The instance's default language from the public settings. Outside a QueryClientProvider (server rendering of a single component in a test, a storybook) there is
 * no settings cache: then there is no instance default, and the personal choice or the browser language decides. The provider is present for the lifetime of the
 * app, so this never switches from one case to the other while a component is mounted.
 */
function useInstanceLanguage(): string | undefined {
  try { return usePublicSettings().data?.defaultLanguage } catch { return undefined }
}

/**
 * Current interface language and the `tr()` function: `tr('Create issue')`. Order of precedence: personal choice,
 * instance default language, browser language, English. Missing translations fall back to the English text.
 */
export function useI18n() {
  const stored = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, read, () => null)
  const instance = useInstanceLanguage()
  const browser = typeof navigator === 'undefined' ? null : navigator.language
  const locale = resolveLocale(stored, instance, browser)
  setActiveLocale(locale)
  const tr = useCallback((text: string, vars?: I18nVars) => fill(translate(locale, text), vars), [locale])
  setActiveTr(tr)
  return { locale, tr, stored }
}
