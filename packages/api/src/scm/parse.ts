/**
 * Pure helpers for the git integrations: signature checks, issue-key extraction, smart-commit commands and
 * normalisation of webhook payloads from GitHub, GitLab, Gitea and Bitbucket into one event shape.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export type Provider = 'github' | 'gitlab' | 'gitea' | 'bitbucket';
export const PROVIDERS: readonly Provider[] = ['github', 'gitlab', 'gitea', 'bitbucket'];

export interface ScmEvent {
  kind: 'branch' | 'commit' | 'pull_request' | 'build';
  /** branch name, commit sha or PR number (for builds: the branch the build ran on) */
  ref: string;
  branch?: string;
  title?: string;
  url?: string;
  /** PR: open | merged | closed. Build: pending | success | failed. */
  status?: string;
  author?: string;
  authorEmail?: string;
  /** text scanned for issue keys */
  texts: string[];
  /** full commit message (smart commits) */
  message?: string;
}

const KEY_RE = /\b[A-Z][A-Z0-9_]{1,49}-\d{1,9}\b/g;

export function extractIssueKeys(...texts: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    // Branch names are often lower-case ("proj-12-fix"): match case-insensitively but only on word boundaries.
    for (const m of t.toUpperCase().matchAll(KEY_RE)) out.add(m[0]);
  }
  return [...out];
}

export interface SmartCommand { key: string; comment?: string; transition?: string }

/** `PROJ-1 #comment text #done` — the first non-comment `#word` is a transition name. */
export function parseSmartCommits(message: string): SmartCommand[] {
  const result: SmartCommand[] = [];
  const re = /\b([A-Za-z][A-Za-z0-9_]{1,49}-\d{1,9})\s+((?:#[\w-]+[^#\n]*)+)/g;
  for (const m of message.matchAll(re)) {
    const cmd: SmartCommand = { key: m[1].toUpperCase() };
    for (const part of m[2].split('#').map((s) => s.trim()).filter(Boolean)) {
      const [word, ...rest] = part.split(/\s+/);
      const w = word.toLowerCase();
      if (w === 'comment') { const text = rest.join(' ').trim(); if (text) cmd.comment = text.slice(0, 2000); }
      else if (!cmd.transition) cmd.transition = w.replace(/-/g, ' ');
    }
    if (cmd.comment || cmd.transition) result.push(cmd);
  }
  return result;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Checks the request against the repository's webhook secret in the way each provider signs it. */
export function verifyWebhook(provider: Provider, headers: (name: string) => string | undefined, rawBody: string, secret: string, queryToken?: string): boolean {
  switch (provider) {
    case 'github': {
      const sig = headers('x-hub-signature-256') ?? '';
      return sig.startsWith('sha256=') && safeEqual(sig.slice(7), hmacHex(secret, rawBody));
    }
    case 'gitea': {
      const sig = headers('x-gitea-signature') ?? headers('x-hub-signature-256')?.replace(/^sha256=/, '') ?? '';
      return sig !== '' && safeEqual(sig, hmacHex(secret, rawBody));
    }
    case 'gitlab':
      return safeEqual(headers('x-gitlab-token') ?? '', secret);
    case 'bitbucket':
      // Bitbucket Cloud does not sign deliveries; the secret travels as ?token= in the configured URL.
      return safeEqual(queryToken ?? '', secret);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const asObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});
const branchOf = (ref: unknown): string | undefined => str(ref)?.replace(/^refs\/heads\//, '');

function pushEvents(branch: string | undefined, commits: any[], repoUrl?: string): ScmEvent[] {
  const out: ScmEvent[] = [];
  if (branch) out.push({ kind: 'branch', ref: branch, branch, url: repoUrl, texts: [branch] });
  for (const c of commits.slice(0, 100)) {
    const o = asObj(c);
    const sha = str(o.id) ?? str(o.sha) ?? str(o.hash);
    const message = str(o.message);
    if (!sha || !message) continue;
    const a = asObj(o.author);
    out.push({
      kind: 'commit', ref: sha, branch, title: message.split('\n')[0].slice(0, 300), url: str(o.url) ?? str(asObj(asObj(o.links).html).href),
      author: str(a.name) ?? str(a.username), authorEmail: str(a.email), texts: [message], message,
    });
  }
  return out;
}

function prStatus(state: string | undefined, merged: boolean): string {
  if (merged || state === 'merged' || state === 'MERGED') return 'merged';
  if (state === 'closed' || state === 'declined' || state === 'DECLINED') return 'closed';
  return 'open';
}

function buildStatus(s: string | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (['success', 'passed', 'completed', 'successful'].includes(v)) return 'success';
  if (['failure', 'failed', 'error', 'canceled', 'cancelled', 'timed_out'].includes(v)) return 'failed';
  return 'pending';
}

/** Normalises one webhook delivery; unknown or irrelevant events give an empty list. */
export function parseWebhook(provider: Provider, event: string | undefined, payload: unknown): ScmEvent[] {
  const p = asObj(payload);
  try {
    if (provider === 'github' || provider === 'gitea') {
      const repoUrl = str(asObj(p.repository).html_url);
      if (event === 'push') {
        if (p.deleted) return [];
        return pushEvents(branchOf(p.ref), Array.isArray(p.commits) ? p.commits : [], repoUrl);
      }
      if (event === 'pull_request') {
        const pr = asObj(p.pull_request);
        const number = pr.number ?? p.number;
        if (number === undefined) return [];
        const head = str(asObj(pr.head).ref);
        return [{
          kind: 'pull_request', ref: String(number), branch: head, title: str(pr.title), url: str(pr.html_url),
          status: prStatus(str(pr.state), !!pr.merged), author: str(asObj(pr.user).login) ?? str(asObj(pr.user).username),
          texts: [str(pr.title) ?? '', head ?? '', str(pr.body) ?? ''],
        }];
      }
      if (event === 'workflow_run') {
        const run = asObj(p.workflow_run);
        const b = str(run.head_branch);
        return b ? [{ kind: 'build', ref: b, branch: b, url: str(run.html_url), status: run.status === 'completed' ? buildStatus(str(run.conclusion)) : 'pending', texts: [] }] : [];
      }
      if (event === 'status') {
        const b = str(asObj(Array.isArray(p.branches) ? p.branches[0] : null).name);
        return b ? [{ kind: 'build', ref: b, branch: b, url: str(p.target_url), status: buildStatus(str(p.state)), texts: [] }] : [];
      }
      return [];
    }
    if (provider === 'gitlab') {
      const repoUrl = str(asObj(p.project).web_url);
      if (event === 'Push Hook') {
        if (/^0+$/.test(String(p.after ?? '1'))) return [];
        return pushEvents(branchOf(p.ref), Array.isArray(p.commits) ? p.commits : [], repoUrl);
      }
      if (event === 'Merge Request Hook') {
        const a = asObj(p.object_attributes);
        if (a.iid === undefined) return [];
        const source = str(a.source_branch);
        return [{
          kind: 'pull_request', ref: String(a.iid), branch: source, title: str(a.title), url: str(a.url),
          status: prStatus(str(a.state), a.state === 'merged'), author: str(asObj(p.user).username),
          texts: [str(a.title) ?? '', source ?? '', str(a.description) ?? ''],
        }];
      }
      if (event === 'Pipeline Hook') {
        const a = asObj(p.object_attributes);
        const b = str(a.ref);
        return b ? [{ kind: 'build', ref: b, branch: b, status: buildStatus(str(a.status)), url: str(asObj(p.project).web_url) ? `${asObj(p.project).web_url}/-/pipelines/${a.id}` : undefined, texts: [] }] : [];
      }
      return [];
    }
    // bitbucket
    if (event === 'repo:push') {
      const out: ScmEvent[] = [];
      for (const ch of Array.isArray(asObj(p.push).changes) ? asObj(p.push).changes : []) {
        const n = asObj(ch.new);
        if (n.type !== 'branch') continue;
        const commits = (Array.isArray(ch.commits) ? ch.commits : []).map((c: any) => ({
          hash: c.hash, message: c.message, links: c.links,
          author: { name: str(asObj(asObj(c.author).user).display_name), email: str(/<([^>]+)>/.exec(str(asObj(c.author).raw) ?? '')?.[1]) },
        }));
        out.push(...pushEvents(str(n.name), commits, str(asObj(asObj(p.repository).links).html?.href)));
      }
      return out;
    }
    if (event?.startsWith('pullrequest:')) {
      const pr = asObj(p.pullrequest);
      if (pr.id === undefined) return [];
      const head = str(asObj(asObj(pr.source).branch).name);
      return [{
        kind: 'pull_request', ref: String(pr.id), branch: head, title: str(pr.title), url: str(asObj(asObj(pr.links).html).href),
        status: prStatus(str(pr.state), false), author: str(asObj(pr.author).display_name), texts: [str(pr.title) ?? '', head ?? '', str(pr.description) ?? ''],
      }];
    }
    return [];
  } catch {
    return [];
  }
}
