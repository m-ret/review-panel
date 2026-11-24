import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { resolveAuthors } from "../src/author.ts";

const config = parseConfig(
  JSON.stringify({
    providers: { main: { baseUrl: "https://api.example.com/v1" } },
    reviewers: [
      { id: "alpha", lab: "lab-a", provider: "main", model: "vendor/Alpha-1", usdPerMillionTokens: { input: 0, output: 0 } },
      { id: "beta", lab: "lab-b", provider: "main", model: "vendor/beta-1", usdPerMillionTokens: { input: 0, output: 0 } },
    ],
    authors: { claude: "anthropic" },
  }),
);

const labs = (text: string) => {
  const result = resolveAuthors(text, config);
  return result.ok ? [...result.labs].sort() : result.problem;
};

describe("resolveAuthors", () => {
  test("a reviewer, its model, its lab or an alias all lead to the lab", () => {
    expect(labs("alpha")).toEqual(["lab-a"]);
    expect(labs("vendor/Alpha-1")).toEqual(["lab-a"]);
    expect(labs("lab-b")).toEqual(["lab-b"]);
    expect(labs("claude")).toEqual(["anthropic"]);
    expect(labs("anthropic")).toEqual(["anthropic"]);
  });

  test("capital letters and stray spaces do not change who it is", () => {
    expect(labs("  ALPHA ")).toEqual(["lab-a"]);
    expect(labs("Vendor/alpha-1")).toEqual(["lab-a"]);
  });

  test("a misspelled author is refused, because guessing could seat the real one", () => {
    expect(labs("alpah")).toContain("'alpah'");
    expect(labs("alpah")).toContain("alpha");
  });

  test("several authors are all left out", () => {
    expect(labs("claude, beta")).toEqual(["anthropic", "lab-b"]);
  });

  test("one bad name in a list refuses the whole list", () => {
    expect(labs("claude, betta")).toContain("'betta'");
  });

  test("'human' leaves nobody out, and says so on record", () => {
    expect(resolveAuthors("human", config)).toMatchObject({ ok: true, names: ["human"], labs: new Set() });
  });

  test("'human' next to a model still leaves the model out", () => {
    expect(labs("human,claude")).toEqual(["anthropic"]);
  });

  test("no author at all is refused", () => {
    expect(labs("")).toContain("--author");
    expect(labs(" , ")).toContain("--author");
  });

  test("a name that JavaScript objects happen to have is not an author", () => {
    expect(labs("constructor")).toContain("'constructor'");
    expect(labs("__proto__")).toContain("'__proto__'");
  });

  test("the refusal does not print control characters back", () => {
    expect(labs("\u001b[31malpah")).not.toContain("\u001b");
  });
});
