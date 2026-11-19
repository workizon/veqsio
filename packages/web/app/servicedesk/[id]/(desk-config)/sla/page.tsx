'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'
import {
  useDeleteSla, useDesks, useReorderSla, useSaveSla, useSlaCalendars, useSlaMetrics,
  type GoalCriteria, type SlaCalendar, type SlaMetric,
} from '@/hooks/use-servicedesk'
import { useDeskRequestTypes } from '@/hooks/use-servicedesk-email'
import { usePriorities, useStatuses } from '@/hooks/use-issues'
import { useIssueTypes } from '@/hooks/use-admin'
import {
  BLOCK_TEXT, CONDITION_OPTIONS, NEEDS_STATUSES, formatMinutes, parseDuration, validateConditions,
  type Block, type Condition, type ConditionEvent,
} from '@/lib/sla'
import { SortableTh } from '@/components/sortable-th'
import { useTextSort } from '@/lib/table-sort'
import { confirmDialog } from '@/components/dialogs'

interface Option { id: number; name: string }

interface GoalDraft { key: number; criteria: GoalCriteria; jql: string; duration: string; calendarId: number | null }
interface Draft {
  id?: number
  name: string
  metric: string
  calendarId: number | null
  warning: string
  start: Condition[]; pause: Condition[]; stop: Condition[]
  goals: GoalDraft[]
  defaultGoal: { duration: string; calendarId: number | null }
}

let keySeq = 1
const isDefaultGoal = (g: { criteria: GoalCriteria; jql?: string | null; priorityId?: number | null }) =>
  !g.priorityId && !g.jql && !g.criteria?.priorityIds?.length && !g.criteria?.issueTypeIds?.length && !g.criteria?.requestTypeIds?.length

function toDraft(s: SlaMetric): Draft {
  const goals = [...s.goals]
  // the last goal without any criteria is the "All remaining issues" goal
  let di = -1
  goals.forEach((g, i) => { if (isDefaultGoal(g)) di = i })
  const def = di >= 0 ? goals.splice(di, 1)[0] : null
  return {
    id: s.id, name: s.name, metric: s.metric, calendarId: s.calendarId, warning: s.warningPercent ? String(s.warningPercent) : '',
    start: structuredClone(s.effectiveConditions.start), pause: structuredClone(s.effectiveConditions.pause), stop: structuredClone(s.effectiveConditions.stop),
    goals: goals.map((g) => ({
      key: keySeq++,
      criteria: { ...g.criteria, ...(g.priorityId && !g.criteria?.priorityIds?.length ? { priorityIds: [g.priorityId] } : {}) },
      jql: g.jql ?? '', duration: formatMinutes(g.targetMinutes), calendarId: g.calendarId ?? null,
    })),
    defaultGoal: { duration: def ? formatMinutes(def.targetMinutes) : '8h', calendarId: def?.calendarId ?? null },
  }
}

const newDraft = (calendarId: number | null): Draft => ({
  name: '', metric: 'custom', calendarId, warning: '',
  start: [{ event: 'issue_created' }], pause: [], stop: [{ event: 'resolution_set' }],
  goals: [], defaultGoal: { duration: '8h', calendarId: null },
})

const PRESETS: Array<{ label: string; build: (d: Draft) => Draft }> = [
  { label: 'Time to first response', build: (d) => ({ ...d, name: 'Time to first response', metric: 'first_response', stop: [{ event: 'comment_agent' }, { event: 'resolution_set' }], defaultGoal: { duration: '4h', calendarId: null } }) },
  { label: 'Time to resolution', build: (d) => ({ ...d, name: 'Time to resolution', metric: 'resolution', stop: [{ event: 'resolution_set' }], pause: [{ event: 'waiting_for_customer' }], defaultGoal: { duration: '24h', calendarId: null } }) },
  { label: 'Time to close after resolution', build: (d) => ({ ...d, name: 'Time to close after resolution', metric: 'custom', start: [{ event: 'resolution_set', restart: true }], stop: [{ event: 'resolution_cleared' }], defaultGoal: { duration: '72h', calendarId: null } }) },
]

export default function SlaPage() {
  const nameSort = useTextSort()
  const id = Number(useParams<{ id: string }>().id)
  const desks = useDesks()
  const slas = useSlaMetrics(id)
  const cals = useSlaCalendars(id)
  const save = useSaveSla(id)
  const del = useDeleteSla(id)
  const reorder = useReorderSla(id)
  const statuses = useStatuses()
  const priorities = usePriorities()
  const issueTypes = useIssueTypes()
  const requestTypes = useDeskRequestTypes(id)
  const isAdmin = desks.data?.values.find((d) => d.id === id)?.role === 'admin'

  const [draft, setDraft] = useState<Draft | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const calendars = cals.data?.values ?? []
  const calName = (cid: number | null, fallback: string) => calendars.find((c) => c.id === cid)?.name ?? fallback

  const statusOpts: Option[] = (statuses.data ?? []).map((s) => ({ id: Number(s.id), name: s.name }))
  const priorityOpts: Option[] = (priorities.data ?? []).map((p) => ({ id: Number(p.id), name: p.name }))
  const typeOpts: Option[] = (issueTypes.data ?? []).map((t) => ({ id: Number(t.id), name: t.name }))
  const reqOpts: Option[] = (requestTypes.data?.values ?? []).map((r) => ({ id: r.id, name: r.name }))

  const move = (idx: number, dir: -1 | 1) => {
    const ids = (slas.data?.values ?? []).map((s) => s.id)
    const j = idx + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
    reorder.mutate(ids)
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="text-heading-1 text-[var(--text-primary)]">SLAs</h1>
          <div className="flex gap-2">
            <Link href={`/servicedesk/${id}/calendars`} className="veqsio-btn-secondary">Calendars</Link>
            <Link href={`/servicedesk/${id}`} className="veqsio-btn-secondary">Back to service desk</Link>
          </div>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          An SLA measures how long an event takes. Choose when the clock starts, pauses and stops, then set time goals for the issues it applies to.
        </p>

        {slas.isLoading && <Spinner />}
        {slas.error && <div role="alert" className="text-[var(--error)]">{slas.error.message}</div>}

        {!draft && (() => {
          const list = slas.data?.values ?? []
          const current = list.find((x) => x.id === selectedId) ?? list[0] ?? null
          const idx = current ? list.findIndex((x) => x.id === current.id) : -1
          const names = (ids: number[] | undefined, opts: Option[]) => (ids ?? []).map((i) => opts.find((o) => o.id === i)?.name ?? `#${i}`)
          const criteria = (g: SlaMetric['goals'][number]) => {
            const parts = [
              g.criteria?.issueTypeIds?.length ? `issuetype in (${names(g.criteria.issueTypeIds, typeOpts).join(', ')})` : '',
              g.criteria?.requestTypeIds?.length ? `request type in (${names(g.criteria.requestTypeIds, reqOpts).join(', ')})` : '',
              g.criteria?.priorityIds?.length ? `priority in (${names(g.criteria.priorityIds, priorityOpts).join(', ')})` : g.priorityId ? `priority = ${names([g.priorityId], priorityOpts)[0]}` : '',
              g.jql ?? '',
            ].filter(Boolean)
            return parts.length ? parts.join(' AND ') : null
          }
          const box = 'rounded border border-[var(--surface-3)] bg-[var(--surface-1)] px-3 py-1.5 text-sm'
          const condColumn = (title: string, hint: string, block: Block, conds: Condition[], optional = false) => (
            <div className="min-w-0">
              <p className="font-semibold text-[var(--text-primary)]">{title}{optional && <span className="font-normal text-[var(--text-secondary)]"> (optional)</span>}</p>
              <p className="mt-1 mb-2 text-sm text-[var(--text-secondary)]">{hint}</p>
              <div className="space-y-2">
                {conds.length === 0 ? <div className="rounded border border-dashed border-[var(--surface-4)] px-3 py-1.5 text-sm text-[var(--text-tertiary)]">&nbsp;</div> : conds.map((c, i) => <div key={i} className={box}>{condText(block, c, statusOpts)}</div>)}
              </div>
            </div>
          )
          return (
            <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
              <nav aria-label="SLAs" className="space-y-1">
                <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">SLAs</p>
                {list.length === 0 && <p className="px-3 py-2 text-sm text-[var(--text-tertiary)]">No SLAs yet</p>}
                {list.map((x) => (
                  <button key={x.id} type="button" aria-current={current?.id === x.id ? 'true' : undefined} onClick={() => setSelectedId(x.id)}
                    className={`block w-full truncate rounded-md px-3 py-2 text-left text-sm ${current?.id === x.id ? 'bg-[var(--brand-50)] font-medium text-[var(--brand-700)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'}`} title={x.name}>{x.name}</button>
                ))}
                {isAdmin && (
                  <div className="mt-2 border-t border-[var(--surface-3)] pt-2">
                    <button type="button" className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)]" onClick={() => setDraft(newDraft(calendars.find((c) => c.builtIn)?.id ?? null))}><span aria-hidden="true">+</span>Create SLA</button>
                  </div>
                )}
              </nav>

              {current && (
                <section aria-label={current.name} className="min-w-0 space-y-8">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h2 className="text-heading-1 text-[var(--text-primary)]">{current.name}</h2>
                    {isAdmin && (
                      <div className="flex flex-wrap gap-2">
                        <button className="veqsio-btn-secondary text-sm" aria-label={`Move ${current.name} up`} disabled={idx <= 0 || reorder.isPending} onClick={() => move(idx, -1)}>Move up</button>
                        <button className="veqsio-btn-secondary text-sm" aria-label={`Move ${current.name} down`} disabled={idx === list.length - 1 || reorder.isPending} onClick={() => move(idx, 1)}>Move down</button>
                        <button className="veqsio-btn-secondary text-sm" disabled={del.isPending} onClick={async () => { if ((await confirmDialog(`Delete SLA "${current.name}"?`))) del.mutate(current.id) }}>Delete</button>
                        <button className="veqsio-btn-primary text-sm" onClick={() => setDraft(toDraft(current))}>Edit SLA</button>
                      </div>
                    )}
                  </div>

                  <div>
                    <h3 className="font-semibold text-[var(--text-primary)]">Time metric</h3>
                    <p className="mt-1 mb-4 text-sm text-[var(--text-secondary)]">Time is measured between the <strong>Start</strong> and <strong>Stop</strong> conditions below{current.warningPercent ? `; a warning is raised at ${current.warningPercent}% of the goal` : ''}.</p>
                    <div className="grid items-start gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
                      {condColumn('Start', 'Begin counting time when', 'start', current.effectiveConditions.start)}
                      <span className="hidden pt-1 text-[var(--text-tertiary)] md:block" aria-hidden="true">→</span>
                      {condColumn('Pause on', 'Time is not counted during', 'pause', current.effectiveConditions.pause, true)}
                      <span className="hidden pt-1 text-[var(--text-tertiary)] md:block" aria-hidden="true">→</span>
                      {condColumn('Stop', 'Finish counting time when', 'stop', current.effectiveConditions.stop)}
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-[var(--text-primary)]">Goals</h3>
                    <p className="mt-1 mb-3 text-sm text-[var(--text-secondary)]">Issues are checked against this list from top to bottom and get the time target of the first matching row.</p>
                    <div className="overflow-x-auto rounded-lg border border-[var(--surface-3)]">
                      <table className="w-full text-sm">
                        <caption className="sr-only">Goals of {current.name}</caption>
                        <thead><tr className="veqsio-table-header text-left"><th scope="col">Issues</th><th scope="col" className="w-28">Goal</th><th scope="col" className="w-64">Calendar</th></tr></thead>
                        <tbody>
                          {current.goals.map((g, i) => {
                            const c = criteria(g)
                            return (
                              <tr key={i} className="veqsio-table-row">
                                <td className="px-4 py-2 font-mono text-[13px]">{c ?? <span className="font-sans text-[var(--text-secondary)]">All remaining issues</span>}</td>
                                <td className="px-4 py-2 tabular-nums">{formatMinutes(g.targetMinutes)}</td>
                                <td className="px-4 py-2">{calName(g.calendarId ?? current.calendarId, current.calendar === 'business' ? 'Business hours' : '24/7')}</td>
                              </tr>
                            )
                          })}
                          {current.goals.length === 0 && <tr><td colSpan={3} className="px-4 py-4 text-[var(--text-tertiary)]">No goals yet. Edit the SLA to add one.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {(reorder.error || del.error) && <div role="alert" className="text-[var(--error)]">{((reorder.error || del.error) as Error).message}</div>}
                </section>
              )}
            </div>
          )
        })()}

        {draft && isAdmin && (
          <SlaEditor
            draft={draft} setDraft={setDraft} calendars={calendars}
            statusOpts={statusOpts} priorityOpts={priorityOpts} typeOpts={typeOpts} reqOpts={reqOpts}
            saving={save.isPending} error={(save.error as Error | null)?.message}
            onCancel={() => { save.reset(); setDraft(null) }}
            onSave={(body) => save.mutate({ id: draft.id, ...body }, { onSuccess: () => setDraft(null) })}
          />
        )}
      </div>
    </>
  )
}

function condText(block: Block, c: Condition, statuses: Option[]): string {
  const label = CONDITION_OPTIONS[block].find((o) => o.event === c.event)?.label ?? c.event
  if (!c.statusIds?.length) return label
  return `${label} ${c.statusIds.map((sid) => statuses.find((s) => s.id === sid)?.name ?? sid).join(', ')}`
}

function SlaEditor(props: {
  draft: Draft
  setDraft: (d: Draft) => void
  calendars: SlaCalendar[]
  statusOpts: Option[]; priorityOpts: Option[]; typeOpts: Option[]; reqOpts: Option[]
  saving: boolean
  error?: string
  onCancel: () => void
  onSave: (body: import('@/hooks/use-servicedesk').SlaMetricInput) => void
}) {
  const { draft, setDraft, calendars } = props
  const patch = (p: Partial<Draft>) => setDraft({ ...draft, ...p })
  const calOptions = calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)

  const errors: string[] = []
  if (!draft.name.trim()) errors.push('Name is required')
  errors.push(...validateConditions('start', draft.start), ...validateConditions('pause', draft.pause), ...validateConditions('stop', draft.stop))
  const warn = draft.warning.trim() === '' ? null : Number(draft.warning)
  if (warn !== null && (!Number.isInteger(warn) || warn < 1 || warn > 99)) errors.push('Warning threshold must be a whole number from 1 to 99')
  draft.goals.forEach((g, i) => { if (parseDuration(g.duration) == null) errors.push(`Goal ${i + 1}: enter a duration such as 4h 30m`) })
  if (parseDuration(draft.defaultGoal.duration) == null) errors.push('All remaining issues: enter a duration such as 4h 30m')

  const submit = () => {
    if (errors.length) return
    props.onSave({
      name: draft.name.trim(), metric: draft.metric, calendarId: draft.calendarId, warningPercent: warn,
      startConditions: draft.start, pauseConditions: draft.pause, stopConditions: draft.stop,
      goals: [
        ...draft.goals.map((g) => ({
          criteria: Object.fromEntries(Object.entries(g.criteria).filter(([, v]) => (v as number[]).length)) as GoalCriteria,
          jql: g.jql.trim() || null, targetMinutes: parseDuration(g.duration)!, calendarId: g.calendarId,
        })),
        { criteria: {}, jql: null, targetMinutes: parseDuration(draft.defaultGoal.duration)!, calendarId: draft.defaultGoal.calendarId },
      ],
    })
  }

  const moveGoal = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= draft.goals.length) return
    const goals = [...draft.goals]
    ;[goals[i], goals[j]] = [goals[j], goals[i]]
    patch({ goals })
  }
  const setGoal = (i: number, p: Partial<GoalDraft>) => patch({ goals: draft.goals.map((g, j) => (j === i ? { ...g, ...p } : g)) })

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="veqsio-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-heading-2">{draft.id ? 'Edit SLA' : 'Create SLA'}</h2>
          {!draft.id && (
            <div className="flex gap-1 flex-wrap items-center text-sm">
              <span className="text-[var(--text-tertiary)]">Start from</span>
              {PRESETS.map((p) => <button key={p.label} type="button" className="veqsio-btn-ghost" onClick={() => setDraft(p.build(draft))}>{p.label}</button>)}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <label htmlFor="sla-name" className="text-sm">Name</label>
            <input id="sla-name" className="veqsio-input w-full" maxLength={255} required value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Time to first response" />
          </div>
          <div className="space-y-1">
            <label htmlFor="sla-cal" className="text-sm">Default calendar</label>
            <select id="sla-cal" className="veqsio-input w-full" value={draft.calendarId ?? ''} onChange={(e) => patch({ calendarId: e.target.value ? Number(e.target.value) : null })}>
              {draft.calendarId == null && <option value="">Legacy (desk business hours)</option>}
              {calOptions}
            </select>
          </div>
        </div>
        <div className="space-y-1 max-w-xs">
          <label htmlFor="sla-warn" className="text-sm">Warn at % of goal (optional)</label>
          <input id="sla-warn" inputMode="numeric" className="veqsio-input w-24" value={draft.warning} onChange={(e) => patch({ warning: e.target.value })} placeholder="80" />
          <p className="text-xs text-[var(--text-tertiary)]">Shows a near-breach state when this share of the goal is used.</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {(['start', 'pause', 'stop'] as Block[]).map((b) => (
          <ConditionBlock key={b} block={b} list={draft[b]} onChange={(l) => patch({ [b]: l } as Partial<Draft>)} statuses={props.statusOpts} />
        ))}
      </div>

      <div className="veqsio-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-heading-3">Goals</h2>
            <p className="text-xs text-[var(--text-tertiary)]">The first goal whose criteria match an issue is used. Order matters.</p>
          </div>
          <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => patch({ goals: [...draft.goals, { key: keySeq++, criteria: {}, jql: '', duration: '4h', calendarId: null }] })}>Add goal</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="veqsio-table-header text-left">
                <th className="px-2 py-2 w-8">#</th><th className="px-2 py-2">Issues matching</th><th className="px-2 py-2 w-28">Goal</th>
                <th className="px-2 py-2 w-44">Calendar</th><th className="px-2 py-2 w-24" />
              </tr>
            </thead>
            <tbody>
              {draft.goals.map((g, i) => (
                <tr key={g.key} className="align-top border-t border-[var(--surface-3)]">
                  <td className="px-2 py-2 text-[var(--text-tertiary)]">{i + 1}</td>
                  <td className="px-2 py-2 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <MultiPick label="Priority" options={props.priorityOpts} value={g.criteria.priorityIds ?? []} onChange={(v) => setGoal(i, { criteria: { ...g.criteria, priorityIds: v } })} />
                      <MultiPick label="Issue type" options={props.typeOpts} value={g.criteria.issueTypeIds ?? []} onChange={(v) => setGoal(i, { criteria: { ...g.criteria, issueTypeIds: v } })} />
                      <MultiPick label="Request type" options={props.reqOpts} value={g.criteria.requestTypeIds ?? []} onChange={(v) => setGoal(i, { criteria: { ...g.criteria, requestTypeIds: v } })} />
                    </div>
                    <input
                      aria-label={`Goal ${i + 1} JQL filter`} className="veqsio-input w-full font-mono text-xs" value={g.jql}
                      onChange={(e) => setGoal(i, { jql: e.target.value })} placeholder='Optional JQL filter, e.g. labels = vip AND component = "Network"'
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input aria-label={`Goal ${i + 1} duration`} className="veqsio-input w-24" value={g.duration} onChange={(e) => setGoal(i, { duration: e.target.value })} aria-invalid={parseDuration(g.duration) == null} />
                  </td>
                  <td className="px-2 py-2">
                    <select aria-label={`Goal ${i + 1} calendar`} className="veqsio-input w-full" value={g.calendarId ?? ''} onChange={(e) => setGoal(i, { calendarId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">SLA default</option>{calOptions}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1">
                      <button type="button" className="veqsio-btn-ghost" aria-label={`Move goal ${i + 1} up`} disabled={i === 0} onClick={() => moveGoal(i, -1)}>Up</button>
                      <button type="button" className="veqsio-btn-ghost" aria-label={`Move goal ${i + 1} down`} disabled={i === draft.goals.length - 1} onClick={() => moveGoal(i, 1)}>Down</button>
                      <button type="button" className="veqsio-btn-ghost" aria-label={`Delete goal ${i + 1}`} onClick={() => patch({ goals: draft.goals.filter((_, j) => j !== i) })}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="align-top border-t border-[var(--surface-3)] bg-[var(--surface-2)]">
                <td className="px-2 py-2 text-[var(--text-tertiary)]">{draft.goals.length + 1}</td>
                <td className="px-2 py-2 font-medium text-[var(--text-primary)]">All remaining issues</td>
                <td className="px-2 py-2">
                  <input aria-label="All remaining issues duration" className="veqsio-input w-24" value={draft.defaultGoal.duration}
                    onChange={(e) => patch({ defaultGoal: { ...draft.defaultGoal, duration: e.target.value } })} aria-invalid={parseDuration(draft.defaultGoal.duration) == null} />
                </td>
                <td className="px-2 py-2">
                  <select aria-label="All remaining issues calendar" className="veqsio-input w-full" value={draft.defaultGoal.calendarId ?? ''}
                    onChange={(e) => patch({ defaultGoal: { ...draft.defaultGoal, calendarId: e.target.value ? Number(e.target.value) : null } })}>
                    <option value="">SLA default</option>{calOptions}
                  </select>
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--text-tertiary)]">Durations: 4h 30m, 90m, 1d (24h). The default goal applies to every issue no earlier goal matched.</p>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="text-sm text-[var(--error)] list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      {props.error && <div role="alert" className="text-[var(--error)]">{props.error}</div>}
      <div className="flex gap-2">
        <button type="submit" className="veqsio-btn-primary" disabled={props.saving || errors.length > 0}>{draft.id ? 'Save' : 'Create'}</button>
        <button type="button" className="veqsio-btn-secondary" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function ConditionBlock({ block, list, onChange, statuses }: { block: Block; list: Condition[]; onChange: (l: Condition[]) => void; statuses: Option[] }) {
  const { title, hint } = BLOCK_TEXT[block]
  const options = CONDITION_OPTIONS[block]
  const set = (i: number, p: Partial<Condition>) => onChange(list.map((c, j) => (j === i ? { ...c, ...p } : c)))
  return (
    <fieldset className="veqsio-card p-3 space-y-2 min-w-0">
      <legend className="sr-only">{title}</legend>
      <h3 className="text-heading-3">{title}</h3>
      <p className="text-xs text-[var(--text-tertiary)]">{hint}</p>
      {list.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">{block === 'pause' ? 'The clock never pauses' : 'No conditions'}</p>}
      <ul className="space-y-2">
        {list.map((c, i) => (
          <li key={i} className="rounded border border-[var(--surface-3)] p-2 space-y-2">
            <div className="flex gap-1">
              <select
                aria-label={`${title} condition ${i + 1}`} className="veqsio-input flex-1 min-w-0" value={c.event}
                onChange={(e) => {
                  const event = e.target.value as ConditionEvent
                  set(i, { event, statusIds: NEEDS_STATUSES.includes(event) ? c.statusIds ?? [] : undefined, restart: block === 'start' ? c.restart : undefined })
                }}
              >
                {options.map((o) => <option key={o.event} value={o.event}>{o.label}</option>)}
              </select>
              <button type="button" className="veqsio-btn-ghost" aria-label={`Remove ${title} condition ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))}>Remove</button>
            </div>
            {NEEDS_STATUSES.includes(c.event) && (
              <MultiPick label="Statuses" options={statuses} value={c.statusIds ?? []} onChange={(v) => set(i, { statusIds: v })} />
            )}
            {block === 'start' && (
              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <input type="checkbox" checked={!!c.restart} onChange={(e) => set(i, { restart: e.target.checked || undefined })} />
                Restart the clock every time this happens again
              </label>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="veqsio-btn-ghost text-sm" onClick={() => onChange([...list, { event: options[0].event }])}>Add condition</button>
    </fieldset>
  )
}

/** Compact multi-select: a summary button that opens a checklist. */
function MultiPick({ label, options, value, onChange }: { label: string; options: Option[]; value: number[]; onChange: (v: number[]) => void }) {
  const names = value.map((v) => options.find((o) => o.id === v)?.name ?? String(v))
  return (
    <details className="relative">
      <summary className="veqsio-input cursor-pointer list-none text-sm select-none max-w-[16rem] truncate" aria-label={`${label}: ${names.length ? names.join(', ') : 'any'}`}>
        <span className="text-[var(--text-tertiary)]">{label}: </span>{names.length ? names.join(', ') : 'any'}
      </summary>
      <div className="absolute z-20 mt-1 max-h-56 overflow-auto veqsio-card p-2 min-w-[12rem] space-y-1 shadow-lg">
        {options.length === 0 && <div className="text-xs text-[var(--text-tertiary)] px-1">Nothing to choose</div>}
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm px-1 cursor-pointer">
            <input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />
            {o.name}
          </label>
        ))}
        {value.length > 0 && <button type="button" className="veqsio-btn-ghost text-xs" onClick={() => onChange([])}>Clear</button>}
      </div>
    </details>
  )
}
