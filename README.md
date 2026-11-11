# nebula-memory — 知识星云 × DeepSeek Harness

把私有知识星云（Nebula，SQLite + FAISS + BGE-M3 的自建 RAG 知识库）接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的插件：

- **自动召回（预取）**：每条真实用户消息进入会话时即在星云做语义检索，相关记忆（余弦 ≥ 0.72，top-3）在下一 step 边界自动拼入上下文——不打工具、零操作，模型直接"记得"跨设备的历史结论。
- **手动工具**：`nebula_search`（RRF+rerank 融合检索）/ `nebula_add`（幂等写入）/ `nebula_stats`（健康与规模）。
- **多路由 failover**：主地址 + 备用地址，失败冷却 30s、按实测延迟排序；总预算内快速失败，绝无静默挂起。
- **零内嵌端点**：包内不含任何 IP / 域名 / token，装好后每台设备自己配置。

## 安装

任选其一（所有装有 DSH 的设备）：

**① Web 界面**：侧栏 Plugins → 安装 bundle → 填 git 地址：

```
https://github.com/greatyingzi/dsh-nebula-memory.git
```

**② Agent 工具**：对 agent 说

```
用 plugin_manager 安装 https://github.com/greatyingzi/dsh-nebula-memory.git
```

**③ CLI**：

```bash
dsh plugin --profile <你的profile> add https://github.com/greatyingzi/dsh-nebula-memory.git
```

可追加 `#v1.0.0` 锁定 tag。更新 = 先 remove 再 add（或用插件管理器的更新入口）。

## 设备配置（安装后一次）

包里没有任何端点和密钥。每台设备二选一：

**A. 配置文件（推荐）** — `~/.dsh/nebula-memory.json`：

```json
{
  "base_url": "http://<星云主机>:9200",
  "fallback_url": ["http://<备用地址>:9200"],
  "token": "<64位hex，DSH-only 设备必填；有 hermes 的设备可省略>"
}
```

**B. 环境变量**：`NEBULA_BASE_URL`（主）、`NEBULA_FALLBACK_URLS`（逗号分隔备用）、`NEBULA_SYNC_TOKEN`。

**hermes 设备零操作**：若该机跑着 hermes，插件会直接读 `~/.hermes/cloudmemory.json`（base_url/fallback_url/scope）与 `~/.hermes/nebula/token`，与 hermes 侧共用同一份配置。

**热生效**：配置文件每 60s 重读一次，改完无需重启。校验：对 agent 说"查一下星云状态"，或看 `nebula_stats` 返回。

## 写入纪律（星云是主人的知识资产）

- 默认只 `nebula_search`；写入仅在用户明确说"记住/保存"，或产生"删了就要从零重做"的根因/硬约束/决策时。
- `content` 必须自含结论，不引用只有本机才能打开的路径。
- 服务端按 content+scope+tags 幂等去重，但别依赖它。

## 故障排查

| 现象 | 处理 |
|---|---|
| `星云未配置：…` | 按提示建 `~/.dsh/nebula-memory.json` 或设 `NEBULA_BASE_URL` |
| `401 unauthorized` | token 错/缺失；token 是 64-hex，别带引号 |
| `… 不可达（aborted）` | 星云主机不在线（若是笔记本，可能休眠了）；备用路由会自动顶上，全部失败时快速报错 |
| 搜不到刚写的内容 | embed 异步/缓存未命中，或 scope 传错；用 `nebula_stats` 看 scope 分布 |
| 首次检索慢 1-2s | embed+rerank 两次 LLM 调用，缓存命中后 2-4ms，正常 |

## 隐私

本包不含任何主机名、IP、token、用户身份；所有请求只发往设备配置里声明的星云地址。自动召回的注入内容会进入本机 DSH 会话日志（本地存储）。

## License

MIT
