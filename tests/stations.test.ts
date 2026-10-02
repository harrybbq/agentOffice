// Stations from the theme: rule routing, the idle clock, station tags, and that all of it is data
// (src/theme/stations.ts, src/scene/idle.ts). Imported by corridors.test.ts (npm test runs
// everything); also runs alone: tsx tests/stations.test.ts
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRANCH_REQUIRED, HQ_REQUIRED, parseMap, validateTheme } from '../src/theme/parse.ts'
import type { Rect } from '../src/theme/parse.ts'
import { declutter, joinPhrase, LABEL_FULL_ZOOM, LABEL_MIN_ZOOM, labelMode, plainDetail, stationAnchors, StationRouter } from '../src/theme/stations.ts'
import { IdleClock } from '../src/scene/idle.ts'
import { nearest, Roster, Stations } from '../src/scene/roster.ts'
import type { Point } from '../src/scene/roster.ts'
import { WorldLayout } from '../src/world/layout.ts'
import { blockRect, CorridorNetwork } from '../src/world/corridors.ts'
import { NavScopes } from '../src/world/scopes.ts'
import { HOME, MANAGER, STATION_RULE_MAX_PATTERN } from '../shared/theme.ts'
import type { ThemeManifest } from '../shared/theme.ts'
import { ACTIVITIES } from '../shared/events.ts'
import { DETAIL_BOARD, DETAIL_PLANNING, DETAIL_QUESTION, DETAIL_SECRETS } from '../shared/details.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const json = (f: string) => JSON.parse(readFileSync(new URL(`../themes/office/${f}`, import.meta.url), 'utf8'))
const office = json('theme.json') as ThemeManifest
const hqMap = parseMap(json('hq.json'))
const branchMap = parseMap(json('branch.json'))

let pass = 0
const t = (name: string, fn: () => void) => {
  fn()
  pass++
  console.log('ok -', name)
}

const base: ThemeManifest = {
  name: 't',
  displayName: 'T',
  hq: 'hq.json',
  branch: 'branch.json',
  background: '#000000',
  roles: {
    boss: { label: 'Boss', placeholder: { accessory: 'tie', accent: '#ffffff' } },
    manager: { label: 'Lead', placeholder: { accessory: 'clipboard', accent: '#ffffff' } },
    worker: { label: 'Hand', placeholder: { accessory: 'none', accent: '#ffffff' } }
  },
  providers: { default: { tint: '#cccccc' } },
  activities: {
    read: { location: 'shelf', anim: 'work', verb: 'Reading up' },
    write: { location: HOME, verb: 'Writing' },
    exec: 'bench',
    web: { location: 'window', verb: 'Looking out' },
    capture: 'bench',
    waiting: { location: 'inbox', verb: 'Waiting' },
    idle: HOME,
    done: { location: MANAGER, verb: 'Reporting' }
  },
  props: { handoff: 'folder', report: 'report', memo: 'memo' }
}

const inRect = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

function* samples(from: Point, path: Point[]): Generator<Point> {
  let a = from
  for (const b of path) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)))
    for (let i = 0; i <= n; i++) yield { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }
    a = b
  }
}

function world(n: number) {
  const l = new WorldLayout(hqMap, branchMap)
  const net = new CorridorNetwork(l)
  for (let i = 0; i < n; i++) assert.ok(net.connect(l.addBranch('T' + i)))
  const scopes = new NavScopes(l.bounds(), l.all(), net.cells().map((c) => net.cellRect(c)))
  return { l, net, scopes }
}

// ---- rule routing --------------------------------------------------------------------------------

t('rules: the first matching rule wins, in list order; no match falls back to the activities table', () => {
  const r = new StationRouter({
    ...base,
    stationRules: [
      { detail: '^plan', location: 'board', verb: 'Planning' },
      { detail: 'plan', location: 'elsewhere', verb: 'Never' },
      { activity: 'read', detail: '\\.env$', location: 'safe' }
    ]
  })
  assert.equal(r.route('write', 'planning the week').def.location, 'board')
  assert.equal(r.route('write', 'planning the week').rule, 0)
  // Only the second rule matches (not at the start): it still wins over the table.
  assert.equal(r.route('write', 'a new plan').def.location, 'elsewhere')
  assert.equal(r.route('write', 'a new plan').rule, 1)
  // Nothing matches: the table decides.
  assert.deepEqual(r.route('read', 'src/app.ts'), { def: { location: 'shelf', anim: 'work', verb: 'Reading up' }, detail: 'src/app.ts', rule: null })
  assert.equal(r.route('exec', 'npm test').def.location, 'bench')
  assert.equal(r.route('exec', 'npm test').rule, null)
})

t('rules: `activity` limits a rule to that activity; without it the rule is for any activity; matching ignores case', () => {
  const r = new StationRouter({
    ...base,
    stationRules: [
      { activity: 'read', detail: '\\.env$', location: 'safe' },
      { detail: '^SECRETS:', location: 'safe', verb: 'Locked away' }
    ]
  })
  assert.equal(r.route('read', 'config/.ENV').def.location, 'safe')
  assert.equal(r.route('write', 'config/.env').def.location, HOME) // the rule is for read only
  for (const a of ACTIVITIES) assert.equal(r.route(a, 'secrets: keys.pem').def.location, 'safe')
})

t('rules: verb and animation come from the rule, else from the activity; a prefix the verb says is cut from the detail', () => {
  const r = new StationRouter({
    ...base,
    stationRules: [
      { detail: '^planning:\\s*', location: 'board', verb: 'Planning', anim: 'carry' },
      { detail: '^note:', location: 'board' },
      { detail: 'urgent', location: 'board', verb: 'Rushing' },
      { detail: '^checking the board', location: 'board', verb: 'Checking the board' }
    ]
  })
  assert.deepEqual(r.route('write', 'planning: the release'), { def: { location: 'board', anim: 'carry', verb: 'Planning' }, detail: 'the release', rule: 0 })
  // No verb of its own: the activity's verb and animation, and the detail stays whole.
  assert.deepEqual(r.route('read', 'note: call back'), { def: { location: 'board', anim: 'work', verb: 'Reading up' }, detail: 'note: call back', rule: 1 })
  // A match in the middle cuts nothing.
  assert.equal(r.route('write', 'an urgent fix').detail, 'an urgent fix')
  assert.equal(r.route('read', 'checking the board').detail, '')
  assert.equal(r.phrase('read', 'checking the board'), 'Checking the board')
  assert.equal(r.phrase('write', 'planning: the release'), 'Planning · the release')
})

t('rules: HOME and MANAGER work as rule locations', () => {
  const r = new StationRouter({ ...base, stationRules: [{ detail: '^delegating$', location: HOME }, { detail: '^report', location: MANAGER }] })
  assert.equal(r.route('exec', 'delegating').def.location, HOME)
  assert.equal(r.route('exec', 'report ready').def.location, MANAGER)
})

t('rules: invalid ones are ignored with a warning; the rest still apply', () => {
  const warnings: string[] = []
  const long = 'a'.repeat(STATION_RULE_MAX_PATTERN + 1)
  const rules = [
    { detail: '([unclosed', location: 'x' },
    { detail: long, location: 'x' },
    { detail: 'ok', location: '' },
    { location: 'x' },
    { activity: 'dancing', detail: 'ok', location: 'x' },
    null,
    'nope',
    { detail: '^ok', location: 'good', verb: 'Fine' },
    { detail: 'a'.repeat(STATION_RULE_MAX_PATTERN), location: 'edge' }
  ]
  const r = new StationRouter({ ...base, stationRules: rules as unknown as ThemeManifest['stationRules'] }, (m) => warnings.push(m))
  assert.equal(warnings.length, 7)
  assert.match(warnings[0], /stationRules\[0\].*invalid pattern/)
  assert.match(warnings[1], /longer than 200/)
  assert.equal(r.route('read', 'ok then').def.location, 'good')
  assert.equal(r.route('read', 'ok then').rule, 7) // the index in the theme's list
  assert.equal(r.route('read', 'a'.repeat(STATION_RULE_MAX_PATTERN)).def.location, 'edge') // exactly the cap is fine
  assert.equal(r.route('read', '([unclosed').def.location, 'shelf')
  // A theme whose stationRules is not a list at all: ignored, the table still works.
  const bad = new StationRouter({ ...base, stationRules: { detail: 'x' } as unknown as ThemeManifest['stationRules'] }, (m) => warnings.push(m))
  assert.equal(bad.route('exec', 'x').def.location, 'bench')
  // No rules, no labels, no idle: everything is the activities table (a theme from before stations).
  const plain = new StationRouter(base, () => assert.fail('no warnings expected'))
  assert.equal(plain.route('web', 'example.com').def.location, 'window')
  assert.equal(plain.idle, null)
  assert.equal(plain.labels.size, 0)
})

t('phrases: the theme verb plus the detail, a plain verb without one, tool prefixes dropped', () => {
  const r = new StationRouter(base, () => undefined)
  assert.equal(r.phrase('web', 'example.com'), 'Looking out · example.com')
  assert.equal(r.phrase('web', 'WebFetch: example.com'), 'Looking out · example.com')
  assert.equal(r.phrase('exec', 'npm test'), 'Running · npm test') // the theme has no verb for exec
  assert.equal(r.phrase('idle'), 'Idle')
  assert.equal(r.phrase('write', ''), 'Writing')
  assert.equal(r.verb('capture'), 'Capturing')
  // A drive letter or a URL is not a tool prefix.
  assert.equal(plainDetail('C:\\repo\\app.ts'), 'C:\\repo\\app.ts')
  assert.equal(plainDetail('https://example.com/a'), 'https://example.com/a')
  assert.equal(plainDetail('  Bash:   npm   test '), 'npm test')
  assert.equal(joinPhrase('', 'x'), 'x')
  assert.equal(joinPhrase('Verb', ''), 'Verb')
})

// ---- the office theme ----------------------------------------------------------------------------

t('office theme: the details the adapters write are routed to their stations; waiting keeps its place', () => {
  const r = new StationRouter(office, () => assert.fail('the office theme has an invalid rule'))
  assert.equal(r.route('write', `${DETAIL_PLANNING}split the store`).def.location, 'whiteboard')
  assert.equal(r.phrase('write', `${DETAIL_PLANNING}split the store`), 'Planning · split the store')
  assert.equal(r.route('read', DETAIL_BOARD).def.location, 'noticeboard')
  assert.equal(r.route('read', `${DETAIL_SECRETS}.env`).def.location, 'vault')
  assert.equal(r.route('write', `${DETAIL_SECRETS}.env`).def.location, 'vault')
  // A question is still a waiting event at the waiting location (the memo relay decides the rest).
  const q = r.route('waiting', `${DETAIL_QUESTION}Which runner?`)
  assert.equal(q.def.location, r.table('waiting').location)
  assert.equal(q.def.verb, 'Asking')
  assert.equal(q.detail, 'Which runner?')
  // An ordinary permission request is untouched.
  assert.equal(r.route('waiting', 'run the tests').rule, null)
  // Everything else: the activities table.
  assert.equal(r.route('read', 'src/app.ts').def.location, 'filing_cabinet')
  assert.equal(r.route('web', 'example.com').def.location, 'printer')
  assert.deepEqual(r.idle, { location: 'lounge', afterMs: 45000 })
})

t('office theme: no warnings; every station it names is on a map and has a label', () => {
  assert.deepEqual(validateTheme(office, hqMap, branchMap), [])
  const r = new StationRouter(office)
  const named = new Set<string>()
  for (const a of ACTIVITIES) named.add(r.table(a).location)
  for (const rule of office.stationRules ?? []) named.add(rule.location)
  named.add(office.idle!.location)
  for (const type of ['boss_seat', 'inbox', 'manager_seat', 'desk']) named.add(type)
  named.delete(HOME)
  named.delete(MANAGER)
  for (const type of named) {
    assert.ok(branchMap.locations.get(type)?.length || hqMap.locations.get(type)?.length, `${type} is on no map`)
    assert.ok(r.labels.get(type)?.title, `${type} has no label`)
  }
  for (const [type, label] of r.labels) {
    assert.ok(branchMap.locations.get(type)?.length || hqMap.locations.get(type)?.length, `label ${type} has no location`)
    assert.ok(label.title.length > 0 && label.title.length <= 24, `${type}: title too long for a tag`)
    if (label.color) assert.match(label.color, /^#[0-9a-f]{6}$/i)
  }
  assert.equal(r.labels.get('whiteboard')!.subtitle, 'Ideas & planning')
  assert.equal(r.labels.get('vault')!.subtitle, 'Secure storage')
  assert.equal(r.labels.get('lounge')!.subtitle, 'Idle')
  assert.equal(r.labels.get('inbox')!.title, 'Security gate')
  assert.ok(hqMap.locations.get('noticeboard')?.length, 'the HQ has no noticeboard (where notes fly to)')
})

t('office map: every location is reachable from every desk and the manager seat, inside the branch', () => {
  const { l, scopes } = world(3)
  for (const b of l.branches()) {
    const nav = scopes.branch(b.id)
    const r = blockRect(b)
    const starts = [...b.locations.get('desk')!, b.locations.get('manager_seat')![0]]
    const types = [...b.locations.keys()].filter((ty) => ty !== 'door')
    for (const type of ['whiteboard', 'noticeboard', 'vault', 'lounge', 'printer', 'filing_cabinet', 'server_room', 'photo_booth']) assert.ok(types.includes(type), `no ${type}`)
    for (const type of types) {
      for (const to of b.locations.get(type)!) {
        for (const from of starts) {
          const path = nav.findPath(from, to)
          assert.ok(path, `${b.id}: no path ${from.name} -> ${to.name}`)
          if (path.length > 0) assert.deepEqual(path[path.length - 1], { x: to.x, y: to.y })
          for (const p of samples(from, path)) assert.ok(inRect(p, r), `${from.name} -> ${to.name} leaves the branch`)
        }
      }
    }
    // The manager also reaches them on its own nav (HQ + corridors + its branch), and the HQ board.
    const seat = b.locations.get('manager_seat')![0]
    for (const type of types) assert.ok(scopes.manager(b.id).findPath(seat, b.locations.get(type)![0]), `${b.id}: manager can't reach ${type}`)
    assert.ok(scopes.manager(b.id).findPath(seat, l.hq.locations.get('noticeboard')![0]))
  }
  // No location sits inside furniture or a wall.
  for (const map of [hqMap, branchMap]) {
    const solid = [...map.walls, ...map.furniture.filter((f) => f.solid)]
    for (const [type, pts] of map.locations) {
      if (type === 'door') continue
      for (const p of pts) for (const s of solid) assert.ok(!(p.x > s.x && p.x < s.x + s.width && p.y > s.y && p.y < s.y + s.height), `${p.name} is inside ${JSON.stringify(s)}`)
    }
  }
})

t('scope: a worker sent by a rule never leaves its branch; a manager uses its own branch first', () => {
  const layout = new WorldLayout(hqMap, branchMap)
  const roster = new Roster(layout, { provider: 'human', displayName: 'CEO' })
  const ev = (agentId: string, parentId: string | null) => ({ agentId, parentId, provider: 'x', displayName: agentId })
  roster.ensure(ev('m1', null))
  roster.ensure(ev('m2', null))
  roster.ensure(ev('w1', 'm2'))
  const router = new StationRouter(office)
  const own = blockRect(roster.blockOf('w1'))
  const other = roster.blockOf('m1')
  const details = [`${DETAIL_PLANNING}x`, DETAIL_BOARD, `${DETAIL_SECRETS}.env`, 'src/a.ts', 'npm test', 'example.com']
  // Standing in its own branch, in the middle of another one, or at the HQ: the answer is its own branch's station.
  const froms = [roster.get('w1')!.home, { x: other.offset.x + other.width / 2, y: other.offset.y + other.height / 2 }, layout.hq.locations.get('inbox')![0]]
  for (const a of ['read', 'write', 'exec', 'web', 'capture'] as const) {
    for (const d of details) {
      const loc = router.route(a, d).def.location
      if (loc === HOME || loc === MANAGER) continue
      for (const from of froms) {
        const p = roster.station('w1', loc, from)
        assert.ok(p, `w1 finds no ${loc}`)
        assert.ok(inRect(p, own), `${loc} for w1 is outside its branch`)
        const m = roster.station('m2', loc, from)!
        assert.ok(inRect(m, own), `${loc} for m2 is not in its own branch`)
      }
    }
  }
  // The board is in the HQ too: a worker still only ever gets its branch's.
  assert.ok(inRect(roster.station('w1', 'noticeboard', layout.hq.locations.get('noticeboard')![0])!, own))
  // A station its branch does not have: nothing (the character goes home), never the HQ's.
  assert.equal(roster.station('w1', 'boss_seat', roster.get('w1')!.home), null)
  // The idle location is looked up in the character's own block, for workers and managers alike.
  for (const id of ['w1', 'm2']) {
    const p = nearest(roster.blockOf(id).locations, router.idle!.location, roster.get(id)!.home)
    assert.ok(p && inRect(p, own))
  }
})

// ---- idle ----------------------------------------------------------------------------------------

t('idle: a character rests after afterMs without activity and goes back to work on the next one', () => {
  const c = new IdleClock(45_000)
  const all = () => true
  c.touch('w1', 1000) // arrived
  c.touch('m1', 1000)
  assert.deepEqual(c.due(1000 + 44_999, all), [])
  assert.deepEqual(c.due(1000 + 45_000, all).sort(), ['m1', 'w1'])
  assert.ok(c.isResting('w1') && c.isResting('m1'))
  // Already resting: not sent again.
  assert.deepEqual(c.due(1000 + 90_000, all), [])
  // The next activity ends the rest and restarts the clock.
  c.touch('w1', 100_000)
  assert.ok(!c.isResting('w1'))
  assert.ok(c.isResting('m1'))
  assert.deepEqual(c.due(100_000 + 44_000, all), [])
  assert.deepEqual(c.due(100_000 + 45_000, all), ['w1'])
})

t('idle: only eligible characters rest (not while waiting or walking); they are asked again later', () => {
  const c = new IdleClock(1000)
  c.touch('w1', 0)
  c.touch('w2', 0)
  // w1 is waiting on the user: not now.
  assert.deepEqual(c.due(5000, (id) => id !== 'w1'), ['w2'])
  assert.ok(!c.isResting('w1'))
  assert.deepEqual(c.due(6000, () => true), ['w1'])
  c.forget('w2')
  assert.ok(!c.isResting('w2'))
  // track() keeps an existing clock (an "idle" event does not restart it), touch() restarts it.
  c.track('w1', 9999)
  assert.ok(c.isResting('w1'))
  c.endRest('w1')
  assert.deepEqual(c.due(6001, () => true), ['w1'])
  // A theme without idle: nobody ever rests.
  const off = new IdleClock(0)
  off.touch('w1', 0)
  assert.equal(off.enabled, false)
  assert.deepEqual(off.due(10 ** 9, () => true), [])
})

// ---- tags ----------------------------------------------------------------------------------------

t('tags: one per station, pinned to its furniture; `once` types get a single tag per block', () => {
  const layout = new WorldLayout(hqMap, branchMap)
  const b = layout.addBranch('T0')
  const router = new StationRouter(office)
  const anchors = stationAnchors(b, router.labels, layout.tile)
  const r = blockRect(b)
  const types = anchors.map((a) => a.type)
  // Desks are labelled once, not eight times.
  assert.equal(types.filter((x) => x === 'desk').length, 1)
  assert.equal(anchors.find((a) => a.type === 'desk')!.points.length, b.locations.get('desk')!.length)
  for (const type of ['manager_seat', 'printer', 'filing_cabinet', 'server_room', 'photo_booth', 'whiteboard', 'noticeboard', 'vault', 'lounge']) {
    assert.equal(types.filter((x) => x === type).length, 1, `${type}: expected one tag`)
  }
  assert.ok(!types.includes('inbox') && !types.includes('boss_seat')) // those are in the HQ
  assert.equal(new Set(anchors.map((a) => a.key)).size, anchors.length)
  for (const a of anchors) {
    assert.ok(inRect(a, r), `${a.type}: tag outside its block`)
    assert.ok(a.rect, `${a.type}: no furniture next to it`)
    assert.ok(a.x >= a.rect!.x && a.x <= a.rect!.x + a.rect!.width && a.y === a.rect!.y, `${a.type}: not on its furniture's top edge`)
    assert.ok(a.color !== null)
  }
  // Tags of one block keep clear of each other at normal zoom (a title tag is about 90 x 20 px).
  for (const a of anchors) for (const o of anchors) if (a !== o) assert.ok(Math.abs(a.x - o.x) >= 90 || Math.abs(a.y - o.y) >= 22, `${a.type} and ${o.type} tags collide`)
  // Priorities follow the order of stationLabels.
  const order = [...router.labels.keys()]
  for (const a of anchors) assert.equal(a.priority, order.indexOf(a.type))

  const hq = stationAnchors(layout.hq, router.labels, layout.tile)
  assert.deepEqual(hq.map((a) => a.type).sort(), ['boss_seat', 'inbox', 'noticeboard'])
  assert.equal(hq.find((a) => a.type === 'inbox')!.points.length, 6)
})

t('tags: without furniture a tag floats above its location; the dot colour falls back to the furniture, then to none', () => {
  const labels = new StationRouter({ ...base, stationLabels: { yard: { title: 'Yard' }, gym: { title: 'Gym', color: '#ff0000' }, cell: { title: 'Cells', once: true }, bad: { title: '' } as never } }, () => undefined).labels
  assert.deepEqual([...labels.keys()], ['yard', 'gym', 'cell'])
  const block = {
    locations: new Map([
      ['yard', [{ name: 'yard', x: 100, y: 200 }]],
      ['gym', [{ name: 'gym', x: 400, y: 200 }]],
      ['cell', [0, 1, 2].map((i) => ({ name: `cell_${i}`, x: 100 + i * 100, y: 400 }))]
    ]),
    furniture: [{ x: 380, y: 100, width: 40, height: 60, solid: true, color: 0x112233 }, { x: 0, y: 0, width: 600, height: 600, solid: false, color: 0xeeeeee }]
  }
  const [yard, gym, cell] = stationAnchors(block, labels, 32)
  assert.deepEqual([yard.x, yard.y, yard.rect, yard.color], [100, 200 - 1.4 * 32, null, null])
  assert.deepEqual([gym.x, gym.y, gym.color], [400, 100, 0xff0000])
  assert.deepEqual([cell.point.x, cell.points.length], [200, 3]) // the middle one
})

t('tags: zoom thresholds and declutter (priority wins, the hovered tag always shows)', () => {
  assert.equal(labelMode(LABEL_MIN_ZOOM - 0.01), 'hidden')
  assert.equal(labelMode(LABEL_MIN_ZOOM), 'title')
  assert.equal(labelMode(LABEL_FULL_ZOOM - 0.01), 'title')
  assert.equal(labelMode(LABEL_FULL_ZOOM), 'full')
  const a = { x: 0, y: 0, width: 80, height: 20, priority: 1 }
  const b = { x: 60, y: 5, width: 80, height: 20, priority: 0 }
  const c = { x: 300, y: 0, width: 80, height: 20, priority: 5 }
  let kept = declutter([a, b, c])
  assert.ok(kept.has(b) && kept.has(c) && !kept.has(a))
  kept = declutter([{ ...a, forced: true }, b, c])
  assert.equal(kept.size, 2)
  assert.ok([...kept].some((k) => k.forced) && !kept.has(b))
})

t('stations: who stands at a spot', () => {
  const s = new Stations()
  const p = { x: 10, y: 20 }
  s.claim('a', p)
  s.claim('b', p)
  s.claim('c', { x: 99, y: 99 })
  assert.deepEqual(s.occupantsAt(p), ['a', 'b'])
  s.release('a')
  assert.deepEqual(s.occupantsAt(p), ['b'])
  assert.deepEqual(s.occupantsAt({ x: 0, y: 0 }), [])
})

// ---- a theme is data -----------------------------------------------------------------------------

/** A tiny Tiled map: point locations, optional furniture. */
function tiled(w: number, h: number, pts: [string, number, number][], furniture: [string, number, number, number, number][] = []) {
  let id = 1
  return {
    type: 'map',
    orientation: 'orthogonal',
    width: w,
    height: h,
    tilewidth: 32,
    tileheight: 32,
    infinite: false,
    tilesets: [],
    layers: [
      {
        name: 'furniture',
        type: 'objectgroup',
        objects: [
          { id: id++, name: 'floor', x: 0, y: 0, width: w * 32, height: h * 32, properties: [{ name: 'color', value: '#777777' }, { name: 'solid', value: false }] },
          ...furniture.map(([name, x, y, fw, fh]) => ({ id: id++, name, x: x * 32, y: y * 32, width: fw * 32, height: fh * 32, properties: [{ name: 'color', value: '#445566' }, { name: 'solid', value: true }] }))
        ]
      },
      { name: 'locations', type: 'objectgroup', objects: pts.map(([type, x, y]) => ({ id: id++, name: type, type, x: x * 32, y: y * 32, point: true })) }
    ]
  }
}

t('a prison theme needs no code: its own stations, rules, idle yard and tags work from data alone', () => {
  const prison: ThemeManifest = {
    ...base,
    name: 'prison',
    displayName: 'Prison',
    roles: {
      boss: { label: 'Warden', placeholder: { accessory: 'peaked_cap', accent: '#222222' } },
      manager: { label: 'Guard', placeholder: { accessory: 'baton', accent: '#222222' } },
      worker: { label: 'Inmate', placeholder: { accessory: 'number', accent: '#ffffff' } }
    },
    activities: {
      read: { location: 'library', verb: 'Studying' },
      write: { location: HOME, verb: 'Scribbling' },
      exec: { location: 'workshop', verb: 'Hammering' },
      web: { location: 'payphone', verb: 'Calling' },
      capture: { location: 'watchtower', verb: 'Watching' },
      waiting: { location: 'hatch', verb: 'Asking the warden' },
      idle: HOME,
      done: { location: MANAGER, verb: 'Reporting' }
    },
    stationRules: [
      { detail: '^planning:\\s*', location: 'canteen', verb: 'Scheming' },
      { detail: '^secrets:\\s*', location: 'solitary', verb: 'Hiding' },
      { detail: '^checking the board$', location: 'roll_call', verb: 'Roll call' }
    ],
    idle: { location: 'yard', afterMs: 20_000 },
    stationLabels: {
      hatch: { title: 'Warden’s hatch', subtitle: 'Waiting on you', once: true },
      yard: { title: 'Yard', subtitle: 'Idle' },
      canteen: { title: 'Canteen', subtitle: 'Scheming' },
      solitary: { title: 'Solitary', subtitle: 'Secrets', color: '#aa3333' },
      library: { title: 'Library' },
      desk: { title: 'Cells', once: true }
    }
  }
  const hq = parseMap(tiled(8, 6, [['boss_seat', 4, 1], ['hatch', 2, 5], ['hatch', 4, 5], ['inbox', 6, 5], ['door', 4, 6]], [['hatch_window', 3, 3.5, 2, 0.5]]))
  const branch = parseMap(
    tiled(
      14,
      10,
      [
        ['manager_seat', 2, 2], ['desk', 2, 6], ['desk', 5, 6], ['desk', 8, 6], ['entrance', 7, 9], ['door', 7, 10], ['door', 0, 5],
        ['library', 6, 2.5], ['workshop', 9, 2.5], ['payphone', 12, 2.5], ['watchtower', 12, 6], ['canteen', 11, 8.5], ['solitary', 4, 8.5], ['roll_call', 8, 8.5], ['yard', 12, 4.5]
      ],
      [['shelves', 5, 0.5, 2, 1], ['bench', 8.5, 0.5, 1, 1], ['tables', 10, 6.8, 2, 1]]
    )
  )
  assert.deepEqual(validateTheme(prison, hq, branch), [])

  const router = new StationRouter(prison, () => assert.fail('the prison theme should compile cleanly'))
  assert.equal(router.route('write', 'planning: the escape').def.location, 'canteen')
  assert.equal(router.phrase('write', 'planning: the escape'), 'Scheming · the escape')
  assert.equal(router.route('read', 'secrets: .env').def.location, 'solitary')
  assert.equal(router.route('read', 'checking the board').def.location, 'roll_call')
  assert.equal(router.route('read', 'a book').def.location, 'library')
  assert.equal(router.table('waiting').location, 'hatch')
  assert.deepEqual(router.idle, { location: 'yard', afterMs: 20_000 })

  // The world, the roster and the tags run on it unchanged.
  const layout = new WorldLayout(hq, branch)
  const roster = new Roster(layout, { provider: 'human', displayName: 'Warden' }, router.table('waiting').location)
  roster.ensure({ agentId: 'g1', parentId: null, provider: 'x', displayName: 'Guard 1' })
  roster.ensure({ agentId: 'i1', parentId: 'g1', provider: 'x', displayName: 'Inmate 1' })
  const net = new CorridorNetwork(layout)
  assert.ok(net.connect(layout.branch('g1')!))
  const scopes = new NavScopes(layout.bounds(), layout.all(), net.cells().map((c) => net.cellRect(c)))
  const b = layout.branch('g1')!
  const home = roster.get('i1')!.home
  for (const type of ['canteen', 'solitary', 'roll_call', 'library', 'workshop', 'payphone', 'watchtower', 'yard']) {
    const p = roster.station('i1', type, home)
    assert.ok(p && inRect(p, blockRect(b)), `${type} not found in the branch`)
    assert.ok(scopes.branch('g1').findPath(home, p), `inmate can't reach ${type}`)
  }
  // The guard waits at the theme's own waiting location in the HQ.
  assert.equal(roster.claimInbox('g1').point.name, 'hatch')
  assert.ok(scopes.manager('g1').findPath(roster.get('g1')!.home, roster.claimInbox('g1').point))
  const tags = stationAnchors(b, router.labels, layout.tile)
  assert.deepEqual(tags.map((x) => x.type).sort(), ['canteen', 'desk', 'library', 'solitary', 'yard'])
  assert.equal(tags.find((x) => x.type === 'solitary')!.color, 0xaa3333)
  assert.equal(tags.find((x) => x.type === 'library')!.color, 0x445566) // from its furniture
  assert.equal(tags.find((x) => x.type === 'yard')!.rect, null) // no furniture: floats above the point
  assert.deepEqual(stationAnchors(layout.hq, router.labels, layout.tile).map((x) => x.type), ['hatch'])
  // A typo in the theme is reported, not fatal.
  const typo = validateTheme({ ...prison, idle: { location: 'yrad', afterMs: 1 }, stationRules: [{ detail: 'x', location: 'nowhere' }], stationLabels: { moon: { title: 'Moon' } } }, hq, branch)
  assert.equal(typo.length, 3)
})

t('the code names no station of its own: only the required location types (and the optional noticeboard)', () => {
  const allowed = new Set<string>([...HQ_REQUIRED, ...BRANCH_REQUIRED, 'manager_inbox', 'noticeboard', HOME, MANAGER])
  const themed = new Set<string>()
  for (const map of [hqMap, branchMap]) for (const type of map.locations.keys()) if (!allowed.has(type)) themed.add(type)
  for (const rule of office.stationRules ?? []) if (!allowed.has(rule.location)) themed.add(rule.location)
  assert.ok(themed.has('vault') && themed.has('lounge') && themed.has('printer') && themed.size >= 8)
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name)) files.push(p)
    }
  }
  walk(join(root, 'src'))
  assert.ok(files.length > 40)
  const quoted = new RegExp(`['"\`](${[...themed].join('|')})['"\`]`)
  for (const f of files) {
    const hit = quoted.exec(readFileSync(f, 'utf8'))
    assert.equal(hit, null, `${f} names the office theme's station "${hit?.[1]}"`)
  }
})

console.log(`\n${pass} station tests passed\n`)
