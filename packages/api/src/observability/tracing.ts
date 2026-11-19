/**
 * OpenTelemetry tracing. Off unless an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT), and then it only ever sends to that endpoint. It uses the standard variables:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT / _TRACES_ENDPOINT / _HEADERS / _TIMEOUT   where to send (OTLP over HTTP, JSON)
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES                            who is sending
 *   OTEL_TRACES_SAMPLER, OTEL_TRACES_SAMPLER_ARG                           what to keep (default: follow the caller's decision)
 *   OTEL_SDK_DISABLED=true                                                 force off
 *
 * What a span carries is deliberately small: the method, the route PATTERN (never the raw path, the query string or any header),
 * the status code, the request id and the number of database queries. No user, no address, no body, no error message.
 * An incoming W3C `traceparent` header is honoured so a request shows up inside the caller's trace.
 */
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, propagation, trace, type Span, type Tracer } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOffSampler, AlwaysOnSampler, BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler,
  type Sampler, type SpanExporter, type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { requestContext } from '../ops/logger';

type Env = Record<string, string | undefined>;

let provider: BasicTracerProvider | null = null;
let tracer: Tracer | null = null;

/** True when the environment asks for tracing: an endpoint is set and the SDK is not disabled. */
export function tracingConfigured(env: Env = process.env): boolean {
  if ((env.OTEL_SDK_DISABLED || '').toLowerCase() === 'true') return false;
  return !!(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

export const isTracing = () => tracer !== null;

/** The sampler named by OTEL_TRACES_SAMPLER; unknown values fall back to the default and say so through `problems`. */
export function samplerFromEnv(env: Env = process.env, problems: string[] = []): Sampler {
  const name = (env.OTEL_TRACES_SAMPLER || 'parentbased_always_on').toLowerCase();
  const arg = Number(env.OTEL_TRACES_SAMPLER_ARG);
  const ratio = Number.isFinite(arg) && env.OTEL_TRACES_SAMPLER_ARG !== undefined && env.OTEL_TRACES_SAMPLER_ARG !== '' ? Math.min(Math.max(arg, 0), 1) : 1;
  if (env.OTEL_TRACES_SAMPLER_ARG && !(Number.isFinite(arg) && arg >= 0 && arg <= 1) && name.includes('ratio')) problems.push('OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1');
  switch (name) {
    case 'always_on': return new AlwaysOnSampler();
    case 'always_off': return new AlwaysOffSampler();
    case 'traceidratio': return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_off': return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio': return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    case 'parentbased_always_on': return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    default: problems.push(`unknown OTEL_TRACES_SAMPLER "${name}", using parentbased_always_on`); return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

/** OTEL_RESOURCE_ATTRIBUTES: "key=value,key2=value2". */
export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) { const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim(); if (k && v) out[k] = v; }
  }
  return out;
}

/** OTEL_EXPORTER_OTLP_HEADERS: "key=value,key2=value2" (values may be percent-encoded), for example an API key for a hosted collector. */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      let v = part.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch { /* keep it as written */ }
      if (k) out[k] = v;
    }
  }
  return out;
}

/** Where traces go: the traces endpoint as given, or the general endpoint plus /v1/traces. */
export function tracesUrl(env: Env): string {
  const specific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (specific) return specific;
  return `${(env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '')}/v1/traces`;
}

function exporterFromEnv(env: Env): SpanExporter {
  const timeout = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT);
  return new OTLPTraceExporter({
    url: tracesUrl(env),
    headers: { ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) },
    timeoutMillis: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
  });
}

/** Starts tracing when configured. Safe to call twice. Pass `exporter` / `processors` in tests. Returns whether tracing is on. */
export function initTracing(opts: { env?: Env; exporter?: SpanExporter; spanProcessors?: SpanProcessor[]; version?: string } = {}): boolean {
  if (tracer) return true;
  const env = opts.env ?? process.env;
  if (!opts.exporter && !opts.spanProcessors && !tracingConfigured(env)) return false;
  const problems: string[] = [];
  const resource = resourceFromAttributes({
    ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'veqsio-api',
    [ATTR_SERVICE_VERSION]: opts.version || env.VEQSIO_VERSION || env.npm_package_version || '1.0.0',
    'deployment.environment.name': env.NODE_ENV || 'production',
  });
  provider = new BasicTracerProvider({
    resource,
    sampler: samplerFromEnv(env, problems),
    spanProcessors: opts.spanProcessors ?? [new BatchSpanProcessor(opts.exporter ?? exporterFromEnv(env))],
  });
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  tracer = provider.getTracer('veqsio-api');
  for (const p of problems) console.warn(`[tracing] ${p}`);
  return true;
}

/** Sends what is buffered and stops. Called on shutdown so the last spans are not lost. */
export async function shutdownTracing(): Promise<void> {
  const p = provider;
  provider = null; tracer = null;
  try { await p?.shutdown(); } catch { /* the collector is gone: nothing more to do */ }
}

/** Test helper: forget the provider without exporting. */
export function resetTracingForTests(): void { provider = null; tracer = null; trace.disable(); propagation.disable(); }

export interface RequestSpan { span: Span; traceId: string; spanId: string }

/** The server span of a request, a child of the caller's span when a valid `traceparent` came in. Null when tracing is off. */
export function startRequestSpan(headers: { traceparent?: string | null; tracestate?: string | null }, method: string): RequestSpan | null {
  if (!tracer) return null;
  const carrier: Record<string, string> = {};
  if (headers.traceparent) carrier.traceparent = headers.traceparent;
  if (headers.tracestate) carrier.tracestate = headers.tracestate;
  const parent = propagation.extract(ROOT_CONTEXT, carrier);
  const span = tracer.startSpan(method, { kind: SpanKind.SERVER, attributes: { 'http.request.method': method } }, parent);
  const sc = span.spanContext();
  return { span, traceId: sc.traceId, spanId: sc.spanId };
}

export function endRequestSpan(rs: RequestSpan | null, info: { method: string; route: string; status: number; requestId: string; dbQueries?: number; errorName?: string }): void {
  if (!rs) return;
  const { span } = rs;
  span.updateName(`${info.method} ${info.route}`);
  span.setAttributes({
    'http.route': info.route,
    'http.response.status_code': info.status,
    'veqsio.request_id': info.requestId,
    ...(info.dbQueries ? { 'db.query.count': info.dbQueries } : {}),
  });
  if (info.status >= 500 || info.errorName) {
    if (info.errorName) span.setAttribute('error.type', info.errorName);
    else span.setAttribute('error.type', String(info.status));
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

/**
 * A span around a piece of work, a child of the current request when there is one. For code that does something slow or remote
 * (a webhook call, an e-mail). Only put low-cardinality, non-personal values in `attributes`. When tracing is off it just runs `fn`.
 */
export async function withSpan<T>(
  name: string, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>,
  opts: { client?: boolean; after?: (result: T) => Record<string, string | number | boolean> } = {},
): Promise<T> {
  if (!tracer) return fn();
  const parent = requestContext.getStore()?.span;
  const ctx = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
  const span = tracer.startSpan(name, { kind: opts.client ? SpanKind.CLIENT : SpanKind.INTERNAL, attributes }, ctx);
  try {
    const r = await fn();
    if (opts.after) for (const [k, v] of Object.entries(opts.after(r))) span.setAttribute(k, v);
    return r;
  } catch (e) {
    span.setAttribute('error.type', e instanceof Error ? e.name : 'Error');
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw e;
  } finally {
    span.end();
  }
}

/** A root span for one run of a background job. */
export async function traceJob<T>(job: string, fn: () => Promise<T>, result: (r: T) => string): Promise<T> {
  if (!tracer) return fn();
  const span = tracer.startSpan(`job ${job}`, { kind: SpanKind.INTERNAL, attributes: { 'veqsio.job': job } }, ROOT_CONTEXT);
  try {
    const r = await fn();
    const outcome = result(r);
    span.setAttribute('veqsio.job.result', outcome);
    if (outcome === 'failure') span.setStatus({ code: SpanStatusCode.ERROR });
    return r;
  } catch (e) {
    span.setAttribute('error.type', e instanceof Error ? e.name : 'Error');
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw e;
  } finally {
    span.end();
  }
}
