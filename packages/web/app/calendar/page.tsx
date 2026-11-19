'use client'

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { AppLayout } from '@/components/app-layout'
import { PageHeader } from '@/components/page-header'
import { Spinner } from '@/components/spinner'
import { MonthCalendar } from '@/components/month-calendar'
import { useIssues } from '@/hooks/use-issues'
import { useProjects } from '@/hooks/use-project-admin'
import { groupByDate, gridRange, isoDate, monthGrid, shiftMonth } from '@/lib/calendar-grid'

export default function CalendarPage() {
  const now = new Date()
  const [ym, setYm] = useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() })
  const [project, setProject] = useState('')
  const { data: projects = [] } = useProjects()
  const weeks = useMemo(() => monthGrid(ym.year, ym.month), [ym])
  const { from, to } = gridRange(weeks)
  const jql = `${project ? `project = "${project}" AND ` : ''}duedate >= "${from}" AND duedate <= "${to}" ORDER BY duedate ASC`
  const { data, isLoading, error } = useIssues(jql)
  const byDay = useMemo(() => groupByDate(data?.issues ?? [], (i) => i.fields.duedate), [data])
  const today = isoDate(now)
  const title = new Date(Date.UTC(ym.year, ym.month, 1)).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader
          title="Calendar"
          description="Issues by due date."
          actions={
          <>
            <label className="sr-only" htmlFor="cal-project">Project</label>
            <select id="cal-project" className="veqsio-input !w-auto" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
            <div className="flex items-center gap-2" role="group" aria-label="Month">
            <button type="button" className="veqsio-btn-secondary" aria-label="Previous month" onClick={() => setYm((v) => shiftMonth(v.year, v.month, -1))}><ChevronLeft className="w-4 h-4" /></button>
            <span className="min-w-[9rem] text-center font-medium" aria-live="polite">{title}</span>
            <button type="button" className="veqsio-btn-secondary" aria-label="Next month" onClick={() => setYm((v) => shiftMonth(v.year, v.month, 1))}><ChevronRight className="w-4 h-4" /></button>
            <button type="button" className="veqsio-btn-secondary" onClick={() => setYm({ year: now.getUTCFullYear(), month: now.getUTCMonth() })}>Today</button>
            </div>
          </>
          }
        />
        {error && <p role="alert" className="text-[var(--error)]">{error.message}</p>}
        {isLoading && <Spinner />}
        <MonthCalendar weeks={weeks} title={title} byDay={byDay} today={today} />
        {data && data.total > data.issues.length && <p className="text-body-sm text-[var(--text-secondary)]">Showing the first {data.issues.length} of {data.total} issues in this range; narrow it by choosing a project.</p>}
      </div>
    </AppLayout>
  )
}
