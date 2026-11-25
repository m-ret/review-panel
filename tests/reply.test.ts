import { describe, expect, test } from "bun:test";
import { createReply } from "../src/reply.ts";

const frame = (choice: object, extra: object = {}) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, finish_reason: null, logprobs: null, ...choice }],
    ...extra,
  });

function collect(...frames: string[]) {
  const reply = createReply();
  for (const data of frames) reply.add(data);
  return reply.result();
}

describe("createReply", () => {
  test("puts the answer together and keeps the finish reason, the usage and the end mark", () => {
    const reply = collect(
      frame({ delta: { role: "assistant", content: "Hel" } }),
      frame({ delta: { content: "lo" } }),
      frame({ delta: {}, finish_reason: "stop" }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 49, completion_tokens: 3, total_tokens: 52 } }),
      "[DONE]",
    );
    expect(reply).toMatchObject({
      text: "Hello",
      finishReason: "stop",
      done: true,
      usage: { inputTokens: 49, outputTokens: 3 },
      error: null,
      badFrames: 0,
    });
  });

  test("hidden reasoning is counted but never becomes part of the answer", () => {
    const reply = collect(
      frame({ delta: { reasoning_content: "thinking" } }),
      frame({ delta: { reasoning: "more" } }),
      // One provider sends the last piece of reasoning and the answer in the same frame.
      frame({ delta: { content: "ready", reasoning_content: '".' }, finish_reason: "stop" }),
    );
    expect(reply.text).toBe("ready");
    expect(reply.reasoningChars).toBe("thinking".length + "more".length + 2);
  });

  test("an answer sent as a list of parts keeps the text parts and leaves the thinking parts out", () => {
    const reply = collect(
      frame({
        delta: {
          content: [
            { type: "thinking", thinking: [{ type: "text", text: "hmm" }] },
            { type: "text", text: "yes" },
          ],
        },
      }),
    );
    expect(reply.text).toBe("yes");
  });

  test("an answer cut by the token limit keeps the finish reason that says so", () => {
    const reply = collect(frame({ delta: { reasoning_content: "is" }, finish_reason: "length" }), "[DONE]");
    expect(reply.text).toBe("");
    expect(reply.finishReason).toBe("length");
  });

  test("a later frame without a finish reason does not erase the one already seen", () => {
    const reply = collect(frame({ delta: {}, finish_reason: "length" }), frame({ delta: {} }));
    expect(reply.finishReason).toBe("length");
  });

  test("an error sent inside a stream that started well is kept", () => {
    const reply = collect(
      frame({ delta: { content: "partial" } }),
      JSON.stringify({ error: { code: 429, message: "upstream rate limit" } }),
    );
    expect(reply.text).toBe("partial");
    expect(reply.error).toEqual({ code: "429", message: "upstream rate limit" });
  });

  test("an error given as a plain string is kept too", () => {
    expect(collect(JSON.stringify({ error: "overloaded" })).error).toEqual({ code: null, message: "overloaded" });
  });

  test("a frame that is not JSON is counted, because it may have held part of the answer", () => {
    const reply = collect(frame({ delta: { content: "a" } }), '{"choices":[{"delta":{"con', frame({ delta: { content: "b" } }));
    expect(reply.badFrames).toBe(1);
  });

  test("a frame that says something else than a choice is counted, because it may be an error in other words", () => {
    for (const odd of [{ object: "error", message: "engine died", code: 500 }, { detail: "gone" }, "text", 42, null, []]) {
      expect(collect(frame({ delta: { content: "a" } }), JSON.stringify(odd))).toMatchObject({ text: "a", badFrames: 1 });
    }
  });

  test("a part of the answer of an unknown kind is counted, because the text may have a hole there", () => {
    const content = [{ type: "text", text: "Do " }, { type: "output_text", text: "not " }, { type: "text", text: "do it." }];
    expect(collect(frame({ delta: { content } })).badFrames).toBe(1);
    expect(collect(frame({ delta: { content: { text: "odd" } } })).badFrames).toBe(1);
  });

  test("frames with no choices that providers do send are fine: usage, and a list of choices that is empty", () => {
    const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    expect(collect(JSON.stringify({ usage }), JSON.stringify({ choices: [], prompt_filter_results: [] }))).toMatchObject({
      badFrames: 0,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  test("empty keep-alive data and pings are not errors", () => {
    const reply = collect("", JSON.stringify({ type: "ping" }), frame({ delta: { content: "a" } }));
    expect(reply).toMatchObject({ text: "a", badFrames: 0, frames: 1 });
  });

  test("usage that is not a pair of whole, non-negative numbers is ignored, so it cannot make a call look free", () => {
    for (const usage of [
      null,
      { prompt_tokens: -1, completion_tokens: 3 },
      { prompt_tokens: 1.5, completion_tokens: 3 },
      { prompt_tokens: "49", completion_tokens: 3 },
      { prompt_tokens: 49 },
    ]) {
      expect(collect(JSON.stringify({ choices: [], usage })).usage).toBeNull();
    }
  });

  test("usage of zero is a number like any other", () => {
    const usage = { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 };
    expect(collect(JSON.stringify({ choices: [], usage })).usage).toEqual({ inputTokens: 5, outputTokens: 0 });
  });

  test("parts of an odd shape are counted, not a crash", () => {
    const content = [null, "bare", 7, { type: "text" }, { text: "no type" }, { type: "text", text: "yes" }];
    expect(collect(frame({ delta: { content } }))).toMatchObject({ text: "yes", badFrames: 1 });
  });

  test("reads a whole completion sent at once by a server that does not stream", () => {
    const reply = createReply();
    reply.addWhole(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    expect(reply.result()).toMatchObject({
      text: "Hi",
      finishReason: "stop",
      done: true,
      frames: 1,
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  test("a whole body that is not JSON is a bad frame, not an answer", () => {
    const reply = createReply();
    reply.addWhole("<html>maintenance</html>");
    expect(reply.result()).toMatchObject({ text: "", badFrames: 1, frames: 0, done: false });
  });
});
