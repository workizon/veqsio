'use client'

import { useId, useState } from 'react'
import { useGroups, useUserSearch } from '@/hooks/use-admin'
import { STATUS_CLASS, STATUS_LABEL, type ApprovalStatus } from '@/lib/approvals'

export function StatusChip({ status }: { status: ApprovalStatus }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status] ?? ''}`}>{STATUS_LABEL[status] ?? status}</span>
}

/** Approve / decline with an optional comment. The parent performs the request and reports errors via `error`. */
export function DecisionForm({
  onDecide, busy, error, label = 'Your decision', touch = false,
}: {
  onDecide: (decision: 'approved' | 'declined', comment: string) => void
  busy: boolean
  error?: string
  label?: string
  /** Portal look: 44px touch targets, full-width buttons on a phone. */
  touch?: boolean
}) {
  const id = useId()
  const [comment, setComment] = useState('')
  const btn = touch ? ' min-h-[44px] flex-1 sm:flex-none sm:px-6' : ''
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => e.preventDefault()}
      aria-label={label}
    >
      <label htmlFor={id} className={touch ? 'block text-body-sm font-medium text-[var(--text-primary)]' : 'block text-sm font-medium'}>Comment (optional)</label>
      <textarea
        id={id} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} rows={2}
        className="veqsio-input w-full"
      />
      {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className={`veqsio-btn-primary${btn}`} disabled={busy} onClick={() => onDecide('approved', comment)}>Approve</button>
        <button type="button" className={`veqsio-btn-secondary${btn}`} disabled={busy} onClick={() => onDecide('declined', comment)}>Decline</button>
      </div>
    </form>
  )
}

export interface PickedUser { id: number; name: string }

/** Pick approver users (search by name) and groups. Keyboard usable: plain inputs, buttons and a select. */
export function ApproverPicker({
  users, groupIds, onChange, error,
}: {
  users: PickedUser[]
  groupIds: number[]
  onChange: (v: { users: PickedUser[]; groupIds: number[] }) => void
  error?: string
}) {
  const uid = useId()
  const [query, setQuery] = useState('')
  const search = useUserSearch(query.trim())
  const groups = useGroups()
  const results = (search.data ?? []).filter((u: any) => u.active !== false && typeof u.id === 'number' && !users.some((x) => x.id === u.id)).slice(0, 8)
  const allGroups = groups.data?.values ?? []

  return (
    <fieldset className="space-y-2" aria-describedby={error ? `${uid}-err` : undefined}>
      <legend className="text-sm font-medium">Approvers</legend>
      <ul className="flex flex-wrap gap-1" aria-label="Selected approvers">
        {users.map((u) => (
          <li key={`u${u.id}`} className="inline-flex items-center gap-1 rounded bg-[var(--surface-2)] px-2 py-0.5 text-sm">
            {u.name}
            <button type="button" aria-label={`Remove ${u.name}`} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              onClick={() => onChange({ users: users.filter((x) => x.id !== u.id), groupIds })}>×</button>
          </li>
        ))}
        {groupIds.map((g) => {
          const name = allGroups.find((x) => Number(x.id) === g)?.name ?? `Group ${g}`
          return (
            <li key={`g${g}`} className="inline-flex items-center gap-1 rounded bg-[var(--surface-2)] px-2 py-0.5 text-sm">
              Group: {name}
              <button type="button" aria-label={`Remove group ${name}`} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                onClick={() => onChange({ users, groupIds: groupIds.filter((x) => x !== g) })}>×</button>
            </li>
          )
        })}
        {users.length === 0 && groupIds.length === 0 && <li className="text-sm text-[var(--text-tertiary)]">Nobody selected</li>}
      </ul>
      <div>
        <label htmlFor={`${uid}-q`} className="block text-sm">Add a person</label>
        <input id={`${uid}-q`} className="veqsio-input w-full" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" autoComplete="off" />
        {results.length > 0 && (
          <ul className="mt-1 border border-[var(--surface-3)] rounded divide-y divide-[var(--surface-3)]" aria-label="Search results">
            {results.map((u: any) => (
              <li key={u.id}>
                <button type="button" className="w-full text-left px-2 py-1 text-sm hover:bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-2"
                  onClick={() => { onChange({ users: [...users, { id: u.id, name: u.name }], groupIds }); setQuery('') }}>
                  {u.name} <span className="text-[var(--text-tertiary)]">{u.emailAddress}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <label htmlFor={`${uid}-g`} className="block text-sm">Add a group</label>
        <select id={`${uid}-g`} className="veqsio-input w-full" value="" onChange={(e) => {
          const g = Number(e.target.value)
          if (g && !groupIds.includes(g)) onChange({ users, groupIds: [...groupIds, g] })
        }}>
          <option value="">Choose a group...</option>
          {allGroups.filter((g) => !groupIds.includes(Number(g.id))).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      {error && <p id={`${uid}-err`} role="alert" className="text-sm text-[var(--error)]">{error}</p>}
    </fieldset>
  )
}
