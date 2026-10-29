# Token 消耗面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从各 provider 抓取 token usage，聚合持久化，在设置里新增「Token 消耗」面板按模型分组展示。

**Architecture:** 新增中央 store `js/token-usage.js`（localStorage 按 `provider::model` 聚合，每次 record 读-改-写；另存会话小计）。openai/anthropic/codex 三个 provider 拿到响应 usage 后调 `global.WpsAiTokenUsage?.record(...)`。设置面板在 MCP 与「程序信息」之间新增 tab + panel 展示总计/会话/分组表。

**Tech Stack:** 浏览器 IIFE（挂 window）；WPS JSAPI；SSE 流式；测试用 Node 内置 `node:test`/`node:assert`/`node:vm`（注入内存 localStorage）。

## Global Constraints

- 不引入任何新依赖。源码是挂 `window` 的 IIFE；store 测试用 `node:vm` 沙箱注入内存 `localStorage`。
- 持久键 `lingxi_token_usage_v1`；聚合键 `provider::model`；结构 `{ model, provider, input, output, total, calls, lastAt }`。
- 每次 `record` read-modify-write（防 4 宿主共享 localStorage 整表覆盖）。
- 仅 token 数（input/output/total/calls）；**不做成本估算/图表/导出/每轮明细**（YAGNI）。
- `record({provider,model,input,output})`：input/output 均 ≤0 或非数字 → 忽略不记；provider/model 缺省 "unknown"。
- provider 未返回 usage → 不 record，不报错；`global.WpsAiTokenUsage?.record` 用可选链，store 未加载也不影响主流程。
- 新 tab 插在 `data-settings-panel="mcp"` 与 `data-settings-panel="about"` 之间，`data-settings-panel="tokens"`。

---

## 文件结构

- `plugin/js/token-usage.js`（新增）— 中央 store。
- `plugin/js/providers/openai.js` / `anthropic.js` / `codex.js`（改）— 抓 usage + record。
- `plugin/taskpane.html`（改）— 新 tab + panel。
- `plugin/js/app.js`（改）— renderTokenUsagePanel + switch 渲染 + 清零 + onChange。
- `plugin/main.js`（改）— 加载 token-usage.js。
- `plugin/css/style.css`（改）— 面板样式。
- `plugin/test/token-usage.test.js`（新增）— store 单测。

---

## Task 1: token-usage.js 中央 store（+ 单测）

**Files:**
- Create: `plugin/js/token-usage.js`
- Test: `plugin/test/token-usage.test.js`

**Interfaces:**
- Produces（`window.WpsAiTokenUsage`）：
  - `record({ provider, model, input, output }) => void`
  - `getBreakdown() => Array<{model,provider,input,output,total,calls,lastAt}>`（total 降序）
  - `getTotals() => {input,output,total,calls}`
  - `getSession() => {input,output,total,calls}`
  - `clear() => void`
  - `onChange(fn) => void` / `offChange(fn) => void`

- [ ] **Step 1: 写失败测试** `plugin/test/token-usage.test.js`

```js
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadStore() {
  const mem = new Map();
  const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "token-usage.js"), "utf8");
  const sandbox = { window: {}, localStorage, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiTokenUsage;
}

test("record accumulates input/output/total/calls for same provider::model", () => {
  const t = loadStore();
  t.record({ provider: "OpenAI", model: "gpt-4o", input: 100, output: 20 });
  t.record({ provider: "OpenAI", model: "gpt-4o", input: 50, output: 10 });
  const b = t.getBreakdown();
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].input, 150);
  assert.strictEqual(b[0].output, 30);
  assert.strictEqual(b[0].total, 180);
  assert.strictEqual(b[0].calls, 2);
  assert.strictEqual(b[0].model, "gpt-4o");
  assert.strictEqual(b[0].provider, "OpenAI");
});

test("same model under different providers are separate rows, sorted by total desc", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m", input: 10, output: 5 });    // total 15
  t.record({ provider: "B", model: "m", input: 100, output: 50 });  // total 150
  const b = t.getBreakdown();
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[0].provider, "B");   // larger total first
  assert.strictEqual(b[1].provider, "A");
});

test("getTotals sums all rows", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m1", input: 10, output: 5 });
  t.record({ provider: "B", model: "m2", input: 20, output: 5 });
  const g = t.getTotals();
  assert.strictEqual(g.input, 30);
  assert.strictEqual(g.output, 10);
  assert.strictEqual(g.total, 40);
  assert.strictEqual(g.calls, 2);
});

test("getSession reflects only this-process records", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m", input: 7, output: 3 });
  const s = t.getSession();
  assert.strictEqual(s.input, 7);
  assert.strictEqual(s.output, 3);
  assert.strictEqual(s.total, 10);
  assert.strictEqual(s.calls, 1);
});

test("invalid records are ignored (all-zero / non-numeric)", () => {
  const t = loadStore();
  t.record({});
  t.record({ provider: "A", model: "m", input: 0, output: 0 });
  t.record({ provider: "A", model: "m", input: "x", output: null });
  assert.strictEqual(t.getBreakdown().length, 0);
  assert.strictEqual(t.getSession().calls, 0);
});

test("missing provider/model default to unknown", () => {
  const t = loadStore();
  t.record({ input: 5, output: 5 });
  const b = t.getBreakdown();
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].model, "unknown");
  assert.strictEqual(b[0].provider, "unknown");
});

test("clear empties persistent + session", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m", input: 10, output: 5 });
  t.clear();
  assert.strictEqual(t.getBreakdown().length, 0);
  assert.strictEqual(t.getTotals().total, 0);
  assert.strictEqual(t.getSession().total, 0);
});

test("onChange fires on record and clear", () => {
  const t = loadStore();
  let n = 0;
  t.onChange(() => { n += 1; });
  t.record({ provider: "A", model: "m", input: 1, output: 1 });
  t.clear();
  assert.strictEqual(n, 2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugin && node --test test/token-usage.test.js`
Expected: FAIL — 无法读取 `WpsAiTokenUsage`（文件不存在）。

- [ ] **Step 3: 实现 `plugin/js/token-usage.js`**

```js
(function attachTokenUsage(global) {
  "use strict";

  // AI token 用量：按 provider::model 聚合持久化 + 本会话小计。
  // 每次 record 都 read-modify-write，避免 4 宿主共享同一 localStorage 时整表覆盖丢数据。
  const STORAGE_KEY = "lingxi_token_usage_v1";
  const listeners = new Set();
  const session = { input: 0, output: 0, total: 0, calls: 0 };

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) { return {}; }
  }
  function saveAll(map) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (e) {}
  }
  function notify() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); }

  function record({ provider, model, input, output } = {}) {
    const inTok = Number(input) || 0;
    const outTok = Number(output) || 0;
    if (inTok <= 0 && outTok <= 0) return;
    const mdl = String(model || "unknown");
    const prov = String(provider || "unknown");
    const key = prov + "::" + mdl;
    const map = loadAll();
    const cur = map[key] || { model: mdl, provider: prov, input: 0, output: 0, total: 0, calls: 0, lastAt: 0 };
    cur.model = mdl;
    cur.provider = prov;
    cur.input = (Number(cur.input) || 0) + inTok;
    cur.output = (Number(cur.output) || 0) + outTok;
    cur.total = cur.input + cur.output;
    cur.calls = (Number(cur.calls) || 0) + 1;
    cur.lastAt = Date.now();
    map[key] = cur;
    saveAll(map);
    session.input += inTok;
    session.output += outTok;
    session.total = session.input + session.output;
    session.calls += 1;
    notify();
  }

  function getBreakdown() {
    const map = loadAll();
    return Object.keys(map).map((k) => {
      const e = map[k] || {};
      return {
        model: String(e.model || "unknown"),
        provider: String(e.provider || "unknown"),
        input: Number(e.input) || 0,
        output: Number(e.output) || 0,
        total: Number(e.total) || 0,
        calls: Number(e.calls) || 0,
        lastAt: Number(e.lastAt) || 0
      };
    }).sort((a, b) => b.total - a.total);
  }

  function getTotals() {
    return getBreakdown().reduce((acc, e) => {
      acc.input += e.input; acc.output += e.output; acc.total += e.total; acc.calls += e.calls;
      return acc;
    }, { input: 0, output: 0, total: 0, calls: 0 });
  }

  function getSession() {
    return { input: session.input, output: session.output, total: session.total, calls: session.calls };
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    session.input = 0; session.output = 0; session.total = 0; session.calls = 0;
    notify();
  }

  function onChange(fn) { if (typeof fn === "function") listeners.add(fn); }
  function offChange(fn) { listeners.delete(fn); }

  global.WpsAiTokenUsage = { record, getBreakdown, getTotals, getSession, clear, onChange, offChange };
})(window);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd plugin && node --test test/token-usage.test.js`
Expected: PASS（8 用例全绿）。也跑 `node --test "test/*.test.js"` 确认没破坏别的。

- [ ] **Step 5: 提交**

```bash
git add plugin/js/token-usage.js plugin/test/token-usage.test.js
git commit -m "feat(usage): central token-usage store (persistent per provider::model + session)"
```

---

## Task 2: provider 抓 usage 并 record

**Files:**
- Modify: `plugin/js/providers/openai.js`、`plugin/js/providers/anthropic.js`、`plugin/js/providers/codex.js`

**Interfaces:**
- Consumes: `global.WpsAiTokenUsage?.record({ provider, model, input, output })`（Task 1）。`provider` 用 `config.label || "<type>"`（openai/anthropic/codex）。

说明：每处都是在既有代码里插入 usage 捕获 + 一句 `record`，用 try/catch 或可选链保证不影响主流程。SSE 流式在回调里捕获 usage 变量，`readSse` 结束后 record。

### openai.js

- [ ] **Step 1: chat（非流）record**

找到 `chat({ model, messages, temperature })` 里 `const payload = await response.json()...`、`return payload.choices?.[0]?.message?.content || ""` 之前，插入：
```js
        try {
          const u = payload.usage;
          if (u) global.WpsAiTokenUsage?.record({ provider: config.label || "openai", model, input: u.prompt_tokens, output: u.completion_tokens });
        } catch (e) {}
```

- [ ] **Step 2: streamChat + runWithTools 请求体加 include_usage**

在 `streamChat` 与 `runWithTools` 构造请求 body 的对象里（`stream: true` 同级）加：
```js
          stream_options: { include_usage: true },
```

- [ ] **Step 3: streamChat 捕获并 record**

在 `streamChat` 的 `let fullText = "";` 后加 `let usage = null;`；在 SSE 回调里（`readSse(response, (_eventType, payload) => {`）开头加：
```js
          if (payload.usage) { usage = payload.usage; return; }
```
在 `await readSse(...)` 之后、`return fullText;` 之前加：
```js
        try {
          if (usage) global.WpsAiTokenUsage?.record({ provider: config.label || "openai", model, input: usage.prompt_tokens, output: usage.completion_tokens });
        } catch (e) {}
```

- [ ] **Step 4: runWithTools 捕获并 record（每轮）**

在 `runWithTools` 的 for 循环内，`let fullText = "";` 附近加 `let usage = null;`；SSE 回调开头加 `if (payload.usage) { usage = payload.usage; return; }`；`await readSse(...)` 之后加：
```js
          try {
            if (usage) global.WpsAiTokenUsage?.record({ provider: config.label || "openai", model, input: usage.prompt_tokens, output: usage.completion_tokens });
          } catch (e) {}
```

### anthropic.js

- [ ] **Step 5: chat（非流）record**

在 `chat` 的 `const payload = await response.json()...` 之后、return 之前加：
```js
        try {
          const u = payload.usage;
          if (u) global.WpsAiTokenUsage?.record({ provider: config.label || "anthropic", model, input: u.input_tokens, output: u.output_tokens });
        } catch (e) {}
```

- [ ] **Step 6: streamChat 捕获 message_start/message_delta 并 record**

在 `streamChat` 的 `let fullText = "";` 后加 `let inTok = 0, outTok = 0;`；SSE 回调里补分支：
```js
          if (eventType === "message_start") { inTok = payload.message?.usage?.input_tokens || inTok; }
          if (eventType === "message_delta") { outTok = payload.usage?.output_tokens || outTok; }
```
`await readSse(...)` 之后加：
```js
        try {
          if (inTok || outTok) global.WpsAiTokenUsage?.record({ provider: config.label || "anthropic", model, input: inTok, output: outTok });
        } catch (e) {}
```

- [ ] **Step 7: runWithTools 捕获并 record（每轮）**

在 `runWithTools` 的每轮 SSE 前加 `let inTok = 0, outTok = 0;`；SSE 回调里补上面同样的 message_start/message_delta 两行；`await readSse(...)` 之后加：
```js
          try {
            if (inTok || outTok) global.WpsAiTokenUsage?.record({ provider: config.label || "anthropic", model, input: inTok, output: outTok });
          } catch (e) {}
```

### codex.js

- [ ] **Step 8: chat（非流）record**

在 `chat` 拿到 `payload` 后、`return getResponseText(payload)` 之前加：
```js
        try {
          const u = payload.usage || payload.response?.usage;
          if (u) global.WpsAiTokenUsage?.record({ provider: config.label || "codex", model, input: u.input_tokens, output: u.output_tokens });
        } catch (e) {}
```

- [ ] **Step 9: streamChat + runWithTools 捕获 response.completed 并 record**

在 `streamChat` 与 `runWithTools`（每轮）的 SSE 回调里，`response.completed` 分支已存在（读 `payload.response?.output`）；在同一分支里补捕获 usage：`const _u = payload.response?.usage; if (_u) completedUsage = _u;`（在该函数/该轮作用域先 `let completedUsage = null;`）。对应 `await readSse(...)` 之后加：
```js
          try {
            if (completedUsage) global.WpsAiTokenUsage?.record({ provider: config.label || "codex", model, input: completedUsage.input_tokens, output: completedUsage.output_tokens });
          } catch (e) {}
```
（streamChat 用函数级 `let completedUsage=null`；runWithTools 用每轮的局部 `let completedUsage=null`。）

- [ ] **Step 10: 校验 + 提交**

Run: `cd plugin && node -c js/providers/openai.js && node -c js/providers/anthropic.js && node -c js/providers/codex.js`
Expected: 全部无输出（语法通过）。

Run: `cd plugin && node --test "test/*.test.js"`
Expected: 全绿（本任务不动被测代码）。

WPS 手动验证（延后给 controller/用户）：真实跑聊天/选区操作，确认对应 provider record 了 token（可临时在 record 里打日志或用面板看）。

```bash
git add plugin/js/providers/openai.js plugin/js/providers/anthropic.js plugin/js/providers/codex.js
git commit -m "feat(usage): capture token usage from openai/anthropic/codex responses"
```

---

## Task 3: UI 面板（tab + panel + 渲染 + 清零 + 加载）

**Files:**
- Modify: `plugin/taskpane.html`、`plugin/js/app.js`、`plugin/main.js`、`plugin/css/style.css`

**Interfaces:**
- Consumes: `WpsAiTokenUsage.getTotals/getSession/getBreakdown/clear/onChange`（Task 1）；`switchSettingsPanel(name)`（app.js 既有）。

- [ ] **Step 1: main.js 加载 token-usage.js**

在 `main.js` 的脚本数组里，`"js/conversations.js",` 之后加一行：
```js
    "js/token-usage.js",
```

- [ ] **Step 2: taskpane.html 加 tab（MCP 与程序信息之间）**

找到侧栏里 `data-settings-panel="mcp"` 的 `<button>`（含「MCP 服务」）与 `data-settings-panel="about"` 的 `<button>`（含「程序信息」）。在这两个 button 之间插入：
```html
              <button type="button" class="settings-sidebar-btn" data-settings-panel="tokens" role="tab">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10.5h3a1.5 1.5 0 0 1 0 3h-3"/></svg>
                <span>Token 消耗</span>
              </button>
```

- [ ] **Step 3: taskpane.html 加 panel**

在 MCP 的 `<section class="settings-panel hidden" data-settings-panel="mcp">…</section>` 之后（程序信息 section 之前）插入：
```html
              <!-- Token 消耗：按模型聚合的 token 用量 -->
              <section class="settings-panel hidden" data-settings-panel="tokens">
                <div class="panel-header" style="display:flex;align-items:center;justify-content:space-between">
                  <h3>Token 消耗</h3>
                  <button id="tokenUsageClearBtn" class="ghost-btn compact-btn" type="button">清零</button>
                </div>
                <p class="muted">统计各模型累计消耗的 token（持久保存）。只在 provider 返回用量时记录；部分兼容网关不返回则不计入。</p>
                <div id="tokenUsageTotals" class="token-usage-totals"></div>
                <div id="tokenUsageSession" class="muted token-usage-session"></div>
                <div class="panel-header" style="margin-top:14px"><h3>按模型</h3></div>
                <div id="tokenUsageTable" class="token-usage-table"></div>
              </section>
```

- [ ] **Step 4: app.js 渲染函数 + 千分位 helper**

在 app.js 合适位置（靠近其它 render 函数）加：
```js
  function fmtInt(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function renderTokenUsagePanel() {
    const store = global.WpsAiTokenUsage;
    const totalsEl = document.getElementById("tokenUsageTotals");
    const sessionEl = document.getElementById("tokenUsageSession");
    const tableEl = document.getElementById("tokenUsageTable");
    if (!store || !totalsEl || !tableEl) return;
    const g = store.getTotals();
    const s = store.getSession();
    totalsEl.innerHTML =
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.input)}</span><span class="token-stat-lbl">输入</span></div>` +
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.output)}</span><span class="token-stat-lbl">输出</span></div>` +
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.total)}</span><span class="token-stat-lbl">总计</span></div>` +
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.calls)}</span><span class="token-stat-lbl">调用</span></div>`;
    if (sessionEl) sessionEl.textContent = `本会话：输入 ${fmtInt(s.input)} · 输出 ${fmtInt(s.output)} · 总计 ${fmtInt(s.total)} · ${fmtInt(s.calls)} 次`;
    const rows = store.getBreakdown();
    if (!rows.length) {
      tableEl.innerHTML = `<div class="muted" style="padding:12px 0">暂无记录。跑一次 AI 对话或选区操作后这里会显示各模型的 token 用量。</div>`;
      return;
    }
    const head = `<div class="token-row token-row-head"><span>模型</span><span>来源</span><span>输入</span><span>输出</span><span>总计</span><span>次数</span></div>`;
    const body = rows.map((r) =>
      `<div class="token-row"><span title="${escapeHtml(r.model)}">${escapeHtml(r.model)}</span><span title="${escapeHtml(r.provider)}">${escapeHtml(r.provider)}</span><span>${fmtInt(r.input)}</span><span>${fmtInt(r.output)}</span><span>${fmtInt(r.total)}</span><span>${fmtInt(r.calls)}</span></div>`
    ).join("");
    tableEl.innerHTML = head + body;
  }
```
（`escapeHtml` 用文件里已有的那个——app.js 有 `escapeHtml`，直接用。）

- [ ] **Step 5: app.js 切到 tokens tab 时渲染 + 清零 + onChange**

在 `switchSettingsPanel(name)` 函数体末尾（toggle 完 active/hidden 之后）加：
```js
    if (name === "tokens") { try { renderTokenUsagePanel(); } catch (e) {} }
```

在 app.js 初始化事件绑定的地方（其它按钮绑定附近）加清零绑定与订阅：
```js
    document.getElementById("tokenUsageClearBtn")?.addEventListener("click", () => {
      if (window.confirm("确定清零所有 token 用量统计？此操作不可撤销。")) {
        global.WpsAiTokenUsage?.clear();
        renderTokenUsagePanel();
      }
    });
    global.WpsAiTokenUsage?.onChange?.(() => {
      const sec = document.querySelector('.settings-panel[data-settings-panel="tokens"]');
      if (sec && !sec.classList.contains("hidden")) renderTokenUsagePanel();
    });
```
（放在 DOM 就绪、其它 `addEventListener` 初始化的同一函数里；若该处拿不到 `global`，用 `window`。）

- [ ] **Step 6: css/style.css 样式**

在 style.css 末尾追加：
```css
.token-usage-totals { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.token-stat { flex: 1 1 90px; background: var(--panel-bg, #f7f8fa); border: 1px solid var(--border, #e5e7eb); border-radius: 8px; padding: 10px 12px; text-align: center; }
.token-stat-num { display: block; font-size: 18px; font-weight: 600; }
.token-stat-lbl { display: block; font-size: 11px; color: var(--muted, #6b7480); margin-top: 2px; }
.token-usage-session { font-size: 12px; margin-bottom: 4px; }
.token-usage-table { display: flex; flex-direction: column; font-size: 12px; }
.token-row { display: grid; grid-template-columns: 1.6fr 1fr 0.8fr 0.8fr 0.8fr 0.6fr; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--border, #eee); }
.token-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.token-row span:nth-child(n+3) { text-align: right; font-variant-numeric: tabular-nums; }
.token-row-head { font-weight: 600; color: var(--muted, #6b7480); border-bottom: 1px solid var(--border, #ddd); }
```

- [ ] **Step 7: 校验 + 提交**

Run: `cd plugin && node -c js/app.js && node -c main.js`
Expected: 无输出（语法通过）。

Run: `cd plugin && node --test "test/*.test.js"`
Expected: 全绿。

WPS 手动验证（延后）：设置里 MCP 与「程序信息」之间出现「Token 消耗」tab；跑几次 AI 后总计/会话/分组表显示真实 token；清零生效;换模型后新行出现。

```bash
git add plugin/taskpane.html plugin/js/app.js plugin/main.js plugin/css/style.css
git commit -m "feat(usage): Token 消耗 settings panel (totals + session + per-model table)"
```

---

## Self-Review 备注

- Spec 覆盖：store(Task1)、三 provider 抓取(Task2)、tab+panel+render+clear+load(Task3)、read-modify-write(store record)、忽略非法/缺省 unknown(store + 测试)、不做成本(全程未涉及)——全覆盖。
- 类型一致：`record({provider,model,input,output})`、`getBreakdown/getTotals/getSession` 返回结构、`WpsAiTokenUsage` 命名在各处一致；provider 字段统一 `config.label || "<type>"`。
- 无占位：store + 测试完整代码；provider/UI 改动给出确切插入锚点 + 代码；COM/DOM 部分以明确 WPS 手动步骤替代（非占位）。
