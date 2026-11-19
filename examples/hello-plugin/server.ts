// Minimal Veqsio plugin: verifies signed deliveries, logs events, serves one UI panel.
// Run: SIGNING_SECRET=whsec_... PORT=8787 bun server.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.SIGNING_SECRET ?? ''
const PORT = Number(process.env.PORT ?? 8787)
const WINDOW_SECONDS = 300
if (!SECRET) throw new Error('Set SIGNING_SECRET to the secret shown when the plugin was installed')

function verify(timestamp: string, body: string, signature: string): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WINDOW_SECONDS) return false // replay protection
  const expected = Buffer.from('v1=' + createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex'))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

const seen = new Set<string>() // delivery ids; retries reuse the id, so handlers must be idempotent

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/manifest.json') return Response.json(await Bun.file(new URL('./manifest.json', import.meta.url)).json())

    if (url.pathname === '/veqsio/events' && req.method === 'POST') {
      const body = await req.text() // verify the RAW body, before parsing
      const ok = verify(req.headers.get('x-veqsio-timestamp') ?? '', body, req.headers.get('x-veqsio-signature') ?? '')
      if (!ok) return new Response('bad signature', { status: 401 })
      const id = req.headers.get('x-veqsio-delivery') ?? ''
      if (!seen.has(id)) {
        seen.add(id)
        const { event, payload } = JSON.parse(body)
        console.log(`[hello] ${event}`, JSON.stringify(payload))
        // Fetch details with the plugin token if needed:
        //   fetch(`${VEQSIO_URL}/rest/api/2/issue/${payload.issueKey}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
      }
      return new Response('ok')
    }

    if (url.pathname === '/panel') {
      const issue = (url.searchParams.get('issue') ?? '').replace(/[^A-Za-z0-9_-]/g, '')
      const html = `<!doctype html><meta charset=utf-8><body style="font:14px sans-serif;margin:8px">
        Hello from a plugin${issue ? ` about <b>${issue}</b>` : ''}.
        <script>parent.postMessage({ source: 'veqsio-plugin', type: 'resize', height: document.body.scrollHeight + 16 }, '*')</script>`
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    return new Response('not found', { status: 404 })
  },
})
console.log(`hello-plugin listening on :${PORT}`)
