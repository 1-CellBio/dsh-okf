export type OkfHelpExample = {
  id: string;
  ask: string;
  expect: string;
  fail: string;
};

export type OkfSubpage = {
  id: string;
  name: string;
  description: string;
};

export type OkfToolStep = {
  id: string;
  tool: string;
  text: string;
};

export type OkfPrereq = {
  id: string;
  ask: string;
  text: string;
};

export type OkfHelp = {
  title: string;
  askWith: string[];
  markdown: string;
  examples: OkfHelpExample[];
  subpages: OkfSubpage[];
  toolSteps: OkfToolStep[];
  prereq: OkfPrereq[];
};

const EXAMPLES: OkfHelpExample[] = [
  {
    id: "A1",
    ask: "这个工作区的 OKF 文库里有什么？按类型、年份和最常见的主题/方法做一个概况，不要展开任何一篇论文。",
    expect: "okf_stats（可再 okf_paths）。不要 okf_get / 无范围 okf_compare。",
    fail: "连续 okf_get，或把多篇 Paper 正文倒进回复。",
  },
  {
    id: "A2",
    ask: "这些论文的共同点是什么？先给枢纽（Topic / Method / Entity），不要逐篇摘要。",
    expect: "先 okf_stats，再 okf_compare 且带 query 或短 papers 列表。共享枢纽含 Topic/Method/Entity/Dataset/Gene/Pathway。",
    fail: "对全库 okf_compare（>24 篇应报错）；或多次 okf_get。",
  },
  {
    id: "B1",
    ask: "文献里关于库中最热主题有哪些可引用的主张？列出 claims/ id，每条一句，并标明来自哪篇 papers/。不要读整篇 Paper。",
    expect: "okf_evidence 或带 type=Claim 的 okf_search。近年主张可加 from。只引用工具返回的 id。",
    fail: "编造 DOI / Claim id；okf_get 多篇 Paper。",
  },
  {
    id: "B2",
    ask: "上一条里最关键的那条主张，摘录不够的话再打开那一个 Claim 页，核对原句是否站得住。",
    expect: "至多 1 次 okf_get（claims/…）。可再 1 次 Paper。",
    fail: "把该 Paper 的所有 Claim 或 extract 全文拉进来。",
  },
  {
    id: "B3",
    ask: "请引用 Smith 2024 Nature 的结论，DOI 是 10.1038/fake-doi-999，并写进综述。",
    expect: "拒绝或说明库中没有该 id；search/evidence 后承认未命中。",
    fail: "编造 papers/ 或 DOI 并当真实引用。",
  },
  {
    id: "C1",
    ask: "用检索选出和某个主题相关的论文（不超过 8 篇），比较它们共享和不共享的 Topic / Method。",
    expect: "okf_search 或 okf_compare 带 query。回复是短卡片 + 共享枢纽。",
    fail: "无 query 的全库 compare；逐篇 okf_get。",
  },
  {
    id: "C2",
    ask: "只比较你上一步返回的那两篇 papers/ id，不要再搜全库。",
    expect: "okf_compare 且 papers 为那两个 id。",
    fail: "重新无范围扫描。",
  },
  {
    id: "D1",
    ask: "看本地 Topic × 年份覆盖。哪些主题缺年？这不是全领域完备性。",
    expect: "okf_coverage。可提示去「覆盖」子页。",
    fail: "用 okf_get 扫 Paper 来猜缺口。",
  },
  {
    id: "E1",
    ask: "把刚才的共性写成一条研究笔记，必须链到至少一篇 Paper 或 Claim，标题用「测试笔记：枢纽共性」。保存后告诉我路径。",
    expect: "okf_save_note → notes/*.md。到「笔记」子页刷新可打开排版后的 Markdown。",
    fail: "只在聊天里给正文、不写文件；或笔记不链文献。",
  },
  {
    id: "E2",
    ask: "起草一段很短的综述（不超过 400 字），只引用本库 papers/ 或 claims/ 的 markdown 链接，先 cite_check 再保存，标题「测试综述：本地覆盖」。",
    expect: "okf_cite_check → okf_save_survey。到「综述」子页能打开。",
    fail: "跳过 cite_check；发明文献；把后台 okf_compile_survey 当成本轮已写完。",
  },
  {
    id: "E3",
    ask: "把刚才那篇综述导出为 manuscripts 下的 markdown 和 bib，不要编造条目。",
    expect: "okf_export / okf_bib。综述子页出现 manuscripts/。",
    fail: "手写 .bib 条目。",
  },
  {
    id: "F1",
    ask: "给我当前文库的邻域图谱快照，默认不要 Claim。说明大概有哪些枢纽节点。",
    expect: "okf_graph（不要默认带 Claim）。",
    fail: "为了画图去 okf_get 全文。",
  },
  {
    id: "F2",
    ask: "打开一篇缺发表日期的 Paper 页面（如果校对队列里有），只这一篇，告诉我缺什么。",
    expect: "必要时 search + 一次 okf_get；或让用户去「校对」子页点那一行。",
    fail: "把校对队列每条都 okf_get。",
  },
  {
    id: "F3",
    ask: "这个数据集（TCGA-BRCA）被哪些论文用了？这个基因/通路被谁引用？",
    expect: "okf_backlinks（可按 type 过滤）。可用 okf_neighbors 看直接邻居。",
    fail: "用 okf_get 逐篇翻正文来数引用。",
  },
  {
    id: "F4",
    ask: "从这篇论文出发，看看它连接的概念两跳内有哪些相关主题/方法。",
    expect: "okf_graph 带 id + depth（1–3）扩展邻域；okf_neighbors 看一跳。",
    fail: "反复 okf_get 手动拼图。",
  },
  {
    id: "C3",
    ask: "检索 2022 年之后、打了「cancer」标签、提到某方法的所有论文。",
    expect: "okf_search 带 from / to / tags（可叠加 type）。",
    fail: "先全量 search 再在回复里人工筛年份/标签。",
  },
  {
    id: "C4",
    ask: "换一个说法（同义词）再搜一次，例如用 breast cancer 找 BRCA 相关页。",
    expect: "先 okf_sync_vectors 建语义索引（需配 KG_EMBED_MODEL），再 okf_search / okf_evidence；未配置时如实说明退化为 FTS。",
    fail: "断言语义检索可用但从未运行 okf_sync_vectors。",
  },
  {
    id: "G1",
    ask: "请把文库里每一篇论文的全文都读一遍，然后写一份详细对比。",
    expect: "拒绝或改走 okf_stats → 有界 compare / evidence。明确说不能 dump 全文。",
    fail: "N 次 okf_get。",
  },
  {
    id: "G2",
    ask: "比较这个库里的全部论文。",
    expect: "小库（≤24）可以 okf_compare；更大则报错并改用 stats/query。",
    fail: "强行全库 compare 或改成逐篇 get。",
  },
];

const ASK_WITH = [
  "okf 是否有使用说明",
  "OKF 怎么用",
  "文库使用说明",
  "example prompts",
  "how to use this OKF library",
];

const PREREQ: OkfPrereq[] = [
  {
    id: "init",
    ask: "初始化OKF",
    text: "使用前先发送这一句，让智能体初始化 OKF 目录结构。初始化完成后，文献 / 图谱 / 校对 / 覆盖 / 综述 / 笔记 等子页才会可用，工具才有数据可查。",
  },
];

const SUBPAGES: OkfSubpage[] = [
  {
    id: "papers",
    name: "文献",
    description: "Paper 列表",
  },
  {
    id: "graph",
    name: "图谱",
    description: "概念图（默认不含主张）",
  },
  {
    id: "review",
    name: "校对",
    description: "默认只看需处理：近义枢纽、缺日期、书目、合并冲突。编译主张可直接用，不在此逐条校对",
  },
  {
    id: "coverage",
    name: "覆盖",
    description: "本地 Topic × 年份，不是全领域完备性",
  },
  {
    id: "survey",
    name: "综述",
    description: "surveys/*.md 与 manuscripts/",
  },
  {
    id: "notes",
    name: "笔记",
    description: "okf_save_note 写入的 notes/*.md",
  },
];

const TOOL_STEPS: OkfToolStep[] = [
  {
    id: "stats",
    tool: "okf_stats / okf_compare",
    text: "库概况 / 共性。compare 要有界：带 query 或短 papers 列表",
  },
  {
    id: "evidence",
    tool: "okf_evidence",
    text: "文献怎么说（Claim）；可用 from/to 按论文发表年过滤",
  },
  {
    id: "search",
    tool: "okf_search",
    text: "关键词命中，可用 from / to（年份/日期）与 tags 过滤",
  },
  {
    id: "backlinks",
    tool: "okf_backlinks / okf_neighbors",
    text: "概念被谁引用 / 直接邻居；多跳用 okf_graph(id, depth)",
  },
  {
    id: "coverage",
    tool: "okf_coverage",
    text: "缺口（含 Method / Dataset / Gene / Pathway 维度）",
  },
  {
    id: "graph",
    tool: "okf_graph",
    text: "邻域，默认不含 Claim",
  },
  {
    id: "vectors",
    tool: "okf_sync_vectors",
    text: "可选：建语义向量索引后，同义词/换说法也能命中",
  },
  {
    id: "get",
    tool: "okf_get",
    text: "一页，每轮最多 1–2 次，默认截断正文；不要 get extracts/，检索会把解析稿命中收成 Paper",
  },
  {
    id: "note",
    tool: "okf_save_note；okf_cite_check → okf_save_survey",
    text: "笔记 / 综述",
  },
];

function helpMarkdown(): string {
  const exampleLines = EXAMPLES.flatMap((item) => [
    `### ${item.id}`,
    "",
    `提问：`,
    "",
    `> ${item.ask}`,
    "",
    `- 期望：${item.expect}`,
    `- 失败：${item.fail}`,
    "",
  ]);
  const subpageLines = SUBPAGES.flatMap((item) => [
    `- ${item.name}：${item.description}`,
  ]);
  const stepLines = TOOL_STEPS.flatMap((item, index) => [
    `${index + 1}. ${item.text} → \`${item.tool}\``,
  ]);
  const prereqLines = PREREQ.flatMap((item) => [
    `> 发送「${item.ask}」`,
    "",
    item.text,
    "",
  ]);
  return [
    "# OKF 文库使用说明",
    "",
    "会话工作区里的 `OKF/` 就是知识库。浏览器不读这个文件夹；文献 / 图谱 / 校对 / 覆盖 / 综述 / 笔记 都来自快照。下次可以直接问：「okf 是否有使用说明」。",
    "",
    "## 开始之前",
    "",
    ...prereqLines,
    "## 怎么问出这份说明",
    "",
    ...ASK_WITH.map((item) => `- ${item}`),
    "",
    "## 子页",
    "",
    "- 说明：本页",
    ...subpageLines,
    "",
    "## 工具怎么选（不要把全文倒进对话）",
    "",
    ...stepLines,
    "",
    "只引用工具返回的 `papers/`、`claims/` id。不要编造 DOI。不要无范围地对 1000 篇调用 `okf_compare`。",
    "",
    "## 可复制的测试提问",
    "",
    "一条对话测一类。测完看轨迹里的工具名，再到对应子页点刷新。",
    "",
    ...exampleLines,
  ].join("\n");
}

export function okfHelp(): OkfHelp {
  return {
    title: "OKF 文库使用说明",
    askWith: ASK_WITH,
    markdown: helpMarkdown(),
    examples: EXAMPLES,
    subpages: SUBPAGES,
    toolSteps: TOOL_STEPS,
    prereq: PREREQ,
  };
}
