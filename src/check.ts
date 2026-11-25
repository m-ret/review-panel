import { ask, type Context } from "./ask.ts";
import { worstCase } from "./budget.ts";
import type { Reviewer } from "./config.ts";
import { internalError, transportFailure, type Failure } from "./outcome.ts";

const PROMPT = "Reply with one word: ready";
const MAX_TOKENS = 16;

export type CheckResult = {
  /** What went wrong, or null. */
  failure: Failure | null;
  /** Replaces what was set aside for the check with what it cost. */
  settle: () => void;
};

/**
 * Asks a reviewer for one word before the panel starts. It is a real completion
 * because a list of models proves little: providers list models they no longer
 * serve, and list them to accounts with no money. The reply is not graded. A
 * reasoning model may spend all sixteen tokens thinking, and that still proves
 * that the key, the model and the address work.
 */
export async function checkReviewer(reviewer: Reviewer, context: Context): Promise<CheckResult> {
  const { budget, config, keys } = context;
  const failed = (reason: Failure["reason"], detail: string): CheckResult => ({
    failure: { reason, detail },
    settle: () => {},
  });
  const key = keys[reviewer.provider];
  if (key?.state === "missing") {
    return failed("no-key", `${key.variable} is not set, or holds characters a key cannot have`);
  }

  const reservation = `check ${reviewer.id}`;
  const most = worstCase(PROMPT.length, MAX_TOKENS, reviewer.usdPerMillionTokens);
  try {
    if (!budget.reserve(reservation, most)) return failed("over-budget", "not even its check fits under the spend cap");
    const options = { maxOutputTokens: MAX_TOKENS, timeoutSeconds: config.limits.checkTimeoutSeconds };
    const { evidence, charge } = await ask(reviewer, PROMPT, options, context);
    return { failure: transportFailure(evidence), settle: () => budget.settle(reservation, charge) };
  } catch (error) {
    return { failure: internalError(error), settle: () => budget.close(reservation) };
  }
}
