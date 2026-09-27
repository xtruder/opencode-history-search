import { expect, test } from "vitest";

import { parseQuery } from "./query";

test("splits words, keeps quoted phrases and collects exclusions", () => {
  expect(parseQuery('login  "token refresh" -revert -"old api"')).toEqual({
    words: ["login", "token refresh"],
    excluded: ["revert", "old api"],
  });
});

test("path: and project: are the only qualifiers; other colons and dashes stay literal", () => {
  expect(parseQuery('path:src/auth.ts "error: x" https://x.dev a-b "- -"')).toEqual({
    path: "src/auth.ts",
    words: ["error: x", "https://x.dev", "a-b", "- -"],
    excluded: [],
  });
  expect(parseQuery('PATH:"My Docs/a.ts"')).toEqual({
    path: "My Docs/a.ts",
    words: [],
    excluded: [],
  });
});

test("project: takes a quoted or bare value; an empty query matches everything", () => {
  expect(parseQuery('Project:"~/My Code/app" login -old')).toEqual({
    project: "~/My Code/app",
    words: ["login"],
    excluded: ["old"],
  });
  expect(parseQuery("")).toEqual({ words: [], excluded: [] });
  expect(parseQuery("-revert")).toEqual({ words: [], excluded: ["revert"] });
});

test("case-insensitive duplicates collapse to the first spelling", () => {
  expect(parseQuery("Auth auth AUTH").words).toEqual(["Auth"]);
});

test.each([
  ['"unclosed', "Unclosed quote"],
  ["path:", "path: needs a value"],
  ['path:""', "path: needs a value"],
  ["path:a.ts path:b.ts", "Only one path:"],
  ["-path:a.ts x", "-path: is not supported"],
  ["project:", "project: needs a value"],
  ["project:a project:b", "Only one project:"],
  ["ab", "at least 3 characters"],
  ["login -ab", "at least 3 characters"],
  ['"東京"', "at least 3 characters"],
])("rejects %j", (input, message) => {
  expect(() => parseQuery(input)).toThrow(message);
});
