import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import initSqlJs, { type SqlJsStatic } from "sql.js";

const require = createRequire(fileURLToPath(import.meta.url));
const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");

let cached: Promise<SqlJsStatic> | undefined;

export function loadSqlJs(): Promise<SqlJsStatic> {
  cached ??= initSqlJs({ locateFile: () => wasmPath });
  return cached;
}
