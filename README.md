# dsh-okf

[中文](./README.md) | [English](./README.en.md)

DeepSeek Harness 插件：把科研 PDF 收录进**可引用的 OKF Markdown 文库**，并在同一个会话中完成检索与综述写作。

> 本目录是可直接安装的插件包（`dsh.bundle` + `cordis.patch.yml`）。请勿对 OKF 文库仓库根目录（那是 Vite workbench）或嵌套的 `deepseek-harness/` checkout 执行 `plugin add`。
>
> 模型选择**完全由 Harness 控制**，OKF 没有自己的 API key、base URL 或模型配置项。

## 功能特性

- **PDF 收录** — `okf_ingest` 复制 PDF、提取文本（anydoc + pdfjs 兜底）并编译原生数字论文；真扫描件会栅格化后交给 Harness 多模态模型识读。
- **可引用的 Markdown 文库** — 论文、主题、方法、实体、数据集、基因、通路、论断、笔记、问题、综述，全部交叉链接存放在 `OKF/` 下。
- **全文 + 语义检索** — `okf_search`（IDF/标题加权的全文检索，可选向量融合）、`okf_evidence`、`okf_compare`、`okf_backlinks`、`okf_neighbors`、`okf_graph` 多跳邻居。
- **覆盖度分析** — 主题 × 年份热力图，外加方法、数据集、基因、通路维度的缺口检测。
- **综述写作** — 起草 → `okf_cite_check` 校验全部引用 id → `okf_save_survey`；全程无隐藏的 LLM 调用。
- **导出** — 通过 `okf_bib` / `okf_export` 输出 BibTeX / Pandoc markdown / LaTeX；通过 `okf_pack` / `okf_merge` 打包迁移文库。
- **Web UI** — 检索/覆盖度工具卡片、每轮对话的 SVG 知识图谱，以及 **OKF 文库** 标签页（说明 / 文献 / 图谱 / 校对 / 覆盖 / 综述 / 笔记）。

## 环境要求

- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)，并可用 `dsh` CLI
- Node.js ≥ 20 与 pnpm
- 本仓库的本地 checkout

## 安装

### 1. 构建插件

```sh
cd dsh-okf
pnpm install   # 会执行 `prepare`，构建 lib/
```

### 2. 添加到 Harness profile

```sh
dsh plugin --profile <name> add ./dsh-okf
```

如需按 commit 固定公开插件仓库的版本：

```sh
dsh plugin --profile <name> add github:1-CellBio/dsh-okf#<commit>
```

#### `--profile <name>` 填什么？

`--profile <name>` 指定插件要安装到**哪个 Harness profile**，它是**必填项**（没有默认值）。

*profile* 是一个自包含的 dsh 运行环境，位于 `~/.dsh/profiles/<name>`（可用环境变量 `DSH_HOME` 覆盖）。每个 profile 拥有独立的 `package.json`、`node_modules/` 和 `cordis.patch.yml`。

- `<name>` 是你自取的名字（单个路径段，不能含 `/`）。常用选择：`web`（配合 `dsh web` 使用）或 `headless`。
- 如果该 profile 尚不存在，`dsh plugin --profile <name> add …` 会**自动创建**它（`web`/`headless` 使用完整模板初始化；其他名字以 `@deepseek-ai/dsh-base` 初始化）。
- 之后用同一个名字启动即可，例如 `dsh web --profile web`（或直接 `dsh web`，它隐含 `--profile web`）。

#### pnpm ≥10 注意事项

pnpm ≥10 会拦截 git 的 `prepare` 脚本，需要手动放行。把 `dsh` 提示的键写入该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-okf: true
```

然后重新执行 `add`（保留 `#<commit>` 固定）。

## 配置

选择一个 Harness **工作区目录**，文库存放在其中的 **`OKF/`** 下。浏览器不直接读目录，由宿主工具读盘；沙箱的 `fs` / bash 因为共享会话 cwd，看到的是同一份文件。

工作区内的默认布局：

| 路径 | 用途 |
|---|---|
| `OKF/papers/`、`OKF/topics/`、`OKF/methods/`、`OKF/entities/`、`OKF/datasets/`、`OKF/genes/`、`OKF/pathways/`、`OKF/claims/`、`OKF/notes/`、`OKF/questions/`、`OKF/surveys/`、`OKF/extracts/` | 概念 Markdown |
| `OKF/sources/pdfs/` | 原始 PDF（仅本地保存，打包时不含） |
| `OKF/manuscripts/` | `okf_export` / `okf_pack` 的输出（不是概念前缀，打包时不含） |
| `OKF/.okf/` | 可重建的索引（打包时不含） |

`${cwd}` / `${workspace}` 指**会话工作区**，不是启动 `dsh` 时所在的目录。用 `okf_paths` 查看解析后的路径快照。

跨工作区迁移文库请用 `okf_pack` + `okf_merge`（或 CLI），不要直接复制 `sources/pdfs/` 进包。

**不要**把机器相关的绝对路径写进插件包或共享 profile。

### 可选覆盖

除非文库要放在工作区之外，否则保持以下变量未设置。dsh 依次加载 `<启动cwd>/.env` 和 `~/.dsh/.env`；`.env` 文件中的 `${HOME}` 不会被展开：

```sh
OKF_DIR=/path/to/your/okf
OKF_PDF_DIR=/path/to/your/pdfs
OKF_EXPORT_DIR=/path/to/your/manuscripts
```

按 id 定位的 profile patch 会**整体替换 `config`**，所以要把仍需要的字段全部重新列出：

```yaml
- id: okf
  config:
    okfDir: ${cwd}/OKF
    pdfDir: ${okfDir}/sources/pdfs
    exportDir: ${okfDir}/manuscripts
```

支持的占位符：`${cwd}`、`${workspace}`、`${home}`、`${dshHome}`、`${okfDir}`、`${pdfDir}`、`${exportDir}`、`${env:NAME}`。遇到未知 `${var}` 会直接报错。

每个目录的解析顺序：非默认 config 值 → 对应的 `OKF_*` 环境变量 → schema 默认值（`${cwd}/OKF`、`${okfDir}/sources/pdfs`、`${okfDir}/manuscripts`）。

`okf_ingest` 的相对 PDF 路径相对 `pdfDir` 解析；`okf_export` / `okf_pack` 的相对路径相对 `exportDir` 解析；`okf_merge` 的 `from` 相对工作区解析。

### 运行时设置（宿主与 Web）

插件注册了 `okf` 设置命名空间（`installSettingsSection`）。启动后 `okf_paths` 显示解析后的目录；`okf_set_paths`（以及 Settings → Plugins 卡片）是**可选覆盖**——后续工具调用无需重启即可生效。

留空（或点 **Reset**）会清除用户层设置，字段重新继承组合默认值。

配置错误会明确报错，不存在静默降级。

## 工具

| 工具 | 用途 |
|---|---|
| `okf_help` | 使用指南 + 可直接复制的示例提问（`okf 是否有使用说明`） |
| `okf_paths` / `okf_set_paths` | 查看解析后的工作区路径；可选覆盖 |
| `okf_ingest` | 后台任务：复制 PDF、提取文本、编译原生数字论文 |
| `okf_compile` | 后台任务：编译已有的 `extracts/*.md` |
| `okf_search` / `okf_get` | 全文检索（可选语义融合）；获取整页内容 |
| `okf_coverage` / `okf_stats` | 覆盖度矩阵 + 缺口；文库统计 |
| `okf_graph` / `okf_neighbors` / `okf_backlinks` | 图谱查询；多跳邻居；反向引用 |
| `okf_evidence` / `okf_compare` | 论断证据；有界的论文对比 |
| `okf_save_note` | 写入带 Paper/Claim 链接的 `notes/*.md` |
| `okf_cite_check` / `okf_save_survey` | 起草 → 校验 id → 写入 `surveys/*.md`（无隐藏 LLM） |
| `okf_compile_survey` | 可选后台任务，使用 Harness 默认模型 |
| `okf_sync_vectors` | 构建/刷新语义向量索引（需配置 `KG_EMBED_MODEL`） |
| `okf_bib` / `okf_export` | 在 `manuscripts/` 下输出 BibTeX / Pandoc markdown / LaTeX |
| `okf_pack` / `okf_merge` | 便携打包（不含 PDF）并合并到本工作区 |

长任务使用 `ctx.jobs`（`run_in_background` 默认开启）。请读 `job_output`；不要把任务内部的完成消息当作本次会话的助手消息。

`okf_ingest` 用 `@napi-rs/canvas` 对插图/扫描页栅格化，并把 JPEG 通过 `ctx.llm`（Harness 默认多模态模型）和 `ctx.attachments` 送出。`skipVision: true` 只跳过原生数字 PDF 上的可选插图，真扫描件仍会走视觉识读。

语义检索为**可选开启**：配置 `KG_EMBED_MODEL` / `KG_EMBED_BASE_URL` / `KG_EMBED_API_KEY`，运行 `okf_sync_vectors`，之后 `okf_search` / `okf_evidence` / `okf_graph` 会把向量命中与全文命中融合（这样 "breast cancer" 之类的同义说法也能命中 "BRCA"）。

## Web UI

插件自带浏览器端（`exports["./client"]`，即 `dsh.client`）。组合后的 Loader 行会被扫描进 `window.__DSH_BOOT__`；除了已有的 `okf` 宿主插入行，无需额外的 patch 行。

当前内置：

- `okf_search` 工具卡片 — 命中列表（类型、标题、年份/id）
- `okf_coverage` 工具卡片 — 主题 × 年份热力图 + 截断的缺口列表
- Settings → Plugins 卡片 — 分段设置 `okfDir` / `pdfDir` / `exportDir`（卡片 `id: okf`，`order: 30`）
- 会话节点 `okf-graph` — 每轮使用过 `okf_search` / `okf_get` / `okf_coverage` / `okf_graph` 的对话渲染一张 SVG 图谱
- 会话视图的 **OKF 文库** 标签页（位于 对话 / 轨迹 旁）— 子页：说明 / 文献 / 图谱 / 校对 / 覆盖 / 综述 / 笔记。在聊天中问：`okf 是否有使用说明`（调用 `okf_help`）。浏览器不读 OKF 目录，快照来自 `/okf/library`、`/okf/organize`、`/okf/coverage`、`/okf/page`。

`okf_coverage` 的 JSON 带有与 `years` 对齐的 `counts`，热力图无需重新解析文库。`okf_search` 命中、`okf_get` 页面、`okf_graph` 都带截断后的节点/边，图谱无需浏览器读目录即可绘制。整理页列出 `notes/`、`questions/`、`surveys/`、`manuscripts/` 以及审校队列；点击行通过 `/okf/page` 获取该 Markdown。写操作仍在聊天工具中（`okf_save_note`、`okf_save_survey` 等）。

修改 `dsh.client` 后需重启 `dsh web`；客户端扫描会缓存否定结论直到重启。

图谱为 SVG，按类型分列布局（Paper → Topic → Method → Entity → Claim），不引入 Vite workbench 或 cytoscape。

客户端样式使用 CSS Modules 与 `--dsw-*` token。React 18 是平台模块（external），本包不打包 React 和一方 UI 内部实现。

## 开发

extract/compile/search 的实现保留在 `../src/lib`，本包是 Cordis 适配层。

```sh
cd dsh-okf
pnpm install
pnpm run build
```

在 OKF 文库仓库根目录，`pnpm test` 覆盖 `tests/unit/dsh-plugin/` 下的插件辅助测试。
