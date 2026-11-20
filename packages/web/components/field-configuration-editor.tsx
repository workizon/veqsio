'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState } from 'react'
import {
  Plus,
  Trash2,
  ChevronRight,
  Save,
  SlidersHorizontal,
  Eye,
  EyeOff,
  Asterisk,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  useFieldConfigurations,
  useCreateFieldConfiguration,
  useUpdateFieldConfiguration,
  useDeleteFieldConfiguration,
} from '@/hooks/use-admin'
import { useFieldList } from '@/hooks/use-admin'
import type { FieldConfiguration } from '@/hooks/use-admin'
import { confirmDialog } from '@/components/dialogs'

export function FieldConfigurationEditor() {
  const { tr } = useI18n();

  const [createOpen, setCreateOpen] = useState(false)
  const [editingConfig, setEditingConfig] = useState<FieldConfiguration | null>(null)

  const { data, isLoading } = useFieldConfigurations()
  const createConfig = useCreateFieldConfiguration()
  const deleteConfig = useDeleteFieldConfiguration()

  const configs = data?.configurations || []

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createConfig.mutateAsync({
        name: fd.get('name') as string,
        description: (fd.get('description') as string) || undefined,
      })
      toast(tr('Field configuration created'), 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || tr('Failed to create configuration'), 'error')
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!(await confirmDialog(`Delete field configuration "${name}"?`))) return
    try {
      await deleteConfig.mutateAsync(id)
      toast(tr('Configuration deleted'), 'success')
    } catch (err: any) {
      toast(err.message || tr('Failed to delete configuration'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">{tr('Field configurations')}</h2>
        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          {tr('Create Configuration')} </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : configs.length === 0 ? (
        <EmptyState
          icon="folder"
          title={tr('No field configurations found')}
          description={tr('Create a configuration to define field visibility and requiredness.')}
          action={
            <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('Create Configuration')} </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {configs.map((cf) => (
            <div key={cf.id} className="veqsio-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                    <SlidersHorizontal className="w-5 h-5 text-[var(--text-secondary)]" />
                  </div>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{cf.name}</div>
                    {cf.description && (
                      <div className="text-xs text-[var(--text-tertiary)]">{cf.description}</div>
                    )}
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                      {cf.items.length} field{cf.items.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingConfig(cf)
                    }}
                    className="veqsio-btn-ghost p-1.5"
                  >
                    <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(cf.id, cf.name)
                    }}
                    className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={tr('Create field configuration')}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Name')}</label>
            <input name="name" type="text" required className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{tr('Description')}</label>
            <input name="description" type="text" className="veqsio-input w-full" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="veqsio-btn-secondary">
              {tr('Cancel')} </button>
            <button type="submit" disabled={createConfig.isPending} className="veqsio-btn-primary">
              {createConfig.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!editingConfig} onClose={() => setEditingConfig(null)} title={editingConfig?.name || tr('Edit Configuration')} size="lg">
        {editingConfig && <ConfigEditPanel config={editingConfig} onClose={() => setEditingConfig(null)} />}
      </Modal>
    </div>
  )
}

function ConfigEditPanel({ config, onClose }: { config: FieldConfiguration; onClose: () => void }) {
  const { tr } = useI18n();

  const updateConfig = useUpdateFieldConfiguration()
  const { data: fieldsData } = useFieldList()
  const allFields = fieldsData || []

  const [items, setItems] = useState(
    config.items.map(i => ({
      ...i,
      fieldName: allFields.find(f => Number(f.id) === i.fieldId && f.custom === i.isCustomField)?.name || `Field ${i.fieldId}`,
    }))
  )

  async function handleSave() {
    try {
      await updateConfig.mutateAsync({
        id: config.id,
        items: items.map(i => ({
          id: i.id,
          fieldId: i.fieldId,
          isCustomField: i.isCustomField,
          isVisible: i.isVisible,
          isRequired: i.isRequired,
          renderer: i.renderer || undefined,
        })),
      })
      toast(tr('Configuration updated'), 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || tr('Failed to update configuration'), 'error')
    }
  }

  function toggleVisible(idx: number) {
    setItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], isVisible: !next[idx].isVisible }
      return next
    })
  }

  function toggleRequired(idx: number) {
    setItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], isRequired: !next[idx].isRequired }
      return next
    })
  }

  function addField(fieldId: number, isCustomField: boolean) {
    const field = allFields.find(f => Number(f.id) === fieldId && f.custom === isCustomField)
    if (!field) return
    setItems(prev => [
      ...prev,
      {
        id: 0,
        fieldId,
        isCustomField,
        isVisible: true,
        isRequired: false,
        renderer: null,
        fieldName: field.name,
      },
    ])
  }

  function removeField(idx: number) {
    setItems(prev => prev.filter((_, i) => i !== idx))
  }

  const usedKeys = new Set(items.map(i => `${i.fieldId}:${i.isCustomField}`))

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
        <select
          onChange={e => {
            const [id, kind] = e.target.value.split(':')
            if (id) addField(Number(id), kind === 'custom')
            e.target.value = ''
          }}
          className="veqsio-input flex-1 w-full"
        >
          <option value="">{tr('Add field...')}</option>
          {allFields.map(f => {
            const key = `${f.id}:${f.custom ? 'custom' : 'system'}`
            if (usedKeys.has(key)) return null
            return (
              <option key={key} value={key}>
                {f.name} {f.custom ? '(Custom)' : '(System)'}
              </option>
            )
          })}
        </select>
      </div>

      <div className="border border-[var(--surface-3)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="veqsio-table-header">
              <th className="text-left">{tr('Field')}</th>
              <th className="text-left">{tr('Visible')}</th>
              <th className="text-left">{tr('Required')}</th>
              <th className="text-right">{tr('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-0">
                  <EmptyState icon="folder" title={tr('No fields configured')} description={tr('Add fields to configure their behavior.')} />
                </td>
              </tr>
            ) : (
              items.map((item, idx) => (
                <tr key={`${item.fieldId}-${item.isCustomField}`} className="veqsio-table-row">
                  <td className="px-4 py-2">
                    <div className="font-medium text-[var(--text-primary)]">{item.fieldName}</div>
                    {item.isCustomField && <div className="text-xs text-[var(--text-tertiary)]">{tr('Custom')}</div>}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => toggleVisible(idx)}
                      className={`veqsio-btn-ghost p-1.5 ${item.isVisible ? 'text-[var(--success)]' : 'text-[var(--text-tertiary)]'}`}
                    >
                      {item.isVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => toggleRequired(idx)}
                      className={`veqsio-btn-ghost p-1.5 ${item.isRequired ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]'}`}
                    >
                      <Asterisk className="w-4 h-4" />
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => removeField(idx)}
                      className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="veqsio-btn-secondary">{tr('Cancel')}</button>
        <button onClick={handleSave} disabled={updateConfig.isPending} className="veqsio-btn-primary flex items-center gap-1.5">
          <Save className="w-4 h-4" />
          {updateConfig.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
