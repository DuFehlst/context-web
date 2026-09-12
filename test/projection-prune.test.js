import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../index.js'

// Tool payloads are the bulk of workspaces.json (measured 2026-09-12: 5.4 MB of
// call arguments + 13.5 MB of results against a 34 MB file). The cap keeps the
// canvas useful while the DSH session log stays the place for the full text.
const CAP = 2_000
const SUFFIX = '\n——…（详情查看全文）'
const LONG = 'x'.repeat(CAP + 500)

function toolSession() {
  return {
    id: 'session-long-tools', header: {}, firstLiveSeq: 0,
    events: [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '读一个大文件' }] } },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我来读。' }] } } },
      { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: LONG } },
      { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: LONG }] } } },
    ],
  }
}

test('caps one oversized tool payload as it is projected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-web-prune-write-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.projectSession(toolSession())

  const [workspace] = await store.list()
  const [thread] = (await store.get(workspace.id)).threads
  const [entry] = thread.messages[1].process
  assert.equal(entry.arguments, `${'x'.repeat(CAP)}${SUFFIX}`)
  assert.equal(entry.result, `${'x'.repeat(CAP)}${SUFFIX}`)
  assert.ok(entry.result.length < LONG.length)
})

test('prunes an oversized tool payload already persisted by an earlier version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-web-prune-load-'))
  const dataFile = join(directory, 'state.json')
  await writeFile(dataFile, JSON.stringify({
    version: 4,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w1', kind: 'dsh', cwd: 'C:\\work', title: 'DSH 任务', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      threads: [{
        id: 't1', title: '读大文件', parentId: null, dshSessionId: 's1', dshSessionTitle: null, color: '#0f766e',
        position: { x: 86, y: 82 }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        messages: [
          { id: 'm1', kind: 'user', text: '读一个大文件', at: '2026-09-01T00:00:00.000Z', sourceSeq: 0 },
          {
            id: 'm2', kind: 'assistant', text: '我来读。', at: '2026-09-01T00:00:01.000Z', turn: 1, step: 1,
            process: [{ callId: 'c1', turn: 1, step: 1, name: 'read', arguments: LONG, result: LONG, error: null }],
          },
        ],
        pendingProcess: [{ callId: 'c2', turn: 2, step: 1, name: 'bash', arguments: LONG, result: null, error: null }],
      }],
    }],
  }), 'utf8')

  const store = new WorkspaceStore(dataFile)
  const graph = await store.get('w1')
  const [entry] = graph.threads[0].messages[1].process
  const [pending] = graph.threads[0].pendingProcess
  assert.equal(entry.arguments.length, CAP + SUFFIX.length)
  assert.equal(entry.result.length, CAP + SUFFIX.length)
  assert.equal(pending.arguments.length, CAP + SUFFIX.length)

  const onDisk = JSON.parse(await readFile(dataFile, 'utf8'))
  assert.equal(onDisk.threads, undefined)
  assert.equal(onDisk.workspaces[0].threads[0].messages[1].process[0].result.length, CAP + SUFFIX.length)
})

test('does not rewrite the data file again once every payload is inside the cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-web-prune-idempotent-'))
  const dataFile = join(directory, 'state.json')
  const store = new WorkspaceStore(dataFile)
  await store.projectSession(toolSession())
  const before = (await stat(dataFile)).mtimeMs

  const second = new WorkspaceStore(dataFile)
  await second.list()
  assert.equal((await stat(dataFile)).mtimeMs, before)
})
