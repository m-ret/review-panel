# Review panel: 3 of 4 reviewers answered

**This panel is not complete.** 1 reviewer did not answer. A missing answer is not agreement.

- **Reviewed:** examples/refund.diff, 1 file, +38 -0
- **Written by:** claude, so anthropic sits out
- **Touches:** payments, code
- **Risk:** high
- **Why:** src/payments/refund.ts touches payments (payments, refund)
- **Cost:** $0 of $0.50
- **Run:** 2026-11-24 23:32 UTC, sign-off code 00a586-f3a9af

## Reviewers

| Reviewer | Lab | Result | Time | Cost |
| --- | --- | --- | --- | --- |
| [mistral](mistral.md) | mistral | 4 findings | 215 s | $0 |
| [nemotron](nemotron.md) | nvidia | 5 findings | 16 s | $0 |
| [kimi](kimi.md) | moonshot | **did not answer**, timeout: no complete reply after 300 s, only hidden reasoning had arrived, 23491 characters | 300 s | $0 |
| [minimax](minimax.md) | minimax | 6 findings | 246 s | $0 |

## Findings

| Severity | Where | What | Reviewer |
| --- | --- | --- | --- |
| blocker | src/payments/refund.ts:12-32 | Check-then-act race with no transaction, lock, or atomic increment. The comment says both the admin page and the gateway webhook call this, so two concurrent \`refundOrder\` calls for the same order both read the same \`refundedCents\`, both pass the line-16 cap, and both call \`gateway.refund\` → the customer is refunded twice at the gateway. Additionally line 31 is a stale read-modify-write (\`order.refundedCents + ...\` from the pre-refund read), so concurrent updates lose one increment and \`refundedCents\` can end below the actually-refunded total, re-opening room for further over-refund. Same hol… | [mistral](mistral.md) |
| blocker | src/payments/refund.ts:16 | Check-then-act race allows refunding more than was paid: two concurrent calls for the same order (admin double-click plus gateway webhook retry, or two admins) both read the same \`refundedCents\`, both pass the cap check, and both call \`gateway.refund\`. Example: order with \`paidCents = 10000\`, \`refundedCents = 0\`, two requests of \`amount = 100\` → the gateway refunds $200 against a $100 charge, while the read-modify-write at line 31 records only 10000, so the ledger under-reports what was actually returned and later checks still allow further refunds. Fix: do the cap check and increment atomica… | [minimax](minimax.md) |
| blocker | src/payments/refund.ts:21 | If gateway.refund throws (network error, gateway decline, invalid chargeId), the catch block logs but does not return; execution continues to update refundedCents and auditLog, returning { ok: true } to caller while no money was refunded. | [nemotron](nemotron.md) |
| blocker | src/payments/refund.ts:25-37 | Gateway failure is swallowed: when \`gateway.refund\` throws (network timeout, processor decline, bad chargeId), the catch only logs and execution continues, so \`refundedCents\` is incremented, an audit "refund" row is written, and \`{ ok: true }\` is returned even though no money moved. Input: any \`refundOrder\` call where the gateway call fails - the order is then permanently marked refunded, the customer never receives funds, and the line-16 cap blocks any later legitimate refund. | [mistral](mistral.md) |
| blocker | src/payments/refund.ts:25 | Gateway failure is swallowed: when \`gateway.refund\` rejects (network timeout, 5xx, invalid/void charge), the catch only logs, and execution continues to increment \`refundedCents\`, write the audit entry, and return \`{ ok: true }\`. The customer never gets money back but the order and ledger show a completed refund, so nobody notices the missing money and the admin page reports success. Fix: return \`{ ok: false }\` (or rethrow) from the catch and skip the DB update/audit write. | [minimax](minimax.md) |
| major | src/payments/refund.ts:15 | Concurrent refundOrder calls for the same orderId can both pass the alreadyRefunded check, both call gateway.refund, and both increment refundedCents, resulting in total refunded exceeding paidCents (over-refund). | [nemotron](nemotron.md) |
| major | src/payments/refund.ts:16,23,31 | Money math in floating-point dollars: \`request.amount \* 100\` is not an integer for values like 0.29 (0.29\*100 = 28.999999999999996), so a fractional \`amountCents\` is sent to the gateway and added into \`refundedCents\` (an Int cents column), and the line-16 cap compares floats (\`order.paidCents/100 - alreadyRefunded\`), so an amount equal to the remaining balance can compare greater/less by epsilon and permit a slight over-refund. Input: any refund amount with more than two decimal places or one that triggers float error, e.g. \`amount: 0.29\` or the exact remaining balance of a partially refunded… | [mistral](mistral.md) |
| major | src/payments/refund.ts:16-24 | No validation that \`amount\` is a positive finite number: \`NaN \> x\` is false and negative numbers pass the check, so \`refundOrder({ orderId, amount: -5 })\` or a webhook payload with a missing/invalid \`amount\` sends a negative or NaN \`amountCents\` to \`gateway.refund\` and writes \`NaN\`/negative values into \`refundedCents\`, corrupting the refund ledger for that order. | [mistral](mistral.md) |
| major | src/payments/refund.ts:16 | Unvalidated amount bypasses the cap: \`amount = NaN\` (e.g. \`parseFloat\` of a malformed admin form field) makes \`request.amount \> ...\` false, so the check passes; \`refundedCents\` then becomes NaN and every later comparison \`amount \> (paid - NaN)\` is false, so all subsequent refunds are approved regardless of the amount paid. \`amount = -50\` also passes the check, calls \`gateway.refund\` with \`amountCents: -5000\` (gateway behavior not visible here - it could reject it or treat it as a new charge) and sets \`refundedCents\` to -5000, raising the remaining allowance to $150 on a $100 order. Fix: rejec… | [minimax](minimax.md) |
| major | src/payments/refund.ts:19 | gateway.refund is called without an idempotency key; a webhook retry or admin double-click causes a second gateway refund for the same chargeId, potentially double-refunding the customer. | [nemotron](nemotron.md) |
| major | src/payments/refund.ts:21 | No idempotency protection on a gateway money movement: the function is documented as called by the gateway webhook, and gateways redeliver events until acknowledged, so a duplicate delivery of the same event issues a second \`gateway.refund\` for the same request and refunds the customer twice. The same happens if the process dies after the gateway call but before the DB update at line 29, or if the uncaught throw from \`db.order.update\`/\`db.auditLog.create\` (lines 29-36) causes the caller to retry (the caller-side retry/ack logic is not visible in this diff). Fix: require an idempotency key (we… | [minimax](minimax.md) |
| major | src/payments/refund.ts:23 | Dollar floats produce fractional cents: \`request.amount \* 100\` yields 1006.9999999999999 for \`amount = 10.07\`, so a non-integer \`amountCents\` is sent to the gateway and a non-integer value is stored in \`refundedCents\`. If the column is an integer type the DB write throws \*after\* the gateway already refunded, leaving the refund unrecorded and inviting a retry/double refund; if the gateway rounds, the amount returned and the amount recorded drift by a cent per refund. Fix: accept/validate cents as an integer (or \`Math.round(amount \* 100)\` after a two-decimal validation) and keep every calculati… | [minimax](minimax.md) |
| minor | src/payments/refund.ts:13 | No validation that request.amount \> 0; a zero or negative amount passes the check (negative increases available balance) and gateway.refund may behave unpredictably. | [nemotron](nemotron.md) |
| minor | src/payments/refund.ts:19 | request.amount \* 100 uses floating-point multiplication; amounts like 0.1 produce 10.000000000000001 cents, which may be rejected by gateway or stored incorrectly. | [nemotron](nemotron.md) |
| minor | src/payments/refund.ts:35 | \`request.reason\` is written verbatim into the audit-log note, and it can originate from a gateway webhook payload, i.e. external input. If the admin audit view renders \`note\` as HTML without escaping (rendering code not visible in this diff), a reason containing markup yields stored script execution in the admin console. Fix: escape/encode the note at render time or store it as plain text with no HTML interpretation. | [minimax](minimax.md) |

## Not seated

| Reviewer | Lab | Why |
| --- | --- | --- |
| step | stepfun | not-needed: the panel was full |
| glm | zai | check-failed: timeout: no complete reply after 60 s |
| laguna | poolside | not-needed: the panel was full |
| gemma | google | check-failed: model-not-found: HTTP 404: Function '\[id\]': Not found for account '\[id\]' |

## Decision

Left to a person. Nobody counts votes here, and no findings is not a GO.

- [ ] GO
- [ ] NO-GO

Decided by:

Why:
