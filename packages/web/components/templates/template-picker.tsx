'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { toast } from '@/components/toast'
import { fetchPrefill, useIssueTemplates, type TemplatePrefill } from '@/hooks/use-templates'
import { useTerm } from '@/hooks/use-term'

/**
 * "Create from template" select for the create dialogs. Renders nothing while the project has no templates.
 * Choosing one asks the server for the prefilled values (placeholders resolved, components mapped to this project)
 * and hands them to the form, which stays fully editable.
 */
export function TemplatePicker({ projectKey, onApply, onClear }: { projectKey: string | undefined; onApply: (p: TemplatePrefill) => void; onClear?: () => void }) {
  const { tr } = useI18n();

  const { t } = useTerm()
  const list = useIssueTemplates(projectKey, !!projectKey)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const templates = list.data?.templates ?? []
  if (!projectKey || templates.length === 0) return null

  const choose = async (value: string) => {
    setSelected(value)
    if (!value) { onClear?.(); return }
    setBusy(true)
    try {
      onApply(await fetchPrefill(Number(value), projectKey))
    } catch (e) {
      setSelected('')
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <label htmlFor="create-template" className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">{t('Create from template')}</label>
      <select id="create-template" className="veqsio-input w-full" value={selected} disabled={busy} onChange={(e) => void choose(e.target.value)}>
        <option value="">{tr('No template')}</option>
        {templates.map((x) => <option key={x.id} value={x.id}>{x.name}{x.scope === 'global' ? ' (global)' : ''}</option>)}
      </select>
    </div>
  )
}
