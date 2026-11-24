// The services the status page watches. Each entry is one check.
//
//   id        short name, used in the results file and the page
//   name      what the page calls it
//   url       the address the check calls (the dead-address test swaps it)
//   live      false while the service isn't live yet: a failure then reads "Not live yet"
//   every     'run' (each run, every 5 minutes) or 'day' (once a day)
//   needs     environment values the check needs; when one is missing the result is "not set"
//   enabled   false keeps the slot on the page without calling anything
//   request   builds the request from the environment (method, headers, body)
//   accept    reads the answer (and the environment); returns null when it is right, or a short plain reason
//
// No key, token or private address goes in this file. The test key comes from the
// PINCAST_TEST_KEY secret and only ever goes in a request header.

export const TEST_KEY_RE = /^pck_test-[a-z2-7]{10}_[A-Za-z0-9_-]{20,}$/
const SET_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function json(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

function isHtml(res, text) {
  return (res.headers.get('content-type') || '').includes('text/html') && /<html/i.test(text)
}

// A streamable HTTP MCP server may answer as JSON or as one server-sent event.
function mcpAnswer(text) {
  const direct = json(text)
  if (direct) return direct
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const event = json(line.slice(5).trim())
      if (event) return event
    }
  }
  return undefined
}

export const CHECKS = [
  {
    id: 'apps',
    name: 'Public list of apps',
    url: 'https://api.pincast.fm/v1/apps',
    live: true,
    every: 'run',
    accept(res, text) {
      if (res.status !== 200) return `Answered HTTP ${res.status}`
      const body = json(text)
      return body && Array.isArray(body.apps) ? null : "The answer wasn't a list of apps"
    },
  },
  {
    id: 'test-read',
    name: 'API read with a test key',
    url: 'https://api.pincast.fm/v1/sets/{set}',
    live: true,
    every: 'run',
    needs: ['PINCAST_TEST_KEY'],
    request(env, url) {
      const key = env.PINCAST_TEST_KEY
      if (!TEST_KEY_RE.test(key)) return { refuse: "The key in PINCAST_TEST_KEY isn't a test key" }
      const set = env.PINCAST_TEST_SET || 'status-check'
      if (!SET_RE.test(set)) return { refuse: "PINCAST_TEST_SET isn't a set name" }
      return { url: url.replace('{set}', set), headers: { 'X-Pincast-Key': key } }
    },
    accept(res, text, env = {}) {
      const set = env.PINCAST_TEST_SET || 'status-check'
      if (res.status === 401 || res.status === 403) return 'The test key was refused'
      if (res.status === 404) return 'The test set is missing'
      if (res.status !== 200) return `Answered HTTP ${res.status}`
      const body = json(text)
      return body && body.set === set && typeof body.app === 'string' ? null : "The answer wasn't the test set"
    },
  },
  {
    id: 'id',
    name: 'Sign-in server (id.pincast.fm)',
    url: 'https://id.pincast.fm/oidc/.well-known/openid-configuration',
    live: true,
    every: 'run',
    accept(res, text) {
      if (res.status !== 200) return `Answered HTTP ${res.status}`
      const body = json(text)
      if (!body || body.issuer !== 'https://id.pincast.fm/oidc') return "The answer didn't name id.pincast.fm"
      return body.authorization_endpoint && body.jwks_uri ? null : 'The sign-in details were incomplete'
    },
  },
  {
    id: 'docs',
    name: 'Docs (docs.pincast.fm)',
    url: 'https://docs.pincast.fm/',
    live: true,
    every: 'run',
    accept(res, text) {
      if (res.status !== 200) return `Answered HTTP ${res.status}`
      return isHtml(res, text) && /pincast/i.test(text) ? null : "The answer wasn't the docs"
    },
  },
  {
    id: 'signin-clients',
    name: 'Sign-in setup for apps',
    // The front door passes only client paths through, so the check asks for a made-up
    // test app's client. The service answers only signed requests: an unsigned call must
    // come back as the service's own refusal, which proves it is running without touching
    // any app. Anything else is a fault.
    url: 'https://signin-clients.pincast.fm/clients/test-statuspage',
    live: true,
    every: 'run',
    accept(res, text) {
      const body = json(text)
      if (res.status === 401 && body && body.error === 'signature_refused') return null
      return res.status === 401 ? "The answer didn't come from the service" : `Answered HTTP ${res.status}`
    },
  },
  {
    id: 'dashboard',
    name: 'Dashboard sign-in page',
    url: 'https://pincast.fm/sign-in',
    live: true,
    every: 'run',
    request() {
      return { redirect: 'manual' }
    },
    // Today the page sends people on to id.pincast.fm. A page of its own is also fine.
    accept(res, text) {
      if ([302, 303, 307].includes(res.status)) {
        let to
        try { to = new URL(res.headers.get('location') || '', 'https://pincast.fm') } catch { to = null }
        return to && to.origin === 'https://id.pincast.fm' && to.pathname === '/oidc/auth'
          ? null
          : "The page didn't send people to sign in"
      }
      if (res.status === 200) return isHtml(res, text) ? null : "The answer wasn't a page"
      return `Answered HTTP ${res.status}`
    },
  },
  {
    id: 'mcp',
    name: 'MCP server',
    url: 'https://mcp.pincast.fm/mcp',
    live: false,
    every: 'run',
    request() {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'pincast-status', version: '1.0.0' },
          },
        }),
      }
    },
    accept(res, text) {
      if (res.status !== 200) return `Answered HTTP ${res.status}`
      const answer = mcpAnswer(text)
      return answer && answer.result && answer.result.serverInfo ? null : "The answer wasn't an MCP server's"
    },
  },
  {
    id: 'registry',
    name: 'MCP Registry listing',
    url: 'https://registry.modelcontextprotocol.io/v0.1/servers?search=fm.pincast/mcp',
    live: false,
    every: 'day',
    accept(res, text) {
      if (res.status !== 200) return `Answered HTTP ${res.status}`
      const body = json(text)
      if (!body || !Array.isArray(body.servers)) return "The answer wasn't a registry search"
      const names = body.servers.map((s) => (s && s.server ? s.server.name : s && s.name))
      return names.includes('fm.pincast/mcp') ? null : 'Not listed'
    },
  },
  {
    // A slot for the webhook sender's lag. It stays off until webhooks go live (unit W2),
    // when this gets the address of the sender's small public health answer.
    id: 'webhook-lag',
    name: 'Webhook delivery',
    url: null,
    live: false,
    every: 'run',
    enabled: false,
    accept(res, text) {
      if (res.status !== 200) return `Answered HTTP ${res.status}`
      const body = json(text)
      if (!body || typeof body.lagSeconds !== 'number') return "The answer didn't give the lag"
      return body.lagSeconds <= 300 ? null : 'Webhooks are running late'
    },
  },
]
