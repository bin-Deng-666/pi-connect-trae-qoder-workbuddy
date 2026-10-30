/**
 * Trae: translate the private chat protocol into OpenAI's.
 *
 * Trae's endpoint is not OpenAI-compatible in any part that matters: auth is a
 * `Cloud-IDE-JWT` header, the body needs `config_name` plus `function`, message
 * content must be an array of parts, tool `parameters` must be a JSON *string*
 * rather than an object, and the stream is `event: output` frames instead of
 * `data: {choices:[…]}`. All of that translation lives here.
 *
 * WHAT THIS FILE DOES NOT DO: it does not store a token. Credentials and the
 * device fingerprint are read from the Trae installation on each call, because
 * the desktop app refreshes them and a copy here would go stale silently.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CLIENTS, CREDENTIAL_FILES, TRAE_CATALOG, appSupport } from '../config.mjs'
import { isMainModule } from '../util.mjs'

const CHAT_URL = 'https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat'

/** Billing endpoints, one per region. */
const PAY_BASE = { cn: 'https://api.trae.cn', ai: 'https://api.trae.ai' }
/** The billing route is a web route and checks for a browser origin. */
const PAY_ORIGIN = { cn: 'https://www.trae.cn', ai: 'https://www.trae.ai' }

/**
 * The credential to use: prefer the CN edition, then SOLO, newest first.
 *
 * The file can hold several logins (one per edition). CN is preferred because
 * it is the edition whose catalog the shipped examples target; ordering by
 * expiry within an edition picks the token that has the most life left.
 */
export async function credential() {
  const file = CREDENTIAL_FILES.trae
  if (!existsSync(file)) throw new Error(`no Trae credential at ${file}`)
  const doc = JSON.parse(await readFile(file, 'utf8'))
  const list = (doc.credentials ?? []).filter((entry) => typeof entry?.accessToken === 'string' && entry.accessToken !== '')
  if (list.length === 0) throw new Error('credential file contains no accessToken')
  const rank = { cn: 0, solo: 1 }
  list.sort(
    (a, b) => (rank[a.edition] ?? 9) - (rank[b.edition] ?? 9) || (b.expiresAtMs ?? 0) - (a.expiresAtMs ?? 0),
  )
  return list[0]
}

/**
 * Device fingerprint and app version, read from the installed client.
 *
 * Missing values degrade to empty strings rather than failing the request:
 * upstream tolerates an absent fingerprint, so a machine that installed Trae
 * somewhere unusual still gets a working connection instead of an error.
 */
async function identity(edition) {
  const dir = CLIENTS.trae.appDirs[edition] ?? CLIENTS.trae.appDirs.cn
  let machineId = ''
  let deviceId = ''
  let version = CLIENTS.trae.version
  try {
    const doc = JSON.parse(await readFile(appSupport(dir, 'User', 'globalStorage', 'storage.json'), 'utf8'))
    machineId = String(doc['telemetry.machineId'] ?? '')
    deviceId = String(doc['telemetry.devDeviceId'] ?? '')
  } catch {
    /* no readable storage: send no fingerprint headers */
  }
  try {
    const product = JSON.parse(await readFile(`/Applications/${dir}.app/Contents/Resources/app/product.json`, 'utf8'))
    version = String(product.version ?? product.appVersion ?? version)
  } catch {
    /* keep the pinned fallback version */
  }
  return { machineId, deviceId, version }
}

/** Upstream requires the `x-*-version-code` headers to be ten digits. */
function versionCode(version) {
  const digits = String(version).replace(/\D/gu, '')
  return digits === '' ? '2026010100' : digits.padEnd(10, '0').slice(0, 10)
}

/**
 * The full header set for a chat call.
 *
 * The trace headers are not decoration: upstream correlates a request across
 * `x-request-id`, `x-trae-request-id`, `x-custom-trace-id` and a W3C-shaped
 * `x-flow-traceparent`, and a request missing them is rejected before the model
 * is reached. They are all derived from one UUID so they agree with each other.
 */
function upstreamHeaders(cred, ident) {
  const requestId = randomUUID()
  const trace = requestId.replaceAll('-', '').slice(0, 32)
  const code = versionCode(ident.version)
  return {
    Authorization: `Cloud-IDE-JWT ${cred.accessToken}`,
    'X-Ide-Token': cred.accessToken,
    'X-Cloudide-Token': cred.accessToken,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${ident.version}`,
    'x-app-id': CLIENTS.trae.appId,
    ...(ident.machineId === '' ? {} : { 'x-machine-id': ident.machineId }),
    ...(ident.deviceId === '' ? {} : { 'x-device-id': ident.deviceId }),
    'x-device-type': 'mac',
    'x-app-version': ident.version,
    'x-ide-version': ident.version,
    'x-app-version-code': code,
    'x-ide-version-code': code,
    'x-uid': String(cred.userId ?? ''),
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'x-custom-trace-id': trace,
    'x-flow-traceparent': `04-${trace}-${trace.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
}

let catalogCache

/**
 * The local model catalog.
 *
 * Trae names the model twice per request — the model id AND the `function`
 * (wire endpoint) that serves it — and `function` cannot be derived from the
 * id. Rather than guess, the catalog is read from `bin/catalog.mjs`'s output,
 * which is built from the installed client. See `docs/providers.md`.
 */
export async function catalog() {
  if (catalogCache !== undefined) return catalogCache
  const list = JSON.parse(await readFile(TRAE_CATALOG, 'utf8'))
  catalogCache = new Map(list.map((model) => [model.id, model]))
  return catalogCache
}

/** OpenAI content (string or part array) -> Trae content array. */
function toTraeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text })
    // Images: Trae's multimodal field shape has not been established, so this
    // degrades to an honest note instead of pretending the image was read.
    else if (part?.type === 'image_url') {
      parts.push({ type: 'text', text: '(an image was attached to this message; image input is not supported)' })
    }
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }]
}

/** OpenAI tool definitions -> Trae, where `parameters` must be a JSON string. */
function toTraeTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const tool of tools) {
    const fn = tool?.function
    if (fn?.name === undefined) continue
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description ?? '',
        parameters: JSON.stringify(fn.parameters ?? { type: 'object', properties: {} }),
      },
    })
  }
  return out.length > 0 ? out : undefined
}

function toTraeBody(body, models) {
  const id = typeof body.model === 'string' ? body.model : ''
  const model = models.get(id)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const traeMessages = messages.map((message) => {
    // OpenAI's `developer` role has no Trae equivalent; system is its nearest.
    const role = message.role === 'developer' ? 'system' : message.role
    // Assistant tool calls: Trae nests them under `function_call`, not `function`.
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: call.id ?? '',
          type: call.type ?? 'function',
          function_call: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' },
        }))
      : undefined
    return {
      role,
      content: toTraeContent(message.content),
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
      ...(typeof message.name === 'string' ? { name: message.name } : {}),
    }
  })
  const thinking = body.reasoning_effort ?? body.reasoning?.effort
  const tools = toTraeTools(body.tools)
  return {
    messages: traeMessages,
    model: id,
    config_name: id,
    function: model?.wireFunction ?? 'solo_work_lite',
    stream: true,
    ...(tools === undefined ? {} : { tools }),
    ...(typeof thinking === 'string' ? { reasoning_effort: thinking } : {}),
  }
}

/** One Trae {response, reasoning_content, tool_calls} frame -> OpenAI delta. */
function deltaOf(payload) {
  const delta = {}
  if (typeof payload.response === 'string' && payload.response !== '') delta.content = payload.response
  if (typeof payload.reasoning_content === 'string' && payload.reasoning_content !== '') {
    delta.reasoning_content = payload.reasoning_content
  }
  if (Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0) {
    delta.tool_calls = payload.tool_calls.map((call, index) => {
      // The function name rides in `function_call` here, and arguments may be split.
      const fn = call.function_call ?? call.function ?? {}
      return {
        index: typeof call.index === 'number' ? call.index : index,
        ...(typeof call.id === 'string' && call.id !== '' ? { id: call.id } : {}),
        type: 'function',
        function: { name: fn.name ?? call.name ?? '', arguments: fn.arguments ?? call.arguments ?? '' },
      }
    })
  }
  return delta
}

/**
 * Trae's `token_usage` event -> OpenAI usage.
 *
 * `cache_read_input_tokens` is forwarded as `prompt_tokens_details.cached_tokens`
 * because that is the field Pi reads to show a cache hit rate. Dropping it would
 * make every cached turn look like a miss.
 */
function usageOf(payload) {
  const prompt = Number(payload.prompt_tokens ?? 0)
  const completion = Number(payload.completion_tokens ?? 0)
  if (prompt === 0 && completion === 0) return undefined
  const cached = Number(payload.cache_read_input_tokens ?? 0)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(payload.total_tokens ?? prompt + completion),
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  }
}

/**
 * Run one chat request. `emit`/`emitUsage`/`emitDone` are supplied by the
 * gateway, which owns SSE framing; this function owns meaning only.
 */
export async function chat(body, { emit, emitUsage, emitDone }) {
  const models = await catalog()
  const cred = await credential()
  const ident = await identity(cred.edition)

  const upstream = await fetch(CHAT_URL, {
    method: 'POST',
    headers: upstreamHeaders(cred, ident),
    body: JSON.stringify(toTraeBody(body, models)),
    signal: AbortSignal.timeout(600_000),
  })
  if (!upstream.ok || upstream.body === null) {
    const text = await upstream.text().catch(() => '')
    throw new Error(`trae ${String(upstream.status)}: ${text.slice(0, 400)}`)
  }

  let buffered = ''
  let finish = 'stop'
  let usage
  const collected = []
  const decoder = new TextDecoder()

  for await (const part of upstream.body) {
    buffered += decoder.decode(part, { stream: true })
    let cut
    while ((cut = buffered.indexOf('\n\n')) !== -1) {
      const block = buffered.slice(0, cut)
      buffered = buffered.slice(cut + 2)
      let event = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data === '') continue
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      if (event === 'output') {
        const delta = deltaOf(payload)
        if (Object.keys(delta).length > 0) {
          collected.push(delta)
          emit(delta)
        }
      } else if (event === 'token_usage') {
        usage = usageOf(payload) ?? usage
      } else if (event === 'done') {
        finish =
          payload.finish_reason === 'tool_calls' || collected.some((delta) => delta.tool_calls !== undefined)
            ? 'tool_calls'
            : 'stop'
      }
    }
  }

  if (usage !== undefined) emitUsage(usage)
  const text = collected.map((delta) => delta.content ?? '').join('')
  emitDone(finish, { text, usage })
}

/** Model list in OpenAI `/v1/models` shape. */
export async function models() {
  const list = await catalog()
  return [...list.values()].map((model) => ({ id: model.id, object: 'model', owned_by: 'trae' }))
}

/**
 * Remaining credits.
 *
 * `usage_summary` IS ALREADY THE ANSWER — `total_amount - consumed_amount` over
 * every bucket, gifts included. The `user_entitlement_pack_list` entries must
 * NOT be added on top: measured on a real account, the four buckets
 * (500/100/100/100) sum to exactly the reported `total_amount` of 800, and
 * `consumed_amount` is the sum of their consumption. Adding the per-bucket
 * remainder made the reading exactly twice the true value.
 */
export async function credits() {
  const cred = await credential()
  const region = cred.edition === 'ai' ? 'ai' : 'cn'
  const response = await fetch(`${PAY_BASE[region]}/trae/api/v2/pay/web_user_ent_usage`, {
    method: 'POST',
    headers: {
      Authorization: `Cloud-IDE-JWT ${cred.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      Origin: PAY_ORIGIN[region],
      Referer: `${PAY_ORIGIN[region]}/`,
    },
    body: JSON.stringify({ require_usage: true }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Trae billing failed: HTTP ${String(response.status)}`)
  const summary = (await response.json())?.usage_summary ?? {}
  const total = Number(summary.total_amount ?? 0)
  const consumed = Number(summary.consumed_amount ?? 0)
  const remaining = total > 0 ? Math.max(0, total - consumed) : 0
  return {
    provider: 'trae',
    account: cred.accountName ?? '',
    remaining: Math.round(remaining * 100) / 100,
    unit: 'credits',
    ...(Number(cred.expiresAtMs ?? 0) === 0 ? {} : { expiresAt: Number(cred.expiresAtMs) }),
  }
}

if (isMainModule(import.meta.url)) {
  const cred = await credential()
  const ident = await identity(cred.edition)
  const list = await catalog()
  const usage = await credits()
  console.log(`credential: ${String(cred.accountName)} (${String(cred.edition)})`)
  console.log(`device: machine=${ident.machineId.slice(0, 12)}… device=${ident.deviceId.slice(0, 12)}… app=${ident.version}`)
  console.log(`catalog: ${String(list.size)} models`)
  console.log(`credits: ${String(usage.remaining)} ${usage.unit}`)
}
