/**
 * Core extension point: veto hooks that modules register for core operations (currently worklogs).
 * Core services call `runWorklogGuards` before they write. A guard that throws vetoes the change (fail closed).
 */
import type { WorklogChange, WorklogVeto } from '@veqsio/sdk'
import { unregisterDeskTemplates } from '../servicedesk/template-registry'

export type WorklogGuard = (change: WorklogChange) => void | WorklogVeto | Promise<void | WorklogVeto>

const worklogGuards = new Map<string, WorklogGuard>()

/** One guard per owner (module id); registering again replaces the previous one. */
export function registerWorklogGuard(owner: string, guard: WorklogGuard): () => void {
  worklogGuards.set(owner, guard)
  return () => { if (worklogGuards.get(owner) === guard) worklogGuards.delete(owner) }
}

export function unregisterHooks(owner: string): void {
  worklogGuards.delete(owner)
  unregisterTransitionChecks(owner)
  unregisterRequestCreatedHook(owner)
  unregisterDeskTemplates(owner)
}

export function worklogGuardCount(): number {
  return worklogGuards.size
}

/** Returns the first veto, or null when every guard allows the change. */
export async function runWorklogGuards(change: WorklogChange): Promise<{ message: string; status: 403 | 409 | 423 } | null> {
  for (const [owner, guard] of worklogGuards) {
    try {
      const r = await guard(change)
      if (r && r.allow === false) return { message: r.message, status: r.status ?? 423 }
    } catch (e) {
      console.error(`[modules] worklog guard of ${owner} failed:`, e)
      return { message: 'The worklog change could not be verified and was refused. Try again later.', status: 409 }
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/*  Transition checks: named validators a module provides              */
/* ------------------------------------------------------------------ */

/** What a check sees: the transition about to run, inside its database transaction (`tx` is a drizzle transaction). */
export interface TransitionCheckInput {
  issueId: number
  issueKey: string
  projectId: number
  transitionId: number
  fromStatusId: number
  toStatusId: number
  toStatusName: string
  tx: unknown
}
/** Return an error message to refuse the transition, or nothing to allow it. */
export type TransitionCheck = (input: TransitionCheckInput) => string | null | undefined | Promise<string | null | undefined>

const transitionChecks = new Map<string, { owner: string; check: TransitionCheck }>()

/**
 * Workflow validators of type `module_check` name a check, e.g. `itsm.postmortem`. A check that is not registered
 * (module missing, disabled or unlicensed) is skipped: licence lapse switches paid behaviour off, never locks issues.
 * A check that throws refuses the transition (fail closed).
 */
export function registerTransitionCheck(owner: string, name: string, check: TransitionCheck): void {
  transitionChecks.set(name, { owner, check })
}

export function unregisterTransitionChecks(owner: string): void {
  for (const [name, e] of transitionChecks) if (e.owner === owner) transitionChecks.delete(name)
}

export function hasTransitionCheck(name: string): boolean {
  return transitionChecks.has(name)
}

export async function runTransitionCheck(name: string, input: TransitionCheckInput): Promise<string | null> {
  const e = transitionChecks.get(name)
  if (!e) return null
  try {
    return (await e.check(input)) || null
  } catch (err) {
    console.error(`[modules] transition check ${name} of ${e.owner} failed:`, err)
    return 'This transition could not be verified and was refused. Try again later.'
  }
}

/* ------------------------------------------------------------------ */
/*  Service request created                                            */
/* ------------------------------------------------------------------ */

export interface RequestCreatedInfo {
  issueId: number
  issueKey: string
  deskId: number
  requestTypeId: number | null
  fieldValues: Record<string, unknown>
}
export type RequestCreatedHook = (info: RequestCreatedInfo) => void | Promise<void>

const requestCreatedHooks = new Map<string, RequestCreatedHook>()

export function registerRequestCreatedHook(owner: string, hook: RequestCreatedHook): void {
  requestCreatedHooks.set(owner, hook)
}

export function unregisterRequestCreatedHook(owner: string): void {
  requestCreatedHooks.delete(owner)
}

/** Runs after a portal request was stored. Failures are logged and never fail the request. */
export async function runRequestCreatedHooks(info: RequestCreatedInfo): Promise<void> {
  for (const [owner, hook] of requestCreatedHooks) {
    try { await hook(info) } catch (err) { console.error(`[modules] request hook of ${owner} failed:`, err) }
  }
}
