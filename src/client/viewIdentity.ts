/**
 * Agent 画布视图的身份：注册处（index.ts）与会话地图的跳转处（synapseBridge.ts）
 * 必须用同一份 id / 文案，否则「在 Agent 画布中打开」会找不到自己注册的标签。
 */
export const AGENT_CANVAS_VIEW_ID = 'agent-canvas'

export const AGENT_CANVAS_LABELS = { zh: 'Agent 画布', en: 'Agent Canvas' } as const

/** 会话头渲染出的标签文本（用于按文本定位内核的 tab 按钮）。 */
export const AGENT_CANVAS_TAB_LABELS: readonly string[] = [AGENT_CANVAS_LABELS.zh, AGENT_CANVAS_LABELS.en]
