// How a reviewer's text is read: its sign-off line and its findings.
// Models dress lines up (bold, quotes, list numbers), so the dressing is
// removed first. What the line says is then matched strictly.

export type Severity = "blocker" | "major" | "minor";
export type Finding = { severity: Severity; where: string; what: string };

const SEVERITIES: readonly string[] = ["blocker", "major", "minor"] satisfies Severity[];

/**
 * What follows the bar on the sign-off line, or null when there is none.
 * Only the last line counts. A sign-off with text after it belongs to an answer
 * that went on, and nobody can tell whether it got to its end.
 */
export function readSignOff(text: string, code: string): string | null {
  const last = text.split("\n").findLast((line) => /[\p{L}\p{N}]/u.test(line));
  if (last === undefined) return null;
  const line = plainDashesAndBars(last).replace(/[*`]/gu, "").replace(/^[\s>#_~-]+/u, "").trim();
  return new RegExp(`^SIGN-?OFF:?\\s+${code}\\s*\\|\\s*(\\S.*)$`, "iu").exec(line)?.[1] ?? null;
}

/** Every "FINDING | severity | place | text" line, in the order it was written. */
export function parseFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of text.split("\n")) {
    const line = unwrapped(plainDashesAndBars(raw).trim().replace(/^\||\|$/gu, "").trim());
    const [label = "", severity = "", where = "", ...rest] = line.split("|");
    const name = undressed(label.replace(/^[\s>#*_~-]*(?:\d+[.)])?/u, ""));
    const level = undressed(severity).toLowerCase();
    const what = rest.join("|").trim();
    if (name.toUpperCase() !== "FINDING" || !isSeverity(level) || what === "") continue;
    findings.push({ severity: level, where: undressed(where), what });
  }
  return findings;
}

function isSeverity(word: string): word is Severity {
  return SEVERITIES.includes(word);
}

/** Some models write a non-breaking hyphen, a long dash or a full-width bar. */
function plainDashesAndBars(text: string): string {
  return text.replace(/[‐-―−]/gu, "-").replace(/｜/gu, "|");
}

/** Removes a pair of marks that wraps the whole line. */
function unwrapped(line: string): string {
  return /^(\*\*|`+)(.*)\1$/u.exec(line)?.[2] ?? line;
}

function undressed(cell: string): string {
  return cell.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "");
}
