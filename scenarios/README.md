# Scenario packs

Packs use YAML, including comments, unquoted keys and block scalars. JSON syntax
is also accepted. Duplicate keys and invalid YAML are rejected.

A pack requires top-level `version: 1`. Unknown versions are rejected.
A pack has non-empty `id` and `name` strings and a non-empty `scenarios` array.
Each scenario requires:

| Field | Type | Meaning |
| --- | --- | --- |
| id | non-empty string | Stable identifier, unique within the pack |
| name | non-empty string | Label shown to reviewers |
| persona | non-empty string | Caller role, knowledge and behavior |
| goal | non-empty string | What the caller wants |
| successCriteria | non-empty array of non-empty strings | Observable pass conditions |
| language | non-empty string | Language or code-switch register, such as `hinglish` |
| callerTurns | optional array of non-empty strings, may be empty | Ordered caller utterances for a caller driver |
| tags | array of non-empty strings, may be empty | Search and coverage labels |

See the three adjacent example packs. Load one in a TypeScript integration:

```ts
import { loadScenarioPack } from '../api/_scenariopack'
const pack = loadScenarioPack(text, 'hinglish-support.yaml')
```

The caller reads the file and supplies its name. Validation errors include that
name and the field path. The loader does not call an agent, select a judge or
import packs into the UI. Map goals, personas and criteria into your suite
runner explicitly. Text scenarios test content; audio criteria need audio and
turn timestamps. Report absent audio as NOT MEASURED.

The CLI checks pack paths in the current directory first, then relative to the
installed package when absent. `npx agentsaidwhat run scenarios/hinglish-support.yaml`
therefore finds the bundled pack from an empty directory; also supply `--agent`
and `--version` as shown in the root README. Existing local packs take precedence.
