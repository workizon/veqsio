/**
 * A small typed in-process event bus. The API emits domain events from its services; modules subscribe
 * through `defineModule({ events })`. Handlers run isolated: an exception in one handler never reaches
 * the code that emitted the event nor other handlers.
 */
import type { ModuleEventName } from './manifest'

interface IssueRef { issueId: number; issueKey: string; projectId: number }

export interface VeqsioEvents {
  'issue.created': IssueRef & { actorId?: number | null }
  'issue.updated': IssueRef & { actorId?: number | null; changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> }
  'issue.transitioned': IssueRef & { actorId?: number | null; fromStatus: string | null; toStatus: string | null }
  'issue.deleted': IssueRef & { actorId?: number | null }
  'comment.created': IssueRef & { commentId: number; authorId?: number | null }
  'worklog.created': IssueRef & { worklogId: number; authorId?: number | null; timeSpentSeconds: number }
  'worklog.updated': IssueRef & { worklogId: number; authorId?: number | null; timeSpentSeconds: number }
  'worklog.deleted': IssueRef & { worklogId: number; authorId?: number | null; timeSpentSeconds: number }
  'sprint.started': { sprintId: number; boardId: number; projectId?: number | null }
  'sprint.completed': { sprintId: number; boardId: number; projectId?: number | null }
}

// Compile-time guard: the manifest enum and the payload map must list the same events.
type _Same = [ModuleEventName] extends [keyof VeqsioEvents] ? ([keyof VeqsioEvents] extends [ModuleEventName] ? true : never) : never
export const _eventNamesInSync: _Same = true

export type EventHandler<K extends keyof VeqsioEvents> = (payload: VeqsioEvents[K], meta: { event: K; at: Date }) => void | Promise<void>

interface Sub { event: string; owner: string; handler: (payload: never, meta: never) => void | Promise<void> }

export interface EventBus {
  /** Subscribe. `owner` groups subscriptions so a module's can be removed at once. Returns an unsubscribe function. */
  on<K extends keyof VeqsioEvents>(event: K, handler: EventHandler<K>, owner?: string): () => void
  /** Remove every subscription of an owner (used on disable). Returns how many were removed. */
  offOwner(owner: string): number
  /** Runs all handlers; resolves when they have settled. Never rejects. */
  emit<K extends keyof VeqsioEvents>(event: K, payload: VeqsioEvents[K]): Promise<void>
  listenerCount(event?: keyof VeqsioEvents): number
}

export function createEventBus(onError: (err: unknown, info: { event: string; owner: string }) => void = (e, i) => console.error(`[events] handler of ${i.owner} failed on ${i.event}:`, e)): EventBus {
  let subs: Sub[] = []
  return {
    on(event, handler, owner = 'core') {
      const sub: Sub = { event, owner, handler: handler as Sub['handler'] }
      subs.push(sub)
      return () => { subs = subs.filter((s) => s !== sub) }
    },
    offOwner(owner) {
      const before = subs.length
      subs = subs.filter((s) => s.owner !== owner)
      return before - subs.length
    },
    async emit(event, payload) {
      const targets = subs.filter((s) => s.event === event)
      const meta = { event, at: new Date() }
      await Promise.all(targets.map(async (s) => {
        try { await (s.handler as (p: unknown, m: unknown) => void | Promise<void>)(payload, meta) } catch (e) {
          try { onError(e, { event, owner: s.owner }) } catch { /* never throw from the error reporter */ }
        }
      }))
    },
    listenerCount(event) { return event ? subs.filter((s) => s.event === event).length : subs.length },
  }
}
