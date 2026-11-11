/**
 * Nebula Memory — 知识星云 integration for the DeepSeek Harness.
 *
 * Ports the essential behavior of the Hermes `cloudmemory` memory plugin
 * (~/.hermes/plugins/cloudmemory) onto this harness:
 *
 *   1. Tools   — `nebula_search` / `nebula_add` / `nebula_stats` backed by the
 *                private nebula-sync REST server (SQLite + FAISS + BGE-M3),
 *                with multi-route failover over whatever endpoints the local
 *                device config declares (primary + fallbacks, cooled down on
 *                failure, ordered by measured latency).
 *   2. Prefetch — every real user message kicks off a bounded semantic recall
 *                (`GET /search`); the next admitted step (`agent/pre-step`)
 *                splices the best matches into the conversation as a
 *                `{ kind: 'nebula', form: 'recall' }` user-role snapshot, so
 *                the model sees relevant memory without calling any tool.
 *
 * Credentials & endpoints — nothing is baked into this package. Every device
 * configures itself after install; resolution order (first hit wins per field):
 *   base_url  env NEBULA_BASE_URL
 *             > $DSH_HOME/nebula-memory.json { "base_url": "...", "fallback_url": "..." }
 *             > $HERMES_HOME/cloudmemory.json { base_url, fallback_url }   (hermes fleet sync)
 *   token     env NEBULA_SYNC_TOKEN
 *             > "token" field of $DSH_HOME/nebula-memory.json
 *             > $HERMES_HOME/nebula/token > CLOUD_MEMORY_TOKEN in $HERMES_HOME/.env
 * With no base_url configured the plugin stays active and every call returns a
 * soft "未配置" hint naming the config file — nothing is fetched, nothing leaks.
 *
 * Harness packages are imported from the installed DSH tree at runtime (the
 * profile does not re-expose them); set DSH_ROOT to override the probe order.
 *
 * Everything degrades silently: recall and tools return soft errors and never
 * block a turn longer than their own budget. (v1.1.0: writes go through the
 * durable outbox — see the Write outbox section.)
 */

import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
// ---------------------------------------------------------------------------
// Harness package imports (resolved from the DSH installation, not the profile)
// ---------------------------------------------------------------------------

function dshRootCandidates() {
  return [
    process.env.DSH_ROOT,
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/opt/local/lib/node_modules/@deepseek-ai/dsh',
  ].filter(Boolean);
}

async function importDshPackage(name) {
  let last;
  for (const root of dshRootCandidates()) {
    const url = new URL(`file://${root}/node_modules/@deepseek-ai/${name}/lib/index.js`);
    try {
      return await import(url.href);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`nebula-memory: cannot import @deepseek-ai/${name}: ${last?.message ?? 'no candidate root'}`);
}

const { createUserMessage } = await importDshPackage('dsh-llm');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const ROUTE_CAP_MS = 6000;            // per-route cap inside one call
const BUDGET_SEARCH_MS = 9000;        // total budget: failover across routes, then clean error
const BUDGET_WRITE_MS = 14000;        // write embeds + dedupes before answering
const BUDGET_STATS_MS = 8000;
const BUDGET_RECALL_MS = 6000;
const ROUTE_COOLDOWN_MS = 30_000;     // failed routes ride last for this long
const ROUTE_LAT_ALPHA = 0.4;          // EWMA factor for route latency

const PREFETCH_ENABLED = true;
const PREFETCH_MIN_QUERY_CHARS = 8;   // skip greetings / one-word nudges
const PREFETCH_MIN_SCORE = 0.72;      // BGE-M3 cosine band, same floor as hermes
const PREFETCH_LIMIT = 3;             // max memories injected per turn
const PREFETCH_ENTRY_CHARS = 300;     // truncate each entry
const PREFETCH_WAIT_MS = 3500;        // max extra wait at pre-step for a slow recall
const PREFETCH_STALE_MS = 30_000;     // discard recall older than this

const CONFIG_TTL_MS = 60_000;         // re-read device config at most once a minute
const TOKEN_REFRESH_MS = 10 * 60_000;

// --- write outbox (异步上传 + 失败重试 + 容量控制) ---
const OUTBOX_MAX_ENTRIES = 200;              // 队列容量上限, 超出淘汰最旧并记入 dropped
const OUTBOX_MAX_ATTEMPTS = 30;              // 单条最大尝试次数, 超过丢弃
const OUTBOX_TTL_MS = 7 * 24 * 3600_000;     // 单条最长滞留 7 天
const OUTBOX_TICK_MS = 30_000;               // 后台重试节拍
const OUTBOX_STARTUP_FLUSH_DELAY = 15_000;   // 进程/会话启动后首试延迟
const OUTBOX_KICK_DELAY_MS = 1_500;          // 入队后首发延迟(在线时秒级送达)
const OUTBOX_BACKOFF_BASE_MS = 30_000;       // 退避基数: 30s, 60s, 120s ... 封顶 30min
const OUTBOX_BACKOFF_CAP_MS = 30 * 60_000;
const OUTBOX_BATCH = 10;                     // 每拍批量补传条数 (/api/memories/batch)
const OUTBOX_RECENT_KEYS = 100;              // 已送达 key 的近期去重集容量
const OUTBOX_DROPPED_KEEP_LINES = 200;       // dropped 审计文件保留行数

const UNCONFIGURED_HINT =
  '星云未配置：设置环境变量 NEBULA_BASE_URL，或创建 ~/.dsh/nebula-memory.json 写入 ' +
  '{"base_url":"http://<星云主机>:9200","fallback_url":"<备用地址>","token":"<64位hex>"}' +
  '（hermes 设备的 ~/.hermes/cloudmemory.json 也会被读取）。改完无需重启，60 秒内自动生效。';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hermesHome() {
  return process.env.HERMES_HOME || join(homedir(), '.hermes');
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function envList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function truncate(text, cap) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= cap ? t : `${t.slice(0, cap - 1)}…`;
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function hashOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return `${(h >>> 0).toString(16)}${text.length.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Device config resolution — the package ships ZERO endpoints or tokens.
// Fields resolve independently, first source that sets a field wins:
//   base_url:  env NEBULA_BASE_URL > $DSH_HOME/nebula-memory.json > $HERMES_HOME/cloudmemory.json
//   fallback:  env NEBULA_FALLBACK_URLS (csv) > DSH file > hermes file (merged, deduped)
//   token:     env NEBULA_SYNC_TOKEN > DSH file "token" > $HERMES_HOME/nebula/token > hermes .env
//   scope:     DSH file "scope" > hermes file "scope" > 'general' (server default)
// ---------------------------------------------------------------------------

let deviceConfig = null;
let deviceConfigAt = 0;

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null; // absent or unparsable — silently skipped
  }
}

function pushFallbacks(list, value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? [value] : [];
  for (const item of items) {
    const u = String(item).trim();
    if (u && !list.includes(u)) list.push(u);
  }
}

async function loadDeviceConfig() {
  const now = Date.now();
  if (deviceConfig && now - deviceConfigAt < CONFIG_TTL_MS) return deviceConfig;
  deviceConfigAt = now;
  const cfg = { baseUrl: '', fallbacks: [], token: '', scope: '' };

  const envBase = String(process.env.NEBULA_BASE_URL || '').trim();
  if (envBase) cfg.baseUrl = envBase;
  cfg.fallbacks = envList(process.env.NEBULA_FALLBACK_URLS);

  const dshFile = await readJsonFile(join(dshHome(), 'nebula-memory.json'));
  const hermesFile = await readJsonFile(join(hermesHome(), 'cloudmemory.json'));

  if (!cfg.baseUrl && dshFile && typeof dshFile.base_url === 'string' && dshFile.base_url.trim()) {
    cfg.baseUrl = dshFile.base_url.trim();
  }
  if (!cfg.baseUrl && hermesFile && typeof hermesFile.base_url === 'string' && hermesFile.base_url.trim()) {
    cfg.baseUrl = hermesFile.base_url.trim();
  }
  if (dshFile) pushFallbacks(cfg.fallbacks, dshFile.fallback_url ?? dshFile.fallback_urls);
  if (hermesFile) pushFallbacks(cfg.fallbacks, hermesFile.fallback_url);

  if (!cfg.token && dshFile && typeof dshFile.token === 'string' && dshFile.token.trim()) {
    cfg.token = dshFile.token.trim();
  }
  if (!cfg.scope && dshFile && typeof dshFile.scope === 'string' && dshFile.scope.trim()) {
    cfg.scope = dshFile.scope.trim();
  }
  if (!cfg.scope && hermesFile && typeof hermesFile.scope === 'string' && hermesFile.scope.trim()) {
    cfg.scope = hermesFile.scope.trim();
  }

  cfg.fallbacks = cfg.fallbacks.filter((u) => u !== cfg.baseUrl);
  deviceConfig = cfg;
  return cfg;
}

async function loadRoutes() {
  const cfg = await loadDeviceConfig();
  return cfg.baseUrl ? [cfg.baseUrl, ...cfg.fallbacks] : [];
}

let tokenCache = { value: '', at: 0 };

async function loadToken() {
  const now = Date.now();
  if (tokenCache.value && now - tokenCache.at < TOKEN_REFRESH_MS) return tokenCache.value;
  if (now - tokenCache.at < 5_000) return tokenCache.value; // avoid hammering a missing file
  tokenCache.at = now;
  const direct = process.env.NEBULA_SYNC_TOKEN;
  if (direct) {
    tokenCache.value = direct.trim();
    return tokenCache.value;
  }
  const cfg = await loadDeviceConfig();
  if (cfg.token) {
    tokenCache.value = cfg.token;
    return tokenCache.value;
  }
  try {
    const raw = await readFile(join(hermesHome(), 'nebula', 'token'), 'utf8');
    const value = raw.trim();
    if (value) {
      tokenCache.value = value;
      return value;
    }
  } catch {
    // fall through to .env
  }
  try {
    const env = await readFile(join(hermesHome(), '.env'), 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('CLOUD_MEMORY_TOKEN='));
    if (line) {
      const value = line.slice('CLOUD_MEMORY_TOKEN='.length).trim();
      if (value) tokenCache.value = value;
    }
  } catch {
    // no token anywhere; calls will 401 and report a soft error
  }
  return tokenCache.value;
}

// ---------------------------------------------------------------------------
// Route health (mirrors the hermes plugin: cool down broken paths, prefer fast)
// ---------------------------------------------------------------------------

const routeFails = new Map(); // base -> deadline (Date.now based)
const routeLat = new Map();   // base -> EWMA latency ms

function routeOrder(routes) {
  const now = Date.now();
  const live = [];
  const cooled = [];
  for (const base of routes) {
    const until = routeFails.get(base) || 0;
    (until > now ? cooled : live).push(base);
  }
  live.sort((a, b) => {
    const la = routeLat.get(a);
    const lb = routeLat.get(b);
    if (la === undefined && lb === undefined) return 0;
    if (la === undefined) return -1;
    if (lb === undefined) return 1;
    return la - lb;
  });
  return [...live, ...cooled];
}

function noteRoute(base, ok, latencyMs) {
  if (ok) {
    routeFails.delete(base);
    const prev = routeLat.get(base);
    routeLat.set(base, prev === undefined ? latencyMs : ROUTE_LAT_ALPHA * latencyMs + (1 - ROUTE_LAT_ALPHA) * prev);
  } else {
    routeFails.set(base, Date.now() + ROUTE_COOLDOWN_MS);
  }
}

// ---------------------------------------------------------------------------
// REST access
// ---------------------------------------------------------------------------

async function nebulaApi(method, path, data, totalBudgetMs) {
  const routes = await loadRoutes();
  if (routes.length === 0) {
    return { status: 0, json: null, error: UNCONFIGURED_HINT };
  }
  const token = await loadToken();
  const deadline = Date.now() + totalBudgetMs;
  let lastError = '所有星云地址均失败';
  for (const base of routeOrder(routes)) {
    const remaining = deadline - Date.now();
    if (remaining <= 200) break; // 总预算耗尽, 快速失败并携带原因
    const perRoute = Math.min(remaining, ROUTE_CAP_MS);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perRoute);
    const started = Date.now();
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: ctrl.signal,
      });
      noteRoute(base, true, Date.now() - started);
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch (error) {
      noteRoute(base, false);
      lastError = `${base} 不可达（${error instanceof Error ? error.message : String(error)}）`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, json: null, error: lastError };
}

// ---------------------------------------------------------------------------
// Write outbox — 写入永不失败: 入队即返回, 后台批量补传, 本地 JSONL 固化
//
// 存储:  $DSH_HOME/nebula-memory.outbox.jsonl (一行一条, 崩溃容错: 断尾行忽略)
// 时序:  入队后 1.5s 首发; 进程启动 15s 后首试; 之后每 30s 一拍; 失败按
//        30s→60s→…→30min 指数退避; 批量走 /api/memories/batch(404 时逐条)
// 容量:  去重键 content+scope+tags; 上限 200 条(超出淘汰最旧); 单条最多 30 次
//        尝试或滞留 7 天即丢入 *.dropped 审计文件(保留 200 行)
// ---------------------------------------------------------------------------

const outbox = new Map();        // key -> entry (保持插入序 = FIFO)
const outboxRecent = new Set();  // 近期已送达 key, 防止同一结论反复入队
let outboxLoaded = false;
let outboxLoadPromise = null;
let outboxTimer = null;
let outboxKickTimer = null;
let outboxFlushing = false;
let outboxDroppedTotal = 0;
let outboxLastError = '';

function outboxPath() {
  return join(dshHome(), 'nebula-memory.outbox.jsonl');
}

function outboxDroppedPath() {
  return `${outboxPath()}.dropped`;
}

function outboxKeyOf(content, scope, tags) {
  return hashOf(`${content}\u0000${scope || ''}\u0000${tags || ''}`);
}

async function outboxEnsureLoaded() {
  if (outboxLoaded) return;
  if (!outboxLoadPromise) {
    outboxLoadPromise = (async () => {
      const text = await readFile(outboxPath(), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const entry = JSON.parse(t);
          if (entry && entry.op === 'add' && typeof entry.content === 'string' && entry.key) {
            outbox.delete(entry.key); // 同 key 后行覆盖前行
            outbox.set(entry.key, entry);
          }
        } catch {
          break; // 崩溃断尾: 其后内容忽略, 下次 persist 重写修复
        }
      }
      outboxLoaded = true;
    })();
  }
  await outboxLoadPromise;
}

function outboxPersist() {
  const entries = [...outbox.values()];
  const tmp = `${outboxPath()}.tmp`;
  const data = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  return writeFile(tmp, data)
    .then(() => rename(tmp, outboxPath()))
    .catch((error) => {
      outboxLastError = `persist: ${error instanceof Error ? error.message : String(error)}`;
    });
}

function outboxDropRecord(entry, reason) {
  outboxDroppedTotal += 1;
  const line = `${JSON.stringify({ dropped_at: Date.now(), reason, ...entry })}\n`;
  appendFile(outboxDroppedPath(), line).catch(() => {});
  readFile(outboxDroppedPath(), 'utf8')
    .then((text) => {
      const lines = text.split('\n').filter(Boolean);
      if (lines.length > OUTBOX_DROPPED_KEEP_LINES) {
        return writeFile(outboxDroppedPath(), `${lines.slice(-OUTBOX_DROPPED_KEEP_LINES).join('\n')}\n`);
      }
    })
    .catch(() => {});
  try {
    console.warn(`[nebula-memory] outbox drop(${reason}): ${truncate(entry.content, 80)}`);
  } catch {}
}

function outboxBackoff(attempts) {
  return Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_BACKOFF_CAP_MS);
}

function outboxRecentAdd(key) {
  outboxRecent.add(key);
  if (outboxRecent.size > OUTBOX_RECENT_KEYS) {
    outboxRecent.delete(outboxRecent.values().next().value);
  }
}

function outboxFail(entries, error) {
  const at = Date.now();
  for (const entry of entries) {
    entry.attempts += 1;
    entry.next_at = at + outboxBackoff(entry.attempts);
    entry.last_error = String(error).slice(0, 200);
  }
  outboxLastError = String(error).slice(0, 200);
}

async function outboxEnqueue({ content, scope, tags }) {
  await outboxEnsureLoaded();
  const key = outboxKeyOf(content, scope, tags);
  if (outbox.has(key)) return { key, duplicate: 'pending' };
  if (outboxRecent.has(key)) return { key, duplicate: 'delivered' };
  let evicted = false;
  while (outbox.size >= OUTBOX_MAX_ENTRIES) {
    const oldest = outbox.keys().next().value;
    outboxDropRecord(outbox.get(oldest), 'capacity');
    outbox.delete(oldest);
    evicted = true;
  }
  const entry = {
    op: 'add',
    key,
    content,
    scope: scope || '',
    tags: tags || '',
    created_at: Date.now(),
    attempts: 0,
    next_at: 0,
  };
  outbox.set(key, entry);
  await appendFile(outboxPath(), `${JSON.stringify(entry)}\n`).catch((error) => {
    outboxLastError = `append: ${error instanceof Error ? error.message : String(error)}`;
  });
  if (evicted) outboxPersist();
  outboxKick();
  return { key, duplicate: null };
}

async function outboxFlushIndividual(entries) {
  for (const entry of entries) {
    const body = {
      content: entry.content,
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
    };
    const res = await nebulaApi('POST', '/api/memories', body, BUDGET_WRITE_MS);
    if (res.json && (res.json.ok === true || res.status === 200 || res.status === 201)) {
      outbox.delete(entry.key);
      outboxRecentAdd(entry.key);
      outboxPersist();
    } else {
      outboxFail([entry], res.json?.error || res.error || `HTTP ${res.status}`);
      return; // 一条失败即停, 整体退避
    }
  }
}

async function outboxFlush(force = false) {
  if (outboxFlushing) return;
  await outboxEnsureLoaded();
  if (outbox.size === 0) return;
  const now = Date.now();
  let removed = false;
  for (const [key, entry] of [...outbox]) {
    if (now - entry.created_at >= OUTBOX_TTL_MS || entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
      outboxDropRecord(entry, entry.attempts >= OUTBOX_MAX_ATTEMPTS ? 'max-attempts' : 'ttl');
      outbox.delete(key);
      removed = true;
    }
  }
  if (removed) outboxPersist();
  const due = [...outbox.values()]
    .filter((e) => force || e.next_at <= now)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, OUTBOX_BATCH);
  if (due.length === 0) return;
  const routes = await loadRoutes();
  if (routes.length === 0 || routes.every((b) => (routeFails.get(b) || 0) > Date.now())) {
    return; // 未配置或全部路由冷却中: 不试也不计 attempts
  }
  outboxFlushing = true;
  try {
    const items = due.map((e) => ({
      content: e.content,
      ...(e.scope ? { scope: e.scope } : {}),
      ...(e.tags ? { tags: e.tags } : {}),
    }));
    const res = await nebulaApi('POST', '/api/memories/batch', { items }, BUDGET_WRITE_MS);
    const body = res.json;
    if (res.status === 404) {
      await outboxFlushIndividual(due); // 老后端无批量端点: 逐条
      return;
    }
    if (!body || body.ok !== true || !Array.isArray(body.results)) {
      outboxFail(due, body?.error || res.error || `HTTP ${res.status}`);
      outboxPersist(); // 失败状态也落盘, 崩溃重启不丢尝试计数
      return;
    }
    const byIndex = new Map(body.results.map((r) => [Number(r.index), r]));
    let delivered = false;
    due.forEach((entry, i) => {
      const r = byIndex.get(i);
      if (r && r.status !== 'error') {
        outbox.delete(entry.key);
        outboxRecentAdd(entry.key);
        delivered = true;
      } else {
        outboxFail([entry], r?.message || 'batch item error');
      }
    });
    if (delivered) outboxPersist();
  } finally {
    outboxFlushing = false;
  }
}

function outboxSchedule(delayMs) {
  if (outboxTimer) clearTimeout(outboxTimer);
  outboxTimer = setTimeout(() => {
    outboxTimer = null;
    outboxFlush().catch((error) => {
      outboxLastError = String(error?.message || error);
    });
    outboxSchedule(OUTBOX_TICK_MS);
  }, delayMs);
}

function outboxKick() {
  if (outboxKickTimer) return;
  outboxKickTimer = setTimeout(() => {
    outboxKickTimer = null;
    outboxFlush().catch(() => {});
  }, OUTBOX_KICK_DELAY_MS);
}

function outboxStop() {
  if (outboxTimer) clearTimeout(outboxTimer);
  if (outboxKickTimer) clearTimeout(outboxKickTimer);
  outboxTimer = null;
  outboxKickTimer = null;
}

// ---------------------------------------------------------------------------
// Tools (plain ToolDefinition objects; explicit JSON Schema)
// ---------------------------------------------------------------------------

const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Whether the search reached the nebula backend.' },
    error: { type: 'string' },
    total: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          score: { type: 'number' },
          scope: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          content: { type: 'string' },
        },
        required: ['id', 'score', 'content'],
      },
    },
  },
  required: ['ok'],
};

function renderItems(items) {
  if (!Array.isArray(items) || items.length === 0) return '（星云中没有相关记忆）';
  return items
    .map((it, i) => {
      const score = typeof it.score === 'number' ? it.score.toFixed(2) : '?';
      const scope = it.scope ? ` · ${it.scope}` : '';
      const via = Array.isArray(it.sources) && it.sources.length ? ` · ${it.sources.join('/')}` : '';
      return `${i + 1}. [${score}${scope}${via}] ${truncate(it.content, 600)}`;
    })
    .join('\n');
}

const nebulaSearchTool = {
  name: 'nebula_search',
  description:
    '在知识星云（主人跨设备共享的长期知识库：记忆、项目经验、踩坑结论、技能原子）中做语义检索。' +
    '当需要回忆历史决策、根因、设备/项目私有事实或某个主题是否已经踩过坑时使用；' +
    '联网搜索前先查这里（经验优先），重任务/陌生领域启动时也先找经验再动手。' +
    '查询务必写成 1-2 句详细自然语言：主题+现象/场景+技术细节(组件/模型/文件/报错)+因果或结论指向；' +
    '只给几个名词会退化成关键字匹配、混入高频词假阳。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      query: { type: 'string', description: '详细自然语言描述(主题+现象/场景+技术细节+因果或结论指向)，越详细命中越准。例: "训练时GPU利用率0%但进程活着,实际是慢盘随机读20万图冲垮OS缓存,是IO瓶颈不是死锁"。' },
      scope: { type: 'string', description: '限定单个 scope（项目或设备标签，例如 hermes、dsv2-model）；不传则全库检索。' },
      limit: { type: 'integer', description: '返回条数，默认 5，最大 10。' },
    },
    required: ['query'],
  },
  timeoutMs: 20_000,
  output: { schema: SEARCH_OUTPUT, render: (_args, value) => [{
    type: 'text',
    text: value.ok === false
      ? `星云检索失败：${value.error || '未知错误'}`
      : renderItems(value.items),
  }] },
  async execute(args) {
    const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
    const q = encodeURIComponent(String(args?.query || '').slice(0, 2000));
    const scopeParam = args?.scope ? `&scope=${encodeURIComponent(String(args.scope))}` : '';
    const res = await nebulaApi('GET', `/search?q=${q}&limit=${limit}${scopeParam}`, undefined, BUDGET_SEARCH_MS);
    const body = res.json;
    if (!body || body.ok !== true) {
      return { ok: false, error: body?.error || res.error || `HTTP ${res.status}` };
    }
    const items = (body.items || [])
      .slice(0, limit) // 部署版 /search 会忽略 limit 返回全部融合结果, 客户端截断
      .map((it) => ({
      id: String(it.id ?? ''),
      score: Number(it.score ?? 0),
      content: String(it.content ?? ''),
      ...(it.scope ? { scope: String(it.scope) } : {}),
      ...(Array.isArray(it.sources) ? { sources: it.sources.map(String) } : {}),
    }));
    return { ok: true, total: Number(body.total ?? items.length), items };
  },
};

const nebulaAddTool = {
  name: 'nebula_add',
  description:
    '往知识星云写入一条长期记忆（跨设备共享，其他设备上的 agent 也能检索到）。' +
    '写入是异步入队制：本工具立即返回成功并把内容放进本地上传队列，由后台自动补传到星云——' +
    '服务端抖动/掉线也绝不丢失、不阻塞、不报错，恢复后自动送达。' +
    '只在用户明确要求记住/保存某条结论，或本轮产生了“删了它下次就要从零重做”的根因/硬约束/决策+理由时使用；' +
    'content 必须写成自含结论，不要引用只有本机才能打开的文件路径。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      content: { type: 'string', description: '自含结论的一条记忆，不引用外部文件路径。' },
      scope: { type: 'string', description: '归属标签（项目/设备名）。不传则用默认 scope（general）。' },
      tags: { type: 'string', description: '逗号分隔的标签，例如 "display,优化"。' },
    },
    required: ['content'],
  },
  timeoutMs: 10_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', description: 'Whether the memory was accepted into the upload queue.' },
        queued: { type: 'boolean', description: 'Always true: delivery to nebula happens in the background.' },
        pending: { type: 'integer', description: 'Entries currently waiting in the local outbox.' },
        duplicate: { type: 'string', description: 'Why an identical entry was skipped: pending or delivered.' },
        error: { type: 'string' },
      },
      required: ['ok', 'queued'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.duplicate
        ? `相同内容已在队列/近期已送达，未重复入队（待发 ${value.pending} 条）`
        : `已入队，后台自动写入星云（当前待发 ${value.pending ?? 1} 条；断网也会在恢复后补传）`,
    }],
  },
  async execute(args) {
    const content = String(args?.content || '').trim();
    if (!content) return { ok: false, error: 'content 不能为空' };
    const device = await loadDeviceConfig();
    const scope = args?.scope ? String(args.scope) : device.scope || '';
    const tags = args?.tags ? String(args.tags) : '';
    try {
      const result = await outboxEnqueue({ content: content.slice(0, 8000), scope, tags });
      return {
        ok: true,
        queued: true,
        pending: outbox.size,
        ...(result.duplicate ? { duplicate: result.duplicate } : {}),
      };
    } catch (error) {
      // 队列本身异常也要兜住: 不向 agent 报失败
      return { ok: true, queued: true, pending: -1, error: `queue: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

const nebulaOutboxTool = {
  name: 'nebula_outbox',
  description:
    '查看或手动冲刷星云写入队列。写入走异步队列（本地 JSONL 固化，断网自动重试补传）；' +
    '本工具用于确认待发条数/重试计划，或在需要时立即尝试上传。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'flush'],
        description: 'status=只看待发与重试计划（默认）；flush=立即尝试上传一批。',
      },
    },
  },
  timeoutMs: 20_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        pending: { type: 'integer' },
        attempts: { type: 'integer', description: 'Max retry count among pending entries.' },
        next_retry_s: { type: 'integer', description: 'Seconds until the oldest due entry retries; absent when idle.' },
        oldest_age_s: { type: 'integer' },
        dropped_total: { type: 'integer' },
        last_error: { type: 'string' },
        file: { type: 'string' },
      },
      required: ['ok', 'action', 'pending'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.pending === 0
        ? '队列为空（全部已送达星云）'
        : `待发 ${value.pending} 条${value.attempts ? `，最多已重试 ${value.attempts} 次` : ''}${value.oldest_age_s !== undefined ? `，最老已等 ${value.oldest_age_s}s` : ''}` +
          `${value.next_retry_s !== undefined ? `，下次重试 ${value.next_retry_s}s 后` : ''}` +
          `${value.last_error ? `；上次错误: ${value.last_error}` : ''}` +
          `（累计丢弃 ${value.dropped_total ?? 0}；队列文件 ${value.file}）`,
    }],
  },
  async execute(args) {
    const action = args?.action === 'flush' ? 'flush' : 'status';
    await outboxEnsureLoaded();
    if (action === 'flush') await outboxFlush(true); // 手动冲刷无视退避, 立即尝试
    const now = Date.now();
    const entries = [...outbox.values()];
    const dueAt = entries.length ? Math.min(...entries.map((e) => Math.max(e.next_at, now))) : undefined;
    return {
      ok: true,
      action,
      pending: entries.length,
      ...(entries.length ? { attempts: Math.max(...entries.map((e) => e.attempts || 0)) } : {}),
      ...(entries.length && dueAt !== undefined && dueAt > now ? { next_retry_s: Math.round((dueAt - now) / 1000) } : {}),
      ...(entries.length ? { oldest_age_s: Math.round((now - Math.min(...entries.map((e) => e.created_at))) / 1000) } : {}),
      dropped_total: outboxDroppedTotal,
      ...(outboxLastError ? { last_error: outboxLastError } : {}),
      file: outboxPath(),
    };
  },
};

const nebulaStatsTool = {
  name: 'nebula_stats',
  description: '查看知识星云后端的健康与规模（记忆总数、原子数、scope 分布）。用于确认星云是否可达。',
  parameters: { type: 'object', additionalProperties: true, properties: {} },
  timeoutMs: 15_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', description: 'Whether the nebula backend is reachable.' },
        error: { type: 'string' },
        total_memories: { type: 'integer' },
        live_memories: { type: 'integer' },
        atoms: { type: 'integer' },
        vectors: { type: 'integer' },
        by_scopes: { type: 'array' },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.ok
        ? `星云在线：memories ${value.total_memories ?? value.live_memories ?? '?'}，atoms ${value.atoms ?? '?'}，vectors ${value.vectors ?? '?'}`
        : `星云不可达：${value.error || '未知错误'}`,
    }],
  },
  async execute() {
    const [stats, health] = await Promise.all([
      nebulaApi('GET', '/stats', undefined, BUDGET_STATS_MS),
      nebulaApi('GET', '/health', undefined, BUDGET_STATS_MS),
    ]);
    const s = stats.json;
    const h = health.json;
    if ((!s || s.ok !== true) && (!h || h.ok !== true)) {
      return { ok: false, error: s?.error || h?.error || stats.error || health.error || `HTTP ${stats.status}/${health.status}` };
    }
    return {
      ok: true,
      ...(s && s.total_memories !== undefined ? { total_memories: Number(s.total_memories) } : {}),
      ...(h && h.live_memories !== undefined ? { live_memories: Number(h.live_memories) } : {}),
      ...(h && h.atoms !== undefined ? { atoms: Number(h.atoms) } : {}),
      ...(h && h.vectors !== undefined ? { vectors: Number(h.vectors) } : {}),
      ...(s && Array.isArray(s.by_scopes) ? { by_scopes: s.by_scopes } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Prefetch (automatic recall injected at each step boundary)
// ---------------------------------------------------------------------------

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function recallFor(query) {
  const routes = await loadRoutes();
  if (routes.length === 0) return []; // 未配置: 静默跳过
  if (routes.every((b) => (routeFails.get(b) || 0) > Date.now())) {
    return []; // 所有路由都在冷却期(已知不可达): 不拖慢本轮 pre-step
  }
  // 纯向量路端点: score = BGE-M3 余弦 (0..1), 与 hermes prefetch 的 0.72 窄带阈值同语义。
  // /search 是 RRF+rerank 融合路, score 为 rerank logit(负值), 不能用过阈值筛。
  const q = encodeURIComponent(query.slice(0, 2000));
  const res = await nebulaApi('GET', `/api/memories/search?q=${q}&limit=${PREFETCH_LIMIT + 2}`, undefined, BUDGET_RECALL_MS);
  const body = res.json;
  if (!body || body.ok !== true || !Array.isArray(body.items)) return [];
  return body.items
    .filter((it) => typeof it.score === 'number' && it.score >= PREFETCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, PREFETCH_LIMIT);
}

function recallText(items) {
  const lines = items.map((it, i) => {
    const score = typeof it.score === 'number' ? it.score.toFixed(2) : '?';
    const scope = it.scope ? ` · ${it.scope}` : '';
    return `${i + 1}. (${score}${scope}) ${truncate(it.content, PREFETCH_ENTRY_CHARS)}`;
  });
  return (
    '[星云记忆自动召回] 以下条目来自知识星云，与当前输入语义相关，由系统自动注入（不是用户说的话）：\n'
    + lines.join('\n')
    + '\n如需更多细节可调用 nebula_search 检索。'
  );
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export const inject = ['agents'];

export function apply(ctx) {
  const pendingByAgent = new Map(); // agent session id -> { promise, startedAt, text, consumed }
  const agentDisposers = new Map(); // agent session id -> () => void

  const startRecall = (agentSessionId, text) => {
    const promise = recallFor(text).catch(() => []);
    pendingByAgent.set(agentSessionId, { promise, startedAt: Date.now(), text, consumed: false });
  };

  const attachAgent = (agent) => {
    const key = agent.session.id;
    if (agentDisposers.has(key)) return;
    const offInserted = agent.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (!PREFETCH_ENABLED) return;
      if (message?.source?.kind !== 'user') return;
      const text = extractText(message.content);
      if (text.length < PREFETCH_MIN_QUERY_CHARS) return;
      startRecall(key, text);
    });
    const offPreStep = agent.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      const st = pendingByAgent.get(key);
      if (!st || st.consumed) return decision;
      if (Date.now() - st.startedAt > PREFETCH_STALE_MS) {
        pendingByAgent.delete(key);
        return decision;
      }
      const remaining = Math.max(0, st.startedAt + PREFETCH_WAIT_MS - Date.now());
      const budget = Math.min(remaining, 2500);
      const items = await Promise.race([st.promise, sleep(budget, payload.signal).then(() => null)]);
      if (!Array.isArray(items)) return decision; // still in flight; a later step may pick it up
      st.consumed = true;
      pendingByAgent.delete(key);
      if (items.length === 0) return decision;
      const message = createUserMessage({
        content: [{ type: 'text', text: recallText(items) }],
        source: { kind: 'nebula', form: 'recall' },
      });
      return { ...decision, messages: [...decision.messages, message] };
    });
    agentDisposers.set(key, () => {
      offInserted?.();
      offPreStep?.();
      pendingByAgent.delete(key);
    });
  };

  ctx.effect(() => {
    const toolsFiber = ctx.inject(['tools'], (scope) => {
      scope.tools.register(nebulaSearchTool);
      scope.tools.register(nebulaAddTool);
      scope.tools.register(nebulaStatsTool);
      scope.tools.register(nebulaOutboxTool);
    });

    const offCreated = ctx.on('agent/created', ({ agent }) => {
      attachAgent(agent);
    });
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const dispose = agentDisposers.get(agent.session.id);
      if (dispose) {
        agentDisposers.delete(agent.session.id);
        dispose();
      }
    });
    for (const agent of ctx.agents.list()) attachAgent(agent);

    // 写入队列: 启动 15s 后首试, 之后每 30s 一拍; 卸载时停表
    outboxSchedule(OUTBOX_STARTUP_FLUSH_DELAY);

    return () => {
      offCreated?.();
      offDisposed?.();
      for (const dispose of agentDisposers.values()) dispose();
      agentDisposers.clear();
      pendingByAgent.clear();
      outboxStop();
      toolsFiber?.dispose?.();
    };
  }, 'nebula-memory: tools & recall');
}
