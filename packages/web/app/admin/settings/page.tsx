'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useAdminSettings, useSaveSettings, type SettingDef } from '@/hooks/use-instance-settings'

type Draft = Record<string, number | boolean | string | string[]>

function Field({ def, value, onChange }: { def: SettingDef; value: Draft[string]; onChange: (v: Draft[string]) => void }) {
  const { tr } = useI18n();

  const id = `setting-${def.key}`
  const input = 'veqsio-input mt-2 max-w-md'
  return (
    <div className="space-y-1">
      {def.type === 'bool' ? (
        <label htmlFor={id} className="flex items-center gap-2 text-body font-medium">
          <input id={id} type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} /> {tr(def.label)}
        </label>
      ) : (
        <label htmlFor={id} className="block text-body font-medium">{tr(def.label)}
          {def.type === 'int' && <input id={id} type="number" className={input} min={def.min} max={def.max} value={value as number} onChange={(e) => onChange(Number(e.target.value))} />}
          {def.type === 'text' && <textarea id={id} className={input} rows={2} maxLength={def.maxLength} value={value as string} onChange={(e) => onChange(e.target.value)} />}
          {def.type === 'enum' && <select id={id} className={input} value={value as string} onChange={(e) => onChange(e.target.value)}>{def.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select>}
          {def.type === 'list' && <input id={id} className={input} value={(value as string[]).join(', ')} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} placeholder={tr('exe, bat, js')} />}
        </label>
      )}
      <p className="text-body-sm text-[var(--text-secondary)]">{tr(def.description)}</p>
    </div>
  )
}

function ConfigAsCode() {
  const { tr } = useI18n();

  const [report, setReport] = useState<{ applied: boolean; changes: string[]; warnings: string[]; errors: string[] } | null>(null)
  const [doc, setDoc] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const run = async (body: unknown, dryRun: boolean) => {
    setBusy(true)
    try {
      const res = await fetch(`/rest/api/2/admin/config/import${dryRun ? '?dryRun=true' : ''}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setReport(await res.json())
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  const pick = async (file: File | undefined) => {
    if (!file) return
    try { const parsed = JSON.parse(await file.text()); setDoc(parsed); await run(parsed, true) } catch { toast(tr('That file is not valid JSON'), 'error'); setDoc(null) }
  }

  return (
    <section aria-labelledby="cfg-heading" className="space-y-4 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5">
      <h2 id="cfg-heading" className="text-heading-3">{tr('Configuration as code')}</h2>
      <p className="text-body-sm text-[var(--text-secondary)]">Export instance settings, switched-off features and, per project, features, public flag, components and versions as one JSON file; apply it to another instance (or this one). Importing never deletes anything, shows a preview first, and skips projects that do not exist.</p>
      <div className="flex flex-wrap items-center gap-3">
        <a className="veqsio-btn-secondary text-sm" href="/rest/api/2/admin/config/export" download="veqsio-config.json">{tr('Export configuration')}</a>
        <label className="text-body-sm">{tr('Import file')} <input type="file" accept="application/json,.json" onChange={(e) => void pick(e.target.files?.[0])} /></label>
      </div>
      {report && (
        <div role="status" className="space-y-1 text-body-sm">
          {report.errors.map((x) => <p key={x} className="text-[var(--error)]">{x}</p>)}
          {report.warnings.map((x) => <p key={x} className="text-[var(--warning)]">{x}</p>)}
          {report.errors.length === 0 && <p>{report.applied ? tr('Applied.') : report.changes.length ? tr('Preview: {n} change(s)', { n: report.changes.length }) : tr('Nothing to change.')}</p>}
          {!report.applied && <ul className="list-disc pl-5">{report.changes.slice(0, 50).map((x) => <li key={x}>{x}</li>)}</ul>}
          {!report.applied && report.errors.length === 0 && report.changes.length > 0 && (
            <button type="button" className="veqsio-btn-primary text-sm" disabled={busy} onClick={() => void run(doc, false)}>{tr('Apply these changes')}</button>
          )}
        </div>
      )}
    </section>
  )
}

export default function InstanceSettingsPage() {
  const { tr } = useI18n();

  const settings = useAdminSettings()
  const save = useSaveSettings()
  const [draft, setDraft] = useState<Draft>({})
  useEffect(() => { if (settings.data) setDraft(Object.fromEntries(settings.data.map((s) => [s.key, s.value]))) }, [settings.data])

  const groups = [...new Set((settings.data ?? []).map((s) => s.group))]
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await save.mutateAsync(draft); toast(tr('Settings saved'), 'success') } catch (err) { toast((err as Error).message, 'error') }
  }

  return (
    <AppLayout>
      <form onSubmit={submit} className="space-y-8">
        <PageHeader title={tr('Instance settings')} description={<>{tr('Security, attachments and the announcement banner. Changes apply within a few seconds. General settings such as the site name are under')} <a className="text-[var(--brand-500)] hover:underline" href="/admin/system">{tr('System')}</a>{tr('; features and modules under')} <a className="text-[var(--brand-500)] hover:underline" href="/admin/features">{tr('Features and modules')}</a>.</>} />
        {settings.isLoading ? <Spinner /> : groups.map((g) => (
          <section key={g} aria-labelledby={`g-${g}`} className="space-y-4 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5">
            <h2 id={`g-${g}`} className="text-heading-3">{tr(g)}</h2>
            {(settings.data ?? []).filter((s) => s.group === g).map((s) => <Field key={s.key} def={s} value={draft[s.key] ?? s.value} onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))} />)}
          </section>
        ))}
        <button type="submit" className="veqsio-btn-primary" disabled={save.isPending}>{tr('Save settings')}</button>
      </form>
      <div className="mt-8"><ConfigAsCode /></div>
    </AppLayout>
  )
}
