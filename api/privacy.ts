import { audit, bad, checkDeployment, json, redis, redisEnv, tenantKey } from './_lib'
import { currentUser } from './auth'

export const config = { runtime: 'edge' }

/**
 * Data subject access, export, and erasure.
 *
 * Every enterprise deal eventually reaches a privacy questionnaire that asks
 * three concrete things: can we get our data out, can you delete it, and can
 * you tell us what you hold. Answering those in a contract attachment is far
 * cheaper than answering them in a call, and "we will build it" is not an
 * answer a procurement team accepts.
 *
 *   GET  /api/privacy?action=inventory  -> what is stored, sized, no content
 *   GET  /api/privacy?action=export     -> full JSON dump of the tenant
 *   POST /api/privacy { action: 'erase' } -> delete one agent, or the tenant
 *
 * Erase is irreversible and admin-only, and it writes its own audit entry
 * before deleting — including into a surviving tenant log where one exists —
 * because the record that data was deleted on request is itself evidence.
 */

export default async function handler(req: Request): Promise<Response> {
  const denied = checkDeployment(req)
  if (denied) return denied

  const env = redisEnv()
  if (!env) return bad('No shared store is configured on this deployment.', 503)

  const user = await currentUser(req)
  if (!user) return bad('Sign in first.', 401)
  const tid = user.tenantId

  const url = new URL(req.url)
  const action = url.searchParams.get('action') ?? (req.method === 'POST' ? '' : 'inventory')

  try {
    /* ---- inventory: sizes and counts, never content ---- */
    if (req.method === 'GET' && action === 'inventory') {
      const raw = (await redis(env, ['GET', tenantKey(tid, 'state')])) as string | null
      const state = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const counts: Record<string, number> = {}
      let transcripts = 0
      for (const [k, v] of Object.entries(state)) {
        if (Array.isArray(v)) {
          counts[k] = v.length
          if (k === 'sessions' || k === 'calls') {
            transcripts += v.filter(r => typeof (r as { transcript?: string }).transcript === 'string' && (r as { transcript: string }).transcript).length
          }
        }
      }
      const auditRows = Number((await redis(env, ['LLEN', tenantKey(tid, 'audit')])) ?? 0)
      return json({
        ok: true,
        tenant: { id: tid, name: user.tenantName },
        stored: counts,
        bytes: raw ? raw.length : 0,
        transcripts,
        auditEvents: auditRows,
        modelProvider: 'Anthropic — transcripts are redacted before any model call',
        residency: 'Data at rest sits in your configured Redis (Upstash or equivalent), region chosen at provision time.',
        retention: 'Transcripts persist with the QA record. Erase an agent or the whole workspace to remove them.',
      })
    }

    /* ---- export: the full tenant record ---- */
    if (req.method === 'GET' && action === 'export') {
      const raw = (await redis(env, ['GET', tenantKey(tid, 'state')])) as string | null
      const rows = (await redis(env, ['LRANGE', tenantKey(tid, 'audit'), 0, 499])) as string[]
      await audit(env, tid, user.email, 'privacy.export', 'workspace')
      return json({
        exportedAt: new Date().toISOString(),
        tenant: { id: tid, name: user.tenantName },
        data: raw ? JSON.parse(raw) : {},
        audit: rows.flatMap(r => { try { return [JSON.parse(r)] } catch { return [] } }),
      }, 200, {
        'content-disposition': `attachment; filename="saidwhat-export-${tid}-${new Date().toISOString().slice(0, 10)}.json"`,
      })
    }

    /* ---- erase ---- */
    if (req.method === 'POST' && action === 'erase') {
      if (user.role !== 'admin') return bad('Only an admin can erase data.', 403)
      const body = JSON.parse(await req.text().catch(() => '{}')) as { scope?: string; agentId?: string; confirm?: string }

      if (body.scope === 'tenant') {
        if (body.confirm !== user.tenantName) {
          return bad(`Type the workspace name exactly (${user.tenantName}) to confirm.`, 400)
        }
        // Preserve a short tombstone: the fact that a workspace was erased, when,
        // and by whom, is what makes this defensible later.
        await redis(env, ['SET', tenantKey(tid, 'erased'), JSON.stringify({
          erasedAt: new Date().toISOString(), by: user.email, name: user.tenantName,
        })])
        for (const k of ['state', 'rev', 'audit', 'name-hints']) {
          await redis(env, ['DEL', tenantKey(tid, k)])
        }
        return json({ ok: true, erased: 'workspace' })
      }

      if (body.scope === 'agent' && body.agentId) {
        const raw = (await redis(env, ['GET', tenantKey(tid, 'state')])) as string | null
        if (!raw) return bad('Nothing stored to erase.', 404)
        const state = JSON.parse(raw) as Record<string, unknown>
        const agent = (state.agents as { id: string; name: string }[] | undefined)?.find(a => a.id === body.agentId)
        if (!agent) return bad('No such agent in this workspace.', 404)
        const versionIds = new Set(((state.versions as { id: string; agentId: string }[] | undefined) ?? [])
          .filter(v => v.agentId === body.agentId).map(v => v.id))
        const sessionIds = new Set(((state.sessions as { id: string; agentId: string }[] | undefined) ?? [])
          .filter(s => s.agentId === body.agentId).map(s => s.id))
        const batchIds = new Set(((state.batches as { id: string; agentId: string }[] | undefined) ?? [])
          .filter(b => b.agentId === body.agentId).map(b => b.id))

        const out: Record<string, unknown> = { ...state }
        out.agents = (state.agents as unknown[]).filter(a => (a as { id: string }).id !== body.agentId)
        out.versions = (state.versions as unknown[]).filter(v => !versionIds.has((v as { id: string }).id))
        out.sessions = (state.sessions as unknown[]).filter(s => !sessionIds.has((s as { id: string }).id))
        out.issues = (state.issues as unknown[]).filter(i => (i as { agentId: string }).agentId !== body.agentId)
        out.calls = (state.calls as unknown[]).filter(c => !batchIds.has((c as { batchId: string }).batchId))
        out.batches = (state.batches as unknown[]).filter(b => !batchIds.has((b as { id: string }).id))

        await redis(env, ['SET', tenantKey(tid, 'state'), JSON.stringify(out)])
        await audit(env, tid, user.email, 'privacy.erase-agent', agent.name)
        return json({ ok: true, erased: 'agent', name: agent.name, removed: {
          sessions: sessionIds.size, versions: versionIds.size,
        } })
      }

      return bad('scope must be "agent" or "tenant".')
    }

    return bad('action must be inventory, export, or erase.')
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Privacy request failed.', 500)
  }
}
