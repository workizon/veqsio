'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Puzzle, Plus, Trash2, Copy, Check, KeyRound, ListChecks, Settings, RefreshCw, Power } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { confirmDialog } from '@/components/dialogs'

interface ConfigField { key: string; label: string; type: 'text' | 'secret' | 'select' | 'boolean' | 'number'; required: boolean; options?: string[] }
interface Plugin {
  id: number; key: string; name: string; version: string; description: string; vendor: { name: string; url: string }; baseUrl: string
  enabled: boolean; requestedScopes: string[]; grantedScopes: string[]; events: string[]; uiPanels: { location: string; title: string; path: string }[]
  config: ConfigField[]; hasToken: boolean; consecutiveFailures: number; disabledReason: string | null
}
interface SettingView { key: string; label: string; type: ConfigField['type']; required: boolean; options: string[] | null; hasValue: boolean; value: string | null }
interface Delivery { id: number; event: string; status: string; responseStatus: number | null; error: string | null; attempts: number; latencyMs: number; createdAt: string }
interface Diff { versionFrom: string; versionTo: string; scopes: { added: string[]; removed: string[] }; events: { added: string[]; removed: string[] }; baseUrlChanged: boolean; needsApproval: boolean }

const BASE = '/rest/api/2/admin/plugins'

async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    const details = Array.isArray(d.details) ? ` (${d.details.join('; ')})` : ''
    throw new Error((d.errorMessages?.[0] || d.error?.message || `HTTP ${res.status}`) + details)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

function CopyBox({ label, value, hint }: { label: string; value: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
      <div className="text-body-sm font-medium">{label}</div>
      <div className="flex gap-2 items-center">
        <code className="font-mono text-xs break-all flex-1">{value}</code>
        <button className="veqsio-btn-ghost p-1" onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }} aria-label="Copy">
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-caption text-[var(--text-secondary)]">{hint}</p>
    </div>
  )
}

interface CatalogEntry { key: string; name: string; description?: string; version?: string; author?: string; homepage?: string; manifestUrl: string }
interface CatalogView { url: string; entries: CatalogEntry[]; skipped: number; installed: string[] }

/** Curated catalog: an administrator-chosen JSON list of manifest URLs. Installing from it is the normal install (not enabled, scopes approved later). */
function Marketplace({ open, onClose, onInstalled }: { open: boolean; onClose: () => void; onInstalled: (r: Plugin & { signingSecret: string }) => void }) {
  const qc = useQueryClient()
  const cat = useQuery({ queryKey: ['plugin-catalog'], enabled: open, retry: false, queryFn: () => api<CatalogView>(`${BASE}/catalog`) })
  const [url, setUrl] = useState<string | null>(null)
  const shown = url ?? cat.data?.url ?? ''
  const saveUrl = useMutation({
    mutationFn: () => api(`${BASE}/catalog`, 'PUT', { url: shown.trim() }),
    onSuccess: () => { setUrl(null); qc.invalidateQueries({ queryKey: ['plugin-catalog'] }) },
    onError: (e: unknown) => toast(e instanceof Error ? e.message : 'Request failed', 'error'),
  })
  const install = useMutation({
    mutationFn: (e: CatalogEntry) => api<Plugin & { signingSecret: string }>(BASE, 'POST', { url: e.manifestUrl }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['plugin-catalog'] }); qc.invalidateQueries({ queryKey: ['admin-plugins'] }); onClose(); onInstalled(r) },
    onError: (e: unknown) => toast(e instanceof Error ? e.message : 'Request failed', 'error'),
  })
  return (
    <Modal isOpen={open} onClose={onClose} title="Plugin marketplace" size="lg">
      <div className="space-y-3">
        <p className="text-caption text-[var(--text-secondary)]">Point Veqsio at a catalog: a JSON file with a <code>plugins</code> list of manifest URLs, from your company or a vendor you trust. Nothing is installed or enabled until you choose it.</p>
        <div className="flex gap-2">
          <input className="veqsio-input flex-1" aria-label="Catalog URL" placeholder="https://plugins.example.com/catalog.json" value={shown} onChange={(e) => setUrl(e.target.value)} />
          <button className="veqsio-btn-secondary" disabled={saveUrl.isPending || url === null} onClick={() => saveUrl.mutate()}>Save</button>
        </div>
        {cat.isLoading && <Spinner />}
        {cat.error && <p role="alert" className="text-[var(--danger)] text-body-sm">{(cat.error as Error).message}</p>}
        {cat.data && !cat.data.url && <p className="text-body-sm text-[var(--text-secondary)]">No catalog configured.</p>}
        <ul className="divide-y divide-[var(--surface-3)] max-h-[50vh] overflow-y-auto">
          {(cat.data?.entries ?? []).map((e) => {
            const done = cat.data!.installed.includes(e.key)
            return (
              <li key={e.key} className="py-2 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{e.name}{e.version ? <span className="text-[var(--text-tertiary)] font-normal"> v{e.version}</span> : null}</p>
                  {e.description && <p className="text-body-sm text-[var(--text-secondary)]">{e.description}</p>}
                  <p className="text-caption text-[var(--text-tertiary)] truncate">{e.author ? `${e.author} · ` : ''}{e.key}{e.homepage ? <> · <a href={e.homepage} target="_blank" rel="noopener noreferrer">website</a></> : null}</p>
                </div>
                {done ? <span className="text-body-sm text-[var(--text-secondary)]">Installed</span> : <button className="veqsio-btn-primary" disabled={install.isPending} onClick={() => install.mutate(e)}>Install</button>}
              </li>
            )
          })}
        </ul>
        {!!cat.data?.skipped && <p className="text-caption text-[var(--text-tertiary)]">{cat.data.skipped} entr{cat.data.skipped === 1 ? 'y' : 'ies'} in the catalog were skipped (invalid, duplicate or not https).</p>}
      </div>
    </Modal>
  )
}

export default function PluginsAdminPage() {
  const qc = useQueryClient()
  const { data: plugins, isLoading, error } = useQuery({ queryKey: ['admin-plugins'], queryFn: () => api<Plugin[]>(BASE) })
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-plugins'] })
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Request failed', 'error')

  const [installOpen, setInstallOpen] = useState(false)
  const [marketOpen, setMarketOpen] = useState(false)
  const [mode, setMode] = useState<'url' | 'json'>('url')
  const [source, setSource] = useState('')
  const [secrets, setSecrets] = useState<{ label: string; value: string; hint: string }[] | null>(null)
  const [enabling, setEnabling] = useState<Plugin | null>(null)
  const [approved, setApproved] = useState<string[]>([])
  const [settingsFor, setSettingsFor] = useState<Plugin | null>(null)
  const [logFor, setLogFor] = useState<Plugin | null>(null)
  const [updateFor, setUpdateFor] = useState<Plugin | null>(null)

  const install = useMutation({
    mutationFn: () => {
      let body: unknown
      if (mode === 'url') body = { url: source.trim() }
      else {
        try { body = { manifest: JSON.parse(source) } } catch { throw new Error('The manifest is not valid JSON') }
      }
      return api<Plugin & { signingSecret: string }>(BASE, 'POST', body)
    },
    onSuccess: (r) => {
      setInstallOpen(false); setSource('')
      setSecrets([{ label: 'Signing secret', value: r.signingSecret, hint: 'Give this to the plugin to verify X-Veqsio-Signature. It is shown only once; you can rotate it later.' }])
      refresh()
    },
    onError: fail,
  })

  const enable = useMutation({
    mutationFn: (p: Plugin) => api<Plugin & { token: string | null }>(`${BASE}/${p.id}/enable`, 'POST', p.requestedScopes.length ? { grantScopes: approved } : {}),
    onSuccess: (r) => {
      setEnabling(null)
      if (r.token) setSecrets([{ label: 'Plugin API token', value: r.token, hint: 'Shown only once. The plugin authenticates as its service user "plugin:' + r.key + '"; add that user to groups/roles to give it project access.' }])
      toast('Plugin enabled', 'success'); refresh()
    },
    onError: fail,
  })
  const disable = useMutation({ mutationFn: (p: Plugin) => api(`${BASE}/${p.id}/disable`, 'POST'), onSuccess: () => { toast('Plugin disabled', 'success'); refresh() }, onError: fail })
  const uninstall = useMutation({ mutationFn: (p: Plugin) => api(`${BASE}/${p.id}`, 'DELETE'), onSuccess: () => { toast('Plugin uninstalled', 'success'); refresh() }, onError: fail })
  const rotate = useMutation({
    mutationFn: (p: Plugin) => api<{ token: string }>(`${BASE}/${p.id}/token`, 'POST'),
    onSuccess: (r) => { setSecrets([{ label: 'New plugin API token', value: r.token, hint: 'The previous token stopped working immediately. Shown only once.' }]); refresh() },
    onError: fail,
  })
  const rotateSecret = useMutation({
    mutationFn: (p: Plugin) => api<{ signingSecret: string }>(`${BASE}/${p.id}/signing-secret`, 'POST'),
    onSuccess: (r) => setSecrets([{ label: 'New signing secret', value: r.signingSecret, hint: 'Update the plugin now; deliveries are signed with this secret from the next event on. Shown only once.' }]),
    onError: fail,
  })

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center"><Puzzle className="w-5 h-5 text-[var(--brand-500)]" /></div>
            <PageHeader title="Plugins" description="Plugins are external services. Veqsio sends them signed events and they call the API with a scoped token; nothing runs inside Veqsio." />
          </div>
          <div className="flex gap-2">
            <button className="veqsio-btn-secondary" onClick={() => setMarketOpen(true)}>Marketplace</button>
            <button className="veqsio-btn-primary flex items-center gap-1" onClick={() => setInstallOpen(true)}><Plus className="w-4 h-4" /> Install plugin</button>
          </div>
        </div>

        {secrets?.map((s) => <CopyBox key={s.label} {...s} />)}
        {secrets && <button className="veqsio-btn-ghost text-body-sm" onClick={() => setSecrets(null)}>I have saved it, hide</button>}

        {isLoading && <Spinner />}
        {error && <p className="text-[var(--danger)]">{(error as Error).message}</p>}
        {plugins?.length === 0 && <p className="text-[var(--text-secondary)]">No plugins installed.</p>}

        <div className="space-y-3">
          {plugins?.map((p) => (
            <div key={p.id} className="veqsio-card space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold">{p.name} <span className="text-caption text-[var(--text-tertiary)]">v{p.version}</span>{' '}
                    <span className={`text-xs px-2 py-0.5 rounded ${p.enabled ? 'bg-green-100 text-green-800' : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'}`}>{p.enabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="text-caption text-[var(--text-tertiary)]">{p.key} · by <a href={p.vendor.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{p.vendor.name}</a> · {p.baseUrl}</div>
                  {p.description && <p className="text-body-sm mt-1">{p.description}</p>}
                </div>
                <div className="flex flex-wrap gap-1 justify-end">
                  {p.enabled
                    ? <button className="veqsio-btn-secondary flex items-center gap-1" onClick={() => disable.mutate(p)}><Power className="w-4 h-4" /> Disable</button>
                    : <button className="veqsio-btn-primary flex items-center gap-1" onClick={() => { setApproved([]); setEnabling(p) }}><Power className="w-4 h-4" /> Enable</button>}
                  <button className="veqsio-btn-secondary flex items-center gap-1" onClick={() => setSettingsFor(p)} disabled={p.config.length === 0}><Settings className="w-4 h-4" /> Settings</button>
                  <button className="veqsio-btn-secondary flex items-center gap-1" onClick={() => setLogFor(p)}><ListChecks className="w-4 h-4" /> Deliveries</button>
                  <button className="veqsio-btn-secondary flex items-center gap-1" onClick={() => setUpdateFor(p)}><RefreshCw className="w-4 h-4" /> Update</button>
                  <button className="veqsio-btn-secondary flex items-center gap-1" onClick={async () => { if ((await confirmDialog('Rotate the API token? The current token stops working immediately.'))) rotate.mutate(p) }}><KeyRound className="w-4 h-4" /> Rotate token</button>
                  <button className="veqsio-btn-secondary" onClick={async () => { if ((await confirmDialog('Rotate the signing secret? The plugin must be updated with the new one.'))) rotateSecret.mutate(p) }}>Rotate signing secret</button>
                  <button className="veqsio-btn-ghost text-[var(--danger)]" aria-label="Uninstall" onClick={async () => { if ((await confirmDialog(`Uninstall ${p.name}? Its token stops working and its settings are deleted.`))) uninstall.mutate(p) }}><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
              <div className="text-caption text-[var(--text-secondary)] space-y-1">
                <div>Granted scopes: {p.grantedScopes.length ? p.grantedScopes.join(', ') : 'none'} (requested: {p.requestedScopes.join(', ') || 'none'})</div>
                <div>Events: {p.events.join(', ') || 'none'}</div>
                {p.disabledReason && <div className="text-amber-700">Disabled: {p.disabledReason}</div>}
                {p.consecutiveFailures > 0 && <div className="text-amber-700">{p.consecutiveFailures} consecutive failed deliveries</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Marketplace open={marketOpen} onClose={() => setMarketOpen(false)} onInstalled={(r) => setSecrets([{ label: 'Signing secret', value: r.signingSecret, hint: 'Give this to the plugin to verify X-Veqsio-Signature. It is shown only once; you can rotate it later.' }])} />

      <Modal isOpen={installOpen} onClose={() => setInstallOpen(false)} title="Install plugin" size="lg">
        <div className="space-y-3">
          <div className="flex gap-2">
            <button className={mode === 'url' ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} onClick={() => setMode('url')}>From URL</button>
            <button className={mode === 'json' ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'} onClick={() => setMode('json')}>Paste JSON</button>
          </div>
          {mode === 'url'
            ? <input className="veqsio-input w-full" placeholder="https://plugin.example.com/veqsio-manifest.json" value={source} onChange={(e) => setSource(e.target.value)} />
            : <textarea className="veqsio-input w-full font-mono text-xs" rows={12} placeholder='{ "schemaVersion": 1, "key": "com.acme.foo", ... }' value={source} onChange={(e) => setSource(e.target.value)} />}
          <p className="text-caption text-[var(--text-secondary)]">Installing does not enable the plugin. You approve its scopes when you enable it.</p>
          <div className="flex justify-end gap-2">
            <button className="veqsio-btn-secondary" onClick={() => setInstallOpen(false)}>Cancel</button>
            <button className="veqsio-btn-primary" disabled={!source.trim() || install.isPending} onClick={() => install.mutate()}>Install</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!enabling} onClose={() => setEnabling(null)} title={`Enable ${enabling?.name ?? ''}`} size="lg">
        {enabling && (
          <div className="space-y-3">
            {enabling.requestedScopes.length === 0 ? (
              <p className="text-body-sm">This plugin requests no API scopes.</p>
            ) : (
              <>
                <p className="text-body-sm">Choose the scopes to grant. The plugin can never do more than these scopes allow, and no more than its service user is permitted in each project.</p>
                {enabling.requestedScopes.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-body-sm">
                    <input type="checkbox" checked={approved.includes(s)} onChange={(e) => setApproved(e.target.checked ? [...approved, s] : approved.filter((x) => x !== s))} />
                    <code className="font-mono">{s}</code>
                  </label>
                ))}
              </>
            )}
            <div className="text-caption text-[var(--text-secondary)]">Events sent to {enabling.baseUrl}: {enabling.events.join(', ') || 'none'}</div>
            <div className="flex justify-end gap-2">
              <button className="veqsio-btn-secondary" onClick={() => setEnabling(null)}>Cancel</button>
              <button className="veqsio-btn-primary" disabled={enable.isPending} onClick={() => enable.mutate(enabling)}>Approve and enable</button>
            </div>
          </div>
        )}
      </Modal>

      {settingsFor && <SettingsModal plugin={settingsFor} onClose={() => setSettingsFor(null)} />}
      {logFor && <DeliveriesModal plugin={logFor} onClose={() => setLogFor(null)} />}
      {updateFor && <UpdateModal plugin={updateFor} onClose={() => setUpdateFor(null)} onDone={refresh} />}
    </AppLayout>
  )
}

function SettingsModal({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['admin-plugin-settings', plugin.id], queryFn: () => api<SettingView[]>(`${BASE}/${plugin.id}/settings`) })
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  const save = useMutation({
    mutationFn: () => {
      const values: Record<string, string | number | boolean | null> = {}
      for (const f of data ?? []) {
        if (!(f.key in draft)) continue
        const v = draft[f.key]
        values[f.key] = f.type === 'number' ? (v === '' ? null : Number(v)) : v === '' ? null : v
      }
      return api(`${BASE}/${plugin.id}/settings`, 'PUT', { values })
    },
    onSuccess: () => { toast('Settings saved', 'success'); onClose() },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  return (
    <Modal isOpen onClose={onClose} title={`${plugin.name} settings`} size="lg">
      {isLoading ? <Spinner /> : (
        <div className="space-y-3">
          {data?.map((f) => (
            <label key={f.key} className="block text-body-sm space-y-1">
              <span>{f.label}{f.required && ' *'}</span>
              {f.type === 'boolean' ? (
                <input type="checkbox" defaultChecked={f.value === 'true'} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })} />
              ) : f.type === 'select' ? (
                <select className="veqsio-input w-full" defaultValue={f.value ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
                  <option value="">(not set)</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  className="veqsio-input w-full" type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  autoComplete="off" defaultValue={f.type === 'secret' ? '' : f.value ?? ''}
                  placeholder={f.type === 'secret' && f.hasValue ? 'Saved. Type to replace.' : ''}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <button className="veqsio-btn-secondary" onClick={onClose}>Cancel</button>
            <button className="veqsio-btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function DeliveriesModal({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['admin-plugin-deliveries', plugin.id], queryFn: () => api<Delivery[]>(`${BASE}/${plugin.id}/deliveries?limit=100`), refetchInterval: 5000 })
  return (
    <Modal isOpen onClose={onClose} title={`${plugin.name} deliveries`} size="lg">
      {isLoading ? <Spinner /> : data?.length === 0 ? <p className="text-body-sm">No deliveries yet.</p> : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-caption">
            <thead><tr className="text-left text-[var(--text-tertiary)]"><th>Time</th><th>Event</th><th>Status</th><th>HTTP</th><th>Tries</th><th>ms</th><th>Error</th></tr></thead>
            <tbody>
              {data?.map((d) => (
                <tr key={d.id} className="border-t border-[var(--surface-3)]">
                  <td>{new Date(d.createdAt).toLocaleString()}</td><td>{d.event}</td>
                  <td className={d.status === 'success' ? 'text-green-700' : 'text-red-700'}>{d.status}</td>
                  <td>{d.responseStatus ?? '-'}</td><td>{d.attempts}</td><td>{d.latencyMs}</td><td className="max-w-[12rem] truncate" title={d.error ?? ''}>{d.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

function UpdateModal({ plugin, onClose, onDone }: { plugin: Plugin; onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState('')
  const [diff, setDiff] = useState<Diff | null>(null)
  const [approve, setApprove] = useState<string[]>([])
  const preview = useMutation({
    mutationFn: () => api<{ applied: boolean; diff: Diff }>(`${BASE}/${plugin.id}`, 'PUT', { url: url.trim() }),
    onSuccess: (r) => { setDiff(r.diff); setApprove([]) },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  const apply = useMutation({
    mutationFn: () => api(`${BASE}/${plugin.id}`, 'PUT', { url: url.trim(), confirm: true, approveScopes: approve }),
    onSuccess: () => { toast('Plugin updated', 'success'); onDone(); onClose() },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  return (
    <Modal isOpen onClose={onClose} title={`Update ${plugin.name}`} size="lg">
      <div className="space-y-3">
        <input className="veqsio-input w-full" placeholder="Manifest URL of the new version" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="veqsio-btn-secondary" disabled={!url.trim() || preview.isPending} onClick={() => preview.mutate()}>Review changes</button>
        {diff && (
          <div className="space-y-2 text-body-sm">
            <div>{diff.versionFrom} to {diff.versionTo}</div>
            {diff.baseUrlChanged && <div className="text-amber-700">The base URL changes: the plugin will be disabled until you enable it again.</div>}
            <div>Removed scopes (revoked): {diff.scopes.removed.join(', ') || 'none'}</div>
            <div>Events added: {diff.events.added.join(', ') || 'none'}; removed: {diff.events.removed.join(', ') || 'none'}</div>
            {diff.scopes.added.length > 0 && (
              <div>
                <div className="font-medium">New scopes requested (not granted unless you approve):</div>
                {diff.scopes.added.map((s) => (
                  <label key={s} className="flex items-center gap-2">
                    <input type="checkbox" checked={approve.includes(s)} onChange={(e) => setApprove(e.target.checked ? [...approve, s] : approve.filter((x) => x !== s))} />
                    <code className="font-mono">{s}</code>
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end"><button className="veqsio-btn-primary" disabled={apply.isPending} onClick={() => apply.mutate()}>Apply update</button></div>
          </div>
        )}
      </div>
    </Modal>
  )
}
