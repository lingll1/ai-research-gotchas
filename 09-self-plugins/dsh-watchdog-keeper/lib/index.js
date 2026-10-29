/**
 * dsh-watchdog-keeper — host half.
 *
 * Closes the supervision loop. `watchdog.ps1` already restarts the dsh server
 * when it dies; nothing watched the watchdog. That asymmetry is what cost six
 * days of downtime on 2026-09-30: the watchdog was gone, the server was gone,
 * and the logon task only fires at logon, so on a machine that stays up for
 * days nothing ever noticed.
 *
 * This plugin is the other half: it lives inside the dsh server, so it can only
 * ever run while dsh is up — which is exactly the desired ordering (dsh first,
 * watchdog second). Every `checkSeconds` it looks at the watchdog's heartbeat
 * file and, if that heartbeat has gone stale, hands off to
 * `D:\dsh\ensure-watchdog.ps1`, which starts a detached watchdog via WMI.
 *
 * Why the heartbeat and not a process scan: mtime is a single cheap stat, it
 * needs no WMI (whose stalls have frozen this stack before), and it also
 * distinguishes "watchdog process exists but is wedged" from "watchdog is
 * fine" — a wedged watchdog still holds the single-instance mutex, so a
 * replacement started here simply exits, which is the correct no-op.
 *
 * Keepalive is opt-in (`keepalive: false` by default). The default behavior is
 * monitor-only: probe the heartbeat, log transitions, expose
 * `/watchdog-keeper/status`, and never start anything. The revive path stays
 * available behind `keepalive: true` for profiles that still want it.
 *
 * Logging goes through `console.error`, never `ctx.logger`: cordis's logger
 * only feeds an in-memory ring that boot's exporter drops, so anything sent
 * there never reaches a file on disk. stderr is redirected into
 * server.err.log and is the only sink that actually persists.
 */

import { statSync } from 'node:fs'
import { execFile } from 'node:child_process'

export const name = 'dsh-watchdog-keeper'

/** the status route lives on the web server; the probe itself needs no service */
export const inject = ['webServer']

const DEFAULTS = {
  /** absolute path to the heartbeat file your watchdog writes; empty = not configured */
  heartbeatPath: '',
  /** heartbeat older than this (seconds) means the watchdog is gone or wedged */
  staleSeconds: 60,
  /** how often to look, in seconds */
  checkSeconds: 120,
  /** the start script to hand off to; it re-checks everything itself; empty = keepalive unavailable */
  script: '',
  /** delay before the first look, so a cold boot can settle, in seconds */
  firstDelaySeconds: 15,
  /** opt-in: run the start script when the heartbeat is stale */
  keepalive: false,
}

function log(...parts) {
  console.error('[watchdog-keeper]', ...parts)
}

/**
 * Pure staleness probe — kept separate so it is testable without a server.
 * Returns `{ alive, ageSeconds }`; a missing file counts as not alive.
 */
export function probeHeartbeat(path, staleSeconds, now = Date.now()) {
  try {
    const st = statSync(path)
    const ageSeconds = (now - st.mtimeMs) / 1000
    return { alive: ageSeconds < staleSeconds, ageSeconds }
  } catch {
    return { alive: false, ageSeconds: Infinity }
  }
}

/** The one side effect: ask ensure-watchdog.ps1 to attach a watchdog. */
export function revive(script, onDone) {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, timeout: 120000 },
    (error, stdout, stderr) => {
      const detail = String(stdout || '').trim() || String(stderr || '').trim()
      onDone(error, detail)
    },
  )
}

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config }
  // Keepalive needs a start script to hand off to; without one, monitoring is all
  // we can honestly do. Silently degrading to monitor-only beats spawning `-File ""`.
  if (opts.keepalive === true && !opts.script) {
    log('keepalive requested but no start script configured; degrading to monitor-only')
  }
  const keepalive = opts.keepalive === true && Boolean(opts.script)
  const checkMs = Math.max(10, Number(opts.checkSeconds) || DEFAULTS.checkSeconds) * 1000
  const stale = Math.max(10, Number(opts.staleSeconds) || DEFAULTS.staleSeconds)
  const firstMs = Math.max(1, Number(opts.firstDelaySeconds) || DEFAULTS.firstDelaySeconds) * 1000

  // Without a heartbeat path there is nothing to probe. Stay loaded but idle, and
  // say so once — a keeper that silently reports "dead" for a path it never had is
  // worse than one that admits it is unconfigured.
  if (!opts.heartbeatPath) {
    log('no heartbeatPath configured; keeper is idle')
    return
  }

  // Only report on transitions. A line every two minutes saying "still fine"
  // would bury the one line that matters.
  let lastAlive = null

  const check = () => {
    let state
    try {
      state = probeHeartbeat(opts.heartbeatPath, stale)
    } catch (error) {
      log(`heartbeat probe threw: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (state.alive) {
      if (lastAlive === false) log('watchdog heartbeat is fresh again; standing down')
      lastAlive = true
      return
    }
    const action = keepalive
      ? (lastAlive === null ? 'attaching one' : 're-attaching')
      : 'monitoring only (keepalive disabled)'
    if (lastAlive === null) {
      log(`no live watchdog at startup (heartbeat age ${Math.round(state.ageSeconds)}s); ${action}`)
    } else {
      log(`watchdog heartbeat went stale (age ${Math.round(state.ageSeconds)}s); ${action}`)
    }
    lastAlive = false
    if (!keepalive) return
    try {
      revive(opts.script, (error, detail) => {
        if (error) log(`ensure-watchdog failed: ${error.message}${detail ? ` :: ${detail}` : ''}`)
        else if (detail) log(`ensure-watchdog: ${detail}`)
      })
    } catch (error) {
      log(`ensure-watchdog spawn threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const first = setTimeout(check, firstMs)
  const timer = setInterval(check, checkMs)
  // Do not hold the event loop open on our account; cordis owns the lifetime
  // and the disposer below stops us cleanly on unload.
  if (typeof first.unref === 'function') first.unref()
  if (typeof timer.unref === 'function') timer.unref()

  ctx.effect(() => () => {
    clearTimeout(first)
    clearInterval(timer)
  }, `${name}.interval`)

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/watchdog-keeper/status',
      handler: async (_req, res) => {
        const state = probeHeartbeat(opts.heartbeatPath, stale)
        const body = {
          name,
          keepalive,
          heartbeatPath: opts.heartbeatPath,
          staleSeconds: stale,
          checkSeconds: checkMs / 1000,
          alive: state.alive,
          ageSeconds: Number.isFinite(state.ageSeconds)
            ? Math.round(state.ageSeconds * 10) / 10
            : null,
          checkedAt: new Date().toISOString(),
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      },
    }),
  )

  log(`armed: probing ${opts.heartbeatPath} every ${checkMs / 1000}s (stale > ${stale}s), keepalive=${keepalive ? 'on' : 'off'} -> ${opts.script}`)
}
