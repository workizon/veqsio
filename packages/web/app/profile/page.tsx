'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AppLayout } from '@/components/app-layout'
import { Breadcrumb } from '@/components/breadcrumb'
import { EmptyState } from '@/components/empty-state'
import { Spinner } from '@/components/spinner'
import { useMyIssues } from '@/hooks/use-dashboards'
import { useMyself, useUpdateMyself } from '@/hooks/use-issues'
import { useActivityStream } from '@/hooks/use-dashboards'
import { Avatar } from '@/components/avatar'
import { toast } from '@/components/toast'
import { Edit3, Mail, User, CheckCircle2, Clock, ArrowRight, KeyRound } from 'lucide-react'

export default function ProfilePage() {
  const { data: user, isLoading: userLoading } = useMyself()
  const { data: myIssues, isLoading: issuesLoading } = useMyIssues()
  const { data: activity, isLoading: activityLoading } = useActivityStream(10)

  const update = useUpdateMyself()
  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState('')

  if (userLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-[60vh]">
          <Spinner size="lg" />
        </div>
      </AppLayout>
    )
  }

  if (!user) {
    return (
      <AppLayout>
        <EmptyState icon="frown" title="Profile not found" description="Could not load your profile." />
      </AppLayout>
    )
  }

  const handleSave = async () => {
    const name = displayName.trim()
    if (!name) { toast('Display name cannot be empty', 'error'); return }
    if (name === (user.name || user.displayName)) { setEditing(false); return }
    try {
      await update.mutateAsync({ displayName: name })
      toast('Profile updated', 'success')
      setEditing(false)
    } catch (e: any) {
      toast(e?.message || 'Could not update profile', 'error')
    }
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <Breadcrumb items={[{ label: 'Profile' }]} />

        {/* Profile card */}
        <div className="veqsio-card flex flex-col sm:flex-row items-start gap-4">
          <Avatar name={user.name || user.displayName || 'User'} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h1 className="text-heading-1 text-[var(--text-primary)]">{user.name || user.displayName}</h1>
                <p className="text-body-sm text-[var(--text-secondary)]">@{user.key || user.username}</p>
              </div>
              <button
                onClick={() => {
                  setDisplayName(user.name || user.displayName || '')
                  setEditing(!editing)
                }}
                className="veqsio-btn-secondary flex items-center gap-1"
              >
                <Edit3 className="w-4 h-4" />
                <span className="hidden sm:inline">{editing ? 'Cancel' : 'Edit'}</span>
              </button>
            </div>

            {editing ? (
              <div className="mt-4 space-y-3 max-w-md">
                <div>
                  <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">Display name</label>
                  <input
                    type="text"
                    className="veqsio-input w-full"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                    autoFocus
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditing(false)} className="veqsio-btn-secondary">Cancel</button>
                  <button onClick={handleSave} disabled={update.isPending} className="veqsio-btn-primary disabled:opacity-60">{update.isPending ? 'Saving…' : 'Save'}</button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-4 text-body-sm text-[var(--text-secondary)]">
                <div className="flex items-center gap-1.5">
                  <Mail className="w-4 h-4 text-[var(--text-tertiary)]" />
                  {user.emailAddress || 'No email'}
                </div>
                <div className="flex items-center gap-1.5">
                  <User className="w-4 h-4 text-[var(--text-tertiary)]" />
                  {user.active ? 'Active' : 'Inactive'}
                </div>
              </div>
            )}

            {/* Nav links */}
            <div className="mt-4 pt-4 border-t border-[var(--surface-3)] flex flex-wrap gap-3">
              <Link
                href="/profile/tokens"
                className="inline-flex items-center gap-1.5 text-body-sm text-[var(--brand-500)] hover:underline"
              >
                <KeyRound className="w-4 h-4" />
                Personal Access Tokens
              </Link>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Assigned issues */}
          <div className="lg:col-span-2 space-y-4">
            <h2 className="text-heading-2 text-[var(--text-primary)] flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-[var(--text-tertiary)]" />
              My Issues
            </h2>
            {issuesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner />
              </div>
            ) : !myIssues?.length ? (
              <EmptyState icon="inbox" title="No assigned issues" description="Issues assigned to you will appear here." />
            ) : (
              <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
                {myIssues.map((issue) => (
                  <Link
                    key={issue.id}
                    href={`/issues/${issue.key}`}
                    className="flex items-center justify-between px-4 py-3 border-b border-[var(--surface-3)] last:border-0 hover:bg-[var(--surface-1)] transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-body-sm text-[var(--text-primary)] truncate">{issue.summary}</div>
                      <div className="text-caption text-[var(--text-tertiary)]">{issue.key} · {issue.status}</div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[var(--text-tertiary)] flex-shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Activity stream */}
          <div className="space-y-4">
            <h2 className="text-heading-2 text-[var(--text-primary)] flex items-center gap-2">
              <Clock className="w-5 h-5 text-[var(--text-tertiary)]" />
              Activity
            </h2>
            {activityLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner />
              </div>
            ) : !activity?.length ? (
              <EmptyState icon="history" title="No recent activity" description="Your actions will appear here." />
            ) : (
              <div className="space-y-3">
                {activity.map((item) => (
                  <div key={item.id} className="veqsio-card">
                    <p className="text-body-sm text-[var(--text-primary)]">
                      <span className="font-medium">{item.user}</span>{' '}
                      {item.action}{' '}
                      <Link href={`/issues/${item.issueKey}`} className="text-[var(--brand-500)] hover:underline">
                        {item.issueKey}
                      </Link>
                    </p>
                    <p className="text-caption text-[var(--text-tertiary)] mt-1">
                      {new Date(item.timestamp).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  )
}
