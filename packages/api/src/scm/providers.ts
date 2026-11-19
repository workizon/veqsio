/** Provider API calls (branch creation). `fetch` is injectable for tests; base URLs go through the SSRF guard. */
import { assertPublicUrl } from '../plugins/ssrf';
import type { Provider } from './parse';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
// redirects are never followed: the SSRF check only covers the first URL, a hop to 169.254.x or localhost would skip it
let doFetch: Fetch = (url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
export function setScmFetch(f: Fetch | null) { doFetch = f ?? ((url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) })); }

export class ScmError extends Error {}

export interface RepoRef { provider: Provider; baseUrl: string | null; name: string; defaultBranch: string }

export function webBase(r: RepoRef): string {
  if (r.baseUrl) return r.baseUrl.replace(/\/+$/, '');
  return { github: 'https://github.com', gitlab: 'https://gitlab.com', gitea: '', bitbucket: 'https://bitbucket.org' }[r.provider];
}

export function branchUrl(r: RepoRef, branch: string): string {
  const b = webBase(r), n = r.name, br = encodeURI(branch);
  switch (r.provider) {
    case 'github': return `${b}/${n}/tree/${br}`;
    case 'gitlab': return `${b}/${n}/-/tree/${br}`;
    case 'gitea': return `${b}/${n}/src/branch/${br}`;
    case 'bitbucket': return `${b}/${n}/branch/${br}`;
  }
}

export function validBranchName(n: string): boolean {
  return /^[A-Za-z0-9._\/-]{1,200}$/.test(n) && !n.includes('..') && !n.startsWith('/') && !n.endsWith('/') && !n.endsWith('.lock') && !n.startsWith('-');
}

export function suggestBranchName(key: string, summary: string): string {
  const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return slug ? `${key}-${slug}` : key;
}

async function call(url: string, init: RequestInit): Promise<any> {
  await assertPublicUrl(url);
  const res = await doFetch(url, init);
  if (res.status >= 300 && res.status < 400) throw new ScmError('The provider answered with a redirect, which is not followed. Check the repository base URL');
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new ScmError(`${res.status === 401 || res.status === 403 ? 'The access token was rejected' : res.status === 422 || res.status === 409 ? 'The branch already exists or the base branch is missing' : `Provider answered ${res.status}`}${text ? `: ${text}` : ''}`);
  }
  return res.json().catch(() => ({}));
}

/** Creates `branch` from `base` in the provider's repository. */
export async function createBranch(r: RepoRef, token: string, branch: string, base: string): Promise<void> {
  const json = { 'Content-Type': 'application/json' };
  switch (r.provider) {
    case 'github': {
      const api = r.baseUrl ? `${r.baseUrl.replace(/\/+$/, '')}/api/v3` : 'https://api.github.com';
      const h = { ...json, Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
      const ref = await call(`${api}/repos/${r.name}/git/ref/heads/${encodeURI(base)}`, { headers: h });
      const sha = ref?.object?.sha;
      if (!sha) throw new ScmError('Base branch not found');
      await call(`${api}/repos/${r.name}/git/refs`, { method: 'POST', headers: h, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
      return;
    }
    case 'gitlab': {
      const api = `${webBase(r)}/api/v4`;
      await call(`${api}/projects/${encodeURIComponent(r.name)}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(base)}`, { method: 'POST', headers: { 'PRIVATE-TOKEN': token } });
      return;
    }
    case 'gitea': {
      await call(`${webBase(r)}/api/v1/repos/${r.name}/branches`, { method: 'POST', headers: { ...json, Authorization: `token ${token}` }, body: JSON.stringify({ new_branch_name: branch, old_branch_name: base }) });
      return;
    }
    case 'bitbucket': {
      const api = `https://api.bitbucket.org/2.0/repositories/${r.name}`;
      const h = { ...json, Authorization: `Bearer ${token}` };
      const b = await call(`${api}/refs/branches/${encodeURIComponent(base)}`, { headers: h });
      const hash = b?.target?.hash;
      if (!hash) throw new ScmError('Base branch not found');
      await call(`${api}/refs/branches`, { method: 'POST', headers: h, body: JSON.stringify({ name: branch, target: { hash } }) });
      return;
    }
  }
}
