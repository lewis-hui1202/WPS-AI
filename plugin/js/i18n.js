// WpsAiI18n：轻量国际化（阶段一：zh + en）。
//
// 设计要点：
//   1. 以中文原文为 key（zh 是源语言，HTML/JS 里的中文即字典 key），en 词典查不到就
//      原样显示中文——渐进覆盖，永不白屏。
//   2. 静态 UI 不用逐个节点加标注：英文模式下对整个文档做「精确匹配」自动翻译
//      （TreeWalker 扫 text 节点 + placeholder/title/aria-label 属性），再挂
//      MutationObserver，动态渲染的节点同样自动翻。中文模式零开销（不扫不观察）。
//   3. 用户内容区域（聊天正文 / 工具输出 / 排版预览等）通过排除选择器跳过，
//      避免把文档内容里恰好等于 UI 文案的句子翻掉。
//   4. 语言偏好存 localStorage（auto | zh | en），auto 跟随系统语言；切换后 reload 生效。
//   5. JS 动态拼接文案用 WpsAiI18n.t("中文", {参数}) 渐进迁移。
(function attachI18n(global) {
  "use strict";

  const PREF_KEY = "lingxi_ui_lang_v1"; // "auto" | "zh" | "en"

  // ---- zh → en 词典（阶段一：核心界面）----
  const DICT_EN = {
    // 顶栏 / Tab / 全局
    "文小舟": "Wenxiaozhou",
    "你": "You",
    "思考": "Thinking",
    "插件启动中": "Starting up…",
    "检测中": "Checking…",
    "本地代理检测中": "Checking local proxy…",
    "新版本": "Update",
    "发现新版本，点击查看": "New version available, click to view",
    "灰度": "Canary",
    "未配置": "Not configured",
    "登录/服务状态": "Sign-in / service status",
    "AI 助手": "AI Assistant",
    "改动记录": "Changes",
    "素材库": "Assets",
    "切换停靠/浮动": "Toggle dock / float",
    "设置": "Settings",
    "历史对话": "Conversations",
    "还没有历史对话": "No conversations yet",
    "新对话（当前对话已自动存档）": "New conversation (current one is archived automatically)",
    "退出": "Sign out",
    "登录": "Sign in",
    "官网": "Website",
    "复制官网地址": "Copy website URL",
    "在浏览器中打开": "Open in browser",

    // 模型选择
    "模型": "Model",
    "点击选择模型": "Click to choose a model",
    "刷新模型列表": "Refresh model list",
    "（请选择模型）": "(choose a model)",
    "（请在设置里启用至少一个供应商）": "(enable at least one provider in Settings)",
    "临时切换本次对话的模型（不改默认设置）": "Temporarily switch model for this conversation (default unchanged)",
    "取消临时模型": "Clear temporary model",
    "点击切换思考强度": "Click to change thinking effort",
    "支持图像输入": "Supports image input",
    "支持 PDF 附件输入": "Supports PDF attachments",

    // 聊天区
    "输入指令，AI 会调用工具直接读写当前文档": "Type an instruction — AI will use tools to read & edit this document",
    "发送": "Send",
    "发送（Enter / ⌘-Enter）": "Send (Enter / ⌘-Enter)",
    "停止当前请求": "Stop current request",
    "停止": "Stop",
    "上传图片 / PDF / 文本附件作为 AI 的参考": "Attach images / PDFs / text files for the AI",
    "粘贴剪贴板内容": "Paste from clipboard",
    "回到最新消息": "Jump to latest message",
    "跳到最新一条": "Jump to latest",
    "↓ 最新": "↓ Latest",
    "折叠中间轮次：只保留首尾对话，中间轮折起来": "Fold middle turns: keep first & last, collapse the rest",
    "纯净模式：隐藏工具调用与推理过程": "Pure mode: hide tool calls & reasoning",
    "清空当前 tab 的会话": "Clear this tab's conversation",
    "AI 正在思考…": "AI is thinking…",
    "AI 正在生成图片": "AI is generating an image",
    "AI 工作中，文档已临时锁定": "AI is working — document temporarily locked",
    "AI 工作中，请勿手动操作表格": "AI is working — please don't edit the sheet",
    "AI 工作中，请勿手动操作幻灯片": "AI is working — please don't edit the slides",
    "AI 工作中": "AI is working",
    "思考过程": "Reasoning",
    "处理过程": "Processing",
    "思考中": "Thinking",
    "推理": "Reasoning",
    "快捷指令": "Quick action",
    "工具调用": "Tool call",
    "我": "Me",
    "待执行的工具调用": "Pending tool calls",
    "全部执行": "Run all",
    "全部跳过": "Skip all",
    "AI 推荐": "Suggested",
    "清除推荐": "Clear suggestions",
    "AI 操作模式": "AI edit mode",
    "AI 调用工具修改文档前是否需要你点确认。": "Whether AI asks for confirmation before modifying the document.",
    "直接操作wps(推荐)": "Apply directly (recommended)",
    "预览确认": "Preview & confirm",
    "预览模式：确认后才会写入文档": "Preview mode: writes to the document only after you confirm",
    "解除文档编辑限制（AI 锁定残留时用）": "Unlock document editing (use if AI lock persists)",
    "附加当前打开的 PDF": "Attach the currently open PDF",

    // 通用按钮 / 状态
    "保存": "Save",
    "取消": "Cancel",
    "关闭": "Close",
    "删除": "Delete",
    "刷新": "Refresh",
    "复制": "Copy",
    "确定": "OK",
    "应用": "Apply",
    "添加": "Add",
    "修改": "Edit",
    "移动": "Move",
    "清空": "Clear",
    "清空全部": "Clear all",
    "清空所有": "Clear all",
    "全部": "All",
    "全文": "Full document",
    "仅选中区域": "Selection only",
    "另存为": "Save as",
    "保存并关闭": "Save & close",
    "收起": "Collapse",
    "展开": "Expand",
    "加载中": "Loading",
    "加载中…": "Loading…",
    "读取中…": "Reading…",
    "处理中…": "Processing…",
    "渲染中…": "Rendering…",
    "排队中": "Queued",
    "已复制": "Copied",
    "点击复制": "Click to copy",
    "复制结果": "Copy result",
    "预览": "Preview",
    "重新生成": "Regenerate",
    "开始排版": "Format now",
    "撤销 (Ctrl+Z)": "Undo (Ctrl+Z)",
    "重做 (Ctrl+Y)": "Redo (Ctrl+Y)",
    "查看日志": "View logs",
    "状态": "Status",
    "名称": "Name",
    "结果": "Result",
    "工具": "Tools",
    "模板": "Template",
    "布局": "Layout",
    "字体": "Font",
    "项目": "Project",
    "分组": "Group",
    "页码": "Pages",
    "原文": "Source",
    "提示词": "Prompt",
    "今日": "Today",
    "最新": "Latest",

    // AI 排版
    "AI 排版预览": "AI Formatting Preview",
    "预览排版效果，确认后替换全文。": "Preview the formatting, then confirm to replace the document.",
    "排版范围": "Scope",
    "排版要求": "Requirements",
    "常用预设": "Presets",
    "可以留空。留空时 AI 会自动识别文档类型（合同 / 招标 / 公文 / 论文 等）再排版。": "Optional. Leave empty and the AI will detect the document type (contract / bid / official / paper etc.) automatically.",
    "点击「开始排版」按当前要求生成预览；留空则 AI 自动识别文档类型。": "Click \"Format now\" to generate a preview; leave requirements empty for auto-detection.",
    "正在生成排版预览…": "Generating formatting preview…",
    "替换全文": "Replace document",
    "替换选中区域": "Replace selection",
    "替换选区": "Replace selection",
    "替换当前选中": "Replace current selection",

    // 选区预览 / 翻译
    "选区预览": "Selection Preview",
    "预览修改前后内容，确认后替换当前选区。": "Preview the change, then confirm to replace the selection.",
    "高亮对比": "Highlight diff",
    "对照翻译": "Parallel translation",
    "目标语言": "Target language",
    "原文语言": "Source language",
    "开始翻译": "Translate",
    "选好语言后点「开始翻译」，这里会显示原文 / 译文对照。": "Pick languages and click Translate — the side-by-side result shows here.",
    "简体中文": "Simplified Chinese",
    "英文": "English",
    "日文": "Japanese",
    "韩文": "Korean",
    "法语": "French",
    "德语": "German",
    "西班牙语": "Spanish",
    "指定页": "Specific pages",
    "如 1-5, 8, 12-15": "e.g. 1-5, 8, 12-15",

    // 快捷指令弹窗
    "填写必要内容后自动发送给 AI。": "Fill in the blanks and it will be sent to the AI automatically.",
    "快捷操作": "Quick actions",

    // 设置侧栏 / 面板
    "聊天模型": "Chat Models",
    "聊天模型供应商": "Chat model providers",
    "可以同时配置多家。当前活动的模型在顶部下拉里切换，列表里只填 API Key 即可启用。": "You can configure multiple providers. Switch the active model in the top dropdown; filling in an API key is enough to enable one.",
    "+ 新增供应商": "+ Add provider",
    "选一个预设供应商": "Choose a preset provider",
    "挑一个会自动填好 baseURL / 默认模型；填完 API Key 就能用。": "Picking one pre-fills the base URL / default model; add your API key and you're set.",
    "测试供应商": "Test provider",
    "生图模型": "Image Models",
    "+ 新增图像渠道": "+ Add image channel",
    "技能": "Skills",
    "技能 (Skills)": "Skills",
    "刷新云端技能": "Refresh cloud skills",
    "导入技能 (.md/.txt)": "Import skill (.md/.txt)",
    "搜索技能名字 / 描述": "Search skills by name / description",
    "Token 消耗": "Token Usage",
    "服务状态": "Service Status",
    "刷新端口与内存占用": "Refresh ports & memory usage",
    "本机后台服务（承载 AI 调用 / 图表 / SQLite 缓存）占用的端口与内存。": "Ports and memory used by the local background services (AI calls / charts / SQLite cache).",
    "后台服务": "Background services",
    "MCP 服务": "MCP Server",
    "启用 MCP 服务": "Enable MCP server",
    "MCP 客户端": "MCP Client",
    "连接外部 MCP 服务（本地 stdio 子进程 / 远程 SSE），把它们的工具加入 AI 对话调用。需要 proxy-server.js 正在运行。": "Connect external MCP services (local stdio subprocess / remote SSE) and bring their tools into AI chat. Requires proxy-server.js running.",
    "+ 新增 MCP 服务": "+ Add MCP service",
    "信任此服务（工具调用跳过确认）": "Trust this service (skip confirmation on tool calls)",
    "无参数 —": "No parameters —",
    "参数": "Parameter",
    "类型": "Type",
    "必填": "Required",
    "说明": "Description",
    "（无工具）": "(No tools)",
    "尚未配置任何 MCP 服务。点「+ 新增 MCP 服务」开始。": "No MCP services configured yet. Click \"+ Add MCP service\" to start.",
    "删除该 MCP 服务？": "Delete this MCP service?",
    "stdio (子进程)": "stdio (subprocess)",
    "sse (远程)": "sse (remote)",
    "命令": "Command",
    "参数(空格分隔)": "Args (space-separated)",
    "名称只能用小写字母/数字/连字符": "Name can only use lowercase letters/digits/hyphens",
    "缓存管理": "Cache",
    "统一配置": "General",
    "程序信息": "About",
    "开发者工具": "Developer Tools",
    "开发工具": "Dev Tools",
    "Bug 反馈": "Feedback",
    "版本更新": "Updates",
    "搜索设置项…": "Search settings…",
    "统一设置": "General",
    "影响所有供应商的全局行为。": "Global behavior across all providers.",
    "界面语言": "Language",
    "跟随系统": "Follow system",
    "切换立即生效；个别动态文案会在下次刷新后完全生效。": "Takes effect immediately; a few dynamic strings finish updating on the next refresh.",
    "Ribbon 入口位置": "Ribbon tab position",
    "开始之前（默认）": "Before Home (default)",
    "开始之后": "After Home",
    "选项卡末尾": "End of tabs",
    "更改后需重启 WPS 才能生效，适用于所有 Office 组件。": "Restart WPS to apply this change across all Office apps.",
    "无法读取 Ribbon 入口位置，请检查本地服务。": "Could not load the Ribbon position. Check the local service.",
    "Ribbon 入口位置已保存，重启 WPS 后生效。": "Ribbon position saved. Restart WPS to apply it.",
    "保存 Ribbon 入口位置失败，请检查本地服务并重新打开设置。": "Could not save the Ribbon position. Check the local service and reopen settings.",
    "系统提示词": "System prompt",
    "重置默认": "Reset to default",
    "恢复为默认提示词": "Restore the default prompt",
    "工具调用次数上限": "Max tool calls per conversation",
    "默认生图比例": "Default image aspect ratio",
    "自动（由 AI 按提示词和场景判断）": "Auto (AI decides from the prompt & context)",
    "显示工具调用详情（开发者日志）": "Show tool call details (developer log)",
    "启用的 Office 组件": "Enabled Office apps",
    "Word（文字）": "Word (Writer)",
    "Excel（表格）": "Excel (Spreadsheets)",
    "PPT（演示）": "PowerPoint (Presentation)",
    "重启 WPS": "Restart WPS",
    "后生效。": "to take effect.",
    "导出配置 JSON": "Export config JSON",
    "导入配置 JSON": "Import config JSON",
    "从 JSON 文件导入配置": "Import configuration from a JSON file",
    "导出当前配置（含 API Key，注意不要外发）": "Export current config (contains API keys — do not share)",
    "导出诊断包": "Export diagnostics",
    "诊断包": "Diagnostics",
    "设备 SN": "Device SN",
    "最近检查": "Last check",
    "最近错误": "Last error",
    "未检查": "Not checked",
    "未启用": "Disabled",
    "立即检查": "Check now",
    "启动时自动检查": "Check automatically on startup",
    "下载并安装": "Download & install",
    "最新版本": "Latest version",
    "版本": "Version",
    "客户端配置": "Client config",
    "复制配置": "Copy config",
    "复制地址": "Copy address",
    "调用日志": "Call log",
    "已注册工具数": "Registered tools",
    "已暴露的工具": "Exposed tools",
    "最近外部调用": "Recent external calls",
    "服务配置": "Service config",
    "启用统一样式": "Enable unified style",
    "换 token": "Exchange token",

    // Token 消耗
    "时间范围": "Time range",
    "近 7 天": "Last 7 days",
    "近 30 天": "Last 30 days",
    "按日": "By day",
    "按模型": "By model",
    "按日总量": "Daily total",
    "模型占比": "By model share",
    "时间趋势": "Trend",
    "总计 —": "Total —",
    "本次用：": "This turn: ",

    // 素材库
    "生图历史会自动保存到这里，选中素材后可插入当前文档。": "Generated images are saved here automatically; select one to insert it into the document.",
    "暂无生图历史。用「AI 生成图片」生成后，会自动保存到这里。": "No images yet. Generate one with \"AI image\" and it will show up here.",
    "搜索提示词 / 标签 / 项目…": "Search prompts / tags / projects…",
    "全部项目": "All projects",
    "按项目筛选": "Filter by project",
    "未选择素材": "No asset selected",
    "素材预览": "Asset preview",
    "插入当前文档": "Insert into document",
    "插入到末尾": "Insert at end",
    "导入本地图片": "Import local image",
    "从本地导入图片到素材库": "Import a local image into the asset library",
    "未记录提示词": "No prompt recorded",
    "智能抠图": "Smart cutout",
    "本地模型抠图": "Local cutout",
    "画笔编辑": "Brush edit",
    "画笔": "Brush",
    "画布": "Canvas",
    "裁剪": "Crop",
    "取消裁剪": "Cancel crop",
    "裁剪并存素材": "Crop & save",
    "整张去背景": "Remove background",
    "抠出涂抹主体": "Cut out brushed area",
    "涂抹处重绘": "Inpaint brushed area",
    "清除涂抹": "Clear brush",
    "按描述抠图": "Cut out by description",
    "选择抠图方式": "Choose cutout method",
    "重绘提示词": "Inpaint prompt",
    "需要保留的部分": "What to keep",
    "生成图片": "Generate image",
    "移动到分组": "Move to group",
    "新建分组": "New group",
    "取消全选": "Deselect all",
    "删除未勾选": "Delete unchecked",

    // 改动记录
    "暂无改动记录。让 AI 帮你做点什么，这里就会显示。": "No changes yet. Ask the AI to do something and it will show up here.",
    "每条记录关联到具体的磁盘文件，只显示当前打开文件的记录。": "Each record is tied to a file on disk; only records for the currently open file are shown.",
    "改动详情": "Change details",
    "查看历史": "View history",
    "重新读取历史": "Reload history",

    // 历史 / 其它
    "历史 (0)": "History (0)",
    "我的历史": "My history",
    "缓存历史（最新 20 条）": "Cache history (latest 20)",

    // 生图弹窗补充
    "备注：当前生图能力仅支持": "Note: image generation currently only supports",
    "模型。": "models.",

    // PDF / 其它次要入口
    "大纲生成 PPT": "Outline → Slides",
    "从当前 PPT 提取": "Extract from current deck",
    "从当前 PPT 提取大纲": "Extract outline from current deck",
    "生成 PPT": "Generate slides",
    "统一 PPT 风格": "Unify deck style",
    "统一修改": "Batch edit",
    "执行统一": "Apply to all",
    "PPT 风格预设": "Deck Style Preset",
    "模板画廊": "Template Gallery",
    "HTML 模板预览": "HTML Template Preview",
    "推荐版式": "Suggested layouts",
    "主题预设": "Theme presets",
    "主题模板（可选）": "Theme template (optional)",
    "字重": "Font weight",
    "字号 px": "Font size px",
    "标题字体": "Title font",
    "标题字号": "Title size",
    "标题加粗": "Bold title",
    "标题颜色": "Title color",
    "正文字体": "Body font",
    "正文字号": "Body size",
    "正文颜色": "Body color",
    "文字颜色": "Text color",
    "文字内容": "Text content",
    "主色": "Primary color",
    "次色": "Secondary color",
    "强调色": "Accent color",
    "卡片底色": "Card background",
    "幻灯片底色": "Slide background",
    "标志元素": "Signature element",
    "自定义": "Custom",
    "描述（可选）": "Description (optional)",
    "组件": "Components",
    "选用组件": "Pick components",
    "保存到组件库": "Save to component library",
    "保存当前预览为组件": "Save current preview as a component",
    "整页存为组件": "Save whole page as component",
    "AI从当前页提取组件": "Extract components from this page",
    "编辑模式": "Edit mode",
    "编辑元素": "Edit element",
    "美化当前": "Beautify current",
    "自动配图（按页内容判断是否需要；要求已启用图像生成）": "Auto-illustrate (per-page judgement; requires image generation enabled)",

    // 服务状态 / 缓存
    "内存 —": "Memory —",
    "共 0 条": "0 items",
    "启用自动清理": "Enable auto-clean",
    "清空缓存": "Clear cache",
    "清可缓存项": "Clear cacheable items",
    "可安全缓存项超": "When safe-to-cache items exceed",
    "总缓存超": "When total cache exceeds",
    "MB 自动清": "MB, auto-clean",
    "天自动清": "days, auto-clean",
    "清零": "Reset",
    "脚本版本: —": "Script version: —",
    "重扫 localStorage + proxy 侧缓存": "Rescan localStorage + proxy-side cache",
    "重新读取 localStorage": "Reload localStorage",

    // Bug 反馈
    "遇到问题？欢迎加入粉丝群反馈！": "Ran into a problem? Join the community group to report it!",
    "微信扫码关注公众号": "Scan the QR code on WeChat to follow us",
    "扫描下方二维码，关注公众号": "Scan the QR code below to follow the official account",
    "在公众号内发送": "Send in the official account",
    "，即可获取进群链接": "to get the group invite link",
    "进群后描述问题，附上截图更有帮助": "Describe the issue in the group — screenshots help a lot",
    "基本信息": "Basics",

    // 对话框通用
    "保存当前修改，窗口保持打开继续配置": "Save changes and keep this window open",
    "已保存。请点窗口右上角 × 关闭。": "Saved. Close this window with the × in the corner.",

    // 动态 JS 高频（app.js 里 t() / 精确匹配都会命中）
    "已按预览排版替换全文。": "Document replaced with the formatted preview.",
    "已按预览排版替换选中区域。": "Selection replaced with the formatted preview.",
    "AI 排版预览已生成。": "Formatting preview generated.",
    "正在替换全文…": "Replacing document…",
    "正在替换选中区域…": "Replacing selection…",
    "正在获取模型列表...": "Fetching model list…",
    "已提交替换任务。": "Replace task submitted.",
    "当前文档没有可排版的正文。": "No formattable body text in this document.",
    "选中区域没有可排版的正文。": "No formattable text in the selection.",
    "已切换排版范围，点「开始排版」重新生成预览。": "Scope changed — click \"Format now\" to regenerate the preview.",
    "填写排版要求（或留空让 AI 自动识别），点「开始排版」生成预览。": "Enter requirements (or leave empty for auto-detection), then click \"Format now\".",
    "AI 正在处理，请先点「停止」或等待本轮完成。": "AI is busy — click Stop or wait for this turn to finish.",

    // 快捷指令 / ribbon 按钮（getLabel 回调与面板快捷 chip 共用）
    "打开文小舟": "Open Wenxiaozhou",
    "帮我写": "Help me write",
    "续写": "Continue writing",
    "扩写": "Expand",
    "缩写": "Condense",
    "重写": "Rewrite",
    "快速润色": "Quick polish",
    "优化": "Optimize",
    "更正式": "More formal",
    "更学术": "More academic",
    "党政风": "Official style",
    "更活泼": "More lively",
    "口语化": "Conversational",
    "全文润色": "Polish document",
    "翻译选中": "Translate selection",
    "全文总结": "Summarize document",
    "文档脑图": "Mind map",
    "AI 排版": "AI Format",
    "AI 生成图片": "AI image",
    "帮我改": "Help me edit",
    "AI 检查校对": "AI proofread",
    "智能推荐操作": "Smart suggestions",
    "文档问答": "Document Q&A",
    "PDF 问答": "PDF Q&A",
    "解释公式": "Explain formula",
    "解释数据": "Explain data",
    "删除空白行": "Delete blank rows",
    "合并相同相邻单元格": "Merge identical cells",
    "自动调整行列宽": "Auto-fit rows & columns",
    "表格美化样式": "Table styling",
    "全部居中对齐": "Center align all",
    "AI 生成 PPT": "AI slides",
    "AI 生成单页": "Generate one slide",
    "AI 生成多页": "Generate multiple slides",
    "AI 生成封面": "Generate cover",
    "AI 演讲稿": "AI speaker notes",
    "这页演讲稿": "Notes for this slide",
    "解释这页": "Explain this slide",
    "简化这页": "Simplify this slide",
    "润色": "Polish",
    "PPT 风格": "Deck style",
    "统一风格": "Unify style",
    "去 AI 味": "De-AI tone",
    // ribbon 分组
    "写作": "Writing",
    "翻译": "Translate",
    "文档": "Document",
    "图像": "Image",
    "生成": "Generate",
    "改写": "Rewrite",
    "校对": "Proofread",
    "美化": "Beautify",
    "数据": "Data",
    "智能": "Smart",
    "其他": "Other",

    // 设置卡片（JS 渲染）
    "显示名称": "Display name",
    "默认模型": "Default model",
    "部署名（可选）": "Deployment (optional)",
    "留空则用默认模型作部署名": "Leave blank to use the default model as the deployment name",
    "启用": "Enable",
    "图像生成": "Image Generation",
    "测试此渠道（拉取模型列表）": "Test this channel (fetch model list)",
    "从下拉选中即填进左侧输入框。可手动输入未列出的模型。": "Pick one from the dropdown to fill the input; you can also type an unlisted model.",
    "点右上角 ⚡ 测试渠道后，这里会出现“模型下拉”。": "Click the ⚡ test button first — a model dropdown will appear here.",

    "界面语言已切换；Ribbon 按钮文字将在重启 WPS 后切换。": "Language switched. Ribbon button labels will update after restarting WPS.",

    // 选区预览弹窗（翻译/改写/总结/优化）运行时文案
    "翻译要求": "Translation requirements",
    "改写要求": "Rewrite requirements",
    "总结要求": "Summary requirements",
    "优化要求": "Optimization requirements",
    "可选。比如：保留专业术语、使用商务书面语、人名不翻译。": "Optional. E.g.: keep terminology, business register, don't translate names.",
    "已预设「{tone}」要求，可在这里追加补充（如：保留专有名词、控制在 300 字以内）。": "The \"{tone}\" instruction is preset; add extras here (e.g. keep proper nouns, under 300 words).",
    "可选。比如：每个要点不超过 20 字 / 只关注关键数据 / 加结论判断。": "Optional. E.g.: each point under 20 chars / key data only / add a conclusion.",
    "可选。比如：更正式、更简洁、更有逻辑、保留原意。": "Optional. E.g.: more formal, more concise, better logic, keep the meaning.",

    // AI 操作跟随提示
    "AI 操作跟随提示": "Follow AI edits",
    "AI 修改文档时，Word 里视图滚动跟随改动位置、Excel 里选中改动区域，直观看到 AI 在动哪里。不改任何格式；不想被打断阅读视线可关闭。": "While the AI edits, Word scrolls to the change location and Excel selects the edited range so you can see where the AI is working. No formatting is touched; turn off if it disrupts your reading.",

    // 排版模板
    "排版模板": "Format template",
    "通用": "General",
    "合同": "Contract",
    "公文": "Official document",
    "论文": "Academic paper",
    "通知公告": "Notice",
    "新建": "New",
    "编辑": "Edit",
    "副本": "copy",
    "自定义排版模板": "Custom Format Template",
    "模板名称": "Template name",
    "标题示例": "Sample Title",
    "一、一级标题示例": "1. Sample Heading",
    "正文段落示例：本合同双方本着平等自愿的原则，经友好协商达成如下条款。": "Sample body paragraph: both parties, on the principle of equality and free will, agree to the following terms.",
    "副标题": "Subtitle",
    "一级标题": "Heading 1",
    "二级标题": "Heading 2",
    "三级标题": "Heading 3",
    "正文": "Body",
    "引用": "Quote",
    "字号": "Size",
    "加粗": "Bold",
    "对齐": "Align",
    "左": "Left",
    "居中": "Center",
    "右": "Right",
    "默认": "Default",
    "正文行距": "Body line spacing",
    "正文首行缩进（字符）": "Body first-line indent (chars)",
    "默认排版要求（选中模板时自动填入，可再修改）": "Default requirements (auto-filled when the template is selected; editable)",
    "基于当前模板复制一份自定义模板": "Duplicate the current template as a custom one",
    "编辑自定义模板（内置模板请先「新建」复制）": "Edit custom template (duplicate a built-in first via New)",
    "删除自定义模板": "Delete custom template",
    "请填写模板名称。": "Enter a template name.",
    "模板保存失败。": "Failed to save the template.",
    "模板已保存。": "Template saved.",
    "确定删除排版模板「{name}」？": "Delete format template \"{name}\"?",
    "查看完整示例": "View full sample",
    "排版示例": "Format Sample",
    "点击放大查看完整示例": "Click to view the full sample",
    "弹窗查看该模板的完整排版示例": "Open a full formatting sample of this template",
    "房屋租赁合同": "Residential Lease Agreement",
    "合同编号：LX-2026-0001": "Contract No.: LX-2026-0001",
    "一、双方基本信息": "1. Parties",
    "出租方（甲方）与承租方（乙方）本着平等自愿、协商一致的原则，就房屋租赁事宜达成如下协议，双方共同遵守执行。": "The lessor (Party A) and the lessee (Party B), on the principle of equality and mutual agreement, enter into the following lease agreement to be observed by both parties.",
    "（一）租赁物业": "(1) Leased premises",
    "甲方将位于示例市示例区示例路 88 号的房屋出租给乙方使用，建筑面积约 120 平方米，用途为办公。": "Party A leases to Party B the premises at 88 Sample Road, Sample District, with a floor area of about 120 m², for office use.",
    "租赁期限：自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止": "Term: from Jan 1, 2026 to Dec 31, 2026",
    "月租金：人民币壹万元整（¥10,000.00）": "Monthly rent: RMB 10,000.00",
    "付款方式：季付，每期提前 7 日支付": "Payment: quarterly, 7 days in advance",
    "（二）双方权利义务": "(2) Rights and obligations",
    "乙方应按约定用途使用房屋，未经甲方书面同意不得转租、转借或改变房屋结构。": "Party B shall use the premises as agreed and shall not sublet, lend, or alter the structure without Party A's written consent.",
    "提示：本页为排版样式示例，展示各级标题、正文、列表与引用在该模板下的实际效果。": "Note: this page is a formatting sample showing headings, body text, lists and quotes under this template.",
    "附：签署栏": "Appendix: Signatures",
    "甲方（签章）：____________　乙方（签章）：____________　日期：____年__月__日": "Party A (seal): ____________  Party B (seal): ____________  Date: ____-__-__",
    // 通用示例（工作报告）
    "2026 年第一季度工作报告": "Q1 2026 Work Report",
    "产品研发部 · 2026 年 4 月": "Product R&D Dept · April 2026",
    "一、总体进展": "1. Overall Progress",
    "本季度围绕年度目标推进各项工作，核心项目按计划交付，关键指标完成率 96%，团队整体运转平稳。": "This quarter we advanced all workstreams toward the annual goals; core projects shipped on schedule with 96% of key metrics met.",
    "1.1 重点项目": "1.1 Key Projects",
    "新版客户端如期发布，上线两周活跃用户提升 18%；数据平台二期完成主体开发，进入联调阶段。": "The new client shipped on time — active users rose 18% within two weeks; data platform phase 2 finished main development and entered integration testing.",
    "客户端 2.0：3 月 15 日发布，崩溃率降至 0.1% 以下": "Client 2.0: released Mar 15, crash rate below 0.1%",
    "数据平台二期：完成度 80%，预计 5 月上线": "Data platform phase 2: 80% complete, launching in May",
    "自动化测试覆盖率：从 45% 提升到 68%": "Automated test coverage: up from 45% to 68%",
    "1.2 存在问题": "1.2 Issues",
    "跨部门协作排期冲突较多，部分需求交付延后一周左右，需要在下季度建立更明确的优先级机制。": "Cross-team scheduling conflicts delayed some deliverables by about a week; a clearer prioritization mechanism is needed next quarter.",
    "二、下季度计划": "2. Next Quarter Plan",
    "聚焦数据平台上线与客户端性能优化，同步启动年度中期复盘。": "Focus on the data platform launch and client performance, and kick off the mid-year review.",
    // 公文示例
    "关于开展 2026 年度安全生产检查工作的通知": "Notice on the 2026 Annual Work-Safety Inspection",
    "示例字〔2026〕12 号": "Ref. [2026] No. 12",
    "各部门、各下属单位：": "To all departments and subsidiaries:",
    "为进一步落实安全生产责任制，防范化解各类安全风险，经研究决定，在全系统范围内开展年度安全生产检查工作。现将有关事项通知如下：": "To further implement the work-safety responsibility system and mitigate safety risks, it has been decided to conduct the annual work-safety inspection across the organization. Relevant matters are hereby notified as follows:",
    "一、总体要求": "I. General Requirements",
    "坚持问题导向和底线思维，聚焦重点领域和关键环节，做到全覆盖、零容忍、严执法、重实效。": "Stay problem-oriented, focus on key areas and critical links, and ensure full coverage, zero tolerance, strict enforcement and real results.",
    "（一）检查范围": "(1) Scope",
    "覆盖办公场所、生产车间、仓储库房及在建项目工地，重点核查消防设施、用电安全与应急预案落实情况。": "Covers offices, workshops, warehouses and construction sites, focusing on fire-safety equipment, electrical safety and emergency plans.",
    "二、时间安排": "II. Schedule",
    "自查阶段：5 月 10 日至 5 月 20 日": "Self-inspection: May 10–20",
    "集中检查：5 月 21 日至 6 月 10 日": "Centralized inspection: May 21 – June 10",
    "整改复查：6 月 11 日至 6 月 30 日": "Rectification review: June 11–30",
    "请各单位高度重视，认真组织实施，确保检查工作取得实效。": "All units shall attach great importance to this work and organize it carefully to ensure effective results.",
    "示例集团安全生产委员会　　2026 年 5 月 6 日": "Sample Group Work-Safety Committee    May 6, 2026",
    // 论文示例
    "基于深度学习的中文文本自动摘要方法研究": "Research on Deep-Learning-Based Automatic Summarization of Chinese Text",
    "摘要：针对长文本摘要中信息冗余与关键信息丢失问题，本文提出一种融合注意力机制的分层摘要模型。": "Abstract: Addressing redundancy and key-information loss in long-document summarization, this paper proposes a hierarchical model with attention.",
    "1 引言": "1 Introduction",
    "随着信息量的爆炸式增长，自动文本摘要成为自然语言处理领域的重要研究方向。现有方法在长文档场景下仍存在语义连贯性不足的问题。": "With the explosive growth of information, automatic summarization has become an important NLP research direction; existing methods still lack coherence on long documents.",
    "1.1 研究现状": "1.1 Related Status",
    "抽取式方法直接选取原文关键句，忠实度高但连贯性差；生成式方法可产生流畅摘要，但易出现事实性错误。": "Extractive methods select key sentences — faithful but less coherent; abstractive methods produce fluent summaries but are prone to factual errors.",
    "1.2 本文贡献": "1.2 Contributions",
    "提出分层编码结构，兼顾句级与篇章级语义": "A hierarchical encoder capturing both sentence- and discourse-level semantics",
    "设计事实一致性约束，显著降低幻觉率": "A factual-consistency constraint that significantly reduces hallucination",
    "在两个公开数据集上取得当前最优结果": "State-of-the-art results on two public datasets",
    "2 相关工作": "2 Related Work",
    "早期研究以统计特征为主，近年来预训练语言模型成为主流范式，其表示能力大幅提升了摘要质量。": "Early studies relied on statistical features; pre-trained language models have since become the dominant paradigm and greatly improved summary quality.",
    "注：本页为排版样式示例，正文内容仅用于展示模板效果。": "Note: this page is a formatting sample; the content is for style demonstration only.",
    // 通知公告示例
    "关于 2026 年国庆节放假安排的通知": "Notice on the 2026 National Day Holiday Schedule",
    "全体员工：": "To all staff:",
    "根据国家法定节假日安排，结合公司实际情况，现将 2026 年国庆节放假事宜通知如下：": "In line with statutory holiday arrangements and company circumstances, the 2026 National Day holiday is arranged as follows:",
    "一、放假安排": "I. Holiday Schedule",
    "放假时间：10 月 1 日（周四）至 10 月 7 日（周三），共 7 天": "Holiday: Oct 1 (Thu) – Oct 7 (Wed), 7 days",
    "9 月 27 日（周日）、10 月 10 日（周六）正常上班": "Work as usual on Sep 27 (Sun) and Oct 10 (Sat)",
    "值班人员安排另行通知": "On-duty arrangements will be announced separately",
    "二、注意事项": "II. Notes",
    "请各部门提前做好工作交接与安全检查，离开办公室前关闭电源与门窗；节日期间保持通讯畅通。": "Please complete handovers and safety checks in advance, switch off power and close windows before leaving, and stay reachable during the holiday.",
    "提示：本页为排版样式示例，展示标题、正文与列表在该模板下的实际效果。": "Note: this page is a formatting sample showing titles, body text and lists under this template.",
    "示例科技有限公司人事行政部　　2026 年 9 月 25 日": "Sample Tech Co., HR & Admin Dept    Sep 25, 2026",

    // 聊天进度状态词
    "生成回复": "Generating",
    "执行工具": "Running tool",
    "重试中": "Retrying",
    "重试": "Retry",
    "完成": "Done",

    // 思考强度档位（header 🧠 chip）
    "关": "Off",
    "低": "Low",
    "中": "Medium",
    "高": "High",

    // ShowDialog 原生窗口标题后缀
    "排版预览": "Formatting Preview",
    "文档报告": "Document report",

    // 聊天页 / 弹窗动态文案
    "工具调用中": "Calling tool",
    "已完成": "Done",
    "生成中…": "Generating…",
    "翻译中…": "Translating…",
    "正在渲染…": "Rendering…",
    "AI 提取中…": "Extracting…",
    "AI 输出解析失败，已生成本地规则预览。": "Failed to parse AI output — a local rule-based preview was generated instead.",
    "AI 整套 PPT 生成中": "Generating full deck",
    "↶ 恢复本轮": "↶ Undo this turn",
    "恢复中...": "Restoring…",
    "保存中...": "Saving…",
    "下载中…": "Downloading…",
    "解压中…": "Extracting…",
    "刷新中…": "Refreshing…",
    "取消抠图": "Cancel cutout",
    "已开启，未连接": "Enabled, not connected",
    "已连接 ✓": "Connected ✓",
    "已是最新": "Up to date",
    "有新版本": "Update available",
    "查看": "View",
    "无法预览": "Preview unavailable",
    "模块未加载": "Module not loaded",
    "插入光标处": "Insert at cursor",
    "插入到幻灯片": "Insert into slide",
    "提取组件": "Extract components",
    "清空所有历史": "Clear all history",
    "清空所有组件": "Clear all components",
    "从右侧历史里挑一条预览或编辑": "Pick an item from the history on the right to preview or edit",
    "暂无历史。生成一次 HTML 模板就会自动保存到这里。": "No history yet. Render an HTML template once and it will be saved here.",
    // ==== 全量扫描补翻（弹窗标题 / 提示 tips / 占位符示例 / 宿主标题等） ====
    ".pptx / .thmx / .potx 本地路径": "Local .pptx / .thmx / .potx path",
    "16:9 横向": "16:9 landscape",
    "1:1 方形": "1:1 square",
    "21:9 超宽": "21:9 ultra-wide",
    "300 细": "300 Light",
    "400 常规": "400 Regular",
    "700 粗": "700 Bold",
    "900 黑": "900 Black",
    "9:16 竖向": "9:16 portrait",
    "HTML 模板插入 PPT 时分图层（实验）": "Split layers when inserting HTML templates into slides (experimental)",
    "MCP 服务区域": "MCP server section",
    "OpenAI 兼容": "OpenAI-compatible",
    "Token 时间趋势": "Token trend",
    "Token 模型占比": "Tokens by model",
    "WPS Office 加载项 · 多 provider AI 写作助手": "WPS Office add-in · multi-provider AI writing assistant",
    "stable=正式 / canary=灰度": "stable = release / canary = preview",
    "· 全局换色 ——「所有背景换成深海军蓝」": "· Recolor globally — \"make all backgrounds deep navy\"",
    "· 切排版 ——「换成有图标的网格」「改成大数字版式」": "· Switch layout — \"use a grid with icons\" \"big-number layout\"",
    "· 复用组件 —— 点上方「选用组件」挑几个，让 AI 在新页里组合它们": "· Reuse components — pick some via \"Pick components\" above and let the AI combine them",
    "· 字体统一 ——「标题字号统一加大到 80px」": "· Unify fonts — \"bump all title sizes to 80px\"",
    "· 改文字 ——「标题改短」「数字换成 73%」": "· Edit text — \"shorten the title\" \"change the number to 73%\"",
    "· 整体美化 ——「美化排版」「更专业」": "· Beautify — \"polish the layout\" \"more professional\"",
    "· 装饰统一 ——「每页顶部加 4px 渐变条」": "· Unify decoration — \"add a 4px gradient bar on top of every slide\"",
    "· 调配色 ——「换成深色背景」「主色改成蓝色」": "· Adjust colors — \"dark background\" \"make the primary color blue\"",
    "· 风格收敛 ——「整套都更商务一点，去掉花哨装饰」": "· Converge style — \"make the whole deck more corporate, drop the flashy bits\"",
    "⚠ 每条历史都会被 AI 单独处理一次，可能慢；会自动跳过 freeform 之外的固定布局（它们的 data 跟 schema 绑死）。": "⚠ Each history item is processed by the AI separately and may be slow; fixed layouts other than freeform are skipped automatically (their data is bound to the schema).",
    "一句话说明这个组件是什么时候用、有什么特点。AI 在新页面挑组件时会读这段。": "One sentence on when to use this component and what makes it special — the AI reads this when picking components for a new slide.",
    "一条指令应用到所有历史幻灯片（Enter 发送）": "One instruction applied to all history slides (Enter to send)",
    "一次对话允许 AI 连续调用工具的最多次数（默认 150）。复杂任务如「AI 生成 10 页 PPT」可能需要 80-150；过低会中途报错\"达到上限\"。": "Max consecutive tool calls per conversation (default 150). Complex tasks like a 10-slide deck may need 80–150; too low fails midway with \"limit reached\".",
    "临时切换模型": "Temporary model",
    "主题预设网格": "Theme preset grid",
    "仅 WARN": "WARN only",
    "仅在 freeform 布局下可用；非 freeform 的固定布局是 schema 化的，已经天然可复用。": "Freeform layouts only; fixed layouts are schema-based and inherently reusable.",
    "仅开发环境可见。生产环境（永久安装 / GUI 安装包）自动隐藏。": "Visible in dev environments only; hidden automatically in production installs.",
    "从 .md / .txt 文件导入自定义技能": "Import a custom skill from .md / .txt",
    "从云端（OSS）目录拉取最新技能": "Fetch the latest skills from the cloud (OSS)",
    "你正在使用灰度版本，遇到问题可去「设置 → 程序信息」查看 / 回退": "You're on a canary build — see Settings → About to review or roll back",
    "例如：左边的人物、中间的产品、前景的花束": "e.g. the person on the left, the product in the middle, the bouquet in front",
    "例如：把当前选区内容润色得更专业": "e.g. polish the selected text to sound more professional",
    "保存为组件": "Save as component",
    "修改要求可以留空，AI 会按默认规则处理。": "Requirements can be left empty — the AI follows default rules.",
    "兜底默认比例：当单次生图没指定比例时用它。生图弹窗里为单次单独选的比例优先级更高。留「自动」则维持原逻辑（AI 按上下文判断）。": "Fallback aspect ratio when a generation doesn't specify one. The per-run ratio in the image dialog takes priority. Leave on Auto to let the AI decide from context.",
    "全部保留": "Keep all",
    "勾选启用的技能会自动追加到 AI 的系统提示，针对特定场景给 AI 更精准的指令。支持导入 .md / .txt 自定义技能。": "Enabled skills are appended to the AI system prompt for more precise instructions in specific scenarios. Custom .md / .txt skills can be imported.",
    "双击显示设备 SN": "Double-click to show device SN",
    "只使用本地模型去背景，输出透明 PNG，不调用 AI 图像接口": "Local background removal only — outputs a transparent PNG without calling any AI image API",
    "只对当前预览生效（Enter 发送）": "Applies to the current preview only (Enter to send)",
    "可选。比如：更正式、保留专业术语、语气更自然。": "Optional. E.g.: more formal, keep terminology, more natural tone.",
    "复制 SN，发给管理员加灰度白名单": "Copy the SN and send it to the admin to join the canary allowlist",
    "复制全部日志到剪贴板": "Copy all logs to clipboard",
    "外部 agent（Claude Code CLI / MCP 客户端）最近通过 MCP 调用了哪些工具、成功与否、耗时多久。最多保留 50 条。": "Recent MCP tool calls from external agents (Claude Code CLI / MCP clients): success, duration. Keeps the latest 50.",
    "如：把涂抹处改成红色气球；抠图可留空": "e.g. turn the brushed area into a red balloon; leave empty for plain cutout",
    "如：指标卡网格 / 完成清单 / 团队介绍卡": "e.g. metric card grid / checklist / team intro card",
    "导出预览日志": "Export preview logs",
    "导出预览渲染全链路日志，用于排查空白预览等问题": "Export the full preview rendering log for diagnosing blank previews etc.",
    "属性": "Properties",
    "幻灯片预览": "Slide preview",
    "开启后插件会向 proxy-server.js 注册当前宿主可用的工具，并通过长轮询接收外部 agent 的调用请求。": "When enabled, the add-in registers the current host's tools with proxy-server.js and receives external agent calls via long polling.",
    "开启图层编辑模式：点击任意元素 → 虚线选中 → 拖动 / 编辑 / 删除 / 存为组件": "Layer edit mode: click any element → dashed selection → drag / edit / delete / save as component",
    "开始执行": "Start",
    "开始生成…": "Generating…",
    "弹窗查看最新日志，无需下载 txt": "View the latest logs in a popup, no file download needed",
    "当前加载的 app.js 版本号，重载后刷新这里来确认新代码已加载": "Version of the loaded app.js — refresh after a reload to confirm new code is live",
    "把大纲贴进来（markdown 格式：# 一级标题 / ## 二级标题 / - 要点）。AI 会按一级标题分页生成。": "Paste your outline (markdown: # H1 / ## H2 / - bullets). The AI generates one slide per H1.",
    "把当前 PPT 的大纲贴进来（或点「从当前 PPT 提取」自动填）。AI 会：①应用风格预设；②按每页文字判断是否需要配图，需要就生成并插入；③加 fade 切换动画；④自检空白页。": "Paste the current deck's outline (or click \"Extract from current deck\"). The AI will: ① apply the style preset; ② illustrate pages that need it; ③ add fade transitions; ④ self-check for blank slides.",
    "把当前宿主可用的 WPS 工具通过 Model Context Protocol 暴露给外部 agent（Claude Code CLI / Claude Desktop / Cursor 等）。需要 proxy-server.js 正在运行。": "Exposes the current host's WPS tools to external agents (Claude Code CLI / Claude Desktop / Cursor) via the Model Context Protocol. Requires proxy-server.js running.",
    "把整张 freeform 幻灯片的 HTML+CSS 存为一个大组件（适合整页模板）": "Save the whole freeform slide's HTML+CSS as one big component (good for full-page templates)",
    "把未勾选的组件从库里删掉": "Delete unchecked components from the library",
    "折叠中间轮次": "Fold middle turns",
    "挑主题会自动填字体，也可单独覆盖": "Picking a theme fills fonts automatically; each can be overridden",
    "挑选当前组件库里的组件，让 AI 在下一次美化时复用": "Pick components from the library for the AI to reuse in the next beautify pass",
    "控制 AI 的回答风格 / 格式 / 操作偏好。默认配了\"简洁直接、不堆 emoji、不带 AI 套话、直接调工具改文档\"等规则。留空则不追加，只用插件内置的最小提示。": "Controls the AI's answer style / format / behavior. Defaults to \"concise, no emoji spam, no AI clichés, edit the document via tools directly\". Leave empty to use only the built-in minimal prompt.",
    "搜索素材": "Search assets",
    "搜索设置": "Search settings",
    "撤销": "Undo",
    "支持的宿主": "Supported hosts",
    "支持配置多个生图渠道（toapis 异步任务 / Codex 桥接 sub2api / OpenAI 官方 / OpenRouter / Boogu 本地生图），同一时刻只能启用一个。AI 调用 generate_image 生成图片后用 wps_insert_image 插入文档。": "Multiple image channels can be configured (toapis async / Codex bridge sub2api / OpenAI official / OpenRouter / Boogu local); only one active at a time. The AI calls generate_image, then inserts via wps_insert_image.",
    "推理步数": "Steps",
    "默认分辨率": "Default resolution",
    "标清 768": "SD 768",
    "1K 1024（推荐）": "1K 1024 (recommended)",
    "1080p 1280": "1080p 1280",
    "2K 1536": "2K 1536",
    "超清 2048（慢/占显存）": "Ultra 2048 (slow / high VRAM)",
    "Boogu Image 本地服务（FastAPI），本地无需 API Key。默认分辨率决定图片整体大小（长边），生图时结合比例自动算出实际宽高并吸附到 512/768/1024/1280/1536/2048 档位；档位越大越慢、越占显存。Turbo 版推荐步数 4。": "Boogu Image local service (FastAPI) — no API key needed locally. The default resolution sets the overall image size (long edge); actual width/height are computed from it plus the aspect ratio and snapped to the 512/768/1024/1280/1536/2048 buckets — larger is slower and uses more VRAM. Turbo recommends 4 steps.",
    "该渠道只支持生成图片，不支持抠图 / 图像编辑": "This channel only generates images; it does not support cutout / image editing",
    "测试连通性": "Test connectivity",
    "「{name}」缺少 Base URL。": "\"{name}\" is missing a Base URL.",
    "正在测试「{name}」连通性…": "Testing \"{name}\" connectivity…",
    "「{name}」连通正常，服务已就绪{dev}。": "\"{name}\" is reachable and ready{dev}.",
    "「{name}」连不上（{err}）。请确认：① Boogu 服务已启动（start_api.ps1，窗口显示 Uvicorn running）；② Base URL 端口正确且未被其它程序占用。": "\"{name}\" is unreachable ({err}). Check that: ① the Boogu service is running (start_api.ps1 shows \"Uvicorn running\"); ② the Base URL port is correct and not taken by another program.",
    "改动会立即在预览里生效；最终通过左侧 footer 的「保存」入库。": "Changes apply to the preview immediately; save to the library via the footer Save button.",
    "新对话": "New conversation",
    "智能抠图：本地离线去背景（发丝级软边），结果存为新素材；本地不可用时回退 Codex 桥接 AI 抠图": "Smart cutout: local offline background removal (hair-level soft edges), saved as a new asset; falls back to Codex-bridge AI cutout when local is unavailable",
    "本次抽到的组件": "Extracted components",
    "本次抽取的组件": "Extracted components",
    "框选一块区域裁剪成新素材": "Drag-select an area to crop into a new asset",
    "模板画廊 — 浏览所有 HTML 幻灯片模板（有图片预览）": "Template gallery — browse all HTML slide templates (with image previews)",
    "正在生成预览…": "Generating preview…",
    "正在审校大纲…": "Reviewing the outline…",
    "批注校对": "Proofread (comments)",
    "对全文做批注式校对：错别字/语病/标点/逻辑问题直接以 Word 批注标在原文位置。": "Proofread the whole document — typos / grammar / punctuation / logic issues are marked as Word comments at their exact positions.",
    "校对还在进行中，请稍候。": "Proofreading is still running, please wait.",
    "校对模块未加载。": "Proofread module not loaded.",
    "正在校对全文（结果将以批注形式标注）…": "Proofreading the document (issues will be marked as comments)…",
    "校对完成：未发现明显问题。": "Proofreading finished: no obvious issues found.",
    "校对完成": "Proofreading finished",
    "处问题已加批注": "issues marked as comments",
    "块解析失败已跳过": "chunks failed and were skipped",
    "校对失败": "Proofreading failed",
    "已保存文档。": "Document saved.",
    "已跳转到第 {n} 页。": "Jumped to page {n}.",
    "调用了 {n} 个工具": "Called {n} tools",
    "调用了 {parts}": "Called {parts}",
    "{n} 个工具": "{n} tools",
    "{n} 个技能": "{n} skills",
    "{n} 个 MCP 工具": "{n} MCP tools",
    "保存技能": "Save skill",
    "已插入 {r}×{c} 表格。": "Inserted a {r}×{c} table.",
    "已撤销。": "Undone.",
    "已重做。": "Redone.",
    "已执行。": "Done.",
    "本地执行失败": "Local execution failed",
    "提示：当前模型已经调用了工具并拿到结果，但没有正确利用工具返回的数据来回答，而是在复述工具调用本身。这通常是模型的工具调用能力不足（常见于 7-9B 小模型）。建议换用工具调用能力更强的模型（如 Qwen2.5-14B 及以上、或云端模型）后重试。": "Note: the current model called a tool and got a result, but instead of using the returned data it just restated the tool call. This usually means the model's tool-calling ability is limited (common with 7-9B small models). Try a stronger tool-calling model (Qwen2.5-14B or larger, or a cloud model) and retry.",
    "合规检查": "Compliance check",
    "按检查清单核查全文，命中问题以 Word 批注标注并按高/中/低分级。": "Review the document against a checklist; findings are marked as Word comments graded high/medium/low.",
    "按检查清单核查全文，命中问题以 Word 批注标在原文位置（按高/中/低分级）。": "Review the document against a checklist — findings are marked as Word comments at their exact positions, graded high/medium/low.",
    "检查清单（一行一条）": "Checklist (one rule per line)",
    "例如：\n合同金额必须同时有大写和小写\n必须明确违约责任条款\n不得出现「最终解释权归本公司」表述\n日期格式统一为 YYYY 年 MM 月 DD 日": "e.g.:\nContract amounts must appear in both words and figures\nLiability clauses must be explicit\n\"Final interpretation rights\" wording is not allowed\nDates must use the YYYY-MM-DD format",
    "可以直接粘贴招标要求、审查要点或内部规范；AI 只报告能在正文中定位的问题。": "Paste tender requirements, review points or internal rules directly; the AI only reports issues it can locate in the text.",
    "开始检查": "Start check",
    "合规检查模块未加载。": "Compliance module not loaded.",
    "请先填写检查清单。": "Enter a checklist first.",
    "合规检查还在进行中，请稍候。": "Compliance check is still running, please wait.",
    "正在按清单核查全文（结果将以批注形式标注）…": "Reviewing the document against the checklist (findings will be marked as comments)…",
    "合规检查完成：未发现清单相关问题。": "Compliance check finished: no checklist-related issues found.",
    "合规检查完成": "Compliance check finished",
    "合规检查失败": "Compliance check failed",
    "导出为 Word 文件": "Export as Word file",
    "不动当前文档，把排版结果另存为新的 Word 文件": "Save the formatted result as a new Word file without touching the current document",
    "没有可导出的排版内容。": "No formatted content to export.",
    "HTML 渲染不可用。": "HTML rendering unavailable.",
    "文小舟 排版导出": "Wenxiaozhou Format Export",
    "已导出为 Word 文件": "Exported as Word file",
    "导出失败": "Export failed",
    "没有检测到画笔选区，可以描述要保留的主体，或直接整张去背景。": "No brush selection detected — describe what to keep, or remove the whole background.",
    "添加附件": "Add attachment",
    "粘贴文本 ({n} 行)": "Pasted text ({n} lines)",
    "粘贴文本 ({n} 字)": "Pasted text ({n} chars)",
    "{names}：不支持的文件类型，只能添加 图片 / PDF / 文本文件": "Unsupported file type: {names}. Only images / PDF / text files can be added",
    "附件 {name} 太大（>{cap}），不支持。": "Attachment {name} is too large (>{cap}), not supported.",
    "清空 WPS 演示里当前选中那一页的所有形状，再贴上预览结果": "Clear all shapes on the currently selected slide, then paste the preview result",
    "清空已积累的预览日志": "Clear accumulated preview logs",
    "清空本地生图历史": "Clear local image history",
    "清空预览日志": "Clear preview logs",
    "清预览中间态 / 版本检查 / 模型列表等安全缓存，不动设置和历史": "Clear safe caches (preview intermediates / version checks / model lists) without touching settings or history",
    "点击卡片直接套用；自定义改任意颜色后会切回\"自定义\"": "Click a card to apply; editing any color switches back to Custom",
    "用当前字体、字号、颜色即时渲染。": "Rendered live with the current font, size and colors.",
    "画笔涂抹框定主体后：抠出涂抹主体（本地离线）/ 涂抹处重绘（仅 Codex 桥接）": "After brushing over the subject: cut out the brushed area (local, offline) / inpaint the brushed area (Codex bridge only)",
    "看看哪些数据占了本地空间，选择性清除。橘色标记的组清了会丢历史 / 设置，需要重配。": "See what's taking up local space and clear selectively. Orange groups lose history / settings when cleared.",
    "程序信息区域": "About section",
    "纯净模式": "Pure mode",
    "给 AI 的全局指引（每轮对话都会附加在 system message 里）": "Global guidance for the AI (appended to the system message every turn)",
    "统计各模型消耗的 token。只在 provider 返回用量时记录；部分兼容网关不返回则不计入。": "Token usage per model. Recorded only when the provider returns usage; gateways that don't return it aren't counted.",
    "脱离": "Detach",
    "范围": "Scope",
    "要求": "Requirements",
    "覆盖保存当前预览到「我的历史」对应条目；没绑定就新建": "Overwrite-save the current preview to its My History entry; creates one if unbound",
    "解除文档锁定": "Unlock document",
    "让 AI **批量改\"我的历史\"全部幻灯片**：": "Let the AI batch-edit all slides in My History:",
    "让 AI 帮你改预览：": "Let the AI edit the preview:",
    "让 AI 扫一遍当前 freeform 幻灯片的 HTML/CSS，把里面的可复用视觉单元（指标卡、状态徽章、引言块等）逐个抽出来存入组件库": "Let the AI scan the current freeform slide's HTML/CSS and extract reusable visual units (metric cards, badges, quote blocks…) into the component library",
    "输入目标语言或风格，例如：繁体中文 / 商务英文": "Enter a target language or style, e.g. Traditional Chinese / business English",
    "过滤（按 tag / where / 关键词，不区分大小写）": "Filter (by tag / where / keyword, case-insensitive)",
    "选用组件（让 AI 在下次美化时把这些复用到当前页）": "Pick components (the AI reuses them on this slide in the next beautify pass)",
    "遇到问题时导出：版本 / 设置(脱敏) / 缓存占用 / SN / 最近日志。": "Export when something goes wrong: version / sanitized settings / cache usage / SN / recent logs.",
    "配色微调": "Color tweaks",
    "重做": "Redo",
    "附加当前 PDF": "Attach current PDF",
    "预览日志": "Preview logs",
    "风格预览": "Style preview",
    "默认关闭。开启后把 HTML 渲染拆成「背景 + 每个顶层元素一张」共 N 张图片插入 PPT，每张都是独立 shape，可在 PPT 里单独选中/移动/缩放。注意：layered 模式偶发\"slide 留白\"问题（all-layers-fail 时已自动 fallback 到单图）。关闭则整页只插一张大图（稳定路径）。": "Off by default. When on, the HTML render is split into background + one image per top-level element, inserted as N independent shapes, each selectable/movable/scalable in slides. Note: layered mode occasionally leaves blank slides (auto-falls back to a single image when all layers fail). Off = one big image per page (stable path).",
    "默认关闭：AI 调工具时只显示\"调用中\"的滚动提示，结果到达后自动消失，对话区只看到 AI 的最终回答。开启后保留每条调用 + 结果的折叠卡片（带完整 JSON），便于排查 AI 行为。": "Off by default: tool calls show only a transient calling indicator that disappears when results arrive. On: keep a collapsible card per call with full JSON for debugging.",
    "（AI 生成 PPT 时套用本预设）": "(applied when the AI generates slides)",
    "（不改）": "(unchanged)",
    "（仅含文本的元素才可编辑）": "(only text-only elements are editable)",
    "，每个卡是一张迷你幻灯片。": ", each card is a mini slide.",
    "WPS 文字 助手": "WPS Writer Assistant",
    "WPS 表格 助手": "WPS Spreadsheet Assistant",
    "WPS 演示 助手": "WPS Presentation Assistant",
    "WPS PDF 助手": "WPS PDF Assistant",
    "对话让 AI 读写文档；顶部 ribbon 写作 / 润色 / 翻译 / 文档 / 图像 6 组快捷入口": "Chat to let the AI read & edit the document; the ribbon offers 6 quick-action groups (writing / polish / translate / document / image)",
    "对话让 AI 读写单元格、行列、工作表；顶部 ribbon 美化 / 数据 / 智能 3 组快捷入口": "Chat to let the AI edit cells, rows/columns and sheets; the ribbon offers 3 quick-action groups (beautify / data / smart)",
    "对话让 AI 读写幻灯片；顶部 ribbon 生成 / 改写 / 校对 4 组快捷入口；「PPT 风格」按钮设置统一样式，「大纲生成 PPT」打开大纲弹窗": "Chat to let the AI edit slides; the ribbon offers generate / rewrite / proofread groups; Deck style sets a unified look, Outline → Slides opens the outline dialog",
    "对话让 AI 阅读当前 PDF；顶部 ribbon 提供对照翻译 / 全文总结 / PDF 问答 / 智能推荐": "Chat to let the AI read the current PDF; the ribbon offers parallel translation / summary / PDF Q&A / smart suggestions",
    "未识别到 WPS 宿主，请在 WPS 文字 / 表格 / 演示 / PDF 中打开本插件": "No WPS host detected — open this add-in inside WPS Writer / Spreadsheets / Presentation / PDF",
    "当前模式": "Mode",
    "直接操作wps": "Direct edit",
    "只在勾选的组件里加载文小舟 加载项。取消勾选后对应组件不再显示插件按钮。改动需": "Load the Wenxiaozhou add-in only in the checked apps. Unchecked apps stop showing the button. Changes require",
    "导入文件格式：可选 frontmatter (": "Import format: optional frontmatter (",
    ")，余下是技能正文。无 frontmatter 时用第一个": ") — the rest is the skill body. Without frontmatter the first",
    "标题或文件名作为名字。": "heading (or the file name) is used as the name.",
    "把下面这段 JSON 加到 Claude Code CLI 的": "Add the JSON below to Claude Code CLI's",
    "（或 Claude Desktop 的": "(or Claude Desktop's",
    "字段）即可。": "field.",
    "手改任意颜色 → 上面\"主题预设\"切回\"自定义\"": "Hand-edit any color → the Theme preset above switches back to Custom",
    // ==== JS 渲染模板补翻（服务状态 / Token 用量 / 缓存 / 本地模型建议 / 生图弹窗 / 脑图 / 改动记录等） ====
    "12 GB 显存：": "12 GB VRAM:",
    "24 GB+ 显存：": "24 GB+ VRAM:",
    "6 GB 显存：": "6 GB VRAM:",
    "HTML 模板模块未加载": "HTML template module not loaded",
    "proxy 本地目录": "proxy local directory",
    "— Microsoft 早期版本，tool 输出格式经常崩。": "— early Microsoft release, tool output breaks often.",
    "— 原生 function calling，中文好。": "— native function calling, good Chinese.",
    "— 原生 tools，英文更强。": "— native tools, stronger in English.",
    "— 原生 tools，速度好。": "— native tools, fast.",
    "— 工具调用质量最接近 GPT-4o-mini 的开源选项（需 24GB+ 显存）。": "— closest open-source tool-calling quality to GPT-4o-mini (needs 24GB+ VRAM).",
    "— 纯代码补全模型，不调工具。": "— pure code-completion model, doesn't call tools.",
    "≤3B 参数": "≤3B parameters",
    "⚠ 每条历史都会被 AI 单独处理一次，可能慢；会自动跳过 freeform 之外的固定布局。": "⚠ Each history item is processed by the AI separately and may be slow; fixed layouts other than freeform are skipped.",
    "✓ 推荐配置（工具调用稳定，部分带视觉）": "✓ Recommended (stable tool calling, some with vision)",
    "✗ 不建议（工具调用不稳定或不支持，插件多数功能用不了）": "✗ Not recommended (unstable/no tool calling — most plugin features won't work)",
    "。Ollama 模型仓库：ollama.com/library。": ". Ollama model library: ollama.com/library.",
    "。多数开源模型至少缺一项，挑错了\"配上能聊天但用不了功能\"。": ". Most open models miss at least one — pick wrong and it chats but can't use features.",
    "从历史里选一条开始": "Pick one from history to start",
    "从字体/配色微调开始": "Start from font / color tweaks",
    "代理服务端口": "Proxy port",
    "任何": "Any",
    "任务进度": "Task progress",
    "展开/收起任务清单": "Expand/collapse task list",
    "任意": "Any",
    "例如：科技感的报告封面，深蓝色背景，柔和光影，商务风格": "e.g. a tech-style report cover, deep blue background, soft lighting, business look",
    "偏代码：": "Code-leaning:",
    "入参": "Input",
    "全系 — Google 系列原生不带 function calling，靠模板模拟成功率低。": "All — the Google family has no native function calling; template emulation rarely works.",
    "内容（拼接所有": "Content (concatenating all",
    "删除元素": "Delete element",
    "删除此对话": "Delete this conversation",
    "删除选中的全部元素": "Delete all selected elements",
    "勉强够，能调工具但慢。": "Barely enough — tools work but slow.",
    "原始报错": "Raw error",
    "后缀的模型都不能识图，不要往里塞截图。": "-suffixed models can't see images — don't paste screenshots.",
    "图片比例（本次）": "Aspect ratio (this run)",
    "图片（原样保留）": "Images (kept as-is)",
    "在浏览器打开（已自动尝试 / 失败时手动复制）": "Open in browser (auto-attempted / copy manually if it fails)",
    "块）+": "blocks) +",
    "基于这份脑图大纲与原文回答。比如：核心结论是什么？各部分怎么衔接？": "Ask about this mind map and the source text. E.g.: what's the core conclusion? How do the parts connect?",
    "复制全文": "Copy full text",
    "复制全文到剪贴板": "Copy full text to clipboard",
    "复制链接": "Copy link",
    "多模态 (vision)": "Multimodal (vision)",
    "大纲": "Outline",
    "存为素材": "Save as asset",
    "完成授权": "Complete authorization",
    "完成授权登录": "Complete sign-in",
    "官方支持：gpt-image-1（推荐，需组织验证）/ dall-e-3 / dall-e-2。国内网络需保证 api.openai.com 可达。": "Official support: gpt-image-1 (recommended, may require org verification) / dall-e-3 / dall-e-2. api.openai.com must be reachable.",
    "将回滚的 AI 改动": "AI changes to roll back",
    "尚未启用任何供应商，去设置里配置。": "No provider enabled yet — configure one in Settings.",
    "尚未测过": "Not tested yet",
    "尝试打开浏览器": "Try opening browser",
    "工具 / 入参": "Tool / input",
    "工具注册表未加载": "Tool registry not loaded",
    "工具调用 (function calling)": "Tool calling (function calling)",
    "已登录": "Signed in",
    "当前分组暂无素材。选中素材后可用「移动」放入这个分组。": "No assets in this group. Select assets and use Move to put them here.",
    "当前文件还没有 AI 改动记录": "No AI change records for this file yet",
    "当前文档尚未保存到磁盘": "Document not saved to disk yet",
    "当前没有缓存数据。": "No cache data.",
    "快照不可序列化": "Snapshot not serializable",
    "思考中…": "Thinking…",
    "总计": "Total",
    "恢复本轮？": "Undo this turn?",
    "或": "or",
    "扫描中…": "Scanning…",
    "批量改\"我的历史\"全部幻灯片": "Batch-edit all slides in My History",
    "技能模块未加载": "Skills module not loaded",
    "把当前脑图转成图片存入素材库": "Save the current mind map as an image asset",
    "把选中的多个元素整体存为一个组件": "Save the selected elements together as one component",
    "拉模型：": "Pull a model:",
    "拖动调整宽度": "Drag to resize width",
    "拖动调整尺寸": "Drag to resize",
    "拖动调整高度": "Drag to resize height",
    "挑一种渠道协议；之后可以在卡片里编辑 baseUrl / apiKey。": "Pick a channel protocol; baseUrl / apiKey can be edited on the card afterwards.",
    "插件未注册任何工具": "No tools registered by the add-in",
    "改动前": "Before",
    "改动前 / 改动后": "Before / After",
    "改动后": "After",
    "改动记录按文档身份（UUID，跨重命名 / Save As 稳定）分组保存；未保存时暂时按文件路径分组。请先保存文档（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），AI 的操作就会关联到这个具体文档。": "Change records are grouped by document identity (UUID, stable across rename / Save As); unsaved files group by path temporarily. Save the document first (Ctrl+",
    "放大预览": "Zoom preview",
    "新增图像生成渠道": "Add image generation channel",
    "无后缀）— 没经过对话微调，根本不会调工具。": "(no suffix) — base model without chat tuning, won't call tools at all.",
    "无快照": "No snapshot",
    "日期": "Date",
    "时间": "Time",
    "暂无可预览内容。": "Nothing to preview.",
    "暂无技能": "No skills",
    "暂无按日记录": "No daily records",
    "暂无按日记录。": "No daily records.",
    "暂无改动记录。让 AI 帮你做点什么,这里就会显示。": "No changes yet. Ask the AI to do something and it will show up here.",
    "暂无模型占比": "No model share data",
    "暂无记录。跑一次 AI 对话或选区操作后这里会显示各模型的 token 用量。": "No records yet. Run an AI conversation or a selection action and per-model token usage will show here.",
    "最低门槛首选": "Best minimum-spec pick",
    "未备份": "Not backed up",
    "未备份（出错）": "Not backed up (error)",
    "未检测到后台服务进程。": "No background service processes detected.",
    "未连接": "Not connected",
    "本地模型选型建议（务必看一眼）": "Local model picking guide (worth a read)",
    "本次排版": "This formatting run",
    "本轮 prompt": "This turn's prompt",
    "来操作文档；图片识别 / 截图分析依赖": "to edit documents; image recognition / screenshot analysis depends on",
    "来源": "Source",
    "次数": "Count",
    "正在粘贴…": "Pasting…",
    "正常运行": "Running",
    "没有可用模型": "No models available",
    "测试": "Test",
    "测试此供应商（拉取模型列表）": "Test this provider (fetch model list)",
    "清了会丢历史/设置": "Clearing loses history/settings",
    "清了会丢改动记录恢复能力": "Clearing loses change-record recovery",
    "清除": "Clear",
    "清除本组": "Clear this group",
    "渲染失败": "Render failed",
    "渲染异常": "Render error",
    "文小舟深度依赖": "Wenxiaozhou depends heavily on",
    "点上一步会出现授权链接": "The authorization link appears after the previous step",
    "点右上角 ⚡ 测试供应商后，这里会出现\"模型下拉\"。": "Click the ⚡ test button first — a model dropdown will appear here.",
    "点右上角 ⚡ 测试渠道后，这里会出现\"模型下拉\"。": "Click the ⚡ test button first — a model dropdown will appear here.",
    "生图提示词": "Image prompt",
    "生成后插入到当前位置。不勾选时只生成图片并记录到素材库。": "Insert at the current position after generating. Unchecked: only generate and save to assets.",
    "生成授权链接": "Generate authorization link",
    "的 base 模型（如": "base models (e.g.",
    "的模型 — 工具调用普遍不靠谱（含 qwen2.5:0.5b/1.5b/3b、llama3.2:1b/3b、phi3:mini）。": "models — tool calling is generally unreliable (incl. qwen2.5:0.5b/1.5b/3b, llama3.2:1b/3b, phi3:mini).",
    "目标": "Target",
    "确认恢复": "Confirm restore",
    "移除": "Remove",
    "纯 CPU / 集显：建议挂在线 API，本地跑 7B 也要十几秒/次。": "CPU / iGPU only: use an online API — even 7B takes 10+ seconds per call locally.",
    "纯文本模型 + 期望视觉：所有不带": "Text-only model + expecting vision: all models without",
    "编辑文字/颜色/字号": "Edit text/color/size",
    "脑图": "Mind map",
    "脑图渲染失败，请切到「大纲」查看。": "Mind map rendering failed — switch to Outline view.",
    "脑图渲染库未加载，请切到「大纲」查看。": "Mind map library not loaded — switch to Outline view.",
    "自动检测": "Auto-detect",
    "自动（按内容判断）": "Auto (by content)",
    "视觉 + 工具：": "Vision + tools:",
    "让 AI": "Let the AI",
    "调用": "Calls",
    "谨慎": "Caution",
    "输入": "Input",
    "输出": "Output",
    "还会同时回滚本轮之后所有已备份的 AI 轮次，以及未保存的手改。请先备份重要内容。": "This will also roll back all later backed-up AI turns and unsaved manual edits. Back up important content first.",
    "还没有外部 agent 调用记录。启动 MCP 服务并让外部 agent 发起调用后，这里会出现。": "No external agent calls yet. Start the MCP server and have an external agent call in — they'll show up here.",
    "退出登录": "Sign out",
    "针对脑图提问": "Ask the mind map",
    "错误": "Error",
    "问问这份脑图 / 文档…（Enter 发送，Shift+Enter 换行）": "Ask this mind map / document… (Enter to send, Shift+Enter for newline)",
    "需选支持图像输出的模型（如 google/gemini-2.5-flash-image）。生图走 chat 接口，比例由提示词控制，不支持 mask 涂抹。": "Pick a model that supports image output (e.g. google/gemini-2.5-flash-image). Generation goes through the chat API; aspect ratio via prompt; no mask support.",
    "静态服务端口": "Static port",
    "非 instruct/chat 后缀": "non-instruct/chat suffix",
    "（仅英文场景）。": "(English-only scenarios).",
    "（截图理解 + 工具调用都有，推荐）、": "(screenshot understanding + tool calling, recommended),",
    "（本轮没有记录到写入型工具调用）": "(no write-type tool calls recorded this turn)",
    "，是甜点档。": ", the sweet spot.",
    "，质量最接近商用 API。": ", closest quality to commercial APIs.",
    // ==== 第三轮扫描补翻（toast 提示 / 原生 confirm 弹窗 / 启动引导页 / 属性赋值） ====
    "\" 或纯 \"": "\" or plain \"",
    "` 大 wrapper 把全部内容塞进去。分图层模式按「直接子元素」切层，包一个 wrapper 等于全页是 1 张图，分图层失效。错误：`": "` wrapper holding everything. Layered mode splits by direct children — one wrapper means the whole page is a single image and layering is defeated. Wrong: `",
    "`，正确：`": "`, correct: `",
    "替换成": "Replace with",
    "文小舟 加载项已启动": "Wenxiaozhou add-in is running",
    "直接打开文小舟": "Open Wenxiaozhou directly",
    "请在 WPS 顶部功能区查找": "Find the tab in the WPS ribbon:",
    "选项卡，然后点击": "tab, then click",
    "面板会嵌入到 WPS 右侧的任务窗格区域。再次点击同一按钮可以收起面板。": "The panel docks into the task pane on the right side of WPS. Click the same button again to collapse it.",
    "从本地删除这条技能": "Delete this skill locally",
    "从组件库删除这条": "Delete from component library",
    "内存": "Memory",
    "启用 / 停用此技能": "Enable / disable this skill",
    "复制完整内容": "Copy full content",
    "排队中 · 0s": "Queued · 0s",
    "查看技能全文": "View full skill",
    "滚轮缩放 · 拖拽平移 · 双击复位": "Wheel to zoom · drag to pan · double-click to reset",
    "请在设置中配置服务": "Configure the service in Settings",
    "清空「我的历史」全部缓存条目？此操作不可撤销。": "Clear all cached items in My History? This cannot be undone.",
    "清空全部生图素材历史？": "Clear all generated image assets?",
    "清空全部自定义组件？此操作不可撤销。": "Clear all custom components? This cannot be undone.",
    "清空所有 HTML 模板缓存记录？此操作不可撤销。": "Clear all HTML template cache records? This cannot be undone.",
    "清空所有已积累的预览日志？": "Clear all accumulated preview logs?",
    "确定清零所有 token 用量统计？此操作不可撤销。": "Reset all token usage stats? This cannot be undone.",
    "确定退出 Codex 登录？": "Sign out of Codex?",
    "确认用预览内容替换当前文档全文？此操作会覆盖原文。": "Replace the whole document with the preview? This overwrites the original.",
    "覆盖当前提示词为默认？": "Overwrite the current prompt with the default?",
    "AI 排版目前只支持 WPS 文字文档。": "AI formatting currently supports WPS Writer documents only.",
    "AI 正在抽取组件，可能需要 10-30 秒…": "The AI is extracting components — this may take 10–30 seconds…",
    "AI 没识别出可独立复用的组件（页面可能太简单 / 太特化）。": "The AI found no independently reusable components (the page may be too simple or too specialized).",
    "AI 还在操作文档，您刚才的输入可能会与 AI 冲突，建议等 AI 完成。": "The AI is still editing the document; your input may conflict with it — better to wait until it finishes.",
    "PPT 风格预设已保存。下次 AI 生成幻灯片会按此色板和样式。": "Deck style preset saved. Future AI-generated slides will follow this palette and style.",
    "SN 还没拿到，稍后再试": "SN not available yet, try again later",
    "freeform 的 html 字段是空的，无可提取。": "The freeform html field is empty — nothing to extract.",
    "freeform 的 html 字段是空的，无法保存。": "The freeform html field is empty — nothing to save.",
    "上一次翻译还在进行中，请稍候或关闭窗口重开。": "The previous translation is still running; wait or reopen the window.",
    "云端技能刷新失败：": "Cloud skill refresh failed: ",
    "分组创建失败。": "Failed to create group.",
    "另存为失败：": "Save-as failed: ",
    "只有 freeform 布局可以保存为组件。": "Only freeform layouts can be saved as components.",
    "只有 freeform 布局可以提取组件。当前请先切到 freeform 排版。": "Only freeform layouts support component extraction. Switch to a freeform layout first.",
    "图片已插入当前文档。": "Image inserted into the document.",
    "图片未加载完成。": "Image not fully loaded.",
    "图片正在插入，请稍候。": "The image is being inserted, please wait.",
    "复制失败，请手动选中文本": "Copy failed — select the text manually",
    "复制失败，请手动选中文本复制": "Copy failed — select and copy the text manually",
    "复制失败：": "Copy failed: ",
    "存入素材库失败（存储空间不足）。": "Failed to save to assets (out of storage).",
    "存入素材库失败（本地存储空间不足）。": "Failed to save to assets (local storage full).",
    "完成但存入失败。": "Finished, but saving failed.",
    "官网地址已复制": "Website URL copied",
    "局部重绘完成，已存入素材库。": "Inpainting done — saved to assets.",
    "已取消": "Cancelled",
    "已取消保存。": "Save cancelled.",
    "写入区域过大（{n} 个单元格），请缩小范围分批写入": "Write area too large ({n} cells); please narrow the range and write in batches.",
    "已复制到剪贴板": "Copied to clipboard",
    "已复制对照翻译。": "Parallel translation copied.",
    "已开始新对话。": "Started a new conversation.",
    "已恢复为默认系统提示词，记得点保存。": "Restored the default system prompt — remember to click Save.",
    "已按涂抹抠出主体，存入素材库。": "Cut out the brushed subject — saved to assets.",
    "已提交。": "Submitted.",
    "已提交，请点窗口右上角 × 关闭。": "Submitted. Close this window with the × in the corner.",
    "已插入到光标位置。": "Inserted at the cursor.",
    "已替换全文（样式回退到默认）。": "Document replaced (styles fell back to defaults).",
    "已替换当前选区。": "Selection replaced.",
    "已生成授权链接。如果浏览器没自动弹出，请复制链接手动打开。": "Authorization link generated. If the browser didn't open, copy the link and open it manually.",
    "已裁剪并存入素材库。": "Cropped and saved to assets.",
    "已转为自由编辑模式 —— 可拖动、缩放、改文字。原字段表单不再可用。": "Switched to free-edit mode — drag, resize, edit text. The field form is no longer available.",
    "已退出 Codex 登录。": "Signed out of Codex.",
    "已退出登录。": "Signed out.",
    "当前 PDF 已经在附件列表里了。": "This PDF is already in the attachment list.",
    "不支持的文件类型，只能添加 图片 / PDF / 文本文件": "Unsupported file type — only images / PDFs / text files can be attached",
    "当前 WPS 版本不支持改 TaskPane 停靠方式。": "This WPS version doesn't support changing the task pane docking mode.",
    "当前文档为空或读取失败。": "The document is empty or could not be read.",
    "当前文档没有可处理的正文。": "No processable body text in this document.",
    "当前模型不支持图片输入，发送时图片附件会被忽略，仅文本附件生效。": "The current model doesn't support image input; image attachments will be ignored, text attachments still apply.",
    "当前没有可保存的预览。": "No preview to save right now.",
    "当前没有可处理的选区内容。": "No selection content to process.",
    "当前没有可复制的内容。": "Nothing to copy.",
    "当前没有检测到 AI 残留锁定。如果 WPS 仍提示编辑受限，可能是用户自己设置的密码保护。": "No residual AI lock detected. If WPS still restricts editing, it may be a user-set password protection.",
    "当前没有选中的文本。": "No text selected.",
    "当前没有预览，无法保存为组件。": "No preview yet — nothing to save as a component.",
    "当前素材没有可保存的图片。": "This asset has no saveable image.",
    "快捷操作数据已过期，请重新点击 ribbon 按钮。": "Quick action data expired — click the ribbon button again.",
    "抠图完成但存入失败。": "Cutout finished but saving failed.",
    "抠图完成，已存入素材库。": "Cutout finished — saved to assets.",
    "拖动会自动吸附（边/中心/对齐 6px 内）。按住 Shift 可临时禁用吸附。": "Dragging snaps automatically (edges/centers within 6px). Hold Shift to disable snapping.",
    "授权链接已复制到剪贴板": "Authorization link copied to clipboard",
    "排版预览数据已过期，请重新点击 ribbon 按钮。": "Formatting preview data expired — click the ribbon button again.",
    "排版预览结果为空。": "The formatting preview result is empty.",
    "插件未完整初始化，无法插入": "Add-in not fully initialized — cannot insert",
    "插入任务已派给主面板执行…": "Insert task handed to the main panel…",
    "插入失败：插件未完整初始化": "Insert failed: add-in not fully initialized",
    "无法切换到自由编辑模式 —— 当前布局渲染失败，请重试": "Cannot switch to free-edit mode — the current layout failed to render, please retry",
    "无法读取这张图片作为参考，已只回填修改指令。": "Couldn't read this image as a reference; only the edit instruction was backfilled.",
    "日志已清空。": "Logs cleared.",
    "暂无日志可导出。": "No logs to export.",
    "更新失败：": "Update failed: ",
    "未找到快捷操作指令。": "Quick action instruction not found.",
    "未读到 PDF 路径。已记录 WPS PDF 路径探测日志，请查看 dev 终端或在控制台执行 __lingxiProbePdfPath()。": "PDF path not detected. WPS PDF path probe logged — check the dev terminal or run __lingxiProbePdfPath() in the console.",
    "未读到当前 PDF 的本机路径，无法读取文件内容。已记录 PDF 路径探测日志，请查看 dev 终端。": "Couldn't get the local path of this PDF, so its content can't be read. Probe log recorded — check the dev terminal.",
    "本地存储已满，设置 / 历史 / 缓存可能写不进去。点这里去缓存管理清空间。": "Local storage is full — settings / history / caches may fail to write. Click here to free space in Cache.",
    "本地模型抠图完成但存入失败。": "Local cutout finished but saving failed.",
    "本地模型抠图完成，已存入素材库。": "Local cutout finished — saved to assets.",
    "正在准备图片并打开另存为窗口...": "Preparing the image and opening Save As…",
    "正在插入图片到文档，请稍候…": "Inserting the image into the document, please wait…",
    "没有可下载的更新（先点检查更新）": "No update to download (check for updates first)",
    "没有可使用的结果。": "No usable result.",
    "没有可替换的排版内容。": "No formatted content to apply.",
    "热更新模块未加载": "Hot-update module not loaded",
    "生成脑图图片失败：": "Failed to generate the mind map image: ",
    "登录成功 ✓": "Signed in ✓",
    "登录成功。": "Signed in.",
    "素材不存在或已被删除。": "Asset missing or deleted.",
    "素材已失效。": "Asset no longer valid.",
    "素材库未就绪。": "Asset library not ready.",
    "素材库模块未加载。": "Asset library module not loaded.",
    "素材插入目前支持 WPS 文字、表格和演示。": "Asset insertion currently supports WPS Writer, Spreadsheets and Presentation.",
    "组件库模块未加载。": "Component library module not loaded.",
    "结果已复制到剪贴板。": "Result copied to clipboard.",
    "缓存模块未加载，无法保存。": "Cache module not loaded — cannot save.",
    "脑图已存入素材库。": "Mind map saved to assets.",
    "至少要保留一个组件——全部关掉后就没有入口能再打开插件了。": "Keep at least one app enabled — turning all off leaves no way to open the add-in.",
    "裁剪区域太小。": "Crop area too small.",
    "裁剪失败：": "Crop failed: ",
    "设置已保存。": "Settings saved.",
    "诊断包已下载。请把 .json 文件发给管理员。": "Diagnostics downloaded. Send the .json file to the admin.",
    "该 PDF 是扫描件，已在对话流中生成对照翻译。": "This PDF is a scan; the parallel translation was generated in the chat flow.",
    "该功能目前只支持 WPS 文字文档。": "This feature currently supports WPS Writer documents only.",
    "请先在「聊天模型」里启用至少一个供应商。": "Enable at least one provider under Chat Models first.",
    "请先在图片上框选一块区域。": "Drag-select an area on the image first.",
    "请先用画笔涂抹要重绘的区域。": "Brush over the area to inpaint first.",
    "请先粘贴回调 URL 或 code": "Paste the callback URL or code first",
    "请先输入大纲。": "Enter an outline first.",
    "请先选中文字，再使用该功能。": "Select some text first.",
    "请先选择一张素材。": "Select an asset first.",
    "请先选择素材。": "Select assets first.",
    "请在主面板执行单图修改。": "Run single-image edits in the main panel.",
    "请填写组件名称。": "Enter a component name.",
    "请描述需要抠出的部分，或选择整张去背景。": "Describe what to cut out, or choose whole-image background removal.",
    "请点窗口右上角 × 关闭。": "Close this window with the × in the corner.",
    "请输入分组名称。": "Enter a group name.",
    "读取文件失败": "Failed to read file",
    "读取文件失败。": "Failed to read file.",
    "还没有可复制的结果。": "No result to copy yet.",
    "还没有结果可复制。": "No result to copy yet.",
    "还没生成授权链接": "No authorization link generated yet",
    "这条素材没有可用图片地址。": "This asset has no usable image URL.",
    "远程图片本地缓存失败，已尝试用原始地址插入。": "Local caching of the remote image failed — inserted with the original URL.",
    "选区预览数据已过期，请重新点击 ribbon 按钮。": "Selection preview data expired — click the ribbon button again.",
    "配置已复制到剪贴板": "Config copied to clipboard",
    "预览已生成。": "Preview generated.",
    "预览已生成（当前 provider 不支持流式，已切非流式）。": "Preview generated (provider doesn't support streaming — switched to non-streaming).",
    "确认用预览内容替换选中区域？此操作只覆盖选中部分的排版。": "Replace the selection with the preview? Only the selected part is overwritten.",
    "确认用预览内容替换当前文档全文？此操作会覆盖原文排版。": "Replace the whole document with the preview? This overwrites the original formatting.",
    "确定删除 {name}？": "Delete {name}?",
    "从技能库删除「{name}」？此操作不可撤销。": "Delete \"{name}\" from the skill library? This cannot be undone.",
    "清空全部 {n} 条改动记录？": "Clear all {n} change records?",
    "删除选中的 {n} 张素材？": "Delete the {n} selected assets?",
    "确认删除对话「{title}」？此操作不可撤销。": "Delete conversation \"{title}\"? This cannot be undone.",
    "确认清除 {key}？": "Clear {key}?",
    "确认清除 proxy 侧 {name} 目录？": "Clear the proxy-side {name} directory?"
  };

  // 反向词典（en → zh）：热切回中文时把已翻的节点还原。
  // 一对多冲突（如「清空全部/清空所有」都译 "Clear all"）取先定义的 key —— 还原文案
  // 可能落到近义变体上，动态区域下次渲染会回到准确原文，可接受。
  const REVERSE_EN = {};
  for (const k in DICT_EN) {
    if (!Object.prototype.hasOwnProperty.call(REVERSE_EN, DICT_EN[k])) REVERSE_EN[DICT_EN[k]] = k;
  }

  function getPref() {
    try { return global.localStorage.getItem(PREF_KEY) || "auto"; } catch (e) { return "auto"; }
  }
  function setPref(v) {
    const val = (v === "zh" || v === "en") ? v : "auto";
    try { global.localStorage.setItem(PREF_KEY, val); } catch (e) {}
    // WPS 的 localStorage 会丢（kv-store 项目存在的原因）——同时写进 SQLite 受管存储持久化。
    // WpsAiStore 是小受管键 write-through，会自己再刷一遍 localStorage，无害。
    try { global.WpsAiStore?.setItem?.(PREF_KEY, val); } catch (e) {}
    applyCurrent(); // 热切换：当前窗口立即套用；其它窗口靠轮询/事件同步
    notifyChanged();
    syncRibbonLangSidecar();
  }

  // ribbon 语言侧车：让本地代理把 ~/.lingxi-ai/ui-lang.txt 写成当前解析语言。
  // 静态服务按它决定给 WPS 发中文还是英文 ribbon.xml（部分 WPS 不支持 getLabel
  // 动态回调，label 必须在 xml 里就是目标语言；重启 WPS 生效）。fire-and-forget。
  function syncRibbonLangSidecar() {
    try {
      if (typeof fetch !== "function") return;
      const base = (global.WpsAiRuntime && global.WpsAiRuntime.proxyBase && global.WpsAiRuntime.proxyBase()) || "http://127.0.0.1:3890";
      fetch(base + "/ui-lang", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: resolvedLang() })
      }).catch(() => {});
    } catch (e) {}
  }

  // 启动对账：WpsAiStore.init() 完成后（app.js boot 调用），以 SQLite 里的偏好为权威——
  // localStorage 被 WPS 清掉时，从 store 恢复并立即套用。
  function syncFromStore() {
    let storeVal = null;
    try { storeVal = global.WpsAiStore?.getItem?.(PREF_KEY); } catch (e) {}
    if (storeVal === "zh" || storeVal === "en" || storeVal === "auto") {
      let lsVal = null;
      try { lsVal = global.localStorage.getItem(PREF_KEY); } catch (e) {}
      if (lsVal !== storeVal) {
        try { global.localStorage.setItem(PREF_KEY, storeVal); } catch (e) {}
        applyCurrent();
        notifyChanged();
      }
    }
  }

  // 语言变化时给本窗口的 UI（如设置里的下拉）发通知，让其同步显示值；
  // ribbon 上下文里还要让 WPS 重新拉一遍 getLabel（按钮文字跟着切）。
  function notifyChanged() {
    try { global.dispatchEvent && global.dispatchEvent(new CustomEvent("lingxi-lang-changed", { detail: { pref: getPref() } })); } catch (e) {}
    try { global.__lingxiRibbonUI && global.__lingxiRibbonUI.Invalidate && global.__lingxiRibbonUI.Invalidate(); } catch (e) {}
  }
  function resolvedLang() {
    const p = getPref();
    if (p === "zh" || p === "en") return p;
    let sys = "";
    try { sys = String((navigator.languages && navigator.languages[0]) || navigator.language || ""); } catch (e) {}
    return /^zh/i.test(sys) || sys === "" ? "zh" : "en";
  }

  // t("中文原文", { name: "值" })：en 模式查词典（查不到回退中文），支持 {param} 插值
  function t(zhText, params) {
    let s = String(zhText == null ? "" : zhText);
    if (resolvedLang() === "en" && Object.prototype.hasOwnProperty.call(DICT_EN, s)) s = DICT_EN[s];
    if (params) {
      for (const k in params) {
        s = s.split("{" + k + "}").join(String(params[k]));
      }
    }
    return s;
  }

  // ---- 自动 DOM 翻译（仅 en 模式启用）----

  // 用户内容区域：不翻。聊天正文 / 工具与思考输出 / 排版与选区预览正文 / 素材名等。
  const EXCLUDE_SELECTOR = [
    "[data-no-i18n]",
    ".chat-msg-body", ".tool-body", ".reasoning-body", ".quick-action-body",
    ".format-preview-content", ".sp-body", ".selection-preview-content",
    ".material-card-name", ".mm-qa-stream",
    ".tl-body", ".tl-text", ".tl-step-detail", ".tl-quickaction-detail"
  ].join(",");

  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  const ATTRS = ["placeholder", "title", "aria-label"];

  function shouldSkip(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    try { if (el.closest && el.closest(EXCLUDE_SELECTOR)) return true; } catch (e) {}
    return false;
  }

  // 翻一个 text 节点：整体 trim 后精确匹配词典；保留原有首尾空白。map 决定方向（zh→en / en→zh）
  function translateTextNode(node, map) {
    const dict = map || DICT_EN;
    const raw = node.nodeValue;
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || !Object.prototype.hasOwnProperty.call(dict, trimmed)) return;
    const lead = raw.slice(0, raw.indexOf(trimmed[0]) >= 0 ? raw.indexOf(trimmed[0]) : 0);
    const tail = raw.slice(lead.length + trimmed.length);
    node.nodeValue = lead + dict[trimmed] + tail;
  }

  function translateAttrs(el, map) {
    const dict = map || DICT_EN;
    for (const a of ATTRS) {
      let v = null;
      try { v = el.getAttribute(a); } catch (e) { continue; }
      if (v && Object.prototype.hasOwnProperty.call(dict, v.trim())) {
        el.setAttribute(a, dict[v.trim()]);
      }
    }
  }

  function walk(root, map) {
    if (!root) return;
    if (root.nodeType === 3) { // 裸 text 节点
      if (!shouldSkip(root.parentElement)) translateTextNode(root, map);
      return;
    }
    if (root.nodeType !== 1 || SKIP_TAGS[root.tagName]) return;
    if (shouldSkip(root)) return;
    translateAttrs(root, map);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          return (SKIP_TAGS[n.tagName] || (n.matches && n.matches(EXCLUDE_SELECTOR)))
            ? NodeFilter.FILTER_REJECT   // 整棵子树跳过
            : NodeFilter.FILTER_SKIP;    // 元素本身不处理（属性下面统一处理），继续下钻
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    // 属性翻译：单独一轮 querySelectorAll（TreeWalker 的 SKIP 拿不到元素引用）
    try {
      root.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => {
        if (!shouldSkip(el)) translateAttrs(el, map);
      });
    } catch (e) {}
    let n;
    while ((n = tw.nextNode())) translateTextNode(n, map);
  }

  let _observer = null;
  function startObserver() {
    if (_observer || typeof MutationObserver === "undefined") return;
    _observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          m.addedNodes && m.addedNodes.forEach((node) => walk(node, DICT_EN));
        } else if (m.type === "attributes" && m.target && !shouldSkip(m.target)) {
          translateAttrs(m.target, DICT_EN);
        }
      }
    });
    _observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }
  function stopObserver() {
    if (_observer) { try { _observer.disconnect(); } catch (e) {} _observer = null; }
  }

  // 按当前语言热套用：en → 正向翻译 + 开启观察器；zh → 关观察器 + 反向还原已翻文案。
  // 无 DOM 环境（单测）安全跳过。
  function applyCurrent() {
    if (typeof document === "undefined" || !document || !document.body) return;
    if (resolvedLang() === "en") {
      walk(document.body, DICT_EN);
      startObserver();
    } else {
      stopObserver();
      walk(document.body, REVERSE_EN);
    }
  }

  function init() {
    // 跨窗口热同步（双保险）：
    //   1. storage 事件——同源其它窗口写 localStorage 时触发（WPS CEF 下不一定可靠）
    //   2. 轮询兜底——WPS 弹窗 IPC 全靠轮询，这里同样每 2s 对比一次偏好
    try {
      global.addEventListener && global.addEventListener("storage", (ev) => {
        if (ev && ev.key === PREF_KEY) { applyCurrent(); notifyChanged(); }
      });
    } catch (e) {}
    let lastPref = getPref();
    try {
      global.setInterval && global.setInterval(() => {
        const p = getPref();
        if (p !== lastPref) {
          lastPref = p;
          applyCurrent();
          notifyChanged();
        }
      }, 2000);
    } catch (e) {}
    // 启动后延迟对齐一次 ribbon 语言侧车（等 runtime 端口探测就绪）：
    // 用户在本功能上线前就切过语言时，侧车文件也能收敛到当前语言
    try { global.setTimeout && global.setTimeout(syncRibbonLangSidecar, 3000); } catch (e) {}
    if (resolvedLang() !== "en") return; // 中文模式启动零开销（不扫描不观察）
    // ribbon 上下文：WPS 可能在 i18n.js 执行前就查过一次 getLabel（按钮按中文渲染了）。
    // 英文模式启动后重试几次 Invalidate，等 __lingxiRibbonUI 就位后让 WPS 重取按钮文字。
    [800, 2500, 6000].forEach((d) => {
      try {
        global.setTimeout(() => {
          try { global.__lingxiRibbonUI && global.__lingxiRibbonUI.Invalidate && global.__lingxiRibbonUI.Invalidate(); } catch (e) {}
        }, d);
      } catch (e) {}
    });
    if (typeof document === "undefined" || !document) return;
    const boot = () => { walk(document.body, DICT_EN); startObserver(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  global.WpsAiI18n = {
    t,
    getPref,
    setPref,
    resolvedLang,
    apply: walk,
    applyCurrent, // 按当前语言热套用（切换语言 / 跨窗口同步入口）
    init,
    _dict: DICT_EN,      // 测试/调试用
    _reverse: REVERSE_EN // 测试/调试用
  };

  init();
})(window);
