'use client'


import { useI18n } from '@/hooks/use-i18n'
import { PROJECT_AVATAR_PRESETS, ProjectAvatar, projectAvatarPresetUrl } from '@/components/project-avatar'
import { useState, useRef, useCallback } from 'react'
import { Check, Upload } from 'lucide-react'
import { toast } from '@/components/toast'
import { Select } from '@/components/select'
import type { ProjectDetail } from '@/hooks/use-project-admin'

interface ProjectSettingsFormProps {
  project: ProjectDetail
  users: { id: number; displayName: string }[]
  onUpdate: (data: {
    name?: string
    description?: string
    leadId?: number
    category?: string
    avatarUrl?: string
  }) => void
  onUploadAvatar: (file: File) => void
  isUpdating: boolean
  isUploading: boolean
}

export function ProjectSettingsForm({
  project,
  users,
  onUpdate,
  onUploadAvatar,
  isUpdating,
  isUploading,
}: ProjectSettingsFormProps) {
  const { tr } = useI18n();

  const [form, setForm] = useState({
    name: project.name,
    description: project.description || '',
    leadId: project.lead?.id ?? '',
    category: project.projectCategory || '',
  })
  const [hasChanges, setHasChanges] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleChange = useCallback(
    (field: string, value: string | number) => {
      setForm((prev) => ({ ...prev, [field]: value }))
      setHasChanges(true)
    },
    []
  )

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const payload: Parameters<typeof onUpdate>[0] = {}
      if (form.name !== project.name) payload.name = form.name
      if (form.description !== (project.description || '')) payload.description = form.description
      if (form.leadId !== (project.lead?.id ?? '')) payload.leadId = Number(form.leadId) || undefined
      if (form.category !== (project.projectCategory || '')) payload.category = form.category
      onUpdate(payload)
      setHasChanges(false)
    },
    [form, project, onUpdate]
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      if (!file.type.startsWith('image/')) {
        toast(tr('Only image files are allowed'), 'error')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        toast(tr('Image must be under 5MB'), 'error')
        return
      }
      onUploadAvatar(file)
    },
    [onUploadAvatar]
  )

  const userOptions = [
    { value: '', label: tr('Unassigned') },
    ...users.map((u) => ({ value: String(u.id), label: u.displayName })),
  ]

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Avatar */}
      <div className="flex items-center gap-4">
        <div className="relative">
          <div className="w-20 h-20 rounded-lg overflow-hidden">
            <ProjectAvatar projectKey={project.key} name={project.name} src={project.avatarUrl} size={80} />
          </div>
          {isUploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={isUploading}
            className="veqsio-btn-secondary flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            {tr('Upload avatar')} </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{tr('JPG, PNG or GIF up to 5MB')}</p>
        </div>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-[var(--text-primary)] mb-2">{tr('Preset gallery')}</legend>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-9">
          <button
            type="button"
            title={tr('Generated initials')}
            aria-label={tr('Use generated initials')}
            aria-pressed={!project.avatarUrl}
            disabled={isUpdating || isUploading}
            onClick={() => onUpdate({ avatarUrl: '' })}
            className="relative rounded-xl p-1.5 border border-[var(--surface-3)] hover:border-[var(--brand-400)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] disabled:opacity-50"
          >
            <ProjectAvatar projectKey={project.key} name={project.name} size={42} />
            {!project.avatarUrl && <Check className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-[var(--brand-600)] p-0.5 text-white" aria-hidden />}
          </button>
          {PROJECT_AVATAR_PRESETS.map((preset) => {
            const url = projectAvatarPresetUrl(preset.id)!
            const selected = project.avatarUrl === url
            return (
              <button
                key={preset.id}
                type="button"
                title={tr(preset.label)}
                aria-label={tr('Use {name} avatar', { name: tr(preset.label) })}
                aria-pressed={selected}
                disabled={isUpdating || isUploading}
                onClick={() => onUpdate({ avatarUrl: url })}
                className="relative rounded-xl p-1.5 border border-[var(--surface-3)] hover:border-[var(--brand-400)] hover:-translate-y-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] disabled:opacity-50"
              >
                <ProjectAvatar projectKey={project.key} name={preset.label} src={url} size={42} />
                {selected && <Check className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-[var(--brand-600)] p-0.5 text-white" aria-hidden />}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">{tr('Choose a polished preset, keep generated initials, or upload your own image.')}</p>
      </fieldset>

      {/* Name */}
      <div>
        <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">{tr('Project name')}</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => handleChange('name', e.target.value)}
          className="veqsio-input w-full"
          placeholder={tr('Project name')}
        />
      </div>

      {/* Key (read-only) */}
      <div>
        <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">{tr('Key')}</label>
        <input
          type="text"
          value={project.key}
          disabled
          className="veqsio-input w-full opacity-60 cursor-not-allowed"
        />
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{tr('The project key cannot be changed.')}</p>
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">{tr('Description')}</label>
        <textarea
          value={form.description}
          onChange={(e) => handleChange('description', e.target.value)}
          className="veqsio-input w-full min-h-[100px] resize-y"
          placeholder={tr('Describe this project')}
        />
      </div>

      {/* Lead */}
      <div>
        <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">{tr('Project lead')}</label>
        <Select
          value={String(form.leadId)}
          options={userOptions}
          onChange={(v) => handleChange('leadId', v)}
          placeholder={tr('Select a lead')}
        />
      </div>

      {/* Category */}
      <div>
        <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">{tr('Category')}</label>
        <input
          type="text"
          value={form.category}
          onChange={(e) => handleChange('category', e.target.value)}
          className="veqsio-input w-full"
          placeholder={tr('e.g. Software, Marketing')}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={!hasChanges || isUpdating}
          className="veqsio-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isUpdating ? tr('Saving...') : tr('Save changes')}
        </button>
        {hasChanges && (
          <button
            type="button"
            onClick={() => {
              setForm({
                name: project.name,
                description: project.description || '',
                leadId: project.lead?.id ?? '',
                category: project.projectCategory || '',
              })
              setHasChanges(false)
            }}
            className="veqsio-btn-ghost"
          >
            {tr('Cancel')} </button>
        )}
      </div>
    </form>
  )
}
