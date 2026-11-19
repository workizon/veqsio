'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Plus, Trash2, Send, Loader2, Power, PowerOff } from 'lucide-react'
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

interface Webhook {
  id: number
  projectId: number | null
  url: string
  hasSecret?: boolean
  events: string[]
  active: boolean
  failureCount: number
  createdAt: string
}

async function fetchWebhooks(): Promise<Webhook[]> {
  const res = await axios.get('/rest/api/2/webhook')
  return res.data.webhooks
}

async function createWebhook(data: {
  url: string
  secret?: string
  events: string[]
}): Promise<void> {
  await axios.post('/rest/api/2/webhook', data)
}

async function deleteWebhook(id: number): Promise<void> {
  await axios.delete(`/rest/api/2/webhook/${id}`)
}

async function toggleWebhook(id: number, active: boolean): Promise<void> {
  await axios.put(`/rest/api/2/webhook/${id}`, { active })
}

async function testWebhook(id: number): Promise<{ success: boolean; error?: string }> {
  const res = await axios.post(`/rest/api/2/webhook/${id}/test`)
  return res.data
}

export function WebhookManager() {
  const queryClient = useQueryClient()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<string[]>([])

  const { data: webhooks, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: fetchWebhooks,
  })

  const createMutation = useMutation({
    mutationFn: createWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
      toast('Webhook created', 'success')
      closeModal()
    },
    onError: () => toast('Failed to create webhook', 'error'),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
      toast('Webhook deleted', 'success')
    },
    onError: () => toast('Failed to delete webhook', 'error'),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => toggleWebhook(id, active),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
    },
    onError: () => toast('Failed to toggle webhook', 'error'),
  })

  const testMutation = useMutation({
    mutationFn: testWebhook,
    onSuccess: (data) => {
      if (data.success) {
        toast('Webhook test successful', 'success')
      } else {
        toast(data.error || 'Webhook test failed', 'error')
      }
    },
    onError: () => toast('Webhook test failed', 'error'),
  })

  function closeModal() {
    setIsModalOpen(false)
    setUrl('')
    setSecret('')
    setSelectedEvents([])
  }

  function toggleEvent(eventKey: string) {
    setSelectedEvents((prev) =>
      prev.includes(eventKey) ? prev.filter((e) => e !== eventKey) : [...prev, eventKey]
    )
  }

  function handleCreate() {
    if (!url.trim() || selectedEvents.length === 0) return
    createMutation.mutate({
      url: url.trim(),
      secret: secret.trim() || undefined,
      events: selectedEvents,
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">Webhooks</h2>
        <button onClick={() => setIsModalOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add Webhook
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !webhooks?.length ? (
        <EmptyState
          icon="inbox"
          title="No webhooks configured yet"
          description="Add webhooks to receive real-time event notifications."
          action={
            <button onClick={() => setIsModalOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Add Webhook
            </button>
          }
        />
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="veqsio-table-header">
                  <th className="text-left px-4 py-2">URL</th>
                  <th className="text-left px-4 py-2">Events</th>
                  <th className="text-center px-4 py-2">Status</th>
                  <th className="text-right px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((wh) => (
                  <tr key={wh.id} className="veqsio-table-row">
                    <td className="px-4 py-3">
                      <div className="text-[var(--text-primary)] font-medium truncate max-w-xs">{wh.url}</div>
                      {wh.hasSecret && (
                        <div className="text-caption text-[var(--text-tertiary)]">Secret configured</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {wh.events.map((e) => (
                          <span key={e} className="veqsio-badge">
                            {EVENT_TYPES.find((et) => et.key === e)?.label || e}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {wh.active ? (
                        <span className="inline-flex items-center gap-1 text-[var(--success)] text-xs font-medium">
                          <Power className="w-3.5 h-3.5" />
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[var(--error)] text-xs font-medium">
                          <PowerOff className="w-3.5 h-3.5" />
                          Disabled
                          {wh.failureCount > 0 && ` (${wh.failureCount} failures)`}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => toggleMutation.mutate({ id: wh.id, active: !wh.active })}
                          className="veqsio-btn-ghost p-2"
                          title={wh.active ? 'Disable' : 'Enable'}
                        >
                          {wh.active ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => testMutation.mutate(wh.id)}
                          disabled={testMutation.isPending}
                          className="veqsio-btn-ghost p-2"
                          title="Test"
                        >
                          {testMutation.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Send className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={() => deleteMutation.mutate(wh.id)}
                          className="veqsio-btn-ghost p-2 text-[var(--error)]"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal isOpen={isModalOpen} onClose={closeModal} title="Add webhook" size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="veqsio-input w-full"
              placeholder="https://example.com/webhook"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Secret (optional)</label>
            <input
              type="text"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="veqsio-input w-full"
              placeholder="For HMAC-SHA256 signature"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Events</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {EVENT_TYPES.map((et) => (
                <label
                  key={et.key}
                  className="flex items-center gap-2 p-2 rounded-lg border border-[var(--surface-3)] hover:bg-[var(--surface-1)] cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(et.key)}
                    onChange={() => toggleEvent(et.key)}
                    className="w-4 h-4 accent-[var(--brand-500)]"
                  />
                  <span className="text-sm text-[var(--text-primary)]">{et.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={closeModal} className="veqsio-btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending || !url.trim() || selectedEvents.length === 0}
              className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Create
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
