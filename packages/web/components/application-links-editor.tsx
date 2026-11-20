'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  useApplicationLinks,
  useCreateApplicationLink,
  useUpdateApplicationLink,
  useDeleteApplicationLink,
  useSyncDevData,
} from '@/hooks/use-application-links'
import { Link2, Plus, Trash2, Edit3, RefreshCw, Globe, Lock, Unlock, GitBranch, Code2, FileText, Workflow, Server, Boxes } from 'lucide-react'
import { confirmDialog } from '@/components/dialogs'

const TYPE_ICONS: Record<string, any> = {
  github: GitBranch,
  gitlab: Code2,
  bitbucket: GitBranch,
  confluence: FileText,
  bamboo: Workflow,
  jenkins: Server,
  custom: Boxes,
}

const TYPE_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  confluence: 'Confluence',
  bamboo: 'Bamboo',
  jenkins: 'Jenkins',
  custom: 'Custom',
}

export function ApplicationLinksEditor() {
  const { tr } = useI18n();

  const { data, isLoading } = useApplicationLinks()
  const createLink = useCreateApplicationLink()
  const updateLink = useUpdateApplicationLink()
  const deleteLink = useDeleteApplicationLink()
  const syncDev = useSyncDevData()

  const [showCreate, setShowCreate] = useState(false)
  const [editingLink, setEditingLink] = useState<any>(null)
  const [form, setForm] = useState({
    name: '',
    type: 'github',
    baseUrl: '',
    displayUrl: '',
    authType: 'none',
    token: '',
    username: '',
    password: '',
    owner: '',
    repo: '',
    isPrimary: false,
    active: true,
  })

  const links = data?.values || []

  const resetForm = () => {
    setForm({
      name: '',
      type: 'github',
      baseUrl: '',
      displayUrl: '',
      authType: 'none',
      token: '',
      username: '',
      password: '',
      owner: '',
      repo: '',
      isPrimary: false,
      active: true,
    })
  }

  const handleCreate = async () => {
    try {
      const credentials: Record<string, string> = {}
      if (form.authType === 'bearer' && form.token) credentials.token = form.token
      if (form.authType === 'basic') {
        if (form.username) credentials.username = form.username
        if (form.password) credentials.password = form.password
      }
      const config: Record<string, string> = {}
      if (form.owner) config.owner = form.owner
      if (form.repo) config.repo = form.repo

      await createLink.mutateAsync({
        name: form.name,
        type: form.type as any,
        baseUrl: form.baseUrl,
        displayUrl: form.displayUrl || undefined,
        authType: form.authType as any,
        credentials,
        config,
        isPrimary: form.isPrimary,
        active: form.active,
      })
      toast(tr('Application link created'), 'success')
      setShowCreate(false)
      resetForm()
    } catch (e: any) {
      toast(e.message || tr('Failed to create link'), 'error')
    }
  }

  const handleUpdate = async () => {
    if (!editingLink) return
    try {
      const credentials: Record<string, string> = {}
      if (form.authType === 'bearer' && form.token) credentials.token = form.token
      if (form.authType === 'basic') {
        if (form.username) credentials.username = form.username
        if (form.password) credentials.password = form.password
      }
      const config: Record<string, string> = {}
      if (form.owner) config.owner = form.owner
      if (form.repo) config.repo = form.repo

      await updateLink.mutateAsync({
        id: editingLink.id,
        name: form.name,
        type: form.type as any,
        baseUrl: form.baseUrl,
        displayUrl: form.displayUrl || undefined,
        authType: form.authType as any,
        credentials,
        config,
        isPrimary: form.isPrimary,
        active: form.active,
      })
      toast(tr('Application link updated'), 'success')
      setEditingLink(null)
      resetForm()
    } catch (e: any) {
      toast(e.message || tr('Failed to update link'), 'error')
    }
  }

  const handleDelete = async (id: number) => {
    if (!(await confirmDialog(tr('Delete this application link?')))) return
    try {
      await deleteLink.mutateAsync(id)
      toast(tr('Application link deleted'), 'success')
    } catch (e: any) {
      toast(e.message || tr('Failed to delete link'), 'error')
    }
  }

  const handleSync = async (id: number) => {
    try {
      await syncDev.mutateAsync(id)
      toast(tr('Development data synced'), 'success')
    } catch (e: any) {
      toast(e.message || tr('Sync failed'), 'error')
    }
  }

  const openEdit = (link: any) => {
    setEditingLink(link)
    setForm({
      name: link.name,
      type: link.type,
      baseUrl: link.baseUrl,
      displayUrl: link.displayUrl || '',
      authType: link.authType,
      token: link.credentials?.token || '',
      username: link.credentials?.username || '',
      password: link.credentials?.password || '',
      owner: link.config?.owner || '',
      repo: link.config?.repo || '',
      isPrimary: link.isPrimary,
      active: link.active,
    })
  }

  const formContent = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Name')}</label>
          <input
            type="text"
            className="veqsio-input w-full"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Type')}</label>
          <select
            className="veqsio-input w-full"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            <option value="github">{tr('GitHub')}</option>
            <option value="gitlab">{tr('GitLab')}</option>
            <option value="bitbucket">{tr('Bitbucket')}</option>
            <option value="confluence">{tr('Confluence')}</option>
            <option value="bamboo">{tr('Bamboo')}</option>
            <option value="jenkins">{tr('Jenkins')}</option>
            <option value="custom">{tr('Custom')}</option>
          </select>
        </div>
      </div>

      <div>
        <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Base URL')}</label>
        <input
          type="url"
          className="veqsio-input w-full"
          placeholder="https://github.com"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        />
      </div>

      <div>
        <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Display URL (optional)')}</label>
        <input
          type="url"
          className="veqsio-input w-full"
          value={form.displayUrl}
          onChange={(e) => setForm({ ...form, displayUrl: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Auth type')}</label>
          <select
            className="veqsio-input w-full"
            value={form.authType}
            onChange={(e) => setForm({ ...form, authType: e.target.value })}
          >
            <option value="none">{tr('None')}</option>
            <option value="bearer">{tr('Bearer token')}</option>
            <option value="basic">{tr('Basic auth')}</option>
          </select>
        </div>
        {form.type === 'github' || form.type === 'gitlab' || form.type === 'bitbucket' ? (
          <>
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Owner / Org')}</label>
              <input
                type="text"
                className="veqsio-input w-full"
                value={form.owner}
                onChange={(e) => setForm({ ...form, owner: e.target.value })}
              />
            </div>
            <div>
              <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Repository')}</label>
              <input
                type="text"
                className="veqsio-input w-full"
                value={form.repo}
                onChange={(e) => setForm({ ...form, repo: e.target.value })}
              />
            </div>
          </>
        ) : null}
      </div>

      {form.authType === 'bearer' && (
        <div>
          <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Token')}</label>
          <input
            type="password"
            className="veqsio-input w-full"
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
          />
        </div>
      )}

      {form.authType === 'basic' && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Username')}</label>
            <input
              type="text"
              className="veqsio-input w-full"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </div>
          <div>
            <label className="text-caption font-medium text-[var(--text-secondary)] block mb-1">{tr('Password')}</label>
            <input
              type="password"
              className="veqsio-input w-full"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-body-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={form.isPrimary}
            onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
          />
          {tr('Primary link')} </label>
        <label className="flex items-center gap-2 text-body-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          {tr('Active')} </label>
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)] flex items-center gap-2">
          <Link2 className="w-5 h-5 text-[var(--text-tertiary)]" />
          {tr('Application Links')} </h2>
        <button onClick={() => { resetForm(); setShowCreate(true) }} className="veqsio-btn-primary flex items-center gap-1">
          <Plus className="w-4 h-4" />
          {tr('Add link')} </button>
      </div>

      <p className="text-body-sm text-[var(--text-secondary)]">
        {tr('Connect Veqsio with other tools like GitHub, GitLab, Confluence, and CI/CD servers. Linked development data appears in the issue detail')} <strong>{tr('Development')}</strong> {tr('panel.')}
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner size="lg" />
        </div>
      ) : links.length === 0 ? (
        <EmptyState
          icon="link"
          title={tr('No application links')}
          description={tr('Add your first link to start seeing development data in issues.')}
        />
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden divide-y divide-[var(--surface-3)]">
          {links.map((link) => {
            const Icon = TYPE_ICONS[link.type] || Boxes
            return (
              <div key={link.id} className="px-4 py-3 flex items-start justify-between gap-4 hover:bg-[var(--surface-1)] transition-colors">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="mt-0.5 p-1.5 bg-[var(--surface-2)] rounded-md">
                    <Icon className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-body-sm font-medium text-[var(--text-primary)]">{link.name}</span>
                      {link.isPrimary && <span className="text-caption px-1.5 py-0.5 bg-[var(--brand-500)] text-white rounded-full">{tr('Primary')}</span>}
                      {!link.active && <span className="text-caption px-1.5 py-0.5 bg-[var(--surface-3)] text-[var(--text-tertiary)] rounded-full">{tr('Inactive')}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-caption text-[var(--text-tertiary)]">
                      <span>{TYPE_LABELS[link.type] ? tr(TYPE_LABELS[link.type]) : link.type}</span>
                      <a href={link.baseUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[var(--brand-500)] hover:underline">
                        <Globe className="w-3 h-3" />
                        {link.baseUrl}
                      </a>
                      <span className="flex items-center gap-1">
                        {link.authType === 'none' ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                        {link.authType}
                      </span>
                    </div>
                    {link.config?.owner && link.config?.repo && (
                      <div className="text-caption text-[var(--text-secondary)] mt-1">
                        {link.config.owner}/{link.config.repo}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {(link.type === 'github' || link.type === 'gitlab' || link.type === 'bitbucket') && (
                    <button
                      onClick={() => handleSync(link.id)}
                      disabled={syncDev.isPending}
                      className="veqsio-btn-secondary flex items-center gap-1 text-caption"
                      title={tr('Sync development data')}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      {tr('Sync')} </button>
                  )}
                  <button
                    onClick={() => openEdit(link)}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] p-1"
                    title={tr('Edit')}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(link.id)}
                    className="text-[var(--text-tertiary)] hover:text-red-500 p-1"
                    title={tr('Delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title={tr('Add application link')}>
        <div className="space-y-4">
          {formContent}
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="veqsio-btn-secondary">{tr('Cancel')}</button>
            <button onClick={handleCreate} disabled={createLink.isPending || !form.name || !form.baseUrl} className="veqsio-btn-primary">
              {createLink.isPending ? <Spinner size="sm" /> : tr('Create')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!editingLink} onClose={() => { setEditingLink(null); resetForm() }} title={tr('Edit application link')}>
        <div className="space-y-4">
          {formContent}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setEditingLink(null); resetForm() }} className="veqsio-btn-secondary">{tr('Cancel')}</button>
            <button onClick={handleUpdate} disabled={updateLink.isPending} className="veqsio-btn-primary">
              {updateLink.isPending ? <Spinner size="sm" /> : tr('Save')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
