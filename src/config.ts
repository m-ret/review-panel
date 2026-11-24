import { z } from "zod";
import { AREAS } from "./types.ts";

/** A problem in the config file, in words that never repeat a value from it. */
export class ConfigError extends Error {}

/** Names become file names and command-line words, so they stay simple. */
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, "use lower-case letters, digits and hyphens");
const dollars = z.number().nonnegative();

const providerSchema = z.strictObject({
  baseUrl: z
    .string()
    .refine(isSafeAddress, "must be https (http only on localhost) and hold no password, query or fragment")
    .transform((text) => {
      const { origin, pathname } = new URL(text);
      return `${origin}${pathname}`.replace(/\/+$/u, "");
    }),
  /** Left out for a local server that needs no key. */
  apiKeyEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/u, "write the name of an environment variable, such as MAIN_API_KEY, not a key")
    .optional(),
  /** Some newer models only accept max_completion_tokens. */
  maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  /** Set to false for a provider that rejects `stream_options`. */
  streamUsage: z.boolean().default(true),
});

const reviewerSchema = z.strictObject({
  id: name,
  lab: name,
  provider: name,
  model: z.string().min(1),
  goodAt: z.array(z.enum(AREAS)).default([]),
  usdPerMillionTokens: z.strictObject({ input: dollars, output: dollars }),
});

const limitsSchema = z.strictObject({
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  checkTimeoutSeconds: z.number().int().min(1).max(600).default(60),
  maxOutputTokens: z.number().int().min(256).max(200_000).default(16_000),
  maxUsd: dollars.default(0.5),
  maxInputBytes: z.number().int().min(1000).max(5_000_000).default(300_000),
});

const configSchema = z
  .strictObject({
    limits: limitsSchema.prefault({}),
    providers: z.record(name, providerSchema),
    reviewers: z.array(reviewerSchema).min(2, "a panel needs at least two reviewers"),
    /** Other names for an author, and the lab each belongs to: {"claude": "anthropic"}. */
    authors: z.record(name, name).default({}),
  })
  .superRefine((config, context) => {
    const problem = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const seen = new Set<string>();
    const labOf = new Map(config.reviewers.map((reviewer) => [reviewer.lab, reviewer.lab]));
    /** A name must point to one lab, or an author could be read two ways. */
    const claim = (path: (string | number)[], word: string, lab: string) => {
      if (word === "human") problem(path, "'human' is taken: it means no model wrote the work");
      const other = labOf.get(word);
      if (other !== undefined && other !== lab) problem(path, `'${word}' already stands for the lab '${other}'`);
      labOf.set(word, lab);
    };

    for (const [index, reviewer] of config.reviewers.entries()) {
      if (seen.has(reviewer.id)) problem(["reviewers", index, "id"], `'${reviewer.id}' is used twice`);
      if (["summary", "prompt"].includes(reviewer.id)) {
        problem(["reviewers", index, "id"], `'${reviewer.id}' is the name of another output file`);
      }
      if (!Object.hasOwn(config.providers, reviewer.provider)) {
        problem(["reviewers", index, "provider"], `there is no provider '${reviewer.provider}'`);
      }
      seen.add(reviewer.id);
      claim(["reviewers", index, "id"], reviewer.id, reviewer.lab);
      claim(["reviewers", index, "model"], reviewer.model.toLowerCase(), reviewer.lab);
    }
    for (const [alias, lab] of Object.entries(config.authors)) claim(["authors", alias], alias, lab);
    if (new Set(config.reviewers.map((reviewer) => reviewer.lab)).size < 2) {
      problem(["reviewers"], "reviewers must come from at least two different labs");
    }
  });

export type Config = z.output<typeof configSchema>;
export type Provider = Config["providers"][string];
export type Reviewer = Config["reviewers"][number];
export type Limits = Config["limits"];
export type Price = Reviewer["usdPerMillionTokens"];

export function parseConfig(text: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError("the config file is not valid JSON");
  }
  const result = configSchema.safeParse(json);
  if (result.success) return result.data;
  throw new ConfigError(result.error.issues.map(describeIssue).join("\n"));
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.join(".") || "config";
  const hint =
    issue.code === "unrecognized_keys" && issue.keys.some((key) => /key|token|secret|password/iu.test(key))
      ? ". Keys are read from environment variables: set apiKeyEnv to the name of one"
      : "";
  return `${where}: ${issue.message}${hint}`;
}

function isSafeAddress(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const isSafeScheme = url.protocol === "https:" || (url.protocol === "http:" && isLocal);
  return isSafeScheme && url.username + url.password + url.search + url.hash === "";
}

export type Key =
  | { state: "present"; key: string }
  | { state: "missing"; variable: string }
  | { state: "not-needed" };

/** The keys, by provider. Environment variables are the only place they are read from. */
export function readKeys(config: Config, env: Record<string, string | undefined>): Record<string, Key> {
  return Object.fromEntries(
    Object.entries(config.providers).map(([id, { apiKeyEnv: variable }]): [string, Key] => {
      if (variable === undefined) return [id, { state: "not-needed" }];
      const key = env[variable]?.trim() ?? "";
      // Only characters that can travel in an HTTP header.
      return [id, /^[\x21-\x7e]+$/u.test(key) ? { state: "present", key } : { state: "missing", variable }];
    }),
  );
}
