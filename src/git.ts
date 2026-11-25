/**
 * Git, run so that neither the folder under review nor anyone's settings decide
 * what it prints or what it starts. A repository can name commands in its own
 * settings (a file watcher, an ssh command, a filter), and a pull request can
 * even carry a whole repository inside a folder.
 */
const ALWAYS = [
  "--no-pager",
  ...["-c", "core.quotePath=false"],
  ...["-c", "core.fsmonitor=false"],
  ...["-c", "core.hooksPath=/dev/null"],
  ...["-c", "safe.bareRepository=explicit"],
];

export type GitResult = { exit: number; out: string; problem: string };

export function runGit(args: readonly string[]): GitResult {
  try {
    const done = Bun.spawnSync(["git", ...ALWAYS, ...args], {
      // Only what git needs. The keys of the providers are not here.
      env: {
        PATH: process.env["PATH"] ?? "",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { exit: done.exitCode, out: done.stdout.toString(), problem: done.stderr.toString() };
  } catch {
    return { exit: -1, out: "", problem: "git could not be started" };
  }
}
