import type {
  EditsResult,
  FileEdit,
  MessagesResult,
  ProjectMatch,
  SessionListing,
  SessionMatch,
  SessionsResult,
} from "./results";

export function formatFileEdits(matches: FileEdit[]): string {
  if (matches.length === 0) {
    return "No file edits found in conversation history.";
  }

  const lines: string[] = [
    `Found ${matches.length} file edits, newest first (use history-read with a Session ID and Message ID for context):\n`,
  ];

  for (const match of matches) {
    const timestamp = new Date(match.timestamp);
    const date = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    const time = timestamp.toTimeString().split(" ")[0];

    lines.push(`## ${match.sessionTitle}`);
    lines.push(`- Session ID: ${match.sessionID}`);
    lines.push(`- Date: ${date} ${time}`);
    if (match.messageID) {
      lines.push(`- Message ID: ${match.messageID}`);
    }

    lines.push(`- Status: ${match.firstTouch ? "First edit of this file" : "Later edit"}`);
    lines.push(`- File: ${match.filePath}`);
    if (match.toolName) {
      lines.push(`- Tool: ${match.toolName}`);
    }

    if (match.userPrompt) {
      lines.push(
        `- Preceding User Prompt: "${match.userPrompt}"${match.userPromptTruncated ? " [truncated]" : ""}`,
      );
    }

    if (match.userPromptMessageID) {
      lines.push(`- Preceding User Message ID: ${match.userPromptMessageID}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

export function formatSessionResults(matches: SessionMatch[]): string {
  if (matches.length === 0) {
    return "No sessions found in conversation history.";
  }

  const lines: string[] = [`Found ${matches.length} sessions in conversation history:\n`];

  for (const match of matches) {
    const timestamp = new Date(match.timestamp);
    const date = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    const time = timestamp.toTimeString().split(" ")[0];

    lines.push(`## ${match.sessionTitle}`);
    lines.push(`- Session ID: ${match.sessionID}`);
    lines.push(`- Project: ${match.projectDirectory}`);
    lines.push(`- Date: ${date} ${time}`);

    if (match.termHits.size > 0) {
      const termList = Array.from(match.termHits.keys()).join(", ");

      lines.push(`- Matched words: ${termList}`);
      for (const [term, hit] of match.termHits) {
        lines.push(`  - ${term}: ${hit.excerpt}`);
        if (hit.messageID) {
          lines.push(`    - Message ID: ${hit.messageID}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function formatProjects(projects: ProjectMatch[], hasMore: boolean): string {
  if (!projects.length) {
    return "No matching projects found in conversation history.";
  }

  return [
    `Found ${projects.length}${hasMore ? "+" : ""} projects (matching sessions per project; narrow with project:<project ID>):`,
    ...projects.map(
      (project) =>
        `- ${project.directories.join(", ")} (${project.sessions} ${project.sessions === 1 ? "session" : "sessions"}; project ID: ${project.projectID})`,
    ),
    ...(hasMore ? ["More projects exist; refine the query or raise limit (up to 100)."] : []),
  ].join("\n");
}

function formatListing(sessions: SessionListing[], hasMore: boolean): string {
  if (!sessions.length) {
    return "No sessions found in conversation history.";
  }

  return [
    `Found ${sessions.length}${hasMore ? "+" : ""} sessions, most recently updated first (use history-read with a Session ID to inspect work):`,
    ...sessions.map(
      (session) =>
        `- ${JSON.stringify(session.sessionTitle)}\n  Session ID: ${session.sessionID}\n  Updated: ${new Date(session.timestamp).toISOString()}\n  Directory: ${session.projectDirectory}\n  Project ID: ${session.projectID}`,
    ),
    ...(hasMore ? ["More sessions exist; refine the query or raise limit (up to 50)."] : []),
  ].join("\n");
}

export function formatSessionsResult(result: SessionsResult): string {
  return result.kind === "projects"
    ? formatProjects(result.projects, result.hasMore)
    : formatListing(result.sessions, result.hasMore);
}

function withCap(output: string, cappedFrom?: number): string {
  return cappedFrom
    ? `${output}\nDetailed results capped at 50 (requested ${cappedFrom}); use history-search-sessions with show:'projects' for a compact overview or refine the query.`
    : output;
}

export function formatMessagesResult(result: MessagesResult): string {
  return withCap(formatSessionResults(result.matches), result.cappedFrom);
}

export function formatEditsResult(result: EditsResult): string {
  return withCap(formatFileEdits(result.edits), result.cappedFrom);
}
