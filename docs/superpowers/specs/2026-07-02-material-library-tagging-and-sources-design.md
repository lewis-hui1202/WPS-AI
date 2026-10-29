# 素材库标签化 + 多来源采集 设计

**日期：** 2026-07-02
**状态：** 已批准（用户授权自主决策，不逐项确认方案），待编写实现计划

## 目标

把「素材库」从"只存生成图 + 分组"升级为**带标签、多来源、AI 可检索复用**的素材中枢：

1. **打标签**：素材带「项目标签」+「内容描述标签」。生成图自动打标；做文档/PPT 时 AI 可按标签决定是否复用某素材。
2. **本地导入**：素材库支持导入本地图片，本地图自动打标。
3. **联网找图**：可联网搜索图片作为素材。
4. **联网抓网页**：新增 `web_fetch` 工具抓取网页数据作为素材。

## 关键自主决策（用户已授权不确认）

- **内容标签用 LLM 生成**，不用本地中文分词：生成图用其 prompt 走一次轻量**文本** chat 调用产出标签；本地/网络图走**视觉**模型（`WpsAiCapabilities.supportsImage`）描述产出标签。质量统一、可降级（失败→空标签，不阻塞）。
- **项目标签来自全局设置** `currentProject`（在「统一配置」面板可编辑；素材库弹窗顶部可切换/输入）。新素材自动带上当前项目标签。
- **`web_fetch` = 服务端静态抓取**：新增 proxy 路由 `/fetch-web`，用 Node 内置 https GET 拉 HTML → 去脚本/样式/标签 → 正文文本（截断）。**不支持 JS 渲染页面**——本项目未打包 puppeteer/headless Chromium（唯一的 Chromium 是 WPS WebView，无法无头驱动）。这是权衡后的最佳可行方案；未来可选加 puppeteer。
- **联网找图**：新增 `web_image_search` 工具，经 proxy 新路由 `/image-search` 抓取 keyless 图片搜索结果（默认 DuckDuckGo i.js 接口，best-effort、可在设置里换 endpoint）。抓到的是图片 URL 列表，用户/AI 选用后经现有 `/fetch-remote-image` 落地并入库。
- **素材类型 `kind`**：`"image"`（默认）与 `"web"`（网页文本素材）。web 素材在网格里渲染为"文本卡"（地球图标 + 标题 + 摘要）。
- **AI 检索**：新增 `query_materials` 工具（`hosts:"*"`），AI 做文档/PPT 前可按 `query/tags/project/kind` 检索素材并复用，而不是每次都新生成。

## 数据模型

### 素材条目扩展（`js/material-library.js` `normalizeEntry`）

在现有 `{id,url,dataUrl,prompt,revisedPrompt,size,resolution,model,providerType,groupId,ts}` 基础上新增（全部有默认值，向后兼容旧条目）：

- `tags: string[]` —— 内容描述标签（trim + 去空 + 去重，保留原文大小写）。
- `project: string` —— 项目标签。
- `source: string` —— 来源：`"generated"|"local"|"web-search"|"web-fetch"`，默认 `"generated"`。
- `kind: string` —— `"image"`（默认）或 `"web"`。
- `title: string` —— web 素材标题（image 素材为空）。
- `text: string` —— web 素材正文（image 素材为空）。

旧条目缺这些字段：`list()` 返回原始条目，消费方一律用 `entry.tags || []`、`entry.kind || "image"` 等兜底；`normalizeEntry` 在 `add`/`addMany`/`update` 时补全。存储 key 不变（`lingxi_material_library_v1`），无破坏性迁移。

### 新增/变更 API（`js/material-library.js`）

- `update(id, patch) → entry|null`：合并 patch 到条目并经 `normalizeEntry` 规整（用于 setTags/setProject 等）。
- `normalizeTags(input) → string[]`：把字符串（逗号/顿号分隔）或数组规整成标签数组。
- `addMany(items, meta)`：已有；`meta` 现可带 `tags/project/source/kind`（经 `normalizeEntry` 透传）。
- 其余 API 不变。

## 组件划分

- `js/material-library.js`（改）：数据模型 + `update` + `normalizeTags` + `normalizeEntry` 扩展。**纯逻辑，可 Node 单测。**
- `js/material-tagger.js`（新）：`WpsAiMaterialTagger.tagImage({prompt?, dataUrl?, url?}) → Promise<string[]>`。生成图走文本 chat、图片走视觉；best-effort；解析模型输出为标签数组（复用 `normalizeTags`）。**解析逻辑纯函数、可测；网络调用注入/mock。**
- `js/tools/materials.js`（新）：注册 AI 工具 `query_materials`（检索）和 `save_web_material`（把 web_fetch 结果入库，可选）。
- `js/tools/web.js`（新）：注册 AI 工具 `web_fetch`（抓网页文本）、`web_image_search`（找图）。内部走 proxy。
- `tools/proxy-server.js`（改）：新增 `/fetch-web`（拉 HTML→文本）与 `/image-search`（keyless 图搜）两条路由，复用现有 SSRF 守卫。
- `js/app.js` + `taskpane.html` + `css/style.css`（改）：素材卡渲染标签 chips；工具栏加「导入本地图片」按钮 + 文本搜索框 + 项目筛选；web 素材文本卡样式。
- `js/providers/registry.js` + `taskpane.html`（改）：`DEFAULT_SETTINGS.currentProject`（字符串）+ 统一配置面板输入框；`imageSearch` 配置（endpoint，可选）。
- `js/tools/image.js`（改）：`generate_image` 成功后调 tagger 产标签 + 带上 `project/source:"generated"` 入库。
- `js/tools/presentation.js` + `js/tools/writer.js`（改）：图片工具/整套生成描述里提示 AI「先用 `query_materials` 按标签找可复用素材，再决定生成或复用」。

## 纯 HTML→文本 提取（`/fetch-web`）

服务端：https/http GET（跟随 1 次 3xx，超时 15s，限 2MB），SSRF 守卫复用 `isMetadataSsrfHost`。提取：删 `<script>/<style>/<noscript>/<!-- -->`，`<br>/<p>/<div>/<li>` 转换行，去所有标签，解 HTML 实体，压空白，截断到 ~8000 字。返回 `{ url, title, text, finalUrl }`（title 取 `<title>`）。

## 内容标签生成

`tagImage`：
- 有 `prompt`（生成图）：文本 chat 调用，system/user = "为这张配图生成 3-6 个简洁中文内容标签，用逗号分隔，只输出标签本身"。用当前激活 chat provider。
- 有 `dataUrl`/`url`（本地/网络图）：若激活模型 `supportsImage`，发 `{type:"image_url",image_url:{url}}` + 上述指令；否则跳过返回 `[]`。
- 输出经 `normalizeTags` 解析（截断到最多 8 个）。任何失败返回 `[]`（不抛）。

## AI 检索工具 `query_materials`

参数：`{ query?: string, tags?: string[], project?: string, kind?: string, limit?: number(默认20) }`。
语义：`list()` 后按（`project` 精确、`kind` 精确、`tags` 任一命中、`query` 在 prompt/tags/title/text 里子串命中）过滤，返回精简条目 `[{id,url,kind,prompt,title,tags,project,source}]`。让 AI 决定复用哪个（复用即把其 `url` 传给 `wps_insert_image`/`wpp_add_picture`，或在 freeform HTML 里直接写 `src`）。

## 联网找图 `web_image_search`

参数 `{ query, count?(默认8) }` → proxy `/image-search?q=&n=` → 返回 `[{url,thumbnail,title,source}]`。默认 keyless 源；endpoint 可在设置覆盖。AI/用户选用后经 `/fetch-remote-image` 落地，`add({url/dataUrl, source:"web-search", tags:[query], project})` 入库并异步补内容标签。best-effort：源失效时返回空 + 明确报错，不崩。

## 本地导入

素材库弹窗工具栏「导入本地图片」→ `<input type=file accept="image/*" multiple>`（WPS WebView=Chromium 支持）→ `FileReader` 读为 dataURL → `add({dataUrl, source:"local", project})` → 异步 `tagImage({dataUrl})` 补标签 → `update(id,{tags})`。

## 错误与降级

- 打标签、找图、抓网页全 best-effort：失败不阻塞主流程，UI 给 toast/日志，素材仍入库（标签为空可后补）。
- `web_fetch`/`web_image_search` 的 URL 经 SSRF 守卫；失败返回结构化错误给 AI。
- 视觉模型不可用时本地图入库但标签为空（可后续手动/重试打标）。
- 素材库满（MAX_ENTRIES=80）沿用现有淘汰策略。

## 测试（node:test + node:vm，纯逻辑优先）

- `material-library.js`：`normalizeEntry` 保留 tags/project/source/kind/title/text 且对旧条目兜底；`normalizeTags`（字符串/数组/顿号逗号混合/去重/截断）；`update` 合并 + 规整；`addMany` 透传 meta 标签。
- `material-tagger.js`：模型输出解析（"标签1, 标签2、标签3" → 数组、去噪、截断）；无 prompt 无图 → []；注入 mock chat。
- `query_materials` 过滤逻辑：抽成纯函数 `filterMaterials(list, {query,tags,project,kind})` 单测（子串/任一命中/精确）。
- `/fetch-web` 文本提取：抽 `htmlToText(html)` 纯函数单测（去脚本/换行/实体/截断）。
- COM/网络在编排测试中 mock；proxy 路由手测为主。

## 范围与阶段（YAGNI）

按依赖分阶段实现，每阶段独立可用：

- **阶段 1（基础/标签）**：数据模型 + `update`/`normalizeTags` + 生成图自动打标（prompt 文本标签）+ 项目设置 + 卡片标签 chips + 搜索/项目筛选 UI。
- **阶段 2（AI 复用）**：`query_materials` 工具 + 文档/PPT 工具描述提示复用。
- **阶段 3（本地导入 + 视觉打标）**：导入按钮 + `material-tagger` 视觉路径。
- **阶段 4（联网抓网页）**：`/fetch-web` + `web_fetch` 工具 + web 素材卡。
- **阶段 5（联网找图）**：`/image-search` + `web_image_search` 工具（best-effort）。

不做：headless Chromium/JS 渲染抓取；per-document 项目（先用全局项目标签）；素材跨设备同步。
