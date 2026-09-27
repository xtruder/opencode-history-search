import { test, expect, describe } from "vitest";

import { formatFileEdits, formatSessionResults } from "./format";
import type { FileEdit, SessionMatch } from "./results";

test("all result formats use the local calendar date and time near UTC midnight", () => {
  // Under America/Los_Angeles this instant is 2024-01-31 16:05:06.
  const timestamp = Date.UTC(2024, 1, 1, 0, 5, 6);
  const date = new Date(timestamp);
  const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toTimeString().split(" ")[0]}`;
  const common = { sessionID: "s", sessionTitle: "title", timestamp, projectDirectory: "/project" };

  for (const output of [
    formatFileEdits([
      { ...common, firstTouch: true, filePath: "a.ts", userPrompt: null, toolName: null },
    ]),
    formatSessionResults([{ ...common, termHits: new Map() }]),
  ]) {
    expect(output).toContain(`- Date: ${expected}`);
  }
});

describe("formatFileEdits", () => {
  test("renders a single file edit", () => {
    const matches: FileEdit[] = [
      {
        sessionID: "ses_001",
        sessionTitle: "Build auth module",
        timestamp: new Date(2024, 1, 1).getTime(),
        firstTouch: true,
        userPrompt: "build me an auth module",
        toolName: "write",
        filePath: "src/auth.ts",
      },
    ];

    const output = formatFileEdits(matches);

    expect(output).toContain("Build auth module");
    expect(output).toContain("ses_001");
    expect(output).toContain("First edit of this file");
    expect(output).toContain("src/auth.ts");
    expect(output).toContain("write");
    expect(output).toContain("build me an auth module");
    expect(output).toContain("Found 1 file edits");
  });

  test("renders later edit status", () => {
    const matches: FileEdit[] = [
      {
        sessionID: "ses_002",
        sessionTitle: "Fix bug",
        timestamp: 2000,
        firstTouch: false,
        userPrompt: null,
        toolName: "edit",
        filePath: "src/bug.ts",
      },
    ];

    const output = formatFileEdits(matches);

    expect(output).toContain("Later edit");
    expect(output).not.toContain("Preceding User Prompt");
  });

  test("returns empty message when no matches", () => {
    const output = formatFileEdits([]);

    expect(output).toBe("No file edits found in conversation history.");
  });
});

describe("formatSessionResults", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Keep this fixture scoped to its test suite.
  const sampleResult = (overrides: Partial<SessionMatch> = {}): SessionMatch => ({
    sessionID: "ses_001",
    sessionTitle: "Train truck model",
    timestamp: new Date(2024, 1, 1).getTime(),
    projectDirectory: "/project/a",
    termHits: new Map(),
    ...overrides,
  });

  test("formats session results with one section per session", () => {
    const results: SessionMatch[] = [
      sampleResult({ sessionID: "ses_001", sessionTitle: "First" }),
      sampleResult({ sessionID: "ses_002", sessionTitle: "Second" }),
    ];

    const output = formatSessionResults(results);

    expect(output).toContain("Found 2 sessions");
    expect(output.match(/## /g)!.length).toBe(2);
  });

  test("lists matched words under each session", () => {
    const termHits = new Map();

    termHits.set("truck", { messageID: "p1", excerpt: "we trained truck" });
    termHits.set("vertex", { messageID: "p2", excerpt: "vertex ai" });
    termHits.set("gemini", { messageID: "p3", excerpt: "gemini-2.5" });

    const output = formatSessionResults([sampleResult({ termHits })]);

    expect(output).toContain("Matched words: truck, vertex, gemini");
  });

  test("each session shows excerpt for each matched word", () => {
    const termHits = new Map();

    termHits.set("truck", { messageID: "p1", excerpt: "we trained truck" });
    termHits.set("vertex", { messageID: "p2", excerpt: "vertex ai" });

    const output = formatSessionResults([sampleResult({ termHits })]);

    expect(output).toContain("truck: we trained truck");
    expect(output).toContain("vertex: vertex ai");
  });

  test("empty array returns no-match message", () => {
    const output = formatSessionResults([]);

    expect(output).toContain("No sessions found");
  });
});
