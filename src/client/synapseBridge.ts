// 会话地图桥（迁移自 dsh-synapse client 半区，MIT，Copyright (c) 2026 liangmianya）。
// 线协议消息类型保留 'synapse:' 前缀；命名空间（路由/数据文件/localStorage/CSS 类）已改为 context-web。
import { AGENT_CANVAS_TAB_LABELS } from './viewIdentity'
const currentSession = (ctx: any) => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const id = snapshot.current
      if (id === undefined) return null
      const session = snapshot.byId[id]
      return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
    }
    const sessionSnapshot = (ctx: any) => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map((id: string) => {
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
      }).filter(Boolean)
    }
    const workspaceSnapshot = (ctx: any) => {
      const sessions = ctx.sessions.list.getSnapshot()
      const snapshot = ctx.workspaces.list.getSnapshot()
      const accounted = new Set(snapshot.items.flatMap((workspace: any) => workspace.sessionIds))
      return [
        ...snapshot.items.map((workspace: any) => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
        { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter((id: string) => !accounted.has(id)) },
      ]
    }

    export const inject = ['sessions', 'workspaces']
    export const apply = (ctx: any) => {
      const prompt = async (sessionId: string, text: string) => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
      }
      const style = document.createElement('style')
      style.textContent = '.context-web-switch{position:fixed;z-index:80;top:64px;left:50%;display:flex;gap:2px;transform:translateX(-50%);border:1px solid #d1d5db;border-radius:999px;background:#fff;padding:3px;box-shadow:0 4px 16px rgba(0,0,0,.12)}.context-web-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#6b7280;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.context-web-switch button:hover{background:#f3f4f6;color:#111827}.context-web-switch button.active{background:#111827;color:#fff}.context-web-switch button:focus-visible{outline:2px solid #111827;outline-offset:2px}.context-web-overlay{position:fixed;z-index:100;inset:0;background:#f5f7fa}.context-web-overlay.is-opening{visibility:hidden}.context-web-overlay[hidden]{display:none}.context-web-overlay iframe{display:block;width:100%;height:100%;border:0}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'context-web-host'
      host.innerHTML = '<div class="context-web-switch" role="group" aria-label="视图切换"><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="map" aria-pressed="false">会话地图</button></div><section class="context-web-overlay" hidden><iframe title="会话地图" src="/context-web/"></iframe></section>'
      document.body.append(host)
      const dialogButton = host.querySelector<HTMLButtonElement>('[data-view="dialog"]')!
      const mapButton = host.querySelector<HTMLButtonElement>('[data-view="map"]')!
      const overlay = host.querySelector<HTMLElement>('.context-web-overlay')!
      const frame = host.querySelector<HTMLIFrameElement>('iframe')!

      const setView = (view: string) => {
        const showingMap = view === 'map'
        dialogButton.classList.toggle('active', !showingMap)
        dialogButton.setAttribute('aria-pressed', String(!showingMap))
        mapButton.classList.toggle('active', showingMap)
        mapButton.setAttribute('aria-pressed', String(showingMap))
      }
      const close = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.classList.remove('is-opening')
        overlay.hidden = true
        setView('dialog')
        // Pause the map's projection polling while hidden.
        send('synapse:map-closed')
      }
      const send = (type: string, payload: Record<string, unknown> = {}) => { frame.contentWindow?.postMessage({ source: 'context-web', type, ...payload }, location.origin) }
      let syncTimer = 0
      let knownSessionIds = new Set()
      const liveUnsubscribers = new Map()
      const syncLiveSessions = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue
          const scope = ctx.sessions.scope(id)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          if (session === undefined) continue
          const publish = () => {
            if (overlay.hidden) return
            const state = session.getSnapshot()
            const text = state.partial?.blocks.filter((block: { kind?: string; text?: string }) => block.kind === 'text').map((block: { kind?: string; text?: string }) => block.text).join('\n') ?? ''
            send('synapse:live-reply', { sessionId: id, running: state.running, text })
          }
          liveUnsubscribers.set(id, session.subscribe(publish))
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id) }
      }
      const syncSessions = () => {
        // Trailing debounce: session-list mutations arrive in bursts while an
        // agent works (every streamed turn event triggers a store update), so
        // an undebounced sync POSTs once per event — an observed request storm
        // (1400+ POSTs / 6 min) against /context-web/api/sessions/sync. 2s
        // while the map is hidden (eventual consistency is fine), 300ms while
        // it is visible so an opened map starts from fresh session metadata.
        if (syncTimer !== 0) return
        const delay = overlay.hidden ? 2000 : 300
        syncTimer = window.setTimeout(() => {
          syncTimer = 0
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map((session: { id: string }) => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          void fetch('/context-web/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) }).catch(() => {})
        }, delay)
      }
      const syncTheme = () => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        send('synapse:theme', { dark })
      }
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        syncTheme()
        if (!overlay.hidden) {
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
          send('synapse:current-session', { session: currentSession(ctx) })
        }
      }
      let mapOpenFallback = 0
      let mapOpening = false
      const showMapOverlay = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.hidden = false
        overlay.classList.remove('is-opening')
        syncCurrentSession()
      }
      const open = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = true
        setView('map')
        // Keep the iframe laid out while hidden so its canvas can receive a
        // real scroll offset. display:none would clamp scrollTop back to zero.
        overlay.hidden = false
        overlay.classList.add('is-opening')
        window.requestAnimationFrame(() => {
          send('synapse:map-opened')
          syncCurrentSession()
        })
        mapOpenFallback = window.setTimeout(showMapOverlay, 300)
      }
      const onFrameLoad = () => {
        syncCurrentSession()
        // Re-announce an already-open map after an iframe reload so its poller
        // re-arms (the iframe starts with polling paused until told otherwise).
        if (mapOpening || !overlay.hidden) send('synapse:map-opened')
      }
      // 会话头自己拥有 View 选择权（0.1.5 未导出 select API），它渲染的 tab 按钮
      // 就是唯一公开入口：点击即走内核的 selectView → activateView + setView，
      // 与用户手点完全同一条路径。标签要等新会话渲染出来，故做有界重试。
      const selectAgentCanvasView = (attempt = 0) => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
        const tab = tabs.find(node => AGENT_CANVAS_TAB_LABELS.includes(node.textContent?.trim() ?? ''))
        if (tab instanceof HTMLElement) {
          tab.click()
          return
        }
        if (attempt >= 20) {
          send('synapse:bridge-error', { message: 'Agent 画布标签未就绪，已在会话中打开' })
          return
        }
        window.setTimeout(() => selectAgentCanvasView(attempt + 1), 50)
      }
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== location.origin || event.data?.source !== 'context-web') return
        if (event.data.type === 'synapse:close') return close()
        if (event.data.type === 'synapse:map-ready') return showMapOverlay()
        if (event.data.type === 'synapse:request-current') {
          send('synapse:workspaces', { workspaces: workspaceSnapshot(ctx) })
          return send('synapse:current-session', { session: currentSession(ctx) })
        }
        if (event.data.type === 'synapse:open-session') {
          try { ctx.sessions.open(event.data.sessionId); close() } catch { send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          // Best-effort anchor to the requested turn: chat nodes expose their
          // source event seq (anchorSeq) and render with data-chat-anchor-key,
          // so resolve seq -> node key -> scroll once the view materializes.
          const seq = event.data.seq
          if (Number.isInteger(seq)) {
            const tryScroll = (attempt: number) => {
              const scope = ctx.sessions.scope(event.data.sessionId)
              const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
              if (session === undefined) return
              const chat = session.getSnapshot()?.chat
              if (chat === undefined) return
              let key = undefined
              for (const node of chat.nodes.values()) {
                if (node.anchorSeq === seq) { key = node.key; break }
              }
              if (key !== undefined) {
                const row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`)
                if (row instanceof HTMLElement) row.scrollIntoView({ block: 'start' })
                return
              }
              if (attempt < 3) window.setTimeout(() => tryScroll(attempt + 1), 500)
            }
            window.setTimeout(() => tryScroll(0), 300)
          }
          return
        }
        if (event.data.type === 'synapse:open-canvas') {
          // 地图 → Agent 画布：先切会话并收起地图，再把该会话的会话区切到画布标签。
          try { ctx.sessions.open(event.data.sessionId) } catch { return send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          close()
          selectAgentCanvasView()
          return
        }
        if (event.data.type === 'synapse:activate-session') {
          // Bidirectional current-session sync: switch DSH's current session
          // without closing the map; the sessions-list subscription re-sends
          // synapse:current-session so the map follows the new highlight.
          try { ctx.sessions.open(event.data.sessionId) } catch { send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          return
        }
        if (event.data.type === 'synapse:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then((id: string) => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('synapse:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { send('synapse:bridge-error', { message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (event.data.type === 'synapse:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return send('synapse:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => {
            send('synapse:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            send('synapse:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (event.data.type === 'synapse:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then((id: string) => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('synapse:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
          }).catch(() => { send('synapse:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
        }
      }
      const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !overlay.hidden) close() }
      // Follow DSH's live theme switch: body[data-ds-dark-theme] is the web
      // client's dark-mode signal, mirrored into the map iframe via synapse:theme.
      const themeObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => syncTheme())
      if (themeObserver !== null && document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      }
      const unsubscribeSessions = ctx.sessions.list.subscribe(syncCurrentSession)
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrentSession)
      dialogButton.addEventListener('click', close)
      mapButton.addEventListener('click', open)
      frame.addEventListener('load', onFrameLoad)
      window.addEventListener('message', onMessage)
      window.addEventListener('keydown', onKeyDown)
      ctx.effect(() => () => {
        dialogButton.removeEventListener('click', close)
        mapButton.removeEventListener('click', open)
        frame.removeEventListener('load', onFrameLoad)
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onKeyDown)
        themeObserver?.disconnect()
        window.clearTimeout(syncTimer)
        unsubscribeSessions()
        unsubscribeWorkspaces()
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
        host.remove()
        style.remove()
      }, 'synapse: web workspace switch')
    }
    
