# nebula-memory — 知识星云 × DeepSeek Harness

把私有知识星云（Nebula，SQLite + FAISS + BGE-M3 自建 RAG 知识库）接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)。

- **自动召回**：每条真实用户消息进会话即在星云语义检索，相关记忆（余弦 ≥0.72，top-3）在下一 step 边界自动拼进上下文——不打工具、零操作，模型直接"记得"跨设备历史结论。注入块标记 `[星云记忆自动召回]`，源 `{kind:'nebula', form:'recall'}`，可从会话日志追溯。
- **手动工具**：`nebula_search`（RRF+rerank 融合检索）/ `nebula_add`（**异步入队，永不失败**）/ `nebula_stats`（健康规模）/ `nebula_outbox`（队列管理）。
- **写入队列**：断网/抖动时写入先固化本地 JSONL，后台批量补传，指数退避，容量受控（详见 [CHANGELOG v1.1.0](CHANGELOG.md)）。
- **多路由 failover**：主+备地址，失败冷却 30s、按实测延迟排序、总预算内快速失败。
- **零内嵌端点**：包内无任何 IP/域名/token，**每台设备装后自配**。

**版本与改动记录：[CHANGELOG.md](CHANGELOG.md)（装前必看）**

---

## 安装

任选其一：

**① Web 界面**：侧栏 Plugins → 安装 → 填 `https://github.com/greatyingzi/dsh-nebula-memory.git`（可加 `#v1.1.2` 锁版本）

**② Agent 工具**：对 agent 说「用 plugin_manager 安装 https://github.com/greatyingzi/dsh-nebula-memory.git#v1.1.2」

**③ CLI**：

```bash
dsh plugin --profile <profile> add https://github.com/greatyingzi/dsh-nebula-memory.git#v1.1.2
```

多 profile 设备（web/headless/tui/acp 并存）逐个执行。

### 更新

```bash
dsh plugin --profile <profile> remove @local/nebula-memory
dsh plugin --profile <profile> add https://github.com/greatyingzi/dsh-nebula-memory.git#v1.1.2
```

**注意**：git/registry 安装的包**需要 host 重启**才加载新代码（DSH 规则）；安装返回 `applied` 只代表依赖与启用生效。`link:` 本地开发安装可热载。更新前先看 [CHANGELOG](CHANGELOG.md) 的「升级影响」。

---

## 配置

### 三种设备画像（对号入座）

| 画像 | 判据 | 配置动作 |
|---|---|---|
| **A. hermes 共存设备** | `~/.hermes/nebula/token` 或 `~/.hermes/cloudmemory.json` 存在 | **零配置**。自动读 hermes 的端点与 token，与 hermes 侧共用同一份配置 |
| **B. 纯 DSH 设备** | 上两者都没有 | 写 `~/.dsh/nebula-memory.json`（下方模板） |
| **C. 容器/CI/临时环境** | 不便落文件 | 设 env：`NEBULA_BASE_URL`（+可选 `NEBULA_FALLBACK_URLS`、`NEBULA_SYNC_TOKEN`） |

### 配置文件模板（画像 B）

`~/.dsh/nebula-memory.json`：

```json
{
  "base_url": "http://<星云主机>:9200",
  "fallback_url": ["http://<备用地址>:9200"],
  "token": "<64位hex>"
}
```

**字段参考**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `base_url` | string | 星云核心 REST（9200）。**必填**——没有它一切调用返回"未配置"提示 |
| `fallback_url` | string 或 string[] | 备用路由（可多条）；没有可不写 |
| `token` | string | 64-hex Bearer token。**hermes 共存设备可省**（自动读 `~/.hermes/nebula/token`，再退 `~/.hermes/.env` 的 `CLOUD_MEMORY_TOKEN`） |
| `scope` | string | `nebula_add` 未显式传 scope 时的默认值；可省（服务端默认 `general`） |

### base_url 怎么选（按网络位置）

| 设备位置 | 推荐 base_url |
|---|---|
| 与星云主机**同一家庭局域网** | `http://<星云主机LAN IP>:9200`（最快），fallback 填 Tailscale 地址 |
| **远程，有 Tailscale** | `http://<星云主机TS IP>:9200`（如 viture Mac） |
| 两者都不是 | 需要一条可达路径（frp/公网壳等自定）；完全无路径时插件静默降级，恢复后自动补传 |

### 解析优先级（每字段独立，先到先得）

| 字段 | 顺序 |
|---|---|
| `base_url` | env `NEBULA_BASE_URL` → DSH 配置文件 → hermes `cloudmemory.json` |
| `fallback_url` | env `NEBULA_FALLBACK_URLS`（逗号分隔）→ DSH 配置文件 → hermes 文件（**合并去重**） |
| `token` | env `NEBULA_SYNC_TOKEN` → DSH 配置文件 `token` → `~/.hermes/nebula/token` → hermes `.env` 的 `CLOUD_MEMORY_TOKEN` |
| `scope` | DSH 配置文件 → hermes 文件 → 服务端默认 `general` |

### 热生效

- **端点**（base/fallback）：配置文件每 **60s** 重读，改完无需重启。
- **token**：缓存 **10 分钟**——换 token 后最长 10min 生效（排障时"改了没生效"先等缓存，别急着重装）。
- 队列文件无需配置：自动创建于 `~/.dsh/nebula-memory.outbox.jsonl`。

---

## 装后自检（四步，全过即接入成功）

1. **可达**：对 agent 说「查一下星云状态」→ `nebula_stats` 应报 memories/atoms 数；报「星云未配置」→ 回上面配置章节。
2. **检索**：`nebula_search` 问一个库里确有的事 → 返回条目（首次 1-2s 属正常：embed+rerank 冷缓存）。
3. **写入**：`nebula_add` 写一条测试 → 立即返回「已入队」；`nebula_outbox status` 看 pending；约 2s 后再 status 应清零（已送达）。
4. **自动召回**：发一句带技术话题的消息 → 下一轮模型上下文出现「[星云记忆自动召回]」块（检索无命中时不出现，属正常）。

---

## 调优参数（`index.js` 顶部常量，改后 remove+add 重装或 link 开发热载）

| 常量 | 默认 | 含义 |
|---|---|---|
| `PREFETCH_MIN_SCORE` | 0.72 | 召回余弦阈值（BGE-M3 窄带 0.67–0.76，相关/跑题都近 0.7，**别乱调高**） |
| `PREFETCH_LIMIT` | 3 | 每轮最多注入条数 |
| `PREFETCH_ENTRY_CHARS` | 300 | 单条截断长度 |
| `PREFETCH_WAIT_MS` | 3500 | pre-step 等召回的额外预算（超时本轮跳过，后续 step 补上） |
| `PREFETCH_MIN_QUERY_CHARS` | 8 | 短于此的用户消息不触发召回 |
| `OUTBOX_MAX_ENTRIES` | 200 | 队列容量，超出淘汰最旧（进 `.dropped`） |
| `OUTBOX_MAX_ATTEMPTS` | 30 | 单条最大尝试次数 |
| `OUTBOX_TTL_MS` | 7 天 | 单条最长滞留 |
| `OUTBOX_TICK_MS` | 30s | 后台重试节拍 |
| `OUTBOX_BACKOFF_BASE/CAP` | 30s / 30min | 退避基数/封顶 |
| `OUTBOX_BATCH` | 10 | 每拍批量补传条数 |
| `BUDGET_SEARCH/STATS/WRITE_MS` | 9s/8s/14s | 各调用总预算（跨路由），超时快速失败 |

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `星云未配置：…` | 未配 base_url——按提示建 `~/.dsh/nebula-memory.json` 或设 `NEBULA_BASE_URL` |
| `401 unauthorized` | token 错/缺失（64-hex 不带引号）；**注意 token 缓存 10 分钟** |
| `… 不可达（aborted）` | 该路由超时；备用路由自动顶上，全挂时快速报错。星云主机若是笔记本可能休眠了 |
| 写入后 `nebula_search` 搜不到 | 向量 embed 异步/索引延迟，等一会；或 scope 传错（`nebula_stats` 看 scope 分布） |
| 改了配置没生效 | 端点等 60s、token 等 10min（缓存语义）；还不行再 remove+add |
| 安装报 `cannot import @deepseek-ai/dsh-llm` | 升级到 ≥1.1.2（包根自动推导）；或设 `DSH_ROOT` 指向 dsh 安装目录 |
| 装了新版本行为没变 | git/registry 安装需 **host 重启**加载新代际（link 安装热载） |
| 队列一直 `pending` 不清 | `nebula_outbox status` 看 last_error；恢复后 `flush` 强推；彻底没救的条目 30 次/7 天自动弃（进 `.dropped`） |

## 隐私

包内不含主机名、IP、token、用户身份（CI 级扫描，见 CHANGELOG v1.0.0）；所有请求只发往设备配置声明的地址。召回注入内容与本队列入本机 DSH 会话日志/文件（本地存储）。commit 作者邮箱属 git 元数据，与包内容无关。

## License

MIT
