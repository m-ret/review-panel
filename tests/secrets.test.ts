import { describe, expect, test } from "bun:test";
import { findSecrets } from "../src/secrets.ts";

// The samples are put together at run time, so that no scanner finds a key in this file.
const fake = (...parts: string[]) => parts.join("");
const letters = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f";

describe("findSecrets", () => {
  test("names the kind of secret and its line, and never repeats the value", () => {
    const value = fake("ghp", "_", letters.slice(0, 36));
    const found = findSecrets(`one\n+const t = "${value}";\n`, []);
    expect(found).toEqual([{ what: "a GitHub token", line: 2 }]);
    expect(JSON.stringify(found)).not.toContain(value);
  });

  test("knows the common formats", () => {
    const samples: Record<string, string> = {
      "an AWS access key": fake("AK", "IA", "ABCDEFGHIJKLMNOP"),
      "a GitHub token": fake("github", "_pat_", letters.slice(0, 30)),
      "a model provider key": fake("sk", "-proj-", letters.slice(0, 32)),
      "an NVIDIA key": fake("nv", "api-", letters),
      "a Google API key": fake("AI", "za", letters.slice(0, 35)),
      "a signed token (JWT)": fake("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "Jyb2xlIjoic2VydmljZSJ9", ".", letters),
      "a Slack token": fake("xo", "xb-", "123456789012-abcdefGHIJ"),
      "a Stripe live key": fake("sk", "_live_", letters.slice(0, 24)),
    };
    for (const [what, value] of Object.entries(samples)) {
      expect(findSecrets(`+key = ${value}\n`, [])).toEqual([{ what, line: 1 }]);
    }
  });

  test("a private key is a header with a key body under it", () => {
    const header = fake("-----BEGIN RSA ", "PRIVATE KEY-----");
    expect(findSecrets(`+${header}\n+${letters}${letters}\n`, [])).toEqual([{ what: "a private key", line: 1 }]);
    expect(findSecrets(`+if (text.startsWith("${header}")) {\n+  return true;\n`, [])).toEqual([]);
  });

  test("a private key of any kind", () => {
    const header = fake("-----BEGIN SSH2 ENCRYPTED ", "PRIVATE KEY-----");
    expect(findSecrets(`+${header}\n+${letters}${letters}\n`, [])).toEqual([{ what: "a private key", line: 1 }]);
  });

  test("a private key written on one line, as service account files do, is found", () => {
    const header = fake("-----BEGIN ", "PRIVATE KEY-----");
    expect(findSecrets(`+  "private_key": "${header}\\n${letters}${letters}\\n"`, [])).toEqual([
      { what: "a private key", line: 1 },
    ]);
  });

  test("a key from this run's own environment is found in any shape", () => {
    expect(findSecrets("+x = plain-local-key-1\n", ["plain-local-key-1"])).toEqual([
      { what: "a key from your environment", line: 1 },
    ]);
  });

  test("eight characters are enough, also at the very start of the text", () => {
    expect(findSecrets("abcd1234\nabcd1234\n", ["abcd1234"]).map((one) => one.line)).toEqual([1, 2]);
  });

  test("a very short environment value is not searched for, it would match everywhere", () => {
    expect(findSecrets("+const abcdefg = 1;\n", ["abcdefg", ""])).toEqual([]);
  });

  test("ordinary code, placeholders and hashes are not secrets", () => {
    const text = [
      'apiKeyEnv: "MAIN_API_KEY"',
      "OPENAI_API_KEY=your-key-here",
      "sk-...",
      "index 4b1f0d2..9c8e7f6 100644",
      "sha512-R9q1hZ0pVvB2l8yJtX3cQ5wN7mK4dF6gH8jL0zA2sD4f==",
      "const task_live_region = true;",
      "risk-assessment-of-the-whole-plan-and-more",
    ].join("\n");
    expect(findSecrets(text, [])).toEqual([]);
  });

  test("different kinds are in order of line", () => {
    const aws = fake("AK", "IA", "ABCDEFGHIJKLMNOP");
    const slack = fake("xo", "xb-", "123456789012-abcdefGHIJ");
    expect(findSecrets(`${slack}\n\n${aws}`, []).map((one) => one.line)).toEqual([1, 3]);
  });

  test("the same kind on several lines is reported once for each line", () => {
    const value = fake("AK", "IA", "ABCDEFGHIJKLMNOP");
    expect(findSecrets(`${value}\nx\n${value}`, []).map((one) => one.line)).toEqual([1, 3]);
  });
});
