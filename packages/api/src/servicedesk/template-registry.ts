/**
 * Extension point: service desk templates contributed by modules (for example "IT service management").
 * Leaf module (no imports of other app code) so templates.ts and the module host can both use it.
 * A registered template is offered and applied only while its `isAvailable()` is true (module licensed and enabled).
 */
export interface RegisteredDeskTemplate {
  id: string
  title: string
  description: string
  /** Licence feature shown in the 402 message. */
  feature: string
  isAvailable: () => boolean | Promise<boolean>
  /** Runs inside the desk-creation transaction (`tx` is a drizzle transaction). Must be idempotent. */
  apply: (tx: unknown, p: { deskId: number; projectId: number }) => Promise<void>
}

const registry = new Map<string, RegisteredDeskTemplate & { owner: string }>()

export function registerDeskTemplate(owner: string, t: RegisteredDeskTemplate): void {
  if (!/^[a-z][a-z0-9-]{1,48}$/.test(t.id)) throw new Error(`invalid desk template id "${t.id}"`)
  registry.set(t.id, { ...t, owner })
}

export function unregisterDeskTemplates(owner: string): void {
  for (const [id, t] of registry) if (t.owner === owner) registry.delete(id)
}

export function getRegisteredDeskTemplate(id: string): (RegisteredDeskTemplate & { owner: string }) | undefined {
  return registry.get(id)
}

/** Templates that can be used right now. */
export async function listAvailableDeskTemplates(): Promise<Array<Pick<RegisteredDeskTemplate, 'id' | 'title' | 'description' | 'feature'>>> {
  const out = []
  for (const t of registry.values()) {
    if (await t.isAvailable()) out.push({ id: t.id, title: t.title, description: t.description, feature: t.feature })
  }
  return out
}
