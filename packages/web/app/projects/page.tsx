'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { KanbanSquare, LayoutDashboard, List, ListTodo, Loader2, Plus, Search, Settings } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import { ProjectAvatar } from '@/components/project-avatar'
import { StatusUpdateBadge } from '@/components/status-update-badge'
import { useFeatures } from '@/hooks/use-features'
import { useLatestStatusUpdates } from '@/hooks/use-status-updates'
import { useProjects } from '@/hooks/use-project-admin'
import { PROJECT_KEY_RE as KEY_RE, suggestKey } from '@/lib/project-key'
import { useCopyPreview, useProjectTemplates } from '@/hooks/use-templates'
import { useTerm } from '@/hooks/use-term'

function CreateProjectModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { tr } = useI18n();

  const router = useRouter()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [start, setStart] = useState<'blank' | 'template' | 'copy'>('blank')
  const [templateId, setTemplateId] = useState('software')
  const [sourceKey, setSourceKey] = useState('')
  const [copyOpts, setCopyOpts] = useState({ components: true, versions: true, issueTemplates: true, roleActors: false })
  const templates = useProjectTemplates()
  const { data: existing = [] } = useProjects()
  const preview = useCopyPreview(start === 'copy' && sourceKey ? sourceKey : null)

  useEffect(() => { if (!keyTouched) setKey(suggestKey(name)) }, [name, keyTouched])
  useEffect(() => { if (!isOpen) { setName(''); setKey(''); setKeyTouched(false); setDescription(''); setError(null); setStart('blank'); setSourceKey('') } }, [isOpen])

  const keyValid = KEY_RE.test(key)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !keyValid || busy) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/rest/api/2/project', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), key, description: description.trim() || undefined,
          template: start === 'template' ? templateId : undefined,
          copyFrom: start === 'copy' && sourceKey ? { projectKey: sourceKey, ...copyOpts } : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.errorMessages?.join(' ') || `HTTP ${res.status}`)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast(tr('Project {key} created', { key: data.key }), 'success')
      onClose()
      router.push(`/projects/${data.key}/settings`)
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('Failed to create project'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={tr('Create project')} size="md">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="project-name" className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">{tr('Name')}</label>
          <input id="project-name" className="veqsio-input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} placeholder={tr('Customer portal')} autoFocus={typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches} required />
        </div>
        <div>
          <label htmlFor="project-key" className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">{tr('Key')}</label>
          <input
            id="project-key" className="veqsio-input w-40 font-mono uppercase" value={key} maxLength={10} required
            aria-invalid={!!key && !keyValid} aria-describedby="project-key-hint"
            onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')) }}
          />
          <p id="project-key-hint" className={`mt-1 text-[12px] ${key && !keyValid ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'}`}>
            {key && !keyValid ? tr('2 to 10 characters, starting with a letter.') : tr('Issue keys will look like {key}-123. The key cannot be changed later.', { key: key || 'KEY' })}
          </p>
        </div>
        <div>
          <label htmlFor="project-description" className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">{tr('Description')} <span className="font-normal text-[var(--text-tertiary)]">{tr('(optional)')}</span></label>
          <textarea id="project-description" className="veqsio-input w-full" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </div>
        <fieldset className="space-y-2">
          <legend className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">{tr('Start from')}</legend>
          <div className="flex flex-wrap gap-4 text-[13px]">
            {([['blank', 'Blank project'], ['template', 'A template'], ['copy', 'Copy of a project']] as const).map(([v, l]) => (
              <label key={v} className="flex items-center gap-1.5"><input type="radio" name="project-start" checked={start === v} onChange={() => setStart(v)} />{tr(l)}</label>
            ))}
          </div>
          {start === 'template' && (
            <div className="space-y-2" role="radiogroup" aria-label={tr('Project template')}>
              {templates.isLoading && <p className="text-[12px] text-[var(--text-tertiary)]">{tr('Loading templates…')}</p>}
              {(templates.data ?? []).map((t) => (
                <label key={t.id} className={`block cursor-pointer rounded-lg border p-3 ${templateId === t.id ? 'border-[var(--brand-500)] bg-[var(--brand-50)]' : 'border-[var(--surface-3)]'}`}>
                  <span className="flex items-center gap-2 text-[13px] font-semibold"><input type="radio" name="project-template" checked={templateId === t.id} onChange={() => setTemplateId(t.id)} />{t.name}</span>
                  <span className="block pl-6 text-[12px] text-[var(--text-secondary)]">{t.description}</span>
                  <span className="block pl-6 text-[12px] text-[var(--text-tertiary)]">
                    {t.board.type === 'scrum' ? tr('Scrum board') : tr('Kanban board')}
                    {t.components.length > 0 && ` · ${tr('components:')} ${t.components.join(', ')}`}
                    {t.versions.length > 0 && ` · ${tr('version')} ${t.versions.join(', ')}`}
                    {` · ${tr('templates:')} ${t.issueTemplates.map((i) => i.name).join(', ')}`}
                  </span>
                </label>
              ))}
            </div>
          )}
          {start === 'copy' && (
            <div className="space-y-2">
              <label htmlFor="copy-source" className="sr-only">{tr('Project to copy from')}</label>
              <select id="copy-source" className="veqsio-input w-full" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
                <option value="">{tr('Select a project you administer')}</option>
                {existing.map((p) => <option key={p.id} value={p.key}>{p.name} ({p.key})</option>)}
              </select>
              {sourceKey && preview.isLoading && <p className="text-[12px] text-[var(--text-tertiary)]">{tr('Loading preview…')}</p>}
              {sourceKey && preview.error && <p role="alert" className="text-[12px] text-[var(--error)]">{tr('You need to be an administrator of')} {sourceKey} {tr('to copy its settings.')}</p>}
              {preview.data && (
                <div className="rounded-lg border border-[var(--surface-3)] p-3 text-[13px] space-y-1.5" aria-live="polite">
                  <p className="text-[12px] font-medium text-[var(--text-secondary)]">{tr('What will be copied from')} {preview.data.key}</p>
                  {([
                    ['components', 'Components', preview.data.components],
                    ['versions', 'Versions (names only, not released)', preview.data.versions],
                    ['issueTemplates', 'Issue templates', preview.data.issueTemplates],
                  ] as const).map(([k, l, items]) => (
                    <label key={k} className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={copyOpts[k]} disabled={items.length === 0} onChange={(e) => setCopyOpts((o) => ({ ...o, [k]: e.target.checked }))} />
                      <span>{tr(l)} <span className="text-[var(--text-tertiary)]">({items.length}{items.length > 0 && `: ${items.slice(0, 6).join(', ')}${items.length > 6 ? ', …' : ''}`})</span></span></label>
                  ))}
                  <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={copyOpts.roleActors} disabled={preview.data.roleActors.length === 0} onChange={(e) => setCopyOpts((o) => ({ ...o, roleActors: e.target.checked }))} />
                    <span>{tr('People in project roles')} <span className="text-[var(--text-tertiary)]">({preview.data.roleActors.length ? preview.data.roleActors.map((r) => `${r.role}: ${r.actors}`).join(', ') : tr('none')}{tr('; off by default)')}</span></span></label>
                </div>
              )}
            </div>
          )}
        </fieldset>
        {error && <p role="alert" className="text-[13px] text-[var(--error)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
          <button type="submit" disabled={busy || !name.trim() || !keyValid || (start === 'copy' && !sourceKey)} className="veqsio-btn-primary">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {tr('Create project')} </button>
        </div>
      </form>
    </Modal>
  )
}

export default function ProjectsPage() {
  const { tr } = useI18n();

  const [archivedView, setArchivedView] = useState(false)
  const { data: projects, isLoading, error } = useProjects(archivedView ? 'only' : undefined)
  const { t, Issues } = useTerm()
  const [counts, setCounts] = useState<Record<string, { total: number; open: number }>>({})
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  // Shift+C anywhere lands here with ?create=1; open the dialog once and drop the flag so a reload does not reopen it
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('create') === '1') {
      setCreateOpen(true)
      window.history.replaceState(null, '', '/projects')
    }
  }, [])
  const updatesOn = useFeatures().isEnabled('updates')
  const latest = useLatestStatusUpdates(updatesOn).data

  useEffect(() => {
    if (!projects?.length) return
    let cancelled = false
    const count = async (jql: string) => {
      const res = await fetch(`/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=0`, { credentials: 'include' })
      return res.ok ? ((await res.json()).total as number) || 0 : 0
    }
    Promise.all(projects.map(async (p) => {
      const [total, open] = await Promise.all([
        count(`project = ${p.key}`).catch(() => 0),
        count(`project = ${p.key} AND status not in (Done, Closed, Resolved)`).catch(() => 0),
      ])
      return [p.key, { total, open }] as const
    })).then((rows) => { if (!cancelled) setCounts(Object.fromEntries(rows)) })
    return () => { cancelled = true }
  }, [projects])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))
  }, [projects, query])

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Breadcrumb items={[{ label: tr('Projects') }]} />
            <h1 className="text-heading-1 text-[var(--text-primary)] mt-2">{tr('Projects')}</h1>
          </div>
          <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary"><Plus className="w-4 h-4" />{tr('Create project')}</button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 min-w-[12rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
          <input aria-label={tr('Search projects')} className="veqsio-input w-full pl-9" placeholder={tr('Search projects')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <label className="flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)]">
          <input type="checkbox" checked={archivedView} onChange={(e) => setArchivedView(e.target.checked)} /> {tr('Archived projects only')} </label>
        </div>

        <div className="veqsio-card !p-0 overflow-hidden">
          <div className="hidden md:grid grid-cols-[minmax(0,1fr)_96px_minmax(0,220px)_auto] gap-4 items-center px-4 py-2 bg-[var(--surface-1)] border-b border-[var(--surface-3)] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
            <span>{tr('Project')}</span><span>{tr('Key')}</span><span className="hidden md:block">{tr('Progress')}</span><span className="sr-only">{tr('Shortcuts')}</span>
          </div>

          {isLoading && Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-[var(--surface-3)] last:border-b-0 animate-pulse">
              <span className="w-8 h-8 rounded-lg bg-[var(--surface-2)]" /><span className="h-3 w-48 rounded bg-[var(--surface-2)]" />
            </div>
          ))}
          {error && <p role="alert" className="px-4 py-6 text-[13px] text-[var(--error)]">{tr('Could not load projects:')} {error.message}</p>}
          {!isLoading && !error && visible.length === 0 && (
            <div className="px-4 py-12 text-center">
              <p className="text-[14px] font-medium text-[var(--text-primary)]">{projects?.length ? tr('No projects match your search') : archivedView ? tr('No archived projects') : tr('No projects yet')}</p>
              <p className="text-[13px] text-[var(--text-tertiary)] mt-1">{projects?.length ? tr('Try a different name or key.') : tr('A project groups issues, a board and a workflow.')}</p>
              {!projects?.length && <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary mt-4"><Plus className="w-4 h-4" />{tr('Create project')}</button>}
            </div>
          )}

          {visible.map((p) => {
            const c = counts[p.key]
            const done = c ? c.total - c.open : 0
            const pct = c && c.total ? Math.round((done / c.total) * 100) : 0
            return (
              <div key={p.id} className="group grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_96px_minmax(0,220px)_auto] gap-x-4 gap-y-2 items-center px-4 py-3 md:py-2.5 border-b border-[var(--surface-3)] last:border-b-0 hover:bg-[var(--surface-1)] transition-colors">
                <Link href={`/issues?jql=${encodeURIComponent(`project = ${p.key}`)}`} className="flex items-center gap-3 min-w-0 focus-visible:outline-none">
                  <ProjectAvatar projectKey={p.key} name={p.name} src={(p as { avatarUrls?: Record<string, string> }).avatarUrls?.['48x48']} size={32} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--brand-700)]">{p.name}</span>
                    <span className="block text-[12px] text-[var(--text-tertiary)] truncate"><span className="md:hidden font-mono">{p.key} · </span>{c ? `${c.total} ${t(c.total === 1 ? 'issue' : 'issues')} · ${tr('{n} open', { n: c.open })}` : tr('Loading…')}</span>
                  </span>
                </Link>
                <span className="hidden md:flex flex-col items-start gap-1 text-[12px] font-medium font-mono text-[var(--text-secondary)]">{p.key}{updatesOn && latest?.[p.key] && <StatusUpdateBadge state={latest[p.key].state} title={tr('Latest status update')} />}</span>
                <div className="hidden md:flex items-center gap-2" title={c ? tr('{done} of {total} done', { done, total: c.total }) : undefined}>
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={tr('{name} progress', { name: p.name })}>
                    <div className="h-full rounded-full bg-[var(--success)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-9 text-right text-[12px] tabular-nums text-[var(--text-tertiary)]">{pct}%</span>
                </div>
                <div className="flex items-center gap-1 md:gap-0.5">
                  {([
                    { href: `/projects/${p.key}`, label: tr('Overview'), Icon: LayoutDashboard },
                    { href: '/boards', label: tr('Board'), Icon: KanbanSquare },
                    { href: '/backlog', label: tr('Backlog'), Icon: ListTodo },
                    { href: `/issues?jql=${encodeURIComponent(`project = ${p.key}`)}`, label: Issues, Icon: List },
                    { href: `/projects/${p.key}/settings`, label: tr('Settings'), Icon: Settings },
                  ] as const).map(({ href, label, Icon }) => (
                    <Link key={label} href={href} title={`${label}: ${p.name}`} aria-label={`${label}: ${p.name}`} className="veqsio-btn-ghost !p-2.5 md:!p-1.5">
                      <Icon className="w-4 h-4" aria-hidden="true" />
                    </Link>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <CreateProjectModal isOpen={createOpen} onClose={() => setCreateOpen(false)} />
    </AppLayout>
  )
}
