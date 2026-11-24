import type { Reviewer } from "./config.ts";
import type { Failure } from "./outcome.ts";
import type { Area, Risk } from "./types.ts";

/** Why a reviewer is not on this panel. */
export type BenchReason = "author" | "check-failed" | "not-needed" | "same-lab" | "over-budget";
export type Bench = { reviewer: Reviewer; reason: BenchReason; detail: string };

/** A bigger risk gets more readers. One reader is not a panel, and past four they mostly repeat each other. */
const SEATS: Record<Risk, number> = { low: 2, medium: 3, high: 4 };
export const FEWEST_SEATS = 2;

/**
 * Picks who reviews. No model is asked: the same work, config and checks always
 * give the same panel, and every reviewer left out has a reason on record.
 */
export function chooseSeats(options: {
  reviewers: readonly Reviewer[];
  authorLabs: ReadonlySet<string>;
  areas: readonly Area[];
  risk: Risk;
  /** What went wrong, by reviewer id, for those that did not pass their check. */
  failedChecks: ReadonlyMap<string, Failure>;
  /** Sets the reviewer's worst case aside. False when it does not fit under the spend cap. */
  reserve: (reviewer: Reviewer) => boolean;
}): { wanted: number; seats: Reviewer[]; bench: Bench[] } {
  const wanted = SEATS[options.risk];
  const seats: Reviewer[] = [];
  const bench: Bench[] = [];

  const matches = (reviewer: Reviewer) => reviewer.goodAt.filter((area) => options.areas.includes(area)).length;
  // The sort is stable, so reviewers that match equally well stay in the order of the config.
  const ranked = options.reviewers.toSorted((a, b) => matches(b) - matches(a));

  for (const reviewer of ranked) {
    const leaveOut = (reason: BenchReason, detail: string) => bench.push({ reviewer, reason, detail });
    const failure = options.failedChecks.get(reviewer.id);
    const labmate = seats.find((seat) => seat.lab === reviewer.lab);

    if (options.authorLabs.has(reviewer.lab)) leaveOut("author", `${reviewer.lab} wrote the work`);
    else if (failure) leaveOut("check-failed", `${failure.reason}: ${failure.detail}`);
    else if (seats.length === wanted) leaveOut("not-needed", "the panel was full");
    else if (labmate) leaveOut("same-lab", `${labmate.id} already sits for ${reviewer.lab}`);
    else if (!options.reserve(reviewer)) leaveOut("over-budget", "its worst case does not fit under the spend cap");
    else seats.push(reviewer);
  }
  return { wanted, seats, bench };
}
