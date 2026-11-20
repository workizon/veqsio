'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Plus, Trash2, Save, Loader2 } from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'

const EVENT_TYPES = [
  { key: 'issue.created', label: 'Issue Created' },
  { key: 'issue.updated', label: 'Issue Updated' },
  { key: 'issue.deleted', label: 'Issue Deleted' },
  { key: 'comment.added', label: 'Comment Added' },
  { key: 'issue.transitioned', label: 'Issue Transitioned' },
  { key: 'sprint.started', label: 'Sprint Started' },
  { key: 'sprint.closed', label: 'Sprint Closed' },
] as const

const RECIPIENT_TYPES = [
  { key: 'notifyAssignee', label: 'Assignee' },
  { key: 'notifyReporter', label: 'Reporter' },
  { key: 'notifyWatchers', label: 'Watchers' },
  { key: 'notifyProjectLead', label: 'Project Lead' },
  { key: 'notifyAllAdmins', label: 'All Admins' },
  { key: 'notifyCurrentUser', label: 'Current User' },
] as const

interface NotificationSchemeEvent {
  id: number
  schemeId: number
  eventType: string
  notifyAssignee: boolean
  notifyReporter: boolean
  notifyWatchers: boolean
  notifyProjectLead: boolean
  notifyAllAdmins: boolean
  notifyCurrentUser: boolean
}

interface NotificationScheme {
  id: number
  name: string
  description: string | null
  projectId: number | null
  isDefault: boolean
  events?: NotificationSchemeEvent[]
}

async function fetchSchemes(): Promise<NotificationScheme[]> {
  const res = await axios.get('/rest/api/2/notification')
  return res.data.schemes
}

async function createScheme(data: {
  name: string
  description?: string
  projectId?: number
  isDefault?: boolean
  events: Array<{
    eventType: string
    notifyAssignee: boolean
    notifyReporter: boolean
    notifyWatchers: boolean
    notifyProjectLead: boolean
    notifyAllAdmins: boolean
    notifyCurrentUser: boolean
  }>
}): Promise<void> {
  await axios.post('/rest/api/2/notification', data)
}

async function updateScheme(
  id: number,
  data: {
    name: string
    description?: string
    projectId?: number
    isDefault?: boolean
    events: Array<{
      eventType: string
      notifyAssignee: boolean
      notifyReporter: boolean
      notifyWatchers: boolean
      notifyProjectLead: boolean
      notifyAllAdmins: boolean
      notifyCurrentUser: boolean
    }>
  }
): Promise<void> {
  await axios.put(`/rest/api/2/notification/${id}`, data)
}

async function deleteScheme(id: number): Promise<void> {
  await axios.delete(`/rest/api/2/notification/${id}`)
}

function defaultEvents(): NotificationSchemeEvent[] {
  return EVENT_TYPES.map((et) => ({
    id: 0,
    schemeId: 0,
    eventType: et.key,
    notifyAssignee: false,
    notifyReporter: false,
    notifyWatchers: false,
    notifyProjectLead: false,
    notifyAllAdmins: false,
    notifyCurrentUser: false,
  }))
}

export function NotificationSchemeEditor() {
  const { tr } = useI18n();

  const queryClient = useQueryClient()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingScheme, setEditingScheme] = useState<NotificationScheme | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [events, setEvents] = useState<NotificationSchemeEvent[]>(defaultEvents)

  const { data: schemes, isLoading } = useQuery({
    queryKey: ['notificationSchemes'],
    queryFn: fetchSchemes,
  })

  const createMutation = useMutation({
    mutationFn: createScheme,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notificationSchemes'] })
      toast(tr('Notification scheme created'), 'success')
      closeModal()
    },
    onError: () => toast(tr('Failed to create scheme'), 'error'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateScheme>[1] }) => updateScheme(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notificationSchemes'] })
      toast(tr('Notification scheme updated'), 'success')
      closeModal()
    },
    onError: () => toast(tr('Failed to update scheme'), 'error'),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteScheme,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notificationSchemes'] })
      toast(tr('Notification scheme deleted'), 'success')
    },
    onError: () => toast(tr('Failed to delete scheme'), 'error'),
  })

  function openModal(scheme?: NotificationScheme) {
    if (scheme) {
      setEditingScheme(scheme)
      setName(scheme.name)
      setDescription(scheme.description || '')
      setEvents(scheme.events?.length ? scheme.events : defaultEvents())
    } else {
      setEditingScheme(null)
      setName('')
      setDescription('')
      setEvents(defaultEvents())
    }
    setIsModalOpen(true)
  }

  function closeModal() {
    setIsModalOpen(false)
    setEditingScheme(null)
  }

  function toggleEventField(eventType: string, field: keyof NotificationSchemeEvent) {
    setEvents((prev) =>
      prev.map((e) => (e.eventType === eventType ? { ...e, [field]: !e[field] } : e))
    )
  }

  function handleSave() {
    const payload = {
      name,
      description,
      events: events.map((e) => ({
        eventType: e.eventType,
        notifyAssignee: e.notifyAssignee,
        notifyReporter: e.notifyReporter,
        notifyWatchers: e.notifyWatchers,
        notifyProjectLead: e.notifyProjectLead,
        notifyAllAdmins: e.notifyAllAdmins,
        notifyCurrentUser: e.notifyCurrentUser,
      })),
    }
    if (editingScheme) {
      updateMutation.mutate({ id: editingScheme.id, data: payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Notification schemes')}</h2>
        <button onClick={() => openModal()} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          {tr('Add Scheme')} </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !schemes?.length ? (
        <EmptyState
          icon="inbox"
          title={tr('No notification schemes yet')}
          description={tr('Create a scheme to define who gets notified about project events.')}
          action={
            <button onClick={() => openModal()} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('Add Scheme')} </button>
          }
        />
      ) : (
        <div className="space-y-4">
          {schemes.map((scheme) => (
            <div key={scheme.id} className="veqsio-card">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-body font-medium text-[var(--text-primary)]">{scheme.name}</h3>
                  {scheme.description && (
                    <p className="text-caption text-[var(--text-tertiary)]">{scheme.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openModal(scheme)}
                    className="veqsio-btn-ghost p-2"
                    title={tr('Edit')}
                  >
                    <Save className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => deleteMutation.mutate(scheme.id)}
                    className="veqsio-btn-ghost p-2 text-[var(--error)]"
                    title={tr('Delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={isModalOpen} onClose={closeModal} title={editingScheme ? tr('Edit Scheme') : tr('New Scheme')} size="lg">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="veqsio-input w-full"
              placeholder={tr('Scheme name')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Description')}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="veqsio-input w-full"
              placeholder={tr('Optional description')}
            />
          </div>

          <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="veqsio-table-header">
                    <th className="text-left px-4 py-2">{tr('Event')}</th>
                    {RECIPIENT_TYPES.map((rt) => (
                      <th key={rt.key} className="text-center px-2 py-2">
                        {tr(rt.label)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {events.map((evt) => (
                    <tr key={evt.eventType} className="border-b border-[var(--surface-3)]">
                      <td className="px-4 py-2 text-[var(--text-primary)]">
                        {(() => { const l = EVENT_TYPES.find((e) => e.key === evt.eventType)?.label; return l ? tr(l) : evt.eventType })()}
                      </td>
                      {RECIPIENT_TYPES.map((rt) => (
                        <td key={rt.key} className="text-center px-2 py-2">
                          <input
                            type="checkbox"
                            checked={!!evt[rt.key as keyof NotificationSchemeEvent]}
                            onChange={() => toggleEventField(evt.eventType, rt.key as keyof NotificationSchemeEvent)}
                            className="w-4 h-4 accent-[var(--brand-500)]"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={closeModal} className="veqsio-btn-secondary">
              {tr('Cancel')} </button>
            <button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending || !name.trim()}
              className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              {tr('Save')} </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
