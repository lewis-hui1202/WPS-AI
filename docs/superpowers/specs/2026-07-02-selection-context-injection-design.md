# 选区操作注入文档上下文（不偏离主题）设计

日期：2026-07-02
状态：已确认，待实现

## 背景与目标

WPS 文字的 ribbon 选区操作（扩写 / 润色 / 翻译 / 语气改写 / 自定义优化）目前只把**选中的那段文字**发给 AI（`buildSelectionPreviewPrompt` 只用 `source`），AI 看不到文档标题、结构、上下文，容易生成偏离全文主题、术语/语气不一致的内容。

**目标**：给选区操作注入**全局主题（标题 + 大纲）**和**局部上下文（选区前后文）**，让 AI 在处理选区时保持与全文一致、不跑题。全文操作（documentRewrite / documentReport）本就读整篇，不改。聊天不改。

## 范围

- 仅 WPS 文字（host === "wps"）。
- 仅 **selection scope** 的意图：`translate` / `tone` / `optimize`(默认) 及自定义优化。**不含** `documentRewrite` / `documentReport`（scope=document，已读全文）。
- 用户明确要求"什么操作都要"，翻译也注入上下文（利于术语一致）。

## 组件与数据流

```
ribbon 按钮 → openSelectionPreviewAsDialog(payload)
  selection 分支：readSelectionSnapshot() 拿选区 text/range/listFormat
  → 新增：readDocumentContext({ selectionRange: range, maxAround: 800 })
  → request.docContext = { title, outline, before, after }
  → dialog: localStorage 传 request（已有机制）；inline: openSelectionPreviewInline 存入 selectionPreviewState.docContext
  → buildSelectionPreviewPrompt(): selection 意图前置【文档背景】段（formatDocContextForPrompt 生成）
  → generateSelectionPreview 流式生成（不变）
```

### 1. 宿主读取器 `readDocumentContext(opts)`（`plugin/js/hosts/writer.js`，新增）

签名：`async readDocumentContext({ selectionRange, maxAround = 800 } = {}) → DocContext | null`

`DocContext`：
```
{
  title: string,               // 首个 Heading1/标题1 段文本；取不到退化到 doc.Name 去扩展名
  outline: Array<{ level:number, text:string }>,  // 标题层级 1-3，复用 wps_get_outline 的 Style 名匹配逻辑
  before: string,              // 选区前最多 maxAround 字（doc.Range(max(0,start-maxAround), start).Text）
  after: string                // 选区后最多 maxAround 字（doc.Range(end, end+maxAround).Text）
}
```
- 读取上限（在读取器内就地截断，避免过大）：outline 最多 60 条；每条 text 截到 120 字；outline 合计截到 1500 字；before/after 各截到 maxAround 字。
- `selectionRange` 缺失（如无 range 信息）时 before/after 留空，仍返回 title/outline。
- 每个字段独立 try/catch；`ensureDocument()` 失败或全空则返回 null。
- 仅新增读取，不改现有读取器。

### 2. 纯函数 `formatDocContextForPrompt(ctx)`（可单测）

放在 `plugin/js/hosts/writer.js`，通过模块导出对象 + `_internal` 暴露（与 host 同域、便于 vm 单测，和现有 `coerceBlocks` 测试同一套路）。签名：`(ctx: DocContext | null) => string`。app.js 通过 `global.WpsAiHostWriter._internal.formatDocContextForPrompt` 或直接导出调用。
- ctx 为 null / 所有字段空 → 返回 `''`。
- 否则拼成：
```
【文档背景】(仅供参考，保持与全文主题/术语/语气一致，不要偏离文档主题；只处理下面的选中内容)
标题：<title>
大纲：
  <'#'.repeat(level)> <text>   // 每行一条；无 outline 时省略"大纲"块
选区前文：…<before>            // before 非空时；截断处用 … 提示
选区后文：<after>…             // after 非空时
```
- 再次按总量上限兜底截断（防御，正常已在读取器截过）。

### 3. 接线 `openSelectionPreviewAsDialog`（`app.js`，仅 selection 分支）

在 `readSelectionSnapshot` 之后、组装 `request` 之前：
```js
let docContext = null
try { docContext = await global.WpsAiHostWriter?.readDocumentContext?.({ selectionRange: range, maxAround: 800 }) } catch (e) {}
```
把 `docContext` 并入 `request`。document 分支不读（不需要）。

`openSelectionPreviewInline(payload)`：把 `payload.docContext` 存进 `selectionPreviewState.docContext`（新增一个字段，跟 range/listFormat 并列）。

### 4. 注入 `buildSelectionPreviewPrompt`（`app.js`）

对 `translate` / `tone` / `optimize`(默认) 三类 selection 意图：在返回的 prompt **最前面**插入 `formatDocContextForPrompt(selectionPreviewState?.docContext)`（非空时），并在各自"要求"里补一行：`结合上述文档背景，保持与全文主题、术语、语气一致，不要偏离文档主题。`
- `documentRewrite` / `documentReport` 分支不加（保持现状）。
- docContext 为空 → formatDocContextForPrompt 返回 ''，prompt 与现状一致（无回归）。

## 错误处理

- readDocumentContext 抛错/返回 null → docContext 缺省 → 不加背景段，退回纯选区 prompt。
- outline/title/before/after 任一读失败 → 该字段空，其余照常。
- 不阻断选区操作主流程。

## 测试

- **单测**（node:test + vm，`plugin/test/`）：`formatDocContextForPrompt`
  - null / 全空 → ''
  - 只有 title → 只出标题行，无"大纲/选区前后文"块
  - title+outline+before+after → 段落格式正确、层级 `#` 数正确、before 前缀 `…` / after 后缀 `…`
  - 超长 outline / before → 被截断到上限
- **手动 WPS 验证**：`readDocumentContext` 的 COM 读取（标题识别、大纲层级、选区前后文窗口）；实际扩写/翻译/润色输出确实结合了主题、不跑题。

## 上限（可调常量）

- `maxAround = 800`（选区前后各）
- outline：≤60 条、每条 ≤120 字、合计 ≤1500 字
- 背景段总量兜底 ≤ ~3500 字

## 非目标（YAGNI）

- 不做全文摘要（额外 AI 调用）。
- 不改全文 scope 操作、不改聊天。
- 不缓存 docContext（每次选区操作实时读，成本可控）。
- 大纲只到 3 级（与 wps_get_outline 默认一致）。
