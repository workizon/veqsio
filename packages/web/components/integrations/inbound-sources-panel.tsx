'use client'

import { useState } from 'react'
import { Check, Copy, FlaskConical, KeyRound, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import {
  useDeleteInboundSource, useInboundDeliveries, useInboundSources, useRotateInboundSecret, useSaveInboundSource, useTestInboundSource,
  type InboundPreview, type InboundSource,
} from '@/hooks/use-integrations'
import { EMPTY_FORM, PRESETS, formToMapping, mappingToForm, type MappingForm } from '@/lib/inbound-mapping'
import { confirmDialog } from '@/components/dialogs'

const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Request failed', 'error')

function CopyText({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-center gap-2 text-body-sm">
      <span className="w-20 shrink-0 text-[var(--text-secondary)]">{label}</span>
      <code className="flex-1 break-all font-mono text-xs">{value}</code>
      <button type="button" className="veqsio-btn-ghost p-1" aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500) } catch { toast('Copy failed', 'error') } }}>
        {done ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-body-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-caption text-[var(--text-tertiary)]">{hint}</span>}
    </label>
  )
}

function SourceForm({ project, source, onDone }: { project: string; source: InboundSource | null; onDone: (created?: { source: InboundSource; secret: string }) => void }) {
  const save = useSaveInboundSource(project)
  const [presetId, setPresetId] = useState('generic')
  const [name, setName] = useState(source?.name ?? '')
  const [type, setType] = useState<'generic' | 'sentry'>(source?.type ?? 'generic')
  const [authMode, setAuthMode] = useState<'hmac' | 'header'>(source?.authMode ?? 'hmac')
  const [form, setForm] = useState<MappingForm>(source ? mappingToForm(source.mapping) : mappingToForm(PRESETS[0].mapping))
  const set = (k: keyof MappingForm, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const preset = PRESETS.find((p) => p.id === presetId)

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) return
    setPresetId(id); setType(p.type); setForm(mappingToForm(p.mapping))
    if (!name.trim()) setName(p.label.split(' (')[0])
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const m = type === 'sentry' ? { mapping: {} } : formToMapping(form)
    if ('error' in m) { toast(m.error, 'error'); return }
    try {
      const res = await save.mutateAsync({ id: source?.id, name: name.trim(), ...(source ? {} : { type }), authMode: type === 'sentry' ? 'hmac' : authMode, mapping: m.mapping })
      toast(source ? 'Source saved' : 'Source created', 'success')
      onDone(!source ? { source: res as InboundSource, secret: String((res as { secret?: string }).secret ?? '') } : undefined)
    } catch (err) { fail(err) }
  }

  const text = 'veqsio-input mt-1 w-full font-mono text-xs'
  return (
    <form onSubmit={submit} className="space-y-4">
      {!source && (
        <Field label="Start from" hint={preset?.hint}>
          <select className="veqsio-input mt-1 w-full" value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="veqsio-input mt-1 w-full" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Grafana" /></Field>
        {type === 'generic' && (
          <Field label="Authentication" hint={authMode === 'hmac' ? 'HMAC-SHA256 of the body in X-Veqsio-Signature (or X-Hub-Signature-256).' : 'The secret is sent as X-Veqsio-Secret or as a Bearer token.'}>
            <select className="veqsio-input mt-1 w-full" value={authMode} onChange={(e) => setAuthMode(e.target.value as 'hmac' | 'header')}>
              <option value="hmac">Signature (HMAC)</option>
              <option value="header">Shared secret header</option>
            </select>
          </Field>
        )}
      </div>
      {type === 'sentry' ? (
        <p className="rounded-lg border border-[var(--surface-3)] p-3 text-body-sm text-[var(--text-secondary)]">
          Sentry payloads are understood out of the box: title, culprit, link and level become the issue, the level sets the priority, and the Sentry issue id is the dedup key. No mapping is needed.
        </p>
      ) : (
        <fieldset className="space-y-3 rounded-lg border border-[var(--surface-3)] p-3">
          <legend className="px-1 text-body-sm font-medium">Mapping</legend>
          <p className="text-caption text-[var(--text-secondary)]">
            Use <code>{'{{path.to[0].value}}'}</code> to insert payload values. Filters: <code>| default &quot;x&quot;</code>, <code>| upper</code>, <code>| lower</code>, <code>| truncate 80</code>, <code>| first</code>. Templates only read values; they never run code.
          </p>
          <Field label="Summary"><input className={text} value={form.summary} onChange={(e) => set('summary', e.target.value)} placeholder="[{{alerts[0].labels.alertname}}] {{alerts[0].annotations.summary}}" /></Field>
          <Field label="Description"><textarea className={text} rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
          <Field label="Comment on a repeat" hint="Added to the open issue when the same dedup key arrives again. Defaults to the description."><textarea className={text} rows={2} value={form.comment} onChange={(e) => set('comment', e.target.value)} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Severity / priority"><input className={text} value={form.priority} onChange={(e) => set('priority', e.target.value)} placeholder="{{alerts[0].labels.severity}}" /></Field>
            <Field label="Priority map" hint="One per line: severity=Priority name"><textarea className={text} rows={3} value={form.priorityMap} onChange={(e) => set('priorityMap', e.target.value)} placeholder={'critical=Highest\nwarning=High'} /></Field>
          </div>
          <Field label="Labels" hint="One template per line"><textarea className={text} rows={2} value={form.labels} onChange={(e) => set('labels', e.target.value)} placeholder="alert" /></Field>
          <Field label="Dedup key" hint="Same key = same problem: an open issue gets a comment instead of a duplicate."><input className={text} value={form.dedupKey} onChange={(e) => set('dedupKey', e.target.value)} placeholder="{{alerts[0].fingerprint}}" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Resolved when: path"><input className={text} value={form.resolvedPath} onChange={(e) => set('resolvedPath', e.target.value)} placeholder="status" /></Field>
            <Field label="Resolved when: equals" hint="Comma separated"><input className={text} value={form.resolvedEquals} onChange={(e) => set('resolvedEquals', e.target.value)} placeholder="resolved, ok" /></Field>
          </div>
          <Field label="Idempotency key (optional)" hint="Taken from the Idempotency-Key header when present; otherwise from this template."><input className={text} value={form.idempotencyKey} onChange={(e) => set('idempotencyKey', e.target.value)} placeholder="{{id}}" /></Field>
        </fieldset>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="veqsio-btn-secondary" onClick={() => onDone()}>Cancel</button>
        <button type="submit" className="veqsio-btn-primary" disabled={save.isPending}>{source ? 'Save' : 'Create source'}</button>
      </div>
    </form>
  )
}

function TestDialog({ project, source, onClose }: { project: string; source: InboundSource; onClose: () => void }) {
  const test = useTestInboundSource(project)
  const preset = PRESETS.find((p) => p.type === source.type && (source.type === 'sentry' || JSON.stringify(p.mapping) === JSON.stringify(source.mapping))) ?? PRESETS.find((p) => p.type === source.type)!
  const [text, setText] = useState(JSON.stringify(preset.sample, null, 2))
  const [result, setResult] = useState<InboundPreview | null>(null)

  const run = async (dryRun: boolean) => {
    let payload: unknown
    try { payload = JSON.parse(text) } catch { toast('The sample payload is not valid JSON', 'error'); return }
    if (!payload || typeof payload !== 'object') { toast('The payload must be a JSON object', 'error'); return }
    try { setResult(await test.mutateAsync({ id: source.id, payload, dryRun })) } catch (e) { fail(e) }
  }
  const n = result?.normalized
  return (
    <Modal isOpen onClose={onClose} title={`Test ${source.name}`} size="lg">
      <div className="space-y-3">
        <label className="block text-body-sm font-medium">Sample payload
          <textarea className="veqsio-input mt-1 w-full font-mono text-xs" rows={10} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="veqsio-btn-secondary" onClick={() => run(true)} disabled={test.isPending}>Preview (dry run)</button>
          <button type="button" className="veqsio-btn-secondary" onClick={async () => { if ((await confirmDialog('This really creates, comments on or transitions an issue as the source actor. Continue?'))) void run(false) }} disabled={test.isPending}>Send as test delivery</button>
          {test.isPending && <Spinner />}
        </div>
        {result && (
          <div role="status" className="space-y-2 rounded-lg border border-[var(--surface-3)] p-3 text-body-sm">
            {result.dryRun ? (
              n ? (
                <>
                  <p><strong>Would {result.plan?.action === 'create' ? 'create an issue' : result.plan?.action === 'comment' ? `comment on ${result.plan.issue?.key}` : result.plan?.action === 'transition' ? `resolve ${result.plan.issue?.key}` : 'do nothing'}</strong>{result.plan?.reason ? `: ${result.plan.reason}` : ''}</p>
                  <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
                    <dt className="text-[var(--text-secondary)]">Summary</dt><dd className="break-words">{n.summary}</dd>
                    <dt className="text-[var(--text-secondary)]">Priority</dt><dd>{n.priority ?? 'none'}</dd>
                    <dt className="text-[var(--text-secondary)]">Labels</dt><dd>{n.labels.join(', ') || 'none'}</dd>
                    <dt className="text-[var(--text-secondary)]">Dedup key</dt><dd className="break-all">{n.dedupKey ?? 'none (every payload is a new issue)'}</dd>
                    <dt className="text-[var(--text-secondary)]">Resolved</dt><dd>{n.resolved ? 'yes' : 'no'}</dd>
                    <dt className="text-[var(--text-secondary)]">Description</dt><dd className="whitespace-pre-wrap break-words">{n.description || '(empty)'}</dd>
                  </dl>
                </>
              ) : <p>{result.note}</p>
            ) : (
              <p><strong>Result: {result.status}</strong>{result.key ? ` (${result.key})` : ''}{result.reason ? `: ${result.reason}` : ''}</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function LogDialog({ project, source, onClose }: { project: string; source: InboundSource; onClose: () => void }) {
  const log = useInboundDeliveries(project, source.id)
  const [open, setOpen] = useState<number | null>(null)
  return (
    <Modal isOpen onClose={onClose} title={`Deliveries of ${source.name}`} size="lg">
      <p className="mb-3 text-caption text-[var(--text-secondary)]">The last 100 deliveries. Payloads are redacted (passwords, tokens, keys) and capped at 8 KB. Requests with a bad signature are not logged.</p>
      {log.isLoading ? <Spinner /> : (log.data ?? []).length === 0 ? <p className="text-body-sm text-[var(--text-tertiary)]">Nothing received yet.</p> : (
        <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)]">
          {(log.data ?? []).map((d) => (
            <li key={d.id} className="p-2 text-body-sm">
              <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${['created', 'commented', 'transitioned'].includes(d.status) ? 'bg-[var(--success)]/10 text-[var(--success)]' : d.status === 'error' || d.status === 'rejected' ? 'bg-[var(--error)]/10 text-[var(--error)]' : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'}`}>{d.status}</span>
                {d.isTest && <span className="text-caption text-[var(--text-tertiary)]">test</span>}
                <span className="flex-1 truncate">{d.issueKey ?? d.reason ?? ''}{d.dedupKey ? ` · ${d.dedupKey}` : ''}</span>
                <time className="text-caption text-[var(--text-tertiary)]" dateTime={d.createdAt}>{new Date(d.createdAt).toLocaleString()}</time>
              </button>
              {open === d.id && (
                <div className="mt-2 space-y-1">
                  {d.reason && <p className="text-caption text-[var(--text-secondary)]">{d.reason}</p>}
                  {d.idempotencyKey && <p className="text-caption text-[var(--text-secondary)]">Idempotency key: {d.idempotencyKey}</p>}
                  <pre className="max-h-64 overflow-auto rounded bg-[var(--surface-1)] p-2 text-[11px]">{d.payload}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/** Project settings: inbound webhook sources (alerts, CI, Sentry) that create and update issues. */
export function InboundSourcesPanel({ projectKey }: { projectKey: string }) {
  const sources = useInboundSources(projectKey)
  const rotate = useRotateInboundSecret(projectKey)
  const remove = useDeleteInboundSource(projectKey)
  const save = useSaveInboundSource(projectKey)
  const [editing, setEditing] = useState<InboundSource | 'new' | null>(null)
  const [testing, setTesting] = useState<InboundSource | null>(null)
  const [logging, setLogging] = useState<InboundSource | null>(null)
  const [reveal, setReveal] = useState<{ source: InboundSource; secret: string } | null>(null)

  return (
    <div className="space-y-5">
      <p className="text-body-sm text-[var(--text-secondary)]">
        External systems (Grafana, GitHub Actions, Sentry, scripts) can POST to a source URL. Each source has its own secret and mapping, creates an issue, comments on the open issue with the same dedup key, and resolves it when the system reports recovery.
      </p>
      {reveal && (
        <div role="status" className="space-y-2 rounded-lg border border-[var(--brand-500)] p-4">
          <p className="text-body-sm font-medium">{reveal.source.name}: copy these now. The secret is not shown again, only replaced.</p>
          <CopyText label="URL" value={reveal.source.url} />
          <CopyText label="Secret" value={reveal.secret} />
          <p className="text-caption text-[var(--text-secondary)]">
            Header: <code>{reveal.source.signatureHeader}</code>{reveal.source.signatureHeader === 'X-Veqsio-Signature' ? ' = sha256=<hex HMAC-SHA256 of the raw body>' : reveal.source.signatureHeader === 'X-Veqsio-Secret' ? ' = the secret' : ' = signed by Sentry with this secret as client secret'}. Optional <code>Idempotency-Key</code> header drops retries.
          </p>
          <button type="button" className="veqsio-btn-secondary text-sm" onClick={() => setReveal(null)}>I have copied it</button>
        </div>
      )}
      <div className="flex justify-end">
        <button type="button" className="veqsio-btn-primary flex items-center gap-1.5" onClick={() => setEditing('new')}><Plus className="w-4 h-4" aria-hidden="true" /> Add source</button>
      </div>
      {sources.isLoading ? <Spinner /> : sources.error ? <p role="alert" className="text-[var(--error)]">{(sources.error as Error).message}</p> : (
        <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)]">
          {(sources.data ?? []).map((s) => (
            <li key={s.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{s.type === 'sentry' ? 'Sentry' : 'Generic'}</span>
                {s.actor && <span className="text-caption text-[var(--text-tertiary)]">acts as {s.actor.displayName}</span>}
                <label className="ml-auto flex items-center gap-1.5 text-caption">
                  <input type="checkbox" role="switch" checked={s.enabled} onChange={(e) => save.mutate({ id: s.id, name: s.name, enabled: e.target.checked }, { onError: fail })} />
                  Enabled
                </label>
              </div>
              <CopyText label="URL" value={s.url} />
              <div className="flex flex-wrap gap-1">
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption" onClick={() => setTesting(s)}><FlaskConical className="w-3.5 h-3.5" aria-hidden="true" /> Test</button>
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption" onClick={() => setLogging(s)}><ListChecks className="w-3.5 h-3.5" aria-hidden="true" /> Deliveries</button>
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption" onClick={() => setEditing(s)}><Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Edit</button>
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption" onClick={async () => { if ((await confirmDialog(`Replace the secret of ${s.name}? The old one stops working immediately.`))) { try { const r = await rotate.mutateAsync(s.id); setReveal({ source: r, secret: r.secret }) } catch (e) { fail(e) } } }}><KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> New secret</button>
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption !text-[var(--error)]" onClick={async () => { if ((await confirmDialog(`Delete ${s.name}? Its URL stops working and its delivery log is removed.`))) { try { await remove.mutateAsync(s.id) } catch (e) { fail(e) } } }}><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Delete</button>
              </div>
            </li>
          ))}
          {sources.data?.length === 0 && <li className="p-3 text-body-sm text-[var(--text-tertiary)]">No inbound sources yet.</li>}
        </ul>
      )}
      {editing && (
        <Modal isOpen onClose={() => setEditing(null)} title={editing === 'new' ? 'Add inbound source' : `Edit ${editing.name}`} size="lg">
          <SourceForm project={projectKey} source={editing === 'new' ? null : editing} onDone={(created) => { setEditing(null); if (created) setReveal(created) }} />
        </Modal>
      )}
      {testing && <TestDialog project={projectKey} source={testing} onClose={() => setTesting(null)} />}
      {logging && <LogDialog project={projectKey} source={logging} onClose={() => setLogging(null)} />}
    </div>
  )
}
