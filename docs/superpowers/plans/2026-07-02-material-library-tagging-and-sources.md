# 素材库标签化 + 多来源采集 Implementation Plan

> **For agentic workers:** 分 5 阶段实现，每阶段独立可用、独立可测。基础阶段(1-3)以 TDD 直写 + 阶段末审查；网络阶段(4-5)风险较高，单独审。Steps 用 checkbox 跟踪。

**Goal:** 素材库支持项目标签 + 内容标签、本地导入、联网找图、联网抓网页，AI 可按标签检索复用素材。

**Architecture:** 扩展 `material-library.js` 数据模型(纯逻辑可测)；新增 `material-tagger.js`(LLM 打标)、`js/tools/materials.js`(query_materials)、`js/tools/web.js`(web_fetch/web_image_search)；proxy 加 `/fetch-web`、`/image-search` 路由；UI 加标签 chips/搜索/项目筛选/本地导入。

**Tech Stack:** 浏览器 IIFE(挂 window)；测试 node:test/node:assert/node:vm；proxy 用 Node 内置 http/https；无第三方依赖。

## Global Constraints

- 素材条目新增字段全部有默认值，向后兼容旧条目(`normalizeEntry` 在读写都跑，旧条目读出即补全)。存储 key 不变 `lingxi_material_library_v1`。
- 打标签/找图/抓网页全 best-effort：失败不阻塞、不抛到主流程，素材照常入库。
- 内容标签用 LLM(生成图走文本、图片走视觉 `supportsImage`)，不做本地中文分词。
- `web_fetch` = 服务端静态抓取(无 headless Chromium)；URL 经 SSRF 守卫 `isMetadataSsrfHost`。
- 新工具 `hosts:"*"`；新 IIFE 模块须在 `main.js` 正确顺序加载。
- 纯逻辑(normalize/parse/filter/htmlToText)必须有 node:test 单测；COM/网络 mock 或手测。

---

## 阶段 1：数据模型 + 标签基础

### Task 1: material-library 数据模型扩展

**Files:** Modify `plugin/js/material-library.js`；Create `plugin/test/material-library.test.js`

**Interfaces (Produces):**
- `normalizeEntry` 输出新增 `tags:string[]`、`project:string`、`source:string("generated")`、`kind:string("image")`、`title:string`、`source`、`text:string`。
- `normalizeTags(input)→string[]`：接受数组或字符串(逗号/中文顿号/分号分隔)，trim、去空、去重、最多 12 个。
- `update(id, patch)→entry|null`：合并 patch 到条目、经 normalizeEntry 规整、写回、notify。
- 导出新增 `update`、`normalizeTags`。

- [ ] Step 1: 写失败测试 `material-library.test.js`（见下方测试代码）
- [ ] Step 2: `node --test test/material-library.test.js` 确认 FAIL
- [ ] Step 3: 实现（normalizeTags + normalizeEntry 扩展 + update + 导出）
- [ ] Step 4: `node --test test/material-library.test.js` 确认 PASS
- [ ] Step 5: `node -c js/material-library.js`
- [ ] Step 6: Commit `feat(material): 素材条目支持 tags/project/source/kind + update/normalizeTags`

测试代码：
```js
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function load() {
  const mem = new Map();
  const localStorage = { getItem:(k)=>mem.has(k)?mem.get(k):null, setItem:(k,v)=>mem.set(k,String(v)), removeItem:(k)=>mem.delete(k) };
  const code = fs.readFileSync(path.join(__dirname,"..","js","material-library.js"),"utf8");
  const window = {};
  const factory = vm.runInThisContext("(function(window, localStorage, console){ "+code+"\n return window.WpsAiMaterialLibrary; })");
  return factory(window, localStorage, console);
}
test("normalizeTags: 字符串按逗号/顿号/分号切分、去空去重、限量", () => {
  const M = load();
  assert.deepStrictEqual(M.normalizeTags("科技, 蓝色、科技；未来 "), ["科技","蓝色","未来"]);
  assert.deepStrictEqual(M.normalizeTags(["a"," a ","b",""]), ["a","b"]);
  assert.strictEqual(M.normalizeTags("").length, 0);
  assert.ok(M.normalizeTags(Array.from({length:20},(_,i)=>"t"+i)).length <= 12);
});
test("add/list: tags/project/source/kind 被持久化并可读回", () => {
  const M = load();
  M.add({ url:"http://x/a.png", prompt:"蓝色科技封面", tags:["科技","蓝色"], project:"Q3汇报", source:"generated" });
  const e = M.list()[0];
  assert.deepStrictEqual(e.tags, ["科技","蓝色"]);
  assert.strictEqual(e.project, "Q3汇报");
  assert.strictEqual(e.source, "generated");
  assert.strictEqual(e.kind, "image");
});
test("normalizeEntry: 旧条目缺字段有默认值(向后兼容)", () => {
  const M = load();
  M.add({ url:"http://x/b.png" });
  const e = M.list()[0];
  assert.deepStrictEqual(e.tags, []);
  assert.strictEqual(e.project, "");
  assert.strictEqual(e.source, "generated");
  assert.strictEqual(e.kind, "image");
  assert.strictEqual(e.title, "");
  assert.strictEqual(e.text, "");
});
test("update: 合并 patch 并规整 tags", () => {
  const M = load();
  const a = M.add({ url:"http://x/c.png" });
  const u = M.update(a.id, { tags:"新, 标签、新", project:"P1" });
  assert.deepStrictEqual(u.tags, ["新","标签"]);
  assert.strictEqual(u.project, "P1");
  assert.strictEqual(M.find(a.id).project, "P1");
});
test("update: 不存在的 id 返回 null", () => {
  const M = load();
  assert.strictEqual(M.update("nope",{tags:["x"]}), null);
});
test("kind=web 素材保留 title/text", () => {
  const M = load();
  M.add({ url:"http://site/p", kind:"web", title:"标题", text:"正文内容", source:"web-fetch" });
  const e = M.list()[0];
  assert.strictEqual(e.kind,"web"); assert.strictEqual(e.title,"标题"); assert.strictEqual(e.text,"正文内容");
});
test("addMany: meta 透传 tags/project", () => {
  const M = load();
  M.addMany([{url:"http://x/d.png"}], { project:"PX", tags:["共享"] });
  const e = M.list()[0];
  assert.strictEqual(e.project,"PX");
  assert.deepStrictEqual(e.tags,["共享"]);
});
```

实现要点（normalizeEntry 内新增，其余不变）：
```js
  function normalizeTags(input) {
    let arr = [];
    if (Array.isArray(input)) arr = input;
    else if (typeof input === "string") arr = input.split(/[,，、;；]+/);
    const seen = new Set(); const out = [];
    arr.map((t) => String(t == null ? "" : t).trim()).forEach((t) => {
      if (!t || seen.has(t)) return; seen.add(t); out.push(t);
    });
    return out.slice(0, 12);
  }
```
normalizeEntry 的 return 追加：
```js
      tags: normalizeTags(item.tags),
      project: String(item.project || "").trim(),
      source: String(item.source || "generated").trim() || "generated",
      kind: String(item.kind || "image").trim() || "image",
      title: String(item.title || "").trim(),
      text: String(item.text || "").trim(),
```
update：
```js
  function update(id, patch) {
    const store = readStore();
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const merged = normalizeEntry(Object.assign({}, store.entries[idx], patch || {}, { id }));
    if (!merged) return null;
    const entries = store.entries.slice(); entries[idx] = merged;
    writeStore({ entries, groups: store.groups }); notify(); return merged;
  }
```
导出加 `update, normalizeTags`。

---

### Task 2: material-tagger（LLM 打标，文本 + 视觉路径）

**Files:** Create `plugin/js/material-tagger.js`；Create `plugin/test/material-tagger.test.js`；Modify `plugin/main.js`（加载，在 material-library.js 之后）

**Interfaces (Produces):** `WpsAiMaterialTagger.tagImage({prompt?, dataUrl?, url?, chat?})→Promise<string[]>`。
- 注入 `chat`(测试用)或默认用激活 provider 的 `chat({model,messages})`。
- 有 prompt→文本消息；有 dataUrl/url 且模型 supportsImage→视觉消息；都无→`[]`。
- 解析模型回复经 `WpsAiMaterialLibrary.normalizeTags`（截断到 8）。失败→`[]`(不抛)。
- 纯解析 `parseTagsReply(text)` 导出以便测试。

- [ ] Step 1: 写失败测试（parseTagsReply：把 "标签：科技, 蓝色、未来" 清洗成 ["科技","蓝色","未来"]；tagImage 无输入→[]；注入 mock chat 返回文本→数组；chat 抛错→[]）
- [ ] Step 2-4: RED→实现→GREEN
- [ ] Step 5: `node -c js/material-tagger.js`
- [ ] Step 6: Commit `feat(material): material-tagger LLM 打标（文本+视觉，best-effort）`

实现要点：读激活 provider —— `const cfg = global.WpsAiProviderRegistry.getActiveConfig(); const provider = global.WpsAiProviderRegistry.buildProvider(cfg); const model = cfg.defaultModel || global.WpsAiProviderRegistry.loadSettings().activeChatModel;` 视觉判定 `global.WpsAiCapabilities?.supportsImage?.(model)`。消息 system："你是图像打标助手，只输出 3-6 个简洁中文内容标签，用逗号分隔，不要解释。" parseTagsReply 去掉「标签：」「以下是」等前缀行、切分、normalizeTags。

---

### Task 3: 项目设置 + 生成图自动打标

**Files:** Modify `plugin/js/providers/registry.js`（DEFAULT_SETTINGS.currentProject + loadSettings merge）；`plugin/taskpane.html`（统一配置面板加「当前项目」输入 `#currentProjectInput`）；`plugin/js/app.js`（读写该输入）；`plugin/js/tools/image.js`（生成后打标+项目+source）

- [ ] Step 1: registry：`DEFAULT_SETTINGS` 加 `currentProject: ""`；loadSettings 字符串合并区加 `if (typeof raw.currentProject === "string") merged.currentProject = raw.currentProject;`
- [ ] Step 2: taskpane.html 统一配置面板加输入框（跟 systemPrompt 同区）
- [ ] Step 3: app.js：设置弹窗读取/保存 currentProject（跟随现有设置读写逻辑）
- [ ] Step 4: image.js：把 addMany 的 meta 加 `project: settings.currentProject, source:"generated"`；addMany 后对每条异步 `tagImage({prompt})`→`update(id,{tags})`（best-effort，不 await 阻塞返回）
- [ ] Step 5: `node -c` 三文件
- [ ] Step 6: Commit `feat(material): 全局项目标签 + 生成图自动打内容标签`

image.js 打标接线（addMany 之后）：
```js
try {
  const cur = added || [];
  cur.forEach((entry) => {
    global.WpsAiMaterialTagger?.tagImage?.({ prompt })
      .then((tags) => { if (tags && tags.length) global.WpsAiMaterialLibrary?.update?.(entry.id, { tags }); })
      .catch(() => {});
  });
} catch (e) {}
```
（其中 `added` = addMany 返回值；需把 image.js 里 addMany 调用的返回值接住。）

---

### Task 4: 素材卡标签 UI + 搜索 + 项目筛选

**Files:** Modify `plugin/js/app.js`（renderMaterialLibrary 卡片加 tag chips；工具栏加搜索框 + 项目筛选；过滤逻辑）；`plugin/taskpane.html`（`#materialSearchInput`、`#materialProjectFilter`）；`plugin/css/style.css`（.material-tags/.material-tag chip 样式）

- [ ] Step 1: taskpane.html 工具栏加搜索框 + 项目下拉
- [ ] Step 2: app.js renderMaterialLibrary：卡片 `.material-card-body` 内渲染 `(item.tags||[]).map(chip)`；按 `materialSearchText`(匹配 prompt/tags/title) + `materialProjectFilter` 过滤
- [ ] Step 3: css chip 样式（复用 .material-group-pill 风格，线性、蓝色系）
- [ ] Step 4: `node -c js/app.js`
- [ ] Step 5: Commit `feat(material): 素材卡标签展示 + 文本搜索 + 项目筛选`

---

## 阶段 2：AI 检索复用

### Task 5: query_materials 工具 + 复用提示

**Files:** Create `plugin/js/tools/materials.js`；`plugin/test/materials-filter.test.js`；Modify `plugin/main.js`（加载）；`plugin/js/tools/presentation.js` + `writer.js`（描述里提示先查素材）

**Interfaces:** 纯函数 `filterMaterials(list, {query,tags,project,kind})→entry[]` 导出可测；工具 `query_materials` handler 调 `WpsAiMaterialLibrary.list()` → filterMaterials → 返回精简条目。

- [ ] Step 1: 写 filterMaterials 单测（project 精确/kind 精确/tags 任一命中/query 子串命中 prompt|tags|title|text）
- [ ] Step 2-4: RED→实现→GREEN
- [ ] Step 5: presentation.js/writer.js 图片相关工具描述追加一行：「插图前可调 query_materials 按 tags/project 找可复用素材，命中则直接用其 url，避免重复生成」
- [ ] Step 6: `node -c` + `node --test`
- [ ] Step 7: Commit `feat(material): query_materials 工具 + 文档/PPT 复用提示`

---

## 阶段 3：本地导入 + 视觉打标

### Task 6: 本地图片导入

**Files:** Modify `plugin/taskpane.html`（工具栏「导入本地图片」按钮 + 隐藏 `<input type=file accept=image/* multiple>`）；`plugin/js/app.js`（FileReader→dataURL→add({dataUrl,source:"local",project})→异步 tagImage({dataUrl})→update）

- [ ] Step 1: taskpane.html 按钮 + file input
- [ ] Step 2: app.js 绑定：读文件→dataURL→add→异步视觉打标→update→重渲染；toast 进度
- [ ] Step 3: `node -c js/app.js`
- [ ] Step 4: Commit `feat(material): 本地图片导入 + 视觉自动打标`

---

## 阶段 4：联网抓网页

### Task 7: /fetch-web 路由 + web_fetch 工具

**Files:** Modify `plugin/tools/proxy-server.js`（`/fetch-web` 路由 + `htmlToText`）；`plugin/tools/proxy-server.test.js`（htmlToText 单测——若 proxy 便于抽测则抽 htmlToText 到可测位置）；Create `plugin/js/tools/web.js`（web_fetch 工具）；`plugin/js/tools/materials.js` 加 `save_web_material`；`plugin/main.js` 加载

**Interfaces:** 纯函数 `htmlToText(html)→{title,text}` 可测；`/fetch-web` POST `{url}`→`{url,finalUrl,title,text}`；工具 `web_fetch({url, save?})`→文本(+可选入库 kind:"web")。

- [ ] Step 1: 抽 `htmlToText` 为可 require 的函数 + 单测（去 script/style/注释、块级转行、实体解码、截断 8000、title 提取）
- [ ] Step 2-4: RED→实现→GREEN
- [ ] Step 5: proxy `/fetch-web`（https/http GET，1 次重定向，超时 15s，限 2MB，SSRF 守卫），返回 htmlToText 结果
- [ ] Step 6: web.js 注册 `web_fetch`（走 proxy）；materials.js 加 `save_web_material({url,title,text,tags})`
- [ ] Step 7: `node -c` + `node --test`
- [ ] Step 8: Commit `feat(web): web_fetch 抓网页文本作为素材（服务端静态抓取）`

---

## 阶段 5：联网找图

### Task 8: /image-search 路由 + web_image_search 工具

**Files:** Modify `plugin/tools/proxy-server.js`（`/image-search` keyless 图搜，endpoint 可配）；Create/Modify `plugin/js/tools/web.js`（web_image_search 工具）；`plugin/js/providers/registry.js`（可选 imageSearch endpoint 设置）

- [ ] Step 1: proxy `/image-search?q=&n=`：默认 keyless 源（DuckDuckGo i.js token 流程），解析结果为 `[{url,thumbnail,title,source}]`，失败返回结构化错误
- [ ] Step 2: web.js 注册 `web_image_search({query,count})` → proxy → 返回列表；AI/用户选用后经 `/fetch-remote-image` 落地 + `add({source:"web-search",tags:[query],project})`
- [ ] Step 3: `node -c`
- [ ] Step 4: Commit `feat(web): web_image_search 联网找图（best-effort keyless 源）`

---

## 自查

- 全部 5 项用户诉求有对应 Task：打标签(T1-T4)、AI 按标签复用(T5)、本地导入自动打标(T6)、联网抓网页(T7)、联网找图(T8)。
- 纯逻辑均有单测(normalizeTags/update、parseTagsReply、filterMaterials、htmlToText)。
- 向后兼容(normalizeEntry 默认值)、best-effort 降级、SSRF 守卫、无第三方依赖 —— 全程遵守。
- 无 headless Chromium：web_fetch 明确为静态抓取(spec 已记决策)。
