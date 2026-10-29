<h1 align="center">文小舟 · WPS Office 多宿主 AI 助手</h1>

<p align="center">
  <b>品牌更名提醒：为避免与 WPS 官方插件名称混淆，本插件已由“灵犀AI”更名为“文小舟”。</b>
</p>

<p align="center">
  一个 TaskPane 兼容 <b>WPS 文字 / 表格 / 演示 / PDF</b> 四端的 AI 助手，挂多家 AI（Codex / OpenAI / Anthropic / Gemini / Azure / OpenAI 兼容），AI 通过工具调用<b>直接读写文档</b>。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/WPS-文字·表格·演示·PDF-red" alt="WPS" />
  <img src="https://img.shields.io/badge/vibe--coded-100%25-ff69b4" alt="Vibe Coded" />
</p>

<p align="center">
  <a href="https://wps-ai.llteac.cn/download"><b>⬇ 下载</b></a> ·
  <a href="#-5-分钟上手">5 分钟上手</a> ·
  <a href="#-功能一览">功能一览</a> ·
  <a href="#-项目结构">项目结构</a> ·
  <a href="#-二次开发">二次开发</a> ·
  <a href="#-已知限制">已知限制</a> ·
  <a href="README.en.md">English</a>
</p>

> 🤖 100% 由 Vibe coding 完成：架构、provider 适配、PPT 主题/图表、Word 渲染、跨平台安装器、文档全程由 [Claude](https://claude.com/claude-code) 和人类对话迭代而来。仓库里没有一行手敲代码 —— 也欢迎你 fork 自己 vibe。

<p align="center">
  <img src="img/1.png" width="32%" />
  <img src="img/2.png" width="32%" />
  <img src="img/3.png" width="32%" />
</p>

---

## ✨ 亮点

| 🖥 多宿主统一 | 🔌 多协议接入 | ✍️ 直接读写文档 |
|---|---|---|
| 文字 / 表格 / 演示 / PDF 四端共用一套 TaskPane，宿主自动分发 | Codex / OpenAI / Anthropic / Gemini / Azure / OpenAI Responses + 本地 Ollama，可同时挂多家随时切 | AI 通过工具调用直接操作文档；**预览确认** / **AI 直接写入** 两档安全 |

## 🧭 架构

```text
WPS 宿主（文字/表格/演示/PDF）
        │  JSAPI
   TaskPane（WebView）── app.js / hosts / tools / providers 门面
        │  fetch（本地回环）
   proxy-server.js（Node）── CORS 代理 · 文件/备份 · MCP Server/Client 端点
        │
   AI Providers（Codex / OpenAI / Anthropic / Gemini / Azure / Responses / 兼容）
   外部 MCP 服务（stdio / SSE）← MCP Client
```

---

## ⚡ 5 分钟上手

### 1. 下载安装包

前往 **[下载页 → wps-ai.llteac.cn/download](https://wps-ai.llteac.cn/download)** 获取对应平台安装包。各平台包都内置 Node 运行时，**无需单独装 Node**。

| 平台 | 安装包 | 大小 | 下载 |
|---|---|---|---|
| **Windows** | `.exe` 安装器 | ~30 MB | [⬇ 下载](https://wps-ai.llteac.cn/download) |
| **macOS** | `.pkg`（Intel + Apple Silicon） | ~35 MB | [⬇ 下载](https://wps-ai.llteac.cn/download) |
| **Linux** | x64 / arm64 | ~35 MB | [⬇ 下载](https://wps-ai.llteac.cn/download) |

### 2. 安装

- **Windows**：先临时关掉杀软实时防护 → 双击 setup.exe → 完全退出 WPS → 重开 WPS，ribbon 出现「文小舟」标签即成功
- **macOS**：**右键 .pkg → 打开**（Gatekeeper 拦未签名包，双击会报错）→ 输系统密码 → 完全退出 WPS → 重开 WPS

详细步骤（卸载 / 升级 / 故障排查 / 安装器构建）见 [INSTALL.md](INSTALL.md)。

### 3. 配置 AI 模型

1. ribbon 点「打开文小舟」→ TaskPane 右侧弹出 → ⚙ 设置（独立弹窗）
2. 「聊天模型」面板 → **+ 新增供应商** → 15 条预设里选一家（baseURL 已预填）
3. 填 API Key → ⚡ 测试 → 关弹窗 → header 下拉挑模型开聊

**可同时挂多家**：DeepSeek + Anthropic + Codex + Gemini 一起开，下拉里随时切。

| 预设 | 说明 |
|---|---|
| **Codex（ChatGPT OAuth）** | 走 OAuth，无需 Key |
| **Anthropic** / **OpenAI** | Claude Messages / Chat Completions |
| **Gemini** | Google 原生 `generateContent`（`x-goog-api-key`） |
| **Azure OpenAI** | 资源 endpoint + 部署名 + api-version |
| **OpenAI Responses** | 通用 `/responses`（API Key，非 OAuth） |
| **DeepSeek / Kimi / Qwen / GLM / 豆包 / 硅基 / OpenRouter** | 各家 OpenAI 兼容协议 |
| **本地 Ollama** | `http://localhost:11434/v1`（免 Key） |
| **自定义** | URL + Key 自填 |

#### 系统要求

| 项 | Windows | macOS | Linux |
|---|---|---|---|
| **操作系统** | Windows 10 / 11 (x64) | macOS 10.15 Catalina+ (Intel + Apple Silicon) | 主流发行版 (x64 / arm64) |
| **WPS** | WPS Office 12.x+ | WPS Office 5.x+ | WPS Office for Linux 11.1+ |
| **运行时** | 内置便携 Node 22.x | 内置 darwin-x64 + arm64 Node | 内置 linux-x64 + arm64 Node |

不支持 WebOffice、移动端 WPS、低版本桌面客户端 —— JSAPI 加载项要求桌面客户端 + 上述最低版本。

---

## 🧩 功能一览

### AI 接入

- 同时挂多家 chat provider，header 下拉按 provider 分组随时切
- **6 类协议原生适配**：Codex / OpenAI Chat Completions / Anthropic Messages / **Gemini** / **Azure OpenAI** / **通用 OpenAI Responses**，外加各家 OpenAI 兼容聚合器 —— 共 15 条预设 + 一条自定义
- 思考（reasoning）**按到达顺序实时回显**，按 provider 映射 `thinking.budget_tokens` / `reasoning_effort` / `reasoning.effort` / `thinkingConfig`
- 模型能力图标：🖼 图像 / 📄 PDF / 💡 思考（models.dev 目录 + 名字正则兜底）
- 流式输出 + tool-use 循环：一次对话内连续调多个工具操作文档
- **预览确认模式** vs **AI 直接写入模式**：两档安全
- PDF 当多模态附件喂大模型（Claude document block / OpenAI Files API / Codex input_file）

### MCP（双向）

- **MCP Server**：把 WPS 工具暴露给外部 agent（Claude Code CLI / Claude Desktop / Cursor），配置 JSON 一键复制
- **MCP Client**：连接外部 MCP 服务（本地 stdio 子进程 / 远程 SSE），把它们的工具纳入 AI 对话，命名空间 `mcp__<服务>__<工具>`；支持启停开关 / 查看工具清单与参数 / 测试连接 / 从 JSON 一键导入

### 对话 / 时间轴

- **Claude-code 风格时间轴**：推理 / 工具调用 / 文本回复交织，rail 节点圆点 + 每步耗时；实时展示 == 历史回放完全一致
- 多对话管理 + 历史独立弹窗（今天 / 7 天内 / 7 天前 分组）
- 生图独立 tab；工具调用气泡默认只显示尾部参数预览，结果到达即收起（设置里可开完整 JSON 日志）
- AI 工作期间文档锁定 banner + 进度合并
- 系统提示词可定制；「技能」（内置 4 套 + 导入 .md/.txt）按场景拼进 system prompt

### 操作安全

- AI 工作期间硬锁文档（Word `Document.Protect` / Excel `UserInterfaceOnly`）
- 临时文档拒绝修改（聊天前 fail-fast）
- per-turn 文档备份 + 一键回退（自动 GC 最近 20 份）
- **改动记录 Tab**：按文件分组，展开看入参 / 前后快照 / 错误
- 配置导入导出（API Key 加密 + 版本兼容）

### 宿主能力

| 宿主 | 能力速览 |
|---|---|
| **文字** | 6 组快捷按钮（写作 / 改写 / 润色 / 翻译 / 总结 / 智能）+ markdown→Word 原生格式（真表格 + 嵌套列表 + 段落缩进清零）+ 扫描红字/高亮/底纹 + 批量清格式 + 读取批注 |
| **表格** | 单元格 / 范围读写、批量格式化、表格美化、列宽自适应、AI 生成公式 / 转表 / 校对、读取批注 |
| **演示** | 50+ 套带设计理念色板 + 8 套形状模板 + 4 套 SVG 视觉模板 + 6 类图表 + 大纲生成 PPT + HTML 模板系统（17 套 layout）+ 可视化编辑器（拖拽 / 8 向 resize / 多选 / PS 风对齐参考线 + 吸附）+ ECharts + 读取批注 |
| **PDF** | 对照翻译（原文/译文表格）+ 全文总结 + 生成 PPT 大纲 + PDF 问答 + 智能推荐操作 |

---

## 🗂 项目结构

```text
plugin/
├── taskpane.html                   # 业务 UI 入口
├── main.js                         # 脚本加载器（声明式 scripts[]）
├── manifest.json / ribbon.xml      # 插件声明 + ribbon
├── css/style.css
├── js/
│   ├── app.js                      # 业务 UI 编排（对话主循环 / 设置 / 时间轴接线）
│   ├── openai.js                   # provider 门面（按 config.type 转发）
│   ├── wps.js / hosts/*            # 宿主分发 + jsapi 桥接（writer / spreadsheet / presentation / pdf）
│   ├── providers/                  # provider 层
│   │   ├── registry.js             #   注册表 + 15 家预设 + 设置存储
│   │   ├── openai.js               #   OpenAI 兼容 + Azure
│   │   ├── anthropic.js            #   Anthropic Messages
│   │   ├── codex.js                #   Codex（ChatGPT OAuth）Responses
│   │   ├── gemini.js               #   Gemini 原生
│   │   ├── openai-responses.js     #   通用 OpenAI Responses
│   │   ├── capabilities.js         #   模型能力检测 + 思考参数
│   │   └── image.js                #   图像 provider
│   ├── tools/*                     # AI 可调用工具（按宿主分组 + registry）
│   ├── chat/timeline.js            # 对话时间轴（实时 == 回放）
│   ├── html-templates/*            # PPT 模板系统（cache / components / renderer / studio）
│   ├── mcp-client.js / mcp-client-ui.js   # MCP Client（plugin 侧）
│   ├── mcp-bridge.js               # MCP Server 桥（plugin 侧）
│   ├── history.js                  # 改动记录 + 快照
│   └── skills.js                   # 技能（内置 + 导入）
└── tools/
    ├── proxy-server.js             # CORS 代理 + 文件 / 备份 / MCP 端点
    ├── mcp-client-manager.js       # MCP Client 连接管理（stdio / SSE，Node 侧）
    ├── mcp-server.js               # stdio MCP server（供外部 agent 用）
    ├── serve-permanent.js          # 永久模式静态服务器
    ├── build-variants.js           # 多宿主变体打包
    └── dev.js / gen-ribbon.js
```

---

## 🛠 二次开发

```bash
cd plugin
npm install
npm run dev:wps   # 或 dev:et / dev:wpp / dev:pdf
```

会同时拉起 CORS 代理（3890）和 wpsjs debug（3889），WPS 自动唤起。

**加新工具** —— 编辑 `js/tools/<host>.js`：

```js
registry.registerTool({
  name: "wps_my_tool",
  hosts: ["wps"],                // 或 ["wps","et","wpp","pdf"]
  description: "...",            // 越清楚 AI 越知道何时调
  parameters: { type: "object", properties: { /* ... */ }, required: [] },
  handler: async (params) => ({ ok: true })
});
```

**加新 provider** —— 新建 `js/providers/<name>.js`，实现 `runWithTools` 等接口后 `WpsAiProviderRegistry.register("<type>", createFn)` 自注册，主链路零改动（详见 `gemini.js` / `openai-responses.js`）。

**加新 ribbon 按钮** —— 编辑 `js/quick-actions.js`，跑 `npm run gen-ribbon`。

**永久模式打包** —— `node tools/build-variants.js --out <dist 目录>`。

---

## ⚠️ 已知限制

- **WPS 26884 及以后的版本存在兼容性问题，待修复**（跟进中）
- WPS 桌面客户端专用，Web / Mobile WPS 均不支持
- Mac WPS WKWebView 永久模式重装后偶尔需清 WebKit 缓存（见 [INSTALL.md](INSTALL.md) Q7）
- `wpsjs debug` 一次只能注册一个宿主，调试切宿主要重启
- Codex OAuth 是非官方复用方案，OpenAI 调整授权策略时可能需更新 `client_id`
- Azure 需自填资源 endpoint + 部署名 + api-version；Gemini 图片输入仅支持 base64 内联
- 图像 provider 协议绑定 toapis，换其他服务需在 `providers/image.js` 适配

---

## 💬 反馈

### 加入粉丝群

扫码关注公众号，回复 `ai` 获取粉丝群链接，和其他用户交流或反馈 Bug：

<img src="img/qrcode_for_gh_e26e731fb54c_258.jpg" alt="公众号二维码" width="160" />

> 微信扫码 → 关注公众号 → 回复 `ai` → 进粉丝群

### Bug 上报信息

发现 Bug 请在群内附上：

- 系统 + WPS 版本
- 哪个宿主、哪个工具触发
- 控制台报错（TaskPane 内右键 → 检查 / 「打开 JS 调试器」）
- `~/.lingxi-ai/server.log` 后 50 行（永久模式）

---

## ⚖️ 许可协议

本项目基于 **[MIT License](LICENSE)** 开源 —— 可自由使用、修改、分发、商用，保留版权与许可声明即可。

> 品牌名称「文小舟」、公众号二维码及截图等资产不在 MIT 授权范围内，仅用于标识本项目。
