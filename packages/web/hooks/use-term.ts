import { useCallback } from 'react'
import { usePublicSettings } from '@/hooks/use-instance-settings'
import { useI18n } from '@/hooks/use-i18n'
import { DEFAULT_TERM, countLabel, isTerm, termWord, termify, type Term } from '@/lib/term'

/**
 * The word this instance uses for an issue. Falls back to "issue" while the setting loads or when it is missing, so
 * the UI never flashes an unexpected word and old servers keep working.
 *
 *   const { issue, issues, Issue, Issues, t } = useTerm()
 *   <h1>{Issues}</h1>   <button>{t('Create issue')}</button>   <p>{t('No {issues} found')}</p>
 */
export function useTerm() {
  const raw = usePublicSettings().data?.issueTerm
  const term: Term = isTerm(raw) ? raw : DEFAULT_TERM
  const { tr } = useI18n()
  const t = useCallback((text: string) => termify(tr(text), term), [term, tr])
  const count = useCallback((n: number) => countLabel(n, term), [term])
  return {
    term,
    issue: termWord(term),
    issues: termWord(term, { plural: true }),
    Issue: termWord(term, { capitalize: true }),
    Issues: termWord(term, { plural: true, capitalize: true }),
    t,
    count,
  }
}
