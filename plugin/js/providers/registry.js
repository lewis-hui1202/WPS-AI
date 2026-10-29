(function attachProviderRegistry(global) {
  "use strict";

  const SETTINGS_KEY = "wps_ai_provider_settings_v1";

  // 灵犀 PPT 设计宪法（每次配版前自检）——提炼自 frontend-slides SKILL.md 的反 AI slop 准则。
  // 同时由 wpp_get_style_preset（工具返回值）和 app.js（拼入 system prompt）两处消费。
  const DESIGN_GUIDELINES = Object.freeze([
    "一页一意：每页只表达一个核心观点，宁可拆页也不堆。",
    "留白优先：装饰元素 ≤ 文本元素；目标 ≥ 30% 空白。",
    "强调色克制：accentColor 全页 ≤ 1 处。除章节页外，禁止整页用 accent 当背景。",
    "字体白名单：仅用色板里指定的 titleFont/bodyFont；禁止额外引入第三种字体。",
    "视觉权重分层：封面/章节页/巨型数字这类 hero moment 用 wpp_apply_visual_template（带渐变光斑/巨型水印）；普通内容页用 wpp_apply_template 即可；杂乱内容拆成几页用同一个版式串起来。",
    "反 AI slop：禁止滥用紫色渐变、emoji 满屏、系统默认字体、模板水印；几何抽象 > 卡通插画 > 真人贴图。",
    "动画克制：一页一次主入场 > 散乱微交互；wpp_set_slide_transition 用 fade/push 即可，不用花哨效果。",
    "数据可视化：图表配色直接用色板 primary+accent，最多 3 色；走 wpp_render_chart 而非塞外部贴图。",
    "章节标志：每个 chapter 首页用统一的 v-section-modern 或 section-fullbleed，让读者一眼识别结构。",
    "固定舞台：所有版式按当前 SlideWidth × SlideHeight 满铺设计，不假设 16:9，不为小屏重排。",
    "防重叠：同一页禁止混用 wpp_apply_template / wpp_apply_visual_template / wpp_render_html_template 与 wpp_add_text_box / wpp_set_title / wpp_set_notes 之外的文本类工具——模板内部已经摆好所有标题与正文，再加文本框会产生重叠。需要补内容时用 wpp_replace_shape_text 改模板里的现有文本框，而不是新加。",
    "防重复：调 wpp_add_slide / wpp_apply_template 前先 wpp_list_slides 看当前页数；想改第 N 页一定显式传 slide=N；省略 slide 一律按「追加新页」处理，禁止用它「改最后一页」。重复添加同一页是最常见 bug。"
  ]);

  // 默认的系统提示词 —— 优化回答风格 / 去 AI 味 / 避免堆砌 emoji 与套话
  // 用户在设置里可改。runChatTurn 会把它跟动态部分（宿主、风格预设等）拼一起。
  const DEFAULT_SYSTEM_PROMPT = [
    "【回答风格】",
    "- 始终用简体中文回复（用户明确要求翻译成其他语言、或用其他语言撰写内容时，正文可用目标语言）。",
    "- 简洁直接，不要重复用户的请求，不要用「好的」「了解了」「明白了」开场。",
    "- 不加「希望对你有帮助」「有其他问题随时告诉我」这类客套结尾。",
    "- 总结类任务直接给内容，不要「总结：」「以下是要点：」这种前缀。",
    "",
    "【格式克制】",
    "- 不使用 emoji（✅ 🎉 🚀 ⚠️ 等都不要），需要标记状态用纯文本「已完成」「失败」。",
    "- 用 Markdown 只在内容确实有结构时：代码块、表格、确实并列的列表。普通陈述用纯文本段落。",
    "- 不要把所有内容都包装成 bullet list；连续的叙述就一段话写下去。",
    "- 标题（# / ## / ###）只在长文档分章节时用，常规回答不加。",
    "",
    "【避免 AI 套话】",
    "- 不要写「作为一个 AI 助手……」。",
    "- 不要主动加免责声明、「建议咨询专业人士」等。",
    "- 不要无端使用「很抱歉」「非常高兴」这类情绪词。",
    "",
    "【操作文档时】",
    "- 能用工具直接改文档就直接调工具，不要先描述「我打算怎么改」再让用户确认。",
    "- 不确定文档当前状态时，先用读类工具看一眼（wps_read_document / wpp_list_slides / et_read_range 等）。",
    "- 工具调用结束后用一两句话说改了什么，不要逐步复述每个调用过程。",
    "",
    "【处理失败】",
    "- 工具失败时说清楚为什么、下一步怎么办；不重复同一种失败调用。",
    "- 完成不了的任务直接说不行，不绕弯子瞎编。"
  ].join("\n");

  // 已知供应商预设：用户在「聊天模型配置」里点「+ 新增」时弹出此列表，
  // 选一项即自动填好 type / baseUrl / 默认模型 / 代理。
  // 用户后续只需要填 API Key（codex 走 OAuth 没 baseUrl）。
  const KNOWN_CHAT_PROVIDERS = Object.freeze([
    Object.freeze({ id: "codex-oauth", type: "codex",
      label: "Codex (ChatGPT OAuth)", baseUrl: "", defaultModel: "gpt-5.1-codex" }),
    Object.freeze({ id: "anthropic", type: "anthropic",
      label: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-6", anthropicVersion: "2023-06-01" }),
    Object.freeze({ id: "openai-official", type: "openai",
      label: "OpenAI 官方", baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini" }),
    Object.freeze({ id: "openai-responses", type: "openai-responses",
      label: "OpenAI Responses API", baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.1" }),
    Object.freeze({ id: "gemini", type: "gemini",
      label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-2.5-flash" }),
    Object.freeze({ id: "azure", type: "azure",
      label: "Azure OpenAI", baseUrl: "", defaultModel: "", apiVersion: "2024-10-21" }),
    Object.freeze({ id: "deepseek", type: "openai",
      label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat" }),
    Object.freeze({ id: "moonshot", type: "openai",
      label: "Kimi / Moonshot", baseUrl: "https://api.moonshot.cn/v1",
      defaultModel: "moonshot-v1-8k" }),
    Object.freeze({ id: "qwen", type: "openai",
      label: "通义千问 (DashScope)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen-plus" }),
    Object.freeze({ id: "zhipu", type: "openai",
      label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-4-plus" }),
    Object.freeze({ id: "doubao", type: "openai",
      label: "豆包 / 火山引擎", baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      defaultModel: "doubao-pro-32k" }),
    Object.freeze({ id: "siliconflow", type: "openai",
      label: "硅基流动 SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1",
      defaultModel: "deepseek-ai/DeepSeek-V3" }),
    Object.freeze({ id: "openrouter", type: "openai",
      label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-3.5-sonnet" }),
    Object.freeze({ id: "ollama", type: "openai",
      label: "本地 Ollama", baseUrl: "http://localhost:11434/v1",
      defaultModel: "qwen2.5:7b" }),
    Object.freeze({ id: "custom", type: "openai",
      label: "自定义 OpenAI 兼容端点", baseUrl: "", defaultModel: "" })
  ]);

  // 默认 chatProviders：保留 codex/anthropic/openai 三条历史条目（兼容老数据迁移），
  // 用户在 UI 里可以新增、删除、启用 openai 类的多家。codex 由于 OAuth 限制单实例，
  // anthropic 也只保留一条；openai 类可以叠加多份（DeepSeek + Kimi + 通义...同时挂）。
  const DEFAULT_CHAT_PROVIDERS = Object.freeze([
    Object.freeze({
      id: "codex", type: "codex", label: "Codex (ChatGPT OAuth)",
      enabled: false, defaultModel: "gpt-5.1-codex"
    }),
    Object.freeze({
      id: "anthropic", type: "anthropic", label: "Anthropic Claude",
      enabled: false, baseUrl: "https://api.anthropic.com/v1", apiKey: "",
      defaultModel: "claude-sonnet-4-6", anthropicVersion: "2023-06-01", useProxy: true
    }),
    Object.freeze({
      id: "openai-official", type: "openai", label: "OpenAI 官方",
      enabled: false, baseUrl: "https://api.openai.com/v1", apiKey: "",
      defaultModel: "gpt-4o-mini", useProxy: true
    })
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    // 老字段 activeProvider / providers.* 仍然保留以兼容历史导入文件，但新版用
    // chatProviders + activeChatModel 这一对：
    //   chatProviders: 用户配置的所有聊天供应商（含 codex/anthropic/多家 openai 兼容）
    //   activeChatModel: 当前选中的「<providerId>::<modelId>」组合，header 下拉直接读它
    activeProvider: "codex",
    chatProviders: DEFAULT_CHAT_PROVIDERS.map((p) => Object.assign({}, p)),
    activeChatModel: "",
    operationMode: "direct",
    // 外部 MCP 服务连接（作为 MCP Client）。每项：
    //   {id, name, type:"stdio"|"sse", enabled, trusted, command?, args?, env?, url?, headers?}
    // stdio 子进程 / SSE 远程连接都由 proxy-server 侧的 mcp-client-manager 持有，plugin 只经 HTTP 调。
    mcpClients: [],
    // 启用的 Office 组件（写入 publish.xml 的宿主）。默认四个全开；用户可在设置里勾选，
    // 保存后由 proxy 重写 publish.xml，重启 WPS 生效。
    enabledHosts: ["wps", "et", "wpp", "pdf"],
    // 一次对话允许的工具调用循环上限，超过会强制中止（防失控）。
    // 复杂任务（生成 10 页 PPT 之类）通常需要 30-60 次迭代。
    maxToolIterations: 150,
    // HTML 模板插入 PPT 时是否分图层（文字层 + 背景层独立 PNG）。
    // 默认 true：让用户能用 WPS 原生工具选中文本框继续微调；之前实验阶段默认 false
    // 等于把功能藏起来了，对正常用户没意义。
    splitLayersOnInsert: true,
    // 修订模式（仅 WPS 文字）：开后 AI 改动走 Word 原生修订，作者标为「文小舟」，可逐条接受/回撤
    reviseMode: false,
    // 用户可配置的系统提示词（追加到每轮 chat 的 system message 里）
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // 界面语言（i18n）：auto | zh | en。真正的读取入口在 WpsAiI18n（localStorage 早期可用），
    // 这里再存一份是持久化兜底——设置 JSON 是全插件最可靠的持久化通道（SQLite 受管 + 导出导入）。
    uiLanguage: "auto",
    // AI 操作跟随提示：修改型工具成功后 Word 滚动跟随 / Excel 选中改动区域（follow-highlight.js）
    aiFollowHighlight: true,
    // 当前项目名：已改为「AI 每对话总结一次」（见 WpsAiProject），不再手填；保留字段仅为兼容
    currentProject: "",
    // 生图比例手动覆盖：非空时所有 generate_image 强制用它（忽略 AI 自选）；空 = 自动（原逻辑）
    imageSizeOverride: "",
    // 老字段 providers 保留只用于读旧导出文件，新代码读 chatProviders
    providers: Object.freeze({
      codex: Object.freeze({
        type: "codex",
        label: "Codex (ChatGPT OAuth)",
        defaultModel: "gpt-5.1-codex"
      }),
      openai: Object.freeze({
        type: "openai",
        label: "OpenAI 兼容",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        defaultModel: "gpt-4o-mini",
        useProxy: true
      }),
      anthropic: Object.freeze({
        type: "anthropic",
        label: "Anthropic Claude",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "",
        defaultModel: "claude-sonnet-4-6",
        useProxy: true,
        anthropicVersion: "2023-06-01"
      })
    }),
    // 图像生成多渠道配置（类比 chatProviders）：
    //   imageProviders[]: 所有已配置渠道，每条独立 enabled
    //   约束：同一时刻只允许一条 enabled=true（UI 层互斥；getImageConfig 取首个 enabled）
    //   渠道协议：
    //     type = "toapis"       → toapis.com / GPT-Image-2 异步任务（创建+轮询）
    //     type = "codex-bridge" → sub2api 等 OpenAI 兼容同步图像 API
    //     type = "openai"       → OpenAI 官方 /images/generations（gpt-image-1 / dall-e-3）
    //     type = "openrouter"   → OpenRouter：无 images 端点，走 chat/completions +
    //                             modalities:["image","text"]（Gemini 图像模型等），
    //                             图片以 dataURL 形式回在 message.images[]
    imageProviders: [
      {
        id: "toapis", type: "toapis", label: "toapis.com (GPT-Image-2)",
        enabled: false,
        baseUrl: "https://toapis.com/v1", apiKey: "",
        model: "gpt-image-2",
        defaultSize: "1:1", defaultResolution: "1K",
        useProxy: true
      },
      {
        id: "codex-bridge", type: "codex-bridge", label: "Codex 桥接 (sub2api)",
        enabled: false,
        baseUrl: "",
        apiKey: "",
        model: "gpt-image-2",
        defaultSize: "1024x1024",
        useProxy: true
      },
      {
        id: "openai", type: "openai", label: "OpenAI 官方",
        enabled: false,
        baseUrl: "https://api.openai.com/v1", apiKey: "",
        model: "gpt-image-1",
        defaultSize: "1024x1024",
        useProxy: true
      },
      {
        id: "openrouter", type: "openrouter", label: "OpenRouter",
        enabled: false,
        baseUrl: "https://openrouter.ai/api/v1", apiKey: "",
        model: "google/gemini-2.5-flash-image",
        useProxy: true
      },
      {
        id: "boogu", type: "boogu", label: "Boogu 本地生图",
        enabled: false,
        baseUrl: "http://127.0.0.1:8000/v1", apiKey: "",
        model: "",
        defaultSize: "1:1",
        resolution: 1024, // 默认分辨率档位（长边）
        steps: 4,
        useProxy: true
      }
    ],
    // PPT 风格预设：用户在 ribbon「PPT 风格」对话框里设置后，AI 生成幻灯片时统一套用
    stylePreset: Object.freeze({
      enabled: false,
      // 字体
      titleFont: "Microsoft YaHei",
      titleSize: 32,
      titleBold: true,
      bodyFont: "Microsoft YaHei",
      bodySize: 18,
      // 色板（核心：让 AI 用这套颜色统一设计幻灯片）
      titleColor: "#1f2329",      // 标题字色
      bodyColor: "#33363c",       // 正文字色
      primaryColor: "#1f3a5f",    // 主色（标题块/装饰条/章节页背景）
      secondaryColor: "#3d5a80",  // 次色（主色暗版/边框）
      accentColor: "#ee6c4d",     // 强调色（点缀/高亮）
      backgroundColor: "#ffffff", // 幻灯片底色
      surfaceColor: "#f5f7fa",    // 卡片/区块底色
      // 主题模板（可选，本地路径）
      themeFile: "",
      // 当前色板方案标识（"custom" 表示用户自定义；其他值见 COLOR_SCHEMES）
      scheme: "custom"
    }),
    // 12 套主题预设——每个都带设计理念。颜色都经过对比度核对，避免炫光/相冲。
    // signatureElement / layoutHints 提炼自 frontend-slides 的 STYLE_PRESETS.md，
    // 给 AI 提供该色板「长什么样、用哪些工具去搭」的可执行提示。
    COLOR_SCHEMES: Object.freeze({
      "bold-signal": Object.freeze({
        label: "Bold Signal", description: "自信、高冲击力 · Pitch Deck/主题演讲",
        design: "黑白极简对比 + 一抹深橙作 hero。大量留白，标题占满视线。灵感：Pitch.com YC 模板 / Apple keynote。",
        signatureElement: "巨型鲜橙色块作单一视觉焦点 + 超大章节编号 + 严苛网格布局；大量留白让标题占满视线。",
        layoutHints: "封面/章节优先 wpp_apply_visual_template:v-section-modern（巨型透明编号水印）；普通页 wpp_apply_template:content-sidebar 加 accent 装饰条；accent 全页只点 1 处。",
        darkMode: false,
        primaryColor: "#1A1A1A", secondaryColor: "#525252", accentColor: "#FF5722",
        backgroundColor: "#FAFAFA", surfaceColor: "#F4F4F5",
        titleColor: "#1A1A1A", bodyColor: "#404040",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "electric-studio": Object.freeze({
        label: "Electric Studio", description: "干净、专业 · 品牌/代理商演示",
        design: "信任蓝 + 暖橙作对比，cool grey 中性面。灵感：R/GA / Pentagram 工作室作品集。",
        signatureElement: "左右双面板竖直分屏 + 一根强调色装饰条 + 引言式大标题作 hero。",
        layoutHints: "封面用 wpp_apply_template:cover-split；内容页 content-sidebar 配 primaryColor 装饰条；对比页用 two-column；accent 橙只点 1 处不全染。",
        darkMode: false,
        primaryColor: "#2563EB", secondaryColor: "#1E3A8A", accentColor: "#F97316",
        backgroundColor: "#FFFFFF", surfaceColor: "#F1F5F9",
        titleColor: "#0F172A", bodyColor: "#475569",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "creative-voltage": Object.freeze({
        label: "Creative Voltage", description: "复古活力 · 创意提案",
        design: "70s 海报色——砖红 + 深蓝 + 芥末黄，做羊皮纸底。灵感：Eames、Massimo Vignelli。",
        signatureElement: "高饱和电蓝 + 霓虹黄对撞 + 可选半调点状/网格纹理底；几何抽象图形而非插画。",
        layoutHints: "章节 section-fullbleed 满主色；数据页 stat-hero 让数字成主角；内容页 content-sidebar 走粗体短句，禁止贴卡通图。",
        darkMode: false,
        primaryColor: "#C2410C", secondaryColor: "#1E40AF", accentColor: "#EAB308",
        backgroundColor: "#FAF3E7", surfaceColor: "#FCE7C5",
        titleColor: "#1C1917", bodyColor: "#57534E",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "dark-botanical": Object.freeze({
        label: "Dark Botanical", description: "优雅、精致 · 高端品牌",
        design: "森林深绿 + 古铜金 + 暖奶油字。深色克制，金色点缀，奢华低调。灵感：Hermès / RH catalog。",
        signatureElement: "深底 + 抽象软渐变光斑作背景 + 细长竖线作分割 + 古铜金细线/小符号点缀。",
        layoutHints: "封面/章节强烈推荐 wpp_apply_visual_template:v-cover-gradient（带模糊光斑）；正文页留白比文字多；accent 金色全页只用 1-2 处装饰线。",
        darkMode: true,
        primaryColor: "#2D4A38", secondaryColor: "#4A6B53", accentColor: "#B8916D",
        backgroundColor: "#0F1A14", surfaceColor: "#1F2D24",
        titleColor: "#EFE8D7", bodyColor: "#A9B3A4",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "notebook-tabs": Object.freeze({
        label: "Notebook Tabs", description: "编辑感、条理清晰 · 报告/评测",
        design: "米黄笔记纸底 + 蓝/红/赭石三色像分类标签。每章一个色调暗示。灵感：Field Notes / Moleskine。",
        signatureElement: "米黄笔记纸底 + 右侧彩色分类标签条（每章不同色）+ 装订孔小圆点装饰。",
        layoutHints: "章节页 section-fullbleed 每章换 primary/secondary/accent 三色之一；内容页 content-sidebar 模拟标签纸；数据多用 surface 米色卡片框。",
        darkMode: false,
        primaryColor: "#1E40AF", secondaryColor: "#B91C1C", accentColor: "#B45309",
        backgroundColor: "#FAFAF2", surfaceColor: "#F5F0DC",
        titleColor: "#1C1917", bodyColor: "#44403C",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "pastel-geometry": Object.freeze({
        label: "Pastel Geometry", description: "友好、亲切 · 产品介绍",
        design: "柔和粉彩三色（薰衣草 + 桃 + 薄荷）配几何感装饰，warm white 底。灵感：Stripe Atlas / Memphis Group。",
        signatureElement: "暖白底 + 大圆角卡片 + 右侧不等高粉彩竖条（药丸状）+ 几何装饰圈/线。",
        layoutHints: "内容页 content-sidebar 配圆角矩形（wpp_add_shape:roundedRect）；数据页 stat-hero；硬边角禁用，所有色块都圆角；accent 薄荷只做高亮。",
        darkMode: false,
        primaryColor: "#8B7CF6", secondaryColor: "#FBA774", accentColor: "#5EEAD4",
        backgroundColor: "#FFFCF7", surfaceColor: "#F3EEFF",
        titleColor: "#312E81", bodyColor: "#4F4870",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "split-pastel": Object.freeze({
        label: "Split Pastel", description: "活泼、现代 · 创意机构",
        design: "粉/青双色等权重分屏，黄色作点缀。Spotify Wrapped 美学。灵感：Wrapped / 现代杂志。",
        signatureElement: "粉/青双色等权重竖分屏 + 黄色徽章药丸 + 半透明网格点缀。",
        layoutHints: "封面/章节优先 cover-split（左 primary 粉 / 右 secondary 青）；内容页 surface badge 作章节标签；accent 黄全页只点 1 处。",
        darkMode: false,
        primaryColor: "#EC4899", secondaryColor: "#06B6D4", accentColor: "#FACC15",
        backgroundColor: "#FFFFFF", surfaceColor: "#FFE4ED",
        titleColor: "#831843", bodyColor: "#4A2A4A",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "vintage-editorial": Object.freeze({
        label: "Vintage Editorial", description: "个性、有腔调 · 个人品牌",
        design: "杂志色调——牛血红 + 烟草棕 + 旧纸黄，宋体衬线。Wes Anderson 调色 + 老 Vogue。",
        signatureElement: "宋体衬线大字号 + 抽象圆环/横线/圆点点缀 + 旧 Vogue 杂志窄栏排版。",
        layoutHints: "内容页 content-sidebar 走窄栏目；引言 quote-block 充分发挥宋体气场；标题加宽字间距；禁止任何卡通插画。",
        darkMode: false,
        primaryColor: "#5C2A2A", secondaryColor: "#8B6F47", accentColor: "#C8553D",
        backgroundColor: "#F0E8D6", surfaceColor: "#E0D4BC",
        titleColor: "#1C0D02", bodyColor: "#3A2E1F",
        titleFont: "宋体", bodyFont: "宋体"
      }),
      "neon-cyber": Object.freeze({
        label: "Neon Cyber", description: "未来感、科技感 · 科技初创",
        design: "深空蓝底 + 电光紫到青的克制霓虹（不是三种霓虹乱炸）。灵感：Apple Vision Pro launch。",
        signatureElement: "深空蓝底 + 紫青双色霓虹辉光 + 粒子/网格细线底纹 + 巨型透明数字水印。",
        layoutHints: "封面/章节优先 v-cover-gradient 或 v-section-modern；数据强爆用 v-stat-bigtype；霓虹色只做点缀辉光不全染；禁止用紫色渐变满铺（AI slop）。",
        darkMode: true,
        primaryColor: "#6366F1", secondaryColor: "#8B5CF6", accentColor: "#22D3EE",
        backgroundColor: "#0A0E1A", surfaceColor: "#131829",
        titleColor: "#F8FAFC", bodyColor: "#94A3B8",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "terminal-green": Object.freeze({
        label: "Terminal Green", description: "开发者极客风 · Dev 工具/API 介绍",
        design: "GitHub Dark + 现代终端绿（不是辣眼的纯绿），等宽 Consolas。Amber 警告 / 红色错误对应代码 IDE 语义。",
        signatureElement: "GitHub Dark + 终端绿 + 等宽字体；可加扫描线/光标方块装饰；语义化色彩（绿=ok 黄=警告 红=错误）。",
        layoutHints: "全部 surface 卡片模拟代码框；标题前缀 \"$ \" 或 \"> \" 强化终端感；accent 红/黄只用在状态指示；数据页用 wpp_render_chart:bar 配 primary 绿。",
        darkMode: true,
        primaryColor: "#4ADE80", secondaryColor: "#FBBF24", accentColor: "#F87171",
        backgroundColor: "#0D1117", surfaceColor: "#161B22",
        titleColor: "#E6EDF3", bodyColor: "#8B949E",
        titleFont: "Consolas", bodyFont: "Consolas"
      }),
      "swiss-modern": Object.freeze({
        label: "Swiss Modern", description: "极简、精准 · 企业数据汇报",
        design: "纯黑白 + 一抹瑞士红，网格留白克制。灵感：Helvetica / Müller-Brockmann / Dieter Rams。",
        signatureElement: "纯黑白基底 + 一抹瑞士红 + 显式细网格 + 不对称版式 + 极简几何形。",
        layoutHints: "内容页 content-sidebar 走严苛对齐；accent 红全页只准用 1 处（一根线或一个圆点）；留白 ≥ 50%；禁止任何渐变/阴影/卡通。",
        darkMode: false,
        primaryColor: "#000000", secondaryColor: "#525252", accentColor: "#DC2626",
        backgroundColor: "#FFFFFF", surfaceColor: "#F4F4F5",
        titleColor: "#000000", bodyColor: "#262626",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "paper-ink": Object.freeze({
        label: "Paper & Ink", description: "文学感、沉稳 · 深度叙事/研究",
        design: "旧纸黄 + 墨黑 + 朱砂红印章。宋体衬线，文人气。灵感：Penguin Classics 封面。",
        signatureElement: "旧纸黄底 + 墨黑宋体 + 朱砂红印章式装饰 + 大首字下沉 + 优雅细横线分割。",
        layoutHints: "引言 quote-block 是核心版式；内容页加宽行距、首字号放大；横线（细线 wpp_add_shape:line）分隔章节比满屏色块更合适；禁色块满铺。",
        darkMode: false,
        primaryColor: "#1C1917", secondaryColor: "#44403C", accentColor: "#991B1B",
        backgroundColor: "#F5EDD8", surfaceColor: "#E8DCBF",
        titleColor: "#1C1917", bodyColor: "#292524",
        titleFont: "宋体", bodyFont: "宋体"
      }),
      "8-bit-orbit": Object.freeze({
        label: "8-Bit Orbit", description: "复古科技 · CRT 像素霓虹",
        design: "深空蓝底 + 粉青黄霓虹三色 + CRT 扫描线 + 像素字体；80s 街机迷幻感。",
        signatureElement: "霓虹 CRT 扫描线叠加星空，蚀刻栅格上堆叠硬阴影发光",
        layoutHints: "封面用 wpp_apply_template:cover-band；章节用 v-cover-gradient；数据强爆 v-stat-bigtype。",
        darkMode: true,
        primaryColor: "#5EDCF4", secondaryColor: "#F0A6CA", accentColor: "#F4D03F",
        backgroundColor: "#0A0E27", surfaceColor: "#0F1B3D",
        titleColor: "#FFFFFF", bodyColor: "#E2D5F2",
        titleFont: "Tektur", bodyFont: "Chakra Petch"
      }),
      "biennale-yellow": Object.freeze({
        label: "Biennale Yellow", description: "双年展海报 · 暖纸明黄",
        design: "羊皮纸底 + 太阳明黄 + 深墨蓝衬线；像艺术双年展海报的氛围渐变。",
        signatureElement: "羊皮纸底上的明黄径向光晕，1px 深墨细线分割",
        layoutHints: "封面用 cover-split；章节用 v-section-modern；金句页用 quote-block。",
        darkMode: false,
        primaryColor: "#F1EE2E", secondaryColor: "#E26B4A", accentColor: "#F0DA7C",
        backgroundColor: "#E9E5DB", surfaceColor: "#DCD6C4",
        titleColor: "#1B2566", bodyColor: "#1B2566",
        titleFont: "Instrument Serif", bodyFont: "Archivo"
      }),
      "block-frame": Object.freeze({
        label: "Block Frame", description: "新野兽派 · 粗黑边糖果色块",
        design: "白底 + 粉/黄糖果色卡 + 4px 纯黑粗边 + 硬偏移阴影；倾斜堆叠。",
        signatureElement: "4px 纯黑粗边框 + 8px 硬偏移阴影，倾斜糖果色卡片堆叠",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#000000", secondaryColor: "#FE90E8", accentColor: "#F7CB46",
        backgroundColor: "#FFFFFF", surfaceColor: "#FFFDF5",
        titleColor: "#000000", bodyColor: "#000000",
        titleFont: "Inter", bodyFont: "Space Grotesk"
      }),
      "blue-professional": Object.freeze({
        label: "Blue Professional", description: "清爽专业 · 暖白底钴蓝点缀",
        design: "暖奶油画布 + 唯一钴蓝高亮重点；干净不冷的现代专业感。",
        signatureElement: "暖奶油画布上唯一钴蓝高亮所有重点元素",
        layoutHints: "封面用 cover-split；内容页 v-content-modern；指标页 v-stat-bigtype。",
        darkMode: false,
        primaryColor: "#1E2BFA", secondaryColor: "#111111", accentColor: "#1E2BFA",
        backgroundColor: "#FDFAE7", surfaceColor: "#FDFAE7",
        titleColor: "#111111", bodyColor: "#6B6B6B",
        titleFont: "Space Grotesk", bodyFont: "Inter"
      }),
      "bold-poster": Object.freeze({
        label: "Bold Poster", description: "杂志封面 · 戏剧大字",
        design: "Shrikhand 巨型大字 + 一抹消防红 + 白纸；像可被引用的海报。",
        signatureElement: "Shrikhand 大字旋转 -6°，红色重墨边栏与黑色粗框交替",
        layoutHints: "封面用 cover-band；章节用 section-fullbleed；金句用 quote-block。",
        darkMode: false,
        primaryColor: "#D8000F", secondaryColor: "#1C1410", accentColor: "#D8000F",
        backgroundColor: "#FFFFFF", surfaceColor: "#F5F2EF",
        titleColor: "#1C1410", bodyColor: "#1C1410",
        titleFont: "Shrikhand", bodyFont: "Libre Baskerville"
      }),
      "broadside": Object.freeze({
        label: "Broadside", description: "新闻头条 · 暗调火橙双语",
        design: "墨黑大幕 + 唯一火橙作头条；超大 Barlow 黑字作图形。中英文双语友好。",
        signatureElement: "超大 Barlow 900 小写黑字作图形，墨黑与火橙双寄存器切换",
        layoutHints: "章节用 section-fullbleed；封面用 v-cover-gradient；金句用 quote-block。",
        darkMode: true,
        primaryColor: "#E85D26", secondaryColor: "#F0ECE5", accentColor: "#E85D26",
        backgroundColor: "#111111", surfaceColor: "#1A1A18",
        titleColor: "#F0ECE5", bodyColor: "#888880",
        titleFont: "Barlow", bodyFont: "IBM Plex Mono"
      }),
      "capsule": Object.freeze({
        label: "Capsule", description: "胶囊几何 · Y2K 粉彩",
        design: "暖骨白底 + 胶囊形状卡 + 2px 描边 + 硬阴影；孟菲斯/编辑混搭。",
        signatureElement: "全局 pill 胶囊几何，2px 描边 + 硬阴影的孟菲斯编辑混搭",
        layoutHints: "封面用 cover-split；内容页 v-content-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#E85D4E", secondaryColor: "#1E1E1E", accentColor: "#C4D94E",
        backgroundColor: "#F5F5F0", surfaceColor: "#FFFFFF",
        titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
        titleFont: "Bodoni Moda", bodyFont: "Space Grotesk"
      }),
      "cartesian": Object.freeze({
        label: "Cartesian", description: "经典安静 · 暖中性 Playfair",
        design: "暖砂岩底 + Playfair 衬线 + 1px 灰褐细线；不慌不忙的成熟感。",
        signatureElement: "暖砂岩底上 1px 灰褐细线分割，背景漂浮制图圆环",
        layoutHints: "封面用 cover-split；章节用 v-section-modern；对比页用 two-column。",
        darkMode: false,
        primaryColor: "#1A1A1A", secondaryColor: "#8A8178", accentColor: "#B8B0A4",
        backgroundColor: "#EDE8E0", surfaceColor: "#E2DBD1",
        titleColor: "#1A1A1A", bodyColor: "#5A5A5A",
        titleFont: "Playfair Display", bodyFont: "Inter"
      }),
      "cobalt-grid": Object.freeze({
        label: "Cobalt Grid", description: "钴蓝衬线 · 网格出版物",
        design: "米白纸面 + 透明坐标方格 + 钴蓝衬线大字；像设计研究公报。",
        signatureElement: "米白纸面上常驻 10% 透明坐标方格，右缘像素故障扫描列",
        layoutHints: "封面用 cover-split；内容页 v-content-modern；数据页 v-stat-bigtype。",
        darkMode: false,
        primaryColor: "#1F2BE0", secondaryColor: "#5560E5", accentColor: "#1F2BE0",
        backgroundColor: "#F0EBDE", surfaceColor: "#E6E0CE",
        titleColor: "#1F2BE0", bodyColor: "#1F2BE0",
        titleFont: "Newsreader", bodyFont: "Hanken Grotesk"
      }),
      "coral": Object.freeze({
        label: "Coral", description: "珊瑚墨黑 · Bebas 杂志",
        design: "近黑底 + 奶油 + 珊瑚红三色硬边相接；超大 Bebas Neue 作背景图形。",
        signatureElement: "珊瑚/墨/奶油三色块硬边相接，超大数字与引号作背景",
        layoutHints: "章节用 section-fullbleed；封面用 v-cover-gradient；金句用 quote-block。",
        darkMode: true,
        primaryColor: "#E85D5D", secondaryColor: "#F5F0E8", accentColor: "#E85D5D",
        backgroundColor: "#1A1A1A", surfaceColor: "#F5F0E8",
        titleColor: "#F5F0E8", bodyColor: "#B0B0B0",
        titleFont: "Bebas Neue", bodyFont: "Inter"
      }),
      "creative-mode": Object.freeze({
        label: "Creative Mode", description: "丝网拼贴 · 多彩自信",
        design: "奶油纸底 + 绿/粉/橙/黄多色 + Archivo Black 重字；4px 黑框 + 24px 硬阴影。",
        signatureElement: "4px 墨黑粗框 + 24px 硬偏移阴影的丝网印刷拼贴美学",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#0F0F0F", secondaryColor: "#1F8A4C", accentColor: "#F06CA8",
        backgroundColor: "#EFE9D9", surfaceColor: "#E4DCC4",
        titleColor: "#0F0F0F", bodyColor: "#2A2A2A",
        titleFont: "Archivo Black", bodyFont: "Space Grotesk"
      }),
      "daisy-days": Object.freeze({
        label: "Daisy Days", description: "手绘雏菊 · 粉彩暖友好",
        design: "燕麦底 + 粉/薄荷/黄柔配色 + 手绘雏菊星星装饰；柔软温和。",
        signatureElement: "手绘雏菊星云装饰角落，3px 炭笔描边 + 大圆角卡片",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；对比页用 two-column。",
        darkMode: false,
        primaryColor: "#F7C8D4", secondaryColor: "#FDE68A", accentColor: "#D4A5E8",
        backgroundColor: "#F5F0E6", surfaceColor: "#7ECDC0",
        titleColor: "#3A2A1A", bodyColor: "#3A2A1A",
        titleFont: "Fredoka One", bodyFont: "Quicksand"
      }),
      "editorial-forest": Object.freeze({
        label: "Editorial Forest", description: "森绿 + 玫瑰粉 · 安静编辑",
        design: "燕麦奶油底 + 森林绿 + 玫瑰粉点缀 + Source Serif 大字。",
        signatureElement: "森林绿、玫瑰粉、燕麦奶油三色编辑配色，220px 衬线大字",
        layoutHints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
        darkMode: false,
        primaryColor: "#2E4A2A", secondaryColor: "#E89CB1", accentColor: "#E89CB1",
        backgroundColor: "#EFE7D4", surfaceColor: "#E6DCC4",
        titleColor: "#2E4A2A", bodyColor: "#1A1A17",
        titleFont: "Source Serif 4", bodyFont: "Source Serif 4"
      }),
      "editorial-tri-tone": Object.freeze({
        label: "Editorial Tri-Tone", description: "粉/奶油/酒红 · 时装编辑",
        design: "三色编辑系统：奶油黄、玫瑰粉、深酒红；衬线 + 无衬线对比强。",
        signatureElement: "粉/奶油/酒红三色严格语义化，标题中 em 触发衬线斜体切换",
        layoutHints: "封面用 cover-band；章节用 v-section-modern；金句用 quote-block。",
        darkMode: false,
        primaryColor: "#7A1F35", secondaryColor: "#F2B6C6", accentColor: "#F2D86A",
        backgroundColor: "#F2D86A", surfaceColor: "#F2B6C6",
        titleColor: "#7A1F35", bodyColor: "#7A1F35",
        titleFont: "Bricolage Grotesque", bodyFont: "Bricolage Grotesque"
      }),
      "emerald-editorial": Object.freeze({
        label: "Emerald Editorial", description: "翡翠海军 · 杂志封面式商业",
        design: "翡翠绿满铺 + 海军蓝 + 奶油纸；Bodoni 装饰双线饰带。",
        signatureElement: "双线饰带夹中央衬线词，19 世纪戏剧海报式装饰",
        layoutHints: "封面用 cover-band；章节用 v-cover-gradient；金句用 quote-block。",
        darkMode: true,
        primaryColor: "#3CD896", secondaryColor: "#0F1A5C", accentColor: "#F1E9D6",
        backgroundColor: "#3CD896", surfaceColor: "#2DC684",
        titleColor: "#0F1A5C", bodyColor: "#0F1A5C",
        titleFont: "Bodoni Moda", bodyFont: "Manrope"
      }),
      "grove": Object.freeze({
        label: "Grove", description: "森林绿 + 锈红 · Playfair 古典",
        design: "深林绿底 + 奶油字 + 锈红 Playfair 斜体；缓慢古典。",
        signatureElement: "深林绿底上下细线框，赤陶珊瑚色斜体 Playfair 标题",
        layoutHints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
        darkMode: true,
        primaryColor: "#C8524A", secondaryColor: "#E8E4D6", accentColor: "#C8524A",
        backgroundColor: "#192B1B", surfaceColor: "#1E3221",
        titleColor: "#E8E4D6", bodyColor: "#D4CFBF",
        titleFont: "Playfair Display", bodyFont: "Jost"
      }),
      "long-table": Object.freeze({
        label: "Long Table", description: "锈红奶油 · 温暖社交",
        design: "奶油纸 + 锈红径向点纹 + Fraunces 衬线；像小店招贴。",
        signatureElement: "奶油纸面 4px 径向点阵纹理，单一锈红墨色多透明度分层",
        layoutHints: "封面用 cover-split；内容页 v-content-modern；对比页用 two-column。",
        darkMode: false,
        primaryColor: "#B53D2A", secondaryColor: "#8E2D1F", accentColor: "#B53D2A",
        backgroundColor: "#FAF1E2", surfaceColor: "#F2E5CF",
        titleColor: "#B53D2A", bodyColor: "#B53D2A",
        titleFont: "Bricolage Grotesque", bodyFont: "Fraunces"
      }),
      "mat": Object.freeze({
        label: "Mat", description: "深沙绿 + 橙 · 中世纪现代",
        design: "深沙绿画布 + 奶油纸卡 + 烧橙点缀；木质温暖的中世纪感。",
        signatureElement: "深林绿画布右下角木棕径向光晕，奶油信息卡如纸张漂浮",
        layoutHints: "封面用 cover-split；章节用 v-cover-gradient；内容页 content-sidebar。",
        darkMode: true,
        primaryColor: "#C07030", secondaryColor: "#EDE6D0", accentColor: "#C07030",
        backgroundColor: "#232E26", surfaceColor: "#EDE6D0",
        titleColor: "#F0E8D2", bodyColor: "#F0E8D2",
        titleFont: "Bricolage Grotesque", bodyFont: "DM Sans"
      }),
      "monochrome": Object.freeze({
        label: "Monochrome", description: "纯黑白 · Lora 学术",
        design: "象牙账本纸 + 纯黑字 + Lora 衬线；零彩色的考古级安静。",
        signatureElement: "纯奶油纸面无任何彩色，黑墨与石墨灰单色调研究报告感",
        layoutHints: "封面用 cover-split；内容页 v-content-modern；金句用 quote-block。",
        darkMode: false,
        primaryColor: "#1A1A16", secondaryColor: "#5E5E54", accentColor: "#8A8A80",
        backgroundColor: "#FAFADF", surfaceColor: "#F2F2D2",
        titleColor: "#1A1A16", bodyColor: "#1A1A16",
        titleFont: "Lora", bodyFont: "Jost"
      }),
      "neo-grid-bold": Object.freeze({
        label: "Neo-Grid Bold", description: "霓虹黄信号 · 新野兽派",
        design: "燕麦纸底 + 单一霓虹黄 + Space Grotesk 重字；编辑性强。",
        signatureElement: "12×8 栅格内嵌 40px，柠檬黄信号高亮 + 2×2 角标块印章",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；数据页 v-stat-bigtype。",
        darkMode: false,
        primaryColor: "#0A0A0A", secondaryColor: "#8A8A85", accentColor: "#E6FF3D",
        backgroundColor: "#F5F4EF", surfaceColor: "#ECECE8",
        titleColor: "#0A0A0A", bodyColor: "#0A0A0A",
        titleFont: "Space Grotesk", bodyFont: "JetBrains Mono"
      }),
      "peoples-platform": Object.freeze({
        label: "People's Platform", description: "活动家海报 · 蓝橙红丝印",
        design: "奶油纸 + 蓝/橙/红三色 + Alfa Slab 平板字 + 颗粒纹理。",
        signatureElement: "红色双层堆叠字符投影 + 6px 墨边 + 颗粒纹理的丝网印刷质感",
        layoutHints: "封面用 cover-band；章节用 v-section-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#2C2CDC", secondaryColor: "#F2A03A", accentColor: "#E83A2A",
        backgroundColor: "#F5F2EA", surfaceColor: "#F4E9D6",
        titleColor: "#2C2CDC", bodyColor: "#1A1A1A",
        titleFont: "Alfa Slab One", bodyFont: "DM Mono"
      }),
      "pin-and-paper": Object.freeze({
        label: "Pin & Paper", description: "安全别针 · 黄纸手作感",
        design: "亮黄便笺纸 + 手绘安全别针 + 蓝墨字 + Caveat 手写注脚。",
        signatureElement: "手绘安全别针 SVG 将奶油卡片别在黄色便笺纸纹理背景上",
        layoutHints: "封面用 cover-split；内容页 v-content-modern；对比页用 two-column。",
        darkMode: false,
        primaryColor: "#1F3A8A", secondaryColor: "#2D4FB8", accentColor: "#C9A66B",
        backgroundColor: "#EFE56A", surfaceColor: "#F8F1D6",
        titleColor: "#1F3A8A", bodyColor: "#1F3A8A",
        titleFont: "Space Grotesk", bodyFont: "DM Mono"
      }),
      "pink-script": Object.freeze({
        label: "Pink Script", description: "黑底霓虹粉 · 夜场奢华",
        design: "暖黑漆面 + 霓虹粉光晕 + DM Serif 衬线；午夜编辑奢华感。",
        signatureElement: "暖黑漆面左上角径向光晕，胶片颗粒 + 1px 细框内嵌 36px",
        layoutHints: "封面用 cover-split；章节用 v-cover-gradient；金句用 quote-block。",
        darkMode: true,
        primaryColor: "#ED3D8C", secondaryColor: "#FF66A8", accentColor: "#ED3D8C",
        backgroundColor: "#060507", surfaceColor: "#0F0D11",
        titleColor: "#F5EDF1", bodyColor: "#F5EDF1",
        titleFont: "DM Serif Display", bodyFont: "Inter"
      }),
      "playful": Object.freeze({
        label: "Playful", description: "桃陶土暖底 · 独立友好",
        design: "桃陶土暖底 + Syne 字体 + 不对称 blob 形状；indie 友好。",
        signatureElement: "桃陶土底色上双描边偏移卡片 + 不对称圆角 blob 形状轻微旋转",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；对比页用 two-column。",
        darkMode: false,
        primaryColor: "#1A1A1A", secondaryColor: "#E8B88E", accentColor: "#1A1A1A",
        backgroundColor: "#F0C8A0", surfaceColor: "#F7DEC6",
        titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
        titleFont: "Syne", bodyFont: "Space Grotesk"
      }),
      "raw-grid": Object.freeze({
        label: "Raw Grid", description: "粗黑边 · 新野兽派直接",
        design: "白底 + 粉/灰绿 + 3px 黑边 + 6px 黑阴影；scrappy confident。",
        signatureElement: "3px 纯黑粗边即布局，6px 硬黑阴影 + 黑底白字胶囊标签",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#0A0A0A", secondaryColor: "#F2D4CF", accentColor: "#E5EDD6",
        backgroundColor: "#FFFFFF", surfaceColor: "#F5F5F5",
        titleColor: "#0A0A0A", bodyColor: "#333333",
        titleFont: "Segoe UI", bodyFont: "Segoe UI"
      }),
      "retro-windows": Object.freeze({
        label: "Retro Windows", description: "Win95 复古 · 像素游戏感",
        design: "Win98 灰底 + 海军蓝标题栏 + Press Start 像素字；纯粹复古道具。",
        signatureElement: "每页一个 Win98 窗口斜面 + 海军蓝渐变标题栏与系统按钮",
        layoutHints: "封面用 cover-split；内容页 v-content-modern；对比页用 two-column。",
        darkMode: false,
        primaryColor: "#000080", secondaryColor: "#808080", accentColor: "#0000A0",
        backgroundColor: "#C0C0C0", surfaceColor: "#D4D0C8",
        titleColor: "#000000", bodyColor: "#222222",
        titleFont: "Press Start 2P", bodyFont: "MS Sans Serif"
      }),
      "retro-zine": Object.freeze({
        label: "Retro Zine", description: "Riso 印刷 · 绿色色块独立刊",
        design: "米色纸 + 绿色偏移色块 + Bebas Neue + Caveat 手写；DIY zine 感。",
        signatureElement: "SVG 颗粒覆盖 + 绿色色块偏移 12px 垫底白卡，旋转图章拼贴",
        layoutHints: "封面用 cover-band；章节用 v-section-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#008F4D", secondaryColor: "#1A1A1A", accentColor: "#00A85D",
        backgroundColor: "#C8B99A", surfaceColor: "#F4EFE6",
        titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
        titleFont: "Bebas Neue", bodyFont: "Space Grotesk"
      }),
      "sakura-chroma": Object.freeze({
        label: "Sakura Chroma", description: "日式磁带包装 · 彩带条码",
        design: "奶油纸 + 红/粉/橙日系三色 + 斜彩带 + 印章；磁带包装感。",
        signatureElement: "花瓣形 blob + 22° 斜彩带 + 12 芒星章 + 红方印的日式编辑感",
        layoutHints: "封面用 cover-band；章节用 v-section-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#E5392A", secondaryColor: "#E54489", accentColor: "#F09131",
        backgroundColor: "#F1E6CB", surfaceColor: "#E5D6B0",
        titleColor: "#3A2516", bodyColor: "#3A2516",
        titleFont: "Big Shoulders Display", bodyFont: "Albert Sans"
      }),
      "scatterbrain": Object.freeze({
        label: "Scatterbrain", description: "便利贴拼贴 · 工作坊感",
        design: "亮黄底 + 蓝/粉/绿便利贴卡 + Shrikhand + Caveat 手写感。",
        signatureElement: "软木板上彩色便利贴拼贴，红蓝绿金图钉与美纹胶带",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；对比页用 two-column。",
        darkMode: false,
        primaryColor: "#FFE066", secondaryColor: "#FFC9C9", accentColor: "#B2F2BB",
        backgroundColor: "#FFE066", surfaceColor: "#A5D8FF",
        titleColor: "#1A1A1A", bodyColor: "#1A1A1A",
        titleFont: "Shrikhand", bodyFont: "Zilla Slab"
      }),
      "signal": Object.freeze({
        label: "Signal", description: "海军蓝 + 古金 · 机构权威",
        design: "深编辑海军蓝 + 暖奶油纸 + 古金色衬线斜体；安静的机构权威感。",
        signatureElement: "深编辑海军蓝与暖奶油纸双面交替，古金色衬线斜体混排",
        layoutHints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
        darkMode: true,
        primaryColor: "#1C2644", secondaryColor: "#F0ECE3", accentColor: "#C8A870",
        backgroundColor: "#1C2644", surfaceColor: "#F0ECE3",
        titleColor: "#E2DCD0", bodyColor: "#8A96A8",
        titleFont: "Source Serif 4", bodyFont: "DM Sans"
      }),
      "soft-editorial": Object.freeze({
        label: "Soft Editorial", description: "Cormorant 衬线 · 暖纸文学",
        design: "奶油底 + 罗马/斜体混排 + Cormorant Garamond；周日副刊的优雅。",
        signatureElement: "奶油底上 24-36px 圆角半透明白卡漂浮，标题罗马 + 斜体混排",
        layoutHints: "封面用 cover-split；章节用 v-section-modern；金句用 quote-block。",
        darkMode: false,
        primaryColor: "#2A241B", secondaryColor: "#E1A4C2", accentColor: "#D6DD63",
        backgroundColor: "#F2EEDF", surfaceColor: "#ECE6D2",
        titleColor: "#2A241B", bodyColor: "#5C5345",
        titleFont: "Cormorant Garamond", bodyFont: "Work Sans"
      }),
      "stencil-tablet": Object.freeze({
        label: "Stencil & Tablet", description: "石碑模板字 · 大地色考古",
        design: "骨白纸 + 6 色大地调 + 模板镂空字；像考古手册。",
        signatureElement: "Stardos 油墨断裂模板字 + 22-26px 圆角彩色药片卡片",
        layoutHints: "封面用 cover-band；内容页 v-content-modern；数据页 stat-hero。",
        darkMode: false,
        primaryColor: "#0A0A0A", secondaryColor: "#A06A3C", accentColor: "#C73B7A",
        backgroundColor: "#E2DCC9", surfaceColor: "#F4EFE0",
        titleColor: "#0A0A0A", bodyColor: "#0A0A0A",
        titleFont: "Stardos Stencil", bodyFont: "Inter"
      }),
      "studio": Object.freeze({
        label: "Studio", description: "电黄 + 近黑 · 高压设计感",
        design: "近黑底 + 酸黄巨字；二元配色，无第三色。是库里最大声的。",
        signatureElement: "近黑底上 12vw 酸黄巨字作为唯一设计元素，二元配色无第三色",
        layoutHints: "章节用 section-fullbleed；封面用 v-cover-gradient；数据页 v-stat-bigtype。",
        darkMode: true,
        primaryColor: "#F5D200", secondaryColor: "#F0CC00", accentColor: "#F5D200",
        backgroundColor: "#1C1C1C", surfaceColor: "#242422",
        titleColor: "#F5D200", bodyColor: "#F5D200",
        titleFont: "Barlow", bodyFont: "Barlow"
      }),
      "vellum": Object.freeze({
        label: "Vellum", description: "深海军 + 暖鹅黄衬线 · 学者",
        design: "深长春花海军蓝单色场 + 暖鹅黄居中衬线斜体；学者气质。",
        signatureElement: "深长春花海军蓝单色场 + 暖鹅黄居中斜体衬线，左下角打字注脚",
        layoutHints: "封面用 cover-split；章节用 v-cover-gradient；金句用 quote-block。",
        darkMode: true,
        primaryColor: "#E8D85C", secondaryColor: "#F5E168", accentColor: "#3A7878",
        backgroundColor: "#2A3870", surfaceColor: "#343F80",
        titleColor: "#E8D85C", bodyColor: "#E8D85C",
        titleFont: "Cormorant Garamond", bodyFont: "DM Sans"
      }),
    })
  });

  const factories = new Map();

  function register(type, factory) {
    factories.set(type, factory);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getSettingsStore() {
    if (global.WpsAiStore && typeof global.WpsAiStore.getItem === "function" && typeof global.WpsAiStore.setItem === "function") {
      return global.WpsAiStore;
    }
    if (global.localStorage && typeof global.localStorage.getItem === "function") return global.localStorage;
    if (typeof localStorage !== "undefined") return localStorage;
    return null;
  }

  function getLegacyLocalStorage() {
    if (global.localStorage && typeof global.localStorage.getItem === "function") return global.localStorage;
    if (typeof localStorage !== "undefined") return localStorage;
    return null;
  }

  function readSettingsRaw() {
    const store = getSettingsStore();
    const legacy = getLegacyLocalStorage();
    let raw = null;
    let legacyRaw = null;
    try { raw = store && store.getItem(SETTINGS_KEY); } catch (e) { raw = null; }
    if (legacy && legacy !== store) {
      try { legacyRaw = legacy.getItem(SETTINGS_KEY); } catch (e) { legacyRaw = null; }
    }
    if (legacyRaw && (!raw || getSettingsUpdatedAt(legacyRaw) > getSettingsUpdatedAt(raw))) {
      raw = legacyRaw;
    }
    if (raw && legacyRaw === raw && store && typeof store.setItem === "function") {
      try {
        store.setItem(SETTINGS_KEY, raw);
        if (typeof store.flush === "function") {
          const flushed = store.flush();
          if (flushed && typeof flushed.catch === "function") flushed.catch(() => {});
        }
      } catch (e) {}
    }
    return raw;
  }

  function getSettingsUpdatedAt(raw) {
    try {
      const parsed = JSON.parse(raw || "{}");
      return Number(parsed && parsed.__updatedAt) || 0;
    } catch (e) {
      return 0;
    }
  }

  function loadSettings() {
    try {
      const raw = readSettingsRaw();
      if (!raw) {
        return clone(DEFAULT_SETTINGS);
      }
      const parsed = JSON.parse(raw);
      const merged = clone(DEFAULT_SETTINGS);
      if (typeof parsed.__updatedAt === "number") merged.__updatedAt = parsed.__updatedAt;
      merged.activeProvider = parsed.activeProvider || merged.activeProvider;
      merged.operationMode = parsed.operationMode || merged.operationMode;
      if (Array.isArray(parsed.mcpClients)) {
        merged.mcpClients = parsed.mcpClients.map((c) => Object.assign({}, c));
      }
      if (Array.isArray(parsed.enabledHosts)) {
        const valid = parsed.enabledHosts.filter((h) => ["wps", "et", "wpp", "pdf"].includes(h));
        if (valid.length) merged.enabledHosts = valid;
      }
      if (typeof parsed.maxToolIterations === "number" && parsed.maxToolIterations > 0) {
        merged.maxToolIterations = parsed.maxToolIterations;
      }
      Object.keys(merged.providers).forEach((key) => {
        if (parsed.providers && parsed.providers[key]) {
          merged.providers[key] = Object.assign({}, merged.providers[key], parsed.providers[key]);
        }
      });
      // ---- imageProviders 多渠道数组 ----
      // 优先用 parsed.imageProviders（新版结构）；没有则从老 parsed.imageProvider 单对象迁移
      if (Array.isArray(parsed.imageProviders) && parsed.imageProviders.length > 0) {
        merged.imageProviders = parsed.imageProviders.map((p) => Object.assign({}, p));
      } else if (parsed.imageProvider && typeof parsed.imageProvider === "object") {
        const ip = parsed.imageProvider;
        const oldType = ip.type || "toapis";
        // 关键：迁移前先把默认 list 里全部 enabled 清掉，再按老配置的 type 单点开启；
        // 否则默认 codex-bridge.enabled=true 会跟用户老选的 toapis 同时为 true，导致两个都被勾上
        const list = merged.imageProviders.map((p) => Object.assign({}, p, { enabled: false }));
        // 把老的 toapis 字段塞回 toapis entry
        const t = list.find((p) => p.type === "toapis");
        if (t) {
          if (ip.baseUrl) t.baseUrl = ip.baseUrl;
          if (ip.apiKey) t.apiKey = ip.apiKey;
          if (ip.model) t.model = ip.model;
          if (ip.defaultSize) t.defaultSize = ip.defaultSize;
          if (ip.defaultResolution) t.defaultResolution = ip.defaultResolution;
          if (typeof ip.useProxy === "boolean") t.useProxy = ip.useProxy;
        }
        // 把老的 codex* 字段塞回 codex-bridge entry
        const c = list.find((p) => p.type === "codex-bridge");
        if (c) {
          if (ip.codexBaseUrl) c.baseUrl = ip.codexBaseUrl;
          if (ip.codexApiKey) c.apiKey = ip.codexApiKey;
          if (ip.codexModel) c.model = ip.codexModel;
          if (ip.codexSize) c.defaultSize = ip.codexSize;
          if (typeof ip.codexUseProxy === "boolean") c.useProxy = ip.codexUseProxy;
        }
        // 老配置 enabled=true 时，把当时选中的 type 对应 entry 标 enabled
        if (ip.enabled) {
          const target = list.find((p) => p.type === oldType);
          if (target) target.enabled = true;
        }
        merged.imageProviders = list;
      }
      // 新增内置渠道补齐：老版本存量设置的 imageProviders 里没有 openai / openrouter，
      // 升级后按 type 查缺自动追加（enabled=false，不影响用户当前激活渠道）。
      if (Array.isArray(merged.imageProviders)) {
        const haveTypes = new Set(merged.imageProviders.map((p) => p && p.type).filter(Boolean));
        DEFAULT_SETTINGS.imageProviders.forEach((d) => {
          if (!haveTypes.has(d.type)) merged.imageProviders.push(Object.assign({}, d));
        });
      }
      // 兜底互斥：图像渠道任何时刻只允许一条 enabled=true。
      // 修历史污染数据（之前迁移 bug 把 codex-bridge 跟 toapis 同时设成 enabled），
      // 同时保护未来任何代码路径意外塞入多个 enabled。
      if (Array.isArray(merged.imageProviders)) {
        let seen = false;
        merged.imageProviders = merged.imageProviders.map((p) => {
          if (p && p.enabled && !seen) { seen = true; return p; }
          if (p && p.enabled) return Object.assign({}, p, { enabled: false });
          return p;
        });
      }
      if (parsed.stylePreset) {
        merged.stylePreset = Object.assign({}, merged.stylePreset, parsed.stylePreset);
      }
      // systemPrompt：用户主动留空也尊重（保存空字符串=不追加个性化提示）
      if (typeof parsed.systemPrompt === "string") {
        merged.systemPrompt = parsed.systemPrompt;
      }
      // 界面语言：只接受合法值
      if (parsed.uiLanguage === "auto" || parsed.uiLanguage === "zh" || parsed.uiLanguage === "en") {
        merged.uiLanguage = parsed.uiLanguage;
      }
      if (typeof parsed.aiFollowHighlight === "boolean") {
        merged.aiFollowHighlight = parsed.aiFollowHighlight;
      }
      // currentProject 已改为「AI 每对话总结」，不再从存量设置里恢复手填值（否则会盖住自动项目名）
      if (typeof parsed.imageSizeOverride === "string") {
        merged.imageSizeOverride = parsed.imageSizeOverride;
      }

      // 其余顶层布尔设置项 —— 之前漏了 merge，导致用户保存的勾选状态下次加载全被默认值覆盖。
      // 用 hasOwnProperty 判断而不是 || ，避免 false 被当成"未保存"
      ["splitLayersOnInsert", "showToolCallLogs", "mcpServerEnabled", "updateAutoCheck", "reviseMode"].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(parsed, k)) {
          merged[k] = !!parsed[k];
        }
      });

      // ---- chatProviders 多供应商数组 ----
      // 优先用 parsed.chatProviders（新版结构）。如果没有，从 parsed.providers 老结构迁移
      if (Array.isArray(parsed.chatProviders) && parsed.chatProviders.length > 0) {
        merged.chatProviders = parsed.chatProviders.map((p) => Object.assign({}, p));
      } else {
        // 老 → 新迁移：把 providers.codex/openai/anthropic 各转成一条 chatProviders 条目
        // enabled 标志按"老 activeProvider 是它"或"有 apiKey/已登录"推断
        const list = clone(DEFAULT_CHAT_PROVIDERS);
        for (const entry of list) {
          const oldP = merged.providers[entry.type];
          if (!oldP) continue;
          Object.assign(entry, {
            baseUrl: oldP.baseUrl ?? entry.baseUrl,
            apiKey: oldP.apiKey ?? entry.apiKey,
            defaultModel: oldP.defaultModel ?? entry.defaultModel,
            anthropicVersion: oldP.anthropicVersion ?? entry.anthropicVersion,
            useProxy: oldP.useProxy ?? entry.useProxy
          });
          // 是否启用：API Key 有值 / 是 Codex(OAuth) / 老 activeProvider 选的它
          entry.enabled = !!(entry.apiKey) || entry.type === "codex" || merged.activeProvider === entry.type;
        }
        merged.chatProviders = list;
      }
      merged.activeChatModel = typeof parsed.activeChatModel === "string" ? parsed.activeChatModel : "";

      return merged;
    } catch (error) {
      console.warn("[provider] 读取设置失败，使用默认值", error);
      return clone(DEFAULT_SETTINGS);
    }
  }

  // 解析 activeChatModel（格式 "<providerId>::<modelId>" 或纯 "<modelId>" 兼容老的）
  // 返回 { providerId, modelId }；providerId 为空时表示需要按当前激活的 chatProviders 推断
  function parseActiveChatModel(value) {
    const s = String(value || "");
    const idx = s.indexOf("::");
    // 修 B50：用 >=0。encodeActiveChatModel("", "gpt-4o") 产出 "::gpt-4o"（idx===0），
    // 旧的 idx>0 会把整串 "::gpt-4o" 当成 modelId，导致后续按 modelId 匹配全部带 "::" 前缀出错。
    if (idx >= 0) return { providerId: s.slice(0, idx), modelId: s.slice(idx + 2) };
    return { providerId: "", modelId: s };
  }

  function encodeActiveChatModel(providerId, modelId) {
    return `${providerId || ""}::${modelId || ""}`;
  }

  // 给定 settings，返回当前用来发请求的 provider 配置（chatProviders 里那条）。
  // 如果 activeChatModel 没指定 providerId，回退到第一个 enabled 的 chatProvider。
  function getActiveChatProvider(settings = loadSettings()) {
    const { providerId } = parseActiveChatModel(settings.activeChatModel);
    let entry = (settings.chatProviders || []).find((p) => p.id === providerId && p.enabled);
    if (!entry) entry = (settings.chatProviders || []).find((p) => p.enabled);
    if (!entry) entry = (settings.chatProviders || [])[0];
    return entry || null;
  }

  // 返回当前激活的图像渠道配置（取 imageProviders 里首个 enabled）。
  // 若没有任何 entry 启用，返回 { enabled: false } 让 image.js 抛"未启用"错误。
  function getImageConfig(settings = loadSettings()) {
    const list = Array.isArray(settings.imageProviders) ? settings.imageProviders : [];
    const active = list.find((p) => p.enabled);
    if (!active) return { enabled: false };
    return Object.assign({}, active, { enabled: true });
  }

  function saveSettings(settings) {
    settings.__updatedAt = Date.now();
    const raw = JSON.stringify(settings);
    const store = getSettingsStore();
    if (!store || typeof store.setItem !== "function") throw new Error("设置存储不可用");
    store.setItem(SETTINGS_KEY, raw);
    if (typeof store.flush === "function") {
      try {
        const flushed = store.flush();
        if (flushed && typeof flushed.catch === "function") flushed.catch(() => {});
      } catch (e) {}
    }
  }

  function getActiveConfig(settings = loadSettings()) {
    // 新版优先：从 chatProviders 解析 activeChatModel
    const entry = getActiveChatProvider(settings);
    if (entry) {
      // 把 chatProviders 条目转成 provider factory 期望的 config 形态（id+type+...）
      return Object.assign({}, entry);
    }
    // 兜底：老代码路径
    const cfg = settings.providers[settings.activeProvider];
    if (!cfg) {
      throw new Error(`未知 provider: ${settings.activeProvider}`);
    }
    return Object.assign({ id: settings.activeProvider }, cfg);
  }

  function buildProvider(config = getActiveConfig()) {
    const factory = factories.get(config.type);
    if (!factory) {
      throw new Error(`Provider 类型未注册：${config.type}`);
    }
    return factory(config);
  }

  function listProviderTypes() {
    return Array.from(factories.keys());
  }

  global.WpsAiProviderRegistry = {
    register,
    buildProvider,
    loadSettings,
    saveSettings,
    getActiveConfig,
    getImageConfig,
    listProviderTypes,
    parseActiveChatModel,
    encodeActiveChatModel,
    getActiveChatProvider,
    DEFAULT_SETTINGS,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_CHAT_PROVIDERS,
    KNOWN_CHAT_PROVIDERS,
    COLOR_SCHEMES: DEFAULT_SETTINGS.COLOR_SCHEMES,
    DESIGN_GUIDELINES
  };
})(window);
