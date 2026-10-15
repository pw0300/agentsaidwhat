/**
 * Redaction for call transcripts.
 *
 * A transcript is the richest PII surface in this product: real people say
 * their phone number, their email, their bank account, their Aadhaar number
 * and their address out loud, and the tester pastes all of it in. Storing that
 * unredacted in a shared Redis document and forwarding it to a model provider
 * is the single thing that stops an enterprise security review dead, so it is
 * handled here rather than in a policy document nobody reads.
 *
 * Two positions this file takes deliberately:
 *
 *  1. Redaction happens on the way IN, at the API boundary, not in the UI. A
 *     user who cannot turn it off cannot accidentally leak, and a new client
 *     (mobile, API, CI) inherits the protection for free. Client-side
 *     redaction would be a suggestion, not a control.
 *
 *  2. Over-redacting is the correct failure. Losing a digit in an email address
 *     costs the QA analyst nothing. Leaking a customer's Aadhaar number into a
 *     third-party inference call costs the deal. So the patterns err wide and
 *     a real entity is replaced with a stable placeholder, not a blank —
 *     `[EMAIL_1]` twice still tells you it was the same person.
 */

/* ---------------- placeholder bookkeeping ---------------- */

export type RedactionKind =
  | 'email' | 'phone' | 'aadhaar' | 'pan' | 'card' | 'account'
  | 'upi' | 'ssn' | 'ifsc' | 'address' | 'ip' | 'dob' | 'name' | 'otp' | 'url'

export interface RedactionHit {
  kind: RedactionKind
  placeholder: string
  /** 1-based index within its own kind, so `[EMAIL_1]` means the first email. */
  n: number
}

export interface RedactionResult {
  text: string
  hits: RedactionHit[]
  /** True when the text was touched at all. */
  changed: boolean
}

/** Ordered: earlier patterns win, and the order is chosen by disambiguation
 *  tests, not by intuition. Two of these interactions are load-bearing:
 *
 *  - A card must be matched before Aadhaar, because a 16-digit card contains a
 *    12-digit Aadhaar-shaped prefix. Run the other way, `4111 1111 1111 1111`
 *    is eaten as an Aadhaar and the last four digits of someone's card survive
 *    in the clear.
 *
 *  - Phone must be matched before Aadhaar, because `+919876543210` is a
 *    12-digit run starting with 9 and is indistinguishable from an Aadhaar by
 *    shape alone. The phone pattern is narrower (a required +91/0 prefix or a
 *    bare 10 digits), so letting it go first costs no Aadhaar its label and
 *    keeps a phone number from being reported to a QA analyst as an identity
 *    document.
 */
const DIGIT_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|shunya|shoonya|sunye|ek|do|teen|tin|chaar|char|paanch|panch|chhe|chhah|che|saat|sat|aath|ath|nau|शून्य|एक|दो|तीन|चार|पांच|पाँच|छह|छः|सात|आठ|नौ)'
const SPOKEN_DIGITS = new RegExp(`(?<![\\p{L}\\p{M}])${DIGIT_WORD}(?:[\\s,.-]+${DIGIT_WORD}){9,}(?![\\p{L}\\p{M}])`, 'giu')

const PATTERNS: { kind: RedactionKind; re: RegExp }[] = [
  // Money and identity documents first — these are the highest-damage leaks and
  // the most specific patterns, so they should claim the digits first.
  { kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: 'phone', re: /(?<![\d+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g },
  { kind: 'aadhaar', re: /\b[2-9]\d{3}(?:[\s-]?\d{4}){2}\b/g },            // 12 digit, no leading 0/1
  { kind: 'pan', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },                          // ABCDE1234F
  { kind: 'ifsc', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },                        // ABCD0123456
  { kind: 'account', re: /\b(?:a\/c|account)\s*(?:no\.?|number|#)?\s*[:.]?\s*\d{9,18}\b/gi },
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'otp', re: /\b(?:otp|one[ -]time (?:password|code)|verification code)\s*(?:is|:)?\s*\d{4,8}\b/gi },

  { kind: 'phone', re: SPOKEN_DIGITS },

  // Contact. Phone is deliberately loose: Indian mobile numbers appear as
  // +91 98765 43210, 09876543210, 98765-43210 and 9876543210 across platforms,
  // and a transcript is transcribed by a human, so the separators are whatever
  // the transcriber typed.
  //
  // The lookbehind/lookahead pair replaces word boundaries here. A `\b` after
  // the optional "0" prefix sits between two word characters, so it can never
  // match and the 0-prefixed form silently never redacts — the exact number
  // style a transcriber is most likely to write out in full.
  { kind: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g },
  { kind: 'upi', re: /\b[\w.+-]+@(?:[a-z][a-z0-9]*)(?![\w-]|\.[\w])/gi },
  { kind: 'phone', re: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g }, // NANP
  { kind: 'phone', re: /\b\d{3}[\s.-]\d{4}[\s.-]\d{4}\b/g },                 // UK-ish
  { kind: 'phone', re: /\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g },

  // Everything else that pins a person to a place, a moment, or a machine.
  { kind: 'dob', re: /\b(?:dob|date of birth|born)\s*(?:is|on)?\s*[:=-]?\s*(?:\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2})\b/gi },
  { kind: 'address', re: /\b(?:address|pata|pin(?:\s*code)?|postal code)\s*[:=-]?[^\n.!?]{0,80}?\b[1-9]\d{5}\b/gi },
  { kind: 'ip', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: 'url', re: /\bhttps?:\/\/\S+/g },
]

/**
 * Luhn check, so a 16-digit number is called a card and a 12-digit number is
 * not. Used only to relabel what a pattern already matched; it never decides
 * whether something is redacted. A number that fails Luhn is still money to
 * somebody, and a transcription typo must not be the thing that leaks it.
 */
function luhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/* ---------------- placeholders ---------------- */

const cap = (k: RedactionKind) => k.toUpperCase()

/**
 * Redact one block of text.
 *
 * `nameHints` lets a tenant supply the literal strings that identify people in
 * their own business — the customer names in the CRM, the agent's own name.
 * Per-tenant hints beat pattern matching because the tool knows things a regex
 * cannot: which of these four names in the transcript is the customer.
 */
export function redact(input: string, nameHints: string[] = []): RedactionResult {
  const hits: RedactionHit[] = []
  const seen = new Map<string, RedactionHit>()

  const placeholderFor = (kind: RedactionKind, match: string): string => {
    // Same value -> same placeholder, which is what makes "[EMAIL_1] … also
    // [EMAIL_1]" legible to a QA analyst reading a redacted call.
    const key = `${kind}:${match}`
    const existing = seen.get(key)
    if (existing) return existing.placeholder
    const n = hits.filter(h => h.kind === kind).length + 1
    const hit: RedactionHit = { kind, n, placeholder: `[${cap(kind)}_${n}]` }
    seen.set(key, hit)
    hits.push(hit)
    return hit.placeholder
  }

  let text = input

  // Names first: a customer name often contains a place ("Prestige Whitefield")
  // and replacing it before the address rule runs keeps the numbering stable.
  for (const raw of nameHints) {
    const name = raw.trim()
    if (name.length < 3) continue
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    text = text.replace(re, () => placeholderFor('name', name.toLowerCase()))
  }

  for (const { kind, re } of PATTERNS) {
    text = text.replace(re, m => {
      // Relabel, never skip. A 13-19 digit run that fails Luhn is still
      // redacted — as a card, because "something number-shaped this long" is
      // money more often than it is not, and a mislabel costs a QA analyst
      // nothing while a miss costs the customer their card.
      const digits = m.replace(/\D/g, '')
      if (kind === 'card' && digits.length >= 13 && !luhn(digits)) return placeholderFor('account', m.trim().toLowerCase())
      return placeholderFor(kind, m.trim().toLowerCase())
    })
  }

  return { text, hits, changed: text !== input }
}

/** Redact every transcript-shaped string in a session or call record. */
export function redactTranscript(transcript: string, nameHints?: string[]): RedactionResult {
  return redact(transcript ?? '', nameHints)
}

/**
 * A short, honest summary of what a redaction pass removed.
 *
 * Shown to the person who submitted the transcript so redaction is visible
 * rather than mysterious — a QA analyst who cannot see that a phone number was
 * masked will assume the tool dropped the whole line and start re-pasting raw
 * data into other tools.
 */
export function describe(hits: RedactionHit[]): string {
  if (hits.length === 0) return 'No personal data detected in this transcript.'
  const byKind = new Map<RedactionKind, number>()
  for (const h of hits) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1)
  const parts = Array.from(byKind.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
  return `Masked ${hits.length} value${hits.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
}

type Dict = Record<string, unknown>

/** Scrub evidence fields only; prompts and structural identifiers stay intact. */
export function scrubState(state: Dict, hints: string[] = []): { state: Dict; hits: number } {
  let hits = 0
  const fields = new Set(['transcript', 'comments', 'text', 'whatHappened', 'expected', 'quote', 'evidence'])
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object') return value
    const next: Dict = {}
    for (const [key, item] of Object.entries(value)) {
      if (fields.has(key) && typeof item === 'string') {
        const res = redact(item, hints)
        hits += res.hits.length
        next[key] = res.text
        if (key === 'transcript' && res.changed) next.redacted = true
      } else next[key] = walk(item)
    }
    return next
  }
  const next = { ...state }
  for (const key of ['sessions', 'calls', 'issues']) {
    if (Array.isArray(state[key])) next[key] = walk(state[key])
  }
  return { state: next, hits }
}
