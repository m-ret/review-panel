import { createReply, type Usage } from "./reply.ts";
import { createSseReader } from "./sse.ts";
import { providerNote, stripControls, withoutKeys } from "./text.ts";

/** What happened on the wire, cleaned and without any judgement. `outcome.ts` judges it. */
export type Evidence = {
  ms: number;
  /** Null when no response arrived. */
  status: number | null;
  end: "closed" | "timeout" | "network" | "too-long";
  /** The provider's own words when it refused, already cleaned. */
  refusal: { code: string | null; note: string } | null;
  retryAfter: string | null;
  text: string;
  reasoningChars: number;
  finishReason: string | null;
  done: boolean;
  usage: Usage | null;
  frames: number;
  badFrames: number;
};

export type Target = {
  baseUrl: string;
  key: string | null;
  model: string;
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  streamUsage: boolean;
};

const MAX_REPLY_BYTES = 5_000_000;
const MAX_REFUSAL_BYTES = 50_000;

/**
 * One request to one model. It never throws: whatever happens comes back as
 * evidence, so one broken provider cannot take the other reviewers down.
 */
export async function callModel(
  target: Target,
  prompt: string,
  options: { maxOutputTokens: number; timeoutMs: number; secrets: readonly string[]; maxReplyBytes?: number },
): Promise<Evidence> {
  const started = performance.now();
  const reply = createReply();
  let status: number | null = null;
  let retryAfter: string | null = null;
  let end: Evidence["end"] = "closed";
  let refusal: { code: string | null; body: string } | null = null;

  try {
    const response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target.key === null ? {} : { authorization: `Bearer ${target.key}` }),
      },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        ...(target.streamUsage ? { stream_options: { include_usage: true } } : {}),
        [target.maxTokensParam]: options.maxOutputTokens,
      }),
      // A redirect would carry the key and the diff to an address nobody configured.
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
      // Bun gives up on a silent connection after five minutes; the line above is the only clock here.
      timeout: false,
    });
    status = response.status;
    retryAfter = response.headers.get("retry-after");

    if (!response.ok) {
      const body: string[] = [];
      await readText(response, MAX_REFUSAL_BYTES, (text) => body.push(text));
      const parsed = createReply();
      parsed.addWhole(body.join(""));
      refusal = { code: parsed.result().error?.code ?? null, body: body.join("") };
    } else if (response.headers.get("content-type")?.includes("json")) {
      const body: string[] = [];
      end = await readText(response, options.maxReplyBytes ?? MAX_REPLY_BYTES, (text) => body.push(text));
      reply.addWhole(body.join(""));
    } else {
      const reader = createSseReader((data) => reply.add(data));
      end = await readText(response, options.maxReplyBytes ?? MAX_REPLY_BYTES, (text) => {
        reader.push(text);
        return reply.result().done;
      });
      reader.end();
    }
  } catch (error) {
    end = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    // Only the code or the kind of error: the message can quote the headers, and the key is one.
    if (end === "network") refusal = { code: codeOf(error), body: codeOf(error) };
  }

  // Everything below came from outside, so it is cleaned here, once, at the door.
  const note = (words: string | null) => words && providerNote(words, options.secrets);
  const { text, error, finishReason, ...counts } = reply.result();
  if (error) refusal ??= { code: error.code, body: error.message };
  return {
    ...counts,
    ms: Math.round(performance.now() - started),
    status,
    end,
    refusal: refusal && { code: note(refusal.code), note: note(refusal.body) ?? "" },
    retryAfter: note(retryAfter),
    text: withoutKeys(stripControls(text), options.secrets),
    finishReason: note(finishReason),
  };
}

/** Reads a body as text until it closes, `onText` says it has enough, or it passes the size limit. */
async function readText(
  response: Response,
  maxBytes: number,
  onText: (text: string) => unknown,
): Promise<"closed" | "too-long"> {
  const decoder = new TextDecoder();
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) return "too-long";
    if (onText(decoder.decode(chunk, { stream: true })) === true) return "closed";
  }
  onText(decoder.decode());
  return "closed";
}

function codeOf(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}
