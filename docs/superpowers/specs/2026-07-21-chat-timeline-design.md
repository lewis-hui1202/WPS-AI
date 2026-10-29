# 聊天时间轴（类 Claude）设计

**日期**：2026-07-21
**目标**：把聊天记录从当前的微信风气泡布局，改成类 Claude 的「文档流 + 步骤轨道」时间轴呈现。

## 背景与现状

当前聊天区（`plugin/js/app.js` + `plugin/css/style.css`）是气泡布局：

- 用户消息：右对齐蓝气泡 + 气泡外右侧圆头像（`makeAvatarEl`）。
- AI 消息：左对齐白气泡 + 紫色 ✨ 头像。
- 工具调用：可折叠卡片，有 transient / done / aggregate 三态（`js/app.js` ~8061/8149/8184）。
- 推理（思考）：独立折叠气泡（~5046）。
- 多工具轮次：末尾补一张「轮次汇总卡」`renderTurnSummary`（~8270）。
- 快捷指令：折叠成「操作盒子」（~5082）。

核心渲染函数：`appendChatMsg`（4934）、`makeAvatarEl`（4923）、工具气泡组、`clearTransientToolBubble`（8247）、`renderTurnSummary`（8270）、`appendToolResultMsg`（8358）。

事件管线（**本设计不改**）：
- 实时：`handleStreamEvent`（~9040 起的 switch），事件类型 `reasoning_chunk / reasoning_end / assistant_chunk / assistant_text_end / assistant_text / tool_call / tool_result / done`。
- 历史回放：`appendHistoryEvent`（12938）/ `appendHistoryBlock`（12976）；v2 事件经 `WpsAiChatBlocks.fromEvents`（13048）转块后逐块渲染。

## 已确认的决策

1. **布局形态**：混合——消息走文档流（全宽、左对齐、无气泡无头像）；AI 一轮里的工具/思考步骤用竖向轨道收纳。
2. **上线方式**：完全替掉气泡，单一渲染路径（不做视图模式开关）。
3. **步骤展示**：默认收起，一行一步（图标 + 友好名 + 状态），点击展开看参数/结果。
4. **折叠粒度**：一轮结束后轨道**保持展开**，只提供**手动**整体折叠（不自动折叠）。
5. **模块化**：新拆 `plugin/js/chat/timeline.js` 承载时间轴渲染，`app.js` 调它。

## 视觉规格

**文档流消息**
- 容器 `.chat-timeline`（取代现有 `.chat-msg` 气泡容器语义）。
- 用户消息 `.tl-msg.tl-user`：浅灰圆角块 + 「你」标签，全宽左对齐。
- AI 消息 `.tl-msg.tl-assistant`：纯文档文本 + 「文小舟」标签，标签下一行浅色 meta（模型 · 时间 · token，来自现有 meta 逻辑 ~8979）。
- 报错：文档流里的红条（保留 `friendlyMultimodalError` 等友好文案）。

**AI 步骤轨道 `.tl-rail`**
- AI 回复区左侧一条竖线（CSS 伪元素或独立列），步骤按发生顺序挂成节点 `.tl-step`。
- 节点收起态：`图标 + 友好名 + 状态徽标`（running=转圈 / ok=✓ / err=✗），一行。
- 节点展开态（点击）：显示参数与结果（复用现有 `summarizeToolResult` / 工具结果渲染）。
- 思考步骤 `.tl-step.tl-reasoning`：一行「已思考」，展开看思考过程。
- 最终回答：接在轨道末尾的 AI 文档文本。
- 轨道头部有一个手动折叠控件：折叠后整条轨道收成一句小结（「N 步 · 已完成」），再点展开。默认展开。

**快捷指令操作盒子**
- 用户轮若来自 ribbon 快捷指令：一行（按钮文字）可展开看完整提示词，文档流样式。保留现有 quickAction 透传逻辑。

**图标/配色**：沿用现有线性 SVG 图标集 + WPS 蓝主色（遵循项目既有 UI 规范）。

## 架构与数据流

**新增模块 `plugin/js/chat/timeline.js`**（挂 `window.WpsAiChatTimeline`，与其它 `js/chat/*.js` 一致的 IIFE + window 导出，vm 可测）。职责：把「一次事件/一个历史块」渲染成时间轴 DOM 片段。对外接口（示意，实现计划细化）：

- `renderUserMessage({ text, quickAction }) -> HTMLElement`
- `beginAssistantTurn() -> turnHandle`（创建 AI 消息容器 + 空轨道）
- `turnHandle.addReasoning() / appendReasoning(delta) / endReasoning()`
- `turnHandle.startToolStep(name) -> stepHandle` / `stepHandle.finish(result)`
- `turnHandle.appendAssistantText(delta)` / `turnHandle.finalizeText()`
- `turnHandle.setCollapsed(bool)`（手动折叠整条轨道）
- `renderErrorNode(turnHandle | container, message)`

**数据流**：事件管线不变。`handleStreamEvent`（实时）与 `appendHistoryEvent` / `appendHistoryBlock`（回放）都改成调用 `WpsAiChatTimeline` 的对应方法产出 DOM，**替换**原来产出气泡 DOM 的调用。实时与回放走同一套 timeline 接口 → 呈现一致（关键不变量）。

**剥离原则**：timeline.js 只负责「事件/块 → DOM」，不持有 app.js 的会话状态。它接收纯数据入参、返回/操作 DOM 节点；app.js 保管 `turnHandle`、串联事件。若某处渲染强依赖 app.js 内部状态（如 els、流式游标）剥不干净，则该处保留在 app.js、只把纯展示片段委托给 timeline.js，不硬拆。

**移除**：`makeAvatarEl` 及头像相关 CSS；气泡对齐/背景 CSS；工具 transient/aggregate 三态复杂度可简化为轨道节点的 running/done 两态；`renderTurnSummary` 卡片由「可折叠轨道 + 小结头」取代。

## 影响面

- 改：`plugin/js/app.js`（渲染调用点：`appendChatMsg`、工具/推理/汇总渲染、`handleStreamEvent` 事件分支、历史回放分支），`plugin/css/style.css`（chat 段大改），`plugin/main.js`（加载 `js/chat/timeline.js`，在 app.js 前）。
- 新增：`plugin/js/chat/timeline.js`、对应测试。
- 不碰：事件管线本身、持久化、长对话压缩、跨对话记忆、provider 层。

## 测试

- 渲染是 WebView DOM，难做端到端单测；重点：
  - 保证现有 `test/chat-blocks.test.js` / `test/chat-events.test.js` 仍绿（事件→块映射不变）。
  - 为 `timeline.js` 的纯逻辑部分（如「事件序列 → 轨道节点结构/状态机」、折叠状态、quickAction 展开）加 vm 单测。
  - 视觉与交互（实时流式、历史回放长得一致、折叠/展开、步骤展开看参数）由用户在 WPS 内实测确认。

## 明确不做（YAGNI）

- 不做「气泡 / 时间轴」视图切换开关（已决定完全替掉）。
- 不做轨道自动折叠（已决定仅手动）。
- 不改事件协议、不动持久化格式。
- 不引入新图标风格/配色，沿用现有。
