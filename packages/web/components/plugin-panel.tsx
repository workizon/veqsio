'use client'

import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { PANEL_SANDBOX, buildPanelSrc, parsePanelMessage, type PanelContext } from '@/lib/plugin-panel'

export interface PluginPanelInfo { pluginKey: string; pluginName: string; location: string; title: string; url: string }

/** One sandboxed panel. No cookies or tokens reach it: the frame has an opaque origin and only gets ?issue= and ?project=. */
export function PluginPanel({ panel, context }: { panel: PluginPanelInfo; context: PanelContext }) {
  const { tr } = useI18n()
  const frame = useRef<HTMLIFrameElement>(null)
  const router = useRouter()
  const [height, setHeight] = useState(160)
  const src = buildPanelSrc(panel.url, context)

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow) return // only this panel's frame
      const msg = parsePanelMessage(e.origin, e.data)
      if (!msg) return
      if (msg.type === 'resize') setHeight(msg.height)
      else router.push(msg.path) // same-origin paths only (validated)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [router])

  if (!src) return null
  return (
    <div className="veqsio-card">
      <div className="text-caption font-semibold text-[var(--text-tertiary)] uppercase mb-2" title={tr('Provided by {name}', { name: panel.pluginName })}>
        {panel.title}
      </div>
      <iframe
        ref={frame}
        src={src}
        title={`${panel.pluginName}: ${panel.title}`}
        sandbox={PANEL_SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ width: '100%', height, border: 0 }}
      />
    </div>
  )
}

/** All enabled plugin panels for a location. Renders nothing when there are none. */
export function PluginPanels({ location, context }: { location: 'issue.sidebar' | 'issue.tab' | 'project.page' | 'admin.page'; context: PanelContext }) {
  const { data } = useQuery({
    queryKey: ['plugin-panels', location],
    queryFn: async () => {
      const res = await fetch(`/rest/api/2/plugins/panels?location=${encodeURIComponent(location)}`, { credentials: 'include' })
      if (!res.ok) return [] as PluginPanelInfo[]
      return (await res.json()) as PluginPanelInfo[]
    },
    staleTime: 60_000,
  })
  if (!data || data.length === 0) return null
  return (
    <>
      {data.map((p) => (
        <PluginPanel key={`${p.pluginKey}:${p.title}:${p.url}`} panel={p} context={context} />
      ))}
    </>
  )
}
