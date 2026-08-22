/**
 * AgentForge Brain — host half: galaxy bridge.
 *
 * GET  /agentforge-brain/galaxy     → per-session summary from the persisted
 *                                     event logs (message/turn counts, first
 *                                     user text) to enrich the memory galaxy.
 * POST /agentforge-brain/embed-sim  → cosine similarity matrix for texts via a
 *                                     local Ollama embedding endpoint. Optional
 *                                     enhancement: 503 (Ollama down / no model)
 *                                     makes the client keep its lexical fallback.
 *
 * Both routes only register when the web bundle actually provides
 * `webServer` + `sessionPersistence`; a bundle without them leaves the client
 * on its metadata-only path.
 */

export const name = 'agentforge-brain'

const MAX_SESSIONS = 40
const MAX_EVENTS_SCAN = 4000
const OLLAMA = 'http://127.0.0.1:11434/api/embed'
const EMBED_MODEL = process.env.AGENTFORGE_EMBED_MODEL ?? 'nomic-embed-text'

function sendJson(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** same-origin guard (dshmarket / dsh-hippo precedent) for the POST route */
function sameOrigin(request) {
  const { origin, host } = request.headers
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function readJsonBody(request, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(c)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    request.on('error', reject)
  })
}

/** best-effort text extraction from a message content (string | block array) */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '')))
      .filter((s) => s.length > 0)
      .join(' ')
  }
  return ''
}

/** one-line summary of a session's persisted event log */
async function summarize(sp, id) {
  const { events } = await sp.readFrom(id, 0)
  let users = 0
  let assistants = 0
  let turns = 0
  let firstUser = ''
  let lastAt = null
  for (let i = 0; i < events.length && i < MAX_EVENTS_SCAN; i++) {
    const ev = events[i]
    if (ev === undefined || ev === null) continue
    if (ev.type === 'turn/end') turns += 1
    if (ev.type === 'user/message') {
      users += 1
      if (firstUser === '') firstUser = textOf(ev.data?.content ?? ev.content).slice(0, 140)
    }
    if (ev.type === 'assistant/message') assistants += 1
    if (typeof ev.time === 'number') lastAt = ev.time
  }
  return { id, users, assistants, turns, firstUser, lastAt, events: events.length }
}

/** summaries are cached briefly — giant logs must not re-read on every tab mount */
const summaryCache = new Map()
const CACHE_TTL_MS = 120000

async function summarizeCached(sp, id) {
  const hit = summaryCache.get(id)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const value = await summarize(sp, id)
  summaryCache.set(id, { at: Date.now(), value })
  return value
}

export function apply(ctx) {
  ctx.logger?.info?.('agentforge-brain: host half loaded (galaxy bridge)')

  ctx.inject(['webServer', 'sessionPersistence'], (host) => {
    host.effect(() => {
      const disposers = [
        host.webServer.register({
          kind: 'exact',
          path: '/agentforge-brain/galaxy',
          handler: (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            void host.sessionPersistence.list()
              .then(async (headers) => {
                const picked = headers
                  .filter((h) => h.origin !== 'subagent')
                  .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
                  .slice(0, MAX_SESSIONS)
                const items = []
                for (const h of picked) {
                  try {
                    items.push(await summarizeCached(host.sessionPersistence, h.id))
                  } catch {
                    // unreadable log → skip the session, keep the rest
                  }
                }
                sendJson(response, 200, { items, model: EMBED_MODEL })
              })
              .catch((e) => {
                sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
              })
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: '/agentforge-brain/embed-sim',
          handler: (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: 'same-origin only' })
              return
            }
            void readJsonBody(request).then(
              async (body) => {
                const texts = Array.isArray(body.texts) ? body.texts.filter((t) => typeof t === 'string').slice(0, 200) : []
                if (texts.length < 2) {
                  sendJson(response, 400, { error: 'texts[] with >=2 entries required' })
                  return
                }
                let embeddings
                try {
                  const r = await fetch(OLLAMA, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
                  })
                  if (!r.ok) throw new Error(`ollama ${String(r.status)}`)
                  const j = await r.json()
                  embeddings = j.embeddings
                } catch (e) {
                  sendJson(response, 503, { fallback: 'lexical', error: e instanceof Error ? e.message : String(e) })
                  return
                }
                if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
                  sendJson(response, 502, { fallback: 'lexical', error: 'embedding count mismatch' })
                  return
                }
                const norms = embeddings.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1)
                const matrix = embeddings.map((va, i) =>
                  embeddings.map((vb, j) => {
                    if (i === j) return 1
                    let dot = 0
                    for (let k = 0; k < va.length; k++) dot += va[k] * vb[k]
                    return dot / (norms[i] * norms[j])
                  }),
                )
                sendJson(response, 200, { matrix })
              },
              (e) => {
                sendJson(response, 400, { error: e instanceof Error ? e.message : String(e) })
              },
            )
          },
        }),
      ]
      return () => { for (const d of disposers) d() }
    }, 'agentforge-brain: galaxy routes')
  })
}
