# 分步生成 PPT（配图异步）设计

**日期：** 2026-07-02
**状态：** 已批准，待编写实现计划

## 目标

改造 `wpp_render_full_deck`，让整套 PPT 生成分两步：

1. **阶段一（同步，秒级）**：一次调用即把全部幻灯片**带图片占位骨架**插入到 WPS（用户立刻在演示里看到完整结构 = 预览），工具随即返回。
2. **阶段二（后台，异步，不阻塞返回）**：并发生成图片；每页图片全部就绪后，用真实图片回填并 `replace` 换掉该页整页 PNG。

核心约束：工具在阶段一插完就返回，**绝不阻塞在生图上**。生图慢（toapis / GPT-Image-2 异步轮询），不能让它挡住预览。

## 背景（现状）

- `wpp_render_full_deck`：AI 规划 N 张 freeform 幻灯片（每条 `{ templateName:'studio', layout:'freeform', data:{ html, css } }`）。
- 每页经 `renderAndInsertSlide` → `HtmlTpl.renderToPng`（html2canvas 把 HTML+CSS 截成**一张扁平 PNG**）→ 上传本地代理 → `AddPicture` 整页作为一张图片插入。
- 幻灯片里的图片是 HTML 中的 `<img src>`；AI 配图来自 `generate_image` 工具（异步轮询，**慢**）。
- 现状问题：AI 必须先把所有图片生成完（阻塞），再渲染 deck，所有页面在图片全好之前都不出现。

## 设计决策（已与用户确认）

| 决策点 | 选择 |
| --- | --- |
| 编排方式 | **工具内部自动**：改造现有 `wpp_render_full_deck`，AI 只调一次，占位/生图/回填全在工具内部完成 |
| 图片槽位声明 | **`<img>` 标记属性**：`data-gen-prompt` / `data-gen-size` / `data-gen-resolution` |
| 重渲染粒度 | **整页图片齐了再渲**：一页所有图就绪后只 replace 一次 |

## 1. 图片槽位契约

AI 在 freeform HTML 里用标记属性声明需异步生成的图片：

```html
<img data-gen-prompt="未来城市天际线，黄昏" data-gen-size="16:9" data-gen-resolution="2K" class="hero">
```

- **带 `data-gen-prompt` 的 `<img>`** → 进入分步流程；其 `src` 可留空或写占位，工具会覆盖。
- **不带 `data-gen-prompt` 的普通 `<img>`**（已有 https / dataUrl / 本地路径）→ 照旧直接渲染，不受本特性影响。
- `data-gen-size`（默认由 `generate_image` 依 prompt 判定，见其 enum）、`data-gen-resolution`（`1K`/`2K`/`4K`，可选）透传给 `generate_image`。

工具扫描每页 HTML，收集所有带 `data-gen-prompt` 的 `<img>`，组成该页的**图片请求列表** `[{ marker, prompt, size?, resolution? }]`。

## 2. 两阶段渲染流程

### 阶段一（同步）

对每页：
1. 解析 HTML，把每个带 `data-gen-prompt` 的 `<img>` 的 `src` 替换为**骨架占位图**（内联 dataURL SVG：`surfaceColor` 底 + 线性图片图标 + “AI 配图生成中…”字样），保留原有 class/style/尺寸；其余 HTML 原样。
2. 走现有 `renderAndInsertSlide` 管线渲染并插入（`intent` 默认 insert）。
3. 记录该页 `{ seq, slideIndex, batchTag, imageRequests, htmlOriginal, css, palette, templateName, layout }`。

全部插完后**立即返回**：

```js
{
  ok: true,
  phase: "preview-ready",
  insertedCount, total, batchTag,
  pendingImages,          // 待生成图片总数
  slidesWithImages,       // 有待生成图片的页数
  message: "预览已就绪（N 页已插入）。M 张配图正在后台生成，完成后会自动替换对应页。"
}
```

AI 据此告知用户“预览已就绪，配图生成中”，本轮结束。

### 阶段二（后台，异步）

阶段一返回后，用一个**不被 await 的后台任务**继续：

1. 汇总所有页的图片请求，以**受限并发（默认 3）** 调 `generate_image({ prompt, size, resolution })`。
2. 每页维护"已就绪图片数 / 该页图片总数"计数。**某页所有图片就绪**时：
   - 用真实图片 URL（`ensureLocalImagePath` 落地后）回填该页 `htmlOriginal` 中对应 `<img>` 的 `src`。
   - 调 `renderAndInsertSlide({ templateName, layout, data:{ html:filledHtml, css }, palette, slide:<定位到的页>, intent:"replace", saveToCache:false, batchTag })` 换掉整页 PNG。
3. 进度经现有 `PROGRESS_KEY`（localStorage）+ 生图面板 `WpsAiImageUI` 上报。

## 3. 定位要替换的页

阶段一插入时，除现有的 `LingxiBatch`=`batchTag` tag 外，**给每页再打一个唯一 tag**：`LingxiBatchSeq`=`<batchTag>:<seq>`（seq 为该页在本批次内的 1-based 序号），并记录 `slideIndex`。阶段二 replace 时：

1. **优先扫描全部幻灯片，按精确 `LingxiBatchSeq == <batchTag>:<seq>` 反查当前真实 slide 位置**——每页有唯一 tag，对用户中途增删页 / 重排都稳（不靠 index）。
2. 反查失败时回退用记录的 `slideIndex`。
3. 目标页已被用户删除 / 找不到 → **跳过并计入 skipped，不报错**。

> 现有 `renderAndInsertSlide` 只接受 `slide`（index）参数，不认 tag。反查（tag → 当前 index）由 handler 内新增的辅助函数完成，再把解析出的 index 传给 `renderAndInsertSlide`。

## 4. 失败与降级

- **单图生成失败** → 该槽保留占位骨架（caption 改为“配图未生成”），该页其它图正常，不使整个 deck 失败。若该页尚有其它图待生成，仍按“全部有结果（成功或失败）”触发一次回填重渲。
- **图像生成未启用 / 未配置**（`getImageConfig` 缺 baseUrl/apiKey/未启用）→ 阶段一照常出带占位的 deck，阶段二**整体跳过**，返回信息附“未配置图像生成，已保留配图占位”。
- **阶段二找不到目标页** → 跳过并计入 skipped。
- 后台任务内部异常一律 try/catch 吞掉并记日志，绝不能让未捕获的 Promise 拒绝影响主 TaskPane。

## 5. 并发与幂等

- 图片生成用受限并发（默认 3），避免同时打爆生图 API。
- 后台任务按 `batchTag` 归组；重复生成新 deck 用新 `batchTag` 隔离，互不干扰。

## 6. 模块划分

新增纯函数模块，便于单测、与 COM 解耦：

- `collectImageRequests(html)` → `{ requests: [{ marker, prompt, size, resolution }], slots }`：解析 HTML，找出带 `data-gen-prompt` 的 img。
- `applyPlaceholders(html, palette)` → `htmlWithPlaceholders`：把这些 img 的 src 换成骨架占位 dataURL。
- `fillImages(html, urlByMarker)` → `filledHtml`：把真实 URL 回填对应 img 的 src。
- `makeLimiter(concurrency)` → 并发限制器。
- 骨架占位 SVG 生成 `buildPlaceholderDataUrl(palette, caption)`。
- `findSlideIndexBySeqTag(pres, batchTag, seq)` → 扫描全部幻灯片，返回 `LingxiBatchSeq == <batchTag>:<seq>` 的当前 index（找不到返回 null）。涉及 COM，编排测试中 mock pres。

阶段一插入每页后，handler 追加写 `LingxiBatchSeq`=`<batchTag>:<seq>` tag（`renderAndInsertSlide` 已写 `LingxiBatch`=`batchTag`，此处补唯一 seq tag）。

`wpp_render_full_deck` handler 负责编排：阶段一循环 + 返回；阶段二 fire-and-forget 后台任务。`renderAndInsertSlide` / `generate_image` / COM 操作保持不变，被编排调用。

## 7. 测试（node:test + node:vm）

纯函数可脱离 WPS COM 测试：

- `collectImageRequests`：含多个 `data-gen-prompt` 的 HTML → 收集到正确的 `{prompt,size,resolution}` 列表；普通 `<img>`（无该属性）不被收集。
- `applyPlaceholders`：目标 img 的 src 被换成占位 dataURL，其它属性/元素不变；普通 img 不动。
- `fillImages`：按 marker 把 src 换成真实 URL；未提供 URL 的 marker 保持占位。
- “每页图片是否齐了”的计数/就绪判定逻辑。
- `makeLimiter`：并发不超过上限、全部完成、单个 reject 不拖垮其余。

`renderAndInsertSlide` / `generate_image` 在编排测试中用 mock（如需覆盖阶段二编排）。

## 范围（YAGNI）

- **本期只改 `wpp_render_full_deck`（整套生成）**。单页 `wpp_render_html_template` 的分步支持暂不做（用户单页 1-2 张，通常直接等图即可）。
- 不引入独立“预览弹窗”——阶段一插入到真实 PPT 本身即用户可见的预览。
- 占位样式先用一套固定骨架（surfaceColor + 图标 + 文案），不做可配置。
