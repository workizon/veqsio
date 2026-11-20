'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useId, useState } from 'react'
import { renderCannedResponse, useCannedResponses } from '@/hooks/use-servicedesk'

/** Lets service desk staff insert a rendered canned response into the comment box. */
export function CannedResponseSelect({ deskId, issueKey, onInsert }: {
  deskId: number
  issueKey: string
  onInsert: (text: string) => void
}) {
  const { tr } = useI18n();

  const id = useId()
  const canned = useCannedResponses(deskId)
  const [error, setError] = useState<string | null>(null)
  const items = canned.data?.values ?? []
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={id}>{tr('Canned response')}</label>
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
            setError(err instanceof Error ? err.message : tr('Could not load response'))
          }
        }}
      >
        <option value="">{tr('Insert a canned response...')}</option>
        {items.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
      </select>
      {error && <span role="alert" className="text-[var(--error)]">{error}</span>}
    </div>
  )
}
