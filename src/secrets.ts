export type FoundSecret = { what: string; line: number };

/** Well-known formats. This is a safety net for what is about to be sent out, not a full scanner. */
const FORMATS: [string, RegExp][] = [
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/u],
  ["a Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{16,}/u],
  ["a model provider key", /\bsk-(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{20,}/u],
  ["an NVIDIA key", /\bnvapi-[A-Za-z0-9_-]{20,}/u],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/u],
  ["a signed token (JWT)", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u],
  ["a Slack token", /\bxox[abeoprs]-[0-9A-Za-z-]{10,}/u],
  // Only with key material after it: code that merely mentions the header is fine.
  ["a private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\s*\n[+ -]?\s*|\\n)[A-Za-z0-9+/=]{40,}/u],
];

/** Shorter values would match ordinary text. Local servers are often given a dummy key, such as "none". */
export const SHORTEST_KEY = 8;

/** What looks like a secret, and where. The value itself is never returned. */
export function findSecrets(text: string, keys: readonly string[]): FoundSecret[] {
  const found: FoundSecret[] = [];
  const add = (what: string, index: number) => found.push({ what, line: text.slice(0, index).split("\n").length });

  for (const [what, format] of FORMATS) {
    for (const match of text.matchAll(new RegExp(format, "gu"))) add(what, match.index);
  }
  for (const key of keys.filter((one) => one.length >= SHORTEST_KEY)) {
    for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
      add("a key from your environment", at);
    }
  }
  return found.sort((a, b) => a.line - b.line);
}
