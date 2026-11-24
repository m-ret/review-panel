# How it works

This page explains every part in plain words. File names point to the code in `src/`.

- [The idea](#the-idea)
- [One run, from start to end](#one-run-from-start-to-end)
- [Map of the code](#map-of-the-code)
- [Rules that never bend](#rules-that-never-bend)
- [Why it is built this way](#why-it-is-built-this-way)
- [What was measured](#what-was-measured)
- [How it is tested](#how-it-is-tested)
- [What it does not do](#what-it-does-not-do)
- [Words used here](#words-used-here)

## The idea

One AI model writes a change. Two to four other models read it. This program does not judge the change. It makes sure that each reviewer got all of it, really answered, and did not write it. It keeps a record when one did not answer. Then it stops, and a person decides.

## One run, from start to end

```bash
review-panel --range main...HEAD --author claude
```

### 1. Read the work (`input.ts`, `diff.ts`)

The program asks git for the diff. It forces a plain diff, because people set up git in different ways: with colours, with another diff tool, or with other prefixes. A range that starts with a hyphen is refused. Git would read it as an option, and some git options write files.

Then it reads the diff to learn which files changed, and by how many lines. Each block of a diff starts with a header such as `@@ -1,3 +1,4 @@`, which says how many lines follow. The program counts them down one by one. The reason is a trap. A comment in SQL starts with `--`. When you remove one, the diff line is `--- some text`, and that looks exactly like a file header. Without counting, the content of a file could invent another file or hide one, and that would change the risk.

### 2. Refuse what must not be sent (`secrets.ts`, `cli.ts`)

Two checks run before anything leaves the machine.

- **Does it look like it holds a key?** The program looks for well-known key formats, for private keys, and for the keys it uses itself. If it finds one, it stops. The message gives the kind and the line, never the value. No option turns this off. To go on, leave that file out with paths after `--`.
- **Is it too big?** Then it stops too. It never trims a diff to fit, because a reviewer that saw half of a change would sign for all of it.

### 3. Decide how risky it is (`classify.ts`)

No model is asked. Each path is split into words: `src/OAuthClient.ts` becomes `src`, `o`, `auth`, `client`, `ts`. The words are looked up in a short table. Words are matched whole, so `author.ts` is not about `auth`. A renamed file counts under both names.

| Risk | When | Seats |
| --- | --- | --- |
| low | only docs or tests, or up to 40 changed lines with nothing sensitive | 2 |
| medium | everything else | 3 |
| high | a path about security, payments, data or infrastructure; added code that destroys data; more than 800 changed lines; or a diff that could not be read all the way | 4 |

When in doubt the risk goes up. A person can raise it with `--risk`, but cannot lower it. A question has no paths, so it is medium, unless it names something sensitive.

### 4. Leave the author out (`author.ts`)

Every reviewer in the config belongs to a lab, the company that made the model. `--author` can be a reviewer, a model, a lab, an alias from the config (`claude` means `anthropic`), or `human`. It can be several, with commas.

The whole lab sits out. It is not asked anything, not even the check in the next step.

A name that the config does not know is refused. If it were accepted, it would leave nobody out, so one typo would let a model review its own work.

### 5. Check every candidate (`check.ts`)

Each candidate is asked for one word, with a limit of 16 tokens. The question holds none of the work. A candidate that fails loses its seat before it sees any code.

Why a real request, and not the provider's list of models? Because the list proves little. While this was being written, one provider listed a model that gave "404 Not Found" when called.

The reply is not graded. A reasoning model may spend all 16 tokens thinking and say nothing. That still proves that the key, the model and the address work.

### 6. Fill the seats (`seats.ts`)

The reviewers are sorted by how many of the areas of the change are in their `goodAt` list. Ties keep the order of the config. Then the program walks down the list once and asks four questions about each one:

1. Is it from the author's lab?
2. Did its check fail?
3. Does its lab already have a seat?
4. Does its worst case not fit under the spend cap?

One yes and it does not sit, and the reason is written down. When the seats are full, the rest are "not needed".

If fewer than two can sit, nothing is sent, because one reviewer is not a panel. If fewer can sit than the risk asks for, the panel runs, and the first line of the summary says that it is short.

### 7. Set the money aside (`budget.ts`)

Reviewers work at the same time. So it is not enough to check what was spent so far: two calls could both pass that check and go over the cap together. Before a call starts, its worst case is set aside. If it no longer fits, the call does not start. When the call ends, its real cost replaces the worst case.

The worst case is the whole prompt plus the longest answer allowed. The prompt is counted as one token for every byte. That is too high on purpose, about four times too high for code. A token is at least one byte, so this is the one number that cannot be too low. Another 500 tokens cover the template that the provider adds around the prompt.

If a provider does not say what a call cost, the worst case stands. Money is kept in whole millionths of a dollar, so rounding cannot hide anything.

### 8. Ask everyone at once (`prompt.ts`, `call.ts`, `sse.ts`, `reply.ts`)

Every seat gets the same packet: what to look for, how to write a finding, and the work between two marker lines. The packet says that everything between the markers is data, not instructions.

**The sign-off.** Each run makes a fresh random code. Half of it is written above the work and half below it. The last line of an answer must be `SIGN-OFF <both halves> | <number of findings>`. So a signed answer shows three things:

- the reviewer received the start and the end of the packet, since some servers cut a long prompt without saying so;
- the answer is finished, because the line is the last one;
- the line was not planted in the diff, because the code did not exist when the diff was written.

**The call.** The answer is streamed, piece by piece. A reasoning model can think for minutes, and a connection that stays silent that long gets closed on the way. Each call has one time limit. Redirects are not followed, because they would carry the key and the code to an address nobody configured.

**Cleaning.** Everything that comes back is cleaned once, at the door: terminal codes, invisible characters, account ids in error messages, and any repeat of a key.

### 9. Judge each reply (`outcome.ts`, `answer.ts`)

The code that makes the call only reports what happened. Other code decides what it means. An answer counts if all of this is true:

1. The provider accepted the request, and no error came inside the stream.
2. Every piece of the reply could be read.
3. The provider said that it was finished, and not because of a limit or a filter.
4. There is text.
5. The last line is this run's sign-off.
6. The number in the sign-off is the number of findings that were written.

If one of them fails, the reviewer "did not answer", and the reason gets a name: `no-key`, `no-access`, `out-of-credit`, `rate-limited`, `model-not-found`, `bad-request`, `provider-error`, `timeout`, `network`, `empty`, `truncated`, `filtered`, `unsigned`, `inconsistent`, `over-budget` or `internal-error`. Each one needs a different fix, so each has its own name.

### 10. Write it down (`report.ts`)

- `prompt.txt`: exactly what was sent.
- `<reviewer>.md`, one for each seat, written as soon as that reviewer is done. The text is kept as it came. If the reviewer did not answer, the part that arrived is kept too, under "not counted".
- `summary.md` and `summary.json`, written last. If there is no summary, the run did not finish.

The summary opens with what is missing. If it opened with the findings, a missing reviewer would look like one with nothing to say.

### 11. A person decides

The summary ends with two empty boxes, GO and NO-GO. No code ever fills them in. In the JSON file, `decision` is always `null`.

## Map of the code

| File | Its job |
| --- | --- |
| `cli.ts` | reads the options, runs the steps, sets the exit code |
| `input.ts` | gets the diff or the question |
| `config.ts` | checks the config file and reads the keys |
| `author.ts` | finds the lab that must sit out |
| `secrets.ts` | finds what must not be sent |
| `diff.ts` | which files changed, and by how much |
| `classify.ts` | what the change touches, and how risky it is |
| `prompt.ts` | the packet and its codes |
| `panel.ts` | the order of the steps |
| `check.ts` | one word from each candidate |
| `seats.ts` | who sits, and why the others do not |
| `budget.ts` | the money |
| `ask.ts` | one call, with its money settled whatever happens |
| `call.ts` | one HTTP request, reported as it happened |
| `sse.ts`, `reply.ts` | the stream, put back together |
| `outcome.ts` | did it answer, and if not, why |
| `answer.ts` | the sign-off line and the findings |
| `report.ts` | the files |
| `text.ts` | cleaning text from outside |

## Rules that never bend

1. A missing answer is never agreement.
2. The lab that wrote the work is never asked.
3. No model picks the reviewers or adds up the result.
4. What is sent is sent whole, or not at all.
5. Keys come from environment variables, travel in one header to one address, and are never written anywhere.
6. Text from outside stays text.
7. A reviewer that fails stays visible. Nothing is retried or replaced in silence.

## Why it is built this way

**Why not let a model pick the reviewers?** It would cost a call, it could pick differently each time, and the author could be the one picking its own jury. A table can be read, tested and argued with.

**Why count labs and not models?** Two models from one lab share training data and habits. Labs are the simplest stand-in for "thinks differently". It is only a stand-in: different labs also train on much of the same public text, so they can share a blind spot.

**Why ask for a sign-off instead of looking for errors?** A list of known errors only catches errors that somebody has seen. The first reworded rate-limit message passes as a review. So the burden of proof is turned around: no proof, no answer.

**Why split the code in two?** With one half at each end, a reviewer that lost either end cannot sign. It costs one sentence in the prompt. Every complete answer in the live runs below got it right.

**Why count the findings?** A model that writes two findings and signs for none has contradicted itself. Code cannot know which half is true, so it is not counted, and a person can read the file.

**Why no retries?** A retry hides the failure that you needed to know about, and it spends money that nobody approved. Running the command again is a person's choice.

**Why not add up the votes?** Three reviewers can miss the same bug, and one can be right against three. Counting turns that into a number that looks like a decision.

**Why plain lines and not JSON?** Not every model on an OpenAI-compatible endpoint can promise valid JSON, and cut-off JSON is hard to read at all. A line per finding survives, and people can read it.

**What about a diff that tries to talk to the reviewers?** It can try. The packet calls the diff data, the markers and the code are new in every run, and the diff cannot sign for a reviewer. But a model can still be talked into something. That is one more reason why a person decides.

**What if a provider lies about what a call cost?** Then the cap can be passed, and the summary says so. The program can only count what it is told.

**Why does it not read `.env`?** The program runs inside the folder under review, and Bun reads `.env` and `bunfig.toml` from there by default. A `bunfig.toml` can run code. The first line of `cli.ts` turns both off.

## What was measured

All on 2026-11-24, with free models.

- **Do models sign with a split code?** In 11 complete answers from four labs, 11 were signed correctly and had the right number of findings. The other 7 calls of those runs ended in a timeout and were recorded as such.
- **Does a list of models prove anything?** No. One listed model gave 404.
- **What does a 16-token check show on a reasoning model?** Status 200, only hidden reasoning, and "stopped at the token limit". It passes, as it should.
- **How much do providers add to a prompt?** A 26-byte prompt was billed as 14 to 184 tokens.
- **Can the folder under review run code?** With plain `bun run`, yes: a planted `bunfig.toml` ran a planted script. Started by its first line, no.
- **Does Bun cut a silent connection?** Yes, after five minutes by default. The call turns that timer off and uses its own.
- **Does the diff reader agree with git?** On 688 commits and almost 5,000 changed files from six repositories, every file name and line count was the same as in `git show --numstat`.

## How it is tested

Tests were written first and seen failing. They use no keys and no network. Calls go over real HTTP to a stand-in provider on the same machine (`demo/fake-provider.ts`), which can answer, stop half way, refuse, stay silent, send broken pieces or send a whole web page. The command-line tests start the real command by its first line, in a real git repository.

Then the code was broken on purpose, one small change at a time, to see whether a test noticed. The breaks that nobody noticed became new tests.

## What it does not do

- It does not decide, vote, retry or replace.
- Reviewers see the diff. They do not see the rest of the repository and cannot run anything.
- It does not know if a model is good. `goodAt` is your opinion.
- It does not stop you from sending code to a provider you should not use. Read the terms of each one.
- The search for keys knows common formats. It is a safety net, not a scanner.
- It needs a Unix-like system.

## Words used here

| Word | Meaning |
| --- | --- |
| reviewer | a model in the config |
| lab | the company that made the model |
| provider | the server that runs it; one provider can run models from many labs |
| candidate | a reviewer that is not from the author's lab |
| check | the one-word question before the panel starts |
| seat | a place on this panel: two, three or four |
| packet | the instructions and the work, as sent |
| sign-off | the last line of an answer, with this run's code |
| finding | one problem, on one line |
| worst case | the most a call can cost |
