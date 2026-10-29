# Token 消耗面板设计

日期：2026-07-02
状态：已确认，待实现

## 背景与目标

插件目前完全不记录 token 用量（provider 不解析响应里的 `usage`，会话统计只用轮次 + wall-time）。目标：**从各 provider 抓取 usage（输入/输出 token），聚合持久化，并在设置里新增「Token 消耗」面板**，按模型分组展示累计用量，让用户知道每个模型烧了多少 token。

## 范围

- 两部分：(A) provider 捕获 usage + 中央 store；(B) 设置面板新增 tab + 展示。
- 覆盖所有走 provider 的 AI 调用（chat / streamChat / runWithTools）：聊天、选区预览、排版预览、快捷操作全部自动计入。
- 仅 token 数（输入/输出/总计/调用次数）；**不做成本估算**（YAGNI）。
- 按**模型**分组（行内展示 provider 名）。

## A. 捕获 + 存储

### 中央 store `plugin/js/token-usage.js`（新增，仿 history.js / conversations.js）

- 持久：localStorage 键 `lingxi_token_usage_v1`，结构 `{ [modelKey]: { model, provider, input, output, total, calls, lastAt } }`。`modelKey` = `provider::model`（同名模型跨 provider 分开统计；provider 缺省用 "unknown"）。
- 会话小计：内存 `{ input, output, total, calls }`，页面刷新清零。
- 多宿主并发一致性：每次 `record` 都做 **read-modify-write**——即时读盘 → 对 `provider::model` 项累加 → 立即写回。token 记录频率低（一次 AI 调用一条），read-modify-write 成本可忽略，且天然避免 4 个宿主 TaskPane 共享同一 localStorage 时的整表覆盖丢数据（对齐之前 history/conversations 修的 B31）。不在内存缓存整表（避免陈旧），会话小计单独在内存累加。
- API：
  - `record({ provider, model, input, output })`：input/output 为非负数字；`total = input + output`；读盘→对 `provider::model` 项累加 input/output/total/calls、更新 lastAt→写盘；同时累加会话小计；触发 onChange。input+output 均为 0 或非数字时忽略。
  - `getBreakdown()`：返回按 total 降序的数组 `[{ model, provider, input, output, total, calls, lastAt }]`（读盘）。
  - `getTotals()`：返回 `{ input, output, total, calls }`（对 breakdown 求和）。
  - `getSession()`：返回本会话小计。
  - `clear()`：清 localStorage 键 + 会话小计置零 + onChange。
  - `onChange(fn)` / `offChange(fn)`：订阅变更（UI 实时刷新）。
- localStorage 读写 try/catch；解析失败当空。

### provider 抓 usage（调 `global.WpsAiTokenUsage?.record(...)`）

每个 provider 在拿到 usage 后 record。字段映射：input=prompt/input tokens，output=completion/output tokens。`provider` 取该 provider 的 config.label（无则 provider 类型名，如 "openai"/"anthropic"/"codex"）；`model` 取本次请求 model。

- **openai.js**：
  - `chat`（非流）：`payload.usage.prompt_tokens` / `payload.usage.completion_tokens`。
  - `streamChat` / `runWithTools`（SSE）：请求 body 加 `stream_options: { include_usage: true }`；SSE 末尾会有一个 `choices: []` 且带 `usage` 的 chunk，在 SSE 回调里捕获 `payload.usage` 并在流结束后 record。
- **anthropic.js**：
  - SSE：`message_start` 事件 `payload.message.usage.input_tokens`；`message_delta` 事件 `payload.usage.output_tokens`（累计到最后）。流结束后 record。
  - `chat`（非流）：`payload.usage.input_tokens` / `output_tokens`。
- **codex.js**：
  - SSE `runWithTools` / `streamChat`：`response.completed` 事件 `payload.response.usage.input_tokens` / `output_tokens`。
  - `chat`（非流）：`payload.usage`（同 Responses 结构）。
- provider 未返回 usage（部分兼容网关）→ 不 record。
- runWithTools 多轮：每轮请求各自 record（累加即可）。

## B. UI 面板

### taskpane.html

- 在侧栏 `data-settings-panel="mcp"` 的 tab 与 `data-settings-panel="about"`（程序信息）的 tab **之间**插入新 tab：
  ```html
  <button type="button" class="settings-sidebar-btn" data-settings-panel="tokens" role="tab">
    <svg …线性图标…></svg><span>Token 消耗</span>
  </button>
  ```
- 在 panel 区插入 `data-settings-panel="tokens"` 的 section：
  - 顶部 panel-header「Token 消耗」+ 右侧「清零」按钮（`id="tokenUsageClearBtn"`）。
  - 总计卡片区（`id="tokenUsageTotals"`）：总输入 / 总输出 / 总计 / 调用次数；下面一行本会话小计（`id="tokenUsageSession"`）。
  - 分组表（`id="tokenUsageTable"`）：列 = 模型 / provider / 输入 / 输出 / 总计 / 次数，按总计降序；空态显示「暂无记录」。

### app.js

- 渲染函数 `renderTokenUsagePanel()`：读 `WpsAiTokenUsage.getTotals/getSession/getBreakdown` 填充 totals/session/table；空 breakdown 显示空态。
- 切到 tokens tab 时渲染一次（复用现有 settings-sidebar tab 切换逻辑：找到 tab 切换 handler，加 tokens 分支调 renderTokenUsagePanel）。
- 「清零」按钮：确认后 `WpsAiTokenUsage.clear()` + 重渲染。
- `WpsAiTokenUsage.onChange(renderTokenUsagePanel)`：面板可见时实时刷新（不可见也可刷，代价小）。
- 数字用千分位格式化（复用/新增小 helper）。

### main.js

- 在加载其它 js（history.js 等）的位置加载 `js/token-usage.js`（在 providers 之前，保证 provider record 时 store 已就绪）。

### css/style.css

- token 面板的 totals 卡片 + 表格样式，复用现有 about/mcp 面板视觉（卡片、muted 文本、表格线）。

## 数据流

```
AI 调用 → provider.chat/streamChat/runWithTools
  → 解析响应 usage → WpsAiTokenUsage.record({provider, model, input, output})
  → localStorage 累加(按 provider::model) + 会话小计 + onChange
面板可见 → renderTokenUsagePanel 读 store → 总计卡 + 本会话 + 分组表
```

## 错误处理

- provider 无 usage → 不 record，不报错。
- record 收到非数字/负数/全 0 → 忽略。
- localStorage 读写失败 → try/catch，退化为不持久（当次内存仍累加会话小计）。
- store 未加载（`WpsAiTokenUsage` undefined）→ provider 的 `?.record` 空调用，不影响主流程。

## 测试

- **单测**（node:test + vm，`plugin/test/`）：`token-usage.js`
  - record 累加：两次 record 同 model → input/output/total/calls 正确累加。
  - 分组：不同 provider 同名 model → 两条；`getBreakdown` 按 total 降序。
  - getTotals 求和正确；getSession 只反映本进程 record。
  - 忽略非法：全 0 / 非数字 record 不产生条目。
  - clear() 清空 + getBreakdown 返回空。
  - （用可注入的 localStorage stub：测试里给 sandbox 提供一个内存 localStorage 对象。）
- **手动 WPS 验证**：跑几次聊天/选区操作/排版后，面板显示真实 token（与模型控制台对得上量级）；换模型后分组正确;清零生效;provider 不吐 usage 时不崩、面板不虚增。

## 上限 / 常量

- 无条数上限（按模型聚合，模型数量天然有限）。
- 数字非负整数。

## 非目标（YAGNI）

- 成本估算 / 定价配置。
- 图表、导出、按时间趋势。
- 每轮明细列表（本设计只按模型聚合 + 会话小计）。
