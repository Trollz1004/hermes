import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// three.js is mocked through vitest.config.js aliases + this mock; the app never
// touches WebGL in tests.
vi.mock('three', () => ({
  Scene: class { constructor() { this.background = null; this.children = [] } add() {} remove() {} },
  PerspectiveCamera: class { constructor() { this.position = { set() {} }; this.aspect = 1 } updateProjectionMatrix() {} },
  WebGLRenderer: class { constructor() { this.domElement = {} } setSize() {} setPixelRatio() {} render() {} },
  Color: class { constructor(v) { this.value = v } },
  DirectionalLight: class { constructor() { this.position = { set() {}, normalize() {} } } },
  AmbientLight: class { constructor() {} },
  GridHelper: class { constructor() {} },
  Clock: class { getDelta() { return 0.016 } },
}))

// ── minimal DOM ──────────────────────────────────────────────────────────────
class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attrs = {}
    this.textContent = ''; this._html = ''; this.value = ''; this.id = ''
    this.classes = new Set()
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => { if (on === undefined) on = !this.classes.has(c); on ? this.classes.add(c) : this.classes.delete(c); return on },
      contains: (c) => this.classes.has(c),
    }
    this.listeners = {}
  }
  get innerHTML() { return this._html }
  set innerHTML(v) { this._html = v; this.children = [] }
  appendChild(c) { this.children.push(c); return c }
  insertBefore(c) { this.children.unshift(c); return c }
  setAttribute(k, v) { this.attrs[k] = v }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn) }
  click() { for (const fn of this.listeners.click || []) fn() }
  querySelectorAll() { return [] }
  get firstChild() { return this.children[0] || null }
}

const registry = new Map()
function reg(id, tag = 'div') { const e = new MockElement(tag); e.id = id; registry.set('#' + id, e); return e }

const tabs = ['dashboard', 'mission-control', 'agents', 'graph', 'avatar', 'widgets', 'scenes', 'image', 'claude'].map((name) => {
  const li = new MockElement('li'); li.dataset.tab = name; li.classes.add('nav-tab'); if (name === 'dashboard') li.classes.add('active')
  const sec = new MockElement('section'); sec.id = 'tab-' + name; sec.classes.add('tab-content'); if (name === 'dashboard') sec.classes.add('active')
  registry.set('#tab-' + name, sec)
  return { li, sec }
})

globalThis.document = {
  querySelector: (sel) => registry.get(sel) || null,
  querySelectorAll: (sel) => sel === '.nav-tab' ? tabs.map((t) => t.li) : sel === '.tab-content' ? tabs.map((t) => t.sec) : [],
  createElement: (tag) => new MockElement(tag),
  createElementNS: (_ns, tag) => new MockElement(tag),
  createTextNode: (t) => ({ text: t }),
  addEventListener: () => {},
}
globalThis.window = { addEventListener: () => {}, devicePixelRatio: 1 }
globalThis.location = { hostname: '192.168.0.8' }
globalThis.requestAnimationFrame = () => {}
globalThis.URL.createObjectURL = () => 'blob:x'

for (const id of ['activity-log', 'omni-model-count', 'stat-services', 'stat-services-detail', 'stat-agents', 'stat-agents-detail', 'stat-nodes', 'stat-nodes-detail', 'stat-vault', 'stat-vault-detail', 'stat-avatars', 'stat-avatars-detail', 'business-overview', 'business-status', 'business-users', 'business-leads', 'business-hot-leads', 'business-campaigns', 'business-open-rate', 'business-automations', 'business-social', 'business-conversions', 'business-detail', 'agent-categories', 'agent-list', 'agent-detail-panel', 'graph-meta', 'graph-note', 'mission-control-link', 'hermes-link', 'claude-command', 'claude-bridge-status', 'claude-note', 'claude-result', 'widget-search-results', 'avatar-gallery']) reg(id)
reg('agent-search', 'input'); reg('graph-search', 'input'); reg('widget-search-input', 'input')
const frame = reg('mission-control-frame', 'iframe')
const svg = reg('graph-svg', 'svg'); svg.querySelectorAll = () => []
const gc = reg('graph-canvas-container'); gc.clientWidth = 800; gc.clientHeight = 600

// fetch mock: routes the app's server API and the OmniRoute proxy
const calls = []
globalThis.fetch = vi.fn(async (url, options = {}) => {
  calls.push({ url, options })
  const json = (body, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body), json: async () => body, blob: async () => new Blob() })
  if (url.endsWith('/api/config')) return json({ host: '192.168.0.8', omniRoute: 'http://192.168.0.8:20128/v1', claude: { command: 'drift bare', note: 'n' } })
  if (url.endsWith('/api/omni/models')) return json({ data: [{ id: 'auto/best-fast' }, { id: 'antigravity/gemini-3.1-flash-image' }] })
  if (url.endsWith('/api/omni/chat/completions')) return json({ model: 'auto/best-fast', choices: [{ message: { content: 'hi' } }] })
  if (url.endsWith('/api/omni/images/generations')) return json({ data: [{ b64_json: 'AAAA' }] })
  if (url.endsWith('/api/house')) return json({ up: 28, total: 30, groups: [{ targets: [{ id: 'x', label: 'X', up: true }, { id: 'y', label: 'Y', up: false }] }] })
  if (url.endsWith('/api/vault/status')) return json({ up: true, state: 'UP', url: 'http://127.0.0.1:27123' })
  if (url.endsWith('/api/vault/graph')) return json({ ok: true, name: 'Antigravity', notes: 3, wikilinks: 2, orphans: 1, nodes: [{ id: 'A', label: 'A', group: '(root)', in: 0, out: 2 }, { id: 'B', label: 'B', group: '(root)', in: 1, out: 0 }, { id: 'sub/C', label: 'C', group: 'sub', in: 1, out: 0 }], links: [{ source: 'A', target: 'B' }, { source: 'A', target: 'sub/C' }] })
  if (url.includes('/api/vault/note')) return json({ ok: true, path: 'A', markdown: '# A' })
  if (url.endsWith('/api/business')) return json({
    source: 'ANTIGRAVITY', emergent: { state: 'UP', health: { userCount: 3 }, analytics: { state: 'UNAVAILABLE' } },
    crm: { state: 'UP', crm: { totalLeads: 12, hotLeads: 2, totalCampaigns: 3, email: { openRate: 50 } } },
    marketing: { state: 'PARTIAL', marketing: { activeAutomationRules: 1, socialLeadsCaptured: 7, landingPageConversions: 8 } },
  })
  if (url.endsWith('/api/avatars')) return json({ count: 1, files: [{ file: 'fable-avatar.png', url: '/avatars/fable-avatar.png', bytes: 1000 }] })
  if (url.endsWith('/api/agents')) return json({ count: 2, source: 'C:/ANTIGRAVITY/.agents/skills', agents: [
    { id: 'judge-house', name: 'judge-house', description: 'Judge lane protocol', category: 'ops + method', path: '.agents/skills/judge-house/SKILL.md' },
    { id: 'agency-unity-architect', name: 'agency-unity-architect', description: 'Unity architecture', category: 'agency', path: '.agents/skills/agency-unity-architect/SKILL.md' },
  ] })
  if (url.endsWith('/api/launch/claude')) return json({ ok: true, opened: 'claude.exe', on: 'THIS-NODE', from: '::1' })
  if (url.endsWith('/api/claude/status')) return json({ installed: true, access: { ok: true }, permissionMode: 'plan' })
  return json({ error: 'no route ' + url }, false, 404)
})

const app = await import('../js/app.js')

beforeEach(() => { calls.length = 0 })

describe('no sample data', () => {
  it('exports no SAMPLE_AGENTS and starts with an empty agent list', () => {
    expect(app.SAMPLE_AGENTS).toBeUndefined()
    expect(Array.isArray(app.state.agents)).toBe(true)
  })
  it('the source has no hardcoded agent, graph, or count fixtures', () => {
    const src = readFileSync(resolve(__dirname, '../js/app.js'), 'utf8')
    expect(src).not.toMatch(/SAMPLE_AGENTS/)
    expect(src).not.toMatch(/'251\+'/)
    expect(src).not.toMatch(/Joshua Coleman/)
    expect(src).not.toMatch(/127\.0\.0\.1:20128|localhost:20128/)
  })
})

describe('business telemetry HUD', () => {
  it('renders verified CRM and marketing aggregates without requiring analytics auth', async () => {
    await app.initBusiness()
    expect(registry.get('#business-status').textContent).toContain('Date App: UP')
    expect(registry.get('#business-leads').textContent).toBe('12')
    expect(registry.get('#business-hot-leads').textContent).toBe('2')
    expect(registry.get('#business-open-rate').textContent).toBe('50%')
    expect(registry.get('#business-social').textContent).toBe('7')
    expect(registry.get('#business-detail').textContent).toContain('analytics not authorized')
  })
})

describe('tab navigation (the bug that killed every click)', () => {
  it('switchTab activates the section and records the tab', () => {
    app.switchTab('widgets')
    expect(app.state.currentTab).toBe('widgets')
    expect(registry.get('#tab-widgets').classList.contains('active')).toBe(true)
    expect(registry.get('#tab-dashboard').classList.contains('active')).toBe(false)
  })
  it('clicking a nav tab through initTabs works end to end', () => {
    app.initTabs()
    tabs.find((t) => t.li.dataset.tab === 'agents').li.click()
    expect(app.state.currentTab).toBe('agents')
  })
  it('mission-control tab points the iframe at the page host, not localhost', () => {
    app.switchTab('mission-control')
    expect(frame.src).toBe('http://192.168.0.8:3151/')
  })
})

describe('OmniRoute goes through the server proxy, never direct', () => {
  it('omniFetch calls /api/omni/<path> on the same origin with no Authorization header', async () => {
    await app.omniFetch('/models')
    const c = calls.find((x) => x.url.endsWith('/api/omni/models'))
    expect(c).toBeTruthy()
    expect(c.url.startsWith('/api/omni')).toBe(true)
    expect(c.options.headers?.Authorization).toBeUndefined()
  })
  it('omniChat posts the chat payload', async () => {
    await app.omniChat([{ role: 'user', content: 'x' }])
    const c = calls.find((x) => x.url.endsWith('/chat/completions'))
    expect(JSON.parse(c.options.body)).toMatchObject({ model: app.CHAT_MODEL, messages: [{ role: 'user', content: 'x' }] })
  })
  it('omniImageGen defaults to the one verified image model and asks for b64', async () => {
    await app.omniImageGen('a cat')
    const c = calls.find((x) => x.url.endsWith('/images/generations'))
    expect(JSON.parse(c.options.body)).toMatchObject({ model: 'antigravity/gemini-3.1-flash-image', response_format: 'b64_json' })
    expect(app.IMAGE_MODEL).toBe('antigravity/gemini-3.1-flash-image')
  })
})

describe('live agents from the skills tree', () => {
  it('initAgents loads from /api/agents and derives categories', async () => {
    await app.initAgents()
    expect(app.state.agents.length).toBe(2)
    expect(app.state.categories).toEqual(['all', 'agency', 'ops + method'])
    expect(registry.get('#stat-agents').textContent).toBe('2')
  })
  it('filters by category and search', () => {
    app.state.selectedCategory = 'agency'
    app.renderAgentList()
    expect(registry.get('#agent-list').children.length).toBe(1)
    app.state.selectedCategory = 'all'
    registry.get('#agent-search').value = 'judge'
    app.renderAgentList()
    expect(registry.get('#agent-list').children.length).toBe(1)
    registry.get('#agent-search').value = ''
  })
})

describe('knowledge graph is the vault', () => {
  it('initGraph builds nodes and links from /api/vault/graph', async () => {
    await app.initGraph()
    expect(app.state.graph.nodes.length).toBe(3)
    expect(app.state.graph.links.length).toBe(2)
    expect(registry.get('#graph-meta').textContent).toMatch(/3 notes/)
    expect(registry.get('#stat-nodes').textContent).toBe('3')
  })
  it('simulateGraph keeps nodes inside the canvas', () => {
    app.simulateGraph(800, 600)
    for (const n of app.state.graph.nodes) { expect(n.x).toBeGreaterThanOrEqual(30); expect(n.x).toBeLessThanOrEqual(770) }
  })
  it('openNote fetches the note and offers an obsidian:// link', async () => {
    await app.openNote(app.state.graph.nodes[0])
    const note = registry.get('#graph-note')
    const a = note.children.find((c) => c.tagName === 'a')
    expect(a.attrs.href).toMatch(/^obsidian:\/\/open\?vault=Antigravity&file=A$/)
  })
})

describe('dashboard stats are live readings', () => {
  it('initDashboard fills services, vault, avatars from the server', async () => {
    await app.initDashboard()
    expect(registry.get('#omni-model-count').textContent).toBe('2')
    expect(registry.get('#stat-services').textContent).toBe('28/30')
    expect(registry.get('#stat-services-detail').textContent).toMatch(/DOWN: Y/)
    expect(registry.get('#stat-vault').textContent).toBe('UP')
    expect(registry.get('#stat-avatars').textContent).toBe('1')
  })
})

describe('claude launch', () => {
  it('posts to /api/launch/claude and reports where it opened', async () => {
    await app.launchClaude()
    const c = calls.find((x) => x.url.endsWith('/api/launch/claude'))
    expect(c.options.method).toBe('POST')
    expect(registry.get('#claude-result').textContent).toMatch(/THIS-NODE/)
  })

  it('initClaude reports bridge capability', async () => {
    await app.initClaude()
    expect(registry.get('#claude-bridge-status').textContent).toBe('Bridge: installed · access ok · mode plan')
  })
})

describe('workflow_api.json', () => {
  it('uses the one OmniRoute URL and the verified image model', () => {
    const config = JSON.parse(readFileSync(resolve(__dirname, '../workflow_api.json'), 'utf8'))
    expect(config.base_url).toBe('http://192.168.0.8:20128/v1')
    expect(JSON.stringify(config)).not.toMatch(/127\.0\.0\.1:20128|localhost:20128/)
  })
})
