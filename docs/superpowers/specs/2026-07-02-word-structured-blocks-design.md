# Word 写入去 markdown 化：结构化块（structured blocks）设计

日期：2026-07-02
状态：已确认，待实现

## 背景与目标

当前 AI 写回 Word 的路径是「AI 输出 markdown 字符串 → `markdown-to-word.js` 解析（tokenize）→ 逐块写 Word 原生格式」。markdown 解析层带来固有缺陷：

- 行内嵌套不支持（`**粗里带*斜*体**` 星号字面输出，见历史 B43）。
- 表格单元格内 `|` 转义、列表内代码块等边界易错。
- `looksLikeMarkdown` 启发式判定不稳。

**目标**：去掉 Word 写入路径上的 markdown 中间层，改为 AI 直接输出**结构化块数组（blocks）**，宿主逐块写 Word 原生格式。行内格式用 **runs 数组**表达，全程不解析 markdown。

**不改**：聊天面板的 markdown 渲染（`markdown-render.js` 用 `tokenizeBlocks/tokenizeInline` 把 AI 回复渲染成 HTML）与 Word 写入无关，保留。

## AI 面向的块 schema（写入契约）

```jsonc
[
  { "type": "heading", "level": 1, "text": "标题" },              // level 1-6
  { "type": "paragraph", "text": "纯文本段落" },                   // 纯文本：单 run
  { "type": "paragraph", "runs": [                                 // 富文本：多 run
      { "text": "带" },
      { "text": "加粗", "bold": true },
      { "text": "和" },
      { "text": "斜体", "italic": true },
      { "text": "行内代码", "code": true }
  ] },
  { "type": "list", "ordered": false, "items": ["项一", "项二"], "level": 0 },
  { "type": "table", "header": true, "rows": [["列A","列B"],["1","2"]] },
  { "type": "quote", "text": "引用文字" },
  { "type": "code", "text": "code();", "lang": "js" },
  { "type": "spacer" }
]
```

规则：
- `paragraph`：给 `text`（纯文本，等价单 run）或 `runs`（富文本）。二者都**不解析 markdown**。
- `run`：`{ text, bold?, italic?, code? }`，字段与现有 `writeRuns` 的 run 结构一致。
- `list`：v1 的 `items` 为纯字符串数组；`level` 控制嵌套缩进（对齐现有 `applyListLevel`）。行内富文本的 list item 留待后续扩展（items 支持 `{runs}`）。
- `table.rows`：二维字符串数组；`header:true` 时首行按表头处理（对齐现有 `writeTable`）。
- 未知/缺字段的块跳过并记日志，不抛异常（保持写入尽力而为）。

## 组件与改动

### 1. `plugin/js/markdown-to-word.js`
- **新增** `writeBlocks(selection, blocks, options)`：接收 AI 面向 schema 的块数组，`options.replace` 时先清空选区，然后逐块写入。内部复用现有 `writeRuns / writeTable / applyStyle / newParagraph / resetParagraph / applyListLevel`，并沿用 B42 的「写入前 reset」修复。
  - `heading` → resetParagraph + applyStyle(HeadingN) + writeRuns。
  - `paragraph` → resetParagraph + writeRuns(block.runs 或 [{text:block.text}])。
  - `list` → 对 `items` 逐项按 ul/ol 写入（复用现有 ApplyBulletDefault/ApplyNumberDefault + applyListLevel 分支）。
  - `table` → resetParagraph + writeTable(适配 `{rows, header}`)。
  - `quote` / `code` / `spacer` → 对齐现有分支。
- **移除** `writeMarkdown`（Word 写入不再经它）。`tokenizeBlocks / tokenizeInline` 保留导出（`markdown-render.js` 仍用）。
- 导出：`{ writeBlocks, tokenizeBlocks, tokenizeInline }`。

### 2. `plugin/js/hosts/writer.js`
- `insertText` / `replaceSelectionText` / `replaceRangeText` 改为接收 `blocks`（数组）走 `writeBlocks`；**删除** `looksLikeMarkdown` 自动判定与 `format==="markdown"` 分支。
- 纯文本快捷：当调用方传字符串而非 blocks 时，包成单个 `{type:"paragraph", text}` 块。
- 保留现有 Range 原子替换、¶ 尾字符裁剪、B6 折叠选区不吃字符等修复；这些在写 blocks 前后同样适用（替换语义 = 清区间后 writeBlocks）。
- `looksLikeMarkdown` 从导出移除。

### 3. `plugin/js/tools/writer.js`
- `wps_insert_text` / `wps_replace_selection` / `wps_replace_document` 的入参：
  - 主参数 `blocks`：结构化块数组（JSON schema 描述上面的块结构）。
  - 保留可选 `text`：纯文本快捷插入（内部转单 paragraph 块）。
  - 移除 `format` 参数与「支持 markdown」描述。
- 工具 description 明确：写 Word 用 blocks 结构，不要传 markdown。

### 4. system prompt（`plugin/js/app.js` 内的 Word 相关系统提示）
- 指示 AI：写 Word 文档内容一律用 blocks 结构（给出 schema 摘要与最小示例）；不要输出 markdown 字符串给写入类工具。
- 聊天回复本身仍可用 markdown（面板渲染），与写文档区分开。

### 5. 快捷操作（润色/翻译，`plugin/js/app.js` ~4767-4805）
- 结果应用从 markdown 改为 blocks：让这些子调用返回 blocks，或将其纯文本结果包成 paragraph 块写入。保持「替换选区/范围」语义不变。

## 数据流

```
AI（工具调用，arguments.blocks）
  → tools/writer.js（校验/透传 blocks）
  → hosts/writer.js insertText/replaceSelectionText/replaceRangeText
  → markdown-to-word.js writeBlocks(selection, blocks, {replace})
  → 逐块调用 applyStyle / writeRuns / writeTable ... → WPS 原生格式
```

聊天面板（不变）：AI 文本 → `markdown-render.js`（tokenize → HTML）→ DOM。

## 错误处理
- `writeBlocks`：块级 try/catch，单块失败记日志继续（不整体中断，避免半截文档时更糟）。
- 未知块类型/缺字段：跳过 + 日志。
- 空 blocks：视作无操作返回。
- 替换语义下清空选区失败时沿用现有兜底（Delete → Text=""）。

## 测试要点
- heading（1-6 级）、paragraph（text 与 runs 两种）、list（有序/无序/多级）、table（含/不含 header）、quote、code、spacer 各自渲染正确。
- runs：bold/italic/code 组合、混合 run 段落。
- 替换语义：选区替换、Range 替换、折叠选区（不吃字符，B6）。
- 列表后接 heading/code/quote（继承 bullet 的 B42 回归）。
- 表格保留场景（结构化排版 replaceParagraphsInPlace 不受影响——它本就走结构化，不经本路径）。
- 纯文本快捷路径（传字符串）。
- 回归：聊天面板 markdown 渲染不受影响。

## 兼容性 / 迁移
- 工具契约破坏性变更；AI 行为由 prompt+schema 驱动，更新后即适配。
- 历史会话残留的 markdown 字符串调用：退化为纯文本插入（不再解析 markdown），可接受。
- `markdown-to-word.js` 的 tokenizer 保留，聊天渲染零影响。

## 非目标（YAGNI）
- 不做 markdown ↔ blocks 双向兼容层。
- list item 行内富文本（runs）留待后续，v1 用纯字符串。
- 不改结构化排版预览路径（已是结构化）。
