/** One edit of a file: an edit/write call or snapshot path in an assistant message. */
export interface FileEdit {
  sessionID: string;
  sessionTitle: string;
  timestamp: number;
  firstTouch: boolean;
  messageID?: string;
  userPrompt: string | null;
  userPromptTruncated?: boolean;
  userPromptMessageID?: string;
  toolName: string | null;
  filePath: string;
}

/** A session containing every query word, with the first hit for each. */
export interface SessionMatch {
  sessionID: string;
  sessionTitle: string;
  timestamp: number;
  projectDirectory: string;
  termHits: Map<string, { messageID?: string; excerpt: string }>;
}

export interface ProjectMatch {
  projectID: string;
  /** Checkout and worktree directories of the project's matching sessions. */
  directories: string[];
  sessions: number;
}

export interface SessionListing {
  sessionID: string;
  sessionTitle: string;
  projectDirectory: string;
  projectID: string;
  timestamp: number;
}

/** Detailed results report the requested limit when it exceeded the cap. */
export interface MessagesResult {
  matches: SessionMatch[];
  cappedFrom?: number;
}

export interface EditsResult {
  edits: FileEdit[];
  cappedFrom?: number;
}

export type SessionsResult =
  | { kind: "list"; sessions: SessionListing[]; hasMore: boolean }
  | { kind: "projects"; projects: ProjectMatch[]; hasMore: boolean };
