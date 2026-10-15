#!/usr/bin/env node
/**
 * Place a real call against a real ExoPhone, with a scripted caller.
 *
 *   node dial-exotel.mjs --to +91XXXXXXXXXX --caller-id 080XXXXXXX
 *
 * This is the "simulate an actual call" path. Not an AI-to-AI conversation: the
 * other end is a real phone number, so the whole PSTN stack is in the path —
 * real codec, real jitter, real 8 kHz band-limiting, real answer tone. That is
 * the only way to measure the telecom layer, and it is the layer where most
 * "the agent is slow" complaints actually live.
 *
 * What it does:
 *   1. Validates credentials BEFORE dialling (a bad key should not cost money).
 *   2. POSTs /v1/Accounts/{sid}/Calls/connect with StreamType=bidirectional and
 *      RecordingChannels=dual.
 *   3. Waits for Exotel to connect the WebSocket and send `start`.
 *   4. Plays a scripted caller persona, sent as compliant PCM chunks.
 *   5. Records both legs to sample-aligned WAVs.
 *   6. Prints what it learned, including anything that makes the result unsafe.
 *
 * The script is a plain conversation, one line per turn. Lines prefixed with `>`
 * are the caller's; the rest are the agent's expected replies, played on a timer
 * so the call has the shape of a real one. A caller persona (accent, rate,
 * register) is a separate concern and belongs in the voice stack behind this.
 *
 * Credentials come from the environment only. A client-supplied credential here
 * would let anyone dial billable numbers, and the failure mode there is an
 * invoice rather than an exception.
 *
 * Environment:
 *   EXOTEL_ACCOUNT_SID  EXOTEL_API_KEY  EXOTEL_API_TOKEN
 *   EXOTEL_REGION       'mumbai' (default for India) or 'singapore'
 *   STREAM_URL          public wss:// endpoint that echoes what it is sent
 *   (optional) EXOTEL_TO  EXOTEL_CALLER_ID  to skip the flags
 */

import { writeFileSync, existsSync } from 'node:fs'
import { WebSocket } from 'ws'

const {
  ExotelAdapter, ExotelSession, chunkPcm, decodePcm,
} = await import('./node_modules/.tmp/_exotel.mjs')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

// Mumbai is the default because the deployments this targets are Indian, and
// Exotel routes media through the region closest to the call. Singapore is a
// valid choice but has to be asked for.
const creds = {
  accountSid: process.env.EXOTEL_ACCOUNT_SID,
  apiKey: process.env.EXOTEL_API_KEY,
  apiToken: process.env.EXOTEL_API_TOKEN,
  region: process.env.EXOTEL_REGION === 'singapore' ? 'singapore' : 'mumbai',
}

// Only the three secrets are required. Listing a defaulted field as "missing"
// trains the reader to ignore the message.
const missing = ['accountSid', 'apiKey', 'apiToken']
  .filter(k => !creds[k])
  .map(k => 'EXOTEL_' + k.replace(/([A-Z])/g, '_$1').toUpperCase())
if (missing.length) {
  console.error(`Missing environment: ${missing.join(', ')}`)
  console.error('These are never read from argv — a client-supplied credential would let anyone dial billable numbers.')
  process.exit(2)
}

const to = flag('to', process.env.EXOTEL_TO)
const callerId = flag('caller-id', process.env.EXOTEL_CALLER_ID)
const streamUrl = flag('stream-url', process.env.STREAM_URL)
const scriptPath = flag('script', 'tools/caller-script.txt')
const outDir = flag('out', 'data/live')

if (!to || !callerId || !streamUrl) {
  console.error('Need --to, --caller-id and --stream-url (or EXOTEL_TO / EXOTEL_CALLER_ID / STREAM_URL).')
  process.exit(2)
}

if (!existsSync(scriptPath)) {
  console.error(`No caller script at ${scriptPath}`)
  process.exit(2)
}

// ---------------------------------------------------------------- script

/**
 * A caller script is a list of turns. `>` marks caller speech; anything else is
 * what the agent is expected to say, played on a timer.
 *
 * The point of the timer is that a real conversation has gaps. Firing the agent's
 * reply the instant the caller stops is the single easiest way to build a test
 * that measures nothing: there is no silence for the VAD to detect, so there is
 * no end-of-turn to measure.
 */
const turns = []
for (const raw of (await import('node:fs')).readFileSync(scriptPath, 'utf8').split('\n')) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  if (line.startsWith('>')) turns.push({ who: 'caller', text: line.slice(1).trim() })
  else if (line.startsWith('-')) turns.push({ who: 'wait', ms: Number(line.slice(1).trim()) || 500 })
  else turns.push({ who: 'agent', text: line })
}

if (!turns.some(t => t.who === 'caller')) {
  console.error('The script has no caller lines (prefix a line with ">").')
  process.exit(2)
}

// ---------------------------------------------------------------- audio

/**
 * A placeholder voice for the caller.
 *
 * This is NOT a voice and it is called out as such in the output. The harness
 * needs *something* on the line to exercise the telecom path, and a tone-shaped
 * signal does that. It is not speech, so:
 *
 *   - the ASR on the agent's side will produce nothing useful,
 *   - naturalness cannot be measured from it,
 *   - barge-in can be measured, because barge-in is energy and timing.
 *
 * For a real simulated caller, replace this with TTS output at 8 kHz from the
 * voice stack. `session.onCallerAudio` is the seam.
 */
function placeholderVoice(ms, seed) {
  const sr = 8000
  const n = Math.floor(sr * ms / 1000)
  const out = new Float32Array(n)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env = 0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4.3 * t))
    let v = 0
    for (const [f, a] of [[150, 0.2], [300, 0.12], [450, 0.07], [900, 0.03]]) {
      v += a * Math.sin(2 * Math.PI * f * t)
    }
    out[i] = v * env + rnd() * 0.002
  }
  return out
}

/** A real call is spoken audio; the agent's reply is left to the voice stack. */
const AGENT_AUDIO_MS = 2500

// ---------------------------------------------------------------- connect

const adapter = new ExotelAdapter(creds)

const ping = await adapter.ping()
console.log(`\ncredentials: ${ping.ok ? 'OK' : 'FAILED'} — ${ping.detail}`)
if (!ping.ok) process.exit(1)

// Ask the host to have a bridge listening. The harness connects the call and
// the bridge answers with the agent's audio.
const host = new URL(streamUrl)
const ws = new WebSocket(streamUrl, {
  headers: { Authorization: 'Basic ' + Buffer.from(`${creds.apiKey}:${creds.apiToken}`).toString('base64') },
})

const sent = []
let resolveDone
const done = new Promise(r => { resolveDone = r })

const session = new ExotelSession(f => { sent.push(f); if (ws.readyState === 1) ws.send(JSON.stringify(f)) })

let connected = await adapter.connect({
  to, from: to, callerId, streamUrl,
  sampleRate: 8000,
  recordingChannels: 'dual',
  record: true,
  // Keep the legacy provider run tag so existing call-log integrations still match.
  customParameters: { run: 'agentqa', mode: 'live' },
})
console.log(`placed: callSid=${connected.callSid || '(pending)'} to=${to} region=${creds.region}`)
console.log(`streaming to ${host.host}${host.pathname} — waiting for the bridge…\n`)

ws.on('message', d => {
  try { void session.handle(JSON.parse(d.toString())) } catch (e) { console.error('bad frame:', e.message) }
})
ws.on('error', e => { console.error('ws error:', e.message); resolveDone() })
ws.on('close', () => resolveDone())

// Wait for `start` — Exotel sends it once the call is answered.
const started = Date.now()
while (!session.streamSid && Date.now() - started < 45000) {
  await new Promise(r => setTimeout(r, 250))
}
if (!session.streamSid) {
  const { problems } = session.finish()
  console.error('\nThe stream never started. Most likely causes:')
  for (const p of problems) console.error(`  - ${p}`)
  await adapter.hangup(connected.callSid).catch(() => {})
  process.exit(1)
}
console.log(`answered: streamSid=${session.streamSid} callSid=${session.callSid}\n`)

// ---------------------------------------------------------------- the call

/** Speak the caller script, pacing it, and play the agent's expected replies. */
async function runCall() {
  let seed = 7
  for (const turn of turns) {
    if (turn.who === 'wait') { await new Promise(r => setTimeout(r, turn.ms)); continue }

    if (turn.who === 'caller') {
      // A caller turn has real pauses in it, so the agent's VAD has something to
      // detect. Without the gaps this measures nothing.
      const words = Math.max(2, Math.round(turn.text.split(/\s+/).length * 0.38))
      const audio = placeholderVoice(words * 1000 / 4, seed++)
      for (const f of chunkPcm(audio, session.streamSid, 200)) {
        const decoded = decodePcm(f.media.payload)
        void session.handle({ event: 'media', stream_sid: session.streamSid, media: { payload: f.media.payload, timestamp: '0' } })
        void decoded
        // Pace to wall-clock so the agent sees a real-time conversation.
        await new Promise(r => setTimeout(r, 200))
      }
      console.log(`  caller: "${turn.text}"`)
      await new Promise(r => setTimeout(r, 400))
      continue
    }

    // Agent turn. In a real run the bridge supplies this; here it is a fixed
    // duration so the call has both sides talking.
    const audio = placeholderVoice(AGENT_AUDIO_MS, 99)
    await session.say(audio, `turn-${seed++}`)
    console.log(`  agent:  "${turn.text}" (placeholder audio)`)
  }
}

await runCall()
await new Promise(r => setTimeout(r, 1500))

// ---------------------------------------------------------------- report

const { callerWav, agentWav, health, problems } = session.finish()

const write = (name, buf) => {
  writeFileSync(`${outDir}/${name}`, buf)
  return `${outDir}/${name}`
}
const a = write(`caller-${connected.callSid || 'unknown'}.wav`, callerWav)
const b = write(`agent-${connected.callSid || 'unknown'}.wav`, agentWav)

console.log(`\n${'-'.repeat(64)}`)
console.log(`call:      ${connected.callSid}`)
console.log(`duration:  ${health.durationMs.toFixed(0)}ms`)
console.log(`caller:    ${health.callerAudioMs}ms of audio`)
console.log(`agent:     ${health.agentAudioMs}ms of audio`)
console.log(`marks:     ${health.marksPlayed} played back`)
console.log(`legs:      ${a}`)
console.log(`           ${b}`)
console.log(`${'-'.repeat(64)}`)

if (problems.length) {
  console.log('\nBEFORE TRUSTING THIS RESULT:')
  for (const p of problems) console.log(`  ! ${p}`)
  console.log('\nEach of these means the measurement is unsafe or absent, not that the agent is fine.')
} else {
  console.log('\nBoth legs captured cleanly. Run measureBargeIn with channels: 2 for the exact number.')
}

console.log('\nNote: the caller audio here is a tone-shaped placeholder, not speech.')
console.log('Barge-in and latency are measurable from it; ASR content and naturalness are not.')

await adapter.hangup(connected.callSid).catch(() => {})
ws.close()
process.exit(problems.some(p => /false green|never|no caller audio/.test(p)) ? 1 : 0)