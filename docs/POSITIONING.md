# Competitive position: what they win on, and what we build instead

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

<!-- The historical source filename is retained so the original brief remains identifiable. -->

**Prepared 1 October 2026.** Companion to `voice-agent-qa-market-brief.md`
(features and pricing) and `voice-qa-competitive-ui-report.md` (full UI research,
49KB, sections A–E).

This document covers the interface question and the resulting strategy. It
supersedes the positioning in the market brief, which was written before the UI
research and got half of it wrong.

---

## 1. The correction: I was wrong about ownership

The market brief said the defensible position was cross-stack attribution plus
the `open → claimed-fixed → verified-fixed` lifecycle, on the basis that **no
vendor documented an issue lifecycle**.

That was wrong. A UI research pass found real ticket systems in three of the
competitors:

| Product | Ownership model | Lifecycle |
|---|---|---|
| **Vapi** | `acknowledgedBy` / `resolvedBy` + timestamps, severity, status filters, AI **Analyze** returning root cause + `confidence` + prioritised fixes + `configExample` | `created → acknowledged → resolved` |
| **Bland AI** | Assignee dropdown, @mentions → notifications, "Assigned to Me" / "Unassigned" filters, threaded discussions | Review Status: Pending / In Progress / Completed / Not Needed |
| **Braintrust** | Row assignment, "Assigned to" column, review queue, drag-and-drop kanban (Backlog → Pending → Complete) | Patterns with close outcomes Resolved / Not useful, reopen, closure attributed to a named person |
| **Level AI** | QA case assignment automation, disputes, calibration, coaching action plans | Richest human-workflow model in the set — but the owner is always a *person* and the subject always a *human agent* |
| **Retell AI** | **None.** Per-call actions are calibrate-a-metric and add-a-note | **None** |

Sources: [Vapi monitoring][vapi-monitoring] · [Bland evals][bland-evals] ·
[Braintrust patterns][bt-patterns] · [Braintrust review work][bt-review] ·
[Level AI][level]

So "nobody has ownership" would have been a bad enough claim to build a company
on. Good that it got checked.

## 2. The gap is narrower and much better

Every one of those systems answers **"who is handling this?"**

**None of them answers "whose bug is this?"**

- Vapi records who *acknowledged or resolved*.
- Bland records who a call is *assigned to for review*.
- Level AI assigns *cases to QA auditors*.
- Braintrust assigns *rows to reviewers*.

Not one product in the set lets you assign a failure to **the prompt** or **the
STT provider** or **the VAD threshold**. The `rootCause.category` Vapi returns
is `"timeout"` — a symptom, not an owning team.

### And the second gap, conceded in writing

**Braintrust, in its own documentation, about its own product:**

> "A closed pattern reflects a judgment about the available evidence, not proof
> that the underlying problem is fixed. **Closing a pattern as resolved does not
> verify the fix.** Use a scorer or monitor chart for that."[bt-patterns]

That is the most sophisticated eval UI in the market stating that its terminal
state is a self-declaration. Vapi's `resolved` is a `resolvedBy` and a
timestamp. Bland's "Completed" is a review status.

**Every terminal state in this market is a closure somebody asserted.** None of
them re-measures.

## 3. What we built, and why it is not table stakes

`api/_verify.ts`. When a defect is claimed fixed, **the evidence that proved it
broken is re-scored on the claiming version**, and `verified-fixed` is only
reachable when that check passes. The closure is earned by a measurement.

The unit is **the defect, not the run**. Braintrust's diff mode is
experiment-against-experiment. Nothing in the set lets you say *"these 47 calls
failed on Tuesday, we changed the prompt on Wednesday, here are the same 47
re-scored."*

A four-valued verdict, because "one of five still broken" is the commonest real
outcome and a boolean cannot express it:

| Verdict | Meaning | Reaches `verified-fixed`? |
|---|---|---|
| `verified` | the defect fires on none of its own evidence | yes |
| `partial` | ≤20% residual | **no** |
| `not-verified` | >20% still firing | no |
| `no-evidence` | no recorded evidence behind the defect | no |

And it refuses on no-owner, unclaimed, and `wont-fix` — every refusal stating
why, because *"why is my ticket not moving"* is the most common support
question in any tracker.

### The bugs the tests caught, which are the argument

Three counting bugs, all found by adversarial fixtures that build a ticket which
looks closed by every measure a tracker accepts:

1. **A placeholder comparison returned false unconditionally**, so every piece of
   evidence was classified post-claim. Real defects reported *"no evidence"*
   while having three calls behind them.
2. **A double count.** Looping per-evidence and then over every later call
   produced 9 findings from 3 calls and a residual of **3.00**. A residual above
   1 is not a rate, it is a bug — and it scored a 33%-fixed agent *worse* than
   a completely unfixed one.
3. **A dedupe key built from the wrong filename**, collapsing every later
   version onto one key, so partial and total failure became indistinguishable.

The fixtures were also wrong twice, and in both cases the code was right: 1-of-3
is 33% residual and genuinely fails a 20% bar, and a reworded defect still
present on one call is `partial`, not `verified`. I corrected the fixtures. A
gate whose thresholds get relaxed to match a failing fixture is not a gate.

## 4. The combined proposition

**They show you what broke. We show you whose it is, and we only let you close it when the evidence agrees.**

| | Incumbents | Our Agent Said What?! |
|---|---|---|
| Primary object | a score, a call, a run | an owned defect |
| Failure shown as | a metric column | a ticket routed to a layer with a named owner |
| Cross-layer | Retell decomposes *latency* into asr/llm/tts on a separate surface | blame on every finding, with a first diagnostic step per layer |
| Terminal state | self-declared closure | **re-scored against the defect's own evidence** |
| Ship decision | a dashboard you read | a CI exit code that blocks the release |

### Why the wedge holds

The research brief's concern was that the window is measured in quarters. It is
— but this wedge is **defensible by structure, not by feature**:

- A competitor adding a `claimed`/`verified` split still has to *build the
  re-scoring*, and re-scoring per defect requires defect-scoped evidence, which
  requires routing findings into defects in the first place. That is the layer
  they would also have to build.
- The owner field is worthless without the attribution engine, and the
  attribution engine is worthless without the calibration corpus — which needs
  field data from real code-switched calls. **Nobody can buy their way to this
  in a sprint.**

### What we should copy deliberately

Two primitives from the research, because they are good and we do not have them:

- **Braintrust's "order by regressions"** — comparison-to-baseline as a first
  class sort. It is the natural companion to `verified-fixed`: "show me what got
  worse since v12".
- **Bland's per-turn decision logs with counterfactual routing** — chosen route
  check-marked, alternatives listed. This is the best existing blame primitive in
  the market and the right benchmark for what "prompt vs platform" should feel
  like when we build the layer drill-down.

And one pattern to **deliberately not copy**: severity-as-colour. All five do it
identically, which means it differentiates nobody.

## 5. What I could not verify

Carried forward honestly, because the strategy above rests on absence-of-evidence
for some claims:

1. **No pixel-level UI read.** `vision_analyze` returned HTTP 429 on every
   attempt with `retry_after` ~110,000 seconds. **No screenshot was read.** Every
   layout claim is doc-characterised. Colour, density, spacing, chart styling and
   theming are **unverified for all five products**.
2. **Cresta and Observe.AI** product docs are login-gated; Level AI was
   substituted. Cresta's tab names came from an unsourced `?ask=` endpoint and
   were excluded as unreliable.
3. **The "what users find hard about the UI" question is unanswered.** No
   substantive Reddit/G2/TrustRadius UX-friction evidence for Retell, Bland,
   Vapi or Braintrust — search returned SEO affiliate content.
4. **Absence in docs is weaker evidence than absence in a vendor that documents
   ownership proudly.** Retell's docs are otherwise detailed, so "no owner" is
   suggestive rather than conclusive.
5. **Vapi's Issues and Evals may be linked in the shipped dashboard.** No
   documented bridge was found; that is *undocumented*, not *confirmed absent*.
6. **Bland's Evals results-table layout** and whether `confidence` renders in
   the UI are unverified — docs describe the data model, not the rendering.

## Sources

[vapi-monitoring]: https://docs.vapi.ai/observability/monitoring-quickstart
[bt-patterns]: https://www.braintrust.dev/docs/observe/patterns/review
[bt-review]: https://www.braintrust.dev/docs/annotate/human-review/manage-review-work
[bland-evals]: https://docs.bland.ai/tutorials/evals
[level]: https://docs.level.ai/