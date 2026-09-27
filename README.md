# @xtruder/opencode-history-search

OpenCode v2 agent tools built on one search: `history-search-messages` returns matching message excerpts; `history-search-sessions` returns matching sessions or projects without message content; `history-search-edits` returns file edits with the prompts behind them; `history-read` reads messages around a result.

## Development installation

```sh
npm ci
npm run build
```

Register the checkout directory in OpenCode's `plugins` configuration. The directory entry is `index.js` → `dist/history-search.js`. Requires OpenCode `>=2.0.16 <3`; Node/Bun must include SQLite FTS5 with the trigram tokenizer.

## Search index

The plugin owns a disposable SQLite database, separate from OpenCode's database. Tables: `sessions` (one row per session: project, directory, title, last activity, and sync bookkeeping), `documents` (one searchable document per message, plus session titles), `document_paths` (edited file paths per message) and an external-content FTS5 trigram index over `documents`. SQLite also creates its own FTS shadow tables. The schema version lives in `PRAGMA user_version`; an index with an older layout is dropped and rebuilt by backfill. No session/part replica tables, direct OpenCode SQL, worker threads or custom SQLite extensions.

Two independent jobs keep the index current, running in parallel. **Backfill** runs at startup (and again if the event subscription fails, since events after the failure are lost): it lists every session through the official API and refreshes those whose title, project, directory, or last activity (the later of `time.updated` and `time.idle`, since new messages don't bump `time.updated`) differs from the index. **Live sync** handles in-process session events, recorded from startup even before the service is discovered; token deltas are ignored. Each affected session is fetched on its own and in full, at most once a second while events keep arriving; a session that fails to refresh is logged once and retried with backoff (up to 10 minutes) without holding up others. The two never coordinate in memory: each write carries the time its fetch started, and `sessions` rejects a write older than the indexed one or than the session's deletion (a tombstone kept for a day), so a slow backfill can't overwrite newer live data or revive a deleted session. Search queries the available index without awaiting either, then applies project/role/date filtering, grouping, ordering and limiting in SQL. Results can be incomplete while backfill is in progress.

The index uses WAL, a busy timeout, retry on simultaneous startup, and write-locked (`BEGIN IMMEDIATE`) session replacement, so the stale-write check and the write are atomic even across independent processes sharing the file. SQLite still serializes writers. Search and index writes are synchronous: very broad/short queries or a large backfill can briefly block the host; removing workers does not make SQLite asynchronous.

The index lives at `<OpenCode data directory>/history-search/index-v1.sqlite`, where the data directory comes from OpenCode's own `@opencode/util/global-roots` resolver (`XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`). It contains private conversation text, including tool content; the plugin creates its directory with owner-only permissions. Stop OpenCode before deleting the index to rebuild it. It is not a backup of history. Message text is stored once, case-preserved, with a separate FTS5 trigram index; edited file paths live in an indexed `document_paths` table.

Backfill and history-read use `Service.discover()` to call the registered OpenCode service's official session/message API. Missing registration is retried in the background; the existing index remains searchable. OpenCode v2.0.16 does not give server plugins `session.list`, `message.list`, or their standalone server endpoint. The data-directory path determines where the index lives, but does not validate that a discovered service uses the same data directory. Configure and run the registered service with the same OpenCode data directory as the plugin host; without it, new history cannot be backfilled or read.

### Query syntax (all search tools)

All three search tools run the same search; they differ only in how results are aggregated. `query` uses GitHub-style syntax:

- `login token`: sessions containing every word (case-insensitive substrings, in any message or the title). Words and phrases need at least 3 characters.
- `"token refresh"`: a phrase, spaces included.
- `-revert`, `-"old api"`: drop sessions that contain the word or phrase anywhere.
- `path:src/auth.ts`: sessions with completed write/edit calls or snapshot paths for the file (in `history-search-edits`, the edits of that file). Relative paths match at slash boundaries; absolute paths require equality; quote paths with spaces (`path:"My Docs/a.ts"`).
- `project:<ID>` or `project:<path>`: search another project. A value without `/` is a project ID. A value with `/` (or starting with `~`) is a checkout or worktree path: it selects the project with sessions in that directory or below it, then searches all of that project's worktrees. `project:all` searches every project. Without `project:`, only the current project is searched.
- Only `path:` and `project:` are qualifiers, so text like `error: x` or URLs stays literal. `OR` and parentheses are not supported.

Shared inputs:

- `role`: `user` or `assistant`; limits which messages words can match (titles always count). Exclusions always consider the whole session.
- `date`: `today`, `yesterday`, `last N days/weeks/months`, `YYYY-MM-DD`, `YYYY-MM`, or `YYYY-MM-DD to YYYY-MM-DD`. Limits which messages words match, or which edits are returned.
- `limit`: positive integer; see each tool for defaults and caps. Filters apply before limiting.

### `history-search-messages`

Needs at least one word or phrase. Returns matching sessions, newest first, with the first matching message ID and a 300-character excerpt for each word. `path:` only narrows to sessions that edited the file. `limit` defaults to 50 and is capped at 50 (with a notice).

### `history-search-edits`

Returns file edits, newest first: completed write/edit calls and snapshot paths, each with the session, message ID, tool, the preceding user prompt (300 characters) and its message ID. `path:src/auth.ts` gives one file's history; words alone list every file edited in matching sessions; an empty query lists recent edits. Paths are deduplicated per message. “First edit of this file” marks the earliest indexed edit of that path in project scope, counted before date/text/limit filtering—not Git creation history. `limit` defaults to 50 and is capped at 50.

### `history-search-sessions`

Returns matching sessions without message content: title, Session ID, update time, directory and project ID, newest first. `limit` defaults to 20, capped at 50. An empty query lists the current project's recent sessions; `project:~/Code/app` lists that project's sessions including its worktrees. `show: "projects"` returns matching projects instead, one line per project with its directories and matching-session count, largest first (`limit` up to 100); use it with `project:all` for "which projects mention X?". Results come from the search index, so sessions appear once indexed.

## `history-read` inputs

`sessionID` defaults to the current session; pass a Session ID from a search result to read another, in any project. Add an optional `messageID` to read around a hit. This is a bounded **text view**, not a full session export.

| Input                | Default / bounds             | Meaning                                                                                                                                        |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionID`          | Current session              | Session to read.                                                                                                                               |
| `messageID`          | Absent                       | Anchor for a context window; cannot be combined with `cursor` or `limit`.                                                                      |
| `before`, `after`    | `5` each; integers `0..50`   | Eligible messages on either side of the anchor. Only valid with `messageID`.                                                                   |
| `cursor`             | Absent                       | Message ID to read **after**, exclusively. Use the previous response's `nextCursor`; this is not an OpenCode API cursor.                       |
| `limit`              | `20`; integer `1..100`       | Page size without an anchor.                                                                                                                   |
| `role`               | Both                         | Optional `"user"` or `"assistant"`. Other native event types are never returned.                                                               |
| `maxCharsPerMessage` | `2000`; integer `100..20000` | Maximum UTF-16 code units in each returned `content`, including tool summaries and inline markers. IDs and JSON metadata are outside this cap. |
| `includeToolResults` | `false`                      | Opt in to tool text output and structured errors. Tool inputs/metadata are never returned.                                                     |

Read around a match:

```json
{ "sessionID": "ses_…", "messageID": "msg_…", "before": 3, "after": 5 }
```

Read only user messages, then continue with the returned cursor:

```json
{ "sessionID": "ses_…", "role": "user", "limit": 20, "maxCharsPerMessage": 1000 }
```

```json
{ "sessionID": "ses_…", "role": "user", "limit": 20, "cursor": "<nextCursor>" }
```

The tool returns a JSON string with `sessionID`, chronological `messages`, and `nextCursor` (`null` at the end). Each message includes `messageID`, `role`, `content`, `truncated`, `toolResultsOmitted`, and `otherContentOmitted`. Truncation flags are outside the content cap, so even a cut-off inline marker is unambiguous. Default tool summaries contain names and `[tool results omitted]`, not inputs, outputs, errors, or metadata. `otherContentOmitted` marks omitted attachments, reasoning/non-text parts, or tool input/metadata. This text view also excludes message-level metadata, model accounting and snapshots.

Filtering happens **before** counting neighbors or filling pages. An excluded-role anchor still locates the window, but is not returned (`anchorIncluded: false`); eligible neighbors on both sides are returned. An anchor window contains at most `before + after + 1` messages. `nextCursor` continues after the window (or the anchor for an empty/exclusively-before window). Drop `messageID`/`before`/`after` when continuing, and keep the same role to avoid changing the traversal. Missing sessions, anchors, or cursor messages are errors, not empty results or a reset to page one.

Reading currently scans all native message pages of **one session** on each call, in batches of 100. It retains those messages while selecting the window/page; the output caps do not cap network traffic or scan memory. Repeated native cursors fail explicitly. API requests support cancellation. It is not a transactional snapshot: concurrent edits/deletions can change subsequent pages. To read more of a truncated message, increase the cap up to 20000; there is no within-message offset or full/binary export.

## Verification

```sh
npm run typecheck
npm run lint
npm run format:check
npm run test:all
```

Development uses Node, Vite, Vitest, type-aware Oxlint and Oxfmt. The integration test starts OpenCode 2.0.16 with isolated HOME/XDG paths and invokes both tools through a test-only RPC probe. It covers API pagination, message and session search, file tracing, message windows, content bounds/omissions and in-process lifecycle events. It makes no model calls or live-history changes. Multi-process tests exercise concurrent writes to different sessions in one index file.

CI also installs the production tarball and runs integration in UTC and America/Los_Angeles. `HISTORY_PLUGIN_PATH` selects the installed package for that check. The package contains a single built ESM bundle; test fixtures and source-only helpers are not shipped.

## Attribution

Fork of [joeyism/opencode-history-search](https://github.com/joeyism/opencode-history-search), maintained at [xtruder/opencode-history-search](https://github.com/xtruder/opencode-history-search). Original MIT license and attribution are preserved. This scoped package has not yet been published.
