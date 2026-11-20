'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'

type Level = 'debug' | 'info' | 'warn' | 'error'
interface LogRecord { ts: string; level: Level; msg: string; request_id?: string; [k: string]: unknown }
interface LogsResult { records: LogRecord[]; level: { effective: string; fromEnvironment: string; temporary: { level: string; expiresAt: string } | null }; note: string }
interface Slow { query: string; calls: number; meanMs: number; maxMs: number; totalMs: number; rows: number }
interface SlowResult { enabled: boolean; howTo?: string; statements: Slow[] }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.errorMessages?.[0] ?? r.statusText)
  return r.json()
}
const LEVEL_CLS: Record<Level, string> = {
  debug: 'text-[var(--text-tertiary)]', info: 'text-[var(--text-primary)]', warn: 'text-amber-700', error: 'text-[var(--error)] font-medium',
}

function LogLevelCard({ data }: { data: LogsResult }) {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const [minutes, setMinutes] = useState(60)
  const set = useMutation({
    mutationFn: async (level: Level | null) => {
      const r = await fetch('/rest/api/2/admin/system/log-level', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level, minutes }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.errorMessages?.[0] ?? tr('Could not change the log level'))
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'logs'] }); toast(tr('Log level changed'), 'success') },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <section className="veqsio-card p-4 space-y-2" aria-labelledby="lvl-h">
      <h2 id="lvl-h" className="text-heading-3">{tr('Log level')}</h2>
      <p className="text-sm text-[var(--text-secondary)]">
        {tr('Now:')} <strong>{data.level.effective}</strong> {tr('(from the environment:')} {data.level.fromEnvironment}).
        {data.level.temporary && <> {tr('Set temporarily, until')} {new Date(data.level.temporary.expiresAt).toLocaleTimeString(getIntlLocale())}.</>}
        {' '}{tr('A level set here applies to this node only and ends by itself, because verbose logging left on fills the disk.')} </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-[var(--text-secondary)]">{tr('For')} <select className="veqsio-input block mt-1" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[15, 60, 240, 1440].map((m) => <option key={m} value={m}>{m >= 60 ? `${m / 60} h` : `${m} min`}</option>)}
          </select>
        </label>
        {(['debug', 'info', 'warn', 'error'] as Level[]).map((l) => (
          <button key={l} type="button" className="veqsio-btn-secondary" disabled={set.isPending} onClick={() => set.mutate(l)}>{l}</button>
        ))}
        {data.level.temporary && <button type="button" className="veqsio-btn-ghost" disabled={set.isPending} onClick={() => set.mutate(null)}>{tr('Back to the environment level')}</button>}
      </div>
    </section>
  )
}

function Logs() {
  const { tr } = useI18n();

  const [level, setLevel] = useState('')
  const [q, setQ] = useState('')
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'logs', level, q],
    refetchInterval: 10_000,
    queryFn: () => getJson<LogsResult>(`/rest/api/2/admin/system/logs?limit=300${level ? `&level=${level}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  })
  return (
    <div className="space-y-4">
      {data && <LogLevelCard data={data} />}
      <section className="veqsio-card p-4 space-y-3" aria-labelledby="log-h">
        <h2 id="log-h" className="text-heading-3">{tr('Application log')}</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-[var(--text-secondary)]">{tr('Level and above')} <select className="veqsio-input block mt-1" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">{tr('All')}</option><option value="info">{tr('info')}</option><option value="warn">{tr('warn')}</option><option value="error">{tr('error')}</option>
            </select>
          </label>
          <label className="text-xs text-[var(--text-secondary)] grow max-w-md">{tr('Contains')} <input className="veqsio-input block mt-1 w-full" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('a request id, a route, a message')} />
          </label>
          <button type="button" className="veqsio-btn-secondary" onClick={() => void refetch()} disabled={isFetching}>{tr('Refresh')}</button>
        </div>
        {isLoading && <Spinner />}
        {error && <p role="alert" className="text-sm text-[var(--error)]">{(error as Error).message}</p>}
        {data && (
          <>
            <p className="text-xs text-[var(--text-tertiary)]">{data.note}</p>
            <div className="max-h-[32rem] overflow-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] font-mono text-[12px] leading-5" role="log" aria-label={tr('Application log')} tabIndex={0}>
              {data.records.length === 0 && <p className="p-3 text-[var(--text-tertiary)]">{tr('No records match.')}</p>}
              {data.records.map((r, i) => {
                const { ts, level: lv, msg, ...rest } = r
                return (
                  <div key={`${ts}-${i}`} className="border-b border-[var(--surface-3)] px-3 py-1 last:border-b-0">
                    <span className="text-[var(--text-tertiary)]">{new Date(ts).toLocaleTimeString(getIntlLocale())}</span>{' '}
                    <span className={LEVEL_CLS[lv]}>{lv.toUpperCase()}</span>{' '}
                    <span className="break-all">{msg}</span>
                    {Object.keys(rest).length > 0 && <span className="text-[var(--text-tertiary)] break-all"> {JSON.stringify(rest)}</span>}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function SlowQueries() {
  const { tr } = useI18n();

  const [by, setBy] = useState<'mean' | 'total'>('mean')
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'slow', by], queryFn: () => getJson<SlowResult>(`/rest/api/2/admin/system/slow-queries?by=${by}`) })
  return (
    <section className="veqsio-card p-4 space-y-3" aria-labelledby="slow-h">
      <h2 id="slow-h" className="text-heading-3">{tr('Slowest queries')}</h2>
      {isLoading && <Spinner />}
      {error && <p role="alert" className="text-sm text-[var(--error)]">{(error as Error).message}</p>}
      {data && !data.enabled && (
        <div className="space-y-2 text-sm">
          <p>{tr('The query statistics are not switched on in the database server, so there is nothing to show yet.')}</p>
          <p className="rounded-lg bg-[var(--surface-1)] p-3 text-[var(--text-secondary)]">{data.howTo}</p>
        </div>
      )}
      {data?.enabled && (
        <>
          <label className="text-xs text-[var(--text-secondary)]">{tr('Sorted by')} <select className="veqsio-input block mt-1" value={by} onChange={(e) => setBy(e.target.value as 'mean' | 'total')}>
              <option value="mean">{tr('Average time per call')}</option><option value="total">{tr('Total time')}</option>
            </select>
          </label>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{tr('The slowest statements')}</caption>
              <thead><tr className="text-left"><th scope="col">{tr('Statement')}</th><th scope="col" className="text-right">{tr('Calls')}</th><th scope="col" className="text-right">{tr('Average ms')}</th><th scope="col" className="text-right">{tr('Max ms')}</th><th scope="col" className="text-right">{tr('Total ms')}</th></tr></thead>
              <tbody>
                {data.statements.map((s, i) => (
                  <tr key={i} className="border-t border-[var(--surface-3)] align-top">
                    <td className="py-1.5 pr-3 font-mono text-[12px] break-all max-w-xl">{s.query}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.calls}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.meanMs}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.maxMs}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.totalMs}</td>
                  </tr>
                ))}
                {data.statements.length === 0 && <tr><td colSpan={5} className="py-2 text-[var(--text-tertiary)]">{tr('No statement has run often enough yet.')}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

export default function LogsPage() {
  const { tr } = useI18n();

  return (
    <AppLayout>
      <PageHeader title={tr('Logs and slow queries')} breadcrumb={[{ label: tr('Administration'), href: '/admin' }, { label: tr('Logs and slow queries') }]} description={tr('What the application has been saying, how loud it is, and which database statements take the longest.')} />
      <div className="space-y-4 max-w-5xl"><Logs /><SlowQueries /></div>
    </AppLayout>
  )
}
