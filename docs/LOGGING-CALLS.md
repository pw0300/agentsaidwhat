# Logging calls

1. Create a project and agent in Settings. Add the exact prompt version under
   Prompt versions. Keep the prompt and change notes with the evidence.
2. Open Log a call and choose the agent, version and scenario. Attach a recording
   and load or paste a transcript. Local mode stores the recording with the call.
3. Listen and score each applicable rubric parameter from 1 to 5. Mark a parameter
   not applicable if you lack evidence, rather than guessing a score.
4. Add went-right and went-wrong notes at the relevant playback time. Include
   what happened, the expected behavior, severity and the responsible layer.
5. Save the call. Use Calls to review it and Triage to accept, reject or request
   clarification for each finding. Assign an owner and verify claimed fixes with
   new version-pinned evidence on the issue board.

## Logging shortcuts

| Key | Action |
| --- | --- |
| Ctrl/Cmd+K | Search screens, agents, calls and issues |
| Space or K | Play or pause |
| J / L or Left / Right | Seek five seconds back / forward |
| , / . | Seek one second back / forward |
| [ / ] | Change playback speed |
| 1 through 5 | Rate the highlighted parameter and advance |
| Up / Down | Move between parameters |
| N | Mark the highlighted parameter not applicable |
| G | Add a went-right note at the playback time |
| B or W | Add a went-wrong note at the playback time |
| Enter in a described note | Finish the note |
| Ctrl/Cmd+Enter | Save, including while typing |
| ? | Show shortcut help |
| N or Ctrl/Cmd+Enter after saving | Log next call with the same context |

Typing in a field suppresses screen shortcuts except Ctrl/Cmd+Enter, Escape
and Ctrl/Cmd+K. Overlays pause screen shortcuts. Native button and input behavior
still applies. See [the full shortcut reference](UX-CHANGES.md#keyboard-shortcuts)
for Calls, Triage and issue navigation. Saved changes offer Undo for six seconds;
Undo preserves newer edits.
