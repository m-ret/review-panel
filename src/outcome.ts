import { parseFindings, readSignOff, type Finding } from "./answer.ts";
import type { Evidence } from "./call.ts";
import type { Kind } from "./types.ts";

/** Every way a reviewer can fail to answer. Each one needs a different fix, so each has its own name. */
export type NoAnswer =
  | "no-key"
  | "no-access"
  | "out-of-credit"
  | "rate-limited"
  | "model-not-found"
  | "bad-request"
  | "provider-error"
  | "timeout"
  | "network"
  | "empty"
  | "truncated"
  | "filtered"
  | "unsigned"
  | "inconsistent"
  | "over-budget"
  | "internal-error";

export type Failure = { reason: NoAnswer; detail: string };

export type Outcome =
  | { answered: true; findings: Finding[]; recommendation: string | null }
  | ({ answered: false } & Failure);

/** Names that different providers use for "stopped at the token limit". */
const CUT = ["length", "max_tokens", "model_length"];
const NO_CREDIT = /insufficient[_ ](?:quota|balance|funds|credits?)|exceeded your current quota|credit balance is too low/iu;

/** Why no usable reply arrived at all, or null when one did. */
export function transportFailure(evidence: Evidence): Failure | null {
  const { end, status, refusal } = evidence;
  if (end === "timeout") {
    return { reason: "timeout", detail: `no complete reply after ${Math.round(evidence.ms / 1000)} s${soFar(evidence)}` };
  }
  if (end === "network") return { reason: "network", detail: `the connection failed: ${refusal?.note ?? "no details"}` };
  if (end === "too-long") return { reason: "provider-error", detail: "the reply was too long and was stopped" };

  const isSuccess = status !== null && status >= 200 && status < 300;
  if (isSuccess && refusal === null) {
    const { frames, badFrames } = evidence;
    if (badFrames > 0) return { reason: "provider-error", detail: `${badFrames} part(s) of the reply could not be read` };
    return frames > 0 ? null : { reason: "provider-error", detail: "the reply was not a chat completion" };
  }

  // A stream can start with 200 and still carry an error, with a code of its own.
  const code = refusal?.code ?? null;
  const effective = isSuccess ? (/^[45]\d\d$/u.test(code ?? "") ? Number(code) : null) : status;
  const label = isSuccess ? `error inside the reply${code === null ? "" : ` (${code})`}` : `HTTP ${status}`;
  const wait = evidence.retryAfter === null ? "" : `, retry after ${evidence.retryAfter}`;
  const note = refusal?.note ? `: ${refusal.note}` : "";
  return { reason: refusalReason(effective, code ?? "", refusal?.note ?? ""), detail: `${label}${note}${wait}` };
}

function soFar({ text, reasoningChars }: Evidence): string {
  if (text !== "") return `, ${text.length} characters had arrived`;
  return reasoningChars > 0 ? `, only hidden reasoning had arrived, ${reasoningChars} characters` : "";
}

function refusalReason(status: number | null, code: string, note: string): NoAnswer {
  // Money first: some providers report an empty account as 429 or 403.
  if (status === 402 || NO_CREDIT.test(`${code} ${note}`)) return "out-of-credit";
  if (status === 401 || status === 403) return "no-access";
  if (status === 429 || /rate_?limit|too_many_requests/iu.test(code)) return "rate-limited";
  if (status === 404 || status === 410) return "model-not-found";
  if (status !== null && status >= 400 && status < 500) return "bad-request";
  return "provider-error";
}

/**
 * Whether a reviewer answered. An answer has to prove itself: it counts only if
 * it arrived whole and ends with this run's sign-off. There is no list of known
 * bad replies, because a list only catches what was seen before.
 */
export function judge(evidence: Evidence, kind: Kind, code: string): Outcome {
  const no = (reason: NoAnswer, detail: string): Outcome => ({ answered: false, reason, detail });
  const { text, finishReason } = evidence;

  const failure = transportFailure(evidence);
  if (failure) return { answered: false, ...failure };
  if (finishReason === "error") return no("provider-error", "the provider said the generation failed");
  if (finishReason === "content_filter") return no("filtered", "held back by the provider's content filter");
  if (text.trim() === "") {
    return evidence.reasoningChars > 0
      ? no("empty", `only hidden reasoning arrived (${evidence.reasoningChars} characters); raise maxOutputTokens`)
      : no("empty", "the provider sent no text");
  }
  if (CUT.includes(finishReason ?? "")) return no("truncated", "stopped at the token limit");
  if (finishReason === null && !evidence.done) {
    return no("truncated", "the stream closed before the provider said it was finished");
  }

  const signOff = readSignOff(text, code);
  if (signOff === null) return no("unsigned", "the last line is not this run's sign-off");
  if (kind === "question") return { answered: true, findings: [], recommendation: signOff };

  const findings = parseFindings(text);
  const signed = countIn(signOff);
  if (signed === null) return no("inconsistent", "the sign-off does not say how many findings there are");
  if (signed !== findings.length) return no("inconsistent", `signed for ${signed} findings, wrote ${findings.length}`);
  return { answered: true, findings, recommendation: null };
}

/** The number of findings, and nothing else: "2", "2 findings", "none". */
function countIn(signOff: string): number | null {
  if (/^(?:none|no findings?)\.?$/iu.test(signOff)) return 0;
  const digits = /^(\d+)(?:\s+findings?)?\.?$/iu.exec(signOff)?.[1];
  return digits === undefined ? null : Number(digits);
}
