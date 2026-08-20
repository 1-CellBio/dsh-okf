import type { Statement } from "sql.js";

/** Drain a prepared statement into rows and free it. */
export function all(stmt: Statement): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** Read at most one row from a prepared statement and free it. */
export function one(stmt: Statement): Record<string, unknown> | undefined {
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}
