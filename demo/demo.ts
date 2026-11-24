// A whole run with no keys and no network: the real command, against a
// stand-in provider on this machine. Run it with: bun run demo
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterCheck, frame, refuses, reviews, says, signOff, sse, startFakeProvider, stream } from "./fake-provider.ts";

const provider = startFakeProvider({
  // Two that answer.
  alpha: reviews(
    "FINDING | blocker | src/payments/refund.ts:25 | When the gateway refuses the refund, the error is only logged, and the order is still marked as refunded.",
    "FINDING | blocker | src/payments/refund.ts:12 | Two calls for one order at the same time both read the old refundedCents, both pass the limit, and the customer is paid twice.",
  ),
  bravo: says((request) => `I read src/payments/refund.ts.\n${signOff(request, 0)}`),
  // Two that sit and do not.
  charlie: afterCheck((request) =>
    stream([
      frame(request.model, { content: "FINDING | major | src/payments/refund.ts:23 | The amount is mult" }),
      frame(request.model, {}, "length"),
      sse("[DONE]"),
    ]),
  ),
  delta: afterCheck(refuses(429, { error: { message: "Too many requests" } }, { "retry-after": "60" })),
  // Three that never sit.
  echo: refuses(402, { error: { message: "Insufficient balance" } }),
  foxtrot: reviews(),
  golf: reviews(),
});

const reviewer = (id: string, lab: string, usdPerMillionTokens: object, goodAt: string[] = []) => ({
  id,
  lab,
  provider: "local",
  model: id,
  goodAt,
  usdPerMillionTokens,
});
const CHEAP = { input: 0.5, output: 2 };

const folder = mkdtempSync(join(tmpdir(), "review-panel-demo-"));
writeFileSync(
  join(folder, "panel.json"),
  JSON.stringify({
    limits: { maxUsd: 0.2, maxOutputTokens: 16_000, timeoutSeconds: 10 },
    labs: Object.fromEntries("abcdefg".split("").map((letter) => [`lab-${letter}`, []])),
    providers: { local: { baseUrl: provider.baseUrl } },
    reviewers: [
      reviewer("alpha", "lab-a", CHEAP, ["payments", "code"]),
      reviewer("bravo", "lab-b", CHEAP, ["code"]),
      reviewer("charlie", "lab-c", CHEAP),
      reviewer("delta", "lab-d", CHEAP),
      reviewer("echo", "lab-e", CHEAP, ["payments"]),
      reviewer("foxtrot", "lab-f", { input: 15, output: 75 }, ["payments", "code"]),
      reviewer("golf", "lab-g", CHEAP, ["payments", "code"]),
    ],
  }),
);

const out = join(folder, "out");
const child = Bun.spawn(
  [
    "src/cli.ts",
    ...["--diff", "examples/refund.diff"],
    ...["--author", "golf"],
    ...["--config", join(folder, "panel.json")],
    ...["--out", out],
  ],
  { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "inherit" },
);
const exit = await child.exited;
console.log(`\n${readFileSync(join(out, "summary.md"), "utf8")}`);
console.log(`The command ended with exit code ${exit}.`);

rmSync(folder, { recursive: true, force: true });
await provider.stop();
