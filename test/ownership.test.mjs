// The layer -> team map, and the free-text normaliser.
//
//   npm test
//
// Two things are guarded here and both matter commercially:
//
//  1. The client map (`LAYER_TEAM` in src/types.ts) is a deliberate duplicate
//     of the server map (`LAYER_OWNER` in api/_voicebench.ts), because the
//     server file must not be imported into the browser bundle. A duplicate
//     without a guard drifts, and a layer that routes to the wrong team sends
//     an engineer to the wrong codebase — which is worse than not routing at
//     all, because it costs them an hour before they notice.
//
//  2. `toFailureLayer` receives prose from an LLM judge. The dangerous failure
//     is a confident mis-route, so the tests below assert that unrecognised and
//     pseudo-layer labels land on `unknown` rather than on the nearest match.
import assert from 'node:assert'
import { LAYER_TEAM, LAYER_FIRST_CHECK, toFailureLayer } from '../src/types.ts'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

/* ==================== the map is complete ==================== */

t('every layer has a team and a first check', () => {
  const layers = ['prompt', 'voice-tts', 'vad', 'asr', 'llm', 'telecom', 'platform', 'unknown']
  for (const l of layers) {
    assert.ok(LAYER_TEAM[l], `${l} has no team`)
    assert.ok(LAYER_TEAM[l].length > 5, `${l} team name is too terse to route on`)
    assert.ok(LAYER_FIRST_CHECK[l], `${l} has no first check`)
    assert.ok(LAYER_FIRST_CHECK[l].length > 30, `${l} first check gives no next step`)
  }
})

t('the unknown layer is visibly unowned, not silently mis-owned', () => {
  // "Unattributed — needs a human" is the honest string. A team name here
  // would mean every unroutable defect gets dumped on one team by default.
  assert.match(LAYER_TEAM.unknown, /unattributed|human/i)
  assert.doesNotMatch(LAYER_TEAM.unknown, /prompt|voice|vad|telephony/i)
})

t('the team names name a team, not a technology', () => {
  // "TTS team" would have an engineer checking whether it is theirs.
  // "Voice & TTS settings" tells them where to look without being told.
  for (const [layer, team] of Object.entries(LAYER_TEAM)) {
    if (layer === 'unknown') continue
    assert.ok(team.length > 14, `${layer}: "${team}" is too short to be an owning function`)
  }
  assert.match(LAYER_TEAM.prompt, /prompt/i)
  assert.match(LAYER_TEAM.vad, /turn-taking|vad/i)
  assert.match(LAYER_TEAM.platform, /telephony|platform/i)
})

/* ==================== the normaliser ==================== */

t('recognised labels map to their layer', () => {
  assert.strictEqual(toFailureLayer('prompt'), 'prompt')
  assert.strictEqual(toFailureLayer('voice-tts'), 'voice-tts')
  assert.strictEqual(toFailureLayer('vad'), 'vad')
  assert.strictEqual(toFailureLayer('platform'), 'telecom')
})

t('prose from the judge maps to the right team', () => {
  // These are the shapes an LLM judge actually produces, not the enum values.
  assert.strictEqual(toFailureLayer('The prompt says to offer X but the agent did Y'), 'prompt')
  assert.strictEqual(toFailureLayer('speech recognition dropped the last word'), 'asr')
  assert.strictEqual(toFailureLayer('transcription error on the price'), 'asr')
  assert.strictEqual(toFailureLayer('TTS audio is clipped'), 'voice-tts')
  assert.strictEqual(toFailureLayer('voice sounds robotic'), 'voice-tts')
  assert.strictEqual(toFailureLayer('elevenlabs stability is too high'), 'voice-tts')
  assert.strictEqual(toFailureLayer('barge-in was not detected'), 'vad')
  assert.strictEqual(toFailureLayer('turn taking is slow'), 'vad')
  assert.strictEqual(toFailureLayer('latency too high'), 'vad')
})

t('a pseudo-layer is not a layer', () => {
  // `simulation` records provenance, not ownership. A simulated caller is not
  // a customer with a complaint, so routing it to a team would be a fiction.
  for (const s of ['simulation', 'simulated', 'synthetic', 'Simulated caller']) {
    assert.strictEqual(toFailureLayer(s), 'unknown', `"${s}" should not route to a team`)
  }
})

t('anything unrecognised falls back to unknown rather than the nearest match', () => {
  // This is the load-bearing case. Forcing an unmatched label into the closest
  // layer sends an engineer to the wrong codebase, and they only find out after
  // an hour. An admitted unknown costs a human thirty seconds.
  for (const s of ['unknown', '', '???', 'quantum', 'general', null, undefined, 'ui/ux']) {
    assert.strictEqual(toFailureLayer(s), 'unknown', `"${s}" should be unknown`)
  }
})

t('normalisation is case-insensitive', () => {
  assert.strictEqual(toFailureLayer('PROMPT'), 'prompt')
  assert.strictEqual(toFailureLayer('Barge-In'), 'vad')
  assert.strictEqual(toFailureLayer('ElevenLabs'), 'voice-tts')
})

t('an ambiguous label goes to the unknown bucket, not the first match', () => {
  // "prompt and voice both wrong" has no single owner, and picking the first
  // keyword silently converts a two-team problem into a one-team problem.
  assert.strictEqual(toFailureLayer('prompt and voice quality'), 'unknown')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)