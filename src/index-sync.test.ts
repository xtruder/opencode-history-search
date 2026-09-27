import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { roots } from "@opencode/util/global-roots";

import { api, session, user } from "../test/history-fixtures";
import { LiveSync, backfill, discoverService, indexPath } from "./index-sync";
import { formatMessagesResult } from "./format";
import { SearchIndex, type SearchFilters } from "./search-index";

const search = (index: SearchIndex, projectID: string, args: SearchFilters) =>
  formatMessagesResult(index.searchMessages(projectID, args));

test("service discovery retries until available without beginning backfill", async () => {
  const controller = new AbortController();
  const endpoint = { url: "http://example.test" };
  const discover = vi
    .fn<(options: { version: string }) => Promise<{ url: string } | undefined>>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(endpoint);
  const wait = vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined);

  await expect(discoverService("2.0.16", controller.signal, discover, wait)).resolves.toBe(
    endpoint,
  );
  expect(discover).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledTimes(1);
});

test("unavailable service discovery stops on plugin shutdown", async () => {
  const controller = new AbortController();
  const discover = vi
    .fn<(options: { version: string }) => Promise<undefined>>()
    .mockResolvedValue(undefined);
  const wait = vi.fn<() => Promise<undefined>>().mockImplementation(() => {
    controller.abort();
    return Promise.reject(controller.signal.reason);
  });

  await expect(discoverService("2.0.16", controller.signal, discover, wait)).rejects.toBeDefined();
  expect(discover).toHaveBeenCalledTimes(1);
});

test("index location follows OpenCode's own data root, not its cache root", () => {
  expect(indexPath()).toBe(join(roots("opencode").data, "history-search", "index-v1.sqlite"));
  expect(indexPath()).not.toContain(roots("opencode").cache);
});

async function withIndex(run: (index: SearchIndex, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "history-sync-"));
  const path = join(dir, "index.sqlite");
  const index = await SearchIndex.open(path);

  try {
    await run(index, path);
  } finally {
    index.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("existing index survives restart without refetching every message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-sync-"));
  const path = join(dir, "index.sqlite");
  const existing = session("existing");
  const first = await SearchIndex.open(path);
  first.replaceSession(existing, [user("kept", "previously indexed")]);
  first.close();

  const index = await SearchIndex.open(path);
  const { client, calls } = api([existing], { existing: [user("kept", "previously indexed")] });
  try {
    await backfill(index, client);
    expect(calls.some((url) => url.pathname.includes("/message"))).toBe(false);
    expect(search(index, "project", { query: "previously indexed" })).toContain("kept");
  } finally {
    index.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfill never erases sessions indexed by another instance", () =>
  withIndex(async (index) => {
    index.replaceSession(session("other"), [user("other-message", "from another instance")]);
    const { client } = api([session("own")], { own: [user("own-message", "this instance")] });

    await backfill(index, client);
    expect(search(index, "project", { query: "from another instance" })).toContain("other-message");
    expect(search(index, "project", { query: "this instance" })).toContain("own-message");
  }));

test("backfill repairs sessions whose new messages only moved time.idle", () =>
  withIndex(async (index) => {
    const sessions = [session("one")];
    const messages = { one: [user("m", "initial")] };
    const { client } = api(sessions, messages);

    await backfill(index, client);
    // OpenCode leaves time.updated alone for new messages; the turn's idle time moves.
    messages.one = [user("replacement", "reconciled")];
    sessions[0]!.time.idle = 10;
    await backfill(index, client);
    expect(search(index, "project", { query: "initial" })).toContain("No sessions");
    expect(search(index, "project", { query: "reconciled" })).toContain("reconciled");
  }));

test("live sync refreshes only the dirty session and ignores token deltas", () =>
  withIndex(async (index) => {
    const messages = { one: [user("m", "initial")], two: [user("t", "other")] };
    const { client, calls } = api([session("one"), session("two")], messages);
    const live = new LiveSync(index, client);

    await backfill(index, client);
    calls.splice(0);
    messages.one.push(user("n", "incremental"));
    live.event({ type: "session.next.text.delta", data: { sessionID: "one" } });
    await live.flush();
    expect(calls).toHaveLength(0);

    live.event({ type: "session.next.step.ended", data: { sessionID: "one" } });
    live.event({ type: "session.next.step.ended", data: { sessionID: "one" } });
    await live.flush();
    expect(search(index, "project", { query: "incremental" })).toContain("incremental");
    expect(calls.map((url) => url.pathname)).not.toContain("/api/session");
    expect(calls.some((url) => url.pathname.includes("/two"))).toBe(false);
  }));

test("live sync records events while the service is still being discovered", () =>
  withIndex(async (index) => {
    const existing = session("one");
    index.replaceSession(existing, [user("m", "initial")]);
    const { client } = api([existing], {
      one: [user("m", "initial"), user("n", "arrived early")],
    });
    let connect!: (value: typeof client) => void;
    const live = new LiveSync(index, new Promise<typeof client>((resolve) => (connect = resolve)));

    // The fingerprint is unchanged, so only the recorded event reveals the new message.
    live.event({ type: "session.next.step.ended", data: { sessionID: "one" } });
    connect(client);
    await live.flush();
    expect(search(index, "project", { query: "arrived early" })).toContain("arrived early");
  }));

test(
  "a session failing to refresh backs off without blocking the others",
  () =>
    withIndex(async (index) => {
      const { client } = api([session("broken"), session("fine")], {
        fine: [user("f", "indexed fine")],
      });
      const list = client.message.list.bind(client.message);
      let brokenCalls = 0;

      vi.spyOn(client.message, "list").mockImplementation((input, options) => {
        if (input.sessionID !== "broken") {
          return list(input, options);
        }

        brokenCalls++;

        // Reject on a timer, like a real request, so a retry loop can't starve the test timeout.
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("undecodable message")), 0);
        });
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const live = new LiveSync(index, client);

      try {
        await backfill(index, client, { onError: (id, cause) => live.retry(id, cause) });
        expect(search(index, "project", { query: "indexed fine" })).toContain("indexed fine");
        expect(brokenCalls).toBe(1);

        // Handed to live sync, which is backing off: flushing must not hammer it.
        await live.flush();
        await live.flush();
        expect(brokenCalls).toBe(1);
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
      }
      // Without per-session backoff the flush retries the broken session forever.
    }),
  5000,
);

test("deleted and vanished sessions are removed, and stay removed", () =>
  withIndex(async (index) => {
    index.replaceSession(session("deleted"), [user("d", "deleted text")]);
    index.replaceSession(session("vanished"), [user("v", "vanished text")]);
    const { client } = api([], {});
    const live = new LiveSync(index, client);

    live.event({ type: "session.deleted", data: { sessionID: "deleted" } });
    live.event({ type: "session.next.step.ended", data: { sessionID: "vanished" } });
    await live.flush();
    expect(index.sessionFingerprints().size).toBe(0);
    expect(search(index, "project", { query: "text" })).toContain("No sessions");
  }));

test("an older fetch never overwrites a newer one, nor revives a deleted session", () =>
  withIndex(async (index) => {
    const one = session("one");

    // Backfill fetched at 100, live sync at 200; backfill's slow write lands last.
    expect(index.replaceSession(one, [user("new", "newer content")], 200)).toBe(true);
    expect(index.replaceSession(one, [user("old", "older content")], 100)).toBe(false);
    expect(search(index, "project", { query: "newer content" })).toContain("newer content");
    expect(search(index, "project", { query: "older content" })).toContain("No sessions");

    // Deleted at 300: a fetch that began before it can't write the session back.
    index.removeSession("one", 300);
    expect(index.replaceSession(one, [user("old", "older content")], 250)).toBe(false);
    expect(index.sessionFingerprints().has("one")).toBe(false);
    // A later fetch (the session was recreated) is written.
    expect(index.replaceSession(one, [user("again", "recreated")], 400)).toBe(true);
    expect(search(index, "project", { query: "recreated" })).toContain("recreated");
  }));

test("backfill and live sync run concurrently; the newer fetch wins", () =>
  withIndex(async (index) => {
    const sessions = [session("one")];
    const messages = { one: [user("m", "before")] };
    const { client } = api(sessions, messages);
    const list = client.message.list.bind(client.message);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;

    // Hold backfill's message fetch so live sync fetches and writes in the middle of it.
    vi.spyOn(client.message, "list").mockImplementation(async (input, options) => {
      const page = await list(input, options);

      if (first) {
        first = false;
        await gate;
      }

      return page;
    });
    const live = new LiveSync(index, client);
    const running = backfill(index, client);

    await vi.waitFor(() => expect(first).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 2));
    messages.one = [user("n", "after")];
    live.event({ type: "session.next.step.ended", data: { sessionID: "one" } });
    await live.flush();
    release();
    await running;

    expect(search(index, "project", { query: "after" })).toContain("after");
    expect(search(index, "project", { query: "before" })).toContain("No sessions");
  }));

test("backfill's writes date from its listing, so a rename made meanwhile survives", () =>
  withIndex(async (index) => {
    const sessions = [{ ...session("one"), title: "old title" }];
    const { client } = api(sessions, { one: [user("m", "content")] });
    const list = client.session.list.bind(client.session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let listed = false;

    // Hold the listing after it was taken, so live sync writes the rename in between.
    vi.spyOn(client.session, "list").mockImplementation(async (input, options) => {
      const page = await list(input, options);

      listed = true;
      await gate;

      return page;
    });
    const live = new LiveSync(index, client);
    const running = backfill(index, client);

    await vi.waitFor(() => expect(listed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 2));
    sessions[0]!.title = "new title";
    live.event({ type: "session.updated", data: { sessionID: "one" } });
    await live.flush();
    release();
    await running;

    expect(index.sessionFingerprints().get("one")?.title).toBe("new title");
  }));
