import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// #1 视图联动：会话地图 → 该会话的 Agent 画布标签。
// 0.1.5 内核没有导出「选中某个 conversation.view」的 API，唯一的公开入口是会话头
// 渲染出来的 tab 按钮（点击即 selectView → activateView + setView）。因此这条链路
// 靠三处约定咬合：同一份视图身份、桥的有界重试、地图的入口按钮。

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')

test('keeps one Agent Canvas identity for the registration and the jump', async () => {
  const identity = await read('src/client/viewIdentity.ts')
  const index = await read('src/client/index.ts')
  const bridge = await read('src/client/synapseBridge.ts')

  assert.match(identity, /export const AGENT_CANVAS_VIEW_ID = 'agent-canvas'/)
  assert.match(identity, /AGENT_CANVAS_LABELS = \{ zh: 'Agent 画布', en: 'Agent Canvas' \}/)
  assert.match(identity, /AGENT_CANVAS_TAB_LABELS: readonly string\[\] = \[AGENT_CANVAS_LABELS\.zh, AGENT_CANVAS_LABELS\.en\]/)

  // registration side
  assert.match(index, /import \{ AGENT_CANVAS_LABELS, AGENT_CANVAS_VIEW_ID \} from '\.\/viewIdentity'/)
  assert.match(index, /id: AGENT_CANVAS_VIEW_ID/)
  assert.match(index, /zh: \{ 'view\.label': AGENT_CANVAS_LABELS\.zh/)
  assert.match(index, /en: \{ 'view\.label': AGENT_CANVAS_LABELS\.en/)

  // jump side
  assert.match(bridge, /import \{ AGENT_CANVAS_TAB_LABELS, AGENT_CANVAS_VIEW_ID \} from '\.\/viewIdentity'/)
  assert.match(bridge, /AGENT_CANVAS_TAB_LABELS\.includes\(node\.textContent\?\.trim\(\) \?\? ''\)/)
})

test('opens the session, closes the map, then selects the canvas tab for that session', async () => {
  const bridge = await read('src/client/synapseBridge.ts')
  const jump = bridge.slice(bridge.indexOf("'synapse:open-canvas'"), bridge.indexOf("'synapse:activate-session'"))

  assert.match(jump, /ctx\.sessions\.open\(event\.data\.sessionId\)/)
  assert.match(jump, /close\(\)/)
  assert.match(jump, /selectAgentCanvasView\(event\.data\.sessionId\)/)
  assert.ok(jump.indexOf('ctx.sessions.open') < jump.indexOf('selectAgentCanvasView(event.data.sessionId)'))
  assert.match(jump, /bridge-error'[\s\S]*关联的 DSH 会话已不可用/)
})

test('verifies the selection per session instead of clicking whatever tab is rendered', async () => {
  const bridge = await read('src/client/synapseBridge.ts')
  const selector = bridge.slice(bridge.indexOf('const CANVAS_STORE_KEY'), bridge.indexOf('const onMessage'))

  // ctx.sessions.open() is synchronous, so "current === sessionId" is already true
  // on the first round while the DOM still holds the PREVIOUS session's header.
  // A quiescence window is therefore the gate, not the current-session check.
  assert.match(selector, /const QUIESCENT_ROUNDS = 2/)
  assert.match(selector, /const MAX_ROUNDS = 40/)
  assert.match(selector, /if \(switched && attempt >= QUIESCENT_ROUNDS\) \{/)
  assert.doesNotMatch(selector, /rounds >= 1/)

  // Verification is the OR of two signals: the target session's own persisted view
  // preference, and (once clicked) the rendered tab. A stale persisted value must
  // not veto a DOM-confirmed selection.
  assert.match(selector, /const CANVAS_STORE_KEY = 'dsh\.conversation'/)
  assert.match(selector, /querySelectorAll\('\[role="tab"\]'\)/)
  assert.match(selector, /if \(clicked\) \{\s*const tab = findAgentCanvasTab\(\)\s*if \(tab !== null && tab\.getAttribute\('aria-selected'\) === 'true'\) return true/)
  assert.match(selector, /localStorage\.getItem\(`\$\{CANVAS_STORE_KEY\}\.\$\{sessionId\}`\)/)
  assert.match(selector, /return stored\.view === AGENT_CANVAS_VIEW_ID/)
})

test('gives up loudly after a bounded number of rounds', async () => {
  const bridge = await read('src/client/synapseBridge.ts')
  const selector = bridge.slice(bridge.indexOf('const selectAgentCanvasView'), bridge.indexOf('const onMessage'))

  assert.match(selector, /if \(attempt >= MAX_ROUNDS\)/)
  assert.match(selector, /setTimeout\(\(\) => selectAgentCanvasView\(sessionId, attempt \+ 1, clicked\), 50\)/)
  assert.match(selector, /bridge-error'[\s\S]*未能确认切到 Agent 画布标签/)
})

test('offers the jump on a session detail and posts the linked DSH session', async () => {
  const app = await read('app.js')
  assert.match(app, /data-action="open-canvas" data-thread="\$\{thread\.id\}"/)

  const handler = app.slice(app.indexOf("if (button.dataset.action === 'open-canvas')"), app.indexOf("if (button.dataset.action === 'export-markdown')"))
  assert.match(handler, /post\('synapse:open-canvas', \{ sessionId: thread\.dshSessionId \}\)/)
  assert.match(handler, /setError\('这张卡片还没有关联的 DSH 会话'\)/)
})
