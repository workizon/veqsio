'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'

export interface SprintAutomation { autoCreateNext: boolean; durationDays: number; autoMoveIncomplete: 'next' | 'backlog' }

/** Board setting: when a sprint is completed, create the next one and carry unfinished work over. */
export function SprintAutomationDialog({ boardId, initial, onClose }: { boardId: number; initial: SprintAutomation; onClose: () => void }) {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const [v, setV] = useState<SprintAutomation>(initial)
  const [busy, setBusy] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch(`/rest/agile/1.0/board/${boardId}/sprint-automation`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
      await qc.invalidateQueries()
      toast(tr('Sprint automation saved'), 'success')
      onClose()
    } catch (err) { toast((err as Error).message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title={tr('Sprint automation')}>
      <form onSubmit={save} className="space-y-4">
        <label className="flex items-start gap-3 text-body">
          <input type="checkbox" className="mt-1" checked={v.autoCreateNext} onChange={(e) => setV({ ...v, autoCreateNext: e.target.checked })} />
          <span>{tr('Create the next sprint when a sprint is completed')} <span className="block text-body-sm text-[var(--text-secondary)]">{tr('Named by counting up (Sprint 12 → Sprint 13), starts on the completion day. An existing future sprint is used instead of creating another.')}</span>
          </span>
        </label>
        <label className="block text-body">{tr('Length of an automatic sprint (days)')} <input type="number" min={1} max={90} className="veqsio-input mt-1 w-32" value={v.durationDays} disabled={!v.autoCreateNext} onChange={(e) => setV({ ...v, durationDays: Number(e.target.value) })} />
        </label>
        <label className="block text-body">{tr('Unfinished issues go to')} <select className="veqsio-input mt-1" value={v.autoMoveIncomplete} disabled={!v.autoCreateNext} onChange={(e) => setV({ ...v, autoMoveIncomplete: e.target.value as 'next' | 'backlog' })}>
            <option value="backlog">{tr('The backlog')}</option>
            <option value="next">{tr('The next sprint')}</option>
          </select>
          <span className="block text-body-sm text-[var(--text-secondary)]">{tr('Whoever completes a sprint can still pick another target in the dialog.')}</span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="veqsio-btn-primary" disabled={busy}>{tr('Save')}</button>
        </div>
      </form>
    </Modal>
  )
}
