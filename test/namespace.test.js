import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

// host 侧三个文件不得残留上游品牌/路由/样式类（wire 协议 'synapse:' 前缀是文档化保留，不在此列）
test('host 侧文件无上游品牌与路由残留', async () => {
  for (const name of ['index.js', 'app.js', 'styles.css']) {
    const text = await readFile(new URL(name, root), 'utf8')
    assert.doesNotMatch(text, /Synapse/, `${name} 含大写品牌词 Synapse`)
    assert.doesNotMatch(text, /\/synapse/, `${name} 含旧路由 /synapse`)
    assert.doesNotMatch(text, /synapse-shell/, `${name} 含旧样式类 synapse-shell`)
    assert.doesNotMatch(text, /dsh-synapse/, `${name} 含旧命名空间 dsh-synapse`)
  }
  const styles = await readFile(new URL('styles.css', root), 'utf8')
  const app = await readFile(new URL('app.js', root), 'utf8')
  assert.match(styles, /\/context-web\/deepseek-mark\.svg/)
  assert.match(app, /context-web-shell/)
})
