'use client'


import { useI18n } from '@/hooks/use-i18n'
import { use, useMemo } from 'react'
import { createModuleApiClient } from '@veqsio/sdk'
import { AppLayout } from '@/components/app-layout'
import { FeatureGate } from '@/components/feature-gate'
import { Spinner } from '@/components/spinner'
import { useActiveModules } from '@/hooks/use-modules'
import { findWebModule, resolveModulePage } from '@/lib/module-registry'

/** Hosts the pages that modules contribute: /m/<module id>/<path declared in the manifest>. */
export default function ModulePage({ params }: { params: Promise<{ segments: string[] }> }) {
  const { tr } = useI18n();

  const { segments } = use(params)
  const [moduleId, ...rest] = segments
  const active = useActiveModules()
  const api = useMemo(() => createModuleApiClient(moduleId), [moduleId])
  const mod = active.data?.find((m) => m.id === moduleId)
  const web = findWebModule(moduleId)
  const target = mod ? resolveModulePage(mod, rest) : null
  const Component = target && web ? (web[target.kind]?.[target.key] as ((p: { moduleId: string; api: typeof api; segments: string[] }) => React.ReactNode) | undefined) : undefined

  let body: React.ReactNode
  if (active.isLoading) body = <div className="p-8 flex justify-center"><Spinner /></div>
  else if (!mod && web) {
    // The module is part of this build but not active: without a licence explain what it needs, otherwise it is disabled.
    const title = moduleId.charAt(0).toUpperCase() + moduleId.slice(1)
    body = (
      <FeatureGate feature={`module_${moduleId.replace(/-/g, '_')}`} label={`The ${title} module`}>
        <div role="status" className="veqsio-card p-6"><h1 className="text-heading-2">{title} {tr('is switched off')}</h1><p className="text-sm text-[var(--text-secondary)] mt-2">{tr('An administrator can enable this module in the administration area.')}</p></div>
      </FeatureGate>
    )
  } else if (!mod || !web || !Component) {
    // Not enabled, not licensed or not part of this build: explain instead of a blank page.
    body = <div role="status" className="veqsio-card p-6"><h1 className="text-heading-2">{tr('Page not available')}</h1><p className="text-sm text-[var(--text-secondary)] mt-2">{tr('This module page is not enabled, not licensed, or not part of this installation.')}</p></div>
  } else {
    body = (
      <FeatureGate feature={mod.feature ?? ''} label={mod.name}>
        <Component moduleId={moduleId} api={api} segments={rest} />
      </FeatureGate>
    )
  }
  return <AppLayout>{body}</AppLayout>
}
