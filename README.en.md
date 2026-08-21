# dsh-okf

[中文](./README.md) | [English](./README.en.md)

DeepSeek Harness plugin: ingest research PDFs into a **citable OKF markdown library**, then search and write surveys in the same conversation.

> This directory is the installable bundle (`dsh.bundle` + `cordis.patch.yml`). Do **not** `plugin add` the OKF library repo root (that is a Vite workbench) or a nested `deepseek-harness/` checkout.
>
> Model selection is **entirely Harness-controlled**. There is no OKF API key, base URL, or model field.

## Features

- **PDF ingestion** — `okf_ingest` copies PDFs, extracts text (anydoc + pdfjs fallback), and compiles born-digital papers; true scans are rasterized and read via the harness multimodal model.
- **Citable markdown library** — papers, topics, methods, entities, datasets, genes, pathways, claims, notes, questions, and surveys, all cross-linked under `OKF/`.
- **Full-text + semantic search** — `okf_search` (FTS with IDF/title weighting, optional vector fusion), `okf_evidence`, `okf_compare`, `okf_backlinks`, `okf_neighbors`, `okf_graph` multi-hop neighbors.
- **Coverage analysis** — topic × year heatmap plus gap detection across methods, datasets, genes, and pathways.
- **Survey writing** — draft → `okf_cite_check` verifies every id → `okf_save_survey`; no hidden LLM calls.
- **Export** — BibTeX / Pandoc markdown / LaTeX via `okf_bib` / `okf_export`; portable packs via `okf_pack` / `okf_merge`.
- **Web UI** — tool views for search/coverage, an SVG knowledge graph per conversation turn, and an **OKF Library** tab (help / library / graph / review / coverage / surveys / notes).

## Requirements

- A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) installation with the `dsh` CLI
- Node.js ≥ 20 and pnpm
- A local checkout of this repository

## Installation

### 1. Build the plugin

```sh
cd dsh-okf
pnpm install   # runs `prepare`, which builds lib/
```

### 2. Add it to a Harness profile

```sh
dsh plugin --profile <name> add ./dsh-okf
```

To pin a public plugin repo by commit:

```sh
dsh plugin --profile <name> add github:1-CellBio/dsh-okf#<commit>
```

#### What is `--profile <name>`?

`--profile <name>` selects **which Harness profile** the plugin is installed into, and is **required** (there is no default).

A *profile* is a self-contained dsh environment living at `~/.dsh/profiles/<name>` (override with the `DSH_HOME` env var). Each profile has its own `package.json`, `node_modules/`, and `cordis.patch.yml`.

- `<name>` is any name you choose (a single path segment, no `/`). Common choices: `web` (for `dsh web`) or `headless`.
- If the profile does not exist yet, `dsh plugin --profile <name> add …` **creates it automatically** (`web`/`headless` get full templates; any other name starts with `@deepseek-ai/dsh-base`).
- Launch with the same name afterwards, e.g. `dsh web --profile web` (or just `dsh web`, which implies `--profile web`).

#### pnpm ≥10 note

pnpm ≥10 blocks git `prepare` scripts until you allow them. Copy the key `dsh` prints into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-okf: true
```

Then re-run `add` (keep the `#<commit>` pin).

## Configuration

Pick a Harness **workspace folder**. The library lives in **`OKF/`** inside it. The browser does not read the folder; host tools read it on disk, and sandbox `fs` / bash see the same files because they share the session cwd.

Default layout inside the workspace:

| Path | Role |
|---|---|
| `OKF/papers/`, `OKF/topics/`, `OKF/methods/`, `OKF/entities/`, `OKF/datasets/`, `OKF/genes/`, `OKF/pathways/`, `OKF/claims/`, `OKF/notes/`, `OKF/questions/`, `OKF/surveys/`, `OKF/extracts/` | Concept markdown |
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

The plugin registers an `okf` settings namespace (`installSettingsSection`). After boot, `okf_paths` shows the resolved folders. `okf_set_paths` (and the Settings → Plugins card) are **optional overrides** — later tool calls pick them up without restart.

Empty text (or **Reset**) clears the user layer so the field re-inherits the composition default.

Misconfiguration fails loud. There is no silent fallback.

## Tools

| Tool | Role |
|---|---|
| `okf_help` | Usage guide + copy-paste example prompts |
| `okf_paths` / `okf_set_paths` | Show resolved workspace paths; optional override |
| `okf_ingest` | Background job: copy PDFs, text-extract, compile born-digital papers |
| `okf_compile` | Background job: compile existing `extracts/*.md` |
| `okf_search` / `okf_get` | Full-text search (with optional semantic fusion); fetch full page |
| `okf_coverage` / `okf_stats` | Coverage matrix + gaps; library census |
| `okf_graph` / `okf_neighbors` / `okf_backlinks` | Graph query; multi-hop neighbors; reverse references |
| `okf_evidence` / `okf_compare` | Claim evidence; bounded paper comparison |
| `okf_save_note` | Write `notes/*.md` with Paper/Claim links |
| `okf_cite_check` / `okf_save_survey` | Draft → verify ids → write `surveys/*.md` (no hidden LLM) |
| `okf_compile_survey` | Optional background job using the harness default model |
| `okf_sync_vectors` | Build/refresh the semantic vector index (requires `KG_EMBED_MODEL`) |
| `okf_bib` / `okf_export` | BibTeX / Pandoc markdown / LaTeX under `manuscripts/` |
| `okf_pack` / `okf_merge` | Portable pack (no PDFs) and merge into this workspace |

Long work uses `ctx.jobs` (`run_in_background` defaults true). Read `job_output`; do not treat job-internal completions as this chat's assistant messages.

`okf_ingest` rasterizes figure/scan pages with `@napi-rs/canvas` and sends JPEGs through `ctx.llm` (the harness default multimodal model) plus `ctx.attachments`. `skipVision: true` only skips optional figures on born-digital PDFs; true scans still run vision.

Semantic retrieval is **opt-in**: set `KG_EMBED_MODEL` / `KG_EMBED_BASE_URL` / `KG_EMBED_API_KEY`, run `okf_sync_vectors`, and `okf_search` / `okf_evidence` / `okf_graph` fuse vector hits with full-text hits (so synonyms like "breast cancer" match "BRCA").

## Web UI

The plugin ships a browser half (`exports["./client"]`, i.e. `dsh.client`). The composed Loader row is scanned into `window.__DSH_BOOT__`; no extra patch row is required beyond the existing `okf` host insert.

Shipped now:

- `okf_search` toolview — hit list (type, title, year/id)
- `okf_coverage` toolview — topic × year heatmap plus a capped gap list
- Settings → Plugins card — staged `okfDir` / `pdfDir` / `exportDir` (card `id: okf`, `order: 30`)
- Conversation Node `okf-graph` — one SVG graph per turn that used `okf_search` / `okf_get` / `okf_coverage` / `okf_graph`
- Conversation view tab **OKF Library** (beside Conversation / Trace) — subpages: help / library / graph / review / coverage / surveys / notes. Browser never reads the OKF folder; snapshots come from `/okf/library`, `/okf/organize`, `/okf/coverage`, `/okf/page`.

`okf_coverage` JSON includes `counts` aligned with `years` so the heatmap does not re-parse the library. `okf_search` hits, `okf_get` pages, and `okf_graph` include capped nodes/edges so the graph can draw without the browser reading the folder. Organize pages list `notes/`, `questions/`, `surveys/`, `manuscripts/` plus the review queue; click a row to fetch that markdown via `/okf/page`. Writes stay in chat tools (`okf_save_note`, `okf_save_survey`, …).

Restart `dsh web` after changing `dsh.client`; the client scan caches a negative verdict until restart.

The graph is SVG with a type-column layout (Paper → Topic → Method → Entity → Claim). It does not import the Vite workbench or cytoscape.

Client styling uses CSS Modules and `--dsw-*` tokens. React 18 is a platform module (external); this package does not bundle React or first-party UI internals.

## Development

Implementation of extract/compile/search stays in `../src/lib`. This package is the Cordis adapter.

```sh
cd dsh-okf
pnpm install
pnpm run build
```

From the OKF library repo root, `pnpm test` covers plugin helpers under `tests/unit/dsh-plugin/`.
