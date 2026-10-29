(function attachQuickActions(global) {
  "use strict";

  // 三个宿主的快捷指令定义。每条带：
  //   key       — 唯一稳定标识，ribbon 上点击时通过它反查 prompt
  //   label     — 显示文字
  //   category  — 分组标识，用于 ribbon 菜单分组渲染（写作/润色/翻译/...）
  //   prefill   — true 表示需要用户在 [占位] 处补内容，taskpane 收到后会预填输入框，不自动发送
  //   prompt    — 实际指令
  const QUICK_ACTIONS = {
    wps: [
      { key: "helpWrite", label: "帮我写", category: "writing", prefill: true,
        prompt: "请帮我写一段关于 [在这里描述主题，比如：项目复盘的 300 字总结] 的内容。先用 wps_insert_text 插入到当前光标位置（用 markdown 自然成段，会渲染成 Word 原生格式）。" },
      { key: "continue", label: "续写", category: "writing", prefill: true, optionalInput: true,
        prompt: "请用 wps_read_document 读取整篇文档了解上下文，然后基于结尾内容续写 1-2 段，承接已有语气，用 wps_insert_text 插入到当前光标位置。" },
      { key: "expand", label: "扩写", category: "writing", flow: "selectionTone",
        instruction: "把选区扩写得更详细、更丰满：补充事例、原因、影响等支撑细节，保持原意与关键事实不变。",
        prompt: "读取当前选区，打开扩写预览弹窗，确认后替换选区。" },
      { key: "shrink", label: "缩写", category: "writing", flow: "selectionTone",
        instruction: "把选区压缩到原来的一半左右，保留核心信息与关键事实，删除冗余修饰与重复表达。",
        prompt: "读取当前选区，打开缩写预览弹窗，确认后替换选区。" },
      { key: "rewrite", label: "重写", category: "writing", flow: "selectionTone",
        instruction: "从不同角度或不同句式重写选区，保持原意与关键事实，避免与原文逐字相同。",
        prompt: "读取当前选区，打开重写预览弹窗，确认后替换选区。" },

      { key: "polish", label: "快速润色", category: "polish", flow: "selectionTone",
        instruction: "润色选区让表达更流畅、更专业、更书面，保持原意与关键事实不变。",
        prompt: "读取当前选区，打开润色预览弹窗，确认后替换选区。" },
      { key: "optimize", label: "优化", category: "polish", flow: "selectionOptimize",
        prompt: "读取当前选区，打开优化预览弹窗，确认后替换选区。" },
      // 五个语气改写按钮统一走选区预览弹窗：先生成 → HTML 形式对比原文/结果 → 一键高亮差异 → 确认替换
      { key: "polishFormal", label: "更正式", category: "polish", flow: "selectionTone",
        instruction: "改写成更正式的书面语风格：去除口语词，调整句式，使用规范书面表达，但保持原意。",
        prompt: "读取当前选区，打开改写预览弹窗，按「更正式」风格改写后确认替换。" },
      { key: "polishAcademic", label: "更学术", category: "polish", flow: "selectionTone",
        instruction: "改写成学术论文风格：严谨、客观、使用专业术语和被动句，避免主观表达，保持原意。",
        prompt: "读取当前选区，打开改写预览弹窗，按「更学术」风格改写后确认替换。" },
      { key: "polishGov", label: "党政风", category: "polish", flow: "selectionTone",
        instruction: "改写成党政公文风格：规范用词、政策语言、四字格表达，结构严谨，逻辑清晰，保持原意。",
        prompt: "读取当前选区，打开改写预览弹窗，按「党政风」风格改写后确认替换。" },
      { key: "polishLively", label: "更活泼", category: "polish", flow: "selectionTone",
        instruction: "改写得更活泼生动：多用比喻、设问、贴近读者的口吻，节奏明快但保持原意。",
        prompt: "读取当前选区，打开改写预览弹窗，按「更活泼」风格改写后确认替换。" },
      { key: "polishCasual", label: "口语化", category: "polish", flow: "selectionTone",
        instruction: "改写成自然口语化表达：像日常聊天一样，去除书面化措辞，但保持原意与关键信息。",
        prompt: "读取当前选区，打开改写预览弹窗，按「口语化」风格改写后确认替换。" },
      { key: "polishAll", label: "全文润色", category: "polish", flow: "documentRewrite",
        instruction: "对整篇文档做整体润色：保持结构、章节顺序、关键事实和数据不变，让语言更通顺、更专业；统一术语；删除冗余；不要新增段落或观点。",
        prompt: "读取整篇文档，打开全文润色预览弹窗，确认后替换全文。" },

      { key: "translate", label: "翻译选中", category: "translate", flow: "selectionTranslate",
        prompt: "读取当前选区，打开翻译预览弹窗，确认后替换选区。" },

      { key: "summary", label: "全文总结", category: "document", flow: "documentReport", reportKind: "summary",
        instruction: "给一份结构化的中文摘要：一级标题写文档主旨；要点列表覆盖各章节核心；最后一段写「核心结论」总括关键判断。保持中性表述，不展开论证。",
        prompt: "读取整篇文档，打开全文总结预览弹窗，可复制或插入到光标位置。" },
      { key: "mindmap", label: "文档脑图", category: "document", flow: "documentReport", reportKind: "mindmap",
        instruction: "提炼成 markdown 大纲形式的脑图：一级标题用 `# `，二级用 `## `，三级用 `### `，要点用 `- `。只保留层级骨架，每条不超过 20 字。",
        prompt: "读取整篇文档，打开文档脑图预览弹窗，可复制或插入到光标位置。" },
      { key: "format", label: "AI 排版", category: "document", flow: "formatPreview",
        prompt: "读取全文并打开富文本排版预览，确认后替换全文。" },
      { key: "proofread", label: "批注校对", category: "document", flow: "proofread",
        prompt: "对全文做批注式校对：错别字/语病/标点/逻辑问题直接以 Word 批注标在原文位置。" },
      { key: "compliance", label: "合规检查", category: "document", flow: "compliance",
        prompt: "按检查清单核查全文，命中问题以 Word 批注标注并按高/中/低分级。" },
      { key: "qa", label: "文档问答", category: "document", prefill: true,
        prompt: "请基于当前文档内容回答这个问题：[在这里写你想问的问题]" },

      { key: "image", label: "AI 生成图片", category: "image", prefill: true,
        prompt: "请生成一张关于 [描述要生成的图片内容，比如：科技感的报告封面，深蓝色背景] 的图片，先调用 generate_image 拿到 URL，再用 wps_insert_image 插入到当前光标位置。" },
      { key: "materialLibrary", label: "素材库", category: "image", modal: "materialLibrary",
        prompt: "打开生图素材库。" },

      { key: "suggest", label: "智能推荐操作", category: "smart",
        prompt: "请先用 wps_read_document 读一下整篇文档（如果太长就读前 2000 字），分析它的内容类型、风格、语气、潜在问题。基于这些观察调用 suggest_quick_actions 工具给我 5-8 条针对这篇文档具体可执行的操作建议。每条 label 不超过 12 个字，prompt 要明确指定调用什么工具完成什么。完成 suggest_quick_actions 后简单说一句你看到了什么。" }
    ],

    et: [
      { key: "autofit", label: "自动调整行列宽", category: "beautify",
        prompt: "请先用 et_get_sheet_info 取到活动工作表的 UsedRange，然后调用 et_autofit 对该区域执行 dimension=both 的自适应。完成后简短告诉我处理了哪个区域。" },
      { key: "beautify", label: "表格美化样式", category: "beautify",
        prompt: "请对当前活动工作表的 UsedRange 执行表格美化：1) 用 et_autofit 自适应行列宽；2) 用 et_set_borders 给整块区域加 outline 外框（thin），再加 inside 内框（hairline）；3) 用 et_format_range 把第一行设置为加粗、白字、深蓝色背景 #2C5BAA、水平居中、垂直居中；4) 用 et_set_alignment 把数据区设置成水平居中 + 垂直居中 + 自动换行。完成后用一句话总结。" },
      { key: "centerAll", label: "全部居中对齐", category: "beautify",
        prompt: "请用 et_get_sheet_info 取到活动工作表的 UsedRange，然后调用 et_set_alignment 把整个 UsedRange 设为 h=center, v=center, wrap=true。完成后用一句话告诉我。" },
      { key: "createTable", label: "套用表格样式", category: "beautify",
        prompt: "请把当前数据区转成智能表（自带筛选 + 隔行底纹）：先用 et_get_sheet_info 找到含表头的 UsedRange，再用 et_create_table（styleName 选一个如 TableStyleMedium2）。完成后告诉我表名和范围。" },
      { key: "freezeHeader", label: "冻结首行", category: "beautify",
        prompt: "请冻结首行表头方便滚动查看：用 et_freeze_panes(splitRow=1, splitColumn=0)。如需同时冻结首列告诉我。完成后确认一句。" },

      { key: "explainFormula", label: "解释公式", category: "data",
        prompt: "请用 et_get_selection 拿到当前选区的第一个单元格，用 et_read_cell 读取它的 Formula 和 Value。如果是公式，用简单中文解释：这个公式做了什么、每个函数/引用的作用、可能的边界情况；如果不是公式而是常量，说明它可能来自哪个引用。不要改单元格。" },
      { key: "explainRange", label: "解释数据", category: "data",
        prompt: "请用 et_get_sheet_info 找到 UsedRange，然后 et_read_range 读取前 30 行数据（大表就采样）。基于列名和数据分布告诉我：这张表是什么内容？每列是什么含义？有没有明显异常（缺失/重复/格式不一致）？不要改数据。" },
      { key: "deleteBlank", label: "删除空白行", category: "data",
        prompt: "请先用 et_get_sheet_info 找到 UsedRange，再用 et_read_range 读取 UsedRange 的全部数据。识别所有完全为空的行（每个单元格都是空字符串或 null），然后调用 et_delete_rows 按从下往上的顺序删除它们。删除完成后告诉我删了哪些行。" },
      { key: "mergeSame", label: "合并相同相邻单元格", category: "data",
        prompt: "请用 et_get_sheet_info 找到当前选区（如果没有选区就用 UsedRange 的第一列），然后用 et_read_range 读取该列数据。识别相邻、内容相同的单元格段，按段调用 et_merge_cells 合并。完成后告诉我合并了哪些段。" },
      { key: "genFormula", label: "生成公式", category: "data", prefill: true,
        prompt: "我想在 [目标区域，如 D2:D100] 计算 [用中文描述计算逻辑，如：单价列 × 数量列]。请先用 et_get_sheet_info 看维度/表头和当前选区，再用 et_set_formula 把合适的公式写入目标区域（相对引用会自动逐行填充，公式不用带前导 =）。完成后一句话说明公式含义。" },
      { key: "dedupe", label: "数据去重", category: "data",
        prompt: "请先用 et_get_sheet_info 找到含表头的 UsedRange，再用 et_remove_duplicates 去除重复行（columns 省略=按所有列判重；若只按某几列去重，先告诉我列名我再指定）。完成后告诉我删了多少行。" },
      { key: "splitColumns", label: "文本分列", category: "data",
        prompt: "请把当前选中的单列按分隔符拆成多列：先用 et_get_sheet_info 确认选区，再用 et_text_to_columns（delimiter 选 comma/space/tab/semicolon，其它字符用 other + otherChar）执行。完成后说明分成了几列。" },
      { key: "subtotal", label: "分类汇总", category: "data",
        prompt: "请对当前数据做分类汇总：先用 et_read_range 读 UsedRange 了解列，确定 [分组列] 和 [要汇总的列]。因为 et_subtotal 要求先按分组列排好序，请先用 et_sort_range 按分组列排序，再用 et_subtotal（func=sum/count/average）汇总。完成后简述结果。" },

      { key: "insertChart", label: "AI 生成图表", category: "chart", prefill: true,
        prompt: "请基于数据生成图表：先用 et_get_sheet_info 拿到当前选区/UsedRange（含表头）作为 dataRange，判断合适的图表类型（趋势→line、占比→pie、对比→column），再用 et_insert_chart 插入并给个标题。完成后说明用了什么图、数据范围是什么。" },
      { key: "conditionalFormat", label: "条件格式高亮", category: "chart",
        prompt: "请给当前选区加条件格式突出重点：先用 et_get_sheet_info 确认选区，再用 et_add_conditional_format——数值分布用 color_scale 色阶或 data_bar 数据条；找极值/异常用 top10/bottom10 或 above_average/below_average。完成后说明用了哪种规则。" },
      { key: "sparkline", label: "迷你图", category: "chart",
        prompt: "请为每行数据生成趋势迷你图：先用 et_get_sheet_info 找到数据区与放置列（通常在数据右侧空列），再用 et_add_sparkline（type=line 折线，location=放迷你图的列如 F2:F10，dataRange=对应每行的数据）。完成后说明放在哪列。" },

      { key: "image", label: "AI 生成图片", category: "image", prefill: true,
        prompt: "请生成一张关于 [描述要生成的图片内容，比如：数据主题的装饰插图、报表封面] 的图片：先调用 generate_image 拿到图片 URL，再用 et_insert_image 插入——它默认放到当前选中单元格的左上角。完成后告诉我插到哪里了。" },
      { key: "materialLibrary", label: "素材库", category: "image", modal: "materialLibrary",
        prompt: "打开生图素材库。" },

      { key: "suggest", label: "智能推荐操作", category: "smart",
        prompt: "请先用 et_get_sheet_info 看一下活动工作表的维度，再用 et_read_range 读取 UsedRange 前 20 行（如果数据少于 20 行就全部）。基于看到的数据特征（列名、值类型、是否有空行、是否有数字等），调用 suggest_quick_actions 工具给我 5-8 条针对这个表的具体可执行操作建议。每条 label 不超过 12 个字，prompt 是一句完整指令，用到的工具名要明确写出来。完成 suggest_quick_actions 后简单说一句你看到了什么。" }
    ],

    wpp: [
      { key: "genPpt", label: "AI 生成 PPT", category: "generate", prefill: true,
        prompt: "请帮我生成一份关于 [描述主题，如：2026 年第一季度复盘报告，10 页，包含封面/摘要/数据/结论] 的 PPT。流程：先用 wpp_get_presentation_info 看现状；如果是空文档/我要求重做，就为每一页调 wpp_add_slide（合理选择 layout=title/text/sectionHeader/comparison），并通过 title 和 body 字段填入内容；末尾用 wpp_set_notes 给每页加演讲者备注。完成后告诉我每页大概内容。" },
      { key: "fromOutline", label: "大纲生成 PPT", category: "generate", modal: "outline",
        prompt: "（大纲生成 PPT 走专门的弹窗输入大纲；如果你看到这个 prompt，说明 modal 没正常打开。）" },
      { key: "cover", label: "AI 生成封面", category: "generate", prefill: true,
        prompt: "请帮我做一张吸引眼球的封面：主标题 [写主标题，比如：项目 Alpha 启动会]，副标题/作者 [写副标题或留空]。先用 wpp_add_slide(afterIndex=0, layout='title') 在最前面插入一页，再调 wpp_set_title 填主标题，必要时 wpp_add_text_box 加副标题/日期。" },
      { key: "genOne", label: "AI 生成单页", category: "generate", prefill: true,
        prompt: "请在当前位置之后插入一张新幻灯片，主题是 [描述这一页的内容，比如：第二季度销售额同比增长 23%，给出关键数据和原因]。流程：wpp_add_slide(layout='text', title=..., body=...)，根据需要再 wpp_add_text_box 补充。" },
      { key: "genMany", label: "AI 生成多页", category: "generate", prefill: true,
        prompt: "请围绕主题 [描述主题] 生成 [3-5] 页幻灯片，结构层次清晰（如：概述 → 数据 → 案例 → 结论）。每一页用 wpp_add_slide(title, body) 插入，最后告诉我各页大致内容。" },
      { key: "image", label: "AI 生成图片", category: "generate", prefill: true,
        prompt: "请生成一张关于 [描述图片，如：未来感的科技城市夜景，蓝紫色调] 的图片，并插入到当前幻灯片：先调 generate_image 拿到 URL，再用 wpp_add_picture(fileName=URL, left=80, top=120, width=560) 放到合适位置。" },
      { key: "materialLibrary", label: "素材库", category: "generate", modal: "materialLibrary",
        prompt: "打开生图素材库。" },

      { key: "helpWrite", label: "帮我写", category: "rewrite", prefill: true,
        prompt: "请围绕 [描述主题] 帮我写一段适合放在 PPT 上的内容。如果要替换某个形状的文字，先 wpp_read_slide 找到目标形状的 index，再 wpp_replace_shape_text 写入；如果是新内容，用 wpp_add_text_box 在当前页加一个文本框。" },
      { key: "helpEdit", label: "帮我改", category: "rewrite",
        prompt: "请用 wpp_read_slide 读当前幻灯片所有形状文本，识别需要改进的地方（措辞、错别字、语气、结构），然后逐个用 wpp_replace_shape_text 改写。改完简短说一下改了什么。" },
      { key: "expand", label: "扩写", category: "rewrite", prefill: true,
        prompt: "请扩写当前幻灯片中第 [形状序号] 个形状的文字（先用 wpp_read_slide 看一下序号），把要点扩写为完整段落，再用 wpp_replace_shape_text 写回。" },
      { key: "shrink", label: "缩写", category: "rewrite", prefill: true,
        prompt: "请缩写当前幻灯片中第 [形状序号] 个形状的文字，压缩到原来一半左右、保留核心要点，用 wpp_replace_shape_text 写回。" },
      { key: "polish", label: "润色", category: "rewrite",
        prompt: "请用 wpp_read_slide 读当前幻灯片所有有文字的形状，逐个润色（保持原意，更通顺、更专业），用 wpp_replace_shape_text 写回。完成后总结一下改动。" },

      { key: "explainSlide", label: "解释这页", category: "rewrite",
        prompt: "请用 wpp_read_slide 读当前幻灯片的全部文字，用一段自然中文解释这一页在讲什么、面向什么听众、核心结论是什么。不要改文档。" },
      { key: "simplifyPage", label: "简化这页", category: "rewrite",
        prompt: "请用 wpp_read_slide 看当前幻灯片，识别文字过多的形状，用 wpp_replace_shape_text 把每个长段落压缩成 3-5 个要点，保留核心信息，去掉冗余。完成后简短说改了哪些形状。" },
      { key: "onePageNotes", label: "这页演讲稿", category: "rewrite",
        prompt: "请用 wpp_read_slide 读当前幻灯片，为其生成 30-60 秒口语化的演讲稿，用 wpp_set_notes 写入到当前页备注。完成后告诉我大意。" },
      { key: "proofread", label: "AI 检查校对", category: "check",
        prompt: "请用 wpp_list_slides 看整份演示文稿，再 wpp_read_slide 逐页读文字，找出错别字、用词不当、语法错误、不一致之处。直接列出问题清单（按页码 + 形状序号 + 建议改法），不要直接改文档；改不改由我来决定。" },
      { key: "speakerNotes", label: "AI 演讲稿", category: "check",
        prompt: "请用 wpp_list_slides 看整份演示文稿，再逐页 wpp_read_slide 看每页内容，为每一页生成 1-3 句口语化的演讲稿，用 wpp_set_notes 写入到该页备注。完成后告诉我已为多少页加了备注。" },

      { key: "suggest", label: "智能推荐操作", category: "smart",
        prompt: "请先用 wpp_get_presentation_info 和 wpp_list_slides 了解当前演示文稿（页数、各页标题/版式/字数），然后调用 suggest_quick_actions 工具给我 5-8 条针对这份 PPT 具体可执行的操作建议（比如：缺封面的话提醒生成封面；某些页文字太多建议拆分；缺备注的话建议生成演讲稿等等）。每条 label ≤12 字，prompt 写明要调用哪些工具。" }
    ],

    pdf: [
      // PDF 走「双通道」（app.js preparePdfContext）：数字版由 proxy /pdf-extract 抽带页码文本
      // 喂给任意模型（便宜、可分块、页码准）；扫描件/无文字层自动回退整文件多模态附件。
      // COM 的 pdf_read_document 在整合阅读模式抓不到字，仅留作回退，标准流程不依赖。
      { key: "parallelTranslate", label: "对照翻译", category: "translate", modal: "parallelTranslate" },
      { key: "summary", label: "全文总结", category: "document", attachActivePdf: true,
        prompt: "请基于当前 PDF 内容作答。请输出结构化 markdown 摘要：\n\n## 一句话概括\n（≤30 字）\n\n## 核心要点\n5-8 条，每条结尾标注页码 [P3]\n\n## 关键结论 / 数据\n\n## 我可以基于此追问的 3 个问题\n\n基于 PDF 实际内容写，不要泛泛而谈。" },
      { key: "qa", label: "PDF 问答", category: "document", prefill: true, attachActivePdf: true,
        prompt: "请基于当前 PDF 内容作答。请基于 PDF 内容回答：[在这里写你的问题]\n\n回答时引用相关页码（如 [P3]）。PDF 里没有的明确说『PDF 中未提及』，不要编造。" },
      { key: "suggest", label: "智能推荐操作", category: "smart", attachActivePdf: true,
        prompt: "请基于当前 PDF 内容作答。判断这是什么类型的 PDF（合同 / 论文 / 报告 / 教材 / 说明书 / 其他），然后调用 suggest_quick_actions 给我 5-8 条针对性建议。每条 label ≤12 字，prompt 写完整指令；最后用一句话告诉我你看到了什么。" }
    ]
  };

  // 分组在 ribbon 菜单里展示的中文标题；顺序也决定了菜单内分组的顺序
  const CATEGORY_LABELS = {
    writing: "写作",
    polish: "润色",
    translate: "翻译",
    document: "文档",
    image: "图像",
    generate: "生成",
    rewrite: "改写",
    check: "校对",
    beautify: "美化",
    data: "数据",
    chart: "图表",
    smart: "智能",
    other: "其他"
  };

  // 每个 category 在 ribbon 上使用的图标（黑白线性 SVG）
  const CATEGORY_ICON = {
    writing: "images/icons/writing.svg",
    polish: "images/icons/polish.svg",
    translate: "images/icons/translate.svg",
    document: "images/icons/document.svg",
    image: "images/icons/image.svg",
    generate: "images/icons/slides.svg",
    rewrite: "images/icons/edit.svg",
    check: "images/icons/check.svg",
    beautify: "images/icons/brush.svg",
    data: "images/icons/table.svg",
    chart: "images/icons/table.svg",
    smart: "images/icons/wand.svg",
    other: "images/ai.png"
  };

  const CATEGORY_ORDER_BY_HOST = {
    wps: ["writing", "polish", "translate", "document", "image", "smart"],
    et:  ["beautify", "data", "chart", "image", "smart"],
    wpp: ["generate", "rewrite", "check", "smart"],
    pdf: ["translate", "document", "smart"]
  };

  function findByKey(host, key) {
    const list = QUICK_ACTIONS[host] || [];
    return list.find((a) => a.key === key) || null;
  }

  /**
   * 把宿主下的所有 chip 按 category 分组返回（保留 prefill 标记，
   * ribbon 点击 prefill 类时 taskpane 会预填输入框而不是自动发送）。
   * 返回：[{ category, label, actions: [{key,label,prefill}] }, ...]
   */
  function getRibbonGroups(host) {
    const list = QUICK_ACTIONS[host] || [];
    const order = CATEGORY_ORDER_BY_HOST[host] || ["other"];
    const buckets = new Map(order.map((cat) => [cat, []]));
    list.forEach((act) => {
      const cat = act.category && buckets.has(act.category) ? act.category : "other";
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(act);
    });
    const groups = [];
    buckets.forEach((actions, cat) => {
      if (!actions || actions.length === 0) return;
      groups.push({
        category: cat,
        label: CATEGORY_LABELS[cat] || cat,
        actions: actions.map((a) => ({ key: a.key, label: a.label, prefill: !!a.prefill, flow: a.flow || "" }))
      });
    });
    return groups;
  }

  global.WpsAiQuickActions = {
    QUICK_ACTIONS,
    CATEGORY_LABELS,
    CATEGORY_ICON,
    CATEGORY_ORDER_BY_HOST,
    findByKey,
    getRibbonGroups
  };
})(window);
