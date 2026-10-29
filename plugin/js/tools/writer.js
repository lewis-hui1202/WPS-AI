(function attachWriterTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const doc = () => global.WpsAiDocument;
  const writer = () => global.WpsAiHostWriter;
  const imageAssets = () => global.WpsAiImageAssets;
  const WD_COLLAPSE_END = 0;
  const MSO = { TRUE: -1, FALSE: 0 };
  function proxyBaseUrl() { return (window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"); }
  function DEBUG_LOG_URL() { return proxyBaseUrl() + "/debug-log"; }
  function LOCAL_IMAGE_INFO_URL() { return proxyBaseUrl() + "/local-image-info"; }
  function IMAGE_HTML_FILE_URL() { return proxyBaseUrl() + "/image-html-file"; }
  function IMAGE_RTF_FILE_URL() { return proxyBaseUrl() + "/image-rtf-file"; }
  function CLIPBOARD_IMAGE_URL() { return proxyBaseUrl() + "/clipboard/image"; }

  const BLOCK_SCHEMA = {
    type: "array",
    description: "结构化内容块数组，直接写 Word 原生格式（不要传 markdown 字符串）",
    items: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["heading", "paragraph", "list", "table", "quote", "code", "spacer"] },
        level: { type: "integer", description: "heading 级别 1-6" },
        text: { type: "string", description: "paragraph/heading/quote/code 的纯文本" },
        runs: { type: "array", description: "paragraph 富文本：[{text, bold?, italic?, code?}]",
          items: { type: "object", properties: {
            text: { type: "string" }, bold: { type: "boolean" }, italic: { type: "boolean" }, code: { type: "boolean" }
          }, required: ["text"] } },
        ordered: { type: "boolean", description: "list 是否有序" },
        items: { type: "array", items: { type: "string" }, description: "list 各项" },
        header: { type: "boolean", description: "table 首行是否表头" },
        rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table 行×列" }
      },
      required: ["type"]
    }
  };

  function normalizeBlocksOrText(blocks, text) {
    if (Array.isArray(blocks)) return { payload: blocks, mode: "blocks", count: blocks.length, coerced: false };
    if (blocks && typeof blocks === "object") return { payload: [blocks], mode: "blocks", count: 1, coerced: true };
    if (typeof blocks === "string" && blocks.trim()) {
      const raw = blocks.trim();
      if (/^\s*[\[{]/.test(raw)) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return { payload: parsed, mode: "blocks", count: parsed.length, coerced: true };
          if (parsed && typeof parsed === "object") return { payload: [parsed], mode: "blocks", count: 1, coerced: true };
        } catch (error) {
          const extracted = extractTextFromJsonishBlocks(raw);
          return {
            payload: extracted || raw,
            mode: "text",
            count: extracted ? extracted.split(/\n+/).filter(Boolean).length : 1,
            coerced: true,
            warning: `blocks JSON parse failed: ${error?.message || error}`
          };
        }
      }
      return { payload: raw, mode: "text", count: 1, coerced: true };
    }
    if (typeof text === "string" && text.length) return { payload: text, mode: "text", count: 1, coerced: false };
    return { payload: "", mode: "text", count: 0, coerced: false, warning: "empty payload" };
  }

  function unquoteJsonString(value) {
    try { return JSON.parse(`"${String(value || "").replace(/"/g, '\\"')}"`); } catch (e) { return String(value || ""); }
  }

  function extractTextFromJsonishBlocks(raw) {
    const out = [];
    const re = /"text"\s*:\s*"([^"]*)"|"items"\s*:\s*\[((?:"[^"]*"\s*,?\s*)*)\]/g;
    let m;
    while ((m = re.exec(raw))) {
      if (m[1] != null) {
        const text = unquoteJsonString(m[1]).trim();
        if (text) out.push(text);
      } else if (m[2] != null) {
        try {
          const items = JSON.parse(`[${m[2]}]`);
          items.forEach((item) => {
            const text = String(item || "").trim();
            if (text) out.push(`- ${text}`);
          });
        } catch (e) {}
      }
    }
    return out.join("\n");
  }

  registry.registerTool({
    name: "wps_read_selection",
    hosts: ["wps"],
    description: "读取 WPS 文字 当前选区文本。maxChars+offset 可分页（截断时返回 truncated 与 nextOffset）；includeRangeInfo=true 附带选区 range{start,end}。",
    parameters: {
      type: "object",
      properties: {
        maxChars: { type: "integer", minimum: 1, description: "最多返回字符数（分页上限）" },
        offset: { type: "integer", minimum: 0, description: "起始字符偏移，默认 0" },
        includeRangeInfo: { type: "boolean", description: "是否附带选区 range{start,end}" }
      }
    },
    handler: async ({ maxChars, offset, includeRangeInfo } = {}) => {
      let fullText = await writer().readSelectionText();
      // 选区含对象时改用带占位符文本（把结构过滤到选区范围）
      try {
        const P = global.WpsAiPreserveObjects;
        const info = typeof writer().readSelectionInfo === "function" ? await writer().readSelectionInfo() : null;
        if (P && info && Number.isFinite(info.start) && Number.isFinite(info.end) && typeof writer().readDocumentStructure === "function") {
          const structure = await writer().readDocumentStructure();
          const segs = ((structure && structure.segments) || []).filter((s) => s.start >= info.start && s.end <= info.end);
          if (segs.some((s) => P.isObjectKind(s.kind))) {
            fullText = P.renderStructureWithPlaceholders({ segments: segs }).text;
          }
        }
      } catch (e) {}
      const page = global.WpsAiReadUtils.paginateText(fullText, { offset: offset || 0, maxChars: maxChars || 0 });
      const out = { text: page.slice, length: fullText.length, truncated: page.truncated, nextOffset: page.nextOffset };
      if (includeRangeInfo) {
        try {
          const info = await writer().readSelectionInfo();
          out.range = info ? { start: info.start, end: info.end } : null;
        } catch (e) { out.range = null; }
      }
      return out;
    }
  });

  registry.registerTool({
    name: "wps_clear_text_formatting",
    hosts: ["wps"],
    description: [
      "批量把 WPS 文字 文档字体统一黑色、去除荧光笔高亮 / 段落底纹(背景色)——一次调用处理整篇(或指定段落范围)，不用逐处修改。",
      "「把文字都统一黑色 / 去背景色 / 清除高亮」这类整体清理直接用本工具，避免逐个片段操作导致大量模型请求(rpm 超限)。",
      "参数均可选：paragraphRange:[起,止] 限段落范围(默认全文)；resetColor / removeHighlight / removeShading 各自可关(默认都做)。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        paragraphRange: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "段落序号范围 [起,止]，默认全文" },
        resetColor: { type: "boolean", description: "字体统一黑色，默认 true" },
        removeHighlight: { type: "boolean", description: "去除荧光笔高亮，默认 true" },
        removeShading: { type: "boolean", description: "去除段落底纹(背景色)，默认 true" }
      }
    },
    handler: async (opts = {}) => {
      const fn = writer().clearTextFormatting;
      if (typeof fn !== "function") throw new Error("当前宿主不支持批量清除格式。");
      return await fn.call(writer(), opts || {});
    }
  });

  registry.registerTool({
    name: "wps_read_comments",
    hosts: ["wps"],
    description: "读取 WPS 文字 文档中的所有批注，返回 comments:[{index, author(作者), text(批注内容), anchor(被批注的原文), date(时间)}]。问“文档有哪些批注/审阅意见”用本工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const fn = writer().readComments;
      if (typeof fn !== "function") throw new Error("当前宿主不支持读取批注。");
      return await fn.call(writer());
    }
  });

  registry.registerTool({
    name: "wps_read_revisions",
    hosts: ["wps"],
    description: "读取 WPS 文字 文档的修订（track changes），返回 {total, trackOn(是否开着修订), revisions:[{index, author(作者), type(插入/删除/格式…), text(涉及原文), date}]}。问“文档有哪些修订/改了什么”用本工具。",
    parameters: { type: "object", properties: { max: { type: "integer", minimum: 1, description: "最多返回条数" } } },
    handler: async ({ max } = {}) => {
      const fn = writer().readRevisions;
      if (typeof fn !== "function") throw new Error("当前宿主不支持读取修订。");
      return await fn.call(writer(), max);
    }
  });

  registry.registerTool({
    name: "wps_manage_revisions",
    hosts: ["wps"],
    description: "处理 WPS 文字 修订。action：accept_all(接受全部)/reject_all(拒绝全部)/enable_track(打开修订)/disable_track(关闭修订)。",
    parameters: {
      type: "object",
      required: ["action"],
      properties: { action: { type: "string", enum: ["accept_all", "reject_all", "enable_track", "disable_track"] } }
    },
    handler: async ({ action } = {}) => {
      const fn = writer().manageRevisions;
      if (typeof fn !== "function") throw new Error("当前宿主不支持处理修订。");
      return await fn.call(writer(), action);
    }
  });

  registry.registerTool({
    name: "wps_export_pdf",
    hosts: ["wps"],
    description: "把当前 WPS 文字 文档导出为 PDF。path 省略时导到文档同目录同名 .pdf（文档需已保存到磁盘）。",
    parameters: { type: "object", properties: { path: { type: "string", description: "输出 PDF 完整路径，省略=同目录同名" } } },
    handler: async ({ path } = {}) => {
      const fn = writer().exportToPdf;
      if (typeof fn !== "function") throw new Error("当前宿主不支持导出 PDF。");
      return await fn.call(writer(), path);
    }
  });

  registry.registerTool({
    name: "wps_format_paragraph",
    hosts: ["wps"],
    description: "设置段落格式（字体之外的排版）。scope=selection(选区,默认)/document(全文)。alignment 对齐(left/center/right/justify/distribute)；leftIndent/rightIndent/firstLineIndent 缩进(磅)；lineSpacing 行距(磅) + lineSpacingRule(single/oneAndHalf/double/atLeast/exactly/multiple)；spaceBefore/spaceAfter 段前段后(磅)。",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["selection", "document"] },
        alignment: { type: "string", enum: ["left", "center", "right", "justify", "distribute"] },
        leftIndent: { type: "number" }, rightIndent: { type: "number" }, firstLineIndent: { type: "number" },
        lineSpacing: { type: "number" }, lineSpacingRule: { type: "string", enum: ["single", "oneAndHalf", "double", "atLeast", "exactly", "multiple"] },
        spaceBefore: { type: "number" }, spaceAfter: { type: "number" }
      }
    },
    handler: async (opts = {}) => {
      const fn = writer().formatParagraph;
      if (typeof fn !== "function") throw new Error("当前宿主不支持段落格式。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_set_header_footer",
    hosts: ["wps"],
    description: "设置页眉或页脚。target=header/footer。text=文字内容；pageNumber=true 插入页码；alignment 对齐(left/center/right)。",
    parameters: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", enum: ["header", "footer"] },
        text: { type: "string" },
        pageNumber: { type: "boolean" },
        alignment: { type: "string", enum: ["left", "center", "right"] }
      }
    },
    handler: async (opts = {}) => {
      const fn = writer().setHeaderFooter;
      if (typeof fn !== "function") throw new Error("当前宿主不支持页眉页脚。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_page_setup",
    hosts: ["wps"],
    description: "页面设置。orientation=portrait/landscape；topMargin/bottomMargin/leftMargin/rightMargin 页边距(磅)；paperSize=a4/a3/letter/legal；columns 分栏数。",
    parameters: {
      type: "object",
      properties: {
        orientation: { type: "string", enum: ["portrait", "landscape"] },
        topMargin: { type: "number" }, bottomMargin: { type: "number" }, leftMargin: { type: "number" }, rightMargin: { type: "number" },
        paperSize: { type: "string", enum: ["a4", "a3", "letter", "legal"] },
        columns: { type: "integer", minimum: 1 }
      }
    },
    handler: async (opts = {}) => {
      const fn = writer().pageSetup;
      if (typeof fn !== "function") throw new Error("当前宿主不支持页面设置。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_insert_footnote",
    hosts: ["wps"],
    description: "在光标处插入脚注或尾注。kind=footnote(脚注,默认)/endnote(尾注)，text=注释内容。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: { kind: { type: "string", enum: ["footnote", "endnote"] }, text: { type: "string" } }
    },
    handler: async (opts = {}) => {
      const fn = writer().insertFootnote;
      if (typeof fn !== "function") throw new Error("当前宿主不支持脚注。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_update_toc_fields",
    hosts: ["wps"],
    description: "刷新目录和/或域（编辑后页码/交叉引用会过期）。target=toc(仅目录)/fields(仅域)/all(默认)。",
    parameters: { type: "object", properties: { target: { type: "string", enum: ["toc", "fields", "all"] } } },
    handler: async (opts = {}) => {
      const fn = writer().updateTocFields;
      if (typeof fn !== "function") throw new Error("当前宿主不支持刷新目录/域。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_doc_properties",
    hosts: ["wps"],
    description: "读取/设置文档属性（标题/作者/主题/关键字等）。传 set 则写入；始终返回当前全部属性。",
    parameters: { type: "object", properties: { set: { type: "object", description: "写入项，键 title/author/subject/keywords/comments/category/manager/company" } } },
    handler: async ({ set } = {}) => {
      const fn = writer().docProperties;
      if (typeof fn !== "function") throw new Error("当前宿主不支持文档属性。");
      return await fn.call(writer(), set);
    }
  });

  registry.registerTool({
    name: "wps_save_as",
    hosts: ["wps"],
    description: "把文档另存为指定格式。path=完整路径，format：docx/doc/pdf/rtf/txt/html。",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, format: { type: "string", enum: ["docx", "doc", "pdf", "rtf", "txt", "html"] } }
    },
    handler: async (opts = {}) => {
      const fn = writer().saveAs;
      if (typeof fn !== "function") throw new Error("当前宿主不支持另存为。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_print",
    hosts: ["wps"],
    description: "打印当前文档（默认打印机）。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const fn = writer().printDoc;
      if (typeof fn !== "function") throw new Error("当前宿主不支持打印。");
      return await fn.call(writer());
    }
  });

  registry.registerTool({
    name: "wps_list_styles",
    hosts: ["wps"],
    description: "列出文档可用样式（名称/类型/是否内置/是否已用），配合 wps_apply_paragraph_style 使用。max 控制上限。",
    parameters: { type: "object", properties: { max: { type: "integer", minimum: 1 } } },
    handler: async ({ max } = {}) => {
      const fn = writer().listStyles;
      if (typeof fn !== "function") throw new Error("当前宿主不支持列出样式。");
      return await fn.call(writer(), max);
    }
  });

  registry.registerTool({
    name: "wps_insert_textbox",
    hosts: ["wps"],
    description: "插入文本框。text=内容，left/top/width/height 位置尺寸(磅，省略取默认)。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
      }
    },
    handler: async (opts = {}) => {
      const fn = writer().insertTextbox;
      if (typeof fn !== "function") throw new Error("当前宿主不支持文本框。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_insert_file",
    hosts: ["wps"],
    description: "在光标处插入/合并另一个文档文件（把 path 指向的文件内容并入当前文档）。",
    parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "要插入的文档完整路径" } } },
    handler: async (opts = {}) => {
      const fn = writer().insertFileAt;
      if (typeof fn !== "function") throw new Error("当前宿主不支持插入文件。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_add_caption",
    hosts: ["wps"],
    description: "在光标处插入题注。label=figure(图)/table(表)/equation(公式)或自定义标签文字；title=题注说明文字；position=below(默认)/above。",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "figure/table/equation 或自定义标签" },
        title: { type: "string" },
        position: { type: "string", enum: ["below", "above"] }
      }
    },
    handler: async (opts = {}) => {
      const fn = writer().addCaption;
      if (typeof fn !== "function") throw new Error("当前宿主不支持题注。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_accept_reject_revision",
    hosts: ["wps"],
    description: "接受或拒绝单条修订（按序号，配合 wps_read_revisions 的 index）。index=修订序号(1起)，action=accept(默认)/reject。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: { index: { type: "integer", minimum: 1 }, action: { type: "string", enum: ["accept", "reject"] } }
    },
    handler: async (opts = {}) => {
      const fn = writer().acceptRejectRevision;
      if (typeof fn !== "function") throw new Error("当前宿主不支持逐条修订。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_add_watermark",
    hosts: ["wps"],
    description: "加文字水印（灰色半透明斜排，插入到页眉）。text=水印文字，fontName/fontSize 可选，diagonal=false 则水平不倾斜。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        fontName: { type: "string" },
        fontSize: { type: "number" },
        diagonal: { type: "boolean" }
      }
    },
    handler: async (opts = {}) => {
      const fn = writer().addWatermark;
      if (typeof fn !== "function") throw new Error("当前宿主不支持水印。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_set_view",
    hosts: ["wps"],
    description: "调整视图。zoom=缩放百分比；gotoPage=跳到第几页。",
    parameters: { type: "object", properties: { zoom: { type: "integer", minimum: 10, maximum: 500 }, gotoPage: { type: "integer", minimum: 1 } } },
    handler: async (opts = {}) => {
      const fn = writer().setView;
      if (typeof fn !== "function") throw new Error("当前宿主不支持视图设置。");
      return await fn.call(writer(), opts);
    }
  });

  registry.registerTool({
    name: "wps_find_colored_text",
    hosts: ["wps"],
    description: [
      "扫描 WPS 文字 文档，找出所有带非默认字体颜色 / 荧光笔高亮 / 段落底纹（背景色）的文本片段。",
      "用于回答「哪些是红字 / 哪些高亮 / 哪些带背景色」这类问题——普通 text/structured 读取不含颜色信息，问颜色/高亮/背景就用本工具。",
      "返回 spans:[{paragraph(段号), text, fontColor(#RRGGBB，无则不含), highlight(荧光笔色名，无则不含), background(段落底纹 #RRGGBB，无则不含)}]；limit 控制上限（默认 200，超出 truncated=true）。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, description: "最多返回片段数，默认 200" }
      }
    },
    handler: async ({ limit } = {}) => {
      const fn = writer().findColoredText;
      if (typeof fn !== "function") throw new Error("当前宿主不支持颜色扫描。");
      return await fn.call(writer(), { limit });
    }
  });

  registry.registerTool({
    name: "wps_sample_document_formatting",
    hosts: ["wps"],
    description: "只读提取文字文档的段落格式，不读取正文、不修改文档。用于根据现有文档格式创建技能。默认优先选区，否则全篇均匀抽样（最多100段）；返回样本数量与总段数，不能把抽样结果当成全篇。用户明确要求更完整分析时可用 mode=page、offset、nextOffset 分批读取；支持停止。",
    parameters: { type: "object", properties: {
      scope: { type: "string", enum: ["auto", "selection", "document"], description: "默认 auto：优先非空选区" },
      mode: { type: "string", enum: ["sample", "page"], description: "默认 sample；page 按段落分页" },
      maxParagraphs: { type: "integer", minimum: 1, maximum: 100, description: "每次最多读取段落数，默认40" },
      offset: { type: "integer", minimum: 0, description: "page 模式的零起始段落偏移" }
    } },
    handler: async (args = {}, ctx = {}) => {
      const fn = writer()?.sampleDocumentFormatting;
      if (typeof fn !== "function") throw new Error("当前宿主不支持格式采样。");
      return await fn.call(writer(), { ...args, signal: ctx.signal });
    }
  });

  registry.registerTool({
    name: "wps_read_document",
    hosts: ["wps"],
    description: [
      "读取 WPS 文字 文档内容。mode：text(默认，纯文本) / structured(带样式的结构化块) / outline(仅标题大纲)。",
      "按节读：paragraphRange:[起,止] 按段落序号（1 起，闭区间）；或 fromHeadingIndex/toHeadingIndex 传 wps_get_outline 返回的 index（止=下一个标题的 index 即取该节）。",
      "大文档分页：maxChars+offset，截断时返回 truncated 与 nextOffset。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["text", "structured", "outline"], description: "读取形态，默认 text" },
        paragraphRange: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "[起始段落, 结束段落]（1 起，闭区间）" },
        fromHeadingIndex: { type: "integer", minimum: 1, description: "起始段落序号（wps_get_outline 的 index）" },
        toHeadingIndex: { type: "integer", minimum: 1, description: "结束段落序号（含）；取整节时传下一标题的 index" },
        maxChars: { type: "integer", minimum: 1, description: "text 模式最多返回字符数（分页上限）" },
        offset: { type: "integer", minimum: 0, description: "text 模式起始字符偏移，默认 0" }
      }
    },
    handler: async ({ mode, paragraphRange, fromHeadingIndex, toHeadingIndex, maxChars, offset } = {}) => {
      const ru = global.WpsAiReadUtils;
      // outline 模式：只回标题大纲
      if (mode === "outline") {
        const document = await getActiveDocument();
        const paras = document.Paragraphs;
        const count = paras?.Count || 0;
        const headings = [];
        for (let i = 1; i <= count; i += 1) {
          let styleName = "";
          try {
            const style = paras.Item(i).Style;
            styleName = typeof style === "string" ? style : (style?.NameLocal || style?.Name || "");
          } catch (e) { styleName = ""; }
          const m = /^(?:Heading|标题)\s*(\d)/i.exec(styleName);
          if (m) {
            let text = "";
            try { text = String(paras.Item(i).Range.Text || "").replace(/[\r\n]+$/g, ""); } catch (e) {}
            headings.push({ level: parseInt(m[1], 10), text, index: i });
          }
        }
        return { mode: "outline", count: headings.length, headings };
      }
      // structured 模式：带样式的结构化块（宿主支持时）
      if (mode === "structured") {
        const fn = writer().readDocumentStructure;
        if (typeof fn !== "function") throw new Error("当前宿主不支持 structured 读取，请用 mode:text。");
        const structure = await fn.call(writer());
        return { mode: "structured", structure };
      }
      // text 模式（默认）：可选段落/标题范围 + 分页
      let fullText;
      let range = null;
      const hasRange = Array.isArray(paragraphRange) || fromHeadingIndex != null || toHeadingIndex != null;
      if (hasRange) {
        const document = await getActiveDocument();
        const total = document.Paragraphs?.Count || 0;
        const from = Array.isArray(paragraphRange) ? paragraphRange[0] : fromHeadingIndex;
        const to = Array.isArray(paragraphRange) ? paragraphRange[1] : toHeadingIndex;
        const r = ru.clampIndexRange({ from, to, count: total });
        range = { fromParagraph: r.from, toParagraph: r.to };
        const parts = [];
        for (let i = r.from; i <= r.to; i += 1) {
          try { parts.push(String(document.Paragraphs.Item(i).Range.Text || "")); } catch (e) {}
        }
        fullText = parts.join("");
      } else {
        // 全文 text 模式：含对象时带占位符（保对象位置感），无对象退回纯文本
        let placeholderText = null;
        try {
          const P = global.WpsAiPreserveObjects;
          if (P && typeof writer().readDocumentStructure === "function") {
            const structure = await writer().readDocumentStructure();
            const hasObject = ((structure && structure.segments) || []).some((s) => P.isObjectKind(s.kind));
            if (hasObject) placeholderText = P.renderStructureWithPlaceholders(structure).text;
          }
        } catch (e) {}
        fullText = placeholderText != null ? placeholderText : await writer().readDocumentText();
      }
      const page = ru.paginateText(fullText, { offset: offset || 0, maxChars: maxChars || 0 });
      const out = { mode: "text", text: page.slice, length: fullText.length, truncated: page.truncated, nextOffset: page.nextOffset };
      if (range) out.range = range;
      return out;
    }
  });

  registry.registerTool({
    name: "wps_insert_text",
    hosts: ["wps"],
    description: "在当前光标处插入内容。用结构化 blocks 数组（标题/段落/列表/表格等），直接渲染成 Word 原生格式；不要传 markdown。简单纯文本可用 text。",
    parameters: {
      type: "object",
      properties: { blocks: BLOCK_SCHEMA, text: { type: "string", description: "纯文本快捷插入（无格式时用）" } }
    },
    handler: async ({ blocks, text } = {}) => {
      const normalized = normalizeBlocksOrText(blocks, text);
      if (!normalized.count) throw new Error("wps_insert_text 收到空内容，未执行插入。");
      await writer().insertText(normalized.payload, {});
      return {
        inserted: normalized.count,
        mode: normalized.mode,
        coerced: normalized.coerced,
        warning: normalized.warning
      };
    }
  });

  registry.registerTool({
    name: "wps_replace_selection",
    hosts: ["wps"],
    description: "用结构化 blocks 替换当前选区（Word 原生格式）；不要传 markdown。简单纯文本可用 text。全文 AI 排版请走排版预览弹窗。",
    parameters: {
      type: "object",
      properties: { blocks: BLOCK_SCHEMA, text: { type: "string", description: "纯文本替换" } }
    },
    handler: async ({ blocks, text } = {}) => {
      const normalized = normalizeBlocksOrText(blocks, text);
      if (!normalized.count) throw new Error("wps_replace_selection 收到空内容，未执行替换。");
      // 选区含对象 -> 走保留路径（对象不删），无论 blocks 还是 text。
      // blocks 原样；text 先包成单段 paragraph（其中的占位符由 splitBlocksByPlaceholder 行内解析）。
      if (typeof writer().replaceTextPreservingObjects === "function") {
        const payloadBlocks = normalized.mode === "blocks"
          ? normalized.payload
          : [{ type: "paragraph", text: String(normalized.payload) }];
        try {
          // 用 readSelectionSnapshot 取区间：无文字的浮动对象选区也能拿到 range，
          // 不像 readSelectionInfo 会在无文字时返回 null 而漏检（I1）。
          const snap = typeof writer().readSelectionSnapshot === "function" ? await writer().readSelectionSnapshot() : null;
          const range = snap && snap.range ? snap.range : null;
          if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start
              && await rangeHasObjects(range.start, range.end)) {
            const res = await writer().replaceTextPreservingObjects(payloadBlocks, { range: { start: range.start, end: range.end } });
            return { replaced: res.replaced, preserved: res.objectsPreserved, skipped: res.skipped, mode: "preserve-objects" };
          }
        } catch (e) {
          // 检测/准备/替换任一步失败 -> 明确抛错，绝不退回破坏性删除
          throw new Error("检测/准备选区保留路径失败，已中止以避免删除对象：" + (e?.message || e));
        }
      }
      await writer().replaceSelectionText(normalized.payload, {});
      return {
        replaced: normalized.count,
        mode: normalized.mode,
        coerced: normalized.coerced,
        warning: normalized.warning
      };
    }
  });

  registry.registerTool({
    name: "wps_find_replace",
    hosts: ["wps"],
    description: "在当前 WPS 文字 文档全局执行查找/替换。",
    parameters: {
      type: "object",
      required: ["find", "replace"],
      properties: {
        find: { type: "string", description: "要查找的文本" },
        replace: { type: "string", description: "替换为" },
        matchCase: { type: "boolean", default: false }
      }
    },
    handler: async ({ find, replace, matchCase = false } = {}) => {
      const app = await doc().getApplication();
      const document = app?.ActiveDocument;
      if (!document) throw new Error("未检测到活动文档。");
      const range = document.Content;
      const finder = range.Find;
      finder.Text = find;
      finder.Replacement.Text = replace;
      finder.MatchCase = matchCase;
      // wdReplaceAll = 2
      const ok = finder.Execute(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
      return { matched: !!ok };
    }
  });

  // ---- 内部工具 ----

  async function documentHasObjects() {
    const P = global.WpsAiPreserveObjects;
    // 能力缺失（模块未加载 / 宿主不支持）-> 回退原行为
    if (!P || typeof writer().readDocumentStructure !== "function") return false;
    // 读结构若抛错，向上传播 -> 调用方据此中止，绝不退回破坏性删除（spec §5）
    const structure = await writer().readDocumentStructure();
    return (((structure && structure.segments) || []).some((s) => P.isObjectKind(s.kind)));
  }

  async function rangeHasObjects(start, end) {
    const P = global.WpsAiPreserveObjects;
    if (!P || typeof writer().readDocumentStructure !== "function") return false;
    const structure = await writer().readDocumentStructure();
    // overlap 判定：对象段只要与 [start,end] 有交叠就算含对象（含部分覆盖的表格），
    // 比 containment 更安全——避免部分选中的表格漏检后落入破坏性替换。
    return (((structure && structure.segments) || [])
      .filter((s) => s.start < end && s.end > start)
      .some((s) => P.isObjectKind(s.kind)));
  }

  async function getActiveDocument() {
    const app = await doc().getApplication();
    const d = app?.ActiveDocument;
    if (!d) throw new Error("未检测到活动文档。");
    return d;
  }

  async function getApp() {
    const app = await doc().getApplication();
    if (!app) throw new Error("未检测到 WPS 文字 应用对象。");
    return app;
  }

  function collectionCount(collection) {
    if (!collection) return null;
    try {
      const n = Number(collection.Count);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      return null;
    }
  }

  function shortPath(value) {
    const raw = String(value || "");
    if (raw.length <= 180) return raw;
    return raw.slice(0, 80) + "..." + raw.slice(-80);
  }

  function debugLog(message, data) {
    try {
      console.log("[wps_insert_image]", message, data || "");
    } catch (e) {}
    try {
      fetch(DEBUG_LOG_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "wps_insert_image", message, data })
      }).catch(() => {});
    } catch (e) {}
  }

  function imageCounts(document) {
    return {
      inline: collectionCount(document?.InlineShapes),
      floating: collectionCount(document?.Shapes),
      fields: collectionCount(document?.Fields)
    };
  }

  function hasComparableCounts(before, after) {
    return (typeof before.inline === "number" && typeof after.inline === "number")
      || (typeof before.floating === "number" && typeof after.floating === "number");
  }

  function imageCountIncreased(before, after) {
    return (typeof before.inline === "number" && typeof after.inline === "number" && after.inline > before.inline)
      || (typeof before.floating === "number" && typeof after.floating === "number" && after.floating > before.floating);
  }

  function fieldCountIncreased(before, after) {
    return typeof before.fields === "number" && typeof after.fields === "number" && after.fields > before.fields;
  }

  function isJpegPath(fileName) {
    return /\.(jpe?g)(?:$|[?#])/i.test(String(fileName || ""));
  }

  function collectionItem(collection, index) {
    if (!collection || !index) return null;
    try { return collection.Item(index); } catch (e) {}
    try { return collection(index); } catch (e) {}
    return null;
  }

  function latestInsertedShape(document, before, after) {
    if (typeof before.inline === "number" && typeof after.inline === "number" && after.inline > before.inline) {
      return collectionItem(document?.InlineShapes, after.inline);
    }
    if (typeof before.floating === "number" && typeof after.floating === "number" && after.floating > before.floating) {
      return collectionItem(document?.Shapes, after.floating);
    }
    return null;
  }

  function safeRead(obj, prop) {
    try {
      const value = obj?.[prop];
      if (typeof value === "function") return null;
      return value == null ? null : value;
    } catch (e) {
      return null;
    }
  }

  function rangeInfo(range) {
    if (!range) return null;
    const info = {
      start: safeRead(range, "Start"),
      end: safeRead(range, "End")
    };
    try {
      const text = String(range.Text || "");
      info.textLength = text.length;
    } catch (e) {}
    return info;
  }

  function shapeInfo(shape) {
    if (!shape) return null;
    return {
      type: safeRead(shape, "Type"),
      name: safeRead(shape, "Name"),
      width: safeRead(shape, "Width"),
      height: safeRead(shape, "Height"),
      range: rangeInfo(safeRead(shape, "Range"))
    };
  }

  function duplicateRange(range) {
    if (!range) return null;
    try {
      const dup = typeof range.Duplicate === "function" ? range.Duplicate() : range.Duplicate;
      return dup || range;
    } catch (e) {
      return range;
    }
  }

  function collapsedSelectionRange(sel) {
    const range = duplicateRange(sel?.Range);
    if (!range) return null;
    try { range.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return range;
  }

  function documentRange(document, start, end) {
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    try {
      if (typeof document?.Range === "function") return document.Range(s, e);
    } catch (err) {}
    return null;
  }

  function hintedInsertionRange(document) {
    let hint = global.WpsAiWriterInsertionRangeHint;
    if (!hint) {
      try {
        const raw = localStorage.getItem("lingxi_writer_insertion_range_hint_v1");
        hint = raw ? JSON.parse(raw) : null;
      } catch (e) {
        hint = null;
      }
    }
    if (!hint || Date.now() - Number(hint.ts || 0) > 10 * 60 * 1000) return null;
    const range = documentRange(document, hint.start, hint.end);
    if (!range) return null;
    try { range.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return range;
  }

  function documentSelectionRange(document, sel) {
    const source = sel?.Range;
    const range = documentRange(document, safeRead(source, "Start"), safeRead(source, "End"));
    if (!range) return null;
    try { range.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return range;
  }

  function documentEndRange(document) {
    const content = duplicateRange(document?.Content);
    if (!content) return null;
    try { content.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return content;
  }

  function applyImageSize(shape, width, height) {
    if (!shape) return;
    if (typeof width === "number") {
      try { shape.Width = width; } catch (e) {}
    }
    if (typeof height === "number") {
      try { shape.Height = height; } catch (e) {}
    }
  }

  function revealInsertedShape(app, shape) {
    if (!shape) return;
    try { shape.Select(); } catch (e) {}
    try { shape.Range?.Select?.(); } catch (e) {}
    try { app?.ActiveWindow?.ScrollIntoView?.(shape.Range, true); } catch (e) {}
    try { app?.ScreenRefresh?.(); } catch (e) {}
  }

  async function shortDelay(ms = 80) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function localImagePathCandidates(fileName) {
    const raw = String(fileName || "").trim();
    const candidates = [raw];
    if (!raw || /^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return candidates;
    if (/^\/var\//.test(raw)) candidates.push(`/private${raw}`);
    if (/^\/private\/var\//.test(raw)) candidates.push(raw.replace(/^\/private/, ""));
    try {
      const resp = await fetch(LOCAL_IMAGE_INFO_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: raw })
      });
      const payload = await resp.json().catch(() => ({}));
      if (resp.ok && payload.realPath) candidates.push(payload.realPath);
      if (resp.ok && payload.safePath) candidates.push(payload.safePath);
      if (resp.ok && payload.jpegPath) candidates.push(payload.jpegPath);
    } catch (e) {
      debugLog("local-image-info-failed", { fileName: shortPath(raw), error: e?.message || String(e) });
    }
    return Array.from(new Set(candidates.filter(Boolean)));
  }

  async function writerImageCandidates(fileName) {
    const raw = String(fileName || "").trim();
    if (!raw) throw new Error("缺少图片路径 fileName。");
    if (/^https?:\/\//i.test(raw)) {
      const remote = raw;
      const candidates = [];
      try {
        const local = await imageAssets()?.ensureLocalImagePath?.(remote);
        if (local && local !== remote) candidates.push(...await localImagePathCandidates(local));
      } catch (e) {
        debugLog("remote-localize-failed", { fileName: shortPath(remote), error: e?.message || String(e) });
      }
      candidates.push(remote);
      return Array.from(new Set(candidates.filter(Boolean)));
    }
    const local = await imageAssets()?.ensureLocalImagePath?.(raw) || raw;
    return localImagePathCandidates(local);
  }

  async function prepareWordImageInsertion(app, document, sel) {
    const state = {
      interactive: safeRead(app, "Interactive"),
      protectionType: safeRead(document, "ProtectionType"),
      readOnly: safeRead(document, "ReadOnly"),
      documentName: safeRead(document, "Name"),
      selectionRange: rangeInfo(sel?.Range),
      hintedRange: rangeInfo(hintedInsertionRange(document)),
      documentSelectionRange: rangeInfo(documentSelectionRange(document, sel)),
      documentEndRange: rangeInfo(documentEndRange(document))
    };
    debugLog("app-state-before", state);
    try {
      if (app && app.Interactive === false) {
        app.Interactive = true;
        debugLog("interactive-restored", { previous: false });
      }
    } catch (e) {
      debugLog("interactive-restore-failed", { error: e?.message || String(e) });
    }
    try { if (app?.Visible === false) app.Visible = true; } catch (e) {}
    try { app?.Activate?.(); } catch (e) {}
    try { app?.ActiveWindow?.Activate?.(); } catch (e) {}
    try { document?.Activate?.(); } catch (e) {}
    try { sel?.Range?.Select?.(); } catch (e) {}
    await shortDelay(120);
    debugLog("app-state-after", {
      interactive: safeRead(app, "Interactive"),
      protectionType: safeRead(document, "ProtectionType"),
      readOnly: safeRead(document, "ReadOnly"),
      selectionRange: rangeInfo(app?.Selection?.Range || sel?.Range),
      hintedRange: rangeInfo(hintedInsertionRange(document)),
      documentSelectionRange: rangeInfo(documentSelectionRange(document, app?.Selection || sel)),
      documentEndRange: rangeInfo(documentEndRange(document))
    });
  }

  async function verifyDocumentImageCounts(document, before, strategyName, delayMs = 80) {
    await shortDelay(delayMs);
    const after = imageCounts(document);
    const inserted = imageCountIncreased(before, after);
    return { after, inserted, comparable: hasComparableCounts(before, after) };
  }

  async function probeTextWrite(document, sel) {
    const marker = `LINGXI_IMAGE_PROBE_${Date.now()}`;
    const range = hintedInsertionRange(document) || documentSelectionRange(document, sel) || collapsedSelectionRange(sel) || documentEndRange(document);
    const beforeStart = rangeInfo(range);
    try {
      if (range && "Text" in range) {
        range.Text = marker;
      } else if (typeof sel?.TypeText === "function") {
        sel.TypeText(marker);
      } else {
        return { ok: false, beforeStart, error: "无可用文本写入 API" };
      }
      await shortDelay(60);
      const content = String(document?.Content?.Text || "");
      const found = content.includes(marker);
      try {
        const cleanup = document?.Content?.Find;
        if (cleanup) {
          cleanup.Text = marker;
          cleanup.Replacement.Text = "";
          cleanup.Execute(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
        }
      } catch (e) {}
      return { ok: found, beforeStart, found };
    } catch (e) {
      return { ok: false, beforeStart, error: e?.message || String(e) };
    }
  }

  async function insertByHtmlFragment(document, app, sel, fileName, width, height) {
    const before = imageCounts(document);
    const resp = await fetch(IMAGE_HTML_FILE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fileName })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.htmlPath) {
      throw new Error(payload.error || `image-html-file ${resp.status}`);
    }
    const range = collapsedSelectionRange(sel);
    if (!range?.InsertFile) throw new Error("Range.InsertFile 不可用");
    range.InsertFile(payload.htmlPath);
    const verified = await verifyDocumentImageCounts(document, before, "range.insert-file-html", 120);
    debugLog("range-insert-file-html-result", { before, after: verified.after, inserted: verified.inserted, htmlPath: shortPath(payload.htmlPath), imagePath: shortPath(payload.imagePath) });
    if (!verified.inserted) {
      throw new Error(`InsertFile HTML 后未确认新增图片。before=${JSON.stringify(before)} after=${JSON.stringify(verified.after)}`);
    }
    const shape = latestInsertedShape(document, before, verified.after);
    applyImageSize(shape, width, height);
    revealInsertedShape(app, shape);
    return { shape, strategy: "range.insert-file-html", before, after: verified.after, attempts: [] };
  }

  async function insertByRtfPict(document, app, sel, fileName, width, height) {
    const before = imageCounts(document);
    const resp = await fetch(IMAGE_RTF_FILE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fileName })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.rtfPath) {
      throw new Error(payload.error || `image-rtf-file ${resp.status}`);
    }
    const range = collapsedSelectionRange(sel);
    if (!range?.InsertFile) throw new Error("Range.InsertFile 不可用");
    range.InsertFile(payload.rtfPath);
    const verified = await verifyDocumentImageCounts(document, before, "range.insert-file-rtf", 160);
    debugLog("range-insert-file-rtf-result", { before, after: verified.after, inserted: verified.inserted, rtfPath: shortPath(payload.rtfPath), imagePath: shortPath(payload.imagePath), kind: payload.kind });
    if (!verified.inserted) {
      throw new Error(`InsertFile RTF 后未确认新增图片。before=${JSON.stringify(before)} after=${JSON.stringify(verified.after)}`);
    }
    const shape = latestInsertedShape(document, before, verified.after);
    applyImageSize(shape, width, height);
    revealInsertedShape(app, shape);
    return { shape, strategy: "range.insert-file-rtf", before, after: verified.after, attempts: [] };
  }

  async function insertByClipboardImage(document, app, sel, fileName, width, height) {
    const before = imageCounts(document);
    const resp = await fetch(CLIPBOARD_IMAGE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fileName })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.ok) {
      throw new Error(payload.error || `clipboard/image ${resp.status}`);
    }
    const pasteRange = hintedInsertionRange(document) || documentSelectionRange(document, sel) || collapsedSelectionRange(sel) || documentEndRange(document);
    try { pasteRange?.Select?.(); } catch (e) {}
    if (typeof sel?.Paste === "function") {
      sel.Paste();
    } else if (typeof app?.Selection?.Paste === "function") {
      app.Selection.Paste();
    } else {
      throw new Error("Selection.Paste 不可用");
    }
    const verified = await verifyDocumentImageCounts(document, before, "selection.paste-image-clipboard", 180);
    debugLog("selection-paste-image-clipboard-result", { before, after: verified.after, inserted: verified.inserted, imagePath: shortPath(payload.imagePath), ext: payload.ext });
    if (!verified.inserted) {
      throw new Error(`剪贴板图片粘贴后未确认新增图片。before=${JSON.stringify(before)} after=${JSON.stringify(verified.after)}`);
    }
    const shape = latestInsertedShape(document, before, verified.after);
    applyImageSize(shape, width, height);
    revealInsertedShape(app, shape);
    return { shape, strategy: "selection.paste-image-clipboard", before, after: verified.after, attempts: [] };
  }

  function fieldCodePath(fileName) {
    return String(fileName || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function addIncludePictureField(document, range, fileName) {
    if (!document?.Fields?.Add) throw new Error("Document.Fields.Add 不可用");
    if (!range) throw new Error("Range 不可用");
    const code = `"${fieldCodePath(fileName)}"`;
    try {
      return document.Fields.Add(range, 67, code, true);
    } catch (e1) {
      try { return document.Fields.Add(range, undefined, code, true); } catch (e2) {}
      try { return document.Fields.Add(range, 67, code); } catch (e3) {}
      throw e1;
    }
  }

  async function insertByIncludePictureField(document, app, sel, fileName, width, height) {
    const before = imageCounts(document);
    const ranges = [
      ["hinted", hintedInsertionRange(document)],
      ["documentSelection", documentSelectionRange(document, sel)],
      ["selection", collapsedSelectionRange(sel)],
      ["contentEnd", documentEndRange(document)]
    ].filter((entry) => entry[1]);

    for (const [label, range] of ranges) {
      try {
        const field = addIncludePictureField(document, range, fileName);
        try { field?.Update?.(); } catch (e) {}
        try { document?.Fields?.Update?.(); } catch (e) {}
        try { app?.ScreenRefresh?.(); } catch (e) {}
        const verified = await verifyDocumentImageCounts(document, before, `field.includePicture.${label}`, 160);
        const shape = latestInsertedShape(document, before, verified.after);
        debugLog("field-include-picture-result", {
          range: label,
          before,
          after: verified.after,
          inserted: verified.inserted,
          field: {
            code: (() => { try { return String(field?.Code?.Text || "").slice(0, 220); } catch (e) { return null; } })(),
            resultRange: rangeInfo(safeRead(field, "Result"))
          }
        });
        const fieldInserted = fieldCountIncreased(before, verified.after);
        if (fieldInserted && !verified.inserted) {
          debugLog("field-include-picture-unconfirmed", {
            range: label,
            before,
            after: verified.after,
            fileName: shortPath(fileName)
          });
          try { field?.Delete?.(); } catch (e) {}
        }
        if (verified.inserted) {
          applyImageSize(shape, width, height);
          revealInsertedShape(app, shape);
          return { shape, strategy: `field.includePicture.${label}`, fileName, before, after: verified.after, attempts: [] };
        }
      } catch (e) {
        debugLog("field-include-picture-failed", { range: label, fileName: shortPath(fileName), error: e?.message || String(e) });
      }
    }

    throw new Error("INCLUDEPICTURE 域插入后未确认新增图片。");
  }

  async function insertWordImage(document, app, sel, fileNames, width, height) {
    const attempts = [];
    await prepareWordImageInsertion(app, document, sel);
    const deferredFieldCandidates = [];
    const strategies = [
      {
        name: "document.inlineShapes.fileOnly",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName);
        }
      },
      {
        name: "selection.inlineShapes.fileOnly",
        run: (targetFileName) => {
          if (!sel?.InlineShapes?.AddPicture) throw new Error("Selection.InlineShapes.AddPicture 不可用");
          return sel.InlineShapes.AddPicture(targetFileName);
        }
      },
      {
        name: "document.inlineShapes.hintedRange.mso",
        run: (targetFileName) => {
          const range = hintedInsertionRange(document);
          if (!range) throw new Error("无可用的弹窗前光标 Range");
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.inlineShapes.documentSelectionRange.mso",
        run: (targetFileName) => {
          const range = documentSelectionRange(document, sel);
          if (!range) throw new Error("Document.Range(selection) 不可用");
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.inlineShapes.originalSelectionRange.boolean",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, false, true, sel.Range);
        }
      },
      {
        name: "document.inlineShapes.originalSelectionRange.mso",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, sel.Range);
        }
      },
      {
        name: "selection.inlineShapes.boolean",
        run: (targetFileName) => {
          if (!sel?.InlineShapes?.AddPicture) throw new Error("Selection.InlineShapes.AddPicture 不可用");
          return sel.InlineShapes.AddPicture(targetFileName, false, true);
        }
      },
      {
        name: "range.inlineShapes.boolean",
        run: (targetFileName) => {
          const range = collapsedSelectionRange(sel);
          if (!range?.InlineShapes?.AddPicture) throw new Error("Range.InlineShapes.AddPicture 不可用");
          return range.InlineShapes.AddPicture(targetFileName, false, true);
        }
      },
      {
        name: "document.inlineShapes.collapsedRange.boolean",
        run: (targetFileName) => {
          const range = collapsedSelectionRange(sel);
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, false, true, range);
        }
      },
      {
        name: "document.inlineShapes.collapsedRange.mso",
        run: (targetFileName) => {
          const range = collapsedSelectionRange(sel);
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.inlineShapes.selectionRange.boolean",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, false, true, sel.Range);
        }
      },
      {
        name: "document.inlineShapes.contentEnd.mso",
        run: (targetFileName) => {
          const range = documentEndRange(document);
          if (!range) throw new Error("Document.Content Range 不可用");
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.shapes.floating.anchor.mso",
        run: (targetFileName) => {
          if (!document?.Shapes?.AddPicture) throw new Error("Document.Shapes.AddPicture 不可用");
          const range = collapsedSelectionRange(sel);
          const shape = document.Shapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, 0, 0, undefined, undefined, range);
          try {
            return shape?.ConvertToInlineShape?.() || shape;
          } catch (e) {
            return shape;
          }
        }
      },
      {
        name: "document.shapes.floating.noAnchor.mso",
        run: (targetFileName) => {
          if (!document?.Shapes?.AddPicture) throw new Error("Document.Shapes.AddPicture 不可用");
          const shape = document.Shapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, 0, 0);
          try {
            return shape?.ConvertToInlineShape?.() || shape;
          } catch (e) {
            return shape;
          }
        }
      }
    ];

    const files = Array.isArray(fileNames) ? fileNames : await localImagePathCandidates(fileNames);
    debugLog("path-candidates", { files: files.map(shortPath) });

    for (const candidate of files) {
      for (const strategy of strategies) {
        const before = imageCounts(document);
        debugLog("try", { strategy: strategy.name, before, fileName: shortPath(candidate) });
        try {
          let shape = strategy.run(candidate);
          const verified = await verifyDocumentImageCounts(document, before, strategy.name);
          if (!shape && verified.inserted) shape = latestInsertedShape(document, before, verified.after);
          const info = shapeInfo(shape);
          attempts.push({ strategy: strategy.name, fileName: candidate, before, after: verified.after, inserted: verified.inserted, shape: info });
          debugLog("result", { strategy: strategy.name, before, after: verified.after, inserted: verified.inserted, shape: info });
          if (!verified.inserted && !verified.comparable && shape) {
            debugLog("unverified-returned-shape", { strategy: strategy.name, before, after: verified.after, shape: info, fileName: shortPath(candidate) });
          }
          if (verified.inserted) {
            applyImageSize(shape, width, height);
            revealInsertedShape(app, shape);
            debugLog("success", { strategy: strategy.name, before, after: verified.after, shape: shapeInfo(shape), fileName: shortPath(candidate) });
            return { shape, strategy: strategy.name, fileName: candidate, before, after: verified.after, attempts };
          }
        } catch (e) {
          const after = imageCounts(document);
          const inserted = imageCountIncreased(before, after);
          const shape = inserted ? latestInsertedShape(document, before, after) : null;
          attempts.push({
            strategy: strategy.name,
            fileName: candidate,
            before,
            after,
            inserted,
            shape: shapeInfo(shape),
            error: e?.message || String(e)
          });
          debugLog("error", {
            strategy: strategy.name,
            before,
            after,
            inserted,
            fileName: shortPath(candidate),
            error: e?.message || String(e)
          });
          if (inserted) {
            applyImageSize(shape, width, height);
            revealInsertedShape(app, shape);
            debugLog("success-after-error", { strategy: strategy.name, before, after, shape: shapeInfo(shape), fileName: shortPath(candidate) });
            return { shape, strategy: strategy.name, fileName: candidate, before, after, attempts };
          }
        }
      }

      if (!/^https?:\/\//i.test(candidate)) {
        deferredFieldCandidates.push(candidate);
        try {
          const rtfInserted = await insertByRtfPict(document, app, sel, candidate, width, height);
          rtfInserted.attempts = attempts.concat([{ strategy: rtfInserted.strategy, fileName: candidate, before: rtfInserted.before, after: rtfInserted.after, inserted: true, shape: shapeInfo(rtfInserted.shape) }]);
          rtfInserted.fileName = candidate;
          debugLog("success", { strategy: rtfInserted.strategy, before: rtfInserted.before, after: rtfInserted.after, shape: shapeInfo(rtfInserted.shape), fileName: shortPath(candidate) });
          return rtfInserted;
        } catch (e) {
          debugLog("range-insert-file-rtf-failed", { fileName: shortPath(candidate), error: e?.message || String(e) });
        }

        try {
          const htmlInserted = await insertByHtmlFragment(document, app, sel, candidate, width, height);
          htmlInserted.attempts = attempts.concat([{ strategy: htmlInserted.strategy, fileName: candidate, before: htmlInserted.before, after: htmlInserted.after, inserted: true, shape: shapeInfo(htmlInserted.shape) }]);
          htmlInserted.fileName = candidate;
          debugLog("success", { strategy: htmlInserted.strategy, before: htmlInserted.before, after: htmlInserted.after, shape: shapeInfo(htmlInserted.shape), fileName: shortPath(candidate) });
          return htmlInserted;
        } catch (e) {
          debugLog("range-insert-file-html-failed", { fileName: shortPath(candidate), error: e?.message || String(e) });
        }

        try {
          const clipboardInserted = await insertByClipboardImage(document, app, sel, candidate, width, height);
          clipboardInserted.attempts = attempts.concat([{ strategy: clipboardInserted.strategy, fileName: candidate, before: clipboardInserted.before, after: clipboardInserted.after, inserted: true, shape: shapeInfo(clipboardInserted.shape) }]);
          clipboardInserted.fileName = candidate;
          debugLog("success", { strategy: clipboardInserted.strategy, before: clipboardInserted.before, after: clipboardInserted.after, shape: shapeInfo(clipboardInserted.shape), fileName: shortPath(candidate) });
          return clipboardInserted;
        } catch (e) {
          debugLog("selection-paste-image-clipboard-failed", { fileName: shortPath(candidate), error: e?.message || String(e) });
        }
      }
    }

    const hasJpegFieldCandidate = deferredFieldCandidates.some(isJpegPath);
    const orderedFieldCandidates = (hasJpegFieldCandidate ? deferredFieldCandidates.filter(isJpegPath) : deferredFieldCandidates)
      .slice()
      .sort((a, b) => {
        const aj = isJpegPath(a);
        const bj = isJpegPath(b);
        if (hasJpegFieldCandidate && aj !== bj) return aj ? -1 : 1;
        return 0;
      });
    debugLog("field-candidates", {
      hasJpegFieldCandidate,
      files: orderedFieldCandidates.map(shortPath),
      skippedNonJpeg: hasJpegFieldCandidate ? deferredFieldCandidates.filter((x) => !isJpegPath(x)).map(shortPath) : []
    });
    for (const candidate of orderedFieldCandidates) {
      try {
        const fieldInserted = await insertByIncludePictureField(document, app, sel, candidate, width, height);
        fieldInserted.attempts = attempts.concat([{ strategy: fieldInserted.strategy, fileName: candidate, before: fieldInserted.before, after: fieldInserted.after, inserted: true, shape: shapeInfo(fieldInserted.shape) }]);
        debugLog("success", { strategy: fieldInserted.strategy, before: fieldInserted.before, after: fieldInserted.after, shape: shapeInfo(fieldInserted.shape), fileName: shortPath(candidate) });
        return fieldInserted;
      } catch (e) {
        debugLog("field-include-picture-all-failed", { fileName: shortPath(candidate), error: e?.message || String(e) });
      }
    }

    const last = attempts[attempts.length - 1] || null;
    const textProbe = await probeTextWrite(document, sel);
    debugLog("text-write-probe", textProbe);
    debugLog("failed", { fileName: shortPath(Array.isArray(fileNames) ? fileNames[0] : fileNames), last, textProbe });
    throw new Error(`WPS 未确认图片已插入。fileName=${Array.isArray(fileNames) ? fileNames[0] : fileNames}；最后状态=${JSON.stringify(last)}；文本写入探针=${JSON.stringify(textProbe)}`);
  }

  function parseColor(input) {
    let s = String(input).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (s.length !== 6) throw new Error(`颜色格式错误：${input}`);
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    // Word Color 也是 BGR 整数（0xBBGGRR）
    return (b << 16) | (g << 8) | r;
  }

  // 修 B29：把 hex/颜色名就近映射到 WdColorIndex 枚举（高亮色只支持这 16 档）。
  function highlightIndexFromColor(input) {
    const NAMED = {
      yellow: 7, 黄: 7, 黄色: 7, green: 11, 绿: 11, 绿色: 11, brightgreen: 4,
      cyan: 3, turquoise: 3, 青: 3, pink: 5, magenta: 5, 粉: 5, 粉色: 5,
      blue: 2, 蓝: 2, 蓝色: 2, red: 6, 红: 6, 红色: 6, darkblue: 9, teal: 10,
      violet: 12, 紫: 12, darkred: 13, darkyellow: 14, gray: 15, grey: 15,
      灰: 15, lightgray: 16, lightgrey: 16, black: 1, 黑: 1, white: 8, 白: 8
    };
    const key = String(input).trim().toLowerCase();
    if (NAMED[key] != null) return NAMED[key];
    // hex → 就近选枚举代表色
    let s = key.replace(/^#/, "").replace(/^0x/, "");
    if (s.length === 3) s = s.split("").map((c) => c + c).join("");
    if (s.length !== 6 || /[^0-9a-f]/.test(s)) return 7; // 解析不了默认黄色高亮
    const r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16);
    const PALETTE = [
      [1, 0, 0, 0], [2, 0, 0, 255], [3, 0, 255, 255], [4, 0, 255, 0],
      [5, 255, 0, 255], [6, 255, 0, 0], [7, 255, 255, 0], [8, 255, 255, 255],
      [9, 0, 0, 128], [10, 0, 128, 128], [11, 0, 128, 0], [12, 128, 0, 128],
      [13, 128, 0, 0], [14, 128, 128, 0], [15, 128, 128, 128], [16, 192, 192, 192]
    ];
    let best = 7, bestD = Infinity;
    for (const [idx, pr, pg, pb] of PALETTE) {
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bestD) { bestD = d; best = idx; }
    }
    return best;
  }

  // wd 内置样式 ID（WdBuiltinStyle 枚举）
  const STYLE_IDS = {
    "Normal": -1, "正文": -1,
    "Heading 1": -2, "标题 1": -2, "标题1": -2,
    "Heading 2": -3, "标题 2": -3, "标题2": -3,
    "Heading 3": -4, "标题 3": -4, "标题3": -4,
    "Heading 4": -5, "Heading 5": -6, "Heading 6": -7,
    "Title": -63, "标题": -63,
    "Subtitle": -75, "副标题": -75,
    "Quote": -85, "引用": -85,
    // 修 B26：wdStyleListBullet = -49、wdStyleListNumber = -50。
    // 旧值 -19(wdStyleIndex9) / -29(wdStyleNormalIndent) 是完全不相干的样式，
    // 会让"改成项目符号列表"套上错误样式且没有项目符号。
    "List Bullet": -49, "项目符号": -49,
    "List Number": -50, "编号列表": -50
  };

  // ---- 文档统计 / 大纲 / 选择 ----

  registry.registerTool({
    name: "wps_get_doc_stats",
    hosts: ["wps"],
    description: "获取当前文档统计信息：总字符数、汉字数、段落数、页数。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      const stats = {};
      // 修 B25：WdStatistic 枚举是 0 起的：0=Words, 1=Lines, 2=Pages, 3=Characters,
      // 4=Paragraphs, 5=CharactersWithSpaces, 6=FarEastCharacters(汉字数)。
      // 旧代码用 1-6 整体错位一位，导致 pages 返回字符数等全错。
      const safe = (n) => {
        try { return document.ComputeStatistics(n); } catch (e) { return null; }
      };
      stats.words = safe(0);
      stats.lines = safe(1);
      stats.pages = safe(2);
      stats.characters = safe(3);
      stats.paragraphs = safe(4);
      stats.charactersWithSpaces = safe(5);
      stats.farEastCharacters = safe(6); // 汉字数
      try { stats.name = document.Name; } catch (e) { stats.name = null; }
      try { stats.saved = !!document.Saved; } catch (e) {}
      return stats;
    }
  });

  registry.registerTool({
    name: "wps_get_outline",
    hosts: ["wps"],
    description: "提取文档大纲（标题样式段落的层级和文本）。每项含 level（1-9）、text、index。minLevel/maxLevel 限定层级区间；includeRange=true 附带每节 range{start,end}（配合 wps_read_document 的 paragraphRange/fromHeadingIndex 按节读）；limit 限条数。",
    parameters: {
      type: "object",
      properties: {
        minLevel: { type: "integer", minimum: 1, maximum: 9, description: "从第几级标题开始，默认 1" },
        maxLevel: { type: "integer", minimum: 1, maximum: 9, default: 3, description: "提取到第几级标题为止，默认 3" },
        includeRange: { type: "boolean", description: "为每个标题附带 range{start,end}，配合 wps_read_document 按节读" },
        limit: { type: "integer", minimum: 1, description: "最多返回标题条数" }
      }
    },
    handler: async ({ minLevel = 1, maxLevel = 3, includeRange = false, limit } = {}) => {
      const document = await getActiveDocument();
      const paragraphs = document.Paragraphs;
      const count = paragraphs?.Count || 0;
      const cap = limit && limit > 0 ? Math.floor(limit) : Infinity;
      const out = [];
      let truncated = false;
      for (let i = 1; i <= count; i += 1) {
        const p = paragraphs.Item(i);
        let styleName = "";
        try {
          const style = p.Style;
          styleName = typeof style === "string" ? style : (style?.NameLocal || style?.Name || "");
        } catch (e) { styleName = ""; }
        const m = /^(?:Heading|标题)\s*(\d)/i.exec(styleName);
        if (m) {
          const level = parseInt(m[1], 10);
          if (level >= minLevel && level <= maxLevel) {
            if (out.length >= cap) { truncated = true; break; }
            let text = "";
            try { text = String(p.Range.Text || "").replace(/[\r\n]+$/g, ""); } catch (e) {}
            const item = { level, text, index: i };
            if (includeRange) {
              try { item.range = { start: p.Range.Start, end: p.Range.End }; } catch (e) { item.range = null; }
            }
            out.push(item);
          }
        }
      }
      return { count: out.length, truncated, headings: out };
    }
  });

  registry.registerTool({
    name: "wps_select_all",
    hosts: ["wps"],
    description: "选中整篇文档（等同 Ctrl+A）。后续 wps_replace_selection 可以替换全文。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      sel.WholeStory();
      return { ok: true };
    }
  });

  registry.registerTool({
    name: "wps_replace_document",
    hosts: ["wps"],
    description: "替换整个文档内容（先全选再替换）。用结构化 blocks；不要传 markdown。慎用：覆盖现有所有文字。AI 排版场景走排版预览弹窗。",
    parameters: {
      type: "object",
      properties: { blocks: BLOCK_SCHEMA, text: { type: "string", description: "纯文本替换" } }
    },
    handler: async ({ blocks, text } = {}) => {
      // 有可写内容 -> 先检测对象（无论 blocks 还是 text），含对象走保留路径（对象不删）。
      const payloadBlocks = Array.isArray(blocks) && blocks.length
        ? blocks
        : (typeof text === "string" && text.length ? [{ type: "paragraph", text }] : null);
      if (payloadBlocks && typeof writer().replaceTextPreservingObjects === "function") {
        let hasObjects = false;
        try {
          hasObjects = await documentHasObjects();
        } catch (e) {
          // 无法确定是否含对象（读结构失败）-> 中止，绝不退回破坏性全文删除（spec §5）
          throw new Error("检测文档是否含对象失败，已中止以避免删除对象：" + (e?.message || e));
        }
        if (hasObjects) {
          const res = await writer().replaceTextPreservingObjects(payloadBlocks, {});
          return { replaced: res.replaced, preserved: res.objectsPreserved, skipped: res.skipped, mode: "preserve-objects" };
        }
      }
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      sel.WholeStory();
      const payload = Array.isArray(blocks) ? blocks : text;
      await writer().replaceSelectionText(payload, {});
      const n = Array.isArray(blocks) ? blocks.length : (text ? 1 : 0);
      return { replaced: n, mode: Array.isArray(blocks) ? "blocks" : "text" };
    }
  });

  registry.registerTool({
    name: "wps_select_paragraph",
    hosts: ["wps"],
    description: "把选区移到指定序号的段落上（用于 wps_get_outline 返回的 index 跳转）。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1, description: "段落序号（从 1 开始）" }
      }
    },
    handler: async ({ index } = {}) => {
      const document = await getActiveDocument();
      const p = document.Paragraphs.Item(index);
      if (!p) throw new Error(`段落 ${index} 不存在`);
      p.Range.Select();
      return { selected: index };
    }
  });

  // ---- 段落样式 / 字符格式 ----

  registry.registerTool({
    name: "wps_apply_paragraph_style",
    hosts: ["wps"],
    description: "为当前选区应用段落样式。常用：Heading 1 / Heading 2 / Heading 3 / Normal / Title / Quote / List Bullet / List Number。",
    parameters: {
      type: "object",
      required: ["style"],
      properties: {
        style: { type: "string", description: "样式名（中英文都支持）" }
      }
    },
    handler: async ({ style } = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const styleId = STYLE_IDS[style];
      try {
        if (styleId != null) {
          sel.Style = styleId;
        } else {
          sel.Style = style;
        }
      } catch (e) {
        throw new Error(`应用样式失败：${e.message || e}`);
      }
      return { style };
    }
  });

  registry.registerTool({
    name: "wps_format_selection",
    hosts: ["wps"],
    description: "对当前选区应用字符格式（粗/斜/下划线/字体/字号/颜色）。所有参数可选，只设置传入的项。",
    parameters: {
      type: "object",
      properties: {
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        underline: { type: "boolean", description: "true=单下划线" },
        fontName: { type: "string", description: "字体名，如 \"宋体\"、\"Microsoft YaHei\"" },
        fontSize: { type: "number", description: "字号（磅）" },
        color: { type: "string", description: "字体颜色 #RRGGBB" },
        highlight: { type: "string", description: "荧光笔色 #RRGGBB（部分 WPS 版本支持）" }
      }
    },
    handler: async (opts = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const font = sel.Font;
      if (!font) throw new Error("未获取到 Font 对象。");
      const applied = {};
      if (typeof opts.bold === "boolean") { font.Bold = opts.bold ? 1 : 0; applied.bold = opts.bold; }
      if (typeof opts.italic === "boolean") { font.Italic = opts.italic ? 1 : 0; applied.italic = opts.italic; }
      if (typeof opts.underline === "boolean") {
        // wdUnderlineNone=0, wdUnderlineSingle=1
        font.Underline = opts.underline ? 1 : 0;
        applied.underline = opts.underline;
      }
      if (opts.fontName) { font.Name = opts.fontName; applied.fontName = opts.fontName; }
      if (typeof opts.fontSize === "number") { font.Size = opts.fontSize; applied.fontSize = opts.fontSize; }
      if (opts.color) { font.Color = parseColor(opts.color); applied.color = opts.color; }
      if (opts.highlight) {
        // 修 B29：HighlightColorIndex 接受的是 WdColorIndex 枚举（0-17），不是 RGB/BGR 整数。
        // 把 hex/颜色名就近映射到枚举，否则 COM 要么拒绝（静默无效果）要么套出随机颜色。
        try { sel.Range.HighlightColorIndex = highlightIndexFromColor(opts.highlight); applied.highlight = opts.highlight; }
        catch (e) { /* 部分版本不支持 */ }
      }
      return { applied };
    }
  });

  // ---- 插入元素 ----

  registry.registerTool({
    name: "wps_insert_page_break",
    hosts: ["wps"],
    description: "在当前光标位置插入分页符。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      // wdPageBreak = 7
      sel.InsertBreak(7);
      return { ok: true };
    }
  });

  registry.registerTool({
    name: "wps_insert_table",
    hosts: ["wps"],
    description: "在当前光标位置插入表格。可选 data 是二维数组用于初始填充。",
    parameters: {
      type: "object",
      required: ["rows", "cols"],
      properties: {
        rows: { type: "integer", minimum: 1 },
        cols: { type: "integer", minimum: 1 },
        data: {
          type: "array",
          description: "二维数组，外层为行内层为列；单元格按 String() 写入。可省略。",
          items: { type: "array", items: { type: "string" } }
        }
      }
    },
    handler: async ({ rows, cols, data } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const table = document.Tables.Add(sel.Range, rows, cols);
      if (Array.isArray(data)) {
        for (let r = 0; r < Math.min(rows, data.length); r += 1) {
          const row = data[r];
          if (!Array.isArray(row)) continue;
          for (let c = 0; c < Math.min(cols, row.length); c += 1) {
            try {
              const cell = table.Cell(r + 1, c + 1);
              cell.Range.Text = String(row[c] ?? "");
            } catch (e) { /* skip */ }
          }
        }
      }
      return { rows, cols, filled: !!data };
    }
  });

  registry.registerTool({
    name: "wps_insert_hyperlink",
    hosts: ["wps"],
    description: "在当前光标位置插入超链接。textToDisplay 留空时显示 URL 本身。",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        textToDisplay: { type: "string" },
        screenTip: { type: "string", description: "鼠标悬停提示" }
      }
    },
    handler: async ({ url, textToDisplay, screenTip } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Hyperlinks.Add(sel.Range, url, undefined, screenTip, textToDisplay || url);
      return { url, textToDisplay: textToDisplay || url };
    }
  });

  registry.registerTool({
    name: "wps_insert_image",
    hosts: ["wps"],
    description: "在当前光标位置插入图片。fileName 可以是 HTTP URL、dataUrl 或本地路径；HTTP 会先按 WPS 原生方式插入，失败再本地化兜底。需要配图时可先调 query_materials（按 tags/project/关键词）复用素材库里已有的图，命中就把其 url 传进来。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        fileName: { type: "string", description: "图片 URL 或本地路径" },
        width: { type: "number", description: "宽度（磅，1磅=1/72英寸）；省略使用原图" },
        height: { type: "number", description: "高度（磅）；省略使用原图" }
      }
    },
    handler: async ({ fileName, width, height } = {}) => {
      if (!fileName) throw new Error("缺少图片路径 fileName。");
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const candidateFiles = await writerImageCandidates(fileName);
      debugLog("start", {
        sourceFileName: shortPath(fileName),
        candidateFiles: candidateFiles.map(shortPath),
        counts: imageCounts(document),
        selectionRange: rangeInfo(sel.Range)
      });
      const inserted = await insertWordImage(document, app, sel, candidateFiles, width, height);
      return {
        inserted: true,
        fileName: inserted.fileName || candidateFiles[0],
        sourceFileName: fileName,
        strategy: inserted.strategy,
        before: inserted.before,
        after: inserted.after,
        shape: shapeInfo(inserted.shape)
      };
    }
  });

  registry.registerTool({
    name: "wps_insert_toc",
    hosts: ["wps"],
    description: "在当前光标位置插入目录（基于文档中的标题样式）。",
    parameters: {
      type: "object",
      properties: {
        upperHeadingLevel: { type: "integer", default: 1 },
        lowerHeadingLevel: { type: "integer", default: 3 },
        useHyperlinks: { type: "boolean", default: true }
      }
    },
    handler: async ({ upperHeadingLevel = 1, lowerHeadingLevel = 3, useHyperlinks = true } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      // TablesOfContents.Add(Range, UseHeadingStyles, UpperHeadingLevel, LowerHeadingLevel,
      //   UseFields, TableID, RightAlignPageNumbers, IncludePageNumbers, AddedStyles, UseHyperlinks)
      document.TablesOfContents.Add(
        sel.Range, true, upperHeadingLevel, lowerHeadingLevel,
        false, undefined, true, true, undefined, useHyperlinks
      );
      return { upperHeadingLevel, lowerHeadingLevel };
    }
  });

  registry.registerTool({
    name: "wps_save",
    hosts: ["wps"],
    description: "保存当前文档（使用现有路径）。新文档需先在 WPS 里另存为再调用此工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      try {
        document.Save();
        return { saved: true, name: document.Name };
      } catch (e) {
        throw new Error(`保存失败（可能是新文档没有路径）：${e.message || e}`);
      }
    }
  });

  // ---- 批注 / 书签 ----

  registry.registerTool({
    name: "wps_add_comment",
    hosts: ["wps"],
    description: "对当前选区添加批注。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "批注内容" }
      }
    },
    handler: async ({ text } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Comments.Add(sel.Range, text);
      return { added: true };
    }
  });

  registry.registerTool({
    name: "wps_list_bookmarks",
    hosts: ["wps"],
    description: "列出文档中的所有书签。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      const bms = document.Bookmarks;
      const count = bms?.Count || 0;
      const names = [];
      for (let i = 1; i <= count; i += 1) {
        try { names.push(bms.Item(i).Name); } catch (e) {}
      }
      return { count, bookmarks: names };
    }
  });

  registry.registerTool({
    name: "wps_add_bookmark",
    hosts: ["wps"],
    description: "在当前选区或光标位置添加命名书签。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "书签名（不能含空格和特殊字符）" }
      }
    },
    handler: async ({ name } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Bookmarks.Add(name, sel.Range);
      return { added: name };
    }
  });

  // ============ 表格工具（对齐 et_* 系列，改表不动正文） ============

  // 单元格文本读取：Range.Text 末尾会有 \r\a（\a=BEL=0x07，单元格结束）+ \r，剥掉
  function cleanCellText(raw) {
    return String(raw || "").replace(/[\r\n\v]+$/g, "");
  }
  function tableAt(document, index) {
    const tables = document?.Tables;
    if (!tables) throw new Error("当前文档没有 Tables 集合。");
    const total = Number(tables.Count) || 0;
    if (total === 0) throw new Error("当前文档没有表格。");
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 1 || idx > total) {
      throw new Error(`tableIndex 越界：${index}（当前 ${total} 个表格）`);
    }
    let t;
    try { t = tables.Item(idx); } catch (e) { throw new Error(`获取第 ${idx} 个表格失败：${e?.message || e}`); }
    if (!t) throw new Error(`第 ${idx} 个表格不存在`);
    return t;
  }

  registry.registerTool({
    name: "wps_list_tables",
    hosts: ["wps"],
    description: "枚举当前文档里的所有表格：tableIndex（从 1 开始）+ rows / cols + 首格文本预览，供后续 wps_write_table_range / wps_add_table_row 使用。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      const tables = document.Tables;
      const count = Number(tables?.Count) || 0;
      const list = [];
      for (let i = 1; i <= count; i += 1) {
        let rows = 0, cols = 0, preview = "";
        try {
          const t = tables.Item(i);
          rows = Number(t.Rows?.Count) || 0;
          cols = Number(t.Columns?.Count) || 0;
          try { preview = cleanCellText(t.Cell(1, 1)?.Range?.Text).slice(0, 40); } catch (e) {}
        } catch (e) {}
        list.push({ tableIndex: i, rows, cols, firstCellPreview: preview });
      }
      return { count, tables: list };
    }
  });

  registry.registerTool({
    name: "wps_read_table",
    hosts: ["wps"],
    description: "读取指定表格的完整内容，返回 values 二维数组（行 × 列，单元格纯文本），rows / cols 元信息，方便 AI 基于现有内容改。",
    parameters: {
      type: "object",
      required: ["tableIndex"],
      properties: {
        tableIndex: { type: "integer", minimum: 1, description: "表格序号，从 1 开始；先用 wps_list_tables 查" },
        maxRows: { type: "integer", minimum: 1, description: "最多读多少行，避免大表爆 context（默认 200）" },
        maxCols: { type: "integer", minimum: 1, description: "最多读多少列（默认 30）" }
      }
    },
    handler: async ({ tableIndex, maxRows = 200, maxCols = 30 } = {}) => {
      const document = await getActiveDocument();
      const t = tableAt(document, tableIndex);
      const rows = Math.min(Number(t.Rows?.Count) || 0, Number(maxRows) || 200);
      const cols = Math.min(Number(t.Columns?.Count) || 0, Number(maxCols) || 30);
      const values = [];
      for (let r = 1; r <= rows; r += 1) {
        const row = [];
        for (let c = 1; c <= cols; c += 1) {
          let text = "";
          try { text = cleanCellText(t.Cell(r, c)?.Range?.Text); } catch (e) {}
          row.push(text);
        }
        values.push(row);
      }
      return { tableIndex, rows, cols, values, truncated: rows < (Number(t.Rows?.Count) || 0) || cols < (Number(t.Columns?.Count) || 0) };
    }
  });

  registry.registerTool({
    name: "wps_write_table_range",
    hosts: ["wps"],
    description: "向指定表格从 (startRow, startCol) 开始写入二维数据（对齐 et_write_range 语义）。values 长度决定写入范围；行列不够会追加。startRow / startCol 从 1 开始。",
    parameters: {
      type: "object",
      required: ["tableIndex", "values"],
      properties: {
        tableIndex: { type: "integer", minimum: 1, description: "表格序号，从 1 开始；先用 wps_list_tables 查" },
        startRow: { type: "integer", minimum: 1, default: 1, description: "起始行，默认 1" },
        startCol: { type: "integer", minimum: 1, default: 1, description: "起始列，默认 1" },
        values: {
          type: "array",
          description: "二维数据，外层为行内层为列。单元格按 String() 写入。",
          items: { type: "array", items: {} }
        }
      }
    },
    handler: async ({ tableIndex, startRow = 1, startCol = 1, values } = {}) => {
      if (!Array.isArray(values) || values.length === 0) throw new Error("values 必须是非空二维数组");
      const document = await getActiveDocument();
      const t = tableAt(document, tableIndex);
      const rowCount = Number(t.Rows?.Count) || 0;
      const colCount = Number(t.Columns?.Count) || 0;
      const needRows = startRow + values.length - 1;
      let colsMax = 0;
      for (const r of values) { if (!Array.isArray(r)) throw new Error("values 内层必须是数组"); if (r.length > colsMax) colsMax = r.length; }
      const needCols = startCol + colsMax - 1;
      // 行不够就 Add
      while ((Number(t.Rows?.Count) || 0) < needRows) {
        try { t.Rows.Add(); } catch (e) { throw new Error(`扩行失败（${e?.message || e}）`); }
      }
      // 列不够就 Add（Columns.Add 追加在末尾）
      while ((Number(t.Columns?.Count) || 0) < needCols) {
        try { t.Columns.Add(); } catch (e) { throw new Error(`扩列失败（${e?.message || e}）`); }
      }
      let written = 0, failed = 0;
      for (let i = 0; i < values.length; i += 1) {
        const row = values[i];
        for (let j = 0; j < row.length; j += 1) {
          try {
            const cell = t.Cell(startRow + i, startCol + j);
            cell.Range.Text = String(row[j] ?? "");
            written += 1;
          } catch (e) {
            failed += 1;
          }
        }
      }
      return {
        tableIndex,
        writtenCells: written,
        failedCells: failed,
        finalRows: Number(t.Rows?.Count) || 0,
        finalCols: Number(t.Columns?.Count) || 0,
        prevRows: rowCount,
        prevCols: colCount
      };
    }
  });

  registry.registerTool({
    name: "wps_add_table_row",
    hosts: ["wps"],
    description: "给指定表格添加一行。默认追加到末尾；beforeRow 指定序号则插入到该行之前。",
    parameters: {
      type: "object",
      required: ["tableIndex"],
      properties: {
        tableIndex: { type: "integer", minimum: 1 },
        beforeRow: { type: "integer", minimum: 1, description: "插入到该行之前（1-based）；省略追加到末尾" },
        values: {
          type: "array",
          description: "可选：新行的初始文本（每列一个字符串）",
          items: { type: "string" }
        }
      }
    },
    handler: async ({ tableIndex, beforeRow, values } = {}) => {
      const document = await getActiveDocument();
      const t = tableAt(document, tableIndex);
      let newRow, at;
      if (beforeRow) {
        const target = t.Rows.Item(Number(beforeRow));
        if (!target) throw new Error(`beforeRow=${beforeRow} 越界`);
        newRow = t.Rows.Add(target);
        at = Number(beforeRow);
      } else {
        newRow = t.Rows.Add();
        at = Number(t.Rows?.Count) || 0;
      }
      if (Array.isArray(values) && values.length) {
        const cols = Number(t.Columns?.Count) || 0;
        for (let j = 0; j < Math.min(values.length, cols); j += 1) {
          try { t.Cell(at, j + 1).Range.Text = String(values[j] ?? ""); } catch (e) {}
        }
      }
      return { tableIndex, insertedAt: at, totalRows: Number(t.Rows?.Count) || 0 };
    }
  });

  registry.registerTool({
    name: "wps_delete_table_row",
    hosts: ["wps"],
    description: "删除指定表格的某一行。",
    parameters: {
      type: "object",
      required: ["tableIndex", "rowIndex"],
      properties: {
        tableIndex: { type: "integer", minimum: 1 },
        rowIndex: { type: "integer", minimum: 1, description: "1-based" }
      }
    },
    handler: async ({ tableIndex, rowIndex } = {}) => {
      const document = await getActiveDocument();
      const t = tableAt(document, tableIndex);
      const r = t.Rows.Item(Number(rowIndex));
      if (!r) throw new Error(`rowIndex=${rowIndex} 越界`);
      r.Delete();
      return { tableIndex, deletedRow: Number(rowIndex), remainingRows: Number(t.Rows?.Count) || 0 };
    }
  });

  registry.registerTool({
    name: "wps_goto_bookmark",
    hosts: ["wps"],
    description: "跳转到指定书签的位置。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" }
      }
    },
    handler: async ({ name } = {}) => {
      const document = await getActiveDocument();
      const bm = document.Bookmarks.Item(name);
      if (!bm) throw new Error(`书签不存在：${name}`);
      bm.Select();
      return { gone: name };
    }
  });
})(window);
