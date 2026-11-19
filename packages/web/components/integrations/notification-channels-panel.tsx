'use client'

import { useState } from 'react'
import { ListChecks, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import {
  useChannelDeliveries, useDeleteChannel, useNotificationChannels, useSaveChannel, useTestChannel,
  type ChannelEvent, type ChannelScope, type ChannelType, type NotificationChannel,
} from '@/hooks/use-integrations'
import { confirmDialog } from '@/components/dialogs'

const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Request failed', 'error')
const TYPE_LABEL: Record<ChannelType, string> = { slack: 'Slack', teams: 'Microsoft Teams' }
const URL_HINT: Record<ChannelType, string> = {
  slack: 'Create an Incoming Webhook in your Slack app (https://hooks.slack.com/services/...). Mattermost and other Slack-compatible webhooks work too.',
  teams: 'Use the Workflows "Post to a channel when a webhook request is received" URL, or a legacy Office 365 connector URL.',
}

function ChannelForm({ scope, channel, events, onDone }: { scope: ChannelScope; channel: NotificationChannel | null; events: ChannelEvent[]; onDone: () => void }) {
  const save = useSaveChannel(scope)
  const [type, setType] = useState<ChannelType>(channel?.type ?? 'slack')
  const [name, setName] = useState(channel?.name ?? '')
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState<string[]>(channel?.events ?? ['issue.created', 'issue.transitioned'])
  const [teamsFormat, setTeamsFormat] = useState<'adaptive' | 'messagecard'>(channel?.settings.teamsFormat ?? 'adaptive')

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected.length) { toast('Choose at least one event', 'error'); return }
    try {
      await save.mutateAsync({
        id: channel?.id, name: name.trim(), events: selected,
        ...(channel ? {} : { type }),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...((channel?.type ?? type) === 'teams' ? { settings: { teamsFormat } } : {}),
      })
      toast(channel ? 'Channel saved' : 'Channel added', 'success')
      onDone()
    } catch (err) { fail(err) }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-body-sm">
          <span className="font-medium">Service</span>
          <select className="veqsio-input mt-1 w-full" value={type} disabled={!!channel} onChange={(e) => setType(e.target.value as ChannelType)}>
            {(Object.keys(TYPE_LABEL) as ChannelType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="block text-body-sm">
          <span className="font-medium">Name</span>
          <input className="veqsio-input mt-1 w-full" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="#dev-alerts" />
        </label>
      </div>
      <label className="block text-body-sm">
        <span className="font-medium">Incoming webhook URL</span>
        <input className="veqsio-input mt-1 w-full font-mono text-xs" type="url" required={!channel} autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder={channel ? `${channel.url} (leave empty to keep the stored URL)` : 'https://...'} />
        <span className="mt-0.5 block text-caption text-[var(--text-tertiary)]">{URL_HINT[channel?.type ?? type]} The URL is stored encrypted and never shown again.</span>
      </label>
      {(channel?.type ?? type) === 'teams' && (
        <label className="block text-body-sm">
          <span className="font-medium">Card format</span>
          <select className="veqsio-input mt-1 w-full" value={teamsFormat} onChange={(e) => setTeamsFormat(e.target.value as 'adaptive' | 'messagecard')}>
            <option value="adaptive">Adaptive card (Workflows)</option>
            <option value="messagecard">MessageCard (legacy connector)</option>
          </select>
        </label>
      )}
      <fieldset>
        <legend className="text-body-sm font-medium">Send a message when</legend>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          {events.map((ev) => (
            <label key={ev.id} className="flex items-center gap-2 text-body-sm">
              <input type="checkbox" checked={selected.includes(ev.id)} onChange={() => toggle(ev.id)} /> {ev.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2">
        <button type="button" className="veqsio-btn-secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="veqsio-btn-primary" disabled={save.isPending}>{channel ? 'Save' : 'Add channel'}</button>
      </div>
    </form>
  )
}

function LogDialog({ scope, channel, onClose }: { scope: ChannelScope; channel: NotificationChannel; onClose: () => void }) {
  const log = useChannelDeliveries(scope, channel.id)
  return (
    <Modal isOpen onClose={onClose} title={`Deliveries to ${channel.name}`} size="lg">
      {log.isLoading ? <Spinner /> : (log.data ?? []).length === 0 ? <p className="text-body-sm text-[var(--text-tertiary)]">Nothing sent yet.</p> : (
        <table className="w-full text-body-sm">
          <thead><tr className="text-left text-caption text-[var(--text-secondary)]"><th className="py-1">Time</th><th>Event</th><th>Result</th><th>Attempts</th></tr></thead>
          <tbody>
            {(log.data ?? []).map((d) => (
              <tr key={d.id} className="border-t border-[var(--surface-3)]">
                <td className="py-1 pr-2 tabular-nums">{new Date(d.createdAt).toLocaleString()}</td>
                <td className="pr-2">{d.event}</td>
                <td className={`pr-2 ${d.status === 'success' ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>{d.status}{d.responseStatus ? ` (${d.responseStatus})` : ''}{d.error ? `: ${d.error}` : ''}</td>
                <td>{d.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

/** Slack / Teams notification channels. `scope.project` = a project; no project = the instance default (all projects). */
export function NotificationChannelsPanel({ scope }: { scope: ChannelScope }) {
  const q = useNotificationChannels(scope)
  const save = useSaveChannel(scope)
  const remove = useDeleteChannel(scope)
  const test = useTestChannel(scope)
  const [editing, setEditing] = useState<NotificationChannel | 'new' | null>(null)
  const [logging, setLogging] = useState<NotificationChannel | null>(null)
  const events = q.data?.events ?? []
  const labelOf = (id: string) => events.find((e) => e.id === id)?.label ?? id

  const sendTest = async (c: NotificationChannel) => {
    try {
      const r = await test.mutateAsync(c.id)
      toast(r.ok ? `Test message sent to ${c.name}` : `Test failed: ${r.error ?? 'unknown error'}`, r.ok ? 'success' : 'error')
    } catch (e) { fail(e) }
  }

  return (
    <div className="space-y-5">
      <p className="text-body-sm text-[var(--text-secondary)]">
        {scope.project
          ? 'Post issue and sprint events of this project to Slack or Microsoft Teams. Instance-wide default channels (set by an administrator) also receive this project’s events.'
          : 'Default channels receive the chosen events of every project. Projects can add their own channels.'}
        {' '}Slash commands and interactive Slack apps are not supported; these are one-way incoming webhooks.
      </p>
      <div className="flex justify-end">
        <button type="button" className="veqsio-btn-primary flex items-center gap-1.5" onClick={() => setEditing('new')}><Plus className="w-4 h-4" aria-hidden="true" /> Add channel</button>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <p role="alert" className="text-[var(--error)]">{(q.error as Error).message}</p> : (
        <ul className="divide-y divide-[var(--surface-3)] rounded-lg border border-[var(--surface-3)]">
          {(q.data?.channels ?? []).map((c) => (
            <li key={c.id} className="space-y-1.5 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{TYPE_LABEL[c.type]}</span>
                <span className="font-mono text-caption text-[var(--text-tertiary)]">{c.url}</span>
                <label className="ml-auto flex items-center gap-1.5 text-caption">
                  <input type="checkbox" role="switch" checked={c.enabled} onChange={(e) => save.mutate({ id: c.id, enabled: e.target.checked }, { onError: fail })} />
                  Enabled
                </label>
              </div>
              {!c.enabled && c.consecutiveFailures > 0 && <p className="text-caption text-[var(--error)]">Switched off after {c.consecutiveFailures} failed deliveries. Check the URL, then enable it again.</p>}
              <p className="text-caption text-[var(--text-secondary)]">{c.events.map(labelOf).join(', ')}</p>
              <div className="flex flex-wrap gap-1">
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption" onClick={() => sendTest(c)} disabled={test.isPending}><Send className="w-3.5 h-3.5" aria-hidden="true" /> Send test message</button>
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption" onClick={() => setLogging(c)}><ListChecks className="w-3.5 h-3.5" aria-hidden="true" /> Deliveries</button>
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption" onClick={() => setEditing(c)}><Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Edit</button>
                <button type="button" className="veqsio-btn-ghost flex items-center gap-1 px-2 py-1 text-caption !text-[var(--error)]" onClick={async () => { if ((await confirmDialog(`Delete channel ${c.name}?`))) { try { await remove.mutateAsync(c.id) } catch (e) { fail(e) } } }}><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Delete</button>
              </div>
            </li>
          ))}
          {q.data?.channels.length === 0 && <li className="p-3 text-body-sm text-[var(--text-tertiary)]">No channels yet.</li>}
        </ul>
      )}
      {editing && (
        <Modal isOpen onClose={() => setEditing(null)} title={editing === 'new' ? 'Add channel' : `Edit ${editing.name}`} size="lg">
          <ChannelForm scope={scope} channel={editing === 'new' ? null : editing} events={events} onDone={() => setEditing(null)} />
        </Modal>
      )}
      {logging && <LogDialog scope={scope} channel={logging} onClose={() => setLogging(null)} />}
    </div>
  )
}
