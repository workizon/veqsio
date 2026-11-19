/**
 * "Role-based" permission scheme: what each project role may do. Roles are not cumulative: every role lists everything
 * it grants, so a user in the Commenters role can browse and comment but cannot create or edit issues.
 */
const BROWSE = ['BROWSE_PROJECTS', 'VIEW_VOTERS_AND_WATCHERS'] as const
const COMMENT = ['COMMENT_ISSUE', 'ADD_COMMENTS', 'EDIT_OWN_COMMENTS', 'DELETE_OWN_COMMENTS'] as const
const WORK = [
  'CREATE_ISSUES', 'EDIT_ISSUES', 'ASSIGN_ISSUES', 'ASSIGNABLE_USER', 'RESOLVE_ISSUES', 'CLOSE_ISSUES', 'TRANSITION_ISSUES',
  'CREATE_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS', 'WORK_ON_ISSUES', 'LINK_ISSUES', 'MANAGE_WATCHERS', 'MANAGE_SPRINTS',
] as const
const ADMIN = ['PROJECT_ADMIN', 'ADMINISTER_PROJECTS', 'DELETE_ISSUES', 'MODIFY_REPORTER', 'DELETE_ALL_ATTACHMENTS', 'DELETE_ALL_COMMENTS', 'EDIT_ALL_COMMENTS', 'SET_ISSUE_SECURITY', 'EDIT_ALL_WORKLOGS', 'DELETE_ALL_WORKLOGS'] as const

export const ROLE_TEMPLATE: Record<string, { description: string; permissions: readonly string[] }> = {
  Viewers: { description: 'Can browse the project, read issues and see watchers and votes.', permissions: BROWSE },
  Commenters: { description: 'Viewers who can also comment (and edit or delete their own comments); cannot create or edit issues.', permissions: [...BROWSE, ...COMMENT] },
  Developers: { description: 'Work on issues: create, edit, assign, transition, log work, link, plan sprints.', permissions: [...BROWSE, ...COMMENT, ...WORK] },
  Administrators: { description: 'Everything a developer can do, plus project administration and moderation.', permissions: [...BROWSE, ...COMMENT, ...WORK, ...ADMIN] },
}

export interface TemplateEntry { permission: string; roleName: string }

export function roleTemplateEntries(): TemplateEntry[] {
  return Object.entries(ROLE_TEMPLATE).flatMap(([roleName, def]) => def.permissions.map((permission) => ({ permission, roleName })))
}
