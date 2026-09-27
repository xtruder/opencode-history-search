/* eslint-disable typescript/no-unsafe-type-assertion -- Deliberately malformed API fixtures. */
import { OpenCode, type SessionMessageInfo } from "@opencode/client";
import { expect, test, vi } from "vitest";

import { api, assistant, session, user } from "../test/history-fixtures";
import { indexedSearch as searchHistory } from "../test/indexed-search";

test("filters native assistant content by role/date before limiting, case-insensitively", async () => {
  const { client } = api([session("one")], {
    one: [
      user("a", "needle", new Date(2026, 0, 5).getTime()),
      assistant("b", "Needle auth module"),
    ],
  });

  const result = await searchHistory(client, "project", {
    query: "needle",
    role: "assistant",
    date: "2026-01-03",
    limit: 1,
  });

  expect(result).toContain("Needle auth module");
  expect(result).toContain("Message ID: b");
  expect(result).not.toContain("Message ID: a");
  expect(result).toContain("Found 1 sessions");
  expect(await searchHistory(client, "project", { query: "needle", date: "2026-01-04" })).toContain(
    "No sessions",
  );
});

test("AND search spans titles, messages and native tool input/output across projects", async () => {
  const edit = assistant("edit", "answer");

  if (edit.type === "assistant") {
    edit.content.push({
      type: "tool",
      id: "call",
      name: "edit",
      time: { created: 1 },
      state: {
        status: "completed",
        input: { filePath: "/repo/src/auth.ts" },
        content: [{ type: "text", text: "vertex result" }],
      },
    });
  }

  const { client } = api([session("one"), session("other", "other")], {
    one: [user("u", "truck")],
    other: [user("u2", "truck"), edit],
  });
  const result = await searchHistory(client, "project", {
    query: "project:all truck vertex auth.ts",
  });

  expect(result).toContain("Message ID: u2");
  expect(result).toContain("Message ID: edit");
  expect(result).toContain("Found 1 sessions");
  expect(result).toContain("Session other");
  expect(result).toContain("vertex");
  expect(await searchHistory(client, "project", { query: "truck vertex" })).toContain(
    "No sessions",
  );
  expect(await searchHistory(client, "project", { query: "project:all auth.ts" })).toContain(
    "/repo/src/auth.ts",
  );
});

test("file edits use boundary-safe relative paths, completed writes and snapshots with preceding prompts", async () => {
  const edit = assistant("edit", "done");

  if (edit.type === "assistant") {
    edit.content.push({
      type: "tool",
      id: "c",
      name: "edit",
      time: { created: 1 },
      state: {
        status: "completed",
        input: { filePath: "/repo/src/auth.ts" },
        content: [{ type: "text", text: "ok" }],
      },
    });
    edit.snapshot = { files: ["/repo/src/auth.ts", "/repo/other-src/auth.ts"] };
  }

  const failed = assistant("failed", "failed", new Date(2026, 0, 4).getTime());

  if (failed.type === "assistant") {
    failed.content.push({
      type: "tool",
      id: "bad",
      name: "write",
      time: { created: 1 },
      state: { status: "running", input: { filePath: "/repo/src/auth.ts" }, metadata: {} },
    });
  }

  const { client } = api([session("one")], { one: [user("u", "please fix auth"), edit, failed] });
  const result = await searchHistory(client, "project", { query: "path:src/auth.ts" }, "edits");

  expect(result).toContain("Found 1 file edits");
  expect(result).toContain("First edit of this file");
  expect(result).toContain("please fix auth");
  expect(result).not.toContain("other-src");
  expect(
    await searchHistory(client, "project", { query: "path:/wrong/src/auth.ts" }, "edits"),
  ).toContain("No file edits");
});

test("malformed and unsupported content parts do not hide valid native history", async () => {
  const message = assistant("a", "valid needle");

  if (message.type === "assistant") {
    message.content.unshift(
      ...([
        null,
        { type: "text", text: 42 },
        { type: "tool", name: "bad", state: null },
        {
          type: "tool",
          name: "edit",
          state: { status: "completed", input: null, content: [null, { type: "text", text: 42 }] },
        },
        { type: "tool", name: "bad", state: { input: undefined, content: {} } },
      ] as unknown as typeof message.content),
    );
  }

  const { client } = api([session("one")], { one: [message] });

  expect(await searchHistory(client, "project", { query: "needle" })).toContain("valid needle");
  expect(await searchHistory(client, "project", { query: "path:auth.ts" }, "edits")).toContain(
    "No file edits",
  );
});

test("excerpts stay bounded around a match in a large tool or message body", async () => {
  const { client } = api([session("one")], {
    one: [user("a", "x".repeat(10000) + "needle" + "y".repeat(10000))],
  });
  const output = await searchHistory(client, "project", { query: "needle" });

  expect(output).toContain("Message ID: a");
  expect(output).toContain("needle");
  expect(output.length).toBeLessThan(1000);
});

test("file edits bound preceding prompts and exposes both follow-up anchors", async () => {
  const touch = assistant("touch", "done");

  if (touch.type === "assistant") {
    touch.snapshot = { files: ["/repo/auth.ts"] };
  }

  const { client } = api([session("one")], { one: [user("prompt", "x".repeat(1000000)), touch] });
  const output = await searchHistory(client, "project", { query: "path:auth.ts" }, "edits");

  expect(output.length).toBeLessThan(1500);
  expect(output).toContain("[truncated]");
  expect(output).toContain("Message ID: touch");
  expect(output).toContain("Preceding User Message ID: prompt");
});

function cyclingClient(kind: "session" | "message") {
  const state = { calls: 0 };
  const client = OpenCode.make({
    baseUrl: "http://history.test",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const cycling =
        kind === "session" ? url.pathname === "/api/session" : url.pathname !== "/api/session";

      if (cycling && ++state.calls > 4) {
        throw new Error("test budget exhausted");
      }

      return Response.json({
        data: url.pathname === "/api/session" ? [session("one")] : [],
        cursor: { next: cycling ? (state.calls % 2 ? "a" : "b") : null },
      });
    },
  });

  return { client, state };
}

test("a cyclic session cursor fails the pass", async () => {
  const { client, state } = cyclingClient("session");

  await expect(searchHistory(client, "project", { query: "needle" })).rejects.toThrow(
    "Repeated session cursor",
  );
  expect(state.calls).toBe(3);
});

test("a cyclic message cursor skips only that session, logged for retry", async () => {
  const { client, state } = cyclingClient("message");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(searchHistory(client, "project", { query: "needle" })).resolves.toContain(
      "No sessions",
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("could not refresh session one"),
      "Repeated message cursor from OpenCode.",
    );
    expect(state.calls).toBe(3);
  } finally {
    error.mockRestore();
  }
});

test.each([null, {}, [null, 42]].map((invalid) => ({ invalid })))(
  "malformed content/snapshot containers remain searchable: %j",
  async ({ invalid }) => {
    const bad = {
      ...assistant("bad", ""),
      content: invalid,
      snapshot: { files: invalid },
    } as unknown as SessionMessageInfo;
    const { client } = api([session("one")], {
      one: [bad, user("bad-user", null as unknown as string), user("good", "needle")],
    });

    expect(await searchHistory(client, "project", { query: "needle" })).toContain("needle");
    expect(await searchHistory(client, "project", { query: "path:auth.ts" }, "edits")).toContain(
      "No file edits",
    );
  },
);

test("path: combined with text lists only edits in sessions containing the text", async () => {
  const touch = assistant("touch", "done");

  if (touch.type === "assistant") {
    touch.snapshot = { files: ["/repo/auth.ts"] };
  }

  const { client } = api([session("one")], { one: [user("u", "fix login"), touch] });

  expect(
    await searchHistory(client, "project", { query: "path:auth.ts login" }, "edits"),
  ).toContain("Message ID: touch");
  expect(
    await searchHistory(client, "project", { query: "path:auth.ts -login" }, "edits"),
  ).toContain("No file edits");
});

test("date filtering happens before the result limit in every mode", async () => {
  const early = {
    ...session("early"),
    time: { created: new Date(2026, 0, 2).getTime(), updated: new Date(2026, 0, 2).getTime() },
  };
  const late = {
    ...session("late"),
    time: { created: new Date(2026, 0, 5).getTime(), updated: new Date(2026, 0, 5).getTime() },
  };
  const first = assistant("first", "needle quartz early", early.time.created);
  const last = assistant("last", "needle quartz late", late.time.created);

  if (first.type === "assistant") {
    first.snapshot = { files: ["/repo/src/auth.ts"] };
  }

  if (last.type === "assistant") {
    last.snapshot = { files: ["/repo/src/auth.ts"] };
  }

  const { client } = api([late, early], { late: [last], early: [first] });

  for (const [query, tool] of [
    ["needle", "messages"],
    ["needle quartz", "messages"],
    ["path:auth.ts", "edits"],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
    const output = await searchHistory(
      client,
      "project",
      { query, date: "2026-01-02", limit: 1 },
      tool,
    );

    expect(output).toContain("Session early");
    expect(output).not.toContain("Session late");
  }
});

test("keyword searches native v2 messages through both pagination cursors and project scope", async () => {
  const { client, calls } = api([session("one"), session("two"), session("other", "other")], {
    one: [user("a", "unrelated")],
    two: [user("b", "not yet"), user("c", "needle in native v2")],
    other: [user("d", "needle in another project")],
  });
  const result = await searchHistory(client, "project", { query: "needle" });

  expect(result).toContain("needle in native v2");
  expect(result).not.toContain("another project");
  expect(
    calls.some((u) => u.pathname === "/api/session" && u.searchParams.get("cursor") === "1"),
  ).toBe(true);
  expect(
    calls.some(
      (u) => u.pathname === "/api/session/two/message" && u.searchParams.get("cursor") === "1",
    ),
  ).toBe(true);
});
