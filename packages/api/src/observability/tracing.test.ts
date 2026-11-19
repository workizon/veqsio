import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode } from '@opentelemetry/api'
import { initTracing, isTracing, parseHeaders, parseResourceAttributes, tracesUrl, resetTracingForTests, samplerFromEnv, shutdownTracing, traceJob, tracingConfigured, withSpan } from './tracing'
import { requestLog } from '../middleware/request-log'
import { logger, requestContext, setLogSink } from '../ops/logger'
import { outboundFetch } from '../security/outbound'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT_SPAN = '00f067aa0ba902b7'
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN}-01`

let exporter: InMemorySpanExporter
const spans = () => exporter.getFinishedSpans()

function buildApp() {
  const app = new Hono()
  app.use('*', requestLog() as any)
  app.get('/rest/api/2/issue/:key', (c) => c.json({ key: c.req.param('key') }))
  app.get('/boom', () => { throw new TypeError('secret detail that must not be exported') })
  app.get('/slow/:id', async (c) => { await withSpan('webhook.deliver', { 'veqsio.webhook.event': 'issue.created' }, async () => 'ok'); return c.text('done') })
  return app
}

beforeEach(() => {
  resetTracingForTests()
  exporter = new InMemorySpanExporter()
  initTracing({ exporter: undefined, spanProcessors: [new SimpleSpanProcessor(exporter)], env: { OTEL_SERVICE_NAME: 'veqsio-test', OTEL_RESOURCE_ATTRIBUTES: 'team=platform' }, version: '9.9.9' })
})
afterEach(() => { resetTracingForTests() })

describe('tracing configuration', () => {
  test('it is off unless an endpoint is set, and OTEL_SDK_DISABLED wins', () => {
    expect(tracingConfigured({})).toBe(false)
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true)
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' })).toBe(true)
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'true' })).toBe(false)
    resetTracingForTests()
    expect(initTracing({ env: {} })).toBe(false)
    expect(isTracing()).toBe(false)
  })

  test('samplers follow the standard variables and report mistakes instead of failing', () => {
    const problems: string[] = []
    expect(samplerFromEnv({}, problems).toString()).toContain('ParentBased')
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'always_off' }, problems).toString()).toContain('AlwaysOff')
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.25' }, problems).toString()).toContain('0.25')
    expect(problems).toEqual([])
    samplerFromEnv({ OTEL_TRACES_SAMPLER: 'nonsense' }, problems)
    samplerFromEnv({ OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '7' }, problems)
    expect(problems.length).toBe(2)
  })

  test('endpoint and headers follow the standard variables', () => {
    expect(tracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe('http://collector:4318/v1/traces')
    expect(tracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318///' })).toBe('http://collector:4318/v1/traces')
    expect(tracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:1', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://b:2/custom' })).toBe('http://b:2/custom')
    expect(parseHeaders('authorization=Bearer%20abc, x-team = platform ,broken')).toEqual({ authorization: 'Bearer abc', 'x-team': 'platform' })
    expect(parseHeaders(undefined)).toEqual({})
  })

  test('resource attributes are parsed from OTEL_RESOURCE_ATTRIBUTES', () => {
    expect(parseResourceAttributes('a=1, b = two ,broken,=x,c=')).toEqual({ a: '1', b: 'two' })
    expect(parseResourceAttributes(undefined)).toEqual({})
  })
})

describe('request spans', () => {
  test('a request becomes a server span named by the route pattern, with status and request id, and nothing personal', async () => {
    const res = await buildApp().request('/rest/api/2/issue/SECRET-42?token=abc&email=a@b.c', { headers: { 'x-request-id': 'req-1234567890', authorization: 'Bearer top-secret', cookie: 'session=x' } })
    expect(res.status).toBe(200)
    expect(spans()).toHaveLength(1)
    const s = spans()[0]
    expect(s.name).toBe('GET /rest/api/2/issue/:key')
    expect(s.kind).toBe(1) // SERVER
    expect(s.attributes).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/rest/api/2/issue/:key', 'http.response.status_code': 200, 'veqsio.request_id': 'req-1234567890' })
    expect(s.resource.attributes).toMatchObject({ 'service.name': 'veqsio-test', 'service.version': '9.9.9', team: 'platform' })
    const everything = JSON.stringify({ a: s.attributes, n: s.name, e: s.events, l: s.links })
    for (const leak of ['SECRET-42', 'token=abc', 'a@b.c', 'top-secret', 'session=x']) expect(everything).not.toContain(leak)
  })

  test('an incoming traceparent is continued: same trace, the caller’s span is the parent', async () => {
    await buildApp().request('/rest/api/2/issue/A-1', { headers: { traceparent: TRACEPARENT } })
    const s = spans()[0]
    expect(s.spanContext().traceId).toBe(TRACE_ID)
    expect(s.parentSpanContext?.spanId).toBe(PARENT_SPAN)
    // no or broken header: a new trace, no parent
    exporter.reset()
    await buildApp().request('/rest/api/2/issue/A-1', { headers: { traceparent: 'garbage' } })
    await buildApp().request('/rest/api/2/issue/A-1')
    expect(spans().every((x) => x.parentSpanContext === undefined)).toBe(true)
    expect(new Set(spans().map((x) => x.spanContext().traceId)).size).toBe(2)
  })

  test('a failing request is an error span with the error type but never its message', async () => {
    const res = await buildApp().request('/boom')
    expect(res.status).toBe(500)
    const s = spans()[0]
    expect(s.status.code).toBe(SpanStatusCode.ERROR)
    expect(s.attributes['http.response.status_code']).toBe(500)
    expect(s.attributes['error.type']).toBe('TypeError')
    expect(JSON.stringify(s.attributes) + JSON.stringify(s.events)).not.toContain('secret detail')
  })

  test('an unknown path is named "unmatched" so URLs cannot blow up the cardinality', async () => {
    const res = await buildApp().request('/no/such/path/with-an-id-1234')
    expect(res.status).toBe(404)
    expect(spans()[0].name).toBe('GET unmatched')
    expect(JSON.stringify(spans()[0].attributes)).not.toContain('with-an-id-1234')
  })

  test('withSpan makes a child of the request span; log lines carry the trace and span ids', async () => {
    const lines: string[] = []
    const restore = setLogSink((l) => lines.push(l))
    try {
      const app = buildApp()
      app.get('/log', (c) => { logger.warn('inside a request'); return c.text('ok') })
      await app.request('/slow/7', { headers: { traceparent: TRACEPARENT } })
      await app.request('/log', { headers: { traceparent: TRACEPARENT } })
    } finally { restore() }
    const child = spans().find((s) => s.name === 'webhook.deliver')!
    const server = spans().find((s) => s.name === 'GET /slow/:id')!
    expect(child.parentSpanContext?.spanId).toBe(server.spanContext().spanId)
    expect(child.spanContext().traceId).toBe(TRACE_ID)
    expect(child.attributes).toEqual({ 'veqsio.webhook.event': 'issue.created' })
    const rec = JSON.parse(lines.find((l) => l.includes('inside a request'))!)
    expect(rec.trace_id).toBe(TRACE_ID)
    expect(rec.span_id).toMatch(/^[0-9a-f]{16}$/)
    expect(rec.request_id).toBeTruthy()
  })

  test('the number of database queries is a count on the span, nothing else about them', async () => {
    const app = new Hono()
    app.use('*', requestLog() as any)
    app.get('/q', (c) => { const s = requestContext.getStore()!; s.dbQueries = (s.dbQueries ?? 0) + 3; return c.text('ok') })
    await app.request('/q')
    expect(spans()[0].attributes['db.query.count']).toBe(3)
  })

  test('with tracing off nothing is created and requests behave as before', async () => {
    resetTracingForTests()
    const res = await buildApp().request('/rest/api/2/issue/A-1')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(spans()).toHaveLength(0)
    expect(await withSpan('x', {}, async () => 42)).toBe(42)
  })
})

describe('job spans', () => {
  test('a run is a root span with its result, and a failure marks the span', async () => {
    await traceJob('email-queue', async () => 'success', (r) => r)
    await traceJob('sla-breach', async () => 'failure', (r) => r)
    await expect(traceJob('boom', async () => { throw new RangeError('x') }, (r: string) => r)).rejects.toThrow()
    const [a, b, c] = spans()
    expect(a.name).toBe('job email-queue'); expect(a.attributes['veqsio.job.result']).toBe('success'); expect(a.status.code).toBe(SpanStatusCode.UNSET)
    expect(b.status.code).toBe(SpanStatusCode.ERROR)
    expect(c.attributes['error.type']).toBe('RangeError')
    expect(a.parentSpanContext).toBeUndefined()
  })
})

describe('export to a collector', () => {
  test('spans reach an OTLP/HTTP endpoint as JSON with the standard fields', async () => {
    resetTracingForTests()
    const received: any[] = []
    const server = Bun.serve({ port: 0, async fetch(req) { received.push({ path: new URL(req.url).pathname, type: req.headers.get('content-type'), key: req.headers.get('x-api-key'), body: await req.json() }); return new Response('{}', { headers: { 'content-type': 'application/json' } }) } })
    try {
      const ok = initTracing({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}`, OTEL_SERVICE_NAME: 'veqsio-export-test', OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=k-123' } })
      expect(ok).toBe(true)
      await buildApp().request('/rest/api/2/issue/A-1', { headers: { traceparent: TRACEPARENT } })
      await shutdownTracing() // flushes the batch
      expect(received.length).toBeGreaterThan(0)
      const r = received[0]
      expect(r.path).toBe('/v1/traces')
      expect(r.type).toContain('application/json')
      expect(r.key).toBe('k-123')
      const rs = r.body.resourceSpans[0]
      expect(rs.resource.attributes.find((a: any) => a.key === 'service.name').value.stringValue).toBe('veqsio-export-test')
      const span = rs.scopeSpans[0].spans[0]
      expect(span.name).toBe('GET /rest/api/2/issue/:key')
      expect(span.traceId).toBe(TRACE_ID)
      expect(span.parentSpanId).toBe(PARENT_SPAN)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
    } finally { server.stop(true) }
  })
})

describe('outgoing HTTP spans', () => {
  test('a client span carries method, host and status, never the path, query or body', async () => {
    const fake = (async () => new Response('ok', { status: 202 })) as unknown as typeof fetch
    const res = await outboundFetch('https://hooks.example.com/services/T000/B000/SECRET-TOKEN?token=abc', { method: 'POST', body: '{"secret":"x"}' }, { fetchImpl: fake, env: { VEQSIO_EGRESS_GUARD: 'off' } as any })
    expect(res.status).toBe(202)
    const out = spans().find((x) => x.name.startsWith('POST'))
    expect(out).toBeDefined()
    expect(out!.name).toBe('POST hooks.example.com')
    expect(out!.attributes['server.address']).toBe('hooks.example.com')
    expect(out!.attributes['http.response.status_code']).toBe(202)
    expect(JSON.stringify(out!.attributes)).not.toContain('SECRET-TOKEN')
    expect(JSON.stringify(out!.attributes)).not.toContain('abc')
  })
})
