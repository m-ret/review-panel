import { describe, expect, test } from "bun:test";
import type { Evidence } from "../src/call.ts";
import type { Reviewer } from "../src/config.ts";
import type { Outcome } from "../src/outcome.ts";
import type { Panel, Plan, SeatResult } from "../src/panel.ts";
import { reviewerMarkdown, summaryJson, summaryMarkdown, type Run } from "../src/report.ts";

const reviewer = (id: string): Reviewer => ({
  id,
  lab: `lab-${id}`,
  provider: "main",
  model: `vendor/${id}`,
  goodAt: [],
  usdPerMillionTokens: { input: 0, output: 0 },
});

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  ms: 41_800,
  status: 200,
  end: "closed",
  refusal: null,
  retryAfter: null,
  text: "I read it all.\nSIGN-OFF 7f3a9c-91bc04 | 0",
  reasoningChars: 0,
  finishReason: "stop",
  done: true,
  usage: { inputTokens: 3120, outputTokens: 840 },
  frames: 5,
  badFrames: 0,
  ...over,
});

const seat = (id: string, outcome: Outcome, over: Partial<SeatResult> = {}): SeatResult => ({
  reviewer: reviewer(id),
  outcome,
  evidence: evidence(),
  cost: 4000,
  isWorstCase: false,
  ...over,
});

const clean: Outcome = { answered: true, findings: [], recommendation: null };
const found = (...findings: [("blocker" | "major" | "minor"), string, string][]): Outcome => ({
  answered: true,
  recommendation: null,
  findings: findings.map(([severity, where, what]) => ({ severity, where, what })),
});
const missing: Outcome = { answered: false, reason: "rate-limited", detail: "HTTP 429: slow down" };

const plan = (over: Partial<Plan> = {}): Plan => ({
  kind: "diff",
  authors: { names: ["claude"], labs: new Set(["anthropic"]) },
  diff: {
    files: [{ path: "src/pay.ts", oldPath: "src/pay.ts", added: 41, removed: 3, addedText: "" }],
    problem: null,
  },
  classification: { areas: ["payments", "code"], risk: "medium", reasons: ["src/pay.ts touches payments (pay)"] },
  codes: { first: "7f3a9c", second: "91bc04", marker: "c0ffee12" },
  prompt: "the prompt",
  ...over,
});

function run(results: SeatResult[], over: Partial<Panel> = {}, planOver: Partial<Plan> = {}): Run {
  const wanted = over.wanted ?? results.length;
  const isComplete = results.length === wanted && results.every((one) => one.outcome.answered);
  return {
    source: "git diff main...HEAD",
    startedAt: new Date("2026-11-24T14:03:11.000Z"),
    maxUsd: 0.5,
    plan: plan(planOver),
    panel: {
      state: isComplete ? "complete" : "incomplete",
      wanted,
      seats: results.map((one) => one.reviewer),
      bench: [],
      results,
      spent: 12_345,
      isOverCap: false,
      ...over,
    },
  };
}

const complete = run([seat("a", clean), seat("b", clean), seat("c", clean)]);
const incomplete = run([seat("a", clean), seat("b", missing), seat("c", clean)]);

describe("summaryMarkdown", () => {
  test("a missing answer is in the first lines, not at the bottom", () => {
    const top = summaryMarkdown(incomplete).split("\n").slice(0, 4).join("\n");
    expect(top).toContain("2 of 3");
    expect(top).toContain("not complete");
    expect(top).toContain("A missing answer is not agreement");
  });

  test("a short panel says how many seats are missing, even if everyone who sat answered", () => {
    const text = summaryMarkdown(run([seat("a", clean), seat("b", clean)], { wanted: 4 }));
    expect(text.split("\n").slice(0, 4).join("\n")).toContain("2 of 4");
    expect(text).toContain("asks for 4 reviewers and only 2 could sit");
    expect(text).toContain("not complete");
  });

  test("a complete panel never reads as approval", () => {
    const text = summaryMarkdown(complete);
    expect(text).toContain("3 of 3");
    expect(text).not.toContain("not complete");
    expect(text).not.toMatch(/approved|passed|lgtm|ship it/iu);
  });

  test("the decision is always open: both boxes are there and none is ticked", () => {
    const started = [complete, incomplete, run([], { state: "not-started", wanted: 3 })];
    for (const one of started) {
      const text = summaryMarkdown(one);
      expect(text).toContain("- [ ] GO\n- [ ] NO-GO");
      expect(text).not.toContain("[x]");
    }
  });

  test("a panel that did not start says that nothing was reviewed", () => {
    const text = summaryMarkdown(run([], { state: "not-started", wanted: 3 }));
    expect(text.split("\n")[0]).toContain("did not start");
    expect(text).toContain("Nothing was sent for review");
  });

  test("every reviewer has a row with its file, and one that did not answer says why", () => {
    const text = summaryMarkdown(incomplete);
    expect(text).toContain("[a](a.md)");
    expect(text).toMatch(/\[b\]\(b\.md\).*did not answer.*rate-limited.*HTTP 429: slow down/u);
  });

  test("findings from all reviewers are in one list, worst first", () => {
    const text = summaryMarkdown(
      run([
        seat("a", found(["minor", "z.ts:9", "small thing"], ["major", "b.ts:2", "big thing"])),
        seat("b", found(["blocker", "a.ts:1", "worst thing"])),
        seat("c", clean),
      ]),
    );
    const order = ["worst thing", "big thing", "small thing"].map((what) => text.indexOf(what));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(order[0]).toBeGreaterThan(0);
  });

  test("text from a model stays text: no table rows, images or HTML of its own", () => {
    const text = summaryMarkdown(
      run([seat("a", found(["major", "x|y.ts:1", "a | b\n| c | ![p](http://e/p.png) <img src=x>"])), seat("b", clean)]),
    );
    expect(text).not.toContain("![p](");
    expect(text).not.toMatch(/(?<!\\)<img/u);
    const row = text.split("\n").find((line) => line.includes("http://e/p.png")) ?? "";
    expect(row.match(/(?<!\\)\|/gu)).toHaveLength(5);
  });

  test("a path from the diff cannot render either, whatever character it starts with", () => {
    const reasons = ["\u0000![p](http://e/p.png) touches payments (pay)"];
    const text = summaryMarkdown(
      run([seat("a", clean), seat("b", clean)], {}, { classification: { areas: ["code"], risk: "high", reasons } }),
    );
    expect(text).not.toContain("![p](");
  });

  test("an answer with no findings shows what the reviewer said it checked", () => {
    const text = summaryMarkdown(
      run([
        seat("a", clean, { evidence: evidence({ text: "I checked src/pay.ts for double refunds.\nSIGN-OFF x | 0" }) }),
        seat("b", clean),
      ]),
    );
    expect(text).toContain("I checked src/pay.ts for double refunds.");
  });

  test("whoever did not sit is listed with the reason", () => {
    const text = summaryMarkdown(
      run([seat("a", clean), seat("b", clean)], {
        bench: [
          { reviewer: reviewer("opus"), reason: "author", detail: "anthropic wrote the work" },
          { reviewer: reviewer("gemma"), reason: "check-failed", detail: "model-not-found: HTTP 404: gone" },
        ],
      }),
    );
    expect(text).toMatch(/opus.*anthropic wrote the work/u);
    expect(text).toMatch(/gemma.*model-not-found: HTTP 404: gone/u);
  });

  test("says who wrote the work, and that nobody was left out when a person did", () => {
    expect(summaryMarkdown(complete)).toMatch(/claude.*anthropic/u);
    const human = run([seat("a", clean), seat("b", clean)], {}, { authors: { names: ["human"], labs: new Set() } });
    expect(summaryMarkdown(human)).toMatch(/human.*no lab sits out/u);
  });

  test("shows the risk with its reasons, and the cost against the cap", () => {
    const text = summaryMarkdown(complete);
    expect(text).toContain("- **Risk:** medium");
    expect(text).toContain("src/pay.ts touches payments (pay)");
    expect(text).toContain("$0.012345 of $0.50");
  });

  test("going over the cap is said out loud", () => {
    expect(summaryMarkdown(run([seat("a", clean), seat("b", clean)], { isOverCap: true }))).toContain("over the cap");
    expect(summaryMarkdown(complete)).not.toContain("over the cap");
  });

  test("a cost that is only the worst case is marked", () => {
    const text = summaryMarkdown(run([seat("a", clean, { isWorstCase: true }), seat("b", clean)]));
    expect(text).toMatch(/\[a\]\(a\.md\).*at most \$0\.004/u);
  });

  test("a diff that could not be read all the way is said out loud", () => {
    const text = summaryMarkdown(
      run([seat("a", clean), seat("b", clean)], {}, { diff: { files: [], problem: "the diff stops in the middle of a hunk" } }),
    );
    expect(text).toContain("the diff stops in the middle of a hunk");
  });

  test("a question lists recommendations instead of findings", () => {
    const answer = (recommendation: string): Outcome => ({ answered: true, findings: [], recommendation });
    const text = summaryMarkdown(
      run([seat("a", answer("Use a queue.")), seat("b", answer("Use cron."))], {}, { kind: "question", diff: null }),
    );
    expect(text).toContain("Use a queue.");
    expect(text).toContain("Use cron.");
    expect(text).not.toContain("Findings");
  });
});

describe("summaryJson", () => {
  test("says the same things for a program, and never holds a decision", () => {
    const json = summaryJson(incomplete);
    expect(json).toMatchObject({
      state: "incomplete",
      wanted: 3,
      seated: 3,
      answered: 2,
      decision: null,
      authors: ["claude"],
      leftOutLabs: ["anthropic"],
      risk: "medium",
      spend: { spentUsd: 0.012345, capUsd: 0.5, isOverCap: false },
    });
  });

  test("gives each reviewer its outcome", () => {
    expect(summaryJson(incomplete)).toMatchObject({
      reviewers: [
        { id: "a", answered: true, findings: [], file: "a.md" },
        { id: "b", answered: false, reason: "rate-limited", detail: "HTTP 429: slow down", file: "b.md" },
        { id: "c", answered: true },
      ],
    });
  });

  test("survives being written and read back", () => {
    expect(JSON.parse(JSON.stringify(summaryJson(complete)))).toMatchObject({ state: "complete", leftOutLabs: ["anthropic"] });
  });
});

describe("reviewerMarkdown", () => {
  test("keeps the answer exactly, in a block that nothing inside can close", () => {
    const text = "```ts\nconst a = 1;\n```\n# not a heading\nSIGN-OFF 7f3a9c-91bc04 | 0";
    const file = reviewerMarkdown(seat("a", clean, { evidence: evidence({ text }) }));
    expect(file).toContain(`\n\`\`\`\`text\n${text}\n\`\`\`\`\n`);
  });

  test("the title says whether it answered", () => {
    expect(reviewerMarkdown(seat("a", clean)).split("\n")[0]).toBe("# a: no findings");
    expect(reviewerMarkdown(seat("a", found(["major", "x", "y"]))).split("\n")[0]).toBe("# a: 1 finding");
    expect(reviewerMarkdown(seat("a", missing)).split("\n")[0]).toBe("# a: did not answer (rate-limited)");
  });

  test("text that arrived from a reviewer that did not answer is kept, and marked as not counted", () => {
    const cut: Outcome = { answered: false, reason: "truncated", detail: "stopped at the token limit" };
    const file = reviewerMarkdown(seat("a", cut, { evidence: evidence({ text: "half of a rev" }) }));
    expect(file).toContain("stopped at the token limit");
    expect(file).toContain("not counted");
    expect(file).toContain("half of a rev");
  });

  test("a reviewer with no text says so", () => {
    const file = reviewerMarkdown(seat("a", missing, { evidence: evidence({ text: "" }) }));
    expect(file).toContain("No text arrived");
  });

  test("a seat lost to a bug of ours still gets a file", () => {
    const lost: Outcome = { answered: false, reason: "internal-error", detail: "boom" };
    expect(reviewerMarkdown(seat("a", lost, { evidence: null }))).toContain("boom");
  });

  test("shows the model, the time, the tokens and the cost", () => {
    const file = reviewerMarkdown(seat("a", clean));
    for (const piece of ["vendor/a", "42 s", "3120", "840", "$0.004"]) expect(file).toContain(piece);
  });
});
