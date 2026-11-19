'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Copy, Trash2, Network, Pencil } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Modal } from '@/components/modal'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { toast } from '@/components/toast'
import { ConfirmDialog } from '@/components/workflow/designer'
import { useAdminWorkflows, useWorkflowMutations, type WorkflowSummary } from '@/hooks/use-workflow-designer'
import { SortableTh } from '@/components/sortable-th'
import { useMultiSort } from '@/lib/table-sort'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

export default function AdminWorkflowsPage() {
  const ms = useMultiSort()
  const router = useRouter()
  const { data, isLoading, error } = useAdminWorkflows()
  const m = useWorkflowMutations()
  const [createOpen, setCreateOpen] = useState(false)
  const [cloneFrom, setCloneFrom] = useState<WorkflowSummary | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void } | null>(null)

  const workflows = data?.workflows ?? []

  function askDelete(w: WorkflowSummary) {
    setConfirm({
      title: 'Delete workflow?',
      message: `“${w.name}” and its ${w.transitionCount} transition${w.transitionCount === 1 ? '' : 's'} will be deleted. This cannot be undone.`,
      confirmLabel: 'Delete workflow',
      danger: true,
      onConfirm: async () => {
        try { await m.deleteWorkflow.mutateAsync(w.id); toast('Workflow deleted', 'success') } catch (e) { toast(errMsg(e), 'error') }
      },
    })
  }

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader title="Workflows" description={<>Design statuses and transitions visually. Assign workflows to projects through <Link href="/admin" className="text-[var(--brand-600)] hover:underline">workflow schemes</Link>.</>}
          actions={<><button className="veqsio-btn-primary flex items-center gap-2" onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> Create workflow</button></>} />

        {isLoading && <div className="flex justify-center py-12"><Spinner /></div>}
        {error && <p role="alert" className="text-[var(--error)]">{errMsg(error)}</p>}
        {data && workflows.length === 0 && (
          <EmptyState icon="folder" title="No workflows yet" description="Create a workflow to define how issues move between statuses." action={<button className="veqsio-btn-primary" onClick={() => setCreateOpen(true)}>Create workflow</button>} />
        )}

        {workflows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-[var(--surface-3)] bg-[var(--surface-0)]">
            <table className="w-full text-sm">
              <caption className="sr-only">Workflows</caption>
              <thead>
                <tr className="veqsio-table-header text-left">
                  <SortableTh {...ms.th('name')} className="px-4 py-2.5">Name</SortableTh>
                  <SortableTh {...ms.th('transitions')} className="px-4 py-2.5">Transitions</SortableTh>
                  <th scope="col" className="px-4 py-2.5">Used by</th>
                  <th scope="col" className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {ms.sort(workflows, { name: (w) => w.name, transitions: (w) => w.transitionCount }).map((w) => (
                  <tr key={w.id} className="veqsio-table-row align-top">
                    <th scope="row" className="px-4 py-3 text-left">
                      <Link href={`/admin/workflows/${w.id}`} className="font-medium text-[var(--text-primary)] hover:text-[var(--brand-600)] inline-flex items-center gap-2">
                        <Network className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden /> {w.name}
                      </Link>
                      {w.isDefault && <span className="veqsio-badge ml-2">Default</span>}
                      {w.description && <p className="text-xs font-normal text-[var(--text-tertiary)] mt-0.5">{w.description}</p>}
                    </th>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{w.transitionCount}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {w.schemes.length === 0 && w.projects.length === 0 ? (
                        <span className="text-[var(--text-tertiary)]">{w.isDefault ? 'Projects without a scheme' : 'Not in use'}</span>
                      ) : (
                        <>
                          {w.schemes.length > 0 && <div>Schemes: {w.schemes.map((s) => s.name).join(', ')}</div>}
                          {w.projects.length > 0 && <div className="text-xs text-[var(--text-tertiary)]">Projects: {w.projects.map((p) => p.key).join(', ')}</div>}
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      <Link href={`/admin/workflows/${w.id}`} className="veqsio-btn-ghost p-1.5 inline-flex" aria-label={`Open designer for ${w.name}`}><Pencil className="w-4 h-4" /></Link>
                      <button className="veqsio-btn-ghost p-1.5" onClick={() => setCloneFrom(w)} aria-label={`Clone ${w.name}`}><Copy className="w-4 h-4" /></button>
                      <button className="veqsio-btn-ghost p-1.5 text-[var(--error)]" onClick={() => askDelete(w)} aria-label={`Delete ${w.name}`}><Trash2 className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateModal
        open={createOpen || cloneFrom !== null}
        onClose={() => { setCreateOpen(false); setCloneFrom(null) }}
        workflows={workflows}
        initialClone={cloneFrom?.id}
        initialName={cloneFrom ? `${cloneFrom.name} (copy)` : ''}
        pending={m.createWorkflow.isPending}
        onCreate={async (d) => {
          try {
            const r = await m.createWorkflow.mutateAsync(d)
            toast(d.cloneFromId ? 'Workflow cloned' : 'Workflow created', 'success')
            setCreateOpen(false); setCloneFrom(null)
            router.push(`/admin/workflows/${r.id}`)
          } catch (e) { toast(errMsg(e), 'error') }
        }}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </AppLayout>
  )
}

function CreateModal({ open, onClose, workflows, initialClone, initialName, pending, onCreate }: {
  open: boolean; onClose: () => void; workflows: WorkflowSummary[]
  initialClone?: number; initialName: string; pending: boolean
  onCreate: (d: { name: string; description?: string; cloneFromId?: number }) => Promise<void>
}) {
  return (
    <Modal isOpen={open} onClose={onClose} title={initialClone ? 'Clone workflow' : 'Create workflow'}>
      {/* remount per opening so the fields start from the right defaults */}
      <CreateForm key={`${initialClone ?? 'new'}`} workflows={workflows} initialClone={initialClone} initialName={initialName} pending={pending} onCreate={onCreate} onCancel={onClose} />
    </Modal>
  )
}

function CreateForm({ workflows, initialClone, initialName, pending, onCreate, onCancel }: {
  workflows: WorkflowSummary[]; initialClone?: number; initialName: string; pending: boolean
  onCreate: (d: { name: string; description?: string; cloneFromId?: number }) => Promise<void>; onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState('')
  const [clone, setClone] = useState<string>(initialClone ? String(initialClone) : '')
  const nameId = useId(), descId = useId(), cloneId = useId()
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), description: description.trim() || undefined, cloneFromId: clone ? Number(clone) : undefined }) }}>
      <div>
        <label htmlFor={nameId} className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
        <input id={nameId} className="veqsio-input w-full" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>
      <div>
        <label htmlFor={descId} className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Description <span className="font-normal text-[var(--text-tertiary)]">(optional)</span></label>
        <textarea id={descId} className="veqsio-input w-full min-h-[64px]" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <label htmlFor={cloneId} className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Start from</label>
        <select id={cloneId} className="veqsio-input w-full" value={clone} onChange={(e) => setClone(e.target.value)}>
          <option value="">Blank workflow</option>
          {workflows.map((w) => <option key={w.id} value={w.id}>Copy of “{w.name}”</option>)}
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="veqsio-btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="veqsio-btn-primary" disabled={!name.trim() || pending}>{pending ? 'Creating…' : initialClone || clone ? 'Clone' : 'Create'}</button>
      </div>
    </form>
  )
}
