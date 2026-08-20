# dsh-okf

DeepSeek Harness plugin: ingest research PDFs into a **citable OKF markdown library**, then search and write surveys in the same conversation.

This directory is the installable bundle (`dsh.bundle` + `cordis.patch.yml`). Do **not** `plugin add` the OKF 文库 repo root (that is a Vite workbench) or a nested `deepseek-harness/` checkout.

Model selection is **entirely Harness-controlled**. There is no OKF API key, base URL, or model field.

## Install

From a local checkout of this folder (after `pnpm install` / `npm install` so `prepare` can build `lib/`):

```sh
dsh plugin --profile <name> add ./dsh-okf
```

Pin a public plugin repo by commit when you publish one:

```sh
dsh plugin --profile <name> add github:<you>/dsh-okf#<commit>
```

Prefer a prebuilt npm package when you do not want git `prepare` / pnpm `allowBuilds`:

```sh
dsh plugin --profile <name> add dsh-okf
```

pnpm ≥10 blocks git `prepare` until you allow it. Copy the key `dsh` prints into the profile `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-okf: true
```

Then re-run `add`. Pin `#<commit>`.

## Configure

Pick a Harness **workspace folder**. The library lives in **`OKF/`** inside it. The browser does not read the folder; host tools read it on disk, and sandbox `fs` / bash see the same files because they share the session cwd.

Default layout inside the workspace:

| Path | Role |
|---|---|
| `OKF/papers/`, `OKF/topics/`, `OKF/methods/`, `OKF/entities/`, `OKF/claims/`, `OKF/notes/`, `OKF/questions/`, `OKF/surveys/`, `OKF/extracts/` | Concept markdown |
| `OKF/sources/pdfs/` | Original PDFs (local only; packs omit them) |
| `OKF/manuscripts/` | `okf_export` / `okf_pack` output (not a concept prefix; packs omit it) |
| `OKF/.okf/` | Rebuildable index (packs omit it) |

`${cwd}` / `${workspace}` is the **session workspace**, not the directory you launched `dsh` from. Inspect the resolved snapshot with `okf_paths`.

Move a library between workspaces with `okf_pack` then `okf_merge` (or the CLI). Do not copy `sources/pdfs/` into a pack.

Do **not** put a machine-specific absolute path in the plugin bundle or in a shared profile.

### Optional overrides

Leave these unset unless the library should live outside the workspace. dsh loads `<launch-cwd>/.env` then `~/.dsh/.env`. `${HOME}` in a `.env` file is not expanded:

```sh
OKF_DIR=/path/to/your/okf
OKF_PDF_DIR=/path/to/your/pdfs
OKF_EXPORT_DIR=/path/to/your/manuscripts
```

An id-targeted profile patch **replaces the whole `config`**, so restate every field you still need:

```yaml
- id: okf
  config:
    okfDir: ${cwd}/OKF
    pdfDir: ${okfDir}/sources/pdfs
    exportDir: ${okfDir}/manuscripts
```

Supported tokens: `${cwd}`, `${workspace}`, `${home}`, `${dshHome}`, `${okfDir}`, `${pdfDir}`, `${exportDir}`, `${env:NAME}`. Unknown `${var}` fails loud.

Resolution order per directory: a non-default config value → matching `OKF_*` env var → schema default (`${cwd}/OKF`, `${okfDir}/sources/pdfs`, `${okfDir}/manuscripts`).

Relative `okf_ingest` PDF paths resolve against `pdfDir`. Relative `okf_export` / `okf_pack` paths resolve against `exportDir`. `okf_merge` `from` is relative to the workspace.

### Live settings (Host and Web)

The plugin registers a `okf` settings namespace (`installSettingsSection`). After boot, `okf_paths` shows the resolved folders. `okf_set_paths` (and the Settings → Plugins card) are **optional overrides** — later tool calls pick them up without restart.

Empty text (or **Reset**) clears the user layer so the field re-inherits the composition default.

This repository's nested `deepseek-harness/` checkout serves **every** registered settings namespace: `settings.describe` maps the whole namespace list with no per-namespace allowlist, so registering `okf` alone is enough. A stock `dsh` build that predates that behavior may still answer `settings-not-exposed`, and the card renders nothing.

Misconfiguration fails loud. There is no silent fallback model.

## Web UI (settings cards and visualization)

The plugin ships a browser half (`exports["./client"]`, `dsh.client`). The composed Loader row is scanned into `window.__DSH_BOOT__`; no extra patch row is required beyond the existing `okf` host insert.

Shipped now:

- `okf_search` toolview — hit list (type, title, year/id)
- `okf_coverage` toolview — topic × year heatmap plus a capped gap list
- Settings → Plugins card — staged `okfDir` / `pdfDir` / `exportDir` (card `id: okf`, `order: 30`)
- Conversation Node `okf-graph` — one SVG graph per turn that used `okf_search` / `okf_get` / `okf_coverage` / `okf_graph`
- Conversation view tab **OKF 文库** (beside 对话 / 轨迹) — subpages 说明 / 文献 / 图谱 / 校对 / 覆盖 / 综述 / 笔记. Ask in chat: `okf 是否有使用说明` (calls `okf_help`). Browser never reads the OKF folder; snapshots come from `/okf/library`, `/okf/organize`, `/okf/coverage`, `/okf/page`.

`okf_coverage` JSON includes `counts` aligned with `years` so the heatmap does not re-parse the library. `okf_search` hits, `okf_get` pages, and `okf_graph` include capped nodes/edges so the graph can draw without the browser reading the folder. Organize pages list `notes/` `questions/` `surveys/` `manuscripts/` plus the review queue; click a row to fetch that markdown via `/okf/page`. Writes stay in chat tools (`okf_save_note`, `okf_save_survey`, …).

Restart `dsh web` after changing `dsh.client`; the client scan caches a negative verdict until restart.

The graph is SVG with a type-column layout (Paper → Topic → Method → Entity → Claim). It does not import the Vite workbench or cytoscape.

Client styling uses CSS Modules and `--dsw-*` tokens. React 18 is a platform module (external); this package does not bundle React or first-party UI internals.

## Tools

| Tool | Role |
|---|---|
| `okf_help` | Usage guide + copy-paste example prompts (`okf 是否有使用说明`) |
| `okf_paths` / `okf_set_paths` | Show resolved workspace paths; optional override |
| `okf_ingest` | Background job: copy PDFs, text-extract, compile born-digital papers |
| `okf_compile` | Background job: compile existing `extracts/*.md` |
| `okf_search` / `okf_get` / `okf_coverage` / `okf_graph` / `okf_stats` / `okf_evidence` / `okf_compare` | Search, full page, coverage, graph, census, claim evidence, bounded compare |
| `okf_save_note` | Write `notes/*.md` with Paper/Claim links |
| `okf_cite_check` / `okf_save_survey` | Draft → verify ids → write `surveys/*.md` (no hidden LLM) |
| `okf_compile_survey` | Optional background job using the harness default model |
| `okf_bib` / `okf_export` | BibTeX / Pandoc markdown / LaTeX under `manuscripts/` |
| `okf_pack` / `okf_merge` | Portable pack (no PDFs) and merge into this workspace |

Long work uses `ctx.jobs` (`run_in_background` defaults true). Read `job_output`; do not treat job-internal completions as this chat's assistant messages.

`okf_ingest` rasters figure/scan pages with `@napi-rs/canvas` and sends JPEGs through `ctx.llm` (the harness default multimodal model) plus `ctx.attachments`. `skipVision: true` only skips optional figures on born-digital PDFs; true scans still run vision.

## Develop

Implementation of extract/compile/search stays in `../src/lib`. This package is the Cordis adapter.

```sh
cd dsh-okf
pnpm install
pnpm run build
```

From the OKF 文库 repo root, `pnpm test` covers plugin helpers under `tests/unit/dsh-plugin/`.
