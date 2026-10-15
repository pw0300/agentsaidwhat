# Our Agent Said What?! changes

All six implementation items are complete. Each item has its own commit, followed by a final documentation and cleanup commit. No runtime dependencies were added, and no server, API, tool, data, documentation-directory, or license files were changed. The saved data model is unchanged.

## What changed

1. The command palette searches every navigation destination, agent, scenario, logged call and issue across projects. It supports ordered-character fuzzy matching, tester and date searches, direct record opening, theme switching, tester view, new versions and dense mode. Opening a record switches to its project. The palette traps focus and returns it when closed.
2. Call logging supports the requested playback and rating keys, focused timestamped notes, save from a text field and a next-call action that keeps the agent, version and scenario. The shortcut overlay lists logging and playback keys. Saving stops playback. Undo returns to the saved draft if the tester has not started the next call.
3. Calls has keyboard selection and opening, search focus, bulk selection, sortable columns, combined filters and removable filter chips. Agent, version, scenario, tester, problems, recording, dates, search and sorting persist in the URL hash. Dates use UTC calendar days, with inclusive endpoints. The result count shows filtered and total calls. Bulk triage returns selected, unlinked reviewed problems to the queue; pending problems are already there, and findings linked to issues are preserved.
4. Triage shows one finding at a time, the number left and skipped findings. Its recording starts three seconds before the pinned moment, or at zero if no time was pinned. Acceptance creates an issue, rejection requires a note, asking the tester marks the finding as needing clarification, and skip leaves it pending for a later pass. After the queue, the next action is reviewing issues or returning to skipped findings.
5. The issue board supports keyboard selection across columns and within a column, an owner-layer filter and a detail drawer. The drawer shows the originating version, claimed and verified fix versions, every verification with tester, date and note, ownership and resolution. Missing version references are labelled as unavailable. Navigation selects cards; the existing version and verification workflows still determine fix status.
6. Dense mode uses one root CSS class and persists per browser. Saved changes show a six-second toast with working Undo, including "Saved call · Undo" for logging. Undo restores unchanged records without overwriting newer or remote edits. Empty states provide a relevant action, focus rings cover controls and keyboard cards, and waveform and playback-status space stays reserved while audio loads. Native Enter and Space activation on controls remains available.

## Keyboard shortcuts

Shortcuts are ignored while typing in text fields, selects and editable content, except Ctrl/Cmd+Enter and Escape. Ctrl/Cmd+K opens the palette even while typing. Overlays pause screen shortcuts. Space and Enter retain their native behavior on focused buttons, links and inputs.

| Screen | Key | Action |
| --- | --- | --- |
| Anywhere in the app shell | Ctrl/Cmd+K | Open or close the command palette |
| Palette | Up / Down | Select a search result |
| Palette search | Enter | Run the selected result |
| Palette | Escape | Close and restore focus |
| Palette and shortcut overlay | Tab / Shift+Tab | Move focus within the overlay |
| Log a call | Space or K | Play or pause |
| Log a call | J / L | Seek back or forward five seconds |
| Log a call | Left / Right | Seek back or forward five seconds |
| Log a call | , / . | Seek back or forward one second |
| Log a call | [ / ] | Step through 0.75, 1, 1.25, 1.5 and 2 times playback speed |
| Log a call | 1 through 5 | Rate the highlighted parameter and advance |
| Log a call | Up / Down | Focus the previous or next parameter |
| Focused parameter row | Tab / Shift+Tab | Focus the next or previous parameter; at either edge, leave the ratings |
| Log a call | N | Mark the highlighted parameter not applicable |
| Log a call | G | Add a went-right note at the playback time and focus its description |
| Log a call | B or W | Add a went-wrong note at the playback time and focus its description |
| Note description | Enter | Finish a described note |
| Log a call | Ctrl/Cmd+Enter | Save, including while typing |
| Log a call | Escape | Close the note or shortcut overlay |
| Log a call or saved-call screen | ? | Show shortcut help |
| Saved-call screen | N or Ctrl/Cmd+Enter | Log the next call with the same context |
| Calls | J / K | Select the next or previous call |
| Calls | Enter | Open the selected call, or the first shown call |
| Calls | / | Focus search |
| Calls | X | Toggle bulk selection for the selected call, or the first shown call |
| Calls | Escape | Close call details and leave search entry |
| Call details | Space | Play or pause the recording |
| Call details | Left / Right | Seek back or forward five seconds |
| Triage | A | Accept the finding and create an issue |
| Triage | R | Reject if a note is present; otherwise focus the required note |
| Triage rejection note | Enter or Ctrl/Cmd+Enter | Submit a rejection after entering a note |
| Triage | C | Mark the finding as needing tester clarification |
| Triage | S | Skip the finding for this pass |
| Triage with a recording | Space | Play or pause the clip |
| Triage | Escape | Leave rejection-note entry |
| Issue board | H / L | Select a card in the previous or next populated column |
| Issue board | J / K | Select the next or previous card in the current column |
| Issue board | Enter | Open details for the selected card |
| Issue board | Escape | Close the drawer and return focus to the card |
| Focused recording seek bar | Left / Right | Seek five seconds |
| Focused recording seek bar | Home / End | Seek to the start or end |
| Bulk call-file drop area | Enter or Space | Open the file chooser |
| All screens | Tab / Shift+Tab | Navigate native controls with visible focus |

Theme, view and density changes are available as palette actions. Filter controls, sortable headers, bulk actions and toast Undo are reachable using native keyboard navigation.

## Validation and limitations

Validation completed:

- `npm test`: 453 passing, 0 failing across 28 test files.
- `npx tsc -b`: clean.
- `npx tsc -p tsconfig.api.json`: clean.
- `npx vite build`: successful production build.
- `npm run build:server`: generated the bundle required by the existing local-server tests.
- `git diff --check`: clean.

The render-test bundle has a separate filename because this worktree shares its dependency directory with another worktree. This prevents another build from replacing the UI fixtures during a test run. No dependencies were added.

The browser automation tool timed out on both attempts, so a live browser click-through could not be completed. Automated checks cover search, filtering and sorting, navigation, undo, typing protection, overlay suppression and rendered controls and empty states.

"Ask tester" records a clarification request in the workspace; it does not send email or another external message. Release-gate evidence continues to be generated by the existing audit workflow. Its empty-state action leads to analysis setup; this change does not add a server endpoint to run an audit. Neither behavior changes the existing product's data or communication model.
