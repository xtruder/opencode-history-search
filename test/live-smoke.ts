// Opt-in, GET-only smoke against the registered local service. No session writes.
import { OpenCode, type SessionInfo } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext, ToolEditor, Info } from "@opencode/plugin/promise/tool";
import assert from "node:assert/strict";

import definition from "../index.js";

const plugin = definition as Plugin.Plugin;

const endpoint = await Service.discover({ version: "2.0.16" });

assert(endpoint, "No registered 2.0.16 service");
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const projects = new Map<string, SessionInfo[]>();
let cursor: string | undefined;

do {
  // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
  const page = await client.session.list({ limit: 100, cursor });

  for (const session of page.data) {
    projects.set(session.projectID, [...(projects.get(session.projectID) ?? []), session]);
  }
  cursor = page.cursor.next ?? undefined;
} while (cursor);
let verified = false;

for (const [projectID, sessions] of [...projects].toSorted((a, b) => a[1].length - b[1].length)) {
  const session = sessions[0]!;
  // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
  const page = await client.message.list({ sessionID: session.id, limit: 100 });
  const message = page.data.find((m) => m.type === "user" && m.text.length > 20);

  if (!message || message.type !== "user") {
    continue;
  }
  const query = message.text.slice(0, 60);
  let tool: Info | undefined;
  const context = {
    app: { version: "2.0.16" },
    location: { project: { id: projectID } },
    tool: {
      transform: async (fn: (editor: ToolEditor) => void) => {
        const editor = {
          add: (value: Info) => {
            if (value.name === "history-search-messages") {
              tool = value;
            }
          },
        };

        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Only add is used by setup.
        fn(editor as unknown as ToolEditor);

        return { dispose: async () => {} };
      },
    },
  };
  // eslint-disable-next-line no-await-in-loop, typescript/no-unsafe-type-assertion -- Minimal setup context; inspect one project at a time.
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);

  try {
    assert(tool);
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- History search uses only the cancellation signal.
    const execution = { signal: AbortSignal.timeout(60000) } as ToolContext;
    // eslint-disable-next-line no-await-in-loop -- Check one project at a time.
    const output = await tool.execute({ query, role: "user", limit: 50 }, execution);

    assert(
      typeof output.content === "string" &&
        output.content.includes(session.id) &&
        output.content.includes(query),
    );
    console.log(
      JSON.stringify({
        service: endpoint.url,
        // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
        version: (await client.server.info()).version,
        projectSessions: sessions.length,
        foundKnownMessage: true,
        result: output.content.split("\n")[0],
        mutations: 0,
      }),
    );
    verified = true;
  } finally {
    // eslint-disable-next-line no-await-in-loop -- Ordered cursor/readiness or fixture assertions; avoid overlapping host operations.
    await cleanup?.();
  }
  break;
}
assert(verified, "No searchable native API message found");
