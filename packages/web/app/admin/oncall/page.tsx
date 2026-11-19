'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Breadcrumb } from '@/components/breadcrumb'
import { Spinner } from '@/components/spinner'
import { toast } from '@/components/toast'
import { useUsers } from '@/hooks/use-users'
import { confirmDialog } from '@/components/dialogs'

interface Person { id: number; displayName: string }
interface Schedule {
  id: number; name: string; description: string | null; rotationHours: number; startAt: string
  escalationMinutes: number | null; escalationScheduleId: number | null
  members: Person[]; onCall: (Person & { override: boolean }) | null
  overrides: { id: number; user: Person; startsAt: string; endsAt: string }[]
}
interface Alert { id: number; title: string; severity: string; status: string; count: number; lastSeenAt: string; description: string | null }
interface Shift { user: Person; from: string; to: string; override: boolean }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errorMessages?.[0] ?? res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}

const B = '/rest/api/2/oncall/schedule'
const fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
/** <input type="datetime-local"> value for a Date, in local time */
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

function Editor({ schedule, others, onDone }: { schedule: Schedule | null; others: Schedule[]; onDone: () => void }) {
  const users = useUsers().data ?? []
  const [name, setName] = useState(schedule?.name ?? '')
  const [hours, setHours] = useState(schedule?.rotationHours ?? 168)
  const [start, setStart] = useState(local(schedule ? new Date(schedule.startAt) : new Date()))
  const [members, setMembers] = useState<number[]>(schedule?.members.map((m) => m.id) ?? [])
  const [escMin, setEscMin] = useState<number | ''>(schedule?.escalationMinutes ?? '')
  const [escSched, setEscSched] = useState<number | ''>(schedule?.escalationScheduleId ?? '')
  const move = (i: number, d: number) => setMembers((m) => { const n = [...m]; const j = i + d; if (j < 0 || j >= n.length) return m; [n[i], n[j]] = [n[j], n[i]]; return n })
  const save = useMutation({
    mutationFn: () => api(schedule ? `${B}/${schedule.id}` : B, { method: schedule ? 'PUT' : 'POST', body: JSON.stringify({ name, rotationHours: hours, startAt: new Date(start).toISOString(), memberIds: members, escalationMinutes: escMin === '' ? null : escMin, escalationScheduleId: escMin === '' || escSched === '' ? null : escSched }) }),
    onSuccess: () => { toast('Schedule saved', 'success'); onDone() },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <div className="veqsio-card p-4 space-y-4">
      <input className="veqsio-input w-full" placeholder="Schedule name" aria-label="Schedule name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex flex-wrap gap-4">
        <label className="text-sm">Shift length (hours)
          <input type="number" min={1} max={2160} className="veqsio-input block mt-1 w-32" value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
        <label className="text-sm">First shift starts
          <input type="datetime-local" className="veqsio-input block mt-1" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
      </div>
      <div>
        <p className="text-sm font-medium mb-1">Rotation order</p>
        <ol className="space-y-1">
          {members.map((id, i) => (
            <li key={id} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-[var(--text-tertiary)]">{i + 1}.</span>
              <span className="flex-1">{users.find((u) => u.id === id)?.displayName ?? `User ${id}`}</span>
              <button type="button" className="veqsio-btn-ghost" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" className="veqsio-btn-ghost" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === members.length - 1}>↓</button>
              <button type="button" className="veqsio-btn-ghost" onClick={() => setMembers(members.filter((m) => m !== id))}>Remove</button>
            </li>
          ))}
        </ol>
        <select className="veqsio-input mt-2" aria-label="Add person" value="" onChange={(e) => e.target.value && setMembers([...members, Number(e.target.value)])}>
          <option value="">Add a person…</option>
          {users.filter((u) => !members.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
        </select>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Escalation</legend>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">If nobody acknowledges within (minutes)
            <input type="number" min={1} max={1440} className="veqsio-input block mt-1 w-32" placeholder="Never" value={escMin} onChange={(e) => setEscMin(e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
          <label className="text-sm">Also notify
            <select className="veqsio-input block mt-1" disabled={escMin === ''} value={escSched} onChange={(e) => setEscSched(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">Next person in this rotation</option>
              {others.filter((o) => o.id !== schedule?.id).map((o) => <option key={o.id} value={o.id}>Whoever is on call in {o.name}</option>)}
            </select>
          </label>
        </div>
      </fieldset>
      <div className="flex gap-2">
        <button className="veqsio-btn-primary" disabled={!name.trim() || hours < 1 || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button className="veqsio-btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

function Alerts({ scheduleId }: { scheduleId: number }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['oncall-alerts', scheduleId], refetchInterval: 15000, queryFn: () => api<{ alerts: Alert[] }>(`/rest/api/2/oncall/alert?status=active&scheduleId=${scheduleId}`).then((r) => r.alerts) })
  const [key, setKey] = useState<string | null>(null)
  const act = useMutation({
    mutationFn: (v: { id: number; action: 'acknowledge' | 'close' | 'snooze' }) => api(`/rest/api/2/oncall/alert/${v.id}/${v.action}`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['oncall-alerts', scheduleId] }),
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const mint = useMutation({
    mutationFn: () => api<{ key: string }>(`/rest/api/2/oncall/schedule/${scheduleId}/key`, { method: 'POST' }),
    onSuccess: (r) => setKey(r.key),
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <div>
      <h3 className="text-sm font-medium mb-1">Open alerts</h3>
      {q.isLoading ? <Spinner /> : (
        <ul className="text-sm divide-y divide-[var(--surface-3)] mb-2">
          {(q.data ?? []).map((a) => (
            <li key={a.id} className="py-1.5 flex items-center gap-3">
              <span className="uppercase text-xs w-16 font-semibold">{a.severity}</span>
              <span className="flex-1 min-w-0 truncate" title={a.description ?? undefined}>{a.title}{a.count > 1 ? ` ×${a.count}` : ''}</span>
              <span className="text-xs text-[var(--text-tertiary)]">{a.status}</span>
              {a.status === 'open' && <button className="veqsio-btn-ghost" onClick={() => act.mutate({ id: a.id, action: 'acknowledge' })}>Acknowledge</button>}
              <button className="veqsio-btn-ghost" onClick={() => act.mutate({ id: a.id, action: 'close' })}>Close</button>
            </li>
          ))}
          {!q.data?.length && <li className="py-1 text-[var(--text-tertiary)]">No open alerts.</li>}
        </ul>
      )}
      <button className="veqsio-btn-secondary" disabled={mint.isPending} onClick={async () => { if ((await confirmDialog('Create a new integration key? The previous key stops working.'))) mint.mutate() }}>New alert integration key</button>
      {key && (
        <div className="mt-2 text-sm veqsio-card p-3" role="status">
          <p>Copy it now, it is shown once. Send alerts as JSON with the header <code>x-veqsio-alert-key</code>:</p>
          <pre className="mt-1 overflow-x-auto text-xs">{`curl -X POST ${typeof window !== 'undefined' ? window.location.origin : ''}/rest/api/2/oncall/alert \\\n  -H 'x-veqsio-alert-key: ${key}' -H 'Content-Type: application/json' \\\n  -d '{"title":"Disk full","severity":"critical","dedupKey":"disk-db1"}'`}</pre>
        </div>
      )}
    </div>
  )
}

function Details({ s, refresh }: { s: Schedule; refresh: () => void }) {
  const users = useUsers().data ?? []
  const shifts = useQuery({ queryKey: ['oncall-shifts', s.id, s.overrides.length, s.rotationHours, s.members.length], queryFn: () => api<{ shifts: Shift[] }>(`${B}/${s.id}/shifts`).then((r) => r.shifts) })
  const [who, setWho] = useState('')
  const [from, setFrom] = useState(local(new Date()))
  const [to, setTo] = useState(local(new Date(Date.now() + 86_400_000)))
  const add = useMutation({
    mutationFn: () => api(`${B}/${s.id}/override`, { method: 'POST', body: JSON.stringify({ userId: Number(who), startsAt: new Date(from).toISOString(), endsAt: new Date(to).toISOString() }) }),
    onSuccess: () => { toast('Override added', 'success'); refresh() },
    onError: (e: Error) => toast(e.message, 'error'),
  })
  const del = useMutation({
    mutationFn: (id: number) => api(`${B}/${s.id}/override/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <div className="mt-3 space-y-4">
      <Alerts scheduleId={s.id} />
      <div>
        <h3 className="text-sm font-medium mb-1">Next shifts (30 days)</h3>
        {shifts.isLoading ? <Spinner /> : (
          <ul className="text-sm divide-y divide-[var(--surface-3)]">
            {(shifts.data ?? []).slice(0, 20).map((x, i) => (
              <li key={i} className="py-1 flex gap-3"><span className="w-40">{x.user.displayName}{x.override ? ' (override)' : ''}</span><span className="text-[var(--text-secondary)]">{fmt(x.from)} – {fmt(x.to)}</span></li>
            ))}
            {!shifts.data?.length && <li className="py-1 text-[var(--text-tertiary)]">Nobody is scheduled. Add people and a start time.</li>}
          </ul>
        )}
      </div>
      <div>
        <h3 className="text-sm font-medium mb-1">Overrides</h3>
        <ul className="text-sm space-y-1 mb-2">
          {s.overrides.map((o) => (
            <li key={o.id} className="flex items-center gap-3"><span className="w-40">{o.user.displayName}</span><span className="flex-1 text-[var(--text-secondary)]">{fmt(o.startsAt)} – {fmt(o.endsAt)}</span><button className="veqsio-btn-ghost" onClick={() => del.mutate(o.id)}>Remove</button></li>
          ))}
          {!s.overrides.length && <li className="text-[var(--text-tertiary)]">No upcoming overrides.</li>}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <select className="veqsio-input" aria-label="Override person" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Cover by…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
          <input type="datetime-local" className="veqsio-input" aria-label="Override from" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="datetime-local" className="veqsio-input" aria-label="Override until" value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="veqsio-btn-secondary" disabled={!who || add.isPending} onClick={() => add.mutate()}>Add override</button>
        </div>
      </div>
    </div>
  )
}

export default function OnCallPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['oncall'], queryFn: () => api<{ schedules: Schedule[] }>(B).then((r) => r.schedules) })
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['oncall'] }); qc.invalidateQueries({ queryKey: ['oncall-shifts'] }); setEditing(null) }
  const remove = useMutation({
    mutationFn: (id: number) => api(`${B}/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e: Error) => toast(e.message, 'error'),
  })
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader breadcrumb={[{ label: 'Administration', href: '/admin' }, { label: 'On-call schedules' }]} title="On-call schedules" actions={<>{!editing && <button className="veqsio-btn-primary" onClick={() => setEditing('new')}>New schedule</button>}</>} />
        <p className="text-sm text-[var(--text-secondary)]">People take turns in shifts of a fixed length. An override puts someone else on call for a time window, for example during leave.</p>
        {editing && <Editor schedule={editing === 'new' ? null : editing} others={list.data ?? []} onDone={refresh} />}
        {list.isLoading ? <Spinner /> : list.error ? <p role="alert" className="text-sm text-[var(--error)]">{(list.error as Error).message}</p> : (
          <ul className="space-y-3">
            {(list.data ?? []).map((s) => (
              <li key={s.id} className="veqsio-card p-4">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-sm text-[var(--text-secondary)]">On call now: {s.onCall ? `${s.onCall.displayName}${s.onCall.override ? ' (override)' : ''}` : 'nobody'} · {s.members.length} people · {s.rotationHours} h shifts{s.escalationMinutes ? ` · escalates after ${s.escalationMinutes} min` : ''}</p>
                  </div>
                  <button className="veqsio-btn-ghost" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide' : 'Details'}</button>
                  <button className="veqsio-btn-ghost" onClick={() => setEditing(s)}>Edit</button>
                  <button className="veqsio-btn-ghost" onClick={async () => { if ((await confirmDialog(`Delete schedule "${s.name}"?`))) remove.mutate(s.id) }}>Delete</button>
                </div>
                {open === s.id && <Details s={s} refresh={refresh} />}
              </li>
            ))}
            {!list.data?.length && !editing && <li className="text-sm text-[var(--text-tertiary)]">No schedules yet.</li>}
          </ul>
        )}
      </div>
    </AppLayout>
  )
}
