import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

const connectionString = process.env.DATABASE_URL || 'postgresql://veqsio:veqsio@localhost:5460/veqsio';
const sql = postgres(connectionString);
const db = drizzle(sql, { schema });

async function seed() {
  console.log('Seeding database...');

  // Check if already seeded
  const existing = await db.select().from(schema.statuses).limit(1);
  if (existing.length > 0) {
    console.log('Database already seeded. Skipping.');
    await sql.end();
    return;
  }

  // Checked before the first insert: a refusal half way through would leave statuses and groups behind, and the next run would say "already seeded" without an administrator.
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (process.env.NODE_ENV === 'production' && adminPassword === 'admin123') {
    throw new Error('Refusing to seed the default administrator password in production. Set ADMIN_PASSWORD.');
  }

  // Statuses
  const [open, inProgress, resolved, closed, reopened] = await db.insert(schema.statuses).values([
    { name: 'Open', description: 'Issue is open and ready for work', category: 'to_do', color: '#505F79', sortOrder: 1 },
    { name: 'In Progress', description: 'Issue is being worked on', category: 'in_progress', color: '#0052CC', sortOrder: 2 },
    { name: 'Resolved', description: 'Issue has been resolved', category: 'done', color: '#36B37E', sortOrder: 3 },
    { name: 'Closed', description: 'Issue is closed', category: 'done', color: '#36B37E', sortOrder: 4 },
    { name: 'Reopened', description: 'Issue was reopened', category: 'to_do', color: '#FFAB00', sortOrder: 5 },
  ]).returning();

  // Priorities
  await db.insert(schema.priorities).values([
    { name: 'Highest', description: 'Critical priority', color: '#DE350B', sortOrder: 1 },
    { name: 'High', description: 'High priority', color: '#FF5630', sortOrder: 2 },
    { name: 'Medium', description: 'Normal priority', color: '#FF991F', sortOrder: 3 },
    { name: 'Low', description: 'Low priority', color: '#36B37E', sortOrder: 4 },
    { name: 'Lowest', description: 'Very low priority', color: '#00B8D9', sortOrder: 5 },
  ]);

  // Issue Types
  const [bug, task, story, epic, subTask] = await db.insert(schema.issueTypes).values([
    { name: 'Bug', description: 'A problem or error', iconUrl: '/icons/bug.svg', color: '#E5493A' },
    { name: 'Task', description: 'A unit of work', iconUrl: '/icons/task.svg', color: '#4BADE8' },
    { name: 'Story', description: 'A user story', iconUrl: '/icons/story.svg', color: '#65BA43' },
    { name: 'Epic', description: 'Large body of work', iconUrl: '/icons/epic.svg', color: '#904EE2' },
    { name: 'Sub-task', description: 'A sub-task', iconUrl: '/icons/subtask.svg', isSubtask: true, color: '#4BADE8' },
  ]).returning();

  // Resolutions
  await db.insert(schema.resolutions).values([
    { name: 'Fixed', description: 'Issue has been fixed' },
    { name: "Won't Fix", description: 'Issue will not be fixed' },
    { name: 'Duplicate', description: 'Duplicate of another issue' },
    { name: 'Incomplete', description: 'Not enough information' },
    { name: 'Cannot Reproduce', description: 'Could not reproduce' },
    { name: 'Done', description: 'Work is completed' },
  ]);

  // Link types (migration 0017 already adds the built-in ones; only insert what is missing)
  const haveLinkTypes = new Set((await db.select({ name: schema.linkTypes.name }).from(schema.linkTypes)).map((t) => t.name.toLowerCase()));
  const missingLinkTypes = [
    { name: 'Blocks', inward: 'is blocked by', outward: 'blocks', isSystem: true },
    { name: 'Cloners', inward: 'is cloned by', outward: 'clones', isSystem: true },
    { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates', isSystem: true },
    { name: 'Relates', inward: 'relates to', outward: 'relates to', isSystem: true },
    { name: 'Implements', inward: 'is implemented by', outward: 'implements', isSystem: true },
    { name: 'Starts before', inward: 'starts after', outward: 'starts before', scheduling: 'starts_before', isSystem: true },
    { name: 'Finishes before', inward: 'finishes after', outward: 'finishes before', scheduling: 'finishes_before', isSystem: true },
  ].filter((t) => !haveLinkTypes.has(t.name.toLowerCase()));
  if (missingLinkTypes.length) await db.insert(schema.linkTypes).values(missingLinkTypes);

  // Project Roles
  const [adminRole, devRole, viewerRole] = await db.insert(schema.projectRoles).values([
    { name: 'Administrators', description: 'Project administrators' },
    { name: 'Developers', description: 'Developers who work on issues' },
    { name: 'Viewers', description: 'Users who can only view' },
  ]).returning();

  // Groups
  const [adminGroup, devGroup, userGroup] = await db.insert(schema.groups).values([
    { name: 'veqsio-administrators', description: 'System administrators' },
    { name: 'veqsio-developers', description: 'Developers' },
    { name: 'veqsio-users', description: 'All users' },
  ]).returning();

  // Admin user. Development default is admin / admin123; production and cloud provisioning set
  // ADMIN_PASSWORD (and ADMIN_EMAIL) so no instance is ever created with a well-known password.
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const [adminUser] = await db.insert(schema.users).values({
    username: 'admin',
    email: process.env.ADMIN_EMAIL || 'admin@veqsio.local',
    displayName: 'Administrator',
    passwordHash,
    active: true,
  }).returning();

  // Assign admin to groups
  await db.insert(schema.userGroups).values([
    { userId: adminUser.id, groupId: adminGroup.id },
    { userId: adminUser.id, groupId: userGroup.id },
  ]);

  // Default workflow
  const [defaultWorkflow] = await db.insert(schema.workflows).values({
    name: 'Default Workflow',
    description: 'The default Jira workflow',
    isDefault: true,
  }).returning();

  // Default workflow transitions
  await db.insert(schema.workflowTransitions).values([
    { workflowId: defaultWorkflow.id, name: 'Start Progress', fromStatusId: open.id, toStatusId: inProgress.id, conditions: '[{"type":"permission_check","permission":"TRANSITION_ISSUES"}]', validators: '[]', postFunctions: '[{"type":"update_field","field":"status","value":"{{to_status}}"},{"type":"fire_event","event_id":"issue_generic"}]' },
    { workflowId: defaultWorkflow.id, name: 'Resolve', fromStatusId: inProgress.id, toStatusId: resolved.id, conditions: '[{"type":"permission_check","permission":"TRANSITION_ISSUES"}]', validators: '[{"type":"field_required","field":"resolution"}]', postFunctions: '[{"type":"update_field","field":"status","value":"{{to_status}}"},{"type":"set_resolution","resolution_id":null},{"type":"update_date","field":"resolved_at"},{"type":"fire_event","event_id":"issue_resolved"}]' },
    { workflowId: defaultWorkflow.id, name: 'Close', fromStatusId: resolved.id, toStatusId: closed.id, conditions: '[{"type":"permission_check","permission":"TRANSITION_ISSUES"}]', validators: '[]', postFunctions: '[{"type":"update_field","field":"status","value":"{{to_status}}"},{"type":"fire_event","event_id":"issue_closed"}]' },
    { workflowId: defaultWorkflow.id, name: 'Reopen', fromStatusId: closed.id, toStatusId: reopened.id, conditions: '[{"type":"permission_check","permission":"TRANSITION_ISSUES"}]', validators: '[]', postFunctions: '[{"type":"update_field","field":"status","value":"{{to_status}}"},{"type":"clear_field","field":"resolution"},{"type":"fire_event","event_id":"issue_reopened"}]' },
    { workflowId: defaultWorkflow.id, name: 'Resolve', fromStatusId: open.id, toStatusId: resolved.id, conditions: '[{"type":"permission_check","permission":"TRANSITION_ISSUES"}]', validators: '[{"type":"field_required","field":"resolution"}]', postFunctions: '[{"type":"update_field","field":"status","value":"{{to_status}}"},{"type":"set_resolution","resolution_id":null},{"type":"update_date","field":"resolved_at"},{"type":"fire_event","event_id":"issue_resolved"}]' },
    { workflowId: defaultWorkflow.id, name: 'Start Progress', fromStatusId: reopened.id, toStatusId: inProgress.id, conditions: '[{"type":"permission_check","permission":"TRANSITION_ISSUES"}]', validators: '[]', postFunctions: '[{"type":"update_field","field":"status","value":"{{to_status}}"},{"type":"fire_event","event_id":"issue_generic"}]' },
  ]);

  // Default permission scheme
  const [defaultScheme] = await db.insert(schema.permissionSchemes).values({
    name: 'Default Permission Scheme',
    description: 'Default scheme for new projects',
  }).returning();

  // Permission entries for default scheme
  await db.insert(schema.permissionEntries).values([
    { schemeId: defaultScheme.id, permissionKey: 'ADMINISTER', groupId: adminGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'BROWSE_PROJECTS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'CREATE_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'EDIT_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'ASSIGN_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'RESOLVE_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'CLOSE_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'TRANSITION_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'COMMENT_ISSUE', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'ADD_COMMENTS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'CREATE_ATTACHMENTS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'DELETE_OWN_ATTACHMENTS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'EDIT_OWN_COMMENTS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'DELETE_OWN_COMMENTS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'WORK_ON_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'LINK_ISSUES', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'MANAGE_WATCHERS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'VIEW_VOTERS_AND_WATCHERS', groupId: userGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'PROJECT_ADMIN', groupId: adminGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'SET_ISSUE_SECURITY', groupId: adminGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'DELETE_ALL_ATTACHMENTS', groupId: adminGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'DELETE_ALL_COMMENTS', groupId: adminGroup.id },
    { schemeId: defaultScheme.id, permissionKey: 'EDIT_ALL_COMMENTS', groupId: adminGroup.id },
  ]);

  // Default project
  const [defaultProject] = await db.insert(schema.projects).values({
    projectKey: 'DEMO',
    name: 'Demo Project',
    description: 'A sample project to get started with Veqsio',
    leadId: adminUser.id,
    category: 'Software',
  }).returning();

  await db.insert(schema.permissionSchemeAssociations).values({
    projectId: defaultProject.id,
    schemeId: defaultScheme.id,
  });

  // Assign admin user to Administrators role for default project
  await db.insert(schema.projectRoleActors).values({
    projectId: defaultProject.id,
    roleId: adminRole.id,
    userId: adminUser.id,
    groupId: null,
  });

  console.log('Seed complete.');
  await sql.end();
}

seed().catch(console.error);
