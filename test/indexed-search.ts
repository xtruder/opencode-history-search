import type { OpenCodeClient } from "@opencode/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatEditsResult, formatMessagesResult } from "../src/format";
import { backfill } from "../src/index-sync";
import { SearchIndex, type SearchFilters } from "../src/search-index";

/** Backfills a throwaway index from fixtures and runs one search tool against it. */
export async function indexedSearch(
  client: OpenCodeClient,
  projectID: string,
  args: SearchFilters,
  tool: "messages" | "edits" = "messages",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "indexed-search-"));
  const index = await SearchIndex.open(join(dir, "index.sqlite"));

  try {
    await backfill(index, client);

    return tool === "edits"
      ? formatEditsResult(index.searchEdits(projectID, args))
      : formatMessagesResult(index.searchMessages(projectID, args));
  } finally {
    index.close();
    await rm(dir, { recursive: true, force: true });
  }
}
