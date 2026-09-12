import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../index.js'

// The map only needs the canvas nodes of the DSH workspace it is about to open.
// Asking for every workspace's full detail (7 concurrent multi-MB payloads) was
// the largest avoidable request of the open-workspace path (白屏诊断 P2-6).
async function seed() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-web-lookup-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  const alpha = await store.create('工作区甲')
  const beta = await store.create('工作区乙')
  const one = await store.createThread(alpha.id, { title: '甲-会话一', dshSessionId: 'session-1' })
  await store.createThread(alpha.id, { title: '甲-会话二', dshSessionId: 'session-2' })
  await store.createThread(beta.id, { title: '乙-会话三', dshSessionId: 'session-3' })
  await store.addMessage(one.id, '只请求需要的那一个')
  return { store, alpha, beta }
}

test('returns only the canvas nodes bound to the requested DSH sessions', async () => {
  const { store } = await seed()
  const threads = await store.lookupThreads(['session-2', 'session-3'])
  assert.deepEqual(threads.map(thread => thread.dshSessionId).sort(), ['session-2', 'session-3'])
  assert.equal(threads.find(thread => thread.dshSessionId === 'session-2').title, '甲-会话二')
  assert.deepEqual(await store.lookupThreads([]), [])
  assert.deepEqual(await store.lookupThreads(['session-missing']), [])
})

test('returns a deep copy so a caller cannot mutate stored state', async () => {
  const { store } = await seed()
  const [thread] = await store.lookupThreads(['session-1'])
  assert.equal(thread.messages.length, 1)
  thread.messages[0].text = '被调用方改写'
  const [again] = await store.lookupThreads(['session-1'])
  assert.equal(again.messages[0].text, '只请求需要的那一个')
})

test('rejects a malformed sessionIds argument instead of returning everything', async () => {
  const { store } = await seed()
  await assert.rejects(() => store.lookupThreads('session-1'), /sessionIds/)
  await assert.rejects(() => store.lookupThreads([1, 2]), /sessionIds/)
})

test('the map asks for one workspace worth of threads instead of every workspace', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const lookup = app.slice(app.indexOf('async function threadsForDshWorkspace'), app.indexOf('async function openDshWorkspace'))
  assert.match(lookup, /\/context-web\/api\/threads\/lookup/)
  assert.match(lookup, /method: 'POST'/)
  assert.doesNotMatch(lookup, /state\.summaries\.map/)
})

test('exposes the lookup route and trims the sync acknowledgement', async () => {
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /path === '\/context-web\/api\/threads\/lookup' && req\.method === 'POST'/)
  assert.match(index, /threads: await store\.lookupThreads\(\(await readJson\(req\)\)\.sessionIds\)/)
  const syncStart = index.indexOf("path === '/context-web/api/sessions/sync'")
  const sync = index.slice(syncStart, index.indexOf('const messages =', syncStart))
  assert.match(sync, /synced: true/)
  assert.doesNotMatch(sync, /workspaces: await store\.syncSessions/)
})
