// Everything a provider or a model sends back is untrusted text. These helpers
// make it safe to print in a terminal and safe to paste into a Markdown file.

/** Terminal sequences: window titles and links (OSC), colours and cursor moves (CSI). */
const TERMINAL_SEQUENCES = /\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b./gu;
/** Other control characters except tab and line feed, plus invisible format characters. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu;

export function stripControls(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(TERMINAL_SEQUENCES, "").replace(CONTROL_CHARACTERS, "");
}

/** One printable line, cut to `max` characters. */
export function oneLine(text: string, max = 200): string {
  const line = stripControls(text).replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * A provider's error body as one short note that is safe to keep.
 * Error bodies often quote the caller's key, account id or email, so those go.
 */
export function providerNote(body: string, secrets: readonly string[]): string {
  const note = withoutKeys(errorMessage(body), secrets)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, "[email]")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, "[id]")
    .replace(/[A-Za-z0-9_-]{20,}/gu, (run) => (looksLikeId(run) ? "[id]" : run));
  return oneLine(note);
}

/** Keys never get through, even from a gateway that repeats the request it was sent. */
export function withoutKeys(text: string, secrets: readonly string[]): string {
  return secrets.reduce((clean, secret) => (secret === "" ? clean : clean.replaceAll(secret, "[key]")), text);
}

/** Mixed upper case, lower case and digits in one long run: an id or a key, not a word. */
function looksLikeId(run: string): boolean {
  return /[A-Z]/u.test(run) && /[a-z]/u.test(run) && /[0-9]/u.test(run);
}

function errorMessage(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;
  const inner = isRecord(parsed["error"]) ? parsed["error"] : parsed;
  for (const key of ["message", "detail", "error", "title"]) {
    const value = inner[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return body;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text in a Markdown code block it cannot break out of. */
export function fenced(text: string): string {
  const longestRun = (text.match(/`+/gu) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** The text as one inert Markdown table cell, cut if it is very long. */
export function tableCell(text: string): string {
  return oneLine(text, 600).replace(/[\\`*_~|<>[\]]/gu, "\\$&");
}
