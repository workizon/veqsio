'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from '@/components/toast'
import {
  useIntakeSettings, useRotateIntakeEmailSecret, useRotateIntakeSlug, useUpdateIntakeSettings,
  type FieldMode, type IntakeFields,
} from '@/hooks/use-intake'
import { confirmDialog } from '@/components/dialogs'

const origin = () => (typeof window === 'undefined' ? '' : window.location.origin)

/** Project settings tab: switch intake on, public form, email webhook. */
export function IntakeSettingsPanel({ projectKey }: { projectKey: string }) {
  const q = useIntakeSettings(projectKey)
  const update = useUpdateIntakeSettings(projectKey)
  const rotateSlug = useRotateIntakeSlug(projectKey)
  const rotateSecret = useRotateIntakeEmailSecret(projectKey)
  const s = q.data
  const [title, setTitle] = useState('')
  const [intro, setIntro] = useState('')
  const [fields, setFields] = useState<IntakeFields>({ name: 'optional', email: 'optional', description: 'optional' })
  const [secret, setSecret] = useState<string | null>(null)

  useEffect(() => { if (s) { setTitle(s.formTitle); setIntro(s.formIntro); setFields(s.fields) } }, [s?.formTitle, s?.formIntro, s?.fields]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (body: Parameters<typeof update.mutateAsync>[0], ok: string) => {
    try { await update.mutateAsync(body); toast(ok, 'success') } catch (e) { toast((e as Error).message, 'error') }
  }

  if (q.isLoading) return <p>Loading…</p>
  if (q.error || !s) return <p role="alert" className="text-[var(--error)]">{(q.error as Error)?.message ?? 'Could not load the intake settings'}</p>
  const formUrl = s.publicFormPath ? `${origin()}${s.publicFormPath}` : null

  return (
    <div className="max-w-2xl space-y-6">
      <section aria-labelledby="intake-enable" className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 space-y-3">
        <h2 id="intake-enable" className="text-heading-3">Intake queue</h2>
        <label className="flex items-start gap-3 text-body">
          <input type="checkbox" className="mt-1" checked={s.enabled} disabled={update.isPending} onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? 'Intake enabled' : 'Intake disabled')} />
          <span>
            Collect submissions in an intake queue
            <span className="block text-body-sm text-[var(--text-secondary)]">Submissions are not issues. Members with permission to create issues accept, decline, snooze or mark them as duplicates. Turning it off keeps all data and closes the public form and the email address.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-body">
          <input type="checkbox" className="mt-1" checked={s.notifyLead !== false} disabled={update.isPending || !s.enabled} onChange={(e) => void save({ notifyLead: e.target.checked }, e.target.checked ? 'The project lead is notified' : 'No notifications')} />
          <span>
            E-mail the project lead about new submissions
            <span className="block text-body-sm text-[var(--text-secondary)]">At most one e-mail per 10 minutes, so a flood of submissions does not flood the inbox.</span>
          </span>
        </label>
        {s.enabled && <p className="text-body-sm"><Link className="text-[var(--brand-500)] hover:underline" href={`/projects/${projectKey}/intake`}>Open the queue</Link></p>}
      </section>

      <section aria-labelledby="intake-public" className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 space-y-4">
        <h2 id="intake-public" className="text-heading-3">Public form</h2>
        <label className="flex items-start gap-3 text-body">
          <input type="checkbox" className="mt-1" checked={s.publicFormEnabled} disabled={update.isPending || !s.enabled} onChange={(e) => void save({ publicFormEnabled: e.target.checked }, e.target.checked ? 'Public form on' : 'Public form off')} />
          <span>
            Anyone with the link can submit, without signing in
            <span className="block text-body-sm text-[var(--text-secondary)]">The link is unguessable. Visitors see only the title and introduction below, never your project. Spam protection: a hidden honeypot field, a limit per address and per form, and size limits.</span>
          </span>
        </label>
        {formUrl && (
          <p className="text-body-sm">Form link: <code className="break-all">{formUrl}</code>{' '}
            <button type="button" className="text-[var(--brand-500)] hover:underline" onClick={() => { void navigator.clipboard?.writeText(formUrl); toast('Link copied', 'success') }}>Copy</button>
            {' · '}
            <button type="button" className="text-[var(--brand-500)] hover:underline" disabled={rotateSlug.isPending}
              onClick={async () => { if ((await confirmDialog('Create a new link? The current link stops working immediately.'))) { try { await rotateSlug.mutateAsync(); toast('New link created', 'success') } catch (e) { toast((e as Error).message, 'error') } } }}>New link</button>
          </p>
        )}
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save({ formTitle: title, formIntro: intro, fields }, 'Form saved') }}>
          <div>
            <label htmlFor="intake-title" className="block text-sm font-medium mb-1">Form title</label>
            <input id="intake-title" className="veqsio-input w-full" maxLength={120} value={title} placeholder="Submit a request" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="intake-intro" className="block text-sm font-medium mb-1">Introduction</label>
            <textarea id="intake-intro" className="veqsio-input w-full min-h-[80px]" maxLength={2000} value={intro} onChange={(e) => setIntro(e.target.value)} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Fields to collect (the title is always required)</legend>
            {(['name', 'email', 'description'] as const).map((f) => (
              <div key={f} className="flex items-center gap-3">
                <label htmlFor={`intake-f-${f}`} className="w-28 text-sm capitalize">{f}</label>
                <select id={`intake-f-${f}`} className="veqsio-input" value={fields[f]} onChange={(e) => setFields({ ...fields, [f]: e.target.value as FieldMode })}>
                  <option value="off">Not asked</option>
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                </select>
              </div>
            ))}
            <p className="text-xs text-[var(--text-tertiary)]">Requesters who give an email address are told when their submission is accepted or declined.</p>
          </fieldset>
          <button type="submit" className="veqsio-btn-primary" disabled={update.isPending}>Save form</button>
        </form>
      </section>

      <section aria-labelledby="intake-email" className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)] p-5 space-y-3">
        <h2 id="intake-email" className="text-heading-3">Email intake</h2>
        <p className="text-body-sm text-[var(--text-secondary)]">
          Your mail gateway (or an automation) posts each incoming message as JSON to the address below with the secret in the <code>X-Veqsio-Inbound-Secret</code> header.
          Veqsio does not poll a mailbox itself. Quoted replies and signatures are removed, auto-replies are ignored and redelivered messages are not duplicated.
        </p>
        {s.emailWebhookPath && <p className="text-body-sm">POST <code className="break-all">{origin()}{s.emailWebhookPath}</code></p>}
        {secret && (
          <div role="status" className="rounded-lg border border-[var(--brand-500)] p-3 text-body-sm">
            Secret (shown once, copy it now): <code className="break-all">{secret}</code>
            <button type="button" className="ml-2 text-[var(--brand-500)] hover:underline" onClick={() => setSecret(null)}>Done</button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="veqsio-btn-secondary" disabled={rotateSecret.isPending}
            onClick={async () => {
              if (s.emailConfigured && !(await confirmDialog('Create a new secret? The current one stops working immediately.'))) return
              try { setSecret((await rotateSecret.mutateAsync()).secret) } catch (e) { toast((e as Error).message, 'error') }
            }}>{s.emailConfigured ? 'New secret' : 'Create secret'}</button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.emailEnabled} disabled={update.isPending || !s.emailConfigured || !s.enabled} onChange={(e) => void save({ emailEnabled: e.target.checked }, e.target.checked ? 'Email intake on' : 'Email intake off')} />
            Accept email
          </label>
        </div>
      </section>
    </div>
  )
}
