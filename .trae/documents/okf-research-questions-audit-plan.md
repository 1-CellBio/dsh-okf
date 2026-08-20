# 计划：生物医药科研视角的 OKF 文库检索能力审计（仅报告）

## 摘要（Summary）

用户收集了大量生物医药论文 PDF 并建成 OKF 文库。本任务**仅交付一份分析报告**（不改代码），回答两个问题：

1. 作为生物医药科研工作者，面对这样一个文库，**会想问哪些类型的问题**？
2. 针对每类问题，OKF 现有工具（21 个 MCP 工具 + 前端 GraphView）**能否检索到相应内容**？差在哪里？

报告将给出「科研问题目录 × 工具能力映射 × 缺口清单（结构化增强优先，语义检索仅列为后续项）」。

## 现状分析（Phase 1 探索结论）

三个搜索代理已完成对 dsh-okf 全量代码的只读分析，关键事实：

### 检索基础设施
- **纯 FTS**：SQLite 手写倒排表（拉丁词 ≥2 字符 + 汉字单字/二元组 + 前缀匹配，评分仅为「长 token 权重 2 / 单字权重 1」的计数，**无 BM25/IDF/title 加权**），降级走 MiniSearch（fuzzy 0.2）。
- **向量检索代码完整但未接线**：`syncVectors`/`queryVectorHits`/RRF 融合均已实现且设计持久化（`.okf/vectors.sqlite`），但无调用方 → 运行时所有 MCP 工具均为词法检索（用户已确认本次不接线）。
- 被索引目录：papers/topics/methods/entities/datasets/genes/pathways/claims/notes/questions/surveys/extracts 全部 `.md`；TextExtract 正文只进 FTS。
- `retrieve()` 内部支持 type/tags/publishedFrom/publishedTo/status 过滤，但 MCP 层 `okf_search` **只暴露了 type**。

### 工具能力（检索相关）
| 工具 | 机制 | 关键限制 |
|---|---|---|
| okf_search | FTS + type 过滤 | 无年份/tags 过滤；extract 命中折叠为 paper；上限 16 |
| okf_evidence | FTS 限定 Claim，top 12 | SQLite 路径 **stance/confidence 字段丢失**（rowToRecord 未恢复）→ disputed 过滤与 stance 展示失效 |
| okf_graph | query→FTS 一跳扩展；无 query→按类型 rank 取节点 | 仅 48 节点/80 边快照；**无 neighbors/多跳模式**（`lib/graph/filter.ts` 的 `undirectedNeighborhood` 已实现但无调用方） |
| okf_compare | 论文集合共享 Topic/Method/Entity/tags | **shared 不含 datasets/genes/pathways**（新晋一等公民类型未纳入比较） |
| okf_stats | 内存遍历，六类概念 paper-degree top 16 | 已含 datasets/genes/pathways ✅ |
| okf_coverage | Topic × 年份矩阵 + 缺口 | 仅 Topic 维度，无 Method/Dataset 维度 |
| okf_get | 直读文件 | TextExtract 默认拒读 |
| 前端 GraphView | /okf/library 180 节点、类型 toggle、query/年份种子 + 1 跳展开 | 年份过滤只在客户端已下发子图内生效；无「概念 X 被哪些论文引用」的反查面板（inspect 只有单点邻居） |

### 已确认的结构性缺口（报告将逐条展开）
- G1 年份/标签过滤未暴露到 okf_search（retrieve 已支持）
- G2 多跳邻居查询未接线（filter.ts 已实现）
- G3 okf_compare 的 shared 缺 datasets/genes/pathways
- G4 SQLite 索引丢失 claim 的 stance/confidence（bug 级）
- G5 FTS 评分粗糙（长尾查询、中英混排效果受限）
- G6 无「哪些论文/概念引用了 X」的反向引用查询工具
- G7 语义检索休眠（同义词盲区，本次仅列为后续建议）
- G8 coverage 仅 Topic×年份

## 交付物（Proposed Changes）

**唯一改动：新增一份 Markdown 报告文件**（用户明确要求，不触碰任何源码）：

- 路径：`/Users/1Cellbio/Desktop/Pipeline_project/1Cellbio_ASTRA/dsh-okf/.trae/documents/OKF-科研问题目录与检索能力审计.md`

### 报告结构（章节级大纲）

1. **执行摘要**：一页结论——OKF 已覆盖的科研问题类型、最大盲区、优先级建议。
2. **科研问题目录**（以生物医药研究者日常工作流组织，每类给出典型问句示例）：
   - A 文库盘点（规模/领域/年份/方法分布）
   - B 主题与趋势探索（某 topic/基因/通路的文献脉络、热度）
   - C 证据与结论（某问题有没有 claim 支持/反对、出自哪篇、原文引文）
   - D 方法/数据集/模型比较（谁用了什么方法、共享了哪些 dataset）
   - E 关系与网络（基因-通路-疾病关联、两篇论文如何连接、概念被谁引用）
   - F 覆盖与缺口（某领域逐年覆盖、缺什么方法）
   - G 综述产出（起草、引用校验、BibTeX、导出）
   - H 原文回溯（某句话的出处、某 extract 细节）
3. **工具映射矩阵**：每类问题 × 可用工具 × 回答质量评级（✅ 直接可用 / ⚠️ 部分可用需绕行 / ❌ 无法检索）+ 具体绕行路径。
4. **缺口清单与结构化增强建议**（G1–G8 逐条：现象、影响的问题类型、建议的修复方向与涉及文件；语义检索单列「后续项」）。
5. **典型科研问句实测推演**：挑 8–10 个真实风格问句（含中文、同义词、跨类型查询），逐一推演现有工具链能否答出，标注卡点。
6. **优先级路线图**：按「投入小/收益大」排序的改进建议列表（仅建议，不实施）。

### 依据与边界
- 所有工具行为描述以 Phase 1 三个代理的源码分析为准（tools.ts / okf-ops.ts / retrieve / index / graph / library-http），不虚构能力。
- 报告为只读产物；不改 src/ 任何文件、不重启服务、不建索引。

## 假设与决策（Assumptions & Decisions）

- 用户已确认：交付物仅报告；语义检索本次不接线（报告中作为后续项分析）。
- 报告语言：中文（与对话一致）。
- 报告位置放 `.trae/documents/`，与计划文件同目录，不污染项目源码区。

## 验证（Verification）

1. 报告文件写入后，自检：每个工具行为描述与源码一致（对照 Phase 1 结论）；缺口编号 G1–G8 全覆盖。
2. 向用户展示报告路径与执行摘要；由用户审阅内容是否贴合其科研场景。
3. 无代码改动 → 无需 tsc/build。
