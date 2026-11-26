import assert from 'node:assert/strict'
import { tick } from './worker.js'
const env = { GITHUB_TOKEN: 't' }
function mock(runsByRepo) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url.replace('https://api.github.com/repos/pincastFM/', '')])
    if (opts.method === 'POST') return { status: 204, text: async () => '' }
    const repo = url.includes('/status/') ? 'status' : 'docs'
    return { ok: true, json: async () => ({ workflow_runs: runsByRepo[repo] }) }
  }
  return calls
}
const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
console.log = () => {}
// 1. old run: dispatch status only
let c = mock({ status: [{ id: 1, status: 'completed', event: 'schedule', created_at: ago(600) }] })
await tick(env, new Date('2026-11-25T18:03:00Z'))
assert.deepEqual(c.map(x => x[0]), ['GET', 'POST']); assert.match(c[1][1], /status\/actions\/workflows\/checks.yml\/dispatches/)
// 2. run 2 min ago: skip
c = mock({ status: [{ id: 2, status: 'completed', event: 'push', created_at: ago(120) }] })
await tick(env, new Date('2026-11-25T18:08:00Z')); assert.deepEqual(c.map(x => x[0]), ['GET'])
// 3. running: skip
c = mock({ status: [{ id: 3, status: 'in_progress', event: 'workflow_dispatch', created_at: ago(900) }] })
await tick(env, new Date('2026-11-25T18:13:00Z')); assert.deepEqual(c.map(x => x[0]), ['GET'])
// 4. 10:23 UTC: status + docs
c = mock({ status: [], docs: [{ id: 9, status: 'completed', event: 'deployment_status', created_at: ago(3600) }] })
await tick(env, new Date('2026-11-25T10:23:00Z'))
assert.deepEqual(c.map(x => x[0]), ['GET', 'POST', 'GET', 'POST']); assert.match(c[3][1], /pincast-docs-public\/actions\/workflows\/docs-checks.yml\/dispatches/)
// 5. 10:23 UTC, GitHub's timer ran docs an hour ago: no docs dispatch
c = mock({ status: [], docs: [{ id: 10, status: 'completed', event: 'schedule', created_at: ago(3600) }] })
await tick(env, new Date('2026-11-25T10:23:00Z')); assert.deepEqual(c.map(x => x[0]), ['GET', 'POST', 'GET'])
// 6. dispatch refused: throws
globalThis.fetch = async (u, o = {}) => o.method === 'POST' ? { status: 403, text: async () => 'no' } : { ok: true, json: async () => ({ workflow_runs: [] }) }
await assert.rejects(tick(env, new Date('2026-11-25T18:18:00Z')), /HTTP 403/)
process.stdout.write('6 of 6 pass\n')
