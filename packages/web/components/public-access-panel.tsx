'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@/components/toast'

/** Project setting: let anyone read this project without signing in. */
export function PublicAccessPanel({ projectKey, isPublic, publicIndexing = 'inherit', publicBoard = false, publicRoadmap = false }: { projectKey: string; isPublic: boolean; publicIndexing?: string; publicBoard?: boolean; publicRoadmap?: boolean }) {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const [value, setValue] = useState(isPublic)
  const [busy, setBusy] = useState(false)
  const [noIndex, setNoIndex] = useState(publicIndexing === 'none')
  const [extras, setExtras] = useState({ publicBoard, publicRoadmap })
  const changeExtra = async (k: 'publicBoard' | 'publicRoadmap', v: boolean) => {
    setBusy(true)
    try {
      const res = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [k]: v }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
      setExtras((e) => ({ ...e, [k]: v }))
      qc.invalidateQueries({ queryKey: ['project', projectKey] })
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }

  const change = async (next: boolean) => {
    setBusy(true)
    try {
      const res = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isPublic: next }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
      setValue(next)
      qc.invalidateQueries({ queryKey: ['project', projectKey] })
      toast(next ? tr('Project is now public') : tr('Project is private again'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const changeIndexing = async (none: boolean) => {
    setBusy(true)
    try {
      const res = await fetch(`/rest/api/2/project/${encodeURIComponent(projectKey)}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicIndexing: none ? 'none' : 'inherit' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] || res.statusText)
      setNoIndex(none)
      qc.invalidateQueries({ queryKey: ['project', projectKey] })
      toast(none ? tr('Search engines are asked not to index this project') : tr('This project follows the instance indexing policy'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="public-heading" className="max-w-xl rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 space-y-3">
      <h2 id="public-heading" className="text-heading-3">{tr('Public access')}</h2>
      <label className="flex items-start gap-3 text-body">
        <input type="checkbox" className="mt-1" checked={value} disabled={busy} onChange={(e) => void change(e.target.checked)} />
        <span>
          {tr('Anyone on the internet can view this project, without signing in')} <span className="block text-body-sm text-[var(--text-secondary)]">
            {tr('Read-only: issue summaries, descriptions, status and public comments, with display names only. Internal comments, attachments, emails and custom fields are never shown. Search engines can index it (see Instance settings). Needs “Allow public projects” enabled by an administrator.')}
          </span>
        </span>
      </label>
      {value && (
        <label className="flex items-start gap-3 text-body">
          <input type="checkbox" className="mt-1" checked={noIndex} disabled={busy} onChange={(e) => void changeIndexing(e.target.checked)} />
          <span>{tr('Ask search engines not to index this project')} <span className="block text-body-sm text-[var(--text-secondary)]">{tr('The project stays readable by anyone with the link. It is left out of the sitemap and its pages say noindex. The instance setting still applies on top of this.')}</span>
          </span>
        </label>
      )}
      {value && (
        <>
          <label className="flex items-start gap-3 text-body">
            <input type="checkbox" className="mt-1" checked={extras.publicBoard} disabled={busy} onChange={(e) => void changeExtra('publicBoard', e.target.checked)} />
            <span>{tr('Show a read-only board')}<span className="block text-body-sm text-[var(--text-secondary)]">{tr('The columns of the project\'s first board with the newest issues in each. Page: /p/')}{projectKey}/board</span></span>
          </label>
          <label className="flex items-start gap-3 text-body">
            <input type="checkbox" className="mt-1" checked={extras.publicRoadmap} disabled={busy} onChange={(e) => void changeExtra('publicRoadmap', e.target.checked)} />
            <span>{tr('Show a roadmap')}<span className="block text-body-sm text-[var(--text-secondary)]">{tr('Versions that are not archived, with names, descriptions, dates and how many of their issues are done. Check your version descriptions first. Page: /p/')}{projectKey}/roadmap</span></span>
          </label>
        </>
      )}
      {value && <p className="text-body-sm">{tr('Public page:')} <a className="text-[var(--brand-500)] hover:underline" href={`/p/${projectKey}`} target="_blank" rel="noopener noreferrer">/p/{projectKey}</a></p>}
    </section>
  )
}
