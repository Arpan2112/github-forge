// mcp.ts — the MCP (Model Context Protocol) endpoint at POST /mcp: JSON-RPC 2.0 with the
// github-mcp-server tool names (create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request) over the shared Forge model. Tool results carry
// the same JSON the REST surface serves, as both text content and structured content, so an
// agent reading either sees the identical object.

import { Forge, Repo, VIEWER_LOGIN, type IssueState, type PullState } from './forge.ts';
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';

export interface McpHttpResult {
  status: number;
  body?: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const MCP_TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The name of the repository'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by issue state' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        pull_number: { type: 'integer', description: 'The pull request number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'The merge method' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function callTool(forge: Forge, name: string, rawArgs: unknown): Record<string, unknown> | { rpcError: { code: number; message: string } } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;
  const invalid = (message: string): { rpcError: { code: number; message: string } } => ({ rpcError: { code: -32602, message } });

  switch (name) {
    case 'create_repo': {
      const repoName = str(args, 'name');
      if (repoName === undefined) return invalid('name is required');
      if (forge.getRepo(VIEWER_LOGIN, repoName) !== null) return toolError(`Repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, args.private !== false, str(args, 'description') ?? '');
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = str(args, 'owner');
      const repoName = str(args, 'repo');
      if (owner === undefined || repoName === undefined) return invalid('owner and repo are required');
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = str(args, 'owner');
      const repoName = str(args, 'repo');
      const title = str(args, 'title');
      if (owner === undefined || repoName === undefined || title === undefined) return invalid('owner, repo and title are required');
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
      const now = forge.nowIso();
      const issue: IssueState = {
        number: repo.nextNumber,
        title,
        body: str(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPullRequest: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = now;
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = str(args, 'owner');
      const repoName = str(args, 'repo');
      if (owner === undefined || repoName === undefined) return invalid('owner and repo are required');
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = str(args, 'state') ?? 'open';
      const items = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return toolResult(items);
    }
    case 'create_pull_request': {
      const owner = str(args, 'owner');
      const repoName = str(args, 'repo');
      const title = str(args, 'title');
      const head = str(args, 'head');
      const base = str(args, 'base');
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        return invalid('owner, repo, title, head and base are required');
      }
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
      if (repo.branchTip(head) === null || repo.branchTip(base) === null) return toolError('head or base branch does not exist');
      const now = forge.nowIso();
      const pull: PullState = {
        number: repo.nextNumber,
        title,
        body: str(args, 'body') ?? '',
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
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const owner = str(args, 'owner');
      const repoName = str(args, 'repo');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      if (owner === undefined || repoName === undefined || !Number.isFinite(number)) return invalid('owner, repo and pull_number are required');
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`Pull request ${number} not found`);
      const method = str(args, 'merge_method') ?? 'squash';
      const result = mergePull(forge, repo, pull, method);
      if ('status' in result) return toolError('Pull Request is not mergeable');
      return toolResult({ sha: result.sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, pull) });
    }
    default:
      return invalid(`Unknown tool: ${name}`);
  }
}

function handleRpc(forge: Forge, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const isNotification = id === undefined || id === null;
  const respond = (result: unknown): Record<string, unknown> | null => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const failWith = (code: number, text: string): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id: id ?? null, error: { code, message: text } };

  switch (method) {
    case 'initialize': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      return respond({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    case 'server/discover':
      return respond({
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: MCP_TOOLS });
    case 'tools/call': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      if (!MCP_TOOLS.some((tool) => tool.name === name)) return failWith(-32602, `Unknown tool: ${name}`);
      const result = callTool(forge, name, params.arguments);
      if ('rpcError' in result) return failWith(result.rpcError.code, result.rpcError.message);
      return respond(result);
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return failWith(-32601, `Method not found: ${method}`);
  }
}

/** Handle one HTTP request to /mcp. `rawBody` is the exact request body. */
export function handleMcp(forge: Forge, rawBody: Buffer): McpHttpResult {
  const text = rawBody.toString('utf8').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((item) => handleRpc(forge, (item ?? {}) as Record<string, unknown>))
      .filter((r) => r !== null);
    if (responses.length === 0) return { status: 202 };
    return { status: 200, body: responses };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const response = handleRpc(forge, parsed as Record<string, unknown>);
  if (response === null) return { status: 202 };
  return { status: 200, body: response };
}

export type { Repo };
