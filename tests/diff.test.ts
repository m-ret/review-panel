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
    expect(parseDiff(added).files).toMatchObject([{ path: "src/new.ts", oldPath: null, added: 1, removed: 0 }]);
    expect(parseDiff(deleted).files).toMatchObject([
      { path: "src/auth/old.ts", oldPath: "src/auth/old.ts", added: 0, removed: 1 },
    ]);
  });

  test("reads several files of a plain diff, which has no 'diff --git' lines", () => {
    const plain = lines("--- src/a.ts", "+++ src/a.ts", "@@ -1 +1 @@", "-a", "+b");
    expect(parseDiff(plain + plain.replaceAll("a.ts", "b.ts")).files).toMatchObject([
      { path: "src/a.ts", added: 1, removed: 1 },
      { path: "src/b.ts", added: 1, removed: 1 },
    ]);
  });

  test("a hunk may end with removed lines or with added lines", () => {
    const ends = (header: string, ...body: string[]) =>
      parseDiff(lines("--- a/x", "+++ b/x", header, ...body)).files[0];
    expect(ends("@@ -1,3 +1 @@", " a", "-b", "-c")).toMatchObject({ added: 0, removed: 2 });
    expect(ends("@@ -1 +1,3 @@", " a", "+b", "+c")).toMatchObject({ added: 2, removed: 0 });
  });

  test("the last line counts even when the text does not end with a line break", () => {
    expect(parseDiff(MODIFIED.trimEnd().replace(/\n three$/u, "\n three\n-x").replace("-1,3 +1,4", "-1,4 +1,4"))).toMatchObject({
      files: [{ added: 2, removed: 2 }],
      problem: null,
    });
  });

  test("text around the diff, such as a commit message that quotes one, adds no files", () => {
    const message = lines(
      "commit 4b1f0d2",
      "",
      "    This reverts what diff --git a/src/auth.ts b/src/auth.ts did:",
      "    diff --git a/src/auth.ts b/src/auth.ts",
      "    new file mode 100644",
      "    --- a/src/auth.ts",
      "    +++ b/src/auth.ts",
      "    @@ -1 +1 @@",
      "--- a line of its own",
      "+++ another line of its own",
      "",
    ).replace("--- a line of its own\n", "--- a line of its own\nand text under it\n");
    expect(parseDiff(message + MODIFIED)).toMatchObject({ files: [{ path: "src/a.ts", added: 2 }], problem: null });
    expect(paths(message + MODIFIED)).toEqual(["src/a.ts"]);
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

  test("a path with ' b/' in it, or with quotes, is read whole even when only the header names it", () => {
    const modeChange = (header: string) => paths(lines(header, "old mode 100644", "new mode 100755"));
    expect(modeChange("diff --git a/x b/y.sh b/x b/y.sh")).toEqual(["x b/y.sh"]);
    expect(modeChange('diff --git "a/caf\\303\\251.sh" "b/caf\\303\\251.sh"')).toEqual(["café.sh"]);
  });

  test("a/ and b/ are only dropped when both sides have them", () => {
    const named = (oldName: string, newName: string) =>
      parseDiff(lines(`--- ${oldName}`, `+++ ${newName}`, "@@ -1 +1 @@", "-a", "+b")).files[0];
    expect(named("a/x.ts", "lib/x.ts")).toMatchObject({ oldPath: "a/x.ts", path: "lib/x.ts" });
    expect(named("data/x.ts", "lib/x.ts")).toMatchObject({ oldPath: "data/x.ts", path: "lib/x.ts" });
    expect(named("a/x.ts", "b/x.ts")).toMatchObject({ oldPath: "x.ts", path: "x.ts" });
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

  test("says so even when only added lines, or only removed lines, are missing from it", () => {
    const cut = (header: string) => parseDiff(lines("--- a/x", "+++ b/x", header, " a")).problem;
    expect(cut("@@ -1 +1,2 @@")).toContain("stops in the middle");
    expect(cut("@@ -1,2 +1 @@")).toContain("stops in the middle");
  });

  test("says so when a hunk holds more lines of one kind than its header promised", () => {
    expect(parseDiff(lines("--- a/x", "+++ b/x", "@@ -1,2 +1 @@", "+a", "+b", "-c", "-d")).problem).toContain("line 5");
    expect(parseDiff(lines("--- a/x", "+++ b/x", "@@ -1 +1,2 @@", "-a", "-b", "+c", "+d")).problem).toContain("line 5");
  });

  test("a hunk that claims more lines than it has swallows the next header, as it does for git, or leaves a problem", () => {
    const next = ["--- a/src/auth.ts", "+++ b/src/auth.ts", "@@ -1 +1 @@", "-a", "+b"];
    const read = (claim: string) => parseDiff(lines("--- a/x", "+++ b/x", claim, " a", ...next));
    for (const claim of ["@@ -1,3 +1,3 @@", "@@ -1,9 +1,9 @@", "@@ -1,99999999999999999999 +1 @@"]) {
      expect(read(claim).problem).not.toBeNull();
    }
    // Here the counts come out even, so both header lines are content. "git apply --numstat" says the same: 2 2 x.
    expect(read("@@ -1,2 +1,2 @@")).toMatchObject({ files: [{ path: "x", added: 2, removed: 2 }], problem: null });
  });

  test("says so when a hunk header cannot be read", () => {
    expect(parseDiff(lines("--- a/x", "+++ b/x", "@@ nonsense @@", "+a")).problem).toContain("line 3");
  });

  test("after a broken hunk it still finds the files that follow", () => {
    const broken = lines("--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "not a diff line", "-b", "+c");
    expect(parseDiff(broken + MODIFIED)).toMatchObject({
      files: [{ path: "x" }, { path: "src/a.ts", added: 2, removed: 1 }],
      problem: "line 5 does not fit the hunk it is in",
    });
    const cutShort = lines("--- a/x", "+++ b/x", "@@ -1,9 +1,9 @@", " a");
    expect(parseDiff(cutShort + MODIFIED)).toMatchObject({
      files: [{ path: "x" }, { path: "src/a.ts", added: 2, removed: 1 }],
      problem: "line 5 does not fit the hunk it is in",
    });
  });

  test("says so when a hunk holds a line that is not part of a diff", () => {
    const broken = lines("--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "not a diff line", "-b", "+c");
    expect(parseDiff(broken).problem).toContain("line 5");
  });

  test("says so for a merge diff, whose hunks count differently", () => {
    const merge = lines("diff --cc src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@@ -1,2 -1,2 +1,2 @@@", "  a");
    expect(parseDiff(merge).problem).toContain("merge");
    expect(paths(merge)).toEqual(["src/a.ts"]);
  });

  test("says so when there is nothing that looks like a changed file", () => {
    expect(parseDiff("hello\nworld\n")).toEqual({ files: [], problem: "no changed file found" });
  });

  test("a hunk with no file above it is a problem, not a crash", () => {
    expect(parseDiff(lines("@@ -1 +1 @@", "-a", "+b")).problem).toContain("no file");
  });
});
