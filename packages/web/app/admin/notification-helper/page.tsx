'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { UserPicker, type PickedUser } from '@/components/admin/user-picker'
import { ExplainResult, type ExplainReason } from '@/components/admin/explain-result'

interface Explanation {
  notified: boolean
  deliverable: boolean
  event: { id: string; label: string }
  issueKey: string
  user: { id: number; username: string; displayName: string; email: string; active: boolean }
  reasons: ExplainReason[]
}

export default function NotificationHelperPage() {
  const [issueKey, setIssueKey] = useState('')
  const [event, setEvent] = useState('issue.updated')
  const [user, setUser] = useState<PickedUser | null>(null)
  const [actor, setActor] = useState<PickedUser | null>(null)
  const [result, setResult] = useState<Explanation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: events } = useQuery({
    queryKey: ['admin', 'notification-events'],
    queryFn: async () => ((await (await fetch('/rest/api/2/admin/notification-helper/events', { credentials: 'include' })).json()).events as Array<{ id: string; label: string }>),
  })

  const run = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setResult(null)
    if (!issueKey.trim()) return setError('Enter an issue key such as DEMO-1.')
    if (!user) return setError('Pick the recipient first.')
    const q = new URLSearchParams({ issueKey: issueKey.trim().toUpperCase(), event, userId: String(user.id) })
    if (actor) q.set('actorId', String(actor.id))
    setBusy(true)
    try {
      const res = await fetch(`/rest/api/2/admin/notification-helper?${q}`, { credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) setError(res.status === 403 ? 'System administrator rights are required.' : body.errorMessages?.[0] || res.statusText)
      else setResult(body)
    } finally { setBusy(false) }
  }

  const verdict = !result ? '' : !result.notified ? 'Not notified' : result.deliverable ? 'Notified' : 'Queued, not deliverable'

  return (
    <AppLayout>
      <div className="space-y-5">
        <PageHeader title="Notification helper" description="Find out whether someone would receive an e-mail for an event on an issue, and which rule decides it. Uses the same recipient rules as the mail sender." />

        <form onSubmit={run} className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 grid gap-4 md:grid-cols-2 max-w-4xl">
          <div>
            <label htmlFor="nh-issue" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">Issue key</label>
            <input id="nh-issue" className="veqsio-input w-full" value={issueKey} onChange={(e) => setIssueKey(e.target.value)} placeholder="DEMO-1" autoComplete="off" />
          </div>
          <div>
            <label htmlFor="nh-event" className="block text-caption font-medium text-[var(--text-secondary)] mb-1">Event</label>
            <select id="nh-event" className="veqsio-input w-full" value={event} onChange={(e) => setEvent(e.target.value)}>
              {(events ?? [{ id: 'issue.updated', label: 'Issue updated' }]).map((ev) => <option key={ev.id} value={ev.id}>{ev.label}</option>)}
            </select>
          </div>
          <UserPicker label="Recipient" value={user} onChange={setUser} />
          <UserPicker label="Who made the change (optional)" value={actor} onChange={setActor} hint="The person who causes an event is not notified about it." />
          <div className="md:col-span-2 flex items-center gap-3">
            <button type="submit" className="veqsio-btn-primary flex items-center gap-2" disabled={busy}><Mail className="w-4 h-4" />Check notification</button>
            {busy && <Spinner />}
            <span className="text-caption text-[var(--text-tertiary)]">Looking up another user is recorded in the audit log.</span>
          </div>
        </form>

        {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
        {result && (
          <div className="">
            <ExplainResult
              verdict={verdict} positive={result.notified}
              title={`${result.user.displayName} ${result.notified ? 'would get' : 'would not get'} an e-mail for "${result.event.label}" on ${result.issueKey}`}
              subtitle={result.user.email ? `Address: ${result.user.email}` : 'No e-mail address on file'}
              reasons={result.reasons}
            />
          </div>
        )}
      </div>
    </AppLayout>
  )
}
