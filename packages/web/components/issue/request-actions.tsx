'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitMerge, Link2, Mail } from 'lucide-react'
import { Modal } from '@/components/modal'
import { toast } from '@/components/toast'
import { useLinkTypes } from '@/hooks/use-issues'
import { useDeskRequestSearch, useLinkRequest, useMergeRequest } from '@/hooks/use-servicedesk-comms'
import { describeMerge, linkOptions, mergeCandidates, parseRequestKey } from '@/lib/servicedesk-comms'

export interface RequestMeta {
  deskId?: number
  channel?: string
  customer?: { id: number; displayName: string | null; email: string } | null
}

const CHANNEL: Record<string, string> = { portal: 'Portal', email: 'Email', agent: 'Raised by an agent', api: 'API' }

/** Customer panel of a service request in the agent's issue view, with the Merge and Link actions. */
export function RequestActions({ issueKey, meta }: { issueKey: string; meta: RequestMeta }) {
  const { tr } = useI18n();

  const [dialog, setDialog] = useState<'merge' | 'link' | null>(null)
  if (!meta.deskId) return null
  return (
    <>
      <div className="space-y-2 py-1">
        {meta.customer && (
          <div className="text-body-sm">
            <p className="font-medium text-[var(--text-primary)]">{meta.customer.displayName || meta.customer.email}</p>
            <p className="flex items-center gap-1.5 text-[var(--text-secondary)] break-all"><Mail aria-hidden className="w-3.5 h-3.5 shrink-0" />{meta.customer.email}</p>
          </div>
        )}
        {meta.channel && <p className="text-caption text-[var(--text-tertiary)]">{tr('Channel:')} {CHANNEL[meta.channel] ? tr(CHANNEL[meta.channel]) : meta.channel}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className="veqsio-btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-body-sm" onClick={() => setDialog('merge')}>
            <GitMerge aria-hidden className="w-4 h-4" />{tr('Merge into…')} </button>
          <button type="button" className="veqsio-btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-body-sm" onClick={() => setDialog('link')}>
            <Link2 aria-hidden className="w-4 h-4" />{tr('Link request')} </button>
        </div>
      </div>
      {dialog === 'merge' && <MergeDialog deskId={meta.deskId} issueKey={issueKey} onClose={() => setDialog(null)} />}
      {dialog === 'link' && <LinkDialog deskId={meta.deskId} issueKey={issueKey} onClose={() => setDialog(null)} />}
    </>
  )
}

/** Search box + result list for a request of the same desk. Returns the chosen key through onPick. */
function TargetPicker({ deskId, issueKey, value, onPick }: { deskId: number; issueKey: string; value: string | null; onPick: (key: string | null) => void }) {
  const { tr } = useI18n();

  const [term, setTerm] = useState('')
  const typedKey = parseRequestKey(term)
  const search = useDeskRequestSearch(deskId, term, true)
  const all = search.data?.values ?? []
  const shown = mergeCandidates(all, issueKey, term)
  return (
    <div className="space-y-2">
      <label htmlFor="target-search" className="block text-body-sm font-medium">{tr('Request in this service desk')}</label>
      <input id="target-search" className="veqsio-input w-full" placeholder={tr('Search by key or summary')} autoComplete="off" value={term}
        onChange={(e) => { setTerm(e.target.value); onPick(null) }} />
      <ul role="listbox" aria-label={tr('Matching requests')} className="max-h-48 overflow-y-auto rounded-lg border border-[var(--surface-3)] divide-y divide-[var(--surface-3)]">
        {search.isLoading && <li className="px-3 py-2 text-sm text-[var(--text-tertiary)]">{tr('Searching…')}</li>}
        {!search.isLoading && shown.length === 0 && (
          <li className="px-3 py-2 text-sm text-[var(--text-tertiary)]">
            {tr('No open request matches.')}{typedKey && typedKey !== issueKey ? ' ' : ''}
            {typedKey && typedKey !== issueKey && <button type="button" className="text-[var(--brand-500)] hover:underline" onClick={() => onPick(typedKey)}>{tr('Use')} {typedKey}</button>}
          </li>
        )}
        {shown.map((r) => (
          <li key={r.key} role="option" aria-selected={value === r.key}>
            <button type="button" onClick={() => onPick(r.key)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none ${value === r.key ? 'bg-[var(--surface-2)] font-medium' : ''}`}>
              <span className="font-mono text-[var(--brand-600)]">{r.key}</span> <span>{r.summary}</span>
            </button>
          </li>
        ))}
      </ul>
      {value && <p role="status" className="text-body-sm">{tr('Selected:')} <strong>{value}</strong></p>}
    </div>
  )
}

function MergeDialog({ deskId, issueKey, onClose }: { deskId: number; issueKey: string; onClose: () => void }) {
  const { tr } = useI18n();

  const router = useRouter()
  const merge = useMergeRequest(deskId, issueKey)
  const [target, setTarget] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)

  const run = () => {
    if (!target) return
    merge.mutate({ targetKey: target, note: note.trim() || undefined }, {
      onSuccess: (r) => { toast(describeMerge(r), 'success'); onClose(); router.push(`/issues/${r.target}`) },
      onError: () => setConfirm(false),
    })
  }

  return (
    <Modal isOpen onClose={onClose} title={`Merge ${issueKey} into another request`}>
      <div className="space-y-4">
        <p className="text-body-sm text-[var(--text-secondary)]">
          {tr('Comments, attachments and participants of')} {issueKey} {tr('move to the request you pick.')} {issueKey} {tr('is linked as a duplicate, closed with the resolution Duplicate, and the customer is told by email.')} </p>
        <TargetPicker deskId={deskId} issueKey={issueKey} value={target} onPick={(k) => { setTarget(k); setConfirm(false) }} />
        <div className="space-y-1">
          <label htmlFor="merge-note" className="block text-body-sm font-medium">{tr('Internal note (optional)')}</label>
          <textarea id="merge-note" rows={2} maxLength={2000} className="veqsio-input w-full" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {merge.error && <p role="alert" className="text-body-sm text-[var(--error)]">{merge.error.message}</p>}
        {confirm && target && (
          <p role="alert" className="rounded-lg border border-[var(--warning)] px-3 py-2 text-body-sm">
            {tr('This cannot be undone. Merge')} {issueKey} {tr('into')} <strong>{target}</strong>?
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-secondary" onClick={onClose} disabled={merge.isPending}>{tr('Cancel')}</button>
          {!confirm ? (
            <button type="button" className="veqsio-btn-primary" disabled={!target} onClick={() => setConfirm(true)}>{tr('Merge…')}</button>
          ) : (
            <button type="button" className="veqsio-btn-primary" disabled={merge.isPending} onClick={run}>{merge.isPending ? tr('Merging…') : tr('Merge into {target}', { target })}</button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function LinkDialog({ deskId, issueKey, onClose }: { deskId: number; issueKey: string; onClose: () => void }) {
  const { tr } = useI18n();

  const link = useLinkRequest(deskId, issueKey)
  const types = useLinkTypes()
  const options = linkOptions(types.data?.issueLinkTypes ?? [])
  const [target, setTarget] = useState<string | null>(null)
  const [kind, setKind] = useState('')
  const chosen = options.find((o) => o.value === (kind || options[0]?.value))

  const run = () => {
    if (!target || !chosen) return
    link.mutate({ targetKey: target, linkTypeId: chosen.linkTypeId, direction: chosen.direction }, {
      onSuccess: () => { toast(tr('{key} {label} {target}', { key: issueKey, label: chosen.label, target }), 'success'); onClose() },
    })
  }

  return (
    <Modal isOpen onClose={onClose} title={`Link ${issueKey}`}>
      <div className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="link-kind" className="block text-body-sm font-medium">{issueKey} …</label>
          <select id="link-kind" className="veqsio-input w-full" value={kind || options[0]?.value || ''} onChange={(e) => setKind(e.target.value)} disabled={options.length === 0}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <TargetPicker deskId={deskId} issueKey={issueKey} value={target} onPick={setTarget} />
        {link.error && <p role="alert" className="text-body-sm text-[var(--error)]">{link.error.message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="veqsio-btn-secondary" onClick={onClose} disabled={link.isPending}>{tr('Cancel')}</button>
          <button type="button" className="veqsio-btn-primary" disabled={!target || !chosen || link.isPending} onClick={run}>{link.isPending ? tr('Linking…') : tr('Link')}</button>
        </div>
      </div>
    </Modal>
  )
}
