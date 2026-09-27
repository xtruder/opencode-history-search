/**
 * GitHub-style search syntax, kept deliberately small:
 *   words             every word must appear in the session (AND); at least 3 characters
 *   "a phrase"        literal text including spaces
 *   -word             exclude sessions containing the word or "-phrase"
 *   path:a/b.ts       sessions that edited a file; path:"a b/c.ts" for spaces
 *   project:<id>      one project by ID, or by a checkout/worktree path (project:~/Code/app);
 *                     project:all for every project
 * Only these qualifiers are parsed, so pasted text such as `error: x` or URLs stays literal.
 * An empty query is valid and matches every session.
 */
export interface ParsedQuery {
  words: string[];
  excluded: string[];
  path?: string;
  project?: string;
}

const qualifiers = ["path", "project"] as const;
const examples = { path: "path:src/auth.ts", project: "project:~/Code/app" };

export function parseQuery(input: string): ParsedQuery {
  const words: string[] = [];
  const excluded: string[] = [];
  const found: Partial<Record<(typeof qualifiers)[number], string>> = {};
  let i = 0;

  const value = (): string => {
    if (input[i] !== '"') {
      const start = i;

      while (i < input.length && !/\s/.test(input[i]!)) {
        i++;
      }

      return input.slice(start, i);
    }

    const end = input.indexOf('"', i + 1);

    if (end < 0) {
      throw new Error(`Unclosed quote in query: ${input}`);
    }

    const text = input.slice(i + 1, end);

    i = end + 1;

    return text;
  };

  while (i < input.length) {
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }

    const negated = input[i] === "-" && i + 1 < input.length && !/\s/.test(input[i + 1]!);

    if (negated) {
      i++;
    }

    const qualifier = qualifiers.find(
      (name) => input.slice(i, i + name.length + 1).toLowerCase() === `${name}:`,
    );

    if (qualifier) {
      if (negated) {
        throw new Error(`-${qualifier}: is not supported.`);
      }

      if (found[qualifier] !== undefined) {
        throw new Error(`Only one ${qualifier}: qualifier is supported per query.`);
      }

      i += qualifier.length + 1;
      found[qualifier] = value();
      if (!found[qualifier]) {
        throw new Error(`${qualifier}: needs a value, e.g. ${examples[qualifier]}`);
      }

      continue;
    }

    const text = value();

    if (text) {
      (negated ? excluded : words).push(text);
    }
  }

  // The trigram index cannot match fewer than three code points.
  // eslint-disable-next-line typescript/no-misused-spread -- Count Unicode code points like FTS5.
  const short = [...words, ...excluded].find((text) => [...text].length < 3);

  if (short !== undefined) {
    throw new Error(
      `Search words need at least 3 characters: ${JSON.stringify(short)}. Use a longer word or a quoted phrase.`,
    );
  }

  return { words: unique(words), excluded: unique(excluded), ...found };
}

// Matching is case-insensitive, so words differing only in case are the same term.
function unique(texts: string[]): string[] {
  const seen = new Set<string>();

  return texts.filter((text) => {
    const key = text.toLowerCase();

    return !seen.has(key) && !!seen.add(key);
  });
}
