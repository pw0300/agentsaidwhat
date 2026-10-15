/// <reference types="vite/client" />
// Build-time snapshots also work in packaged local installs and static demos.
import asr from '../data/asr_verdict.json'
import audio from '../data/voice_probe/calibration_verdict.json'
// Include audit evidence if a checkout has produced it before this build.
// Plain esbuild SSR tests do not implement Vite's glob macro.
const evidence = (() => {
  try {
    const snapshots = import.meta.glob('../data/evidence.json', { eager: true, import: 'default' })
    return (snapshots['../data/evidence.json'] ?? null) as Record<string, any> | null
  } catch { return null }
})()
export const gateArtifacts = { asr, audio, evidence }
