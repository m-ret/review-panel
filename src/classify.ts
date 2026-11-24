import type { ParsedDiff } from "./diff.ts";
import { AREAS, RISKS, type Area, type Risk } from "./types.ts";

export type Classification = {
  /** What the work touches, most sensitive first. */
  areas: Area[];
  risk: Risk;
  /** Why, in words a person can check. */
  reasons: string[];
};

/** Up to this many changed lines is a small change. */
const SMALL = 40;
/** Over this many, reviewers start to miss things. */
const LARGE = 800;

/**
 * Words that make a change sensitive. A word is matched whole, so "author" is
 * not "auth". `inPaths` holds words that say something in a file name and
 * nothing in a sentence ("what role does it play").
 */
const SENSITIVE_WORDS: Partial<Record<Area, { anywhere: string[]; inPaths: string[] }>> = {
  security: {
    anywhere:
      "auth authn authz oauth sso saml jwt rls csrf cors password passwords permission permissions secret secrets encryption security webhook webhooks".split(
        " ",
      ),
    inPaths: "login logout signin signup session sessions token role roles crypto encrypt sandbox env".split(" "),
  },
  payments: {
    anywhere:
      "payment payments billing checkout invoice invoices refund refunds payout payouts subscription subscriptions stripe paypal paddle".split(
        " ",
      ),
    inPaths: "charge charges price prices pricing tax taxes wallet ledger".split(" "),
  },
  data: {
    anywhere: "migration migrations backfill".split(" "),
    inPaths: "migrate schema sql prisma drizzle".split(" "),
  },
  infra: {
    anywhere: "terraform kubernetes".split(" "),
    inPaths: "dockerfile docker compose k8s helm tf nginx deploy deployment infra".split(" "),
  },
};

const DESTRUCTIVE: [RegExp, string][] = [
  [/\bdrop\s+(?:table|column|database|schema)\b/iu, "drops a table or column"],
  [/\btruncate\s+table\b/iu, "empties a table"],
  [/\bdelete\s+from\s+[\w."`]+\s*(?:;|$)/imu, "deletes every row of a table"],
  [/\brm\s+-[a-z]*(?:rf|fr)/iu, "runs rm -rf"],
  [/\bgit\s+push\b.*\s(?:--force|-f)\b/iu, "force-pushes"],
];

const DOCS = /\.(?:md|mdx|rst|adoc)$|(?:^|\/)LICENSE$/iu;
const FRONTEND = /\.(?:tsx|jsx|css|scss|sass|less|html|vue|svelte|astro)$/iu;
const LOCK_FILE =
  /(?:^|\/)(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/u;
const TESTS =
  /(?:^|\/)(?:tests?|__tests__|e2e|fixtures)\/|^spec\/|[._](?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]+\.py$/iu;

export function classifyDiff(diff: ParsedDiff): Classification {
  const areas = new Set<Area>();
  const sensitive: string[] = [];
  const destructive: string[] = [];
  let lines = 0;

  for (const file of diff.files) {
    if (!LOCK_FILE.test(file.path)) lines += file.added + file.removed;
    // A renamed file counts under both names: both say what kind of code moved.
    const names = [...new Set([file.path, file.oldPath ?? file.path])];
    for (const name of names) {
      const type = typeOf(name);
      areas.add(type);
      if (type === "docs" || type === "tests") continue;
      const found = sensitiveWords(wordsOf(name), true);
      if (name.startsWith(".github/")) found.set("infra", [".github"]);
      for (const area of found.keys()) areas.add(area);
      if (found.size > 0) sensitive.push(`${name} touches ${describe(found)}`);
      for (const what of destructiveIn(file.addedText)) destructive.push(`${name} ${what}`);
    }
  }

  const result = (risk: Risk, ...reasons: string[]): Classification => ({ areas: sorted(areas), risk, reasons });
  if (diff.problem) return result("high", `the diff could not be read all the way: ${diff.problem}`, ...sensitive);
  if (sensitive.length + destructive.length > 0) return result("high", ...sensitive, ...destructive);
  if ([...areas].every((area) => area === "docs" || area === "tests")) return result("low", "only docs and tests changed");
  if (lines > LARGE) return result("high", `${lines} changed lines, more than ${LARGE}`);
  if (lines <= SMALL) return result("low", `${lines} changed lines, nothing sensitive`);
  return result("medium", `${lines} changed lines, nothing sensitive`);
}

/** A question has no paths, so it is medium unless it names something sensitive. */
export function classifyQuestion(text: string): Classification {
  const found = sensitiveWords(wordsOf(text), false);
  const destructive = destructiveIn(text);
  const areas = sorted(new Set<Area>([...found.keys(), "design"]));
  if (found.size + destructive.length === 0) {
    return { areas, risk: "medium", reasons: ["a question with no sensitive words"] };
  }
  const reasons = found.size > 0 ? [`the question mentions ${describe(found)}`] : [];
  reasons.push(...destructive.map((what) => `the question mentions work that ${what}`));
  return { areas, risk: "high", reasons };
}

/** `--risk` can ask for more reviewers, never for fewer. */
export function raiseRisk(classification: Classification, asked: Risk | null): Classification {
  if (asked === null || asked === classification.risk) return classification;
  const { risk, reasons } = classification;
  if (RISKS.indexOf(asked) < RISKS.indexOf(risk)) {
    return { ...classification, reasons: [...reasons, `--risk ${asked} ignored: it can only raise the risk`] };
  }
  return { ...classification, risk: asked, reasons: [...reasons, `raised from ${risk} to ${asked} by --risk`] };
}

function typeOf(path: string): Area {
  if (DOCS.test(path)) return "docs";
  if (TESTS.test(path)) return "tests";
  if (FRONTEND.test(path)) return "frontend";
  if (/\.(?:sql|prisma)$/iu.test(path)) return "data";
  if (path.startsWith(".github/") || /(?:^|\/)Dockerfile|\.tf$/u.test(path)) return "infra";
  return "code";
}

/** "src/OAuthClient.ts" becomes src, o, auth, client, ts. */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u);
}

function sensitiveWords(words: string[], inPaths: boolean): Map<Area, string[]> {
  const found = new Map<Area, string[]>();
  for (const area of AREAS) {
    const table = SENSITIVE_WORDS[area];
    if (!table) continue;
    const list = new Set(inPaths ? [...table.anywhere, ...table.inPaths] : table.anywhere);
    const hits = [...new Set(words.filter((word) => list.has(word)))];
    if (hits.length > 0) found.set(area, hits);
  }
  return found;
}

function destructiveIn(text: string): string[] {
  return DESTRUCTIVE.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
}

function describe(found: Map<Area, string[]>): string {
  return [...found].map(([area, words]) => `${area} (${words.join(", ")})`).join(", ");
}

function sorted(areas: Set<Area>): Area[] {
  return AREAS.filter((area) => areas.has(area));
}
