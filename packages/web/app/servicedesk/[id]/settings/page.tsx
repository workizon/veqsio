'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { toast } from '@/components/toast'
import { useDesk, useDeskAdmin, usePortalSettings, useSavePortalSettings, useUpdateDesk } from '@/hooks/use-servicedesk-admin'

/** Project settings > Details */
export default function DeskDetailsPage() {
  const id = Number(useParams<{ id: string }>().id)
  const desk = useDesk(id)
  const portal = usePortalSettings(id)
  const { isAdmin } = useDeskAdmin(id)
  const update = useUpdateDesk(id)
  const savePortal = useSavePortalSettings(id)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [welcome, setWelcome] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [accent, setAccent] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!desk.data) return
    setName(desk.data.name); setDescription(desk.data.description ?? ''); setWelcome(desk.data.welcomeMessage ?? '')
  }, [desk.data])
  useEffect(() => {
    if (!portal.data) return
    setLogoUrl(portal.data.logoUrl ?? ''); setAccent(portal.data.accentColor ?? '')
  }, [portal.data])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await update.mutateAsync({ name: name.trim(), description: description.trim() || null, welcomeMessage: welcome.trim() || null })
      await savePortal.mutateAsync({ logoUrl: logoUrl.trim() || null, accentColor: accent.trim() || null })
      toast('Details saved', 'success')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!desk.data) return null
  return (
    <form onSubmit={save} className="veqsio-card p-5 space-y-4 max-w-2xl" aria-label="Service desk details">
      <h2 className="text-heading-2 text-[var(--text-primary)]">Details</h2>
      <fieldset disabled={!isAdmin} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Name</span>
          <input required maxLength={255} className="veqsio-input w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="block text-sm font-medium">Project key</span>
            <div className="veqsio-input w-full font-mono bg-[var(--surface-2)]" aria-label="Project key">{desk.data.projectKey ?? 'n/a'}</div>
            <p className="text-xs text-[var(--text-tertiary)]">Issue keys look like {desk.data.projectKey ?? 'KEY'}-123. The key cannot be changed.</p>
          </div>
          <div className="space-y-1">
            <span className="block text-sm font-medium">Portal address</span>
            <div className="veqsio-input w-full font-mono bg-[var(--surface-2)] truncate">/portal/{desk.data.slug}</div>
          </div>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Description</span>
          <textarea rows={3} maxLength={5000} className="veqsio-input w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Welcome message</span>
          <textarea rows={3} maxLength={5000} className="veqsio-input w-full" value={welcome} onChange={(e) => setWelcome(e.target.value)} aria-describedby="welcome-help" />
          <span id="welcome-help" className="block text-xs text-[var(--text-tertiary)]">Shown at the top of your portal.</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Logo URL <span className="text-[var(--text-tertiary)] font-normal">(optional)</span></span>
            <input type="url" className="veqsio-input w-full" placeholder="https://" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
          </label>
          <div className="space-y-1">
            <label htmlFor="accent" className="block text-sm font-medium">Accent colour <span className="text-[var(--text-tertiary)] font-normal">(optional)</span></label>
            <div className="flex items-center gap-2">
              <input
                type="color" aria-label="Pick accent colour" className="h-9 w-12 rounded border border-[var(--surface-4)] bg-transparent p-1"
                value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#3d6af0'} onChange={(e) => setAccent(e.target.value)}
              />
              <input id="accent" className="veqsio-input w-full font-mono" placeholder="#3D6AF0" maxLength={7} value={accent} onChange={(e) => setAccent(e.target.value)} />
              {accent && <button type="button" className="veqsio-btn-ghost text-sm" onClick={() => setAccent('')}>Reset</button>}
            </div>
          </div>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
      {isAdmin && (
        <button type="submit" className="veqsio-btn-primary" disabled={update.isPending || savePortal.isPending}>
          {update.isPending || savePortal.isPending ? 'Saving…' : 'Save changes'}
        </button>
      )}
    </form>
  )
}
