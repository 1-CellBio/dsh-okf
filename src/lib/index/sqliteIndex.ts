import type { Database, SqlJsStatic } from "sql.js";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { okfCachePath } from "@/lib/okf/cache";
import { toConceptId } from "@/lib/okf/links";
import type { ConceptRecord, OkfStatus } from "@/types/okf";
import {
  extractsByPaperMap,
  listIndexableMarkdown,
  parseConceptRecord,
  toCatalogRecord,
} from "./catalog";
import type { SearchEngine, SearchHit } from "./search";
import { all, one } from "./sqlRows";
import { loadStamps, stampEquals, stampPaths, upsertStamp } from "./stamps";

export const FTS_PATH = okfCachePath("fts.sqlite");
export const FTS_SCHEMA = "5";

/**
 * Single Han characters that add retrieval noise when indexed alone (function
 * words, particles, common pronouns). Bigrams containing them are still kept,
 * so phrases like "基因的表达" remain searchable via "表达".
 */
const HAN_STOP_SINGLE = new Set([
  "的", "了", "是", "在", "和", "与", "及", "就", "都", "而", "或", "其", "之", "于",
  "也", "对", "从", "到", "由", "被", "把", "以", "为", "所", "因", "但", "并", "且",
  "这", "那", "有", "中", "上", "下", "个", "等", "更", "又", "再", "已", "将", "还",
  "若", "则", "即", "吗", "呢", "吧", "啊", "哦", "我", "你", "他", "她", "它", "们",
]);

export function ftsTokens(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9+-]{1,}/g)) {
    out.add(match[0]);
  }
  const hans = [...text.matchAll(/\p{Script=Han}/gu)].map((match) => match[0]);
  for (let i = 0; i < hans.length; i += 1) {
    const ch = hans[i];
    if (ch && !HAN_STOP_SINGLE.has(ch)) {
      out.add(ch);
    }
    const next = hans[i + 1];
    if (ch && next) {
      out.add(`${ch}${next}`);
    }
  }
  return [...out];
}

export class SqliteSearchEngine implements SearchEngine {
  constructor(private readonly db: Database) {}

  search(query: string): SearchHit[] {
    const tokens = ftsTokens(query);
    if (tokens.length === 0) {
      return [];
    }
    const clauses = tokens.map(() => "(t.token = ? OR t.token GLOB ?)").join(" OR ");
    const params = tokens.flatMap((token) => [token, `${token}*`]);
    // Score per matched token = token-length weight × IDF × title boost.
    // Longer tokens (bigrams/words) are more selective than single chars, so
    // weight them higher. IDF (precomputed in fts_stats) down-ranks common
    // tokens, and a title match (fts_title_tokens) boosts the row further.
    const stmt = this.db.prepare(
      `SELECT t.id, SUM(
         (CASE WHEN length(t.token) >= 2 THEN 2 ELSE 1 END)
         * COALESCE(s.idf, 1.0)
         * (CASE WHEN tt.id IS NULL THEN 1 ELSE 3 END)
       ) AS score
       FROM fts_tokens t
       LEFT JOIN fts_stats s ON s.token = t.token
       LEFT JOIN fts_title_tokens tt ON tt.token = t.token AND tt.id = t.id
       WHERE ${clauses}
       GROUP BY t.id ORDER BY score DESC LIMIT 40`,
    );
    stmt.bind(params);
    const hits: SearchHit[] = [];
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const id = String(row.id ?? "");
        if (id) {
          hits.push({ id, score: Number(row.score ?? 0) });
        }
      }
    } finally {
      stmt.free();
    }
    return hits;
  }

  getBody(id: string): string | undefined {
    const stmt = this.db.prepare(`SELECT body FROM fts_docs WHERE id = ?`);
    stmt.bind([id]);
    const row = one(stmt);
    return row ? String(row.body ?? "") : undefined;
  }

  dispose(): void {
    this.db.close();
  }
}

function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS fts_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fts_stamps (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms INTEGER,
      hash TEXT
    );
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      published TEXT,
      tags TEXT NOT NULL,
      status TEXT NOT NULL,
      verified INTEGER NOT NULL,
      paper TEXT,
      doi TEXT,
      outgoing TEXT NOT NULL,
      confidence TEXT,
      stance TEXT,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fts_docs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fts_tokens (
      token TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (token, id)
    );
    CREATE INDEX IF NOT EXISTS fts_tokens_token ON fts_tokens(token);
    CREATE TABLE IF NOT EXISTS fts_title_tokens (
      token TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (token, id)
    );
    CREATE TABLE IF NOT EXISTS fts_stats (
      token TEXT PRIMARY KEY,
      idf REAL NOT NULL
    );
  `);
  db.run(`INSERT OR REPLACE INTO fts_meta(key, value) VALUES ('schema', ?)`, [FTS_SCHEMA]);
}

function schemaOk(db: Database): boolean {
  try {
    const stmt = db.prepare(`SELECT value FROM fts_meta WHERE key = 'schema'`);
    const row = one(stmt);
    return row?.value === FTS_SCHEMA;
  } catch {
    return false;
  }
}

function insertTokens(db: Database, id: string, text: string): void {
  const tokens = ftsTokens(text);
  const chunk = 80;
  for (let i = 0; i < tokens.length; i += chunk) {
    const slice = tokens.slice(i, i + chunk);
    const placeholders = slice.map(() => "(?, ?)").join(", ");
    const params = slice.flatMap((token) => [token, id]);
    db.run(`INSERT OR IGNORE INTO fts_tokens(token, id) VALUES ${placeholders}`, params);
  }
}

function insertTitleTokens(db: Database, id: string, title: string): void {
  const tokens = ftsTokens(title);
  if (tokens.length === 0) {
    return;
  }
  const chunk = 80;
  for (let i = 0; i < tokens.length; i += chunk) {
    const slice = tokens.slice(i, i + chunk);
    const placeholders = slice.map(() => "(?, ?)").join(", ");
    const params = slice.flatMap((token) => [token, id]);
    db.run(`INSERT OR IGNORE INTO fts_title_tokens(token, id) VALUES ${placeholders}`, params);
  }
}

function insertRecord(db: Database, record: ConceptRecord): void {
  const catalog = toCatalogRecord(record);
  db.run("BEGIN");
  try {
    db.run(`DELETE FROM docs WHERE id = ?`, [record.id]);
    db.run(`DELETE FROM fts_docs WHERE id = ?`, [record.id]);
    db.run(`DELETE FROM fts_tokens WHERE id = ?`, [record.id]);
    db.run(`DELETE FROM fts_title_tokens WHERE id = ?`, [record.id]);
    db.run(
      `INSERT INTO docs(id, path, type, title, published, tags, status, verified, paper, doi, outgoing, confidence, stance, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        catalog.id,
        catalog.path,
        catalog.type,
        catalog.title ?? null,
        catalog.published ?? null,
        JSON.stringify(catalog.tags),
        catalog.status,
        catalog.verifiedHuman ? 1 : 0,
        catalog.paper ?? null,
        catalog.doi ?? null,
        JSON.stringify(catalog.outgoing),
        catalog.confidence ?? null,
        catalog.stance ?? null,
        catalog.body,
      ],
    );
    const title = record.title ?? record.id;
    db.run(`INSERT INTO fts_docs(id, type, title, body) VALUES (?, ?, ?, ?)`, [
      record.id,
      record.type,
      title,
      record.body,
    ]);
    insertTokens(db, record.id, `${title}\n${record.body}`);
    insertTitleTokens(db, record.id, title);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): ConceptRecord {
  return {
    id: String(row.id),
    path: String(row.path),
    type: String(row.type),
    title: row.title == null ? undefined : String(row.title),
    published: row.published == null ? undefined : String(row.published),
    tags: parseJsonArray(String(row.tags ?? "[]")),
    status: String(row.status) as OkfStatus,
    verifiedHuman: Number(row.verified) === 1,
    paper: row.paper == null ? undefined : String(row.paper),
    doi: row.doi == null ? undefined : String(row.doi),
    outgoing: parseJsonArray(String(row.outgoing ?? "[]")),
    // Schema v4 restored these; older libs rebuilt with a fresh table so the
    // columns are always present after a sync.
    confidence: row.confidence == null || row.confidence === "" ? undefined : String(row.confidence),
    stance: row.stance == null || row.stance === "" ? undefined : String(row.stance),
    body: String(row.body ?? ""),
  };
}

function loadConcepts(db: Database): Map<string, ConceptRecord> {
  const stmt = db.prepare(`SELECT * FROM docs`);
  const concepts = new Map<string, ConceptRecord>();
  for (const row of all(stmt)) {
    const record = rowToRecord(row);
    concepts.set(record.id, record);
  }
  return concepts;
}

function removePath(db: Database, path: string): void {
  const id = toConceptId(path);
  db.run(`DELETE FROM docs WHERE id = ?`, [id]);
  db.run(`DELETE FROM fts_docs WHERE id = ?`, [id]);
  db.run(`DELETE FROM fts_tokens WHERE id = ?`, [id]);
  db.run(`DELETE FROM fts_title_tokens WHERE id = ?`, [id]);
  db.run(`DELETE FROM fts_stamps WHERE path = ?`, [path]);
}

/** Rebuild IDF (inverse document frequency) stats from the current token table. */
function rebuildStats(db: Database): void {
  const total = Number(one(db.prepare(`SELECT COUNT(*) AS n FROM docs`))?.n ?? 0);
  const rows = all(db.prepare(`SELECT token, COUNT(DISTINCT id) AS df FROM fts_tokens GROUP BY token`));
  db.run(`DELETE FROM fts_stats`);
  for (const row of rows) {
    const df = Math.max(1, Number(row.df ?? 1));
    const idf = Math.log((total + 1) / (df + 1)) + 1;
    db.run(`INSERT OR REPLACE INTO fts_stats(token, idf) VALUES (?, ?)`, [String(row.token), idf]);
  }
}

export type SqliteIndexResult = {
  concepts: Map<string, ConceptRecord>;
  search: SearchEngine;
  extractsByPaper: Map<string, string>;
  changed: number;
};

export async function syncSqliteIndex(
  store: FileStore,
  SQL: SqlJsStatic,
  options?: { persist?: boolean; onProgress?: (info: { done: number; total: number; changed: number }) => void },
): Promise<SqliteIndexResult> {
  const persist = options?.persist !== false;
  let db: Database | undefined;
  if (persist && (await store.exists(FTS_PATH))) {
    try {
      const bytes = await store.read(FTS_PATH);
      db = new SQL.Database(new Uint8Array(bytes));
      if (!schemaOk(db)) {
        db.close();
        db = undefined;
      }
    } catch {
      db = undefined;
    }
  }
  if (!db) {
    db = new SQL.Database();
    initSchema(db);
  }

  const paths = await listIndexableMarkdown(store);
  const previous = loadStamps(db, "fts_stamps");
  const seen = new Set<string>();
  let changed = 0;
  let done = 0;

  // Stat every file concurrently first; only changed files are read and parsed
  // below, so 10k sequential stat calls collapse into one bounded batch.
  const stamps = await stampPaths(store, paths);
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i]!;
    const stamp = stamps[i]!;
    seen.add(path);
    const old = previous.get(path);
    if (old && stampEquals(old, stamp)) {
      done += 1;
      options?.onProgress?.({ done, total: paths.length, changed });
      continue;
    }
    const record = parseConceptRecord(path, utf8Decode(await store.read(path)));
    if (!record) {
      removePath(db, path);
      upsertStamp(db, "fts_stamps", path, stamp);
      changed += 1;
      done += 1;
      options?.onProgress?.({ done, total: paths.length, changed });
      continue;
    }
    insertRecord(db, record);
    upsertStamp(db, "fts_stamps", path, stamp);
    changed += 1;
    done += 1;
    options?.onProgress?.({ done, total: paths.length, changed });
  }

  for (const path of previous.keys()) {
    if (!seen.has(path)) {
      removePath(db, path);
      changed += 1;
    }
  }

  // IDF stats depend on the token corpus, so rebuild them whenever any token
  // changed (skipped when nothing changed and the stats are already valid).
  if (changed > 0) {
    rebuildStats(db);
  }

  if (persist && (changed > 0 || !(await store.exists(FTS_PATH)))) {
    await store.write(FTS_PATH, db.export());
  }

  const concepts = loadConcepts(db);
  return {
    concepts,
    search: new SqliteSearchEngine(db),
    extractsByPaper: extractsByPaperMap(concepts),
    changed,
  };
}
