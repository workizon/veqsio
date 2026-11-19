'use client'

import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useAdminFeatures, useAdminModules, useToggleFeature, useToggleModule } from '@/hooks/use-features'

function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] ${checked ? 'bg-[var(--brand-600)]' : 'bg-[var(--surface-4)]'}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

export default function FeaturesPage() {
  const features = useAdminFeatures()
  const modules = useAdminModules()
  const toggleFeature = useToggleFeature()
  const toggleModule = useToggleModule()
  const fail = (e: unknown) => toast((e as Error).message || 'Failed to save', 'error')

  return (
    <AppLayout>
      <div className="space-y-8">
        <PageHeader title="Features and modules" description="Switch parts of Veqsio on or off for the whole instance. A switched-off feature disappears from the menus and its API answers 404; no data is deleted, so switching it back on restores everything." />

        <section aria-labelledby="core-heading" className="space-y-3">
          <h2 id="core-heading" className="text-heading-3">Core features</h2>
          {features.isLoading ? <Spinner /> : (
            <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
              {(features.data ?? []).map((f) => (
                <li key={f.id} className="flex items-center gap-4 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-body font-medium text-[var(--text-primary)]">{f.name}</div>
                    <div className="text-body-sm text-[var(--text-secondary)]">{f.description}{f.note ? ` ${f.note}` : ''}</div>
                  </div>
                  <Switch checked={f.enabled} label={`${f.name} enabled`} disabled={toggleFeature.isPending} onChange={(enabled) => toggleFeature.mutate({ id: f.id, enabled }, { onError: fail })} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="modules-heading" className="space-y-3">
          <h2 id="modules-heading" className="text-heading-3">Modules</h2>
          {modules.isLoading ? <Spinner /> : (modules.data ?? []).length === 0 ? <p className="text-body-sm text-[var(--text-secondary)]">No modules are installed.</p> : (
            <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
              {(modules.data ?? []).map((m) => (
                <li key={m.id} className="flex items-center gap-4 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-body font-medium text-[var(--text-primary)]">{m.name} <span className="text-caption text-[var(--text-tertiary)]">v{m.version} · {m.edition}</span></div>
                    <div className="text-body-sm text-[var(--text-secondary)]">{m.description}{!m.licensed ? ' Needs a licence: it stays inactive until one that includes it is installed.' : ''}</div>
                  </div>
                  <Switch checked={m.enabled} label={`${m.name} enabled`} disabled={toggleModule.isPending} onChange={(enabled) => toggleModule.mutate({ id: m.id, enabled }, { onError: fail })} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppLayout>
  )
}
