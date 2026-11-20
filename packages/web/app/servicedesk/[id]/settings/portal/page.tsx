'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useDesk, useDeskAdmin, usePortalSettings, useSavePortalSettings, useUpdateDesk } from '@/hooks/use-servicedesk-admin'

interface GroupRow { name: string; original?: string; count: number }

/** Project settings > Portal settings */
export default function PortalSettingsPage() {
  const { tr } = useI18n();

  const id = Number(useParams<{ id: string }>().id)
  const desk = useDesk(id)
  const settings = usePortalSettings(id)
  const { isAdmin } = useDeskAdmin(id)
  const updateDesk = useUpdateDesk(id)
  const save = useSavePortalSettings(id)

  const [title, setTitle] = useState('')
  const [intro, setIntro] = useState('')
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!settings.data) return
    setTitle(settings.data.portalTitle ?? ''); setIntro(settings.data.introduction ?? '')
    setGroups(settings.data.groups.map((g) => ({ name: g.name, original: g.name, count: g.requestTypeCount })))
  }, [settings.data])

  const move = (i: number, d: -1 | 1) => setGroups((g) => {
    const j = i + d
    if (j < 0 || j >= g.length) return g
    const n = [...g]; [n[i], n[j]] = [n[j], n[i]]; return n
  })
  const names = groups.map((g) => g.name.trim().toLowerCase())
  const dup = names.some((n, i) => !n || names.indexOf(n) !== i)

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (dup) { setError('Group names must be unique and not empty'); return }
    try {
      await save.mutateAsync({
        portalTitle: title.trim() || null, introduction: intro.trim() || null,
        groups: groups.map((g) => ({ name: g.name.trim(), ...(g.original && g.original !== g.name.trim() ? { renamedFrom: g.original } : {}) })),
      })
      toast(tr('Portal settings saved'), 'success')
    } catch (err) { setError((err as Error).message) }
  }

  if (!desk.data || !settings.data) return <Spinner />
  return (
    <div className="space-y-6 max-w-2xl">
      <section className="veqsio-card p-5 space-y-3" aria-labelledby="avail">
        <h2 id="avail" className="text-heading-2">{tr('Availability')}</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={!isAdmin || updateDesk.isPending} checked={desk.data.enabled} onChange={(e) => updateDesk.mutate({ enabled: e.target.checked }, { onError: (er) => toast(er.message, 'error') })} />
          <span><span className="font-medium">{tr('Portal enabled')}</span><br /><span className="text-[var(--text-secondary)]">{tr('When off, customers get a “not available” page. Agents keep working in the queues.')}</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={!isAdmin || updateDesk.isPending} checked={desk.data.publicSignup} onChange={(e) => updateDesk.mutate({ publicSignup: e.target.checked }, { onError: (er) => toast(er.message, 'error') })} />
          <span><span className="font-medium">{tr('Anyone with an account can sign up')}</span><br /><span className="text-[var(--text-secondary)]">{tr('Off: only customers you invite can raise requests.')}</span></span>
        </label>
        <p className="text-sm">{tr('Portal address:')} <Link className="text-[var(--brand-500)] hover:underline font-mono" href={`/portal/${desk.data.slug}`}>/portal/{desk.data.slug}</Link></p>
      </section>

      <form onSubmit={onSave} className="veqsio-card p-5 space-y-4" aria-label={tr('Portal content')}>
        <h2 className="text-heading-2">{tr('Portal content')}</h2>
        <fieldset disabled={!isAdmin} className="space-y-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{tr('Portal title')}</span>
            <input className="veqsio-input w-full" maxLength={255} placeholder={desk.data.name} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{tr('Introduction')}</span>
            <textarea rows={3} maxLength={5000} className="veqsio-input w-full" value={intro} onChange={(e) => setIntro(e.target.value)} />
          </label>

          <div className="space-y-2">
            <h3 className="text-sm font-medium" id="groups-h">{tr('Request type groups')}</h3>
            <p className="text-xs text-[var(--text-tertiary)]">{tr('Groups appear in this order on the portal. Assign request types to a group in the request type settings; order inside a group follows the request type list.')}</p>
            <ul aria-labelledby="groups-h" className="space-y-2">
              {groups.length === 0 && <li className="text-sm text-[var(--text-tertiary)]">{tr('No groups yet. Request types without a group appear under “General”.')}</li>}
              {groups.map((g, i) => (
                <li key={g.original ?? `new-${i}`} className="flex items-center gap-2">
                  <input aria-label={`Group ${i + 1} name`} className="veqsio-input flex-1" maxLength={100} value={g.name} onChange={(e) => setGroups((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <span className="text-xs text-[var(--text-tertiary)] w-20 text-right">{g.count} type{g.count === 1 ? '' : 's'}</span>
                  <button type="button" className="veqsio-btn-ghost p-1.5" aria-label={`Move ${g.name || 'group'} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="w-4 h-4" /></button>
                  <button type="button" className="veqsio-btn-ghost p-1.5" aria-label={`Move ${g.name || 'group'} down`} disabled={i === groups.length - 1} onClick={() => move(i, 1)}><ArrowDown className="w-4 h-4" /></button>
                  <button type="button" className="veqsio-btn-ghost p-1.5 text-[var(--error)]" aria-label={`Remove ${g.name || 'group'}`} disabled={g.count > 0} title={g.count > 0 ? 'Move its request types to another group first' : 'Remove group'} onClick={() => setGroups((all) => all.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>
                </li>
              ))}
            </ul>
            <button type="button" className="veqsio-btn-secondary text-sm inline-flex items-center gap-1" onClick={() => setGroups((g) => [...g, { name: '', count: 0 }])}><Plus className="w-3.5 h-3.5" aria-hidden />{tr('Add group')}</button>
          </div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
        {isAdmin && <button type="submit" className="veqsio-btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save portal settings'}</button>}
        <p className="text-xs text-[var(--text-tertiary)]">{tr('Logo and accent colour are under')} <Link className="text-[var(--brand-500)] hover:underline" href={`/servicedesk/${id}/settings`}>{tr('Details')}</Link>. Request types are managed under <Link className="text-[var(--brand-500)] hover:underline" href={`/servicedesk/${id}/settings/request-types`}>{tr('Request types')}</Link>.</p>
      </form>
    </div>
  )
}
