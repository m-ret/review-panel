import { afterEach, describe, expect, test } from "bun:test";
import {
  afterCheck,
  type Behavior,
  type FakeProvider,
  frame,
  refuses,
  reviews,
  says,
  signOff,
  sse,
  startFakeProvider,
  stream,
} from "../demo/fake-provider.ts";
import { type Budget, createBudget } from "../src/budget.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { planPanel, runPanel, type SeatResult } from "../src/panel.ts";

const open: FakeProvider[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((provider) => provider.stop()));
});

const FINDING = "FINDING | major | src/parse.ts:1 | an empty list throws";

/** 50 changed lines of ordinary code: medium risk, so three seats. */
const MEDIUM = [
  "diff --git a/src/parse.ts b/src/parse.ts",
  "--- a/src/parse.ts",
  "+++ b/src/parse.ts",
  "@@ -0,0 +1,50 @@",
  ...Array.from({ length: 50 }, (_, index) => `+line ${index}`),
  "",
].join("\n");

type Member = { behavior: Behavior; lab?: string; price?: { input: number; output: number } };

/** A roster of fake reviewers, all served by one fake provider. */
async function run(
  members: Record<string, Member | Behavior>,
  over: {
    material?: string;
    authorLabs?: string[];
    limits?: object;
    onResult?: (result: SeatResult) => void;
    budget?: (budget: Budget) => Budget;
    spoil?: (config: Config) => void;
  } = {},
) {
  const entries = Object.entries(members).map(([id, member]): [string, Member] => [
    id,
    typeof member === "function" ? { behavior: member } : member,
  ]);
  const provider = startFakeProvider(Object.fromEntries(entries.map(([id, { behavior }]) => [id, behavior])));
  open.push(provider);
  const config = parseConfig(
    JSON.stringify({
      limits: { timeoutSeconds: 1, checkTimeoutSeconds: 1, maxOutputTokens: 1000, ...over.limits },
      providers: { main: { baseUrl: provider.baseUrl } },
      reviewers: entries.map(([id, { lab, price }]) => ({
        id,
        lab: lab ?? `lab-${id}`,
        provider: "main",
        model: id,
        usdPerMillionTokens: price ?? { input: 0, output: 0 },
      })),
    }),
  );
  over.spoil?.(config);
  const plan = planPanel({
    kind: "diff",
    material: over.material ?? MEDIUM,
    authors: { names: ["x"], labs: new Set(over.authorLabs ?? []) },
    askedRisk: null,
  });
  const budget = (over.budget ?? ((one) => one))(createBudget(config.limits.maxUsd));
  const panel = await runPanel(
    plan,
    { config, keys: { main: { state: "not-needed" } }, budget, secrets: [] },
    { onResult: over.onResult },
  );
  const asked = (id: string) => provider.requests.filter((request) => request.model === id && !request.isCheck).length;
  const result = (id: string) => panel.results.find((one) => one.reviewer.id === id);
  return { panel, provider, asked, result, budget };
}

describe("runPanel", () => {
  test("when every seat answers, the panel is complete and has every finding", async () => {
    const { panel, result } = await run({ a: reviews(FINDING), b: reviews(), c: reviews() });
    expect(panel.state).toBe("complete");
    expect(panel.results).toHaveLength(3);
    expect(result("a")?.outcome).toMatchObject({ answered: true, findings: [{ where: "src/parse.ts:1" }] });
    expect(result("b")?.outcome).toMatchObject({ answered: true, findings: [] });
  });

  test("every reviewer gets the same packet, with the whole diff in it", async () => {
    const { provider } = await run({ a: reviews(), b: reviews(), c: reviews() });
    const prompts = new Set(provider.requests.filter((one) => !one.isCheck).map((one) => one.prompt));
    expect(prompts.size).toBe(1);
    expect([...prompts][0]).toContain(MEDIUM);
  });

  const broken: Record<string, Behavior> = {
    empty: afterCheck(() => stream([frame("m", { reasoning_content: "hm" }), frame("m", {}, "stop"), sse("[DONE]")])),
    truncated: afterCheck((request) =>
      stream([frame("m", { content: `${FINDING}\n${signOff(request, 1)}` }, "length"), sse("[DONE]")]),
    ),
    "rate-limited": afterCheck(refuses(429, { error: { message: "slow down" } })),
    "out-of-credit": afterCheck(refuses(402, { error: { message: "no money" } })),
    "provider-error": afterCheck(refuses(503, "unavailable")),
    filtered: afterCheck(() => stream([frame("m", { content: "no" }, "content_filter"), sse("[DONE]")])),
    unsigned: afterCheck(says("Looks good to me, ship it!")),
    inconsistent: afterCheck(says((request) => `${FINDING}\n${signOff(request, 0)}`)),
    timeout: afterCheck(() => stream([frame("m", { content: "half" }), 3000])),
  };

  for (const [reason, behavior] of Object.entries(broken)) {
    test(`${reason}: the seat did not answer, the panel is not complete, and the others still count`, async () => {
      const { panel, result } = await run({ a: reviews(FINDING), b: behavior, c: reviews() });
      expect(result("b")?.outcome).toMatchObject({ answered: false, reason });
      expect(panel.state).toBe("incomplete");
      expect(result("a")?.outcome.answered).toBe(true);
      expect(result("c")?.outcome.answered).toBe(true);
    });
  }

  test("the author is never asked anything, not even its check", async () => {
    const { provider, panel } = await run(
      { a: reviews(), b: reviews(), c: reviews(), d: reviews() },
      { authorLabs: ["lab-a"] },
    );
    expect(provider.requests.filter((request) => request.model === "a")).toEqual([]);
    expect(panel.seats.map((seat) => seat.id)).toEqual(["b", "c", "d"]);
  });

  test("a reviewer that fails its check never sees the diff, and another takes its seat", async () => {
    const { panel, asked } = await run({
      a: refuses(404, { error: { message: "gone" } }),
      b: reviews(),
      c: reviews(),
      d: reviews(),
    });
    expect(asked("a")).toBe(0);
    expect(panel.seats.map((seat) => seat.id)).toEqual(["b", "c", "d"]);
    expect(panel.state).toBe("complete");
    expect(panel.bench).toMatchObject([{ reason: "check-failed", detail: "model-not-found: HTTP 404: gone" }]);
  });

  test("every check comes before any review", async () => {
    const { provider } = await run({ a: reviews(), b: reviews(), c: reviews(), d: reviews() });
    expect(provider.requests.map((request) => request.isCheck)).toEqual([
      true, true, true, true, false, false, false,
    ]);
  });

  test("a panel with fewer seats than the risk asks for is not complete, even if everyone answered", async () => {
    const { panel } = await run({ a: reviews(), b: reviews() });
    expect(panel).toMatchObject({ wanted: 3, state: "incomplete" });
    expect(panel.results.every((result) => result.outcome.answered)).toBe(true);
  });

  test("one reviewer is not a panel: nothing is sent to it", async () => {
    const gone = refuses(404, { error: { message: "gone" } });
    const { panel, provider } = await run({ a: reviews(), b: gone, c: gone });
    expect(panel.state).toBe("not-started");
    expect(panel.spent).toBe(0);
    expect(panel.results).toEqual([]);
    expect(provider.requests.filter((request) => !request.isCheck)).toEqual([]);
    expect(panel.bench.map((one) => [one.reviewer.id, one.reason])).toEqual([
      ["a", "not-needed"],
      ["b", "check-failed"],
      ["c", "check-failed"],
    ]);
  });

  test("reviewers work at the same time", async () => {
    const slow = afterCheck(async (request) => {
      await Bun.sleep(400);
      return reviews()(request);
    });
    const started = performance.now();
    const { panel } = await run({ a: slow, b: slow, c: slow });
    expect(panel.state).toBe("complete");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("each result is handed over as soon as it is there, not at the end", async () => {
    const order: string[] = [];
    const after = (ms: number) =>
      afterCheck(async (request) => {
        await Bun.sleep(ms);
        return reviews()(request);
      });
    await run({ a: after(300), b: after(10), c: after(150) }, { onResult: (result) => order.push(result.reviewer.id) });
    expect(order).toEqual(["b", "c", "a"]);
  });

  test("the cost of the checks and the answers is added up", async () => {
    const price = { input: 1, output: 10 };
    const { panel, result } = await run(
      { a: { behavior: reviews(), price }, b: reviews(), c: reviews() },
      { limits: { maxUsd: 1 } },
    );
    // Check: 20 in, 2 out. Review: 1000 in, 200 out.
    expect(panel.spent).toBe(20 + 2 * 10 + 1000 + 200 * 10);
    expect(result("a")).toMatchObject({ cost: 3000, isWorstCase: false });
  });

  test("a reviewer whose worst case does not fit is not called, and the cap holds", async () => {
    const price = { input: 0, output: 100 }; // an answer may cost up to 100,000
    const { panel, asked } = await run(
      { a: { behavior: reviews(), price }, b: { behavior: reviews(), price }, c: reviews(), d: reviews() },
      { limits: { maxUsd: 0.15 } },
    );
    expect(asked("a")).toBe(1);
    expect(asked("b")).toBe(0);
    expect(panel.bench).toMatchObject([{ reviewer: { id: "b" }, reason: "over-budget" }]);
    expect(panel.seats.map((seat) => seat.id)).toEqual(["a", "c", "d"]);
    expect(panel.isOverCap).toBe(false);
  });

  test("a reply without usage is charged its worst case, and says so", async () => {
    const noUsage = afterCheck((request) => stream([frame("a", { content: signOff(request, 0) }, "stop"), sse("[DONE]")]));
    const price = { input: 0, output: 100 };
    const { result } = await run({ a: { behavior: noUsage, price }, b: reviews(), c: reviews() }, { limits: { maxUsd: 1 } });
    expect(result("a")).toMatchObject({ cost: 100_000, isWorstCase: true });
  });

  test("a provider that charges more than its worst case is reported", async () => {
    const greedy = afterCheck(says((request) => signOff(request, 0), { input: 1000, output: 900_000 }));
    const { panel } = await run(
      { a: { behavior: greedy, price: { input: 0, output: 1 } }, b: reviews(), c: reviews() },
      { limits: { maxUsd: 0.01 } },
    );
    expect(panel.isOverCap).toBe(true);
  });

  test("a bug of ours in one seat is a seat that did not answer, and the others still count", async () => {
    const { panel, result } = await run(
      { a: reviews(), b: reviews(), c: reviews() },
      {
        budget: (real) => ({
          ...real,
          settle(id, micros) {
            if (id === "b") throw new Error("boom");
            real.settle(id, micros);
          },
        }),
      },
    );
    expect(result("b")?.outcome).toEqual({ answered: false, reason: "internal-error", detail: "boom" });
    expect(result("b")?.isWorstCase).toBe(true);
    expect(result("a")?.outcome.answered).toBe(true);
    expect(panel.state).toBe("incomplete");
  });

  test("when a run ends, no money is still set aside, whatever happened in it", async () => {
    const price = { input: 1, output: 1 };
    const paid = (behavior: Behavior) => ({ behavior, price });
    const { panel, budget } = await run(
      { a: paid(reviews()), b: paid(afterCheck(refuses(500, "down"))), c: paid(reviews()), d: paid(reviews()), e: paid(reviews()) },
      {
        limits: { maxUsd: 1 },
        spoil: (config) => {
          config.reviewers[3]!.provider = "gone"; // our own mistake: its check cannot even be sent
        },
      },
    );
    expect(panel.bench).toMatchObject([{ reason: "check-failed", detail: expect.stringContaining("internal-error") }, {}]);
    expect(budget.left()).toBe(1_000_000 - budget.spent());
    // Four checks of 22, two reviews of 1200. The refused review and the check that was never sent cost nothing.
    expect(budget.spent()).toBe(4 * 22 + 2 * 1200);
  });

  test("a bug of ours in one check leaves that reviewer out, and the panel goes on", async () => {
    const { panel } = await run(
      { a: reviews(), b: reviews(), c: reviews(), d: reviews() },
      {
        budget: (real) => ({
          ...real,
          settle(id, micros) {
            if (id === "check b") throw new Error("boom");
            real.settle(id, micros);
          },
        }),
      },
    );
    expect(panel.seats.map((seat) => seat.id)).toEqual(["a", "c", "d"]);
    expect(panel.bench).toMatchObject([{ reason: "check-failed", detail: "internal-error: boom" }]);
  });

  test("two reviewers from one lab never sit together", async () => {
    const { panel } = await run({
      a: { behavior: reviews(), lab: "same" },
      b: { behavior: reviews(), lab: "same" },
      c: reviews(),
      d: reviews(),
    });
    expect(panel.seats.map((seat) => seat.id)).toEqual(["a", "c", "d"]);
  });
});
