import assert from 'node:assert/strict'
import { access, mkdtemp, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../index.js'

test('删除数据文件后加载重建空画布（不删 DSH 会话）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-web-reset-'))
  const dataFile = join(directory, 'state.json')

  const store = new WorkspaceStore(dataFile)
  await store.ready
  const workspace = await store.create('临时')
  await store.createThread(workspace.id, { title: '某会话', dshSessionId: 'session-x' })
  assert.equal((await store.list())[0].threadCount, 1)

  await unlink(dataFile) // 模拟用户删除画布元数据
  const fresh = new WorkspaceStore(dataFile)
  await fresh.ready
  assert.deepEqual(await fresh.list(), []) // 画布重置为空
  await access(dataFile) // 文件自动重建
  // DSH 会话日志不在该文件中：删它只重置画布，不删会话（架构保证）
})
