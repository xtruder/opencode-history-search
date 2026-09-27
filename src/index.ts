import type { Plugin } from "@opencode/plugin";
import { z } from "zod";

import { formatEditsResult, formatMessagesResult, formatSessionsResult } from "./format";
import { acquireIndex } from "./index-sync";
import { parseQuery } from "./query";
import { readInput, readHistory } from "./read";

const query = z.string().superRefine((value, ctx) => {
  try {
    parseQuery(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error).replace(/^Error: /, "") });
  }
});
const filters = {
  date: z.string().optional(),
  limit: z.number().int().positive().optional(),
  role: z.enum(["user", "assistant"]).optional(),
};

export const searchMessagesInput = z
  .object({
    query: query.refine((value) => {
      try {
        const parsed = parseQuery(value);

        return parsed.words.length > 0;
      } catch {
        // Syntax errors are reported by the base query check.
        return true;
      }
    }, "Needs at least one word or phrase; path:, project: and -exclusions only narrow results. Use history-search-sessions to list sessions or history-search-edits for file edits."),
    ...filters,
  })
  .strict();
export const searchSessionsInput = z
  .object({
    query: query.optional(),
    show: z.enum(["sessions", "projects"]).optional(),
    ...filters,
  })
  .strict();
export const searchEditsInput = z.object({ query: query.optional(), ...filters }).strict();

const syntax =
  'query syntax (GitHub-style): words must all appear in the same session (case-insensitive substrings, at least 3 characters each); "quoted phrase" keeps spaces; -word or -"phrase" excludes sessions; path:src/auth.ts keeps sessions that edited that file (relative paths match at slash boundaries; quote paths with spaces); the default scope is the current project; project:<project ID> or project:<checkout or worktree path> (e.g. project:~/Code/app) searches another project including all its worktrees, and project:all searches every project. date filters by time (today, yesterday, last N days, YYYY-MM-DD, YYYY-MM, or a range "A to B"); role limits which messages words match (titles always count).';

export default {
  id: "opencode-history-search",
  async setup(ctx) {
    const resource = await acquireIndex(ctx);
    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "history-read",
        description:
          "Read session text chronologically. sessionID defaults to the current session; use a Session ID from history-search-* to read another. role user/assistant defaults both. Without messageID, limit defaults 20 (1..100); pass nextCursor as cursor to continue exclusively after that message. With messageID, before/after count eligible neighbors (default 5 each, 0..50), include anchor only if role matches; do not combine with cursor/limit. maxCharsPerMessage defaults 2000 (100..20000); truncated/omission flags are returned. Tool results omitted unless includeToolResults:true.",
        input: readInput,
        async execute(input, context) {
          const args = readInput.parse(input);

          context.signal.throwIfAborted();

          const { client } = await resource.ready;

          return {
            content: await readHistory(
              client,
              { ...args, sessionID: args.sessionID ?? context.sessionID },
              context.signal,
            ),
          };
        },
      });
      editor.add({
        name: "history-search-sessions",
        description: `Find conversation sessions without reading their messages: for "what did we work on in ~/Code/app?" or "which sessions touched auth.ts?". Returns titles, Session IDs, update times and directories, newest first (default 20, up to 50). show:'projects' returns matching projects with session counts instead; use it with project:all for "which projects mention X?". An empty query lists recent sessions. ${syntax} Then use history-search-messages for matching excerpts or history-read on a Session ID.`,
        input: searchSessionsInput,
        async execute(input, context) {
          const args = searchSessionsInput.parse(input);

          context.signal.throwIfAborted();

          return {
            content: formatSessionsResult(
              resource.index.searchSessions(ctx.location.project.id, args),
            ),
          };
        },
      });
      editor.add({
        name: "history-search-messages",
        description: `Search conversation messages. Returns matching sessions newest first, each with an excerpt and Message ID for every word. Needs at least one word or phrase. Example: "login bug" -revert project:all. ${syntax} Results are capped at 50; use history-search-sessions for broad overviews, history-search-edits for file changes, and history-read with a Session ID and Message ID for surrounding context.`,
        input: searchMessagesInput,
        async execute(input, context) {
          const args = searchMessagesInput.parse(input);

          context.signal.throwIfAborted();

          return {
            content: formatMessagesResult(
              resource.index.searchMessages(ctx.location.project.id, args),
            ),
          };
        },
      });
      editor.add({
        name: "history-search-edits",
        description: `Find file edits made in conversations: completed edit/write calls and snapshot paths, newest first, each with the tool, whether it was the first recorded edit of that file, and the user prompt before it (with Message IDs). Use path:src/auth.ts for one file's history ("who changed this and why?"), or words alone for every file edited in matching sessions ("what did we change for the login bug?"). An empty query lists recent edits. ${syntax} Results are capped at 50; use history-read with a Session ID and Message ID for surrounding context.`,
        input: searchEditsInput,
        async execute(input, context) {
          const args = searchEditsInput.parse(input);

          context.signal.throwIfAborted();

          return {
            content: formatEditsResult(resource.index.searchEdits(ctx.location.project.id, args)),
          };
        },
      });
    });

    return async () => {
      await registration.dispose();
      await resource.close();
    };
  },
} satisfies Plugin.Plugin;
