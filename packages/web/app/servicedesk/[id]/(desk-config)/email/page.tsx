'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { ImapSettings } from '@/components/servicedesk/imap-settings'
import {
  useDeskRequestTypes, useEmailChannel, useRotateEmailSecret, useUpdateEmailChannel,
} from '@/hooks/use-servicedesk-email'
import { confirmDialog } from '@/components/dialogs'

export default function EmailChannelPage() {
  const { tr } = useI18n();

  const id = Number(useParams<{ id: string }>().id)
  const channel = useEmailChannel(id)
  const types = useDeskRequestTypes(id)
  const update = useUpdateEmailChannel(id)
  const rotate = useRotateEmailSecret(id)

  const [enabled, setEnabled] = useState(false)
  const [requestType, setRequestType] = useState('')
  const [domains, setDomains] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!channel.data) return
    setEnabled(channel.data.enabled)
    setRequestType(channel.data.defaultRequestTypeId ? String(channel.data.defaultRequestTypeId) : '')
    setDomains(channel.data.allowedSenderDomains.join(', '))
  }, [channel.data])

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const endpoint = `${origin}${channel.data?.inboundPath ?? ''}`

  async function save() {
    setMessage(null)
    try {
      const res = await update.mutateAsync({
        enabled,
        defaultRequestTypeId: requestType ? Number(requestType) : null,
        allowedSenderDomains: domains.split(/[\s,;]+/).filter(Boolean),
      })
      if (res.secret) setSecret(res.secret) // first configuration reveals the secret once
      setMessage(tr('Saved'))
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  async function doRotate() {
    if (!(await confirmDialog(tr('Rotate the secret? Gateways using the current secret will stop working.')))) return
    setMessage(null)
    try {
      const res = await rotate.mutateAsync()
      setSecret(res.secret)
      setCopied(false)
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  async function copy() {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setMessage(tr('Copy failed, select the secret and copy it manually'))
    }
  }

  const curl = `curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Veqsio-Inbound-Secret: ${secret ?? '<secret>'}' \\
  -d '{"messageId":"<unique-id@example.com>","from":"Jane <jane@example.com>","subject":"Printer broken","text":"It is on fire","headers":{}}'`

  return (
    <>
      <div className="space-y-4">
        <PageHeader title={tr('Email channel')} actions={<><Link href={`/servicedesk/${id}`} className="veqsio-btn-secondary">{tr('Back to service desk')}</Link></>} />

        {channel.isLoading && <Spinner />}
        {channel.isError && <p role="alert">{tr('Could not load the email channel (admin access required).')}</p>}

        {channel.data && (
          <>
            <section className="veqsio-card p-4 space-y-4" aria-labelledby="email-settings">
              <h2 id="email-settings" className="text-heading-2">{tr('Settings')}</h2>
              <p className="text-sm text-[var(--text-secondary)]">
                {tr('Mail gateways post parsed emails to the endpoint below. New emails become requests; replies that contain the request key in the subject become public comments.')} </p>

              <label className="flex items-center gap-2">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <span>{tr('Accept inbound email')}</span>
              </label>

              <div className="space-y-1">
                <label htmlFor="default-request-type" className="block font-medium">{tr('Default request type')}</label>
                <select
                  id="default-request-type" className="veqsio-input" value={requestType}
                  onChange={(e) => setRequestType(e.target.value)}
                >
                  <option value="">{tr('None (new emails are rejected)')}</option>
                  {types.data?.values.filter((t) => t.enabled).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="allowed-domains" className="block font-medium">{tr('Allowed sender domains')}</label>
                <input
                  id="allowed-domains" className="veqsio-input" placeholder={tr('example.com, partner.org')}
                  value={domains} onChange={(e) => setDomains(e.target.value)} aria-describedby="allowed-domains-help"
                />
                <p id="allowed-domains-help" className="text-sm text-[var(--text-secondary)]">{tr('Comma separated. Leave empty to accept any domain.')}</p>
              </div>

              <div className="flex items-center gap-3">
                <button className="veqsio-btn-primary" onClick={save} disabled={update.isPending}>{tr('Save')}</button>
                {message && <span role="status">{message}</span>}
              </div>
            </section>

            <ImapSettings deskId={id} channel={channel.data} />

            <section className="veqsio-card p-4 space-y-3" aria-labelledby="email-secret">
              <h2 id="email-secret" className="text-heading-2">{tr('Inbound secret')}</h2>
              <p className="text-sm text-[var(--text-secondary)]">
                {tr('Sent in the')} <code>X-Veqsio-Inbound-Secret</code> {tr('header. It is shown once and cannot be retrieved later.')} </p>
              {secret && (
                <div role="alert" className="space-y-2">
                  <label htmlFor="new-secret" className="block font-medium">{tr('New secret (copy it now)')}</label>
                  <div className="flex gap-2">
                    <input id="new-secret" readOnly className="veqsio-input font-mono" value={secret} onFocus={(e) => e.currentTarget.select()} />
                    <button className="veqsio-btn-secondary" onClick={copy} aria-label={tr('Copy secret to clipboard')}>{copied ? tr('Copied') : tr('Copy')}</button>
                  </div>
                  <button className="veqsio-btn-secondary" onClick={() => setSecret(null)}>{tr('I have stored it, hide')}</button>
                </div>
              )}
              <button className="veqsio-btn-secondary" onClick={doRotate} disabled={rotate.isPending}>
                {channel.data.configured ? tr('Rotate secret') : tr('Generate secret')}
              </button>
            </section>

            <section className="veqsio-card p-4 space-y-2" aria-labelledby="email-usage">
              <h2 id="email-usage" className="text-heading-2">{tr('Usage')}</h2>
              <p className="text-sm text-[var(--text-secondary)]">
                {tr('Endpoint:')} <code>{endpoint}</code>{tr('. Use a unique')} <code>messageId</code> {tr('(the email Message-ID) so retries are ignored.')} </p>
              <pre className="overflow-x-auto rounded bg-[var(--surface-2)] p-3 text-sm" aria-label={tr('Example curl command')}><code>{curl}</code></pre>
            </section>
          </>
        )}
      </div>
    </>
  )
}
