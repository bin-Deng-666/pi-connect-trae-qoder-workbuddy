/**
 * Every host-specific path and constant lives here, and nowhere else.
 *
 * WHY ONE FILE. Three adapters read from three different places on disk — the
 * Trae app's device identity, the Qoder plugin's account vault, the WorkBuddy
 * plugin's token vault. Each of those paths used to be assembled inside the
 * adapter that needed it, which meant a user on a different layout had to edit
 * three files to move one directory. They are collected here so that
 * `PI_CONNECT_*` environment variables can override all of it, and so the
 * README has one table to document instead of three.
 *
 * NOTHING SECRET IS STORED HERE. Every value is either a path, a public
 * identifier, or a version string. Tokens are read at request time and never
 * cached to disk by this project.
 */
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** Read an environment override, treating an empty string as "not set". */
const env = (name, fallback) => {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

export const HOME = homedir()

/**
 * Where Pi keeps its agent state (`models.json`, extension settings).
 *
 * Defaults to Pi's own location so the gateway works without configuration on
 * a machine where Pi is already installed.
 */
export const PI_HOME = env('PI_CONNECT_PI_HOME', join(HOME, '.pi', 'agent'))

/**
 * Where the DSH desktop app keeps its plugin state.
 *
 * The adapters read credentials out of the provider plugins' own vaults rather
 * than asking the user to paste tokens a second time: the plugins already keep
 * them refreshed, and duplicating that job is how credentials go stale.
 */
export const DSH_HOME = env('DSH_HOME', join(HOME, '.dsh'))

/** Loopback only: this process holds live credentials and must not be reachable. */
export const GATEWAY_HOST = env('PI_CONNECT_HOST', '127.0.0.1')
export const GATEWAY_PORT = Number(env('PI_CONNECT_PORT', '8798'))

/**
 * The Trae model catalog: a small JSON array written once per machine.
 *
 * It exists because Trae's chat request must name the model twice — once as
 * the model id, once as the `function` (wire endpoint) that serves it — and
 * `function` is not derivable from the id. `bin/catalog.mjs` builds this file
 * from the Trae app; see `docs/providers.md`.
 */
export const TRAE_CATALOG = env('PI_CONNECT_TRAE_CATALOG', join(PI_HOME, 'trae-models.json'))

/**
 * macOS application-support root.
 *
 * Only the macOS layout is implemented: all three clients are Electron apps
 * whose identity files sit under this directory. The helper returns the
 * platform-correct root so a future Linux port has one place to change, and
 * the adapters degrade to "no device headers" when the file is absent rather
 * than throwing.
 */
export function appSupport(...parts) {
  const root =
    platform() === 'darwin'
      ? join(HOME, 'Library', 'Application Support')
      : env('XDG_CONFIG_HOME', join(HOME, '.config'))
  return join(root, ...parts)
}

/**
 * Client identities as they identify themselves upstream.
 *
 * These are user-agent strings, not secrets: upstream validates the *shape*
 * ("this request came from the official client at version N"), so impersonating
 * a stale version is what gets a request rejected, not what gets it accepted.
 * They are pinned here because they appear in more than one request path.
 */
export const CLIENTS = {
  trae: {
    /** Public application id, sent as `x-app-id` on every chat request. */
    appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    /** Install directory names, used to find the device fingerprint. */
    appDirs: { cn: 'Trae CN', solo: 'TRAE SOLO CN' },
    /** Fallback client version when the installed app cannot be read. */
    version: '0.2.2',
  },
  qoder: {
    /** The Qoder desktop client reports these on the cosy channel. */
    cosyVersion: '0.1.43',
    cosyVersionHeader: '1.1.69',
    clientType: '10',
  },
  workbuddy: {
    /** WorkBuddy authenticates the CLI channel separately from the GUI one. */
    headers: {
      'User-Agent': 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/5.8.3',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Type': 'CLI',
    },
  },
}

/** Files the providers read credentials from, relative to `DSH_HOME`. */
export const CREDENTIAL_FILES = {
  trae: env('PI_CONNECT_TRAE_CREDENTIALS', join(DSH_HOME, '.trae-auth.cn.json')),
  qoder: {
    cn: env('PI_CONNECT_QODER_CREDENTIALS', join(DSH_HOME, '.qoder-accounts.cn.json')),
    global: join(DSH_HOME, '.qoder-accounts.global.json'),
  },
}
