# 更新日志 / Changelog

> 历史版本的详细发布说明。最新版本概览见 [README](README.md#更新日志)。

## v1.4.8（开发中）

### 名称与安装兼容

- 产品显示名称改为「文小舟」。Windows 安装器保留原 AppId 和安装目录，macOS / Linux 保留原包标识、插件注册名及用户数据目录；旧版本可原位升级，配置与对话沿用。
- 修复 Windows WPS 停靠面板顶部被功能区遮挡，导致模型选择和设置入口不可见的问题。
- 规避 Windows WPS 文字创建停靠窗格后功能区无法点击的问题：主面板改用非模态浮窗，并移除浮窗多余的顶部留白。
- 更新文小舟 logo：WPS 功能区与插件面板使用压缩 PNG，Windows 安装器和卸载入口使用多尺寸图标。

### 启动修复

- 修复本地代理切换端口后，插件可能一直显示「插件启动中」的问题；Windows 本地调试会使用实际代理端口。
- 修复 Gemini 3 系列使用工具后续轮报 `Function call is missing a thought_signature`：按原顺序回传模型返回的 parts 与签名。
- 修复 PPT 读取时文字按形状创建顺序返回、与页面视觉顺序不一致；完成报告明确成功时同步遗漏的任务进度状态。

### 多协议供应商（加强聊天回显适配）

- **新增 Google Gemini 原生协议**（`js/providers/gemini.js`）：`:streamGenerateContent?alt=sse`，解析 `parts[].text`（正文）/ `parts[].thought`（思考）/ `parts[].functionCall`（工具）；鉴权 `x-goog-api-key`；消息 `contents(user/model)` + `systemInstruction`；functionResponse 回填进 user 轮（Gemini 强制 user/model 交替）；schema 过 sanitize 只留 OpenAPI 子集
- **新增通用 OpenAI Responses 协议**（`js/providers/openai-responses.js`）：用 API Key + baseUrl 接 `/v1/responses`（不走 codex 的 ChatGPT OAuth）；解析 `response.output_text.delta` / `reasoning_summary_text.delta`（比 codex 多回显了思考）/ `function_call_arguments.delta` / `output_item.added` / `completed`
- **新增 Azure OpenAI**：复用 chat/completions 整套解析，仅请求端分叉——`api-key` 头 + `/openai/deployments/{部署}/chat/completions?api-version=`（部署名默认取所选模型）
- **修流式 `delta.content` 数组分片**：少数网关把正文发成 `[{type:"text",text}]` 数组而非字符串，之前会整段丢字，现统一压平
- **思考实时回显**：reasoning token 改为按到达顺序实时发出（之前攒到流末尾一次性发 → 思考总排在答案后面）；Gemini 2.5 全系识别为思考模型
- proxy 放行 `api-key` / `x-goog-api-key` 透传头；三种新协议在「+ 新增供应商」预设里可选，配置复用 openai 卡片（Azure 另填 api-version / 部署名）

### MCP Client（作为客户端连接外部 MCP 服务）

- **新增「MCP 客户端」设置面板**：连接外部 MCP 服务（本地 stdio 子进程 / 远程 SSE），把它们的工具纳入 AI 对话调用
  - stdio / SSE 两种传输，连接管理器（声明式 reconcile / 状态 / 调用转发），proxy 侧 `/mcpc/*` 路由
  - 外部工具以 `mcp__<服务>__<工具>` 命名空间注册进工具表，AI 对话主链路零改动；复用双模式确认，`trusted` 服务可免确认
  - 服务卡片支持：启停开关、查看工具清单、查看每个工具的参数、测试连接、编辑/删除
  - 「+ 新增」下拉：快速创建 / 从 JSON 导入（粘贴 Claude Desktop/Code 的 `mcpServers` 配置一次建多个）
  - 修 Windows `spawn npx ENOENT`（裸命令走 `cmd.exe /c` 解析 + 树杀清理子进程）
  - `/mcpc/*` TOFU token 门禁（首个请求建立信任并落盘），关闭浏览器可触发的本机 RCE 面

### 聊天时间轴

- **修 WPS WebView 下对话区没滚动条 / 内容被截断**：对话区改绝对定位铺满，解耦"高度确定"与"滚动视口"
- **类 Claude 时间轴外观**：rail 竖线上每个过程节点加圆点；最后一个节点下方竖线收尾不再延伸
- **耗时展示**：恢复模型名后本轮耗时；工具调用 / 思考各自显示耗时；收起行「调用了 N 个工具」右侧显示该段总耗时
- 用户消息靠右气泡；任务清单默认折叠

### WPS 文字工具

- **`wps_find_colored_text`**：扫描文档找出红字 / 高亮 / 段落底纹（背景色）的文本片段（补读取侧颜色能力缺口）
- **`wps_clear_text_formatting`**：一次调用把整篇（或指定段落范围）字体统一黑色 + 去高亮 + 去底纹，避免逐处操作触发限流

### 通用

- **限流（rpm / rate limit / 429）友好提示**：模型端点报「每分钟请求超限」时，翻成用户能懂的中文（稍等 1 分钟 / 换额度更高的 Key / 批量操作一次搞定），原始报错仍附末尾

## v1.4.0

围绕「PPT 设计能力升级 + 可视化编辑器 + 灰度热更新 + 通用质量」的大版本。

### HTML 模板系统大扩

- **从 9 套布局扩到 17 套**，按 2026 modern keynote / pitch deck 标准改造 typography（正文最低 18pt=36px / 标题 40-44pt / 金句 44pt italic）：
  - 新增 `timeline`（横向里程碑 + 编号圆点）/ `agenda`（议程目录 + dotted leader）/ `two-column`（双栏文字）/ `image-text`（图文，黄金比例 62:38 切分）/ `process`（横向流程图 + 箭头）/ `table`（数据表，斑马纹）/ `bento`（不对称网格，1 hero + 3 small）/ `closer`（致谢 / Q&A）
  - 原有 9 套（cover/section/content/stat/feature-grid/quote/comparison/metric-trio/freeform）字号统一抬到 modern 标准、布局更克制
- **编辑感 page-indicator 全局组件**：每个 layout 可选 `pageIndex`（"03 / 12"）+ `brand`（品牌名），右下角自动渲染小字 strip
- **章节扉页升级**：`section.sec-number` 320→260（克制不压迫），叠加 240px 横线 + 新增 `subtitle` 一句话提要做杂志气
- **边框与圆角互斥规则**：所有有 border / border-left / border-top 的卡都去掉 border-radius（圆角会把 accent 色条/边框端头截弯）；纯填充卡（bento/process step）继续圆角
- **AI 提示词同步**：把"一页一意 / 留白 15-20% / 字号 ≥ 18pt / 三分法 / pageIndex 编辑感"7 条 modern keynote 准则写进 `wpp_render_html_template` 工具描述
- **AI 节奏建议**：cover → agenda → section/content 交替 → 中段 stat/metric-trio/bento 提气 → 必要的 comparison/timeline/process/table → 收尾 closer，**至少 4 种 layout** 避免单调

### 可视化编辑器（HTML 预览 modal）

- **任何 layout 都能进编辑模式**：之前只支持 freeform，现在非 freeform 点「编辑模式」会自动调 `convertCurrentLayoutToFreeform()` —— 把当前 layout 渲染结果用 DOMParser 抽出 `<style>` 内容 + `.stage` innerHTML 塞回 freeform，保留视觉，原 data 备份在 `_preFreeformData` 留还原口子
- **PS 风对齐参考线 + 吸附**（参考 Figma smart guides）：
  - 拖动期间扫描画布 6 个锚点（左/中/右 + 顶/中/底）+ 其他元素的 6 个锚点，被拖元素的 3 个 X / 3 个 Y 锚点找最近吸附目标
  - `SNAP_PX = 6` 内自动吸附；红色虚线 = 画布边/中线，青色虚线 = 元素对齐
  - **Shift 临时禁用吸附**（跟 Figma 一致）
  - Resize 同样支持：`se` 句柄吸右下、`nw` 句柄吸左上 etc.
- **坐标 hint 徽章**：拖动时跟随光标 `200 × 100 · 画布 234, 567`，深色背景 + 等宽字体
- **拖动后再选别的元素不响应** bug 修：`_editorJustDragged` 加 100ms setTimeout 自动失效（之前卡 true 直到下次点击被吃掉）
- **Resize 把手 cursor 没显示** bug 修：`body.__lingxi_editing * { cursor: crosshair !important }` 用更具体的选择器 + `!important` 抢回 `nwse-resize / nesw-resize / ns-resize / ew-resize / pointer`；选中元素本体挂 `.__lingxi_selected_move` 显示 move 光标
- **html2canvas 截图丢虚线** bug 修：agenda 的 TOC dotted leader 从 `border-bottom: 4px dotted` 改成 `background-image: radial-gradient` 点阵；AI 自由排版也明确告知不要用 dashed/dotted

### PPT 风格预设弹窗重做

- **40+ 主题从单 `<select>` 改成可视化网格**：每张卡渲染迷你 16:9 幻灯片缩略图，背景色 + 标题字 + accent 圆点全用该主题的真实颜色画出，一眼挑
- **顶部实时预览块**：标题 + 正文 + accent + 元信息（字体 + 字号），任何字段改动毫秒级反映
- **分段重构**：主题预设 / 字体 / 配色微调 / 主题模板 4 个 section header
- **弹窗加宽**：modal-card 440px → modal-card-wide 720px
- **关键 bug 修：未勾选「启用统一样式」时 stylePreset 还在生效**
  - presentation.js 加 `getEffectiveStylePreset()` 单点闸门，`enabled !== true` 返回空对象，5 处渲染入口统一接入（wpp_apply_visual_template / wpp_render_html_template / wpp_render_full_deck / wpp_apply_template / getChartPalette）
  - `wpp_get_style_preset` 工具未启用时不再返回保存的色板字段（之前 AI 看到字段会拿去填 freeform CSS，等同于"未启用"形同虚设），改成只返回 `enabled: false + guidelines + 自己挑色板`提示

### 技能模块

- **`DEFAULT_ENABLED = []` 完全 opt-in**：之前默认开 `builtin-ui-ux-pro-max`，新用户没碰过技能面板时 system prompt 里实际塞了 ~10K token UI/UX 指令，跟 UI 显示不一致
- **`pptFreeDesignNote` 不再硬编码"已启用 UI/UX Pro Max 技能"**：用 `WpsAiSkills.isEnabled()` 判断，没启用就不在 prompt 里提 skill 名字，避免 AI 假装在用没真启用的技能

### 本地模型配置建议

- 检测 baseUrl 是 `localhost / 127.0.0.1 / 私网 IP` 时，配置卡里追加"本地模型选型建议" `<details>` 块：
  - ✓ 推荐：qwen2.5:7b/14b/32b-instruct / llama3.1 系列 / mistral-nemo / qwen2.5-vl:7b（视觉+工具）
  - ✗ 不建议：gemma2/3 全系（无原生 tools）/ phi-3 早期 / 任意 ≤3B 参数 / 任意 base 模型 / codellama / 不带 -vl/-vision 的模型识图
  - 6/12/24GB 显存对照预算

### 图像生成

- **codex-bridge 路径加心跳进度**：阻塞 POST 期间每秒重报 in_progress，让 UI 的「已用 Xs」实时跳动（之前全程显示 0s 直到完成）
- **状态串重排**：耗时 / 状态在前，提示词放最后允许被 CSS ellipsis 吃掉；提示词截断从 30 字放宽到 80 字
- **CF Cloudflare JA3 拦截的精准错误归因**：proxy 加 socket 生命周期诊断（DNS / TCP / TLS 三级）：
  - TCP 连了 + TLS 没握上 + 落 CF IP 段 → 明确提示"被 CF 边缘按 TLS 指纹拦了 · 跟控制台开关无关 · 换非 CF 端点"
  - `isCloudflareIp()` 覆盖 CF 主要 IPv4 段（104.16/12、172.64/13、162.158/15 等）
  - 客户端识别 "Cloudflare / TLS 握手 / JA3" 关键词时不再附加误导的"model 不支持"尾巴

### 灰度热更新

- **设备 SN（硬件级稳定标识）**：
  - Windows 优先 PowerShell `Get-CimInstance Win32_ComputerSystemProduct` 取主板 UUID（Windows 11 22H2+ 已砍掉 wmic），失败兜底 wmic / BIOS SN
  - macOS：`ioreg IOPlatformUUID`
  - Linux：`/sys/class/dmi/id/product_uuid` 或 `/etc/machine-id`
  - 全失败 → `crypto.randomUUID()` 一次性生成存到 `~/.lingxi-ai/device-sn.json`
- **manifest 新增 canary 字段**：
  - `canary.snWhitelist[]` 精准白名单（命中强制 canary）
  - `canary.rolloutPercent` 百分比放量（白名单外按 `snHash100(sn) % 100 < N` 灰度，FNV-1a hash 保证同 SN 永远同结果，逐步放量平滑）
- **UI**：
  - 「程序信息」面板新增"设备 SN"行 + 复制按钮（navigator.clipboard fallback 给老 WebView）
  - "版本更新"卡 head 多通道徽章：`stable` / `canary (whitelist)` / `canary (rollout)`
- **稳健性**：dev 模式 proxy / TaskPane 并发启动，前端 getDeviceSn 加 3 次退避重试（立即 / 1.5s / 3s），区分"代理离线"vs"SN 读取失败"两种错误

### 其它

- MCP 服务（设置 → MCP 服务）：开启后把 WPS 工具暴露给外部 agent（Claude Code / Claude Desktop / Cursor 等），配置 JSON 一键复制，实时状态徽章
- 响应式弹窗：modal-card 改 `min(width, 100vw - 24px)`，360px 宽 TaskPane 不再撑爆
- PPT 风格预设独立窗口：`Application.ShowDialog ?mode=stylepreset` 脱离 TaskPane 宽度

### 修复 v1.3.x 遗留 bug

**设置 / 配置**

- 设置布尔字段勾选保存了但下次加载又被重置：[loadSettings](plugin/js/providers/registry.js) 是字段白名单 merge，`splitLayersOnInsert / showToolCallLogs / mcpServerEnabled / updateAutoCheck` 全部漏写 → parsed 里的用户值没复制到 merged，永远回到 default。统一加 `hasOwnProperty` 判断 merge
- 「+ 新增图像渠道」按钮无响应：① 设置 dialog 独立窗口模式（`?mode=settings`）的事件绑定块漏绑 `addImageProviderBtn` ② 用了 `window.prompt()` 取类型，WPS WebView 多版本静默不弹。改成 modal picker
- Codex (ChatGPT OAuth) 卡片缺登录 UI：之前依赖 `<div class="legacy-shim hidden">` 里的登录按钮（实际被 CSS 隐藏），用户选 Codex 后看不到任何登录入口。卡内直接内嵌 4 步授权流（生成链接 → 复制 → 浏览器登录 → 粘 code 完成）
- 默认 `maxToolIterations: 50` 太低：复杂任务（10 页 PPT / 多页文档生成）经常中途 `工具调用循环达到上限`。默认 50 → 150，input max 200 → 500

**PPT 风格预设**

- **未勾选「启用统一样式」但 AI 生成的 PPT 仍套用保存的色板/字体**：5 处 presentation.js 渲染入口（`wpp_apply_visual_template / wpp_render_html_template / wpp_render_full_deck / wpp_apply_template / getChartPalette`）直接读 `settings.stylePreset`，不看 `enabled` 字段。新增单点闸门 `getEffectiveStylePreset()`，`enabled !== true` 时返回空对象让所有 fallback 接管
- `wpp_get_style_preset` 工具未启用时仍返回完整色板：AI 看到字段就会拿去填 freeform CSS，等于"未启用形同虚设"。改成只返回 `enabled:false + guidelines + 提示自己挑色板`，色板字段不暴露

**技能模块**

- 新用户没勾过任何技能，但 system prompt 里实际塞着 ~10K token UI/UX 指令：`DEFAULT_ENABLED = ["builtin-ui-ux-pro-max"]` 默认静默启用 → UI 显示和真实行为不一致。改为 `DEFAULT_ENABLED = []` 完全 opt-in
- `pptFreeDesignNote` 在用户输入风格关键词时硬编码"参考已启用的 UI/UX Pro Max 设计智能技能"：哪怕 skill 实际没启用，AI 也被诱导按那套套路走。改成 `WpsAiSkills.isEnabled()` 判断才提该行

**图像生成**

- codex-bridge 路径"已用时间"全程显示 `0s`：阻塞 POST 期间不主动 tick，只在开始（0s）和完成时各报一次。每秒心跳重报 in_progress
- 长提示词把状态串里的耗时挤出可视区：CSS `text-overflow: ellipsis` 截掉的是耗时而非提示词。状态串重排，耗时/状态在前、提示词放最后
- ECONNRESET 错误归因笼统：所有重置都报"连接被重置"，分不清 CF JA3 拦截 / 网络问题 / API Key 无效。proxy 加 socket 三级诊断（DNS / TCP / TLS），CF 边缘 IP 段命中时明确提示"换非 CF 端点"；客户端识别 CF/TLS 关键词时不再误加"model 不支持"尾巴

**HTML 模板预览**

- PPT 预览弹窗（独立 dialog 模式）插完幻灯片后**「渲染中」徽章不消失**：`doConfirm` 中 `isPreviewDialog` 分支把任务派给 MAIN 后早 return，漏 `setHtmlPreviewBusy(false)`
- agenda 议程页的 TOC dotted leader **预览有虚线、插入到 PPT 后消失**：html2canvas 截图对 `border-style: dashed/dotted` 渲染不可靠。改成 `background-image: radial-gradient` 点阵
- 可视化编辑器**拖完元素后点别的元素没反应，要退出编辑再进**：`_editorJustDragged` 用来吃浏览器拖完后的合成 click，但 Chrome 拖距 > 5px 后根本不发那次 click，flag 卡在 true 直到下次真点击被吃掉。100ms setTimeout 自动 reset
- 可视化编辑器**hover 到 resize 把手不显示拖拽箭头光标**：`body.__lingxi_editing * { cursor: crosshair !important }` 用 `!important` 压住所有子元素。给 8 向 resize handle 单独的 `!important` 抢回
- 「编辑模式」按钮只在 freeform layout 显示：非 freeform 完全不能编辑。改成任意 layout 都可点 → 自动 `convertCurrentLayoutToFreeform()` 转换后接管

**多文件作用域**

- 历史对话 / 改动记录 / HTML 模板历史 / 组件库**所有文件混在一个池子**，切换 PPT 后还能看到别的文件的对话和模板。引入 `docKey`（用 `WpsAiBackup.getCurrentDocPath()`）严格作用域过滤；加 `startDocWatcher()` 1.5s 轮询文档切换，自动保存旧对话 + 清空 chat + 加载新文件对话

**对话 UI**

- 聊天气泡有"我"/"AI"文字标签但没头像，移动端/窄屏时占地方且不直观。加微信风圆形头像（蓝底"我"/紫底 ✨ AI），文字标签隐藏（头像已表达"谁说的"）
- 复制 / 回填按钮只在 hover 才显示：操作要先 hover 再点多一步。改为常驻 `opacity: 0.55`，hover 加深到 1
- 必填字段没视觉标识：聊天 / 图像供应商卡片的 baseUrl / apiKey / 默认模型加 `.required` 类 → CSS `::before` 注入红色 `*` 前缀

---

## v1.3.0

围绕"PDF 宿主 + 多供应商管理 + 设置弹窗化 + TaskPane 自由布局"的大版本。

### PDF 宿主接入
- 新增第四个宿主 WPS PDF（addonType=pdf），ribbon 上独立「灵犀AI」标签，安装时自动注册 plugin-pdf 变体
- AI 工具：`pdf_get_info` / `pdf_read_document`（带 maxPages/maxChars 控量）/ `pdf_read_page`
- 三个开箱即用快捷操作：**对照翻译**（原文 | 译文 markdown 表格逐段对齐 + 页码标记）/ **全文总结**（一句话概括 + 要点 + 结论 + 可追问问题）/ **文档生成 PPT**（提炼大纲 → 复制到 WPS 演示用大纲生成 PPT 一键配色）
- 附 PDF 问答 + 智能推荐操作
- **PDF 当多模态附件**：WPS Office 整合阅读模式下 jsapi 拿不到 PDF 文本，改走"把整个文件 base64 化喂大模型"路径 —— proxy 新增 `/load-local-file` + `/openai-file-upload` 端点；Anthropic 走 document content block / OpenAI 走 Files API / Codex 走 input_file
- 多版本兼容：ActivePDF / ActivePdf / ActivePDFDocument 四种命名兜底

### 多供应商 + 模型能力
- 数据模型从单 active provider 改成 `chatProviders[]` 数组，可**同时挂多家**（Codex + Anthropic + 多家 OpenAI 兼容并存）；老结构 `providers.codex/openai/anthropic` 自动迁移
- 12 条预设供应商：Codex / Anthropic / OpenAI / DeepSeek / Kimi / 通义千问 / 智谱 / 豆包 / 硅基 / OpenRouter / Ollama / 自定义，新增时弹选单自动填好 baseURL + 默认模型
- header 模型下拉按 provider 分组列出所有 enabled 模型，行内显示 🖼 图像 / 📄 PDF / 💡 思考 三个能力图标（亮=支持，灰=不支持）；当前选中按钮上同样展示 caps
- 每张供应商卡片右上 ⚡ 按钮一键拉取该家真实模型列表写入下拉缓存
- 模型能力按 model id 模式判断（`capabilities.js`）：图像 / PDF / 思考；OpenAI 兼容协议不接受 `type:"file"` 的（DeepSeek/Kimi/Qwen/GLM）从 supportsPdf 白名单移除，避免错误请求
- 思考强度可调：聊天工具栏 💡 chip 点击循环低/中/高/关，按 provider 协议映射：Anthropic `thinking.budget_tokens` 1024/4000/16000，OpenAI `reasoning_effort`，Codex `reasoning.effort`

### 设置弹窗 + TaskPane 布局
- 设置从 Tab Bar 拆出 → **独立 960×720 dialog**（`Application.ShowDialog ?mode=settings`），脱离 TaskPane 宽度限制
- 左侧侧栏 4 个分类：聊天模型 / 生图模型 / 统一配置 / 程序信息
- 每条供应商以可折叠卡片展示，head 上 ⚡ 测试 / ☑ 启用 / ▾ 展开；body 内编辑 baseURL/API Key/默认模型实时持久化
- `storage` 事件双向同步：dialog 窗口里改了 localStorage，主 TaskPane 立刻 reload settings + 重渲模型下拉
- **TaskPane 一键脱离/停靠**：Tab Bar 右侧 ↗ 按钮调 WPS DockPosition；浮动模式 480×720 居中，窗口 8 个边角带 resize 抓手

### 线性图标统一 + UI 收敛
- 全套 emoji（🖼 📄 🧠 📕 ⟳ 等）换成 feather 风格线性 SVG
- 能力 chip 从 header 挪到聊天工具栏，跟附件按钮放一起，"打字前就看到能用啥能力"
- header 简化只剩：模型选择 + 🔄 刷新 + 「就绪」徽章

### 改动追溯优化
- 文档备份恢复加 EPERM/EBUSY/EACCES 退避重试（6 次累计 ~3s），处理 Windows 文件锁释放延迟 + WeChat sandbox 锁
- 关文档后强制等 400ms 再 copyFile；恢复失败也会自动重开原文档，不让用户白屏
- 失败时给清晰指引："文件仍被占用，请关闭微信预览窗口"等

### 工具 schema 修复
- `wps_insert_table` / `wpp_add_table` 二维数组内层 `items` 补 string 类型，strict tool 校验的模型（gpt-4o-2024-08-06+ / gpt-5）不再 invalid_function_parameters

### 安装器
- PDF tab 显示在「开始」左侧（修 serve-permanent 路由正则漏 /pdf/ 的 bug 后，统一 insertBeforeMso=TabHome）
- publish.xml 写入时不再带 `debug=""` 属性
- 版本号 1.2.1-beta → 1.3.0，统一 semver

---

## v1.2.1:beta

围绕"AI 操作可控、过程可追溯、UI 更顺手"做了一大批改动。

### 对话 / UI 体验
- 多对话管理 + 顶部「+ 新对话」/「📑 历史」入口，按对话独立 localStorage 持久化
- 历史对话回放完整应答过程（推理 + 工具调用 + 结果 + 文本回复）
- 纯净模式（眼睛切换）：隐藏工具调用 / 推理块，只看 AI 文本回复
- 聊天进度条：实时显示 AI 当前在干什么
- 输入框改两层布局：上 textarea / 下工具栏
- 附件上传：图片 + 文本文件，自动检测模型多模态能力
- pill 按钮全 SVG 化，移除装饰性 emoji

### 改动可追溯
- 「改动记录」Tab：每次 AI 对文档的修改按文件分组、按对话回合折叠
- per-turn 文档级备份 + 「↶ 恢复本轮」一键回退
- 切换文档自动过滤；空态文案区分三种

### 安全 / 可靠性
- AI 工作期间锁定文档：Word + Excel 硬锁，PPT banner 兜底
- 锁定用固定 token（`lingxi-ai-doc-lock-v1`），启动时自动清理残留卡锁
- 临时文档拒绝 AI 修改型操作
- 配置导出版本化 + API Key 加密

### 生图 / 写回
- 生图进度实时显示
- markdown→Word 真表格、嵌套列表
- 修扩写段首 16 字符缩进 bug

### 设置 / 提示词
- 系统提示词字段：默认配了一段"简洁直接"规则，可一键重置

---

## v1.1.0:beta

- 永久安装升级流程：重跑 install 自动停旧服务，避免文件锁
- macOS WKWebView 缓存修复：server 加 `no-store` 严格禁缓存 + HEAD 请求不发 body
- Mac taskpane 宽度自适应
- 聊天输入框快捷键：Enter 发送、Shift+Enter 换行
- 打包 / 文档：截图等临时文件不再误打入 zip；INSTALL.md 加完整升级章节 + 8 条 FAQ

---

## v1.0.0:beta（首版）

- **永久安装**：build-variants + serve-permanent + 三宿主同时注册 + 开机自启
- **数据可视化**：6 类 SVG 图表，配色跟主题色板，darkMode 自适应
- **设计主题**：12 套带设计理念色板
- **方案 A/B 模板**：8 套形状模板 + 4 套 SVG 视觉模板
- **统一风格 / 去 AI 味**：PPT 一键统一 + 自然化改写
- **多 provider + tool-use**：Codex / OpenAI / Anthropic 三家通用
- **markdown→Word 原生格式**
- **双模式**：预览确认 / AI 直接写入
- **多 bug 修复**：Mac Gatekeeper / GBK 编码 / CRLF 行尾 / WKWebView 缓存 / vbs 自启等
