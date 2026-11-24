// node --test test/
//
// Every check is pointed at dead addresses (a closed port, a name that can't exist, a server
// that answers 503, one that answers the wrong thing, one that never answers) and must turn
// red. Each is also pointed at a stub that answers the right way and must turn green, so a
// red result means the check works, not that it is always red. Nothing here leaves this machine.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { CHECKS } from '../check/checks.mjs'
import { probe, runAll, buildStatus, HISTORY_RUNS } from '../check/run.mjs'

const KEY = 'pck_test-abcdefghij_' + 'k'.repeat(32)
const ENV = { PINCAST_TEST_KEY: KEY, PINCAST_TEST_SET: 'status-check' }
const TIMEOUT = 800

const GOOD = {
  apps: [200, 'application/json', '{"apps":[{"id":"treehopper","name":"Treehopper"}]}'],
  'test-read': [200, 'application/json', '{"app":"test-abcdefghij","set":"status-check","name":"Status check","collects":0}'],
  id: [200, 'application/json', JSON.stringify({
    issuer: 'https://id.pincast.fm/oidc',
    authorization_endpoint: 'https://id.pincast.fm/oidc/auth',
    jwks_uri: 'https://id.pincast.fm/oidc/jwks',
  })],
  docs: [200, 'text/html; charset=utf-8', '<!doctype html><html><title>Pincast docs</title></html>'],
  'signin-clients': [401, 'application/json', '{"error":"signature_refused","message":"The request signature was refused."}'],
  dashboard: [302, 'text/plain', '', { Location: 'https://id.pincast.fm/oidc/auth?client_id=x' }],
  mcp: [200, 'text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"Pincast","version":"0.1.0"}}}\n\n'],
  registry: [200, 'application/json', '{"servers":[{"server":{"name":"fm.pincast/mcp"}}],"metadata":{"count":1}}'],
  'webhook-lag': [200, 'application/json', '{"lagSeconds":12}'],
}

let server
let port
let closedPort
const seen = []

before(async () => {
  server = http.createServer((req, res) => {
    const [, mode, id] = req.url.split('/')
    seen.push({ mode, id, headers: req.headers })
    if (mode === 'hang') return // never answers
    if (mode === 'error') { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('down') }
    if (mode === 'wrong') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('{"nope":true}') }
    const [status, type, body, extra] = GOOD[id]
    if (id === 'test-read' && req.headers['x-pincast-key'] !== KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end('{"error":"key_invalid"}')
    }
    res.writeHead(status, { 'Content-Type': type, ...(extra || {}) })
    res.end(body)
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  port = server.address().port
  // A port that was free a moment ago and has nothing listening now.
  const tmp = net.createServer()
  await new Promise((ok) => tmp.listen(0, '127.0.0.1', ok))
  closedPort = tmp.address().port
  await new Promise((ok) => tmp.close(ok))
})

after(() => {
  server.closeAllConnections()
  server.close()
})

const at = (check, url) => ({ ...check, url, enabled: true })
const local = (mode, check) => `http://127.0.0.1:${port}/${mode}/${check.id}${check.id === 'test-read' ? '/{set}' : ''}`

const DEAD = {
  'closed port': () => `http://127.0.0.1:${closedPort}/`,
  'name that cannot exist': () => 'https://status-check.invalid/',
  'server error': (check) => local('error', check),
  'wrong answer': (check) => local('wrong', check),
  'no answer': (check) => local('hang', check),
}

for (const check of CHECKS) {
  test(`${check.id}: green against a stub that answers right`, async () => {
    const r = await probe(at(check, local('good', check)), { env: ENV, timeoutMs: TIMEOUT })
    assert.equal(r.status, 'up', r.detail)
  })
  for (const [what, url] of Object.entries(DEAD)) {
    test(`${check.id}: red at a dead address (${what})`, async () => {
      const r = await probe(at(check, url(check)), { env: ENV, timeoutMs: TIMEOUT })
      assert.equal(r.status, 'down', `${what}: ${r.detail}`)
      assert.ok(r.detail && r.detail !== 'Answering')
      if (what === 'no answer') assert.match(r.detail, /No answer/)
    })
  }
}

test('the real addresses are the ones on the page plan', () => {
  const urls = Object.fromEntries(CHECKS.map((c) => [c.id, c.url]))
  assert.equal(urls.apps, 'https://api.pincast.fm/v1/apps')
  assert.equal(urls.id, 'https://id.pincast.fm/oidc/.well-known/openid-configuration')
  assert.equal(urls.mcp, 'https://mcp.pincast.fm/mcp')
  assert.equal(urls['webhook-lag'], null)
})

test('test-read: no key means "not set", and no request goes out', async () => {
  const check = CHECKS.find((c) => c.id === 'test-read')
  const count = seen.length
  const r = await probe(at(check, local('good', check)), { env: {}, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'not_set')
  assert.equal(r.detail, 'PINCAST_TEST_KEY is not set')
  assert.equal(seen.length, count)
})

test('test-read: a key that is not a test key is never sent', async () => {
  const check = CHECKS.find((c) => c.id === 'test-read')
  const count = seen.length
  const live = 'pck_treehopper_' + 'z'.repeat(32)
  const r = await probe(at(check, local('good', check)), { env: { PINCAST_TEST_KEY: live }, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'down')
  assert.equal(seen.length, count)
  assert.ok(!JSON.stringify(r).includes(live))
})

test('test-read: the key goes in the header and never in a result', async () => {
  const check = CHECKS.find((c) => c.id === 'test-read')
  const results = await Promise.all(
    [local('good', check), local('error', check), 'https://status-check.invalid/{set}'].map((u) =>
      probe(at(check, u), { env: ENV, timeoutMs: TIMEOUT })),
  )
  const last = seen.filter((s) => s.id === 'test-read' && s.mode === 'good').at(-1)
  assert.equal(last.headers['x-pincast-key'], KEY)
  const status = buildStatus(results, null, new Date().toISOString())
  assert.ok(!JSON.stringify(status).includes(KEY.slice(9)))
})

test('webhook-lag stays off and calls nothing', async () => {
  const check = CHECKS.find((c) => c.id === 'webhook-lag')
  const r = await probe(check, { env: ENV, timeoutMs: TIMEOUT })
  assert.equal(r.status, 'disabled')
})

test('mcp and registry are marked not live yet', () => {
  for (const id of ['mcp', 'registry', 'webhook-lag']) assert.equal(CHECKS.find((c) => c.id === id).live, false)
})

test('the registry check runs once a day', async () => {
  const check = { ...CHECKS.find((c) => c.id === 'registry'), url: `http://127.0.0.1:${port}/good/registry` }
  const t0 = new Date('2026-11-24T12:00:00Z')
  const first = await runAll([check], { env: ENV, timeoutMs: TIMEOUT, now: () => t0 })
  assert.equal(first[0].status, 'up')
  const count = seen.length
  const prev = { checks: [{ ...first[0], checkedAt: t0.toISOString() }] }
  const later = await runAll([check], { previous: prev, env: ENV, timeoutMs: TIMEOUT, now: () => new Date(t0.getTime() + 3600e3) })
  assert.equal(seen.length, count)
  assert.equal(later[0].checkedAt, t0.toISOString())
  const forced = await runAll([check], { previous: prev, forceDaily: true, env: ENV, timeoutMs: TIMEOUT })
  assert.equal(seen.length, count + 1)
  assert.notEqual(forced[0].checkedAt, t0.toISOString())
  await runAll([check], { previous: prev, env: ENV, timeoutMs: TIMEOUT, now: () => new Date(t0.getTime() + 24 * 3600e3) })
  assert.equal(seen.length, count + 2)
})

test('history keeps the last 24 hours of runs', () => {
  let status = null
  for (let i = 0; i < HISTORY_RUNS + 10; i++) {
    status = buildStatus([{ id: 'apps', status: i % 2 ? 'up' : 'down' }], status, new Date(i * 300e3).toISOString())
  }
  assert.equal(status.history.length, HISTORY_RUNS)
  assert.equal(status.history.at(-1).s.apps, 'u') // the last run, i = 297, was up
  assert.equal(status.history[0].at, new Date(10 * 300e3).toISOString())
  assert.equal(status.staleAfterMinutes, 20)
})
