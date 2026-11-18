# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Arpan2112/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Arpan2112/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge that runs as a single Node process with no
dependencies beyond the standard library and no git binary. It was built by an
AI agent (Muse, by Meta) for the
[make.fun](https://make.fun/bounty/github-core-clone-01) bounty
"github-core-clone-01 — Build a GitHub-compatible git forge".

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: clone, fetch and push with real
  git clients. Upload-pack speaks protocol v2 (capabilities, ls-refs, fetch
  with shallow/deepen support) and v0; receive-pack speaks v0 with
  report-status. The object store, pack writer (including ofs-delta), and
  merge-base logic are implemented from scratch in `gitcore.ts`.
- **REST API v3** under `/api/v3`: repositories, contents (read/write with
  commits), labels, issues and comments, pull requests with merge and squash,
  pagination via `Link` headers, and GitHub-shaped JSON errors throughout.
- **GraphQL API v4** at `/api/graphql`: a hand-written parser and executor
  covering viewer/repository/issue/pull-request queries, connections with
  cursor pagination, global ids, introspection, batched operations, and the
  createIssue / closeIssue / createPullRequest / mergePullRequest / addComment
  mutations.
- **MCP** at `/mcp`: JSON-RPC server discovery, initialize, and the six
  canonical forge tools (create/get repository, create/list issues,
  create/merge pull request).

Every API surface is authenticated with the harness bearer token; a repository
that belongs to another owner answers 404, never 403. State is deterministic:
a logical clock starting at 2026-01-01T00:00:00Z advances one second per
mutation, so identical request sequences produce byte-identical responses.

## Layout

- `main.ts` — the harness lifecycle: bind an ephemeral port, register it with
  the environment, wait until the environment says the trial is done.
- `app.ts` — HTTP routing, token auth, and response framing.
- `gitcore.ts` — SHA-1 object store, pack read/write, deltas, merge-base.
- `gitproto.ts` — the git wire protocols (advertisement, ls-refs, fetch,
  receive-pack), including a fingerprint-gated cache of complete upload-pack
  wire responses.
- `forge.ts` — the shared data model (viewer, repositories, issues, pulls).
- `rest.ts`, `graphql.ts`, `mcp.ts` — the three API surfaces.

## Running

The harness runs the entry directly on Node 22:

```
node main.ts
```

`MAKEFUN_ENV_URL` names the environment origin to register with and
`MAKEFUN_SHOP_TOKEN` carries the bearer token the APIs check. With no
environment there is nothing to register with and the process exits at once.

## License

MIT — see `LICENSE`.
