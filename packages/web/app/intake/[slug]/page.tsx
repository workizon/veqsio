'use client'

import { PoweredBy } from '@/components/powered-by'
import { useEffect, useId, useState } from 'react'
import { useParams } from 'next/navigation'
import { Logo } from '@/components/logo'
import { Spinner } from '@/components/spinner'
import { fetchPublicForm, submitPublicForm, type PublicIntakeForm } from '@/hooks/use-intake'

/** Public intake form. Anonymous: shows only what the project chose to show (title, introduction, fields). */
export default function PublicIntakePage() {
  const { slug } = useParams<{ slug: string }>()
  const id = useId()
  const [form, setForm] = useState<PublicIntakeForm | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'sent'>('loading')
  const [values, setValues] = useState({ title: '', description: '', name: '', email: '' })
  const [honeypot, setHoneypot] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = 'Submit a request'
    fetchPublicForm(slug).then((f) => { setForm(f); setState('ready'); document.title = f.title }).catch(() => setState('missing'))
  }, [slug])

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [k]: e.target.value }))

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await submitPublicForm(slug, {
        title: values.title.trim(),
        ...(form!.fields.description !== 'off' ? { description: values.description } : {}),
        ...(form!.fields.name !== 'off' ? { name: values.name } : {}),
        ...(form!.fields.email !== 'off' ? { email: values.email.trim() } : {}),
        website: honeypot,
      })
      setState('sent')
    } catch (err) {
      const status = (err as { status?: number }).status
      setError(status === 429 ? 'Too many submissions from your connection. Please try again later.' : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const f = form?.fields
  return (
    <div className="min-h-dvh bg-[var(--surface-1)] text-[var(--text-primary)]">
      <main className="mx-auto max-w-xl px-4 py-10">
        <div className="mb-6 flex items-center gap-2 text-[var(--text-secondary)]"><Logo size={22} /><PoweredBy className="text-sm" /></div>
        {state === 'loading' && <div className="flex justify-center py-16"><Spinner size="lg" /></div>}
        {state === 'missing' && (
          <div role="alert" className="veqsio-card p-6">
            <h1 className="text-heading-2">This form is not available</h1>
            <p className="mt-2 text-[var(--text-secondary)]">The link may be wrong or the form was closed.</p>
          </div>
        )}
        {state === 'sent' && (
          <div role="status" className="veqsio-card p-6">
            <h1 className="text-heading-2">Thank you</h1>
            <p className="mt-2 text-[var(--text-secondary)]">Your submission was received and will be reviewed by the team.{f?.email !== 'off' && ' If you gave an email address, you will hear back once it has been looked at.'}</p>
          </div>
        )}
        {state === 'ready' && form && f && (
          <form onSubmit={send} className="veqsio-card p-6 space-y-4" aria-labelledby={`${id}-h`}>
            <h1 id={`${id}-h`} className="text-heading-1">{form.title}</h1>
            {form.intro && <p className="whitespace-pre-wrap text-[var(--text-secondary)]">{form.intro}</p>}
            <div>
              <label htmlFor={`${id}-title`} className="block text-sm font-medium mb-1">Title <span aria-hidden>*</span></label>
              <input id={`${id}-title`} className="veqsio-input w-full" required maxLength={200} value={values.title} onChange={set('title')} autoFocus />
            </div>
            {f.description !== 'off' && (
              <div>
                <label htmlFor={`${id}-desc`} className="block text-sm font-medium mb-1">Details{f.description === 'required' ? <span aria-hidden> *</span> : ' (optional)'}</label>
                <textarea id={`${id}-desc`} className="veqsio-input w-full min-h-[140px]" required={f.description === 'required'} maxLength={10000} value={values.description} onChange={set('description')} />
              </div>
            )}
            {f.name !== 'off' && (
              <div>
                <label htmlFor={`${id}-name`} className="block text-sm font-medium mb-1">Your name{f.name === 'required' ? <span aria-hidden> *</span> : ' (optional)'}</label>
                <input id={`${id}-name`} className="veqsio-input w-full" autoComplete="name" required={f.name === 'required'} maxLength={100} value={values.name} onChange={set('name')} />
              </div>
            )}
            {f.email !== 'off' && (
              <div>
                <label htmlFor={`${id}-email`} className="block text-sm font-medium mb-1">Email{f.email === 'required' ? <span aria-hidden> *</span> : ' (optional)'}</label>
                <input id={`${id}-email`} type="email" className="veqsio-input w-full" autoComplete="email" required={f.email === 'required'} maxLength={254} value={values.email} onChange={set('email')} />
              </div>
            )}
            {/* Honeypot: invisible to people and assistive technology, tempting to bots. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
              <label>Leave this field empty<input tabIndex={-1} autoComplete="off" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} /></label>
            </div>
            {error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}
            <button type="submit" className="veqsio-btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Submit'}</button>
          </form>
        )}
      </main>
    </div>
  )
}
