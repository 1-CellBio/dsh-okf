# dsh-okf

[中文](./README.md) | [English](./README.en.md)

DeepSeek Harness 插件：把科研 PDF（以及 docx 等文档）编进本地 **OKF Markdown 知识库**，并在同一会话里做检索、图谱、覆盖度分析和综述写作。

> 模型、API key 和 base URL **全部由 Harness 管**。插件自己不配模型。

![OKF 文库知识图谱界面](./OKF_main.png)

核心约定：**Claim 是引用原子，Paper 是带链接的摘要，Topic / Method / Entity / Dataset / Gene / Pathway 是枢纽节点。** Agent 被要求走这张已经编好的类型图，而不是整篇读 PDF。

## 功能特性

- **文档收录** — `okf_ingest` 接受文件或目录（递归）。PDF 走 anydoc 文本层 + pdfjs 兜底；真扫描件和插图页栅格化后交给 Harness 多模态模型。docx / pptx / xlsx / epub 等格式直接转 Markdown。
- **全文分段编译** — 整份 extract 按约 12k 字符切段 map-reduce（schema v3），后半部分不会被丢掉。Gene / Pathway 默认不抽，需显式打开。
- **可引用的 Markdown 文库** — 论文、主题、方法、实体、数据集、基因、通路、论断、笔记、问题、综述，全部交叉链接存放在工作区 `OKF/` 下。
- **检索** — `okf_search`（IDF/标题加权全文检索，可选向量融合）、`okf_evidence`、`okf_compare`、`okf_backlinks`、`okf_neighbors`、`okf_graph` 多跳邻居。
- **覆盖度** — 主题 × 年份热力图，以及方法、数据集、基因、通路维度的缺口。
- **校对** — 近义枢纽双栏对照、AI 合并建议、缺日期 / DOI / 书目。点击后立即从列表消失，合并在后台进行。
- **综述** — 起草 → `okf_cite_check` 校验全部引用 id → `okf_save_survey`；全程无隐藏的 LLM 调用。
- **导出与迁移** — `okf_bib` / `okf_export` 输出 BibTeX / Pandoc markdown / LaTeX；`okf_pack` / `okf_merge` 打包迁移（不含 PDF）。
- **Web UI** — 检索/覆盖度工具卡片、聊天里的 SVG 小图，以及会话视图 **OKF 文库** 标签（说明 / 文献 / 图谱 / 校对 / 覆盖 / 综述 / 笔记）。

## 流水线

```
来源文件
  → 复制到 sources/pdfs 或 sources/docs（同哈希则跳过）
  → 提取文本（anydoc；损坏文本层自动转视觉）
  → 视觉识读（默认 auto：扫描件全页；原生数字 PDF 只看插图和薄文本页）
  → 分段编译（biblio → concepts → claims → digest）
  → 枢纽对齐 / 近义合并
  → 写入 papers/ topics/ methods/ … 并刷新索引
```

- **ingest** 默认并发 3 篇；编译对同一文库加锁，避免互相覆盖。
- 视觉请求每次 2 页，超时会重试，并从剩余页续跑。`visionMaxPages` 可让 auto 模式在页数过多时暂停。
- `okf_compile` 不带 `paper` 时增量跳过「当前 schema + extract 哈希未变」的篇；传入 `paper`（papers id / extract 路径 / 源文件名）则强制重编该篇。
- 无引用原文的主张会在编译后自动剪掉，不进人工校对队列。

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

修改 `dsh.client` 后需**重启 `dsh web`**；客户端扫描会缓存否定结论直到重启。

## 配置

选择一个 Harness **工作区目录**，文库存放在其中的 **`OKF/`** 下。浏览器不直接读目录，由宿主工具读盘；沙箱的 `fs` / bash 因为共享会话 cwd，看到的是同一份文件。

首次使用可在对话里发送「初始化OKF」，让智能体建好目录结构。

工作区内的默认布局：

| 路径 | 用途 |
|---|---|
| `OKF/papers/`、`OKF/topics/`、`OKF/methods/`、`OKF/entities/`、`OKF/datasets/`、`OKF/genes/`、`OKF/pathways/`、`OKF/claims/`、`OKF/notes/`、`OKF/questions/`、`OKF/surveys/`、`OKF/extracts/` | 概念 Markdown |
| `OKF/sources/pdfs/` | 原始 PDF（仅本地保存，打包时不含） |
| `OKF/sources/docs/` | 非 PDF 源文件 |
| `OKF/manuscripts/` | `okf_export` / `okf_pack` 的输出（不是概念前缀，打包时不含） |
| `OKF/.okf/` | 可重建的索引与流水线状态（打包时不含） |

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

`okf_ingest` 的相对路径相对 `pdfDir` 解析；`okf_export` / `okf_pack` 的相对路径相对 `exportDir` 解析；`okf_merge` 的 `from` 相对工作区解析。

### 运行时设置（宿主与 Web）

插件注册了 `okf` 设置命名空间（`installSettingsSection`）。启动后 `okf_paths` 显示解析后的目录；`okf_set_paths`（以及 Settings → Plugins 卡片）是**可选覆盖**——后续工具调用无需重启即可生效。

留空（或点 **Reset**）会清除用户层设置，字段重新继承组合默认值。

配置错误会明确报错，不存在静默降级。

## 工具

| 工具 | 用途 |
|---|---|
| `okf_help` | 使用指南 + 可直接复制的示例提问（`okf 是否有使用说明`） |
| `okf_paths` / `okf_set_paths` | 查看解析后的工作区路径；可选覆盖 |
| `okf_ingest` | 后台任务：复制源文件、提取、视觉识读、分段编译 |
| `okf_compile` | 后台任务：编译已有的 `extracts/*.md`（增量；传 `paper` 则强制） |
| `okf_search` / `okf_get` | 全文检索（可选语义融合）；获取整页（每轮宜 1–2 次） |
| `okf_coverage` / `okf_stats` | 覆盖度矩阵 + 缺口；文库统计 |
| `okf_check` | 健康检查：断链、孤立节点、未记录 PDF、流水线未完成 |
| `okf_graph` / `okf_neighbors` / `okf_backlinks` | 图谱查询；一跳邻居；反向引用 |
| `okf_evidence` / `okf_compare` | 论断证据；有界的论文对比（不要对上千篇无范围 compare） |
| `okf_canonicalize` | 把近义枢纽并入规范名，全库改链，源页改成跳转 |
| `okf_save_note` | 写入带 Paper/Claim 链接的 `notes/*.md` |
| `okf_cite_check` / `okf_save_survey` | 起草 → 校验 id → 写入 `surveys/*.md`（无隐藏 LLM） |
| `okf_compile_survey` | 可选后台任务，使用 Harness 默认模型起草综述 |
| `okf_sync_vectors` | 构建/刷新语义向量索引（需配置 `KG_EMBED_MODEL`） |
| `okf_bib` / `okf_export` | 在 `manuscripts/` 下输出 BibTeX / Pandoc markdown / LaTeX |
| `okf_pack` / `okf_merge` | 便携打包（不含 PDF）并合并到本工作区 |

长任务使用 `ctx.jobs`（`run_in_background` 默认开启）。请读 `job_output`；不要把任务内部的完成消息当作本次会话的助手消息。

`okf_ingest` 用 `@napi-rs/canvas` 对插图/扫描页栅格化，并把 JPEG 通过 `ctx.llm`（Harness 默认多模态模型）和 `ctx.attachments` 送出。`vision="skip"` / `skipVision: true` 只跳过原生数字 PDF 上的可选插图，真扫描件仍会走视觉识读。

语义检索为**可选开启**：配置 `KG_EMBED_MODEL` / `KG_EMBED_BASE_URL` / `KG_EMBED_API_KEY`，运行 `okf_sync_vectors`，之后 `okf_search` / `okf_evidence` / `okf_graph` 会把向量命中与全文命中融合（这样 "breast cancer" 之类的同义说法也能命中 "BRCA"）。

## Web UI

插件自带浏览器端（`exports["./client"]`，即 `dsh.client`）。组合后的 Loader 行会被扫描进 `window.__DSH_BOOT__`；除了已有的 `okf` 宿主插入行，无需额外的 patch 行。

当前内置：

- `okf_search` 工具卡片 — 命中列表（类型、标题、年份/id）
- `okf_coverage` 工具卡片 — 主题 × 年份热力图 + 可折叠的缺口列表
- Settings → Plugins 卡片 — 分段设置 `okfDir` / `pdfDir` / `exportDir`（卡片 `id: okf`，`order: 30`）
- 会话节点 `okf-graph` — 每轮使用过 `okf_search` / `okf_get` / `okf_coverage` / `okf_graph` 的对话渲染一张 SVG 图谱
- 会话视图的 **OKF 文库** 标签页（位于 对话 / 轨迹 旁）

浏览器不读 OKF 目录。快照来自 `/okf/library`、`/okf/organize`、`/okf/coverage`、`/okf/page`。写操作仍在聊天工具中（`okf_save_note`、`okf_save_survey`、`okf_canonicalize` 等）。

### 图谱页

聊天卡片小图为 SVG，按类型分列。文库大图使用 WebGL（**sigma.js + graphology**，Gephi 同款 ForceAtlas2）：

- 默认节点上限 **8000**（按 1000+ 篇论文总览设计）；填 `0` 用服务端硬上限 **2 万**。主张默认不画。
- **运行 / 暂停 / 重新排布**，布局过程逐帧刷新；右上角可调重力、斥力、减速，以及 LinLog / 强重力 / 打散枢纽 / 防重叠 / Barnes-Hut。
- 拖节点会钉住该点，其余节点继续受力；空白处平移，滚轮缩放。
- 布局在 Web Worker 中计算；Worker 不可用时回退到主线程逐帧迭代，界面保持可交互。

### 校对页

「需处理」只放近义枢纽、缺发表日期、书目待确认、合并冲突。编译出的主张可直接检索和写综述，不必在此逐条校对。

近义项点开后在该行下方双栏对照：选左侧、选右侧，或「保留两者」。AI 会给出建议。点选后条目立即从列表消失，合并在后台改链。

## 开发

本仓库是完整插件：`src/lib/` 是抽取、编译、索引、检索、图谱和综述；`src/` 根上是 Cordis / dsh 适配（`tools.ts`、`jobs.ts`、`library-http.ts`）。构建用 tsdown：Node 侧产出 `lib/index.js`，浏览器侧把 sigma / graphology 打进 `lib/client.js`（React 走平台模块）。

```sh
cd dsh-okf
pnpm install
pnpm run build
```

改完客户端后重启 `dsh web` 并硬刷新，否则会继续用缓存的旧 bundle。
