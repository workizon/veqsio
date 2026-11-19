/**
 * Web side of a module: `defineWebModule()`. The module's web entry (usually `src/web.tsx`) default-exports its
 * result. The web app generates a static registry of all bundled modules at build time (Next.js needs static
 * imports); at runtime it only renders what `/rest/api/2/modules/active` reports as enabled and licensed.
 *
 * Components are matched to the manifest's `contributes.web` entries by `key`.
 */

// Deliberately not importing React: any function component is accepted, so the SDK stays framework-light.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModuleComponent<P> = (props: P) => any

export interface ModuleApiClient {
  /** Calls /rest/modules/<id>/<path> with the user's session. Throws ModuleApiError on non-2xx. */
  request<T = unknown>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T>
  get<T = unknown>(path: string, init?: RequestInit): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  put<T = unknown>(path: string, body?: unknown): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  delete<T = unknown>(path: string): Promise<T>
}

export class ModuleApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message)
    this.name = 'ModuleApiError'
  }
}

export interface ModuleBaseProps {
  moduleId: string
  api: ModuleApiClient
}
export interface PageProps extends ModuleBaseProps {
  /** Remaining URL segments after /m/<id>/, e.g. `['reports','summary']`. */
  segments: string[]
}
export interface IssuePanelProps extends ModuleBaseProps { issueKey: string; projectKey: string }
export interface ProjectTabProps extends ModuleBaseProps { projectKey: string }
export interface GadgetProps extends ModuleBaseProps { config: Record<string, unknown> }
export interface IssueListActionContext extends ModuleBaseProps { issueKeys: string[] }
export interface CommandContext extends ModuleBaseProps { navigate(href: string): void }

export interface WebModuleDefinition {
  id: string
  /** Pages for navItems, adminPages and projectTabs, keyed by the manifest `key`. Rendered under /m/<id>/<path>. */
  pages?: Record<string, ModuleComponent<PageProps>>
  adminPages?: Record<string, ModuleComponent<PageProps>>
  projectTabs?: Record<string, ModuleComponent<ProjectTabProps>>
  issuePanels?: Record<string, ModuleComponent<IssuePanelProps>>
  gadgets?: Record<string, ModuleComponent<GadgetProps>>
  issueListActions?: Record<string, { run(ctx: IssueListActionContext): void | Promise<void> }>
  commands?: Record<string, { run(ctx: CommandContext): void | Promise<void> }>
}

export function defineWebModule(def: WebModuleDefinition): WebModuleDefinition {
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(def.id)) throw new Error(`defineWebModule: invalid module id "${def.id}"`)
  return def
}

/** Builds a client for a module's API over `fetch` (cookies included). `base` is the API origin, empty for same-origin. */
export function createModuleApiClient(moduleId: string, base = '', fetchImpl: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch): ModuleApiClient {
  const request = async <T,>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> => {
    const url = `${base}/rest/modules/${moduleId}/${path.replace(/^\/+/, '')}`
    const res = await fetchImpl(url, {
      ...init,
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : undefined
    if (!res.ok) {
      const msg = (data as { errorMessages?: string[] } | undefined)?.errorMessages?.[0] ?? `HTTP ${res.status}`
      throw new ModuleApiError(res.status, msg, (data as { code?: string } | undefined)?.code)
    }
    return data as T
  }
  return {
    request,
    get: (p, init) => request('GET', p, undefined, init),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    delete: (p) => request('DELETE', p),
  }
}
