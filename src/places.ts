import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runGit } from "./git.ts";
import { InputError } from "./input.ts";
import { oneLine } from "./text.ts";

// The config and the results live with the person, not in the folder under
// review. The config says where the keys and the code go, so whoever wrote the
// change must not be able to change it too.

type Environment = Record<string, string | undefined>;

export function readConfigFile(given: string | undefined, env: Environment): string {
  const path = given ?? join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "review-panel/panel.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new InputError(`cannot read the config file ${oneLine(path)}. Start from panel.example.json`);
  }
  if (mayBeTracked(realpathSync(path))) {
    throw new InputError(
      `git tracks ${oneLine(path)}, so a change under review could rewrite where your keys and your code go. Copy it to your own folder`,
    );
  }
  return text;
}

/** When git cannot say, the answer is yes. */
function mayBeTracked(path: string): boolean {
  const { exit, problem } = runGit(["-C", dirname(path), "ls-files", "--error-unmatch", "--", `:(literal)${basename(path)}`]);
  const isOutsideGit = problem.includes("not a git repository") || exit === -1;
  return exit !== 1 && !isOutsideGit;
}

/** A new or empty folder. An old answer next to new ones could pass for one of them. */
export function makeResultsFolder(given: string | undefined, name: string, env: Environment): string {
  const path = given ?? join(env["XDG_STATE_HOME"] || join(homedir(), ".local/state"), "review-panel", name);
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new InputError(`${oneLine(path)} already holds something. An old answer next to new ones could pass for one of them`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Writes a file that is not there yet. It never overwrites and never follows a link. */
export function writeNew(folder: string, name: string, text: string): void {
  writeFileSync(join(folder, name), text, { flag: "wx", mode: 0o600 });
}
