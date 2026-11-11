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
 * block a turn longer than their own budget.
 */

import { readFile } from 'node:fs/promises';
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
  timeoutMs: 20_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', description: 'Whether the memory was written.' },
        error: { type: 'string' },
        id: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.ok
        ? `已写入星云（id ${value.id}${value.status ? `，${value.status}` : ''}）`
        : `写入失败：${value.error || '未知错误'}`,
    }],
  },
  async execute(args) {
    const content = String(args?.content || '').trim();
    if (!content) return { ok: false, error: 'content 不能为空' };
    const device = await loadDeviceConfig();
    const body = {
      content: content.slice(0, 8000),
      ...(args?.scope ? { scope: String(args.scope) } : device.scope ? { scope: device.scope } : {}),
      ...(args?.tags ? { tags: String(args.tags) } : {}),
    };
    const res = await nebulaApi('POST', '/api/memories', body, BUDGET_WRITE_MS);
    const out = res.json;
    if (res.status >= 500 || !out) {
      return { ok: false, error: out?.error || res.error || `HTTP ${res.status}` };
    }
    return {
      ok: out.ok === true || res.status === 200 || res.status === 201,
      ...(out.id ? { id: String(out.id) } : {}),
      ...(out.status ? { status: String(out.status) } : {}),
      ...(!out.ok && out.error ? { error: String(out.error) } : {}),
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

    return () => {
      offCreated?.();
      offDisposed?.();
      for (const dispose of agentDisposers.values()) dispose();
      agentDisposers.clear();
      pendingByAgent.clear();
      toolsFiber?.dispose?.();
    };
  }, 'nebula-memory: tools & recall');
}
