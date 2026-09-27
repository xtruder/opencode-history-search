import { OpenCode, type SessionMessageInfo } from "@opencode/client";
import { Service } from "@opencode/client/service";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import { probe } from "./probe/index.ts";

const readResponse = z.object({
  sessionID: z.string(),
  nextCursor: z.string().nullable(),
  anchorIncluded: z.boolean().optional(),
  messages: z.array(
    z.object({
      messageID: z.string(),
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      truncated: z.boolean(),
      toolResultsOmitted: z.boolean(),
      otherContentOmitted: z.boolean(),
    }),
  ),
});

const root = resolve(import.meta.dirname, "..");
const tmp = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "history-integration-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => !key.startsWith("OPENCODE_") && value !== undefined,
  ),
);

for (const [variable, folder] of Object.entries({
  HOME: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
  XDG_CACHE_HOME: "cache",
})) {
  env[variable] = join(tmp, folder);
  // eslint-disable-next-line no-await-in-loop -- Initialize isolated fixture paths before starting the host.
  await mkdir(env[variable], { recursive: true });
}

const directory = join(tmp, "project");

await mkdir(directory);
await mkdir(join(env.XDG_CONFIG_HOME!, "opencode"));
await writeFile(
  join(env.XDG_CONFIG_HOME!, "opencode/opencode.json"),
  JSON.stringify({
    plugins: [
      { package: process.env.HISTORY_PLUGIN_PATH || root },
      { package: join(root, "test/probe") },
    ],
  }),
);

const proc = spawn("opencode", ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: directory,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(proc, "close");
const stdout = text(proc.stdout);
const stderr = text(proc.stderr);

try {
  let endpoint;

  for (let i = 0; i < 200; i++) {
    // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
    endpoint = await Service.discover({
      file: join(env.XDG_STATE_HOME!, "opencode/service.json"),
      version: "2.0.16",
    });
    if (endpoint) {
      break;
    }

    if (proc.exitCode !== null) {
      // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
      throw new Error(`Isolated service exited ${proc.exitCode}: ${await stderr}`);
    }

    // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
    await sleep(100);
  }

  assert(endpoint, "Isolated service failed to become ready");

  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const session = await client.session.create({
    title: "Native history integration",
    location: { directory },
  });
  // RPC invocation below initializes the location's tool/plugin registry.
  const messages: SessionMessageInfo[] = Array.from({ length: 101 }, (_, i) => ({
    id: `msg_history_test_${String(i).padStart(4, "0")}`,
    type: "user",
    text: "u".repeat(100) + "!",
    time: { created: new Date(2026, 0, 2).getTime() + i },
  }));

  messages.push({
    id: "msg_history_test_0101",
    type: "user",
    text: "please fix zephyr auth",
    time: { created: new Date(2026, 0, 3).getTime() },
  });
  messages.push({
    id: "msg_history_test_0102",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    time: {
      created: new Date(2026, 0, 3).getTime() + 1,
      completed: new Date(2026, 0, 3).getTime() + 2,
    },
    finish: "stop",
    content: [
      { type: "text", text: "quartz native response" },
      {
        type: "tool",
        name: "edit",
        id: "call_history",
        time: { created: new Date(2026, 0, 3).getTime() + 1 },
        state: {
          status: "completed",
          input: { filePath: `${directory}/src/auth.ts` },
          content: [{ type: "text", text: "edited" }],
        },
      },
    ],
    snapshot: { files: [`${directory}/src/auth.ts`] },
  });

  const toolMessage = messages[102]!;

  assert(toolMessage.type === "assistant");
  toolMessage.content.push({
    type: "tool",
    name: "inspect",
    id: "call_long",
    time: { created: toolMessage.time.created },
    state: {
      status: "completed",
      input: { hidden: "INPUT_SECRET" },
      content: [{ type: "text", text: "TOOL_SECRET" + "x".repeat(3000) }],
    },
  });
  toolMessage.content.push({ type: "reasoning", text: "REASONING_SECRET" });
  toolMessage.content.push({
    type: "tool",
    name: "failed",
    id: "failed_call",
    time: { created: toolMessage.time.created },
    state: { status: "error", input: {}, error: { type: "test", message: "ERROR_SECRET" } },
  });

  const alternate = structuredClone(toolMessage);

  alternate.id = messages[50]!.id;
  alternate.time = {
    created: messages[50]!.time.created,
    completed: messages[50]!.time.created + 1,
  };
  alternate.content = [
    { type: "text", text: "middle assistant" },
    {
      type: "tool",
      name: "n".repeat(3000),
      id: "long_name",
      time: { created: alternate.time.created },
      state: {
        status: "completed",
        input: {},
        content: [{ type: "text", text: "NAME_TOOL_SECRET" }],
      },
    },
  ];
  messages[50] = alternate;
  messages[0] = { ...messages[0]!, type: "user", text: "u".repeat(3000) + "!" };
  await client.session.remove({ sessionID: session.id });
  await client.session.import({ info: session, messages, location: { directory } });
  for (let i = 0; i < 100; i++) {
    // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
    await client.session.import({
      info: {
        ...session,
        id: `ses_history_pagination_${String(i).padStart(4, "0")}`,
        title: "pagination filler",
      },
      messages: [],
      location: { directory },
    });
  }

  const sessionPage = await client.session.list({
    project: session.projectID,
    limit: 100,
    order: "desc",
  });

  assert.equal(sessionPage.data.length, 100);
  assert(sessionPage.cursor.next);

  const stored = await client.message.list({ sessionID: session.id, limit: 100, order: "asc" });
  assert.equal(stored.data.length, 100);
  assert(stored.cursor.next);

  const finalPage = await client.message.list({
    sessionID: session.id,
    cursor: stored.cursor.next,
  });

  assert(finalPage.data.some((message) => message.type === "assistant"));

  const rpc = client.rpc(probe);
  const readTimings: number[] = [];
  const read = async (args: Record<string, unknown>) => {
    const started = performance.now();
    const parsed: unknown = JSON.parse(
      await rpc.read(
        { args: { sessionID: session.id, ...args }, sessionID: session.id },
        { location: { directory } },
      ),
    );

    readTimings.push(performance.now() - started);

    return readResponse.parse(parsed);
  };
  const first = await read({ limit: 2 });

  assert.deepEqual(
    first.messages.map((m) => m.messageID),
    messages.slice(0, 2).map((m) => m.id),
  );
  assert.equal(first.nextCursor, messages[1]!.id);
  assert.equal((await read({})).messages.length, 20);
  for (const role of [undefined, "user", "assistant"]) {
    const ids: string[] = [];
    let cursor: string | undefined;

    do {
      // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
      const page = await read({ role, limit: 17, cursor });

      const eligibleCount = messages.filter((m) => !role || m.type === role).length;

      assert.equal(page.messages.length, Math.min(17, eligibleCount - ids.length));
      assert(page.messages.every((m) => !role || m.role === role));
      ids.push(...page.messages.map((m) => m.messageID));
      assert(ids.length <= messages.length, "continuation loop");
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    assert.deepEqual(
      ids,
      messages.filter((m) => !role || m.type === role).map((m) => m.id),
    );
  }

  const anchored = await read({ messageID: messages[99]!.id, before: 2, after: 3 });

  assert.deepEqual(
    anchored.messages.map((m) => m.messageID),
    messages.slice(97, 103).map((m) => m.id),
  );

  const backwards = await read({ messageID: messages[101]!.id, before: 3, after: 1 });

  assert.deepEqual(
    backwards.messages.map((m) => m.messageID),
    messages.slice(98).map((m) => m.id),
  );

  const excludedAnchor = await read({
    messageID: messages[102]!.id,
    role: "user",
    before: 2,
    after: 2,
  });

  assert.equal(excludedAnchor.anchorIncluded, false);
  assert.deepEqual(
    excludedAnchor.messages.map((m) => m.messageID),
    messages.slice(100, 102).map((m) => m.id),
  );

  const partialWindow = await read({ messageID: messages[99]!.id, before: 1, after: 1 });
  const continued = await read({ cursor: partialWindow.nextCursor });

  assert.deepEqual(
    continued.messages.map((m) => m.messageID),
    messages.slice(101).map((m) => m.id),
  );

  const hidden = await read({ messageID: toolMessage.id, before: 0, after: 0 });

  assert(hidden.messages[0]!.content.includes("quartz native response"));
  assert(hidden.messages[0]!.content.includes("inspect"));
  assert.equal(hidden.messages[0]!.toolResultsOmitted, true);
  assert(!JSON.stringify(hidden).includes("TOOL_SECRET"));
  assert(!JSON.stringify(hidden).includes("INPUT_SECRET"));
  assert(!JSON.stringify(hidden).includes("REASONING_SECRET"));
  assert(!JSON.stringify(hidden).includes("ERROR_SECRET"));

  const withError = await read({
    messageID: toolMessage.id,
    before: 0,
    after: 0,
    includeToolResults: true,
    maxCharsPerMessage: 20000,
  });

  assert(withError.messages[0]!.content.includes("ERROR_SECRET"));

  const longName = await read({
    messageID: alternate.id,
    before: 0,
    after: 0,
    maxCharsPerMessage: 100,
  });

  assert.equal(longName.messages[0]!.content.length, 100);
  assert.equal(longName.messages[0]!.truncated, true);
  assert.equal(longName.messages[0]!.toolResultsOmitted, true);
  assert(!JSON.stringify(longName).includes("NAME_TOOL_SECRET"));
  assert.equal(hidden.messages[0]!.otherContentOmitted, true);

  const middle = await read({ messageID: alternate.id, role: "user", before: 2, after: 2 });

  assert.equal(middle.anchorIncluded, false);
  assert.deepEqual(
    middle.messages.map((m) => m.messageID),
    [48, 49, 51, 52].map((i) => messages[i]!.id),
  );

  const emptyWindow = await read({ messageID: alternate.id, role: "user", before: 0, after: 0 });

  assert.deepEqual(emptyWindow.messages, []);
  assert.equal(emptyWindow.nextCursor, alternate.id);

  const included = await read({
    messageID: toolMessage.id,
    before: 0,
    after: 0,
    includeToolResults: true,
    maxCharsPerMessage: 200,
  });

  assert(included.messages[0]!.content.includes("TOOL_SECRET"));
  assert(included.messages[0]!.content.length <= 200);
  assert.equal(included.messages[0]!.truncated, true);
  assert.equal(included.messages[0]!.toolResultsOmitted, false);
  assert.equal(first.messages[0]!.content.length, 2000);
  assert.equal(first.messages[0]!.truncated, true);

  const small = await read({ role: "user", limit: 1, maxCharsPerMessage: 100 });

  assert.equal(small.messages[0]!.content.length, 100);
  assert.equal(small.messages[0]!.truncated, true);
  await assert.rejects(read({ messageID: "msg_missing" }));
  await assert.rejects(read({ cursor: "msg_missing" }));
  await assert.rejects(read({ sessionID: "ses_missing" }));

  const otherDirectory = join(tmp, "other-project");

  await mkdir(otherDirectory);

  const foreign = await client.session.create({
    title: "other project",
    location: { directory: otherDirectory },
  });

  assert.notEqual(foreign.projectID, session.projectID);
  // Sessions from other projects are readable by ID; scope only limits search.
  assert.deepEqual((await read({ sessionID: foreign.id })).messages, []);
  for (const args of [
    { limit: 101 },
    { maxCharsPerMessage: 99 },
    { maxCharsPerMessage: 20001 },
    { before: 51 },
    { messageID: messages[0].id, cursor: messages[1]!.id },
    { before: 1 },
    { messageID: messages[0].id, limit: 1 },
  ]) {
    // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
    await assert.rejects(read(args));
  }

  for (const [args, expected] of [
    [{ query: "zephyr" }, "please fix zephyr auth"],
    [
      { query: "quartz", role: "assistant", date: "2026-01-03", limit: 1 },
      "quartz native response",
    ],
    [{ query: "zephyr quartz" }, "Found 1 sessions"],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
    const output = await rpc.search(
      {
        args,
        sessionID: session.id,
      },
      { location: { directory } },
    );

    console.log("Isolated search", JSON.stringify(args), output.split("\n")[0]);
    assert(output.includes(expected), output);
  }

  const edits = await rpc.edits(
    {
      args: { query: "path:src/auth.ts zephyr", date: "2026-01-03", limit: 1 },
      sessionID: session.id,
    },
    { location: { directory } },
  );
  assert(edits.includes('Preceding User Prompt: "please fix zephyr auth"'), edits);
  console.log("PASS: file edits with preceding prompt through history-search-edits");

  const projects = await rpc.sessions(
    {
      args: { query: "project:all zephyr", show: "projects", limit: 500 },
      sessionID: session.id,
    },
    { location: { directory } },
  );
  assert(projects.includes(directory), projects);
  assert(projects.includes("session"), projects);
  assert(!projects.includes("Message ID:"), projects);
  console.log("PASS: project summary returns directories and counts without message excerpts");

  const recent = await rpc.sessions(
    { args: { limit: 5 }, sessionID: session.id },
    { location: { directory } },
  );
  assert(recent.includes("Session ID: ses_history_pagination_0099"), recent);
  assert(!recent.includes("Message ID:"), recent);
  console.log("PASS: recent current-project sessions from the index, with IDs and no message dump");

  const recentByID = await rpc.sessions(
    { args: { query: `project:${session.projectID}`, limit: 5 }, sessionID: foreign.id },
    { location: { directory: otherDirectory } },
  );
  assert(recentByID.includes("Session ID: ses_history_pagination_0099"), recentByID);
  console.log("PASS: project: qualifier lists another project's sessions");

  // These changes occur after backfill. The short deadline excludes periodic reconciliation.
  const eventSession = await client.session.create({
    title: "live-index-original",
    location: { directory },
  });
  const searchLive = (query: string) =>
    rpc.search({ args: { query }, sessionID: session.id }, { location: { directory } });
  const waitFor = async (query: string, present: boolean) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      // eslint-disable-next-line no-await-in-loop -- Observe asynchronous in-process event delivery.
      const output = await searchLive(query);

      if (output.includes("No sessions") !== present) {
        return;
      }

      // eslint-disable-next-line no-await-in-loop -- Bounded readiness check, not an indexing trigger.
      await sleep(100);
    }

    throw new Error(`Live event index did not reach expected state: ${query} present=${present}`);
  };

  await waitFor("live-index-original", true);
  await client.session.update({ sessionID: eventSession.id, title: "live-index-renamed" });
  await waitFor("live-index-renamed", true);
  await waitFor("live-index-original", false);
  await client.session.remove({ sessionID: eventSession.id });
  await waitFor("live-index-renamed", false);
  await assert.rejects(
    rpc.search(
      { args: { query: "foo", regex: true }, sessionID: session.id },
      { location: { directory } },
    ),
  );
  const indexFile = join(env.XDG_DATA_HOME!, "opencode/history-search/index-v1.sqlite");

  assert((await stat(indexFile)).isFile(), "Index must live in OpenCode's isolated data directory");
  await assert.rejects(stat(join(env.XDG_CACHE_HOME!, "opencode-history-search/index-v1.sqlite")));
  console.log("PASS: index follows OpenCode data root, not its cache root");
  console.log("PASS: in-process create/rename/delete events and removed regex rejection");
  console.log(
    `PASS history-read: windows, role-filtered pagination, omissions, bounds, missing IDs and project scope. ${readTimings.length} successful RPC calls: ${Math.min(...readTimings).toFixed(1)}–${Math.max(...readTimings).toFixed(1)} ms (fixture observations only).`,
  );

  const plugins = await client.plugin.list({ location: { directory } });

  assert(plugins.data.some((p) => p.id === "opencode-history-search"));
  console.log(
    "PASS: real v2 host loaded directory plugin and native FTS5 index; 101 native sessions / 103 messages exercised both cursors; substring/AND/file edit search passed.",
  );
} finally {
  proc.kill();
  await exited;

  const logs = await Promise.all([stdout, stderr]);

  console.log(
    "Isolated server output:",
    logs.join("\n").replace(/(password|authorization)[^\n]*/gi, "$1=[REDACTED]"),
  );
  await rm(tmp, { recursive: true, force: true });
}
