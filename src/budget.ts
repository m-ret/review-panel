import type { Price } from "./config.ts";
import type { Usage } from "./reply.ts";

// Money is kept in whole millionths of a dollar. A price of 2 dollars per
// million tokens is 2 of them per token, so no rounding error can build up.

/** Providers wrap a prompt in a template of their own. The largest seen added about 160 tokens. */
const TEMPLATE_TOKENS = 500;

export function costOf(usage: Usage, price: Price): number {
  return Math.ceil(usage.inputTokens * price.input + usage.outputTokens * price.output);
}

/**
 * The most a call can cost: the whole prompt, plus an answer that uses all of
 * its limit. A token is at least one byte, so counting one for every byte is
 * too high on purpose. A guess that can be too low would not be a cap.
 */
export function worstCase(promptBytes: number, maxOutputTokens: number, price: Price): number {
  return costOf({ inputTokens: promptBytes + TEMPLATE_TOKENS, outputTokens: maxOutputTokens }, price);
}

export type Budget = {
  /** Sets the money aside before a call starts. False means the call must not start. */
  reserve(id: string, micros: number): boolean;
  /** Replaces what was set aside with what the call cost. Null: it did not say, so the worst case stands. */
  settle(id: string, micros: number | null): void;
  /** For when something went wrong: if it is still open, the worst case stands. */
  close(id: string): void;
  spent(): number;
  left(): number;
  isOver(): boolean;
};

/**
 * Calls run at the same time, so checking what was spent so far is not enough:
 * two calls could both pass the check and go over together. Each call sets its
 * worst case aside first, and only starts if that still fits.
 */
export function createBudget(maxUsd: number): Budget {
  const cap = Math.round(maxUsd * 1_000_000);
  const reserved = new Map<string, number>();
  let spent = 0;

  const left = () => cap - spent - [...reserved.values()].reduce((sum, micros) => sum + micros, 0);

  return {
    reserve(id, micros) {
      if (reserved.has(id)) throw new Error(`reserved twice: ${id}`);
      if (micros > left()) return false;
      reserved.set(id, micros);
      return true;
    },
    settle(id, micros) {
      const held = reserved.get(id);
      if (held === undefined) throw new Error(`settled without a reservation: ${id}`);
      reserved.delete(id);
      spent += micros ?? held;
    },
    close(id) {
      spent += reserved.get(id) ?? 0;
      reserved.delete(id);
    },
    spent: () => spent,
    left,
    isOver: () => spent > cap,
  };
}

export function dollars(micros: number): string {
  if (micros === 0) return "$0";
  const [whole = "0", decimals = ""] = (micros / 1_000_000).toFixed(6).replace(/0+$/u, "").split(".");
  return `$${whole}.${decimals.padEnd(2, "0")}`;
}
