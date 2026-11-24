import { ask, type Context } from "./ask.ts";
import { worstCase } from "./budget.ts";
import type { Evidence } from "./call.ts";
import { checkReviewer } from "./check.ts";
import { classifyDiff, classifyQuestion, raiseRisk, type Classification } from "./classify.ts";
import type { Reviewer } from "./config.ts";
import { parseDiff, type ParsedDiff } from "./diff.ts";
import { judge, type Failure, type Outcome } from "./outcome.ts";
import { buildPrompt, makeCodes, signOffCode, type Codes } from "./prompt.ts";
import { chooseSeats, FEWEST_SEATS, type Bench } from "./seats.ts";
import { oneLine } from "./text.ts";
import type { Kind, Risk } from "./types.ts";

export type Authors = { names: readonly string[]; labs: ReadonlySet<string> };

/** Everything that is decided before anything is sent. */
export type Plan = {
  kind: Kind;
  authors: Authors;
  /** Null for a question. */
  diff: ParsedDiff | null;
  classification: Classification;
  codes: Codes;
  prompt: string;
};

export type SeatResult = {
  reviewer: Reviewer;
  outcome: Outcome;
  /** Null only when our own code failed. */
  evidence: Evidence | null;
  /** In millionths of a dollar. */
  cost: number;
  /** The provider did not say what the call cost, so the worst case is counted. */
  isWorstCase: boolean;
};

export type Panel = {
  /** Complete means every seat the risk asks for was filled and answered. It does not mean GO. */
  state: "complete" | "incomplete" | "not-started";
  wanted: number;
  seats: Reviewer[];
  bench: Bench[];
  results: SeatResult[];
  /** In millionths of a dollar. */
  spent: number;
  isOverCap: boolean;
};

export function planPanel(input: { kind: Kind; material: string; authors: Authors; askedRisk: Risk | null }): Plan {
  const { kind, material, authors, askedRisk } = input;
  const diff = kind === "diff" ? parseDiff(material) : null;
  const classification = raiseRisk(diff ? classifyDiff(diff) : classifyQuestion(material), askedRisk);
  const codes = makeCodes();
  const prompt = buildPrompt({ kind, areas: classification.areas, material, codes });
  return { kind, authors, diff, classification, codes, prompt };
}

/** The most this reviewer should cost for this plan. */
export function worstCaseOf(reviewer: Reviewer, plan: Plan, maxOutputTokens: number): number {
  return worstCase(Buffer.byteLength(plan.prompt), maxOutputTokens, reviewer.usdPerMillionTokens);
}

export async function runPanel(
  plan: Plan,
  context: Context,
  steps: {
    onChecks?: (failedChecks: ReadonlyMap<string, Failure>) => void;
    onSeats?: (seats: readonly Reviewer[], wanted: number) => void;
    onResult?: ((result: SeatResult) => void | Promise<void>) | undefined;
  } = {},
): Promise<Panel> {
  const { config, budget } = context;
  const { maxOutputTokens } = config.limits;

  const candidates = config.reviewers.filter((reviewer) => !plan.authors.labs.has(reviewer.lab));
  const checks = await Promise.all(
    candidates.map(async (reviewer) => [reviewer.id, await checkReviewer(reviewer, context).catch(internalError)] as const),
  );
  const failedChecks = new Map<string, Failure>();
  for (const [id, failure] of checks) {
    if (failure) failedChecks.set(id, failure);
  }
  steps.onChecks?.(failedChecks);

  const { wanted, seats, bench } = chooseSeats({
    reviewers: config.reviewers,
    authorLabs: plan.authors.labs,
    areas: plan.classification.areas,
    risk: plan.classification.risk,
    failedChecks,
    reserve: (reviewer) => budget.reserve(reviewer.id, worstCaseOf(reviewer, plan, maxOutputTokens)),
  });

  if (seats.length < FEWEST_SEATS) {
    for (const reviewer of seats) {
      budget.settle(reviewer.id, 0);
      bench.unshift({ reviewer, reason: "not-needed", detail: "one reviewer is not a panel, so it was not asked" });
    }
    return { state: "not-started", wanted, seats: [], bench, results: [], spent: budget.spent(), isOverCap: budget.isOver() };
  }
  steps.onSeats?.(seats, wanted);

  const results = await Promise.all(
    seats.map(async (reviewer) => {
      const result = await review(reviewer, plan, context);
      await steps.onResult?.(result);
      return result;
    }),
  );
  const isComplete = seats.length === wanted && results.every((result) => result.outcome.answered);
  return {
    state: isComplete ? "complete" : "incomplete",
    wanted,
    seats,
    bench,
    results,
    spent: budget.spent(),
    isOverCap: budget.isOver(),
  };
}

async function review(reviewer: Reviewer, plan: Plan, context: Context): Promise<SeatResult> {
  const { maxOutputTokens, timeoutSeconds } = context.config.limits;
  const most = worstCaseOf(reviewer, plan, maxOutputTokens);
  try {
    const { evidence, charge } = await ask(
      reviewer,
      plan.prompt,
      { reservation: reviewer.id, maxOutputTokens, timeoutSeconds },
      context,
    );
    const outcome = judge(evidence, plan.kind, signOffCode(plan.codes));
    return { reviewer, outcome, evidence, cost: charge ?? most, isWorstCase: charge === null };
  } catch (error) {
    return { reviewer, outcome: { answered: false, ...internalError(error) }, evidence: null, cost: most, isWorstCase: true };
  }
}

/** A bug of ours must show up as a seat that did not answer, not as a lost one. */
function internalError(error: unknown): Failure {
  return { reason: "internal-error", detail: oneLine(error instanceof Error ? error.message : String(error)) };
}
