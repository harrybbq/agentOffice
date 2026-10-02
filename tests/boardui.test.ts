// Pure logic of the Board panel (src/ui/board.ts): grouping, overlap detection, what is new on the
// board, relative times and the optimistic removal. No DOM, no React rendering.
// Imported by ui.test.ts (npm test runs everything); also runs alone: tsx tests/boardui.test.ts
import assert from 'node:assert/strict'
import { BOARD_CONFLICT_WINDOW_MS } from '../shared/board.ts'
import type { BoardBranch, BoardClaim, BoardFile, BoardNote, BoardSnapshot } from '../shared/board.ts'
import {
  applyRemovals,
  BOARD_VISIBLE_FILES,
  findOverlaps,
  groupBoard,
  newNotes,
  noteTarget,
  overlapBadge,
  overlapSummary,
  relTime,
  removalKey,
  removalReducer,
  splitPath,
  teamRow,
  warningText
} from '../src/ui/board.ts'

let pass = 0
const t = (name: string, fn: () => void) => {
  fn()
  pass++
  console.log('ok -', name)
}

const NOW = 1_800_000_000_000
const MIN = 60_000
const W = BOARD_CONFLICT_WINDOW_MS

const file = (path: string, ts: number, kind: BoardFile['kind'] = 'edit'): BoardFile => ({ path, ts, kind })
const branch = (sessionId: string, over: Partial<BoardBranch> = {}): BoardBranch => ({
  sessionId,
  team: sessionId.toUpperCase(),
  provider: 'claude-code',
  project: 'c:/repos/app',
  projectLabel: 'app',
  status: 'idle',
  task: '',
  files: [],
  lastActiveTs: NOW,
  ...over
})
const claim = (id: string, sessionId: string, over: Partial<BoardClaim> = {}): BoardClaim => ({
  id,
  project: 'c:/repos/app',
  task: `task ${id}`,
  sessionId,
  team: sessionId.toUpperCase(),
  ts: NOW,
  files: [],
  ...over
})
const note = (id: string, sessionId: string, over: Partial<BoardNote> = {}): BoardNote => ({
  id,
  project: 'c:/repos/app',
  sessionId,
  team: sessionId.toUpperCase(),
  ts: NOW,
  text: `note ${id}`,
  kind: 'note',
  ...over
})
const snap = (over: Partial<BoardSnapshot> = {}): BoardSnapshot => ({ branches: [], claims: [], notes: [], warnings: [], ...over })

t('board: two teams of one project on the same file overlap, and both are named', () => {
  const out = findOverlaps([
    branch('a', { files: [file('src/x.ts', NOW - 5 * MIN), file('src/only-a.ts', NOW)] }),
    branch('b', { files: [file('src/x.ts', NOW - 1 * MIN)] }),
    branch('c', { files: [file('src/only-c.ts', NOW)] })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].path, 'src/x.ts')
  // Most recent edit first.
  assert.deepEqual(out[0].teams.map((x) => x.sessionId), ['b', 'a'])
  assert.equal(out[0].ts, NOW - 1 * MIN)
})

t('board: the conflict window is inclusive at its edge and closed just beyond it', () => {
  const at = (gap: number) =>
    findOverlaps([branch('a', { files: [file('x.ts', NOW - gap)] }), branch('b', { files: [file('x.ts', NOW)] })]).length
  assert.equal(at(0), 1)
  assert.equal(at(W - 1), 1)
  assert.equal(at(W), 1)
  assert.equal(at(W + 1), 0)
  // The order of the two edits does not matter.
  assert.equal(findOverlaps([branch('a', { files: [file('x.ts', NOW)] }), branch('b', { files: [file('x.ts', NOW - W)] })]).length, 1)
  // An explicit window.
  assert.equal(findOverlaps([branch('a', { files: [file('x.ts', NOW - 2000)] }), branch('b', { files: [file('x.ts', NOW)] })], 1000).length, 0)
})

t('board: the same path in another project, or twice in one team, is no overlap', () => {
  assert.deepEqual(
    findOverlaps([
      branch('a', { files: [file('package.json', NOW)] }),
      branch('b', { project: 'c:/repos/other', projectLabel: 'other', files: [file('package.json', NOW)] })
    ]),
    []
  )
  assert.deepEqual(findOverlaps([branch('a', { files: [file('x.ts', NOW), file('x.ts', NOW - MIN, 'create')] })]), [])
  // Separators don't make it a different file.
  assert.equal(findOverlaps([branch('a', { files: [file('src\\x.ts', NOW)] }), branch('b', { files: [file('src/x.ts', NOW)] })]).length, 1)
})

t('board: with three teams only those inside the window of another are involved', () => {
  const out = findOverlaps([
    branch('a', { files: [file('x.ts', NOW)] }),
    branch('b', { files: [file('x.ts', NOW - 10 * MIN)] }),
    branch('c', { files: [file('x.ts', NOW - W - 20 * MIN)] })
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].teams.map((x) => x.sessionId), ['a', 'b'])
  // An older edit of the same team inside the window still counts for that team.
  const twice = findOverlaps([
    branch('a', { files: [file('x.ts', NOW), file('x.ts', NOW - W - 5 * MIN)] }),
    branch('b', { files: [file('x.ts', NOW - W - 10 * MIN)] })
  ])
  assert.deepEqual(twice.map((o) => o.teams.map((x) => [x.sessionId, x.ts])), [[['a', NOW - W - 5 * MIN], ['b', NOW - W - 10 * MIN]]])
})

t('board: a team row lists overlapping files first, then newest first, and never hides an overlap', () => {
  const many = Array.from({ length: 8 }, (_, i) => file(`src/f${i}.ts`, NOW - i * MIN))
  const a = branch('a', { files: [...many, file('old/shared.ts', NOW - 20 * MIN)] })
  const b = branch('b', { files: [file('old/shared.ts', NOW - 25 * MIN)] })
  const row = teamRow(a, findOverlaps([a, b]))
  assert.equal(row.files[0].path, 'old/shared.ts')
  assert.deepEqual(row.files[0].others, [{ sessionId: 'b', team: 'B' }])
  assert.deepEqual(row.files.slice(1, 4).map((f) => f.path), ['src/f0.ts', 'src/f1.ts', 'src/f2.ts'])
  assert.equal(row.visible.length, BOARD_VISIBLE_FILES)
  assert.equal(row.hidden, 9 - BOARD_VISIBLE_FILES)
  assert.equal(row.overlaps, 1)
  // More overlaps than the visible limit: all of them stay visible.
  const c = branch('c', { files: many })
  const d = branch('d', { files: many })
  const all = teamRow(c, findOverlaps([c, d]))
  assert.equal(all.visible.length, 8)
  assert.equal(all.hidden, 0)
  // The same path twice in one team is one line (the newest).
  const dup = teamRow(branch('e', { files: [file('x.ts', NOW - MIN, 'create'), file('x.ts', NOW)] }), [])
  assert.deepEqual(dup.files.map((f) => [f.path, f.ts, f.kind]), [['x.ts', NOW, 'edit']])
  assert.deepEqual(teamRow(branch('f'), []).files, [])
})

t('board: grouped by project, bigger projects first, teams in sidebar order with ended ones last', () => {
  const groups = groupBoard(
    snap({
      branches: [
        branch('solo', { project: 'c:/repos/shop', projectLabel: 'shop' }),
        branch('gone', { status: 'ended' }),
        branch('b', { files: [file('x.ts', NOW)] }),
        branch('a', { files: [file('x.ts', NOW - MIN)] })
      ],
      claims: [claim('c1', 'a', { ts: NOW - 5 * MIN }), claim('c2', 'b', { ts: NOW }), claim('c3', 'solo', { project: 'c:/repos/shop' })],
      notes: [note('n1', 'a', { ts: NOW - MIN }), note('n2', 'b', { ts: NOW })],
      warnings: [{ id: 'w1', project: 'c:/repos/app', sessionId: 'b', team: 'B', path: 'x.ts', otherTeam: 'A', ts: NOW }]
    }),
    { order: ['b', 'a', 'gone', 'solo'] }
  )
  assert.deepEqual(groups.map((g) => [g.label, g.teams.length]), [['app', 3], ['shop', 1]])
  assert.deepEqual(groups[0].teams.map((r) => r.branch.sessionId), ['b', 'a', 'gone'])
  assert.equal(groups[0].overlaps.length, 1)
  assert.equal(groups[1].overlaps.length, 0)
  assert.deepEqual(groups[0].claims.map((c) => c.id), ['c2', 'c1'])
  assert.deepEqual(groups[0].notes.map((n) => n.id), ['n2', 'n1'])
  assert.deepEqual(groups[1].claims.map((c) => c.id), ['c3'])
  assert.equal(groups[0].warnings.length, 1)
  // Without an order: by team name.
  assert.deepEqual(groupBoard(snap({ branches: [branch('b'), branch('a')] }))[0].teams.map((r) => r.branch.sessionId), ['a', 'b'])
  assert.deepEqual(groupBoard(snap()), [])
  // A note whose teams are gone is still listed, under a label made of its project key.
  const orphan = groupBoard(snap({ notes: [note('n9', 'x', { project: 'c:/repos/left' })] }))
  assert.deepEqual(orphan.map((g) => [g.label, g.teams.length, g.notes.length]), [['left', 0, 1]])
  assert.equal(groupBoard(snap({ notes: [note('n9', 'x', { project: 'C:\\repos\\left\\.git' })] }))[0].label, 'left')
})

t('board: summary texts', () => {
  assert.equal(overlapSummary(1), '1 file touched by more than one team')
  assert.equal(overlapSummary(2), '2 files touched by more than one team')
  assert.equal(overlapBadge(1), '1 overlap')
  assert.equal(overlapBadge(3), '3 overlaps')
  assert.equal(warningText({ team: 'B', path: 'src\\x.ts', otherTeam: 'A' }), 'Stopped B once before editing src/x.ts (changed by A)')
  assert.deepEqual(splitPath('src/ui/App.tsx'), { dir: 'src/ui/', base: 'App.tsx' })
  assert.deepEqual(splitPath('README.md'), { dir: '', base: 'README.md' })
  assert.deepEqual(splitPath('a\\b.ts'), { dir: 'a/', base: 'b.ts' })
})

t('board: relative times', () => {
  assert.equal(relTime(NOW - 20_000, NOW), 'just now')
  assert.equal(relTime(NOW - 3 * MIN, NOW), '3 min ago')
  assert.equal(relTime(NOW - 59 * MIN - 59_000, NOW), '59 min ago')
  assert.equal(relTime(NOW - 2 * 60 * MIN, NOW), '2 h ago')
  // A timestamp slightly ahead of this clock is "just now", not a date.
  assert.equal(relTime(NOW + 5000, NOW), 'just now')
})

t('board: only notes that were not seen before are new, and the first snapshot has none', () => {
  const notes = [note('n1', 'a'), note('n2', 'b')]
  assert.deepEqual(newNotes(null, notes), [])
  assert.deepEqual(newNotes(new Set(), notes).map((n) => n.id), ['n1', 'n2'])
  assert.deepEqual(newNotes(new Set(['n1']), notes).map((n) => n.id), ['n2'])
  assert.deepEqual(newNotes(new Set(['n1', 'n2', 'old']), notes), [])
  // With a clock: a note from long ago that only shows up now is not announced.
  const late = [note('fresh', 'a', { ts: NOW - 2000 }), note('stale', 'a', { ts: NOW - 5 * MIN })]
  assert.deepEqual(newNotes(new Set(), late, NOW).map((n) => n.id), ['fresh'])
})

t('board: a hand-over finds its team by name inside its own project', () => {
  const branches = [
    branch('a', { team: 'Frontend' }),
    branch('b', { team: 'tests' }),
    branch('x', { team: 'tests', project: 'c:/repos/other' }),
    branch('dead', { team: 'old', status: 'ended' })
  ]
  assert.equal(noteTarget(note('n', 'a', { kind: 'handover', to: ' Tests ' }), branches), 'b')
  assert.equal(noteTarget(note('n', 'b', { kind: 'handover', to: 'frontend' }), branches), 'a')
  // A plain note, no name, an unknown name, the author itself, an ended team: the HQ instead.
  assert.equal(noteTarget(note('n', 'a', { to: 'tests' }), branches), null)
  assert.equal(noteTarget(note('n', 'a', { kind: 'handover' }), branches), null)
  assert.equal(noteTarget(note('n', 'a', { kind: 'handover', to: 'nobody' }), branches), null)
  assert.equal(noteTarget(note('n', 'a', { kind: 'handover', to: 'frontend' }), branches), null)
  assert.equal(noteTarget(note('n', 'a', { kind: 'handover', to: 'old' }), branches), null)
  // Two teams with that name: ambiguous.
  assert.equal(noteTarget(note('n', 'a', { kind: 'handover', to: 'tests' }), [...branches, branch('b2', { team: 'tests' })]), null)
})

t('board: an optimistic removal hides the item, and a rollback brings it back', () => {
  const s = snap({
    branches: [branch('a', { task: 'task c2' }), branch('b', { task: 'task c3' })],
    claims: [claim('c1', 'a', { ts: NOW - MIN }), claim('c2', 'a', { ts: NOW }), claim('c3', 'b')],
    notes: [note('n1', 'a'), note('n2', 'b')]
  })
  let removing: ReadonlySet<string> = new Set()
  assert.equal(applyRemovals(s, removing), s)

  removing = removalReducer(removing, { type: 'remove', key: removalKey('note', 'n1') })
  removing = removalReducer(removing, { type: 'remove', key: removalKey('claim', 'c2') })
  assert.equal(removalReducer(removing, { type: 'remove', key: removalKey('claim', 'c2') }), removing)
  const shown = applyRemovals(s, removing)
  assert.deepEqual(shown.notes.map((n) => n.id), ['n2'])
  assert.deepEqual(shown.claims.map((c) => c.id), ['c1', 'c3'])
  // The team's current task falls back to its next newest claim; other teams are untouched.
  assert.deepEqual(shown.branches.map((b) => b.task), ['task c1', 'task c3'])
  assert.equal(shown.branches[1], s.branches[1])
  // A claim with the same id as a note is a different thing.
  assert.deepEqual(applyRemovals(s, new Set([removalKey('claim', 'n1')])), s)

  // The main process said no (or the call failed): it is back.
  const rolled = removalReducer(removing, { type: 'rollback', key: removalKey('note', 'n1') })
  assert.deepEqual(applyRemovals(s, rolled).notes.map((n) => n.id), ['n1', 'n2'])
  assert.equal(removalReducer(rolled, { type: 'rollback', key: removalKey('note', 'n1') }), rolled)

  // A snapshot that still has the item keeps it hidden (the answer is on its way) ...
  assert.equal(removalReducer(removing, { type: 'snapshot', snapshot: s }), removing)
  // ... and one without it settles the removal.
  const after = snap({ ...s, claims: s.claims.filter((c) => c.id !== 'c2') })
  assert.deepEqual([...removalReducer(removing, { type: 'snapshot', snapshot: after })], [removalKey('note', 'n1')])
  const none: ReadonlySet<string> = new Set()
  assert.equal(removalReducer(none, { type: 'snapshot', snapshot: s }), none)
  // Removing the only claim of a team leaves it without a task.
  assert.equal(applyRemovals(s, new Set([removalKey('claim', 'c3')])).branches[1].task, '')
})

console.log(`\n${pass} board ui tests passed`)
