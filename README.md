# context-web

> 单包双视图 DeepSeek Harness 插件：**会话地图** + **Agent 画布**，一次安装，两套可视化。

合并自两个 MIT 开源插件：

| 上游 | 能力 |
|---|---|
| [dsh-synapse](https://github.com/liangmianya/dsh-synapse)（liangmianya） | 会话地图：把 DSH 会话/分支投影成可拖拽画布，支持追问与 fork 双向同步 |
| [dsh-agent-canvas](https://github.com/Lhy723/dsh-agent-canvas)（Lhy723） | Agent 画布：Agent/Subagent/Workflow/Phase/工具调用的实时力导向关系图 |

## 能力一览

- 顶部「对话 / 会话地图」视图切换：会话按工作目录分组，DSH 原生 fork 血缘连线，选中文字直接追问
- 会话区第三个 Tab「Agent 画布」：运行状态实时成图，力导向参数可调、明暗主题自适应
- DSH 会话日志仍是唯一事实来源；画布元数据存 `$DSH_HOME/context-web/workspaces.json`，删除只重置画布
- 复用 DSH 现有 Web Server（路由 `/context-web/*`），不启动第二个服务进程

## 安装

```powershell
# 前置：web profile，Node.js >= 22.19.0；先卸载上游两个插件避免重复注册
dsh plugin --profile web remove dsh-synapse dsh-agent-canvas
dsh plugin --profile web add <path-to-context-web>
dsh web
```

## 开发

```powershell
npm install
npm test        # 上游迁移测试 + 骨架测试
npm run build   # host 语法检查 + client 打包（tsdown → lib/client.js）
```

## 已知限制（继承自上游）

- 「详情」视图展示的是画布投影消息（单条 ≤8000 字符，超长截断并提示）；完整会话历史以 DSH 原生会话为准。`app.js` 的 `loadThreadHistory` 为空实现，与上游 dsh-synapse v0.4.1 相同——本仓库按 spec 边界不重写上游功能，暂不扩展。
- wire 协议消息类型保留 `synapse:` 前缀（上游线协议的历史命名，测试断言依赖）。
- 仅支持 web profile；多实例共享同一 workspaces.json 为 last-writer-wins（有跨进程锁与告警，建议只跑一个实例）。

## 许可

[MIT](LICENSE)（保留 dsh-synapse 与 dsh-agent-canvas 版权署名）。
