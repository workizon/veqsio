'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useDesks } from '@/hooks/use-servicedesk'
import { useUsers } from '@/hooks/use-users'
import { usePriorities } from '@/hooks/use-issues'
import { confirmDialog } from '@/components/dialogs'

interface Rule { id: number; name: string; enabled: boolean; trigger: string; threshold: number | null; action: string; params: { userId?: number; priorityId?: number; status?: string; text?: string; labels?: string[]; requestTypeId?: number }; conditions?: { contains?: string[]; channel?: string; requestTypeId?: number }; runs: number }

const TRIGGERS: Array<{ id: string; label: string; needs?: 'percent' | 'days' }> = [
  { id: 'sla_percent', label: 'An SLA has used a share of its time', needs: 'percent' },
  { id: 'sla_breached', label: 'An SLA is breached' },
  { id: 'waiting_days', label: 'A request waits for the customer for days', needs: 'days' },
  { id: 'customer_reply', label: 'The customer replies to a resolved request' },
  { id: 'request_created', label: 'A new request arrives (categorise and prioritise)' },
]
const ACTIONS = [
  { id: 'notify', label: 'Notify the assignee (or the agents)' },
  { id: 'reassign', label: 'Reassign to a person' },
  { id: 'priority', label: 'Change the priority' },
  { id: 'transition', label: 'Move to a status' },
  { id: 'comment', label: 'Add a public comment' },
  { id: 'label', label: 'Add labels (new requests only)' },
  { id: 'request_type', label: 'Set the request type (new requests only)' },
]

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
  return res.json()
}

function describe(r: Rule): string {
  const t = TRIGGERS.find((x) => x.id === r.trigger)
  const cond = r.conditions && (r.conditions.contains?.length || r.conditions.channel || r.conditions.requestTypeId) ? ` (${[r.conditions.contains?.length ? `mentions ${r.conditions.contains.join(' / ')}` : '', r.conditions.channel ? `via ${r.conditions.channel}` : ''].filter(Boolean).join(', ') || 'with conditions'})` : ''
  const when = r.trigger === 'request_created' ? `When a new request arrives${cond}` : r.trigger === 'sla_percent' ? `When ${r.threshold}% of an SLA is used` : r.trigger === 'waiting_days' ? `When a request has waited ${r.threshold} day(s) for the customer` : t?.label ?? r.trigger
  const what = r.action === 'transition' ? `move to "${r.params.status}"` : r.action === 'comment' ? 'add a comment' : r.action === 'label' ? `add labels ${r.params.labels?.join(', ')}` : r.action === 'request_type' ? 'set the request type' : ACTIONS.find((a) => a.id === r.action)?.label.toLowerCase() ?? r.action
  return `${when}: ${what}`
}

export default function DeskAutomationPage() {
  const id = Number(useParams<{ id: string }>().id)
  const qc = useQueryClient()
  const desks = useDesks()
  const isAdmin = desks.data?.values.find((d) => d.id === id)?.role === 'admin'
  const users = useUsers()
  const priorities = usePriorities()
  const key = ['sd-automation', id]
  const rules = useQuery({ queryKey: key, queryFn: () => api<{ values: Rule[] }>(`/rest/servicedeskapi/servicedesk/${id}/automation`) })
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const onError = (e: unknown) => toast((e as Error).message, 'error')
  const create = useMutation({ mutationFn: (b: object) => api(`/rest/servicedeskapi/servicedesk/${id}/automation`, { method: 'POST', body: JSON.stringify(b) }), onSuccess: () => { refresh(); toast('Rule created', 'success') }, onError })
  const toggle = useMutation({ mutationFn: (r: Rule) => api(`/rest/servicedeskapi/servicedesk/${id}/automation/${r.id}`, { method: 'PUT', body: JSON.stringify({ name: r.name, trigger: r.trigger, threshold: r.threshold, action: r.action, params: r.params, enabled: !r.enabled }) }), onSuccess: refresh, onError })
  const del = useMutation({ mutationFn: (rid: number) => api(`/rest/servicedeskapi/servicedesk/${id}/automation/${rid}`, { method: 'DELETE' }), onSuccess: refresh, onError })

  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('sla_percent')
  const [threshold, setThreshold] = useState(80)
  const [action, setAction] = useState('notify')
  const [userId, setUserId] = useState('')
  const [priorityId, setPriorityId] = useState('')
  const [status, setStatus] = useState('')
  const [text, setText] = useState('')
  const [keywords, setKeywords] = useState('')
  const [channel, setChannel] = useState('')
  const [labels, setLabels] = useState('')
  const [requestTypeId, setRequestTypeId] = useState('')
  const types = useQuery({ queryKey: ['sd-request-types', id], queryFn: () => api<{ values: Array<{ id: number; name: string }> }>(`/rest/servicedeskapi/servicedesk/${id}/requesttype`).catch(() => ({ values: [] as Array<{ id: number; name: string }> })) })
  const needs = TRIGGERS.find((t) => t.id === trigger)?.needs
  const allowedActions = trigger === 'customer_reply' ? ACTIONS.filter((a) => ['transition', 'notify', 'comment'].includes(a.id)) : trigger === 'request_created' ? ACTIONS : ACTIONS.filter((a) => a.id !== 'label' && a.id !== 'request_type')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    create.mutate({
      name: name.trim(), trigger, threshold: needs ? threshold : null, action,
      params: {
        ...(action === 'reassign' && userId ? { userId: Number(userId) } : {}),
        ...(action === 'priority' && priorityId ? { priorityId: Number(priorityId) } : {}),
        ...(action === 'label' ? { labels: labels.split(/[\s,]+/).filter(Boolean) } : {}),
        ...(action === 'request_type' && requestTypeId ? { requestTypeId: Number(requestTypeId) } : {}),
        ...(action === 'transition' && status.trim() ? { status: status.trim() } : {}),
        ...((action === 'comment' || action === 'transition') && text.trim() ? { text: text.trim() } : {}),
      },
      conditions: trigger === 'request_created' ? {
        ...(keywords.trim() ? { contains: keywords.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
        ...(channel ? { channel } : {}),
      } : {},
    }, { onSuccess: () => { setName(''); setText(''); setKeywords(''); setLabels('') } })
  }

  return (
    <>
      <div className="space-y-6">
        <PageHeader title="Automation" actions={<><Link href={`/servicedesk/${id}`} className="veqsio-btn-secondary">Back to service desk</Link></>} />
        <p className="text-body text-[var(--text-secondary)]">
          Rules run once per request, a minute after their condition is met (a reply to a resolved request acts at once). They act as the person who saved them, so workflow rules still apply.
          Close a request that waits too long by moving it to a status such as Resolved; reopen on a reply with a transition to the status you use for reopening. Text placeholders: <code>{'{{issue.key}}'}</code>, <code>{'{{days}}'}</code>.
        </p>

        {rules.isLoading && <Spinner />}
        <ul className="space-y-2">
          {rules.data?.values.length === 0 && <li className="text-[var(--text-tertiary)]">No rules yet.</li>}
          {rules.data?.values.map((r) => (
            <li key={r.id} className="veqsio-card flex flex-wrap items-center gap-3 p-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium">{r.name} {!r.enabled && <span className="text-caption text-[var(--text-tertiary)]">(off)</span>}</div>
                <div className="text-body-sm text-[var(--text-secondary)]">{describe(r)} · ran {r.runs} time(s)</div>
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <button type="button" className="veqsio-btn-secondary text-sm" disabled={toggle.isPending} onClick={() => toggle.mutate(r)}>{r.enabled ? 'Turn off' : 'Turn on'}</button>
                  <button type="button" className="veqsio-btn-secondary text-sm" disabled={del.isPending} onClick={async () => { if ((await confirmDialog(`Delete "${r.name}"?`))) del.mutate(r.id) }}>Delete<span className="sr-only"> {r.name}</span></button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {isAdmin ? (
          <form onSubmit={submit} className="veqsio-card grid gap-3 p-4 sm:grid-cols-2" aria-label="New rule">
            <h2 className="sm:col-span-2 text-heading-3">New rule</h2>
            <label className="text-sm sm:col-span-2">Name<input className="veqsio-input mt-1 w-full" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="text-sm">When
              <select className="veqsio-input mt-1 w-full" value={trigger} onChange={(e) => { setTrigger(e.target.value); if (e.target.value === 'customer_reply') setAction('transition') }}>
                {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            {trigger === 'request_created' && (
              <>
                <label className="text-sm">Mentions any of these words (optional, comma separated)
                  <input className="veqsio-input mt-1 w-full" placeholder="printer, scanner" value={keywords} onChange={(e) => setKeywords(e.target.value)} /></label>
                <label className="text-sm">Arrives by (optional)
                  <select className="veqsio-input mt-1 w-full" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">Any channel</option><option value="portal">Portal</option><option value="email">E-mail</option><option value="agent">Raised by an agent</option></select></label>
              </>
            )}
            {needs && <label className="text-sm">{needs === 'percent' ? 'Percent of the SLA time (1 to 99)' : 'Days (1 to 365)'}
              <input type="number" className="veqsio-input mt-1 w-full" min={1} max={needs === 'percent' ? 99 : 365} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>}
            <label className="text-sm">Then
              <select className="veqsio-input mt-1 w-full" value={action} onChange={(e) => setAction(e.target.value)}>
                {allowedActions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            {action === 'reassign' && <label className="text-sm">Person
              <select className="veqsio-input mt-1 w-full" required value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Choose…</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></label>}
            {action === 'priority' && <label className="text-sm">Priority
              <select className="veqsio-input mt-1 w-full" required value={priorityId} onChange={(e) => setPriorityId(e.target.value)}><option value="">Choose…</option>{priorities.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
            {action === 'label' && <label className="text-sm">Labels (separated by spaces or commas)
              <input className="veqsio-input mt-1 w-full" required value={labels} onChange={(e) => setLabels(e.target.value)} /></label>}
            {action === 'request_type' && <label className="text-sm">Request type
              <select className="veqsio-input mt-1 w-full" required value={requestTypeId} onChange={(e) => setRequestTypeId(e.target.value)}><option value="">Choose…</option>{types.data?.values.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
            {action === 'transition' && <label className="text-sm">Status name
              <input className="veqsio-input mt-1 w-full" required maxLength={100} placeholder="Resolved" value={status} onChange={(e) => setStatus(e.target.value)} /></label>}
            {(action === 'comment' || action === 'transition') && <label className="text-sm sm:col-span-2">{action === 'comment' ? 'Comment text' : 'Comment added with the move (optional)'}
              <textarea className="veqsio-input mt-1 w-full" rows={2} maxLength={2000} required={action === 'comment'} value={text} onChange={(e) => setText(e.target.value)} /></label>}
            <div className="sm:col-span-2"><button type="submit" className="veqsio-btn-primary" disabled={create.isPending}>Create rule</button></div>
          </form>
        ) : <p className="text-body-sm text-[var(--text-secondary)]">Only service desk administrators can change rules.</p>}
      </div>
    </>
  )
}
