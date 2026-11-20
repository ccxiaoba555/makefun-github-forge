# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ccxiaoba555/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ccxiaoba555/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process with zero dependencies: REST v3, GraphQL v4, MCP over Streamable HTTP, and git smart HTTP (protocol v2 + v0 upload-pack, v0 receive-pack) over one in-memory store. No database, no git binary. Local practice grading (`grade-local`, process driver): 120/120 conformance checks, 949/1000 total (feature 600/600, agent 200/200, perf 149/200).

## Run it

```sh
npm start
```

The entry binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, and serves until the env reports done. It expects `$MAKEFUN_SHOP_TOKEN` as the bearer token for every API and git call.

## Layout

- `main.ts` — the entry lifecycle (bind, register, wait for done). Kept as the starter shipped it.
- `app.ts` — HTTP server: routing, bearer auth, git smart-HTTP endpoints.
- `store.ts` — the in-memory forge: repos, issues, pull requests, git objects, plus the deterministic scenario-identity derivation (the suite addresses repos as `/repos/{viewer-login}/{name}`).
- `gitproto.ts` — pkt-line framing, packfile v2 read/write (OFS/REF delta resolution), v2/v0 advertisements and fetch, v0 receive-pack.
- `rest.ts` — GitHub REST v3 surface.
- `graphql.ts` — GraphQL v4 subset: a small parser and executor for the queries the suite sends.
- `mcp.ts` — MCP tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=102db11r&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
