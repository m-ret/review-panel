export type ChangedFile = {
  path: string;
  /** The name before the change; null when the file is new. */
  oldPath: string | null;
  added: number;
  removed: number;
  addedText: string;
};

export type ParsedDiff = {
  files: ChangedFile[];
  /** Why the diff could not be read all the way, or null. */
  problem: string | null;
};

/**
 * Reads a unified diff far enough to know which files changed and by how much.
 *
 * The line counts in each hunk header are followed exactly. That matters: a
 * removed SQL comment prints as "--- text" and an added "++ text" prints as
 * "+++ text", so without counting, the content of a file could invent or hide
 * the name of another one.
 */
export function parseDiff(text: string): ParsedDiff {
  const files: ChangedFile[] = [];
  let file: ChangedFile | null = null;
  /** True between "diff --git" and the first hunk, where "---" and "+++" name this same file. */
  let inHeader = false;
  let oldName: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let problem: string | null = null;

  const start = (path: string, oldPath: string | null): ChangedFile => {
    const next = { path, oldPath, added: 0, removed: 0, addedText: "" };
    files.push(next);
    return next;
  };

  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();

  for (const [index, line] of lines.entries()) {
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0] ?? " ";
      if (mark === "\\") continue;
      if (mark === "+" || mark === " ") newLeft -= 1;
      if (mark === "-" || mark === " ") oldLeft -= 1;
      if (!"+- ".includes(mark) || newLeft < 0 || oldLeft < 0) {
        problem ??= `line ${index + 1} does not fit the hunk it is in`;
        oldLeft = 0;
        newLeft = 0;
        continue;
      }
      if (mark === "+" && file) {
        file.added += 1;
        file.addedText += `${line.slice(1)}\n`;
      }
      if (mark === "-" && file) file.removed += 1;
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const path = pathFromGitHeader(line.slice("diff --git ".length));
      file = start(path, path);
      inHeader = true;
    } else if (/^diff --(?:cc|combined) /u.test(line) || line.startsWith("@@@")) {
      problem ??= "merge diffs are not supported";
      if (line.startsWith("diff")) {
        file = start(line.replace(/^diff --\w+ /u, ""), null);
        inHeader = true;
      }
    } else if (line.startsWith("new file mode") && file) {
      file.oldPath = null;
    } else if (/^(?:rename|copy) from /u.test(line) && file) {
      file.oldPath = unquote(line.replace(/^\w+ from /u, ""));
    } else if (/^(?:rename|copy) to /u.test(line) && file) {
      file.path = unquote(line.replace(/^\w+ to /u, ""));
    } else if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      oldName = headerPath(line);
    } else if (line.startsWith("+++ ") && lines[index - 1]?.startsWith("--- ")) {
      const [oldPath, path] = withoutPrefixes(oldName, headerPath(line));
      if (!file || !inHeader) file = start("", null);
      file.oldPath = oldPath;
      file.path = path ?? oldPath ?? "";
      inHeader = false;
    } else if (line.startsWith("@@ ")) {
      const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
      if (!counts) {
        problem ??= `line ${index + 1} is not a hunk header`;
        continue;
      }
      if (!file) problem ??= `the hunk on line ${index + 1} has no file above it`;
      oldLeft = Number(counts[1] ?? 1);
      newLeft = Number(counts[2] ?? 1);
      inHeader = false;
    }
  }

  if (oldLeft > 0 || newLeft > 0) problem ??= "the diff stops in the middle of a hunk";
  if (files.length === 0) problem ??= "no changed file found";
  return { files, problem };
}

/** The path on a "--- " or "+++ " line; null for /dev/null. Plain diffs put a date after a tab. */
function headerPath(line: string): string | null {
  const path = unquote((line.slice(4).split("\t")[0] ?? "").trimEnd());
  return path === "/dev/null" ? null : path;
}

/** Drops git's "a/" and "b/", but only when both sides have them. */
function withoutPrefixes(oldPath: string | null, newPath: string | null): [string | null, string | null] {
  const isGit = (oldPath?.startsWith("a/") ?? true) && (newPath?.startsWith("b/") ?? true);
  return isGit ? [oldPath?.slice(2) ?? null, newPath?.slice(2) ?? null] : [oldPath, newPath];
}

/** "a/x b/x". The two halves are equal unless the file was renamed, and then the rename lines name it. */
function pathFromGitHeader(rest: string): string {
  const quoted = /^"(?:[^"\\]|\\.)*"/u.exec(rest)?.[0];
  if (quoted !== undefined) return unquote(quoted).replace(/^a\//u, "");
  const length = (rest.length - "a/ b/".length) / 2;
  const path = rest.slice(2, 2 + length);
  return rest === `a/${path} b/${path}` ? path : rest;
}

/** Undoes git's quoting of unusual paths: "caf\303\251" is café. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  for (const part of body.match(/\\[0-7]{3}|\\.|[^\\]+/gsu) ?? []) {
    if (/^\\[0-7]{3}$/u.test(part)) bytes.push(Number.parseInt(part.slice(1), 8));
    else bytes.push(...Buffer.from(part.startsWith("\\") ? unescape(part) : part));
  }
  return Buffer.from(bytes).toString("utf8");
}

function unescape(part: string): string {
  return { "\\n": "\n", "\\t": "\t", "\\r": "\r" }[part] ?? part.slice(1);
}
