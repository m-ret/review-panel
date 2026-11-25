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

/** Asks one reviewer, and says what the call cost, or null when nobody said. */
export async function ask(
  reviewer: Reviewer,
  prompt: string,
  options: { maxOutputTokens: number; timeoutSeconds: number },
  { config, keys, secrets }: Context,
): Promise<{ evidence: Evidence; charge: number | null }> {
  const provider = config.providers[reviewer.provider];
  const key = keys[reviewer.provider];
  if (!provider || !key || key.state === "missing") throw new Error(`${reviewer.id} cannot be called without its key`);

  const evidence = await callModel(
    { ...provider, key: key.state === "present" ? key.key : null, model: reviewer.model },
    prompt,
    { maxOutputTokens: options.maxOutputTokens, timeoutMs: options.timeoutSeconds * 1000, secrets },
  );
  return { evidence, charge: chargeOf(evidence, reviewer) };
}

/**
 * A request that was turned down is not charged. Otherwise only a finished
 * answer knows its cost: usage can also come early, or a server can fail after
 * it did the work.
 */
function chargeOf({ status, end, finishReason, usage }: Evidence, reviewer: Reviewer): number | null {
  if (status !== null && status >= 300 && status < 500) return 0;
  const isFinished = end === "closed" && finishReason !== null;
  return isFinished && usage ? costOf(usage, reviewer.usdPerMillionTokens) : null;
}
