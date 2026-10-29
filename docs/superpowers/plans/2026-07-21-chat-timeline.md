# 聊天时间轴（类 Claude）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把聊天区从微信风气泡改成类 Claude 的「文档流消息 + AI 步骤竖向轨道」时间轴，完全替掉气泡。

**Architecture:** 新增纯模块 `plugin/js/chat/timeline.js`：一层可单测的「事件序列 → 轨道步骤模型」纯逻辑 + 一层 DOM 渲染器。`app.js` 的实时事件分支（`handleStreamEvent`）与历史回放（`appendHistoryEvent`/`appendHistoryBlock`）都改成调 timeline 渲染器产出 DOM，事件管线/持久化不动，两路共用同一渲染保证一致。

**Tech Stack:** 原生 JS（IIFE + `window` 挂载，与 `js/chat/*.js` 一致）、`node:test` + `vm`（与现有测试一致）、原生 CSS。

## Global Constraints

- 模块风格：`(function attach…(global){ "use strict"; … global.WpsAiChatTimeline = {…}; })(window);`，与 `js/chat/events.js` 一致。
- 测试风格：`node:test` + `vm.runInContext`，`window` 用普通对象 shim（见 `test/chat-events.test.js`）。不引入 jsdom / 新依赖。
- 图标：沿用现有线性 SVG（`CAP_ICON_SVG` 那套 stroke-currentColor），不用 emoji / 彩色图标。
- 主色：WPS 蓝 `var(--primary)` / `var(--primary-soft)`；圆角 `var(--radius-sm)`；边框 `var(--border)`。
- 事件类型（不新增、不改）：`reasoning_chunk / reasoning_end / assistant_chunk / assistant_text_end / assistant_text / tool_call / tool_result / done`；历史块类型 `text / reasoning / tool-call / tool-result / error / status / source / file`。
- 完全替掉气泡：不做视图模式开关。轨道**默认展开**，只提供手动整体折叠（不自动折叠）。步骤节点默认收起（一行），点击展开。
- 每次改完同步四变体目录 `~/.lingxi-ai/plugin-{wps,et,wpp,pdf}/` 并保持 `node --test test/*.test.js` 既有 4 个失败数不新增。
- 提交只到本地，不 push。commit 结尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## File Structure

- `plugin/js/chat/timeline.js`（新建）：纯模型 `buildTurnSteps` + DOM 渲染器（`renderUserMessage` / `beginAssistantTurn` / `renderTurnModel` / 折叠）。挂 `window.WpsAiChatTimeline`。
- `plugin/test/chat-timeline.test.js`（新建）：纯模型 + DOM 结构（用最小 `document` stub）单测。
- `plugin/main.js`（改）：在 `js/chat/history-sanitize.js`（135 行）之后、`js/app.js`（165 行）之前加载 timeline.js。
- `plugin/css/style.css`（改）：新增 `.chat-timeline / .tl-*` 样式；移除/中和旧 `.chat-msg*` 气泡样式（2260 起）。
- `plugin/js/app.js`（改）：`handleStreamEvent` 事件分支（~9177–9300）、`appendHistoryEvent`（12938）、`appendHistoryBlock`（12976）改调 timeline；移除头像/旧工具气泡/`renderTurnSummary` 死码。

---

### Task 1: timeline.js 纯模型 —— 事件序列 → 轨道步骤

**Files:**
- Create: `plugin/js/chat/timeline.js`
- Test: `plugin/test/chat-timeline.test.js`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  - `WpsAiChatTimeline.buildTurnSteps(turnEvents)` → `Array<Step>`，`Step = { kind:"reasoning"|"tool"|"text"|"error", name?:string, status:"running"|"ok"|"error", text?:string, args?:any, result?:any }`。入参是 app.js 里累积的 `turnEvents`（元素形如 `{type:"reasoning",text}` / `{type:"tool_call",name,args}` / `{type:"tool_result",name,result}` / `{type:"assistant",text}`）。规则：`tool_call` 建一个 `kind:"tool" status:"running"` 步骤；随后同名 `tool_result` 把最近一个该名 running 步骤置为 `ok`（`result.ok!==false`）或 `error`，并挂 `result`；`reasoning`→`kind:"reasoning"`；`assistant`→`kind:"text"`。
  - `WpsAiChatTimeline.stepStatusFromResult(result)` → `"ok"|"error"`（`result && result.ok===false` → error，否则 ok）。

- [ ] **Step 1: 写失败测试**

`plugin/test/chat-timeline.test.js`：
```js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTimeline(documentStub) {
  const context = { window: {}, console };
  if (documentStub) context.document = documentStub;
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "chat", "timeline.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiChatTimeline;
}

test("buildTurnSteps：tool_call+tool_result 配对成一个 ok 步骤", () => {
  const T = loadTimeline();
  const steps = T.buildTurnSteps([
    { type: "reasoning", text: "先想想" },
    { type: "tool_call", name: "et_read_range", args: { a: 1 } },
    { type: "tool_result", name: "et_read_range", result: { ok: true, value: 42 } },
    { type: "assistant", text: "读到了" }
  ]);
  assert.equal(steps.length, 3);
  assert.deepEqual([steps[0].kind, steps[1].kind, steps[2].kind], ["reasoning", "tool", "text"]);
  assert.equal(steps[1].status, "ok");
  assert.deepEqual(steps[1].result, { ok: true, value: 42 });
  assert.equal(steps[2].text, "读到了");
});

test("buildTurnSteps：tool_result.ok===false → error 步骤", () => {
  const T = loadTimeline();
  const steps = T.buildTurnSteps([
    { type: "tool_call", name: "wps_insert_text", args: {} },
    { type: "tool_result", name: "wps_insert_text", result: { ok: false, error: "boom" } }
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "error");
});

test("buildTurnSteps：无 tool_result 的 tool_call 保持 running", () => {
  const T = loadTimeline();
  const steps = T.buildTurnSteps([{ type: "tool_call", name: "x", args: {} }]);
  assert.equal(steps[0].status, "running");
});

test("stepStatusFromResult", () => {
  const T = loadTimeline();
  assert.equal(T.stepStatusFromResult({ ok: true }), "ok");
  assert.equal(T.stepStatusFromResult({ ok: false }), "error");
  assert.equal(T.stepStatusFromResult(null), "ok");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugin && node --test test/chat-timeline.test.js`
Expected: FAIL（`Cannot read properties of undefined` / `WpsAiChatTimeline` 未定义）。

- [ ] **Step 3: 写最小实现**

`plugin/js/chat/timeline.js`：
```js
(function attachChatTimeline(global) {
  "use strict";

  function stepStatusFromResult(result) {
    return (result && result.ok === false) ? "error" : "ok";
  }

  // turnEvents（app.js 累积的一轮事件）→ 有序步骤模型。
  // tool_call 建 running 步骤；同名 tool_result 回填最近一个该名 running 步骤的状态+结果。
  function buildTurnSteps(turnEvents) {
    const steps = [];
    for (const ev of (turnEvents || [])) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "reasoning") {
        steps.push({ kind: "reasoning", status: "ok", text: ev.text || "" });
      } else if (ev.type === "tool_call") {
        steps.push({ kind: "tool", name: ev.name, status: "running", args: ev.args });
      } else if (ev.type === "tool_result") {
        let hit = null;
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].kind === "tool" && steps[i].name === ev.name && steps[i].status === "running") { hit = steps[i]; break; }
        }
        if (hit) { hit.status = stepStatusFromResult(ev.result); hit.result = ev.result; }
        else steps.push({ kind: "tool", name: ev.name, status: stepStatusFromResult(ev.result), result: ev.result });
      } else if (ev.type === "assistant") {
        steps.push({ kind: "text", status: "ok", text: ev.text || "" });
      } else if (ev.type === "error") {
        steps.push({ kind: "error", status: "error", text: ev.text || ev.message || "" });
      }
    }
    return steps;
  }

  global.WpsAiChatTimeline = { buildTurnSteps, stepStatusFromResult };
})(window);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd plugin && node --test test/chat-timeline.test.js`
Expected: PASS（4 个 test 全过）。

- [ ] **Step 5: 提交**

```bash
cd /e/workspace/other/wps-ai/wps-ai
git add plugin/js/chat/timeline.js plugin/test/chat-timeline.test.js
git commit -m "feat(timeline): 纯模型 buildTurnSteps —— 一轮事件映射成有序步骤

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: timeline.js DOM 渲染器

**Files:**
- Modify: `plugin/js/chat/timeline.js`
- Test: `plugin/test/chat-timeline.test.js`

**Interfaces:**
- Consumes: Task 1 的 `buildTurnSteps`。
- Produces（挂到 `WpsAiChatTimeline`）：
  - `renderUserMessage({ text, quickAction }) -> HTMLElement`：文档流用户块。`quickAction={label,prompt}` 时渲成一行可展开操作盒子。
  - `renderAssistantTurn({ steps, meta }) -> HTMLElement`：整轮 AI 块（`.tl-msg.tl-assistant` + `.tl-rail`），`steps` 来自 `buildTurnSteps`，`meta={model,elapsedMs}`。每个 tool/reasoning 步骤默认收起一行、带 `data-expandable`；文本步骤直接铺开。含手动折叠头。
  - `renderErrorMessage(text) -> HTMLElement`：文档流红条。
- 注：实时流式的增量 DOM 操作（append 文本 delta、running→done 改状态）在 Task 4 由 app.js 直接操作 timeline 产出的节点完成，本任务只保证「给定完整 steps 能构建正确结构」。

- [ ] **Step 1: 写失败测试（用最小 document stub 验证结构，不验像素）**

追加到 `plugin/test/chat-timeline.test.js`：
```js
// 最小 document stub：记录 createElement/className/children，够验证结构，不渲染。
function makeDocStub() {
  function el(tag) {
    return {
      tagName: tag, className: "", dataset: {}, children: [], textContent: "",
      _html: "", set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.dataset[k.replace(/^data-/, "")] = v; },
      querySelectorAll(sel) { // 只支持按 class 递归查
        const cls = sel.replace(".", ""); const out = [];
        (function walk(n) { for (const c of n.children) { if ((c.className || "").split(" ").includes(cls)) out.push(c); walk(c); } })(this);
        return out;
      },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
    };
  }
  return { createElement: (t) => el(t) };
}

test("renderAssistantTurn：每个 tool/reasoning 步骤是一个 .tl-step 节点", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const steps = T.buildTurnSteps([
    { type: "reasoning", text: "想" },
    { type: "tool_call", name: "et_read_range", args: {} },
    { type: "tool_result", name: "et_read_range", result: { ok: true } },
    { type: "assistant", text: "答案" }
  ]);
  const node = T.renderAssistantTurn({ steps, meta: { model: "gpt-x", elapsedMs: 1200 } });
  const stepEls = node.querySelectorAll(".tl-step");
  assert.equal(stepEls.length, 3); // reasoning + tool + text 各一个
});

test("renderUserMessage：quickAction 渲成可展开盒子（带 data-quickaction）", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const node = T.renderUserMessage({ text: "全文润色", quickAction: { label: "润色", prompt: "把全文润色得更专业" } });
  assert.equal(node.dataset.quickaction, "1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugin && node --test test/chat-timeline.test.js`
Expected: FAIL（`renderAssistantTurn is not a function`）。

- [ ] **Step 3: 实现 DOM 渲染器**

在 `plugin/js/chat/timeline.js` 里补 `renderUserMessage` / `renderAssistantTurn` / `renderErrorMessage`，用 `global.document`。结构约定（class 名固定，供 CSS 与测试对齐）：
- 用户块：`<div class="tl-msg tl-user">`，内 `<div class="tl-label">你</div>` + `<div class="tl-body">`；`quickAction` 时 `dataset.quickaction="1"`，body 为一行 label + 可展开 prompt。
- AI 块：`<div class="tl-msg tl-assistant">`，`<div class="tl-label">文小舟</div>` + `<div class="tl-meta">` + `<div class="tl-rail">`；`tl-rail` 内每个 `steps[i]`：
  - `kind==="tool"|"reasoning"`：`<div class="tl-step" data-expandable="1">`，收起态一行（图标占位 span + 名称 + 状态 span：running/ok/error）；展开体 `<div class="tl-step-detail">`（args/result/思考文本），初始 `hidden`。
  - `kind==="text"`：`<div class="tl-step tl-text">` 直接放文本。
  - `kind==="error"`：`<div class="tl-step tl-error">`。
  - 折叠头 `<button class="tl-rail-toggle">`：点击给 `tl-rail` 加/去 `collapsed`（Task 3 的 CSS 负责隐藏步骤、显示小结）。
（完整代码在实现时落定；保证上面两个测试断言的 class/dataset 成立。图标用 app.js 已有的线性 SVG 常量的等价物，实现时从 `CAP_ICON_SVG`/`friendlyToolName` 取。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd plugin && node --test test/chat-timeline.test.js`
Expected: PASS（含新增 2 个结构测试）。

- [ ] **Step 5: 提交**

```bash
git add plugin/js/chat/timeline.js plugin/test/chat-timeline.test.js
git commit -m "feat(timeline): DOM 渲染器 —— 文档流消息 + 步骤轨道

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 时间轴 CSS + 加载模块

**Files:**
- Modify: `plugin/css/style.css`（`.chat-msg*` 段 2260 起）
- Modify: `plugin/main.js`（135 行后加载 timeline.js）

**Interfaces:**
- Consumes: Task 2 的 class 名（`.tl-msg/.tl-user/.tl-assistant/.tl-label/.tl-meta/.tl-rail/.tl-step/.tl-step-detail/.tl-text/.tl-error/.tl-rail-toggle` + `.tl-rail.collapsed`）。
- Produces: 视觉样式（无代码接口）。

- [ ] **Step 1: main.js 加载 timeline.js（app.js 之前）**

`plugin/main.js` 在第 135 行 `"js/chat/history-sanitize.js",` 之后插一行：
```js
    "js/chat/timeline.js",   // 聊天时间轴渲染（文档流 + 步骤轨道）
```

- [ ] **Step 2: 写时间轴 CSS**

在 `plugin/css/style.css` 追加 `.tl-*` 样式：文档流全宽左对齐；`.tl-user` 浅灰圆角块（`var(--primary-soft)` 淡底）+ `.tl-label`；`.tl-assistant` 纯文本；`.tl-meta` 浅色小字；`.tl-rail` 左竖线（`border-left` / 伪元素）；`.tl-step` 收起一行、`cursor:pointer`，`.tl-step-detail[hidden]` 隐藏；`.tl-rail.collapsed .tl-step` 隐藏、显示小结；`.tl-error` 红色。状态点用现有色板（ok=绿 err=红 running=蓝转圈）。

- [ ] **Step 3: 中和旧气泡样式**

把 `.chat-msg.user/.assistant`（2272/2281）的气泡背景、对齐、`margin-left/right:40px`、头像相关（`.chat-msg-avatar*` 2293 起）改为不影响新布局（可直接删这些规则；保留 `.chat-msg` 通用容器若仍被过渡引用）。

- [ ] **Step 4: 语法自检**

Run: `cd plugin && node --check js/chat/timeline.js && node --check main.js && echo OK`
Expected: `OK`（CSS 无语法检查，靠后续手动视觉验证）。

- [ ] **Step 5: 提交**

```bash
git add plugin/css/style.css plugin/main.js
git commit -m "feat(timeline): 时间轴 CSS + 加载模块，中和旧气泡样式

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 接实时流式路径

**Files:**
- Modify: `plugin/js/app.js`（`handleStreamEvent` 分支 ~9177–9300 及相关流式 helper）

**Interfaces:**
- Consumes: `WpsAiChatTimeline.renderAssistantTurn / renderUserMessage / buildTurnSteps`。
- Produces: 实时对话渲染为时间轴。事件管线、`turnEvents`/`turnEventsV2` 的 push（9174/9191/9205/9263/9294 等）**保持不变**。

- [ ] **Step 1: 用户消息改文档流**

发送处（`appendTurnUserMsg` / 8595 附近推 chatHistory 之处）改用 `WpsAiChatTimeline.renderUserMessage({text, quickAction})` 追加到 `els.chatStream`，取代 `appendChatMsg("user", …)`。

- [ ] **Step 2: AI 轮改轨道**

一轮开始建一个 AI 轮容器（`renderAssistantTurn({steps:[], meta})` 或 `beginAssistantTurn`）。`handleStreamEvent` 各分支改成操作该轮的轨道节点：`reasoning_chunk`→思考步骤 append 文本；`tool_call`→轨道 append 一个 running 步骤（取代 `appendTransientToolBubble`/合并逻辑）；`tool_result`→把该步骤置 ok/error + 挂 result（取代 `clearTransientToolBubble`）；`assistant_chunk`→轨道末尾文本步骤 append delta（取代 `updateStreamingBubble`）；`assistant_text_end/assistant_text`→定稿文本 + 挂 meta（取代 `attachMetaToBubble`）；`done`→不再 `renderTurnSummary`（轨道本身就是汇总，保持展开）。`showToolCallLogs` 开启时的详细分支合并进步骤展开体。

- [ ] **Step 3: 语法自检 + 手动验证**

Run: `cd plugin && node --check js/app.js && echo OK` → `OK`。
手动：`npm run dev:wps`（或装包后）发一条会触发工具的消息（如"读一下当前表格有几行"），确认：思考/工具/回答按顺序在轨道上出现、running→✓、点开工具看参数结果、最终回答在末尾。

- [ ] **Step 4: 回归 + 同步 + 提交**

```bash
cd plugin && node --test test/*.test.js 2>&1 | grep -E "# (pass|fail)"   # 失败数不超过既有 4
for h in wps et wpp pdf; do cp js/app.js ~/.lingxi-ai/plugin-$h/js/app.js; cp js/chat/timeline.js ~/.lingxi-ai/plugin-$h/js/chat/timeline.js; cp css/style.css ~/.lingxi-ai/plugin-$h/css/style.css; cp main.js ~/.lingxi-ai/plugin-$h/main.js; done
cd /e/workspace/other/wps-ai/wps-ai
git add plugin/js/app.js
git commit -m "feat(timeline): 实时流式改走时间轴渲染，去掉气泡/瞬态工具气泡

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 接历史回放路径

**Files:**
- Modify: `plugin/js/app.js`（`appendHistoryEvent` 12938 / `appendHistoryBlock` 12976 / 回放分发 13048）

**Interfaces:**
- Consumes: `WpsAiChatTimeline`（与 Task 4 同一套）。
- Produces: 历史回放渲染与实时**一致**（关键不变量）。

- [ ] **Step 1: 重写回放为按轮聚合**

`appendHistoryEvent`/`appendHistoryBlock` 逐条渲染改为：把一段历史里 user 之后到下一个 user 之前的 reasoning/tool-call/tool-result/assistant/error 聚成一轮，喂 `buildTurnSteps` → `renderAssistantTurn`；user 段（含 quickAction）走 `renderUserMessage`。v2 块（`fromEvents`，13048）与旧事件（`events.forEach`，13049 下）两路都产出同样的轮结构。

- [ ] **Step 2: 语法自检 + 手动验证一致性**

Run: `cd plugin && node --check js/app.js && echo OK` → `OK`。
手动：切到一条有工具调用的历史对话，确认回放出来的轨道和当初实时看到的一致（步骤、状态、可展开）。

- [ ] **Step 3: 回归 + 同步 + 提交**

```bash
cd plugin && node --test test/*.test.js 2>&1 | grep -E "# (pass|fail)"
for h in wps et wpp pdf; do cp js/app.js ~/.lingxi-ai/plugin-$h/js/app.js; done
cd /e/workspace/other/wps-ai/wps-ai
git add plugin/js/app.js
git commit -m "feat(timeline): 历史回放改走时间轴，与实时渲染一致

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 清死码 + 折叠交互收尾

**Files:**
- Modify: `plugin/js/app.js`（删 `makeAvatarEl` 4921、`appendTransientToolBubble`/`bump`/`update`/`clearTransientToolBubble` 8182+、`renderTurnSummary` 8270、`renderAssistantText` 若不再用）、`plugin/css/style.css`（删残留 `.chat-msg-avatar*` 等）

**Interfaces:**
- Consumes: 无新增。
- Produces: 无死码；手动折叠交互可用。

- [ ] **Step 1: 删无引用的旧渲染函数**

按 `grep -n "makeAvatarEl\|appendTransientToolBubble\|renderTurnSummary\|renderAssistantText" js/app.js` 确认无剩余调用后删除定义。

- [ ] **Step 2: 折叠交互绑定**

给 `.tl-rail-toggle` 绑 click（在 timeline.js 渲染时用 `addEventListener`，`stopPropagation`）：切 `.tl-rail` 的 `collapsed`。手动确认折叠/展开正常。

- [ ] **Step 3: 全量回归 + 语法 + 同步**

Run: `cd plugin && node --check js/app.js && node --test test/*.test.js 2>&1 | grep -E "# (tests|pass|fail)"`
Expected: 语法 OK；失败数不超过既有 4。
```bash
for h in wps et wpp pdf; do cp js/app.js ~/.lingxi-ai/plugin-$h/js/app.js; cp js/chat/timeline.js ~/.lingxi-ai/plugin-$h/js/chat/timeline.js; cp css/style.css ~/.lingxi-ai/plugin-$h/css/style.css; done
```

- [ ] **Step 4: 提交**

```bash
cd /e/workspace/other/wps-ai/wps-ai
git add plugin/js/app.js plugin/css/style.css
git commit -m "chore(timeline): 清理气泡时代死码（头像/瞬态工具气泡/轮次汇总卡）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 手动验证清单（贯穿 Task 4–6）

在 WPS 里逐条确认（渲染是 WebView DOM，无自动化替代）：
1. 纯文本对话：用户浅灰块 + AI 文档文本，无气泡无头像。
2. 带工具的一轮：思考→工具(running→✓/✗)→回答按序在轨道；点开工具看参数/结果。
3. 工具失败：红色步骤 + 友好提示。
4. 快捷指令：用户轮一行可展开看完整提示词。
5. 手动折叠整条轨道 → 收成小结 → 再展开。
6. 历史回放同一对话：与实时一致。
7. 小屏/矮窗：不横向溢出，输入区/停止按钮不被挤（沿用现有布局约束）。

## Self-Review

**Spec 覆盖**：文档流消息(Task2/3/4)、步骤轨道(Task1/2/4)、默认收起一行(Task2 CSS Task3)、保持展开+手动折叠(Task2/6)、快捷指令盒子(Task2/4/5)、报错节点(Task1/2)、实时=回放同一渲染器(Task4/5)、抽 timeline.js(Task1/2)、移除头像/汇总卡(Task6)、测试策略(Task1/2 纯核 + 手动清单) —— 均有对应任务。

**占位扫描**：Task2 Step3 的完整 DOM 代码标注「实现时落定」但给了 class/dataset 契约与测试断言约束边界；这是 UI 渲染的固有性质（像素级代码在实现中定），非逻辑占位。其余步骤含可运行代码/命令。

**类型一致**：`buildTurnSteps`/`stepStatusFromResult`/`renderUserMessage`/`renderAssistantTurn`/`renderErrorMessage` 在 Task1–5 命名一致；Step 结构字段（kind/status/name/args/result/text）前后一致；class 名（`.tl-*`）Task2/3 一致。
