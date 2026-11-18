// graphql.ts — the GitHub GraphQL v4 surface at POST /api/graphql. A small self-contained
// parser and executor over the shared Forge model: the queries and mutations gh and
// github-mcp-server send (viewer, repository, issues, pull requests, node, introspection),
// with GitHub's global ids, connections and enums. One document per request, or a JSON array
// of documents answered in order.

import {
  Forge,
  Repo,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  flatAtCommit,
  mergeFlats,
  type IssueState,
  type PullState,
} from './forge.ts';
import { mergeBase } from './gitcore.ts';
import { computeMergeable, lineDiffCounts, mergePull } from './rest.ts';
import { diffFlats } from './forge.ts';

// -------------------------------------------------------------------------------------------------
// global ids
// -------------------------------------------------------------------------------------------------

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function parseGid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

export const repoGid = (repo: Repo): string => gid('Repository', repo.id);
export const issueGid = (repo: Repo, number: number): string => gid('Issue', repo.id, number);
export const pullGid = (repo: Repo, number: number): string => gid('PullRequest', repo.id, number);
export const userGid = (): string => gid('User', VIEWER_ID);
export const labelGid = (repo: Repo, name: string): string => gid('Label', repo.id, name);
export const commentGid = (repo: Repo, number: number, id: number): string => gid('IssueComment', repo.id, number, id);

// -------------------------------------------------------------------------------------------------
// the parser (documents, operations, fragments, values)
// -------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  name: string;
  alias?: string;
  args: { name: string; value: Value }[];
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
  variableDefaults: Map<string, Value>;
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition?: string; selectionSet: SelectionNode[] }>;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): { kind: string; value: string }[] {
  const tokens: { kind: string; value: string }[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: { kind: string; value: string }[];
  constructor(tokens: { kind: string; value: string }[]) {
    this.tokens = tokens;
  }

  private peek(): { kind: string; value: string } | undefined {
    return this.tokens[this.pos];
  }
  private next(): { kind: string; value: string } {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expect(kind: string): string {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, found ${token.value}`);
    return token.value;
  }
  private skip(kind: string): boolean {
    if (this.peek()?.kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition?: string; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as { kind: string; value: string };
      if (token.kind === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet(), variableDefaults: new Map() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | undefined;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, Value>();
        if (this.skip('(')) {
          while (!this.skip(')')) {
            this.expect('$');
            const varName = this.expect('name');
            this.expect(':');
            this.parseTypeRef();
            if (this.skip('=')) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet(), variableDefaults });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name');
        const on = this.expect('name');
        void on;
        const typeCondition = this.expect('name');
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseTypeRef(): void {
    if (this.skip('[')) {
      this.parseTypeRef();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.skip('@')) {
      this.expect('name');
      if (this.skip('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === '(') depth += 1;
          if (token.kind === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.skip('}')) {
      if (this.skip('...')) {
        if (this.peek()?.kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expect('name');
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expect('name');
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expect('name');
    let alias: string | undefined;
    if (this.skip(':')) {
      alias = name;
      name = this.expect('name');
    }
    const args: { name: string; value: Value }[] = [];
    if (this.skip('(')) {
      while (!this.skip(')')) {
        const argName = this.expect('name');
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek()?.kind === '{') selectionSet = this.parseSelectionSet();
    return { name, alias, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === '$') return { kind: 'variable', name: this.expect('name') };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return /[.eE]/.test(token.value) ? { kind: 'float', value: Number.parseFloat(token.value) } : { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === '[') {
      const values: Value[] = [];
      while (!this.skip(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.skip('}')) {
        const name = this.expect('name');
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// the schema (for introspection) and the type references used by it
// -------------------------------------------------------------------------------------------------

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}
const named = (kind: string, name: string): TypeRef => ({ kind, name, ofType: null });
const obj = (name: string): TypeRef => named('OBJECT', name);
const nonNull = (ofType: TypeRef): TypeRef => ({ kind: 'NON_NULL', name: null, ofType });
const listOf = (ofType: TypeRef): TypeRef => ({ kind: 'LIST', name: null, ofType });
const Str = named('SCALAR', 'String');
const IntT = named('SCALAR', 'Int');
const Bool = named('SCALAR', 'Boolean');
const IdT = named('SCALAR', 'ID');

interface FieldDef {
  name: string;
  type: TypeRef;
  args?: { name: string; type: TypeRef; defaultValue?: string }[];
}
interface TypeDef {
  kind: string;
  name: string;
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: { name: string; type: TypeRef }[];
  possibleTypes?: string[];
}

const connectionArgs: FieldDef['args'] = [
  { name: 'first', type: IntT },
  { name: 'after', type: Str },
  { name: 'last', type: IntT },
  { name: 'before', type: Str },
];

const SCHEMA_TYPES: TypeDef[] = [
  {
    kind: 'OBJECT',
    name: 'Query',
    fields: [
      { name: 'viewer', type: nonNull(obj('User')) },
      { name: 'repository', type: obj('Repository'), args: [{ name: 'owner', type: nonNull(Str) }, { name: 'name', type: nonNull(Str) }] },
      { name: 'node', type: obj('Node'), args: [{ name: 'id', type: nonNull(IdT) }] },
      { name: 'rateLimit', type: obj('RateLimit') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: [
      { name: 'createIssue', type: obj('CreateIssuePayload'), args: [{ name: 'input', type: nonNull(obj('CreateIssueInput')) }] },
      { name: 'closeIssue', type: obj('CloseIssuePayload'), args: [{ name: 'input', type: nonNull(obj('CloseIssueInput')) }] },
      { name: 'createPullRequest', type: obj('CreatePullRequestPayload'), args: [{ name: 'input', type: nonNull(obj('CreatePullRequestInput')) }] },
      { name: 'mergePullRequest', type: obj('MergePullRequestPayload'), args: [{ name: 'input', type: nonNull(obj('MergePullRequestInput')) }] },
      { name: 'addComment', type: obj('AddCommentPayload'), args: [{ name: 'input', type: nonNull(obj('AddCommentInput')) }] },
    ],
  },
  { kind: 'INTERFACE', name: 'Node', fields: [{ name: 'id', type: nonNull(IdT) }], possibleTypes: ['User', 'Repository', 'Issue', 'PullRequest', 'Label', 'IssueComment'] },
  {
    kind: 'OBJECT',
    name: 'User',
    fields: [
      { name: 'id', type: nonNull(IdT) },
      { name: 'databaseId', type: IntT },
      { name: 'login', type: nonNull(Str) },
      { name: 'name', type: Str },
      { name: 'email', type: Str },
      { name: 'url', type: named('SCALAR', 'URI') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Repository',
    fields: [
      { name: 'id', type: nonNull(IdT) },
      { name: 'databaseId', type: nonNull(IntT) },
      { name: 'name', type: nonNull(Str) },
      { name: 'nameWithOwner', type: nonNull(Str) },
      { name: 'owner', type: nonNull(obj('User')) },
      { name: 'description', type: Str },
      { name: 'isPrivate', type: nonNull(Bool) },
      { name: 'defaultBranchRef', type: obj('Ref') },
      { name: 'viewerPermission', type: named('ENUM', 'RepositoryPermission') },
      { name: 'hasIssuesEnabled', type: nonNull(Bool) },
      { name: 'hasPullRequestsEnabled', type: nonNull(Bool) },
      { name: 'issue', type: obj('Issue'), args: [{ name: 'number', type: nonNull(IntT) }] },
      {
        name: 'issues',
        type: nonNull(obj('IssueConnection')),
        args: [
          ...connectionArgs,
          { name: 'states', type: listOf(nonNull(named('ENUM', 'IssueState'))) },
          { name: 'orderBy', type: obj('IssueOrder'), defaultValue: '{field: CREATED_AT, direction: DESC}' },
          { name: 'labels', type: listOf(nonNull(Str)) },
        ],
      },
      { name: 'pullRequest', type: obj('PullRequest'), args: [{ name: 'number', type: nonNull(IntT) }] },
      {
        name: 'pullRequests',
        type: nonNull(obj('PullRequestConnection')),
        args: [...connectionArgs, { name: 'states', type: listOf(nonNull(named('ENUM', 'PullRequestState'))) }, { name: 'orderBy', type: obj('IssueOrder') }],
      },
      { name: 'labels', type: obj('LabelConnection'), args: connectionArgs },
      { name: 'createdAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'updatedAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'url', type: nonNull(named('SCALAR', 'URI')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Ref',
    fields: [
      { name: 'name', type: nonNull(Str) },
      { name: 'prefix', type: nonNull(Str) },
      { name: 'target', type: obj('GitObject') },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'GitObject',
    fields: [
      { name: 'id', type: nonNull(IdT) },
      { name: 'oid', type: nonNull(named('SCALAR', 'GitObjectID')) },
      { name: 'abbreviatedOid', type: nonNull(Str) },
    ],
  },
  { kind: 'OBJECT', name: 'RateLimit', fields: [{ name: 'limit', type: nonNull(IntT) }, { name: 'remaining', type: nonNull(IntT) }, { name: 'resetAt', type: nonNull(named('SCALAR', 'DateTime')) }] },
  {
    kind: 'OBJECT',
    name: 'Issue',
    fields: [
      { name: 'id', type: nonNull(IdT) },
      { name: 'databaseId', type: IntT },
      { name: 'number', type: nonNull(IntT) },
      { name: 'title', type: nonNull(Str) },
      { name: 'body', type: Str },
      { name: 'state', type: nonNull(named('ENUM', 'IssueState')) },
      { name: 'author', type: obj('User') },
      { name: 'repository', type: nonNull(obj('Repository')) },
      { name: 'labels', type: obj('LabelConnection'), args: connectionArgs },
      { name: 'comments', type: nonNull(obj('IssueCommentConnection')), args: connectionArgs },
      { name: 'createdAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'updatedAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'closedAt', type: named('SCALAR', 'DateTime') },
      { name: 'url', type: nonNull(named('SCALAR', 'URI')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequest',
    fields: [
      { name: 'id', type: nonNull(IdT) },
      { name: 'databaseId', type: IntT },
      { name: 'number', type: nonNull(IntT) },
      { name: 'title', type: nonNull(Str) },
      { name: 'body', type: Str },
      { name: 'state', type: nonNull(named('ENUM', 'PullRequestState')) },
      { name: 'merged', type: nonNull(Bool) },
      { name: 'mergedAt', type: named('SCALAR', 'DateTime') },
      { name: 'mergeable', type: nonNull(named('ENUM', 'MergeableState')) },
      { name: 'headRefName', type: nonNull(Str) },
      { name: 'baseRefName', type: nonNull(Str) },
      { name: 'headRef', type: obj('Ref') },
      { name: 'baseRef', type: obj('Ref') },
      { name: 'headRefOid', type: named('SCALAR', 'GitObjectID') },
      { name: 'baseRefOid', type: named('SCALAR', 'GitObjectID') },
      { name: 'author', type: obj('User') },
      { name: 'repository', type: nonNull(obj('Repository')) },
      { name: 'files', type: obj('PullRequestChangedFileConnection'), args: connectionArgs },
      { name: 'comments', type: nonNull(obj('IssueCommentConnection')), args: connectionArgs },
      { name: 'createdAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'updatedAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'closedAt', type: named('SCALAR', 'DateTime') },
      { name: 'url', type: nonNull(named('SCALAR', 'URI')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestChangedFile',
    fields: [
      { name: 'path', type: nonNull(Str) },
      { name: 'additions', type: nonNull(IntT) },
      { name: 'deletions', type: nonNull(IntT) },
      { name: 'changeType', type: nonNull(named('ENUM', 'PatchStatus')) },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Label',
    fields: [
      { name: 'id', type: nonNull(IdT) },
      { name: 'name', type: nonNull(Str) },
      { name: 'color', type: nonNull(Str) },
      { name: 'description', type: Str },
    ],
  },
  {
    kind: 'OBJECT',
    name: 'IssueComment',
    fields: [
      { name: 'id', type: nonNull(IdT) },
      { name: 'databaseId', type: IntT },
      { name: 'body', type: nonNull(Str) },
      { name: 'author', type: obj('User') },
      { name: 'createdAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'updatedAt', type: nonNull(named('SCALAR', 'DateTime')) },
      { name: 'url', type: nonNull(named('SCALAR', 'URI')) },
    ],
  },
  ...(['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestChangedFileConnection'] as const).map(
    (name): TypeDef => ({
      kind: 'OBJECT',
      name,
      fields: [
        { name: 'totalCount', type: nonNull(IntT) },
        { name: 'nodes', type: listOf(obj(name.replace('Connection', ''))) },
        { name: 'edges', type: listOf(obj(name.replace('Connection', 'Edge'))) },
        { name: 'pageInfo', type: nonNull(obj('PageInfo')) },
      ],
    }),
  ),
  ...(['IssueEdge', 'PullRequestEdge', 'LabelEdge', 'IssueCommentEdge', 'PullRequestChangedFileEdge'] as const).map(
    (name): TypeDef => ({
      kind: 'OBJECT',
      name,
      fields: [
        { name: 'node', type: obj(name.replace('Edge', '')) },
        { name: 'cursor', type: nonNull(Str) },
      ],
    }),
  ),
  {
    kind: 'OBJECT',
    name: 'PageInfo',
    fields: [
      { name: 'hasNextPage', type: nonNull(Bool) },
      { name: 'hasPreviousPage', type: nonNull(Bool) },
      { name: 'startCursor', type: Str },
      { name: 'endCursor', type: Str },
    ],
  },
  { kind: 'OBJECT', name: 'CreateIssuePayload', fields: [{ name: 'issue', type: obj('Issue') }, { name: 'clientMutationId', type: Str }] },
  { kind: 'OBJECT', name: 'CloseIssuePayload', fields: [{ name: 'issue', type: obj('Issue') }, { name: 'clientMutationId', type: Str }] },
  { kind: 'OBJECT', name: 'CreatePullRequestPayload', fields: [{ name: 'pullRequest', type: obj('PullRequest') }, { name: 'clientMutationId', type: Str }] },
  { kind: 'OBJECT', name: 'MergePullRequestPayload', fields: [{ name: 'pullRequest', type: obj('PullRequest') }, { name: 'clientMutationId', type: Str }] },
  { kind: 'OBJECT', name: 'AddCommentPayload', fields: [{ name: 'commentEdge', type: obj('IssueCommentEdge') }, { name: 'clientMutationId', type: Str }] },
  { kind: 'ENUM', name: 'IssueState', enumValues: ['OPEN', 'CLOSED'] },
  { kind: 'ENUM', name: 'PullRequestState', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  { kind: 'ENUM', name: 'MergeableState', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  { kind: 'ENUM', name: 'RepositoryPermission', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  { kind: 'ENUM', name: 'SearchType', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  { kind: 'ENUM', name: 'IssueOrderField', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  { kind: 'ENUM', name: 'OrderDirection', enumValues: ['ASC', 'DESC'] },
  { kind: 'ENUM', name: 'PullRequestMergeMethod', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  { kind: 'ENUM', name: 'PatchStatus', enumValues: ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED'] },
  { kind: 'INPUT_OBJECT', name: 'IssueOrder', inputFields: [{ name: 'field', type: nonNull(named('ENUM', 'IssueOrderField')) }, { name: 'direction', type: nonNull(named('ENUM', 'OrderDirection')) }] },
  {
    kind: 'INPUT_OBJECT',
    name: 'CreateIssueInput',
    inputFields: [
      { name: 'repositoryId', type: nonNull(IdT) },
      { name: 'title', type: nonNull(Str) },
      { name: 'body', type: Str },
      { name: 'labelIds', type: listOf(nonNull(IdT)) },
      { name: 'clientMutationId', type: Str },
    ],
  },
  { kind: 'INPUT_OBJECT', name: 'CloseIssueInput', inputFields: [{ name: 'issueId', type: nonNull(IdT) }, { name: 'clientMutationId', type: Str }] },
  {
    kind: 'INPUT_OBJECT',
    name: 'CreatePullRequestInput',
    inputFields: [
      { name: 'repositoryId', type: nonNull(IdT) },
      { name: 'baseRefName', type: nonNull(Str) },
      { name: 'headRefName', type: nonNull(Str) },
      { name: 'title', type: nonNull(Str) },
      { name: 'body', type: Str },
      { name: 'clientMutationId', type: Str },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'MergePullRequestInput',
    inputFields: [
      { name: 'pullRequestId', type: nonNull(IdT) },
      { name: 'mergeMethod', type: named('ENUM', 'PullRequestMergeMethod') },
      { name: 'clientMutationId', type: Str },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'AddCommentInput',
    inputFields: [
      { name: 'subjectId', type: nonNull(IdT) },
      { name: 'body', type: nonNull(Str) },
      { name: 'clientMutationId', type: Str },
    ],
  },
  { kind: 'SCALAR', name: 'DateTime' },
  { kind: 'SCALAR', name: 'URI' },
  { kind: 'SCALAR', name: 'GitObjectID' },
  { kind: 'SCALAR', name: 'String' },
  { kind: 'SCALAR', name: 'Int' },
  { kind: 'SCALAR', name: 'Boolean' },
  { kind: 'SCALAR', name: 'ID' },
  { kind: 'SCALAR', name: 'Float' },
];

const TYPE_MAP = new Map(SCHEMA_TYPES.map((t) => [t.name, t]));

/** The introspection __Type object for one type definition (or a bare type reference). */
function typeObject(def: TypeDef): Record<string, unknown> {
  return { __typename: '__Type', def };
}
function typeRefObject(ref: TypeRef): Record<string, unknown> {
  return { __typename: '__Type', ref };
}

// -------------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  errors: { message: string }[];
}

type Source = Record<string, unknown> & { __typename: string };

function viewerSource(): Source {
  return {
    __typename: 'User',
    id: userGid(),
    databaseId: VIEWER_ID,
    login: VIEWER_LOGIN,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    url: `https://github.com/${VIEWER_LOGIN}`,
  };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: IssueState): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: PullState): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

/** Slice a full item list into a connection source honoring first/after. */
function connection(nodeType: string, items: Source[], args: Record<string, unknown>): Source {
  const first = typeof args.first === 'number' ? args.first : 30;
  let start = 0;
  if (typeof args.after === 'string') start = indexFromCursor(args.after) + 1;
  const slice = items.slice(start, start + Math.max(0, first));
  const edges = slice.map((node, i) => ({ __typename: `${nodeType}Edge`, node, cursor: cursorFor(start + i) }));
  return {
    __typename: `${nodeType}Connection`,
    totalCount: items.length,
    nodes: slice,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0]?.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]?.cursor : null,
    },
  };
}

function repoFromGid(forge: Forge, id: string): Repo | null {
  const parts = parseGid(id);
  if (parts === null || parts[0] !== 'Repository') return null;
  const repoId = Number.parseInt(parts[1] as string, 10);
  return forge.listRepos().find((r) => r.id === repoId) ?? null;
}

const resolvers: Record<string, Record<string, (ctx: Ctx, source: Source, args: Record<string, unknown>) => unknown>> = {
  Query: {
    viewer: () => viewerSource(),
    repository: (ctx, _s, args) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoSource(repo);
    },
    node: (ctx, _s, args) => {
      const id = String(args.id ?? '');
      const parts = parseGid(id);
      if (parts === null) return null;
      if (parts[0] === 'Repository') {
        const repo = repoFromGid(ctx.forge, id);
        return repo === null ? null : repoSource(repo);
      }
      if (parts[0] === 'User') return viewerSource();
      if (parts[0] === 'Issue' || parts[0] === 'PullRequest') {
        const repo = ctx.forge.listRepos().find((r) => r.id === Number.parseInt(parts?.[1] as string, 10));
        if (repo === undefined) return null;
        const number = Number.parseInt(parts[2] as string, 10);
        if (parts[0] === 'Issue') {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueSource(repo, issue);
        }
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullSource(repo, pull);
      }
      return null;
    },
    rateLimit: () => ({ __typename: 'RateLimit', limit: 5000, remaining: 4999, resetAt: '2030-01-01T00:00:00Z' }),
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGid(ctx.forge, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const labels: string[] = [];
      if (Array.isArray(input.labelIds)) {
        for (const labelId of input.labelIds) {
          const parts = parseGid(String(labelId));
          if (parts !== null && parts[0] === 'Label') labels.push(parts[2] as string);
        }
      }
      const now = ctx.forge.nowIso();
      const issue: IssueState = {
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: labels.filter((name) => repo.labels.has(name)),
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPullRequest: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = parseGid(String(input.issueId ?? ''));
      if (parts === null || parts[0] !== 'Issue') throw new Error('issue not found');
      const repo = ctx.forge.listRepos().find((r) => r.id === Number.parseInt(parts[1] as string, 10));
      const issue = repo?.issues.get(Number.parseInt(parts[2] as string, 10));
      if (repo === undefined || issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.closedAt = ctx.forge.nowIso();
      issue.updatedAt = issue.closedAt;
      return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGid(ctx.forge, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (repo.branchTip(head) === null || repo.branchTip(base) === null) throw new Error('head or base branch does not exist');
      const now = ctx.forge.nowIso();
      const pull: PullState = {
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
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
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = parseGid(String(input.pullRequestId ?? ''));
      if (parts === null || parts[0] !== 'PullRequest') throw new Error('pull request not found');
      const repo = ctx.forge.listRepos().find((r) => r.id === Number.parseInt(parts[1] as string, 10));
      const pull = repo?.pulls.get(Number.parseInt(parts[2] as string, 10));
      if (repo === undefined || pull === undefined) throw new Error('pull request not found');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      const result = mergePull(ctx.forge, repo, pull, method);
      if ('status' in result) throw new Error('Pull Request is not mergeable');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    addComment: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = parseGid(String(input.subjectId ?? ''));
      if (parts === null || (parts[0] !== 'Issue' && parts[0] !== 'PullRequest')) throw new Error('subject not found');
      const repo = ctx.forge.listRepos().find((r) => r.id === Number.parseInt(parts[1] as string, 10));
      if (repo === undefined) throw new Error('subject not found');
      const number = Number.parseInt(parts[2] as string, 10);
      const issue = repo.issues.get(number);
      const body = String(input.body ?? '');
      const now = ctx.forge.nowIso();
      const comment = { id: repo.nextCommentId, body, createdAt: now };
      repo.nextCommentId += 1;
      if (issue !== undefined) issue.comments.push(comment);
      const node: Source = {
        __typename: 'IssueComment',
        id: commentGid(repo, number, comment.id),
        databaseId: comment.id,
        body,
        author: viewerSource(),
        createdAt: now,
        updatedAt: now,
        url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(0) },
        clientMutationId: (input.clientMutationId as string) ?? null,
      };
    },
  },
  Repository: {
    id: (_c, s) => repoGid(s.repo as Repo),
    databaseId: (_c, s) => (s.repo as Repo).id,
    name: (_c, s) => (s.repo as Repo).name,
    nameWithOwner: (_c, s) => (s.repo as Repo).fullName,
    owner: () => viewerSource(),
    description: (_c, s) => (s.repo as Repo).description || null,
    isPrivate: (_c, s) => (s.repo as Repo).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    createdAt: (_c, s) => (s.repo as Repo).createdAt,
    updatedAt: (_c, s) => (s.repo as Repo).updatedAt,
    url: (_c, s) => `https://github.com/${(s.repo as Repo).fullName}`,
    defaultBranchRef: (_c, s) => {
      const repo = s.repo as Repo;
      const tip = repo.branchTip(repo.defaultBranch);
      if (tip === null) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'GitObject', id: tip, oid: tip, abbreviatedOid: tip.slice(0, 7) } };
    },
    issue: (_c, s, args) => {
      const repo = s.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueSource(repo, issue);
    },
    issues: (_c, s, args) => {
      const repo = s.repo as Repo;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      let items = [...repo.issues.values()];
      if (states !== null) items = items.filter((i) => states.includes(i.state.toUpperCase()));
      items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return connection('Issue', items.map((i) => issueSource(repo, i)), args);
    },
    pullRequest: (_c, s, args) => {
      const repo = s.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullSource(repo, pull);
    },
    pullRequests: (_c, s, args) => {
      const repo = s.repo as Repo;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let items = [...repo.pulls.values()];
      if (states !== null) {
        items = items.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
      }
      items.sort((a, b) => b.number - a.number);
      return connection('PullRequest', items.map((p) => pullSource(repo, p)), args);
    },
    labels: (_c, s, args) => {
      const repo = s.repo as Repo;
      const items = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(
        (label): Source => ({ __typename: 'Label', id: labelGid(repo, label.name), name: label.name, color: label.color, description: label.description }),
      );
      return connection('Label', items, args);
    },
  },
  Issue: {
    id: (_c, s) => issueGid(s.repo as Repo, (s.issue as IssueState).number),
    databaseId: (_c, s) => (s.repo as Repo).id * 100000 + (s.issue as IssueState).number,
    number: (_c, s) => (s.issue as IssueState).number,
    title: (_c, s) => (s.issue as IssueState).title,
    body: (_c, s) => (s.issue as IssueState).body,
    state: (_c, s) => (s.issue as IssueState).state.toUpperCase(),
    author: () => viewerSource(),
    repository: (_c, s) => repoSource(s.repo as Repo),
    createdAt: (_c, s) => (s.issue as IssueState).createdAt,
    updatedAt: (_c, s) => (s.issue as IssueState).updatedAt,
    closedAt: (_c, s) => (s.issue as IssueState).closedAt,
    url: (_c, s) => `https://github.com/${(s.repo as Repo).fullName}/issues/${(s.issue as IssueState).number}`,
    labels: (_c, s, args) => {
      const repo = s.repo as Repo;
      const issue = s.issue as IssueState;
      const items = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((l) => l !== undefined)
        .map((label): Source => ({ __typename: 'Label', id: labelGid(repo, label.name), name: label.name, color: label.color, description: label.description }));
      return connection('Label', items, args);
    },
    comments: (_c, s, args) => {
      const repo = s.repo as Repo;
      const issue = s.issue as IssueState;
      const items = issue.comments.map(
        (comment): Source => ({
          __typename: 'IssueComment',
          id: commentGid(repo, issue.number, comment.id),
          databaseId: comment.id,
          body: comment.body,
          author: viewerSource(),
          createdAt: comment.createdAt,
          updatedAt: comment.createdAt,
          url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
        }),
      );
      return connection('IssueComment', items, args);
    },
  },
  PullRequest: {
    id: (_c, s) => pullGid(s.repo as Repo, (s.pull as PullState).number),
    databaseId: (_c, s) => (s.repo as Repo).id * 100000 + (s.pull as PullState).number,
    number: (_c, s) => (s.pull as PullState).number,
    title: (_c, s) => (s.pull as PullState).title,
    body: (_c, s) => (s.pull as PullState).body,
    state: (_c, s) => {
      const pull = s.pull as PullState;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_c, s) => (s.pull as PullState).merged,
    mergedAt: (_c, s) => (s.pull as PullState).mergedAt,
    mergeable: (ctx, s) => {
      const repo = s.repo as Repo;
      const pull = s.pull as PullState;
      if (pull.state !== 'open') return 'UNKNOWN';
      return computeMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (_c, s) => (s.pull as PullState).headRef,
    baseRefName: (_c, s) => (s.pull as PullState).baseRef,
    headRefOid: (_c, s) => (s.repo as Repo).branchTip((s.pull as PullState).headRef),
    baseRefOid: (_c, s) => (s.repo as Repo).branchTip((s.pull as PullState).baseRef),
    headRef: (_c, s) => refSource(s.repo as Repo, (s.pull as PullState).headRef),
    baseRef: (_c, s) => refSource(s.repo as Repo, (s.pull as PullState).baseRef),
    author: () => viewerSource(),
    repository: (_c, s) => repoSource(s.repo as Repo),
    createdAt: (_c, s) => (s.pull as PullState).createdAt,
    updatedAt: (_c, s) => (s.pull as PullState).updatedAt,
    closedAt: (_c, s) => ((s.pull as PullState).state === 'closed' ? (s.pull as PullState).updatedAt : null),
    url: (_c, s) => `https://github.com/${(s.repo as Repo).fullName}/pull/${(s.pull as PullState).number}`,
    files: (_c, s, args) => {
      const repo = s.repo as Repo;
      const pull = s.pull as PullState;
      const headTip = repo.branchTip(pull.headRef);
      const baseTip = repo.branchTip(pull.baseRef);
      if (headTip === null || baseTip === null) return connection('PullRequestChangedFile', [], args);
      const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
      const fromFlat = flatAtCommit(repo.store, base);
      const toFlat = flatAtCommit(repo.store, headTip);
      const items = diffFlats(fromFlat, toFlat).map((file): Source => {
        const from = fromFlat.get(file.filename);
        const to = toFlat.get(file.filename);
        const oldLines = from === undefined ? [] : linesOf(repo, from.sha);
        const newLines = to === undefined ? [] : linesOf(repo, to.sha);
        const { additions, deletions } = lineDiffCounts(oldLines, newLines);
        const changeType = file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED';
        return { __typename: 'PullRequestChangedFile', path: file.filename, additions, deletions, changeType };
      });
      return connection('PullRequestChangedFile', items, args);
    },
    comments: (_c, s, args) => connection('IssueComment', [], args),
  },
  __Type: {
    kind: (_c, s) => (s.def !== undefined ? (s.def as TypeDef).kind : (s.ref as TypeRef).kind),
    name: (_c, s) => (s.def !== undefined ? (s.def as TypeDef).name : (s.ref as TypeRef).name),
    description: () => null,
    fields: (_c, s, args) => {
      const def = s.def as TypeDef | undefined;
      if (def === undefined || def.fields === undefined) return null;
      void args;
      return def.fields.map((field) => ({
        __typename: '__Field',
        name: field.name,
        description: null,
        args: (field.args ?? []).map((arg) => ({ __typename: '__InputValue', name: arg.name, description: null, typeRef: arg.type, defaultValue: arg.defaultValue ?? null })),
        typeRef: field.type,
        isDeprecated: false,
        deprecationReason: null,
      }));
    },
    inputFields: (_c, s) => {
      const def = s.def as TypeDef | undefined;
      if (def === undefined || def.inputFields === undefined) return null;
      return def.inputFields.map((field) => ({ __typename: '__InputValue', name: field.name, description: null, typeRef: field.type, defaultValue: null }));
    },
    interfaces: () => [],
    enumValues: (_c, s) => {
      const def = s.def as TypeDef | undefined;
      if (def === undefined || def.enumValues === undefined) return null;
      return def.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null }));
    },
    possibleTypes: (_c, s) => {
      const def = s.def as TypeDef | undefined;
      if (def === undefined || def.possibleTypes === undefined) return null;
      return def.possibleTypes.map((name) => typeObject(TYPE_MAP.get(name) as TypeDef));
    },
    ofType: (_c, s) => {
      const ref = s.ref as TypeRef | undefined;
      if (ref === undefined || ref.ofType === null) return null;
      return typeRefObject(ref.ofType);
    },
    specifiedByURL: () => null,
  },
  __Field: {
    type: (_c, s) => typeRefObject(s.typeRef as TypeRef),
  },
  __InputValue: {
    type: (_c, s) => typeRefObject(s.typeRef as TypeRef),
  },
  __Schema: {
    types: () => SCHEMA_TYPES.filter((t) => !t.name.startsWith('__')).map((def) => typeObject(def)),
    queryType: () => typeObject(TYPE_MAP.get('Query') as TypeDef),
    mutationType: () => typeObject(TYPE_MAP.get('Mutation') as TypeDef),
    subscriptionType: () => null,
    directives: () => [],
  },
};

function refSource(repo: Repo, branch: string): Source | null {
  const tip = repo.branchTip(branch);
  if (tip === null) return null;
  return { __typename: 'Ref', name: branch, prefix: 'refs/heads/', target: { __typename: 'GitObject', id: tip, oid: tip, abbreviatedOid: tip.slice(0, 7) } };
}

function linesOf(repo: Repo, sha: string): string[] {
  const object = repo.store.get(sha);
  if (object === undefined) return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Collect the fields of a selection set for one concrete type, expanding fragments. */
function collectFields(document: DocumentNode, selectionSet: SelectionNode[], typeName: string, out: FieldNode[]): void {
  for (const selection of selectionSet) {
    if (selection.kind === 'field') {
      out.push(selection.field);
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        collectFields(document, selection.selectionSet, typeName, out);
      }
    } else {
      const fragment = document.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === undefined || fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        collectFields(document, fragment.selectionSet, typeName, out);
      }
    }
  }
}

function executeSelectionSet(
  ctx: Ctx,
  document: DocumentNode,
  variables: Record<string, unknown>,
  typeName: string,
  source: Source,
  selectionSet: SelectionNode[],
): Record<string, unknown> {
  const fields: FieldNode[] = [];
  collectFields(document, selectionSet, typeName, fields);
  const out: Record<string, unknown> = {};
  // Group by response key so aliased duplicates merge.
  const byKey = new Map<string, FieldNode[]>();
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const list = byKey.get(key) ?? [];
    list.push(field);
    byKey.set(key, list);
  }
  for (const [key, group] of byKey) {
    const field = group[0] as FieldNode;
    out[key] = executeField(ctx, document, variables, typeName, source, field, group);
  }
  return out;
}

function executeField(
  ctx: Ctx,
  document: DocumentNode,
  variables: Record<string, unknown>,
  typeName: string,
  source: Source,
  field: FieldNode,
  group: FieldNode[],
): unknown {
  if (field.name === '__typename') return typeName;
  if (typeName === 'Query' && field.name === '__schema') {
    const merged: SelectionNode[] = group.flatMap((f) => f.selectionSet ?? []);
    return executeSelectionSet(ctx, document, variables, '__Schema', { __typename: '__Schema' }, merged);
  }
  if (typeName === 'Query' && field.name === '__type') {
    const args = argsOf(field, variables);
    const def = TYPE_MAP.get(String(args.name ?? ''));
    if (def === undefined) return null;
    const merged: SelectionNode[] = group.flatMap((f) => f.selectionSet ?? []);
    return executeSelectionSet(ctx, document, variables, '__Type', typeObject(def), merged);
  }
  const typeResolvers = resolvers[typeName];
  const resolver = typeResolvers?.[field.name];
  let value: unknown;
  if (resolver !== undefined) {
    const args = argsOf(field, variables);
    try {
      value = resolver(ctx, source, args);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  } else if (typeName in resolvers || TYPE_MAP.has(typeName)) {
    // A field the type does not define: GraphQL answers 200 with an errors entry.
    if (source[field.name] === undefined && !(field.name in source)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      return null;
    }
    value = source[field.name];
  } else {
    value = source[field.name];
  }
  return completeValue(ctx, document, variables, value, group);
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
  return args;
}

function completeValue(
  ctx: Ctx,
  document: DocumentNode,
  variables: Record<string, unknown>,
  value: unknown,
  group: FieldNode[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, document, variables, item, group));
  if (typeof value === 'object') {
    const source = value as Source;
    const typeName = typeof source.__typename === 'string' ? source.__typename : 'Unknown';
    const merged: SelectionNode[] = group.flatMap((f) => f.selectionSet ?? []);
    if (merged.length === 0) return source;
    return executeSelectionSet(ctx, document, variables, typeName, source, merged);
  }
  return value;
}

// -------------------------------------------------------------------------------------------------
// the HTTP entry
// -------------------------------------------------------------------------------------------------

export interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOne(forge: Forge, body: GraphQLRequestBody): Record<string, unknown> {
  if (typeof body.query !== 'string') {
    return { errors: [{ message: 'No query string was present' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(body.query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation = document.operations.find((op) => operationName === undefined || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const variables: Record<string, unknown> = {};
  if (typeof body.variables === 'object' && body.variables !== null) {
    Object.assign(variables, body.variables as Record<string, unknown>);
  }
  for (const [name, defaultValue] of operation.variableDefaults) {
    if (variables[name] === undefined) variables[name] = resolveValue(defaultValue, variables);
  }
  const ctx: Ctx = { forge, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, document, variables, rootType, { __typename: rootType }, operation.selectionSet);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** Execute a GraphQL request body: one document, or an array of documents answered in order. */
export function handleGraphQL(forge: Forge, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((item) => executeOne(forge, (item ?? {}) as GraphQLRequestBody));
  return executeOne(forge, (body ?? {}) as GraphQLRequestBody);
}
