// H685 A (Andrew, 2026-11-25): a timed Cloudflare Worker starts the status checks every 5 minutes and the
// docs checks once a day. The checks themselves run on GitHub (H663 A); only the start lives here.
// Secret: GITHUB_TOKEN, a fine-grained token with Actions read and write on pincastFM/status and
// pincastFM/pincast-docs-public only.
const API = 'https://api.github.com/repos/pincastFM'

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pincast-status-starter',
    'Content-Type': 'application/json',
  }
}

async function dispatch(env, repo, workflow) {
  const r = await fetch(`${API}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST', headers: headers(env), body: JSON.stringify({ ref: 'main' }),
  })
  if (r.status !== 204) throw new Error(`${repo} ${workflow}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  console.log(`dispatched ${repo} ${workflow}`)
}

// Skip when a run started in the last 4 minutes or is still going, so GitHub's own timer, a push or the
// box's bridge never stack runs behind this one.
async function recentRun(env, repo, workflow, seconds) {
  const r = await fetch(`${API}/${repo}/actions/workflows/${workflow}/runs?per_page=1`, { headers: headers(env) })
  if (!r.ok) throw new Error(`${repo} ${workflow} runs: HTTP ${r.status}`)
  const run = (await r.json()).workflow_runs?.[0]
  if (!run) return null
  const busy = ['queued', 'in_progress', 'waiting', 'pending'].includes(run.status)
  const age = (Date.now() - Date.parse(run.created_at)) / 1000
  return busy || age < seconds ? run : null
}

export async function tick(env, when) {
  const run = await recentRun(env, 'status', 'checks.yml', 240)
  if (run) console.log(`skip status: run ${run.id} (${run.event}, ${run.status}) at ${run.created_at}`)
  else await dispatch(env, 'status', 'checks.yml')
  // Once a day, at the docs checks' own 10:23 UTC slot.
  if (when.getUTCHours() === 10 && when.getUTCMinutes() === 23) {
    const docs = await recentRun(env, 'pincast-docs-public', 'docs-checks.yml', 6 * 3600)
    if (docs && docs.event === 'schedule') console.log(`skip docs: GitHub's timer ran it at ${docs.created_at}`)
    else await dispatch(env, 'pincast-docs-public', 'docs-checks.yml')
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, new Date(event.scheduledTime)))
  },
}
