/**
 * saidwhat, running on your own machine.
 *
 *   npx agentsaidwhat            -> http://localhost:5199
 *
 * One process, one SQLite file, one folder of audio. No Vercel, no Redis, no
 * account. This is the version someone who just cloned the repo can use for
 * real work in five minutes, and it is the same app: the UI talks the same
 * /api/state protocol to this server that it talks to the hosted one.
 *
 * WHERE DATA LIVES
 *
 *   $AGENT_QA_HOME/agent-qa.db     workspace, revisions, audit log
 *   $AGENT_QA_HOME/audio/<id>.<ext> recordings, as uploaded
 *
 * AGENT_QA_HOME defaults to ./agent-qa-data under the directory you ran it in,
 * so a project's QA record sits next to the project and is easy to back up.
 *
 * WHY THE WORKSPACE IS ONE DOCUMENT
 *
 * The hosted store keeps one JSON document per tenant and the client merges
 * three ways against it. Normalising it into tables here would mean two data
 * models and a translation layer between them, and the first bug in that layer
 * would show a tester different data locally than in production. So SQLite
 * holds the same document, with a revision number for compare-and-set and an
 * append-only history table so nothing a tester logged can be lost by a bad
 * merge -- every revision is kept and can be restored.
 *
 * Binds to 127.0.0.1 by default. Set HOST=0.0.0.0 to share it on a LAN; there
 * is no sign-in in local mode, so only do that on a network you trust.
 */

import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

export const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm',
  '.flac': 'audio/flac', '.aac': 'audio/aac',
}
// Signature checks identify the container, not the quality or safety of its contents.
function matchesAudio(buf, ext) {
  const at = (offset, text) => buf.subarray(offset, offset + text.length).toString('ascii') === text
  switch (ext) {
    case '.wav': return at(0, 'RIFF') && at(8, 'WAVE')
    case '.mp3': return at(0, 'ID3') || (buf.length >= 3 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x18) !== 0x08 && (buf[1] & 0x06) !== 0 && (buf[2] & 0xf0) !== 0xf0)
    case '.ogg': case '.oga': case '.opus': return at(0, 'OggS')
    case '.flac': return at(0, 'fLaC')
    case '.m4a': case '.mp4': return at(4, 'ftyp')
    case '.webm': return buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    case '.aac': return buf.length >= 4 && buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0
    default: return false
  }
}
const displayName = name => String(name).split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 200) || 'recording'

const MAX_AUDIO_BYTES = 200 * 1024 * 1024   // a 2-hour mono call at 128 kbps is ~115 MB
const MAX_STATE_BYTES = 50 * 1024 * 1024
const HISTORY_KEEP = 500

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export function openStore(home) {
  mkdirSync(join(home, 'audio'), { recursive: true })
  // Legacy database filename preserves existing workspaces after the brand rename.
  const db = new DatabaseSync(join(home, 'agent-qa.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS workspace (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rev INTEGER NOT NULL,
      doc TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      rev INTEGER PRIMARY KEY,
      doc TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audio (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      meta TEXT
    );
  `)
  const q = {
    read: db.prepare('SELECT rev, doc FROM workspace WHERE id = 1'),
    insert: db.prepare('INSERT INTO workspace (id, rev, doc, updated_at) VALUES (1, ?, ?, ?)'),
    cas: db.prepare('UPDATE workspace SET rev = ?, doc = ?, updated_at = ? WHERE id = 1 AND rev = ?'),
    hist: db.prepare('INSERT OR REPLACE INTO history (rev, doc, at) VALUES (?, ?, ?)'),
    prune: db.prepare('DELETE FROM history WHERE rev <= ?'),
    histList: db.prepare('SELECT rev, at, length(doc) AS bytes FROM history ORDER BY rev DESC LIMIT ?'),
    histGet: db.prepare('SELECT doc FROM history WHERE rev = ?'),
    audioAdd: db.prepare('INSERT INTO audio (id, name, ext, bytes, created_at) VALUES (?, ?, ?, ?, ?)'),
    audioGet: db.prepare('SELECT * FROM audio WHERE id = ?'),
    audioDel: db.prepare('DELETE FROM audio WHERE id = ?'),
    audioAll: db.prepare('SELECT id, name, bytes, created_at FROM audio ORDER BY created_at DESC'),
    auditAdd: db.prepare('INSERT INTO audit (at, action, target, meta) VALUES (?, ?, ?, ?)'),
    auditList: db.prepare('SELECT at, action, target, meta FROM audit ORDER BY seq DESC LIMIT ?'),
  }

  const read = () => {
    const row = q.read.get()
    if (!row) return { state: {}, rev: 0 }
    try { return { state: JSON.parse(row.doc), rev: Number(row.rev) } } catch { return { state: {}, rev: Number(row.rev) } }
  }

  /** Write only if nobody else wrote since `expected`. Returns the new rev or null. */
  const write = (doc, expected) => {
    const at = new Date().toISOString()
    const text = JSON.stringify(doc)
    const next = expected + 1
    db.exec('BEGIN IMMEDIATE')
    try {
      let ok
      if (expected === 0 && !q.read.get()) { q.insert.run(next, text, at); ok = true }
      else ok = q.cas.run(next, text, at, expected).changes === 1
      if (!ok) { db.exec('ROLLBACK'); return null }
      q.hist.run(next, text, at)
      if (next > HISTORY_KEEP) q.prune.run(next - HISTORY_KEEP)
      db.exec('COMMIT')
      return next
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }

  const audit = (action, target, meta) => {
    try { q.auditAdd.run(new Date().toISOString(), action, target, meta ? JSON.stringify(meta) : null) } catch { /* never fail the action */ }
  }

  return { db, q, read, write, audit, home }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const send = (res, status, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body)
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...(isBuf ? {} : { 'content-type': 'application/json' }),
    ...headers,
  })
  res.end(isBuf ? body : JSON.stringify(body))
}
const fail = (res, status, error) => send(res, status, { error })

function readBody(req, limit) {
  return new Promise((ok, no) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { no(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', no)
  })
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function loadLib() {
  // Compiled from api/*.ts by `npm run build:server`. The local server uses the
  // same merge, redaction and gate code as the hosted one, never a copy.
  const lib = join(ROOT, 'dist-server', 'lib.mjs')
  if (!existsSync(lib)) throw new Error(`Missing ${lib}. Run: npm run build`)
  return import(pathToFileURL(lib).href)
}

export function makeHandler({ store, lib, distDir, host = process.env.HOST ?? '127.0.0.1' }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local')
    const path = url.pathname
    try {
      const authority = req.headers.host
      let requestOrigin, hostname
      try {
        const parsed = new URL(`http://${authority}`)
        requestOrigin = parsed.origin
        hostname = parsed.hostname
        if (!authority || parsed.username || parsed.password || parsed.host !== authority.toLowerCase()) throw new Error()
      } catch { return fail(res, 403, 'Invalid Host header.') }
      const configuredHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
      if (!['localhost', '127.0.0.1', '[::1]', configuredHost.toLowerCase()].includes(hostname)) return fail(res, 403, 'Host is not allowed.')
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== requestOrigin) return fail(res, 403, 'Origin is not allowed.')
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        const audio = path === '/api/audio' && req.method === 'POST'
        if (audio ? ![...Object.values(AUDIO_TYPES), 'application/octet-stream'].includes(type) : type !== 'application/json') return fail(res, 403, 'Use an accepted Content-Type.')
      }
      /* ---------- health ---------- */
      if (path === '/api/health') {
        const providers = lib.configuredProviders()
        return send(res, 200, {
          mode: 'local', store: true, anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
          judges: providers, accessCodeRequired: false, sessionSecret: true, ready: true,
          home: store.home, regions: ['local'],
        })
      }

      /* ---------- auth: local mode has no accounts ---------- */
      if (path === '/api/auth') {
        return send(res, 200, { configured: false, user: null, mode: 'local' })
      }

      /* ---------- workspace sync (same protocol as hosted) ---------- */
      if (path === '/api/state') {
        if (req.method === 'GET') {
          const { state, rev } = store.read()
          return send(res, 200, { configured: true, state: rev ? state : null, rev })
        }
        if (req.method !== 'POST') return fail(res, 405, 'GET or POST only')
        const raw = await readBody(req, MAX_STATE_BYTES)
        let body
        try { body = JSON.parse(raw.toString('utf8')) } catch { return fail(res, 400, 'Body must be JSON.') }
        if (!body.local || typeof body.local !== 'object') return fail(res, 400, 'Missing local state.')
        const base = body.base && typeof body.base === 'object' ? body.base : {}
        for (let attempt = 0; attempt < 5; attempt++) {
          const { state: server, rev } = store.read()
          const merged = lib.scrubState(lib.mergeState(base, body.local, rev ? server : body.local)).state
          const next = store.write(merged, rev)
          if (next != null) return send(res, 200, { configured: true, state: merged, rev: next })
        }
        return fail(res, 409, 'The workspace is being written too often. Try again.')
      }

      /* ---------- history: every revision, restorable ---------- */
      if (path === '/api/history') {
        if (req.method === 'GET') {
          const revParam = url.searchParams.get('rev')
          if (revParam) {
            const row = store.q.histGet.get(Number(revParam))
            if (!row) return fail(res, 404, 'No such revision.')
            return send(res, 200, { rev: Number(revParam), state: JSON.parse(row.doc) })
          }
          return send(res, 200, { revisions: store.q.histList.all(50) })
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}')
          const row = store.q.histGet.get(Number(body.rev))
          if (!row) return fail(res, 404, 'No such revision.')
          const { rev } = store.read()
          const next = store.write(lib.scrubState(JSON.parse(row.doc)).state, rev)
          store.audit('workspace.restore', `rev ${body.rev}`, { newRev: next })
          return send(res, 200, { restored: Number(body.rev), rev: next })
        }
        return fail(res, 405, 'GET or POST only')
      }

      /* ---------- audio ---------- */
      if (path === '/api/audio' && req.method === 'POST') {
        const name = displayName(url.searchParams.get('name') ?? 'recording')
        const ext = extname(name).toLowerCase()
        if (!AUDIO_TYPES[ext]) return fail(res, 415, `Unsupported audio type "${ext || '(none)'}". Use ${Object.keys(AUDIO_TYPES).join(', ')}.`)
        const buf = await readBody(req, MAX_AUDIO_BYTES)
        if (buf.length === 0) return fail(res, 400, 'Empty file.')
        const claimed = String(req.headers['content-type']).split(';')[0].trim().toLowerCase()
        if (!matchesAudio(buf, ext) || (claimed !== 'application/octet-stream' && claimed !== AUDIO_TYPES[ext])) return fail(res, 415, 'Audio bytes do not match the claimed type.')
        const id = randomBytes(9).toString('base64url')
        writeFileSync(join(store.home, 'audio', `${id}${ext}`), buf)
        store.q.audioAdd.run(id, name, ext, buf.length, new Date().toISOString())
        store.audit('audio.upload', name, { bytes: buf.length })
        return send(res, 201, { id, name, bytes: buf.length, url: `/api/audio/${id}` })
      }
      if (path === '/api/audio' && req.method === 'GET') {
        return send(res, 200, { files: store.q.audioAll.all() })
      }
      const audioMatch = path.match(/^\/api\/audio\/([A-Za-z0-9_-]{6,40})$/)
      if (audioMatch) {
        const row = store.q.audioGet.get(audioMatch[1])
        if (!row) return fail(res, 404, 'No such recording.')
        const file = join(store.home, 'audio', `${row.id}${row.ext}`)
        if (req.method === 'DELETE') {
          try { unlinkSync(file) } catch { /* already gone */ }
          store.q.audioDel.run(row.id)
          store.audit('audio.delete', row.name)
          return send(res, 200, { deleted: row.id })
        }
        if (!existsSync(file)) return fail(res, 404, 'Recording file is missing on disk.')
        return streamRange(req, res, file, AUDIO_TYPES[row.ext])
      }

      /* ---------- release gate ---------- */
      if (path === '/api/gate') {
        const agentId = url.searchParams.get('agent') ?? ''
        if (!agentId) return fail(res, 400, 'Pass ?agent=<agentId>.')
        const { state } = store.read()
        const m = lib.measureGate(state, agentId, url.searchParams.get('version') || undefined)
        if (m.error) return fail(res, m.status, m.error)
        const promptHash = await lib.sha256Hex(String(m.version.promptText ?? ''))
        const receipt = {
          agent: { id: agentId, name: m.agent.name },
          version: { id: m.version.id, number: m.version.number, changelog: m.version.changelog ?? '' },
          measured: { composite: m.input.composite, samples: m.input.samples, paramSamples: m.input.paramSamples, unsubstantiatedSessions: m.unsubstantiatedSessions, humanSessions: m.humanSessions, simulatedSessions: m.simulatedSessions, aiCalls: m.aiCalls, blockerFindings: m.input.blockerFindings },
          outcome: m.result.outcome, promptHash, evaluatedAt: new Date().toISOString(),
          // Unsigned in local mode: there is no deployment secret to sign with,
          // and a signature made with a default secret would prove nothing.
          signed: false,
        }
        store.audit('gate.evaluate', `${m.agent.name} v${m.version.number}`, { outcome: m.result.outcome })
        return send(res, m.result.outcome === 'pass' || m.result.outcome === 'disabled' ? 200 : 409, { ...m.result, receipt })
      }

      /* ---------- audit ---------- */
      if (path === '/api/audit') {
        return send(res, 200, { events: store.q.auditList.all(200).map(e => ({ ...e, meta: e.meta ? JSON.parse(e.meta) : undefined })) })
      }

      /* ---------- model-backed endpoints: reuse the hosted handlers ---------- */
      const edge = { '/api/anthropic': lib.anthropic, '/api/simulate': lib.simulate, '/api/simulate-suite': lib.simulateSuite }[path]
      if (edge) return proxyEdge(req, res, edge)

      if (path.startsWith('/api/')) return fail(res, 404, `No route ${path} in local mode.`)

      /* ---------- the UI ---------- */
      return serveStatic(res, distDir, path)
    } catch (e) {
      return fail(res, e.status ?? 500, e instanceof Error ? e.message : String(e))
    }
  }
}

async function proxyEdge(req, res, handler) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, 8_000_000)
  const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body })
  const r = await handler(request)
  const buf = Buffer.from(await r.arrayBuffer())
  res.writeHead(r.status, Object.fromEntries(r.headers.entries()))
  res.end(buf)
}

/** Range requests, because a browser cannot seek an audio file served without them. */
function streamRange(req, res, file, type) {
  const size = statSync(file).size
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? Number(m[1]) : 0
    let end = m && m[2] ? Number(m[2]) : size - 1
    if (!m || start >= size || end >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end()
    }
    res.writeHead(206, {
      'content-type': type, 'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600',
    })
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' })
  createReadStream(file).pipe(res)
}

async function serveStatic(res, distDir, path) {
  const safe = resolve(distDir, '.' + decodeURIComponent(path))
  const rel = relative(resolve(distDir), safe)
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) return fail(res, 403, 'Forbidden')
  let file = safe
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, 'index.html')  // SPA fallback
  if (!existsSync(file)) {
    return send(res, 503, Buffer.from('The UI is not built. Run: npm run build'), { 'content-type': 'text/plain' })
  }
  const type = STATIC_TYPES[extname(file)] ?? 'application/octet-stream'
  const immutable = file.includes(`${join(distDir, 'assets')}`)
  res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' })
  res.end(await readFile(file))
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

// AGENT_QA_HOME and agent-qa-data stay stable so existing workspaces are reused.
export async function start({ port = Number(process.env.PORT ?? 5199), host = process.env.HOST ?? '127.0.0.1', home = process.env.AGENT_QA_HOME ?? resolve('agent-qa-data'), quiet = false } = {}) {
  const store = openStore(home)
  const lib = await loadLib()
  const server = createServer(makeHandler({ store, lib, distDir: join(ROOT, 'dist'), host }))
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, host, ok) })
  const addr = server.address()
  if (!quiet) {
    const shown = host === '0.0.0.0' ? 'localhost' : host
    console.log(`\n  Our Agent Said What?! is running at http://${shown}:${addr.port}`)
    console.log(`  data: ${home}`)
    console.log(`  AI analysis and simulation: ${process.env.ANTHROPIC_API_KEY ? 'on (ANTHROPIC_API_KEY)' : 'off. Set ANTHROPIC_API_KEY in the server environment and restart to enable them. Manual logging, scoring, triage and gates over saved evidence still work.'}\n`)
  }
  return { server, store, port: addr.port, close: () => new Promise(r => { server.close(() => { store.db.close(); r() }) }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(e => { console.error(e.message); process.exit(1) })
}
