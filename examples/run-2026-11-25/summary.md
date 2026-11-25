# Review panel: 3 of 4 reviewers answered

**This panel is not complete.** 1 reviewer did not answer. A missing answer is not agreement.

- **Reviewed:** examples/refund.diff, 1 file, +38 -0
- **Fingerprint:** sha256 cb9d2e81a542542d
- **Written by:** claude, so anthropic sits out (it has no reviewer here)
- **Touches:** payments, code
- **Risk:** high
- **Why:** src/payments/refund.ts touches payments (payments, refund)
- **Cost:** $0 of $0.50
- **Run:** 2026-11-25 00:06 UTC, sign-off code e35b40-83eb1e

## Reviewers

| Reviewer | Lab | Result | Time | Cost |
| --- | --- | --- | --- | --- |
| [mistral](mistral.md) | mistral | 5 findings | 208 s | $0 |
| [nemotron](nemotron.md) | nvidia | 4 findings | 30 s | $0 |
| [minimax](minimax.md) | minimax | 5 findings | 219 s | $0 |
| [step](step.md) | stepfun | **did not answer**, timeout: no complete reply after 300 s, only hidden reasoning had arrived, 12405 characters | 300 s | $0 |

## Findings

| Severity | Where | What | Reviewer |
| --- | --- | --- | --- |
| blocker | src/payments/refund.ts:12-32 | TOCTOU race on the refund cap: order (and refundedCents) is read at line 12, checked at line 16, then line 31 writes \`order.refundedCents + amount\*100\` from the stale read. Two concurrent refundOrder calls (the doc comment says both the admin page and the gateway webhook call it, and webhook retries are expected) both pass the cap check and both run gateway.refund, so the customer is refunded twice at the gateway, while the second update overwrites the first so the DB under-records refunds and still allows further over-refunds. No idempotency key exists anywhere in this code. | [mistral](mistral.md) |
| blocker | src/payments/refund.ts:13 | Race condition allows over-refunding beyond paid amount. Input: two concurrent refundOrder calls for same orderId, each requesting an amount that individually passes the check but together exceed paidCents - refundedCents. State: order.paidCents=10000, order.refundedCents=0. Order of events: both calls read order (refundedCents=0), both pass amount check (e.g., each requests $60), both call gateway.refund, both update refundedCents to 6000, total refunded becomes $120 on a $100 order. | [nemotron](nemotron.md) |
| blocker | src/payments/refund.ts:16 | The over-refund check reads \`order.refundedCents\` and line 31 writes back \`order.refundedCents + amount\` with no transaction, row lock, or conditional update, so two concurrent calls on the same order (admin double-click while the gateway webhook fires, or a webhook retry) both read the same \`refundedCents\` and both pass the check: on a $100 order two $60 refunds both go to the gateway ($120 against a $100 charge) and both DB updates write 6000, losing one update so the ledger shows only $60 refunded while $120 left the account. This also depends on idempotency/serialization in the unseen gat… | [minimax](minimax.md) |
| blocker | src/payments/refund.ts:24 | Gateway refund failure is caught and logged but execution continues, so the database records a refund that never happened at the payment provider. Input: any request where gateway.refund throws (network error, provider decline, invalid chargeId). State: order exists, refund amount valid. Order of events: gateway.refund throws -\> catch logs error -\> db.order.update increments refundedCents -\> auditLog created -\> returns ok:true. | [nemotron](nemotron.md) |
| blocker | src/payments/refund.ts:25-32 | If gateway.refund throws, the catch only logs and execution continues: refundedCents is still incremented, an audit "refund" row is written, and {ok:true} is returned to the admin page / gateway webhook. The ledger says the customer was refunded but no money moved through the gateway, and the caller is told it succeeded - silent ledger/gateway mismatch in payments. | [mistral](mistral.md) |
| blocker | src/payments/refund.ts:26 | If \`gateway.refund\` throws (network timeout, gateway decline, gateway 5xx), the catch only logs the error and execution continues: \`refundedCents\` is incremented, a "refund" audit row is written, and the function returns \`{ ok: true }\`. The order then shows money returned that never reached the gateway, and the admin page/webhook caller is told the refund succeeded. Fix: propagate the failure (rethrow or return \`{ ok: false }\`) and skip the order/audit writes when the gateway call fails. | [minimax](minimax.md) |
| major | src/payments/refund.ts:7 | No validation that request.amount is a positive finite number. Input: request.amount = -50, NaN, Infinity, or a string that coerces. State: any valid order. Order of events: negative amount passes the check (since -50 \> remaining is false), gateway.refund receives negative amountCents (provider behavior unknown), database subtracts from refundedCents (increasing balance), audit log records refund. | [nemotron](nemotron.md) |
| major | src/payments/refund.ts:16 | No validation that request.amount \> 0: a negative (or zero) amount passes the cap check, is sent to gateway.refund as a negative amountCents, and line 31 subtracts it from refundedCents, re-opening refund room so a later request can refund more than was paid. | [mistral](mistral.md) |
| major | src/payments/refund.ts:16 | \`request.amount\` is never validated: a negative amount passes the \`\>\` check (e.g. -50), decreasing \`refundedCents\` and inflating the refundable balance to $150 on a $100 order; \`NaN\` also passes because every comparison with NaN is false, and line 31 then stores \`NaN\` in \`refundedCents\`, after which the guard (\`x \> NaN\`) is always false and unbounded refunds are allowed; an amount of 0 also passes and calls the gateway with 0. Fix: require a finite amount \> 0 and compare in integer cents. | [minimax](minimax.md) |
| major | src/payments/refund.ts:23,31 | \`amount\` is dollars as a JS float and is multiplied by 100 without rounding: 19.99\*100 = 1998.9999999999998, so amountCents sent to gateway.refund and the value added to refundedCents can be a non-integer or off by one cent - the gateway may refund the wrong amount or reject it, and the stored ledger is wrong. | [mistral](mistral.md) |
| major | src/payments/refund.ts:23 | Dollars are converted to cents by floating-point multiplication: \`request.amount = 0.29\` yields \`amountCents = 28.999999999999996\`, so the gateway may reject the call or round it (refunding 28 or 29 cents), and the same non-integer value is written to \`refundedCents\` on line 31, which fails on an integer column or stores a corrupted balance; the comparison on line 16 is likewise done in float dollars. Fix: convert with \`Math.round(amount \* 100)\` and keep all amount arithmetic in integer cents. | [minimax](minimax.md) |
| major | src/payments/refund.ts:29 | If the order update or audit insert fails after \`gateway.refund\` already succeeded (DB outage, integer column rejecting the value, audit table error), the function throws with the refund already executed but nothing recorded, so the order still shows the old \`refundedCents\` and the same amount can be refunded again later, sending the customer more money than intended. There is no compensation or reconciliation for this ordering. Fix: persist a pending-refund/idempotency record before calling the gateway and reconcile pending records, or make the post-gateway writes retryable. | [minimax](minimax.md) |
| minor | src/payments/refund.ts:11 | Floating-point arithmetic on dollar amounts risks cent-level drift. Input: request.amount = 0.1 (cannot be represented exactly in binary). State: order.paidCents=100, order.refundedCents=0. Order of events: alreadyRefunded = 0, check uses 0.1 \> 1 - 0 (true), amountCents = 0.1 \* 100 = 10.000...001 or 9.999...999, gateway receives wrong cents, database update adds truncated/rounded value. | [nemotron](nemotron.md) |
| minor | src/payments/refund.ts:15-16 | The cap comparison mixes float math (paidCents/100 - refundedCents/100), e.g. paidCents=2999 with 1000 already refunded gives 19.989999999999998, so a legitimate request of exactly 19.99 is wrongly rejected with {ok:false}. | [mistral](mistral.md) |

## Not seated

| Reviewer | Lab | Why |
| --- | --- | --- |
| kimi | moonshot | check-failed: timeout: no complete reply after 60 s |
| glm | zai | check-failed: timeout: no complete reply after 60 s |
| laguna | poolside | not-needed: the panel was full |
| gemma | google | check-failed: model-not-found: HTTP 404: Function '\[id\]': Not found for account '\[id\]' |

## Decision

Left to a person. Nobody counts votes here, and no findings is not a GO.

- [ ] GO
- [ ] NO-GO

Decided by:

Why:
