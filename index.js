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
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// [NEBULA-TRACE] 调试插桩: 设置 env NEBULA_TRACE_FILE 开启, 默认关闭(零开销)
import { appendFileSync as __nebAppend, writeFileSync } from 'node:fs';
const __NEB_TRACE = process.env.NEBULA_TRACE_FILE || '';
function __nebTrace(m) { if (!__NEB_TRACE) return; try { __nebAppend(__NEB_TRACE, new Date().toISOString() + ' ' + m + '\n'); } catch {} }
// ---------------------------------------------------------------------------
// Harness package imports (resolved from the DSH installation, not the profile)
// ---------------------------------------------------------------------------

function isDshPackageDir(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg && typeof pkg.name === 'string' && pkg.name === '@deepseek-ai/dsh';
  } catch {
    return false;
  }
}

function dshRootCandidates() {
  const roots = [];
  const push = (r) => {
    if (r && !roots.includes(r)) roots.push(r);
  };
  if (process.env.DSH_ROOT) push(process.env.DSH_ROOT);
  // 从运行中的启动器推导 (npm -g / ~/.local / npx / homebrew 全适配):
  // argv[1] = dsh 入口 (常为 symlink) → realpath 向上找 @deepseek-ai/dsh 包根
  try {
    const arg1 = process.argv[1];
    if (arg1) {
      let cur = realpathSync(arg1);
      for (let i = 0; i < 8 && cur && cur !== '/'; i += 1) {
        const dir = dirname(cur);
        if (isDshPackageDir(dir)) {
          push(dir);
          break;
        }
        const nested = join(dir, 'node_modules', '@deepseek-ai', 'dsh');
        if (existsSync(join(nested, 'package.json'))) {
          push(nested);
          break;
        }
        cur = dir;
      }
    }
  } catch {
    // argv[1] 缺失或不可达: 落到静态候选
  }
  push('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh');
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
  push('/opt/local/lib/node_modules/@deepseek-ai/dsh');
  return roots;
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
// Tunables — 设备配置文件 + NEBULA_* 环境变量 (v1.5.0)
// 同步加载一次(模块加载期): $DSH_HOME/nebula-memory.json → ~/.dsh/nebula-memory.json
// 的 "tunables" 对象; env 覆盖文件, 文件覆盖默认。解析失败静默回退安全默认值。
// ---------------------------------------------------------------------------

const TUNABLE_SPECS = {
  recapMaxTokens:      { env: 'NEBULA_RECAP_MAX_TOKENS',      def: 2400, type: 'int' },
  recapMaxTurns:       { env: 'NEBULA_RECAP_MAX_TURNS',       def: 100,  type: 'int' },
  recapWindowMs:       { env: 'NEBULA_RECAP_WINDOW_MS',       def: 0,    type: 'int' },
  recapQueryChars:     { env: 'NEBULA_RECAP_QUERY_CHARS',     def: 1200, type: 'int' },
  prefetchLimit:       { env: 'NEBULA_PREFETCH_LIMIT',        def: 3,    type: 'int' },
  prefetchEntryChars:  { env: 'NEBULA_PREFETCH_ENTRY_CHARS',  def: 300,  type: 'int' },
  intraTurnRecall:     { env: 'NEBULA_INTRA_TURN_RECALL',     def: true, type: 'bool' },
  intraTurnRecallMax:  { env: 'NEBULA_INTRA_TURN_RECALL_MAX',  def: 2,    type: 'int' },
  compactionHandoff:   { env: 'NEBULA_COMPACTION_HANDOFF',    def: true, type: 'bool' },
  precisionEnabled:    { env: 'NEBULA_PRECISION',              def: true, type: 'bool' },
  precisionSkipFirstTurn: { env: 'NEBULA_PRECISION_SKIP_FIRST_TURN', def: true, type: 'bool' },
  precisionRetries:      { env: 'NEBULA_PRECISION_RETRIES',         def: 3,    type: 'int' },
  precisionCandidates: { env: 'NEBULA_PRECISION_CANDIDATES',   def: 12,   type: 'int' },
  precisionTopFull:    { env: 'NEBULA_PRECISION_TOP_FULL',     def: 3,    type: 'int' },
  precisionTopPointer: { env: 'NEBULA_PRECISION_TOP_POINTER',   def: 2,    type: 'int' },
  precisionBudgetMs:   { env: 'NEBULA_PRECISION_BUDGET_MS',    def: 20000, type: 'int' },
  precisionReviewChars:{ env: 'NEBULA_PRECISION_REVIEW_CHARS', def: 220,  type: 'int' },
};

function coerceTunable(spec, value) {
  if (value === undefined || value === null || value === '') return spec.def;
  if (spec.type === 'bool') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return spec.def;
  }
  if (spec.type === 'str') return String(value ?? '').trim();
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) return spec.def;
  return Math.floor(n);
}

/** 纯函数: 从 tunables 对象 + env 对象解析最终值(自检/测试用, 无 I/O)。 */
export function resolveTunables(fileTunables, env) {
  const file = (fileTunables && typeof fileTunables === 'object' && !Array.isArray(fileTunables)) ? fileTunables : {};
  const envs = (env && typeof env === 'object') ? env : {};
  const out = {};
  for (const [key, spec] of Object.entries(TUNABLE_SPECS)) {
    const snake = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    let value = spec.def;
    if (Object.prototype.hasOwnProperty.call(file, key)) value = file[key];
    else if (Object.prototype.hasOwnProperty.call(file, snake)) value = file[snake];
    if (Object.prototype.hasOwnProperty.call(envs, spec.env)) value = envs[spec.env];
    out[key] = coerceTunable(spec, value);
  }
  return out;
}

function readTunablesSync() {
  const path = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'nebula-memory.json')
    : join(homedir(), '.dsh', 'nebula-memory.json');
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    return (json && typeof json.tunables === 'object' && !Array.isArray(json.tunables)) ? json.tunables : {};
  } catch { return {}; }
}

/** 诊断对象: 模块加载时解析出的最终可调项(只读)。 */
export const nebulaTunables = Object.freeze(resolveTunables(readTunablesSync(), process.env));

const ROUTE_CAP_MS = 8000;            // per-route cap inside one call
const BUDGET_SEARCH_MS = 15000;       // total budget: failover across routes, then clean error
const BUDGET_WRITE_MS = 14000;        // write embeds + dedupes before answering
const BUDGET_STATS_MS = 12000;
const BUDGET_RECALL_MS = 10000;
const ROUTE_COOLDOWN_MS = 30_000;     // failed routes ride last for this long
const ROUTE_LAT_ALPHA = 0.4;          // EWMA factor for route latency

const PREFETCH_ENABLED = true;
const PREFETCH_MIN_QUERY_CHARS = 0;   // 0 = 不限制字数（全面召回）
const PREFETCH_MIN_SCORE = 0.72;      // BGE-M3 cosine band, same floor as hermes
const PREFETCH_LIMIT = nebulaTunables.prefetchLimit;         // max memories injected per turn (tunable)
const PREFETCH_ENTRY_CHARS = nebulaTunables.prefetchEntryChars; // truncate each entry (tunable)
const PREFETCH_WAIT_MS = 7000;        // max extra wait at pre-step for a slow recall (老机器 embedding 慢)
const PREFETCH_STALE_MS = 30_000;     // discard recall older than this

// --- 注入前精排 (复用 recap 辅助调用机制) ---
// 与 recap 同款: 一次独立 llm.stream 辅助调用 + 单条用户消息 + 一个回调工具。
// 上下文取主会话最近片段(当前用户消息/上一轮回答尾部/recap 摘要), 不复制完整会话历史、不写主会话。
// 打分只决定"注入哪些"; 不写 nebula_feedback —— 那是轮末观察到真实用处后的学习回路。
const PRECISION_ENABLED = nebulaTunables.precisionEnabled;                 // NEBULA_PRECISION=0 跳过
// 新会话首轮没有上一轮助手回答 / recap 摘要可作打分依据, 且实测首轮打分超时率最高 → 默认跳过
const PRECISION_SKIP_FIRST_TURN = nebulaTunables.precisionSkipFirstTurn;     // NEBULA_PRECISION_SKIP_FIRST_TURN=0 恢复首轮打分
const PRECISION_CANDIDATES = Math.max(1, nebulaTunables.precisionCandidates); // 粗召回 N —— 成本主旋钮
const PRECISION_TOP_FULL = Math.max(1, Math.min(PRECISION_CANDIDATES, nebulaTunables.precisionTopFull));
const PRECISION_TOP_POINTER = Math.max(0, nebulaTunables.precisionTopPointer);
const PRECISION_REVIEW_CHARS = Math.max(60, nebulaTunables.precisionReviewChars);
const PRECISION_MAX_TOKENS = 4000;    // 实测 800 会让模型在发出工具调用前触顶(no-tool-call/max-tokens); 恢复已知可用的 4000
const PRECISION_RETRIES = Math.max(0, nebulaTunables.precisionRetries); // 解析失败重试次数(不含首次), 默认 3
const PRECISION_BUDGET_MS = Math.max(1000, nebulaTunables.precisionBudgetMs); // 所有尝试共享总预算, 超时 → 回退向量分
const PRECISION_CACHE_TTL_MS = 10 * 60_000;
const PRECISION_CACHE_MAX = 200;
const PRECISION_LOG_NAME = 'nebula-precision.jsonl';
const PRECISION_LOG_KEEP = 3000;

// --- session-RAG 指针腿 (会话段索引, 对齐 hermes MEM_INTERACTION §3.1) ---
// 与 mem 腿并行、独立预算、失败静默; RRF(k=60) 排名融合取 session 侧 top-N,
// 只注入"指针行"(时间/主题/设备 + session_id), 不注原文——原文经指针下钻。
// 选法用 RRF 排名而非硬阈值: 实测 0.75 阈值 session 召回仅 0.33, RRF 达 0.82。
const PREFETCH_SESSION_ENABLED = true;
const PREFETCH_SESSION_LIMIT = 2;     // max pointer lines per turn
const PREFETCH_SESSION_FETCH = 8;     // candidates fetched from the session index
const PREFETCH_SESSION_BUDGET_MS = 7000; // independent budget for the session leg
const PREFETCH_SESSION_PREVIEW = 300; // preview chars fetched for pointer building
const SESSION_SEARCH_TOOL_PREVIEW = 1500; // 下钻工具的正文预览长度

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

// --- 负反馈闭环 (v1.4.0) ---
// recap 辅助轮里让模型对本轮注入的知识逐条打分; 插件按查询主题条件降权 + 上报服务端。
const FEEDBACK_ENABLED = true;
const FEEDBACK_NEG_BELOW = 0.4;        // score < 0.4 → 负反馈
const FEEDBACK_POS_ABOVE = 0.7;        // score >= 0.7 → 正反馈(恢复权重)
const FEEDBACK_NEG_FACTOR = 0.6;       // 每次负反馈乘法系数
const FEEDBACK_POS_FACTOR = 1.25;      // 每次正反馈乘法系数
const FEEDBACK_MIN_FACTOR = 0.12;      // 降权下限(不彻底拉黑)
const FEEDBACK_MAX_FACTOR = 1.0;       // 不超过原始分
const FEEDBACK_TOPIC_JACCARD = 0.3;    // 条件匹配门槛: 当前 query 与历史反馈 token 的 Jaccard
const FEEDBACK_TOPIC_TOKENS = 28;      // 单条最多保留的主题 token 数
const FEEDBACK_REVIEW_CHARS = 220;     // recap 给模型看的每条知识摘要长度
const FEEDBACK_MAX_ITEMS = 6;          // recap 最多评分条数
const FEEDBACK_LOG_NAME = 'nebula-feedback.jsonl';
const FEEDBACK_LOG_KEEP = 3000;        // 本地审计日志保留行数
const BUDGET_FEEDBACK_MS = 5000;       // 服务端上报预算(失败静默)

let feedbackRecords = [];              // {id, tokens, useful, score, ts, query}
let feedbackLoadedAt = 0;
let recentTokens = [];                 // 最近一次用户查询的主题 token(显式工具兜底)

function feedbackLogPath() { return join(dshHome(), FEEDBACK_LOG_NAME); }

/** 主题 token: ASCII 复合词 + CJK 二元组。两端同规则, 用于条件降权匹配。 */
function feedbackTokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_.\-/]{2,}/g)) out.add(m[0]);
  for (const seg of (s.match(/[\u4e00-\u9fff]+/g) || [])) {
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out].slice(0, FEEDBACK_TOPIC_TOKENS);
}

function tokenJaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

async function loadFeedbackRecords() {
  if (feedbackLoadedAt && Date.now() - feedbackLoadedAt < 60_000) return;
  feedbackLoadedAt = Date.now();
  try {
    const txt = await readFile(feedbackLogPath(), 'utf8');
    feedbackRecords = txt.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).slice(-FEEDBACK_LOG_KEEP);
  } catch {
    feedbackRecords = [];
  }
}

/** 某条记忆 + 当前查询主题的降权系数 (乘法, 1 = 不变)。 */
async function feedbackFactor(id, queryTokens) {
  if (!FEEDBACK_ENABLED || !id) return 1;
  await loadFeedbackRecords();
  let f = 1;
  for (const rec of feedbackRecords) {
    if (rec.id !== id || !Array.isArray(rec.tokens)) continue;
    if (tokenJaccard(queryTokens, rec.tokens) < FEEDBACK_TOPIC_JACCARD) continue;
    const useful = rec.useful === true || Number(rec.score) >= FEEDBACK_POS_ABOVE;
    f *= useful ? FEEDBACK_POS_FACTOR : FEEDBACK_NEG_FACTOR;
  }
  return Math.min(FEEDBACK_MAX_FACTOR, Math.max(FEEDBACK_MIN_FACTOR, f));
}

/** 召回结果按反馈降权重排。 */
async function applyFeedback(items, query) {
  if (!FEEDBACK_ENABLED || !items.length) return items;
  const qt = feedbackTokens(query);
  const out = [];
  for (const it of items) {
    // 服务端 /api/memories/search 已应用降权并返回 feedback_factor:
    // 这里只重排不再乘, 避免双重降权(0.6→0.36); 离线/旧服务端回退到本地计算。
    const sf = typeof it.feedback_factor === 'number' ? it.feedback_factor : null;
    const f = sf !== null ? sf : await feedbackFactor(it.id, qt);
    const score = typeof it.score === 'number' ? it.score : 0;
    out.push({ ...it,
      rawScore: sf !== null && f > 0 ? score / f : (it.rawScore !== undefined ? it.rawScore : score),
      feedbackFactor: f,
      feedback_factor: f,
      score: sf !== null ? score : score * f });
  }
  out.sort((a, b) => (b.score || 0) - (a.score || 0));
  return out;
}

/** 写一条反馈: 本地 JSONL(审计+即时生效) + 异步上报服务端(跨设备)。 */
async function recordFeedback(id, score, query, queryTokens) {
  if (!FEEDBACK_ENABLED || !id || typeof score !== 'number') return;
  const useful = score >= FEEDBACK_POS_ABOVE;
  const negative = score < FEEDBACK_NEG_BELOW;
  if (!useful && !negative) return; // 中间分不动权重
  const tokens = Array.isArray(queryTokens) && queryTokens.length ? queryTokens : recentTokens;
  const rec = { id, score, useful, tokens, ts: Date.now(), query: String(query || '').slice(0, 160) };
  feedbackRecords.push(rec);
  if (feedbackRecords.length > FEEDBACK_LOG_KEEP) {
    feedbackRecords.splice(0, feedbackRecords.length - FEEDBACK_LOG_KEEP);
  }
  try {
    await appendFile(feedbackLogPath(), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 本地审计失败不影响主流程 */ }
  __nebTrace('feedback ' + id + ' score=' + score + ' useful=' + useful);
  void nebulaApi('POST', '/api/memories/feedback', {
    id, score, useful, tokens, query: rec.query,
  }, BUDGET_FEEDBACK_MS).catch(() => {});
}

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
  const cfg = { baseUrl: '', fallbacks: [], token: '', scope: '', recapProvider: '', recapModel: '' };

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

  // recap 轻量路由(可选): 显式配置优先于前台路由 (graph-memory 同款纪律)
  if (!cfg.recapProvider && dshFile && typeof dshFile.recap_provider === 'string' && dshFile.recap_provider.trim()) {
    cfg.recapProvider = dshFile.recap_provider.trim();
  }
  if (!cfg.recapModel && dshFile && typeof dshFile.recap_model === 'string' && dshFile.recap_model.trim()) {
    cfg.recapModel = dshFile.recap_model.trim();
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
    if (la === undefined) return 1;   // 未知延迟排最后(避免不可达兜底被优先试)
    if (lb === undefined) return -1;
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
  const __order = routeOrder(routes);
  __nebTrace('api ' + method + ' ' + String(path).slice(0, 36) + ' order=' + JSON.stringify(__order));
  for (const base of __order) {
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
      __nebTrace('api ok ' + base + ' ' + (Date.now() - started) + 'ms');
      noteRoute(base, true, Date.now() - started);
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch (error) {
      __nebTrace('api fail ' + base + ' :: ' + (error instanceof Error ? error.message : String(error)));
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

const RECAP_RETURN_SCHEMA = {
  name: 'nebula_recap_return',
  description: '轮末总结轮(nebula recap)专用回调工具: 把刚结束的会话轮总结交给星云记忆插件。仅在 recap 轮调用一次。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      content: { type: 'string', description: '本次会话轮收尾总结: 任务/关键结论与决策(含数字、配置值)/未完成事项/下一步推进方向/3-6个检索关键词。500字内, 自含, 不引用本机路径。' },
      outcome: { type: 'string', enum: ['done', 'partial', 'blocked', 'noconclusion'], description: '本轮完成度: done=达成 / partial=部分完成 / blocked=受阻 / noconclusion=无明确结论。' },
      ratings: {
        type: 'array',
        description: '对本轮注入的知识逐条打用处分。必须覆盖【本轮召回的知识】里列出的每个 id；漏评的条目保持原权重。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: '注入条目 id，原样复制，不要改写。' },
            score: { type: 'number', description: '0..1: 1=确实帮上忙 / 0.5=有点相关但没帮上 / 0=完全没用或误导。' },
          },
          required: ['id', 'score'],
        },
      },
    },
    required: ['content'],
  },
};

const recapReturnTool = {
  ...RECAP_RETURN_SCHEMA,
  timeoutMs: 10_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        queued: { type: 'boolean' },
        error: { type: 'string' },
      },
      required: ['ok', 'queued'],
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: value && value.ok ? 'recap 总结已交给星云记忆插件(异步入队)' : 'recap 回调未入队: ' + ((value && value.error) || '未知原因'),
  }],
  async execute(args, meta) {
    const content = String(args?.content || '').trim();
    if (!content) return { ok: false, queued: false, error: 'content 不能为空' };
    const key = (meta && meta.session && meta.session.id) || activeRecapKey || '';
    const outcome = String(args?.outcome || '').trim();
    try {
      await captureRecap(key, content, outcome);
      return { ok: true, queued: true };
    } catch (error) {
      return { ok: true, queued: true, error: 'queue: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
};

const nebulaFeedbackTool = {
  name: 'nebula_feedback',
  description: '显式反馈某条召回知识的用处: 打 0..1 分。0=完全没用/误导, 1=确实有用。低于 0.4 降低它与当前话题的关联度, 高于 0.7 恢复; 通常由 recap 轮自动完成, 这里用于模型主动纠正。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string', description: '知识条目 id（来自召回注入或 nebula_search）' },
      score: { type: 'number', description: '0..1 用处分' },
      query: { type: 'string', description: '当前查询/话题, 用于按主题条件降权; 不传则用最近一次查询。' },
    },
    required: ['id', 'score'],
  },
  timeoutMs: 10_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        id: { type: 'string' },
        useful: { type: 'boolean' },
        error: { type: 'string' },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.ok
        ? ('已记录反馈: ' + value.id + (value.useful ? ' (有用, 提权)' : ' (没用, 降权)'))
        : ('反馈失败: ' + ((value && value.error) || '未知原因')),
    }],
  },
  async execute(args) {
    const id = String(args?.id || '').trim();
    const sc = Number(args?.score);
    if (!id || !Number.isFinite(sc)) return { ok: false, error: 'id 和 0..1 的 score 必填' };
    const score = Math.max(0, Math.min(1, sc));
    const q = String(args?.query || '');
    await recordFeedback(id, score, q, q ? feedbackTokens(q) : recentTokens);
    return { ok: true, id, useful: score >= FEEDBACK_POS_ABOVE };
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

const nebulaSessionSearchTool = {
  name: 'nebula_session_search',
  description:
    '在会话 RAG 库检索历史会话原文片段——四端(Hermes/Claude Code/Codex/pi 等)的历史对话都已切段入库。' +
    '当上下文出现「📂 会话: … [session_id]」指针行需要看原文, 或要查"以前那次是怎么做的/当时结论"时调用。' +
    '要查根因/硬约束等结论性知识用 nebula_search（经验优先），本工具查的是历史对话原文。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      query: {
        type: 'string',
        description:
          '尽量详细的自然语言描述：主题+现象/场景+技术细节(组件/模型/文件/报错)+因果或结论指向；' +
          '别只甩关键词——细节越多命中越准，只给名词会退化成关键字匹配、混入高频词假阳。',
      },
      limit: { type: 'integer', description: '返回段数，默认 6，最大 20。' },
      device: { type: 'string', description: '限定设备，例如 liheng-mac / viture / leon-pc / lenovo-book；不传则全库。' },
      agent: { type: 'string', description: '限定 agent 来源，例如 hermes / claude / codex / pi；不传则全库。' },
    },
    required: ['query'],
  },
  timeoutMs: 20_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        error: { type: 'string' },
        total: { type: 'integer' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_id: { type: 'string' },
              agent: { type: 'string' },
              device: { type: 'string' },
              ts_iso: { type: 'string' },
              doc_id: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['session_id', 'text'],
          },
        },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.ok === false
        ? `会话检索失败：${value.error || '未知错误'}`
        : (!Array.isArray(value.items) || value.items.length === 0
          ? '（会话库中没有相关片段）'
          : value.items
            .map((it, i) => {
              const meta = [it.agent || '?', it.device || '?', String(it.ts_iso || '').slice(0, 19), it.doc_id || ''].filter(Boolean).join(' | ');
              return `(${i + 1}) ${meta}\n${truncate(it.text || it.text_preview || '', SESSION_SEARCH_TOOL_PREVIEW)}`;
            })
            .join('\n\n')),
    }],
  },
  async execute(args) {
    const limit = Math.max(1, Math.min(20, Number(args?.limit) || 6));
    const items = await sessionSearch(String(args?.query || ''), Math.max(limit, 6), {
      preview: SESSION_SEARCH_TOOL_PREVIEW,
      rerank: true, // 工具调用开精排(与 hermes 同语义); 预取指针腿才用 rerank=0
      budgetMs: BUDGET_SEARCH_MS,
    });
    return {
      ok: true,
      total: items.length,
      items: items.slice(0, limit).map((it) => ({
        session_id: String(it.session_id || ''),
        text: truncate(it.text || it.text_preview || '', SESSION_SEARCH_TOOL_PREVIEW),
        ...(it.agent ? { agent: String(it.agent) } : {}),
        ...(it.device ? { device: String(it.device) } : {}),
        ...(it.ts_iso ? { ts_iso: String(it.ts_iso) } : {}),
        ...(it.doc_id ? { doc_id: String(it.doc_id) } : {}),
      })),
    };
  },
};

const nebulaSessionReadTool = {
  name: 'nebula_session_read',
  description:
    '按 session_id 取出某个历史会话的全部段落(时间序)，用于深度下钻：' +
    '先用 nebula_session_search（或召回指针行）定位会话，再用本工具读完整上下文。',
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      session_id: { type: 'string', description: '从指针行或 search 结果里取的会话 id。' },
      limit: { type: 'integer', description: '最多返回段数，默认 20，最大 50。' },
    },
    required: ['session_id'],
  },
  timeoutMs: 20_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        error: { type: 'string' },
        session_id: { type: 'string' },
        count: { type: 'integer' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              doc_id: { type: 'string' },
              ts_iso: { type: 'string' },
              agent: { type: 'string' },
              device: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.ok === false
        ? `取会话失败：${value.error || '未知错误'}`
        : (!value.items || value.items.length === 0
          ? `会话 ${value.session_id} 没有段落 (session_id 可能不对)。`
          : `会话 ${value.session_id}: ${value.items.length} 段 (时间序):\n\n`
            + value.items
              .map((it, i) => {
                const meta = [it.agent || '?', it.device || '?', String(it.ts_iso || '').slice(0, 19), it.doc_id || ''].filter(Boolean).join(' | ');
                return `(${i + 1}) ${meta}\n${truncate(it.text || '', SESSION_SEARCH_TOOL_PREVIEW)}`;
              })
              .join('\n\n')),
    }],
  },
  async execute(args) {
    const sid = String(args?.session_id || '').trim();
    if (!sid) return { ok: false, error: 'session_id 不能为空' };
    const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
    const out = await sessionFull(sid, limit);
    if (out.error) return { ok: false, error: out.error, session_id: sid };
    return {
      ok: true,
      session_id: sid,
      count: out.items.length,
      items: out.items.map((it) => ({
        text: truncate(it.text || it.text_preview || '', SESSION_SEARCH_TOOL_PREVIEW),
        ...(it.doc_id ? { doc_id: String(it.doc_id) } : {}),
        ...(it.ts_iso ? { ts_iso: String(it.ts_iso) } : {}),
        ...(it.agent ? { agent: String(it.agent) } : {}),
        ...(it.device ? { device: String(it.device) } : {}),
      })),
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
// Session RAG — 会话段检索/下钻 + 预取指针腿
// ---------------------------------------------------------------------------

async function sessionSearch(query, fetch, { preview = 300, rerank = false, budgetMs = 15000 } = {}) {
  const q = encodeURIComponent(String(query || '').slice(0, 2000));
  const url = `/api/session-rag/search?q=${q}&limit=${Math.max(fetch, 4)}&rerank=${rerank ? 1 : 0}&preview=${Math.round(preview)}`;
  const res = await nebulaApi('GET', url, undefined, budgetMs);
  const body = res.json;
  if (res.status >= 400 && res.status < 500) return []; // 端点缺失/参数错: 不试下一路(同一后端)
  if (!body || !Array.isArray(body.items)) return [];
  return body.items.filter((it) => it && typeof it === 'object');
}

async function sessionFull(sessionId, limit) {
  const url = `/api/session-rag/session?session_id=${encodeURIComponent(sessionId)}&limit=${limit}`;
  const res = await nebulaApi('GET', url, undefined, BUDGET_SEARCH_MS);
  const body = res.json;
  if (!body) return { error: res.error || `HTTP ${res.status}` };
  const items = body.items || body.docs || [];
  return { items: Array.isArray(items) ? items : [] };
}

function sessionTopicOf(it) {
  const txt = it.text_preview || it.text || '';
  const m = /topic=([^\]]*)\]/.exec(txt);
  if (m) return m[1].trim();
  const body = txt.includes('\n') ? txt.split('\n').slice(1).join('').trim() : txt.trim();
  return truncate(body, 60);
}

function pointerLine(it) {
  const ts = String(it.ts_iso || '').slice(0, 10);
  const topic = sessionTopicOf(it).slice(0, 70);
  const head = [it.agent, it.device].filter(Boolean).join(' / ');
  let line = `📂 会话: ${ts} ${topic}`;
  if (head) line += ` (${head})`;
  line += ' — 需要细节用 nebula_session_search 下钻';
  const sid = it.session_id || '';
  if (sid) line += ` [${sid}]`;
  return truncate(line, 200);
}

// RRF(k=60) 融合 mem/session 两路排名, 取 session 侧前 limit 条 (按 session 去重)。
// 只用排名不用绝对分: 规避 BGE-M3 余弦窄带 (相关/跑题都落 0.70-0.76)。
function rrfSessionPick(memItems, sessItems, limit) {
  const k = 60;
  const scored = [];
  memItems.forEach((_it, rank) => scored.push({ side: 'm', rank, v: 1 / (k + rank + 1) }));
  sessItems.forEach((_it, rank) => scored.push({ side: 's', rank, v: 1 / (k + rank + 1) }));
  scored.sort((a, b) => b.v - a.v);
  const picked = [];
  const seen = new Set();
  for (const s of scored) {
    if (s.side !== 's') continue;
    const it = sessItems[s.rank];
    const sid = (it && it.session_id) || '';
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    picked.push(it);
    if (picked.length >= limit) break;
  }
  return picked;
}

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

async function recallMemLeg(query) {
  const routes = await loadRoutes();
  if (routes.length === 0) return []; // 未配置: 静默跳过
  // v1.6.6: 写队列(outbox)失败也会把路由打入冷却; 读召回不能因此直接返回空,
  // 否则精排永远拿不到候选。冷却路由仍排在后面尝试, 由请求预算兜底。
  // 纯向量路端点: score = BGE-M3 余弦 (0..1), 与 hermes prefetch 的 0.72 窄带阈值同语义。
  // /search 是 RRF+rerank 融合路, score 为 rerank logit(负值), 不能用过阈值筛。
  const q = encodeURIComponent(query.slice(0, 2000));
  __nebTrace('recallMem q=' + String(query).slice(0,30));
  // 精排开启时粗召回放大到 N 条 (召回管 recall, 精排管 precision); 未开启保持原行为。
  const want = PRECISION_ENABLED ? Math.max(PRECISION_CANDIDATES, PREFETCH_LIMIT + 2) : PREFETCH_LIMIT + 2;
  const res = await nebulaApi('GET', '/api/memories/search?q=' + q + '&limit=' + want, undefined, BUDGET_RECALL_MS).catch((e) => { __nebTrace('ERR memSearch: ' + (e && e.message || e)); return {}; });
  const body = res.json;
  if (!body || body.ok !== true || !Array.isArray(body.items)) return [];
  const kept = body.items
    .filter((it) => typeof it.score === 'number' && it.score >= PREFETCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, want);
  const ranked = await applyFeedback(kept, query); // 负反馈: 按查询主题条件降权
  return ranked.slice(0, want);                    // 精排在 pre-step 侧决定真正注入哪些
}

async function recallSessionLeg(query) {
  const routes = await loadRoutes();
  if (routes.length === 0) return [];
  // v1.6.6: 同 recallMemLeg, 写失败导致的冷却不应让读召回空转
  // 指针腿不走 rerank（独立预算, 不能被精排拖）, preview 只要够拼指针行
  return sessionSearch(query, PREFETCH_SESSION_FETCH, {
    preview: PREFETCH_SESSION_PREVIEW,
    rerank: false,
    budgetMs: PREFETCH_SESSION_BUDGET_MS,
  });
}

function recallText(memItems, ptrs, memPointers) {
  const lines = ['[星云记忆自动召回] 以下条目来自知识星云，与当前输入语义相关，由系统自动注入（不是用户说的话）：'];
  memItems.forEach((it, i) => {
    const score = typeof it.score === 'number' ? it.score.toFixed(2) : '?';
    const fine = it.precisionSelected ? ' · 精排选中' : (typeof it.precisionScore === 'number' ? ' · 精排 ' + it.precisionScore.toFixed(2) : '');
    const scope = it.scope ? ` · ${it.scope}` : '';
    lines.push(`${i + 1}. (${score}${fine}${scope}) ${truncate(it.content, PREFETCH_ENTRY_CHARS)}`);
  });
  for (const it of memPointers || []) {
    const id = String(it.id || '');
    const hint = truncate(String(it.content || '').replace(/\s+/g, ' '), 70);
    if (!id || !hint) continue;
    lines.push(`📌 [次高分·指针] id=${id} ${hint}… — 需要全文用 nebula_search 按上面短语检索`);
  }
  for (const it of ptrs || []) {
    const line = pointerLine(it);
    if (line) lines.push(line);
  }
  lines.push('历史记忆细节用 nebula_search、会话原文用 nebula_session_search 下钻。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Recap turn (轮末总结轮 - agent/turn-stopping 触发的辅助 LLM 请求)
// 设计: 主轮结束(收件箱空、无 steering)后, 插件追加一次独立 LLM 请求(复用 compaction 的
// ctx.llm.stream 机制, purpose:'nebula-recap', 不并入主会话、不进入可见轮次);
// 请求只携带一个回调工具 schema nebula_recap_return, 云端把本轮总结经工具参数交回插件;
// 总结按会话ID关联入队星云(异步入队, 断网不丢), 并缓存为下一轮自动召回的拼接语料:
// 下一条用户消息触发召回时把 recap 摘要拼进检索 query, 提升代词型短消息的召回命中。
// ---------------------------------------------------------------------------

const RECAP_ENABLED = true;
const RECAP_MIN_CHARS = 0;            // 0 = 不限制字数（与召回门槛一致）
const RECAP_MAX_TURNS = nebulaTunables.recapMaxTurns;       // 0 = 不限次数
const RECAP_MAX_WINDOW_MS = nebulaTunables.recapWindowMs;   // 0 = 不限时长
const RECAP_BUDGET_MS = 30_000;       // recap 请求整体预算
const RECAP_MAX_TOKENS = nebulaTunables.recapMaxTokens;
const RECAP_USER_SNIPPET = 1500;      // recap 请求携带的末条用户消息长度
const RECAP_ASST_SNIPPET = 2200;      // recap 请求携带的末条助手回答尾部
const RECAP_ENTRY_CHARS = 2400;       // 缓存/入队的总结长度上限
const RECAP_QUERY_CHARS = nebulaTunables.recapQueryChars;  // 拼进检索 query 的 recap 摘要尾部上限
const RECAP_QUERY_DELAY_MS = 1500;    // recap 到达后留给查询增强的等待窗口
const RECAP_PROMPT_MAX_CHARS = 6000;  // recap prompt 总长度上限

// v1.5.0 新能力开关(均有安全默认, 可经 tunables 文件 / NEBULA_* env 关闭)
const INTRA_TURN_RECALL = nebulaTunables.intraTurnRecall;
const INTRA_TURN_RECALL_MAX = nebulaTunables.intraTurnRecallMax;
const COMPACTION_HANDOFF = nebulaTunables.compactionHandoff;

const turnState = new Map();     // agent session id -> recap 状态机
const recapBuf = new Map();      // agent session id -> 最近 recap 摘要(下轮召回拼接用)
const pendingRecall = new Set(); // 有 recap 待下轮召回消费的 agent session id
const recapQueryTail = new Map(); // agent session id -> recap 摘要尾部(检索查询增强用); 消费后即删
const recapProbe = new Map();    // key -> {text, at} 最近一次注入的 recap(供下轮 consumed 观测)
const injectedByAgent = new Map(); // key -> {items, query, tokens, at} 本轮注入的知识, 供 recap 轮打分反馈
const postCompactionPending = new Map(); // session id -> {at, ids[]} 压缩完成, 下一 step 注入交接块
const compactionEnq = new Map();         // session id -> [outbox key] 本会话刚入队的交接/摘要记忆
let recapReqSeq = 0;             // recap 请求序号(新请求使旧请求流失效)
let recapInflight = false;       // 同一时刻只允许一个 recap 请求
let activeRecapKey = '';         // 当前 recap 请求所属会话(回调工具兜底用)

function recapLog(kind, msg) {
  const line = '[nebula-recap] ' + String(msg);
  if (kind === 'warn') console.warn(line); else console.info(line);
}

function recapPrompt(userText, asstTail, nebulaSid, injected, evidence) {
  let user = String(userText || '').slice(0, RECAP_USER_SNIPPET);
  let asst = String(asstTail || '').slice(-RECAP_ASST_SNIPPET);
  let toolErrors = String((evidence && evidence.toolErrors) || '').slice(-1800);
  const toolCalls = Array.isArray(evidence && evidence.toolCalls) ? evidence.toolCalls.slice(0, 6) : [];
  const head = [
    '[nebula recap 轮] 主对话刚刚结束。这是收尾总结请求, 不属于主对话:',
    '你的输出不会被用户看到, 也不会写入主会话历史。',
    '唯一动作: 调用一次工具 nebula_recap_return, 在 content 给出收尾总结, 在 outcome 给完成度(done/partial/blocked/noconclusion), 并在 ratings 里对本轮注入的知识逐条打分; 不要调用其他工具, 不要输出多余正文。',
    '',
    'content 要求(500字内, 自含, 不引用本机路径): 1)本轮任务/问题一句话; 2)关键结论/决策/配置值(有数字给数字); 3)未完成事项与下一步; 4)3-6个检索关键词。',
    '',
  ];
  const tail = [];
  if (nebulaSid) tail.push('【关联会话ID】' + nebulaSid);
  if (injected && Array.isArray(injected.items) && injected.items.length) {
    tail.push('', '【本轮召回的知识 — 请逐条给 ratings 打分(必填)】');
    injected.items.forEach((it, i) => {
      const sc = typeof it.score === 'number' ? it.score.toFixed(2) : '?';
      tail.push((i + 1) + '. id=' + it.id + ' [相似度 ' + sc + '] ' + it.content);
    });
    tail.push('评分: 1=确实帮上本轮回答 / 0.5=有点相关但没帮上 / 0=完全没用或误导; 每个 id 都要给分。');
  }
  const build = () => [
    ...head,
    '【用户最后消息】' + user,
    '【助手最后回答(尾部)】' + (asst || '(无)'),
    ...tail,
    '【本轮工具错误/关键结果】' + (toolErrors || '(无)'),
    '【本轮工具调用】' + (toolCalls.length ? toolCalls.join(' | ') : '(无)'),
  ].join('\n');
  let out = build();
  // 硬上限 ~6000 字: 先压证据, 再压回答/用户尾部, 保住开头的指令与 ratings 段
  let guard = 0;
  while (out.length > RECAP_PROMPT_MAX_CHARS && guard++ < 16) {
    if (toolErrors.length > 200) toolErrors = toolErrors.slice(-Math.max(200, toolErrors.length - 400));
    else if (asst.length > 300) asst = asst.slice(-Math.max(300, asst.length - 400));
    else if (user.length > 200) user = user.slice(0, Math.max(200, user.length - 400));
    else break;
    out = build();
  }
  return out.length > RECAP_PROMPT_MAX_CHARS ? out.slice(0, RECAP_PROMPT_MAX_CHARS) : out;
}

function assistantTextOf(message) {
  try {
    const content = message && message.content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  } catch { return ''; }
}

/** 会话是否已有历史轮次: 宿主重启后 turnCount 归零, 不能只靠它判断首轮。 */
function hasPriorConversation(agent) {
  try {
    const session = agent && agent.session;
    const log = session && Array.isArray(session.log) ? session.log : null;
    if (!log) return false;
    let users = 0;
    for (const ev of log) {
      const msg = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(ev) : null;
      if (!msg) continue;
      if (msg.role === 'assistant') return true;
      if (msg.role === 'user' && ++users >= 2) return true;
    }
  } catch { /* 派生失败按新会话保守处理 */ }
  return false;
}

/** 从会话日志尾部取最近 assistant 文本(最多数条拼接), 供 recap 请求参考。 */
function lastAssistantTail(agent, want) {
  try {
    const session = agent && agent.session;
    const log = session && Array.isArray(session.log) ? session.log : null;
    if (!log) return '';
    let out = '';
    for (let i = log.length - 1; i >= 0 && out.length < want; i -= 1) {
      const msg = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(log[i]) : null;
      if (!msg || msg.role !== 'assistant') continue;
      const t = assistantTextOf(msg);
      if (t) out = out ? t + '\n' + out : t;
    }
    return out.slice(-want);
  } catch { return ''; }
}

/** 从会话日志倒序收集最近的工具错误/关键结果(默认末 1800 字), 供 recap 参考。 */
function lastToolErrorTail(agent, want = 1800) {
  try {
    const session = agent && agent.session;
    const log = session && Array.isArray(session.log) ? session.log : null;
    if (!log) return '';
    const parts = [];
    for (let i = log.length - 1; i >= 0 && parts.join('\n').length < want; i -= 1) {
      const ev = log[i];
      if (!ev || ev.type !== 'tool/result') continue;
      const data = ev.data || {};
      const msg = data.message || {};
      const hasError = msg.isError === true || (data.error !== undefined && data.error !== null && data.error !== '');
      if (!hasError) continue;
      let t = extractText(msg.content);
      if (!t && typeof data.error === 'string') t = data.error;
      if (!t && data.error) { try { t = JSON.stringify(data.error); } catch {} }
      if (!t && typeof msg.text === 'string') t = msg.text;
      if (t) parts.push(truncate(t, 600));
    }
    return parts.join('\n').slice(-want);
  } catch { return ''; }
}

/** 最近 ~6 次工具调用的名称 + 参数片段(截断), 让 recap 知道本轮实际试过什么。 */
function lastToolCalls(agent, want = 6) {
  try {
    const session = agent && agent.session;
    const log = session && Array.isArray(session.log) ? session.log : null;
    if (!log) return [];
    const out = [];
    for (let i = log.length - 1; i >= 0 && out.length < want; i -= 1) {
      const ev = log[i];
      if (!ev) continue;
      const data = ev.data || {};
      const type = String(ev.type || '');
      let name = '';
      let args = '';
      if (/^tool\/(call|start|request)$/.test(type) || type === 'tool-call' || type === 'tool_use') {
        name = String(data.name || data.toolName || data.tool || '');
        args = typeof data.args === 'string' ? data.args
          : (data.arguments !== undefined ? JSON.stringify(data.arguments) : '');
      }
      if (!name) {
        const msg = (typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(ev) : data.message);
        const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
        for (const b of blocks) {
          if (b && (b.type === 'tool-call' || b.type === 'tool_use')) {
            name = String(b.name || b.toolName || '');
            args = typeof b.arguments === 'string' ? b.arguments : (b.args ? JSON.stringify(b.args) : '');
            if (name) break;
          }
        }
      }
      if (name) out.unshift((i + 1) + '. ' + truncate(name, 40) + (args ? ' ' + truncate(args, 120) : ''));
    }
    return out;
  } catch { return []; }
}

/** 压缩前快照: 最近对话 + 当前注入的记忆(带 id), 供摘要器保留连续性。 */
function compactionContinuityText(session) {
  const lines = [
    '## Memory Continuity (preserve across compaction)',
    '以下是压缩前必须保留的事实、记忆 id 与决策; 生成摘要时请原样保留条目 id 与关键数字, 不要丢弃。',
  ];
  try {
    const log = session && Array.isArray(session.log) ? session.log : [];
    const recent = [];
    for (let i = log.length - 1; i >= 0 && recent.length < 8; i -= 1) {
      const msg = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(log[i]) : null;
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const t = extractText(msg.content) || (typeof msg.text === 'string' ? msg.text : '');
      if (!t) continue;
      recent.unshift(msg.role + ': ' + truncate(t, 600));
    }
    if (recent.length) lines.push('', '【最近 8 条用户/助手消息】', ...recent);
  } catch { /* observe-only: 派生消息失败不影响快照 */ }
  const injected = injectedByAgent.get(session && session.id);
  if (injected && Array.isArray(injected.items) && injected.items.length) {
    lines.push('', '【当前注入的星云记忆(保留 id)】');
    for (const it of injected.items) {
      const id = String(it.id || '');
      if (id) lines.push('- [' + id + '] ' + truncate(it.content, 300));
    }
  }
  lines.push('', '需要细节时用 nebula_search / nebula_session_search 下钻。');
  return lines.join('\n');
}

// 交接文件容量护栏: 每会话一份会随会话数/压缩次数无限增长, 按数量+时间双上限清理。
const HANDOFF_KEEP_MAX = 20;
const HANDOFF_TTL_MS = 7 * 24 * 3600_000;
function pruneHandoffFiles(keepPath) {
  try {
    const dir = dshHome();
    const now = Date.now();
    const files = readdirSync(dir)
      .filter((n) => /^nebula-compaction-handoff-session-.*\.json$/.test(n))
      .map((n) => { const p = join(dir, n); return { p, m: statSync(p).mtimeMs }; })
      .filter((f) => f.p !== keepPath)
      .sort((a, b) => b.m - a.m);
    let removed = 0;
    files.forEach((f, i) => {
      if (i >= HANDOFF_KEEP_MAX - 1 || now - f.m > HANDOFF_TTL_MS) {
        try { unlinkSync(f.p); removed += 1; } catch { /* 单文件删除失败不影响主流程 */ }
      }
    });
    if (removed) __nebTrace('compaction handoff pruned ' + removed + ' files');
  } catch { /* 清理失败不影响写入 */ }
}

/** 同步落盘交接文件(摘要器启动前必须完成): 全局一份 + 每会话一份。 */
function writeCompactionHandoff(payload) {
  try {
    const data = JSON.stringify(payload, null, 2);
    const sid = String(payload.sessionId || 'unknown').replace(/[\\/]/g, '_');
    const paths = [
      join(dshHome(), 'nebula-compaction-handoff.json'),
      join(dshHome(), 'nebula-compaction-handoff-' + sid + '.json'),
    ];
    for (const p of paths) writeFileSync(p, data);
    pruneHandoffFiles(paths[1]);
    __nebTrace('compaction handoff written ' + paths[1]);
    return paths;
  } catch (error) {
    __nebTrace('compaction handoff write failed: ' + (error instanceof Error ? error.message : String(error)));
    return [];
  }
}

/** recap 请求器: 独立辅助 LLM 调用, 解析 tool-call/text, 捕获总结。 */
async function recapTurn(ctx, agent, seq, signal) {
  const key = agent.session.id;
  const injected = injectedByAgent.get(key); // 本轮注入的知识, 供 ratings 打分
  const ts = turnState.get(key);
  if (!ts || seq !== recapReqSeq) return;
  let route = null;
  try {
    const header = typeof agent.session.requestHeader === 'function' ? agent.session.requestHeader() : undefined;
    const cfg = header && header.config;
    if (cfg && cfg.provider && cfg.model) route = { provider: cfg.provider, model: cfg.model };
  } catch { route = null; }
  try {
    const dev = await loadDeviceConfig();
    if (dev && dev.recapProvider && dev.recapModel) route = { provider: dev.recapProvider, model: dev.recapModel };
  } catch { /* 轻量路由未配置则沿用前台路由 */ }
  if (!route) return;
  recapLog('info', 'trigger provider=' + route.provider + ' model=' + route.model);
  __nebTrace('recap trigger ' + route.provider + '/' + route.model + ' key=' + key);
  const llm = ctx && (ctx.llm || (typeof ctx.get === 'function' ? ctx.get('llm') : undefined));
  __nebTrace('recap llm=' + (!!llm) + ' hasStream=' + (!!(llm && typeof llm.stream === 'function')));
  if (!llm || typeof llm.stream !== 'function') { __nebTrace('recap no llm -> abort'); return; }
  const controller = new AbortController();
  const abortAll = () => { try { controller.abort(); } catch {} };
  if (signal) { if (signal.aborted) abortAll(); else signal.addEventListener('abort', abortAll, { once: true }); }
  const timer = setTimeout(abortAll, RECAP_BUDGET_MS);
  activeRecapKey = key;
  try {
    const evidence = {
      toolErrors: lastToolErrorTail(agent, 1800),
      toolCalls: lastToolCalls(agent, 6),
    };
    __nebTrace('recap evidence errors=' + evidence.toolErrors.length + ' calls=' + evidence.toolCalls.length);
    const messages = [{ role: 'user', content: [{ type: 'text', text: recapPrompt(ts.lastUserText, lastAssistantTail(agent, RECAP_ASST_SNIPPET), key, injected, evidence) }] }];
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      tools: [RECAP_RETURN_SCHEMA],
      maxTokens: RECAP_MAX_TOKENS,
      // recap 只做结构化总结/打分, 关闭思考降低延迟与 token 消耗
      reasoningEffort: 'off',
      sessionId: key,
      purpose: 'nebula-recap',
      signal: controller.signal,
    };
    let text = '';
    let toolName = '';
    let toolArgs = '';
    let outcome = '';
    let ratings = [];
    let finishKind = '';
    for await (const chunk of llm.stream(options)) {
      if (seq !== recapReqSeq) return;
      if (chunk.type === 'text-delta' && chunk.text) text += chunk.text;
      else if (chunk.type === 'tool-call-delta') {
        if (chunk.name) toolName = chunk.name;
        if (chunk.argumentsDelta) toolArgs += chunk.argumentsDelta;
      } else if (chunk.type === 'finish') {
        finishKind = String(chunk.reason?.kind || '');
      }
    }
    if (seq !== recapReqSeq) return;
    // 解析一次工具参数(截断场景下也要抢救已收到的部分)
    let parsedArgs = null;
    if (toolName && toolName.indexOf('recap') !== -1 && toolArgs && toolArgs.trim()) {
      try { parsedArgs = JSON.parse(toolArgs); } catch { /* 半截 JSON: 走文本回退 */ }
    }
    let captured = '';
    if (finishKind === 'max-tokens') {
      // v1.5.0: 截断不再一律丢弃 —— 优先抢救回调工具已交回的 content, 其次用流式正文。
      let salvaged = '';
      if (parsedArgs && typeof parsedArgs.content === 'string') salvaged = parsedArgs.content.trim();
      if (!salvaged && text.trim()) salvaged = text.trim();
      if (!salvaged) {
        recapLog('warn', 'max-tokens 截断且无可抢救内容, 本次总结弃用');
        __nebTrace('recap salvage abort: no content');
        return;
      }
      captured = salvaged;
      if (parsedArgs) {
        outcome = String(parsedArgs.outcome || '').trim();
        if (Array.isArray(parsedArgs.ratings)) ratings = parsedArgs.ratings;
      }
      recapLog('warn', 'max-tokens 截断, 已抢救 ' + captured.length + ' chars');
      __nebTrace('recap salvage ok ' + captured.length + ' chars');
    } else if (parsedArgs) {
      captured = String(parsedArgs.content || '').trim();
      outcome = String(parsedArgs.outcome || '').trim();
      if (Array.isArray(parsedArgs.ratings)) ratings = parsedArgs.ratings;
    }
    if (!captured && text.trim()) captured = text.trim();
    __nebTrace('recap stream end finish=' + finishKind + ' textLen=' + text.length + ' tool=' + toolName + ' argsLen=' + toolArgs.length);
    if (captured) {
      __nebTrace('recap captured ' + captured.length + ' chars');
      recapLog('info', 'captured ' + captured.length + ' chars outcome=' + (outcome || '未标注'));
      await captureRecap(key, captured, outcome);
    }
    // 负反馈: 用 recap 轮给的 ratings 对本轮注入的知识打分并写回
    if (injected) {
      injectedByAgent.delete(key);
      const valid = new Set(injected.items.map((it) => it.id));
      let rated = 0;
      for (const r of ratings) {
        const id = String((r && r.id) || '');
        const sc = Number(r && r.score);
        if (!valid.has(id) || !Number.isFinite(sc)) continue; // 只接受本轮真实注入的 id
        await recordFeedback(id, Math.max(0, Math.min(1, sc)), injected.query, injected.tokens);
        rated += 1;
      }
      if (rated) recapLog('info', 'feedback ' + rated + '/' + ratings.length + ' 条已评分');
    }
  } catch (error) {
    __nebTrace('recap failed: ' + (error instanceof Error ? error.message : String(error)));
    recapLog('warn', 'failed: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
    if (activeRecapKey === key) activeRecapKey = '';
  }
}

// recap 本地持久缓存: 服务重启后仍能给旧会话拼回上一轮话题(星云上传可能失败/滞后)。
const RECAP_CACHE_NAME = 'nebula-recap-cache.json';
const RECAP_CACHE_MAX = 100;
const RECAP_CACHE_TTL_MS = 7 * 24 * 3600_000;
function recapCachePath() { return join(dshHome(), RECAP_CACHE_NAME); }
function loadRecapCache() {
  try {
    const o = JSON.parse(readFileSync(recapCachePath(), 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}
function saveRecapCache(cache) {
  try { writeFileSync(recapCachePath(), JSON.stringify(cache)); }
  catch (e) { __nebTrace('recap cache write failed: ' + (e instanceof Error ? e.message : String(e))); }
}
function restoreRecapFromDisk(key) {
  try {
    const entry = loadRecapCache()[key];
    if (!entry || typeof entry.text !== 'string' || !entry.text) return false;
    if (Date.now() - (entry.at || 0) > RECAP_CACHE_TTL_MS) return false;
    recapBuf.set(key, entry.text);
    pendingRecall.add(key);
    recapQueryTail.set(key, entry.text.slice(-RECAP_QUERY_CHARS));
    recapLog('info', 'recap restored from disk key=' + key + ' chars=' + entry.text.length);
    return true;
  } catch { return false; }
}

/** 捕获总结: 入队星云(带会话ID+完成度) + 缓存为下轮召回拼接语料。 */
async function captureRecap(key, content, outcome) {
  const trimmed = String(content || '').slice(0, RECAP_ENTRY_CHARS);
  if (!trimmed) return;
  const outcomeTag = String(outcome || '').trim();
  if (key && turnState.has(key)) {
    recapBuf.set(key, trimmed);
    pendingRecall.add(key);
    recapQueryTail.set(key, trimmed.slice(-RECAP_QUERY_CHARS));
    const cache = loadRecapCache();
    const now = Date.now();
    for (const [k, v] of Object.entries(cache)) if (!v || now - (v.at || 0) > RECAP_CACHE_TTL_MS) delete cache[k];
    cache[key] = { text: trimmed, at: now };
    const keys = Object.keys(cache);
    if (keys.length > RECAP_CACHE_MAX) for (const k of keys.slice(0, keys.length - RECAP_CACHE_MAX)) delete cache[k];
    saveRecapCache(cache);
  }
  try {
    const device = await loadDeviceConfig();
    const stored = '【轮末总结】' + (outcomeTag ? '[outcome:' + outcomeTag + '] ' : '') + trimmed + '\n【会话ID】' + (key || '未知');
    await outboxEnqueue({ content: stored.slice(0, 8000), scope: device.scope || 'dsh-recap', tags: 'recap,auto' });
  } catch {
    // 星云入队失败不影响本地召回拼接缓存
  }
}

/** consumed 观测: 助手回复与上轮 recap 的实词重合度(仅统计, 不改行为)。 */
function recapProbeConsumed(replyText, recapText) {
  try {
    const stop = new Set(['的','了','是','在','我','你','他','这','那','和','与','或','但','就','都','也','很','要','会','能','有','没','不','一个','什么','怎么','可以','已经','如果','然后','因为','所以','我们','他们','自己','还是','使用','进行','通过','比如','直接','一定','需要','现在','起来','下来','而且','并且','作为','以及','关于','然后','接着','完成','问题','内容','结果']);
    const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9_]{2,}|[一-龥]{2,6}/g) || [];
    const rSet = new Set(words(replyText).filter((w) => !stop.has(w) && w.length >= 2));
    if (!rSet.size) return 0;
    let hit = 0;
    for (const w of new Set(words(recapText).filter((x) => !stop.has(x) && x.length >= 2))) if (rSet.has(w)) hit += 1;
    return hit;
  } catch { return 0; }
}

/** 下一轮召回注入文本: recap 摘要块 + 常规召回块。 */
function recapText(kept, ptrs, recapBlockText, memPointers) {
  const head = recapBlockText ? '[上一轮 recap 摘要]\n' + recapBlockText + '\n' : '';
  return head + recallText(kept, ptrs, memPointers);
}

// ---------------------------------------------------------------------------
// 注入前精排 (fork-from-main) — 打分副本 + top-K 选择 + 审计
// ---------------------------------------------------------------------------

// v1.6.3: 复用模型已熟悉的 nebula_recap_return 工具名, 参数只收选中的 id。
const PRECISION_SCORE_SCHEMA = {
  name: 'nebula_recap_return',
  description: '注入前精排专用回调工具: 从候选清单中选出最有用的记忆, 只返回 id, 不返回分数或总结。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      full_ids: { type: 'array', items: { type: 'string' }, description: '按价值从高到低的最多 3 个候选 id, 会全文注入; id 必须原样复制。' },
      pointer_ids: { type: 'array', items: { type: 'string' }, description: '次优最多 2 个候选 id, 只注入一行指针; 没有就传空数组。' },
    },
    required: ['full_ids', 'pointer_ids'],
  },
};

const precisionCache = new Map();
let precisionLogLines = 0;
let precisionFailReason = ''; // 最近一次打分失败原因(写入审计日志, 便于定位)

function precisionCacheKey(query, items) {
  const s = String(query || '') + '|' + items.map((it) => it.id).join(',');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'p' + (h >>> 0).toString(36);
}
function precisionCacheGet(key) {
  const hit = precisionCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PRECISION_CACHE_TTL_MS) { precisionCache.delete(key); return null; }
  const v = hit.selection;
  return (v && Array.isArray(v.full_ids) && Array.isArray(v.pointer_ids)) ? v : null;
}
function precisionCacheSet(key, selection) {
  if (precisionCache.size >= PRECISION_CACHE_MAX) precisionCache.delete(precisionCache.keys().next().value);
  precisionCache.set(key, { at: Date.now(), selection });
}
function precisionLog(rec) {
  const path = join(dshHome(), PRECISION_LOG_NAME);
  void appendFile(path, JSON.stringify({ ts: Date.now(), ...rec }) + '\n', 'utf8').catch(() => {});
  precisionLogLines += 1;
  if (precisionLogLines % 200 !== 0) return;
  void (async () => {
    try {
      const txt = await readFile(path, 'utf8');
      const lines = txt.split('\n').filter(Boolean);
      if (lines.length > PRECISION_LOG_KEEP) await writeFile(path, lines.slice(-PRECISION_LOG_KEEP).join('\n') + '\n', 'utf8');
    } catch { /* 审计失败不影响主流程 */ }
  })();
}

/** 注入前选择请求: 单条消息 + 最近上下文 + 候选 id/摘要; 只让模型回选中的 id。 */
function precisionPrompt(agent, key, query, candidates) {
  const ts = turnState.get(key);
  const user = String((ts && ts.lastUserText) || query || '');
  const asst = lastAssistantTail(agent, RECAP_ASST_SNIPPET);
  const recap = String(recapBuf.get(key) || '').slice(-RECAP_QUERY_CHARS);
  const lines = [
    '[nebula 注入前精排] 这是主请求前的辅助选择, 不属于主对话; 输出用户看不到, 也不会写入会话。',
    '唯一动作: 调用工具 nebula_recap_return 一次。不要输出正文, 不要调用其他工具。',
    '参数只有两个数组: full_ids = 按价值从高到低最多 3 个候选 id (全文注入); pointer_ids = 次优最多 2 个候选 id (只留一行指针); 没选中的不要列出; 没有次优条目时 pointer_ids 传空数组。',
    '调用示例: nebula_recap_return({"full_ids":["<候选id1>","<候选id2>","<候选id3>"],"pointer_ids":["<候选id4>","<候选id5>"]})',
    'id 必须从下方候选清单里原样复制; 不要给分数、不要写理由、不要写总结。',
    '选择标准: 真正帮得上当前用户消息的条目优先; 创意/新颖的非显而易见联想也算高价值; 明显错误或过时的不要选。',
    '',
    '【当前用户消息】' + user,
  ];
  if (asst) lines.push('【上一轮助手回答(尾部)】' + asst);
  if (recap) lines.push('【上一轮话题】' + recap);
  lines.push('', '【候选记忆 — id 原样复制】');
  for (const it of candidates) {
    const sc = typeof it.score === 'number' ? it.score.toFixed(2) : '?';
    lines.push('- ' + String(it.id || '') + ' [相关度 ' + sc + '] ' + truncate(String(it.content || ''), PRECISION_REVIEW_CHARS));
  }
  return lines.join('\n');
}

/** 沿用主会话的 provider/model(与前台请求完全一致), 不引入额外模型路由。 */
async function resolvePrecisionRoute(agent) {
  let route = null;
  try {
    const header = typeof agent.session.requestHeader === 'function' ? agent.session.requestHeader() : undefined;
    const cfg = header && header.config;
    if (cfg && cfg.provider && cfg.model) route = { provider: cfg.provider, model: cfg.model };
  } catch { /* 前台路由不可得 */ }
  // 首轮 pre-step 时 requestHeader 可能尚未生成, 退回 agent 选项里的 provider/model。
  try {
    const opt = agent && agent.options;
    if (!route && opt && opt.provider && opt.model) route = { provider: opt.provider, model: opt.model };
  } catch { /* agent 选项不可得 */ }
  return route;
}

/** 严格校验选择结果: 非法/重复 id 丢弃, 顺序保留, 空选择视为失败。导出供自检。 */
export function normalizePrecisionSelection(parsed, validIds) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.full_ids) || !Array.isArray(parsed.pointer_ids)) return null; // 字段缺失/类型错误才算失败
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  const seen = new Set();
  const pick = (v, limit) => {
    const out = [];
    if (!Array.isArray(v)) return out;
    for (const raw of v) {
      const id = String(raw || '').trim();
      if (!valid.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= limit) break;
    }
    return out;
  };
  const full_ids = pick(parsed.full_ids, PRECISION_TOP_FULL);
  const pointer_ids = pick(parsed.pointer_ids, PRECISION_TOP_POINTER);
  // 两个数组都合法但都为空 = 模型认为本轮没有相关记忆, 是有效结果, 不再重试。
  return { full_ids, pointer_ids };
}

/** 单条消息调用 + 结构化 ID 选择; 解析失败重试(不携带失败输出); 共享总预算, 全失败回退。 */
async function precisionScore(ctx, agent, candidates, query, signal, route, budgetMs = PRECISION_BUDGET_MS) {
  const llm = ctx && (ctx.llm || (typeof ctx.get === 'function' ? ctx.get('llm') : undefined));
  if (!llm || typeof llm.stream !== 'function' || !route) { precisionFailReason = 'no-llm-or-route'; return null; }
  const controller = new AbortController();
  const abort = () => { try { controller.abort(); } catch {} };
  if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
  const timer = setTimeout(abort, budgetMs);
  const started = Date.now();
  const validIds = new Set(candidates.map((it) => String(it.id || '')));
  const attempts = 1 + PRECISION_RETRIES;
  let lastFail = '';
  try {
    // 每次尝试都是全新的单条消息调用, 不把失败那次的输出带进上下文。
    const messages = [{ role: 'user', content: [{ type: 'text', text: precisionPrompt(agent, agent.session.id, query, candidates) }] }];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (controller.signal.aborted || (signal && signal.aborted)) { precisionFailReason = 'aborted'; return null; }
      let toolName = '';
      let args = '';
      let finish = '';
      let strayText = '';
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        tools: [PRECISION_SCORE_SCHEMA],
        maxTokens: PRECISION_MAX_TOKENS,
        reasoningEffort: 'off',
        sessionId: agent.session.id,
        purpose: 'nebula-precision',
        signal: controller.signal,
      })) {
        if (signal && signal.aborted) { precisionFailReason = 'aborted'; return null; }
        if (chunk.type === 'tool-call-delta') {
          if (chunk.name) toolName = chunk.name;
          if (chunk.argumentsDelta) args += chunk.argumentsDelta;
        } else if (chunk.type === 'text-delta' && chunk.text) {
          strayText += chunk.text;
        } else if (chunk.type === 'finish') {
          finish = String(chunk.reason?.kind || '');
        }
      }
      if (controller.signal.aborted) { precisionFailReason = 'aborted'; return null; }
      if (toolName.indexOf('recap') === -1 && toolName.indexOf('precision') === -1) {
        lastFail = 'no-tool-call:' + (toolName || 'none') + '/finish=' + finish + '/args=' + args.length;
        __nebTrace('precision attempt ' + attempt + '/' + attempts + ' failed: ' + lastFail + '/text=' + strayText.slice(0, 300).replace(/\n/g, ' '));
        recapLog('info', 'precision attempt ' + attempt + '/' + attempts + ' failed: ' + lastFail + '/text=' + strayText.slice(0, 200).replace(/\n/g, ' '));
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(args || '{}'); } catch (e) {
        lastFail = 'bad-json:' + (e instanceof Error ? e.message : String(e)) + '/args=' + args.length + '/' + args.slice(0, 80);
        __nebTrace('precision attempt ' + attempt + '/' + attempts + ' failed: ' + lastFail);
        recapLog('info', 'precision attempt ' + attempt + '/' + attempts + ' failed: ' + lastFail);
        continue;
      }
      const selection = normalizePrecisionSelection(parsed, validIds);
      if (!selection) {
        lastFail = 'no-valid-ids:' + JSON.stringify(parsed).slice(0, 120);
        __nebTrace('precision attempt ' + attempt + '/' + attempts + ' failed: ' + lastFail);
        recapLog('info', 'precision attempt ' + attempt + '/' + attempts + ' failed: ' + lastFail);
        continue;
      }
      precisionFailReason = '';
      __nebTrace('precision selected attempt=' + attempt + '/' + attempts + ' ' + (Date.now() - started) + 'ms full=' + selection.full_ids.length + ' ptr=' + selection.pointer_ids.length);
      recapLog('info', 'precision selected attempt=' + attempt + '/' + attempts + ' ' + (Date.now() - started) + 'ms full=' + selection.full_ids.length + ' ptr=' + selection.pointer_ids.length);
      return { ...selection, attempts: attempt };
    }
    precisionFailReason = lastFail + '/attempts=' + attempts;
    __nebTrace('precision failed: ' + precisionFailReason);
    recapLog('warn', 'precision failed: ' + precisionFailReason);
    return null;
  } catch (error) {
    precisionFailReason = 'error:' + (error instanceof Error ? error.message : String(error));
    __nebTrace('precision failed: ' + precisionFailReason);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 按模型给出的有序 id 取全文/指针; 没列出的条目即淘汰。 */
function applyPrecision(candidates, selection) {
  const byId = new Map(candidates.map((it) => [String(it.id || ''), it]));
  const picked = (ids) => ids.map((id) => byId.get(id)).filter(Boolean).map((it) => ({ ...it, precisionSelected: true }));
  const tier = new Map();
  for (const id of selection.full_ids) tier.set(id, 'selected-full');
  for (const id of selection.pointer_ids) if (!tier.has(id)) tier.set(id, 'selected-pointer');
  const scores = candidates.map((it) => ({
    id: String(it.id || ''),
    score: null,
    verdict: tier.get(String(it.id || '')) || 'not-selected',
    note: '',
  }));
  return { full: picked(selection.full_ids), pointers: picked(selection.pointer_ids), scores };
}

/** 打分不可用时按原向量分 top-K —— 行为与旧版一致, 保证零回归。 */
function fallbackPrecision(candidates) {
  return {
    full: [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, PRECISION_TOP_FULL),
    pointers: [],
    scores: candidates.map((it) => ({ id: String(it.id || ''), score: it.score, verdict: 'fallback' })),
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export const inject = ['agents', 'llm'];

export function apply(ctx) {
  const pendingByAgent = new Map(); // agent session id -> { memPromise, sessPromise, startedAt, text, augmented }
  const agentDisposers = new Map(); // agent session id -> () => void

  const startRecall = (agentSessionId, text) => {
    __nebTrace('startRecall key=' + agentSessionId + ' q=' + String(text).slice(0, 40));
    recentTokens = feedbackTokens(text);
    let queryText = text;
    // 查询侧 recap 增强: 每条用户消息各自一次(flag 存在本次 pending 条目上),
    // 消费掉 tail 防止同一份旧总结反复拼进后续消息; recap 迟到时 pre-step 有补发窗口。
    const tail = recapQueryTail.get(agentSessionId);
    let augmented = false;
    if (tail) {
      queryText = '[上轮话题] ' + tail + '\n[本条消息] ' + text;
      augmented = true;
      recapQueryTail.delete(agentSessionId);
      recapLog('info', 'query-augmented +' + tail.length + ' chars');
    }
    const memPromise = recallMemLeg(queryText).catch(() => []);
    const sessPromise = PREFETCH_SESSION_ENABLED
      ? recallSessionLeg(queryText).catch(() => [])
      : Promise.resolve([]);
    pendingByAgent.set(agentSessionId, { memPromise, sessPromise, startedAt: Date.now(), text, augmented });
    let ts = turnState.get(agentSessionId);
    if (!ts) {
      ts = { firstTurnAt: Date.now(), turnCount: 0, lastSourceWasUser: false, lastUserText: '' };
      turnState.set(agentSessionId, ts);
    }
    // 新一轮用户消息: 轮内的工具错误召回计数与签名去重集清零
    ts.intraRecallCount = 0;
    ts.intraSigs = new Set();
    ts.lastSourceWasUser = true;
    ts.lastUserText = text;
  };

  const attachAgent = (agent) => {
    const key = agent.session.id;
    const prev = agentDisposers.get(key);
    __nebTrace('attachAgent key=' + key + ' sameAgent=' + (prev && prev.agent === agent));
    if (prev && prev.agent === agent) return;
    if (prev) { agentDisposers.delete(key); try { prev.dispose(); } catch {} }
    turnState.set(key, { firstTurnAt: Date.now(), turnCount: 0, lastSourceWasUser: false, lastUserText: '', intraRecallCount: 0, intraSigs: new Set() });
    restoreRecapFromDisk(key);

    /** v1.5.0: 工具报错后本轮重新召回 —— 换掉两腿, 本 step 不注入, 由下一 step 用新 st 注入。 */
    const maybeIntraTurnRecall = (payload) => {
      if (!INTRA_TURN_RECALL) return false;
      const ts = turnState.get(key);
      if (!ts || (ts.intraRecallCount || 0) >= INTRA_TURN_RECALL_MAX) return false;
      const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
      let errText = '';
      let flagged = false;
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const m = msgs[i];
        if (!m || m.role !== 'tool') continue;
        const t = extractText(m.content) || String(m.text || '');
        if (!t) continue;
        errText = t;
        flagged = m.isError === true;
        break;
      }
      if (!errText) return false;
      if (!flagged && !/error|failed|exception|失败|错误|超时|timeout/i.test(errText)) return false;
      const snippet = truncate(errText, 1500);
      const sig = hashOf(snippet.slice(0, 120));
      if (!ts.intraSigs) ts.intraSigs = new Set();
      if (ts.intraSigs.has(sig)) return false; // 同一错误不重复召回(防循环)
      const userText = ts.lastUserText || '';
      if (!userText) return false;
      ts.intraSigs.add(sig);
      ts.intraRecallCount = (ts.intraRecallCount || 0) + 1;
      const query = String(userText) + '\n[工具错误]' + snippet;
      const memPromise = recallMemLeg(query).catch(() => []);
      const sessPromise = PREFETCH_SESSION_ENABLED
        ? recallSessionLeg(query).catch(() => [])
        : Promise.resolve([]);
      pendingByAgent.set(key, { memPromise, sessPromise, startedAt: Date.now(), text: userText, augmented: false });
      __nebTrace('intra-turn recall key=' + key + ' sig=' + sig + ' count=' + ts.intraRecallCount + ' q=' + query.slice(0, 140).replace(/\n/g, ' '));
      return true;
    };

    /** v1.5.0: 压缩完成后的下一 step 注入交接块(取走即清 flag)。 */
    const takeCompactionHandoff = () => {
      if (!postCompactionPending.has(key)) return null;
      const info = postCompactionPending.get(key) || {};
      postCompactionPending.delete(key);
      const ids = Array.isArray(info.ids) ? info.ids : [];
      const text = [
        '【压缩交接】上下文刚被压缩, 请继续沿用以下记忆线索:',
        '- 已压缩: ' + (info.reason || 'auto') + ' compaction, 摘要与连续性快照已写入星云。',
        '- 记忆 id: ' + (ids.length ? ids.join(', ') : '(见 nebula_search 或 ~/.dsh/nebula-compaction-handoff.json)'),
        '- 需要原文/细节请用 nebula_search、nebula_session_search 检索。',
      ].join('\n');
      return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'nebula', form: 'compaction-handoff' },
      });
    };

    const offInserted = agent.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (!PREFETCH_ENABLED) return;
      if (message?.source?.kind !== 'user') return;
      const text = extractText(message.content);
      __nebTrace('inserted kind=' + (message && message.source && message.source.kind) + ' len=' + text.length);
      if (!text || text.length < PREFETCH_MIN_QUERY_CHARS) return;
      startRecall(key, text);
    });
    const offPreStep = agent.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      // 压缩交接优先: 单独注入一条 user 消息, 常规召回留给下一 step
      const handoff = takeCompactionHandoff();
      if (handoff) return { ...decision, messages: [...decision.messages, handoff] };
      // 轮内工具错误: 触发新召回后本 step 不注入, 下一 step 用新的 st
      if (maybeIntraTurnRecall(payload)) return decision;
      const st = pendingByAgent.get(key);
      __nebTrace('prestep key=' + key + ' kind=' + decision.kind + ' pending=' + !!st);
      if (!st) return decision;
      if (Date.now() - st.startedAt > PREFETCH_STALE_MS) {
        pendingByAgent.delete(key);
        return decision;
      }
      const remaining = Math.max(0, st.startedAt + PREFETCH_WAIT_MS - Date.now());
      const budget = Math.min(remaining, 7000);
      const [memItems, sessItems] = await Promise.all([
        Promise.race([st.memPromise, sleep(budget, payload.signal).then(() => null)]),
        Promise.race([st.sessPromise, sleep(Math.min(budget, PREFETCH_SESSION_BUDGET_MS + 500), payload.signal).then(() => null)]),
      ]);
      const memReady = Array.isArray(memItems);
      const sessReady = Array.isArray(sessItems);
      __nebTrace('prestep-ready memReady=' + memReady + '(' + (memItems ? memItems.length : 'null') + ') sessReady=' + sessReady + '(' + (sessItems ? sessItems.length : 'null') + ')');
      if (!memReady) { __nebTrace('mem not ready -> 等下一步'); return decision; } // 记忆腿未就绪: 不空注入, 后续 step 再取
      // recap 迟到补发: 两腿已就绪但 recap 刚好到达, 再给它一个短窗口重发查询
      // 每条用户消息只增强一次(augmented 存在本次 pending 条目上)
      if (!st.augmented && recapQueryTail.has(key) && Date.now() - st.startedAt < RECAP_QUERY_DELAY_MS) {
        const tail = recapQueryTail.get(key) || '';
        if (tail) {
          const q = '[上轮话题] ' + tail + '\n[本条消息] ' + st.text;
          recapQueryTail.delete(key);
          st.augmented = true;
          recapLog('info', 'query-augmented(late) +' + tail.length + ' chars');
          pendingByAgent.set(key, { memPromise: recallMemLeg(q).catch(() => []), sessPromise: recallSessionLeg(q).catch(() => []), startedAt: st.startedAt, text: st.text, augmented: true });
          return decision; // 下一 step 用增强结果
        }
      }
      pendingByAgent.delete(key);
      const candidates = memReady ? memItems : [];
      const ptrs = sessReady ? rrfSessionPick(candidates, sessItems, PREFETCH_SESSION_LIMIT) : [];
      let kept = candidates.slice(0, PREFETCH_LIMIT); // 默认: 向量分 top-K (精排未启用/候选不足)
      let memPointers = [];
      let precisionSource = 'off';
      // 新会话首轮没有上一轮回答/recap 作依据, 直接走向量 top-K (反馈仍由轮末 recap 正常记录)
      const ts = turnState.get(key);
      const firstPrompt = (!ts || (ts.turnCount || 0) === 0) && !hasPriorConversation(agent);
      const skipPrecision = PRECISION_SKIP_FIRST_TURN && firstPrompt;
      if (PRECISION_ENABLED && skipPrecision && candidates.length > PRECISION_TOP_FULL) {
        __nebTrace('precision skipped: first prompt of session key=' + key);
      }
      if (PRECISION_ENABLED && !skipPrecision && candidates.length > PRECISION_TOP_FULL && !(payload.signal && payload.signal.aborted)) {
        const route = await resolvePrecisionRoute(agent);
        const cacheKey = precisionCacheKey(st.text, candidates);
        let selection = precisionCacheGet(cacheKey);
        let attempts = 0;
        if (selection) {
          precisionSource = 'cache';
        } else {
          precisionFailReason = '';
          selection = await precisionScore(ctx, agent, candidates, st.text, payload.signal, route);
          if (selection) {
            precisionCacheSet(cacheKey, selection);
            precisionSource = 'selected-ids';
            attempts = selection.attempts || 0;
          } else precisionSource = 'fallback';
        }
        let auditScores = [];
        if (selection) {
          const picked = applyPrecision(candidates, selection);
          kept = picked.full;
          memPointers = picked.pointers;
          auditScores = picked.scores;
        } else {
          const fb = fallbackPrecision(candidates); // 全失败 → 原向量分 top-3, 零回归
          kept = fb.full;
          auditScores = fb.scores;
        }
        precisionLog({
          key, source: precisionSource,
          query: String(st.text || '').slice(0, 160),
          candidates: candidates.length,
          kept: kept.map((it) => String(it.id || '')),
          pointers: memPointers.map((it) => String(it.id || '')),
          scores: auditScores, // 逐条 verdict=selected-full/selected-pointer/not-selected, 仅本地审计
          attempts,
          model: route ? route.provider + '/' + route.model : '',
          fail: precisionFailReason || undefined,
        });
        recapLog('info', 'precision ' + precisionSource + ' ' + candidates.length + '->' + kept.length + '+' + memPointers.length);
      }
      let recapBlockText = '';
      if (pendingRecall.has(key)) {
        recapBlockText = recapBuf.get(key) || '';
        pendingRecall.delete(key);
      }
      __nebTrace('inject? kept=' + kept.length + ' ptrs=' + ptrs.length + ' recap=' + recapBlockText.length);
      if (kept.length === 0 && ptrs.length === 0 && !recapBlockText) return decision;
      // 记录本轮注入的知识, 供 recap 辅助轮逐条打分反馈
      if (kept.length) {
        injectedByAgent.set(key, {
          items: kept.slice(0, FEEDBACK_MAX_ITEMS).map((it) => ({
            id: String(it.id || ''),
            score: it.score,
            content: truncate(String(it.content || ''), FEEDBACK_REVIEW_CHARS),
          })).filter((it) => it.id),
          query: st.text,
          tokens: feedbackTokens(st.text),
          at: Date.now(),
        });
      }
      if (recapBlockText) recapProbe.set(key, { text: recapBlockText, at: Date.now() });
      const message = createUserMessage({
        content: [{ type: 'text', text: recapText(kept, ptrs, recapBlockText, memPointers) }],
        source: { kind: 'nebula', form: 'recall' },
      });
      return { ...decision, messages: [...decision.messages, message] };
    });
    const offTurnStopping = agent.ctx.on('agent/turn-stopping', async ({ signal } = {}) => {
      if (!RECAP_ENABLED) return;
      const ts = turnState.get(key);
      if (!ts) return;
      ts.turnCount += 1;
      if (!ts.lastSourceWasUser || !ts.lastUserText || ts.lastUserText.length < RECAP_MIN_CHARS) return;
      // 0 = 不限(可调默认值: 100 次 / 无限时长)
      if (RECAP_MAX_WINDOW_MS > 0 && Date.now() - ts.firstTurnAt > RECAP_MAX_WINDOW_MS) return;
      if (RECAP_MAX_TURNS > 0 && ts.turnCount > RECAP_MAX_TURNS) return;
      if (recapInflight) return;
      recapInflight = true;
      const seq = ++recapReqSeq;
      // fire-and-forget: 不阻塞 agent loop 收尾(hook 只负责发起)
      void recapTurn(ctx, agent, seq, signal).catch(() => {}).finally(() => { recapInflight = false; });
      // consumed 观测探针: 刚结束这轮的回复是否真的用上了上轮注入的 recap(仅日志)
      const probe = recapProbe.get(key);
      if (probe && Date.now() - probe.at < 600_000) {
        const reply = lastAssistantTail(agent, 3000);
        const hits = reply ? recapProbeConsumed(reply, probe.text) : 0;
        recapLog('info', 'probe consumed-words=' + hits + (hits >= 5 ? ' (像是用上了)' : ''));
        recapProbe.delete(key);
      }
    });
    agentDisposers.set(key, { agent, dispose: () => {
      offInserted?.();
      offPreStep?.();
      offTurnStopping?.();
      pendingByAgent.delete(key);
      turnState.delete(key);
      recapBuf.delete(key);
      recapQueryTail.delete(key);
      recapProbe.delete(key);
      injectedByAgent.delete(key);
      postCompactionPending.delete(key);
      compactionEnq.delete(key);
    } });
  };

  ctx.effect(() => {
    const toolsFiber = ctx.inject(['tools'], (scope) => {
      scope.tools.register(nebulaSearchTool);
      scope.tools.register(nebulaSessionSearchTool);
      scope.tools.register(nebulaSessionReadTool);
      scope.tools.register(nebulaAddTool);
      scope.tools.register(nebulaStatsTool);
      scope.tools.register(nebulaOutboxTool);
      scope.tools.register(recapReturnTool);
      scope.tools.register(nebulaFeedbackTool);
    });

    // v1.5.0: 压缩交接 —— session 级 observe-only 事件; 绝不改动 session 对象。
    // start 必须同步写盘(摘要器紧接着运行); summary 入队后打标记, 下一 step 注入交接块。
    const offSessionEvent = ctx.on('session/event', (session, event) => {
      if (!COMPACTION_HANDOFF) return;
      // 主签名 (session, event); 兼容只传 event 的宿主: event.session 里取会话
      let ev = event;
      let sess = session;
      if (!ev && session && (session.type || session.kind || session.name)) {
        ev = session;
        sess = session.session || null;
      }
      const type = String((ev && (ev.type || ev.kind || ev.name)) || '');
      if (type !== 'compaction/start' && type !== 'compaction/summary') return;
      const sid = String((sess && sess.id) || '');
      if (!sid) return;
      const data = (ev && ev.data) || {};
      if (type === 'compaction/start') {
        const text = compactionContinuityText(sess);
        const handoff = {
          sessionId: sid,
          at: new Date().toISOString(),
          reason: data.turn === null ? 'manual' : 'auto',
          text,
        };
        writeCompactionHandoff(handoff); // 同步: 摘要器启动前完成
        __nebTrace('compaction/start sid=' + sid + ' reason=' + handoff.reason + ' textLen=' + text.length);
        void outboxEnqueue({ content: text, scope: 'dsh-recap', tags: 'compaction,auto' })
          .then((res) => {
            if (!res || !res.key) return;
            const list = compactionEnq.get(sid) || [];
            list.push(res.key);
            compactionEnq.set(sid, list);
          })
          .catch(() => {});
        return;
      }
      const summary = truncate(String(data.summary ?? data.text ?? ''), 2000);
      const shadowed = Number(data.shadowedTokenCount ?? data.shadowed_tokens ?? 0) || 0;
      const content = '【压缩摘要】' + summary + '\n【shadowedTokenCount】' + shadowed + '\n【会话ID】' + sid;
      __nebTrace('compaction/summary sid=' + sid + ' summaryLen=' + summary.length + ' shadowed=' + shadowed);
      void outboxEnqueue({ content: content.slice(0, 8000), scope: 'dsh-recap', tags: 'compaction-summary,auto' })
        .then((res) => {
          const list = compactionEnq.get(sid) || [];
          if (res && res.key) list.push(res.key);
          compactionEnq.set(sid, list);
          postCompactionPending.set(sid, { at: Date.now(), ids: [...list], reason: data.turn === null ? 'manual' : 'auto' });
        })
        .catch(() => {
          postCompactionPending.set(sid, { at: Date.now(), ids: [...(compactionEnq.get(sid) || [])], reason: 'auto' });
        });
    });

    const offCreated = ctx.on('agent/created', ({ agent }) => {
      attachAgent(agent);
    });
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const entry = agentDisposers.get(agent.session.id);
      if (entry && entry.agent === agent) {
        agentDisposers.delete(agent.session.id);
        entry.dispose();
      }
    });
    for (const agent of ctx.agents.list()) attachAgent(agent);

    // 写入队列: 启动 15s 后首试, 之后每 30s 一拍; 卸载时停表
    outboxSchedule(OUTBOX_STARTUP_FLUSH_DELAY);

    return () => {
      offSessionEvent?.();
      offCreated?.();
      offDisposed?.();
      for (const e of agentDisposers.values()) e.dispose();
      agentDisposers.clear();
      pendingByAgent.clear();
      outboxStop();
      toolsFiber?.dispose?.();
    };
  }, 'nebula-memory: tools & recall');
}
