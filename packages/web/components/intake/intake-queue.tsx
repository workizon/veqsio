'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clock, Copy, Inbox, Plus, RotateCcw, Settings, X } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import {
  useIntakeAction, useIntakeBulk, useIntakeItems, useSubmitIntake,
  type ActionBody, type IntakeAction, type IntakeInfo, type IntakeItem, type IntakeStatus,
} from '@/hooks/use-intake'
import { AcceptDialog, DeclineDialog, DuplicateDialog, SnoozeDialog, SubmitDialog, type DialogKind } from './dialogs'

const TABS: Array<{ id: IntakeStatus; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'declined', label: 'Declined' },
  { id: 'duplicate', label: 'Duplicates' },
]
const SOURCE: Record<string, string> = { form: 'Public form', email: 'Email', api: 'API', app: 'In app' }
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : '')
const ago = (s: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 60_000))
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return `${Math.round(m / 1440)} days ago`
}

export function IntakeQueue({ project, info }: { project: string; info: IntakeInfo }) {
  const [tab, setTab] = useState<IntakeStatus>('pending')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [activeId, setActiveId] = useState<number | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [dialog, setDialog] = useState<{ kind: DialogKind; items: IntakeItem[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 250); return () => clearTimeout(t) }, [q])
  const list = useIntakeItems(project, tab, debouncedQ, info.canTriage)
  const act = useIntakeAction(project)
  const bulk = useIntakeBulk(project)
  const submit = useSubmitIntake(project)
  const items = list.data?.items ?? []
  const counts = list.data?.counts

  // Keep the selection valid when the list changes.
  useEffect(() => {
    setChecked((c) => new Set([...c].filter((id) => items.some((i) => i.id === id))))
    if (!items.some((i) => i.id === activeId)) setActiveId(items[0]?.id ?? null)
  }, [items]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChecked(new Set()); setActiveId(null) }, [tab])

  const active = items.find((i) => i.id === activeId) ?? null
  const canDecide = (i: IntakeItem) => i.status === 'pending' || i.status === 'snoozed'
  const target = useMemo(() => (checked.size ? items.filter((i) => checked.has(i.id)) : active ? [active] : []), [checked, items, active])

  const open = (kind: DialogKind, its: IntakeItem[] = target) => { if (its.length || kind === 'submit') { setError(null); setDialog({ kind, items: its }) } }

  const run = async (action: IntakeAction, body: ActionBody, its: IntakeItem[]) => {
    setError(null)
    try {
      if (its.length === 1 && checked.size === 0) {
        await act.mutateAsync({ id: its[0].id, action, body })
        toast(`Item ${past(action)}`, 'success')
      } else {
        const r = await bulk.mutateAsync({ ids: its.map((i) => i.id), action, ...body })
        toast(`${r.succeeded} ${past(action)}${r.failed ? `, ${r.failed} failed: ${r.results.find((x) => !x.ok)?.error ?? ''}` : ''}`, r.failed ? 'error' : 'success')
        setChecked(new Set())
      }
      setDialog(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const idx = items.findIndex((i) => i.id === activeId)
    const move = (n: number) => { const next = items[Math.min(items.length - 1, Math.max(0, n))]; if (next) { setActiveId(next.id); document.getElementById(`intake-item-${next.id}`)?.scrollIntoView({ block: 'nearest' }) } }
    const k = e.key.toLowerCase()
    if (k === 'arrowdown' || k === 'j') { e.preventDefault(); move(idx + 1) }
    else if (k === 'arrowup' || k === 'k') { e.preventDefault(); move(idx - 1) }
    else if (k === ' ' && active) { e.preventDefault(); toggle(active.id) }
    else if (info.canTriage && target.length && target.every(canDecide)) {
      if (k === 'a') { e.preventDefault(); open('accept') }
      else if (k === 'd') { e.preventDefault(); open('decline') }
      else if (k === 's') { e.preventDefault(); open('snooze') }
      else if (k === 'u') { e.preventDefault(); open('duplicate') }
    }
  }
  const toggle = (id: number) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allChecked = items.length > 0 && checked.size === items.length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="veqsio-btn-primary flex items-center gap-2" onClick={() => open('submit', [])}><Plus className="w-4 h-4" aria-hidden />Submit to intake</button>
        {info.canAdmin && <Link href={`/projects/${project}/settings`} className="veqsio-btn-secondary flex items-center gap-2"><Settings className="w-4 h-4" aria-hidden />Intake settings</Link>}
      </div>

      {!info.canTriage ? (
        <p className="veqsio-card p-6 text-[var(--text-secondary)]">Your submissions go to the project&apos;s intake queue. You need permission to create issues in this project to review the queue.</p>
      ) : (
        <>
          <div role="tablist" aria-label="Intake status" className="flex gap-1 border-b border-[var(--surface-3)] overflow-x-auto"
            onKeyDown={(e) => {
              const i = TABS.findIndex((t) => t.id === tab)
              if (e.key === 'ArrowRight') { e.preventDefault(); setTab(TABS[(i + 1) % TABS.length].id) }
              if (e.key === 'ArrowLeft') { e.preventDefault(); setTab(TABS[(i + TABS.length - 1) % TABS.length].id) }
            }}>
            {TABS.map((t) => (
              <button key={t.id} role="tab" id={`intake-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="intake-panel" tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${tab === t.id ? 'border-[var(--brand-600)] text-[var(--brand-700)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                {t.label}
                <span className="ml-2 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs" aria-label={`${counts?.[t.id] ?? 0} items`}>{counts?.[t.id] ?? '–'}</span>
              </button>
            ))}
          </div>

          <div id="intake-panel" role="tabpanel" aria-labelledby={`intake-tab-${tab}`} className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <input type="search" aria-label="Search the queue" placeholder="Search title, text, requester" className="veqsio-input w-72 max-w-full" value={q} onChange={(e) => setQ(e.target.value)} />
              {items.length > 0 && tab !== 'accepted' && (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(items.map((i) => i.id)))} />Select all</label>
              )}
              {checked.size > 0 && (
                <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={`Actions for ${checked.size} selected items`}>
                  <span className="text-sm text-[var(--text-secondary)]">{checked.size} selected</span>
                  {items.filter((i) => checked.has(i.id)).every(canDecide) ? (
                    <>
                      <button type="button" className="veqsio-btn-primary text-sm" onClick={() => open('accept')}>Accept</button>
                      <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => open('decline')}>Decline</button>
                      <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => open('snooze')}>Snooze</button>
                      <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => open('duplicate')}>Duplicate of…</button>
                    </>
                  ) : (tab === 'declined' || tab === 'duplicate') ? (
                    <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => run('reopen', {}, target)}>Reopen</button>
                  ) : null}
                </div>
              )}
              <span className="ml-auto text-xs text-[var(--text-tertiary)] hidden md:inline">Keys: ↑ ↓ move · Space select · A accept · D decline · S snooze · U duplicate</span>
            </div>

            {list.isLoading && <div className="flex justify-center py-12"><Spinner size="lg" /></div>}
            {list.error && <p role="alert" className="text-[var(--error)]">{(list.error as Error).message}</p>}
            {list.data && items.length === 0 && (
              <div className="veqsio-card p-10 text-center text-[var(--text-secondary)]">
                <Inbox className="mx-auto mb-2 w-8 h-8 text-[var(--text-tertiary)]" aria-hidden />
                {debouncedQ ? 'Nothing matches your search.' : tab === 'pending' ? 'Nothing is waiting for triage.' : `No ${TABS.find((t) => t.id === tab)!.label.toLowerCase()} items.`}
              </div>
            )}

            {items.length > 0 && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <ul ref={listRef} role="listbox" aria-label={`${TABS.find((t) => t.id === tab)!.label} submissions`} aria-activedescendant={activeId ? `intake-item-${activeId}` : undefined}
                  tabIndex={0} onKeyDown={onKey} className="veqsio-card divide-y divide-[var(--surface-3)] p-0 max-h-[70vh] overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]">
                  {items.map((i) => (
                    <li key={i.id} id={`intake-item-${i.id}`} role="option" aria-selected={i.id === activeId}
                      className={`flex gap-3 p-3 cursor-pointer ${i.id === activeId ? 'bg-[var(--brand-50)]' : 'hover:bg-[var(--surface-1)]'}`} onClick={() => setActiveId(i.id)}>
                      <input type="checkbox" aria-label={`Select ${i.title}`} checked={checked.has(i.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(i.id)} tabIndex={-1} className="mt-1" />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{i.title}</p>
                        <p className="text-xs text-[var(--text-tertiary)] truncate">
                          {i.requester.name || i.requester.email || 'Unknown requester'} · {SOURCE[i.source]} · {ago(i.createdAt)}
                          {i.status === 'snoozed' && i.snoozedUntil ? ` · back ${new Date(i.snoozedUntil).toLocaleDateString()}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>

                <section aria-label="Details" className="veqsio-card p-5 space-y-4 min-w-0">
                  {active ? <Detail item={active} busy={act.isPending} onOpen={(k) => open(k, [active])} onReopen={() => run('reopen', {}, [active])} canTriage={info.canTriage} /> : <p className="text-[var(--text-secondary)]">Select a submission.</p>}
                </section>
              </div>
            )}
          </div>
        </>
      )}

      {dialog?.kind === 'submit' && (
        <SubmitDialog busy={submit.isPending} error={error} onCancel={() => setDialog(null)}
          onSubmit={async (b) => { setError(null); try { await submit.mutateAsync(b); toast('Submitted to intake', 'success'); setDialog(null) } catch (e) { setError((e as Error).message) } }} />
      )}
      {dialog && dialog.kind !== 'submit' && (() => {
        const common = { project, items: dialog.items, busy: act.isPending || bulk.isPending, error, onCancel: () => setDialog(null) }
        const go = (a: IntakeAction) => (b: ActionBody) => run(a, b, dialog.items)
        return dialog.kind === 'accept' ? <AcceptDialog {...common} onSubmit={go('accept')} />
          : dialog.kind === 'decline' ? <DeclineDialog {...common} onSubmit={go('decline')} />
          : dialog.kind === 'snooze' ? <SnoozeDialog {...common} onSubmit={go('snooze')} />
          : <DuplicateDialog {...common} onSubmit={go('duplicate')} />
      })()}
    </div>
  )
}

const past = (a: IntakeAction) => ({ accept: 'accepted', decline: 'declined', snooze: 'snoozed', duplicate: 'marked as duplicate', reopen: 'reopened' })[a]

function Detail({ item, busy, canTriage, onOpen, onReopen }: { item: IntakeItem; busy: boolean; canTriage: boolean; onOpen: (k: DialogKind) => void; onReopen: () => void }) {
  const decided = item.status !== 'pending'
  return (
    <>
      <div>
        <h2 className="text-heading-2 break-words">{item.title}</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          From <strong>{item.requester.name || 'unknown'}</strong>
          {item.requester.email && <> &lt;<a className="text-[var(--brand-500)] hover:underline" href={`mailto:${item.requester.email}`}>{item.requester.email}</a>&gt;</>}
          {' '}· {SOURCE[item.source]} · {fmt(item.createdAt)}
        </p>
      </div>
      {item.description ? <p className="whitespace-pre-wrap break-words text-body">{item.description}</p> : <p className="text-[var(--text-tertiary)]">No details were given.</p>}
      {decided && (
        <div className="rounded-lg bg-[var(--surface-1)] p-3 text-sm space-y-1">
          <p><strong className="capitalize">{item.status}</strong>{item.decidedAt && ` · ${fmt(item.decidedAt)}`}{item.snoozedUntil && ` · until ${fmt(item.snoozedUntil)}`}</p>
          {item.acceptedIssue && <p>Issue: <Link className="text-[var(--brand-500)] hover:underline" href={`/issues/${item.acceptedIssue.key}`}>{item.acceptedIssue.key}</Link></p>}
          {item.duplicateOf && <p>Duplicate of <Link className="text-[var(--brand-500)] hover:underline" href={`/issues/${item.duplicateOf.key}`}>{item.duplicateOf.key}</Link></p>}
          {item.decisionReason && <p className="whitespace-pre-wrap break-words">Note: {item.decisionReason}</p>}
        </div>
      )}
      {canTriage && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Triage actions">
          {(item.status === 'pending' || item.status === 'snoozed') && (
            <>
              <button type="button" className="veqsio-btn-primary flex items-center gap-1" disabled={busy} onClick={() => onOpen('accept')}><Check className="w-4 h-4" aria-hidden />Accept</button>
              <button type="button" className="veqsio-btn-secondary flex items-center gap-1" disabled={busy} onClick={() => onOpen('decline')}><X className="w-4 h-4" aria-hidden />Decline</button>
              <button type="button" className="veqsio-btn-secondary flex items-center gap-1" disabled={busy} onClick={() => onOpen('snooze')}><Clock className="w-4 h-4" aria-hidden />Snooze</button>
              <button type="button" className="veqsio-btn-secondary flex items-center gap-1" disabled={busy} onClick={() => onOpen('duplicate')}><Copy className="w-4 h-4" aria-hidden />Duplicate</button>
            </>
          )}
          {(item.status === 'declined' || item.status === 'duplicate' || item.status === 'snoozed') && (
            <button type="button" className="veqsio-btn-secondary flex items-center gap-1" disabled={busy} onClick={onReopen}><RotateCcw className="w-4 h-4" aria-hidden />Reopen</button>
          )}
        </div>
      )}
    </>
  )
}
