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

- User accounts / permissions

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

# Privacy and security

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
Run `npm run check` and `npm test`. Set `TEST_DATABASE_URL` to a dedicated disposable
PostgreSQL database to include PostgreSQL tests (these tests delete its assets).
CI runs both backends. `npm audit` checks known advisories, not every security risk.

# Contributing

Contributions are very welcome! Just fork the repo and open a PR with your changes.
This can be anything from bug fixes, new features, or even just improving documentation.

Roadmap:

- Bulk actions (tagging, deleting, downloading)
- Metadata generation for 3D models
- Add support for more file types (e.g. video, fonts, ...)
- User accounts and permissions
- Improved infinite scrolling/padination for large libraries
- Better responsiveness for mobile devices

## 🛠️ Development

To run the app locally for development, first clone the repo and install dependencies:

```bash
npm install
npm run dev
```

Then open: `http://localhost:5173`
