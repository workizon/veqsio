'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Archive, ArchiveRestore, Bug, FileText, FolderInput, History, ListTree, Lock, Maximize2, Minimize2, Pencil, Plus, Search, Unlock } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { EmptyState } from '@/components/empty-state'
import { Modal } from '@/components/modal'
import { RichTextEditor } from '@/components/rich-text-editor'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useFeatures } from '@/hooks/use-features'
import { useProjects } from '@/hooks/use-project-admin'
import { useArchivePage, useCreatePage, useMovePage, usePage, usePageSearch, usePages, useUpdatePage, type PageDetail } from '@/hooks/use-pages'
import { ancestorIds, renderPage, snippetParts, type PageSummary } from '@/lib/pages'
import { ConvertToIssueDialog } from './convert-issue-dialog'
import { HistoryDrawer } from './history-drawer'
import { PageComments } from './page-comments'
import { PageTree } from './page-tree'
import { Portal } from '@/components/portal'
import { confirmDialog } from '@/components/dialogs'

/**
 * The Pages screen: scope switcher and search on top, page tree on the left, the page in the middle and its table of
 * contents, linked issues and details on the right. `scopeKey` is a project key, null for the workspace, or undefined
 * when it should follow the open page (route /pages/[id]).
 */
export function PagesWorkspace({ scopeKey, pageId }: { scopeKey?: string | null; pageId: number | null }) {
  const { tr } = useI18n();

  const router = useRouter()
  const { isEnabled, loaded } = useFeatures()
  const projects = useProjects()
  const page = usePage(pageId)
  const scope: string | null | undefined = scopeKey !== undefined ? scopeKey : pageId === null ? null : page.data ? page.data.projectKey : undefined
  const list = usePages(scope === undefined ? null : scope)
  const [focus, setFocus] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [creating, setCreating] = useState<{ parentId: number | null } | null>(null)
  const search = usePageSearch(debounced, scope === undefined ? null : scope)

  useEffect(() => { const t = setTimeout(() => setDebounced(searchText), 250); return () => clearTimeout(t) }, [searchText])
  useEffect(() => {
    if (!focus) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) setFocus(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus])

  if (loaded && !isEnabled('pages')) {
    return <AppLayout><EmptyState icon="archive" title={tr('Pages are switched off')} description={tr('An administrator turned the Wiki / Pages feature off for this instance.')} /></AppLayout>
  }

  const switchScope = (value: string) => router.push(value ? `/projects/${encodeURIComponent(value)}/pages` : '/pages')
  const canCreateHere = true // the server decides (project pages need Edit issues); a refusal is shown as a message
  const showSearch = debounced.trim().length >= 2

  return (
    <AppLayout>
      <div className="max-w-[1600px] mx-auto">
        {!focus && (
          <>
            <Breadcrumb items={[{ label: tr('Pages'), href: '/pages' }, ...(scope ? [{ label: scope, href: `/projects/${scope}/pages` }] : [])]} />
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <h1 className="text-heading-1 mr-auto">{tr('Pages')}</h1>
              <label className="flex items-center gap-2 text-sm">
                <span className="sr-only sm:not-sr-only">{tr('Space')}</span>
                <select className="veqsio-input" aria-label={tr('Choose workspace or project pages')} value={scope ?? ''} onChange={(e) => switchScope(e.target.value)}>
                  <option value="">{tr('Workspace')}</option>
                  {(projects.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
                </select>
              </label>
              <button type="button" className="veqsio-btn-primary" onClick={() => setCreating({ parentId: null })}><Plus className="w-4 h-4" aria-hidden /> {tr('New page')}</button>
            </div>
          </>
        )}

        <div className={`grid gap-6 ${focus ? 'grid-cols-1' : 'lg:grid-cols-[260px_minmax(0,1fr)]'}`}>
          {!focus && (
            <nav aria-label={tr('Page navigation')} className="veqsio-card p-3 self-start max-h-[calc(100dvh-12rem)] overflow-y-auto">
              <div className="relative mb-3">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden />
                <input type="search" className="veqsio-input w-full pl-8" placeholder={tr('Search pages')} aria-label={tr('Search pages')} value={searchText} onChange={(e) => setSearchText(e.target.value)} />
              </div>
              {showSearch ? (
                <div aria-live="polite">
                  {search.isLoading && <Spinner />}
                  {search.isError && <p role="alert" className="text-sm text-red-600">{tr('Search failed.')}</p>}
                  {search.data && search.data.length === 0 && <p className="text-sm text-[var(--text-secondary)] px-1">{tr('No pages match “')}{debounced}{tr('”.')}</p>}
                  <ul className="space-y-2">
                    {search.data?.map((h) => (
                      <li key={h.id}>
                        <Link href={`/pages/${h.id}`} className="block rounded-md p-2 hover:bg-[var(--surface-2)]">
                          <span className="block text-sm font-medium">{h.title}</span>
                          <span className="block text-xs text-[var(--text-tertiary)]">{h.projectKey ?? tr('Workspace')}</span>
                          <span className="block text-xs text-[var(--text-secondary)] break-words">
                            {snippetParts(h.snippet).map((s, i) => s.match ? <mark key={i} className="veqsio-hl">{s.text}</mark> : <span key={i}>{s.text}</span>)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : list.isLoading || scope === undefined ? <Spinner />
                : list.isError ? <p role="alert" className="text-sm text-red-600 px-1">{tr('Could not load the pages.')}</p>
                : <PageTree pages={list.data ?? []} currentId={pageId} onCreate={(parentId) => setCreating({ parentId })} canCreate={canCreateHere} />}
            </nav>
          )}

          <main className="min-w-0">
            {pageId === null ? (
              <Landing pages={list.data} loading={list.isLoading} scope={scope ?? null} onCreate={() => setCreating({ parentId: null })} />
            ) : page.isLoading ? <Spinner />
              : page.isError ? (
                <EmptyState icon="inbox" title={tr('Page not found')} description={tr('It does not exist, was removed, or you are not allowed to see it.')} action={<Link className="veqsio-btn-secondary" href="/pages">{tr('Back to Pages')}</Link>} />
              ) : page.data ? (
                <PageView key={page.data.id} page={page.data} pages={list.data ?? []} focus={focus} onFocus={setFocus} />
              ) : null}
          </main>

          {creating && (
            <NewPageDialog
              scope={scope ?? null}
              parentId={creating.parentId}
              pages={list.data ?? []}
              onClose={() => setCreating(null)}
              onCreated={(id) => { setCreating(null); router.push(`/pages/${id}`) }}
            />
          )}
        </div>
      </div>
    </AppLayout>
  )
}

function Landing({ pages, loading, scope, onCreate }: { pages: PageSummary[] | undefined; loading: boolean; scope: string | null; onCreate: () => void }) {
  const { tr } = useI18n();

  if (loading) return <Spinner />
  if (!pages?.length) {
    return <EmptyState icon="archive" title={tr('No pages yet')} description={scope ? tr('Write the first page for project {scope}: documentation, decisions, meeting notes.', { scope }) : tr('Write the first workspace page. Every signed-in user can read it.')} action={<button type="button" className="veqsio-btn-primary" onClick={onCreate}>{tr('Create a page')}</button>} />
  }
  const recent = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12)
  return (
    <section aria-labelledby="recent-pages">
      <h2 id="recent-pages" className="text-heading-2 mb-3">{tr('Recently updated')}</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {recent.map((p) => (
          <li key={p.id}>
            <Link href={`/pages/${p.id}`} className="veqsio-card p-3 flex items-start gap-2 hover:border-[var(--brand-300)]">
              <FileText className="w-4 h-4 mt-0.5 text-[var(--text-tertiary)]" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium truncate">{p.title}</span>
                <span className="block text-xs text-[var(--text-secondary)]">{p.author?.displayName ?? tr('Unknown')} · {new Date(p.updatedAt).toLocaleDateString(getIntlLocale())}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function NewPageDialog({ scope, parentId, pages, onClose, onCreated }: { scope: string | null; parentId: number | null; pages: PageSummary[]; onClose: () => void; onCreated: (id: number) => void }) {
  const { tr } = useI18n();

  const create = useCreatePage()
  const [title, setTitle] = useState('')
  const [parent, setParent] = useState<number | null>(parentId)
  return (
    <Modal isOpen onClose={onClose} title={`New ${scope ? `${scope} ` : 'workspace '}page`}>
      <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault()
        create.mutate({ title, parentId: parent, projectKey: scope }, { onSuccess: (r) => onCreated(r.id), onError: (err) => toast(err.message, 'error') })
      }}>
        <div>
          <label htmlFor="np-title" className="block text-sm font-medium mb-1">{tr('Title')}</label>
          <input id="np-title" className="veqsio-input w-full" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        </div>
        <div>
          <label htmlFor="np-parent" className="block text-sm font-medium mb-1">{tr('Parent page')}</label>
          <select id="np-parent" className="veqsio-input w-full" value={parent ?? ''} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{tr('None (top level)')}</option>
            {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-ghost" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="veqsio-btn-primary" disabled={!title.trim() || create.isPending}>{tr('Create')}</button>
        </div>
      </form>
    </Modal>
  )
}

function PageView({ page, pages, focus, onFocus }: { page: PageDetail; pages: PageSummary[]; focus: boolean; onFocus: (v: boolean) => void }) {
  const { tr } = useI18n();

  const projects = useProjects()
  const update = useUpdatePage(page.id)
  const archive = useArchivePage(page.id)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(page.title)
  const [body, setBody] = useState(page.body)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [selection, setSelection] = useState('')
  const [convertText, setConvertText] = useState<string | null>(null)
  const [quote, setQuote] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const projectKeys = useMemo(() => new Set((projects.data ?? []).map((p) => p.key)), [projects.data])
  const rendered = useMemo(() => renderPage(page.body, projectKeys.size ? projectKeys : undefined), [page.body, projectKeys])
  const { canEdit, canLock, canComment } = page.permissions
  const dirty = editing && (title !== page.title || body !== page.body)

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Keyboard shortcuts (ignored while typing): E edit, Shift+L lock / unlock, Shift+R archive / restore.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || editing || historyOpen || moveOpen) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === 'e' && !e.shiftKey && canEdit && !page.archived) { e.preventDefault(); setTitle(page.title); setBody(page.body); setEditing(true) }
      else if (e.key === 'L' && e.shiftKey && canLock) { e.preventDefault(); update.mutate({ locked: !page.locked }, { onError: (err) => toast(err.message, 'error') }) }
      else if (e.key === 'R' && e.shiftKey && (canEdit || page.archived)) {
        e.preventDefault()
        if (page.archived || (await confirmDialog(tr('Archive this page and the pages below it? You can restore them later.')))) archive.mutate(!page.archived, { onSuccess: () => toast(page.archived ? tr('Page restored') : tr('Page archived'), 'success'), onError: (err) => toast(err.message, 'error') })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, historyOpen, moveOpen, canEdit, canLock, page, update, archive])

  const readSelection = () => {
    const sel = window.getSelection()
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : ''
    const inside = !!(sel && sel.anchorNode && contentRef.current?.contains(sel.anchorNode))
    setSelection(inside ? text.slice(0, 20000) : '')
  }

  const save = () => update.mutate({ title: title.trim(), body, expectedVersion: page.version }, {
    onSuccess: (r) => { toast(r.changed ? tr('Page saved') : tr('No changes to save'), 'success'); setEditing(false) },
    onError: (e: any) => toast(e.status === 409 ? tr('Someone else changed this page. Copy your text, reload the page and apply it again.') : e.message, 'error'),
  })

  const crumbs = [...page.ancestors]

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
      <article className={`min-w-0 ${focus ? 'max-w-3xl mx-auto w-full' : ''}`} aria-labelledby="page-title">
        {crumbs.length > 0 && (
          <nav aria-label={tr('Page path')} className="text-xs text-[var(--text-secondary)] mb-2 flex flex-wrap gap-1">
            {crumbs.map((a) => <span key={a.id}><Link className="hover:underline" href={`/pages/${a.id}`}>{a.title}</Link> /</span>)}
          </nav>
        )}
        <div className="flex flex-wrap items-start gap-2 mb-4">
          {editing ? (
            <input aria-label={tr('Page title')} className="veqsio-input flex-1 text-xl font-semibold" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
          ) : (
            <h1 id="page-title" className="text-heading-1 flex-1 min-w-0 break-words">
              {page.title}
              {page.locked && <Lock className="inline w-5 h-5 ml-2 text-[var(--text-tertiary)]" aria-label={tr('Locked')} />}
            </h1>
          )}
          <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label={tr('Page actions')}>
            {editing ? (
              <>
                <button type="button" className="veqsio-btn-primary" disabled={!title.trim() || update.isPending} onClick={save}>{tr('Save')}</button>
                <button type="button" className="veqsio-btn-ghost" onClick={async () => { if (!dirty || (await confirmDialog(tr('Discard your changes?')))) { setEditing(false); setTitle(page.title); setBody(page.body) } }}>{tr('Cancel')}</button>
              </>
            ) : (
              <>
                {canEdit && <button type="button" className="veqsio-btn-secondary" title={tr('Edit (E)')} aria-keyshortcuts="e" onClick={() => { setTitle(page.title); setBody(page.body); setEditing(true) }}><Pencil className="w-4 h-4" aria-hidden /> {tr('Edit')}</button>}
                <button type="button" className="veqsio-btn-ghost" onClick={() => setHistoryOpen(true)}><History className="w-4 h-4" aria-hidden /> {tr('History')}</button>
                {canEdit && <button type="button" className="veqsio-btn-ghost" onClick={() => setMoveOpen(true)}><FolderInput className="w-4 h-4" aria-hidden /> {tr('Move')}</button>}
                {canLock && (
                  <button type="button" className="veqsio-btn-ghost" disabled={update.isPending} title={tr('Lock or unlock (Shift+L)')} aria-keyshortcuts="Shift+L"
                    onClick={() => update.mutate({ locked: !page.locked }, { onError: (e) => toast(e.message, 'error') })}>
                    {page.locked ? <><Unlock className="w-4 h-4" aria-hidden /> {tr('Unlock')}</> : <><Lock className="w-4 h-4" aria-hidden /> {tr('Lock')}</>}
                  </button>
                )}
                {(canEdit || page.archived) && (
                  <button type="button" className="veqsio-btn-ghost" disabled={archive.isPending} title={tr('Archive or restore (Shift+R)')} aria-keyshortcuts="Shift+R"
                    onClick={async () => { if (page.archived || (await confirmDialog(tr('Archive this page and the pages below it? You can restore them later.')))) archive.mutate(!page.archived, { onSuccess: () => toast(page.archived ? tr('Page restored') : tr('Page archived'), 'success'), onError: (e) => toast(e.message, 'error') }) }}>
                    {page.archived ? <><ArchiveRestore className="w-4 h-4" aria-hidden /> {tr('Restore')}</> : <><Archive className="w-4 h-4" aria-hidden /> {tr('Archive')}</>}
                  </button>
                )}
              </>
            )}
            <button type="button" className="veqsio-btn-ghost" aria-pressed={focus} onClick={() => onFocus(!focus)}>
              {focus ? <><Minimize2 className="w-4 h-4" aria-hidden /> {tr('Exit focus')}</> : <><Maximize2 className="w-4 h-4" aria-hidden /> {tr('Focus')}</>}
            </button>
          </div>
        </div>

        {page.archived && <p role="status" className="mb-4 rounded-md border border-[var(--surface-4)] bg-[var(--surface-2)] px-3 py-2 text-sm">{tr('This page is archived and read-only. Use Restore to bring it back.')}</p>}
        {page.locked && !canEdit && !page.archived && <p role="status" className="mb-4 rounded-md border border-[var(--surface-4)] bg-[var(--surface-2)] px-3 py-2 text-sm">{tr('This page is locked. Only its author and administrators can edit it.')}</p>}

        {editing ? (
          <RichTextEditor value={body} onChange={setBody} label={tr('Page content')} rows={22} maxLength={200000} onSubmit={save} />
        ) : (
          <>
            {selection && (
              <div role="region" aria-label={tr('Selected text')} className="sticky top-16 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--surface-4)] bg-[var(--surface-0)] px-3 py-2 shadow-sm text-sm">
                <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">&ldquo;{selection}&rdquo;</span>
                <button type="button" className="veqsio-btn-secondary" onClick={() => setConvertText(selection)}><Bug className="w-4 h-4" aria-hidden /> {tr('Create issue')}</button>
                {canComment && <button type="button" className="veqsio-btn-ghost" onClick={() => { setQuote(selection); document.getElementById('page-comments-heading')?.scrollIntoView({ behavior: 'smooth' }) }}>{tr('Comment on this')}</button>}
              </div>
            )}
            <div ref={contentRef} onMouseUp={readSelection} onKeyUp={readSelection}>
              {rendered.html
                ? <div className="rich-text pages-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
                : <p className="text-[var(--text-secondary)]">{tr('This page is empty.')}{canEdit ? tr(' Choose Edit to write something.') : ''}</p>}
            </div>
            <PageComments pageId={page.id} canComment={canComment} quote={quote} onClearQuote={() => setQuote(null)} />
          </>
        )}
      </article>

      {!focus && (
        <aside aria-label={tr('Page details')} className="space-y-4 self-start xl:sticky xl:top-20">
          {rendered.toc.length > 0 && (
            <section className="veqsio-card p-3" aria-labelledby="toc-heading">
              <h2 id="toc-heading" className="text-sm font-semibold flex items-center gap-1.5 mb-2"><ListTree className="w-4 h-4" aria-hidden /> {tr('On this page')}</h2>
              <ul className="text-sm space-y-1">
                {rendered.toc.map((t) => (
                  <li key={t.id} style={{ paddingLeft: (t.level - 1) * 10 }}>
                    <a href={`#${t.id}`} className="text-[var(--text-secondary)] hover:text-[var(--brand-500)] hover:underline">{t.text}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="veqsio-card p-3" aria-labelledby="linked-heading">
            <h2 id="linked-heading" className="text-sm font-semibold flex items-center gap-1.5 mb-2"><Bug className="w-4 h-4" aria-hidden /> {tr('Linked issues')}</h2>
            {page.linkedIssues.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">{tr('None yet. Select text in the page and choose Create issue.')}</p> : (
              <ul className="text-sm space-y-2">
                {page.linkedIssues.map((i) => (
                  <li key={i.id}>
                    <Link href={`/issues/${i.issueKey}`} className="text-[var(--brand-500)] hover:underline font-medium">{i.issueKey}</Link>{' '}
                    <span>{i.summary}</span>
                    {i.status && <span className="ml-1 text-xs text-[var(--text-tertiary)]">({i.status})</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="veqsio-card p-3 text-sm" aria-labelledby="info-heading">
            <h2 id="info-heading" className="text-sm font-semibold mb-2">{tr('Details')}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--text-secondary)]">
              <dt>{tr('Space')}</dt><dd>{page.projectKey ? `${page.projectName ?? ''} (${page.projectKey})` : tr('Workspace')}</dd>
              <dt>{tr('Author')}</dt><dd>{page.author?.displayName ?? tr('Unknown')}</dd>
              <dt>{tr('Updated')}</dt><dd>{new Date(page.updatedAt).toLocaleString(getIntlLocale())}</dd>
              <dt>{tr('Version')}</dt><dd>{page.version}</dd>
            </dl>
          </section>
        </aside>
      )}

      {historyOpen && <Portal><HistoryDrawer pageId={page.id} canRestore={canEdit && !page.archived} onClose={() => setHistoryOpen(false)} onRestored={() => setHistoryOpen(false)} /></Portal>}
      {moveOpen && <MoveDialog page={page} pages={pages} onClose={() => setMoveOpen(false)} />}
      <ConvertToIssueDialog pageId={page.id} text={convertText} defaultProject={page.projectKey} onClose={() => { setConvertText(null); setSelection('') }} />
    </div>
  )
}

function MoveDialog({ page, pages, onClose }: { page: PageDetail; pages: PageSummary[]; onClose: () => void }) {
  const { tr } = useI18n();

  const move = useMovePage(page.id)
  const [parent, setParent] = useState<number | null>(page.parentId)
  const [position, setPosition] = useState('')
  // A page cannot go below itself: leave out the page and everything under it.
  const options = pages.filter((p) => p.id !== page.id && !ancestorIds(pages, p.id).includes(page.id))
  return (
    <Modal isOpen onClose={onClose} title={`Move "${page.title}"`}>
      <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault()
        const index = position.trim() ? Math.max(0, Number(position) - 1) : undefined
        move.mutate({ parentId: parent, index }, { onSuccess: () => { toast(tr('Page moved'), 'success'); onClose() }, onError: (err) => toast(err.message, 'error') })
      }}>
        <div>
          <label htmlFor="mv-parent" className="block text-sm font-medium mb-1">{tr('New parent')}</label>
          <select id="mv-parent" className="veqsio-input w-full" value={parent ?? ''} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{tr('None (top level)')}</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="mv-pos" className="block text-sm font-medium mb-1">{tr('Position among its siblings (1 = first, empty = last)')}</label>
          <input id="mv-pos" type="number" min={1} className="veqsio-input w-32" value={position} onChange={(e) => setPosition(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-ghost" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="veqsio-btn-primary" disabled={move.isPending}>{tr('Move')}</button>
        </div>
      </form>
    </Modal>
  )
}
