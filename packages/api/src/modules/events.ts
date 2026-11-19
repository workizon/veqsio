import { createEventBus, type VeqsioEvents } from '@veqsio/sdk'

/** The process wide event bus. Core services emit, modules subscribe (see modules/runtime.ts). */
export const eventBus = createEventBus()

/**
 * Fire-and-forget emit for use inside request handlers and services: never throws, never delays the caller
 * beyond scheduling. Handlers run after the current tick.
 */
export function emitEvent<K extends keyof VeqsioEvents>(event: K, payload: VeqsioEvents[K]): void {
  if (eventBus.listenerCount(event) === 0) return
  void Promise.resolve().then(() => eventBus.emit(event, payload)).catch(() => {})
}
