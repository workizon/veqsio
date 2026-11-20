'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { ChevronDown, ChevronUp, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'

interface WebhookDelivery {
  id: number
  webhookId: number
  event: string
  payload: Record<string, any>
  responseStatus: number | null
  responseBody: string | null
  success: boolean
  durationMs: number | null
  createdAt: string
}

interface Webhook {
  id: number
  url: string
}

async function fetchWebhooks(): Promise<Webhook[]> {
  const res = await axios.get('/rest/api/2/webhook')
  return res.data.webhooks
}

async function fetchDeliveries(webhookId: number): Promise<WebhookDelivery[]> {
  const res = await axios.get(`/rest/api/2/webhook/${webhookId}/delivery`)
  return res.data.deliveries
}

export function WebhookLogs() {
  const { tr } = useI18n();

  const [selectedWebhookId, setSelectedWebhookId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const { data: webhooks, isLoading: webhooksLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: fetchWebhooks,
  })

  const { data: deliveries, isLoading: deliveriesLoading } = useQuery({
    queryKey: ['webhookDeliveries', selectedWebhookId],
    queryFn: () => fetchDeliveries(selectedWebhookId!),
    enabled: selectedWebhookId !== null,
  })

  if (webhooksLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }

  if (!webhooks?.length) {
    return (
      <EmptyState
        icon="inbox"
        title={tr('No webhooks configured yet')}
        description={tr('Configure a webhook first to see delivery logs.')}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
        <label className="text-sm font-medium text-[var(--text-secondary)]">{tr('Webhook:')}</label>
        <select
          value={selectedWebhookId ?? ''}
          onChange={(e) => setSelectedWebhookId(Number(e.target.value) || null)}
          className="veqsio-input"
        >
          <option value="">{tr('Select a webhook')}</option>
          {webhooks.map((wh) => (
            <option key={wh.id} value={wh.id}>
              {wh.url}
            </option>
          ))}
        </select>
      </div>

      {selectedWebhookId && deliveriesLoading && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {selectedWebhookId && deliveries && !deliveries.length && (
        <EmptyState
          icon="inbox"
          title={tr('No deliveries yet')}
          description={tr('Delivery logs will appear here once events are triggered.')}
        />
      )}

      {selectedWebhookId && deliveries && deliveries.length > 0 && (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="veqsio-table-header">
                  <th className="text-left px-4 py-2">{tr('Event')}</th>
                  <th className="text-center px-4 py-2">{tr('Status')}</th>
                  <th className="text-center px-4 py-2">{tr('Duration')}</th>
                  <th className="text-right px-4 py-2">{tr('Time')}</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <>
                    <tr
                      key={d.id}
                      className="veqsio-table-row cursor-pointer"
                      onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
                    >
                      <td className="px-4 py-3">
                        <span className="veqsio-badge">{d.event}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {d.success ? (
                          <span className="inline-flex items-center gap-1 text-[var(--success)]">
                            <CheckCircle2 className="w-4 h-4" />
                            <span className="text-xs font-medium">{d.responseStatus}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[var(--error)]">
                            <XCircle className="w-4 h-4" />
                            <span className="text-xs font-medium">{d.responseStatus || tr('Error')}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center text-[var(--text-secondary)]">
                        {d.durationMs ? `${d.durationMs}ms` : '-'}
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--text-secondary)]">
                        {new Date(d.createdAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-3">
                        {expandedId === d.id ? (
                          <ChevronUp className="w-4 h-4 text-[var(--text-tertiary)]" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-[var(--text-tertiary)]" />
                        )}
                      </td>
                    </tr>
                    {expandedId === d.id && (
                      <tr className="bg-[var(--surface-1)]">
                        <td colSpan={5} className="px-4 py-3">
                          <div className="space-y-3">
                            <div>
                              <div className="text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Payload')}</div>
                              <pre className="bg-[var(--surface-2)] p-3 rounded-md text-xs text-[var(--text-primary)] overflow-x-auto">
                                {JSON.stringify(d.payload, null, 2)}
                              </pre>
                            </div>
                            {d.responseBody && (
                              <div>
                                <div className="text-xs font-medium text-[var(--text-secondary)] mb-1">{tr('Response')}</div>
                                <pre className="bg-[var(--surface-2)] p-3 rounded-md text-xs text-[var(--text-primary)] overflow-x-auto">
                                  {d.responseBody.length > 500 ? d.responseBody.slice(0, 500) + '...' : d.responseBody}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
