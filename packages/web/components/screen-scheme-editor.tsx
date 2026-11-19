'use client'

import { useState } from 'react'
import {
  Plus,
  Trash2,
  Monitor,
  Save,
  ChevronRight,
  X,
  GripVertical,
} from 'lucide-react'
import { toast } from './toast'
import { Modal } from './modal'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import {
  useScreens,
  useCreateScreen,
  useUpdateScreen,
  useDeleteScreen,
  useCreateScreenTab,
  useUpdateScreenTab,
  useDeleteScreenTab,
  useAddScreenTabField,
  useRemoveScreenTabField,
  useScreenFieldCatalog,
  useSetScreenFieldRequired,
} from '@/hooks/use-admin'
import { useFieldList } from '@/hooks/use-admin'
import type { Screen, ScreenTab } from '@/hooks/use-admin'
import { confirmDialog } from '@/components/dialogs'

export function ScreenSchemeEditor() {
  const [createOpen, setCreateOpen] = useState(false)
  const [editingScreen, setEditingScreen] = useState<Screen | null>(null)

  const { data, isLoading } = useScreens()
  const createScreen = useCreateScreen()
  const deleteScreen = useDeleteScreen()

  const screens = data?.screens || []
  // The dialog shows the live screen (fields added or changed in it appear at once), not the snapshot that was clicked.
  const liveScreen = editingScreen ? screens.find((x) => x.id === editingScreen.id) ?? editingScreen : null

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await createScreen.mutateAsync({
        name: fd.get('name') as string,
        description: (fd.get('description') as string) || undefined,
      })
      toast('Screen created', 'success')
      setCreateOpen(false)
      e.currentTarget.reset()
    } catch (err: any) {
      toast(err.message || 'Failed to create screen', 'error')
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!(await confirmDialog(`Delete screen "${name}"?`))) return
    try {
      await deleteScreen.mutateAsync(id)
      toast('Screen deleted', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to delete screen', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-[var(--text-primary)]">Screens</h2>
        <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Create Screen
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : screens.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No screens found"
          description="Create a screen to define field layouts for issue operations."
          action={
            <button onClick={() => setCreateOpen(true)} className="veqsio-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Create Screen
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {screens.map((s) => (
            <div key={s.id} className="veqsio-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                    <Monitor className="w-5 h-5 text-[var(--text-secondary)]" />
                  </div>
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{s.name}</div>
                    {s.description && (
                      <div className="text-xs text-[var(--text-tertiary)]">{s.description}</div>
                    )}
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                      {s.tabs.length} tab{s.tabs.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingScreen(s)
                    }}
                    className="veqsio-btn-ghost p-1.5"
                  >
                    <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(s.id, s.name)
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

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Create screen">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
            <input name="name" type="text" required className="veqsio-input w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Description</label>
            <input name="description" type="text" className="veqsio-input w-full" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="veqsio-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={createScreen.isPending} className="veqsio-btn-primary">
              {createScreen.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!liveScreen} onClose={() => setEditingScreen(null)} title={liveScreen?.name || 'Edit Screen'} size="lg">
        {liveScreen && <ScreenEditPanel screen={liveScreen} onClose={() => setEditingScreen(null)} />}
      </Modal>
    </div>
  )
}

function ScreenEditPanel({ screen, onClose }: { screen: Screen; onClose: () => void }) {
  const updateScreen = useUpdateScreen()
  const [name, setName] = useState(screen.name)
  const [description, setDescription] = useState(screen.description || '')

  async function handleSave() {
    try {
      await updateScreen.mutateAsync({ id: screen.id, name, description: description || undefined })
      toast('Screen updated', 'success')
      onClose()
    } catch (err: any) {
      toast(err.message || 'Failed to update screen', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} className="veqsio-input w-full" />
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Description</label>
          <input value={description} onChange={e => setDescription(e.target.value)} className="veqsio-input w-full" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={handleSave} disabled={updateScreen.isPending} className="veqsio-btn-primary flex items-center gap-1.5">
          <Save className="w-4 h-4" />
          Save
        </button>
      </div>

      <hr className="border-[var(--surface-3)]" />

      <ScreenTabsEditor screen={screen} />
    </div>
  )
}

function ScreenTabsEditor({ screen }: { screen: Screen }) {
  const createTab = useCreateScreenTab()
  const deleteTab = useDeleteScreenTab()
  const [activeTabId, setActiveTabId] = useState<number | undefined>(screen.tabs[0]?.id)
  const [newTabName, setNewTabName] = useState('')

  async function handleAddTab() {
    if (!newTabName.trim()) return
    try {
      await createTab.mutateAsync({ screenId: screen.id, name: newTabName.trim() })
      toast('Tab added', 'success')
      setNewTabName('')
    } catch (err: any) {
      toast(err.message || 'Failed to add tab', 'error')
    }
  }

  async function handleDeleteTab(tabId: number, name: string) {
    if (!(await confirmDialog(`Delete tab "${name}"?`))) return
    try {
      await deleteTab.mutateAsync({ screenId: screen.id, tabId })
      toast('Tab deleted', 'success')
      if (activeTabId === tabId) setActiveTabId(screen.tabs.find(t => t.id !== tabId)?.id)
    } catch (err: any) {
      toast(err.message || 'Failed to delete tab', 'error')
    }
  }

  const activeTab = screen.tabs.find(t => t.id === activeTabId)

  return (
    <div className="space-y-3">
      <h3 className="text-heading-2 text-[var(--text-primary)]">Tabs</h3>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
        <input
          value={newTabName}
          onChange={e => setNewTabName(e.target.value)}
          placeholder="New tab name..."
          className="veqsio-input flex-1 w-full"
          onKeyDown={e => { if (e.key === 'Enter') handleAddTab() }}
        />
        <button onClick={handleAddTab} disabled={createTab.isPending} className="veqsio-btn-secondary flex items-center gap-1.5">
          <Plus className="w-4 h-4" />
          Add Tab
        </button>
      </div>

      {screen.tabs.length === 0 ? (
        <EmptyState icon="folder" title="No tabs" description="Add a tab to organize screen fields." />
      ) : (
        <div className="flex items-center gap-1 border-b border-[var(--surface-3)] overflow-x-auto">
          {screen.tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors relative ${
                activeTabId === tab.id ? 'text-[var(--brand-500)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tab.name}
              {activeTabId === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--brand-500)] rounded-t-full" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleDeleteTab(tab.id, tab.name)
                }}
                className="ml-1 veqsio-btn-ghost p-0.5 text-[var(--error)] hover:bg-[var(--error)]/10"
              >
                <X className="w-3 h-3" />
              </button>
            </button>
          ))}
        </div>
      )}

      {activeTab && (
        <TabFieldsEditor screenId={screen.id} tab={activeTab} />
      )}
    </div>
  )
}

function TabFieldsEditor({ screenId, tab }: { screenId: number; tab: ScreenTab }) {
  const { data: catalog } = useScreenFieldCatalog()
  const addField = useAddScreenTabField()
  const removeField = useRemoveScreenTabField()
  const setRequired = useSetScreenFieldRequired()
  const [selectedField, setSelectedField] = useState('')

  const allFields = catalog?.fields || []

  async function handleAdd() {
    if (!selectedField) return
    const item = allFields.find((f) => f.key === selectedField)
    if (!item) return
    try {
      await addField.mutateAsync({ screenId, tabId: tab.id, ...(item.custom ? { fieldId: item.fieldId, isCustomField: true } : { fieldKey: item.key, isCustomField: false }) })
      toast('Field added', 'success')
      setSelectedField('')
    } catch (err: any) {
      toast(err.message || 'Failed to add field', 'error')
    }
  }

  async function handleRemove(fieldId: number) {
    try {
      await removeField.mutateAsync({ screenId, tabId: tab.id, fieldId })
      toast('Field removed', 'success')
    } catch (err: any) {
      toast(err.message || 'Failed to remove field', 'error')
    }
  }

  const usedKeys = new Set(tab.fields.map(f => (f.isCustomField ? `customfield_${f.fieldId}` : f.fieldKey ?? '')))

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
        <select
          value={selectedField}
          onChange={e => setSelectedField(e.target.value)}
          className="veqsio-input flex-1 w-full"
        >
          <option value="">Select field...</option>
          {allFields.map(f => {
            if (usedKeys.has(f.key)) return null
            return (
              <option key={f.key} value={f.key}>
                {f.name} {f.custom ? '(Custom)' : '(System)'}
              </option>
            )
          })}
        </select>
        <button onClick={handleAdd} disabled={!selectedField || addField.isPending} className="veqsio-btn-secondary flex items-center gap-1.5">
          <Plus className="w-4 h-4" />
          Add Field
        </button>
      </div>

      {tab.fields.length === 0 ? (
        <EmptyState icon="folder" title="No fields" description="Add fields to this tab." />
      ) : (
        <div className="border border-[var(--surface-3)] rounded-lg divide-y divide-[var(--surface-3)]">
          {tab.fields.map(f => (
            <div key={f.id} className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <GripVertical className="w-4 h-4 text-[var(--text-tertiary)]" />
                <span className="text-sm text-[var(--text-primary)]">
                  {allFields.find(af => af.key === (f.isCustomField ? `customfield_${f.fieldId}` : f.fieldKey))?.name || `Field ${f.fieldKey ?? f.fieldId}`}
                </span>
                {f.isCustomField && <span className="text-xs text-[var(--text-tertiary)]">Custom</span>}
              </div>
              <label className="ml-auto mr-3 flex items-center gap-1.5 text-caption text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={!!f.required}
                  disabled={setRequired.isPending}
                  onChange={(e) => setRequired.mutate({ screenId, tabId: tab.id, fieldId: f.id, required: e.target.checked }, { onError: (err: any) => toast(err.message || 'Failed to update the field', 'error') })}
                />
                Required on transitions
              </label>
              <button
                onClick={() => handleRemove(f.id)}
                className="veqsio-btn-ghost p-1.5 text-[var(--error)] hover:bg-[var(--error)]/10"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
