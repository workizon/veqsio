'use client'

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useLinkIssues, useLinkTypes, useUnlinkIssue } from '@/hooks/use-issues'
import type { ApiIssue } from '@/hooks/use-issues'
import { groupLinks, linkRequest } from '@/lib/issue-view'

export interface LinkedIssuesHandle {
  openAdd: () => void
}

export const LinkedIssues = forwardRef<LinkedIssuesHandle, { issue: ApiIssue }>(function LinkedIssues({ issue }, ref) {
  const [adding, setAdding] = useState(false)
  const [option, setOption] = useState('')
  const [targetKey, setTargetKey] = useState('')
  const [busy, setBusy] = useState(false)
  const keyRef = useRef<HTMLInputElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const { data: linkTypes } = useLinkTypes()
  const link = useLinkIssues()
  const unlink = useUnlinkIssue()

  const groups = useMemo(() => groupLinks(issue.fields.issuelinks), [issue.fields.issuelinks])
  const options = useMemo(
    () =>
      (linkTypes?.issueLinkTypes || []).flatMap((t) => [
        { value: `${t.id}:outward`, label: t.outward, typeId: Number(t.id), direction: 'outward' as const },
        ...(t.inward !== t.outward ? [{ value: `${t.id}:inward`, label: t.inward, typeId: Number(t.id), direction: 'inward' as const }] : []),
      ]),
    [linkTypes],
  )
  const selected = options.find((o) => o.value === option) || options[0]

  useImperativeHandle(ref, () => ({
    openAdd: () => {
      setAdding(true)
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => keyRef.current?.focus(), 0)
    },
  }))

  const submit = async () => {
    const k = targetKey.trim().toUpperCase()
    if (!k || !selected) return
    setBusy(true)
    try {
      const target = await fetch(`/rest/api/2/issue/${encodeURIComponent(k)}`, { credentials: 'include' }).then((r) => (r.ok ? r.json() : null))
      if (!target) {
        toast(`Issue ${k} not found`, 'error')
        return
      }
      await link.mutateAsync({ ...linkRequest(issue.id, target.id, selected.direction), typeId: selected.typeId })
      toast('Issues linked', 'success')
      setTargetKey('')
      setAdding(false)
    } catch (err: any) {
      toast(err?.message || 'Failed to link issues', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (groups.length === 0 && !adding) return <section ref={sectionRef} aria-hidden="true" />

  return (
    <section ref={sectionRef} aria-labelledby="issue-links-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="issue-links-heading" className="text-heading-3 text-[var(--text-primary)]">Linked issues</h2>
        <button
          type="button"
          onClick={() => { setAdding(true); setTimeout(() => keyRef.current?.focus(), 0) }}
          aria-label="Add a linked issue"
          title="Add a linked issue"
          className="p-1.5 rounded text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {groups.map((g) => (
        <div key={g.label}>
          <h3 className="text-caption uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{g.label}</h3>
          <ul className="divide-y divide-[var(--surface-3)] border border-[var(--surface-3)] rounded-lg">
            {g.links.map(({ link: l, issue: target }) => (
              <li key={l.id} className="group flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] transition-colors">
                <Link href={`/issues/${target.key}`} className="font-mono text-body-sm text-[var(--brand-500)] hover:underline shrink-0">{target.key}</Link>
                <span className="flex-1 min-w-0 truncate text-body-sm text-[var(--text-primary)]">{target.summary}</span>
                {l.dependency?.conflict && (
                  <span role="img" aria-label={`Schedule conflict: ${l.dependency.message ?? ''}`} title={l.dependency.message ?? 'Schedule conflict'} className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-[#C9372C1f] text-[#C9372C]">
                    <AlertTriangle className="w-3 h-3" aria-hidden="true" /> Dates conflict
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => unlink.mutate({ linkId: l.id }, { onSuccess: () => toast('Link removed', 'success'), onError: (e: any) => toast(e?.message || 'Failed to remove link', 'error') })}
                  disabled={unlink.isPending}
                  aria-label={`Remove link to ${target.key}`}
                  className="p-1 rounded text-[var(--text-tertiary)] opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {adding && (
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="link-type" className="text-caption text-[var(--text-secondary)] block mb-1">This issue</label>
            <select id="link-type" value={selected?.value || ''} onChange={(e) => setOption(e.target.value)} className="veqsio-input text-sm" disabled={options.length === 0}>
              {options.length === 0 && <option value="">No link types configured</option>}
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[10rem]">
            <label htmlFor="link-target" className="text-caption text-[var(--text-secondary)] block mb-1">Issue key</label>
            <input
              id="link-target"
              ref={keyRef}
              value={targetKey}
              onChange={(e) => setTargetKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(false) } }}
              placeholder="e.g. PROJ-123"
              className="veqsio-input w-full text-sm"
            />
          </div>
          <button type="submit" disabled={busy || !targetKey.trim() || !selected} className="veqsio-btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
            {busy && <Spinner size="sm" />} Link
          </button>
          <button type="button" onClick={() => setAdding(false)} className="veqsio-btn-secondary text-sm">Cancel</button>
        </form>
      )}
    </section>
  )
})
