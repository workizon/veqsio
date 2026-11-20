'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useId, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Avatar } from '../avatar'

export interface PickedUser { id: number; username: string; displayName: string; email: string }
interface ApiUser { id: number; key: string; name: string; emailAddress: string }

/** Autocomplete over /rest/api/2/user/search. Controlled: `value` is the chosen user or null. */
export function UserPicker({ label, value, onChange, hint }: { label: string; value: PickedUser | null; onChange: (u: PickedUser | null) => void; hint?: string }) {
  const { tr } = useI18n();

  const id = useId()
  const [text, setText] = useState('')
  const [options, setOptions] = useState<PickedUser[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/rest/api/2/user/search?query=${encodeURIComponent(text)}`, { credentials: 'include' })
        const data: ApiUser[] = res.ok ? await res.json() : []
        if (!cancelled) { setOptions(data.map((u) => ({ id: u.id, username: u.key, displayName: u.name, email: u.emailAddress }))); setActive(0) }
      } finally { if (!cancelled) setLoading(false) }
    }, 180)
    return () => { cancelled = true; clearTimeout(t) }
  }, [text, open])

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const choose = (u: PickedUser) => { onChange(u); setOpen(false); setText('') }

  return (
    <div ref={box} className="relative">
      <label htmlFor={id} className="block text-caption font-medium text-[var(--text-secondary)] mb-1">{label}</label>
      {value ? (
        <div className="veqsio-input flex items-center gap-2 !py-1.5">
          <Avatar name={value.displayName} size="sm" />
          <span className="flex-1 min-w-0 truncate text-sm text-[var(--text-primary)]">{value.displayName} <span className="text-[var(--text-tertiary)]">@{value.username}</span></span>
          <button type="button" aria-label={`Clear ${label}`} onClick={() => onChange(null)} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X className="w-4 h-4" /></button>
        </div>
      ) : (
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden />
          <input
            id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off"
            className="veqsio-input w-full !pl-9" placeholder={tr('Search by name, username or e-mail')} value={text}
            onChange={(e) => { setText(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); choose(options[active]) }
              else if (e.key === 'Escape') setOpen(false)
            }}
          />
          {open && (
            <ul id={`${id}-list`} role="listbox" aria-label={`${label} suggestions`} className="absolute z-30 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-lg py-1">
              {loading && options.length === 0 && <li className="px-3 py-2 text-sm text-[var(--text-tertiary)]">{tr('Searching...')}</li>}
              {!loading && options.length === 0 && <li className="px-3 py-2 text-sm text-[var(--text-tertiary)]">{tr('No users found')}</li>}
              {options.map((u, i) => (
                <li key={u.id} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); choose(u) }} onMouseEnter={() => setActive(i)}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm ${i === active ? 'bg-[var(--surface-2)]' : ''}`}>
                  <Avatar name={u.displayName} size="sm" />
                  <span className="text-[var(--text-primary)]">{u.displayName}</span>
                  <span className="text-[var(--text-tertiary)] truncate">@{u.username} {u.email && `· ${u.email}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {hint && <p className="text-caption text-[var(--text-tertiary)] mt-1">{hint}</p>}
    </div>
  )
}
