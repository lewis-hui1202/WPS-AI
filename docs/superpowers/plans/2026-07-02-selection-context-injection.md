# 选区操作注入文档上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 WPS 文字的选区操作（扩写/润色/翻译/语气/自定义优化）注入文档标题+大纲+选区前后文，让 AI 输出不偏离全文主题。

**Architecture:** 新增宿主 COM 读取器 `readDocumentContext`（标题+大纲+前后文窗口，就地截断）和纯函数 `formatDocContextForPrompt`（拼【文档背景】段，可单测），二者都在 `hosts/writer.js`。app.js 在选区预览打开时读上下文并塞进 request/state，`buildSelectionPreviewPrompt` 对 selection 意图前置背景段。全文操作、聊天不改。

**Tech Stack:** 浏览器 IIFE（挂 window）；WPS Word JSAPI（COM）；测试用 Node 内置 `node:test` + `node:assert` + `node:vm`。

## Global Constraints

- 不引入任何新依赖。
- 源码是挂 `window` 的 IIFE，测试用 `node:vm` 在 `{ window: {}, document: {}, console }` 沙箱加载。
- 仅 WPS 文字（host === "wps"）；仅 selection scope 意图（translate / tone / optimize 默认）；全文意图（documentRewrite / documentReport）与聊天不改。
- 上限：`maxAround = 800`（选区前后各）；outline ≤60 条、每条 text ≤120 字、合计 ≤1500 字；【文档背景】总量兜底 ≤3500 字。
- 大纲只取标题 1-3 级（Style 名匹配 `(Heading|标题)\s*(\d)`）。
- 容错：任一读取失败留空；无任何上下文时 `readDocumentContext` 返回 null、`formatDocContextForPrompt` 返回 ''（prompt 退回现状，不回归）。

---

## 文件结构

- `plugin/js/hosts/writer.js` — 新增 `readDocumentContext`（COM 读）+ `formatDocContextForPrompt`（纯函数）；加入导出对象（`formatDocContextForPrompt` 也放进 `_internal` 方便测试）。
- `plugin/js/app.js` — `openSelectionPreviewAsDialog`（selection 分支读上下文并入 request）、`openSelectionPreviewInline`（state 存 docContext）、`buildSelectionPreviewPrompt`（selection 意图前置背景段）。
- `plugin/test/doc-context.test.js` — `formatDocContextForPrompt` 单测。

---

## Task 1: host 读取器 + 纯格式化函数（+ 单测）

**Files:**
- Modify: `plugin/js/hosts/writer.js`（新增两函数 + 导出）
- Test: `plugin/test/doc-context.test.js`

**Interfaces:**
- Produces:
  - `readDocumentContext({ selectionRange, maxAround }) => Promise<{title,outline:[{level,text}],before,after} | null>`
  - `formatDocContextForPrompt(ctx) => string`（导出到 `WpsAiHostWriter.formatDocContextForPrompt` 与 `_internal`）
- Consumes（模块内既有）：`ensureDocument`。

- [ ] **Step 1: 写失败测试** `plugin/test/doc-context.test.js`

```js
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadHost() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "hosts", "writer.js"), "utf8");
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiHostWriter;
}

test("formatDocContextForPrompt: null -> empty string", () => {
  const h = loadHost();
  assert.strictEqual(h.formatDocContextForPrompt(null), "");
});

test("formatDocContextForPrompt: all-empty ctx -> empty string", () => {
  const h = loadHost();
  assert.strictEqual(h.formatDocContextForPrompt({ title: "", outline: [], before: "", after: "" }), "");
});

test("formatDocContextForPrompt: title only omits outline/context blocks", () => {
  const h = loadHost();
  const out = h.formatDocContextForPrompt({ title: "项目周报", outline: [], before: "", after: "" });
  assert.ok(out.includes("【文档背景】"));
  assert.ok(out.includes("标题：项目周报"));
  assert.ok(!out.includes("大纲："));
  assert.ok(!out.includes("选区前文"));
  assert.ok(!out.includes("选区后文"));
});

test("formatDocContextForPrompt: full context renders all blocks with heading depth", () => {
  const h = loadHost();
  const out = h.formatDocContextForPrompt({
    title: "白皮书",
    outline: [{ level: 1, text: "概述" }, { level: 2, text: "背景" }, { level: 3, text: "细节" }],
    before: "前面这段",
    after: "后面这段"
  });
  assert.ok(out.includes("标题：白皮书"));
  assert.ok(out.includes("# 概述"));
  assert.ok(out.includes("## 背景"));
  assert.ok(out.includes("### 细节"));
  assert.ok(out.includes("选区前文：…前面这段"));
  assert.ok(out.includes("选区后文：后面这段…"));
});

test("formatDocContextForPrompt: heading level clamped to 1-3", () => {
  const h = loadHost();
  const out = h.formatDocContextForPrompt({ title: "", outline: [{ level: 7, text: "深层" }], before: "", after: "" });
  assert.ok(out.includes("### 深层"));   // 7 -> clamp 3
  assert.ok(!out.includes("####"));
});

test("formatDocContextForPrompt: total output capped at 3500 chars", () => {
  const h = loadHost();
  const big = "字".repeat(5000);
  const out = h.formatDocContextForPrompt({ title: "T", outline: [], before: big, after: "" });
  assert.ok(out.length <= 3500);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugin && node --test test/doc-context.test.js`
Expected: FAIL — `h.formatDocContextForPrompt is not a function`。

- [ ] **Step 3: 实现两个函数**

在 `plugin/js/hosts/writer.js` 里、`readDocumentStructure` 之后（或任意函数区，导出之前）新增：

```js
  // 读文档上下文供选区操作参考：标题 + 大纲(标题 1-3 级) + 选区前后文窗口。
  // 全部就地截断；任一字段读失败留空；文档不可用返回 null。
  async function readDocumentContext({ selectionRange, maxAround = 800 } = {}) {
    let doc;
    try { doc = await ensureDocument(); } catch (e) { return null; }
    const ctx = { title: "", outline: [], before: "", after: "" };

    try {
      const paras = doc.Paragraphs;
      const count = paras?.Count || 0;
      let outlineChars = 0;
      for (let i = 1; i <= count && ctx.outline.length < 60; i += 1) {
        let styleName = "";
        try {
          const style = paras.Item(i).Style;
          styleName = typeof style === "string" ? style : (style?.NameLocal || style?.Name || "");
        } catch (e) { continue; }
        const m = /^(?:Heading|标题)\s*(\d)/i.exec(String(styleName));
        if (!m) continue;
        const level = parseInt(m[1], 10);
        if (!(level >= 1 && level <= 3)) continue;
        let text = "";
        try { text = String(paras.Item(i).Range?.Text || "").replace(/[\r\n\x07]+$/g, "").trim(); } catch (e) {}
        if (!text) continue;
        if (text.length > 120) text = text.slice(0, 120);
        if (level === 1 && !ctx.title) ctx.title = text;
        if (outlineChars + text.length > 1500) break;
        outlineChars += text.length;
        ctx.outline.push({ level, text });
      }
    } catch (e) {}

    if (!ctx.title) {
      try { ctx.title = String(doc.Name || "").replace(/\.[^.]+$/, "").trim(); } catch (e) {}
    }

    const start = Number(selectionRange?.start);
    const end = Number(selectionRange?.end);
    if (Number.isFinite(start) && typeof doc.Range === "function") {
      try {
        const b = doc.Range(Math.max(0, start - maxAround), start);
        ctx.before = String(b?.Text || "").replace(/[\r\x07]+/g, "").trim();
      } catch (e) {}
    }
    if (Number.isFinite(end) && typeof doc.Range === "function") {
      try {
        const a = doc.Range(end, end + maxAround);
        ctx.after = String(a?.Text || "").replace(/[\r\x07]+/g, "").trim();
      } catch (e) {}
    }

    if (!ctx.title && ctx.outline.length === 0 && !ctx.before && !ctx.after) return null;
    return ctx;
  }

  // 纯函数：把 docContext 拼成【文档背景】提示段。ctx 空 / 全空 → 返回 ''。
  function formatDocContextForPrompt(ctx) {
    if (!ctx) return "";
    const title = String(ctx.title || "").trim();
    const outline = Array.isArray(ctx.outline) ? ctx.outline : [];
    const before = String(ctx.before || "").trim();
    const after = String(ctx.after || "").trim();
    if (!title && outline.length === 0 && !before && !after) return "";
    const lines = [];
    lines.push("【文档背景】(仅供参考，保持与全文主题/术语/语气一致，不要偏离文档主题；只处理下面的选中内容)");
    if (title) lines.push(`标题：${title}`);
    if (outline.length) {
      lines.push("大纲：");
      for (const it of outline) {
        const lv = Math.max(1, Math.min(3, parseInt(it?.level, 10) || 1));
        lines.push(`  ${"#".repeat(lv)} ${String(it?.text || "").trim()}`);
      }
    }
    if (before) lines.push(`选区前文：…${before}`);
    if (after) lines.push(`选区后文：${after}…`);
    let out = lines.join("\n");
    if (out.length > 3500) out = out.slice(0, 3500);
    return out;
  }
```

- [ ] **Step 4: 加入导出**

把导出对象改为（在既有基础上加 `readDocumentContext`、`formatDocContextForPrompt`，并把后者也放进 `_internal`）：

```js
  global.WpsAiHostWriter = {
    host: "wps",
    label: "WPS 文字",
    readSelectionText,
    readSelectionSnapshot,
    readDocumentText,
    readDocumentStructure,
    readDocumentContext,
    readByScope,
    insertText,
    replaceSelectionText,
    replaceRangeText,
    replaceDocumentBlocks,
    replaceDocumentBlocksHtml,
    replaceParagraphsInPlace,
    getScopeOptions,
    formatDocContextForPrompt,
    _internal: { coerceBlocks, formatDocContextForPrompt }
  };
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd plugin && node --test test/doc-context.test.js`
Expected: PASS（6 用例全绿）。也跑全量 `node --test "test/*.test.js"` 确认没破坏别的。

- [ ] **Step 6: 提交**

```bash
git add plugin/js/hosts/writer.js plugin/test/doc-context.test.js
git commit -m "feat(word): readDocumentContext + formatDocContextForPrompt for selection ops"
```

---

## Task 2: app.js 接线（读上下文 + 注入 prompt）

**Files:**
- Modify: `plugin/js/app.js`（`openSelectionPreviewAsDialog` ~4861-4914、`openSelectionPreviewInline` ~4379-4394 的 selectionPreviewState、`buildSelectionPreviewPrompt` ~4417-4487）

**Interfaces:**
- Consumes: `WpsAiHostWriter.readDocumentContext(...)`、`WpsAiHostWriter.formatDocContextForPrompt(ctx)`（Task 1）。

- [ ] **Step 1: openSelectionPreviewAsDialog 读上下文并入 request**

把 selection 分支读完 snapshot 后到组装 request 之间改为（在 `range = snap?.range || null; listFormat = snap?.listFormat || null;` 之后、`const request = Object.assign(...)` 之前插入 docContext 读取，并把 docContext 加进 request）：

找到：
```js
        range = snap?.range || null;
        listFormat = snap?.listFormat || null;   // 关键：原文是不是无序 / 有序 list 段落
      }
      const request = Object.assign({}, payload || {}, {
        ts: Date.now(),
        sourceText: text,
        range,
        listFormat
      });
```
改为：
```js
        range = snap?.range || null;
        listFormat = snap?.listFormat || null;   // 关键：原文是不是无序 / 有序 list 段落
      }
      // 选区操作注入文档上下文（标题+大纲+选区前后文），让 AI 不偏离全文主题。全文场景不需要。
      let docContext = null;
      if (!wantsFullDoc) {
        try { docContext = await global.WpsAiHostWriter?.readDocumentContext?.({ selectionRange: range, maxAround: 800 }); } catch (e) {}
      }
      const request = Object.assign({}, payload || {}, {
        ts: Date.now(),
        sourceText: text,
        range,
        listFormat,
        docContext
      });
```

- [ ] **Step 2: openSelectionPreviewInline 存 docContext 到 state**

在 `selectionPreviewState = { ... }` 里 `listFormat: payload?.listFormat || null,` 那一行后面加一行：
```js
      docContext: payload?.docContext || null,
```
（保持对象其余字段不变。）

- [ ] **Step 3: buildSelectionPreviewPrompt 注入背景段**

在函数开头（`const source = selectionPreviewState?.sourceText || ""` 之后）加：
```js
    const bg = global.WpsAiHostWriter?.formatDocContextForPrompt?.(selectionPreviewState?.docContext) || "";
    const withBg = (body) => (bg ? `${bg}\n\n${body}` : body);
    const bgNote = bg ? "结合上述文档背景，保持与全文主题、术语、语气一致，不要偏离文档主题。" : "";
```

然后把 `translate`、`tone`、以及末尾默认（optimize）三个 return 用 `withBg(...)` 包住并塞入 `bgNote`。`documentRewrite` / `documentReport` 两个分支**不动**。

translate 分支改为：
```js
    if (intent === "translate") {
      if (!targetLanguage) throw new Error("请先选择或输入目标语言。");
      return withBg([
        `请把下面 WPS 文字选区内容翻译为${targetLanguage}。`,
        "要求：只输出翻译后的正文，不要解释，不要 Markdown 代码块。",
        "保留原文的段落换行；专有名词、数字、符号按上下文自然处理。",
        bgNote,
        instruction ? `用户补充要求：${instruction}` : "",
        "",
        "【原文】",
        source
      ].filter(Boolean).join("\n"));
    }
```

tone 分支改为：
```js
    if (intent === "tone") {
      const tone = selectionPreviewState?.tone || "改写";
      const preset = selectionPreviewState?.presetInstruction || `按「${tone}」风格改写。`;
      return withBg([
        `请按「${tone}」风格改写下面 WPS 文字选区内容。`,
        "要求：只输出改写后的正文，不要解释，不要 Markdown 代码块。",
        "保持原意和关键事实，不新增事实；保留原文段落换行。",
        `【风格要求】${preset}`,
        bgNote,
        instruction ? `【用户补充要求】${instruction}` : "",
        "",
        "【原文】",
        source
      ].filter(Boolean).join("\n"));
    }
```

末尾默认（optimize）分支改为：
```js
    return withBg([
      "请优化下面 WPS 文字选区内容。",
      "要求：只输出优化后的正文，不要解释，不要 Markdown 代码块。",
      "保持原意和关键事实，不新增事实；保留段落换行；让表达更清晰、通顺、专业。",
      bgNote,
      instruction ? `用户优化要求：${instruction}` : "",
      "",
      "【原文】",
      source
    ].filter(Boolean).join("\n"));
```

- [ ] **Step 4: 校验**

Run: `cd plugin && node -c js/app.js`
Expected: 无输出（语法通过）。

Run: `cd plugin && node --test "test/*.test.js"`
Expected: 全绿（Task 1 单测 + 既有）。

WPS 手动验证（需真实 WPS，延后给 controller/用户）：在一篇有标题+大纲的文档里，选中某段做「扩写/翻译/润色」，确认结果结合了全文主题/术语、不跑题；确认全文改写/文档报告、聊天不受影响。

- [ ] **Step 5: 提交**

```bash
git add plugin/js/app.js
git commit -m "feat(word): inject document context into selection ops prompts"
```

---

## Self-Review 备注

- Spec 覆盖：readDocumentContext(Task1)、formatDocContextForPrompt(Task1)、接线读上下文(Task2 Step1)、inline state(Task2 Step2)、prompt 注入且仅 selection 意图(Task2 Step3)、容错空→退回(两函数的空返回 + withBg 空短路)、测试(Task1 单测 + Task2 手动)——全覆盖。
- 类型一致：`readDocumentContext({selectionRange,maxAround})`、`formatDocContextForPrompt(ctx)`、docContext 结构 `{title,outline:[{level,text}],before,after}` 在各处一致；range 用 `{start,end}`（与 readSelectionSnapshot 返回一致）。
- 无占位：测试与实现均完整代码；COM 读取器以明确 WPS 手动步骤 + 预期替代（非占位）。
