# 分步生成 PPT（配图异步）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `wpp_render_full_deck` 分两步生成整套 PPT——先秒级插入全部带图片占位骨架的幻灯片供用户预览，再后台异步生成图片、每页图片齐了自动替换回该页。

**Architecture:** 新增纯函数模块 `js/tools/deck-staging.js`（HTML 图片槽位解析/占位/回填、并发限制器、每页就绪追踪、后台回填编排器），全部与 WPS COM 解耦、可 Node 单测。`wpp_render_full_deck` handler 改为：阶段一循环渲染占位版并插入、打唯一 seq tag、立即返回；阶段二 fire-and-forget 后台任务调编排器，用真实图片回填并 `replace` 换页。

**Tech Stack:** 纯浏览器 JS（IIFE 挂 `window`），无第三方依赖；测试用 Node 内置 `node:test` / `node:assert` / `node:vm`。HTML 处理用正则字符串操作（**不依赖 DOMParser**，以便脱离浏览器单测）。占位图用 `data:image/svg+xml,` + `encodeURIComponent`（不依赖 btoa/Buffer）。

## Global Constraints

- **只改 `wpp_render_full_deck`（整套生成）**；单页 `wpp_render_html_template` 本期不动。
- 阶段一插完**立即返回**，绝不 await 图片生成；阶段二后台任务所有异常必须 try/catch 吞掉，不得让未捕获 Promise 拒绝冒泡。
- 图片槽位契约：freeform HTML 中带 `data-gen-prompt` 属性的 `<img>` 进入分步流程；不带的普通 `<img>` 原样不动。
- 重渲染粒度：**一页所有图片都有结果（成功或失败）后，才 `replace` 该页一次**。
- 定位替换页：靠每页唯一 tag `LingxiBatchSeq`=`<batchTag>:<seq>` 反查当前 index，不靠记录的旧 index；找不到则跳过不报错。
- 图像生成未启用（`getImageConfig().enabled !== true`）时：阶段一照常出带占位的 deck，阶段二整体跳过。
- HTML 处理全部字符串/正则实现，不引入 DOMParser 或任何依赖。
- 新模块 IIFE 挂 `global.WpsAiDeckStaging`；须在 `main.js` 里于 `js/tools/presentation.js` **之前**加载。
- 并发默认 3。
- 测试运行命令：`node --test test/<文件>`（本仓库无 test npm script，直接用 node 内置 runner）。

---

### Task 1: 纯函数模块 `deck-staging.js` + 单测 + 加载注册

**Files:**
- Create: `plugin/js/tools/deck-staging.js`
- Create: `plugin/test/deck-staging.test.js`
- Modify: `plugin/main.js`（在 `"js/tools/presentation.js"` 之前插入 `"js/tools/deck-staging.js"`）

**Interfaces:**
- Consumes: 无（叶子模块）。
- Produces: `global.WpsAiDeckStaging = { collectImageRequests, applyPlaceholders, fillImages, buildPlaceholderDataUrl, makeLimiter, makeImageTracker }`
  - `collectImageRequests(html: string) → { html: string, requests: Array<{ id, prompt, size?, resolution? }> }`：扫描带 `data-gen-prompt` 的 `<img>`，为每个注入 `data-gen-id="gN"`（若无），返回注入后的 html 与请求列表；普通 img 不动。
  - `applyPlaceholders(html: string, requests, palette) → string`：把 requests 中各 id 对应 `<img>` 的 `src` 换成占位 dataURL。
  - `fillImages(html: string, urlById: Record<string,string>) → string`：把有 URL 的 id 对应 `<img>` 的 `src` 换成该 URL；无 URL（null/缺失）的 id 不动。
  - `buildPlaceholderDataUrl(palette: {surfaceColor?,bodyColor?}, caption: string) → string`：返回 `data:image/svg+xml,...` 占位图。
  - `makeLimiter(concurrency: number) → (thunk: ()=>Promise) => Promise`：受限并发执行器。
  - `makeImageTracker(pages: Array<{seq:number, ids:string[]}>) → { record(seq, id, url) → { seq, urlById } | null }`：记录单张图结果；当某页全部 id 都有结果时返回 `{ seq, urlById }`，否则返回 null。

- [ ] **Step 1: 写失败测试** `plugin/test/deck-staging.test.js`

```js
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function load() {
  // 用 runInThisContext 在当前 realm 里执行模块，返回的数组/对象与测试同一 realm，
  // 这样 deepStrictEqual 才不会因跨 realm 原型不同而误判（createContext 会跨 realm）。
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "deck-staging.js"), "utf8");
  const window = {};
  const factory = vm.runInThisContext(
    "(function(window, console){ " + code + "\n return window.WpsAiDeckStaging; })"
  );
  return factory(window, console);
}

test("collectImageRequests: 收集带 data-gen-prompt 的 img 并注入 id，普通 img 不动", () => {
  const S = load();
  const html = '<div><img data-gen-prompt="城市" data-gen-size="16:9"><img src="http://x/y.png" class="logo"></div>';
  const { html: out, requests } = S.collectImageRequests(html);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].prompt, "城市");
  assert.strictEqual(requests[0].size, "16:9");
  assert.strictEqual(requests[0].id, "g0");
  assert.ok(out.includes('data-gen-id="g0"'), "目标 img 注入了 id");
  assert.ok(out.includes('src="http://x/y.png"'), "普通 img 的 src 原样保留");
});

test("collectImageRequests: 多张目标 img 递增 id，resolution 可选", () => {
  const S = load();
  const html = '<img data-gen-prompt="a"><img data-gen-prompt="b" data-gen-resolution="2K">';
  const { requests } = S.collectImageRequests(html);
  assert.deepStrictEqual(requests.map(r => r.id), ["g0", "g1"]);
  assert.strictEqual(requests[0].resolution, undefined);
  assert.strictEqual(requests[1].resolution, "2K");
});

test("applyPlaceholders: 目标 img 的 src 变占位，普通 img 不动", () => {
  const S = load();
  const { html, requests } = S.collectImageRequests('<img data-gen-prompt="a"><img src="keep.png">');
  const out = S.applyPlaceholders(html, requests, { surfaceColor: "#EEE" });
  assert.ok(out.includes("data:image/svg+xml,"), "目标 img 用了占位 dataURL");
  assert.ok(out.includes('src="keep.png"'), "普通 img 不动");
});

test("fillImages: 有 URL 的 id 回填 src，无 URL 的不动", () => {
  const S = load();
  const { html, requests } = S.collectImageRequests('<img data-gen-prompt="a"><img data-gen-prompt="b">');
  const ph = S.applyPlaceholders(html, requests, {});
  const filled = S.fillImages(ph, { g0: "http://real/a.png" });
  assert.ok(filled.includes('src="http://real/a.png"'), "g0 被回填");
  // g1 未提供 URL，仍是占位
  assert.ok(filled.includes("data:image/svg+xml,"), "g1 仍保留占位");
});

test("buildPlaceholderDataUrl: 返回 svg dataURL 且含 caption", () => {
  const S = load();
  const url = S.buildPlaceholderDataUrl({ surfaceColor: "#F4F4F5" }, "AI 配图生成中…");
  assert.ok(url.startsWith("data:image/svg+xml,"));
  assert.ok(decodeURIComponent(url).includes("AI 配图生成中"));
});

test("makeLimiter: 并发不超过上限且全部完成", async () => {
  const S = load();
  const run = S.makeLimiter(2);
  let active = 0, peak = 0;
  const mk = () => run(async () => {
    active += 1; peak = Math.max(peak, active);
    await Promise.resolve(); await Promise.resolve();
    active -= 1; return "ok";
  });
  const res = await Promise.all([mk(), mk(), mk(), mk(), mk()]);
  assert.strictEqual(res.length, 5);
  assert.ok(peak <= 2, `峰值并发 ${peak} 应 ≤ 2`);
});

test("makeLimiter: 单个 reject 不拖垮其余", async () => {
  const S = load();
  const run = S.makeLimiter(2);
  const results = await Promise.allSettled([
    run(async () => { throw new Error("boom"); }),
    run(async () => "ok")
  ]);
  assert.strictEqual(results[0].status, "rejected");
  assert.strictEqual(results[1].status, "fulfilled");
});

test("makeImageTracker: 某页全部就绪才返回该页 urlById", () => {
  const S = load();
  const tr = S.makeImageTracker([{ seq: 1, ids: ["g0", "g1"] }, { seq: 2, ids: ["g0"] }]);
  assert.strictEqual(tr.record(1, "g0", "u0"), null, "第1页还差一张");
  const done1 = tr.record(1, "g1", null);
  assert.deepStrictEqual(done1, { seq: 1, urlById: { g0: "u0", g1: null } });
  const done2 = tr.record(2, "g0", "u2");
  assert.deepStrictEqual(done2, { seq: 2, urlById: { g0: "u2" } });
});

test("makeImageTracker: 未知 seq/id 返回 null", () => {
  const S = load();
  const tr = S.makeImageTracker([{ seq: 1, ids: ["g0"] }]);
  assert.strictEqual(tr.record(9, "g0", "x"), null);
  assert.strictEqual(tr.record(1, "zz", "x"), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/deck-staging.test.js`
Expected: FAIL（`Cannot read properties of undefined` / `WpsAiDeckStaging` 为 undefined，因 `deck-staging.js` 尚不存在）

- [ ] **Step 3: 实现 `plugin/js/tools/deck-staging.js`**

```js
(function attachDeckStaging(global) {
  "use strict";

  // 分步生成 PPT 的纯函数工具：HTML 图片槽位解析/占位/回填 + 并发限制 + 每页就绪追踪。
  // 全部字符串/正则实现，不依赖 DOMParser/btoa，便于脱离浏览器单测。

  const IMG_TAG_RE = /<img\b[^>]*>/gi;

  function eachImgTag(html, fn) {
    return String(html || "").replace(IMG_TAG_RE, (tag) => {
      const r = fn(tag);
      return (r == null) ? tag : r;
    });
  }

  function getAttr(tag, name) {
    let m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i"));
    if (m) return m[1];
    m = tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", "i"));
    return m ? m[1] : null;
  }

  function setAttr(tag, name, value) {
    const esc = String(value).replace(/"/g, "&quot;");
    const re = new RegExp("(" + name + "\\s*=\\s*)(\"[^\"]*\"|'[^']*')", "i");
    if (re.test(tag)) return tag.replace(re, '$1"' + esc + '"');
    return tag.replace(/^<img\b/i, '<img ' + name + '="' + esc + '"');
  }

  function collectImageRequests(html) {
    const requests = [];
    let n = 0;
    const out = eachImgTag(html, (tag) => {
      const prompt = getAttr(tag, "data-gen-prompt");
      if (!prompt) return tag; // 普通 img 不进入分步流程
      let id = getAttr(tag, "data-gen-id");
      let t = tag;
      if (!id) { id = "g" + n; t = setAttr(t, "data-gen-id", id); }
      n += 1;
      requests.push({
        id,
        prompt,
        size: getAttr(tag, "data-gen-size") || undefined,
        resolution: getAttr(tag, "data-gen-resolution") || undefined
      });
      return t;
    });
    return { html: out, requests };
  }

  function buildPlaceholderDataUrl(palette, caption) {
    const p = palette || {};
    const bg = p.surfaceColor || "#F4F4F5";
    const fg = p.bodyColor || "#9AA0A6";
    const text = String(caption || "AI 配图生成中…");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">' +
      '<rect width="800" height="450" fill="' + bg + '"/>' +
      '<g fill="none" stroke="' + fg + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="330" y="175" width="140" height="110" rx="10"/>' +
      '<circle cx="368" cy="212" r="14"/>' +
      '<path d="M330 265 L385 220 L420 250 L450 225 L470 245"/>' +
      '</g>' +
      '<text x="400" y="330" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="26" fill="' + fg + '">' +
      text + '</text></svg>';
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function applyPlaceholders(html, requests, palette) {
    const ids = new Set((requests || []).map((r) => r.id));
    const ph = buildPlaceholderDataUrl(palette || {}, "AI 配图生成中…");
    return eachImgTag(html, (tag) => {
      const id = getAttr(tag, "data-gen-id");
      if (!id || !ids.has(id)) return tag;
      return setAttr(tag, "src", ph);
    });
  }

  function fillImages(html, urlById) {
    const map = urlById || {};
    return eachImgTag(html, (tag) => {
      const id = getAttr(tag, "data-gen-id");
      if (!id || !map[id]) return tag; // 无 URL 的保留原样（占位）
      return setAttr(tag, "src", map[id]);
    });
  }

  function makeLimiter(concurrency) {
    const max = Math.max(1, Number(concurrency) || 1);
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < max && queue.length) {
        const job = queue.shift();
        active += 1;
        Promise.resolve().then(job.thunk).then(
          (v) => { active -= 1; job.resolve(v); pump(); },
          (e) => { active -= 1; job.reject(e); pump(); }
        );
      }
    };
    return function run(thunk) {
      return new Promise((resolve, reject) => {
        queue.push({ thunk, resolve, reject });
        pump();
      });
    };
  }

  function makeImageTracker(pages) {
    const remaining = new Map();
    const results = new Map();
    (pages || []).forEach((p) => {
      remaining.set(p.seq, new Set(p.ids || []));
      results.set(p.seq, {});
    });
    return {
      record(seq, id, url) {
        const rem = remaining.get(seq);
        if (!rem || !rem.has(id)) return null;
        rem.delete(id);
        results.get(seq)[id] = url || null;
        if (rem.size === 0) return { seq, urlById: results.get(seq) };
        return null;
      }
    };
  }

  global.WpsAiDeckStaging = {
    collectImageRequests, applyPlaceholders, fillImages,
    buildPlaceholderDataUrl, makeLimiter, makeImageTracker
  };
})(window);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/deck-staging.test.js`
Expected: PASS（9 个测试全绿）

- [ ] **Step 5: 在 `main.js` 注册加载**

在 `plugin/main.js` 的脚本加载列表里，`"js/tools/presentation.js"` 这一行**之前**插入：

```js
    "js/tools/deck-staging.js",
```

（当前顺序见 `main.js` 第 59-65 行：registry.js → common.js → spreadsheet.js → writer.js → presentation.js …；把 deck-staging.js 放在 presentation.js 之前、common.js 之后即可。）

- [ ] **Step 6: 语法校验**

Run: `node -c js/tools/deck-staging.js && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add plugin/js/tools/deck-staging.js plugin/test/deck-staging.test.js plugin/main.js
git commit -m "feat(ppt): deck-staging 纯函数模块（图片槽位解析/占位/回填/并发/就绪追踪）"
```

---

### Task 2: 阶段一——占位版整套插入 + 唯一 seq tag + 立即返回

**Files:**
- Modify: `plugin/js/tools/presentation.js`（`wpp_render_full_deck` 的 handler，约 2211-2313 行；并在模块内新增 `findSlideIndexBySeqTag` 辅助函数）
- Create: `plugin/test/deck-seq-tag.test.js`

**Interfaces:**
- Consumes: `global.WpsAiDeckStaging.{collectImageRequests, applyPlaceholders}`（Task 1）；现有 `renderAndInsertSlide`、`getPresentation`、`getEffectiveStylePreset`、`globalPalette` 构造逻辑。
- Produces:
  - 模块级函数 `findSlideIndexBySeqTag(pres, batchTag, seq) → number|null`：扫描 `pres.Slides`，返回 `Tags.Item("LingxiBatchSeq") === batchTag + ":" + seq` 的那张的 `SlideIndex`；找不到返回 null。Task 3 会用它。
  - handler 阶段一产出并挂到闭包变量的 `pageRecords: Array<{ seq, slideIndex, templateName, layout, html, css, palette, requests }>`（仅含 freeform 且有 `data-gen-prompt` 图片的页；供 Task 3 阶段二使用）。
  - handler 返回值新增字段：`phase: "preview-ready"`, `pendingImages: number`, `slidesWithImages: number`。

- [ ] **Step 1: 写失败测试** `plugin/test/deck-seq-tag.test.js`

`findSlideIndexBySeqTag` 涉及 COM，用 mock pres 测。但它是 `presentation.js` 内的模块私有函数——为可测，把它挂到 `global.WpsAiRenderDeckInternals = { findSlideIndexBySeqTag }`（`presentation.js` 末尾已有 `global.WpsAiRenderAndInsertSlide = ...` 的先例）。测试加载 `presentation.js` 需要不少 `window.*` 依赖，故沙箱里给足桩对象。

```js
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadInternals() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "presentation.js"), "utf8");
  // presentation.js 顶部若 registry 缺失会 return，导致不挂 internals。给足最小桩：
  const window = {
    WpsAiToolRegistry: { registerTool() {}, toOpenAIToolSpec() {}, execute() {}, serializeResult() {} },
    WpsAiHostPresentation: { _internal: {} },
    WpsAiImageAssets: {},
    WpsAiProviderRegistry: { DESIGN_GUIDELINES: [], COLOR_SCHEMES: {}, loadSettings: () => ({}) },
    WpsAiHtmlTemplates: {},
    WpsAiHtmlCache: {},
    WpsAiHtmlPreview: {},
    WpsAiDeckStaging: {}
  };
  const sandbox = { window, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return window.WpsAiRenderDeckInternals;
}

// mock 一张 slide：Tags.Item(name) 从 map 取；SlideIndex 固定
function mkSlide(index, tags) {
  return {
    SlideIndex: index,
    Tags: { Item: (name) => (tags && tags[name]) || "" }
  };
}
function mkPres(slides) {
  return { Slides: { Count: slides.length, Item: (i) => slides[i - 1] } };
}

test("findSlideIndexBySeqTag: 命中唯一 seq tag 返回其 SlideIndex", () => {
  const internals = loadInternals();
  const pres = mkPres([
    mkSlide(1, { LingxiBatchSeq: "deck-x:1" }),
    mkSlide(2, { LingxiBatchSeq: "deck-x:2" }),
    mkSlide(3, { LingxiBatchSeq: "other:1" })
  ]);
  assert.strictEqual(internals.findSlideIndexBySeqTag(pres, "deck-x", 2), 2);
});

test("findSlideIndexBySeqTag: 用户在前面插了一页后仍按 tag 命中真实位置", () => {
  const internals = loadInternals();
  const pres = mkPres([
    mkSlide(1, {}),                                   // 用户新插入的页
    mkSlide(2, { LingxiBatchSeq: "deck-x:1" }),
    mkSlide(3, { LingxiBatchSeq: "deck-x:2" })
  ]);
  assert.strictEqual(internals.findSlideIndexBySeqTag(pres, "deck-x", 1), 2);
});

test("findSlideIndexBySeqTag: 找不到返回 null", () => {
  const internals = loadInternals();
  const pres = mkPres([mkSlide(1, { LingxiBatchSeq: "deck-x:1" })]);
  assert.strictEqual(internals.findSlideIndexBySeqTag(pres, "deck-x", 9), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/deck-seq-tag.test.js`
Expected: FAIL（`WpsAiRenderDeckInternals` 为 undefined）

- [ ] **Step 3: 新增 `findSlideIndexBySeqTag` 并导出**

在 `plugin/js/tools/presentation.js` 中 `getSlideAt` 函数附近（约 410 行后）新增：

```js
  // 按唯一 seq tag 反查某页当前真实 index（防用户中途增删页导致 index 漂移）。
  // seq tag 写法：Tags["LingxiBatchSeq"] = `${batchTag}:${seq}`。找不到返回 null。
  function findSlideIndexBySeqTag(pres, batchTag, seq) {
    const want = String(batchTag) + ":" + String(seq);
    const slides = pres?.Slides;
    const count = slides?.Count || 0;
    for (let i = 1; i <= count; i += 1) {
      try {
        const s = slides.Item(i);
        const v = s?.Tags?.Item?.("LingxiBatchSeq");
        if (v && String(v) === want) return s.SlideIndex || i;
      } catch (e) {}
    }
    return null;
  }
```

在文件末尾 `global.WpsAiRenderAndInsertSlide = renderAndInsertSlide;` 之后（或 IIFE 结束前统一处）新增导出：

```js
  global.WpsAiRenderDeckInternals = { findSlideIndexBySeqTag };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/deck-seq-tag.test.js`
Expected: PASS（3 个测试全绿）

- [ ] **Step 5: 改造 handler 阶段一**

把 `wpp_render_full_deck` handler 里的插入循环（当前约 2260-2293 行）改为：渲染前对 freeform HTML 做占位处理，插入后补写 seq tag，并收集 `pageRecords`。将当前循环体替换为下面逻辑（保留外围的 `globalPalette` 构造、`batchTag`、`writeProgress`/`clearProgress`、`inserted`/`errs` 不变）：

```js
      const Staging = global.WpsAiDeckStaging;
      const pageRecords = []; // 供阶段二回填
      let pendingImages = 0;

      const inserted = [];
      const errs = [];
      for (let i = 0; i < slides.length; i += 1) {
        writeProgress(i, `渲染第 ${i + 1}/${slides.length} 页`);
        const spec = slides[i] || {};
        const templateName = spec.templateName || "studio";
        const layout = spec.layout;
        const data = spec.data || {};
        const slidePalette = Object.assign({}, globalPalette, deckPalette || {}, spec.palette || {});
        if (!layout) { errs.push(`#${i + 1}: 缺 layout`); continue; }

        const tpl = HtmlTpl.getTemplate?.(templateName);
        const layoutDef = tpl?.layouts?.[layout];
        if (!layoutDef) {
          errs.push(`#${i + 1}: layout '${templateName}/${layout}' 不存在`);
          continue;
        }

        // 仅 freeform 且 data.html 是字符串时才可能有图片槽位
        let renderData = data;
        let record = null;
        if (Staging && typeof data.html === "string") {
          const { html: normHtml, requests } = Staging.collectImageRequests(data.html);
          if (requests.length) {
            const phHtml = Staging.applyPlaceholders(normHtml, requests, slidePalette);
            renderData = Object.assign({}, data, { html: phHtml });
            record = {
              seq: i + 1, slideIndex: null,
              templateName, layout,
              html: normHtml, css: data.css,
              palette: slidePalette, requests
            };
            pendingImages += requests.length;
          }
        }

        try {
          const res = await renderAndInsertSlide({
            templateName, layout, data: renderData, palette: slidePalette, batchTag
          });
          inserted.push({ seq: i + 1, slideIndex: res.slide, template: res.template, layout: res.layout });
          // 补写唯一 seq tag，供阶段二按 tag 反查
          try {
            const presNow = await getPresentation();
            const slideObj = presNow.Slides.Item(res.slide);
            slideObj?.Tags?.Add?.("LingxiBatchSeq", batchTag + ":" + (i + 1));
          } catch (e) {}
          if (record) { record.slideIndex = res.slide; pageRecords.push(record); }
        } catch (e) {
          errs.push(`#${i + 1} (${templateName}/${layout}): ${e?.message || e}`);
        }
      }
```

- [ ] **Step 6: 改造 handler 返回值（阶段一即返回）**

把 handler 结尾的 `return { ... }`（当前约 2300-2311 行）替换为下面这版，新增 `phase`/`pendingImages`/`slidesWithImages`。**Task 3 会在这个 return 之前插入阶段二后台任务的启动代码**，本任务先返回不含图片生成的结果：

```js
      writeProgress(slides.length, errs.length ? "完成（部分失败）" : "预览已就绪");
      setTimeout(clearProgress, 2000);

      const slidesWithImages = pageRecords.length;
      return {
        ok: !errs.length,
        phase: "preview-ready",
        total: slides.length,
        insertedCount: inserted.length,
        failedCount: errs.length,
        pendingImages,
        slidesWithImages,
        batchTag,
        inserted,
        errors: errs,
        message: (errs.length
          ? `共 ${slides.length} 页：${inserted.length} 页插入成功，${errs.length} 页失败。`
          : `预览已就绪：${inserted.length} 页已插入。`)
          + (pendingImages ? ` ${pendingImages} 张配图正在后台生成，完成后自动替换对应页。` : "")
          + `\n撤销本次批量：在主 TaskPane 调 WpsAiHtmlPreview.undoBatch("${batchTag}")。`
      };
```

- [ ] **Step 7: 语法校验 + 跑相关测试**

Run: `node -c js/tools/presentation.js && node --test test/deck-seq-tag.test.js`
Expected: 语法无输出（成功），测试 3 个 PASS

- [ ] **Step 8: Commit**

```bash
git add plugin/js/tools/presentation.js plugin/test/deck-seq-tag.test.js
git commit -m "feat(ppt): full_deck 阶段一——占位版整套插入 + 唯一 seq tag + 立即返回"
```

---

### Task 3: 阶段二——后台异步生图 + 每页回填 replace

**Files:**
- Modify: `plugin/js/tools/deck-staging.js`（新增 `runImageBackfill` 编排器）
- Modify: `plugin/test/deck-staging.test.js`（新增 `runImageBackfill` 测试）
- Modify: `plugin/js/tools/presentation.js`（handler 阶段一 return 之前启动后台任务；更新工具 description 说明 `data-gen-prompt`）

**Interfaces:**
- Consumes: `global.WpsAiDeckStaging.{fillImages, buildPlaceholderDataUrl, makeLimiter, makeImageTracker}`（Task 1）；`findSlideIndexBySeqTag`（Task 2）；`global.WpsAiImage.generateImage`、`global.WpsAiImageAssets.ensureLocalImagePath`、`global.WpsAiProviderRegistry.getImageConfig`、`global.WpsAiHtmlCache.update`、`renderAndInsertSlide`、`getPresentation`。
- Produces: `global.WpsAiDeckStaging.runImageBackfill(opts) → Promise<{ pagesReplaced, imagesOk, imagesFailed, skipped }>`
  - `opts = { pages, concurrency, deps }`
  - `pages: Array<{ seq, cacheId, html, css, palette, templateName, layout, requests }>`（= Task 2 的 pageRecords，Task 3 会给 record 补 `cacheId`）
  - `deps = { generateImage(req)→Promise<string|null>, renderReplace({seq, cacheId, templateName, layout, html, css, palette})→Promise, reportProgress?(info) }`
  - 语义：对所有页所有 requests 以受限并发调 `deps.generateImage`；每页全部图片有结果后，用 `fillImages` 回填（成功→真实 URL；失败→“配图未生成”占位），调 `deps.renderReplace` 换该页；`renderReplace` 抛错则该页计入 `skipped`。
  - **缓存一致性**：阶段一插入时 `renderAndInsertSlide` 已把**占位版** HTML 存进「我的历史」缓存（返回 `cacheId`）。`deps.renderReplace` 在换页成功后须用真实图 HTML `update(cacheId, ...)` 覆盖该缓存条目，否则历史里永远是占位图。

- [ ] **Step 1: 写失败测试**（追加到 `plugin/test/deck-staging.test.js` 末尾）

```js
test("runImageBackfill: 每页图齐后回填并 replace，成功/失败分别计数", async () => {
  const S = load();
  const pages = [
    { seq: 1, cacheId: "c1", html: '<img data-gen-id="g0" data-gen-prompt="a"><img data-gen-id="g1" data-gen-prompt="b">',
      css: "", palette: {}, templateName: "studio", layout: "freeform",
      requests: [{ id: "g0", prompt: "a" }, { id: "g1", prompt: "b" }] },
    { seq: 2, cacheId: "c2", html: '<img data-gen-id="g0" data-gen-prompt="c">',
      css: "", palette: {}, templateName: "studio", layout: "freeform",
      requests: [{ id: "g0", prompt: "c" }] }
  ];
  const replaced = [];
  let genCalls = 0;
  const deps = {
    generateImage: async (req) => {
      genCalls += 1;
      if (req.prompt === "b") return null; // 模拟这张失败
      return "http://img/" + req.prompt + ".png";
    },
    renderReplace: async (info) => { replaced.push(info); },
    reportProgress: () => {}
  };
  const res = await S.runImageBackfill({ pages, concurrency: 2, deps });
  assert.strictEqual(genCalls, 3);
  assert.strictEqual(res.imagesOk, 2);
  assert.strictEqual(res.imagesFailed, 1);
  assert.strictEqual(res.pagesReplaced, 2);
  assert.strictEqual(res.skipped, 0);
  // 第1页：g0 用真实 URL，g1 失败→占位；cacheId 透传给 renderReplace（供缓存一致性更新）
  const p1 = replaced.find((r) => r.seq === 1);
  assert.strictEqual(p1.cacheId, "c1");
  assert.ok(p1.html.includes('src="http://img/a.png"'));
  assert.ok(p1.html.includes("data:image/svg+xml,"), "失败的 g1 用了占位");
});

test("runImageBackfill: renderReplace 抛错的页计入 skipped 且不影响其它页", async () => {
  const S = load();
  const pages = [
    { seq: 1, html: '<img data-gen-id="g0" data-gen-prompt="a">', css: "", palette: {}, templateName: "studio", layout: "freeform", requests: [{ id: "g0", prompt: "a" }] },
    { seq: 2, html: '<img data-gen-id="g0" data-gen-prompt="b">', css: "", palette: {}, templateName: "studio", layout: "freeform", requests: [{ id: "g0", prompt: "b" }] }
  ];
  const deps = {
    generateImage: async () => "http://img/x.png",
    renderReplace: async (info) => { if (info.seq === 1) throw new Error("页没了"); }
  };
  const res = await S.runImageBackfill({ pages, concurrency: 2, deps });
  assert.strictEqual(res.pagesReplaced, 1);
  assert.strictEqual(res.skipped, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/deck-staging.test.js`
Expected: FAIL（`runImageBackfill is not a function`）

- [ ] **Step 3: 实现 `runImageBackfill`**（加到 `deck-staging.js`，在 `global.WpsAiDeckStaging = {...}` 导出之前）

```js
  // 阶段二编排器：对所有页的图片请求受限并发生成，每页图齐后回填 + replace。
  // 纯编排，COM 与生图都经 deps 注入，便于单测。
  async function runImageBackfill(opts) {
    const { pages, concurrency, deps } = opts || {};
    const list = Array.isArray(pages) ? pages : [];
    const run = makeLimiter(concurrency || 3);
    const tracker = makeImageTracker(list.map((p) => ({ seq: p.seq, ids: (p.requests || []).map((r) => r.id) })));
    const pageBySeq = new Map(list.map((p) => [p.seq, p]));
    let imagesOk = 0, imagesFailed = 0, pagesReplaced = 0, skipped = 0;

    const jobs = [];
    for (const page of list) {
      for (const req of (page.requests || [])) {
        jobs.push(run(async () => {
          let url = null;
          try { url = await deps.generateImage(req); } catch (e) { url = null; }
          if (url) imagesOk += 1; else imagesFailed += 1;
          const done = tracker.record(page.seq, req.id, url);
          if (!done) return;
          const p = pageBySeq.get(done.seq);
          const finalById = {};
          for (const id of Object.keys(done.urlById)) {
            finalById[id] = done.urlById[id] || buildPlaceholderDataUrl(p.palette, "配图未生成");
          }
          const filled = fillImages(p.html, finalById);
          try {
            await deps.renderReplace({
              seq: p.seq, cacheId: p.cacheId, templateName: p.templateName, layout: p.layout,
              html: filled, css: p.css, palette: p.palette
            });
            pagesReplaced += 1;
          } catch (e) {
            skipped += 1;
          }
          try { deps.reportProgress && deps.reportProgress({ pagesReplaced, imagesOk, imagesFailed }); } catch (e) {}
        }));
      }
    }
    await Promise.all(jobs);
    return { pagesReplaced, imagesOk, imagesFailed, skipped };
  }
```

在导出对象里加上 `runImageBackfill`：

```js
  global.WpsAiDeckStaging = {
    collectImageRequests, applyPlaceholders, fillImages,
    buildPlaceholderDataUrl, makeLimiter, makeImageTracker, runImageBackfill
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/deck-staging.test.js`
Expected: PASS（Task 1 的 9 个 + 本任务 2 个 = 11 个全绿）

- [ ] **Step 5a: 给阶段一 record 补 cacheId**

Task 2 的阶段一循环里，插入成功后把 record 推入 `pageRecords` 的那行（当前是 `if (record) { record.slideIndex = res.slide; pageRecords.push(record); }`）改为顺带记下缓存 id，供阶段二做缓存一致性更新：

```js
          if (record) { record.slideIndex = res.slide; record.cacheId = res.cacheId; pageRecords.push(record); }
```

（`renderAndInsertSlide` 在阶段一是默认 `saveToCache`，其返回值 `res.cacheId` 即刚写入的「我的历史」条目 id。）

- [ ] **Step 5b: 在 handler 阶段一 return 之前启动后台任务**

在 `wpp_render_full_deck` handler 里、Task 2 写的 `return { ... }` **之前**插入以下代码（`pageRecords`/`pendingImages`/`batchTag` 均已在阶段一就绪）：

```js
      // 阶段二：后台异步生图 + 回填。fire-and-forget，绝不 await，不阻塞返回。
      const imgReady = global.WpsAiProviderRegistry?.getImageConfig?.()?.enabled === true;
      let backfillLaunched = false;
      if (Staging?.runImageBackfill && pageRecords.length && imgReady) {
        backfillLaunched = true;
        const imgUI = global.WpsAiImageUI;
        Promise.resolve().then(() => Staging.runImageBackfill({
          pages: pageRecords,
          concurrency: 3,
          deps: {
            generateImage: async (req) => {
              const out = await global.WpsAiImage.generateImage({
                prompt: req.prompt, size: req.size, resolution: req.resolution, n: 1
              });
              const url = out && out[0] && out[0].url;
              if (!url) return null;
              // 落成本地文件再插，避免 WPS 远程下载失败
              return await global.WpsAiImageAssets?.ensureLocalImagePath?.(url) || url;
            },
            renderReplace: async (info) => {
              const presNow = await getPresentation();
              const idx = findSlideIndexBySeqTag(presNow, batchTag, info.seq);
              if (idx == null) throw new Error(`seq ${info.seq} 对应的页已不存在`);
              await renderAndInsertSlide({
                templateName: info.templateName, layout: info.layout,
                data: { html: info.html, css: info.css },
                palette: info.palette, slide: idx, intent: "replace",
                saveToCache: false, batchTag
              });
              // 缓存一致性：把「我的历史」里该条的占位 HTML 覆盖成真实图版本
              try { global.WpsAiHtmlCache?.update?.(info.cacheId, { data: { html: info.html, css: info.css } }); } catch (e) {}
            },
            reportProgress: (p) => {
              try { writeProgress(slides.length, `配图回填中：已完成 ${p.pagesReplaced}/${slidesWithImages} 页`); } catch (e) {}
              try { imgUI?.update?.({ label: `配图回填 ${p.pagesReplaced}/${slidesWithImages}` }); } catch (e) {}
            }
          }
        })).then((r) => {
          try { writeProgress(slides.length, "配图全部完成"); } catch (e) {}
          setTimeout(clearProgress, 2000);
          console.log("[full_deck] 阶段二完成:", r);
        }).catch((e) => {
          console.warn("[full_deck] 阶段二异常:", e?.message || e);
        });
      }
```

注意：`slidesWithImages` 变量在 return 段才定义——把它的定义 `const slidesWithImages = pageRecords.length;` 上移到这段后台任务之前（阶段二 `reportProgress` 要用）。同时在返回 message 里，当 `pendingImages && !imgReady` 时追加“未配置图像生成，已保留配图占位”。把 Task 2 的 return message 那行改为：

```js
        message: (errs.length
          ? `共 ${slides.length} 页：${inserted.length} 页插入成功，${errs.length} 页失败。`
          : `预览已就绪：${inserted.length} 页已插入。`)
          + (pendingImages
              ? (imgReady
                  ? ` ${pendingImages} 张配图正在后台生成，完成后自动替换对应页。`
                  : ` 检测到 ${pendingImages} 处配图占位，但未配置/未启用图像生成，已保留占位。`)
              : "")
          + `\n撤销本次批量：在主 TaskPane 调 WpsAiHtmlPreview.undoBatch("${batchTag}")。`,
```

- [ ] **Step 6: 更新工具 description 说明图片槽位契约**

在 `wpp_render_full_deck` 的 `description` 数组里（约 2144-2178 行），在 freeform 说明附近追加两行，告诉 AI 用 `data-gen-prompt`：

```js
      "",
      "**配图分步生成**：freeform HTML 里需 AI 生成的图片，用 <img data-gen-prompt=\"图像描述\" data-gen-size=\"16:9\"> 声明（size/resolution 可选）。",
      "  工具会先用占位骨架把整套 deck 秒级插入供预览，再后台异步生成图片、每页图齐后自动替换。**不要**为了配图先去逐个调 generate_image 再拼 URL——直接在 HTML 里写 data-gen-prompt 即可。已有确定 URL 的图片照常写 src。",
```

- [ ] **Step 7: 语法校验 + 全量测试**

Run: `node -c js/tools/deck-staging.js && node -c js/tools/presentation.js && node --test`
Expected: 语法成功；全部测试 PASS（原有 50 + 新增 deck-staging 11 + deck-seq-tag 3 = 64）

- [ ] **Step 8: Commit**

```bash
git add plugin/js/tools/deck-staging.js plugin/test/deck-staging.test.js plugin/js/tools/presentation.js
git commit -m "feat(ppt): full_deck 阶段二——后台异步生图 + 每页回填 replace"
```

---

## 自查（Self-Review）

**Spec 覆盖：**
- 图片槽位契约（data-gen-prompt/size/resolution）→ Task 1 `collectImageRequests` + Task 3 description。
- 阶段一占位秒级插入 + 立即返回 → Task 2。
- 阶段二后台并发生图 + 每页齐了 replace → Task 3 `runImageBackfill` + handler 后台启动。
- 唯一 seq tag 定位、防漂移、找不到跳过 → Task 2 `findSlideIndexBySeqTag` + Task 3 renderReplace。
- 单图失败保留“配图未生成”占位、不拖垮全局 → Task 3 `runImageBackfill`（finalById 兜底）。
- 图像生成未启用则跳过阶段二 → Task 3 `imgReady` 判定 + message。
- 后台异常吞掉不冒泡 → Task 3 `.catch` + 内层 try/catch。
- 并发默认 3 → Task 3。
- 只改 full_deck、不动单页、不引 DOMParser → 全程遵守。
- 缓存一致性（历史里占位版被真实图覆盖）→ Task 3 Step 5a 给 record 补 `cacheId` + renderReplace 内 `WpsAiHtmlCache.update`。
- 测试脱离 COM → Task 1/3 纯函数测；Task 2 用 mock pres。

**占位符扫描：** 无 TBD/TODO；每个改码步骤含完整代码。

**类型一致性：** `pageRecords` 字段（seq/slideIndex/cacheId/templateName/layout/html/css/palette/requests）在 Task 2 产出（cacheId 由 Task 3 Step 5a 补）、Task 3 `runImageBackfill` 的 `pages` 消费，字段名一致；`runImageBackfill` 的 `deps.renderReplace(info)` 里 `info.{seq,cacheId,templateName,layout,html,css,palette}` 与 handler 注入实现一致；`findSlideIndexBySeqTag(pres,batchTag,seq)` 签名在 Task 2 定义、Task 3 调用一致。
