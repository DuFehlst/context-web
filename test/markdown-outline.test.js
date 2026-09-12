import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// #3 画布导出：会话地图 → Markdown 大纲。
// 纯函数在 app.js 内（该文件是经典脚本，不是模块），沿用 conversation-cards 测试的
// vm 切片加载方式：只取纯函数段，不拉 DOM。
async function loadOutline() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const OUTLINE_MESSAGE_LIMIT')
  const end = source.indexOf('function dshRpc')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.markdownOutline = markdownOutline;globalThis.outlineFileName = outlineFileName`, context)
  return { markdownOutline: context.globalThis.markdownOutline, outlineFileName: context.globalThis.outlineFileName }
}

const workspace = {
  id: 'w1',
  title: '插件作用分析',
  cwd: 'D:\\dev\\dsh\\dsh_0',
  threads: [
    {
      id: 't1', title: 'context-web 合并', parentId: null,
      messages: [
        { kind: 'user', text: '第一个问题' },
        { kind: 'assistant', text: '第一个回答', process: [{ callId: 'c1' }, { callId: 'c2' }] },
        { kind: 'error', text: '本轮执行失败' },
      ],
    },
    {
      id: 't2', title: '分支：追问细节', parentId: 't1',
      messages: [{ kind: 'user', text: '分支里的追问' }],
    },
    { id: 't3', title: '归档会话', parentId: null, messages: [] },
  ],
}

test('writes a workspace → thread lineage → message outline', async () => {
  const { markdownOutline } = await loadOutline()
  const text = markdownOutline(workspace)
  const lines = text.split('\n')

  assert.equal(lines[0], '# 插件作用分析')
  assert.match(text, /> 工作目录：`D:\\dev\\dsh\\dsh_0`/)
  assert.match(text, /> 共 3 条会话\/分支 · 导出时间 \d{4}-\d{2}-\d{2}T/)
  assert.ok(text.includes('\n## context-web 合并\n'), 'root thread is a level-2 heading')
  assert.ok(text.includes('\n### 分支：追问细节\n'), 'a fork indents one level deeper')
  assert.ok(text.includes('\n## 归档会话\n'), 'a second root stays at level 2')
  assert.ok(text.indexOf('## context-web 合并') < text.indexOf('### 分支：追问细节'))
  assert.ok(text.indexOf('### 分支：追问细节') < text.indexOf('## 归档会话'))
  assert.ok(text.includes('- **用户**：第一个问题'))
  assert.ok(text.includes('- **回答**（工具 2 次）：第一个回答'))
  assert.ok(text.includes('- **失败**：本轮执行失败'))
  assert.ok(text.includes('_（暂无投影消息）_'))
  assert.ok(text.endsWith('\n'))
})

test('keeps one line per message and truncates a long one', async () => {
  const { markdownOutline } = await loadOutline()
  const text = markdownOutline({
    title: '长文本',
    threads: [{ id: 't1', title: 'x', parentId: null, messages: [{ kind: 'assistant', text: `${'y'.repeat(400)}\n第二行` }] }],
  })
  const messageLine = text.split('\n').find(line => line.startsWith('- **回答**'))
  assert.ok(messageLine.length < 200)
  assert.ok(messageLine.endsWith('…'))
  assert.equal(text.split('\n').filter(line => line.startsWith('- **')).length, 1)
})

test('ignores a dangling parent pointer and still exports a cyclic pair once', async () => {
  const { markdownOutline } = await loadOutline()
  const dangling = markdownOutline({ title: 'w', threads: [{ id: 't1', title: '孤儿', parentId: 'missing', messages: [] }] })
  assert.ok(dangling.includes('## 孤儿'), 'a thread whose parent is gone is still exported as a root')

  const cyclic = markdownOutline({
    title: 'w',
    threads: [
      { id: 'a', title: '甲', parentId: 'b', messages: [] },
      { id: 'b', title: '乙', parentId: 'a', messages: [] },
    ],
  })
  // 血缘在 DSH 里是树；真出现环时既不能死循环，也不能把线程整条丢掉。
  assert.equal(cyclic.split('\n').filter(line => line.startsWith('## ')).length, 1)
  assert.ok(cyclic.includes('## ') && (cyclic.includes('甲') || cyclic.includes('乙')))
})

test('returns nothing for a missing workspace and a safe file name', async () => {
  const { markdownOutline, outlineFileName } = await loadOutline()
  assert.equal(markdownOutline(null), '')
  assert.equal(markdownOutline(undefined), '')
  const name = outlineFileName({ title: 'a/b:c*d?e' })
  assert.match(name, /^a-b-c-d-e-\d{4}-\d{2}-\d{2}\d{4}\.md$/)
})

test('wires the export button and the download handler in the map', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  assert.match(app, /<button data-action="export-markdown" title="导出 Markdown 大纲"/)
  const handler = app.slice(app.indexOf("if (button.dataset.action === 'export-markdown')"), app.indexOf("app.addEventListener('change'"))
  assert.match(handler, /setError\('当前工作区还没有可导出的内容'\)/)
  assert.match(handler, /downloadTextFile\(outlineFileName\(exportable\), markdownOutline\(exportable\)\)/)
  const download = app.slice(app.indexOf('function downloadTextFile'), app.indexOf('function render()'))
  assert.match(download, /new Blob\(\[text\], \{ type: 'text\/markdown;charset=utf-8' \}\)/)
  assert.match(download, /link\.download = fileName/)
  assert.match(download, /URL\.revokeObjectURL\(url\)/)
})
