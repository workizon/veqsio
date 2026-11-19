import { relations } from 'drizzle-orm';
import * as schema from './schema';

export const usersRelations = relations(schema.users, ({ many }) => ({
  groups: many(schema.userGroups),
  createdIssues: many(schema.issues, { relationName: 'reporter' }),
  assignedIssues: many(schema.issues, { relationName: 'assignee' }),
  automationRules: many(schema.automationRules),
}));

export const automationRulesRelations = relations(schema.automationRules, ({ one, many }) => ({
  project: one(schema.projects, { fields: [schema.automationRules.projectId], references: [schema.projects.id] }),
  createdByUser: one(schema.users, { fields: [schema.automationRules.createdBy], references: [schema.users.id] }),
  triggers: many(schema.automationTriggers),
  conditions: many(schema.automationConditions),
  actions: many(schema.automationActions),
  executions: many(schema.automationExecutions),
}));

export const automationTriggersRelations = relations(schema.automationTriggers, ({ one }) => ({
  rule: one(schema.automationRules, { fields: [schema.automationTriggers.ruleId], references: [schema.automationRules.id] }),
}));

export const automationConditionsRelations = relations(schema.automationConditions, ({ one }) => ({
  rule: one(schema.automationRules, { fields: [schema.automationConditions.ruleId], references: [schema.automationRules.id] }),
}));

export const automationActionsRelations = relations(schema.automationActions, ({ one }) => ({
  rule: one(schema.automationRules, { fields: [schema.automationActions.ruleId], references: [schema.automationRules.id] }),
}));

export const automationExecutionsRelations = relations(schema.automationExecutions, ({ one }) => ({
  rule: one(schema.automationRules, { fields: [schema.automationExecutions.ruleId], references: [schema.automationRules.id] }),
}));

export const issuesRelations = relations(schema.issues, ({ one, many }) => ({
  project: one(schema.projects, { fields: [schema.issues.projectId], references: [schema.projects.id] }),
  issueType: one(schema.issueTypes, { fields: [schema.issues.issueTypeId], references: [schema.issueTypes.id] }),
  status: one(schema.statuses, { fields: [schema.issues.statusId], references: [schema.statuses.id] }),
  priority: one(schema.priorities, { fields: [schema.issues.priorityId], references: [schema.priorities.id] }),
  resolution: one(schema.resolutions, { fields: [schema.issues.resolutionId], references: [schema.resolutions.id] }),
  assignee: one(schema.users, { fields: [schema.issues.assigneeId], references: [schema.users.id], relationName: 'assignee' }),
  reporter: one(schema.users, { fields: [schema.issues.reporterId], references: [schema.users.id], relationName: 'reporter' }),
  parent: one(schema.issues, { fields: [schema.issues.parentId], references: [schema.issues.id] }),
  subtasks: many(schema.issues, { relationName: 'parent' }),
  comments: many(schema.comments),
  attachments: many(schema.attachments),
  history: many(schema.issueHistory),
  labels: many(schema.issueLabels),
  components: many(schema.issueComponents),
  fixVersions: many(schema.issueFixVersions),
  affectsVersions: many(schema.issueAffectsVersions),
  watchers: many(schema.watchers),
  votes: many(schema.votes),
}));

export const projectsRelations = relations(schema.projects, ({ one, many }) => ({
  lead: one(schema.users, { fields: [schema.projects.leadId], references: [schema.users.id] }),
  issues: many(schema.issues),
  components: many(schema.components),
  versions: many(schema.versions),
}));

export const commentsRelations = relations(schema.comments, ({ one }) => ({
  issue: one(schema.issues, { fields: [schema.comments.issueId], references: [schema.issues.id] }),
  author: one(schema.users, { fields: [schema.comments.authorId], references: [schema.users.id] }),
}));

export const attachmentsRelations = relations(schema.attachments, ({ one }) => ({
  issue: one(schema.issues, { fields: [schema.attachments.issueId], references: [schema.issues.id] }),
  author: one(schema.users, { fields: [schema.attachments.authorId], references: [schema.users.id] }),
}));
