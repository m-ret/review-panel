import { describe, expect, test } from "bun:test";
import { classifyDiff, classifyQuestion, raiseRisk } from "../src/classify.ts";
import type { ChangedFile, ParsedDiff } from "../src/diff.ts";

function diffOf(...files: (Partial<ChangedFile> & { path: string })[]): ParsedDiff {
  return {
    files: files.map((file) => ({ oldPath: file.path, added: 50, removed: 10, addedText: "", ...file })),
    problem: null,
  };
}
const risk = (...files: Parameters<typeof diffOf>) => classifyDiff(diffOf(...files)).risk;
const areas = (...files: Parameters<typeof diffOf>) => classifyDiff(diffOf(...files)).areas;

describe("classifyDiff: what the change touches", () => {
  test("sensitive paths are named by area, most sensitive first", () => {
    expect(
      areas({ path: "db/migrations/001.sql" }, { path: "src/auth/login.ts" }, { path: "src/billing/refund.ts" }),
    ).toEqual(["security", "payments", "data", "code"]);
  });

  test("words are matched whole, so author.ts is not about auth", () => {
    expect(areas({ path: "src/author.ts" })).toEqual(["code"]);
    expect(areas({ path: "src/blog/authors-list.ts" })).toEqual(["code"]);
  });

  test("words inside camelCase names are found", () => {
    expect(areas({ path: "src/lib/OAuthClient.ts" })).toEqual(["security", "code"]);
    expect(areas({ path: "src/lib/processRefund.ts" })).toEqual(["payments", "code"]);
  });

  test("the file type decides when no word does", () => {
    expect(areas({ path: "src/Button.tsx" })).toEqual(["frontend"]);
    expect(areas({ path: "src/parse.ts" })).toEqual(["code"]);
    expect(areas({ path: "queries/report.sql" })).toEqual(["data"]);
    expect(areas({ path: "Dockerfile" })).toEqual(["infra"]);
    expect(areas({ path: ".github/workflows/ci.yml" })).toEqual(["infra"]);
    expect(areas({ path: "README.md" })).toEqual(["docs"]);
  });

  test("a test about auth is a test", () => {
    expect(areas({ path: "tests/auth/login.test.ts" })).toEqual(["tests"]);
    expect(areas({ path: "src/auth/__tests__/login.ts" })).toEqual(["tests"]);
  });

  test("a folder of API specs is not a test folder", () => {
    expect(areas({ path: "openapi/spec/payments.yaml" })).toEqual(["payments", "code"]);
  });

  test("the usual test file names are recognised", () => {
    for (const path of ["src/a.test.ts", "src/a.spec.tsx", "pkg/a_test.go", "test_a.py", "spec/a_spec.rb", "e2e/a.ts"]) {
      expect(areas({ path })).toEqual(["tests"]);
    }
  });

  test("a helper whose name merely contains the word test is code", () => {
    expect(areas({ path: "src/testUtils.ts" })).toEqual(["code"]);
    expect(areas({ path: "src/latest.ts" })).toEqual(["code"]);
  });

  test("moving sensitive code into a test folder is still sensitive", () => {
    expect(areas({ path: "tests/old.ts", oldPath: "src/auth/session.ts" })).toEqual(["security", "code", "tests"]);
    expect(risk({ path: "tests/old.ts", oldPath: "src/auth/session.ts", added: 0, removed: 0 })).toBe("high");
  });

  test("a file moved out of a sensitive folder still counts as sensitive", () => {
    expect(areas({ path: "lib/helpers.ts", oldPath: "src/auth/session.ts" })).toEqual(["security", "code"]);
  });
});

describe("classifyDiff: risk", () => {
  test("every sensitive area is high risk", () => {
    expect(risk({ path: "src/auth/login.ts", added: 1, removed: 0 })).toBe("high");
    expect(risk({ path: "src/payments/charge.ts", added: 1, removed: 0 })).toBe("high");
    expect(risk({ path: "prisma/schema.prisma", added: 1, removed: 0 })).toBe("high");
    expect(risk({ path: ".github/workflows/ci.yml", added: 1, removed: 0 })).toBe("high");
    expect(risk({ path: ".env.example", added: 1, removed: 0 })).toBe("high");
  });

  test("ordinary code is medium", () => {
    expect(risk({ path: "src/parse.ts", added: 41, removed: 0 })).toBe("medium");
    expect(risk({ path: "src/Button.tsx", added: 700, removed: 100 })).toBe("medium");
  });

  test("a small change is low, and the limit counts added plus removed lines", () => {
    expect(risk({ path: "src/parse.ts", added: 20, removed: 20 })).toBe("low");
    expect(risk({ path: "src/parse.ts", added: 21, removed: 20 })).toBe("medium");
  });

  test("a very large change is high, because reviewers miss more in it", () => {
    expect(risk({ path: "src/parse.ts", added: 401, removed: 400 })).toBe("high");
  });

  test("docs and tests alone are low at any size", () => {
    expect(risk({ path: "README.md", added: 5000 }, { path: "tests/a.test.ts", added: 5000 })).toBe("low");
  });

  test("one code file among docs is not docs alone", () => {
    expect(risk({ path: "README.md" }, { path: "src/parse.ts" })).toBe("medium");
  });

  test("a lock file does not make a change large", () => {
    expect(risk({ path: "bun.lock", added: 9000, removed: 3000 }, { path: "src/parse.ts", added: 5, removed: 0 })).toBe(
      "low",
    );
  });

  test("added code that destroys data is high wherever it is", () => {
    for (const addedText of [
      "await db.execute('DROP TABLE users')",
      "alter table users drop column email",
      "truncate table events",
      'DELETE FROM "bookings";',
      "rm -rf $TARGET",
      "git push --force origin main",
    ]) {
      expect(risk({ path: "src/parse.ts", added: 1, removed: 0, addedText })).toBe("high");
    }
  });

  test("words that only look destructive are not", () => {
    for (const addedText of ['<p className="truncate text-sm">', "DELETE FROM bookings WHERE id = $1;", "a drop of water"]) {
      expect(risk({ path: "src/parse.ts", added: 1, removed: 0, addedText })).toBe("low");
    }
  });

  test("a README that mentions DROP TABLE stays low", () => {
    expect(risk({ path: "README.md", added: 1, removed: 0, addedText: "Never run DROP TABLE." })).toBe("low");
  });

  test("a diff that could not be read is high, because nobody knows what it holds", () => {
    const result = classifyDiff({ files: [], problem: "no changed file found" });
    expect(result.risk).toBe("high");
    expect(result.reasons.join()).toContain("no changed file found");
  });

  test("the reasons name the file and the words that decided", () => {
    const { reasons } = classifyDiff(diffOf({ path: "src/auth/loginForm.ts" }));
    expect(reasons).toEqual(["src/auth/loginForm.ts touches security (auth, login)"]);
  });
});

describe("classifyQuestion", () => {
  test("a question is design work of medium risk", () => {
    expect(classifyQuestion("Should the list use cursor or offset pagination?")).toEqual({
      areas: ["design"],
      risk: "medium",
      reasons: ["a question with no sensitive words"],
    });
  });

  test("a question about something sensitive is high risk and says which words decided", () => {
    const result = classifyQuestion("How should we run the migration that moves refunds?");
    expect(result.areas).toEqual(["payments", "data", "design"]);
    expect(result.risk).toBe("high");
    expect(result.reasons).toEqual(["the question mentions payments (refunds), data (migration)"]);
  });

  test("words that only mean something in a file path do not raise a question", () => {
    expect(classifyQuestion("What role does the token limit play in this session?").risk).toBe("medium");
  });

  test("a question about destroying data is high risk", () => {
    expect(classifyQuestion("Is it fine to drop column email now?").risk).toBe("high");
  });
});

describe("raiseRisk", () => {
  const medium = { areas: ["code" as const], risk: "medium" as const, reasons: ["r"] };

  test("a person can raise the risk", () => {
    expect(raiseRisk(medium, "high")).toMatchObject({ risk: "high", reasons: ["r", "raised from medium to high by --risk"] });
  });

  test("a person cannot lower it, and the summary says so", () => {
    expect(raiseRisk(medium, "low")).toMatchObject({
      risk: "medium",
      reasons: ["r", "--risk low ignored: it can only raise the risk"],
    });
  });

  test("without --risk nothing changes", () => {
    expect(raiseRisk(medium, null)).toEqual(medium);
  });
});
