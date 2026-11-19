'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Spinner } from '@/components/spinner'
import { BrandLockup } from '@/components/brand-logo'
import { useBranding } from '@/hooks/use-branding'

/**
 * Minimal built-in viewer for the OpenAPI document served at /rest/api/2/openapi.json (public, no instance data).
 * No external viewer bundle: tags, endpoints, parameters, request bodies, responses and schemas, plus a filter box.
 */
type Json = any
interface Doc { info: { title: string; version: string; description?: string }; tags: { name: string }[]; paths: Record<string, Record<string, Json>>; components: { schemas: Record<string, Json>; securitySchemes: Record<string, Json> } }

const METHOD_STYLE: Record<string, string> = {
  get: 'bg-blue-100 text-blue-800', post: 'bg-green-100 text-green-800', put: 'bg-amber-100 text-amber-800',
  patch: 'bg-amber-100 text-amber-800', delete: 'bg-red-100 text-red-800',
}
const METHODS = ['get', 'post', 'put', 'patch', 'delete']

function typeLabel(s: Json): string {
  if (!s) return 'any'
  if (s.$ref) return String(s.$ref).split('/').pop() as string
  if (s.oneOf) return s.oneOf.map(typeLabel).join(' | ')
  if (s.type === 'array') return `${typeLabel(s.items)}[]`
  if (s.enum) return s.enum.map((e: string) => `"${e}"`).join(' | ')
  return [s.type, s.format].filter(Boolean).join(' / ') || 'object'
}

function SchemaView({ schema, schemas, depth = 0 }: { schema: Json; schemas: Record<string, Json>; depth?: number }) {
  if (!schema) return null
  const resolved = schema.$ref ? schemas[String(schema.$ref).split('/').pop() as string] : schema
  if (schema.$ref && depth >= 2) return <code className="text-xs">{typeLabel(schema)}</code>
  const target = schema.type === 'array' && schema.items ? schema.items : resolved
  const shown = target?.$ref ? schemas[String(target.$ref).split('/').pop() as string] : target
  const props = shown?.properties as Record<string, Json> | undefined
  return (
    <div className="text-sm">
      <code className="text-xs">{typeLabel(schema)}</code>
      {resolved?.description && <p className="text-[var(--text-secondary)]">{resolved.description}</p>}
      {props && depth < 3 && (
        <ul className="mt-1 ml-3 border-l border-[var(--surface-3)] pl-3 space-y-1">
          {Object.entries(props).map(([name, p]) => (
            <li key={name}>
              <span className="font-mono">{name}</span>
              {shown.required?.includes(name) && <span className="text-[var(--error)]" title="required" aria-label="required"> *</span>}
              <span className="text-[var(--text-tertiary)]">{' '}{typeLabel(p)}</span>
              {p.description && <span className="text-[var(--text-secondary)]"> - {p.description}</span>}
              {(p.$ref || p.items?.$ref || p.properties) && depth < 2 && <SchemaView schema={p} schemas={schemas} depth={depth + 1} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Operation({ path, method, op, schemas }: { path: string; method: string; op: Json; schemas: Record<string, Json> }) {
  const open = op.security?.length === 0 ? 'Public' : op.security?.[0]?.metricsToken ? 'Metrics token' : op.security?.[0]?.webhookSignature ? 'Signature' : 'Signed in'
  return (
    <details className="rounded border border-[var(--surface-3)] bg-[var(--surface-0)]">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${METHOD_STYLE[method] ?? 'bg-[var(--surface-2)]'}`}>{method}</span>
        <code className="text-sm break-all">{path}</code>
        <span className="text-sm text-[var(--text-secondary)]">{op.summary}</span>
        <span className="ml-auto text-xs text-[var(--text-tertiary)]">{open}{op['x-documented'] === 'generated' ? ' · outline only' : ''}</span>
      </summary>
      <div className="space-y-3 border-t border-[var(--surface-3)] px-3 py-3 text-sm">
        {op.description && <p className="whitespace-pre-line">{op.description}</p>}
        {op.parameters?.length > 0 && (
          <table className="w-full">
            <caption className="text-left font-medium">Parameters</caption>
            <thead className="sr-only"><tr><th scope="col">Name</th><th scope="col">In</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead>
            <tbody>
              {op.parameters.map((p: Json) => (
                <tr key={p.in + p.name} className="border-t border-[var(--surface-3)] align-top">
                  <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">{p.name}{p.required && <span className="text-[var(--error)]"> *</span>}</th>
                  <td className="pr-3 text-[var(--text-tertiary)]">{p.in}</td>
                  <td className="pr-3"><code className="text-xs">{typeLabel(p.schema)}</code></td>
                  <td>{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {op.requestBody && (
          <div><h4 className="font-medium">Request body (JSON)</h4><SchemaView schema={op.requestBody.content?.['application/json']?.schema} schemas={schemas} /></div>
        )}
        <div>
          <h4 className="font-medium">Responses</h4>
          <ul className="space-y-1">
            {Object.entries<Json>(op.responses ?? {}).map(([code, r]) => (
              <li key={code}><span className="font-mono">{code}</span> {r.description}
                {r.content?.['application/json']?.schema && Number(code) < 300 && <SchemaView schema={r.content['application/json'].schema} schemas={schemas} depth={1} />}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  )
}

export default function ApiDocsPage() {
  const b = useBranding()
  const [filter, setFilter] = useState('')
  const [onlyTag, setOnlyTag] = useState('')
  const { data, isLoading, error } = useQuery({
    queryKey: ['openapi'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch('/rest/api/2/openapi.json')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as Doc
    },
  })

  const groups = useMemo(() => {
    if (!data) return []
    const q = filter.trim().toLowerCase()
    const byTag = new Map<string, Array<{ path: string; method: string; op: Json }>>()
    for (const [path, item] of Object.entries(data.paths)) {
      for (const method of METHODS) {
        const op = item[method]
        if (!op) continue
        const tag = op.tags?.[0] ?? 'Other'
        if (onlyTag && tag !== onlyTag) continue
        if (q && !`${method} ${path} ${op.summary} ${op.operationId}`.toLowerCase().includes(q)) continue
        if (!byTag.has(tag)) byTag.set(tag, [])
        byTag.get(tag)!.push({ path, method, op })
      }
    }
    return [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [data, filter, onlyTag])

  const total = groups.reduce((n, [, ops]) => n + ops.length, 0)

  return (
    <div className="min-h-dvh bg-[var(--surface-1)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--surface-3)] bg-[var(--surface-0)]">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link href="/" className="flex items-center" aria-label={b.siteName}><BrandLockup height={24} /></Link>
          <span className="text-[var(--text-secondary)]">REST API reference</span>
          <a href="/rest/api/2/openapi.json" className="ml-auto text-sm text-[var(--brand-600)] hover:underline">Download openapi.json</a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
        {isLoading && <Spinner />}
        {error && <p role="alert" className="text-[var(--error)]">Could not load the API description: {(error as Error).message}</p>}
        {data && (
          <>
            <div>
              <h1 className="text-heading-1">{data.info.title} <span className="text-base font-normal text-[var(--text-tertiary)]">v{data.info.version}</span></h1>
              <p className="whitespace-pre-line text-sm text-[var(--text-secondary)]">{data.info.description}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex-1 min-w-[16rem]">
                <span className="sr-only">Filter endpoints</span>
                <input type="search" className="veqsio-input w-full" placeholder="Filter by path, method or summary" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </label>
              <label>
                <span className="sr-only">Tag</span>
                <select className="veqsio-input" value={onlyTag} onChange={(e) => setOnlyTag(e.target.value)}>
                  <option value="">All tags</option>
                  {data.tags.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              </label>
            </div>
            <p className="text-sm text-[var(--text-secondary)]" aria-live="polite">{total} endpoint{total === 1 ? '' : 's'}</p>
            {groups.length === 0 && <p className="text-[var(--text-secondary)]">No endpoint matches the filter.</p>}
            {groups.map(([tag, ops]) => (
              <section key={tag} aria-labelledby={`tag-${tag}`} className="space-y-2">
                <h2 id={`tag-${tag}`} className="text-heading-2">{tag} <span className="text-sm font-normal text-[var(--text-tertiary)]">({ops.length})</span></h2>
                {ops.map(({ path, method, op }) => <Operation key={method + path} path={path} method={method} op={op} schemas={data.components.schemas} />)}
              </section>
            ))}
            <section aria-labelledby="schemas-h" className="space-y-2">
              <h2 id="schemas-h" className="text-heading-2">Schemas</h2>
              {Object.entries(data.components.schemas).map(([name, s]) => (
                <details key={name} className="rounded border border-[var(--surface-3)] bg-[var(--surface-0)]">
                  <summary className="cursor-pointer px-3 py-2 font-mono text-sm">{name}</summary>
                  <div className="border-t border-[var(--surface-3)] px-3 py-3"><SchemaView schema={s} schemas={data.components.schemas} depth={1} /></div>
                </details>
              ))}
            </section>
          </>
        )}
      </main>
    </div>
  )
}
