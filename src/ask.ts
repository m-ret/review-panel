import { costOf, type Budget } from "./budget.ts";
import { callModel, type Evidence } from "./call.ts";
import type { Config, Key, Reviewer } from "./config.ts";

/** What every call of one run shares. */
export type Context = {
  config: Config;
  keys: Record<string, Key>;
  budget: Budget;
  /** Key values, so they can be removed from anything a provider says. */
  secrets: readonly string[];
};

/** Asks one reviewer and settles what was reserved under `reservation`, whatever happens. */
export async function ask(
  reviewer: Reviewer,
  prompt: string,
  options: { reservation: string; maxOutputTokens: number; timeoutSeconds: number },
  { config, keys, budget, secrets }: Context,
): Promise<{ evidence: Evidence; charge: number | null }> {
  let charge: number | null = 0;
  try {
    const provider = config.providers[reviewer.provider];
    const key = keys[reviewer.provider];
    if (!provider || !key || key.state === "missing") throw new Error(`${reviewer.id} cannot be called without its key`);

    charge = null; // from here on it may cost something
    const evidence = await callModel(
      { ...provider, key: key.state === "present" ? key.key : null, model: reviewer.model },
      prompt,
      { maxOutputTokens: options.maxOutputTokens, timeoutMs: options.timeoutSeconds * 1000, secrets },
    );
    charge = chargeOf(evidence, reviewer);
    return { evidence, charge };
  } finally {
    budget.settle(options.reservation, charge);
  }
}

/** What a call cost, or null when nobody said. A refused request is not charged. */
function chargeOf(evidence: Evidence, reviewer: Reviewer): number | null {
  if (evidence.usage) return costOf(evidence.usage, reviewer.usdPerMillionTokens);
  const isRefused = evidence.status !== null && (evidence.status < 200 || evidence.status >= 300);
  return isRefused ? 0 : null;
}
