'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { History, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useDeleteRecurring, useIssueTemplates, useRecurring, useRecurringRuns, useSaveRecurring, type RecurringRule } from '@/hooks/use-templates'
import { useTerm } from '@/hooks/use-term'
import { confirmDialog } from '@/components/dialogs'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function describeSchedule(r: Pick<RecurringRule, 'frequency' | 'daysOfWeek' | 'dayOfMonth' | 'timeOfDay' | 'timezone'>): string {
  const when = `at ${r.timeOfDay} (${r.timezone})`
  if (r.frequency === 'daily') return `Every day ${when}`
  if (r.frequency === 'monthly') return `Monthly on day ${r.dayOfMonth} ${when}`
  const days = r.daysOfWeek.length ? [...r.daysOfWeek].sort().map((d) => DAYS[d - 1]).join(', ') : 'Mon, Tue, Wed, Thu, Fri'
  return `Weekly on ${days} ${when}`
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '-')

function timezones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  return list.includes('UTC') ? list : ['UTC', ...list]
}

function RuleEditor({ projectKey, rule, onClose }: { projectKey: string; rule: RecurringRule | null; onClose: () => void }) {
  const { tr } = useI18n();

  const { t } = useTerm()
  const templates = useIssueTemplates(projectKey)
  const users = useQuery({ queryKey: ['assignable-users'], queryFn: () => fetch('/rest/api/2/user/search?username=', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).then((d) => (d?.users ?? []) as Array<{ id: number; displayName: string }>) })
  const save = useSaveRecurring(projectKey)
  const [name, setName] = useState(rule?.name ?? '')
  const [templateId, setTemplateId] = useState(rule ? String(rule.templateId) : '')
  const [frequency, setFrequency] = useState<RecurringRule['frequency']>(rule?.frequency ?? 'weekly')
  const [days, setDays] = useState<number[]>(rule?.daysOfWeek.length ? rule.daysOfWeek : [1, 2, 3, 4, 5])
  const [dayOfMonth, setDayOfMonth] = useState(String(rule?.dayOfMonth ?? 1))
  const [timeOfDay, setTime] = useState(rule?.timeOfDay ?? '09:00')
  const [timezone, setTimezone] = useState(rule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
  const [ownerId, setOwnerId] = useState(rule ? String(rule.ownerId) : '')
  const [active, setActive] = useState(rule?.active ?? true)
  const toggleDay = (d: number) => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]))
  const label = 'block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const data: Record<string, unknown> = { name: name.trim(), templateId: Number(templateId), frequency, timeOfDay, timezone, active, daysOfWeek: frequency === 'weekly' ? days : [], dayOfMonth: frequency === 'monthly' ? Number(dayOfMonth) : null }
    if (ownerId) data.ownerId = Number(ownerId)
    save.mutate({ id: rule?.id, data }, { onSuccess: () => { toast(tr('Recurring issue saved'), 'success'); onClose() }, onError: (err) => toast(err.message, 'error') })
  }
  return (
    <Modal isOpen onClose={onClose} title={rule ? 'Edit recurring issue' : 'New recurring issue'} size="md">
      <form onSubmit={submit} className="space-y-4">
        <div><label htmlFor="rec-name" className={label}>{tr('Name')}</label><input id="rec-name" className="veqsio-input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus /></div>
        <div>
          <label htmlFor="rec-tpl" className={label}>{tr('Template')}</label>
          <select id="rec-tpl" className="veqsio-input w-full" value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            <option value="">{tr('Select a template')}</option>
            {(templates.data?.templates ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.scope === 'global' ? ' (global)' : ''}</option>)}
          </select>
          <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">{t('Each run creates an issue from this template. {date} style placeholders in its summary use the scheduled day.')}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label htmlFor="rec-freq" className={label}>{tr('Repeats')}</label>
            <select id="rec-freq" className="veqsio-input w-full" value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringRule['frequency'])}>
              <option value="daily">{tr('Every day')}</option><option value="weekly">{tr('Weekly, on selected days')}</option><option value="monthly">{tr('Monthly, on a day of the month')}</option>
            </select></div>
          <div><label htmlFor="rec-time" className={label}>{tr('Time')}</label><input id="rec-time" type="time" className="veqsio-input w-full" value={timeOfDay} onChange={(e) => setTime(e.target.value)} required /></div>
        </div>
        {frequency === 'weekly' && (
          <fieldset><legend className={label}>{tr('Days')}</legend>
            <div className="flex flex-wrap gap-2">{DAYS.map((d, i) => (
              <label key={d} className={`cursor-pointer rounded border px-2.5 py-1 text-[13px] ${days.includes(i + 1) ? 'border-[var(--brand-500)] bg-[var(--brand-50)] text-[var(--brand-700)]' : 'border-[var(--surface-4)]'}`}>
                <input type="checkbox" className="sr-only" checked={days.includes(i + 1)} onChange={() => toggleDay(i + 1)} />{d}
              </label>))}
            </div>
            <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">{tr('With no day selected the rule runs Monday to Friday.')}</p>
          </fieldset>
        )}
        {frequency === 'monthly' && (
          <div><label htmlFor="rec-dom" className={label}>{tr('Day of the month')}</label>
            <input id="rec-dom" type="number" min={1} max={31} className="veqsio-input w-28" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} required />
            <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">{tr('Shorter months use their last day (31 runs on 28 or 29 February).')}</p></div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label htmlFor="rec-tz" className={label}>{tr('Time zone')}</label>
            <input id="rec-tz" className="veqsio-input w-full" list="rec-tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
            <datalist id="rec-tz-list">{timezones().map((z) => <option key={z} value={z} />)}</datalist></div>
          <div><label htmlFor="rec-owner" className={label}>{tr('Owner (reporter)')}</label>
            <select id="rec-owner" className="veqsio-input w-full" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">{tr('Me')}</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></div>
        </div>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {tr('Active')}</label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
          <button type="submit" disabled={save.isPending || !name.trim() || !templateId} className="veqsio-btn-primary">{save.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{tr('Save')}</button>
        </div>
      </form>
    </Modal>
  )
}

function RunLog({ projectKey, rule, onClose }: { projectKey: string; rule: RecurringRule; onClose: () => void }) {
  const { tr } = useI18n();

  const runs = useRecurringRuns(projectKey, rule.id)
  return (
    <Modal isOpen onClose={onClose} title={`Run log: ${rule.name}`} size="md">
      {runs.isLoading ? <Spinner /> : runs.error ? <p role="alert" className="text-[13px] text-[var(--error)]">{runs.error.message}</p> : !runs.data?.runs.length ? (
        <p className="text-[13px] text-[var(--text-secondary)]">{tr('Nothing has run yet.')}</p>
      ) : (
        <table className="w-full text-[13px]">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]"><th className="py-1 pr-3">{tr('Scheduled for')}</th><th className="pr-3">{tr('Result')}</th><th>{tr('Details')}</th></tr></thead>
          <tbody>{runs.data.runs.map((r) => (
            <tr key={r.id} className="border-t border-[var(--surface-3)]">
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmt(r.slotAt)}</td>
              <td className="pr-3 capitalize">{r.status}</td>
              <td>{r.issueKey ? <Link className="text-[var(--brand-500)] hover:underline" href={`/issues/${r.issueKey}`}>{r.issueKey}</Link> : <span className="text-[var(--text-secondary)]">{r.error}</span>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

/** Project settings, tab "Recurring issues" (project administrators). */
export function RecurringPanel({ projectKey }: { projectKey: string }) {
  const { tr } = useI18n();

  const list = useRecurring(projectKey)
  const save = useSaveRecurring(projectKey)
  const del = useDeleteRecurring(projectKey)
  const [editing, setEditing] = useState<RecurringRule | 'new' | null>(null)
  const [log, setLog] = useState<RecurringRule | null>(null)

  if (list.isLoading) return <div className="py-8 flex justify-center"><Spinner /></div>
  if (list.error) return <p role="alert" className="text-[13px] text-[var(--error)]">{tr('Could not load recurring issues:')} {list.error.message}</p>
  const archived = list.data?.archived
  const rules = list.data?.rules ?? []
  return (
    <section aria-labelledby="rec-heading" className="space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="rec-heading" className="text-heading-3">{tr('Recurring issues')}</h2>
          <p className="text-body-sm text-[var(--text-secondary)] mt-1">{tr('Create an issue from a template on a schedule. Every scheduled day creates at most one issue, even after restarts. Rules pause while the project is archived.')}</p>
        </div>
        {!archived && <button onClick={() => setEditing('new')} className="veqsio-btn-primary"><Plus className="w-4 h-4" />{tr('New rule')}</button>}
      </div>
      {archived && <p role="status" className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[13px]">{tr('This project is archived, so no recurring issues are created.')}</p>}
      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--surface-4)] p-6 text-center text-[13px] text-[var(--text-secondary)]">{tr('No recurring issues yet. Create a template first, then a rule that uses it.')}</p>
      ) : (
        <ul className="rounded-lg border border-[var(--surface-3)] divide-y divide-[var(--surface-3)]">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold truncate">{r.name} {!r.active && <span className="ml-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">{tr('Paused')}</span>}</p>
                <p className="text-[12px] text-[var(--text-secondary)] truncate">{describeSchedule(r)} {tr('· template')} {r.templateName} {tr('· owner')} {r.ownerName}</p>
                <p className="text-[12px] text-[var(--text-tertiary)]">{tr('Last run')} {fmt(r.lastRunAt)} {tr('· Next run')} {r.active ? fmt(r.nextRunAt) : 'paused'}</p>
              </div>
              <div className="flex items-center gap-0.5">
                <label className="mr-1 flex items-center gap-1 text-[12px]"><input type="checkbox" checked={r.active} disabled={archived || save.isPending} onChange={(e) => save.mutate({ id: r.id, data: { active: e.target.checked } }, { onError: (err) => toast(err.message, 'error') })} aria-label={`Active: ${r.name}`} /> {tr('Active')}</label>
                <button className="veqsio-btn-ghost !p-1.5" aria-label={`Run log of ${r.name}`} onClick={() => setLog(r)}><History className="w-4 h-4" aria-hidden="true" /></button>
                {!archived && <button className="veqsio-btn-ghost !p-1.5" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Pencil className="w-4 h-4" aria-hidden="true" /></button>}
                {!archived && <button className="veqsio-btn-ghost !p-1.5" aria-label={`Delete ${r.name}`} onClick={async () => { if ((await confirmDialog(`Delete the recurring issue "${r.name}"? Issues it already created stay.`))) del.mutate(r.id, { onSuccess: () => toast(tr('Deleted'), 'success'), onError: (e) => toast(e.message, 'error') }) }}><Trash2 className="w-4 h-4" aria-hidden="true" /></button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleEditor projectKey={projectKey} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {log && <RunLog projectKey={projectKey} rule={log} onClose={() => setLog(null)} />}
    </section>
  )
}
