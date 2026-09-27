import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import { test, expect, vi } from "vitest";

import type { MessagesResult } from "./results";

const mock = vi.hoisted(() => ({
  searchMessages: vi.fn<() => MessagesResult>().mockReturnValue({ matches: [] }),
}));
vi.mock("./index-sync", () => ({
  acquireIndex: () => ({
    close: async () => {},
    index: { searchMessages: mock.searchMessages },
    // Service discovery and backfill never finish; search must not wait for them.
    ready: new Promise(() => {}),
  }),
}));
import { z } from "zod";

import plugin from "./index";

async function register() {
  const tools = new Map<string, Info>();
  let disposed = false;
  const context = {
    app: { version: "2.0.16" },
    location: { project: { id: "project" } },
    tool: {
      transform: async (fn: (editor: ToolEditor) => void) => {
        const editor = { add: (value: Info) => tools.set(value.name, value) };

        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Only add is used by the registration under test.
        fn(editor as unknown as ToolEditor);

        return {
          dispose: async () => {
            disposed = true;
          },
        };
      },
    },
  };
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal host fixture implements the setup surface used by this plugin.
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);

  return { tools, cleanup, disposed: () => disposed };
}

test("recent sessions for a project expose IDs and titles without private database access", async () => {
  const { tools, cleanup } = await register();
  expect(tools.has("history-search-sessions")).toBe(true);
  await cleanup();
});

test("search does not wait for historical backfill to complete", async () => {
  const { tools, cleanup } = await register();
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal signal for the tool execution under test.
  const context = { signal: new AbortController().signal } as ToolContext;

  const result = await Promise.race([
    tools.get("history-search-messages")!.execute({ query: "project:all opencode" }, context),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("search waited for backfill")), 200),
    ),
  ]);

  expect(result).toEqual({ content: "No sessions found in conversation history." });
  expect(mock.searchMessages).toHaveBeenCalledWith("project", { query: "project:all opencode" });
  await cleanup();
});

test("both registered tools validate input before accessing the service", async () => {
  const { tools, cleanup } = await register();
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Invalid input fails before any execution-context fields are accessed.
  const context = { signal: new AbortController().signal } as ToolContext;

  expect([...tools.keys()].toSorted()).toEqual([
    "history-read",
    "history-search-edits",
    "history-search-messages",
    "history-search-sessions",
  ]);
  await expect(tools.get("history-search-messages")!.execute({}, context)).rejects.toThrow("query");
  await expect(
    tools.get("history-search-sessions")!.execute({ query: "project:" }, context),
  ).rejects.toThrow("project: needs a value");
  await expect(tools.get("history-read")!.execute({ limit: 0 }, context)).rejects.toThrow("limit");
  await cleanup();
});

test("v2 definition registers both schemas and disposes its transform", async () => {
  const { tools, cleanup, disposed } = await register();

  expect(plugin.id).toBe("opencode-history-search");
  expect([...tools.keys()].toSorted()).toEqual([
    "history-read",
    "history-search-edits",
    "history-search-messages",
    "history-search-sessions",
  ]);

  const search = tools.get("history-search-messages")!.input;
  const read = tools.get("history-read")!.input;

  expect(search).toBeInstanceOf(z.ZodType);
  expect(read).toBeInstanceOf(z.ZodType);
  if (!(search instanceof z.ZodType) || !(read instanceof z.ZodType)) {
    throw new Error("Expected Zod schemas");
  }

  expect(search.safeParse({ query: 'path:src/a.ts "login bug" -revert' }).success).toBe(true);
  expect(search.safeParse({ query: "path:src/a.ts" }).error?.issues[0]?.message).toContain(
    "history-search-edits",
  );
  expect(search.safeParse({ query: "-revert" }).error?.issues[0]?.message).toContain(
    "at least one",
  );
  expect(search.safeParse({ query: "a", terms: ["a"] }).success).toBe(false);
  expect(search.safeParse({ query: "login", allProjects: true }).success).toBe(false);
  expect(read.safeParse({}).success).toBe(true);
  expect(read.safeParse({ searchAllProjects: true }).success).toBe(false);
  expect(disposed()).toBe(false);
  await cleanup();
  expect(disposed()).toBe(true);
});
