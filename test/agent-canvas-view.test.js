import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

// AgentCanvasView 合并后保留核心图构建/仿真逻辑（结构断言，与上游自测风格一致；
// 完整行为验证依赖浏览器运行环境，见 delivery.md 的残余风险）。
test('AgentCanvasView 保留图构建与力导向仿真核心', async () => {
  const source = await readFile(new URL('src/client/AgentCanvasView.tsx', root), 'utf8')

  assert.match(source, /const SIM_PARAMS_KEY = 'context-web:sim-params'/)
  assert.match(source, /const MAX_ACTIVITY_NODES = 12/)
  assert.match(source, /slice\(-MAX_ACTIVITY_NODES\)/)
  assert.match(source, /function buildGraph\(/)
  assert.match(source, /function layoutGraph\(/)
  assert.match(source, /function stepSimulation\(/)
  assert.match(source, /function colourFor\(/)
  assert.match(source, /workflowMemberIds\.has\(row\.id\)/)
  assert.match(source, /session\.runningCalls/)
  assert.match(source, /data-ds-dark-theme/)
  assert.doesNotMatch(source, /dsh-agent-canvas/)
  assert.doesNotMatch(source, /dsh-synapse/)
})
