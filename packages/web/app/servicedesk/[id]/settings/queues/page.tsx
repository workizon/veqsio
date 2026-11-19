'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { ApiError, useAdminQueues, useDeleteQueue, useDeskAdmin, useSaveQueue, type DeskQueue } from '@/hooks/use-servicedesk-admin'
import { jqlErrorFrom, type JqlErrorInfo } from '@/lib/queue-jql'
import { confirmDialog } from '@/components/dialogs'

const onErr = (e: Error) => toast(e.message, 'error')
const EXAMPLE = 'resolution = Unresolved AND assignee is EMPTY ORDER BY created DESC'

/** Inline JQL error: the parser's message and, when known, the character position with a caret under the JQL. */
function JqlError({ id, jql, error }: { id: string; jql: string; error: JqlErrorInfo }) {
  return (
    <div id={id} role="alert" className="text-sm text-[var(--error)] space-y-1">
      <p>{error.message}{error.position !== null && <span className="text-[var(--text-secondary)]"> (position {error.position + 1})</span>}</p>
      {error.position !== null && (
        <pre aria-hidden="true" className="text-xs font-mono bg-[var(--surface-2)] rounded px-2 py-1 overflow-x-auto">{jql}{'\n'}{' '.repeat(Math.min(error.position, jql.length))}^</pre>
      )}
    </div>
  )
}

function QueueEditor({ q, canEdit, onMove, onDelete, first, last, saveQueue }: {
  q: DeskQueue; canEdit: boolean; first: boolean; last: boolean
  onMove: (dir: -1 | 1) => void; onDelete: () => void
  saveQueue: (v: { name: string; jql: string | null }) => Promise<unknown>
}) {
  const [jql, setJql] = useState(q.jql ?? '')
  const [error, setError] = useState<JqlErrorInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = jql !== (q.jql ?? '')
  const errId = `q-${q.id}-err`
  const save = async () => {
    setSaving(true)
    try { await saveQueue({ name: q.name, jql: jql.trim() || null }); setError(null); toast('Queue saved', 'success') }
    catch (e) { const info = jqlErrorFrom(e); if (info) setError(info); else onErr(e as Error) }
    finally { setSaving(false) }
  }
  return (
    <li className="veqsio-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">{q.name}</span>
        {canEdit && (
          <>
            <button className="veqsio-btn-ghost p-1.5" aria-label={`Move ${q.name} up`} disabled={first} onClick={() => onMove(-1)}><ArrowUp className="w-4 h-4" /></button>
            <button className="veqsio-btn-ghost p-1.5" aria-label={`Move ${q.name} down`} disabled={last} onClick={() => onMove(1)}><ArrowDown className="w-4 h-4" /></button>
            <button className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Delete ${q.name}`} onClick={onDelete}><Trash2 className="w-4 h-4" /></button>
          </>
        )}
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">JQL</span>
        <textarea
          rows={2} maxLength={2000} readOnly={!canEdit} spellCheck={false}
          className={`veqsio-input w-full font-mono text-sm ${error ? 'border-[var(--error)]' : ''}`}
          value={jql} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
          onChange={(e) => { setJql(e.target.value); setError(null) }}
          placeholder="Empty shows every request of this desk"
        />
      </label>
      {error && <JqlError id={errId} jql={jql} error={error} />}
      {canEdit && dirty && (
        <div className="flex gap-2">
          <button className="veqsio-btn-primary" disabled={saving} onClick={save}>Save JQL</button>
          <button className="veqsio-btn-secondary" disabled={saving} onClick={() => { setJql(q.jql ?? ''); setError(null) }}>Cancel</button>
        </div>
      )}
    </li>
  )
}

/** Project settings > Queues */
export default function QueuesSettingsPage() {
  const id = Number(useParams<{ id: string }>().id)
  const { isAdmin } = useDeskAdmin(id)
  const queues = useAdminQueues(id)
  const save = useSaveQueue(id)
  const del = useDeleteQueue(id)
  const [name, setName] = useState('')
  const [jql, setJql] = useState('resolution = Unresolved')
  const [createError, setCreateError] = useState<JqlErrorInfo | null>(null)

  const list = queues.data?.values ?? []
  const swap = (a: DeskQueue, b: DeskQueue) => {
    save.mutate({ qid: a.id, name: a.name, jql: a.jql, sortOrder: b.sortOrder }, { onError: onErr })
    save.mutate({ qid: b.id, name: b.name, jql: b.jql, sortOrder: a.sortOrder }, { onError: onErr })
  }

  return (
    <section className="space-y-4 max-w-2xl" aria-labelledby="q-h">
      <h2 id="q-h" className="text-heading-2">Queues</h2>
      <p className="text-sm text-[var(--text-secondary)]">
        A queue is a saved JQL query over this desk&apos;s requests. Anything the JQL search understands works, including <code>currentUser()</code>, relative dates and <code>ORDER BY</code> (the queue&apos;s sort). It is always narrowed to this desk&apos;s project.
      </p>

      {isAdmin && (
        <form className="veqsio-card p-4 space-y-3" onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ name: name.trim(), jql: jql.trim() || null, sortOrder: list.length }, {
            onSuccess: () => { setName(''); setCreateError(null); toast('Queue created', 'success') },
            onError: (err) => { const info = err instanceof ApiError ? jqlErrorFrom(err) : null; if (info) setCreateError(info); else onErr(err) },
          })
        }}>
          <h3 className="text-sm font-semibold">New queue</h3>
          <label className="block space-y-1"><span className="text-sm font-medium">Name</span><input required maxLength={255} className="veqsio-input w-full" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">JQL</span>
            <textarea rows={2} maxLength={2000} spellCheck={false} className={`veqsio-input w-full font-mono text-sm ${createError ? 'border-[var(--error)]' : ''}`}
              value={jql} placeholder={EXAMPLE} aria-invalid={createError ? true : undefined} aria-describedby={createError ? 'q-new-err' : undefined}
              onChange={(e) => { setJql(e.target.value); setCreateError(null) }} />
          </label>
          {createError && <JqlError id="q-new-err" jql={jql} error={createError} />}
          <button type="submit" className="veqsio-btn-primary" disabled={save.isPending}>Create queue</button>
        </form>
      )}

      {queues.isLoading && <Spinner />}
      <ul className="space-y-2">
        {list.map((q, i) => (
          <QueueEditor
            key={`${q.id}:${q.jql ?? ''}`} q={q} canEdit={isAdmin} first={i === 0} last={i === list.length - 1}
            onMove={(dir) => swap(q, list[i + dir])}
            onDelete={async () => { if ((await confirmDialog(`Delete queue ${q.name}?`))) del.mutate(q.id, { onError: onErr }) }}
            saveQueue={(v) => save.mutateAsync({ qid: q.id, ...v })}
          />
        ))}
      </ul>
    </section>
  )
}
