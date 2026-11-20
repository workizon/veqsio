'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { Modal } from '@/components/modal'
import { PageHeader } from '@/components/page-header'
import { RuleDraftButton } from '@/components/ai/rule-draft'
import {
  useAutomationRules,
  useDeleteAutomationRule,
  useToggleAutomationRule,
  useExecuteAutomationRule,
  useAutomationExecutions,
} from '@/hooks/use-automation'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus,
  Play,
  Trash2,
  Pencil,
  History,
  Power,
  PowerOff,
  Zap,
  X,
  CheckCircle,
  AlertCircle,
  SkipForward,
  Clock,
} from 'lucide-react'
import { confirmDialog } from '@/components/dialogs'

export default function AutomationPage() {
  const { tr } = useI18n();

  const router = useRouter()
  const { data: rules, isLoading, error } = useAutomationRules()
  const deleteMutation = useDeleteAutomationRule()
  const toggleMutation = useToggleAutomationRule()
  const executeMutation = useExecuteAutomationRule()
  const [historyRuleId, setHistoryRuleId] = useState<number | null>(null)
  const [runRuleId, setRunRuleId] = useState<number | null>(null)
  const [runIssueKey, setRunIssueKey] = useState('')

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader
          title={tr('Automation')}
          description={tr('Rules that act on issues when something happens, so nobody has to do it by hand.')}
          actions={<>
            <RuleDraftButton />
            <button onClick={() => router.push('/automation/create')} className="veqsio-btn-primary flex items-center gap-2"><Plus className="w-4 h-4" />{tr('Create rule')}</button>
          </>}
        />

        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center py-16 px-4 text-center">
            <div className="text-[var(--error)] text-body">
              {error.message || 'Failed to load automation rules'}
            </div>
          </div>
        )}

        {!isLoading && !error && (!rules || rules.length === 0) && (
          <EmptyState
            icon="folder"
            title={tr('No automation rules')}
            description={tr('Use Create rule above to add the first one, or Describe a rule to let the AI draft it.')}
          />
        )}

        {!isLoading && !error && rules && rules.length > 0 && (
          <div className="space-y-3">
            {rules.map((rule) => (
              <div key={rule.id} className="veqsio-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Zap className="w-4 h-4 text-[var(--brand-500)]" />
                      <h3 className="text-heading-2 text-[var(--text-primary)] truncate">
                        {rule.name}
                      </h3>
                      {rule.isEnabled ? (
                        <span className="veqsio-badge-status-done text-[10px] px-2 py-0.5 rounded-full">
                          {tr('Active')} </span>
                      ) : (
                        <span className="veqsio-badge text-[10px] px-2 py-0.5 rounded-full">
                          {tr('Disabled')} </span>
                      )}
                    </div>
                    {rule.description && (
                      <p className="text-body-sm text-[var(--text-secondary)] mb-2">
                        {rule.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 text-caption text-[var(--text-tertiary)]">
                      <span>
                        {rule.triggers?.length ?? 0} trigger
                        {(rule.triggers?.length ?? 0) !== 1 ? 's' : ''}
                      </span>
                      <span>
                        {rule.conditions?.length ?? 0} condition
                        {(rule.conditions?.length ?? 0) !== 1 ? 's' : ''}
                      </span>
                      <span>
                        {rule.actions?.length ?? 0} action
                        {(rule.actions?.length ?? 0) !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => setRunRuleId(rule.id)}
                      className="veqsio-btn-ghost p-2"
                      title={tr('Test run')}
                    >
                      <Play className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setHistoryRuleId(rule.id)}
                      className="veqsio-btn-ghost p-2"
                      title={tr('Execution history')}
                    >
                      <History className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() =>
                        toggleMutation.mutate({ id: rule.id, isEnabled: !rule.isEnabled })
                      }
                      className="veqsio-btn-ghost p-2"
                      title={rule.isEnabled ? tr('Disable') : tr('Enable')}
                    >
                      {rule.isEnabled ? (
                        <Power className="w-4 h-4 text-[var(--success)]" />
                      ) : (
                        <PowerOff className="w-4 h-4 text-[var(--text-tertiary)]" />
                      )}
                    </button>
                    <button
                      onClick={() => router.push(`/automation/create?id=${rule.id}`)}
                      className="veqsio-btn-ghost p-2"
                      title={tr('Edit')}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={async () => {
                        if ((await confirmDialog('Delete this automation rule?'))) {
                          deleteMutation.mutate(rule.id)
                        }
                      }}
                      className="veqsio-btn-ghost p-2 hover:text-[var(--error)]"
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
      </div>

      {/* Execution History Modal */}
      <ExecutionHistoryModal
        ruleId={historyRuleId}
        onClose={() => setHistoryRuleId(null)}
      />

      {/* Test Run Modal */}
      <TestRunModal
        ruleId={runRuleId}
        issueKey={runIssueKey}
        setIssueKey={setRunIssueKey}
        onClose={() => {
          setRunRuleId(null)
          setRunIssueKey('')
        }}
        onRun={() => {
          if (runRuleId !== null) {
            executeMutation.mutate(
              { id: runRuleId, issueKey: runIssueKey || undefined },
              {
                onSuccess: () => {
                  setRunRuleId(null)
                  setRunIssueKey('')
                },
              }
            )
          }
        }}
        isRunning={executeMutation.isPending}
      />
    </AppLayout>
  )
}

function ExecutionHistoryModal({
  ruleId,
  onClose,
}: {
  ruleId: number | null
  onClose: () => void
}) {
  const { tr } = useI18n();

  const { data: executions, isLoading } = useAutomationExecutions(ruleId)

  return (
    <Modal isOpen={ruleId !== null} onClose={onClose} title={tr('Execution history')} size="lg">
      <div className="max-h-[60vh] overflow-y-auto space-y-2">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        )}
        {!isLoading && (!executions || executions.length === 0) && (
          <EmptyState icon="inbox" title={tr('No executions yet')} description={tr('Run this rule to see history.')} />
        )}
        {!isLoading &&
          executions?.map((ex) => (
            <div
              key={ex.id}
              className="flex items-center justify-between p-3 rounded-lg border border-[var(--surface-3)] bg-[var(--surface-1)]"
            >
              <div className="flex items-center gap-3">
                {ex.status === 'success' && <CheckCircle className="w-4 h-4 text-[var(--success)]" />}
                {ex.status === 'failed' && <AlertCircle className="w-4 h-4 text-[var(--error)]" />}
                {ex.status === 'skipped' && <SkipForward className="w-4 h-4 text-[var(--warning)]" />}
                {ex.status === 'running' && <Clock className="w-4 h-4 text-[var(--info)] animate-spin" />}
                <div>
                  <div className="text-body-sm text-[var(--text-primary)]">
                    {ex.triggeredBy}
                    {ex.triggerIssueKey ? ` · ${ex.triggerIssueKey}` : ''}
                  </div>
                  <div className="text-caption text-[var(--text-tertiary)]">
                    {new Date(ex.startedAt).toLocaleString(getIntlLocale())}
                  </div>
                  {ex.errorMessage && (
                    <div className="text-caption text-[var(--error)] mt-1">{ex.errorMessage}</div>
                  )}
                </div>
              </div>
              <span
                className={`text-caption-sm font-medium px-2 py-0.5 rounded-full ${
                  ex.status === 'success'
                    ? 'bg-[var(--success)]/10 text-[var(--success)]'
                    : ex.status === 'failed'
                    ? 'bg-[var(--error)]/10 text-[var(--error)]'
                    : ex.status === 'skipped'
                    ? 'bg-[var(--warning)]/10 text-[var(--warning)]'
                    : 'bg-[var(--info)]/10 text-[var(--info)]'
                }`}
              >
                {ex.status}
              </span>
            </div>
          ))}
      </div>
    </Modal>
  )
}

function TestRunModal({
  ruleId,
  issueKey,
  setIssueKey,
  onClose,
  onRun,
  isRunning,
}: {
  ruleId: number | null
  issueKey: string
  setIssueKey: (v: string) => void
  onClose: () => void
  onRun: () => void
  isRunning: boolean
}) {
  const { tr } = useI18n();

  return (
    <Modal isOpen={ruleId !== null} onClose={onClose} title={tr('Test run')} size="sm">
      <div className="space-y-4">
        <p className="text-body-sm text-[var(--text-secondary)]">
          {tr('Provide an issue key to run this rule against a specific issue, or leave blank for a generic manual run.')} </p>
        <input
          type="text"
          value={issueKey}
          onChange={(e) => setIssueKey(e.target.value)}
          placeholder={tr('e.g. PROJ-123')}
          className="veqsio-input w-full"
        />
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="veqsio-btn-ghost" disabled={isRunning}>
            {tr('Cancel')} </button>
          <button onClick={onRun} className="veqsio-btn-primary flex items-center gap-2" disabled={isRunning}>
            {isRunning ? <Spinner size="sm" /> : <Play className="w-4 h-4" />}
            {tr('Run')} </button>
        </div>
      </div>
    </Modal>
  )
}
