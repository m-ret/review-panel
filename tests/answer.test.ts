import { describe, expect, test } from "bun:test";
import { parseFindings, readSignOff } from "../src/answer.ts";

const CODE = "7f3a-91bc";

describe("readSignOff", () => {
  test("gives what follows the bar on the last line", () => {
    expect(readSignOff("Some findings.\n\nSIGN-OFF 7f3a-91bc | 2", CODE)).toBe("2");
  });

  test("blank lines after the sign-off do not matter", () => {
    expect(readSignOff("SIGN-OFF 7f3a-91bc | 0\n\n  \n", CODE)).toBe("0");
  });

  test("a sign-off that is not the last line does not count, because the answer went on and may have been cut", () => {
    expect(readSignOff("SIGN-OFF 7f3a-91bc | 0\nOne more thing: the", CODE)).toBeNull();
  });

  test("a code from another run, or one half of this one, does not count", () => {
    expect(readSignOff("SIGN-OFF 1111-2222 | 0", CODE)).toBeNull();
    expect(readSignOff("SIGN-OFF 7f3a | 0", CODE)).toBeNull();
    expect(readSignOff("SIGN-OFF 91bc | 0", CODE)).toBeNull();
    expect(readSignOff("SIGN-OFF 7f3a-91bcd | 0", CODE)).toBeNull();
  });

  test("a refusal that quotes the instruction in the middle of a sentence does not count", () => {
    expect(readSignOff("You asked me to end with SIGN-OFF 7f3a-91bc | 0, but I cannot help.", CODE)).toBeNull();
  });

  test("a line with the code and nothing after the bar does not count", () => {
    expect(readSignOff("SIGN-OFF 7f3a-91bc |", CODE)).toBeNull();
    expect(readSignOff("SIGN-OFF 7f3a-91bc", CODE)).toBeNull();
  });

  test("the dressing models put around a line is accepted", () => {
    for (const line of [
      "**SIGN-OFF 7f3a-91bc | 2**",
      "`SIGN-OFF 7f3a-91bc | 2`",
      "> SIGN-OFF 7f3a-91bc | 2",
      "### SIGN-OFF 7f3a-91bc | 2",
      "sign-off 7F3A-91BC | 2",
      "SIGN-OFF: 7f3a-91bc | 2",
      "SIGN‑OFF 7f3a–91bc ｜ 2",
    ]) {
      expect(readSignOff(`text\n${line}`, CODE)).toBe("2");
    }
  });

  test("a closing code fence after the sign-off is not an extra line", () => {
    expect(readSignOff("```\nFINDING ...\nSIGN-OFF 7f3a-91bc | 1\n```", CODE)).toBe("1");
  });

  test("a recommendation keeps its own punctuation", () => {
    expect(readSignOff("SIGN-OFF 7f3a-91bc | Use a queue, not cron. It retries.", CODE)).toBe(
      "Use a queue, not cron. It retries.",
    );
  });

  test("an empty answer has no sign-off", () => {
    expect(readSignOff("", CODE)).toBeNull();
    expect(readSignOff("\n\n", CODE)).toBeNull();
  });
});

describe("parseFindings", () => {
  test("reads severity, place and text", () => {
    expect(parseFindings("FINDING | blocker | src/pay.ts:42 | The refund runs twice when the webhook repeats.")).toEqual([
      { severity: "blocker", where: "src/pay.ts:42", what: "The refund runs twice when the webhook repeats." },
    ]);
  });

  test("text may hold bars of its own", () => {
    expect(parseFindings("FINDING | minor | a.ts:1 | `a || b` should be `a ?? b`")[0]?.what).toBe(
      "`a || b` should be `a ?? b`",
    );
  });

  test("the dressing models put around a line is accepted", () => {
    for (const line of [
      "- FINDING | major | a.ts:1 | text",
      "**FINDING | major | a.ts:1 | text**",
      "1. FINDING | major | a.ts:1 | text",
      "| FINDING | major | a.ts:1 | text |",
      "finding | MAJOR | `a.ts:1` | text",
      "**FINDING** | **major** | a.ts:1 | text",
    ]) {
      expect(parseFindings(line)).toEqual([{ severity: "major", where: "a.ts:1", what: "text" }]);
    }
  });

  test("keeps the order and ignores the lines between findings", () => {
    const text = [
      "Here is what I found.",
      "FINDING | minor | b.ts:2 | second place",
      "Fix: rename it.",
      "FINDING | blocker | a.ts:1 | first in severity",
      "SIGN-OFF 7f3a-91bc | 2",
    ].join("\n");
    expect(parseFindings(text).map((finding) => finding.where)).toEqual(["b.ts:2", "a.ts:1"]);
  });

  test("a sentence that mentions a finding is not one", () => {
    expect(parseFindings("This FINDING | is | not | at the start")).toEqual([]);
    expect(parseFindings("FINDING: something vague")).toEqual([]);
  });

  test("a hostile line cannot hold the run up", () => {
    const started = performance.now();
    for (const line of ["`".repeat(20_000), "*".repeat(20_000), `FINDING ${"_ ".repeat(20_000)}|`, `${" ".repeat(20_000)}x`, `${"`".repeat(8000)}x`]) {
      parseFindings(line);
      readSignOff(line, CODE);
    }
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("the example line from the instructions is not a finding when a model repeats it", () => {
    expect(parseFindings("FINDING | blocker, major or minor | path/to/file.ts:42 | what goes wrong, and when")).toEqual([]);
  });
});
