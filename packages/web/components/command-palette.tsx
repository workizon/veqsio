'use client'

import { useTerm } from '@/hooks/use-term'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Bug, CornerDownLeft, FolderKanban, History, Kanban, Search, User, Zap, Compass } from 'lucide-react'
import { useUIStore } from './ui-store'
import { useTheme } from './theme-provider'
import { toast } from './toast'
import { useProjects } from '@/hooks/use-project-admin'
import { useBoards } from '@/hooks/use-boards'
import { useMyself, useUpdateIssue } from '@/hooks/use-issues'
import { useFeatures } from '@/hooks/use-features'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { highlightSegments } from '@/lib/fuzzy'
import { formatSpec } from '@/lib/shortcuts'
import { signOut } from '@/lib/session'
import { useCommandLineStore } from '@/hooks/use-command-line'
import {
  GROUP_LABELS, actionItems, boardItem, browserLocalStorage, buildGroups, cycleGroup, flatten, issueItem, loadRecents, pageItems,
  pageResultItem, projectItem, pushRecent, saveRecents, searchJql, stepIndex, userItem, type PaletteGroup, type PaletteItem, type RankedGroup, type RankedItem,
} from '@/lib/palette'

/* ------------------------------------------------------------------ */
/*  Presentational part (also rendered on the server in tests)          */
/* ------------------------------------------------------------------ */

const GROUP_ICONS: Record<PaletteGroup, typeof Bug> = {
  recent: History,
  issues: Bug,
  projects: FolderKanban,
  boards: Kanban,
  pages: Compass,
  actions: Zap,
  people: User,
}

function iconFor(item: PaletteItem, group: PaletteGroup) {
  if (group !== 'recent') return GROUP_ICONS[group]
  const kind = item.id.split(':')[0]
  return kind === 'issue' ? Bug : kind === 'project' ? FolderKanban : kind === 'board' ? Kanban : kind === 'user' ? User : Compass
}

export function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  return (
    <>
      {highlightSegments(text, ranges).map((s, i) =>
        s.match ? <mark key={i} className="veqsio-hl">{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>,
      )}
    </>
  )
}

export const PALETTE_LISTBOX_ID = 'command-palette-listbox'
export const paletteOptionId = (index: number) => `command-palette-option-${index}`

export interface PaletteViewProps {
  query: string
  groups: RankedGroup[]
  activeIndex: number
  /** Server results are still on their way. */
  loading: boolean
  /** The server search failed; local results are still shown. */
  error: boolean
  onQueryChange?: (q: string) => void
  onHover?: (index: number) => void
  onChoose?: (item: PaletteItem) => void
  onRetry?: () => void
  inputRef?: React.Ref<HTMLInputElement>
  listRef?: React.Ref<HTMLDivElement>
  /** Rewrites visible words (the instance's term for an issue); identity by default so the view stays a pure component. */
  t?: (text: string) => string
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div aria-hidden="true" data-testid="palette-skeleton" className="py-1">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <div className="w-4 h-4 rounded bg-[var(--surface-3)] animate-pulse" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 rounded bg-[var(--surface-3)] animate-pulse" style={{ width: `${70 - i * 12}%` }} />
            <div className="h-2.5 rounded bg-[var(--surface-2)] animate-pulse" style={{ width: `${35 + i * 6}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function PaletteView({ query, groups, activeIndex, loading, error, onQueryChange, onHover, onChoose, onRetry, inputRef, listRef, t = (x: string) => x }: PaletteViewProps) {
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const q = query.trim()
  let flat = -1
  return (
    <div className="veqsio-modal-panel w-full max-w-xl overflow-hidden veqsio-pop-in" data-testid="command-palette">
      <div className="flex items-center gap-3 px-4 border-b border-[var(--surface-3)]">
        <Search className="w-4 h-4 text-[var(--text-tertiary)] flex-shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={t("Search issues, projects, pages and actions")}
          aria-expanded="true"
          aria-controls={PALETTE_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={total > 0 && activeIndex >= 0 ? paletteOptionId(activeIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("Search issues, projects, pages, or type a command…  (> runs a command on selected issues)")}
          className="flex-1 bg-transparent py-3.5 text-[15px] outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
        />
        <kbd className="veqsio-kbd" aria-hidden="true">Esc</kbd>
      </div>

      <div ref={listRef} className="max-h-[min(60vh,28rem)] overflow-y-auto overscroll-contain">
        <div id={PALETTE_LISTBOX_ID} role="listbox" aria-label="Results" className="py-1.5">
          {groups.map((g) => (
            <div key={g.group} role="group" aria-labelledby={`palette-group-${g.group}`}>
              <div id={`palette-group-${g.group}`} className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                {t(g.label)}
              </div>
              {g.items.map((r) => {
                flat += 1
                const index = flat
                const Icon = iconFor(r.item, g.group)
                const hint = r.item.shortcut ? formatSpec(r.item.shortcut) : null
                return (
                  <div
                    key={r.item.id}
                    id={paletteOptionId(index)}
                    role="option"
                    aria-selected={index === activeIndex}
                    data-palette-index={index}
                    className="veqsio-option flex items-center gap-3 mx-1.5 px-2.5 py-2 rounded-lg cursor-pointer"
                    onMouseMove={() => { if (index !== activeIndex) onHover?.(index) }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onChoose?.(r.item)}
                  >
                    <Icon className="veqsio-option-icon w-4 h-4 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--text-primary)] truncate">
                        <Highlighted text={r.item.title} ranges={r.titleRanges} />
                      </div>
                      {r.item.subtitle && (
                        <div className="text-xs text-[var(--text-tertiary)] truncate">
                          <Highlighted text={r.item.subtitle} ranges={r.subtitleRanges} />
                        </div>
                      )}
                    </div>
                    {r.item.badge && <span className="veqsio-badge flex-shrink-0">{r.item.badge}</span>}
                    {hint && (
                      <span className="flex items-center gap-1 flex-shrink-0" aria-hidden="true">
                        {hint.map((k, i) => (k === 'then' ? <span key={i} className="text-[10px] text-[var(--text-tertiary)]">then</span> : <kbd key={i} className="veqsio-kbd">{k}</kbd>))}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {loading && <SkeletonRows count={total === 0 ? 3 : 2} />}

        {!loading && total === 0 && !error && (
          <div className="px-4 py-10 text-center" data-testid="palette-empty">
            <p className="text-sm text-[var(--text-primary)]">{q ? `No results for “${q}”` : 'Nothing to show yet'}</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Try an issue key such as DEMO-12, a project name, or “create”.</p>
          </div>
        )}

        {error && (
          <div role="alert" className="flex items-center gap-3 mx-3 my-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] text-xs text-[var(--text-secondary)]" data-testid="palette-error">
            <AlertCircle className="w-4 h-4 text-[var(--error)] flex-shrink-0" aria-hidden="true" />
            <span className="flex-1">{total > 0 ? 'Search on the server failed. Showing local results only.' : 'Search on the server failed.'}</span>
            {onRetry && <button type="button" className="text-[var(--brand-600)] font-medium hover:underline" onMouseDown={(e) => e.preventDefault()} onClick={onRetry}>Retry</button>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--surface-3)] bg-[var(--surface-1)] text-[11px] text-[var(--text-tertiary)]" aria-hidden="true">
        <span className="flex items-center gap-1"><kbd className="veqsio-kbd">↑</kbd><kbd className="veqsio-kbd">↓</kbd> navigate</span>
        <span className="flex items-center gap-1"><kbd className="veqsio-kbd"><CornerDownLeft className="w-3 h-3" /></kbd> open</span>
        <span className="flex items-center gap-1"><kbd className="veqsio-kbd">Tab</kbd> next group</span>
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        {loading ? 'Searching' : error ? 'Server search failed' : total === 0 ? 'No results' : `${total} results`}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Container                                                          */
/* ------------------------------------------------------------------ */

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

interface RemoteResults { issues: PaletteItem[]; people: PaletteItem[]; pages: PaletteItem[] }

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

const ISSUE_PATH = /^\/issues\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/

/** Mounted only while open, so closed palettes cost no queries and no listeners. */
export function CommandPalette() {
  const open = useUIStore((s) => s.searchOpen)
  return open ? <PaletteDialog /> : null
}

function PaletteDialog() {
  const { t } = useTerm()
  const router = useRouter()
  const pathname = usePathname() || ''
  const { setSearchOpen, setCreateOpen, setShortcutsOpen } = useUIStore()
  const { toggleTheme } = useTheme()
  const open = true

  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useDialogFocus(open, dialogRef, inputRef)

  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [recents, setRecents] = useState<PaletteItem[]>([])

  useEffect(() => { setRecents(loadRecents(browserLocalStorage())) }, [])

  const issueKey = ISSUE_PATH.exec(pathname)?.[1]?.toUpperCase() ?? null

  const { data: projects } = useProjects()
  const { data: boards } = useBoards()
  const { data: myself } = useMyself()
  const updateIssue = useUpdateIssue()
  const { isEnabled } = useFeatures()
  const pagesOn = isEnabled('pages')

  const local = useMemo<PaletteItem[]>(() => [
    ...(projects ?? []).map(projectItem),
    ...(boards?.values ?? []).map(boardItem),
    ...pageItems(),
    ...actionItems({ issueKey }),
  ], [projects, boards, issueKey])

  const q = query.trim()
  const debounced = useDebounced(q, 200)
  const remoteEnabled = open && debounced.length >= 2
  const remote = useQuery<RemoteResults, Error>({
    queryKey: ['palette', debounced, pagesOn],
    enabled: remoteEnabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const [issues, users, pageHits] = await Promise.all([
        getJson<{ issues?: Array<{ key: string; fields?: { summary?: string; status?: { name?: string } } }> }>(
          `/rest/api/2/search?jql=${encodeURIComponent(searchJql(debounced))}&maxResults=8&fields=summary,status`,
        ),
        // people are a bonus: a failing user search must not fail the whole palette
        getJson<Array<{ id: number; displayName?: string; name?: string; emailAddress?: string }>>(`/rest/api/2/user/search?query=${encodeURIComponent(debounced)}`).catch(() => []),
        // wiki pages are a bonus too (and the request is skipped when the feature is switched off)
        pagesOn
          ? getJson<{ results?: Array<{ id: number; title: string; projectKey: string | null }> }>(`/rest/api/2/pages/search?q=${encodeURIComponent(debounced)}`).catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] as Array<{ id: number; title: string; projectKey: string | null }> }),
      ])
      return {
        issues: (issues.issues ?? []).map((i) => issueItem(i.key, i.fields?.summary, i.fields?.status?.name)),
        pages: (pageHits.results ?? []).slice(0, 5).map(pageResultItem),
        people: (Array.isArray(users) ? users : []).slice(0, 5).map((u) => userItem({ id: u.id, displayName: u.displayName || u.name || 'User', email: u.emailAddress })),
      }
    },
  })

  const pending = remoteEnabled && (debounced !== q || remote.isFetching)
  const settledForQuery = remoteEnabled && debounced === q && remote.data
  const remoteItems = useMemo(() => (settledForQuery ? [...remote.data!.issues, ...remote.data!.pages, ...remote.data!.people] : []), [settledForQuery, remote.data])
  const error = remoteEnabled && debounced === q && remote.isError

  const groups = useMemo(() => buildGroups({ query, local, remote: remoteItems, recents }), [query, local, remoteItems, recents])
  const flat = useMemo(() => flatten(groups), [groups])
  const found = activeId ? flat.findIndex((r) => r.item.id === activeId) : -1
  const activeIndex = flat.length === 0 ? -1 : found >= 0 ? found : 0

  useEffect(() => {
    if (activeIndex < 0) return
    listRef.current?.querySelector(`[data-palette-index="${activeIndex}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, groups])

  const close = () => setSearchOpen(false)

  const runAction = (item: PaletteItem) => {
    switch (item.action) {
      case 'create': setCreateOpen(true); break
      case 'help': setShortcutsOpen(true); break
      case 'toggleTheme': toggleTheme(); break
      case 'myIssues': router.push(`/issues?jql=${encodeURIComponent('assignee = currentUser() AND status != Done')}`); break
      case 'signOut': void signOut(router); break
      case 'assignToMe':
        if (!issueKey || !myself) { toast('Could not assign: your user is not loaded yet', 'error'); break }
        updateIssue.mutate(
          { key: issueKey, fields: { assignee: { id: myself.id } }, lookup: { users: [{ id: myself.id, displayName: myself.displayName || myself.name }] } },
          { onSuccess: () => toast(`${issueKey} assigned to you`, 'success'), onError: (e: any) => toast(e?.message || 'Failed to assign', 'error') },
        )
        break
    }
  }

  const choose = (item: PaletteItem) => {
    if (item.href) {
      const store = browserLocalStorage()
      const next = pushRecent(loadRecents(store), item)
      saveRecents(store, next)
    }
    close()
    if (item.action) runAction(item)
    else if (item.href) router.push(item.href)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    const move = (idx: number) => { if (idx >= 0) setActiveId(flat[idx].item.id) }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(stepIndex(activeIndex, 1, flat.length)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(stepIndex(activeIndex, -1, flat.length)) }
    else if (e.key === 'Tab') { e.preventDefault(); move(cycleGroup(groups, activeIndex < 0 ? 0 : activeIndex, e.shiftKey ? -1 : 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const r: RankedItem | undefined = flat[activeIndex]; if (r) choose(r.item) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh] veqsio-modal-overlay veqsio-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-xl" onKeyDown={onKeyDown} tabIndex={-1}>
        <PaletteView
          t={t}
          query={query}
          groups={groups}
          activeIndex={activeIndex}
          loading={pending}
          error={error}
          onQueryChange={(v) => {
            // ">" switches to the command line for the selected issues (the text after it moves over)
            if (v.startsWith('>')) { setSearchOpen(false); useCommandLineStore.getState().openBar(v.slice(1).trimStart()); return }
            setQuery(v); setActiveId(null)
          }}
          onHover={(i) => setActiveId(flat[i]?.item.id ?? null)}
          onChoose={choose}
          onRetry={() => void remote.refetch()}
          inputRef={inputRef}
          listRef={listRef}
        />
      </div>
    </div>
  )
}

export { GROUP_LABELS }
