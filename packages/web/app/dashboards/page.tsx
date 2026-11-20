'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { useDashboards, useCreateDashboard, useSetDefaultDashboard } from '@/hooks/use-dashboards'
import { EmptyState } from '@/components/empty-state'
import { Modal } from '@/components/modal'
import { LayoutDashboard, Plus, ArrowUpRight, SlidersHorizontal, UserRound, Star } from 'lucide-react'
import { toast } from '@/components/toast'

export default function DashboardsPage() {
  const { tr } = useI18n();

  const router = useRouter()
  const { data: dashboards = [], isLoading, isError, refetch } = useDashboards()
  const createDashboard = useCreateDashboard()
  const setDefault = useSetDefaultDashboard()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!newName.trim() || createDashboard.isPending) return
    setError('')
    try {
      const dashboard = await createDashboard.mutateAsync({ name: newName.trim() })
      router.push(`/dashboards/${dashboard.id}`)
    } catch (error) {
      setError(error instanceof Error ? error.message : tr('Unable to create dashboard. Please try again.'))
    }
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title={tr('My dashboards')}
          description={tr('Combine your assigned issues, saved filters and charts. Add, configure and rearrange widgets on each dashboard.')}
          actions={<button onClick={() => { setError(''); setCreateOpen(true) }} className="veqsio-btn-primary"><Plus className="w-4 h-4" aria-hidden="true" />{tr('Create dashboard')}</button>}
        />

        <div className="flex items-start gap-4 rounded-xl border border-[var(--surface-3)] bg-[var(--surface-0)] p-5">
          <div className="rounded-lg bg-[var(--brand-50)] p-2.5 text-[var(--brand-600)]"><SlidersHorizontal className="w-5 h-5" aria-hidden="true" /></div>
          <div><h2 className="text-sm font-semibold text-[var(--text-primary)]">{tr('Make room for what matters')}</h2><p className="text-sm text-[var(--text-secondary)] mt-1 leading-6">{tr('Combine your assigned issues, saved filters and charts. Add, configure and rearrange widgets on each dashboard.')}</p></div>
        </div>

        {isLoading ? (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-label={tr('Loading dashboards')} role="status">
            {[0, 1, 2].map((n) => <div key={n} className="veqsio-card h-48 animate-pulse"><div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] mb-6" /><div className="w-40 h-5 rounded bg-[var(--surface-2)]" /></div>)}
          </div>
        ) : isError ? (
          <EmptyState icon="frown" title={tr('Unable to load your dashboards')} description={tr('Please try again. Your dashboards have not been changed.')} action={<button onClick={() => void refetch()} className="veqsio-btn-secondary">{tr('Retry')}</button>} />
        ) : dashboards.length === 0 ? (
          <div className="veqsio-card py-12"><EmptyState icon="folder" title={tr('Build your first dashboard')} description={tr('Start with a blank canvas, then add the widgets you use every day.')} action={<button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary"><Plus className="w-4 h-4" />{tr('Create dashboard')}</button>} /></div>
        ) : (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {dashboards.map((dashboard) => (
              <div key={dashboard.id} className="relative">
                <Link href={`/dashboards/${dashboard.id}`} className="veqsio-card group flex flex-col min-h-48">
                  <div className="flex items-center justify-between mb-6"><div className="w-10 h-10 rounded-lg bg-[var(--brand-50)] flex items-center justify-center"><LayoutDashboard className="w-5 h-5 text-[var(--brand-600)]" /></div><ArrowUpRight className="w-4 h-4 text-[var(--text-tertiary)] group-hover:text-[var(--brand-600)]" /></div>
                  <h2 className="text-base font-semibold text-[var(--text-primary)] break-words">{dashboard.name}</h2>
                  <div className="mt-auto pt-5 flex items-center justify-between text-xs text-[var(--text-tertiary)]"><span className="flex items-center gap-1.5"><UserRound className="w-3.5 h-3.5" />{tr('Your dashboard')}</span><span>{tr('Open dashboard')}</span></div>
                </Link>
                <button
                  type="button"
                  onClick={() => setDefault.mutate(dashboard.isDefault ? null : dashboard.id, { onSuccess: () => toast(dashboard.isDefault ? tr('Default dashboard removed: you land on Home again') : tr('{name} opens first from now on', { name: dashboard.name }), 'success'), onError: (e: Error) => toast(e.message, 'error') })}
                  aria-pressed={!!dashboard.isDefault}
                  title={dashboard.isDefault ? tr('Default dashboard (click to remove)') : tr('Make this your default dashboard')}
                  className={`absolute right-3 top-3 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${dashboard.isDefault ? 'bg-[var(--brand-50)] text-[var(--brand-700)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'}`}
                >
                  <Star className={`w-3.5 h-3.5 ${dashboard.isDefault ? 'fill-current' : ''}`} aria-hidden="true" />{dashboard.isDefault ? tr('Default') : tr('Make default')}
                </button>
              </div>
            ))}
          </div>
        )}
        <Link href="/overview" className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--brand-600)]">{tr('Workspace overview')}<ArrowUpRight className="w-4 h-4" /></Link>
      </div>
      <Modal isOpen={createOpen} onClose={() => { if (!createDashboard.isPending) setCreateOpen(false) }} title={tr('Create dashboard')} size="sm">
        <form onSubmit={handleCreate} className="space-y-5">
          <p className="text-sm text-[var(--text-secondary)]">{tr('Give your dashboard a name. You can add and arrange widgets next.')}</p>
          <div><label htmlFor="dashboard-name" className="block text-sm font-medium text-[var(--text-secondary)] mb-2">{tr('Name')}</label><input id="dashboard-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={tr('My daily focus')} maxLength={255} required autoFocus className="veqsio-input w-full h-11" /></div>
          {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setCreateOpen(false)} disabled={createDashboard.isPending} className="veqsio-btn-secondary">{tr('Cancel')}</button><button disabled={!newName.trim() || createDashboard.isPending} className="veqsio-btn-primary">{createDashboard.isPending ? tr('Creating…') : tr('Create dashboard')}</button></div>
        </form>
      </Modal>
    </AppLayout>
  )
}
