// A local stand-in for an OpenAI-compatible provider. The tests and the demo
// run the real code against it, over real HTTP. Each model gets a behavior.
// The frames have the shape that real providers sent on 2026-11-24.

export type ModelRequest = {
  model: string;
  prompt: string;
  /** The tiny request sent before the panel starts. */
  isCheck: boolean;
  headers: Headers;
  body: Record<string, unknown>;
};

export type Behavior = (request: ModelRequest) => Response | Promise<Response>;

export type FakeProvider = { baseUrl: string; requests: ModelRequest[]; stop(): Promise<void> };

export function startFakeProvider(models: Record<string, Behavior>): FakeProvider {
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as Record<string, unknown> & { messages: { content: string }[] };
      const prompt = body.messages[0]?.content ?? "";
      const seen: ModelRequest = {
        model: String(body["model"]),
        prompt,
        isCheck: !prompt.includes("=====BEGIN"),
        headers: request.headers,
        body,
      };
      requests.push(seen);
      const behavior = models[seen.model];
      return behavior ? behavior(seen) : refuses(404, { error: { message: `no model ${seen.model}` } })(seen);
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

/** One frame of a streamed reply. */
export function frame(model: string, delta: object, finish: string | null = null): string {
  return sse({
    id: "chatcmpl-demo",
    object: "chat.completion.chunk",
    created: 1_795_559_385,
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });
}

export function sse(data: object | string): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

export function usageFrame(model: string, input: number, output: number): string {
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  return sse({ id: "chatcmpl-demo", object: "chat.completion.chunk", created: 1_795_559_385, model, choices: [], usage });
}

/** A response that sends each part as its own chunk. A number is a pause in milliseconds. */
export function stream(parts: (string | Uint8Array | number)[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        if (typeof part === "number") await Bun.sleep(part);
        else controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      }
      controller.close();
    },
    cancel() {},
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Says `text` and finishes normally, with its usage and the end mark. */
export function says(text: string | ((request: ModelRequest) => string), usage = { input: 1000, output: 200 }): Behavior {
  return (request) => {
    const answer = typeof text === "string" ? text : text(request);
    const words = request.isCheck ? ["ready"] : answer.match(/.{1,40}/gsu) ?? [];
    const used = request.isCheck ? { input: 20, output: 2 } : usage;
    return stream([
      frame(request.model, { role: "assistant", content: "" }),
      ...words.map((content) => frame(request.model, { content })),
      frame(request.model, {}, "stop"),
      usageFrame(request.model, used.input, used.output),
      sse("[DONE]"),
    ]);
  };
}

/** A reviewer that does its job: writes its findings and signs for them. */
export function reviews(...findings: string[]): Behavior {
  return says((request) =>
    [...findings, findings.length === 0 ? "I read every file and checked the error paths." : "", signOff(request, findings.length)].join(
      "\n",
    ),
  );
}

/** The sign-off line, built the way a model has to: from the two halves in the prompt. */
export function signOff(request: ModelRequest, value: string | number): string {
  const first = /The first half is ([0-9a-f]+)/u.exec(request.prompt)?.[1];
  const second = /second half of your sign-off code is ([0-9a-f]+)/u.exec(request.prompt)?.[1];
  return `SIGN-OFF ${first}-${second} | ${value}`;
}

export function refuses(status: number, body: object | string, headers: Record<string, string> = {}): Behavior {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return () => new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/** Passes its check, then does something else when asked to review. */
export function afterCheck(behavior: Behavior): Behavior {
  const ready = says("ready");
  return (request) => (request.isCheck ? ready(request) : behavior(request));
}
