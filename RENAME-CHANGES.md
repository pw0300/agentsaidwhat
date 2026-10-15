# Rename to Our Agent Said What?!

The npm package is `agentsaidwhat`. Both `saidwhat` and `agentsaidwhat` execute
`cli.mjs`. Repository metadata points to https://github.com/pw0300/agentsaidwhat;
Compose and the release workflow use `ghcr.io/pw0300/agentsaidwhat`.
The UI, CLI help and package metadata use the requested brand and tagline.
README structure is preserved; its edits are names and a compatibility comment.

## Files changed

- `.claude/launch.json`
- `.github/workflows/release.yml`
- `.gitignore`
- `ADAPTERS-CHANGES.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `Dockerfile`
- `LICENSE`
- `README.md`
- `SHIP-CHANGES.md`
- `action.yml`
- `api/_lib.ts`
- `api/anthropic.ts`
- `api/auth.ts`
- `api/gate.ts`
- `api/health.ts`
- `api/privacy.ts`
- `api/state.ts`
- `benchrun.mjs`
- `cli.mjs`
- `dial-exotel.mjs`
- `docker-compose.yml`
- `docs/ADAPTERS.md`
- `docs/ARCHITECTURE.md`
- `docs/AUTOMATED-RUNS.md`
- `docs/POSITIONING.md`
- `docs/PRIVACY.md`
- `docs/QUICKSTART.md`
- `docs/UX-CHANGES.md`
- `index.html`
- `package-lock.json`
- `package.json`
- `scenarios/README.md`
- `server/local.mjs`
- `server/run.mjs`
- `src/App.tsx`
- `src/LogCall.tsx`
- `src/Settings.tsx`
- `src/api.ts`
- `src/data.ts`
- `src/sync.ts`
- `src/useAutoSimulation.ts`
- `test/adapters.test.mjs`
- `test/ux_fixes.test.mjs`
- `RENAME-CHANGES.md` (this summary).
- `.codex-brief.md` removed from the worktree as requested; it was untracked.

SECURITY.md, CODE_OF_CONDUCT.md, examples/ and the other workflows contained no
old brand names and required no edits. Contact placeholders were left intact.

## Intentionally retained identifiers

Each source definition or group has a one-line compatibility comment.

| Files | Retained values | Reason |
| --- | --- | --- |
| src/App.tsx | `agent-qa-theme`, `agent-qa-tester-mode`, `agent-qa-last-project`, `agent-qa-dense` | Preserve preferences and navigation. |
| src/LogCall.tsx | `agent-qa-log-draft-${agentId}`, `agent-qa-last-agent` | Preserve drafts and agent selection. |
| src/api.ts | `agent-qa-access` | Preserve saved access credentials. |
| src/data.ts | `agent-qa-state-v1` | Preserve browser workspaces. |
| src/sync.ts | `agent-qa-base-v1`, `agent-qa-rev-v1` | Preserve sync snapshots and revision tracking. |
| src/useAutoSimulation.ts | `agent-qa-auto-sim`, `agent-qa-autosim-log` | Preserve simulation preferences and logs. |
| server/local.mjs, server/run.mjs, .gitignore, README.md, CONTRIBUTING.md | `agent-qa-data` (including its audio subfolder) | Reuse existing data and keep it out of git. |
| server/local.mjs, test/adapters.test.mjs | `agent-qa.db` | Open and test the existing SQLite database. |
| server/local.mjs, server/run.mjs, Dockerfile, README.md, docs/ARCHITECTURE.md, docs/QUICKSTART.md, test/adapters.test.mjs, test/cli_local.test.mjs, test/ux_fixes.test.mjs | `AGENT_QA_HOME` | Keep existing deployment configuration and test the same contract. |
| server/run.mjs, docs/ADAPTERS.md | `AGENT_QA_ADAPTER_MODULE` | Keep existing adapter configuration. |
| action.yml | `AGENT_QA_ACTION_PATH`, `AGENT_QA_AGENT`, `AGENT_QA_VERSION` | Preserve action runner environment names. |
| cli.mjs, api/gate.ts (example), README.md, docs/RELEASE-GATE.md, test/cli_evidence.test.mjs, test/cli_gate.test.mjs, test/cli_local.test.mjs and test/gate_contract.test.mjs | `QA_URL`, `QA_TOKEN` | Preserve deployment credentials and CI configuration. |
| api/_lib.ts, api/auth.ts, api/anthropic.ts, api/gate.ts, api/health.ts, api/state.ts, docs/PRIVACY.md, test/gate_contract.test.mjs, test/hosted_hardening.test.mjs | `aq:` Redis prefixes, including tenant keys, users, tenants, memberships, sessions and invites | Preserve hosted data. |
| api/auth.ts (definition and cookie reader) | `aq_session_${tenantId}` cookies | Keep existing authenticated sessions valid. |
| dial-exotel.mjs | `agentqa` provider run tag | Preserve external call-log integration matching. |
| docs/POSITIONING.md | `voice-agent-qa-market-brief.md` | Historical source filename, not a current product name. |
| SHIP-CHANGES.md | Original `Agent QA` author identity, old-name inventory, historical source filename and branding discussion | Preserve the earlier shipping report as a historical record, marked by a one-line comment. |
| Git metadata and commit authorship | Original worktree path and the requested `Agent QA <agent@local>` identity | Git bookkeeping and the explicitly requested author identity are not product branding. |

All other environment variables, cookie names, storage paths, volumes and Redis
keys also remain unchanged. This report quotes legacy names only to document why
they remain. Existing user data and historical records are not rewritten.

## Validation

- `npm test`: 556 passing, 0 failing across 49 files.
- `npx tsc -b`: passed.
- `npx tsc -p tsconfig.api.json`: passed.
- Action, Compose and release workflow YAML parse successfully.
- Package metadata confirms `agentsaidwhat@0.2.0` and both `saidwhat` and
  `agentsaidwhat` bins pointing to `cli.mjs`.
- Audited 15 legacy storage key/path definitions across eight source files;
  all are still present.
- `npm pack --dry-run`: passed, including the prepack production build;
  package name `agentsaidwhat`, archive `agentsaidwhat-0.2.0.tgz`.
- `git diff --check`: passed.

No package, container or release was published. Unrelated `codex-run.log` and
`docs/assets/` worktree files were left untouched and outside this commit.
