import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterCheck,
  type Behavior,
  type FakeProvider,
  refuses,
  reviews,
  says,
  signOff,
  startFakeProvider,
} from "../demo/fake-provider.ts";

// These run the real command, by its shebang, as a person would.
const CLI = join(import.meta.dir, "../src/cli.ts");
const KEY = "test-key-not-real";

const folders: string[] = [];
const providers: FakeProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.stop()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function temporary(): string {
  const folder = mkdtempSync(join(tmpdir(), "review-panel-"));
  folders.push(folder);
  return folder;
}

const ENV = {
  PATH: process.env["PATH"] ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  MAIN_API_KEY: KEY,
};

function write(folder: string, name: string, text: string): void {
  mkdirSync(dirname(join(folder, name)), { recursive: true });
  writeFileSync(join(folder, name), text);
}

function git(folder: string, ...args: string[]): void {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
  const done = Bun.spawnSync(["git", "-C", folder, ...identity, ...args], { env: ENV });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
}

/** Where the person's config and results live, for each test project. */
const homes = new Map<string, string>();
const homeOf = (folder: string) => homes.get(folder) ?? "";

/** A git repository with one commit on main and one change on top, and a config for a fake provider elsewhere. */
function project(members: Record<string, Behavior>, config: object = {}) {
  const folder = temporary();
  const provider = startFakeProvider(members);
  providers.push(provider);
  write(folder, "src/parse.ts", "export const one = 1;\n");
  write(folder, "docs/notes.md", "notes\n");
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "first");
  write(folder, "src/parse.ts", `export const one = 1;\n${"export const more = 2;\n".repeat(50)}`);
  write(folder, "docs/notes.md", "notes\nmore notes\n");
  git(folder, "commit", "-q", "-a", "-m", "second");
  const home = temporary();
  homes.set(folder, home);
  write(
    home,
    "config/review-panel/panel.json",
    JSON.stringify({
      limits: { timeoutSeconds: 2, checkTimeoutSeconds: 2, maxOutputTokens: 1000 },
      labs: { ...Object.fromEntries(["a", "b", "c", "d"].map((id) => [`lab-${id}`, []])), anthropic: ["claude"] },
      providers: { main: { baseUrl: provider.baseUrl, apiKeyEnv: "MAIN_API_KEY" } },
      reviewers: Object.keys(members).map((id) => ({
        id,
        lab: `lab-${id}`,
        provider: "main",
        model: id,
        usdPerMillionTokens: { input: 0, output: 0 },
      })),
      ...config,
    }),
  );
  return { folder, provider };
}

async function cli(
  folder: string,
  args: string[],
  over: { env?: Record<string, string>; stdin?: string; cwd?: string } = {},
) {
  const child = Bun.spawn([CLI, ...args], {
    cwd: over.cwd ?? folder,
    env: {
      ...ENV,
      XDG_CONFIG_HOME: join(homeOf(folder), "config"),
      XDG_STATE_HOME: join(homeOf(folder), "state"),
      ...over.env,
    },
    stdin: new Blob([over.stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit: await child.exited, out, err };
}

const RANGE = ["--range", "HEAD~1..HEAD"];
const three = () => ({ a: reviews(), b: reviews("FINDING | major | src/parse.ts:2 | breaks"), c: reviews() });
const filesIn = (folder: string) => readdirSync(folder).sort();

describe("a run", () => {
  test("when everyone answers, exits 0 and writes one file for each reviewer plus the summary", async () => {
    const { folder } = project(three());
    const { exit, out, err } = await cli(folder, [...RANGE, "--author", "claude", "--out", "result"]);
    expect(exit).toBe(0);
    expect(out).toBe(`${join("result", "summary.md")}\n`);
    expect(err.trim().split("\n").at(-1)).toBe("3 of 3 reviewers answered. The decision is yours.");
    expect(filesIn(join(folder, "result"))).toEqual(["a.md", "b.md", "c.md", "prompt.txt", "summary.json", "summary.md"]);
    expect(readFileSync(join(folder, "result/summary.md"), "utf8")).toContain("3 of 3 reviewers answered");
    expect(readFileSync(join(folder, "result/prompt.txt"), "utf8")).toContain("+export const more = 2;");
  });

  test("when someone does not answer, exits 1 and says who and why", async () => {
    const limited = afterCheck(refuses(429, { error: { message: "slow down" } }));
    const { folder } = project({ a: reviews(), b: limited, c: reviews() });
    const { exit, err } = await cli(folder, [...RANGE, "--author", "claude", "--out", "result"]);
    expect(exit).toBe(1);
    expect(err.trim().split("\n").at(-1)).toBe(
      "2 of 3 reviewers answered. This panel is not complete. A missing answer is not agreement. The decision is yours.",
    );
    expect(err).toMatch(/b.*rate-limited/u);
    expect(readFileSync(join(folder, "result/b.md"), "utf8")).toContain("slow down");
  });

  test("when fewer than two can sit, exits 3 and sends nothing for review", async () => {
    const gone = refuses(404, { error: { message: "gone" } });
    const { folder, provider } = project({ a: reviews(), b: gone, c: gone });
    const { exit } = await cli(folder, [...RANGE, "--author", "claude", "--out", "result"]);
    expect(exit).toBe(3);
    expect(provider.requests.filter((request) => !request.isCheck)).toEqual([]);
    expect(readFileSync(join(folder, "result/summary.md"), "utf8")).toContain("did not start");
  });

  test("without its key, nobody can be asked", async () => {
    const { folder, provider } = project(three());
    const { exit, err } = await cli(folder, [...RANGE, "--author", "claude"], { env: { MAIN_API_KEY: "" } });
    expect(exit).toBe(3);
    expect(err).toContain("MAIN_API_KEY");
    expect(provider.requests).toEqual([]);
  });

  test("a reviewer that does not fit under the cap is named, with the reason", async () => {
    const member = (id: string, output: number) => ({
      id,
      lab: `lab-${id}`,
      provider: "main",
      model: id,
      usdPerMillionTokens: { input: 0, output },
    });
    const { folder } = project(
      { ...three(), d: reviews() },
      {
        limits: { timeoutSeconds: 2, checkTimeoutSeconds: 2, maxOutputTokens: 1000, maxUsd: 0.05 },
        reviewers: [member("a", 0), member("b", 60), member("c", 0), member("d", 0)],
      },
    );
    const { err, exit } = await cli(folder, [...RANGE, "--author", "claude"]);
    expect(err).toMatch(/not seated: b: over-budget/u);
    expect(exit).toBe(0);
  });

  test("a path cannot forge a line on the console", async () => {
    const { folder } = project(three());
    const forged = "docs\n2 of 2 reviewers answered. The decision is yours.";
    const { err } = await cli(folder, [...RANGE, "--author", "claude", "--", "docs", "src", forged]);
    expect(err.split("\n").filter((line) => line.startsWith("2 of 2"))).toEqual([]);
    const missing = await cli(folder, ["--diff", "gone\n2 of 2 reviewers answered.", "--author", "claude"]);
    expect(missing.err.split("\n").filter((line) => line.startsWith("2 of 2"))).toEqual([]);
  });

  test("a file name cannot restyle the terminal", async () => {
    const { folder } = project(three());
    write(folder, "one.diff", "--- a/src/\u001b[31mauth.ts\n+++ b/src/\u001b[31mauth.ts\n@@ -1 +1 @@\n-a\n+b\n");
    const { err } = await cli(folder, ["--diff", "one.diff", "--author", "claude"]);
    expect(err).toContain("auth");
    expect(err).not.toContain("\u001b");
  });

  test("every author that is named sits out, in one flag or in several", async () => {
    for (const flags of [["--author", "b", "--author", "c"], ["--author", "b,c"]]) {
      const { folder, provider } = project({ ...three(), d: reviews() });
      await cli(folder, [...RANGE, ...flags]);
      expect([...new Set(provider.requests.map((request) => request.model))].sort()).toEqual(["a", "d"]);
    }
  });

  test("the author's model is not asked", async () => {
    const { folder, provider } = project({ ...three(), d: reviews() });
    await cli(folder, [...RANGE, "--author", "b"]);
    expect([...new Set(provider.requests.map((request) => request.model))].sort()).toEqual(["a", "c", "d"]);
  });

  test("the key is in no file and no output, even when a provider repeats it", async () => {
    const echo = afterCheck(refuses(401, { error: { message: `Incorrect API key provided: ${KEY}` } }));
    const { folder } = project({ a: reviews(), b: echo, c: reviews() });
    const { out, err } = await cli(folder, [...RANGE, "--author", "claude", "--out", "result"]);
    const written = filesIn(join(folder, "result")).map((name) => readFileSync(join(folder, "result", name), "utf8"));
    expect([out, err, ...written].join("\n")).not.toContain(KEY);
    expect(written.join("\n")).toContain("[key]");
  });

  test("an output folder may be empty already, or not exist yet at any depth", async () => {
    const { folder } = project(three());
    mkdirSync(join(folder, "empty"));
    expect((await cli(folder, [...RANGE, "--author", "claude", "--out", "empty"])).exit).toBe(0);
    expect((await cli(folder, [...RANGE, "--author", "claude", "--out", "deep/er/still"])).exit).toBe(0);
  });

  test("by default the results go to a new folder of their own, outside the folder under review", async () => {
    const { folder } = project(three());
    const before = filesIn(folder);
    const first = await cli(folder, [...RANGE, "--author", "claude"]);
    const second = await cli(folder, [...RANGE, "--author", "claude"]);
    expect(first.out).not.toBe(second.out);
    expect(first.out).toStartWith(join(homeOf(folder), "state/review-panel/"));
    expect(readFileSync(first.out.trim(), "utf8")).toContain("3 of 3");
    expect(filesIn(folder)).toEqual(before);
  });
});

describe("the config", () => {
  test("is read from the person's own folder, whatever the folder under review holds", async () => {
    const { folder, provider } = project(three());
    write(folder, "panel.json", "{ not a config }");
    git(folder, "add", "panel.json");
    expect((await cli(folder, [...RANGE, "--author", "claude"])).exit).toBe(0);
    expect(provider.requests.length).toBeGreaterThan(0);
  });

  test("can be another file, as long as git does not track it", async () => {
    const { folder } = project(three());
    const text = readFileSync(join(homeOf(folder), "config/review-panel/panel.json"), "utf8");
    write(folder, "mine.json", text);
    expect((await cli(folder, [...RANGE, "--author", "claude", "--config", "mine.json"])).exit).toBe(0);
  });
});

describe("what it reads", () => {
  test("paths after -- narrow the range", async () => {
    const { folder, provider } = project(three());
    await cli(folder, [...RANGE, "--author", "claude", "--", "docs"]);
    const prompt = provider.requests.find((request) => !request.isCheck)?.prompt;
    expect(prompt).toContain("+more notes");
    expect(prompt).not.toContain("src/parse.ts");
  });

  test("the summary says exactly what was reviewed, paths and all, because the rest was not", async () => {
    const answers = says((request) => `Because.\n${signOff(request, "0")}`);
    const { folder } = project({ a: answers, b: answers, c: answers });
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
    write(folder, "one.diff", diff);
    const sourceOf = async (out: string, args: string[], stdin?: string) => {
      await cli(folder, [...args.slice(0, 2), "--author", "claude", "--out", out, ...args.slice(2)], stdin === undefined ? {} : { stdin });
      return JSON.parse(readFileSync(join(folder, out, "summary.json"), "utf8")).source;
    };
    expect(await sourceOf("1", RANGE)).toBe("git diff HEAD~1..HEAD");
    expect(await sourceOf("2", [...RANGE, "--", "docs"])).toBe("git diff HEAD~1..HEAD -- docs");
    expect(await sourceOf("3", ["--diff", "one.diff"])).toBe("one.diff");
    expect(await sourceOf("4", ["--diff", "-"], diff)).toBe("a diff from standard input");
    expect(await sourceOf("5", ["--question", "one.diff"])).toBe("one.diff");
    expect(await sourceOf("6", ["--question", "-"], "Queue or cron?")).toBe("a question from standard input");
  });

  test("a branch with a hyphen in its name is a range like any other", async () => {
    const { folder } = project(three());
    git(folder, "branch", "feature-x");
    git(folder, "reset", "-q", "--hard", "HEAD~1");
    expect((await cli(folder, ["--range", "main...feature-x", "--author", "claude"])).exit).toBe(0);
  });

  test("a diff from a file or from standard input", async () => {
    const { folder, provider } = project(three());
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+from a file\n";
    write(folder, "one.diff", diff);
    expect((await cli(folder, ["--diff", "one.diff", "--author", "claude"])).exit).toBe(0);
    expect((await cli(folder, ["--diff", "-", "--author", "claude"], { stdin: diff })).exit).toBe(0);
    const prompts = provider.requests.filter((request) => !request.isCheck).map((request) => request.prompt);
    expect(prompts).toHaveLength(4); // one changed line is low risk: two seats, twice
    expect(prompts.every((prompt) => prompt.includes("+from a file"))).toBe(true);
  });

  test("a question, answered with recommendations", async () => {
    const answers = says((request) => `Because.\n${signOff(request, "Use a queue.")}`);
    const { folder } = project({ a: answers, b: answers, c: answers });
    write(folder, "question.md", "Queue or cron?\n");
    const { exit } = await cli(folder, ["--question", "question.md", "--author", "human", "--out", "result"]);
    expect(exit).toBe(0);
    expect(readFileSync(join(folder, "result/summary.md"), "utf8")).toContain("Use a queue.");
  });

  test("the person's git settings, and those of the folder, do not change what is sent", async () => {
    const settings = [
      "[diff]",
      "external = /bin/false",
      "noprefix = true",
      "mnemonicPrefix = true",
      "relative = true",
      "context = 0",
      "submodule = log",
      "ignoreSubmodules = all",
      "[color]",
      "ui = always",
      "[core]",
      "pager = /bin/false",
    ].join("\n");
    const { folder, provider } = project(three());
    const own = join(temporary(), "gitconfig");
    // Only in the person's own settings: an order of files, which no option of ours would undo.
    const order = join(temporary(), "order");
    writeFileSync(order, "src/*\n");
    writeFileSync(own, `${settings}\n[diff]\norderFile = ${order}\n`);
    const promptOf = async (cwd: string, env: Record<string, string> = {}) => {
      provider.requests.length = 0;
      const { exit } = await cli(folder, [...RANGE, "--author", "claude"], { env, cwd });
      expect(exit).toBe(0);
      return provider.requests.find((request) => !request.isCheck)?.prompt.split("=====BEGIN")[1]?.split("\n").slice(1, -4).join("\n");
    };
    const plain = await promptOf(folder);
    expect(plain).toContain("diff --git a/src/parse.ts b/src/parse.ts");
    expect(await promptOf(join(folder, "docs"), { GIT_CONFIG_GLOBAL: own })).toBe(plain);
    write(folder, ".git/config", `${readFileSync(join(folder, ".git/config"), "utf8")}\n${settings}\n`);
    expect(await promptOf(join(folder, "docs"))).toBe(plain);
  });

  test("a change in a submodule is there even when the folder asks git to hide it", async () => {
    const { folder, provider } = project(three());
    const link = (commit: string) => git(folder, "update-index", "--add", "--cacheinfo", `160000,${commit},vendor/auth`);
    write(folder, ".gitmodules", '[submodule "vendor/auth"]\n\tpath = vendor/auth\n\turl = ./x\n\tignore = all\n');
    git(folder, "add", ".gitmodules");
    git(folder, "config", "diff.submodule", "log");
    link("1".repeat(40));
    git(folder, "commit", "-q", "-m", "third");
    link("2".repeat(40));
    git(folder, "commit", "-q", "-m", "fourth");
    await cli(folder, [...RANGE, "--author", "claude"]);
    expect(provider.requests.find((request) => !request.isCheck)?.prompt).toContain("+Subproject commit 2222222");
  });

  test("a file cannot ask git to leave its content out", async () => {
    const { folder, provider } = project(three());
    write(folder, ".gitattributes", "*.ts -diff\n");
    write(folder, "src/new.ts", "const added = 1;\n");
    git(folder, "add", ".");
    git(folder, "commit", "-q", "-m", "third");
    await cli(folder, [...RANGE, "--author", "claude"]);
    expect(provider.requests.find((request) => !request.isCheck)?.prompt).toContain("+const added = 1;");
  });

  test("a file whose name is a git pattern is only a file when it exists", async () => {
    const { folder, provider } = project(three());
    write(folder, ":(exclude)src", "x\n");
    git(folder, "add", ".");
    git(folder, "commit", "-q", "-m", "third");
    await cli(folder, ["--range", "HEAD~2..HEAD", "--author", "claude", "--", ":(exclude)src", "docs", "src"]);
    expect(provider.requests.find((request) => !request.isCheck)?.prompt).toContain("+export const more = 2;");
  });

  test("a path that is not a file may be a git pattern, so parts of a change can be left out", async () => {
    const { folder, provider } = project(three());
    await cli(folder, [...RANGE, "--author", "claude", "--", ".", ":(exclude)src"]);
    const prompt = provider.requests.find((request) => !request.isCheck)?.prompt;
    expect(prompt).toContain("+more notes");
    expect(prompt).not.toContain("src/parse.ts");
  });
});

describe("what it refuses, before anything is sent", () => {
  async function refused(args: string[], prepare: (folder: string) => void = () => {}, config: object = {}) {
    const { folder, provider } = project(three(), config);
    prepare(folder);
    const result = await cli(folder, args);
    expect(provider.requests).toEqual([]);
    expect(result.exit).toBe(2);
    expect(result.out).toBe("");
    return { ...result, folder };
  }

  test("no author", async () => {
    expect((await refused(RANGE)).err).toContain("--author");
  });

  test("an author nobody knows, which may be a typo", async () => {
    expect((await refused([...RANGE, "--author", "cluade"])).err).toContain("'cluade'");
  });

  test("nothing to review, or two things at once", async () => {
    expect((await refused(["--author", "claude"])).err).toContain("--range");
    expect((await refused([...RANGE, "--question", "docs/notes.md", "--author", "claude"])).err).toContain("one of");
  });

  test("paths for something that is not a range, where they would do nothing", async () => {
    expect((await refused(["--diff", "docs/notes.md", "--author", "claude", "--", "docs"])).err).toContain("--range");
  });

  test("a range without changes", async () => {
    expect((await refused(["--range", "HEAD..HEAD", "--author", "claude"])).err).toContain("empty");
  });

  test("a range git does not know", async () => {
    expect((await refused(["--range", "nope..HEAD", "--author", "claude"])).err).toContain("nope");
  });

  test("a range that is really an option for git", async () => {
    const { folder } = await refused(["--range=--output=stolen.txt", "--author", "claude"]);
    expect(filesIn(folder)).not.toContain("stolen.txt");
  });

  test("a file that is not there", async () => {
    expect((await refused(["--diff", "missing.diff", "--author", "claude"])).err).toContain("missing.diff");
  });

  test("an option that is given twice, because only one of the two would count", async () => {
    expect((await refused([...RANGE, "--range", "HEAD..HEAD", "--author", "claude"])).err).toContain("--range");
  });

  test("a config from the folder under review: it says where the key and the code go", async () => {
    const evil = startFakeProvider(three());
    providers.push(evil);
    const planted = (folder: string) => {
      write(folder, "panel.json", readFileSync(join(homeOf(folder), "config/review-panel/panel.json"), "utf8").replace(/http:[^"]+/u, evil.baseUrl));
      git(folder, "add", "panel.json");
    };
    expect((await refused([...RANGE, "--author", "claude", "--config", "panel.json"], planted)).err).toContain("git tracks");
    expect(evil.requests).toEqual([]);
  });

  test("a misspelled option", async () => {
    expect((await refused([...RANGE, "--author", "claude", "--dryrun"])).err).toContain("--dryrun");
  });

  test("a risk that does not exist", async () => {
    expect((await refused([...RANGE, "--author", "claude", "--risk", "huge"])).err).toContain("huge");
  });

  test("a config that is missing or wrong", async () => {
    expect((await refused([...RANGE, "--author", "claude", "--config", "other.json"])).err).toContain("other.json");
    expect((await refused([...RANGE, "--author", "claude"], undefined, { limits: { maxUSD: 1 } })).err).toContain("maxUSD");
  });

  test("a change that holds something like a key, without repeating it", async () => {
    const value = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    const diff = `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+const k = "${value}";\n`;
    const { err } = await refused(["--diff", "one.diff", "--author", "claude"], (folder) => write(folder, "one.diff", diff));
    expect(err).toContain("an AWS access key on line 5");
    expect(err).not.toContain(value);
  });

  test("a change that holds one of its own keys", async () => {
    const diff = `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+const k = "${KEY}";\n`;
    const { err } = await refused(["--diff", "one.diff", "--author", "claude"], (folder) => write(folder, "one.diff", diff));
    expect(err).toContain("a key from your environment on line 5");
    expect(err).not.toContain(KEY);
  });

  test("a change that cannot be shown as text, because a reviewer would sign for what it did not see", async () => {
    const commit = (name: string, text: string) => (folder: string) => {
      write(folder, name, text);
      git(folder, "add", ".");
      git(folder, "commit", "-q", "-m", "third");
    };
    const hidden = await refused([...RANGE, "--author", "claude"], commit("src/auth.ts", "/*\u0000*/ evil();\n"));
    expect(hidden.err).toContain("src/auth.ts");
    expect(hidden.err).toContain(":(exclude)src/auth.ts");
    const patch = "diff --git a/x.bin b/x.bin\nindex 1..2 100644\nGIT binary patch\nliteral 4\nLcmZQz\n\n";
    expect((await refused(["--diff", "one.diff", "--author", "claude"], (folder) => write(folder, "one.diff", patch))).err).toContain(
      "x.bin",
    );
  });

  test("a change over the size limit: it is never trimmed, because half a change would be signed as a whole one", async () => {
    const { err } = await refused([...RANGE, "--author", "claude"], undefined, { limits: { maxInputBytes: 1000 } });
    expect(err).toContain("1000");
    expect(err).toContain("--");
  });

  test("a change of exactly the size limit is fine", async () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const padded = diff.replace("+new", `+${"n".repeat(1000 - diff.length + 3)}`);
    expect(Buffer.byteLength(padded)).toBe(1000);
    const { folder } = project(three(), { limits: { maxInputBytes: 1000 } });
    write(folder, "one.diff", padded);
    expect((await cli(folder, ["--diff", "one.diff", "--author", "claude"])).exit).toBe(0);
  });

  test("an output folder that already holds something", async () => {
    const { err, folder } = await refused([...RANGE, "--author", "claude", "--out", "old"], (one) =>
      write(one, "old/summary.md", "from another run"),
    );
    expect(err).toContain("old");
    expect(readFileSync(join(folder, "old/summary.md"), "utf8")).toBe("from another run");
  });
});

describe("--dry-run", () => {
  test("shows the plan, writes what would be sent, and sends nothing", async () => {
    const { folder, provider } = project({ ...three(), d: reviews() });
    const { exit, out } = await cli(folder, [...RANGE, "--author", "a", "--dry-run", "--out", "result"]);
    expect(exit).toBe(0);
    expect(provider.requests).toEqual([]);
    expect(out).toContain("medium");
    expect(out).toMatch(/b, c, d/u);
    expect(filesIn(join(folder, "result"))).toEqual(["prompt.txt"]);
  });

  test("shows the worst case of the whole panel against the cap, and who would not fit", async () => {
    const price = (output: number) => ({ input: 0, output });
    const member = (id: string, output: number) => ({
      id,
      lab: `lab-${id}`,
      provider: "main",
      model: id,
      usdPerMillionTokens: price(output),
    });
    const { folder } = project(
      { a: reviews() },
      {
        limits: { maxOutputTokens: 1000, maxUsd: 0.05 },
        reviewers: [member("a", 10), member("b", 60), member("c", 20), member("d", 5)],
      },
    );
    const { out } = await cli(folder, [...RANGE, "--author", "claude", "--dry-run"]);
    expect(out).toContain("If every check passes: a, c, d. Worst case $0.035 of $0.05.");
    expect(out).toContain("not b: over-budget");
  });
});

describe("--help", () => {
  test("explains the options and exits 0", async () => {
    const { folder } = project(three());
    const { exit, out } = await cli(folder, ["--help"]);
    expect(exit).toBe(0);
    for (const option of ["--author", "--range", "--diff", "--question", "--config", "--out", "--risk", "--dry-run"]) {
      expect(out).toContain(option);
    }
  });
});

describe("the folder it runs in", () => {
  /** A command that leaves a mark, with the key in it if it can see one. */
  const plant = (mark: string) => `sh -c 'echo "ran $MAIN_API_KEY" > ${mark}' #`;

  test("cannot run commands through git settings", async () => {
    for (const setting of ["core.fsmonitor", "core.sshCommand", "diff.external", "core.pager"]) {
      const { folder } = project(three());
      const mark = join(homeOf(folder), "mark");
      git(folder, "config", setting, plant(mark));
      expect((await cli(folder, ["--range", "HEAD~1", "--author", "claude"])).exit).toBe(0);
      expect(filesIn(homeOf(folder))).not.toContain("mark");
    }
  });

  test("cannot run commands through a git hook or a git filter", async () => {
    const { folder } = project(three());
    const mark = join(homeOf(folder), "mark");
    write(folder, ".git/hooks/post-index-change", `#!/bin/sh\necho ran > ${mark}\n`);
    chmodSync(join(folder, ".git/hooks/post-index-change"), 0o755);
    write(folder, ".gitattributes", "*.ts filter=planted diff=planted\n");
    git(folder, "config", "filter.planted.clean", plant(mark));
    git(folder, "config", "diff.planted.textconv", plant(mark));
    git(folder, "config", "diff.planted.command", plant(mark));
    write(folder, "src/parse.ts", "changed again\n");
    expect((await cli(folder, ["--range", "HEAD", "--author", "claude"])).exit).toBe(0);
    expect(filesIn(homeOf(folder))).not.toContain("mark");
  });

  test("cannot hide a git repository of its own in a subfolder", async () => {
    const { folder } = project(three());
    const mark = join(homeOf(folder), "mark");
    const inner = join(folder, "packages/api");
    write(inner, "HEAD", "ref: refs/heads/main\n");
    write(inner, "config", `[core]\n\tbare = false\n\tworktree = .\n\tfsmonitor = "${plant(mark).replace(/"/gu, '\\"')}"\n`);
    mkdirSync(join(inner, "objects"), { recursive: true });
    mkdirSync(join(inner, "refs"), { recursive: true });
    const { exit, err } = await cli(folder, ["--range", "HEAD", "--author", "claude"], { cwd: inner });
    expect(exit).toBe(2);
    expect(err).toMatch(/git could not read HEAD: .*not a git repository/iu);
    expect(filesIn(homeOf(folder))).not.toContain("mark");
  });

  test("cannot make git fetch something, which would start a command of its choice", async () => {
    const { folder } = project(three());
    const mark = join(homeOf(folder), "mark");
    const blob = Bun.spawnSync(["git", "-C", folder, "rev-parse", "HEAD:src/parse.ts"], { env: ENV }).stdout.toString().trim();
    rmSync(join(folder, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    git(folder, "config", "core.repositoryFormatVersion", "1");
    git(folder, "config", "extensions.partialClone", "far");
    git(folder, "config", "remote.far.url", "ssh://host/path");
    git(folder, "config", "remote.far.promisor", "true");
    git(folder, "config", "core.sshCommand", plant(mark));
    expect((await cli(folder, [...RANGE, "--author", "claude"])).exit).toBe(2);
    expect(filesIn(homeOf(folder))).not.toContain("mark");
  });

  test("gets no keys through git: they are not in its environment", async () => {
    const { folder } = project(three());
    const bin = join(homeOf(folder), "bin");
    const seen = join(homeOf(folder), "seen");
    write(bin, "git", `#!/bin/sh\nenv >> ${seen}\nPATH="${ENV.PATH}" exec git "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    expect((await cli(folder, [...RANGE, "--author", "claude"], { env: { PATH: `${bin}:${ENV.PATH}` } })).exit).toBe(0);
    const environment = readFileSync(seen, "utf8");
    expect(environment).toContain("PATH=");
    expect(environment).not.toContain(KEY);
  });

  test("cannot hand it keys or run code: its .env and bunfig.toml are not read", async () => {
    const { folder, provider } = project(three());
    write(folder, ".env", "MAIN_API_KEY=from-dot-env-file\n");
    write(folder, "bunfig.toml", 'preload = ["./planted.ts"]\n');
    write(folder, "planted.ts", 'import { writeFileSync } from "node:fs";\nwriteFileSync("planted-ran.txt", "yes");\n');
    const { exit } = await cli(folder, [...RANGE, "--author", "claude"], { env: { MAIN_API_KEY: "" } });
    expect(exit).toBe(3);
    expect(provider.requests).toEqual([]);
    expect(filesIn(folder)).not.toContain("planted-ran.txt");
  });
});
