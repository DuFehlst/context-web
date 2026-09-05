/**
 * Agent / Subagent / Workflow canvas.
 *
 * The graph is derived from the same live session data that drives the chat
 * log: `useSession` (conversation snapshot, including workflow-run chat nodes
 * and running tool calls) and `useSessions` (the session list / subagent
 * tree). Every change in the conversation feed re-renders the canvas, and
 * SVG nodes animate position/colour changes with CSS transitions.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  shallowEqual,
  type ChatConversationViewNode,
  type ConversationNode,
  type ConversationSnapshot,
  type SessionId,
  type SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    agentCanvas: AgentCanvasKey
  }
}

export type AgentCanvasKey = 'view.label' | 'refresh'

export interface AgentCanvasInjected {
  /** Refresh the current session's direct-subagent catalog from the host. */
  refreshSubagents: () => Promise<void>
}

type NodeStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
type NodeKind = 'agent' | 'subagent' | 'workflow' | 'phase' | 'tool' | 'message'

interface CanvasNode {
  id: string
  label: string
  kind: NodeKind
  status: NodeStatus
  seq: number
  subtitle?: string
}

interface CanvasEdge {
  id: string
  from: string
  to: string
  kind: 'parent' | 'workflow' | 'activity'
}

interface CanvasGraph {
  rootId: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

interface WorkflowRunChatDataLike {
  name: string
  status: NodeStatus
  phases: readonly {
    key: string
    phase: string | null
    members: readonly {
      seq: number
      label: string
      childId: string
      status: NodeStatus
    }[]
  }[]
}

const MAX_ACTIVITY_NODES = 12

const WORLD_WIDTH = 2000
const WORLD_HEIGHT = 1200
const WORLD_CENTER_X = WORLD_WIDTH / 2
const WORLD_CENTER_Y = WORLD_HEIGHT / 2
const REPULSION = 50000
const SPRING_LENGTH = 200
const SPRING_STRENGTH = 0.1
const CENTER_STRENGTH = 0.01
const DAMPING = 0.95

interface SimParams {
  repulsion: number
  springLength: number
  springStrength: number
  centerStrength: number
  damping: number
}

const DEFAULT_SIM_PARAMS: SimParams = {
  repulsion: REPULSION,
  springLength: SPRING_LENGTH,
  springStrength: SPRING_STRENGTH,
  centerStrength: CENTER_STRENGTH,
  damping: DAMPING,
}

const SIM_PARAMS_KEY = 'dsh-agent-canvas:sim-params'

function loadSimParams(): SimParams {
  const fallback = { ...DEFAULT_SIM_PARAMS }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(SIM_PARAMS_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw) as Partial<SimParams>
    return {
      repulsion: typeof parsed.repulsion === 'number' && Number.isFinite(parsed.repulsion) ? parsed.repulsion : fallback.repulsion,
      springLength: typeof parsed.springLength === 'number' && Number.isFinite(parsed.springLength) ? parsed.springLength : fallback.springLength,
      springStrength: typeof parsed.springStrength === 'number' && Number.isFinite(parsed.springStrength) ? parsed.springStrength : fallback.springStrength,
      centerStrength: typeof parsed.centerStrength === 'number' && Number.isFinite(parsed.centerStrength) ? parsed.centerStrength : fallback.centerStrength,
      damping: typeof parsed.damping === 'number' && Number.isFinite(parsed.damping) ? parsed.damping : fallback.damping,
    }
  } catch {
    return fallback
  }
}

function saveSimParams(params: SimParams): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SIM_PARAMS_KEY, JSON.stringify(params))
  } catch {
    // Storage can be unavailable/blocked; persistence is best-effort.
  }
}

function previewOf(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
}

function textOfBlocks(blocks: readonly { kind?: string; type?: string; text?: string }[]): string {
  return blocks
    .map(block => {
      if (block.kind === 'text') return block.text ?? ''
      if (block.type === 'text') return block.text ?? ''
      return ''
    })
    .join(' ')
}

function activityLabel(node: ConversationNode): string {
  switch (node.kind) {
    case 'user':
      return `用户: ${previewOf(textOfBlocks(node.content as readonly { kind?: string; type?: string; text?: string }[]))}`
    case 'assistant':
      return `助手: ${previewOf(textOfBlocks(node.blocks as readonly { kind?: string; type?: string; text?: string }[]))}`
    case 'tool-result':
      return `工具: ${node.call?.name ?? node.callId}`
    case 'command':
      return `命令: /${node.name ?? ''}`
    default:
      return node.kind
  }
}

function statusOfNode(status: NodeStatus): NodeStatus {
  return status
}

function buildGraph(
  sessionId: SessionId,
  session: ConversationSnapshot,
  sessions: SessionListState,
): CanvasGraph {
  const nodes = new Map<string, CanvasNode>()
  const edges: CanvasEdge[] = []

  const root = sessions.byId[sessionId]
  nodes.set(sessionId, {
    id: sessionId,
    label: root?.displayTitle ?? 'Agent',
    kind: 'agent',
    status: session.running ? 'running' : 'completed',
    seq: 0,
    subtitle: session.running ? '运行中' : '空闲',
  })

  // Workflow members must hang under their workflow, not also under the root
  // agent. Collect them first so direct-subagent edges can skip them.
  const workflowMemberIds = new Set<string>()
  for (const node of session.chat.nodes.values()) {
    if (node.kind !== 'workflow-run') continue
    const data = node.data as unknown as WorkflowRunChatDataLike
    for (const phase of data.phases) {
      for (const member of phase.members) workflowMemberIds.add(member.childId)
    }
  }

  // Direct subagents from the session list (already refreshed by the web app).
  // Prefer the catalog label (the short subagent name) over displayTitle,
  // which may be the full prompt text.
  const subagentLabelById = new Map<string, string>()
  for (const entry of sessions.subagentsByParent[sessionId]?.entries ?? []) {
    if (entry.kind === 'child') subagentLabelById.set(entry.id, entry.label ?? entry.id)
  }

  // If a subagent is a workflow member, it gets only the workflow edge below.
  for (const row of Object.values(sessions.byId)) {
    if (row.parentId !== sessionId || row.origin !== 'subagent') continue
    const name = subagentLabelById.get(row.id) ?? row.displayTitle
    const task = row.title !== undefined && row.title !== name
      ? row.title
      : subagentLabelById.has(row.id) && subagentLabelById.get(row.id) !== row.displayTitle
        ? row.displayTitle
        : undefined
    const subtitle = `${row.running ? '运行中' : '空闲'}${task !== undefined ? ` · ${task}` : ''}`
    nodes.set(row.id, {
      id: row.id,
      label: name,
      kind: 'subagent',
      status: row.running ? 'running' : 'completed',
      seq: 1,
      subtitle,
    })
    if (workflowMemberIds.has(row.id)) continue
    edges.push({ id: `edge:${sessionId}:${row.id}`, from: sessionId, to: row.id, kind: 'parent' })
  }

  // Workflow runs: the web client already folds `tool-workflow/*` events into
  // `workflow-run` chat nodes, so this stays in sync with the conversation log.
  const workflowNodes = session.chat.nodes
    .values()
    .filter((node): node is ChatConversationViewNode & { kind: 'workflow-run' } => node.kind === 'workflow-run')

  for (const node of workflowNodes) {
    const wfId = `workflow:${node.id}`
    const data = node.data as unknown as WorkflowRunChatDataLike
    const totalMembers = data.phases.reduce((sum, phase) => sum + phase.members.length, 0)
    nodes.set(wfId, {
      id: wfId,
      label: data.name || 'Workflow',
      kind: 'workflow',
      status: statusOfNode(data.status),
      seq: node.anchorSeq,
      subtitle: `${data.status} · ${totalMembers} members`,
    })
    edges.push({ id: `edge:${sessionId}:${wfId}`, from: sessionId, to: wfId, kind: 'workflow' })

    for (const phase of data.phases) {
      if (phase.members.length === 0) continue
      const phaseId = `${wfId}:phase:${phase.key}`
      const phaseLabel = phase.phase === null
        ? '未分组'
        : phase.phase === ''
          ? '(空)'
          : phase.phase
      nodes.set(phaseId, {
        id: phaseId,
        label: phaseLabel,
        kind: 'phase',
        status: phase.members.some(member => member.status === 'running') ? 'running' : 'completed',
        seq: node.anchorSeq,
        subtitle: `${phase.members.length} agents`,
      })
      edges.push({ id: `edge:${wfId}:${phaseId}`, from: wfId, to: phaseId, kind: 'workflow' })

      for (const member of phase.members) {
        const memberId = member.childId
        const row = sessions.byId[memberId as SessionId]
        const task = row?.title !== undefined
          ? row.title
          : row !== undefined && row.displayTitle !== member.label
            ? row.displayTitle
            : undefined
        const subtitle = `${member.status}${task !== undefined ? ` · ${task}` : ''}`
        nodes.set(memberId, {
          id: memberId,
          label: member.label || member.childId,
          kind: 'subagent',
          status: statusOfNode(member.status),
          seq: 1,
          subtitle,
        })
        edges.push({ id: `edge:${phaseId}:${memberId}`, from: phaseId, to: memberId, kind: 'workflow' })
      }
    }
  }

  // In-flight tool calls of the current agent.
  for (const call of session.runningCalls) {
    const id = `tool:${call.callId}`
    nodes.set(id, {
      id,
      label: call.name,
      kind: 'tool',
      status: 'running',
      seq: 2,
      subtitle: '运行中',
    })
    edges.push({ id: `edge:${sessionId}:${id}`, from: sessionId, to: id, kind: 'activity' })
  }

  // Recent tool results as compact leaf nodes, so the canvas still tracks the
  // tool-call side of the conversation log without flooding the graph with
  // user/assistant message nodes.
  const recentTools = session.nodes
    .filter((node): node is Extract<ConversationNode, { kind: 'tool-result' }> => node.kind === 'tool-result')
    .slice(-MAX_ACTIVITY_NODES)

  for (const node of recentTools) {
    const id = `activity:${node.seq}`
    if (nodes.has(id)) continue
    nodes.set(id, {
      id,
      label: `工具: ${node.call?.name ?? node.callId}`,
      kind: 'tool',
      status: 'completed',
      seq: node.seq,
      subtitle: '已完成',
    })
    edges.push({ id: `edge:${sessionId}:${id}`, from: sessionId, to: id, kind: 'activity' })
  }

  return {
    rootId: sessionId,
    nodes: [...nodes.values()],
    edges,
  }
}

interface Point {
  x: number
  y: number
}

function layoutGraph(graph: CanvasGraph): Record<string, Point> {
  const children = new Map<string, string[]>()
  const seenChild = new Set<string>()
  for (const edge of graph.edges) {
    if (seenChild.has(edge.to)) continue
    seenChild.add(edge.to)
    const list = children.get(edge.from) ?? []
    list.push(edge.to)
    children.set(edge.from, list)
  }

  const subtreeSize = new Map<string, number>()
  const sizeOf = (id: string): number => {
    const cached = subtreeSize.get(id)
    if (cached !== undefined) return cached
    let size = 1
    for (const child of children.get(id) ?? []) size += sizeOf(child)
    subtreeSize.set(id, size)
    return size
  }

  const positions: Record<string, Point> = {}
  const HORIZONTAL_PAD = 90
  const VERTICAL_GAP = 110
  const totalWidth = Math.max(360, sizeOf(graph.rootId) * HORIZONTAL_PAD)

  const layout = (id: string, left: number, right: number, depth: number): void => {
    const kids = children.get(id) ?? []
    const y = 60 + depth * VERTICAL_GAP
    if (kids.length === 0) {
      positions[id] = { x: (left + right) / 2, y }
      return
    }
    const totalSize = kids.reduce((sum, kid) => sum + sizeOf(kid), 0)
    let cursor = left
    for (const kid of kids) {
      const width = (right - left) * (sizeOf(kid) / totalSize)
      layout(kid, cursor, cursor + width, depth + 1)
      cursor += width
    }
    const xs = kids.map(kid => positions[kid]?.x ?? (left + right) / 2)
    positions[id] = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y }
  }

  layout(graph.rootId, 0, totalWidth, 0)

  // Defensive fallback for any unreachable node.
  for (const node of graph.nodes) {
    if (positions[node.id] !== undefined) continue
    positions[node.id] = { x: totalWidth / 2, y: 60 + graph.nodes.length * VERTICAL_GAP }
  }

  return positions
}

function stepSimulation(
  graph: CanvasGraph,
  positions: Record<string, Point>,
  velocities: Record<string, { vx: number; vy: number }>,
  alpha: number,
  params: SimParams,
  fixedId: string | null = null,
): void {
  const { nodes, edges } = graph
  for (const node of nodes) {
    if (node.id === fixedId) continue
    const a = positions[node.id]
    if (a === undefined) continue
    let fx = 0
    let fy = 0

    for (const other of nodes) {
      if (other.id === node.id) continue
      const b = positions[other.id]
      if (b === undefined) continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      const force = (params.repulsion / (dist * dist)) * alpha
      fx += (dx / dist) * force
      fy += (dy / dist) * force
    }

    for (const edge of edges) {
      if (edge.from !== node.id && edge.to !== node.id) continue
      const otherId = edge.from === node.id ? edge.to : edge.from
      const b = positions[otherId]
      if (b === undefined) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      const force = (dist - params.springLength) * params.springStrength * alpha
      fx += (dx / dist) * force
      fy += (dy / dist) * force
    }

    fx += (WORLD_CENTER_X - a.x) * params.centerStrength * alpha
    fy += (WORLD_CENTER_Y - a.y) * params.centerStrength * alpha

    const v = velocities[node.id] ?? { vx: 0, vy: 0 }
    v.vx = (v.vx + fx) * params.damping
    v.vy = (v.vy + fy) * params.damping
    velocities[node.id] = v
    a.x += v.vx
    a.y += v.vy
  }
}

function colourFor(node: CanvasNode): string {
  if (node.status === 'running') {
    return node.kind === 'workflow' ? '#2563eb' : '#16a34a'
  }
  if (node.status === 'failed') return '#dc2626'
  if (node.status === 'cancelled' || node.status === 'interrupted') return '#d97706'
  switch (node.kind) {
    case 'agent': return '#0f172a'
    case 'subagent': return '#64748b'
    case 'workflow': return '#4d6bfe'
    case 'phase': return '#8b5cf6'
    case 'tool': return '#0e7490'
    default: return '#94a3b8'
  }
}

const CANVAS_CSS = `
@keyframes agent-canvas-node-in {
  from { opacity: 0; transform: scale(0.6); }
  to { opacity: 1; transform: scale(1); }
}
`

interface ViewState {
  x: number
  y: number
  k: number
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
} | null

const MIN_SCALE = 0.2
const MAX_SCALE = 5

export function AgentCanvasView({
  sessionId,
  useSession,
  useSessions,
  refreshSubagents,
  t,
}: ConvViewProps & AgentCanvasInjected & PropsLocale<'agentCanvas'>) {
  const session = useSession(snapshot => snapshot)
  const sessions = useSessions(snapshot => snapshot, shallowEqual)

  const graph = useMemo(
    () => buildGraph(sessionId, session, sessions),
    [sessionId, session, sessions],
  )
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, k: 1 })
  const [dragging, setDragging] = useState(false)
  const [draggingNode, setDraggingNode] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<DragState>(null)
  const dragNodeRef = useRef<string | null>(null)
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null)

  const [positions, setPositions] = useState<Record<string, Point>>({})
  const positionsRef = useRef<Record<string, Point>>({})
  const velocitiesRef = useRef<Record<string, { vx: number; vy: number }>>({})
  const alphaRef = useRef(1)

  const [params, setParamsState] = useState<SimParams>(() => loadSimParams())
  const paramsRef = useRef(params)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [simEpoch, setSimEpoch] = useState(0)
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme'),
  )

  useEffect(() => {
    const update = () => setDark(document.body.hasAttribute('data-ds-dark-theme'))
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    update()
    return () => observer.disconnect()
  }, [])

  const updateParam = (key: keyof SimParams, value: number) => {
    const next = { ...paramsRef.current, [key]: value }
    paramsRef.current = next
    setParamsState(next)
    saveSimParams(next)
    alphaRef.current = 0.5
    setSimEpoch(epoch => epoch + 1)
  }

  // Initialize / extend positions when the graph changes.
  // Use a stable tree layout, then run a silent warm-up so the visible start
  // is already mostly settled instead of exploding from a chaotic scatter.
  useEffect(() => {
    const initialLayout = layoutGraph(graph)
    const next: Record<string, Point> = { ...positionsRef.current }
    const velocities: Record<string, { vx: number; vy: number }> = { ...velocitiesRef.current }
    graph.nodes.forEach((node) => {
      if (next[node.id] !== undefined) return
      const seed = initialLayout[node.id]
      next[node.id] = seed ?? { x: WORLD_CENTER_X, y: WORLD_CENTER_Y }
      velocities[node.id] = { vx: 0, vy: 0 }
    })

    // Silent warm-up: let the force model settle before the first paint.
    let warmAlpha = 0.3
    for (let i = 0; i < 80; i += 1) {
      stepSimulation(graph, next, velocities, warmAlpha, paramsRef.current)
      warmAlpha *= 0.96
    }

    positionsRef.current = next
    velocitiesRef.current = velocities
    setPositions(next)
    alphaRef.current = 0.05
  }, [graph])

  // Force-directed simulation loop.
  useEffect(() => {
    let raf = 0
    let alpha = alphaRef.current

    const tick = () => {
      const nodes = graph.nodes
      const edges = graph.edges
      const pos = positionsRef.current
      const vel = velocitiesRef.current
      const fixedId = dragNodeRef.current
      const p = paramsRef.current

      for (const node of nodes) {
        if (node.id === fixedId) continue
        const a = pos[node.id]
        if (a === undefined) continue
        let fx = 0
        let fy = 0

        for (const other of nodes) {
          if (other.id === node.id) continue
          const b = pos[other.id]
          if (b === undefined) continue
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dist = Math.max(1, Math.hypot(dx, dy))
          const force = (p.repulsion / (dist * dist)) * alpha
          fx += (dx / dist) * force
          fy += (dy / dist) * force
        }

        for (const edge of edges) {
          if (edge.from !== node.id && edge.to !== node.id) continue
          const otherId = edge.from === node.id ? edge.to : edge.from
          const b = pos[otherId]
          if (b === undefined) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.max(1, Math.hypot(dx, dy))
          const force = (dist - p.springLength) * p.springStrength * alpha
          fx += (dx / dist) * force
          fy += (dy / dist) * force
        }

        fx += (WORLD_CENTER_X - a.x) * p.centerStrength * alpha
        fy += (WORLD_CENTER_Y - a.y) * p.centerStrength * alpha

        const v = vel[node.id] ?? { vx: 0, vy: 0 }
        v.vx = (v.vx + fx) * p.damping
        v.vy = (v.vy + fy) * p.damping
        vel[node.id] = v
        a.x += v.vx
        a.y += v.vy
      }

      positionsRef.current = { ...pos }
      setPositions(positionsRef.current)

      alpha *= 0.985
      alphaRef.current = alpha
      if (alpha > 0.003 || dragNodeRef.current !== null) {
        raf = requestAnimationFrame(tick)
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [graph, simEpoch])

  const toUserPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (svg === null) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: (clientX - rect.left) * (WORLD_WIDTH / rect.width),
      y: (clientY - rect.top) * (WORLD_HEIGHT / rect.height),
    }
  }

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const point = toUserPoint(clientX, clientY)
    setView(current => {
      const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.k * factor))
      const ratio = k / current.k
      return {
        k,
        x: point.x - (point.x - current.x) * ratio,
        y: point.y - (point.y - current.y) * ratio,
      }
    })
  }

  const zoomBy = (factor: number) => {
    const svg = svgRef.current
    if (svg === null) return
    const rect = svg.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    zoomAt(event.clientX, event.clientY, factor)
  }

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<Element>) => {
    const nodeId = dragNodeRef.current
    if (nodeId !== null) {
      const point = toUserPoint(event.clientX, event.clientY)
      const offset = dragOffsetRef.current ?? { dx: 0, dy: 0 }
      const next = { x: point.x + offset.dx, y: point.y + offset.dy }
      positionsRef.current = { ...positionsRef.current, [nodeId]: next }
      setPositions(positionsRef.current)
      return
    }

    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const currentPoint = toUserPoint(event.clientX, event.clientY)
    const startPoint = toUserPoint(drag.startX, drag.startY)
    setView(current => ({
      ...current,
      x: drag.originX + (currentPoint.x - startPoint.x),
      y: drag.originY + (currentPoint.y - startPoint.y),
    }))
  }

  const handlePointerUp = (event: ReactPointerEvent<Element>) => {
    if (dragNodeRef.current !== null) {
      dragNodeRef.current = null
      dragOffsetRef.current = null
      setDraggingNode(null)
      alphaRef.current = 0.6
      setSimEpoch(epoch => epoch + 1)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      return
    }

    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleNodePointerDown = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    event.stopPropagation()
    if (event.pointerType === 'mouse' && event.button !== 0) return
    alphaRef.current = 1
    dragNodeRef.current = nodeId
    setDraggingNode(nodeId)
    setSimEpoch(epoch => epoch + 1)
    const point = toUserPoint(event.clientX, event.clientY)
    const current = positionsRef.current[nodeId]
    dragOffsetRef.current = current === undefined
      ? { dx: 0, dy: 0 }
      : { dx: current.x - point.x, dy: current.y - point.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const resetView = () => setView({ x: 0, y: 0, k: 1 })

  const iconButtonStyle = {
    width: 32,
    height: 32,
    borderRadius: 6,
    border: '1px solid #cbd5e1',
    background: dark ? '#1e293b' : '#ffffff',
    color: dark ? '#e2e8f0' : '#0f172a',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    boxShadow: '0 1px 2px rgb(0 0 0 / 0.08)',
  }

  const canvasBg = dark ? '#0f172a' : '#fbfdff'
  const cardBg = dark ? '#1e293b' : '#ffffff'
  const cardBorder = dark ? '#334155' : '#e2e8f0'
  const cardText = dark ? '#f1f5f9' : '#1e293b'
  const cardSubtext = dark ? '#cbd5e1' : '#64748b'
  const headerDivider = dark ? '#334155' : '#f1f5f9'
  const badgeBgWorkflow = dark ? '#1e3a8a' : '#dbeafe'
  const badgeBgPhase = dark ? '#4c1d95' : '#ede9fe'
  const badgeBgSubagent = dark ? '#334155' : '#f1f5f9'
  const panelBg = dark ? '#1e293b' : '#ffffff'
  const panelBorder = dark ? '#334155' : '#e2e8f0'
  const panelText = dark ? '#e2e8f0' : '#0f172a'

  return (
    <div style={{ height: '100%', minHeight: 480, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px 4px' }}>
        <span style={{ color: dark ? '#cbd5e1' : '#64748b', fontSize: 12 }}>
          {graph.nodes.length} nodes · {graph.edges.length} edges
        </span>
        <span style={{ color: dark ? '#94a3b8' : '#94a3b8', fontSize: 12 }}>
          滚轮缩放 · 背景拖拽平移 · 节点可拖动
        </span>
      </div>

      <div style={{ position: 'relative', flex: 1, overflow: 'hidden', margin: 8 }}>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          style={{
            display: 'block',
            background: canvasBg,
            borderRadius: 8,
            border: `1px solid ${cardBorder}`,
            touchAction: 'none',
            cursor: dragging ? 'grabbing' : 'grab',
          }}
        >
          <style>{CANVAS_CSS}</style>

          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {graph.edges.map(edge => {
              const from = positions[edge.from]
              const to = positions[edge.to]
              if (from === undefined || to === undefined) return null
              return (
                <line
                  key={edge.id}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={edge.kind === 'workflow' ? '#4d6bfe' : edge.kind === 'parent' ? '#94a3b8' : '#cbd5e1'}
                  strokeWidth={1.5}
                  strokeDasharray={edge.kind === 'activity' ? '4 4' : undefined}
                  style={{ opacity: 0.7, transition: 'opacity 0.4s' }}
                />
              )
            })}

            {graph.nodes.map(node => {
              const point = positions[node.id]
              if (point === undefined) return null
              const fill = colourFor(node)
              const isRect = node.kind === 'subagent' || node.kind === 'workflow' || node.kind === 'phase'

              if (isRect) {
                const width = Math.min(220, Math.max(160, node.label.length * 7 + 56))
                const height = 78
                const accent = fill
                const statusDot = node.status === 'running'
                  ? '#22c55e'
                  : node.status === 'failed'
                    ? '#ef4444'
                    : node.status === 'cancelled' || node.status === 'interrupted'
                      ? '#f59e0b'
                      : '#94a3b8'
                const typeLabel = node.kind === 'workflow'
                  ? 'Workflow'
                  : node.kind === 'phase'
                    ? 'Phase'
                    : 'Subagent'
                const typeBadgeBg = node.kind === 'workflow'
                  ? badgeBgWorkflow
                  : node.kind === 'phase'
                    ? badgeBgPhase
                    : badgeBgSubagent
                return (
                  <g
                    key={node.id}
                    transform={`translate(${point.x}, ${point.y})`}
                    onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    style={{
                      cursor: draggingNode === node.id ? 'grabbing' : 'grab',
                      animation: 'agent-canvas-node-in 0.4s ease',
                    }}
                  >
                    <rect
                      x={-width / 2}
                      y={-height / 2}
                      width={width}
                      height={height}
                      rx={12}
                      ry={12}
                      fill={cardBg}
                      stroke={cardBorder}
                      strokeWidth={1.5}
                      style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.08))' }}
                    />
                    {node.status === 'running' && (
                      <rect
                        x={-width / 2}
                        y={-height / 2}
                        width={width}
                        height={height}
                        rx={12}
                        ry={12}
                        fill="none"
                        stroke={accent}
                        strokeWidth={2}
                        opacity={0.6}
                      >
                        <animate attributeName="opacity" values="0.6;0" dur="1.2s" repeatCount="indefinite" />
                      </rect>
                    )}
                    <foreignObject
                      x={-width / 2}
                      y={-height / 2}
                      width={width}
                      height={height}
                      style={{ overflow: 'hidden', borderRadius: 12, pointerEvents: 'auto' }}
                    >
                      <div
                        style={{
                          width: '100%',
                          height: '100%',
                          boxSizing: 'border-box',
                          background: cardBg,
                          borderRadius: 12,
                          overflow: 'hidden',
                          display: 'flex',
                          flexDirection: 'row',
                        }}
                      >
                        <div style={{ width: 4, background: accent, flexShrink: 0 }} />
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '7px 9px 6px',
                              borderBottom: `1px solid ${headerDivider}`,
                              flexShrink: 0,
                            }}
                          >
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: statusDot,
                                boxShadow: '0 0 0 1px #e2e8f0',
                                flexShrink: 0,
                              }}
                            />
                            <span
                              style={{
                                padding: '1px 6px',
                                borderRadius: 6,
                                background: typeBadgeBg,
                                color: accent,
                                fontSize: 9,
                                fontWeight: 700,
                                lineHeight: '14px',
                                flexShrink: 0,
                                textTransform: 'uppercase',
                                letterSpacing: '0.02em',
                              }}
                            >
                              {typeLabel}
                            </span>
                            <span
                              style={{
                                fontWeight: 600,
                                fontSize: 12,
                                color: cardText,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                userSelect: 'none',
                                flex: 1,
                              }}
                            >
                              {node.label}
                            </span>
                          </div>
                          <div
                            onWheel={(event) => event.stopPropagation()}
                            style={{
                              padding: '5px 9px 7px',
                              fontSize: 10,
                              lineHeight: 1.4,
                              color: cardSubtext,
                              overflowY: 'auto',
                              flex: 1,
                              minHeight: 0,
                            }}
                          >
                            {node.subtitle ?? ''}
                          </div>
                        </div>
                      </div>
                    </foreignObject>
                  </g>
                )
              }

              const radius = node.kind === 'agent' ? 22 : 12
              return (
                <g
                  key={node.id}
                  transform={`translate(${point.x}, ${point.y})`}
                  onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  style={{
                    cursor: draggingNode === node.id ? 'grabbing' : 'grab',
                    animation: 'agent-canvas-node-in 0.4s ease',
                  }}
                >
                  <circle
                    r={radius}
                    fill={fill}
                    stroke="#ffffff"
                    strokeWidth={2}
                    style={{ transition: 'fill 0.3s' }}
                  />
                  {node.status === 'running' && (
                    <circle r={radius} fill="none" stroke={fill} strokeWidth={2} opacity={0.7}>
                      <animate attributeName="r" values={`${radius};${radius + 10}`} dur="1.2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.7;0" dur="1.2s" repeatCount="indefinite" />
                    </circle>
                  )}
                  <text
                    y={node.kind === 'agent' ? 40 : 31}
                    textAnchor="middle"
                    fontSize={node.kind === 'agent' ? 14 : 12}
                    fill={cardText}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {node.label}
                  </text>
                  {node.subtitle !== undefined && (
                    <text
                      y={node.kind === 'agent' ? 54 : 45}
                      textAnchor="middle"
                      fontSize={10}
                      fill={cardSubtext}
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {node.subtitle}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>

        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            <button
              type="button"
              aria-label="力导向设置"
              title="力导向设置"
              onClick={() => setSettingsOpen(open => !open)}
              style={{ ...iconButtonStyle, fontSize: 15 }}
            >
              ⚙
            </button>
            <button
              type="button"
              aria-label="放大"
              title="放大"
              onClick={() => zoomBy(1.2)}
              style={iconButtonStyle}
            >
              +
            </button>
            <button
              type="button"
              aria-label="缩小"
              title="缩小"
              onClick={() => zoomBy(1 / 1.2)}
              style={iconButtonStyle}
            >
              −
            </button>
            <button
              type="button"
              aria-label="重置视图"
              title="重置视图"
              onClick={resetView}
              style={{ ...iconButtonStyle, fontSize: 12 }}
            >
              ⟳
            </button>
          </div>

          {settingsOpen && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                right: 44,
                width: 240,
                background: panelBg,
                border: `1px solid ${panelBorder}`,
                borderRadius: 10,
                padding: 12,
                boxShadow: '0 4px 16px rgb(0 0 0 / 0.12)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: panelText }}>力导向设置</div>

              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: panelText }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>向心力</span>
                  <span>{params.centerStrength.toFixed(4)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={0.03}
                  step={0.001}
                  value={params.centerStrength}
                  onChange={event => updateParam('centerStrength', Number(event.target.value))}
                  style={{ width: '100%' }}
                />
              </label>

              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: panelText }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>节点排斥力</span>
                  <span>{params.repulsion}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100000}
                  step={1000}
                  value={params.repulsion}
                  onChange={event => updateParam('repulsion', Number(event.target.value))}
                  style={{ width: '100%' }}
                />
              </label>

              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: panelText }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>连线吸引力</span>
                  <span>{params.springStrength.toFixed(4)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={0.2}
                  step={0.001}
                  value={params.springStrength}
                  onChange={event => updateParam('springStrength', Number(event.target.value))}
                  style={{ width: '100%' }}
                />
              </label>

              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: panelText }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>连线自然距离</span>
                  <span>{params.springLength}</span>
                </div>
                <input
                  type="range"
                  min={80}
                  max={500}
                  step={10}
                  value={params.springLength}
                  onChange={event => updateParam('springLength', Number(event.target.value))}
                  style={{ width: '100%' }}
                />
              </label>

              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: panelText }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>阻尼</span>
                  <span>{params.damping.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={1}
                  step={0.01}
                  value={params.damping}
                  onChange={event => updateParam('damping', Number(event.target.value))}
                  style={{ width: '100%' }}
                />
              </label>

              <button
                type="button"
                onClick={() => {
                  const next = { ...DEFAULT_SIM_PARAMS }
                  paramsRef.current = next
                  setParamsState(next)
                  saveSimParams(next)
                }}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: `1px solid ${dark ? '#334155' : '#cbd5e1'}`,
                  background: dark ? '#0f172a' : '#f8fafc',
                  color: dark ? '#e2e8f0' : '#0f172a',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                恢复默认
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
