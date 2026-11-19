'use client'

import { useMemo } from 'react'
import { createModuleApiClient } from '@veqsio/sdk'
import { useActiveModules } from '@/hooks/use-modules'
import { bundledWebModules } from '@/lib/module-registry'
import { issuePanelsFor } from '@/lib/module-panels'

/**
 * Panels that licensed, enabled modules add to the issue view (for example the ITSM incident, problem and change
 * panels). A panel decides itself whether it has anything to show for the issue and renders nothing otherwise.
 */
export function ModuleIssuePanels({ issueKey, projectKey, location }: { issueKey: string; projectKey: string; location: 'sidebar' | 'content' }) {
  const active = useActiveModules()
  const panels = useMemo(() => issuePanelsFor(active.data, bundledWebModules, location), [active.data, location])
  if (!panels.length) return null
  return (
    <>
      {panels.map((p) => <ModulePanel key={`${p.moduleId}:${p.key}`} panel={p} issueKey={issueKey} projectKey={projectKey} />)}
    </>
  )
}

function ModulePanel({ panel, issueKey, projectKey }: { panel: { moduleId: string; key: string }; issueKey: string; projectKey: string }) {
  const api = useMemo(() => createModuleApiClient(panel.moduleId), [panel.moduleId])
  const Component = bundledWebModules.find((m) => m.id === panel.moduleId)?.issuePanels?.[panel.key]
  if (!Component) return null
  return <Component moduleId={panel.moduleId} api={api} issueKey={issueKey} projectKey={projectKey} />
}
