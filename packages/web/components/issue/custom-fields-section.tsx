'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Pencil, X } from 'lucide-react'
import { CustomFieldInput, type MetaField, type MetaProject } from '@/components/custom-field-input'
import { useUpdateIssue, type ApiIssue } from '@/hooks/use-issues'
import { toast } from '@/components/toast'
import { CollapsibleSection, FieldRow } from './primitives'

/** Values reach the issue as customfield_<id>; multiple choices are stored as "a, b". */
function toInput(field: MetaField, raw: unknown): unknown {
  const type = field.schema?.type
  if (type === 'multiselect' || type === 'checkbox') {
    if (typeof raw === 'boolean') return raw
    return typeof raw === 'string' && raw ? raw.split(',').map((x) => x.trim()) : []
  }
  if (type === 'date' && typeof raw === 'string') return raw.slice(0, 10)
  return raw ?? ''
}

function show(field: MetaField, raw: unknown, users: Map<number, string>): React.ReactNode {
  const none = <span className="text-[var(--text-tertiary)]">None</span>
  if (raw === null || raw === undefined || raw === '') return none
  const type = field.schema?.type
  if (type === 'checkbox' && typeof raw === 'boolean') return raw ? 'Yes' : 'No'
  if (type === 'date' && typeof raw === 'string') return new Date(raw).toLocaleDateString()
  if (type === 'datetime' && typeof raw === 'string') return new Date(raw).toLocaleString()
  if (type === 'url' && typeof raw === 'string') {
    // only a web address becomes a link: older data may hold anything, and `javascript:` in a link runs when somebody clicks it
    return /^https?:\/\/[^\s]+$/i.test(raw.trim())
      ? <a href={raw.trim()} target="_blank" rel="noopener noreferrer" className="text-[var(--brand-500)] hover:underline break-all">{raw}</a>
      : <span className="break-all">{raw}</span>
  }
  if (type === 'userpicker') return users.get(Number(raw)) ?? `User #${String(raw)}`
  if (type === 'textarea') return <span className="whitespace-pre-wrap">{String(raw)}</span>
  if (type === 'multiselect') return <span className="flex flex-wrap gap-1">{String(raw).split(',').map((x) => <span key={x} className="veqsio-badge">{x.trim()}</span>)}</span>
  return String(raw)
}

/** The custom fields that apply to this issue (its project and type), with click-to-edit. */
export function CustomFieldsSection({ issue }: { issue: ApiIssue }) {
  const projectKey = issue.fields.project?.key
  const typeId = String(issue.fields.issuetype?.id ?? '')
  const update = useUpdateIssue()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>('')

  const meta = useQuery({
    queryKey: ['createmeta', projectKey],
    enabled: !!projectKey,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey!)}&expand=projects.issuetypes.fields`, { credentials: 'include' })
      return r.ok ? (((await r.json()) as { projects: MetaProject[] }).projects[0] ?? null) : null
    },
  })
  const users = useQuery({
    queryKey: ['users-by-id'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch('/rest/api/2/user?maxResults=100', { credentials: 'include' })
      const list = r.ok ? ((await r.json()) as { values: Array<{ id: number; name: string }> }).values : []
      return new Map(list.map((u) => [u.id, u.name]))
    },
  })

  const type = meta.data?.issuetypes.find((t) => t.id === typeId)
  const fields = Object.values(type?.fields ?? {}).filter((f) => f.key.startsWith('customfield_'))
  if (fields.length === 0) return null
  const raw = issue.fields as unknown as Record<string, unknown>

  async function save(field: MetaField) {
    const value = Array.isArray(draft) ? draft.join(', ') : draft
    try {
      await update.mutateAsync({ key: issue.key, fields: { customFields: [{ fieldId: Number(field.key.replace('customfield_', '')), value: value === '' ? null : value }] } })
      setEditing(null)
    } catch (err: any) {
      toast(err?.message || 'Failed to update the field', 'error')
    }
  }

  return (
    <CollapsibleSection id="custom-fields" title="Custom fields">
      {fields.map((f) => (
        <FieldRow key={f.key} label={f.name}>
          {editing === f.key ? (
            <div className="space-y-2 py-1">
              <CustomFieldInput field={f} value={draft} onChange={setDraft} />
              <div className="flex gap-2">
                <button type="button" onClick={() => void save(f)} disabled={update.isPending} className="veqsio-btn-primary px-2 py-1 text-sm inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" />Save</button>
                <button type="button" onClick={() => setEditing(null)} className="veqsio-btn-secondary px-2 py-1 text-sm inline-flex items-center gap-1"><X className="w-3.5 h-3.5" />Cancel</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setDraft(toInput(f, raw[f.key])); setEditing(f.key) }}
              title={f.description ? `${f.description} (click to edit)` : 'Click to edit'}
              className="group w-full text-left rounded px-1 -mx-1 py-1 hover:bg-[var(--surface-2)] inline-flex items-start gap-2"
            >
              <span className="min-w-0 flex-1">{show(f, raw[f.key], users.data ?? new Map())}</span>
              <Pencil className="w-3 h-3 mt-1 shrink-0 opacity-0 group-hover:opacity-60" aria-hidden="true" />
            </button>
          )}
        </FieldRow>
      ))}
    </CollapsibleSection>
  )
}
