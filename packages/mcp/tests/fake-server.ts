import type { McpConfig } from '../src/server'
import { connectInMemory } from '../src/testing'

export interface Recorded { method: string; path: string; query: Record<string, string>; auth: string | null; body: any }
export type Reply = { status?: number; json?: unknown; text?: string } | ((r: Recorded) => { status?: number; json?: unknown; text?: string })

/** A tiny fake Veqsio API: routes are `"METHOD /path"`; every request is recorded. */
export function startFakeApi(routes: Record<string, Reply>) {
  const requests: Recorded[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const rec: Recorded = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.get('authorization'), body: text ? JSON.parse(text) : undefined }
      requests.push(rec)
      const hit = routes[`${req.method} ${url.pathname}`]
      if (!hit) return Response.json({ errorMessages: [`no fake route ${req.method} ${url.pathname}`] }, { status: 404 })
      const r = typeof hit === 'function' ? hit(rec) : hit
      if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200, headers: { 'Content-Type': 'text/markdown' } })
      return Response.json(r.json ?? {}, { status: r.status ?? 200 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) }
}

/** Connects an MCP client to a server instance over an in-memory transport. */
export function connect(cfg: Partial<McpConfig> & { url: string; fetch?: typeof fetch }) {
  return connectInMemory({ readOnly: false, ...cfg })
}

export const issueJson = (key: string, over: Record<string, any> = {}) => ({
  id: Number(key.split('-')[1]) + 100,
  key,
  fields: {
    summary: `Summary of ${key}`, description: 'Some description', status: { id: 1, name: 'To Do' }, issuetype: { id: 1, name: 'Bug' },
    priority: { id: 2, name: 'High' }, resolution: null, assignee: { id: 7, displayName: 'Ada Admin' }, reporter: { id: 8, displayName: 'Rob Reporter' },
    project: { id: 1, key: key.split('-')[0], name: 'Demo' }, created: '2026-01-02T10:00:00.000Z', updated: '2026-01-03T10:00:00.000Z', resolved: null,
    duedate: null, labels: ['backend'], components: [], fixVersions: [], issuelinks: [], subtasks: [], ...over,
  },
})
