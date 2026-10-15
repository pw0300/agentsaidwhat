import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redact, scrubState } from '../dist-server/lib.mjs'

test('Hinglish UPI, address PIN and full DOB are masked conservatively', () => {
  const result = redact('Mera UPI asha@okaxis hai. Address: MG Road, Pune PIN 411001. DOB: 12/05/1990. Born on 1990-05-12. Ticket 411002, meeting 12/05/1990.')
  assert.ok(!result.text.includes('asha@okaxis'))
  assert.ok(!result.text.includes('411001'))
  assert.equal(result.text.match(/12\/05\/1990/g)?.length, 1)
  assert.ok(!result.text.includes('1990-05-12'))
  assert.ok(result.text.includes('Ticket 411002'))
  assert.ok(!redact('UPI name@bank. Please pay here.').text.includes('name@bank'))
})

test('English Hindi and Devanagari spoken digit runs are masked', () => {
  for (const spoken of ['nine eight seven six five four three two one zero', 'nau aath saat chhe paanch chaar teen do ek shunya', 'नौ आठ सात छह पांच चार तीन दो एक शून्य', 'nine aath seven chhe five chaar three do one shunya']) {
    const result = redact(`Mera phone ${spoken} hai, please call karo.`)
    assert.ok(result.changed, spoken)
    assert.ok(!result.text.includes(spoken))
  }
  assert.equal(redact('one two three tasks, नौ आठ सात samples').changed, false)
})

test('state scrubbing covers observations comments and finding evidence without touching prompts', () => {
  const pii = 'Customer asha@okaxis, DOB 12/05/1990, phone 9876543210'
  const input = { sessions: [{ id: 's', comments: pii, observations: [{ text: pii, whatHappened: pii, expected: pii, quote: pii }] }], calls: [{ id: 'c', findings: [{ evidence: pii }], comments: pii }], issues: [{ id: 'i', comments: pii }], versions: [{ id: 'v', promptText: pii }] }
  const { state, hits } = scrubState(input)
  assert.ok(hits > 0)
  assert.ok(!JSON.stringify({ sessions: state.sessions, calls: state.calls, issues: state.issues }).includes('9876543210'))
  assert.ok(!JSON.stringify(state.sessions).includes('asha@okaxis'))
  assert.equal(state.versions[0].promptText, pii)
  assert.equal(input.sessions[0].comments, pii)
})
