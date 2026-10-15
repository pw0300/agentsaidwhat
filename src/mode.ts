declare const __DEMO_MODE__: boolean

// Vite sets this for the static demo. Other build tools default to normal mode.
export const DEMO_MODE = typeof __DEMO_MODE__ !== 'undefined' && __DEMO_MODE__
export const DEMO_SERVER_REASON = 'Install locally to upload files, run simulations or use AI judging.'
