#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The two flags above keep the folder under review from handing this program
// keys (its .env) or code (its bunfig.toml). Bun reads both by default.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Context } from "./ask.ts";
import { resolveAuthors } from "./author.ts";
import { createBudget, dollars } from "./budget.ts";
import { ConfigError, parseConfig, readKeys, type Config } from "./config.ts";
import { InputError, readInput, type Input } from "./input.ts";
import { planPanel, runPanel, worstCaseOf, type Panel, type Plan } from "./panel.ts";
import { countAnswered, plural, reviewerMarkdown, sizeOf, summaryJson, summaryMarkdown } from "./report.ts";
import { chooseSeats, FEWEST_SEATS } from "./seats.ts";
import { findSecrets } from "./secrets.ts";
import { oneLine, stripControls } from "./text.ts";
import { RISKS, type Risk } from "./types.ts";

const HELP = `review-panel sends a diff or a question to two to four AI models that did not write it.
It records every answer and every missing one. A person decides.

  review-panel --author <who> --range <a..b> [-- <paths>]
  review-panel --author <who> --diff <file>
  review-panel --author <who> --question <file>

  --author <names>   Who wrote it: a reviewer, model, lab or alias from the config, or "human".
                     Several, with commas: claude,codex. Their labs sit out.
  --range <range>    A git range, such as main...HEAD. Paths after -- narrow it.
  --diff <file>      A unified diff. "-" reads standard input.
  --question <file>  A question or a plan, as text. "-" reads standard input.
  --config <file>    Default: panel.json
  --out <folder>     Default: a new folder in .review-panel/
  --risk <level>     low, medium or high. It can raise the risk, never lower it.
  --dry-run          Show the plan and write what would be sent. Sends nothing.
  --help

Exit codes: 0 every seat answered, 1 a seat is missing or did not answer,
2 nothing was sent, 3 fewer than two reviewers could sit.`;

const EXIT: Record<Panel["state"], number> = { complete: 0, incomplete: 1, "not-started": 3 };
const REFUSED = 2;

const say = (text: string) => console.error(stripControls(text));

async function main(): Promise<number> {
  const { values, positionals } = readArguments();
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const config = parseConfig(readConfig(values.config ?? "panel.json"));
  const authors = resolveAuthors(values.author ?? "", config);
  if (!authors.ok) throw new InputError(authors.problem);
  const input = readInput({ range: values.range, paths: positionals, diff: values.diff, question: values.question });
  const keys = readKeys(config, process.env);
  const secrets = Object.values(keys).flatMap((key) => (key.state === "present" ? [key.key] : []));
  refuseUnsendable(input, config, secrets);

  const startedAt = new Date();
  const plan = planPanel({ kind: input.kind, material: input.material, authors, askedRisk: readRisk(values.risk) });
  const out = makeFolder(values.out, startedAt, plan);
  writeFileSync(join(out, "prompt.txt"), plan.prompt);
  say(`${input.source}${plan.diff ? `, ${sizeOf(plan)}` : ""}`);
  say(`written by ${authors.names.join(", ")}; risk ${plan.classification.risk}`);
  for (const reason of plan.classification.reasons) say(`  ${oneLine(reason)}`);

  if (values["dry-run"]) {
    console.log(describePlan(plan, config, join(out, "prompt.txt")));
    return 0;
  }

  const context: Context = { config, keys, budget: createBudget(config.limits.maxUsd), secrets };
  const panel = await runPanel(plan, context, {
    onChecks: (failed) => {
      for (const [id, { reason, detail }] of failed) say(`check failed: ${id}: ${reason} (${detail})`);
    },
    onSeats: (seats, wanted, bench) => {
      for (const { reviewer, reason, detail } of bench) {
        if (reason === "over-budget") say(`not seated: ${reviewer.id}: ${reason} (${detail})`);
      }
      if (seats.length >= FEWEST_SEATS) {
        say(`asking ${seats.length} of ${wanted}: ${seats.map((seat) => seat.id).join(", ")}`);
      }
    },
    onResult: (result) => {
      writeFileSync(join(out, `${result.reviewer.id}.md`), reviewerMarkdown(result));
      const { outcome } = result;
      const said = outcome.answered ? `answered, ${plural(outcome.findings.length, "finding")}` : `${outcome.reason} (${outcome.detail})`;
      say(`${result.reviewer.id}: ${outcome.answered && input.kind === "question" ? "answered" : said}`);
    },
  });

  const run = { source: input.source, startedAt, maxUsd: config.limits.maxUsd, plan, panel };
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summaryJson(run), null, 2)}\n`);
  writeFileSync(join(out, "summary.md"), summaryMarkdown(run));
  say(closingLine(panel));
  console.log(join(out, "summary.md"));
  return EXIT[panel.state];
}

function readArguments() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        author: { type: "string" },
        range: { type: "string" },
        diff: { type: "string" },
        question: { type: "string" },
        config: { type: "string" },
        out: { type: "string" },
        risk: { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : String(error));
  }
}

function readConfig(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new InputError(`cannot read the config file ${path}. Start from panel.example.json`);
  }
}

function readRisk(text: string | undefined): Risk | null {
  if (text === undefined) return null;
  const risk = RISKS.find((one) => one === text);
  if (!risk) throw new InputError(`--risk must be ${RISKS.join(", ")}, not '${oneLine(text, 40)}'`);
  return risk;
}

/** Stops what must not leave this machine, and what no reviewer could read whole. */
function refuseUnsendable(input: Input, config: Config, secrets: readonly string[]): void {
  const { maxInputBytes } = config.limits;
  const bytes = Buffer.byteLength(input.material);
  if (bytes > maxInputBytes) {
    throw new InputError(
      `${input.source} is ${bytes} bytes and the limit is ${maxInputBytes}. It is not trimmed, because a reviewer would sign for a change it saw half of. Narrow it with paths after --`,
    );
  }
  const found = findSecrets(input.material, secrets);
  if (found.length > 0) {
    const list = found.map(({ what, line }) => `  ${what} on line ${line} of what would be sent`).join("\n");
    throw new InputError(`this looks like it holds a secret, so it was not sent:\n${list}\nLeave that file out with paths after --`);
  }
}

function makeFolder(wanted: string | undefined, startedAt: Date, plan: Plan): string {
  if (wanted !== undefined) {
    if (existsSync(wanted) && readdirSync(wanted).length > 0) {
      throw new InputError(`${wanted} already holds something. An old answer next to new ones could pass for one of them`);
    }
    mkdirSync(wanted, { recursive: true });
    return wanted;
  }
  const stamp = startedAt.toISOString().slice(0, 19).replace(/:/gu, "-");
  const folder = join(".review-panel", `${stamp}-${plan.codes.first}`);
  mkdirSync(folder, { recursive: true });
  // The answers quote the code under review, so git should leave them alone.
  writeFileSync(join(".review-panel", ".gitignore"), "*\n");
  return folder;
}

function describePlan(plan: Plan, config: Config, promptFile: string): string {
  const budget = createBudget(config.limits.maxUsd);
  const worst = (reviewer: Config["reviewers"][number]) => worstCaseOf(reviewer, plan, config.limits.maxOutputTokens);
  const { wanted, seats, bench } = chooseSeats({
    reviewers: config.reviewers,
    authorLabs: plan.authors.labs,
    areas: plan.classification.areas,
    risk: plan.classification.risk,
    failedChecks: new Map(),
    reserve: (reviewer) => budget.reserve(reviewer.id, worst(reviewer)),
  });
  const total = seats.reduce((sum, seat) => sum + worst(seat), 0);
  return [
    `Risk ${plan.classification.risk}: ${wanted} reviewers. Touches ${plan.classification.areas.join(", ")}.`,
    `If every check passes: ${seats.map((seat) => seat.id).join(", ")}. Worst case ${dollars(total)} of ${dollars(Math.round(config.limits.maxUsd * 1_000_000))}.`,
    ...bench.map(({ reviewer, reason, detail }) => `  not ${reviewer.id}: ${reason} (${detail})`),
    `What would be sent: ${promptFile}`,
    "Nothing was sent.",
  ].join("\n");
}

function closingLine(panel: Panel): string {
  if (panel.state === "not-started") return "Did not start: fewer than two reviewers could sit.";
  const count = `${countAnswered(panel)} of ${panel.wanted} reviewers answered.`;
  const warning = panel.state === "complete" ? "" : " This panel is not complete. A missing answer is not agreement.";
  return `${count}${warning} The decision is yours.`;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof InputError) && !(error instanceof ConfigError)) throw error;
  say(error.message);
  process.exitCode = REFUSED;
}
