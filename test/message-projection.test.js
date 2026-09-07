import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadMessagesFromEvents() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('const SYSTEM_INJECTED_PREFIXES')
  const end = source.indexOf('async function loadThreadHistory')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.messagesFromEvents = messagesFromEvents`, context)
  return context.globalThis.messagesFromEvents
}

test('does not turn DSH runtime context into a question card', async () => {
  const messagesFromEvents = await loadMessagesFromEvents()
  const messages = messagesFromEvents([
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nPolicy details.' }] } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '你是谁' }] } },
  ])

  assert.deepEqual(messages.map(message => message.text), ['你是谁'])
})

test('does not turn harness-injected user messages into question cards', async () => {
  const messagesFromEvents = await loadMessagesFromEvents()
  const messages = messagesFromEvents([
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-09-07T12:00:00+08:00' }] } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '<system-reminder>\nThe following workspace instructions may b…' }] } },
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: '【DSWM】有 3 条待确认记忆（~/.dsh/workspace/pending/）：' }] } },
    { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: 'Double-check before you ship: this task is brief and no doub…' }] } },
    { type: 'user/message', seq: 5, time: 5, data: { content: [{ type: 'text', text: 'Green gate: the implementation changed, but no passing test …' }] } },
    { type: 'user/message', seq: 6, time: 6, data: { content: [{ type: 'text', text: 'Red/green discipline: no failing test is on record since the…' }] } },
    { type: 'user/message', seq: 7, time: 7, data: { content: [{ type: 'text', text: '真实的用户问题' }] } },
  ])

  assert.deepEqual(messages.map(message => message.text), ['真实的用户问题'])
})
