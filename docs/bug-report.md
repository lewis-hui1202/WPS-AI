# 潜在问题记录

此文档用于记录代码审查中发现的潜在问题和改进点。

## 1. OpenAI 请求缺少超时和取消机制

- **文件**: `plugin/js/openai.js`
- **问题**: `chatCompletion` 和 `streamChatCompletion` 函数在发起网络请求时，没有实现超时控制或传递 `AbortSignal` 以便取消请求。
- **影响**: 如果 OpenAI API 响应缓慢或网络不稳定，程序可能会长时间等待，导致用户界面无响应，用户也无法主动取消操作，影响体验。
- **建议**: 为这些请求增加超时逻辑（例如使用 `Promise.race`），并允许传递 `AbortSignal` 以便可以从外部取消请求。

## 2. 2026-07-08 安全扫描问题核验

- **验证命令**: `npm audit --json`（分别在 `plugin`、`site`、`upload-oss` 执行）、`npm run scan:semgrep`、`npm run lint:eslint`
- **总体结论**: NPM audit 确认存在 4 个 high 漏洞、0 个 critical；Semgrep 确认 18 个 finding；ESLint 未报错。

### 2.1 NPM 依赖审计

- **状态**: 确认存在。
- **`plugin`**: 3 个 high。
  - `pdfjs-dist@3.11.174` 是直接依赖，命中 `GHSA-wgrm-67xf-hhpq`，恶意 PDF 可能触发任意 JavaScript 执行；audit 建议升级到 `pdfjs-dist@6.1.200`，属于 semver major。
  - `@mapbox/node-pre-gyp@1.0.11` 是 `canvas@2.11.2` 的 optional 传递依赖，继续依赖 `tar@6.2.1`。
  - `tar@6.2.1` 命中多条 high 路径穿越、任意文件覆盖/读写类 advisory。
- **`site`**: 1 个 high、1 个 low。
  - `archiver-utils -> glob@10.4.5` 命中 high：glob CLI 的 `-c/--cmd` 存在命令注入风险。
  - `@nuxt/vite-builder/node_modules/esbuild@0.27.7` 与 `vite-node/node_modules/esbuild@0.27.7` 命中 low：Windows dev server 任意文件读取问题。
- **`upload-oss`**: audit 结果为 0 个漏洞。
- **建议**: 优先升级 `pdfjs-dist` 并做 PDF 预览/解析回归；刷新 `plugin/package-lock.json` 中 `canvas/@mapbox/node-pre-gyp/tar` 链路；升级 `site` 的 Nuxt/archiver 相关依赖或等待上游锁到安全的 `glob`/`esbuild` 版本。

### 2.2 Semgrep: raw HTML / XSS 类问题

- **状态**: 部分确认，且存在比 Semgrep 摘要更明确的自由 HTML 执行面。
- **Semgrep 命中**: `plugin/js/html-templates/templates/studio.js` 共 8 个 `raw-html-format` finding，位置包括 308、675、895、900、901、970、1039、1045 行。
- **人工核验**:
  - 固定 layout 中大部分用户文本已通过 `escapeHtml` / `multilineHtml` 转义，Semgrep 对这些位置存在一定误报成分。
  - `studio.js` 的 `freeform` layout 明确把 `data.html` 和 `data.css` 原样拼入 HTML/CSS（1286-1322 行），这是实际的未净化输入入口。
  - `renderer.js` 通过 `iframe.srcdoc = html` 挂载生成内容；iframe 设置了 `sandbox="allow-same-origin"`，普通 `<script>` 不会直接执行。
  - 但 `renderer.js` 会读取 `canvas[data-canvas-draw]` 并用 `new Function(...)` 执行属性里的代码（157-164 行）。如果 freeform HTML 来自 AI 或用户输入，这里会形成可执行 JavaScript 注入面。
- **影响**: 恶意或被提示注入的 freeform 内容可能执行渲染器上下文中的 JavaScript，风险高于单纯“字符串注入 DOM”。即使禁用了 iframe 内脚本，`data-canvas-draw` 仍绕过了这层保护。
- **建议**: 对 freeform HTML/CSS 做白名单净化；移除或改造 `data-canvas-draw`，用声明式绘图 schema 替代任意 JS；如果必须保留，至少只允许受信来源开启，并为恶意 `<script>`、事件属性、`data-canvas-draw` 增加回归测试。

### 2.3 Semgrep: child_process / 命令注入类问题

- **状态**: finding 确认存在，但大部分不是远端输入直接拼 shell 的命令注入；可利用性偏低或需要本机环境可控条件。
- **`plugin/tools/chromium-fetch.js:301`**: `spawn(resolved.executablePath, args)` 的可执行路径可受 `LINGXI_CHROMIUM_PATH` / `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` 环境变量影响。参数数组未走 shell，URL 不会变成 shell 片段；主要风险是本机环境变量劫持可执行文件。
- **`plugin/tools/clipboard.js:63,78,94`**: 剪贴板命令按平台固定，参数以数组传入；macOS 图片路径作为 `osascript` argv 传递，图片类型来自小白名单。未发现典型 shell 拼接注入。
- **`plugin/tools/dev.js:42,206`**: `spawnLabeled` 接收内部传入的固定命令；Linux WPS 启动命令来自 `addonType` 映射。Windows 下 `shell: true` 用于 `.cmd/.bat`，需保持命令来源只走白名单。
- **`plugin/tools/proxy-server.js:86,287`**: `execSafe` / `runSaveAsCommand` 是通用封装，当前调用点多为固定命令。`/bin/sh -c "ioreg ... | awk ..."` 是静态字符串，不含用户输入；保存对话的 AppleScript/PowerShell 字符串有转义处理。
- **建议**: 为这些封装补充命令白名单和注释；能不用 shell 的地方改成直接执行二进制并在 JS 内解析输出；对环境变量指定的浏览器路径做绝对路径、存在性、文件类型校验。确认可接受的静态分析误报可加 Semgrep ignore，并附带理由。

## 3. 2026-07-10 WPS PDF Ribbon 图标不显示

- **状态**: 未解决，需继续排查。
- **现象**: macOS WPS PDF 宿主中，灵犀 AI Ribbon 按钮点击可触发功能，但按钮图标仍不显示。
- **已验证**:
  - PDF 对照翻译、全文总结、PDF 问答等按钮的 `OnAction` 能进入插件逻辑。
  - 本地静态服务可返回 `images/ai.png`、`images/icons/*.png`。
  - 已尝试在 `ribbon.xml` 增加静态 `image="...png"`，并让 `GetImage_*` 返回绝对 URL，但用户复测仍未显示图标。
  - dev 日志中能看到 `early.getImageById`，但没有稳定观察到 WPS 后续请求图标 PNG。
- **影响**: PDF 宿主 Ribbon 可用性不受影响，但按钮视觉提示缺失。
- **后续方向**: 核对 WPS PDF 对自定义 Ribbon 图标的支持格式和缓存策略；尝试 `imageMso` / base64 图标 / 宿主安装包内相对资源路径；确认是否是 PDF 宿主独有的 Ribbon 图标限制。
