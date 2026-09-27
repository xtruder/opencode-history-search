import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
import { z } from "zod";

export const readInput = z
  .object({
    sessionID: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
    messageID: z.string().min(1).optional(),
    before: z.number().int().min(0).max(50).optional(),
    after: z.number().int().min(0).max(50).optional(),
    role: z.enum(["user", "assistant"]).optional(),
    maxCharsPerMessage: z.number().int().min(100).max(20000).default(2000),
    includeToolResults: z.boolean().default(false),
  })
  .strict()
  .refine((a) => !a.messageID || (!a.cursor && a.limit === undefined), {
    message: "messageID cannot be combined with cursor or limit",
  })
  .refine((a) => a.messageID || (a.before === undefined && a.after === undefined), {
    message: "before/after require messageID",
  });

/** Any session is readable by ID; search scope already chose which sessions to show. */
export async function readHistory(
  client: Pick<OpenCodeClient, "session" | "message">,
  args: z.infer<typeof readInput> & { sessionID: string },
  signal?: AbortSignal,
) {
  // Fail on unknown sessions before paging messages.
  await client.session.get({ sessionID: args.sessionID }, { signal });

  const messages: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();

  do {
    if (cursor && seen.has(cursor)) {
      throw new Error("Repeated message cursor from OpenCode.");
    }

    if (cursor) {
      seen.add(cursor);
    }

    // eslint-disable-next-line no-await-in-loop -- Each page requires the preceding native cursor.
    const page = await client.message.list(
      { sessionID: args.sessionID, limit: 100, order: cursor ? undefined : "asc", cursor },
      { signal },
    );

    messages.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  const boundary = args.messageID ?? args.cursor;
  const index = boundary ? messages.findIndex((m) => m.id === boundary) : -1;

  if (boundary && index === -1) {
    throw new Error("Message not found in session (anchor or cursor).");
  }

  const eligible = messages
    .map((message, position) => ({ message, index: position }))
    .filter(({ message: m }) =>
      args.role ? m.type === args.role : m.type === "user" || m.type === "assistant",
    );
  const preceding = eligible.filter((m) => m.index < index);
  const beforeStart = Math.max(0, preceding.length - (args.before ?? 5));
  const selected = args.messageID
    ? [
        ...preceding.slice(beforeStart),
        ...eligible.filter((m) => m.index === index),
        ...eligible.filter((m) => m.index > index).slice(0, args.after ?? 5),
      ]
    : eligible.filter((m) => m.index > index).slice(0, args.limit ?? 20);
  const end = Math.max(index, selected.at(-1)?.index ?? -1);

  return JSON.stringify({
    sessionID: args.sessionID,
    anchorIncluded: args.messageID ? selected.some((m) => m.index === index) : undefined,
    messages: selected.map(({ message }) => renderMessage(message, args)),
    nextCursor: eligible.some((m) => m.index > end) ? messages[end]?.id : null,
  });
}

function renderMessage(message: SessionMessageInfo, args: z.infer<typeof readInput>) {
  let content = "";
  let length = 0;
  let toolResultsOmitted = false;
  let otherContentOmitted =
    message.type === "user" &&
    !!(message.files?.length || message.agents?.length || message.skills?.length);
  const append = (text: unknown) => {
    if (typeof text !== "string") {
      otherContentOmitted = true;

      return;
    }

    const separator = length ? "\n" : "";

    content += (separator + text).slice(0, Math.max(0, args.maxCharsPerMessage - content.length));
    length += separator.length + text.length;
  };

  if (message.type === "user") {
    append(message.text);
  }

  if (message.type === "assistant") {
    if (!Array.isArray(message.content)) {
      otherContentOmitted = true;
    }

    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!part) {
        otherContentOmitted = true;
        continue;
      }

      if (part.type !== "text" && part.type !== "tool") {
        otherContentOmitted = true;
      }

      if (part.type === "text") {
        append(part.text);
      }

      if (part.type === "tool") {
        otherContentOmitted = true; // Tool inputs/metadata are never part of the text view.
        if (typeof part.name === "string") {
          append(`[tool: ${part.name}]`);
        }

        if (!args.includeToolResults) {
          toolResultsOmitted = true;
          append("[tool results omitted]");
        } else {
          if (!part.state || typeof part.state !== "object") {
            continue;
          }

          if ("content" in part.state && Array.isArray(part.state.content)) {
            for (const result of part.state.content ?? []) {
              if (result?.type === "text") {
                append(result.text);
              } else {
                otherContentOmitted = true;
              }
            }
          }

          if ("error" in part.state) {
            append(JSON.stringify(part.state.error));
          }
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
    otherContentOmitted,
  };
}
