/**
 * Gateway contract tests.
 *
 * NO NETWORK, NO CREDENTIALS. The provider adapters are replaced with fakes, so
 * these assert the part of the gateway that is easy to get wrong and hard to see:
 * the exact byte shape of the SSE stream that pi's `openai-completions` client
 * consumes. A gateway that renders text correctly but drops the usage chunk
 * produces a footer stuck on `?/200k`, which looks like a pi bug and is not one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createGateway } from '../src/gateway.mjs'

/** Start the server on an ephemeral port and return its base URL plus a closer. */
async function serve(adapters) {
  const server = createGateway(adapters)
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Collect an SSE response into raw frames. */
async function frames(response) {
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice(6))
}

test('healthz lists only the proxied providers', async () => {
  const { base, close } = await serve({ trae: { models: async () => [], chat: async () => {} } })
  try {
    const body = await (await fetch(`${base}/healthz`)).json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.providers, ['trae'])
  } finally {
    await close()
  }
})

test('models endpoint answers in OpenAI list shape', async () => {
  const { base, close } = await serve({
    qoder: { models: async () => [{ id: 'GLM-5.3', object: 'model', owned_by: 'qoder' }] },
  })
  try {
    const body = await (await fetch(`${base}/qoder/v1/models`)).json()
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 1)
    assert.equal(body.data[0].id, 'GLM-5.3')
  } finally {
    await close()
  }
})

test('unknown provider is a 404, not a crash', async () => {
  const { base, close } = await serve({ trae: { models: async () => [] } })
  try {
    const response = await fetch(`${base}/nope/v1/models`)
    assert.equal(response.status, 404)
    assert.match((await response.json()).error.message, /unknown provider/u)
  } finally {
    await close()
  }
})

test('stream ends with exactly one usage-bearing chunk before [DONE]', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  const { base, close } = await serve({
    trae: {
      models: async () => [],
      chat: async (_body, { emit, emitUsage, emitDone }) => {
        emit({ content: 'hel' })
        emit({ content: 'lo' })
        emitUsage(usage)
        emitDone('stop', {})
      },
    },
  })
  try {
    const response = await fetch(`${base}/trae/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const list = await frames(response)
    assert.equal(list.at(-1), '[DONE]')

    const payloads = list.slice(0, -1).map((frame) => JSON.parse(frame))
    const withUsage = payloads.filter((payload) => payload.usage !== undefined)
    // Exactly one: pi updates the message's usage from the last chunk that has
    // it, and repeating it in every chunk would inflate nothing but is still the
    // wrong shape to promise.
    assert.equal(withUsage.length, 1)
    assert.deepEqual(withUsage[0].usage, usage)
    // The usage chunk must also close the message, or pi never marks it finished.
    assert.equal(withUsage[0].choices[0].finish_reason, 'stop')

    const text = payloads.map((payload) => payload.choices[0].delta.content ?? '').join('')
    assert.equal(text, 'hello')
  } finally {
    await close()
  }
})

test('no usage is invented when the upstream reported none', async () => {
  const { base, close } = await serve({
    trae: {
      models: async () => [],
      chat: async (_body, { emit, emitDone }) => {
        emit({ content: 'ok' })
        emitDone('stop', {})
      },
    },
  })
  try {
    const response = await fetch(`${base}/trae/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
    })
    const payloads = (await frames(response)).slice(0, -1).map((frame) => JSON.parse(frame))
    assert.equal(payloads.filter((payload) => payload.usage !== undefined).length, 0)
    // Silence would leave pi waiting for a finish reason that never arrives.
    assert.equal(payloads.at(-1).choices[0].finish_reason, 'stop')
  } finally {
    await close()
  }
})

test('a non-streaming request returns one complete message', async () => {
  const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
  const { base, close } = await serve({
    qoder: {
      models: async () => [],
      chat: async (_body, { emit, emitUsage, emitDone }) => {
        emit({ content: 'done' })
        emitUsage(usage)
        emitDone('stop', {})
      },
    },
  })
  try {
    const response = await fetch(`${base}/qoder/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.3', stream: false, messages: [] }),
    })
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await response.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, 'done')
    assert.deepEqual(body.usage, usage)
  } finally {
    await close()
  }
})

test('an upstream failure mid-stream arrives as content, not as a hang', async () => {
  const { base, close } = await serve({
    trae: {
      models: async () => [],
      chat: async (_body, { emit }) => {
        emit({ content: 'partial' })
        throw new Error('upstream exploded')
      },
    },
  })
  try {
    const response = await fetch(`${base}/trae/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
    })
    // 200 already went out with the first token, so the error cannot be a status.
    assert.equal(response.status, 200)
    const payloads = (await frames(response)).slice(0, -1).map((frame) => JSON.parse(frame))
    const last = payloads.at(-1)
    assert.equal(last.choices[0].finish_reason, 'stop')
    assert.match(last.choices[0].delta.content, /upstream exploded/u)
  } finally {
    await close()
  }
})

test('credits failure is reported per provider without hiding the others', async () => {
  // `creditsAll` is exercised through the route only for shape: the real
  // providers are not reachable here, so this asserts the error envelope.
  const { base, close } = await serve({ trae: { models: async () => [] } })
  try {
    const response = await fetch(`${base}/credits/unknown`)
    assert.equal(response.status, 502)
    assert.match((await response.json()).error.message, /unknown provider/u)
  } finally {
    await close()
  }
})
