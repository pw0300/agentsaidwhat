/**
 * Turn a pasted transcript into lines a player can follow.
 *
 * Transcripts arrive from every calling platform in a slightly different shape,
 * so this is generous about input and strict about output: each line gets a
 * speaker (or none) and a start time in seconds (or none). Lines without a time
 * still render; they just cannot be clicked to seek.
 *
 * Accepted time forms, at the start of a line, bare or in brackets/parens:
 *   0:42   00:42   1:02:03   00:00:42.350   [00:42]   (0:42)   42.5s
 * Accepted speaker forms: "Agent:", "AGENT -", "Customer:", "User:", "Bot:",
 * "Caller:", "Speaker 1:", or any short label followed by a colon.
 */

export type Speaker = 'agent' | 'caller' | 'other'

export interface TranscriptLine {
  index: number
  /** Seconds from the start of the recording, when the line carried a time. */
  atSec: number | null
  /** Raw label as written, e.g. "Agent" or "Speaker 2". */
  label: string
  speaker: Speaker | null
  text: string
}

const TIME = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`
const LEAD_TIME = new RegExp(String.raw`^\s*[\[(]?\s*${TIME}\s*[\])]?\s*[-–—|]?\s*`)
const LEAD_SECONDS = /^\s*[[(]?\s*(\d{1,5}(?:\.\d+)?)s\s*[\])]?\s*[-–—|]?\s*/
const LABEL_TIME = new RegExp(String.raw`^\s*([A-Za-z][A-Za-z0-9 ._'-]{0,23}?)\s*[\[(]\s*${TIME}\s*[\])]\s*[:\-–—]\s*`)
const LABEL = /^\s*([A-Za-z][A-Za-z0-9 ._'-]{0,23}?)\s*(?::|\s-\s|\s—\s)\s*/

const AGENT_WORDS = /^(agent|bot|assistant|ai|system|rep|representative|ivr|voicebot|va)\b/i
const CALLER_WORDS = /^(customer|caller|user|client|human|lead|prospect|patient|guest)\b/i

export function toSeconds(h: string | undefined, m: string, s: string, frac?: string): number {
  const ms = frac ? Number(frac.padEnd(3, '0')) / 1000 : 0
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s) + ms
}

export function formatTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Parse "1:23", "01:02:03" or "83" into seconds. Null when it is not a time. */
export function parseTime(input: string): number | null {
  const t = input.trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  const m = new RegExp(`^${TIME}$`).exec(t)
  return m ? toSeconds(m[1], m[2], m[3], m[4]) : null
}

function classify(label: string): Speaker | null {
  if (!label) return null
  if (AGENT_WORDS.test(label)) return 'agent'
  if (CALLER_WORDS.test(label)) return 'caller'
  return 'other'
}

export function parseTranscript(raw: string): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const rawLine of (raw ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let rest = rawLine
    if (!rest.trim()) continue

    let atSec: number | null = null
    const t = LEAD_TIME.exec(rest)
    if (t) { atSec = toSeconds(t[1], t[2], t[3], t[4]); rest = rest.slice(t[0].length) }
    else {
      const s = LEAD_SECONDS.exec(rest)
      if (s) { atSec = Number(s[1]); rest = rest.slice(s[0].length) }
    }

    let label = ''
    // Some exports put the time between the speaker and the colon:
    // "Agent [00:42]: hello". Handled first, because the plain label pattern
    // stops at the bracket and would see no speaker at all.
    if (atSec == null) {
      const mid = LABEL_TIME.exec(rest)
      if (mid) {
        label = mid[1].trim()
        atSec = toSeconds(mid[2], mid[3], mid[4], mid[5])
        rest = rest.slice(mid[0].length)
      }
    }
    const l = label ? null : LABEL.exec(rest)
    // A label must be short and must not swallow a sentence that merely
    // contains a colon ("Note: the price is..." is speech, not a speaker).
    if (l && l[1].split(/\s+/).length <= 3 && !/^(note|ps|re|fyi)$/i.test(l[1])) {
      label = l[1].trim()
      rest = rest.slice(l[0].length)
    }

    const text = rest.trim()
    if (!text && !label) continue
    out.push({ index: out.length, atSec, label, speaker: classify(label), text })
  }
  return out
}

/** The line being spoken at `sec`: the last timed line that started at or before it. */
export function activeLine(lines: TranscriptLine[], sec: number): number {
  let best = -1
  for (const l of lines) {
    if (l.atSec == null) continue
    if (l.atSec <= sec + 0.05) best = l.index
    else break
  }
  return best
}

export const hasTimes = (lines: TranscriptLine[]): boolean => lines.some(l => l.atSec != null)

/**
 * Convert SRT or WebVTT captions into the line format above.
 *
 * Many calling platforms export captions rather than a transcript. Read as
 * plain text, a cue's "00:00:01,000 --> 00:00:04,000" line would become a line
 * of speech, so cues are rewritten to "[0:01] Speaker: text" first. WebVTT
 * voice tags (<v Agent>) become the speaker label.
 */
export function fromSubtitles(raw: string): string {
  if (!/-->/.test(raw)) return raw
  const blocks = raw.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  const out: string[] = []
  const lead = new RegExp(`^${TIME}`)
  for (const b of blocks) {
    const lines = b.split('\n').map(x => x.trim()).filter(Boolean)
    const i = lines.findIndex(l => l.includes('-->'))
    if (i < 0) continue
    const m = lead.exec(lines[i])
    if (!m) continue
    const sec = toSeconds(m[1], m[2], m[3], m[4])
    const text = lines.slice(i + 1).join(' ')
      .replace(/<v(?:\.[^\s>]+)?\s+([^>]+)>/g, '$1: ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) out.push(`[${formatTime(sec)}] ${text}`)
  }
  return out.join('\n')
}
