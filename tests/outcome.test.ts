import { describe, expect, test } from "bun:test";
import type { Evidence } from "../src/call.ts";
import { judge, transportFailure } from "../src/outcome.ts";

const CODE = "7f3a-91bc";
const SIGNED = "FINDING | major | a.ts:1 | breaks when empty\nSIGN-OFF 7f3a-91bc | 1";

/** A reply that arrived whole and signed; each test changes the one thing it is about. */
function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    ms: 1000,
    status: 200,
    end: "closed",
    refusal: null,
    retryAfter: null,
    text: SIGNED,
    reasoningChars: 0,
    finishReason: "stop",
    done: true,
    usage: { inputTokens: 100, outputTokens: 50 },
    frames: 3,
    badFrames: 0,
    ...over,
  };
}

const diff = (over: Partial<Evidence> = {}) => judge(evidence(over), "diff", CODE);
const question = (over: Partial<Evidence> = {}) => judge(evidence(over), "question", CODE);

describe("judge: what counts as an answer", () => {
  test("a whole, signed review counts, with its findings", () => {
    expect(diff()).toEqual({
      answered: true,
      findings: [{ severity: "major", where: "a.ts:1", what: "breaks when empty" }],
      recommendation: null,
    });
  });

  test("a whole, signed review with no findings counts", () => {
    expect(diff({ text: "I checked a.ts for empty input.\nSIGN-OFF 7f3a-91bc | 0" })).toMatchObject({
      answered: true,
      findings: [],
    });
  });

  test("'none' and '2 findings' are numbers people write", () => {
    expect(diff({ text: "Checked a.ts.\nSIGN-OFF 7f3a-91bc | none" })).toMatchObject({ answered: true });
    expect(diff({ text: SIGNED.replace("| 1", "| 1 finding") })).toMatchObject({ answered: true });
  });

  test("an answer to a question counts with its recommendation", () => {
    expect(question({ text: "Because...\nSIGN-OFF 7f3a-91bc | Use a queue." })).toEqual({
      answered: true,
      findings: [],
      recommendation: "Use a queue.",
    });
  });

  test("an unusual finish reason is fine when the answer is whole and signed", () => {
    expect(diff({ finishReason: "eos_token" })).toMatchObject({ answered: true });
  });

  test("a provider that never sends a finish reason is fine when it sends its end mark", () => {
    expect(diff({ finishReason: null, done: true })).toMatchObject({ answered: true });
  });
});

describe("judge: what does not", () => {
  const reasonOf = (over: Partial<Evidence>) => {
    const outcome = diff(over);
    return outcome.answered ? "answered" : outcome.reason;
  };

  test("no text at all", () => {
    expect(reasonOf({ text: "  \n" })).toBe("empty");
  });

  test("no text because the whole limit went on hidden reasoning, and the detail says so", () => {
    const outcome = diff({ text: "", reasoningChars: 9000, finishReason: "length" });
    expect(outcome).toMatchObject({ answered: false, reason: "empty" });
    expect(JSON.stringify(outcome)).toContain("9000");
  });

  test("cut at the token limit, even if the part that arrived is signed", () => {
    expect(reasonOf({ finishReason: "length" })).toBe("truncated");
    expect(reasonOf({ finishReason: "max_tokens" })).toBe("truncated");
    expect(reasonOf({ finishReason: "model_length" })).toBe("truncated");
  });

  test("a stream that closed before the provider said it was finished, even if what arrived is signed", () => {
    expect(reasonOf({ finishReason: null, done: false })).toBe("truncated");
  });

  test("held back by the provider's filter", () => {
    expect(reasonOf({ finishReason: "content_filter" })).toBe("filtered");
  });

  test("the provider said the generation failed", () => {
    expect(reasonOf({ finishReason: "error" })).toBe("provider-error");
  });

  test("a frame that could not be read may have held part of the answer", () => {
    expect(reasonOf({ badFrames: 1 })).toBe("provider-error");
  });

  test("text that does not end with this run's sign-off", () => {
    expect(reasonOf({ text: "Looks good to me!" })).toBe("unsigned");
    expect(reasonOf({ text: SIGNED.replace(CODE, "0000-0000") })).toBe("unsigned");
  });

  test("signed for a different number of findings than it wrote", () => {
    expect(reasonOf({ text: SIGNED.replace("| 1", "| 0") })).toBe("inconsistent");
    expect(reasonOf({ text: SIGNED.replace("| 1", "| 3") })).toBe("inconsistent");
    expect(reasonOf({ text: "ok\nSIGN-OFF 7f3a-91bc | looks good" })).toBe("inconsistent");
    expect(reasonOf({ text: "ok\nSIGN-OFF 7f3a-91bc | 0.5" })).toBe("inconsistent");
  });

  test("the transport is judged first: a signed text on a refused request is not an answer", () => {
    expect(reasonOf({ status: 500 })).toBe("provider-error");
    expect(reasonOf({ end: "timeout" })).toBe("timeout");
    expect(reasonOf({ refusal: { code: null, note: "overloaded" } })).toBe("provider-error");
  });
});

describe("transportFailure", () => {
  const failure = (over: Partial<Evidence>) => transportFailure(evidence({ text: "", ...over }));
  const refused = (status: number, note = "", code: string | null = null) =>
    failure({ status, refusal: { code, note } })?.reason;

  test("a reply that arrived is not a failure", () => {
    expect(failure({})).toBeNull();
  });

  test("each refusal has its own name, because each needs a different fix", () => {
    expect(refused(401)).toBe("no-access");
    expect(refused(403)).toBe("no-access");
    expect(refused(402)).toBe("out-of-credit");
    expect(refused(429)).toBe("rate-limited");
    expect(refused(404)).toBe("model-not-found");
    expect(refused(410)).toBe("model-not-found");
    expect(refused(400)).toBe("bad-request");
    expect(refused(413)).toBe("bad-request");
    expect(refused(307)).toBe("provider-error");
    expect(refused(500)).toBe("provider-error");
    expect(refused(529)).toBe("provider-error");
  });

  test("a 429 for an empty account is about money, not speed: waiting will not fix it", () => {
    expect(refused(429, "You exceeded your current quota", "insufficient_quota")).toBe("out-of-credit");
    expect(refused(400, "Your credit balance is too low")).toBe("out-of-credit");
    expect(refused(403, "Insufficient balance")).toBe("out-of-credit");
  });

  test("an error inside a stream that started with 200 is read by its code", () => {
    expect(refused(200, "slow down", "429")).toBe("rate-limited");
    expect(refused(200, "slow down", "rate_limit_exceeded")).toBe("rate-limited");
    expect(refused(200, "no money", "insufficient_quota")).toBe("out-of-credit");
    expect(refused(200, "upstream died", "502")).toBe("provider-error");
    expect(refused(200, "something odd")).toBe("provider-error");
  });

  test("the detail keeps the status, the provider's words and how long to wait", () => {
    const detail = failure({ status: 429, refusal: { code: null, note: "Slow down" }, retryAfter: "60" })?.detail;
    expect(detail).toBe("HTTP 429: Slow down (retry after 60)");
  });

  test("a timeout says how long it waited and how much had arrived", () => {
    expect(failure({ end: "timeout", ms: 300_400, text: "half an answer", status: 200 })).toEqual({
      reason: "timeout",
      detail: "no complete reply after 300 s (14 characters had arrived)",
    });
    expect(failure({ end: "timeout", ms: 60_000, status: null })?.detail).toBe("no complete reply after 60 s");
  });

  test("a page that is not a chat completion is a failure, even with status 200", () => {
    expect(failure({ frames: 0 })).toEqual({ reason: "provider-error", detail: "the reply was not a chat completion" });
  });

  test("a reply with a part that could not be read is a failure", () => {
    expect(failure({ badFrames: 2 })).toEqual({
      reason: "provider-error",
      detail: "2 part(s) of the reply could not be read",
    });
  });

  test("a lost connection and a reply that never stops are failures too", () => {
    expect(failure({ end: "network", status: null, refusal: { code: "ECONNREFUSED", note: "ECONNREFUSED" } })).toEqual({
      reason: "network",
      detail: "the connection failed: ECONNREFUSED",
    });
    expect(failure({ end: "too-long" })?.reason).toBe("provider-error");
  });
});
