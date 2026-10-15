/**
 * The transcript parser decides which lines a tester can click to jump the
 * audio, and who said them. A wrong time sends the tester to the wrong moment
 * of a call; a wrong speaker paints the agent's line as the caller's. Both are
 * silent, so the formats real platforms export are pinned here.
 */
import assert from 'node:assert/strict'
import { test as t } from 'node:test'
import { parseTranscript, activeLine, formatTime, parseTime, fromSubtitles } from '../node_modules/.tmp/_transcript.mjs'

t('bracketed m:ss with a speaker', () => {
  const [l] = parseTranscript('[00:42] Agent: Namaste, main Priya bol rahi hoon')
  assert.equal(l.atSec, 42)
  assert.equal(l.label, 'Agent')
  assert.equal(l.speaker, 'agent')
  assert.equal(l.text, 'Namaste, main Priya bol rahi hoon')
})

t('h:mm:ss with milliseconds', () => {
  const [l] = parseTranscript('01:02:03.250 Customer: haan boliye')
  assert.equal(l.atSec, 3723.25)
  assert.equal(l.speaker, 'caller')
})

t('bare seconds with an s suffix', () => {
  const [l] = parseTranscript('12.5s User: hello')
  assert.equal(l.atSec, 12.5)
  assert.equal(l.speaker, 'caller')
})

t('time after the speaker, the other common export', () => {
  const [l] = parseTranscript('Bot [01:05]: Your EMI would be about 32,000')
  assert.equal(l.atSec, 65)
  assert.equal(l.speaker, 'agent')
  assert.equal(l.text, 'Your EMI would be about 32,000')
})

t('lines without a time still render, they just cannot seek', () => {
  const lines = parseTranscript('Agent: hi\nCustomer: hello')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].atSec, null)
})

t('a sentence that contains a colon is speech, not a speaker', () => {
  const [l] = parseTranscript('Note: the price includes GST and parking')
  assert.equal(l.label, '')
  assert.match(l.text, /^Note: the price/)
})

t('a long phrase before a colon is not taken as a speaker', () => {
  const [l] = parseTranscript('So what I wanted to ask is: what is the EMI')
  assert.equal(l.label, '')
})

t('an unknown short label is kept but classed as other', () => {
  const [l] = parseTranscript('Speaker 2: kya aap sun pa rahe ho')
  assert.equal(l.label, 'Speaker 2')
  assert.equal(l.speaker, 'other')
})

t('blank lines and CRLF are tolerated', () => {
  const lines = parseTranscript('[0:01] Agent: a\r\n\r\n[0:03] Customer: b\r\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(l => l.index), [0, 1])
})

t('the active line is the last one that started, not the nearest', () => {
  const lines = parseTranscript('[0:01] Agent: a\n[0:05] Customer: b\n[0:09] Agent: c')
  assert.equal(activeLine(lines, 0.5), -1, 'before the first line nothing is active')
  assert.equal(activeLine(lines, 4.9), 0)
  assert.equal(activeLine(lines, 5), 1)
  assert.equal(activeLine(lines, 100), 2)
})

t('formatTime and parseTime round-trip', () => {
  assert.equal(formatTime(42), '0:42')
  assert.equal(formatTime(3723), '1:02:03')
  assert.equal(formatTime(null), '--:--')
  assert.equal(parseTime('1:23'), 83)
  assert.equal(parseTime('01:02:03'), 3723)
  assert.equal(parseTime('42'), 42)
  assert.equal(parseTime('soon'), null)
})

t('SRT captions become timed lines, not lines of "-->" text', () => {
  const srt = `1\n00:00:01,000 --> 00:00:03,000\nAgent: Hello\n\n2\n00:00:04,500 --> 00:00:06,000\nCustomer: Hi there\n`
  const lines = parseTranscript(fromSubtitles(srt))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].atSec, 1)
  assert.equal(lines[1].atSec, 4)
  assert.equal(lines[1].speaker, 'caller')
  assert.ok(!lines.some(l => l.text.includes('-->')))
})

t('WebVTT voice tags become the speaker', () => {
  const vtt = `WEBVTT\n\n00:00:02.000 --> 00:00:04.000\n<v Agent>Namaste</v>\n\n00:00:05.000 --> 00:00:07.000\n<v Customer>Haan</v>`
  const lines = parseTranscript(fromSubtitles(vtt))
  assert.deepEqual(lines.map(l => [l.atSec, l.speaker, l.text]), [[2, 'agent', 'Namaste'], [5, 'caller', 'Haan']])
})

t('text that is not captions passes through untouched', () => {
  assert.equal(fromSubtitles('Agent: hi'), 'Agent: hi')
})
