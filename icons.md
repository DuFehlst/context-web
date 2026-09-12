# context-web 图标白名单（Reicon Outline · 2026-09-11）

> 依据 ui-standard v1.2 §2.9：状态/类型/动作用「单色 + 符号」，禁止 emoji、禁止多色语义块；图标统一取自 Reicon（MIT，24 网格，currentColor）。
> agent 选取图标时**只允许**从本表取导出名，禁止凭记忆编造；如需新语义，先经 `npx -y reicon-mcp search "<英文关键词>"` 确认导出名后再补白名单。

| 语义 | 导出名 | 形态(fill/stroke) | 使用位置 |
|---|---|---|---|
| 设置 | settings | fill | AgentCanvasView 工具栏 |
| 放大 | plus | fill | AgentCanvasView 工具栏 / app.js 画布缩放 |
| 缩小 | minus | fill | AgentCanvasView 工具栏 / app.js 画布缩放 |
| 重置视图 | refresh | fill | AgentCanvasView 工具栏 |
| 添加（通用加号） | plus | fill | app.js 添加追问 / 折叠展开 / 添加快捷词 |
| 折叠（通用减号） | minus | fill | app.js 折叠后续对话 |
| 分支 | share | fill | app.js 图分支 / 消息分支 / 创建分支 |
| 发送 | send | fill | app.js 发送追问 |
| 关闭/取消/删除 | xmark | stroke(1.5) | app.js 取消 / 删除快捷词 / 关闭卡片详情 |
| 追问/继续追问 | chat-plus | fill | app.js 追问 / 继续追问 |
| 展开/折叠（chevron） | chevron-right | stroke(1.5) | app.js 收起过程记录 |
| 整理节点 | grid | fill | app.js 画布整理 |
| 定位 | target | fill | app.js 定位到当前会话 |
| 侧边栏切换 | sidebar | fill | app.js 侧边栏切换 |
| 工作区 | folder | fill | app.js 工作区选择 |
| 归档 | archive | fill | app.js 归档此会话 |
| 查看完整会话 | home | fill | app.js 详情 |
| 在 DSH 中打开 | arrow-up-right | fill | app.js 打开 DSH |
| 新会话 | plus-circle | fill | app.js 新会话按钮 |
| 导出 Markdown 大纲 | download | fill | app.js 画布控制条（2026-09-12 补，reicon search 查证） |

## 形态约定

- **fill 式**（多数）：根 `<svg fill="none">` + 各 `path fill="currentColor"`；CSS 容器统一 `fill: currentColor`，不再设 `stroke` / `stroke-width`。
- **stroke 式**（xmark / chevron-right）：`stroke="currentColor"`，统一 `stroke-width: 1.5`（内联属性自带，勿覆盖）。
- 内联时 `path`/`line`/`polyline` 上的 `fill="currentColor"` / `stroke="currentColor"` **不得删除**；若转 `<symbol>` 雪碧图，须在 CSS 补 `.ic{fill:currentColor}`（否则图标全黑）。

## 已知假名（禁止）

triangle-alert（→ alert-triangle）、layout-grid（→ grid）、zap（→ lightning）、dots-horizontal（→ more-h）、dices（→ shuffle）。
