/**
 * context-web — 浏览器半区（合并自 dsh-synapse 与 dsh-agent-canvas，MIT）。
 * 一个模块同时注册：顶部「对话/会话地图」视图切换器 + 会话区第三个 Tab「Agent 画布」。
 */
// 0.1.5 起客户端上下文即 cordis Context（内核移除 dsh-client-runtime 包）
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workflow-run/client'
// 0.1.5 起 slots 服务（ctx.slots）由 ui-renderer 在 cordis Context 上声明
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { AgentCanvasView, type AgentCanvasInjected } from './AgentCanvasView'
import { apply as applySynapseBridge } from './synapseBridge'
import { AGENT_CANVAS_LABELS, AGENT_CANVAS_VIEW_ID } from './viewIdentity'

export const inject = ['sessions', 'workspaces', 'slots', 'locale']

export function apply(ctx: ClientContext): void {
  // 1) 会话地图桥：顶部视图切换 + /context-web/ iframe + postMessage 双向同步
  applySynapseBridge(ctx as unknown as Parameters<typeof applySynapseBridge>[0])

  // 2) Agent 画布 Tab（注册在「对话」「轨迹」之后）
  ctx.effect(() => ctx.locale.register('agentCanvas', {
    zh: { 'view.label': AGENT_CANVAS_LABELS.zh, refresh: '刷新' },
    en: { 'view.label': AGENT_CANVAS_LABELS.en, refresh: 'Refresh' },
  }), 'context-web: locale')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: AGENT_CANVAS_VIEW_ID,
    order: 20,
    locale: 'agentCanvas',
    label: () => ctx.locale.bind('agentCanvas')('view.label'),
    inject: (sessionId: SessionId): AgentCanvasInjected => ({
      refreshSubagents: () => ctx.sessions.refreshSubagents(sessionId),
    }),
  }, AgentCanvasView))
}
