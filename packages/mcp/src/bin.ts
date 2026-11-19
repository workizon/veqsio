#!/usr/bin/env bun
/**
 * Veqsio MCP server over stdio.
 *
 *   VEQSIO_URL=https://jira.example.com VEQSIO_TOKEN=veqsio_... bun packages/mcp/src/bin.ts
 *
 * stdout carries the protocol only; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configFromEnv, createServer } from './server'

try {
  const cfg = configFromEnv(process.env)
  const { server, tools } = createServer(cfg)
  if (!cfg.token) console.error('[veqsio-mcp] VEQSIO_TOKEN is not set: only the anonymous public tools are available')
  console.error(`[veqsio-mcp] ${cfg.url} | ${cfg.readOnly ? 'read-only' : 'read/write'} | ${tools.length} tools`)
  await server.connect(new StdioServerTransport())
} catch (e) {
  console.error(`[veqsio-mcp] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
