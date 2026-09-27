import { z } from "zod";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { roots } from "@opencode/util/global-roots";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
//#region src/format.ts
function formatFileEdits(matches) {
	if (matches.length === 0) return "No file edits found in conversation history.";
	const lines = [`Found ${matches.length} file edits, newest first (use history-read with a Session ID and Message ID for context):\n`];
	for (const match of matches) {
		const timestamp = new Date(match.timestamp);
		const date = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
		const time = timestamp.toTimeString().split(" ")[0];
		lines.push(`## ${match.sessionTitle}`);
		lines.push(`- Session ID: ${match.sessionID}`);
		lines.push(`- Date: ${date} ${time}`);
		if (match.messageID) lines.push(`- Message ID: ${match.messageID}`);
		lines.push(`- Status: ${match.firstTouch ? "First edit of this file" : "Later edit"}`);
		lines.push(`- File: ${match.filePath}`);
		if (match.toolName) lines.push(`- Tool: ${match.toolName}`);
		if (match.userPrompt) lines.push(`- Preceding User Prompt: "${match.userPrompt}"${match.userPromptTruncated ? " [truncated]" : ""}`);
		if (match.userPromptMessageID) lines.push(`- Preceding User Message ID: ${match.userPromptMessageID}`);
		lines.push("");
	}
	return lines.join("\n");
}
function formatSessionResults(matches) {
	if (matches.length === 0) return "No sessions found in conversation history.";
	const lines = [`Found ${matches.length} sessions in conversation history:\n`];
	for (const match of matches) {
		const timestamp = new Date(match.timestamp);
		const date = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
		const time = timestamp.toTimeString().split(" ")[0];
		lines.push(`## ${match.sessionTitle}`);
		lines.push(`- Session ID: ${match.sessionID}`);
		lines.push(`- Project: ${match.projectDirectory}`);
		lines.push(`- Date: ${date} ${time}`);
		if (match.termHits.size > 0) {
			const termList = Array.from(match.termHits.keys()).join(", ");
			lines.push(`- Matched words: ${termList}`);
			for (const [term, hit] of match.termHits) {
				lines.push(`  - ${term}: ${hit.excerpt}`);
				if (hit.messageID) lines.push(`    - Message ID: ${hit.messageID}`);
			}
		}
		lines.push("");
	}
	return lines.join("\n");
}
function formatProjects(projects, hasMore) {
	if (!projects.length) return "No matching projects found in conversation history.";
	return [
		`Found ${projects.length}${hasMore ? "+" : ""} projects (matching sessions per project; narrow with project:<project ID>):`,
		...projects.map((project) => `- ${project.directories.join(", ")} (${project.sessions} ${project.sessions === 1 ? "session" : "sessions"}; project ID: ${project.projectID})`),
		...hasMore ? ["More projects exist; refine the query or raise limit (up to 100)."] : []
	].join("\n");
}
function formatListing(sessions, hasMore) {
	if (!sessions.length) return "No sessions found in conversation history.";
	return [
		`Found ${sessions.length}${hasMore ? "+" : ""} sessions, most recently updated first (use history-read with a Session ID to inspect work):`,
		...sessions.map((session) => `- ${JSON.stringify(session.sessionTitle)}\n  Session ID: ${session.sessionID}\n  Updated: ${new Date(session.timestamp).toISOString()}\n  Directory: ${session.projectDirectory}\n  Project ID: ${session.projectID}`),
		...hasMore ? ["More sessions exist; refine the query or raise limit (up to 50)."] : []
	].join("\n");
}
function formatSessionsResult(result) {
	return result.kind === "projects" ? formatProjects(result.projects, result.hasMore) : formatListing(result.sessions, result.hasMore);
}
function withCap(output, cappedFrom) {
	return cappedFrom ? `${output}\nDetailed results capped at 50 (requested ${cappedFrom}); use history-search-sessions with show:'projects' for a compact overview or refine the query.` : output;
}
function formatMessagesResult(result) {
	return withCap(formatSessionResults(result.matches), result.cappedFrom);
}
function formatEditsResult(result) {
	return withCap(formatFileEdits(result.edits), result.cappedFrom);
}
//#endregion
//#region src/date-filter.ts
/**
* Date filtering utilities for search results
* Supports natural language dates: "today", "yesterday", "last N days/weeks/months"
* All calendar inputs use the host local timezone, consistently with today/yesterday.
* Boundaries are inclusive and DST-aware, not UTC-parsed ISO instants.
* Supports ISO dates: "YYYY-MM-DD"
* Supports date ranges: "YYYY-MM-DD to YYYY-MM-DD"
*/
function calendarDate(input) {
	const [year, month, day] = input.split("-").map(Number);
	const date = /* @__PURE__ */ new Date(0);
	date.setFullYear(year, month - 1, day);
	date.setHours(0, 0, 0, 0);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(`Invalid date: ${input}`);
	return date;
}
/**
* Parse a date filter string into a DateRange
* @param filter Date filter string (e.g., "today", "last 7 days", "2024-01-15", "2024-01-01 to 2024-01-31")
* @returns DateRange object with start and end dates (inclusive)
* @throws Error if the filter format is invalid
*/
function parseDateFilter(filter) {
	const normalized = filter.trim().toLowerCase();
	if (normalized === "today") {
		const start = /* @__PURE__ */ new Date();
		start.setHours(0, 0, 0, 0);
		const end = /* @__PURE__ */ new Date();
		end.setHours(23, 59, 59, 999);
		return {
			start,
			end
		};
	}
	if (normalized === "yesterday") {
		const start = /* @__PURE__ */ new Date();
		start.setDate(start.getDate() - 1);
		start.setHours(0, 0, 0, 0);
		const end = new Date(start);
		end.setHours(23, 59, 59, 999);
		return {
			start,
			end
		};
	}
	const relativeMatch = normalized.match(/^last (\d+) (day|week|month)s?$/);
	if (relativeMatch && relativeMatch[1] && relativeMatch[2]) {
		const count = parseInt(relativeMatch[1], 10);
		const unit = relativeMatch[2];
		const end = /* @__PURE__ */ new Date();
		const start = /* @__PURE__ */ new Date();
		if (unit === "day") start.setDate(start.getDate() - count);
		else if (unit === "week") start.setDate(start.getDate() - count * 7);
		else if (unit === "month") start.setMonth(start.getMonth() - count);
		start.setHours(0, 0, 0, 0);
		return {
			start,
			end
		};
	}
	const rangeMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/);
	if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
		const start = calendarDate(rangeMatch[1]);
		const end = calendarDate(rangeMatch[2]);
		end.setHours(23, 59, 59, 999);
		if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error(`Invalid date range: ${filter}`);
		if (start > end) throw new Error(`Start date must be before end date: ${filter}`);
		return {
			start,
			end
		};
	}
	const isoMatch = normalized.match(/^(\d{4}-\d{2}(?:-\d{2})?)$/);
	if (isoMatch && isoMatch[1]) {
		const dateStr = isoMatch[1];
		if (dateStr.match(/^\d{4}-\d{2}$/)) {
			const start = calendarDate(`${dateStr}-01`);
			const end = new Date(start);
			end.setMonth(end.getMonth() + 1);
			end.setDate(0);
			end.setHours(23, 59, 59, 999);
			if (isNaN(start.getTime())) throw new Error(`Invalid date: ${filter}`);
			return {
				start,
				end
			};
		}
		const start = calendarDate(dateStr);
		const end = calendarDate(dateStr);
		end.setHours(23, 59, 59, 999);
		if (isNaN(start.getTime())) throw new Error(`Invalid date: ${filter}`);
		return {
			start,
			end
		};
	}
	throw new Error(`Unrecognized date filter format: ${filter}. Supported formats: "today", "yesterday", "last N days/weeks/months", "YYYY-MM-DD", "YYYY-MM", "YYYY-MM-DD to YYYY-MM-DD"`);
}
//#endregion
//#region src/query.ts
var qualifiers = ["path", "project"];
var examples = {
	path: "path:src/auth.ts",
	project: "project:~/Code/app"
};
function parseQuery(input) {
	const words = [];
	const excluded = [];
	const found = {};
	let i = 0;
	const value = () => {
		if (input[i] !== "\"") {
			const start = i;
			while (i < input.length && !/\s/.test(input[i])) i++;
			return input.slice(start, i);
		}
		const end = input.indexOf("\"", i + 1);
		if (end < 0) throw new Error(`Unclosed quote in query: ${input}`);
		const text = input.slice(i + 1, end);
		i = end + 1;
		return text;
	};
	while (i < input.length) {
		if (/\s/.test(input[i])) {
			i++;
			continue;
		}
		const negated = input[i] === "-" && i + 1 < input.length && !/\s/.test(input[i + 1]);
		if (negated) i++;
		const qualifier = qualifiers.find((name) => input.slice(i, i + name.length + 1).toLowerCase() === `${name}:`);
		if (qualifier) {
			if (negated) throw new Error(`-${qualifier}: is not supported.`);
			if (found[qualifier] !== void 0) throw new Error(`Only one ${qualifier}: qualifier is supported per query.`);
			i += qualifier.length + 1;
			found[qualifier] = value();
			if (!found[qualifier]) throw new Error(`${qualifier}: needs a value, e.g. ${examples[qualifier]}`);
			continue;
		}
		const text = value();
		if (text) (negated ? excluded : words).push(text);
	}
	const short = [...words, ...excluded].find((text) => [...text].length < 3);
	if (short !== void 0) throw new Error(`Search words need at least 3 characters: ${JSON.stringify(short)}. Use a longer word or a quoted phrase.`);
	return {
		words: unique(words),
		excluded: unique(excluded),
		...found
	};
}
function unique(texts) {
	const seen = /* @__PURE__ */ new Set();
	return texts.filter((text) => {
		const key = text.toLowerCase();
		return !seen.has(key) && !!seen.add(key);
	});
}
//#endregion
//#region src/search-index.ts
var sessionSchema = z.object({
	id: z.string(),
	projectID: z.string(),
	title: z.string().optional(),
	location: z.object({ directory: z.string() }),
	time: z.object({
		updated: z.number(),
		idle: z.number().optional()
	})
});
var fingerprintSchema = z.object({
	updated: z.number(),
	title: z.string(),
	projectID: z.string(),
	directory: z.string()
});
/**
* Last activity of a session. OpenCode bumps time.updated only for session
* changes (title, move, revert); new messages leave it alone but set
* time.idle when the turn ends, so the later of the two tracks new messages.
*/
function activity(time) {
	return Math.max(time.updated, time.idle ?? 0);
}
function sessionFingerprint(input) {
	return {
		updated: activity(input.time),
		title: input.title ?? "Untitled session",
		projectID: input.projectID,
		directory: input.location.directory
	};
}
function sameFingerprint(a, b) {
	return a.updated === b.updated && a.title === b.title && a.projectID === b.projectID && a.directory === b.directory;
}
var messageSchema = z.object({
	id: z.string(),
	type: z.string(),
	time: z.object({ created: z.number() })
}).passthrough();
var object = (value) => value && typeof value === "object" && !Array.isArray(value) ? z.record(z.string(), z.unknown()).parse(value) : {};
var array = (value) => Array.isArray(value) ? value : [];
var normalizePath = (path) => path.replaceAll("\\", "/");
var basename = (path) => path.slice(path.lastIndexOf("/") + 1);
function extract(message) {
	const texts = [];
	const paths = /* @__PURE__ */ new Map();
	if (typeof message.text === "string") texts.push(message.text);
	for (const raw of array(message.content)) {
		const part = object(raw);
		if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") texts.push(part.text);
		if (part.type !== "tool" || typeof part.name !== "string" || !part.state || typeof part.state !== "object") continue;
		const state = object(part.state);
		texts.push(part.name);
		if (state.input !== void 0) texts.push(JSON.stringify(state.input));
		for (const output of array(state.content)) {
			const content = object(output);
			if (content.type === "text" && typeof content.text === "string") texts.push(content.text);
		}
		const path = object(state.input).filePath;
		if (["edit", "write"].includes(part.name) && state.status === "completed" && typeof path === "string") paths.set(normalizePath(path), part.name);
	}
	for (const path of array(object(message.snapshot).files)) {
		if (typeof path !== "string") continue;
		texts.push(path);
		if (!paths.has(normalizePath(path))) paths.set(normalizePath(path), null);
	}
	return {
		text: texts.join("\n"),
		paths: [...paths].map(([path, tool]) => ({
			path,
			tool
		}))
	};
}
function excerpt(text, query) {
	const start = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase()) - 100);
	return text.slice(start, start + 300);
}
var schemaVersion = 2;
var schema = `
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
var SearchIndex = class SearchIndex {
	db;
	constructor(db) {
		this.db = db;
	}
	static async open(path) {
		for (let attempt = 0;; attempt++) try {
			return await SearchIndex.initialize(path);
		} catch (error) {
			const details = error && typeof error === "object" ? error : {};
			if (!(details.errcode === 5 || details.code === "SQLITE_BUSY") || attempt >= 9) throw error;
			await setTimeout(50 * (attempt + 1));
		}
	}
	static async initialize(path) {
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		const db = process.versions.bun ? new (await (import("bun:sqlite"))).Database(path, {
			readonly: false,
			create: true
		}) : new (await (import("node:sqlite"))).DatabaseSync(path);
		try {
			db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        -- Required for document_paths cascades; bun:sqlite leaves it off by default.
        PRAGMA foreign_keys = ON;
      `);
			db.exec("BEGIN IMMEDIATE");
			try {
				const [{ user_version: version }] = z.tuple([z.object({ user_version: z.number() })]).parse(db.prepare("PRAGMA user_version").all());
				if (version !== schemaVersion) db.exec(`
            DROP TRIGGER IF EXISTS documents_insert;
            DROP TRIGGER IF EXISTS documents_delete;
            DROP TABLE IF EXISTS documents_fts;
            DROP TABLE IF EXISTS document_paths;
            DROP TABLE IF EXISTS documents;
            DROP TABLE IF EXISTS sessions;
            ${schema}
            PRAGMA user_version = ${schemaVersion};
          `);
				db.prepare("DELETE FROM sessions WHERE deleted_at < ?").run(Date.now() - 864e5);
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
	close() {
		this.db.close();
	}
	/**
	* Remove a session and leave a tombstone: a fetch that started before
	* `deletedAt` can no longer write it back (see replaceSession).
	*/
	removeSession(id, deletedAt = Date.now()) {
		this.transaction(() => {
			this.db.prepare("DELETE FROM documents WHERE session_id=?").run(id);
			this.db.prepare(`INSERT INTO sessions (id, fetched_at, deleted_at) VALUES (?, 0, ?)
           ON CONFLICT (id) DO UPDATE SET deleted_at = max(coalesce(deleted_at, 0), excluded.deleted_at)`).run(id, deletedAt);
		});
	}
	sessionFingerprints() {
		return new Map(this.db.prepare(`SELECT id, updated, title, project_id AS projectID, directory
           FROM sessions WHERE deleted_at IS NULL`).all().map((row) => {
			const { id, ...fingerprint } = fingerprintSchema.extend({ id: z.string() }).parse(row);
			return [id, fingerprint];
		}));
	}
	/**
	* Replace a session's indexed content with a fetch that started at
	* `fetchedAt`. Backfill and live sync refresh sessions concurrently, so a
	* slow, older fetch can finish last: it is skipped (returns false) when a
	* newer fetch was already written or the session was deleted after it began.
	* The check and the write share one write-locked transaction, which also
	* covers other processes using the same index file.
	*/
	replaceSession(input, messages, fetchedAt = Date.now()) {
		const session = sessionSchema.parse(input);
		const insert = this.db.prepare(`INSERT INTO documents (session_id, message_id, project_id, timestamp, seq, role, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);
		const insertPath = this.db.prepare(`INSERT INTO document_paths (document_id, project_id, path, basename, tool)
       VALUES (?, ?, ?, ?, ?)`);
		const add = (id, role, timestamp, seq, text, paths) => {
			const scalar = text.toWellFormed().replaceAll("\0", "�");
			const { lastInsertRowid } = insert.run(session.id, id, session.projectID, timestamp, seq, role, scalar);
			for (const { path, tool } of paths) insertPath.run(Number(lastInsertRowid), session.projectID, path, basename(path), tool);
		};
		return this.transaction(() => {
			const [current] = z.array(z.object({
				fetched_at: z.number(),
				deleted_at: z.number().nullable()
			})).parse(this.db.prepare("SELECT fetched_at, deleted_at FROM sessions WHERE id=?").all(session.id));
			if (current && (current.fetched_at > fetchedAt || (current.deleted_at ?? -1) >= fetchedAt)) return false;
			const title = session.title ?? "Untitled session";
			const updated = activity(session.time);
			this.db.prepare(`INSERT INTO sessions (id, project_id, title, directory, updated, fetched_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (id) DO UPDATE SET
             project_id = excluded.project_id,
             title = excluded.title,
             directory = excluded.directory,
             updated = excluded.updated,
             fetched_at = excluded.fetched_at,
             deleted_at = NULL`).run(session.id, session.projectID, title, session.location.directory, updated, fetchedAt);
			this.db.prepare("DELETE FROM documents WHERE session_id=?").run(session.id);
			add("", "title", updated, -1, title, []);
			for (const [seq, message] of messages.entries()) {
				const parsed = messageSchema.safeParse(message);
				if (!parsed.success) continue;
				const m = parsed.data;
				const { text, paths } = extract(m);
				add(m.id, m.type, m.time.created, seq, text, paths);
			}
			return true;
		});
	}
	transaction(write) {
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
	project(column, current, query) {
		if (query.project === void 0) return {
			sql: `${column} = ?`,
			values: [current]
		};
		if (query.project.toLowerCase() === "all") return {
			sql: "1",
			values: []
		};
		const value = normalizePath(query.project).replace(/^~(?=\/|$)/, homedir());
		if (!value.includes("/")) return {
			sql: `${column} = ?`,
			values: [value]
		};
		const directory = value.replace(/(.)\/+$/, "$1");
		return {
			sql: `${column} IN (
        SELECT project_id FROM sessions
        WHERE deleted_at IS NULL
          AND (replace(directory, '\\', '/') = ?
            OR substr(replace(directory, '\\', '/'), 1, length(?)) = ?)
      )`,
			values: [
				directory,
				`${directory}/`,
				`${directory}/`
			]
		};
	}
	filters(current, query, args) {
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
		return {
			sql: filters.join(" AND "),
			values
		};
	}
	/**
	* A quoted trigram phrase is an exact, Unicode case-folded substring match,
	* so FTS alone decides it without reading message bodies. parseQuery
	* guarantees at least three code points, the trigram minimum.
	*/
	contains(query) {
		return {
			sql: "d.id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)",
			values: [`"${query.toWellFormed().replaceAll("\0", "�").replaceAll("\"", "\"\"")}"`]
		};
	}
	/**
	* Exclusions look at the whole session, ignoring role and date: `-revert`
	* drops a session if revert appears anywhere in it.
	*/
	excluding(column, excluded) {
		const matches = excluded.map((text) => this.contains(text));
		return {
			sql: matches.map((match) => ` AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.session_id = ${column} AND ${match.sql})`).join(""),
			values: matches.flatMap((match) => match.values)
		};
	}
	/**
	* The shared matching step behind every result shape: CTEs ending in
	* `matched(session_id)`, the sessions in scope that contain every word and
	* none of the exclusions. `firsts` holds each word's first hit per session.
	* Without words, every session with a message in scope matches.
	*/
	matching(current, query, args, name = "matched") {
		const scope = this.filters(current, query, args);
		const excluded = this.excluding("m.session_id", query.excluded);
		if (!query.words.length) return {
			sql: `
          firsts AS (SELECT NULL id, NULL session_id, NULL word WHERE 0),
          ${name} AS (
            SELECT m.session_id
            FROM (SELECT DISTINCT d.session_id FROM documents d WHERE ${scope.sql}) m
            WHERE 1 ${excluded.sql}
          )
        `,
			values: [...scope.values, ...excluded.values]
		};
		const values = [];
		return {
			sql: `
        hits AS (${query.words.map((word, i) => {
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
			}).join(" UNION ALL ")}),
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
			values: [
				...values,
				query.words.length,
				...excluded.values
			]
		};
	}
	detailedLimit(args) {
		return Math.min(args.limit ?? 50, 50);
	}
	cappedFrom(args) {
		return args.limit && args.limit > 50 ? { cappedFrom: args.limit } : {};
	}
	/**
	* Matching messages: each session's first hit per word. path: only narrows
	* to sessions that edited the file; the edits themselves are searchEdits.
	*/
	searchMessages(current, args) {
		const query = parseQuery(args.query ?? "");
		if (!query.words.length) throw new Error("history-search-messages needs a word or phrase; use history-search-sessions to list sessions or history-search-edits for file edits.");
		const matched = query.path ? this.editing(current, query.path, query, args) : this.matching(current, query, args);
		const rows = this.db.prepare(`
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
      `).all(...matched.values, this.detailedLimit(args));
		const sessions = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const d = z.object({
				session_id: z.string(),
				title: z.string(),
				directory: z.string(),
				updated: z.number(),
				word: z.number(),
				message_id: z.string(),
				text: z.string()
			}).parse(row);
			const word = query.words[d.word];
			const session = sessions.get(d.session_id) ?? {
				sessionID: d.session_id,
				sessionTitle: d.title,
				projectDirectory: d.directory,
				timestamp: d.updated,
				termHits: /* @__PURE__ */ new Map()
			};
			session.termHits.set(word, {
				messageID: d.message_id || void 0,
				excerpt: excerpt(d.text, word)
			});
			sessions.set(d.session_id, session);
		}
		return {
			matches: [...sessions.values()],
			...this.cappedFrom(args)
		};
	}
	/**
	* Matching sessions without message content, newest first, or their projects
	* with session counts. path: narrows to sessions that edited the file.
	*/
	searchSessions(current, args) {
		const query = parseQuery(args.query ?? "");
		const matched = query.path ? this.editing(current, query.path, query, args) : this.matching(current, query, args);
		if (args.show === "projects") {
			const maxProjects = 100;
			const displayed = Math.min(args.limit ?? maxProjects, maxProjects);
			const projects = this.db.prepare(`
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
        `).all(...matched.values, displayed + 1).map((row) => z.object({
				project_id: z.string(),
				sessions: z.number(),
				directories: z.string()
			}).parse(row));
			return {
				kind: "projects",
				projects: projects.slice(0, displayed).map((project) => ({
					projectID: project.project_id,
					directories: z.array(z.string()).parse(JSON.parse(project.directories)).toSorted(),
					sessions: project.sessions
				})),
				hasMore: projects.length > displayed
			};
		}
		const displayed = Math.min(args.limit ?? 20, 50);
		const sessions = this.db.prepare(`
        WITH ${matched.sql}
        SELECT s.id session_id, s.title, s.directory, s.project_id, s.updated
        FROM matched m
        JOIN sessions s ON s.id = m.session_id
        ORDER BY s.updated DESC, s.id DESC
        LIMIT ?
      `).all(...matched.values, displayed + 1).map((row) => z.object({
			session_id: z.string(),
			title: z.string(),
			directory: z.string(),
			project_id: z.string(),
			updated: z.number()
		}).parse(row));
		return {
			kind: "list",
			sessions: sessions.slice(0, displayed).map((session) => ({
				sessionID: session.session_id,
				sessionTitle: session.title,
				projectDirectory: session.directory,
				projectID: session.project_id,
				timestamp: session.updated
			})),
			hasMore: sessions.length > displayed
		};
	}
	pathMatch(path) {
		const normalized = normalizePath(path);
		return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) ? {
			sql: "p.basename = ? AND (p.path = ? OR substr(p.path, -length(?)) = ?)",
			values: [
				basename(normalized),
				normalized,
				`/${normalized}`,
				`/${normalized}`
			]
		} : {
			sql: "p.path = ?",
			values: [normalized]
		};
	}
	/** `matched` for path: in session results: text matches, then only sessions editing the file. */
	editing(current, path, query, args) {
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
			values: [
				...texts.values,
				...match.values,
				...project.values
			]
		};
	}
	/**
	* File edits in matching sessions, newest first, each with the user prompt
	* before it. path: selects the file; without it every edited file counts.
	* Words, exclusions and date narrow which edits are shown, but firstTouch is
	* numbered per file over all its edits in project scope, so it keeps meaning
	* the first recorded touch of that file.
	*/
	searchEdits(current, args) {
		const query = parseQuery(args.query ?? "");
		const match = query.path ? this.pathMatch(query.path) : {
			sql: "1",
			values: []
		};
		const project = this.project("p.project_id", current, query);
		const date = args.date ? parseDateFilter(args.date) : void 0;
		const texts = query.words.length > 0 || query.excluded.length > 0 ? this.matching(current, {
			...query,
			path: void 0
		}, {
			...args,
			date: void 0
		}, "texts") : void 0;
		const filters = [...date ? ["timestamp BETWEEN ? AND ?"] : [], ...texts ? ["session_id IN (SELECT session_id FROM texts)"] : []];
		return {
			edits: this.db.prepare(`
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
      `).all(...texts?.values ?? [], ...match.values, ...project.values, ...date ? [date.start.getTime(), date.end.getTime()] : [], this.detailedLimit(args)).map((row) => {
				const d = z.object({
					session_id: z.string(),
					message_id: z.string(),
					title: z.string(),
					timestamp: z.number(),
					path: z.string(),
					tool: z.string().nullable(),
					touch: z.number(),
					prompt: z.string().nullable(),
					prompt_message: z.string().nullable()
				}).parse(row);
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
					userPromptMessageID: d.prompt_message ?? void 0
				};
			}),
			...this.cappedFrom(args)
		};
	}
};
//#endregion
//#region src/index-sync.ts
var describe = (error) => error instanceof Error ? error.message : "unknown error";
var notFound = (error) => error instanceof Error && error.name === "SessionNotFoundError";
/** Fetch all of a session's messages and write them as a fetch that started at `fetchedAt`. */
async function refreshSession(index, client, session, fetchedAt, signal) {
	const messages = [];
	let cursor;
	const seen = /* @__PURE__ */ new Set();
	do {
		if (cursor && seen.has(cursor)) throw new Error("Repeated message cursor from OpenCode.");
		if (cursor) seen.add(cursor);
		const page = await client.message.list({
			sessionID: session.id,
			limit: 100,
			order: cursor ? void 0 : "asc",
			cursor
		}, { signal });
		messages.push(...page.data);
		cursor = page.cursor.next ?? void 0;
	} while (cursor);
	signal?.throwIfAborted();
	index.replaceSession(session, messages, fetchedAt);
}
async function listSessions(client, signal) {
	const sessions = [];
	let cursor;
	const seen = /* @__PURE__ */ new Set();
	do {
		if (cursor && seen.has(cursor)) throw new Error("Repeated session cursor from OpenCode.");
		if (cursor) seen.add(cursor);
		const page = await client.session.list({
			limit: 100,
			order: cursor ? void 0 : "desc",
			cursor
		}, { signal });
		sessions.push(...page.data);
		cursor = page.cursor.next ?? void 0;
	} while (cursor);
	return sessions;
}
/**
* Bring the index up to date with every session OpenCode lists, refreshing the
* ones whose metadata changed since they were indexed. Runs at startup and
* after the event subscription fails; LiveSync covers changes in between.
*
* It runs concurrently with LiveSync. Every write carries the listing's start
* time, so a live refresh fetched after it is never overwritten by this slower
* pass, and a session deleted meanwhile is never written back (see
* SearchIndex.replaceSession). Sessions missing from the listing are kept:
* another OpenCode process sharing the index may own them.
*/
async function backfill(index, client, options = {}) {
	const { signal, onError } = options;
	const listedAt = Date.now();
	const sessions = await listSessions(client, signal);
	const known = index.sessionFingerprints();
	for (const session of sessions) {
		const indexed = known.get(session.id);
		if (indexed && sameFingerprint(indexed, sessionFingerprint(session))) continue;
		try {
			await refreshSession(index, client, session, listedAt, signal);
		} catch (error) {
			signal?.throwIfAborted();
			if (notFound(error)) index.removeSession(session.id);
			else if (onError) onError(session.id, error);
			else console.error(`History index could not refresh session ${session.id}:`, describe(error));
		}
	}
}
function indexPath() {
	return join(roots("opencode").data, "history-search", "index-v1.sqlite");
}
async function discoverService(version, signal, discover = Service.discover, wait = setTimeout) {
	while (!signal.aborted) {
		const endpoint = await discover({ version });
		if (endpoint) return endpoint;
		await wait(1e3, void 0, { signal });
	}
	signal.throwIfAborted();
	throw new Error("History index stopped");
}
var shared;
/**
* Minimum time between refreshes of one session while events keep arriving for
* it: an active turn emits step/text/tool events several times a second, and
* each refresh refetches the session's messages.
*/
var sessionRefreshInterval = 1e3;
async function acquireIndex(ctx) {
	if (!shared) shared = (async () => {
		const controller = new AbortController();
		const { signal } = controller;
		const index = await SearchIndex.open(indexPath());
		const client = discoverService(ctx.app.version, signal).then((endpoint) => OpenCode.make({
			baseUrl: endpoint.url,
			headers: Service.headers(endpoint)
		}));
		const live = new LiveSync(index, client, signal, sessionRefreshInterval);
		let backfilling;
		let again = false;
		const startBackfill = () => {
			if (backfilling) {
				again = true;
				return;
			}
			again = false;
			backfilling = (async () => {
				const resolved = await client;
				for (let failures = 0;; failures++) try {
					await backfill(index, resolved, {
						signal,
						onError: (sessionID, error) => live.retry(sessionID, error)
					});
					return;
				} catch (error) {
					if (signal.aborted) return;
					if (failures === 0) console.error("History index backfill failed; retrying:", describe(error));
					await setTimeout(Math.min(1e3 * 2 ** (failures + 1), 3e4), void 0, { signal });
				}
			})().catch((error) => {
				if (!signal.aborted) console.error("History index unavailable:", describe(error));
			}).finally(() => {
				backfilling = void 0;
				if (again && !signal.aborted) startBackfill();
			});
		};
		const liveLoop = (async () => {
			await client;
			while (!signal.aborted) {
				await live.flush();
				await setTimeout(250, void 0, { signal });
			}
		})().catch((error) => {
			if (!signal.aborted) console.error("History index live sync stopped:", describe(error));
		});
		startBackfill();
		return {
			refs: 0,
			controller,
			index,
			live,
			ready: client.then((resolved) => ({
				client: resolved,
				index
			})),
			backfill: startBackfill,
			stopped: async () => {
				await liveLoop;
				await backfilling;
			}
		};
	})().catch((error) => {
		shared = void 0;
		throw error;
	});
	const state = await shared;
	state.refs++;
	const subscription = new AbortController();
	const events = (async () => {
		while (!subscription.signal.aborted) try {
			for await (const event of ctx.event.subscribe({ signal: subscription.signal })) state.live.event(event);
			if (!subscription.signal.aborted) throw new Error("History event subscription ended");
		} catch (error) {
			if (subscription.signal.aborted) break;
			console.error("History event subscription interrupted:", describe(error));
			state.backfill();
			await setTimeout(1e3, void 0, { signal: subscription.signal });
		}
	})().catch((error) => {
		if (!subscription.signal.aborted) console.error("History event listener failed:", describe(error));
	});
	return {
		index: state.index,
		ready: state.ready,
		async close() {
			subscription.abort();
			await events;
			if (--state.refs === 0) {
				shared = void 0;
				state.controller.abort();
				await state.stopped();
				state.index.close();
			}
		}
	};
}
/**
* Keeps the index current from session events, alongside backfill. Each
* changed session is fetched on its own, at most once per `refreshInterval`
* while events keep arriving; a session that fails backs off without holding
* up others. Deletions apply immediately and leave a tombstone.
*/
var LiveSync = class {
	index;
	signal;
	refreshInterval;
	dirty = /* @__PURE__ */ new Set();
	/** Earliest next refresh per session, from throttling or failure backoff. */
	notBefore = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	client;
	running = Promise.resolve();
	constructor(index, client, signal, refreshInterval = 0) {
		this.index = index;
		this.signal = signal;
		this.refreshInterval = refreshInterval;
		this.client = Promise.resolve(client);
		this.client.catch(() => {});
	}
	/** Token and progress deltas never trigger indexing; the events that end them do. */
	event(event) {
		if (!event.type.startsWith("session.") || event.type.endsWith(".delta") || event.type.endsWith(".progress")) return;
		const data = event.data;
		if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return;
		if (event.type === "session.deleted") {
			this.forget(data.sessionID);
			this.index.removeSession(data.sessionID);
		} else this.dirty.add(data.sessionID);
	}
	/** Take over a session that failed to refresh elsewhere (backfill) and retry it with backoff. */
	retry(sessionID, error) {
		this.failed(sessionID, error);
	}
	/** Refresh every session whose events are due. Passes run one after another. */
	flush() {
		const pass = this.running.catch(() => {}).then(() => this.update());
		this.running = pass;
		return pass;
	}
	async update() {
		const client = await this.client;
		for (;;) {
			const now = Date.now();
			const due = [...this.dirty].filter((id) => (this.notBefore.get(id) ?? 0) <= now);
			if (!due.length) return;
			for (const id of due) {
				this.dirty.delete(id);
				await this.refresh(client, id);
			}
		}
	}
	async refresh(client, id) {
		const fetchedAt = Date.now();
		try {
			const session = await client.session.get({ sessionID: id }, { signal: this.signal });
			await refreshSession(this.index, client, session, fetchedAt, this.signal);
			this.failures.delete(id);
			this.notBefore.set(id, Date.now() + this.refreshInterval);
		} catch (error) {
			this.signal?.throwIfAborted();
			if (notFound(error)) {
				this.forget(id);
				this.index.removeSession(id);
			} else this.failed(id, error);
		}
	}
	failed(id, error) {
		const attempts = (this.failures.get(id) ?? 0) + 1;
		this.failures.set(id, attempts);
		this.notBefore.set(id, Date.now() + Math.min(1e3 * 2 ** attempts, 6e5));
		this.dirty.add(id);
		if (attempts === 1) console.error(`History index could not refresh session ${id}; retrying with backoff:`, describe(error));
	}
	forget(id) {
		this.dirty.delete(id);
		this.notBefore.delete(id);
		this.failures.delete(id);
	}
};
//#endregion
//#region src/read.ts
var readInput = z.object({
	sessionID: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(100).optional(),
	cursor: z.string().min(1).optional(),
	messageID: z.string().min(1).optional(),
	before: z.number().int().min(0).max(50).optional(),
	after: z.number().int().min(0).max(50).optional(),
	role: z.enum(["user", "assistant"]).optional(),
	maxCharsPerMessage: z.number().int().min(100).max(2e4).default(2e3),
	includeToolResults: z.boolean().default(false)
}).strict().refine((a) => !a.messageID || !a.cursor && a.limit === void 0, { message: "messageID cannot be combined with cursor or limit" }).refine((a) => a.messageID || a.before === void 0 && a.after === void 0, { message: "before/after require messageID" });
/** Any session is readable by ID; search scope already chose which sessions to show. */
async function readHistory(client, args, signal) {
	await client.session.get({ sessionID: args.sessionID }, { signal });
	const messages = [];
	let cursor;
	const seen = /* @__PURE__ */ new Set();
	do {
		if (cursor && seen.has(cursor)) throw new Error("Repeated message cursor from OpenCode.");
		if (cursor) seen.add(cursor);
		const page = await client.message.list({
			sessionID: args.sessionID,
			limit: 100,
			order: cursor ? void 0 : "asc",
			cursor
		}, { signal });
		messages.push(...page.data);
		cursor = page.cursor.next ?? void 0;
	} while (cursor);
	const boundary = args.messageID ?? args.cursor;
	const index = boundary ? messages.findIndex((m) => m.id === boundary) : -1;
	if (boundary && index === -1) throw new Error("Message not found in session (anchor or cursor).");
	const eligible = messages.map((message, position) => ({
		message,
		index: position
	})).filter(({ message: m }) => args.role ? m.type === args.role : m.type === "user" || m.type === "assistant");
	const preceding = eligible.filter((m) => m.index < index);
	const beforeStart = Math.max(0, preceding.length - (args.before ?? 5));
	const selected = args.messageID ? [
		...preceding.slice(beforeStart),
		...eligible.filter((m) => m.index === index),
		...eligible.filter((m) => m.index > index).slice(0, args.after ?? 5)
	] : eligible.filter((m) => m.index > index).slice(0, args.limit ?? 20);
	const end = Math.max(index, selected.at(-1)?.index ?? -1);
	return JSON.stringify({
		sessionID: args.sessionID,
		anchorIncluded: args.messageID ? selected.some((m) => m.index === index) : void 0,
		messages: selected.map(({ message }) => renderMessage(message, args)),
		nextCursor: eligible.some((m) => m.index > end) ? messages[end]?.id : null
	});
}
function renderMessage(message, args) {
	let content = "";
	let length = 0;
	let toolResultsOmitted = false;
	let otherContentOmitted = message.type === "user" && !!(message.files?.length || message.agents?.length || message.skills?.length);
	const append = (text) => {
		if (typeof text !== "string") {
			otherContentOmitted = true;
			return;
		}
		const separator = length ? "\n" : "";
		content += (separator + text).slice(0, Math.max(0, args.maxCharsPerMessage - content.length));
		length += separator.length + text.length;
	};
	if (message.type === "user") append(message.text);
	if (message.type === "assistant") {
		if (!Array.isArray(message.content)) otherContentOmitted = true;
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (!part) {
				otherContentOmitted = true;
				continue;
			}
			if (part.type !== "text" && part.type !== "tool") otherContentOmitted = true;
			if (part.type === "text") append(part.text);
			if (part.type === "tool") {
				otherContentOmitted = true;
				if (typeof part.name === "string") append(`[tool: ${part.name}]`);
				if (!args.includeToolResults) {
					toolResultsOmitted = true;
					append("[tool results omitted]");
				} else {
					if (!part.state || typeof part.state !== "object") continue;
					if ("content" in part.state && Array.isArray(part.state.content)) for (const result of part.state.content ?? []) if (result?.type === "text") append(result.text);
					else otherContentOmitted = true;
					if ("error" in part.state) append(JSON.stringify(part.state.error));
				}
			}
		}
	}
	return {
		messageID: message.id,
		role: message.type,
		content,
		truncated: length > args.maxCharsPerMessage,
		toolResultsOmitted,
		otherContentOmitted
	};
}
//#endregion
//#region src/index.ts
var query = z.string().superRefine((value, ctx) => {
	try {
		parseQuery(value);
	} catch (error) {
		ctx.addIssue({
			code: "custom",
			message: String(error).replace(/^Error: /, "")
		});
	}
});
var filters = {
	date: z.string().optional(),
	limit: z.number().int().positive().optional(),
	role: z.enum(["user", "assistant"]).optional()
};
var searchMessagesInput = z.object({
	query: query.refine((value) => {
		try {
			return parseQuery(value).words.length > 0;
		} catch {
			return true;
		}
	}, "Needs at least one word or phrase; path:, project: and -exclusions only narrow results. Use history-search-sessions to list sessions or history-search-edits for file edits."),
	...filters
}).strict();
var searchSessionsInput = z.object({
	query: query.optional(),
	show: z.enum(["sessions", "projects"]).optional(),
	...filters
}).strict();
var searchEditsInput = z.object({
	query: query.optional(),
	...filters
}).strict();
var syntax = "query syntax (GitHub-style): words must all appear in the same session (case-insensitive substrings, at least 3 characters each); \"quoted phrase\" keeps spaces; -word or -\"phrase\" excludes sessions; path:src/auth.ts keeps sessions that edited that file (relative paths match at slash boundaries; quote paths with spaces); the default scope is the current project; project:<project ID> or project:<checkout or worktree path> (e.g. project:~/Code/app) searches another project including all its worktrees, and project:all searches every project. date filters by time (today, yesterday, last N days, YYYY-MM-DD, YYYY-MM, or a range \"A to B\"); role limits which messages words match (titles always count).";
var src_default = {
	id: "opencode-history-search",
	async setup(ctx) {
		const resource = await acquireIndex(ctx);
		const registration = await ctx.tool.transform((editor) => {
			editor.add({
				name: "history-read",
				description: "Read session text chronologically. sessionID defaults to the current session; use a Session ID from history-search-* to read another. role user/assistant defaults both. Without messageID, limit defaults 20 (1..100); pass nextCursor as cursor to continue exclusively after that message. With messageID, before/after count eligible neighbors (default 5 each, 0..50), include anchor only if role matches; do not combine with cursor/limit. maxCharsPerMessage defaults 2000 (100..20000); truncated/omission flags are returned. Tool results omitted unless includeToolResults:true.",
				input: readInput,
				async execute(input, context) {
					const args = readInput.parse(input);
					context.signal.throwIfAborted();
					const { client } = await resource.ready;
					return { content: await readHistory(client, {
						...args,
						sessionID: args.sessionID ?? context.sessionID
					}, context.signal) };
				}
			});
			editor.add({
				name: "history-search-sessions",
				description: `Find conversation sessions without reading their messages: for "what did we work on in ~/Code/app?" or "which sessions touched auth.ts?". Returns titles, Session IDs, update times and directories, newest first (default 20, up to 50). show:'projects' returns matching projects with session counts instead; use it with project:all for "which projects mention X?". An empty query lists recent sessions. ${syntax} Then use history-search-messages for matching excerpts or history-read on a Session ID.`,
				input: searchSessionsInput,
				async execute(input, context) {
					const args = searchSessionsInput.parse(input);
					context.signal.throwIfAborted();
					return { content: formatSessionsResult(resource.index.searchSessions(ctx.location.project.id, args)) };
				}
			});
			editor.add({
				name: "history-search-messages",
				description: `Search conversation messages. Returns matching sessions newest first, each with an excerpt and Message ID for every word. Needs at least one word or phrase. Example: "login bug" -revert project:all. ${syntax} Results are capped at 50; use history-search-sessions for broad overviews, history-search-edits for file changes, and history-read with a Session ID and Message ID for surrounding context.`,
				input: searchMessagesInput,
				async execute(input, context) {
					const args = searchMessagesInput.parse(input);
					context.signal.throwIfAborted();
					return { content: formatMessagesResult(resource.index.searchMessages(ctx.location.project.id, args)) };
				}
			});
			editor.add({
				name: "history-search-edits",
				description: `Find file edits made in conversations: completed edit/write calls and snapshot paths, newest first, each with the tool, whether it was the first recorded edit of that file, and the user prompt before it (with Message IDs). Use path:src/auth.ts for one file's history ("who changed this and why?"), or words alone for every file edited in matching sessions ("what did we change for the login bug?"). An empty query lists recent edits. ${syntax} Results are capped at 50; use history-read with a Session ID and Message ID for surrounding context.`,
				input: searchEditsInput,
				async execute(input, context) {
					const args = searchEditsInput.parse(input);
					context.signal.throwIfAborted();
					return { content: formatEditsResult(resource.index.searchEdits(ctx.location.project.id, args)) };
				}
			});
		});
		return async () => {
			await registration.dispose();
			await resource.close();
		};
	}
};
//#endregion
export { src_default as default, searchEditsInput, searchMessagesInput, searchSessionsInput };
