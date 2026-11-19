import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import * as schema from '@veqsio/db'
import type { JiraClient } from './client'
import type { Resolver } from '../resolver'

export interface AgileStats { boards: number; sprints: number; sprintIssues: number }

const sprintState = (s: string | undefined) => (s === 'active' ? 'active' : s === 'closed' ? 'closed' : 'future')
const date = (v: unknown) => { const d = v ? new Date(String(v)) : null; return d && !Number.isNaN(d.getTime()) ? d : null }

/**
 * Imports the boards of one project (columns from the board configuration) and, for scrum boards,
 * their sprints and sprint membership. Best effort: a missing Agile API only produces a warning.
 */
export async function importAgile(
  client: JiraClient, resolver: Resolver, project: { id: number; key: string },
  issueIdByKey: Map<string, number>, warnings: string[],
): Promise<AgileStats> {
  const stats: AgileStats = { boards: 0, sprints: 0, sprintIssues: 0 }
  let boards: any[]
  try {
    boards = await client.getAgilePaged('/rest/agile/1.0/board', { projectKeyOrId: project.key })
  } catch (e: any) {
    warnings.push(`${project.key}: boards/sprints not imported (${e.message})`)
    return stats
  }

  // Status id -> name for translating the board configuration.
  let statusNames = new Map<string, string>()
  try {
    statusNames = new Map((await client.get<any[]>('/rest/api/2/status')).map((s) => [String(s.id), s.name]))
  } catch { /* columns fall back to names from the configuration, if any */ }

  for (const b of boards) {
    const type = b.type === 'scrum' ? 'scrum' : 'kanban'
    const name = String(b.name ?? `Board ${b.id}`).slice(0, 255)
    let [board] = await db.select().from(schema.boards).where(and(eq(schema.boards.projectId, project.id), eq(schema.boards.name, name))).limit(1)
    const created = !board
    if (!board) {
      ;[board] = await db.insert(schema.boards).values({ name, type, projectId: project.id, config: {} }).returning()
      stats.boards++
    }

    if (created) {
      try {
        const cfg = await client.get(`/rest/agile/1.0/board/${b.id}/configuration`)
        let order = 0
        for (const col of cfg.columnConfig?.columns ?? []) {
          const sts: any[] = col.statuses ?? []
          if (sts.length > 1) warnings.push(`${project.key}: board "${name}" column "${col.name}" maps ${sts.length} statuses; split into one column per status`)
          for (const st of sts) {
            const sname = statusNames.get(String(st.id)) ?? st.name
            if (!sname) continue
            const statusId = await resolver.status(sname, 'todo')
            await db.insert(schema.boardColumns).values({
              boardId: board.id, statusId, name: (sts.length === 1 ? col.name : sname).slice(0, 100),
              min: col.min ?? null, max: col.max ?? null, sortOrder: order++,
            })
          }
        }
      } catch (e: any) {
        warnings.push(`${project.key}: columns of board "${name}" not imported (${e.message})`)
      }
    }

    if (type !== 'scrum') continue
    let sprints: any[] = []
    try {
      sprints = await client.getAgilePaged(`/rest/agile/1.0/board/${b.id}/sprint`, { state: 'active,closed,future' })
    } catch (e: any) {
      warnings.push(`${project.key}: sprints of board "${name}" not imported (${e.message})`)
      continue
    }
    for (const s of sprints) {
      const sname = String(s.name ?? `Sprint ${s.id}`).slice(0, 255)
      let [sprint] = await db.select().from(schema.sprints).where(and(eq(schema.sprints.boardId, board.id), eq(schema.sprints.name, sname))).limit(1)
      if (sprint) {
        // Re-sync: keep state and dates current (e.g. a sprint that was active last time is now closed).
        await db.update(schema.sprints).set({ state: sprintState(s.state), startDate: date(s.startDate), endDate: date(s.endDate), completeDate: date(s.completeDate) })
          .where(eq(schema.sprints.id, sprint.id))
      } else {
        ;[sprint] = await db.insert(schema.sprints).values({
          name: sname, goal: s.goal ?? null, state: sprintState(s.state), boardId: board.id,
          startDate: date(s.startDate), endDate: date(s.endDate), completeDate: date(s.completeDate),
        }).returning()
        stats.sprints++
      }
      try {
        const issues = await client.getAgilePaged(`/rest/agile/1.0/sprint/${s.id}/issue`, { fields: 'summary' })
        for (const i of issues) {
          let id = issueIdByKey.get(i.key)
          if (!id) {
            const [row] = await db.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.issueKey, i.key)).limit(1)
            id = row?.id
          }
          if (!id) continue
          const r = await db.insert(schema.sprintIssues).values({ sprintId: sprint.id, issueId: id }).onConflictDoNothing().returning({ i: schema.sprintIssues.issueId })
          stats.sprintIssues += r.length
        }
      } catch (e: any) {
        warnings.push(`${project.key}: issues of sprint "${sname}" not imported (${e.message})`)
      }
    }
  }
  return stats
}
