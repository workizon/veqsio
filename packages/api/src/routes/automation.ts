import { Hono } from 'hono';
import { sessionMiddleware, requireAuth } from '../auth/middleware';
import { db } from '../db';
import * as schema from '@veqsio/db';
import { eq, desc, and } from 'drizzle-orm';
import type { AppContext } from '../auth/middleware';
import { executeRuleManually } from '../services/automation-engine';
import { hasGlobalPermission } from '../rbac/service';
import { checkProjectPermission } from '../middleware/permissions';

const app = new Hono<AppContext>();
app.use('/rest/api/2/automation*', sessionMiddleware);

/* ------------------------------------------------------------------ */
/*  Access                                                             */
/* ------------------------------------------------------------------ */

type AuthUser = typeof schema.users.$inferSelect;

/**
 * Rules run with the identity of the person who created them and can change issues, send comments and call webhooks,
 * so they are administration: global rules (no project) need SYSTEM_ADMIN, a project rule needs PROJECT_ADMIN of that
 * project (or SYSTEM_ADMIN). Rules a user may not manage do not exist for them (404), and rules never appear in lists.
 */
async function isProjectAdmin(user: AuthUser, projectId: number): Promise<boolean> {
  // both keys exist in permission schemes; either one makes a project administrator
  return (await checkProjectPermission(user, projectId, 'PROJECT_ADMIN')) || (await checkProjectPermission(user, projectId, 'ADMINISTER_PROJECTS'));
}

async function canManage(user: AuthUser, projectId: number | null): Promise<boolean> {
  if (await hasGlobalPermission(user.id, 'SYSTEM_ADMIN')) return true;
  return projectId !== null && (await isProjectAdmin(user, projectId));
}

/** Webhook actions can reach other systems: only system administrators may add them. */
const usesWebhook = (actions: unknown) => Array.isArray(actions) && actions.some((a) => a && typeof a === 'object' && (a as any).actionType === 'send_webhook');

const FORBIDDEN_RULE = { errorMessages: ['You do not have permission to manage this automation rule'] };

async function loadManageable(c: any, id: number) {
  if (!Number.isInteger(id)) return null;
  const [rule] = await db.select().from(schema.automationRules).where(eq(schema.automationRules.id, id)).limit(1);
  if (!rule || !(await canManage(c.get('user')!, rule.projectId))) return null;
  return rule;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function getRuleWithDetails(ruleId: number) {
  const rule = await db
    .select()
    .from(schema.automationRules)
    .where(eq(schema.automationRules.id, ruleId))
    .limit(1);
  if (rule.length === 0) return null;

  const triggers = await db
    .select()
    .from(schema.automationTriggers)
    .where(eq(schema.automationTriggers.ruleId, ruleId));

  const conditions = await db
    .select()
    .from(schema.automationConditions)
    .where(eq(schema.automationConditions.ruleId, ruleId))
    .orderBy(schema.automationConditions.position);

  const actions = await db
    .select()
    .from(schema.automationActions)
    .where(eq(schema.automationActions.ruleId, ruleId))
    .orderBy(schema.automationActions.position);

  return {
    ...rule[0],
    triggers,
    conditions,
    actions,
  };
}

/* ------------------------------------------------------------------ */
/*  List rules                                                         */
/* ------------------------------------------------------------------ */
app.get('/rest/api/2/automation/rule', requireAuth, async (c) => {
  try {
    const query = c.req.query();
    const projectId = query.projectId ? Number(query.projectId) : undefined;

    let rules;
    if (projectId !== undefined && !isNaN(projectId)) {
      rules = await db
        .select()
        .from(schema.automationRules)
        .where(
          and(
            eq(schema.automationRules.projectId, projectId)
          )
        )
        .orderBy(desc(schema.automationRules.updatedAt));
    } else {
      rules = await db
        .select()
        .from(schema.automationRules)
        .orderBy(desc(schema.automationRules.updatedAt));
    }

    const user = c.get('user')!;
    const isAdmin = await hasGlobalPermission(user.id, 'SYSTEM_ADMIN');
    const allowed = new Map<number, boolean>();
    rules = isAdmin ? rules : (await Promise.all(rules.map(async (r) => {
      if (r.projectId === null) return null;
      if (!allowed.has(r.projectId)) allowed.set(r.projectId, await isProjectAdmin(user, r.projectId));
      return allowed.get(r.projectId) ? r : null;
    }))).filter((r): r is NonNullable<typeof r> => r !== null);

    return c.json({
      startAt: 0,
      maxResults: rules.length,
      total: rules.length,
      isLast: true,
      values: rules.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        projectId: r.projectId,
        isEnabled: r.isEnabled,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch rules'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Create rule                                                        */
/* ------------------------------------------------------------------ */
app.post('/rest/api/2/automation/rule', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const user = c.get('user')!;
    const projectId = body.projectId == null ? null : Number(body.projectId);
    if (projectId !== null && !Number.isInteger(projectId)) return c.json({ errorMessages: ['projectId must be a number'] }, 400);
    if (!(await canManage(user, projectId))) return c.json(FORBIDDEN_RULE, 403);
    if (usesWebhook(body.actions) && !(await hasGlobalPermission(user.id, 'SYSTEM_ADMIN'))) return c.json({ errorMessages: ['Only system administrators can add webhook actions'] }, 403);

    const [rule] = await db
      .insert(schema.automationRules)
      .values({
        name: body.name,
        description: body.description,
        projectId: body.projectId ?? null,
        isEnabled: body.isEnabled ?? true,
        createdBy: user.id,
      })
      .returning();

    if (body.triggers?.length) {
      await db.insert(schema.automationTriggers).values(
        body.triggers.map((t: any) => ({
          ruleId: rule.id,
          triggerType: t.triggerType,
          config: t.config ?? {},
        }))
      );
    }

    if (body.conditions?.length) {
      await db.insert(schema.automationConditions).values(
        body.conditions.map((cond: any, idx: number) => ({
          ruleId: rule.id,
          conditionType: cond.conditionType,
          operator: cond.operator ?? 'AND',
          config: cond.config ?? {},
          position: idx,
        }))
      );
    }

    if (body.actions?.length) {
      await db.insert(schema.automationActions).values(
        body.actions.map((act: any, idx: number) => ({
          ruleId: rule.id,
          actionType: act.actionType,
          config: act.config ?? {},
          position: idx,
        }))
      );
    }

    const full = await getRuleWithDetails(rule.id);
    return c.json(full, 201);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to create rule'] }, 400);
  }
});

/* ------------------------------------------------------------------ */
/*  Get rule                                                           */
/* ------------------------------------------------------------------ */
app.get('/rest/api/2/automation/rule/:id', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!(await loadManageable(c, id))) return c.json({ errorMessages: ['Rule not found'] }, 404);
    const rule = await getRuleWithDetails(id);
    if (!rule) return c.json({ errorMessages: ['Rule not found'] }, 404);
    return c.json(rule);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch rule'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Update rule                                                        */
/* ------------------------------------------------------------------ */
app.put('/rest/api/2/automation/rule/:id', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();

    const existingRule = await loadManageable(c, id);
    if (!existingRule) return c.json({ errorMessages: ['Rule not found'] }, 404);
    const user = c.get('user')!;
    if (body.projectId !== undefined) {
      const np = body.projectId == null ? null : Number(body.projectId);
      if (np !== null && !Number.isInteger(np)) return c.json({ errorMessages: ['projectId must be a number'] }, 400);
      if (!(await canManage(user, np))) return c.json(FORBIDDEN_RULE, 403);
    }
    if (usesWebhook(body.actions) && !(await hasGlobalPermission(user.id, 'SYSTEM_ADMIN'))) return c.json({ errorMessages: ['Only system administrators can add webhook actions'] }, 403);

    const setObj: Partial<typeof schema.automationRules.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) setObj.name = body.name;
    if (body.description !== undefined) setObj.description = body.description;
    if (body.projectId !== undefined) setObj.projectId = body.projectId ?? null;
    if (body.isEnabled !== undefined) setObj.isEnabled = body.isEnabled;

    await db.update(schema.automationRules).set(setObj).where(eq(schema.automationRules.id, id));

    // Replace triggers if provided
    if (body.triggers) {
      await db.delete(schema.automationTriggers).where(eq(schema.automationTriggers.ruleId, id));
      if (body.triggers.length) {
        await db.insert(schema.automationTriggers).values(
          body.triggers.map((t: any) => ({
            ruleId: id,
            triggerType: t.triggerType,
            config: t.config ?? {},
          }))
        );
      }
    }

    // Replace conditions if provided
    if (body.conditions) {
      await db.delete(schema.automationConditions).where(eq(schema.automationConditions.ruleId, id));
      if (body.conditions.length) {
        await db.insert(schema.automationConditions).values(
          body.conditions.map((cond: any, idx: number) => ({
            ruleId: id,
            conditionType: cond.conditionType,
            operator: cond.operator ?? 'AND',
            config: cond.config ?? {},
            position: idx,
          }))
        );
      }
    }

    // Replace actions if provided
    if (body.actions) {
      await db.delete(schema.automationActions).where(eq(schema.automationActions.ruleId, id));
      if (body.actions.length) {
        await db.insert(schema.automationActions).values(
          body.actions.map((act: any, idx: number) => ({
            ruleId: id,
            actionType: act.actionType,
            config: act.config ?? {},
            position: idx,
          }))
        );
      }
    }

    const full = await getRuleWithDetails(id);
    return c.json(full);
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to update rule'] }, 400);
  }
});

/* ------------------------------------------------------------------ */
/*  Delete rule                                                        */
/* ------------------------------------------------------------------ */
app.delete('/rest/api/2/automation/rule/:id', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!(await loadManageable(c, id))) return c.json({ errorMessages: ['Rule not found'] }, 404);
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, id));
    return c.json({});
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to delete rule'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Manual execute                                                     */
/* ------------------------------------------------------------------ */
app.post('/rest/api/2/automation/rule/:id/execute', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;

    const managed = await loadManageable(c, id);
    if (!managed) return c.json({ errorMessages: ['Rule not found'] }, 404);
    const rule = [managed];

    const issueKey = body.issueKey as string | undefined;
    let issueId: number | undefined;
    let projectId: number | undefined;
    if (issueKey) {
      const issueRows = await db
        .select()
        .from(schema.issues)
        .where(eq(schema.issues.issueKey, issueKey))
        .limit(1);
      if (issueRows.length > 0) {
        // a project rule only runs on issues of its own project
        if (rule[0].projectId !== null && issueRows[0].projectId !== rule[0].projectId) return c.json({ errorMessages: ['This rule belongs to another project'] }, 400);
        issueId = issueRows[0].id;
        projectId = issueRows[0].projectId;
      }
    }

    await executeRuleManually(rule[0], {
      issueId: issueId ?? 0,
      issueKey: issueKey ?? 'MANUAL',
      projectId: projectId ?? (rule[0].projectId ?? 0),
      userId: user.id,
    });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Execution failed'] }, 400);
  }
});

/* ------------------------------------------------------------------ */
/*  Execution history                                                  */
/* ------------------------------------------------------------------ */
app.get('/rest/api/2/automation/rule/:id/execution', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!(await loadManageable(c, id))) return c.json({ errorMessages: ['Rule not found'] }, 404);
    const executions = await db
      .select()
      .from(schema.automationExecutions)
      .where(eq(schema.automationExecutions.ruleId, id))
      .orderBy(desc(schema.automationExecutions.startedAt))
      .limit(50);

    return c.json({
      startAt: 0,
      maxResults: executions.length,
      total: executions.length,
      isLast: true,
      values: executions,
    });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to fetch executions'] }, 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Toggle enable/disable                                              */
/* ------------------------------------------------------------------ */
app.put('/rest/api/2/automation/rule/:id/toggle', requireAuth, async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    const isEnabled = body.isEnabled === true;

    if (!(await loadManageable(c, id))) return c.json({ errorMessages: ['Rule not found'] }, 404);

    await db
      .update(schema.automationRules)
      .set({ isEnabled, updatedAt: new Date() })
      .where(eq(schema.automationRules.id, id));

    return c.json({ id, isEnabled });
  } catch (err: any) {
    return c.json({ errorMessages: [err.message || 'Failed to toggle rule'] }, 500);
  }
});

export default app;
