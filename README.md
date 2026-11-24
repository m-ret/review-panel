# review-panel

[![ci](https://github.com/m-ret/review-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/m-ret/review-panel/actions/workflows/ci.yml)

Send a diff or a question to two to four AI models that did not write it. Every answer is kept, every missing one is recorded with its reason, and a person decides.

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="docs/assets/flow-dark-mobile.svg">
  <source media="(max-width: 640px)" srcset="docs/assets/flow-light-mobile.svg">
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/flow-dark.svg">
  <img src="docs/assets/flow-light.svg" width="100%" alt="Five steps and what each one writes down. Plan: paths and size set the risk, low risk is two seats, medium three, high four, and the lab that wrote the work sits out. Check: each candidate is asked for one word before any code is sent, and a dead one loses its seat. Ask: the same packet goes to every seat at once, with a timeout, and the worst case of each call is set aside under the spend cap first. Judge: a reply counts only if it arrived whole, is signed for this run, and its findings add up. Decide: a person reads the answers; code never counts votes, and a missing answer is never a yes.">
</picture>

## Why

When one model writes code and others review it, three things go wrong without a sound:

- **The author reviews its own work.** A model rarely sees the hole it just left. Here, the lab of whoever wrote the change sits out, and a misspelt author is refused, because a typo would seat the real one.
- **Silence looks like approval.** A rate limit, a cut-off reply, an empty body and a clean review can all end up in a log as "no findings". Here, a reply counts only if it proves that it arrived whole.
- **Code makes the decision.** Votes get added up, and three models that missed a bug outvote the one that saw it. Here, the summary ends with two empty boxes: GO and NO-GO.

## Try it without keys

You need [Bun](https://bun.sh) 1.4 or newer, on Linux or macOS.

```bash
git clone https://github.com/m-ret/review-panel && cd review-panel
bun install
bun run demo
```

The demo runs the real command against a stand-in provider on your machine. Two reviewers answer, one is cut off, one is rate limited, one has no credit, one would break the spend cap, and one is from the lab that wrote the work.

## A real run

[`examples/refund.diff`](examples/refund.diff) is a refund function with bugs planted on purpose. On 2026-11-24 it went to eight models from eight labs, on NVIDIA's free endpoint, with [`panel.example.json`](panel.example.json):

```console
$ review-panel --diff examples/refund.diff --author claude --config panel.example.json
examples/refund.diff, 1 file, +38 -0
written by claude; risk high
  src/payments/refund.ts touches payments (payments, refund)
check failed: glm: timeout (no complete reply after 60 s)
check failed: gemma: model-not-found (HTTP 404: Function '[id]': Not found for account '[id]')
asking 4 of 4: mistral, nemotron, kimi, minimax
nemotron: answered, 4 findings
minimax: answered, 5 findings
mistral: answered, 5 findings
kimi: timeout (no complete reply after 300 s, only hidden reasoning had arrived, 19290 characters)
3 of 4 reviewers answered. This panel is not complete. A missing answer is not agreement. The decision is yours.
```

The three that answered found that a refused refund is still written down as paid, and that two requests at once pay twice. One thought for five minutes and said nothing, so the command ended with exit code 1. Two never got a seat. The provider lists one of them, and calling it gives "404 Not Found".

Read [the summary](examples/run-2026-11-24/summary.md), or [what one reviewer wrote](examples/run-2026-11-24/mistral.md).

## What counts as an answer

A reply counts if all of this is true. If not, the reviewer "did not answer", and the summary says why.

1. The provider accepted the request, and no error came inside the stream.
2. Every piece of the reply could be read.
3. The provider said that it was finished, and not because of a token limit or a filter.
4. There is text.
5. The last line is this run's sign-off. Its code is random and new, half of it above the work and half below. So a signed answer got both ends of the packet, is finished, and was not planted in the diff.
6. The number in the sign-off is the number of findings that were written.

There is no list of known error messages. A list only catches what somebody has seen before.

## Who reviews

Code picks, not a model, so the same work, config and checks always give the same panel.

| Risk | When | Seats |
| --- | --- | --- |
| low | only docs or tests, or up to 40 changed lines with nothing sensitive | 2 |
| medium | everything else | 3 |
| high | a path about security, payments, data or infrastructure; code that destroys data; more than 800 changed lines; a diff that cannot be read all the way | 4 |

Reviewers are sorted by how well their `goodAt` list matches the change. Then the list is walked once. A reviewer does not sit if it is from the author's lab, its check failed, its lab already has a seat, or its worst case does not fit under the spend cap. Each reason is written down.

## Use it

```bash
bun link                              # puts review-panel on your path
cp panel.example.json panel.json      # then put your own reviewers in it
export NVIDIA_API_KEY=...             # one variable for each provider

review-panel --author claude --range main...HEAD
review-panel --author claude --range main...HEAD -- src/payments
gh pr diff 12 | review-panel --author codex --diff -
review-panel --author human --question plan.md
```

`--dry-run` shows the plan and the worst-case cost, and writes the exact text that would be sent. It sends nothing. `--help` has the rest.

Any OpenAI-compatible endpoint works as a provider. The example config needs one free key. A key that is written in the config is refused.

| Exit code | Meaning |
| --- | --- |
| 0 | every seat was filled and answered |
| 1 | a seat is missing, or a reviewer did not answer |
| 2 | nothing was sent: bad input, a bad config, or something that looks like a key |
| 3 | fewer than two reviewers could sit |

## Limits

- It does not decide, vote, retry or replace. A failed reviewer stays visible.
- Reviewers see the diff only. They cannot open the repository or run anything.
- Different labs are a stand-in for independence. They train on much of the same public text, so they can share a blind spot.
- The spend cap trusts your prices and the provider's own count. If a provider counts more than the worst case, the summary says so afterwards.
- Your code goes to the providers you list. Read their terms first.

## How it works

[docs/how-it-works.md](docs/how-it-works.md) explains every part in plain words, with the reason for each choice and what was measured.

```bash
bun run check    # typecheck and tests: no keys, no network
```

One runtime dependency: [Zod](https://zod.dev), for the config.

## License

[MIT](LICENSE)
