import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@veqsio/db';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://veqsio:veqsio@localhost:5460/veqsio_test';

export function createTestSql() {
  return postgres(TEST_DATABASE_URL, { max: 10 });
}

export function createTestDb(sql: ReturnType<typeof postgres>) {
  return drizzle(sql, { schema });
}

export async function resetTestDb(sql: ReturnType<typeof postgres>) {
  const tables = [
    'inbox_notifications',
    'ai_usage',
    'ai_settings',
    'migration_external_refs',
    'migration_sessions',
    'email_queue',
    'webhook_deliveries',
    'webhooks',
    'notification_scheme_events',
    'notification_schemes',
    'project_issue_counters',
    'field_configuration_scheme_associations',
    'field_configuration_items',
    'field_configurations',
    'issue_type_scheme_associations',
    'issue_type_scheme_items',
    'issue_type_schemes',
    'screen_tab_fields',
    'screen_tabs',
    'screens',
    'dashboard_gadgets',
    'dashboards',
    'filters',
    'sprint_issues',
    'sprints',
    'board_columns',
    'boards',
    'custom_field_options',
    'custom_field_contexts',
    'custom_field_values',
    'custom_fields',
    'project_role_actors',
    'project_roles',
    'permission_scheme_associations',
    'permission_entries',
    'permission_schemes',
    'workflow_scheme_associations',
    'workflow_scheme_items',
    'workflow_schemes',
    'workflow_transitions',
    'workflows',
    'votes',
    'watchers',
    'issue_links',
    'link_types',
    'issue_affects_versions',
    'issue_fix_versions',
    'versions',
    'issue_components',
    'components',
    'issue_labels',
    'labels',
    'attachments',
    'comments',
    'issue_history',
    'issues',
    'resolutions',
    'priorities',
    'statuses',
    'issue_types',
    'projects',
    'user_groups',
    'groups',
    'users',
  ];

  for (const table of tables) {
    try {
      await sql`TRUNCATE TABLE ${sql(table)} RESTART IDENTITY CASCADE`;
    } catch {
      // ignore missing tables
    }
  }
}

export async function seedTestData(sql: ReturnType<typeof postgres>) {
  await resetTestDb(sql);
  const db = createTestDb(sql);

  // Seed basic metadata
  const [user] = await db
    .insert(schema.users)
    .values({
      username: 'admin',
      email: 'admin@veqsio.local',
      displayName: 'Administrator',
      passwordHash: '$2a$12$dummyhashfordemopurposesonlynotreal',
    })
    .returning();

  const [project] = await db
    .insert(schema.projects)
    .values({
      projectKey: 'TEST',
      name: 'Test Project',
      leadId: user.id,
    })
    .returning();

  const [issueType] = await db
    .insert(schema.issueTypes)
    .values({ name: 'Task', description: 'A task', isSubtask: false })
    .returning();

  const [status] = await db
    .insert(schema.statuses)
    .values({ name: 'To Do', category: 'todo', color: '#666666' })
    .returning();

  const [status2] = await db
    .insert(schema.statuses)
    .values({ name: 'In Progress', category: 'in_progress', color: '#0052CC' })
    .returning();

  const [priority] = await db
    .insert(schema.priorities)
    .values({ name: 'Medium', color: '#f4c542' })
    .returning();

  const [workflow] = await db
    .insert(schema.workflows)
    .values({ name: 'Default Workflow', isDefault: true })
    .returning();

  await db.insert(schema.workflowTransitions).values({
    workflowId: workflow.id,
    name: 'Start Progress',
    fromStatusId: status.id,
    toStatusId: status2.id,
    conditions: JSON.stringify([{ type: 'always_true' }]),
    validators: JSON.stringify([]),
    postFunctions: JSON.stringify([]),
  });

  const [wfScheme] = await db
    .insert(schema.workflowSchemes)
    .values({ name: 'Default Scheme' })
    .returning();

  await db.insert(schema.workflowSchemeItems).values({
    schemeId: wfScheme.id,
    issueTypeId: issueType.id,
    workflowId: workflow.id,
  });

  await db.insert(schema.workflowSchemeAssociations).values({
    projectId: project.id,
    schemeId: wfScheme.id,
  });

  const [permScheme] = await db
    .insert(schema.permissionSchemes)
    .values({ name: 'Default Permission Scheme' })
    .returning();

  await db.insert(schema.permissionSchemeAssociations).values({
    projectId: project.id,
    schemeId: permScheme.id,
  });

  return { user, project, issueType, status, status2, priority, workflow, permScheme };
}
