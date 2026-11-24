import { describe, expect, test } from "bun:test";
import { parseFindings, readSignOff } from "../src/answer.ts";
import { buildPrompt, makeCodes, signOffCode } from "../src/prompt.ts";

const codes = { first: "7f3a9c", second: "91bc04", marker: "c0ffee12" };
const material = "diff --git a/src/pay.ts b/src/pay.ts\n+refund();";
const build = (over: Partial<Parameters<typeof buildPrompt>[0]> = {}) =>
  buildPrompt({ kind: "diff", areas: ["payments", "code"], material, codes, ...over });

describe("buildPrompt", () => {
  test("carries the material exactly as given, between two marker lines", () => {
    expect(build()).toContain(`\n=====BEGIN c0ffee12=====\n${material}\n=====END c0ffee12=====\n`);
  });

  test("the first half of the code is only above the material and the second half only below it", () => {
    const [above = "", below = ""] = build().split(material);
    expect(above).toContain("7f3a9c");
    expect(above).not.toContain("91bc04");
    expect(below).toContain("91bc04");
    expect(below).not.toContain("7f3a9c");
  });

  test("a reviewer that lost either end of the packet cannot sign", () => {
    const prompt = build();
    const middle = prompt.indexOf(material);
    for (const part of [prompt.slice(middle), prompt.slice(0, middle + material.length)]) {
      expect(part.includes("7f3a9c") && part.includes("91bc04")).toBe(false);
    }
  });

  test("a reviewer that only repeats the prompt has not signed and has found nothing", () => {
    for (const kind of ["diff", "question"] as const) {
      const prompt = build({ kind });
      expect(readSignOff(prompt, signOffCode(codes))).toBeNull();
      expect(parseFindings(prompt)).toEqual([]);
    }
  });

  test("tells the reviewer what the change touches", () => {
    expect(build({ areas: ["security", "data"] })).toContain("security, data");
  });

  test("asks for findings on a diff and for a recommendation on a question", () => {
    expect(build()).toContain("FINDING |");
    const question = build({ kind: "question" });
    expect(question).not.toContain("FINDING |");
    expect(question).toContain("recommendation");
    expect(build()).toContain("The second half is below the change.");
    expect(question).toContain("The second half is below the question.");
  });
});

describe("makeCodes", () => {
  test("every run gets codes of its own", () => {
    const seen = new Set(Array.from({ length: 200 }, () => Object.values(makeCodes()).join()));
    expect(seen.size).toBe(200);
  });

  test("the sign-off code is the two halves joined by a hyphen", () => {
    expect(signOffCode(codes)).toBe("7f3a9c-91bc04");
    expect(signOffCode(makeCodes())).toMatch(/^[0-9a-f]{6}-[0-9a-f]{6}$/u);
  });
});
