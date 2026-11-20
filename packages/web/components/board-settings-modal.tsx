'use client'


import { useI18n } from '@/hooks/use-i18n'
import { useState, useEffect } from 'react'
import { Modal } from './modal'
import { Tabs } from './tabs'
import { Spinner } from './spinner'
import { EmptyState } from './empty-state'
import { useBoards, useBoard, useUpdateBoard, useUpdateBoardColumns, useCreateQuickFilter, useUpdateQuickFilter, useDeleteQuickFilter } from '@/hooks/use-boards'
import { useStatuses } from '@/hooks/use-issues'
import { toast } from './toast'
import { CARD_FIELDS, CARD_FIELD_LABELS, normalizeCardLayout, type CardSize } from '@/lib/card-layout'
import {
  CARD_COLOUR_MODES, CARD_COLOUR_MODE_LABELS, CARD_COLOUR_TOKENS, emptyRule, normalizeCardColour, validateCardColour,
  type CardColourConfig, type CardColourMode,
} from '@/lib/card-colours'
import {
  Settings,
  GripVertical,
  Plus,
  Trash2,
  Save,
  AlertCircle,
  X,
} from 'lucide-react'

interface BoardSettingsModalProps {
  open: boolean
  onClose: () => void
  /** Board to show first (the one on screen); defaults to the first board. */
  initialBoardId?: string | null
}

export function BoardSettingsModal({ open, onClose, initialBoardId }: BoardSettingsModalProps) {
  const { tr } = useI18n();

  const { data: boardsData, isLoading: boardsLoading } = useBoards()
  const [selectedBoardId, setSelectedBoardId] = useState<string>('')

  const boards = boardsData?.values || []

  useEffect(() => {
    if (boards.length > 0 && !selectedBoardId) {
      setSelectedBoardId(boards[0].id)
    }
  }, [boards, selectedBoardId])

  // Opening the dialog from a board shows that board's settings.
  useEffect(() => {
    if (open && initialBoardId) setSelectedBoardId(initialBoardId)
  }, [open, initialBoardId])

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={tr('Board settings')}
      size="lg"
    >
      {boardsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : boards.length === 0 ? (
        <EmptyState
          icon="folder"
          title={tr('No boards yet')}
          description={tr('Create a board in a project to configure board settings.')}
        />
      ) : (
        <div className="space-y-4">
          <div>
            <label className="text-caption text-[var(--text-secondary)] block mb-1">{tr('Select board')}</label>
            <select
              value={selectedBoardId}
              onChange={(e) => setSelectedBoardId(e.target.value)}
              className="veqsio-input w-full"
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.type})
                </option>
              ))}
            </select>
          </div>
          {selectedBoardId && (
            <BoardSettingsContent boardId={selectedBoardId} />
          )}
        </div>
      )}
    </Modal>
  )
}

function BoardSettingsContent({ boardId }: { boardId: string }) {
  const { tr } = useI18n();

  const { data: board, isLoading } = useBoard(boardId)
  const { data: statusesData } = useStatuses()
  const updateBoard = useUpdateBoard()
  const updateColumns = useUpdateBoardColumns()
  const createFilter = useCreateQuickFilter()
  const updateFilter = useUpdateQuickFilter()
  const deleteFilter = useDeleteQuickFilter()

  const [columns, setColumns] = useState(board?.columns || [])
  const [quickFilters, setQuickFilters] = useState(board?.quickFilters || [])
  const [swimlaneField, setSwimlaneField] = useState(board?.config?.swimlaneField || '')
  const [hasChanges, setHasChanges] = useState(false)
  const [cardColour, setCardColour] = useState<CardColourConfig>({ by: 'none', rules: [] })
  const [layout, setLayout] = useState(() => normalizeCardLayout(board?.config))
  const [colourErrors, setColourErrors] = useState<string[]>([])

  useEffect(() => {
    if (board) {
      setCardColour(normalizeCardColour(board.config))
      setLayout(normalizeCardLayout(board.config))
      setColourErrors([])
      setColumns(board.columns || [])
      setQuickFilters(board.quickFilters || [])
      setSwimlaneField(board.config?.swimlaneField || '')
      setHasChanges(false)
    }
  }, [board])

  const statuses = statusesData || []

  const handleSaveColumns = async () => {
    await updateColumns.mutateAsync({ id: boardId, columns })
    setHasChanges(false)
  }

  const handleSaveConfig = async () => {
    await updateBoard.mutateAsync({
      id: boardId,
      data: { config: { ...board?.config, swimlaneField: swimlaneField || null } },
    })
    setHasChanges(false)
  }

  const handleSaveLayout = async () => {
    try {
      await updateBoard.mutateAsync({ id: boardId, data: { config: { ...board?.config, cardFields: CARD_FIELDS.filter((f) => layout.fields.has(f)), cardSize: layout.size } } })
      toast(tr('Card layout saved'), 'success')
    } catch (e: any) {
      toast(e?.message || 'Could not save the card layout', 'error')
    }
  }

  const handleSaveCardColour = async () => {
    const problems = validateCardColour(cardColour)
    setColourErrors(problems)
    if (problems.length) return
    try {
      await updateBoard.mutateAsync({ id: boardId, data: { config: { ...board?.config, cardColour } } })
      setHasChanges(false)
      toast(tr('Card colours saved'), 'success')
    } catch (e: any) {
      setColourErrors([e?.message || 'Could not save the card colours'])
    }
  }
  const setRule = (i: number, patch: Partial<CardColourConfig['rules'][number]>) => {
    setCardColour((c) => ({ ...c, rules: c.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
    setHasChanges(true)
  }

  const handleAddColumn = () => {
    const nextOrder = columns.length > 0
      ? Math.max(...columns.map((c) => c.sortOrder)) + 1
      : 0
    setColumns((prev) => [
      ...prev,
      { id: `new-${Date.now()}`, name: 'New Column', statusId: null, min: null, max: null, sortOrder: nextOrder },
    ])
    setHasChanges(true)
  }

  const handleRemoveColumn = (id: string) => {
    setColumns((prev) => prev.filter((c) => c.id !== id))
    setHasChanges(true)
  }

  const handleColumnChange = (id: string, field: string, value: any) => {
    setColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c))
    )
    setHasChanges(true)
  }

  const handleMoveColumn = (index: number, direction: number) => {
    const newColumns = [...columns]
    const target = index + direction
    if (target < 0 || target >= newColumns.length) return
    ;[newColumns[index], newColumns[target]] = [newColumns[target], newColumns[index]]
    setColumns(newColumns.map((c, i) => ({ ...c, sortOrder: i })))
    setHasChanges(true)
  }

  const handleAddFilter = () => {
    const nextOrder = quickFilters.length > 0
      ? Math.max(...quickFilters.map((f) => f.sortOrder)) + 1
      : 0
    setQuickFilters((prev) => [
      ...prev,
      { id: `new-${Date.now()}`, name: '', jql: '', sortOrder: nextOrder },
    ])
    setHasChanges(true)
  }

  const handleFilterChange = (id: string, field: string, value: string) => {
    setQuickFilters((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value } : f))
    )
    setHasChanges(true)
  }

  const handleRemoveFilter = (id: string) => {
    setQuickFilters((prev) => prev.filter((f) => f.id !== id))
    setHasChanges(true)
  }

  const handleSaveFilters = async () => {
    // Delete all existing and recreate
    for (const f of board?.quickFilters || []) {
      if (!f.id.startsWith('new-')) {
        await deleteFilter.mutateAsync({ boardId, filterId: f.id })
      }
    }
    for (const f of quickFilters) {
      await createFilter.mutateAsync({
        boardId,
        data: { name: f.name, jql: f.jql, sortOrder: f.sortOrder },
      })
    }
    setHasChanges(false)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {hasChanges && (
        <div className="flex items-center gap-2 bg-[var(--warning)]/10 text-[var(--warning)] px-3 py-2 rounded-lg text-sm">
          <AlertCircle className="w-4 h-4" />
          {tr('You have unsaved changes')} </div>
      )}
      <Tabs
        tabs={[
          {
            id: 'columns',
            label: 'Columns',
            content: (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-heading-3 text-[var(--text-primary)]">{tr('Column configuration')}</h3>
                  <button onClick={handleAddColumn} className="veqsio-btn-secondary flex items-center gap-2 text-sm">
                    <Plus className="w-4 h-4" /> {tr('Add Column')} </button>
                </div>
                <div className="space-y-2">
                  {columns.map((col, idx) => (
                    <div key={col.id} className="veqsio-card p-3 flex items-center gap-3">
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => handleMoveColumn(idx, -1)}
                          disabled={idx === 0}
                          className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => handleMoveColumn(idx, 1)}
                          disabled={idx === columns.length - 1}
                          className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
                        >
                          ▼
                        </button>
                      </div>
                      <div className="flex-1 grid grid-cols-4 gap-3">
                        <div>
                          <label className="text-caption text-[var(--text-tertiary)] block mb-1">{tr('Name')}</label>
                          <input
                            type="text"
                            value={col.name}
                            onChange={(e) => handleColumnChange(col.id, 'name', e.target.value)}
                            className="veqsio-input w-full text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-caption text-[var(--text-tertiary)] block mb-1">{tr('Status')}</label>
                          <select
                            value={col.statusId || ''}
                            onChange={(e) => handleColumnChange(col.id, 'statusId', e.target.value ? Number(e.target.value) : null)}
                            className="veqsio-input w-full text-sm"
                          >
                            <option value="">{tr('None')}</option>
                            {statuses.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-caption text-[var(--text-tertiary)] block mb-1">{tr('Min WIP')}</label>
                          <input
                            type="number"
                            value={col.min ?? ''}
                            onChange={(e) => handleColumnChange(col.id, 'min', e.target.value ? Number(e.target.value) : null)}
                            className="veqsio-input w-full text-sm"
                            placeholder={tr('None')}
                          />
                        </div>
                        <div>
                          <label className="text-caption text-[var(--text-tertiary)] block mb-1">{tr('Max WIP')}</label>
                          <input
                            type="number"
                            value={col.max ?? ''}
                            onChange={(e) => handleColumnChange(col.id, 'max', e.target.value ? Number(e.target.value) : null)}
                            className="veqsio-input w-full text-sm"
                            placeholder={tr('None')}
                          />
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveColumn(col.id)}
                        className="text-[var(--error)] hover:opacity-70 p-1"
                        title={tr('Remove column')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  {columns.length === 0 && (
                    <p className="text-body-sm text-[var(--text-secondary)] text-center py-8">{tr('No columns configured. Add a column to get started.')}</p>
                  )}
                </div>
                {columns.length > 0 && (
                  <div className="flex justify-end">
                    <button
                      onClick={handleSaveColumns}
                      disabled={updateColumns.isPending}
                      className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      {updateColumns.isPending ? 'Saving...' : 'Save Columns'}
                    </button>
                  </div>
                )}
              </div>
            ),
          },
          {
            id: 'quick-filters',
            label: 'Quick Filters',
            content: (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-heading-3 text-[var(--text-primary)]">{tr('Quick filters')}</h3>
                  <button onClick={handleAddFilter} className="veqsio-btn-secondary flex items-center gap-2 text-sm">
                    <Plus className="w-4 h-4" /> {tr('Add Filter')} </button>
                </div>
                <div className="space-y-2">
                  {quickFilters.map((qf) => (
                    <div key={qf.id} className="veqsio-card p-3 flex items-center gap-3">
                      <div className="flex-1 grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-caption text-[var(--text-tertiary)] block mb-1">{tr('Name')}</label>
                          <input
                            type="text"
                            value={qf.name}
                            onChange={(e) => handleFilterChange(qf.id, 'name', e.target.value)}
                            placeholder={tr('e.g. My Issues')}
                            className="veqsio-input w-full text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-caption text-[var(--text-tertiary)] block mb-1">{tr('JQL')}</label>
                          <input
                            type="text"
                            value={qf.jql}
                            onChange={(e) => handleFilterChange(qf.id, 'jql', e.target.value)}
                            placeholder={tr('e.g. assignee = currentUser()')}
                            className="veqsio-input w-full text-sm"
                          />
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveFilter(qf.id)}
                        className="text-[var(--error)] hover:opacity-70 p-1"
                        title={tr('Remove filter')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  {quickFilters.length === 0 && (
                    <p className="text-body-sm text-[var(--text-secondary)] text-center py-8">{tr('No quick filters configured. Add one to get started.')}</p>
                  )}
                </div>
                {quickFilters.length > 0 && (
                  <div className="flex justify-end">
                    <button
                      onClick={handleSaveFilters}
                      disabled={createFilter.isPending || deleteFilter.isPending}
                      className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      {createFilter.isPending ? 'Saving...' : 'Save Filters'}
                    </button>
                  </div>
                )}
              </div>
            ),
          },
          {
            id: 'cards',
            label: 'Card colours',
            content: (
              <div className="space-y-4">
                <h3 className="text-heading-3 text-[var(--text-primary)]">{tr('Card colour by')}</h3>
                <div className="veqsio-card p-4 space-y-4">
                  <div>
                    <label htmlFor="card-colour-by" className="text-caption text-[var(--text-secondary)] block mb-1">{tr('Colour the left border and tint of each card by')}</label>
                    <select
                      id="card-colour-by"
                      value={cardColour.by}
                      onChange={(e) => {
                        const by = e.target.value as CardColourMode
                        setCardColour((c) => ({ ...c, by, rules: by === 'rules' && c.rules.length === 0 ? [emptyRule()] : c.rules }))
                        setHasChanges(true)
                      }}
                      className="veqsio-input w-full"
                    >
                      {CARD_COLOUR_MODES.map((m) => <option key={m} value={m}>{CARD_COLOUR_MODE_LABELS[m]}</option>)}
                    </select>
                  </div>
                  {cardColour.by === 'rules' ? (
                    <div className="space-y-2">
                      <p className="text-body-sm text-[var(--text-secondary)]">{tr('The first rule that matches a card decides its colour. Cards that match no rule stay plain. A legend above the board lists the colours in use.')}</p>
                      {cardColour.rules.map((r, i) => (
                        <div key={i} className="rounded-lg border border-[var(--surface-3)] p-3 space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-3">
                            <div>
                              <label className="text-caption text-[var(--text-tertiary)] block mb-1" htmlFor={`rule-name-${i}`}>{tr('Legend name')}</label>
                              <input id={`rule-name-${i}`} className="veqsio-input w-full text-sm" value={r.name} maxLength={60} placeholder={tr('e.g. Blocked')} onChange={(e) => setRule(i, { name: e.target.value })} />
                            </div>
                            <div>
                              <label className="text-caption text-[var(--text-tertiary)] block mb-1" htmlFor={`rule-jql-${i}`}>{tr('JQL')}</label>
                              <input id={`rule-jql-${i}`} className="veqsio-input w-full text-sm font-mono" value={r.jql} placeholder={tr('e.g. flagged = true')} onChange={(e) => setRule(i, { jql: e.target.value })} />
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-caption text-[var(--text-tertiary)]" id={`rule-colour-${i}`}>{tr('Colour')}</span>
                            <div role="group" aria-labelledby={`rule-colour-${i}`} className="flex flex-wrap gap-1.5">
                              {CARD_COLOUR_TOKENS.map((t) => (
                                <button
                                  key={t} type="button" aria-label={t} aria-pressed={r.colour === t} title={t}
                                  onClick={() => setRule(i, { colour: t })}
                                  className={`h-6 w-6 rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)] ${r.colour === t ? 'border-[var(--text-primary)]' : 'border-transparent'}`}
                                  style={{ background: `var(--label-${t}-dot)` }}
                                />
                              ))}
                            </div>
                            <button
                              type="button"
                              onClick={() => { setCardColour((c) => ({ ...c, rules: c.rules.filter((_, j) => j !== i) })); setHasChanges(true) }}
                              className="ml-auto text-[var(--error)] hover:opacity-70 p-1"
                              title={tr('Remove rule')} aria-label={`Remove rule ${i + 1}`}
                            ><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </div>
                      ))}
                      {cardColour.rules.length < 10 && (
                        <button type="button" className="veqsio-btn-secondary flex items-center gap-2 text-sm" onClick={() => { setCardColour((c) => ({ ...c, rules: [...c.rules, emptyRule()] })); setHasChanges(true) }}>
                          <Plus className="w-4 h-4" /> {tr('Add rule')} </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-body-sm text-[var(--text-secondary)]">
                      {cardColour.by === 'none' ? 'Cards use the plain style.' : `Each ${cardColour.by === 'issuetype' ? 'issue type' : cardColour.by} gets its own colour.`} {tr('Flagged issues are always tinted and show a flag.')} </p>
                  )}
                  {colourErrors.length > 0 && (
                    <ul role="alert" className="text-sm text-[var(--error)] space-y-0.5">{colourErrors.map((m) => <li key={m}>{m}</li>)}</ul>
                  )}
                </div>
                <div className="flex justify-end">
                  <button onClick={handleSaveCardColour} disabled={updateBoard.isPending} className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50">
                    <Save className="w-4 h-4" />
                    {updateBoard.isPending ? 'Saving...' : 'Save card colours'}
                  </button>
                </div>
              </div>
            ),
          },
          {
            id: 'layout',
            label: 'Card layout',
            content: (
              <div className="space-y-4">
                <h3 className="text-heading-3 text-[var(--text-primary)]">{tr('Card layout')}</h3>
                <div className="veqsio-card p-4 space-y-4">
                  <fieldset>
                    <legend className="text-caption text-[var(--text-secondary)] mb-2">{tr('Show on each card (summary, key and flag are always shown)')}</legend>
                    <div className="space-y-2">
                      {CARD_FIELDS.map((f) => (
                        <label key={f} className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                          <input
                            type="checkbox"
                            checked={layout.fields.has(f)}
                            onChange={(e) => setLayout((l) => { const next = new Set(l.fields); if (e.target.checked) next.add(f); else next.delete(f); return { ...l, fields: next } })}
                          />
                          {CARD_FIELD_LABELS[f]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div>
                    <label htmlFor="card-size" className="text-caption text-[var(--text-secondary)] block mb-1">{tr('Density')}</label>
                    <select id="card-size" className="veqsio-input" value={layout.size} onChange={(e) => setLayout((l) => ({ ...l, size: e.target.value as CardSize }))}>
                      <option value="comfortable">{tr('Comfortable')}</option>
                      <option value="compact">{tr('Compact')}</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button onClick={handleSaveLayout} disabled={updateBoard.isPending} className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50">
                    <Save className="w-4 h-4" />
                    {updateBoard.isPending ? 'Saving...' : 'Save card layout'}
                  </button>
                </div>
              </div>
            ),
          },
          {
            id: 'swimlanes',
            label: 'Swimlanes',
            content: (
              <div className="space-y-4">
                <h3 className="text-heading-3 text-[var(--text-primary)]">{tr('Swimlane configuration')}</h3>
                <div className="veqsio-card p-4 space-y-4">
                  <div>
                    <label className="text-caption text-[var(--text-secondary)] block mb-1">{tr('Group by (Swimlane Field)')}</label>
                    <select
                      value={swimlaneField}
                      onChange={(e) => {
                        setSwimlaneField(e.target.value)
                        setHasChanges(true)
                      }}
                      className="veqsio-input w-full"
                    >
                      <option value="">{tr('No swimlanes')}</option>
                      <option value="assignee">{tr('Assignee')}</option>
                      <option value="priority">{tr('Priority')}</option>
                      <option value="project">{tr('Project')}</option>
                      <option value="issuetype">{tr('Issue type')}</option>
                      <option value="epic">{tr('Epic')}</option>
                    </select>
                  </div>
                  <p className="text-body-sm text-[var(--text-secondary)]">
                    {tr('Swimlanes group issues horizontally on the board. Choose a field to group by, or select "No Swimlanes" to display all issues in a single row per column.')} </p>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveConfig}
                    disabled={updateBoard.isPending}
                    className="veqsio-btn-primary flex items-center gap-2 disabled:opacity-50"
                  >
                    <Save className="w-4 h-4" />
                    {updateBoard.isPending ? 'Saving...' : 'Save Swimlanes'}
                  </button>
                </div>
              </div>
            ),
          },
        ]}
        defaultTab="columns"
      />
    </div>
  )
}
