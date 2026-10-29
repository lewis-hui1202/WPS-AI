# localStorage → SQLite(proxy) + 同步 WpsAiStore 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把插件所有持久化缓存从 localStorage 迁到本地 SQLite（经 Node 代理落盘 `~/.lingxi-ai/lingxi.db`），前端用与 localStorage 同款的**同步** `WpsAiStore` 面板托管，各模块机械替换、不改 async，彻底消除 QuotaExceeded。

**Architecture:** 代理侧 `tools/kv-store.js` 用 Node 22 内置 `node:sqlite` 提供 KV 存储 + 4 个路由；前端 `js/store.js` 维护内存 Map（启动从 `/kv/all` 灌入），读走内存、写防抖批量回写 `/kv/batch`；代理不可用整体降级 localStorage；首次运行一次性迁移旧数据。

**Tech Stack:** WPS JS 加载项（window IIFE）、Node 代理（内置 Node v22.11）、`node:sqlite`（`--experimental-sqlite`）、node:test + node:vm。

## Global Constraints

- 仅桌面；不为移动端做任何适配。
- 代理必须带 `--experimental-sqlite` 启动；`node:sqlite` 不可用时端点回 `503`、前端降级 localStorage，绝不崩。
- 业务模块只把 `localStorage.*` 换成 `WpsAiStore.*`，不得改 async、不得改业务逻辑。
- 跨窗 IPC key、`lingxi_runtime_proxy_port_v1` 保持在 localStorage（后者是 store 找代理的前置，鸡生蛋）。
- DB 单文件 `~/.lingxi-ai/lingxi.db`，开 WAL。测试用环境变量 `LINGXI_KV_DB` 覆盖路径（`:memory:`）。
- 迁移幂等：先写 SQLite 成功再删 localStorage 大键；失败不写 `__lingxi_kv_migrated_v1` 标记。
- API Key/令牌明文入库（与今天同级，不加密）。

---

## 文件结构

- **新增** `plugin/tools/kv-store.js` — node:sqlite KV 模块：`available/getAll/batch/stats/clear/dbPath`。
- **改** `plugin/tools/proxy-server.js` — 加 `/kv/all` `/kv/batch` `/kv/stats` `/kv/clear` 路由 + 未知路由提示。
- **改** 启动入口 — 加 `--experimental-sqlite`。
- **新增** `plugin/js/store.js` — `WpsAiStore` 同步面板（Map/脏集/防抖/init/迁移/降级）。
- **改** `plugin/main.js` — 首个加载 `js/store.js`；boot 里 `await WpsAiStore.init()`。
- **改** 业务模块 — `localStorage.*` → `WpsAiStore.*`（清单见任务）。
- **改** `plugin/js/cache.js` — 缓存管理改查 `/kv/stats`、清 `/kv/clear`。
- **测试** `plugin/test/kv-store.test.js`、`plugin/test/store.test.js`。

---

### Task 1: 代理 KV 存储模块 `tools/kv-store.js`

**Files:**
- Create: `plugin/tools/kv-store.js`
- Test: `plugin/test/kv-store.test.js`

**Interfaces:**
- Produces: `available(): boolean`、`getAll(): {[key]:value}`、`batch({sets:[{key,value}],dels:[key]}): number`、`stats(): {entries:[{key,bytes}],total}`、`clear({keys?}): number`、`dbPath(): string`。value 一律 string。

- [ ] **Step 1: 写失败测试**

`plugin/test/kv-store.test.js`：
```js
const test = require("node:test");
const assert = require("node:assert");
process.env.LINGXI_KV_DB = ":memory:";
const kv = require("../tools/kv-store.js");
const RUN = kv.available(); // 无 --experimental-sqlite 时整组跳过

test("set/get 往返", { skip: !RUN && "需 --experimental-sqlite" }, () => {
  kv.batch({ sets: [{ key: "a", value: "1" }, { key: "b", value: "两" }] });
  const all = kv.getAll();
  assert.equal(all.a, "1");
  assert.equal(all.b, "两");
});

test("batch 覆盖 + 删除在一个事务", { skip: !RUN }, () => {
  kv.batch({ sets: [{ key: "a", value: "x" }], dels: ["b"] });
  const all = kv.getAll();
  assert.equal(all.a, "x");
  assert.ok(!("b" in all));
});

test("stats 返回每 key 字节数与总和", { skip: !RUN }, () => {
  kv.clear({});
  kv.batch({ sets: [{ key: "k", value: "abcd" }] });
  const s = kv.stats();
  assert.equal(s.total, 4);
  assert.deepStrictEqual([...s.entries], [{ key: "k", bytes: 4 }]);
});

test("clear({keys}) 只删指定；clear() 清全部", { skip: !RUN }, () => {
  kv.batch({ sets: [{ key: "p", value: "1" }, { key: "q", value: "2" }] });
  kv.clear({ keys: ["p"] });
  assert.ok(!("p" in kv.getAll()));
  assert.ok("q" in kv.getAll());
  kv.clear({});
  assert.equal(Object.keys(kv.getAll()).length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `plugin/runtime/node-win-x64/node.exe --experimental-sqlite --test plugin/test/kv-store.test.js`
Expected: FAIL（`Cannot find module '../tools/kv-store.js'`）。

- [ ] **Step 3: 写实现**

`plugin/tools/kv-store.js`：
```js
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");

let _db = null;
let _available = null;

function dbPath() {
  if (process.env.LINGXI_KV_DB) return process.env.LINGXI_KV_DB;
  const dir = path.join(os.homedir(), ".lingxi-ai");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return path.join(dir, "lingxi.db");
}

function getDb() {
  if (_db) return _db;
  const { DatabaseSync } = require("node:sqlite"); // 无 flag / 老 Node 会抛 → available()=false
  const db = new DatabaseSync(dbPath());
  try { db.exec("PRAGMA journal_mode=WAL"); } catch (e) {}
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  _db = db;
  return _db;
}

function available() {
  if (_available !== null) return _available;
  try { getDb(); _available = true; } catch (e) { _available = false; }
  return _available;
}

function getAll() {
  const rows = getDb().prepare("SELECT key, value FROM kv").all();
  const items = {};
  for (const r of rows) items[r.key] = r.value;
  return items;
}

function batch({ sets = [], dels = [] } = {}) {
  const db = getDb();
  const now = Date.now();
  const up = db.prepare("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
  const del = db.prepare("DELETE FROM kv WHERE key=?");
  db.exec("BEGIN");
  try {
    for (const s of sets) { if (s && typeof s.key === "string") up.run(s.key, String(s.value == null ? "" : s.value), now); }
    for (const k of dels) { if (typeof k === "string") del.run(k); }
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
  return (sets ? sets.length : 0) + (dels ? dels.length : 0);
}

function stats() {
  const rows = getDb().prepare("SELECT key, length(value) AS bytes FROM kv").all();
  let total = 0;
  const entries = rows.map((r) => { const b = r.bytes || 0; total += b; return { key: r.key, bytes: b }; });
  return { entries, total };
}

function clear({ keys } = {}) {
  const db = getDb();
  if (Array.isArray(keys) && keys.length) {
    const del = db.prepare("DELETE FROM kv WHERE key=?");
    db.exec("BEGIN");
    try { for (const k of keys) del.run(k); db.exec("COMMIT"); }
    catch (e) { try { db.exec("ROLLBACK"); } catch (e2) {} throw e; }
    return keys.length;
  }
  const n = db.prepare("SELECT COUNT(*) AS c FROM kv").get().c;
  db.exec("DELETE FROM kv");
  return n;
}

module.exports = { available, getAll, batch, stats, clear, dbPath };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `plugin/runtime/node-win-x64/node.exe --experimental-sqlite --test plugin/test/kv-store.test.js`
Expected: PASS（4 tests）。若不带 flag：4 tests skipped（不报错）。

- [ ] **Step 5: 提交**

```bash
git add plugin/tools/kv-store.js plugin/test/kv-store.test.js
git commit -m "feat(store): 代理 node:sqlite KV 存储模块 kv-store.js"
```

---

### Task 2: 代理 `/kv/*` 路由

**Files:**
- Modify: `plugin/tools/proxy-server.js`（在 `/model-file` 路由块之后加；未知路由提示 §末尾更新）

**Interfaces:**
- Consumes: `kv-store.js` 的 `available/getAll/batch/stats/clear`。
- Produces: HTTP `GET /kv/all`、`POST /kv/batch`、`GET /kv/stats`、`POST /kv/clear`；node:sqlite 不可用一律 `503 {ok:false,error}`。

- [ ] **Step 1: 写实现（路由）**

在 `plugin/tools/proxy-server.js` 顶部 require 区加：
```js
const kvStore = require("./kv-store.js");
```
在 `/model-file` 路由 `return;` 之后插入：
```js
  // ===== SQLite KV 存储（前端 WpsAiStore 用；node:sqlite 不可用一律 503 → 前端降级 localStorage）=====
  if (pathname.startsWith("/kv/")) {
    if (!kvStore.available()) { sendJson(res, 503, { ok: false, error: "node:sqlite 未启用（需 --experimental-sqlite 启动代理）" }); return; }
    try {
      if (pathname === "/kv/all" && method === "GET") { sendJson(res, 200, { ok: true, items: kvStore.getAll() }); return; }
      if (pathname === "/kv/batch" && method === "POST") {
        const body = await readBody(req);
        const json = JSON.parse(body.toString("utf8") || "{}");
        const count = kvStore.batch({ sets: Array.isArray(json.sets) ? json.sets : [], dels: Array.isArray(json.dels) ? json.dels : [] });
        sendJson(res, 200, { ok: true, count });
        return;
      }
      if (pathname === "/kv/stats" && method === "GET") { sendJson(res, 200, Object.assign({ ok: true }, kvStore.stats())); return; }
      if (pathname === "/kv/clear" && method === "POST") {
        const body = await readBody(req);
        const json = JSON.parse(body.toString("utf8") || "{}");
        const removed = kvStore.clear({ keys: Array.isArray(json.keys) ? json.keys : undefined });
        sendJson(res, 200, { ok: true, removed });
        return;
      }
      sendJson(res, 404, { ok: false, error: "未知 kv 路由: " + pathname });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }
```
未知路由提示（`未知路由: ${pathname}...` 那条）里的"常用"清单追加 `/kv/all, /kv/batch, /kv/stats, /kv/clear`。

- [ ] **Step 2: 跑集成验证（隔离 HOME 的测试代理）**

```bash
cd plugin
USERPROFILE="$PWD/.kvtest" HOME="$PWD/.kvtest" LINGXI_KV_DB="$PWD/.kvtest/t.db" \
  PROXY_PORT=3895 runtime/node-win-x64/node.exe --experimental-sqlite tools/proxy-server.js &
sleep 1
NP="--noproxy 127.0.0.1,localhost"
curl -s $NP -X POST http://127.0.0.1:3895/kv/batch -H "Content-Type: application/json" -d '{"sets":[{"key":"x","value":"1"}]}'
curl -s $NP http://127.0.0.1:3895/kv/all
curl -s $NP http://127.0.0.1:3895/kv/stats
# kill 测试代理 + rm -rf .kvtest
```
Expected: batch `{"ok":true,"count":1}`、all `{"ok":true,"items":{"x":"1",...}}`、stats 含 `x`。

- [ ] **Step 3: 全量语法检查 + 主测试套件**

Run: `node --check plugin/tools/proxy-server.js && node --test`
Expected: 语法 OK；套件全过（新 kv-store 测试在无 flag 下 skip）。

- [ ] **Step 4: 提交**

```bash
git add plugin/tools/proxy-server.js
git commit -m "feat(store): 代理 /kv/all|batch|stats|clear 路由，sqlite 不可用回 503"
```

---

### Task 3: 启动脚本加 `--experimental-sqlite`

**Files:**
- Modify: `plugin/package.json`（`scripts.proxy`）
- Modify: `plugin/start-wps.sh` `plugin/start-et.sh` `plugin/start-wpp.sh`、`start-wps.bat` 等（凡直接 `node tools/proxy-server.js` 或 `npm run proxy` 的）
- Modify: `plugin/tools/serve-permanent.js`（若它 spawn node 起代理）、`plugin/tools/register-task.ps1`、`plugin/install-permanent-windows.bat` `plugin/install-permanent-mac.sh`（凡拉起代理的命令）

- [ ] **Step 1: 改 package.json**

`plugin/package.json`：`"proxy": "node tools/proxy-server.js"` → `"proxy": "node --experimental-sqlite tools/proxy-server.js"`。

- [ ] **Step 2: 逐个改直接起代理的命令**

把每处 `node tools/proxy-server.js` / `<bundled-node> tools/proxy-server.js` 改为带 `--experimental-sqlite`。用 grep 找齐：
```bash
grep -rn "proxy-server.js" plugin --include=*.sh --include=*.bat --include=*.ps1 --include=*.js | grep -v node_modules
```
（.bat 文件按其既有 GBK 编码保存。）

- [ ] **Step 3: 验证**

启动一次代理（任一 start 脚本），curl `http://127.0.0.1:<port>/kv/stats`，应返回 `{"ok":true,...}` 而非 503。

- [ ] **Step 4: 提交**

```bash
git add plugin/package.json plugin/start-*.sh plugin/start-*.bat plugin/tools/serve-permanent.js plugin/tools/register-task.ps1 plugin/install-permanent-*.*
git commit -m "chore(store): 代理启动加 --experimental-sqlite 启用 node:sqlite"
```

---

### Task 4: 前端 `WpsAiStore` 同步面板 `js/store.js`

**Files:**
- Create: `plugin/js/store.js`
- Test: `plugin/test/store.test.js`

**Interfaces:**
- Consumes: `WpsAiRuntime.proxyBase()`；`fetch`；`localStorage`。
- Produces: `window.WpsAiStore = { getItem, setItem, removeItem, clear, keys, init, ready, flush }`。`getItem` 返回 string|null（同步）；`init()` 返回 Promise<"sqlite"|"localStorage">。

- [ ] **Step 1: 写失败测试**

`plugin/test/store.test.js`（node:vm 装 IIFE，mock window）：
```js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadStore(win) {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "store.js"), "utf8");
  vm.runInThisContext("(function(window){" + code + "})")(win);
  return win.WpsAiStore;
}
function fakeLocalStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
// 记录所有 fetch 调用；/kv/all 按 opts.allItems 返回；其它返回 ok
function fakeFetch(opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    if (/\/kv\/all$/.test(url)) {
      if (opts.proxyDown) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({ ok: true, items: opts.allItems || {} }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  fn.calls = calls;
  return fn;
}

test("backend=sqlite：init 从 /kv/all 灌 Map，getItem 同步命中", async () => {
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: fakeFetch({ allItems: { a: "1", __lingxi_kv_migrated_v1: "1" } }), localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  const backend = await S.init();
  assert.equal(backend, "sqlite");
  assert.equal(S.getItem("a"), "1");
  assert.equal(S.getItem("missing"), null);
});

test("backend=sqlite：setItem 攒脏 + flush 组 /kv/batch", async () => {
  const ff = fakeFetch({ allItems: { __lingxi_kv_migrated_v1: "1" } });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  await S.init();
  S.setItem("k", "v");
  S.removeItem("gone");
  await S.flush();
  const batch = ff.calls.find((c) => /\/kv\/batch$/.test(c.url) && c.body && c.body.sets && c.body.sets.length);
  assert.ok(batch, "应发 /kv/batch");
  assert.deepStrictEqual([...batch.body.sets], [{ key: "k", value: "v" }]);
  assert.deepStrictEqual([...batch.body.dels], ["gone"]);
  // sqlite backend 不写 localStorage
  assert.equal(win.localStorage.getItem("k"), null);
});

test("首次迁移：把 localStorage 受管 key 批量写 SQLite 并清大键", async () => {
  const ff = fakeFetch({ allItems: {} }); // SQLite 空、无迁移标记
  const ls = fakeLocalStorage({ lingxi_conversations_v1: "big", lingxi_pure_mode: "1" });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: ls, addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  await S.init();
  const mig = ff.calls.find((c) => c.body && c.body.sets && c.body.sets.some((s) => s.key === "__lingxi_kv_migrated_v1"));
  assert.ok(mig, "应发迁移 batch 含标记");
  assert.ok(mig.body.sets.some((s) => s.key === "lingxi_conversations_v1" && s.value === "big"));
  // 迁移成功后大键从 localStorage 删除
  assert.equal(ls.getItem("lingxi_conversations_v1"), null);
});

test("backend=localStorage：proxy 挂时从 localStorage 灌 + 写 localStorage", async () => {
  const ls = fakeLocalStorage({ lingxi_pure_mode: "1" });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: fakeFetch({ proxyDown: true }), localStorage: ls, addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  const backend = await S.init();
  assert.equal(backend, "localStorage");
  assert.equal(S.getItem("lingxi_pure_mode"), "1");
  S.setItem("lingxi_pure_mode", "0");
  assert.equal(ls.getItem("lingxi_pure_mode"), "0");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test plugin/test/store.test.js`
Expected: FAIL（store.js 不存在 / WpsAiStore undefined）。

- [ ] **Step 3: 写实现**

`plugin/js/store.js`：
```js
// WpsAiStore：与 localStorage 同款的同步 KV 面板，内部内存 Map + 启动从 SQLite(代理) 灌入 +
// 写防抖批量回写；代理不可用整体降级 localStorage；首次一次性迁移旧数据。只托管"受管 key"。
(function attachStore(global) {
  "use strict";
  const MIGRATED_FLAG = "__lingxi_kv_migrated_v1";
  // 受管 key：迁移 + 由 store 托管。跨窗 IPC / 端口 key 不在内。
  const MANAGED_KEYS = [
    "lingxi_conversations_v1", "lingxi_current_conversation_v1",
    "lingxi_history_v1", "lingxi_history_turns_v1",
    "lingxi_material_library_v1",
    "lingxi_skills_user_v1", "lingxi_skills_enabled_v1", "lingxi_skills_cloud_v1",
    "lingxi_html_template_cache_v1", "lingxi_html_components_v1", "lingxi_html_cache_cleared_at",
    "lingxi_token_usage_v1", "lingxi_doc_report_cache_v1", "lingxi_mindmap_qa_v1",
    "lingxi_models_cache_v1", "lingxi_image_models_cache_v1", "lingxi_model_group_collapsed_v1",
    "wps_ai_provider_settings_v1", "lingxi_ai_thinking_level_v1", "lingxi_pure_mode",
    "wpsAiChatFoldMiddle", "wpsAiProviderHealthV1",
    "wpsAiCacheAutoCleanPolicy", "wpsAiCacheAutoCleanLastRunAt",
    "lingxi_preview_log_v1", "lingxi_html_preview_chat_log_v1", "lingxi_html_preview_unified_chat_log_v1",
    "lingxi_html_preview_picked_components_v1",
    "lingxi_device_sn_v1", "lingxi_updater_last_check_v1", "wpsAiMcpBridgeToken",
    "__lingxi_editor_tips_seen__",
    // auth.js OAuth 令牌（实现时以 auth.js 常量为准，逐个列全）
    "wps_ai_access_token", "wps_ai_refresh_token", "wps_ai_expires_at",
    "wps_ai_code_verifier", "wps_ai_oauth_state", "wps_ai_account_id"
  ];
  // 迁移成功后从 localStorage 删掉的大/增长键（腾配额）；小标志留着无害
  const LARGE_KEYS_TO_CLEAR = [
    "lingxi_conversations_v1", "lingxi_history_v1", "lingxi_history_turns_v1",
    "lingxi_material_library_v1", "lingxi_skills_user_v1",
    "lingxi_html_template_cache_v1", "lingxi_html_components_v1",
    "lingxi_doc_report_cache_v1", "lingxi_mindmap_qa_v1",
    "lingxi_preview_log_v1", "lingxi_html_preview_chat_log_v1", "lingxi_html_preview_unified_chat_log_v1"
  ];

  const _map = new Map();
  const _dirty = new Set();
  const _deleted = new Set();
  let _backend = "localStorage";
  let _flushTimer = null;
  let _readyResolve;
  const ready = new Promise((r) => { _readyResolve = r; });

  function base() { return (global.WpsAiRuntime && global.WpsAiRuntime.proxyBase && global.WpsAiRuntime.proxyBase()) || "http://127.0.0.1:3890"; }
  function ls() { return global.localStorage; }

  function getItem(key) { const v = _map.get(key); return v === undefined ? null : v; }
  function setItem(key, value) {
    const v = String(value == null ? "" : value);
    _map.set(key, v);
    if (_backend === "sqlite") { _dirty.add(key); _deleted.delete(key); scheduleFlush(); }
    else { try { ls().setItem(key, v); } catch (e) { throw e; } } // 保留原 QuotaExceeded 行为
  }
  function removeItem(key) {
    _map.delete(key);
    if (_backend === "sqlite") { _deleted.add(key); _dirty.delete(key); scheduleFlush(); }
    else { try { ls().removeItem(key); } catch (e) {} }
  }
  function keys() { return Array.from(_map.keys()); }
  function clear() { keys().forEach(removeItem); }

  function scheduleFlush() { if (_flushTimer) return; _flushTimer = setTimeout(() => { _flushTimer = null; flush(); }, 500); }

  async function flush() {
    if (_backend !== "sqlite") return;
    if (!_dirty.size && !_deleted.size) return;
    const sets = Array.from(_dirty).map((k) => ({ key: k, value: _map.get(k) }));
    const dels = Array.from(_deleted);
    _dirty.clear(); _deleted.clear();
    try {
      const resp = await global.fetch(base() + "/kv/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sets, dels }) });
      if (!resp || !resp.ok) throw new Error("kv/batch 失败");
    } catch (e) { sets.forEach((s) => _dirty.add(s.key)); dels.forEach((k) => _deleted.add(k)); } // 重新标脏下次重试
  }

  async function init() {
    let items = null;
    try {
      const resp = await global.fetch(base() + "/kv/all");
      if (resp && resp.ok) { const j = await resp.json(); if (j && j.ok) items = j.items || {}; }
    } catch (e) {}
    if (items) {
      _backend = "sqlite";
      for (const k in items) _map.set(k, items[k]);
      await migrateIfNeeded();
    } else {
      _backend = "localStorage";
      for (const k of MANAGED_KEYS) { try { const v = ls().getItem(k); if (v != null) _map.set(k, v); } catch (e) {} }
    }
    try {
      global.addEventListener && global.addEventListener("beforeunload", () => {
        if (_backend === "sqlite" && (_dirty.size || _deleted.size)) {
          const sets = Array.from(_dirty).map((k) => ({ key: k, value: _map.get(k) }));
          const dels = Array.from(_deleted);
          try { global.navigator && global.navigator.sendBeacon && global.navigator.sendBeacon(base() + "/kv/batch", new Blob([JSON.stringify({ sets, dels })], { type: "application/json" })); } catch (e) {}
        }
      });
    } catch (e) {}
    _readyResolve(_backend);
    return _backend;
  }

  async function migrateIfNeeded() {
    if (_map.get(MIGRATED_FLAG)) return; // 已迁移
    const sets = [];
    for (const k of MANAGED_KEYS) {
      try { const v = ls().getItem(k); if (v != null && !_map.has(k)) sets.push({ key: k, value: v }); } catch (e) {}
    }
    sets.push({ key: MIGRATED_FLAG, value: String(Date.now()) });
    try {
      const resp = await global.fetch(base() + "/kv/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sets, dels: [] }) });
      if (!resp || !resp.ok) throw new Error("migrate 失败");
      for (const s of sets) _map.set(s.key, s.value);
      for (const k of LARGE_KEYS_TO_CLEAR) { try { ls().removeItem(k); } catch (e) {} }
    } catch (e) { /* 失败：没写标记、没删 ls，下次幂等重试 */ }
  }

  global.WpsAiStore = { getItem, setItem, removeItem, clear, keys, init, ready, flush };
})(window);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test plugin/test/store.test.js`
Expected: PASS（4 tests）。

- [ ] **Step 5: 提交**

```bash
git add plugin/js/store.js plugin/test/store.test.js
git commit -m "feat(store): WpsAiStore 同步存储面板（内存 Map + 防抖回写 + 迁移 + 降级）"
```

---

### Task 5: 装载次序 —— store 首个加载 + boot 先 init

**Files:**
- Modify: `plugin/main.js`（SCRIPTS 数组：把 `js/store.js` 放在**最前**，早于 runtime 之外的一切）
- Modify: `plugin/js/app.js`（主初始化入口最前 `await global.WpsAiStore.init()`）

**Interfaces:**
- Consumes: `WpsAiStore.init()`（Task 4）、`WpsAiRuntime`（proxyBase，store 需要它，故 store 排在 runtime 之后）。

- [ ] **Step 1: main.js 调整加载顺序**

`plugin/main.js` 的 `scripts` 数组：在 `"js/runtime.js"` 之后、`"js/auth.js"` 之前插入 `"js/store.js"`（store 依赖 runtime.proxyBase；auth 等受管模块要在 store 之后）。

- [ ] **Step 2: app.js boot 先 await init**

在 app.js 的主初始化函数（DOMContentLoaded / init 入口）**最前面**加：
```js
try { await global.WpsAiStore.init(); } catch (e) { console.warn("[store] init 失败，降级 localStorage:", e && e.message); }
```
确保它在任何"读缓存"（loadSettings / conversations 首读 / history 首读 / 渲染）之前。

- [ ] **Step 3: 核对"加载即读"点**

Run: `grep -rn "localStorage.getItem" plugin/js | grep -v node_modules`
逐一确认受管 key 的读取都发生在函数内（运行期，init 之后）、不是模块顶层立即执行。若有顶层立即读，挪进 init 后调用的函数。（IPC/端口 key 不管。）

- [ ] **Step 4: 语法 + 套件**

Run: `node --check plugin/main.js && node --check plugin/js/app.js && node --test`
Expected: OK；套件全过。

- [ ] **Step 5: 提交**

```bash
git add plugin/main.js plugin/js/app.js
git commit -m "feat(store): store.js 首个加载 + boot 先 await WpsAiStore.init()"
```

---

### Task 6: 迁移核心大缓存 —— conversations / history

**Files:**
- Modify: `plugin/js/conversations.js`、`plugin/js/history.js`

**Interfaces:**
- Consumes: `global.WpsAiStore`（同步 getItem/setItem/removeItem，与 localStorage 同形）。

- [ ] **Step 1: 机械替换**

在这两个文件里，把对**受管 key** 的 `localStorage.getItem/setItem/removeItem` 换成 `global.WpsAiStore.getItem/setItem/removeItem`。变换模式（逐处照此改）：
```js
// 前
localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
const raw = localStorage.getItem(CURRENT_KEY);
localStorage.removeItem(CURRENT_KEY);
// 后
global.WpsAiStore.setItem(STORAGE_KEY, JSON.stringify(conversations));
const raw = global.WpsAiStore.getItem(CURRENT_KEY);
global.WpsAiStore.removeItem(CURRENT_KEY);
```
保留各自的 QuotaExceeded 兜底 `catch`（sqlite 下 setItem 不抛、不会触发；localStorage 降级下 WpsAiStore.setItem 仍会把 QuotaExceeded 抛出来，原 catch 照旧接住）。

- [ ] **Step 2: 验证无遗漏**

Run: `grep -nE "localStorage\.(get|set|remove)Item" plugin/js/conversations.js plugin/js/history.js`
Expected: 无输出（这两文件不再直接碰 localStorage）。

- [ ] **Step 3: 套件**

Run: `node --test`
Expected: 全过（conversations/history 若有测试，其 mock 需相应提供 WpsAiStore；否则不受影响）。

- [ ] **Step 4: 提交**

```bash
git add plugin/js/conversations.js plugin/js/history.js
git commit -m "refactor(store): conversations/history 缓存改走 WpsAiStore"
```

---

### Task 7: 迁移 素材库 / 技能 / token / 模板缓存 / 组件

**Files:**
- Modify: `plugin/js/material-library.js`、`plugin/js/skills.js`、`plugin/js/token-usage.js`、`plugin/js/html-templates/cache.js`、`plugin/js/html-templates/components.js`

- [ ] **Step 1: 机械替换**

同 Task 6：这些文件里受管 key 的 `localStorage.*` → `global.WpsAiStore.*`。保留各自 slim-and-retry 兜底。

- [ ] **Step 2: 验证无遗漏**

Run: `grep -nE "localStorage\.(get|set|remove)Item" plugin/js/material-library.js plugin/js/skills.js plugin/js/token-usage.js plugin/js/html-templates/cache.js plugin/js/html-templates/components.js`
Expected: 无输出。

- [ ] **Step 3: 套件**

Run: `node --test`（material-library.test.js / skills-cloud.test.js / token-usage.test.js 等若 mock 了 localStorage，需在测试里改成 mock `window.WpsAiStore`——见下方 note）。

> Note: 现有测试 `test/material-library.test.js`、`test/skills-cloud.test.js`、`test/token-usage.test.js` 用 vm 注入了假 `localStorage`。改为注入假 `WpsAiStore`（同 API：`getItem/setItem/removeItem`）。在各测试的 sandbox 里加 `window.WpsAiStore = fakeLocalStorage()` 即可（`fakeLocalStorage` 已是 KV 形态）。

- [ ] **Step 4: 提交**

```bash
git add plugin/js/material-library.js plugin/js/skills.js plugin/js/token-usage.js plugin/js/html-templates/cache.js plugin/js/html-templates/components.js plugin/test/material-library.test.js plugin/test/skills-cloud.test.js plugin/test/token-usage.test.js
git commit -m "refactor(store): 素材库/技能/token/模板缓存/组件 改走 WpsAiStore"
```

---

### Task 8: 迁移 设置 / 令牌 / 更新器 / MCP / app.js 诸键

**Files:**
- Modify: `plugin/js/providers/registry.js`、`plugin/js/auth.js`、`plugin/js/updater.js`、`plugin/js/mcp-bridge.js`、`plugin/js/app.js`

- [ ] **Step 1: 机械替换（app.js 逐 key）**

app.js 里受管 key（`lingxi_doc_report_cache_v1`、`lingxi_mindmap_qa_v1`、`lingxi_models_cache_v1`、`lingxi_image_models_cache_v1`、`lingxi_model_group_collapsed_v1`、`lingxi_ai_thinking_level_v1`、`lingxi_pure_mode`、`wpsAiChatFoldMiddle`、`wpsAiProviderHealthV1`、`wpsAiCacheAutoCleanPolicy`、`wpsAiCacheAutoCleanLastRunAt`、`lingxi_preview_log_v1`、`lingxi_html_preview_chat_log_v1`、`lingxi_html_preview_unified_chat_log_v1`、`lingxi_html_preview_picked_components_v1`、`__lingxi_editor_tips_seen__`）的 `localStorage.*` → `global.WpsAiStore.*`。
**不动**的（保留 localStorage）：所有 `*_dialog_request_v1/result_v1`、`lingxi_html_preview_pending_insert_v1`、`lingxi_material_dialog_insert_v1/modify_v1`、`lingxi_full_deck_progress_v1`、`lingxi_writer_insertion_range_hint_v1`、`lingxi_runtime_proxy_port_v1`。registry.js 的 `wps_ai_provider_settings_v1`、auth.js 的 OAuth 令牌键、updater.js 的 `lingxi_device_sn_v1`/`lingxi_updater_last_check_v1`、mcp-bridge.js 的 `wpsAiMcpBridgeToken` → 换成 WpsAiStore。

- [ ] **Step 2: 验证**

Run: `grep -nE "localStorage\.(get|set|remove)Item" plugin/js/providers/registry.js plugin/js/auth.js plugin/js/updater.js plugin/js/mcp-bridge.js plugin/js/app.js`
Expected: 仅剩**保留清单**里的 IPC / 端口 key（人工核对每条都在保留清单内）。`installLocalStorageGuard` 内部对 `Storage.prototype` 的引用保留不动。

- [ ] **Step 3: 语法 + 套件**

Run: `node --check plugin/js/app.js && node --test`
Expected: OK；全过。

- [ ] **Step 4: 提交**

```bash
git add plugin/js/providers/registry.js plugin/js/auth.js plugin/js/updater.js plugin/js/mcp-bridge.js plugin/js/app.js
git commit -m "refactor(store): 设置/令牌/更新器/MCP/app 诸缓存改走 WpsAiStore；IPC/端口保留 localStorage"
```

---

### Task 9: 缓存管理 UI 改走 `/kv/stats` + `/kv/clear`

**Files:**
- Modify: `plugin/js/cache.js`

**Interfaces:**
- Consumes: 代理 `GET /kv/stats`、`POST /kv/clear`（Task 2）。

- [ ] **Step 1: 改实现**

`cache.js` 原来扫 `localStorage` 键分组算大小 → 改为：`fetch(base()+"/kv/stats")` 拿 `{entries:[{key,bytes}],total}`，按现有分组规则（key 前缀）归类展示；"清理"按钮改 `fetch(base()+"/kv/clear",{method:"POST",body:JSON.stringify({keys})})`，清完让 `WpsAiStore` 同步内存（`keys.forEach((k)=>window.WpsAiStore.removeItem(k))` 或重载）。IPC 部分仍扫 localStorage 展示（保持原逻辑那一小块）。降级（stats 503）时回退扫 localStorage。

- [ ] **Step 2: 语法 + 套件**

Run: `node --check plugin/js/cache.js && node --test`
Expected: OK；全过。

- [ ] **Step 3: 手动验证（WPS 内）**

代理带 flag 启动 → 面板 reload → 打开缓存管理，能看到 SQLite 各项大小；点清理某组，SQLite 与内存都清掉。

- [ ] **Step 4: 提交**

```bash
git add plugin/js/cache.js
git commit -m "feat(store): 缓存管理 UI 改查 /kv/stats、清 /kv/clear"
```

---

## 收尾验证（全部任务后）

- [ ] `grep -rnE "localStorage\.(get|set|remove)Item" plugin/js | grep -v node_modules` → 只剩保留清单（IPC / 端口）与 `installLocalStorageGuard` 的 `Storage.prototype` 引用。
- [ ] 代理带 `--experimental-sqlite` 启动，WPS 内跑一轮：新对话、生成 PPT、翻译、导入素材 → 全部持久化；重开 WPS 数据仍在；`~/.lingxi-ai/lingxi.db` 有数据。
- [ ] 故意不带 flag 启动代理 → `/kv/*` 回 503 → 面板降级 localStorage，功能不崩。
- [ ] `node --test` 全过；`node --experimental-sqlite --test plugin/test/kv-store.test.js` 全过。
