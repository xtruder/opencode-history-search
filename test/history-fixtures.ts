import { OpenCode, type SessionInfo, type SessionMessageInfo } from "@opencode/client";

export const session = (id: string, projectID = "project"): SessionInfo => ({
  id,
  projectID,
  title: `Session ${id}`,
  location: { directory: `/repo/${projectID}` },
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
export const user = (
  id: string,
  text: string,
  created = new Date(2026, 0, 2).getTime(),
): SessionMessageInfo => ({
  id,
  type: "user",
  text,
  time: { created },
});

export function api(sessions: SessionInfo[], messages: Record<string, SessionMessageInfo[]>) {
  const calls: URL[] = [];
  const client = OpenCode.make({
    baseUrl: "http://history.test",
    fetch: async (input: Request | string | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);

      calls.push(url);
      if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
        return Response.json({ message: "Cursor cannot be combined with order" }, { status: 400 });
      }

      const [, , , sessionID, resource] = url.pathname.split("/");

      if (sessionID && !resource) {
        const found = sessions.find((s) => s.id === sessionID);

        return found
          ? Response.json({ data: found })
          : Response.json(
              { _tag: "SessionNotFoundError", message: `Session not found: ${sessionID}` },
              { status: 404 },
            );
      }

      const source =
        url.pathname === "/api/session"
          ? sessions.filter(
              (s) =>
                !url.searchParams.get("project") || s.projectID === url.searchParams.get("project"),
            )
          : (messages[url.pathname.split("/")[3]!] ?? []);
      const index = Number(url.searchParams.get("cursor") ?? 0);

      return Response.json({
        data: source.slice(index, index + 1),
        cursor: { next: index + 1 < source.length ? String(index + 1) : null },
      });
    },
  });

  return { client, calls };
}

export const assistant = (
  id: string,
  text: string,
  created = new Date(2026, 0, 3).getTime(),
): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "test" },
  time: { created },
  content: [{ type: "text", text }],
});
