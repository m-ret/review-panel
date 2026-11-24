import { readFileSync } from "node:fs";
import { oneLine } from "./text.ts";
import type { Kind } from "./types.ts";

/** Something the person has to fix before anything is sent. */
export class InputError extends Error {}

export type Input = {
  kind: Kind;
  material: string;
  /** What it is, in words, for the summary. */
  source: string;
};

export type Wanted = {
  range?: string | undefined;
  /** Narrow a range to these paths. */
  paths: readonly string[];
  diff?: string | undefined;
  question?: string | undefined;
};

export function readInput({ range, paths, diff, question }: Wanted): Input {
  const given = [range, diff, question].filter((one) => one !== undefined);
  if (given.length !== 1) throw new InputError("give exactly one of --range, --diff or --question");
  if (paths.length > 0 && range === undefined) throw new InputError("paths after -- only go with --range");

  const input: Input =
    range !== undefined
      ? { kind: "diff", material: gitDiff(range, paths), source: ["git diff", range, ...(paths.length > 0 ? ["--", ...paths] : [])].join(" ") }
      : diff !== undefined
        ? { kind: "diff", material: readText(diff), source: diff === "-" ? "a diff from standard input" : diff }
        : { kind: "question", material: readText(question ?? ""), source: question === "-" ? "a question from standard input" : (question ?? "") };
  if (input.material.trim() === "") throw new InputError(`nothing to review: ${input.source} is empty`);
  return input;
}

/**
 * The plain unified diff, whatever the person's git is set up to print.
 * A range that starts with a hyphen would be read as an option, and git has
 * options that write files.
 */
function gitDiff(range: string, paths: readonly string[]): string {
  if (range.startsWith("-")) throw new InputError(`not a git range: ${oneLine(range, 60)}`);
  const done = Bun.spawnSync([
    "git",
    "--no-pager",
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    range,
    "--",
    ...paths,
  ]);
  if (done.exitCode !== 0) throw new InputError(`git could not read ${oneLine(range, 60)}: ${oneLine(done.stderr.toString())}`);
  return done.stdout.toString();
}

function readText(path: string): string {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch {
    throw new InputError(`cannot read ${path === "-" ? "standard input" : path}`);
  }
}
