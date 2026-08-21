import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "tsdown";
import { transform } from "lightningcss";

const root = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ID = "dsh-okf";

// `graphology`/`sigma` extend Node's `events.EventEmitter`. In the browser
// plugin loader `events` is neither a platform module nor materialized, so it
// must be bundled with the npm `events` polyfill instead of being externalized
// as a Node builtin. Resolve it from graphology's dependency context (pnpm
// isolates it from the project root). Note: `require.resolve("events")` returns
// the bare specifier (Node builtin), so we must resolve the package subpath to
// get the real file path on disk.
const _require = createRequire(import.meta.url);
const EVENTS_ENTRY = createRequire(_require.resolve("graphology")).resolve("events/events.js");

const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
] as const;

const CSS_VIRTUAL_PREFIX = "\0dsh-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";

const node: UserConfig = {
  name: PACKAGE_ID,
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  platform: "node",
  target: "es2024",
  fixedExtension: false,
  dts: false,
  clean: false,
  alias: {
    "@": path.resolve(root, "./src"),
  },
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^@napi-rs\//, /^@firecrawl\//, "pdfjs-dist"],
  },
};

const client: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  dts: false,
  sourcemap: true,
  clean: false,
  alias: {
    // graphology and sigma extend `events.EventEmitter`; alias the Node
    // builtin name to the npm events polyfill so it is bundled instead of
    // staying external (the browser plugin loader cannot resolve `events`).
    events: EVENTS_ENTRY,
  },
  deps: {
    neverBundle: [...PLATFORM_MODULES],
    alwaysBundle: [
      /^sigma(\/.*)?$/,
      /^graphology(\/.*)?$/,
      /^graphology-layout-forceatlas2(\/.*)?$/,
      /^graphology-utils(\/.*)?$/,
      /^@sigma\/(node-border|utils)(\/.*)?$/,
    ],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    "import.meta.env.MODE": JSON.stringify(process.env.NODE_ENV ?? "production"),
    "import.meta.env": JSON.stringify({ MODE: process.env.NODE_ENV ?? "production" }),
  },
  plugins: [{
    name: "dsh-client-bundle-purity",
    resolveId(source: string) {
      if (!source.startsWith("@deepseek-ai/")) return null;
      if ((PLATFORM_MODULES as readonly string[]).includes(source)) return null;
      throw new Error(
        `client bundle purity: "${source}" is not a platform module — use type-only imports or cordis services`,
      );
    },
  }, {
    name: "dsh-css-modules-inline",
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(".module.css")) return null;
      const abs = importer !== undefined ? path.resolve(path.dirname(importer), source) : source;
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX;
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
      this.addWatchFile(fileId);
      const source = await readFile(fileId);
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: "[hash]_[local]" },
        minify: true,
      });
      const classMap: Record<string, string> = {};
      for (const [local, exp] of Object.entries(cssExports ?? {})) {
        classMap[local] = exp.name;
      }
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${PACKAGE_ID}/${path.basename(fileId)}`)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
        "  tag.dataset.pluginCss = tagId;",
        "  tag.textContent = css;",
        "  document.head.appendChild(tag);",
        "}",
        `export default ${JSON.stringify(classMap)};`,
      ].join("\n");
    },
  }],
  outputOptions: {
    entryFileNames: "client.js",
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
};

export default defineConfig([node, client]);
