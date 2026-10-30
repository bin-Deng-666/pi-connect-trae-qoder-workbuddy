/**
 * Footer credits: show the current provider's remaining balance next to the
 * context occupancy.
 *
 * WHY THIS REBUILDS THE WHOLE FOOTER INSTEAD OF ADDING A FIELD. Pi has exactly
 * one custom footer slot (`ctx.ui.setFooter`), and the last extension to claim it
 * wins. `agent-personal-memory` also claims it, and it right-aligns its own
 * status on the path line. A second, separately-arranged footer would push that
 * status onto a third line — which is exactly the "my footer moved" bug this
 * layout exists to avoid. So this renders the same three rows memory does: path
 * (with memory's status right-aligned), stats, then any other extension statuses.
 *
 * WHY EACH SEGMENT IS COLOURED ON ITS OWN. The context segment turns
 * `warning`/`error` above 70/90 percent, and those emit a foreground reset. A
 * single outer `dim` wrapper would be cancelled at that reset and every later
 * segment would fall back to the terminal's default colour — black on a light
 * theme. Each segment therefore carries its own attribute.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent'
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/** Where the gateway listens. Matches the `--port` used to start it. */
const GATEWAY = process.env.PI_CONNECT_GATEWAY ?? 'http://127.0.0.1:8798'

/** How long a reading stays fresh. Balances settle per cycle, not per keystroke. */
const TTL_MS = 60_000

/** Providers that bill in credits. Anything else shows nothing. */
const CREDIT_PROVIDERS = new Set(['trae', 'qoder', 'workbuddy'])

/** The key `agent-personal-memory` publishes its status under. */
const MEMORY_STATUS_KEY = 'personal-memory'

interface CreditState {
  text?: string
  at: number
  pending: boolean
}

const cache = new Map<string, CreditState>()

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

/**
 * Compact form for a balance: big numbers fold to k/M, one decimal at most.
 *
 * The footer re-renders on every keystroke, so a value that changes width
 * between refreshes makes the whole line jump. One decimal is enough to see a
 * balance move without giving it room to jitter.
 */
function formatCredits(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  if (value >= 100) return String(Math.round(value))
  return value.toFixed(1)
}

/** Path shown relative to home, matching memory's footer and Pi's built-in one. */
function cwdLabel(cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home === undefined || home === '') return cwd
  const child = relative(resolve(home), resolve(cwd))
  if (child === '') return '~'
  if (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return `~${sep}${child}`
  return cwd
}

/** Two ends of one line. The right side is protected first, the left truncates. */
function align(left: string, right: string, width: number): string {
  const rightText = truncateToWidth(right, Math.max(0, width - 3), '…')
  const leftText = truncateToWidth(left, Math.max(0, width - visibleWidth(rightText) - (rightText !== '' ? 2 : 0)), '…')
  return leftText + ' '.repeat(Math.max(0, width - visibleWidth(leftText) - visibleWidth(rightText))) + rightText
}

/**
 * Fetch one provider's balance, at most once per TTL.
 *
 * `onUpdate` is what makes the FIRST reading visible: the request is fired from
 * inside `render()`, so without a repaint request the result would sit in the
 * cache until some unrelated event caused the next render.
 */
function refresh(provider: string, onUpdate: () => void): void {
  const current = cache.get(provider)
  const now = Date.now()
  if (current !== undefined && (current.pending || now - current.at < TTL_MS)) return
  cache.set(provider, {
    at: current?.at ?? 0,
    pending: true,
    ...(current?.text === undefined ? {} : { text: current.text }),
  })
  fetch(`${GATEWAY}/credits/${provider}`, { signal: AbortSignal.timeout(15_000) })
    .then(async (response) => {
      const payload = (await response.json()) as { remaining?: number; error?: unknown }
      const remaining = Number(payload?.remaining)
      if (payload?.error !== undefined || !Number.isFinite(remaining)) {
        cache.set(provider, { at: Date.now(), pending: false })
        return
      }
      cache.set(provider, { at: Date.now(), pending: false, text: formatCredits(remaining) })
    })
    .catch(() => {
      // A gateway that is not running is a normal state, not an error worth
      // painting into the footer: one missing segment is more useful than a
      // permanent error message.
      cache.set(provider, { at: Date.now(), pending: false })
    })
    .finally(onUpdate)
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir()
  let enabled = true
  /** Whether this extension's footer is currently the installed one. */
  let alive = false
  /** Repaint handle from the last install, used to redraw after a model switch. */
  let latestRender: (() => void) | undefined

  const install = (ctx: ExtensionContext): void => {
    const settings = SettingsManager.create(ctx.cwd, agentDir)
    ctx.ui.setFooter((tui, theme: Theme, data: ReadonlyFooterDataProvider) => {
      alive = true
      latestRender = () => tui.requestRender()
      const unsubscribe = data.onBranchChange(() => tui.requestRender())

      return {
        dispose() {
          alive = false
          latestRender = undefined
          unsubscribe()
        },
        invalidate() {},
        render(width: number): string[] {
          const manager = ctx.sessionManager
          const model = ctx.model
          const provider = model?.provider ?? ''
          if (CREDIT_PROVIDERS.has(provider)) refresh(provider, () => tui.requestRender())

          let input = 0
          let output = 0
          let cacheRead = 0
          let cacheWrite = 0
          let cost = 0
          let cacheHit: number | undefined
          for (const entry of manager.getEntries()) {
            if (entry.type === 'message' && entry.message.role === 'assistant') {
              const message = entry.message as AssistantMessage
              input += message.usage.input
              output += message.usage.output
              cacheRead += message.usage.cacheRead
              cacheWrite += message.usage.cacheWrite
              cost += message.usage.cost.total
              const prompt = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
              cacheHit = prompt > 0 ? (message.usage.cacheRead / prompt) * 100 : undefined
            }
          }

          const usage = ctx.getContextUsage()
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0
          const percentValue = usage?.percent ?? 0
          const percent =
            usage?.percent === null || usage?.percent === undefined ? '?' : `${percentValue.toFixed(1)}%`

          const parts: string[] = []
          const pushDim = (text: string): void => {
            parts.push(theme.fg('dim', text))
          }
          if (input > 0) pushDim(`↑${formatTokens(input)}`)
          if (output > 0) pushDim(`↓${formatTokens(output)}`)
          if (cacheRead > 0) pushDim(`R${formatTokens(cacheRead)}`)
          if (cacheWrite > 0) pushDim(`W${formatTokens(cacheWrite)}`)
          if ((cacheRead > 0 || cacheWrite > 0) && cacheHit !== undefined) pushDim(`CH${cacheHit.toFixed(1)}%`)
          if (cost > 0) pushDim(`$${cost.toFixed(3)}`)

          const contextText = `${percent}/${formatTokens(contextWindow)}${settings.getCompactionEnabled() ? ' (auto)' : ''}`
          parts.push(
            percentValue > 90
              ? theme.fg('error', contextText)
              : percentValue > 70
                ? theme.fg('warning', contextText)
                : theme.fg('dim', contextText),
          )

          const creditText = cache.get(provider)?.text
          if (creditText !== undefined) pushDim(`◆ ${creditText}`)

          const branch = data.getGitBranch()
          const sessionName = manager.getSessionName()
          const path =
            cwdLabel(manager.getCwd()) +
            (branch !== null ? ` (${branch})` : '') +
            // getSessionName() can return undefined; testing only null or '' would
            // render " • undefined" on a session that has no name.
            (typeof sessionName === 'string' && sessionName !== '' ? ` • ${sessionName}` : '')
          const memoryStatus = data.getExtensionStatuses().get(MEMORY_STATUS_KEY) ?? ''

          const left = truncateToWidth(parts.join(' '), width)
          let right = model?.id ?? 'no-model'
          if (model?.reasoning === true) {
            const level = ctx.thinkingLevel ?? 'off'
            right = level === 'off' ? `${right} • thinking off` : `${right} • ${level}`
          }
          if (model !== undefined && data.getAvailableProviderCount() > 1) {
            const withProvider = `(${provider}) ${right}`
            if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider
          }
          const rightText = truncateToWidth(right, Math.max(0, width - visibleWidth(left) - 2), '')

          const lines: string[] = [
            align(theme.fg('dim', path), memoryStatus, width),
            left + ' '.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(rightText))) + theme.fg('dim', rightText),
          ]

          const others = [...data.getExtensionStatuses()]
            .filter(([key]) => key !== MEMORY_STATUS_KEY)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/[\r\n\t]/gu, ' ').replace(/ +/gu, ' ').trim())
            .filter((text) => text !== '')
          if (others.length > 0) lines.push(truncateToWidth(others.join(' '), width, theme.fg('dim', '...')))
          return lines
        },
      }
    })
  }

  pi.on('session_start', (_event, ctx) => {
    if (!enabled) return
    install(ctx)
    /*
     * `agent-personal-memory` also installs its footer on session_start, and its
     * handler awaits store initialisation first, so a single setTimeout(0) loses
     * that race (measured: the credits only appeared after the first message).
     * Backoff retries: whenever this footer turns out not to be the installed
     * one, put it back.
     */
    for (const delay of [0, 30, 120, 400, 1000]) {
      setTimeout(() => {
        if (!enabled) return
        if (!alive) install(ctx)
        latestRender?.()
      }, delay)
    }
  })

  // Pi resets extension footers when a session is rebuilt; reinstall if needed.
  pi.on('turn_start', (_event, ctx) => {
    if (enabled && !alive) install(ctx)
  })

  /**
   * A model switch has to repaint immediately, not on the next message.
   *
   * Two things must happen together: drop the new provider's cache (otherwise the
   * previous provider's balance is shown as if it belonged to this one), and
   * reinstall the footer, because `/model` calls `resetExtensionUI()` and clears
   * extension footers back to the built-in one. The reinstall is deferred to the
   * next tick to sit after the UI reset Pi performs in the same tick.
   */
  pi.on('model_select', (event, ctx) => {
    if (!enabled) return
    const provider = event.model?.provider ?? ''
    if (CREDIT_PROVIDERS.has(provider)) cache.delete(provider)
    const previous = event.previousModel?.provider ?? ''
    if (previous !== '' && previous !== provider) cache.delete(previous)
    install(ctx)
    setTimeout(() => {
      if (!alive) install(ctx)
      latestRender?.()
    }, 0)
  })

  // A turn can consume credits; re-read on the next render.
  pi.on('turn_end', (_event, ctx) => {
    const provider = ctx.model?.provider ?? ''
    if (CREDIT_PROVIDERS.has(provider)) cache.delete(provider)
  })

  pi.registerCommand('credits', {
    description: 'Show remaining credits for every provider',
    handler: async (_args, ctx) => {
      try {
        const response = await fetch(`${GATEWAY}/credits`, { signal: AbortSignal.timeout(20_000) })
        const payload = (await response.json()) as Record<
          string,
          { remaining?: number; unit?: string; account?: string; error?: string }
        >
        const lines = Object.entries(payload).map(([name, value]) => {
          if (value.error !== undefined) return `${name}: ${value.error}`
          const account = value.account === undefined || value.account === '' ? '' : ` (${value.account})`
          return `${name}: ${formatCredits(Number(value.remaining ?? 0))} ${value.unit ?? 'credits'} left${account}`
        })
        ctx.ui.notify(lines.join('\n'), 'info')
      } catch (error) {
        ctx.ui.notify(`credit lookup failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    },
  })

  pi.registerCommand('credits-off', {
    description: 'Hide footer credits',
    handler: async (_args, ctx) => {
      enabled = false
      ctx.ui.setFooter(undefined)
      ctx.ui.notify('footer credits hidden — /credits-on to restore', 'info')
    },
  })

  pi.registerCommand('credits-on', {
    description: 'Show footer credits again',
    handler: async (_args, ctx) => {
      enabled = true
      install(ctx)
      ctx.ui.notify('footer credits restored', 'info')
    },
  })
}
