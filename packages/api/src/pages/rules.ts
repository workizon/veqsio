/**
 * Who may do what with a page. Pure decision functions (the route collects the facts, see routes/pages.ts).
 *
 * Workspace pages (no project): readable by every signed-in user, editable by the author and administrators.
 * Project pages: readable with BROWSE_PROJECTS, editable with EDIT_ISSUES on the project. A locked project page
 * is editable only by its author (who still needs EDIT_ISSUES), administrators and project administrators.
 */
export interface PageFacts {
  /** the page belongs to a project (false = workspace page) */
  inProject: boolean;
  isAuthor: boolean;
  /** global administrator */
  isAdmin: boolean;
  /** PROJECT_ADMIN on the page's project */
  isProjectAdmin: boolean;
  /** EDIT_ISSUES on the page's project */
  canEditInProject: boolean;
  locked: boolean;
}

export function canEditPage(f: PageFacts): boolean {
  if (f.isAdmin) return true;
  if (!f.inProject) return f.isAuthor;
  if (f.isProjectAdmin) return true;
  if (!f.canEditInProject) return false;
  return f.locked ? f.isAuthor : true;
}

/** Locking and unlocking: the author and administrators only. */
export function canLockPage(f: PageFacts): boolean {
  if (f.isAdmin) return true;
  if (!f.inProject) return f.isAuthor;
  return f.isProjectAdmin || (f.isAuthor && f.canEditInProject);
}

/** Deleting other people's comments and similar moderation. */
export function canModeratePage(f: PageFacts): boolean {
  return f.isAdmin || (f.inProject && f.isProjectAdmin);
}
