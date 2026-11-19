'use client'

import { useProjectSecurity } from '@/hooks/use-issue-security'
import { levelChoices } from '@/lib/issue-security'
import { RichTextEditor } from '@/components/rich-text-editor'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { AppLayout } from '@/components/app-layout'
import { toast } from '@/components/toast'
import {
  Bug, GitBranch, BookOpen, Layers, CheckCircle2,
  ArrowLeft, Loader2, Paperclip
} from 'lucide-react'
import Link from 'next/link'
import { SimilarIssuesHint } from '@/components/ai/similar-issues'
import { AiSuggest } from '@/components/ai/ai-suggest'
import { DraftNotice } from '@/components/draft-notice'
import { useDraft } from '@/hooks/use-draft'
import { useMyself } from '@/hooks/use-issues'
import { isDraftEmpty, issueDraftKey } from '@/lib/drafts'
import { TemplatePicker } from '@/components/templates/template-picker'
import { useTerm } from '@/hooks/use-term'

interface ProjectOption {
  id: number
  key: string
  name: string
}

interface IssueTypeOption {
  id: number
  name: string
  icon: string
  color: string
}

interface PriorityOption {
  id: number
  name: string
  color: string
}

interface UserOption {
  id: number
  displayName: string
  username: string
}

const typeIcons: Record<string, typeof Bug> = {
  Bug: Bug,
  Task: CheckCircle2,
  Story: BookOpen,
  Epic: Layers,
  'Sub-task': GitBranch,
}

export default function CreateIssuePage() {
  const router = useRouter()
  const { t } = useTerm()
  const [templateExtras, setTemplateExtras] = useState<{ components?: number[]; customFields?: Array<{ fieldId: number; value: unknown }> }>({})
  const [loading, setLoading] = useState(false)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [issueTypes, setIssueTypes] = useState<IssueTypeOption[]>([])
  const [priorities, setPriorities] = useState<PriorityOption[]>([])
  const [users, setUsers] = useState<UserOption[]>([])

  const [projectId, setProjectId] = useState('')
  const [issueTypeId, setIssueTypeId] = useState('')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [priorityId, setPriorityId] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [labels, setLabels] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [storyPoints, setStoryPoints] = useState('')
  const [createAnother, setCreateAnother] = useState(false)
  const [securityId, setSecurityId] = useState<string | null>(null) // null = leave to the project's default
  const projectKeyOf = projects.find((p) => String(p.id) === projectId)?.key
  const { data: projectSecurity } = useProjectSecurity(projectKeyOf)
  const offerSecurity = !!projectSecurity?.canSet && projectSecurity.levels.length > 0

  // Autosaved draft (localStorage, one per user): never contains attachments, cleared after a successful create.
  const { data: me } = useMyself()
  const draftValue = useMemo(
    () => ({ projectId, issueTypeId, summary, description, priorityId, assigneeId, labels, dueDate, storyPoints }),
    [projectId, issueTypeId, summary, description, priorityId, assigneeId, labels, dueDate, storyPoints],
  )
  const draft = useDraft({
    key: me ? issueDraftKey(me.id, 'new', 'form') : null,
    value: draftValue,
    isEmpty: (d) => isDraftEmpty(d, ['projectId', 'issueTypeId', 'priorityId', 'assigneeId']),
    onRestore: (d) => {
      if (d.projectId) setProjectId(String(d.projectId))
      if (d.issueTypeId) setIssueTypeId(String(d.issueTypeId))
      setSummary(d.summary ?? '')
      setDescription(d.description ?? '')
      if (d.priorityId) setPriorityId(String(d.priorityId))
      setAssigneeId(d.assigneeId ?? '')
      setLabels(d.labels ?? '')
      setDueDate(d.dueDate ?? '')
      setStoryPoints(d.storyPoints ?? '')
    },
    onDiscard: () => { setSummary(''); setDescription(''); setAssigneeId(''); setLabels(''); setDueDate(''); setStoryPoints('') },
  })

  useEffect(() => {
    fetchMetadata()
  }, [])

  async function fetchMetadata() {
    try {
      const [projRes, typeRes, prioRes, userRes] = await Promise.all([
        fetch('/rest/api/2/project', { credentials: 'include' }),
        fetch('/rest/api/2/issuetype', { credentials: 'include' }),
        fetch('/rest/api/2/priority', { credentials: 'include' }),
        fetch('/rest/api/2/user/search?username=', { credentials: 'include' }),
      ])

      const projData = projRes.ok ? await projRes.json() : []
      const typeData = typeRes.ok ? await typeRes.json() : []
      const prioData = prioRes.ok ? await prioRes.json() : []
      const usersData = userRes.ok ? await userRes.json() : { users: [] }

      setProjects(projData)
      setIssueTypes(typeData)
      setPriorities(prioData)
      setUsers(usersData.users || [])

      // Set defaults after loading
      // functional updates: a restored draft may already have chosen project, type or priority
      if (projData[0]) setProjectId((cur) => cur || String(projData[0].id))
      if (typeData[0]) setIssueTypeId((cur) => cur || String(typeData[0].id))
      const medium = prioData.find((p: any) => p.name === 'Medium')
      const defaultPriority = medium ?? prioData[0]
      if (defaultPriority) setPriorityId((cur) => cur || String(defaultPriority.id))
    } catch {
      toast('Failed to load metadata', 'error')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!summary.trim() || !projectId || !issueTypeId) {
      toast('Please fill in required fields', 'error')
      return
    }

    const points = storyPoints.trim() === '' ? undefined : Number(storyPoints)
    if (points !== undefined && (!Number.isFinite(points) || points < 0 || points > 1000 || Math.round(points * 100) / 100 !== points)) {
      toast('Story points must be a number between 0 and 1000 with at most 2 decimals', 'error')
      return
    }

    setLoading(true)
    try {
      const body: any = {
        fields: {
          project: { id: Number(projectId) },
          issuetype: { id: Number(issueTypeId) },
          summary,
          description: description || undefined,
          priority: priorityId ? { id: Number(priorityId) } : undefined,
          assignee: assigneeId ? { id: Number(assigneeId) } : undefined,
          labels: labels ? labels.split(',').map((l) => l.trim()) : undefined,
          components: templateExtras.components?.map((id) => ({ id })),
          customFields: templateExtras.customFields,
          duedate: dueDate || undefined,
          storyPoints: points,
          // only sent when the user changed it: the project default applies otherwise
          ...(offerSecurity && securityId !== null ? { security: securityId === '' ? null : { id: Number(securityId) } } : {}),
        },
      }

      const res = await fetch('/rest/api/2/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const data = await res.json()
        toast(t(`Issue ${data.key} created`), 'success')
        draft.clear()
        if (createAnother) {
          setSummary('')
          setDescription('')
          setLabels('')
          setDueDate('')
          setStoryPoints('')
          setTemplateExtras({})
        } else {
          router.push(`/issues/${data.key}`)
        }
      } else {
        const err = await res.json()
        toast(err.errorMessages?.[0] || t('Failed to create issue'), 'error')
      }
    } catch {
      toast('Network error', 'error')
    } finally {
      setLoading(false)
    }
  }

  const selectedType = issueTypes.find((t) => String(t.id) === issueTypeId)
  const TypeIcon = selectedType ? typeIcons[selectedType.name] || Bug : Bug

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <Link href="/issues" aria-label="Back to issues" className="veqsio-btn-ghost p-2">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <h1 className="text-heading-1 text-[var(--text-primary)]">{t('Create issue')}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <DraftNotice savedAt={draft.restored?.savedAt ?? null} onDiscard={draft.discard} />
          {/* Project & Type row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
                Project *
              </label>
              <select
                aria-label="Project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="veqsio-input w-full"
                required
              >
                <option value="">Select project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
                {t('Issue Type')} *
              </label>
              <div className="relative">
                <select
                  aria-label="Issue type"
                  value={issueTypeId}
                  onChange={(e) => setIssueTypeId(e.target.value)}
                  className="veqsio-input w-full pl-10"
                  required
                >
                  <option value="">Select type</option>
                  {issueTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <div className="absolute left-3 top-1/2 -translate-y-1/2">
                  <TypeIcon className="w-4 h-4 text-[var(--text-tertiary)]" />
                </div>
              </div>
            </div>
          </div>

          <TemplatePicker
            key={projectId}
            projectKey={projects.find((p) => String(p.id) === projectId)?.key}
            onApply={(p) => {
              setIssueTypeId(String(p.issueTypeId))
              setSummary(p.summary)
              setDescription(p.description ?? '')
              if (p.priorityId) setPriorityId(String(p.priorityId))
              setAssigneeId(p.assigneeId ? String(p.assigneeId) : '')
              setLabels((p.labels ?? []).join(', '))
              setTemplateExtras({ components: p.components, customFields: p.customFields })
            }}
            onClear={() => setTemplateExtras({})}
          />

          {/* Summary */}
          <div>
            <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
              Summary *
            </label>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What needs to be done?"
              className="veqsio-input w-full"
              required
            />
            <SimilarIssuesHint projectId={projectId} summary={summary} description={description} />
          </div>

          {/* Description */}
          <div>
            <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
              Description
            </label>
            <RichTextEditor
              label="Description"
              placeholder="Add a description... (Markdown supported, @ to mention)"
              rows={7}
              maxLength={100000}
              value={description}
              onChange={setDescription}
            />
            <AiSuggest projectId={projectId} summary={summary} description={description} onApply={(a) => {
              if (a.issueTypeId) setIssueTypeId(String(a.issueTypeId))
              if (a.priorityId) setPriorityId(String(a.priorityId))
              if (a.labels.length) setLabels((cur) => Array.from(new Set([...cur.split(',').map((l) => l.trim()).filter(Boolean), ...a.labels])).join(', '))
            }} />
          </div>

          {/* Priority & Assignee row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
                Priority
              </label>
              <select
                aria-label="Priority"
                value={priorityId}
                onChange={(e) => setPriorityId(e.target.value)}
                className="veqsio-input w-full"
              >
                <option value="">Select priority</option>
                {priorities.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
                Assignee
              </label>
              <select
                aria-label="Assignee"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="veqsio-input w-full"
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {offerSecurity && (
            <div>
              <label htmlFor="create-security" className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">Security level</label>
              <select
                id="create-security"
                value={securityId ?? (projectSecurity!.defaultLevelId ? String(projectSecurity!.defaultLevelId) : '')}
                onChange={(e) => setSecurityId(e.target.value)}
                className="veqsio-input w-full sm:w-1/2"
              >
                {levelChoices(projectSecurity!.levels, projectSecurity!.defaultLevelId).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <p className="text-caption text-[var(--text-tertiary)] mt-1">Only members of the level can see the issue.</p>
            </div>
          )}

          {/* Labels & Due Date row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
                Labels
              </label>
              <input
                type="text"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="bug, frontend, urgent"
                className="veqsio-input w-full"
              />
              <p className="text-caption text-[var(--text-tertiary)] mt-1">Separate labels with commas</p>
            </div>

            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
                Due Date
              </label>
              <input
                aria-label="Due date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="veqsio-input w-full"
              />
            </div>
          </div>

          {/* Story points */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="create-story-points" className="text-caption font-medium text-[var(--text-secondary)] block mb-1.5">
                Story Points
              </label>
              <input
                id="create-story-points"
                type="number"
                inputMode="decimal"
                min={0}
                max={1000}
                step={0.5}
                value={storyPoints}
                onChange={(e) => setStoryPoints(e.target.value)}
                placeholder="e.g. 5"
                className="veqsio-input w-full"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="sticky bottom-0 z-10 -mx-2 px-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 py-3 border-t border-[var(--surface-3)] bg-[var(--surface-0)]">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={createAnother}
                onChange={(e) => setCreateAnother(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--surface-4)] text-[var(--brand-500)] focus:ring-[var(--brand-500)]"
              />
              <span className="text-body-sm text-[var(--text-secondary)]">Create another</span>
            </label>

            <div className="flex items-center gap-3">
              <Link href="/issues" className="veqsio-btn-secondary">
                Cancel
              </Link>
              <button
                type="submit"
                disabled={loading}
                className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-60"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('Create issue')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  )
}
