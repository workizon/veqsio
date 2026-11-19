'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Check, Info } from 'lucide-react'
import { Spinner } from '@/components/spinner'

interface EventRow { event: string; assignee: boolean; reporter: boolean; watchers: boolean; projectLead: boolean; allAdmins: boolean; currentUser: boolean }

const COLS: Array<[keyof Omit<EventRow, 'event'>, string]> = [['assignee', 'Assignee'], ['reporter', 'Reporter'], ['watchers', 'Watchers'], ['projectLead', 'Project lead'], ['allAdmins', 'All admins'], ['currentUser', 'Current user']]
const label = (e: string) => e.replace(/[_-]+/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())

/** Who is told about what in this project, from the notification scheme that applies to it. */
export function ProjectNotificationsPanel({ projectKey }: { projectKey: string }) {
  const q = useQuery({
    queryKey: ['project-notifications', projectKey],
    queryFn: async () => {
      const r = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}/notifications`, { credentials: 'include' })
      if (!r.ok) throw new Error('Could not load the notification rules')
      return (await r.json()) as { scheme: { id: number; name: string; forThisProject: boolean } | null; events: EventRow[] }
    },
  })
  if (q.isLoading) return <div className="flex justify-center py-12"><Spinner /></div>
  if (q.error || !q.data) return <p className="text-[var(--error)]">Could not load the notification rules.</p>
  const { scheme, events } = q.data
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-heading-2 text-[var(--text-primary)]">Notifications</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)] max-w-3xl">When something happens to an issue of this project, these people get a message. Individual people can also switch notifications off in their profile.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--surface-3)] bg-[var(--brand-50)] px-4 py-3 text-sm">
        <Info className="w-4 h-4 text-[var(--brand-500)] shrink-0" aria-hidden="true" />
        {scheme ? <span>Notification scheme: <strong>{scheme.name}</strong> {scheme.forThisProject ? '(made for this project)' : '(the default scheme, shared by projects)'}</span> : <span>No notification scheme applies, so no event notifications are sent.</span>}
        <Link href="/admin/notifications" className="ml-auto text-[var(--brand-500)] hover:underline">Edit notification schemes</Link>
      </div>
      {events.length > 0 && (
        <div className="rounded-lg border border-[var(--surface-3)] overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Notification rules</caption>
            <thead><tr className="veqsio-table-header text-left"><th scope="col">Event</th>{COLS.map(([, n]) => <th key={n} scope="col" className="text-center">{n}</th>)}</tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event} className="veqsio-table-row">
                  <th scope="row" className="px-4 py-2 text-left font-medium">{label(e.event)}</th>
                  {COLS.map(([k, n]) => <td key={k} className="px-4 py-2 text-center">{e[k] ? <Check className="inline w-4 h-4 text-[var(--success)]" aria-label={`${n} is notified`} /> : <span className="text-[var(--text-tertiary)]" aria-label={`${n} is not notified`}>–</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
