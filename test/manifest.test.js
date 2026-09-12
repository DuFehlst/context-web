import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('context-web 包骨架声明合并插件契约', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.name, 'context-web')
  assert.equal(pkg.type, 'module')
  assert.ok(String(pkg.version).startsWith('0.1'), 'version 应为 0.1.x')
  // bundle patch 指向 cordis.patch.yml
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  // client 半区：web 平台 + 注入会话/视图/slots 所需服务包。
  // 0.1.5 起 dsh-client-runtime 已从内核移除，注入清单里不得再出现。
  assert.equal(pkg.dsh?.client?.platform, 'web')
  for (const required of ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-conversation']) {
    assert.ok(pkg.dsh.client.inject.includes(required), `dsh.client.inject 缺少 ${required}`)
  }
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'), '0.1.5 起 dsh-client-runtime 已移除，不应再注入')
  assert.equal(pkg.exports['./client']?.default, './lib/client.js')
  assert.ok(pkg.files.includes('lib'), 'files 应包含 lib')
  assert.ok(pkg.files.includes('app.js'), 'files 应包含 app.js')
})

test('cordis.patch.yml 以单行插件注册 context-web 并指向独立数据文件', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  assert.match(patch, /id: context-web/)
  assert.match(patch, /name: ['"]?context-web['"]?/)
  assert.match(patch, /dshHomePath\('context-web\/workspaces\.json'\)/)
})

test('LICENSE 保留两个上游插件的版权署名', async () => {
  const license = await readFile(new URL('LICENSE', root), 'utf8')
  assert.match(license, /dsh-synapse|liangmianya/i)
  assert.match(license, /dsh-agent-canvas|Lhy723/i)
})
