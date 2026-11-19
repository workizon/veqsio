'use client'

import { PortalApprovals } from '@/components/approvals/portal-approvals'
import { RichTextEditor } from '@/components/rich-text-editor'
import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { PortalShell } from '@/components/portal-shell'
import { AlertCircle, ArrowLeft, ArrowRight, BookOpen, Search, X } from 'lucide-react'
import { Skeleton } from '@/components/skeleton'
import { EmptyState } from '@/components/empty-state'
import { RequestFormFields } from '@/components/request-form'
import { RequestTypeTile } from '@/components/request-type-icon'
import { toast } from '@/components/toast'
import { useCreatePortalRequest, usePortal, usePortalKb } from '@/hooks/use-servicedesk'
import { uploadPortalFile } from '@/hooks/use-servicedesk-admin'
import { initialValues, submittableValues, validateValues, visibleKeys } from '@/lib/request-form'

export default function PortalPage() {
  const { slug } = useParams<{ slug: string }>()
  const router = useRouter()
  const { data, isLoading, error } = usePortal(slug)
  const create = useCreatePortalRequest(slug)
  const [typeId, setTypeId] = useState<number | null>(null)
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [uploading, setUploading] = useState(false)
  const [q, setQ] = useState('')
  const kb = usePortalKb(slug, summary)
  const search = usePortalKb(slug, q)

  if (isLoading) {
    return (
      <PortalShell slug={slug} hero={<div className="border-b border-[var(--surface-3)] bg-[var(--surface-0)]"><div className="max-w-3xl mx-auto px-4 py-16 flex flex-col items-center gap-4"><Skeleton className="h-9 w-3/4" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-14 w-full max-w-xl rounded-xl mt-4" /></div></div>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading request types">
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      </PortalShell>
    )
  }
  if (error || !data) {
    return (
      <PortalShell slug={slug} width="narrow">
        <EmptyState icon="frown" title="This help center is not available" description="You may need to sign in or ask for access." action={<a href="/login" className="veqsio-btn-primary min-h-[44px] inline-flex items-center px-5">Sign in</a>} />
      </PortalShell>
    )
  }

  const type = data.requestTypes.find((t) => t.id === typeId)
  // Group order comes from the portal settings; request types keep their own order inside a group.
  const used = new Set(data.requestTypes.map((t) => t.groupName ?? 'General'))
  const ordered = (data.groups ?? []).filter((g) => used.has(g))
  const groups = [...ordered, ...[...used].filter((g) => !ordered.includes(g))]

  const choose = (id: number) => {
    const t = data.requestTypes.find((x) => x.id === id)
    setTypeId(id); setValues(initialValues(t?.fields ?? [])); setFiles({}); setErrors({}); setSummary(''); setDescription('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!type) return
    const problems = validateValues(type.fields, values, files)
    if (!type.summaryField && !summary.trim()) problems._summary = 'Summary is required'
    if (Object.keys(problems).length) {
      setErrors(problems)
      // Move focus to the first invalid control once the errors have rendered.
      setTimeout(() => document.querySelector<HTMLElement>('form [aria-invalid="true"]')?.focus(), 0)
      return
    }
    setErrors({})
    const visible = visibleKeys(type.fields, values)
    const attachments = type.fields.filter((f) => f.type === 'attachment' && visible.has(f.key)).flatMap((f) => files[f.key] ?? [])
    create.mutate(
      {
        requestTypeId: type.id, summary: type.summaryField ? undefined : summary,
        description: type.descriptionField ? undefined : description || undefined,
        fieldValues: submittableValues(type.fields, values),
      },
      {
        onSuccess: async (r) => {
          if (attachments.length) {
            setUploading(true)
            const failed: string[] = []
            for (const file of attachments) {
              try { await uploadPortalFile(slug, r.key, file) } catch (err) { failed.push((err as Error).message) }
            }
            setUploading(false)
            if (failed.length) toast(`Request sent, but some files could not be attached: ${failed.join('; ')}`, 'warning')
          }
          router.push(`/portal/${slug}/requests/${r.key}`)
        },
      },
    )
  }

  const busy = create.isPending || uploading
  const portalName = data.portalTitle || data.name
  const needle = q.trim().toLowerCase()
  const matches = (t: (typeof data.requestTypes)[number]) =>
    !needle || [t.name, t.description ?? '', t.groupName ?? ''].some((x) => x.toLowerCase().includes(needle))
  const shown = data.requestTypes.filter(matches)
  const articles = needle.length >= 3 ? search.data?.values ?? [] : []

  if (type) {
    return (
      <PortalShell slug={slug} title={data.name} width="narrow">
        <div className="space-y-6">
          <button type="button" onClick={() => setTypeId(null)} className="inline-flex items-center gap-1.5 min-h-[44px] -ml-2 px-2 rounded-md text-body font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-300)]">
            <ArrowLeft aria-hidden className="w-4 h-4" /> All request types
          </button>
          <div className="flex items-start gap-4">
            <RequestTypeTile name={type.icon} size="lg" />
            <div className="min-w-0">
              <h1 className="text-display text-[var(--text-primary)]">{type.name}</h1>
              {(type.helpText || type.description) && <p className="mt-1 text-body text-[var(--text-secondary)]">{type.helpText || type.description}</p>}
            </div>
          </div>

          <form onSubmit={submit} noValidate aria-label={`${type.name} request`} className="rounded-2xl border border-[var(--surface-3)] bg-[var(--surface-0)] shadow-[var(--shadow-sm)]">
            <div className="p-5 sm:p-7 space-y-6">
              <p className="text-caption text-[var(--text-tertiary)]"><span aria-hidden className="text-[var(--error)]">*</span> Required field</p>

              {!type.summaryField && (
                <div className="space-y-1.5">
                  <label htmlFor="req-summary" className="block text-body-sm font-medium text-[var(--text-primary)]">
                    Summary <span aria-hidden className="text-[var(--error)]">*</span><span className="sr-only"> (required)</span>
                  </label>
                  <input
                    id="req-summary" required maxLength={500} placeholder="Briefly describe what you need"
                    className={`veqsio-input w-full min-h-[44px] px-3 ${errors._summary ? 'border-[var(--error)] focus:border-[var(--error)]' : ''}`}
                    value={summary} onChange={(e) => { setSummary(e.target.value); if (errors._summary) setErrors((p) => ({ ...p, _summary: '' })) }}
                    aria-invalid={errors._summary ? true : undefined} aria-describedby={errors._summary ? 'req-summary-err' : undefined}
                  />
                  {errors._summary && <p id="req-summary-err" role="alert" className="flex items-center gap-1.5 text-caption text-[var(--error)]"><AlertCircle aria-hidden className="w-3.5 h-3.5" />{errors._summary}</p>}
                </div>
              )}

              {kb.data && kb.data.values.length > 0 && (
                <aside aria-label="Suggested articles" className="rounded-xl border border-[var(--brand-100)] bg-[var(--brand-50)] p-4 space-y-2">
                  <div className="flex items-center gap-2 text-body-sm font-medium text-[var(--text-primary)]"><BookOpen aria-hidden className="w-4 h-4 text-[var(--brand-600)]" />These articles may help</div>
                  <ul className="space-y-2">
                    {kb.data.values.slice(0, 3).map((a) => (
                      <li key={a.id} className="text-body-sm"><span className="font-medium text-[var(--brand-700)]">{a.title}</span><span className="text-[var(--text-secondary)]"> — {a.excerpt}</span></li>
                    ))}
                  </ul>
                </aside>
              )}

              <RequestFormFields
                fields={type.fields} values={values} errors={errors} files={files} disabled={busy}
                onChange={(k, v) => { setValues((p) => ({ ...p, [k]: v })); if (errors[k]) setErrors((p) => ({ ...p, [k]: '' })) }}
                onFiles={(k, fs) => setFiles((p) => ({ ...p, [k]: fs }))}
              />

              {!type.descriptionField && (
                <div className="space-y-1.5">
                  <label htmlFor="req-description" className="block text-body-sm font-medium text-[var(--text-primary)]">Description</label>
                  <p className="text-caption text-[var(--text-tertiary)]">Include anything that helps us resolve this faster: what you expected, what happened, and any error messages.</p>
                  <RichTextEditor id="req-description" label="Description" rows={5} maxLength={20000} mentions={false} value={description} onChange={setDescription} />
                </div>
              )}

              {create.error && (
                <p role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_8%,var(--surface-0))] px-3 py-2.5 text-body-sm text-[var(--error)]">
                  <AlertCircle aria-hidden className="w-4 h-4 mt-0.5 shrink-0" />{create.error.message}
                </p>
              )}
            </div>
            <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 rounded-b-2xl border-t border-[var(--surface-3)] bg-[color-mix(in_srgb,var(--surface-0)_92%,transparent)] backdrop-blur px-5 sm:px-7 py-3">
              <button type="button" className="veqsio-btn-secondary min-h-[44px] px-4" onClick={() => setTypeId(null)} disabled={busy}>Cancel</button>
              <button type="submit" disabled={busy} className="veqsio-btn-primary min-h-[44px] px-5">
                {busy ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </form>
        </div>
      </PortalShell>
    )
  }

  const hero = (
    <section aria-labelledby="portal-hero" className="relative overflow-hidden border-b border-[var(--surface-3)] bg-[var(--surface-0)]">
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(60%_90%_at_50%_0%,color-mix(in_srgb,var(--brand-500)_16%,transparent),transparent_70%)]" />
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_60%,var(--surface-1))] opacity-60" />
      <div className="relative max-w-3xl mx-auto px-4 sm:px-6 pt-12 pb-12 sm:pt-16 sm:pb-16 text-center">
        <h1 id="portal-hero" className="text-[28px] sm:text-[36px] leading-tight font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          {data.welcomeMessage || `Welcome to ${portalName}`}
        </h1>
        <p className="mt-3 text-body sm:text-heading-2 sm:font-normal text-[var(--text-secondary)]">
          {data.introduction || data.description || 'Tell us what you need and we will route it to the right team.'}
        </p>
        <form role="search" onSubmit={(e) => e.preventDefault()} className="relative mt-8 max-w-xl mx-auto text-left">
          <label htmlFor="portal-search" className="sr-only">Search request types and articles</label>
          <Search aria-hidden className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)] pointer-events-none" />
          <input
            id="portal-search" type="search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="What do you need help with?"
            className="veqsio-input w-full !min-h-[56px] !rounded-xl !pl-12 !pr-12 !text-[16px] shadow-[var(--shadow-md)]"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 w-11 h-11 inline-flex items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]">
              <X aria-hidden className="w-4 h-4" />
            </button>
          )}
        </form>
      </div>
    </section>
  )

  return (
    <PortalShell slug={slug} title={data.name} hero={hero}>
      <PortalApprovals slug={slug} />

      {needle && (
        <p role="status" className="text-body-sm text-[var(--text-secondary)]">
          {shown.length + articles.length === 0 ? (search.isFetching ? 'Searching…' : `Nothing matches “${q.trim()}”.`) : `${shown.length} request ${shown.length === 1 ? 'type' : 'types'}${articles.length ? ` and ${articles.length} ${articles.length === 1 ? 'article' : 'articles'}` : ''} found`}
        </p>
      )}

      {data.requestTypes.length === 0 && (
        <EmptyState icon="inbox" title="No request types yet" description="This help center has no forms available at the moment. Please check back soon or contact your administrator." />
      )}

      {data.requestTypes.length > 0 && needle && shown.length === 0 && articles.length === 0 && !search.isFetching && (
        <EmptyState icon="search" title="No results" description="Try a different word, or clear the search to browse everything we offer." action={<button type="button" className="veqsio-btn-secondary min-h-[44px] px-4" onClick={() => setQ('')}>Clear search</button>} />
      )}

      {groups.map((g) => {
        const list = shown.filter((t) => (t.groupName ?? 'General') === g)
        if (!list.length) return null
        return (
          <section key={g} aria-labelledby={`grp-${g}`} className="space-y-3">
            <h2 id={`grp-${g}`} className="text-heading-3 text-[var(--text-primary)]">{g}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((t) => (
                <button key={t.id} type="button" onClick={() => choose(t.id)} className="veqsio-card group relative !p-5 text-left flex flex-col gap-3 min-h-[44px] hover:-translate-y-0.5 hover:border-[var(--brand-300)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-400)]">
                  <RequestTypeTile name={t.icon} />
                  <span className="block">
                    <span className="block text-heading-3 text-[var(--text-primary)]">{t.name}</span>
                    {t.description && <span className="mt-1 block text-body-sm text-[var(--text-secondary)] line-clamp-3">{t.description}</span>}
                  </span>
                  <ArrowRight aria-hidden className="absolute right-4 top-5 w-4 h-4 text-[var(--text-tertiary)] opacity-0 -translate-x-1 transition group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100" />
                </button>
              ))}
            </div>
          </section>
        )
      })}

      {articles.length > 0 && (
        <section aria-labelledby="kb-results" className="space-y-3">
          <h2 id="kb-results" className="text-heading-3 text-[var(--text-primary)]">Knowledge base articles</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {articles.map((a) => (
              <li key={a.id} className="veqsio-card !p-4 flex gap-3">
                <span aria-hidden className="w-10 h-10 shrink-0 rounded-lg inline-flex items-center justify-center bg-[var(--surface-2)] text-[var(--text-secondary)]"><BookOpen className="w-5 h-5" /></span>
                <span className="min-w-0">
                  <span className="block text-heading-3 text-[var(--text-primary)]">{a.title}</span>
                  <span className="mt-1 block text-body-sm text-[var(--text-secondary)] line-clamp-3">{a.excerpt}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PortalShell>
  )
}
