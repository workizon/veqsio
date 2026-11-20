'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AlertCircle, UserPlus, X } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { RequestFormFields } from '@/components/request-form'
import { RichTextEditor } from '@/components/rich-text-editor'
import { toast } from '@/components/toast'
import { useDesk } from '@/hooks/use-servicedesk-admin'
import { usePortal } from '@/hooks/use-servicedesk'
import { useCreateOnBehalf, useCustomerSearch } from '@/hooks/use-servicedesk-comms'
import { initialValues, submittableValues, validateValues } from '@/lib/request-form'
import { customerPayload, isNewCustomerEmail, type CustomerChoice } from '@/lib/servicedesk-comms'

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

/** Agent view: raise a request on behalf of a customer (existing one via autocomplete, or a new one by email). */
export default function NewRequestOnBehalfPage() {
  const { tr } = useI18n();

  const id = Number(useParams<{ id: string }>().id)
  const router = useRouter()
  const desk = useDesk(id)
  const portal = usePortal(desk.data?.slug ?? '')
  const create = useCreateOnBehalf(id)

  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState<CustomerChoice | null>(null)
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [typeId, setTypeId] = useState<number | ''>('')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const q = useDebounced(picked ? '' : typed.trim())
  const search = useCustomerSearch(id, q)
  const results = search.data?.values ?? []
  const creating = !picked && isNewCustomerEmail(typed, results)
  const type = portal.data?.requestTypes.find((t) => t.id === typeId)

  useEffect(() => { setActive(0) }, [q])

  const choose = (c: CustomerChoice) => { setPicked(c); setTyped(''); setOpen(false) }
  const chooseType = (v: string) => {
    const t = portal.data?.requestTypes.find((x) => x.id === Number(v))
    setTypeId(v ? Number(v) : ''); setValues(initialValues(t?.fields ?? [])); setErrors({}); setSummary(''); setDescription('')
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const problems: Record<string, string> = {}
    const who = customerPayload(picked, typed, name)
    if (!who.ok) problems._customer = who.error
    if (!type) problems._type = tr('Choose a request type')
    if (type) {
      Object.assign(problems, validateValues(type.fields, values, {}))
      if (!type.summaryField && !summary.trim()) problems._summary = tr('Summary is required')
    }
    setErrors(problems)
    if (Object.keys(problems).length || !who.ok || !type) {
      setTimeout(() => document.querySelector<HTMLElement>('form [aria-invalid="true"]')?.focus(), 0)
      return
    }
    create.mutate(
      {
        ...who.body, requestTypeId: type.id, summary: type.summaryField ? undefined : summary,
        description: type.descriptionField ? undefined : description || undefined, fieldValues: submittableValues(type.fields, values),
      },
      {
        onSuccess: (r) => { toast(`Request ${r.key} raised on behalf of the customer`, 'success'); router.push(`/issues/${r.key}`) },
      },
    )
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter' && open && results[active] && !picked) { e.preventDefault(); choose(results[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  const err = (k: string) => errors[k] && <p id={`${k}-err`} role="alert" className="flex items-center gap-1.5 text-caption text-[var(--error)]"><AlertCircle aria-hidden className="w-3.5 h-3.5" />{errors[k]}</p>
  const listOpen = open && !picked && q.length > 0 && results.length > 0

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader breadcrumb={[{ label: tr('Service desk'), href: '/servicedesk' }, { label: desk.data?.name ?? '…', href: `/servicedesk/${id}` }, { label: tr('Create request') }]} title={tr('Create request for a customer')} description={tr('The customer becomes the reporter and can follow the request in the portal. The activity log records that you raised it.')} />

        {(desk.isLoading || (desk.data && portal.isLoading)) && <Spinner />}
        {desk.isError && <p role="alert" className="text-[var(--error)]">{tr('You need to be an agent of this service desk.')}</p>}

        {desk.data && portal.data && (
          <form onSubmit={submit} noValidate aria-label={tr('Create request on behalf of a customer')} className="veqsio-card p-5 space-y-6">
            <p className="text-caption text-[var(--text-tertiary)]"><span aria-hidden className="text-[var(--error)]">*</span> {tr('Required field')}</p>

            <div className="space-y-1.5 max-w-xl">
              <label htmlFor="customer-input" className="block text-body-sm font-medium text-[var(--text-primary)]">
                {tr('Customer')} <span aria-hidden className="text-[var(--error)]">*</span><span className="sr-only"> {tr('(required)')}</span>
              </label>
              {picked ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] px-3 py-2">
                  <span><span className="font-medium">{picked.displayName || picked.email}</span> <span className="text-[var(--text-secondary)]">{picked.email}</span></span>
                  <button type="button" className="veqsio-btn-ghost !px-2" onClick={() => setPicked(null)} aria-label={tr('Change customer')}><X aria-hidden className="w-4 h-4" /></button>
                </div>
              ) : (
                <div className="relative">
                  <input
                    id="customer-input" role="combobox" aria-expanded={listOpen} aria-controls="customer-list" aria-autocomplete="list"
                    aria-invalid={errors._customer ? true : undefined} aria-describedby={errors._customer ? '_customer-err' : 'customer-hint'}
                    aria-activedescendant={listOpen ? `customer-opt-${active}` : undefined}
                    className="veqsio-input w-full" autoComplete="off" placeholder={tr('Search by name or email, or type a new email address')}
                    value={typed} onChange={(e) => { setTyped(e.target.value); setOpen(true); setErrors((p) => ({ ...p, _customer: '' })) }}
                    onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKey}
                  />
                  {listOpen && (
                    <ul id="customer-list" role="listbox" aria-label={tr('Matching customers')} className="absolute z-20 mt-1 w-full rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-md)] py-1">
                      {results.map((r, i) => (
                        <li key={r.id} id={`customer-opt-${i}`} role="option" aria-selected={i === active}
                          onMouseDown={(e) => { e.preventDefault(); choose(r) }} onMouseEnter={() => setActive(i)}
                          className={`px-3 py-2 cursor-pointer text-sm ${i === active ? 'bg-[var(--surface-2)]' : ''}`}>
                          <span className="font-medium">{r.displayName || r.email}</span> <span className="text-[var(--text-secondary)]">{r.email}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <p id="customer-hint" className="text-caption text-[var(--text-tertiary)]">{tr('Pick an existing customer, or enter an email address to create one.')}</p>
              {err('_customer')}
              {creating && (
                <div className="space-y-1.5 rounded-lg border border-[var(--brand-100)] bg-[var(--brand-50)] p-3">
                  <p className="flex items-center gap-2 text-body-sm font-medium text-[var(--text-primary)]"><UserPlus aria-hidden className="w-4 h-4 text-[var(--brand-600)]" />{tr('A new customer will be created for')} {typed.trim()}</p>
                  <label htmlFor="customer-name" className="block text-body-sm">{tr('Name (optional)')}</label>
                  <input id="customer-name" className="veqsio-input w-full" maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              )}
            </div>

            <div className="space-y-1.5 max-w-xl">
              <label htmlFor="rt-select" className="block text-body-sm font-medium text-[var(--text-primary)]">
                {tr('Request type')} <span aria-hidden className="text-[var(--error)]">*</span><span className="sr-only"> {tr('(required)')}</span>
              </label>
              <select id="rt-select" className="veqsio-input w-full" value={typeId} onChange={(e) => chooseType(e.target.value)}
                aria-invalid={errors._type ? true : undefined} aria-describedby={errors._type ? '_type-err' : undefined}>
                <option value="">{tr('Choose a request type')}</option>
                {portal.data.requestTypes.map((t) => <option key={t.id} value={t.id}>{t.groupName ? `${t.groupName}: ` : ''}{t.name}</option>)}
              </select>
              {err('_type')}
              {portal.data.requestTypes.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">{tr('This desk has no request types yet. Create one under Settings, Request types.')}</p>}
            </div>

            {type && (
              <div className="space-y-6 border-t border-[var(--surface-3)] pt-5 max-w-3xl">
                {(type.helpText || type.description) && <p className="text-body text-[var(--text-secondary)]">{type.helpText || type.description}</p>}
                {!type.summaryField && (
                  <div className="space-y-1.5">
                    <label htmlFor="req-summary" className="block text-body-sm font-medium text-[var(--text-primary)]">{tr('Summary')} <span aria-hidden className="text-[var(--error)]">*</span><span className="sr-only"> {tr('(required)')}</span></label>
                    <input id="req-summary" maxLength={500} className="veqsio-input w-full" value={summary}
                      aria-invalid={errors._summary ? true : undefined} aria-describedby={errors._summary ? '_summary-err' : undefined}
                      onChange={(e) => { setSummary(e.target.value); setErrors((p) => ({ ...p, _summary: '' })) }} />
                    {err('_summary')}
                  </div>
                )}
                <RequestFormFields
                  fields={type.fields} values={values} errors={errors} disabled={create.isPending}
                  onChange={(k, v) => { setValues((p) => ({ ...p, [k]: v })); if (errors[k]) setErrors((p) => ({ ...p, [k]: '' })) }}
                />
                {!type.descriptionField && (
                  <div className="space-y-1.5">
                    <label htmlFor="req-description" className="block text-body-sm font-medium text-[var(--text-primary)]">{tr('Description')}</label>
                    <RichTextEditor id="req-description" label={tr('Description')} rows={5} maxLength={20000} mentions={false} value={description} onChange={setDescription} />
                  </div>
                )}
                <p className="text-caption text-[var(--text-tertiary)]">{tr('Files can be attached from the request once it exists.')}</p>
              </div>
            )}

            {create.error && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--error)] px-3 py-2.5 text-body-sm text-[var(--error)]">
                <AlertCircle aria-hidden className="w-4 h-4 mt-0.5 shrink-0" />{create.error.message}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button type="submit" className="veqsio-btn-primary" disabled={create.isPending}>{create.isPending ? tr('Creating…') : tr('Create request')}</button>
              <button type="button" className="veqsio-btn-secondary" onClick={() => router.push(`/servicedesk/${id}`)} disabled={create.isPending}>{tr('Cancel')}</button>
            </div>
          </form>
        )}
      </div>
    </AppLayout>
  )
}
