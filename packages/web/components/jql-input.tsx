'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { applySuggestion, getJqlContext, type JqlContext } from '@/lib/jql-autocomplete'

interface AutoField {
  value: string
  displayName: string
  orderable: string
  auto?: string
  operators: string[]
  types: string[]
}
interface AutoFunction {
  value: string
  displayName: string
  types: string[]
}
interface AutoData {
  visibleFieldNames: AutoField[]
  visibleFunctionNames: AutoFunction[]
  jqlReservedWords: string[]
}
interface Suggestion {
  /** Text inserted into the query */
  insert: string
  /** Text shown in the dropdown */
  label: string
  hint: string
  asValue?: boolean
}

const LOGICAL_KEYWORDS = ['AND', 'OR', 'ORDER BY']

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function matches(candidate: string, prefix: string) {
  const c = candidate.toLowerCase()
  const p = prefix.toLowerCase()
  return !p || c.startsWith(p) || c.includes(p)
}

function rank<T>(items: T[], text: (t: T) => string, prefix: string): T[] {
  const p = prefix.toLowerCase()
  return items
    .filter((i) => matches(text(i), prefix))
    .sort((a, b) => Number(text(b).toLowerCase().startsWith(p)) - Number(text(a).toLowerCase().startsWith(p)))
}

export interface JqlInputProps {
  value: string
  onChange: (value: string) => void
  /** Called when the user presses Enter with no suggestion highlighted. */
  onSubmit?: () => void
  placeholder?: string
  className?: string
}

export function JqlInput({ value, onChange, onSubmit, placeholder, className }: JqlInputProps) {
  const { tr } = useI18n();

  const inputRef = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState(value.length)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [valueSuggestions, setValueSuggestions] = useState<{ value: string; displayName: string }[]>([])

  const { data: meta } = useQuery({
    queryKey: ['jql', 'autocompletedata'],
    queryFn: () => getJson<AutoData>('/rest/api/2/jql/autocompletedata'),
    staleTime: 5 * 60_000,
  })

  const ctx: JqlContext = useMemo(() => getJqlContext(value, cursor), [value, cursor])

  // Fetch value suggestions (debounced) when completing a value for a known field.
  const valueField = ctx.kind === 'value' ? ctx.field : undefined
  const valuePrefix = ctx.prefix
  useEffect(() => {
    if (!valueField) {
      setValueSuggestions([])
      return
    }
    const fieldMeta = meta?.visibleFieldNames.find((f) => f.value.toLowerCase() === valueField)
    if (meta && !fieldMeta?.auto) {
      setValueSuggestions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      getJson<{ results: { value: string; displayName: string }[] }>(
        `/rest/api/2/jql/autocompletedata/suggestions?fieldName=${encodeURIComponent(valueField)}&fieldValue=${encodeURIComponent(valuePrefix)}`,
      )
        .then((r) => !cancelled && setValueSuggestions(r.results))
        .catch(() => !cancelled && setValueSuggestions([]))
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [valueField, valuePrefix, meta])

  const suggestions: Suggestion[] = useMemo(() => {
    if (!meta) return []
    const out: Suggestion[] = []
    const fieldList = (orderable: boolean) =>
      rank(
        meta.visibleFieldNames.filter((f) => !orderable || f.orderable === 'true'),
        (f) => f.displayName,
        ctx.prefix,
      ).map((f) => ({ insert: f.value, label: f.displayName, hint: 'field' }))

    switch (ctx.kind) {
      case 'field':
        out.push(...fieldList(false))
        if (!ctx.prefix || 'not'.startsWith(ctx.prefix.toLowerCase()))
          out.push({ insert: 'NOT', label: 'NOT', hint: 'keyword' })
        break
      case 'orderField':
        out.push(...fieldList(true))
        break
      case 'orderDirection':
        for (const d of ['ASC', 'DESC'])
          if (matches(d, ctx.prefix)) out.push({ insert: d, label: d, hint: 'keyword' })
        break
      case 'operator': {
        if (ctx.extraKeywords.length > 0) {
          for (const k of ctx.extraKeywords)
            if (matches(k, ctx.prefix)) out.push({ insert: k, label: k, hint: 'operator' })
          break
        }
        const f = meta.visibleFieldNames.find((x) => x.value.toLowerCase() === ctx.field)
        const ops = f?.operators ?? ['=', '!=', '~', 'in', 'is']
        for (const op of rank(ops, (o) => o, ctx.prefix)) out.push({ insert: op, label: op, hint: 'operator' })
        break
      }
      case 'keyword': {
        const words = ctx.extraKeywords.length > 0 ? [...ctx.extraKeywords, ...LOGICAL_KEYWORDS] : LOGICAL_KEYWORDS
        for (const k of words) if (matches(k, ctx.prefix)) out.push({ insert: k, label: k, hint: 'keyword' })
        break
      }
      case 'value': {
        if (ctx.operator === 'is' || ctx.operator === 'is not') {
          for (const k of ['EMPTY', 'NULL']) if (matches(k, ctx.prefix)) out.push({ insert: k, label: k, hint: 'keyword' })
          break
        }
        const f = meta.visibleFieldNames.find((x) => x.value.toLowerCase() === ctx.field)
        for (const v of valueSuggestions)
          out.push({ insert: v.value, label: v.displayName, hint: 'value', asValue: true })
        if (!ctx.quoted) {
          const types = new Set(f?.types ?? [])
          const fns = meta.visibleFunctionNames.filter(
            (fn) => !f || fn.types.some((t) => types.has(t)),
          )
          for (const fn of rank(fns, (x) => x.displayName, ctx.prefix))
            out.push({ insert: fn.value, label: fn.displayName, hint: 'function', asValue: true })
        }
        break
      }
      default:
        break
    }
    // Do not suggest what is already fully typed.
    return out
      .filter((s) => !(s.insert.toLowerCase() === ctx.prefix.toLowerCase() && s.hint !== 'value'))
      .slice(0, 12)
  }, [meta, ctx, valueSuggestions])

  useEffect(() => setActive(0), [suggestions])

  const showList = open && suggestions.length > 0

  const accept = (s: Suggestion) => {
    const r = applySuggestion(value, ctx, s.insert, { asValue: s.asValue })
    onChange(r.text)
    setCursor(r.cursor)
    setOpen(true)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(r.cursor, r.cursor)
      }
    })
  }

  const syncCursor = () => {
    const el = inputRef.current
    if (el) setCursor(el.selectionStart ?? el.value.length)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (showList) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (a + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        accept(suggestions[active])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
    }
    if (e.key === 'Enter') {
      setOpen(false)
      onSubmit?.()
    }
  }

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        aria-label={tr('JQL query')}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        aria-controls="jql-suggestions"
        aria-activedescendant={showList ? `jql-suggestion-${active}` : undefined}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        className={className ?? 'veqsio-input w-full font-mono'}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCursor(e.target.selectionStart ?? e.target.value.length)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) syncCursor()
        }}
        onClick={syncCursor}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      />
      {showList && (
        <ul
          id="jql-suggestions"
          role="listbox"
          className="absolute z-30 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] shadow-lg py-1"
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s.hint}:${s.insert}`}
              id={`jql-suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown (not click) so the input does not lose focus first
              onMouseDown={(e) => {
                e.preventDefault()
                accept(s)
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex items-center justify-between gap-3 px-3 py-1.5 cursor-pointer text-body-sm ${
                i === active ? 'bg-[var(--brand-50)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
              }`}
            >
              <span className="font-mono truncate">{s.label}</span>
              <span className="text-caption text-[var(--text-tertiary,var(--text-secondary))]">{s.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
