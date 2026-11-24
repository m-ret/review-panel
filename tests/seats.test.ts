import { describe, expect, test } from "bun:test";
import type { Reviewer } from "../src/config.ts";
import type { Failure } from "../src/outcome.ts";
import { chooseSeats } from "../src/seats.ts";
import type { Area } from "../src/types.ts";

const reviewer = (id: string, lab: string, goodAt: Area[] = []): Reviewer => ({
  id,
  lab,
  provider: "main",
  model: `vendor/${id}`,
  goodAt,
  usdPerMillionTokens: { input: 0, output: 0 },
});

const roster = [
  reviewer("alpha", "lab-a", ["code"]),
  reviewer("beta", "lab-b", ["security"]),
  reviewer("gamma", "lab-c", ["security", "payments"]),
  reviewer("delta", "lab-d"),
  reviewer("epsilon", "lab-e", ["docs"]),
];

function choose(over: Partial<Parameters<typeof chooseSeats>[0]> = {}) {
  const result = chooseSeats({
    reviewers: roster,
    authorLabs: new Set(),
    areas: ["code"],
    risk: "medium",
    failedChecks: new Map(),
    reserve: () => true,
    ...over,
  });
  return {
    ...result,
    ids: result.seats.map((seat) => seat.id),
    why: Object.fromEntries(result.bench.map((one) => [one.reviewer.id, one.reason])),
  };
}

const outOfCredit: Failure = { reason: "out-of-credit", detail: "HTTP 402" };

describe("chooseSeats", () => {
  test("low risk seats two, medium three, high four", () => {
    expect(choose({ risk: "low" }).ids).toHaveLength(2);
    expect(choose({ risk: "medium" }).ids).toHaveLength(3);
    expect(choose({ risk: "high" }).ids).toHaveLength(4);
  });

  test("the best match for the work goes first, and the order of the config breaks ties", () => {
    expect(choose({ areas: ["security", "payments"] }).ids).toEqual(["gamma", "beta", "alpha"]);
    expect(choose({ areas: ["design"] }).ids).toEqual(["alpha", "beta", "gamma"]);
  });

  test("the author never sits, however good a match it is", () => {
    const result = choose({ areas: ["security", "payments"], authorLabs: new Set(["lab-c"]) });
    expect(result.ids).toEqual(["beta", "alpha", "delta"]);
    expect(result.why["gamma"]).toBe("author");
  });

  test("another model from the author's lab does not sit either", () => {
    const reviewers = [reviewer("alpha", "lab-a"), reviewer("alpha-mini", "lab-a"), ...roster.slice(1)];
    expect(choose({ reviewers, authorLabs: new Set(["lab-a"]) }).ids).toEqual(["beta", "gamma", "delta"]);
  });

  test("a lab gets one seat, so three seats are three labs", () => {
    const reviewers = [reviewer("alpha", "lab-a"), reviewer("alpha-mini", "lab-a"), ...roster.slice(1)];
    const result = choose({ reviewers });
    expect(result.ids).toEqual(["alpha", "beta", "gamma"]);
    expect(result.why["alpha-mini"]).toBe("same-lab");
  });

  test("a reviewer whose check failed does not sit, the next one does, and the reason is kept", () => {
    const result = choose({ failedChecks: new Map([["alpha", outOfCredit]]) });
    expect(result.ids).toEqual(["beta", "gamma", "delta"]);
    expect(result.bench.find((one) => one.reviewer.id === "alpha")).toMatchObject({
      reason: "check-failed",
      detail: "out-of-credit: HTTP 402",
    });
  });

  test("when the first of a lab fails its check, another model of that lab may take the seat", () => {
    const reviewers = [reviewer("alpha", "lab-a"), reviewer("alpha-mini", "lab-a"), ...roster.slice(1)];
    expect(choose({ reviewers, failedChecks: new Map([["alpha", outOfCredit]]) }).ids).toEqual([
      "alpha-mini",
      "beta",
      "gamma",
    ]);
  });

  test("a reviewer that does not fit under the spend cap does not sit, and a cheaper one may", () => {
    const result = choose({ reserve: (one) => one.id !== "alpha" });
    expect(result.ids).toEqual(["beta", "gamma", "delta"]);
    expect(result.why["alpha"]).toBe("over-budget");
  });

  test("money is only set aside for reviewers that would otherwise sit", () => {
    const asked: string[] = [];
    choose({
      risk: "low",
      authorLabs: new Set(["lab-a"]),
      failedChecks: new Map([["beta", outOfCredit]]),
      reserve: (one) => asked.push(one.id) > 0,
    });
    expect(asked).toEqual(["gamma", "delta"]);
  });

  test("with too few left, the panel comes out short and still knows how many it wanted", () => {
    const result = choose({ risk: "high", authorLabs: new Set(["lab-a", "lab-b", "lab-c"]) });
    expect(result.ids).toEqual(["delta", "epsilon"]);
    expect(result.wanted).toBe(4);
  });

  test("everyone is either seated or on the bench with a reason", () => {
    const result = choose({ risk: "low" });
    expect([...result.ids, ...Object.keys(result.why)].sort()).toEqual(roster.map((one) => one.id).sort());
    expect(Object.values(result.why)).toEqual(["not-needed", "not-needed", "not-needed"]);
  });

  test("the same input always gives the same panel", () => {
    const runs = Array.from({ length: 20 }, () => choose({ areas: ["security"], risk: "high" }).ids.join());
    expect(new Set(runs).size).toBe(1);
  });

  test("choosing does not reorder the config", () => {
    const before = roster.map((one) => one.id);
    choose({ areas: ["security", "payments"] });
    expect(roster.map((one) => one.id)).toEqual(before);
  });
});
