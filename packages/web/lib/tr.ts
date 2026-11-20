import { fill, type I18nVars } from './i18n'

/** The shape of `tr` from useI18n(). Lib helpers that build user-visible text take one as an optional last argument. */
export type Tr = (text: string, vars?: I18nVars) => string

/** English passthrough (placeholders filled): the default for lib helpers, and what tests use. */
export const identityTr: Tr = (text, vars) => fill(text, vars)

let active: Tr = identityTr
/** Published by useI18n() on every render (like setActiveLocale), so plain functions can translate without a hook. English until a component has rendered. */
export const setActiveTr = (tr: Tr): void => { active = tr }
/** `tr` for code that runs outside components (lib/*.ts messages, error texts, label builders): same keys, same {placeholders}. Call it when the text is built, not at module load. */
export const trNow: Tr = (text, vars) => active(text, vars)
