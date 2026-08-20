import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

let cached: Promise<SqlJsStatic> | undefined;

export function loadSqlJs(): Promise<SqlJsStatic> {
  cached ??= initSqlJs({ locateFile: () => wasmUrl });
  return cached;
}
