import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";

const searchInput = z.record(z.string(), z.unknown());

export const probe = {
  id: "history-test",
  methods: {
    search: {
      input: z.object({
        args: searchInput,
        sessionID: z.string(),
      }),
      output: z.string(),
    },
    sessions: {
      input: z.object({ args: searchInput, sessionID: z.string() }),
      output: z.string(),
    },
    read: {
      input: z.object({ args: z.record(z.string(), z.unknown()), sessionID: z.string() }),
      output: z.string(),
    },
    edits: {
      input: z.object({ args: searchInput, sessionID: z.string() }),
      output: z.string(),
    },
  },
  events: {},
};
export default {
  id: "history-test-probe",
  async setup(ctx) {
    const registration = await ctx.rpc.register(probe, {
      async sessions({ args, sessionID }, { signal }) {
        const tool = (await ctx.tool.list()).find(
          (candidate) => candidate.name === "history-search-sessions",
        );
        if (!tool) {
          throw new Error("history-search-sessions missing from real host registry");
        }
        const context = {
          signal,
          sessionID,
          agent: "build",
          id: "test",
          messageID: "test",
          progress: async () => {},
        };
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Probe supplies the minimal tool context.
        const result = await tool.execute(args, context as unknown as ToolContext);
        if (typeof result.content !== "string") {
          throw new Error("Expected v2 string content");
        }
        return result.content;
      },
      async read({ args, sessionID }, { signal }) {
        const tool = (await ctx.tool.list()).find((candidate) => candidate.name === "history-read");

        if (!tool) {
          throw new Error("history-read missing from real host registry");
        }

        const context = {
          signal,
          sessionID,
          agent: "build",
          id: "test",
          messageID: "test",
          progress: async () => {},
        };
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Test probe supplies only context fields used by history tools.
        const result = await tool.execute(args, context as unknown as ToolContext);

        if (typeof result.content !== "string") {
          throw new Error("Expected v2 string content");
        }

        return result.content;
      },
      async search({ args, sessionID }, { signal }) {
        const tools = await ctx.tool.list();
        const tool = tools.find((candidate) => candidate.name === "history-search-messages");

        if (!tool) {
          throw new Error("history-search-messages missing from real host registry");
        }

        const context = {
          signal,
          sessionID,
          agent: "build",
          id: "test",
          messageID: "test",
          progress: async () => {},
        };

        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Probe supplies tool execution context.
        const result = await tool.execute(args, context as unknown as ToolContext);

        if (typeof result.content !== "string") {
          throw new Error("Expected v2 string content");
        }

        return result.content;
      },
      async edits({ args, sessionID }, { signal }) {
        const tools = await ctx.tool.list();
        const tool = tools.find((candidate) => candidate.name === "history-search-edits");

        if (!tool) {
          throw new Error("history-search-edits missing from real host registry");
        }

        const context = {
          signal,
          sessionID,
          agent: "build",
          id: "test",
          messageID: "test",
          progress: async () => {},
        };

        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Probe supplies tool execution context.
        const result = await tool.execute(args, context as unknown as ToolContext);

        if (typeof result.content !== "string") {
          throw new Error("Expected v2 string content");
        }

        return result.content;
      },
    });

    return () => registration.dispose();
  },
} satisfies Plugin.Plugin;
