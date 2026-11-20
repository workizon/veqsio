'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { RequestFormFields } from '@/components/request-form'
import { RequestTypeIcon } from '@/components/request-type-icon'
import { FormCanvas } from '@/components/form-builder/canvas'
import { FieldProperties, Palette, TypeProperties, type TypeDraft } from '@/components/form-builder/properties'
import {
  useAdminRequestType, useDeskAdmin, useFormContext, usePortalSettings, useUpdateRequestType, type RequestTypeFull,
} from '@/hooks/use-servicedesk-admin'
import {
  checkForm, duplicateField, hasProblems, insertField, makeKey, moveField, newField, patchField, removeField, renameKey,
} from '@/lib/form-builder'
import { initialValues, validateValues, type FieldDef, type FieldType } from '@/lib/request-form'

type Tab = 'add' | 'field' | 'type'
type Mode = 'edit' | 'preview'

const toDraft = (rt: RequestTypeFull): TypeDraft => ({
  name: rt.name, description: rt.description ?? '', helpText: rt.helpText ?? '', icon: rt.icon ?? 'help-circle', groupName: rt.groupName ?? '',
  issueTypeId: rt.issueTypeId, defaultPriorityId: rt.defaultPriorityId ?? null, enabled: rt.enabled, visibility: rt.visibility,
  organizationIds: rt.organizationIds, sortOrder: rt.sortOrder,
})

/** Drop empty optional properties so stored JSON stays small and the strict server schema accepts it. */
function cleanField(f: FieldDef): FieldDef {
  const out: Record<string, unknown> = { key: f.key, label: f.label.trim(), type: f.type }
  if (f.required && !f.internal) out.required = true
  if (f.options && ['select', 'multiselect', 'checkboxes', 'radio'].includes(f.type)) out.options = f.options.map((o) => o.trim()).filter(Boolean)
  if (f.helpText?.trim()) out.helpText = f.helpText
  if (f.placeholder?.trim()) out.placeholder = f.placeholder
  if (f.internal) out.internal = true
  if (f.defaultValue !== undefined && f.defaultValue !== '') out.defaultValue = f.defaultValue
  if (f.validation && Object.keys(f.validation).length) out.validation = f.validation
  if (f.visibleWhen) out.visibleWhen = f.visibleWhen
  if (f.mapping) out.mapping = f.mapping
  return out as unknown as FieldDef
}

export default function RequestTypeBuilderPage() {
  const { tr } = useI18n();

  const params = useParams<{ id: string; rtId: string }>()
  const id = Number(params.id)
  const rtId = Number(params.rtId)
  const rt = useAdminRequestType(id, rtId)
  const { isAdmin } = useDeskAdmin(id)
  const ctx = useFormContext(isAdmin ? id : NaN)
  const portalSettings = usePortalSettings(id)
  const update = useUpdateRequestType(id)
  const readOnly = !isAdmin

  const [draft, setDraft] = useState<TypeDraft | null>(null)
  const [fields, setFields] = useState<FieldDef[]>([])
  const [baseline, setBaseline] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('add')
  const [mode, setMode] = useState<Mode>('edit')
  const [serverError, setServerError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')

  // Load once per server version; local edits are never overwritten by background refetches.
  useEffect(() => {
    if (!rt.data || baseline) return
    const d = toDraft(rt.data)
    setDraft(d); setFields(rt.data.fields)
    setBaseline(JSON.stringify({ d, f: rt.data.fields.map(cleanField) }))
    if (rt.data.fields.length) { setSelected(0); setTab('field') }
  }, [rt.data, baseline])

  const current = useMemo(() => JSON.stringify({ d: draft, f: fields.map(cleanField) }), [draft, fields])
  const dirty = !!draft && baseline !== '' && current !== baseline
  const problems = useMemo(() => checkForm(fields), [fields])

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  if (rt.isLoading || !draft) {
    return rt.error ? <div role="alert" className="text-[var(--error)]">{rt.error.message}</div> : <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  }

  /* ---- field operations (all pure helpers from lib/form-builder) ---- */
  const select = (i: number | null) => { setSelected(i); if (i !== null) setTab('field') }
  const add = (type: FieldType) => {
    const at = selected === null ? fields.length : selected + 1
    const f = newField(type, fields)
    setFields(insertField(fields, f, at)); setSelected(at); setTab('field')
    setAnnounce(`Added ${f.label} at position ${at + 1}`)
  }
  const move = (from: number, to: number) => {
    setFields(moveField(fields, from, to))
    if (selected === from) setSelected(Math.max(0, Math.min(to, fields.length - 1)))
    else if (selected !== null && from < selected && to >= selected) setSelected(selected - 1)
    else if (selected !== null && from > selected && to <= selected) setSelected(selected + 1)
    setAnnounce(`${fields[from]?.label} moved to position ${Math.max(0, Math.min(to, fields.length - 1)) + 1} of ${fields.length}`)
  }
  const remove = (i: number) => {
    const name = fields[i]?.label
    setFields(removeField(fields, i))
    setSelected(fields.length - 1 === 0 ? null : Math.min(i, fields.length - 2))
    setAnnounce(`Deleted ${name}`)
  }
  const duplicate = (i: number) => { setFields(duplicateField(fields, i)); setSelected(i + 1); setTab('field') }
  const relabel = (i: number, label: string) => {
    const old = fields[i]
    const others = fields.filter((_, j) => j !== i).map((f) => f.key)
    // The key follows the label until it was edited by hand.
    const auto = old.key === makeKey(old.label, others)
    let next = patchField(fields, i, { label })
    if (auto && label.trim()) next = renameKey(next, i, makeKey(label, others))
    setFields(next)
  }

  async function save() {
    setServerError(null)
    if (!draft) return
    if (hasProblems(problems)) {
      setServerError('Fix the highlighted problems before saving.')
      const first = [...problems.keys()].find((k) => k >= 0)
      if (first !== undefined) select(first)
      return
    }
    try {
      const saved = await update.mutateAsync({
        rtId,
        body: {
          name: draft.name.trim(), description: draft.description ?? '', helpText: draft.helpText ?? '', icon: draft.icon,
          groupName: draft.groupName?.trim() ? draft.groupName.trim() : null, issueTypeId: draft.issueTypeId,
          defaultPriorityId: draft.defaultPriorityId ?? null, enabled: draft.enabled, sortOrder: draft.sortOrder,
          visibility: draft.visibility, organizationIds: draft.visibility === 'all' ? [] : draft.organizationIds,
          fields: fields.map(cleanField),
        },
      })
      const d = toDraft(saved)
      setDraft(d); setFields(saved.fields)
      setBaseline(JSON.stringify({ d, f: saved.fields.map(cleanField) }))
      toast(tr('Request type saved'), 'success')
    } catch (e) {
      setServerError((e as Error).message)
    }
  }

  function discard() {
    if (!rt.data) return
    const d = toDraft(rt.data)
    setDraft(d); setFields(rt.data.fields); setBaseline(JSON.stringify({ d, f: rt.data.fields.map(cleanField) })); setServerError(null)
    setSelected(rt.data.fields.length ? 0 : null)
  }

  const groups = (portalSettings.data?.groups ?? []).map((g) => g.name)
  const tabs: Array<[Tab, string]> = [['add', 'Add field'], ['field', 'Field'], ['type', 'Request type']]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-10 h-10 rounded-lg bg-[var(--surface-2)] flex items-center justify-center text-[var(--brand-500)]"><RequestTypeIcon name={draft.icon} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-heading-2 text-[var(--text-primary)] truncate">{draft.name || 'Untitled request type'}</h2>
          <p className="text-xs text-[var(--text-tertiary)]">
            {readOnly ? 'Read-only: only desk administrators can change forms.' : dirty ? 'Unsaved changes' : 'All changes saved'}
            {(rt.data?.requestCount ?? 0) > 0 && ` · ${rt.data?.requestCount} existing requests keep their stored answers`}
          </p>
        </div>
        <div role="group" aria-label={tr('View')} className="flex gap-1">
          {(['edit', 'preview'] as Mode[]).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={mode === m ? 'veqsio-btn-primary' : 'veqsio-btn-secondary'}>{m === 'edit' ? 'Edit form' : 'Preview'}</button>
          ))}
        </div>
        {!readOnly && (
          <>
            <button type="button" className="veqsio-btn-secondary" onClick={discard} disabled={!dirty || update.isPending}>{tr('Discard')}</button>
            <button type="button" className="veqsio-btn-primary" onClick={save} disabled={!dirty || update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</button>
          </>
        )}
      </div>
      {serverError && <p role="alert" className="rounded-md bg-[var(--error)]/10 p-2 text-sm text-[var(--error)]">{serverError}</p>}
      {problems.get(-1)?.map((p) => <p key={p} role="alert" className="text-sm text-[var(--error)]">{p}</p>)}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* left: canvas or live preview */}
        <section aria-label={mode === 'edit' ? 'Form canvas' : 'Customer preview'} className="min-w-0">
          {mode === 'edit' ? (
            <div className="veqsio-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--text-secondary)]">{tr('Form fields')}</h3>
                <span className="text-xs text-[var(--text-tertiary)]">{fields.length} / 50</span>
              </div>
              <p className="text-xs text-[var(--text-tertiary)]">{tr('The summary and description inputs are added automatically unless a field is mapped to them.')}</p>
              <FormCanvas
                fields={fields} selected={selected} problems={problems} readOnly={readOnly}
                onSelect={select} onMove={move} onDuplicate={duplicate} onRemove={remove}
              />
            </div>
          ) : (
            <Preview draft={draft} fields={fields} />
          )}
        </section>

        {/* right: palette and properties */}
        <aside aria-label={tr('Field palette and properties')} className="veqsio-card p-4 h-fit space-y-3 xl:sticky xl:top-4">
          <div role="tablist" aria-label={tr('Builder panels')} className="flex gap-1 border-b border-[var(--surface-3)] -mx-1 px-1">
            {tabs.map(([t, label]) => (
              <button
                key={t} role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={`panel-${t}`}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm rounded-t-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-500)] ${tab === t ? 'font-medium text-[var(--text-primary)] border-b-2 border-[var(--brand-500)]' : 'text-[var(--text-secondary)]'}`}
              >{label}</button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="max-h-[calc(100vh-14rem)] overflow-y-auto pr-1">
            {tab === 'add' && <Palette onAdd={add} disabled={readOnly || fields.length >= 50} />}
            {tab === 'field' && (
              <FieldProperties
                fields={fields} index={selected ?? -1} ctx={ctx.data} readOnly={readOnly} problems={selected !== null ? problems.get(selected) : undefined}
                onChange={(patch) => selected !== null && setFields(patchField(fields, selected, patch))}
                onRelabel={(l) => selected !== null && relabel(selected, l)}
                onRekey={(k) => selected !== null && setFields(renameKey(fields, selected, k))}
              />
            )}
            {tab === 'type' && <TypeProperties draft={draft} ctx={ctx.data} groups={groups} readOnly={readOnly} onChange={(p) => setDraft({ ...draft, ...p })} />}
          </div>
        </aside>
      </div>
    </div>
  )
}

/** Live preview: the same component the portal renders, with the draft form. */
function Preview({ draft, fields }: { draft: TypeDraft; fields: FieldDef[] }) {
  const { tr } = useI18n();

  const [values, setValues] = useState<Record<string, unknown>>({})
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Defaults apply to whatever the customer has not touched yet.
  const effective = useMemo(() => ({ ...initialValues(fields), ...values }), [fields, values])
  const customer = fields.filter((f) => !f.internal)
  const summaryMapped = customer.some((f) => f.mapping?.target === 'summary')
  const descriptionMapped = customer.some((f) => f.mapping?.target === 'description')
  const internalCount = fields.length - customer.length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--text-secondary)]">{tr('This is how customers see the form in the portal. Try it: conditions and validation work.')}</p>
        <button type="button" className="veqsio-btn-ghost text-sm" onClick={() => { setValues({}); setFiles({}); setErrors({}) }}>{tr('Reset preview')}</button>
      </div>
      <form noValidate onSubmit={(e) => { e.preventDefault(); setErrors(validateValues(fields, effective, files)) }} className="veqsio-card p-5 space-y-4 bg-[var(--surface-0)]">
        <h3 className="text-heading-2">{draft.name || 'Untitled request type'}</h3>
        {draft.helpText && <p className="text-sm text-[var(--text-secondary)]">{draft.helpText}</p>}
        {!summaryMapped && (
          <div className="space-y-1">
            <label htmlFor="pv-summary" className="text-sm font-medium">{tr('Summary')} <span aria-hidden className="text-[var(--error)]">*</span></label>
            <input id="pv-summary" className="veqsio-input w-full" />
          </div>
        )}
        <RequestFormFields
          idPrefix="pv" fields={fields} values={effective} errors={errors} files={files}
          onChange={(k, v) => setValues((p) => ({ ...p, [k]: v }))} onFiles={(k, fs) => setFiles((p) => ({ ...p, [k]: fs }))}
        />
        {!descriptionMapped && (
          <div className="space-y-1">
            <label htmlFor="pv-desc" className="text-sm font-medium">{tr('Description')}</label>
            <textarea id="pv-desc" rows={4} className="veqsio-input w-full" />
          </div>
        )}
        <button type="submit" className="veqsio-btn-primary">{tr('Send request')}</button>
        <p className="text-xs text-[var(--text-tertiary)]">{tr('Preview only: nothing is sent. “Send request” runs the form checks.')}</p>
      </form>
      {internalCount > 0 && <p className="text-xs text-[var(--text-tertiary)]">{internalCount} {tr('internal field')}{internalCount === 1 ? ' is' : 's are'} {tr('hidden from customers and not shown here.')}</p>}
    </div>
  )
}
