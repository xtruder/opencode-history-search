import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { formatEditsResult, formatMessagesResult, formatSessionsResult } from "./format";
import { SearchIndex, type SearchFilters } from "./search-index";

const search = (index: SearchIndex, projectID: string, args: SearchFilters) =>
  formatMessagesResult(index.searchMessages(projectID, args));
const edits = (index: SearchIndex, projectID: string, args: SearchFilters) =>
  formatEditsResult(index.searchEdits(projectID, args));

const directories: string[] = [];
const touch = (files: string[]) => [
  { id: "m", type: "assistant", snapshot: { files }, time: { created: 3 } },
];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent processes concurrently index different sessions in one SQLite file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-writers-"));

  directories.push(dir);

  const path = join(dir, "index.sqlite");
  const source = new URL("./search-index.ts", import.meta.url).href;
  const code = `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){return next(specifier.startsWith('.') && !specifier.endsWith('.ts') && !specifier.endsWith('.js') ? specifier+'.ts' : specifier,context);}});
    const {SearchIndex}=await import(${JSON.stringify(source)});
    const index=await SearchIndex.open(process.argv[1]);
    const id=process.argv[2];
    for(let i=0;i<20;i++) index.replaceSession({id,projectID:'p',title:'session '+id,location:{directory:'/repo'},time:{updated:i}},[{id:'m',type:'user',text:'concurrent-'+id+'-'+i,time:{created:i}}]);
    index.close();
  `;

  await Promise.all(
    ["one", "two", "three"].map((id) =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, path, id]),
    ),
  );

  const index = await SearchIndex.open(path);

  try {
    expect([...index.sessionFingerprints().keys()].toSorted()).toEqual(["one", "three", "two"]);
    for (const id of ["one", "two", "three"]) {
      expect(search(index, "p", { query: `concurrent-${id}-19` })).toContain(`concurrent-${id}-19`);
    }

    expect(search(index, "p", { query: "concurrent" })).toContain("Found 3 sessions");
  } finally {
    index.close();
  }
}, 30000);

test("session search lists sessions or projects, scoped by project: with worktrees", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-projects-"));
  directories.push(dir);
  const index = await SearchIndex.open(join(dir, "index.sqlite"));
  const sessions = (projectID: string, args: Parameters<SearchIndex["searchSessions"]>[1]) =>
    formatSessionsResult(index.searchSessions(projectID, args));
  const add = (id: string, projectID: string, directory: string, text: string, updated = 2) => {
    index.replaceSession(
      { id, projectID, title: `title ${id}`, location: { directory }, time: { updated } },
      [{ id: `message-${id}`, type: "user", text, time: { created: 3 } }],
    );
  };

  try {
    add("a", "p1", "/repo/synapse", "opencode repeated opencode", 3);
    add("b", "p1", "/data/worktree/p1/fix", "opencode", 4);
    add("c", "p2", "/repo/two", "opencode");
    add("d", "p3", "/repo/synapse-extra", "unrelated");

    const all = sessions("p1", { query: "project:all opencode", show: "projects", limit: 500 });
    expect(all).toContain("/data/worktree/p1/fix, /repo/synapse (2 sessions; project ID: p1)");
    expect(all).toContain("/repo/two (1 session; project ID: p2)");
    expect(all).not.toContain("/repo/synapse-extra");
    expect(all).not.toContain("message-a");

    // Default scope is the current project; an empty query lists its recent sessions.
    const recent = sessions("p1", {});
    expect(recent).toContain("Found 2 sessions");
    expect(recent.indexOf("Session ID: b")).toBeLessThan(recent.indexOf("Session ID: a"));
    expect(recent).not.toContain("Message ID");
    // A path selects the project owning that directory, then all its worktrees.
    const byPath = sessions("p2", { query: "project:/repo/synapse/" });
    expect(byPath).toContain("Session ID: a");
    expect(byPath).toContain("Session ID: b");
    expect(byPath).not.toContain("Session ID: d");
    expect(sessions("p2", { query: "project:/repo" })).toContain("Session ID: d");
    expect(sessions("p2", { query: "project:/repo/syn" })).toContain("No sessions");
    expect(sessions("p1", { query: "project:p2" })).toContain("Session ID: c");
    expect(sessions("p1", { query: "project:synapse" })).toContain("No sessions");
    expect(sessions("p1", { query: "-repeated" })).toContain("Found 1 sessions");
    expect(sessions("p1", { query: "project:all", limit: 1 })).toContain("More sessions exist");
  } finally {
    index.close();
  }
});

test("large detailed limit is capped with an explicit context-saving notice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-cap-"));
  directories.push(dir);
  const index = await SearchIndex.open(join(dir, "index.sqlite"));

  try {
    for (let i = 0; i < 80; i++) {
      index.replaceSession(
        {
          id: `s${i}`,
          projectID: "p",
          title: `bulk ${i}`,
          location: { directory: "/repo" },
          time: { updated: i },
        },
        [{ id: `m${i}`, type: "user", text: "opencode", time: { created: i } }],
      );
    }

    const result = search(index, "p", { query: "opencode", limit: 500 });
    expect(result).toContain("capped at 50");
    expect(result).toContain("history-search-sessions");
    expect(result).toContain("Found 50 sessions");
    expect(result).toContain("Message ID: m79\n");
    expect(result).not.toContain("Message ID: m0\n");
  } finally {
    index.close();
  }
  // 80 separate write transactions; slow under a fully parallel suite.
}, 30000);

test("stores one canonical case-preserving text copy while matching case-insensitively", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-single-text-"));
  directories.push(dir);
  const path = join(dir, "index.sqlite");
  const index = await SearchIndex.open(path);
  try {
    index.replaceSession(
      {
        id: "s",
        projectID: "p",
        title: "Mixed Case",
        location: { directory: "/repo" },
        time: { updated: 2 },
      },
      [{ id: "m", type: "user", text: "AbC MixedCase", time: { created: 3 } }],
    );
    expect(search(index, "p", { query: "abc" })).toContain("AbC MixedCase");
    expect(search(index, "p", { query: "MIXEDCASE" })).toContain("AbC MixedCase");
    index.replaceSession(
      {
        id: "unicode",
        projectID: "p",
        title: "Unicode",
        location: { directory: "/repo" },
        time: { updated: 4 },
      },
      [{ id: "unicode-message", type: "user", text: "École 東京", time: { created: 5 } }],
    );
    expect(search(index, "p", { query: "école" })).toContain("École 東京");
    expect(search(index, "p", { query: "ÉCOLE" })).toContain("École 東京");
  } finally {
    index.close();
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = db
      .prepare("PRAGMA table_info(documents)")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("text");
    expect(columns).not.toContain("original");
    expect(columns).not.toContain("raw");
    expect(db.prepare("SELECT text FROM documents WHERE message_id='m'").get()?.text).toBe(
      "AbC MixedCase",
    );
  } finally {
    db.close();
  }
});

test("document paths are replaced and removed with their session documents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-paths-"));
  directories.push(dir);
  const path = join(dir, "index.sqlite");
  const index = await SearchIndex.open(path);
  const session = {
    id: "s",
    projectID: "p",
    title: "Paths",
    location: { directory: "/repo" },
    time: { updated: 2 },
  };
  const paths = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db
        .prepare("SELECT project_id, path, basename FROM document_paths ORDER BY path")
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };

  try {
    index.replaceSession(session, touch(["/repo/a.ts", "C:\\repo\\b.ts"]));
    expect(paths()).toEqual([
      { project_id: "p", path: "/repo/a.ts", basename: "a.ts" },
      { project_id: "p", path: "C:/repo/b.ts", basename: "b.ts" },
    ]);
    index.replaceSession(session, touch(["/repo/c.ts"]));
    expect(paths()).toEqual([{ project_id: "p", path: "/repo/c.ts", basename: "c.ts" }]);
    index.removeSession("s");
    expect(paths()).toEqual([]);
  } finally {
    index.close();
  }
});

test("file edits match paths across projects and ignore other basenames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-edits-"));
  directories.push(dir);
  const index = await SearchIndex.open(join(dir, "index.sqlite"));
  const add = (id: string, projectID: string, files: string[]) => {
    index.replaceSession(
      { id, projectID, title: id, location: { directory: "/repo" }, time: { updated: 2 } },
      [
        { id: `${id}-prompt`, type: "user", text: `prompt ${id}`, time: { created: 3 } },
        { id: `${id}-touch`, type: "assistant", snapshot: { files }, time: { created: 4 } },
      ],
    );
  };

  try {
    add("one", "p1", ["/repo/src/auth.ts"]);
    add("two", "p2", ["/other/src/auth.ts", "/other/src/xauth.ts"]);
    add("three", "p1", ["C:\\win\\src\\auth.ts"]);

    expect(edits(index, "p1", { query: "path:src/auth.ts" })).toContain("Found 2 file edits");
    expect(edits(index, "p1", { query: "path:auth.ts project:all" })).toContain(
      "Found 3 file edits",
    );
    expect(edits(index, "p1", { query: "path:/other/src/auth.ts" })).toContain("No file edits");
    expect(edits(index, "p1", { query: "project:all path:/other/src/auth.ts" })).toContain(
      "prompt two",
    );
    expect(edits(index, "p1", { query: "path:C:\\win\\src\\auth.ts" })).toContain("prompt three");
    // Without path:, every edited file counts; first edit is tracked per file.
    const all = edits(index, "p2", {});
    expect(all).toContain("Found 2 file edits");
    expect(all.match(/First edit of this file/g)).toHaveLength(2);
    expect(() => search(index, "p1", { query: "path:auth.ts" })).toThrow("history-search-edits");
  } finally {
    index.close();
  }
});

test("query words, phrases and exclusions match session-wide in every tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-syntax-"));
  directories.push(dir);
  const index = await SearchIndex.open(join(dir, "index.sqlite"));
  const add = (id: string, updated: number, texts: string[], files: string[] = []) => {
    index.replaceSession(
      {
        id,
        projectID: "p",
        title: `title ${id}`,
        location: { directory: "/repo" },
        time: { updated },
      },
      [
        ...texts.map((text, i) => ({
          id: `${id}-${i}`,
          type: "user",
          text,
          time: { created: updated * 10 + i },
        })),
        {
          id: `${id}-edit`,
          type: "assistant",
          snapshot: { files },
          time: { created: updated * 10 + 9 },
        },
      ],
    );
  };

  try {
    add("first", 1, ["fix login bug", "later: token refresh"], ["/repo/src/auth.ts"]);
    add("second", 2, ["login flow", "revert token change"], ["/repo/src/auth.ts"]);
    add("third", 3, ["token refresh only"], ["/repo/src/auth.ts"]);
    add("fourth", 4, ["login token refresh"]);

    const both = search(index, "p", { query: "login token" });
    expect(both).toContain("Found 3 sessions");
    expect(both).toContain("Matched words: login, token");
    expect(both).toContain("Message ID: first-1");
    expect(both).not.toContain("title third");

    const phrase = search(index, "p", { query: '"token refresh"' });
    expect(phrase).toContain("Found 3 sessions");
    expect(phrase).not.toContain("title second");
    expect(search(index, "p", { query: "login -revert" })).not.toContain("title second");

    const edited = edits(index, "p", { query: 'path:src/auth.ts login "token refresh"' });
    expect(edited).toContain("Found 1 file edits");
    expect(edited).toContain("Session ID: first");
    // firstTouch is computed before text filtering, so a later match is not "first".
    const later = edits(index, "p", { query: "path:src/auth.ts -revert only" });
    expect(later).toContain("Session ID: third");
    expect(later).toContain("Later edit");
    expect(edits(index, "p", { query: "path:src/auth.ts -revert" })).not.toContain(
      "Session ID: second",
    );
    expect(edits(index, "p", { query: "path:src/auth.ts login", role: "assistant" })).toContain(
      "No file edits",
    );
    // Words alone list every file edited in matching sessions.
    expect(edits(index, "p", { query: '"token refresh" -revert' })).toContain("Found 2 file edits");
    // In message search, path: narrows sessions but results stay excerpts.
    const narrowed = search(index, "p", { query: "path:src/auth.ts token" });
    expect(narrowed).toContain("Found 3 sessions");
    expect(narrowed).toContain("Matched words: token");
    expect(search(index, "p", { query: "path:src/auth.ts login -revert" })).toContain(
      "Found 1 sessions",
    );

    const listed = formatSessionsResult(
      index.searchSessions("p", { query: "path:src/auth.ts -revert", show: "sessions" }),
    );
    expect(listed).toContain("Found 2 sessions");
    expect(listed).not.toContain("Session ID: second");
    expect(
      formatSessionsResult(index.searchSessions("p", { query: "login -revert", show: "projects" })),
    ).toContain("2 sessions");
    expect(() => search(index, "p", { query: "-revert" })).toThrow("history-search-sessions");
  } finally {
    index.close();
  }
});

test("indexed words and phrases match exact case-folded substrings without rechecking text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-fts-literal-"));
  directories.push(dir);
  const index = await SearchIndex.open(join(dir, "index.sqlite"));
  const texts = {
    phrase: "we need token refresh here",
    newline: "token\nrefresh split by newline",
    reversed: "refresh token reversed",
    punctuation: "a-b and x.y and foo_bar",
    quoted: 'say "quoted" text',
    unicode: "École 東京 ÀÉÎ",
    operators: "SELECT * FROM x WHERE a OR b",
    windows: "the path C:\\repo\\a.ts",
  };

  for (const [id, text] of Object.entries(texts)) {
    index.replaceSession(
      { id, projectID: "p", title: "t", location: { directory: "/repo" }, time: { updated: 1 } },
      [{ id: `${id}-m`, type: "user", text, time: { created: 1 } }],
    );
  }

  const found = (query: string) =>
    [...search(index, "p", { query }).matchAll(/Session ID: (\w+)/g)]
      .map((m) => m[1]!)
      .toSorted((a, b) => a.localeCompare(b));

  try {
    expect(found('"token refresh"')).toEqual(["phrase"]);
    expect(found('"n r"')).toEqual(["phrase", "reversed"]);
    expect(found("a-b")).toEqual(["punctuation"]);
    expect(found("x.y foo_bar")).toEqual(["punctuation"]);
    expect(found('quoted"')).toEqual(["quoted"]);
    expect(found("ÉCOLE")).toEqual(["unicode"]);
    expect(found("àéî")).toEqual(["unicode"]);
    expect(found('"a OR b"')).toEqual(["operators"]);
    expect(found('"* FROM"')).toEqual(["operators"]);
    expect(found("C:\\repo")).toEqual(["windows"]);
    expect(found('"école 東京"')).toEqual(["unicode"]);
  } finally {
    index.close();
  }
});

test("persistent FTS index supports substring search and atomic replacement without duplicate hits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-index-"));

  directories.push(dir);

  const path = join(dir, "index.sqlite");
  let index = await SearchIndex.open(path);
  const session = {
    id: "s",
    projectID: "p",
    title: "Example",
    location: { directory: "/repo" },
    time: { created: 1, updated: 2 },
  };
  const messages = [{ id: "m", type: "user", text: "migration history", time: { created: 3 } }];

  index.replaceSession(session, messages);
  expect(search(index, "p", { query: "igr" })).toContain("Message ID: m");
  expect(search(index, "other", { query: "igr" })).toContain("No sessions");
  index.close();
  index = await SearchIndex.open(path);
  index.replaceSession(session, messages);
  expect(search(index, "p", { query: "igr" })).toContain("Found 1 sessions");
  index.replaceSession(session, [{ ...messages[0], text: "replacement" }]);
  expect(search(index, "p", { query: "igr" })).toContain("No sessions");
  expect(search(index, "p", { query: "replace" })).toContain("replacement");
  index.removeSession("s");
  expect(search(index, "p", { query: "replace" })).toContain("No sessions");
  index.close();
});
