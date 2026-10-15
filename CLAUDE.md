# CLAUDE.md

Guidance for working in this repo (branch `feat/npm-skill`: Node/TypeScript rewrite, npm package `feyagate`).

## What this repo is

- `skill/` — the agent skill (SKILL.md + references/). Host-agnostic. This folder alone is the Agensi upload (`npm run pack:skill`).
- `src/` — the `feyagate` CLI: installs, upgrades, supervises the `miloco-mcp-server` engine and runs a stdio MCP bridge.
- `manifest/server-manifest.json` — pinned engine assets + sha256 from `toddpan/miloco-mcp-server-releases`. Regenerate with `npm run manifest` (script copied from `app/dsh-feyagate`).

Download/extract/verify/config-gen modules are ported from `app/dsh-feyagate/src` (see its ADR-0004). Keep fixes in sync with that repo.

## Commands

```bash
npm install
npm test            # tsc build + node:test with a fake engine (no network)
npm run typecheck
npm run pack:skill  # Agensi pre-flight + dist/feyagate-skill-<v>.zip
```

## Invariants

- Nothing downloads, installs, deletes or edits host config without `--yes` (exit code 3 otherwise). `doctor`, `status`, `upgrade --check` and `mcp` never download.
- Only sha256-pinned assets install unless `--allow-unverified`.
- `versions/<v>/` is immutable. Activation sets `pending` → `/health` → `confirmHealthy`. On failure, roll back to `lastKnownGood`.
- `config.yaml` and `data/` stay at the install root (`~/.feyagate-mcp` or `$FEYAGATE_HOME`). The engine binds license and device id to that directory.
- Passwords are only read in an interactive TTY (`feyagate auth midea|ewelink|huawei`), never accepted as CLI arguments. `call auth/*_login` is refused.
- `--json` prints exactly one JSON object on stdout; logs go to stderr. The stdio bridge must never write non-protocol text to stdout.

## Version management

Bump the version in both `package.json` and the `skill/SKILL.md` frontmatter (pack-skill checks that they match).
