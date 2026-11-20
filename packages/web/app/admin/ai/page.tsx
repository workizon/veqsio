'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { aiJson } from '@/components/ai/use-ai'

interface AdminAi {
  enabled: boolean
  provider: 'openai' | 'anthropic'
  baseUrl: string | null
  model: string | null
  hasKey: boolean
  maxInputChars: number
  dailyRequestLimitPerUser: number
  features: { classify: boolean; summarize: boolean; similar: boolean; release_notes: boolean; review: boolean; rule_draft: boolean }
  usage?: { total: number; byFeature: Record<string, number> }
}

const FEATURE_LABELS: Record<keyof AdminAi['features'], string> = {
  similar: 'Similar / duplicate issues (works without a model)',
  summarize: 'Summarize issue threads',
  classify: 'Suggest type, priority and labels',
  release_notes: 'Draft release notes',
  review: 'Draft post-incident reviews',
  rule_draft: 'Draft automation rules from a description',
}

export default function AdminAiPage() {
  const { tr } = useI18n();

  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'ai'],
    queryFn: () => aiJson<AdminAi>('GET', '/rest/api/2/admin/ai'),
    retry: false,
  })
  const [form, setForm] = useState<AdminAi | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => { if (data) setForm(data) }, [data])

  async function save() {
    if (!form) return
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        enabled: form.enabled, provider: form.provider, baseUrl: form.baseUrl?.trim() || null, model: form.model?.trim() || null,
        maxInputChars: Number(form.maxInputChars), dailyRequestLimitPerUser: Number(form.dailyRequestLimitPerUser), features: form.features,
      }
      if (removeKey) body.apiKey = null
      else if (apiKey.trim()) body.apiKey = apiKey.trim()
      const res = await fetch('/rest/api/2/admin/ai', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.errorMessages?.[0] ?? tr('Could not save'))
      setApiKey(''); setRemoveKey(false); setTestMsg(null)
      toast(tr('AI settings saved'), 'success')
      await qc.invalidateQueries({ queryKey: ['admin', 'ai'] })
      await qc.invalidateQueries({ queryKey: ['ai', 'features'] })
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally { setBusy(false) }
  }

  async function test() {
    setBusy(true); setTestMsg(null)
    try { setTestMsg(await aiJson('POST', '/rest/api/2/admin/ai/test')) }
    catch (e) { setTestMsg({ ok: false, message: (e as Error).message }) }
    finally { setBusy(false) }
  }

  const set = <K extends keyof AdminAi>(k: K, v: AdminAi[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const label = 'text-caption font-medium text-[var(--text-secondary)] block mb-1.5'

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center"><Sparkles className="w-5 h-5 text-[var(--brand-500)]" /></div>
          <PageHeader title={tr('AI assist')} description={tr('Optional. Off by default. Veqsio works fully without it.')} />
        </div>

        {isLoading && <Spinner />}
        {error && <p role="alert" className="text-[var(--error)]">{(error as Error).message}</p>}

        {form && (
          <form className="veqsio-card space-y-5" onSubmit={(e) => { e.preventDefault(); void save() }}>
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-body-sm">
              {tr('When enabled, issue text the requesting user may see (summary, description, comments, never internal notes unless the user is service-desk staff) is sent to the model endpoint you configure. Use a self-hosted model if that data must not leave your network.')}
            </div>

            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              <span className="text-body-sm font-medium">{tr('Enable AI assist (model-backed features)')}</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={label} htmlFor="ai-provider">{tr('Provider API')}</label>
                <select id="ai-provider" className="veqsio-input w-full" value={form.provider} onChange={(e) => set('provider', e.target.value as AdminAi['provider'])}>
                  <option value="openai">{tr('OpenAI-compatible (OpenAI, Ollama, vLLM, LM Studio, llama.cpp, gateways)')}</option>
                  <option value="anthropic">{tr('Anthropic Messages API')}</option>
                </select>
              </div>
              <div>
                <label className={label} htmlFor="ai-model">{tr('Model')}</label>
                <input id="ai-model" className="veqsio-input w-full" value={form.model ?? ''} onChange={(e) => set('model', e.target.value)} placeholder={tr('e.g. llama3.1:8b')} />
              </div>
            </div>

            <div>
              <label className={label} htmlFor="ai-url">{tr('Base URL')}</label>
              <input id="ai-url" className="veqsio-input w-full" value={form.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)}
                placeholder={form.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} autoComplete="off" />
              <p className="text-caption text-[var(--text-tertiary)] mt-1">
                {tr('Must be https and contain no credentials. Localhost and private-network hosts (for example http://ollama:11434/v1) are only accepted when the server runs with')} <code>AI_ALLOW_PRIVATE_HOSTS=true</code>.
              </p>
            </div>

            <div>
              <label className={label} htmlFor="ai-key">{tr('API key')}</label>
              <input id="ai-key" type="password" className="veqsio-input w-full" value={apiKey} autoComplete="new-password"
                onChange={(e) => setApiKey(e.target.value)} placeholder={form.hasKey ? tr('A key is stored. Leave empty to keep it.') : tr('Optional for local models')} />
              {form.hasKey && (
                <label className="flex items-center gap-2 mt-1 text-caption">
                  <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} /> {tr('Remove the stored key')} </label>
              )}
              <p className="text-caption text-[var(--text-tertiary)] mt-1">{tr('Stored encrypted (AES-256-GCM) and never shown again.')}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={label} htmlFor="ai-max">{tr('Max input characters per request')}</label>
                <input id="ai-max" type="number" min={500} max={200000} className="veqsio-input w-full" value={form.maxInputChars} onChange={(e) => set('maxInputChars', Number(e.target.value))} />
              </div>
              <div>
                <label className={label} htmlFor="ai-limit">{tr('Requests per user per day')}</label>
                <input id="ai-limit" type="number" min={1} max={10000} className="veqsio-input w-full" value={form.dailyRequestLimitPerUser} onChange={(e) => set('dailyRequestLimitPerUser', Number(e.target.value))} />
              </div>
            </div>

            <fieldset className="space-y-1">
              <legend className={label}>{tr('Features')}</legend>
              {(Object.keys(FEATURE_LABELS) as (keyof AdminAi['features'])[]).map((k) => (
                <label key={k} className="flex items-center gap-2 text-body-sm">
                  <input type="checkbox" checked={form.features[k]} onChange={(e) => set('features', { ...form.features, [k]: e.target.checked })} /> {tr(FEATURE_LABELS[k])}
                </label>
              ))}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className="veqsio-btn-primary" disabled={busy}>{tr('Save')}</button>
              <button type="button" className="veqsio-btn-secondary" onClick={test} disabled={busy || !data?.enabled}>{tr('Test connection')}</button>
              {testMsg && <span role="status" className={testMsg.ok ? 'text-green-700' : 'text-[var(--error)]'}>{testMsg.message}</span>}
            </div>
            {!data?.enabled && <p className="text-caption text-[var(--text-tertiary)]">{tr('Save with AI enabled first, then test the connection.')}</p>}

            {data?.usage && (
              <p className="text-caption text-[var(--text-tertiary)]">
                {tr('Last 7 days:')} {data.usage.total} {tr('requests')}
                {Object.entries(data.usage.byFeature).map(([k, n]) => ` · ${k}: ${n}`).join('')}{tr('. Only counts are recorded, never prompts or answers.')}
              </p>
            )}
          </form>
        )}
      </div>
    </AppLayout>
  )
}
