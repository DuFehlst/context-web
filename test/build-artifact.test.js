import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('client 打包产物注册 context-web 模块并包含双视图注入', async () => {
  const bundle = await readFile(new URL('lib/client.js', root), 'utf8')
  // 模块注册 id = 包名（DSH 客户端加载协议）
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{\s*id: ['"]context-web['"]/)
  // 双视图：会话地图桥（线协议保留 synapse: 前缀）+ Agent 画布 Tab
  assert.match(bundle, /synapse:map-opened/)
  assert.match(bundle, /synapse:fork-session/)
  assert.match(bundle, /conversation\.view/)
  assert.match(bundle, /Agent 画布|Agent Canvas/)
  // 主题与数据路径命名空间
  assert.match(bundle, /data-ds-dark-theme/)
  assert.match(bundle, /\/context-web\/api\/sessions\/sync/)
  // 统一 localStorage 命名空间，无上游残留
  assert.match(bundle, /context-web:sim-params/)
  assert.doesNotMatch(bundle, /dsh-synapse/)
  assert.doesNotMatch(bundle, /dsh-agent-canvas:sim-params/)
})
