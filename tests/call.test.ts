import { afterEach, describe, expect, test } from "bun:test";
import {
  type Behavior,
  type FakeProvider,
  frame,
  refuses,
  says,
  sse,
  startFakeProvider,
  stream,
  usageFrame,
} from "../demo/fake-provider.ts";
import { callModel, type Target } from "../src/call.ts";

const open: FakeProvider[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((provider) => provider.stop()));
});

function provide(behavior: Behavior): FakeProvider {
  const provider = startFakeProvider({ m: behavior });
  open.push(provider);
  return provider;
}

const KEY = "test-key-not-real";
/** Looks like a review request, so the stand-in does not take it for a check. */
const PROMPT = "=====BEGIN 00=====\nthe prompt";
const target = (provider: FakeProvider, over: Partial<Target> = {}): Target => ({
  baseUrl: provider.baseUrl,
  key: KEY,
  model: "m",
  maxTokensParam: "max_tokens",
  streamUsage: true,
  ...over,
});

async function call(behavior: Behavior, over: Partial<Target> & { timeoutMs?: number; maxReplyBytes?: number } = {}) {
  const { timeoutMs = 5000, maxReplyBytes = 1_000_000, ...rest } = over;
  const provider = provide(behavior);
  const evidence = await callModel(target(provider, rest), PROMPT, {
    maxOutputTokens: 500,
    timeoutMs,
    maxReplyBytes,
    secrets: [KEY],
  });
  return { provider, evidence };
}

describe("callModel: the request", () => {
  test("is the one an OpenAI-compatible endpoint expects", async () => {
    const { provider } = await call(says("hello"));
    expect(provider.requests).toHaveLength(1);
    const { headers, body } = provider.requests[0]!;
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toContain("application/json");
    expect(body).toEqual({
      model: "m",
      messages: [{ role: "user", content: PROMPT }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 500,
    });
  });

  test("uses the other name for the token limit when the config says so", async () => {
    const { provider } = await call(says("hello"), { maxTokensParam: "max_completion_tokens" });
    expect(provider.requests[0]!.body).toMatchObject({ max_completion_tokens: 500 });
    expect(provider.requests[0]!.body).not.toHaveProperty("max_tokens");
  });

  test("leaves out stream_options when the config says so", async () => {
    const { provider } = await call(says("hello"), { streamUsage: false });
    expect(provider.requests[0]!.body).not.toHaveProperty("stream_options");
  });

  test("sends no authorization header when no key is needed", async () => {
    const { provider } = await call(says("hello"), { key: null });
    expect(provider.requests[0]!.headers.get("authorization")).toBeNull();
  });
});

describe("callModel: the reply", () => {
  test("is put together from the stream, with its finish reason and usage", async () => {
    const { evidence } = await call(says("hello from the model", { input: 11, output: 7 }));
    expect(evidence).toMatchObject({
      status: 200,
      end: "closed",
      text: "hello from the model",
      finishReason: "stop",
      done: true,
      usage: { inputTokens: 11, outputTokens: 7 },
      refusal: null,
      badFrames: 0,
    });
  });

  test("survives a character that the network split in two", async () => {
    const bytes = new TextEncoder().encode(frame("m", { content: "café ✓" }) + frame("m", {}, "stop") + sse("[DONE]"));
    const middle = bytes.indexOf(0xc3) + 1; // inside the é
    const { evidence } = await call(() => stream([bytes.slice(0, middle), 20, bytes.slice(middle)]));
    expect(evidence.text).toBe("café ✓");
  });

  test("is read even from a server that answers all at once instead of streaming", async () => {
    const whole = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "all at once" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
    const { evidence } = await call(() => Response.json(whole));
    expect(evidence).toMatchObject({ text: "all at once", finishReason: "stop", done: true, badFrames: 0 });
  });

  test("ends at the end mark, even if the server keeps the connection open", async () => {
    const started = performance.now();
    const { evidence } = await call(() => stream([frame("m", { content: "x" }, "stop"), sse("[DONE]"), 3000]));
    expect(evidence).toMatchObject({ end: "closed", text: "x", done: true });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("has terminal codes removed from its text", async () => {
    const { evidence } = await call(says("\u001b[2Jwiped‮"));
    expect(evidence.text).toBe("wiped");
  });

  test("a stream that just closes is reported as not done", async () => {
    const { evidence } = await call(() => stream([frame("m", { content: "half an ans" })]));
    expect(evidence).toMatchObject({ end: "closed", text: "half an ans", done: false, finishReason: null });
  });

  test("a web page instead of a completion has no frames", async () => {
    const { evidence } = await call(
      () => new Response("<html>maintenance</html>", { headers: { "content-type": "text/html" } }),
    );
    expect(evidence).toMatchObject({ status: 200, frames: 0, text: "" });
  });
});

describe("callModel: when it goes wrong", () => {
  test("a refusal keeps the status, the provider's words and how long to wait", async () => {
    const { evidence } = await call(
      refuses(429, { error: { message: "Slow down", code: "rate_limit_exceeded" } }, { "retry-after": "60" }),
    );
    expect(evidence).toMatchObject({
      status: 429,
      refusal: { code: "rate_limit_exceeded", note: "Slow down" },
      retryAfter: "60",
      text: "",
    });
  });

  test("a key repeated by the provider does not get through", async () => {
    const { evidence } = await call(refuses(401, { error: { message: `Incorrect API key provided: ${KEY}` } }));
    expect(evidence.refusal?.note).toBe("Incorrect API key provided: [key]");
    expect(JSON.stringify(evidence)).not.toContain(KEY);
  });

  test("a key that a gateway repeats inside an answer does not get through either", async () => {
    const { evidence } = await call(() =>
      stream([frame("m", { content: `you sent Bearer ${KEY.slice(0, 5)}` }), frame("m", { content: KEY.slice(5) }, KEY), sse("[DONE]")]),
    );
    expect(evidence.text).toBe("you sent Bearer [key]");
    expect(JSON.stringify(evidence)).not.toContain(KEY);
  });

  test("an error inside a good stream is a refusal, and its words are cleaned too", async () => {
    const { evidence } = await call(() =>
      stream([frame("m", { content: "par" }), sse({ error: { code: 429, message: `limit for ${KEY}` } }), sse("[DONE]")]),
    );
    expect(evidence).toMatchObject({ status: 200, refusal: { code: "429", note: "limit for [key]" }, text: "par" });
  });

  test("a redirect is not followed, so the key and the diff never reach another address", async () => {
    const elsewhere = provide(says("stolen"));
    const { evidence } = await call(
      () => new Response(null, { status: 307, headers: { location: `${elsewhere.baseUrl}/chat/completions` } }),
    );
    expect(elsewhere.requests).toHaveLength(0);
    expect(evidence).toMatchObject({ status: 307, text: "" });
  });

  test("a provider that never responds is stopped at the time limit", async () => {
    const { evidence } = await call(
      async () => {
        await Bun.sleep(3000);
        return new Response("late");
      },
      { timeoutMs: 150 },
    );
    expect(evidence).toMatchObject({ end: "timeout", status: null, text: "" });
    expect(evidence.ms).toBeGreaterThanOrEqual(140);
    expect(evidence.ms).toBeLessThan(1500);
  });

  test("a provider that stops half way is stopped at the time limit, and what arrived is kept", async () => {
    const { evidence } = await call(() => stream([frame("m", { content: "first half" }), 3000]), { timeoutMs: 200 });
    expect(evidence).toMatchObject({ end: "timeout", status: 200, text: "first half" });
  });

  test("a refusal whose body never ends is stopped at the time limit too", async () => {
    const { evidence } = await call(
      () => new Response(stream(['{"error":', 3000]).body, { status: 500 }),
      { timeoutMs: 200 },
    );
    expect(evidence).toMatchObject({ end: "timeout", status: 500 });
  });

  test("a closed door is a network failure with its code", async () => {
    const provider = provide(says("x"));
    await provider.stop();
    const evidence = await callModel(target(provider), "p", {
      maxOutputTokens: 1,
      timeoutMs: 2000,
      secrets: [],
    });
    expect(evidence).toMatchObject({ end: "network", status: null, refusal: { code: "ECONNREFUSED" } });
  });

  test("a reply that never stops is cut off", async () => {
    const part = frame("m", { content: "y".repeat(1000) });
    const { evidence } = await call(() => stream(Array.from({ length: 200 }, () => part)), { maxReplyBytes: 20_000 });
    expect(evidence.end).toBe("too-long");
    expect(evidence.text.length).toBeLessThan(40_000);
  });

  test("a long answer in many small pieces is fine: the limit on bytes grows with the limit on tokens", async () => {
    // One token to a frame, a few hundred bytes around each, as real providers send them.
    const one = frame("m", { reasoning_content: "x", padding: "p".repeat(300) });
    const ending = [frame("m", { content: "done" }, "stop"), sse("[DONE]")];
    const ask = (tokens: number, maxOutputTokens: number) =>
      callModel(target(provide(() => stream([one.repeat(tokens), ...ending]))), PROMPT, {
        maxOutputTokens,
        timeoutMs: 5000,
        secrets: [],
      });
    expect(await ask(8000, 8000)).toMatchObject({ end: "closed", text: "done" });
    expect((await ask(8000, 500)).end).toBe("too-long");
  });

  test("a whole reply that is too long is cut off too", async () => {
    const whole = { choices: [{ message: { content: "y".repeat(50_000) }, finish_reason: "stop" }] };
    const { evidence } = await call(() => Response.json(whole), { maxReplyBytes: 20_000 });
    expect(evidence).toMatchObject({ end: "too-long", text: "" });
  });

  /** Runs one call in a process of its own, with environment variables that Bun reads when it starts. */
  async function callIn(env: Record<string, string>, provider: FakeProvider, timeoutMs: number) {
    const script = `
      import { callModel } from ${JSON.stringify(new URL("../src/call.ts", import.meta.url).pathname)};
      const target = ${JSON.stringify(target(provider))};
      const evidence = await callModel(target, "p", { maxOutputTokens: 5, timeoutMs: ${timeoutMs}, secrets: [target.key] });
      console.log(evidence.end, evidence.text);
    `;
    const child = Bun.spawn(["bun", "-e", script], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { out: out.trim(), err };
  }

  test("a server on this machine is asked directly, even when a proxy is set: the proxy would get the key in the clear", async () => {
    const seen: string[] = [];
    const proxy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(request.headers.get("authorization") ?? "");
        return new Response("from the proxy", { status: 502 });
      },
    });
    const address = `http://127.0.0.1:${proxy.port}`;
    const provider = provide(says("direct"));
    const { out } = await callIn({ HTTP_PROXY: address, http_proxy: address, ALL_PROXY: address }, provider, 5000);
    await proxy.stop(true);
    expect(seen).toEqual([]);
    expect(out).toBe("closed ready");
    expect(provider.requests).toHaveLength(1);
  });

  test("the key is not printed when Bun is told to print every request", async () => {
    const { out, err } = await callIn({ BUN_CONFIG_VERBOSE_FETCH: "curl" }, provide(says("x")), 5000);
    expect(out).toStartWith("closed");
    expect(out + err).not.toContain(KEY);
  });

  test("a model that is silent for longer than Bun's own idle limit is not cut off by it", async () => {
    // The limit is five minutes by default. Here it is set to its shortest, about eight seconds.
    const provider = provide(() => stream([9500, frame("m", { content: "slow but fine" }, "stop"), sse("[DONE]")]));
    const { out } = await callIn({ BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" }, provider, 20_000);
    expect(out).toBe("closed slow but fine");
  }, 20_000);

  test("a key that cannot be sent in a header fails as a call, and is not printed", async () => {
    const bad = "bad\nkey-value";
    const provider = provide(says("x"));
    const evidence = await callModel(target(provider, { key: bad }), "p", {
      maxOutputTokens: 1,
      timeoutMs: 2000,
      secrets: [bad],
    });
    expect(evidence.end).toBe("network");
    expect(JSON.stringify(evidence)).not.toContain("key-value");
    expect(provider.requests).toHaveLength(0);
  });

  test("usage that arrives after the finish reason is kept", async () => {
    const { evidence } = await call(() => stream([frame("m", { content: "x" }, "stop"), usageFrame("m", 5, 6), sse("[DONE]")]));
    expect(evidence.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });
});
