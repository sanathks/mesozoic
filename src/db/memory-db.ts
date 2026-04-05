/**
 * SQLite memory store — built on Node 24's native node:sqlite (no extra deps).
 *
 * Hybrid retrieval combines three signals:
 *   text relevance  — FTS5 with porter stemmer (rank column)
 *   importance      — starts at 1.0, decays 5%/day via the dream job
 *   recency         — exponential decay with 20-day half-life
 *
 * hybrid_score = (-rank) × importance × exp(−age / HALF_LIFE)
 *
 * Importance lifecycle:
 *   insert           → 1.0
 *   each access      → ×1.15 (capped at 1.0)
 *   dream decay/day  → ×0.95
 *   floor            → 0.05 (entries never fully vanish from DB)
 *   soft-delete      → when at floor AND not accessed in 30 days
 */

import Database from "better-sqlite3";
import fs from "node:fs";

// ─── Paths ────────────────────────────────────────────────────────────────────

export function getMemoryDir(): string {
  return process.env.MESO_MEMORY_DIR || `${process.env.HOME || ""}/.meso/runtime/memory`;
}

export function getMemoryDbPath(): string {
  return process.env.MESO_MEMORY_DB || `${getMemoryDir()}/memory.db`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: number;
  content: string;
  category: string;
  sourceThread: string | null;
  createdAt: number;        // unix seconds
  lastAccessedAt: number | null;
  accessCount: number;
  importance: number;       // 0.05 – 1.0
  pinned: number;           // 1 = user explicitly asked to remember this — never decays
}

export interface SearchResult extends MemoryRow {
  hybridScore: number;
  snippet: string;          // FTS5 snippet with >> << markers
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _db: Database | null = null;
let _dbPath = "";

export function getDb(): Database {
  const dbPath = getMemoryDbPath();
  if (_db && _dbPath === dbPath) return _db;
  if (_db && _dbPath !== dbPath) {
    _db.close();
    _db = null;
  }
  fs.mkdirSync(getMemoryDir(), { recursive: true });
  _db = new Database(dbPath);
  _dbPath = dbPath;
  _db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  initSchema(_db);
  return _db;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      content          TEXT    NOT NULL,
      category         TEXT    NOT NULL DEFAULT 'general',
      source_thread    TEXT,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count     INTEGER NOT NULL DEFAULT 0,
      importance       REAL    NOT NULL DEFAULT 1.0,
      pinned           INTEGER NOT NULL DEFAULT 0,  -- 1 = explicitly pinned by user
      is_deleted       INTEGER NOT NULL DEFAULT 0
    );

    -- FTS5 virtual table — porter stemmer for fuzzy prefix matching
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content     = memories,
      content_rowid = id,
      tokenize    = 'porter unicode61'
    );

    -- Keep FTS5 in sync via triggers
    CREATE TRIGGER IF NOT EXISTS memories_ai
    AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category)
      VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au
    AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category)
      VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category)
      VALUES (new.id, new.content, new.category);
    END;

    -- Dream run history
    CREATE TABLE IF NOT EXISTS dream_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at           INTEGER NOT NULL,
      entries_processed INTEGER,
      entries_faded    INTEGER,
      summary          TEXT
    );
  `);
}

// ─── Write ops ────────────────────────────────────────────────────────────────

export function insertMemory(
  content: string,
  category: string,
  sourceThread?: string,
  pinned = false,
): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO memories (content, category, source_thread, created_at, pinned)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(content, category, sourceThread ?? null, unixNow(), pinned ? 1 : 0);
  return result.lastInsertRowid as number;
}

export function softDeleteMemory(id: number): boolean {
  const db = getDb();
  const r = db
    .prepare(`UPDATE memories SET is_deleted = 1 WHERE id = ? AND is_deleted = 0`)
    .run(id);
  return (r.changes as number) > 0;
}

// ─── Search ───────────────────────────────────────────────────────────────────

// Recency half-life: score halves every HALF_LIFE seconds
const HALF_LIFE_SECS = 20 * 86400; // 20 days
const MIN_IMPORTANCE = 0.05;

export function searchMemories(query: string, limit = 10): SearchResult[] {
  const db = getDb();
  const now = unixNow();
  const ftsQuery = toFtsQuery(query);

  let rows: SearchResult[] = [];

  try {
    rows = db
      .prepare(
        `SELECT
           m.id,
           m.content,
           m.category,
           m.source_thread    AS sourceThread,
           m.created_at       AS createdAt,
           m.last_accessed_at AS lastAccessedAt,
           m.access_count     AS accessCount,
           m.importance,
           m.pinned,
           snippet(memories_fts, 0, '>>', '<<', '...', 12) AS snippet,
           CASE WHEN m.pinned = 1 THEN 999
                ELSE (-memories_fts.rank) * m.importance
                       * exp(-cast((? - m.created_at) AS real) / ?)
           END AS hybridScore
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
           AND m.is_deleted = 0
         ORDER BY hybridScore DESC
         LIMIT ?`,
      )
      .all(now, HALF_LIFE_SECS, ftsQuery, limit) as SearchResult[];
  } catch {
    // FTS5 throws on malformed queries - fall through to LIKE
  }

  // If FTS returned nothing, try OR semantics (any token matches)
  if (rows.length === 0) {
    const orFtsQuery = toFtsQueryOr(query);
    try {
      rows = db
        .prepare(
          `SELECT
             m.id,
             m.content,
             m.category,
             m.source_thread    AS sourceThread,
             m.created_at       AS createdAt,
             m.last_accessed_at AS lastAccessedAt,
             m.access_count     AS accessCount,
             m.importance,
             m.pinned,
             snippet(memories_fts, 0, '>>', '<<', '...', 12) AS snippet,
             CASE WHEN m.pinned = 1 THEN 999
                  ELSE (-memories_fts.rank) * m.importance
                         * exp(-cast((? - m.created_at) AS real) / ?)
             END AS hybridScore
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ?
             AND m.is_deleted = 0
           ORDER BY hybridScore DESC
           LIMIT ?`,
        )
        .all(now, HALF_LIFE_SECS, orFtsQuery, limit) as SearchResult[];
    } catch { /* fall through */ }
  }

  // Last resort: LIKE search across content
  if (rows.length === 0) {
    rows = likeSearch(query, limit);
  }

  // Record access (fire-and-forget - don't throw on failure)
  if (rows.length > 0) {
    try {
      const ids = rows.map((r) => r.id);
      const ph = ids.map(() => "?").join(",");
      db.prepare(
        `UPDATE memories
         SET access_count = access_count + 1,
             last_accessed_at = ?
         WHERE id IN (${ph})`,
      ).run(now, ...ids);
    } catch { /* non-fatal */ }
  }

  return rows;
}

function likeSearch(query: string, limit: number): SearchResult[] {
  const db = getDb();
  const now = unixNow();
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT
         id, content, category,
         source_thread    AS sourceThread,
         created_at       AS createdAt,
         last_accessed_at AS lastAccessedAt,
         access_count     AS accessCount,
         importance,
         pinned,
         content          AS snippet,
         CASE WHEN pinned = 1 THEN 999
              ELSE importance * exp(-cast((? - created_at) AS real) / ?)
         END AS hybridScore
       FROM memories
       WHERE (content LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')
         AND is_deleted = 0
       ORDER BY hybridScore DESC
       LIMIT ?`,
    )
    .all(now, HALF_LIFE_SECS, like, like, limit) as SearchResult[];
}

/** Convert free text to an FTS5 MATCH expression with prefix matching (AND semantics) */
function toFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/['"+()^{}[\]|&!]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  // Each token becomes a prefix match; multi-token = implicit AND
  return tokens.map((t) => `${t}*`).join(" ");
}

/** Convert free text to an FTS5 MATCH expression with OR semantics - any token matches */
function toFtsQueryOr(raw: string): string {
  const tokens = raw
    .replace(/['"+()^{}[\]|&!]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `${t}*`).join(" OR ");
}

// ─── Dream helpers ────────────────────────────────────────────────────────────

/** All active entries for the dream consolidation prompt */
export function getActiveMemories(limit = 300): MemoryRow[] {
  return getDb()
    .prepare(
      `SELECT
         id, content, category,
         source_thread    AS sourceThread,
         created_at       AS createdAt,
         last_accessed_at AS lastAccessedAt,
         access_count     AS accessCount,
         importance,
         pinned
       FROM memories
       WHERE is_deleted = 0
       ORDER BY pinned DESC, importance DESC, created_at DESC
       LIMIT ?`,
    )
    .all(limit) as MemoryRow[];
}

/**
 * Apply importance decay for `daysSince` days at 5 %/day, then
 * soft-delete entries that hit the floor and haven't been accessed recently.
 * Returns counts for the dream log.
 */
export function applyImportanceDecay(daysSince: number): {
  processed: number;
  faded: number;
} {
  const db = getDb();
  const decayFactor = Math.pow(0.95, Math.max(0, daysSince));
  const thirtyDaysAgo = unixNow() - 30 * 86400;

  // Pinned entries are immune to decay
  const updated = db
    .prepare(
      `UPDATE memories
       SET importance = MAX(?, importance * ?)
       WHERE is_deleted = 0 AND pinned = 0`,
    )
    .run(MIN_IMPORTANCE, decayFactor);

  // Soft-delete: at floor AND cold AND not pinned
  const faded = db
    .prepare(
      `UPDATE memories
       SET is_deleted = 1
       WHERE importance <= ?
         AND (last_accessed_at IS NULL OR last_accessed_at < ?)
         AND is_deleted = 0
         AND pinned = 0`,
    )
    .run(MIN_IMPORTANCE + 0.001, thirtyDaysAgo);

  return {
    processed: updated.changes as number,
    faded: faded.changes as number,
  };
}

export function logDream(
  entriesProcessed: number,
  entriesFaded: number,
  summary: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO dream_log (ran_at, entries_processed, entries_faded, summary)
       VALUES (?, ?, ?, ?)`,
    )
    .run(unixNow(), entriesProcessed, entriesFaded, summary);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function getStats(): {
  total: number;
  active: number;
  faded: number;
  avgImportance: number;
} {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*)                                              AS total,
         SUM(CASE WHEN is_deleted = 0 THEN 1 ELSE 0 END)     AS active,
         SUM(CASE WHEN is_deleted = 1 THEN 1 ELSE 0 END)     AS faded,
         ROUND(AVG(CASE WHEN is_deleted=0 THEN importance END), 3) AS avgImportance
       FROM memories`,
    )
    .get() as { total: number; active: number; faded: number; avgImportance: number };
  return row;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
