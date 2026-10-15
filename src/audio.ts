/**
 * Client side of recording storage.
 *
 * The local server stores recordings on disk. The hosted deployment does not
 * store them yet, so an upload there falls back to keeping the filename, and the
 * UI says so plainly instead of pretending the call can be played back later.
 */

import { DEMO_MODE, DEMO_SERVER_REASON } from './mode'

export const AUDIO_ACCEPT = '.mp3,.wav,.m4a,.mp4,.ogg,.oga,.opus,.webm,.flac,.aac,audio/*'

export interface StoredAudio { id: string; name: string; bytes: number; url: string }

export type UploadResult =
  | { ok: true; audio: StoredAudio }
  | { ok: false; unsupported: true; reason: string }
  | { ok: false; unsupported: false; reason: string }

export const audioUrl = (id: string): string => `/api/audio/${encodeURIComponent(id)}`

export async function uploadAudio(file: File, onProgress?: (fraction: number) => void): Promise<UploadResult> {
  if (DEMO_MODE) return { ok: false, unsupported: true, reason: DEMO_SERVER_REASON }
  // XHR rather than fetch, because fetch cannot report upload progress and a
  // 60 MB call recording on a slow link otherwise looks like a frozen page.
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/audio?name=${encodeURIComponent(file.name)}`)
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total) }
    xhr.onerror = () => resolve({ ok: false, unsupported: false, reason: 'Could not reach the server.' })
    xhr.onload = () => {
      const type = xhr.getResponseHeader('content-type') ?? ''
      if (!type.includes('json')) {
        resolve({ ok: false, unsupported: true, reason: 'This server does not store recordings. Run the local server (npm run local) to keep audio with each call.' })
        return
      }
      let data: { error?: string } & Partial<StoredAudio> = {}
      try { data = JSON.parse(xhr.responseText) } catch { /* handled below */ }
      if (xhr.status === 404) {
        resolve({ ok: false, unsupported: true, reason: 'This deployment does not store recordings yet. The filename is kept; run the local server to keep the audio.' })
        return
      }
      if (xhr.status >= 400 || !data.id) {
        resolve({ ok: false, unsupported: false, reason: data.error ?? `Upload failed (${xhr.status}).` })
        return
      }
      resolve({ ok: true, audio: { id: data.id, name: data.name ?? file.name, bytes: data.bytes ?? file.size, url: data.url ?? audioUrl(data.id) } })
    }
    xhr.send(file)
  })
}

/**
 * Peaks for a waveform, one value per bar, 0..1.
 *
 * Decoding a long call costs memory once; after that the bars are a few KB, so
 * they are cached per recording for the life of the tab.
 */
const peakCache = new Map<string, number[]>()

export async function loadPeaks(src: string, bars: number, signal?: AbortSignal): Promise<number[]> {
  const key = `${src}#${bars}`
  const hit = peakCache.get(key)
  if (hit) return hit
  const res = await fetch(src, { signal })
  if (!res.ok) throw new Error(`Recording unavailable (${res.status}).`)
  const buf = await res.arrayBuffer()
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  try {
    const audio = await ctx.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const step = Math.max(1, Math.floor(ch.length / bars))
    const peaks: number[] = []
    let max = 0
    for (let i = 0; i < bars; i++) {
      let p = 0
      const end = Math.min(ch.length, (i + 1) * step)
      for (let j = i * step; j < end; j += 4) { const v = Math.abs(ch[j]); if (v > p) p = v }
      peaks.push(p)
      if (p > max) max = p
    }
    const norm = max > 0 ? peaks.map(p => p / max) : peaks
    peakCache.set(key, norm)
    return norm
  } finally {
    void ctx.close()
  }
}
