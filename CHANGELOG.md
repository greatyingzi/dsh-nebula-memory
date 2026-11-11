# 更新日志 / Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。每个版本固定三段：**改动明细 / 升级影响 / 最佳配置建议**——其他端安装或升级前先看这里，再决定配置。

> 安装方式与配置全集见 [README](README.md)。发布页（Releases）与本章保持同步；有出入以本章为准。

---

## [Unreleased]

（无）

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
