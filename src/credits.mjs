/**
 * Credit balances: three upstreams, three shapes, one report.
 *
 * THE ONLY NUMBER IS "HOW MUCH IS LEFT". Not the total, not the spend. The
 * footer has room for one figure and the question it answers is "can I keep
 * going" — totals belong on each vendor's own billing page. Sums are rounded to
 * two decimals so a footer refreshed once a minute does not flicker.
 *
 * WHY WORKBUDDY LIVES HERE BUT ITS CHAT DOES NOT. Its chat endpoint is already
 * OpenAI-compatible, so proxying it would translate nothing. Its billing
 * endpoint is not, so reading the balance IS a translation and belongs with the
 * other two.
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CLIENTS, DSH_HOME } from './config.mjs'
import { isMainModule } from './util.mjs'
import * as qoder from './providers/qoder.mjs'
import * as trae from './providers/trae.mjs'

/** WorkBuddy billing endpoints, one per region. */
const WORKBUDDY_REGIONS = {
  cn: 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource',
}

const round = (value) => Math.round(value * 100) / 100

/**
 * The freshest WorkBuddy credential in a region's vault.
 *
 * One file per account; the newest `refreshedAtMs` wins, because an older file
 * is an older token and may already be revoked. A file that fails to parse is
 * skipped rather than fatal — one corrupt account must not hide the others.
 */
async function workbuddyCredential(region) {
  const dir = join(DSH_HOME, 'workbuddy-vault', region)
  if (!existsSync(dir)) return undefined
  let best
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const doc = JSON.parse(await readFile(join(dir, name), 'utf8'))
      const token = doc?.auth?.accessToken
      if (typeof token !== 'string' || token === '') continue
      const refreshedAtMs = Number(doc?.refreshedAtMs ?? 0)
      if (best === undefined || refreshedAtMs > best.refreshedAtMs) {
        best = {
          token,
          refreshedAtMs,
          account: doc?.account?.nickname ?? doc?.accountId ?? name.replace(/\.json$/u, ''),
          expiresAtMs: Number(doc?.auth?.expiresAt ?? 0) * 1000,
        }
      }
    } catch {
      /* one bad file is not a reason to report nothing */
    }
  }
  return best
}

/**
 * WorkBuddy remaining credits: the sum of what every bucket has left.
 *
 * `CycleCapacityRemain` IS THE ANSWER, `CapacityRemain` IS NOT. The first is
 * what is left in the current billing cycle, the second is what is left of the
 * bucket's lifetime. Measured on a trial bucket: `CapacityRemain` still read
 * 500 while `CycleCapacityRemain` had fallen to 217.63. "How much can I still
 * use" is the cycle figure. Upstream writes both as strings (`"217.63000011"`),
 * so they are parsed explicitly rather than trusted as numbers.
 */
async function workbuddyCredits(region = 'cn') {
  const endpoint = WORKBUDDY_REGIONS[region]
  if (endpoint === undefined) throw new Error(`unknown WorkBuddy region: ${region}`)
  const cred = await workbuddyCredential(region)
  if (cred === undefined) throw new Error(`no WorkBuddy credential found for region ${region}`)

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...CLIENTS.workbuddy.headers, Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json()
  if (body?.code !== 0) throw new Error(`WorkBuddy billing failed: code ${String(body?.code)} ${String(body?.msg ?? '')}`)

  const accounts = body?.data?.Response?.Data?.Accounts
  const list = Array.isArray(accounts) ? accounts : []
  const num = (value) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  let remaining = 0
  let unit = 'credits'
  for (const account of list) {
    remaining += round(
      num(
        account?.CycleCapacityRemainPrecise ??
          account?.CycleCapacityRemain ??
          account?.CapacityRemainPrecise ??
          account?.CapacityRemain,
      ),
    )
    if (typeof account?.CapacityUnit === 'string') unit = account.CapacityUnit
  }
  return {
    provider: 'workbuddy',
    account: cred.account,
    remaining: round(remaining),
    unit,
    ...(cred.expiresAtMs === 0 ? {} : { expiresAt: cred.expiresAtMs }),
  }
}

const PROVIDERS = {
  trae: () => trae.credits(),
  qoder: () => qoder.credits(),
  workbuddy: () => workbuddyCredits('cn'),
}

/** Every provider this module can report on. */
export const CREDIT_PROVIDERS = Object.keys(PROVIDERS)

/** One provider's remaining balance. Throws on unknown names, by design. */
export async function creditsFor(name) {
  const loader = PROVIDERS[name]
  if (loader === undefined) throw new Error(`unknown provider: ${name}`)
  return await loader()
}

/**
 * Every provider's balance.
 *
 * Failures are reported per provider and never abort the batch: one expired
 * token must not blank out the other two readings. The unsuccessful entry is an
 * `{ error }` object rather than an omission so the caller can tell "zero
 * credits" from "could not ask".
 */
export async function creditsAll() {
  const out = {}
  await Promise.all(
    Object.entries(PROVIDERS).map(async ([name, loader]) => {
      try {
        out[name] = await loader()
      } catch (error) {
        out[name] = { provider: name, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
  return out
}

if (isMainModule(import.meta.url)) {
  const all = await creditsAll()
  for (const [name, value] of Object.entries(all)) {
    console.log(
      'error' in value
        ? `${name}: ${value.error}`
        : `${name}: ${String(value.remaining)} ${value.unit}${value.account === '' ? '' : ` (${value.account})`}`,
    )
  }
}
