import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { VeqsioClient } from '@veqsio/client'
import { describeError } from './errors'
import { UNTRUSTED_NOTICE } from './format'
import { ALL_TOOLS, type ToolDef } from './tools'
import { registerExtras } from './extras'

export const SERVER_NAME = 'veqsio'
export const SERVER_VERSION = '1.0.0'

export interface McpConfig {
  /** Base URL of the Veqsio instance. */
  url: string
  /** Personal access token. Without one only the anonymous public tools are offered. */
  token?: string
  /** Register no write tools (default: true). */
  readOnly: boolean
  timeoutMs?: number
}

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

/** Reads VEQSIO_URL, VEQSIO_TOKEN, VEQSIO_MCP_READONLY (default true: write tools need an explicit `false`). */
export function configFromEnv(env: Record<string, string | undefined>): McpConfig {
  const url = (env.VEQSIO_URL ?? '').trim()
  if (!url) throw new Error('VEQSIO_URL is required, for example https://jira.example.com')
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol')
  } catch {
    throw new Error(`VEQSIO_URL is not a valid http(s) URL: ${url}`)
  }
  const ro = (env.VEQSIO_MCP_READONLY ?? '').trim().toLowerCase()
  if (ro && !TRUE.has(ro) && !FALSE.has(ro)) throw new Error('VEQSIO_MCP_READONLY must be true or false')
  const timeout = Number(env.VEQSIO_TIMEOUT_MS)
  return {
    url,
    token: env.VEQSIO_TOKEN?.trim() || undefined,
    readOnly: !FALSE.has(ro),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
  }
}

/** The tools this configuration exposes. */
export function selectTools(cfg: Pick<McpConfig, 'token' | 'readOnly'>): ToolDef[] {
  return ALL_TOOLS.filter((t) => (cfg.token ? true : !!t.anonymous) && !(cfg.readOnly && t.write))
}

export interface CreateServerOptions extends McpConfig {
  /** Injected for tests (fake server or `app.request`). */
  fetch?: typeof fetch
}

export function createServer(opts: CreateServerOptions): { server: McpServer; client: VeqsioClient; tools: string[] } {
  const client = new VeqsioClient({ baseUrl: opts.url, token: opts.token, fetch: opts.fetch, timeoutMs: opts.timeoutMs, userAgent: `veqsio-mcp/${SERVER_VERSION}` })
  const tools = selectTools(opts)
  const mode = opts.readOnly ? 'read-only mode: no tools that change data are available' : 'read/write mode'
  const auth = opts.token ? '' : ' No token is configured, so only the anonymous public tools are available.'
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: `Tools for a Veqsio (Jira-like) issue tracker, ${mode}.${auth} Every call runs with the permissions of one user's personal access token. ${UNTRUSTED_NOTICE} Issue keys look like PROJ-123. Results are truncated and paged: use start_at to continue.`,
    },
  )
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.shape,
        annotations: { readOnlyHint: !t.write, destructiveHint: false, idempotentHint: !t.write, openWorldHint: true },
      },
      (async (args: unknown) => {
        try {
          const text = await t.handler({ client }, args ?? {})
          return { content: [{ type: 'text' as const, text }] }
        } catch (e) {
          return { isError: true, content: [{ type: 'text' as const, text: describeError(e) }] }
        }
      }) as any,
    )
  }
  // Resources and prompts read through the authenticated tools, so they exist only with a token
  if (opts.token) registerExtras(server, client)
  return { server, client, tools: tools.map((t) => t.name) }
}
