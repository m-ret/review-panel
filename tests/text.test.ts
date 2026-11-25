import { describe, expect, test } from "bun:test";
import { fenced, oneLine, providerNote, stripControls, tableCell } from "../src/text.ts";

describe("stripControls", () => {
  test("removes terminal color codes so a reply cannot restyle the console", () => {
    expect(stripControls("\u001b[31mred\u001b[0m text")).toBe("red text");
  });

  test("removes a window-title sequence, text and all", () => {
    expect(stripControls("a\u001b]0;owned\u0007b")).toBe("ab");
  });

  test("an unfinished title sequence cannot swallow the lines after it", () => {
    expect(stripControls("a\u001b]0;open\nSIGN-OFF")).toBe("a\nSIGN-OFF");
  });

  test("removes direction overrides that make code read differently from what it is", () => {
    expect(stripControls("if (admin‮⁦) {")).toBe("if (admin) {");
  });

  test("keeps line breaks and tabs, which answers need", () => {
    expect(stripControls("a\n\tb")).toBe("a\n\tb");
  });

  test("turns carriage returns into line breaks so nothing can overwrite a printed line", () => {
    expect(stripControls("safe\rEVIL\r\nnext")).toBe("safe\nEVIL\nnext");
  });
});

describe("oneLine", () => {
  test("collapses whitespace and cuts long text with a mark", () => {
    expect(oneLine("  a \n\n b\t c ")).toBe("a b c");
    expect(oneLine("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("text that exactly fits is not cut", () => {
    expect(oneLine("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("providerNote", () => {
  test("reads the message out of an OpenAI-style error body", () => {
    const body = JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } });
    expect(providerNote(body, [])).toBe("Rate limit reached");
  });

  test("reads the detail out of an error body that uses other names", () => {
    expect(providerNote(JSON.stringify({ status: 404, title: "Not Found", detail: "No such model" }), [])).toBe(
      "No such model",
    );
  });

  test("hides the account id a provider puts in its error text", () => {
    const body = JSON.stringify({
      status: 404,
      detail:
        "Function '0f0e1d2c-3b4a-4958-8776-655443322110': Not found for account 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f'",
    });
    expect(providerNote(body, [])).toBe("Function '[id]': Not found for account '[id]'");
  });

  test("hides a configured key even when it is short and plain", () => {
    expect(providerNote("bad key hunter2hunter2 given", ["hunter2hunter2"])).toBe("bad key [key] given");
  });

  test("hides an email address", () => {
    expect(providerNote("user someone@example.com is blocked", [])).toBe("user [email] is blocked");
  });

  test("keeps ordinary words, codes and model names readable", () => {
    expect(providerNote("invalid_request_error: max_tokens too high for nemotron-3-ultra-550b-a55b", [])).toBe(
      "invalid_request_error: max_tokens too high for nemotron-3-ultra-550b-a55b",
    );
  });

  test("an HTML error page becomes one short line", () => {
    const note = providerNote(`<html>\n<body>502 Bad Gateway</body>${"x ".repeat(500)}</html>`, []);
    expect(note).not.toContain("\n");
    expect(note.length).toBeLessThanOrEqual(200);
  });

  test("hides a key that the provider wrote with an invisible character inside", () => {
    const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    expect(providerNote(`bad key ${key.slice(0, 8)}\u200b${key.slice(8)}`, [key])).toBe("bad key [key]");
  });

  test("hides a key whose slashes came back escaped", () => {
    expect(providerNote('{"errors":["abc\\/def+ghi\\/jkl="]}', ["abc/def+ghi/jkl="])).not.toContain("def+ghi");
  });

  test("hides a long run of lower-case letters and digits, which may be a key of any kind", () => {
    expect(providerNote("token 0f1e2d3c4b5a69788796a5b4c3d2e1f0a9 is wrong", [])).toBe("token [id] is wrong");
  });

  test("a very long message is cut before it is searched, so it cannot hold the run up", () => {
    const started = performance.now();
    expect(providerNote("a".repeat(300_000), []).length).toBeLessThanOrEqual(200);
    expect(providerNote(`${"a@".repeat(150_000)}`, []).length).toBeLessThanOrEqual(200);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("an empty secret never blanks the whole message", () => {
    expect(providerNote("plain", [""])).toBe("plain");
  });
});

describe("fenced", () => {
  test("the fence is longer than any run of backticks inside, so the text cannot close it", () => {
    const inside = "```js\ncode\n```\n````\nmore";
    const out = fenced(inside);
    expect(out.startsWith("`````text\n")).toBe(true);
    expect(out.endsWith("\n`````")).toBe(true);
    expect(out).toContain(inside);
  });

  test("a plain text gets the usual three-backtick fence", () => {
    expect(fenced("hello")).toBe("```text\nhello\n```");
  });
});

describe("tableCell", () => {
  test("text with bars, images and HTML stays inside one table cell and renders as text", () => {
    expect(tableCell("a | b ![x](http://e/x.png) <img src=x>")).toBe(
      "a \\| b !\\[x\\](http://e/x.png) \\<img src=x\\>",
    );
  });

  test("a line break cannot start a new table row", () => {
    expect(tableCell("a\n| forged | row |")).toBe("a \\| forged \\| row \\|");
  });
});
