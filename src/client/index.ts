/**
 * context-web — 浏览器半区（合并自 dsh-synapse 与 dsh-agent-canvas，MIT）。
 * 一个模块同时注册：顶部「对话/会话地图」视图切换器 + 会话区第三个 Tab「Agent 画布」。
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import { AgentCanvasView, type AgentCanvasInjected } from './AgentCanvasView'
import { apply as applySynapseBridge } from './synapseBridge'

export const inject = ['sessions', 'workspaces', 'slots', 'locale']

export function apply(ctx: ClientContext): void {
  // 1) 会话地图桥：顶部视图切换 + /context-web/ iframe + postMessage 双向同步
  applySynapseBridge(ctx as unknown as Parameters<typeof applySynapseBridge>[0])

  // 2) Agent 画布 Tab（注册在「对话」「轨迹」之后）
  ctx.effect(() => ctx.locale.register('agentCanvas', {
    zh: { 'view.label': 'Agent 画布', refresh: '刷新' },
    en: { 'view.label': 'Agent Canvas', refresh: 'Refresh' },
  }), 'context-web: locale')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agent-canvas',
    order: 20,
    locale: 'agentCanvas',
    label: () => ctx.locale.bind('agentCanvas')('view.label'),
    inject: (sessionId: SessionId): AgentCanvasInjected => ({
      refreshSubagents: () => ctx.sessions.refreshSubagents(sessionId),
    }),
  }, AgentCanvasView))
}
