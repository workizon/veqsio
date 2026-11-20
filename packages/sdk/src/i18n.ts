/**
 * Interface language for modules. The host app owns the language choice (personal setting, instance default, browser language) and publishes it with
 * `moduleI18n.setHost(locale, tr)`. A module ships its own dictionaries and registers them once:
 *
 *   moduleI18n.register('plans', { de: { 'New plan': 'Neuer Plan' }, ru: { 'New plan': 'Новый план' } })
 *
 * and translates with `moduleI18n.translate('plans', 'New plan')`: the module's own dictionary first, then the host's dictionary (common words such as
 * "Save" or "Cancel"), then the English text itself, so a missing translation never shows an empty label. The English text is the key.
 * Framework-free on purpose: a module wraps `subscribe` / `getVersion` in `useSyncExternalStore` to re-render when the language changes.
 */
export type ModuleDictionaries = Record<string, Record<string, string>>

const dictionaries = new Map<string, ModuleDictionaries>()
const listeners = new Set<() => void>()
let locale = 'en'
let hostTr: (text: string, vars?: Record<string, string | number>) => string = (t) => t
let version = 0

function bump() { version++; listeners.forEach((l) => l()) }

export const moduleI18n = {
  /** Registers (or replaces) the dictionaries of one module, keyed by language id (`de`, `ru`, ...). */
  register(moduleId: string, dicts: ModuleDictionaries): void { dictionaries.set(moduleId, dicts); bump() },
  /** Called by the host app whenever the interface language changes. */
  setHost(nextLocale: string, tr: (text: string, vars?: Record<string, string | number>) => string): void { if (nextLocale === locale && tr === hostTr) return; locale = nextLocale; hostTr = tr; bump() },
  getLocale(): string { return locale },
  translate(moduleId: string, text: string, vars?: Record<string, string | number>): string {
    const out = locale === 'en' ? text : dictionaries.get(moduleId)?.[locale]?.[text] ?? hostTr(text)
    return vars ? out.replace(/\{([a-zA-Z]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out
  },
  /** For `useSyncExternalStore(moduleI18n.subscribe, moduleI18n.getVersion, moduleI18n.getVersion)`. */
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
  getVersion(): number { return version },
}
