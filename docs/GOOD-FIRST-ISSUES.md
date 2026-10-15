# Good first issues

These are proposed tasks, not promises that an issue is already open. Pick one,
describe the scope in a pull request and use synthetic or licensed material.
Scenario tasks should change one pack and its loader tests. Text criteria must
not claim to measure audio. Run the checks in [CONTRIBUTING.md](../CONTRIBUTING.md).

1. **Tamil-English delivery pack.** Add three scenarios for status, address
   correction and cancellation. Acceptance: version 1 YAML loads; each scenario
   has callerTurns, explicit language tags and observable criteria; a fluent
   reviewer checks the wording.
2. **Bengali-English appointment pack.** Add three scenarios for rescheduling,
   date ambiguity and confirmation. Acceptance: loader tests pass; criteria
   require confirming date and time without inventing availability; bilingual
   wording is reviewed.
3. **Marathi-English returns pack.** Add three scenarios for refund status,
   damaged goods and missing receipt. Acceptance: caller turns include a
   correction; criteria prohibit invented refund policy; language review and
   loader coverage are included.
4. **Kannada-English billing pack.** Add three scenarios for disputed charges,
   duplicate payment and statement requests. Acceptance: no real account data;
   explicit confirmation criteria; bilingual review and passing loader tests.
5. **Travel booking pack.** Add three scenarios covering date correction,
   unavailable options and baggage-policy uncertainty. Acceptance: fictional
   inventory; every success criterion is observable from a transcript; all IDs
   are unique and the pack loads.
6. **Retail delivery pack.** Add three scenarios for lost parcels, address
   changes and partial delivery. Acceptance: no fabricated tracking status is
   accepted; escalation conditions are explicit; loader tests cover all scenarios.
7. **Banking support pack.** Add three fictional scenarios for card blocking,
   an unknown charge and a failed transfer. Acceptance: no real financial data
   or credentials; criteria require appropriate escalation and prohibit
   unsupported promises; the YAML loads.
8. **Appointment scheduling pack.** Add three non-clinical scenarios for booking,
   cancellation and opening hours. Acceptance: no medical advice; missing
   availability triggers clarification; callerTurns and loader tests exist.
9. **Repeated-answer loop detector.** Add a pure text detector for three repeated
   agent answers with no new information. Acceptance: synthetic positive,
   paraphrase and legitimate repetition controls; report evidence spans and
   explicitly state that speech repetition is not measured.
10. **Hindi quickstart translation.** Translate QUICKSTART.md into a new linked
    file. Acceptance: commands and environment names stay exact; a fluent
    reviewer checks it; links resolve and sample-data limits remain visible.
11. **Tamil logging guide translation.** Translate LOGGING-CALLS.md into a new
    linked file. Acceptance: shortcut keys remain exact; evidence and
    not-applicable instructions remain clear; a fluent reviewer checks it.
12. **Scenario validation guide.** Add a small table of missing version, duplicate
    IDs and wrong callerTurns types to the scenario README. Acceptance: each
    example's actual loader error names the file and field; no extra dependency.
13. **Gate policy worked example.** Add a fictional five-call example to
    RELEASE-GATE.md. Acceptance: demonstrate pass, fail and inconclusive with
    reproducible inputs; missing scores never pass; calculations match the gate.
14. **Accessible disabled-action descriptions.** Connect upload and simulation
    explanations with aria-describedby. Acceptance: descriptions announce on
    focus where possible; disabled controls remain disabled in the demo; normal
    local controls retain their behavior.
15. **Recording format guide.** Document supported audio extensions and the
    local 200 MB upload limit. Acceptance: values match server/local.mjs;
    include unsupported-format and oversized-file examples; explain that text
    redaction does not anonymise audio and never add a real recording.
