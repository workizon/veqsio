'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'
import {
  useDeleteCalendar, useDesks, usePreviewCalendar, useSaveCalendar, useSlaCalendars,
  type Holiday, type SlaCalendar, type WorkingHours,
} from '@/hooks/use-servicedesk'
import { formatMinutes, parseDuration } from '@/lib/sla'
import { confirmDialog } from '@/components/dialogs'

const DAYS: Array<{ key: keyof WorkingHours; label: string }> = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' }, { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' }, { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' }, { key: 'sun', label: 'Sunday' },
]

function timeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
    return list.includes('UTC') ? list : ['UTC', ...list]
  } catch {
    return ['UTC']
  }
}

interface Draft { id?: number; name: string; timeZone: string; workingHours: WorkingHours; holidays: Holiday[]; builtIn: boolean }

const NINE_TO_FIVE: WorkingHours = Object.fromEntries((['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((d) => [d, [['09:00', '17:00']]]))

const emptyDraft = (): Draft => ({ name: '', timeZone: 'UTC', workingHours: structuredClone(NINE_TO_FIVE), holidays: [], builtIn: false })
const toDraft = (c: SlaCalendar): Draft => ({
  id: c.id, name: c.name, timeZone: c.timeZone, builtIn: c.builtIn,
  workingHours: structuredClone(c.workingHours ?? {}), holidays: c.holidays.map((h) => ({ ...h })),
})

function weeklyHours(h: WorkingHours): number {
  let min = 0
  for (const d of DAYS) for (const [s, e] of h[d.key] ?? []) {
    const [sh, sm] = s.split(':').map(Number), [eh, em] = e.split(':').map(Number)
    min += eh * 60 + em - (sh * 60 + sm)
  }
  return min
}

export default function CalendarsPage() {
  const id = Number(useParams<{ id: string }>().id)
  const desks = useDesks()
  const cals = useSlaCalendars(id)
  const save = useSaveCalendar(id)
  const del = useDeleteCalendar(id)
  const isAdmin = desks.data?.values.find((d) => d.id === id)?.role === 'admin'
  const zones = useMemo(timeZones, [])

  const [draft, setDraft] = useState<Draft | null>(null)
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))

  const setDay = (key: keyof WorkingHours, list: Array<[string, string]>) =>
    patch({ workingHours: { ...draft!.workingHours, [key]: list } })

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="text-heading-1 text-[var(--text-primary)]">Calendars</h1>
          <div className="flex gap-2">
            <Link href={`/servicedesk/${id}/sla`} className="veqsio-btn-secondary">SLAs</Link>
            <Link href={`/servicedesk/${id}`} className="veqsio-btn-secondary">Back to service desk</Link>
          </div>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          Calendars define when SLA clocks run: working hours per weekday, a time zone and holidays. Each SLA goal can use its own calendar.
        </p>

        {!desks.isLoading && !isAdmin && <div role="alert" className="text-[var(--error)]">Only service desk administrators can manage calendars.</div>}
        {cals.isLoading && <Spinner />}
        {cals.error && isAdmin && <div role="alert" className="text-[var(--error)]">{cals.error.message}</div>}

        {isAdmin && (
          <div className="grid gap-4 lg:grid-cols-[18rem_1fr] items-start">
            <div className="veqsio-card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-heading-3">Calendars</h2>
                <button className="veqsio-btn-primary text-sm" onClick={() => setDraft(emptyDraft())}>Add calendar</button>
              </div>
              <ul className="space-y-1">
                {cals.data?.values.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => setDraft(toDraft(c))}
                      aria-current={draft?.id === c.id}
                      className={`w-full text-left rounded px-2 py-2 hover:bg-[var(--surface-2)] ${draft?.id === c.id ? 'bg-[var(--surface-2)]' : ''}`}
                    >
                      <div className="font-medium text-[var(--text-primary)]">{c.name}</div>
                      <div className="text-xs text-[var(--text-tertiary)]">
                        {c.builtIn ? 'Always open' : `${c.timeZone} · ${formatMinutes(weeklyHours(c.workingHours))} per week${c.holidays.length ? ` · ${c.holidays.length} holiday${c.holidays.length === 1 ? '' : 's'}` : ''}`}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {draft ? (
              <CalendarEditor
                key={draft.id ?? 'new'}
                deskId={id}
                draft={draft}
                zones={zones}
                patch={patch}
                setDay={setDay}
                saving={save.isPending}
                error={(save.error as Error | null)?.message ?? (del.error as Error | null)?.message}
                onSave={() =>
                  save.mutate(
                    { id: draft.id, name: draft.name.trim(), timeZone: draft.timeZone, workingHours: draft.workingHours, holidays: draft.holidays },
                    { onSuccess: (c) => setDraft(toDraft(c)) },
                  )
                }
                onDelete={draft.id ? async () => { if ((await confirmDialog(`Delete calendar "${draft.name}"?`))) del.mutate(draft.id!, { onSuccess: () => setDraft(null) }) } : undefined}
                onCancel={() => setDraft(null)}
              />
            ) : (
              <div className="veqsio-card p-6 text-[var(--text-secondary)]">Select a calendar to edit it, or add a new one.</div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function CalendarEditor(props: {
  deskId: number
  draft: Draft
  zones: string[]
  patch: (p: Partial<Draft>) => void
  setDay: (key: keyof WorkingHours, list: Array<[string, string]>) => void
  saving: boolean
  error?: string
  onSave: () => void
  onDelete?: () => void
  onCancel: () => void
}) {
  const { draft, zones, patch, setDay } = props

  if (draft.builtIn) {
    return (
      <div className="veqsio-card p-4 space-y-3">
        <h2 className="text-heading-2">{draft.name}</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          The built-in 24/7 calendar counts every minute of every day. It cannot be edited or deleted.
        </p>
        <PreviewWidget deskId={props.deskId} draft={draft} />
      </div>
    )
  }

  const nameOk = draft.name.trim().length > 0
  const holidaysOk = draft.holidays.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date) && h.name.trim())
  const hoursErrors = DAYS.flatMap((d) => (draft.workingHours[d.key] ?? []).flatMap(([s, e], i) => (!s || !e || e <= s && e !== '24:00' ? [`${d.label}: interval ${i + 1} must end after it starts`] : [])))

  return (
    <form
      className="veqsio-card p-4 space-y-5"
      onSubmit={(e) => { e.preventDefault(); if (nameOk && holidaysOk && hoursErrors.length === 0) props.onSave() }}
    >
      <h2 className="text-heading-2">{draft.id ? 'Edit calendar' : 'New calendar'}</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="cal-name" className="text-sm">Name</label>
          <input id="cal-name" className="veqsio-input w-full" maxLength={255} required value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <label htmlFor="cal-tz" className="text-sm">Time zone</label>
          <select id="cal-tz" className="veqsio-input w-full" value={draft.timeZone} onChange={(e) => patch({ timeZone: e.target.value })}>
            {!zones.includes(draft.timeZone) && <option value={draft.timeZone}>{draft.timeZone}</option>}
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-heading-3 mb-1">Working hours</legend>
        <div className="flex gap-2 text-xs">
          <button type="button" className="veqsio-btn-ghost" onClick={() => patch({ workingHours: structuredClone(NINE_TO_FIVE) })}>Mon to Fri, 9 to 5</button>
          <button type="button" className="veqsio-btn-ghost" onClick={() => {
            const mon = draft.workingHours.mon ?? []
            patch({ workingHours: { ...draft.workingHours, tue: structuredClone(mon), wed: structuredClone(mon), thu: structuredClone(mon), fri: structuredClone(mon) } })
          }}>Copy Monday to Tue to Fri</button>
        </div>
        <ul className="divide-y divide-[var(--surface-3)]">
          {DAYS.map(({ key, label }) => {
            const list = draft.workingHours[key] ?? []
            const on = list.length > 0
            return (
              <li key={key} className="flex flex-wrap items-start gap-3 py-2">
                <label className="flex items-center gap-2 w-36 pt-1.5">
                  <input
                    type="checkbox" checked={on}
                    onChange={(e) => setDay(key, e.target.checked ? [['09:00', '17:00']] : [])}
                  />
                  <span className={on ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}>{label}</span>
                </label>
                <div className="flex-1 space-y-1 min-w-[16rem]">
                  {!on && <span className="text-sm text-[var(--text-tertiary)] inline-block pt-1.5">Closed</span>}
                  {list.map(([s, e], i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input aria-label={`${label} interval ${i + 1} start`} type="time" className="veqsio-input" value={s}
                        onChange={(ev) => setDay(key, list.map((x, j) => (j === i ? [ev.target.value, x[1]] : x)))} />
                      <span className="text-[var(--text-tertiary)]">to</span>
                      <input aria-label={`${label} interval ${i + 1} end`} type="time" className="veqsio-input" value={e === '24:00' ? '23:59' : e}
                        onChange={(ev) => setDay(key, list.map((x, j) => (j === i ? [x[0], ev.target.value] : x)))} />
                      <button type="button" className="veqsio-btn-ghost text-sm" aria-label={`Remove ${label} interval ${i + 1}`}
                        onClick={() => setDay(key, list.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                  ))}
                  {on && (
                    <button type="button" className="veqsio-btn-ghost text-sm" onClick={() => {
                      const last = list[list.length - 1]?.[1] ?? '09:00'
                      const start = last >= '22:00' ? '22:00' : `${String(Number(last.slice(0, 2)) + 1).padStart(2, '0')}:00`
                      setDay(key, [...list, [start, '23:00' > start ? '23:00' : '23:59']])
                    }}>Add interval</button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        {hoursErrors.map((e) => <div key={e} role="alert" className="text-sm text-[var(--error)]">{e}</div>)}
      </fieldset>

      <HolidayList holidays={draft.holidays} onChange={(holidays) => patch({ holidays })} />

      <PreviewWidget deskId={props.deskId} draft={draft} />

      {props.error && <div role="alert" className="text-[var(--error)]">{props.error}</div>}
      <div className="flex gap-2">
        <button type="submit" className="veqsio-btn-primary" disabled={props.saving || !nameOk || !holidaysOk || hoursErrors.length > 0}>
          {draft.id ? 'Save' : 'Create'}
        </button>
        <button type="button" className="veqsio-btn-secondary" onClick={props.onCancel}>Cancel</button>
        {props.onDelete && <button type="button" className="veqsio-btn-secondary ml-auto" onClick={props.onDelete}>Delete</button>}
      </div>
    </form>
  )
}

function HolidayList({ holidays, onChange }: { holidays: Holiday[]; onChange: (h: Holiday[]) => void }) {
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [recurring, setRecurring] = useState(false)
  const sorted = [...holidays].sort((a, b) => a.date.localeCompare(b.date))
  return (
    <fieldset className="space-y-2">
      <legend className="text-heading-3 mb-1">Holidays</legend>
      <p className="text-xs text-[var(--text-tertiary)]">The clock does not run on these days. Recurring holidays repeat every year on the same date.</p>
      {sorted.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No holidays</p>}
      <ul className="space-y-1">
        {sorted.map((h) => (
          <li key={`${h.date}-${h.name}`} className="flex items-center gap-3 text-sm">
            <span className="tabular-nums w-28">{h.date}</span>
            <span className="flex-1 text-[var(--text-primary)]">{h.name}</span>
            {h.recurring && <span className="veqsio-badge">Every year</span>}
            <button type="button" className="veqsio-btn-ghost" aria-label={`Remove holiday ${h.name}`} onClick={() => onChange(holidays.filter((x) => x !== h))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="hol-date" className="text-xs">Date</label>
          <input id="hol-date" type="date" className="veqsio-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1 flex-1 min-w-[10rem]">
          <label htmlFor="hol-name" className="text-xs">Name</label>
          <input id="hol-name" className="veqsio-input w-full" maxLength={255} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New Year" />
        </div>
        <label className="flex items-center gap-1 text-sm pb-2"><input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} /> Repeats every year</label>
        <button
          type="button" className="veqsio-btn-secondary" disabled={!date || !name.trim()}
          onClick={() => { onChange([...holidays, { date, name: name.trim(), recurring }]); setDate(''); setName(''); setRecurring(false) }}
        >Add holiday</button>
      </div>
    </fieldset>
  )
}

function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "Test your calendar": enter a start time and a goal, see when it falls due. Works on unsaved edits. */
function PreviewWidget({ deskId, draft }: { deskId: number; draft: Draft }) {
  const preview = usePreviewCalendar(deskId)
  const [start, setStart] = useState('')
  const [duration, setDuration] = useState('4h')
  useEffect(() => { setStart(localInputValue(new Date())) }, [])
  const minutes = parseDuration(duration)
  const tz = draft.builtIn ? undefined : draft.timeZone

  const run = () => {
    if (minutes == null || !start) return
    const iso = new Date(start).toISOString()
    preview.mutate(draft.id && draft.builtIn
      ? { calendarId: draft.id, start: iso, durationMinutes: minutes }
      : { calendar: { timeZone: draft.timeZone, workingHours: draft.workingHours, holidays: draft.holidays }, start: iso, durationMinutes: minutes })
  }
  const fmt = (iso: string, zone?: string) => {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(new Date(iso)) } catch { return iso }
  }

  return (
    <div className="rounded border border-[var(--surface-3)] bg-[var(--surface-2)] p-3 space-y-2">
      <h3 className="text-heading-3">Test your calendar</h3>
      <p className="text-xs text-[var(--text-tertiary)]">If an issue is created at the start time, when does a goal of this length run out?</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="pv-start" className="text-xs">Issue created (your local time)</label>
          <input id="pv-start" type="datetime-local" className="veqsio-input" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label htmlFor="pv-dur" className="text-xs">Goal</label>
          <input id="pv-dur" className="veqsio-input w-28" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="4h 30m" aria-invalid={minutes == null} />
        </div>
        <button type="button" className="veqsio-btn-secondary" disabled={minutes == null || !start || preview.isPending} onClick={run}>Calculate due time</button>
      </div>
      {minutes == null && <div className="text-xs text-[var(--error)]">Enter a duration such as 4h 30m, 90m or 1d</div>}
      {preview.error && <div role="alert" className="text-sm text-[var(--error)]">{(preview.error as Error).message}</div>}
      {preview.data && (
        <div className="text-sm" role="status">
          {preview.data.due ? (
            <>
              <div>Due <strong className="text-[var(--text-primary)]">{fmt(preview.data.due, tz)}</strong>{tz ? ` (${tz})` : ''}</div>
              <div className="text-[var(--text-tertiary)]">
                {preview.data.elapsedMinutes != null && `${formatMinutes(preview.data.elapsedMinutes)} on the wall clock`}
                {preview.data.workingMinutes != null && `, ${formatMinutes(preview.data.workingMinutes)} of it working time`}
              </div>
            </>
          ) : <div className="text-[var(--warning)]">{preview.data.message ?? 'Never due'}</div>}
        </div>
      )}
    </div>
  )
}
