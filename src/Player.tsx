import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadPeaks } from './audio'
import { EmptyState } from './nav'
import { activeLine, formatTime, parseTranscript, type TranscriptLine } from './transcript'

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

export interface AudioClock {
  ref: React.RefObject<HTMLAudioElement>
  time: number
  duration: number
  playing: boolean
  rate: number
  ready: boolean
  error: string
  toggle: () => void
  seek: (sec: number) => void
  nudge: (delta: number) => void
  setRate: (r: number) => void
}

export const RATES = [0.75, 1, 1.25, 1.5, 2]

/** One audio element, exposed as state. Time updates at animation rate while playing. */
export function useAudioClock(src: string | null, initialTime = 0): AudioClock {
  const ref = useRef<HTMLAudioElement>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRateState] = useState(1)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setTime(0); setDuration(0); setPlaying(false); setReady(false); setError('') }, [src])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const tick = () => { setTime(el.currentTime); raf = requestAnimationFrame(tick) }
    const onPlay = () => { setPlaying(true); raf = requestAnimationFrame(tick) }
    const onPause = () => { setPlaying(false); cancelAnimationFrame(raf); setTime(el.currentTime) }
    const onMeta = () => { setDuration(Number.isFinite(el.duration) ? el.duration : 0); setReady(true) }
    const onLoadedMetadata = () => { onMeta(); el.currentTime = Math.max(0, Math.min(initialTime, Number.isFinite(el.duration) ? el.duration : initialTime)); setTime(el.currentTime); el.playbackRate = rate }
    const onSeeked = () => setTime(el.currentTime)
    const onErr = () => setError('This recording could not be played. The file may be missing or in a format this browser cannot decode.')
    el.addEventListener('play', onPlay); el.addEventListener('pause', onPause); el.addEventListener('ended', onPause)
    el.addEventListener('loadedmetadata', onLoadedMetadata); el.addEventListener('durationchange', onMeta)
    el.addEventListener('seeked', onSeeked); el.addEventListener('error', onErr)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('play', onPlay); el.removeEventListener('pause', onPause); el.removeEventListener('ended', onPause)
      el.removeEventListener('loadedmetadata', onLoadedMetadata); el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('seeked', onSeeked); el.removeEventListener('error', onErr)
    }
  }, [src, initialTime])

  const seek = useCallback((sec: number) => {
    const el = ref.current
    if (!el) return
    const max = Number.isFinite(el.duration) ? el.duration : sec
    el.currentTime = Math.max(0, Math.min(max, sec))
    setTime(el.currentTime)
  }, [])
  const toggle = useCallback(() => {
    const el = ref.current
    if (!el || !src) return
    if (el.paused) void el.play().catch(() => setError('Playback was blocked. Click play again.'))
    else el.pause()
  }, [src])
  const nudge = useCallback((d: number) => { const el = ref.current; if (el) seek(el.currentTime + d) }, [seek])
  const setRate = useCallback((r: number) => { const el = ref.current; if (el) el.playbackRate = r; setRateState(r) }, [])

  return { ref, time, duration, playing, rate, ready, error, toggle, seek, nudge, setRate }
}

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

export interface Marker { atSec: number; kind: 'went-wrong' | 'went-well'; label: string }

const BARS = 220

export function Player({ src, clock, markers = [], onMarker }: {
  src: string | null
  clock: AudioClock
  markers?: Marker[]
  onMarker?: (atSec: number) => void
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [peakErr, setPeakErr] = useState(false)
  const wave = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPeaks(null); setPeakErr(false)
    if (!src) return
    const ac = new AbortController()
    loadPeaks(src, BARS, ac.signal).then(setPeaks).catch(() => { if (!ac.signal.aborted) setPeakErr(true) })
    return () => ac.abort()
  }, [src])

  const dur = clock.duration
  const pct = dur > 0 ? Math.min(1, clock.time / dur) : 0

  const seekFromEvent = (e: React.MouseEvent) => {
    const box = wave.current?.getBoundingClientRect()
    if (!box || dur <= 0) return
    clock.seek(((e.clientX - box.left) / box.width) * dur)
  }

  if (!src) return null

  return (
    <div className="player">
      <audio ref={clock.ref} src={src} preload="metadata" />
      <div className="player-row">
        <button className="play-btn" onClick={clock.toggle} aria-label={clock.playing ? 'Pause' : 'Play'} title="Play / pause (Space)">
          {clock.playing ? '❚❚' : '▶'}
        </button>
        <div className="player-time" aria-live="off">
          <strong>{formatTime(clock.time)}</strong>
          <span className="muted"> / {formatTime(dur || null)}</span>
        </div>
        <div className="spacer" />
        <button className="btn small secondary" onClick={() => clock.nudge(-5)} title="Back 5s (←)">−5s</button>
        <button className="btn small secondary" onClick={() => clock.nudge(5)} title="Forward 5s (→)">+5s</button>
        <select className="rate" value={clock.rate} onChange={e => clock.setRate(Number(e.target.value))} aria-label="Playback speed" title="Speed ([ and ])">
          {RATES.map(r => <option key={r} value={r}>{r}×</option>)}
        </select>
      </div>

      <div ref={wave} className={`wave ${peaks ? '' : 'flat'}`} onClick={seekFromEvent} role="slider"
        aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(clock.time)}
        tabIndex={0} onKeyDown={e => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault()
            if (e.key === 'Home') clock.seek(0)
            else if (e.key === 'End') clock.seek(dur)
            else clock.nudge(e.key === 'ArrowLeft' ? -5 : 5)
          }
        }}>
        {peaks
          ? peaks.map((p, i) => (
            <span key={i} className={i / BARS < pct ? 'on' : ''} style={{ height: `${Math.max(6, p * 100)}%` }} />
          ))
          : <div className="wave-track"><div className="wave-fill" style={{ width: `${pct * 100}%` }} /></div>}
        {dur > 0 && markers.map((m, i) => (
          <button key={i} className={`wave-marker ${m.kind}`} style={{ left: `${(m.atSec / dur) * 100}%` }}
            aria-label={`${formatTime(m.atSec)}: ${m.label}`} title={`${formatTime(m.atSec)} · ${m.label}`}
            onClick={e => { e.stopPropagation(); clock.seek(m.atSec); onMarker?.(m.atSec) }} />
        ))}
        <div className="wave-head" style={{ left: `${pct * 100}%` }} />
      </div>
      <div className="player-status muted" role="status">{clock.error || (peakErr ? 'Waveform unavailable for this file; playback and seeking still work.' : '')}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

export function TranscriptView({ text, clock, onPin, maxHeight = 460 }: {
  text: string
  clock: AudioClock | null
  onPin?: (line: TranscriptLine) => void
  maxHeight?: number
}) {
  const lines = useMemo(() => parseTranscript(text), [text])
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const active = clock && clock.duration > 0 ? activeLine(lines, clock.time) : -1
  const timed = lines.some(l => l.atSec != null)

  useEffect(() => {
    if (!follow || active < 0 || !box.current) return
    const el = box.current.querySelector<HTMLElement>(`[data-line="${active}"]`)
    if (!el) return
    const top = el.offsetTop - box.current.clientHeight / 3
    box.current.scrollTo({ top, behavior: 'smooth' })
  }, [active, follow])

  if (!lines.length) return <EmptyState icon="Transcript" title="No transcript yet" body="Include a transcript when logging a call." actionLabel="Log a call" to="score" />

  const q = query.trim().toLowerCase()
  const hits = q ? lines.filter(l => l.text.toLowerCase().includes(q) || l.label.toLowerCase().includes(q)).length : 0

  return (
    <div className="transcript">
      <div className="transcript-tools">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search transcript" aria-label="Search transcript" />
        {q && <span className="muted">{hits} match{hits === 1 ? '' : 'es'}</span>}
        <div className="spacer" />
        {clock && timed && (
          <label className="toggle"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> Follow audio</label>
        )}
      </div>
      {clock && !timed && (
        <p className="muted" style={{ margin: '4px 0 8px' }}>This transcript has no timestamps, so lines cannot be clicked to seek. Lines like <code>[00:42] Agent: …</code> can.</p>
      )}
      <div className="transcript-lines" ref={box} style={{ maxHeight }}>
        {lines.map(l => {
          const match = q && (l.text.toLowerCase().includes(q) || l.label.toLowerCase().includes(q))
          return (
            <div key={l.index} data-line={l.index}
              className={`tline ${l.speaker ?? 'none'} ${l.index === active ? 'active' : ''} ${q && !match ? 'dim' : ''}`}>
              <button className="tline-time" disabled={l.atSec == null || !clock}
                onClick={() => l.atSec != null && clock?.seek(l.atSec)}
                title={l.atSec != null ? 'Play from here' : undefined}>
                {l.atSec != null ? formatTime(l.atSec) : ''}
              </button>
              <div className="tline-body">
                {l.label && <span className="tline-who">{l.label}</span>}
                <span className="tline-text">{l.text}</span>
              </div>
              {onPin && (
                <button className="tline-pin" onClick={() => onPin(l)} title="Add a note about this line">+ note</button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
