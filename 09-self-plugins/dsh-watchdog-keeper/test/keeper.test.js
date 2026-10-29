/**
 * Smoke tests for the pure parts of dsh-watchdog-keeper.
 *
 * These exist mostly because the plugin's real failure mode is silent: a bad
 * import or a wrong heartbeat path leaves a plugin that loads fine and never
 * revives anything. `node --test` at least proves the module loads under ESM
 * and that the staleness boundary does what the watchdog's writer assumes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeHeartbeat, revive, apply, inject, name } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'keeper-test-'))
const beat = join(dir, 'watchdog.heartbeat')
writeFileSync(beat, new Date().toISOString())

test('exports the cordis plugin surface', () => {
  assert.equal(name, 'dsh-watchdog-keeper')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof revive, 'function')
})

test('a fresh heartbeat reads as alive', () => {
  const { alive, ageSeconds } = probeHeartbeat(beat, 60)
  assert.equal(alive, true)
  assert.ok(ageSeconds < 5, `expected a fresh age, got ${ageSeconds}`)
})

test('a heartbeat older than the threshold reads as dead', () => {
  const old = new Date(Date.now() - 300 * 1000)
  utimesSync(beat, old, old)
  const { alive, ageSeconds } = probeHeartbeat(beat, 60)
  assert.equal(alive, false)
  assert.ok(ageSeconds > 200, `expected an old age, got ${ageSeconds}`)
})

test('a missing heartbeat reads as dead rather than throwing', () => {
  const { alive, ageSeconds } = probeHeartbeat(join(dir, 'nope.heartbeat'), 60)
  assert.equal(alive, false)
  assert.equal(ageSeconds, Infinity)
})

test('apply registers the monitor-only status route', async () => {
  const fresh = join(dir, 'fresh.heartbeat')
  writeFileSync(fresh, new Date().toISOString())
  const registered = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
    webServer: {
      register(options) {
        registered.push(options)
        return () => {}
      },
    },
  }

  apply(ctx, {
    heartbeatPath: fresh,
    keepalive: false,
    firstDelaySeconds: 1,
    checkSeconds: 60,
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, '/watchdog-keeper/status')

  let body
  const res = { writeHead() {}, end(value) { body = value } }
  await registered[0].handler({}, res)
  const status = JSON.parse(body)
  assert.equal(status.keepalive, false)
  assert.equal(status.alive, true)
  assert.equal(status.heartbeatPath, fresh)

  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
