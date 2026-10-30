#!/usr/bin/env node
/**
 * Build the Trae model catalog from the installed desktop client.
 *
 * WHY A LOCAL FILE IS NEEDED AT ALL. Trae names a model twice per chat request:
 * once as `model`, once as `function` (the wire endpoint that serves it). The
 * two are not derivable from each other — `glm-5.3` is served by
 * `solo_agent_remote`, while other models of the same family are not — so the
 * mapping has to be read from somewhere authoritative.
 *
 * WHY THE CLIENT'S OWN DATABASE IS THAT SOURCE. Probing the endpoint for each
 * candidate name burns credits and cannot be done for models the account cannot
 * reach; scraping the public site gives the marketing list, which is not the
 * list this build can actually select. The desktop client already holds the
 * exact answer for this machine and this login, in the SQLite database where it
 * caches its model picker.
 *
 * WHAT IS WRITTEN. A minimal array: id, display name, context window, max output,
 * the wire function, and which thinking efforts the model accepts. Everything
 * else the database holds (icons, promo rates, browser-tool flags) is irrelevant
 * to the gateway.
 *
 * Usage:
 *   node bin/catalog.mjs                     # write the catalog for "Trae CN"
 *   node bin/catalog.mjs --app "TRAE SOLO CN"
 *   node bin/catalog.mjs --group solo_work_lite   # pick a different picker group
 *   node bin/catalog.mjs --stdout            # print instead of writing
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { TRAE_CATALOG, appSupport } from '../src/config.mjs'

/** The database key the picker caches its model list under, per group. */
const CACHE_KEY = '3041714748265068:AI.agent.model.model_list_map'

/**
 * Which picker group to read.
 *
 * `solo_agent_remote` is the group the gateway's chat path uses (its models are
 * served by the remote agent endpoint, which is the one that reports real usage
 * and accepts a 1M window). The other groups are the same models with different
 * wire functions and smaller defaults, so they are readable on demand rather
 * than merged — merging would list one model several times.
 */
const DEFAULT_GROUP = 'solo_agent_remote'

function parseArgs(argv) {
  const options = { app: 'Trae CN', group: DEFAULT_GROUP, stdout: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--app') options.app = argv[++i]
    else if (arg === '--group') options.group = argv[++i]
    else if (arg === '--stdout') options.stdout = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: catalog.mjs [--app <dir>] [--group <name>] [--stdout]')
      process.exit(0)
    }
  }
  return options
}

/** The picker cache lives in the client's per-workspace SQLite database. */
function databasePath(app) {
  return appSupport(app, 'User', 'globalStorage', 'state.vscdb')
}

/**
 * The largest context window a model advertises.
 *
 * `context_window_size` is `{default, max}` where `max` is an array of selectable
 * sizes. The gateway reports the largest, because that is what the model can be
 * given; the default is a UI preference, not a capability. A model that only
 * lists a default (no `max` array) uses the default.
 */
function contextWindowOf(entry) {
  const size = entry?.context_window_size
  if (typeof size === 'number') return size
  if (typeof size?.max === 'number') return size.max
  if (Array.isArray(size?.max) && size.max.length > 0) return Math.max(...size.max.filter((n) => typeof n === 'number'))
  if (typeof size?.default === 'number') return size.default
  return undefined
}

/**
 * Read the catalog.
 *
 * Ordering is preserved from the client so the generated file diffs cleanly when
 * a model is added: a sorted file would move every entry whenever the vendor
 * reordered its own list.
 */
function readCatalog(app, group) {
  const file = databasePath(app)
  if (!existsSync(file)) {
    throw new Error(`Trae database not found: ${file}\nStart the ${app} app once so it can cache its model list.`)
  }
  // Read-only: opening the live database for writing while the app is running is
  // how a working install gets corrupted.
  const db = new DatabaseSync(file, { readOnly: true })
  let raw
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CACHE_KEY)
    if (row === undefined) throw new Error(`model cache key ${CACHE_KEY} is absent from ${file}`)
    raw = JSON.parse(String(row.value))
  } finally {
    db.close()
  }
  const list = raw?.[group]
  if (!Array.isArray(list) || list.length === 0) {
    const groups = Object.entries(raw ?? {})
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .map(([name, value]) => `${name} (${String(value.length)})`)
    throw new Error(`group "${group}" is empty; available groups: ${groups.join(', ')}`)
  }
  return list
}

/**
 * One client entry -> one catalog entry.
 *
 * `wireFunction` IS THE GROUP NAME, NOT `config_name`. The two look alike and are
 * not the same: `config_name` is the model's own routing name (what the entry
 * calls itself), while the endpoint that must be named in `function` is the
 * picker group the entry was cached under. Measured on a real install, a group
 * entry's `config_name` equals its `name` for some models and differs for others,
 * so using `config_name` routes some models to an endpoint that does not serve
 * them. The group is the field the client itself groups by, and it is what the
 * chat request has to carry.
 */
function toCatalogEntry(entry, group) {
  const id = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.config_name
  if (typeof id !== 'string' || id === '') return undefined
  const efforts = entry.reasoning_effort_config?.options
  return {
    id,
    name: typeof entry.display_name === 'string' && entry.display_name !== '' ? entry.display_name : id,
    contextWindow: contextWindowOf(entry) ?? 200_000,
    maxTokens: typeof entry.max_tokens === 'number' ? entry.max_tokens : 32_000,
    wireFunction: group,
    multimodal: entry.multimodal === true,
    ...(Array.isArray(efforts) && efforts.length > 0 ? { efforts } : {}),
  }
}

const options = parseArgs(process.argv.slice(2))
const catalog = readCatalog(options.app, options.group)
  .map((entry) => toCatalogEntry(entry, options.group))
  .filter((entry) => entry !== undefined)

if (catalog.length === 0) {
  console.error('no usable entries; nothing written')
  process.exit(1)
}

const text = `${JSON.stringify(catalog, null, 2)}\n`
if (options.stdout) {
  process.stdout.write(text)
} else {
  await mkdir(dirname(TRAE_CATALOG), { recursive: true })
  await writeFile(TRAE_CATALOG, text, 'utf8')
  console.log(`wrote ${String(catalog.length)} models to ${TRAE_CATALOG}`)
  console.log(`group: ${options.group}  app: ${options.app}`)
}
