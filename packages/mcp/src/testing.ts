/**
 * Test helper: connects a real MCP client to a server instance over an in-memory transport, so tests exercise the
 * full protocol (initialize, tools/list, tools/call) without a subprocess. Not used at runtime.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer, type CreateServerOptions } from './server'

export async function connectInMemory(opts: CreateServerOptions) {
  const { server, tools } = createServer(opts)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args })
    return { isError: !!r.isError, text: (r.content ?? []).map((c: any) => c.text).join('\n') as string }
  }
  return { client, call, tools, close: () => client.close() }
}
