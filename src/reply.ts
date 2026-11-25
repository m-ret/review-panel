import { isRecord } from "./text.ts";

export type Usage = { inputTokens: number; outputTokens: number };

/** What a chat completion said, put back together from its frames. No judgment here. */
export type Reply = {
  text: string;
  /** Length of the hidden reasoning. It is counted and never shown as an answer. */
  reasoningChars: number;
  finishReason: string | null;
  /** The provider sent its end mark. */
  done: boolean;
  usage: Usage | null;
  error: { code: string | null; message: string } | null;
  /** Frames that held a choice. */
  frames: number;
  /** Frames that could not be read. Each one may have held part of the answer. */
  badFrames: number;
};

export function createReply(): { add(data: string): void; addWhole(body: string): void; result(): Reply } {
  const reply: Reply = {
    text: "",
    reasoningChars: 0,
    finishReason: null,
    done: false,
    usage: null,
    error: null,
    frames: 0,
    badFrames: 0,
  };

  /** Reads one JSON message. Streams put the text in `delta`, whole replies in `message`. */
  function read(json: string, part: "delta" | "message"): void {
    let message: unknown;
    try {
      message = JSON.parse(json);
    } catch {
      reply.badFrames += 1;
      return;
    }
    if (!isRecord(message)) {
      reply.badFrames += 1;
      return;
    }
    reply.error ??= readError(message["error"]);
    reply.usage = readUsage(message["usage"]) ?? reply.usage;
    const choices = message["choices"];
    if (!Array.isArray(choices)) {
      // Usage and pings come without choices. Anything else may be an error in words of its own.
      const isKnown = isRecord(message["usage"]) || message["type"] === "ping" || reply.error !== null;
      if (!isKnown) reply.badFrames += 1;
      return;
    }

    const choice: unknown = choices[0];
    if (!isRecord(choice)) return;
    reply.frames += 1;
    if (typeof choice["finish_reason"] === "string") reply.finishReason = choice["finish_reason"];
    const piece = choice[part];
    if (!isRecord(piece)) return;
    const answer = readContent(piece["content"]);
    if (answer.hasUnknown) reply.badFrames += 1;
    reply.text += answer.text;
    reply.reasoningChars += readContent(piece["reasoning_content"]).text.length + readContent(piece["reasoning"]).text.length;
  }

  return {
    add(data) {
      if (data.trim() === "") return;
      if (data.trim() === "[DONE]") reply.done = true;
      else read(data, "delta");
    },
    addWhole(body) {
      read(body, "message");
      reply.done = reply.frames > 0;
    },
    result: () => reply,
  };
}

/**
 * Content is a string, or a list of parts of which only the text parts are the
 * answer. A part of an unknown kind may be a piece of the answer too.
 */
function readContent(content: unknown): { text: string; hasUnknown: boolean } {
  if (typeof content === "string") return { text: content, hasUnknown: false };
  if (content === undefined || content === null) return { text: "", hasUnknown: false };
  if (!Array.isArray(content)) return { text: "", hasUnknown: true };
  let text = "";
  let hasUnknown = false;
  for (const part of content) {
    const kind = isRecord(part) ? part["type"] : undefined;
    if (isRecord(part) && kind === "text" && typeof part["text"] === "string") text += part["text"];
    else if (kind !== "thinking" && kind !== "reasoning") hasUnknown = true;
  }
  return { text, hasUnknown };
}

function readUsage(usage: unknown): Usage | null {
  if (!isRecord(usage)) return null;
  const inputTokens = usage["prompt_tokens"];
  const outputTokens = usage["completion_tokens"];
  return isCount(inputTokens) && isCount(outputTokens) ? { inputTokens, outputTokens } : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readError(error: unknown): Reply["error"] {
  if (typeof error === "string" && error !== "") return { code: null, message: error };
  if (!isRecord(error)) return null;
  const code = error["code"] ?? error["type"];
  return {
    code: typeof code === "string" || typeof code === "number" ? String(code) : null,
    message: typeof error["message"] === "string" ? error["message"] : "",
  };
}
