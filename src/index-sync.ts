/* eslint-disable no-await-in-loop -- Cursor pagination, synchronization and subscription recovery are ordered. */
import { OpenCode, type OpenCodeClient, type SessionInfo } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";
import { roots } from "@opencode/util/global-roots";
import type { Plugin } from "@opencode/plugin";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { SearchIndex, sameFingerprint, sessionFingerprint } from "./search-index";

const describe = (error: unknown) => (error instanceof Error ? error.message : "unknown error");
const notFound = (error: unknown) =>
  error instanceof Error && error.name === "SessionNotFoundError";

/** Fetch all of a session's messages and write them as a fetch that started at `fetchedAt`. */
async function refreshSession(
  index: SearchIndex,
  client: OpenCodeClient,
  session: SessionInfo,
  fetchedAt: number,
  signal?: AbortSignal,
): Promise<void> {
  const messages = [];
  let cursor: string | undefined;
  const seen = new Set<string>();

  do {
    if (cursor && seen.has(cursor)) {
      throw new Error("Repeated message cursor from OpenCode.");
    }

    if (cursor) {
      seen.add(cursor);
    }

    const page = await client.message.list(
      { sessionID: session.id, limit: 100, order: cursor ? undefined : "asc", cursor },
      { signal },
    );

    messages.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  signal?.throwIfAborted();
  index.replaceSession(session, messages, fetchedAt);
}

async function listSessions(client: OpenCodeClient, signal?: AbortSignal): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();

  do {
    if (cursor && seen.has(cursor)) {
      throw new Error("Repeated session cursor from OpenCode.");
    }

    if (cursor) {
      seen.add(cursor);
    }

    const page = await client.session.list(
      { limit: 100, order: cursor ? undefined : "desc", cursor },
      { signal },
    );

    sessions.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  return sessions;
}

/**
 * Bring the index up to date with every session OpenCode lists, refreshing the
 * ones whose metadata changed since they were indexed. Runs at startup and
 * after the event subscription fails; LiveSync covers changes in between.
 *
 * It runs concurrently with LiveSync. Every write carries the listing's start
 * time, so a live refresh fetched after it is never overwritten by this slower
 * pass, and a session deleted meanwhile is never written back (see
 * SearchIndex.replaceSession). Sessions missing from the listing are kept:
 * another OpenCode process sharing the index may own them.
 */
export async function backfill(
  index: SearchIndex,
  client: OpenCodeClient,
  options: {
    signal?: AbortSignal;
    /** A session failed to refresh; without a handler it is logged and skipped. */
    onError?: (sessionID: string, error: unknown) => void;
  } = {},
): Promise<void> {
  const { signal, onError } = options;
  const listedAt = Date.now();
  const sessions = await listSessions(client, signal);
  const known = index.sessionFingerprints();

  for (const session of sessions) {
    const indexed = known.get(session.id);

    if (indexed && sameFingerprint(indexed, sessionFingerprint(session))) {
      continue;
    }

    try {
      await refreshSession(index, client, session, listedAt, signal);
    } catch (error) {
      signal?.throwIfAborted();

      if (notFound(error)) {
        index.removeSession(session.id);
      } else if (onError) {
        onError(session.id, error);
      } else {
        console.error(`History index could not refresh session ${session.id}:`, describe(error));
      }
    }
  }
}

export function indexPath(): string {
  return join(roots("opencode").data, "history-search", "index-v1.sqlite");
}

export async function discoverService(
  version: string,
  signal: AbortSignal,
  discover: (options: { version: string }) => Promise<Endpoint | undefined> = Service.discover,
  wait: (
    ms: number,
    value: undefined,
    options: { signal: AbortSignal },
  ) => Promise<undefined> = sleep,
): Promise<Endpoint> {
  while (!signal.aborted) {
    const endpoint = await discover({ version });
    if (endpoint) {
      return endpoint;
    }

    await wait(1000, undefined, { signal });
  }

  signal.throwIfAborted();
  throw new Error("History index stopped");
}

/** One shared index per server process; each location owns its local event subscription. */
type SharedIndex = {
  refs: number;
  controller: AbortController;
  index: SearchIndex;
  live: LiveSync;
  ready: Promise<{ client: OpenCodeClient; index: SearchIndex }>;
  /** Start a backfill, or queue one more if one is already running. */
  backfill: () => void;
  /** Settles once live sync and any backfill have stopped after abort. */
  stopped: () => Promise<void>;
};

let shared: Promise<SharedIndex> | undefined;

/**
 * Minimum time between refreshes of one session while events keep arriving for
 * it: an active turn emits step/text/tool events several times a second, and
 * each refresh refetches the session's messages.
 */
const sessionRefreshInterval = 1000;

export async function acquireIndex(ctx: Plugin.Context) {
  if (!shared) {
    shared = (async (): Promise<SharedIndex> => {
      const controller = new AbortController();
      const { signal } = controller;
      const index = await SearchIndex.open(indexPath());
      const client = discoverService(ctx.app.version, signal).then((endpoint) =>
        OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }),
      );
      // Created before discovery finishes so events are recorded, not dropped, meanwhile.
      const live = new LiveSync(index, client, signal, sessionRefreshInterval);
      let backfilling: Promise<void> | undefined;
      let again = false;
      const startBackfill = (): void => {
        if (backfilling) {
          again = true;

          return;
        }

        again = false;
        backfilling = (async () => {
          const resolved = await client;

          for (let failures = 0; ; failures++) {
            try {
              await backfill(index, resolved, {
                signal,
                onError: (sessionID, error) => live.retry(sessionID, error),
              });

              return;
            } catch (error) {
              if (signal.aborted) {
                return;
              }

              // Listing sessions failed, e.g. the service is briefly unavailable.
              if (failures === 0) {
                console.error("History index backfill failed; retrying:", describe(error));
              }

              await sleep(Math.min(1000 * 2 ** (failures + 1), 30_000), undefined, { signal });
            }
          }
        })()
          .catch((error: unknown) => {
            if (!signal.aborted) {
              console.error("History index unavailable:", describe(error));
            }
          })
          .finally(() => {
            backfilling = undefined;
            if (again && !signal.aborted) {
              startBackfill();
            }
          });
      };
      // Live sync runs alongside backfill from the start; the index resolves
      // races between them (see backfill).
      const liveLoop = (async () => {
        await client;

        while (!signal.aborted) {
          await live.flush();
          await sleep(250, undefined, { signal });
        }
      })().catch((error: unknown) => {
        if (!signal.aborted) {
          console.error("History index live sync stopped:", describe(error));
        }
      });

      startBackfill();

      return {
        refs: 0,
        controller,
        index,
        live,
        ready: client.then((resolved) => ({ client: resolved, index })),
        backfill: startBackfill,
        stopped: async () => {
          await liveLoop;
          await backfilling;
        },
      };
    })().catch((error: unknown) => {
      shared = undefined;
      throw error;
    });
  }

  const state = await shared;

  state.refs++;

  const subscription = new AbortController();
  const events = (async () => {
    while (!subscription.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
          state.live.event(event);
        }

        if (!subscription.signal.aborted) {
          throw new Error("History event subscription ended");
        }
      } catch (error) {
        if (subscription.signal.aborted) {
          break;
        }

        // The stream fails for good on an event it can't encode; everything after
        // it is lost, so resubscribe and backfill to catch up.
        console.error("History event subscription interrupted:", describe(error));
        state.backfill();
        await sleep(1000, undefined, { signal: subscription.signal });
      }
    }
  })().catch((error: unknown) => {
    if (!subscription.signal.aborted) {
      console.error("History event listener failed:", describe(error));
    }
  });

  return {
    index: state.index,
    ready: state.ready,
    async close() {
      subscription.abort();
      await events;
      if (--state.refs === 0) {
        shared = undefined;

        state.controller.abort();
        await state.stopped();

        state.index.close();
      }
    },
  };
}

/**
 * Keeps the index current from session events, alongside backfill. Each
 * changed session is fetched on its own, at most once per `refreshInterval`
 * while events keep arriving; a session that fails backs off without holding
 * up others. Deletions apply immediately and leave a tombstone.
 */
export class LiveSync {
  private readonly dirty = new Set<string>();
  /** Earliest next refresh per session, from throttling or failure backoff. */
  private readonly notBefore = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly client: Promise<OpenCodeClient>;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly index: SearchIndex,
    client: OpenCodeClient | Promise<OpenCodeClient>,
    private readonly signal?: AbortSignal,
    private readonly refreshInterval = 0,
  ) {
    this.client = Promise.resolve(client);
    // Discovery failure is reported by whoever awaits the client; never unhandled.
    this.client.catch(() => {});
  }

  /** Token and progress deltas never trigger indexing; the events that end them do. */
  event(event: { type: string; data: unknown }): void {
    if (
      !event.type.startsWith("session.") ||
      event.type.endsWith(".delta") ||
      event.type.endsWith(".progress")
    ) {
      return;
    }

    const data = event.data;

    if (
      !data ||
      typeof data !== "object" ||
      !("sessionID" in data) ||
      typeof data.sessionID !== "string"
    ) {
      return;
    }

    if (event.type === "session.deleted") {
      this.forget(data.sessionID);
      this.index.removeSession(data.sessionID);
    } else {
      this.dirty.add(data.sessionID);
    }
  }

  /** Take over a session that failed to refresh elsewhere (backfill) and retry it with backoff. */
  retry(sessionID: string, error: unknown): void {
    this.failed(sessionID, error);
  }

  /** Refresh every session whose events are due. Passes run one after another. */
  flush(): Promise<void> {
    const pass = this.running.catch(() => {}).then(() => this.update());

    this.running = pass;

    return pass;
  }

  private async update(): Promise<void> {
    const client = await this.client;

    for (;;) {
      const now = Date.now();
      const due = [...this.dirty].filter((id) => (this.notBefore.get(id) ?? 0) <= now);

      if (!due.length) {
        return;
      }

      for (const id of due) {
        this.dirty.delete(id);
        await this.refresh(client, id);
      }
    }
  }

  private async refresh(client: OpenCodeClient, id: string): Promise<void> {
    const fetchedAt = Date.now();

    try {
      const session = await client.session.get({ sessionID: id }, { signal: this.signal });

      await refreshSession(this.index, client, session, fetchedAt, this.signal);
      this.failures.delete(id);
      this.notBefore.set(id, Date.now() + this.refreshInterval);
    } catch (error) {
      this.signal?.throwIfAborted();

      if (notFound(error)) {
        this.forget(id);
        this.index.removeSession(id);
      } else {
        this.failed(id, error);
      }
    }
  }

  private failed(id: string, error: unknown): void {
    const attempts = (this.failures.get(id) ?? 0) + 1;

    this.failures.set(id, attempts);
    this.notBefore.set(id, Date.now() + Math.min(1000 * 2 ** attempts, 600_000));
    this.dirty.add(id);
    if (attempts === 1) {
      console.error(
        `History index could not refresh session ${id}; retrying with backoff:`,
        describe(error),
      );
    }
  }

  private forget(id: string): void {
    this.dirty.delete(id);
    this.notBefore.delete(id);
    this.failures.delete(id);
  }
}
