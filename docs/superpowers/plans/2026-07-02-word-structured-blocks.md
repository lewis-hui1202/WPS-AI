# Word 结构化块写入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 通过结构化 blocks 数组直接写 Word 原生格式，移除 Word 写入路径上的 markdown 解析中间层。

**Architecture:** `markdown-to-word.js` 新增 `writeBlocks(selection, blocks, opts)`，复用现有原生写入辅助（applyStyle/writeRuns/writeTable/…），行内格式用 runs 数组表达（不再 `tokenizeInline`）。`hosts/writer.js` 的 insert/replace 走 `writeBlocks` 并删除 `looksLikeMarkdown` 自动判定。`tools/writer.js` 三个写入工具入参改为 `blocks`。system prompt 与快捷操作改为产出 blocks。聊天面板的 markdown 渲染（`markdown-render.js`）不变。

**Tech Stack:** 原生浏览器 JS（IIFE 挂 `window`）；WPS Word JSAPI（COM，类 VBA 对象模型）；测试用 Node 内置 `node:test` + `node:assert` + `node:vm`（不引入新依赖）。

## Global Constraints

- 不引入任何新的运行时/开发依赖（`plugin/package.json` deps 保持为空，devDeps 仅 `wps-jsapi`）。
- 源码是 IIFE 挂 `window` 的浏览器脚本，不是 CommonJS；测试通过 `node:vm` 在 `{ window: {} }` 沙箱里加载。
- 保留 `tokenizeBlocks` / `tokenizeInline` 的导出（`markdown-render.js` 依赖）。
- 块级写入尽力而为：单块失败记日志继续，不整体抛出。
- 沿用既有修复：B42（写入前 resetParagraph）、B6（折叠选区不吃字符）、Range 原子替换与 ¶ 尾字符裁剪。
- 块 schema（AI 面向，权威定义见 spec）：
  - `{type:"heading", level:1-6, text}`
  - `{type:"paragraph", text}` 或 `{type:"paragraph", runs:[{text,bold?,italic?,code?}]}`
  - `{type:"list", ordered:bool, items:[string], level?:int}`
  - `{type:"table", header:bool, rows:[[string]]}`
  - `{type:"quote", text}`
  - `{type:"code", text, lang?}`
  - `{type:"spacer"}`

---

## 文件结构

- `plugin/js/markdown-to-word.js` — 新增 `writeBlocks` + `runsForBlock` 辅助；`writeTable` 改为收 `{rows, header}`；删除 `writeMarkdown`；导出 `{ writeBlocks, tokenizeBlocks, tokenizeInline }`。
- `plugin/js/hosts/writer.js` — `insertText`/`replaceSelectionText`/`replaceRangeText` 收 `blocks` 走 `writeBlocks`；删 `looksLikeMarkdown` 与 markdown 分支；字符串入参包成单 paragraph 块；不再导出 `looksLikeMarkdown`。
- `plugin/js/tools/writer.js` — `wps_insert_text`/`wps_replace_selection`/`wps_replace_document` 入参改 `blocks`（保留可选 `text` 纯文本快捷）。
- `plugin/js/app.js` — Word 写入相关 system prompt 改为要求 blocks；快捷操作（润色/翻译，~4767-4805）改走 blocks。
- `plugin/test/` — 新增 `markdown-to-word.writeBlocks.test.js`、`writer-host.coerce.test.js`（Node 测试）。

---

## Task 1: markdown-to-word.js 增加 writeBlocks（核心）

**Files:**
- Modify: `plugin/js/markdown-to-word.js`（新增 `runsForBlock`、`writeBlocks`；改 `writeTable`；删 `writeMarkdown`；改导出）
- Test: `plugin/test/markdown-to-word.writeBlocks.test.js`

**Interfaces:**
- Produces:
  - `writeBlocks(selection, blocks, options)` → `{ blocks: number }`；`options.replace` 为 true 时先清空选区。
  - `runsForBlock(block)` → `Array<{text, bold?, italic?, code?}>`（内部辅助，导出用于测试）。
  - `writeTable(selection, { rows, header })`（改签名）。
  - 导出对象：`window.WpsAiMarkdownToWord = { writeBlocks, runsForBlock, tokenizeBlocks, tokenizeInline }`。
- Consumes（模块内既有）：`applyStyle`、`safeSet`、`resetParagraph`、`writeRuns`、`newParagraph`、`applyListLevel`、`STYLE`。

- [ ] **Step 1: 写失败测试**

创建 `plugin/test/markdown-to-word.writeBlocks.test.js`：

```js
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// 加载 IIFE 模块到沙箱（脚本挂到 window 上）
function loadModule() {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "js", "markdown-to-word.js"),
    "utf8"
  );
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiMarkdownToWord;
}

// 假 Selection：记录 TypeText / Style / 段落 / bullet-number / 表格单元格 的调用序列
function makeFakeSelection() {
  const trace = [];
  const font = new Proxy({}, {
    set(t, p, v) { if (p === "Name") trace.push(["font.Name", v]);
                   if (p === "Bold" && v) trace.push(["bold"]);
                   if (p === "Italic" && v) trace.push(["italic"]);
                   t[p] = v; return true; },
    get(t, p) { return t[p]; }
  });
  const listFormat = {
    ApplyBulletDefault() { trace.push(["bullet"]); },
    ApplyNumberDefault() { trace.push(["number"]); },
    RemoveNumbers() {}
  };
  const fakeTable = {
    Style: 0,
    AutoFitBehavior() {},
    Cell(r, c) { return { Range: { set Text(v) { trace.push(["cell", r, c, v]); } } }; },
    Rows: { Item() { return { Range: { Font: {}, }, Shading: {} }; } },
    Range: { End: 0, Font: {} }
  };
  const range = {
    End: 0,
    ListFormat: listFormat,
    Tables: { Add() { trace.push(["table.add"]); return fakeTable; } }
  };
  const sel = {
    Font: font,
    ParagraphFormat: new Proxy({}, { set() { return true; }, get() { return 0; } }),
    Range: range,
    TypeText(t) { trace.push(["text", t]); },
    TypeParagraph() { trace.push(["para"]); },
    Delete() { trace.push(["delete"]); },
    SetRange() {}, MoveDown() {}, InsertAfter(t) { trace.push(["text", t]); }
  };
  Object.defineProperty(sel, "Style", {
    set(v) { trace.push(["style", v]); }, get() { return -1; }, configurable: true
  });
  return { sel, trace };
}

test("paragraph with plain text writes one run", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "你好" }]);
  assert.deepStrictEqual(trace.filter((e) => e[0] === "text"), [["text", "你好"]]);
});

test("paragraph with runs applies bold/italic without markdown parsing", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", runs: [
    { text: "普通" }, { text: "粗", bold: true }, { text: "斜", italic: true }
  ] }]);
  const texts = trace.filter((e) => e[0] === "text").map((e) => e[1]);
  assert.deepStrictEqual(texts, ["普通", "粗", "斜"]);
  assert.ok(trace.some((e) => e[0] === "bold"));
  assert.ok(trace.some((e) => e[0] === "italic"));
});

test("literal markdown in text is NOT parsed (star stays literal)", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "**不该加粗**" }]);
  const texts = trace.filter((e) => e[0] === "text").map((e) => e[1]);
  assert.deepStrictEqual(texts, ["**不该加粗**"]);
  assert.ok(!trace.some((e) => e[0] === "bold"));
});

test("heading applies HeadingN style", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "heading", level: 2, text: "标题" }]);
  assert.ok(trace.some((e) => e[0] === "style" && e[1] === -3)); // Heading2
  assert.ok(trace.some((e) => e[0] === "text" && e[1] === "标题"));
});

test("list writes each item as bullet/number", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "list", ordered: false, items: ["甲", "乙"] }]);
  assert.strictEqual(trace.filter((e) => e[0] === "bullet").length, 2);
  const texts = trace.filter((e) => e[0] === "text").map((e) => e[1]);
  assert.deepStrictEqual(texts, ["甲", "乙"]);
});

test("ordered list uses number default", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "list", ordered: true, items: ["一"] }]);
  assert.strictEqual(trace.filter((e) => e[0] === "number").length, 1);
});

test("table fills cells and adds a native table", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "table", header: true, rows: [["A", "B"], ["1", "2"]] }]);
  assert.ok(trace.some((e) => e[0] === "table.add"));
  assert.ok(trace.some((e) => e[0] === "cell" && e[3] === "A"));
  assert.ok(trace.some((e) => e[0] === "cell" && e[3] === "2"));
});

test("code block switches to Consolas and writes text verbatim", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "code", text: "x=1" }]);
  assert.ok(trace.some((e) => e[0] === "font.Name" && e[1] === "Consolas"));
  assert.ok(trace.some((e) => e[0] === "text" && e[1] === "x=1"));
});

test("spacer emits a paragraph break", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "spacer" }]);
  assert.ok(trace.some((e) => e[0] === "para"));
});

test("replace option clears the selection first", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "新" }], { replace: true });
  assert.strictEqual(trace[0][0], "delete");
});

test("unknown block type is skipped, does not throw", () => {
  const mod = loadModule();
  const { sel } = makeFakeSelection();
  assert.doesNotThrow(() => mod.writeBlocks(sel, [{ type: "bogus" }, { type: "paragraph", text: "ok" }]));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugin && node --test test/markdown-to-word.writeBlocks.test.js`
Expected: FAIL —`mod.writeBlocks is not a function`（尚未实现）。

- [ ] **Step 3: 实现 runsForBlock**

在 `markdown-to-word.js` 里 `writeRuns` 之后新增：

```js
  // AI 面向块 → runs 数组。runs 存在直接用；否则纯文本单 run。全程不解析 markdown。
  function runsForBlock(block) {
    if (Array.isArray(block.runs)) {
      return block.runs
        .filter((r) => r && typeof r.text === "string")
        .map((r) => ({ text: r.text, bold: !!r.bold, italic: !!r.italic, code: !!r.code }));
    }
    return [{ text: typeof block.text === "string" ? block.text : "", bold: false, italic: false, code: false }];
  }
```

- [ ] **Step 4: 改 writeTable 收 {rows, header}**

把 `writeTable` 整个函数替换为（只由 writeBlocks 调用，不再兼容旧 {headers,rows}）：

```js
  // 写 Word 原生表格：block = { rows:[[cell]], header:bool }。header 时首行加粗+浅底。
  function writeTable(selection, block) {
    const rows = Array.isArray(block.rows) ? block.rows.map((r) => Array.isArray(r) ? r : []) : [];
    const rowCount = rows.length;
    if (rowCount === 0) return;
    const colCount = Math.max(1, ...rows.map((r) => r.length));
    const hasHeader = block.header !== false;

    let table;
    try {
      const range = selection.Range;
      table = range.Tables.Add(range, rowCount, colCount);
    } catch (e) {
      // 兜底：制表符分隔纯文本
      rows.forEach((r, ri) => {
        writeRuns(selection, [{ text: r.join("\t"), bold: hasHeader && ri === 0 }]);
        newParagraph(selection);
      });
      return;
    }

    try { table.Style = -111; } catch (e) {}      // wdStyleTableGrid
    try { table.AutoFitBehavior(1); } catch (e) {} // wdAutoFitContent

    rows.forEach((row, ri) => {
      for (let c = 0; c < colCount; c += 1) {
        try { table.Cell(ri + 1, c + 1).Range.Text = row[c] || ""; } catch (e) {}
      }
    });

    if (hasHeader) {
      try {
        const headerRow = table.Rows.Item(1);
        headerRow.Range.Font.Bold = true;
        try { headerRow.Shading.BackgroundPatternColor = 15921906; } catch (e) {}
      } catch (e) {}
    }
    try { table.Range.Font.Size = 10.5; } catch (e) {}

    try {
      selection.SetRange(table.Range.End, table.Range.End);
      selection.MoveDown?.();
    } catch (e) {}
    try { selection.TypeParagraph(); } catch (e) {}
  }
```

- [ ] **Step 5: 实现 writeBlocks，删除 writeMarkdown**

删除整个 `writeMarkdown` 函数（428-525 行区域），替换为 `writeBlocks`：

```js
  /**
   * 把结构化 blocks 数组写入 Selection 当前位置（Word 原生格式）。
   * @param {object} selection - WPS Word Application.Selection
   * @param {Array} blocks - AI 面向块数组（schema 见设计文档）
   * @param {object} options - options.replace=true 时先清空选区
   */
  function writeBlocks(selection, blocks, options = {}) {
    if (!selection) throw new Error("缺少 Selection 对象");
    const list = Array.isArray(blocks) ? blocks : [];
    if (list.length === 0) return { blocks: 0 };

    if (options.replace) {
      try { selection.Delete(); } catch (e) {
        try { selection.Text = ""; } catch (e2) {}
      }
    }

    list.forEach((block, idx) => {
      if (!block || typeof block !== "object") return;
      try {
        switch (block.type) {
          case "heading": {
            resetParagraph(selection);
            const lvl = Math.min(Math.max(parseInt(block.level, 10) || 1, 1), 3);
            applyStyle(selection, [STYLE.Heading1, STYLE.Heading2, STYLE.Heading3][lvl - 1]);
            writeRuns(selection, runsForBlock(block));
            newParagraph(selection);
            resetParagraph(selection);
            break;
          }
          case "list": {
            const items = Array.isArray(block.items) ? block.items : [];
            const ordered = !!block.ordered;
            items.forEach((item) => {
              applyStyle(selection, ordered ? STYLE.ListNumber : STYLE.ListBullet);
              try {
                if (ordered) selection.Range.ListFormat?.ApplyNumberDefault?.();
                else selection.Range.ListFormat?.ApplyBulletDefault?.();
              } catch (e) {
                writeRuns(selection, [{ text: ordered ? "1. " : "• " }]);
              }
              applyListLevel(selection, parseInt(block.level, 10) || 0);
              writeRuns(selection, runsForBlock({ text: typeof item === "string" ? item : (item && item.text) || "", runs: item && item.runs }));
              newParagraph(selection);
            });
            resetParagraph(selection);
            break;
          }
          case "table":
            resetParagraph(selection);
            writeTable(selection, block);
            break;
          case "code": {
            resetParagraph(selection);
            const prevName = selection.Font.Name;
            safeSet(selection.Font, "Name", "Consolas");
            try { selection.TypeText(String(block.text || "")); } catch (e) {
              if (typeof selection.InsertAfter === "function") selection.InsertAfter(String(block.text || ""));
            }
            safeSet(selection.Font, "Name", prevName);
            newParagraph(selection);
            resetParagraph(selection);
            break;
          }
          case "quote":
            resetParagraph(selection);
            writeRuns(selection, [{ text: "│ ", bold: false, italic: true, code: false }]);
            writeRuns(selection, runsForBlock(block));
            newParagraph(selection);
            break;
          case "spacer":
            newParagraph(selection);
            break;
          case "paragraph":
          default:
            resetParagraph(selection);
            writeRuns(selection, runsForBlock(block));
            if (idx !== list.length - 1) newParagraph(selection);
        }
      } catch (err) {
        try { global.WpsAiLog?.log?.("writeBlocks:block-error", { idx, type: block.type, err: err?.message || String(err) }); } catch (_) {}
      }
    });

    return { blocks: list.length };
  }
```

- [ ] **Step 6: 改导出**

把文件末尾导出改为：

```js
  global.WpsAiMarkdownToWord = {
    writeBlocks,
    runsForBlock,
    tokenizeBlocks,
    tokenizeInline
  };
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd plugin && node --test test/markdown-to-word.writeBlocks.test.js`
Expected: PASS（全部用例通过）。

- [ ] **Step 8: 提交**

```bash
git add plugin/js/markdown-to-word.js plugin/test/markdown-to-word.writeBlocks.test.js
git commit -m "feat(word): writeBlocks for structured native writing, drop writeMarkdown"
```

---

## Task 2: hosts/writer.js 走 writeBlocks，删除 markdown 判定

**Files:**
- Modify: `plugin/js/hosts/writer.js`（`insertText`/`replaceSelectionText`/`replaceRangeText`；删 `looksLikeMarkdown` 及其导出与 markdown 分支）
- Test: `plugin/test/writer-host.coerce.test.js`（测试字符串→单 paragraph 块的纯逻辑）

**Interfaces:**
- Consumes: `WpsAiMarkdownToWord.writeBlocks`（Task 1）。
- Produces:
  - `coerceBlocks(input)` → `Array`（导出用于测试）：数组原样返回；字符串包成 `[{type:"paragraph", text}]`；空返回 `[]`。
  - `insertText(blocksOrText, options)`、`replaceSelectionText(blocksOrText, options)`、`replaceRangeText(rangeInfo, blocksOrText, options)` 改为经 `coerceBlocks` → `writeBlocks`。

- [ ] **Step 1: 写失败测试**

创建 `plugin/test/writer-host.coerce.test.js`：

```js
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadHost() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "hosts", "writer.js"), "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiHostWriter;
}

test("coerceBlocks passes arrays through", () => {
  const host = loadHost();
  const blocks = [{ type: "heading", level: 1, text: "T" }];
  assert.strictEqual(host._internal.coerceBlocks(blocks), blocks);
});

test("coerceBlocks wraps a plain string as one paragraph", () => {
  const host = loadHost();
  assert.deepStrictEqual(host._internal.coerceBlocks("hi"), [{ type: "paragraph", text: "hi" }]);
});

test("coerceBlocks empty input -> empty array", () => {
  const host = loadHost();
  assert.deepStrictEqual(host._internal.coerceBlocks(""), []);
  assert.deepStrictEqual(host._internal.coerceBlocks(null), []);
});
```

注：`hosts/writer.js` 在 Node 沙箱里加载时，模块顶层不得直接触碰 `document`/COM（当前实现是函数内才调 `getApp` 等，加载不会执行），若加载抛错，改为在测试里补 `sandbox.document = {}` 兜底。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugin && node --test test/writer-host.coerce.test.js`
Expected: FAIL — `coerceBlocks` 未定义。

- [ ] **Step 3: 实现 coerceBlocks 并接入三个写入函数**

在 `hosts/writer.js` 顶部辅助区新增：

```js
  // 把工具/调用方传入的内容统一成 blocks 数组：
  //   - 已是数组：原样
  //   - 字符串（纯文本快捷）：包成单 paragraph 块（不解析 markdown）
  //   - 其它：空数组
  function coerceBlocks(input) {
    if (Array.isArray(input)) return input;
    if (typeof input === "string" && input.length > 0) return [{ type: "paragraph", text: input }];
    return [];
  }
```

`insertText` 改为：

```js
  async function insertText(blocksOrText, options = {}) {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前光标位置。");
    const blocks = coerceBlocks(blocksOrText);
    if (!blocks.length) return;
    if (!global.WpsAiMarkdownToWord) throw new Error("写入模块未加载。");
    global.WpsAiMarkdownToWord.writeBlocks(sel, blocks, { replace: false });
  }
```

`replaceSelectionText` 改为（保留 B6 折叠选区兜底：writeBlocks 的 replace 会先 Delete，折叠选区下 Delete 会吃右侧字符——因此这里先判断是否有真实选区，无选区时按 insert 处理）：

```js
  async function replaceSelectionText(blocksOrText, options = {}) {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const blocks = coerceBlocks(blocksOrText);
    if (!blocks.length) return;
    if (!global.WpsAiMarkdownToWord) throw new Error("写入模块未加载。");
    let start = 0, end = 0;
    try { start = Number(sel.Start) || 0; } catch (e) {}
    try { end = Number(sel.End) || 0; } catch (e) {}
    // 修 B6：无真实选区（折叠）时不走 replace（Delete 会吃右侧字符），直接插入。
    global.WpsAiMarkdownToWord.writeBlocks(sel, blocks, { replace: end > start });
  }
```

`replaceRangeText` 改为（Range 无效退回 replaceSelectionText）：

```js
  async function replaceRangeText(rangeInfo, blocksOrText, options = {}) {
    const doc = await ensureDocument();
    const start = Number(rangeInfo?.start);
    const end = Number(rangeInfo?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return replaceSelectionText(blocksOrText, options);
    }
    const blocks = coerceBlocks(blocksOrText);
    if (!blocks.length) return;
    let range = null;
    try { if (typeof doc.Range === "function") range = doc.Range(start, end); } catch (e) {}
    if (!range) return replaceSelectionText(blocksOrText, options);
    try { range.Select?.(); } catch (e) {}
    const sel = await getSelection();
    if (!sel) return replaceSelectionText(blocksOrText, options);
    if (!global.WpsAiMarkdownToWord) throw new Error("写入模块未加载。");
    global.WpsAiMarkdownToWord.writeBlocks(sel, blocks, { replace: true });
  }
```

- [ ] **Step 4: 删除 looksLikeMarkdown 及其导出**

删除 `looksLikeMarkdown` 函数（734-737 行区域）以及导出对象里的 `looksLikeMarkdown` 项。在导出对象里补上 `_internal: { coerceBlocks }`（供测试）。若原导出已有 `_internal`，合并进去。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd plugin && node --test test/writer-host.coerce.test.js`
Expected: PASS。

- [ ] **Step 6: grep 确认无残留引用**

Run: `cd plugin && grep -rn "looksLikeMarkdown\|writeMarkdown" js/ | grep -v node_modules`
Expected: 无输出（全部替换完毕）。若 `markdown-render.js` 有命中说明它用的是 tokenizer（应只命中 `tokenizeBlocks/tokenizeInline`，不含 `writeMarkdown`）。

- [ ] **Step 7: 提交**

```bash
git add plugin/js/hosts/writer.js plugin/test/writer-host.coerce.test.js
git commit -m "feat(word): host insert/replace consume blocks via writeBlocks; drop markdown detection"
```

---

## Task 3: tools/writer.js 写入工具入参改 blocks

**Files:**
- Modify: `plugin/js/tools/writer.js`（`wps_insert_text` @40-53、`wps_replace_selection` @58-71、`wps_replace_document` @838 附近）

**Interfaces:**
- Consumes: `writer().insertText/replaceSelectionText/replaceDocument`（收 blocks 或字符串）。

BLOCK_SCHEMA 常量（三个工具共用，放文件顶部）：

```js
  const BLOCK_SCHEMA = {
    type: "array",
    description: "结构化内容块数组，直接写 Word 原生格式（不要传 markdown 字符串）",
    items: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["heading", "paragraph", "list", "table", "quote", "code", "spacer"] },
        level: { type: "integer", description: "heading 级别 1-6" },
        text: { type: "string", description: "paragraph/heading/quote/code 的纯文本" },
        runs: { type: "array", description: "paragraph 富文本：[{text, bold?, italic?, code?}]",
          items: { type: "object", properties: {
            text: { type: "string" }, bold: { type: "boolean" }, italic: { type: "boolean" }, code: { type: "boolean" }
          }, required: ["text"] } },
        ordered: { type: "boolean", description: "list 是否有序" },
        items: { type: "array", items: { type: "string" }, description: "list 各项" },
        header: { type: "boolean", description: "table 首行是否表头" },
        rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table 行×列" }
      },
      required: ["type"]
    }
  };
```

- [ ] **Step 1: 改 wps_insert_text**

把 40-53 行的工具定义替换为：

```js
  registry.registerTool({
    name: "wps_insert_text",
    hosts: ["wps"],
    description: "在当前光标处插入内容。用结构化 blocks 数组（标题/段落/列表/表格等），直接渲染成 Word 原生格式；不要传 markdown。简单纯文本可用 text。",
    parameters: {
      type: "object",
      properties: { blocks: BLOCK_SCHEMA, text: { type: "string", description: "纯文本快捷插入（无格式时用）" } }
    },
    handler: async ({ blocks, text } = {}) => {
      const payload = Array.isArray(blocks) ? blocks : text;
      await writer().insertText(payload, {});
      const n = Array.isArray(blocks) ? blocks.length : (text ? 1 : 0);
      return { inserted: n, mode: Array.isArray(blocks) ? "blocks" : "text" };
    }
  });
```

- [ ] **Step 2: 改 wps_replace_selection**

把 58-71 行替换为：

```js
  registry.registerTool({
    name: "wps_replace_selection",
    hosts: ["wps"],
    description: "用结构化 blocks 替换当前选区（Word 原生格式）；不要传 markdown。简单纯文本可用 text。全文 AI 排版请走排版预览弹窗。",
    parameters: {
      type: "object",
      properties: { blocks: BLOCK_SCHEMA, text: { type: "string", description: "纯文本替换" } }
    },
    handler: async ({ blocks, text } = {}) => {
      const payload = Array.isArray(blocks) ? blocks : text;
      await writer().replaceSelectionText(payload, {});
      const n = Array.isArray(blocks) ? blocks.length : (text ? 1 : 0);
      return { replaced: n, mode: Array.isArray(blocks) ? "blocks" : "text" };
    }
  });
```

- [ ] **Step 3: 改 wps_replace_document（@838-857）**

把该工具定义替换为（保持 `WholeStory()` 全选 → `replaceSelectionText` 的调用链，仅把内容参数从 markdown 文本换成 blocks/text）：

```js
  registry.registerTool({
    name: "wps_replace_document",
    hosts: ["wps"],
    description: "替换整个文档内容（先全选再替换）。用结构化 blocks；不要传 markdown。慎用：覆盖现有所有文字。AI 排版场景走排版预览弹窗。",
    parameters: {
      type: "object",
      properties: { blocks: BLOCK_SCHEMA, text: { type: "string", description: "纯文本替换" } }
    },
    handler: async ({ blocks, text } = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      sel.WholeStory();
      const payload = Array.isArray(blocks) ? blocks : text;
      await writer().replaceSelectionText(payload, {});
      const n = Array.isArray(blocks) ? blocks.length : (text ? 1 : 0);
      return { replaced: n, mode: Array.isArray(blocks) ? "blocks" : "text" };
    }
  });
```

注：`wps_replace_selection` 全项目只有一处（@58-71，Step 2 已改）；845-855 行属于本 `wps_replace_document`，不是第二个 replace_selection。

- [ ] **Step 4: 手动验证（WPS）**

因工具层依赖 WPS 运行时，用真实环境验证：
1. `cd plugin && npm run dev:wps` 启动调试，在 WPS 文字里打开一个文档。
2. 让 AI 执行「在文档里插入一个二级标题『测试』、一段带**加粗**的话、一个两项无序列表、一个 2×2 表格」。
3. 预期：AI 调 `wps_insert_text`，参数是 blocks 数组；文档里出现真正的 Word 二级标题样式、加粗 run、项目符号列表、原生表格——且**文档中不出现任何 markdown 符号**（`#`、`*`、`|`、`-`）。

- [ ] **Step 5: 提交**

```bash
git add plugin/js/tools/writer.js
git commit -m "feat(word): insert/replace tools take structured blocks instead of markdown"
```

---

## Task 4: system prompt 改为要求 blocks

**Files:**
- Modify: `plugin/js/app.js`（Word 相关 system prompt 段落）

- [ ] **Step 1: 定位 prompt**

Run: `cd plugin && grep -n "markdown\|wps_insert_text\|wps_replace_selection\|Word\|文字" js/app.js | grep -i "prompt\|系统\|工具\|插入" | head -30`
找到组装给模型、描述如何写 Word 的系统提示片段（可能是常量字符串或数组拼接）。

- [ ] **Step 2: 改写提示**

把「用 markdown 写入文档」类措辞替换为明确的 blocks 指引，插入如下要点（按现有 prompt 的语言风格融入，不要照抄成生硬段落）：

```
写 Word 文档内容时，wps_insert_text / wps_replace_selection 的 blocks 参数用结构化块，禁止传 markdown 字符串：
- 标题：{type:"heading", level:1-6, text}
- 段落：{type:"paragraph", text} 或带格式 {type:"paragraph", runs:[{text, bold?, italic?, code?}]}
- 列表：{type:"list", ordered:bool, items:[...]}
- 表格：{type:"table", header:true, rows:[[...]]}
- 引用/代码/空行：{type:"quote",text} / {type:"code",text} / {type:"spacer"}
加粗、斜体一律用 runs，不要在 text 里写 ** 或 *。
```

- [ ] **Step 3: 手动验证**

在 WPS 调试环境重复 Task 3 Step 4 的指令，确认 AI 稳定产出 blocks（而非 markdown 文本），且不再有 `format:"markdown"` 之类旧参数。

- [ ] **Step 4: 提交**

```bash
git add plugin/js/app.js
git commit -m "docs(prompt): instruct model to write Word via structured blocks"
```

---

## Task 5: 快捷操作（润色/翻译）改走 blocks

**Files:**
- Modify: `plugin/js/app.js`（~4767-4805 的 quick-action 应用逻辑）

- [ ] **Step 1: 读现状**

读 `plugin/js/app.js:4760-4810`，确认 `result.text` 从何而来（是否单独的 provider 调用 + 自有 prompt），以及它当前用 `format:"markdown"`/`"plain"` 写回的三处调用（insertText / replaceSelectionText / replaceRangeText）。

- [ ] **Step 2: 决定内容形态**

润色/翻译结果通常是纯文本或轻格式。最小改动：把 `result.text`（字符串）直接透传给已改造的 writer 方法（它们的 `coerceBlocks` 会包成单 paragraph 块），移除 `format` 参数。若某快捷操作需要多段/富文本，让其子 prompt 返回 blocks 数组并透传。

把三处调用（原 `{ format: "plain"/"markdown" }`）改为不带 format：

```js
await writer?.replaceSelectionText?.(result.text, {});
// ...
await global.WpsAiHostWriter?.insertText?.(result.text, {});
// ...
await global.WpsAiHostWriter.replaceRangeText(result.range, result.text, {});
```

- [ ] **Step 3: 手动验证**

WPS 里选中一段文字，跑「润色」「翻译」快捷操作，确认结果正确写回、无 markdown 残留、无报错。

- [ ] **Step 4: 提交**

```bash
git add plugin/js/app.js
git commit -m "feat(word): quick actions write via blocks path (no markdown format flag)"
```

---

## Task 6: 端到端回归验证

**Files:** 无（验证任务）

- [ ] **Step 1: 单测全绿**

Run: `cd plugin && node --test test/`
Expected: 两个测试文件全部 PASS。

- [ ] **Step 2: 无残留引用**

Run: `cd plugin && grep -rn "writeMarkdown\|looksLikeMarkdown\|format:\s*\"markdown\"" js/ | grep -v node_modules`
Expected: 无输出。

- [ ] **Step 3: WPS 端到端**

在 WPS 文字里，让 AI 生成一篇含「多级标题 + 加粗/斜体段落 + 有序与无序列表 + 一个表格 + 一段引用」的内容并写入。逐项核对：Word 原生样式正确、行内格式正确、表格是原生表格、**通篇无 markdown 符号**。再测「替换选区」「无选区插入」两种路径不吃字符（B6）。

- [ ] **Step 4: 聊天面板回归**

确认聊天面板里 AI 回复的 markdown 仍正常渲染成富文本（`markdown-render.js` 未受影响）。

---

## Self-Review 备注

- Spec 覆盖：writeBlocks(Task1)、host 接入+删 looksLikeMarkdown(Task2)、tools 入参(Task3)、system prompt(Task4)、快捷操作(Task5)、聊天渲染不动(Task6 Step4 验证)、tokenizer 保留(Task1 Step6 导出)——全部有对应任务。
- 类型一致：`writeBlocks(selection, blocks, options)`、`runsForBlock(block)`、`coerceBlocks(input)` 在各任务间签名一致；`writeTable(selection, {rows, header})` 仅 writeBlocks 调用。
- 无占位符：测试与实现代码均为完整可执行代码；COM 依赖处以明确 WPS 手动步骤 + 预期结果替代（非「测试上面内容」式占位）。
