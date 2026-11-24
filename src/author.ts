import type { Config } from "./config.ts";
import { oneLine } from "./text.ts";

export type Authors = { ok: true; names: string[]; labs: Set<string> } | { ok: false; problem: string };

/**
 * Who wrote the work, as the labs that must sit out.
 * A name the config does not know is refused. Accepting it would leave nobody
 * out, so one typo would let a model review its own work.
 */
export function resolveAuthors(text: string, config: Config): Authors {
  const labOf = new Map<string, string>();
  for (const [lab, aliases] of Object.entries(config.labs)) {
    for (const word of [lab, ...aliases]) labOf.set(word, lab);
  }
  for (const { id, lab, model } of config.reviewers) {
    for (const word of [id, model.toLowerCase()]) labOf.set(word, lab);
  }

  const names = text.toLowerCase().split(",").map((name) => name.trim()).filter((name) => name !== "");
  const known = `Known authors: human, ${[...labOf.keys()].sort().join(", ")}`;
  if (names.length === 0) return { ok: false, problem: `--author is missing. ${known}` };

  const labs = new Set<string>();
  for (const name of names) {
    if (name === "human") continue;
    const lab = labOf.get(name);
    if (lab === undefined) return { ok: false, problem: `unknown author '${oneLine(name, 60)}'. ${known}` };
    labs.add(lab);
  }
  return { ok: true, names, labs };
}
