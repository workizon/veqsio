'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { RequestTypeIcon } from '@/components/request-type-icon'
import {
  ApiError, useAdminRequestTypes, useCreateRequestType, useDeleteRequestType, useDeskAdmin, useDuplicateRequestType,
  useFormContext, useReorderRequestTypes, useUpdateRequestType, type RequestTypeFull,
} from '@/hooks/use-servicedesk-admin'

/** Project settings > Request types */
export default function RequestTypesPage() {
  const { tr } = useI18n();

  const id = Number(useParams<{ id: string }>().id)
  const router = useRouter()
  const list = useAdminRequestTypes(id)
  const { isAdmin } = useDeskAdmin(id)
  const ctx = useFormContext(isAdmin ? id : NaN)
  const create = useCreateRequestType(id)
  const update = useUpdateRequestType(id)
  const dup = useDuplicateRequestType(id)
  const del = useDeleteRequestType(id)
  const reorder = useReorderRequestTypes(id)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [issueTypeId, setIssueTypeId] = useState('')
  const [group, setGroup] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<RequestTypeFull | null>(null)

  const types = list.data?.values ?? []
  const move = (i: number, dir: -1 | 1) => {
    const ids = types.map((t) => t.id)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    reorder.mutate(ids, { onError: (e) => toast(e.message, 'error') })
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    const typeId = Number(issueTypeId || ctx.data?.issueTypes[0]?.id)
    if (!typeId) { setFormError('No issue type is available'); return }
    try {
      const rt = await create.mutateAsync({ name: name.trim(), issueTypeId: typeId, groupName: group.trim() || null, fields: [] })
      router.push(`/servicedesk/${id}/settings/request-types/${rt.id}`)
    } catch (err) {
      setFormError((err as Error).message)
    }
  }

  async function confirmDelete() {
    if (!toDelete) return
    if ((toDelete.requestCount ?? 0) > 0) {
      // Existing requests keep their request type: offer the safe alternative instead of a doomed delete.
      try {
        await update.mutateAsync({ rtId: toDelete.id, body: { enabled: false } })
        toast(`${toDelete.name} was disabled instead`, 'info')
        setToDelete(null)
      } catch (err) { toast((err as Error).message, 'error') }
      return
    }
    try {
      await del.mutateAsync(toDelete.id)
      toast(`Deleted ${toDelete.name}`, 'success')
      setToDelete(null)
    } catch (err) {
      const e = err as ApiError
      toast(e.message, 'error')
      if (e.status === 409) {
        // Offer the safe alternative right away.
        await update.mutateAsync({ rtId: toDelete.id, body: { enabled: false } }).catch(() => {})
        toast(`${toDelete.name} was disabled instead`, 'info')
        setToDelete(null)
      }
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="rt-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="rt-heading" className="text-heading-2 text-[var(--text-primary)]">{tr('Request types')}</h2>
          <p className="text-sm text-[var(--text-secondary)]">{tr('What your customers can ask for. Each request type has its own form.')}</p>
        </div>
        {isAdmin && <button className="veqsio-btn-primary inline-flex items-center gap-2" onClick={() => { setCreating(true); setName(''); setGroup(''); setFormError(null) }}><Plus className="w-4 h-4" aria-hidden />{tr('Create request type')}</button>}
      </div>

      {list.isLoading && <Spinner />}
      {list.error && <div role="alert" className="text-[var(--error)]">{list.error.message}</div>}
      {list.data && types.length === 0 && <p className="text-[var(--text-tertiary)]">{tr('No request types yet.')}</p>}

      <ul className="space-y-2">
        {types.map((t, i) => (
          <li key={t.id} className="veqsio-card p-3 flex flex-wrap items-center gap-3">
            <span className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center text-[var(--brand-500)] shrink-0"><RequestTypeIcon name={t.icon} /></span>
            <div className="min-w-0 flex-1">
              <Link href={`/servicedesk/${id}/settings/request-types/${t.id}`} className="font-medium text-[var(--text-primary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)]">{t.name}</Link>
              <p className="text-xs text-[var(--text-tertiary)]">
                {t.groupName || 'General'} · {t.fields.filter((f) => f.type !== 'section' && f.type !== 'help').length} {tr('fields ·')} {t.requestCount ?? 0} requests
                {t.visibility === 'organizations' && ' · restricted to organizations'}
                {!t.enabled && ' · disabled'}
              </p>
            </div>
            {isAdmin && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox" checked={t.enabled} disabled={update.isPending}
                  onChange={(e) => update.mutate({ rtId: t.id, body: { enabled: e.target.checked } }, { onError: (er) => toast(er.message, 'error') })}
                />
                {tr('Enabled')}<span className="sr-only"> {t.name}</span>
              </label>
            )}
            <div className="flex items-center gap-1">
              {isAdmin && (
                <>
                  <button className="veqsio-btn-ghost p-2" aria-label={`Move ${t.name} up`} disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}><ArrowUp className="w-4 h-4" /></button>
                  <button className="veqsio-btn-ghost p-2" aria-label={`Move ${t.name} down`} disabled={i === types.length - 1 || reorder.isPending} onClick={() => move(i, 1)}><ArrowDown className="w-4 h-4" /></button>
                  <button className="veqsio-btn-ghost p-2" aria-label={`Duplicate ${t.name}`} disabled={dup.isPending} onClick={() => dup.mutate(t.id, { onSuccess: (c) => toast(`Created ${c.name} (disabled)`, 'success'), onError: (e) => toast(e.message, 'error') })}><Copy className="w-4 h-4" /></button>
                  <button className="veqsio-btn-ghost p-2 text-[var(--error)]" aria-label={`Delete ${t.name}`} onClick={() => setToDelete(t)}><Trash2 className="w-4 h-4" /></button>
                </>
              )}
              <Link href={`/servicedesk/${id}/settings/request-types/${t.id}`} className="veqsio-btn-secondary text-sm">{isAdmin ? 'Edit form' : 'View form'}</Link>
            </div>
          </li>
        ))}
      </ul>

      <Modal isOpen={creating} onClose={() => setCreating(false)} title={tr('Create request type')}>
        <form onSubmit={submitCreate} className="space-y-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{tr('Name')}</span>
            <input autoFocus required maxLength={255} className="veqsio-input w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{tr('Issue type created for each request')}</span>
            <select className="veqsio-input w-full" value={issueTypeId} onChange={(e) => setIssueTypeId(e.target.value)}>
              {ctx.data?.issueTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{tr('Portal group')} <span className="font-normal text-[var(--text-tertiary)]">{tr('(optional)')}</span></span>
            <input maxLength={100} className="veqsio-input w-full" value={group} onChange={(e) => setGroup(e.target.value)} />
          </label>
          {formError && <p role="alert" className="text-sm text-[var(--error)]">{formError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="veqsio-btn-secondary" onClick={() => setCreating(false)}>{tr('Cancel')}</button>
            <button type="submit" className="veqsio-btn-primary" disabled={create.isPending || !name.trim()}>{tr('Create and edit form')}</button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!toDelete} onClose={() => setToDelete(null)} title={tr('Delete request type')}>
        <div className="space-y-4">
          <p className="text-sm">
            {tr('Delete')} <strong>{toDelete?.name}</strong> {tr('and its form?')} {(toDelete?.requestCount ?? 0) > 0
              ? `It has ${toDelete?.requestCount} existing requests, so it cannot be deleted. It will be disabled instead and disappear from the portal.`
              : 'This cannot be undone.'}
          </p>
          <div className="flex justify-end gap-2">
            <button className="veqsio-btn-secondary" onClick={() => setToDelete(null)}>{tr('Cancel')}</button>
            <button className="veqsio-btn-primary" onClick={confirmDelete} disabled={del.isPending}>
              {(toDelete?.requestCount ?? 0) > 0 ? 'Disable instead' : 'Delete'}
            </button>
          </div>
        </div>
      </Modal>
    </section>
  )
}
