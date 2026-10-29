# 📦 Asset Library

![Preview](./docs/images/main-overview.png)

A simple **self-hosted asset library** for your game development needs, available as a simple selfhostable docker container:

- ⬆️ Uploading assets:
  - 🔊 audio
  - 🖼️ textures
  - ✨ shaders
  - 📜 scripts
  - 🧊 3D models
- 🗂️ Storing metadata:
  - 🏷️ title
  - 🔖 tags
  - 📅 upload date
  - 📝 description
  - ⚖️ license
  - 🔗 source
- 👀 Asset previews for 3D models, audio and text/code
- 🤖 AI integration, which automatically tags/describes imported files (audio, textures, shaders, scripts)
- ⬇️ Downloading / 🔁 Replacing assets
- 🔎 Strong filtering and searching functionalities
  - 🏷️ Filtering by tag, type, ...
  - ↕️ Many sorting options
  - 🧠 Fuzzy search using Fuse.js

- 🧬 File deduplication using hashes
- 📁 Configurable SQLite or PostgreSQL metadata storage (SQLite by default)

🚧 Currently not available

- Per-user libraries, local password accounts and role-based permissions

# 🚀 Quick Start

The recommended way to run the app is using **Docker Compose**. Just copy the following into a `docker-compose.yml` file in your project root:

```yaml
services:
  asset-library:
    image: ghcr.io/kellojo/asset-library:latest
    environment:
      - ORIGIN=http://localhost:3000 # Adjust if using a domain or reverse proxy
      - PUBLIC_UPLOAD_PARALLELISM=4 # Number of files uploaded in parallel from the UI (default: 4)
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

Then run:

```bash
docker-compose up -d
```

The app will be available on port 3000, ready to accept your uploads!

`BODY_SIZE_LIMIT` controls the maximum upload/request size for the app. The default is set to 1GB, which should be sufficient for most assets. You can adjust this via an environment variable if you need to allow larger or smaller uploads. To do so set the `BODY_SIZE_LIMIT` environment variable in your `docker-compose.yml`.

`PUBLIC_UPLOAD_PARALLELISM` controls how many files are uploaded in parallel by the UI upload queue. The default is `4` (parallel uploads). Set it to a higher value to process multiple files at once.

Please run this behind a reverse proxy and do not expose this directly on the internet without proper authentication!

In case you obsere failing requests when uploading large files, make sure that your reverse proxy allows uploading files of that size.

# 🗄️ Storage Layout

At runtime the app creates a `data/` directory in the project root:

- `data/assets.db`: SQLite metadata database
- `data/ai-config.json`: AI metadata generation configuration (optional)
- `data/uploads/`: uploaded files

This keeps setup **very small and easy to back up**.

If a legacy `data/assets.json` exists, it is automatically migrated into SQLite on first startup.

# ✨ AI Metadata Generation

![Preview](./docs/images/ai-setup.png)

You can connect **AI metadata generation** from the UI:

1. Open the app and click `AI` in the top bar
2. Enable auto-tagging
3. Set base URL (default `http://127.0.0.1:1234`)
4. Set the model name loaded by your AI endpoint
5. Save

The app sends upload metadata to your AI endpoint using the **OpenAI-compatible API**:

- `POST /v1/chat/completions`

For best results choose an AI model that supports image and audio inputs, so that it can analyze the content of your assets and generate relevant tags and descriptions. Additionally, thinking models with good reasoning capabilities can provide more accurate and detailed metadata.

Models that have been tried:

- qwen/qwen3.5-9b
- mistralai/devstral-small-2-2512

### ⚙️ Configure via `.env` or `ai-config.json`

You can configure **AI metadata** via `.env` or `ai-config.json` instead of the UI.

Place this config in `data/ai-config.json`:

```json
{
  "enabled": true,
  "baseUrl": "http://192.168.178.21:1234",
  "model": "qwen/qwen3.5-9b",
  "apiKey": "",
  "timeoutMs": 120000,
  "temperature": 0.2,
  "disableThinking": false,
  "reasoningEffort": "low",
  "customInstruction": ""
}
```

### Supported variables

- `AI_ENABLED` (`true` / `false`)
- `AI_BASE_URL` (e.g. `http://127.0.0.1:1234`)
- `AI_MODEL` (loaded model name)
- `AI_API_KEY` (optional 🔑)
- `AI_CONFIG_READONLY` (`true` / `false`, default `false`; reject UI/API changes when server-managed)

- `AI_TIMEOUT_MS` (e.g. `12000`)
- `AI_TEMPERATURE` (e.g. `0.2`, range `0` to `2`)
- `AI_DISABLE_THINKING` (`true` / `false`, forces `reasoningEffort=none`)
- `AI_REASONING_EFFORT` (`none` | `minimal` | `low` | `medium` | `high` | `xhigh`)
- `AI_CUSTOM_INSTRUCTION` (optional prompt addition ✏️)

The settings API never returns the API key. An empty API key in a settings update
keeps the existing file key. To remove a file key, clear it in `data/ai-config.json`.
Environment overrides are used at runtime and are never copied into that file.
For shared instances, set `AI_CONFIG_READONLY=true` alongside your secret-backed
`AI_API_KEY` to prevent users from changing the destination of AI requests.

# Native OpenID Connect login

Set `AUTH_MODE=oidc` with `ORIGIN`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and a
secret-managed `OIDC_CLIENT_SECRET`. Register the exact callback
`<ORIGIN>/auth/callback` at Authentik (or another conforming OIDC provider), using
a confidential authorization-code client, PKCE and asymmetric ID-token signing.
The app performs its own login and session validation; a forward-auth proxy is
not required. `AUTH_MODE=none` preserves the original self-hosted behavior.
Incomplete or invalid native-auth configuration fails closed.

Login uses fresh state, nonce and S256 PKCE. Issuer, audience, expiry and ID-token
signatures are verified. Transactions are single-use with a ten-minute expiry.
The app discards provider tokens after login, stores only minimal identity data
and a hash of a random session ID in the selected database, and sends the ID in
an HttpOnly/SameSite=Lax cookie. HTTPS deployments use host-only `__Host-` Secure
cookies. Sessions survive restarts and expire at the earlier of ID-token expiry
or `OIDC_SESSION_MAX_AGE_SECONDS` (default one hour, maximum eight hours).

IdP application policies must restrict the intended users/groups. Optionally set
`OIDC_ALLOWED_GROUPS` to a comma-separated allow-list of signed `groups` claims
for an additional app-side restriction. Do not use an email display value as an
identity/permission check. All admitted users still share the library and its
editing/deletion rights: native identity does not add per-user asset isolation.
Group/user revocation is bounded by session expiry; back-channel logout is not
implemented. POST-only, same-origin Sign out invalidates the local app session
and displays a signed-out page, leaving other IdP/SSO application sessions alone.

Authenticated data routes deny anonymous requests, including downloads and
thumbnails. `/auth/check` returns a minimal JSON session verdict for a trusted
private edge checker. It reports `authenticated: false` when native auth is off,
so a native-session edge policy cannot accidentally fail open into proxy mode.
Keep health/edge-check access private as appropriate for your ingress.

For Authentik behind cluster ingress, `OIDC_INTERNAL_ORIGIN` can send server-side
discovery/token/JWKS requests through its private service while retaining and
validating the public HTTPS issuer. Only the configured issuer origin and
`/application/o/` paths are eligible. A private HTTP hop relies on network
isolation; do not use it over an untrusted network. Native login normally requires
HTTPS. `OIDC_ALLOW_HTTP_LOCALHOST=true` permits HTTP only when both issuer and app
origins are loopback/localhost, for isolated development tests.

Authentication tables are created on either backend. The SQLite-to-PostgreSQL
metadata migration does not copy login transactions or sessions; users sign in
again after a backend switch. Keep database credentials and OIDC credentials in
your deployment secret manager, never in source or browser configuration.

# PostgreSQL and SQLite

Set `DATABASE_BACKEND=sqlite` (the default) to use `data/assets.db`, or
`DATABASE_BACKEND=postgres` plus a secret-managed `DATABASE_URL` for PostgreSQL.
An invalid backend or missing PostgreSQL URI fails explicitly; there is no silent
fallback. Database queries use bound parameters with both backends.
Use a TLS-verified URI (`sslmode=verify-full&sslrootcert=/path/to/ca.crt`) outside
an isolated local development environment. Connection strings must not be committed.

The database stores metadata. Uploaded files and AI settings still live under
`data/`, so back up the files and metadata consistently. PostgreSQL alone does not
make the application safe to run with multiple replicas or provide S3 storage.

To migrate an existing SQLite library:

1. Stop application writers and back up `data/` and the target PostgreSQL database.
2. Supply `DATABASE_URL` securely through your environment, then run
   `node scripts/migrate-sqlite-to-postgres.mjs /path/to/data/assets.db` with Node 24+.
3. The migration opens SQLite read-only, requires an empty PostgreSQL assets table,
   and copies all metadata in one transaction. It verifies every copied field
   before committing. It refuses a nonempty target; rerunning does not overwrite it.
4. Preserve the same uploaded files, set `DATABASE_BACKEND=postgres`, and start
   the app. Check counts, previews, downloads, edits and backups before retiring
   the SQLite copy. The tool does not copy files or change the source database.

SQLite's older `assets.json` import remains supported. Switching database backends
does not automatically import SQLite; use the explicit migration above.

# Server-generated thumbnails and ThumbHash

Image uploads generate a small WebP thumbnail and a compact ThumbHash placeholder
on the server. Cards load the thumbnail rather than the original. GIF/animated
images use the first frame; undecodable or oversized images retain their existing
preview fallback. Decoding is limited to 64 megapixels and five seconds.

3D posters are also generated on the server from the uploaded model bytes. Run
the separate `thumbnail-renderer` Docker target, then set `MODEL_THUMBNAIL_URL`
on the app to its private service URL. It supports self-contained GLB/GLTF, OBJ,
STL and FBX. Missing external textures/buffers, unsupported formats, unavailable
renderers, models over 64MiB and timed-out renders fall back gracefully. Neither
posters nor hashes can be submitted through the public API: the thumbnail route
is read-only, and metadata edits cannot set the hash.

The renderer must be isolated from the app: no credentials, no uploaded-file
volume, no service-account token, read-only root filesystem, temporary scratch
space, and no network egress. Allow ingress only from the application. Chromium
uses software rendering and runs without its own sandbox for container
compatibility, so this separate workload isolation is required. Browser routing,
CSP and loader rules also block model references to network resources. Each job
gets a fresh browser and a 30-second deadline; renderer concurrency is one.
Do not expose its `/render` endpoint to users.

Thumbnail files live beside originals as `.thumbnail.webp` sidecars; the database
stores their ThumbHash. Replacements regenerate them; deletion removes both files.
Existing database schemas gain a nullable `thumbhash` column automatically.
In maintenance mode, run `node scripts/backfill-thumbnails.mjs` from the library's
working directory with the same database/renderer settings to process existing
assets. Backfill skips files over 64MiB and reports unavailable/unsupported files.
Preserve thumbnail sidecars when copying uploaded files during a database migration.

Audio keeps its waveform preview, and code/text keeps its text preview. Those
have no raster placeholder to hash. Live 3D viewing loads only after choosing Explore 3D; cards otherwise use the
server poster; if rendering fails in the browser, the server poster stays visible.

# Privacy and security

Production model workers require kernel-level egress isolation. The
`renderer-network-guard` image installs IPv4/IPv6 output rules in the pod network
namespace as a trusted, short-lived `NET_ADMIN` initializer. The renderer then
runs without capabilities. Loopback and replies to existing connections are
allowed; new outbound connections are dropped. This also works on Flannel,
which does not itself enforce Kubernetes NetworkPolicies.

Set `RENDERER_REQUIRE_SIGNATURE=true` and `RENDERER_PUBLIC_KEY` (base64 DER/SPKI
Ed25519) on the worker. Set `MODEL_THUMBNAIL_SIGNING_KEY` (base64 DER/PKCS8) only
on the app. The worker holds only a public verification key. Requests bind the
body bytes, format, method/path, timestamp and a single-use nonce. Unsigned,
tampered, stale and replayed requests are rejected before model decoding.
Keep the private signing key in your secret manager; use SOPS for GitOps.

Icons and fonts are bundled locally. There is no analytics or error-reporting
service in the app. The browser CSP permits connections only to the app's origin;
3D previews reject references to remote resources. AI SDK telemetry and input/output
recording are explicitly disabled. AI requests still send the selected asset content
to the endpoint you configure for metadata generation; disabling telemetry does not
make a cloud AI provider local. Set `AI_ENABLED=false` to disable AI requests.

All library users share modification rights; deploy behind authentication and an
explicit access policy. AI settings should be locked with `AI_CONFIG_READONLY=true`
when a gateway credential is injected through the environment. Uploaded file
responses are sandboxed, MIME sniffing is disabled, API responses are not publicly
cached, source links allow only HTTP(S), and cross-origin mutations are rejected.

Node 24 LTS is the container/CI runtime. Runtime and build dependencies are pinned
in the manifest and lockfile. TypeScript stays on 6 because the current framework
and checker require it; Node types track the supported Node 24 runtime.
Run `npm run check` and `npm test`. Set `TEST_CHROMIUM_PATH` to a Chromium binary
to include the actual server-rendered model test. Set `TEST_DATABASE_URL` to a dedicated disposable
PostgreSQL database to include PostgreSQL tests (these tests delete its assets).
CI runs both backends. `npm audit` checks known advisories, not every security risk.
CI enforces `npm audit --omit=dev` and scans both runtime images with Trivy,
rejecting fixable HIGH/CRITICAL findings. Runtime images omit npm, npx, Corepack
and Yarn after dependency installation.

As of 2026-10-28, full development audits also report
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
in `deepmerge@4.3.1`, through the Svelte Vite plugin. No patched release is
published. It merges trusted build configuration and is absent from production
dependencies. Do not feed untrusted configuration to the build. Track the upstream
fix rather than following npm's suggested downgrade to pre-release SvelteKit.

# Artifact versions and change history

Open an asset's metadata dialog and choose **Version History** to see every
recorded file and metadata update, newest first. Entries include the version number,
change number, timestamp, authenticated author, optional note, full metadata,
SHA-256, server preview when available, and a download of the exact historical bytes.
History is paginated and survives restarts on both SQLite and PostgreSQL.

When an upload matches an existing filename (case-insensitive) or content hash,
choose its target asset and either **Save New Version** or **Replace Current**:

- New Version increments the file version number.
- Replace Current retains the version number and records a replacement event.
- Both preserve previous bytes and previews in history, and retain existing metadata.
- Cancel Upload leaves the existing asset unchanged.

To update an asset with a differently named file, use **Upload File Update** in its
metadata dialog; the same decision is required. Multiple matching assets require
an explicit target selection. Concurrent changes cause a conflict instead of
silently overwriting a reviewed revision. Metadata edits create their own change
entries without increasing the file version number. Existing installations receive
a baseline of their currently available state; earlier deleted files cannot be
reconstructed. Unauthenticated installations record a null author, never an invented
identity. Full history consumes storage; no automatic history pruning is enabled.
Deleting an entire asset deletes all of its revisions and stored files; the existing
confirmation explicitly says so. There is no separate historical-delete API.

`GET /api/assets/{id}/versions?offset=0&limit=50` lists history. Returned revision
links address `/api/assets/{id}/versions/{revision}/{download,file,text,thumbnail}`.
All routes retain authentication, sandboxing and private cache policy. Revision
numbers identify immutable snapshots; version numbers describe file releases.
`POST /api/assets` returns `409 upload_conflict` with candidate assets and latest
revisions when an upload needs a decision. To save an update, submit `targetAssetId`,
`mode` (`replace` or `new-version`), and `expectedRevision` together, plus an optional
`note`. Stale decisions return `409 revision_conflict`. The legacy file PATCH route
defaults to preserving a new version when no mode is supplied. SQLite-to-PostgreSQL
migration now copies and verifies history as well as current metadata; stored files
must still be transferred separately in maintenance mode.
UI and WebMCP metadata updates use `POST /api/assets/{id}`, sharing the exact PATCH
handler. File updates use `POST /api/assets` with the explicit target/version decision.
This works with ingress policies that permit POST but reject PATCH; all requests
still pass the existing WAF, authentication and same-origin mutation checks.
The confirmed UI delete action uses `POST /api/assets/{id}/delete` with an explicit
JSON action; the legacy DELETE API remains available.
Recovery tests take a real SQLite backup with its coordinated upload files, restore
it into a separate app, and also migrate that backup into an isolated PostgreSQL
schema in CI. Both old and current downloads are verified after restoration.

# WebMCP and Codex

The library registers seven imperative WebMCP tools in the active, top-level page:
`asset_library_search`, `asset_library_get_asset`, `asset_library_read_text`,
`asset_library_show_asset`, `asset_library_update_metadata`, and
`asset_library_import_text`, and `asset_library_history`. Search/history are paginated (maximum 50 results), text previews
are capped at 10,000 characters, and text imports at 256 KiB UTF-8. Binary files,
3D assets and animations use the existing file picker. There is no agent delete
tool or tool for credentials/AI configuration. Metadata and file text are untrusted
content, explicitly marked as such in tool annotations.

Open the library in Codex's built-in browser, sign in through the normal OIDC flow,
and enable Site Tools in Browser Permissions if available for your account/workspace.
Then ask Codex to use the library tools, for example: “Find the model assets tagged
vehicle and open the first preview.” No separate MCP server or token is required.
See [OpenAI's WebMCP instructions](https://learn.chatgpt.com/docs/webmcp).
Codex CLI and external-browser automation do not automatically gain these tools;
the consumer must support WebMCP. Unsupported browsers show a dismissible setup
toast once per tab session, with a setup-guide button; working support is silent.
Browser API availability alone does not prove an agent consumer is enabled.

The implementation prefers `document.modelContext` and supports the older
`navigator.modelContext` registration API. Browsers without WebMCP retain the normal
UI. Tools reuse same-origin authenticated APIs; no tokens are exposed to agents.
They are removed on navigation/logout, and pending requests are aborted. Metadata
updates preserve omitted fields and require a real license. Uploads may trigger the
configured AI metadata integration, just like uploads through the UI.
History is readable through WebMCP; text imports can update an explicitly selected
asset using `targetAssetId`, `mode` and `expectedRevision` after the user chooses
replacement or a new version. Conflicts return candidate metadata and the current
revision; tools must not infer replacement permission from a conflicting filename.
Native Chromium WebMCP discovery/invocation, OIDC gating, mutations, validation,
session expiry and the unsupported-browser path are exercised in browser tests.

# Contributing

Contributions are very welcome! Just fork the repo and open a PR with your changes.
This can be anything from bug fixes, new features, or even just improving documentation.

Roadmap:

- Bulk actions (tagging, deleting, downloading)
- Metadata generation for 3D models
- Add support for more file types (e.g. video, fonts, ...)
- Per-user libraries and role-based permissions
- Improved infinite scrolling/padination for large libraries
- Better responsiveness for mobile devices

## 🛠️ Development

To run the app locally for development, first clone the repo and install dependencies:

```bash
npm install
npm run dev
```

Then open: `http://localhost:5173`
