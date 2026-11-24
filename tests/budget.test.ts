import { describe, expect, test } from "bun:test";
import { costOf, createBudget, dollars, worstCase } from "../src/budget.ts";

const price = { input: 2, output: 10 }; // dollars per million tokens, so micro-dollars per token

describe("the price of a call", () => {
  test("what a call cost, in whole millionths of a dollar", () => {
    expect(costOf({ inputTokens: 1000, outputTokens: 200 }, price)).toBe(4000);
  });

  test("a fraction is rounded up, so many tiny calls never add up to nothing", () => {
    expect(costOf({ inputTokens: 1, outputTokens: 0 }, { input: 0.04, output: 0 })).toBe(1);
  });

  test("a free model costs nothing", () => {
    expect(costOf({ inputTokens: 5000, outputTokens: 5000 }, { input: 0, output: 0 })).toBe(0);
  });

  test("the worst case counts a token for every byte sent, some for the provider's template, and the whole answer limit", () => {
    // A token is at least one byte, so no text can have more tokens than bytes.
    expect(worstCase(3000, 500, price)).toBe((3000 + 500) * 2 + 500 * 10);
  });

  test("the worst case is not exceeded by text with a token in every byte, nor by a provider that adds to a short prompt", () => {
    expect(worstCase(3000, 0, price)).toBeGreaterThanOrEqual(costOf({ inputTokens: 3000, outputTokens: 0 }, price));
    // Measured: a 26-byte prompt came back as 184 tokens.
    expect(worstCase(26, 0, price)).toBeGreaterThanOrEqual(costOf({ inputTokens: 184, outputTokens: 0 }, price));
  });
});

describe("createBudget", () => {
  test("a call that fits is reserved, and one that does not is refused and changes nothing", () => {
    const budget = createBudget(0.01);
    expect(budget.reserve("a", 6000)).toBe(true);
    expect(budget.reserve("b", 4001)).toBe(false);
    expect(budget.reserve("c", 4000)).toBe(true);
    expect(budget.left()).toBe(0);
  });

  test("two calls that fit alone but not together cannot both start", () => {
    const budget = createBudget(0.01);
    expect([budget.reserve("a", 9000), budget.reserve("b", 9000)]).toEqual([true, false]);
  });

  test("when a call ends, its real cost replaces what was reserved", () => {
    const budget = createBudget(0.01);
    budget.reserve("a", 9000);
    budget.settle("a", 1500);
    expect(budget.spent()).toBe(1500);
    expect(budget.left()).toBe(8500);
  });

  test("a call with no usage report is charged its worst case", () => {
    const budget = createBudget(0.01);
    budget.reserve("a", 9000);
    budget.settle("a", null);
    expect(budget.spent()).toBe(9000);
  });

  test("a call that cost more than reserved is counted in full and the budget says it is over", () => {
    const budget = createBudget(0.01);
    budget.reserve("a", 9000);
    expect(budget.isOver()).toBe(false);
    budget.settle("a", 12_000);
    expect(budget.spent()).toBe(12_000);
    expect(budget.isOver()).toBe(true);
    expect(budget.reserve("b", 1)).toBe(false);
  });

  test("spending the whole cap is not going over it", () => {
    const budget = createBudget(0.01);
    budget.reserve("a", 10_000);
    budget.settle("a", 10_000);
    expect(budget.isOver()).toBe(false);
  });

  test("settling something that was never reserved is a bug, not a free call", () => {
    expect(() => createBudget(1).settle("ghost", 5)).toThrow("ghost");
  });

  test("reserving the same call twice is a bug", () => {
    const budget = createBudget(1);
    budget.reserve("a", 1);
    expect(() => budget.reserve("a", 1)).toThrow("a");
  });

  test("a cap of zero still lets free models run", () => {
    expect(createBudget(0).reserve("free", 0)).toBe(true);
    expect(createBudget(0).reserve("paid", 1)).toBe(false);
  });
});

describe("dollars", () => {
  test("small amounts keep enough digits to be read", () => {
    expect([0, 1, 4000, 12_345, 500_000, 1_250_000].map(dollars)).toEqual([
      "$0",
      "$0.000001",
      "$0.004",
      "$0.012345",
      "$0.50",
      "$1.25",
    ]);
  });
});
