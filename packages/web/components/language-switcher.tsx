'use client'

import { Globe } from 'lucide-react'
import { useI18n, setUserLocale } from '@/hooks/use-i18n'
import { LOCALES, isLocale } from '@/lib/i18n'

/** Quick interface-language switch (same personal choice as /settings: stored in this browser, overrides the instance default). */
export function LanguageSwitcher({ className = '', block = false }: { className?: string; block?: boolean }) {
  const { locale, tr } = useI18n()
  return (
    <label className={`relative inline-flex items-center ${block ? 'w-full' : ''} ${className}`}>
      <span className="sr-only">{tr('Language')}</span>
      <Globe aria-hidden className="w-4 h-4 absolute left-2.5 pointer-events-none text-[var(--text-tertiary)]" />
      <select
        value={locale}
        onChange={(e) => { if (isLocale(e.target.value)) setUserLocale(e.target.value) }}
        className={`veqsio-input !pl-8 !py-1 text-sm cursor-pointer ${block ? 'w-full' : ''}`}
      >
        {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  )
}
