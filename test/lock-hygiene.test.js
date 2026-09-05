import assert from 'node:assert/strict'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../index.js'

test('未获锁的写入方不得删除另一个实例持有的锁', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-web-lock-'))
  const dataFile = join(directory, 'state.json')
  const lockFile = `${dataFile}.lock`

  const a = new WorkspaceStore(dataFile)
  await a.ready
  assert.equal(await a.acquireLock(), true)
  await access(lockFile) // A 持有锁

  // B 拿不到锁（告警），但它的 save() 收尾不得删掉 A 的锁
  const b = new WorkspaceStore(dataFile)
  await b.ready
  await b.save()
  await access(lockFile) // 修复前：B 的 releaseLock 无条件 unlink → 此处抛 ENOENT

  await a.releaseLock()
  await assert.rejects(access(lockFile))
})

test('持有锁的实例正常写入并释放锁', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-web-lock2-'))
  const dataFile = join(directory, 'state.json')
  const store = new WorkspaceStore(dataFile)
  await store.ready
  const workspace = await store.create('锁测试')
  await access(`${dataFile}.lock`).then(() => { throw new Error('正常写入后锁应已释放') }, () => {})
  assert.equal((await store.list()).length, 1)
  assert.equal((await store.list())[0].title, '锁测试')
})
