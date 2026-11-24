import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig, readKeys } from "../src/config.ts";

const reviewer = (over: object = {}) => ({
  id: "alpha",
  lab: "lab-a",
  provider: "main",
  model: "vendor/alpha-1",
  goodAt: ["code"],
  usdPerMillionTokens: { input: 1, output: 2 },
  ...over,
});

const config = (over: object = {}) => ({
  providers: { main: { baseUrl: "https://api.example.com/v1", apiKeyEnv: "MAIN_API_KEY" } },
  reviewers: [reviewer(), reviewer({ id: "beta", lab: "lab-b", model: "vendor/beta-1" })],
  ...over,
});

const parse = (value: unknown) => parseConfig(JSON.stringify(value));

function problemOf(value: unknown): string {
  try {
    parse(value);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return "(accepted)";
}

describe("parseConfig", () => {
  test("fills in the limits that were left out", () => {
    expect(parse(config()).limits).toEqual({
      timeoutSeconds: 300,
      checkTimeoutSeconds: 60,
      maxOutputTokens: 16_000,
      maxUsd: 0.5,
      maxInputBytes: 300_000,
    });
  });

  test("keeps the limits that were given", () => {
    expect(parse(config({ limits: { maxUsd: 0 } })).limits.maxUsd).toBe(0);
  });

  test("the example file that ships with the repo is valid", async () => {
    const text = await Bun.file(new URL("../panel.example.json", import.meta.url)).text();
    expect(new Set(parseConfig(text).reviewers.map((one) => one.lab)).size).toBeGreaterThanOrEqual(4);
  });

  test("a key written in the file is refused, and the message does not repeat it", () => {
    const value = "k-live-0123456789";
    const problem = problemOf(
      config({ providers: { main: { baseUrl: "https://api.example.com/v1", apiKey: value } } }),
    );
    expect(problem).toContain("apiKey");
    expect(problem).toContain("environment variable");
    expect(problem).not.toContain(value);
  });

  test("the hint about keys is there even when another setting is wrong too", () => {
    const main = { baseUrl: "https://api.example.com/v1", apiKey: "x", color: "red" };
    expect(problemOf(config({ providers: { main } }))).toContain("environment variable");
  });

  test("a provider speaks the usual dialect unless the config says otherwise", () => {
    expect(parse(config()).providers["main"]).toMatchObject({ maxTokensParam: "max_tokens", streamUsage: true });
  });

  test("a key pasted where the variable name belongs is refused, and the message does not repeat it", () => {
    const value = "nv-0123456789abcdef";
    const problem = problemOf(
      config({ providers: { main: { baseUrl: "https://api.example.com/v1", apiKeyEnv: value } } }),
    );
    expect(problem).toContain("apiKeyEnv");
    expect(problem).not.toContain(value);
  });

  test("a file that is not JSON is refused without repeating what it holds", () => {
    expect(() => parseConfig("{ apiKey: hunter2 }")).toThrow("not valid JSON");
    expect(() => parseConfig("{ apiKey: hunter2 }")).not.toThrow("hunter2");
  });

  test("an address must be https, so a key and a diff never travel in the clear", () => {
    const at = (baseUrl: string) => problemOf(config({ providers: { main: { baseUrl, apiKeyEnv: "MAIN_API_KEY" } } }));
    expect(at("http://api.example.com/v1")).toContain("https");
    expect(at("ftp://api.example.com/v1")).toContain("https");
    expect(at("not an address")).toContain("https");
    expect(at("http://localhost.evil.com/v1")).toContain("https");
    expect(at("https://api.example.com/v1")).toBe("(accepted)");
    expect(at("http://localhost:11434/v1")).toBe("(accepted)");
    expect(at("http://127.0.0.1:11434/v1")).toBe("(accepted)");
    expect(at("http://[::1]:11434/v1")).toBe("(accepted)");
  });

  test("an address with a password, a query or a fragment in it is refused, and not repeated", () => {
    for (const baseUrl of [
      "https://user:hunter2@api.example.com/v1",
      "https://api.example.com/v1?key=hunter2",
      "https://api.example.com/v1#hunter2",
    ]) {
      const problem = problemOf(config({ providers: { main: { baseUrl, apiKeyEnv: "MAIN_API_KEY" } } }));
      expect(problem).toContain("baseUrl");
      expect(problem).not.toContain("hunter2");
    }
  });

  test("a trailing slash or question mark on an address is dropped, so the path is joined the same way", () => {
    for (const baseUrl of ["https://api.example.com/v1/", "https://api.example.com/v1?", "https://api.example.com/v1/#"]) {
      const parsed = parse(config({ providers: { main: { baseUrl, apiKeyEnv: "MAIN_API_KEY" } } }));
      expect(parsed.providers["main"]?.baseUrl).toBe("https://api.example.com/v1");
    }
  });

  test("a reviewer needs a price, because a cap cannot hold back a call of unknown cost", () => {
    const { usdPerMillionTokens: _, ...noPrice } = reviewer();
    expect(problemOf(config({ reviewers: [noPrice, reviewer({ id: "beta", lab: "lab-b" })] }))).toContain(
      "usdPerMillionTokens",
    );
    expect(
      problemOf(
        config({ reviewers: [reviewer({ usdPerMillionTokens: { input: -1, output: 0 } }), reviewer({ id: "beta" })] }),
      ),
    ).toContain("usdPerMillionTokens");
  });

  test("a reviewer id that could leave the output folder is refused", () => {
    for (const id of ["../up", "a/b", "", "Upper", "a b", "-x"]) {
      expect(problemOf(config({ reviewers: [reviewer({ id }), reviewer({ id: "beta", lab: "lab-b" })] }))).toContain(
        "reviewers.0.id",
      );
    }
  });

  test("the file name of the summary cannot be taken by a reviewer", () => {
    expect(problemOf(config({ reviewers: [reviewer({ id: "summary" }), reviewer()] }))).toContain("summary");
  });

  test("two reviewers cannot share an id", () => {
    expect(problemOf(config({ reviewers: [reviewer(), reviewer()] }))).toContain("alpha");
  });

  test("a reviewer must use a provider that exists", () => {
    expect(problemOf(config({ reviewers: [reviewer({ provider: "nope" }), reviewer({ id: "beta" })] }))).toContain(
      "nope",
    );
  });

  test("one reviewer is not a panel", () => {
    expect(problemOf(config({ reviewers: [reviewer()] }))).toContain("reviewers");
  });

  test("reviewers from one lab alone cannot make a panel, because a lab gets one seat", () => {
    expect(problemOf(config({ reviewers: [reviewer(), reviewer({ id: "alpha-2" })] }))).toContain("two different labs");
  });

  test("a name that could mean two different labs is refused, so an author always means one", () => {
    expect(
      problemOf(config({ reviewers: [reviewer({ id: "lab-b" }), reviewer({ id: "beta", lab: "lab-b" })] })),
    ).toContain("lab-b");
    expect(problemOf(config({ authors: { alpha: "lab-b" } }))).toContain("alpha");
    expect(problemOf(config({ authors: { "lab-a": "lab-b" } }))).toContain("lab-a");
    expect(problemOf(config({ authors: { alpha: "lab-a" } }))).toBe("(accepted)");
  });

  test("one model cannot be listed under two labs", () => {
    expect(
      problemOf(config({ reviewers: [reviewer(), reviewer({ id: "beta", lab: "lab-b", model: "Vendor/Alpha-1" })] })),
    ).toContain("reviewers.1.model");
  });

  test("'human' is taken: it means no model wrote the work", () => {
    expect(problemOf(config({ authors: { human: "lab-a" } }))).toContain("human");
    expect(problemOf(config({ reviewers: [reviewer({ id: "human" }), reviewer({ id: "beta" })] }))).toContain("human");
  });

  test("a misspelled setting is refused instead of being ignored", () => {
    expect(problemOf(config({ limits: { maxUSD: 5 } }))).toContain("maxUSD");
  });
});

describe("readKeys", () => {
  const providers = {
    main: { baseUrl: "https://api.example.com/v1", apiKeyEnv: "MAIN_API_KEY" },
    local: { baseUrl: "http://localhost:11434/v1" },
  };
  const parsed = parse(config({ providers }));

  test("takes keys from the environment and drops stray spaces", () => {
    expect(readKeys(parsed, { MAIN_API_KEY: " secret\n" })).toEqual({
      main: { state: "present", key: "secret" },
      local: { state: "not-needed" },
    });
  });

  test("a key with characters that cannot go in a header counts as missing", () => {
    for (const value of ["two words", "line\nbreak", "ünicode-key"]) {
      expect(readKeys(parsed, { MAIN_API_KEY: value })["main"]).toEqual({ state: "missing", variable: "MAIN_API_KEY" });
    }
  });

  test("an unset or blank variable is a missing key, named by its variable", () => {
    expect(readKeys(parsed, {})["main"]).toEqual({ state: "missing", variable: "MAIN_API_KEY" });
    expect(readKeys(parsed, { MAIN_API_KEY: "  " })["main"]).toEqual({ state: "missing", variable: "MAIN_API_KEY" });
  });
});
