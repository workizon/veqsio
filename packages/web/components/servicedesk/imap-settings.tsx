'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, CircleDashed } from 'lucide-react'
import { toast } from '@/components/toast'
import { useUpdateEmailChannel, type EmailChannel } from '@/hooks/use-servicedesk-email'
import { useInboundMessages, usePollNow, useTestImap } from '@/hooks/use-servicedesk-comms'
import { describePoll, validateImapForm, looksLikeEmail, type ImapForm } from '@/lib/servicedesk-comms'

const fromChannel = (c: EmailChannel): ImapForm => ({
  enabled: c.imap.enabled, host: c.imap.host, port: String(c.imap.port), tls: c.imap.tls, user: c.imap.user,
  password: '', folder: c.imap.folder, pollSeconds: String(c.imap.pollSeconds),
})

/** Mailbox polling and reply address of a desk's e-mail channel (admin only; the API enforces it). */
export function ImapSettings({ deskId, channel }: { deskId: number; channel: EmailChannel }) {
  const update = useUpdateEmailChannel(deskId)
  const test = useTestImap(deskId)
  const poll = usePollNow(deskId)
  const messages = useInboundMessages(deskId, channel.configured)
  const [form, setForm] = useState<ImapForm>(() => fromChannel(channel))
  const [replyTo, setReplyTo] = useState(channel.replyAddress ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => { setForm(fromChannel(channel)); setReplyTo(channel.replyAddress ?? '') }, [channel])

  const set = <K extends keyof ImapForm>(k: K, v: ImapForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })) }
  const status = describePoll(channel.imap)
  const StatusIcon = status.tone === 'ok' ? CheckCircle2 : status.tone === 'error' ? AlertCircle : CircleDashed
  const toneClass = status.tone === 'ok' ? 'text-[var(--success)]' : status.tone === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-tertiary)]'

  const payload = () => ({
    enabled: form.enabled, host: form.host.trim() || null, port: Number(form.port), tls: form.tls, user: form.user.trim() || null,
    ...(form.password ? { password: form.password } : {}), folder: form.folder.trim(), pollSeconds: Number(form.pollSeconds),
  })

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const problems = validateImapForm(form, channel.imap.passwordSet)
    if (replyTo.trim() && !looksLikeEmail(replyTo)) problems.replyTo = 'Enter a valid email address'
    setErrors(problems)
    if (Object.keys(problems).length) {
      setTimeout(() => document.querySelector<HTMLElement>('#imap-form [aria-invalid="true"]')?.focus(), 0)
      return
    }
    try {
      await update.mutateAsync({ replyAddress: replyTo.trim() || null, imap: payload() })
      toast('Mailbox settings saved', 'success')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  async function runTest() {
    setTestResult(null)
    const p = payload()
    const r = await test.mutateAsync({
      host: p.host ?? undefined, port: p.port, tls: p.tls, user: p.user ?? undefined, password: p.password, folder: p.folder,
    }).catch((err: Error) => ({ ok: false as const, error: err.message }))
    setTestResult(r.ok
      ? { ok: true, text: `Connected. ${r.unseen} unread message${r.unseen === 1 ? '' : 's'} in ${form.folder}.` }
      : { ok: false, text: r.error })
  }

  async function pollNow() {
    try {
      const r = await poll.mutateAsync()
      toast(r.status === 'locked' ? 'Another poll is already running' : 'Mailbox polled', 'success')
      void messages.refetch()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  const field = (id: string, label: string, el: React.ReactNode, hint?: string) => (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-medium text-body-sm">{label}</label>
      {el}
      {hint && !errors[id] && <p id={`${id}-hint`} className="text-caption text-[var(--text-tertiary)]">{hint}</p>}
      {errors[id] && <p id={`${id}-err`} role="alert" className="text-caption text-[var(--error)]">{errors[id]}</p>}
    </div>
  )
  const a11y = (id: string, hint?: boolean) => ({
    id, 'aria-invalid': errors[id] ? true : undefined, 'aria-describedby': errors[id] ? `${id}-err` : hint ? `${id}-hint` : undefined,
  })

  return (
    <>
      <section className="veqsio-card p-4 space-y-4" aria-labelledby="imap-h">
        <div>
          <h2 id="imap-h" className="text-heading-2">Mailbox polling (IMAP)</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Instead of a mail gateway, Veqsio can read a mailbox itself. Unread messages become requests; replies to our emails
            (matched by request key or by the reply headers) become public comments. Messages are marked as read only after they were processed.
            Auto-replies, bounces and mailing-list mail are ignored. Requires &ldquo;Accept inbound email&rdquo; to be on.
          </p>
        </div>

        <form id="imap-form" onSubmit={save} noValidate className="space-y-4" aria-label="Mailbox settings">
          <label className="flex items-center gap-2">
            <input type="checkbox" role="switch" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span>Poll this mailbox</span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            {field('host', 'IMAP host', <input {...a11y('host')} className="veqsio-input w-full" placeholder="imap.example.com" autoComplete="off" value={form.host} onChange={(e) => set('host', e.target.value)} />)}
            {field('port', 'Port', <input {...a11y('port')} className="veqsio-input w-full" inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} />)}
            {field('user', 'User', <input {...a11y('user')} className="veqsio-input w-full" autoComplete="off" placeholder="support@example.com" value={form.user} onChange={(e) => set('user', e.target.value)} />)}
            {field('password', 'Password',
              <input {...a11y('password', true)} type="password" className="veqsio-input w-full" autoComplete="new-password"
                placeholder={channel.imap.passwordSet ? 'Stored, leave empty to keep' : ''} value={form.password} onChange={(e) => set('password', e.target.value)} />,
              'Stored encrypted and never shown again.')}
            {field('folder', 'Folder', <input {...a11y('folder')} className="veqsio-input w-full" value={form.folder} onChange={(e) => set('folder', e.target.value)} />)}
            {field('pollSeconds', 'Poll interval (seconds)', <input {...a11y('pollSeconds', true)} className="veqsio-input w-full" inputMode="numeric" value={form.pollSeconds} onChange={(e) => set('pollSeconds', e.target.value)} />, 'At least 60.')}
          </div>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.tls} onChange={(e) => set('tls', e.target.checked)} />
            <span>Use TLS (implicit, usually port 993)</span>
          </label>

          <div className="space-y-1 max-w-md">
            {field('replyTo', 'Reply-To address on outgoing mail',
              <input {...a11y('replyTo', true)} className="veqsio-input w-full" placeholder="support@example.com" value={replyTo} onChange={(e) => { setReplyTo(e.target.value); setErrors((x) => ({ ...x, replyTo: '' })) }} />,
              'Customers reply here. Defaults to the IMAP user when that is an address.')}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="veqsio-btn-primary" disabled={update.isPending}>Save</button>
            <button type="button" className="veqsio-btn-secondary" onClick={runTest} disabled={test.isPending}>{test.isPending ? 'Testing…' : 'Test connection'}</button>
            <button type="button" className="veqsio-btn-secondary" onClick={pollNow} disabled={poll.isPending || !channel.imap.host}>Poll now</button>
          </div>
          {testResult && (
            <p role="status" className={`flex items-start gap-2 text-sm ${testResult.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
              {testResult.ok ? <CheckCircle2 aria-hidden className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle aria-hidden className="w-4 h-4 mt-0.5 shrink-0" />}
              <span>{testResult.ok ? 'Success. ' : 'Failed. '}{testResult.text}</span>
            </p>
          )}
        </form>

        <div className="rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)] px-3 py-2.5" aria-label="Last poll">
          <p className="text-caption font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Last poll</p>
          <p role="status" className={`mt-1 flex items-start gap-2 text-sm ${toneClass}`}>
            <StatusIcon aria-hidden className="w-4 h-4 mt-0.5 shrink-0" /><span>{status.text}</span>
          </p>
        </div>
      </section>

      <section className="veqsio-card p-4 space-y-3" aria-labelledby="inbound-h">
        <h2 id="inbound-h" className="text-heading-2">Recent inbound messages</h2>
        <p className="text-sm text-[var(--text-secondary)]">Includes rejected mail (unknown sender, auto-replies, bounces), so nothing disappears silently.</p>
        {messages.isLoading && <p className="text-sm text-[var(--text-tertiary)]">Loading…</p>}
        {messages.data && messages.data.values.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">No messages received yet.</p>}
        {messages.data && messages.data.values.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="veqsio-table-header text-left"><th className="px-3 py-2">From</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Result</th></tr></thead>
              <tbody>
                {messages.data.values.map((m) => (
                  <tr key={m.id} className="veqsio-table-row">
                    <td className="px-3 py-2 whitespace-nowrap">{m.from}</td>
                    <td className="px-3 py-2 max-w-[28ch] truncate" title={m.subject ?? ''}>{m.subject}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium">{m.status === 'created' ? 'Request created' : m.status === 'commented' ? 'Comment added' : 'Ignored'}</span>
                      {m.reason && <span className="text-[var(--text-tertiary)]"> ({m.reason})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
