import { afterEach, describe, expect, test } from "bun:test";
import {
  type Behavior,
  type FakeProvider,
  frame,
  refuses,
  says,
  sse,
  startFakeProvider,
  stream,
  usageFrame,
} from "../demo/fake-provider.ts";
import { createBudget } from "../src/budget.ts";
import { checkReviewer } from "../src/check.ts";
import { type Key, parseConfig } from "../src/config.ts";

const open: FakeProvider[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((provider) => provider.stop()));
});

async function check(
  behavior: Behavior,
  over: { key?: string | null; maxUsd?: number; price?: { input: number; output: number } } = {},
) {
  const provider = startFakeProvider({ m: behavior });
  open.push(provider);
  const reviewer = {
    id: "alpha",
    lab: "lab-a",
    provider: "main",
    model: "m",
    usdPerMillionTokens: over.price ?? { input: 0, output: 0 },
  };
  const config = parseConfig(
    JSON.stringify({
      limits: { checkTimeoutSeconds: 1 },
      labs: { "lab-a": [], "lab-b": [] },
      providers: { main: { baseUrl: provider.baseUrl, apiKeyEnv: "MAIN_API_KEY" } },
      reviewers: [reviewer, { ...reviewer, id: "beta", lab: "lab-b", model: "other" }],
    }),
  );
  const budget = createBudget(over.maxUsd ?? 1);
  const key = over.key === undefined ? "k-test" : over.key;
  const state: Key =
    key === null
      ? { state: "missing", variable: "MAIN_API_KEY" }
      : key === "not-needed"
        ? { state: "not-needed" }
        : { state: "present", key };
  const { failure, settle } = await checkReviewer(config.reviewers[0]!, {
    config,
    keys: { main: state },
    budget,
    secrets: key === null ? [] : [key],
  });
  const heldWhileRunning = 1_000_000 * (over.maxUsd ?? 1) - budget.left();
  settle();
  return { failure, provider, budget, heldWhileRunning };
}

describe("checkReviewer", () => {
  test("a model that answers passes", async () => {
    expect((await check(says("ready"))).failure).toBeNull();
  });

  test("the request is tiny and holds none of the work under review", async () => {
    const { provider } = await check(says("ready"));
    const { body, prompt } = provider.requests[0]!;
    expect(body["max_tokens"]).toBe(16);
    expect(prompt.length).toBeLessThan(60);
  });

  test("the key of its provider goes with it, and a provider that needs none gets none", async () => {
    const { provider } = await check(says("ready"));
    expect(provider.requests[0]!.headers.get("authorization")).toBe("Bearer k-test");
    const open = await check(says("ready"), { key: "not-needed" });
    expect(open.provider.requests[0]!.headers.get("authorization")).toBeNull();
  });

  test("a reasoning model that spends all sixteen tokens thinking passes: the key, the model and the address work", async () => {
    const { failure } = await check(() =>
      stream([
        frame("m", { role: "assistant", reasoning_content: "The user wants" }),
        frame("m", { reasoning_content: " one word" }, "length"),
        usageFrame("m", 17, 16),
        sse("[DONE]"),
      ]),
    );
    expect(failure).toBeNull();
  });

  test("a model the provider lists but does not serve fails its check", async () => {
    const { failure } = await check(refuses(404, { status: 404, title: "Not Found", detail: "No such function" }));
    expect(failure).toEqual({ reason: "model-not-found", detail: "HTTP 404: No such function" });
  });

  test("an empty account, a refused key and a rate limit fail it, each under its own name", async () => {
    expect((await check(refuses(402, { error: { message: "Pay first" } }))).failure?.reason).toBe("out-of-credit");
    expect((await check(refuses(401, { error: { message: "Bad key" } }))).failure?.reason).toBe("no-access");
    expect((await check(refuses(429, { error: { message: "Slow down" } }))).failure?.reason).toBe("rate-limited");
  });

  test("a page that is not a completion fails it, even with status 200", async () => {
    const { failure } = await check(() => new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }));
    expect(failure?.reason).toBe("provider-error");
  });

  test("silence fails it at the check's own time limit", async () => {
    const { failure } = await check(async () => {
      await Bun.sleep(3000);
      return new Response("late");
    });
    expect(failure).toEqual({ reason: "timeout", detail: "no complete reply after 1 s" });
  });

  test("a missing key fails it without any request, and names the variable", async () => {
    const { failure, provider } = await check(says("ready"), { key: null });
    expect(failure?.reason).toBe("no-key");
    expect(failure?.detail).toContain("MAIN_API_KEY");
    expect(provider.requests).toHaveLength(0);
  });

  test("a check that does not fit under the cap is not sent", async () => {
    const { failure, provider } = await check(says("ready"), { maxUsd: 0, price: { input: 1, output: 1 } });
    expect(failure?.reason).toBe("over-budget");
    expect(provider.requests).toHaveLength(0);
  });

  test("what the check cost is counted", async () => {
    const { budget } = await check(says("ready"), { price: { input: 10, output: 100 } });
    expect(budget.spent()).toBe(20 * 10 + 2 * 100);
  });

  test("until it is settled, its worst case stays set aside, so a reported cost cannot change who sits", async () => {
    const { heldWhileRunning } = await check(says("ready"), { price: { input: 10, output: 100 } });
    expect(heldWhileRunning).toBe((26 + 500) * 10 + 16 * 100);
  });

  test("a refused check costs nothing", async () => {
    const { budget } = await check(refuses(402, {}), { price: { input: 10, output: 100 } });
    expect(budget.spent()).toBe(0);
  });
});
