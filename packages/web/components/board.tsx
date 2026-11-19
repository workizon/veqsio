'use client'

import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  defaultDropAnimationSideEffects,
  DropAnimation,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { createPortal } from 'react-dom'
import { BoardColumn } from './board-column'
import { IssueCard } from './issue-card'

interface Issue {
  id: number
  key: string
  summary: string
  type: 'bug' | 'task' | 'story' | 'epic' | 'sub-task'
  status: string
  priority: string
  assignee?: { name: string; initials: string }
  labels?: string[]
}

interface Column {
  id: string
  name: string
  status: string
}

interface BoardProps {
  columns: Column[]
  initialIssues: Issue[]
  onIssueMove?: (issueId: number, newStatus: string) => void
}

export function Board({ columns, initialIssues, onIssueMove }: BoardProps) {
  const [issues, setIssues] = useState(initialIssues)
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event
    const issue = issues.find((i) => i.id === Number(active.id))
    if (issue) setActiveIssue(issue)
  }

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over) return

    const activeId = Number(active.id)
    const overId = over.id

    const activeIssue = issues.find((i) => i.id === activeId)
    if (!activeIssue) return

    const overColumn = columns.find((c) => c.id === overId)
    if (overColumn && activeIssue.status !== overColumn.status) {
      setIssues((prev) =>
        prev.map((i) =>
          i.id === activeId ? { ...i, status: overColumn.status } : i
        )
      )
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveIssue(null)

    if (!over) return

    const activeId = Number(active.id)
    const overId = over.id

    const activeIssue = issues.find((i) => i.id === activeId)
    if (!activeIssue) return

    const overColumn = columns.find((c) => c.id === overId)
    if (overColumn) {
      onIssueMove?.(activeId, overColumn.status)
    }
  }

  const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: '0.5',
        },
      },
    }),
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4 h-full">
        {columns.map((column) => {
          const columnIssues = issues.filter((i) => i.status === column.status)
          return (
            <BoardColumn
              key={column.id}
              id={column.id}
              name={column.name}
              count={columnIssues.length}
            >
              <SortableContext
                items={columnIssues.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2">
                  {columnIssues.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      id={issue.id}
                      issueKey={issue.key}
                      summary={issue.summary}
                      type={issue.type}
                      status={issue.status}
                      priority={issue.priority}
                      assignee={issue.assignee}
                      labels={issue.labels}
                    />
                  ))}
                </div>
              </SortableContext>
            </BoardColumn>
          )
        })}
      </div>

      {createPortal(
        <DragOverlay dropAnimation={dropAnimation}>
          {activeIssue ? (
            <IssueCard
              id={activeIssue.id}
              issueKey={activeIssue.key}
              summary={activeIssue.summary}
              type={activeIssue.type}
              status={activeIssue.status}
              priority={activeIssue.priority}
              assignee={activeIssue.assignee}
              labels={activeIssue.labels}
            />
          ) : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  )
}
