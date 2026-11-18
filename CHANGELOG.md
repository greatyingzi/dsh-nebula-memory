# 更新日志 / Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。每个版本固定三段：**改动明细 / 升级影响 / 最佳配置建议**——其他端安装或升级前先看这里，再决定配置。

> 安装方式与配置全集见 [README](README.md)。发布页（Releases）与本章保持同步；有出入以本章为准。

---

## [Unreleased]

（无）

## [1.4.1] — 2026-11-18

### Fixed

- 双重降权：服务端已在 /api/memories/search 应用 feedback_factor，客户端改为只重排不再乘（0.6→0.36 的问题）。
- 两端 token 规则统一：服务端 CJK bigram 改为按连续段切分，与客户端一致（此前 Rust 多出「练利/率但/着阈」等跨段 bigram）。
- 服务端 feedback_factor 由百分数改回原始小数，供客户端识别。

## [1.4.0] — 2026-11-18

### Added — 检索负反馈闭环（recap 打分 → 按主题条件降权）

- **recap 轮逐条打分**：`nebula_recap_return` 工具新增 `ratings` 参数（数组 `{id, score 0..1}`）。recap prompt 列出本轮注入的知识（id + 相似度 + 220 字摘要），要求逐条给用处分：1=确实帮上 / 0.5=有点相关但没帮上 / 0=完全没用或误导。只接受本轮真实注入的 id，防模型幻觉。
- **按查询主题条件降权**：本地 `~/.dsh/nebula-feedback.jsonl` 记评分与主题 token（ASCII 复合词 + CJK bigram）；召回时对同一记忆、主题 Jaccard ≥0.3 的历史评分做乘法衰减（负 0.6 / 正 1.25，下限 0.12），降权重排后再取 top-3——被判没用的让位给其他候选，换主题不误伤。
- **显式反馈工具** `nebula_feedback({id, score, query?})`：模型可在非 recap 轮主动纠正某条知识的用处分。
- **服务端配合**：每条反馈异步 `POST /api/memories/feedback`；Rust 端 `memory_feedback` 表 + 检索排序惩罚，跨设备生效。

### 升级影响

- 需 nebula-sync 服务端同步升级（新接口 404 时上报静默失败，本地降权仍独立生效）。
- 新增本地文件 `~/.dsh/nebula-feedback.jsonl`（append-only，3000 行上限）。
- 装完需重启宿主进程加载新代码（模块代际为进程级）。

### 最佳配置建议

- 打分门槛与衰减系数目前为内置常量（0.4 / 0.7 / 0.6 / 1.25）；先跑一周观察 `nebula-feedback.jsonl` 的正负分布再调。

## [1.3.1] — 2026-11-17

### Fixed — 自动召回 / recap / 查询增强全链路

- **钩子丢失（首轮后不再注入）**：`attachAgent` 原先按 `session.id` 去重，宿主 resume/compaction 重建 agent 实例后（同 session id）旧守卫直接 return，新实例挂不上 `agent/inbox/inserted` / `agent/pre-step` 钩子。改为按 agent 实例判重（`agentDisposers` 存 `{ agent, dispose }`），新实例先释放旧钩子再重挂；`agent/disposed` 按实例匹配。
- **路由排序**：`routeOrder` 把「未知延迟」地址排在最前，导致首次成功后不可达的 fallback 被优先尝试、吃满预算。改为未知延迟排最后，保留已知最快优先。
- **空注入**：记忆腿超时（`memReady=false`）时直接以 `kept=0` 返回并丢弃 pending；改为等下一步重试，不空注入。
- **recap 不生效**：`recapTurn` 用 `ctx.llm` 取不到 LLM 服务（插件上下文为 undefined）→ 静默退出。改为 `ctx.get('llm')` 并 `inject: ['llm']`。
- **短消息不召回 / 不 recap**：`PREFETCH_MIN_QUERY_CHARS` / `RECAP_MIN_CHARS` 由 8 降为 0（保留空文本保护），「继续」「再试一次」这类消息也触发召回与轮末总结，recap 与查询增强对短消息真正生效。
- **超时预算按老硬件放宽**：预取等待 7s、单次 race 7s、召回总预算 10s、单路由 8s、会话腿 7s、搜索工具 15s、stats/health 12s（联想老本 embedding+rerank 实测需 7~8s）。写入仍走异步 outbox，不阻塞交互。

### Added

- 可选调试插桩：设置环境变量 `NEBULA_TRACE_FILE=<路径>` 时输出召回/路由/recap 全链路 trace（默认关闭，零开销）。

### 升级影响

- 无破坏：配置、存储、对外工具签名不变。
- 装完需重启宿主进程加载新代码（模块代际为进程级）。

### 最佳配置建议

- 同前置版本；低功耗设备保持 1.3.1 的超时默认值即可。

---

## [1.3.0] — 2026-11-16

### Added — 轮末 recap（Hermes 式收尾总结 → 下轮召回增强）

- **recap 轮**：主轮结束（收件箱空、无 steering）时，插件在 `agent/turn-stopping` 钩子自主发起一次**独立辅助 LLM 请求**（复用 `ctx.llm.stream`，`purpose:'nebula-recap'`）——不并入主会话、不写会话历史、不改下一轮主请求前缀（KV cache 零影响）。
- **工具回调交总结**：recap 请求只挂一个回调工具 `nebula_recap_return`，云端把轮末总结经 `content` 参数交回；`outcome` 参数（`done/partial/blocked/noconclusion`）标注本轮完成度，入库时以 `[outcome:xxx]` 前缀标注。
- **双写**：① 异步入队星云（正文=`【轮末总结】…【会话ID】…`，scope=设备 scope 或 `dsh-recap`，tags=`recap,auto`）；② 内存缓存按会话 ID 关联。
- **下轮自动使用（两条路）**：a) 注入侧——下一条用户消息的召回块顶部拼「[上一轮 recap 摘要]」块；b) 查询侧——检索 query 变为 `[上轮话题] <recap尾部>\n[本条消息] <原文>`（mem/session 两腿同步），**代词型短消息（「继续」「那怎么办」）不再只靠实体词撞运气**。recap 迟到时 pre-step 有 1500ms 补发窗口。
- **consumed 观测探针**：注入 recap 时快照，下轮 `turn-stopping` 用实词重合启发式（中英分词+停用词）评估助手回复是否真用上了 recap，日志 `probe consumed-words=N`（仅观测，不改行为）。
- **观测日志**：`[nebula-recap] trigger/captured/query-augmented/failed/probe` 全链路 console 日志。

### Changed

- `loadDeviceConfig` 新增可选字段 `recap_provider`/`recap_model`（`~/.dsh/nebula-memory.json`）：显式配置的**轻量 recap 路由**优先于会话前台路由（graph-memory 同款纪律）。
- 被截断的 recap 弃用：`finish` 为 `max-tokens` 时该次总结不落库不缓存（截断即丢尾部关键词，fail-closed）。

### 护栏（防失控）

- 用户消息 <8 字符不 recap；单会话最多 3 次；首轮起 10 分钟窗口外停用；请求预算 30s；全局同时 1 个在飞；流式 seq 失效防新旧错乱；插件 dispose 清理全部 recap 状态；任何失败静默，不拖累主轮。

### 升级影响

- 无破坏。**装完必须重启 host 进程才加载新代码**（同 1.2.0 结论：模块代际是进程级的）。
- recap 每次为独立小请求（输入 ~4-5k tok、输出 ≤900 tok、每会话 ≤3 次）；走云端 API 无本地 KV 争抢顾虑；自建 vLLM/SGLang 满载时理论上有极小 LRU 逐出窗口。

### 最佳配置建议

- 想控成本：在 `~/.dsh/nebula-memory.json` 配 `recap_provider`/`recap_model` 指向便宜/免费模型。
- 想关 recap：`index.js` 顶部 `RECAP_ENABLED=false`（其余 recap 常量 `RECAP_MAX_TURNS`/`RECAP_MAX_WINDOW_MS`/`RECAP_BUDGET_MS`/`RECAP_QUERY_CHARS` 等见 README 调优表）。
- 部署验证方式：正常聊完一轮 → 星云出现 `【轮末总结】` 条目（tags=recap,auto）→ 下一条消息召回块顶部出现 `[上一轮 recap 摘要]` → 日志出现 `[nebula-recap]` 行。

---

## [1.2.0] — 2026-11-11

### Added — Session RAG（历史会话检索/下钻 + 预取指针腿）

- **新工具 `nebula_session_search`**：在会话 RAG 库检索四端（Hermes/Claude Code/Codex/pi 等）历史对话切段；`query`（详细自然语言）/`limit`(≤20)/`device`/`agent` 过滤；工具调用开精排（与 hermes 同语义）。
- **新工具 `nebula_session_read`**：按 `session_id` 取整段会话原文（时间序，≤50 段），深度下钻用。
- **预取会话指针腿**：与记忆腿并行、独立 2s 预算、不走精排；**RRF(k=60) 排名融合**两路取 session 侧 top-2（按 session_id 去重）——评测依据：硬阈值 session 召回 0.33 → RRF 0.82。注入「📂 会话: 日期 主题 (agent/设备) — 需要细节用 nebula_session_search 下钻 [session_id]」**指针行**（不注原文，防 prompt 污染）。
- 服务端：`GET /api/session-rag/search` + `GET /api/session-rag/session`（同一 9200/token；4xx 视为端点缺失不试下一路）。

### Changed

- 召回注入块尾部提示更新：记忆细节 `nebula_search`、会话原文 `nebula_session_search`。

### 升级影响

- 无破坏。**git/registry 安装的设备：装完必须重启 host 进程才加载新代码**（新建会话不够——模块代际是进程级的，实测 remove+install 后注册表仍是旧代际）。
- `link:` 本地开发安装同样受代际缓存影响，换代码后建议重启。

### 最佳配置建议

- 无需新配置（沿用既有 base_url/token）。想关指针腿：`index.js` 的 `PREFETCH_SESSION_ENABLED=false`。
- 指针腿预算 `PREFETCH_SESSION_BUDGET_MS=2000`；嫌注入噪可把 `PREFETCH_SESSION_LIMIT` 降到 1。

---

## [1.1.2] — 2026-11-11

### Fixed

- **跨设备导入失败**（重要）：dsh 包根探测原来写死了 liheng Mac 的 homebrew 路径，在 npm 全局装到 `~/.local`、npx、或其他 prefix 的机器上**插件必然激活失败**。现改为从**运行中的启动器**（`process.argv[1]` realpath 向上找 `@deepseek-ai/dsh` 包根）自动推导，npm -g / `~/.local` / npx / homebrew 全适配；env `DSH_ROOT` 仍可强制覆盖。

### 部署验证

- liheng Mac（homebrew 全局，web profile）与 viture Mac（npm `~/.local`，web/headless/tui/acp 四 profile）均实测安装 + `--dump-config` 静态验证**导入零错误**。

### 升级影响

- 无破坏性变更。**所有非 homebrew 布局的设备必须升到本版**，否则插件激活失败（诊断：`cannot import @deepseek-ai/dsh-llm`）。

### 最佳配置建议

- 新装设备：装完先跑 README §「装后自检」四步。
- **不在家庭局域网的设备**（如 viture）：`base_url` 填星云主机的 Tailscale 地址；局域网设备才填 `192.168.1.x` 类 LAN 地址。

---

## [1.1.1] — 2026-11-11

### Changed

- `nebula_outbox flush` 现在**无视退避**强制立即尝试。此前手动冲刷会被单条退避（next_at）挡住，排障时"明明恢复了却推不动"。

### Fixed

- 失败状态（attempts / last_error）**也落盘**：崩溃、重启、代际切换不再丢重试计数与错误现场。

### 升级影响

- 无破坏。已装 1.1.0 的设备建议升级。

### 最佳配置建议

- 排障口诀：**先 `nebula_outbox status` 看 `last_error` → 恢复后 `flush` 强制推一次** → 再看 `status` 是否清零。

---

## [1.1.0] — 2026-11-11

### Added — 写入队列（异步上传 + 失败重试 + 容量控制）

解决"服务端抖动时写入丢失、只能靠模型自己兜底、会话一断记忆就没了"的问题：

- **`nebula_add` 改为入队即返回**：校验后写入本地队列（<10ms），**永不报错、永不阻塞**，服务端抖动/掉线/401 一概不丢失。
- **本地固化**：`~/.dsh/nebula-memory.outbox.jsonl`（JSONL，一行一条；崩溃断尾行忽略，下次重写自愈；删除/重写用 tmp+rename 原子替换）。
- **重试时序**：入队后 1.5s 首发（在线即秒级送达）→ 进程启动 15s 后首试 → 此后每 30s 一拍 → 失败按 **30s→60s→120s→…→封顶 30min** 指数退避；全路由处于冷却期时不空转、不烧次数。
- **批量补传**：每拍最多 10 条走 `POST /api/memories/batch`；老后端无批量端点（404）时自动降级逐条。
- **容量控制**：去重键 = content+scope+tags（另设 100 条"近期已送达"集防同一结论反复入队）；队列上限 **200 条**，超出淘汰最旧；单条 **30 次尝试或滞留 7 天**即弃；被弃条目写入 `~/.dsh/nebula-memory.outbox.jsonl.dropped` 审计（滚动保留 200 行）。
- **新工具 `nebula_outbox`**（status / flush）：看待发条数、最老等待、下次重试、last_error、累计丢弃；flush 可手动强推。

### Changed

- `nebula_add` 输出 schema：`{ ok, queued, pending, duplicate? }`——**不再返回服务端 id/status**（送达是后台行为，查结果用 `nebula_outbox` 或 `nebula_search`）。

### 运维注意（重要）

- **token 缓存 10 分钟**：`NEBULA_SYNC_TOKEN` / 配置文件 token 改动后**最长 10 分钟**才生效（端点缓存是 60s）。排障时"改了没生效"先等缓存过期，别急着重装。
- **模块代际**：git/registry 安装的包**需要 host 重启**才加载新代码（`link:` 本地开发安装可热载）。安装返回 `applied` 只代表依赖与启用生效；`plugin_manager` 文档原话 "replacing an installed package requires restart"。
- 队列文件可随时整删（下次入队自动重建）；`.dropped` 文件只增不碍事。

### 最佳配置建议

- **无人值守设备**（无 hermes）：务必在配置文件里写 `token`，否则队列会一直滞留（不烧次数，恢复配置后自动补传）。
- 磁盘敏感环境：200 条上限 ≈ 每条 ≤8KB，最坏 ~1.6MB，可放心。
- 想改激进/保守：改 `index.js` 顶部 `OUTBOX_*` / `PREFETCH_*` / `BUDGET_*` 常量（见 README §调优参数）。

---

## [1.0.0] — 2026-11-09

### Added

- 首版。`nebula_search` / `nebula_add` / `nebula_stats` 三工具；**每轮自动召回**（真实用户消息入队即在纯向量路检索，余弦 ≥0.72 的 top-3 在下一 step 边界以「[星云记忆自动召回]」块注入）；多路由 failover（失败冷却 30s + 延迟 EWMA 排序 + 总预算快速失败）；**零内嵌端点**（包内无任何 IP/域名/token，三级解析：env → `~/.dsh/nebula-memory.json` → `~/.hermes/cloudmemory.json`）。
- 召回注入消息源标记 `{ kind: 'nebula', form: 'recall' }`，可从会话日志追溯。

### 说明（星云 API score 语义，接其他端必读）

- `GET /search`（RRF+rerank 融合路）：score 是 **rerank logit（负值，越大越相关）**；部署版会忽略 `limit` 返回全部融合结果 → 插件客户端截断。
- `GET /api/memories/search`（纯向量路）：score 是 **BGE-M3 余弦（0..1）**——召回阈值 0.72 只对它有意义。接其他端时别混用。

### 升级影响

- 首版，无。

### 最佳配置建议

- 有 hermes 的设备：**零配置**（自动读 `~/.hermes/cloudmemory.json` + `~/.hermes/nebula/token`）。
- 纯 DSH 设备：见 README §配置。
