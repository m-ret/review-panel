import { existsSync, readFileSync } from "node:fs";
import { runGit } from "./git.ts";
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

/** A plain unified diff of everything, whatever the settings say. */
const DIFF_OPTIONS = [
  ...["--no-ext-diff", "--no-textconv", "--no-color", "--no-relative"],
  ...["--unified=3", "--inter-hunk-context=0", "--find-renames"],
  ...["--submodule=short", "--ignore-submodules=none"],
  ...["--src-prefix=a/", "--dst-prefix=b/"],
];

export function readInput({ range, paths, diff, question }: Wanted): Input {
  const given = [range, diff, question].filter((one) => one !== undefined);
  if (given.length !== 1) throw new InputError("give exactly one of --range, --diff or --question");
  if (paths.length > 0 && range === undefined) throw new InputError("paths after -- only go with --range");

  const input = range !== undefined ? fromGit(range, paths) : fromFile(diff, question ?? "");
  if (input.material.trim() === "") throw new InputError(`nothing to review: ${oneLine(input.source)} is empty`);
  return input;
}

function fromGit(range: string, paths: readonly string[]): Input {
  // Git would read it as an option, and git has options that write files.
  if (range.startsWith("-")) throw new InputError(`not a git range: ${oneLine(range, 60)}`);
  // Attributes come from an empty tree, so no file can ask to be left out of the diff or to be run through a filter.
  const emptyTree = runGit(["hash-object", "-t", "tree", "/dev/null"]).out.trim();
  const { exit, out, problem } = runGit([
    `--attr-source=${emptyTree}`,
    ...["diff", ...DIFF_OPTIONS, range, "--"],
    // A name that exists is a name, even if it looks like a pattern.
    ...paths.map((path) => (existsSync(path) ? `:(literal)${path}` : path)),
  ]);
  if (exit !== 0) throw new InputError(`git could not read ${oneLine(range, 60)}: ${oneLine(problem)}`);
  return { kind: "diff", material: out, source: ["git diff", range, ...(paths.length > 0 ? ["--", ...paths] : [])].join(" ") };
}

function fromFile(diff: string | undefined, question: string): Input {
  const kind = diff === undefined ? "question" : "diff";
  const path = diff ?? question;
  try {
    const material = readFileSync(path === "-" ? 0 : path, "utf8");
    return { kind, material, source: path === "-" ? `a ${kind} from standard input` : path };
  } catch {
    throw new InputError(`cannot read ${path === "-" ? "standard input" : oneLine(path)}`);
  }
}
