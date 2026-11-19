'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useQueryClient } from '@tanstack/react-query'
import { runBulk, useBulkTransitions, useProjectSprints } from '@/hooks/use-bulk'
import { useMyself, usePriorities, useProjectVersions } from '@/hooks/use-issues'
import { useLabels } from '@/hooks/use-labels'
import { useUsers } from '@/hooks/use-users'
import { useUndoableAction } from '@/hooks/use-undoable'
import { toast } from '@/components/toast'
import { browserLocalStorage } from '@/lib/palette'
import { type BulkResult } from '@/lib/bulk'
import {
  emptyContext, lastCommand, pushCommandHistory, resolveInput, summarizeRun, type CommentOutcome, type ResolveContext, type Resolution,
} from '@/lib/command-line'

export interface CommandTarget { key: string; projectId: number; projectKey: string }

interface CommandLineStore {
  open: boolean
  initialText: string
  /** Run the command as soon as it resolves (repeat-last shortcut). */
  autoRun: boolean
  /** The issues the command applies to: the selection on the list or board, or the open issue. */
  targets: CommandTarget[]
  /** Lets the page tell the bar when its selection changed after a run (clear selection etc.). */
  onDone: (() => void) | null
  setTargets: (t: CommandTarget[], onDone?: (() => void) | null) => void
  openBar: (text?: string, autoRun?: boolean) => void
  closeBar: () => void
}

export const useCommandLineStore = create<CommandLineStore>((set) => ({
  open: false,
  initialText: '',
  autoRun: false,
  targets: [],
  onDone: null,
  setTargets: (targets, onDone = null) => set({ targets, onDone }),
  openBar: (text = '', autoRun = false) => set({ open: true, initialText: text, autoRun }),
  closeBar: () => set({ open: false }),
}))

/** A page publishes the issues a command should apply to (selection, or the open issue). Cleared when the page goes away. */
export function usePublishCommandTargets(targets: CommandTarget[], onDone?: () => void) {
  const set = useCommandLineStore((s) => s.setTargets)
  const sig = targets.map((t) => t.key).join(',')
  const doneRef = onDone
  useEffect(() => {
    set(targets, doneRef ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  useEffect(() => () => set([], null), [set])
}

/** Live data the resolver and the completion need; queries run only while the bar is open. */
export function useCommandContext(targets: CommandTarget[], enabled: boolean): ResolveContext {
  const keys = useMemo(() => targets.map((t) => t.key), [targets])
  const projectKeys = useMemo(() => [...new Set(targets.map((t) => t.projectKey))], [targets])
  const projectIds = useMemo(() => [...new Set(targets.map((t) => t.projectId))], [targets])
  const single = projectKeys.length === 1
  const { data: me } = useMyself()
  const users = useUsers()
  const priorities = usePriorities()
  const transitions = useBulkTransitions(keys, enabled && keys.length > 0)
  const labels = useLabels(enabled)
  const sprints = useProjectSprints(single ? projectIds[0] : null, enabled && single)
  const versions = useProjectVersions(enabled && single ? projectKeys[0] : '')
  return useMemo<ResolveContext>(() => ({
    ...emptyContext(new Date()),
    me: me ? { id: me.id, displayName: me.displayName || me.name, name: me.name } : null,
    users: (users.data ?? []).map((u) => ({ id: u.id, displayName: u.displayName, name: u.username, email: u.email })),
    priorities: (priorities.data ?? []).map((p) => ({ id: Number(p.id), name: p.name })),
    transitions: transitions.data ?? null,
    labels: labels.data?.values ?? [],
    sprints: single ? (sprints.data ?? null) : null,
    versions: single ? (versions.data?.map((v) => ({ id: v.id, name: v.name })) ?? null) : null,
    issueKeys: keys,
    projectKeys,
  }), [me, users.data, priorities.data, transitions.data, labels.data, sprints.data, versions.data, single, keys, projectKeys])
}

export interface RunOutcome { ok: boolean; message: string; tone: 'success' | 'warning' | 'error'; failedKeys: string[] }

/** Runs a resolved command through the bulk API, posts the comment, reports through toasts and offers Undo. */
export function useRunCommand() {
  const qc = useQueryClient()
  const undoableAction = useUndoableAction()

  return useCallback(async (input: string, res: Resolution, targets: CommandTarget[]): Promise<RunOutcome> => {
    const keys = targets.map((t) => t.key)
    const results: BulkResult[] = []
    for (const op of res.operations) results.push(await runBulk(keys, op.operation, op.params))

    let comment: CommentOutcome | null = null
    if (res.comment) {
      const okKeys = res.operations.length === 0 ? keys : [...new Set(results.flatMap((r) => r.succeeded))]
      const posts = await Promise.allSettled(okKeys.map((k) => fetch(`/rest/api/2/issue/${encodeURIComponent(k)}/comment`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: res.comment }),
      }).then((r) => { if (!r.ok) throw new Error(String(r.status)) })))
      comment = { posted: posts.filter((p) => p.status === 'fulfilled').length, failed: posts.filter((p) => p.status === 'rejected').length }
    }

    const summary = summarizeRun(results, keys.length, comment)
    pushCommandHistory(browserLocalStorage(), input)
    void qc.invalidateQueries({ queryKey: ['issues', 'search'] })
    for (const k of keys) void qc.invalidateQueries({ queryKey: ['issue', k] })
    void qc.invalidateQueries({ queryKey: ['bulk'] })

    if (summary.canUndo && summary.tone !== 'error') {
      const groups = summary.undo
      undoableAction({
        message: summary.headline + (res.undoable ? '' : ' Some changes cannot be undone.'),
        undo: async () => {
          const undone: BulkResult[] = []
          for (const g of groups) undone.push(await runBulk(g.issueKeys, g.operation, g.params))
          const restored = new Set(undone.flatMap((r) => r.succeeded)).size
          const failed = new Set(undone.flatMap((r) => r.failed.map((f) => f.key))).size
          toast(failed ? `Restored ${restored} issues; ${failed} could not be restored` : `Restored ${restored} ${restored === 1 ? 'issue' : 'issues'}`, failed ? 'warning' : 'success')
          void qc.invalidateQueries({ queryKey: ['issues', 'search'] })
          for (const k of keys) void qc.invalidateQueries({ queryKey: ['issue', k] })
        },
      })
    } else {
      toast(summary.headline, summary.tone === 'error' ? 'error' : summary.tone)
    }
    return { ok: summary.tone !== 'error', message: summary.headline, tone: summary.tone, failedKeys: summary.failedKeys }
  }, [qc, undoableAction])
}

export const lastStoredCommand = () => lastCommand(browserLocalStorage())
