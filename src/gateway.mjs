/**
 * The HTTP front door: one process, one port, one OpenAI-compatible shape.
 *
 * WHY ONE PROCESS FOR TWO PROVIDERS. Trae and Qoder both need exactly the same
 * three things — protocol translation, credential replay, and usage forwarding.
 * Two separate shims would implement those three things twice and then drift.
 * The shared half lives here (SSE framing, usage reporting, error mapping,
 * credit routing) and only the protocol difference lives in `providers/`.
 *
 * WHY WORKBUDDY IS NOT PROXIED. Its upstream already speaks OpenAI: the chat
 * endpoint accepts the same body, and the billing number arrives in an
 * OpenAI-shaped `usage` field. A hop through this process would add latency and
 * a failure mode without translating anything, so Pi talks to it directly. The
 * gateway still reports its credits, because that call IS a translation.
 *
 * Routes:
 *   GET  /healthz
 *   GET  /providers
 *   GET  /<provider>/v1/models
 *   POST /<provider>/v1/chat/completions
 *   GET  /credits               -> every provider
 *   GET  /credits/<provider>    -> one provider
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

import { GATEWAY_HOST, GATEWAY_PORT } from './config.mjs'
import { isMainModule } from './util.mjs'
import { creditsAll, creditsFor } from './credits.mjs'
import * as trae from './providers/trae.mjs'
import * as qoder from './providers/qoder.mjs'

/** Providers served by this process. WorkBuddy is deliberately absent — see above. */
export const ADAPTERS = { trae, qoder }

const json = (payload) => JSON.stringify(payload)

/** One streaming delta, in the exact shape `openai-completions` expects. */
const chunk = (model, delta, finish, extra) =>
  `data: ${json({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    ...extra,
  })}\n\n`

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    req.on('data', (part) => parts.push(part))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, payload) {
  const text = json(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Run one chat request: the adapter decides what the deltas mean, this decides
 * how they reach the client.
 *
 * THE USAGE CHUNK IS THE WHOLE POINT OF THIS FUNCTION. Pi's footer reads
 * `chunk.usage` off the last streamed chunk to compute context occupancy, cache
 * hit rate, and cost. An adapter that emits content but no usage produces a
 * footer that silently reports `?/200k` forever, so usage is forwarded exactly
 * once, on the closing chunk, and only when the upstream actually reported it —
 * inventing zeros would be worse than showing nothing.
 */
async function handleChat(adapter, body, res) {
  const model = typeof body.model === 'string' ? body.model : ''
  const stream = body.stream !== false
  let usage

  res.writeHead(200, {
    'content-type': stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    ...(stream ? { connection: 'keep-alive' } : {}),
  })

  const text = []
  const emit = (delta) => {
    if (typeof delta.content === 'string' && delta.content !== '') text.push(delta.content)
    if (stream) res.write(chunk(model, delta, null))
  }
  const emitUsage = (value) => {
    if (value !== undefined) usage = value
  }
  const emitDone = (finish, extra) => {
    if (extra?.usage !== undefined && usage === undefined) usage = extra.usage
    if (stream) {
      res.write(chunk(model, {}, finish, usage === undefined ? {} : { usage }))
      res.end('data: [DONE]\n\n')
      return
    }
    const message = { role: 'assistant', content: extra?.text ?? text.join('') }
    const toolCalls = extra?.toolCalls
    if (toolCalls instanceof Map && toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, slot]) => ({
          index,
          id: slot.id,
          type: 'function',
          function: { name: slot.name, arguments: slot.arguments },
        }))
    }
    res.end(
      json({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        ...(usage === undefined ? {} : { usage }),
      }),
    )
  }

  try {
    await adapter.chat(body, { emit, emitUsage, emitDone })
  } catch (error) {
    const message = messageOf(error)
    if (stream) {
      // Headers and possibly some content are already gone, so the only channel
      // left is the body. Ending silently would leave the client waiting for a
      // finish_reason that never arrives.
      res.write(chunk(model, { content: `\n\n[pi-connect] ${message}` }, 'stop'))
      res.end('data: [DONE]\n\n')
      return
    }
    if (!res.headersSent) writeJson(res, 502, { error: { message, type: 'upstream_error' } })
    else res.end()
  }
}

/** Build the server without listening, so tests and the CLI can drive it. */
export function createGateway(adapters = ADAPTERS) {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname

    if (req.method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
      writeJson(res, 200, { ok: true, providers: Object.keys(adapters) })
      return
    }
    if (req.method === 'GET' && (path === '/providers' || path === '/providers/')) {
      writeJson(res, 200, Object.keys(adapters))
      return
    }

    if (req.method === 'GET' && path.startsWith('/credits')) {
      const name = path.replace(/^\/credits\/?/u, '').replace(/\/$/u, '')
      const task = name === '' ? creditsAll() : creditsFor(name)
      task
        .then((payload) => writeJson(res, 200, payload))
        .catch((error) => writeJson(res, 502, { error: { message: messageOf(error) } }))
      return
    }

    const match = /^\/([a-z]+)\/v1\/(models|chat\/completions)\/?$/u.exec(path)
    if (match !== null) {
      const [, provider, endpoint] = match
      const adapter = adapters[provider]
      if (adapter === undefined) {
        writeJson(res, 404, { error: { message: `unknown provider: ${provider}` } })
        return
      }
      if (endpoint === 'models') {
        adapter
          .models()
          .then((data) => writeJson(res, 200, { object: 'list', data }))
          .catch((error) => writeJson(res, 502, { error: { message: messageOf(error) } }))
        return
      }
      if (req.method === 'POST') {
        readBody(req)
          .then((body) => handleChat(adapter, body, res))
          .catch((error) => writeJson(res, 400, { error: { message: messageOf(error) } }))
        return
      }
    }

    writeJson(res, 404, { error: { message: 'not found' } })
  })
}

/** Start listening. Returns the server so the caller can close it. */
export function startGateway({ host = GATEWAY_HOST, port = GATEWAY_PORT } = {}) {
  const server = createGateway()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

// Run directly: `node src/gateway.mjs`
if (isMainModule(import.meta.url)) {
  const server = await startGateway()
  const { address, port } = server.address()
  console.log(`pi-connect gateway: http://${String(address)}:${String(port)}  providers=${Object.keys(ADAPTERS).join(',')}`)
}
