# OKF 文库：生物医药科研问题目录与检索能力审计报告

> 面向对象：以生物医药文献工作流为背景的科研用户（使用 OKF 文库检索/分析工具）。
> 范围：对 dsh-okf 全部 21 个 MCP 工具 + 前端 GraphView 的**检索与分析能力**进行审计。所有工具行为描述均来自源码分析（src/tools.ts、src/okf-ops.ts、src/lib/retrieve/、src/lib/index/、src/lib/graph/、src/library-http.ts），非虚构。
> 结论性质：**仅分析报告**，不含代码改动。

---

## 一、执行摘要

把一堆生物医药论文 PDF 建成 OKF 文库后，科研用户日常会问的问题，可以归纳为 **8 大类（A–H）**。审计结论分三档：

**✅ 能直接回答（约 4 类半）**
- **A 文库盘点**（库有多大、什么领域、什么年代、方法分布）——`okf_stats` / `okf_paths` / `okf_check` 覆盖良好。
- **B 主题与趋势**（某 topic/基因/通路的文献脉络与热度）——`okf_stats` 的 paper-degree hotlist + 前端图谱，基本够用。
- **C 证据与结论**（某问题有没有 claim、支持/反对、出自哪篇、原文引文）——`okf_evidence` 直达 claim，链路设计是最完整的。
- **F 覆盖与缺口**（某领域逐年覆盖、缺什么方法）——`okf_coverage` 专用工具。
- **G 综述产出**——`okf_cite_check` / `okf_save_survey` / `okf_bib` / `okf_export` / `okf_compile_survey` 链条完整。

**⚠️ 能回答但要绕行（约 2 类）**
- **D 方法/数据集/模型比较**——`okf_compare` 能做论文间共享，但**只比较 Topic/Method/Entity/tag，漏掉了 dataset/gene/pathway**，而这恰恰是生物医药最关心的比较维度。
- **H 原文回溯**——`okf_get` + `okf_search`(type=TextExtract) 可用，但 extract 命中默认折叠为论文，且 SQLite 检索路径丢失 claim 的 stance/confidence，回溯证据链时有精度损失。

**❌ 基本无法直接回答（2 类半）**
- **E 关系与网络（深挖）**——能看图谱快照（48 节点/80 边、1 跳邻居），但**没有「概念 X 被哪些论文/概念引用」的反向引用查询**，也没有**多跳/路径查询**（代码 `lib/graph/filter.ts` 已实现 `undirectedNeighborhood` 但未接线）。"哪几篇论文都用到 TCGA-BRCA？"这种问题，现在只能靠 okf_search + 逐篇 okf_get 手工拼。
- **同义词/换说法检索**——纯词法 FTS，"breast cancer" 搜不到写 "BC"、"BRCA 相关页" 的文档。向量检索代码完整（`syncVectors`/`queryVectorHits`/RRF）但**未接线**，是最大的单点盲区（已确认本次不修，列为后续项）。
- **F 覆盖缺 Method/Dataset 维度**——coverage 只有 Topic×年份，问"2023 年有多少篇用了单细胞测序但没做空间转录组"这类交叉缺口，无法直接回答。

**一句话结论**：OKF 的**「证据回溯 + 综述产出」链条**（claim→原文→citation→manuscript）是业内少有的完整闭环，对"写综述/回答科学问题"是强项；**短板集中在「跨论文关系深挖」与「语义检索」**——前者是已实现未接线（投入小收益大），后者需要 embedding 配置（后续项）。

---

## 二、科研问题目录（A–H）

以生物医药研究者日常工作流组织，每类给出**典型问句示例**（含真实科研风格，中英混排）。

### A. 文库盘点
> "这个库里一共有多少篇论文？覆盖了哪些领域？"
> "都有哪些年份的文献？近五年多不多？"
> "库里主要用了哪些方法/数据集？"
> "这个库完整吗？有没有没处理好的 PDF？"

### B. 主题与趋势探索
> "跟 spatial transcriptomics 相关的论文有哪些？热度趋势怎么样？"
> "BRCA 这个基因在库里被哪些论文重点研究？"
> "近几年在肿瘤微环境方向，主要的研究话题是什么？"
> "用单细胞测序做细胞命运决定的，最早是哪年的文章？"

### C. 证据与结论
> "有没有证据表明配体-受体互作在肿瘤耐药里起关键作用？"
> "库里支持还是反对『SOX9 是胰腺癌干性维持必需基因』？出自哪篇、原文怎么说？"
> "哪些论文报告了 'cell fate landscape' 的结论？各是什么 stance？"

### D. 方法/数据集/模型比较
> "这 5 篇都用 Optimal Transport 做细胞命运分析，方法有什么异同？"
> "哪些论文用了 TCGA-BRCA 数据？分别怎么处理的？"
> "对比一下 STORIES 和 Topological autoencoder 两篇，共享了哪些概念/方法？"

### E. 关系与网络（深挖）
> "TCGA-BRCA 这个数据集被哪些论文引用过？（反向引用）"
> "从 'cell fate' 这个 topic 出发，两跳之内关联到哪些通路/基因？"
> "Fused Gromov–Wasserstein 这个方法和哪些数据集/基因有共同引用？"
> "哪些基因和哪些通路经常在同一篇论文里一起出现？"

### F. 覆盖与缺口
> "spatial transcriptomics 这个 topic 哪些年份没有论文？"
> "2023–2025 年，单细胞测序相关的论文里，有多少没用空间组学？（交叉覆盖）"
> "哪些方法在库里从未与 'cell fate' 搭配使用？"

### G. 综述产出
> "帮我起草一篇关于『细胞命运决定机制』的综述框架。"
> "检查我这段草稿里的引用是否都在库里、格式对不对。"
> "给这份综述生成 BibTeX，导出 LaTeX/Pandoc 手稿。"

### H. 原文回溯
> "'细胞命运由 Waddington landscape 决定' 这句话的原文出处是哪篇？上下文是什么？"
> "STORY 论文里关于 optimal transport 的具体段落，原文怎么说？"

---

## 三、工具映射矩阵

| 问题类 | 可用工具链 | 评级 | 说明/绕行路径 |
|---|---|---|---|
| **A 文库盘点** | `okf_stats`(counts/years/topics/methods/entities/datasets/genes/pathways/tags) + `okf_paths` + `okf_check`(pipeline 完整性) | ✅ | 覆盖完整；`okf_stats` 已是六类概念 hotlist 齐全（含 datasets/genes/pathways） |
| **B 主题与趋势** | `okf_stats`(paper-degree hotlist) + `okf_search`(type) + `okf_graph`(query 聚焦) + `okf_coverage`(逐年) | ✅ | 趋势 = `okf_coverage` 逐年计数 + `okf_stats` 热度；需注意 FTS 词法匹配，同义表达要换词搜 |
| **C 证据与结论** | `okf_evidence`(query→top12 claims→paper 聚合) + `okf_get`(读 claim/paper 全文) | ✅ | 链路最完整；⚠️ SQLite 路径丢失 stance/confidence（见 G4），"支持/反对"判断目前依赖 claim 正文人工读 |
| **D 方法/数据集/模型比较** | `okf_compare`(papers ids 或 query) | ⚠️ | shared 仅 Topic/Method/Entity/tags，**缺 dataset/gene/pathway**（G3）；要比较基因/通路需绕行：`okf_search`(type=Gene) 逐个 + `okf_get` 手工拼 |
| **E 关系与网络（深挖）** | `okf_graph`(48/80 快照) + 前端 1 跳 inspector | ❌ | 无反向引用查询（G6）、无多跳/路径查询（G2，`filter.ts` 已实现未接线）；"X 被谁引用"现需手工绕行 |
| **F 覆盖与缺口** | `okf_coverage`(topic 或从/to) | ⚠️ | 只有 Topic×年份（G8）；Method/Dataset 维度、交叉覆盖缺口无法直接回答 |
| **G 综述产出** | `okf_compile_survey` + `okf_cite_check` + `okf_save_survey` + `okf_bib` + `okf_export` | ✅ | 链条完整；cite_check 校验 papers/claims 链接存在性，bib 复用不发明 DOI |
| **H 原文回溯** | `okf_search`(type=TextExtract) + `okf_get` + `okf_evidence`(claim 含 quote/excerpt) | ⚠️ | extract 命中默认折叠为论文，需显式 type=TextExtract；claim 的 quote 对齐原文依赖 `snapQuoteToExtract`，未对齐置 disputed 且 status=draft（默认 stableOnly 会漏掉） |

---

## 四、缺口清单与结构化增强建议（G1–G8）

> 每条：现象 / 影响的问题类 / 建议修复方向与涉及文件。G7 语义检索为「后续项」（用户已确认本次不接线）。

### G1 年份/标签过滤未暴露到 okf_search
- **现象**：`retrieve()` 内部已支持 `tags`/`publishedFrom`/`publishedTo`/`status` 过滤，但 MCP 层 `okf_search` 只暴露了 `type` 一个维度（src/tools.ts、okf-ops.ts `searchOkf`）。
- **影响**：B（"近五年"）、A（"按年份盘点"）需绕行 `okf_coverage`/`okf_stats` 再手工筛。
- **建议**：`searchOkf` 增加 `from`/`to`/`tags` 可选参数透传给 `retrieve`；改动小、纯透传。

### G2 多跳邻居查询未接线
- **现象**：`src/lib/graph/filter.ts` 已实现 `undirectedNeighborhood(index, seeds, depth)`（无向多跳 BFS）与 `filterGraph`（types/year/query/depth/maxNodes/claimMinDegree），但**无任何调用方**；`src/lib/retrieve/query.ts` 的 `walk(startId, depth)` 同样未接线。MCP 层 `okf_graph` 只有 query/includeClaims 两个参数。
- **影响**：E（"从 cell fate 两跳内关联哪些通路/基因"）无法回答。
- **建议**：给 `okf_graph` 增加可选 `id`+`depth` 参数，走 `undirectedNeighborhood`；同时暴露 `okf_neighbors`（单点出入邻居 + 反向引用）工具。投入小、复用现成实现。

### G3 okf_compare 的 shared 缺 datasets/genes/pathways
- **现象**：`comparePapersOp` 的 `sharedHits` 只算 Topic/Method/Entity/tags（src/okf-ops.ts），而 datasets/genes/pathways 已是库中一等公民（独立目录、图谱有色节点、stats 已纳入）。
- **影响**：D（"哪些论文共享了 TCGA-BRCA？哪些共享了同一个基因/通路？"）是生物医药高频问题，当前漏掉。
- **建议**：`sharedHits`/`inAll` 纳入 Dataset/Gene/Pathway（复用 `byType`/`paperLinks` 派生表即可，改动集中在 comparePapersOp 的分桶逻辑）。

### G4 SQLite 索引丢失 claim 的 stance/confidence（bug 级）
- **现象**：`sqliteIndex.ts` 的 `rowToRecord` 不恢复 `confidence`/`stance` 字段（`parseConceptRecord` 解析了但入库时丢弃）→ 主路径下 `collectClaims` 的 disputed 过滤与 `okf_evidence` 的 stance/confidence 展示实际失效；仅 MiniSearch 降级路径保留。
- **影响**：C（"支持还是反对"判断）、H（证据可信度标注）精度损失。
- **建议**：`rowToRecord` 补读 `confidence`/`stance`（fts 表已有这些列）；纯 bug 修复，改 1 处。

### G5 FTS 评分粗糙（长尾/中英混排）
- **现象**：评分 = `SUM(长度≥2 的 token 权重2 + 单字权重1)`，无 BM25/IDF/title 字段加权；中文靠单字+bigram（虚词单字被滤）。
- **影响**：B/C 的相关性排序在长尾查询（如 "Fused Gromov–Wasserstein"）上可能把不相关的泛化页排前面。
- **建议**：可选——SQLite 路径引入 IDF 权重或 title 加权（`fts_tokens` 已有 idf 可算）；或前端对结果做二次重排。列为低优先。

### G6 无「哪些论文/概念引用了 X」的反向引用查询
- **现象**：图谱只有"出链"（outgoing）有链接；`derivedOf(index).incoming` 反向边已在内存计算并缓存（供 stats/check 复用），但**没有工具暴露它**。前端 inspect 面板也只有单点邻居，无"被谁引用"列表。
- **影响**：E（"TCGA-BRCA 被哪些论文引用？"）、"这个概念重要吗"（引用数）。
- **建议**：新暴露 `okf_backlinks`（id → 引用它的 papers/claims/…），直接读 `derivedOf().incoming`，纯增量、零计算成本。

### G7 语义检索休眠（同义词盲区）—— 后续项
- **现象**：`syncVectors`/`queryVectorHits`/RRF(k=60) 全部实现且持久化设计完整（`.okf/vectors.sqlite`，extract 按 400–800 字符切片上限 16 chunk，claim 1 chunk），但**无调用方**；运行时所有 MCP 工具纯词法。`retrieve` 已支持 `vectorHits` 融合，只差接线 + embedding 配置。
- **影响**："breast cancer"↔"BC"、"tumor microenvironment"↔"TME" 这类同义词/缩写完全搜不到，是科研检索最大痛点（C/D/B 均受影响）。
- **建议（后续实施，需用户提供 OpenAI 兼容 embedding 端点或本地 Ollama）**：① 接线 `syncVectors`（ingest/compile 后增量构建）；② `retrieve` 传入 `vectorHits`（embed model 与 vectors_meta 一致才生效，跨模型自动降级）；③ 配置 `embedding.model/baseUrl/apiKey`（或 `KG_EMBED_*`/`OPENAI_EMBED_*` env）。

### G8 coverage 仅 Topic×年份
- **现象**：`buildCoverageMatrix` 只建 paperTopics/paperMethods 邻接表，`listCoverageGaps` 的 gap 只有 missing_year/missing_method(单topic)/undated_paper；无 Method/Dataset/基因维度的覆盖矩阵。
- **影响**：F（"哪些方法从未与 cell fate 搭配"）只能单 topic 查 missing_method，无法跨维度问。
- **建议**：coverage 增补 Dataset/Pathway 维度矩阵（复用邻接表模式），低-中优先。

---

## 五、典型科研问句实测推演（8 个）

> 推演基于源码语义（FTS 词法 + 现有工具参数），标注每一步的工具与卡点。

**Q1「库里有多少篇单细胞测序相关的论文？」**
`okf_stats` → topics hotlist 找 single-cell → `okf_search(type=Topic, "single-cell")` → `okf_get` 看该 topic 的 paper 链接数。
✅ 可答（FTS 命中 "single-cell" 词即可）；卡点：若正文写成 "scRNA-seq" 则词法可能不命中（G7）。

**Q2「BRCA 基因被哪些论文重点研究？」**
`okf_search(type=Gene, "BRCA")` → 命中 gene 页 → 看 outgoing；**反向（哪些论文引用了它）无工具**。
⚠️ 部分可答；卡点：缺反向引用（G6）、缺 paper-degree 排序（可借 okf_stats 的 genes hotlist）。

**Q3「有没有证据支持『配体-受体互作驱动肿瘤耐药』？」**
`okf_evidence("ligand receptor tumor resistance")` → top12 claims → 每条带 paper/paperTitle/excerpt → 聚合 papers。
✅ 链路完整；卡点：stance/confidence 在 SQLite 路径丢失（G4），"支持/反对"需读 claim 正文自行判断；同义表达需多轮换词（G7）。

**Q4「这 5 篇论文共享了哪些方法/数据集？」**
`okf_compare(papers=[5 个 id])` → shared topics/methods/entities/tags + inAll。
⚠️ 方法/topic 可答；**共享数据集（如都用了 TCGA-BRCA）漏掉**（G3）；共享基因/通路同样漏。

**Q5「从 cell fate 出发，两跳内关联到哪些通路/基因？」**
`okf_graph(query="cell fate")` → 只给 48 节点/80 边 + 1 跳。
❌ 不可直接答；`undirectedNeighborhood(depth=2)` 已实现未接线（G2）。绕行：逐节点 okf_get 手工扩展，极慢。

**Q6「TCGA-BRCA 被哪些论文引用过？」**
`okf_search(type=Dataset, "TCGA")` 命中 dataset 页 → outgoing 是它指向的论文；**谁指向它**无工具。
❌ 反向引用缺失（G6）；绕行：前端图谱选中该节点看 inspector 邻居（仅当该节点在已下发 180 节点内）。

**Q7「spatial transcriptomics 哪些年份没有论文？」**
`okf_coverage(topic=spatial-transcriptomics)` → missingYears 直接给。
✅ 可直接答；卡点：topic 名需与库内一致（FTS 词法，缩写差异需多试）。

**Q8「2023–2025 年用单细胞但没用空间组学的论文有哪些？」**
`okf_coverage(from=2023,to=2025)` → 只有 Topic×年份计数，无"未用某方法"的交叉过滤。
❌ 无法直接答（G8）；绕行：coverage 逐年 + okf_compare 手工交叉。

**Q9「把这段综述草稿里的引用校验一遍，导出 BibTeX。」**
`okf_cite_check(body)` → illegal 列表 → `okf_bib(survey)` → `okf_export(format=tex)`。
✅ 完整闭环，本库最成熟的产出链。

**Q10「『细胞命运由 Waddington landscape 决定』的原文出处？」**
`okf_evidence(该句)` → claim 命中 → claim 含 quote + evidence.extract + paper。
✅ 可答；卡点：若引文未能 `snapQuoteToExtract` 对齐 → claim 置 disputed+status=draft → **默认 stableOnly 检索会漏掉**（G4/H 侧）；extract 全文回溯需显式 type=TextExtract。

---

## 六、优先级路线图（仅建议，未实施）

| 优先级 | 项 | 收益 | 成本 | 归属问题 |
|---|---|---|---|---|
| P0 | G4 修复 stance/confidence 持久化 | 证据可信度立即可靠 | 极小（1 处） | C/H |
| P0 | G6 反向引用工具（okf_backlinks） | "X 被谁引用"高频问题打通 | 极小（读缓存派生表） | E/D |
| P1 | G2 多跳邻居 + okf_neighbors（复用已实现 filter.ts） | 关系深挖闭环 | 小（接线） | E |
| P1 | G3 compare 纳入 dataset/gene/pathway | 生物医药比较维度补齐 | 小 | D |
| P1 | G1 okf_search 年份/tags 过滤透传 | 时间维度检索 | 极小 | A/B |
| P2 | G8 coverage 增补方法/数据集维度 | 交叉缺口分析 | 中 | F |
| P2 | G5 FTS 评分增强（IDF/title 加权） | 相关性排序改善 | 中 | B/C |
| P3 | G7 语义检索接线（需 embedding 配置/费用） | 同义词盲区根治 | 大 + 外部依赖 | 全局 |

---

*本报告为只读分析产物；所有工具行为描述与缺口判定均对照 dsh-okf 源码（Phase 1 三代理全量分析），未做任何代码改动。*
