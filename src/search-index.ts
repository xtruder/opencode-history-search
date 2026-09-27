import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import { parseDateFilter } from "./date-filter";
import { parseQuery, type ParsedQuery } from "./query";
import type { EditsResult, FileEdit, MessagesResult, SessionMatch } from "./results";

type Value = string | number | null;
type Filter = { sql: string; values: Value[] };

/** Inputs shared by both search tools; scope and text live in `query`. */
export interface SearchFilters {
  query?: string;
  role?: "user" | "assistant";
  date?: string;
  limit?: number;
}

interface Database {
  prepare(sql: string): {
    all(...args: Value[]): unknown[];
    run(...args: Value[]): { lastInsertRowid: number | bigint };
  };
  exec(sql: string): unknown;
  close(): unknown;
}

const sessionSchema = z.object({
  id: z.string(),
  projectID: z.string(),
  title: z.string().optional(),
  location: z.object({ directory: z.string() }),
  time: z.object({ updated: z.number(), idle: z.number().optional() }),
});
const fingerprintSchema = z.object({
  updated: z.number(),
  title: z.string(),
  projectID: z.string(),
  directory: z.string(),
});

/** Session metadata that decides whether an indexed session is stale. */
export type SessionFingerprint = z.infer<typeof fingerprintSchema>;

/**
 * Last activity of a session. OpenCode bumps time.updated only for session
 * changes (title, move, revert); new messages leave it alone but set
 * time.idle when the turn ends, so the later of the two tracks new messages.
 */
function activity(time: { updated: number; idle?: number }): number {
  return Math.max(time.updated, time.idle ?? 0);
}

export function sessionFingerprint(input: z.input<typeof sessionSchema>): SessionFingerprint {
  return {
    updated: activity(input.time),
    // Must match the stored title so untitled sessions don't look stale on every scan.
    title: input.title ?? "Untitled session",
    projectID: input.projectID,
    directory: input.location.directory,
  };
}

export function sameFingerprint(a: SessionFingerprint, b: SessionFingerprint): boolean {
  return (
    a.updated === b.updated &&
    a.title === b.title &&
    a.projectID === b.projectID &&
    a.directory === b.directory
  );
}

const messageSchema = z
  .object({ id: z.string(), type: z.string(), time: z.object({ created: z.number() }) })
  .passthrough();
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? z.record(z.string(), z.unknown()).parse(value)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const normalizePath = (path: string) => path.replaceAll("\\", "/");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function extract(message: Record<string, unknown>): {
  text: string;
  paths: { path: string; tool: string | null }[];
} {
  const texts: string[] = [];
  const paths = new Map<string, string | null>();

  if (typeof message.text === "string") {
    texts.push(message.text);
  }

  for (const raw of array(message.content)) {
    const part = object(raw);

    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      texts.push(part.text);
    }

    if (
      part.type !== "tool" ||
      typeof part.name !== "string" ||
      !part.state ||
      typeof part.state !== "object"
    ) {
      continue;
    }

    const state = object(part.state);

    texts.push(part.name);
    if (state.input !== undefined) {
      texts.push(JSON.stringify(state.input));
    }

    for (const output of array(state.content)) {
      const content = object(output);

      if (content.type === "text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }

    const path = object(state.input).filePath;

    if (
      ["edit", "write"].includes(part.name) &&
      state.status === "completed" &&
      typeof path === "string"
    ) {
      paths.set(normalizePath(path), part.name);
    }
  }

  for (const path of array(object(message.snapshot).files)) {
    if (typeof path !== "string") {
      continue;
    }

    texts.push(path);
    if (!paths.has(normalizePath(path))) {
      paths.set(normalizePath(path), null);
    }
  }

  return { text: texts.join("\n"), paths: [...paths].map(([path, tool]) => ({ path, tool })) };
}

function excerpt(text: string, query: string): string {
  const start = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase()) - 100);

  return text.slice(start, start + 300);
}

const schemaVersion = 2;
const schema = `
  -- One row per session: the session metadata shown in results, plus the
  -- bookkeeping that lets backfill and live sync write concurrently.
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    title TEXT,
    directory TEXT,
    -- Last activity (see activity()); orders results and detects stale sessions.
    updated INTEGER,
    -- Start of the fetch that produced the indexed content; older fetches are rejected.
    fetched_at INTEGER NOT NULL,
    -- Tombstone, so a fetch that started before the deletion can't write it back.
    deleted_at INTEGER
  );

  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    message_id TEXT NOT NULL,
    -- Copied from sessions so scope filters seek documents_scope without a
    -- join; safe because replaceSession rewrites both together.
    project_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    UNIQUE (session_id, message_id)
  );

  -- project_id is copied from sessions for the same reason as in documents.
  CREATE TABLE document_paths (
    document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    basename TEXT NOT NULL,
    tool TEXT
  );

  -- path/basename lead so project:all lookups still seek.
  CREATE INDEX document_paths_path ON document_paths (path, project_id);
  CREATE INDEX document_paths_basename ON document_paths (basename, project_id);
  CREATE INDEX document_paths_document ON document_paths (document_id);
  CREATE INDEX documents_scope ON documents (project_id, role, timestamp);
  CREATE INDEX documents_sequence ON documents (session_id, role, seq);

  CREATE VIRTUAL TABLE documents_fts USING fts5 (
    text,
    content = 'documents',
    content_rowid = 'id',
    tokenize = 'trigram case_sensitive 0'
  );

  CREATE TRIGGER documents_insert AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts (rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TRIGGER documents_delete AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts (documents_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`;

export class SearchIndex {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static async open(path: string): Promise<SearchIndex> {
    for (let attempt = 0; ; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Retry only SQLite startup lock contention.
        return await SearchIndex.initialize(path);
      } catch (error) {
        // Read fields directly: Error instances are not plain records for zod.
        const details: { errcode?: unknown; code?: unknown } =
          error && typeof error === "object" ? error : {};
        const busy = details.errcode === 5 || details.code === "SQLITE_BUSY";

        if (!busy || attempt >= 9) {
          throw error;
        }

        // journal_mode can return BUSY without invoking SQLite's busy handler.
        // eslint-disable-next-line no-await-in-loop -- Bounded backoff between initialization attempts.
        await sleep(50 * (attempt + 1));
      }
    }
  }

  private static async initialize(path: string): Promise<SearchIndex> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const db = process.versions.bun
      ? new (await import("bun:sqlite")).Database(path, { readonly: false, create: true })
      : new (await import("node:sqlite")).DatabaseSync(path);

    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        -- Required for document_paths cascades; bun:sqlite leaves it off by default.
        PRAGMA foreign_keys = ON;
      `);
      db.exec("BEGIN IMMEDIATE");
      try {
        const [{ user_version: version }] = z
          .tuple([z.object({ user_version: z.number() })])
          .parse(db.prepare("PRAGMA user_version").all());

        // The index is a disposable cache: an older layout is dropped and
        // rebuilt by backfill instead of migrated.
        if (version !== schemaVersion) {
          db.exec(`
            DROP TRIGGER IF EXISTS documents_insert;
            DROP TRIGGER IF EXISTS documents_delete;
            DROP TABLE IF EXISTS documents_fts;
            DROP TABLE IF EXISTS document_paths;
            DROP TABLE IF EXISTS documents;
            DROP TABLE IF EXISTS sessions;
            ${schema}
            PRAGMA user_version = ${schemaVersion};
          `);
        }

        // A day is far longer than any fetch a tombstone has to outlast.
        db.prepare("DELETE FROM sessions WHERE deleted_at < ?").run(Date.now() - 86_400_000);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return new SearchIndex(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Remove a session and leave a tombstone: a fetch that started before
   * `deletedAt` can no longer write it back (see replaceSession).
   */
  removeSession(id: string, deletedAt = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM documents WHERE session_id=?").run(id);
      this.db
        .prepare(
          `INSERT INTO sessions (id, fetched_at, deleted_at) VALUES (?, 0, ?)
           ON CONFLICT (id) DO UPDATE SET deleted_at = max(coalesce(deleted_at, 0), excluded.deleted_at)`,
        )
        .run(id, deletedAt);
    });
  }

  sessionFingerprints(): Map<string, SessionFingerprint> {
    return new Map(
      this.db
        .prepare(
          `SELECT id, updated, title, project_id AS projectID, directory
           FROM sessions WHERE deleted_at IS NULL`,
        )
        .all()
        .map((row) => {
          const { id, ...fingerprint } = fingerprintSchema.extend({ id: z.string() }).parse(row);
          return [id, fingerprint];
        }),
    );
  }

  /**
   * Replace a session's indexed content with a fetch that started at
   * `fetchedAt`. Backfill and live sync refresh sessions concurrently, so a
   * slow, older fetch can finish last: it is skipped (returns false) when a
   * newer fetch was already written or the session was deleted after it began.
   * The check and the write share one write-locked transaction, which also
   * covers other processes using the same index file.
   */
  replaceSession(input: unknown, messages: unknown[], fetchedAt = Date.now()): boolean {
    const session = sessionSchema.parse(input);
    const insert = this.db.prepare(
      `INSERT INTO documents (session_id, message_id, project_id, timestamp, seq, role, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPath = this.db.prepare(
      `INSERT INTO document_paths (document_id, project_id, path, basename, tool)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const add = (
      id: string,
      role: string,
      timestamp: number,
      seq: number,
      text: string,
      paths: { path: string; tool: string | null }[],
    ) => {
      // Search uses Unicode scalar text, not JavaScript's lone-surrogate substring semantics.
      const scalar = text.toWellFormed().replaceAll("\0", "\uFFFD");
      const { lastInsertRowid } = insert.run(
        session.id,
        id,
        session.projectID,
        timestamp,
        seq,
        role,
        scalar,
      );

      for (const { path, tool } of paths) {
        insertPath.run(Number(lastInsertRowid), session.projectID, path, basename(path), tool);
      }
    };

    return this.transaction(() => {
      const [current] = z
        .array(z.object({ fetched_at: z.number(), deleted_at: z.number().nullable() }))
        .parse(
          this.db.prepare("SELECT fetched_at, deleted_at FROM sessions WHERE id=?").all(session.id),
        );

      // Ties go to the later write, so repeated writes of one fetch time still apply.
      if (current && (current.fetched_at > fetchedAt || (current.deleted_at ?? -1) >= fetchedAt)) {
        return false;
      }

      const title = session.title ?? "Untitled session";
      const updated = activity(session.time);

      this.db
        .prepare(
          `INSERT INTO sessions (id, project_id, title, directory, updated, fetched_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (id) DO UPDATE SET
             project_id = excluded.project_id,
             title = excluded.title,
             directory = excluded.directory,
             updated = excluded.updated,
             fetched_at = excluded.fetched_at,
             deleted_at = NULL`,
        )
        .run(session.id, session.projectID, title, session.location.directory, updated, fetchedAt);
      this.db.prepare("DELETE FROM documents WHERE session_id=?").run(session.id);
      // The title is a searchable document too; its metadata lives in sessions.
      add("", "title", updated, -1, title, []);
      for (const [seq, message] of messages.entries()) {
        const parsed = messageSchema.safeParse(message);

        if (!parsed.success) {
          continue;
        }

        const m = parsed.data;
        const { text, paths } = extract(m);

        add(m.id, m.type, m.time.created, seq, text, paths);
      }

      return true;
    });
  }

  private transaction<T>(write: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();

      this.db.exec("COMMIT");

      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Project scope from the query: the current project by default, every
   * project for `project:all`, a project ID, or a checkout/worktree path. A path
   * selects the project(s) with sessions in that directory or below it, and
   * then searches all of their worktrees.
   */
  private project(column: string, current: string, query: ParsedQuery): Filter {
    if (query.project === undefined) {
      return { sql: `${column} = ?`, values: [current] };
    }

    if (query.project.toLowerCase() === "all") {
      return { sql: "1", values: [] };
    }

    const value = normalizePath(query.project).replace(/^~(?=\/|$)/, homedir());

    if (!value.includes("/")) {
      return { sql: `${column} = ?`, values: [value] };
    }

    const directory = value.replace(/(.)\/+$/, "$1");

    return {
      sql: `${column} IN (
        SELECT project_id FROM sessions
        WHERE deleted_at IS NULL
          AND (replace(directory, '\\', '/') = ?
            OR substr(replace(directory, '\\', '/'), 1, length(?)) = ?)
      )`,
      values: [directory, `${directory}/`, `${directory}/`],
    };
  }

  private filters(current: string, query: ParsedQuery, args: SearchFilters): Filter {
    const project = this.project("d.project_id", current, query);
    const filters = [project.sql];
    const values = [...project.values];

    if (args.role) {
      filters.push("(d.role=? OR d.role='title')");
      values.push(args.role);
    }

    if (args.date) {
      const date = parseDateFilter(args.date);

      filters.push("d.timestamp BETWEEN ? AND ?");
      values.push(date.start.getTime(), date.end.getTime());
    }

    return { sql: filters.join(" AND "), values };
  }

  /**
   * A quoted trigram phrase is an exact, Unicode case-folded substring match,
   * so FTS alone decides it without reading message bodies. parseQuery
   * guarantees at least three code points, the trigram minimum.
   */
  private contains(query: string): Filter {
    const needle = query.toWellFormed().replaceAll("\0", "\uFFFD");

    return {
      sql: "d.id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)",
      values: [`"${needle.replaceAll('"', '""')}"`],
    };
  }

  /**
   * Exclusions look at the whole session, ignoring role and date: `-revert`
   * drops a session if revert appears anywhere in it.
   */
  private excluding(column: string, excluded: string[]): Filter {
    const matches = excluded.map((text) => this.contains(text));

    return {
      sql: matches
        .map(
          (match) =>
            ` AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.session_id = ${column} AND ${match.sql})`,
        )
        .join(""),
      values: matches.flatMap((match) => match.values),
    };
  }

  /**
   * The shared matching step behind every result shape: CTEs ending in
   * `matched(session_id)`, the sessions in scope that contain every word and
   * none of the exclusions. `firsts` holds each word's first hit per session.
   * Without words, every session with a message in scope matches.
   */
  private matching(
    current: string,
    query: ParsedQuery,
    args: SearchFilters,
    name = "matched",
  ): Filter {
    const scope = this.filters(current, query, args);
    const excluded = this.excluding("m.session_id", query.excluded);

    if (!query.words.length) {
      return {
        sql: `
          firsts AS (SELECT NULL id, NULL session_id, NULL word WHERE 0),
          ${name} AS (
            SELECT m.session_id
            FROM (SELECT DISTINCT d.session_id FROM documents d WHERE ${scope.sql}) m
            WHERE 1 ${excluded.sql}
          )
        `,
        values: [...scope.values, ...excluded.values],
      };
    }

    // Only ids go through the window sort; text is read for the final page.
    const values: Value[] = [];
    const selects = query.words.map((word, i) => {
      const match = this.contains(word);

      values.push(i, ...scope.values, ...match.values);

      return `
        SELECT
          d.id,
          d.session_id,
          ? word,
          row_number() OVER (PARTITION BY d.session_id ORDER BY d.seq) hit
        FROM documents d
        WHERE ${scope.sql} AND ${match.sql}
      `;
    });

    return {
      sql: `
        hits AS (${selects.join(" UNION ALL ")}),
        firsts AS (SELECT id, session_id, word FROM hits WHERE hit = 1),
        ${name} AS (
          SELECT m.session_id
          FROM (
            SELECT session_id FROM firsts
            GROUP BY session_id
            HAVING count(*) = ?
          ) m
          WHERE 1 ${excluded.sql}
        )
      `,
      values: [...values, query.words.length, ...excluded.values],
    };
  }

  private detailedLimit(args: SearchFilters): number {
    return Math.min(args.limit ?? 50, 50);
  }

  private cappedFrom(args: SearchFilters): { cappedFrom?: number } {
    return args.limit && args.limit > 50 ? { cappedFrom: args.limit } : {};
  }

  /**
   * Matching messages: each session's first hit per word. path: only narrows
   * to sessions that edited the file; the edits themselves are searchEdits.
   */
  searchMessages(current: string, args: SearchFilters): MessagesResult {
    const query = parseQuery(args.query ?? "");

    if (!query.words.length) {
      throw new Error(
        "history-search-messages needs a word or phrase; use history-search-sessions to list sessions or history-search-edits for file edits.",
      );
    }

    const matched = query.path
      ? this.editing(current, query.path, query, args)
      : this.matching(current, query, args);
    const rows = this.db
      .prepare(`
        WITH ${matched.sql},
        page AS (
          SELECT s.id session_id, s.title, s.directory, s.updated
          FROM matched m
          JOIN sessions s ON s.id = m.session_id
          ORDER BY s.updated DESC, s.id DESC
          LIMIT ?
        )
        SELECT p.*, f.word, d.message_id, d.text
        FROM page p
        JOIN firsts f ON f.session_id = p.session_id
        JOIN documents d ON d.id = f.id
        ORDER BY p.updated DESC, p.session_id DESC, f.word
      `)
      .all(...matched.values, this.detailedLimit(args));
    const sessions = new Map<string, SessionMatch>();

    for (const row of rows) {
      const d = z
        .object({
          session_id: z.string(),
          title: z.string(),
          directory: z.string(),
          updated: z.number(),
          word: z.number(),
          message_id: z.string(),
          text: z.string(),
        })
        .parse(row);
      const word = query.words[d.word]!;
      const session = sessions.get(d.session_id) ?? {
        sessionID: d.session_id,
        sessionTitle: d.title,
        projectDirectory: d.directory,
        timestamp: d.updated,
        termHits: new Map(),
      };

      session.termHits.set(word, {
        messageID: d.message_id || undefined,
        excerpt: excerpt(d.text, word),
      });
      sessions.set(d.session_id, session);
    }

    return { matches: [...sessions.values()], ...this.cappedFrom(args) };
  }

  /**
   * Matching sessions without message content, newest first, or their projects
   * with session counts. path: narrows to sessions that edited the file.
   */
  searchSessions(current: string, args: SearchFilters & { show?: "sessions" | "projects" }) {
    const query = parseQuery(args.query ?? "");
    const matched = query.path
      ? this.editing(current, query.path, query, args)
      : this.matching(current, query, args);

    if (args.show === "projects") {
      const maxProjects = 100;
      const displayed = Math.min(args.limit ?? maxProjects, maxProjects);
      const rows = this.db
        .prepare(`
          WITH ${matched.sql}
          SELECT
            s.project_id,
            COUNT(*) sessions,
            json_group_array(DISTINCT s.directory) directories,
            MAX(s.updated) updated
          FROM matched m
          JOIN sessions s ON s.id = m.session_id
          GROUP BY s.project_id
          ORDER BY sessions DESC, updated DESC
          LIMIT ?
        `)
        .all(...matched.values, displayed + 1);
      const projects = rows.map((row) =>
        z
          .object({ project_id: z.string(), sessions: z.number(), directories: z.string() })
          .parse(row),
      );

      return {
        kind: "projects" as const,
        projects: projects.slice(0, displayed).map((project) => ({
          projectID: project.project_id,
          directories: z.array(z.string()).parse(JSON.parse(project.directories)).toSorted(),
          sessions: project.sessions,
        })),
        hasMore: projects.length > displayed,
      };
    }

    const maxSessions = 50;
    const displayed = Math.min(args.limit ?? 20, maxSessions);
    const rows = this.db
      .prepare(`
        WITH ${matched.sql}
        SELECT s.id session_id, s.title, s.directory, s.project_id, s.updated
        FROM matched m
        JOIN sessions s ON s.id = m.session_id
        ORDER BY s.updated DESC, s.id DESC
        LIMIT ?
      `)
      .all(...matched.values, displayed + 1);
    const sessions = rows.map((row) =>
      z
        .object({
          session_id: z.string(),
          title: z.string(),
          directory: z.string(),
          project_id: z.string(),
          updated: z.number(),
        })
        .parse(row),
    );

    return {
      kind: "list" as const,
      sessions: sessions.slice(0, displayed).map((session) => ({
        sessionID: session.session_id,
        sessionTitle: session.title,
        projectDirectory: session.directory,
        projectID: session.project_id,
        timestamp: session.updated,
      })),
      hasMore: sessions.length > displayed,
    };
  }

  private pathMatch(path: string): Filter {
    const normalized = normalizePath(path);
    const relative = !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized);

    // Relative inputs seek by basename, then keep only slash-bounded suffixes.
    return relative
      ? {
          sql: "p.basename = ? AND (p.path = ? OR substr(p.path, -length(?)) = ?)",
          values: [basename(normalized), normalized, `/${normalized}`, `/${normalized}`],
        }
      : { sql: "p.path = ?", values: [normalized] };
  }

  /** `matched` for path: in session results: text matches, then only sessions editing the file. */
  private editing(current: string, path: string, query: ParsedQuery, args: SearchFilters): Filter {
    const match = this.pathMatch(path);
    const project = this.project("p.project_id", current, query);
    const texts = this.matching(current, query, args, "texts");

    return {
      sql: `
        ${texts.sql},
        matched AS (
          SELECT DISTINCT d.session_id
          FROM document_paths p
          JOIN documents d ON d.id = p.document_id
          WHERE ${match.sql}
            AND ${project.sql}
            AND d.role = 'assistant'
            AND d.session_id IN (SELECT session_id FROM texts)
        )
      `,
      values: [...texts.values, ...match.values, ...project.values],
    };
  }

  /**
   * File edits in matching sessions, newest first, each with the user prompt
   * before it. path: selects the file; without it every edited file counts.
   * Words, exclusions and date narrow which edits are shown, but firstTouch is
   * numbered per file over all its edits in project scope, so it keeps meaning
   * the first recorded touch of that file.
   */
  searchEdits(current: string, args: SearchFilters): EditsResult {
    const query = parseQuery(args.query ?? "");
    const match = query.path ? this.pathMatch(query.path) : { sql: "1", values: [] };
    const project = this.project("p.project_id", current, query);
    const date = args.date ? parseDateFilter(args.date) : undefined;
    const filtered = query.words.length > 0 || query.excluded.length > 0;
    const texts = filtered
      ? this.matching(current, { ...query, path: undefined }, { ...args, date: undefined }, "texts")
      : undefined;
    const filters = [
      ...(date ? ["timestamp BETWEEN ? AND ?"] : []),
      ...(texts ? ["session_id IN (SELECT session_id FROM texts)"] : []),
    ];
    // Number and page edits using only columns stored before documents.text,
    // so common basenames never pull message bodies through the window sort.
    // Text and preceding prompts are fetched for the final page only.
    const rows = this.db
      .prepare(`
        WITH ${texts ? `${texts.sql},` : ""}
        edits AS (
          SELECT
            p.document_id,
            p.path,
            p.tool,
            d.session_id,
            d.timestamp,
            d.seq,
            row_number() OVER (
              PARTITION BY p.path
              ORDER BY d.timestamp, d.session_id, d.seq
            ) touch
          FROM document_paths p
          JOIN documents d ON d.id = p.document_id
          WHERE ${match.sql}
            AND ${project.sql}
            AND d.role = 'assistant'
        ),
        page AS (
          SELECT * FROM edits
          ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
          ORDER BY timestamp DESC, session_id DESC, path
          LIMIT ?
        )
        SELECT
          d.session_id,
          d.message_id,
          s.title,
          d.timestamp,
          t.path,
          t.tool,
          t.touch,
          u.text prompt,
          u.message_id prompt_message
        FROM page t
        JOIN documents d ON d.id = t.document_id
        JOIN sessions s ON s.id = t.session_id
        LEFT JOIN documents u ON u.id = (
          SELECT id FROM documents
          WHERE session_id = t.session_id
            AND role = 'user'
            AND seq < t.seq
          ORDER BY seq DESC
          LIMIT 1
        )
        ORDER BY t.timestamp DESC, t.session_id DESC, t.path
      `)
      .all(
        ...(texts?.values ?? []),
        ...match.values,
        ...project.values,
        ...(date ? [date.start.getTime(), date.end.getTime()] : []),
        this.detailedLimit(args),
      );

    return {
      edits: rows.map((row): FileEdit => {
        const d = z
          .object({
            session_id: z.string(),
            message_id: z.string(),
            title: z.string(),
            timestamp: z.number(),
            path: z.string(),
            tool: z.string().nullable(),
            touch: z.number(),
            prompt: z.string().nullable(),
            prompt_message: z.string().nullable(),
          })
          .parse(row);
        const prompt = d.prompt;

        return {
          sessionID: d.session_id,
          sessionTitle: d.title,
          timestamp: d.timestamp,
          messageID: d.message_id,
          firstTouch: d.touch === 1,
          filePath: d.path,
          toolName: d.tool,
          userPrompt: prompt?.slice(0, 300) ?? null,
          userPromptTruncated: !!prompt && prompt.length > 300,
          userPromptMessageID: d.prompt_message ?? undefined,
        };
      }),
      ...this.cappedFrom(args),
    };
  }
}
