'use client'


import { getIntlLocale } from '@/lib/i18n'
import { useI18n } from '@/hooks/use-i18n'
import { AppLayout } from '@/components/app-layout'
import { Spinner } from '@/components/spinner'
import { EmptyState } from '@/components/empty-state'
import { Modal } from '@/components/modal'
import { Tabs } from '@/components/tabs'
import {
  useAutomationRule,
  useCreateAutomationRule,
  useUpdateAutomationRule,
  useExecuteAutomationRule,
  useAutomationExecutions,
} from '@/hooks/use-automation'
import { useQuery } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  Save,
  Play,
  Plus,
  Trash2,
  History,
  Zap,
  CheckCircle,
  AlertCircle,
  SkipForward,
  Clock,
} from 'lucide-react'
import { alertDialog } from '@/components/dialogs'

/* ------------------------------------------------------------------ */
/*  Metadata fetchers                                                  */
/* ------------------------------------------------------------------ */

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

function useProjects() {
  return useQuery({
    queryKey: ['projects-list'],
    queryFn: () => fetchJson<{ id: number; key: string; name: string }[]>('/rest/api/2/project'),
  })
}

function useIssueTypes() {
  return useQuery({
    queryKey: ['issue-types'],
    queryFn: () =>
      fetchJson<{ id: string; name: string; subtask: boolean }[]>('/rest/api/2/issuetype'),
  })
}

function useStatuses() {
  return useQuery({
    queryKey: ['statuses'],
    queryFn: () =>
      fetchJson<{ id: string; name: string }[]>('/rest/api/2/status'),
  })
}

function usePriorities() {
  return useQuery({
    queryKey: ['priorities'],
    queryFn: () =>
      fetchJson<{ id: string; name: string }[]>('/rest/api/2/priority'),
  })
}

function useUsers() {
  return useQuery({
    queryKey: ['users-list'],
    queryFn: () =>
      fetchJson<{ values: { id: number; name: string }[] }>('/rest/api/2/user?maxResults=100').then((d) => d.values),
  })
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TRIGGER_TYPES = [
  'issue_created',
  'issue_updated',
  'issue_commented',
  'issue_transitioned',
  'sprint_started',
  'manual',
  'scheduled',
]

const CONDITION_TYPES = [
  'jql_match',
  'field_equals',
  'field_changed',
  'issue_type_is',
  'priority_is',
  'status_is',
  'assignee_is',
  'reporter_is_current_user',
  'issue_is_subtask',
]

const ACTION_TYPES = [
  'transition_issue',
  'assign_issue',
  'add_comment',
  'update_field',
  'create_issue',
  'send_webhook',
  'send_email',
  'add_label',
  'remove_label',
  'set_priority',
  'link_issue',
  'log_action',
]

const SYSTEM_FIELDS = [
  'summary',
  'description',
  'status',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'duedate',
  'environment',
  'timeestimate',
  'timespent',
]

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function AutomationCreatePage() {
  const { tr } = useI18n();

  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get('id') ? Number(searchParams.get('id')) : null

  const { data: existingRule, isLoading: existingLoading } = useAutomationRule(editId)
  const createMutation = useCreateAutomationRule()
  const updateMutation = useUpdateAutomationRule()
  const executeMutation = useExecuteAutomationRule()

  const { data: projects } = useProjects()
  const { data: issueTypes } = useIssueTypes()
  const { data: statuses } = useStatuses()
  const { data: priorities } = usePriorities()
  const { data: users } = useUsers()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState<string>('')
  const [isEnabled, setIsEnabled] = useState(true)
  const [triggers, setTriggers] = useState<Array<{ id?: number; triggerType: string; config: Record<string, any> }>>([])
  const [conditions, setConditions] = useState<
    Array<{ id?: number; conditionType: string; operator: string; config: Record<string, any> }>
  >([])
  const [actions, setActions] = useState<Array<{ id?: number; actionType: string; config: Record<string, any> }>>([])

  const [testIssueKey, setTestIssueKey] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (existingRule) {
      setName(existingRule.name)
      setDescription(existingRule.description || '')
      setProjectId(existingRule.projectId ? String(existingRule.projectId) : '')
      setIsEnabled(existingRule.isEnabled)
      setTriggers(
        existingRule.triggers.map((t) => ({
          id: t.id,
          triggerType: t.triggerType,
          config: (t.config as Record<string, any>) || {},
        }))
      )
      setConditions(
        existingRule.conditions.map((c) => ({
          id: c.id,
          conditionType: c.conditionType,
          operator: c.operator,
          config: (c.config as Record<string, any>) || {},
        }))
      )
      setActions(
        existingRule.actions.map((a) => ({
          id: a.id,
          actionType: a.actionType,
          config: (a.config as Record<string, any>) || {},
        }))
      )
    }
  }, [existingRule])

  const handleSave = async () => {
    if (!name.trim()) return void alertDialog('Rule name is required')
    if (triggers.length === 0) return void alertDialog('At least one trigger is required')
    if (actions.length === 0) return void alertDialog('At least one action is required')

    setSaving(true)
    try {
      const payload = {
        name,
        description,
        projectId: projectId ? Number(projectId) : null,
        isEnabled,
        triggers: triggers.map((t) => ({
          triggerType: t.triggerType,
          config: t.config,
        })),
        conditions: conditions.map((c) => ({
          conditionType: c.conditionType,
          operator: c.operator,
          config: c.config,
        })),
        actions: actions.map((a) => ({
          actionType: a.actionType,
          config: a.config,
        })),
      }

      if (editId) {
        await updateMutation.mutateAsync({ id: editId, body: payload as any })
        router.push('/automation')
      } else {
        await createMutation.mutateAsync(payload as any)
        router.push('/automation')
      }
    } catch (e: any) {
      void alertDialog(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleTestRun = async () => {
    if (!editId) return void alertDialog('Save the rule before testing')
    await executeMutation.mutateAsync({ id: editId, issueKey: testIssueKey || undefined })
    void alertDialog('Test run executed')
  }

  const isLoadingMeta = !projects || !issueTypes || !statuses || !priorities || !users

  if (editId && existingLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-16">
          <Spinner size="lg" />
        </div>
      </AppLayout>
    )
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/automation')} className="veqsio-btn-ghost p-2">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-heading-1 text-[var(--text-primary)]">
              {editId ? 'Edit Rule' : 'Create Rule'}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {editId && (
              <>
                <button
                  onClick={() => setHistoryOpen(true)}
                  className="veqsio-btn-secondary flex items-center gap-2"
                >
                  <History className="w-4 h-4" />
                  {tr('History')} </button>
                <button
                  onClick={handleTestRun}
                  className="veqsio-btn-secondary flex items-center gap-2"
                  disabled={executeMutation.isPending}
                >
                  {executeMutation.isPending ? <Spinner size="sm" /> : <Play className="w-4 h-4" />}
                  {tr('Test')} </button>
              </>
            )}
            <button
              onClick={handleSave}
              className="veqsio-btn-primary flex items-center gap-2"
              disabled={saving}
            >
              {saving ? <Spinner size="sm" /> : <Save className="w-4 h-4" />}
              {tr('Save')} </button>
          </div>
        </div>

        {isLoadingMeta ? (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : (
          <>
            {/* Basic settings */}
            <div className="veqsio-card p-4 space-y-4">
              <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Basic settings')}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-caption text-[var(--text-secondary)]">{tr('Name *')}</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="veqsio-input w-full"
                    placeholder={tr('Rule name')}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-caption text-[var(--text-secondary)]">{tr('Project scope')}</label>
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="veqsio-input w-full"
                  >
                    <option value="">{tr('Global (all projects)')}</option>
                    {projects?.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-caption text-[var(--text-secondary)]">{tr('Description')}</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="veqsio-input w-full min-h-[80px] resize-y"
                  placeholder={tr('What does this rule do?')}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="enabled"
                  type="checkbox"
                  checked={isEnabled}
                  onChange={(e) => setIsEnabled(e.target.checked)}
                  className="accent-[var(--brand-500)]"
                />
                <label htmlFor="enabled" className="text-body-sm text-[var(--text-primary)]">
                  {tr('Enabled')} </label>
              </div>
              {editId && (
                <div className="flex items-center gap-2">
                  <label className="text-caption text-[var(--text-secondary)]">{tr('Test issue key')}</label>
                  <input
                    type="text"
                    value={testIssueKey}
                    onChange={(e) => setTestIssueKey(e.target.value)}
                    className="veqsio-input w-48"
                    placeholder={tr('PROJ-123')}
                  />
                </div>
              )}
            </div>

            {/* Builder sections */}
            <Tabs
              tabs={[
                {
                  id: 'triggers',
                  label: tr('Triggers ({n})', { n: triggers.length }),
                  content: (
                    <BuilderSection
                      items={triggers}
                      typeOptions={TRIGGER_TYPES}
                      onAdd={() =>
                        setTriggers((prev) => [...prev, { triggerType: TRIGGER_TYPES[0], config: {} }])
                      }
                      onRemove={(idx) => setTriggers((prev) => prev.filter((_, i) => i !== idx))}
                      onUpdate={(idx, item) =>
                        setTriggers((prev) => prev.map((t, i) => (i === idx ? item : t)))
                      }
                      renderConfig={(item, onChange) => (
                        <TriggerConfigForm
                          triggerType={item.triggerType}
                          config={item.config}
                          onChange={onChange}
                        />
                      )}
                    />
                  ),
                },
                {
                  id: 'conditions',
                  label: tr('Conditions ({n})', { n: conditions.length }),
                  content: (
                    <BuilderSection
                      items={conditions}
                      typeOptions={CONDITION_TYPES}
                      onAdd={() =>
                        setConditions((prev) => [
                          ...prev,
                          { conditionType: CONDITION_TYPES[0], operator: 'AND', config: {} },
                        ])
                      }
                      onRemove={(idx) => setConditions((prev) => prev.filter((_, i) => i !== idx))}
                      onUpdate={(idx, item) =>
                        setConditions((prev) => prev.map((c, i) => (i === idx ? item : c)))
                      }
                      renderConfig={(item, onChange) => (
                        <ConditionConfigForm
                          conditionType={item.conditionType}
                          config={item.config}
                          onChange={onChange}
                          meta={{ issueTypes, statuses, priorities, users, projects }}
                        />
                      )}
                    />
                  ),
                },
                {
                  id: 'actions',
                  label: tr('Actions ({n})', { n: actions.length }),
                  content: (
                    <BuilderSection
                      items={actions}
                      typeOptions={ACTION_TYPES}
                      onAdd={() =>
                        setActions((prev) => [...prev, { actionType: ACTION_TYPES[0], config: {} }])
                      }
                      onRemove={(idx) => setActions((prev) => prev.filter((_, i) => i !== idx))}
                      onUpdate={(idx, item) =>
                        setActions((prev) => prev.map((a, i) => (i === idx ? item : a)))
                      }
                      renderConfig={(item, onChange) => (
                        <ActionConfigForm
                          actionType={item.actionType}
                          config={item.config}
                          onChange={onChange}
                          meta={{ issueTypes, statuses, priorities, users, projects }}
                        />
                      )}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </div>

      <ExecutionHistoryModal ruleId={editId} isOpen={historyOpen} onClose={() => setHistoryOpen(false)} />
    </AppLayout>
  )
}

/* ------------------------------------------------------------------ */
/*  Builder Section                                                    */
/* ------------------------------------------------------------------ */

function BuilderSection({
  items,
  typeOptions,
  onAdd,
  onRemove,
  onUpdate,
  renderConfig,
}: {
  items: any[]
  typeOptions: string[]
  onAdd: () => void
  onRemove: (idx: number) => void
  onUpdate: (idx: number, item: any) => void
  renderConfig: (item: any, onChange: (partial: any) => void) => React.ReactNode
}) {
  const { tr } = useI18n();

  return (
    <div className="space-y-3">
      {items.map((item, idx) => (
        <div key={idx} className="veqsio-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <select
              value={(item as any).triggerType || (item as any).conditionType || (item as any).actionType}
              onChange={(e) => {
                const typeKey =
                  'triggerType' in (item as object)
                    ? 'triggerType'
                    : 'conditionType' in (item as object)
                    ? 'conditionType'
                    : 'actionType'
                onUpdate(idx, { ...item, [typeKey]: e.target.value, config: {} } as any)
              }}
              className="veqsio-input flex-1"
            >
              {typeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
            {'operator' in (item as any) && (
              <select
                value={(item as any).operator}
                onChange={(e) => onUpdate(idx, { ...item, operator: e.target.value })}
                className="veqsio-input w-24"
              >
                <option value="AND">{tr('AND')}</option>
                <option value="OR">{tr('OR')}</option>
              </select>
            )}
            <button
              onClick={() => onRemove(idx)}
              className="veqsio-btn-ghost p-2 hover:text-[var(--error)]"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div>
            {renderConfig(item, (partial) => onUpdate(idx, { ...item, ...partial }))}
          </div>
        </div>
      ))}
      <button
        onClick={onAdd}
        className="veqsio-btn-secondary w-full flex items-center justify-center gap-2 py-3"
      >
        <Plus className="w-4 h-4" />
        {tr('Add')} </button>

      {items.length === 0 && (
        <EmptyState
          icon="inbox"
          title={tr('Nothing here yet')}
          description={tr('Click Add to get started.')}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Trigger Config Form                                                */
/* ------------------------------------------------------------------ */

function TriggerConfigForm({
  triggerType,
  config,
  onChange,
}: {
  triggerType: string
  config: Record<string, any>
  onChange: (partial: { config?: Record<string, any> }) => void
}) {
  const { tr } = useI18n();

  if (triggerType === 'scheduled') {
    return (
      <div className="space-y-2">
        <label className="text-caption text-[var(--text-secondary)]">{tr('Cron expression')}</label>
        <input
          type="text"
          value={config.cron || ''}
          onChange={(e) => onChange({ config: { ...config, cron: e.target.value } })}
          className="veqsio-input w-full"
          placeholder="0 9 * * 1"
        />
      </div>
    )
  }
  return (
    <p className="text-caption text-[var(--text-tertiary)]">
      {tr('No additional configuration required for this trigger.')} </p>
  )
}

/* ------------------------------------------------------------------ */
/*  Condition Config Form                                              */
/* ------------------------------------------------------------------ */

function ConditionConfigForm({
  conditionType,
  config,
  onChange,
  meta,
}: {
  conditionType: string
  config: Record<string, any>
  onChange: (partial: { config?: Record<string, any>; operator?: string }) => void
  meta: {
    issueTypes?: { id: string; name: string }[]
    statuses?: { id: string; name: string }[]
    priorities?: { id: string; name: string }[]
    users?: { id: number; name: string }[]
    projects?: { id: number; key: string; name: string }[]
  }
}) {
  const { tr } = useI18n();

  switch (conditionType) {
    case 'jql_match':
      return (
        <div className="space-y-2">
          <label className="text-caption text-[var(--text-secondary)]">{tr('JQL Query')}</label>
          <textarea
            value={config.jql || ''}
            onChange={(e) => onChange({ config: { ...config, jql: e.target.value } })}
            className="veqsio-input w-full min-h-[80px] resize-y font-mono text-sm"
            placeholder={tr('status = \'To Do\' AND priority = \'High\'')}
          />
        </div>
      )

    case 'field_equals':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Field')}</label>
            <select
              value={config.field || ''}
              onChange={(e) => onChange({ config: { ...config, field: e.target.value } })}
              className="veqsio-input w-full"
            >
              <option value="">{tr('Select field')}</option>
              {SYSTEM_FIELDS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Value')}</label>
            <input
              type="text"
              value={config.value || ''}
              onChange={(e) => onChange({ config: { ...config, value: e.target.value } })}
              className="veqsio-input w-full"
              placeholder={tr('Value to match')}
            />
          </div>
        </div>
      )

    case 'field_changed':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Field')}</label>
          <select
            value={config.field || ''}
            onChange={(e) => onChange({ config: { ...config, field: e.target.value } })}
            className="veqsio-input w-full"
          >
            <option value="">{tr('Select field')}</option>
            {SYSTEM_FIELDS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
      )

    case 'issue_type_is':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Issue type')}</label>
          <select
            value={config.issueTypeId || ''}
            onChange={(e) => onChange({ config: { ...config, issueTypeId: e.target.value } })}
            className="veqsio-input w-full"
          >
            <option value="">{tr('Select issue type')}</option>
            {meta.issueTypes?.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )

    case 'priority_is':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Priority')}</label>
          <select
            value={config.priorityId || ''}
            onChange={(e) => onChange({ config: { ...config, priorityId: e.target.value } })}
            className="veqsio-input w-full"
          >
            <option value="">{tr('Select priority')}</option>
            {meta.priorities?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )

    case 'status_is':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Status')}</label>
          <select
            value={config.statusId || ''}
            onChange={(e) => onChange({ config: { ...config, statusId: e.target.value } })}
            className="veqsio-input w-full"
          >
            <option value="">{tr('Select status')}</option>
            {meta.statuses?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      )

    case 'assignee_is':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Assignee')}</label>
          <select
            value={config.assigneeId || ''}
            onChange={(e) => onChange({ config: { ...config, assigneeId: e.target.value } })}
            className="veqsio-input w-full"
          >
            <option value="">{tr('Unassigned')}</option>
            {meta.users?.map((u) => (
              <option key={u.id} value={String(u.id)}>{u.name}</option>
            ))}
          </select>
        </div>
      )

    case 'reporter_is_current_user':
    case 'issue_is_subtask':
      return (
        <p className="text-caption text-[var(--text-tertiary)]">
          {tr('No additional configuration required.')} </p>
      )

    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/*  Action Config Form                                                 */
/* ------------------------------------------------------------------ */

function ActionConfigForm({
  actionType,
  config,
  onChange,
  meta,
}: {
  actionType: string
  config: Record<string, any>
  onChange: (partial: { config?: Record<string, any> }) => void
  meta: {
    issueTypes?: { id: string; name: string }[]
    statuses?: { id: string; name: string }[]
    priorities?: { id: string; name: string }[]
    users?: { id: number; name: string }[]
    projects?: { id: number; key: string; name: string }[]
  }
}) {
  const { tr } = useI18n();

  switch (actionType) {
    case 'transition_issue':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Transition ID')}</label>
          <input
            type="number"
            value={config.transitionId || ''}
            onChange={(e) => onChange({ config: { ...config, transitionId: Number(e.target.value) } })}
            className="veqsio-input w-full"
            placeholder="e.g. 3"
          />
        </div>
      )

    case 'assign_issue':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Assignee')}</label>
          <select
            value={config.assigneeId || ''}
            onChange={(e) => onChange({ config: { ...config, assigneeId: e.target.value } })}
            className="veqsio-input w-full"
          >
            <option value="">{tr('Unassigned')}</option>
            {meta.users?.map((u) => (
              <option key={u.id} value={String(u.id)}>{u.name}</option>
            ))}
          </select>
        </div>
      )

    case 'add_comment':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Comment body')}</label>
          <textarea
            value={config.body || ''}
            onChange={(e) => onChange({ config: { ...config, body: e.target.value } })}
            className="veqsio-input w-full min-h-[80px] resize-y"
            placeholder={tr('Enter comment text...')}
          />
        </div>
      )

    case 'update_field':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Field')}</label>
            <select
              value={config.field || ''}
              onChange={(e) => onChange({ config: { ...config, field: e.target.value } })}
              className="veqsio-input w-full"
            >
              <option value="">{tr('Select field')}</option>
              {SYSTEM_FIELDS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Value')}</label>
            <input
              type="text"
              value={config.value || ''}
              onChange={(e) => onChange({ config: { ...config, value: e.target.value } })}
              className="veqsio-input w-full"
              placeholder={tr('New value')}
            />
          </div>
        </div>
      )

    case 'create_issue':
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Project')}</label>
            <select
              value={config.projectId || ''}
              onChange={(e) => onChange({ config: { ...config, projectId: e.target.value } })}
              className="veqsio-input w-full"
            >
              <option value="">{tr('Select project')}</option>
              {meta.projects?.map((p) => (
                <option key={p.id} value={String(p.id)}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Issue type')}</label>
            <select
              value={config.issueTypeId || ''}
              onChange={(e) => onChange({ config: { ...config, issueTypeId: e.target.value } })}
              className="veqsio-input w-full"
            >
              <option value="">{tr('Select type')}</option>
              {meta.issueTypes?.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1 md:col-span-2">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Summary')}</label>
            <input
              type="text"
              value={config.summary || ''}
              onChange={(e) => onChange({ config: { ...config, summary: e.target.value } })}
              className="veqsio-input w-full"
              placeholder={tr('Issue summary')}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Description')}</label>
            <textarea
              value={config.description || ''}
              onChange={(e) => onChange({ config: { ...config, description: e.target.value } })}
              className="veqsio-input w-full min-h-[60px] resize-y"
              placeholder={tr('Optional description')}
            />
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Priority')}</label>
            <select
              value={config.priorityId || ''}
              onChange={(e) => onChange({ config: { ...config, priorityId: e.target.value } })}
              className="veqsio-input w-full"
            >
              <option value="">{tr('None')}</option>
              {meta.priorities?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Assignee')}</label>
            <select
              value={config.assigneeId || ''}
              onChange={(e) => onChange({ config: { ...config, assigneeId: e.target.value } })}
              className="veqsio-input w-full"
            >
              <option value="">{tr('Unassigned')}</option>
              {meta.users?.map((u) => (
                <option key={u.id} value={String(u.id)}>{u.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Parent Issue ID')}</label>
            <input
              type="number"
              value={config.parentId || ''}
              onChange={(e) => onChange({ config: { ...config, parentId: e.target.value } })}
              className="veqsio-input w-full"
              placeholder={tr('Optional parent issue id')}
            />
          </div>
        </div>
      )

    case 'send_webhook':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Webhook URL')}</label>
          <input
            type="url"
            value={config.url || ''}
            onChange={(e) => onChange({ config: { ...config, url: e.target.value } })}
            className="veqsio-input w-full"
            placeholder="https://example.com/webhook"
          />
        </div>
      )

    case 'send_email':
      return (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('To address')}</label>
            <input
              type="email"
              value={config.toAddress || ''}
              onChange={(e) => onChange({ config: { ...config, toAddress: e.target.value } })}
              className="veqsio-input w-full"
              placeholder={tr('user@example.com')}
            />
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Subject')}</label>
            <input
              type="text"
              value={config.subject || ''}
              onChange={(e) => onChange({ config: { ...config, subject: e.target.value } })}
              className="veqsio-input w-full"
              placeholder={tr('Email subject')}
            />
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Body')}</label>
            <textarea
              value={config.body || ''}
              onChange={(e) => onChange({ config: { ...config, body: e.target.value } })}
              className="veqsio-input w-full min-h-[80px] resize-y"
              placeholder={tr('HTML body')}
            />
          </div>
        </div>
      )

    case 'add_label':
    case 'remove_label':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Label')}</label>
          <input
            type="text"
            value={config.label || ''}
            onChange={(e) => onChange({ config: { ...config, label: e.target.value } })}
            className="veqsio-input w-full"
            placeholder="bug"
          />
        </div>
      )

    case 'set_priority':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Priority')}</label>
          <select
            value={config.priorityId || ''}
            onChange={(e) => onChange({ config: { ...config, priorityId: e.target.value } })}
            className="veqsio-input w-full"
          >
            <option value="">{tr('None')}</option>
            {meta.priorities?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )

    case 'link_issue':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Outward Issue ID')}</label>
            <input
              type="number"
              value={config.outwardIssueId || ''}
              onChange={(e) => onChange({ config: { ...config, outwardIssueId: Number(e.target.value) } })}
              className="veqsio-input w-full"
              placeholder={tr('Issue ID to link')}
            />
          </div>
          <div className="space-y-1">
            <label className="text-caption text-[var(--text-secondary)]">{tr('Link Type ID')}</label>
            <input
              type="number"
              value={config.linkTypeId || ''}
              onChange={(e) => onChange({ config: { ...config, linkTypeId: Number(e.target.value) } })}
              className="veqsio-input w-full"
              placeholder="e.g. 1"
            />
          </div>
        </div>
      )

    case 'log_action':
      return (
        <div className="space-y-1">
          <label className="text-caption text-[var(--text-secondary)]">{tr('Message')}</label>
          <input
            type="text"
            value={config.message || ''}
            onChange={(e) => onChange({ config: { ...config, message: e.target.value } })}
            className="veqsio-input w-full"
            placeholder={tr('Log message')}
          />
        </div>
      )

    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/*  Execution History Modal                                            */
/* ------------------------------------------------------------------ */

function ExecutionHistoryModal({
  ruleId,
  isOpen,
  onClose,
}: {
  ruleId: number | null
  isOpen: boolean
  onClose: () => void
}) {
  const { tr } = useI18n();

  const { data: executions, isLoading } = useAutomationExecutions(ruleId)

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={tr('Execution history')} size="lg">
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
