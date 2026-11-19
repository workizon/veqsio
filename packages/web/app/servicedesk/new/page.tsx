'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { toast } from '@/components/toast'
import { useCreateDesk, useExtraDeskTemplates, useProjects, type DeskTemplateId } from '@/hooks/use-servicedesk-admin'
import { TEMPLATE_OPTIONS, mergeTemplateOptions, slugify, suggestProjectKey, validateWizard } from '@/lib/desk-wizard'

type Step = 1 | 2 | 3
const STEPS = ['Choose a template', 'Name and project', 'Who can raise requests'] as const

/** Create a service desk project: template, name/key/project, customer access. */
export default function NewServiceDeskPage() {
  const router = useRouter()
  const create = useCreateDesk()
  const projects = useProjects()
  const extraTemplates = useExtraDeskTemplates()
  const templateOptions = mergeTemplateOptions(TEMPLATE_OPTIONS, extraTemplates.data)
  const [step, setStep] = useState<Step>(1)
  const [template, setTemplate] = useState<DeskTemplateId>('it-support')
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [slug, setSlug] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [existingKey, setExistingKey] = useState('')
  const [description, setDescription] = useState('')
  const [publicSignup, setPublicSignup] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const errors = validateWizard({ name, key, slug, mode, existingKey })

  function onName(v: string) {
    setName(v)
    if (!keyTouched) setKey(suggestProjectKey(v))
    if (!slugTouched) setSlug(slugify(v))
  }

  function next() {
    if (step === 2) {
      setShowErrors(true)
      if (Object.keys(errors).length) return
    }
    setStep((s) => (Math.min(3, s + 1) as Step))
  }

  async function submit() {
    setServerError(null)
    setShowErrors(true)
    if (Object.keys(errors).length) { setStep(2); return }
    try {
      const desk = await create.mutateAsync({
        projectKey: mode === 'new' ? key : existingKey, createProject: mode === 'new', name: name.trim(), slug,
        description: description.trim() || undefined, publicSignup, template,
      })
      toast('Service desk created', 'success')
      router.push(`/servicedesk/${desk.id}/settings`)
    } catch (e) {
      setServerError((e as Error).message)
    }
  }

  const err = (k: string) => (showErrors ? errors[k] : undefined)

  return (
    <AppLayout>
      <div className="space-y-5">
        <PageHeader title="Create service desk" description="A service desk project gives your customers a portal and your agents queues, request types and SLAs." />

        <ol className="flex flex-wrap gap-2" aria-label="Progress">
          {STEPS.map((label, i) => {
            const n = (i + 1) as Step
            const state = n === step ? 'current' : n < step ? 'done' : 'todo'
            return (
              <li key={label} aria-current={state === 'current' ? 'step' : undefined}
                className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm ${state === 'current' ? 'bg-[var(--brand-500)] text-[var(--text-inverse)]' : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'}`}>
                {state === 'done' ? <Check className="w-3.5 h-3.5" aria-hidden /> : <span aria-hidden>{n}</span>}
                {label}
              </li>
            )
          })}
        </ol>

        {step === 1 && (
          <fieldset className="space-y-3">
            <legend className="sr-only">Template</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {templateOptions.map((t) => (
                <label key={t.id} className={`veqsio-card p-4 cursor-pointer space-y-1 focus-within:ring-2 focus-within:ring-[var(--brand-500)] ${template === t.id ? 'border-[var(--brand-500)] ring-1 ring-[var(--brand-500)]' : ''}`}>
                  <span className="flex items-center gap-2">
                    <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
                    <span className="font-medium text-[var(--text-primary)]">{t.title}</span>
                  </span>
                  <span className="block text-sm text-[var(--text-secondary)]">{t.description}</span>
                  <span className="block text-xs text-[var(--text-tertiary)]">{t.examples}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">Templates add request types, queues and SLAs you can change afterwards.</p>
          </fieldset>
        )}

        {step === 2 && (
          <div className="veqsio-card p-5 space-y-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium">Name</span>
              <input autoFocus maxLength={255} className="veqsio-input w-full" value={name} onChange={(e) => onName(e.target.value)} aria-invalid={err('name') ? true : undefined} />
              {err('name') && <span role="alert" className="block text-xs text-[var(--error)]">{err('name')}</span>}
            </label>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Project</legend>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="mode" className="mt-1" checked={mode === 'new'} onChange={() => setMode('new')} />
                <span><span className="font-medium">Create a new project</span><br /><span className="text-[var(--text-secondary)]">Requests become issues in a new project with the default schemes.</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="mode" className="mt-1" checked={mode === 'existing'} onChange={() => setMode('existing')} />
                <span><span className="font-medium">Use an existing project</span><br /><span className="text-[var(--text-secondary)]">Requests become issues in a project you administer.</span></span>
              </label>
            </fieldset>

            {mode === 'new' ? (
              <label className="block space-y-1 max-w-xs">
                <span className="text-sm font-medium">Project key</span>
                <input
                  maxLength={10} className="veqsio-input w-full font-mono uppercase" value={key} aria-invalid={err('key') ? true : undefined} aria-describedby="key-help"
                  onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')) }}
                />
                <span id="key-help" className="block text-xs text-[var(--text-tertiary)]">Issue keys will look like {key || 'KEY'}-1. Cannot be changed later.</span>
                {err('key') && <span role="alert" className="block text-xs text-[var(--error)]">{err('key')}</span>}
              </label>
            ) : (
              <label className="block space-y-1 max-w-sm">
                <span className="text-sm font-medium">Existing project</span>
                <select className="veqsio-input w-full" value={existingKey} onChange={(e) => setExistingKey(e.target.value)} aria-invalid={err('existingKey') ? true : undefined}>
                  <option value="">Select a project…</option>
                  {projects.data?.map((p) => <option key={p.id} value={p.key}>{p.name} ({p.key})</option>)}
                </select>
                {err('existingKey') && <span role="alert" className="block text-xs text-[var(--error)]">{err('existingKey')}</span>}
              </label>
            )}

            <label className="block space-y-1 max-w-sm">
              <span className="text-sm font-medium">Portal address</span>
              <div className="flex items-center gap-1">
                <span className="text-sm text-[var(--text-tertiary)]">/portal/</span>
                <input
                  className="veqsio-input w-full font-mono" value={slug} aria-invalid={err('slug') ? true : undefined}
                  onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')) }}
                />
              </div>
              {err('slug') && <span role="alert" className="block text-xs text-[var(--error)]">{err('slug')}</span>}
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Description <span className="font-normal text-[var(--text-tertiary)]">(optional)</span></span>
              <textarea rows={2} maxLength={5000} className="veqsio-input w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <fieldset className="veqsio-card p-5 space-y-3">
              <legend className="px-1 text-sm font-medium">Who can raise requests?</legend>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="access" className="mt-1" checked={!publicSignup} onChange={() => setPublicSignup(false)} />
                <span><span className="font-medium">Invited customers only</span><br /><span className="text-[var(--text-secondary)]">You add customers by email in the desk settings.</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="access" className="mt-1" checked={publicSignup} onChange={() => setPublicSignup(true)} />
                <span><span className="font-medium">Anyone with an account can sign up</span><br /><span className="text-[var(--text-secondary)]">Signed-in users become customers the first time they open the portal.</span></span>
              </label>
            </fieldset>
            <dl className="veqsio-card p-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-[var(--text-tertiary)]">Template</dt><dd>{templateOptions.find((t) => t.id === template)?.title}</dd>
              <dt className="text-[var(--text-tertiary)]">Name</dt><dd>{name}</dd>
              <dt className="text-[var(--text-tertiary)]">Project</dt><dd>{mode === 'new' ? `New project ${key}` : `Existing project ${existingKey}`}</dd>
              <dt className="text-[var(--text-tertiary)]">Portal</dt><dd className="font-mono">/portal/{slug}</dd>
            </dl>
            {serverError && <p role="alert" className="text-sm text-[var(--error)]">{serverError}</p>}
          </div>
        )}

        <div className="flex items-center justify-between">
          <Link href="/servicedesk" className="veqsio-btn-ghost">Cancel</Link>
          <div className="flex gap-2">
            {step > 1 && <button type="button" className="veqsio-btn-secondary" onClick={() => setStep((s) => (s - 1) as Step)}>Back</button>}
            {step < 3
              ? <button type="button" className="veqsio-btn-primary" onClick={next}>Next</button>
              : <button type="button" className="veqsio-btn-primary" disabled={create.isPending} onClick={submit}>{create.isPending ? 'Creating…' : 'Create service desk'}</button>}
          </div>
        </div>
      </div>
    </AppLayout>
  )
}
