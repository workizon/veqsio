'use client'


import { useI18n } from '@/hooks/use-i18n'
import Link from 'next/link'
import type { CalendarDay } from '@/lib/calendar-grid'
import { getIntlLocale } from '@/lib/i18n'

/** Short weekday names, Monday first, in the interface language (2024-01-01 was a Monday). */
const weekdayNames = (locale: string) => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))))
const MAX_PER_DAY = 3

export interface CalendarIssue { key: string; fields: { summary: string } }

/** The month grid shared by the Calendar page and the calendar layout of saved views. */
export function MonthCalendar({ weeks, title, byDay, today }: { weeks: CalendarDay[][]; title: string; byDay: Map<string, CalendarIssue[]>; today: string }) {
  const { tr } = useI18n();

  const days = weeks.flat().filter((d) => d.inMonth && (byDay.get(d.date)?.length ?? 0) > 0)
  return (
    <>
    <div role="grid" aria-label={title} className="overflow-hidden rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
      <div role="row" className="grid grid-cols-[repeat(7,minmax(0,1fr))] border-b border-[var(--surface-3)] bg-[var(--surface-1)] text-caption text-[var(--text-secondary)]">
        {weekdayNames(getIntlLocale()).map((d, i) => <div key={i} role="columnheader" className="px-1 sm:px-2 py-1.5 text-center sm:text-left">{d}</div>)}
      </div>
      {weeks.map((week, wi) => (
        <div role="row" key={wi} className="grid grid-cols-[repeat(7,minmax(0,1fr))] border-b border-[var(--surface-3)] last:border-b-0">
          {week.map((d) => {
            const items = byDay.get(d.date) ?? []
            return (
              <div role="gridcell" key={d.date} aria-label={tr('{date}, {n} issues', { date: d.date, n: items.length })} className={`min-h-[56px] sm:min-h-[104px] border-r border-[var(--surface-3)] p-1 sm:p-1.5 last:border-r-0 ${d.inMonth ? '' : 'bg-[var(--surface-1)] text-[var(--text-tertiary)]'}`}>
                <div className={`mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-caption ${d.date === today ? 'bg-[var(--brand-600)] font-semibold text-white' : ''}`}>{d.day}</div>
                {items.length > 0 && <span className="sm:hidden mx-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--brand-50)] px-1 text-[11px] font-semibold text-[var(--brand-700)]" aria-hidden="true">{items.length}</span>}
                <ul className="hidden sm:block space-y-1">
                  {items.slice(0, MAX_PER_DAY).map((i) => (
                    <li key={i.key}>
                      <Link href={`/issues/${i.key}`} title={`${i.key} ${i.fields.summary}`} className="block truncate rounded bg-[var(--brand-50)] px-1.5 py-0.5 text-caption text-[var(--brand-700)] hover:underline">
                        <span className="font-medium">{i.key}</span> {i.fields.summary}
                      </Link>
                    </li>
                  ))}
                  {items.length > MAX_PER_DAY && <li className="px-1.5 text-caption text-[var(--text-tertiary)]">{tr('+{n} more', { n: items.length - MAX_PER_DAY })}</li>}
                </ul>
              </div>
            )
          })}
        </div>
      ))}
    </div>
    {/* a phone has no room for titles in a month grid: the same issues as a list by day */}
    <div className="sm:hidden mt-4 space-y-3" aria-label={`${title}, by day`}>
      {days.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">{tr('Nothing scheduled this month.')}</p>}
      {days.map((d) => (
        <section key={d.date} className="rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] p-3">
          <h3 className="mb-1.5 text-xs font-semibold text-[var(--text-secondary)]">{d.date}</h3>
          <ul className="space-y-1">
            {(byDay.get(d.date) ?? []).map((i) => (
              <li key={i.key}><Link href={`/issues/${i.key}`} className="flex min-h-[40px] items-center gap-2 text-sm text-[var(--brand-700)]"><span className="font-medium">{i.key}</span><span className="truncate text-[var(--text-primary)]">{i.fields.summary}</span></Link></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
    </>
  )
}
