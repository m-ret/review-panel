import type { Finding, Severity } from "./answer.ts";
import { dollars } from "./budget.ts";
import type { Outcome } from "./outcome.ts";
import type { Panel, Plan, SeatResult } from "./panel.ts";
import { signOffCode } from "./prompt.ts";
import { fenced, stripControls, tableCell } from "./text.ts";

export type Run = {
  /** What was reviewed, in words: "git diff main...HEAD". */
  source: string;
  startedAt: Date;
  maxUsd: number;
  plan: Plan;
  panel: Panel;
};

const WORST_FIRST: Severity[] = ["blocker", "major", "minor"];

/**
 * The page a person reads. What is missing comes first, because a page that
 * opens with findings lets a missing reviewer look like one with nothing to say.
 */
export function summaryMarkdown(run: Run): string {
  const { plan, panel } = run;
  const isQuestion = plan.kind === "question";
  return [
    ...headline(panel),
    ...(panel.isOverCap ? ["", "**Spending went over the cap.** A provider charged more than the worst case."] : []),
    ...(plan.diff?.problem ? ["", `**The diff could not be read all the way:** ${tableCell(plan.diff.problem)}`] : []),
    "",
    ...facts(run),
    ...section("Reviewers", ["Reviewer", "Lab", "Result", "Time", "Cost"], panel.results.map(reviewerRow)),
    ...(isQuestion
      ? section("Recommendations", ["Reviewer", "Recommendation"], recommendationRows(panel))
      : [
          ...section("Findings", ["Severity", "Where", "What", "Reviewer"], findingRows(panel)),
          ...section("Answers with no findings", ["Reviewer", "In its own words"], cleanRows(panel)),
        ]),
    ...section(
      "Not seated",
      ["Reviewer", "Lab", "Why"],
      panel.bench.map(({ reviewer, reason, detail }) => [reviewer.id, reviewer.lab, `${reason}: ${detail}`]),
    ),
    "",
    "## Decision",
    "",
    "Left to a person. Nobody counts votes here, and no findings is not a GO.",
    "",
    "- [ ] GO",
    "- [ ] NO-GO",
    "",
    "Decided by:",
    "",
    "Why:",
    "",
  ].join("\n");
}

function headline(panel: Panel): string[] {
  if (panel.state === "not-started") {
    return ["# Review panel: did not start", "", "**Fewer than two reviewers could sit.** Nothing was sent for review."];
  }
  const title = `# Review panel: ${countAnswered(panel)} of ${panel.wanted} reviewers answered`;
  if (panel.state === "complete") {
    return [title, "", "Every seat answered. That is not a decision: a person reads the answers and decides."];
  }
  const silent = panel.seats.length - countAnswered(panel);
  const reasons = [
    panel.seats.length < panel.wanted
      ? `The risk asks for ${panel.wanted} reviewers and only ${panel.seats.length} could sit.`
      : "",
    silent > 0 ? `${plural(silent, "reviewer")} did not answer.` : "",
  ].filter((reason) => reason !== "");
  return [title, "", `**This panel is not complete.** ${reasons.join(" ")} A missing answer is not agreement.`];
}

function facts({ source, startedAt, maxUsd, plan, panel }: Run): string[] {
  const { areas, risk, reasons } = plan.classification;
  const size = plan.diff ? `, ${sizeOf(plan)}` : "";
  return list([
    ["Reviewed", `${source}${size}`],
    ["Fingerprint", `sha256 ${plan.fingerprint.slice(0, 16)}`],
    ["Written by", `${plan.authors.names.join(", ")}, so ${whoSitsOut(plan, panel)}`],
    ["Touches", areas.join(", ")],
    ["Risk", risk],
    ["Why", reasons.join("; ")],
    ["Cost", `${dollars(panel.spent)} of ${dollars(Math.round(maxUsd * 1_000_000))}`],
    ["Run", `${startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC, sign-off code ${signOffCode(plan.codes)}`],
  ]);
}

/** A lab without a reviewer is named too: if that surprises the reader, the config may be wrong. */
function whoSitsOut(plan: Plan, panel: Panel): string {
  const hasReviewer = (lab: string) => panel.bench.some(({ reviewer, reason }) => reason === "author" && reviewer.lab === lab);
  const labs = [...plan.authors.labs].map((lab) => `${lab} sits out${hasReviewer(lab) ? "" : " (it has no reviewer here)"}`);
  return labs.length === 0 ? "no lab sits out" : labs.join(", ");
}

export function sizeOf(plan: Plan): string {
  const files = plan.diff?.files ?? [];
  const sum = (key: "added" | "removed") => files.reduce((total, file) => total + file[key], 0);
  return `${plural(files.length, "file")}, +${sum("added")} -${sum("removed")}`;
}

function reviewerRow(result: SeatResult): Cell[] {
  const { reviewer, outcome } = result;
  return [
    fileOf(reviewer.id),
    reviewer.lab,
    outcome.answered
      ? describe(outcome)
      : { markdown: `**did not answer**, ${tableCell(`${outcome.reason}: ${outcome.detail}`)}` },
    secondsOf(result),
    costOf(result),
  ];
}

/** Worst first, then by file and line, so that one problem found by two reviewers sits together. */
function findingRows(panel: Panel): Cell[][] {
  const all = panel.results.flatMap(({ reviewer, outcome }) =>
    outcome.answered ? outcome.findings.map((finding) => ({ ...finding, id: reviewer.id })) : [],
  );
  const rank = ({ severity }: Finding) => WORST_FIRST.indexOf(severity);
  return all
    .toSorted((a, b) => rank(a) - rank(b) || comparePlaces(a.where, b.where))
    .map(({ severity, where, what, id }) => [severity, where, what, fileOf(id)]);
}

function comparePlaces(a: string, b: string): number {
  const [pathA = "", lineA = "0"] = a.split(":");
  const [pathB = "", lineB = "0"] = b.split(":");
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  return (Number.parseInt(lineA, 10) || 0) - (Number.parseInt(lineB, 10) || 0);
}

function fileOf(id: string): Cell {
  return { markdown: `[${id}](${id}.md)` };
}

/** A reviewer that found nothing should at least say what it looked at. A person can tell a hollow answer. */
function cleanRows(panel: Panel): string[][] {
  return panel.results
    .filter(({ outcome }) => outcome.answered && outcome.findings.length === 0)
    .map(({ reviewer, evidence }) => {
      const words = (evidence?.text ?? "").trim().split("\n").slice(0, -1).join(" ");
      return [reviewer.id, words.trim() === "" ? "(nothing but its sign-off)" : words];
    });
}

function recommendationRows(panel: Panel): string[][] {
  return panel.results.flatMap(({ reviewer, outcome }) =>
    outcome.answered ? [[reviewer.id, outcome.recommendation ?? ""]] : [],
  );
}

/** The same facts for a program. `decision` is always null: no code here ever fills it in. */
export function summaryJson({ source, startedAt, maxUsd, plan, panel }: Run): Record<string, unknown> {
  const summary = {
    version: 1,
    state: panel.state,
    decision: null,
    startedAt: startedAt.toISOString(),
    source,
    sha256: plan.fingerprint,
    kind: plan.kind,
    authors: plan.authors.names,
    leftOutLabs: [...plan.authors.labs],
    areas: plan.classification.areas,
    risk: plan.classification.risk,
    reasons: plan.classification.reasons,
    diffProblem: plan.diff?.problem ?? null,
    signOffCode: signOffCode(plan.codes),
    wanted: panel.wanted,
    seated: panel.seats.length,
    answered: countAnswered(panel),
    spend: { spentUsd: panel.spent / 1_000_000, capUsd: maxUsd, isOverCap: panel.isOverCap },
    reviewers: panel.results.map(({ reviewer, outcome, evidence, cost, isWorstCase }) => ({
      id: reviewer.id,
      lab: reviewer.lab,
      provider: reviewer.provider,
      model: reviewer.model,
      file: `${reviewer.id}.md`,
      ...outcome,
      seconds: evidence === null ? null : evidence.ms / 1000,
      usage: evidence?.usage ?? null,
      costUsd: cost / 1_000_000,
      isWorstCase,
    })),
    notSeated: panel.bench.map(({ reviewer, reason, detail }) => ({
      id: reviewer.id,
      lab: reviewer.lab,
      reason,
      detail,
    })),
  };
  // Paths and names come from outside, and JSON keeps characters that a terminal would obey.
  return JSON.parse(JSON.stringify(summary, (_key, value) => (typeof value === "string" ? stripControls(value) : value)));
}

/** One reviewer's file. The text is kept as it came, in a block where nothing renders. */
export function reviewerMarkdown(result: SeatResult): string {
  const { reviewer, outcome, evidence } = result;
  const text = evidence?.text ?? "";
  const usage = evidence?.usage;
  const rows: [string, string][] = [
    ["Model", `${reviewer.model} (${reviewer.lab})`],
    ["Provider", reviewer.provider],
    ["Time", secondsOf(result)],
    ["Tokens", usage ? `${usage.inputTokens} in, ${usage.outputTokens} out` : "the provider did not say"],
    ["Cost", costOf(result)],
    ["Finish reason", evidence?.finishReason ?? "none"],
  ];
  return [
    `# ${reviewer.id}: ${describe(outcome)}`,
    "",
    ...list(rows),
    "",
    ...(outcome.answered
      ? ["## Answer", ""]
      : [`**Why:** ${tableCell(`${outcome.reason}: ${outcome.detail}`)}`, "", "## What arrived (not counted)", ""]),
    text.trim() === "" ? "No text arrived." : fenced(text),
    "",
  ].join("\n");
}

function describe(outcome: Outcome): string {
  if (!outcome.answered) return `did not answer (${outcome.reason})`;
  if (outcome.recommendation !== null) return "answered";
  return outcome.findings.length === 0 ? "no findings" : plural(outcome.findings.length, "finding");
}

function secondsOf({ evidence }: SeatResult): string {
  return evidence === null ? "-" : `${Math.round(evidence.ms / 1000)} s`;
}

function costOf({ cost, isWorstCase }: SeatResult): string {
  return `${isWorstCase && cost > 0 ? "at most " : ""}${dollars(cost)}`;
}

export function countAnswered(panel: Panel): number {
  return panel.results.filter((result) => result.outcome.answered).length;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Text is made inert. Markdown is only for what was built here. */
type Cell = string | { markdown: string };

function table(head: string[], rows: Cell[][]): string[] {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const render = (cell: Cell) => (typeof cell === "string" ? tableCell(cell) : cell.markdown);
  return [line(head), line(head.map(() => "---")), ...rows.map((row) => line(row.map(render)))];
}

function list(rows: [string, string][]): string[] {
  return rows.map(([label, text]) => `- **${label}:** ${tableCell(text)}`);
}

function section(title: string, head: string[], rows: Cell[][]): string[] {
  return rows.length === 0 ? [] : ["", `## ${title}`, "", ...table(head, rows)];
}
