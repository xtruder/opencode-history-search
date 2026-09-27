/* eslint-disable typescript/no-unsafe-type-assertion -- Test-only partial SDK contexts and malformed fixtures are intentional. */
import type { OpenCodeClient } from "@opencode/client";
import { expect, test } from "vitest";

import { readHistory, readInput } from "./read";

test("read skips malformed nested content and marks omissions", async () => {
  const client = {
    session: { get: async () => ({ projectID: "project" }) },
    message: {
      list: async () => ({
        data: [
          {
            id: "a",
            type: "assistant",
            content: [
              null,
              { type: "text", text: 42 },
              { type: "tool", name: "bad", state: null },
              {
                type: "tool",
                name: "edit",
                state: {
                  content: [
                    null,
                    { type: "text", text: 42 },
                    { type: "text", text: "valid result" },
                  ],
                },
              },
              { type: "tool", name: "bad", state: { content: {} } },
              { type: "text", text: "valid answer" },
            ],
          },
        ],
        cursor: {},
      }),
    },
  } as unknown as OpenCodeClient;
  const output = JSON.parse(
    await readHistory(client, {
      ...readInput.parse({ sessionID: "session", includeToolResults: true }),
      sessionID: "session",
    }),
  ) as { messages: { content: string; otherContentOmitted: boolean }[] };

  expect(output.messages[0]!.content).toContain("valid result");
  expect(output.messages[0]!.content).toContain("valid answer");
  expect(output.messages[0]!.otherContentOmitted).toBe(true);
});

test.each([false, true])(
  "read omits malformed tool names with results enabled: %s",
  async (includeToolResults) => {
    const client = {
      session: { get: async () => ({ projectID: "project" }) },
      message: {
        list: async () => ({
          data: [
            {
              id: "a",
              type: "assistant",
              content: [
                {
                  type: "tool",
                  name: { toString: null },
                  state: { content: [{ type: "text", text: "valid result" }] },
                },
                { type: "text", text: "valid answer" },
              ],
            },
          ],
          cursor: {},
        }),
      },
    } as unknown as OpenCodeClient;
    const output = JSON.parse(
      await readHistory(client, {
        ...readInput.parse({ sessionID: "session", includeToolResults }),
        sessionID: "session",
      }),
    ) as {
      messages: { content: string; otherContentOmitted: boolean; toolResultsOmitted: boolean }[];
    };

    expect(output.messages[0]!.content).toContain("valid answer");
    expect(output.messages[0]!.content).not.toContain("[tool:");
    expect(output.messages[0]!.content.includes("valid result")).toBe(includeToolResults);
    expect(output.messages[0]!.otherContentOmitted).toBe(true);
    expect(output.messages[0]!.toolResultsOmitted).toBe(!includeToolResults);
  },
);

test.each([null, {}])("read marks malformed content containers omitted: %j", async (content) => {
  const client = {
    session: { get: async () => ({ projectID: "project" }) },
    message: {
      list: async () => ({ data: [{ id: "a", type: "assistant", content }], cursor: {} }),
    },
  } as unknown as OpenCodeClient;
  const output = await readHistory(client, {
    ...readInput.parse({ sessionID: "session" }),
    sessionID: "session",
  });

  expect(output).toContain('"otherContentOmitted":true');
});

test("repeated native cursors fail rather than silently looping", async () => {
  let calls = 0;
  const client = {
    session: { get: async () => ({ projectID: "project" }) },
    message: {
      list: async () => {
        if (++calls > 3) {
          throw new Error("loop escaped test budget");
        }

        return { data: [], cursor: { next: "repeated" } };
      },
    },
  } as unknown as OpenCodeClient;

  await expect(
    readHistory(client, { ...readInput.parse({ sessionID: "session" }), sessionID: "session" }),
  ).rejects.toThrow("Repeated message cursor");
  expect(calls).toBe(2);
});
