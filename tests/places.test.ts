import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeResultsFolder, writeNew } from "../src/places.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function temporary(): string {
  const folder = mkdtempSync(join(tmpdir(), "review-panel-places-"));
  folders.push(folder);
  return folder;
}

describe("writeNew", () => {
  test("never overwrites a file", () => {
    const folder = temporary();
    writeFileSync(join(folder, "a.md"), "theirs");
    expect(() => writeNew(folder, "a.md", "ours")).toThrow();
    expect(readFileSync(join(folder, "a.md"), "utf8")).toBe("theirs");
  });

  test("never follows a link, not even to a file that does not exist yet", () => {
    const folder = temporary();
    const outside = join(temporary(), "outside");
    symlinkSync(outside, join(folder, "a.md"));
    expect(() => writeNew(folder, "a.md", "ours")).toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  test("leaves the file readable for its owner only, because answers quote private code", () => {
    const folder = temporary();
    writeNew(folder, "a.md", "ours");
    expect(statSync(join(folder, "a.md")).mode & 0o777).toBe(0o600);
  });
});

describe("makeResultsFolder", () => {
  test("is a folder for its owner only", () => {
    const state = temporary();
    const folder = makeResultsFolder(undefined, "one", { XDG_STATE_HOME: state });
    expect(folder).toBe(join(state, "review-panel/one"));
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });
});
