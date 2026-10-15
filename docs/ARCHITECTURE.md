# Architecture

<!-- Legacy data paths and AGENT_QA_* environment names stay unchanged for compatibility. -->

| Mode | UI and API | Storage | Authentication |
| --- | --- | --- | --- |
| Local | One Node process serves built React and local API routes | SQLite revisions and audio under AGENT_QA_HOME | No sign-in; localhost by default |
| Hosted | React plus Vercel API handlers | Tenant-scoped Upstash Redis; hosted audio storage is not implemented | Signed sessions and role checks |
| Static demo | Built React with sample data | Read-only sample workspace; no server sync | None |

`server/local.mjs` handles local state, history, recordings and gates. It imports
the built `dist-server/lib.mjs` for shared measurements, merging, redaction and
model-backed handlers from `api/`. `src/` contains the interface and `cli.mjs`
exposes local startup and CI commands. Both local and hosted gates use the same
measurement function.

Hosted mode needs QA_SESSION_SECRET and KV_REST_API_URL / KV_REST_API_TOKEN
(or the UPSTASH_REDIS_REST aliases). Model keys remain on the server. Optional
QA_ACCESS_CODE, QA_ALLOWED_IPS and QA_MONTHLY_CALL_CAP restrict access and usage.
Text redaction does not anonymise recordings. See [SECURITY.md](../SECURITY.md).

`npm run build:demo` writes `dist-demo/` with relative asset paths for GitHub Pages.
The demo flag selects a separate read-only store seeded by `src/demo.ts` and
blocks uploads, model calls and evidence fetching. Theme and navigation
preferences may remain in the browser; sample workspace edits are not saved.
The ordinary build and local server retain their existing store behavior.
