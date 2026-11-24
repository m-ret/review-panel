import { describe, expect, test } from "bun:test";
import { parseDiff } from "../src/diff.ts";

const lines = (...parts: string[]) => `${parts.join("\n")}\n`;
const paths = (text: string) => parseDiff(text).files.map((file) => file.path);

const MODIFIED = lines(
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@ function a() {",
  " one",
  "-two",
  "+2",
  "+two and a half",
  " three",
);

describe("parseDiff", () => {
  test("finds the file and counts what was added and removed", () => {
    expect(parseDiff(MODIFIED)).toEqual({
      files: [{ path: "src/a.ts", oldPath: "src/a.ts", added: 2, removed: 1, addedText: "2\ntwo and a half\n" }],
      problem: null,
    });
  });

  test("reads several files", () => {
    expect(paths(MODIFIED + MODIFIED.replaceAll("src/a.ts", "src/b.ts"))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a new file has only its new path, a deleted file keeps its old one", () => {
    const added = lines(
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+x",
    );
    const deleted = lines(
      "diff --git a/src/auth/old.ts b/src/auth/old.ts",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/src/auth/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    );
    expect(parseDiff(added).files[0]).toMatchObject({ path: "src/new.ts", oldPath: null });
    expect(parseDiff(deleted).files[0]).toMatchObject({ path: "src/auth/old.ts", oldPath: "src/auth/old.ts" });
  });

  test("a removed line that starts with '-- ' is content, not the header of another file", () => {
    // In SQL a comment starts with "--", so removing it prints "--- ...".
    const diff = lines(
      "diff --git a/db/x.sql b/db/x.sql",
      "--- a/db/x.sql",
      "+++ b/db/x.sql",
      "@@ -1,3 +1,3 @@",
      " select 1;",
      "--- a/docs/fake.md",
      "+++ b/docs/fake.md",
      " select 2;",
    );
    expect(parseDiff(diff)).toEqual({
      files: [{ path: "db/x.sql", oldPath: "db/x.sql", added: 1, removed: 1, addedText: "++ b/docs/fake.md\n" }],
      problem: null,
    });
  });

  test("a context line that looks like a file header does not add a file", () => {
    const diff = lines(
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,2 +1,3 @@",
      " diff --git a/src/auth.ts b/src/auth.ts",
      "+one",
      " end",
    );
    expect(paths(diff)).toEqual(["notes.txt"]);
  });

  test("a rename keeps both names, because both tell what kind of code moved", () => {
    const diff = lines(
      "diff --git a/src/auth/session.ts b/lib/helpers.ts",
      "similarity index 100%",
      "rename from src/auth/session.ts",
      "rename to lib/helpers.ts",
    );
    expect(parseDiff(diff).files).toEqual([
      { path: "lib/helpers.ts", oldPath: "src/auth/session.ts", added: 0, removed: 0, addedText: "" },
    ]);
  });

  test("a binary file and a mode change have no hunks but are still changed files", () => {
    const diff = lines(
      "diff --git a/img/a b.png b/img/a b.png",
      "index 1111111..2222222 100644",
      "Binary files a/img/a b.png and b/img/a b.png differ",
      "diff --git a/deploy.sh b/deploy.sh",
      "old mode 100644",
      "new mode 100755",
    );
    expect(paths(diff)).toEqual(["img/a b.png", "deploy.sh"]);
  });

  test("reads a quoted path with escaped bytes", () => {
    const diff = lines(
      'diff --git "a/caf\\303\\251/\\"q\\".ts" "b/caf\\303\\251/\\"q\\".ts"',
      '--- "a/caf\\303\\251/\\"q\\".ts"',
      '+++ "b/caf\\303\\251/\\"q\\".ts"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    );
    expect(paths(diff)).toEqual(['café/"q".ts']);
  });

  test("a path with a tab-separated timestamp, as plain diff -u prints it, is read without the timestamp", () => {
    const diff = lines(
      "--- src/a.ts\t2026-01-01 00:00:00.000000000 +0000",
      "+++ src/a.ts\t2026-01-02 00:00:00.000000000 +0000",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    );
    expect(paths(diff)).toEqual(["src/a.ts"]);
  });

  test("accepts the marker for a missing newline at the end of a file", () => {
    const diff = lines(
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "\\ No newline at end of file",
    );
    expect(parseDiff(diff)).toMatchObject({ files: [{ added: 1, removed: 1 }], problem: null });
  });

  test("accepts CRLF files", () => {
    expect(parseDiff(MODIFIED.replaceAll("\n", "\r\n"))).toMatchObject({
      files: [{ path: "src/a.ts", added: 2, removed: 1 }],
      problem: null,
    });
  });

  test("an empty context line that lost its leading space still counts", () => {
    const diff = lines("--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "", "-b", "+c");
    expect(parseDiff(diff)).toMatchObject({ files: [{ added: 1, removed: 1 }], problem: null });
  });

  test("says so when the diff stops in the middle of a hunk", () => {
    const cut = lines("--- a/x", "+++ b/x", "@@ -1,30 +1,30 @@", " a", "-b", "+c");
    expect(parseDiff(cut).problem).toContain("stops in the middle");
  });

  test("says so when a hunk holds a line that is not part of a diff", () => {
    const broken = lines("--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "not a diff line", "-b", "+c");
    expect(parseDiff(broken).problem).toContain("line 5");
  });

  test("says so for a merge diff, whose hunks count differently", () => {
    const merge = lines("diff --cc src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@@ -1,2 -1,2 +1,2 @@@", "  a");
    expect(parseDiff(merge).problem).toContain("merge");
  });

  test("says so when there is nothing that looks like a changed file", () => {
    expect(parseDiff("hello\nworld\n")).toEqual({ files: [], problem: "no changed file found" });
  });

  test("a hunk with no file above it is a problem, not a crash", () => {
    expect(parseDiff(lines("@@ -1 +1 @@", "-a", "+b")).problem).toContain("no file");
  });
});
