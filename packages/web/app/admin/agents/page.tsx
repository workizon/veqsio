'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Plus, Trash2, Power, KeyRound, Copy, Check, Square } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { AgentBadge } from '@/components/agent-badge'
import { ACTIVE_RUN, TRIGGER_LABELS, agentApi, type AgentInfo, type AgentRun } from '@/hooks/use-agents'
import { confirmDialog } from '@/components/dialogs'

const BASE = '/rest/api/2/admin/agents'
const SLUG = /^[a-z0-9][a-z0-9_-]{1,63}$/

function Secret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2" role="status">
      <div className="text-body-sm font-medium">{label}</div>
      <div className="flex gap-2 items-center">
        <code className="font-mono text-xs break-all flex-1">{value}</code>
        <button className="veqsio-btn-ghost p-1" aria-label="Copy" onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-caption text-[var(--text-secondary)]">Shown once. Store it now; it cannot be shown again, only rotated.</p>
    </div>
  )
}

export default function AgentsAdminPage() {
  const qc = useQueryClient()
  const agents = useQuery({ queryKey: ['admin-agents'], queryFn: () => agentApi<AgentInfo[]>(BASE) })
  const runs = useQuery({ queryKey: ['admin-agent-runs'], queryFn: () => agentApi<AgentRun[]>(`${BASE}/runs?limit=30`), refetchInterval: 10_000 })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-agents'] }); qc.invalidateQueries({ queryKey: ['admin-agent-runs'] }) }
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Request failed', 'error')

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ slug: '', displayName: '', description: '', webhookUrl: '', triggers: ['assigned', 'mentioned'] as string[] })
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [tokenFor, setTokenFor] = useState<AgentInfo | null>(null)
  const [tokenName, setTokenName] = useState('Agent token')
  const [tokenWrite, setTokenWrite] = useState(true)

  const create = useMutation({
    mutationFn: () => agentApi<AgentInfo>(BASE, 'POST', {
      slug: form.slug, displayName: form.displayName, description: form.description || null,
      webhookUrl: form.webhookUrl || null, triggers: form.triggers,
    }),
    onSuccess: (a) => { setCreateOpen(false); setSecret({ label: `Signing secret for ${a.displayName}`, value: a.signingSecret! }); setForm({ slug: '', displayName: '', description: '', webhookUrl: '', triggers: ['assigned', 'mentioned'] }); refresh() },
    onError: fail,
  })
  const toggle = useMutation({ mutationFn: (a: AgentInfo) => agentApi(`${BASE}/${a.id}/${a.enabled ? 'disable' : 'enable'}`, 'POST'), onSuccess: refresh, onError: fail })
  const remove = useMutation({ mutationFn: (a: AgentInfo) => agentApi(`${BASE}/${a.id}`, 'DELETE'), onSuccess: refresh, onError: fail })
  const rotate = useMutation({
    mutationFn: (a: AgentInfo) => agentApi<{ signingSecret: string }>(`${BASE}/${a.id}/signing-secret`, 'POST'),
    onSuccess: (r, a) => setSecret({ label: `New signing secret for ${a.displayName}`, value: r.signingSecret }), onError: fail,
  })
  const mint = useMutation({
    mutationFn: (a: AgentInfo) => agentApi<{ token: string }>(`${BASE}/${a.id}/tokens`, 'POST', { name: tokenName, scopes: tokenWrite ? ['read:issues', 'write:issues'] : ['read:issues'] }),
    onSuccess: (r, a) => { setTokenFor(null); setSecret({ label: `API token for ${a.displayName}`, value: r.token }) }, onError: fail,
  })
  const stop = useMutation({ mutationFn: (id: number) => agentApi(`/rest/api/2/agent-runs/${id}/stop`, 'POST'), onSuccess: refresh, onError: fail })

  const toggleTrigger = (t: string) => setForm((f) => ({ ...f, triggers: f.triggers.includes(t) ? f.triggers.filter((x) => x !== t) : [...f.triggers, t] }))
  const valid = SLUG.test(form.slug) && form.displayName.trim().length > 0

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-heading-1 flex items-center gap-2"><Bot className="w-6 h-6" aria-hidden="true" />AI agents</h1>
            <p className="text-body-sm text-[var(--text-secondary)] mt-1">
              Agents are service accounts that can be assigned and mentioned. They see only the projects where you add them to a role or group
              (Project settings, Roles). Issue text is untrusted input for an agent.
            </p>
          </div>
          <button type="button" className="veqsio-btn-primary" onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" />New agent</button>
        </div>

        {secret && <Secret label={secret.label} value={secret.value} />}

        {agents.isLoading && <Spinner />}
        {agents.error && <p role="alert" className="text-sm text-[var(--error)]">{(agents.error as Error).message}</p>}
        {agents.data && agents.data.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No agents yet.</p>}
        <ul className="space-y-3">
          {agents.data?.map((a) => (
            <li key={a.id} className="veqsio-card p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{a.displayName}</strong><AgentBadge />
                <code className="text-xs text-[var(--text-tertiary)]">@{a.username}</code>
                <span className={`text-xs ${a.enabled ? 'text-[var(--success)]' : 'text-[var(--text-tertiary)]'}`}>{a.enabled ? 'enabled' : 'disabled'}</span>
                <div className="ml-auto flex gap-1">
                  <button className="veqsio-btn-ghost p-2" aria-label={`Create API token for ${a.displayName}`} title="Create API token" onClick={() => setTokenFor(a)}><KeyRound className="w-4 h-4" /></button>
                  <button className="veqsio-btn-ghost p-2" aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.displayName}`} title={a.enabled ? 'Disable' : 'Enable'} onClick={() => toggle.mutate(a)}><Power className="w-4 h-4" /></button>
                  <button className="veqsio-btn-ghost p-2" aria-label={`Delete ${a.displayName}`} title="Delete" onClick={async () => { if ((await confirmDialog(`Delete agent ${a.displayName}? Its tokens stop working and its run log is deleted.`))) remove.mutate(a) }}><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
              {a.description && <p className="text-sm text-[var(--text-secondary)]">{a.description}</p>}
              <p className="text-xs text-[var(--text-tertiary)]">
                Owner: {a.owner?.displayName ?? 'none'} · Webhook: {a.webhookUrl ?? 'none (the agent pulls queued runs)'} · Triggers: {a.triggers.map((t) => TRIGGER_LABELS[t] ?? t).join(', ') || 'none'}
              </p>
              <p className="text-xs text-[var(--text-tertiary)]">
                Limits: {a.limits.maxConcurrentRuns} concurrent, {a.limits.maxRunsPerIssue} per issue, {a.limits.maxRunsPerHour} per hour
                {a.consecutiveFailures > 0 && <> · <span className="text-[var(--error)]">{a.consecutiveFailures} failed deliveries in a row</span></>}
                {' · '}<button type="button" className="underline" onClick={() => rotate.mutate(a)}>Rotate signing secret</button>
              </p>
            </li>
          ))}
        </ul>

        <section aria-labelledby="runs-heading" className="space-y-2">
          <h2 id="runs-heading" className="text-heading-3">Recent runs</h2>
          {runs.data && runs.data.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No runs yet.</p>}
          {runs.data && runs.data.length > 0 && (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[var(--text-tertiary)]"><th className="py-1">Agent</th><th>Issue</th><th>Trigger</th><th>Status</th><th>When</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--surface-3)]">
                    <td className="py-1.5">{r.agent?.displayName}</td>
                    <td><a className="text-[var(--brand-500)] hover:underline" href={`/issues/${r.issueKey}`}>{r.issueKey}</a></td>
                    <td>{TRIGGER_LABELS[r.trigger] ?? r.trigger}</td>
                    <td title={r.error ?? undefined}>{r.status}{r.error ? ' *' : ''}</td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>{ACTIVE_RUN.includes(r.status) && <button className="veqsio-btn-ghost p-1" aria-label={`Stop run ${r.id}`} onClick={() => stop.mutate(r.id)}><Square className="w-4 h-4" /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="New AI agent">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate() }}>
          <label className="block text-sm">Name (user name becomes agent:&lt;id&gt;)
            <input className="veqsio-input w-full mt-1" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label className="block text-sm">Id (lower-case letters, digits, - and _)
            <input className="veqsio-input w-full mt-1" required pattern="[a-z0-9][a-z0-9_-]{1,63}" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          </label>
          <label className="block text-sm">Description
            <input className="veqsio-input w-full mt-1" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="block text-sm">Webhook URL (https; leave empty if the agent polls for work)
            <input className="veqsio-input w-full mt-1" type="url" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} />
          </label>
          <fieldset className="text-sm space-y-1">
            <legend className="font-medium">Triggers</legend>
            {Object.keys(TRIGGER_LABELS).filter((t) => t !== 'claim').map((t) => (
              <label key={t} className="flex items-center gap-2"><input type="checkbox" checked={form.triggers.includes(t)} onChange={() => toggleTrigger(t)} />{TRIGGER_LABELS[t]}</label>
            ))}
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" className="veqsio-btn-secondary" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button type="submit" className="veqsio-btn-primary" disabled={!valid || create.isPending}>Create agent</button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!tokenFor} onClose={() => setTokenFor(null)} title={`API token for ${tokenFor?.displayName ?? ''}`}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (tokenFor) mint.mutate(tokenFor) }}>
          <label className="block text-sm">Name
            <input className="veqsio-input w-full mt-1" required value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={tokenWrite} onChange={(e) => setTokenWrite(e.target.checked)} />Allow changes (write:issues). Otherwise read-only.</label>
          <div className="flex justify-end gap-2">
            <button type="button" className="veqsio-btn-secondary" onClick={() => setTokenFor(null)}>Cancel</button>
            <button type="submit" className="veqsio-btn-primary" disabled={mint.isPending}>Create token</button>
          </div>
        </form>
      </Modal>
    </AppLayout>
  )
}
