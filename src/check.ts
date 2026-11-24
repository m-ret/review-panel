import { ask, type Context } from "./ask.ts";
import { worstCase } from "./budget.ts";
import type { Reviewer } from "./config.ts";
import { transportFailure, type Failure } from "./outcome.ts";

const PROMPT = "Reply with one word: ready";
const MAX_TOKENS = 16;

/**
 * Asks a reviewer for one word before the panel starts, and says what went
 * wrong, or null. It is a real completion because a list of models proves
 * little: providers list models they no longer serve, and list them to accounts
 * with no money. The reply is not graded. A reasoning model may spend all
 * sixteen tokens thinking, and that still proves that the key, the model and
 * the address work.
 */
export async function checkReviewer(reviewer: Reviewer, context: Context): Promise<Failure | null> {
  const key = context.keys[reviewer.provider];
  if (key?.state === "missing") {
    return { reason: "no-key", detail: `${key.variable} is not set, or holds characters a key cannot have` };
  }

  const reservation = `check ${reviewer.id}`;
  const most = worstCase(PROMPT.length, MAX_TOKENS, reviewer.usdPerMillionTokens);
  if (!context.budget.reserve(reservation, most)) {
    return { reason: "over-budget", detail: "not even its check fits under the spend cap" };
  }
  const { evidence } = await ask(
    reviewer,
    PROMPT,
    { reservation, maxOutputTokens: MAX_TOKENS, timeoutSeconds: context.config.limits.checkTimeoutSeconds },
    context,
  );
  return transportFailure(evidence);
}
