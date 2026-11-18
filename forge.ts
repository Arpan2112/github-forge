// forge.ts — the forge's data model: repositories, their object stores and refs, and the issue /
// pull-request / label state the REST, GraphQL, MCP and git surfaces all share. One Forge per
// process; the trial's viewer is the single user the bearer token names.
//
// Time is a logical clock, not the wall clock: every mutation advances a counter from a fixed
// epoch, so the same request sequence always produces the same timestamps (the harness runs an
// entry twice and compares). Ids are likewise sequential counters.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFlat,
  commitHistory,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  type Identity,
} from './gitcore.ts';

/** The login the suite's token names (the scenario's viewer, fixed by the suite's own seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The forge identity commits are authored under when the API creates them. */
export const FORGE_IDENTITY: Identity = {
  name: VIEWER_NAME,
  email: VIEWER_EMAIL,
  epochSec: 1_767_225_600, // replaced per-commit by the logical clock below
  tz: '+0000',
};

/** 2026-01-01T00:00:00Z: the logical clock's epoch. */
const CLOCK_EPOCH_SEC = 1_767_225_600;

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueState {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** GraphQL kind: an issue and a pull request are different node types over one number space. */
  isPullRequest: false;
}

export interface PullState {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  isPullRequest: true;
}

export interface LabelState {
  name: string;
  color: string;
  description: string | null;
}

export class Repo {
  readonly store = new ObjectStore();
  /** Full ref name ('refs/heads/main') -> object id. HEAD is symbolic to the default branch. */
  readonly refs = new Map<string, string>();
  readonly issues = new Map<number, IssueState>();
  readonly pulls = new Map<number, PullState>();
  readonly labels = new Map<string, LabelState>();
  /**
   * Fetch packs by request signature. Objects are content-addressed and immutable, so a given
   * (wants, haves, shallow, depth) request always yields the same pack in this repository.
   */
  readonly packCache = new Map<string, { pack: Buffer; shallowInfo: string[] }>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber = 1;
  nextCommentId = 1;

  readonly id: number;
  readonly owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;

  constructor(
    id: number,
    owner: string,
    name: string,
    isPrivate: boolean,
    description: string,
    defaultBranch: string,
    createdAt: string,
    updatedAt: string,
  ) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The current tip of a branch (short name), or null when unborn/absent. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Set a branch (short name) to a commit id. */
  setBranch(branch: string, sha: string): void {
    this.refs.set(`refs/heads/${branch}`, sha);
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private clockTicks = 0;

  /** The next logical timestamp, as an ISO string; every call advances the clock one second. */
  nowIso(): string {
    this.clockTicks += 1;
    return new Date((CLOCK_EPOCH_SEC + this.clockTicks) * 1000).toISOString();
  }

  /** The next logical timestamp as a git identity time. */
  nowIdentity(): Identity {
    this.clockTicks += 1;
    return { name: VIEWER_NAME, email: VIEWER_EMAIL, epochSec: CLOCK_EPOCH_SEC + this.clockTicks, tz: '+0000' };
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const created = this.nowIso();
    const repo = new Repo(this.nextRepoId, VIEWER_LOGIN, name, isPrivate, description, 'main', created, created);
    this.nextRepoId += 1;
    this.repos.set(name.toLowerCase(), repo);
    return repo;
  }

  /** Look a repository up by owner + name; a foreign owner is simply absent (404, never 403). */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(name.toLowerCase()) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(name.toLowerCase());
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

// -------------------------------------------------------------------------------------------------
// commit-level helpers shared by REST contents, pulls and merges
// -------------------------------------------------------------------------------------------------

/** The tree id at a commit, or null. */
export function commitTree(store: ObjectStore, commitId: string): string | null {
  const object = store.get(commitId);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The flat path map at a ref (or commit id); an unborn ref flattens to empty. */
export function flatAtCommit(store: ObjectStore, commitId: string | null): Map<string, { mode: string; sha: string }> {
  if (commitId === null) return new Map();
  const tree = commitTree(store, commitId);
  if (tree === null) return new Map();
  return flattenTree(store, tree);
}

/**
 * Make one commit on top of `parent` (null for a root commit) whose tree is `flat`, authored by
 * the forge identity at `when`. Answers the new commit id; the caller moves the ref.
 */
export function commitFlat(
  repo: Repo,
  parent: string | null,
  flat: ReadonlyMap<string, { mode: string; sha: string }>,
  message: string,
  when: Identity,
): string {
  const tree = buildTreeFromFlat(repo.store, flat);
  const data = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    author: when,
    committer: when,
    message,
  });
  return repo.store.put('commit', data);
}

/**
 * Three-way file-level merge of `headFlat` into `baseFlat` against their common ancestor
 * `ancestorFlat`. A path conflicts when both sides changed it differently (or one deleted what
 * the other changed). Answers the merged map, or null on conflict.
 */
export function mergeFlats(
  ancestorFlat: ReadonlyMap<string, { mode: string; sha: string }>,
  baseFlat: ReadonlyMap<string, { mode: string; sha: string }>,
  headFlat: ReadonlyMap<string, { mode: string; sha: string }>,
): Map<string, { mode: string; sha: string }> | null {
  const merged = new Map(baseFlat);
  const paths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    const baseChanged = !sameFile(base, ancestor);
    const headChanged = !sameFile(head, ancestor);
    if (!headChanged) continue;
    if (baseChanged && !sameFile(base, head)) return null; // both sides changed it differently
    if (head === undefined) merged.delete(path);
    else merged.set(path, head);
  }
  return merged;
}

function sameFile(
  a: { mode: string; sha: string } | undefined,
  b: { mode: string; sha: string } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.sha === b.sha && a.mode === b.mode;
}

/** The changed paths between two flats, with GitHub's status words. */
export function diffFlats(
  fromFlat: ReadonlyMap<string, { mode: string; sha: string }>,
  toFlat: ReadonlyMap<string, { mode: string; sha: string }>,
): { filename: string; status: 'added' | 'removed' | 'modified' | 'renamed'; additions: number; deletions: number; changes: number; sha: string }[] {
  const out: { filename: string; status: 'added' | 'removed' | 'modified' | 'renamed'; additions: number; deletions: number; changes: number; sha: string }[] = [];
  const paths = new Set([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to !== undefined && from.sha === to.sha) continue;
    const status = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions: 0, deletions: 0, changes: 0, sha: to?.sha ?? from?.sha ?? '' });
  }
  return out;
}

/** Line counts of a text blob, for the pull-files additions/deletions fields. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

export { commitHistory, isAncestor, mergeBase };
