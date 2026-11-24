import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("the demo", () => {
  test("runs without any key, and shows every way a reviewer can be missing", async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../demo/demo.ts")], {
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(out).toContain("2 of 4 reviewers answered");
    for (const reason of ["truncated", "rate-limited", "out-of-credit", "over-budget", "author"]) {
      expect(out).toContain(reason);
    }
    expect(out).toContain("exit code 1");
  });
});
