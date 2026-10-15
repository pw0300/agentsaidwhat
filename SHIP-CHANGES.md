# Shipping changes

<!-- Historical shipping report: original names, author identity and inventory are retained as a record of that earlier release work. -->

Completed the seven brief items in seven separate commits, using Agent QA
<agent@local>, followed by this summary and cleanup commit. The package name and
version were not renamed. No publication or external deployment was performed.

## What was built

1. Real YAML parsing with the runtime yaml dependency, required format version 1,
   explicit unknown-version errors and optional validated callerTurns. Converted
   all three packs to readable YAML and updated their documentation and tests.
2. A v1 gate result JSON Schema and stability rules. Tests validate actual local
   HTTP, CLI JSON and hosted handler results, including the hosted signed receipt.
3. A multi-stage Node 22 slim Docker image running as the node user, with /data
   persistence, a health check and localhost-only Compose port exposure.
4. A tag-driven npm/GHCR/GitHub release workflow, changelog and package allowlist.
   Prepack builds the local UI and server. Existing no-argument CLI startup was
   verified; help reads the package name from package.json.
5. A separate static demo build with sample data, the requested banner, a
   read-only workspace and disabled server actions with explanations. It has no
   API sync, model calls or upload requests. Added the GitHub Pages workflow.
6. A documentation index and guides for quickstart, logging, automated runs,
   scenarios, gates, architecture, metrics and research. Moved UX-CHANGES.md into
   docs and linked its complete keyboard reference from the logging guide.
7. Fifteen scoped starter tasks with acceptance criteria, a now/next/later
   roadmap and actionable missing-key messages in handlers, judge results,
   Settings, CLI help and local startup. Messages name the environment variable
   and explain that manual logging, scoring, triage and evidence gates still work.

Also corrected the existing render build to use test/ui-entry.tsx and output
_ui-ux.mjs, matching the UI tests' component exports and expected filename.
CLI command logic was preserved; only help text changed. The existing default
startup already behaved as requested.

## Package audit

Final npm pack dry-run: **330,742 bytes compressed** (330.7 kB), **1,032,081 bytes
unpacked**, **68 files**. The normal dry-run ran prepack successfully; a second
dry-run with scripts skipped produced clean machine-readable metadata from the
same built artifacts.

Included: cli.mjs, package.json, built dist/ with HTML/JS/CSS and robots.txt,
dist-server/lib.mjs, server/, api/, all three YAML packs and scenarios/README.md,
docs including the gate schema, CHANGELOG.md, ROADMAP.md, README and contributor,
security, conduct and licence documents.

Excluded: data/, parquet, audio, node_modules, source UI, tests, examples/, bench/,
tools/, demo build output, GitHub/private configuration, brief and run log.
SHIP-CHANGES.md is a repository report, outside the package allowlist.

A real tarball was installed into a temporary directory with production
dependencies. Its installed CLI with no arguments printed a URL and served the
local UI and healthy /api/health endpoint. No global package was installed.

## Package name inventory

New user guides use <pkg>, defined once in docs/QUICKSTART.md as package.json's
name; the executable is its bin key. CLI help reads the name dynamically. Release
notes read package.json's version and repository metadata. The GHCR image name
comes from the GitHub repository, so the new workflows and Docker files do not
hardcode the published package or CLI name.

The following is the complete tracked-file inventory of the literal agent-qa
name, including legacy storage identifiers and filename fragments. Existing
occurrences were preserved, as requested:

| File | Occurrences and purpose |
| --- | --- |
| package.json | name and bin key |
| package-lock.json | top-level name, root package name and bin key |
| README.md | quickstart npx command; local audio folder; npx startup/help sentence; gate command; composite action repository placeholder; readiness command |
| CONTRIBUTING.md | local data folder |
| cli.mjs | header description and three header command examples; rendered help derives the name dynamically |
| server/local.mjs | header name and npx example; database path comment; default-folder comment; SQLite filename; default home folder; startup label |
| .gitignore | local data folder exclusion |
| .claude/launch.json | development launch configuration name |
| api/privacy.ts | export download filename prefix |
| src/Settings.tsx | backup download filename prefix |
| src/App.tsx | theme, tester-mode, last-project and dense-mode browser keys, including their reads and writes |
| src/LogCall.tsx | draft key and last-agent browser key reads/writes |
| src/api.ts | access-code browser key |
| src/data.ts | workspace browser key |
| src/sync.ts | base snapshot and revision browser keys |
| src/useAutoSimulation.ts | automatic simulation preference and log browser keys |
| docs/POSITIONING.md | historical voice-agent-qa-market-brief.md filename reference |
| SHIP-CHANGES.md | this inventory and its literal-name description |

For publication, update name and bin together in package.json and refresh the
lockfile. Review the old README commands, CLI/server comments and startup label.
Storage keys, database filenames and export prefixes are compatibility choices;
changing them needs migration planning. Product display text such as Agent QA
is branding, separate from the npm identifier. No names were changed here.

## Validation

- npm test: **481 passing, 0 failing across 34 files**.
- npx tsc -b and npx tsc -p tsconfig.api.json: passed.
- npm run build and npm run build:demo: passed.
- Actual installed tarball startup, UI and health endpoint: passed.
- Compose and both new workflow YAML files: parsed successfully.
- New guide links: resolved except the explicitly pending ADAPTERS.md link.
- git diff --check: passed.

Local checks used Node 26.7.0. The container and release workflow target Node 22;
the existing CI matrix covers Node 22 and 24. No live provider calls were needed.

## Pending and limits

All requested implementation items are complete. Docker is unavailable on this
machine, so the image was not built or run locally. The release workflow includes
a container smoke test before publication. GitHub workflows were not executed
against a remote repository, and nothing was published or deployed.

Before publishing, a maintainer must choose an available npm name (the current
name is taken), set the repository URL placeholder, configure NPM_TOKEN and
enable GitHub Pages with GitHub Actions as its source. Contact and repository
placeholders remain placeholders. The current package version stays 0.2.0; the
requested 0.1.0 changelog entry is a clearly labelled retrospective baseline.

ADAPTERS.md is reserved for the other worker and remains an explicitly pending
link. External pack UI import, live voice adapters, hosted audio storage and
unmeasured metrics remain documented limitations. The demo cannot save workspace
changes, though ordinary browser theme/navigation preferences may persist.

Protected examples/, bench/, tools/ and data/ were not changed. The brief and
codex-run.log were kept until this final summary and cleanup commit, then removed.
