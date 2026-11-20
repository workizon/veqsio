import { type AnyPgColumn, pgTable, serial, varchar, text, boolean, timestamp, integer, primaryKey, jsonb, bigserial, bigint, date, uuid, numeric, index, uniqueIndex, smallint } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }),
  active: boolean('active').default(true),
  avatarUrl: text('avatar_url'),
  timezone: varchar('timezone', { length: 100 }).default('UTC'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const groups = pgTable('groups', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  description: text('description'),
});

export const userGroups = pgTable('user_groups', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.groupId] }),
  userIdIdx: index('user_groups_user_id_idx').on(table.userId),
  groupIdIdx: index('user_groups_group_id_idx').on(table.groupId),
}));

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  projectKey: varchar('project_key', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  leadId: integer('lead_id').references(() => users.id),
  category: varchar('category', { length: 100 }),
  avatarUrl: text('avatar_url'),
  // Read-only access for anyone on the internet (needs the instance setting publicProjectsEnabled). Never set for service desk projects.
  isPublic: boolean('is_public').default(false).notNull(),
  // Search engines: 'inherit' follows the instance policy, 'none' asks them not to index this project even when the instance allows it
  publicIndexing: varchar('public_indexing', { length: 10 }).notNull().default('inherit'),
  // Public project extras, off until a project administrator turns them on: a read-only board and a roadmap of released/planned versions
  publicBoard: boolean('public_board').notNull().default(false),
  publicRoadmap: boolean('public_roadmap').notNull().default(false),
  // Ids of switchable features turned off for this project only (see api/src/features).
  disabledFeatures: jsonb('disabled_features').$type<string[]>().default([]).notNull(),
  // Set while the project is archived: read-only, hidden from default lists, restorable. Only archived projects can be deleted.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedBy: integer('archived_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  leadIdIdx: index('projects_lead_id_idx').on(table.leadId),
}));

export const issueTypes = pgTable('issue_types', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),
  isSubtask: boolean('is_subtask').default(false),
  color: varchar('color', { length: 7 }).default('#0052CC'),
});

export const statuses = pgTable('statuses', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 20 }).notNull(),
  color: varchar('color', { length: 7 }).default('#666666'),
  sortOrder: integer('sort_order').default(0),
  // Workflow governance: false = no issue may be created directly into this status.
  allowNewIssues: boolean('allow_new_issues').default(true).notNull(),
});

export const priorities = pgTable('priorities', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),
  color: varchar('color', { length: 7 }).default('#666666'),
  sortOrder: integer('sort_order').default(0),
});

export const resolutions = pgTable('resolutions', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
});

export const issues = pgTable('issues', {
  id: serial('id').primaryKey(),
  issueKey: varchar('issue_key', { length: 100 }).notNull().unique(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  issueTypeId: integer('issue_type_id').notNull().references(() => issueTypes.id),
  statusId: integer('status_id').notNull().references(() => statuses.id),
  priorityId: integer('priority_id').references(() => priorities.id),
  resolutionId: integer('resolution_id').references(() => resolutions.id),
  summary: varchar('summary', { length: 500 }).notNull(),
  description: text('description'),
  assigneeId: integer('assignee_id').references(() => users.id),
  reporterId: integer('reporter_id').notNull().references(() => users.id),
  environment: text('environment'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  dueDate: timestamp('due_date', { withTimezone: true }),
  startDate: timestamp('start_date', { withTimezone: true }),
  storyPoints: numeric('story_points', { precision: 8, scale: 2 }),
  // Explicit order inside the backlog (null = not ranked yet, sorted after ranked ones).
  backlogRank: integer('backlog_rank'),
  parentId: integer('parent_id').references((): AnyPgColumn => issues.id),
  /** Impediment flag (Jira "Flagged"): shown on cards and boards, JQL `flagged`, changes land in issue_history. */
  flagged: boolean('flagged').notNull().default(false),
  timeEstimate: integer('time_estimate'),
  timeSpent: integer('time_spent'),
  // Issue security: when set, only members of that level see the issue (see api/src/security/issue-security.ts).
  securityLevelId: integer('security_level_id').references((): any => issueSecurityLevels.id),
}, (table) => ({
  projectIdIdx: index('issues_project_id_idx').on(table.projectId),
  statusIdIdx: index('issues_status_id_idx').on(table.statusId),
  assigneeIdIdx: index('issues_assignee_id_idx').on(table.assigneeId),
  reporterIdIdx: index('issues_reporter_id_idx').on(table.reporterId),
  issueTypeIdIdx: index('issues_issue_type_id_idx').on(table.issueTypeId),
  priorityIdIdx: index('issues_priority_id_idx').on(table.priorityId),
  resolutionIdIdx: index('issues_resolution_id_idx').on(table.resolutionId),
  parentIdIdx: index('issues_parent_id_idx').on(table.parentId),
  createdAtIdx: index('issues_created_at_idx').on(table.createdAt),
  // Composite indexes for per-project lists, boards and JQL (see sql/001_perf_indexes.sql for the production variant).
  projectCreatedIdx: index('issues_project_created_idx').on(table.projectId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
  projectUpdatedIdx: index('issues_project_updated_idx').on(table.projectId, table.updatedAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
  projectStatusIdx: index('issues_project_status_idx').on(table.projectId, table.statusId),
  assigneeOpenIdx: index('issues_assignee_open_idx').on(table.assigneeId, table.createdAt.desc().nullsFirst()).where(sql`resolution_id IS NULL`),
}));

export const issueHistory = pgTable('issue_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  fieldName: varchar('field_name', { length: 100 }).notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  authorId: integer('author_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  issueIdIdx: index('issue_history_issue_id_idx').on(table.issueId),
  issueCreatedIdx: index('issue_history_issue_created_idx').on(table.issueId, table.createdAt.desc().nullsFirst()),
  authorIdIdx: index('issue_history_author_id_idx').on(table.authorId),
}));

export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  authorId: integer('author_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  isInternal: boolean('is_internal').default(false),
  // Threading: id of the comment this one replies to (same issue). Plain integer, no FK, to avoid circular typing.
  parentCommentId: integer('parent_comment_id'),
}, (table) => ({
  parentIdx: index('comments_parent_comment_id_idx').on(table.parentCommentId),
  issueIdIdx: index('comments_issue_id_idx').on(table.issueId),
  issueCreatedIdx: index('comments_issue_created_idx').on(table.issueId, table.createdAt),
  authorIdIdx: index('comments_author_id_idx').on(table.authorId),
}));

export const commentReactions = pgTable('comment_reactions', {
  commentId: integer('comment_id').notNull().references(() => comments.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: varchar('emoji', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.commentId, table.userId, table.emoji] }),
}));

export const attachments = pgTable('attachments', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  filename: varchar('filename', { length: 255 }).notNull(),
  filesize: bigint('filesize', { mode: 'number' }).notNull(),
  mimetype: varchar('mimetype', { length: 100 }).notNull(),
  storageKey: text('storage_key').notNull().unique(),
  authorId: integer('author_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  issueIdIdx: index('attachments_issue_id_idx').on(table.issueId),
  authorIdIdx: index('attachments_author_id_idx').on(table.authorId),
}));

export const labels = pgTable('labels', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  // Palette token (e.g. 'blue') or a custom '#rrggbb' hex; null means the neutral default.
  color: varchar('color', { length: 16 }),
  // When true the label is detached from an issue as soon as that issue is resolved.
  removeOnResolve: boolean('remove_on_resolve').notNull().default(false),
});

export const issueLabels = pgTable('issue_labels', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  labelId: integer('label_id').notNull().references(() => labels.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.issueId, table.labelId] }),
  issueIdIdx: index('issue_labels_issue_id_idx').on(table.issueId),
  labelIdIdx: index('issue_labels_label_id_idx').on(table.labelId),
}));

export const components = pgTable('components', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  leadId: integer('lead_id').references(() => users.id),
}, (table) => ({
  projectIdIdx: index('components_project_id_idx').on(table.projectId),
  leadIdIdx: index('components_lead_id_idx').on(table.leadId),
}));

export const issueComponents = pgTable('issue_components', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  componentId: integer('component_id').notNull().references(() => components.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.issueId, table.componentId] }),
  issueIdIdx: index('issue_components_issue_id_idx').on(table.issueId),
  componentIdIdx: index('issue_components_component_id_idx').on(table.componentId),
}));

export const versions = pgTable('versions', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  startDate: date('start_date'),
  releaseDate: date('release_date'),
  released: boolean('released').default(false),
  archived: boolean('archived').default(false),
}, (table) => ({
  projectIdIdx: index('versions_project_id_idx').on(table.projectId),
}));

export const issueFixVersions = pgTable('issue_fix_versions', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  versionId: integer('version_id').notNull().references(() => versions.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.issueId, table.versionId] }),
  issueIdIdx: index('issue_fix_versions_issue_id_idx').on(table.issueId),
  versionIdIdx: index('issue_fix_versions_version_id_idx').on(table.versionId),
}));

export const issueAffectsVersions = pgTable('issue_affects_versions', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  versionId: integer('version_id').notNull().references(() => versions.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.issueId, table.versionId] }),
  issueIdIdx: index('issue_affects_versions_issue_id_idx').on(table.issueId),
  versionIdIdx: index('issue_affects_versions_version_id_idx').on(table.versionId),
}));

export const linkTypes = pgTable('link_types', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  inward: varchar('inward', { length: 100 }).notNull(),
  outward: varchar('outward', { length: 100 }).notNull(),
  // Dependency scheduling semantics: null for plain relations, else 'starts_before' | 'finishes_before'.
  scheduling: varchar('scheduling', { length: 20 }),
  // Built-in types cannot be deleted or renamed; custom types are created by administrators.
  isSystem: boolean('is_system').default(false).notNull(),
});

export const issueLinks = pgTable('issue_links', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  linkedIssueId: integer('linked_issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  linkTypeId: integer('link_type_id').references(() => linkTypes.id),
}, (table) => ({
  issueIdIdx: index('issue_links_issue_id_idx').on(table.issueId),
  linkedIssueIdIdx: index('issue_links_linked_issue_id_idx').on(table.linkedIssueId),
  linkTypeIdIdx: index('issue_links_link_type_id_idx').on(table.linkTypeId),
}));

export const watchers = pgTable('watchers', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.issueId, table.userId] }),
  issueIdIdx: index('watchers_issue_id_idx').on(table.issueId),
  userIdIdx: index('watchers_user_id_idx').on(table.userId),
}));

export const votes = pgTable('votes', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.issueId, table.userId] }),
  issueIdIdx: index('votes_issue_id_idx').on(table.issueId),
  userIdIdx: index('votes_user_id_idx').on(table.userId),
}));

export const workflows = pgTable('workflows', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  isDefault: boolean('is_default').default(false),
  // Designer canvas: { nodes: { "<statusId>": { x, y } } }. A status listed here belongs to the workflow
  // even before it has transitions. Not used by the engine.
  designerLayout: jsonb('designer_layout').default({ nodes: {} }),
}, (table) => ({
  // At most one default workflow (the application keeps it at exactly one).
  oneDefault: uniqueIndex('workflows_one_default_idx').on(table.isDefault).where(sql`${table.isDefault} = true`),
}));

export const workflowTransitions = pgTable('workflow_transitions', {
  id: serial('id').primaryKey(),
  workflowId: integer('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  fromStatusId: integer('from_status_id').references(() => statuses.id),
  toStatusId: integer('to_status_id').notNull().references(() => statuses.id),
  screenId: integer('screen_id'),
  conditions: jsonb('conditions').default('[]'),
  validators: jsonb('validators').default('[]'),
  postFunctions: jsonb('post_functions').default('[]'),
}, (table) => ({
  workflowIdIdx: index('workflow_transitions_workflow_id_idx').on(table.workflowId),
  fromStatusIdIdx: index('workflow_transitions_from_status_id_idx').on(table.fromStatusId),
  toStatusIdIdx: index('workflow_transitions_to_status_id_idx').on(table.toStatusId),
}));

// Who changed which part of a workflow when (shown in the workflow designer). Additive audit trail, never read by the engine.
export const workflowChangeLog = pgTable('workflow_change_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workflowId: integer('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
  // workflow | transition | status | condition | validator | postFunction | layout | scheme
  targetType: varchar('target_type', { length: 30 }).notNull(),
  action: varchar('action', { length: 20 }).notNull(),
  summary: text('summary').notNull(),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workflowCreatedIdx: index('workflow_change_log_workflow_created_idx').on(table.workflowId, table.createdAt.desc().nullsFirst()),
}));

export const workflowSchemes = pgTable('workflow_schemes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
});

export const workflowSchemeItems = pgTable('workflow_scheme_items', {
  schemeId: integer('scheme_id').notNull().references(() => workflowSchemes.id, { onDelete: 'cascade' }),
  issueTypeId: integer('issue_type_id').notNull().references(() => issueTypes.id, { onDelete: 'cascade' }),
  workflowId: integer('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.schemeId, table.issueTypeId] }),
  schemeIdIdx: index('workflow_scheme_items_scheme_id_idx').on(table.schemeId),
  workflowIdIdx: index('workflow_scheme_items_workflow_id_idx').on(table.workflowId),
}));

export const workflowSchemeAssociations = pgTable('workflow_scheme_associations', {
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  schemeId: integer('scheme_id').notNull().references(() => workflowSchemes.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId] }),
  schemeIdIdx: index('workflow_scheme_associations_scheme_id_idx').on(table.schemeId),
}));

export const permissionSchemes = pgTable('permission_schemes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
});

export const permissionEntries = pgTable('permission_entries', {
  id: serial('id').primaryKey(),
  schemeId: integer('scheme_id').notNull().references(() => permissionSchemes.id, { onDelete: 'cascade' }),
  permissionKey: varchar('permission_key', { length: 100 }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
  projectRoleId: integer('project_role_id').references(() => projectRoles.id, { onDelete: 'cascade' }),
  anyUser: boolean('any_user').default(false),
  // Grants the permission to the lead of the project the check is about.
  projectLead: boolean('project_lead').default(false),
  anonymous: boolean('anonymous').default(false),
}, (table) => ({
  schemeIdIdx: index('permission_entries_scheme_id_idx').on(table.schemeId),
  permissionKeyIdx: index('permission_entries_permission_key_idx').on(table.permissionKey),
  userIdIdx: index('permission_entries_user_id_idx').on(table.userId),
  groupIdIdx: index('permission_entries_group_id_idx').on(table.groupId),
  projectRoleIdIdx: index('permission_entries_project_role_id_idx').on(table.projectRoleId),
}));

export const permissionSchemeAssociations = pgTable('permission_scheme_associations', {
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  schemeId: integer('scheme_id').notNull().references(() => permissionSchemes.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId] }),
  schemeIdIdx: index('permission_scheme_associations_scheme_id_idx').on(table.schemeId),
}));

export const projectRoles = pgTable('project_roles', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
});

export const projectRoleActors = pgTable('project_role_actors', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  roleId: integer('role_id').notNull().references(() => projectRoles.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
}, (table) => ({
  projectIdIdx: index('project_role_actors_project_id_idx').on(table.projectId),
  roleIdIdx: index('project_role_actors_role_id_idx').on(table.roleId),
  userIdIdx: index('project_role_actors_user_id_idx').on(table.userId),
  groupIdIdx: index('project_role_actors_group_id_idx').on(table.groupId),
}));

export const customFields = pgTable('custom_fields', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  fieldType: varchar('field_type', { length: 50 }).notNull(),
  description: text('description'),
  defaultValue: text('default_value'),
  searcherKey: varchar('searcher_key', { length: 100 }),
  isGlobal: boolean('is_global').default(true),
});

export const customFieldValues = pgTable('custom_field_values', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  customFieldId: integer('custom_field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
  stringValue: varchar('string_value', { length: 500 }),
  numberValue: numeric('number_value'),
  dateValue: timestamp('date_value', { withTimezone: true }),
  userValue: integer('user_value').references(() => users.id),
  textValue: text('text_value'),
  booleanValue: boolean('boolean_value'),
}, (table) => ({
  issueIdIdx: index('custom_field_values_issue_id_idx').on(table.issueId),
  customFieldIdIdx: index('custom_field_values_custom_field_id_idx').on(table.customFieldId),
  userValueIdx: index('custom_field_values_user_value_idx').on(table.userValue),
}));

export const customFieldContexts = pgTable('custom_field_contexts', {
  id: serial('id').primaryKey(),
  customFieldId: integer('custom_field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  issueTypeId: integer('issue_type_id').references(() => issueTypes.id, { onDelete: 'cascade' }),
  // The value a new issue gets when the field is not filled in, for issues in this context (the field's own default applies when this is null).
  defaultValue: text('default_value'),
}, (table) => ({
  customFieldIdIdx: index('custom_field_contexts_custom_field_id_idx').on(table.customFieldId),
  projectIdIdx: index('custom_field_contexts_project_id_idx').on(table.projectId),
  issueTypeIdIdx: index('custom_field_contexts_issue_type_id_idx').on(table.issueTypeId),
}));

export const customFieldOptions = pgTable('custom_field_options', {
  id: serial('id').primaryKey(),
  customFieldId: integer('custom_field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
  contextId: integer('context_id').notNull().references(() => customFieldContexts.id, { onDelete: 'cascade' }),
  value: varchar('value', { length: 255 }).notNull(),
  sortOrder: integer('sort_order').default(0),
  description: text('description'),
  color: varchar('color', { length: 7 }),
  // Archived values are no longer offered, but issues that already carry them keep showing them.
  archived: boolean('archived').default(false).notNull(),
}, (table) => ({
  customFieldIdIdx: index('custom_field_options_custom_field_id_idx').on(table.customFieldId),
  contextIdIdx: index('custom_field_options_context_id_idx').on(table.contextId),
}));

export const boards = pgTable('boards', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 20 }).notNull(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  filterId: integer('filter_id'),
  config: jsonb('config').default('{}'),
}, (table) => ({
  projectIdIdx: index('boards_project_id_idx').on(table.projectId),
}));

export const boardColumns = pgTable('board_columns', {
  id: serial('id').primaryKey(),
  boardId: integer('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  statusId: integer('status_id').references(() => statuses.id),
  name: varchar('name', { length: 100 }).notNull(),
  min: integer('min'),
  max: integer('max'),
  sortOrder: integer('sort_order').default(0),
}, (table) => ({
  boardIdIdx: index('board_columns_board_id_idx').on(table.boardId),
  statusIdIdx: index('board_columns_status_id_idx').on(table.statusId),
}));

export const boardQuickFilters = pgTable('board_quick_filters', {
  id: serial('id').primaryKey(),
  boardId: integer('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  jql: text('jql').notNull(),
  sortOrder: integer('sort_order').default(0),
}, (table) => ({
  boardIdIdx: index('board_quick_filters_board_id_idx').on(table.boardId),
}));

export const sprints = pgTable('sprints', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  goal: text('goal'),
  state: varchar('state', { length: 20 }).default('future'),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  completeDate: timestamp('complete_date', { withTimezone: true }),
  boardId: integer('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
}, (table) => ({
  boardIdIdx: index('sprints_board_id_idx').on(table.boardId),
}));

export const sprintIssues = pgTable('sprint_issues', {
  sprintId: integer('sprint_id').notNull().references(() => sprints.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  /** Position of the issue inside the sprint (planning order). */
  sortOrder: integer('sort_order').notNull().default(0),
  /** When the issue joined the sprint; later than the sprint start means scope added after start. */
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sprintId, table.issueId] }),
  sprintIdIdx: index('sprint_issues_sprint_id_idx').on(table.sprintId),
  issueIdIdx: index('sprint_issues_issue_id_idx').on(table.issueId),
}));

export const filters = pgTable('filters', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  jql: text('jql').notNull(),
  authorId: integer('author_id').references(() => users.id),
  favourite: boolean('favourite').default(false),
  shares: jsonb('shares').default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  authorIdIdx: index('filters_author_id_idx').on(table.authorId),
}));

/**
 * Saved views: a saved query + layout + display settings (`config`, validated by the API). Sharing uses the same
 * `shares` array as saved filters ({type: user|group|project|global}).
 */
export const views = pgTable('views', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  config: jsonb('config').notNull().default('{}'),
  shares: jsonb('shares').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ownerIdIdx: index('views_owner_id_idx').on(table.ownerId),
}));

/** Per-user favourites of views (also for views shared by others). viewKey is "builtin:<key>" or the numeric view id. */
export const viewFavourites = pgTable('view_favourites', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  viewKey: varchar('view_key', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.viewKey] }),
}));

export const dashboards = pgTable('dashboards', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  ownerId: integer('owner_id').references(() => users.id),
  shares: jsonb('shares').default('[]'),
  layout: varchar('layout', { length: 20 }).default('2-column'),
  description: text('description'),
  icon: varchar('icon', { length: 40 }),
  /** Auto-refresh of the whole dashboard in seconds; 0 = off. */
  refreshInterval: integer('refresh_interval').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  ownerIdIdx: index('dashboards_owner_id_idx').on(table.ownerId),
}));

export const dashboardGadgets = pgTable('dashboard_gadgets', {
  id: serial('id').primaryKey(),
  dashboardId: integer('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
  gadgetType: varchar('gadget_type', { length: 50 }).notNull(),
  columnIndex: integer('column_index').default(0),
  rowIndex: integer('row_index').default(0),
  config: jsonb('config').default('{}'),
  /** 12-column grid rectangle. Null on rows written before the grid existed (derived from column/row on read). */
  posX: integer('pos_x'),
  posY: integer('pos_y'),
  width: integer('width'),
  height: integer('height'),
}, (table) => ({
  dashboardIdIdx: index('dashboard_gadgets_dashboard_id_idx').on(table.dashboardId),
}));

/** Who else may open (view) or change (edit) a dashboard. shareType: user | group | project | everyone. */
export const dashboardShares = pgTable('dashboard_shares', {
  id: serial('id').primaryKey(),
  dashboardId: integer('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
  shareType: varchar('share_type', { length: 20 }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  permission: varchar('permission', { length: 10 }).notNull().default('view'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  dashboardIdIdx: index('dashboard_shares_dashboard_id_idx').on(table.dashboardId),
  userIdIdx: index('dashboard_shares_user_id_idx').on(table.userId),
  groupIdIdx: index('dashboard_shares_group_id_idx').on(table.groupId),
  projectIdIdx: index('dashboard_shares_project_id_idx').on(table.projectId),
}));

export const dashboardFavourites = pgTable('dashboard_favourites', {
  dashboardId: integer('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.dashboardId, table.userId] }),
  userIdIdx: index('dashboard_favourites_user_id_idx').on(table.userId),
}));

/** Per-user dashboard preferences (the dashboard that opens as the user's home). */
export const dashboardUserPrefs = pgTable('dashboard_user_prefs', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  defaultDashboardId: integer('default_dashboard_id').references(() => dashboards.id, { onDelete: 'set null' }),
});

export const screens = pgTable('screens', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
});

export const screenTabs = pgTable('screen_tabs', {
  id: serial('id').primaryKey(),
  screenId: integer('screen_id').notNull().references(() => screens.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  sortOrder: integer('sort_order').default(0),
}, (table) => ({
  screenIdIdx: index('screen_tabs_screen_id_idx').on(table.screenId),
}));

export const screenTabFields = pgTable('screen_tab_fields', {
  id: serial('id').primaryKey(),
  tabId: integer('tab_id').notNull().references(() => screenTabs.id, { onDelete: 'cascade' }),
  fieldId: integer('field_id').notNull(),
  isCustomField: boolean('is_custom_field').default(false),
  // System field key (assignee, priority, labels, ...) for screen fields that are not custom fields; fieldId is 0 then.
  fieldKey: varchar('field_key', { length: 50 }),
  // A required field must be filled in when the screen is used on a workflow transition.
  required: boolean('required').default(false).notNull(),
  sortOrder: integer('sort_order').default(0),
}, (table) => ({
  tabIdIdx: index('screen_tab_fields_tab_id_idx').on(table.tabId),
}));

export const issueTypeSchemes = pgTable('issue_type_schemes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  defaultIssueTypeId: integer('default_issue_type_id').references(() => issueTypes.id),
});

export const issueTypeSchemeItems = pgTable('issue_type_scheme_items', {
  schemeId: integer('scheme_id').notNull().references(() => issueTypeSchemes.id, { onDelete: 'cascade' }),
  issueTypeId: integer('issue_type_id').notNull().references(() => issueTypes.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.schemeId, table.issueTypeId] }),
  schemeIdIdx: index('issue_type_scheme_items_scheme_id_idx').on(table.schemeId),
}));

export const issueTypeSchemeAssociations = pgTable('issue_type_scheme_associations', {
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  schemeId: integer('scheme_id').notNull().references(() => issueTypeSchemes.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId] }),
  schemeIdIdx: index('issue_type_scheme_associations_scheme_id_idx').on(table.schemeId),
}));

export const prioritySchemes = pgTable('priority_schemes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  defaultPriorityId: integer('default_priority_id').references(() => priorities.id, { onDelete: 'set null' }),
});

export const prioritySchemeItems = pgTable('priority_scheme_items', {
  schemeId: integer('scheme_id').notNull().references(() => prioritySchemes.id, { onDelete: 'cascade' }),
  priorityId: integer('priority_id').notNull().references(() => priorities.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.schemeId, table.priorityId] }),
}));

/** A project without a row here accepts every priority (the behaviour before priority schemes existed). */
export const prioritySchemeAssociations = pgTable('priority_scheme_associations', {
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  schemeId: integer('scheme_id').notNull().references(() => prioritySchemes.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId] }),
  schemeIdIdx: index('priority_scheme_associations_scheme_id_idx').on(table.schemeId),
}));

export const fieldConfigurations = pgTable('field_configurations', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
});

export const fieldConfigurationItems = pgTable('field_configuration_items', {
  id: serial('id').primaryKey(),
  configId: integer('config_id').notNull().references(() => fieldConfigurations.id, { onDelete: 'cascade' }),
  fieldId: integer('field_id').notNull(),
  isCustomField: boolean('is_custom_field').default(false),
  isVisible: boolean('is_visible').default(true),
  isRequired: boolean('is_required').default(false),
  renderer: varchar('renderer', { length: 50 }),
}, (table) => ({
  configIdIdx: index('field_configuration_items_config_id_idx').on(table.configId),
}));

export const fieldConfigurationSchemeAssociations = pgTable('field_configuration_scheme_associations', {
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  issueTypeId: integer('issue_type_id').notNull().references(() => issueTypes.id, { onDelete: 'cascade' }),
  configId: integer('config_id').notNull().references(() => fieldConfigurations.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId, table.issueTypeId] }),
  projectIdIdx: index('field_configuration_scheme_associations_project_id_idx').on(table.projectId),
  configIdIdx: index('field_configuration_scheme_associations_config_id_idx').on(table.configId),
}));

export const projectIssueCounters = pgTable('project_issue_counters', {
  projectId: integer('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  currentValue: integer('current_value').default(0),
});

export const notificationSchemes = pgTable('notification_schemes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  projectIdIdx: index('notification_schemes_project_id_idx').on(table.projectId),
}));

export const notificationSchemeEvents = pgTable('notification_scheme_events', {
  id: serial('id').primaryKey(),
  schemeId: integer('scheme_id').notNull().references(() => notificationSchemes.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  notifyAssignee: boolean('notify_assignee').default(false),
  notifyReporter: boolean('notify_reporter').default(false),
  notifyWatchers: boolean('notify_watchers').default(false),
  notifyProjectLead: boolean('notify_project_lead').default(false),
  notifyAllAdmins: boolean('notify_all_admins').default(false),
  notifyCurrentUser: boolean('notify_current_user').default(false),
}, (table) => ({
  schemeIdIdx: index('notification_scheme_events_scheme_id_idx').on(table.schemeId),
  eventTypeIdx: index('notification_scheme_events_event_type_idx').on(table.eventType),
}));

export const webhooks = pgTable('webhooks', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret'),
  events: jsonb('events').default('[]').notNull(),
  active: boolean('active').default(true),
  failureCount: integer('failure_count').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  projectIdIdx: index('webhooks_project_id_idx').on(table.projectId),
  activeIdx: index('webhooks_active_idx').on(table.active),
}));

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: serial('id').primaryKey(),
  webhookId: integer('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  event: varchar('event', { length: 100 }).notNull(),
  payload: jsonb('payload').notNull(),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  success: boolean('success').default(false),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  webhookIdIdx: index('webhook_deliveries_webhook_id_idx').on(table.webhookId),
  eventIdx: index('webhook_deliveries_event_idx').on(table.event),
  createdAtIdx: index('webhook_deliveries_created_at_idx').on(table.createdAt),
}));

export const emailQueue = pgTable('email_queue', {
  id: serial('id').primaryKey(),
  toAddress: varchar('to_address', { length: 255 }).notNull(),
  subject: varchar('subject', { length: 500 }).notNull(),
  htmlBody: text('html_body').notNull(),
  textBody: text('text_body').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  retryCount: integer('retry_count').default(0),
  errorMessage: text('error_message'),
  // Optional extra mail headers (Message-ID, In-Reply-To, References, Reply-To, Auto-Submitted) for threaded mail
  headers: jsonb('headers'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  statusIdx: index('email_queue_status_idx').on(table.status),
  createdAtIdx: index('email_queue_created_at_idx').on(table.createdAt),
}));

export const migrationSessions = pgTable('migration_sessions', {
  id: serial('id').primaryKey(),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  totalEntities: integer('total_entities').default(0),
  processedEntities: integer('processed_entities').default(0),
  errors: jsonb('errors').default('[]'),
  backupPath: text('backup_path').notNull(),
  options: jsonb('options').default('{}'),
  createdBy: integer('created_by').references(() => users.id),
}, (table) => ({
  statusIdx: index('migration_sessions_status_idx').on(table.status),
  createdByIdx: index('migration_sessions_created_by_idx').on(table.createdBy),
}));

/**
 * Maps records of other tools (Linear, Asana, ClickUp, generic JSON) to the Veqsio rows they were imported as,
 * so that re-running an import updates instead of duplicating. entity_type: project | issue | comment | sprint.
 */
export const migrationExternalRefs = pgTable('migration_external_refs', {
  id: serial('id').primaryKey(),
  source: varchar('source', { length: 30 }).notNull(),
  entityType: varchar('entity_type', { length: 30 }).notNull(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  externalKey: varchar('external_key', { length: 255 }),
  localId: integer('local_id').notNull(),
  sessionId: integer('session_id').references(() => migrationSessions.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniq: uniqueIndex('migration_external_refs_uniq').on(table.source, table.entityType, table.externalId),
  localIdx: index('migration_external_refs_local_idx').on(table.entityType, table.localId),
}));

export const ssoSettings = pgTable('sso_settings', {
  id: serial('id').primaryKey(),
  provider: varchar('provider', { length: 50 }).notNull().default('microsoft'),
  clientId: varchar('client_id', { length: 500 }).notNull(),
  clientSecret: varchar('client_secret', { length: 500 }).notNull(),
  tenantId: varchar('tenant_id', { length: 255 }).notNull(),
  redirectUri: varchar('redirect_uri', { length: 500 }).notNull(),
  enforceSso: boolean('enforce_sso').default(false),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const systemSettings = pgTable('system_settings', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 255 }).notNull().unique(),
  value: text('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const personalAccessTokens = pgTable('personal_access_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
  scopes: jsonb('scopes').default(['*']).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  userIdIdx: index('personal_access_tokens_user_id_idx').on(table.userId),
  tokenHashIdx: index('personal_access_tokens_token_hash_idx').on(table.tokenHash),
}));

export const userIdentities = pgTable('user_identities', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 50 }).notNull(),
  providerUserId: varchar('provider_user_id', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  rawProfile: jsonb('raw_profile').default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userIdIdx: index('user_identities_user_id_idx').on(table.userId),
  providerIdx: index('user_identities_provider_idx').on(table.provider),
  providerUserIdIdx: index('user_identities_provider_user_id_idx').on(table.providerUserId),
}));

export const automationRules = pgTable('automation_rules', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  projectId: integer('project_id').references(() => projects.id),
  isEnabled: boolean('is_enabled').default(true).notNull(),
  createdBy: integer('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  projectIdIdx: index('automation_rules_project_id_idx').on(table.projectId),
  createdByIdx: index('automation_rules_created_by_idx').on(table.createdBy),
}));

export const automationTriggers = pgTable('automation_triggers', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => automationRules.id, { onDelete: 'cascade' }),
  triggerType: varchar('trigger_type', { length: 50 }).notNull(),
  config: jsonb('config').default('{}'),
}, (table) => ({
  ruleIdIdx: index('automation_triggers_rule_id_idx').on(table.ruleId),
}));

export const automationConditions = pgTable('automation_conditions', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => automationRules.id, { onDelete: 'cascade' }),
  conditionType: varchar('condition_type', { length: 50 }).notNull(),
  operator: varchar('operator', { length: 10 }).default('AND').notNull(),
  config: jsonb('config').default('{}'),
  position: integer('position').default(0).notNull(),
}, (table) => ({
  ruleIdIdx: index('automation_conditions_rule_id_idx').on(table.ruleId),
}));

export const automationActions = pgTable('automation_actions', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => automationRules.id, { onDelete: 'cascade' }),
  actionType: varchar('action_type', { length: 50 }).notNull(),
  config: jsonb('config').default('{}'),
  position: integer('position').default(0).notNull(),
}, (table) => ({
  ruleIdIdx: index('automation_actions_rule_id_idx').on(table.ruleId),
}));

export const automationExecutions = pgTable('automation_executions', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => automationRules.id, { onDelete: 'cascade' }),
  triggeredBy: varchar('triggered_by', { length: 50 }).notNull(),
  triggerIssueKey: varchar('trigger_issue_key', { length: 50 }),
  status: varchar('status', { length: 20 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  result: jsonb('result').default('{}'),
  errorMessage: text('error_message'),
}, (table) => ({
  ruleIdIdx: index('automation_executions_rule_id_idx').on(table.ruleId),
  statusIdx: index('automation_executions_status_idx').on(table.status),
  startedAtIdx: index('automation_executions_started_at_idx').on(table.startedAt),
}));

export const applicationLinks = pgTable('application_links', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).notNull(), // github, gitlab, bitbucket, confluence, bamboo, jenkins, custom
  baseUrl: varchar('base_url', { length: 500 }).notNull(),
  displayUrl: varchar('display_url', { length: 500 }),
  authType: varchar('auth_type', { length: 20 }).notNull().default('none'), // none, basic, bearer, oauth
  credentials: jsonb('credentials').default('{}'), // encrypted or plain for demo
  config: jsonb('config').default('{}'), // owner, repo, projectKey, etc.
  isPrimary: boolean('is_primary').default(false).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  typeIdx: index('application_links_type_idx').on(table.type),
  activeIdx: index('application_links_active_idx').on(table.active),
}));

export const devCommits = pgTable('dev_commits', {
  id: serial('id').primaryKey(),
  applicationLinkId: integer('application_link_id').notNull().references(() => applicationLinks.id, { onDelete: 'cascade' }),
  issueKey: varchar('issue_key', { length: 50 }).notNull(),
  commitId: varchar('commit_id', { length: 255 }).notNull(),
  message: text('message').notNull(),
  authorName: varchar('author_name', { length: 255 }),
  authorEmail: varchar('author_email', { length: 255 }),
  url: varchar('url', { length: 500 }),
  branch: varchar('branch', { length: 255 }),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  issueKeyIdx: index('dev_commits_issue_key_idx').on(table.issueKey),
  appLinkIdx: index('dev_commits_application_link_id_idx').on(table.applicationLinkId),
  commitIdIdx: index('dev_commits_commit_id_idx').on(table.commitId),
}));

export const devBranches = pgTable('dev_branches', {
  id: serial('id').primaryKey(),
  applicationLinkId: integer('application_link_id').notNull().references(() => applicationLinks.id, { onDelete: 'cascade' }),
  issueKey: varchar('issue_key', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  isDefault: boolean('is_default').default(false),
  aheadBy: integer('ahead_by').default(0),
  behindBy: integer('behind_by').default(0),
  lastCommitAt: timestamp('last_commit_at', { withTimezone: true }),
  url: varchar('url', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  issueKeyIdx: index('dev_branches_issue_key_idx').on(table.issueKey),
  appLinkIdx: index('dev_branches_application_link_id_idx').on(table.applicationLinkId),
}));

export const devPullRequests = pgTable('dev_pull_requests', {
  id: serial('id').primaryKey(),
  applicationLinkId: integer('application_link_id').notNull().references(() => applicationLinks.id, { onDelete: 'cascade' }),
  issueKey: varchar('issue_key', { length: 50 }).notNull(),
  prId: varchar('pr_id', { length: 255 }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  authorName: varchar('author_name', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull(), // open, merged, closed
  sourceBranch: varchar('source_branch', { length: 255 }),
  targetBranch: varchar('target_branch', { length: 255 }),
  url: varchar('url', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  issueKeyIdx: index('dev_pull_requests_issue_key_idx').on(table.issueKey),
  appLinkIdx: index('dev_pull_requests_application_link_id_idx').on(table.applicationLinkId),
  prIdIdx: index('dev_pull_requests_pr_id_idx').on(table.prId),
}));

export const worklogs = pgTable('worklogs', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  issueKey: varchar('issue_key', { length: 50 }).notNull(),
  authorId: integer('author_id').references(() => users.id),
  authorName: varchar('author_name', { length: 255 }),
  authorEmail: varchar('author_email', { length: 255 }),
  description: text('description'),
  timeSpentSeconds: integer('time_spent_seconds').notNull(),
  started: timestamp('started', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  issueIdIdx: index('worklogs_issue_id_idx').on(table.issueId),
  issueKeyIdx: index('worklogs_issue_key_idx').on(table.issueKey),
  authorIdIdx: index('worklogs_author_id_idx').on(table.authorId),
  startedIdx: index('worklogs_started_idx').on(table.started),
}));

// ============================================================
// Service Desk (Veqsio Service Management)
// ============================================================

export const serviceDesks = pgTable('service_desks', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  description: text('description'),
  welcomeMessage: text('welcome_message'),
  enabled: boolean('enabled').default(true).notNull(),
  publicSignup: boolean('public_signup').default(false).notNull(),
  businessHours: jsonb('business_hours'), // { timezone, days: { mon: ['09:00','18:00'], ... } }
  // Customer e-mail: public agent replies are always mailed (when SMTP is configured); these two are per-desk switches
  notifyCustomerComments: boolean('notify_customer_comments').default(true).notNull(),
  notifyCustomerStatus: boolean('notify_customer_status').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const serviceDeskAgents = pgTable('service_desk_agents', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 20 }).default('agent').notNull(), // agent | admin
}, (t) => ({
  uniq: uniqueIndex('sd_agents_uniq').on(t.serviceDeskId, t.userId),
}));

export const serviceDeskCustomers = pgTable('service_desk_customers', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  organizationId: integer('organization_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('sd_customers_uniq').on(t.serviceDeskId, t.userId),
}));

export const customerOrganizations = pgTable('customer_organizations', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const requestTypes = pgTable('request_types', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  helpText: text('help_text'),
  icon: varchar('icon', { length: 50 }).default('help-circle'),
  groupName: varchar('group_name', { length: 100 }),
  issueTypeId: integer('issue_type_id').notNull().references(() => issueTypes.id),
  defaultPriorityId: integer('default_priority_id').references(() => priorities.id),
  // [{ key, label, type: text|textarea|select|checkbox|date|number, required, options?: string[] }]
  fields: jsonb('fields').default([]).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
}, (t) => ({
  deskIdx: index('request_types_desk_idx').on(t.serviceDeskId),
}));

export const serviceRequests = pgTable('service_requests', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().unique().references(() => issues.id, { onDelete: 'cascade' }),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  requestTypeId: integer('request_type_id').references(() => requestTypes.id, { onDelete: 'set null' }),
  customerId: integer('customer_id').notNull().references(() => users.id),
  channel: varchar('channel', { length: 20 }).default('portal').notNull(), // portal | email | api | agent
  fieldValues: jsonb('field_values').default({}).notNull(),
  csatRating: integer('csat_rating'),
  csatComment: text('csat_comment'),
  csatAt: timestamp('csat_at', { withTimezone: true }),
  // Follow-up of a poor rating: set when an agent has dealt with it.
  csatHandledAt: timestamp('csat_handled_at', { withTimezone: true }),
  csatHandledBy: integer('csat_handled_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  deskIdx: index('service_requests_desk_idx').on(t.serviceDeskId),
  customerIdx: index('service_requests_customer_idx').on(t.customerId),
}));

export const requestParticipants = pgTable('request_participants', {
  id: serial('id').primaryKey(),
  requestId: integer('request_id').notNull().references(() => serviceRequests.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => ({
  uniq: uniqueIndex('request_participants_uniq').on(t.requestId, t.userId),
}));

export const serviceQueues = pgTable('service_queues', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  jql: text('jql'), // optional extra JQL narrowing the desk's requests
  sortOrder: integer('sort_order').default(0).notNull(),
});

export const slaDefinitions = pgTable('sla_definitions', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(), // e.g. "Time to first response", "Time to resolution"
  metric: varchar('metric', { length: 30 }).notNull(), // first_response | resolution
  // calendar: 24x7 or business hours of the desk
  calendar: varchar('calendar', { length: 20 }).default('24x7').notNull(),
  // statuses (ids) that pause the clock, e.g. "Waiting for customer"
  pauseStatusIds: jsonb('pause_status_ids').default([]).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  // Jira-style metric model: lists of conditions ({ event, statusIds?, restart? }); empty = legacy behaviour
  startConditions: jsonb('start_conditions').default([]).notNull(),
  pauseConditions: jsonb('pause_conditions').default([]).notNull(),
  stopConditions: jsonb('stop_conditions').default([]).notNull(),
  calendarId: integer('calendar_id'), // default calendar (sla_calendars.id); null = legacy `calendar` column
  warningPercent: integer('warning_percent'), // near-breach threshold in % of the goal; null = off
});

export const slaGoals = pgTable('sla_goals', {
  id: serial('id').primaryKey(),
  slaId: integer('sla_id').notNull().references(() => slaDefinitions.id, { onDelete: 'cascade' }),
  priorityId: integer('priority_id').references(() => priorities.id), // null = default goal
  targetMinutes: integer('target_minutes').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(), // first matching goal wins
  // { priorityIds?: number[], issueTypeIds?: number[], requestTypeIds?: number[] }; empty = matches everything
  criteria: jsonb('criteria').default({}).notNull(),
  jql: text('jql'), // optional JQL filter (subset the JQL engine can evaluate)
  calendarId: integer('calendar_id'), // null = the SLA's calendar
});

export const requestSlaStates = pgTable('request_sla_states', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  slaId: integer('sla_id').notNull().references(() => slaDefinitions.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  elapsedMs: bigint('elapsed_ms', { mode: 'number' }).default(0).notNull(),
  targetMinutes: integer('target_minutes').notNull(),
  breached: boolean('breached').default(false).notNull(),
  // set once when the warning threshold was notified (so the warning goes out once per request and SLA)
  warnedAt: timestamp('warned_at', { withTimezone: true }),
}, (t) => ({
  uniq: uniqueIndex('request_sla_states_uniq').on(t.issueId, t.slaId),
}));

export const kbArticles = pgTable('kb_articles', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 500 }).notNull(),
  body: text('body').notNull(),
  labels: jsonb('labels').default([]).notNull(),
  published: boolean('published').default(false).notNull(),
  views: integer('views').default(0).notNull(),
  helpful: integer('helpful').default(0).notNull(),
  notHelpful: integer('not_helpful').default(0).notNull(),
  authorId: integer('author_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  deskIdx: index('kb_articles_desk_idx').on(t.serviceDeskId),
}));

export const sdCannedResponses = pgTable('sd_canned_responses', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  deskIdx: index('sd_canned_responses_desk_idx').on(t.serviceDeskId),
}));

// ============================================================
// Service Desk email channel (inbound email -> requests / public comments)
// ============================================================

export const sdEmailChannels = pgTable('sd_email_channels', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().unique().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(false).notNull(),
  secretHash: varchar('secret_hash', { length: 64 }).notNull(), // sha256 hex of the shared secret
  defaultRequestTypeId: integer('default_request_type_id').references(() => requestTypes.id, { onDelete: 'set null' }),
  allowedSenderDomains: jsonb('allowed_sender_domains').default([]).notNull(), // [] = any domain
  // Reply-To address on outbound mail (defaults to the IMAP user when that is an address)
  replyAddress: varchar('reply_address', { length: 320 }),
  // IMAP polling (disabled by default)
  imapEnabled: boolean('imap_enabled').default(false).notNull(),
  imapHost: varchar('imap_host', { length: 255 }),
  imapPort: integer('imap_port').default(993).notNull(),
  imapTls: boolean('imap_tls').default(true).notNull(),
  imapUser: varchar('imap_user', { length: 320 }),
  imapPasswordEncrypted: text('imap_password_encrypted'), // AES-256-GCM envelope, see api/src/auth/secrets.ts
  imapFolder: varchar('imap_folder', { length: 255 }).default('INBOX').notNull(),
  imapPollSeconds: integer('imap_poll_seconds').default(300).notNull(), // >= 60
  imapLastPollAt: timestamp('imap_last_poll_at', { withTimezone: true }),
  imapLastStatus: varchar('imap_last_status', { length: 20 }), // ok | error
  imapLastError: text('imap_last_error'),
  imapLastCount: integer('imap_last_count'), // messages processed by the last poll
  imapLockUntil: timestamp('imap_lock_until', { withTimezone: true }), // lease so only one API instance polls
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Message-IDs of mails we sent for a request, to thread replies that only carry In-Reply-To / References
export const sdOutboundMessages = pgTable('sd_outbound_messages', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  messageId: varchar('message_id', { length: 500 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('sd_outbound_messages_uniq').on(t.messageId),
  issueIdx: index('sd_outbound_messages_issue_idx').on(t.issueId),
}));

export const sdInboundMessages = pgTable('sd_inbound_messages', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  messageId: varchar('message_id', { length: 500 }).notNull(),
  fromAddress: varchar('from_address', { length: 320 }).notNull(),
  subject: varchar('subject', { length: 500 }),
  issueId: integer('issue_id').references(() => issues.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 20 }).notNull(), // created | commented | rejected
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('sd_inbound_messages_uniq').on(t.serviceDeskId, t.messageId),
}));

// =====================================================// Enterprise identity: generic OIDC providers and SCIM tokens
// ============================================================

export const oidcProviders = pgTable('oidc_providers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  issuer: varchar('issuer', { length: 500 }).notNull(),
  clientId: varchar('client_id', { length: 500 }).notNull(),
  clientSecretEncrypted: text('client_secret_encrypted').notNull(), // AES-256-GCM envelope, see api/src/auth/secrets.ts
  scopes: varchar('scopes', { length: 500 }).default('openid profile email').notNull(),
  emailClaim: varchar('email_claim', { length: 100 }).default('email').notNull(),
  nameClaim: varchar('name_claim', { length: 100 }).default('name').notNull(),
  groupsClaim: varchar('groups_claim', { length: 100 }), // null = no group sync
  allowedDomains: jsonb('allowed_domains').default([]).notNull(), // [] = any domain
  autoProvision: boolean('auto_provision').default(false).notNull(),
  linkByEmail: boolean('link_by_email').default(false).notNull(), // link to an existing user by verified email
  enforceSso: boolean('enforce_sso').default(false).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// SAML 2.0 identity providers (SP-initiated, HTTP-Redirect AuthnRequest, HTTP-POST ACS). Feature: sso_saml.
export const samlProviders = pgTable('saml_providers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  idpEntityId: varchar('idp_entity_id', { length: 500 }).notNull(),
  idpSsoUrl: varchar('idp_sso_url', { length: 1000 }).notNull(),
  idpCertificates: text('idp_certificates').notNull(), // one or more PEM certificates (rollover)
  signRequests: boolean('sign_requests').default(false).notNull(),
  spSigningKeyEncrypted: text('sp_signing_key_encrypted'), // AES-256-GCM envelope (auth/secrets.ts)
  spSigningCertificate: text('sp_signing_certificate'), // public PEM, published in the SP metadata
  nameIdFormat: varchar('name_id_format', { length: 200 }).default('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress').notNull(),
  emailAttribute: varchar('email_attribute', { length: 300 }), // null = well-known aliases (email, mail, ...)
  displayNameAttribute: varchar('display_name_attribute', { length: 300 }),
  usernameAttribute: varchar('username_attribute', { length: 300 }),
  groupsAttribute: varchar('groups_attribute', { length: 300 }),
  syncGroups: boolean('sync_groups').default(false).notNull(),
  defaultGroups: jsonb('default_groups').default([]).notNull(), // group names every JIT-provisioned user joins
  allowedDomains: jsonb('allowed_domains').default([]).notNull(), // [] = any domain
  autoProvision: boolean('auto_provision').default(false).notNull(), // JIT provisioning
  linkByEmail: boolean('link_by_email').default(false).notNull(),
  enforceSso: boolean('enforce_sso').default(false).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// LDAP / Active Directory connections: login fallback, JIT provisioning and scheduled user/group sync. Feature: ldap.
export const ldapDirectories = pgTable('ldap_directories', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  url: varchar('url', { length: 500 }).notNull(), // ldap:// or ldaps://
  startTls: boolean('start_tls').default(false).notNull(),
  tlsRejectUnauthorized: boolean('tls_reject_unauthorized').default(true).notNull(),
  bindDn: varchar('bind_dn', { length: 1000 }).notNull(),
  bindPasswordEncrypted: text('bind_password_encrypted').notNull(),
  baseDn: varchar('base_dn', { length: 1000 }).notNull(),
  userFilter: varchar('user_filter', { length: 1000 }).default('(objectClass=person)').notNull(),
  usernameAttribute: varchar('username_attribute', { length: 100 }).default('uid').notNull(),
  emailAttribute: varchar('email_attribute', { length: 100 }).default('mail').notNull(),
  displayNameAttribute: varchar('display_name_attribute', { length: 100 }).default('cn').notNull(),
  uniqueIdAttribute: varchar('unique_id_attribute', { length: 100 }).default('entryUUID').notNull(),
  groupBaseDn: varchar('group_base_dn', { length: 1000 }),
  groupFilter: varchar('group_filter', { length: 1000 }).default('(objectClass=groupOfNames)').notNull(),
  groupNameAttribute: varchar('group_name_attribute', { length: 100 }).default('cn').notNull(),
  groupMemberAttribute: varchar('group_member_attribute', { length: 100 }).default('member').notNull(),
  nestedGroups: boolean('nested_groups').default(false).notNull(),
  loginEnabled: boolean('login_enabled').default(true).notNull(), // password login checks the directory
  autoProvision: boolean('auto_provision').default(false).notNull(), // JIT on first login and creation during sync
  linkByEmail: boolean('link_by_email').default(false).notNull(),
  syncEnabled: boolean('sync_enabled').default(false).notNull(),
  syncIntervalMinutes: integer('sync_interval_minutes').default(360).notNull(),
  deactivateMissing: boolean('deactivate_missing').default(true).notNull(),
  maxEntries: integer('max_entries').default(10000).notNull(), // search size limit; a truncated result aborts the sync
  timeoutMs: integer('timeout_ms').default(10000).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncResult: jsonb('last_sync_result'),
  syncLockUntil: timestamp('sync_lock_until', { withTimezone: true }), // lease so two API instances never sync at once
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const scimTokens = pgTable('scim_tokens', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), // sha256 hex; the token itself is shown once
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
// Filter subscriptions: scheduled email digest of a saved filter's results (hour is UTC).
export const filterSubscriptions = pgTable('filter_subscriptions', {
  id: serial('id').primaryKey(),
  filterId: integer('filter_id').notNull().references(() => filters.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  schedule: varchar('schedule', { length: 10 }).notNull(), // daily | weekly
  hour: smallint('hour').notNull().default(8), // 0-23, UTC
  weekday: smallint('weekday'), // 0 (Sunday) - 6, weekly only
  emptyPolicy: varchar('empty_policy', { length: 10 }).notNull().default('skip'), // skip | send
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('filter_subscriptions_filter_user_uniq').on(t.filterId, t.userId),
  userIdx: index('filter_subscriptions_user_id_idx').on(t.userId),
}));

// Optional AI assist (off by default). Single row (id = 1). The API key is AES-256-GCM encrypted at rest.
export const aiSettings = pgTable('ai_settings', {
  id: integer('id').primaryKey().default(1),
  enabled: boolean('enabled').default(false).notNull(),
  provider: varchar('provider', { length: 20 }).default('openai').notNull(), // openai (any OpenAI-compatible endpoint) | anthropic
  baseUrl: text('base_url'),
  model: varchar('model', { length: 200 }),
  apiKeyEncrypted: text('api_key_encrypted'),
  maxInputChars: integer('max_input_chars').default(12000).notNull(),
  dailyRequestLimitPerUser: integer('daily_request_limit_per_user').default(50).notNull(),
  features: jsonb('features').default({ classify: true, summarize: true, similar: true, release_notes: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// AI usage counters: who used which feature when. Never stores prompts or responses.
export const aiUsage = pgTable('ai_usage', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  feature: varchar('feature', { length: 30 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
}, (t) => ({
  userCreatedIdx: index('ai_usage_user_created_idx').on(t.userId, t.createdAt),
}));

// Plugins: external HTTP services described by a manifest. Never executed in-process.
export const plugins = pgTable('plugins', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 128 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 64 }).notNull(),
  manifest: jsonb('manifest').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  installedBy: integer('installed_by').references(() => users.id, { onDelete: 'set null' }),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  tokenHash: varchar('token_hash', { length: 128 }),
  grantedScopes: jsonb('granted_scopes').notNull().default([]),
  serviceUserId: integer('service_user_id').references(() => users.id, { onDelete: 'set null' }),
  signingSecretEnc: text('signing_secret_enc'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  disabledReason: text('disabled_reason'),
});

export const pluginSettings = pgTable('plugin_settings', {
  id: serial('id').primaryKey(),
  pluginId: integer('plugin_id').notNull().references(() => plugins.id, { onDelete: 'cascade' }),
  key: varchar('key', { length: 128 }).notNull(),
  value: text('value').notNull(),
  isSecret: boolean('is_secret').notNull().default(false),
}, (t) => ({
  uniq: uniqueIndex('plugin_settings_plugin_key_uniq').on(t.pluginId, t.key),
}));

export const pluginDeliveries = pgTable('plugin_deliveries', {
  id: serial('id').primaryKey(),
  pluginId: integer('plugin_id').notNull().references(() => plugins.id, { onDelete: 'cascade' }),
  deliveryId: varchar('delivery_id', { length: 64 }).notNull(),
  event: varchar('event', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(), // success | failed
  responseStatus: integer('response_status'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(1),
  latencyMs: integer('latency_ms').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pluginIdx: index('plugin_deliveries_plugin_created_idx').on(t.pluginId, t.createdAt),
}));
// AI agents as first-class users. An agent is a normal users row (username `agent:<slug>`, no password, never signs in)
// plus this row for its owner, webhook endpoint and limits. Permissions come from project roles/groups like any user.
export const agents = pgTable('agents', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  webhookUrl: text('webhook_url'),
  signingSecretEnc: text('signing_secret_enc'),
  // Which events start a run: assigned | mentioned | status_changed | commented
  triggers: jsonb('triggers').$type<string[]>().notNull().default(['assigned', 'mentioned']),
  maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(3),
  maxRunsPerIssue: integer('max_runs_per_issue').notNull().default(1),
  maxRunsPerHour: integer('max_runs_per_hour').notNull().default(30),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  ownerIdx: index('agents_owner_id_idx').on(t.ownerId),
}));

// One row per activation of an agent on an issue (run log). tokenHash is the short-lived scoped run token (nulled when the run ends or is stopped).
export const agentRuns = pgTable('agent_runs', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  trigger: varchar('trigger', { length: 24 }).notNull(), // assigned | mentioned | status_changed | commented | claim
  status: varchar('status', { length: 16 }).notNull().default('queued'), // queued | delivered | running | succeeded | failed | cancelled
  triggeredBy: integer('triggered_by').references(() => users.id, { onDelete: 'set null' }),
  chainDepth: integer('chain_depth').notNull().default(0),
  deliveryId: varchar('delivery_id', { length: 64 }),
  tokenHash: varchar('token_hash', { length: 128 }),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  summary: text('summary'),
  resultUrl: text('result_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  agentCreatedIdx: index('agent_runs_agent_created_idx').on(t.agentId, t.createdAt),
  issueIdx: index('agent_runs_issue_idx').on(t.issueId, t.createdAt),
  tokenIdx: index('agent_runs_token_hash_idx').on(t.tokenHash),
}));

/** Append-only record of administrative actions. actor_id is deliberately not an FK so entries survive user deletion. */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  actorId: integer('actor_id'),
  actorName: varchar('actor_name', { length: 255 }),
  action: varchar('action', { length: 100 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  target: varchar('target', { length: 255 }),
  method: varchar('method', { length: 10 }),
  path: varchar('path', { length: 500 }),
  status: integer('status'),
  ip: varchar('ip', { length: 64 }),
  details: jsonb('details'),
}, (t) => ({
  createdIdx: index('audit_log_created_at_idx').on(t.createdAt),
  actionIdx: index('audit_log_action_idx').on(t.action),
  actorIdx: index('audit_log_actor_idx').on(t.actorName),
}));

// Password reset tokens: only the SHA-256 hash of the token is stored; tokens expire and are single-use.
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('password_reset_tokens_user_id_idx').on(table.userId),
  expiresAtIdx: index('password_reset_tokens_expires_at_idx').on(table.expiresAt),
}));

// ============================================================
// Service desk SLA calendars (Jira Service Management style)
// ============================================================

export const slaCalendars = pgTable('sla_calendars', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  kind: varchar('kind', { length: 20 }).default('custom').notNull(), // custom | 24x7 (built-in, read-only hours)
  timeZone: varchar('time_zone', { length: 64 }).default('UTC').notNull(), // IANA name
  // { mon: [["09:00","17:00"], ...], ... }; a missing/empty day is a non-working day
  workingHours: jsonb('working_hours').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nameUniq: uniqueIndex('sla_calendars_desk_name_uniq').on(t.serviceDeskId, t.name),
}));

export const slaCalendarHolidays = pgTable('sla_calendar_holidays', {
  id: serial('id').primaryKey(),
  calendarId: integer('calendar_id').notNull().references(() => slaCalendars.id, { onDelete: 'cascade' }),
  date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD
  name: varchar('name', { length: 255 }).notNull(),
  recurring: boolean('recurring').default(false).notNull(), // repeats every year on the same month/day
}, (t) => ({
  calIdx: index('sla_calendar_holidays_cal_idx').on(t.calendarId),
}));

// ============================================================
// Service Desk configuration (request type form builder, portal settings)
// Additive tables; no migration files (tests and dev use `drizzle-kit push`).
// ============================================================

/** Extra request type settings kept apart from request_types so that table is untouched. */
export const requestTypeSettings = pgTable('request_type_settings', {
  requestTypeId: integer('request_type_id').primaryKey().references(() => requestTypes.id, { onDelete: 'cascade' }),
  visibility: varchar('visibility', { length: 20 }).default('all').notNull(), // all | organizations
  organizationIds: jsonb('organization_ids').default([]).notNull(), // customer_organizations ids when visibility = organizations
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Per-desk portal presentation: title, introduction, ordered request type groups, logo and accent colour. */
export const serviceDeskPortalSettings = pgTable('service_desk_portal_settings', {
  serviceDeskId: integer('service_desk_id').primaryKey().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  portalTitle: varchar('portal_title', { length: 255 }),
  introduction: text('introduction'),
  groups: jsonb('groups').default([]).notNull(), // ordered [{ name }]; request types reference a group by name
  logoUrl: text('logo_url'),
  accentColor: varchar('accent_color', { length: 20 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================
// Modules (plugin framework). See docs/modules.md.
// ============================================================

/** Bundled modules that an administrator installed. Absence of a row means "available, not installed". */
export const installedModules = pgTable('installed_modules', {
  id: varchar('id', { length: 40 }).primaryKey(), // module id slug from the manifest
  version: varchar('version', { length: 50 }).notNull(), // version whose migrations have been applied
  enabled: boolean('enabled').default(false).notNull(),
  settings: jsonb('settings').default({}).notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  installedBy: integer('installed_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  lastError: text('last_error'),
});

/**
 * Ledger of module-owned SQL migrations. Deliberately no foreign key to installed_modules:
 * uninstalling a module without deleting its data keeps its tables, so the ledger must survive too.
 */
export const moduleMigrations = pgTable('module_migrations', {
  moduleId: varchar('module_id', { length: 40 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(), // sha256 of the SQL text
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.moduleId, t.name] }),
}));

// ============================================================
// Approvals (multi-approver decisions on issues / service requests). See docs/approvals.md.
// ============================================================

/** Reusable approval definition per project (or service desk project). */
export const approvalTemplates = pgTable('approval_templates', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  approverUserIds: jsonb('approver_user_ids').default([]).notNull(), // number[]
  approverGroupIds: jsonb('approver_group_ids').default([]).notNull(), // number[]; expanded to users when an approval is created
  rule: varchar('rule', { length: 20 }).default('all').notNull(), // all | any | n_of_m | percentage
  ruleThreshold: integer('rule_threshold'), // n for n_of_m, percent (1..100) for percentage
  autoApproveWhen: jsonb('auto_approve_when'), // { field: 'priority'|'issuetype', op: 'eq'|'neq'|'in', value } or null
  autoDeclineWhen: jsonb('auto_decline_when'),
  reminderIntervalHours: integer('reminder_interval_hours'),
  expiryHours: integer('expiry_hours'),
  onApprovedTransitionId: integer('on_approved_transition_id'), // workflow_transitions.id, validated at use time
  onDeclinedTransitionId: integer('on_declined_transition_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectNameUniq: uniqueIndex('approval_templates_project_name_uniq').on(t.projectId, t.name),
}));

/** One approval round on an issue. Approvers are snapshotted in approval_approvers when it is created. */
export const approvals = pgTable('approvals', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  templateId: integer('template_id').references(() => approvalTemplates.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 120 }).notNull(),
  status: varchar('status', { length: 20 }).default('pending').notNull(), // pending | approved | declined | cancelled | expired
  rule: varchar('rule', { length: 20 }).default('all').notNull(),
  ruleThreshold: integer('rule_threshold'),
  completedBy: varchar('completed_by', { length: 20 }), // decisions | auto_rule | expiry | cancel
  onApprovedTransitionId: integer('on_approved_transition_id'),
  onDeclinedTransitionId: integer('on_declined_transition_id'),
  reminderIntervalHours: integer('reminder_interval_hours'),
  nextReminderAt: timestamp('next_reminder_at', { withTimezone: true }),
  remindersSent: integer('reminders_sent').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (t) => ({
  issueIdx: index('approvals_issue_idx').on(t.issueId),
  statusIdx: index('approvals_status_idx').on(t.status),
}));

/** Frozen approver set of an approval (groups are expanded at creation time). */
export const approvalApprovers = pgTable('approval_approvers', {
  approvalId: integer('approval_id').notNull().references(() => approvals.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.approvalId, t.userId] }),
  userIdx: index('approval_approvers_user_idx').on(t.userId),
}));

/** Append-only decision log. A decision can never be changed or removed (only deleted with its approval). */
export const approvalDecisions = pgTable('approval_decisions', {
  id: serial('id').primaryKey(),
  approvalId: integer('approval_id').notNull().references(() => approvals.id, { onDelete: 'cascade' }),
  approverId: integer('approver_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  decision: varchar('decision', { length: 20 }).notNull(), // approved | declined
  comment: text('comment'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('approval_decisions_uniq').on(t.approvalId, t.approverId),
}));

/** A git repository linked to a project (GitHub, GitLab, Gitea or Bitbucket); events arrive through a signed webhook. */
export const scmRepositories = pgTable('scm_repositories', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 20 }).notNull(),
  // Self-hosted base URL (GitLab, Gitea, GitHub Enterprise); '' = the public service (not null so the unique index works).
  baseUrl: text('base_url').notNull().default(''),
  name: varchar('name', { length: 255 }).notNull(),
  defaultBranch: varchar('default_branch', { length: 255 }).default('main').notNull(),
  // Both encrypted with the instance secret key (auth/secrets.ts).
  webhookSecretEnc: text('webhook_secret_enc').notNull(),
  accessTokenEnc: text('access_token_enc'),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  projectIdx: index('scm_repositories_project_idx').on(table.projectId),
  uniq: uniqueIndex('scm_repositories_provider_name_idx').on(table.provider, table.baseUrl, table.name),
}));

/** Branches, commits and pull/merge requests found in webhook events that mention an issue key. */
export const scmLinks = pgTable('scm_links', {
  id: serial('id').primaryKey(),
  repositoryId: integer('repository_id').notNull().references(() => scmRepositories.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 20 }).notNull(), // branch | commit | pull_request
  ref: varchar('ref', { length: 255 }).notNull(), // branch name, commit sha or PR number
  branch: varchar('branch', { length: 255 }),
  title: text('title'),
  url: text('url'),
  status: varchar('status', { length: 20 }), // PR: open | merged | closed
  buildStatus: varchar('build_status', { length: 20 }), // pending | success | failed
  author: varchar('author', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniq: uniqueIndex('scm_links_unique_idx').on(table.repositoryId, table.issueId, table.kind, table.ref),
  issueIdx: index('scm_links_issue_idx').on(table.issueId),
}));

/* ------------------------------------------------------------------ */
/*  Intake / triage                                                    */
/* ------------------------------------------------------------------ */

/** Per-project intake configuration (one row per project that ever touched intake). */
export const intakeSettings = pgTable('intake_settings', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(false).notNull(),
  // Public form at /intake/<slug>; the slug is unguessable and can be rotated. It also addresses the email webhook.
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  publicFormEnabled: boolean('public_form_enabled').default(false).notNull(),
  formTitle: varchar('form_title', { length: 120 }).default('').notNull(),
  formIntro: text('form_intro').default('').notNull(),
  // { name, email, description }: each 'off' | 'optional' | 'required'. The title is always required.
  fields: jsonb('fields').default({ name: 'optional', email: 'optional', description: 'optional' }).notNull(),
  emailEnabled: boolean('email_enabled').default(false).notNull(),
  // Email the project lead when a new submission arrives (at most one email per project per 10 minutes).
  notifyLead: boolean('notify_lead').default(true).notNull(),
  emailSecretHash: varchar('email_secret_hash', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** A submission waiting for triage. It is NOT an issue until it is accepted. */
export const intakeItems = pgTable('intake_items', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').default('').notNull(),
  requesterName: varchar('requester_name', { length: 255 }),
  requesterEmail: varchar('requester_email', { length: 255 }),
  requesterUserId: integer('requester_user_id').references(() => users.id, { onDelete: 'set null' }),
  source: varchar('source', { length: 10 }).notNull(), // form | email | api | app
  status: varchar('status', { length: 12 }).default('pending').notNull(), // pending | accepted | declined | snoozed | duplicate
  decidedBy: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
  acceptedIssueId: integer('accepted_issue_id').references(() => issues.id, { onDelete: 'set null' }),
  duplicateOfIssueId: integer('duplicate_of_issue_id').references(() => issues.id, { onDelete: 'set null' }),
  // External message id (inbound email): makes redelivery idempotent.
  sourceRef: varchar('source_ref', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectStatusIdx: index('intake_items_project_status_idx').on(t.projectId, t.status, t.createdAt),
  snoozeIdx: index('intake_items_snoozed_until_idx').on(t.snoozedUntil),
  sourceRefIdx: uniqueIndex('intake_items_source_ref_idx').on(t.projectId, t.sourceRef),
}));

/* ------------------------------------------------------------------ */
/*  Wiki / Pages (feature switch `pages`)                               */
/* ------------------------------------------------------------------ */

/** A wiki page: Markdown body, nested under a parent, either in one project (projectId) or in the workspace (null). */
export const pages = pgTable('pages', {
  id: serial('id').primaryKey(),
  // null = workspace (global) page, readable by every signed-in user
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  parentId: integer('parent_id').references((): any => pages.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull().default(''),
  authorId: integer('author_id').references(() => users.id),
  updatedBy: integer('updated_by').references(() => users.id),
  // Locked pages can only be edited by the author and administrators.
  locked: boolean('locked').notNull().default(false),
  // Order among the siblings (same scope and parent).
  position: integer('position').notNull().default(0),
  // Current version number; every saved change adds a row to page_versions.
  version: integer('version').notNull().default(1),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  treeIdx: index('pages_tree_idx').on(t.projectId, t.parentId, t.position),
  authorIdx: index('pages_author_idx').on(t.authorId),
  ftsIdx: index('pages_fts_idx').using('gin', sql`to_tsvector('simple', ${t.title} || ' ' || ${t.body})`),
}));

/** Every saved state of a page (version 1 is the creation). */
export const pageVersions = pgTable('page_versions', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').references(() => users.id),
  // Lines added/removed compared with the previous version (summary shown in the history list).
  addedLines: integer('added_lines').notNull().default(0),
  removedLines: integer('removed_lines').notNull().default(0),
  // Set when this version was created by restoring an older one.
  restoredFrom: integer('restored_from'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pageVersionUniq: uniqueIndex('page_versions_page_version_uniq').on(t.pageId, t.version),
}));

/** Comments on a page; replies point to a top-level comment, `quote` is the text the comment refers to. */
export const pageComments = pgTable('page_comments', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  parentId: integer('parent_id').references((): any => pageComments.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').references(() => users.id),
  body: text('body').notNull(),
  quote: text('quote'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pageIdx: index('page_comments_page_idx').on(t.pageId),
}));

/** Issues created from highlighted page text ("convert to issue"). */
export const pageIssueLinks = pgTable('page_issue_links', {
  id: serial('id').primaryKey(),
  pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  quote: text('quote'),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('page_issue_links_page_issue_uniq').on(t.pageId, t.issueId),
  issueIdx: index('page_issue_links_issue_idx').on(t.issueId),
}));

/** Issue security schemes (Jira style): levels with members; a project uses one scheme. */
export const issueSecuritySchemes = pgTable('issue_security_schemes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  // Level applied to new issues of the associated projects (no foreign key: levels belong to the scheme).
  defaultLevelId: integer('default_level_id'),
});

export const issueSecurityLevels = pgTable('issue_security_levels', {
  id: serial('id').primaryKey(),
  schemeId: integer('scheme_id').notNull().references(() => issueSecuritySchemes.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').default(0).notNull(),
}, (t) => ({
  schemeIdx: index('issue_security_levels_scheme_idx').on(t.schemeId),
}));

/** memberType: user | group | role | reporter | assignee | project_lead | any_user */
export const issueSecurityLevelMembers = pgTable('issue_security_level_members', {
  id: serial('id').primaryKey(),
  levelId: integer('level_id').notNull().references(() => issueSecurityLevels.id, { onDelete: 'cascade' }),
  memberType: varchar('member_type', { length: 20 }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
  projectRoleId: integer('project_role_id').references(() => projectRoles.id, { onDelete: 'cascade' }),
}, (t) => ({
  levelIdx: index('issue_security_level_members_level_idx').on(t.levelId),
}));

export const issueSecuritySchemeAssociations = pgTable('issue_security_scheme_associations', {
  projectId: integer('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  schemeId: integer('scheme_id').notNull().references(() => issueSecuritySchemes.id, { onDelete: 'cascade' }),
});


/** Status updates on a project ("On track" / "At risk" / "Off track" with free text); the newest one is the current state. */
export const projectStatusUpdates = pgTable('project_status_updates', {
  id: serial('id').primaryKey(),
  // Null only for updates posted on an initiative (then initiativeId is set).
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  // Set for updates posted on an epic; null for project-level updates.
  issueId: integer('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
  // Set for updates posted on an initiative.
  initiativeId: integer('initiative_id').references(() => initiatives.id, { onDelete: 'cascade' }),
  state: varchar('state', { length: 20 }).notNull(), // on_track | at_risk | off_track
  body: text('body').notNull().default(''),
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('project_status_updates_project_idx').on(t.projectId, t.createdAt),
  issueIdx: index('project_status_updates_issue_idx').on(t.issueId, t.createdAt),
  initiativeIdx: index('project_status_updates_initiative_idx').on(t.initiativeId, t.createdAt),
}));

/** Initiatives: workspace-level groupings above epics and projects (feature switch `initiatives`). */
export const initiatives = pgTable('initiatives', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').notNull().default(''),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 20 }).notNull().default('planned'), // planned | active | completed | cancelled
  startDate: date('start_date'),
  targetDate: date('target_date'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  ownerIdx: index('initiatives_owner_idx').on(t.ownerId),
}));

export const initiativeProjects = pgTable('initiative_projects', {
  initiativeId: integer('initiative_id').notNull().references(() => initiatives.id, { onDelete: 'cascade' }),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.initiativeId, t.projectId] }),
  projectIdx: index('initiative_projects_project_idx').on(t.projectId),
}));

export const initiativeEpics = pgTable('initiative_epics', {
  initiativeId: integer('initiative_id').notNull().references(() => initiatives.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.initiativeId, t.issueId] }),
  issueIdx: index('initiative_epics_issue_idx').on(t.issueId),
}));

/** Milestones of a project (feature switch `milestones`): a named target date that issues are linked to. */
export const milestones = pgTable('milestones', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').notNull().default(''),
  targetDate: date('target_date'),
  state: varchar('state', { length: 12 }).notNull().default('open'), // open | reached
  reachedAt: timestamp('reached_at', { withTimezone: true }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectNameIdx: uniqueIndex('milestones_project_name_idx').on(t.projectId, t.name),
}));

export const milestoneIssues = pgTable('milestone_issues', {
  milestoneId: integer('milestone_id').notNull().references(() => milestones.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.milestoneId, t.issueId] }),
  issueIdx: index('milestone_issues_issue_idx').on(t.issueId),
}));


/** Issue templates: per project (project_id set) or global (project_id null). Components are stored by name so a template works in any project. */
export const issueTemplates = pgTable('issue_templates', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  issueTypeId: integer('issue_type_id').references(() => issueTypes.id, { onDelete: 'set null' }),
  summaryPattern: varchar('summary_pattern', { length: 255 }).notNull().default(''),
  body: text('body').notNull().default(''),
  priorityId: integer('priority_id').references(() => priorities.id, { onDelete: 'set null' }),
  labels: jsonb('labels').$type<string[]>().default([]).notNull(),
  componentNames: jsonb('component_names').$type<string[]>().default([]).notNull(),
  assigneeId: integer('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  customFields: jsonb('custom_fields').$type<Array<{ fieldId: number; value: unknown }>>().default([]).notNull(),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('issue_templates_project_idx').on(t.projectId),
}));

/** A rule that creates an issue from a template on a schedule. */
export const recurringIssues = pgTable('recurring_issues', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  templateId: integer('template_id').notNull().references(() => issueTemplates.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 100 }).notNull(),
  frequency: varchar('frequency', { length: 10 }).notNull(), // daily | weekly | monthly
  daysOfWeek: jsonb('days_of_week').$type<number[]>().default([]).notNull(), // ISO 1=Monday .. 7=Sunday (weekly)
  dayOfMonth: smallint('day_of_month'), // 1..31, clamped to the month's last day (monthly)
  timeOfDay: varchar('time_of_day', { length: 5 }).notNull().default('09:00'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  ownerId: integer('owner_id').notNull().references(() => users.id), // reporter of the created issues
  active: boolean('active').notNull().default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('recurring_issues_project_idx').on(t.projectId),
  dueIdx: index('recurring_issues_due_idx').on(t.active, t.nextRunAt),
}));

/** One row per scheduled slot; the unique (rule, slot) makes the scheduler idempotent across ticks, restarts and instances. */
export const recurringIssueRuns = pgTable('recurring_issue_runs', {
  id: serial('id').primaryKey(),
  recurringId: integer('recurring_id').notNull().references(() => recurringIssues.id, { onDelete: 'cascade' }),
  slotAt: timestamp('slot_at', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('pending'), // pending | created | failed | skipped
  issueId: integer('issue_id').references(() => issues.id, { onDelete: 'set null' }),
  issueKey: varchar('issue_key', { length: 60 }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  slotUniq: uniqueIndex('recurring_issue_runs_slot_uniq').on(t.recurringId, t.slotAt),
}));

/* ------------------------------------------------------------------ */
/*  Integrations: inbound webhooks, chat notifications                 */
/* ------------------------------------------------------------------ */

/** A named inbound webhook source of a project (Grafana, GitHub Actions, Sentry, generic). Addressed by an unguessable slug. */
export const inboundSources = pgTable('inbound_sources', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  type: varchar('type', { length: 20 }).notNull().default('generic'), // generic | sentry
  enabled: boolean('enabled').notNull().default(true),
  authMode: varchar('auth_mode', { length: 20 }).notNull().default('hmac'), // hmac | header
  // Signing secret / shared secret, encrypted with the instance secret key (auth/secrets.ts); shown once, rotatable.
  secretEnc: text('secret_enc').notNull(),
  // JSON path -> field templates (summary, description, priority, labels, dedupKey, resolvedWhen, priorityMap).
  mapping: jsonb('mapping').notNull().default({}),
  issueTypeId: integer('issue_type_id').references(() => issueTypes.id, { onDelete: 'set null' }),
  // The user who acts as reporter / commenter / transitioner; permissions are checked against this user.
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('inbound_sources_project_idx').on(t.projectId),
  nameUniq: uniqueIndex('inbound_sources_project_name_idx').on(t.projectId, t.name),
}));

/** Delivery log of a source: redacted, capped payload, outcome and the idempotency key used to drop retries. */
export const inboundDeliveries = pgTable('inbound_deliveries', {
  id: serial('id').primaryKey(),
  sourceId: integer('source_id').notNull().references(() => inboundSources.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull(), // processing | created | commented | transitioned | ignored | duplicate | rejected | error
  reason: text('reason'),
  idempotencyKey: varchar('idempotency_key', { length: 200 }),
  dedupKey: varchar('dedup_key', { length: 300 }),
  issueId: integer('issue_id').references(() => issues.id, { onDelete: 'set null' }),
  payload: text('payload'),
  isTest: boolean('is_test').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sourceIdx: index('inbound_deliveries_source_idx').on(t.sourceId, t.createdAt),
  idemUniq: uniqueIndex('inbound_deliveries_idem_idx').on(t.sourceId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
}));

/** Maps a source's dedup key (e.g. alert fingerprint) to the issue it created. */
export const inboundLinks = pgTable('inbound_links', {
  id: serial('id').primaryKey(),
  sourceId: integer('source_id').notNull().references(() => inboundSources.id, { onDelete: 'cascade' }),
  dedupKey: varchar('dedup_key', { length: 300 }).notNull(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('inbound_links_source_key_idx').on(t.sourceId, t.dedupKey),
  issueIdx: index('inbound_links_issue_idx').on(t.issueId),
}));

/** Outgoing chat notification channel (Slack or Microsoft Teams incoming webhook). projectId null = instance default. */
export const notificationChannels = pgTable('notification_channels', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 20 }).notNull(), // slack | teams
  name: varchar('name', { length: 100 }).notNull(),
  urlEnc: text('url_enc').notNull(), // incoming webhook URL, encrypted at rest
  events: jsonb('events').$type<string[]>().notNull().default([]),
  settings: jsonb('settings').notNull().default({}), // e.g. { teamsFormat: 'adaptive' | 'messagecard' }
  enabled: boolean('enabled').notNull().default(true),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index('notification_channels_project_idx').on(t.projectId),
}));

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: serial('id').primaryKey(),
  channelId: integer('channel_id').notNull().references(() => notificationChannels.id, { onDelete: 'cascade' }),
  event: varchar('event', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(), // success | failed | rate_limited
  responseStatus: integer('response_status'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(1),
  latencyMs: integer('latency_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  channelIdx: index('notification_deliveries_channel_idx').on(t.channelId, t.createdAt),
}));

/** Service desk automation: an action that runs once per request when a condition is met (SLA at x%, breached, waiting for the customer too long, customer replied after resolution). */
export const sdAutomationRules = pgTable('sd_automation_rules', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  // sla_percent | sla_breached | waiting_days | customer_reply | request_created
  trigger: varchar('trigger', { length: 30 }).notNull(),
  // sla_percent: percent of the SLA target used (1-99); waiting_days: days in "Waiting for customer"; unused otherwise
  threshold: integer('threshold'),
  // notify | reassign | priority | transition | comment | label | request_type
  action: varchar('action', { length: 30 }).notNull(),
  // { userId?, priorityId?, status?, text?, slaId? }
  params: jsonb('params').default({}).notNull(),
  // request_created only: { contains?: string[], channel?: string, requestTypeId?: number }; empty = every new request
  conditions: jsonb('conditions').default({}).notNull(),
  // The rule acts as this user (history, comments, transitions); the rule's creator.
  actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  deskIdx: index('sd_automation_rules_desk_idx').on(t.serviceDeskId),
}));

export const sdAutomationRuns = pgTable('sd_automation_runs', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => sdAutomationRules.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  outcome: text('outcome'),
  ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('sd_automation_runs_uniq').on(t.ruleId, t.issueId),
}));

/** What customers searched for in the knowledge base (no user is stored): shows what is missing. */
export const kbSearchLog = pgTable('kb_search_log', {
  id: serial('id').primaryKey(),
  serviceDeskId: integer('service_desk_id').notNull().references(() => serviceDesks.id, { onDelete: 'cascade' }),
  term: varchar('term', { length: 200 }).notNull(),
  results: integer('results').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  deskTimeIdx: index('kb_search_log_desk_time_idx').on(t.serviceDeskId, t.createdAt),
}));

/** Browser push subscriptions (Web Push). One row per browser/device; removed when the push service reports it gone. */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: varchar('user_agent', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('push_subscriptions_user_idx').on(t.userId),
}));

/**
 * In-app inbox (the bell in the header): one row per person per event. Written next to the e-mail/push senders, which have
 * already applied issue security, so a row never names an issue its owner cannot see. Old rows are pruned by the API.
 */
export const inboxNotifications = pgTable('inbox_notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 32 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull().default(''),
  link: varchar('link', { length: 500 }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userCreatedIdx: index('inbox_notifications_user_created_idx').on(t.userId, t.createdAt),
}));

/**
 * What a person wants pushed to their browsers and when. `events` holds only the switches that were changed (a missing key means on);
 * quiet hours silence everything except on-call pages, in the person's own time zone.
 */
export const pushPreferences = pgTable('push_preferences', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  events: jsonb('events').$type<Record<string, boolean>>().notNull().default({}),
  quietEnabled: boolean('quiet_enabled').notNull().default(false),
  quietStart: varchar('quiet_start', { length: 5 }).notNull().default('22:00'),
  quietEnd: varchar('quiet_end', { length: 5 }).notNull().default('07:00'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** On-call schedules: members rotate in fixed-length shifts from `startAt`; overrides replace the rotation for a time window. */
export const oncallSchedules = pgTable('oncall_schedules', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  rotationHours: integer('rotation_hours').notNull().default(168),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  // sha256 of the alert integration key (the key itself is shown once); alerts posted with it are routed to this schedule
  integrationKeyHash: varchar('integration_key_hash', { length: 64 }).unique(),
  // Escalation: an alert nobody acknowledged within this many minutes also goes to whoever is on call in the escalation schedule (or the next person in this rotation)
  escalationMinutes: integer('escalation_minutes'),
  escalationScheduleId: integer('escalation_schedule_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const oncallMembers = pgTable('oncall_members', {
  scheduleId: integer('schedule_id').notNull().references(() => oncallSchedules.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.scheduleId, t.userId] }),
}));

export const oncallOverrides = pgTable('oncall_overrides', {
  id: serial('id').primaryKey(),
  scheduleId: integer('schedule_id').notNull().references(() => oncallSchedules.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  scheduleIdx: index('oncall_overrides_schedule_idx').on(t.scheduleId, t.startsAt),
}));

/** Alerts routed to an on-call schedule. An open alert with the same dedup key is counted, not duplicated. */
export const oncallAlerts = pgTable('oncall_alerts', {
  id: serial('id').primaryKey(),
  scheduleId: integer('schedule_id').notNull().references(() => oncallSchedules.id, { onDelete: 'cascade' }),
  dedupKey: varchar('dedup_key', { length: 255 }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  severity: varchar('severity', { length: 10 }).notNull().default('high'), // critical | high | medium | low | info
  status: varchar('status', { length: 15 }).notNull().default('open'), // open | acknowledged | closed
  count: integer('count').notNull().default(1),
  // who was on call when the alert first arrived
  notifiedUserId: integer('notified_user_id').references(() => users.id, { onDelete: 'set null' }),
  acknowledgedBy: integer('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalatedUserId: integer('escalated_user_id').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  scheduleIdx: index('oncall_alerts_schedule_idx').on(t.scheduleId, t.status),
  // one non-closed alert per (schedule, dedup key)
  openUniq: uniqueIndex('oncall_alerts_open_uniq').on(t.scheduleId, t.dedupKey).where(sql`status <> 'closed'`),
}));

/** Teamspaces: a team (people + the projects it works in) with a combined view of its work. */
export const teamspaces = pgTable('teamspaces', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  leadId: integer('lead_id').references(() => users.id, { onDelete: 'set null' }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nameUniq: uniqueIndex('teamspaces_name_uniq').on(sql`lower(${t.name})`),
}));

export const teamspaceMembers = pgTable('teamspace_members', {
  teamspaceId: integer('teamspace_id').notNull().references(() => teamspaces.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamspaceId, t.userId] }),
  userIdx: index('teamspace_members_user_idx').on(t.userId),
}));

export const teamspaceProjects = pgTable('teamspace_projects', {
  teamspaceId: integer('teamspace_id').notNull().references(() => teamspaces.id, { onDelete: 'cascade' }),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamspaceId, t.projectId] }),
  projectIdx: index('teamspace_projects_project_idx').on(t.projectId),
}));

/** Customers (companies or accounts) that asked for or are affected by work, with how much they matter. */
export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  importance: smallint('importance').notNull().default(3), // 1 (low) .. 5 (critical account)
  annualRevenue: numeric('annual_revenue', { precision: 14, scale: 2 }),
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  nameUniq: uniqueIndex('customers_name_uniq').on(sql`lower(${t.name})`),
}));

/** "Customer X needs this issue", with a note. */
export const customerIssueLinks = pgTable('customer_issue_links', {
  customerId: integer('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  note: text('note'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.customerId, t.issueId] }),
  issueIdx: index('customer_issue_links_issue_idx').on(t.issueId),
}));
