# Wiki / Pages

Pages are Markdown documents (Jira wiki markup is rendered too) that live in the workspace or in a project: documentation,
decisions, meeting notes, runbooks. They sit under **More → Pages** (`/pages`, and `/projects/KEY/pages` for one project).
Administrators can switch the feature off under Administration → Features and modules (id `pages`): the menu entry disappears,
the API answers 404, and nothing is deleted.

## Spaces and permissions

| | Workspace page | Project page |
| --- | --- | --- |
| Who can see it | every signed-in user | users with **Browse projects** on the project |
| Create | every signed-in user | **Edit issues** on the project |
| Edit, move, archive | the author and administrators | **Edit issues** on the project |
| Edit when locked | the author and administrators (locking changes nothing here, the page is already author-only) | the author (still needs Edit issues), project administrators and administrators |
| Lock / unlock | the author and administrators | the author, project administrators and administrators |
| Comment | every signed-in user | **Add comments** on the project |
| Delete someone else's comment | administrators | administrators and project administrators |

"Administrator" means the `admin` user or a global **Administer** grant. Anything a user may not see answers **404** (not 403):
a project page, its versions and comments, the project's page list and search results never reveal that they exist. A user who
cannot browse a project cannot learn that it exists by trying to create a page in it either.

## Writing

* The editor is the same Markdown editor as for issues (toolbar, preview, tables, task lists, @mentions).
  Pasting images is not supported in pages yet (images can be embedded by URL).
* Pages nest: choose a parent when creating, use **Move** to change parent and position, or the **+** next to a page in the tree.
  Siblings are ordered by position, then title. A page cannot be moved below itself or into another space.
* **Table of contents:** the right-hand panel lists the headings of the page and jumps to them.
* **Issue keys:** `PROJ-123` in the text becomes a link to the issue (only for keys of projects that exist, so `UTF-8` stays text;
  not inside code or existing links). The key is not checked against your permissions; the issue page does that.
* **Focus mode:** hides the page tree and the details panel; `Esc` or *Exit focus* brings them back.
* **Archive** hides a page and the pages below it from the tree and from search; they stay readable by direct link and can be
  restored. Archived pages are read-only.
* **Lock** a page so that only its author and administrators can change it.

## Version history

Every save that changes the title or the text stores a new version (identical saves store nothing; moving, locking and archiving are
not versions). **History** opens a drawer with all versions (author, time, `+3 -1 lines`), the changes of the selected version
against the previous one or against the current page, and **Restore this version**, which writes the old text as a *new* version
(history is append-only, a restore can itself be restored).

Saving from the page sends the version that was edited; if someone else saved in between, the API answers 409 instead of
overwriting. There is no merge and no real-time co-editing: the second person has to copy their text, reload and apply it again.

## Comments

Comment on a page, reply (one level), edit your own comments, and quote highlighted text in a comment (**Comment on this**).
Comments are not versioned and are not attached to a position in the text.

## Convert highlighted text to an issue

Select text in a page, choose **Create issue**, pick a project, edit the summary and description, and the issue is created
(requires **Create issues** in that project). The description holds the selected text and a link back to the page; the page's
side panel lists the issue under **Linked issues**. People who can read the page but cannot browse the issue's project do not see
that link.

## Search

The search box above the tree and the command palette (`Ctrl/Cmd+K`) search titles and text of pages the user may see
(PostgreSQL full text search with word-prefix matching plus a title substring match, GIN index; archived pages are excluded).
Results show a snippet with the matches marked.

## REST API

All under `/rest/api/2/pages`, session or token authenticated, JSON bodies validated strictly.

| Request | Purpose |
| --- | --- |
| `GET /pages?project=KEY` / `?workspace=true` / no filter / `&archived=true` | flat list (no bodies) of one space or of everything the caller may see |
| `GET /pages/search?q=&project=` | full text search, up to 30 results with `snippet` (`[[match]]`) |
| `POST /pages` `{title, body?, parentId?, projectKey?}` | create (no `projectKey` = workspace page) |
| `GET /pages/:id` | page with body, ancestors, linked issues and the caller's permissions |
| `PUT /pages/:id` `{title?, body?, locked?, expectedVersion?}` | save (409 + `currentVersion` when `expectedVersion` is stale) |
| `POST /pages/:id/move` `{parentId, index?}` | change parent and position |
| `POST /pages/:id/archive`, `/unarchive` | archive or restore the page and the pages archived with it |
| `GET /pages/:id/versions`, `GET /pages/:id/versions/:n[?compare=current]` | history list; one version with its diff |
| `POST /pages/:id/versions/:n/restore` | restore version number `n` as a new version |
| `GET/POST /pages/:id/comments`, `PUT/DELETE /pages/:id/comments/:commentId` | comments |
| `POST /pages/:id/convert-to-issue` `{projectKey, text, summary?, issueTypeId?, priorityId?}` | create and link an issue |

Personal access tokens need a `*`, `read:*` or `write:*` scope (pages are not part of the `issues` or `projects` scope families).

## Not built

* Publishing a page read-only on the public pages (`/p`, see [public-projects.md](public-projects.md)).
* Real-time co-editing, slash commands, page templates, attachments/pasted images on pages, permanent deletion of pages
  (archive only), inline comments anchored to a text position, notifications and watchers for pages, drag and drop in the tree
  (use **Move**), page restrictions for single users or groups beyond the rules above, export, importing Confluence.
* Mentions in pages are rendered but do not notify anyone.

## Keyboard shortcuts
On a page (not while typing): **E** edit, **Shift+L** lock or unlock, **Shift+R** archive or restore (archiving asks for confirmation). **Esc** leaves focus mode.
