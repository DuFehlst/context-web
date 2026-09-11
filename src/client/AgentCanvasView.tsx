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

const SIM_PARAMS_KEY = 'context-web:sim-params'

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
  // Monochrome + single accent (ui-standard §2.9): the running state is the
  // only accent; node type is carried by shape and label, never by colour.
  return node.status === 'running' ? '#2563eb' : '#64748b'
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
  const badgeBg = dark ? '#334155' : '#f1f5f9'
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
                  stroke={edge.kind === 'activity' ? '#cbd5e1' : '#94a3b8'}
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
                const statusDot = node.status === 'running' ? '#2563eb' : '#94a3b8'
                const typeLabel = node.kind === 'workflow'
                  ? 'Workflow'
                  : node.kind === 'phase'
                    ? 'Phase'
                    : 'Subagent'
                const typeBadgeBg = badgeBg
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
              style={iconButtonStyle}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 8.25C9.92893 8.25 8.25 9.92893 8.25 12C8.25 14.0711 9.92893 15.75 12 15.75C14.0711 15.75 15.75 14.0711 15.75 12C15.75 9.92893 14.0711 8.25 12 8.25ZM9.75 12C9.75 10.7574 10.7574 9.75 12 9.75C13.2426 9.75 14.25 10.7574 14.25 12C14.25 13.2426 13.2426 14.25 12 14.25C10.7574 14.25 9.75 13.2426 9.75 12Z" fill="currentColor" />
                <path fillRule="evenodd" clipRule="evenodd" d="M12 1.25C11.2954 1.25 10.6519 1.44359 9.94858 1.77037C9.26808 2.08656 8.48039 2.55304 7.49457 3.13685L6.74148 3.58283C5.75533 4.16682 4.96771 4.63324 4.36076 5.07944C3.73315 5.54083 3.25177 6.01311 2.90334 6.63212C2.55548 7.25014 2.39841 7.91095 2.32306 8.69506C2.24999 9.45539 2.24999 10.3865 2.25 11.556V12.444C2.24999 13.6135 2.24999 14.5446 2.32306 15.3049C2.39841 16.0891 2.55548 16.7499 2.90334 17.3679C3.25177 17.9869 3.73315 18.4592 4.36076 18.9206C4.96771 19.3668 5.75533 19.8332 6.74148 20.4172L7.4946 20.8632C8.48038 21.447 9.2681 21.9135 9.94858 22.2296C10.6519 22.5564 11.2954 22.75 12 22.75C12.7046 22.75 13.3481 22.5564 14.0514 22.2296C14.7319 21.9134 15.5196 21.447 16.5054 20.8632L17.2585 20.4172C18.2446 19.8332 19.0323 19.3668 19.6392 18.9206C20.2669 18.4592 20.7482 17.9869 21.0967 17.3679C21.4445 16.7499 21.6016 16.0891 21.6769 15.3049C21.75 14.5446 21.75 13.6135 21.75 12.4441V11.556C21.75 10.3866 21.75 9.45538 21.6769 8.69506C21.6016 7.91095 21.4445 7.25014 21.0967 6.63212C20.7482 6.01311 20.2669 5.54083 19.6392 5.07944C19.0323 4.63324 18.2447 4.16683 17.2585 3.58285L16.5054 3.13685C15.5196 2.55303 14.7319 2.08656 14.0514 1.77037C13.3481 1.44359 12.7046 1.25 12 1.25ZM8.22524 4.44744C9.25238 3.83917 9.97606 3.41161 10.5807 3.13069C11.1702 2.85676 11.5907 2.75 12 2.75C12.4093 2.75 12.8298 2.85676 13.4193 3.13069C14.0239 3.41161 14.7476 3.83917 15.7748 4.44744L16.4609 4.85379C17.4879 5.46197 18.2109 5.89115 18.7508 6.288C19.2767 6.67467 19.581 6.99746 19.7895 7.36788C19.9986 7.73929 20.1199 8.1739 20.1838 8.83855C20.2492 9.51884 20.25 10.378 20.25 11.5937V12.4063C20.25 13.622 20.2492 14.4812 20.1838 15.1614C20.1199 15.8261 19.9986 16.2607 19.7895 16.6321C19.581 17.0025 19.2767 17.3253 18.7508 17.712C18.2109 18.1089 17.4879 18.538 16.4609 19.1462L15.7748 19.5526C14.7476 20.1608 14.0239 20.5884 13.4193 20.8693C12.8298 21.1432 12.4093 21.25 12 21.25C11.5907 21.25 11.1702 21.1432 10.5807 20.8693C9.97606 20.5884 9.25238 20.1608 8.22524 19.5526L7.53909 19.1462C6.5121 18.538 5.78906 18.1089 5.24923 17.712C4.72326 17.3253 4.419 17.0025 4.2105 16.6321C4.00145 16.2607 3.88005 15.8261 3.81618 15.1614C3.7508 14.4812 3.75 13.622 3.75 12.4063V11.5937C3.75 10.378 3.7508 9.51884 3.81618 8.83855C3.88005 8.1739 4.00145 7.73929 4.2105 7.36788C4.419 6.99746 4.72326 6.67467 5.24923 6.288C5.78906 5.89115 6.5121 5.46197 7.53909 4.85379L8.22524 4.44744Z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="放大"
              title="放大"
              onClick={() => zoomBy(1.2)}
              style={iconButtonStyle}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M11.25 20C11.25 20.4142 11.5858 20.75 12 20.75C12.4142 20.75 12.75 20.4142 12.75 20V12.75H20C20.4142 12.75 20.75 12.4142 20.75 12C20.75 11.5858 20.4142 11.25 20 11.25H12.75V4C12.75 3.58579 12.4142 3.25 12 3.25C11.5858 3.25 11.25 3.58579 11.25 4V11.25H4C3.58579 11.25 3.25 11.5858 3.25 12C3.25 12.4142 3.58579 12.75 4 12.75H11.25V20Z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="缩小"
              title="缩小"
              onClick={() => zoomBy(1 / 1.2)}
              style={iconButtonStyle}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M20.75 12C20.75 12.4142 20.4142 12.75 20 12.75H4C3.58579 12.75 3.25 12.4142 3.25 12C3.25 11.5858 3.58579 11.25 4 11.25H20C20.4142 11.25 20.75 11.5858 20.75 12Z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="重置视图"
              title="重置视图"
              onClick={resetView}
              style={iconButtonStyle}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path fillRule="evenodd" clipRule="evenodd" d="M2.93077 11.2003C3.00244 6.23968 7.07619 2.25 12.0789 2.25C15.3873 2.25 18.287 3.99427 19.8934 6.60721C20.1103 6.96007 20.0001 7.42199 19.6473 7.63892C19.2944 7.85585 18.8325 7.74565 18.6156 7.39279C17.2727 5.20845 14.8484 3.75 12.0789 3.75C7.8945 3.75 4.50372 7.0777 4.431 11.1982L4.83138 10.8009C5.12542 10.5092 5.60029 10.511 5.89203 10.8051C6.18377 11.0991 6.18191 11.574 5.88787 11.8657L4.20805 13.5324C3.91565 13.8225 3.44398 13.8225 3.15157 13.5324L1.47176 11.8657C1.17772 11.574 1.17585 11.0991 1.46759 10.8051C1.75933 10.5111 2.2342 10.5092 2.52824 10.8009L2.93077 11.2003ZM19.7864 10.4666C20.0786 10.1778 20.5487 10.1778 20.8409 10.4666L22.5271 12.1333C22.8217 12.4244 22.8245 12.8993 22.5333 13.1939C22.2421 13.4885 21.7673 13.4913 21.4727 13.2001L21.0628 12.7949C20.9934 17.7604 16.9017 21.75 11.8825 21.75C8.56379 21.75 5.65381 20.007 4.0412 17.3939C3.82366 17.0414 3.93307 16.5793 4.28557 16.3618C4.63806 16.1442 5.10016 16.2536 5.31769 16.6061C6.6656 18.7903 9.09999 20.25 11.8825 20.25C16.0887 20.25 19.4922 16.9171 19.5625 12.7969L19.1546 13.2001C18.86 13.4913 18.3852 13.4885 18.094 13.1939C17.8028 12.8993 17.8056 12.4244 18.1002 12.1333L19.7864 10.4666Z" fill="currentColor" />
              </svg>
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
