// Reads data/status.json and draws the page. No build step, no dependencies.
const STRIP_RUNS = 48
const LABEL = { up: 'Up', down: 'Down' }
const $ = (id) => document.getElementById(id)
let data = null

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return min === 1 ? '1 minute ago' : `${min} minutes ago`
  const h = Math.round(min / 60)
  if (h < 48) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  return `${d} days ago`
}

function clock(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// What a row shows: its color, its label and its second line.
function view(c) {
  if (c.status === 'up') return { tone: 'up', label: LABEL.up, note: c.ms != null ? `Answering in ${c.ms} ms` : 'Answering' }
  if (c.status === 'down' && c.live) return { tone: 'down', label: LABEL.down, note: c.detail }
  if (c.status === 'down') return { tone: 'wait', label: 'Not live yet', note: 'Shows here once it launches' }
  if (c.status === 'not_set') return { tone: 'wait', label: 'Not set up', note: 'Waiting for its test key' }
  return { tone: 'wait', label: 'Not started', note: 'Starts when this service goes live' }
}

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function uptime(id, history) {
  const runs = history.map((h) => h.s[id]).filter((s) => s === 'u' || s === 'd')
  if (!runs.length) return null
  const up = runs.filter((s) => s === 'u').length
  const pct = (100 * up) / runs.length
  return pct === 100 ? '100%' : `${pct.toFixed(1)}%`
}

function render() {
  const list = $('services')
  list.replaceChildren()
  if (!data || !data.generatedAt || !data.checks.length) {
    $('summary').className = 'summary'
    $('summary').textContent = 'No checks have run yet.'
    $('meta').textContent = ''
    $('stale').hidden = true
    return
  }
  const history = data.history || []
  const live = data.checks.filter((c) => c.live && (c.status === 'up' || c.status === 'down'))
  const down = live.filter((c) => c.status === 'down')
  const summary = $('summary')
  if (down.length) {
    summary.className = 'summary down'
    summary.textContent = down.length === 1 ? `${down[0].name} is down.` : `${down.length} of ${live.length} services are down.`
  } else {
    summary.className = 'summary up'
    summary.textContent = 'Every live service is answering.'
  }

  const ageMin = (Date.now() - new Date(data.generatedAt).getTime()) / 60000
  const stale = $('stale')
  stale.hidden = ageMin <= (data.staleAfterMinutes || 20)
  if (!stale.hidden) {
    stale.replaceChildren(
      el('strong', null, 'Status may be stale.'),
      document.createTextNode(`The newest check ran ${ago(data.generatedAt)}. Checks run every ${data.intervalMinutes || 5} minutes, so they may have stopped, and what you see below may be out of date.`),
    )
  }
  $('meta').textContent = `Last checked ${ago(data.generatedAt)} (${clock(data.generatedAt)}).`

  for (const c of data.checks) {
    const v = view(c)
    const li = el('li')
    li.append(el('span', `dot ${v.tone}`), el('span', 'name', c.name), el('span', `state ${v.tone}`, v.label))
    const line2 = el('span', 'line2')
    line2.append(el('span', null, v.note))
    if (c.checkedAt) line2.append(el('span', null, `Checked ${ago(c.checkedAt)}${c.every === 'day' ? ', once a day' : ''}`))
    const pct = c.live ? uptime(c.id, history) : null
    if (pct) line2.append(el('span', null, `Up ${pct} of the last 24 hours`))
    li.append(line2)
    if (c.every !== 'day' && c.status !== 'disabled') {
      const strip = el('span', `strip${v.tone === 'wait' ? ' wait' : ''}`)
      strip.setAttribute('aria-hidden', 'true')
      const runs = history.slice(-STRIP_RUNS)
      for (let i = runs.length; i < STRIP_RUNS; i++) strip.append(el('span'))
      for (const h of runs) {
        const s = el('span', h.s[c.id] || '')
        s.title = `${clock(h.at)}: ${h.s[c.id] === 'u' ? 'up' : h.s[c.id] === 'd' ? 'down' : 'not checked'}`
        strip.append(s)
      }
      li.append(strip)
    }
    list.append(li)
  }
}

async function load() {
  try {
    const res = await fetch(`data/status.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(String(res.status))
    data = await res.json()
    render()
  } catch {
    $('summary').className = 'summary down'
    $('summary').textContent = "The latest results couldn't be read. Try again in a minute."
  }
}

// The results change every 5 minutes, so the page fetches them every 5 minutes and only
// redraws the "minutes ago" times in between.
load()
setInterval(load, 5 * 60000)
setInterval(() => data && render(), 60000)
