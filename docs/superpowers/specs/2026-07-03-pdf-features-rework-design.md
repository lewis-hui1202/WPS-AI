# PDF 功能重构设计（混合读取 + 修复两个 bug + 移除生成 PPT）

**Goal:** 让 WPS 插件的 PDF 功能（对照翻译、全文总结、PDF 问答）恢复可用并显著优化：数字版 PDF 走服务端文字提取（任意模型、便宜、大文档分块、页码准确），扫描件自动回退整文件多模态；移除"文档生成 PPT"。

**Architecture:** 读 PDF 由"单一整文件多模态上传"改为**双通道**：proxy 用 pdfjs 抽取带页码文本 → 有文字层走【文字通道】、扫描件回退【多模态通道】。同时修复两个使功能不可用的 bug。

**Tech Stack:** WPS Office JS 加载项（window IIFE 模块 + COM）、本地 Node 代理（proxy-server.js）、pdfjs-dist（新增，纯 JS）、node:test。

## Global Constraints

- 不破坏其它宿主（Writer/ET/WPP）的现有 quick-action 行为。
- 代理路由改动需重启代理；前端改动面板 reload。
- `pdfjs-dist` 用 legacy build，在 Node 侧运行，无原生编译依赖。
- 占位符语法迁移必须**一次覆盖所有 prefill prompt**，不留 `[...]` 输入残留。
- 保持"预览确认 / 直接写入"双模式与现有对话流不变。
- 不引入 RAG/向量库、不做扫描件 OCR（回退多模态即可）——本轮明确排除。

---

## 一、现状与根因（诊断）

四个 PDF 动作**不读 COM 文字**，而是把整个 PDF 当多模态 `file` 附件上传给模型。COM 文字提取（`hosts/pdf.js`、`tools/pdf.js`）在整合阅读模式抓不到字，是死代码。

调用链：ribbon 点击 → `PluginStorage["lingxi_ai_pending_action"]` → `consumePendingAction()` [app.js:11821] → 分派 [app.js:11862]：`prefill` 走弹框 `openQuickPromptAsDialog`，否则直接 `attachActivePdf` + `runChatTurn`。附件由 `attachActivePdf()` [app.js:420] 经 `getCurrentDocPath()` → proxy `/load-local-file` 读成 base64。

**Bug A（运行时，拖垮全部四个）：** `backup.js` 的 `getActiveDoc()` [backup.js:38-45] 只认 `ActiveDocument/ActiveWorkbook/ActivePresentation`，**无 `ActivePDF` 分支**。PDF 宿主上 `getCurrentDocPath()` 返回 null → `attachActivePdf` 因 `{silent:true}` 静默失败 → 模型收到"PDF 已作为附件提供"却无文件 → 答"看不到 PDF"。用户实测"全文总结"正是此现象。

**Bug B（弹框，卡死对照翻译/问答）：** `extractQuickPromptPlaceholders` 用 `/\[([^\]]+)\]/g` 提取占位符。对照翻译 [quick-actions.js:144] 与 PDF 问答 [quick-actions.js:150] 的 prompt 内含页码示例 `[P3]`，被误当**必填输入** → 弹框多出"P3"字段 → "请先填写「P3」"卡住，或填入后破坏格式说明。全文总结因非 `prefill`、提取器不跑，故独善其身（但仍死于 Bug A）。

---

## 二、设计

### 2.1 PDF 路径解析（修 Bug A）

- 新增 `WpsAiHostPdf.getActivePdfPath()`：对 `getActivePdf()` 得到的 PDF 文档对象依次探测 `.Path` / `.FullName` / `.FullPath` / `.Name`（拼当前目录），返回绝对路径或 null。
- `backup.js getCurrentDocPath()` 增加 PDF 分支：`host==="pdf"` 时优先用 `getActivePdfPath()`；仍失败再退回原 `getActiveDoc()` 逻辑。
- `attachActivePdf()` 失败不再静默：`silent` 仅抑制"成功提示"，**失败一律 `showMessage` 明确报错**（"没读到 PDF 路径，请确认 PDF 已保存并处于打开状态"）。

### 2.2 占位符语法迁移（修 Bug B）

- 用户填空占位符从 `[...]` 改为 **`{{...}}`**；`[...]` 从此仅表示内容/页码示例。
- `extractQuickPromptPlaceholders` 正则改 `/\{\{([^}]+)\}\}/g`；`renderQuickPromptForm`、`buildGenericQuickPrompt` 的 `ph.raw` 匹配随之改为 `{{...}}`。
- **迁移全部 prefill prompt**（quick-actions.js 内，约 13 条，覆盖 writer/wpp/rewrite/pdf）：把每条的输入占位符 `[在这里…]` → `{{在这里…}}`；内容示例 `[P3]` 等保持不变。
- `optionalInput` 语义不变。

### 2.3 代理文字提取

- 新增 `POST /pdf-extract { path }`：Node 侧 `pdfjs-dist`(legacy) 打开文件，逐页 `getTextContent()` 拼文本，返回：
  ```json
  { "ok": true, "pages": [{ "page": 1, "text": "..." }], "charCount": 12345,
    "pageCount": 20, "hasText": true }
  ```
- `hasText` 判据：`charCount >= max(200, pageCount*20)`（低于视为扫描件/无文字层）。
- 按 `path + mtime` 缓存解析结果，避免同文件重复解析。
- 复用现有 SSRF/路径守卫；仅允许读本机既有文件（同 `/load-local-file` 策略）。

### 2.4 双通道选择

新增前端 `preparePdfContext()`（取代裸 `attachActivePdf`）：

1. 解析 PDF 路径（2.1）。失败→报错返回。
2. 调 `/pdf-extract`。
3. `hasText` 为真 → **文字通道**：返回 `{ mode:"text", pages, charCount }`。
4. 否则 → **多模态通道**：走原 `attachActivePdf` 拿 base64，返回 `{ mode:"file", dataUrl }`；此时若当前模型 `!supportsPdf` → 明确提示"该模型看不了扫描件 PDF，请换支持 PDF 的模型或改用数字版 PDF"。

### 2.5 各功能流程

- **文本上下文构造**：`buildPdfTextContext(pages, budget)` 把带 `[P{n}]` 页标记的文本拼成上下文；超预算时按页切块。预算按 token 估算（字符/1.8 近似），默认整篇直发的上限 ~120k tokens。
- **文本投递方式**：文字通道的正文作为**用户消息里的前置文本块**（`【PDF 正文（带页码）】…` 段）随 prompt 一起发，**不走 file 附件**，因此任意模型都能读到；多模态通道才用 file 附件。
- **全文总结**：文本通道，能整篇则整篇；超预算 **map-reduce**（分块各自小结 → 合并），每条结论带页码。
- **对照翻译**：文本通道，**按自然段/页分批**翻译（输出会翻倍，分批防截断），流式产出后拼 `| 原文 | 译文 |`（带页码）。多模态通道则沿用原整文件 prompt。
- **PDF 问答**：文本通道整篇作上下文发送；超预算时退化为"分块取最相关段落再答"（简单关键词打分，非向量）。
- **移除 文档生成 PPT**：删 `quick-actions.js` 的 `toPpt` 条目；`CATEGORY_ORDER_BY_HOST.pdf` 里的 `generate` 残留一并清理（`getRibbonGroups` 已跳过空组，无破坏）。

### 2.6 错误处理 & UX

- 附件/提取失败、模型不支持扫描件 → 面板明确报错，不再静默丢附件。
- 文字通道进度：提取/分块/翻译分阶段文案。
- prompt 文案更新：文字通道不再写"PDF 已作为附件"，改为"以下为 PDF 提取的带页码正文"。

---

## 三、组件与接口

- `proxy-server.js`：`POST /pdf-extract`（+ `extractPdfText(path)` 帮助函数，含缓存）。
- `js/hosts/pdf.js`：`getActivePdfPath()`。
- `js/backup.js`：`getCurrentDocPath()` 增 PDF 分支。
- `js/app.js`：`preparePdfContext()`、`buildPdfTextContext()`、总结/翻译/问答三条流程改造；`extractQuickPromptPlaceholders`/`renderQuickPromptForm`/`buildGenericQuickPrompt` 占位符语法；`attachActivePdf` 报错化。
- `js/quick-actions.js`：占位符迁移；移除 `toPpt`；PDF prompt 文案更新。
- `package.json`：新增依赖 `pdfjs-dist`。

## 四、测试（node:test）

- `/pdf-extract`：`hasText` 判定（数字版 vs 扫描件阈值）、页码结构、缓存命中。
- 占位符提取：`{{...}}` 正确识别为输入；`[P3]`/`[...]` 不再被当输入；`optionalInput` 行为。
- `buildPdfTextContext`：页标记正确、超预算切块边界。
- map-reduce 分块与对照翻译分批的纯逻辑（分块函数）。

## 五、Out of Scope

- RAG / 向量检索、扫描件 OCR（回退多模态即可）。
- COM 文字提取死代码的清理（可后续单独处理，不在本轮）。
- "PDF→真·PPT"生成（本轮按用户要求仅移除入口）。
