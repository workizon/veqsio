'use client'

import { RichTextEditor } from '@/components/rich-text-editor'
import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { useCannedResponses, useDeleteCanned, useDesks, useSaveCanned } from '@/hooks/use-servicedesk'
import { confirmDialog } from '@/components/dialogs'

export default function CannedResponsesPage() {
  const id = Number(useParams<{ id: string }>().id)
  const desks = useDesks()
  const canned = useCannedResponses(id)
  const save = useSaveCanned(id)
  const del = useDeleteCanned(id)
  const isAdmin = desks.data?.values.find((d) => d.id === id)?.role === 'admin'

  const [editId, setEditId] = useState<number | undefined>()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const reset = () => { setEditId(undefined); setTitle(''); setBody('') }

  return (
    <>
      <div className="space-y-4">
        <PageHeader title="Canned responses" actions={<><Link href={`/servicedesk/${id}`} className="veqsio-btn-secondary">Back to service desk</Link></>} />
        <p className="text-sm text-[var(--text-secondary)]">
          Reusable replies for agents. Placeholders: <code>{'{{customer.name}}'}</code>, <code>{'{{issue.key}}'}</code>.
        </p>

        {canned.isLoading && <Spinner />}
        {canned.error && <div role="alert" className="text-[var(--error)]">{canned.error.message}</div>}

        <ul className="space-y-2">
          {canned.data?.values.length === 0 && <li className="text-[var(--text-tertiary)]">No canned responses yet</li>}
          {canned.data?.values.map((c) => (
            <li key={c.id} className="veqsio-card p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <strong>{c.title}</strong>
                {isAdmin && (
                  <div className="flex gap-2">
                    <button className="veqsio-btn-secondary text-sm" onClick={() => { setEditId(c.id); setTitle(c.title); setBody(c.body) }}>
                      Edit<span className="sr-only"> {c.title}</span>
                    </button>
                    <button
                      className="veqsio-btn-secondary text-sm"
                      disabled={del.isPending}
                      onClick={async () => { if ((await confirmDialog(`Delete "${c.title}"?`))) del.mutate(c.id) }}
                    >
                      Delete<span className="sr-only"> {c.title}</span>
                    </button>
                  </div>
                )}
              </div>
              <pre className="whitespace-pre-wrap text-sm text-[var(--text-secondary)] font-sans">{c.body}</pre>
            </li>
          ))}
        </ul>

        {isAdmin && (
          <form
            className="veqsio-card p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate({ id: editId, title: title.trim(), body }, { onSuccess: reset })
            }}
          >
            <h2 className="text-heading-2">{editId ? 'Edit response' : 'New response'}</h2>
            <div className="space-y-1">
              <label htmlFor="canned-title" className="text-sm">Title</label>
              <input id="canned-title" className="veqsio-input w-full" maxLength={200} required value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="canned-body" className="text-sm">Text</label>
              <RichTextEditor id="canned-body" label="Text" rows={6} maxLength={10000} mentions={false} value={body} onChange={setBody} />
            </div>
            {save.error && <div role="alert" className="text-[var(--error)]">{save.error.message}</div>}
            <div className="flex gap-2">
              <button type="submit" className="veqsio-btn-primary" disabled={save.isPending || !title.trim() || !body.trim()}>
                {editId ? 'Save' : 'Create'}
              </button>
              {editId && <button type="button" className="veqsio-btn-secondary" onClick={reset}>Cancel</button>}
            </div>
          </form>
        )}
      </div>
    </>
  )
}
