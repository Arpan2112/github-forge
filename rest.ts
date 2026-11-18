// rest.ts — the GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, with GitHub's status codes and body shapes. Everything is
// served from the shared Forge model, so a change made here is visible to GraphQL, MCP and git
// in the same instant.

import {
  Forge,
  Repo,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commitFlat,
  commitTree,
  countLines,
  diffFlats,
  flatAtCommit,
  mergeFlats,
  type IssueState,
  type PullState,
} from './forge.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  commitHistory,
  mergeBase,
  parseCommit,
  parseTree,
  type Identity,
} from './gitcore.ts';

export interface ApiRequest {
  method: string;
  /** The path after /api/v3, e.g. '/repos/adaiversen/demo/contents/src/a.ts'. */
  path: string;
  query: URLSearchParams;
  body: Buffer;
  /** The request's Host header, for absolute pagination links. */
  host: string;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): ApiResponse => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): ApiResponse => ({ status: 422, body: { message } });

function parseBody(request: ApiRequest): Record<string, unknown> | ApiResponse {
  const text = request.body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
}

function isError(value: Record<string, unknown> | ApiResponse): value is ApiResponse {
  return 'status' in value && 'body' in value;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_pull_requests: true,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label === undefined ? 0 : [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: IssueState): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

/** A pull request rendered as an issue (GitHub's REST issue list includes pull requests). */
export function pullAsIssueJson(repo: Repo, pull: PullState): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: `I_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userJson(),
    assignee: null,
    assignees: [],
    comments: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    pull_request: { url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}` },
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullState): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? ZERO_OID;
  const baseSha = repo.branchTip(pull.baseRef) ?? ZERO_OID;
  return {
    id: repo.id * 100000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    user: userJson(),
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? computeMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (computeMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

/** Could this pull merge cleanly right now? (File-level three-way merge against the merge base.) */
export function computeMergeable(repo: Repo, pull: PullState): boolean {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) return true;
  const merged = mergeFlats(flatAtCommit(repo.store, base), flatAtCommit(repo.store, baseTip), flatAtCommit(repo.store, headTip));
  return merged !== null;
}

/** Perform the merge (or fail with the GitHub status). Shared by REST, GraphQL and MCP. */
export function mergePull(
  forge: Forge,
  repo: Repo,
  pull: PullState,
  method: string,
): { sha: string } | ApiResponse {
  if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === null || baseTip === null) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const base = mergeBase(repo.store, baseTip, headTip);
  const ancestorFlat = flatAtCommit(repo.store, base);
  const baseFlat = flatAtCommit(repo.store, baseTip);
  const headFlat = flatAtCommit(repo.store, headTip);
  const when: Identity = forge.nowIdentity();
  let sha: string;
  if (method === 'merge') {
    const mergedFlat = mergeFlats(ancestorFlat, baseFlat, headFlat);
    if (mergedFlat === null) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    const tree = buildTreeFromFlat(repo.store, mergedFlat);
    sha = repo.store.put('commit', buildCommit({ tree, parents: [baseTip, headTip], author: when, committer: when, message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}` }));
  } else {
    // Squash (and the default): one commit on the base branch carrying the head's net change.
    const mergedFlat = mergeFlats(ancestorFlat, baseFlat, headFlat);
    if (mergedFlat === null) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    sha = commitFlat(repo, baseTip, mergedFlat, `${pull.title} (#${pull.number})`, when);
  }
  repo.setBranch(pull.baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  repo.updatedAt = pull.mergedAt;
  return { sha };
}



// -------------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------------

function paginate<T>(request: ApiRequest, items: T[]): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(request.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(request.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(request.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const lastParams = new URLSearchParams(request.query);
    lastParams.set('per_page', String(perPage));
    lastParams.set('page', String(Math.ceil(items.length / perPage)));
    const base = `http://${request.host}/api/v3${request.path}`;
    headers.link = `<${base}?${params.toString()}>; rel="next", <${base}?${lastParams.toString()}>; rel="last"`;
  }
  return { page: slice, headers };
}

// -------------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------------

export function handleApi(forge: Forge, request: ApiRequest): ApiResponse {
  const { method, path } = request;
  const segments = path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));

  // Root and meta.
  if (path === '/' || path === '') {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0-forge', verifiable_password_authentication: false, github_services_sha: 'forge' } };
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: userJson() };
  }
  if (segments[0] === 'rate_limit' && method === 'GET') {
    return { status: 200, body: { rate: { limit: 5000, remaining: 4999, reset: 1893456000 }, resources: {} } };
  }

  // The viewer's repositories.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(request, forge.listRepos());
      return { status: 200, body: page.map(repoJson), headers };
    }
    if (method === 'POST') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const name = str(body.name);
      if (name === undefined || name === '') return unprocessable('name is required');
      if (forge.getRepo(VIEWER_LOGIN, name) !== null) {
        return { status: 422, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } };
      }
      const repo = forge.createRepo(name, body.private !== false, str(body.description) ?? '');
      if (body.auto_init === true) {
        const flat = new Map<string, { mode: string; sha: string }>();
        const blob = repo.store.put('blob', Buffer.from(`# ${name}\n`, 'utf8'));
        flat.set('README.md', { mode: '100644', sha: blob });
        const sha = commitFlat(repo, null, flat, 'Initial commit', forge.nowIdentity());
        repo.setBranch(repo.defaultBranch, sha);
      }
      return { status: 201, body: repoJson(repo) };
    }
    return notFound();
  }

  // Everything under /repos/{owner}/{repo}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = forge.getRepo(owner, name);
    if (repo === null) return notFound();
    const rest = segments.slice(3);
    return handleRepo(forge, repo, rest, request);
  }

  return notFound();
}

function handleRepo(forge: Forge, repo: Repo, rest: string[], request: ApiRequest): ApiResponse {
  const { method } = request;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const description = str(body.description);
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = forge.nowIso();
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`), url: '' }, protected: false }));
      const { page, headers } = paginate(request, branches);
      return { status: 200, body: page, headers };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = repo.branchTip(branch);
      if (tip === null) return notFound();
      return { status: 200, body: { name: branch, commit: { sha: tip, url: '' }, protected: false } };
    }
    return notFound();
  }

  // Git refs (branch/tag creation).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
      if (!repo.store.has(sha)) return unprocessable('Object does not exist');
      if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
      repo.refs.set(ref, sha);
      repo.updatedAt = forge.nowIso();
      return { status: 201, body: { ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      return { status: 200, body: { ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } } };
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const shaParam = request.query.get('sha');
      let tip: string | null;
      if (shaParam === null || shaParam === '') tip = repo.branchTip(repo.defaultBranch);
      else if (repo.store.has(shaParam)) tip = shaParam;
      else tip = repo.branchTip(shaParam);
      if (tip === null) return { status: 409, body: { message: 'Git Repository is empty.' } };
      const history = commitHistory(repo.store, tip).map((sha) => commitJson(repo, sha));
      const { page, headers } = paginate(request, history);
      return { status: 200, body: page, headers };
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = rest[1] as string;
      if (!repo.store.has(sha)) return notFound();
      return { status: 200, body: commitJson(repo, sha) };
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(forge, repo, path, request);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, body: [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)) };
    }
    if (rest.length === 1 && method === 'POST') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const name = str(body.name);
      if (name === undefined || name === '') return unprocessable('name is required');
      if (repo.labels.has(name)) return unprocessable('Validation Failed: name has already been taken');
      repo.labels.set(name, { name, color: (str(body.color) ?? 'ededed').replace(/^#/, ''), description: str(body.description) ?? null });
      return { status: 201, body: labelJson(repo, name) };
    }
    return notFound();
  }

  // Issues and their comments (pull requests share the number space).
  if (rest[0] === 'issues') {
    return handleIssues(forge, repo, rest.slice(1), request);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(forge, repo, rest.slice(1), request);
  }

  return notFound();
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.store.get(sha);
  if (object === undefined || object.type !== 'commit') return { sha };
  const commit = parseCommit(object.data);
  const iso = (identity: Identity): string => new Date(identity.epochSec * 1000).toISOString();
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: { name: commit.author.name, email: commit.author.email, date: iso(commit.author) },
      committer: { name: commit.committer.name, email: commit.committer.email, date: iso(commit.committer) },
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
    author: { login: commit.author.email === VIEWER_EMAIL ? VIEWER_LOGIN : commit.author.name, id: VIEWER_ID, type: 'User' },
    committer: { login: commit.committer.email === VIEWER_EMAIL ? VIEWER_LOGIN : commit.committer.name, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
  };
}

// -------------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------------

function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.branchTip(repo.defaultBranch);
  if (repo.store.has(ref)) return ref;
  return repo.branchTip(ref);
}

function handleContents(forge: Forge, repo: Repo, path: string, request: ApiRequest): ApiResponse {
  const { method } = request;

  if (method === 'GET') {
    const tip = resolveRef(repo, request.query.get('ref'));
    if (tip === null) return notFound();
    const flat = flatAtCommit(repo.store, tip);
    const entry = flat.get(path);
    if (entry !== undefined) {
      const blob = repo.store.get(entry.sha);
      const data = blob?.data ?? Buffer.alloc(0);
      const name = path.split('/').pop() as string;
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          content: wrapBase64(data),
          sha: entry.sha,
          size: data.length,
          name,
          path,
          url: '',
          html_url: '',
          download_url: '',
        },
      };
    }
    // A directory listing (also the root when path is empty).
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    for (const [filePath, file] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash === -1) {
        entries.set(remainder, { type: 'file', sha: file.sha, size: repo.store.get(file.sha)?.data.length ?? 0 });
      } else {
        const dir = remainder.slice(0, slash);
        if (!entries.has(dir)) {
          const treeSha = treeShaAtPath(repo, tip, prefix + dir);
          entries.set(dir, { type: 'dir', sha: treeSha ?? ZERO_OID, size: 0 });
        }
      }
    }
    if (entries.size === 0 && path !== '') return notFound();
    const listing = [...entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, entry]) => ({
        name,
        path: prefix + name,
        sha: entry.sha,
        size: entry.size,
        type: entry.type,
        url: '',
        html_url: '',
        download_url: null,
      }));
    return { status: 200, body: listing };
  }

  if (method === 'PUT') {
    const body = parseBody(request);
    if (isError(body)) return body;
    const message = str(body.message) ?? '';
    const contentB64 = str(body.content);
    if (contentB64 === undefined) return unprocessable('content is required');
    const branch = str(body.branch) ?? repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (tip === null && branch !== repo.defaultBranch) return notFound();
    const flat = flatAtCommit(repo.store, tip);
    const existing = flat.get(path);
    const givenSha = str(body.sha);
    if (existing !== undefined) {
      if (givenSha === undefined) return unprocessable('sha wasn\'t supplied');
      if (givenSha !== existing.sha) return { status: 409, body: { message: 'Conflict: the file has changed since the sha was read' } };
    }
    const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const blobSha = repo.store.put('blob', data);
    flat.set(path, { mode: existing?.mode ?? '100644', sha: blobSha });
    const when = forge.nowIdentity();
    const commitSha = commitFlat(repo, tip, flat, message, when);
    repo.setBranch(branch, commitSha);
    repo.updatedAt = forge.nowIso();
    const name = path.split('/').pop() as string;
    return {
      status: existing !== undefined ? 200 : 201,
      body: {
        content: { name, path, sha: blobSha, size: data.length, type: 'file', encoding: 'base64', content: wrapBase64(data), url: '', html_url: '', download_url: '' },
        commit: { sha: commitSha, message, author: { name: when.name, email: when.email, date: new Date(when.epochSec * 1000).toISOString() }, committer: { name: when.name, email: when.email, date: new Date(when.epochSec * 1000).toISOString() }, tree: { sha: commitTree(repo.store, commitSha) }, parents: tip === null ? [] : [{ sha: tip }] },
      },
    };
  }

  if (method === 'DELETE') {
    const body = parseBody(request);
    if (isError(body)) return body;
    const message = str(body.message) ?? '';
    const branch = str(body.branch) ?? repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (tip === null) return notFound();
    const flat = flatAtCommit(repo.store, tip);
    const existing = flat.get(path);
    if (existing === undefined) return notFound();
    const givenSha = str(body.sha);
    if (givenSha !== undefined && givenSha !== existing.sha) {
      return { status: 409, body: { message: 'Conflict: the file has changed since the sha was read' } };
    }
    flat.delete(path);
    const when = forge.nowIdentity();
    const commitSha = commitFlat(repo, tip, flat, message, when);
    repo.setBranch(branch, commitSha);
    repo.updatedAt = forge.nowIso();
    return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
  }

  return notFound();
}

/** The tree id at a slash path inside a commit's tree (for directory listings). */
function treeShaAtPath(repo: Repo, commitId: string, path: string): string | null {
  const tree = commitTree(repo.store, commitId);
  if (tree === null) return null;
  let current = tree;
  for (const part of path.split('/').filter((p) => p !== '')) {
    const object = repo.store.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entries = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
    if (entries === undefined) return null;
    current = entries.sha;
  }
  return current;
}

/** GitHub wraps base64 content at 60 columns. */
function wrapBase64(data: Buffer): string {
  const b64 = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 60) lines.push(b64.slice(i, i + 60));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// -------------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------------

function handleIssues(forge: Forge, repo: Repo, rest: string[], request: ApiRequest): ApiResponse {
  const { method } = request;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const title = str(body.title);
      if (title === undefined || title === '') return unprocessable('title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label "${label}" does not exist`);
      }
      const now = forge.nowIso();
      const issue: IssueState = {
        number: repo.nextNumber,
        title,
        body: str(body.body) ?? '',
        state: 'open',
        labels,
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPullRequest: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = now;
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const sort = request.query.get('sort') ?? 'created';
      const direction = request.query.get('direction') ?? 'desc';
      const items: Record<string, unknown>[] = [];
      for (const issue of repo.issues.values()) {
        if (state !== 'all' && issue.state !== state) continue;
        items.push(issueJson(repo, issue));
      }
      for (const pull of repo.pulls.values()) {
        if (state !== 'all' && pull.state !== state) continue;
        items.push(pullAsIssueJson(repo, pull));
      }
      void sort;
      items.sort((a, b) => {
        const diff = (a.number as number) - (b.number as number);
        return direction === 'asc' ? diff : -diff;
      });
      const { page, headers } = paginate(request, items);
      return { status: 200, body: page, headers };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue !== undefined) return { status: 200, body: issueJson(repo, issue) };
      if (pull !== undefined) return { status: 200, body: pullAsIssueJson(repo, pull) };
      return notFound();
    }
    if (method === 'PATCH') {
      const body = parseBody(request);
      if (isError(body)) return body;
      if (issue !== undefined) {
        const title = str(body.title);
        if (title !== undefined) issue.title = title;
        const text = str(body.body);
        if (text !== undefined) issue.body = text;
        const state = str(body.state);
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? forge.nowIso() : null;
        }
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((l): l is string => typeof l === 'string');
          for (const label of labels) {
            if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label "${label}" does not exist`);
          }
          issue.labels = labels;
        }
        issue.updatedAt = forge.nowIso();
        return { status: 200, body: issueJson(repo, issue) };
      }
      if (pull !== undefined) {
        const state = str(body.state);
        if (state === 'open' || state === 'closed') pull.state = state;
        const title = str(body.title);
        if (title !== undefined) pull.title = title;
        const text = str(body.body);
        if (text !== undefined) pull.body = text;
        pull.updatedAt = forge.nowIso();
        return { status: 200, body: pullAsIssueJson(repo, pull) };
      }
      return notFound();
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    // Comments live on the issue; a pull request's issue comments are the same list.
    const comments = issue?.comments ?? null;
    if (method === 'GET') {
      if (issue !== undefined) {
        return { status: 200, body: issue.comments.map((c) => commentJson(repo, issue.number, c)) };
      }
      if (pull !== undefined) return { status: 200, body: [] };
      return notFound();
    }
    if (method === 'POST') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const text = str(body.body);
      if (text === undefined) return unprocessable('body is required');
      if (issue === undefined) {
        if (pull === undefined) return notFound();
        // A comment on a pull request through the issues API: keep it on a shadow issue list.
        return { status: 201, body: { id: repo.nextCommentId++, body: text, user: userJson(), created_at: forge.nowIso(), updated_at: forge.nowIso() } };
      }
      const comment = { id: repo.nextCommentId, body: text, createdAt: forge.nowIso() };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      void comments;
      return { status: 201, body: commentJson(repo, issue.number, comment) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'labels' && method === 'POST') {
    const body = parseBody(request);
    if (isError(body)) return body;
    if (issue === undefined) return notFound();
    const names = Array.isArray(body) ? [] : [];
    void names;
    return { status: 200, body: issue.labels.map((name) => labelJson(repo, name)) };
  }

  return notFound();
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
  };
}

// -------------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------------

function handlePulls(forge: Forge, repo: Repo, rest: string[], request: ApiRequest): ApiResponse {
  const { method } = request;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base);
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        return unprocessable('title, head and base are required');
      }
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      const headTip = repo.branchTip(head);
      const baseTip = repo.branchTip(base);
      if (headTip === null || baseTip === null) return unprocessable('Validation Failed: head or base branch does not exist');
      if (head === base) return unprocessable('Validation Failed: head and base are the same');
      const existing = [...repo.pulls.values()].find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
      if (existing !== undefined) return unprocessable(`A pull request already exists for ${head} into ${base}`);
      const now = forge.nowIso();
      const pull: PullState = {
        number: repo.nextNumber,
        title,
        body: str(body.body) ?? '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: now,
        updatedAt: now,
        isPullRequest: true,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = now;
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const items = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state || (state === 'closed' && pull.state === 'closed'))
        .sort((a, b) => b.number - a.number)
        .map((pull) => pullJson(repo, pull));
      const { page, headers } = paginate(request, items);
      return { status: 200, body: page, headers };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return notFound();
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (pull === undefined) return notFound();
      return { status: 200, body: pullJson(repo, pull) };
    }
    if (method === 'PATCH') {
      const body = parseBody(request);
      if (isError(body)) return body;
      if (pull === undefined) return notFound();
      const title = str(body.title);
      if (title !== undefined) pull.title = title;
      const text = str(body.body);
      if (text !== undefined) pull.body = text;
      const state = str(body.state);
      if (state === 'open' || state === 'closed') pull.state = state;
      pull.updatedAt = forge.nowIso();
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }

  if (pull === undefined) return notFound();

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === null || baseTip === null) return { status: 200, body: [] };
    const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
    const fromFlat = flatAtCommit(repo.store, base);
    const toFlat = flatAtCommit(repo.store, headTip);
    const files = diffFlats(fromFlat, toFlat).map((file) => {
      const from = fromFlat.get(file.filename);
      const to = toFlat.get(file.filename);
      const oldLines = from === undefined ? [] : blobLines(repo, from.sha);
      const newLines = to === undefined ? [] : blobLines(repo, to.sha);
      const { additions, deletions } = lineDiffCounts(oldLines, newLines);
      return {
        filename: file.filename,
        status: file.status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: file.sha,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      };
    });
    const { page, headers } = paginate(request, files);
    return { status: 200, body: page, headers };
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method === 'PUT') {
      const body = parseBody(request);
      if (isError(body)) return body;
      const mergeMethod = str(body.merge_method) ?? 'merge';
      const result = mergePull(forge, repo, pull, mergeMethod);
      if ('status' in result) return result;
      return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    if (method === 'GET') {
      return pull.merged ? { status: 204 } : notFound();
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'commits' && method === 'GET') {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === null || baseTip === null) return { status: 200, body: [] };
    const base = mergeBase(repo.store, baseTip, headTip);
    const history = commitHistory(repo.store, headTip);
    const commits = (base === null ? history : history.slice(0, history.indexOf(base))).map((sha) => commitJson(repo, sha));
    return { status: 200, body: commits };
  }

  return notFound();
}

function blobLines(repo: Repo, sha: string): string[] {
  const object = repo.store.get(sha);
  if (object === undefined) return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Additions/deletions between two line arrays by longest-common-subsequence. */
export function lineDiffCounts(oldLines: string[], newLines: string[]): { additions: number; deletions: number } {
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0) return { additions: n, deletions: 0 };
  if (n === 0) return { additions: 0, deletions: m };
  // LCS via dynamic programming over the shorter axis to bound memory.
  const dp: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    let prev = 0;
    for (let j = 1; j <= n; j += 1) {
      const saved = dp[j] as number;
      if (oldLines[i - 1] === newLines[j - 1]) dp[j] = prev + 1;
      else dp[j] = Math.max(dp[j] as number, dp[j - 1] as number);
      prev = saved;
    }
  }
  const common = dp[n] as number;
  return { additions: n - common, deletions: m - common };
}

export { countLines };
