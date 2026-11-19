'use client'

import { useId, useState } from 'react'
import { renderCannedResponse, useCannedResponses } from '@/hooks/use-servicedesk'

/** Lets service desk staff insert a rendered canned response into the comment box. */
export function CannedResponseSelect({ deskId, issueKey, onInsert }: {
  deskId: number
  issueKey: string
  onInsert: (text: string) => void
}) {
  const id = useId()
  const canned = useCannedResponses(deskId)
  const [error, setError] = useState<string | null>(null)
  const items = canned.data?.values ?? []
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={id}>Canned response</label>
      <select
        id={id}
        className="veqsio-input max-w-xs"
        value=""
        onChange={async (e) => {
          const cid = Number(e.target.value)
          if (!cid) return
          setError(null)
          try {
            const r = await renderCannedResponse(deskId, cid, issueKey)
            onInsert(r.body)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load response')
          }
        }}
      >
        <option value="">Insert a canned response...</option>
        {items.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
      </select>
      {error && <span role="alert" className="text-[var(--error)]">{error}</span>}
    </div>
  )
}
