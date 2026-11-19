/** Names, descriptions and groups of the project permissions, for the "Permissions" screen of a project. */
export interface PermissionInfo { name: string; description: string; category: string }

export const PERMISSION_INFO: Record<string, PermissionInfo> = {
  PROJECT_ADMIN: { name: 'Administer project', description: 'Change the project settings: details, components, versions, roles and its schemes.', category: 'Administration' },
  ADMINISTER_PROJECTS: { name: 'Administer projects', description: 'Administer any project on the instance.', category: 'Administration' },
  SET_ISSUE_SECURITY: { name: 'Set issue security', description: 'Set or change the security level of an issue.', category: 'Administration' },
  BROWSE_PROJECTS: { name: 'Browse projects', description: 'Open the project and see the issues in it.', category: 'Project' },
  VIEW_VOTERS_AND_WATCHERS: { name: 'View voters and watchers', description: 'See who votes for and watches an issue.', category: 'Project' },
  MANAGE_SPRINTS: { name: 'Manage sprints', description: 'Create, start, edit and complete sprints.', category: 'Project' },
  CREATE_ISSUES: { name: 'Create issues', description: 'Create issues and sub-tasks in the project.', category: 'Issues' },
  EDIT_ISSUES: { name: 'Edit issues', description: 'Edit the fields of issues.', category: 'Issues' },
  DELETE_ISSUES: { name: 'Delete issues', description: 'Delete issues for good.', category: 'Issues' },
  TRANSITION_ISSUES: { name: 'Transition issues', description: 'Move issues through the workflow.', category: 'Issues' },
  ASSIGN_ISSUES: { name: 'Assign issues', description: 'Assign issues to other people.', category: 'Issues' },
  ASSIGNABLE_USER: { name: 'Assignable user', description: 'Can be chosen as the assignee of an issue.', category: 'Issues' },
  RESOLVE_ISSUES: { name: 'Resolve issues', description: 'Resolve issues and change their resolution.', category: 'Issues' },
  CLOSE_ISSUES: { name: 'Close issues', description: 'Close issues that were resolved.', category: 'Issues' },
  MODIFY_REPORTER: { name: 'Modify reporter', description: 'Change the reporter of an issue.', category: 'Issues' },
  LINK_ISSUES: { name: 'Link issues', description: 'Link issues together and to other projects.', category: 'Issues' },
  MANAGE_WATCHERS: { name: 'Manage watchers', description: 'Add and remove watchers of an issue.', category: 'Issues' },
  CREATE_ATTACHMENTS: { name: 'Create attachments', description: 'Attach files to issues.', category: 'Attachments' },
  DELETE_ALL_ATTACHMENTS: { name: 'Delete all attachments', description: 'Delete any attachment.', category: 'Attachments' },
  DELETE_OWN_ATTACHMENTS: { name: 'Delete own attachments', description: 'Delete the attachments you added.', category: 'Attachments' },
  COMMENT_ISSUE: { name: 'Comment on issues', description: 'Read and write comments.', category: 'Comments' },
  ADD_COMMENTS: { name: 'Add comments', description: 'Add comments to issues.', category: 'Comments' },
  EDIT_ALL_COMMENTS: { name: 'Edit all comments', description: 'Edit any comment.', category: 'Comments' },
  EDIT_OWN_COMMENTS: { name: 'Edit own comments', description: 'Edit the comments you wrote.', category: 'Comments' },
  DELETE_ALL_COMMENTS: { name: 'Delete all comments', description: 'Delete any comment.', category: 'Comments' },
  DELETE_OWN_COMMENTS: { name: 'Delete own comments', description: 'Delete the comments you wrote.', category: 'Comments' },
  WORK_ON_ISSUES: { name: 'Work on issues', description: 'Log work on issues.', category: 'Time tracking' },
  EDIT_ALL_WORKLOGS: { name: 'Edit all worklogs', description: 'Edit work logged by other people.', category: 'Time tracking' },
  DELETE_ALL_WORKLOGS: { name: 'Delete all worklogs', description: 'Delete work logged by other people.', category: 'Time tracking' },
};

export const PERMISSION_CATEGORY_ORDER = ['Project', 'Issues', 'Comments', 'Attachments', 'Time tracking', 'Administration'];
