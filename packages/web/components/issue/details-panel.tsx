'use client'


import { useI18n } from '@/hooks/use-i18n'
import { AgentBadge } from '@/components/agent-badge'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, ThumbsUp, X, Eye } from 'lucide-react'
import { Avatar } from '@/components/avatar'
import { DevelopmentPanel } from '@/components/development-panel'
import { SlaBadge } from '@/components/sla-badge'
import { Skeleton } from '@/components/skeleton'
import { toast } from '@/components/toast'
import { useUndoableAction } from '@/hooks/use-undoable'
import { assigneeRestorePatch } from '@/lib/undo-helpers'
import {
  useIssueVotes, useIssueWatchers, useMyself, usePriorities, useProjectComponents, useProjectVersions,
  useToggleVote, useToggleWatch, useUpdateIssue, useUserSearch,
} from '@/hooks/use-issues'
import type { ApiIssue, OptimisticLookup } from '@/hooks/use-issues'
import { useRequestMeta } from '@/hooks/use-servicedesk'
import { RequestActions } from './request-actions'
import { CollapsibleSection, FieldRow, InlineValueButton, Lozenge, Popover, RelativeTime } from './primitives'
import { TimeTrackingSection } from './time-tracking'
import { SecurityRow } from './security-field'
import { CustomFieldsSection } from './custom-fields-section'

export interface DetailsHandle {
  openAssignee: () => void
  openLabels: () => void
}

const PICKER = 'w-[min(18rem,calc(100vw-2rem))]'
const optionClass = 'w-full flex items-center gap-2 px-3 py-2 text-left text-body-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none'
function Muted() {
  const { tr } = useI18n()
  return <span className="text-[var(--text-tertiary)]">{tr('None')}</span>
}

export const DetailsPanel = forwardRef<DetailsHandle, { issue: ApiIssue }>(function DetailsPanel({ issue }, ref) {
  const { tr } = useI18n();

  const { fields } = issue
  const key = issue.key
  const projectKey = fields.project?.key || ''
  const update = useUpdateIssue()
  const { data: myself } = useMyself()
  const requestMeta = useRequestMeta(key)

  const [assigneeOpen, setAssigneeOpen] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  useImperativeHandle(ref, () => ({ openAssignee: () => setAssigneeOpen(true), openLabels: () => setLabelsOpen(true) }), [])

  const undoableAction = useUndoableAction()
  /** Saves a field; with `undo` (the previous value) the change gets an Undo toast (9 s, Ctrl/Cmd+Z). */
  const save = async (
    patch: Record<string, unknown>,
    lookup?: OptimisticLookup,
    undo?: { message: string; patch: Record<string, unknown>; lookup?: OptimisticLookup },
  ) => {
    try {
      await update.mutateAsync({ key, fields: patch, lookup })
      if (undo) undoableAction({ message: undo.message, undo: () => update.mutateAsync({ key, fields: undo.patch, lookup: undo.lookup }).then(() => undefined) })
    } catch (err: any) {
      toast(err?.message || tr('Failed to update issue'), 'error')
    }
  }

  const assignToMe = () => {
    if (!myself) return
    void save({ assignee: { id: myself.id } }, { users: [{ id: myself.id, displayName: myself.displayName || myself.name }] }, assigneeUndo(tr('Assigned to you')))
  }
  const assigneeUndo = (message: string) => ({
    message,
    patch: assigneeRestorePatch(fields.assignee) as Record<string, unknown>,
    lookup: fields.assignee ? { users: [{ id: fields.assignee.id, displayName: fields.assignee.displayName }] } : undefined,
  })
  const assignedToMe = !!myself && fields.assignee?.id === myself.id

  return (
    <aside aria-label={tr('Issue details')} className="space-y-3">
      <CollapsibleSection id="details" title={tr('Details')}>
        <FieldRow label={tr('Assignee')} htmlFor="field-assignee">
          <AssigneeField
            open={assigneeOpen}
            onOpenChange={setAssigneeOpen}
            assignee={fields.assignee}
            myself={myself ? { id: myself.id, displayName: myself.displayName || myself.name } : undefined}
            onPick={(u) => {
              setAssigneeOpen(false)
              void save({ assignee: u ? { id: u.id } : null }, u ? { users: [u] } : undefined, assigneeUndo(u ? tr('Assigned to {name}', { name: u.displayName }) : tr('Assignee removed')))
            }}
          />
          {!assignedToMe && myself && (
            <button type="button" onClick={assignToMe} className="text-caption text-[var(--brand-500)] hover:underline ml-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
              {tr('Assign to me')} </button>
          )}
        </FieldRow>

        <FieldRow label={tr('Reporter')}>
          <span className="flex items-center gap-2 py-1">
            <Avatar name={fields.reporter?.displayName || tr('Unknown')} size="sm" />
            <span className="truncate">{fields.reporter?.displayName || tr('Unknown')}</span>
          </span>
        </FieldRow>

        <FieldRow label={tr('Labels')} htmlFor="field-labels">
          <LabelsField open={labelsOpen} onOpenChange={setLabelsOpen} labels={fields.labels || []} onChange={(labels) => void save({ labels }, undefined, { message: tr('Labels updated'), patch: { labels: fields.labels || [] } })} />
        </FieldRow>

        <FieldRow label={tr('Priority')} htmlFor="field-priority">
          <PriorityField priority={fields.priority} onPick={(p) => void save({ priority: { id: p.id } }, { priorities: [p] }, fields.priority ? { message: tr('Priority set to {name}', { name: p.name }), patch: { priority: { id: fields.priority.id } }, lookup: { priorities: [fields.priority] } } : undefined)} />
        </FieldRow>

        {fields.resolution && (
          <FieldRow label={tr('Resolution')}><span className="py-1 inline-block">{fields.resolution.name}</span></FieldRow>
        )}

        <SecurityRow projectKey={projectKey} level={fields.security} onChange={(security) => void save({ security })} />

        <FieldRow label={tr('Parent')} htmlFor="field-parent">
          <ParentField issue={issue} onSave={(id) => void save({ parent: id === null ? null : { id } })} />
        </FieldRow>

        <FieldRow label={tr('Sprint')}>
          <span className="py-1 inline-block">
            {fields.sprint ? (
              <span className="flex items-center gap-1.5">
                {fields.sprint.name}
                {fields.sprint.state && <Lozenge tone={fields.sprint.state === 'active' ? 'brand' : 'neutral'}>{fields.sprint.state}</Lozenge>}
              </span>
            ) : <Muted />}
          </span>
        </FieldRow>

        <FieldRow label={tr('Fix versions')} htmlFor="field-fixversions">
          <VersionsField
            id="field-fixversions"
            label={tr('Fix versions')}
            projectKey={projectKey}
            selected={fields.fixVersions || []}
            onChange={(ids, all) => void save({ fixVersions: ids }, { versions: all })}
          />
        </FieldRow>

        <FieldRow label={tr('Affects versions')} htmlFor="field-versions">
          <VersionsField
            id="field-versions"
            label={tr('Affects versions')}
            projectKey={projectKey}
            selected={fields.versions || []}
            onChange={(ids, all) => void save({ versions: ids }, { versions: all })}
          />
        </FieldRow>

        <FieldRow label={tr('Components')} htmlFor="field-components">
          <ComponentsField projectKey={projectKey} selected={fields.components || []} onChange={(ids, all) => void save({ components: ids }, { components: all })} />
        </FieldRow>

        <FieldRow label={tr('Due date')} htmlFor="field-duedate">
          <DueDateField value={fields.duedate} onChange={(v) => void save({ duedate: v })} />
        </FieldRow>
      </CollapsibleSection>

      <PeopleSection issueKey={key} />

      <CustomFieldsSection issue={issue} />
      <CollapsibleSection id="dates" title={tr('Dates')}>
        <FieldRow label={tr('Created')}><RelativeTime date={fields.created} className="py-1 inline-block" /></FieldRow>
        <FieldRow label={tr('Updated')}><RelativeTime date={fields.updated} className="py-1 inline-block" /></FieldRow>
        {fields.resolved && <FieldRow label={tr('Resolved')}><RelativeTime date={fields.resolved} className="py-1 inline-block" /></FieldRow>}
      </CollapsibleSection>

      <TimeTrackingSection issue={issue} onSaveEstimate={(seconds) => void save({ timeestimate: seconds })} />

      {requestMeta.data?.isRequest && requestMeta.data.staff && (
        <CollapsibleSection id="customer-request" title={tr('Customer request')}>
          <RequestActions issueKey={key} meta={requestMeta.data} />
        </CollapsibleSection>
      )}

      {requestMeta.data?.isRequest && requestMeta.data.staff && (
        <CollapsibleSection id="sla" title={tr('SLA')}>
          {requestMeta.data.sla && requestMeta.data.sla.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 py-1">{requestMeta.data.sla.map((x) => <SlaBadge key={x.slaId} sla={x} />)}</div>
          ) : (
            <p className="text-body-sm text-[var(--text-tertiary)] py-1">{tr('No SLA applies to this request.')}</p>
          )}
        </CollapsibleSection>
      )}

      <CollapsibleSection id="development" title={tr('Development')} defaultOpen={false}>
        <DevelopmentPanel issueKey={key} />
      </CollapsibleSection>
    </aside>
  )
})

/* ------------------------------------------------------------------ */
/*  People                                                             */
/* ------------------------------------------------------------------ */

function PeopleSection({ issueKey }: { issueKey: string }) {
  const { tr } = useI18n();

  const { data: watchers, isLoading: watchersLoading } = useIssueWatchers(issueKey)
  const { data: votes, isLoading: votesLoading } = useIssueVotes(issueKey)
  const toggleWatch = useToggleWatch()
  const toggleVote = useToggleVote()
  const watching = !!watchers?.isWatching
  return (
    <CollapsibleSection id="people" title={tr('People')}>
      <FieldRow label={tr('Watchers')}>
        {watchersLoading ? <Skeleton className="h-5 w-24 mt-1" /> : (
          <div className="py-1 space-y-1">
            {(watchers?.watchers || []).length === 0 ? <span className="text-[var(--text-tertiary)]">{tr('No watchers')}</span> : (
              <ul className="space-y-1">
                {(watchers?.watchers || []).map((w) => (
                  <li key={w.id} className="flex items-center gap-2"><Avatar name={w.displayName || tr('Unknown')} size="sm" /><span className="truncate">{w.displayName}</span></li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => toggleWatch.mutate({ key: issueKey, watching: !watching })}
              disabled={toggleWatch.isPending}
              className="flex items-center gap-1 text-caption text-[var(--brand-500)] hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
            >
              <Eye className="w-3.5 h-3.5" aria-hidden="true" /> {watching ? tr('Stop watching') : tr('Start watching')}
              <span className="text-[var(--text-tertiary)]">({watchers?.watchCount ?? 0})</span>
            </button>
          </div>
        )}
      </FieldRow>
      <FieldRow label={tr('Votes')}>
        {votesLoading ? <Skeleton className="h-5 w-24 mt-1" /> : (
          <div className="py-1">
            <button
              type="button"
              onClick={() => toggleVote.mutate({ key: issueKey, voting: !votes?.hasVoted })}
              disabled={toggleVote.isPending}
              aria-pressed={!!votes?.hasVoted}
              className={`flex items-center gap-1.5 text-body-sm rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] ${votes?.hasVoted ? 'text-[var(--brand-500)]' : 'text-[var(--text-primary)] hover:text-[var(--brand-500)]'}`}
            >
              <ThumbsUp className="w-3.5 h-3.5" aria-hidden="true" />
              {votes?.votes ?? 0} {votes?.hasVoted ? tr('(you voted)') : ''}
            </button>
          </div>
        )}
      </FieldRow>
    </CollapsibleSection>
  )
}

/* ------------------------------------------------------------------ */
/*  Field editors                                                      */
/* ------------------------------------------------------------------ */

export function AssigneeField({
  open, onOpenChange, assignee, myself, onPick, id = 'field-assignee',
}: {
  id?: string
  open: boolean
  onOpenChange: (o: boolean) => void
  assignee: ApiIssue['fields']['assignee']
  myself?: { id: number; displayName: string }
  onPick: (u: { id: number; displayName: string } | null) => void
}) {
  const { tr } = useI18n();

  const [search, setSearch] = useState('')
  const { data: results, isFetching } = useUserSearch(search)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => { onOpenChange(o); if (o) setSearch('') }}
      label={tr('Assign issue')}
      align="right"
      panelClassName={`${PICKER} py-2`}
      trigger={(p) => (
        <InlineValueButton id={id} {...p} aria-label={tr('Assignee: {name}. Change assignee', { name: assignee?.displayName || tr('Unassigned') })}>
          {assignee ? (
            <span className="flex items-center gap-2"><Avatar name={assignee.displayName} size="sm" /><span className="truncate">{assignee.displayName}</span>{assignee.isAgent && <AgentBadge />}</span>
          ) : (
            <span className="text-[var(--text-tertiary)]">{tr('Unassigned')}</span>
          )}
        </InlineValueButton>
      )}
    >
      <div className="px-3 pb-2">
        <label htmlFor={`${id}-search`} className="sr-only">{tr('Search users')}</label>
        <input id={`${id}-search`} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('Search users...')} className="veqsio-input w-full text-sm" />
      </div>
      <ul className="max-h-56 overflow-y-auto">
        <li><button type="button" className={optionClass} onClick={() => onPick(null)}>{tr('Unassigned')}</button></li>
        {myself && (
          <li><button type="button" className={optionClass} onClick={() => onPick(myself)}><Avatar name={myself.displayName} size="sm" />{myself.displayName} <span className="text-[var(--text-tertiary)]">{tr('(me)')}</span></button></li>
        )}
        {search && isFetching && <li className="px-3 py-2"><Skeleton className="h-5 w-full" /></li>}
        {(results || []).filter((u) => u.id !== myself?.id).map((u) => (
          <li key={u.id}>
            <button type="button" className={optionClass} onClick={() => onPick({ id: u.id, displayName: u.displayName || u.name })}>
              <Avatar name={u.displayName || u.name} size="sm" />{u.displayName || u.name}{u.isAgent && <AgentBadge />}
            </button>
          </li>
        ))}
        {search && !isFetching && (results || []).length === 0 && <li className="px-3 py-2 text-body-sm text-[var(--text-tertiary)]">{tr('No users found')}</li>}
      </ul>
    </Popover>
  )
}

export function PriorityField({
  priority, onPick, id = 'field-priority',
}: {
  id?: string
  priority: ApiIssue['fields']['priority']
  onPick: (p: { id: number; name: string; color?: string }) => void
}) {
  const { tr } = useI18n();

  const [open, setOpen] = useState(false)
  const { data: priorities, isLoading } = usePriorities()
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={tr('Set priority')}
      align="right"
      haspopup="listbox"
      panelClassName={`${PICKER} py-1`}
      trigger={(p) => (
        <InlineValueButton id={id} {...p} aria-label={tr('Priority: {name}. Change priority', { name: priority?.name || tr('None') })}>
          {priority ? (
            <span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: priority.color || 'var(--text-tertiary)' }} aria-hidden="true" />{priority.name}</span>
          ) : <Muted />}
        </InlineValueButton>
      )}
    >
      {isLoading ? <div className="p-3"><Skeleton className="h-5 w-full" /></div> : (
        <ul>
          {(priorities || []).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={priority?.id === Number(p.id)}
                className={optionClass}
                onClick={() => { setOpen(false); if (priority?.id !== Number(p.id)) onPick({ id: Number(p.id), name: p.name, color: p.statusColor }) }}
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.statusColor || 'var(--text-tertiary)' }} aria-hidden="true" />
                {p.name}
                {priority?.id === Number(p.id) && <Check className="w-4 h-4 ml-auto text-[var(--brand-500)]" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  )
}

export function LabelsField({
  open, onOpenChange, labels, onChange, id = 'field-labels',
}: {
  id?: string
  open: boolean
  onOpenChange: (o: boolean) => void
  labels: string[]
  onChange: (labels: string[]) => void
}) {
  const { tr } = useI18n();

  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim().replace(/\s+/g, '-')
    if (!v) return
    if (labels.includes(v)) { toast(tr('Label already exists'), 'info'); return }
    onChange([...labels, v])
    setDraft('')
  }
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={tr('Edit labels')}
      align="right"
      panelClassName={`${PICKER} p-3 space-y-2`}
      trigger={(p) => (
        <InlineValueButton id={id} {...p} aria-label={tr('Edit labels')}>
          {labels.length > 0 ? (
            <span className="flex flex-wrap gap-1">{labels.map((l) => <Lozenge key={l}>{l}</Lozenge>)}</span>
          ) : <Muted />}
        </InlineValueButton>
      )}
    >
      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {labels.map((l) => (
            <li key={l}>
              <span className="inline-flex items-center gap-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
                {l}
                <button type="button" onClick={() => onChange(labels.filter((x) => x !== l))} aria-label={tr('Remove label {name}', { name: l })} className="hover:text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] rounded">
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => { e.preventDefault(); add() }} className="flex gap-2">
        <label htmlFor={`${id}-input`} className="sr-only">{tr('New label')}</label>
        <input id={`${id}-input`} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr('Add a label and press Enter')} className="veqsio-input w-full text-sm" />
        <button type="submit" className="veqsio-btn-primary text-sm" disabled={!draft.trim()}>{tr('Add')}</button>
      </form>
    </Popover>
  )
}

function MultiPicker({
  id, label, selected, options, loading, onChange, emptyText,
}: {
  id: string
  label: string
  selected: Array<{ id: number; name: string }>
  options: Array<{ id: number; name: string }>
  loading: boolean
  onChange: (ids: number[], all: Array<{ id: number; name: string }>) => void
  emptyText: string
}) {
  const [open, setOpen] = useState(false)
  const selectedIds = new Set(selected.map((s) => s.id))
  const all = useMemo(() => {
    const map = new Map<number, { id: number; name: string }>()
    for (const o of [...selected, ...options]) map.set(o.id, o)
    return [...map.values()]
  }, [selected, options])
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={`Edit ${label.toLowerCase()}`}
      align="right"
      panelClassName={`${PICKER} p-2`}
      trigger={(p) => (
        <InlineValueButton id={id} {...p} aria-label={`Edit ${label.toLowerCase()}`}>
          {selected.length > 0 ? <span className="flex flex-wrap gap-1">{selected.map((s) => <Lozenge key={s.id}>{s.name}</Lozenge>)}</span> : <Muted />}
        </InlineValueButton>
      )}
    >
      {loading ? <Skeleton className="h-5 w-full" /> : options.length === 0 ? (
        <p className="px-2 py-1 text-body-sm text-[var(--text-tertiary)]">{emptyText}</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto">
          {options.map((o) => (
            <li key={o.id}>
              <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--surface-2)] cursor-pointer text-body-sm">
                <input
                  type="checkbox"
                  checked={selectedIds.has(o.id)}
                  onChange={(e) => {
                    const next = new Set(selectedIds)
                    if (e.target.checked) next.add(o.id)
                    else next.delete(o.id)
                    onChange([...next], all)
                  }}
                />
                {o.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  )
}

export function VersionsField(props: { id: string; label: string; projectKey: string; selected: Array<{ id: number; name: string }>; onChange: (ids: number[], all: Array<{ id: number; name: string }>) => void }) {
  const { tr } = useI18n();

  const { data, isLoading } = useProjectVersions(props.projectKey)
  return <MultiPicker id={props.id} label={props.label} selected={props.selected} options={(data || []).filter((v) => !v.archived)} loading={isLoading} onChange={props.onChange} emptyText={tr('No versions in this project')} />
}

export function ComponentsField(props: { id?: string; projectKey: string; selected: Array<{ id: number; name: string }>; onChange: (ids: number[], all: Array<{ id: number; name: string }>) => void }) {
  const { tr } = useI18n();

  const { data, isLoading } = useProjectComponents(props.projectKey)
  return <MultiPicker id={props.id ?? 'field-components'} label={tr('Components')} selected={props.selected} options={data || []} loading={isLoading} onChange={props.onChange} emptyText={tr('No components in this project')} />
}

export function DueDateField({ value, onChange, id = 'field-duedate' }: { value: string | null; onChange: (v: string | null) => void; id?: string }) {
  const { tr } = useI18n()
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          id={id}
          type="date"
          autoFocus
          defaultValue={value || ''}
          onBlur={(e) => { setEditing(false); const v = e.target.value || null; if (v !== (value || null)) onChange(v) }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="veqsio-input text-sm py-1"
        />
      </div>
    )
  }
  const overdue = value ? new Date(`${value}T23:59:59`).getTime() < Date.now() : false
  return (
    <InlineValueButton id={id} onClick={() => setEditing(true)} aria-label={tr('Due date: {value}. Change due date', { value: value || tr('none') })}>
      {value ? <span className={overdue ? 'text-[var(--error)]' : ''}>{new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}{overdue ? tr(' (overdue)') : ''}</span> : <Muted />}
    </InlineValueButton>
  )
}

function ParentField({ issue, onSave }: { issue: ApiIssue; onSave: (id: number | null) => void }) {
  const { tr } = useI18n();

  const [open, setOpen] = useState(false)
  const [keyText, setKeyText] = useState('')
  const [busy, setBusy] = useState(false)
  const parent = issue.fields.parent
  const inputRef = useRef<HTMLInputElement>(null)
  const submit = async () => {
    const k = keyText.trim().toUpperCase()
    if (!k) return
    setBusy(true)
    try {
      const target = await fetch(`/rest/api/2/issue/${encodeURIComponent(k)}`, { credentials: 'include' }).then((r) => (r.ok ? r.json() : null))
      if (!target) { toast(`Issue ${k} not found`, 'error'); return }
      setOpen(false)
      setKeyText('')
      onSave(target.id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={tr('Edit parent')}
      align="right"
      panelClassName={`${PICKER} p-3 space-y-2`}
      trigger={(p) => (
        <InlineValueButton id="field-parent" {...p} aria-label={tr('Edit parent')}>
          {parent ? (
            parent.key ? (
              <span className="block truncate"><Link href={`/issues/${parent.key}`} onClick={(e) => e.stopPropagation()} className="text-[var(--brand-500)] hover:underline font-mono">{parent.key}</Link> <span className="text-[var(--text-secondary)]">{parent.summary}</span></span>
            ) : <span>{tr('Issue #')}{parent.id}</span>
          ) : <Muted />}
        </InlineValueButton>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-2">
        <label htmlFor="parent-key" className="text-caption text-[var(--text-secondary)] block">{tr('Parent issue key')}</label>
        <input id="parent-key" ref={inputRef} autoFocus value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder={tr('e.g. PROJ-12')} className="veqsio-input w-full text-sm" />
        <div className="flex items-center gap-2">
          <button type="submit" disabled={busy || !keyText.trim()} className="veqsio-btn-primary text-sm disabled:opacity-50">{tr('Set parent')}</button>
          {parent && <button type="button" onClick={() => { setOpen(false); onSave(null) }} className="veqsio-btn-secondary text-sm">{tr('Remove')}</button>}
        </div>
      </form>
    </Popover>
  )
}
