# mini-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Fan-Fan-F/mini-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Fan-Fan-F/mini-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge written from scratch in TypeScript, standard library only: git smart HTTP (protocol v0 and v2, shallow fetch, packfiles in and out), the REST v3 API (repos, contents, branches, issues, labels, pull requests with three-way merges), a GraphQL endpoint with introspection and cursor pagination, and an MCP endpoint — all four surfaces over one in-memory object store, with a deterministic logical clock.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=dev-token node main.ts
```

The entry binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, and serves until the env says the trial is done. `MAKEFUN_SHOP_TOKEN` is the bearer token every API surface checks.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fvne2t1t&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
