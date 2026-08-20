export const AGENTS_PROTOCOL = `# Agent protocol

This folder is an OKF knowledge bundle. The Markdown files are the knowledge. Indexes under \`.okf/\` are rebuildable caches.

1. Read \`index.md\` first. Do not read \`extracts/\` end-to-end; they are a search corpus.
2. Cite papers and claims with bundle paths such as \`papers/2017-attention-is-all-you-need\` or \`claims/...\`, or markdown links \`[title](/papers/....md)\`.
3. Never invent a Paper id, Claim id, or DOI. If it is not in this folder, say so.
4. \`published\` is the scientific publication date. \`generated.at\` is compile time.
5. Do not overwrite files whose frontmatter \`verified.by\` starts with \`human:\`.
6. Optional MCP: \`pnpm kg mcp\` exposes \`search\`, \`get_concept\`, \`list_coverage\`, \`compile_survey\`, \`save_note\` on this folder. It is not a second store.
`;
