(function attachPresentationTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const wpp = () => global.WpsAiHostPresentation;
  const internal = () => wpp()?._internal;
  const imageAssets = () => global.WpsAiImageAssets;

  // PpSlideLayout 枚举（来自 wpp-jsapi-declare），常用版式映射
  const LAYOUTS = {
    title: 1,                // 标题幻灯片
    text: 2,                 // 标题 + 内容
    twoColumn: 3,            // 双栏文本
    titleOnly: 11,           // 仅标题
    blank: 12,               // 空白
    sectionHeader: 33,       // 节标题
    comparison: 34,          // 对比
    contentWithCaption: 35,  // 内容+标题说明
    pictureWithCaption: 36   // 图片+标题说明
  };

  // MsoTriState
  const MSO = { TRUE: -1, FALSE: 0 };

  // 加固版 AddPicture：WPP 里 AddPicture 偶发返回 null（Interactive=false / 非法尺寸 / 瞬时 COM 抖动 /
  // 图片像素过大解不出位图）。先复位 Interactive、校验尺寸、重试一次，再兜底"原生尺寸插入后再设大小"。
  // 只增不减：首次成功就立刻返回，行为跟原来一致。
  function safeAddPicture(pres, slideObj, filePath, left, top, width, height) {
    try { const app = pres && pres.Application; if (app && app.Interactive === false) app.Interactive = true; } catch (e) {}
    const ok = (n) => typeof n === "number" && isFinite(n);
    const L = ok(left) ? left : 0, T = ok(top) ? top : 0;
    const W = ok(width) && width > 0 ? width : -1;   // -1 = 原生尺寸
    const H = ok(height) && height > 0 ? height : -1;
    const tryOnce = (w, h) => {
      try { return slideObj.Shapes.AddPicture(filePath, MSO.FALSE, MSO.TRUE, L, T, w, h) || null; }
      catch (e) { return null; }
    };
    let pic = tryOnce(W, H);
    if (!pic) pic = tryOnce(W, H);                    // 重试一次（瞬时抖动）
    if (!pic) {                                       // 兜底：先原生尺寸插入，再显式设大小（部分版本对显式尺寸会拒插）
      pic = tryOnce(-1, -1);
      if (pic) { try { if (W > 0) pic.Width = W; } catch (e) {} try { if (H > 0) pic.Height = H; } catch (e) {} }
    }
    return pic;
  }

  // 灵犀 PPT 设计宪法 — 集中定义在 registry.js（DESIGN_GUIDELINES），此处惰性读取。
  const getDesignGuidelines = () => global.WpsAiProviderRegistry?.DESIGN_GUIDELINES || [];

  // 单位换算：1 英寸 = 72 磅；slide 单位是磅（point）
  const POINT_PER_INCH = 72;

  function parseColor(input) {
    let s = String(input).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (s.length !== 6) throw new Error(`颜色格式错误：${input}`);
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    return (b << 16) | (g << 8) | r; // BGR
  }

  function readShapeText(shape) {
    try {
      if (!shape?.HasTextFrame) return "";
      return String(shape.TextFrame?.TextRange?.Text || "");
    } catch (e) { return ""; }
  }

  // MsoShapeType：13=Picture、19=Table、14=Placeholder、17=TextBox。
  function readShapeGeometry(shape) {
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
    const g = {};
    try { g.left = num(shape.Left); } catch (e) { g.left = null; }
    try { g.top = num(shape.Top); } catch (e) { g.top = null; }
    try { g.width = num(shape.Width); } catch (e) { g.width = null; }
    try { g.height = num(shape.Height); } catch (e) { g.height = null; }
    return g;
  }

  function listSlideShapes(slide, opts) {
    const maxChars = Math.floor(Number(opts && opts.maxChars) || 0);
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    const out = [];
    for (let i = 1; i <= count; i += 1) {
      const shape = shapes.Item(i);
      let text = "";
      try { text = readShapeText(shape); } catch (e) {}
      let textTruncated = false;
      if (maxChars > 0 && text.length > maxChars) { text = text.slice(0, maxChars); textTruncated = true; }
      let isPlaceholder = false;
      const placeholderType = safeGetPlaceholderType(shape);
      if (placeholderType !== undefined) isPlaceholder = true;
      // shape.Type 在 WPS 中：14 = msoPlaceholder
      let shapeType = null;
      try { shapeType = shape.Type; } catch (e) {}
      if (!isPlaceholder && shapeType === 14) isPlaceholder = true;
      out.push({
        index: i,
        name: shape.Name || `Shape${i}`,
        text,
        hasText: !!text,
        textTruncated,
        isPlaceholder,
        placeholderType,
        // 形状几何（points）与类型：布局理解 / 二次编辑用
        shapeType,
        isPicture: shapeType === 13,
        isTable: shapeType === 19,
        geometry: readShapeGeometry(shape),
        // 给 AI 看类型语义，方便 debug
        placeholderRole: placeholderType !== undefined
          ? (TITLE_PH_TYPES.has(placeholderType) ? "title"
              : BODY_PH_TYPES.has(placeholderType) ? "body"
              : SKIP_PH_TYPES.has(placeholderType) ? "skip"
              : "other")
          : null
      });
    }
    return global.WpsAiPresentationOrder?.sort(out) || out;
  }

  // 读某页演讲者备注（从 wpp_get_notes 抽出，供 includeNotes 复用）。
  function readSlideNotes(slideObj) {
    const notesPage = slideObj && slideObj.NotesPage;
    if (!notesPage) return "";
    const shapes = notesPage.Item ? notesPage.Item(1).Shapes : notesPage.Shapes;
    const count = shapes?.Count || 0;
    const buf = [];
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      try {
        if (sh.HasTextFrame && sh.PlaceholderFormat?.Type === 2) { // ppPlaceholderBody=2
          buf.push(String(sh.TextFrame.TextRange.Text || ""));
        }
      } catch (e) {}
    }
    if (buf.length === 0) {
      for (let i = 1; i <= count; i += 1) {
        const sh = shapes.Item(i);
        try {
          if (sh.HasTextFrame) {
            const txt = String(sh.TextFrame.TextRange.Text || "").trim();
            if (txt) buf.push(txt);
          }
        } catch (e) {}
      }
    }
    return buf.join("\n").trim();
  }

  async function getPresentation() {
    const pres = await internal().getActivePresentation();
    if (!pres) throw new Error("未检测到打开的 WPS 演示。");
    return pres;
  }

  // 模块级共享渲染管线：从 HTML 模板 → PNG → 上传 → 插入到 PPT → 写缓存。
  // 之前这段逻辑藏在 wpp_render_html_template 的 handler 闭包里，导致 fallback 路径必须重新走
  // 工具调用，参数解析顺序跟主路径不一致。提到模块级，主路径和 fallback 都直接调它，行为完全一致。
  //
  // params: { templateName, layout, data, palette, slide?, intent?, batchTag?, saveToCache? }
  //   intent: "insert" (默认) / "replace" / "replace-active"
  //   - replace 需要带 slide（hint 目标页）
  //   - replace-active 忽略 slide，强制用 ActiveWindow.View.Slide
  //   saveToCache: true（默认）→ 插入成功后写一条 cache；false 时不写（fallback 路径已经有缓存条目就传 false）
  // 修 #20: cache.save 统一放在这里，避免各调用点重复写（preview=false 单页 / wpp_render_full_deck 每页）。
  // dialog Save 按钮是另一个语义（用户主动覆盖编辑），仍走 cache.save/update。
  // 返回: { slide, template, layout, intent, slideWidth, slideHeight, picturePath, cacheId? }
  // 简易日志桥：app.js 暴露 WpsAiLog.log/warn 时跟着记，否则只落 console
  function _logI(tag, ...args) {
    try { global.WpsAiLog?.log?.(tag, ...args); } catch (e) {}
    try { console.log(`[lingxi-preview][TOOL][${tag}]`, ...args); } catch (e) {}
  }
  function _logW(tag, ...args) {
    try { global.WpsAiLog?.warn?.(tag, ...args); } catch (e) {}
    try { console.warn(`[lingxi-preview][TOOL][${tag}]`, ...args); } catch (e) {}
  }

  async function renderAndInsertSlide(params) {
    const { templateName, layout, data, palette } = params;
    const slide = params.slide;
    const intent = params.intent || "insert";
    const batchTag = params.batchTag || null;
    const saveToCache = params.saveToCache !== false; // 默认写缓存
    const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
    const splitLayers = params.splitLayers != null
      ? !!params.splitLayers
      : !!settings.splitLayersOnInsert;
    _logI("renderAndInsert.start", {
      templateName, layout,
      slide,
      intent,
      splitLayers,
      hasData: !!data,
      hasPalette: !!palette
    });
    const HtmlTpl = global.WpsAiHtmlTemplates;
    if (!HtmlTpl?.renderToPng) {
      throw new Error("HTML 模板模块未加载");
    }
    const pres = await getPresentation();
    const ps = pres.PageSetup;
    let w = 720, h = 540;
    try { if (ps?.SlideWidth) w = ps.SlideWidth; } catch (e) {}
    try { if (ps?.SlideHeight) h = ps.SlideHeight; } catch (e) {}

    // 修 B2：不再"先清空后渲染"。渲染 PNG / 上传本地代理很容易失败（proxy 未起等），
    // 若先清空，失败后原页就成了不可恢复的白板。改为：先快照旧形状引用，等新内容
    // 成功插入后再删除旧形状；插入失败则抛出，旧形状原样保留。
    let deferredOldShapes = null;
    const snapshotShapesForClear = (slideObj) => {
      const refs = [];
      try {
        const shapes = slideObj.Shapes;
        const cnt = shapes?.Count || 0;
        for (let i = 1; i <= cnt; i += 1) {
          try { refs.push(shapes.Item(i)); } catch (e) {}
        }
      } catch (e) {}
      deferredOldShapes = refs;
    };
    const flushDeferredClear = () => {
      if (!deferredOldShapes) return;
      for (const sh of deferredOldShapes) {
        try { sh.Delete(); } catch (e) {}
      }
      deferredOldShapes = null;
    };

    _logI("renderAndInsert.dims", `slide ${w}×${h} points; totalSlides=${pres.Slides?.Count}`);
    // 检查全局 Application.Interactive，doc-lock 把它设为 false 会导致 jsapi 操作 OK 但 UI 不刷新
    try {
      const appObj = pres?.Application;
      const interactive = appObj?.Interactive;
      const visible = appObj?.Visible;
      const winState = appObj?.WindowState;
      _logI("renderAndInsert.appState", { interactive, visible, winState });
      if (interactive === false) {
        appObj.Interactive = true;
        _logI("renderAndInsert.appState", "Interactive=false → 强制设回 true");
      }
    } catch (e) { _logW("renderAndInsert.appState", e?.message); }

    let slideObj;
    if (intent === "replace-active") {
      slideObj = getSlideAt(pres, 0);
      _logI("renderAndInsert.targetSlide", `intent=replace-active → got slide ${slideObj?.SlideIndex} (via getSlideAt(0))`);
      snapshotShapesForClear(slideObj);
    } else if (slide === undefined || slide === null) {
      const idx = (pres.Slides?.Count || 0) + 1;
      slideObj = pres.Slides.Add(idx, 12 /* blank */);
      _logI("renderAndInsert.targetSlide", `intent=${intent} no slide param → Added new slide ${slideObj?.SlideIndex}`);
    } else {
      slideObj = getSlideAt(pres, slide || 0);
      _logI("renderAndInsert.targetSlide", `intent=${intent} slide=${slide} → got slide ${slideObj?.SlideIndex}`);
      if (intent === "replace") {
        snapshotShapesForClear(slideObj);
      }
    }

    // 诊断 slide layout / background —— 用户 shape 完美但看不到, 可能是 master/layout
    // 的占位符或背景覆盖在 slide.Shapes 之上 (WPS 在某些场景里有这个问题)
    try {
      const lay = slideObj?.Layout;
      const layoutInfo = {
        layoutName: lay?.Name,
        followMasterBackground: slideObj?.FollowMasterBackground,
        displayMasterShapes: slideObj?.DisplayMasterShapes,
        masterShapeCount: slideObj?.Master?.Shapes?.Count,
        layoutShapeCount: lay?.Shapes?.Count,
        slideLayoutType: lay?.SlideLayout
      };
      _logI("renderAndInsert.slideMeta", layoutInfo);
      // 关键修复尝试：禁用 master shapes 显示 + 跟随 master 背景 → 排除 master/layout 覆盖
      try { slideObj.FollowMasterBackground = false; _logI("renderAndInsert.slideMeta", "FollowMasterBackground=false"); } catch (e) {}
      try { slideObj.DisplayMasterShapes = false; _logI("renderAndInsert.slideMeta", "DisplayMasterShapes=false"); } catch (e) {}
    } catch (e) { _logW("renderAndInsert.slideMeta", e?.message); }

    // === 分支 1：分图层模式 ===
    // 每个 .stage > * 子元素 + 一个背景层 → 各自一张 PNG → 各自 AddPicture。
    // 在 PPT 里看到的是 N 个独立 shape，可单独选中/移动/缩放。
    let layerInfo = null;
    let lastLocalPath = null;
    if (splitLayers && HtmlTpl.renderToLayers) {
      _logI("renderAndInsert.layered", "calling renderToLayers");
      try {
        layerInfo = await HtmlTpl.renderToLayers(templateName, layout, data || {}, palette || {}, { scale: 1 });
        _logI("renderAndInsert.layered", `renderToLayers returned ${layerInfo?.layers?.length} layers`);
      } catch (e) {
        _logW("renderAndInsert.layered", "renderToLayers THREW:", e?.message || e);
        layerInfo = null;
      }
    } else {
      _logI("renderAndInsert.layered", `skip (splitLayers=${splitLayers}, hasRenderToLayers=${!!HtmlTpl.renderToLayers})`);
    }

    // 跟踪本次实际成功插入了几张 shape，分别统计前景/背景。
    // 关键判断：背景成功 + 前景全失败 → slide 上只剩底色看着像"没图片"，
    // 此时也算 layered 失败，删掉残留并走单图兜底。
    let insertedFgCount = 0;
    let insertedBgCount = 0;
    const insertedShapes = [];
    const layerErrors = [];

    if (layerInfo && layerInfo.layers?.length) {
      const sx = w / layerInfo.width;   // stage 像素 → PPT points 缩放比
      const sy = h / layerInfo.height;
      // 按 DOM 顺序 AddPicture，PPT 里后插入的在上层 —— 跟 DOM 顺序天然一致
      for (let i = 0; i < layerInfo.layers.length; i += 1) {
        const layer = layerInfo.layers[i];
        if (!layer?.dataUrl || layer.dataUrl.length < 200) {
          const e = `dataUrl 空或过短 (${layer?.dataUrl?.length || 0} chars)`;
          layerErrors.push(`#${i} (${layer?.kind}): ${e}`);
          _logW("renderAndInsert.layer", `#${i} skip: ${e}`);
          continue;
        }
        const rawPx = layer.x * sx;
        const rawPy = layer.y * sy;
        const rawPw = layer.w * sx;
        const rawPh = layer.h * sy;
        const px = Math.max(0, Math.min(rawPx, w - 1));
        const py = Math.max(0, Math.min(rawPy, h - 1));
        const pw = Math.max(1, Math.min(rawPw, w - px));
        const ph = Math.max(1, Math.min(rawPh, h - py));
        let lp = null;
        try {
          lp = await uploadDataUrl(layer.dataUrl);
          lastLocalPath = lp;
          _logI("renderAndInsert.layer", `#${i} (${layer.kind}) upload OK → ${lp}; about to AddPicture @ ${px},${py} ${pw}×${ph}`);
          const shape = safeAddPicture(pres, slideObj, lp, px, py, pw, ph);
          if (!shape) throw new Error("AddPicture 返回 null");
          if (layer.kind === "background") {
            try { shape.ZOrder?.(1 /* msoSendToBack */); } catch (e) {}
            insertedBgCount += 1;
          } else {
            insertedFgCount += 1;
          }
          insertedShapes.push(shape);
          _logI("renderAndInsert.layer", `#${i} (${layer.kind}) OK shape inserted`);
        } catch (e) {
          const msg = e?.message || String(e);
          layerErrors.push(`#${i} (${layer.kind}) @ ${px},${py} ${pw}×${ph}: ${msg}`);
          _logW("renderAndInsert.layer", `#${i} (${layer.kind}) FAILED: ${msg} (lp=${lp})`);
        }
      }
      const layerCount = layerInfo.layers.length;
      const allOk = insertedFgCount + insertedBgCount === layerCount;
      const fgFullyFailed = insertedFgCount === 0 && layerCount > 1; // 不止背景层
      if (!allOk) {
        console.warn(`[renderAndInsertSlide] layered ${insertedFgCount + insertedBgCount}/${layerCount} 成功（前景 ${insertedFgCount}, 背景 ${insertedBgCount}）。失败明细：\n  ` + layerErrors.join("\n  "));
      }
      // 前景全失败 → 残留的 bg 只画了一块底色，看着像"没图片"。清掉重走单图。
      if (fgFullyFailed) {
        console.warn("[renderAndInsertSlide] 前景层全失败，删掉 layered 残留改走单图");
        insertedShapes.forEach((sh) => { try { sh.Delete?.(); } catch (e) {} });
        insertedShapes.length = 0;
        insertedFgCount = 0;
        insertedBgCount = 0;
      }
    }

    let totalInserted = insertedFgCount + insertedBgCount;
    if (totalInserted === 0) {
      _logI("renderAndInsert.singleImage", "entering single-image fallback");
      const dataUrl = await HtmlTpl.renderToPng(templateName, layout, data || {}, palette || {}, { scale: 1 });
      _logI("renderAndInsert.singleImage", `renderToPng returned ${dataUrl?.length || 0} chars`);
      if (!dataUrl || dataUrl.length < 200) {
        throw new Error("renderToPng 返回空 dataUrl，html2canvas 截图失败");
      }
      lastLocalPath = await uploadDataUrl(dataUrl);
      _logI("renderAndInsert.singleImage", `uploadDataUrl returned: ${lastLocalPath}`);
      if (!lastLocalPath) throw new Error("uploadDataUrl 没返回本地路径（proxy 是否在运行？）");
      _logI("renderAndInsert.singleImage", `calling AddPicture(slide ${slideObj?.SlideIndex}, 0,0, ${w}×${h})`);
      // 解锁文档 + 取消 Interactive=false（doc-lock 可能没复位，会阻塞 AddPicture 视觉效果）
      try {
        const app = pres?.Application;
        if (app?.Interactive === false) {
          app.Interactive = true;
          _logI("renderAndInsert.singleImage", "Application.Interactive=false → 强制设回 true");
        }
      } catch (e) {}
      const pic = safeAddPicture(pres, slideObj, lastLocalPath, 0, 0, w, h);
      if (!pic) {
        throw new Error(`AddPicture 返回 null。slide=${slideObj?.SlideIndex}, path=${lastLocalPath}`);
      }
      // 深度检查：AddPicture 返回成功但用户看不到图 → 把 shape 真实属性 dump 出来
      const shapeInfo = { name: pic?.Name };
      try { shapeInfo.left = pic.Left; } catch (e) { shapeInfo.leftErr = e?.message; }
      try { shapeInfo.top = pic.Top; } catch (e) { shapeInfo.topErr = e?.message; }
      try { shapeInfo.width = pic.Width; } catch (e) { shapeInfo.widthErr = e?.message; }
      try { shapeInfo.height = pic.Height; } catch (e) { shapeInfo.heightErr = e?.message; }
      try { shapeInfo.visible = pic.Visible; } catch (e) { shapeInfo.visibleErr = e?.message; }
      try { shapeInfo.type = pic.Type; } catch (e) { shapeInfo.typeErr = e?.message; }
      try { shapeInfo.zOrderPos = pic.ZOrderPosition; } catch (e) { shapeInfo.zOrderErr = e?.message; }
      _logI("renderAndInsert.singleImage", `AddPicture OK; shape:`, shapeInfo);
      try { pic.Visible = true; } catch (e) {}
      // BringToFront —— 即使我们是唯一 shape, 显式抬到 zorder 顶, 避开 slide layout 的 placeholder
      try { pic.ZOrder?.(0 /* msoBringToFront */); _logI("renderAndInsert.singleImage", "ZOrder BringToFront OK"); } catch (e) { _logW("renderAndInsert.singleImage", "ZOrder BringToFront failed:", e?.message); }
      // Select 一下迫使 WPS 把 shape 真的渲染出来
      try { pic.Select?.(); _logI("renderAndInsert.singleImage", "shape.Select() OK"); } catch (e) {}
      // 强制 doc dirty + 让 WPS 落盘内部状态（不真的存文件, 但触发刷新）
      try {
        const presObj = pres;
        if (presObj?.Saved !== undefined) {
          presObj.Saved = false;
          _logI("renderAndInsert.singleImage", "Presentation.Saved=false (强制 dirty 触发渲染)");
        }
      } catch (e) {}
      totalInserted = 1;
    }

    // 新内容已成功插入（totalInserted >= 1，否则上面早已抛出），此时才删除 replace 意图下的旧形状。
    flushDeferredClear();

    // 强制 WPS 重绘：AddPicture 后 WPS 偶尔不刷新 slide 视图，shape 已在 COM 里但用户看不到
    try {
      const app = pres?.Application;
      if (app?.ScreenRefresh) { app.ScreenRefresh(); _logI("renderAndInsert.repaint", "Application.ScreenRefresh OK"); }
      else if (app?.ScreenUpdating !== undefined) {
        const prev = app.ScreenUpdating;
        app.ScreenUpdating = false;
        app.ScreenUpdating = true;
        _logI("renderAndInsert.repaint", `ScreenUpdating toggled (prev=${prev})`);
      }
      // ActiveWindow 重新激活，强制刷新 slide pane
      const win = app?.ActiveWindow;
      if (win?.View?.GotoSlide) {
        win.View.GotoSlide(slideObj.SlideIndex);
        _logI("renderAndInsert.repaint", `View.GotoSlide(${slideObj.SlideIndex}) OK`);
      } else if (win?.Activate) {
        win.Activate();
        _logI("renderAndInsert.repaint", "ActiveWindow.Activate OK");
      }
    } catch (e) {
      _logW("renderAndInsert.repaint", "failed:", e?.message || String(e));
    }
    const insertedShapeCount = totalInserted;
    _logI("renderAndInsert.done", {
      slide: slideObj?.SlideIndex,
      insertedShapeCount,
      finalShapeCountOnSlide: slideObj?.Shapes?.Count
    });

    if (batchTag) {
      try { slideObj.Tags?.Add?.("LingxiBatch", batchTag); } catch (e) {}
    }
    // 修 #20: 单一缓存写入点。失败不阻塞插入结果。
    let cacheId = null;
    if (saveToCache) {
      try {
        // docKey = 当前 PPT 的 FullName（含路径）；切到别的 PPT 时该条历史不再显示
        let docKey = "";
        try { docKey = String(pres.FullName || pres.Name || "").trim(); } catch (e) {}
        const saved = global.WpsAiHtmlCache?.save?.({
          templateName, layout, data: data || {}, palette,
          slideHint: slideObj.SlideIndex,
          batchTag: batchTag || null,
          docKey
        });
        cacheId = saved?.id || null;
      } catch (e) { /* 缓存失败不阻塞 */ }
    }
    return {
      slide: slideObj.SlideIndex,
      template: templateName,
      layout,
      intent,
      slideWidth: w,
      slideHeight: h,
      picturePath: lastLocalPath,
      layerCount: insertedShapeCount,
      cacheId
    };
  }
  // 暴露：app.js 的 fallbackInsertFromState 直接调它，跟工具主路径走同一条管线
  global.WpsAiRenderAndInsertSlide = renderAndInsertSlide;

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
  global.WpsAiRenderDeckInternals = { findSlideIndexBySeqTag };

  function getSlideAt(pres, index) {
    if (!index) {
      // 0 / 未传 → 当前幻灯片
      const win = pres.Application?.ActiveWindow;
      if (win?.View?.Slide) return win.View.Slide;
      return pres.Slides.Item(1);
    }
    const slide = pres.Slides.Item(index);
    if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
    return slide;
  }

  // 取"生效的 stylePreset"。enabled !== true 时返回空对象，让所有 ||fallback 默认值生效。
  // 解决 bug：之前直接读 settings.stylePreset 不看 enabled，用户取消勾选「启用统一样式」后
  // 保存的色板/字体仍会被注入到 HTML 模板和直写工具，"未启用"形同虚设。
  // 凡是要让"未勾选 = 不应用"的工具入口都用这个函数读 sp，不要直接读 settings.stylePreset。
  function getEffectiveStylePreset(settings) {
    const sp = settings?.stylePreset;
    if (!sp || sp.enabled !== true) return {};
    return sp;
  }

  // PpPlaceholderType 实际枚举值（来自 wpp-jsapi-declare）：
  //   -2 Mixed / 1 Title / 2 Body / 3 CenterTitle / 4 Subtitle
  //   5 VerticalTitle / 6 VerticalBody / 7 Object / 8 Chart
  //   9 Bitmap / 10 MediaClip / 11 OrgChart / 12 Table
  //   13 SlideNumber / 14 Header / 15 Footer / 16 Date
  //   17 VerticalObject / 18 Picture
  // 标题类（含副标题——封面副标题视觉上跟主标题一组）：
  const TITLE_PH_TYPES = new Set([1, 3, 4, 5]);
  // 正文类（包含 Object / Chart / OrgChart / Table 这些可能填文字的容器）：
  const BODY_PH_TYPES = new Set([2, 6, 7, 8, 11, 12, 17]);
  // 不要乱改的：页眉/页脚/页码/日期/位图/媒体/纯图片
  const SKIP_PH_TYPES = new Set([9, 10, 13, 14, 15, 16, 18]);

  function safeGetPlaceholderType(shape) {
    try { return shape.PlaceholderFormat?.Type; } catch (e) { return undefined; }
  }

  function findTitleShape(slide) {
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    // 1) 优先按 PlaceholderType 找
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      const t = safeGetPlaceholderType(sh);
      if (t !== undefined && TITLE_PH_TYPES.has(t)) return sh;
    }
    // 2) 按形状 Name 找（"Title 1" / "标题 1" 之类）
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      try {
        if (sh.HasTextFrame && /title|标题/i.test(sh.Name || "")) return sh;
      } catch (e) {}
    }
    return null;
  }

  function findBodyShape(slide, excludeShape) {
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      if (sh === excludeShape) continue;
      const t = safeGetPlaceholderType(sh);
      if (t !== undefined && BODY_PH_TYPES.has(t)) return sh;
    }
    // 名称 fallback
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      if (sh === excludeShape) continue;
      try {
        if (sh.HasTextFrame && /(content|body|text|placeholder|内容|正文)/i.test(sh.Name || "")) return sh;
      } catch (e) {}
    }
    // 兜底：第一个有 TextFrame、不是 title、不是页眉/页脚/页码 的形状
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      if (sh === excludeShape) continue;
      const t = safeGetPlaceholderType(sh);
      if (t !== undefined && (SKIP_PH_TYPES.has(t) || TITLE_PH_TYPES.has(t))) continue;
      try { if (sh.HasTextFrame) return sh; } catch (e) {}
    }
    return null;
  }

  // ============ 现有工具：保留 + 增强 ============

  registry.registerTool({
    name: "wpp_read_comments",
    hosts: ["wpp"],
    description: "读取 WPS 演示 所有幻灯片的批注，返回 comments:[{slide(页号), author(作者), text(批注内容)}]。问“演示/幻灯片有哪些批注”用本工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const fn = wpp().readComments;
      if (typeof fn !== "function") throw new Error("当前宿主不支持读取批注。");
      return await fn.call(wpp());
    }
  });

  registry.registerTool({
    name: "wpp_add_comment",
    hosts: ["wpp"],
    description: "给某页幻灯片添加批注。slide=页号(从1起，省略=第1页)，text=批注内容，author 可选。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        slide: { type: "integer", minimum: 1, description: "页号，省略=第1页" },
        text: { type: "string" },
        author: { type: "string", description: "作者名，省略=AI" }
      }
    },
    handler: async ({ slide, text, author } = {}) => {
      const fn = wpp().addComment;
      if (typeof fn !== "function") throw new Error("当前宿主不支持添加批注。");
      return await fn.call(wpp(), slide, text, author);
    }
  });

  registry.registerTool({
    name: "wpp_export_pdf",
    hosts: ["wpp"],
    description: "把当前 WPS 演示 导出为 PDF。path 省略时导到演示同目录同名 .pdf（演示需已保存到磁盘）。",
    parameters: { type: "object", properties: { path: { type: "string", description: "输出 PDF 完整路径，省略=同目录同名" } } },
    handler: async ({ path } = {}) => {
      const fn = wpp().exportToPdf;
      if (typeof fn !== "function") throw new Error("当前宿主不支持导出 PDF。");
      return await fn.call(wpp(), path);
    }
  });

  registry.registerTool({
    name: "wpp_add_animation",
    hosts: ["wpp"],
    description: "给某页某个形状加动画。slide=页号(默认1)，shapeIndex=形状序号(默认1)，effect：appear/flyIn/blinds/dissolve/fade/peek/spiral/split/wheel/wipe/zoom/bounce，trigger：onClick(默认)/withPrevious/afterPrevious。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 1 },
        shapeIndex: { type: "integer", minimum: 1 },
        effect: { type: "string", enum: ["appear", "flyIn", "blinds", "checkerboard", "dissolve", "fade", "peek", "randomBars", "spiral", "split", "strips", "wedge", "wheel", "wipe", "zoom", "bounce"] },
        trigger: { type: "string", enum: ["onClick", "withPrevious", "afterPrevious"] }
      }
    },
    handler: async (opts = {}) => {
      const fn = wpp().addAnimation;
      if (typeof fn !== "function") throw new Error("当前宿主不支持动画。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_align_shapes",
    hosts: ["wpp"],
    description: "对齐/分布某页的所有形状。align：left/center/right/top/middle/bottom(对齐)；或 distribute：horizontal/vertical(均匀分布)。relativeTo=slide 相对幻灯片、each(默认)相对彼此。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 1 },
        align: { type: "string", enum: ["left", "center", "right", "top", "middle", "bottom"] },
        distribute: { type: "string", enum: ["horizontal", "vertical"] },
        relativeTo: { type: "string", enum: ["slide", "each"] }
      }
    },
    handler: async (opts = {}) => {
      const fn = wpp().alignShapes;
      if (typeof fn !== "function") throw new Error("当前宿主不支持形状对齐。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_doc_properties",
    hosts: ["wpp"],
    description: "读取/设置演示文档属性（标题/作者/主题/关键字等）。传 set 则写入；始终返回当前全部属性。",
    parameters: { type: "object", properties: { set: { type: "object", description: "写入项，键 title/author/subject/keywords/comments/category/manager/company" } } },
    handler: async ({ set } = {}) => {
      const fn = wpp().docProperties;
      if (typeof fn !== "function") throw new Error("当前宿主不支持文档属性。");
      return await fn.call(wpp(), set);
    }
  });

  registry.registerTool({
    name: "wpp_save_as",
    hosts: ["wpp"],
    description: "把演示另存为指定格式。path=完整路径，format：pptx/ppt/pdf/png/jpg。",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, format: { type: "string", enum: ["pptx", "ppt", "pdf", "png", "jpg"] } }
    },
    handler: async (opts = {}) => {
      const fn = wpp().saveAs;
      if (typeof fn !== "function") throw new Error("当前宿主不支持另存为。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_print",
    hosts: ["wpp"],
    description: "打印当前演示（默认打印机）。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const fn = wpp().printPres;
      if (typeof fn !== "function") throw new Error("当前宿主不支持打印。");
      return await fn.call(wpp());
    }
  });

  registry.registerTool({
    name: "wpp_add_section",
    hosts: ["wpp"],
    description: "新增幻灯片节。name=节名，beforeSlide=从第几页开始(默认1)。",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, beforeSlide: { type: "integer", minimum: 1 } }
    },
    handler: async (opts = {}) => {
      const fn = wpp().addSection;
      if (typeof fn !== "function") throw new Error("当前宿主不支持分节。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_set_action",
    hosts: ["wpp"],
    description: "给形状设置点击动作。slide=页号，shapeIndex=形状序号(默认1)。url=打开网址；或 jumpToSlide=点击跳到第几页。二选一。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 1 },
        shapeIndex: { type: "integer", minimum: 1 },
        url: { type: "string" },
        jumpToSlide: { type: "integer", minimum: 1 }
      }
    },
    handler: async (opts = {}) => {
      const fn = wpp().setAction;
      if (typeof fn !== "function") throw new Error("当前宿主不支持形状动作。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_add_media",
    hosts: ["wpp"],
    description: "在某页插入音频/视频文件。slide=页号(默认1)，path=媒体文件完整路径，left/top/width/height 位置尺寸(磅，省略自动)。",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        slide: { type: "integer", minimum: 1 },
        path: { type: "string" },
        left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
      }
    },
    handler: async (opts = {}) => {
      const fn = wpp().addMedia;
      if (typeof fn !== "function") throw new Error("当前宿主不支持媒体插入。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_add_smartart",
    hosts: ["wpp"],
    description: "插入 SmartArt 图形。layoutIndex=布局序号(1起，默认1)，items=各节点文字数组，slide=页号，left/top/width/height 位置尺寸(磅)。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 1 },
        layoutIndex: { type: "integer", minimum: 1 },
        items: { type: "array", items: { type: "string" }, description: "各节点文字" },
        left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
      }
    },
    handler: async (opts = {}) => {
      const fn = wpp().addSmartArt;
      if (typeof fn !== "function") throw new Error("当前宿主不支持 SmartArt。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_set_view",
    hosts: ["wpp"],
    description: "调整视图。zoom=缩放百分比；gotoSlide=跳到第几页。",
    parameters: { type: "object", properties: { zoom: { type: "integer", minimum: 10, maximum: 400 }, gotoSlide: { type: "integer", minimum: 1 } } },
    handler: async (opts = {}) => {
      const fn = wpp().setView;
      if (typeof fn !== "function") throw new Error("当前宿主不支持视图设置。");
      return await fn.call(wpp(), opts);
    }
  });

  registry.registerTool({
    name: "wpp_list_slides",
    hosts: ["wpp"],
    description: "列出演示文稿幻灯片摘要：序号、形状数、布局编号、标题预览、文字预览。大 deck 可用 from/to 或 limit+offset 分页，previewLength 调预览长度。返回 total 与 nextOffset。",
    parameters: {
      type: "object",
      properties: {
        from: { type: "integer", minimum: 1, description: "起始页序号（1 起，闭区间），配合 to" },
        to: { type: "integer", minimum: 1, description: "结束页序号（闭区间）" },
        limit: { type: "integer", minimum: 1, description: "最多返回页数（与 offset 配合分页；不与 from/to 同用）" },
        offset: { type: "integer", minimum: 0, description: "分页偏移（页数，默认 0）" },
        previewLength: { type: "integer", minimum: 0, description: "每页文字预览截断长度，默认 200" }
      }
    },
    handler: async ({ from, to, limit, offset, previewLength } = {}) => {
      const pres = await getPresentation();
      const count = pres.Slides?.Count || 0;
      const preview = previewLength == null ? 200 : Math.max(0, Math.floor(previewLength));
      const ru = global.WpsAiReadUtils;
      // 计算要读的页序号区间（1-based）
      let startIdx = 1;
      let endIdx = count;
      let winMeta = { total: count, truncated: false, nextOffset: null };
      if (from != null || to != null) {
        const r = ru.clampIndexRange({ from, to, count });
        startIdx = r.from; endIdx = r.to;
      } else if (limit != null || offset != null) {
        const off = Math.max(0, Math.floor(offset || 0));
        const lim = Math.max(1, Math.floor(limit || 20));
        startIdx = off + 1;
        endIdx = Math.min(count, off + lim);
        winMeta = { total: count, truncated: endIdx < count, nextOffset: endIdx < count ? endIdx : null };
      }
      const summary = [];
      for (let i = startIdx; i <= endIdx; i += 1) {
        const slide = pres.Slides.Item(i);
        const title = (() => {
          const t = findTitleShape(slide);
          return t ? readShapeText(t).trim() : "";
        })();
        const text = String(internal().readSlideText(slide) || "").trim();
        let layout = null;
        try { layout = slide.Layout; } catch (e) {}
        summary.push({
          index: i,
          shapeCount: slide.Shapes?.Count || 0,
          layout,
          title,
          textPreview: preview > 0 ? text.slice(0, preview) : ""
        });
      }
      return { count: summary.length, total: winMeta.total, truncated: winMeta.truncated, nextOffset: winMeta.nextOffset, slides: summary };
    }
  });

  registry.registerTool({
    name: "wpp_read_slide",
    hosts: ["wpp"],
    description: "读取幻灯片形状：文本、占位信息、形状几何(left/top/width/height)与类型(isPicture/isTable)。index=0/省略=当前页；传 from/to 可一次读多页；includeNotes=true 顺带读演讲者备注；maxChars 限制每个形状文本长度。",
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0, description: "单页序号（从 1 开始；0 或省略=当前页）" },
        from: { type: "integer", minimum: 1, description: "多页读起始序号（闭区间），配合 to" },
        to: { type: "integer", minimum: 1, description: "多页读结束序号（闭区间）" },
        includeNotes: { type: "boolean", description: "是否同时返回该页演讲者备注" },
        maxChars: { type: "integer", minimum: 0, description: "每个形状文本的最大字符数，超出截断" }
      }
    },
    handler: async ({ index, from, to, includeNotes, maxChars } = {}) => {
      const pres = await getPresentation();
      const count = pres.Slides?.Count || 0;
      const readOne = (slide, idx) => {
        const out = {
          index: (slide.SlideIndex || idx || 0),
          layout: slide.Layout,
          shapes: listSlideShapes(slide, { maxChars })
        };
        if (includeNotes) { try { out.notes = readSlideNotes(slide); } catch (e) { out.notes = ""; } }
        return out;
      };
      // 多页模式
      if (from != null || to != null) {
        const r = global.WpsAiReadUtils.clampIndexRange({ from, to, count });
        const slides = [];
        for (let i = r.from; i <= r.to; i += 1) slides.push(readOne(pres.Slides.Item(i), i));
        return { count: slides.length, total: count, from: r.from, to: r.to, slides };
      }
      // 单页模式（原行为）
      const slide = getSlideAt(pres, index || 0);
      return readOne(slide, index || 0);
    }
  });

  registry.registerTool({
    name: "wpp_replace_shape_text",
    hosts: ["wpp"],
    description: "替换指定幻灯片中指定形状的文本。slide=0 表示当前页。",
    parameters: {
      type: "object",
      required: ["shape", "text"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        shape: { type: "integer", description: "形状序号（参考 wpp_read_slide 返回的 index）" },
        text: { type: "string" }
      }
    },
    handler: async ({ slide, shape, text } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj) throw new Error(`形状 ${shape} 不存在`);
      if (!shapeObj.HasTextFrame) throw new Error(`形状 ${shape} 不支持文本`);
      shapeObj.TextFrame.TextRange.Text = text;
      return { slide: slideObj.SlideIndex || slide, shape, length: text.length };
    }
  });

  // ============ 幻灯片增删改 ============

  registry.registerTool({
    name: "wpp_add_slide",
    hosts: ["wpp"],
    description: "在指定位置之后插入新幻灯片。layout 控制版式：title=标题页 / text=标题+内容 / titleOnly=仅标题 / blank=空白 / sectionHeader=节标题 / comparison=对比 / contentWithCaption=内容+说明 / pictureWithCaption=图片+说明。返回新幻灯片序号。",
    parameters: {
      type: "object",
      properties: {
        afterIndex: { type: "integer", minimum: 0, description: "在第几张后插入；省略或 0 = 末尾" },
        layout: {
          type: "string",
          enum: ["title", "text", "twoColumn", "titleOnly", "blank", "sectionHeader", "comparison", "contentWithCaption", "pictureWithCaption"],
          default: "text",
          description: "幻灯片版式"
        },
        title: { type: "string", description: "可选：自动填到标题占位符" },
        body: { type: "string", description: "可选：自动填到内容占位符（多段用 \\n 分隔）" }
      }
    },
    handler: async ({ afterIndex, layout = "text", title, body } = {}) => {
      const pres = await getPresentation();
      const total = pres.Slides.Count;
      const layoutId = LAYOUTS[layout] ?? LAYOUTS.text;
      const insertAt = afterIndex == null || afterIndex === 0
        ? total + 1
        : Math.max(1, Math.min(total + 1, afterIndex + 1));
      const slide = pres.Slides.Add(insertAt, layoutId);

      let titleFilled = false;
      let bodyFilled = false;
      let titleShape = null;

      if (title) {
        titleShape = findTitleShape(slide);
        if (titleShape) {
          try {
            titleShape.TextFrame.TextRange.Text = title;
            titleFilled = true;
          } catch (e) { /* ignore */ }
        }
      }

      if (body) {
        const bodyShape = findBodyShape(slide, titleShape);
        if (bodyShape) {
          try {
            bodyShape.TextFrame.TextRange.Text = body;
            bodyFilled = true;
          } catch (e) { /* ignore */ }
        }
      }

      return {
        index: slide.SlideIndex || insertAt,
        layout,
        titleFilled,
        bodyFilled,
        // 调用方拿 false 时可以用 wpp_add_text_box 自行补一个文本框上去
        warning: (title && !titleFilled) || (body && !bodyFilled)
          ? `部分占位符未找到（titleFilled=${titleFilled}, bodyFilled=${bodyFilled}），请用 wpp_add_text_box 补充`
          : undefined
      };
    }
  });

  registry.registerTool({
    name: "wpp_delete_slide",
    hosts: ["wpp"],
    description: "删除指定序号的幻灯片。慎用。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1 }
      }
    },
    handler: async ({ index } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      slide.Delete();
      return { deleted: index };
    }
  });

  registry.registerTool({
    name: "wpp_move_slide",
    hosts: ["wpp"],
    description: "把幻灯片移动到指定位置。",
    parameters: {
      type: "object",
      required: ["fromIndex", "toIndex"],
      properties: {
        fromIndex: { type: "integer", minimum: 1 },
        toIndex: { type: "integer", minimum: 1, description: "目标位置（1-based）" }
      }
    },
    handler: async ({ fromIndex, toIndex } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(fromIndex);
      if (!slide) throw new Error(`幻灯片 ${fromIndex} 不存在`);
      slide.MoveTo(toIndex);
      return { from: fromIndex, to: toIndex };
    }
  });

  registry.registerTool({
    name: "wpp_duplicate_slide",
    hosts: ["wpp"],
    description: "复制一张幻灯片（新副本紧跟在原幻灯片之后）。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: { index: { type: "integer", minimum: 1 } }
    },
    handler: async ({ index } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      const range = slide.Duplicate();
      const newIdx = range?.Item?.(1)?.SlideIndex || index + 1;
      return { source: index, newIndex: newIdx };
    }
  });

  registry.registerTool({
    name: "wpp_set_slide_layout",
    hosts: ["wpp"],
    description: "切换某张幻灯片的版式。",
    parameters: {
      type: "object",
      required: ["index", "layout"],
      properties: {
        index: { type: "integer", minimum: 1 },
        layout: { type: "string", enum: ["title", "text", "twoColumn", "titleOnly", "blank", "sectionHeader", "comparison", "contentWithCaption", "pictureWithCaption"] }
      }
    },
    handler: async ({ index, layout } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      const id = LAYOUTS[layout];
      if (id == null) throw new Error(`未知 layout：${layout}`);
      slide.Layout = id;
      return { index, layout };
    }
  });

  registry.registerTool({
    name: "wpp_select_slide",
    hosts: ["wpp"],
    description: "把视图切换到指定幻灯片。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: { index: { type: "integer", minimum: 1 } }
    },
    handler: async ({ index } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      slide.Select();
      return { active: index };
    }
  });

  // ============ 幻灯片内容（标题/正文/演讲者备注） ============

  registry.registerTool({
    name: "wpp_set_title",
    hosts: ["wpp"],
    description: "设置某张幻灯片的标题（自动找标题占位符）。slide=0 表示当前页。",
    parameters: {
      type: "object",
      required: ["title"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        title: { type: "string" }
      }
    },
    handler: async ({ slide, title } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const titleShape = findTitleShape(slideObj);
      if (!titleShape) throw new Error("当前幻灯片没有标题占位符。可改用 wpp_add_text_box 自己加一个标题。");
      titleShape.TextFrame.TextRange.Text = title;
      return { slide: slideObj.SlideIndex || slide, title };
    }
  });

  registry.registerTool({
    name: "wpp_set_notes",
    hosts: ["wpp"],
    description: "设置幻灯片的演讲者备注（在 NotesPage 上写文字）。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        text: { type: "string", description: "备注内容（会替换原有备注）" }
      }
    },
    handler: async ({ slide, text } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const notesPage = slideObj.NotesPage;
      if (!notesPage) throw new Error("当前幻灯片没有备注页。");
      // 备注页第一个有 TextFrame 的形状（不是占位编号那种，常见是第二个形状）
      const shapes = notesPage.Item ? notesPage.Item(1).Shapes : notesPage.Shapes;
      const count = shapes?.Count || 0;
      let target = null;
      for (let i = 1; i <= count; i += 1) {
        const sh = shapes.Item(i);
        try {
          if (sh.HasTextFrame && sh.PlaceholderFormat?.Type === 2) { target = sh; break; } // 修 B27：ppPlaceholderBody=2（12 是 Table）
        } catch (e) {}
      }
      if (!target) {
        for (let i = 1; i <= count; i += 1) {
          const sh = shapes.Item(i);
          try { if (sh.HasTextFrame) { target = sh; break; } } catch (e) {}
        }
      }
      if (!target) throw new Error("备注页找不到可写文本的形状。");
      target.TextFrame.TextRange.Text = text;
      return { slide: slideObj.SlideIndex || slide, length: text.length };
    }
  });

  registry.registerTool({
    name: "wpp_get_notes",
    hosts: ["wpp"],
    description: "读取幻灯片的演讲者备注。",
    parameters: {
      type: "object",
      properties: { slide: { type: "integer", minimum: 0 } }
    },
    handler: async ({ slide } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      if (!slideObj.NotesPage) return { text: "" };
      return { slide: slideObj.SlideIndex || slide, text: readSlideNotes(slideObj) };
    }
  });

  // ============ 形状新增（文本框 / 图片 / 表格） ============

  registry.registerTool({
    name: "wpp_add_text_box",
    hosts: ["wpp"],
    description: "在幻灯片上新增一个文本框。坐标和尺寸单位为磅（72 磅 = 1 英寸；常见幻灯片宽 720 磅 / 高 540 磅）。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        text: { type: "string" },
        left: { type: "number", default: 50 },
        top: { type: "number", default: 50 },
        width: { type: "number", default: 600 },
        height: { type: "number", default: 80 },
        fontSize: { type: "number", description: "字号（磅）" },
        bold: { type: "boolean" },
        color: { type: "string", description: "字体颜色 #RRGGBB" }
      }
    },
    handler: async ({ slide, text, left = 50, top = 50, width = 600, height = 80, fontSize, bold, color } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      // MsoTextOrientation: msoTextOrientationHorizontal = 1
      const shape = slideObj.Shapes.AddTextbox(1, left, top, width, height);
      const tr = shape.TextFrame.TextRange;
      tr.Text = text;
      try {
        if (typeof fontSize === "number") tr.Font.Size = fontSize;
        if (typeof bold === "boolean") tr.Font.Bold = bold ? MSO.TRUE : MSO.FALSE;
        if (color) tr.Font.Color.RGB = parseColor(color);
      } catch (e) {}
      return { slide: slideObj.SlideIndex || slide, shapeIndex: slideObj.Shapes.Count };
    }
  });

  registry.registerTool({
    name: "wpp_add_picture",
    hosts: ["wpp"],
    description: "在幻灯片上插入图片。fileName 可以是 HTTP URL、dataUrl 或本地路径；HTTP/dataUrl 会先落成本地文件再插入，避免 WPS 远程下载失败。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        fileName: { type: "string", description: "图片 URL 或本地路径" },
        left: { type: "number", default: 100 },
        top: { type: "number", default: 100 },
        width: { type: "number", description: "宽度（磅），省略使用原图" },
        height: { type: "number", description: "高度（磅），省略使用原图" }
      }
    },
    handler: async ({ slide, fileName, left = 100, top = 100, width, height } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const localFileName = await imageAssets()?.ensureLocalImagePath?.(fileName) || fileName;
      // AddPicture(FileName, LinkToFile, SaveWithDocument, Left, Top, Width?, Height?)
      const shape = safeAddPicture(pres, slideObj, localFileName, left, top, width, height);
      return { slide: slideObj.SlideIndex || slide, fileName: localFileName, sourceFileName: fileName, shapeIndex: slideObj.Shapes.Count };
    }
  });

  registry.registerTool({
    name: "wpp_add_table",
    hosts: ["wpp"],
    description: "在幻灯片上插入表格（无填充）。后续可以用 wpp_set_table_cell 写入数据。",
    parameters: {
      type: "object",
      required: ["rows", "cols"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        rows: { type: "integer", minimum: 1 },
        cols: { type: "integer", minimum: 1 },
        left: { type: "number", default: 50 },
        top: { type: "number", default: 100 },
        width: { type: "number", default: 600 },
        height: { type: "number", default: 300 },
        data: {
          type: "array",
          description: "可选二维数组，自动填充；外层为行内层为列，单元格按 String() 写入",
          items: { type: "array", items: { type: "string" } }
        }
      }
    },
    handler: async ({ slide, rows, cols, left = 50, top = 100, width = 600, height = 300, data } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shape = slideObj.Shapes.AddTable(rows, cols, left, top, width, height);
      if (Array.isArray(data) && shape.Table) {
        for (let r = 0; r < Math.min(rows, data.length); r += 1) {
          const row = data[r];
          if (!Array.isArray(row)) continue;
          for (let c = 0; c < Math.min(cols, row.length); c += 1) {
            try {
              const cell = shape.Table.Cell(r + 1, c + 1);
              cell.Shape.TextFrame.TextRange.Text = String(row[c] ?? "");
            } catch (e) {}
          }
        }
      }
      return { slide: slideObj.SlideIndex || slide, rows, cols, filled: !!data };
    }
  });

  registry.registerTool({
    name: "wpp_set_table_cell",
    hosts: ["wpp"],
    description: "设置表格指定单元格的文本。",
    parameters: {
      type: "object",
      required: ["shape", "row", "col", "text"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        shape: { type: "integer", description: "表格形状的序号（参考 wpp_read_slide）" },
        row: { type: "integer", minimum: 1 },
        col: { type: "integer", minimum: 1 },
        text: { type: "string" }
      }
    },
    handler: async ({ slide, shape, row, col, text } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj?.Table) throw new Error(`形状 ${shape} 不是表格`);
      const cell = shapeObj.Table.Cell(row, col);
      cell.Shape.TextFrame.TextRange.Text = text;
      return { slide: slideObj.SlideIndex || slide, shape, row, col };
    }
  });

  registry.registerTool({
    name: "wpp_delete_shape",
    hosts: ["wpp"],
    description: "删除幻灯片上的某个形状。",
    parameters: {
      type: "object",
      required: ["shape"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        shape: { type: "integer", description: "形状序号（参考 wpp_read_slide）" }
      }
    },
    handler: async ({ slide, shape } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj) throw new Error(`形状 ${shape} 不存在`);
      shapeObj.Delete();
      return { slide: slideObj.SlideIndex || slide, deleted: shape };
    }
  });

  // ============ 文本格式化 ============

  registry.registerTool({
    name: "wpp_format_shape_text",
    hosts: ["wpp"],
    description: "对某形状的文本设置字体格式（粗/斜/下划线/字号/字体/颜色）。所有格式参数可选。",
    parameters: {
      type: "object",
      required: ["shape"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        shape: { type: "integer" },
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        underline: { type: "boolean" },
        fontName: { type: "string" },
        fontSize: { type: "number" },
        color: { type: "string", description: "字体颜色 #RRGGBB" }
      }
    },
    handler: async ({ slide, shape, bold, italic, underline, fontName, fontSize, color } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj?.HasTextFrame) throw new Error(`形状 ${shape} 不支持文本`);
      const font = shapeObj.TextFrame.TextRange.Font;
      const applied = {};
      if (typeof bold === "boolean") { font.Bold = bold ? MSO.TRUE : MSO.FALSE; applied.bold = bold; }
      if (typeof italic === "boolean") { font.Italic = italic ? MSO.TRUE : MSO.FALSE; applied.italic = italic; }
      if (typeof underline === "boolean") { font.Underline = underline ? MSO.TRUE : MSO.FALSE; applied.underline = underline; }
      if (fontName) { font.Name = fontName; applied.fontName = fontName; }
      if (typeof fontSize === "number") { font.Size = fontSize; applied.fontSize = fontSize; }
      if (color) { font.Color.RGB = parseColor(color); applied.color = color; }
      return { slide: slideObj.SlideIndex || slide, shape, applied };
    }
  });

  // ============ Presentation 级别 ============

  registry.registerTool({
    name: "wpp_get_presentation_info",
    hosts: ["wpp"],
    description: "获取演示文稿元信息：文件名、保存状态、幻灯片数、页面尺寸。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const pres = await getPresentation();
      const ps = pres.PageSetup;
      return {
        name: pres.Name,
        path: pres.Path || null,
        saved: pres.Saved == null ? null : !!pres.Saved,
        slideCount: pres.Slides?.Count || 0,
        slideWidth: ps?.SlideWidth ?? null,
        slideHeight: ps?.SlideHeight ?? null
      };
    }
  });

  registry.registerTool({
    name: "wpp_apply_theme",
    hosts: ["wpp"],
    description: "对指定幻灯片应用主题文件。themePath 是本地 .pptx/.thmx/.potx 文件路径，应用后会替换该幻灯片的设计模板。",
    parameters: {
      type: "object",
      required: ["themePath"],
      properties: {
        themePath: { type: "string" },
        slide: { type: "integer", minimum: 0, description: "省略=当前页；传 0 同样表示当前页；传 -1 表示对所有页应用" }
      }
    },
    handler: async ({ themePath, slide } = {}) => {
      const pres = await getPresentation();
      if (slide === -1) {
        const count = pres.Slides.Count;
        for (let i = 1; i <= count; i += 1) {
          try { pres.Slides.Item(i).ApplyTemplate(themePath); } catch (e) {}
        }
        return { themePath, applied: "all" };
      }
      const slideObj = getSlideAt(pres, slide || 0);
      slideObj.ApplyTemplate(themePath);
      return { themePath, applied: slideObj.SlideIndex || slide };
    }
  });

  registry.registerTool({
    name: "wpp_save",
    hosts: ["wpp"],
    description: "保存当前演示文稿（使用现有路径）。新文件需要先在 WPS 里另存为再调用此工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const pres = await getPresentation();
      try {
        pres.Save();
        return { saved: true, name: pres.Name };
      } catch (e) {
        throw new Error(`保存失败（可能是新文件没有路径）：${e.message || e}`);
      }
    }
  });

  // ============ 风格预设（与「PPT 风格」对话框联动） ============

  registry.registerTool({
    name: "wpp_get_style_preset",
    hosts: ["wpp"],
    description: [
      "读取用户在「PPT 风格」对话框里设定的统一样式预设和色板。**生成/编辑幻灯片前必须先调一次，按返回的色板和 guidelines 设计**。",
      "返回字段：",
      "  - enabled, scheme（色板方案标识）",
      "  - titleFont/titleSize/titleBold/titleColor 标题字体设置",
      "  - bodyFont/bodySize/bodyColor 正文字体设置",
      "  - **色板**：primaryColor（主色，章节页背景/装饰色块）、secondaryColor（次色/边框）、accentColor（强调色，点缀高亮）、backgroundColor（幻灯片底色）、surfaceColor（卡片/内容块底色）",
      "  - themeFile 可选模板路径",
      "  - **主题元信息**：themeLabel（英文名）、themeDescription（用途定位）、themeDesign（设计理念+灵感来源）、darkMode（true=深色底主题，文字反白；用图表配色时也要切换深色板）",
      "  - **signatureElement**：该色板的标志视觉元素（必须在封面/章节页体现）",
      "  - **layoutHints**：该色板下优先用哪些模板/版式工具（直接照做）",
      "  - **guidelines**：灵犀 PPT 设计宪法 10 条（每次配版前自检）",
      "做高级版式时建议组合使用：",
      "  - 章节分隔页 → wpp_set_slide_background 用 primaryColor 满屏；标题用白色大字号",
      "  - 内容页 → 背景 backgroundColor；左侧 wpp_add_shape(rectangle, width=8, height=slideHeight, fill=primaryColor) 加装饰条",
      "  - 数据/统计页 → 用 wpp_add_shape(roundedRect, fill=surfaceColor) 做卡片容器；或调 wpp_render_chart 生成图表插图",
      "  - 强调元素 → accentColor",
      "通过色板 + signatureElement + layoutHints + guidelines 让所有页风格统一，避免 AI slop。"
    ].join("\n"),
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const sp = settings.stylePreset || { enabled: false };
      // 关键修复：用户没勾选「启用统一样式」时不返回保存的色板/字体，
      // 否则 AI 看到这些字段就会拿去填 freeform CSS，等同于"未启用"形同虚设。
      // 只返回 enabled=false + 设计宪法，并明确告诉 AI 自己挑色板。
      if (sp.enabled !== true) {
        return {
          enabled: false,
          note: "用户未启用统一样式预设——你有完全设计自由度，请按页面内容和用户需求自己挑色板和字体，**不要**参考用户保存过的任何色板字段。",
          guidelines: getDesignGuidelines()
        };
      }
      const out = Object.assign({}, sp);
      const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
      const matched = sp.scheme && schemes[sp.scheme];
      if (matched) {
        out.themeLabel = matched.label;
        out.themeDescription = matched.description;
        out.themeDesign = matched.design;
        out.signatureElement = matched.signatureElement || "";
        out.layoutHints = matched.layoutHints || "";
        out.darkMode = !!matched.darkMode;
      } else {
        out.themeLabel = "Custom";
        out.themeDescription = "用户自定义色板";
        out.themeDesign = "用户自调，无固定设计参考";
        out.signatureElement = "无固定签名元素 — 按 primary/accent 对比关系自行设计 1 个全篇统一的标志元素（如左侧装饰条、右上角小符号、章节大数字之一），并在所有页保持。";
        out.layoutHints = "封面/章节用 wpp_apply_visual_template（带渐变/巨型水印）；普通页 wpp_apply_template:content-sidebar；数据页 stat-hero 或 wpp_render_chart。";
        // 推断 darkMode：背景色亮度 < 128 视为深色
        const bg = (sp.backgroundColor || "#ffffff").replace("#", "");
        if (bg.length === 6) {
          const r = parseInt(bg.slice(0, 2), 16);
          const g = parseInt(bg.slice(2, 4), 16);
          const b = parseInt(bg.slice(4, 6), 16);
          out.darkMode = (r * 299 + g * 587 + b * 114) / 1000 < 128;
        } else {
          out.darkMode = false;
        }
      }
      out.guidelines = getDesignGuidelines();
      return out;
    }
  });

  registry.registerTool({
    name: "wpp_apply_style_preset",
    hosts: ["wpp"],
    description: "把用户保存的风格预设统一应用到指定幻灯片的标题/正文/普通文本框。slide=0 表示当前页；省略 slide 表示对所有幻灯片应用。即使预设 enabled=false 也会按已有字段应用一遍商用统一样式（不会失败）。除占位符外，也会顺手把页面上其它纯文本框统一字体（标题用大字号 / 正文用小字号根据高度判断）。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前页；省略=所有页）" },
        formatTextBoxes: { type: "boolean", default: true, description: "是否同时格式化非占位符的纯文本框" }
      }
    },
    handler: async ({ slide, formatTextBoxes = true } = {}) => {
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const sp = settings.stylePreset || {};
      const pres = await getPresentation();
      const targets = [];
      if (slide === undefined || slide === null) {
        const count = pres.Slides?.Count || 0;
        for (let i = 1; i <= count; i += 1) targets.push(pres.Slides.Item(i));
      } else {
        targets.push(getSlideAt(pres, slide || 0));
      }

      // 取值：未填的字段用一套商用默认值兜底
      const titleFont = sp.titleFont || "Microsoft YaHei";
      const titleSize = sp.titleSize || 32;
      const titleBold = sp.titleBold !== false;
      const titleColor = parseColor(sp.titleColor || "#1f2329");
      const bodyFont = sp.bodyFont || "Microsoft YaHei";
      const bodySize = sp.bodySize || 18;
      const bodyColor = parseColor(sp.bodyColor || "#33363c");

      // 多路径写字体/颜色/加粗，应对 WPS 不同版本和中英文字体差异
      function forceFont(shape, fontName, fontSize, boldFlag, colorBgr) {
        // 1) 经典路径 TextFrame.TextRange.Font
        try {
          const f = shape.TextFrame.TextRange.Font;
          try { f.Name = fontName; } catch (e) {}
          try { f.Size = fontSize; } catch (e) {}
          if (typeof boldFlag === "boolean") {
            // 不同 WPS 版本接受不同值，全都 try 一遍最安全
            for (const v of [boldFlag ? -1 : 0, boldFlag ? 1 : 0, boldFlag]) {
              try { f.Bold = v; break; } catch (e) {}
            }
          }
          // 强制 RGB 类型再设颜色（避免主题色覆盖）
          try { f.Color.Type = 1; } catch (e) {}
          try { f.Color.RGB = colorBgr; } catch (e) {}
        } catch (e) {}

        // 2) 新路径 TextFrame2 — 中文要用 NameFarEast，西文用 NameAscii
        try {
          const f2 = shape.TextFrame2?.TextRange?.Font;
          if (f2) {
            try { f2.NameFarEast = fontName; } catch (e) {}
            try { f2.NameAscii = fontName; } catch (e) {}
            try { f2.NameOther = fontName; } catch (e) {}
            try { f2.Size = fontSize; } catch (e) {}
            if (typeof boldFlag === "boolean") {
              for (const v of [boldFlag ? -1 : 0, boldFlag ? 1 : 0, boldFlag]) {
                try { f2.Bold = v; break; } catch (e) {}
              }
            }
            try { f2.Fill.ForeColor.RGB = colorBgr; } catch (e) {}
          }
        } catch (e) {}

        // 3) Characters() 路径 — 强制每个字符都套上
        try {
          const tr = shape.TextFrame.TextRange;
          const len = tr.Length || tr.Text?.length || 0;
          if (len > 0) {
            const chars = tr.Characters(1, len);
            try { chars.Font.Name = fontName; } catch (e) {}
            try { chars.Font.Size = fontSize; } catch (e) {}
            if (typeof boldFlag === "boolean") {
              for (const v of [boldFlag ? -1 : 0, boldFlag ? 1 : 0, boldFlag]) {
                try { chars.Font.Bold = v; break; } catch (e) {}
              }
            }
            try { chars.Font.Color.Type = 1; } catch (e) {}
            try { chars.Font.Color.RGB = colorBgr; } catch (e) {}
          }
        } catch (e) {}
      }

      let processed = 0;
      let titleHits = 0, bodyHits = 0, otherHits = 0;

      for (const slideObj of targets) {
        const shapes = slideObj.Shapes;
        const cnt = shapes?.Count || 0;

        for (let i = 1; i <= cnt; i += 1) {
          const sh = shapes.Item(i);
          let hasFrame = false;
          try { hasFrame = !!sh.HasTextFrame; } catch (e) {}
          if (!hasFrame) continue;

          const phType = safeGetPlaceholderType(sh);
          if (phType !== undefined && SKIP_PH_TYPES.has(phType)) continue;

          let role = "other";
          if (phType !== undefined && TITLE_PH_TYPES.has(phType)) role = "title";
          else if (phType !== undefined && BODY_PH_TYPES.has(phType)) role = "body";

          try {
            // 空文本框跳过（避免修改空 shape 反而引入隐藏问题）
            let textVal = "";
            try { textVal = String(sh.TextFrame.TextRange.Text || ""); } catch (e) {}
            if (!textVal.trim()) continue;

            if (role === "title") {
              forceFont(sh, titleFont, titleSize, titleBold, titleColor);
              titleHits += 1;
            } else if (role === "body") {
              forceFont(sh, bodyFont, bodySize, undefined, bodyColor);
              bodyHits += 1;
            } else if (formatTextBoxes) {
              let h = 0;
              try { h = sh.Height; } catch (e) {}
              if (h >= 80) {
                forceFont(sh, titleFont, titleSize, titleBold, titleColor);
              } else {
                forceFont(sh, bodyFont, bodySize, undefined, bodyColor);
              }
              otherHits += 1;
            }
          } catch (e) { /* 单个形状失败不影响其他 */ }
        }
        processed += 1;
      }

      return {
        processed,
        scope: slide === undefined || slide === null ? "all" : (slide || 0),
        applied: { titleHits, bodyHits, otherHits },
        usedDefaults: !sp.enabled,
        preset: { titleFont, titleSize, titleBold, bodyFont, bodySize }
      };
    }
  });

  // ============ 内部 helper：模板用的低层操作 ============

  function setBg(slideObj, color) {
    try {
      try { slideObj.FollowMasterBackground = MSO.FALSE; } catch (e) {}
      const bg = slideObj.Background;
      if (!bg) return;
      const fill = bg.Fill;
      try { fill.Solid(); } catch (e) {}
      try { fill.ForeColor.Type = 1; } catch (e) {}
      try { fill.ForeColor.RGB = parseColor(color); } catch (e) {}
    } catch (e) {}
  }

  function addRect(slide, x, y, w, h, fillColor, opts = {}) {
    const sh = slide.Shapes.AddShape(1 /* rectangle */, x, y, w, h);
    try {
      if (fillColor) {
        sh.Fill.Solid();
        try { sh.Fill.ForeColor.Type = 1; } catch (e) {}
        sh.Fill.ForeColor.RGB = parseColor(fillColor);
      } else {
        sh.Fill.Visible = MSO.FALSE;
      }
    } catch (e) {}
    try {
      if (opts.lineColor) {
        sh.Line.Visible = MSO.TRUE;
        try { sh.Line.ForeColor.Type = 1; } catch (e) {}
        sh.Line.ForeColor.RGB = parseColor(opts.lineColor);
      } else {
        sh.Line.Visible = MSO.FALSE;
      }
    } catch (e) {}
    return sh;
  }

  function addText(slide, x, y, w, h, text, opts = {}) {
    const sh = slide.Shapes.AddTextbox(1 /* horizontal */, x, y, w, h);
    const tr = sh.TextFrame.TextRange;
    try { tr.Text = String(text || ""); } catch (e) {}
    if (opts.fontName) {
      try { tr.Font.Name = opts.fontName; } catch (e) {}
      try {
        const f2 = sh.TextFrame2?.TextRange?.Font;
        if (f2) {
          f2.NameFarEast = opts.fontName;
          f2.NameAscii = opts.fontName;
        }
      } catch (e) {}
    }
    if (opts.fontSize) try { tr.Font.Size = opts.fontSize; } catch (e) {}
    if (typeof opts.bold === "boolean") {
      for (const v of [opts.bold ? -1 : 0, opts.bold ? 1 : 0, opts.bold]) {
        try { tr.Font.Bold = v; break; } catch (e) {}
      }
    }
    if (opts.italic) {
      try { tr.Font.Italic = -1; } catch (e) {}
    }
    if (opts.color) {
      try { tr.Font.Color.Type = 1; } catch (e) {}
      try { tr.Font.Color.RGB = parseColor(opts.color); } catch (e) {}
    }
    if (opts.alignH) {
      // 1=left 2=center 3=right
      const map = { left: 1, center: 2, right: 3 };
      try { tr.ParagraphFormat.Alignment = map[opts.alignH] || 1; } catch (e) {}
    }
    // 关闭文本框边框（textbox 默认无边框，保险起见）
    try { sh.Line.Visible = MSO.FALSE; } catch (e) {}
    return sh;
  }

  // ============ 背景 / 形状（高级版式必备） ============

  registry.registerTool({
    name: "wpp_set_slide_background",
    hosts: ["wpp"],
    description: "设置幻灯片背景纯色填充。slide=0 当前页；省略 slide 表示对所有页应用。配合 wpp_get_style_preset 拿到的 backgroundColor / primaryColor 用，章节分隔页可用 primaryColor 做满屏底色。",
    parameters: {
      type: "object",
      required: ["color"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前页；省略=所有页）" },
        color: { type: "string", description: "颜色 #RRGGBB，例 #1f3a5f" }
      }
    },
    handler: async ({ slide, color } = {}) => {
      const pres = await getPresentation();
      const targets = [];
      if (slide === undefined || slide === null) {
        const count = pres.Slides?.Count || 0;
        for (let i = 1; i <= count; i += 1) targets.push(pres.Slides.Item(i));
      } else {
        targets.push(getSlideAt(pres, slide || 0));
      }
      const bgr = parseColor(color);
      let processed = 0;
      for (const slideObj of targets) {
        try {
          // 让幻灯片不再继承母版背景
          try { slideObj.FollowMasterBackground = MSO.FALSE; } catch (e) {}
          const bg = slideObj.Background;
          if (bg) {
            try {
              const fill = bg.Fill;
              try { fill.Solid(); } catch (e) {}
              try { fill.ForeColor.Type = 1; } catch (e) {}
              try { fill.ForeColor.RGB = bgr; } catch (e) {}
            } catch (e) {}
          }
          processed += 1;
        } catch (e) { /* skip */ }
      }
      return { processed, color, scope: slide === undefined || slide === null ? "all" : (slide || 0) };
    }
  });

  // 常用 MsoAutoShapeType（来自 kso.MsoAutoShapeType）
  const SHAPE_TYPES = {
    rectangle: 1,           // msoShapeRectangle
    roundedRect: 5,         // msoShapeRoundedRectangle
    oval: 9,                // msoShapeOval
    diamond: 4,             // msoShapeDiamond
    triangle: 7,            // msoShapeIsoscelesTriangle
    pentagon: 51,           // msoShapePentagon
    hexagon: 10,            // msoShapeHexagon
    star5: 92,              // 修 B28：msoShape5pointStar=92（12 是 RegularPentagon 正五边形）
    rightArrow: 33,         // msoShapeRightArrow
    leftArrow: 34,
    upArrow: 35,
    downArrow: 36,
    chevron: 52,            // msoShapeChevron
    parallelogram: 2,       // 修 B28：msoShapeParallelogram=2（8 是 RightTriangle）
    trapezoid: 3,           // 修 B28：msoShapeTrapezoid=3（6 是 Octagon 八边形）
    line: 1,                // 用 rectangle 高度=1 模拟横线
    plus: 11                // msoShapePlus
  };

  registry.registerTool({
    name: "wpp_add_shape",
    hosts: ["wpp"],
    description: "在幻灯片上添加一个形状（矩形/圆角矩形/圆/箭头/星形等）。常用于：左侧装饰色块（rectangle 高度=slideHeight，宽 8）、章节页背景色块、统计页大圆点、流程箭头等。可设填充色、描边色、可选写入文字。坐标单位磅（pt）。",
    parameters: {
      type: "object",
      required: ["shape", "left", "top", "width", "height"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前页）" },
        shape: {
          type: "string",
          enum: ["rectangle", "roundedRect", "oval", "diamond", "triangle", "pentagon", "hexagon", "star5", "rightArrow", "leftArrow", "upArrow", "downArrow", "chevron", "parallelogram", "trapezoid", "plus"],
          description: "形状类型"
        },
        left: { type: "number" },
        top: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        fillColor: { type: "string", description: "填充色 #RRGGBB，省略=无填充" },
        lineColor: { type: "string", description: "描边色 #RRGGBB，省略=无描边" },
        text: { type: "string", description: "可选：在形状内写入文字" },
        textColor: { type: "string", description: "文字颜色 #RRGGBB" },
        textSize: { type: "number", description: "文字字号（磅）" },
        textBold: { type: "boolean" }
      }
    },
    handler: async ({ slide, shape, left, top, width, height, fillColor, lineColor, text, textColor, textSize, textBold } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeId = SHAPE_TYPES[shape];
      if (shapeId == null) throw new Error(`未知形状：${shape}`);
      const sh = slideObj.Shapes.AddShape(shapeId, left, top, width, height);

      try {
        if (fillColor) {
          const fill = sh.Fill;
          try { fill.Solid(); } catch (e) {}
          try { fill.ForeColor.Type = 1; } catch (e) {}
          fill.ForeColor.RGB = parseColor(fillColor);
        } else {
          try { sh.Fill.Visible = MSO.FALSE; } catch (e) {}
        }
      } catch (e) {}

      try {
        if (lineColor) {
          try { sh.Line.Visible = MSO.TRUE; } catch (e) {}
          try { sh.Line.ForeColor.Type = 1; } catch (e) {}
          try { sh.Line.ForeColor.RGB = parseColor(lineColor); } catch (e) {}
        } else {
          try { sh.Line.Visible = MSO.FALSE; } catch (e) {}
        }
      } catch (e) {}

      if (text) {
        try {
          const tr = sh.TextFrame.TextRange;
          tr.Text = text;
          if (textSize) tr.Font.Size = textSize;
          if (typeof textBold === "boolean") {
            for (const v of [textBold ? -1 : 0, textBold ? 1 : 0, textBold]) {
              try { tr.Font.Bold = v; break; } catch (e) {}
            }
          }
          if (textColor) {
            try { tr.Font.Color.Type = 1; } catch (e) {}
            try { tr.Font.Color.RGB = parseColor(textColor); } catch (e) {}
          }
        } catch (e) {}
      }

      return {
        slide: slideObj.SlideIndex || slide,
        shapeIndex: slideObj.Shapes.Count,
        shape, left, top, width, height
      };
    }
  });

  // ============ 切换效果（过渡动画） ============

  // PpEntryEffect 子集（来自 wpp-jsapi-declare），挑商用合适的几个
  const ENTRY_EFFECTS = {
    none: 0,           // ppEffectNone
    fade: 1793,        // ppEffectFade（推荐，最稳重）
    dissolve: 1537,    // ppEffectDissolve
    cut: 257,          // ppEffectCut
    coverLeft: 1281,
    coverUp: 1282,
    wipeLeft: 2049,    // ppEffectUncoverLeft（轻微移动）
    wipeUp: 2050
  };
  // PpTransitionSpeed: 1=Slow, 2=Medium, 3=Fast
  const TRANSITION_SPEED = { slow: 1, medium: 2, fast: 3 };

  registry.registerTool({
    name: "wpp_set_slide_transition",
    hosts: ["wpp"],
    description: "为幻灯片设置切换/过渡效果。商用建议 effect=fade（淡入淡出最稳）+ speed=medium。slide=0 当前页；省略 slide = 对所有页面应用。一份 PPT 一般统一所有页过渡效果即可。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号，0=当前页，省略=所有页" },
        effect: {
          type: "string",
          enum: ["none", "fade", "dissolve", "cut", "coverLeft", "coverUp", "wipeLeft", "wipeUp"],
          default: "fade"
        },
        speed: { type: "string", enum: ["slow", "medium", "fast"], default: "medium" }
      }
    },
    handler: async ({ slide, effect = "fade", speed = "medium" } = {}) => {
      const pres = await getPresentation();
      const effectId = ENTRY_EFFECTS[effect];
      const speedId = TRANSITION_SPEED[speed] || 2;
      if (effectId == null) throw new Error(`未知效果：${effect}`);

      const targets = [];
      if (slide === undefined || slide === null) {
        const count = pres.Slides?.Count || 0;
        for (let i = 1; i <= count; i += 1) targets.push(pres.Slides.Item(i));
      } else {
        targets.push(getSlideAt(pres, slide || 0));
      }

      let processed = 0;
      for (const slideObj of targets) {
        try {
          const tr = slideObj.SlideShowTransition;
          if (!tr) continue;
          tr.EntryEffect = effectId;
          try { tr.Speed = speedId; } catch (e) {}
          processed += 1;
        } catch (e) { /* 跳过不支持的 */ }
      }

      return { processed, effect, speed, scope: slide === undefined || slide === null ? "all" : (slide || 0) };
    }
  });

  registry.registerTool({
    name: "wpp_export_slide_as_image",
    hosts: ["wpp"],
    description: "把某张幻灯片导出成图片到本地路径。支持 PNG/JPG（看 fileName 后缀，filterName 用 PNG / JPG）。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        fileName: { type: "string", description: "本地保存路径，例 C:/tmp/slide-1.png" },
        filterName: { type: "string", default: "PNG", description: "PNG / JPG / BMP" },
        width: { type: "number", description: "导出像素宽度，省略用原始尺寸" },
        height: { type: "number", description: "导出像素高度，省略用原始尺寸" }
      }
    },
    handler: async ({ slide, fileName, filterName = "PNG", width, height } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      slideObj.Export(fileName, filterName, width || 0, height || 0);
      return { slide: slideObj.SlideIndex || slide, fileName, filterName };
    }
  });

  // ============ 视觉模板（方案 B：SVG 渲染为 PNG 作为整页背景） ============

  // 把 SVG 字符串渲染成 PNG dataURL
  // 用 Image + Canvas，纯浏览器能力，不需要外部库
  function svgToPngDataUrl(svgString, widthPx, heightPx) {
    return new Promise((resolve, reject) => {
      const svg64 = btoa(unescape(encodeURIComponent(svgString)));
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = widthPx;
          canvas.height = heightPx;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, widthPx, heightPx);
          ctx.drawImage(img, 0, 0, widthPx, heightPx);
          resolve(canvas.toDataURL("image/png"));
        } catch (e) { reject(e); }
      };
      img.onerror = (e) => reject(new Error("SVG 解析失败"));
      img.src = "data:image/svg+xml;base64," + svg64;
    });
  }

  // 上传 dataUrl 到本地代理，拿回本地文件路径供 AddPicture 使用
  async function uploadDataUrl(dataUrl) {
    const proxyBase = window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
    let resp;
    try {
      resp = await fetch(`${proxyBase}/upload-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl })
      });
    } catch (e) {
      throw new Error(`代理服务器连不上（${proxyBase}）：${e.message}。先确认 npm run dev:et 进程在跑。`);
    }
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch (e) {}
      if (resp.status === 404) {
        throw new Error(`/upload-image 返回 404 —— 多半是代理服务器是旧进程（没有这个路由）。请重启 npm run dev:et 让新版生效。响应：${detail}`);
      }
      throw new Error(`上传图片失败 ${resp.status}：${detail}`);
    }
    const json = await resp.json();
    if (!json.path) throw new Error(`代理未返回文件路径，响应：${JSON.stringify(json).slice(0, 200)}`);
    try {
      global.WpsAiLog?.log?.("uploadDataUrl", `path=${json.path} size=${json.size} verifiedSize=${json.verifiedSize}`);
    } catch (e) {}
    return json.path;
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  // 视觉模板：纯 SVG，吃 palette + params 渲染。每个返回 { svg, textBoxes }
  // textBoxes 是模板预留的可编辑文本框区域（左/上/宽/高/参数引用），由 tool 在插图后再 wpp_add_text_box 叠加
  const VISUAL_TEMPLATES = {
    // 渐变封面：左上→右下渐变 + 大标题居中（标题作为可编辑文本框单独叠加）
    "v-cover-gradient": ({ palette, params, w, h }) => {
      const grad = `<defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.secondary)}"/>
        </linearGradient>
        <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="40" />
        </filter>
      </defs>`;
      const decor = `
        <circle cx="${w * 0.85}" cy="${h * 0.15}" r="${h * 0.35}" fill="${escAttr(palette.accent)}" opacity="0.18" filter="url(#soft)"/>
        <circle cx="${w * 0.15}" cy="${h * 0.9}" r="${h * 0.25}" fill="${escAttr(palette.accent)}" opacity="0.12" filter="url(#soft)"/>
        <rect x="${w * 0.08}" y="${h * 0.65}" width="${w * 0.08}" height="3" fill="${escAttr(palette.accent)}"/>
      `;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="url(#g1)"/>${decor}</svg>`;
      return {
        svg,
        textBoxes: [
          { role: "title", text: params.title || "标题", x: w * 0.08, y: h * 0.4, w: w * 0.7, h: h * 0.18, fontSize: 56, bold: true, color: "#FFFFFF" },
          ...(params.subtitle ? [{ role: "subtitle", text: params.subtitle, x: w * 0.08, y: h * 0.58, w: w * 0.7, h: 40, fontSize: 18, color: "#E2E8F0" }] : [])
        ]
      };
    },

    // 现代分章页：暗色背景 + 巨大透明数字 + 章节标题
    "v-section-modern": ({ palette, params, w, h }) => {
      const bigNum = params.chapter || "01";
      const grad = `<defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.secondary)}"/>
        </linearGradient>
      </defs>`;
      const ghost = `
        <text x="${w * 0.45}" y="${h * 0.95}" font-family="Microsoft YaHei, sans-serif" font-size="${h * 1.1}" font-weight="900" fill="${escAttr(palette.accent)}" opacity="0.16">${escAttr(bigNum)}</text>
      `;
      const accent = `<rect x="${w * 0.08}" y="${h * 0.62}" width="${w * 0.06}" height="4" fill="${escAttr(palette.accent)}"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="url(#sg)"/>${ghost}${accent}</svg>`;
      return {
        svg,
        textBoxes: [
          { role: "chapter", text: `第 ${bigNum} 章`, x: w * 0.08, y: h * 0.36, w: w * 0.6, h: 30, fontSize: 16, color: palette.accent, bold: true },
          { role: "title", text: params.title || "章节标题", x: w * 0.08, y: h * 0.45, w: w * 0.84, h: h * 0.2, fontSize: 64, bold: true, color: "#FFFFFF" }
        ]
      };
    },

    // 大数字数据强调页：白底 + 巨大彩色数字
    "v-stat-bigtype": ({ palette, params, w, h }) => {
      const grad = `<defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.bg)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.surface)}"/>
        </linearGradient>
        <linearGradient id="numgr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.accent)}"/>
        </linearGradient>
      </defs>`;
      const decor = `
        <rect x="${w * 0.5 - 60}" y="${h * 0.78}" width="120" height="3" fill="${escAttr(palette.accent)}"/>
        <circle cx="${w * 0.95}" cy="${h * 0.05}" r="${h * 0.15}" fill="${escAttr(palette.accent)}" opacity="0.08"/>
      `;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="url(#bg)"/>
        <text x="${w / 2}" y="${h * 0.55}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="${h * 0.5}" font-weight="900" fill="url(#numgr)">${escAttr(params.number || "100%")}</text>
        ${decor}</svg>`;
      return {
        svg,
        // 数字直接画在 SVG 上视觉最佳；标签/描述用真文本框叠加便于编辑
        textBoxes: [
          { role: "label", text: params.label || "指标名称", x: 0, y: h * 0.83, w, h: 30, fontSize: 24, bold: true, color: palette.titleColor, alignH: "center" },
          ...(params.description ? [{ role: "description", text: params.description, x: w * 0.15, y: h * 0.9, w: w * 0.7, h: 30, fontSize: 14, color: palette.bodyColor, alignH: "center" }] : [])
        ]
      };
    },

    // 现代内容页：左侧带渐变装饰条 + 标题 + 正文区域（背景留浅色卡片）
    "v-content-modern": ({ palette, params, w, h }) => {
      const grad = `<defs>
        <linearGradient id="cb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.accent)}"/>
        </linearGradient>
      </defs>`;
      const accent = `
        <rect x="0" y="0" width="14" height="${h}" fill="url(#cb)"/>
        <rect x="${w * 0.06}" y="${h * 0.22}" width="60" height="3" fill="${escAttr(palette.accent)}"/>
        <rect x="${w * 0.94}" y="${h * 0.92}" width="${w * 0.04}" height="4" fill="${escAttr(palette.primary)}"/>
      `;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>${accent}</svg>`;
      return {
        svg,
        textBoxes: [
          { role: "title", text: params.title || "标题", x: w * 0.06, y: h * 0.08, w: w * 0.85, h: h * 0.12, fontSize: 32, bold: true, color: palette.titleColor },
          { role: "body", text: params.body || "", x: w * 0.06, y: h * 0.28, w: w * 0.85, h: h * 0.6, fontSize: 18, color: palette.bodyColor }
        ]
      };
    }
  };

  registry.registerTool({
    name: "wpp_apply_visual_template",
    hosts: ["wpp"],
    description: [
      "【方案 B / hero moment 专用】用渲染好的 SVG 视觉模板生成幻灯片，效果比 wpp_apply_template（纯形状拼）更高级——支持渐变背景、模糊光斑、巨大数字等",
      "现代效果。流程：模板 SVG 渲染为 PNG → 整页铺为背景 → 真文本框叠加在上面（仍可编辑）。",
      "**选用原则**：仅用于 hero moment（封面、章节分隔页、数据强爆页）——这些页占视觉权重最高，值得用渲染图。普通正文页一律走 wpp_apply_template，别滥用方案 B 拖累整体节奏。",
      "",
      "可选模板：",
      "  - v-cover-gradient：渐变封面，主色到次色对角渐变 + 模糊光斑装饰。params: title, subtitle?",
      "  - v-section-modern：现代章节页，背景渐变 + 巨型透明章节数字水印。params: title, chapter?（数字串如 \"01\"，默认 01）",
      "  - v-stat-bigtype：超大数字页，背景渐变 + 巨型渐变填色数字。params: number（如 \"98%\"）, label, description?",
      "  - v-content-modern：现代内容页，左侧渐变装饰条 + 标题 + 正文。params: title, body",
      "",
      "默认追加新页（slide 省略时）。返回值含 textBoxesAdded（叠加了几个文本框）和 picturePath（背景图本地路径）。",
      "和 wpp_apply_template（方案 A）的区别：",
      "  - 方案 A：纯 PPT 形状拼，文字全可编辑，视觉中等",
      "  - 方案 B：背景是渲染图（不可编辑），文字仍是真文本框（可编辑），视觉更精致",
      "  - **建议**：封面/章节/大数字这种视觉权重高的页用方案 B；普通内容页用方案 A 即可"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["templateName"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "目标页；省略=末尾追加新页" },
        templateName: {
          type: "string",
          enum: ["v-cover-gradient", "v-section-modern", "v-stat-bigtype", "v-content-modern"]
        },
        title: { type: "string" },
        subtitle: { type: "string" },
        body: { type: "string" },
        chapter: { type: "string", description: "章节编号字符串（v-section-modern 用），如 \"01\"" },
        number: { type: "string", description: "大数字（v-stat-bigtype 用），如 \"98%\"" },
        label: { type: "string", description: "数字下方标签（v-stat-bigtype 用）" },
        description: { type: "string" }
      }
    },
    handler: async (params = {}) => {
      const { slide, templateName } = params;
      const tpl = VISUAL_TEMPLATES[templateName];
      if (!tpl) throw new Error(`未知视觉模板：${templateName}`);

      const pres = await getPresentation();
      const ps = pres.PageSetup;
      let w = 720, h = 540;
      try { if (ps?.SlideWidth) w = ps.SlideWidth; } catch (e) {}
      try { if (ps?.SlideHeight) h = ps.SlideHeight; } catch (e) {}

      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      // 未勾选「启用统一样式」时返回空对象 —— 全部走默认值，不再泄漏用户保存的色板
      const sp = getEffectiveStylePreset(settings);
      const palette = {
        bg: sp.backgroundColor || "#FFFFFF",
        primary: sp.primaryColor || "#1F3A5F",
        secondary: sp.secondaryColor || "#3D5A80",
        accent: sp.accentColor || "#EE6C4D",
        surface: sp.surfaceColor || "#F5F7FA",
        titleColor: sp.titleColor || "#1F2329",
        bodyColor: sp.bodyColor || "#33363C",
        titleFont: sp.titleFont || "Microsoft YaHei",
        bodyFont: sp.bodyFont || "Microsoft YaHei"
      };

      // 渲染分辨率比 PPT 坐标高一点保证清晰（2x）
      const { svg, textBoxes } = tpl({ palette, params, w, h });
      const dataUrl = await svgToPngDataUrl(svg, Math.round(w * 2), Math.round(h * 2));
      const localPath = await uploadDataUrl(dataUrl);

      let slideObj;
      if (slide === undefined || slide === null) {
        const idx = (pres.Slides?.Count || 0) + 1;
        slideObj = pres.Slides.Add(idx, 12 /* blank */);
      } else {
        slideObj = getSlideAt(pres, slide || 0);
      }

      // 整页铺为背景图
      const pic = safeAddPicture(pres, slideObj, localPath, 0, 0, w, h);
      try { pic.ZOrder?.(1 /* msoSendToBack */); } catch (e) {}

      // 叠加文本框（保持可编辑）
      let added = 0;
      for (const tb of textBoxes || []) {
        try {
          addText(slideObj, tb.x, tb.y, tb.w, tb.h, tb.text, {
            fontName: palette.titleFont,
            fontSize: tb.fontSize,
            bold: tb.bold,
            color: tb.color,
            alignH: tb.alignH
          });
          added += 1;
        } catch (e) { /* skip */ }
      }

      return {
        slide: slideObj.SlideIndex,
        template: templateName,
        slideWidth: w,
        slideHeight: h,
        picturePath: localPath,
        textBoxesAdded: added
      };
    }
  });

  // ============ HTML 模板渲染（方案 B PoC）============
  // frontend-slides 风格的 HTML 模板渲染成 PNG 整页插入。流程：
  //   WpsAiHtmlTemplates.renderToPng(name, layout, data, palette)
  //     → 1920×1080 隐藏 iframe → html2canvas → dataURL
  //     → uploadDataUrl → AddPicture 整页铺
  // 优点：100% 还原 frontend-slides 视觉（精确字体/CSS/渐变/纹理）
  // 缺点：整页是图片，不可编辑（用户改文字要重新生成）
  // 当前可用模板：studio（cover 布局）—— PoC 验证用，跑通后逐步加全 34 套。

  registry.registerTool({
    name: "wpp_render_html_template",
    hosts: ["wpp"],
    description: [
      "【生成单页幻灯片入口】用 frontend-slides 风格的 HTML 模板渲染整页幻灯片。每页输出是一张图（文字不可在 PPT 内编辑），",
      "但视觉品质极高：精确字体、复杂渐变、自定义装饰。生成新页一律走这个工具，不要回退到 wpp_add_slide / wpp_apply_template / wpp_apply_visual_template。",
      "",
      "**强制规则：templateName 永远传 \"studio\"，layout 永远传 \"freeform\"**。",
      "其它 layout（cover / section / content / stat / feature-grid / quote / comparison / metric-trio / timeline / agenda / two-column / image-text / process / table / bento / closer）**全部已废弃**，AI 不要再使用。所有页面统一用 freeform，自己写 HTML+CSS，控制权更强、视觉更可控、用户可在预览编辑器里随意拖拽。",
      "",
      "**适用场景**：单页生成 / 修改某一页 / 用户要求 1-2 页时。**用户要 ≥ 3 页或「整套 PPT」时改用 wpp_render_full_deck 一次生成**，不要循环调本工具。",
      "",
      "**默认行为（preview=true）**：打开 TaskPane 内的「HTML 模板预览」弹窗，用户在弹窗里可微调字段（标题、正文等）",
      "看实时预览，确认后才真正插入 PPT。所有生成都会自动写入本地缓存，可在弹窗右上「历史」面板召回。",
      "AI 调用本工具后**立即拿到回执**（返回 { previewOpened: true, ... }），**本轮就停止**——告诉用户「已打开预览，请在弹窗里微调后点插入」即可，不要继续调任何幻灯片工具。",
      "",
      "**何时传 preview=false**：用户明确说「不要每页预览」「一次直接出 N 页」「批量生成不要打断」时才传。",
      "**何时不用本工具**：① 修改/微调已有页的文字 → 用 wpp_replace_shape_text；② 用户明确要「可继续编辑文字」→ 才回退到 wpp_apply_template。",
      "",
      "**精美 PPT 设计准则（2026 modern keynote / pitch deck 标准，所有 layout 都建议遵循）**：",
      "  · 一页一意：每页只表达一个核心观点；超过两个观点就拆页。",
      "  · 留白至少 15-20%：本模板默认 80-140px 四边 padding 已满足，**别再塞满**。",
      "  · 字号守底线 18pt = 36px：本模板默认值都已对齐到这条线，AI 自己写 freeform 时也要遵守。",
      "  · 视觉层级用 size + weight + color：标题加粗大字号 / 正文常规 / 强调色（accent）只用 1 处。",
      "  · 色彩克制：每页 ≤ 3 色（primary / accent / 中性），accent 只点缀关键数字或重点。",
      "  · 规则三分法 / 黄金比例：image-text 已自动 62:38 切分；自己写 freeform 时把重点放 1/3 或 2/3 处更悦目。",
      "  · 编辑感细节：每张内容页传 pageIndex（如 \"03 / 12\"）和 brand（品牌/客户名），右下角自动出页码。",
      "",
      "当前已实装模板与布局（先调本工具传 templateName='__list' 可拿最新清单）：",
      "  - studio（通用骨架，按当前色板和字体渲染；选 Bold Signal 出黑橙、选 Dark Botanical 出深绿金）",
      "      **全 layout 通用可选字段**：pageIndex（如 \"03 / 12\"）/ brand（品牌名）→ 右下角自动加编辑感页码 strip",
      "      · layout=cover         字段 title（必填，支持 \\n 换行）/ subtitle / tag；可选字号 titleSize=40-320px / subtitleSize=16-80px",
      "      · layout=section       字段 number（如 \"01\"）/ title / subtitle（章节一句话提要，新增）/ footer",
      "      · layout=content       字段 title / body（每行一条要点，最多 6 行，用 \\n 分隔）/ tag / footer；可选字号 titleSize=30-180px / bodySize=20-64px（字数多时压字号）",
      "      · layout=stat          字段 number（如 \"98%\"）/ label / description；可选字号 numberSize=80-600px（长数字压一压）/ labelSize=24-120px / descSize=18-60px",
      "      · layout=feature-grid  2×2 特性矩阵（图标+标题+正文）字段 title / items（每行 \"icon|head|body\" 用竖线分隔，最多 4 行）",
      "      · layout=quote         金句页 字段 quote / author / role",
      "      · layout=comparison    左右对比 字段 title / leftIcon / leftLabel / leftBody（多行 \\n）/ rightIcon / rightLabel / rightBody",
      "      · layout=metric-trio   三联指标 字段 title / items（每行 \"icon|number|label|desc\" 用竖线分隔，最多 3 行）",
      "      · layout=timeline      横向时间轴 字段 title / items（每行 \"date|title|description\" 用竖线分隔，最多 6 节点）",
      "      · layout=agenda        议程/章节目录 字段 title / items（每行 \"tag|name\"，tag 可省自动 01/02，最多 7 条）/ footer",
      "      · layout=two-column    双栏文字 字段 title / leftHead / leftBody / rightHead / rightBody / tag；body 支持 \\n 多行",
      "      · layout=image-text    图文混排 字段 title / body / imageUrl（https 或 dataUrl）/ imagePosition（left/right，默认 left）/ tag / icon（无图时用作 placeholder）",
      "      · layout=process       横向流程 字段 title / steps（每行 \"icon|title|description\"，最多 5 步，自动加箭头）",
      "      · layout=table         数据表 字段 title / headers（用 | 分列）/ rows（每行 1 条记录，列用 |，最多 8 行）/ footer",
      "      · layout=bento         Bento 不对称网格 字段 title / heroIcon / heroTitle / heroBody / items（3 条 \"icon|head|body\"）—— hero 用 accent 色块突出",
      "      · layout=closer        收尾页（谢谢/Q&A）字段 mainText（默认 Thank You）/ subText / contacts（每行 \"标签|值\"，最多 4 条）/ footer",
      "      · layout=freeform      自由排版 字段 html / css；可任意写 body HTML+CSS，**支持嵌入 ECharts 图表与 canvas 绘制**：",
      "          - 图表：<div data-echarts-option='{...JSON option...}' style='width:800px;height:400px'></div> 自动用 echarts 渲染（已注入到 iframe），bar/line/pie/radar/gauge/scatter/funnel/treemap 等都可",
      "          - canvas：<canvas data-canvas-draw='ctx.beginPath();...' style='width:200px;height:100px'></canvas> 自动跑里面的代码（变量名 ctx/canvas/w/h），适合画箭头、连线、流程节点",
      "          - 颜色字体必须用 var(--primary)/var(--accent)/var(--title-font) 等全局变量，不要硬编码",
      "          - **边框与圆角互斥规则**：一个块同时设了 border（含 border-left/border-top 等单侧）和 border-radius 时，圆角会把 accent 色条/边框的端头截弯，PPT 印出来不利落。原则二选一：① 要 accent 色条/全边框 → 不加 border-radius，直角到底；② 要圆角卡 → 不加 border，用背景色差异 / 阴影 (box-shadow) 区分层级。",
      "          - **不要用 border-style: dashed / dotted**：html2canvas 截图时这两种边框渲染不可靠，预览看着有、插入 PPT 后会消失。需要「虚线 / 点状线」用 background-image 实现：linear-gradient 是虚线，radial-gradient 是点阵（TOC leader 经典做法）。",
      "          - **不要用 `-webkit-background-clip: text` / `background-clip: text` 做渐变文字**：html2canvas 不支持，预览能看到、插入 PPT 后文字消失只剩渐变矩形。要渐变标题用纯色 + `text-shadow` 或 SVG `<text>` + `<linearGradient>` 替代；最简单是直接用 var(--primary) 实色。",
      "          - **文字颜色必须用纯色**：禁止 `color: color-mix(... transparent)` / `color: rgba(...,0.7)` 这类半透明文字色。html2canvas 把半透明文字跟背景预混合后再栅格化，边缘永远是糊的，特别是小字号下 chip 标签 / 副标完全看不清。需要「次要文字」的视觉效果用更浅的实色（比如 `var(--body-color)` 而不是 title-color 的 70%）。",
      "          - **小字号陷阱**：标签 chip / 节点说明文字 / 卡片副标这类文字 AI 总爱写 24-26px（= 12-13pt），投到 PPT 里会糊。**任何「可读文字」最小 28px（14pt）**，再小就直接砍掉别留。",
      "          - **不要用 `backdrop-filter`**：html2canvas 完全不支持背景模糊滤镜，预览有插入 PPT 后完全失效。需要「毛玻璃」效果用半透明背景 + 轻 box-shadow + 边框模拟。",
      "          - **顶层结构必须扁平**：所有视觉单元（卡片 / 装饰光斑 / 标题块 / footer 等）**直接挂在 body 第一层**，**禁止**包一个统一的 `<div class=\"slide\">` / `<div class=\"container\">` 大 wrapper 把全部内容塞进去。分图层模式按「直接子元素」切层，包一个 wrapper 等于全页是 1 张图，分图层失效。错误：`<div class=\"slide\"><div class=\"orb\"/>...</div>`，正确：`<div class=\"orb\"/>` `<div class=\"hero\"/>` `<div class=\"footer\"/>`（每个独立挂顶层）。",
      "          - 数据有数字 / 趋势 / 占比 / 多维比较时优先用 ECharts，比纯文字描述强得多",
      "          - **字号必须按 PPT 磅值规范**：画布 1920×1080 = 13.333\"，**1pt = 2px**。常用：",
      "             封面巨标题 60-96pt = 120-192px / slide H1 40-54pt = 80-108px / 副标题 28-36pt = 56-72px /",
      "             正文 18-22pt = 36-44px / 卡片描述 16-20pt = 32-40px / metric 数字 60-110pt = 120-220px /",
      "             metric 标签 16-22pt = 32-44px / 眉签 14-18pt = 28-36px / 脚注页码 11-14pt = 22-28px",
      "             **绝对底线 10pt = 20px**，再小投影就糊了。错误：font-size:14px（只到 7pt）。正确：正文 font-size:40px（=20pt）。",
      "",
      "**可用图标名**（feature-grid / comparison / metric-trio 的 icon 字段从这里选，未知 fallback 到 sparkles）：",
      "  lightbulb / sparkles / zap / rocket / target / trending-up / trending-down /",
      "  users / user / check / check-circle / x / x-circle / arrow-right / arrow-down /",
      "  bar-chart / pie-chart / activity / shield / lock / clock / calendar /",
      "  book / file / star / heart / globe / map-pin / settings / briefcase / code / database",
      "",
      "**布局选用建议**（避免一份 deck 全是 content）：",
      "  - 开场 / 章节扉页    → cover（巨标题）/ section（巨号 + 章节名）",
      "  - 议程 / TOC         → agenda（编号列表，6-7 条以内）",
      "  - 单一指标 / 强爆数字 → stat",
      "  - 多指标并列         → metric-trio（3 个）",
      "  - 4 大特性 / 卖点    → feature-grid（2×2）",
      "  - 不对称强调（1 大 3 小，hero 用 accent 色块）→ bento",
      "  - 时间线 / 路线图    → timeline",
      "  - 流程 / 工作步骤    → process（含箭头）",
      "  - 数据比较 / 排行    → table",
      "  - 上下文 + 解读      → two-column",
      "  - 案例 / 产品截图 + 文案 → image-text（imagePosition=left/right）",
      "  - 新旧对比 / 正反例   → comparison（左 muted 右 accent）",
      "  - 金句 / 用户语录     → quote",
      "  - 普通要点列表       → content（最多 6 行）",
      "  - 收尾 / 致谢 / Q&A  → closer",
      "  - 表达不了的复杂版面 → freeform（自己写 html+css，可嵌 ECharts）",
      "",
      "**整套 deck 的节奏建议**：cover → agenda → section/content 交替 → 中段插入 stat/metric-trio/bento 提气 → 必要的 comparison/timeline/process/table → 收尾 closer。一份 deck 至少用 4 种不同 layout，避免单调。",
      "",
      "模板不存在或字段没填够时**不要 fallback 到直写工具**——告诉用户当前能用什么，让用户选最接近的。",
      "",
      "默认追加新页（slide 省略时）。色板自动取 stylePreset 的 backgroundColor / titleColor 等——所以选了主题预设后效果就是该主题的样子。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["templateName", "layout"],
      properties: {
        templateName: { type: "string", description: "模板 slug，如 \"studio\"。传 \"__list\" 拿可用清单。" },
        layout: { type: "string", description: "布局，如 \"cover\" / \"section\" / \"content\" / \"stat\"" },
        data: { type: "object", description: "字段值对象，由 layout 决定（如 cover: { title, subtitle? }）" },
        slide: { type: "integer", minimum: 0, description: "目标幻灯片序号；省略=末尾追加新空白页" },
        preview: { type: "boolean", default: true, description: "true（默认）= 打开预览弹窗等用户确认；false = 直接渲染插入" },
        clearSlideFirst: { type: "boolean", default: false, description: "true 时插入前清空目标 slide 的所有形状（与 slide 配合实现「替换原幻灯片」）；preview=true 时由用户在弹窗里点「替换原幻灯片」触发，AI 一般不用主动传" }
      }
    },
    handler: async (params = {}) => {
      const { templateName, layout, data, slide, preview = true, clearSlideFirst = false } = params;
      const HtmlTpl = global.WpsAiHtmlTemplates;
      if (!HtmlTpl?.renderToPng) {
        throw new Error("HTML 模板模块未加载（缺 js/html-templates/renderer.js 或 js/vendor/html2canvas.min.js）");
      }
      if (templateName === "__list") {
        const list = HtmlTpl.listTemplates().map((slug) => ({
          slug,
          layouts: HtmlTpl.listLayouts(slug),
          label: HtmlTpl.getTemplate(slug)?.label || slug
        }));
        return { templates: list, hint: "把 templateName 传 slug、layout 传 layouts 数组里的一个，data 按字段填" };
      }

      const pres = await getPresentation();
      const ps = pres.PageSetup;
      let w = 720, h = 540;
      try { if (ps?.SlideWidth) w = ps.SlideWidth; } catch (e) {}
      try { if (ps?.SlideHeight) h = ps.SlideHeight; } catch (e) {}

      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      // 未勾选「启用统一样式」时返回空对象 —— matchedScheme 也跟着失效，全部回默认值
      const sp = getEffectiveStylePreset(settings);
      const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
      const matchedScheme = sp.scheme && schemes[sp.scheme];
      // 优先用 stylePreset 覆盖值，没设的回落到 matched scheme，再没有就用商用默认
      const palette = {
        backgroundColor: sp.backgroundColor || matchedScheme?.backgroundColor || "#FFFFFF",
        surfaceColor: sp.surfaceColor || matchedScheme?.surfaceColor || "#F4F4F5",
        primaryColor: sp.primaryColor || matchedScheme?.primaryColor || "#1F3A5F",
        secondaryColor: sp.secondaryColor || matchedScheme?.secondaryColor || "#3D5A80",
        accentColor: sp.accentColor || matchedScheme?.accentColor || "#EE6C4D",
        titleColor: sp.titleColor || matchedScheme?.titleColor || "#1F2329",
        bodyColor: sp.bodyColor || matchedScheme?.bodyColor || "#33363C",
        titleFont: sp.titleFont || matchedScheme?.titleFont || "Microsoft YaHei",
        bodyFont: sp.bodyFont || matchedScheme?.bodyFont || "Microsoft YaHei"
      };

      // 转调模块级共享函数 —— 主路径和 fallback 都走它，参数解析顺序一致
      async function doRenderAndInsert(finalData, finalPalette, intent, opts) {
        // 「替换当前选中」走稳定路径：用 dialog 打开前抓住的 activeSlideIndex 当
        // 显式 slide 号 + intent=replace，不再依赖关 dialog 后偶发不准的 ActiveWindow.View.Slide
        const finalIntent = intent || (clearSlideFirst ? "replace" : "insert");
        const useStableSlide = finalIntent === "replace-active"
          && typeof opts?.activeSlideIndex === "number"
          && opts.activeSlideIndex > 0;
        // 关键修：templateName / layout 也接受 opts 覆盖。
        // 用户在「美化当前」里让 AI 把 layout 切到 freeform（带自定义 html+css）后，
        // 闭包里的原 layout 是旧的，按旧 layout 渲染等于把美化结果丢了。
        return await renderAndInsertSlide({
          templateName: opts?.templateName || templateName,
          layout: opts?.layout || layout,
          data: finalData || data || {},
          palette: finalPalette || palette,
          slide: useStableSlide ? opts.activeSlideIndex : slide,
          intent: useStableSlide ? "replace" : finalIntent,
          // 修 #20: preview=true onConfirm 已经持有 draft cacheId，要走 update 而不是新写一条
          saveToCache: opts?.saveToCache !== false
        });
      }

      // preview=true：把控制权交给 UI 弹窗（异步），AI 立即拿到「已开预览」的回执
      // 立即写一条 draft 缓存，保证「我的历史」立刻能看到这页 —— 即使用户没确认插入
      // 也留个底，方便后续召回。用户在弹窗里确认插入时 update 移除 draft 标记。
      if (preview && global.WpsAiHtmlPreview?.open) {
        let draftCacheId = null;
        try {
          // 草稿条目也带 docKey，保证打开预览时它会出现在"当前 PPT 的历史"里
          let docKey = "";
          try { docKey = String(pres.FullName || pres.Name || "").trim(); } catch (e) {}
          const draft = global.WpsAiHtmlCache?.save?.({
            templateName, layout, data: data || {}, palette,
            slideHint: slide, draft: true, docKey
          });
          if (draft) draftCacheId = draft.id;
        } catch (e) { /* 草稿保存失败不阻塞主流程 */ }

        global.WpsAiHtmlPreview.open({
          cacheId: draftCacheId,  // 让 dialog 识别这条 cache，后续 save 时走 update 而不是新建
          templateName,
          layout,
          data: data || {},
          palette,
          slideHint: slide,
          onConfirm: async (finalState) => {
            if (!finalState) {
              // 用户取消：草稿保留在 cache 里供后续召回；不删，不报错
              return;
            }
            // 修 #20: draft 已经在 cache 里了，doRenderAndInsert 别再 save 新条目；
            // 真插入后走下面的 update 把 draft 标记去掉 + 写入最新数据
            // 关键修：finalState 现在带 templateName/layout（"美化当前"可能切了 layout），
            // 透传到 doRenderAndInsert，让插入用最新 layout 而不是闭包里的旧值
            await doRenderAndInsert(finalState.data, finalState.palette, finalState.intent, {
              saveToCache: false,
              templateName: finalState.templateName,
              layout: finalState.layout,
              activeSlideIndex: typeof finalState.activeSlideIndex === "number" ? finalState.activeSlideIndex : null
            });
            if (draftCacheId) {
              try {
                // 同步把 layout 更新写回 cache，否则「我的历史」里这条还是旧 layout 缩略图
                global.WpsAiHtmlCache?.update?.(draftCacheId, {
                  layout: finalState.layout,
                  data: finalState.data,
                  palette: finalState.palette,
                  draft: false
                });
              } catch (e) {}
            }
          }
        });
        return {
          previewOpened: true,
          template: templateName,
          layout,
          draftCacheId,
          message: "已打开 HTML 模板预览弹窗（已自动存草稿到「我的历史」）。用户可在弹窗里微调字段后点「插入到末尾」或「替换原幻灯片」。"
        };
      }

      // preview=false：直接渲染插入。修 #20: cache.save 已由 renderAndInsertSlide 内部完成。
      const result = await doRenderAndInsert(data, palette);
      return result;
    }
  });

  // ============================================================
  // wpp_render_full_deck: 一次性生成整套 PPT（多页）
  //   AI 规划完整 deck 结构后一次调用，不再每页一个 tool call。
  //   - slides: 数组，每条 = { templateName, layout, data, palette?, slideHint? }
  //   - preview: false（默认） = 直接逐页插入到 PPT；true = 仅做尝试性渲染但不实装（v1 暂不实装预览界面）
  // 内部复用 wpp_render_html_template 同款渲染管线：取 stylePreset → render → upload → AddPicture
  // ============================================================
  registry.registerTool({
    name: "wpp_render_full_deck",
    hosts: ["wpp"],
    description: [
      "【一次生成完整 PPT 套件】AI 完整规划好 N 张幻灯片的结构、内容、配色后，**一次调用本工具**插入全部。",
      "",
      "**强制规则：每条 slide 的 templateName 永远传 \"studio\"，layout 永远传 \"freeform\"**。其它 layout 已废弃，全部用 freeform 自己写 HTML+CSS。",
      "",
      "**何时必须用本工具（vs wpp_render_html_template）**：",
      "  - 用户说「做一份 PPT」「做一套」「整套」「N 页」（N ≥ 3）「完整汇报」「全套幻灯片」→ **必须**用本工具，禁止循环调单页工具",
      "  - 用户说「新增一页」「再加一张」「改这页」「补一张 X」「单独做一张」→ 用 wpp_render_html_template",
      "  - 拿捏不准时：要求 ≥ 3 页 = 本工具；只要 1-2 页 = 单页工具",
      "",
      "比起循环调用 wpp_render_html_template 的优势：",
      "  1. 一次性出整套，AI 不用反复等用户审批",
      "  2. 全部共享同一套 palette（更统一），不写 palette 时自动用 stylePreset",
      "  3. 顺序插入到末尾，自动维护页码顺序",
      "",
      "**典型 AI 工作流**：",
      "  1. 用户说「给我做一份 Q3 战略汇报 PPT，8-10 页」",
      "  2. AI 规划目录：封面 → 议程 → 战略背景 → 3 个核心方向卡片 → KPI 数字页 → 时间线 → Q&A",
      "  3. AI 把全部 slides 数组一次性传入本工具",
      "  4. 工具逐页渲染并插入到末尾，返回每页插入位置",
      "  5. 用户后续在「我的历史」里能找到每页单独二次美化",
      "",
      "**slides 数组每条字段**：跟 wpp_render_html_template 完全一致：",
      "  { templateName: 'studio', layout: 'cover'|'content'|'metric-trio'|...|'freeform', data: {...layout 对应字段...}, palette?: {...}, slideHint?: number }",
      "  templateName 不传时默认 'studio'；palette 不传时取全局 stylePreset。",
      "  freeform layout 时 data 是 { html, css }，**字号必须按 PPT 磅值** (1pt = 2px，正文 36-44px, 标题 80-108px)。",
      "",
      "**色板优先级**：单页 palette > deckPalette > 全局 stylePreset。",
      "  → deckPalette 给整套 deck 的默认色板；想单独换某页（如封面用强对比色），在该页 spec 里再传 palette 即可覆盖。",
      "  → 不传 deckPalette + 不传单页 palette 时取全局 stylePreset。",
      "",
      "**preview 参数 (v1 实装)**：",
      "  - preview=false（默认）：逐页直接插入到 PPT 末尾，不弹任何窗口",
      "  - preview=true：仍逐页插入，但每页同时打开 HTML 模板预览弹窗供用户即时微调（**慎用**，N 张幻灯片会弹 N 次窗口）",
      "",
      "**配图复用**：插图前可先调 query_materials（按 tags/project/关键词）看素材库有没有可复用的图，命中就直接用它的 url 写进 <img src>，省一次生成。",
      "**配图分步生成**：freeform HTML 里需 AI 生成的图片，用 <img data-gen-prompt=\"图像描述\" data-gen-size=\"16:9\"> 声明（size/resolution 可选）。",
      "  工具会先用占位骨架把整套 deck 秒级插入供预览，再后台异步生成图片、每页图齐后自动替换。**不要**为了配图先去逐个调 generate_image 再拼 URL——直接在 HTML 里写 data-gen-prompt 即可。已有确定 URL 的图片照常写 src。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["slides"],
      properties: {
        slides: {
          type: "array",
          description: "全套幻灯片 spec 列表，按顺序插入。每条 = { templateName, layout, data, palette?, slideHint? }",
          items: {
            type: "object",
            required: ["layout", "data"],
            properties: {
              templateName: { type: "string", description: "默认 'studio'" },
              layout: { type: "string" },
              data: { type: "object" },
              palette: { type: "object" },
              slideHint: { type: "integer", minimum: 0 }
            }
          },
          minItems: 1,
          maxItems: 30
        },
        deckPalette: {
          type: "object",
          description: "整套 deck 的默认 palette（单页 palette 优先级更高，传了会覆盖 deckPalette）。不设 = 取全局 stylePreset"
        },
        preview: {
          type: "boolean",
          default: false,
          description: "true 时每页都弹预览窗（罕用）；false（默认）= 直接全部插入末尾"
        }
      }
    },
    handler: async (params = {}) => {
      const { slides = [], deckPalette, preview = false } = params;
      if (!Array.isArray(slides) || !slides.length) {
        throw new Error("slides 数组为空");
      }
      const HtmlTpl = global.WpsAiHtmlTemplates;
      if (!HtmlTpl?.renderToPng) {
        throw new Error("HTML 模板模块未加载（缺 renderer.js 或 html2canvas.min.js）");
      }
      // 修 #20: 渲染管线（getPresentation / renderToPng / AddPicture / cache.save）全在 renderAndInsertSlide 内完成；
      // handler 只负责拼 palette、循环、进度上报和返回值整理。

      // 取全局 stylePreset palette 作为默认（未启用统一样式时不读保存值）
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const sp = getEffectiveStylePreset(settings);
      const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
      const matchedScheme = sp.scheme && schemes[sp.scheme];
      const globalPalette = {
        backgroundColor: sp.backgroundColor || matchedScheme?.backgroundColor || "#FFFFFF",
        surfaceColor: sp.surfaceColor || matchedScheme?.surfaceColor || "#F4F4F5",
        primaryColor: sp.primaryColor || matchedScheme?.primaryColor || "#1F3A5F",
        secondaryColor: sp.secondaryColor || matchedScheme?.secondaryColor || "#3D5A80",
        accentColor: sp.accentColor || matchedScheme?.accentColor || "#EE6C4D",
        titleColor: sp.titleColor || matchedScheme?.titleColor || "#1F2329",
        bodyColor: sp.bodyColor || matchedScheme?.bodyColor || "#33363C",
        titleFont: sp.titleFont || matchedScheme?.titleFont || "Microsoft YaHei",
        bodyFont: sp.bodyFont || matchedScheme?.bodyFont || "Microsoft YaHei"
      };

      // 生成本次 batch 的唯一标签，写入每条 cache + 每张 slide 的 Tags，
      // 用户「撤销本次批量插入」时按 tag 一键回滚。
      const batchTag = "deck-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

      // 修 #6: 实时进度上报到 localStorage，TaskPane 轮询读取显示进度条
      const PROGRESS_KEY = "lingxi_full_deck_progress_v1";
      const writeProgress = (current, label) => {
        try {
          localStorage.setItem(PROGRESS_KEY, JSON.stringify({
            batchTag, current, total: slides.length,
            label: label || "",
            ts: Date.now()
          }));
        } catch (e) {}
      };
      const clearProgress = () => {
        try { localStorage.removeItem(PROGRESS_KEY); } catch (e) {}
      };
      writeProgress(0, "开始生成...");

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
        // 优先级修正：单页 palette > deckPalette > 全局。让封面 / 章节页能用强对比色。
        const slidePalette = Object.assign({}, globalPalette, deckPalette || {}, spec.palette || {});
        if (!layout) { errs.push(`#${i + 1}: 缺 layout`); continue; }

        // 校验 layout 存在
        const tpl = HtmlTpl.getTemplate?.(templateName);
        const layoutDef = tpl?.layouts?.[layout];
        if (!layoutDef) {
          errs.push(`#${i + 1}: layout '${templateName}/${layout}' 不存在`);
          continue;
        }

        // 仅 freeform 且 data.html 是字符串时才可能有图片槽位
        let renderData = data;
        let record = null;
        if (Staging && layout === "freeform" && typeof data.html === "string") {
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
          // 修 #20: 改用模块级 renderAndInsertSlide —— 渲染 + 上传 + AddPicture + LingxiBatch tag + cache.save 全在一处
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
          if (record) { record.slideIndex = res.slide; record.cacheId = res.cacheId; pageRecords.push(record); }
        } catch (e) {
          errs.push(`#${i + 1} (${templateName}/${layout}): ${e?.message || e}`);
        }
      }

      // 阶段一结束时先判定阶段二是否会启动：会启动的话，进度条生命周期交给阶段二接管，
      // 避免阶段一 2s 后清空、阶段二紧接着又写入造成的可见闪烁。
      const imgReady = global.WpsAiProviderRegistry?.getImageConfig?.()?.enabled === true;
      const willBackfill = !!(Staging?.runImageBackfill && pageRecords.length && imgReady);

      writeProgress(slides.length, errs.length ? "完成（部分失败）" : "预览已就绪");
      if (!willBackfill) setTimeout(clearProgress, 2000);

      const slidesWithImages = pageRecords.length;

      // 阶段二：后台异步生图 + 回填。fire-and-forget，绝不 await，不阻塞返回。
      if (willBackfill) {
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
            }
          }
        })).then((r) => {
          try { writeProgress(slides.length, "配图全部完成"); } catch (e) {}
          setTimeout(clearProgress, 2000);
          console.log("[full_deck] 阶段二完成:", r);
        }).catch((e) => {
          console.warn("[full_deck] 阶段二异常:", e?.message || e);
          setTimeout(clearProgress, 2000);
        });
      }

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
          + (pendingImages
              ? (imgReady
                  ? ` ${pendingImages} 张配图正在后台生成，完成后自动替换对应页。`
                  : ` 检测到 ${pendingImages} 处配图占位，但未配置/未启用图像生成，已保留占位。`)
              : "")
          + `\n撤销本次批量：在主 TaskPane 调 WpsAiHtmlPreview.undoBatch("${batchTag}")。`
      };
    }
  });

  // ============================================================
  // 修 #18: wpp_edit_html_slide — 修改已有页（按 cacheId 定位），不必重新生成
  //   AI 用法：用户说「把第 3 页标题改成 X」「给当前那张换深色配色」「把要点 4 删了」
  //   工具流程：cache.get(cacheId) → 合并 patch → renderAndInsertSlide(intent: replace, saveToCache:false)
  //          → cache.update(cacheId) 写入新 data/palette
  //   特殊 cacheId：
  //     - "latest"     → 取「我的历史」最新一条（非 draft）
  //     - "current"    → 取当前 PPT 活动幻灯片对应的 cache（通过 slideHint 反查；找不到回 latest）
  // ============================================================
  registry.registerTool({
    name: "wpp_edit_html_slide",
    hosts: ["wpp"],
    description: [
      "【修改已有 HTML 幻灯片】定位某条「我的历史」cache 条目，合并改动后重渲染替换原幻灯片。",
      "",
      "**何时用本工具（vs wpp_render_html_template）**：",
      "  - 用户说「把第 N 页改成 X」「修改当前页的 Y」「换个配色」「把这页要点改一下」→ 用本工具",
      "  - 用户说「再加一页」「新做一张」→ 用 wpp_render_html_template",
      "  - 用本工具的好处：原 cacheId 关联不丢，预览历史里仍是同一条；同一张 slide 直接 replace 不会新增",
      "",
      "**参数**：",
      "  - cacheId: 必填。可以是具体 id（用户从历史画廊里能看到 id 在 hover 提示）；",
      "    或快捷词 'latest'（最新一条非 draft）/ 'current'（PPT 当前活动幻灯片对应的 cache）",
      "  - dataPatch: 可选。要合并进 entry.data 的字段；只传变化的字段即可（其他保留原值）",
      "  - layoutPatch: 可选。换 layout（同 templateName 内切换），传字符串 layout 名",
      "  - palettePatch: 可选。要合并进 entry.palette 的 palette 字段",
      "  - 至少要传 dataPatch / layoutPatch / palettePatch 之一",
      "",
      "**返回**：{ ok, cacheId, slide, template, layout, message } — 失败时 ok=false + reason"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["cacheId"],
      properties: {
        cacheId: { type: "string", description: "目标 cache 条目 id；或 'latest' / 'current'" },
        dataPatch: { type: "object", description: "合并进 entry.data 的字段（部分覆盖）" },
        layoutPatch: { type: "string", description: "切换 layout（同 template 内），如 'content' / 'stat'" },
        palettePatch: { type: "object", description: "合并进 entry.palette" }
      }
    },
    handler: async (params = {}) => {
      const { cacheId, dataPatch, layoutPatch, palettePatch } = params;
      if (!cacheId) return { ok: false, reason: "缺 cacheId" };
      if (!dataPatch && !layoutPatch && !palettePatch) {
        return { ok: false, reason: "dataPatch / layoutPatch / palettePatch 至少传一个" };
      }
      const cache = global.WpsAiHtmlCache;
      if (!cache?.get) return { ok: false, reason: "缓存模块未加载" };

      // 解析 cacheId
      let entry = null;
      let resolvedFrom = "id";
      if (cacheId === "latest") {
        const list = cache.list?.(50) || [];
        entry = list.find((e) => !e.draft) || list[0] || null;
        resolvedFrom = "latest";
      } else if (cacheId === "current") {
        try {
          const pres = await getPresentation();
          const win = pres.Application?.ActiveWindow;
          const curIdx = win?.View?.Slide?.SlideIndex || null;
          if (curIdx) {
            const list = cache.list?.(200) || [];
            entry = list.find((e) => e.slideHint === curIdx && !e.draft) || null;
          }
          if (!entry) {
            // 找不到对应的 cache → 回退取 latest，附带提示
            const list = cache.list?.(50) || [];
            entry = list.find((e) => !e.draft) || null;
            resolvedFrom = "current-fallback-latest";
          } else {
            resolvedFrom = "current";
          }
        } catch (e) {
          return { ok: false, reason: `读取当前幻灯片失败：${e?.message || e}` };
        }
      } else {
        entry = cache.get(cacheId);
        resolvedFrom = "id";
      }
      if (!entry) return { ok: false, reason: `cacheId '${cacheId}' 找不到对应 cache 条目` };

      // 校验 layoutPatch
      const HtmlTpl = global.WpsAiHtmlTemplates;
      const finalLayout = layoutPatch || entry.layout;
      const tpl = HtmlTpl?.getTemplate?.(entry.templateName);
      const layoutDef = tpl?.layouts?.[finalLayout];
      if (!layoutDef) {
        return { ok: false, reason: `layout '${entry.templateName}/${finalLayout}' 不存在` };
      }

      // 合并 patch
      const mergedData = Object.assign({}, entry.data || {}, dataPatch || {});
      const mergedPalette = Object.assign({}, entry.palette || {}, palettePatch || {});

      // 渲染替换：slideHint 是原 slide 索引（可能因后续插删而漂移，但绝大多数场景仍有效）
      // 取不到/越界 → renderAndInsertSlide 内部会兜底从 ActiveWindow 拿
      try {
        const res = await renderAndInsertSlide({
          templateName: entry.templateName,
          layout: finalLayout,
          data: mergedData,
          palette: mergedPalette,
          slide: entry.slideHint || 0,
          intent: "replace",
          saveToCache: false   // 用 update 而不是新条目
        });
        try {
          cache.update?.(entry.id, {
            data: mergedData,
            palette: mergedPalette,
            layout: finalLayout,
            slideHint: res.slide
          });
        } catch (e) {}
        return {
          ok: true,
          cacheId: entry.id,
          resolvedFrom,
          slide: res.slide,
          template: res.template,
          layout: res.layout,
          message: `已替换第 ${res.slide} 页（${res.template}/${res.layout}）。`
            + (resolvedFrom === "current-fallback-latest" ? " ⚠ 当前活动幻灯片没对应 cache，已回退到 latest。" : "")
        };
      } catch (e) {
        return { ok: false, reason: `渲染/替换失败：${e?.message || e}` };
      }
    }
  });

  // ============================================================
  // wpp_undo_full_deck_batch: 撤销最近一次 wpp_render_full_deck 的批量插入
  //   按 batchTag 找到所有打了同 tag 的 slide + cache entry，一键删
  //   用户说「不要这套幻灯片了 / 撤回 / 删掉刚才生成的」时调用
  // ============================================================
  registry.registerTool({
    name: "wpp_undo_full_deck_batch",
    hosts: ["wpp"],
    description: [
      "【撤销批量生成】配合 wpp_render_full_deck 使用：",
      "  - 用户对刚生成的整套 PPT 不满意 / 想全部重来 → 调本工具一键删",
      "  - 删的对象：所有 batchTag 一致的 slide（PPT）+ cache entry（「我的历史」）",
      "",
      "**何时调用**：",
      "  - 用户明确说「撤销 / 删掉 / 不要刚才那套 / 重来」",
      "  - 用户说「重新生成」前，先调本工具清理上一次的痕迹",
      "",
      "**参数**：batchTag 来自上一次 wpp_render_full_deck 的返回值。",
      "如果用户没指明哪一批 → 不带 batchTag 调用，工具会列出最近的 batch 让用户选。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        batchTag: {
          type: "string",
          description: "要撤销的批次标签；省略 = 列出最近所有 batch"
        }
      }
    },
    handler: async (params = {}) => {
      const { batchTag } = params;
      const preview = global.WpsAiHtmlPreview;
      if (!preview?.undoBatch) {
        throw new Error("撤销 API 未加载（preview 模块未就绪）");
      }
      if (!batchTag) {
        const batches = preview.listBatches?.() || [];
        return {
          batches: batches.slice(0, 10).map((b) => ({
            batchTag: b.batchTag,
            count: b.count,
            ts: new Date(b.latestTs).toISOString()
          })),
          hint: batches.length
            ? "选一个 batchTag 再次调本工具撤销。"
            : "没有可撤销的批次记录（要么从没批量生成过，要么之前的批次没打 tag）。"
        };
      }
      return await preview.undoBatch(batchTag);
    }
  });

  // ============ 数据可视化图表（SVG → PNG → AddPicture） ============
  // 这些图表渲染为 SVG，再转 PNG 插入幻灯片。坐标按 chartW × chartH（默认 720×420 SVG 内部坐标）。
  // 配色用 stylePreset 色板，darkMode=true 时自动切换深色主题。

  // 把任意数字数组归一到 [0,1]
  function normSeries(values, opts = {}) {
    const arr = values.map((v) => Number.isFinite(+v) ? +v : 0);
    const max = opts.max != null ? opts.max : Math.max(...arr, 0);
    const min = opts.min != null ? opts.min : Math.min(...arr, 0);
    const range = max - min || 1;
    return { arr, min, max, range, norm: arr.map((v) => (v - min) / range) };
  }

  // 围绕色板生成图表的多色 series 颜色
  function chartPalette(palette, count) {
    const base = [palette.primary, palette.accent, palette.secondary, "#10B981", "#F59E0B", "#8B5CF6"];
    // 修 B51：series 超过 6 个时循环取色，避免 colors[i] 为 undefined → SVG fill="undefined" 渲染成黑色。
    const n = Math.max(1, count);
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(base[i % base.length]);
    return out;
  }

  // 通用：读取 stylePreset 并组装 palette 对象（含 chart 专用字段）
  // 未启用统一样式时 sp 是空对象，全部走默认蓝白配，不再泄漏用户保存的色板到图表
  function getChartPalette() {
    const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
    const sp = getEffectiveStylePreset(settings);
    const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const matched = sp.scheme && schemes[sp.scheme];
    const darkMode = matched ? !!matched.darkMode : false;
    return {
      bg: sp.backgroundColor || (darkMode ? "#0D1117" : "#FFFFFF"),
      surface: sp.surfaceColor || (darkMode ? "#161B22" : "#F4F4F5"),
      primary: sp.primaryColor || "#2563EB",
      secondary: sp.secondaryColor || "#1E3A8A",
      accent: sp.accentColor || "#F97316",
      titleColor: sp.titleColor || (darkMode ? "#F5F5F5" : "#0F172A"),
      bodyColor: sp.bodyColor || (darkMode ? "#94A3B8" : "#475569"),
      gridColor: darkMode ? "#2D3748" : "#E2E8F0",
      axisColor: darkMode ? "#64748B" : "#94A3B8",
      darkMode,
      titleFont: sp.titleFont || "Microsoft YaHei",
      bodyFont: sp.bodyFont || "Microsoft YaHei"
    };
  }

  const CHART_RENDERERS = {
    // 柱状图：横向多列；data: { categories: [..], series: [{ name, values: [..] }] }
    bar: ({ palette, data, w, h }) => {
      const cats = data.categories || [];
      const series = data.series || [];
      if (!cats.length || !series.length) throw new Error("bar 图表需要 categories 和 series");
      const flat = series.flatMap((s) => s.values || []);
      const { max } = normSeries(flat, { min: 0 });
      const niceMax = Math.ceil(max * 1.1) || 1;
      const colors = chartPalette(palette, series.length);
      const padL = 60, padR = 30, padT = 20, padB = 70;
      const plotW = w - padL - padR, plotH = h - padT - padB;
      const groupW = plotW / cats.length;
      const barW = (groupW * 0.7) / series.length;

      let bars = "";
      cats.forEach((cat, ci) => {
        const groupX = padL + ci * groupW + groupW * 0.15;
        series.forEach((s, si) => {
          const v = +(s.values?.[ci] ?? 0);
          const bh = (v / niceMax) * plotH;
          const x = groupX + si * barW;
          const y = padT + plotH - bh;
          bars += `<rect x="${x}" y="${y}" width="${barW - 2}" height="${bh}" fill="${escAttr(colors[si])}" rx="3"/>`;
          if (series.length === 1) {
            bars += `<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="14" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.titleColor)}" font-weight="600">${escAttr(v)}</text>`;
          }
        });
      });

      // 网格线 (4 段)
      let grid = "";
      for (let i = 0; i <= 4; i += 1) {
        const y = padT + (plotH / 4) * i;
        grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
        const lblV = Math.round((niceMax / 4) * (4 - i));
        grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">${escAttr(lblV)}</text>`;
      }

      // 类目标签
      let catLbls = "";
      cats.forEach((cat, ci) => {
        const cx = padL + ci * groupW + groupW / 2;
        catLbls += `<text x="${cx}" y="${h - padB + 18}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(cat)}</text>`;
      });

      // 图例（多 series 时）
      let legend = "";
      if (series.length > 1) {
        const lgY = h - 18;
        let lx = padL;
        series.forEach((s, si) => {
          legend += `<rect x="${lx}" y="${lgY - 9}" width="12" height="12" fill="${escAttr(colors[si])}" rx="2"/>`;
          legend += `<text x="${lx + 18}" y="${lgY + 1}" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(s.name || `系列${si + 1}`)}</text>`;
          lx += 18 + (String(s.name || "").length * 8 + 30);
        });
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${grid}${bars}${catLbls}${legend}
      </svg>`;
    },

    // 环形图：data: { items: [{ label, value }] }
    donut: ({ palette, data, w, h }) => {
      const items = data.items || [];
      if (!items.length) throw new Error("donut 图表需要 items");
      const total = items.reduce((s, i) => s + (+i.value || 0), 0) || 1;
      const colors = chartPalette(palette, items.length);
      const cx = w * 0.35, cy = h / 2;
      const rOuter = Math.min(w * 0.28, h * 0.4);
      const rInner = rOuter * 0.6;

      let arcs = "";
      let angle = -Math.PI / 2;
      items.forEach((it, i) => {
        const v = +it.value || 0;
        const sweep = (v / total) * Math.PI * 2;
        const a2 = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const x1 = cx + Math.cos(angle) * rOuter, y1 = cy + Math.sin(angle) * rOuter;
        const x2 = cx + Math.cos(a2) * rOuter, y2 = cy + Math.sin(a2) * rOuter;
        const x3 = cx + Math.cos(a2) * rInner, y3 = cy + Math.sin(a2) * rInner;
        const x4 = cx + Math.cos(angle) * rInner, y4 = cy + Math.sin(angle) * rInner;
        arcs += `<path d="M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4} Z" fill="${escAttr(colors[i])}"/>`;
        angle = a2;
      });

      // 中心总数
      const centerLabel = data.centerLabel || `${total}`;
      const centerSub = data.centerSub || "总计";
      const centerTxt = `
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="${rInner * 0.55}" font-weight="700" font-family="${escAttr(palette.titleFont)}" fill="${escAttr(palette.titleColor)}">${escAttr(centerLabel)}</text>
        <text x="${cx}" y="${cy + rInner * 0.45}" text-anchor="middle" font-size="14" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(centerSub)}</text>
      `;

      // 右侧图例
      let legend = "";
      const lgX = w * 0.7;
      const lineH = 28;
      const lgStart = (h - items.length * lineH) / 2;
      items.forEach((it, i) => {
        const ly = lgStart + i * lineH;
        const pct = ((+it.value || 0) / total * 100).toFixed(1);
        legend += `<rect x="${lgX}" y="${ly}" width="14" height="14" fill="${escAttr(colors[i])}" rx="2"/>`;
        legend += `<text x="${lgX + 22}" y="${ly + 11}" font-size="13" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(it.label)} <tspan font-weight="700" fill="${escAttr(palette.titleColor)}">${pct}%</tspan></text>`;
      });

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${arcs}${centerTxt}${legend}
      </svg>`;
    },

    // 折线图：data: { categories: [..], series: [{ name, values: [..] }] }
    line: ({ palette, data, w, h }) => {
      const cats = data.categories || [];
      const series = data.series || [];
      if (!cats.length || !series.length) throw new Error("line 图表需要 categories 和 series");
      const flat = series.flatMap((s) => s.values || []);
      const { max, min } = normSeries(flat);
      const niceMin = Math.min(0, Math.floor(min * 1.05));
      const niceMax = Math.ceil(max * 1.1) || 1;
      const range = niceMax - niceMin || 1;
      const colors = chartPalette(palette, series.length);
      const padL = 60, padR = 30, padT = 30, padB = 60;
      const plotW = w - padL - padR, plotH = h - padT - padB;
      const stepX = cats.length > 1 ? plotW / (cats.length - 1) : 0;

      // 网格
      let grid = "";
      for (let i = 0; i <= 4; i += 1) {
        const y = padT + (plotH / 4) * i;
        grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
        const lblV = (niceMax - (range / 4) * i).toFixed(0);
        grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">${escAttr(lblV)}</text>`;
      }

      // 折线 + 节点
      let lines = "";
      series.forEach((s, si) => {
        const pts = (s.values || []).map((v, i) => {
          const x = padL + i * stepX;
          const y = padT + plotH - ((+v - niceMin) / range) * plotH;
          return [x, y];
        });
        const d = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(" ");
        lines += `<path d="${d}" fill="none" stroke="${escAttr(colors[si])}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
        pts.forEach((p) => {
          lines += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${escAttr(palette.bg)}" stroke="${escAttr(colors[si])}" stroke-width="2"/>`;
        });
      });

      // 类目标签
      let catLbls = "";
      cats.forEach((cat, ci) => {
        const cx = padL + ci * stepX;
        catLbls += `<text x="${cx}" y="${h - padB + 20}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(cat)}</text>`;
      });

      // 图例
      let legend = "";
      if (series.length >= 1) {
        let lx = padL;
        const ly = 18;
        series.forEach((s, si) => {
          legend += `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 16}" y2="${ly - 4}" stroke="${escAttr(colors[si])}" stroke-width="3"/>`;
          legend += `<text x="${lx + 22}" y="${ly}" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(s.name || `系列${si + 1}`)}</text>`;
          lx += 22 + (String(s.name || "").length * 8 + 30);
        });
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${grid}${lines}${catLbls}${legend}
      </svg>`;
    },

    // 雷达图：data: { axes: [..], series: [{ name, values: [..] }], max? }
    radar: ({ palette, data, w, h }) => {
      const axes = data.axes || [];
      const series = data.series || [];
      if (axes.length < 3 || !series.length) throw new Error("radar 图表至少需要 3 条 axes 和 series");
      const flat = series.flatMap((s) => s.values || []);
      const max = data.max != null ? +data.max : Math.max(...flat) * 1.05 || 1;
      const cx = w / 2, cy = h / 2;
      const r = Math.min(w, h) * 0.36;
      const colors = chartPalette(palette, series.length);
      const angleAt = (i) => -Math.PI / 2 + (Math.PI * 2 * i) / axes.length;

      // 同心多边形（5 层）+ 轴线
      let bg = "";
      for (let lvl = 1; lvl <= 5; lvl += 1) {
        const lr = (r * lvl) / 5;
        const pts = axes.map((_, i) => {
          const a = angleAt(i);
          return `${cx + Math.cos(a) * lr},${cy + Math.sin(a) * lr}`;
        }).join(" ");
        bg += `<polygon points="${pts}" fill="none" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
      }
      axes.forEach((_, i) => {
        const a = angleAt(i);
        bg += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a) * r}" y2="${cy + Math.sin(a) * r}" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
      });

      // 每个 series 一个填色多边形
      let polys = "";
      series.forEach((s, si) => {
        const pts = axes.map((_, i) => {
          const a = angleAt(i);
          const v = Math.max(0, Math.min(max, +(s.values?.[i] || 0)));
          const lr = (v / max) * r;
          return `${cx + Math.cos(a) * lr},${cy + Math.sin(a) * lr}`;
        }).join(" ");
        polys += `<polygon points="${pts}" fill="${escAttr(colors[si])}" fill-opacity="0.25" stroke="${escAttr(colors[si])}" stroke-width="2"/>`;
        // 节点
        axes.forEach((_, i) => {
          const a = angleAt(i);
          const v = Math.max(0, Math.min(max, +(s.values?.[i] || 0)));
          const lr = (v / max) * r;
          polys += `<circle cx="${cx + Math.cos(a) * lr}" cy="${cy + Math.sin(a) * lr}" r="3" fill="${escAttr(colors[si])}"/>`;
        });
      });

      // 轴标签
      let labels = "";
      axes.forEach((ax, i) => {
        const a = angleAt(i);
        const lx = cx + Math.cos(a) * (r + 22);
        const ly = cy + Math.sin(a) * (r + 22);
        const anchor = Math.abs(Math.cos(a)) < 0.3 ? "middle" : (Math.cos(a) > 0 ? "start" : "end");
        labels += `<text x="${lx}" y="${ly + 4}" text-anchor="${anchor}" font-size="13" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.titleColor)}" font-weight="600">${escAttr(ax)}</text>`;
      });

      // 图例
      let legend = "";
      if (series.length > 1) {
        let lx = 20, ly = h - 18;
        series.forEach((s, si) => {
          legend += `<rect x="${lx}" y="${ly - 9}" width="12" height="12" fill="${escAttr(colors[si])}" rx="2"/>`;
          legend += `<text x="${lx + 18}" y="${ly + 1}" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(s.name || `系列${si + 1}`)}</text>`;
          lx += 18 + (String(s.name || "").length * 8 + 30);
        });
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${bg}${polys}${labels}${legend}
      </svg>`;
    },

    // 仪表盘 / 完成率：data: { value, max?, label?, suffix? }
    gauge: ({ palette, data, w, h }) => {
      const max = data.max != null ? +data.max : 100;
      const value = Math.max(0, Math.min(max, +data.value || 0));
      const pct = value / max;
      const cx = w / 2, cy = h * 0.62;
      const r = Math.min(w * 0.36, h * 0.5);
      const startA = Math.PI; // 180°
      const endA = 0;          // 360°
      const valueA = startA + (endA - startA) * pct;

      const arc = (a1, a2, color, width) => {
        const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
        const x2 = cx + Math.cos(a2) * r, y2 = cy + Math.sin(a2) * r;
        const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
        const sweep = a2 > a1 ? 1 : 0;
        return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}" fill="none" stroke="${escAttr(color)}" stroke-width="${width}" stroke-linecap="round"/>`;
      };

      // 背景弧（灰）+ 进度弧（accent）
      const bgArc = arc(startA, endA, palette.gridColor, 22);
      const fgArc = pct > 0.001 ? arc(startA, valueA, palette.accent, 22) : "";

      // 中心数字
      const valTxt = `${value}${data.suffix || ""}`;
      const center = `
        <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="${r * 0.55}" font-weight="800" font-family="${escAttr(palette.titleFont)}" fill="${escAttr(palette.primary)}">${escAttr(valTxt)}</text>
        ${data.label ? `<text x="${cx}" y="${cy + r * 0.5}" text-anchor="middle" font-size="16" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(data.label)}</text>` : ""}
      `;

      // 起止刻度
      const ticks = `
        <text x="${cx - r}" y="${cy + 22}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">0</text>
        <text x="${cx + r}" y="${cy + 22}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">${escAttr(max)}${escAttr(data.suffix || "")}</text>
      `;

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${bgArc}${fgArc}${center}${ticks}
      </svg>`;
    },

    // 热力图：data: { rows: [..], cols: [..], values: [[v,v,...], ...] (rows * cols), max?, min? }
    heatmap: ({ palette, data, w, h }) => {
      const rows = data.rows || [];
      const cols = data.cols || [];
      const values = data.values || [];
      if (!rows.length || !cols.length || !values.length) throw new Error("heatmap 需要 rows、cols、values");
      const flat = values.flat();
      const max = data.max != null ? +data.max : Math.max(...flat);
      const min = data.min != null ? +data.min : Math.min(...flat);
      const range = max - min || 1;
      const padL = 80, padR = 30, padT = 30, padB = 50;
      const plotW = w - padL - padR, plotH = h - padT - padB;
      const cellW = plotW / cols.length, cellH = plotH / rows.length;

      // 用 primary 透明度叠加表示数值（深色模式同样）
      const baseColor = palette.primary;
      let cells = "";
      rows.forEach((r, ri) => {
        cols.forEach((c, ci) => {
          const v = +(values[ri]?.[ci] ?? 0);
          const t = Math.max(0, Math.min(1, (v - min) / range));
          const opacity = 0.15 + t * 0.85;
          cells += `<rect x="${padL + ci * cellW}" y="${padT + ri * cellH}" width="${cellW - 1}" height="${cellH - 1}" fill="${escAttr(baseColor)}" fill-opacity="${opacity.toFixed(3)}"/>`;
          // 单元格数值
          if (cellW > 36 && cellH > 22) {
            const txtColor = t > 0.5 ? "#FFFFFF" : palette.titleColor;
            cells += `<text x="${padL + ci * cellW + cellW / 2}" y="${padT + ri * cellH + cellH / 2 + 4}" text-anchor="middle" font-size="11" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(txtColor)}">${escAttr(v)}</text>`;
          }
        });
      });

      // 行标签
      let rowLbls = "";
      rows.forEach((r, ri) => {
        const y = padT + ri * cellH + cellH / 2 + 4;
        rowLbls += `<text x="${padL - 8}" y="${y}" text-anchor="end" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(r)}</text>`;
      });
      // 列标签
      let colLbls = "";
      cols.forEach((c, ci) => {
        const x = padL + ci * cellW + cellW / 2;
        colLbls += `<text x="${x}" y="${padT - 8}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(c)}</text>`;
      });

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${cells}${rowLbls}${colLbls}
      </svg>`;
    }
  };

  registry.registerTool({
    name: "wpp_render_chart",
    hosts: ["wpp"],
    description: [
      "在幻灯片上插入数据可视化图表（SVG 渲染→PNG→AddPicture）。配色自动跟随当前 stylePreset 色板（含 darkMode）。",
      "适合统一风格时给数据型幻灯片加图表：几组数字对比、占比构成、趋势变化、多维度评分等。",
      "",
      "支持的 chartType：",
      "  - bar：柱状图。data = { categories: [\"Q1\",\"Q2\",..], series: [{ name, values:[..] }] }",
      "  - donut：环形图。data = { items: [{label, value}, ..], centerLabel?, centerSub? }",
      "  - line：折线图。data = { categories: [..], series: [{ name, values:[..] }] }",
      "  - radar：雷达图（多维度评分）。data = { axes: [\"产品\",\"交付\",\"售后\"], series: [{ name, values:[..] }], max? }",
      "  - gauge：仪表盘 / 完成率（半圆进度）。data = { value, max?, label?, suffix? }（如 value=87, max=100, suffix='%'）",
      "  - heatmap：热力图（行×列 矩阵）。data = { rows: [..], cols: [..], values: [[..],..] }",
      "",
      "默认插在幻灯片右侧（slide 必填）。可指定 left/top/width/height（PPT 坐标）；省略则默认宽 = slideW * 0.42、高 = slideH * 0.55、靠右居中。",
      "",
      "**何时使用**：在「统一风格」流程里，当某页 textPreview 含百分比、数字趋势、对比数据、占比构成时——比手工堆文字效果好。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["slide", "chartType", "data"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "目标页（1 起；0=当前页）" },
        chartType: { type: "string", enum: ["bar", "donut", "line", "radar", "gauge", "heatmap"] },
        data: { type: "object", description: "图表数据，结构按 chartType 区分（见 description）" },
        left: { type: "number", description: "左上角 X（PPT 坐标）。省略=自动放右半边" },
        top: { type: "number", description: "左上角 Y。省略=自动垂直居中" },
        width: { type: "number", description: "图表宽度。省略=slideW*0.42" },
        height: { type: "number", description: "图表高度。省略=slideH*0.55" },
        title: { type: "string", description: "可选：图表上方的小标题（独立文本框）" }
      }
    },
    handler: async ({ slide, chartType, data, left, top, width, height, title } = {}) => {
      const renderer = CHART_RENDERERS[chartType];
      if (!renderer) throw new Error(`未知 chartType：${chartType}`);
      if (!data || typeof data !== "object") throw new Error("data 必须是对象");

      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const ps = pres.PageSetup;
      let slideW = 720, slideH = 540;
      try { if (ps?.SlideWidth) slideW = ps.SlideWidth; } catch (e) {}
      try { if (ps?.SlideHeight) slideH = ps.SlideHeight; } catch (e) {}

      const palette = getChartPalette();
      const w = width || Math.round(slideW * 0.42);
      const h = height || Math.round(slideH * 0.55);
      const x = (left != null) ? left : Math.round(slideW - w - slideW * 0.04);
      const y = (top != null) ? top : Math.round((slideH - h) / 2);

      // SVG 内部坐标用 720 × 420 比例换算（保证文字大小一致）；最后按 2x 渲染
      const svgW = 720, svgH = Math.round(720 * (h / w));
      const svg = renderer({ palette, data, w: svgW, h: svgH });
      const dataUrl = await svgToPngDataUrl(svg, svgW * 2, svgH * 2);
      const localPath = await uploadDataUrl(dataUrl);

      // 图表小标题（可选）
      let titleAdded = false;
      if (title) {
        try {
          addText(slideObj, x, Math.max(0, y - 28), w, 24, title, {
            fontName: palette.titleFont, fontSize: 14, bold: true, color: palette.titleColor
          });
          titleAdded = true;
        } catch (e) {}
      }

      const pic = safeAddPicture(pres, slideObj, localPath, x, y, w, h);
      try { pic.Name = `lingxi-chart-${chartType}`; } catch (e) {}

      return {
        slide: slideObj.SlideIndex,
        chartType,
        left: x, top: y, width: w, height: h,
        picturePath: localPath,
        titleAdded,
        darkMode: palette.darkMode
      };
    }
  });

  // ============ 高级版式模板（方案 A） ============
  // 每个模板封装一个高频商用版式，AI 只填参数，避免手工拼坐标

  const TEMPLATES = {
    "cover-split": (slide, w, h, p, params) => {
      // 左半边主色块，右半边白底大标题
      setBg(slide, p.bg);
      addRect(slide, 0, 0, Math.round(w * 0.42), h, p.primary);
      // 装饰：左侧色块上加一条细 accent 横线
      addRect(slide, 30, Math.round(h * 0.45), 60, 4, p.accent);
      // 标题
      addText(slide, Math.round(w * 0.48), Math.round(h * 0.32), Math.round(w * 0.46), Math.round(h * 0.18),
        params.title || "标题", {
          fontName: p.titleFont, fontSize: 44, bold: true, color: p.titleColor
        });
      // 副标题
      if (params.subtitle) {
        addText(slide, Math.round(w * 0.48), Math.round(h * 0.55), Math.round(w * 0.46), 40,
          params.subtitle, {
            fontName: p.bodyFont, fontSize: 18, color: p.bodyColor
          });
      }
    },

    "cover-band": (slide, w, h, p, params) => {
      // 顶部主色横条 + 居中大标题 + 底部 accent 细条
      setBg(slide, p.bg);
      addRect(slide, 0, 0, w, Math.round(h * 0.18), p.primary);
      addRect(slide, 0, Math.round(h * 0.18), w, 4, p.accent);
      // 标题居中
      addText(slide, 60, Math.round(h * 0.42), w - 120, 80,
        params.title || "标题", {
          fontName: p.titleFont, fontSize: 48, bold: true, color: p.titleColor, alignH: "center"
        });
      // 副标题/日期
      if (params.subtitle || params.date) {
        addText(slide, 60, Math.round(h * 0.58), w - 120, 32,
          params.subtitle || params.date, {
            fontName: p.bodyFont, fontSize: 16, color: p.bodyColor, alignH: "center"
          });
      }
      // 底部装饰短线
      addRect(slide, Math.round(w / 2 - 30), Math.round(h * 0.65), 60, 3, p.accent);
    },

    "section-fullbleed": (slide, w, h, p, params) => {
      // 满屏主色，白色大字号章节标题
      setBg(slide, p.primary);
      // 章节编号小字（如"第一章"）
      if (params.chapter) {
        addText(slide, 60, Math.round(h * 0.32), w - 120, 30,
          params.chapter, {
            fontName: p.bodyFont, fontSize: 16, color: "#FFFFFF", alignH: "center"
          });
      }
      // 大标题
      addText(slide, 60, Math.round(h * 0.40), w - 120, 100,
        params.title || "章节标题", {
          fontName: p.titleFont, fontSize: 56, bold: true, color: "#FFFFFF", alignH: "center"
        });
      // 中间 accent 装饰横线
      addRect(slide, Math.round(w / 2 - 40), Math.round(h * 0.60), 80, 4, p.accent);
    },

    "content-sidebar": (slide, w, h, p, params) => {
      // 内容页：左侧 8pt 主色装饰条 + 标题 + 标题下细 accent 横线 + 正文
      setBg(slide, p.bg);
      addRect(slide, 0, 0, 8, h, p.primary);
      // 标题
      addText(slide, 40, 30, w - 80, 50,
        params.title || "标题", {
          fontName: p.titleFont, fontSize: p.titleSize, bold: true, color: p.titleColor
        });
      // 标题下方细装饰线
      addRect(slide, 40, 88, 60, 3, p.accent);
      // 正文（多行用 \n 分隔，由 add textbox 自然换行）
      if (params.body) {
        addText(slide, 40, 110, w - 80, h - 150,
          params.body, {
            fontName: p.bodyFont, fontSize: p.bodySize, color: p.bodyColor
          });
      }
    },

    "stat-hero": (slide, w, h, p, params) => {
      // 大数字 + 标签 + 描述（数据强调页）
      setBg(slide, p.bg);
      // 上方左侧装饰条
      addRect(slide, 60, Math.round(h * 0.20), 4, 60, p.accent);
      // 大数字
      addText(slide, 60, Math.round(h * 0.25), w - 120, Math.round(h * 0.25),
        params.number || "100%", {
          fontName: p.titleFont, fontSize: 96, bold: true, color: p.accent, alignH: "center"
        });
      // 标签
      if (params.label) {
        addText(slide, 60, Math.round(h * 0.55), w - 120, 50,
          params.label, {
            fontName: p.titleFont, fontSize: 28, bold: true, color: p.titleColor, alignH: "center"
          });
      }
      // 描述
      if (params.description || params.body) {
        addText(slide, 80, Math.round(h * 0.68), w - 160, 50,
          params.description || params.body, {
            fontName: p.bodyFont, fontSize: 16, color: p.bodyColor, alignH: "center"
          });
      }
    },

    "quote-block": (slide, w, h, p, params) => {
      // 引言：大引号 + 引文（斜体）+ 署名
      setBg(slide, p.surface);
      // 大引号（用 textbox 写一个 “ 开引号，巨大字号）
      addText(slide, 50, 50, 120, 120, "“", {
        fontName: p.titleFont, fontSize: 140, bold: true, color: p.primary
      });
      // 引文
      addText(slide, 100, Math.round(h * 0.32), w - 200, Math.round(h * 0.40),
        params.quote || params.body || "引言内容", {
          fontName: p.titleFont, fontSize: 28, italic: true, color: p.titleColor
        });
      // 署名
      if (params.author) {
        addText(slide, 100, Math.round(h * 0.78), w - 200, 30,
          "— " + params.author, {
            fontName: p.bodyFont, fontSize: 16, color: p.bodyColor, alignH: "right"
          });
      }
    },

    "two-column": (slide, w, h, p, params) => {
      // 左右双栏对比卡片
      setBg(slide, p.bg);
      // 顶部标题（可选）
      if (params.title) {
        addText(slide, 40, 20, w - 80, 40,
          params.title, {
            fontName: p.titleFont, fontSize: 24, bold: true, color: p.titleColor, alignH: "center"
          });
      }
      const top = params.title ? 80 : 40;
      const cardW = Math.round(w * 0.42);
      const cardH = h - top - 40;
      // 左卡片
      addRect(slide, 40, top, cardW, cardH, p.surface);
      addRect(slide, 40, top, cardW, 4, p.primary); // 上边框装饰
      addText(slide, 60, top + 20, cardW - 40, 36,
        params.leftTitle || "方案 A", {
          fontName: p.titleFont, fontSize: 22, bold: true, color: p.primary
        });
      addText(slide, 60, top + 70, cardW - 40, cardH - 90,
        params.leftBody || "", {
          fontName: p.bodyFont, fontSize: 16, color: p.bodyColor
        });
      // 右卡片
      const rightX = w - 40 - cardW;
      addRect(slide, rightX, top, cardW, cardH, p.surface);
      addRect(slide, rightX, top, cardW, 4, p.accent);
      addText(slide, rightX + 20, top + 20, cardW - 40, 36,
        params.rightTitle || "方案 B", {
          fontName: p.titleFont, fontSize: 22, bold: true, color: p.accent
        });
      addText(slide, rightX + 20, top + 70, cardW - 40, cardH - 90,
        params.rightBody || "", {
          fontName: p.bodyFont, fontSize: 16, color: p.bodyColor
        });
    },

    "closing-thanks": (slide, w, h, p, params) => {
      // 结尾页：满屏主色 + "谢谢观看" + Q&A
      setBg(slide, p.primary);
      addText(slide, 60, Math.round(h * 0.38), w - 120, 100,
        params.title || "谢谢观看", {
          fontName: p.titleFont, fontSize: 64, bold: true, color: "#FFFFFF", alignH: "center"
        });
      // 装饰短线
      addRect(slide, Math.round(w / 2 - 30), Math.round(h * 0.55), 60, 3, p.accent);
      // 副标题
      addText(slide, 60, Math.round(h * 0.60), w - 120, 50,
        params.subtitle || "Q & A", {
          fontName: p.bodyFont, fontSize: 28, color: p.accent, alignH: "center"
        });
    }
  };

  registry.registerTool({
    name: "wpp_apply_template",
    hosts: ["wpp"],
    description: [
      "【方案 A / 普通页主力】用预设的高级感版式模板生成或改造一张幻灯片。AI 只填参数，模板内部自动按色板（来自风格预设）摆色块/装饰条/标题/正文，比手工拼形状更整齐统一。",
      "**调用前必读**：先调 wpp_get_style_preset 拿 layoutHints 看色板偏好的模板组合；按「一页一意」原则，宁可拆 2 页都用 content-sidebar 也不要在 1 页堆 6 条信息。每章首页统一用 section-fullbleed 让结构可识别。",
      "",
      "模板列表（templateName 取值）：",
      "  - cover-split：封面，左半主色块 + 右半大标题。params: title, subtitle?",
      "  - cover-band：封面，顶部主色横条 + 居中大标题 + accent 装饰短线。params: title, subtitle? 或 date?",
      "  - section-fullbleed：章节分隔页，满屏主色 + 白字大标题 + 中间 accent 短线。params: title, chapter?（如「第一章」）",
      "  - content-sidebar：内容页，左侧主色装饰条 + 标题（带 accent 下划线）+ 正文多行。params: title, body（多行用 \\n 分隔）",
      "  - stat-hero：数据强调页，巨大数字 + 标签 + 描述。params: number（如 \"98%\"）, label, description?",
      "  - quote-block：引言页，大引号装饰 + 斜体引文 + 署名。params: quote, author?",
      "  - two-column：对比页，左右双卡片。params: title?, leftTitle, leftBody, rightTitle, rightBody",
      "  - closing-thanks：结尾页，满屏主色 + 「谢谢观看」+ Q&A。params: title?（默认「谢谢观看」）, subtitle?（默认「Q & A」）",
      "",
      "默认行为：省略 slide 时**追加一张新空白幻灯片**再应用模板（推荐用法）。",
      "如果 slide 传了序号，会在该幻灯片上**叠加**模板的形状（不会清掉已有内容）。",
      "执行前会读取 stylePreset 的色板和字体，所以不同色板自动出不同质感。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["templateName"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "目标幻灯片序号；省略=追加新幻灯片到末尾" },
        templateName: {
          type: "string",
          enum: ["cover-split", "cover-band", "section-fullbleed", "content-sidebar", "stat-hero", "quote-block", "two-column", "closing-thanks"]
        },
        title: { type: "string" },
        subtitle: { type: "string" },
        body: { type: "string", description: "正文，多行用 \\n 分隔（content-sidebar 等用）" },
        chapter: { type: "string", description: "章节编号文字，如「第一章」（仅 section-fullbleed）" },
        number: { type: "string", description: "大数字（仅 stat-hero），如 \"98%\" 或 \"2,580\"" },
        label: { type: "string", description: "数字下方标签（仅 stat-hero）" },
        description: { type: "string", description: "辅助说明（仅 stat-hero）" },
        quote: { type: "string", description: "引言内容（仅 quote-block）" },
        author: { type: "string", description: "引言作者（仅 quote-block）" },
        leftTitle: { type: "string" },
        leftBody: { type: "string" },
        rightTitle: { type: "string" },
        rightBody: { type: "string" },
        date: { type: "string", description: "日期/作者（仅 cover-band 等）" }
      }
    },
    handler: async (params = {}) => {
      const { slide, templateName } = params;
      if (!templateName) throw new Error("templateName 必填");
      const tpl = TEMPLATES[templateName];
      if (!tpl) throw new Error(`未知模板：${templateName}`);

      const pres = await getPresentation();
      const ps = pres.PageSetup;
      let w = 720, h = 540;
      try { if (ps?.SlideWidth) w = ps.SlideWidth; } catch (e) {}
      try { if (ps?.SlideHeight) h = ps.SlideHeight; } catch (e) {}

      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      // 未勾选「启用统一样式」时返回空对象 —— 全部走默认值，不再泄漏用户保存的色板
      const sp = getEffectiveStylePreset(settings);
      const palette = {
        bg: sp.backgroundColor || "#FFFFFF",
        primary: sp.primaryColor || "#1F3A5F",
        secondary: sp.secondaryColor || "#3D5A80",
        accent: sp.accentColor || "#EE6C4D",
        surface: sp.surfaceColor || "#F5F7FA",
        titleColor: sp.titleColor || "#1F2329",
        bodyColor: sp.bodyColor || "#33363C",
        titleFont: sp.titleFont || "Microsoft YaHei",
        bodyFont: sp.bodyFont || "Microsoft YaHei",
        titleSize: sp.titleSize || 32,
        bodySize: sp.bodySize || 18
      };

      let slideObj;
      if (slide === undefined || slide === null) {
        const idx = (pres.Slides?.Count || 0) + 1;
        slideObj = pres.Slides.Add(idx, 12 /* ppLayoutBlank */);
      } else {
        slideObj = getSlideAt(pres, slide || 0);
      }

      tpl(slideObj, w, h, palette, params);

      return {
        slide: slideObj.SlideIndex || (slide || pres.Slides.Count),
        template: templateName,
        slideWidth: w,
        slideHeight: h,
        usedPalette: { primary: palette.primary, accent: palette.accent, bg: palette.bg }
      };
    }
  });
})(window);
