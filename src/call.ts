import type { Usage } from "./reply.ts";

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
