'use client'


import { useI18n } from '@/hooks/use-i18n'
import { saveIssueOffline } from '@/lib/offline-cache'
import { MilestonesField } from '@/components/issue/milestones-field'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { toast } from '@/components/toast'
import { useIssue, useIssueAttachments, useMyself, useUpdateIssue } from '@/hooks/use-issues'
import { useShortcuts } from '@/hooks/use-shortcuts'
import { browserSessionStorage, loadIssueList, resolveNeighbours } from '@/lib/issue-nav'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ActivitySection, type ActivityHandle } from '@/components/issue/activity-section'
import { AttachmentsSection, useAttachmentUpload } from '@/components/issue/attachments-section'
import { ChildIssues, type ChildIssuesHandle } from '@/components/issue/child-issues'
import { DescriptionSection, type DescriptionHandle } from '@/components/issue/description-section'
import { DetailsPanel, type DetailsHandle } from '@/components/issue/details-panel'
import { IssueDialogs, type IssueDialogKind } from '@/components/issue/issue-dialogs'
import { IssueHeader, type IssueHeaderHandle } from '@/components/issue/issue-header'
import { LinkedIssues, type LinkedIssuesHandle } from '@/components/issue/linked-issues'
import { CustomersSection } from '@/components/issue/customers-section'
import { DevelopmentSection } from '@/components/issue/development-section'
import { ApprovalsSection } from '@/components/issue/approvals-section'
import { AgentsSection } from '@/components/issue/agents-section'
import { ModuleIssuePanels } from '@/components/module-issue-panels'
import { IssueViewSkeleton } from '@/components/issue/primitives'
import { PresenceAvatars } from '@/components/presence-avatars'
import { PluginPanels } from '@/components/plugin-panel'
import { AiIssuePanel } from '@/components/ai/ai-issue-panel'
import { StoryPointsField } from '@/components/story-points-field'
import { useLiveInvalidation, usePresence } from '@/hooks/use-realtime'
import { usePublishCommandTargets, useCommandLineStore } from '@/hooks/use-command-line'
import { useUndoableAction } from '@/hooks/use-undoable'
import { IssueListPanel, useIssuePanelCollapsed } from '@/components/issue/issue-list-panel'
import { QuickOperations, type QuickOperation } from '@/components/issue/quick-operations'

function scrollToId(id: string) {
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
}

/**
 * Jira-style issue view. This file only composes: data and behaviour live in components/issue/*,
 * pure logic in lib/issue-view.ts. All hooks run before any early return (Rules of Hooks).
 */
export default function IssueDetailPage() {
  const { tr } = useI18n();

  const { key } = useParams() as { key: string }
  const { data: issue, isLoading, error } = useIssue(key)
  // offline reading (opt-in in Personal settings): keep the text of the issue that was just read
  useEffect(() => { if (issue) void saveIssueOffline(issue as any) }, [issue])
  const { data: attachments } = useIssueAttachments(key)
  const { data: myself } = useMyself()
  const updateIssue = useUpdateIssue()
  const uploader = useAttachmentUpload(key)
  // Live updates: refetch when someone else changes this issue; show who else is looking
  useLiveInvalidation(`issue:${key}`, { queryKeys: [['issue', key], ['issues', 'search']], toastOthers: true })
  const viewers = usePresence(`issue:${key}`)

  const headerRef = useRef<IssueHeaderHandle>(null)
  const detailsRef = useRef<DetailsHandle>(null)
  const descriptionRef = useRef<DescriptionHandle>(null)
  const activityRef = useRef<ActivityHandle>(null)
  const childrenRef = useRef<ChildIssuesHandle>(null)
  const linksRef = useRef<LinkedIssuesHandle>(null)

  const [dialog, setDialog] = useState<IssueDialogKind>(null)
  const [quickOpen, setQuickOpen] = useState(false)

  const resolveAttachment = useMemo(() => {
    const byName = new Map((attachments || []).map((a) => [a.filename, `/rest/api/2/attachment/${a.id}`]))
    return (name: string) => byName.get(name) ?? null
  }, [attachments])

  // The command line (Ctrl/Cmd+Alt+J) applies to this issue.
  const commandTargets = useMemo(
    () => (issue ? [{ key: issue.key, projectId: issue.fields.project.id, projectKey: issue.fields.project.key }] : []),
    [issue],
  )
  usePublishCommandTargets(commandTargets)

  const undoableAction = useUndoableAction()
  const assignToMe = () => {
    if (!myself) return
    const previous = issue?.fields.assignee ?? null
    updateIssue.mutate(
      { key, fields: { assignee: { id: myself.id } }, lookup: { users: [{ id: myself.id, displayName: myself.displayName || myself.name }] } },
      {
        onSuccess: () => {
          if (previous?.id === myself.id) { toast(tr('Already assigned to you'), 'info'); return }
          undoableAction({
            message: tr('Assigned to you'),
            undo: () => updateIssue.mutateAsync({ key, fields: { assignee: previous ? { id: previous.id } : null }, lookup: previous ? { users: [{ id: previous.id, displayName: previous.displayName }] } : undefined }).then(() => undefined),
          })
        },
        onError: (e: any) => toast(e?.message || tr('Failed to assign'), 'error'),
      },
    )
  }

  const actions = {
    assign: () => { detailsRef.current?.openAssignee(); scrollToId('field-assignee') },
    assignToMe,
    flag: () => {
      const next = !issue?.fields.flagged
      updateIssue.mutate(
        { key, fields: { flagged: next } },
        { onSuccess: () => toast(next ? tr('Flagged as an impediment') : tr('Flag removed'), 'success'), onError: (e: any) => toast(e?.message || tr('Could not change the flag'), 'error') },
      )
    },
    comment: () => activityRef.current?.focusComment(),
    labels: () => { detailsRef.current?.openLabels(); scrollToId('field-labels') },
    editDescription: () => { descriptionRef.current?.edit(); scrollToId('issue-description') },
  }
  const router = useRouter()

  // Position in the list the user came from (the issue list stores its result keys in sessionStorage).
  const [neighbours, setNeighbours] = useState<ReturnType<typeof resolveNeighbours>>(null)
  useEffect(() => { setNeighbours(resolveNeighbours(loadIssueList(browserSessionStorage()), key)) }, [key])
  const [panelCollapsed, togglePanel] = useIssuePanelCollapsed()
  const step = (target: string | null | undefined) => { if (target) router.push(`/issues/${target}`) }

  // Keys come from the shortcut table (lib/shortcuts); the same table drives the Ctrl+/ help.
  useShortcuts('issueView', {
    'issueView.assign': actions.assign,
    'issueView.assignToMe': actions.assignToMe,
    'issueView.flag': actions.flag,
    'issueView.comment': actions.comment,
    'issueView.labels': actions.labels,
    'issueView.editDescription': actions.editDescription,
    'issueView.quickOps': () => setQuickOpen(true),
    'issueView.prev': () => (neighbours?.prev ? step(neighbours.prev) : false),
    'issueView.next': () => (neighbours?.next ? step(neighbours.next) : false),
  })

  if (isLoading) {
    return (
      <AppLayout>
        <IssueViewSkeleton />
      </AppLayout>
    )
  }

  if (error || !issue) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-96 gap-4 text-center" role="alert">
          <div className="text-body text-[var(--text-primary)]">{error?.message || tr('Issue not found')}</div>
          <Link href="/issues" className="veqsio-btn-secondary">{tr('Back to issues')}</Link>
        </div>
      </AppLayout>
    )
  }

  const operations: QuickOperation[] = [
    { id: 'assign', label: tr('Assign'), hint: 'A', run: actions.assign },
    { id: 'assign-me', label: tr('Assign to me'), hint: 'I', run: actions.assignToMe },
    { id: 'flag', label: issue.fields.flagged ? tr('Remove flag') : tr('Add flag'), hint: 'F', run: actions.flag },
    { id: 'comment', label: tr('Comment'), hint: 'M', run: actions.comment },
    { id: 'labels', label: tr('Edit labels'), hint: 'L', run: actions.labels },
    { id: 'description', label: tr('Edit description'), hint: 'E', run: actions.editDescription },
    { id: 'command', label: tr('Command line'), hint: 'Ctrl+Alt+J', run: () => useCommandLineStore.getState().openBar() },
    { id: 'status', label: tr('Change status'), run: () => headerRef.current?.openStatus() },
    { id: 'attach', label: tr('Attach files'), run: uploader.open },
    ...(issue.fields.issuetype?.subtask ? [] : [{ id: 'subtask', label: tr('Create sub-task'), run: () => childrenRef.current?.focusAdd() }]),
    { id: 'link', label: tr('Link issue'), run: () => linksRef.current?.openAdd() },
    { id: 'clone', label: tr('Clone'), run: () => setDialog('clone') },
    { id: 'move', label: tr('Move'), run: () => setDialog('move') },
    { id: 'change-type', label: tr('Change type'), run: () => setDialog('change-type') },
    { id: 'delete', label: tr('Delete'), run: () => setDialog('delete') },
  ]

  return (
    <AppLayout>
      <div className={`issue-compact grid grid-cols-1 gap-6 items-start ${panelCollapsed ? 'lg:grid-cols-[2.25rem_minmax(0,1fr)] lg:gap-x-3' : 'lg:grid-cols-[260px_minmax(0,1fr)]'}`}>
      <IssueListPanel issueKey={key} projectKey={issue.fields.project.key} collapsed={panelCollapsed} onToggle={togglePanel} />
      <div className="space-y-4 min-w-0">
        <input
          ref={uploader.inputRef}
          type="file"
          multiple
          className="hidden"
          tabIndex={-1}
          aria-label={tr('Attach files')}
          onChange={(e) => void uploader.upload(e.target.files)}
        />

        {neighbours && (
          <nav aria-label={tr('Issues in your list')} className={`flex items-center gap-2 text-sm text-[var(--text-secondary)] ${panelCollapsed ? '' : 'lg:hidden'}`}>
            <button
              type="button"
              className="veqsio-btn-secondary px-2 py-1 disabled:opacity-40"
              disabled={!neighbours.prev}
              onClick={() => step(neighbours.prev)}
              title={neighbours.prev ? tr('Previous: {key} ([)', { key: neighbours.prev }) : tr('This is the first issue')}
              aria-label={tr('Previous issue in list')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span data-testid="issue-position" aria-live="polite">{neighbours.position} {tr('of')} {neighbours.total}</span>
            <button
              type="button"
              className="veqsio-btn-secondary px-2 py-1 disabled:opacity-40"
              disabled={!neighbours.next}
              onClick={() => step(neighbours.next)}
              title={neighbours.next ? tr('Next: {key} (])', { key: neighbours.next }) : tr('This is the last issue')}
              aria-label={tr('Next issue in list')}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <Link href="/issues" className="ml-1 text-caption text-[var(--text-tertiary)] hover:underline">{tr('Back to list')}</Link>
          </nav>
        )}

        <IssueHeader
          ref={headerRef}
          issue={issue}
          actions={{
            attach: uploader.open,
            addSubtask: () => childrenRef.current?.focusAdd(),
            addLink: () => linksRef.current?.openAdd(),
            clone: () => setDialog('clone'),
            move: () => setDialog('move'),
            remove: () => setDialog('delete'),
          }}
        />

        {viewers.length > 0 && (
          <div className="flex items-center gap-2 text-caption text-[var(--text-tertiary)]">
            <span>{tr('Also viewing')}</span>
            <PresenceAvatars users={viewers} />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
          <main className="space-y-8 min-w-0" aria-label={tr('Issue content')}>
            <DescriptionSection ref={descriptionRef} issueKey={key} description={issue.fields.description} resolveAttachment={resolveAttachment} />
            <ChildIssues ref={childrenRef} issue={issue} />
            <LinkedIssues ref={linksRef} issue={issue} />
            <ModuleIssuePanels issueKey={key} projectKey={issue.fields.project?.key || ''} location="content" />
            <DevelopmentSection issueKey={key} />
            <CustomersSection issueKey={key} />
            <PluginPanels location="issue.tab" context={{ issue: key, project: issue.fields.project.key }} />
            <ApprovalsSection issueKey={key} projectKey={issue.fields.project?.key || ''} />
            <AgentsSection issueKey={key} />
            <AttachmentsSection issueKey={key} uploader={uploader} />
            <ActivitySection ref={activityRef} issueKey={key} resolveAttachment={resolveAttachment} />
          </main>

          <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1">
            <div className="space-y-4">
              <DetailsPanel ref={detailsRef} issue={issue} />
              <div className="veqsio-card">
                <StoryPointsField
                  value={issue.fields.storyPoints}
                  onSave={async (storyPoints) => {
                    await updateIssue.mutateAsync({ key, fields: { storyPoints } })
                    toast(tr('Story points updated'), 'success')
                  }}
                />
              </div>
              <MilestonesField issueKey={key} projectKey={issue.fields.project.key} />
              <PluginPanels location="issue.sidebar" context={{ issue: key, project: issue.fields.project.key }} />
              <AiIssuePanel issueKey={key} />
            </div>
          </div>
        </div>
      </div>
      </div>

      <IssueDialogs issue={issue} dialog={dialog} onClose={() => setDialog(null)} />
      <QuickOperations isOpen={quickOpen} onClose={() => setQuickOpen(false)} operations={operations} />
    </AppLayout>
  )
}
