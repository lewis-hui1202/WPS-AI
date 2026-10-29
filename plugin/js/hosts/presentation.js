(function attachPresentationHost(global) {
  "use strict";

  async function getApp() {
    return global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
  }

  async function getActivePresentation() {
    const app = await getApp();
    return app?.ActivePresentation || null;
  }

  async function ensurePresentation() {
    const pres = await getActivePresentation();
    if (!pres) throw new Error("未检测到打开的 WPS 演示。");
    return pres;
  }

  async function getActiveWindow() {
    const app = await getApp();
    return app?.ActiveWindow || null;
  }

  async function getSelection() {
    const win = await getActiveWindow();
    return win?.Selection || null;
  }

  // COM 对象的属性访问本身可能抛异常（选区类型不匹配时 ShapeRange/SlideRange 直接 throw，
  // 可选链 ?. 挡不住），必须用 try/catch 包裹，否则后面的兜底逻辑走不到。
  function safeShapeRange(sel) {
    try { return sel?.ShapeRange || null; } catch (error) { return null; }
  }

  function safeSlideRangeItem1(sel) {
    try {
      const sr = sel?.SlideRange;
      return sr?.Item ? sr.Item(1) : null;
    } catch (error) { return null; }
  }

  async function getCurrentSlide() {
    const sel = await getSelection();
    const view = safeSlideRangeItem1(sel);
    if (view) return view;
    const win = await getActiveWindow();
    if (win?.View?.Slide) return win.View.Slide;
    const pres = await ensurePresentation();
    return pres.Slides?.Item?.(1) || null;
  }

  function readShapeText(shape) {
    try {
      if (!shape?.HasTextFrame) return "";
      const frame = shape.TextFrame;
      const range = frame?.TextRange;
      const text = range?.Text || "";
      return String(text);
    } catch (error) {
      return "";
    }
  }

  function readSlideText(slide, withHeader = false) {
    if (!slide) return "";
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    const items = [];
    for (let i = 1; i <= count; i += 1) {
      const shape = shapes.Item(i);
      const text = readShapeText(shape).trim();
      if (text) {
        const geometry = {};
        try { geometry.top = shape.Top; } catch (e) {}
        try { geometry.left = shape.Left; } catch (e) {}
        items.push({ index: i, text, geometry });
      }
    }
    const body = (global.WpsAiPresentationOrder?.sort(items) || items).map((item) => item.text).join("\n");
    if (!withHeader) return body;
    const idx = slide.SlideIndex || slide.Index || "";
    return `# Slide ${idx}\n${body}`;
  }

  async function readSelectedShapesText() {
    const sel = await getSelection();
    const shapeRange = safeShapeRange(sel);
    const count = shapeRange?.Count || 0;
    if (!count) return "";
    const lines = [];
    for (let i = 1; i <= count; i += 1) {
      const text = readShapeText(shapeRange.Item(i)).trim();
      if (text) lines.push(text);
    }
    return lines.join("\n");
  }

  async function readSlideAtCursor() {
    const slide = await getCurrentSlide();
    return readSlideText(slide).trim();
  }

  async function readPresentationText() {
    const pres = await ensurePresentation();
    const slides = pres.Slides;
    const count = slides?.Count || 0;
    const buffers = [];
    for (let i = 1; i <= count; i += 1) {
      buffers.push(readSlideText(slides.Item(i), true).trim());
    }
    return buffers.filter(Boolean).join("\n\n");
  }

  async function readSelectionText() {
    const text = await readSelectedShapesText();
    if (text) return text.trim();
    return readSlideAtCursor();
  }

  async function readDocumentText() {
    return readPresentationText();
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    if (scope === "slide") return readSlideAtCursor();
    return readPresentationText();
  }

  function pickWritableShape(slide) {
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    for (let i = 1; i <= count; i += 1) {
      const shape = shapes.Item(i);
      try {
        if (shape.HasTextFrame) return shape;
      } catch (error) { /* skip */ }
    }
    return null;
  }

  // mode = "replace" 整体覆盖形状文字；"append" 在原文末尾追加（insert 的正确语义）。
  function applyTextToShape(shape, text, mode) {
    const range = shape.TextFrame.TextRange;
    if (mode === "append") {
      if (typeof range.InsertAfter === "function") range.InsertAfter(text);
      else range.Text = String(range.Text || "") + text;
    } else {
      range.Text = text;
    }
  }

  async function writeToTextFrame(text, mode = "replace") {
    if (!text) throw new Error("没有可写入的文本。");

    const sel = await getSelection();
    const shapeRange = safeShapeRange(sel);
    if (shapeRange?.Count > 0) {
      const shape = shapeRange.Item(1);
      try {
        if (shape.HasTextFrame) {
          applyTextToShape(shape, text, mode);
          return;
        }
      } catch (error) { /* fallthrough */ }
    }

    const slide = await getCurrentSlide();
    if (!slide) throw new Error("未检测到当前幻灯片。");
    const shape = pickWritableShape(slide);
    if (!shape) throw new Error("当前幻灯片没有可写入文字的形状。");
    applyTextToShape(shape, text, mode);
  }

  async function insertText(text) {
    return writeToTextFrame(text, "append");
  }

  async function replaceSelectionText(text) {
    return writeToTextFrame(text, "replace");
  }

  function getScopeOptions() {
    return [
      { value: "selection", label: "当前选中形状" },
      { value: "slide", label: "当前幻灯片" },
      { value: "presentation", label: "整个演示文稿" }
    ];
  }

  // 读取所有幻灯片的批注：slide.Comments 集合。返回 [{slide(页号), author, text}]
  async function readComments() {
    const pres = await ensurePresentation();
    const slides = pres.Slides;
    const sc = Number(slides && slides.Count) || 0;
    const clip = (t, n) => { const s = String(t == null ? "" : t).replace(/[\r\n\x07\t]+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
    const sg = (obj, prop) => { try { return obj ? obj[prop] : undefined; } catch (e) { return undefined; } };
    const out = [];
    for (let s = 1; s <= sc; s += 1) {
      let slide;
      try { slide = slides.Item(s); } catch (e) { continue; }
      let comments;
      try { comments = slide.Comments; } catch (e) { comments = null; }
      const cc = Number(sg(comments, "Count")) || 0;
      for (let i = 1; i <= cc; i += 1) {
        try {
          const c = comments.Item(i);
          out.push({ slide: s, author: clip(sg(c, "Author"), 60), text: clip(sg(c, "Text"), 500) });
        } catch (e) {}
      }
    }
    return { total: out.length, comments: out };
  }

  // FullName 派生同名 .pdf；未保存返回 null
  function derivePdfPath(fullName) {
    const s = String(fullName || "");
    if (!s || !/[\\/]/.test(s)) return null;
    return s.replace(/\.[^.\\/]+$/, "") + ".pdf";
  }

  // 给某页加批注：Slide.Comments.Add(Left, Top, Author, AuthorInitials, Text)。COM 需真机验。
  async function addComment(slideIndex, text, author) {
    if (!text) throw new Error("批注内容不能为空。");
    const pres = await ensurePresentation();
    const slides = pres.Slides;
    const total = Number(slides && slides.Count) || 0;
    let idx = Number(slideIndex) > 0 ? Number(slideIndex) : 1;
    if (total && idx > total) idx = total;
    const slide = slides.Item(idx);
    const a = author || "AI";
    const initials = String(a).slice(0, 2);
    slide.Comments.Add(12, 12, a, initials, String(text));
    return { slide: idx, applied: true };
  }

  async function exportToPdf(path) {
    const pres = await ensurePresentation();
    const out = path || derivePdfPath(pres.FullName);
    if (!out) throw new Error("演示尚未保存到磁盘，请先保存或显式传 path。");
    // ppFixedFormatTypePDF = 2
    try { pres.ExportAsFixedFormat(out, 2); }
    catch (e) { pres.SaveAs(out, 32 /*ppSaveAsPDF*/); }
    return { path: out, applied: true };
  }

  // ---- 动画 / 形状对齐 / 文档属性 / 另存 / 打印（第一二梯队）----
  const MSO_ANIM_EFFECT = { appear: 1, flyIn: 2, blinds: 3, checkerboard: 5, dissolve: 9, fade: 10, peek: 12, randomBars: 14, spiral: 15, split: 16, strips: 18, wedge: 20, wheel: 21, wipe: 22, zoom: 23, bounce: 26 };
  const MSO_ANIM_TRIGGER = { onClick: 1, withPrevious: 2, afterPrevious: 3 };

  async function addAnimation(opts = {}) {
    const pres = await ensurePresentation();
    const idx = Number(opts.slide) > 0 ? Number(opts.slide) : 1;
    const slide = pres.Slides.Item(idx);
    const si = Number(opts.shapeIndex) > 0 ? Number(opts.shapeIndex) : 1;
    const shape = slide.Shapes.Item(si);
    const seq = slide.TimeLine.MainSequence;
    const effect = MSO_ANIM_EFFECT[opts.effect] || 1;
    const eff = seq.AddEffect(shape, effect);
    if (opts.trigger && MSO_ANIM_TRIGGER[opts.trigger]) { try { eff.Timing.TriggerType = MSO_ANIM_TRIGGER[opts.trigger]; } catch (e) {} }
    return { slide: idx, shape: si, effect: opts.effect || "appear", applied: true };
  }

  async function alignShapes(opts = {}) {
    const pres = await ensurePresentation();
    const idx = Number(opts.slide) > 0 ? Number(opts.slide) : 1;
    const slide = pres.Slides.Item(idx);
    const range = slide.Shapes.Range(); // 全部形状
    const relToSlide = opts.relativeTo === "slide" ? -1 : 0; // msoTrue=-1 相对幻灯片；0 相对彼此
    const ALIGN = { left: 0, center: 1, right: 2, top: 3, middle: 4, bottom: 5 }; // msoAlignLefts..Bottoms
    const DIST = { horizontal: 0, vertical: 1 };
    if (opts.align && ALIGN[opts.align] != null) { range.Align(ALIGN[opts.align], relToSlide); }
    else if (opts.distribute && DIST[opts.distribute] != null) { range.Distribute(DIST[opts.distribute], relToSlide); }
    else throw new Error("需要 align 或 distribute");
    return { slide: idx, applied: true };
  }

  const WPP_DOC_PROP_KEYS = { title: "Title", author: "Author", subject: "Subject", keywords: "Keywords", comments: "Comments", category: "Category", manager: "Manager", company: "Company" };
  async function docProperties(setObj) {
    const pres = await ensurePresentation();
    const props = pres.BuiltInDocumentProperties;
    if (setObj && typeof setObj === "object") {
      for (const [k, v] of Object.entries(setObj)) {
        const name = WPP_DOC_PROP_KEYS[k];
        if (name && v != null) { try { props.Item(name).Value = String(v); } catch (e) {} }
      }
    }
    const out = {};
    for (const [k, name] of Object.entries(WPP_DOC_PROP_KEYS)) {
      try { out[k] = String(props.Item(name).Value == null ? "" : props.Item(name).Value); } catch (e) { out[k] = ""; }
    }
    return { properties: out };
  }

  async function saveAs(opts = {}) {
    const pres = await ensurePresentation();
    if (!opts.path) throw new Error("需要 path");
    const FMT = { pptx: 24, ppt: 1, pdf: 32, png: 18, jpg: 17 }; // ppSaveAsOpenXMLPresentation=24 / Presentation=1 / PDF=32 / PNG=18 / JPG=17
    pres.SaveAs(opts.path, FMT[opts.format] == null ? 24 : FMT[opts.format]);
    return { path: opts.path, format: opts.format || "pptx", applied: true };
  }

  async function printPres() {
    const pres = await ensurePresentation();
    pres.PrintOut();
    return { applied: true };
  }

  // ---- 分节 / 形状动作 / 媒体（第三梯队）----
  async function addSection(opts = {}) {
    const pres = await ensurePresentation();
    const before = Number(opts.beforeSlide) > 0 ? Number(opts.beforeSlide) : 1;
    const name = String(opts.name || "新节");
    // SectionProperties.AddBeforeSlide(SlideIndex, SectionName)
    pres.SectionProperties.AddBeforeSlide(before, name);
    return { name, beforeSlide: before, applied: true };
  }

  async function setAction(opts = {}) {
    const pres = await ensurePresentation();
    const si = Number(opts.slide) > 0 ? Number(opts.slide) : 1;
    const slide = pres.Slides.Item(si);
    const shape = slide.Shapes.Item(Number(opts.shapeIndex) > 0 ? Number(opts.shapeIndex) : 1);
    const as = shape.ActionSettings.Item(1); // ppMouseClick=1
    if (opts.url) {
      as.Action = 7; // ppActionHyperlink
      as.Hyperlink.Address = String(opts.url);
    } else if (Number(opts.jumpToSlide) > 0) {
      as.Action = 7;
      try { as.Hyperlink.Address = ""; } catch (e) {}
      as.Hyperlink.SubAddress = String(Number(opts.jumpToSlide));
    } else {
      throw new Error("需要 url 或 jumpToSlide");
    }
    return { slide: si, applied: true };
  }

  async function addMedia(opts = {}) {
    if (!opts.path) throw new Error("需要 path（音视频文件路径）");
    const pres = await ensurePresentation();
    const si = Number(opts.slide) > 0 ? Number(opts.slide) : 1;
    const slide = pres.Slides.Item(si);
    const L = Number.isFinite(opts.left) ? opts.left : 100;
    const T = Number.isFinite(opts.top) ? opts.top : 100;
    const W = Number.isFinite(opts.width) ? opts.width : -1;
    const H = Number.isFinite(opts.height) ? opts.height : -1;
    // Shapes.AddMediaObject2(FileName, LinkToFile=msoFalse(0), SaveWithDocument=msoTrue(-1), Left, Top, Width, Height)
    slide.Shapes.AddMediaObject2(String(opts.path), 0, -1, L, T, W, H);
    return { slide: si, applied: true };
  }

  // ---- SmartArt / 视图（A 组）----
  async function addSmartArt(opts = {}) {
    const app = await getApp();
    const pres = await ensurePresentation();
    const si = Number(opts.slide) > 0 ? Number(opts.slide) : 1;
    const slide = pres.Slides.Item(si);
    const li = Number(opts.layoutIndex) > 0 ? Number(opts.layoutIndex) : 1;
    const layout = app.SmartArtLayouts.Item(li); // 需 Application 暴露 SmartArtLayouts
    const L = Number.isFinite(opts.left) ? opts.left : 100;
    const T = Number.isFinite(opts.top) ? opts.top : 100;
    const W = Number.isFinite(opts.width) ? opts.width : 400;
    const H = Number.isFinite(opts.height) ? opts.height : 300;
    const shape = slide.Shapes.AddSmartArt(layout, L, T, W, H);
    if (Array.isArray(opts.items) && opts.items.length) {
      try {
        const nodes = shape.SmartArt.AllNodes;
        const n = Number(nodes && nodes.Count) || 0;
        for (let i = 0; i < opts.items.length && i < n; i += 1) {
          try { nodes.Item(i + 1).TextFrame2.TextRange.Text = String(opts.items[i]); } catch (e) {}
        }
      } catch (e) {}
    }
    return { slide: si, layoutIndex: li, applied: true };
  }

  async function setView(opts = {}) {
    const app = await getApp();
    await ensurePresentation();
    const win = app.ActiveWindow;
    if (Number(opts.zoom) > 0) { try { win.View.Zoom = Number(opts.zoom); } catch (e) {} }
    if (Number(opts.gotoSlide) > 0) { try { win.View.GotoSlide(Number(opts.gotoSlide)); } catch (e) {} }
    return { applied: true };
  }

  global.WpsAiHostPresentation = {
    host: "wpp",
    label: "WPS 演示",
    readComments,
    addComment,                  // 给某页加批注
    exportToPdf,                 // 导出为 PDF
    addAnimation,                // 给形状加动画
    alignShapes,                 // 形状对齐/分布
    docProperties,               // 文档属性读写
    saveAs,                      // 另存为
    printPres,                   // 打印
    addSection,                  // 幻灯片分节
    setAction,                   // 形状点击动作/超链接
    addMedia,                    // 插入音视频
    addSmartArt,                 // 插入 SmartArt
    setView,                     // 视图缩放/定位
    readSelectionText,
    readDocumentText,
    readByScope,
    insertText,
    replaceSelectionText,
    getScopeOptions,
    _internal: {
      getApp,
      getActivePresentation,
      getCurrentSlide,
      readSlideText,
      readShapeText,
      writeToTextFrame
    }
  };
})(window);
