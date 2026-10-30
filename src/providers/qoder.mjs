/**
 * Qoder: translate the cosy protocol into OpenAI's.
 *
 * Qoder's chat endpoint is not OpenAI-compatible in any part that matters: auth
 * is a signed cosy bearer (`Bearer COSY.<payloadB64>.<md5>`), the request body
 * must be re-encoded with a custom base64 alphabet, message content goes in a
 * `contents` array, the model is named by an internal short id (`dmodel`, not
 * `DeepSeek-V4-Pro`), and the stream is `data: {"body":"<inner json>"}` rather
 * than `data: {choices:[…]}`. All of that translation lives here.
 *
 * PROTOCOL PROVENANCE. The crypto and signing primitives below are a
 * byte-for-byte reimplementation of the ones in `dsh-connect-qoder` (MIT,
 * dingminhua). That project's implementation is the source of truth for the
 * wire format; this file only changes where the bytes come from and where the
 * deltas go. Verified against the live service: jobToken exchange 200, 11
 * catalog entries, working chat SSE, working tool calls, usage carrying credits.
 *
 * CREDENTIALS ARE READ, NEVER STORED. The PAT is read from the Qoder plugin's
 * vault on each call, so the plugin's own refresh cycle stays authoritative and
 * this process never writes a secret to disk.
 */
import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { CLIENTS, CREDENTIAL_FILES } from '../config.mjs'
import { isMainModule } from '../util.mjs'

/**
 * Per-region endpoints. The credential paths come from `config.mjs` so that one
 * `PI_CONNECT_QODER_CREDENTIALS` override moves both, instead of the endpoint
 * table and the vault location drifting apart.
 */
const REGIONS = {
  cn: {
    gateway: 'https://gateway.qoder.com.cn',
    openapi: 'https://openapi.qoder.com.cn',
    accountsFile: CREDENTIAL_FILES.qoder.cn,
  },
  global: {
    gateway: 'https://api1.qoder.sh',
    openapi: 'https://openapi.qoder.sh',
    accountsFile: CREDENTIAL_FILES.qoder.global,
  },
}
const CHAT_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
const MODELS_PATH = '/algo/api/v2/model/list?Encode=1'
const JOB_TOKEN_PATH = '/algo/api/v3/user/jobToken?Encode=1'

/** The cosy base64 alphabet, byte-identical to upstream. */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const s2c = new Map()
for (let i = 0; i < 64; i += 1) s2c.set(STD_ALPHABET[i], CUSTOM_ALPHABET[i])
s2c.set('=', '$')

const COSY_VERSION = CLIENTS.qoder.cosyVersion
const COSY_VERSION_HEADER = CLIENTS.qoder.cosyVersionHeader
const COSY_CLIENT_TYPE = CLIENTS.qoder.clientType
/** App code sent in the legacy signature and the jobToken headers. */
const COSY_APPCODE = 'cosy'
/**
 * The shared secret baked into the official client, base64-encoded.
 *
 * NOT A USER SECRET: it is identical in every copy of the client and is only
 * used to sign the jobToken exchange. It is here because the protocol requires
 * it, exactly as the client does.
 */
const COSY_SECRET_B64 = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=='

/** The gateway RSA public key. The client uses it to wrap a per-session AES key. */
const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex')
const sha512b64url = (text) => createHash('sha512').update(text, 'utf8').digest('base64url')

/**
 * Cosy base64: standard base64, then rotate the three n/3-sized blocks, then
 * transliterate through the custom alphabet.
 *
 * The rotation is not a security measure — it is what the client does, and the
 * server rejects a body that did not go through it. Reproduced rather than
 * reasoned about.
 */
function cosyEncode(plaintext) {
  const std = Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  let out = ''
  for (const ch of rearranged) {
    const mapped = s2c.get(ch)
    if (mapped === undefined) throw new Error(`cosy encode: char out of alphabet: ${ch}`)
    out += mapped
  }
  return out
}

/**
 * Legacy signature, used only by the jobToken exchange:
 * md5("cosy&<secret>&<rfc1123-date>").
 */
const signLegacy = (date) => md5(`${COSY_APPCODE}&${COSY_SECRET_B64}&${date}`)

/**
 * Current signature: md5 over the bearer payload, the wrapped session key, the
 * date, the (already encoded) body, and the path with `/algo` stripped.
 *
 * Every part is signed in the exact form it is sent — re-serialising the body
 * here would break the signature.
 */
const signRequest = (payloadB64, cosyKey, cosyDate, body, pathSig) =>
  md5(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`)

const composeBearer = (payloadB64, sig) => `Bearer COSY.${payloadB64}.${sig}`

/** The path as signed: no query string, and without the leading `/algo`. */
function pathSigFrom(fullUrl) {
  let path
  try {
    path = new URL(fullUrl).pathname
  } catch {
    path = fullUrl
  }
  return path.startsWith('/algo') ? path.slice(5) : path
}

/**
 * Device fingerprint derived from the credential itself.
 *
 * It has to be STABLE across calls — the server treats a changing machine id
 * from one token as a stolen token — so it is a hash of the credential rather
 * than a random id persisted somewhere.
 */
function deriveFingerprint(credentialValue) {
  const seed = `cred:${credentialValue}`
  return {
    machineId: md5(`machine:${seed}`),
    machineType: md5(`machinetype:${seed}`).slice(0, 18),
    machineToken: sha512b64url(`machinetoken:${seed}`).slice(0, 43),
  }
}

/** AES-128-CBC with PKCS7 padding. The IV is the key, as the client does it. */
function aesCbcEncrypt(plain, key) {
  const iv = key
  const padLen = 16 - (plain.length % 16)
  const padded = new Uint8Array(plain.length + padLen)
  padded.set(plain)
  padded.fill(padLen, plain.length)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  return new Uint8Array(Buffer.concat([cipher.update(padded), cipher.final()]))
}

const rsaEncrypt = (plain) =>
  new Uint8Array(publicEncrypt({ key: SERVER_PUBKEY_PEM, padding: 1 }, Buffer.from(plain)))

/**
 * Start a session: random AES key -> RSA-wrap it into `cosyKey` -> AES-encrypt
 * the identity payload into `info`. Both travel in the bearer on every call.
 */
function newCosySession(identityValue, fingerprint) {
  const tempKey = new Uint8Array(Buffer.from(randomBytes(16).toString('hex').slice(0, 16), 'utf8'))
  const cosyKey = Buffer.from(rsaEncrypt(tempKey)).toString('base64')
  const payload = JSON.stringify({
    name: identityValue.name,
    aid: identityValue.aid,
    uid: identityValue.uid,
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: identityValue.userType,
    security_oauth_token: identityValue.securityOauthToken,
    refresh_token: identityValue.refreshToken,
  })
  return {
    cosyKey,
    info: Buffer.from(aesCbcEncrypt(new Uint8Array(Buffer.from(payload, 'utf8')), tempKey)).toString('base64'),
    identity: identityValue,
    ...fingerprint,
  }
}

/**
 * The bearer payload: {cosyVersion, ideVersion, info, requestId, version}.
 *
 * KEY ORDER IS PART OF THE FORMAT. The signature covers this JSON, so the keys
 * are sorted before serialising; an unsorted object would produce a different
 * string and a signature the server rejects.
 */
function buildPayloadB64(info) {
  const payload = { cosyVersion: COSY_VERSION, ideVersion: '', info, requestId: randomUUID(), version: 'v1' }
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1)))
  return Buffer.from(JSON.stringify(sorted)).toString('base64')
}

/**
 * The jobToken exchange body. A PAT and a `drt-` refresh token take the same
 * field two different ways: exactly one of them is populated, and `needRefresh`
 * says which. Sending both, or the wrong one, is rejected.
 */
function jobTokenBody(credentialValue) {
  const isRefresh = credentialValue.startsWith('drt-')
  const outer = {
    payload: JSON.stringify({
      personalToken: isRefresh ? '' : credentialValue,
      securityOauthToken: '',
      refreshToken: isRefresh ? credentialValue : '',
      needRefresh: isRefresh,
      authInfo: {},
    }),
    encodeVersion: '1',
  }
  return cosyEncode(new TextEncoder().encode(JSON.stringify(outer)))
}

/** Read a PAT: the first account in the vault that has one. */
async function credential(region = 'cn') {
  const file = REGIONS[region].accountsFile
  if (!existsSync(file)) {
    throw new Error(
      `no Qoder credential at ${file} — add a PAT in the dsh-connect-qoder settings card, or set PI_CONNECT_QODER_CREDENTIALS`,
    )
  }
  const doc = JSON.parse(await readFile(file, 'utf8'))
  const list = Array.isArray(doc.accounts) ? doc.accounts : []
  const account = list.find((entry) => typeof entry?.pat === 'string' && entry.pat !== '')
  if (account === undefined) throw new Error(`credential file ${file} contains no PAT`)
  return { pat: account.pat, name: account.accountName ?? '', id: account.id ?? '' }
}

/**
 * Session cache, keyed by PAT.
 *
 * A jobToken exchange costs a round trip and creates server-side state, so it is
 * reused until shortly before expiry (the 5-minute margin absorbs clock skew
 * between this machine and the gateway).
 */
const sessions = new Map()

async function ensureSession(region = 'cn') {
  const cred = await credential(region)
  const cached = sessions.get(cred.pat)
  if (cached !== undefined && cached.expireAtMs - Date.now() > 300_000) return cached

  const config = REGIONS[region]
  const fingerprint = deriveFingerprint(cred.pat)
  const date = new Date().toUTCString()
  const response = await fetch(`${config.gateway}${JOB_TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      'cosy-machinetoken': fingerprint.machineToken,
      'cosy-machinetype': fingerprint.machineType,
      'login-version': 'v2',
      appcode: COSY_APPCODE,
      accept: 'application/json',
      'accept-encoding': 'identity',
      'cosy-version': COSY_VERSION_HEADER,
      'cosy-clienttype': COSY_CLIENT_TYPE,
      date,
      signature: signLegacy(date),
      'content-type': 'application/json',
      'cosy-machineid': fingerprint.machineId,
      'user-agent': 'Go-http-client/2.0',
    },
    body: jobTokenBody(cred.pat),
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`Qoder jobToken exchange failed: HTTP ${String(response.status)} ${text.slice(0, 300)}`)
  const data = JSON.parse(text)
  const session = {
    ...newCosySession(
      {
        name: String(data.name ?? ''),
        aid: String(data.id ?? ''),
        uid: String(data.id ?? ''),
        userType: String(data.userType ?? 'personal_standard'),
        securityOauthToken: String(data.securityOauthToken ?? ''),
        refreshToken: String(data.refreshToken ?? ''),
      },
      fingerprint,
    ),
    jobToken: String(data.securityOauthToken ?? ''),
    expireAtMs: Number(data.expireTime ?? 0),
    accountName: String(data.name ?? ''),
    accountId: String(data.id ?? ''),
    plan: String(data.plan ?? ''),
  }
  sessions.set(cred.pat, session)
  return session
}

/** Headers shared by every cosy call (chat, catalog). */
const DEFAULT_HEADERS = {
  'cosy-data-policy': 'agree',
  'content-type': 'application/json',
  'cosy-clienttype': COSY_CLIENT_TYPE,
  'login-version': 'v2',
  'user-agent': 'Go-http-client/2.0',
  'cosy-scene': 'assistant',
  'cosy-business-product': 'ide',
  'cosy-business-type': 'agent',
}

/** A signed GET on the cosy channel, used for the model catalog. */
async function bearerGet(region, session, url) {
  const pathSig = pathSigFrom(url)
  const payloadB64 = buildPayloadB64(session.info)
  const date = String(Math.floor(Date.now() / 1000))
  const bearer = composeBearer(payloadB64, signRequest(payloadB64, session.cosyKey, date, '', pathSig))
  const response = await fetch(url, {
    headers: {
      ...DEFAULT_HEADERS,
      'cosy-machinetype': session.machineType,
      'cosy-date': date,
      'cosy-user': session.identity.uid,
      'cosy-key': session.cosyKey,
      accept: 'application/json',
      authorization: bearer,
      'cosy-version': COSY_VERSION_HEADER,
      'cosy-machineid': session.machineId,
      'cosy-machinetoken': session.machineToken,
    },
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`Qoder request failed: HTTP ${String(response.status)} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/**
 * Catalog cache.
 *
 * The catalog changes when the vendor ships a model, not per request, and the
 * caller resolves a display name back to the internal key from it. One fetch per
 * process is the right granularity; a per-request fetch would add a round trip
 * to every message.
 */
let catalogCache

export async function catalog(region = 'cn') {
  if (catalogCache !== undefined) return catalogCache
  const session = await ensureSession(region)
  const data = await bearerGet(region, session, `${REGIONS[region].gateway}${MODELS_PATH}`)
  const list = (Array.isArray(data.chat) ? data.chat : [])
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      key: typeof entry.key === 'string' ? entry.key : '',
      name: typeof entry.display_name === 'string' ? entry.display_name : '',
      enable: entry.enable !== false,
      isVl: entry.is_vl === true,
      isReasoning: entry.is_reasoning === true,
      isFree: entry.is_free === true,
      maxInputTokens: typeof entry.max_input_tokens === 'number' ? entry.max_input_tokens : undefined,
      contextConfig: entry.context_config !== null && typeof entry.context_config === 'object' ? entry.context_config : undefined,
    }))
    .filter((model) => model.key !== '' && model.name !== '' && model.enable)
    // `auto` is a router, not a model: it picks a model and a context size on
    // the server side, so it has nothing stable to list here.
    .filter((model) => model.key !== 'auto')
  catalogCache = list
  return list
}

/**
 * The chat body template.
 *
 * Every id field must be fresh per request — the server treats a repeated
 * request id as a replay. `createChatBodyTemplate()` returns the constant shape
 * and the caller overwrites the ids, so a new field added upstream is added in
 * exactly one place.
 */
function createChatBodyTemplate() {
  return {
    request_id: '',
    request_set_id: '',
    chat_record_id: '',
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      extra: { modelConfig: { is_reasoning: false, key: 'lite' }, originalContent: { type: 'text', text: '' } },
      text: { type: 'text', text: '' },
    },
    session_id: '',
    source: 1,
    version: '3',
    aliyun_user_type: 'personal_standard',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: { key: 'lite', is_vl: false, is_reasoning: false, source: 'system' },
    messages: [],
    business: { id: '', name: 'hi', begin_at: 0 },
  }
}

const blankMeta = () => ({
  id: '',
  usage: {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    completion_tokens_details: { reasoning_tokens: 0 },
    prompt_tokens_details: { cached_tokens: 0 },
  },
})

/**
 * Flatten an OpenAI message to text.
 *
 * The cosy protocol carries reasoning and tool traffic as plain text in most
 * message positions, so a structured part array has to collapse. Nothing is
 * dropped silently: every part contributes its text.
 */
function messageText(message) {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

/**
 * Image URLs from a user message.
 *
 * Only user messages carry images on this protocol; an image part anywhere else
 * is ignored rather than promoted, because the server has no field for it.
 */
function messageImages(message) {
  if (message.role !== 'user' || !Array.isArray(message.content)) return []
  const urls = []
  for (const part of message.content) {
    const image = part?.image_url
    if (image !== undefined && typeof image.url === 'string') urls.push(image.url)
  }
  return urls
}

const TOOL_CALLS_TEXT_RE = /Tool calls:\s*(\[[\s\S]*?\])/

/**
 * Recover tool calls that were flattened into text.
 *
 * History written by a previous turn may carry its calls as a `Tool calls: [...]`
 * block rather than structured fields. Parsing it back is what keeps an old
 * conversation replayable after a restart.
 */
function parseToolCallsText(text) {
  if (text === '') return undefined
  const match = TOOL_CALLS_TEXT_RE.exec(text)
  if (match?.[1] === undefined) return undefined
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) && parsed.every((item) => item !== null && typeof item === 'object') ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether an assistant message's tool calls already have results.
 *
 * This decides the wire shape for that message: with results present the calls
 * go out structured, without them (the call is still in flight) they go out as
 * text so the server does not wait for a result that never came.
 */
function hasResolvedToolResponse(messages, index) {
  const message = messages[index]
  if (message === undefined || message.role !== 'assistant') return false
  const calls = message.tool_calls
  const hasCalls = (Array.isArray(calls) && calls.length > 0) || parseToolCallsText(messageText(message)) !== undefined
  if (!hasCalls) return false
  for (let i = index + 1; i < messages.length; i += 1) {
    const next = messages[i]
    if (next?.role === 'tool') return true
    if (next !== undefined && (next.role === 'assistant' || next.role === 'user' || next.role === 'system')) return false
  }
  return false
}

const structuredMessage = (role, text) => ({
  role,
  content: text,
  response_meta: blankMeta(),
  reasoning_content_signature: '',
})

function userMessage(text, images = []) {
  const parts = []
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } })
  if (text.trim() !== '') parts.push({ type: 'text', text })
  if (parts.length === 0) parts.push({ type: 'text', text: '' })
  return {
    role: 'user',
    content: '',
    contents: parts,
    response_meta: blankMeta(),
    reasoning_content_signature: '',
  }
}

function toolMessage(message, text) {
  const out = structuredMessage('tool', text)
  if (typeof message.name === 'string') out.name = message.name
  if (typeof message.tool_call_id === 'string') out.tool_call_id = message.tool_call_id
  return out
}

const renderToolCalls = (calls) => `Tool calls:\n${JSON.stringify(calls)}`

function renderToolResult(message, text) {
  const name = typeof message.name === 'string' ? message.name : ''
  const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
  let out = 'Tool result'
  if (name !== '') out += ` (${name})`
  if (id !== '') out += ` [${id}]`
  if (text.trim() !== '') out += `:\n${text}`
  return out
}

/** One OpenAI message -> the cosy shape. `undefined` means "omit this one". */
function convertMessage(message, toolsEnabled, allowStructured) {
  const role = typeof message.role === 'string' ? message.role : 'user'
  const text = messageText(message)
  let structuredCalls
  if (toolsEnabled && allowStructured) {
    const calls =
      Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : parseToolCallsText(text)
    if (calls !== undefined) structuredCalls = calls
  }
  if (role === 'assistant' && structuredCalls !== undefined) {
    const out = structuredMessage('assistant', text)
    out.tool_calls = structuredCalls
    return out
  }
  if (role === 'tool') {
    return toolsEnabled ? toolMessage(message, text) : structuredMessage('user', renderToolResult(message, text))
  }
  let finalText = text
  if (role === 'assistant' && !toolsEnabled && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    finalText = [text, renderToolCalls(message.tool_calls)].filter(Boolean).join('\n\n')
  }
  const images = role === 'user' ? messageImages(message) : []
  if (finalText.trim() === '' && images.length === 0) return undefined
  return role === 'user' ? userMessage(finalText, images) : structuredMessage(role, finalText)
}

/**
 * Convert the whole message array.
 *
 * Done as one pass rather than a `.map`, because whether a message may use the
 * structured tool shape depends on what follows it.
 */
function buildMessages(incoming, toolsEnabled) {
  const rebuilt = []
  for (let i = 0; i < incoming.length; i += 1) {
    const allowStructured = toolsEnabled && hasResolvedToolResponse(incoming, i)
    const converted = convertMessage(incoming[i], toolsEnabled, allowStructured)
    if (converted !== undefined) rebuilt.push(converted)
  }
  return rebuilt
}

/**
 * The latest user text.
 *
 * The protocol requires a conversation title and a prompt echo on every request;
 * both are this string.
 */
function latestPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user') {
      const text = messageText(message)
      if (text.trim() !== '') return text
    }
  }
  return ''
}

/**
 * Decode one SSE frame into {delta, usage}.
 *
 * The frame is a DOUBLE envelope: an outer status wrapper whose `body` is a JSON
 * string containing the actual OpenAI-shaped chunk. Both layers have to be
 * opened, and a non-200 status hides in the outer one — which is why an upstream
 * error arrives here as a thrown error rather than as a malformed delta.
 */
function parseFrame(dataPayload) {
  let wrapper
  try {
    wrapper = JSON.parse(dataPayload)
  } catch {
    return undefined
  }
  const status = wrapper.statusCodeValue
  if (status !== undefined && status !== null && Number(status) !== 200) {
    const detail = typeof wrapper.body === 'string' ? wrapper.body : dataPayload.slice(0, 400)
    throw new Error(`Qoder upstream envelope error: HTTP ${String(status)} ${detail.slice(0, 300)}`)
  }
  const innerText = wrapper.body
  if (typeof innerText !== 'string' || innerText === '') return undefined
  let inner
  try {
    inner = JSON.parse(innerText)
  } catch {
    return undefined
  }
  if (inner === null || typeof inner !== 'object') return undefined
  if (typeof inner.code === 'string' && inner.code !== '' && inner.code !== '0') {
    throw new Error(`Qoder upstream error code=${inner.code}: ${String(inner.message ?? '')}`)
  }

  const delta = {}
  const choices = Array.isArray(inner.choices) ? inner.choices : []
  for (const choice of choices) {
    const piece = choice?.delta
    if (piece === undefined || piece === null) continue
    if (typeof piece.role === 'string' && piece.role !== '') delta.role = piece.role
    if (typeof piece.content === 'string' && piece.content !== '') delta.content = piece.content
    if (typeof piece.reasoning_content === 'string' && piece.reasoning_content !== '') {
      delta.reasoning_content = piece.reasoning_content
    }
    if (Array.isArray(piece.tool_calls) && piece.tool_calls.length > 0) delta.tool_calls = piece.tool_calls
  }

  let usage
  if (inner.usage !== null && typeof inner.usage === 'object') {
    const input = Number(inner.usage.prompt_tokens ?? 0)
    const output = Number(inner.usage.completion_tokens ?? 0)
    const details = inner.usage.prompt_tokens_details
    const cached = details !== null && typeof details === 'object' ? details.cached_tokens : undefined
    if (input > 0 || output > 0) {
      usage = {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: Number(inner.usage.total_tokens ?? input + output),
        ...(typeof cached === 'number' && cached >= 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
      }
    }
  }
  if (Object.keys(delta).length === 0 && usage === undefined) return undefined
  return { delta, usage }
}

/** Upstream tool-call fragments -> OpenAI deltas, keeping `index` so they can be joined. */
function toolCallsDelta(calls) {
  return calls.map((call, position) => {
    const fn = call?.function ?? {}
    return {
      index: typeof call?.index === 'number' ? call.index : position,
      ...(typeof call?.id === 'string' && call.id !== '' ? { id: call.id } : {}),
      type: 'function',
      function: {
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
      },
    }
  })
}

/**
 * Resolve the model the client named into a catalog entry.
 *
 * Qoder's internal ids are short codes (`dmodel`, `kmodel_latest`); the readable
 * name only exists in the upstream `display_name`. Pi's model picker and footer
 * both render `model.id`, so the Pi-side entries use the display name — this
 * accepts either form: an exact internal key first, then key or display name
 * case-insensitively. Accepting both is what lets the same config work whether
 * the user picked the model in Pi or called the gateway directly.
 */
function resolveModel(models, wanted) {
  const text = typeof wanted === 'string' ? wanted.trim() : ''
  if (text === '') return undefined
  const exact = models.find((entry) => entry.key === text)
  if (exact !== undefined) return exact
  const lower = text.toLowerCase()
  return models.find((entry) => entry.key.toLowerCase() === lower || entry.name.toLowerCase() === lower)
}

/**
 * Run one chat request. `emit`/`emitUsage`/`emitDone` reach the client through
 * the gateway, which owns SSE framing; this function owns meaning only.
 */
export async function chat(body, { emit, emitUsage, emitDone }) {
  const region = 'cn'
  const models = await catalog(region)
  const model = resolveModel(models, body.model)
  // The wire wants the short code. If the name does not resolve, pass it through
  // unchanged so upstream produces its own error instead of a confusing local one.
  const modelKey = model?.key ?? (typeof body.model === 'string' ? body.model : '')
  const session = await ensureSession(region)

  const template = createChatBodyTemplate()
  const isReasoning = model?.isReasoning === true
  template.model_config.key = modelKey
  template.model_config.is_vl = model?.isVl === true
  template.model_config.is_reasoning = isReasoning
  template.chat_context.extra.modelConfig.key = modelKey
  template.chat_context.extra.modelConfig.is_reasoning = isReasoning
  template.aliyun_user_type = 'personal_standard'

  const effort = body.reasoning_effort ?? body.reasoning?.effort
  if (typeof effort === 'string' && effort !== '' && effort !== 'minimal' && effort !== 'xhigh' && effort !== 'max') {
    template.reasoningEffort = effort
    template.parameters = { reasoning_effort: effort }
  }

  const incoming = Array.isArray(body.messages) ? body.messages : []
  const prompt = latestPrompt(incoming)
  const toolsEnabled = Array.isArray(body.tools) && body.tools.length > 0
  template.messages = buildMessages(incoming, toolsEnabled)
  if (toolsEnabled) {
    template.tools = body.tools.map((tool) => {
      const fn = tool?.function ?? {}
      return {
        type: 'function',
        function: {
          name: fn.name ?? '',
          description: fn.description ?? '',
          // Unlike Trae, this protocol wants `parameters` as an object.
          parameters: fn.parameters ?? { type: 'object', properties: {} },
        },
      }
    })
  }
  const requestId = randomUUID()
  template.request_id = requestId
  template.chat_record_id = requestId
  template.request_set_id = randomUUID()
  template.session_id = randomUUID()
  template.business.id = randomUUID()
  template.business.name = prompt.slice(0, 30) || 'hi'
  template.business.begin_at = Date.now()
  template.chat_context.extra.originalContent.text = prompt
  template.chat_context.text.text = prompt

  const url = `${REGIONS[region].gateway}${CHAT_PATH}`
  const encoded = cosyEncode(new TextEncoder().encode(JSON.stringify(template)))
  const date = String(Math.floor(Date.now() / 1000))
  const payloadB64 = buildPayloadB64(session.info)
  const bearer = composeBearer(payloadB64, signRequest(payloadB64, session.cosyKey, date, encoded, pathSigFrom(url)))

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'cosy-machinetype': session.machineType,
      'cosy-date': date,
      'cosy-user': session.identity.uid,
      'cosy-key': session.cosyKey,
      'cache-control': 'no-cache',
      accept: 'text/event-stream',
      authorization: bearer,
      'cosy-version': COSY_VERSION_HEADER,
      'cosy-machineid': session.machineId,
      'cosy-machinetoken': session.machineToken,
      'x-model-key': modelKey,
      'x-model-source': 'system',
    },
    body: encoded,
    signal: AbortSignal.timeout(600_000),
  })

  if (!upstream.ok || upstream.body === null) {
    const text = await upstream.text().catch(() => '')
    throw new Error(`qoder ${String(upstream.status)}: ${text.slice(0, 400)}`)
  }

  let buffered = ''
  let finish = 'stop'
  let usage
  const collected = []
  const toolCallSlots = new Map()
  const decoder = new TextDecoder()

  for await (const part of upstream.body) {
    buffered += decoder.decode(part, { stream: true })
    let cut
    while ((cut = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, cut).trim()
      buffered = buffered.slice(cut + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      const frame = parseFrame(payload)
      if (frame === undefined) continue
      if (frame.usage !== undefined) usage = frame.usage
      const delta = frame.delta
      const out = {}
      if (delta.role !== undefined) out.role = delta.role
      if (delta.content !== undefined) out.content = delta.content
      if (delta.reasoning_content !== undefined) out.reasoning_content = delta.reasoning_content
      if (delta.tool_calls !== undefined) {
        out.tool_calls = toolCallsDelta(delta.tool_calls)
        for (const call of out.tool_calls) {
          const slot = toolCallSlots.get(call.index) ?? { id: '', name: '', arguments: '' }
          if (call.id !== undefined) slot.id = call.id
          if (call.function.name !== '') slot.name = call.function.name
          slot.arguments += call.function.arguments
          toolCallSlots.set(call.index, slot)
        }
        finish = 'tool_calls'
      }
      if (Object.keys(out).length === 0) continue
      collected.push(out)
      emit(out)
    }
  }

  if (toolCallSlots.size > 0) finish = 'tool_calls'
  if (usage !== undefined) emitUsage(usage)
  const text = collected.map((delta) => delta.content ?? '').join('')
  emitDone(finish, { text, usage, collected, toolCalls: toolCallSlots })
}

/**
 * Catalog in OpenAI `/v1/models` shape.
 *
 * `id` is the display name so that what the picker shows and what it later sends
 * back are the same string.
 */
export async function models() {
  const list = await catalog('cn')
  return list.map((model) => ({ id: model.name, object: 'model', owned_by: 'qoder' }))
}

/**
 * Remaining credits.
 *
 * Upstream reports two buckets — the plan quota and separately purchased add-ons
 * — and the honest answer to "how much can I still use" is their sum. Only the
 * remainder is reported: totals belong on the billing page, and a footer that
 * showed both would be answering a question nobody asked.
 */
export async function credits() {
  const region = 'cn'
  const session = await ensureSession(region)
  const url = `${REGIONS[region].openapi}/sash/api/v2/me/usage`
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${session.jobToken}`,
      'cosy-clienttype': COSY_CLIENT_TYPE,
      'user-agent': 'Qoder',
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`Qoder billing failed: HTTP ${String(response.status)} ${text.slice(0, 200)}`)
  const data = JSON.parse(text)
  const usage = data.qoderUsage ?? data
  const round = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : 0)
  const mainRemaining = round(usage?.userQuota?.remaining)
  const addOnRemaining = round(usage?.addOnQuota?.remaining)
  const unit = typeof usage?.userQuota?.unit === 'string' ? usage.userQuota.unit : 'credits'
  return {
    provider: 'qoder',
    account: session.accountName,
    plan: session.plan,
    remaining: Math.round((mainRemaining + addOnRemaining) * 100) / 100,
    unit,
    expiresAt: typeof usage?.expiresAt === 'number' ? usage.expiresAt : undefined,
  }
}

if (isMainModule(import.meta.url)) {
  const session = await ensureSession('cn')
  const list = await catalog('cn')
  const usage = await credits()
  console.log(`account: ${session.accountName} (${session.plan || 'unknown plan'})`)
  console.log(`catalog: ${String(list.length)} models -> ${list.map((model) => model.key).join(', ')}`)
  console.log(`credits: ${String(usage.remaining)} ${usage.unit}`)
}
