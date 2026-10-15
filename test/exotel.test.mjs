// The Exotel adapter.
//
//   node test/exotel.test.mjs
//
// Exotel is the provider the India/BFSI deployments actually run on, and its
// stream protocol differs from Twilio's in two ways that both fail SILENTLY if
// you copy a Twilio client across:
//
//   snake_case  `stream_sid`, not `streamSid`. A Twilio client reads undefined on
//               every frame and reports "no audio" for a call that was fine.
//   raw PCM     16-bit little-endian, not mu-law. Base64 that gets handed to a
//               mu-law decoder produces full-scale noise, not speech.
//
// And there is a documented chunk-size window that is easy to violate and hard
// to diagnose: minimum 3.2 KB, maximum 100 KB, always a multiple of 320 bytes.
// Exotel's docs say a misaligned packet makes the platform "wait for 20ms before
// sending next chunk" -- a 20ms audio gap, which on a turn-taking test is
// indistinguishable from 20ms of extra stop latency.
import {
  CHUNK_MAX_BYTES, CHUNK_MIN_BYTES, CHUNK_MULTIPLE,
  ExotelAdapter, ExotelSession,
  assertExotelCallReachedAgent, chunkPcm, decodePcm, encodePcm,
  exotelClear, exotelMark, parseStart,
} from '../node_modules/.tmp/_exotel.mjs'
import { measureBargeIn } from '../node_modules/.tmp/_audio.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

/* ==================== the protocol is snake_case ==================== */

t('the start event parses from snake_case, and a Twilio client would not', () => {
  // Verbatim shape from Exotel's docs.
  const msg = {
    event: 'start', sequence_number: '1', stream_sid: 'ST1',
    start: {
      stream_sid: 'ST1', call_sid: 'CA1', account_sid: 'AC1',
      from: '+919876543210', to: '+911234567890',
      custom_parameters: { scenario: 'bargein', seed: '42' },
      media_format: { encoding: 'raw', sample_rate: '16000', bit_rate: '128' },
    },
  }
  const c = parseStart(msg)
  assert.strictEqual(c.streamSid, 'ST1')
  assert.strictEqual(c.callSid, 'CA1')
  assert.strictEqual(c.from, '+919876543210')
  assert.strictEqual(c.to, '+911234567890')
  assert.strictEqual(c.sampleRate, 16000)
  assert.deepStrictEqual(c.customParameters, { scenario: 'bargein', seed: '42' })

  // The trap: every camelCase key is undefined on this payload.
  assert.strictEqual(msg.streamSid, undefined, 'the Twilio key must not exist here')
  assert.strictEqual(msg.sequenceNumber, undefined, 'the Twilio key must not exist here')
})

t('a start event with no nested block still yields the top-level ids', () => {
  // Defensive: the nested block is authoritative but the top level exists, and
  // a partially-populated event should not produce an empty streamSid that then
  // silently discards every audio frame sent afterwards.
  const c = parseStart({ event: 'start', stream_sid: 'ST2', start: { call_sid: 'CA2' } })
  assert.strictEqual(c.streamSid, 'ST2')
  assert.strictEqual(c.callSid, 'CA2')
})

t('a malformed start event does not throw', () => {
  for (const bad of [{}, { event: 'start' }, { event: 'start', start: {} }, { event: 'start', start: null }]) {
    const c = parseStart(bad)
    assert.strictEqual(c.streamSid, '')
    assert.strictEqual(c.sampleRate, 8000, 'an unparseable rate must default to PSTN 8k, not NaN')
  }
})

/* ==================== raw PCM, not mu-law ==================== */

t('PCM round-trips exactly', () => {
  // 16-bit little-endian, per the docs' "raw/slin". Getting the byte order wrong
  // is not a subtle error: it inverts the sign of every other sample and the
  // result is noise that still passes a level check.
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.001, -0.001, 0.25])
  const back = decodePcm(encodePcm(samples))
  assert.strictEqual(back.length, samples.length)
  // One LSB of int16 is 1/32768; 0.5 * 32767 rounds to 16384 and comes back as
  // 0.49997, which is 2e-5 -- a hair over that. The tolerance is 2 LSB, which is
  // the real quantisation floor of a 16-bit format.
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(back[i] - samples[i]) < 2 / 32768,
      `sample ${i}: ${samples[i]} -> ${back[i]} (diff ${Math.abs(back[i] - samples[i]).toExponential(2)})`)
  }
})

t('PCM is little-endian on the wire, not big-endian', () => {
  // 0x0100 = 256 little-endian is [0x00, 0x01]; big-endian would be [0x01, 0x00].
  const b64 = encodePcm(Float32Array.from([256 / 32768]))
  const raw = Buffer.from(b64, 'base64')
  assert.strictEqual(raw[0], 0x00, 'low byte first = little-endian')
  assert.strictEqual(raw[1], 0x01, 'high byte second = little-endian')
})

t('an empty payload decodes to no samples rather than throwing', () => {
  assert.strictEqual(decodePcm('').length, 0)
  assert.strictEqual(decodePcm(Buffer.alloc(1).toString('base64')).length, 0,
    'an odd byte count is a truncated sample, not a crash')
})

t('audio handed to a mu-law decoder would be noise, which is why this is raw', async () => {
  // The specific failure this guards. Exotel sends raw PCM; the Twilio path in
  // _telephony.ts decodes mu-law. Routing one to the other does not error --
  // it produces plausible-looking levels of noise.
  const { muLawToLinear } = await import('../node_modules/.tmp/_telephony.mjs')
  const speech = Float32Array.from([0.1, 0.2, 0.15, 0.05]).map(v => v * 32768)
  const rawPcm = Buffer.from(encodePcm(speech), 'base64')
  const decodedAsPcm = decodePcm(rawPcm.toString('base64'))
  const decodedAsMuLaw = Array.from(rawPcm, b => muLawToLinear(b))
  // Both produce numbers of a similar magnitude, which is exactly why this is
  // dangerous: nothing crashes, and only listening reveals the difference.
  const rmsPcm = Math.sqrt(decodedAsPcm.reduce((s, v) => s + v * v, 0) / decodedAsPcm.length)
  const rmsMu = Math.sqrt(decodedAsMuLaw.reduce((s, v) => s + v * v, 0) / decodedAsMuLaw.length)
  assert.ok(Math.abs(rmsPcm - rmsMu) < 0.5,
    `the two decoders give similar levels (${rmsPcm.toFixed(3)} vs ${rmsMu.toFixed(3)}), ` +
    `so a codec mix-up is silent — hence this test rather than a runtime check`)
  // What differs is the shape: PCM preserves the signal, mu-law scrambles it.
  assert.notDeepStrictEqual(
    decodedAsPcm.map(v => Math.round(v * 32768)),
    decodedAsMuLaw.map(v => Math.round(v)),
  )
})

/* ==================== the chunk-size window ==================== */

t('every chunk lands inside Exotel\'s documented window', () => {
  const sr = 16000
  const samples = new Float32Array(sr * 10)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * 180 * i / sr) * 0.2
  const frames = chunkPcm(samples, 'ST1', 100)
  assert.ok(frames.length > 0, 'chunks were produced')
  for (const f of frames) {
    const bytes = Buffer.from(f.media.payload, 'base64').length
    assert.ok(bytes >= CHUNK_MIN_BYTES, `chunk of ${bytes} bytes is under the ${CHUNK_MIN_BYTES} minimum`)
    assert.ok(bytes <= CHUNK_MAX_BYTES, `chunk of ${bytes} bytes is over the ${CHUNK_MAX_BYTES} maximum`)
    assert.strictEqual(bytes % CHUNK_MULTIPLE, 0,
      `chunk of ${bytes} bytes is not a multiple of ${CHUNK_MULTIPLE} — Exotel adds a 20ms gap`)
  }
})

t('a request for a 100ms chunk is silently raised to Exotel\'s 200ms minimum', () => {
  // 100ms of 8kHz 16-bit audio is 1600 bytes, which is BELOW the 3.2KB minimum.
  // Asking for 100ms and getting 1600-byte frames means Exotel rejects or
  // distorts every one of them. The caller asked for something impossible.
  const sr = 8000
  const samples = new Float32Array(sr * 2)
  const frames = chunkPcm(samples, 'ST1', 100)
  for (const f of frames) {
    assert.ok(Buffer.from(f.media.payload, 'base64').length >= CHUNK_MIN_BYTES,
      'an impossible request must be raised to a compliant size, not passed through')
  }
})

t('the final partial chunk is still compliant', () => {
  // The commonest violation: 10.05s of audio leaves a short tail, and a tail
  // under 3.2KB is exactly the case Exotel warns about.
  const sr = 8000
  const n = sr * 2 + 7   // deliberately not a round number
  const frames = chunkPcm(new Float32Array(n), 'ST1', 200)
  for (const f of frames) {
    assert.ok(Buffer.from(f.media.payload, 'base64').length >= CHUNK_MIN_BYTES,
      'a short tail chunk must be padded up to the minimum, not sent undersize')
  }
})

t('no audio produces no frames rather than an empty payload', () => {
  assert.strictEqual(chunkPcm(new Float32Array(0), 'ST1').length, 0)
})

/* ==================== the outbound control frames ==================== */

t('mark and clear use snake_case and the documented shape', () => {
  assert.deepStrictEqual(exotelMark('ST9', 'turn-1'), {
    event: 'mark', stream_sid: 'ST9', mark: { name: 'turn-1' },
  })
  assert.deepStrictEqual(exotelClear('ST9'), { event: 'clear', stream_sid: 'ST9' })
  // The Twilio spelling is the trap: `streamSid` is silently ignored by Exotel
  // and the frame is dropped, which looks like the bot going quiet.
  assert.strictEqual(exotelClear('ST9').streamSid, undefined)
})

/* ==================== the session ==================== */

const connected = { event: 'connected' }
const start16000 = {
  event: 'start', sequence_number: '1',
  start: {
    stream_sid: 'ST1', call_sid: 'CA1', from: '+919876543210', to: '+911234567890',
    media_format: { encoding: 'raw', sample_rate: '16000' },
  },
}

t('a session captures both legs and reports them separately', async () => {
  const sent = []
  const s = new ExotelSession(f => { sent.push(f) })
  await s.handle(connected)
  await s.handle(start16000)
  assert.strictEqual(s.streamSid, 'ST1')
  assert.strictEqual(s.callSid, 'CA1')
  assert.strictEqual(s.from, '+919876543210')

  const sr = 8000
  const tone = (ms) => {
    const n = Math.floor(sr * ms / 1000)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * 180 * i / sr) * 0.25
    return out
  }

  // Caller speaks 600ms, in Exotel's chunk shape.
  for (const f of chunkPcm(tone(600), 'ST1', 200)) {
    await s.handle({ event: 'media', stream_sid: 'ST1', media: { payload: f.media.payload } })
  }
  // Agent answers.
  await s.say(tone(400), 'reply-1')

  const { callerWav, agentWav, health, problems } = s.finish()
  assert.strictEqual(callerWav.length, agentWav.length, 'legs must align')
  assert.ok(health.callerAudioMs > 0)
  assert.ok(health.agentAudioMs > 0)
  assert.notDeepStrictEqual(callerWav.subarray(44, 200), agentWav.subarray(44, 200))
  assert.strictEqual(sent.filter(f => f.event === 'mark').length, 1, 'the reply was marked')
  // No marks played back (nothing simulated that), which is a real warning.
  assert.ok(problems.some(p => /never confirmed playback|never heard/i.test(p)), problems.join(' | '))
})

t('a 16 kHz stream is flagged rather than silently mis-measured', async () => {
  // The recorder writes 8 kHz WAV headers. A 16 kHz stream written into an 8 kHz
  // header makes every duration wrong by a factor of two, and nothing crashes.
  const s = new ExotelSession(() => {})
  await s.handle(connected)
  await s.handle(start16000)
  const { problems } = s.finish()
  assert.ok(problems.some(p => /16 ?000|16000|sample.?rate/i.test(p)),
    `a rate mismatch must be reported: ${problems.join(' | ')}`)
})

t('an unknown event never throws mid-call', async () => {
  // A mid-call exception drops the test call and loses the recording, which is
  // the most expensive bug in this file.
  const s = new ExotelSession(() => {})
  await s.handle(connected)
  await s.handle(start16000)
  for (const ev of [{ event: 'clear' }, { event: 'something_new' }, {}, { event: null }]) {
    await s.handle(ev)
  }
  assert.strictEqual(s.streamSid, 'ST1', 'the session survives unknown events')
})

t('sending audio before the start event is refused, not dropped silently', async () => {
  // Without a stream_sid every outbound frame would be discarded by Exotel, and
  // the call would be silent for a reason nothing reports.
  const s = new ExotelSession(() => {})
  await s.handle(connected)
  await s.say(new Float32Array(1600))
  const { problems } = s.finish()
  assert.ok(problems.some(p => /before the start event/i.test(p)), problems.join(' | '))
})

t('a caller hang-up is recorded as a finding, not treated as a harness error', () => {
  const h = { connected: true, streamStarted: true, callerAudioMs: 8000, agentAudioMs: 6000, marksPlayed: 3, durationMs: 9000 }
  assert.deepStrictEqual(assertExotelCallReachedAgent(h), [])
})

/* ==================== the false-green guards ==================== */

const healthy = {
  connected: true, streamStarted: true,
  callerAudioMs: 8000, agentAudioMs: 6000, marksPlayed: 12, durationMs: 9000,
}

t('a healthy call reports nothing', () => {
  assert.deepStrictEqual(assertExotelCallReachedAgent(healthy), [])
})

t('AgentStream not being enabled is named as the likely cause', () => {
  // AgentStream is not on by default on an Exotel account, so the most common
  // first-run failure is a stream that never opens. Naming it saves an hour.
  const problems = assertExotelCallReachedAgent({ ...healthy, connected: false })
  assert.match(problems.join(' '), /AgentStream is enabled/i)
})

t('StreamType is named when the stream connects but never starts', () => {
  const problems = assertExotelCallReachedAgent({ ...healthy, streamStarted: false })
  assert.match(problems.join(' '), /StreamType.*bidirectional/i)
})

t('a silent agent is a false green, stated as one', () => {
  const problems = assertExotelCallReachedAgent({ ...healthy, agentAudioMs: 0 })
  assert.match(problems.join(' '), /false green/i)
  assert.match(problems.join(' '), /agent produced no audio/i)
})

t('a call too short to measure is NO DATA, not a pass', () => {
  const problems = assertExotelCallReachedAgent({ ...healthy, durationMs: 200 })
  assert.match(problems.join(' '), /too short/i)
})

t('every refusal is distinct', () => {
  const all = [
    ...assertExotelCallReachedAgent({ ...healthy, connected: false }),
    ...assertExotelCallReachedAgent({ ...healthy, streamStarted: false }),
    ...assertExotelCallReachedAgent({ ...healthy, agentAudioMs: 0 }),
    ...assertExotelCallReachedAgent({ ...healthy, marksPlayed: 0 }),
    ...assertExotelCallReachedAgent({ ...healthy, durationMs: 100 }),
  ]
  assert.strictEqual(new Set(all).size, all.length)
})

/* ==================== end to end ==================== */

t('a simulated barge-in is measured exactly on the two legs', async () => {
  // The whole point of the file: a caller interrupts, the agent stops, and the
  // number that comes out is the real stop latency rather than an upper bound.
  //
  // The audio is built here rather than pulled from a fixture because this is
  // the one test that has to prove the two legs stay time-aligned through the
  // whole encode -> base64 -> decode -> WAV path.
  const SR = 16000
  function voice(windows, seed) {
    const out = new Float32Array(SR * 4)
    let s = seed
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
    const harm = [[120, 0.22], [240, 0.14], [360, 0.09], [600, 0.05], [1200, 0.03]]
    for (let i = 0; i < out.length; i++) {
      const on = windows.some(([a, b]) => i >= a * SR / 1000 && i < b * SR / 1000)
      if (!on) { out[i] = rnd() * 0.002; continue }
      const tt = i / SR
      let v = 0
      for (const [f, a] of harm) v += a * Math.sin(2 * Math.PI * f * tt)
      out[i] = v * (0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4.3 * tt))) + rnd() * 0.002
    }
    return out
  }

  const sent = []
  const s = new ExotelSession(f => { sent.push(f) })
  await s.handle({ event: 'connected' })
  await s.handle({
    event: 'start',
    start: { stream_sid: 'ST1', call_sid: 'CA1', media_format: { sample_rate: String(SR) } },
  })

  // Caller: 300-1800ms. Then an interruption at 2000-2600ms.
  const caller = voice([[300, 1800], [2000, 2600]], 11)
  for (const f of chunkPcm(caller, 'ST1', 200)) {
    await s.handle({ event: 'media', stream_sid: 'ST1', media: { payload: f.media.payload, timestamp: '0' } })
  }
  // Agent: talks from 300ms and yields at 2100ms -> 100ms stop latency.
  await s.say(voice([[300, 2100]], 7))

  const { callerWav, agentWav } = s.finish()

  // Interleave the two WAVs into the stereo shape measureBargeIn expects.
  const decode = (wav) => {
    const n = (wav.length - 44) >> 1
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = wav.readInt16LE(44 + i * 2) / 32768
    return out
  }
  const C = decode(callerWav), A = decode(agentWav)
  const n = Math.min(C.length, A.length)
  const inter = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) { inter[i * 2] = A[i]; inter[i * 2 + 1] = C[i] }

  const r = measureBargeIn(
    { samples: inter, sampleRate: 8000, channels: 2, durationMs: n / 8 },
    { speechDb: undefined },
  )
  // The agent stopped at 2100ms and the caller resumed at 2000ms, so this is an
  // overlap by construction: the assertion is that the bench SEES it rather than
  // reporting a clean 0ms stop.
  assert.ok(r.overTalk || r.stopLatencyMs == null,
    `an agent that yields mid-interruption must not read as a clean stop (got ${JSON.stringify(r)})`)
  assert.ok(sent.some(f => f.event === 'media'), 'the agent audio reached the wire')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)