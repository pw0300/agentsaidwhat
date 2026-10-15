import { FAULTS, injectFault, type Call, type Turn } from './faults'

export function random(seed: number): () => number {
  let s = seed >>> 0
  return () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}
const DOMAINS = [
  { name: 'real-estate', ask: ['What is the viewing fee?', 'Flat dekhne ka charge kitna hai?', 'Flat देखने का charge कितना है?'], answer: ['The viewing fee is 500 rupees.', 'Viewing ka charge 500 rupees hai.', 'Viewing का charge 500 rupees है.'], action: ['Arrange a viewing for tomorrow.', 'Kal ke liye viewing rakh dijiye.', 'कल के लिए viewing रख दीजिए.'] },
  { name: 'bank', ask: ['When will my replacement card arrive?', 'Replacement card kis date ko aayega?', 'Replacement card किस date को आएगा?'], answer: ['Your replacement card will arrive on 15 November.', 'Aapka replacement card 15 November ko aayega.', 'आपका replacement card 15 November को आएगा.'], action: ['Send it to my registered address.', 'Registered address pe bhej dijiye.', 'Registered address पर भेज दीजिए.'] },
  { name: 'food-delivery', ask: ['What is the total for my order?', 'Mere order ka total kitna hua?', 'मेरे order का total कितना हुआ?'], answer: ['Your order total is 500 rupees.', 'Aapke order ka total 500 rupees hai.', 'आपके order का total 500 rupees है.'], action: ['Place the order for home delivery.', 'Home delivery ke liye order kar dijiye.', 'Home delivery के लिए order कर दीजिए.'] },
  { name: 'telecom', ask: ['What does this recharge cost?', 'Is recharge ka kitna lagega?', 'इस recharge का कितना लगेगा?'], answer: ['This recharge costs 500 rupees.', 'Is recharge ke 500 rupees lagenge.', 'इस recharge के 500 rupees लगेंगे.'], action: ['Recharge my registered number.', 'Registered number pe recharge kar dijiye.', 'Registered number पर recharge कर दीजिए.'] },
]
export const LANGUAGES = ['English', 'Hinglish-Latin', 'Hinglish-mixed']
export interface CallSet { schemaVersion: number; seed: number; calls: Call[] }
export function baseCall(index: number, variant: number): Call {
  const d = DOMAINS[index % DOMAINS.length], l = Math.floor(index / DOMAINS.length) % 3
  // The caller explicitly changes language, so the target language is observable.
  const switchRequest = l === 0 ? 'Please Hindi mein baat kijiye.' : 'Please switch to English now.'
  const prefix = variant % 2 ? ['Hi, ', 'Hello, ', 'Hello, '][l] : ''
  const texts = [prefix + d.ask[l], d.answer[l], switchRequest,
    l === 0 ? 'Haan, ab Hindi mein baat karte hain. Bataiye.' : "Sure, let's continue in English. What would you like me to do?",
    l === 0 ? d.action[1] : d.action[0],
    l === 0 ? 'Theek hai, pehle confirm kar dijiye, kya main request submit kar doon?' : 'Please confirm: should I submit this request?',
    l === 0 ? 'Haan, confirm hai. Submit kar dijiye.' : 'Yes, I confirm. Please submit it.',
    l === 0 ? 'Request submit ho gayi. Koi approval fee nahi hai.' : 'Your request has been submitted. There is no approval fee.',
    l === 0 ? 'Theek hai, shukriya. Bye.' : 'Thanks, that is all. Goodbye.',
    l === 0 ? 'Shukriya, bye.' : 'Thanks. Goodbye.']
  let cursor = 0
  const turns: Turn[] = texts.map((text, i) => { const startMs = cursor; const endMs = startMs + 1500 + text.split(/\s+/).length * 100; cursor = endMs + 300; return { role: i % 2 ? 'agent' : 'caller', text, startMs, endMs } })
  return { id: `call-${String(index + 1).padStart(4, '0')}`, domain: d.name, language: LANGUAGES[l], context: `Facts: ${d.answer[0]} Policy: no approval fee. Ask for confirmation before submitting the request. Follow the caller's explicit language preference.`, turns, faults: [] }
}
export function generate(seed = 20261013, count = 300): CallSet {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer')
  const rng = random(seed)
  // Exact clean share, then evenly cycle first faults with seeded ordering.
  const cleanCount = Math.round(count * 0.3)
  const order = FAULTS.map(f => f.id)
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  const calls: Call[] = []
  for (let i = 0; i < count; i++) {
    const c = baseCall(i, Math.floor(rng() * 100))
    if (i >= cleanCount) {
      const first = FAULTS.find(f => f.id === order[(i - cleanCount) % order.length])!
      const selected = [first]
      if ((i - cleanCount) % 2 === 0) {
        const choices = FAULTS.filter(f => f.id !== first.id && f.turnIndex !== first.turnIndex
          && !(f.id === 'asr-mishear' && first.turnIndex === 5) && !(first.id === 'asr-mishear' && f.turnIndex === 5)
          && !(f.id === 'early-hangup' && first.turnIndex > 6) && !(first.id === 'early-hangup' && f.turnIndex > 6))
        selected.push(choices[Math.floor(rng() * choices.length)])
      }
      // Truncation runs last; distinct targets preserve each injected fault.
      selected.sort((a, b) => Number(a.id === 'early-hangup') - Number(b.id === 'early-hangup') || a.turnIndex - b.turnIndex)
      for (const f of selected) injectFault(c, f.id)
    }
    calls.push(c)
  }
  // Mix clean and faulty cases; no label/order information reaches detectors.
  for (let i = calls.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [calls[i], calls[j]] = [calls[j], calls[i]] }
  return { schemaVersion: 1, seed, calls }
}
