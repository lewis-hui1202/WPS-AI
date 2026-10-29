(function attachWriterHost(global) {
  "use strict";

  async function getApp() {
    return global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
  }

  async function getActiveDocument() {
    const app = await getApp();
    return app?.ActiveDocument || null;
  }

  async function ensureDocument() {
    const doc = await getActiveDocument();
    if (!doc) {
      throw new Error("未检测到打开的 WPS 文字文档。");
    }
    return doc;
  }

  async function getSelection() {
    const app = await getApp();
    const doc = await getActiveDocument();
    return app?.Selection || doc?.Application?.Selection || null;
  }

  async function readSelectionText() {
    const sel = await getSelection();
    const range = typeof sel?.Range === "function" ? await sel.Range() : sel?.Range;
    const text = sel?.Text || range?.Text || "";
    return String(text).trim();
  }

  // 探测 range 首段的列表格式：无序 / 有序 / 无，以及 level。
  //
  // 判据优先级（前面命中就返回，后面的只作兜底）：
  //   1. ListFormat.ListString —— 段落实际显示的项目符号 / 编号字符。
  //      "•/○/■/▪/◦/·/-/*" 是 bullet；"1./a)/I./①" 是 numbered。最准。
  //   2. ListFormat.ListType —— Word 常量枚举
  //        0 = wdListNoNumbering
  //        1 = wdListListNumOnly
  //        2 = wdListSimpleNumbering
  //        3 = wdListBullet
  //        4 = wdListMixedNumbering
  //        5 = wdListOutlineNumbering
  //        6 = wdListPictureBullet
  //      3 / 6 → bullet；其它非 0 → numbered。之前只认 3，用户用图片项目符号被误判 numbered。
  //   3. 段落 Style 名字（"项目符号 / List Bullet / 无序列表 / 编号列表 / List Number …"）—— 用户
  //      用 Style 应用 list 而不是走 ListFormat 时兜底。
  function detectListFormat(range) {
    if (!range) return null;
    let lf = null;
    try { lf = range.ListFormat; } catch (e) {}
    let listLevel = 1;
    try { if (lf) listLevel = Number(lf.ListLevelNumber) || 1; } catch (e) {}
    const clampLevel = () => Math.max(1, Math.min(9, listLevel));

    // 收集诊断信息 —— 用户报告 ListType=5/2 但视觉是 bullet，得看清楚 WPS 到底返回啥
    let listString = "";
    let listStringCodes = "";
    let listType = 0;
    let listValue = null;
    let styleName = "";
    try { if (lf) listString = String(lf.ListString || ""); } catch (e) {}
    try {
      // 把每个字符的码点也带出来，看是不是奇怪的 PUA 或 unicode 变体
      listStringCodes = Array.from(listString).slice(0, 4).map((c) => c.charCodeAt(0).toString(16)).join(",");
    } catch (e) {}
    try { if (lf) listType = Number(lf.ListType) || 0; } catch (e) {}
    try { if (lf) { const v = lf.ListValue; if (v != null) listValue = Number(v); } } catch (e) {}
    try {
      const p = range.Paragraphs?.Item?.(1);
      const style = p?.Style;
      styleName = String(style?.NameLocal || style?.Name || style || "");
    } catch (e) {}
    const diag = { listString, listStringCodes, listType, listValue, styleName, listLevel };

    // 1) ListString 字符判断（最准 —— 人眼看到什么就是什么）
    const trimmed = listString.trim();
    if (trimmed) {
      // bullet 字符集：常见 unicode + WPS 里的 F0B7（Wingdings 的 · 私用区映射）
      if (/^[•○◦▪■▫◾◽·‧⁃∙▶►◆◇★☆✓✔◉◎●\-*+·]|^|^|^|^/.test(trimmed)) {
        return { kind: "bullet", level: clampLevel(), _via: "listString-bullet", _diag: diag };
      }
      // numbered：数字 / 字母 / 罗马 / ①② / 中文数字
      if (/^\d|^[a-zA-Z][\.\)]|^[IVXLCM]+[\.\)]|^[Ⅰ-ⅿ]|^[①-⒛]|^[０-９]|^[一二三四五六七八九十]/.test(trimmed)) {
        return { kind: "numbered", level: clampLevel(), _via: "listString-numbered", _diag: diag };
      }
      // ListString 有内容但都不匹配：既然肉眼视觉不像数字，默认按 bullet 处理（比误判成 ol 好）
      return { kind: "bullet", level: clampLevel(), _via: "listString-fallback-bullet", _diag: diag };
    }

    // 2) ListString 空：靠 ListValue 决胜
    //   ListValue 是本项的编号数字（1, 2, 3…），bullet 项没编号会返回 0 / null / 抛错。
    //   凡是能拿到 > 0 的 ListValue 才判 numbered，否则一律 bullet（比"任何 ListType>0 都算 numbered"稳）
    if (listValue != null && listValue > 0) {
      return { kind: "numbered", level: clampLevel(), _via: "listValue", _diag: diag };
    }
    if (listType === 3 || listType === 6) {
      return { kind: "bullet", level: clampLevel(), _via: "listType-bullet", _diag: diag };
    }
    if (listType > 0 && listValue === 0) {
      // 有 list 属性 + 编号值 = 0 → 大概率是 bullet（Outline 模板下的项目符号）
      return { kind: "bullet", level: clampLevel(), _via: "listValue-zero-bullet", _diag: diag };
    }

    // 3) Style 名字兜底
    if (styleName) {
      if (/项目符号|无序列表|list.*bullet|bullet/i.test(styleName)) {
        return { kind: "bullet", level: clampLevel(), _via: "style-bullet", _diag: diag };
      }
      if (/编号列表|有序列表|list.*number|numbered/i.test(styleName)) {
        return { kind: "numbered", level: clampLevel(), _via: "style-numbered", _diag: diag };
      }
    }

    // 4) 什么都没匹配上但 ListType > 0：只有到这一步才 fallback numbered
    if (listType > 0) {
      return { kind: "numbered", level: clampLevel(), _via: "listType-last-resort", _diag: diag };
    }

    return null;
  }

  async function readSelectionSnapshot() {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const range = typeof sel?.Range === "function" ? await sel.Range() : sel?.Range;
    const text = sel?.Text || range?.Text || "";
    const listFormat = detectListFormat(range);
    // 打日志：帮排查"选中 bullet 却识别成 numbered"这类情况
    // 只输出前几个字段避免爆日志；_via / _sample 会告诉我们是哪层判据命中的
    try {
      global.WpsAiLog?.log?.("fmt:snapshot-listFormat", {
        listFormat,
        textLen: String(text || "").length,
        textPreview: String(text || "").slice(0, 30)
      });
    } catch (e) {}
    return {
      text: String(text || "").trim(),
      range: {
        start: Number(range?.Start),
        end: Number(range?.End)
      },
      listFormat
    };
  }

  function HTML_FILE_URL() { return (window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/html-file"; }

  async function readDocumentText() {
    const doc = await ensureDocument();
    const range = typeof doc.Range === "function" ? await doc.Range() : null;
    let text = String(doc.Content?.Text || range?.Text || "").trim();
    // 有些文档（分节 / 特殊结构 / 老 .wps）Content.Text / Range.Text 只返回很少内容，
    // 导致排版只读到 1 段。用段落集合(Paragraphs)做校正：段落数明显多于 Content.Text 里
    // 能数出的段数时，逐段读 Range.Text 用段落标记 \r 连接，取更全的那份。
    try {
      const paras = doc.Content?.Paragraphs;
      const pCount = Number(paras?.Count) || 0;
      const textParaCount = text ? text.split(/[\r\n]+/).filter((s) => s.trim()).length : 0;
      if (pCount > 1 && pCount > textParaCount + 1) {
        const parts = [];
        for (let i = 1; i <= pCount; i += 1) {
          try {
            const t = String(paras.Item(i)?.Range?.Text || "").replace(/[\r\n]+$/, "");
            parts.push(t);
          } catch (e) {}
        }
        const joined = parts.join("\r").trim();
        fmtLog("readText-paragraphs-fallback", { pCount, textParaCount, contentLen: text.length, joinedLen: joined.length });
        if (joined.length > text.length) text = joined;
      }
    } catch (e) {}
    return text;
  }

  // 有界读取格式元数据：默认优先选区，否则均匀抽样；page 模式按游标分批。
  async function sampleDocumentFormatting({ scope = "auto", mode = "sample", maxParagraphs = 40, offset = 0, signal } = {}) {
    const startedAt = Date.now();
    const doc = await ensureDocument();
    let paragraphs = null;
    let selected = false;
    if (scope !== "document") {
      const sel = await getSelection();
      const range = typeof sel?.Range === "function" ? await sel.Range() : sel?.Range;
      if (range && Number(range.End) > Number(range.Start) && range.Paragraphs) {
        paragraphs = range.Paragraphs;
        selected = true;
      } else if (scope === "selection") throw new Error("请先选择要分析的文档范围。");
    }
    if (!paragraphs) paragraphs = doc.Content?.Paragraphs;
    const total = Math.max(0, Number(paragraphs?.Count) || 0);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(maxParagraphs) || 40)));
    const from = Math.max(0, Math.min(total, Math.floor(Number(offset) || 0)));
    const count = Math.min(limit, mode === "page" ? total - from : total);
    const samples = [];
    const safe = (fn) => { try { const v = fn(); return v == null ? null : v; } catch (e) { return null; } };
    for (let n = 0; n < count; n += 1) {
      if (n % 5 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      }
      const index = mode === "page" ? from + n + 1 : (count === 1 ? 1 : 1 + Math.floor(n * (total - 1) / (count - 1)));
      try {
        const para = paragraphs.Item(index);
        const range = para.Range;
        const style = safe(() => para.Style);
        const font = safe(() => range.Font);
        const format = safe(() => range.ParagraphFormat);
        samples.push({
          index,
          style: safe(() => String(style?.NameLocal || style?.Name || style || "")),
          fontName: safe(() => String(font?.Name || "")), fontSize: safe(() => font?.Size),
          bold: safe(() => font?.Bold), italic: safe(() => font?.Italic),
          alignment: safe(() => format?.Alignment), lineSpacing: safe(() => format?.LineSpacing),
          lineSpacingRule: safe(() => format?.LineSpacingRule),
          spaceBefore: safe(() => format?.SpaceBefore), spaceAfter: safe(() => format?.SpaceAfter),
          firstLineIndent: safe(() => format?.FirstLineIndent), leftIndent: safe(() => format?.LeftIndent),
          rightIndent: safe(() => format?.RightIndent)
        });
      } catch (e) { samples.push({ index, error: "无法读取该段格式" }); }
    }
    const nextOffset = mode === "page" && from + count < total ? from + count : null;
    try { global.WpsAiLog?.log?.("format-sampling", { scope: selected ? "selection" : "document", mode, totalParagraphs: total, sampledParagraphs: count, elapsedMs: Date.now() - startedAt }); } catch (e) {}
    return { scope: selected ? "selection" : "document", mode, totalParagraphs: total, sampledParagraphs: count, nextOffset, samples };
  }

  // 结构化读文档：按顶层段落遍历，每段记 [rangeStart, rangeEnd] + kind。
  // 表格 / 内嵌图 / 目录等特殊段落标 kind=table/image/other，AI 只处理 kind=paragraph 的。
  // 排版应用时表格 / 图片 Range 完全跳过，保住原样。
  //
  // 检测"是否在表格里"：主路径 Range.Information(12)（wdWithInTable）。
  // 兜底：先把文档里所有 doc.Tables[i].Range 的 [start, end] 收集起来，段落 range
  // 落在任何一个表格 range 内也算 table —— 之前 Information(12) 在某些段落抛异常时
  // 会把表格里的段落漏判成正文，AI 拿去当成段落重排，预览出现"乱码"（其实是拆开
  // 的表格单元格文本）。
  // 调试日志：直接走 window.WpsAiLog.log（等同于 plog），自动落进 lingxi 日志查看器 +
  // console。之前用 console.log + /debug-log 用户看不到（日志查看器只捕获 plog 格式）。
  // 每次预览都会打 4 条摘要，够看清楚"6 层判断到底哪一层跑通了"。
  function fmtLog(tag, data) {
    try {
      const logger = global.WpsAiLog?.log;
      if (logger) { logger("fmt:" + tag, data); return; }
      // 老逻辑兜底
      console.log("[format-preview]", tag, data);
    } catch (e) {}
  }

  // 从段落 Style 名判定标题级别：Heading 1-3 / 标题 1-3 → 1..3；其它 → 0（正文）。
  // 与 readDocumentContext 里的大纲判定同源（writer.js 内 /^(?:Heading|标题)\s*(\d)/i，见 readDocumentContext）。
  function headingLevelFromStyle(styleName) {
    const m = /^(?:Heading|标题)\s*(\d)/i.exec(String(styleName || "").trim());
    if (!m) return 0;
    const lv = parseInt(m[1], 10);
    return lv >= 1 && lv <= 3 ? lv : 0;
  }

  async function readDocumentStructure() {
    const doc = await ensureDocument();
    const paragraphs = doc.Content?.Paragraphs;
    if (!paragraphs) {
      fmtLog("no-paragraphs", { hasContent: !!doc.Content });
      return { segments: [], editable: [], tables: [] };
    }

    // 一次性走 doc.Tables 收 3 件事：
    //   - tableRanges: 每张表的 Range [start, end]
    //   - cellRanges:  每个单元格的 Range [start, end]  （老 .wps 格式 Table.Range 会漏字符，cell 级更稳）
    //   - tableParaStarts: 反向枚举 —— 直接用 table.Range.Paragraphs 拿到"这张表里的所有段落"的 Range.Start
    //     Set。主循环用 Set.has(p.Range.Start) 判断，绕过所有段级 API（Information / Range.Tables /
    //     Range.Cells）在某些格式下不给正确答案的情况。只要 doc.Tables 能枚举 + 拿到 paragraph.Range.Start
    //     就 100% 准确 —— 这是老 .wps 文件表格漏检的关键补丁。
    const tableRanges = [];
    const cellRanges = [];
    const tableParaStarts = new Set();
    // 收集期错误也记一下，方便看是哪个 API 挂了
    const collectErrors = [];
    try {
      const tables = doc.Tables;
      const tCount = Number(tables?.Count) || 0;
      fmtLog("tables-count", { count: tCount, hasTablesObj: !!tables });
      for (let t = 1; t <= tCount; t += 1) {
        try {
          const table = tables.Item(t);
          const tr = table?.Range;
          let trStart = -1, trEnd = -1;
          if (tr) {
            trStart = Number(tr.Start) || 0;
            trEnd = Number(tr.End) || 0;
            tableRanges.push({ start: trStart, end: trEnd });
          }
          // 反向枚举：表里的所有段落 Range.Start 直接进 Set
          let tpAdded = 0;
          try {
            const tParas = tr?.Paragraphs;
            const tpCount = Number(tParas?.Count) || 0;
            for (let pi = 1; pi <= tpCount; pi += 1) {
              try {
                const tp = tParas.Item(pi);
                const s = Number(tp?.Range?.Start);
                if (Number.isFinite(s)) { tableParaStarts.add(s); tpAdded += 1; }
              } catch (e) {}
            }
            fmtLog("table-paragraphs", { tableIdx: t, count: tpCount, added: tpAdded, tableRange: [trStart, trEnd] });
          } catch (e) { collectErrors.push({ where: `t${t}.Range.Paragraphs`, error: e?.message || String(e) }); }
          // 单元格级 range 兜底
          let cellAdded = 0;
          try {
            const rows = table.Rows;
            const rCount = Number(rows?.Count) || 0;
            for (let ri = 1; ri <= rCount; ri += 1) {
              try {
                const row = rows.Item(ri);
                const cells = row.Cells;
                const cCount = Number(cells?.Count) || 0;
                for (let ci = 1; ci <= cCount; ci += 1) {
                  try {
                    const cell = cells.Item(ci);
                    const cr = cell?.Range;
                    if (cr) { cellRanges.push({ start: Number(cr.Start) || 0, end: Number(cr.End) || 0 }); cellAdded += 1; }
                  } catch (e) {}
                }
              } catch (e) {}
            }
            fmtLog("table-cells", { tableIdx: t, rows: rCount, cellsCollected: cellAdded });
          } catch (e) { collectErrors.push({ where: `t${t}.Rows`, error: e?.message || String(e) }); }
        } catch (e) { collectErrors.push({ where: `tables.Item(${t})`, error: e?.message || String(e) }); }
      }
    } catch (e) { collectErrors.push({ where: "doc.Tables", error: e?.message || String(e) }); }
    fmtLog("collect-summary", {
      tableRanges: tableRanges.length,
      cellRanges: cellRanges.length,
      tableParaStarts: tableParaStarts.size,
      errors: collectErrors
    });
    const isInsideAnyTable = (s, e) => {
      if (tableRanges.some((tr) => s >= tr.start && e <= tr.end)) return true;
      // 单元格边界更细，段落大概率整段落在某个 cell 里；也允许 s 只落在 cell 内（尾字符差 1）
      return cellRanges.some((cr) => s >= cr.start && s < cr.end);
    };

    // 浮动对象（doc.Shapes）：按 Anchor 锚定字符位收集，锚定所在段落视为"对象"保留。
    const anchoredShapeStarts = [];
    try {
      const shapes = doc.Shapes;
      const sCount = Number(shapes?.Count) || 0;
      for (let s = 1; s <= sCount; s += 1) {
        try {
          const shp = shapes.Item(s);
          const aStart = Number(shp?.Anchor?.Start);
          if (Number.isFinite(aStart)) anchoredShapeStarts.push(aStart);
        } catch (e) {}
      }
    } catch (e) {}
    const hasAnchoredShapeIn = (s, e) => anchoredShapeStarts.some((a) => a >= s && a < e);

    const count = Number(paragraphs.Count) || 0;
    fmtLog("main-loop-start", { paragraphCount: count });
    const segments = [];
    // 逐层命中统计 + 前 N 条明细
    const layerHitCount = { paraStarts: 0, information: 0, rangeTables: 0, rangeCells: 0, ranges: 0, bel: 0, none: 0 };
    const detailed = [];
    const DETAIL_MAX = 30; // 只留前 30 条明细
    for (let i = 1; i <= count; i += 1) {
      let p, r;
      try { p = paragraphs.Item(i); } catch (e) { continue; }
      try { r = p.Range; } catch (e) { continue; }
      if (!r) continue;
      let start = 0, end = 0;
      try { start = Number(r.Start) || 0; } catch (e) {}
      try { end = Number(r.End) || 0; } catch (e) {}
      // 6 层判断，从最可靠到最兜底
      let inTable = false;
      let hitLayer = null;
      // 1. 反向枚举
      if (tableParaStarts.has(start)) { inTable = true; hitLayer = "paraStarts"; }
      // 2. Information(12)
      let infoVal = null;
      if (!inTable) {
        try { infoVal = r.Information(12); inTable = !!infoVal; if (inTable) hitLayer = "information"; } catch (e) {}
      }
      // 3. Range.Tables.Count
      let rangeTablesCount = null;
      if (!inTable) {
        try { rangeTablesCount = Number(r.Tables?.Count) || 0; if (rangeTablesCount > 0) { inTable = true; hitLayer = "rangeTables"; } } catch (e) {}
      }
      // 4. Range.Cells.Count
      let rangeCellsCount = null;
      if (!inTable) {
        try { rangeCellsCount = Number(r.Cells?.Count) || 0; if (rangeCellsCount > 0) { inTable = true; hitLayer = "rangeCells"; } } catch (e) {}
      }
      // 5. tableRanges + cellRanges 区间
      if (!inTable && isInsideAnyTable(start, end)) { inTable = true; hitLayer = "ranges"; }
      let hasImage = false;
      try { hasImage = (Number(r.InlineShapes?.Count) || 0) > 0; } catch (e) { hasImage = true; }
      let hasEquation = false;
      try { hasEquation = (Number(r.OMaths?.Count) || 0) > 0; } catch (e) { hasEquation = true; }
      const hasAnchoredShape = hasAnchoredShapeIn(start, end);
      let text = "";
      try { text = String(r.Text || ""); } catch (e) {}
      text = text.replace(/[\r\n\v]+$/g, "");
      // 6. BEL
      if (!inTable && /\x07/.test(text)) { inTable = true; hitLayer = "bel"; }
      if (hitLayer) layerHitCount[hitLayer] += 1; else layerHitCount.none += 1;
      const P = global.WpsAiPreserveObjects;
      let kind;
      if (P) {
        kind = P.classifySegment({ inTable, hasInlineShape: hasImage, hasAnchoredShape, hasEquation, textEmpty: text.trim() === "" });
      } else {
        kind = inTable ? "table" : (hasImage ? "image" : (text.trim() === "" ? "empty" : "paragraph"));
      }
      const label = (P && P.isObjectKind(kind)) ? P.placeholderLabelFor(kind) : null;
      // 前 DETAIL_MAX 条 + 所有命中 table 的都记明细，方便排查
      if (detailed.length < DETAIL_MAX || inTable) {
        detailed.push({
          idx: i - 1, start, end, kind, hitLayer,
          infoVal, rangeTablesCount, rangeCellsCount,
          textPreview: text.slice(0, 40)
        });
      }
      segments.push({ idx: i - 1, kind, text, start, end, label });
    }
    fmtLog("main-loop-done", { layerHits: layerHitCount, detailedSample: detailed.slice(0, 40) });
    // AI 只处理 editable = kind === "paragraph"（空段落也跳过，避免污染 AI 输出）
    const editable = segments
      .filter((s) => s.kind === "paragraph")
      .map((s, editIdx) => ({ editIdx, refIdx: s.idx, text: s.text }));

    // 表格清单：把每张表的 cells 二维数组也读出来，供预览面板渲染成 <table>
    // 让用户看到跟真实文档一致的排版。之前只跳过表格 range，预览面板里表格就"消失"了。
    // 每张表按 tableRange 与哪些 segments 重叠来关联；预览合并时用 startsAt 找回原顺序。
    const tables = [];
    try {
      const wpsTables = doc.Tables;
      const tCount2 = Number(wpsTables?.Count) || 0;
      for (let ti = 1; ti <= tCount2; ti += 1) {
        try {
          const t = wpsTables.Item(ti);
          const trStart = Number(t.Range?.Start) || 0;
          const trEnd = Number(t.Range?.End) || 0;
          const rowCount = Math.min(Number(t.Rows?.Count) || 0, 100);  // 太大就截，防爆 DOM
          const colCount = Math.min(Number(t.Columns?.Count) || 0, 20);
          const cells = [];
          for (let r = 1; r <= rowCount; r += 1) {
            const row = [];
            for (let c = 1; c <= colCount; c += 1) {
              let cellText = "";
              try { cellText = String(t.Cell(r, c)?.Range?.Text || "").replace(/[\r\n\v\x07]+$/g, ""); } catch (e) {}
              row.push(cellText);
            }
            cells.push(row);
          }
          tables.push({ tableIndex: ti, start: trStart, end: trEnd, rows: rowCount, cols: colCount, cells });
        } catch (e) {}
      }
    } catch (e) {}
    fmtLog("final", {
      segmentsByKind: segments.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}),
      editableCount: editable.length,
      tablesCount: tables.length
    });
    return { segments, editable, tables };
  }

  // 同 readDocumentStructure 的段落遍历，但给每个 paragraph 段补 headingLevel（读 Style 名走
  // headingLevelFromStyle）；表格/图片/空段 headingLevel 恒 0。
  //
  // 表格/图片判定复刻 readDocumentStructure（writer.js:200 起）里的既有逻辑而非另起一套：先用
  // doc.Tables 建 tableRanges/cellRanges/tableParaStarts 索引，再对每个段落走同一套 6 层兜底判断
  // （反向枚举 → Information(12) → Range.Tables → Range.Cells → 区间兜底 → BEL），InlineShapes
  // 探图片。两处判定必须保持一致，否则 splitSections（long-rewrite.js）依赖的 table/image 断节
  // 会和 readDocumentStructure 的结果对不上。此处省略了 readDocumentStructure 里仅用于调试的
  // fmtLog / layerHitCount 明细统计，不影响 kind 判定结果。
  async function readDocumentSections() {
    const doc = await ensureDocument();
    const paragraphs = doc.Content?.Paragraphs;
    if (!paragraphs) return { segments: [] };

    // —— 表格索引收集：与 readDocumentStructure 完全一致 ——
    const tableRanges = [];
    const cellRanges = [];
    const tableParaStarts = new Set();
    try {
      const tables = doc.Tables;
      const tCount = Number(tables?.Count) || 0;
      for (let t = 1; t <= tCount; t += 1) {
        try {
          const table = tables.Item(t);
          const tr = table?.Range;
          if (tr) tableRanges.push({ start: Number(tr.Start) || 0, end: Number(tr.End) || 0 });
          try {
            const tParas = tr?.Paragraphs;
            const tpCount = Number(tParas?.Count) || 0;
            for (let pi = 1; pi <= tpCount; pi += 1) {
              try {
                const tp = tParas.Item(pi);
                const s = Number(tp?.Range?.Start);
                if (Number.isFinite(s)) tableParaStarts.add(s);
              } catch (e) {}
            }
          } catch (e) {}
          try {
            const rows = table.Rows;
            const rCount = Number(rows?.Count) || 0;
            for (let ri = 1; ri <= rCount; ri += 1) {
              try {
                const row = rows.Item(ri);
                const cells = row.Cells;
                const cCount = Number(cells?.Count) || 0;
                for (let ci = 1; ci <= cCount; ci += 1) {
                  try {
                    const cell = cells.Item(ci);
                    const cr = cell?.Range;
                    if (cr) cellRanges.push({ start: Number(cr.Start) || 0, end: Number(cr.End) || 0 });
                  } catch (e) {}
                }
              } catch (e) {}
            }
          } catch (e) {}
        } catch (e) {}
      }
    } catch (e) {}
    const isInsideAnyTable = (s, e) => {
      if (tableRanges.some((tr) => s >= tr.start && e <= tr.end)) return true;
      return cellRanges.some((cr) => s >= cr.start && s < cr.end);
    };

    // 浮动对象（doc.Shapes）：按 Anchor 锚定字符位收集，锚定所在段落视为"对象"保留。
    const anchoredShapeStarts = [];
    try {
      const shapes = doc.Shapes;
      const sCount = Number(shapes?.Count) || 0;
      for (let s = 1; s <= sCount; s += 1) {
        try {
          const shp = shapes.Item(s);
          const aStart = Number(shp?.Anchor?.Start);
          if (Number.isFinite(aStart)) anchoredShapeStarts.push(aStart);
        } catch (e) {}
      }
    } catch (e) {}
    const hasAnchoredShapeIn = (s, e) => anchoredShapeStarts.some((a) => a >= s && a < e);

    const count = Number(paragraphs.Count) || 0;
    const segments = [];
    for (let i = 1; i <= count; i += 1) {
      let p, r;
      try { p = paragraphs.Item(i); } catch (e) { continue; }
      try { r = p.Range; } catch (e) { continue; }
      if (!r) continue;
      let start = 0, end = 0;
      try { start = Number(r.Start) || 0; } catch (e) {}
      try { end = Number(r.End) || 0; } catch (e) {}

      // —— 6 层表格判定：与 readDocumentStructure 完全一致 ——
      let inTable = false;
      if (tableParaStarts.has(start)) inTable = true;
      if (!inTable) { try { inTable = !!r.Information(12); } catch (e) {} }
      if (!inTable) { try { inTable = (Number(r.Tables?.Count) || 0) > 0; } catch (e) {} }
      if (!inTable) { try { inTable = (Number(r.Cells?.Count) || 0) > 0; } catch (e) {} }
      if (!inTable && isInsideAnyTable(start, end)) inTable = true;
      let hasImage = false;
      try { hasImage = (Number(r.InlineShapes?.Count) || 0) > 0; } catch (e) { hasImage = true; }
      let hasEquation = false;
      try { hasEquation = (Number(r.OMaths?.Count) || 0) > 0; } catch (e) { hasEquation = true; }
      const hasAnchoredShape = hasAnchoredShapeIn(start, end);
      let text = "";
      try { text = String(r.Text || ""); } catch (e) {}
      text = text.replace(/[\r\n\v]+$/g, "");
      if (!inTable && /\x07/.test(text)) inTable = true;

      const P = global.WpsAiPreserveObjects;
      let kind;
      if (P) {
        kind = P.classifySegment({ inTable, hasInlineShape: hasImage, hasAnchoredShape, hasEquation, textEmpty: text.trim() === "" });
      } else {
        kind = inTable ? "table" : (hasImage ? "image" : (text.trim() === "" ? "empty" : "paragraph"));
      }

      let headingLevel = 0;
      if (kind === "paragraph") {
        let styleName = "";
        try {
          const st = p.Style;
          styleName = typeof st === "string" ? st : (st?.NameLocal || st?.Name || "");
        } catch (e) {}
        headingLevel = headingLevelFromStyle(styleName);
      }

      segments.push({ idx: i - 1, kind, text, start, end, headingLevel });
    }
    return { segments };
  }

  const STYLE_IDS = {
    normal: -1,
    title: -63,
    subtitle: -75,
    heading1: -2,
    heading2: -3,
    heading3: -4,
    heading4: -5,
    bullet: -19,
    numbered: -29,
    quote: -85
  };

  function safeSet(obj, prop, value) {
    try { obj[prop] = value; } catch (e) {}
  }

  function clearParagraphFormat(sel) {
    try { sel?.Range?.ListFormat?.RemoveNumbers?.(); } catch (e) {}
    try {
      const pf = sel?.ParagraphFormat;
      if (!pf) return;
      safeSet(pf, "LeftIndent", 0);
      safeSet(pf, "FirstLineIndent", 0);
      safeSet(pf, "RightIndent", 0);
      safeSet(pf, "CharacterUnitLeftIndent", 0);
      safeSet(pf, "CharacterUnitFirstLineIndent", 0);
      safeSet(pf, "CharacterUnitRightIndent", 0);
      safeSet(pf, "SpaceBefore", 0);
      safeSet(pf, "SpaceAfter", 6);
      safeSet(pf, "LineSpacingRule", 0);
    } catch (e) {}
  }

  // 排版模板：按 block 类型取模板样式（heading 按 level 映射 headingN；列表沿用正文样式）
  function templateStyleFor(styleMap, type, level) {
    if (!styleMap || typeof styleMap !== "object") return null;
    const t = String(type || "paragraph").toLowerCase();
    if (t === "heading") {
      const n = Math.max(1, Math.min(4, Number(level || 1)));
      return styleMap[`heading${n}`] || null;
    }
    if (t === "bullet" || t === "numbered") return styleMap.paragraph || null;
    return styleMap[t] || null;
  }

  // 应用模板字体（Name/Size/Bold/Italic，缺省字段不动）
  function applyTemplateFont(font, s) {
    if (!font || !s) return;
    if (s.font) safeSet(font, "Name", s.font);
    if (Number.isFinite(s.size)) safeSet(font, "Size", s.size);
    if (typeof s.bold === "boolean") safeSet(font, "Bold", s.bold);
    if (typeof s.italic === "boolean") safeSet(font, "Italic", s.italic);
  }

  // 应用模板段落格式（对齐/行距/首行缩进/段前分页）
  function applyTemplateParagraphFormat(pf, s) {
    if (!pf || !s) return;
    if (typeof s.pageBreakBefore === "boolean") safeSet(pf, "PageBreakBefore", s.pageBreakBefore);
    if (s.align === "center") safeSet(pf, "Alignment", 1);
    else if (s.align === "right") safeSet(pf, "Alignment", 2);
    else if (s.align === "left") safeSet(pf, "Alignment", 0);
    if (Number.isFinite(s.lineSpacing)) {
      if (s.lineSpacing === 1.5) safeSet(pf, "LineSpacingRule", 1);       // wdLineSpace1pt5
      else if (s.lineSpacing === 2) safeSet(pf, "LineSpacingRule", 2);    // wdLineSpaceDouble
      else if (s.lineSpacing !== 1) {
        safeSet(pf, "LineSpacingRule", 5);                                // wdLineSpaceMultiple
        safeSet(pf, "LineSpacing", 12 * s.lineSpacing);
      } else safeSet(pf, "LineSpacingRule", 0);
    }
    if (Number.isFinite(s.firstLineIndentChars)) {
      // WPS 中文排版扩展：按字符数缩进（最贴近「首行缩进两字符」语义）；不支持时退回磅值近似
      let done = false;
      try { pf.CharacterUnitFirstLineIndent = s.firstLineIndentChars; done = true; } catch (e) {}
      if (!done && s.firstLineIndentChars > 0) {
        safeSet(pf, "FirstLineIndent", s.firstLineIndentChars * (Number.isFinite(s.size) ? s.size : 12));
      }
    }
  }

  function applyBlockStyle(sel, type, level, styleMap) {
    const t = String(type || "paragraph").toLowerCase();
    clearParagraphFormat(sel);
    let style = STYLE_IDS.normal;
    if (t === "title") style = STYLE_IDS.title;
    else if (t === "subtitle") style = STYLE_IDS.subtitle;
    else if (t === "heading") {
      const n = Math.max(1, Math.min(4, Number(level || 1)));
      style = STYLE_IDS[`heading${n}`] || STYLE_IDS.heading1;
    } else if (t === "quote") {
      style = STYLE_IDS.quote;
    } else if (t === "bullet") {
      style = STYLE_IDS.bullet;
    } else if (t === "numbered") {
      style = STYLE_IDS.numbered;
    }
    safeSet(sel, "Style", style);
    try {
      const font = sel.Font;
      if (font) {
        if (t === "title") {
          safeSet(font, "Bold", true);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 18);
        } else if (t === "subtitle") {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 12);
        } else if (t === "heading") {
          safeSet(font, "Bold", true);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", Number(level || 1) <= 1 ? 16 : (Number(level || 1) === 2 ? 14 : 12));
        } else if (t === "quote") {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", true);
          safeSet(font, "Size", 10.5);
        } else {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 10.5);
        }
      }
    } catch (e) {}
    if (t === "bullet") {
      try { sel.Range.ListFormat?.ApplyBulletDefault?.(); } catch (e) {}
    } else if (t === "numbered") {
      try { sel.Range.ListFormat?.ApplyNumberDefault?.(); } catch (e) {}
    }
    if ((t === "bullet" || t === "numbered") && Number(level) > 1) {
      try {
        const pf = sel.ParagraphFormat;
        if (pf) safeSet(pf, "LeftIndent", 14 * Math.min(Number(level) - 1, 5));
      } catch (e) {}
    }
    // 排版模板覆盖：模板给了该类型的样式时，用模板的字体/字号/对齐/行距/首行缩进盖过上面默认值
    const tplStyle = templateStyleFor(styleMap, t, level);
    if (tplStyle) {
      try { applyTemplateFont(sel.Font, tplStyle); } catch (e) {}
      try { applyTemplateParagraphFormat(sel.ParagraphFormat, tplStyle); } catch (e) {}
    }
  }

  function writePlainParagraph(sel, text) {
    const value = String(text || "").replace(/\s+$/g, "");
    if (value) {
      if (typeof sel.TypeText === "function") sel.TypeText(value);
      else if (typeof sel.InsertAfter === "function") sel.InsertAfter(value);
      else throw new Error("当前 Selection 对象不支持写入文本。");
    }
    if (typeof sel.TypeParagraph === "function") sel.TypeParagraph();
    else if (typeof sel.TypeText === "function") sel.TypeText("\n");
  }

  // 排版模板页面设置：cm → 磅（1cm = 28.35pt）。失败静默（老宿主 PageSetup 可能缺属性）。
  function applyTemplatePageSetup(doc, page) {
    if (!doc || !page) return;
    let ps = null;
    try { ps = doc.PageSetup; } catch (e) { return; }
    if (!ps) return;
    const CM = 28.35;
    if (page.orientation) safeSet(ps, "Orientation", page.orientation === "landscape" ? 1 : 0);
    if (Number.isFinite(page.marginTopCm)) safeSet(ps, "TopMargin", page.marginTopCm * CM);
    if (Number.isFinite(page.marginBottomCm)) safeSet(ps, "BottomMargin", page.marginBottomCm * CM);
    if (Number.isFinite(page.marginLeftCm)) safeSet(ps, "LeftMargin", page.marginLeftCm * CM);
    if (Number.isFinite(page.marginRightCm)) safeSet(ps, "RightMargin", page.marginRightCm * CM);
  }

  // 模板写入预处理：中文章节自动编号（纯函数，见 format-templates.applyHeadingNumbering）
  function preprocessBlocksForTemplate(blocks, options) {
    if (options?.numbering && global.WpsAiFormatTemplates?.applyHeadingNumbering) {
      try { return global.WpsAiFormatTemplates.applyHeadingNumbering(blocks, options.numbering); } catch (e) {}
    }
    return blocks;
  }

  async function replaceDocumentBlocks(blocks, options = {}) {
    const styleMap = options.styleMap || null;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error("没有可替换的排版内容。");
    }
    blocks = preprocessBlocksForTemplate(blocks, options);
    const docForSetup = await ensureDocument();
    applyTemplatePageSetup(docForSetup, options.page);
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    if (typeof sel.WholeStory !== "function") throw new Error("当前 Selection 不支持全文选择。");
    sel.WholeStory();
    try { sel.Delete(); } catch (e) {
      try { sel.Text = ""; } catch (e2) {}
    }
    for (const block of blocks) {
      const type = String(block?.type || "paragraph").toLowerCase();
      if (type === "spacer") {
        if (typeof sel.TypeParagraph === "function") sel.TypeParagraph();
        continue;
      }
      if (type === "table") {
        // 表格用 COM 建原生表格（HTML InsertFile 在 WPS 里会丢表格）。
        // 我们的 block 是 {headers, rows}，转成 writeTable 要的 {rows:[表头,...数据], header}。
        const headers = Array.isArray(block?.headers) ? block.headers : [];
        const rows = Array.isArray(block?.rows) ? block.rows : [];
        const allRows = headers.length ? [headers].concat(rows) : rows;
        try { clearParagraphFormat(sel); } catch (e) {}
        if (global.WpsAiMarkdownToWord?.writeTable && allRows.length) {
          global.WpsAiMarkdownToWord.writeTable(sel, { rows: allRows, header: headers.length > 0 });
        }
        continue;
      }
      applyBlockStyle(sel, type, block?.level, styleMap);
      const text = block?.text != null ? block.text : "";
      writePlainParagraph(sel, text);
      clearParagraphFormat(sel);
    }
    return { replaced: blocks.length };
  }

  // 分段范围替换：只动 kind=paragraph 的段落，表格 / 图片 / 特殊段落一律跳过。
  //   - segments: readDocumentStructure() 返回的段落清单
  //   - blocks:   AI 返回的排版 block，sourceIndex 指向 editable 数组的索引
  // 从后往前替换，前面段落的 [start,end] 不受后面替换的长度变化影响。
  //
  // 关键坑：paragraph.Range 通常包含段落末尾的 ¶（\r）。直接 sel.Delete() 会把段落合并
  // 掉，跟前后段落连成一坨。所以先把 sel.End 收缩到 ¶ 之前，只删正文；再 TypeText 新
  // 内容，¶ 保留 —— 前后段落隔断完整。
  async function replaceParagraphsInPlace(segments, blocks, options = {}) {
    const styleMap = options.styleMap || null;
    if (!Array.isArray(segments) || segments.length === 0) throw new Error("段落清单为空。");
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("没有可替换的排版内容。");
    blocks = preprocessBlocksForTemplate(blocks, options); // 编号变换保留 sourceIndex，映射不受影响
    const doc = await ensureDocument();
    applyTemplatePageSetup(doc, options.page);
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    if (typeof sel.SetRange !== "function") throw new Error("当前 Selection 不支持 SetRange。");

    // 建立 editable 索引 → block 的映射（AI sourceIndex 引用的是 editable 数组）
    const blockByEditIdx = new Map();
    blocks.forEach((b, i) => {
      const src = Number.isInteger(b?.sourceIndex) ? b.sourceIndex : i;
      if (!blockByEditIdx.has(src)) blockByEditIdx.set(src, b);
    });

    // 走一遍 segments，给 kind=paragraph 的分配 editIdx
    let editIdx = 0;
    const plan = [];
    for (const seg of segments) {
      if (seg.kind === "paragraph") {
        const block = blockByEditIdx.get(editIdx);
        plan.push({ seg, block });
        editIdx += 1;
      }
      // 表格 / 图片 / 空段 / other 一律 skip（不加入 plan → 不会被 touch）
    }

    // 关键改造：不再用 sel.Delete + TypeText。改用 doc.Range(start, end-1).Text = newText。
    //   - Range.Text setter 是 Word/WPS 官方"替换 range 内容"的写法，preserves paragraph
    //     structure（不影响 ¶）
    //   - 之前 sel.SetRange + sel.End -= 1 + Delete + TypeText 的组合，用户反馈"替换后
    //     只剩前 16 个字符"——推测 sel.End -= 1 在某些 WPS 版本上把 End 拉到 Start 之前
    //     或 selection 内部状态错乱，导致 TypeText 只写了一部分就退出
    //   - 用 Range 完全绕过 Selection，稳定得多。段落 style 用 paragraph.Style 直接设
    //
    // 反向替换 —— 后面变了不影响前面的 Range
    fmtLog("replace-plan", {
      totalPlan: plan.length,
      hasBlock: plan.filter((p) => p.block).length,
      totalSegments: segments.length,
      firstFewPlan: plan.slice(0, 5).map((p) => ({
        segStart: p.seg.start,
        segEnd: p.seg.end,
        segTextLen: p.seg.text?.length || 0,
        blockType: p.block?.type,
        blockLevel: p.block?.level,
        blockTextLen: p.block?.text?.length || 0,
        blockTextPreview: (p.block?.text || "").slice(0, 40)
      }))
    });
    let replaced = 0, skipped = 0;
    for (let i = plan.length - 1; i >= 0; i -= 1) {
      const { seg, block } = plan[i];
      if (!block) { skipped += 1; continue; }
      const type = String(block.type || "paragraph").toLowerCase();
      if (type === "spacer") { skipped += 1; continue; } // spacer 在原地保留即可

      try {
        const rawText = String(block.text || "").replace(/\s+$/g, "");
        // 换行归一化 —— Word/WPS 里 \r 才是段落标记。之前把 \n 转成 \r 会造成一段
        // 拆成多段，反过来影响后续 segment 的 Range 位置。这里改成把所有换行都变成空格，
        // 因为一个段落里理论上不应该有换行（AI 出的 block.text 一段一条）
        const cleanText = rawText.replace(/[\r\n\v]+/g, " ").trim();
        // 用 Range 替换文本 —— 范围收缩到 ¶ 之前（seg.end - 1）
        const targetEnd = Math.max(seg.start, seg.end - 1);
        const range = typeof doc.Range === "function" ? doc.Range(seg.start, targetEnd) : null;
        if (!range) throw new Error("doc.Range 不可用");
        // 关键：Range.Text 是 setter，写入后 range 会自动扩展到新内容末尾
        range.Text = cleanText;
        // 段落级样式：拿到这段所属的 paragraph 对象直接设 style
        try {
          const para = range.Paragraphs?.Item?.(1) || null;
          if (para) {
            let style = STYLE_IDS.normal;
            if (type === "title") style = STYLE_IDS.title;
            else if (type === "subtitle") style = STYLE_IDS.subtitle;
            else if (type === "heading") {
              const n = Math.max(1, Math.min(4, Number(block.level || 1)));
              style = STYLE_IDS[`heading${n}`] || STYLE_IDS.heading1;
            } else if (type === "quote") style = STYLE_IDS.quote;
            else if (type === "bullet") style = STYLE_IDS.bullet;
            else if (type === "numbered") style = STYLE_IDS.numbered;
            safeSet(para, "Style", style);
            // 字体
            try {
              const font = para.Range?.Font;
              if (font) {
                if (type === "title") { safeSet(font, "Bold", true); safeSet(font, "Size", 18); }
                else if (type === "subtitle") { safeSet(font, "Bold", false); safeSet(font, "Size", 12); }
                else if (type === "heading") {
                  const n = Math.max(1, Math.min(4, Number(block.level || 1)));
                  safeSet(font, "Bold", true);
                  safeSet(font, "Size", n <= 1 ? 16 : (n === 2 ? 14 : 12));
                } else if (type === "quote") { safeSet(font, "Bold", false); safeSet(font, "Italic", true); safeSet(font, "Size", 10.5); }
                else { safeSet(font, "Bold", false); safeSet(font, "Italic", false); safeSet(font, "Size", 10.5); }
                // 排版模板覆盖默认字体
                const tplStyle = templateStyleFor(styleMap, type, block.level);
                if (tplStyle) applyTemplateFont(font, tplStyle);
              }
            } catch (fontErr) {}
            // 排版模板的段落格式（对齐/行距/首行缩进）
            try {
              const tplStyle = templateStyleFor(styleMap, type, block.level);
              if (tplStyle) applyTemplateParagraphFormat(para.Format || para.ParagraphFormat, tplStyle);
            } catch (pfErr) {}
            // 列表
            if (type === "bullet") {
              try { para.Range?.ListFormat?.ApplyBulletDefault?.(); } catch (e) {}
            } else if (type === "numbered") {
              try { para.Range?.ListFormat?.ApplyNumberDefault?.(); } catch (e) {}
            } else {
              // 非列表段落，如果之前是列表的要把 list 撸掉。但只针对当前段，不影响别的
              try { para.Range?.ListFormat?.RemoveNumbers?.(); } catch (e) {}
            }
            if ((type === "bullet" || type === "numbered") && Number(block.level) > 1) {
              try {
                const pf = para.Format || para.ParagraphFormat;
                if (pf) safeSet(pf, "LeftIndent", 14 * Math.min(Number(block.level) - 1, 5));
              } catch (e) {}
            }
          }
        } catch (styleErr) {
          fmtLog("replace-style-err", { idx: seg.idx, error: styleErr?.message || String(styleErr) });
        }
        replaced += 1;
        if (i >= plan.length - 3 || i < 3) {
          // 前 3 段 + 后 3 段留个明细，方便对着看
          fmtLog("replace-step", { i, idx: seg.idx, type, textLen: cleanText.length, textPreview: cleanText.slice(0, 40), segStart: seg.start, segEnd: seg.end });
        }
      } catch (e) {
        fmtLog("replace-step-err", { i, idx: seg.idx, error: e?.message || String(e) });
        skipped += 1;
      }
    }
    fmtLog("replace-done", { replaced, skipped, preserved: segments.length - plan.length });
    return { replaced, skipped, preserved: segments.length - plan.length };
  }

  // 节级自底向上写回。orderedResults 已按 charStart 降序（后节先写，不影响前节 offset，
  // 参见 long-rewrite.js 的 orderResultsForWriteback）。
  // 每节把 [charStart, charEnd-1] 区间替换成 blocks 拼的多段文本，逐段套样式。
  // 沿用 replaceParagraphsInPlace 的 doc.Range(start, end-1).Text = text 手法（见上方）。
  // options.doc 可注入（测试用桩）。
  async function replaceSectionsInPlace(orderedResults, options = {}) {
    const doc = options.doc || (await ensureDocument());
    let replaced = 0, failed = 0;
    for (const r of (orderedResults || [])) {
      try {
        const blocks = Array.isArray(r.blocks) ? r.blocks : [];
        // 过滤掉清洗后为空文本的 block（如占位段），并保持 text/block 一一对应，
        // 避免下方样式循环用原始 blocks 下标去对齐过滤后的 Paragraphs 而错位（见 Finding 2）。
        const rendered = blocks
          .map((b) => ({ b, t: String(b?.text || "").replace(/[\r\n\v]+/g, " ").trim() }))
          .filter((x) => x.t);
        const text = rendered.map((x) => x.t).join("\r");
        if (!text) {
          // 全部 block 文本为空：不写回空文本（会清空该节），跳过并计入 failed（见 Finding 3）。
          failed += 1;
          continue;
        }
        const targetEnd = Math.max(r.charStart, r.charEnd - 1);
        const range = typeof doc.Range === "function" ? doc.Range(r.charStart, targetEnd) : null;
        if (!range) throw new Error("doc.Range 不可用");
        range.Text = text;
        // 逐段套样式：heading→标题（按 level 映射 headingN），其余→正文。
        // STYLE_IDS 没有单独的 "heading" 字段，跟 replaceParagraphsInPlace 一样按
        // level 取 headingN（缺省/越界回落到 heading1）。
        try {
          const paras = range.Paragraphs;
          const cnt = paras?.Count || 0;
          for (let k = 1; k <= cnt && k <= rendered.length; k += 1) {
            const b = rendered[k - 1].b;
            const p = paras.Item(k);
            let style = STYLE_IDS.normal;
            if (String(b?.type).toLowerCase() === "heading") {
              const n = Math.max(1, Math.min(4, Number(b?.level || 1)));
              style = STYLE_IDS[`heading${n}`] || STYLE_IDS.heading1;
            }
            safeSet(p, "Style", style);
          }
        } catch (e) {}
        replaced += 1;
      } catch (e) {
        failed += 1;
      }
    }
    return { replaced, failed };
  }

  // 分区就地替换：把对象之间的"文本区"逐区用 writeBlocks 替换，对象 Range 从不触碰。
  //   - blocks：AI 返回的排版 blocks，其中占位符 block（[图片N] 等）标记对象位置
  //   - options.range：{start,end} 限定处理范围（选区）；缺省=全文
  // 反向（按 start 降序）逐区替换，前区 offset 不受后区长度变化影响。
  // 硬保证：对象所在段落属于 object 段、不进任何 zone，因此不会被删。
  async function replaceTextPreservingObjects(blocks, options = {}) {
    const P = global.WpsAiPreserveObjects;
    if (!P) throw new Error("preserve-objects 模块未加载，已中止（避免破坏性删除）。");
    if (!global.WpsAiMarkdownToWord) throw new Error("写入模块未加载。");
    const list = Array.isArray(blocks) ? blocks : [];
    if (!list.length) throw new Error("没有可替换的内容。");
    const doc = await ensureDocument();
    if (typeof doc.Range !== "function") throw new Error("doc.Range 不可用，已中止以避免破坏性删除。");
    const sel = await getSelection();
    if (!sel || typeof sel.SetRange !== "function") throw new Error("Selection 不支持 SetRange，已中止。");

    const structure = await readDocumentStructure();
    let segments = (structure && structure.segments) || [];
    const range = options.range;
    if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
      segments = segments.filter((s) => s.start >= range.start && s.end <= range.end);
    }
    const zones = P.buildZones(segments);
    const { groups, markerCount } = P.splitBlocksByPlaceholder(list);
    const assignments = P.mapGroupsToZones(groups, zones)
      .filter((a) => a.zone.hasRange && a.blocks && a.blocks.length)
      .sort((a, b) => b.zone.start - a.zone.start); // 反向：后区先写

    const objectsPreserved = Math.max(0, zones.length - 1);
    fmtLog("preserve-replace-plan", {
      segments: segments.length, zones: zones.length, objectsPreserved,
      groups: groups.length, markerCount, writableAssignments: assignments.length
    });

    let replaced = 0, skipped = 0;
    for (const a of assignments) {
      try {
        const targetEnd = Math.max(a.zone.start, a.zone.end - 1);
        sel.SetRange(a.zone.start, targetEnd);
        global.WpsAiMarkdownToWord.writeBlocks(sel, a.blocks, { replace: true });
        replaced += 1;
      } catch (e) {
        fmtLog("preserve-replace-err", { start: a.zone.start, end: a.zone.end, error: e?.message || String(e) });
        skipped += 1;
      }
    }
    fmtLog("preserve-replace-done", { replaced, skipped, objectsPreserved });
    return { replaced, skipped, objectsPreserved };
  }

  // ---- 结构重排写回（Task 8，书签锚点） ----

  // 在指定字符区间上打命名书签，供 reorderSectionsByBookmarks 定位搬动。
  // 补足 wps_add_bookmark（tools/writer.js）只能绑定当前 Selection 的缺口——这里直接按 [start, end) 定位。
  // Bookmarks.Add 对已存在的同名书签会重新定义其范围（幂等：同一 name 多次调用，书签会跟随最新区间）。
  async function addBookmarkAtRange(name, start, end) {
    const doc = await ensureDocument();
    const range = doc.Range(start, Math.max(start + 1, end));
    doc.Bookmarks.Add(String(name), range);
    return { added: name };
  }

  // 按标题文字在文档里重定位一节的区间（缺书签兜底用，brief MINOR 4）。
  // Word/WPS 的 Range.Find.Execute() 命中后会把该 Range 重定义到匹配文本；据此取标题起点，
  // 再按原始节长度 origLen 推出 [start, start+origLen) 当作该节区间。找不到返回 null。
  function findRangeByHeading(doc, heading, origLen) {
    const h = String(heading || "").trim();
    if (!h) return null;
    let searchRange = null;
    try { searchRange = doc.Content; } catch (e) {}
    if (!searchRange) { try { searchRange = typeof doc.Range === "function" ? doc.Range() : null; } catch (e) {} }
    if (!searchRange) return null;
    try {
      const find = searchRange.Find;
      if (!find) return null;
      try { find.ClearFormatting?.(); } catch (e) {}
      try { find.Text = h; } catch (e) { return null; }
      try { find.Forward = true; } catch (e) {}
      try { find.MatchWildcards = false; } catch (e) {}
      try { find.Wrap = 0; } catch (e) {}   // wdFindStop —— 不回绕，命中即止
      const ok = find.Execute();
      if (!ok) return null;
      const s = Number(searchRange.Start);
      if (!Number.isFinite(s)) return null;
      const len = (Number.isFinite(origLen) && origLen > 0) ? origLen : Math.max(1, h.length);
      return doc.Range(s, s + len);
    } catch (e) { return null; }
  }

  // 按 compileStructureMoves（long-rewrite.js）产出的 moves
  // （[{name, charStart, charEnd, targetOrder, heading}]）把对应节整体搬动到 targetOrder 描述的
  // 新顺序。COM 逻辑复杂，无法在 node:test 下跑，仅手动验证（见任务报告里的手动验证清单）。
  //
  // 【内容安全算法：先插后删（insert-before-delete-after）】—— 修复 code review 两个 CRITICAL：
  //
  //   CRITICAL 1：Range.FormattedText 是指向文档同一片段的【活引用】，不是值快照。旧实现"先把所有
  //   节的 FormattedText 存下来 → 删除整个并集 → 再贴回"会导致每个 FormattedText 指向的片段在删除
  //   时被清空，贴回时贴进去的是空 —— 整篇内容丢失且函数还报成功。修复：任何一节的富文本读取都必须
  //   发生在它对应的原节【仍然存活、尚未删除】的时刻。做法：把重排后的副本按 targetOrder 逐个插入到
  //   原区域【之前】（锚点 minStart），每插一个都从"当前仍存活的书签区间"即时读 FormattedText；插在
  //   前面会把原区域整体右移、书签随内容平移、始终存活；等所有副本都写好，第 5 步才删除原区域。
  //
  //   CRITICAL 2：minStart/maxEnd 只对 moves 取 min/max，而 compileStructureMoves 会丢弃 merge/split
  //   （只留 keep/move），plan 可能有"洞"——夹在 [minStart,maxEnd) 里却没有任何 move 的节不会被捕获，
  //   一旦按并集删除就会把它删掉。修复：删除前做【连续覆盖守卫】，捕获区间必须无缝平铺 [minStart,maxEnd)；
  //   不满足就中止、绝不删除。
  //
  //   IMPORTANT 3：事后校验。每贴一段都检查光标是否真的推进（插入区间非空）；没推进=空写，记 failed
  //   并给 warning；若所有节都空写则中止删除。破坏性操作绝不能在"什么都没贴进去"时还报成功。
  //
  // 定位优先级（每节）：书签当前区间 → 按 move.heading 文字 Find（MINOR 4）→ 原始字符位置。
  // 另备一份纯文本值快照 String(Range.Text)（真正的值拷贝，不随文档变动失真）作为"绝不丢内容"的
  // 兜底：富文本贴回不可用时退化为纯文本（丢格式、不丢内容）。
  //
  // 返回 { reordered, failed, total, warnings }。强烈建议调用方在触发前走 backup.js 的
  // captureCurrentDoc()（开 UndoRecord），万一结果不理想可 Application.Undo() 整组撤销 ——
  // 本函数自身不做 UndoRecord 分组。
  async function reorderSectionsByBookmarks(moves) {
    const list = Array.isArray(moves) ? moves.slice() : [];
    if (!list.length) return { reordered: 0, failed: 0, total: 0, warnings: [] };
    const doc = await ensureDocument();
    const warnings = [];

    // 1) 打/刷新书签
    for (const mv of list) {
      try { await addBookmarkAtRange(mv.name, mv.charStart, mv.charEnd); }
      catch (e) { warnings.push(`书签 ${mv.name} 创建失败：${e?.message || e}`); }
    }

    // 2) 定位每节 LIVE 区间 + 抓一份纯文本值快照（不缓存 FormattedText —— 它是活引用，只能贴回时即时读）
    const items = [];
    for (const mv of list) {
      let bm = null, range = null, via = "bookmark";
      try { bm = doc.Bookmarks.Item(mv.name); } catch (e) {}
      try { range = bm ? bm.Range : null; } catch (e) {}
      let start = null, end = null;
      if (range) { try { start = Number(range.Start); end = Number(range.End); } catch (e) {} }

      // 书签缺失/不可读 → 先按标题文字重定位（MINOR 4）
      if (!(Number.isFinite(start) && Number.isFinite(end))) {
        const origLen = Math.max(1, (Number(mv.charEnd) || 0) - (Number(mv.charStart) || 0));
        const hr = findRangeByHeading(doc, mv.heading, origLen);
        if (hr) {
          try { start = Number(hr.Start); end = Number(hr.End); range = hr; via = "heading-find"; } catch (e) {}
          if (Number.isFinite(start) && Number.isFinite(end)) {
            warnings.push(`书签 ${mv.name} 缺失，已按标题「${mv.heading}」文字重定位。`);
          }
        }
      }
      // 标题也没命中 → 退回原始字符位置
      if (!(Number.isFinite(start) && Number.isFinite(end))) {
        start = Number(mv.charStart); end = Number(mv.charEnd); via = "positional";
        try { range = (typeof doc.Range === "function") ? doc.Range(start, Math.max(start + 1, end)) : null; } catch (e) { range = null; }
        warnings.push(`书签 ${mv.name} 缺失且标题未命中，退化为原始字符位置（可能失真）。`);
      }
      if (!range || !(Number.isFinite(start) && Number.isFinite(end))) {
        return { reordered: 0, failed: list.length, total: list.length,
          warnings: warnings.concat([`节 ${mv.name} 无法定位，已中止（未做任何删除）。`]) };
      }
      let textSnapshot = "";
      try { textSnapshot = String(range.Text || ""); } catch (e) {}
      items.push({ name: mv.name, heading: mv.heading, targetOrder: Number(mv.targetOrder) || 0, start, end, via, textSnapshot });
    }

    // 3) 连续覆盖守卫（CRITICAL 2）：捕获区间必须无缝平铺 [minStart, maxEnd)，否则区间之间夹着
    //    未捕获内容（如被过滤掉的 merge/split 节），按并集删除会误删 —— 直接中止，绝不删除。
    const byStart = items.slice().sort((a, b) => a.start - b.start);
    const minStart = byStart[0].start;
    const maxEnd = byStart[byStart.length - 1].end;
    let tiled = (byStart[0].start === minStart) && (byStart[byStart.length - 1].end === maxEnd);
    for (let i = 1; i < byStart.length && tiled; i += 1) {
      if (byStart[i].start !== byStart[i - 1].end) tiled = false;
    }
    if (!tiled) {
      return { reordered: 0, failed: list.length, total: list.length,
        warnings: warnings.concat(["plan 非连续覆盖，已中止以避免内容丢失"]) };
    }

    // 4) 先插后删：按 targetOrder 把副本插入到原区域【之前】（锚点 = minStart）。
    //    每贴一段都从仍存活的书签区间即时读 FormattedText（CRITICAL 1：读发生在删除之前）。
    const ordered = items.slice().sort((a, b) => a.targetOrder - b.targetOrder);
    let cursor = minStart;
    let reordered = 0, failed = 0;
    for (const it of ordered) {
      const before = cursor;
      let wrote = false;
      // 4a) 优先 FormattedText（保留富文本）—— 即时从 LIVE 书签区间读
      try {
        let src = null;
        try { const b = doc.Bookmarks.Item(it.name); src = b ? b.Range : null; } catch (e) {}
        if (src) {
          const insertRange = doc.Range(cursor, cursor);
          insertRange.FormattedText = src.FormattedText;
          const nend = Number(insertRange.End);
          if (Number.isFinite(nend) && nend > before) { cursor = nend; wrote = true; }
        }
      } catch (e) {}
      // 4b) FormattedText 不可用/空写 → 纯文本值快照兜底（内容安全，丢格式）
      if (!wrote) {
        try {
          const insertRange = doc.Range(cursor, cursor);
          insertRange.Text = it.textSnapshot;
          const nend = Number(insertRange.End);
          if (Number.isFinite(nend) && nend > before) {
            cursor = nend; wrote = true;
            warnings.push(`节 ${it.name} 富文本贴回不可用，已退化为纯文本（丢格式，不丢内容）。`);
          }
        } catch (e) {}
      }
      // 4c) 事后校验（IMPORTANT 3）：光标没推进 = 空写 → 记 failed，绝不算成功
      if (wrote) reordered += 1;
      else { failed += 1; warnings.push(`节 ${it.name} 贴回后光标未推进（疑似空写），计为失败。`); }
    }

    // 所有节都空写：一个字都没写进去，此时删原区域 = 净内容丢失 → 中止删除。
    if (reordered === 0) {
      return { reordered: 0, failed: list.length, total: list.length,
        warnings: warnings.concat(["所有节贴回均为空写，已中止删除以避免内容丢失（请回滚）。"]) };
    }

    // 5) 只有副本已成功写入后才删原区域。原区域被前置副本整体右移，用其书签当前位置的并集精确定位。
    let delStart = null, delEnd = null;
    for (const it of items) {
      let s = null, e = null;
      try { const b = doc.Bookmarks.Item(it.name); const r = b ? b.Range : null; if (r) { s = Number(r.Start); e = Number(r.End); } } catch (err) {}
      if (Number.isFinite(s) && Number.isFinite(e)) {
        delStart = (delStart == null) ? s : Math.min(delStart, s);
        delEnd = (delEnd == null) ? e : Math.max(delEnd, e);
      }
    }
    // 书签解析异常，或解析出的起点落进了刚插入的副本区（delStart < cursor，说明书签被牵连）→
    // 用"副本末尾 cursor 起、原节总长度"兜底定位原区域，避免误删新副本。
    if (!(Number.isFinite(delStart) && Number.isFinite(delEnd)) || delStart < cursor) {
      delStart = cursor;
      delEnd = cursor + (maxEnd - minStart);
    }
    try {
      const deleteRange = doc.Range(delStart, delEnd);
      deleteRange.Text = "";
    } catch (e) {
      warnings.push(`原区域删除失败：${e?.message || e}（文档中可能同时存在新旧两份，请人工检查/回滚）。`);
    }

    return { reordered, failed, total: list.length, warnings };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function blocksToHtml(blocks) {
    const parts = [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<meta charset="utf-8">',
      "<style>",
      "@page{margin:72pt 72pt 72pt 72pt;}",
      "body{font-family:SimSun,'Songti SC',serif;font-size:10.5pt;color:#111;}",
      "p.MsoNormal{margin:0 0 6pt 0;text-indent:21pt;mso-char-indent-count:2.0;line-height:175%;mso-line-height-rule:exactly;}",
      "p.LingxiSubtitle{margin:0 0 12pt 0;text-align:center;text-indent:0;font-size:12pt;color:#4b5563;line-height:150%;}",
      "p.LingxiQuote{margin:8pt 0 8pt 0;padding-left:12pt;border-left:3pt solid #1a6dff;color:#374151;font-style:italic;text-indent:0;line-height:165%;}",
      "h1{margin:0 0 16pt 0;text-align:center;font-size:18pt;font-weight:bold;line-height:135%;}",
      "h2{margin:14pt 0 6pt 0;font-size:16pt;font-weight:bold;line-height:145%;}",
      "h3{margin:14pt 0 6pt 0;font-size:14pt;font-weight:bold;line-height:145%;}",
      "h4{margin:14pt 0 6pt 0;font-size:12pt;font-weight:bold;line-height:145%;}",
      "ul,ol{margin:6pt 0 8pt 24pt;padding-left:18pt;line-height:165%;}",
      "li{margin:0 0 3pt 0;}",
      "</style>",
      "</head>",
      "<body>"
    ];
    let listTag = "";
    const closeList = () => {
      if (listTag) {
        parts.push(`</${listTag}>`);
        listTag = "";
      }
    };
    const listStyle = 'margin:6pt 0 8pt 24pt;padding-left:18pt;line-height:1.65;';
    blocks.forEach((block) => {
      const type = String(block?.type || "paragraph").toLowerCase();
      const text = escapeHtml(block?.text || "");
      if (type === "spacer") {
        closeList();
        parts.push('<p class="MsoNormal" style="text-indent:0;mso-char-indent-count:0;">&nbsp;</p>');
        return;
      }
      if (type === "bullet" || type === "numbered") {
        const tag = type === "numbered" ? "ol" : "ul";
        if (listTag !== tag) {
          closeList();
          parts.push(`<${tag} style="${listStyle}">`);
          listTag = tag;
        }
        parts.push(`<li style="margin:0 0 3pt 0;">${text}</li>`);
        return;
      }
      closeList();
      if (type === "title") {
        parts.push(`<h1 style="margin:0 0 16pt 0;text-align:center;font-size:18pt;font-weight:bold;line-height:1.35;">${text}</h1>`);
      } else if (type === "subtitle") {
        parts.push(`<p class="LingxiSubtitle" style="margin:0 0 12pt 0;text-align:center;font-size:12pt;color:#4b5563;text-indent:0;mso-char-indent-count:0;line-height:150%;">${text}</p>`);
      } else if (type === "heading") {
        const level = Math.max(1, Math.min(4, Number(block?.level || 2)));
        const size = level <= 1 ? 16 : (level === 2 ? 14 : 12);
        parts.push(`<h${Math.min(level + 1, 4)} style="margin:14pt 0 6pt 0;font-size:${size}pt;font-weight:bold;line-height:1.45;">${text}</h${Math.min(level + 1, 4)}>`);
      } else if (type === "quote") {
        parts.push(`<p class="LingxiQuote" style="margin:8pt 0 8pt 0;padding-left:12pt;border-left:3pt solid #1a6dff;color:#374151;font-style:italic;text-indent:0;mso-char-indent-count:0;line-height:165%;">${text}</p>`);
      } else if (type === "table") {
        // markdown 表格美化后写成 Word 原生表格（InsertFile 会把 <table> 转成真实表格）
        const headers = Array.isArray(block?.headers) ? block.headers : [];
        const rows = Array.isArray(block?.rows) ? block.rows : [];
        const cell = (c, head) => `<td style="border:0.75pt solid #999;padding:3pt 6pt;${head ? "font-weight:bold;background:#f2f2f2;" : ""}">${escapeHtml(String(c == null ? "" : c))}</td>`;
        let t = '<table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:8pt 0;">';
        if (headers.length) t += "<tr>" + headers.map((h) => cell(h, true)).join("") + "</tr>";
        rows.forEach((r) => { t += "<tr>" + (Array.isArray(r) ? r : []).map((c) => cell(c, false)).join("") + "</tr>"; });
        t += "</table>";
        parts.push(t);
      } else {
        parts.push(`<p class="MsoNormal" style="margin:0 0 6pt 0;text-indent:21pt;mso-char-indent-count:2.0;line-height:175%;mso-line-height-rule:exactly;">${text}</p>`);
      }
    });
    closeList();
    parts.push("</body>", "</html>");
    return parts.join("");
  }

  async function replaceDocumentBlocksHtml(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error("没有可替换的排版内容。");
    }
    await ensureDocument();
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const html = blocksToHtml(blocks);
    const resp = await fetch(HTML_FILE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.htmlPath) {
      throw new Error(payload.error || `html-file ${resp.status}`);
    }
    if (typeof sel.WholeStory !== "function") throw new Error("当前 Selection 不支持全文选择。");
    sel.WholeStory();
    try { sel.Delete(); } catch (e) {
      try { sel.Text = ""; } catch (e2) {}
    }
    const range = typeof sel.Range === "function" ? await sel.Range() : sel.Range;
    if (!range?.InsertFile) throw new Error("Range.InsertFile 不可用");
    range.InsertFile(payload.htmlPath);
    return { replaced: blocks.length, htmlPath: payload.htmlPath };
  }

  // 把工具/调用方传入的内容统一成 blocks 数组：
  //   - 已是数组：原样
  //   - 字符串（纯文本快捷）：包成单 paragraph 块（不解析 markdown）
  //   - 其它：空数组
  function coerceBlocks(input) {
    if (Array.isArray(input)) return input;
    if (typeof input === "string" && input.length > 0) return [{ type: "paragraph", text: input }];
    return [];
  }

  async function insertText(blocksOrText, options = {}) {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前光标位置。");
    const blocks = coerceBlocks(blocksOrText);
    if (!blocks.length) return;
    if (!global.WpsAiMarkdownToWord) throw new Error("写入模块未加载。");
    global.WpsAiMarkdownToWord.writeBlocks(sel, blocks, { replace: false });
  }

  // ---- 字符/段落格式 capture & restore ----
  // wdUndefined = 9999999：Word/WPS 在范围内格式不一致时（例如选区内一部分粗体一部分不粗）
  // 返回的"未定义"哨兵值。捕获时把它当成 null，恢复时也跳过——避免把"混合"误写成"统一"。
  const WD_UNDEFINED = 9999999;

  // 一次性可读字段；漏读 / 异常都按 null 处理
  const FONT_KEYS = [
    "Name", "NameFarEast", "NameAscii", "NameOther",
    "Size",
    "Bold", "Italic",
    "Underline", "UnderlineColor",
    "Color", "ColorIndex",
    "StrikeThrough", "DoubleStrikeThrough",
    "Subscript", "Superscript",
    "SmallCaps", "AllCaps", "Hidden",
    "Spacing", "Scaling", "Position", "Kerning"
  ];
  const PARA_KEYS = [
    "Alignment",
    "LineSpacing", "LineSpacingRule",
    "SpaceBefore", "SpaceAfter",
    "FirstLineIndent", "LeftIndent", "RightIndent",
    "CharacterUnitLeftIndent", "CharacterUnitFirstLineIndent", "CharacterUnitRightIndent",
    "KeepWithNext", "KeepTogether"
  ];

  function safeReadProp(obj, key) {
    try {
      const v = obj?.[key];
      if (typeof v === "function") return null;
      return v == null ? null : v;
    } catch (e) {
      return null;
    }
  }
  function safeWriteProp(obj, key, value) {
    if (value == null) return;
    if (value === WD_UNDEFINED) return; // 跳过混合态
    try { obj[key] = value; } catch (e) {}
  }
  function captureFontSnap(range) {
    const f = range?.Font;
    if (!f) return null;
    const snap = {};
    FONT_KEYS.forEach((k) => { snap[k] = safeReadProp(f, k); });
    return snap;
  }
  function captureParaSnap(range) {
    const p = range?.ParagraphFormat;
    if (!p) return null;
    const snap = {};
    PARA_KEYS.forEach((k) => { snap[k] = safeReadProp(p, k); });
    return snap;
  }
  function applyFontSnap(range, snap) {
    if (!snap) return;
    const f = range?.Font;
    if (!f) return;
    FONT_KEYS.forEach((k) => safeWriteProp(f, k, snap[k]));
  }
  function applyParaSnap(range, snap) {
    if (!snap) return;
    const p = range?.ParagraphFormat;
    if (!p) return;
    PARA_KEYS.forEach((k) => safeWriteProp(p, k, snap[k]));
  }
  function captureStyle(range) {
    try { return range?.Style; } catch (e) { return null; }
  }
  function applyStyle(range, style) {
    if (style == null) return;
    try { range.Style = style; } catch (e) {}
  }

  async function replaceSelectionText(blocksOrText, options = {}) {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const blocks = coerceBlocks(blocksOrText);
    if (!blocks.length) return;
    if (!global.WpsAiMarkdownToWord) throw new Error("写入模块未加载。");
    let start = 0, end = 0;
    try { start = Number(sel.Start) || 0; } catch (e) {}
    try { end = Number(sel.End) || 0; } catch (e) {}
    // 替换列表项时保留其项目符号/编号：优先用 caller 传入的 listFormat（app.js 会传），
    // 否则从当前选区探测（detectListFormat 返回 {kind, level, ...}）。
    let listFormat = options.listFormat || null;
    if (!listFormat) {
      try {
        const range = typeof sel.Range === "function" ? await sel.Range() : sel.Range;
        listFormat = detectListFormat(range);
      } catch (e) {}
    }
    // 修 B6：无真实选区（折叠）时不走 replace（Delete 会吃右侧字符），直接插入。
    global.WpsAiMarkdownToWord.writeBlocks(sel, blocks, { replace: end > start, listFormat });
  }

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
    // 关键修：选区末尾若含段落标记(¶)，把它排除出待删范围——否则 writeBlocks 的 Delete 会连 ¶ 一起删，
    // 末段替换文本没有结尾 ¶，就跟下一段开头粘在一起。仅末块是"裸段落"时缩（list 自带结尾 ¶，缩了会多空行）。
    const lastBlock = blocks[blocks.length - 1];
    const lastIsBarePara = !lastBlock || lastBlock.type === "paragraph" || lastBlock.type === undefined;
    if (lastIsBarePara) try {
      const txt = String(range.Text || "");
      if (end - 1 > start && /[\r\n\x0b\x07]$/.test(txt)) {
        const shrunk = doc.Range(start, end - 1);
        if (shrunk) range = shrunk;
      }
    } catch (e) {}
    // 替换前探测 list 格式（写入后 range 内容已变，必须先抓），优先用 caller 传入的。
    let listFormat = options.listFormat || null;
    if (!listFormat) {
      try { listFormat = detectListFormat(range); } catch (e) {}
    }
    try { range.Select?.(); } catch (e) {}
    const sel = await getSelection();
    if (!sel) return replaceSelectionText(blocksOrText, options);
    if (!global.WpsAiMarkdownToWord) throw new Error("写入模块未加载。");
    global.WpsAiMarkdownToWord.writeBlocks(sel, blocks, { replace: true, listFormat });
  }

  // P1-3 批注式校对：在指定字符区间上添加 Word 批注（非破坏性，不改正文）。
  async function addCommentAtRange(start, end, text) {
    const doc = await ensureDocument();
    const s = Math.max(0, Number(start) | 0);
    const e = Math.max(s + 1, Number(end) | 0);
    let range = null;
    try { if (typeof doc.Range === "function") range = doc.Range(s, e); } catch (err) {}
    if (!range) throw new Error("doc.Range 不可用，无法定位批注位置。");
    const comments = doc.Comments;
    if (!comments || typeof comments.Add !== "function") throw new Error("当前宿主不支持批注（Comments.Add 不可用）。");
    comments.Add(range, String(text || ""));
    return { start: s, end: e };
  }

  // 读文档上下文供选区操作参考：标题 + 大纲(标题 1-3 级) + 选区前后文窗口。
  // 全部就地截断；任一字段读失败留空；文档不可用返回 null。
  async function readDocumentContext({ selectionRange, maxAround = 800 } = {}) {
    let doc;
    try { doc = await ensureDocument(); } catch (e) { return null; }
    const ctx = { title: "", outline: [], before: "", after: "" };

    try {
      const paras = doc.Paragraphs;
      const count = paras?.Count || 0;
      let outlineChars = 0;
      for (let i = 1; i <= count && i <= 4000 && ctx.outline.length < 60; i += 1) {
        let p;
        try { p = paras.Item(i); } catch (e) { continue; }
        let styleName = "";
        try {
          const style = p.Style;
          styleName = typeof style === "string" ? style : (style?.NameLocal || style?.Name || "");
        } catch (e) { continue; }
        const m = /^(?:Heading|标题)\s*(\d)/i.exec(String(styleName));
        if (!m) continue;
        const level = parseInt(m[1], 10);
        if (!(level >= 1 && level <= 3)) continue;
        let text = "";
        try { text = String(p.Range?.Text || "").replace(/[\r\n\x07]+$/g, "").trim(); } catch (e) {}
        if (!text) continue;
        if (text.length > 120) text = text.slice(0, 120);
        if (level === 1 && !ctx.title) ctx.title = text;
        if (outlineChars + text.length > 1500) break;
        outlineChars += text.length;
        ctx.outline.push({ level, text });
      }
    } catch (e) {}

    if (!ctx.title) {
      try { ctx.title = String(doc.Name || "").replace(/\.[^.]+$/, "").trim(); } catch (e) {}
    }

    const start = Number(selectionRange?.start);
    const end = Number(selectionRange?.end);
    if (Number.isFinite(start) && typeof doc.Range === "function") {
      try {
        const b = doc.Range(Math.max(0, start - maxAround), start);
        ctx.before = String(b?.Text || "").replace(/\x07/g, "").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      } catch (e) {}
    }
    if (Number.isFinite(end) && typeof doc.Range === "function") {
      try {
        const a = doc.Range(end, end + maxAround);
        ctx.after = String(a?.Text || "").replace(/\x07/g, "").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      } catch (e) {}
    }

    if (!ctx.title && ctx.outline.length === 0 && !ctx.before && !ctx.after) return null;
    return ctx;
  }

  // 纯函数：把 docContext 拼成【文档背景】提示段。ctx 空 / 全空 → 返回 ''。
  function formatDocContextForPrompt(ctx) {
    if (!ctx) return "";
    const title = String(ctx.title || "").trim();
    const outline = Array.isArray(ctx.outline) ? ctx.outline : [];
    const before = String(ctx.before || "").trim();
    const after = String(ctx.after || "").trim();
    if (!title && outline.length === 0 && !before && !after) return "";
    const lines = [];
    lines.push("【文档背景】(仅供参考，保持与全文主题/术语/语气一致，不要偏离文档主题；只处理下面的选中内容)");
    if (title) lines.push(`标题：${title}`);
    if (outline.length) {
      lines.push("大纲：");
      for (const it of outline) {
        const lv = Math.max(1, Math.min(3, parseInt(it?.level, 10) || 1));
        lines.push(`  ${"#".repeat(lv)} ${String(it?.text || "").trim()}`);
      }
    }
    if (before) lines.push(`选区前文：…${before}`);
    if (after) lines.push(`选区后文：${after}…`);
    let out = lines.join("\n");
    if (out.length > 3500) out = out.slice(0, 3500);
    return out;
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    return readDocumentText();
  }

  // AI 排版「仅选中区域」用：一次拿选区文本 + start/end。
  // start/end 供替换阶段用 doc.Range(start, end) 重新定位——排版弹窗是模态的，
  // 弹窗期间文档不会被改，位置替换时依然有效。无选区 / 折叠选区返回 null。
  async function readSelectionInfo() {
    const sel = await getSelection();
    if (!sel) return null;
    let start = 0, end = 0;
    try { start = Number(sel.Start) || 0; } catch (e) {}
    try { end = Number(sel.End) || 0; } catch (e) {}
    if (!(end > start)) return null;
    let text = "";
    try {
      const range = typeof sel.Range === "function" ? await sel.Range() : sel.Range;
      text = String(sel.Text || range?.Text || "");
    } catch (e) {}
    if (!text.trim()) return null;
    return { start, end, text };
  }

  function getScopeOptions() {
    return [
      { value: "selection", label: "当前选区" },
      { value: "document", label: "全文" }
    ];
  }

  // 扫描文档，找出带非默认字体颜色 / 荧光笔高亮 / 段落底纹（背景色）的文本片段。
  // 读的是 Word/WPS COM 标准属性（Font.Color BGR、Range.HighlightColorIndex、Range.Shading.BackgroundPatternColor），
  // 写入侧已在用同一批属性（wps_format_selection），故 WPS COM 支持。答"哪些是红字/高亮/带背景"用。
  async function findColoredText(options) {
    const opts = options || {};
    const cap = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 200;
    const doc = await ensureDocument();
    const paras = (doc.Content && doc.Content.Paragraphs) || doc.Paragraphs;
    const count = Number(paras && paras.Count) || 0;

    const sg = (obj, prop) => { try { return obj ? obj[prop] : undefined; } catch (e) { return undefined; } };
    // Word BGR 整数 → #RRGGBB；自动色(负数)/未定义(9999999) → null
    const bgrToHex = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n === 9999999) return null;
      const b = (n >> 16) & 0xff, g = (n >> 8) & 0xff, r = n & 0xff;
      return ("#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")).toUpperCase();
    };
    const HL = { 1: "黑", 2: "蓝", 3: "青", 4: "绿", 5: "洋红", 6: "红", 7: "黄", 8: "白", 9: "深蓝", 10: "深青", 11: "深绿", 12: "深洋红", 13: "深红", 14: "深黄", 15: "深灰", 16: "浅灰" };
    const hiName = (idx) => { const n = Number(idx); if (!Number.isFinite(n) || n <= 0) return null; if (n === 9999999) return "混合"; return HL[n] || ("高亮#" + n); };
    const clip = (t) => { const s = String(t || "").replace(/[\r\n\x07\t]+/g, " ").trim(); return s.length > 120 ? s.slice(0, 120) + "…" : s; };

    const spans = [];
    for (let i = 1; i <= count && spans.length < cap; i += 1) {
      let range, text;
      try { const p = paras.Item(i); range = p.Range; text = String(sg(range, "Text") || ""); } catch (e) { continue; }
      if (!range || !clip(text)) continue;

      const font = sg(range, "Font");
      const paraColor = font ? sg(font, "Color") : undefined;
      const paraHi = sg(range, "HighlightColorIndex");
      const shadingObj = sg(range, "Shading");
      const bgHex = bgrToHex(shadingObj ? sg(shadingObj, "BackgroundPatternColor") : undefined);
      const mixed = Number(paraColor) === 9999999 || Number(paraHi) === 9999999;

      if (!mixed) {
        const colorHex = bgrToHex(paraColor);
        const highlight = hiName(paraHi);
        if (colorHex || highlight || bgHex) {
          spans.push({ paragraph: i, text: clip(text), fontColor: colorHex || undefined, highlight: highlight || undefined, background: bgHex || undefined });
        }
        continue;
      }
      // 段内混合：按 Words 分组，合并相邻同色/同高亮的词
      let words = null;
      try { words = range.Words; } catch (e) { words = null; }
      const wc = Number(sg(words, "Count")) || 0;
      let cur = null;
      const flush = () => {
        if (cur && (cur.color || cur.hi || bgHex)) {
          const t = clip(cur.text);
          if (t) spans.push({ paragraph: i, text: t, fontColor: cur.color || undefined, highlight: cur.hi || undefined, background: bgHex || undefined });
        }
        cur = null;
      };
      for (let w = 1; w <= wc && spans.length < cap; w += 1) {
        let wt, wcolor, whi;
        try { const word = words.Item(w); wt = String(sg(word, "Text") || ""); const wf = sg(word, "Font"); wcolor = bgrToHex(wf ? sg(wf, "Color") : undefined); whi = hiName(sg(word, "HighlightColorIndex")); }
        catch (e) { continue; }
        if (cur && cur.color === wcolor && cur.hi === whi) cur.text += wt;
        else { flush(); cur = { text: wt, color: wcolor, hi: whi }; }
      }
      flush();
    }
    return { total: spans.length, truncated: spans.length >= cap, spans };
  }

  // 批量清理格式：整篇（或指定段落范围）一次性把字体统一黑色 + 去荧光笔高亮 + 去段落底纹。
  // 全程只对一个 Range 设 3 个属性 → 1 次工具调用搞定，避免 AI 逐片段处理导致大量模型请求(rpm 超限)。
  async function clearTextFormatting(options) {
    const opts = options || {};
    const doc = await ensureDocument();
    let range;
    if (Array.isArray(opts.paragraphRange) && opts.paragraphRange.length === 2) {
      const total = Number(doc.Paragraphs && doc.Paragraphs.Count) || 0;
      const from = Math.max(1, Math.min(total, Number(opts.paragraphRange[0]) || 1));
      const to = Math.max(from, Math.min(total, Number(opts.paragraphRange[1]) || total));
      const s = doc.Paragraphs.Item(from).Range.Start;
      const e = doc.Paragraphs.Item(to).Range.End;
      range = doc.Range(s, e);
    } else {
      range = doc.Content;
    }
    const doColor = opts.resetColor !== false;
    const doHighlight = opts.removeHighlight !== false;
    const doShading = opts.removeShading !== false;
    const applied = {};
    if (doColor) {
      try { range.Font.Color = 0; applied.fontColor = "#000000"; }            // wdColorBlack=0 → 统一黑色
      catch (e) { applied.fontColorError = (e && e.message) || String(e); }
    }
    if (doHighlight) {
      try { range.HighlightColorIndex = 0; applied.highlight = "removed"; }   // 0=wdNoHighlight
      catch (e) { applied.highlightError = (e && e.message) || String(e); }
    }
    if (doShading) {
      try {
        const sh = range.Shading;
        if (sh) { try { sh.Texture = 0; } catch (e) {} sh.BackgroundPatternColor = -16777216; } // wdColorAutomatic → 去底纹
        applied.shading = "removed";
      } catch (e) { applied.shadingError = (e && e.message) || String(e); }
    }
    return { ok: true, scope: Array.isArray(opts.paragraphRange) ? opts.paragraphRange : "全文", applied };
  }

  // 读取文档所有批注：doc.Comments 集合。返回 [{index, author, text(批注内容), anchor(被批注原文), date}]
  async function readComments() {
    const doc = await ensureDocument();
    const comments = doc.Comments;
    const count = Number(comments && comments.Count) || 0;
    const clip = (t, n) => { const s = String(t == null ? "" : t).replace(/[\r\n\x07\t]+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
    const sg = (obj, prop) => { try { return obj ? obj[prop] : undefined; } catch (e) { return undefined; } };
    const out = [];
    for (let i = 1; i <= count; i += 1) {
      try {
        const c = comments.Item(i);
        out.push({
          index: i,
          author: clip(sg(c, "Author"), 60),
          text: clip(sg(sg(c, "Range"), "Text"), 500),
          anchor: clip(sg(sg(c, "Scope"), "Text"), 120),
          date: (() => { try { const d = sg(c, "Date"); return d ? String(d) : ""; } catch (e) { return ""; } })()
        });
      } catch (e) {}
    }
    return { total: out.length, comments: out };
  }

  // FullName 派生同名 .pdf；未保存（FullName 无路径分隔符）返回 null
  function derivePdfPath(fullName) {
    const s = String(fullName || "");
    if (!s || !/[\\/]/.test(s)) return null;
    return s.replace(/\.[^.\\/]+$/, "") + ".pdf";
  }

  // 修订（track changes）：读取 / 接受 / 拒绝 / 开关。COM 需真机验。
  const WD_REVISION_TYPE = {
    1: "插入", 2: "删除", 3: "属性", 5: "域", 8: "样式", 9: "替换",
    10: "段落属性", 11: "表格属性", 12: "节属性", 14: "移动(源)", 15: "移动(目标)",
    16: "单元格插入", 17: "单元格删除", 18: "单元格合并"
  };

  async function readRevisions(max) {
    const doc = await ensureDocument();
    const revs = doc.Revisions;
    const count = Number(revs && revs.Count) || 0;
    const clip = (t, n) => { const s = String(t == null ? "" : t).replace(/[\r\n\x07\t]+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
    const sg = (o, p) => { try { return o ? o[p] : undefined; } catch (e) { return undefined; } };
    const lim = Number(max) > 0 ? Number(max) : count;
    const out = [];
    for (let i = 1; i <= count && out.length < lim; i += 1) {
      try {
        const rv = revs.Item(i);
        out.push({
          index: i,
          author: clip(sg(rv, "Author"), 60),
          type: WD_REVISION_TYPE[Number(sg(rv, "Type"))] || "修订",
          text: clip(sg(sg(rv, "Range"), "Text"), 200),
          date: (() => { try { const d = sg(rv, "Date"); return d ? String(d) : ""; } catch (e) { return ""; } })()
        });
      } catch (e) {}
    }
    let trackOn = false; try { trackOn = !!doc.TrackRevisions; } catch (e) {}
    return { total: count, trackOn, revisions: out };
  }

  async function revisionCount() {
    const d = await ensureDocument();
    try { return Number(d.Revisions && d.Revisions.Count) || 0; } catch (e) { return 0; }
  }

  // 强制 WPS 立即重绘修订标记区域。接受/拒绝修订后 WPS 不主动刷新右侧气泡，需要外力触发。
  // 各方法在不同宿主/平台支持不一，全部 try 兜底；只要有一个生效即可。
  async function forceRevisionRepaint(doc) {
    let app = null;
    try { app = await getApp(); } catch (e) {}
    // 1) 关掉再打开「显示标记」——最直接地让修订标注层重画（值本身不变，纯触发重绘）。
    try {
      if (app && app.ActiveWindow && app.ActiveWindow.View) {
        const v = app.ActiveWindow.View;
        const cur = v.ShowRevisionsAndComments;
        v.ShowRevisionsAndComments = false;
        v.ShowRevisionsAndComments = cur == null ? true : cur;
      }
    } catch (e) {}
    // 2) 通用屏幕刷新（不做 Repaginate——整文重新分页很慢，反而拖长「应用中」）。
    try { if (app && typeof app.ScreenRefresh === "function") app.ScreenRefresh(); } catch (e) {}
    // 3) 兜底：切一下 ScreenUpdating 逼一次重绘。
    try { if (app) { app.ScreenUpdating = false; app.ScreenUpdating = true; } } catch (e) {}
  }

  async function manageRevisions(action) {
    const doc = await ensureDocument();
    if (action === "enable_track") { try { doc.TrackRevisions = true; } catch (e) {} }
    else if (action === "disable_track") { try { doc.TrackRevisions = false; } catch (e) {} }
    else if (action === "accept_all" || action === "reject_all") {
      // 接受 / 拒绝修订要求文档「未被保护」——修订模式下文档被 wdAllowOnlyRevisions 锁着，
      // 直接 AcceptAll/RejectAll 会被拦。先用固定 token 解掉我们的 AI 锁（解不开的是用户自己的锁，不动）。
      try {
        const token = (global.WpsAiLock && global.WpsAiLock.LOCK_TOKEN) || "lingxi-ai-doc-lock-v1";
        if (doc.ProtectionType != null && doc.ProtectionType !== -1) { try { doc.Unprotect(token); } catch (e) {} }
      } catch (e) {}
      const countOf = () => { try { return Number(doc.Revisions && doc.Revisions.Count) || 0; } catch (e) { return 0; } };
      const before = countOf();
      // 不同 WPS 版本方法位置不一：优先 Document.AcceptAllRevisions()，回退 Revisions.AcceptAll()
      if (action === "accept_all") {
        try { doc.AcceptAllRevisions(); } catch (e) { try { doc.Revisions.AcceptAll(); } catch (e2) {} }
      } else {
        try { doc.RejectAllRevisions(); } catch (e) { try { doc.Revisions.RejectAll(); } catch (e2) {} }
      }
      const after = countOf();
      if (before > 0 && after >= before) {
        throw new Error(`未能${action === "accept_all" ? "接受" : "回撤"}修订（仍有 ${after} 条）——文档可能仍被保护，或该 WPS 版本方法不同`);
      }
      // 接受/拒绝后 AcceptAllRevisions 已把修订从模型里清掉，但 WPS 常「懒重绘」——右侧修订标记/气泡
      // 要等下次滚动/交互才消失（用户实测 5-15s）。这里强制刷一次屏幕逼它立即重绘。COM 在不同 WPS
      // 版本 / mac 上支持不一，逐个 try 兜底。
      await forceRevisionRepaint(doc);
      return { action, before, after, applied: true };
    } else {
      throw new Error(`未知修订操作：${action}`);
    }
    let trackOn = false; try { trackOn = !!doc.TrackRevisions; } catch (e) {}
    return { action, trackOn, applied: true };
  }

  async function exportToPdf(path) {
    const doc = await ensureDocument();
    const out = path || derivePdfPath(doc.FullName);
    if (!out) throw new Error("文档尚未保存到磁盘，请先保存或显式传 path。");
    doc.ExportAsFixedFormat(out, 17 /*wdExportFormatPDF*/);
    return { path: out, applied: true };
  }

  // ---- 段落格式 / 页眉页脚 / 页面设置 / 脚注 / 域刷新 / 文档属性 / 另存 / 打印（第一二梯队）----
  const WD_ALIGN = { left: 0, center: 1, right: 2, justify: 3, distribute: 4 };
  const numOr = (v) => (typeof v === "number" && isFinite(v)) ? v : null;

  async function formatParagraph(opts = {}) {
    let pf;
    if (opts.scope === "document") {
      const d = await ensureDocument();
      pf = d.Content.ParagraphFormat;
    } else {
      const sel = await getSelection();
      if (!sel) throw new Error("未获取到选区。");
      pf = sel.ParagraphFormat;
    }
    if (opts.alignment && WD_ALIGN[opts.alignment] != null) { try { pf.Alignment = WD_ALIGN[opts.alignment]; } catch (e) {} }
    if (numOr(opts.leftIndent) != null) { try { pf.LeftIndent = opts.leftIndent; } catch (e) {} }
    if (numOr(opts.rightIndent) != null) { try { pf.RightIndent = opts.rightIndent; } catch (e) {} }
    if (numOr(opts.firstLineIndent) != null) { try { pf.FirstLineIndent = opts.firstLineIndent; } catch (e) {} }
    if (numOr(opts.spaceBefore) != null) { try { pf.SpaceBefore = opts.spaceBefore; } catch (e) {} }
    if (numOr(opts.spaceAfter) != null) { try { pf.SpaceAfter = opts.spaceAfter; } catch (e) {} }
    const WD_LS = { single: 0, oneAndHalf: 1, double: 2, atLeast: 3, exactly: 4, multiple: 5 };
    if (opts.lineSpacingRule && WD_LS[opts.lineSpacingRule] != null) {
      try { pf.LineSpacingRule = WD_LS[opts.lineSpacingRule]; } catch (e) {}
      if (numOr(opts.lineSpacing) != null) { try { pf.LineSpacing = opts.lineSpacing; } catch (e) {} }
    } else if (numOr(opts.lineSpacing) != null) {
      try { pf.LineSpacing = opts.lineSpacing; } catch (e) {}
    }
    return { scope: opts.scope || "selection", applied: true };
  }

  async function setHeaderFooter(opts = {}) {
    const d = await ensureDocument();
    const section = d.Sections.Item(1);
    const hf = opts.target === "footer" ? section.Footers.Item(1) : section.Headers.Item(1); // wdHeaderFooterPrimary=1
    const range = hf.Range;
    if (opts.text != null) { try { range.Text = String(opts.text); } catch (e) {} }
    if (opts.alignment && WD_ALIGN[opts.alignment] != null) { try { range.ParagraphFormat.Alignment = WD_ALIGN[opts.alignment]; } catch (e) {} }
    if (opts.pageNumber) {
      const PNA = { left: 0, center: 1, right: 2 };
      try { hf.PageNumbers.Add(PNA[opts.alignment] == null ? 2 : PNA[opts.alignment]); } catch (e) {}
    }
    return { target: opts.target || "header", applied: true };
  }

  async function pageSetup(opts = {}) {
    const d = await ensureDocument();
    const ps = d.PageSetup;
    if (opts.orientation) { try { ps.Orientation = opts.orientation === "landscape" ? 1 : 0; } catch (e) {} } // wdOrientLandscape=1
    if (numOr(opts.topMargin) != null) { try { ps.TopMargin = opts.topMargin; } catch (e) {} }
    if (numOr(opts.bottomMargin) != null) { try { ps.BottomMargin = opts.bottomMargin; } catch (e) {} }
    if (numOr(opts.leftMargin) != null) { try { ps.LeftMargin = opts.leftMargin; } catch (e) {} }
    if (numOr(opts.rightMargin) != null) { try { ps.RightMargin = opts.rightMargin; } catch (e) {} }
    const PAPER = { a4: 7, a3: 6, letter: 1, legal: 5 };
    if (opts.paperSize && PAPER[opts.paperSize] != null) { try { ps.PaperSize = PAPER[opts.paperSize]; } catch (e) {} }
    if (numOr(opts.columns) != null && opts.columns > 0) { try { ps.TextColumns.SetCount(opts.columns); } catch (e) {} }
    return { applied: true };
  }

  async function insertFootnote(opts = {}) {
    const d = await ensureDocument();
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到选区。");
    const text = String(opts.text || "");
    if (opts.kind === "endnote") { d.Endnotes.Add(sel.Range, "", text); }
    else { d.Footnotes.Add(sel.Range, "", text); }
    return { kind: opts.kind || "footnote", applied: true };
  }

  async function updateTocFields(opts = {}) {
    const d = await ensureDocument();
    const target = opts.target || "all";
    let tocN = 0;
    if (target === "toc" || target === "all") {
      const tocs = d.TablesOfContents;
      const n = Number(tocs && tocs.Count) || 0;
      for (let i = 1; i <= n; i += 1) { try { tocs.Item(i).Update(); tocN += 1; } catch (e) {} }
    }
    if (target === "fields" || target === "all") {
      try { d.Fields.Update(); } catch (e) {}
      try {
        const secs = d.Sections; const sn = Number(secs && secs.Count) || 0;
        for (let i = 1; i <= sn; i += 1) {
          try { secs.Item(i).Headers.Item(1).Range.Fields.Update(); } catch (e) {}
          try { secs.Item(i).Footers.Item(1).Range.Fields.Update(); } catch (e) {}
        }
      } catch (e) {}
    }
    return { target, tocUpdated: tocN, applied: true };
  }

  const WD_DOC_PROP_KEYS = { title: "Title", author: "Author", subject: "Subject", keywords: "Keywords", comments: "Comments", category: "Category", manager: "Manager", company: "Company" };
  async function docProperties(setObj) {
    const d = await ensureDocument();
    const props = d.BuiltInDocumentProperties;
    if (setObj && typeof setObj === "object") {
      for (const [k, v] of Object.entries(setObj)) {
        const name = WD_DOC_PROP_KEYS[k];
        if (name && v != null) { try { props.Item(name).Value = String(v); } catch (e) {} }
      }
    }
    const out = {};
    for (const [k, name] of Object.entries(WD_DOC_PROP_KEYS)) {
      try { out[k] = String(props.Item(name).Value == null ? "" : props.Item(name).Value); } catch (e) { out[k] = ""; }
    }
    return { properties: out };
  }

  async function saveAs(opts = {}) {
    const d = await ensureDocument();
    if (!opts.path) throw new Error("需要 path");
    const FMT = { docx: 16, doc: 0, pdf: 17, rtf: 6, txt: 2, html: 8 };
    const fmt = FMT[opts.format] == null ? 16 : FMT[opts.format];
    try { d.SaveAs2(opts.path, fmt); } catch (e) { d.SaveAs(opts.path, fmt); }
    return { path: opts.path, format: opts.format || "docx", applied: true };
  }

  async function printDoc() {
    const d = await ensureDocument();
    d.PrintOut();
    return { applied: true };
  }

  // ---- 样式清单 / 文本框 / 合并文档（第三梯队）----
  const WD_STYLE_TYPE = { 1: "段落", 2: "字符", 3: "表格", 4: "列表" };
  async function listStyles(max) {
    const d = await ensureDocument();
    const styles = d.Styles;
    const count = Number(styles && styles.Count) || 0;
    const lim = Number(max) > 0 ? Number(max) : 120;
    const sg = (o, p) => { try { return o ? o[p] : undefined; } catch (e) { return undefined; } };
    const out = [];
    for (let i = 1; i <= count && out.length < lim; i += 1) {
      try {
        const s = styles.Item(i);
        out.push({
          name: String(sg(s, "NameLocal") || sg(s, "Name") || ""),
          type: WD_STYLE_TYPE[Number(sg(s, "Type"))] || "",
          builtIn: !!sg(s, "BuiltIn"),
          inUse: !!sg(s, "InUse")
        });
      } catch (e) {}
    }
    return { total: count, styles: out };
  }

  async function insertTextbox(opts = {}) {
    const d = await ensureDocument();
    const L = numOr(opts.left) != null ? opts.left : 100;
    const T = numOr(opts.top) != null ? opts.top : 100;
    const W = numOr(opts.width) != null ? opts.width : 200;
    const H = numOr(opts.height) != null ? opts.height : 100;
    // Shapes.AddTextbox(Orientation=msoTextOrientationHorizontal(1), Left, Top, Width, Height)
    const box = d.Shapes.AddTextbox(1, L, T, W, H);
    if (opts.text != null) { try { box.TextFrame.TextRange.Text = String(opts.text); } catch (e) {} }
    return { applied: true };
  }

  async function insertFileAt(opts = {}) {
    if (!opts.path) throw new Error("需要 path");
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到选区。");
    sel.InsertFile(String(opts.path));
    return { path: opts.path, applied: true };
  }

  // ---- 题注 / 逐条修订 / 水印 / 视图（A 组）----
  const WD_CAPTION_LABEL = { figure: -1, table: -2, equation: -3 };
  async function addCaption(opts = {}) {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到选区。");
    const lbl = WD_CAPTION_LABEL[opts.label] != null ? WD_CAPTION_LABEL[opts.label] : String(opts.label || "");
    const title = opts.title ? "：" + opts.title : "";
    // InsertCaption(Label, Title, TitleAutoText, Position: wdCaptionPositionBelow=1 / Above=0)
    sel.InsertCaption(lbl, title, undefined, opts.position === "above" ? 0 : 1);
    return { label: opts.label || "figure", applied: true };
  }

  async function acceptRejectRevision(opts = {}) {
    const d = await ensureDocument();
    const revs = d.Revisions;
    const count = Number(revs && revs.Count) || 0;
    const idx = Number(opts.index);
    if (!(idx >= 1 && idx <= count)) throw new Error(`修订序号超范围(1..${count})`);
    const rv = revs.Item(idx);
    if (opts.action === "reject") rv.Reject(); else rv.Accept();
    return { index: idx, action: opts.action || "accept", applied: true };
  }

  async function addWatermark(opts = {}) {
    const d = await ensureDocument();
    const text = String(opts.text || "");
    if (!text) throw new Error("需要 text");
    const header = d.Sections.Item(1).Headers.Item(1); // wdHeaderFooterPrimary=1
    // AddTextEffect(PresetTextEffect: msoTextEffect1=0, Text, FontName, FontSize, FontBold(msoFalse=0), FontItalic, Left, Top)
    const shape = header.Shapes.AddTextEffect(0, text, opts.fontName || "宋体", numOr(opts.fontSize) || 40, 0, 0, 0, 0);
    try { shape.Fill.ForeColor.RGB = 0xC0C0C0; } catch (e) {}   // 浅灰
    try { shape.Fill.Transparency = 0.5; } catch (e) {}
    try { shape.Line.Visible = 0; } catch (e) {}                // msoFalse
    try { shape.Rotation = opts.diagonal === false ? 0 : 315; } catch (e) {}
    try { shape.Left = -999999; } catch (e) {}                  // wdShapeCenter
    try { shape.Top = -999999; } catch (e) {}
    return { text, applied: true };
  }

  async function setView(opts = {}) {
    const app = await getApp();
    if (numOr(opts.zoom) != null && opts.zoom > 0) {
      try { app.ActiveWindow.View.Zoom.Percentage = Number(opts.zoom); }
      catch (e) { try { app.ActiveWindow.ActivePane.View.Zoom.Percentage = Number(opts.zoom); } catch (e2) {} }
    }
    if (numOr(opts.gotoPage) != null && opts.gotoPage > 0) {
      const sel = await getSelection();
      // Selection.GoTo(What: wdGoToPage=1, Which: wdGoToAbsolute=1, Count)
      try { sel.GoTo(1, 1, Number(opts.gotoPage)); } catch (e) {}
    }
    return { applied: true };
  }

  // ---- 修订模式：AI 改动前后包一层，让 AI 的编辑记为原生修订 + 作者标为「文小舟」----
  // 状态存模块内：beginRevise 记下当前 UserName，endRevise 还原，避免把用户自己的手改也记成 AI。
  let _reviseAuthorPrev = null;
  async function beginRevise(author) {
    const d = await ensureDocument();
    try { d.TrackRevisions = true; } catch (e) {}
    try {
      const app = await getApp();
      if (app) {
        if (_reviseAuthorPrev == null) _reviseAuthorPrev = String(app.UserName == null ? "" : app.UserName);
        app.UserName = String(author || "文小舟");
      }
    } catch (e) {}
    return { applied: true };
  }
  async function endRevise() {
    try {
      const app = await getApp();
      if (app && _reviseAuthorPrev != null) { app.UserName = _reviseAuthorPrev; _reviseAuthorPrev = null; }
    } catch (e) {}
    return { applied: true };
  }

  global.WpsAiHostWriter = {
    host: "wps",
    label: "WPS 文字",
    readComments,                // 读取文档所有批注
    readRevisions,               // 读取修订（track changes）
    revisionCount,               // 修订条数（给 UI 判断是否显示接受/回撤按钮）
    manageRevisions,             // 接受/拒绝全部修订 + 开关修订
    exportToPdf,                 // 导出为 PDF
    formatParagraph,             // 段落格式（对齐/缩进/行距/段前段后）
    setHeaderFooter,             // 页眉页脚 + 页码
    pageSetup,                   // 页面设置（纸张/边距/横竖/分栏）
    insertFootnote,              // 脚注/尾注
    updateTocFields,             // 刷新目录/域
    docProperties,               // 文档属性读写
    saveAs,                      // 另存为
    printDoc,                    // 打印
    listStyles,                  // 列出文档样式
    insertTextbox,               // 插入文本框
    insertFileAt,                // 合并/插入其它文档
    addCaption,                  // 题注
    acceptRejectRevision,        // 逐条接受/拒绝修订
    addWatermark,                // 文字水印
    setView,                     // 视图缩放/定位
    beginRevise,                 // 修订模式：AI 改动前打开修订 + 作者设为文小舟
    endRevise,                   // 修订模式：AI 改动后还原作者
    findColoredText,             // 找红字/高亮/底纹（背景色）文本片段
    clearTextFormatting,         // 批量：统一黑字 + 去高亮 + 去底纹（一次调用整篇）

    readSelectionText,
    readSelectionInfo,           // AI 排版「仅选中区域」用：{ start, end, text } 或 null
    readSelectionSnapshot,
    readDocumentText,
    sampleDocumentFormatting,
    readDocumentStructure,       // 表格 / 图片保留用：结构化读取，AI 只处理 paragraph
    readDocumentSections,        // 长文改写用：带 headingLevel 的段落遍历，供 splitSections 切节
    headingLevelFromStyle,       // 纯函数：段落 Style 名 -> 标题级别 1-3 / 0
    readDocumentContext,
    readByScope,
    insertText,
    replaceSelectionText,
    replaceRangeText,
    replaceDocumentBlocks,
    replaceDocumentBlocksHtml,
    replaceParagraphsInPlace,    // 表格 / 图片保留用：分段范围替换，跳过非段落
    replaceTextPreservingObjects, // 嵌入对象保留：对象间文本区逐区替换，对象 Range 不触碰
    replaceSectionsInPlace,      // 长文改写用：节级自底向上写回
    addBookmarkAtRange,          // 结构重排写回（Task 8）：按 [start,end) 打命名书签
    reorderSectionsByBookmarks,  // 结构重排写回（Task 8）：按书签+targetOrder 整节搬动
    addCommentAtRange,           // 批注式校对（P1-3）：区间上加 Word 批注
    blocksToHtml,                // 导出为新 Word 文件（P2-6）：blocks → Word 兼容 HTML
    getScopeOptions,
    formatDocContextForPrompt,
    _internal: { coerceBlocks, formatDocContextForPrompt }
  };
})(window);
