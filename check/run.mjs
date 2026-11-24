// Runs every check once and writes the results file the page reads.
//
//   node check/run.mjs [--out site/data/status.json] [--force-daily] [--strict] [--timeout 10000]
//
// It exits 0 when services are down, so the workflow still commits the results. --strict
// exits 1 when a live service is down (for local use). Node 22, no dependencies.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CHECKS } from './checks.mjs'

export const DEFAULT_TIMEOUT_MS = 10_000
export const HISTORY_RUNS = 288 // 24 hours at one run every 5 minutes
export const DAILY_MS = 23 * 60 * 60 * 1000 // a little under a day, so a late run doesn't skip one
const BODY_LIMIT = 512 * 1024
const CODES = { up: 'u', down: 'd', not_set: 'n', disabled: 'x' }

// Plain words for a request that never got an answer. Never the raw error: it could hold
// an address or a header.
function failure(err, timeoutMs) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `No answer in ${Math.round(timeoutMs / 1000)} seconds`
  }
  const code = (err && err.cause && err.cause.code) || (err && err.code) || ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The address was not found'
  if (code === 'ECONNREFUSED') return 'The connection was refused'
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'The connection dropped'
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'The certificate was refused'
  return 'The request failed'
}

async function readCapped(res) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > BODY_LIMIT) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// One check, one request. Always resolves; never throws.
export async function probe(check, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const base = { id: check.id, name: check.name, live: check.live !== false, every: check.every || 'run' }
  if (check.enabled === false || !check.url) {
    return { ...base, status: 'disabled', detail: 'Starts when this service goes live', checkedAt: null }
  }
  const missing = (check.needs || []).filter((name) => !env[name])
  if (missing.length) {
    return { ...base, status: 'not_set', detail: `${missing.join(', ')} is not set`, checkedAt: now().toISOString() }
  }
  const built = check.request ? check.request(env, check.url) || {} : {}
  if (built.refuse) {
    return { ...base, status: 'down', detail: built.refuse, checkedAt: now().toISOString() }
  }
  const started = performance.now()
  let res
  let text
  try {
    res = await fetch(built.url || check.url, {
      method: built.method || 'GET',
      headers: { 'User-Agent': 'pincast-status/1.0', ...(built.headers || {}) },
      body: built.body,
      redirect: built.redirect || 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await readCapped(res)
  } catch (err) {
    return {
      ...base,
      status: 'down',
      detail: failure(err, timeoutMs),
      ms: Math.round(performance.now() - started),
      checkedAt: now().toISOString(),
    }
  }
  const ms = Math.round(performance.now() - started)
  let reason
  try {
    reason = check.accept(res, text, env)
  } catch {
    reason = "The answer couldn't be read"
  }
  return {
    ...base,
    status: reason ? 'down' : 'up',
    httpStatus: res.status,
    ms,
    detail: reason || 'Answering',
    checkedAt: now().toISOString(),
  }
}

// All checks in parallel. A daily check reuses its last result until a day has passed.
export async function runAll(checks, { previous = null, forceDaily = false, ...opts } = {}) {
  const now = opts.now ? opts.now() : new Date()
  const before = new Map(((previous && previous.checks) || []).map((c) => [c.id, c]))
  return Promise.all(
    checks.map(async (check) => {
      const last = before.get(check.id)
      const fresh = last && last.checkedAt && now - new Date(last.checkedAt) < DAILY_MS
      if (check.every === 'day' && !forceDaily && fresh && check.enabled !== false) {
        return { ...last, name: check.name, live: check.live !== false }
      }
      return probe(check, opts)
    }),
  )
}

export function buildStatus(results, previous, generatedAt) {
  const history = ((previous && previous.history) || []).slice()
  const s = {}
  for (const r of results) s[r.id] = CODES[r.status] || 'd'
  history.push({ at: generatedAt, s })
  return {
    version: 1,
    generatedAt,
    intervalMinutes: 5,
    staleAfterMinutes: 20,
    checks: results,
    history: history.slice(-HISTORY_RUNS),
  }
}

async function readPrevious(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    return data && data.version === 1 ? data : null
  } catch {
    return null
  }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: resolve(here, '../site/data/status.json') },
      'force-daily': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      timeout: { type: 'string', default: String(DEFAULT_TIMEOUT_MS) },
    },
  })
  const timeoutMs = Number(values.timeout)
  const previous = await readPrevious(values.out)
  const forceDaily = values['force-daily'] || process.env.FORCE_DAILY === 'true'
  const results = await runAll(CHECKS, { previous, forceDaily, timeoutMs })
  const status = buildStatus(results, previous, new Date().toISOString())
  await mkdir(dirname(values.out), { recursive: true })
  const tmp = `${values.out}.tmp`
  await writeFile(tmp, `${JSON.stringify(status, null, 1)}\n`)
  await rename(tmp, values.out)
  for (const r of results) {
    const label = r.status === 'down' && !r.live ? 'not live' : r.status
    console.log(`${label.padEnd(9)} ${r.id.padEnd(15)} ${String(r.httpStatus ?? '-').padEnd(4)} ${String(r.ms ?? '-').padStart(5)} ms  ${r.detail}`)
  }
  const down = results.filter((r) => r.status === 'down' && r.live)
  if (values.strict && down.length) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
