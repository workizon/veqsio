'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { Search, Filter, ClipboardList } from 'lucide-react'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import { useAuditLog } from '@/hooks/use-admin'

export function AuditLog() {
  const { tr } = useI18n();

  const [userFilter, setUserFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const { data, isLoading } = useAuditLog({
    user: userFilter || undefined,
    action: actionFilter || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
  })

  const logs = data?.logs || []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Audit log')}</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type="text"
            placeholder={tr('Filter by user...')}
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="veqsio-input w-full pl-9"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
          <input
            type="text"
            placeholder={tr('Filter by action...')}
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="veqsio-input w-full pl-9"
          />
        </div>
        <div>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="veqsio-input w-full"
          />
        </div>
        <div>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="veqsio-input w-full"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : logs.length === 0 ? (
        <EmptyState
          icon="folder"
          title={tr('No audit log entries')}
          description={tr('System events will appear here once they occur.')}
        />
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="veqsio-table-header">
                <th className="text-left">{tr('Timestamp')}</th>
                <th className="text-left">{tr('User')}</th>
                <th className="text-left">{tr('Action')}</th>
                <th className="text-left">{tr('Entity')}</th>
                <th className="text-left hidden lg:table-cell">{tr('Details')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="veqsio-table-row">
                  <td className="px-4 py-2 text-[var(--text-secondary)] whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-[var(--text-primary)]">{log.user}</td>
                  <td className="px-4 py-2">
                    <span className="veqsio-badge veqsio-badge-status-todo">{log.action}</span>
                  </td>
                  <td className="px-4 py-2 text-[var(--text-secondary)]">{log.entity}</td>
                  <td className="px-4 py-2 text-[var(--text-tertiary)] hidden lg:table-cell max-w-xs truncate">
                    {log.details}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
