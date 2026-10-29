// ============================================================================
// app.js —— 文小舟 WPS 主脚本
// 大文件 (~15k 行)，按 // ===== 分节：
//   1. Boot / mode 检测 / IPC 常量        (top)
//   2. 预览日志 / 消息提示 / 文档锁定
//   3. Header status / Tabs / Settings
//   4. Provider 卡片 / Codex OAuth / Image providers
//   5. Chat 主循环 (runChatTurn / retry / thinking indicator)
//   6. AI 排版预览 / 选区翻译预览
//   7. 工具气泡 (瞬态 + 折叠详情)
//   8. Chat panel UX (slash / @ / model override / session stats)
//   9. Settings I/O / 导入导出 / 加密
//  10. PPT 风格 / 大纲 / 全部辅助 modal
//  11. 缓存管理 UI / Skills UI / MCP UI
//  12. 更新检测 / 灰度徽章 / 设备 SN
//  13. DOMContentLoaded init（末尾）
//
// 已抽出成独立文件的模块（不在此维护）：
//   - runtime / cache / history / backup / doc-lock : plugin/js/*.js
//   - providers/ : chat + image provider adapters
//   - tools/ : per-host tool registry
//   - hosts/ : host-specific helpers
//   - mcp-bridge, skills, conversations, materials 等
//
// 目标：后续把 8/10/11 三块继续独立文件抽出（chat-ui.js / preview-ui.js /
//   cache-ui.js / mcp-ui.js / skills-ui.js），app.js 目标 <10k 行。
// ============================================================================
(function attachApp(global) {
  "use strict";

  const els = {};
  let currentSettings = null;
  let currentHostInfo = null;

  // ?mode=settings：当前页是不是被 Application.ShowDialog 打开的独立设置窗口
  const isSettingsDialog = /[?&]mode=settings(?:&|$)/i.test(window.location.search);
  // ?mode=preview：当前页是不是被 Application.ShowDialog 打开的独立预览窗口
  const isPreviewDialog = /[?&]mode=preview(?:&|$)/i.test(window.location.search);
  // ?mode=stylepreset：当前页是不是被 Application.ShowDialog 打开的独立 PPT 风格设置窗口
  const isStylePresetDialog = /[?&]mode=stylepreset(?:&|$)/i.test(window.location.search);
  // ?mode=materials：当前页是不是被 Application.ShowDialog 打开的独立素材库窗口
  const isMaterialsDialog = /[?&]mode=materials(?:&|$)/i.test(window.location.search);
  // ?mode=conversations：被 ShowDialog 打开的独立「历史对话」窗口（脱离面板、浮在文档上）
  const isConversationsDialog = /[?&]mode=conversations(?:&|$)/i.test(window.location.search);
  // ?mode=quickprompt：当前页是不是被 Application.ShowDialog 打开的 ribbon 快捷输入窗口
  const isQuickPromptDialog = /[?&]mode=quickprompt(?:&|$)/i.test(window.location.search);
  // ?mode=formatpreview：当前页是不是被 Application.ShowDialog 打开的 AI 排版预览窗口
  const isFormatPreviewDialog = /[?&]mode=formatpreview(?:&|$)/i.test(window.location.search);
  // ?mode=selectionpreview：当前页是不是被 Application.ShowDialog 打开的选区处理预览窗口
  const isSelectionPreviewDialog = /[?&]mode=selectionpreview(?:&|$)/i.test(window.location.search);
  // ?mode=paralleltranslate：被 Application.ShowDialog 打开的独立「对照翻译」窗口（脱离面板宽度）
  const isParallelTranslateDialog = /[?&]mode=paralleltranslate(?:&|$)/i.test(window.location.search);

  // 独立预览窗口与主 TaskPane 之间的 IPC：用 localStorage 传 state + 结果
  const PREVIEW_DIALOG_REQUEST_KEY = "lingxi_html_preview_dialog_request_v1";
  const PREVIEW_DIALOG_RESULT_KEY = "lingxi_html_preview_dialog_result_v1";
  // 修 B32：阻塞式 ShowDialog 的 WPS 版本下，dialog 关闭后主窗口会"同步读 RESULT 并插入"，
  // 而排队的 storage 事件监听器随后又会"再插一次"。用这个签名做去重：同步路径消费某个
  // RESULT 字符串时记下它，storage 监听器发现 newValue 相同就跳过。
  let _consumedPreviewResultSig = "";
  // 非阻塞 ShowDialog 的 WPS 版本下用：dialog 写"待执行任务"到这里 → MAIN 用 storage 事件接住
  const PREVIEW_DIALOG_PENDING_INSERT_KEY = "lingxi_html_preview_pending_insert_v1";
  const CONVERSATIONS_DIALOG_REQUEST_KEY = "lingxi_conversations_dialog_request_v1";
  const MATERIAL_DIALOG_INSERT_KEY = "lingxi_material_dialog_insert_v1";
  const MATERIAL_DIALOG_MODIFY_KEY = "lingxi_material_dialog_modify_v1";
  const QUICK_PROMPT_DIALOG_REQUEST_KEY = "lingxi_quick_prompt_dialog_request_v1";
  const QUICK_PROMPT_DIALOG_RESULT_KEY = "lingxi_quick_prompt_dialog_result_v1";
  const FORMAT_PREVIEW_DIALOG_REQUEST_KEY = "lingxi_format_preview_dialog_request_v1";
  const FORMAT_PREVIEW_DIALOG_RESULT_KEY = "lingxi_format_preview_dialog_result_v1";
  const SELECTION_PREVIEW_DIALOG_REQUEST_KEY = "lingxi_selection_preview_dialog_request_v1";
  const PARALLEL_TRANSLATE_DIALOG_REQUEST_KEY = "lingxi_parallel_translate_dialog_request_v1";
  const SELECTION_PREVIEW_DIALOG_RESULT_KEY = "lingxi_selection_preview_dialog_result_v1";

  // ========================================================================
  // 预览渲染诊断日志（默认开启）：每条都有 [lingxi-preview] 前缀 + 上下文标签
  //   - 关闭：在 DevTools 控制台跑 `window.__lingxiPreviewDebug = false`
  //   - 重新打开：`window.__lingxiPreviewDebug = true`
  // 哪里打了日志：
  //   ① WpsAiHtmlPreview.open / tryOpenHtmlPreviewAsDialog（参数 + ShowDialog 前后）
  //   ② 独立 dialog 窗口的 init（读 request → openHtmlPreviewInline）
  //   ③ openHtmlPreviewInline（state 替换 / in-place 合并分支）
  //   ④ renderHtmlPreviewIntoIframe（模板查找、render 结果长度、写入路径、load / 兜底）
  //   ⑤ finishRender（scale 计算、bridge）
  // 排查空白预览：照下面 5 步在 console 里看日志就能定位到哪一环断了
  // ========================================================================
  if (typeof window.__lingxiPreviewDebug === "undefined") window.__lingxiPreviewDebug = true;
  // 日志持久化到 localStorage，让 dialog 窗口关掉后，主 TaskPane 还能拿到日志
  const PREVIEW_LOG_KEY = "lingxi_preview_log_v1";
  const MAX_LOG_ENTRIES = 500;
  function _appendPersistedLog(level, where, tag, args) {
    try {
      const entry = {
        ts: Date.now(),
        level, where, tag,
        msg: args.map((a) => {
          try {
            if (a == null) return String(a);
            if (typeof a === "string") return a;
            if (a instanceof Error) return a.message + (a.stack ? ("\n" + a.stack) : "");
            return describeForLog(a);
          } catch (e) { return "[unserializable]"; }
        }).join(" ")
      };
      const raw = global.WpsAiStore.getItem(PREVIEW_LOG_KEY);
      const list = raw ? (JSON.parse(raw) || []) : [];
      list.push(entry);
      const trimmed = list.slice(-MAX_LOG_ENTRIES);
      global.WpsAiStore.setItem(PREVIEW_LOG_KEY, JSON.stringify(trimmed));
    } catch (e) { /* 满了就算了 */ }
  }
  function plog(tag, ...args) {
    if (!window.__lingxiPreviewDebug) return;
    const where = isPreviewDialog ? "DIALOG" : (isSettingsDialog ? "SETTINGS" : (isStylePresetDialog ? "STYLEPRESET" : (isMaterialsDialog ? "MATERIALS" : (isQuickPromptDialog ? "QUICKPROMPT" : (isFormatPreviewDialog ? "FORMATPREVIEW" : (isSelectionPreviewDialog ? "SELECTIONPREVIEW" : "MAIN"))))));
    try { console.log(`[lingxi-preview][${where}][${tag}]`, ...args); } catch (e) {}
    _appendPersistedLog("LOG", where, tag, args);
  }
  function pwarn(tag, ...args) {
    const where = isPreviewDialog ? "DIALOG" : (isSettingsDialog ? "SETTINGS" : (isStylePresetDialog ? "STYLEPRESET" : (isMaterialsDialog ? "MATERIALS" : (isQuickPromptDialog ? "QUICKPROMPT" : (isFormatPreviewDialog ? "FORMATPREVIEW" : (isSelectionPreviewDialog ? "SELECTIONPREVIEW" : "MAIN"))))));
    try { console.warn(`[lingxi-preview][${where}][${tag}]`, ...args); } catch (e) {}
    _appendPersistedLog("WARN", where, tag, args);
  }
  function describeForLog(value, depth = 0, seen = new WeakSet()) {
    try {
      if (value == null) return String(value);
      const type = typeof value;
      if (type === "string") return value;
      if (type === "number" || type === "boolean" || type === "bigint") return String(value);
      if (type === "function") return `[Function ${value.name || "anonymous"}]`;
      if (value instanceof Error) {
        const err = {
          name: value.name || "Error",
          message: value.message || "",
          stack: value.stack || "",
          code: value.code,
          status: value.status
        };
        return JSON.stringify(err);
      }
      if (type !== "object") return String(value);
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (depth >= 3) {
        const tag = Object.prototype.toString.call(value);
        return tag && tag !== "[object Object]" ? tag : "[Object]";
      }
      if (Array.isArray(value)) {
        return JSON.stringify(value.slice(0, 30).map((item) => {
          const text = describeForLog(item, depth + 1, seen);
          try { return JSON.parse(text); } catch (e) { return text; }
        }));
      }
      const out = {};
      const keys = Object.keys(value).slice(0, 30);
      keys.forEach((key) => {
        try {
          const text = describeForLog(value[key], depth + 1, seen);
          try { out[key] = JSON.parse(text); } catch (e) { out[key] = text; }
        } catch (e) {
          out[key] = `[throw:${e?.message || e}]`;
        }
      });
      const tag = Object.prototype.toString.call(value);
      if (!keys.length && tag && tag !== "[object Object]") return tag;
      return JSON.stringify(out);
    } catch (e) {
      return "[unserializable]";
    }
  }
  function formatMessageText(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message || value.name || "Error";
    if (typeof value === "object") {
      try {
        const direct = value.message || value.msg || value.hint || value.reason || value.detail || value.error;
        if (typeof direct === "string" && direct.trim()) return direct.trim();
        if (direct && typeof direct === "object") {
          const nested = direct.message || direct.msg || direct.detail || direct.reason;
          if (typeof nested === "string" && nested.trim()) return nested.trim();
        }
      } catch (e) {}
      return describeForLog(value);
    }
    return String(value);
  }
  function isLocalDevRuntime() {
    try {
      const h = String(location.hostname || "").toLowerCase();
      return h === "127.0.0.1" || h === "localhost" || h === "::1";
    } catch (e) {
      return false;
    }
  }
  function sanitizeDevLogData(value, depth = 0) {
    if (value == null || typeof value !== "object") return value;
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (depth > 4) return "[depth-limit]";
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeDevLogData(v, depth + 1));
    const out = {};
    Object.keys(value).slice(0, 80).forEach((key) => {
      const lower = key.toLowerCase();
      if (/(apikey|api_key|authorization|secret|password)/.test(lower) || /\btoken\b/.test(lower)) {
        out[key] = "[redacted]";
        return;
      }
      let v = value[key];
      if (typeof v === "string" && v.length > 1200) v = v.slice(0, 1200) + `...(+${v.length - 1200})`;
      out[key] = sanitizeDevLogData(v, depth + 1);
    });
    return out;
  }
  function devLog(tag, message, data) {
    try { console.log(`[lingxi-dev][${tag}] ${message}`, data || ""); } catch (e) {}
    try { bridgeConsoleLog("dev", { tag, message, data: sanitizeDevLogData(data) }); } catch (e) {}
    if (!isLocalDevRuntime()) return;
    try {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      fetch(base + "/debug-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, message, data: sanitizeDevLogData(data) })
      }).catch(() => {});
    } catch (e) {}
  }
  const CONSOLE_BRIDGE_KEY = "lingxi_console_bridge_v1";
  function bridgeConsoleLog(kind, payload) {
    try {
      const store = global.WpsAiStore || global.localStorage;
      if (!store?.setItem) return;
      store.setItem(CONSOLE_BRIDGE_KEY, JSON.stringify({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ts: Date.now(),
        kind,
        payload: sanitizeDevLogData(payload)
      }));
    } catch (e) {}
  }
  // 暴露 plog/pwarn 给其他模块（presentation.js 等）用，方便集中日志
  window.WpsAiLog = { log: plog, warn: pwarn, dev: devLog };
  // 脚本版本标记 —— 用户排查"是不是装载到新代码"时直接看这一行
  const SCRIPT_VERSION = "2026-07-10-r49-remerge";
  try { console.log("[lingxi] app.js loaded version =", SCRIPT_VERSION); } catch (e) {}
  // 一旦 DOMContentLoaded 触发就立刻打 plog（确认日志系统运行 + 新代码已 load）
  document.addEventListener("DOMContentLoaded", () => {
    try { plog("scriptVersion", SCRIPT_VERSION); } catch (e) {}
  }, { once: true });
  // 暴露给用户在 DevTools 控制台手动取：__lingxiDumpLogs() / __lingxiClearLogs() / __lingxiCopyLogs()
  window.__lingxiDumpLogs = function () {
    try {
      const raw = global.WpsAiStore.getItem(PREVIEW_LOG_KEY);
      const list = raw ? (JSON.parse(raw) || []) : [];
      const text = list.map((e) => {
        const t = new Date(e.ts).toISOString().slice(11, 23);
        return `${t} [${e.level}][${e.where}][${e.tag}] ${e.msg}`;
      }).join("\n");
      console.log(text || "(no logs)");
      return text;
    } catch (e) { console.warn("dump 失败:", e); return ""; }
  };
  window.__lingxiClearLogs = function () {
    try { global.WpsAiStore.removeItem(PREVIEW_LOG_KEY); console.log("logs cleared"); } catch (e) {}
  };
  window.__lingxiCopyLogs = async function () {
    try {
      const text = window.__lingxiDumpLogs();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        console.log("logs copied to clipboard (" + text.length + " chars)");
      }
      return text;
    } catch (e) { console.warn("copy 失败:", e); }
  };

  function $(id) { return document.getElementById(id); }

  function bindElements() {
    [
      "authBadge",
      "brandVersion", "aboutVersion", "proxyStatusBadge", "pluginStartupOverlay", "updateAvailableBadge",
      "updateStatusBadge", "updateAutoCheckInput", "updateLastCheckedAt", "updateLatestVersion",
      "updateChangelog", "updateCheckNowBtn", "updateDownloadBtn",
      "message",
      // 整套 PPT 生成进度条
      "fullDeckProgress", "fullDeckProgressCount", "fullDeckProgressBarFill", "fullDeckProgressLabel",
      "settingsView", "aiView",
      "providerSelect", "operationModeSelect", "maxToolIterationsInput", "uiLanguageSelect", "ribbonPositionSelect", "aiFollowHighlightInput",
      "enableHostWps", "enableHostEt", "enableHostWpp", "enableHostPdf",
      "systemPromptInput", "systemPromptResetBtn", "imageSizeOverrideInput", "showToolCallLogsInput", "splitLayersOnInsertInput",
      "signInBtn", "exchangeCodeBtn", "authCodeInput", "signOutBtn", "tokenInfo",
      "codexAuthArea", "codexSignedInArea",
      "openaiBaseUrl", "openaiApiKey", "openaiDefaultModel", "openaiUseProxy",
      "anthropicBaseUrl", "anthropicApiKey", "anthropicDefaultModel", "anthropicVersion", "anthropicUseProxy",
      "imageProvidersList", "addImageProviderBtn",
      "saveSettingsBtn", "saveSettingsOnlyBtn", "testChatConnBtn",
      "exportSettingsBtn", "importSettingsBtn", "importSettingsFile",
      // 缓存管理 UI
      "cacheTotalBadge", "cacheRefreshBtn", "cacheClearSafeBtn", "cacheGroupsList",
      "svcStatusBody", "svcMemBadge", "svcStatusRefreshBtn",
      "cacheAutoCleanEnabled", "cacheAutoCleanMaxAge", "cacheAutoCleanMaxSize", "cacheAutoCleanStatus",
      // 灰度更新 UI
      "updateChannelBadge", "canaryHeaderBadge", "aboutDeviceSn", "copyDeviceSnBtn",
      "exportDiagBundleBtn",
      "aboutHomepageLink", "copyHomepageBtn",
      // 开发者工具（dev mode 才显示）
      "devToolsSection", "devModeBadge", "devScriptVersionBadge",
      "dumpPreviewLogsBtn", "clearPreviewLogsBtn", "viewPreviewLogsBtn",
      "devLogViewerModal", "devLogViewerOutput", "devLogViewerStats",
      "devLogViewerFilter", "devLogViewerWarnOnly",
      "devLogViewerCloseBtn", "devLogViewerRefreshBtn",
      "devLogViewerCopyBtn", "devLogViewerScrollBottomBtn",
      // PPT 风格 modal
      "stylePresetModal", "stylePresetCloseBtn", "styleSaveBtn",
      "styleEnabled", "styleTitleFont", "styleTitleSize", "styleTitleBold", "styleTitleColor",
      "styleBodyFont", "styleBodySize", "styleBodyColor",
      "styleScheme", "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor", "styleBackgroundColor", "styleSurfaceColor",
      "styleThemeFile",
      // PPT 风格 — 主题预览卡 + 可视化主题网格 + 实时预览
      "styleSchemePreview", "styleSchemePreviewLabel", "styleSchemePreviewDesc",
      "styleSchemePreviewSwatches", "styleSchemePreviewSignature", "styleSchemePreviewHints",
      "styleThemeGrid", "styleLivePreview", "styleLiveMeta",
      // HTML 模板预览 modal
      "htmlPreviewModal", "htmlPreviewTitle", "htmlPreviewCloseBtn", "htmlPreviewInsertBtn",
      "htmlPreviewReplaceActiveBtn", "htmlPreviewSaveBtn",
      // 组件库相关
      "htmlPreviewSaveAsCompBtn", "htmlPreviewSaveAsCompModal", "htmlPreviewSaveAsCompCloseBtn",
      "htmlPreviewSaveAsCompName", "htmlPreviewSaveAsCompDesc", "htmlPreviewSaveAsCompTip",
      "htmlPreviewSaveAsCompConfirmBtn",
      "htmlPreviewExtractCompsBtn",
      "htmlPreviewExtractReviewModal", "htmlPreviewExtractReviewTitle", "htmlPreviewExtractReviewCloseBtn",
      "htmlPreviewExtractReviewList", "htmlPreviewExtractReviewSummary",
      "htmlPreviewExtractReviewDiscardBtn", "htmlPreviewExtractReviewKeepAllBtn",
      // 编辑模式 / 标尺
      "htmlPreviewEditModeBtn", "htmlPreviewEditUndoBtn", "htmlPreviewEditRedoBtn",
      "htmlPreviewEditElModal", "htmlPreviewEditElTag", "htmlPreviewEditElCloseBtn",
      "htmlPreviewEditElText", "htmlPreviewEditElColor", "htmlPreviewEditElSize", "htmlPreviewEditElWeight",
      "htmlPreviewEditElCancelBtn", "htmlPreviewEditElApplyBtn",
      "htmlPreviewPickComponentsBtn", "htmlPreviewPickComponentsCount",
      "htmlPreviewComponentsPicker", "htmlPreviewPickComponentsCloseBtn",
      "htmlPreviewComponentsList", "htmlPreviewPickComponentsClearBtn", "htmlPreviewPickComponentsConfirmBtn",
      // 统一修改 tab
      "htmlPreviewUnifiedLog", "htmlPreviewUnifiedInput", "htmlPreviewUnifiedSendBtn",
      "htmlPreviewFrame", "htmlPreviewInfo", "htmlPreviewRendering",
      "htmlPreviewTemplate", "htmlPreviewLayout", "htmlPreviewFields",
      "htmlPreviewHistoryBtn", "htmlPreviewHistoryPanel", "htmlPreviewHistoryList",
      "htmlPreviewHistoryCloseBtn", "htmlPreviewHistoryClearBtn",
      "htmlTemplateGallery", "htmlTemplateGalleryList",
      "htmlTemplateGalleryFoot", "htmlTemplateGalleryClearBtn",
      "htmlPreviewChatInput", "htmlPreviewChatSendBtn", "htmlPreviewChatLog", "htmlPreviewChatClearBtn",
      "chatHtmlGalleryBtn", "chatContextActions",
      // 大纲 modal
      "outlineModal", "outlineCloseBtn", "outlineGenerateBtn",
      "outlineText", "outlineExtractBtn", "outlineClearBtn",
      "parallelTranslateModal", "ptCloseBtn", "ptCloseBtn2", "ptSourceLang", "ptTargetLang",
      "ptScope", "ptPagesField", "ptPages", "ptRunBtn", "ptStatus", "ptResult", "ptCopyBtn",
      // 统一风格 modal
      "unifyModal", "unifyCloseBtn", "unifyExecuteBtn",
      "unifyOutlineText", "unifyExtractBtn", "unifyClearBtn", "unifyAutoImage",
      "modelSelect", "refreshModelsBtn",
      "modelSelectBtn", "modelSelectLabel", "modelSelectCaps", "modelSelectPopup",
      // 新版设置弹窗
      "settingsModal", "settingsModalCloseBtn", "openSettingsModalBtn",
      "localModelGuideSlot", "chatProvidersList", "addChatProviderBtn",
      "skillsList", "skillImportBtn", "skillCloudRefreshBtn", "skillImportFile",
      "skillsSearchInput", "skillsCategoryChips",
      "mcpServerEnabledInput", "mcpStatusBadge", "mcpToolCount", "mcpLastError",
      "mcpConfigSnippet", "mcpCopyConfigBtn", "mcpToolsList",
      "mcpCallLogList", "mcpCallLogClearBtn",
      "presetPickerModal", "presetPickerList",
      // TaskPane 停靠/浮动切换
      "dockToggleBtn", "dockToggleIcon", "dockToggleLabel",
      "aiPanelTitle", "aiPanelHint", "chatSessionStats",
      "settingsSearchInput",
      "suggestedActions", "suggestedActionsList", "suggestedActionsClear",
      "chatStream", "chatPending", "chatPendingList",
      "chatApproveAllBtn", "chatRejectAllBtn",
      "chatInput", "chatSendBtn", "chatStopBtn",
      // 聊天面板体验：跳到最新 + 折叠中间轮次 + 单次模型 override
      "chatJumpLatest", "chatFoldToggle",
      "chatModelOverrideBtn", "chatModelOverrideBar", "chatModelOverrideText", "chatModelOverrideClearBtn",
      // 改动记录
      "historyView", "historyBadge", "historyCount", "historyClearBtn",
      "historyEmpty", "historyList",
      "historyDocBar", "historyDocName",
      "historyDetailModal", "historyDetailTitle", "historyDetailBody", "historyDetailCloseBtn",
      // Ribbon 快捷输入
      "complianceModal", "complianceCloseBtn", "complianceCancelBtn", "complianceRunBtn", "complianceRulesInput",
      "quickPromptModal", "quickPromptTitle", "quickPromptSubtitle", "quickPromptCloseBtn",
      "quickPromptBody", "quickPromptCancelBtn", "quickPromptSubmitBtn",
      // 生图素材库
      "materialLibraryModal", "materialLibraryCloseBtn", "materialLibraryRefreshBtn", "materialLibraryClearBtn",
      "materialImportBtn", "materialImportInput",
      "materialLibraryList", "materialLibraryEmpty",
      "materialSearchInput", "materialProjectFilter",
      "materialGroupList", "materialGroupNameInput", "materialGroupAddBtn",
      "materialSelectedCount", "materialMoveGroupSelect", "materialMoveBtn",
      "materialInsertBtn", "materialModifyBtn", "materialCopyBtn", "materialDeleteBtn",
      "materialPreviewModal", "materialPreviewCloseBtn", "materialPreviewImage", "materialPreviewStatus",
      "materialPreviewPrompt", "materialPreviewMeta", "materialPreviewUrl",
      "materialPreviewInsertBtn", "materialPreviewSaveAsBtn", "materialPreviewCopyBtn",
      "materialPreviewCropBtn", "materialCropSaveBtn", "materialCropCancelBtn", "materialCropOverlay", "materialCutoutBtn", "materialLocalCutoutBtn",
      "materialBrushCanvas", "materialBrushBar", "materialBrushSize", "materialBrushClearBtn", "materialBrushPrompt",
      "materialBrushInpaintBtn", "materialBrushCutoutBtn", "materialBrushCancelBtn", "materialBrushEditBtn",
      "materialEditOverlay", "materialEditCancelBtn",
      "materialCutoutChoiceModal", "materialCutoutChoiceCloseBtn", "materialCutoutDescribeInput",
      "materialCutoutAllBtn", "materialCutoutDescribeBtn",
      // AI 排版富文本预览
      "formatPreviewModal", "formatPreviewCloseBtn", "formatPreviewMeta", "formatPreviewLoading",
      "formatPreviewImpact", "formatPreviewContent", "formatPreviewPromptInput", "formatPreviewPresetList",
      "formatPreviewRegenerateBtn", "formatPreviewCancelBtn", "formatPreviewReplaceBtn", "formatPreviewScopeRow", "formatPreviewExportBtn",
      "formatTemplateSelect", "formatTemplateNewBtn", "formatTemplateEditBtn", "formatTemplateDeleteBtn", "formatTemplateSample",
      "formatTemplateZoomBtn", "formatTemplateSampleModal", "formatTemplateSampleModalTitle",
      "formatTemplateSampleModalCloseBtn", "formatTemplateSampleModalPage",
      "formatTemplateEditorModal", "formatTemplateEditorTitle", "formatTemplateEditorBody",
      "formatTemplateEditorCloseBtn", "formatTemplateEditorCancelBtn", "formatTemplateEditorSaveBtn",
      // 选区翻译/优化预览
      "selectionPreviewModal", "selectionPreviewTitle", "selectionPreviewCloseBtn", "selectionPreviewMeta",
      "selectionPreviewTranslateControls", "selectionPreviewLanguageSelect", "selectionPreviewCustomLanguageInput",
      "selectionPreviewInstructionLabel", "selectionPreviewInstructionInput", "selectionPreviewTip",
      "selectionPreviewLoading", "selectionPreviewOriginal", "selectionPreviewResult", "selectionPreviewDiff",
      "selectionPreviewRegenerateBtn", "selectionPreviewToggleDiffBtn", "selectionPreviewCopyBtn", "selectionPreviewCancelBtn", "selectionPreviewReplaceBtn",
      "selectionPreviewCompare",
      // 纯净模式开关
      "pureModeToggle",
      // 手动解除文档锁定
      "forceUnlockBtn",
      // 多对话
      "newConversationBtn", "conversationsMenuBtn", "conversationsMenu",
      "conversationsMenuList", "conversationsMenuEmpty", "conversationsMenuClose",
      // AI 进度条
      "chatProgress", "chatProgressText",
      // 文档锁定 banner
      "docLockBanner", "docLockStatusText", "docLockTitle",
      // 生图独立进度面板
      "imageGenPanel", "imageGenStatus", "imageGenPrompt", "imageGenCloseBtn",
      // 附件
      "chatAttachBtn", "chatAttachFile", "chatAttachments", "chatAttachActiveBtn",
      // 修订模式（仅 WPS 文字）
      "reviseModeBar", "reviseModeToggle", "reviseModeActions", "reviseAcceptAllBtn", "reviseRejectAllBtn",
      // 技能沉淀提示（多轮 + 有实际操作后）
      "skillSuggestBar", "skillSuggestBtn", "skillSuggestDismissBtn",
      // 模型能力 chip
      "capImage", "capPdf", "capThinking"
    ].forEach((id) => { els[id] = $(id); });
  }

  // 模型能力检测：图像 / PDF / 深度思考。统一走 WpsAiCapabilities，UI 与 provider 共享同一套判断
  function isMultimodalModel(name) {
    const providerId = getActiveChatModel().providerId || "";
    return global.WpsAiCapabilities?.getCapabilities?.(name, providerId)?.image || false;
  }
  function isPdfModel(name) {
    const providerId = getActiveChatModel().providerId || "";
    return global.WpsAiCapabilities?.getCapabilities?.(name, providerId)?.pdf || false;
  }
  function isThinkingModel(name) {
    const providerId = getActiveChatModel().providerId || "";
    return global.WpsAiCapabilities?.getCapabilities?.(name, providerId)?.thinking || false;
  }

  // ---- 能力覆盖：用户手动改（①）/ 从服务端多模态报错学到（⑤），持久化在 settings ----
  // 优先级：这里的「供应商专属」覆盖 > models.dev 全局目录 > 名字正则。
  // 存储形态：currentSettings.capabilityOverrides = { "<providerId>::<modelId>": {image?,pdf?,thinking?,tools?} }
  const CAP_KEYS = ["image", "pdf", "thinking", "tools"];
  function capOverrideStore() {
    if (!currentSettings) return {};
    if (!currentSettings.capabilityOverrides || typeof currentSettings.capabilityOverrides !== "object") {
      currentSettings.capabilityOverrides = {};
    }
    return currentSettings.capabilityOverrides;
  }
  function capOverrideKey(providerId, modelId) {
    return `${String(providerId || "").toLowerCase()}::${String(modelId || "").toLowerCase()}`;
  }
  // 该 (provider,model) 的某能力是否有显式覆盖；返回 true/false/undefined(=无覆盖，走自动)
  function capOverrideValue(providerId, modelId, capKey) {
    const entry = capOverrideStore()[capOverrideKey(providerId, modelId)];
    return entry ? entry[capKey] : undefined;
  }
  // boot 时把持久化的覆盖注入 WpsAiCapabilities（供应商专属键，胜过 models.dev 全局）
  function injectPersistedCapabilityOverrides() {
    const Caps = global.WpsAiCapabilities;
    if (!Caps || !Caps.setCapabilityOverride) return;
    const store = capOverrideStore();
    for (const key of Object.keys(store)) {
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      Caps.setCapabilityOverride(key.slice(0, sep), key.slice(sep + 2), store[key]);
    }
  }
  // 设置/清除一个能力键。value：true/false = 强制；null = 清掉该键回到自动判断（models.dev/正则）。
  // app.js 持有该 (provider,model) 的完整覆盖对象为准，整体写入 capabilities，避免多键互相覆盖。
  // 立刻生效(内存) + 持久化 + 重渲角标。source 仅用于日志/区分手动 vs 学习。
  function setUserCapabilityOverride(providerId, modelId, capKey, value, source) {
    const Caps = global.WpsAiCapabilities;
    if (!Caps || !modelId || !CAP_KEYS.includes(capKey)) return;
    const store = capOverrideStore();
    const key = capOverrideKey(providerId, modelId);
    const cur = (store[key] && typeof store[key] === "object") ? Object.assign({}, store[key]) : {};
    if (value === null || value === undefined) delete cur[capKey];
    else cur[capKey] = !!value;
    if (Object.keys(cur).length) {
      store[key] = cur;
      Caps.setCapabilityOverride(providerId, modelId, cur); // 全量写入
    } else {
      delete store[key];
      Caps.clearCapabilityOverride && Caps.clearCapabilityOverride(providerId, modelId);
    }
    try { global.WpsAiLog?.dev?.("capabilities.override", "set", { providerId, modelId, capKey, value, source: source || "manual" }); } catch (e) {}
    try { persistSettings(); } catch (e) {}
    try { populateModelSelector(els.modelSelect?.value); } catch (e) {}
  }
  // 点击角标：有显式覆盖 → 清掉回到自动；否则 → 强制成「当前判断的反面」。两步一个来回，可逆。
  function toggleCapChipOverride(providerId, modelId, capKey) {
    if (!CAP_KEYS.includes(capKey)) return;
    if (capOverrideValue(providerId, modelId, capKey) !== undefined) {
      setUserCapabilityOverride(providerId, modelId, capKey, null, "manual"); // 回到自动
    } else {
      const cur = global.WpsAiCapabilities?.getCapabilities?.(modelId, providerId) || {};
      setUserCapabilityOverride(providerId, modelId, capKey, !cur[capKey], "manual"); // 反转
    }
  }

  // 把服务端「模型不接受多模态/附件内容」这类晦涩报错，翻译成用户能看懂、能行动的提示。
  // 命中已知签名 → 返回友好文案；否则返回 null（调用方回退原始错误）。
  // 背景：能力检测（isMultimodalModel/isPdfModel）是按模型名正则猜的，自建 OpenAI 兼容
  //       端点 / 改过名的模型可能猜错——猜"支持"但后端其实纯文本，附件就会发出去被后端拒，
  //       用户只看到 "Failed to build prompt: Unexpected item type in content." 这种天书。
  function friendlyMultimodalError(error, opts) {
    const raw = String(error?.message || error || "");
    const s = raw.toLowerCase();
    const hit =
      /unexpected item type in content/.test(s) ||                 // 常见网关：整条多模态 content 被拒
      /failed to build prompt/.test(s) ||
      /unknown variant `?(file|image)/.test(s) ||                  // DeepSeek 等：不认 file/image_url content part
      /(image_url|input_image|input_file).*(not|unsupported|invalid|cannot)/.test(s) ||
      /(does not|doesn'?t|not) support(ed)?.*(image|vision|multimodal|file|attachment|pdf)/.test(s) ||
      /(image|vision|multimodal|pdf).*(not support|unsupported|not enabled|not allowed)/.test(s);
    if (!hit) return null;
    const modelName = String((opts && opts.model) || "").trim();
    const kinds = [];
    if (opts && opts.hadImages) kinds.push("图片");
    if (opts && opts.hadPdfs) kinds.push("PDF 附件");
    const kindText = kinds.length ? kinds.join("和") : "图片 / 附件";
    return [
      `当前模型${modelName ? `「${modelName}」` : ""}不支持${kindText}——服务端拒绝了多模态内容。`,
      `请改用支持多模态的模型（Claude 3.5+/4、GPT-4o/4.1/5、Gemini 1.5+、Qwen-VL 等），或移除${kindText}后仅发文字重试。`,
      "",
      `（服务端原始报错：${raw.slice(0, 200)}）`
    ].join("\n");
  }

  // 判断是否为「限流（每分钟请求数超限）」类错误：端点常报 rpm exhausted / rate limit / 429 /
  // too many requests 等，用户看不懂。集中一处正则识别，供友好提示与重试短文案共用。
  function isRateLimitError(error) {
    const raw = String((error && error.message) || error || "");
    return /\brpm\b|rate.?limit|too many requests|\b429\b|requests per minute|每分钟|请求过于频繁|请求频率过|限流|quota\s*(exceeded|exhaust)/i.test(raw);
  }
  // 限流错误 → 用户能懂的中文提示；非限流返回 null（交回上层用别的友好化/原始报错）
  function friendlyRateLimitError(error) {
    if (!isRateLimitError(error)) return null;
    const raw = String((error && error.message) || error || "");
    return [
      "请求太频繁，被模型服务限流了。",
      "触发了所用 API 端点的「每分钟请求次数」上限——不是文档或插件的问题，是接口的限速。",
      "怎么办：稍等约 1 分钟再继续；若经常遇到，可换一个额度更高的 Key/端点，或让批量操作一次调用完成（如「统一黑色 / 去背景」已支持一次搞定）。",
      "",
      `（服务端原始报错：${raw.slice(0, 160)}）`
    ].join("\n");
  }
  // 限流的一句话短提示（自动重试的 toast 用）；非限流返回 null
  function rateLimitShortReason(error) {
    return isRateLimitError(error) ? "请求过于频繁，触发接口限流" : null;
  }

  // 思考强度：off / low / medium / high。点 header 上的 🧠 chip 切换，存 localStorage
  const THINKING_LEVEL_KEY = "lingxi_ai_thinking_level_v1";
  const THINKING_LEVELS = ["off", "low", "medium", "high"];
  const THINKING_LEVEL_LABEL = { off: "关", low: "低", medium: "中", high: "高" };
  function readThinkingLevel() {
    try {
      const v = global.WpsAiStore.getItem(THINKING_LEVEL_KEY);
      return THINKING_LEVELS.includes(v) ? v : "medium";
    } catch (e) { return "medium"; }
  }
  function writeThinkingLevel(level) {
    try { global.WpsAiStore.setItem(THINKING_LEVEL_KEY, level); } catch (e) {}
  }

  // 当前会话的待发送附件
  let pendingAttachments = [];

  function genAttachId() {
    return "a-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function fmtFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  // 附件类型白名单：图片 / PDF / 文本类可读的扩展名。其余一律拒绝——
  // readFileAsAttachment 对非图片/PDF 一律当 UTF-8 文本读，视频/音频/压缩包/
  // 可执行文件/Office 二进制（.docx/.xlsx/.pptx…）读出来是乱码，不该被当附件收下。
  const TEXT_ATTACHMENT_EXTENSIONS = [
    ".txt", ".md", ".markdown", ".json", ".csv", ".log", ".xml", ".yaml", ".yml",
    ".html", ".css", ".js", ".ts", ".py", ".java", ".c", ".cpp", ".go", ".rs",
    ".sql", ".ini", ".conf"
  ];
  function isSupportedAttachmentFile(file) {
    if (!file) return false;
    const type = String(file.type || "");
    const name = String(file.name || "");
    if (/^image\//.test(type)) return true;
    if (type === "application/pdf" || /\.pdf$/i.test(name)) return true;
    if (/^text\//.test(type) || type === "application/json") return true;
    const lower = name.toLowerCase();
    return TEXT_ATTACHMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  // 把单个 File 读成附件对象。图片 / PDF 读 dataURL，文本读字符串
  function readFileAsAttachment(file) {
    return new Promise((resolve, reject) => {
      const isImage = /^image\//.test(file.type);
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
      if (isImage) {
        reader.onload = () => resolve({
          id: genAttachId(),
          kind: "image",
          name: file.name,
          mediaType: file.type || "image/png",
          dataUrl: String(reader.result || ""),
          size: file.size
        });
        reader.readAsDataURL(file);
      } else if (isPdf) {
        reader.onload = () => resolve({
          id: genAttachId(),
          kind: "pdf",
          name: file.name,
          mediaType: "application/pdf",
          dataUrl: String(reader.result || ""),
          size: file.size
        });
        reader.readAsDataURL(file);
      } else {
        reader.onload = () => resolve({
          id: genAttachId(),
          kind: "text",
          name: file.name,
          mediaType: file.type || "text/plain",
          textContent: String(reader.result || ""),
          size: file.size
        });
        reader.readAsText(file, "utf-8");
      }
    });
  }

  async function addAttachments(fileList) {
    const t = global.WpsAiI18n?.t || ((s) => s);
    const allFiles = Array.from(fileList || []);
    if (allFiles.length === 0) return;
    // 类型白名单：过滤掉视频/音频/压缩包/可执行文件/Office 二进制等不支持的类型。
    // 好的照样收下，只提示被拒绝的——不因为一个文件不支持就整批放弃。
    const files = allFiles.filter(isSupportedAttachmentFile);
    const rejected = allFiles.filter((f) => !isSupportedAttachmentFile(f));
    if (rejected.length > 0) {
      const names = rejected.map((f) => f.name).join("、");
      showMessage(t("{names}：不支持的文件类型，只能添加 图片 / PDF / 文本文件", { names }), "error");
    }
    if (files.length === 0) return;
    // PDF 上限 32MB（跟 proxy 一致），其他 5MB
    const tooLarge = files.find((f) => {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      return f.size > (isPdf ? 32 : 5) * 1024 * 1024;
    });
    if (tooLarge) {
      const cap = (tooLarge.type === "application/pdf" || /\.pdf$/i.test(tooLarge.name)) ? "32MB" : "5MB";
      showMessage(t("附件 {name} 太大（>{cap}），不支持。", { name: tooLarge.name, cap }), "error");
      return;
    }
    try {
      const results = await Promise.all(files.map(readFileAsAttachment));
      pendingAttachments = pendingAttachments.concat(results);
      renderAttachments();
      const modelName = els.modelSelect?.value;
      const hasImage = results.some((a) => a.kind === "image");
      const hasPdf = results.some((a) => a.kind === "pdf");
      if (hasImage && !isMultimodalModel(modelName)) {
        showMessage("当前模型不支持图片输入，发送时图片附件会被忽略，仅文本附件生效。", "info");
      }
      if (hasPdf && !isPdfModel(modelName)) {
        showMessage(`当前模型「${modelName}」不支持 PDF 附件，发送时会被忽略。建议切到 Claude / GPT-4o / Codex / DeepSeek-V4 等支持 PDF 的模型。`, "info");
      }
    } catch (e) {
      showMessage(e.message || String(e), "error");
    }
  }

  // 粘贴/拖拽图片直接变附件，只在聊天输入框里生效——设置项等其他输入框粘贴图片
  // 没有意义，且不该抢占它们的纯文本粘贴行为。
  function isChatAttachmentInput(el) {
    return !!(el && els.chatInput && (el === els.chatInput || els.chatInput.contains?.(el)));
  }

  // 长文本粘贴阈值：满足其一即判定为"长"，转存为临时文本附件而不是直接怼进输入框——
  // 参考 Claude Code CLI：粘贴大段文本时输入框上方出现一个 chip，而不是把输入框撑爆。
  const LONG_PASTE_MIN_LINES = 10;
  const LONG_PASTE_MIN_CHARS = 1500;

  // 纯函数：判断一段粘贴文本是否算"长"。行数统计跟 \r\n / \r / \n 都算一次换行保持一致。
  function isLongPasteText(text) {
    const s = String(text == null ? "" : text);
    if (!s) return false;
    const lineCount = s.split(/\r\n|\r|\n/).length;
    return lineCount >= LONG_PASTE_MIN_LINES || s.length >= LONG_PASTE_MIN_CHARS;
  }

  // chip 名称：多行用行数，单行（可能就是一整行超长）用字数。
  // 兜底的 t()：app.js 被单测按文本锚点切出去 eval 时 WpsAiI18n 不存在，这里手写等价的
  // {n} 插值，保证 isLongPasteText 之外这几个纯函数在单测里也能独立跑。
  function pasteAttachmentName(text) {
    const s = String(text == null ? "" : text);
    const lineCount = s.split(/\r\n|\r|\n/).length;
    const t = (global.WpsAiI18n && global.WpsAiI18n.t) || ((str, params) => {
      let r = String(str == null ? "" : str);
      if (params) for (const k in params) r = r.split("{" + k + "}").join(String(params[k]));
      return r;
    });
    if (lineCount > 1) return t("粘贴文本 ({n} 行)", { n: lineCount });
    return t("粘贴文本 ({n} 字)", { n: s.length });
  }

  // 把一段长粘贴文本转成文本附件（chip），复用 addAttachments 的 5MB 上限 + 渲染逻辑。
  // File 构造器在这个 WebView 里应该可用；不可用时手工拼一个跟 readFileAsAttachment
  // 文本分支形状一致的附件对象，直接走 pendingAttachments + renderAttachments，同样套 5MB 上限。
  function createPastedTextAttachment(text) {
    const name = pasteAttachmentName(text);
    if (typeof File === "function") {
      try {
        const file = new File([text], name, { type: "text/plain" });
        addAttachments([file]);
        return;
      } catch (e) {
        // File 构造失败（理论上不该发生）：落到下面的手工兜底
      }
    }
    if (text.length > 5 * 1024 * 1024) {
      showMessage(t("附件 {name} 太大（>{cap}），不支持。", { name, cap: "5MB" }), "error");
      return;
    }
    pendingAttachments = pendingAttachments.concat([{
      id: genAttachId(),
      kind: "text",
      name,
      mediaType: "text/plain",
      textContent: text,
      size: text.length
    }]);
    renderAttachments();
  }

  // 聊天附件输入框里粘贴的长文本 → 转存为临时文本附件（chip），不再插入输入框；
  // 返回 true 表示"已当附件处理"，调用方不应再内联插入。只对聊天输入框生效——
  // 设置等其它输入框无论粘贴多长的文本都照常内联插入，行为不变。
  function handleChatPastedText(target, text) {
    if (!isChatAttachmentInput(target)) return false;
    const s = String(text == null ? "" : text);
    if (!isLongPasteText(s)) return false;
    createPastedTextAttachment(s);
    return true;
  }

  function withTimeout(promise, ms, fallback) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  let lastActivePdfPathError = "";

  function isUnknownProxyRoutePayload(payload, pathname) {
    const message = String(payload?.error?.message || payload?.message || payload?.error || "");
    return message.includes("未知路由") && message.includes(pathname);
  }

  async function fetchActivePdfPathViaProxy(timeoutMs, allowReprobe = true) {
    const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
    plog("pdfPath.resolve", { stage: "proxy.request", base });
    const resp = await withTimeout(fetch(base + "/active-pdf-path", { method: "GET", cache: "no-store" }), timeoutMs, null);
    if (!resp) {
      pwarn("pdfPath.resolve", { stage: "proxy.timeout", timeoutMs });
      return { path: "", stop: false };
    }
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok && allowReprobe && isUnknownProxyRoutePayload(payload, "/active-pdf-path") && global.WpsAiRuntime?.reprobe) {
      pwarn("pdfPath.resolve", { stage: "proxy.routeMissing", status: resp.status, base, payload });
      const foundPort = await withTimeout(global.WpsAiRuntime.reprobe({ requireFeature: "active-pdf-path", force: true }), timeoutMs, null);
      const nextBase = global.WpsAiRuntime?.proxyBase?.() || base;
      if (foundPort && nextBase !== base) {
        plog("pdfPath.resolve", { stage: "proxy.reprobe.hit", port: foundPort, base: nextBase });
        return fetchActivePdfPathViaProxy(timeoutMs, false);
      }
      lastActivePdfPathError = "当前本地代理是旧版本，缺少 /active-pdf-path。请停止旧 dev 进程后重新运行 npm run dev:pdf。";
      return { path: "", stop: true };
    }
    if (!resp.ok && payload?.ambiguous) {
      lastActivePdfPathError = payload.error || "检测到多个 WPS 已打开 PDF，无法确认当前 PDF。请只保留当前 PDF 打开后重试。";
      pwarn("pdfPath.resolve", { stage: "proxy.ambiguous", status: resp.status, payload });
      return { path: "", stop: true };
    }
    if (!resp.ok && payload?.error) {
      lastActivePdfPathError = payload.error;
    }
    if (payload?.path && /\.pdf$/i.test(String(payload.path))) {
      const path = String(payload.path).trim();
      plog("pdfPath.resolve", { stage: "proxy.hit", status: resp.status, path, source: payload.source || "" });
      return { path, stop: true };
    }
    plog("pdfPath.resolve", { stage: "proxy.miss", status: resp.status, payload });
    return { path: "", stop: false };
  }

  async function resolveActivePdfPath(docPathHint = null, timeoutMs = 1200) {
    lastActivePdfPathError = "";
    const hinted = String(docPathHint || "").trim();
    plog("pdfPath.resolve", { stage: "start", hasHint: !!hinted, hint: hinted || "", timeoutMs });
    if (hinted && /\.pdf$/i.test(hinted)) {
      plog("pdfPath.resolve", { stage: "hint.hit", path: hinted });
      return hinted;
    }
    try {
      const p = global.WpsAiBackup?.getCurrentDocPath?.();
      if (p && /\.pdf$/i.test(String(p))) {
        plog("pdfPath.resolve", { stage: "backup.hit", path: String(p).trim() });
        return String(p).trim();
      }
      plog("pdfPath.resolve", { stage: "backup.miss", value: p || "" });
    } catch (e) {
      pwarn("pdfPath.resolve", { stage: "backup.error", error: describeForLog(e) });
    }
    try {
      const p = await withTimeout(global.WpsAiHostPdf?.getActivePdfPath?.(), timeoutMs, null);
      if (p && /\.pdf$/i.test(String(p))) {
        plog("pdfPath.resolve", { stage: "hostPdf.hit", path: String(p).trim() });
        return String(p).trim();
      }
      plog("pdfPath.resolve", { stage: "hostPdf.miss", value: p || "" });
    } catch (e) {
      pwarn("pdfPath.resolve", { stage: "hostPdf.error", error: describeForLog(e) });
    }
    try {
      const p = await withTimeout(global.WpsAiAddon?.getActivePdfPath?.(), timeoutMs, null);
      if (p && /\.pdf$/i.test(String(p))) {
        plog("pdfPath.resolve", { stage: "addon.hit", path: String(p).trim() });
        return String(p).trim();
      }
      plog("pdfPath.resolve", { stage: "addon.miss", value: p || "" });
    } catch (e) {
      pwarn("pdfPath.resolve", { stage: "addon.error", error: describeForLog(e) });
    }
    try {
      const proxyResult = await fetchActivePdfPathViaProxy(timeoutMs, true);
      if (proxyResult.path) return proxyResult.path;
      if (proxyResult.stop) return null;
    } catch (e) {
      pwarn("pdfPath.resolve", { stage: "proxy.error", error: describeForLog(e) });
    }
    pwarn("pdfPath.resolve", { stage: "miss", lastError: lastActivePdfPathError || "", hinted: hinted || "" });
    return hinted || null;
  }

  // 把当前 WPS 里打开的文档（PDF 优先）作为附件读进来。
  // 仅在 WPS PDF 宿主 / 文字宿主下、且活动文档是 PDF 文件时可用。
  async function attachActivePdf({ silent = false, docPath: docPathHint = null } = {}) {
    try {
      const docPath = await resolveActivePdfPath(docPathHint);
      if (!docPath) {
        if (!silent) showMessage(lastActivePdfPathError || "未检测到当前文档路径（可能是未保存的临时文档？请先保存：Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S）。", "error");
        return null;
      }
      if (!/\.pdf$/i.test(docPath)) {
        if (!silent) showMessage(`当前文档不是 PDF：${docPath}`, "error");
        return null;
      }
      // 已经附过同一份 PDF 就不重复加
      const already = pendingAttachments.find((a) => a.kind === "pdf" && a.sourcePath === docPath);
      if (already) {
        if (!silent) showMessage("当前 PDF 已经在附件列表里了。", "info");
        return already;
      }
      const resp = await fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/load-local-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: docPath })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || `读取 PDF 失败：${resp.status}`);
      const attachment = {
        id: genAttachId(),
        kind: "pdf",
        name: payload.name || "active.pdf",
        mediaType: payload.mediaType || "application/pdf",
        dataUrl: `data:${payload.mediaType || "application/pdf"};base64,${payload.base64}`,
        size: payload.size || 0,
        sourcePath: docPath
      };
      pendingAttachments.push(attachment);
      renderAttachments();
      if (!silent) {
        const modelName = els.modelSelect?.value;
        if (!isPdfModel(modelName)) {
          showMessage(`PDF 已附加，但当前模型「${modelName}」不支持 PDF。请切到 Claude / GPT-4o / Codex / DeepSeek-V4 等支持 PDF 的模型。`, "info");
        }
      }
      return attachment;
    } catch (e) {
      if (!silent) showMessage(e.message || String(e), "error");
      return null;
    }
  }

  function removeAttachment(id) {
    pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
    renderAttachments();
  }

  const PROXY_SERVICE_SIG = "lingxi-ai-proxy/v1";
  const PROXY_HEALTH_TIMEOUT_MS = 800;
  let proxyStatusRetryTimer = 0;
  let proxyStatusFailures = 0;
  let proxyStatusCheckInFlight = null;

  function showPluginStartupOverlay(text) {
    const overlay = els.pluginStartupOverlay || $("pluginStartupOverlay");
    if (!overlay) return;
    const label = overlay.querySelector('[data-role="startup-label"]');
    if (label) label.textContent = text || "插件启动中";
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }

  function hidePluginStartupOverlay() {
    const overlay = els.pluginStartupOverlay || $("pluginStartupOverlay");
    if (!overlay) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }

  function setProxyStatusBadge(state, text, title) {
    const badge = els.proxyStatusBadge;
    if (!badge) return;
    badge.textContent = text;
    badge.title = title || text;
    badge.classList.remove("proxy-status-pending", "proxy-status-ok", "proxy-status-error");
    badge.classList.add(`proxy-status-${state}`);
  }

  async function fetchProxyHealth() {
    const url = global.WpsAiRuntime?.proxyUrl
      ? global.WpsAiRuntime.proxyUrl("/healthz")
      : ((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/healthz");
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), PROXY_HEALTH_TIMEOUT_MS) : 0;
    try {
      const resp = await fetch(url, { method: "GET", cache: "no-store", signal: ctrl?.signal });
      const data = await resp.json().catch(() => ({}));
      const sig = resp.headers?.get?.("X-Lingxi-Service") || data?.service || "";
      if (!resp.ok || sig !== PROXY_SERVICE_SIG) throw new Error(`healthz ${resp.status || 0}`);
      return {
        port: Number(data?.port) || global.WpsAiRuntime?.resolvedPort?.() || 3890,
        pid: data?.pid || ""
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function scheduleProxyStatusRetry() {
    if (proxyStatusRetryTimer || !els.proxyStatusBadge) return;
    const delay = Math.min(10000, 1200 + proxyStatusFailures * 800);
    proxyStatusRetryTimer = setTimeout(() => {
      proxyStatusRetryTimer = 0;
      updateProxyStatusBadge({ scanOnFail: true }).catch(() => {});
    }, delay);
  }

  async function updateProxyStatusBadge(options = {}) {
    if (!els.proxyStatusBadge) return false;
    if (proxyStatusCheckInFlight) return proxyStatusCheckInFlight;
    const scanOnFail = options.scanOnFail !== false;
    proxyStatusCheckInFlight = (async () => {
      try {
        const health = await fetchProxyHealth();
        proxyStatusFailures = 0;
        setProxyStatusBadge("ok", "正常运行", `本地代理正常运行：127.0.0.1:${health.port}${health.pid ? ` · pid ${health.pid}` : ""}`);
        hidePluginStartupOverlay();
        return true;
      } catch (error) {
        showPluginStartupOverlay("插件启动中");
        if (!scanOnFail) {
          proxyStatusFailures += 1;
          setProxyStatusBadge("error", "未连接", "本地代理未连接");
          scheduleProxyStatusRetry();
          return false;
        }
      }

      setProxyStatusBadge("pending", "检测中", "默认端口未响应，正在探测本地代理端口");
      try { await global.WpsAiRuntime?.reprobe?.(); } catch (error) {}

      try {
        const health = await fetchProxyHealth();
        proxyStatusFailures = 0;
        setProxyStatusBadge("ok", "正常运行", `本地代理正常运行：127.0.0.1:${health.port}${health.pid ? ` · pid ${health.pid}` : ""}`);
        hidePluginStartupOverlay();
        return true;
      } catch (error) {
        proxyStatusFailures += 1;
        setProxyStatusBadge("error", "未连接", "本地代理未连接，稍后自动重试");
        scheduleProxyStatusRetry();
        return false;
      }
    })().finally(() => {
      proxyStatusCheckInFlight = null;
    });
    return proxyStatusCheckInFlight;
  }

  const CLIPBOARD_PROXY_RETRY_DELAYS_MS = [0, 160, 320, 640, 1000, 1400, 1800];
  const NAVIGATOR_CLIPBOARD_READ_TIMEOUT_MS = 180;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clipboardTextProxyUrl() {
    return global.WpsAiRuntime?.proxyUrl
      ? global.WpsAiRuntime.proxyUrl("/clipboard/text")
      : ((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/clipboard/text");
  }

  async function readNavigatorClipboardTextWithTimeout(timeoutMs = NAVIGATOR_CLIPBOARD_READ_TIMEOUT_MS) {
    const reader = navigator.clipboard?.readText;
    if (typeof reader !== "function") return "";
    let timer = 0;
    try {
      const text = await Promise.race([
        Promise.resolve().then(() => reader.call(navigator.clipboard)),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(""), Math.max(0, Number(timeoutMs) || 0));
        })
      ]);
      return text ? String(text) : "";
    } catch (error) {
      return "";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function waitForClipboardProxyReady(attempt) {
    try {
      if (attempt > 0) await global.WpsAiRuntime?.reprobe?.();
    } catch (error) {}
  }

  // 代理读剪贴板底层是 PowerShell Get-Clipboard，冷启动常 1~2s（实测暖 ~0.8s）。
  // 超时给 1s 会把这条读取 abort 掉 —— Ctrl+V 走 clipboardData 不受影响，但右键菜单/
  // 「粘贴剪贴板」按钮只能靠这条代理读取，1s 太紧会「没反应」。放宽到 4s：这两条都是
  // 用户显式动作，宁可多等一下也别读不到；正常粘贴（原生 paste 事件）本就不经过这里。
  const CLIPBOARD_PROXY_FETCH_TIMEOUT_MS = 4000;

  async function fetchClipboardTextProxyOnce() {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, CLIPBOARD_PROXY_FETCH_TIMEOUT_MS)
      : 0;
    try {
      const res = await fetch(clipboardTextProxyUrl(), {
        method: "GET",
        cache: "no-store",
        signal: controller ? controller.signal : undefined
      });
      const json = await res.json().catch(() => ({}));
      return { res, json };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function readClipboardTextViaProxy(options = {}) {
    const delays = Array.isArray(options.delays) ? options.delays : CLIPBOARD_PROXY_RETRY_DELAYS_MS;
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      const delay = Number(delays[attempt] || 0);
      if (delay > 0) await sleep(delay);
      await waitForClipboardProxyReady(attempt);
      try {
        const { res, json } = await fetchClipboardTextProxyOnce();
        if (res.ok && json && json.ok) {
          setProxyStatusBadge("ok", "正常运行", `本地代理正常运行：${global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"}`);
          return { ok: true, text: String(json.text || "") };
        }
        lastError = new Error(String(json?.error || `clipboard/text ${res.status}`));
      } catch (error) {
        lastError = error;
      }
    }
    return { ok: false, text: "", error: lastError };
  }

  // WPS 焦点接管 —— 修复「右侧输入框和左侧文档同时有光标，Ctrl+V/C/X/A 等编辑快捷键只进左侧文档」。
  // 根因：WPS 主程序活动文档(Word/PPT/ET)持续持有 OS 级键盘焦点，WebView 里的 focus() 只是逻辑焦点，
  // 编辑快捷键仍被主窗口截获。修法：可编辑元素获得焦点 + 按下编辑快捷键的瞬间，都调
  // CommandBars.ReleaseFocus() 让主窗口让出 OS 键盘焦点。API 不存在则静默退回原行为。每个 document 只装一次。
  function installWpsFocusReleaseForDocument(doc, options = {}) {
    doc = doc || document;
    if (doc.__wpsFocusReleaseInstalled) {
      if (!options.force) return;
      try { if (typeof doc.__wpsFocusReleaseCleanup === "function") doc.__wpsFocusReleaseCleanup(); } catch (e) {}
    }
    doc.__wpsFocusReleaseInstalled = true;
    const cleanupFns = [];
    const onDoc = (type, handler, capture = true) => {
      doc.addEventListener(type, handler, capture);
      cleanupFns.push(() => {
        try { doc.removeEventListener(type, handler, capture); } catch (e) {}
      });
    };
    doc.__wpsFocusReleaseCleanup = () => {
      while (cleanupFns.length) {
        const cleanup = cleanupFns.pop();
        try { cleanup(); } catch (e) {}
      }
      doc.__wpsFocusReleaseInstalled = false;
      doc.__wpsFocusReleaseCleanup = null;
    };
    const activeElement = () => doc.activeElement || document.activeElement;
    const release = () => {
      let ok = false;
      // 跨平台尽力：CommandBars.ReleaseFocus 在 Windows / Linux 桌面版 WPS 上有，但不同平台 app 对象
      // 的取法不一（有时 getApplicationSync 拿到的那个没挂 CommandBars）。逐个候选 app 都试一遍，
      // 任一成功即释放主窗口 OS 键盘焦点 —— 这样 Windows 之外（Linux，以及有该 API 的 mac 版本）也能覆盖。
      const tryReleaseOn = (a) => {
        try {
          if (a && a.CommandBars && typeof a.CommandBars.ReleaseFocus === "function") {
            a.CommandBars.ReleaseFocus();
            return true;
          }
        } catch (e) {}
        return false;
      };
      try {
        ok = tryReleaseOn(global.WpsAiAddon?.getApplicationSync?.())
          || tryReleaseOn(global.Application)
          || tryReleaseOn(global.wps?.Application)
          || tryReleaseOn(typeof global.wps?.WpsApplication === "function" ? global.wps.WpsApplication() : null);
      } catch (e) {}
      // 一次性诊断：打印当前平台到底有没有 ReleaseFocus —— mac 上若始终 released=false，说明该版本
      // WPS 不暴露此 API，双份粘贴需要另找 mac 专用的焦点释放途径（请把这行日志回报）。
      if (!global.__lingxiFocusDiagLogged) {
        global.__lingxiFocusDiagLogged = true;
        try {
          const a = global.WpsAiAddon?.getApplicationSync?.() || global.Application || null;
          console.log("[lingxi] focus-release 诊断:", {
            hasApp: !!a,
            hasCommandBars: !!(a && a.CommandBars),
            hasReleaseFocus: !!(a && a.CommandBars && typeof a.CommandBars.ReleaseFocus === "function"),
            released: ok,
            ua: (navigator.userAgent || "").slice(0, 80)
          });
        } catch (e) {}
      }
      // 补一手：让 WebView 窗口抢回 OS 键盘焦点（ReleaseFocus 不存在/不生效时的兜底，mac WKWebView 上常无效但无害）
      try { if (typeof window.focus === "function") window.focus(); } catch (e) {}
      return ok;
    };
    const isEditable = (el) => {
      if (global.WpsAiEditShortcuts?.isEditableElement) return global.WpsAiEditShortcuts.isEditableElement(el);
      if (!el || !el.tagName) return false;
      const t = el.tagName;
      return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable === true;
    };
    const editableTarget = (target) => (
      global.WpsAiEditShortcuts?.getEditableTarget?.(target, activeElement())
      || (isEditable(target) ? target : (isEditable(activeElement()) ? activeElement() : null))
    );
    const writeTextToClipboard = async (text, restoreEl) => {
      if (!text) return false;
      const clipboardDoc = (restoreEl && restoreEl.ownerDocument) || doc || document;
      const restoreStart = restoreEl && typeof restoreEl.selectionStart === "number" ? restoreEl.selectionStart : null;
      const restoreEnd = restoreEl && typeof restoreEl.selectionEnd === "number" ? restoreEl.selectionEnd : null;
      const restoreFocus = () => {
        if (!restoreEl) return;
        try { if (typeof restoreEl.focus === "function") restoreEl.focus(); } catch (e) {}
        if (restoreStart != null && restoreEnd != null) {
          try {
            restoreEl.selectionStart = restoreStart;
            restoreEl.selectionEnd = restoreEnd;
          } catch (e) {}
        }
      };
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          restoreFocus();
          return true;
        }
      } catch (e) { /* fallthrough */ }
      try {
        let ta = clipboardDoc.createElement("textarea");
        ta.value = text;
        ta.setAttribute("data-wps-ai-clipboard-fallback", "1");
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
        clipboardDoc.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = clipboardDoc.execCommand("copy");
        if (ta.parentNode) ta.parentNode.removeChild(ta);
        restoreFocus();
        if (ok) return true;
      } catch (e) {
        try {
          const stale = clipboardDoc.querySelectorAll("textarea[data-wps-ai-clipboard-fallback]");
          stale.forEach((el) => { try { el.parentNode?.removeChild(el); } catch (removeError) {} });
        } catch (cleanupError) {}
      }
      try {
        const url = global.WpsAiRuntime?.proxyUrl
          ? global.WpsAiRuntime.proxyUrl("/clipboard/text")
          : ((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/clipboard/text");
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: String(text || "") })
        });
        const json = await res.json().catch(() => ({}));
        restoreFocus();
        if (res.ok && json && json.ok) return true;
      } catch (error) {
        restoreFocus();
      }
      return false;
    };
    let pendingManualPaste = null;
    // 粘贴以原生 paste 事件为主（不再拦截 Ctrl+V），蒙版只在原生粘贴迟迟没触发、
    // 走到单次兜底读取时才可能出现。延迟 350ms 再显示——快的粘贴一闪而过就别弹了。
    let _pasteMaskTimer = null;
    const showPasteMaskSoon = () => {
      clearTimeout(_pasteMaskTimer);
      _pasteMaskTimer = setTimeout(() => {
        if (!pendingManualPaste) return; // 已经粘完了就别弹
        let el = doc.getElementById("lingxiPasteMask");
        if (!el) {
          el = doc.createElement("div");
          el.id = "lingxiPasteMask";
          el.className = "lingxi-paste-mask";
          el.innerHTML = '<div class="lingxi-paste-box"><span class="lingxi-paste-spinner"></span><span>正在粘贴…</span></div>';
          (doc.body || doc.documentElement).appendChild(el);
        }
        el.classList.remove("hidden");
      }, 350);
    };
    const hidePasteMask = () => {
      clearTimeout(_pasteMaskTimer);
      const el = doc.getElementById("lingxiPasteMask");
      if (el) el.classList.add("hidden");
    };
    const insertClipboardTextInto = (target, text) => {
      if (!target || !text) return false;
      if (global.WpsAiEditShortcuts?.insertTextAtCursor) {
        return global.WpsAiEditShortcuts.insertTextAtCursor(target, text);
      }
      insertAtCursor(target, text);
      return true;
    };
    const readClipboardTextFallback = async () => {
      const text = await readNavigatorClipboardTextWithTimeout();
      if (text) return text;
      const proxyResult = await readClipboardTextViaProxy();
      if (proxyResult.ok) return proxyResult.text;
      return "";
    };
    // 原生粘贴的单次兜底：只有当浏览器没有派发（或没被我们收到）paste 事件、
    // 蒙版计时器到点时才跑一次，不再嵌套重试。总耗时上限约 1.5s
    // （navigator.clipboard 的短超时 + 一次代理 fetch 的 1s 超时）。
    function runPasteSafetyFallback(pending) {
      if (!pending || pending.handled || pendingManualPaste !== pending) return;
      const editEl = pending.target;
      try { if (typeof editEl?.focus === "function") editEl.focus(); } catch (e) {}
      const finish = (txt) => {
        if (pendingManualPaste !== pending || pending.handled) return;
        pending.handled = true;
        pendingManualPaste = null;
        hidePasteMask();
        if (!txt) return;
        const target = editableTarget(editEl) || editEl;
        if (!handleChatPastedText(target, txt)) insertClipboardTextInto(target, txt);
      };
      readNavigatorClipboardTextWithTimeout()
        .then((txt) => {
          if (txt || pendingManualPaste !== pending || pending.handled) return txt;
          return readClipboardTextViaProxy({ delays: [0] }).then((r) => (r.ok ? r.text : ""));
        })
        .then(finish)
        .catch(() => finish(""));
    }

    // 覆盖所有输入框（聊天 / 设置 / 大纲 / 各弹窗输入…），不止聊天框——"类似问题"一并修
    global.WpsAiClipboard = Object.assign({}, global.WpsAiClipboard, {
      readText: readClipboardTextFallback,
      pasteInto(target) {
        return readClipboardTextFallback().then((txt) => {
          if (!txt) return false;
          const editTarget = editableTarget(target) || target;
          if (handleChatPastedText(editTarget, txt)) return true;
          return insertClipboardTextInto(editTarget, txt);
        });
      }
    });

    onDoc("focusin", (ev) => { if (isEditable(ev.target)) release(); }, true);
    // 右侧聊天区域一被点击（不限可编辑元素）就让出主窗口 OS 焦点 —— 根因修复：
    // 否则左侧文档的插入点(光标)仍然活着，Ctrl+V 会被同时投递给文档和聊天框 → 双份粘贴。
    // 用 pointerdown 捕获阶段：早于 focus 结算，抢焦点最及时，比只在 focusin(可编辑元素) 时释放覆盖更全。
    onDoc("pointerdown", () => { release(); }, true);
    // 编辑快捷键按下的瞬间再让一次焦点，防止主窗口在 focus 后又抢回去（focus 一次性不够）
    onDoc("keydown", (ev) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const editEl = editableTarget(ev.target);
      if (!editEl) return;
      const k = String(ev.key || "").toLowerCase();
      if (k === "v") {
        // 不再拦截原生粘贴：release() 把 OS 键盘焦点从 WPS 主窗口让给 WebView，
        // 之后让浏览器原生派发 paste 事件（下面的 paste 监听器负责插入），
        // 这样粘贴是瞬时的，不用等我们手动读剪贴板。
        release();
        try { window.focus(); } catch (e) {}
        pendingManualPaste = { target: editEl, ts: Date.now(), handled: false, timer: null };
        pendingManualPaste.timer = setTimeout(() => runPasteSafetyFallback(pendingManualPaste), 300);
        showPasteMaskSoon();
        return;
      }
      if (k === "a" || k === "c" || k === "x") {
        release();
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
        if (k === "a") {
          if (global.WpsAiEditShortcuts?.selectAllText) global.WpsAiEditShortcuts.selectAllText(editEl);
          else {
            try {
              editEl.selectionStart = 0;
              editEl.selectionEnd = String(editEl.value || "").length;
            } catch (e) { if (typeof editEl.select === "function") editEl.select(); }
          }
          return;
        }
        const writeText = (text) => writeTextToClipboard(text, editEl);
        if (k === "c") {
          if (global.WpsAiEditShortcuts?.copySelectionToClipboard) {
            global.WpsAiEditShortcuts.copySelectionToClipboard(editEl, writeText)
              .catch(() => {});
          }
          return;
        }
        if (global.WpsAiEditShortcuts?.cutSelectionToClipboard) {
          global.WpsAiEditShortcuts.cutSelectionToClipboard(editEl, writeText)
            .catch(() => {});
        }
        return;
      }
      if (k === "z" || k === "y") {
        const command = global.WpsAiEditShortcuts?.getUndoRedoCommand
          ? global.WpsAiEditShortcuts.getUndoRedoCommand(ev, activeElement())
          : (k === "z" ? (ev.shiftKey ? "redo" : "undo") : "redo");
        if (!command) return;
        release();
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
        try { doc.execCommand(command); } catch (error) {}
      }
    }, true);
    onDoc("paste", (ev) => {
      if (!isEditable(ev.target) && !isEditable(activeElement())) return;
      const shouldHandle = global.WpsAiEditShortcuts?.shouldHandlePasteEvent
        ? global.WpsAiEditShortcuts.shouldHandlePasteEvent(ev, pendingManualPaste, activeElement())
        : !!pendingManualPaste;
      if (!shouldHandle) return;
      // paste 事件到达即是「原生粘贴正在发生」的权威信号：无论能否从 clipboardData
      // 取到文本，都先取消 300ms 兜底，否则 clipboardData 为空但原生默认粘贴仍插入时，
      // 兜底会再读一次剪贴板造成双重插入。
      if (pendingManualPaste) {
        pendingManualPaste.handled = true;
        if (pendingManualPaste.timer) clearTimeout(pendingManualPaste.timer);
      }
      pendingManualPaste = null;
      hidePasteMask();
      const target = editableTarget(ev.target);
      // 聊天输入框粘贴图片 → 直接当附件收，不落地成文本/base64 塞进输入框。
      if (isChatAttachmentInput(target) && ev.clipboardData) {
        const imageFiles = Array.from(ev.clipboardData.items || [])
          .filter((it) => it.kind === "file" && /^image\//.test(it.type))
          .map((it) => it.getAsFile())
          .filter(Boolean);
        if (imageFiles.length > 0) {
          ev.preventDefault();
          ev.stopPropagation();
          if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
          addAttachments(imageFiles);
          return;
        }
      }
      const txt = global.WpsAiEditShortcuts?.readTextFromClipboardEvent
        ? global.WpsAiEditShortcuts.readTextFromClipboardEvent(ev)
        : (ev.clipboardData?.getData("text") || "");
      if (txt && target) {
        // 取到文本：由我们插入（单次），阻止原生默认粘贴以免重复。
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
        // 聊天输入框里的长文本粘贴 → 转存为附件 chip，不再塞进输入框；
        // 短文本 / 非聊天输入框照旧内联插入。
        if (!handleChatPastedText(target, txt)) insertClipboardTextInto(target, txt);
      }
      // txt 为空：不 preventDefault，让浏览器原生默认粘贴插入；兜底已取消，不会二次插入。
    }, true);
  }

  function installWpsFocusRelease() {
    installWpsFocusReleaseForDocument(document);
  }

  // 把逐页文本拼成带页码标记的上下文块；超预算按页截断并标记 truncated。纯函数，可测。
  function buildPdfTextContext(pages, budgetChars = 216000) {
    const parts = [];
    let acc = 0, used = 0, truncated = false;
    for (const pg of (Array.isArray(pages) ? pages : [])) {
      const t = String((pg && pg.text) || "").trim();
      if (!t) continue; // 空白/图片页不计入 usedPages，否则会骗过"无可翻译文字"的判断
      const block = `[P${pg.page}] ${t}`;
      if (parts.length && acc + block.length > budgetChars) { truncated = true; break; }
      parts.push(block); acc += block.length; used += 1;
    }
    const header = "以下是当前 PDF 的提取正文（每段前的 [P页码] 是页码，回答/引用时请据此标注页码）：\n\n";
    return { contextText: header + parts.join("\n\n"), charCount: acc, usedPages: used, totalPages: (Array.isArray(pages) ? pages.length : 0), truncated };
  }

  // 双通道读 PDF：数字版走「文字通道」（proxy 抽带页码文字，任意模型可读、便宜、可分块），
  // 扫描件/无文字层回退「多模态通道」（整文件附件，需支持 PDF 的模型）。
  // 返回 { mode:"text", contextText, charCount, usedPages, totalPages, truncated } |
  //      { mode:"file" }（已挂 PDF 附件） | null（失败，已提示）。
  async function preparePdfContext({ silent = false, pageNumbers = null, docPath: docPathOverride = null } = {}) {
    // 1) 解析 PDF 路径：独立弹窗窗口用主窗口传入的 docPath；否则先 sync（getCurrentDocPath 含 ActivePDF 分支）再退 async
    plog("pdfPath.prepare", { stage: "start", silent, hasOverride: !!docPathOverride, pageNumbers: Array.isArray(pageNumbers) ? pageNumbers : null });
    const docPath = await resolveActivePdfPath(docPathOverride);
    if (!docPath) {
      pwarn("pdfPath.prepare", { stage: "path.miss", lastError: lastActivePdfPathError || "" });
      if (!silent) showMessage(lastActivePdfPathError || "没读到 PDF 路径，请确认 PDF 已保存并处于打开状态。", "error");
      return null;
    }
    if (!/\.pdf$/i.test(docPath)) {
      pwarn("pdfPath.prepare", { stage: "path.notPdf", docPath });
      if (!silent) showMessage(`当前文档不是 PDF：${docPath}`, "error");
      return null;
    }
    plog("pdfPath.prepare", { stage: "path.hit", docPath });
    // 2) 文字提取（失败不致命，回退多模态）
    const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
    let extract = null;
    try {
      const resp = await fetch(base + "/pdf-extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: docPath })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || `提取失败 ${resp.status}`);
      extract = payload;
    } catch (e) {
      console.warn("[pdf] 文字提取失败，回退多模态:", e && (e.message || e));
    }
    // 3) 有文字层 → 文字通道（可按 pageNumbers 只取指定页）
    if (extract && extract.hasText && Array.isArray(extract.pages) && extract.pages.length) {
      let pages = extract.pages;
      if (Array.isArray(pageNumbers) && pageNumbers.length) {
        const set = new Set(pageNumbers);
        pages = pages.filter((p) => set.has(p.page));
      }
      return Object.assign({ mode: "text", pageCount: extract.pageCount }, buildPdfTextContext(pages));
    }
    // 4) 否则 → 多模态回退（整文件，无法按页裁）
    if (docPathOverride) {
      // 独立弹窗窗口里挂不了附件、也发不了主面板对话；返回 file 让调用方提示走主面板
      return { mode: "file", pageCount: extract && extract.pageCount };
    }
    const att = await attachActivePdf({ silent, docPath });
    if (!att) return null;
    const modelName = els.modelSelect?.value;
    if (!isPdfModel(modelName) && !silent) {
      showMessage(`该 PDF 无文字层（可能是扫描件），需支持 PDF 的模型识别。当前「${modelName}」不支持，请切到 Claude / GPT-4o 等。`, "info", { duration: 6000 });
    }
    return { mode: "file", pageCount: extract && extract.pageCount };
  }

  // PDF 快捷动作统一入口：准备上下文（文字/多模态）→ 组装最终 prompt → runChatTurn。
  async function runPdfChatTurn(prompt, docPathHint = null, turnOpts = {}) {
    const text = String(prompt || "").trim();
    if (!text) return;
    const ctx = await preparePdfContext({ silent: false, docPath: docPathHint });
    if (!ctx) return; // 失败已提示
    let finalPrompt = text;
    if (ctx.mode === "text") {
      finalPrompt = ctx.contextText + "\n\n---\n\n" + text;
      if (ctx.truncated) {
        showMessage(`PDF 较大，本次按前 ${ctx.usedPages}/${ctx.totalPages} 页（约 ${Math.round(ctx.charCount / 1000)}k 字）处理。`, "info", { duration: 6000 });
      }
    }
    runChatTurn(finalPrompt, turnOpts);
  }

  // ==== PDF 对照翻译独立弹窗：选原文/目标语言 → 数字版走文字通道弹窗内流式；扫描件回退对话流 ====
  const PT_LANGS = ["简体中文", "繁体中文", "英语", "日语", "韩语", "法语", "德语", "西班牙语", "俄语", "葡萄牙语", "意大利语", "阿拉伯语", "泰语", "越南语"];
  let _ptRunToken = 0;
  let _ptResultText = "";
  let _ptBusy = false;
  let _ptRenderTimer = null;
  let _ptDialogDocPath = null; // 独立弹窗窗口里由主窗口传入的 PDF 路径（弹窗自身取不到活动文档）

  // 解析 "1-5, 8, 12-15" → 去重升序页码数组；非法片段忽略，可选 max 做上限裁剪。
  function parsePageRange(str, max) {
    const out = new Set();
    String(str || "").split(/[,，\s]+/).forEach((seg) => {
      seg = seg.trim();
      if (!seg) return;
      const m = seg.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) { const t = a; a = b; b = t; }
        if (b - a > 5000) b = a + 5000; // 防御：超大区间（如 1-99999999）截断，避免死循环/OOM
        for (let i = a; i <= b; i += 1) out.add(i);
      } else if (/^\d+$/.test(seg)) {
        out.add(parseInt(seg, 10));
      }
    });
    let arr = Array.from(out).filter((n) => n >= 1 && (!max || n <= max));
    arr.sort((a, b) => a - b);
    return arr;
  }

  function populateParallelTranslateLangs() {
    const src = els.ptSourceLang, tgt = els.ptTargetLang;
    if (!src || !tgt || src.dataset.filled === "1") return;
    src.innerHTML = '<option value="自动检测">自动检测</option>' + PT_LANGS.map((l) => `<option value="${l}">${l}</option>`).join("");
    tgt.innerHTML = PT_LANGS.map((l) => `<option value="${l}">${l}</option>`).join("");
    src.value = "自动检测";
    tgt.value = "简体中文";
    src.dataset.filled = "1";
  }

  function bindParallelTranslateModal() {
    const modal = els.parallelTranslateModal;
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    els.ptCloseBtn?.addEventListener("click", () => closeParallelTranslateModal());
    els.ptCloseBtn2?.addEventListener("click", () => closeParallelTranslateModal());
    try { console.log("[pt] bindModal", { hasRunBtn: !!els.ptRunBtn, hasModal: !!modal, hasScope: !!els.ptScope, hasResult: !!els.ptResult }); } catch (e) {}
    els.ptRunBtn?.addEventListener("click", () => { try { console.log("[pt] runBtn click"); } catch (e) {} runParallelTranslate(); });
    els.ptCopyBtn?.addEventListener("click", () => copyParallelTranslateResult());
    els.ptScope?.addEventListener("change", () => {
      els.ptPagesField?.classList.toggle("hidden", els.ptScope.value !== "pages");
    });
    modal.addEventListener("click", (ev) => { if (ev.target === modal) closeParallelTranslateModal(); });
  }

  function setParallelTranslateDocPath(docPath) {
    const path = String(docPath || "").trim();
    _ptDialogDocPath = path || null;
    return path;
  }

  // 主窗口入口：优先用 ShowDialog 开独立窗口（脱离面板宽度）；老版本无 ShowDialog 时退回 in-page 弹窗。
  async function openParallelTranslateAsDialog(docPathHint) {
    let docPath = (typeof docPathHint === "string" && docPathHint.trim()) ? docPathHint.trim() : null;
    if (!docPath) {
      try { docPath = global.WpsAiBackup?.getCurrentDocPath?.(); } catch (e) {}
    }
    if (!docPath || !/\.pdf$/i.test(docPath)) {
      try { const p = await global.WpsAiHostPdf?.getActivePdfPath?.(); if (p) docPath = p; } catch (e) {}
    }
    if (!docPath || !/\.pdf$/i.test(docPath)) docPath = null;
    const app = global.WpsAiAddon?.getApplicationSync?.();
    if (app && typeof app.ShowDialog === "function") {
      try { localStorage.setItem(PARALLEL_TRANSLATE_DIALOG_REQUEST_KEY, JSON.stringify({ ts: Date.now(), docPath })); } catch (e) {}
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=paralleltranslate`;
      const { w, h } = pickDialogSize(900, 720, { minW: 700, minH: 520 });
      app.ShowDialog(url, i18nDialogTitle("对照翻译"), w, h, true);
      try { activateWpsApp(app); } catch (e) {}
      setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
      return;
    }
    // 兜底：无 ShowDialog → in-page 弹窗（用主窗口已解析的路径）
    setParallelTranslateDocPath(docPath);
    openParallelTranslateModal();
  }

  function resetParallelTranslateResult() {
    if (_ptRenderTimer) { clearTimeout(_ptRenderTimer); _ptRenderTimer = null; }
    _ptResultText = "";
    ptSetStatus("");
    if (els.ptResult) els.ptResult.innerHTML = '<p class="muted pt-empty">选好语言后点「开始翻译」，这里会显示原文 / 译文对照。</p>';
  }

  function openParallelTranslateModal() {
    if (!els.parallelTranslateModal) return;
    bindParallelTranslateModal();
    populateParallelTranslateLangs();
    resetParallelTranslateResult(); // 清掉上一次结果，避免复制/显示到旧内容
    els.parallelTranslateModal.classList.remove("hidden");
  }

  function closeParallelTranslateModal() {
    _ptRunToken += 1; // 丢弃在途流式 token
    _ptBusy = false;
    if (els.ptRunBtn) { els.ptRunBtn.disabled = false; els.ptRunBtn.textContent = "开始翻译"; }
    if (isParallelTranslateDialog) { try { window.close(); } catch (e) {} return; } // 独立窗口：关窗
    els.parallelTranslateModal?.classList.add("hidden");
  }

  function ptSetStatus(text) {
    if (!els.ptStatus) return;
    if (text) { els.ptStatus.textContent = text; els.ptStatus.classList.remove("hidden"); }
    else els.ptStatus.classList.add("hidden");
  }

  // 独立窗口里的 showMessage toast 有时挂不到可见容器，错误就"静默"了——用户点了没反应。
  // 统一走这里：清状态 + 把错误直接渲进结果区（永远可见）+ 打 console + 再尝试 toast。
  function ptShowError(text) {
    ptSetStatus("");
    try { console.warn("[pt] " + text); } catch (e) {}
    if (els.ptResult) {
      const safe = String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      els.ptResult.innerHTML = '<p class="pt-empty" style="color:#c0392b;white-space:pre-wrap">' + safe + "</p>";
    }
    try { showMessage(text, "error", { autoHide: false }); } catch (e) {}
  }

  function ptRenderResult(text) {
    if (!els.ptResult) return;
    els.ptResult.innerHTML = global.WpsAiMarkdown?.renderToHtml
      ? global.WpsAiMarkdown.renderToHtml(text)
      : ("<pre>" + String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) + "</pre>");
  }

  function ptScheduleRender(text) {
    if (_ptRenderTimer) return;
    _ptRenderTimer = setTimeout(() => {
      _ptRenderTimer = null;
      ptRenderResult(text);
      if (els.ptResult) els.ptResult.scrollTop = els.ptResult.scrollHeight;
    }, 120);
  }

  async function copyParallelTranslateResult() {
    const t = String(_ptResultText || "").trim();
    if (!t) { showMessage("还没有可复制的结果。", "info"); return; }
    try { await navigator.clipboard.writeText(t); showMessage("已复制对照翻译。", "success"); }
    catch (e) { showMessage("复制失败：" + (e?.message || e), "error"); }
  }

  async function runParallelTranslate() {
    if (_ptBusy) {
      try { console.warn("[pt] 忽略点击：上一次翻译仍在进行 (_ptBusy=true)"); } catch (e) {}
      showMessage("上一次翻译还在进行中，请稍候或关闭窗口重开。", "info");
      return;
    }
    const source = els.ptSourceLang?.value || "自动检测";
    const target = els.ptTargetLang?.value || "简体中文";
    const scope = els.ptScope?.value || "all";
    let pageNumbers = null;
    if (scope === "pages") {
      pageNumbers = parsePageRange(els.ptPages?.value || "");
      if (!pageNumbers.length) { ptShowError("请填写有效页码，如 1-5, 8, 12-15。"); return; }
    }
    try {
      console.log("[pt] run", { source, target, scope, pageNumbers, docPath: _ptDialogDocPath, isDialog: isParallelTranslateDialog, model: els.modelSelect?.value || "" });
    } catch (e) {}
    const srcHint = source === "自动检测" ? "源语言自动识别。" : ("源语言是" + source + "。");
    const structHint = "尽量保留原文的排版结构与顺序：按自然段/标题/列表逐块对照，一段原文对应一段译文，标题和列表项各自成行，不要合并、不要重排、不要漏译。";
    const docPath = setParallelTranslateDocPath(_ptDialogDocPath || "");
    if (!docPath || !/\.pdf$/i.test(docPath)) {
      showMessage("未读到当前 PDF 的本机路径，无法读取文件内容。已记录 PDF 路径探测日志，请查看 dev 终端。", "error", { autoHide: false });
      return;
    }
    _ptBusy = true;
    const myToken = ++_ptRunToken;
    if (els.ptRunBtn) { els.ptRunBtn.disabled = true; els.ptRunBtn.textContent = "翻译中…"; }
    _ptResultText = "";
    if (els.ptResult) els.ptResult.innerHTML = "";
    ptSetStatus("读取 PDF…");
    try {
      const ctx = await preparePdfContext({ silent: false, pageNumbers, docPath });
      try { console.log("[pt] ctx", ctx && { mode: ctx.mode, usedPages: ctx.usedPages, totalPages: ctx.totalPages, pageCount: ctx.pageCount }); } catch (e) {}
      if (!ctx) {
        ptSetStatus("");
        ptShowError("没能读到 PDF 内容（路径解析或文字提取失败）。请确认 PDF 已保存并打开，或重开对照翻译窗口。");
        return;
      }
      if (myToken !== _ptRunToken) return;   // 期间被取消/重开
      if (ctx.mode === "file") {
        if (isParallelTranslateDialog) {
          // 独立窗口没有对话流、也挂不了附件；扫描件请回主面板
          ptShowError("该 PDF 是扫描件（无文字层），独立窗口无法按页翻译；请关掉本窗口，在主面板直接让支持 PDF 的模型翻译。");
          return;
        }
        // in-page（主窗口）：走对话流（附件已挂上）；无法按页裁
        closeParallelTranslateModal();
        showMessage("该 PDF 是扫描件，已在对话流中生成对照翻译。" + (pageNumbers ? "（扫描件无法按页裁，翻译整份）" : ""), "info", { duration: 6000 });
        runChatTurn([
          "请把当前 PDF 翻译成" + target + "。" + srcHint,
          structHint,
          "输出 markdown 表格，原文单元格标注页码：", "| 原文 | 译文 |", "| --- | --- |",
          "规则：专有名词、数字、公式保留原样；只输出表格。"
        ].join("\n"));
        return;
      }
      // 文字通道：弹窗内流式
      if (!ctx.usedPages) {
        ptShowError(pageNumbers
          ? `指定页（${pageNumbers.join(", ")}）没有提取到可翻译的文字，PDF 共 ${ctx.pageCount || "?"} 页。请确认页码在范围内，或该页是否为纯图片。`
          : "PDF 没有可翻译的文字（可能是扫描件）。");
        return;
      }
      ptSetStatus(`共 ${ctx.pageCount || "?"} 页，本次翻译 ${ctx.usedPages} 页 · 翻译中…`);
      const userMsg = [
        ctx.contextText, "\n---\n",
        "请把上面的 PDF 正文翻译成" + target + "。" + srcHint,
        structHint + "原文单元格保留页码标记 [P页码]。",
        "输出 markdown 表格：", "",
        "| 原文 | 译文 |", "| --- | --- |", "",
        "规则：数字、公式、专有名词、人名地名保留原样；只输出表格，不要前后多余文字。"
      ].join("\n");
      const messages = [
        { role: "system", content: "你是专业翻译。严格只输出 markdown 对照翻译表格，尽量保留原文排版结构，不要任何解释。" },
        { role: "user", content: userMsg }
      ];
      const finalText = await callProviderForPreviewChat(messages, (_tok, full) => {
        if (myToken !== _ptRunToken) return;
        _ptResultText = full;
        ptScheduleRender(full);
      });
      if (myToken !== _ptRunToken) return;
      _ptResultText = finalText || _ptResultText;
      ptRenderResult(_ptResultText);
      ptSetStatus(`完成 · 共 ${ctx.pageCount || "?"} 页，翻译 ${ctx.usedPages} 页` + (ctx.truncated ? "（过大已截断）" : ""));
    } catch (e) {
      try { console.warn("[pt] 失败", e); } catch (_) {}
      if (myToken === _ptRunToken) { ptShowError("对照翻译失败：" + (e?.message || e)); }
    } finally {
      if (myToken === _ptRunToken) {
        _ptBusy = false;
        if (els.ptRunBtn) { els.ptRunBtn.disabled = false; els.ptRunBtn.textContent = "开始翻译"; }
      }
    }
  }

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachments();
  }

  function renderAttachments() {
    if (!els.chatAttachments) return;
    els.chatAttachments.innerHTML = "";
    if (pendingAttachments.length === 0) {
      els.chatAttachments.classList.add("hidden");
      return;
    }
    els.chatAttachments.classList.remove("hidden");
    const modelName = els.modelSelect?.value;
    const multimodal = isMultimodalModel(modelName);
    const pdfReady = isPdfModel(modelName);
    pendingAttachments.forEach((att) => {
      const incompatible = (att.kind === "image" && !multimodal) || (att.kind === "pdf" && !pdfReady);
      const chip = document.createElement("div");
      chip.className = "chat-attach-chip" + (incompatible ? " warn" : "");
      let preview;
      // 修 B16：att.name 来自用户选择的文件名，未转义直接拼 innerHTML 会导致 XSS。
      const safeName = escapeHtml(att.name);
      if (att.kind === "image") preview = `<img class="chat-attach-thumb" src="${escapeAttr(att.dataUrl)}" alt="${safeName}" />`;
      else if (att.kind === "pdf") preview = `<span class="chat-attach-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg></span>`;
      else preview = `<span class="chat-attach-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>`;
      let warn = "";
      if (att.kind === "image" && !multimodal) warn = " · ⚠ 当前模型不支持图片";
      else if (att.kind === "pdf" && !pdfReady) warn = " · ⚠ 当前模型不支持 PDF";
      // TEXT 附件（长文本粘贴 / .txt·.md 拖拽）额外加一个「预览」眼睛图标按钮，
      // 点开可看 att.textContent 全文，不用把整段文字堆进输入框才能看清。
      const previewBtnHtml = att.kind === "text"
        ? `<button class="chat-attach-preview" type="button" title="预览" aria-label="预览" data-att-id="${att.id}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>`
        : "";
      chip.innerHTML = `
        ${preview}
        <div class="chat-attach-meta">
          <div class="chat-attach-name" title="${safeName}">${safeName}</div>
          <div class="chat-attach-size">${fmtFileSize(att.size)}${warn}</div>
        </div>
        ${previewBtnHtml}
        <button class="chat-attach-remove" type="button" title="移除" data-att-id="${att.id}">×</button>
      `;
      chip.querySelector(".chat-attach-preview")?.addEventListener("click", () => showTextAttachmentPreview(att));
      chip.querySelector(".chat-attach-remove").addEventListener("click", () => removeAttachment(att.id));
      els.chatAttachments.appendChild(chip);
    });
  }

  // TEXT 附件全文预览弹窗：点眼睛图标弹出，显示 att.textContent 全文（只读）。
  // 复用项目通用的 .modal-overlay 遮罩类；正文用 .textContent 赋值，杜绝 XSS。
  function showTextAttachmentPreview(att) {
    if (!att || att.kind !== "text") return;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay attach-preview-overlay";
    overlay.innerHTML = `
      <div class="attach-preview-box" role="dialog" aria-modal="true">
        <div class="attach-preview-header">
          <div class="attach-preview-title"></div>
          <button class="attach-preview-close" type="button" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="attach-preview-body">
          <pre class="attach-preview-pre"></pre>
        </div>
      </div>`;
    overlay.querySelector(".attach-preview-title").textContent = att.name || "";
    overlay.querySelector(".attach-preview-pre").textContent = att.textContent || "";
    document.body.appendChild(overlay);

    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    overlay.querySelector(".attach-preview-close").addEventListener("click", close);
  }

  // 拖文件到聊天输入框 → 直接走 addAttachments（复用类型白名单 + 大小限制）。
  // 绑在 textarea 上；有 .chat-input-box 外层包装的话一起绑，扩大可放开的范围，
  // 视觉高亮也加在外层（textarea 太窄，高亮外层更明显）。
  function bindChatAttachmentDrop() {
    const input = els.chatInput;
    if (!input || input.dataset.attachDropBound === "1") return;
    input.dataset.attachDropBound = "1";
    const wrapper = input.closest?.(".chat-input-box") || null;
    const highlightEl = wrapper || input;
    const targets = wrapper ? [input, wrapper] : [input];
    const setDragOver = (on) => highlightEl.classList.toggle("drag-over", on);
    targets.forEach((el) => {
      el.addEventListener("dragover", (ev) => {
        ev.preventDefault(); // 必须 preventDefault，drop 事件才会触发
        setDragOver(true);
      });
      el.addEventListener("dragleave", () => setDragOver(false));
      el.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setDragOver(false);
        addAttachments(ev.dataTransfer?.files);
      });
    });
  }

  function bindAttachments() {
    if (!els.chatAttachBtn || !els.chatAttachFile) return;
    els.chatAttachBtn.addEventListener("click", () => els.chatAttachFile.click());
    els.chatAttachFile.addEventListener("change", (ev) => {
      addAttachments(ev.target.files);
      ev.target.value = "";   // 允许同名文件再选
    });
    // 「附加当前 PDF」按钮：把 WPS 里打开的 PDF 读进附件
    els.chatAttachActiveBtn?.addEventListener("click", () => attachActivePdf({ silent: false }));
    // 修订模式（仅 WPS 文字）：开关 + 接受全部 / 全部回撤
    els.reviseModeToggle?.addEventListener("change", onReviseModeToggle);
    els.reviseAcceptAllBtn?.addEventListener("click", () => reviseManageAll("accept_all"));
    els.reviseRejectAllBtn?.addEventListener("click", () => {
      if (!confirm("确定全部回撤？将拒绝所有修订，把文档还原到 AI 改动前。")) return;
      reviseManageAll("reject_all");
    });
    bindChatAttachmentDrop();
    // 模型切换时重渲（更新 ⚠ 标记 + 能力 chip）
    els.modelSelect?.addEventListener("change", updateCapabilityBadges);
    // 思考强度 chip 点击 → 上方弹出强度列表（关/低/中/高），勾选当前项，点某项才切换
    let _thinkingMenu = null;
    function closeThinkingMenu() {
      if (_thinkingMenu) { _thinkingMenu.remove(); _thinkingMenu = null; document.removeEventListener("click", closeThinkingMenu); }
    }
    const THINKING_CHECK_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 7 12 13 4"/></svg>';
    function showThinkingMenu(anchor) {
      closeThinkingMenu();
      const cur = readThinkingLevel();
      const menu = document.createElement("div");
      menu.className = "thinking-menu";
      const order = ["off", "low", "medium", "high"];
      menu.innerHTML = '<div class="thinking-menu-title">思考强度</div>' + order.map((lv) =>
        `<button type="button" class="thinking-menu-item${lv === cur ? " active" : ""}" data-level="${lv}">`
        + `<span class="thinking-menu-check">${lv === cur ? THINKING_CHECK_SVG : ""}</span>`
        + `<span>${THINKING_LEVEL_LABEL[lv]}</span></button>`
      ).join("");
      const rect = anchor.getBoundingClientRect();
      // chip 现在靠右（发送按钮左侧），按右边对齐、向左展开，避免菜单溢出面板右缘
      menu.style.right = Math.max(4, window.innerWidth - rect.right) + "px";
      menu.style.bottom = (window.innerHeight - rect.top + 4) + "px"; // 锚到按钮上方
      menu.addEventListener("click", (e) => {
        const item = e.target.closest(".thinking-menu-item");
        if (!item) return;
        const lv = item.getAttribute("data-level");
        closeThinkingMenu();
        if (lv && lv !== readThinkingLevel()) {
          writeThinkingLevel(lv);
          updateCapabilityBadges();
          showMessage(`思考强度：${THINKING_LEVEL_LABEL[lv]}`, "info");
        }
      });
      document.body.appendChild(menu);
      _thinkingMenu = menu;
      setTimeout(() => document.addEventListener("click", closeThinkingMenu), 0);
    }
    els.capThinking?.addEventListener("click", (ev) => { ev.stopPropagation(); showThinkingMenu(els.capThinking); });

    // 自定义模型下拉：按钮点击开/关；点弹层外面关闭；Esc 关闭
    els.modelSelectBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleModelPopup();
    });
    // 点外面关闭：click + pointerdown 双监听（mac WKWebView 的 click 合成不可靠）
    const closeModelPopupOnOutside = (ev) => {
      if (!els.modelSelectPopup || els.modelSelectPopup.classList.contains("hidden")) return;
      if (els.modelSelectPopup.contains(ev.target) || els.modelSelectBtn?.contains(ev.target)) return;
      closeModelPopup();
    };
    document.addEventListener("click", closeModelPopupOnOutside);
    document.addEventListener("pointerdown", closeModelPopupOnOutside);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !els.modelSelectPopup?.classList.contains("hidden")) {
        closeModelPopup();
      }
    });
  }

  // 在用户消息气泡下方追加一行附件缩略图 chip（live + history 回放共用）
  function appendUserAttachmentsPreview(attachments) {
    if (!attachments || attachments.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "chat-msg user-attachments";
    attachments.forEach((a) => {
      const chip = document.createElement("div");
      chip.className = "user-attach-chip";
      // 修 B16：a.name 为用户文件名，转义防 XSS。
      const safeName = escapeHtml(a.name);
      if (a.kind === "image" && a.dataUrl) {
        chip.innerHTML = `<img class="chat-attach-thumb" src="${escapeAttr(a.dataUrl)}" alt="${safeName}"/><span>${safeName}</span>`;
      } else {
        chip.innerHTML = `<span class="chat-attach-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span><span>${safeName}</span>`;
      }
      wrap.appendChild(chip);
    });
    els.chatStream?.appendChild(wrap);
  }

  let messageTimer = null;
  function showMessage(text, type = "info", { autoHide = true, duration, onClick } = {}) {
    if (!els.message) return;
    const messageText = formatMessageText(text);
    if (text != null && typeof text !== "string") {
      pwarn("showMessage.nonString", {
        type,
        rawType: Object.prototype.toString.call(text),
        displayText: messageText,
        raw: describeForLog(text),
        stack: (() => {
          try { return new Error().stack || ""; } catch (e) { return ""; }
        })()
      });
    }
    if (/\[object Object\]/i.test(messageText)) {
      pwarn("showMessage.objectString", {
        type,
        displayText: messageText,
        originalType: typeof text,
        stack: (() => {
          try { return new Error().stack || ""; } catch (e) { return ""; }
        })()
      });
    }
    if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
    els.message.textContent = messageText;
    els.message.className = `message ${type}`;
    els.message.classList.toggle("hidden", !messageText);
    els.message.classList.toggle("message-clickable", !!onClick);
    // 换掉旧 handler，避免叠加
    if (els.message._wpsaiOnClick) {
      els.message.removeEventListener("click", els.message._wpsaiOnClick);
      els.message._wpsaiOnClick = null;
    }
    if (onClick) {
      const handler = () => { try { onClick(); } catch (e) {} };
      els.message.addEventListener("click", handler);
      els.message._wpsaiOnClick = handler;
    }
    if (messageText && autoHide) {
      const ms = duration ?? (type === "error" ? 5000 : 3000);
      messageTimer = setTimeout(() => {
        els.message.classList.add("hidden");
        messageTimer = null;
      }, ms);
    }
  }

  function setBusy(isBusy) {
    [
      els.signInBtn, els.exchangeCodeBtn, els.signOutBtn,
      els.saveSettingsBtn, els.testChatConnBtn, els.refreshModelsBtn
    ].forEach((b) => { if (b) b.disabled = isBusy; });
  }

  // 修 B10：全局忙碌标志。之前 setChatBusy 只切按钮 hidden class、从不设 disabled，
  // 而推荐操作按钮的点击守卫却检查 disabled（恒 false），导致本轮进行中可并发启动第二轮
  // runChatTurn，引发文档锁提前解除、controller 清错、停止按钮失效、定时器泄漏等连锁故障。
  let chatBusy = false;
  let readOnlyChatTurn = false;

  function setChatBusy(isBusy, { readOnly = false } = {}) {
    const wasBusy = chatBusy;
    if (isBusy) readOnlyChatTurn = !!readOnly;
    const skipDocumentLock = readOnlyChatTurn;
    chatBusy = !!isBusy;
    // Send 与 Stop 按钮互斥：忙碌时显示 Stop，否则显示 Send
    if (els.chatSendBtn) {
      els.chatSendBtn.classList.toggle("hidden", isBusy);
      els.chatSendBtn.disabled = !!isBusy;
    }
    if (els.chatStopBtn) els.chatStopBtn.classList.toggle("hidden", !isBusy);

    [els.modelSelect].forEach((b) => { if (b) b.disabled = isBusy; });
    if (els.suggestedActionsList) {
      els.suggestedActionsList.querySelectorAll("button").forEach((b) => { b.disabled = isBusy; });
    }
    // 文档锁定：AI 工作期间禁止用户编辑文档
    if (!skipDocumentLock) {
      if (isBusy) lockHostDocument();
      else if (wasBusy) unlockHostDocument();
    }
    // 修订模式（仅 WPS 文字）：AI 工作期间打开原生修订 + 把作者临时设为「文小舟」，结束后还原
    if (!skipDocumentLock && (isBusy || wasBusy)) applyReviseTurn(isBusy);
    if (!isBusy) readOnlyChatTurn = false;
    // 一轮结束后按当前修订条数刷新「接受全部 / 全部回撤」按钮显隐（有修订才显示）
    if (!isBusy) updateReviseActions();
    // 文档型 host (wps/wpp/et) 下显示锁定 banner（内嵌进度），其他 host 用独立的 chat-progress。
    // 二选一避免两个指示器视觉重叠。
    const host = currentHostInfo?.host || "*";
    const useBanner = isBusy && !skipDocumentLock && ["wps", "wpp", "et"].includes(host);
    const useStandalone = isBusy && !useBanner;
    // 修订模式（Word）不锁文档，banner 文案相应改成"记为修订"，不再说"已锁定"
    if (els.docLockTitle) {
      // 按宿主给准确文案：Word 仍用 Protect 硬锁 → "已临时锁定"；Excel/PPT 不再硬锁（只 Interactive 软拦，
      // 避免 WPS 原生"受保护"模态框冻住整个界面 + 停止按钮），改成软提醒"请勿手动操作"。
      let lockTitle;
      if (host === "wps" && currentSettings?.reviseMode) {
        lockTitle = "AI 正在编辑（修订模式，改动记为修订）";
      } else if (host === "et") {
        lockTitle = "AI 工作中，请勿手动操作表格";
      } else if (host === "wpp") {
        lockTitle = "AI 工作中，请勿手动操作幻灯片";
      } else if (host === "wps") {
        lockTitle = "AI 工作中，文档已临时锁定";
      } else {
        lockTitle = "AI 工作中";
      }
      els.docLockTitle.textContent = lockTitle;
    }
    if (els.docLockBanner) els.docLockBanner.classList.toggle("hidden", !useBanner);
    if (els.chatProgress) {
      els.chatProgress.classList.toggle("hidden", !useStandalone);
    }
    if (!isBusy) setProgressStatus(null);
  }

  // ===== 文档锁定 / 用户操作检测 =====
  // 实际锁定逻辑在 js/doc-lock.js 的 WpsAiLock 里，这里只负责 UI 状态 +
  // 轮询给 PPT 等无法硬锁的宿主做兜底警告。

  let docLockWatcher = null;

  function lockHostDocument() {
    // 修 B10：先清掉可能残留的旧 watcher，避免 setInterval 泄漏（同一时刻只应有一个）。
    if (docLockWatcher) { clearInterval(docLockWatcher); docLockWatcher = null; }
    const host = currentHostInfo?.host || "*";
    // 修订模式下 Word 不加 Protect 硬锁：只开 TrackRevisions（AI 改动记为原生修订、由用户审阅），
    // 免得 Protect 挡住"接受/拒绝修订"；防用户误编辑仍靠 Interactive=false 软挡。见 doc-lock.js lockWord。
    const reviseMode = host === "wps" && !!currentSettings?.reviseMode;
    try { global.WpsAiLock?.lock?.(host, { reviseMode }); } catch (e) {}
    updateForceUnlockVisibility();

    // 轮询 selection（PPT 没有硬锁，需要用变化探测来弹警告；Word/Excel 也加做双保险）
    const app = global.wps?.WpsApplication?.()
      || global.wps?.EtApplication?.()
      || global.wps?.WppApplication?.()
      || global.wps?.Application
      || null;
    if (!app) return;
    let lastSig = readSelectionSig(app, host);
    let warned = false;
    docLockWatcher = setInterval(() => {
      const sig = readSelectionSig(app, host);
      if (sig && lastSig && sig !== lastSig) {
        if (!warned) {
          warned = true;
          showMessage("AI 还在操作文档，您刚才的输入可能会与 AI 冲突，建议等 AI 完成。", "error", { duration: 6000 });
        }
      }
      lastSig = sig || lastSig;
    }, 1000);
  }

  function unlockHostDocument() {
    try { global.WpsAiLock?.unlock?.(); } catch (e) {}
    if (docLockWatcher) { clearInterval(docLockWatcher); docLockWatcher = null; }
    updateForceUnlockVisibility();
  }

  function updateForceUnlockVisibility() {
    if (!els.forceUnlockBtn) return;
    const reviseMode = currentHostInfo?.host === "wps" && !!currentSettings?.reviseMode;
    let locked = false;
    try { locked = !!global.WpsAiLock?.isDocumentLocked?.(); } catch (e) { locked = false; }
    els.forceUnlockBtn.classList.toggle("hidden", !(locked && !reviseMode));
  }

  // 修订模式：AI 工作期间(isBusy)包一层——打开原生修订 + 作者设为「文小舟」；结束还原作者。
  // 只在 WPS 文字 + 开关打开时生效；endRevise 没 begin 过时是 no-op，收尾无脑调即可。
  function applyReviseTurn(isBusy) {
    if ((currentHostInfo?.host || "") !== "wps") return;
    const w = global.WpsAiHostWriter;
    if (!w) return;
    if (isBusy) {
      if (currentSettings?.reviseMode && typeof w.beginRevise === "function") {
        Promise.resolve(w.beginRevise("文小舟")).catch(() => {});
      }
    } else if (typeof w.endRevise === "function") {
      Promise.resolve(w.endRevise()).catch(() => {});
    }
  }

  async function onReviseModeToggle() {
    const on = !!els.reviseModeToggle?.checked;
    currentSettings.reviseMode = on;
    try { persistSettings(); } catch (e) {}
    updateReviseActions();
    updateForceUnlockVisibility();
    const w = global.WpsAiHostWriter;
    if (w && typeof w.manageRevisions === "function") {
      try { await w.manageRevisions(on ? "enable_track" : "disable_track"); } catch (e) {}
    }
    showMessage(
      on ? "已开启修订模式：AI 的改动会记为 Word 修订（作者「文小舟」），可逐条接受或全部回撤。" : "已关闭修订模式。",
      "info",
      { duration: 4000 }
    );
  }

  // 应用修订（接受/回撤全部）在大文档上可能耗时数秒——期间禁用按钮并显示「应用中…」转圈，避免用户
  // 以为卡死或重复点击。
  function setReviseApplying(on) {
    els.reviseModeActions?.classList.toggle("is-applying", !!on);
    if (els.reviseAcceptAllBtn) els.reviseAcceptAllBtn.disabled = !!on;
    if (els.reviseRejectAllBtn) els.reviseRejectAllBtn.disabled = !!on;
  }

  async function reviseManageAll(action) {
    if (chatBusy) { showMessage("AI 正在工作，请等本轮结束后再接受 / 回撤修订。", "info"); return; }
    const w = global.WpsAiHostWriter;
    if (!w || typeof w.manageRevisions !== "function") return;
    setReviseApplying(true);
    try {
      const r = await w.manageRevisions(action);
      const n = (r && typeof r.before === "number") ? r.before : null;
      showMessage(
        (action === "accept_all" ? "已接受全部修订" : "已全部回撤（拒绝所有修订）") + (n ? `（${n} 条）` : "") + "。",
        "success"
      );
    } catch (e) {
      showMessage((action === "accept_all" ? "接受修订失败：" : "回撤失败：") + (e?.message || e), "error");
    } finally {
      setReviseApplying(false);
      updateReviseActions();
    }
  }

  // 接受全部 / 全部回撤 按钮：只在「修订模式 + 当前有修订」时显示（没有修订就没意义）。
  // 修订可能来自任意入口——主对话、AI 排版、ribbon 快捷指令、甚至用户在修订模式下手改——
  // 这些不一定都走 setChatBusy 收尾，所以修订模式开着时用一个轻量轮询兜底刷新（Revisions.Count 只读，很便宜）。
  let reviseActionsPoll = null;
  function stopReviseActionsPoll() {
    if (reviseActionsPoll) { clearInterval(reviseActionsPoll); reviseActionsPoll = null; }
  }
  async function updateReviseActions() {
    if (!els.reviseModeActions) return;
    const show = (currentHostInfo?.host === "wps") && !!currentSettings?.reviseMode;
    if (!show) { els.reviseModeActions.classList.add("hidden"); stopReviseActionsPoll(); return; }
    if (!reviseActionsPoll) reviseActionsPoll = setInterval(() => { updateReviseActions(); }, 2500);
    let n = 0;
    try { n = (await global.WpsAiHostWriter?.revisionCount?.()) || 0; } catch (e) { n = 0; }
    els.reviseModeActions.classList.toggle("hidden", !(n > 0));
  }

  function readSelectionSig(app, host) {
    try {
      if (host === "wps") {
        const sel = app.Selection;
        if (sel) return `wps:${sel.Start || 0}:${sel.End || 0}`;
      } else if (host === "et") {
        const sel = app.Selection;
        if (sel?.Address) return `et:${sel.Address}`;
      } else if (host === "wpp") {
        const view = app.ActiveWindow?.View;
        const slideIdx = view?.Slide?.SlideIndex || 0;
        return `wpp:${slideIdx}`;
      }
    } catch (e) {}
    return null;
  }

  // AI 进度条状态文字：null 表示清空（隐藏文字但保留进度条容器结构）
  // 同步更新 chat-progress 和 doc-lock-banner 两处（两者互斥显示，但 setChatBusy 决定哪个 visible）
  function setProgressStatus(text) {
    const t = text || "";
    if (els.chatProgressText) els.chatProgressText.textContent = t;
    if (els.docLockStatusText) els.docLockStatusText.textContent = t || "AI 正在思考…";
  }

  // 结构化状态：状态图标 + 语义词 + 副信息计数，替代之前"AI 正在生成: xxxxxxx"截断尾巴那种。
  // state 可选：thinking / reasoning / generating / tool / retrying / done。
  // detail 是简短副信息，比如"1.2k 字符" / "翻译选中" / "第 3/5 次"，可省。
  const STATE_MAP = {
    thinking:   { icon: "◆", word: "思考中" },
    reasoning:  { icon: "◇", word: "推理" },
    generating: { icon: "✎", word: "生成回复" },
    tool:       { icon: "⚙", word: "执行工具" },
    retrying:   { icon: "↻", word: "重试" },
    done:       { icon: "✓", word: "完成" }
  };
  function setProgressState(state, detail) {
    const s = STATE_MAP[state] || STATE_MAP.thinking;
    const parts = [`${s.icon} ${s.word}`];
    if (detail) parts.push(String(detail));
    setProgressStatus(parts.join(" · "));
  }

  // 进度条切到"确定百分比"模式：percent 0~100 → 进度条按 % 静态填充
  // percent = null 切回 indeterminate（默认来回滑动）
  function setProgressFill(percent) {
    // 同步 chat-progress 和 doc-lock-banner 的进度条（两者互斥显示）
    const setBar = (container, innerSel) => {
      if (!container) return;
      const inner = container.querySelector(innerSel);
      if (!inner) return;
      if (percent == null) {
        container.classList.remove("is-determinate");
        inner.style.width = "";
        inner.style.left = "";
        inner.style.transform = "";
        return;
      }
      const pct = Math.max(0, Math.min(100, +percent || 0));
      container.classList.add("is-determinate");
      inner.style.left = "0";
      inner.style.transform = "none";
      inner.style.width = `${pct}%`;
    };
    setBar(els.chatProgress, ".chat-progress-bar-inner");
    setBar(els.docLockBanner, ".doc-lock-bar-inner");
  }

  // 暴露给其他模块（如 tools/image.js）的 UI 接口
  global.WpsAiUI = {
    setProgressStatus,
    setProgressFill
  };

  // ===== 生图独立进度面板 =====
  // 不走 chat-progress / doc-lock-banner（那两个是单行 ellipsis，多行提示词显示不全），
  // 用专门的小面板：3 行 -webkit-line-clamp 显示提示词，状态/进度横向排列。
  let imageGenAutoHideTimer = null;
  let imageGenCurrentPrompt = "";

  function setImageGenBar(percent) {
    const panel = els.imageGenPanel;
    if (!panel) return;
    const inner = panel.querySelector(".image-gen-bar-inner");
    if (!inner) return;
    if (percent == null) {
      panel.classList.remove("is-determinate");
      inner.style.width = "";
      return;
    }
    const pct = Math.max(0, Math.min(100, +percent || 0));
    panel.classList.add("is-determinate");
    inner.style.width = `${pct}%`;
  }

  function setImageGenPanelTone(tone) {
    const panel = els.imageGenPanel;
    if (!panel) return;
    panel.classList.remove("is-failed", "is-done");
    if (tone === "failed") panel.classList.add("is-failed");
    else if (tone === "done") panel.classList.add("is-done");
  }

  function showImageGenPanel() {
    if (!els.imageGenPanel) return;
    if (imageGenAutoHideTimer) { clearTimeout(imageGenAutoHideTimer); imageGenAutoHideTimer = null; }
    els.imageGenPanel.classList.remove("hidden");
    setImageGenPanelTone(null);
    if (els.imageGenCloseBtn) els.imageGenCloseBtn.classList.add("hidden");
    // 「生图」tab 亮角标提示有任务 + 隐藏空态
    try { document.getElementById("imageTaskBadge")?.classList.remove("hidden"); document.getElementById("imageTaskEmpty")?.classList.add("hidden"); } catch (e) {}
  }

  function clearImageGenFailHint() {
    const panel = els.imageGenPanel;
    if (!panel) return;
    const hintEl = panel.querySelector(".image-gen-fail-hint");
    if (hintEl) hintEl.remove();
  }

  function hideImageGenPanel() {
    if (!els.imageGenPanel) return;
    els.imageGenPanel.classList.add("hidden");
    // 清「生图」tab 角标 + 恢复空态
    try { document.getElementById("imageTaskBadge")?.classList.add("hidden"); document.getElementById("imageTaskEmpty")?.classList.remove("hidden"); } catch (e) {}
    setImageGenBar(null);
    setImageGenPanelTone(null);
    if (els.imageGenStatus) els.imageGenStatus.textContent = "";
    if (els.imageGenPrompt) {
      els.imageGenPrompt.textContent = "";
      els.imageGenPrompt.removeAttribute("title");
    }
    clearImageGenFailHint();
    imageGenCurrentPrompt = "";
  }

  function imageGenStart({ prompt } = {}) {
    showImageGenPanel();
    clearImageGenFailHint();
    imageGenCurrentPrompt = String(prompt || "").trim();
    if (els.imageGenPrompt) {
      els.imageGenPrompt.textContent = imageGenCurrentPrompt || "（未填写提示词）";
      if (imageGenCurrentPrompt) els.imageGenPrompt.title = imageGenCurrentPrompt;
    }
    if (els.imageGenStatus) els.imageGenStatus.textContent = "排队中 · 0s";
    setImageGenBar(null);
  }

  function imageGenUpdate({ status, progress, elapsedMs } = {}) {
    if (!els.imageGenPanel || els.imageGenPanel.classList.contains("hidden")) return;
    const labelMap = {
      queued: "排队中", pending: "排队中",
      in_progress: "生成中", processing: "生成中", running: "生成中",
      completed: "已完成", succeeded: "已完成",
      failed: "失败"
    };
    const label = labelMap[status] || status || "生成中";
    const pct = typeof progress === "number" ? ` · ${progress}%` : "";
    const elapsed = Math.round((elapsedMs || 0) / 1000);
    if (els.imageGenStatus) els.imageGenStatus.textContent = `${label}${pct} · 已用 ${elapsed}s`;
    if (typeof progress === "number") setImageGenBar(progress);
  }

  function imageGenDone() {
    if (!els.imageGenPanel) return;
    setImageGenPanelTone("done");
    setImageGenBar(100);
    if (els.imageGenStatus) els.imageGenStatus.textContent = "已完成";
    if (els.imageGenCloseBtn) els.imageGenCloseBtn.classList.add("hidden");
    if (imageGenAutoHideTimer) clearTimeout(imageGenAutoHideTimer);
    imageGenAutoHideTimer = setTimeout(() => { hideImageGenPanel(); imageGenAutoHideTimer = null; }, 1500);
  }

  // 生图错误归因：委托给 image-error-classifier.js（已抽出成独立文件，纯逻辑无 DOM 依赖）
  function classifyImageError(raw) {
    const mod = global.WpsAiImageErrorClassifier;
    if (mod?.classify) return mod.classify(raw);
    return { label: "生成失败", tone: "unknown", hint: "" };
  }

  function imageGenFail(message) {
    if (!els.imageGenPanel) return;
    setImageGenPanelTone("failed");
    setImageGenBar(null);
    const raw = String(message || "").trim();
    const cls = classifyImageError(raw);
    if (els.imageGenStatus) {
      // status 行只放分类 label + tone 徽章，具体消息放到面板下方 hint 里
      els.imageGenStatus.innerHTML = `<span class="image-gen-fail-badge image-gen-fail-${cls.tone}">${cls.label}</span>`;
    }
    // 附加一行 hint（有的话）+ 折叠的原始消息，方便用户 / 排障
    const panel = els.imageGenPanel;
    let hintEl = panel.querySelector(".image-gen-fail-hint");
    if (!hintEl) {
      hintEl = document.createElement("div");
      hintEl.className = "image-gen-fail-hint";
      panel.appendChild(hintEl);
    }
    const detailsHtml = raw ? `<details class="image-gen-fail-details"><summary>原始报错</summary><pre>${escapeHtmlSafe(raw)}</pre></details>` : "";
    hintEl.innerHTML = `${cls.hint ? `<span class="image-gen-fail-hint-text">${cls.hint}</span>` : ""}${detailsHtml}`;
    hintEl.style.display = (cls.hint || raw) ? "" : "none";
    if (els.imageGenCloseBtn) els.imageGenCloseBtn.classList.remove("hidden");
  }

  function bindImageGenPanel() {
    els.imageGenCloseBtn?.addEventListener("click", () => hideImageGenPanel());
  }

  global.WpsAiImageUI = {
    start: imageGenStart,
    update: imageGenUpdate,
    done: imageGenDone,
    fail: imageGenFail,
    hide: hideImageGenPanel
  };

  // 把工具名映射成中文，复用 history 模块里的字典
  function friendlyToolName(name) {
    return global.WpsAiHistory?.getFriendlyName?.(name) || name;
  }

  // ---------------- Tabs ----------------

  function activateTab(name) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll("[data-tab-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.tabPanel !== name));
    // 切到改动记录 Tab 时重新读一次当前文档路径，刷新过滤
    if (name === "history" && typeof renderHistory === "function") {
      try { renderHistory(); } catch (e) {}
    }
  }

  function bindTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
  }

  // ---------------- Settings ----------------

  function loadSettings() {
    currentSettings = global.WpsAiProviderRegistry.loadSettings();
    return currentSettings;
  }

  function persistSettings() {
    global.WpsAiProviderRegistry.saveSettings(currentSettings);
  }

  function applySettingsToForm() {
    const s = currentSettings;
    els.providerSelect.value = s.activeProvider;
    els.operationModeSelect.value = s.operationMode;
    applyEnabledHostsToForm();
    els.maxToolIterationsInput.value = s.maxToolIterations || 150;
    if (els.systemPromptInput) els.systemPromptInput.value = (s.systemPrompt != null) ? s.systemPrompt : "";
    if (els.imageSizeOverrideInput) els.imageSizeOverrideInput.value = (s.imageSizeOverride != null) ? s.imageSizeOverride : "";
    if (els.showToolCallLogsInput) els.showToolCallLogsInput.checked = !!s.showToolCallLogs;
    if (els.aiFollowHighlightInput) els.aiFollowHighlightInput.checked = s.aiFollowHighlight !== false;
    // splitLayersOnInsert 默认开启（实验阶段过去后改成默认 true，让插入的 PPT 能分层选中）。
    // 之前 loadSettings 漏 merge 这条，用户的勾选保存了也读不回来 —— 已在 registry.js 修。
    if (els.splitLayersOnInsertInput) els.splitLayersOnInsertInput.checked = s.splitLayersOnInsert !== false;
    if (els.mcpServerEnabledInput) els.mcpServerEnabledInput.checked = !!s.mcpServerEnabled;
    if (els.updateAutoCheckInput) els.updateAutoCheckInput.checked = !!s.updateAutoCheck;

    const oa = s.providers.openai;
    els.openaiBaseUrl.value = oa.baseUrl || "";
    els.openaiApiKey.value = oa.apiKey || "";
    els.openaiDefaultModel.value = oa.defaultModel || "";
    els.openaiUseProxy.checked = oa.useProxy !== false;

    const an = s.providers.anthropic;
    els.anthropicBaseUrl.value = an.baseUrl || "";
    els.anthropicApiKey.value = an.apiKey || "";
    els.anthropicDefaultModel.value = an.defaultModel || "";
    els.anthropicVersion.value = an.anthropicVersion || "2023-06-01";
    els.anthropicUseProxy.checked = an.useProxy !== false;

    // 图像渠道：用动态卡片列表渲染（每条 entry 一张卡，类似 chatProviders）
    renderImageProvidersList();

    refreshProviderConfigVisibility();
  }

  const HOST_LABELS = { wps: "Word", et: "Excel", wpp: "PPT", pdf: "PDF" };
  const HOST_CHECKBOX = { wps: "enableHostWps", et: "enableHostEt", wpp: "enableHostWpp", pdf: "enableHostPdf" };
  function hostLabel(h) { return HOST_LABELS[h] || h; }

  function applyEnabledHostsToForm() {
    const list = (Array.isArray(currentSettings?.enabledHosts) && currentSettings.enabledHosts.length)
      ? currentSettings.enabledHosts : ["wps", "et", "wpp", "pdf"];
    Object.keys(HOST_CHECKBOX).forEach((h) => {
      const el = els[HOST_CHECKBOX[h]];
      if (el) el.checked = list.includes(h);
    });
    bindEnabledHostToggles();
  }

  function readEnabledHostsFromForm() {
    const hosts = [];
    Object.keys(HOST_CHECKBOX).forEach((h) => { if (els[HOST_CHECKBOX[h]]?.checked) hosts.push(h); });
    return hosts;
  }

  // 勾选/取消某个组件 → 持久化 + 通知 proxy 重写 publish.xml + 提示重启 WPS。
  async function applyEnabledHosts() {
    const hosts = readEnabledHostsFromForm();
    if (!hosts.length) {
      showMessage("至少要保留一个组件——全部关掉后就没有入口能再打开插件了。", "error");
      applyEnabledHostsToForm(); // 恢复上一次勾选
      return;
    }
    currentSettings.enabledHosts = hosts;
    persistSettings();
    try {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const origin = (window.location && window.location.origin) || "";
      const staticBase = /^https?:/i.test(origin) ? origin : "";
      const resp = await fetch(base + "/publish/set-hosts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledHosts: hosts, staticBase })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
      showMessage(`已更新启用组件：${hosts.map(hostLabel).join("、")}。重启 WPS 后生效。`, "success", { duration: 6000 });
    } catch (e) {
      showMessage("更新失败：" + (e?.message || e) + "（后台服务可能未运行）。设置已保存，下次服务起来时会应用。", "error", { autoHide: false });
    }
  }

  function bindEnabledHostToggles() {
    Object.keys(HOST_CHECKBOX).forEach((h) => {
      const el = els[HOST_CHECKBOX[h]];
      if (el && el.dataset.bound !== "1") {
        el.dataset.bound = "1";
        el.addEventListener("change", () => { applyEnabledHosts(); });
      }
    });
  }

  // 主面板启动时：若用户选的是宿主子集（<4），best-effort 重新同步一次 publish.xml。
  // 自愈两种情况：① 上次保存时 proxy 没起来；② 重装后 installer 又写回全 4 个（设置存在
  // SQLite 里，重装不清，所以偏好还在）。全开 / 未设则不动，避免每次启动都写盘。
  function syncEnabledHostsOnBoot() {
    try {
      const hosts = Array.isArray(currentSettings?.enabledHosts) ? currentSettings.enabledHosts : [];
      if (!hosts.length || hosts.length >= 4) return;
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const origin = (window.location && window.location.origin) || "";
      const staticBase = /^https?:/i.test(origin) ? origin : "";
      fetch(base + "/publish/set-hosts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledHosts: hosts, staticBase })
      }).catch(() => {});
    } catch (e) {}
  }

  function readSettingsFromForm() {
    currentSettings.activeProvider = els.providerSelect.value;
    currentSettings.operationMode = els.operationModeSelect.value;
    const eh = readEnabledHostsFromForm();
    if (eh.length) currentSettings.enabledHosts = eh;
    const maxIter = parseInt(els.maxToolIterationsInput.value, 10);
    currentSettings.maxToolIterations = (Number.isFinite(maxIter) && maxIter > 0) ? maxIter : 50;
    if (els.systemPromptInput) currentSettings.systemPrompt = els.systemPromptInput.value;
    if (els.imageSizeOverrideInput) currentSettings.imageSizeOverride = els.imageSizeOverrideInput.value;
    if (els.showToolCallLogsInput) currentSettings.showToolCallLogs = !!els.showToolCallLogsInput.checked;
    if (els.aiFollowHighlightInput) currentSettings.aiFollowHighlight = !!els.aiFollowHighlightInput.checked;
    if (els.splitLayersOnInsertInput) currentSettings.splitLayersOnInsert = !!els.splitLayersOnInsertInput.checked;
    if (els.mcpServerEnabledInput) currentSettings.mcpServerEnabled = !!els.mcpServerEnabledInput.checked;
    if (els.updateAutoCheckInput) currentSettings.updateAutoCheck = !!els.updateAutoCheckInput.checked;
    Object.assign(currentSettings.providers.openai, {
      baseUrl: els.openaiBaseUrl.value.trim(),
      apiKey: els.openaiApiKey.value.trim(),
      defaultModel: els.openaiDefaultModel.value.trim() || "gpt-4o-mini",
      useProxy: els.openaiUseProxy.checked
    });
    Object.assign(currentSettings.providers.anthropic, {
      baseUrl: els.anthropicBaseUrl.value.trim(),
      apiKey: els.anthropicApiKey.value.trim(),
      defaultModel: els.anthropicDefaultModel.value.trim() || "claude-sonnet-4-6",
      anthropicVersion: els.anthropicVersion.value.trim() || "2023-06-01",
      useProxy: els.anthropicUseProxy.checked
    });
    // 图像渠道：值是即时写回到 currentSettings.imageProviders 的（onchange 触发），
    // 这里只兜底保留对象引用即可，不再重新组装。
    if (!Array.isArray(currentSettings.imageProviders)) {
      currentSettings.imageProviders = [];
    }
  }

  function refreshProviderConfigVisibility() {
    const active = els.providerSelect.value;
    document.querySelectorAll(".provider-config").forEach((node) => {
      node.classList.toggle("hidden", node.dataset.provider !== active);
    });
    refreshCodexAuthArea();
  }

  function refreshCodexAuthArea() {
    if (!els.codexAuthArea || !els.codexSignedInArea) return;
    const tokenInfo = global.WpsAiAuth.getTokenInfo();
    els.codexAuthArea.classList.toggle("hidden", tokenInfo.authenticated);
    els.codexSignedInArea.classList.toggle("hidden", !tokenInfo.authenticated);
    if (els.tokenInfo) {
      els.tokenInfo.textContent = tokenInfo.expiresAtText
        ? `Token 有效期至：${tokenInfo.expiresAtText}`
        : "已登录";
    }
  }

  // ========== Codex 卡片内嵌 OAuth 登录流（4 步） ==========
  // 1. 生成授权链接（startLogin → PKCE + 跳浏览器 / 复制兜底）
  // 2. URL 显示在 readonly textarea，旁边带"复制"按钮（WebView 自带浏览器拦截时方便手动复制）
  // 3. 用户在浏览器登录后，回调 URL（带 code=）会被显示 → 复制回插件
  // 4. 粘贴到第二个 textarea → 点"完成授权"（exchangeCode）
  //
  // 已登录态：显示 token 有效期 + 退出按钮
  function renderCodexCardBody(body, p, models, hint) {
    const modelField = `<label class="field"><span>默认模型</span>
      <div class="field-with-picker"><input type="text" data-field="defaultModel" value="${escapeAttr(p.defaultModel || "")}"/>${buildModelPickerHtml(models, p.defaultModel)}</div>${hint || ""}</label>`;
    const Auth = global.WpsAiAuth;
    const tokenInfo = Auth?.getTokenInfo?.() || { authenticated: false };
    if (tokenInfo.authenticated) {
      body.innerHTML = `
        ${modelField}
        <div class="codex-card-signedin">
          <div class="codex-status-row">
            <span class="codex-status-ok">已登录</span>
            <span class="muted" style="font-size:11px">${escapeHtml(tokenInfo.expiresAtText ? "Token 至 " + tokenInfo.expiresAtText : "")}</span>
          </div>
          <button type="button" class="ghost-btn compact-btn" data-codex-act="signout">退出登录</button>
        </div>
      `;
      body.querySelector('[data-codex-act="signout"]')?.addEventListener("click", () => {
        if (!confirm(i18nT("确定退出 Codex 登录？"))) return;
        try {
          Auth.clearAuth();
          showMessage("已退出 Codex 登录。", "info");
        } catch (e) { showMessage(`退出失败：${e?.message || e}`, "error"); }
        renderChatProvidersList();
      });
      return;
    }
    body.innerHTML = `
      ${modelField}
      <div class="codex-login-steps">
        <div class="codex-step">
          <div class="codex-step-head"><span class="codex-step-no">1</span><span>生成授权链接</span></div>
          <button type="button" class="primary-btn compact-btn" data-codex-act="gen-url">生成授权链接</button>
        </div>
        <div class="codex-step" data-codex-step="url-display" hidden>
          <div class="codex-step-head"><span class="codex-step-no">2</span><span>在浏览器打开（已自动尝试 / 失败时手动复制）</span></div>
          <textarea data-codex-act="url-text" rows="2" readonly placeholder="点上一步会出现授权链接"></textarea>
          <div class="codex-step-actions">
            <button type="button" class="ghost-btn compact-btn" data-codex-act="copy-url">复制链接</button>
            <button type="button" class="ghost-btn compact-btn" data-codex-act="open-url">尝试打开浏览器</button>
          </div>
        </div>
        <div class="codex-step" data-codex-step="code-input" hidden>
          <div class="codex-step-head"><span class="codex-step-no">3</span><span>粘贴浏览器回调的 URL（带 code= 参数）或纯 code</span></div>
          <textarea data-codex-act="code-text" rows="3" placeholder="https://.../callback?code=...&state=...  或  authorization code"></textarea>
        </div>
        <div class="codex-step" data-codex-step="confirm" hidden>
          <div class="codex-step-head"><span class="codex-step-no">4</span><span>完成授权</span></div>
          <button type="button" class="primary-btn compact-btn" data-codex-act="exchange">完成授权登录</button>
        </div>
      </div>
    `;
    const stepUrl = body.querySelector('[data-codex-step="url-display"]');
    const stepCode = body.querySelector('[data-codex-step="code-input"]');
    const stepConfirm = body.querySelector('[data-codex-step="confirm"]');
    const urlTa = body.querySelector('[data-codex-act="url-text"]');
    const codeTa = body.querySelector('[data-codex-act="code-text"]');

    body.querySelector('[data-codex-act="gen-url"]')?.addEventListener("click", async () => {
      try {
        const url = await Auth.startLogin();
        if (urlTa) urlTa.value = url;
        if (stepUrl) stepUrl.hidden = false;
        if (stepCode) stepCode.hidden = false;
        if (stepConfirm) stepConfirm.hidden = false;
        showMessage("已生成授权链接。如果浏览器没自动弹出，请复制链接手动打开。", "info");
      } catch (e) {
        showMessage(`生成链接失败：${e?.message || e}`, "error");
      }
    });
    body.querySelector('[data-codex-act="copy-url"]')?.addEventListener("click", async () => {
      const txt = urlTa?.value || "";
      if (!txt) { showMessage("还没生成授权链接", "error"); return; }
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(txt); }
        else {
          urlTa.removeAttribute("readonly");
          urlTa.select(); document.execCommand("copy"); urlTa.setAttribute("readonly", "readonly");
        }
        showMessage("授权链接已复制到剪贴板", "success");
      } catch (e) { showMessage(`复制失败：${e?.message || e}`, "error"); }
    });
    body.querySelector('[data-codex-act="open-url"]')?.addEventListener("click", async () => {
      const txt = urlTa?.value || "";
      if (!txt) return;
      try {
        if (global.wps?.OAAssist?.ShellExecute) global.wps.OAAssist.ShellExecute(txt);
        else window.open(txt, "_blank");
      } catch (e) { showMessage(`打开失败：${e?.message || e}，请手动复制链接到浏览器。`, "error"); }
    });
    body.querySelector('[data-codex-act="exchange"]')?.addEventListener("click", async () => {
      const txt = (codeTa?.value || "").trim();
      if (!txt) { showMessage("请先粘贴回调 URL 或 code", "error"); return; }
      try {
        await Auth.exchangeCode(txt);
        showMessage("登录成功 ✓", "success");
        renderChatProvidersList();
        try { populateModelSelector(els.modelSelect?.value); } catch (e) {}
        try { renderProviderState(); } catch (e) {}
      } catch (e) {
        showMessage(`换 token 失败：${e?.message || e}`, "error");
      }
    });
  }

  // ---------------- Header status ----------------

  function isProviderReady(info) {
    if (!info) return false;
    if (info.type === "codex") return global.WpsAiAuth.isAuthenticated();
    // 新版从 chatProviders 找当前激活的 entry；老路径回退 providers
    const entry = (currentSettings.chatProviders || []).find((p) => p.id === info.id);
    const cfg = entry || (currentSettings.providers || {})[info.type];
    return Boolean(cfg && cfg.apiKey && cfg.baseUrl);
  }

  function renderProviderState() {
    const info = global.WpsAiOpenAI.getActiveProviderInfo();
    if (!info) {
      els.authBadge.textContent = "未配置";
      els.authBadge.className = "badge badge-muted";
      els.authBadge.title = "请在设置中配置服务";
      return;
    }

    const ready = isProviderReady(info);
    els.authBadge.textContent = ready ? (info.type === "codex" ? "已登录" : "就绪") : "未配置";
    els.authBadge.className = ready ? "badge badge-success" : "badge badge-muted";
    els.authBadge.title = `${info.label}${ready ? "（已就绪）" : "（未配置）"}`;
  }

  // ---------------- Models ----------------

  // ---- 模型缓存（按 provider id 分桶，让 header 下拉能横向列出多家） ----
  // 每个 provider 上次成功 listModels 的结果存这里；refresh 按钮只刷"当前选中" provider
  const MODELS_CACHE_KEY = "lingxi_models_cache_v1";
  let modelsByProvider = {};
  try {
    const raw = global.WpsAiStore.getItem(MODELS_CACHE_KEY);
    if (raw) modelsByProvider = JSON.parse(raw) || {};
  } catch (e) { modelsByProvider = {}; }
  function persistModelsCache() {
    try { global.WpsAiStore.setItem(MODELS_CACHE_KEY, JSON.stringify(modelsByProvider)); } catch (e) {}
  }

  // 生图渠道也单独存一份模型列表缓存，让配置卡的"模型"输入框可以下拉选已知模型。
  const IMAGE_MODELS_CACHE_KEY = "lingxi_image_models_cache_v1";
  let imageModelsByProvider = {};
  try {
    const raw = global.WpsAiStore.getItem(IMAGE_MODELS_CACHE_KEY);
    if (raw) imageModelsByProvider = JSON.parse(raw) || {};
  } catch (e) { imageModelsByProvider = {}; }
  function persistImageModelsCache() {
    try { global.WpsAiStore.setItem(IMAGE_MODELS_CACHE_KEY, JSON.stringify(imageModelsByProvider)); } catch (e) {}
  }

  // 拼一段"从已拉取的模型选..."下拉 HTML。
  // 用 <select> + 第一项是占位（value=""），选中真实模型时 JS 把值复制回旁边那个 input。
  // 之所以不用 <datalist>：WPS CEF 老版本下 datalist 点击不弹下拉，相当于没启用。
  function buildModelPickerHtml(modelList, currentValue) {
    const list = (modelList || []).filter(Boolean);
    if (!list.length) return "";
    const options = list.map((m) => {
      const sel = m === currentValue ? " selected" : "";
      return `<option value="${escapeAttr(m)}"${sel}>${escapeHtml(m)}</option>`;
    }).join("");
    return `<select data-role="model-picker" class="model-picker"><option value="">从已拉取的 ${list.length} 个模型中选…</option>${options}</select>`;
  }

  // 收集所有 enabled chatProviders 的可见模型项：
  //   每个 provider 至少一条（defaultModel），加上 modelsByProvider[providerId] 缓存
  // 返回 [{ providerId, providerLabel, providerType, modelId }, ...]
  function collectMultiProviderItems() {
    const items = [];
    (currentSettings.chatProviders || []).forEach((p) => {
      if (!p.enabled) return;
      const seen = new Set();
      const push = (m) => {
        if (!m || seen.has(m)) return;
        seen.add(m);
        items.push({ providerId: p.id, providerLabel: p.label || p.id, providerType: p.type, modelId: m });
      };
      const cached = modelsByProvider[p.id] || [];
      cached.forEach(push);
      if (p.defaultModel) push(p.defaultModel);
    });
    return items;
  }

  // 把 activeChatModel 解码到 { providerId, modelId }
  function getActiveChatModel() {
    const r = global.WpsAiProviderRegistry?.parseActiveChatModel?.(currentSettings.activeChatModel || "");
    return r || { providerId: "", modelId: "" };
  }
  function setActiveChatModel(providerId, modelId) {
    currentSettings.activeChatModel = global.WpsAiProviderRegistry.encodeActiveChatModel(providerId, modelId);
    persistSettings();
  }

  // 老接口：单 provider 给 [modelId,...]。内部转成 multi items 调 populateModelSelector
  // 兼容老的 refreshModels 调用路径
  function clearUnavailableCodexDefault(entry, models) {
    if (entry?.type !== "codex" || !entry.defaultModel || models.includes(entry.defaultModel)) return false;
    entry.defaultModel = "";
    persistSettings();
    return true;
  }

  function setModelOptions(models, selected) {
    const list = (models || []).filter(Boolean);
    const activeEntry = global.WpsAiProviderRegistry?.getActiveChatProvider?.(currentSettings) || null;
    if (activeEntry) {
      clearUnavailableCodexDefault(activeEntry, list);
      modelsByProvider[activeEntry.id] = list;
      persistModelsCache();
    }
    populateModelSelector(selected);
  }

  // 重新渲染 header 下拉：hidden select 只放当前选中模型一条（兼容 .value 读取的老代码）；
  // 真正可见的 popup 列出全部 enabled providers × 各自的 modelId
  function populateModelSelector(preferredModelId) {
    if (!els.modelSelect) return;
    const items = collectMultiProviderItems();
    const { providerId: curPid, modelId: curMid } = getActiveChatModel();

    // 选中目标：优先用 preferredModelId（refresh 后保留用户选择），否则 activeChatModel，否则第一条
    let pickedItem = null;
    if (preferredModelId) {
      pickedItem = items.find((it) => it.providerId === curPid && it.modelId === preferredModelId);
      if (!pickedItem) pickedItem = items.find((it) => it.modelId === preferredModelId);
    }
    if (!pickedItem && curPid && curMid) {
      pickedItem = items.find((it) => it.providerId === curPid && it.modelId === curMid);
    }
    if (!pickedItem) pickedItem = items[0] || null;

    // 把"模型"id 同步进隐藏 <select>.value（很多老代码读 .value）
    els.modelSelect.innerHTML = "";
    if (!pickedItem) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "（请在设置里启用至少一个供应商）";
      opt.disabled = true;
      els.modelSelect.appendChild(opt);
      els.modelSelect.value = "";
      renderMultiModelPopup(items, null);
      updateCapabilityBadges();
      return;
    }
    items.forEach((it) => {
      const opt = document.createElement("option");
      opt.value = it.modelId;
      opt.dataset.providerId = it.providerId;
      opt.textContent = it.modelId;
      els.modelSelect.appendChild(opt);
    });
    els.modelSelect.value = pickedItem.modelId;
    setActiveChatModel(pickedItem.providerId, pickedItem.modelId);
    renderMultiModelPopup(items, pickedItem);
    updateCapabilityBadges();
  }

  // 渲染下拉浮层：分组按 provider；每行 "[Provider] modelId" + 能力图标
  function renderMultiModelPopup(items, selected) {
    if (!els.modelSelectPopup || !els.modelSelectLabel || !els.modelSelectCaps) return;
    els.modelSelectPopup.innerHTML = "";

    if (items.length === 0) {
      els.modelSelectLabel.textContent = "（请在设置里启用至少一个供应商）";
      els.modelSelectCaps.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "model-select-popup-item disabled";
      empty.innerHTML = `<span class="model-select-popup-item-label">没有可用模型</span>`;
      els.modelSelectPopup.appendChild(empty);
      return;
    }

    // header 按钮上的 label = "<provider> · <model>"，能力 chip 取当前选中模型
    if (selected) {
      els.modelSelectLabel.textContent = `${selected.providerLabel} · ${selected.modelId}`;
      els.modelSelectCaps.innerHTML = capChipsHtmlForButton(selected.modelId, selected.providerId);
    } else {
      els.modelSelectLabel.textContent = "（请选择模型）";
      els.modelSelectCaps.innerHTML = "";
    }

    // 按 provider 分组渲染：用一个分组 header + 各 model 行
    const byProvider = new Map();
    items.forEach((it) => {
      if (!byProvider.has(it.providerId)) byProvider.set(it.providerId, { label: it.providerLabel, models: [] });
      byProvider.get(it.providerId).models.push(it);
    });

    // mac WPS 的 WKWebView 对非交互元素（div）的 click 合成不可靠：弹层能开
    //（header 按钮是原生 <button>）但 div 行点了没反应，Win 的 CEF 正常。
    // 三重修：① 行改真 <button>（原生可点性）② pointerup 主路 + click 兜底
    //（双触发 400ms 去重）③ stopPropagation 防外部关闭监听抢跑。
    const bindActivate = (el, fn) => {
      let handledAt = 0;
      const wrap = (ev) => {
        const now = Date.now();
        if (now - handledAt < 400) return; // pointerup 与合成 click 双触发去重
        handledAt = now;
        ev.stopPropagation();
        fn(ev);
      };
      el.addEventListener("pointerup", wrap);
      el.addEventListener("click", wrap);
    };

    const collapsed = getCollapsedProviders();
    byProvider.forEach((group, providerId) => {
      const isCollapsed = collapsed.has(providerId);
      const head = document.createElement("button");
      head.type = "button";
      head.className = "model-select-popup-item model-group-head";
      head.dataset.providerId = providerId;
      // 修 B17：group.label / modelId 来自 provider 的 /models 响应（可能是不可信中转），转义防注入。
      head.innerHTML = `<span class="model-select-popup-item-label"><span class="model-group-arrow">${isCollapsed ? "▸" : "▾"}</span> ${escapeHtml(group.label)}</span><span class="model-group-count">${group.models.length}</span>`;
      const body = document.createElement("div");
      body.className = "model-group-body" + (isCollapsed ? " hidden" : "");
      body.dataset.providerId = providerId;
      bindActivate(head, () => {
        const nowCollapsed = !body.classList.contains("hidden");
        body.classList.toggle("hidden", nowCollapsed);
        const arrow = head.querySelector(".model-group-arrow");
        if (arrow) arrow.textContent = nowCollapsed ? "▸" : "▾";
        setProviderCollapsed(providerId, nowCollapsed);
      });
      els.modelSelectPopup.appendChild(head);

      group.models.forEach((it) => {
        const item = document.createElement("button");
        item.type = "button";
        const isSel = selected && selected.providerId === providerId && selected.modelId === it.modelId;
        item.className = "model-select-popup-item" + (isSel ? " selected" : "");
        item.setAttribute("role", "option");
        item.dataset.providerId = providerId;
        item.dataset.modelId = it.modelId;
        item.innerHTML = `
          <span class="model-select-popup-item-label" style="padding-left:14px;">${escapeHtml(it.modelId)}</span>
          <span class="model-select-popup-item-caps">${capChipsHtmlForItem(it.modelId, it.providerId)}</span>
        `;
        bindActivate(item, () => {
          setActiveChatModel(providerId, it.modelId);
          if (els.modelSelect) {
            els.modelSelect.value = it.modelId;
            els.modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
          }
          closeModelPopup();
          populateModelSelector(it.modelId);
        });
        // ① 能力角标可点击手动覆盖：bindActivate 已 stopPropagation，点角标不会连带选中该模型
        item.querySelectorAll(".cap-chip").forEach((chip) => {
          bindActivate(chip, () => toggleCapChipOverride(providerId, it.modelId, chip.dataset.cap));
        });
        body.appendChild(item);
      });
      els.modelSelectPopup.appendChild(body);
    });
  }

  // 模型下拉：按供应商折叠状态（持久化）
  const MODEL_GROUP_COLLAPSE_KEY = "lingxi_model_group_collapsed_v1";
  function getCollapsedProviders() {
    try { return new Set(JSON.parse(global.WpsAiStore.getItem(MODEL_GROUP_COLLAPSE_KEY) || "[]")); } catch (e) { return new Set(); }
  }
  function setProviderCollapsed(providerId, collapsed) {
    const s = getCollapsedProviders();
    if (collapsed) s.add(providerId); else s.delete(providerId);
    try { global.WpsAiStore.setItem(MODEL_GROUP_COLLAPSE_KEY, JSON.stringify(Array.from(s))); } catch (e) {}
  }

  // SVG 图标常量：弹层每条 + header 按钮里的能力指示器
  // image=画框 / pdf=文档 / thinking=灯泡
  const CAP_ICON_SVG = {
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    pdf:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
    thinking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>',
    // 扳手图标表示工具调用 / function calling 能力
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
  };
  const CAP_LABEL = { image: "支持图像", pdf: "支持 PDF", thinking: "深度思考", tools: "支持工具调用（可读写文档）" };

  // 当前选中模型旁边的精简 chip 串（只显示"支持"的能力，不画占位）
  function capChipsHtmlForButton(modelId, providerId) {
    const cap = global.WpsAiCapabilities?.getCapabilities?.(modelId, providerId) || { image: false, pdf: false, thinking: false, tools: true };
    return ["image", "pdf", "thinking", "tools"]
      .filter((k) => cap[k])
      .map((k) => `<span title="${CAP_LABEL[k]}">${CAP_ICON_SVG[k]}</span>`)
      .join("");
  }

  // 弹层每条：模型名 + 四个图标（亮=支持/灰=不支持），用同位置占位让所有行对齐。
  // 角标可点击手动覆盖（①）：点一下在「自动 ⇄ 强制反转」间切换，手动覆盖过的带一个小圆点。
  // 覆盖持久化、跨会话保留，优先级高于 models.dev 目录和名字正则。
  function capChipsHtmlForItem(modelId, providerId) {
    const cap = global.WpsAiCapabilities?.getCapabilities?.(modelId, providerId) || { image: false, pdf: false, thinking: false, tools: true };
    return ["image", "pdf", "thinking", "tools"]
      .map((k) => {
        const on = !!cap[k];
        const forced = capOverrideValue(providerId, modelId, k) !== undefined;
        const cls = "cap-chip " + (on ? "cap-on" : "cap-off") + (forced ? " cap-forced" : "");
        const base = on ? CAP_LABEL[k] : `${CAP_LABEL[k]}（不支持）`;
        const tip = `${base}${forced ? " · 已手动设置" : ""} · 点击切换（自动/强制）`;
        return `<span class="${cls}" role="button" tabindex="0" data-cap="${k}" title="${tip}">${CAP_ICON_SVG[k]}</span>`;
      })
      .join("");
  }

  function openModelPopup() {
    if (!els.modelSelectPopup || !els.modelSelectBtn) return;
    els.modelSelectPopup.classList.remove("hidden");
    els.modelSelectBtn.setAttribute("aria-expanded", "true");
    // 滚动到当前选中项可见
    const sel = els.modelSelectPopup.querySelector(".model-select-popup-item.selected");
    if (sel) try { sel.scrollIntoView({ block: "nearest" }); } catch (e) {}
  }
  function closeModelPopup() {
    if (!els.modelSelectPopup || !els.modelSelectBtn) return;
    els.modelSelectPopup.classList.add("hidden");
    els.modelSelectBtn.setAttribute("aria-expanded", "false");
  }
  function toggleModelPopup() {
    if (els.modelSelectPopup?.classList.contains("hidden")) openModelPopup();
    else closeModelPopup();
  }

  // 刷新 header 上的能力 chip（图像/PDF/思考）以及附件 chip 警告
  // 模型支持 → 显示 chip；不支持 → 隐藏。思考 chip 同时显示当前 level
  function updateCapabilityBadges() {
    const model = els.modelSelect?.value || "";
    const providerId = getActiveChatModel().providerId || "";
    const cap = global.WpsAiCapabilities?.getCapabilities?.(model, providerId) || { image: false, pdf: false, thinking: false };
    if (els.capImage) els.capImage.classList.toggle("hidden", !cap.image);
    if (els.capPdf) els.capPdf.classList.toggle("hidden", !cap.pdf);
    if (els.capThinking) {
      els.capThinking.classList.toggle("hidden", !cap.thinking);
      const level = readThinkingLevel();
      els.capThinking.dataset.level = level;
      const lbl = document.getElementById("capThinkingLevel");
      if (lbl) lbl.textContent = THINKING_LEVEL_LABEL[level] || "中";
      els.capThinking.title = `思考强度：${THINKING_LEVEL_LABEL[level]}（点击切换）`;
    }
    // 下拉按钮的 label / 能力 chip / popup 高亮交给 renderMultiModelPopup 统一管，
    // 这里只刷头部能力 chip 颜色和聊天工具栏的附件警告
    if (els.modelSelectCaps) els.modelSelectCaps.innerHTML = model ? capChipsHtmlForButton(model, providerId) : "";
    renderAttachments();
    updateAttachActiveBtn();
  }

  // 把活动 PDF 按钮的显隐 / 启用状态根据当前 host + 文档同步
  function updateAttachActiveBtn() {
    const btn = els.chatAttachActiveBtn;
    if (!btn) return;
    let show = false;
    try {
      const docPath = global.WpsAiBackup?.getCurrentDocPath?.();
      show = !!(docPath && /\.pdf$/i.test(docPath));
    } catch (e) { show = false; }
    btn.classList.toggle("hidden", !show);
  }

  function showLoadingModels(text = "（加载模型中...）") {
    els.modelSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = text;
    opt.disabled = true;
    els.modelSelect.appendChild(opt);
  }

  /**
   * 模型列表只显示当前 provider 实际返回的模型，不再回落到硬编码 fallback。
   * 失败时下拉显示占位提示。选中策略：当前下拉值 → 设置里的默认模型 → 列表第一项。
   */
  async function refreshModels({ silent = false } = {}) {
    if (!silent) {
      setBusy(true);
      showMessage("正在获取模型列表...", "info");
    }
    const previous = els.modelSelect.value || global.WpsAiOpenAI.getDefaultModel();
    try {
      const models = await global.WpsAiOpenAI.listModels();
      setModelOptions(models, previous);
      if (!silent) showMessage(`已获取 ${models.length} 个模型。`, "success");
      return true;
    } catch (error) {
      // 刷新失败不清空，只是不补，仍然展示已 cache + defaultModel
      populateModelSelector(previous);
      if (!silent) showMessage(`获取模型失败：${error.message || error}`, "error");
      return false;
    } finally {
      if (!silent) setBusy(false);
    }
  }

  // 启动时的静默模型刷新会跟本地代理冷启动抢跑（代理没就绪 → fetch 失败 → 悄悄放弃，
  // 下拉只剩缓存/默认模型）。失败退避重试几次，代理起来后自动补全列表。
  async function refreshModelsOnBootWithRetry() {
    const delays = [0, 3000, 8000];
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      try {
        if (await refreshModels({ silent: true })) return;
      } catch (e) { /* 继续退避 */ }
    }
  }

  // ---------------- 设置弹窗 + 聊天供应商卡片 ----------------

  // 浮动模式下 8 个 resize handle 共用同一套 mouse drag 逻辑：
  //   按 screenX/screenY 的 delta 直接调 pane.Width/Height（必要时也调 Left/Top，
  //   从北/西方向拉时窗口左上角会移动）
  function bindFloatingResizeHandles() {
    const handles = document.querySelectorAll(".resize-handle");
    if (handles.length === 0) return;
    handles.forEach((h) => {
      h.addEventListener("mousedown", (ev) => startResize(ev, h.dataset.edge || "se"));
    });
  }

  function startResize(ev, edge) {
    if (!document.body.classList.contains("is-floating")) return;
    const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
    if (!pane) return;
    let initialW = 0, initialH = 0, initialLeft = 0, initialTop = 0;
    try { initialW = Number(pane.Width) || 0; } catch (e) {}
    try { initialH = Number(pane.Height) || 0; } catch (e) {}
    try { initialLeft = Number(pane.Left) || 0; } catch (e) {}
    try { initialTop = Number(pane.Top) || 0; } catch (e) {}
    const startX = ev.screenX;
    const startY = ev.screenY;
    ev.preventDefault();
    ev.stopPropagation();

    function onMove(e) {
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      let newW = initialW, newH = initialH, newL = initialLeft, newT = initialTop;
      if (edge.includes("e")) newW = Math.max(280, initialW + dx);
      if (edge.includes("w")) { newW = Math.max(280, initialW - dx); newL = initialLeft + (initialW - newW); }
      if (edge.includes("s")) newH = Math.max(240, initialH + dy);
      if (edge.includes("n")) { newH = Math.max(240, initialH - dy); newT = initialTop + (initialH - newH); }
      try { if ("Width" in pane && newW !== initialW) pane.Width = Math.round(newW); } catch (er) {}
      try { if ("Height" in pane && newH !== initialH) pane.Height = Math.round(newH); } catch (er) {}
      try { if ("Left" in pane && newL !== initialLeft) pane.Left = Math.round(newL); } catch (er) {}
      try { if ("Top" in pane && newT !== initialTop) pane.Top = Math.round(newT); } catch (er) {}
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  // 是否偏好浮窗主面板（与 wps-addon-adapter.preferDialogPaneForHost 一致）：确认 mac/linux 才 true。
  // 这两端主面板已是独立 ShowDialog 浮窗，「脱离/停靠」按钮无意义，隐藏它；Windows（或识别不出）保留。
  function preferFloatingPanel() {
    try {
      const qs = new URLSearchParams(global.location?.search || "");
      if (qs.get("pane") === "dialog") return true;
      const s = String(navigator.userAgent || "") + " " + String(navigator.platform || "");
      if (/Windows|Win32|Win64|WOW64/i.test(s)) return false;
      return /Mac|Macintosh|Mac OS X|Darwin|Linux|X11|CrOS/i.test(s);
    } catch (e) { return false; }
  }

  // 根据当前 TaskPane 停靠状态刷新「脱离/停靠」按钮的图标和文字
  function refreshDockToggleUI() {
    if (!els.dockToggleBtn || !els.dockToggleIcon || !els.dockToggleLabel) return;
    // Mac/Linux 主面板已是浮窗，不显示「脱离右侧固定区」按钮
    if (preferFloatingPanel()) { els.dockToggleBtn.classList.add("hidden"); return; }
    const dock = global.WpsAiAddon?.getTaskPaneDockPosition?.();
    // dock=4 浮动；其他（2 右停靠 / null 取不到）都按"已停靠"显示
    const isFloating = dock === 4;
    // 切 body class，让 resize 抓手只在浮动时显示 + 改 cursor
    document.body.classList.toggle("is-floating", isFloating);
    els.dockToggleLabel.textContent = isFloating ? "停靠" : "脱离";
    els.dockToggleBtn.title = isFloating ? "停靠回 WPS 右侧固定区" : "脱离右侧固定区，浮动窗口";
    // 切换 SVG 图标：脱离=对角箭头；停靠=向左 dock-in 箭头
    if (isFloating) {
      els.dockToggleIcon.innerHTML = `
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
        <path d="M15 8l-3 4 3 4"/>
      `;
    } else {
      els.dockToggleIcon.innerHTML = `
        <path d="M14 3h7v7"/>
        <path d="M10 14L21 3"/>
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>
      `;
    }
  }

  function openSettingsModal(panel, subtab) {
    if (!els.settingsModal) return;
    renderChatProvidersList();   // 每次打开都重渲，避免 stale
    applySettingsToForm();       // 把 currentSettings 同步进表单（图像 / 统一 / 程序）
    els.settingsModal.classList.remove("hidden");
    if (panel) switchSettingsPanel(panel);
    if (subtab) activateSettingsSubtabByName(subtab);
  }

  // 把期望 dialog 尺寸根据屏幕可用区裁剪：低分辨率笔记本 (1366×768) / 多任务窗口里 1600×1000
  // 直接撑爆屏幕看不到底部按钮。规则：在 [minW/H, prefW/H] 之间挑能塞进屏幕的最大值；
  // 边距给 OS 任务栏 / WPS 主窗口标题栏留 100×140。
  function pickDialogSize(prefW, prefH, opts = {}) {
    const minW = opts.minW || 640;
    const minH = opts.minH || 480;
    const marginW = opts.marginW || 100;
    const marginH = opts.marginH || 140;
    const sw = (window.screen?.availWidth || window.screen?.width || prefW);
    const sh = (window.screen?.availHeight || window.screen?.height || prefH);
    const w = Math.max(minW, Math.min(prefW, sw - marginW));
    const h = Math.max(minH, Math.min(prefH, sh - marginH));
    return { w: Math.round(w), h: Math.round(h) };
  }

  // 用 WPS Application.ShowDialog 打开独立的设置窗口（脱离 TaskPane 宽度限制）。
  // 失败回退到 inline modal，保证最差情况下用户能改设置
  function openSettingsAsDialog(initialPanel, initialSubtab) {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const panelArg = initialPanel ? `&panel=${encodeURIComponent(initialPanel)}` : "";
      const subtabArg = initialSubtab ? `&subtab=${encodeURIComponent(initialSubtab)}` : "";
      const url = `${base}/taskpane.html?mode=settings${panelArg}${subtabArg}`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        const { w, h } = pickDialogSize(960, 720);
        // 第 5 个参数 true = 模态阻塞（调用要等用户关 dialog 才返回）。
        // 之前是 false（modeless），ShowDialog 立刻返回 → 下面的 activateWpsApp 在 dialog 刚弹出来时
        // 就跑了，等用户真正关 dialog 时早就过去了 → WPS 被 OS 最小化到托盘没人拉回来。
        // 改 modal=true 后 ShowDialog 阻塞到关闭，activateWpsApp 紧接关闭跑，行为跟预览 dialog 一致。
        app.ShowDialog(url, i18nDialogTitle("设置"), w, h, true);
        // dialog 关掉后 WPS 主窗口会被 OS 切到后台 / 最小化到托盘，主动拉回前台
        try { activateWpsApp(app); } catch (e) {}
        // 关掉后再延迟一拍重试一次，对付 WPS 演示这种关闭后还会切回后台的版本
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        // dialog 期间用户改的设置已经走 localStorage，关掉后我们重读并刷新 UI
        loadSettings();
        applySettingsToForm();
        renderProviderState();
        populateModelSelector(els.modelSelect?.value);
        return;
      }
    } catch (e) {
      console.warn("[settings] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    openSettingsModal(initialPanel || "chat", initialSubtab);
  }

  // 用 WPS Application.ShowDialog 打开独立的 PPT 风格设置窗口（脱离 TaskPane 宽度限制，
  // 跟"设置"dialog 一致：modal=true 阻塞到关闭，关掉后 activateWpsApp 把 WPS 拉回前台）。
  function openStylePresetAsDialog() {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=stylepreset`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        const { w, h } = pickDialogSize(720, 880);
        app.ShowDialog(url, i18nDialogTitle("PPT 风格"), w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        // dialog 期间用户在独立窗口里改 + 保存，主 TaskPane 这边重读 + 触发 UI 刷新
        loadSettings();
        return;
      }
    } catch (e) {
      console.warn("[stylepreset] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    openStylePresetModal();
  }

  // PPT 风格独立窗口里点关闭：保存表单 → 关窗
  function closeStylePresetDialogWindow() {
    try { saveStylePreset({ silent: true }); } catch (e) {}
    try { if (typeof window.close === "function") window.close(); } catch (e) {}
    setTimeout(() => { showMessage("已保存。请点窗口右上角 × 关闭。", "info"); }, 100);
  }

  // 独立窗口里点关闭：让 WPS 关掉当前 dialog；不行就提示用户手动关
  function closeSettingsDialogWindow() {
    // 保存最后一次未保存的编辑
    try { readSettingsFromForm(); persistSettings(); } catch (e) {}
    try {
      if (typeof window.close === "function") window.close();
    } catch (e) {}
    // window.close 在 WPS dialog 里可能没权限关；告诉用户手动点 X
    setTimeout(() => {
      showMessage("已保存。请点窗口右上角 × 关闭。", "info");
    }, 100);
  }

  // 监听 storage 事件：另一个窗口（settings dialog）改了 localStorage，主 TaskPane 同步
  if (!isSettingsDialog && !isQuickPromptDialog && !isFormatPreviewDialog && !isSelectionPreviewDialog && !isConversationsDialog) {
    window.addEventListener("storage", (ev) => {
      // 独立历史窗口（非阻塞 ShowDialog 版本）选中对话 → 主窗口加载
      if (ev.key === CONVERSATIONS_DIALOG_REQUEST_KEY && ev.newValue) {
        consumeConversationsDialogRequest();
      }
      if (ev.key === "wps_ai_provider_settings_v1") {
        const prevMcp = !!currentSettings?.mcpServerEnabled;
        loadSettings();
        renderProviderState();
        populateModelSelector(els.modelSelect?.value);
        // 设置窗口改了 MCP 开关 → 主面板（bridge 真正运行处）同步起停
        const nowMcp = !!currentSettings?.mcpServerEnabled;
        if (nowMcp !== prevMcp) {
          try {
            if (nowMcp) global.WpsAiMcpBridge?.start?.();
            else global.WpsAiMcpBridge?.stop?.();
          } catch (e) {}
        }
      }
      // 设置弹窗里点「测试」拉到的模型列表缓存（write-through 到 localStorage 会触发本事件）：
      // 主窗口同步刷新内存缓存 + 重建模型下拉，否则要等重启/手动刷新才能看到全部模型。
      if (ev.key === MODELS_CACHE_KEY) {
        try { modelsByProvider = ev.newValue ? (JSON.parse(ev.newValue) || {}) : {}; } catch (e) {}
        populateModelSelector(els.modelSelect?.value);
      }
      if (ev.key === IMAGE_MODELS_CACHE_KEY) {
        try { imageModelsByProvider = ev.newValue ? (JSON.parse(ev.newValue) || {}) : {}; } catch (e) {}
        try { renderImageProvidersList(); } catch (e) {}
      }
    });
  }

  function closeSettingsModal() {
    els.settingsModal?.classList.add("hidden");
    closePresetPicker();
    // 关闭时保存一次（按用户的"实时保存"预期）
    persistSettings();
    populateModelSelector(els.modelSelect?.value);
    renderProviderState();
  }

  function switchSettingsPanel(name) {
    document.querySelectorAll(".settings-sidebar-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.settingsPanel === name);
    });
    document.querySelectorAll(".settings-panel").forEach((sec) => {
      sec.classList.toggle("hidden", sec.dataset.settingsPanel !== name);
    });
    // 切到「技能」时按需渲染（首次进入或外部新增技能后都会重渲）
    if (name === "skills") {
      renderSkillsList();
      // 后台刷新云端技能（best-effort），拉到后重渲；失败用缓存，不打扰用户
      global.WpsAiSkills?.loadCloud?.().then((skills) => {
        if (skills && skills.length) renderSkillsList();
      }).catch(() => {});
    }
    if (name === "mcp") renderMcpPanel();
    // 切到「程序信息」时刷缓存面板（每次进都重扫，占用是动态的）
    if (name === "about") renderCachePanel();
    // 切到「Token 消耗」时重渲染（总计/会话/按模型都是动态的）
    if (name === "tokens") { try { renderTokenUsagePanel(); } catch (e) {} }
    // 切到「服务状态」时拉端口 + 内存占用
    if (name === "service") { try { bindServiceStatus(); loadServiceStatus(); } catch (e) {} }
  }

  function activateSettingsSubtab(root, target) {
    if (!root || !target) return;
    const owner = root.closest(".settings-panel") || document;
    root.querySelectorAll("[data-subtab-target]").forEach((btn) => {
      const active = btn.dataset.subtabTarget === target;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    owner.querySelectorAll(".settings-subtab-panel[data-subtab-panel]").forEach((panel) => {
      const active = panel.dataset.subtabPanel === target;
      panel.classList.toggle("active", active);
      panel.classList.toggle("hidden", !active);
    });
    if (target.startsWith("mcp-")) {
      try { renderMcpPanel(); } catch (e) {}
    }
    if (target === "about-cache") {
      try { renderCachePanel(); } catch (e) {}
    }
  }

  function fmtBytesShort(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
    return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function bindServiceStatus() {
    if (els.svcStatusRefreshBtn && els.svcStatusRefreshBtn.dataset.bound !== "1") {
      els.svcStatusRefreshBtn.dataset.bound = "1";
      els.svcStatusRefreshBtn.addEventListener("click", () => { loadServiceStatus(); });
    }
  }

  // 把各种异常/错误体转成可读字符串，避免 String(object) 出 "[object Object]"。
  function errText(x) {
    if (x == null) return "";
    if (typeof x === "string") return x;
    if (x instanceof Error) return x.message || String(x);
    if (typeof x.message === "string" && x.message) return x.message;
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  }

  function renderServiceStatus(data) {
    const body = els.svcStatusBody;
    if (!body) return;
    // 静态端口以前端自己的加载地址为准（proxy 侧 env 未必拿得到）
    const staticPort = (window.location && window.location.port) || (data.ports && data.ports.static) || "—";
    const proxyPort = (data.ports && data.ports.proxy) || "—";
    const procs = Array.isArray(data.processes) ? data.processes : [];
    const total = data.totalRssBytes || procs.reduce((a, p) => a + (p.rssBytes || 0), 0) || 0;
    if (els.svcMemBadge) els.svcMemBadge.textContent = "内存 " + fmtBytesShort(total);
    const memRows = procs.length
      ? procs.map((p) =>
          `<div class="svc-row"><span class="svc-kind">${escapeHtml(p.kind || "node")}</span>` +
          `<span class="svc-pid muted">pid ${p.pid}</span>` +
          `<span class="svc-mem">${fmtBytesShort(p.rssBytes)}</span></div>`
        ).join("")
      : '<span class="muted">未检测到后台服务进程。</span>';
    const uptimeMin = Math.round((data.self?.uptimeSec || 0) / 60);
    body.innerHTML =
      '<div class="svc-row"><span class="svc-kind">静态服务端口</span><span class="svc-mem">' + escapeHtml(String(staticPort)) + '</span></div>' +
      '<div class="svc-row"><span class="svc-kind">代理服务端口</span><span class="svc-mem">' + escapeHtml(String(proxyPort)) + '</span></div>' +
      '<div class="muted" style="margin:8px 0 4px;font-size:11px">内存占用（合计 ' + fmtBytesShort(total) + '）</div>' +
      memRows +
      (data.nodeVersion ? '<div class="muted" style="margin-top:6px;font-size:11px">Node ' + escapeHtml(data.nodeVersion) + ' · 已运行 ' + uptimeMin + ' 分钟</div>' : "");
  }

  // 拉后台服务的端口 + 内存占用。失败先让 Runtime 重探端口（dev 下 proxy 常在 3892，
  // 而默认 base 是 3890）再重试一次，避免"读取失败"其实只是端口没对上。
  async function loadServiceStatus() {
    const body = els.svcStatusBody;
    if (!body) return;
    body.innerHTML = '<span class="muted">加载中…</span>';
    const doFetch = async () => {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const resp = await fetch(base + "/service/status", { method: "GET", cache: "no-store" });
      let data = null;
      try { data = await resp.json(); } catch (e) { data = null; }
      if (!resp.ok || !data || !data.ok) {
        const detail = data && (data.error || data.message);
        throw new Error(errText(detail) || ("HTTP " + resp.status));
      }
      return data;
    };
    try {
      let data;
      try {
        data = await doFetch();
      } catch (e1) {
        try { await global.WpsAiRuntime?.reprobe?.(); } catch (e) {}
        data = await doFetch(); // 重探端口后再试一次
      }
      renderServiceStatus(data);
    } catch (e) {
      if (els.svcMemBadge) els.svcMemBadge.textContent = "内存 —";
      body.innerHTML = '<span class="muted">读取失败：' + escapeHtml(errText(e)) +
        '。确认后台服务已启动；若刚改过 proxy 代码（dev），请重跑 npm run dev 让新代理带上该接口。</span>';
    }
  }

  function activateSettingsSubtabByName(target) {
    if (!target) return;
    const btn = document.querySelector(`.settings-subtabs [data-subtab-target="${target}"]`);
    const root = btn?.closest?.(".settings-subtabs");
    if (root) activateSettingsSubtab(root, target);
  }

  function bindSettingsSubtabs() {
    document.querySelectorAll(".settings-subtabs[data-settings-subtabs]").forEach((root) => {
      if (root.dataset.bound === "1") return;
      root.dataset.bound = "1";
      const initial = root.querySelector(".settings-subtab-btn.active")?.dataset.subtabTarget
        || root.querySelector("[data-subtab-target]")?.dataset.subtabTarget;
      if (initial) activateSettingsSubtab(root, initial);
      root.querySelectorAll("[data-subtab-target]").forEach((btn) => {
        btn.addEventListener("click", () => activateSettingsSubtab(root, btn.dataset.subtabTarget));
      });
    });
  }

  // ============ Token 消耗 UI ============
  let _tokenUsageUnsub = null;

  function fmtInt(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function getTokenRangeOptions() {
    const rangeEl = document.getElementById("tokenUsageRange");
    const value = rangeEl?.value || "7";
    if (value === "all") return { days: "all" };
    const days = Math.max(1, Math.floor(Number(value) || 7));
    return { days };
  }

  function shortDateLabel(date) {
    const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[2])}/${Number(m[3])}` : String(date || "—");
  }

  function renderTokenTrendChart(el, dailyRows) {
    if (!el) return;
    const rows = Array.isArray(dailyRows) ? dailyRows : [];
    if (!rows.length) {
      el.innerHTML = `<div class="token-usage-empty">暂无按日记录</div>`;
      return;
    }
    const max = Math.max(0, ...rows.map((r) => Number(r.total) || 0));
    el.innerHTML = `<div class="token-trend-bars">${rows.map((r) => {
      const total = Number(r.total) || 0;
      const height = max > 0 && total > 0 ? Math.max(4, Math.round(total / max * 100)) : 0;
      const title = `${r.date || "—"} · 总计 ${fmtInt(total)} · 调用 ${fmtInt(r.calls)}`;
      return `<div class="token-trend-col" title="${escapeAttr(title)}">
        <div class="token-trend-value">${total ? fmtInt(total) : ""}</div>
        <div class="token-trend-track"><div class="token-trend-bar" style="height:${height}%"></div></div>
        <span>${escapeHtml(shortDateLabel(r.date))}</span>
      </div>`;
    }).join("")}</div>`;
  }

  function renderTokenModelChart(el, rows) {
    if (!el) return;
    const topRows = (Array.isArray(rows) ? rows : []).filter((r) => (Number(r.total) || 0) > 0).slice(0, 5);
    if (!topRows.length) {
      el.innerHTML = `<div class="token-usage-empty">暂无模型占比</div>`;
      return;
    }
    const sum = topRows.reduce((acc, r) => acc + (Number(r.total) || 0), 0) || 1;
    el.innerHTML = `<div class="token-share-list">${topRows.map((r) => {
      const total = Number(r.total) || 0;
      const pct = Math.round(total / sum * 1000) / 10;
      const width = Math.max(2, Math.min(100, pct));
      const name = `${r.provider || "unknown"} / ${r.model || "unknown"}`;
      return `<div class="token-share-row" title="${escapeAttr(name + " · " + fmtInt(total))}">
        <div class="token-share-meta">
          <span>${escapeHtml(r.model || "unknown")}</span>
          <small>${escapeHtml(r.provider || "unknown")} · ${pct}%</small>
        </div>
        <div class="token-share-track"><div class="token-share-bar" style="width:${width}%"></div></div>
        <span class="token-share-total">${fmtInt(total)}</span>
      </div>`;
    }).join("")}</div>`;
  }

  function renderTokenDailyTable(el, dailyRows) {
    if (!el) return;
    const rows = (Array.isArray(dailyRows) ? dailyRows : []).slice().reverse();
    if (!rows.length) {
      el.innerHTML = `<div class="muted" style="padding:10px 0">暂无按日记录。</div>`;
      return;
    }
    const head = `<div class="token-row token-row-head token-row-daily"><span>日期</span><span>输入</span><span>输出</span><span>总计</span><span>次数</span></div>`;
    const body = rows.map((r) =>
      `<div class="token-row token-row-daily"><span>${escapeHtml(r.date || "—")}</span><span>${fmtInt(r.input)}</span><span>${fmtInt(r.output)}</span><span>${fmtInt(r.total)}</span><span>${fmtInt(r.calls)}</span></div>`
    ).join("");
    el.innerHTML = head + body;
  }

  function renderTokenUsagePanel() {
    const store = global.WpsAiTokenUsage;
    const totalsEl = document.getElementById("tokenUsageTotals");
    const sessionEl = document.getElementById("tokenUsageSession");
    const tableEl = document.getElementById("tokenUsageTable");
    const trendEl = document.getElementById("tokenUsageTrendChart");
    const modelChartEl = document.getElementById("tokenUsageModelChart");
    const dailyTableEl = document.getElementById("tokenUsageDailyTable");
    if (!store || !totalsEl || !tableEl) return;
    const rangeOpts = getTokenRangeOptions();
    const g = store.getTotals(rangeOpts);
    const s = store.getSession();
    totalsEl.innerHTML =
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.input)}</span><span class="token-stat-lbl">输入</span></div>` +
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.output)}</span><span class="token-stat-lbl">输出</span></div>` +
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.total)}</span><span class="token-stat-lbl">总计</span></div>` +
      `<div class="token-stat"><span class="token-stat-num">${fmtInt(g.calls)}</span><span class="token-stat-lbl">调用</span></div>`;
    if (sessionEl) sessionEl.textContent = `本会话：输入 ${fmtInt(s.input)} · 输出 ${fmtInt(s.output)} · 总计 ${fmtInt(s.total)} · ${fmtInt(s.calls)} 次`;
    const rows = store.getBreakdown(rangeOpts);
    const dailyRows = typeof store.getDailyBreakdown === "function" ? store.getDailyBreakdown(rangeOpts) : [];
    renderTokenTrendChart(trendEl, dailyRows);
    renderTokenModelChart(modelChartEl, rows);
    renderTokenDailyTable(dailyTableEl, dailyRows);
    if (!rows.length) {
      tableEl.innerHTML = `<div class="muted" style="padding:12px 0">暂无记录。跑一次 AI 对话或选区操作后这里会显示各模型的 token 用量。</div>`;
    } else {
      const head = `<div class="token-row token-row-head"><span>模型</span><span>来源</span><span>输入</span><span>输出</span><span>总计</span><span>次数</span></div>`;
      const body = rows.map((r) =>
        `<div class="token-row"><span title="${escapeAttr(r.model)}">${escapeHtml(r.model)}</span><span title="${escapeAttr(r.provider)}">${escapeHtml(r.provider)}</span><span>${fmtInt(r.input)}</span><span>${fmtInt(r.output)}</span><span>${fmtInt(r.total)}</span><span>${fmtInt(r.calls)}</span></div>`
      ).join("");
      tableEl.innerHTML = head + body;
    }
    // 清零按钮 + 用量变化订阅：面板可能被反复渲染（每次切 tab 都会重渲），
    // 用 dataset.bound / 模块级 unsub 防止重复绑定；这样无论是主 TaskPane 流程
    // 还是独立设置窗口（isSettingsDialog）流程，只要走到这个面板就能生效。
    const clearBtn = document.getElementById("tokenUsageClearBtn");
    if (clearBtn && clearBtn.dataset.bound !== "1") {
      clearBtn.dataset.bound = "1";
      clearBtn.addEventListener("click", () => {
        if (window.confirm(i18nT("确定清零所有 token 用量统计？此操作不可撤销。"))) {
          global.WpsAiTokenUsage?.clear?.();
          renderTokenUsagePanel();
        }
      });
    }
    const rangeEl = document.getElementById("tokenUsageRange");
    if (rangeEl && rangeEl.dataset.bound !== "1") {
      rangeEl.dataset.bound = "1";
      rangeEl.addEventListener("change", () => renderTokenUsagePanel());
    }
    if (!_tokenUsageUnsub && store.onChange) {
      _tokenUsageUnsub = store.onChange(() => {
        const sec = document.querySelector('.settings-panel[data-settings-panel="tokens"]');
        if (sec && !sec.classList.contains("hidden")) renderTokenUsagePanel();
      });
    }
  }

  // ============ MCP 服务 UI ============
  let _mcpStatusUnsub = null;
  let _mcpProxyStatusTimer = null;

  // 把 WpsAiAddon.getUrlPath() (URL 形式) 转成本地 FS 路径，给 MCP 配置 JSON 用。
  // 输入示例:
  //   file:///E:/workspace/.../plugin                   → E:/workspace/.../plugin
  //   file:///Users/alice/.lingxi-ai/plugin             → /Users/alice/.lingxi-ai/plugin
  //   http://localhost:8889                             → null（dev 模式，无法反推 FS 路径）
  function detectPluginInstallPath() {
    try {
      const url = global.WpsAiAddon?.getUrlPath?.() || "";
      if (!url) return null;
      // file:// 协议 → 去前缀；空格等已被 decodeURI 解过
      const FILE_PREFIX = "file:///";
      if (url.startsWith(FILE_PREFIX)) {
        let p = url.slice(FILE_PREFIX.length);
        // Windows 盘符（"E:/..."）保持原样；其他平台前面补 /
        if (!/^[A-Za-z]:/.test(p)) p = "/" + p;
        // 去末尾斜杠
        p = p.replace(/[\\/]+$/, "");
        return p;
      }
      const FILE_PREFIX2 = "file://"; // 双斜杠形式（部分 WebView）
      if (url.startsWith(FILE_PREFIX2)) {
        return url.slice(FILE_PREFIX2.length).replace(/[\\/]+$/, "");
      }
      return null; // http/https → dev 模式，让用户手填
    } catch (e) { return null; }
  }

  // 工具数 / 连接态的权威来源是代理 mcpState（主面板 bridge 上报的），跨窗口共享。
  // 设置是独立 ?mode=settings 窗口，它自己的 bridge 从不 start（本地 _status 恒为
  // toolCount:0/connected:false）——所以这里从 proxy /mcp/status 拉真实值，否则重启后
  // 设置里工具数永远显示 0。enabled 仍用用户偏好，lastError 保留本地。
  async function refreshMcpStatusFromProxy() {
    try {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const r = await fetch(base + "/mcp/status", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.ok) return;
      const local = global.WpsAiMcpBridge?.getStatus?.() || {};
      applyMcpStatusToUi({
        enabled: !!currentSettings?.mcpServerEnabled,
        connected: !!j.pluginAlive,
        toolCount: Number(j.toolCount) || 0,
        lastError: local.lastError || null,
        lastRegisteredAt: j.registeredAt || local.lastRegisteredAt || null
      });
    } catch (e) {}
  }

  function renderMcpPanel() {
    // 状态文字 + 工具数 + 错误（实时跟随 mcp-bridge 的 status）
    const bridge = global.WpsAiMcpBridge;
    if (!bridge) {
      if (els.mcpStatusBadge) els.mcpStatusBadge.textContent = "模块未加载";
      return;
    }
    applyMcpStatusToUi(bridge.getStatus());
    if (_mcpStatusUnsub) { try { _mcpStatusUnsub(); } catch (e) {} }
    _mcpStatusUnsub = bridge.onStatusChange(applyMcpStatusToUi);
    // 从代理拉权威工具数/连接态（修跨窗口：设置窗口 bridge 不 start，本地永远 0），
    // 并按小间隔刷新。设置窗口关闭即销毁，interval 随之消失；再次打开会重置。
    refreshMcpStatusFromProxy();
    if (_mcpProxyStatusTimer) { clearInterval(_mcpProxyStatusTimer); }
    _mcpProxyStatusTimer = setInterval(refreshMcpStatusFromProxy, 4000);

    // 配置 JSON 片段：优先从 WpsAiAddon.getUrlPath() 推 plugin 安装的本地 FS 路径（dev 模式
    // 用 file:// 时能直接拿到）。生产安装走 http://localhost 推不出来，向 proxy 问 /install-path
    // 拿真实 mcp-server.js 的绝对路径。
    function writeMcpSnippet(mcpScript) {
      const token = global.WpsAiMcpBridge?.getToken?.() || "";
      const cfg = {
        mcpServers: {
          "wps-ai": {
            command: "node",
            args: [mcpScript],
            env: Object.assign(
              { WPS_PROXY_PORT: "3890" },
              token ? { WPS_MCP_TOKEN: token } : {}
            )
          }
        }
      };
      if (els.mcpConfigSnippet) els.mcpConfigSnippet.value = JSON.stringify(cfg, null, 2);
    }
    const installRoot = detectPluginInstallPath();
    if (installRoot) {
      writeMcpSnippet(`${installRoot}/tools/mcp-server.js`);
    } else {
      writeMcpSnippet("<填入 plugin 安装路径>/tools/mcp-server.js");
      // 异步问 proxy 拿真实路径，回来后覆写片段
      fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/install-path", { method: "GET" })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.ok && data.mcpServer) writeMcpSnippet(data.mcpServer);
        })
        .catch(() => { /* proxy 离线就保留占位符 */ });
    }

    // 暴露的工具清单（按当前宿主）
    renderMcpToolsList();
    // 最近外部调用日志
    renderMcpCallLog();
    // 订阅新调用事件，实时追加（本窗口 record 时触发——只在主面板有效）
    if (bridge.onCall && !_mcpCallLogUnsub) {
      _mcpCallLogUnsub = bridge.onCall(() => renderMcpCallLog());
    }
    // 跨窗口实时刷新：主面板 record 到共享存储（小受管键 write-through localStorage）
    // 会触发本窗口 storage 事件——设置窗口靠它实时刷新，不依赖自己实例的 onCall。
    if (!_mcpCallLogStorageBound) {
      _mcpCallLogStorageBound = true;
      window.addEventListener("storage", (ev) => {
        if (ev.key === "lingxi_mcp_call_log_v1") {
          try { bridge.reloadCallLogFromStore?.(); } catch (e) {}
          renderMcpCallLog();
        }
      });
    }
    if (els.mcpCallLogClearBtn && els.mcpCallLogClearBtn.dataset.bound !== "1") {
      els.mcpCallLogClearBtn.dataset.bound = "1";
      els.mcpCallLogClearBtn.addEventListener("click", () => {
        if (!bridge.clearCallLog) return;
        bridge.clearCallLog();
        renderMcpCallLog();
      });
    }
  }

  let _mcpCallLogUnsub = null;
  let _mcpCallLogStorageBound = false;
  function renderMcpCallLog() {
    const host = els.mcpCallLogList;
    if (!host) return;
    const bridge = global.WpsAiMcpBridge;
    const calls = bridge?.listRecentCalls ? bridge.listRecentCalls() : [];
    if (!calls.length) {
      host.innerHTML = '<div class="mcp-call-log-empty">还没有外部 agent 调用记录。启动 MCP 服务并让外部 agent 发起调用后，这里会出现。</div>';
      return;
    }
    host.innerHTML = calls.map((c) => {
      const statusCls = c.ok ? "ok" : "err";
      const statusTxt = c.ok ? "成功" : "失败";
      const time = fmtTime(c.at);
      const ms = Number.isFinite(c.elapsedMs) ? `${c.elapsedMs} ms` : "";
      const err = c.error ? `<div class="mcp-call-log-err">${escapeHtmlSafe(c.error)}</div>` : "";
      const argsHtml = c.argsPreview ? `<div class="mcp-call-log-args"><span class="mcp-call-log-label">入参</span><code>${escapeHtmlSafe(c.argsPreview)}</code></div>` : "";
      return `<div class="mcp-call-log-item ${statusCls}">
        <div class="mcp-call-log-row1">
          <span class="mcp-call-log-status ${statusCls}">${statusTxt}</span>
          <span class="mcp-call-log-name">${escapeHtmlSafe(c.name || "unknown")}</span>
          <span class="mcp-call-log-time">${time}</span>
          ${ms ? `<span class="mcp-call-log-ms">${ms}</span>` : ""}
        </div>
        ${argsHtml}
        ${err}
      </div>`;
    }).join("");
  }

  function applyMcpStatusToUi(st) {
    if (!st) return;
    const badge = els.mcpStatusBadge;
    if (badge) {
      badge.classList.remove("connected", "error", "disabled");
      if (!st.enabled) {
        badge.textContent = "未启用";
        badge.classList.add("disabled");
      } else if (st.connected) {
        badge.textContent = "已连接 ✓";
        badge.classList.add("connected");
      } else {
        badge.textContent = "已开启，未连接";
        badge.classList.add("error");
      }
    }
    if (els.mcpToolCount) els.mcpToolCount.textContent = String(st.toolCount || 0);
    if (els.mcpLastError) els.mcpLastError.textContent = st.lastError || "（无）";
    // 不要用运行态 st.enabled 覆盖 checkbox：checkbox 是「用户偏好」，跟随保存的设置。
    // 设置是独立 ?mode=settings 窗口，它的 bridge 实例从不 start（自动启动只在主面板），
    // st.enabled 恒为 false——用它覆盖会把用户已保存的启用状态视觉上重置为未勾。
    // 状态徽章仍反映运行态；checkbox 由 currentSettings.mcpServerEnabled 驱动。
    if (els.mcpServerEnabledInput) {
      const pref = !!currentSettings?.mcpServerEnabled;
      if (els.mcpServerEnabledInput.checked !== pref) els.mcpServerEnabledInput.checked = pref;
    }
  }

  function renderMcpToolsList() {
    const host = els.mcpToolsList;
    if (!host) return;
    host.innerHTML = "";
    const reg = global.WpsAiToolRegistry;
    if (!reg?.listAll) {
      host.innerHTML = '<div class="skills-empty">工具注册表未加载</div>';
      return;
    }
    // 暴露 plugin 注册的全部工具（跨宿主），按宿主分组显示
    const defs = reg.listAll();
    if (!defs.length) {
      host.innerHTML = '<div class="skills-empty">插件未注册任何工具</div>';
      return;
    }
    // 按宿主分组：wps / wpp / et / pdf / "*"（通用）
    const groups = new Map();
    defs.forEach((d) => {
      const hosts = Array.isArray(d.hosts) ? d.hosts : (d.hosts ? [d.hosts] : ["*"]);
      hosts.forEach((h) => {
        if (!groups.has(h)) groups.set(h, []);
        groups.get(h).push(d);
      });
    });
    const HOST_LABELS = { "*": "通用", wps: "WPS 文字", wpp: "WPP 演示", et: "ET 表格", pdf: "PDF 阅读" };
    const order = ["*", "wps", "wpp", "et", "pdf"];
    order.forEach((h) => {
      const items = groups.get(h);
      if (!items?.length) return;
      const head = document.createElement("div");
      head.style.cssText = "padding:6px 8px 2px;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:0.5px;text-transform:uppercase;";
      head.textContent = `${HOST_LABELS[h] || h} (${items.length})`;
      host.appendChild(head);
      items.forEach((d) => {
        const row = document.createElement("div");
        row.className = "mcp-tool-row";
        const name = document.createElement("span");
        name.className = "mcp-tool-name";
        name.textContent = d.name;
        const desc = document.createElement("span");
        desc.className = "mcp-tool-desc";
        const firstLine = String(d.description || "").split(/\r?\n/)[0].slice(0, 120);
        desc.textContent = firstLine || "（无描述）";
        row.appendChild(name);
        row.appendChild(desc);
        host.appendChild(row);
      });
    });
  }

  // ============ 技能（Skills）UI ============
  // 渲染设置面板里的技能列表：内置 + 用户导入，统一按"卡片 + 复选框 + 操作按钮"展示
  // 技能分类：从 hostFilter + builtin 派生，避免改动 skills.js 数据结构
  const SKILL_CATEGORIES = [
    { key: "all",    label: "全部" },
    { key: "wps",    label: "Word" },
    { key: "et",     label: "Excel" },
    { key: "wpp",    label: "PPT" },
    { key: "pdf",    label: "PDF" },
    { key: "common", label: "通用" },
    { key: "cloud",  label: "云端" },
    { key: "user",   label: "自定义" }
  ];
  let _skillFilter = { category: "all", query: "" };

  function inferSkillCategory(skill) {
    if (skill.source === "cloud") return "cloud";
    if (!skill.builtin) return "user";
    const hf = Array.isArray(skill.hostFilter) ? skill.hostFilter : [];
    if (hf.length === 0) return "common";
    return hf[0]; // 单一宿主直接用；多宿主时归到第一个（目前 BUILTIN 里最多单宿主）
  }

  function renderSkillCategoryChips(counts) {
    const host = els.skillsCategoryChips;
    if (!host) return;
    host.innerHTML = "";
    SKILL_CATEGORIES.forEach((cat) => {
      const n = counts.get(cat.key) || 0;
      if (cat.key !== "all" && n === 0) return; // 空分类不显示，减少视觉噪音
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "skills-category-chip" + (_skillFilter.category === cat.key ? " active" : "");
      btn.dataset.category = cat.key;
      btn.textContent = n > 0 && cat.key !== "all" ? `${cat.label} · ${n}` : cat.label;
      btn.addEventListener("click", () => {
        _skillFilter.category = cat.key;
        renderSkillsList();
      });
      host.appendChild(btn);
    });
  }

  function bindSkillSearch() {
    if (!els.skillsSearchInput || els.skillsSearchInput.dataset.bound === "1") return;
    els.skillsSearchInput.dataset.bound = "1";
    els.skillsSearchInput.addEventListener("input", () => {
      _skillFilter.query = String(els.skillsSearchInput.value || "").trim().toLowerCase();
      renderSkillsList();
    });
  }

  function renderSkillsList() {
    const host = els.skillsList;
    if (!host) return;
    const Skills = global.WpsAiSkills;
    if (!Skills) {
      host.innerHTML = '<div class="skills-empty">技能模块未加载</div>';
      return;
    }
    bindSkillSearch();
    host.innerHTML = "";
    const all = Skills.list();
    if (!all.length) {
      renderSkillCategoryChips(new Map([["all", 0]]));
      host.innerHTML = '<div class="skills-empty">暂无技能</div>';
      return;
    }
    // 每个分类的数量，用来渲染 chip
    const counts = new Map([["all", all.length]]);
    all.forEach((s) => {
      const c = inferSkillCategory(s);
      counts.set(c, (counts.get(c) || 0) + 1);
    });
    renderSkillCategoryChips(counts);

    const q = _skillFilter.query;
    const filtered = all.filter((s) => {
      if (_skillFilter.category !== "all" && inferSkillCategory(s) !== _skillFilter.category) return false;
      if (q) {
        const hay = `${s.name || ""}\n${s.description || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (!filtered.length) {
      host.innerHTML = `<div class="skills-empty">没有匹配「${escapeHtmlSafe(q || _skillFilter.category)}」的技能。</div>`;
      return;
    }
    filtered.forEach((skill) => {
      const item = document.createElement("div");
      item.className = "skill-item" + (Skills.isEnabled(skill.id) ? " enabled" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Skills.isEnabled(skill.id);
      cb.title = "启用 / 停用此技能";
      cb.addEventListener("change", () => {
        Skills.setEnabled(skill.id, cb.checked);
        item.classList.toggle("enabled", cb.checked);
      });
      const body = document.createElement("div");
      body.className = "skill-item-body";
      const row1 = document.createElement("div");
      row1.className = "skill-item-row1";
      const name = document.createElement("span");
      name.className = "skill-item-name";
      name.textContent = skill.name;
      const badge = document.createElement("span");
      const badgeKind = skill.source === "cloud" ? " cloud" : (skill.builtin ? "" : " user");
      badge.className = "skill-item-badge" + badgeKind;
      badge.textContent = skill.source === "cloud" ? "云端" : (skill.builtin ? "内置" : "自定义");
      row1.appendChild(name);
      row1.appendChild(badge);
      const desc = document.createElement("div");
      desc.className = "skill-item-desc";
      desc.textContent = skill.description || "（无描述）";
      body.appendChild(row1);
      body.appendChild(desc);

      const actions = document.createElement("div");
      actions.className = "skill-item-actions";
      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "skill-item-action";
      previewBtn.textContent = "查看";
      previewBtn.title = "查看技能全文";
      previewBtn.addEventListener("click", () => showSkillPreview(skill));
      actions.appendChild(previewBtn);
      // 云端技能来自 OSS 缓存，removeUser 删不掉（下次 loadCloud 又拉回），不显示删除按钮，避免"假删除"。
      if (!skill.builtin && skill.source !== "cloud") {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "skill-item-action danger";
        del.textContent = "删除";
        del.title = "从本地删除这条技能";
        del.addEventListener("click", () => {
          if (!confirm(i18nT("从技能库删除「{name}」？此操作不可撤销。", { name: skill.name }))) return;
          Skills.removeUser(skill.id);
          renderSkillsList();
        });
        actions.appendChild(del);
      }

      item.appendChild(cb);
      item.appendChild(body);
      item.appendChild(actions);
      host.appendChild(item);
    });
  }

  // 技能全文预览：内联 overlay（window.open 在 WPS WebView 经常被拦）。
  // 支持：
  //   - markdown 渲染（有 WpsAiMarkdown 时）
  //   - contentPath 形式的内置技能（UI/UX Pro Max 44KB）懒加载
  //   - 复制全文 / 按 Esc 关闭 / 点 overlay 关闭
  let _skillPreviewOverlay = null;
  async function showSkillPreview(skill) {
    closeSkillPreview(); // 先关上次的
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay skill-preview-overlay";
    overlay.innerHTML = `
      <div class="modal-card skill-preview-card">
        <div class="modal-header">
          <h3>
            <span class="skill-preview-name"></span>
            <span class="skill-item-badge skill-preview-badge"></span>
          </h3>
          <div class="modal-header-actions">
            <button type="button" class="ghost-btn" data-act="copy" title="复制全文到剪贴板">复制全文</button>
            <button type="button" class="modal-close" data-act="close" aria-label="关闭">×</button>
          </div>
        </div>
        <div class="modal-body skill-preview-body">
          <div class="skill-preview-desc"></div>
          <div class="skill-preview-meta"></div>
          <div class="skill-preview-content"></div>
          <div class="skill-preview-loading">加载中…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    _skillPreviewOverlay = overlay;

    const nameEl = overlay.querySelector(".skill-preview-name");
    const badgeEl = overlay.querySelector(".skill-preview-badge");
    const descEl = overlay.querySelector(".skill-preview-desc");
    const metaEl = overlay.querySelector(".skill-preview-meta");
    const contentEl = overlay.querySelector(".skill-preview-content");
    const loadingEl = overlay.querySelector(".skill-preview-loading");

    nameEl.textContent = skill.name || "未命名技能";
    badgeEl.textContent = skill.source === "cloud" ? "云端" : (skill.builtin ? "内置" : "自定义");
    badgeEl.classList.toggle("user", !skill.builtin && skill.source !== "cloud");
    badgeEl.classList.toggle("cloud", skill.source === "cloud");
    descEl.textContent = skill.description || "（无描述）";

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSkillPreview();
      const act = e.target?.closest?.("[data-act]")?.dataset?.act;
      if (act === "close") closeSkillPreview();
      if (act === "copy") {
        const text = contentEl.dataset.rawText || "";
        copyToClipboard(text).then((ok) => {
          showMessage(ok ? `已复制 ${text.length} 字符到剪贴板` : "复制失败", ok ? "success" : "error");
        });
      }
    });
    // Esc 关闭
    const onKey = (ev) => { if (ev.key === "Escape") closeSkillPreview(); };
    document.addEventListener("keydown", onKey);
    overlay.dataset.keyHandler = "1";
    overlay._cleanupKey = () => document.removeEventListener("keydown", onKey);

    // 加载内容（contentPath 形式异步）
    let content = "";
    try {
      if (skill.content) {
        content = skill.content;
      } else if ((skill.contentPath || skill.url) && global.WpsAiSkills?.loadContent) {
        content = await global.WpsAiSkills.loadContent(skill);
      }
    } catch (e) {
      content = `（加载失败：${e?.message || e}）`;
    }
    loadingEl.style.display = "none";

    const chars = content.length;
    const lines = content.split(/\r?\n/).length;
    const tokens = Math.ceil(chars / 4); // 粗略估算
    metaEl.textContent = `${chars.toLocaleString()} 字符 · ${lines.toLocaleString()} 行 · ≈${tokens.toLocaleString()} tokens`;

    contentEl.dataset.rawText = content;
    // 优先 markdown 渲染（标题/列表/代码块更好看）；没加载就降级 <pre>
    if (global.WpsAiMarkdown?.renderToHtml) {
      contentEl.innerHTML = global.WpsAiMarkdown.renderToHtml(content);
      contentEl.classList.add("markdown");
    } else {
      const pre = document.createElement("pre");
      pre.textContent = content;
      contentEl.appendChild(pre);
    }
  }

  function closeSkillPreview() {
    if (!_skillPreviewOverlay) return;
    try { _skillPreviewOverlay._cleanupKey?.(); } catch (e) {}
    try { _skillPreviewOverlay.remove(); } catch (e) {}
    _skillPreviewOverlay = null;
  }

  // 文件选择 → 解析 → 入库
  function handleSkillImport(file) {
    if (!file) return;
    const Skills = global.WpsAiSkills;
    if (!Skills) { showMessage("技能模块未加载", "error"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const parsed = Skills.parseMarkdownSkill(text, file.name);
        if (!parsed.content) {
          showMessage(`「${file.name}」内容为空，已跳过`, "error");
          return;
        }
        const saved = Skills.addUser(parsed);
        showMessage(`已导入技能「${saved.name}」`, "success");
        renderSkillsList();
      } catch (e) {
        showMessage(`导入失败：${e?.message || e}`, "error");
      }
    };
    reader.onerror = () => showMessage("读取文件失败", "error");
    reader.readAsText(file, "utf-8");
  }

  // 拼成 system prompt block (async, 因为 contentPath 形式的内置 skill 要 fetch 文件)
  // opts.host 让 skill 的 hostFilter 生效（如 UI/UX Pro Max 只在 PPT 宿主注入）
  // 技能改成「渐进式披露」：system prompt 只列技能名 + 简介，AI 判断命中后调 use_skill 工具加载完整指引。
  // 好处：省 token（不再每轮全量塞技能正文）+ 技能调用在时间轴里单独成一步、单独计数。
  async function buildSkillsPromptBlock(opts) {
    try {
      const Skills = global.WpsAiSkills;
      if (!Skills || typeof Skills.getEnabledSkills !== "function") return "";
      const host = opts?.host;
      const enabled = (Skills.getEnabledSkills() || []).filter((s) => {
        if (!Array.isArray(s.hostFilter) || !s.hostFilter.length) return true;
        return !host || s.hostFilter.includes(host);
      });
      const parts = ["\n--- 技能（skill）---"];
      if (enabled.length) {
        parts.push("下面每个技能封装了针对特定场景的一套详细做法。判断当前任务命中某个技能时，先调 use_skill（name 传技能名）把它的完整指引读进来，再照着做；没命中就正常处理，不用调。");
        parts.push(enabled.map((s) => `- ${s.name}${s.description ? "：" + s.description : ""}`).join("\n"));
      }
      // 让 AI 知道能把当前操作沉淀成技能、并持续优化
      parts.push("当你完成了一套值得复用的操作，或用户要求「把刚才的操作总结成技能 / 记住这个做法 / 优化某技能」时，用 save_skill 把做法沉淀成技能（name 同名则更新=持续优化，description 写清适用场景，content 写清步骤要点）；以后遇到类似任务用 use_skill 复用。沉淀技能时只总结对话历史里已经做过的操作，不要重新执行任何工具、不要改动当前文档，这一轮只调 save_skill。");
      return parts.join("\n");
    } catch (e) { return ""; }
  }

  // 在用户的当前一轮输入里查找 PPT 风格/视觉关键词。命中说明用户已经表达了风格意图，
  // 此时让位给设计自由度（UI/UX Pro Max 技能），不再用本地 stylePreset 锁死色板。
  function detectPptStyleIntent(text) {
    if (!text) return false;
    const s = String(text).toLowerCase();
    // 中文风格 / 设计感关键词（按 PPT 设计场景挑常出现的）
    const ZH = [
      // 风格名
      "极简", "扁平", "拟物", "玻璃", "毛玻璃", "立体", "暗黑", "深色", "亮色", "高对比",
      "霓虹", "赛博", "蒸汽波", "复古", "做旧", "波普", "野兽派", "孟菲斯",
      "水墨", "国风", "中式", "日系", "和风", "禅意", "瑞士风", "包豪斯",
      "卡通", "手绘", "插画", "杂志", "编辑", "报刊", "漫画", "像素",
      "科技", "未来", "金属", "工业", "现代", "古典", "高级",
      // 视觉特征
      "渐变", "光晕", "粒子", "网格", "卡片", "圆角", "阴影",
      // 颜色暗示
      "色调", "配色", "主色", "色板", "用红", "用蓝", "用绿", "用紫", "用黄", "用黑", "用白",
      "暖色", "冷色",
      // 通用
      "风格", "调性", "氛围", "设计感", "高端"
    ];
    if (ZH.some((k) => s.includes(k))) return true;
    // 英文 keyword
    const EN = [
      "minimalist", "minimal", "flat", "glassmorphism", "glass morphism", "neumorphism",
      "skeuomorphism", "brutalism", "claymorphism", "bento", "memphis",
      "cyberpunk", "vaporwave", "synthwave", "retro", "vintage", "y2k",
      "dark mode", "light mode", "high contrast",
      "gradient", "neon", "metallic", "futuristic", "modern", "elegant", "luxury",
      "industrial", "swiss", "bauhaus", "editorial",
      // hex 色码（用户直接给颜色就算明确指定）
      "#"
    ];
    if (EN.some((k) => s.includes(k))) return true;
    return false;
  }

  // 把 currentSettings.chatProviders 渲染成可编辑卡片列表
  function renderChatProvidersList() {
    renderLocalModelGuideSlot();
    const wrap = els.chatProvidersList;
    if (!wrap) return;
    const expandedProviderIds = new Set(
      Array.from(wrap.querySelectorAll(".chat-provider-card.expanded"))
        .map((card) => card.dataset.providerId)
        .filter(Boolean)
    );
    wrap.innerHTML = "";
    (currentSettings.chatProviders || []).forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "chat-provider-card" + (p.enabled ? "" : " disabled");
      card.dataset.providerId = p.id;
      if (expandedProviderIds.has(p.id)) card.classList.add("expanded");
      const head = document.createElement("div");
      head.className = "chat-provider-card-head";
      head.innerHTML = `
        ${providerHealthDotHtml(p.id)}
        <span class="chat-provider-card-label">${escapeHtml(p.label || p.id)}</span>
        <span class="chat-provider-card-type">${escapeHtml(p.type)}</span>
        <label class="chat-provider-card-toggle">
          <input type="checkbox" data-role="toggle" ${p.enabled ? "checked" : ""}/>
          <span>启用</span>
        </label>
        <button type="button" class="card-action-btn" data-role="test" title="测试此供应商（拉取模型列表）" aria-label="测试">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </button>
        <span class="chat-provider-card-chev">▾</span>
      `;
      head.addEventListener("click", (ev) => {
        if (ev.target.closest('[data-role="toggle"], [data-role="test"]')) return;
        card.classList.toggle("expanded");
      });
      head.querySelector('[data-role="toggle"]').addEventListener("change", (ev) => {
        p.enabled = ev.target.checked;
        card.classList.toggle("disabled", !p.enabled);
        persistSettings();
        populateModelSelector(els.modelSelect?.value);
      });
      head.querySelector('[data-role="test"]').addEventListener("click", async (ev) => {
        ev.stopPropagation();
        applyChatProviderCardEdits(card, p);
        persistSettings();
        await testSpecificProvider(p);
      });
      card.appendChild(head);

      const body = document.createElement("div");
      body.className = "chat-provider-card-body";

      const cachedChatModels = modelsByProvider[p.id] || [];
      const chatModelsPicker = buildModelPickerHtml(cachedChatModels, p.defaultModel);
      const chatModelsHint = cachedChatModels.length
        ? `<small class="field-tip">从下拉选中即填进左侧输入框。可手动输入未列出的模型。</small>`
        : `<small class="field-tip">点右上角 ⚡ 测试供应商后，这里会出现"模型下拉"。</small>`;

      if (p.type === "codex") {
        // Codex 走 ChatGPT OAuth —— 直接在卡片内做完整的 4 步授权流，而不是依赖隐藏的 legacy UI
        renderCodexCardBody(body, p, cachedChatModels, chatModelsHint);
      } else if (p.type === "anthropic") {
        body.innerHTML = `
          <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://api.anthropic.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
          <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-ant-..." value="${escapeAttr(p.apiKey || "")}"/></label>
          <label class="field required"><span>默认模型</span>
            <div class="field-with-picker">
              <input type="text" data-field="defaultModel" placeholder="claude-sonnet-4-6" value="${escapeAttr(p.defaultModel || "")}"/>
              ${chatModelsPicker}
            </div>
            ${chatModelsHint}
          </label>
          <label class="field"><span>Anthropic Version</span><input type="text" data-field="anthropicVersion" placeholder="2023-06-01" value="${escapeAttr(p.anthropicVersion || "2023-06-01")}"/></label>
        `;
      } else {
        // openai 兼容 —— 同时覆盖 gemini / azure / openai-responses：都用 baseUrl + apiKey + 默认模型，
        // 仅占位提示按类型变；Azure 另加 api-version / 部署名两项。
        const phBase = p.type === "gemini" ? "https://generativelanguage.googleapis.com/v1beta"
          : p.type === "azure" ? "https://<resource>.openai.azure.com"
          : "https://api.openai.com/v1";
        const phKey = p.type === "gemini" ? "AIza..." : "sk-...";
        const phModel = p.type === "gemini" ? "gemini-2.5-flash"
          : p.type === "azure" ? "deployment name"
          : p.type === "openai-responses" ? "gpt-5.1"
          : "gpt-4o-mini";
        const azureExtra = p.type === "azure" ? `
          <label class="field required"><span>API Version</span><input type="text" data-field="apiVersion" placeholder="2024-10-21" value="${escapeAttr(p.apiVersion || "2024-10-21")}"/></label>
          <label class="field"><span>部署名（可选）</span><input type="text" data-field="deployment" placeholder="留空则用默认模型作部署名" value="${escapeAttr(p.deployment || "")}"/></label>
        ` : "";
        body.innerHTML = `
          <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
          <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="${phBase}" value="${escapeAttr(p.baseUrl || "")}"/></label>
          <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="${phKey}" value="${escapeAttr(p.apiKey || "")}"/></label>
          <label class="field required"><span>默认模型</span>
            <div class="field-with-picker">
              <input type="text" data-field="defaultModel" placeholder="${phModel}" value="${escapeAttr(p.defaultModel || "")}"/>
              ${chatModelsPicker}
            </div>
            ${chatModelsHint}
          </label>
          ${azureExtra}
        `;
      }

      // codex/anthropic/openai-official 是内置条目不让删；用户加的可以删
      const isBuiltin = ["codex", "anthropic", "openai-official"].includes(p.id);
      if (!isBuiltin) {
        const actions = document.createElement("div");
        actions.className = "chat-provider-card-actions";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => {
          if (!confirm(i18nT("确定删除 {name}？", { name: p.label || p.id }))) return;
          currentSettings.chatProviders.splice(idx, 1);
          persistSettings();
          renderChatProvidersList();
          populateModelSelector(els.modelSelect?.value);
        });
        actions.appendChild(delBtn);
        body.appendChild(actions);
      }

      // 输入变化实时写回内存（不立即 persist，避免每键击都写 localStorage）
      body.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("change", () => {
          applyChatProviderCardEdits(card, p);
          persistSettings();
        });
      });

      // 默认模型旁挂的"从已拉取模型选..."下拉：选中即填进 defaultModel input。
      body.querySelectorAll('[data-role="model-picker"]').forEach((picker) => {
        picker.addEventListener("change", (ev) => {
          const value = (ev.target.value || "").trim();
          if (!value) return;
          const input = picker.parentElement?.querySelector('input[data-field="defaultModel"]');
          if (input) {
            input.value = value;
            // 同步写回 entry + 持久化 + 刷新 header 下拉
            applyChatProviderCardEdits(card, p);
            persistSettings();
            populateModelSelector(els.modelSelect?.value);
          }
          ev.target.value = ""; // 重置回占位项，方便再次选
        });
      });

      card.appendChild(body);
      wrap.appendChild(card);
    });
  }

  // 把单张卡片的表单值写回 chatProviders 条目
  function applyChatProviderCardEdits(card, entry) {
    card.querySelectorAll("[data-field]").forEach((inp) => {
      const key = inp.dataset.field;
      if (inp.type === "checkbox") entry[key] = inp.checked;
      else entry[key] = inp.value.trim();
    });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function renderLocalModelGuideSlot() {
    if (!els.localModelGuideSlot) return;
    els.localModelGuideSlot.innerHTML = renderLocalModelGuideHtml();
  }

  // 本地模型选型建议 HTML —— 给 Ollama / LM Studio / vLLM 这类本地端点用。
  // 说明开源模型在 tool calling / 多模态两条插件强依赖的能力上的现实差距，
  // 帮用户避开"装上了但插件用不起来"的坑。
  function renderLocalModelGuideHtml() {
    return `
      <details class="local-model-guide">
        <summary>本地模型选型建议（务必看一眼）</summary>
        <div class="local-model-guide-body">
          <p class="muted" style="margin:6px 0 8px;">文小舟深度依赖<b>工具调用 (function calling)</b>来操作文档；图片识别 / 截图分析依赖<b>多模态 (vision)</b>。多数开源模型至少缺一项，挑错了"配上能聊天但用不了功能"。</p>

          <p style="margin:8px 0 4px;"><b>✓ 推荐配置（工具调用稳定，部分带视觉）</b></p>
          <ul style="margin:2px 0 8px 18px; padding:0; line-height:1.6;">
            <li><code>qwen2.5:7b-instruct</code> / <code>qwen2.5:14b-instruct</code> — 原生 function calling，中文好。<b>最低门槛首选</b>。</li>
            <li><code>qwen2.5:32b-instruct</code> — 工具调用质量最接近 GPT-4o-mini 的开源选项（需 24GB+ 显存）。</li>
            <li><code>llama3.1:8b</code> / <code>llama3.1:70b</code> — 原生 tools，英文更强。</li>
            <li><code>mistral-nemo:12b</code> / <code>mistral-small</code> — 原生 tools，速度好。</li>
            <li>视觉 + 工具：<code>qwen2.5-vl:7b</code>（截图理解 + 工具调用都有，推荐）、<code>llama3.2-vision:11b</code>（仅英文场景）。</li>
            <li>偏代码：<code>deepseek-coder-v2:16b</code>、<code>qwen2.5-coder:7b</code>。</li>
          </ul>

          <p style="margin:8px 0 4px;"><b>✗ 不建议（工具调用不稳定或不支持，插件多数功能用不了）</b></p>
          <ul style="margin:2px 0 8px 18px; padding:0; line-height:1.6;">
            <li><code>gemma2</code> / <code>gemma3</code> 全系 — Google 系列原生不带 function calling，靠模板模拟成功率低。</li>
            <li><code>phi-3</code> / <code>phi-3.5</code> — Microsoft 早期版本，tool 输出格式经常崩。</li>
            <li>任意 <b>≤3B 参数</b> 的模型 — 工具调用普遍不靠谱（含 qwen2.5:0.5b/1.5b/3b、llama3.2:1b/3b、phi3:mini）。</li>
            <li>任何 <b>非 instruct/chat 后缀</b> 的 base 模型（如 <code>llama3:8b-text</code>、<code>qwen:7b</code> 无后缀）— 没经过对话微调，根本不会调工具。</li>
            <li><code>codellama</code> / <code>starcoder2</code> — 纯代码补全模型，不调工具。</li>
            <li>纯文本模型 + 期望视觉：所有不带 <code>-vl</code> / <code>-vision</code> / <code>-v</code> 后缀的模型都不能识图，不要往里塞截图。</li>
          </ul>

          <p style="margin:8px 0 4px;"><b>常见组合 = 显存预算</b></p>
          <ul style="margin:2px 0 8px 18px; padding:0; line-height:1.6;">
            <li>6 GB 显存：<code>qwen2.5:7b-instruct-q4</code> 勉强够，能调工具但慢。</li>
            <li>12 GB 显存：<code>qwen2.5:14b-instruct-q4</code> 或 <code>qwen2.5-vl:7b</code>，是甜点档。</li>
            <li>24 GB+ 显存：<code>qwen2.5:32b</code> 或 <code>llama3.1:70b-q4</code>，质量最接近商用 API。</li>
            <li>纯 CPU / 集显：建议挂在线 API，本地跑 7B 也要十几秒/次。</li>
          </ul>

          <p class="muted" style="margin:8px 0 0;">拉模型：<code>ollama pull qwen2.5:7b-instruct</code>。Ollama 模型仓库：ollama.com/library。</p>
        </div>
      </details>
    `;
  }

  // ---- 预设供应商选单 ----
  function openPresetPicker() {
    const known = global.WpsAiProviderRegistry?.KNOWN_CHAT_PROVIDERS || [];
    els.presetPickerList.innerHTML = "";
    known.forEach((preset) => {
      const item = document.createElement("div");
      item.className = "preset-list-item";
      item.innerHTML = `
        <span class="preset-list-item-label">${escapeHtml(preset.label)}</span>
        <span class="preset-list-item-url">${escapeHtml(preset.baseUrl || "(OAuth)")}</span>
      `;
      item.addEventListener("click", () => addChatProviderFromPreset(preset));
      els.presetPickerList.appendChild(item);
    });
    els.presetPickerModal?.classList.remove("hidden");
  }
  function closePresetPicker() {
    els.presetPickerModal?.classList.add("hidden");
  }
  function addChatProviderFromPreset(preset) {
    // 生成不重名 id：如果列表里已经有同 id 的，追加 -2/-3/...
    let id = preset.id;
    const existing = new Set((currentSettings.chatProviders || []).map((p) => p.id));
    let counter = 2;
    while (existing.has(id)) id = `${preset.id}-${counter++}`;
    const entry = {
      id,
      type: preset.type,
      label: preset.label,
      enabled: true,
      baseUrl: preset.baseUrl || "",
      apiKey: "",
      defaultModel: preset.defaultModel || "",
      anthropicVersion: preset.anthropicVersion || "2023-06-01",
      useProxy: true
    };
    currentSettings.chatProviders = currentSettings.chatProviders || [];
    currentSettings.chatProviders.push(entry);
    persistSettings();
    closePresetPicker();
    renderChatProvidersList();
    // 自动展开新增的卡片，让用户填 API Key
    setTimeout(() => {
      const card = els.chatProvidersList.querySelector(`[data-provider-id="${CSS.escape(id)}"]`);
      if (card) card.classList.add("expanded");
    }, 0);
    populateModelSelector(els.modelSelect?.value);
  }

  // ---------------- Image providers (多渠道，互斥启用) ----------------

  // 把 currentSettings.imageProviders 渲染成卡片列表。复用 chat-provider-card 样式。
  // 启用一条会自动关闭其它条目 —— 同一时刻仅一条 enabled=true。
  function renderImageProvidersList() {
    const wrap = els.imageProvidersList;
    if (!wrap) return;
    const expandedImageProviderIds = new Set(
      Array.from(wrap.querySelectorAll(".chat-provider-card.expanded"))
        .map((card) => card.dataset.imageProviderId)
        .filter(Boolean)
    );
    wrap.innerHTML = "";
    const list = currentSettings.imageProviders || [];
    list.forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "chat-provider-card" + (p.enabled ? "" : " disabled");
      card.dataset.imageProviderId = p.id;
      if (expandedImageProviderIds.has(p.id)) card.classList.add("expanded");

      const head = document.createElement("div");
      head.className = "chat-provider-card-head";
      head.innerHTML = `
        <span class="chat-provider-card-label">${escapeHtml(p.label || p.id)}</span>
        <span class="chat-provider-card-type">${escapeHtml(p.type)}</span>
        <label class="chat-provider-card-toggle">
          <input type="checkbox" data-role="toggle" ${p.enabled ? "checked" : ""}/>
          <span>启用</span>
        </label>
        <button type="button" class="card-action-btn" data-role="test" title="${escapeAttr(p.type === "boogu" ? "测试连通性" : "测试此渠道（拉取模型列表）")}" aria-label="测试">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </button>
        <span class="chat-provider-card-chev">▾</span>
      `;
      head.addEventListener("click", (ev) => {
        if (ev.target.closest('[data-role="toggle"], [data-role="test"]')) return;
        card.classList.toggle("expanded");
      });
      head.querySelector('[data-role="toggle"]').addEventListener("change", (ev) => {
        const checked = ev.target.checked;
        // 互斥：开启此条时关闭其它；关闭则单纯关闭
        currentSettings.imageProviders.forEach((other) => {
          other.enabled = (other === p) ? checked : false;
        });
        persistSettings();
        renderImageProvidersList();
      });
      head.querySelector('[data-role="test"]').addEventListener("click", async (ev) => {
        ev.stopPropagation();
        applyImageProviderCardEdits(card, p);
        persistSettings();
        await testImageProviderEntry(p);
      });
      card.appendChild(head);

      const body = document.createElement("div");
      body.className = "chat-provider-card-body";
      body.innerHTML = renderImageProviderBody(p);

      // 内置 id（toapis / codex-bridge / openai / openrouter / boogu）不让删；用户加的可以删
      const isBuiltin = ["toapis", "codex-bridge", "openai", "openrouter", "boogu"].includes(p.id);
      if (!isBuiltin) {
        const actions = document.createElement("div");
        actions.className = "chat-provider-card-actions";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => {
          if (!confirm(i18nT("确定删除 {name}？", { name: p.label || p.id }))) return;
          currentSettings.imageProviders.splice(idx, 1);
          persistSettings();
          renderImageProvidersList();
        });
        actions.appendChild(delBtn);
        body.appendChild(actions);
      }

      body.querySelectorAll("input, select").forEach((inp) => {
        inp.addEventListener("change", () => {
          applyImageProviderCardEdits(card, p);
          persistSettings();
        });
      });

      // 模型旁挂的"从已拉取模型选..."下拉：选中即填进 model input
      body.querySelectorAll('[data-role="model-picker"]').forEach((picker) => {
        picker.addEventListener("change", (ev) => {
          const value = (ev.target.value || "").trim();
          if (!value) return;
          const input = picker.parentElement?.querySelector('input[data-field="model"]');
          if (input) {
            input.value = value;
            applyImageProviderCardEdits(card, p);
            persistSettings();
          }
          ev.target.value = "";
        });
      });

      card.appendChild(body);
      wrap.appendChild(card);
    });
  }

  function renderImageProviderBody(p) {
    const cachedImageModels = imageModelsByProvider[p.id] || [];
    const imageModelsPicker = buildModelPickerHtml(cachedImageModels, p.model);
    const imageModelsHint = cachedImageModels.length
      ? `<small class="field-tip">从下拉选中即填进左侧输入框。可手动输入未列出的模型。</small>`
      : `<small class="field-tip">点右上角 ⚡ 测试渠道后，这里会出现"模型下拉"。</small>`;

    if (p.type === "codex-bridge") {
      return `
        <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
        <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://your-sub2api.example.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
        <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-..." value="${escapeAttr(p.apiKey || "")}"/></label>
        <label class="field required"><span>模型</span>
          <div class="field-with-picker">
            <input type="text" data-field="model" placeholder="gpt-image-1" value="${escapeAttr(p.model || "")}"/>
            ${imageModelsPicker}
          </div>
          ${imageModelsHint}
        </label>
      `;
    }
    if (p.type === "openai") {
      return `
        <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
        <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://api.openai.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
        <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-..." value="${escapeAttr(p.apiKey || "")}"/></label>
        <label class="field required"><span>模型</span>
          <div class="field-with-picker">
            <input type="text" data-field="model" placeholder="gpt-image-1" value="${escapeAttr(p.model || "")}"/>
            ${imageModelsPicker}
          </div>
          ${imageModelsHint}
          <small class="field-tip">官方支持：gpt-image-1（推荐，需组织验证）/ dall-e-3 / dall-e-2。国内网络需保证 api.openai.com 可达。</small>
        </label>
      `;
    }
    if (p.type === "openrouter") {
      return `
        <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
        <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://openrouter.ai/api/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
        <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-or-..." value="${escapeAttr(p.apiKey || "")}"/></label>
        <label class="field required"><span>模型</span>
          <div class="field-with-picker">
            <input type="text" data-field="model" placeholder="google/gemini-2.5-flash-image" value="${escapeAttr(p.model || "")}"/>
            ${imageModelsPicker}
          </div>
          ${imageModelsHint}
          <small class="field-tip">需选支持图像输出的模型（如 google/gemini-2.5-flash-image）。生图走 chat 接口，比例由提示词控制，不支持 mask 涂抹。</small>
        </label>
      `;
    }
    if (p.type === "boogu") {
      const resOpts = [
        [768, "标清 768"], [1024, "1K 1024（推荐）"], [1280, "1080p 1280"], [1536, "2K 1536"], [2048, "超清 2048（慢/占显存）"]
      ];
      const curRes = Number(p.resolution) > 0 ? Number(p.resolution) : 1024;
      const resSelect = resOpts.map(([v, lbl]) => `<option value="${v}"${v === curRes ? " selected" : ""}>${escapeHtml(lbl)}</option>`).join("");
      return `
        <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
        <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="http://127.0.0.1:8000/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
        <label class="field"><span>默认分辨率</span><select data-field="resolution">${resSelect}</select></label>
        <label class="field"><span>推理步数</span><input type="number" data-field="steps" min="1" max="50" step="1" placeholder="4" value="${escapeAttr(p.steps != null ? String(p.steps) : "")}"/></label>
        <small class="field-tip">Boogu Image 本地服务（FastAPI），本地无需 API Key。默认分辨率决定图片整体大小（长边），生图时结合比例自动算出实际宽高并吸附到 512/768/1024/1280/1536/2048 档位；档位越大越慢、越占显存。Turbo 版推荐步数 4。<strong>该渠道只支持生成图片，不支持抠图 / 图像编辑</strong>。</small>
      `;
    }
    // toapis（默认）
    return `
      <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
      <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://toapis.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
      <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-..." value="${escapeAttr(p.apiKey || "")}"/></label>
      <label class="field required"><span>模型</span>
        <div class="field-with-picker">
          <input type="text" data-field="model" placeholder="gpt-image-2" value="${escapeAttr(p.model || "")}"/>
          ${imageModelsPicker}
        </div>
        ${imageModelsHint}
      </label>
    `;
  }

  function applyImageProviderCardEdits(card, entry) {
    card.querySelectorAll("[data-field]").forEach((inp) => {
      const key = inp.dataset.field;
      if (inp.type === "checkbox") entry[key] = inp.checked;
      else if (key === "resolution" || key === "steps") { // 数字字段存 number
        const n = Number(inp.value);
        if (Number.isFinite(n) && n > 0) entry[key] = n;
      } else entry[key] = (inp.value || "").trim();
    });
  }

  // 新增一条图像渠道。type 由用户选；id 自动去重。
  // 类型选项 —— 给 addImageProvider modal picker 用
  const IMAGE_PROVIDER_TYPES = [
    {
      type: "codex-bridge",
      label: "Codex 桥接 (sub2api)",
      desc: "OpenAI 兼容的同步图像 API（sub2api / 自建 reverse-proxy 之类）。返回 b64_json 直接落地。",
      defaults: { baseUrl: "", apiKey: "", model: "gpt-image-1", defaultSize: "1024x1024", useProxy: true }
    },
    {
      type: "toapis",
      label: "toapis.com (GPT-Image-2)",
      desc: "toapis.com 异步任务 API：创建任务 + 轮询。支持比例尺（1:1 / 16:9 等）与分辨率档（1K/2K/4K）。",
      defaults: { baseUrl: "https://toapis.com/v1", apiKey: "", model: "gpt-image-2", defaultSize: "1:1", defaultResolution: "1K", useProxy: true }
    },
    {
      type: "openai",
      label: "OpenAI 官方",
      desc: "api.openai.com 官方图像接口：gpt-image-1 / dall-e-3 / dall-e-2。需要 OpenAI 官方 API Key，且网络可达。",
      defaults: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-image-1", defaultSize: "1024x1024", useProxy: true }
    },
    {
      type: "openrouter",
      label: "OpenRouter",
      desc: "OpenRouter 聚合渠道：生图走 chat 接口（modalities:image），选支持图像输出的模型如 google/gemini-2.5-flash-image。",
      defaults: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "", model: "google/gemini-2.5-flash-image", useProxy: true }
    },
    {
      type: "boogu",
      label: "Boogu 本地生图",
      desc: "Boogu Image 本地 FastAPI 服务：OpenAI 风格 /images/generations，本地无需 API Key。只支持生成图片，不支持抠图 / 编辑。",
      defaults: { baseUrl: "http://127.0.0.1:8000/v1", apiKey: "", model: "", defaultSize: "1:1", resolution: 1024, steps: 4, useProxy: true }
    }
  ];

  function addImageProvider() {
    // 之前用 window.prompt() 取类型，但 WPS WebView 对 native prompt 支持不稳定（很多版本直接静默不弹），
    // 改成 modal picker。复用聊天供应商的 .modal-overlay / .modal-card 样式。
    openImageProviderTypePicker((preset) => {
      const existing = new Set((currentSettings.imageProviders || []).map((p) => p.id));
      let id = preset.type;
      let n = 2;
      while (existing.has(id)) id = `${preset.type}-${n++}`;
      const labelN = n > 2 ? ` #${n - 1}` : "";
      const entry = Object.assign(
        { id, type: preset.type, label: preset.label + labelN, enabled: false },
        preset.defaults
      );
      currentSettings.imageProviders = currentSettings.imageProviders || [];
      currentSettings.imageProviders.push(entry);
      persistSettings();
      renderImageProvidersList();
      // 自动展开新卡，方便填 API Key
      setTimeout(() => {
        const card = els.imageProvidersList.querySelector(`[data-image-provider-id="${CSS.escape(id)}"]`);
        if (card) card.classList.add("expanded");
      }, 0);
    });
  }

  // 临时 modal —— 选图像渠道类型。完成后回调 onPick(preset)；用户取消直接关闭无操作。
  function openImageProviderTypePicker(onPick) {
    // 旧实例若没关掉，先清理
    const oldOverlay = document.getElementById("__lingxi_image_type_picker__");
    if (oldOverlay) try { oldOverlay.remove(); } catch (e) {}

    const overlay = document.createElement("div");
    overlay.id = "__lingxi_image_type_picker__";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h3>新增图像生成渠道</h3>
          <button class="modal-close" type="button" data-act="close" title="关闭">×</button>
        </div>
        <div class="modal-body">
          <p class="muted" style="margin:0 0 10px">挑一种渠道协议；之后可以在卡片里编辑 baseUrl / apiKey。</p>
          <div class="preset-list" data-role="list"></div>
        </div>
      </div>
    `;
    const listHost = overlay.querySelector('[data-role="list"]');
    IMAGE_PROVIDER_TYPES.forEach((preset) => {
      const item = document.createElement("div");
      item.className = "preset-list-item";
      item.innerHTML = `
        <span class="preset-list-item-label">${escapeHtml(preset.label)}</span>
        <span class="preset-list-item-url">${escapeHtml(preset.desc)}</span>
      `;
      item.addEventListener("click", () => {
        try { onPick?.(preset); } catch (e) {}
        try { overlay.remove(); } catch (e) {}
      });
      listHost.appendChild(item);
    });
    const close = () => { try { overlay.remove(); } catch (e) {} };
    overlay.querySelector('[data-act="close"]').addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  // 直接对某条 entry 做连通测试（GET /models 探活，跟 chatProvider 测试同套路）
  async function fetchImageModelsWithProxyMode(entry, useProxy) {
    const PROXY_PREFIX = global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/";
    const base = String(entry.baseUrl).replace(/\/+$/, "");
    const targetBase = useProxy ? PROXY_PREFIX + encodeURIComponent(base) : base;
    return fetch(`${targetBase}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${entry.apiKey}` }
    });
  }

  async function fetchImageModelsAutoProxy(entry) {
    let proxyError = null;
    try {
      return { resp: await fetchImageModelsWithProxyMode(entry, true), useProxy: true };
    } catch (error) {
      proxyError = error;
    }
    try {
      return { resp: await fetchImageModelsWithProxyMode(entry, false), useProxy: false };
    } catch (directError) {
      directError.proxyError = proxyError;
      throw directError;
    }
  }

  // Boogu 等本地生图服务没有 /models，连通性单独测：探 /health（README 的健康检查端点）。
  // baseUrl 形如 http://127.0.0.1:8000/v1 —— /health 在根路径，需去掉尾部 /v1。
  async function testBooguConnectivity(entry) {
    const t = global.WpsAiI18n?.t || ((s) => s);
    const name = entry.label || entry.id;
    const root = String(entry.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (!root) { showMessage(t("「{name}」缺少 Base URL。", { name }), "error"); return; }
    setBusy(true);
    showMessage(t("正在测试「{name}」连通性…", { name }), "info");
    // 依次尝试：走代理 → 直连（本地服务直连通常也行）
    const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
    const forward = (u) => base + "/forward/" + encodeURIComponent(u);
    const targets = [forward(root + "/health"), root + "/health"];
    try {
      let lastErr = null;
      for (const url of targets) {
        try {
          const resp = await fetch(url, { method: "GET" });
          if (resp.ok) {
            const j = await resp.json().catch(() => ({}));
            const dev = j && j.device ? `（${j.device}）` : "";
            showMessage(t("「{name}」连通正常，服务已就绪{dev}。", { name, dev }), "success", { duration: 6000 });
            return;
          }
          lastErr = new Error("HTTP " + resp.status);
        } catch (e) { lastErr = e; }
      }
      // 全失败 → 给指向性诊断（端口占用 / 服务未启动是本地服务最常见根因）
      showMessage(
        t("「{name}」连不上（{err}）。请确认：① Boogu 服务已启动（start_api.ps1，窗口显示 Uvicorn running）；② Base URL 端口正确且未被其它程序占用。", { name, err: lastErr?.message || lastErr }),
        "error", { duration: 12000 }
      );
    } finally {
      setBusy(false);
    }
  }

  async function testImageProviderEntry(entry) {
    // Boogu 本地生图：无 /models、无 API Key，连通性走 /health 单独测
    if (entry.type === "boogu") return testBooguConnectivity(entry);
    if (!entry.baseUrl || !entry.apiKey) {
      showMessage(`「${entry.label || entry.id}」缺少 Base URL 或 API Key。`, "error");
      return;
    }
    setBusy(true);
    showMessage(`正在测试「${entry.label || entry.id}」...`, "info");
    try {
      const tested = await fetchImageModelsAutoProxy(entry);
      const resp = tested.resp;
      entry.useProxy = tested.useProxy;
      persistSettings();
      if (resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        const modelIds = (global.WpsAiModelFilters?.filterImageModels?.(payload) || [])
          .filter((id) => typeof id === "string" && id);
        // 把模型列表缓存起来，重新渲染卡片让"模型"输入框的下拉同步
        if (modelIds.length) {
          imageModelsByProvider[entry.id] = modelIds;
          persistImageModelsCache();
          try { renderImageProvidersList(); } catch (e) {}
        }
        const hit = modelIds.includes(entry.model);
        const preview = modelIds.slice(0, 5).join(" / ") + (modelIds.length > 5 ? ` … (+${modelIds.length - 5})` : "");
        if (hit) {
          showMessage(`「${entry.label || entry.id}」连通正常，模型「${entry.model}」存在；共 ${modelIds.length} 个模型，「模型」输入框可下拉选。`, "success", { duration: 6000 });
        } else if (modelIds.length) {
          showMessage(`「${entry.label || entry.id}」连通正常，列表里没找到「${entry.model}」。返回 ${modelIds.length} 个模型：${preview}。点「模型」输入框可下拉选。`, "info", { duration: 8000 });
        } else {
          showMessage(`「${entry.label || entry.id}」连通正常，但 /models 返回空列表。配置仍可保存。`, "info", { duration: 6000 });
        }
      } else if (resp.status === 401) {
        showMessage(`「${entry.label || entry.id}」认证失败（401）。请检查 API Key。`, "error");
      } else if (resp.status === 404 || resp.status === 405) {
        showMessage(`「${entry.label || entry.id}」未暴露 /models（HTTP ${resp.status}），通常是图像专用服务，可保存后直接试用。`, "info", { duration: 6000 });
      } else {
        const payload = await resp.json().catch(() => ({}));
        showMessage(`「${entry.label || entry.id}」测试失败（${resp.status}）：${payload.error?.message || "未知错误"}`, "error");
      }
    } catch (error) {
      showMessage(`「${entry.label || entry.id}」测试失败：${error.message || error}`, "error");
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Host detection + quick actions ----------------

  const QUICK_ACTIONS = (window.WpsAiQuickActions && window.WpsAiQuickActions.QUICK_ACTIONS) || {};

  // 旧对话回填：新版给快捷指令加了 quickAction 元数据（回放折叠成操作盒子），但旧对话
  // 的存储事件里没有这字段。用「固定提示词 → 按钮文字」反查表补救——只收录不含占位符
  // （[...] / {{...}}）的固定 prompt，用户手打出一模一样内部指令的概率极低，误判风险可控。
  const _fixedPromptToLabel = (() => {
    const map = new Map();
    for (const host in QUICK_ACTIONS) {
      for (const a of QUICK_ACTIONS[host] || []) {
        if (!a || !a.prompt || !a.label) continue;
        if (/\[|\{\{/.test(a.prompt)) continue; // 含占位符/填空 → 合成后文本不定，无法反查
        if (!map.has(a.prompt)) map.set(a.prompt, a.label);
      }
    }
    return map;
  })();
  // 回放一条 user 消息时推断它是否快捷指令：优先用存储的 quickAction.label，
  // 旧记录无该字段则按固定提示词反查。返回 label 或 ""。
  function inferQuickActionLabel(quickAction, text) {
    const label = quickAction && quickAction.label ? String(quickAction.label).trim() : "";
    if (label) return label;
    const t = String(text || "").trim();
    return t && _fixedPromptToLabel.has(t) ? _fixedPromptToLabel.get(t) : "";
  }

  const HOST_TITLES = {
    wps: {
      title: "WPS 文字 助手",
      hint: "对话让 AI 读写文档；顶部 ribbon 写作 / 润色 / 翻译 / 文档 / 图像 6 组快捷入口"
    },
    et: {
      title: "WPS 表格 助手",
      hint: "对话让 AI 读写单元格、行列、工作表；顶部 ribbon 美化 / 数据 / 智能 3 组快捷入口"
    },
    wpp: {
      title: "WPS 演示 助手",
      hint: "对话让 AI 读写幻灯片；顶部 ribbon 生成 / 改写 / 校对 4 组快捷入口；「PPT 风格」按钮设置统一样式，「大纲生成 PPT」打开大纲弹窗"
    },
    pdf: {
      title: "WPS PDF 助手",
      hint: "对话让 AI 阅读当前 PDF；顶部 ribbon 提供对照翻译 / 全文总结 / PDF 问答 / 智能推荐"
    },
    unknown: {
      title: "AI 助手",
      hint: "未识别到 WPS 宿主，请在 WPS 文字 / 表格 / 演示 / PDF 中打开本插件"
    }
  };

  function renderQuickActions() {
    // 静态快捷指令已搬到顶部 ribbon 顶层按钮组，面板内不再重复渲染 chip。
    // 仍负责更新 AI Tab 的标题/副标题（宿主 + 操作模式）。
    // 标题/提示是 JS 拼接的组合串，自动翻译精确匹配不到，必须在源头 t()。
    const host = currentHostInfo?.host || "unknown";
    const meta = HOST_TITLES[host] || HOST_TITLES.unknown;
    const t = global.WpsAiI18n?.t || ((s) => s);
    // 标题/副标题栏已移除（省空间），元素可能不存在——赋值前判空
    if (els.aiPanelTitle) els.aiPanelTitle.textContent = t(meta.title);
    const modeText = currentSettings?.operationMode === "direct" ? t("直接操作wps") : t("预览确认");
    if (els.aiPanelHint) els.aiPanelHint.textContent = `${t(meta.hint)} · ${t("当前模式")}：${modeText}`;
  }

  // ---- AI 推荐操作（由 suggest_quick_actions 工具调用动态渲染） ----

  function renderSuggestedActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) {
      hideSuggestedActions();
      return;
    }
    els.suggestedActionsList.innerHTML = "";
    actions.forEach((act) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-action-chip suggested-chip";
      btn.textContent = act.label;
      btn.title = act.prompt;
      btn.addEventListener("click", () => {
        // 修 B10：用真正的忙碌标志守卫，避免本轮进行中并发启动第二轮。
        if (chatBusy) return;
        // AI 推荐操作也是固定模板提示词，同样折叠成操作盒子
        runChatTurn(act.prompt, act.label ? { quickAction: { label: act.label } } : {});
      });
      els.suggestedActionsList.appendChild(btn);
    });
    els.suggestedActions.classList.remove("hidden");
  }

  function hideSuggestedActions() {
    els.suggestedActions.classList.add("hidden");
    els.suggestedActionsList.innerHTML = "";
  }

  async function detectHost() {
    try {
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
    } catch (error) {
      currentHostInfo = { host: "unknown", label: "未知宿主" };
    }
    // Windows WPS 12.1 may place the WebView behind its ribbon: the first
    // ~103px of the viewport are present in layout but not actually painted.
    // Reserve that space only for the native, docked task pane.
    const isNativeWindowsPane = /Win/i.test(navigator.platform || "")
      && ["wps", "et", "wpp", "pdf"].includes(currentHostInfo.host)
      && !(new URLSearchParams(window.location.search).get("pane") === "dialog")
      && !window.location.search.includes("mode=");
    document.documentElement.classList.toggle("wps-docked-pane-inset", isNativeWindowsPane);
    renderQuickActions();
    renderProviderState();
    // 模板画廊只对 PPT 有意义（HTML 幻灯片模板）—— Word/Excel/PDF 下隐藏入口，避免误导。
    // 现在画廊入口在输入框上方独立行，把整行 (chatContextActions) 一起 toggle，
    // 避免容器空着还占一行高度
    const isWpp = currentHostInfo.host === "wpp";
    if (els.chatHtmlGalleryBtn) {
      els.chatHtmlGalleryBtn.classList.toggle("hidden", !isWpp);
    }
    if (els.chatContextActions) {
      els.chatContextActions.classList.toggle("hidden", !isWpp);
    }
    // 修订模式开关只在 WPS 文字显示（表格/演示无原生修订）
    if (els.reviseModeBar) {
      const isWps = currentHostInfo.host === "wps";
      els.reviseModeBar.classList.toggle("hidden", !isWps);
      if (isWps && els.reviseModeToggle) els.reviseModeToggle.checked = !!currentSettings?.reviseMode;
      updateReviseActions(); // 无论什么 host 都调：非 wps / 未开时会隐藏按钮并停掉轮询
    }
  }

  // ---------------- Chat (Tool Use) ----------------

  const chatHistory = [];

  // 跨模型安全边界：出站历史剥掉供应商特有的工具结构/角色，逻辑在 js/chat/history-sanitize.js
  // （详见该模块注释）。这里留个薄封装 + 兜底，防模块未加载时崩。
  function sanitizeHistoryForModel(history) {
    if (global.WpsAiChatHistory?.sanitizeForModel) {
      return global.WpsAiChatHistory.sanitizeForModel(history);
    }
    const ALLOWED = new Set(["user", "assistant", "system"]);
    return (history || [])
      .filter((m) => m && typeof m === "object" && ALLOWED.has(m.role))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  // 仅取最近的文字对话，避免旧附件或整篇文档进入技能总结请求。
  function buildSkillSummaryHistory(history) {
    const out = [];
    let budget = 18000;
    for (let i = (history || []).length - 1; i >= 0 && budget > 0 && out.length < 20; i -= 1) {
      const msg = history[i];
      if (!msg || !["user", "assistant"].includes(msg.role)) continue;
      let content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content)
        ? msg.content.filter((part) => part && part.type === "text").map((part) => part.text || "").join("\n") : "";
      if (!content) continue;
      const limit = Math.min(3000, budget);
      if (content.length > limit) content = content.slice(0, limit) + "…[已截断]";
      budget -= content.length;
      out.unshift({ role: msg.role, content });
    }
    return out;
  }

  function buildSkillOperationSummary(events) {
    const allowed = new Set(["font", "fontName", "fontSize", "size", "bold", "italic", "color", "alignment", "lineSpacing", "lineSpacingRule", "spaceBefore", "spaceAfter", "firstLineIndent", "leftIndent", "rightIndent", "style", "scope", "level"]);
    const pending = new Map();
    const completed = [];
    for (const event of (events || []).slice(-100)) {
      if (event?.type === "tool_call" && typeof event.name === "string") {
        const params = {};
        if (event.args && typeof event.args === "object" && !Array.isArray(event.args)) {
          for (const [key, value] of Object.entries(event.args)) {
            if (allowed.has(key) && (typeof value === "number" || typeof value === "boolean" || typeof value === "string" && value.length <= 100)) params[key] = value;
          }
        }
        const queue = pending.get(event.name) || [];
        queue.push({ name: event.name.slice(0, 100), params });
        pending.set(event.name, queue);
      } else if (event?.type === "tool_result") {
        const call = pending.get(event.name)?.shift();
        if (call && event.result?.ok === true) completed.push(call);
      }
    }
    return JSON.stringify(completed.slice(-30));
  }

  function isFormatSkillRequest(input) {
    const text = String(input || "");
    return /技能|skill/i.test(text) && /格式|样式|排版/.test(text) && /创建|生成|制作|总结|提取|学习|保存|沉淀|做成|变成/i.test(text);
  }

  function skillSummaryApprover(approver, allowFormatSample = false) {
    return async (call) => {
      if (call?.name !== "save_skill" && !(allowFormatSample && call?.name === "wps_sample_document_formatting")) return { approved: false, reason: "本轮只允许格式采样和保存技能，不能执行其他文档操作。" };
      return approver ? approver(call) : { approved: true };
    };
  }

  // 复用：图标按钮 SVG 字符串
  const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg>';
  const ICON_REFILL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4 9 9l-3-3-3 3"/><path d="M14 4h-4M14 4v4"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 5"/></svg>';

  const TODO_STATUS_LABELS = {
    pending: "待处理",
    in_progress: "进行中",
    completed: "已完成",
    failed: "失败",
    skipped: "已跳过"
  };

  function isLikelyLongTask(input) {
    const text = typeof input === "string" ? input : JSON.stringify(input || "");
    const normalized = text.replace(/\s+/g, "");
    if (normalized.length > 1200) return true;
    const hits = [
      "全文", "整篇", "长文", "分章节", "逐段", "多处修改", "批量",
      "润色", "扩写", "改写", "调整结构", "检查错别字", "通篇", "全部页面",
      "整套", "生成PPT", "生成演示文稿"
    ].filter((kw) => normalized.includes(kw)).length;
    return hits >= 2 || /(\d+)\s*(页|段|章|处|张|个)/.test(text);
  }

  // 长文改写意图：范围词（全文/通篇…）+ 动作词（改写/润色…）同时命中。
  // 命中后走长文改写流水线（只生成预览，不落笔——落笔由预览弹窗双模式决定）。
  function detectLongRewriteIntent(text) {
    const s = String(text || "").replace(/\s+/g, "");
    const scope = /(全文|通篇|整篇|全篇|逐段|各章节|整个文档)/.test(s);
    const act = /(改写|润色|扩写|精简|缩写|重写|调整结构|重新组织|统一语气|统一术语)/.test(s);
    return scope && act;
  }

  function ensureTodoPanel() {
    let panel = document.getElementById("chatTodoPanel");
    if (panel) return panel;
    const streamWrap = els.chatStream?.closest(".chat-stream-wrap");
    if (!streamWrap) return null;
    panel = document.createElement("div");
    panel.id = "chatTodoPanel";
    panel.className = "chat-todo-panel hidden";
    streamWrap.parentElement?.insertBefore(panel, streamWrap);
    return panel;
  }

  // 任务进度面板折叠状态：跨渲染保持，best-effort 持久化（纯显示偏好，丢了无伤）
  let _todoPanelCollapsed = (() => {
    // 默认折叠任务清单；用户手动展开/折叠后按存储的偏好走（"0"=展开 / "1"=折叠）
    try {
      const v = global.localStorage.getItem("lingxi_todo_panel_collapsed");
      return v === null ? true : v === "1";
    } catch (e) { return true; }
  })();

  function renderTodoPanel() {
    const panel = ensureTodoPanel();
    if (!panel) return;
    const state = global.WpsAiConversations?.getConversationTodos?.();
    const todos = Array.isArray(state?.todos) ? state.todos : [];
    if (!todos.length) {
      panel.classList.add("hidden");
      panel.innerHTML = "";
      return;
    }
    const done = todos.filter((t) => ["completed", "skipped"].includes(t.status)).length;
    const total = todos.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    panel.classList.remove("hidden");
    panel.classList.toggle("collapsed", _todoPanelCollapsed);
    // 头部可点折叠：收起时保留标题/进度条/计数，只藏清单。
    // 头部用原生 <button>（mac WKWebView 对 div 的 click 不可靠）。
    panel.innerHTML = `
      <button type="button" class="chat-todo-head" title="展开/收起任务清单">
        <span class="chat-todo-chevron" aria-hidden="true">${_todoPanelCollapsed ? "▸" : "▾"}</span>
        <div class="chat-todo-title">任务进度</div>
        <div class="chat-todo-count">${done}/${total}</div>
      </button>
      <div class="chat-todo-bar"><div class="chat-todo-bar-inner" style="width:${pct}%"></div></div>
      <div class="chat-todo-list">
        ${todos.map((t) => {
          const status = TODO_STATUS_LABELS[t.status] || TODO_STATUS_LABELS.pending;
          return `
            <div class="chat-todo-item ${t.status || "pending"}">
              <span class="chat-todo-dot" aria-hidden="true"></span>
              <span class="chat-todo-text" title="${escapeHtmlSafe(t.title || "")}">${escapeHtmlSafe(t.title || "")}</span>
              <span class="chat-todo-status">${status}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
    const head = panel.querySelector(".chat-todo-head");
    if (head) {
      // pointerup 主路 + click 兜底（双触发去重），同模型下拉的 mac 兼容方案
      let handledAt = 0;
      const toggle = (ev) => {
        const now = Date.now();
        if (now - handledAt < 400) return;
        handledAt = now;
        ev.stopPropagation();
        _todoPanelCollapsed = !_todoPanelCollapsed;
        try { global.localStorage.setItem("lingxi_todo_panel_collapsed", _todoPanelCollapsed ? "1" : "0"); } catch (e) {}
        panel.classList.toggle("collapsed", _todoPanelCollapsed);
        const chev = head.querySelector(".chat-todo-chevron");
        if (chev) chev.textContent = _todoPanelCollapsed ? "▸" : "▾";
      };
      head.addEventListener("pointerup", toggle);
      head.addEventListener("click", toggle);
    }
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallthrough to execCommand */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function pasteClipboardIntoInput(target, { emptyMessage = "剪贴板没有可粘贴的文本。", failMessage = "粘贴失败，请检查剪贴板权限。" } = {}) {
    if (!target) return false;
    try { target.focus?.(); } catch (error) {}
    try {
      let text = "";
      if (global.WpsAiClipboard?.readText) {
        text = await global.WpsAiClipboard.readText();
      } else if (global.WpsAiClipboard?.pasteInto) {
        const ok = await global.WpsAiClipboard.pasteInto(target);
        if (ok) return true;
      }
      if (!text) {
        text = await readNavigatorClipboardTextWithTimeout();
      }
      if (!text) {
        const proxyResult = await readClipboardTextViaProxy();
        if (proxyResult.ok) text = proxyResult.text;
      }
      if (!text) {
        showMessage(emptyMessage, "info");
        return false;
      }
      if (handleChatPastedText(target, text)) return true;
      const inserted = global.WpsAiEditShortcuts?.insertTextAtCursor
        ? global.WpsAiEditShortcuts.insertTextAtCursor(target, text)
        : (insertAtCursor(target, text), true);
      if (!inserted) return false;
      return true;
    } catch (error) {
      try {
        const text = await readNavigatorClipboardTextWithTimeout();
        if (text) {
          if (handleChatPastedText(target, text)) return true;
          insertAtCursor(target, text);
          return true;
        }
      } catch (fallbackError) {}
      showMessage(`${failMessage}${error?.message ? `：${error.message}` : ""}`, "error");
      return false;
    }
  }

  let activeEditableContextMenu = null;

  function getEditableSelectionSnapshot(target) {
    if (!target || typeof target.selectionStart !== "number") return null;
    return {
      start: target.selectionStart,
      end: typeof target.selectionEnd === "number" ? target.selectionEnd : target.selectionStart
    };
  }

  function restoreEditableSelection(target, snapshot) {
    if (!target) return;
    try { target.focus?.(); } catch (error) {}
    if (!snapshot) return;
    try {
      target.selectionStart = snapshot.start;
      target.selectionEnd = snapshot.end;
    } catch (error) {}
  }

  function closeEditableContextMenu() {
    const state = activeEditableContextMenu;
    if (!state) return;
    activeEditableContextMenu = null;
    try { state.cleanup?.(); } catch (error) {}
    try { state.menu?.parentNode?.removeChild(state.menu); } catch (error) {}
  }

  function showEditableContextMenu(target, ev) {
    if (!target) return;
    closeEditableContextMenu();
    const doc = target.ownerDocument || document;
    const win = doc.defaultView || window;
    const snapshot = getEditableSelectionSnapshot(target);
    const selectedText = global.WpsAiEditShortcuts?.getSelectedText
      ? global.WpsAiEditShortcuts.getSelectedText(target)
      : "";
    const canModify = target.readOnly !== true && target.disabled !== true;
    const menu = doc.createElement("div");
    menu.className = "editable-context-menu";
    menu.setAttribute("role", "menu");

    const addItem = (label, action, disabled = false) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.textContent = label;
      btn.disabled = !!disabled;
      btn.addEventListener("click", async (clickEv) => {
        clickEv.preventDefault();
        clickEv.stopPropagation();
        closeEditableContextMenu();
        restoreEditableSelection(target, snapshot);
        try { await action(); } catch (error) {}
      });
      menu.appendChild(btn);
      return btn;
    };

    addItem("复制", async () => {
      if (global.WpsAiEditShortcuts?.copySelectionToClipboard) {
        await global.WpsAiEditShortcuts.copySelectionToClipboard(target, copyToClipboard);
      }
    }, !selectedText);
    addItem("剪切", async () => {
      if (global.WpsAiEditShortcuts?.cutSelectionToClipboard) {
        await global.WpsAiEditShortcuts.cutSelectionToClipboard(target, copyToClipboard);
      }
    }, !canModify || !selectedText);
    addItem("全选", async () => {
      if (global.WpsAiEditShortcuts?.selectAllText) global.WpsAiEditShortcuts.selectAllText(target);
      else target.select?.();
    });

    menu.addEventListener("mousedown", (menuEv) => menuEv.stopPropagation());
    menu.addEventListener("contextmenu", (menuEv) => {
      menuEv.preventDefault();
      menuEv.stopPropagation();
    });
    doc.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const vw = win.innerWidth || doc.documentElement?.clientWidth || 320;
    const vh = win.innerHeight || doc.documentElement?.clientHeight || 240;
    const rawX = typeof ev.clientX === "number" ? ev.clientX : 12;
    const rawY = typeof ev.clientY === "number" ? ev.clientY : 12;
    const x = Math.max(6, Math.min(rawX, vw - rect.width - 6));
    const y = Math.max(6, Math.min(rawY, vh - rect.height - 6));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const cleanupFns = [];
    const cleanup = () => {
      while (cleanupFns.length) {
        const fn = cleanupFns.pop();
        try { fn(); } catch (error) {}
      }
    };
    const closeOnPointer = (pointerEv) => {
      if (menu.contains(pointerEv.target)) return;
      closeEditableContextMenu();
    };
    const closeOnKey = (keyEv) => {
      if (keyEv.key === "Escape") closeEditableContextMenu();
    };
    const closeOnBlur = () => closeEditableContextMenu();
    setTimeout(() => {
      if (activeEditableContextMenu?.menu !== menu) return;
      doc.addEventListener("mousedown", closeOnPointer, true);
      doc.addEventListener("keydown", closeOnKey, true);
      win.addEventListener("blur", closeOnBlur);
      win.addEventListener("resize", closeOnBlur);
      cleanupFns.push(() => doc.removeEventListener("mousedown", closeOnPointer, true));
      cleanupFns.push(() => doc.removeEventListener("keydown", closeOnKey, true));
      cleanupFns.push(() => win.removeEventListener("blur", closeOnBlur));
      cleanupFns.push(() => win.removeEventListener("resize", closeOnBlur));
    }, 0);

    activeEditableContextMenu = { menu, cleanup };
  }

  function installChatInputContextMenu(target) {
    if (!target || target.__lingxiContextMenuInstalled) return;
    target.__lingxiContextMenuInstalled = true;
    target.addEventListener("contextmenu", (ev) => {
      const shouldUseCustomMenu = global.WpsAiEditShortcuts?.shouldUseCustomEditableContextMenu
        ? global.WpsAiEditShortcuts.shouldUseCustomEditableContextMenu(ev, document.activeElement)
        : true;
      if (!shouldUseCustomMenu) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      try { target.focus?.(); } catch (error) {}
      showEditableContextMenu(target, ev);
    }, true);
  }

  // 用户消息气泡内「复制这条 / 填回输入框」——事件委托挂在 chatStream 上，覆盖当前与后续所有消息。
  // 消息原始文本存在 .tl-user 的 data-msg-text 上（timeline.js 渲染时写入）。
  function bindUserMessageActions() {
    const stream = els.chatStream || $("chatStream");
    if (!stream || stream.__lingxiUserActBound) return;
    stream.__lingxiUserActBound = true;
    stream.addEventListener("click", async (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest(".tl-user-act") : null;
      if (!btn) return;
      const msg = btn.closest(".tl-user");
      const text = msg ? (msg.getAttribute("data-msg-text") || "") : "";
      if (!text) return;
      const act = btn.getAttribute("data-user-act");
      if (act === "copy") {
        try { await copyToClipboard(text); showMessage("已复制这条消息。", "success"); }
        catch (e) { showMessage("复制失败：" + (e?.message || e), "error"); }
      } else if (act === "refill") {
        const inp = els.chatInput || $("chatInput");
        if (inp) {
          inp.value = text;
          try { inp.focus(); inp.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
        }
      }
    });
  }

  function installStartupPasteGuards() {
    if (!els.chatInput) els.chatInput = $("chatInput");
    installWpsFocusRelease();
    installChatInputContextMenu(els.chatInput);
    bindUserMessageActions();
  }

  function makeActionBtn(icon, title, handler) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-action-btn";
    btn.title = title;
    btn.innerHTML = icon;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      handler(btn);
    });
    return btn;
  }

  function flashCopied(btn) {
    const oldHtml = btn.innerHTML;
    btn.innerHTML = ICON_CHECK;
    btn.classList.add("copied");
    setTimeout(() => {
      btn.innerHTML = oldHtml;
      btn.classList.remove("copied");
    }, 900);
  }

  // 微信式聊天头像：AI = 紫底 ✨ / 我 = 蓝底"我"字。
  // 仅给 user/assistant 角色挂；tool / thinking 等系统气泡不挂（系统消息不算"谁说的"）。
  function makeAvatarEl(role) {
    const a = document.createElement("div");
    a.className = `chat-msg-avatar chat-msg-avatar-${role}`;
    if (role === "user") {
      a.textContent = "我";
    } else {
      // AI：feather sparkles 线性图标，stroke=white
      a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>';
    }
    a.setAttribute("aria-hidden", "true");
    return a;
  }

  function appendChatMsg(role, text, opts = {}) {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}${opts.kind ? " " + opts.kind : ""}`;

    // 头像（仅 user / assistant，且非 tool）。CSS 用 ::before 也行，但 SVG 要 inline 所以走 DOM
    if (role === "user" || role === "assistant") {
      div.appendChild(makeAvatarEl(role));
    }

    // 头部行：左侧标签 + 右侧动作图标（hover 显示）
    // 注：user / assistant 已经有圆头像表达"谁说的"，文字 "我"/"AI" 标签就重复了 —— 跳过。
    // 其它情况（tool / err / 系统消息）的 label 还是显示，那种不是用户角色的标记。
    const header = document.createElement("div");
    header.className = "chat-msg-header";
    const skipRoleLabel = (role === "user" || role === "assistant")
      && (opts.label === "我" || opts.label === "AI");
    if (opts.label && !skipRoleLabel) {
      const labelEl = document.createElement("span");
      labelEl.className = "chat-msg-label";
      labelEl.textContent = opts.label;
      header.appendChild(labelEl);
    }

    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";

    if (role === "user") {
      actions.appendChild(makeActionBtn(ICON_COPY, "复制", async (btn) => {
        const ok = await copyToClipboard(div.dataset.copyText || "");
        if (ok) flashCopied(btn);
      }));
      actions.appendChild(makeActionBtn(ICON_REFILL, "回填到输入框", () => {
        if (els.chatInput) {
          els.chatInput.value = div.dataset.copyText || "";
          els.chatInput.focus();
        }
      }));
    } else if (role === "assistant" && opts.kind !== "err") {
      actions.appendChild(makeActionBtn(ICON_COPY, "复制", async (btn) => {
        const ok = await copyToClipboard(div.dataset.copyText || "");
        if (ok) flashCopied(btn);
      }));
    }

    header.appendChild(actions);
    div.appendChild(header);

    // 内容主体（独立一行，块级）
    const body = document.createElement("div");
    body.className = "chat-msg-body";
    if (opts.html) {
      body.innerHTML = opts.html;
    } else {
      body.textContent = text;
    }
    div.appendChild(body);

    // 把可复制的纯文本存到 dataset；流式气泡后续会更新这个值
    div.dataset.copyText = opts.copyText != null ? opts.copyText : (text || "");

    els.chatStream.appendChild(div);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
    return div;
  }

  // 从 assistant 输出里剥离 <think>...</think>（部分开源思考模型会内联进正文，
  // 我们的 provider 层没有映射到独立的 reasoning event 时会这样露出来）。
  // 尾部未闭合的 <think> 也算 —— 流式过程中常见到刚吐出一半。
  // 返回 { visible: 面向用户的正文, think: 思考内容（多段用 \n\n 分隔） }
  function splitVisibleAndThinking(text) {
    if (!text) return { visible: "", think: "" };
    const src = String(text);
    const outVisible = [];
    const outThink = [];
    let i = 0;
    while (i < src.length) {
      const openIdx = src.indexOf("<think>", i);
      if (openIdx < 0) { outVisible.push(src.slice(i)); break; }
      if (openIdx > i) outVisible.push(src.slice(i, openIdx));
      const contentStart = openIdx + 7;
      const closeIdx = src.indexOf("</think>", contentStart);
      if (closeIdx < 0) {
        // 未闭合：从 <think> 到末尾都归到思考
        outThink.push(src.slice(contentStart));
        i = src.length;
        break;
      }
      outThink.push(src.slice(contentStart, closeIdx));
      i = closeIdx + 8;
    }
    // 相邻标签会留下空行，正文两端 trim 避免顶部一片空白
    return {
      visible: outVisible.join("").replace(/^\s+|\s+$/g, ""),
      think: outThink.join("\n\n").replace(/^\s+|\s+$/g, "")
    };
  }

  // 静态渲染（历史回放 / 非流式一次性文本）的思考气泡：默认折叠，跟流式版视觉一致。
  function appendStaticReasoningBubble(thinkText) {
    if (!thinkText || !els.chatStream) return null;
    const wrap = document.createElement("div");
    wrap.className = "chat-msg reasoning collapsible";
    wrap.appendChild(makeAvatarEl("assistant"));
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";
    const label = document.createElement("span");
    label.className = "chat-msg-label";
    label.textContent = "思考过程";
    head.appendChild(label);
    const preview = document.createElement("span");
    preview.className = "tool-preview reasoning-preview";
    preview.textContent = (thinkText.split(/\n+/).filter(Boolean).slice(-1)[0] || "").slice(0, 80);
    head.appendChild(preview);
    const chev = document.createElement("span");
    chev.className = "tool-chevron";
    chev.textContent = "▶";
    head.appendChild(chev);
    const body = document.createElement("div");
    body.className = "tool-body reasoning-body";
    body.textContent = thinkText;
    wrap.appendChild(head);
    wrap.appendChild(body);
    head.addEventListener("click", () => {
      const expanded = wrap.classList.toggle("expanded");
      chev.textContent = expanded ? "▼" : "▶";
    });
    els.chatStream.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
    return wrap;
  }

  // ribbon 快捷指令的「操作盒子」：模板提示词不平铺在聊天流里，收起时只显示
  // 按钮文字（如「全文总结」），点开可见实际发送给模型的完整提示词。
  function appendQuickActionUserBubble(actionLabel, promptText) {
    if (!els.chatStream) return null;
    const wrap = document.createElement("div");
    wrap.className = "chat-msg quick-action collapsible";
    wrap.appendChild(makeAvatarEl("user"));
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";
    const label = document.createElement("span");
    label.className = "chat-msg-label";
    label.textContent = actionLabel;
    head.appendChild(label);
    const hint = document.createElement("span");
    hint.className = "tool-preview quick-action-hint";
    hint.textContent = "快捷指令";
    head.appendChild(hint);
    const chev = document.createElement("span");
    chev.className = "tool-chevron";
    chev.textContent = "▶";
    head.appendChild(chev);
    const body = document.createElement("div");
    body.className = "tool-body quick-action-body";
    body.textContent = String(promptText || "");
    wrap.appendChild(head);
    wrap.appendChild(body);
    head.addEventListener("click", () => {
      const expanded = wrap.classList.toggle("expanded");
      chev.textContent = expanded ? "▼" : "▶";
    });
    els.chatStream.appendChild(wrap);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
    return wrap;
  }

  // ---- Thinking indicator ----
  // 在 AI 思考阶段（请求未返回、或工具执行后等待下一轮）显示一个临时占位气泡。
  let thinkingTimer = null;
  function showThinking(text = "AI 正在思考") {
    hideThinking();
    const div = document.createElement("div");
    div.id = "chatThinking";
    div.className = "chat-msg assistant thinking";

    // 不渲染圆形头像（也不渲染"AI"文字标签）—— 只留 ••• 动画 + 文案，
    // 避免思考指示器出现一个圆圈背景（头像圆叠在 ••• 后面）。文案本身已含"AI"。
    const body = document.createElement("span");
    body.className = "thinking-body";
    body.innerHTML = `<span class="dot-typing"><span></span><span></span><span></span></span><span class="thinking-text">${text}</span>`;
    div.appendChild(body);

    els.chatStream.appendChild(div);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
  }

  function hideThinking() {
    const node = document.getElementById("chatThinking");
    if (node) node.remove();
    // 顺手取消尚未触发的 delayed thinking
    if (_delayedThinkingTimer) {
      clearTimeout(_delayedThinkingTimer);
      _delayedThinkingTimer = null;
    }
  }

  // 延时插入 thinking 气泡：只有下一步事件超过 delay 还没来才显示，
  // 避免快速 tool_result → tool_call 序列里 thinking 气泡疯狂闪烁。
  let _delayedThinkingTimer = null;
  function scheduleDelayedThinking(delay = 400, text = "AI 正在思考") {
    if (_delayedThinkingTimer) clearTimeout(_delayedThinkingTimer);
    _delayedThinkingTimer = setTimeout(() => {
      _delayedThinkingTimer = null;
      showThinking(text);
    }, delay);
  }

  function oneLine(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
  }

  // 取流式输出的最近尾段，给进度文字用（类似 Claude Code 的 "…最近几个字"）。
  // - 折行成单行
  // - 超过 max 字符就截尾部，前面加省略号
  function tailForProgress(text, max = 60) {
    const s = oneLine(text);
    if (!s) return "…";
    if (s.length <= max) return s;
    return "…" + s.slice(-max);
  }

  // ---------------- WPS AI 排版富文本预览 ----------------

  let formatPreviewState = null;
  let formatPreviewBound = false;
  let formatPreviewDialogResultWritten = false;

  const FORMAT_PRESETS = [
    { key: "contract", label: "合同", prompt: "正式合同/协议风格：标题居中加粗，条款分级编号清晰（第一条 / 1.1 / a.），正文严谨、术语保留原样、不口语化；签署区/落款单独成段。" },
    { key: "tender", label: "招标文件", prompt: "招标文件规范：章节层级清晰（第一章 / 第二章 …），小节用编号标题，要求项整成项目符号或编号列表，条款分明、便于检索。" },
    { key: "gov", label: "公文报告", prompt: "正式公文/报告风格：主标题居中加粗，一级/二级小标题分级，正文首行缩进、用书面语，必要时使用编号或项目符号，落款居右。" },
    { key: "notice", label: "通知公告", prompt: "通知/公告体：主标题醒目居中，事由/正文用书面语，关键信息（时间、地点、要求）用编号列出，末尾落款（单位 + 日期）居右。" },
    { key: "paper", label: "论文", prompt: "学术论文风格：标题层级清晰，摘要 / 引言 / 方法 / 结果 / 结论 等分章节用一级标题，正文段落首行缩进，引用与编号保留。" },
    { key: "proposal", label: "方案", prompt: "项目/方案文档：分章节（背景 / 目标 / 方案 / 计划 / 风险）使用一级标题，要点列表化，必要处用引用块突出结论。" },
    { key: "resume", label: "简历", prompt: "简历风格：姓名/标题置顶居中加粗，板块（教育背景 / 工作经历 / 项目经验 / 技能）用一级标题，条目用项目符号，时间和职位简洁突出。" }
  ];

  function closeFormatPreviewModal() {
    if (isFormatPreviewDialog) {
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.formatPreviewModal?.classList.add("hidden");
    if (els.formatPreviewLoading) els.formatPreviewLoading.classList.add("hidden");
    // 复位「长文改写模式」，避免下次复用弹窗做 AI 排版时残留双模式按钮 / 隐藏侧栏。
    try { if (typeof setLongRewriteMode === "function") setLongRewriteMode(false); } catch (e) {}
  }

  function normalizeFormatPreviewType(type) {
    const t = String(type || "paragraph").toLowerCase();
    if (["title", "subtitle", "heading", "paragraph", "bullet", "numbered", "quote", "spacer"].includes(t)) return t;
    return "paragraph";
  }

  function splitDocumentParagraphs(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      // 切分点：段落标记 + 软换行(Shift+Enter，表单/日报常整篇一个 Word 段落靠软换行分行) + 分页 + 行段分隔符，都当作分段
      .replace(/[\r\u000b\u000c\u2028\u2029]/g, "\n")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function inferFallbackFormatBlocks(paragraphs, requirement = "") {
    const req = String(requirement || "");
    const formal = /公文|正式|报告|论文|严肃|规范/.test(req);
    return paragraphs.map((text, index) => {
      const clean = String(text || "").trim();
      if (!clean) return { type: "spacer", text: "" };
      if (index === 0 && clean.length <= 40) return { type: "title", text: clean };
      if (/^[一二三四五六七八九十]+[、.．]/.test(clean) || /^\d+[、.．]\s*/.test(clean)) {
        return { type: "heading", level: 2, text: clean.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "") || clean };
      }
      if (/^[(（]?[一二三四五六七八九十\d]+[)）]/.test(clean) || /^[-•*]\s+/.test(clean)) {
        return { type: "bullet", level: 1, text: clean.replace(/^[-•*]\s+/, "") };
      }
      if (!formal && clean.length <= 24 && !/[。！？!?；;]/.test(clean)) return { type: "heading", level: 3, text: clean };
      return { type: "paragraph", text: clean };
    });
  }

  function parseJsonObjectLoose(raw) {
    const s = String(raw || "").trim();
    const fence = s.match(/```(?:json|JSON)?\s*([\s\S]+?)```/);
    if (fence) {
      try { return JSON.parse(fence[1].trim()); } catch (e) {}
    }
    const candidates = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") { inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) candidates.push(s.slice(start, i + 1));
      }
    }
    candidates.sort((a, b) => b.length - a.length);
    for (const c of candidates) {
      try { return JSON.parse(c); } catch (e) {}
    }
    return JSON.parse(s);
  }

  // 把 block.type 翻成预览 DOM 用的标签名 + level（list 在流式阶段统一渲染成 <p>
  // 避免 ul/ol 边渲边重组导致闪屏；流完成后 renderFormatPreviewBlocks 会重画一次拿回正版样式）。
  function streamingTagForType(type, level) {
    const t = normalizeFormatPreviewType(type);
    if (t === "title") return { tag: "h1", t };
    if (t === "heading") return { tag: `h${Math.max(2, Math.min(4, Number(level || 2)))}`, t };
    if (t === "subtitle") return { tag: "p", t };
    if (t === "quote") return { tag: "blockquote", t };
    return { tag: "p", t };
  }

  function createStreamingBlockEl(block) {
    const { tag, t } = streamingTagForType(block?.type, block?.level);
    const el = document.createElement(tag);
    el.className = `format-preview-block format-preview-${t}`;
    let text = String(block?.text || "");
    if (t === "bullet") text = "• " + text;
    if (t === "numbered") text = "1. " + text;  // 流式阶段编号占位，最终 renderFormatPreviewBlocks 会换成真正的 <ol>
    el.textContent = text;
    return el;
  }

  // 原地刷新流式 block 元素：类型/层级变了就换 tag（用 replaceWith 一次性替换、不影响兄弟节点），
  // 没变就只更新 textContent —— 这样大多数 tick 只是节点 text 微调，浏览器不会重排整个面板。
  function updateStreamingBlockEl(el, block) {
    const { tag, t } = streamingTagForType(block?.type, block?.level);
    if (el.tagName.toLowerCase() !== tag.toLowerCase()) {
      const fresh = createStreamingBlockEl(block);
      fresh.classList.add("is-streaming-active");
      el.replaceWith(fresh);
      return fresh;
    }
    el.className = `format-preview-block format-preview-${t}`;
    el.classList.add("is-streaming-active");
    let text = String(block?.text || "");
    if (t === "bullet") text = "• " + text;
    if (t === "numbered") text = "1. " + text;
    if (el.textContent !== text) el.textContent = text;
    return el;
  }

  // 从 raw 里抠出"正在进行中"的那个 block —— 必须是 blocks 数组内部尚未闭合的 {…}，
  // 不是最外层 { "blocks": [ ] } 的 `{`。之前 bug：扫括号从 raw 开头开始，会把外层
  // `{` 当成"当前活跃"，然后 readPartialJsonStringField 找到的 `text` 是 blocks[0].text
  // → 第一个 block 已经落定后，活跃节点还在源源不断地重画它（用户看到"第一句话一直
  // 重复"），直到下个 block 出现才能覆盖掉。
  //
  // 修法：先跳到 blocks 数组的 `[` 之后再扫；只在 depth 从 0→1 时记录 start，
  // depth 回到 0（当前 block 闭合）就 reset。数组闭合（`]` at depth 0）也 reset。
  function extractActiveStreamingBlock(raw) {
    if (!raw) return null;
    const arrayStart = raw.indexOf("[");
    if (arrayStart < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastUnclosedStart = -1;
    for (let i = arrayStart + 1; i < raw.length; i += 1) {
      const c = raw[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") {
        if (depth === 0) lastUnclosedStart = i;
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0) lastUnclosedStart = -1;
      } else if (c === "]" && depth === 0) {
        lastUnclosedStart = -1;
        break;
      }
    }
    if (lastUnclosedStart < 0 || depth <= 0) return null;
    const partial = raw.slice(lastUnclosedStart);
    const typeMatch = partial.match(/"type"\s*:\s*"([^"]*)"/);
    const levelMatch = partial.match(/"level"\s*:\s*(\d+)/);
    const text = readPartialJsonStringField(partial, "text");
    return {
      type: typeMatch ? typeMatch[1] : "paragraph",
      level: levelMatch ? Number(levelMatch[1]) : 1,
      text
    };
  }

  // 从一段半截 JSON 里读 `"key":"…"` 的 value，遇到未闭合的引号也能容忍，按 JSON 转义规则解码。
  function readPartialJsonStringField(partial, key) {
    const keyToken = `"${key}"`;
    const keyIdx = partial.indexOf(keyToken);
    if (keyIdx < 0) return "";
    const colonIdx = partial.indexOf(":", keyIdx + keyToken.length);
    if (colonIdx < 0) return "";
    const quoteIdx = partial.indexOf('"', colonIdx + 1);
    if (quoteIdx < 0) return "";
    let i = quoteIdx + 1;
    let out = "";
    let escape = false;
    for (; i < partial.length; i += 1) {
      const c = partial[i];
      if (escape) {
        if (c === "n") out += "\n";
        else if (c === "t") out += "\t";
        else if (c === "r") out += "\r";
        else if (c === "u") {
          const hex = partial.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        } else {
          out += c;
        }
        escape = false;
      } else if (c === "\\") { escape = true; }
      else if (c === '"') { break; }
      else { out += c; }
    }
    return out;
  }

  // 流式 JSON 增量解析：从 AI 边吐边写的 raw 文本里抽出已经完整的 {…} block。
  // 用括号计数器跨过字符串里的 `{` `}` 干扰；遇到第一个 `]` 视为 blocks 数组结束。
  // 每个匹配到的 {…} 用 JSON.parse 单独 parse，坏掉的就跳过——这样不至于因为一个
  // 半截 block 把已收到的全 invalid 掉。
  function extractStreamingFormatBlocks(raw) {
    if (!raw) return [];
    const arrayStart = raw.indexOf("[");
    if (arrayStart < 0) return [];
    const out = [];
    let depth = 0;
    let blockStart = -1;
    let inString = false;
    let escape = false;
    for (let i = arrayStart + 1; i < raw.length; i += 1) {
      const c = raw[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") {
        if (depth === 0) blockStart = i;
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0 && blockStart >= 0) {
          try {
            const obj = JSON.parse(raw.slice(blockStart, i + 1));
            if (obj && typeof obj === "object") out.push(obj);
          } catch (e) { /* malformed block，跳过不影响其他 */ }
          blockStart = -1;
        }
      } else if (c === "]" && depth === 0) {
        break;
      }
    }
    return out;
  }

  function normalizeFormatBlocks(payload, paragraphs) {
    const rawBlocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
    const requirement = String(payload?.requirement || "");
    if (!rawBlocks.length) return inferFallbackFormatBlocks(paragraphs, requirement);
    const merged = inferFallbackFormatBlocks(paragraphs, requirement);
    rawBlocks.forEach((block, i) => {
      const sourceIndex = Number.isInteger(block.sourceIndex) ? block.sourceIndex : i;
      if (sourceIndex < 0 || sourceIndex >= paragraphs.length) return;
      const original = paragraphs[sourceIndex] || paragraphs[i] || "";
      const type = normalizeFormatPreviewType(block.type);
      merged[sourceIndex] = {
        type,
        level: Math.max(1, Math.min(4, Number(block.level || 1))),
        text: String(block.text || original || "").trim(),
        sourceIndex
      };
    });
    return merged.filter((block) => block.type === "spacer" || block.text);
  }

  // 把连续的 markdown 表格行（| a | b |，紧跟 | --- | --- | 分隔行）合并成一个 table block，
  // 让 AI 排版能把「表格文本」输出成真正的 Word 表格（写回走 blocksToHtml 的 <table>）。
  function splitMarkdownRow(line) {
    let s = String(line || "").trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }
  function mergeMarkdownTables(blocks) {
    const arr = Array.isArray(blocks) ? blocks : [];
    const isRow = (b) => b && typeof b.text === "string" && /^\s*\|.+\|\s*$/.test(b.text);
    const isSep = (b) => b && typeof b.text === "string" && /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(b.text);
    const out = [];
    for (let i = 0; i < arr.length; i += 1) {
      const b = arr[i];
      if (isRow(b) && isSep(arr[i + 1])) {
        const headers = splitMarkdownRow(b.text);
        const rows = [];
        let j = i + 2;
        while (j < arr.length && isRow(arr[j]) && !isSep(arr[j])) {
          rows.push(splitMarkdownRow(arr[j].text));
          j += 1;
        }
        out.push({ type: "table", headers, rows });
        i = j - 1;
      } else {
        out.push(b);
      }
    }
    return out;
  }

  // ---------------- 排版模板（选择 / 样式效果预览 / 自定义编辑器） ----------------
  // 当前选中模板的 styleMap（预览渲染 appendBlockEl 用）；null = 通用默认样式
  let formatTemplateStyles = null;

  function currentFormatTemplateId() {
    return formatPreviewState?.templateId || els.formatTemplateSelect?.value || "default";
  }

  // 模板样式 → 预览 DOM 内联样式（pt→px 用 4/3 近似）
  function applyTplStyleToEl(el, kind, level) {
    const T = global.WpsAiFormatTemplates;
    if (!el || !formatTemplateStyles || !T) return;
    let key = kind;
    if (kind === "heading") key = `heading${Math.max(1, Math.min(4, Number(level || 1)))}`;
    if (kind === "bullet" || kind === "numbered") key = "paragraph";
    const s = formatTemplateStyles[key];
    if (!s) return;
    if (s.font) el.style.fontFamily = s.font;
    if (Number.isFinite(s.size)) el.style.fontSize = Math.round(s.size * 4 / 3) + "px";
    if (typeof s.bold === "boolean") el.style.fontWeight = s.bold ? "700" : "400";
    if (typeof s.italic === "boolean") el.style.fontStyle = s.italic ? "italic" : "normal";
    if (s.align) el.style.textAlign = s.align;
    if (Number.isFinite(s.lineSpacing)) el.style.lineHeight = String(s.lineSpacing);
    if (Number.isFinite(s.firstLineIndentChars) && s.firstLineIndentChars > 0) {
      el.style.textIndent = s.firstLineIndentChars + "em";
    }
  }

  // 「样式效果预览」小样张：标题 / 一级标题 / 正文，按模板即时渲染
  function renderFormatTemplateSample() {
    const box = els.formatTemplateSample;
    if (!box) return;
    const t = global.WpsAiI18n?.t || ((s) => s);
    box.innerHTML = "";
    const rows = [
      { kind: "title", text: t("标题示例") },
      { kind: "heading", level: 1, text: t("一、一级标题示例") },
      { kind: "paragraph", text: t("正文段落示例：本合同双方本着平等自愿的原则，经友好协商达成如下条款。") }
    ];
    rows.forEach((r) => {
      const div = document.createElement("div");
      div.className = "format-template-sample-line format-template-sample-" + r.kind;
      div.textContent = r.text;
      applyTplStyleToEl(div, r.kind, r.level);
      box.appendChild(div);
    });
  }

  function renderFormatTemplateControls() {
    const sel = els.formatTemplateSelect;
    const T = global.WpsAiFormatTemplates;
    if (!sel || !T) return;
    const t = global.WpsAiI18n?.t || ((s) => s);
    const all = T.getAll();
    const currentId = currentFormatTemplateId();
    sel.innerHTML = "";
    all.forEach((tpl) => {
      const opt = document.createElement("option");
      opt.value = tpl.id;
      opt.textContent = tpl.builtin ? t(tpl.name) : tpl.name;
      sel.appendChild(opt);
    });
    sel.value = all.some((x) => x.id === currentId) ? currentId : "default";
    const active = T.getById(sel.value);
    formatTemplateStyles = T.resolveStyleMap(active);
    if (formatPreviewState) formatPreviewState.templateId = sel.value;
    // 内置模板不可编辑/删除
    const isBuiltin = !!active?.builtin;
    if (els.formatTemplateEditBtn) els.formatTemplateEditBtn.disabled = isBuiltin;
    if (els.formatTemplateDeleteBtn) els.formatTemplateDeleteBtn.disabled = isBuiltin;
    renderFormatTemplateSample();
  }

  // 选模板时把模板的排版要求带进输入框：仅当输入框为空或还是上一个模板的默认值时才覆盖，
  // 用户手改过的要求不动。
  let _lastTemplateRequirement = "";
  function onFormatTemplateChange() {
    const T = global.WpsAiFormatTemplates;
    const tpl = T?.getById(els.formatTemplateSelect?.value || "default");
    if (!tpl) return;
    if (formatPreviewState) formatPreviewState.templateId = tpl.id;
    formatTemplateStyles = T.resolveStyleMap(tpl);
    const input = els.formatPreviewPromptInput;
    if (input) {
      const cur = String(input.value || "").trim();
      if (!cur || cur === _lastTemplateRequirement.trim()) input.value = tpl.requirement || "";
    }
    _lastTemplateRequirement = tpl.requirement || "";
    renderFormatTemplateControls();
    // 已有预览结果 → 重渲染让新样式立即可见
    if (formatPreviewState?.blocks?.length) {
      try { renderFormatPreviewBlocks(formatPreviewState.blocks); } catch (e) {}
    }
  }

  // ---- 完整示例弹窗（放大查看） ----
  // 每种内置模板配一份对应文体的迷你示例文档；自定义模板用通用示例。
  const FORMAT_TEMPLATE_SAMPLES = {
    default: [
      { kind: "title", text: "2026 年第一季度工作报告" },
      { kind: "subtitle", text: "产品研发部 · 2026 年 4 月" },
      { kind: "heading", level: 1, text: "一、总体进展" },
      { kind: "paragraph", text: "本季度围绕年度目标推进各项工作，核心项目按计划交付，关键指标完成率 96%，团队整体运转平稳。" },
      { kind: "heading", level: 2, text: "1.1 重点项目" },
      { kind: "paragraph", text: "新版客户端如期发布，上线两周活跃用户提升 18%；数据平台二期完成主体开发，进入联调阶段。" },
      { kind: "list", items: ["客户端 2.0：3 月 15 日发布，崩溃率降至 0.1% 以下", "数据平台二期：完成度 80%，预计 5 月上线", "自动化测试覆盖率：从 45% 提升到 68%"] },
      { kind: "heading", level: 2, text: "1.2 存在问题" },
      { kind: "paragraph", text: "跨部门协作排期冲突较多，部分需求交付延后一周左右，需要在下季度建立更明确的优先级机制。" },
      { kind: "quote", text: "提示：本页为排版样式示例，展示各级标题、正文、列表与引用在该模板下的实际效果。" },
      { kind: "heading", level: 3, text: "二、下季度计划" },
      { kind: "paragraph", text: "聚焦数据平台上线与客户端性能优化，同步启动年度中期复盘。" }
    ],
    contract: [
      { kind: "title", text: "房屋租赁合同" },
      { kind: "subtitle", text: "合同编号：LX-2026-0001" },
      { kind: "heading", level: 1, text: "一、双方基本信息" },
      { kind: "paragraph", text: "出租方（甲方）与承租方（乙方）本着平等自愿、协商一致的原则，就房屋租赁事宜达成如下协议，双方共同遵守执行。" },
      { kind: "heading", level: 2, text: "（一）租赁物业" },
      { kind: "paragraph", text: "甲方将位于示例市示例区示例路 88 号的房屋出租给乙方使用，建筑面积约 120 平方米，用途为办公。" },
      { kind: "list", items: ["租赁期限：自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止", "月租金：人民币壹万元整（¥10,000.00）", "付款方式：季付，每期提前 7 日支付"] },
      { kind: "heading", level: 2, text: "（二）双方权利义务" },
      { kind: "paragraph", text: "乙方应按约定用途使用房屋，未经甲方书面同意不得转租、转借或改变房屋结构。" },
      { kind: "quote", text: "提示：本页为排版样式示例，展示各级标题、正文、列表与引用在该模板下的实际效果。" },
      { kind: "heading", level: 3, text: "附：签署栏" },
      { kind: "paragraph", text: "甲方（签章）：____________　乙方（签章）：____________　日期：____年__月__日" }
    ],
    gov: [
      { kind: "title", text: "关于开展 2026 年度安全生产检查工作的通知" },
      { kind: "subtitle", text: "示例字〔2026〕12 号" },
      { kind: "paragraph", text: "各部门、各下属单位：" },
      { kind: "paragraph", text: "为进一步落实安全生产责任制，防范化解各类安全风险，经研究决定，在全系统范围内开展年度安全生产检查工作。现将有关事项通知如下：" },
      { kind: "heading", level: 1, text: "一、总体要求" },
      { kind: "paragraph", text: "坚持问题导向和底线思维，聚焦重点领域和关键环节，做到全覆盖、零容忍、严执法、重实效。" },
      { kind: "heading", level: 2, text: "（一）检查范围" },
      { kind: "paragraph", text: "覆盖办公场所、生产车间、仓储库房及在建项目工地，重点核查消防设施、用电安全与应急预案落实情况。" },
      { kind: "heading", level: 1, text: "二、时间安排" },
      { kind: "list", items: ["自查阶段：5 月 10 日至 5 月 20 日", "集中检查：5 月 21 日至 6 月 10 日", "整改复查：6 月 11 日至 6 月 30 日"] },
      { kind: "paragraph", text: "请各单位高度重视，认真组织实施，确保检查工作取得实效。" },
      { kind: "paragraph", text: "示例集团安全生产委员会　　2026 年 5 月 6 日" }
    ],
    paper: [
      { kind: "title", text: "基于深度学习的中文文本自动摘要方法研究" },
      { kind: "subtitle", text: "摘要：针对长文本摘要中信息冗余与关键信息丢失问题，本文提出一种融合注意力机制的分层摘要模型。" },
      { kind: "heading", level: 1, text: "1 引言" },
      { kind: "paragraph", text: "随着信息量的爆炸式增长，自动文本摘要成为自然语言处理领域的重要研究方向。现有方法在长文档场景下仍存在语义连贯性不足的问题。" },
      { kind: "heading", level: 2, text: "1.1 研究现状" },
      { kind: "paragraph", text: "抽取式方法直接选取原文关键句，忠实度高但连贯性差；生成式方法可产生流畅摘要，但易出现事实性错误。" },
      { kind: "heading", level: 2, text: "1.2 本文贡献" },
      { kind: "list", items: ["提出分层编码结构，兼顾句级与篇章级语义", "设计事实一致性约束，显著降低幻觉率", "在两个公开数据集上取得当前最优结果"] },
      { kind: "heading", level: 1, text: "2 相关工作" },
      { kind: "paragraph", text: "早期研究以统计特征为主，近年来预训练语言模型成为主流范式，其表示能力大幅提升了摘要质量。" },
      { kind: "quote", text: "注：本页为排版样式示例，正文内容仅用于展示模板效果。" }
    ],
    notice: [
      { kind: "title", text: "关于 2026 年国庆节放假安排的通知" },
      { kind: "paragraph", text: "全体员工：" },
      { kind: "paragraph", text: "根据国家法定节假日安排，结合公司实际情况，现将 2026 年国庆节放假事宜通知如下：" },
      { kind: "heading", level: 1, text: "一、放假安排" },
      { kind: "list", items: ["放假时间：10 月 1 日（周四）至 10 月 7 日（周三），共 7 天", "9 月 27 日（周日）、10 月 10 日（周六）正常上班", "值班人员安排另行通知"] },
      { kind: "heading", level: 1, text: "二、注意事项" },
      { kind: "paragraph", text: "请各部门提前做好工作交接与安全检查，离开办公室前关闭电源与门窗；节日期间保持通讯畅通。" },
      { kind: "quote", text: "提示：本页为排版样式示例，展示标题、正文与列表在该模板下的实际效果。" },
      { kind: "paragraph", text: "示例科技有限公司人事行政部　　2026 年 9 月 25 日" }
    ]
  };

  // 渲染一页「迷你文档」：按模板类型选对应文体示例，全套元素按模板样式呈现。
  function openFormatTemplateSampleModal() {
    const T = global.WpsAiFormatTemplates;
    const t = global.WpsAiI18n?.t || ((s) => s);
    const page = els.formatTemplateSampleModalPage;
    if (!T || !page || !els.formatTemplateSampleModal) return;
    const tpl = T.getById(currentFormatTemplateId());
    if (els.formatTemplateSampleModalTitle) {
      els.formatTemplateSampleModalTitle.textContent = `${t("排版示例")} · ${tpl?.builtin ? t(tpl.name) : (tpl?.name || t("通用"))}`;
    }
    page.innerHTML = "";
    // 自定义模板没有绑定文体 → 用通用示例
    const rows = (FORMAT_TEMPLATE_SAMPLES[tpl?.id] || FORMAT_TEMPLATE_SAMPLES.default)
      .map((r) => (r.kind === "list" ? { kind: "list", items: r.items.map((x) => t(x)) } : Object.assign({}, r, { text: t(r.text) })));
    rows.forEach((r) => {
      if (r.kind === "list") {
        const ul = document.createElement("ul");
        ul.className = "format-preview-list";
        r.items.forEach((it) => {
          const li = document.createElement("li");
          li.textContent = it;
          applyTplStyleToEl(li, "paragraph");
          li.style.textIndent = "";
          ul.appendChild(li);
        });
        page.appendChild(ul);
        return;
      }
      const tag = r.kind === "title" ? "h1" : (r.kind === "heading" ? `h${Math.max(2, Math.min(4, (r.level || 1) + 1))}` : (r.kind === "quote" ? "blockquote" : "p"));
      const el = document.createElement(tag);
      el.className = `format-preview-block format-preview-${r.kind}`;
      el.textContent = r.text;
      applyTplStyleToEl(el, r.kind, r.level);
      page.appendChild(el);
    });
    els.formatTemplateSampleModal.classList.remove("hidden");
  }

  function closeFormatTemplateSampleModal() {
    els.formatTemplateSampleModal?.classList.add("hidden");
  }

  // ---- 自定义模板编辑器 ----
  const TPL_KIND_LABELS = [
    ["title", "标题"], ["subtitle", "副标题"],
    ["heading1", "一级标题"], ["heading2", "二级标题"], ["heading3", "三级标题"],
    ["paragraph", "正文"], ["quote", "引用"]
  ];
  let _editingTemplate = null;

  function openFormatTemplateEditor(baseTpl, { isNew } = {}) {
    const T = global.WpsAiFormatTemplates;
    const t = global.WpsAiI18n?.t || ((s) => s);
    if (!T || !els.formatTemplateEditorModal || !els.formatTemplateEditorBody) return;
    const base = baseTpl || T.getById("default");
    _editingTemplate = {
      id: isNew ? T.newCustomId() : base.id,
      name: isNew ? `${base.name} ${t("副本")}` : base.name,
      requirement: base.requirement || "",
      styles: base.styles ? JSON.parse(JSON.stringify(base.styles)) : {}
    };
    const st = _editingTemplate.styles;
    const esc = escapeAttr;
    const rowHtml = (kind, label) => {
      const s = st[kind] || {};
      return `<div class="tpl-editor-row" data-kind="${kind}">
        <span class="tpl-editor-kind">${escapeHtml(t(label))}</span>
        <input type="text" data-f="font" placeholder="${esc(t("字体"))}" value="${esc(s.font || "")}"/>
        <input type="number" data-f="size" min="6" max="72" step="0.5" placeholder="${esc(t("字号"))}" value="${s.size != null ? esc(String(s.size)) : ""}"/>
        <label class="tpl-editor-check"><input type="checkbox" data-f="bold" ${s.bold ? "checked" : ""}/><span>${escapeHtml(t("加粗"))}</span></label>
        <select data-f="align">
          <option value="">${escapeHtml(t("对齐"))}</option>
          <option value="left" ${s.align === "left" ? "selected" : ""}>${escapeHtml(t("左"))}</option>
          <option value="center" ${s.align === "center" ? "selected" : ""}>${escapeHtml(t("居中"))}</option>
          <option value="right" ${s.align === "right" ? "selected" : ""}>${escapeHtml(t("右"))}</option>
        </select>
      </div>`;
    };
    const para = st.paragraph || {};
    els.formatTemplateEditorBody.innerHTML = `
      <label class="field"><span>${escapeHtml(t("模板名称"))}</span><input type="text" id="tplEditorName" maxlength="30" value="${esc(_editingTemplate.name)}"/></label>
      <div class="tpl-editor-grid">${TPL_KIND_LABELS.map(([k, l]) => rowHtml(k, l)).join("")}</div>
      <div class="tpl-editor-extra">
        <label>${escapeHtml(t("正文行距"))}
          <select id="tplEditorLineSpacing">
            <option value="">${escapeHtml(t("默认"))}</option>
            <option value="1" ${para.lineSpacing === 1 ? "selected" : ""}>1</option>
            <option value="1.5" ${para.lineSpacing === 1.5 ? "selected" : ""}>1.5</option>
            <option value="2" ${para.lineSpacing === 2 ? "selected" : ""}>2</option>
          </select>
        </label>
        <label>${escapeHtml(t("正文首行缩进（字符）"))}
          <input type="number" id="tplEditorIndent" min="0" max="8" step="1" value="${para.firstLineIndentChars != null ? esc(String(para.firstLineIndentChars)) : ""}"/>
        </label>
      </div>
      <label class="field"><span>${escapeHtml(t("默认排版要求（选中模板时自动填入，可再修改）"))}</span>
        <textarea id="tplEditorRequirement" rows="3">${escapeHtml(_editingTemplate.requirement)}</textarea>
      </label>`;
    els.formatTemplateEditorModal.classList.remove("hidden");
  }

  function closeFormatTemplateEditor() {
    els.formatTemplateEditorModal?.classList.add("hidden");
    _editingTemplate = null;
  }

  function saveFormatTemplateEditor() {
    const T = global.WpsAiFormatTemplates;
    if (!T || !_editingTemplate || !els.formatTemplateEditorBody) return;
    const t = global.WpsAiI18n?.t || ((s) => s);
    const name = String(document.getElementById("tplEditorName")?.value || "").trim();
    if (!name) { showMessage(t("请填写模板名称。"), "error"); return; }
    const styles = {};
    els.formatTemplateEditorBody.querySelectorAll(".tpl-editor-row").forEach((row) => {
      const kind = row.dataset.kind;
      const s = {};
      const font = String(row.querySelector('[data-f="font"]')?.value || "").trim();
      const size = Number(row.querySelector('[data-f="size"]')?.value);
      const bold = !!row.querySelector('[data-f="bold"]')?.checked;
      const align = String(row.querySelector('[data-f="align"]')?.value || "");
      if (font) s.font = font;
      if (Number.isFinite(size) && size > 0) s.size = size;
      s.bold = bold;
      if (align) s.align = align;
      styles[kind] = s;
    });
    // heading4 跟随 heading3（编辑器不单独暴露，减少字段噪音）
    if (styles.heading3) styles.heading4 = Object.assign({}, styles.heading3);
    const ls = Number(document.getElementById("tplEditorLineSpacing")?.value);
    const ind = Number(document.getElementById("tplEditorIndent")?.value);
    styles.paragraph = styles.paragraph || {};
    if (Number.isFinite(ls) && ls >= 1) styles.paragraph.lineSpacing = ls;
    if (Number.isFinite(ind) && ind >= 0) styles.paragraph.firstLineIndentChars = ind;
    const saved = T.saveCustom({
      id: _editingTemplate.id,
      name,
      requirement: String(document.getElementById("tplEditorRequirement")?.value || ""),
      styles
    });
    if (!saved) { showMessage(t("模板保存失败。"), "error"); return; }
    closeFormatTemplateEditor();
    if (formatPreviewState) formatPreviewState.templateId = saved.id;
    if (els.formatTemplateSelect) els.formatTemplateSelect.value = saved.id;
    onFormatTemplateChange();
    showMessage(t("模板已保存。"), "success");
  }

  let formatTemplateBound = false;
  function bindFormatTemplateControls() {
    if (formatTemplateBound) return;
    formatTemplateBound = true;
    els.formatTemplateSelect?.addEventListener("change", onFormatTemplateChange);
    els.formatTemplateNewBtn?.addEventListener("click", () => {
      const T = global.WpsAiFormatTemplates;
      openFormatTemplateEditor(T?.getById(currentFormatTemplateId()), { isNew: true });
    });
    els.formatTemplateEditBtn?.addEventListener("click", () => {
      const T = global.WpsAiFormatTemplates;
      const tpl = T?.getById(currentFormatTemplateId());
      if (!tpl || tpl.builtin) return;
      openFormatTemplateEditor(tpl, { isNew: false });
    });
    els.formatTemplateDeleteBtn?.addEventListener("click", () => {
      const T = global.WpsAiFormatTemplates;
      const tpl = T?.getById(currentFormatTemplateId());
      if (!tpl || tpl.builtin) return;
      if (!confirm(i18nT("确定删除排版模板「{name}」？", { name: tpl.name }))) return;
      T.deleteCustom(tpl.id);
      if (formatPreviewState) formatPreviewState.templateId = "default";
      if (els.formatTemplateSelect) els.formatTemplateSelect.value = "default";
      onFormatTemplateChange();
    });
    els.formatTemplateEditorCloseBtn?.addEventListener("click", closeFormatTemplateEditor);
    els.formatTemplateEditorCancelBtn?.addEventListener("click", closeFormatTemplateEditor);
    els.formatTemplateEditorSaveBtn?.addEventListener("click", saveFormatTemplateEditor);
    // 完整示例弹窗：按钮 + 点小样张本体都能打开
    els.formatTemplateZoomBtn?.addEventListener("click", openFormatTemplateSampleModal);
    els.formatTemplateSample?.addEventListener("click", openFormatTemplateSampleModal);
    els.formatTemplateSampleModalCloseBtn?.addEventListener("click", closeFormatTemplateSampleModal);
    els.formatTemplateSampleModal?.addEventListener("click", (ev) => {
      if (ev.target === els.formatTemplateSampleModal) closeFormatTemplateSampleModal();
    });
  }

  function renderFormatPreviewBlocks(blocks) {
    if (!els.formatPreviewContent) return;
    els.formatPreviewContent.innerHTML = "";
    if (!blocks?.length) {
      els.formatPreviewContent.innerHTML = '<p class="muted">暂无可预览内容。</p>';
      return;
    }
    // 模板带章节自动编号时，预览也按同一规则编号（所见即所得；纯函数不改 state）
    try {
      const T = global.WpsAiFormatTemplates;
      const numbering = T?.getById?.(currentFormatTemplateId())?.numbering;
      if (numbering && (numbering.h1 || numbering.h2)) blocks = T.applyHeadingNumbering(blocks, numbering);
    } catch (e) {}
    // 有 structure 就走"段落 / 表格 / 图片按原顺序交织"路径：
    // 让预览跟真实文档一致，用户直观看到"表格在这里保留原样"。之前只渲染 AI 输出的
    // paragraph blocks，表格 / 图片段直接从预览里消失了。
    const structure = formatPreviewState?.structure;
    if (structure && Array.isArray(structure.segments) && structure.segments.length) {
      renderInterleavedPreview(structure, blocks);
      return;
    }
    // 老宿主 / 老逻辑：全篇 AI 排版无结构信息，直接按 blocks 渲染
    renderBlocksPlain(blocks);
  }

  function renderBlocksPlain(blocks) {
    let activeList = null;
    let activeListTag = "";
    const closeActiveList = () => { activeList = null; activeListTag = ""; };
    blocks.forEach((block) => appendBlockEl(block, {
      getActiveList: () => activeList,
      getActiveListTag: () => activeListTag,
      setActiveList: (v, tag) => { activeList = v; activeListTag = tag || ""; },
      closeActiveList
    }));
  }

  // 交织渲染：iterate segments in order；paragraph 拿对应 AI block，table / image / empty
  // 直接从 structure 拿并渲染成对应元素（<table> / 占位）。
  function renderInterleavedPreview(structure, blocks) {
    // editable index → AI block（fallback：按位置对齐；sourceIndex 缺失或越界都能兜住）
    const blockByEditIdx = new Map();
    blocks.forEach((b, i) => {
      const src = Number.isInteger(b?.sourceIndex) ? b.sourceIndex : i;
      if (!blockByEditIdx.has(src)) blockByEditIdx.set(src, b);
    });
    // 表格按 start 快速定位：某 segment.start 恰好落在 tableRange 起点附近 → 渲染这张表
    // 每张表只渲染一次（走 rendered set 去重，避免连续多个表格段落触发多次）
    const tables = Array.isArray(structure.tables) ? structure.tables : [];
    const renderedTableIndex = new Set();
    let activeList = null;
    let activeListTag = "";
    const closeActiveList = () => { activeList = null; activeListTag = ""; };

    let editIdx = 0;
    for (const seg of structure.segments) {
      if (seg.kind === "paragraph") {
        const block = blockByEditIdx.get(editIdx);
        editIdx += 1;
        if (block) {
          appendBlockEl(block, {
            getActiveList: () => activeList,
            getActiveListTag: () => activeListTag,
            setActiveList: (v, tag) => { activeList = v; activeListTag = tag || ""; },
            closeActiveList
          });
        } else {
          // AI 还没生成到这段 → 渲染成灰底 placeholder 保持位置
          closeActiveList();
          const ph = document.createElement("p");
          ph.className = "format-preview-block format-preview-pending";
          ph.textContent = seg.text || "";
          els.formatPreviewContent.appendChild(ph);
        }
      } else if (seg.kind === "table") {
        closeActiveList();
        // 找一张 range 覆盖当前 seg 起点的表；找到就渲染一次
        const table = tables.find((t) => t.start <= seg.start && seg.end <= t.end && !renderedTableIndex.has(t.tableIndex));
        if (table) {
          renderedTableIndex.add(table.tableIndex);
          els.formatPreviewContent.appendChild(buildPreviewTable(table));
        }
        // 其他属于同一表的 seg 就跳过（同 tableIndex 已在集合里）
      } else if (seg.kind === "image") {
        closeActiveList();
        const ph = document.createElement("div");
        ph.className = "format-preview-image-placeholder";
        ph.innerHTML = `<svg class="fmt-preview-inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.5"/><path d="M21 17l-5-5-6 7"/></svg><span>图片（原样保留）</span>`;
        els.formatPreviewContent.appendChild(ph);
      } else if (seg.kind === "empty") {
        closeActiveList();
        const spacer = document.createElement("div");
        spacer.className = "format-preview-spacer";
        els.formatPreviewContent.appendChild(spacer);
      }
    }
  }

  function buildPreviewTable(t) {
    const wrap = document.createElement("table");
    wrap.className = "format-preview-table";
    const tbody = document.createElement("tbody");
    t.cells.forEach((row, ri) => {
      const tr = document.createElement("tr");
      row.forEach((cellText) => {
        // 首行当作表头，跟真实文档习惯一致，用户一眼能对上
        const cell = document.createElement(ri === 0 ? "th" : "td");
        cell.textContent = cellText;
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
    wrap.appendChild(tbody);
    return wrap;
  }

  // 顶部影响概览：把「改动 N 段」/「保留 M 处」/「预计耗时」浓缩成一张卡，
  // 让用户在动手替换全文之前，一眼看清这次排版的量级。
  function renderFormatPreviewImpact(blocks, structure) {
    if (!els.formatPreviewImpact) return;
    if (!blocks?.length) {
      els.formatPreviewImpact.classList.add("hidden");
      els.formatPreviewImpact.innerHTML = "";
      return;
    }
    const typeCount = { title: 0, subtitle: 0, heading: 0, paragraph: 0, bullet: 0, numbered: 0, quote: 0, spacer: 0 };
    blocks.forEach((b) => {
      const t = normalizeFormatPreviewType(b?.type);
      typeCount[t] = (typeCount[t] || 0) + 1;
    });
    const editableCount = blocks.length;
    const headingCount = typeCount.title + typeCount.subtitle + typeCount.heading;
    const listItemCount = typeCount.bullet + typeCount.numbered;
    const paragraphCount = typeCount.paragraph + typeCount.quote;
    const changeParts = [];
    if (headingCount) changeParts.push(`${headingCount} 标题`);
    if (paragraphCount) changeParts.push(`${paragraphCount} 段落`);
    if (listItemCount) changeParts.push(`${listItemCount} 列表项`);
    const changeDetail = changeParts.length ? `（${changeParts.join(" · ")}）` : "";

    let tableCount = 0, imageCount = 0, emptyCount = 0;
    if (structure && Array.isArray(structure.segments)) {
      const seenTable = new Set();
      structure.segments.forEach((seg) => {
        if (seg.kind === "table") {
          const tables = Array.isArray(structure.tables) ? structure.tables : [];
          const t = tables.find((x) => x.start <= seg.start && seg.end <= x.end);
          const key = t ? t.tableIndex : `seg-${seg.start}`;
          if (!seenTable.has(key)) { seenTable.add(key); tableCount += 1; }
        } else if (seg.kind === "image") imageCount += 1;
        else if (seg.kind === "empty") emptyCount += 1;
      });
    }
    const preservedParts = [];
    if (tableCount) preservedParts.push(`${tableCount} 张表格`);
    if (imageCount) preservedParts.push(`${imageCount} 张图片`);
    if (emptyCount) preservedParts.push(`${emptyCount} 个空段`);

    // 预计耗时：段落 40ms / 表格 120ms / 图片 60ms，写回 Range.Text 逐段近似值
    const etaMs = editableCount * 40 + tableCount * 120 + imageCount * 60;
    const etaLabel = etaMs < 1000 ? `<1s` : `约 ${Math.round(etaMs / 1000)}s`;

    const iconChart = `<svg class="impact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="20" x2="20" y2="20"/><line x1="4" y1="20" x2="4" y2="4"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="14" width="3" height="4"/></svg>`;
    const iconEdit = `<svg class="impact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    const iconLock = `<svg class="impact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
    const iconClock = `<svg class="impact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
    els.formatPreviewImpact.innerHTML = `
      <div class="format-preview-impact-title">${iconChart}<span>本次排版</span></div>
      <div class="format-preview-impact-row">
        <span class="impact-chip impact-chip-change">${iconEdit}改动 <b>${editableCount}</b> 段${changeDetail}</span>
        ${preservedParts.length ? `<span class="impact-chip impact-chip-keep">${iconLock}保留 ${preservedParts.join(" · ")}</span>` : ""}
        <span class="impact-chip impact-chip-eta">${iconClock}预计写回耗时 ${etaLabel}</span>
      </div>`;
    els.formatPreviewImpact.classList.remove("hidden");
  }

  function clearFormatPreviewImpact() {
    if (!els.formatPreviewImpact) return;
    els.formatPreviewImpact.innerHTML = "";
    els.formatPreviewImpact.classList.add("hidden");
  }

  // 抽出原有 append 单个 block 的逻辑，供两条渲染路径共用
  function appendBlockEl(block, ctx) {
    // 表格 block：渲染成真正的 <table>（markdown 表格美化后的预览）
    if (block && block.type === "table" && (Array.isArray(block.rows) || Array.isArray(block.headers))) {
      ctx.closeActiveList();
      const table = document.createElement("table");
      table.className = "format-preview-table";
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (headers.length) {
        const tr = document.createElement("tr");
        headers.forEach((h) => { const th = document.createElement("th"); th.textContent = String(h == null ? "" : h); tr.appendChild(th); });
        table.appendChild(tr);
      }
      rows.forEach((r) => {
        const tr = document.createElement("tr");
        (Array.isArray(r) ? r : []).forEach((c) => { const td = document.createElement("td"); td.textContent = String(c == null ? "" : c); tr.appendChild(td); });
        table.appendChild(tr);
      });
      els.formatPreviewContent.appendChild(table);
      return;
    }
    const type = normalizeFormatPreviewType(block.type);
    if (type === "bullet" || type === "numbered") {
      const tag = type === "numbered" ? "ol" : "ul";
      let activeList = ctx.getActiveList();
      const activeListTag = ctx.getActiveListTag();
      if (!activeList || activeListTag !== tag) {
        activeList = document.createElement(tag);
        activeList.className = "format-preview-list";
        activeList.dataset.level = String(Math.max(1, Math.min(4, Number(block.level || 1))));
        els.formatPreviewContent.appendChild(activeList);
        ctx.setActiveList(activeList, tag);
      }
      const li = document.createElement("li");
      li.textContent = block.text;
      applyTplStyleToEl(li, type, block.level);
      li.style.textIndent = ""; // 列表项不做首行缩进（缩进由列表结构承担）
      activeList.appendChild(li);
      return;
    }
    ctx.closeActiveList();
    if (type === "spacer") {
      const spacer = document.createElement("div");
      spacer.className = "format-preview-spacer";
      els.formatPreviewContent.appendChild(spacer);
      return;
    }
    let el;
    if (type === "title") el = document.createElement("h1");
    else if (type === "subtitle") el = document.createElement("p");
    else if (type === "heading") el = document.createElement(`h${Math.max(2, Math.min(4, Number(block.level || 2)))}`);
    else if (type === "quote") el = document.createElement("blockquote");
    else el = document.createElement("p");
    el.className = `format-preview-block format-preview-${type}`;
    el.textContent = block.text;
    // 排版模板样式：预览所见即替换后效果（pt→px 近似）
    applyTplStyleToEl(el, type, block.level);
    els.formatPreviewContent.appendChild(el);
  }

  function setFormatPreviewBusy(on, text) {
    if (els.formatPreviewLoading) {
      els.formatPreviewLoading.classList.toggle("hidden", !on);
      const label = els.formatPreviewLoading.querySelector("span:last-child");
      if (label && text) label.textContent = text;
    }
    if (els.formatPreviewReplaceBtn) els.formatPreviewReplaceBtn.disabled = on || !formatPreviewState?.blocks?.length;
    if (els.formatPreviewRegenerateBtn) els.formatPreviewRegenerateBtn.disabled = on;
  }

  function updateFormatPreviewActionLabel() {
    if (!els.formatPreviewRegenerateBtn) return;
    const hasResult = !!formatPreviewState?.blocks?.length;
    els.formatPreviewRegenerateBtn.textContent = hasResult ? "重新生成" : "开始排版";
    // 替换按钮文案跟随排版范围
    if (els.formatPreviewReplaceBtn) {
      els.formatPreviewReplaceBtn.textContent = formatPreviewScope() === "selection" ? "替换选中区域" : "替换全文";
    }
  }

  // 当前排版范围："selection"（仅选中区域）或 "doc"（全文）。
  // 只有打开时抓到了有效选区（formatPreviewState.selection 非空）才可能是 selection。
  function formatPreviewScope() {
    if (!formatPreviewState?.selection) return "doc";
    return formatPreviewState.scope === "doc" ? "doc" : "selection";
  }

  // 渲染范围选择控件：有选区才显示；选项切换只更新状态 + 文案，用户点「开始排版 / 重新生成」才生效。
  function renderFormatPreviewScopeRow() {
    const row = els.formatPreviewScopeRow;
    if (!row) return;
    const hasSelection = !!formatPreviewState?.selection;
    row.classList.toggle("hidden", !hasSelection);
    if (!hasSelection) return;
    const scope = formatPreviewScope();
    // .checked 类给不支持 :has() 的老 CEF 用（选中态高亮）
    const syncCheckedClass = () => {
      row.querySelectorAll('input[name="formatPreviewScope"]').forEach((r) => {
        r.closest(".format-preview-scope-option")?.classList.toggle("checked", r.checked);
      });
    };
    row.querySelectorAll('input[name="formatPreviewScope"]').forEach((radio) => {
      radio.checked = radio.value === scope;
      if (radio.dataset.scopeBound !== "1") {
        radio.dataset.scopeBound = "1";
        radio.addEventListener("change", () => {
          syncCheckedClass();
          if (!radio.checked || !formatPreviewState) return;
          formatPreviewState.scope = radio.value === "doc" ? "doc" : "selection";
          // 换范围后旧预览不再对应，清掉等重新生成
          formatPreviewState.blocks = [];
          if (els.formatPreviewContent) {
            els.formatPreviewContent.innerHTML = '<p class="muted">已切换排版范围，点「开始排版」重新生成预览。</p>';
          }
          clearFormatPreviewImpact();
          const n = formatPreviewState.scope === "selection"
            ? splitDocumentParagraphs(formatPreviewState.selection?.text || "").length
            : (formatPreviewState.docParagraphs?.length || formatPreviewState.paragraphs?.length || 0);
          if (els.formatPreviewMeta) {
            els.formatPreviewMeta.textContent = formatPreviewState.scope === "selection"
              ? `将只排版选中区域（约 ${n} 段），等待开始排版。`
              : `将排版全文（约 ${n} 段），等待开始排版。`;
          }
          updateFormatPreviewActionLabel();
        });
      }
    });
    syncCheckedClass();
  }

  function renderFormatPreviewPresets() {
    if (!els.formatPreviewPresetList) return;
    els.formatPreviewPresetList.innerHTML = "";
    FORMAT_PRESETS.forEach((preset) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn compact-btn format-preview-preset-chip";
      btn.textContent = preset.label;
      btn.title = preset.prompt;
      btn.addEventListener("click", () => {
        if (els.formatPreviewPromptInput) {
          els.formatPreviewPromptInput.value = preset.prompt;
          els.formatPreviewPromptInput.focus();
        }
      });
      els.formatPreviewPresetList.appendChild(btn);
    });
  }

  function prepareFormatPreview({ text, paragraphs, selection } = {}) {
    const sourceText = text != null ? String(text || "") : "";
    const list = Array.isArray(paragraphs) && paragraphs.length
      ? paragraphs
      : splitDocumentParagraphs(sourceText);
    if (!list.length) {
      showMessage("当前文档没有可排版的正文。", "error");
      return false;
    }
    // 有效选区：{ start, end, text }。打开时带着选区 → 默认「仅选中区域」（用户选中一段
    // 再点 AI 排版，多半就是想排这一段）；随时可切回全文。
    const sel = (selection && Number(selection.end) > Number(selection.start) && String(selection.text || "").trim())
      ? { start: Number(selection.start), end: Number(selection.end), text: String(selection.text) }
      : null;
    formatPreviewState = {
      sourceText,
      paragraphs: list,
      // 全文的文本/段落单独留一份：切换范围时用（sourceText/paragraphs 会按范围重算）
      docSourceText: sourceText,
      docParagraphs: list,
      selection: sel,
      scope: sel ? "selection" : "doc",
      requirement: "",
      blocks: []
    };
    renderFormatPreviewPresets();
    renderFormatPreviewScopeRow();
    // 排版模板控件：绑定 + 按上次选择渲染（默认「通用」）
    bindFormatTemplateControls();
    renderFormatTemplateControls();
    if (els.formatPreviewPromptInput) els.formatPreviewPromptInput.value = "";
    if (els.formatPreviewContent) els.formatPreviewContent.innerHTML = '<p class="muted">填写排版要求（或留空让 AI 自动识别），点「开始排版」生成预览。</p>';
    if (els.formatPreviewMeta) {
      els.formatPreviewMeta.textContent = sel
        ? `检测到选中区域（约 ${splitDocumentParagraphs(sel.text).length} 段），默认只排版选中部分；可切换为全文（共 ${list.length} 段）。`
        : `已加载 ${list.length} 个段落，等待开始排版。`;
    }
    clearFormatPreviewImpact();
    setLongRewriteMode(false);   // 确保排版入口不残留长文改写模式
    els.formatPreviewModal?.classList.remove("hidden");
    setFormatPreviewBusy(false);
    updateFormatPreviewActionLabel();
    return true;
  }

  function formatPreviewRequirement() {
    return String(els.formatPreviewPromptInput?.value || "").trim();
  }

  function getSelectedFormatPreviewModel() {
    const fromSelect = String(els.modelSelect?.value || "").trim();
    if (fromSelect) return fromSelect;
    try {
      const active = global.WpsAiProviderRegistry?.parseActiveChatModel?.(currentSettings?.activeChatModel || "");
      if (active?.modelId) return active.modelId;
    } catch (e) {}
    return global.WpsAiOpenAI.getDefaultModel();
  }

  // 按每批最多 N 段 / M 字符切片。返回 [{ startIdx, paragraphs }]。
  function chunkParagraphsForFormat(paragraphs, maxParagraphs, maxChars) {
    const chunks = [];
    let i = 0;
    while (i < paragraphs.length) {
      let end = i;
      let charCount = 0;
      while (end < paragraphs.length) {
        // 每段前缀 "<idx>: " 也算，粗略按段落文本长度 + 6
        const add = paragraphs[end].length + 8;
        if (end > i && (charCount + add > maxChars || end - i >= maxParagraphs)) break;
        charCount += add;
        end += 1;
      }
      chunks.push({ startIdx: i, paragraphs: paragraphs.slice(i, end) });
      i = end;
    }
    return chunks;
  }

  // 走一批 AI 排版 —— 流式拉 JSON，用括号计数器抽出 block 增量渲染到 formatPreviewContent。
  // 返回该批的 blocks 数组，sourceIndex 是"批内相对索引"（0-based），由调用方加偏移换成全局。
  async function runFormatChunkStream({ chunkParagraphs, requirement, chunkLabel, totalParagraphs, globalStartIdx }) {
    // P0-1 风险画像：结构敏感段落（表格样/编号密集/签署栏/符号密集）打标，
    // 提示 AI 原样保留 text，只判断样式类型——防止表格被拆、编号被改写。
    const riskAssess = global.WpsAiFormatRisk?.isSensitive;
    const indexed = chunkParagraphs.map((p, i) => {
      const tag = (riskAssess && riskAssess(p)) ? " [结构敏感]" : "";
      return `${i}${tag}: ${p}`;
    }).join("\n");
    const system = [
      "你是 WPS 文字文档排版助手。你只负责判断每个原文段落应该套用哪种富文本样式，不改写正文。",
      "必须只输出 JSON 对象，不要 markdown，不要解释。",
      "JSON 格式：{\"blocks\":[{\"sourceIndex\":0,\"type\":\"title|subtitle|heading|paragraph|bullet|numbered|quote\",\"level\":1,\"text\":\"原段落文字\"}]}",
      "规则：text 尽量保持原文原句；只能去掉明显的编号前缀；不要合并、不要新增事实、不要输出 markdown 语法。",
      "带 [结构敏感] 标注的段落（表格样 / 编号密集 / 签署栏 / 符号密集）：text 必须一字不改原样返回（包括编号、下划线、分隔符），禁止拆分、合并或改写；type 仍按内容判断，markdown 表格行仍按下面的表格规则处理。",
      "heading 的 level 取 1-4；普通正文用 paragraph；项目符号用 bullet；编号条目用 numbered。",
      "遇到 markdown 表格行（以 | 开头、用 | 分隔单元格，含 | --- | 这样的分隔行）：每一行都单独作为一个 block、type=paragraph、text 原样保留整行（包括 | 和 | --- | 分隔行），不要改写、不要合并成一段、不要删掉分隔行——后续会自动合并成真正的表格。",
      chunkLabel
        ? `注意：本批只是全文的一部分（${chunkLabel}），请只对给出的段落判断样式；未给出的段落不要凭空生成 block。sourceIndex 用批内的 0-based 索引。`
        : "",
      requirement
        ? `用户排版要求：${requirement}`
        : "用户未填写排版要求。请先根据原文内容识别文档类型（合同 / 招标文件 / 公文报告 / 通知 / 论文 / 方案 / 简历 / 普通文档 等），再按该类型的常规排版规范处理。"
    ].filter(Boolean).join("\n");

    const messagesForFormat = [
      { role: "system", content: system },
      { role: "user", content: `请给下面段落生成排版结构 JSON：\n\n${indexed}` }
    ];
    let raw = "";
    let tokensFiredFmt = false;
    let lastTick = 0;
    // 每批重新计数，DOM 里前批 append 的 block 保留
    let streamCommittedCount = 0;
    let streamActiveEl = null;
    const onTokenFmt = (_delta, fullText) => {
      tokensFiredFmt = true;
      raw = fullText;
      const now = Date.now();
      if (now - lastTick < 50) return;
      lastTick = now;
      if (!els.formatPreviewContent) return;

      const committed = extractStreamingFormatBlocks(fullText);
      while (streamCommittedCount < committed.length) {
        const block = committed[streamCommittedCount];
        const finalEl = createStreamingBlockEl(block);
        if (streamActiveEl) {
          streamActiveEl.replaceWith(finalEl);
          streamActiveEl = null;
        } else {
          els.formatPreviewContent.appendChild(finalEl);
        }
        streamCommittedCount += 1;
      }

      const active = extractActiveStreamingBlock(fullText);
      if (active && active.text) {
        if (!streamActiveEl) {
          streamActiveEl = createStreamingBlockEl(active);
          streamActiveEl.classList.add("is-streaming-active");
          els.formatPreviewContent.appendChild(streamActiveEl);
        } else {
          streamActiveEl = updateStreamingBlockEl(streamActiveEl, active);
        }
      } else if (streamActiveEl && !active) {
        streamActiveEl.remove();
        streamActiveEl = null;
      }

      try { els.formatPreviewContent.scrollTop = els.formatPreviewContent.scrollHeight; } catch (e) {}
      if (els.formatPreviewMeta) {
        const globalDone = (globalStartIdx || 0) + committed.length;
        els.formatPreviewMeta.textContent = chunkLabel
          ? `${chunkLabel}：已完成 ${committed.length} / ${chunkParagraphs.length} 段（全文 ${globalDone} / ${totalParagraphs}）`
          : (committed.length
              ? `正在生成… 已完成 ${committed.length} / ${chunkParagraphs.length} 段`
              : `正在接收排版结构…已收到 ${fullText.length} 字符`);
      }
    };
    let fmtLastErr = null;
    let fmtOk = false;
    for (let attempt = 1; attempt <= MAX_CHAT_RETRY_ATTEMPTS; attempt += 1) {
      tokensFiredFmt = false;
      raw = "";
      try {
        raw = await global.WpsAiOpenAI.streamChatCompletion({
          model: getSelectedFormatPreviewModel(),
          messages: messagesForFormat,
          temperature: 0.1,
          onToken: onTokenFmt
        });
        fmtOk = true;
        break;
      } catch (streamErr) {
        fmtLastErr = streamErr;
        const m = String(streamErr?.message || streamErr || "");
        const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(m);
        if (noStream) break;
        if (tokensFiredFmt) break;
        if (!isRetryableChatError(streamErr) || attempt >= MAX_CHAT_RETRY_ATTEMPTS) break;
        try { await global.WpsAiRuntime?.reprobe?.(); } catch (re) {}
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const seconds = Math.max(1, Math.round(delay / 1000));
        showMessage(`生成排版预览失败（${humanizePreviewError(streamErr).slice(0, 80)}），${seconds}s 后自动重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`, "info", { duration: Math.max(delay, 3000) });
        if (els.formatPreviewMeta) els.formatPreviewMeta.textContent = `正在重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (!fmtOk) {
      const m = String(fmtLastErr?.message || fmtLastErr || "");
      const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(m);
      if (noStream) {
        raw = await global.WpsAiOpenAI.chatCompletion({
          model: getSelectedFormatPreviewModel(),
          messages: messagesForFormat,
          temperature: 0.1
        });
      } else if (fmtLastErr) {
        throw fmtLastErr;
      }
    }
    const parsed = parseJsonObjectLoose(raw);
    return Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  }

  async function generateFormatPreview(options = {}) {
    try {
      if ((currentHostInfo?.host || "") !== "wps") {
        try { currentHostInfo = await global.WpsAiDocument.getHostInfo(); } catch (e) {}
      }
      if (!isFormatPreviewDialog && currentHostInfo?.host !== "wps") {
        showMessage("AI 排版目前只支持 WPS 文字文档。", "error");
        return;
      }
      // 结构化读取（保表格 / 图片）：如果宿主支持 readDocumentStructure，就走它 —— AI
      // 只处理 editable 段落，应用时表格 / 图片按 Range 跳过。宿主不支持或读失败退回
      // 老路径（readDocumentText + 全文替换，会丢表格但至少不 crash）。
      // 关键：结构化读取必须在弹窗模式下也跑。之前只有 options.text == null 才读，dialog
      // 走 openFormatPreviewAsDialog 时 options.text 已经从主窗口通过 localStorage 传过来
      // （readDocumentText 的扁平结果），条件短路 → structure 永远 null → 走扁平路径 →
      // 表格被 AI 当正文重排。改成：只要宿主支持 readDocumentStructure 就调（弹窗跑在同一
      // WPS 进程，WpsAiHostWriter 一样可用）。这是修 .wps / .docx 表格漏检的最后一环。
      // 排版范围：selection = 只排选中区域。选区是文本片段，结构化（保表格/图片）路径
      // 是全文粒度的，对选区不适用——选区按软换行切段走扁平路径，替换时用 start/end
      // 定位 Range 只动选中部分，文档其余内容完全不碰。
      const fmtScope = formatPreviewScope();
      const scopeSelection = fmtScope === "selection" ? formatPreviewState?.selection : null;
      let structure = null;
      try {
        if (!scopeSelection && global.WpsAiHostWriter?.readDocumentStructure) {
          structure = await global.WpsAiHostWriter.readDocumentStructure();
        }
      } catch (e) {
        try { global.WpsAiLog?.log?.("fmt:read-structure-error", e?.message || String(e)); } catch (_) {}
      }
      // useStructure 判据从 editable.length 改成 segments.length：
      // 之前"没有 editable 段"就退到 readDocumentText 老路径，纯表格文档 editable 为空，
      // 老路径会把表格文本当扁平正文送 AI → AI 拆成一行行 → 预览显示表格拆开的"乱码"。
      // 只要 structure 有 segments 就走结构化路径，即使 editable 为空也 OK。
      // 结构路径的价值是「保留表格/图片/空段原样」。若没有可保留的段（segments 全是正文 editable），
      // 就别走结构路径——否则「整篇是一个软换行(Shift+Enter)段落」会被当成 1 段，AI 只排 1 块、替换也
      // 只写 1 块。此时用「全文按软换行切分 + 全文替换」更稳（splitDocumentParagraphs 已按软换行切开）。
      const hasPreservable = !!(structure && Array.isArray(structure.segments) && Array.isArray(structure.editable)
        && structure.segments.length > structure.editable.length);
      const useStructure = !!(structure && Array.isArray(structure.segments) && structure.segments.length && hasPreservable);
      try { global.WpsAiLog?.log?.("fmt:use-structure", { useStructure, hasStructure: !!structure, segments: structure?.segments?.length || 0, editable: structure?.editable?.length || 0, tables: structure?.tables?.length || 0 }); } catch (_) {}
      const text = scopeSelection
        ? String(scopeSelection.text || "")
        : (options.text != null
          ? String(options.text || "")
          : (formatPreviewState?.docSourceText || formatPreviewState?.sourceText || (useStructure ? structure.editable.map((e) => e.text).join("\n\n") : await global.WpsAiHostWriter?.readDocumentText?.())));
      const paragraphs = scopeSelection
        ? splitDocumentParagraphs(text)
        : (Array.isArray(options.paragraphs) && options.paragraphs.length
          ? options.paragraphs
          : (useStructure ? structure.editable.map((e) => e.text) : splitDocumentParagraphs(text)));
      if (!paragraphs.length) {
        showMessage(scopeSelection ? "选中区域没有可排版的正文。" : "当前文档没有可排版的正文。", "error");
        return;
      }
      const requirement = options.requirement != null ? String(options.requirement || "") : formatPreviewRequirement();
      formatPreviewState = {
        sourceText: text,
        paragraphs,
        // 保留全文文本/段落 + 选区/范围信息，供切换范围与替换阶段使用
        docSourceText: formatPreviewState?.docSourceText || (scopeSelection ? "" : text),
        docParagraphs: formatPreviewState?.docParagraphs || (scopeSelection ? [] : paragraphs),
        selection: formatPreviewState?.selection || null,
        templateId: formatPreviewState?.templateId || currentFormatTemplateId(),
        scope: fmtScope,
        // 存下 structure，应用时 replaceParagraphsInPlace 用；老路径 / 选区范围下就是 null
        structure: (!scopeSelection && useStructure) ? structure : null,
        requirement,
        blocks: formatPreviewState?.blocks || []
      };
      els.formatPreviewModal?.classList.remove("hidden");
      if (els.formatPreviewPromptInput && options.requirement != null) els.formatPreviewPromptInput.value = requirement;
      // 保留表格提示：结构化路径下告诉用户"另外还有 N 处表格 / 图片会被保留原样"
      const preservedCount = useStructure ? (structure.segments.length - structure.editable.length) : 0;
      if (els.formatPreviewMeta) {
        els.formatPreviewMeta.textContent = preservedCount > 0
          ? `正在分析 ${paragraphs.length} 个段落…（另 ${preservedCount} 处表格 / 图片 / 空段将原样保留）`
          : `正在分析 ${paragraphs.length} 个段落…`;
      }
      if (els.formatPreviewContent) els.formatPreviewContent.innerHTML = "";
      clearFormatPreviewImpact();
      setFormatPreviewBusy(true, "正在生成排版预览…");
      updateFormatPreviewActionLabel();

      // 长文分批：之前 paragraphs.length > 180 或 indexed.length > 30000 直接退到本地规则
      // fallback，AI 完全没参与，用户看到的排版没那么智能。改成"自动拆分排版任务"：
      // 按每批 CHUNK_MAX_PARAGRAPHS 段 / CHUNK_MAX_CHARS 字符切片，串行走多轮 AI 调用，
      // 每批 sourceIndex 是批内相对索引，回来后加偏移换成全局，最后合并 + normalize。
      // 提示信息实时显示 "第 M/N 批"。
      const CHUNK_MAX_PARAGRAPHS = 60;
      const CHUNK_MAX_CHARS = 12000;
      const chunks = chunkParagraphsForFormat(paragraphs, CHUNK_MAX_PARAGRAPHS, CHUNK_MAX_CHARS);

      if (els.formatPreviewContent) {
        els.formatPreviewContent.innerHTML = "";
        els.formatPreviewContent.classList.add("is-streaming");
      }

      const allBlocks = [];
      // 记录每批 wall-time，用于估计剩余耗时（前 K 批的平均 × 剩余批数）
      const chunkTimings = [];
      const formatStartAt = Date.now();
      for (let ci = 0; ci < chunks.length; ci += 1) {
        const chunk = chunks[ci];
        const chunkStartAt = Date.now();
        const chunkLabel = chunks.length > 1
          ? `第 ${ci + 1}/${chunks.length} 批（${chunk.paragraphs.length} 段）`
          : "";
        // 每批 AI 拿到的 sourceIndex 是"批内相对索引"（0-based），返回后加 chunk.startIdx 换成全局
        const chunkBlocks = await runFormatChunkStream({
          chunkParagraphs: chunk.paragraphs,
          requirement,
          chunkLabel,
          totalParagraphs: paragraphs.length,
          // 让流式渲染的 sourceIndex 显示成全局，方便肉眼对齐原文段落号
          globalStartIdx: chunk.startIdx
        });
        chunkTimings.push(Date.now() - chunkStartAt);
        chunkBlocks.forEach((b) => {
          if (Number.isInteger(b?.sourceIndex)) b.sourceIndex += chunk.startIdx;
        });
        allBlocks.push(...chunkBlocks);
        if (els.formatPreviewMeta && chunks.length > 1) {
          // 预计剩余：拿已完成批次的平均耗时估计剩下的
          const done = ci + 1;
          const left = chunks.length - done;
          let etaStr = "";
          if (left > 0 && chunkTimings.length) {
            const avg = chunkTimings.reduce((s, x) => s + x, 0) / chunkTimings.length;
            const etaMs = Math.round(avg * left);
            etaStr = etaMs < 1000 ? " · 预计剩余 <1s" : ` · 预计剩余 ~${Math.round(etaMs / 1000)}s`;
          }
          els.formatPreviewMeta.textContent = `已处理 ${done}/${chunks.length} 批 · ${allBlocks.length} 段${etaStr}`;
        }
      }

      const parsed = { blocks: allBlocks, requirement };
      // 先 normalize 成逐段 block，再把连续的 markdown 表格行合并成 table block
      const blocks = mergeMarkdownTables(normalizeFormatBlocks(parsed, paragraphs));
      formatPreviewState.blocks = blocks;
      renderFormatPreviewBlocks(blocks);
      renderFormatPreviewImpact(blocks, formatPreviewState.structure);
      // 收尾：去掉"流式中"样式
      if (els.formatPreviewContent) els.formatPreviewContent.classList.remove("is-streaming");
      if (els.formatPreviewMeta) {
        const preservedCount2 = formatPreviewState.structure
          ? (formatPreviewState.structure.segments.length - formatPreviewState.structure.editable.length)
          : 0;
        els.formatPreviewMeta.textContent = preservedCount2 > 0
          ? `已生成 ${blocks.length} 段富文本 · 应用时将保留 ${preservedCount2} 处表格 / 图片。`
          : (formatPreviewScope() === "selection"
            ? `已生成 ${blocks.length} 个富文本段落，确认后只替换选中区域。`
            : `已生成 ${blocks.length} 个富文本段落，确认后可替换全文。`);
      }
      setFormatPreviewBusy(false);
      updateFormatPreviewActionLabel();
      showMessage("AI 排版预览已生成。", "success");
    } catch (e) {
      const paragraphs = formatPreviewState?.paragraphs || [];
      const fallback = inferFallbackFormatBlocks(paragraphs, formatPreviewRequirement());
      if (fallback.length) {
        formatPreviewState.blocks = fallback;
        renderFormatPreviewBlocks(fallback);
        renderFormatPreviewImpact(fallback, formatPreviewState.structure);
        if (els.formatPreviewMeta) els.formatPreviewMeta.textContent = "AI 输出解析失败，已生成本地规则预览。";
      }
      if (els.formatPreviewContent) els.formatPreviewContent.classList.remove("is-streaming");
      setFormatPreviewBusy(false);
      updateFormatPreviewActionLabel();
      showMessage(`生成排版预览失败：${humanizePreviewError(e)}`, "error");
    }
  }

  // P2-6 导出为新 Word 文件：不动当前文档，把排版结果（含模板编号）另存 .doc。
  async function exportFormatPreviewAsDoc() {
    const t = global.WpsAiI18n?.t || ((s) => s);
    let blocks = formatPreviewState?.blocks || [];
    if (!blocks.length) { showMessage(t("没有可导出的排版内容。"), "error"); return; }
    try {
      const T = global.WpsAiFormatTemplates;
      const numbering = T?.getById?.(currentFormatTemplateId())?.numbering;
      if (numbering && (numbering.h1 || numbering.h2)) blocks = T.applyHeadingNumbering(blocks, numbering);
      const html = global.WpsAiHostWriter?.blocksToHtml?.(blocks);
      if (!html) throw new Error(t("HTML 渲染不可用。"));
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const resp = await fetch(base + "/export-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, fileName: t("文小舟 排版导出") })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload.ok) throw new Error(payload.error || `HTTP ${resp.status}`);
      showMessage(`${t("已导出为 Word 文件")}：${payload.path}`, "success", { duration: 10000 });
    } catch (e) {
      showMessage(`${t("导出失败")}：${e?.message || e}`, "error");
    }
  }

  async function replaceDocumentWithFormatPreview() {
    if (!formatPreviewState?.blocks?.length) {
      showMessage("没有可替换的排版内容。", "error");
      return;
    }
    const isSelectionScope = formatPreviewScope() === "selection" && !!formatPreviewState?.selection;
    if (!confirm(isSelectionScope
      ? i18nT("确认用预览内容替换选中区域？此操作只覆盖选中部分的排版。")
      : i18nT("确认用预览内容替换当前文档全文？此操作会覆盖原文排版。"))) return;
    if (isFormatPreviewDialog) {
      try {
        localStorage.setItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({
          ts: Date.now(),
          cancelled: false,
          blocks: formatPreviewState.blocks,
          requirement: formatPreviewRequirement(),
          // 排版模板：主窗口消费时按 id 解析 styleMap 传给写入路径
          templateId: currentFormatTemplateId(),
          // 选区范围：主窗口消费时按 start/end 定位 Range 只替换选中部分
          scope: isSelectionScope ? "selection" : "doc",
          selection: isSelectionScope ? { start: formatPreviewState.selection.start, end: formatPreviewState.selection.end } : null
        }));
        formatPreviewDialogResultWritten = true;
        showMessage("已提交替换任务。", "info");
        setTimeout(() => { try { if (typeof window.close === "function") window.close(); } catch (e) {} }, 0);
      } catch (e) {
        showMessage(`提交替换任务失败：${e?.message || e}`, "error");
      }
      return;
    }
    try {
      // 选区范围：用打开时记录的 start/end 定位 Range 替换，文档其余内容不动。
      if (isSelectionScope) {
        setFormatPreviewBusy(true, "正在替换选中区域…");
        const selBlocksCount = formatPreviewState.blocks?.length || 0;
        const selRange = { start: formatPreviewState.selection.start, end: formatPreviewState.selection.end };
        await recordPreviewModification({
          turnLabel: "AI 排版（选中区域）",
          toolName: "wps_replace_selection",
          params: { scope: "selection", source: "formatPreview", blocks: selBlocksCount, range: selRange },
          summary: `AI 排版：替换选中区域为 ${selBlocksCount} 个富文本段落`,
          modifyFn: async () => {
            await global.WpsAiHostWriter.replaceRangeText(selRange, formatPreviewState.blocks);
          }
        });
        setFormatPreviewBusy(false);
        closeFormatPreviewModal();
        renderHistory();
        showMessage("已按预览排版替换选中区域。", "success");
        return;
      }
      setFormatPreviewBusy(true, "正在替换全文…");
      const blocksCount = formatPreviewState.blocks?.length || 0;
      const structure = formatPreviewState.structure;
      // 优先走"分段范围替换"：只动 kind=paragraph 的段落，表格 / 图片 / 空段 Range 完全
      // 跳过，保住原样。只有当结构化读取没成功（老宿主 / 读失败）时才退到全文 HTML 替换
      // 老路径（会丢表格 —— 但至少能替）。
      const hasPreservable = !!(structure && Array.isArray(structure.segments) && Array.isArray(structure.editable) && structure.segments.length > structure.editable.length);
      const canPreserve = !!(hasPreservable && global.WpsAiHostWriter?.replaceParagraphsInPlace);
      await recordPreviewModification({
        turnLabel: canPreserve ? "AI 排版（保留表格/图片）" : "AI 排版替换全文",
        toolName: "wps_replace_selection",
        params: {
          scope: canPreserve ? "editableParagraphs" : "document",
          source: "formatPreview",
          blocks: blocksCount,
          preserved: canPreserve ? (structure.segments.length - structure.editable.length) : 0
        },
        summary: canPreserve
          ? `AI 排版：替换 ${blocksCount} 段正文，保留 ${structure.segments.length - structure.editable.length} 个表格 / 图片 / 空段`
          : `AI 排版：替换全文 ${blocksCount} 个富文本段落`,
        modifyFn: async () => {
          // 有表格 block 时必须走 COM 路径（replaceDocumentBlocks 用 Tables.Add 建原生表格）；
          // HTML InsertFile 在 WPS 里会把 <table> 连同后面内容一起丢掉，只剩标题。
          // 排版模板样式/编号/页面设置只在 COM 路径生效——带模板时也强制 COM。
          const writeOpts = global.WpsAiFormatTemplates?.resolveWriteOptions?.(currentFormatTemplateId()) || { styleMap: null };
          const styleMap = writeOpts.styleMap;
          const hasTable = (formatPreviewState.blocks || []).some((b) => b && b.type === "table");
          if (canPreserve) {
            await global.WpsAiHostWriter.replaceParagraphsInPlace(structure.segments, formatPreviewState.blocks, writeOpts);
          } else if (!hasTable && !styleMap && !writeOpts.numbering && !writeOpts.page && global.WpsAiHostWriter?.replaceDocumentBlocksHtml) {
            await global.WpsAiHostWriter.replaceDocumentBlocksHtml(formatPreviewState.blocks);
          } else {
            await global.WpsAiHostWriter?.replaceDocumentBlocks?.(formatPreviewState.blocks, writeOpts);
          }
        }
      });
      setFormatPreviewBusy(false);
      closeFormatPreviewModal();
      renderHistory();
      showMessage(canPreserve
        ? `已按预览排版替换正文（保留 ${structure.segments.length - structure.editable.length} 处表格 / 图片）。`
        : "已按预览排版替换全文。", "success");
    } catch (e) {
      setFormatPreviewBusy(false);
      showMessage(`替换全文失败：${e?.message || e}`, "error");
    }
  }

  async function openFormatPreviewAsDialog() {
    try {
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
      if (currentHostInfo?.host !== "wps") {
        showMessage("AI 排版目前只支持 WPS 文字文档。", "error");
        return;
      }
      const text = await global.WpsAiHostWriter?.readDocumentText?.();
      const paragraphs = splitDocumentParagraphs(text);
      if (!paragraphs.length) {
        showMessage("当前文档没有可排版的正文。", "error");
        return;
      }
      // 抓当前选区（有效才带上）：弹窗里可选「仅排版选中区域」。
      // 必须在 ShowDialog 之前抓——之后焦点进弹窗，主窗口再读选区不可靠。
      let selection = null;
      try { selection = await global.WpsAiHostWriter?.readSelectionInfo?.(); } catch (e) {}
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=formatpreview`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        try {
          localStorage.setItem(FORMAT_PREVIEW_DIALOG_REQUEST_KEY, JSON.stringify({
            ts: Date.now(),
            text,
            paragraphs,
            selection
          }));
          localStorage.removeItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY);
        } catch (e) {}
        const { w, h } = pickDialogSize(1080, 760, { minW: 820, minH: 560 });
        app.ShowDialog(url, i18nDialogTitle("排版预览"), w, h, true);
        consumeFormatPreviewDialogResult();
        startFormatPreviewDialogResultPolling();
        return;
      }
      bindFormatPreviewModal();
      prepareFormatPreview({ text, paragraphs, selection });
    } catch (e) {
      console.warn("[format-preview] ShowDialog 失败，回退到 inline modal:", e?.message || e);
      showMessage(`打开 AI 排版预览失败：${e?.message || e}`, "error");
    }
  }

  async function consumeFormatPreviewDialogResult() {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let result = null;
    try { result = JSON.parse(raw); } catch (e) {}
    try { localStorage.removeItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
    if (!result || result.cancelled) return false;
    if (!Array.isArray(result.blocks) || !result.blocks.length) {
      showMessage("排版预览结果为空。", "error");
      return false;
    }
    // 选区范围：dialog 回传了 scope=selection + start/end。弹窗是模态的，期间文档没动，
    // 位置依然有效，直接 Range(start,end) 替换，不读结构、不碰其余内容。
    if (result.scope === "selection" && result.selection && Number(result.selection.end) > Number(result.selection.start)) {
      try {
        setFormatPreviewBusy(true, "正在替换选中区域…");
        const selRange = { start: Number(result.selection.start), end: Number(result.selection.end) };
        await recordPreviewModification({
          turnLabel: "AI 排版（选中区域）",
          toolName: "wps_replace_selection",
          params: { scope: "selection", source: "formatPreview", blocks: result.blocks.length, range: selRange },
          summary: `AI 排版：替换选中区域为 ${result.blocks.length} 个富文本段落`,
          modifyFn: async () => {
            await global.WpsAiHostWriter.replaceRangeText(selRange, result.blocks);
          }
        });
        setFormatPreviewBusy(false);
        renderHistory();
        showMessage("已按预览排版替换选中区域。", "success");
        return true;
      } catch (e) {
        setFormatPreviewBusy(false);
        showMessage(`替换选中区域失败：${e?.message || e}`, "error");
        return false;
      }
    }
    try {
      setFormatPreviewBusy(true, "正在替换全文…");
      const blocksCount = result.blocks.length;
      // 关键：主窗口这里也要重读一次 structure —— dialog 只回传了 blocks，没带 segments。
      // 之前主窗口直接走 replaceDocumentBlocksHtml 全文清洗重建 → 表格 / 图片全丢。
      // 文档在 dialog 期间没被改动（用户只在弹窗里看预览），重读的结构跟 dialog 里生成
      // 时一致，可以直接喂给 replaceParagraphsInPlace 做"只动 paragraph、跳过 table/image"
      // 的分段替换。
      let structure = null;
      try {
        if (global.WpsAiHostWriter?.readDocumentStructure) {
          structure = await global.WpsAiHostWriter.readDocumentStructure();
        }
      } catch (e) {
        try { global.WpsAiLog?.log?.("fmt:consume-read-structure-error", e?.message || String(e)); } catch (_) {}
      }
      // 只有存在「要保留的段」（表格/图片/空段，即 segments 多于 editable）才走分段保留替换；
      // 否则（整篇是一个软换行段落这种退化情况）分段替换会把整段折成第一个 block（只剩标题）。
      const hasPreservable = !!(structure && Array.isArray(structure.segments) && Array.isArray(structure.editable) && structure.segments.length > structure.editable.length);
      const canPreserve = !!(hasPreservable && global.WpsAiHostWriter?.replaceParagraphsInPlace);
      try { global.WpsAiLog?.log?.("fmt:consume-canPreserve", { canPreserve, hasPreservable, hasStructure: !!structure, segments: structure?.segments?.length || 0, editable: structure?.editable?.length || 0 }); } catch (_) {}
      await recordPreviewModification({
        turnLabel: canPreserve ? "AI 排版（保留表格/图片）" : "AI 排版替换全文",
        toolName: "wps_replace_selection",
        params: {
          scope: canPreserve ? "editableParagraphs" : "document",
          source: "formatPreview",
          blocks: blocksCount,
          preserved: canPreserve ? (structure.segments.length - structure.editable.length) : 0
        },
        summary: canPreserve
          ? `AI 排版：替换 ${blocksCount} 段正文，保留 ${structure.segments.length - structure.editable.length} 个表格 / 图片 / 空段`
          : `AI 排版：替换全文 ${blocksCount} 个富文本段落`,
        modifyFn: async () => {
          // 有表格时走 COM 路径（HTML InsertFile 在 WPS 里会丢表格，只剩标题）；
          // dialog 回传了排版模板 id → 解析完整写入选项（样式/编号/页面），带模板时也强制 COM
          const writeOpts = global.WpsAiFormatTemplates?.resolveWriteOptions?.(result.templateId || "") || { styleMap: null };
          const styleMap = writeOpts.styleMap;
          const hasTable = (result.blocks || []).some((b) => b && b.type === "table");
          if (canPreserve) {
            await global.WpsAiHostWriter.replaceParagraphsInPlace(structure.segments, result.blocks, writeOpts);
          } else if (!hasTable && !styleMap && !writeOpts.numbering && !writeOpts.page && global.WpsAiHostWriter?.replaceDocumentBlocksHtml) {
            await global.WpsAiHostWriter.replaceDocumentBlocksHtml(result.blocks);
          } else {
            await global.WpsAiHostWriter?.replaceDocumentBlocks?.(result.blocks, writeOpts);
          }
        }
      });
      setFormatPreviewBusy(false);
      renderHistory();
      showMessage(canPreserve
        ? `已按预览排版替换正文（保留 ${structure.segments.length - structure.editable.length} 处表格 / 图片）。`
        : "已按预览排版替换全文。", "success");
      return true;
    } catch (e) {
      setFormatPreviewBusy(false);
      showMessage(`替换全文失败：${e?.message || e}`, "error");
      return false;
    }
  }

  let formatPreviewDialogPollTimer = null;
  function startFormatPreviewDialogResultPolling() {
    if (isAnyDialogWindow()) return;
    if (formatPreviewDialogPollTimer) clearInterval(formatPreviewDialogPollTimer);
    let ticks = 0;
    formatPreviewDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeFormatPreviewDialogResult();
      if (ticks >= 600) {
        clearInterval(formatPreviewDialogPollTimer);
        formatPreviewDialogPollTimer = null;
      }
    }, 500);
  }

  function bindFormatPreviewModal() {
    if (formatPreviewBound) return;
    formatPreviewBound = true;
    els.formatPreviewCloseBtn?.addEventListener("click", closeFormatPreviewModal);
    els.formatPreviewCancelBtn?.addEventListener("click", closeFormatPreviewModal);
    els.formatPreviewRegenerateBtn?.addEventListener("click", () => generateFormatPreview());
    els.formatPreviewReplaceBtn?.addEventListener("click", replaceDocumentWithFormatPreview);
    els.formatPreviewExportBtn?.addEventListener("click", exportFormatPreviewAsDoc);
    els.formatPreviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.formatPreviewModal) closeFormatPreviewModal();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && els.formatPreviewModal && !els.formatPreviewModal.classList.contains("hidden")) {
        closeFormatPreviewModal();
      }
    });
  }

  // ---------------- WPS 选区翻译/优化预览 ----------------

  let selectionPreviewState = null;
  let selectionPreviewBound = false;
  let selectionPreviewDialogResultWritten = false;
  let selectionPreviewDialogPollTimer = null;
  let lastSelectionPreviewResultTs = 0;

  function isAnyDialogWindow() {
    return isPreviewDialog || isSettingsDialog || isStylePresetDialog || isMaterialsDialog
      || isQuickPromptDialog || isFormatPreviewDialog || isSelectionPreviewDialog || isParallelTranslateDialog;
  }

  function selectionPreviewIntentLabel(intent, tone) {
    if (intent === "translate") return "翻译";
    if (intent === "tone") return String(tone || "改写").trim() || "改写";
    if (intent === "documentRewrite") return String(tone || "全文润色").trim() || "全文润色";
    if (intent === "documentReport") return String(tone || "文档报告").trim() || "文档报告";
    return "优化";
  }

  function selectionPreviewTargetLanguage() {
    const value = String(els.selectionPreviewLanguageSelect?.value || "简体中文").trim();
    const custom = String(els.selectionPreviewCustomLanguageInput?.value || "").trim();
    return value === "custom" ? custom : value;
  }

  function selectionPreviewInstruction() {
    return String(els.selectionPreviewInstructionInput?.value || "").trim();
  }

  function selectedSelectionPreviewModel() {
    return getSelectedFormatPreviewModel();
  }

  // 当 listFormat 存在时按 <ul>/<ol> 渲染；否则按段落渲染。list 场景下按单行拆分，
  // 保证 AI 扩写生成的多行也每行一个 <li>；非 list 场景保留原有"按空行分段"的行为。
  function selectionPreviewParagraphHtml(text, listFormat) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (listFormat && listFormat.kind) {
      const items = normalized.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const tag = listFormat.kind === "numbered" ? "ol" : "ul";
      const lis = items.map((it) => `<li>${escapeHtmlSafe(it)}</li>`).join("");
      return `<${tag} class="selection-preview-list selection-preview-list-${listFormat.kind}">${lis}</${tag}>`;
    }
    const parts = normalized.split(/\n{2,}/);
    return parts.map((part) => `<p>${escapeHtmlSafe(part.trim() || " ")}</p>`).join("");
  }

  function renderSelectionPreviewTexts() {
    // 原文和 AI 输出都按同一 listFormat 渲染 —— 用户视觉一致
    const listFormat = selectionPreviewState?.listFormat || null;
    if (els.selectionPreviewOriginal) {
      els.selectionPreviewOriginal.innerHTML = selectionPreviewParagraphHtml(selectionPreviewState?.sourceText || "", listFormat);
    }
    if (els.selectionPreviewResult) {
      // documentReport 输出是 markdown（含标题/列表），用 markdown 渲染更好读；
      // 其它 intent 输出是纯文本（替换用），按段落 / 列表渲染避免误解析。
      const result = String(selectionPreviewState?.resultText || "");
      const intent = selectionPreviewState?.intent;
      if (intent === "documentReport" && global.WpsAiMarkdown?.renderToHtml && result) {
        els.selectionPreviewResult.innerHTML = global.WpsAiMarkdown.renderToHtml(result);
      } else {
        els.selectionPreviewResult.innerHTML = selectionPreviewParagraphHtml(result, listFormat);
      }
    }
    renderSelectionPreviewDiff();
  }

  // ==== documentReport / 脑图问答 结果持久化：关掉弹窗再点开也能看到上次生成的内容 ====
  // 按「文档内容哈希」为键，文档没变就恢复上次结果；文档变了自然是新键，不会错配。
  function _hashStr(s) {
    let h = 0;
    const str = String(s == null ? "" : s);
    for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ":" + str.length;
  }
  function _cacheReadObj(key) { try { return JSON.parse(global.WpsAiStore.getItem(key) || "{}") || {}; } catch (e) { return {}; } }
  function _cacheTrim(all, max) {
    const keys = Object.keys(all);
    if (keys.length <= max) return all;
    keys.sort((a, b) => (all[a]?.ts || 0) - (all[b]?.ts || 0)).slice(0, keys.length - max).forEach((k) => delete all[k]);
    return all;
  }
  const DOC_REPORT_CACHE_KEY = "lingxi_doc_report_cache_v1";
  function docReportKey(reportKind, sourceText) { return String(reportKind || "") + "::" + _hashStr(sourceText); }
  function docReportCacheGet(reportKind, sourceText) {
    return _cacheReadObj(DOC_REPORT_CACHE_KEY)[docReportKey(reportKind, sourceText)] || null;
  }
  function saveDocReportCacheIfNeeded() {
    const st = selectionPreviewState;
    if (!st || st.intent !== "documentReport" || !st.resultText) return;
    try {
      const all = _cacheReadObj(DOC_REPORT_CACHE_KEY);
      all[docReportKey(st.reportKind, st.sourceText)] = { resultText: String(st.resultText), ts: Date.now() };
      _cacheTrim(all, 20);
      global.WpsAiStore.setItem(DOC_REPORT_CACHE_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  const MINDMAP_QA_CACHE_KEY = "lingxi_mindmap_qa_v1";
  function mindmapQaGet(ctxMarkdown) { return _cacheReadObj(MINDMAP_QA_CACHE_KEY)[_hashStr(ctxMarkdown)]?.history || []; }
  function mindmapQaSet(ctxMarkdown, history) {
    try {
      const all = _cacheReadObj(MINDMAP_QA_CACHE_KEY);
      all[_hashStr(ctxMarkdown)] = { history: history.slice(-12), ts: Date.now() };
      _cacheTrim(all, 20);
      global.WpsAiStore.setItem(MINDMAP_QA_CACHE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  // 文档脑图：生成完成后把 markdown 大纲渲染成可视化脑图（markmap，离线内置），带「脑图 / 大纲」切换。
  let _mmInstance = null;
  function disposeMindmapChart() {
    if (_mmInstance) { try { _mmInstance.destroy(); } catch (e) {} _mmInstance = null; }
  }
  function ensureMarkmapCss() {
    try {
      if (document.getElementById("markmap-global-css")) return;
      const css = global.markmap?.globalCSS;
      if (!css) return;
      const style = document.createElement("style");
      style.id = "markmap-global-css";
      style.textContent = css;
      document.head.appendChild(style);
    } catch (e) {}
  }
  function maybeRenderMindmap() {
    const st = selectionPreviewState;
    if (!st || st.intent !== "documentReport" || st.reportKind !== "mindmap") return;
    const md = String(st.resultText || "").trim();
    if (md) renderMindmapInResult(md);
  }
  async function renderMindmapInResult(markdown) {
    const host = els.selectionPreviewResult;
    if (!host) return;
    disposeMindmapChart();
    host.innerHTML =
      '<div class="mindmap-layout">' +
        '<div class="mindmap-main">' +
          '<div class="mindmap-toolbar">' +
            '<button type="button" class="mm-tab active" data-mmview="chart">脑图</button>' +
            '<button type="button" class="mm-tab" data-mmview="outline">大纲</button>' +
            '<button type="button" class="mm-save-btn" data-role="mmsave" title="把当前脑图转成图片存入素材库">存为素材</button>' +
          '</div>' +
          '<div class="mindmap-chart" data-role="mmchart"><svg class="markmap-svg" data-role="mmsvg"></svg></div>' +
          '<div class="mindmap-outline hidden" data-role="mmoutline"></div>' +
        '</div>' +
        '<div class="mindmap-qa">' +
          '<div class="mm-qa-head">针对脑图提问</div>' +
          '<div class="mm-qa-messages" data-role="qamsgs"><div class="mm-qa-hint">基于这份脑图大纲与原文回答。比如：核心结论是什么？各部分怎么衔接？</div></div>' +
          '<div class="mm-qa-input">' +
            '<textarea data-role="qainput" placeholder="问问这份脑图 / 文档…（Enter 发送，Shift+Enter 换行）" rows="2"></textarea>' +
            '<button type="button" class="primary-btn compact-btn" data-role="qasend">发送</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    const chartEl = host.querySelector('[data-role="mmchart"]');
    const svgEl = host.querySelector('[data-role="mmsvg"]');
    const outlineEl = host.querySelector('[data-role="mmoutline"]');
    setupMindmapQa(host, markdown, String(selectionPreviewState?.sourceText || ""));
    if (outlineEl) {
      outlineEl.innerHTML = global.WpsAiMarkdown?.renderToHtml
        ? global.WpsAiMarkdown.renderToHtml(markdown)
        : selectionPreviewParagraphHtml(markdown, null);
    }
    host.querySelectorAll(".mm-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.mmview;
        host.querySelectorAll(".mm-tab").forEach((b) => b.classList.toggle("active", b === btn));
        chartEl.classList.toggle("hidden", v !== "chart");
        outlineEl.classList.toggle("hidden", v !== "outline");
        if (v === "chart" && _mmInstance) { try { _mmInstance.fit(); } catch (e) {} }
      });
    });
    try {
      // markmap-view 依赖全局 d3，先 d3 再 markmap
      await global.WpsAiLazyVendor?.ensure?.("d3");
      await global.WpsAiLazyVendor?.ensure?.("markmap");
      const mk = global.markmap;
      if (!mk?.Markmap || !global.WpsAiMindmap) {
        chartEl.innerHTML = '<div class="mm-fallback">脑图渲染库未加载，请切到「大纲」查看。</div>';
        return;
      }
      // 异步等 vendor 期间可能已切走 / 重新生成，二次确认仍是本次 mindmap 结果
      if (selectionPreviewState?.reportKind !== "mindmap" || String(selectionPreviewState?.resultText || "").trim() !== markdown) return;
      ensureMarkmapCss();
      const data = global.WpsAiMindmap.outlineToMarkmap(markdown);
      disposeMindmapChart();
      _mmInstance = mk.Markmap.create(svgEl, {
        duration: 200,
        initialExpandLevel: -1,
        zoom: true,
        pan: false,
        scrollForPan: false
      }, data);
      try { _mmInstance.fit(); } catch (e) {}
      const saveBtn = host.querySelector('[data-role="mmsave"]');
      if (saveBtn) saveBtn.addEventListener("click", () => saveMindmapAsMaterial(svgEl, markdown, saveBtn));
    } catch (e) {
      chartEl.innerHTML = '<div class="mm-fallback">脑图渲染失败，请切到「大纲」查看。</div>';
    }
  }

  // 把 markmap SVG 光栅化成 PNG dataURL。markmap 用 foreignObject 承载节点文字，
  // 直接把含 foreignObject 的 SVG 画到 canvas 会污染 canvas → toDataURL 抛 SecurityError。
  // 所以先把每个 foreignObject 换成原生 <text>（读 live 元素的文字与计算样式），再光栅化。
  function markmapSvgToPngDataUrl(svgEl, scale) {
    return new Promise((resolve, reject) => {
      try {
        const SVGNS = "http://www.w3.org/2000/svg";
        const pad = 20;
        // 用内容整体 bbox 而不是可见视口，保证导出的是完整脑图（不被 440px 视口裁掉）
        const g = svgEl.querySelector("g");
        let bb = null;
        try { if (g) bb = g.getBBox(); } catch (e) {}
        const clone = svgEl.cloneNode(true);
        clone.setAttribute("xmlns", SVGNS);
        // foreignObject（HTML 文字）→ 原生 <text>，避免含 foreignObject 的 SVG 污染 canvas
        const cloneFos = Array.from(clone.querySelectorAll("foreignObject"));
        const liveFos = Array.from(svgEl.querySelectorAll("foreignObject"));
        cloneFos.forEach((fo, i) => {
          const live = liveFos[i];
          const text = String((live || fo).textContent || "").trim();
          let fontSize = 14;
          let color = "#333333";
          try {
            const inner = live && live.firstElementChild ? live.firstElementChild : live;
            const cs = inner ? getComputedStyle(inner) : null;
            if (cs) { fontSize = parseFloat(cs.fontSize) || fontSize; color = cs.color || color; }
          } catch (e) {}
          const x = parseFloat(fo.getAttribute("x") || "0");
          const y = parseFloat(fo.getAttribute("y") || "0");
          const foh = parseFloat(fo.getAttribute("height") || String(fontSize + 6));
          const t = document.createElementNS(SVGNS, "text");
          t.setAttribute("x", String(x + 2));
          t.setAttribute("y", String(y + foh / 2));
          t.setAttribute("dominant-baseline", "central");
          t.setAttribute("font-size", String(fontSize));
          t.setAttribute("font-family", "'Microsoft YaHei', 'PingFang SC', sans-serif");
          t.setAttribute("fill", color);
          t.textContent = text;
          if (fo.parentNode) fo.parentNode.replaceChild(t, fo);
        });
        let vbW;
        let vbH;
        if (bb && bb.width > 0 && bb.height > 0) {
          const vbX = bb.x - pad;
          const vbY = bb.y - pad;
          vbW = bb.width + pad * 2;
          vbH = bb.height + pad * 2;
          const cg = clone.querySelector("g");
          if (cg) cg.removeAttribute("transform"); // 去掉平移/缩放，让内容按布局坐标铺满 viewBox
          clone.setAttribute("viewBox", vbX + " " + vbY + " " + vbW + " " + vbH);
          clone.removeAttribute("style"); // 去掉 width:100%;height:440px 之类内联样式
        } else {
          const rect = svgEl.getBoundingClientRect();
          vbW = Math.max(1, rect.width);
          vbH = Math.max(1, rect.height);
        }
        // 限制像素上限，避免超大脑图产生过大 canvas
        let s = scale || 2;
        const maxDim = 4096;
        if (vbW * s > maxDim || vbH * s > maxDim) s = Math.max(1, Math.min(maxDim / vbW, maxDim / vbH));
        const outW = Math.max(1, Math.round(vbW * s));
        const outH = Math.max(1, Math.round(vbH * s));
        clone.setAttribute("width", String(outW));
        clone.setAttribute("height", String(outH));
        const svgStr = new XMLSerializer().serializeToString(clone);
        const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, outW, outH);
            resolve(canvas.toDataURL("image/png"));
          } catch (e) { reject(e); }
        };
        img.onerror = () => reject(new Error("SVG 光栅化失败"));
        img.src = url;
      } catch (e) { reject(e); }
    });
  }

  async function saveMindmapAsMaterial(svgEl, markdown, btn) {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib || !svgEl) { showMessage("素材库未就绪。", "error"); return; }
    const orig = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
    try {
      const dataUrl = await markmapSvgToPngDataUrl(svgEl, 2);
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      let title = "文档脑图";
      try { title = global.WpsAiMindmap.outlineToTree(markdown).name || title; } catch (e) {}
      // 落盘存路径（跟本地导入一致，避免大图撑爆 localStorage）；代理不可用时兜底存 dataUrl
      let stored = null;
      try {
        const p = await global.WpsAiImageAssets?.ensureLocalImagePath?.(dataUrl);
        if (p) stored = { url: p };
      } catch (e) {}
      if (!stored) stored = { dataUrl };
      const entry = lib.add(Object.assign({
        prompt: "文档脑图 · " + title,
        source: "mindmap",
        project: settings.currentProject || "",
        tags: ["脑图", title].filter(Boolean)
      }, stored));
      if (entry) showMessage("脑图已存入素材库。", "success");
      else showMessage("存入素材库失败（本地存储空间不足）。", "error");
    } catch (e) {
      showMessage("生成脑图图片失败：" + (e?.message || e), "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  // 脑图右侧的问答面板：基于脑图大纲（+ 原文节选）多轮问答。
  function setupMindmapQa(host, contextMarkdown, sourceText) {
    const msgsEl = host.querySelector('[data-role="qamsgs"]');
    const inputEl = host.querySelector('[data-role="qainput"]');
    const sendBtn = host.querySelector('[data-role="qasend"]');
    if (!msgsEl || !inputEl || !sendBtn) return;
    const history = []; // { role, content }
    let busy = false;

    function addBubble(role, html) {
      const hint = msgsEl.querySelector(".mm-qa-hint");
      if (hint) hint.remove();
      const div = document.createElement("div");
      div.className = "mm-qa-msg mm-qa-" + role;
      div.innerHTML = html;
      msgsEl.appendChild(div);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      return div;
    }
    const renderInto = (el, text) => {
      el.innerHTML = global.WpsAiMarkdown?.renderToHtml
        ? global.WpsAiMarkdown.renderToHtml(text)
        : escapeHtmlSafe(text);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    };

    // 恢复这张脑图的历史问答（关掉再点开也在）
    const cachedHistory = mindmapQaGet(contextMarkdown);
    if (cachedHistory.length) {
      cachedHistory.forEach((h) => {
        if (h.role === "user") addBubble("user", escapeHtmlSafe(h.content));
        else renderInto(addBubble("assistant", ""), h.content);
      });
      history.push.apply(history, cachedHistory);
    }

    async function ask() {
      const q = String(inputEl.value || "").trim();
      if (!q || busy) return;
      inputEl.value = "";
      busy = true;
      sendBtn.disabled = true;
      addBubble("user", escapeHtmlSafe(q));
      const aiEl = addBubble("assistant", '<span class="mm-qa-typing">思考中…</span>');
      const sys = [
        "你是文档脑图问答助手。用户基于下面这份「文档脑图大纲」（及原文节选）提问，只依据给定内容简洁作答；",
        "内容里没有的就直说「脑图/原文未提及」，不要编造。回答用中文，可用简短 markdown。",
        "", "【文档脑图大纲】", contextMarkdown,
        sourceText ? "\n【原文节选】\n" + String(sourceText).slice(0, 6000) : ""
      ].filter(Boolean).join("\n");
      const messages = [{ role: "system", content: sys }]
        .concat(history.map((h) => ({ role: h.role, content: h.content })))
        .concat([{ role: "user", content: q }]);
      let full = "";
      let last = 0;
      try {
        await global.WpsAiOpenAI.streamChatCompletion({
          model: selectedSelectionPreviewModel(),
          messages,
          temperature: 0.2,
          onToken: (_d, ft) => {
            full = ft;
            const now = Date.now();
            if (now - last > 60) { last = now; renderInto(aiEl, full); }
          }
        });
        renderInto(aiEl, full || "（无回答）");
      } catch (e) {
        try {
          const raw = await global.WpsAiOpenAI.chatCompletion({
            model: selectedSelectionPreviewModel(), messages, temperature: 0.2
          });
          full = String(raw || "");
          renderInto(aiEl, full || "（无回答）");
        } catch (e2) {
          aiEl.innerHTML = '<span class="mm-qa-err">回答失败：' + escapeHtmlSafe(humanizePreviewError(e2)) + "</span>";
          busy = false; sendBtn.disabled = false;
          return;
        }
      }
      history.push({ role: "user", content: q });
      history.push({ role: "assistant", content: full });
      while (history.length > 12) history.shift(); // 控制上下文长度
      mindmapQaSet(contextMarkdown, history); // 持久化问答历史
      busy = false;
      sendBtn.disabled = false;
      try { inputEl.focus(); } catch (e) {}
    }

    sendBtn.addEventListener("click", ask);
    inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); ask(); }
    });
  }

  function diffWords(original, result) {
    const a = String(original || "").match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u4e00-\u9fff]/g) || [];
    const b = String(result || "").match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u4e00-\u9fff]/g) || [];
    const maxCells = 18000;
    if (a.length * b.length > maxCells) {
      return [
        { type: "delete", text: original },
        { type: "insert", text: result }
      ];
    }
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    const push = (type, text) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        push("equal", a[i]);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push("delete", a[i]);
        i += 1;
      } else {
        push("insert", b[j]);
        j += 1;
      }
    }
    while (i < a.length) push("delete", a[i++]);
    while (j < b.length) push("insert", b[j++]);
    return out;
  }

  function renderSelectionPreviewDiff() {
    if (!els.selectionPreviewDiff) return;
    if (!selectionPreviewState?.diffVisible) {
      els.selectionPreviewDiff.classList.add("hidden");
      return;
    }
    const pieces = diffWords(selectionPreviewState.sourceText || "", selectionPreviewState.resultText || "");

    // 词级统计 —— 按中文汉字 / 英文单词粒度累计，标点和空白不计入
    const isCountable = (s) => /^[一-鿿]|^[A-Za-z0-9_]/.test(s);
    let added = 0, removed = 0, kept = 0;
    pieces.forEach((p) => {
      if (!isCountable(p.text)) return;
      if (p.type === "insert") added += 1;
      else if (p.type === "delete") removed += 1;
      else kept += 1;
    });
    const total = added + removed + kept;
    const keepPct = total > 0 ? Math.round((kept / total) * 100) : 100;

    // 相邻同类型片段合并进 diff 段落，避免 <ins><ins><ins> 碎片化
    const merged = [];
    pieces.forEach((p) => {
      const last = merged[merged.length - 1];
      if (last && last.type === p.type) last.text += p.text;
      else merged.push({ type: p.type, text: p.text });
    });

    const bodyHtml = merged.map((part) => {
      const text = escapeHtmlSafe(part.text);
      if (part.type === "delete") return `<del>${text}</del>`;
      if (part.type === "insert") return `<ins>${text}</ins>`;
      return `<span class="diff-eq">${text}</span>`;
    }).join("");

    // 顶部 stats 条 + 正文 —— 用户一眼看到变化量
    const statsHtml = `
      <div class="selection-preview-diff-stats">
        <span class="diff-stat diff-stat-add">+${added} 词</span>
        <span class="diff-stat diff-stat-del">-${removed} 词</span>
        <span class="diff-stat diff-stat-keep">保留 ${keepPct}%</span>
      </div>`;
    els.selectionPreviewDiff.innerHTML = statsHtml + `<div class="selection-preview-diff-body">${bodyHtml}</div>`;
    els.selectionPreviewDiff.classList.remove("hidden");
  }

  function setSelectionPreviewBusy(on, text) {
    if (els.selectionPreviewLoading) {
      els.selectionPreviewLoading.classList.toggle("hidden", !on);
      const label = els.selectionPreviewLoading.querySelector("span:last-child");
      if (label && text) label.textContent = text;
    }
    if (els.selectionPreviewReplaceBtn) els.selectionPreviewReplaceBtn.disabled = on || !selectionPreviewState?.resultText;
    if (els.selectionPreviewRegenerateBtn) els.selectionPreviewRegenerateBtn.disabled = on;
  }

  function applySelectionPreviewModeUi(intent) {
    const isTranslate = intent === "translate";
    const isTone = intent === "tone";
    const tone = selectionPreviewState?.tone || "改写";
    const isDocRewrite = intent === "documentRewrite";
    const isDocReport = intent === "documentReport";
    const reportKind = selectionPreviewState?.reportKind || "";

    let titleText;
    if (isTranslate) titleText = "翻译预览";
    else if (isDocRewrite || isDocReport) titleText = `${tone}预览`;
    else if (isTone) titleText = `${tone}预览`;
    else titleText = "优化预览";

    let metaText;
    if (isTranslate) metaText = "选择目标语言，预览翻译结果，确认后替换当前选区。";
    else if (isDocRewrite) metaText = `预览「${tone}」前后内容，确认后将替换整篇文档。点「高亮对比」可看差异。`;
    else if (isDocReport) metaText = reportKind === "mindmap"
      ? "AI 已基于整篇文档生成 markdown 大纲脑图，可复制或插入到光标位置（不会替换原文档）。"
      : "AI 已基于整篇文档生成结构化摘要，可复制或插入到光标位置（不会替换原文档）。";
    else if (isTone) metaText = `预览「${tone}」改写前后内容，确认后替换当前选区。`;
    else metaText = "预览优化前后内容，确认后替换当前选区。";

    if (els.selectionPreviewTitle) els.selectionPreviewTitle.textContent = titleText;
    if (els.selectionPreviewMeta) els.selectionPreviewMeta.textContent = metaText;
    els.selectionPreviewTranslateControls?.classList.toggle("hidden", !isTranslate);
    // 运行时重设的组合文案走 t()（自动翻译对属性有观察器兜底，但源头 t 更可靠且能翻组合串）
    const spT = global.WpsAiI18n?.t || ((s) => s);
    if (els.selectionPreviewInstructionLabel) {
      els.selectionPreviewInstructionLabel.textContent = isTranslate
        ? spT("翻译要求")
        : ((isTone || isDocRewrite) ? spT("改写要求") : (isDocReport ? spT("总结要求") : spT("优化要求")));
    }
    if (els.selectionPreviewInstructionInput) {
      els.selectionPreviewInstructionInput.placeholder = isTranslate
        ? spT("可选。比如：保留专业术语、使用商务书面语、人名不翻译。")
        : ((isTone || isDocRewrite)
          ? spT("已预设「{tone}」要求，可在这里追加补充（如：保留专有名词、控制在 300 字以内）。", { tone: spT(tone) })
          : (isDocReport
            ? spT("可选。比如：每个要点不超过 20 字 / 只关注关键数据 / 加结论判断。")
            : spT("可选。比如：更正式、更简洁、更有逻辑、保留原意。")));
    }
    if (els.selectionPreviewTip) {
      els.selectionPreviewTip.textContent = isTranslate
        ? "自定义语言会优先生效；未填写翻译要求时按自然书面语处理。"
        : ((isTone || isDocRewrite)
          ? "改写要求会附加在预设之后；点「高亮对比」可一键看修改前后的差异。"
          : (isDocReport
            ? "结果是基于全文的概括，不会自动替换原文档；请用「复制结果」或「插入光标处」按需使用。"
            : "优化要求可以留空，AI 会保持原意并改善表达。"));
    }
    // documentReport：隐藏"原文"那一栏（避免整篇文档塞满左侧），隐藏高亮对比，露出复制按钮
    els.selectionPreviewCompare?.classList.toggle("result-only", isDocReport);
    els.selectionPreviewToggleDiffBtn?.classList.toggle("hidden", isDocReport);
    els.selectionPreviewCopyBtn?.classList.toggle("hidden", !isDocReport);
    if (els.selectionPreviewReplaceBtn) {
      if (isDocRewrite) els.selectionPreviewReplaceBtn.textContent = "替换全文";
      else if (isDocReport) els.selectionPreviewReplaceBtn.textContent = "插入光标处";
      else els.selectionPreviewReplaceBtn.textContent = "替换选区";
    }
    updateSelectionPreviewActionLabel();
  }

  function updateSelectionPreviewActionLabel() {
    if (!els.selectionPreviewRegenerateBtn) return;
    const intent = selectionPreviewState?.intent;
    const tone = selectionPreviewState?.tone;
    const hasResult = !!selectionPreviewState?.resultText;
    if (hasResult) {
      els.selectionPreviewRegenerateBtn.textContent = "重新生成";
      return;
    }
    if (intent === "translate") {
      els.selectionPreviewRegenerateBtn.textContent = "翻译";
    } else if (intent === "tone") {
      els.selectionPreviewRegenerateBtn.textContent = `开始改写为「${tone || "改写"}」`;
    } else if (intent === "documentRewrite") {
      els.selectionPreviewRegenerateBtn.textContent = `开始「${tone || "全文润色"}」`;
    } else if (intent === "documentReport") {
      const rk = selectionPreviewState?.reportKind;
      els.selectionPreviewRegenerateBtn.textContent = rk === "mindmap" ? "提炼脑图" : "生成总结";
    } else {
      els.selectionPreviewRegenerateBtn.textContent = "优化";
    }
  }

  function openSelectionPreviewInline(payload) {
    const rawIntent = String(payload?.intent || "").toLowerCase();
    let intent = "optimize";
    if (rawIntent === "translate") intent = "translate";
    else if (rawIntent === "tone") intent = "tone";
    else if (rawIntent === "documentrewrite") intent = "documentRewrite";
    else if (rawIntent === "documentreport") intent = "documentReport";
    const sourceText = String(payload?.sourceText || "");
    const presetIntents = ["tone", "documentRewrite", "documentReport"];
    selectionPreviewState = {
      intent,
      tone: presetIntents.includes(intent)
        ? (String(payload?.tone || "").trim() || (intent === "documentRewrite" ? "全文润色" : (intent === "documentReport" ? "文档报告" : "改写")))
        : "",
      presetInstruction: presetIntents.includes(intent) ? String(payload?.instruction || "") : "",
      reportKind: intent === "documentReport" ? String(payload?.reportKind || "summary") : "",
      scope: payload?.scope === "document" ? "document" : "selection",
      sourceText,
      resultText: "",
      range: payload?.range || null,
      // 记住原文的 list 格式（无序 / 有序 / null），用于：
      // 1) 预览渲染（原文 + AI 结果都按 <ul>/<ol> 显示）
      // 2) 替换时透传给 replaceRangeText / replaceSelectionText，重 apply bullet 到所有新段落
      listFormat: payload?.listFormat || null,
      docContext: payload?.docContext || null,
      diffVisible: false
    };
    applySelectionPreviewModeUi(intent);
    // tone / documentRewrite / documentReport 流的 payload.instruction 是预设要求（拼在 system prompt 里），不预填到 textarea；
    // 翻译/优化流时 instruction 是用户上次写的补充要求，正常回填。
    if (els.selectionPreviewInstructionInput) {
      els.selectionPreviewInstructionInput.value = presetIntents.includes(intent) ? "" : String(payload?.instruction || "");
    }
    if (els.selectionPreviewLanguageSelect && intent === "translate") {
      const lang = String(payload?.targetLanguage || "简体中文");
      const known = Array.from(els.selectionPreviewLanguageSelect.options).some((opt) => opt.value === lang);
      els.selectionPreviewLanguageSelect.value = known ? lang : "custom";
      if (els.selectionPreviewCustomLanguageInput) {
        els.selectionPreviewCustomLanguageInput.value = known ? "" : lang;
        els.selectionPreviewCustomLanguageInput.classList.toggle("hidden", known);
      }
    }
    els.selectionPreviewModal?.classList.remove("hidden");
    // documentReport（脑图 / 总结）：恢复上次为「相同文档内容」生成的结果，
    // 避免关掉弹窗再点开就空白（用户要看到历史生成的内容）。
    if (intent === "documentReport" && !selectionPreviewState.resultText) {
      const cached = docReportCacheGet(selectionPreviewState.reportKind, selectionPreviewState.sourceText);
      if (cached?.resultText) selectionPreviewState.resultText = cached.resultText;
    }
    renderSelectionPreviewTexts();
    maybeRenderMindmap();
    updateSelectionPreviewActionLabel();
    setSelectionPreviewBusy(false);
    return true;
  }

  function buildSelectionPreviewPrompt() {
    const intent = selectionPreviewState?.intent || "optimize";
    const instruction = selectionPreviewInstruction();
    const targetLanguage = selectionPreviewTargetLanguage();
    const source = selectionPreviewState?.sourceText || "";
    const bg = global.WpsAiHostWriter?.formatDocContextForPrompt?.(selectionPreviewState?.docContext) || "";
    const withBg = (body) => (bg ? `${bg}\n\n${body}` : body);
    const bgNote = bg ? "结合上述文档背景，保持与全文主题、术语、语气一致，不要偏离文档主题。" : "";
    if (intent === "translate") {
      if (!targetLanguage) throw new Error("请先选择或输入目标语言。");
      return withBg([
        `请把下面 WPS 文字选区内容翻译为${targetLanguage}。`,
        "要求：只输出翻译后的正文，不要解释，不要 Markdown 代码块。",
        "保留原文的段落换行；专有名词、数字、符号按上下文自然处理。",
        bgNote,
        instruction ? `用户补充要求：${instruction}` : "",
        "",
        "【原文】",
        source
      ].filter(Boolean).join("\n"));
    }
    if (intent === "tone") {
      const tone = selectionPreviewState?.tone || "改写";
      const preset = selectionPreviewState?.presetInstruction || `按「${tone}」风格改写。`;
      return withBg([
        `请按「${tone}」风格改写下面 WPS 文字选区内容。`,
        "要求：只输出改写后的正文，不要解释，不要 Markdown 代码块。",
        "保持原意和关键事实，不新增事实；保留原文段落换行。",
        `【风格要求】${preset}`,
        bgNote,
        instruction ? `【用户补充要求】${instruction}` : "",
        "",
        "【原文】",
        source
      ].filter(Boolean).join("\n"));
    }
    if (intent === "documentRewrite") {
      const tone = selectionPreviewState?.tone || "全文润色";
      const preset = selectionPreviewState?.presetInstruction || "整体润色，保持结构和原意。";
      return [
        `请对下面整篇 WPS 文字文档执行「${tone}」处理。`,
        "要求：只输出处理后的全文正文，不要解释，不要 Markdown 代码块。",
        "保持章节结构、段落顺序、关键事实和数据不变；保留原文段落换行。",
        `【处理要求】${preset}`,
        instruction ? `【用户补充要求】${instruction}` : "",
        "",
        "【全文原文】",
        source
      ].filter(Boolean).join("\n");
    }
    if (intent === "documentReport") {
      const reportKind = selectionPreviewState?.reportKind || "summary";
      const preset = selectionPreviewState?.presetInstruction || "";
      const kindLine = reportKind === "mindmap"
        ? "请基于下面整篇 WPS 文字文档生成 markdown 大纲脑图（一级用 `# `，二级用 `## `，三级用 `### `，要点用 `- `）。"
        : "请基于下面整篇 WPS 文字文档生成结构化中文摘要（含标题、要点列表、核心结论）。";
      return [
        kindLine,
        "要求：只输出 markdown 内容，不要解释，不要外层代码块包裹（直接以标题/列表开头）。",
        preset ? `【输出要求】${preset}` : "",
        instruction ? `【用户补充要求】${instruction}` : "",
        "",
        "【全文原文】",
        source
      ].filter(Boolean).join("\n");
    }
    return withBg([
      "请优化下面 WPS 文字选区内容。",
      "要求：只输出优化后的正文，不要解释，不要 Markdown 代码块。",
      "保持原意和关键事实，不新增事实；保留段落换行；让表达更清晰、通顺、专业。",
      bgNote,
      instruction ? `用户优化要求：${instruction}` : "",
      "",
      "【原文】",
      source
    ].filter(Boolean).join("\n"));
  }

  // 用 sequence token 让"被取消"的流式请求自然失效——晚到的 onToken / 错误都按 stale 丢弃。
  // 不依赖 provider 端是否支持 abort signal，三家 provider 行为统一。
  let selectionPreviewStreamSeq = 0;

  function stripFences(s) {
    return String(s || "").replace(/^```[a-zA-Z]*\s*/, "").replace(/\n?```$/g, "");
  }

  // "Failed to fetch" 这类错误对用户极不友好，统一翻译成可操作的中文
  function humanizePreviewError(err) {
    const raw = String(err?.message || err || "");
    if (/failed to fetch|networkerror|net::|fetch.*fail/i.test(raw)) {
      return "网络/本地代理不可达（Failed to fetch）。请确认 npm run proxy 还在跑、或重启 WPS 让 runtime 重新探到 proxy 端口。";
    }
    if (/timeout|超时/i.test(raw)) {
      return "请求超时。可能是模型加载慢或网络抖动，可点「重新生成」再试一次。";
    }
    return raw || "未知错误";
  }

  async function generateSelectionPreview() {
    if (!selectionPreviewState?.sourceText) {
      showMessage("当前没有可处理的选区内容。", "error");
      return;
    }
    const mySeq = ++selectionPreviewStreamSeq;
    const isCurrent = () => mySeq === selectionPreviewStreamSeq && !!selectionPreviewState;
    const sysPrompt = "你是 WPS 文字选区处理助手。严格按用户要求输出可直接替换选区的正文，不要解释。";
    const temperature = selectionPreviewState.intent === "translate" ? 0.1 : 0.25;
    const prompt = buildSelectionPreviewPrompt();
    const messages = [
      { role: "system", content: sysPrompt },
      { role: "user", content: prompt }
    ];

    setSelectionPreviewBusy(true, "正在流式生成预览…");
    selectionPreviewState.resultText = "";
    renderSelectionPreviewTexts();

    let lastRenderAt = 0;
    let tokensFiredThisAttempt = false;
    const onToken = (_delta, fullText) => {
      if (!isCurrent()) return;
      tokensFiredThisAttempt = true;
      selectionPreviewState.resultText = stripFences(fullText);
      const now = Date.now();
      if (now - lastRenderAt > 80) {
        lastRenderAt = now;
        renderSelectionPreviewTexts();
      }
    };

    // 一次流式 → 失败时按 isRetryableChatError 做 5 次重试（指数退避），重试前先 reprobe 一次本地端口，
    // 应对 proxy 重启换端口、WpsAiRuntime 缓存过期的"Failed to fetch"场景。
    // 流中途已经吐过 token 时不再重试（避免 UI 重影）。
    let lastErr = null;
    let runSucceeded = false;
    let finalText = "";
    for (let attempt = 1; attempt <= MAX_CHAT_RETRY_ATTEMPTS; attempt += 1) {
      if (!isCurrent()) return;
      tokensFiredThisAttempt = false;
      // 重置流式状态（首次不影响，重试时把残留也清掉）
      selectionPreviewState.resultText = "";
      renderSelectionPreviewTexts();
      try {
        finalText = await global.WpsAiOpenAI.streamChatCompletion({
          model: selectedSelectionPreviewModel(),
          messages,
          temperature,
          onToken
        });
        runSucceeded = true;
        break;
      } catch (e) {
        lastErr = e;
        if (e?.name === "AbortError") return;
        if (tokensFiredThisAttempt) break;
        // provider 真不支持 streamChat → 退到非流式分支
        const msg = String(e?.message || e || "");
        const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(msg);
        if (noStream) break;
        if (!isRetryableChatError(e) || attempt >= MAX_CHAT_RETRY_ATTEMPTS) break;
        try { await global.WpsAiRuntime?.reprobe?.(); } catch (re) {}
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const seconds = Math.max(1, Math.round(delay / 1000));
        showMessage(`生成预览失败（${humanizePreviewError(e).slice(0, 80)}），${seconds}s 后自动重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`, "info", { duration: Math.max(delay, 3000) });
        if (els.selectionPreviewLoading) {
          const label = els.selectionPreviewLoading.querySelector("span:last-child");
          if (label) label.textContent = `正在重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`;
        }
        await new Promise((r) => setTimeout(r, delay));
        if (!isCurrent()) return;
      }
    }

    if (runSucceeded) {
      if (!isCurrent()) return;
      selectionPreviewState.resultText = stripFences(String(finalText || "")).trim();
      renderSelectionPreviewTexts();
      maybeRenderMindmap();
      saveDocReportCacheIfNeeded();
      setSelectionPreviewBusy(false);
      updateSelectionPreviewActionLabel();
      showMessage("预览已生成。", "success");
      return;
    }

    // 流式跑空了——可能 provider 不支持流式 / 重试也没成功。
    // 不支持流式 → 走一次非流式兜底；其它情况直接报错。
    if (lastErr) {
      const errMsg = String(lastErr?.message || lastErr || "");
      const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(errMsg);
      if (noStream) {
        try {
          const raw = await global.WpsAiOpenAI.chatCompletion({
            model: selectedSelectionPreviewModel(),
            messages,
            temperature
          });
          if (!isCurrent()) return;
          selectionPreviewState.resultText = stripFences(String(raw || "")).trim();
          renderSelectionPreviewTexts();
          maybeRenderMindmap();
          saveDocReportCacheIfNeeded();
          setSelectionPreviewBusy(false);
          updateSelectionPreviewActionLabel();
          showMessage("预览已生成（当前 provider 不支持流式，已切非流式）。", "info");
        } catch (e2) {
          if (!isCurrent()) return;
          setSelectionPreviewBusy(false);
          showMessage(`生成预览失败：${humanizePreviewError(e2)}`, "error");
        }
        return;
      }
    }

    if (!isCurrent()) return;
    setSelectionPreviewBusy(false);
    showMessage(`生成预览失败（重试 ${MAX_CHAT_RETRY_ATTEMPTS} 次仍不成功）：${humanizePreviewError(lastErr)}`, "error", { autoHide: false, duration: 12000 });
  }

  function closeSelectionPreviewModal(cancelled = true) {
    // 关闭时把流式 seq 推一格，让任何在途的 onToken 自动 stale 丢弃
    selectionPreviewStreamSeq += 1;
    disposeMindmapChart();
    if (isSelectionPreviewDialog && cancelled) {
      writeSelectionPreviewDialogResult({ cancelled: true });
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.selectionPreviewModal?.classList.add("hidden");
    selectionPreviewState = null;
  }

  function writeSelectionPreviewDialogResult(result) {
    if (!isSelectionPreviewDialog || selectionPreviewDialogResultWritten) return;
    selectionPreviewDialogResultWritten = true;
    const blob = Object.assign({ ts: Date.now() }, result || {});
    try { localStorage.setItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify(blob)); } catch (e) {}
  }

  async function replaceSelectionWithPreviewResult() {
    if (!selectionPreviewState?.resultText) {
      showMessage("没有可使用的结果。", "error");
      return;
    }
    const intent = selectionPreviewState.intent;
    // 替换全文前要求二次确认，避免误覆盖
    if (intent === "documentRewrite") {
      if (!confirm(i18nT("确认用预览内容替换当前文档全文？此操作会覆盖原文。"))) return;
    }
    const result = {
      cancelled: false,
      intent,
      tone: selectionPreviewState.tone || "",
      reportKind: selectionPreviewState.reportKind || "",
      scope: selectionPreviewState.scope || "selection",
      text: selectionPreviewState.resultText,
      range: selectionPreviewState.range || null,
      // 透传给 replaceRangeText，让替换后的段落重新拿回 bullet / numbering 格式
      listFormat: selectionPreviewState.listFormat || null
    };
    if (isSelectionPreviewDialog) {
      writeSelectionPreviewDialogResult(result);
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("已提交。", "info"); }, 100);
      return;
    }
    await applySelectionPreviewResult(result);
  }

  // 把弹窗里"非工具"的直接写入也走 history.addEntry + conversation events 一遍——
  // 这样改动记录里能看到、能一键回退，对话流里也留痕（共享给 AI 后续推理用）。
  // 用现有的 toolName 复用 FRIENDLY_NAMES 映射，不再单独定义文案。
  async function recordPreviewModification({ turnLabel, toolName, params, modifyFn, summary }) {
    const history = global.WpsAiHistory;
    const snap = global.WpsAiSnapshot;
    try { history?.startTurn?.(turnLabel); } catch (e) {}
    try { await history?.ensureBackupForTurn?.(); } catch (e) {}

    let target = null, before = null, captureAfterFn = null;
    try {
      const host = snap?.detectHost?.() || "wps";
      const pre = await snap?.captureBefore?.(host, toolName, params);
      target = pre?.target || null;
      before = pre?.before || null;
      captureAfterFn = pre?._captureAfter || null;
    } catch (e) {}

    let modErr = null;
    try {
      await modifyFn();
    } catch (e) {
      modErr = e;
    }

    let after = null;
    try {
      if (!modErr && captureAfterFn) after = await snap?.captureAfter?.(captureAfterFn);
    } catch (e) {}

    try {
      history?.addEntry?.({
        host: snap?.detectHost?.() || "wps",
        toolName,
        friendlyName: history?.getFriendlyName?.(toolName) || turnLabel,
        target,
        params,
        before,
        after,
        ok: !modErr,
        resultSummary: summary || (modErr ? null : "弹窗替换成功"),
        error: modErr ? (modErr?.message || String(modErr)) : null,
        docPath: global.WpsAiBackup?.getCurrentDocPath?.() || null,
        source: "preview-dialog"
      });
    } catch (e) { console.warn("[preview] addEntry 失败", e); }

    // 同步到当前对话事件流，让聊天流 / 后续 AI 能看到这次弹窗操作
    try {
      const Conv = global.WpsAiConversations;
      if (Conv) {
        if (!Conv.getCurrentId?.()) Conv.createNew?.({ docKey: getCurrentDocKey?.() });
        Conv.appendTurnEvents?.([
          { type: "tool_call", name: toolName, args: params, ts: Date.now(), source: "preview-dialog" },
          {
            type: "tool_result",
            name: toolName,
            result: modErr
              ? { ok: false, error: modErr?.message || String(modErr) }
              : { ok: true, value: { summary: summary || `${turnLabel} 完成` } },
            ts: Date.now(),
            source: "preview-dialog"
          }
        ]);
      }
    } catch (e) {}

    // 关掉当前 UndoRecord 让下次 Application.Undo 能一次性撤回这次弹窗操作（rollback 的两层方案之一）
    try { global.WpsAiBackup?.endUndoGroup?.(); } catch (e) {}
    if (modErr) throw modErr;
  }

  async function applySelectionPreviewResult(result) {
    if (!result?.text) return false;
    const intent = result.intent;
    const label = selectionPreviewIntentLabel(result.intent, result.tone || selectionPreviewState?.tone);
    try {
      if (intent === "documentRewrite") {
        setSelectionPreviewBusy(true, "正在替换全文…");
        await recordPreviewModification({
          turnLabel: `${label}替换全文`,
          // 借用现有工具名：history.addEntry 友好名直接复用「替换选区内容」并由 target 标识"全文"
          toolName: "wps_replace_selection",
          params: { scope: "document", textLength: result.text.length, tone: result.tone, intent },
          summary: `${label}：替换整篇文档共 ${result.text.length} 字符`,
          modifyFn: async () => {
            const writer = global.WpsAiHostWriter;
            const app = global.WpsAiAddon?.getApplicationSync?.();
            const sel = app?.Selection;
            if (sel?.WholeStory) sel.WholeStory();
            const blocks = global.WpsAiMarkdownToWord.paragraphBlocks(result.text);
            await writer?.replaceSelectionText?.(blocks, {});
          }
        });
        setSelectionPreviewBusy(false);
        closeSelectionPreviewModal(false);
        renderHistory();
        showMessage("已替换全文（样式回退到默认）。", "success");
        return true;
      }
      if (intent === "documentReport") {
        setSelectionPreviewBusy(true, "正在插入到光标位置…");
        await recordPreviewModification({
          turnLabel: `${label}插入光标处`,
          toolName: "wps_insert_text",
          params: { reportKind: result.reportKind, textLength: result.text.length, intent },
          summary: `${label}：在光标位置插入 ${result.text.length} 字符的内容`,
          modifyFn: async () => {
            const blocks = global.WpsAiMarkdownToWord.blocksFromMarkdown(result.text);
            await global.WpsAiHostWriter?.insertText?.(blocks, {});
          }
        });
        setSelectionPreviewBusy(false);
        closeSelectionPreviewModal(false);
        renderHistory();
        showMessage("已插入到光标位置。", "success");
        return true;
      }
      setSelectionPreviewBusy(true, "正在替换选区…");
      await recordPreviewModification({
        turnLabel: `${label}替换选区`,
        toolName: "wps_replace_selection",
        params: { scope: "selection", textLength: result.text.length, tone: result.tone, intent, range: result.range, listFormat: result.listFormat },
        summary: `${label}：替换选区 ${result.text.length} 字符`,
        modifyFn: async () => {
          // 选区在列表内时，构造单个 list 块（让 writeBlocks 的 list 分支连续编号），
          // 否则每行一个 paragraph 块会让有序列表重新从 1 计数（"1. 1. 1."）。
          // 之前 range.Text = "多段" 只有首段保留 list 格式，后续段变成普通段，用户投诉
          // "扩写无序列表后小黑点没了"就是这原因。
          const lf = result.listFormat;
          let blocks;
          if (lf && (lf.kind === "bullet" || lf.kind === "numbered")) {
            const items = String(result.text || "").replace(/\r\n/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean);
            blocks = [{ type: "list", ordered: lf.kind === "numbered", level: Math.max(0, (parseInt(lf.level, 10) || 1) - 1), items }];
          } else {
            blocks = global.WpsAiMarkdownToWord.paragraphBlocks(result.text);
          }
          if (result.range && global.WpsAiHostWriter?.replaceRangeText) {
            await global.WpsAiHostWriter.replaceRangeText(result.range, blocks, {});
          } else {
            await global.WpsAiHostWriter?.replaceSelectionText?.(blocks, {});
          }
        }
      });
      setSelectionPreviewBusy(false);
      closeSelectionPreviewModal(false);
      renderHistory();
      showMessage("已替换当前选区。", "success");
      return true;
    } catch (e) {
      setSelectionPreviewBusy(false);
      showMessage(`操作失败：${e?.message || e}`, "error");
      return false;
    }
  }

  async function consumeSelectionPreviewDialogResult() {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let result = null;
    try { result = JSON.parse(raw); } catch (e) {}
    try { localStorage.removeItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
    if (!result || typeof result !== "object") return false;
    if (result.ts && result.ts === lastSelectionPreviewResultTs) return false;
    lastSelectionPreviewResultTs = result.ts || Date.now();
    if (result.cancelled) return true;
    return applySelectionPreviewResult(result);
  }

  function startSelectionPreviewDialogResultPolling() {
    if (isAnyDialogWindow()) return;
    if (selectionPreviewDialogPollTimer) clearInterval(selectionPreviewDialogPollTimer);
    let ticks = 0;
    selectionPreviewDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeSelectionPreviewDialogResult();
      if (ticks >= 600) {
        clearInterval(selectionPreviewDialogPollTimer);
        selectionPreviewDialogPollTimer = null;
      }
    }, 500);
  }

  async function openSelectionPreviewAsDialog(payload) {
    try {
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
      if (currentHostInfo?.host !== "wps") {
        showMessage("该功能目前只支持 WPS 文字文档。", "error");
        return false;
      }
      const wantsFullDoc = payload?.scope === "document";
      let text = "";
      let range = null;
      let listFormat = null;
      if (wantsFullDoc) {
        // 全文场景：读整篇文档，不要求选中
        text = String(await global.WpsAiHostWriter?.readDocumentText?.() || "").trim();
        if (!text) {
          showMessage("当前文档没有可处理的正文。", "error");
          return false;
        }
      } else {
        const snap = await global.WpsAiHostWriter?.readSelectionSnapshot?.();
        text = String(snap?.text || "").trim();
        if (!text) {
          showMessage("请先选中文字，再使用该功能。", "error");
          return false;
        }
        range = snap?.range || null;
        listFormat = snap?.listFormat || null;   // 关键：原文是不是无序 / 有序 list 段落
      }
      // 选区操作注入文档上下文（标题+大纲+选区前后文），让 AI 不偏离全文主题。全文场景不需要。
      let docContext = null;
      if (!wantsFullDoc) {
        try { docContext = await global.WpsAiHostWriter?.readDocumentContext?.({ selectionRange: range, maxAround: 800 }); } catch (e) {}
      }
      const request = Object.assign({}, payload || {}, {
        ts: Date.now(),
        sourceText: text,
        range,
        listFormat,
        docContext
      });
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=selectionpreview`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        try { localStorage.setItem(SELECTION_PREVIEW_DIALOG_REQUEST_KEY, JSON.stringify(request)); } catch (e) {}
        try { localStorage.removeItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
        const { w, h } = pickDialogSize(1120, 760, { minW: 820, minH: 560 });
        app.ShowDialog(url, i18nDialogTitle(`${selectionPreviewIntentLabel(request.intent, request.tone)}预览`), w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        await consumeSelectionPreviewDialogResult();
        startSelectionPreviewDialogResultPolling();
        return true;
      }
      return openSelectionPreviewInline(request);
    } catch (e) {
      showMessage(`打开预览失败：${e?.message || e}`, "error");
      return false;
    }
  }

  function bindSelectionPreviewModal() {
    if (selectionPreviewBound) return;
    selectionPreviewBound = true;
    els.selectionPreviewCloseBtn?.addEventListener("click", () => closeSelectionPreviewModal(true));
    els.selectionPreviewCancelBtn?.addEventListener("click", () => closeSelectionPreviewModal(true));
    els.selectionPreviewRegenerateBtn?.addEventListener("click", () => generateSelectionPreview());
    els.selectionPreviewReplaceBtn?.addEventListener("click", replaceSelectionWithPreviewResult);
    els.selectionPreviewCopyBtn?.addEventListener("click", async () => {
      const text = String(selectionPreviewState?.resultText || "").trim();
      if (!text) {
        showMessage("还没有结果可复制。", "info");
        return;
      }
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        showMessage("结果已复制到剪贴板。", "success");
      } catch (e) {
        showMessage(`复制失败：${e?.message || e}`, "error");
      }
    });
    els.selectionPreviewToggleDiffBtn?.addEventListener("click", () => {
      if (!selectionPreviewState) return;
      selectionPreviewState.diffVisible = !selectionPreviewState.diffVisible;
      if (els.selectionPreviewToggleDiffBtn) {
        els.selectionPreviewToggleDiffBtn.textContent = selectionPreviewState.diffVisible ? "隐藏高亮" : "高亮对比";
      }
      renderSelectionPreviewDiff();
    });
    els.selectionPreviewLanguageSelect?.addEventListener("change", () => {
      const custom = els.selectionPreviewLanguageSelect?.value === "custom";
      els.selectionPreviewCustomLanguageInput?.classList.toggle("hidden", !custom);
      if (custom) els.selectionPreviewCustomLanguageInput?.focus?.();
    });
    els.selectionPreviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.selectionPreviewModal) closeSelectionPreviewModal(true);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && els.selectionPreviewModal && !els.selectionPreviewModal.classList.contains("hidden")) {
        closeSelectionPreviewModal(true);
      }
    });
  }

  /**
   * 折叠式工具消息：默认单行（工具名 + 单行预览 + 折叠箭头），点击展开完整 JSON。
   */
  function appendCollapsibleToolMsg({ kind, label, name, summary, fullText }) {
    const wrap = document.createElement("div");
    wrap.className = `chat-msg tool collapsible ${kind || ""}`;
    wrap.appendChild(makeAvatarEl("assistant"));

    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";

    const labelSpan = document.createElement("span");
    labelSpan.className = "chat-msg-label";
    labelSpan.textContent = label;
    head.appendChild(labelSpan);

    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name-inline";
    nameSpan.textContent = name;
    head.appendChild(nameSpan);

    const previewSpan = document.createElement("span");
    previewSpan.className = "tool-preview";
    previewSpan.textContent = summary;
    head.appendChild(previewSpan);

    // 长 body（>800 char）加一个"复制全文"按钮，避免用户在 pre 里滚半天
    const isLong = String(fullText || "").length > 800;
    if (isLong) {
      const copyBtn = document.createElement("span");
      copyBtn.className = "tool-copy-btn";
      copyBtn.title = "复制完整内容";
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      copyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        try {
          navigator.clipboard?.writeText(String(fullText || ""));
          showMessage("已复制到剪贴板", "success");
        } catch (e) {}
      });
      head.appendChild(copyBtn);
    }

    const chev = document.createElement("span");
    chev.className = "tool-chevron";
    chev.textContent = "▶";
    head.appendChild(chev);

    const body = document.createElement("pre");
    body.className = "tool-body";
    body.textContent = fullText;

    wrap.appendChild(head);
    wrap.appendChild(body);

    head.addEventListener("click", () => {
      const expanded = wrap.classList.toggle("expanded");
      chev.textContent = expanded ? "▼" : "▶";
    });

    els.chatStream.appendChild(wrap);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
    return wrap;
  }

  // 从 tool_result value 里派生一条人话小结，用来当"完成态"的 preview
  function summarizeToolResult(name, result) {
    if (!result || !result.ok) return "";
    const v = result.value;
    // 常见几种：字符串直接用；对象带 count/summary/message 字段的用；否则序列化前 40 字
    if (typeof v === "string") return v.slice(0, 60);
    if (v && typeof v === "object") {
      if (typeof v.summary === "string") return v.summary.slice(0, 60);
      if (typeof v.message === "string") return v.message.slice(0, 60);
      if (typeof v.count === "number") return `已处理 ${v.count} 项`;
      if (Array.isArray(v)) return `${v.length} 项`;
    }
    return "";
  }

  function showPendingApproval(calls) {
    return new Promise((resolve) => {
      els.chatPendingList.innerHTML = "";
      calls.forEach((call) => {
        let pretty;
        try { pretty = JSON.stringify(call.args, null, 2); } catch (e) { pretty = String(call.args); }
        const preview = oneLine(pretty);

        // 折叠式卡片：默认收起，点击头部展开/收起完整 JSON
        const item = document.createElement("div");
        item.className = "chat-pending-item collapsible";

        const head = document.createElement("button");
        head.type = "button";
        head.className = "pending-head";

        const nameSpan = document.createElement("span");
        nameSpan.className = "pending-name";
        nameSpan.textContent = call.name;
        head.appendChild(nameSpan);

        const previewSpan = document.createElement("span");
        previewSpan.className = "pending-preview";
        previewSpan.textContent = preview;
        head.appendChild(previewSpan);

        const chev = document.createElement("span");
        chev.className = "pending-chevron";
        chev.textContent = "▶";
        head.appendChild(chev);

        const body = document.createElement("pre");
        body.className = "pending-body";
        body.textContent = pretty;

        item.appendChild(head);
        item.appendChild(body);

        head.addEventListener("click", () => {
          const expanded = item.classList.toggle("expanded");
          chev.textContent = expanded ? "▼" : "▶";
        });

        els.chatPendingList.appendChild(item);
      });
      els.chatPending.classList.remove("hidden");
      // 关键：AI 忙碌期间文档锁把 app.Interactive 设成了 false，会连带禁掉任务窗格的点击，
      // 导致"确认框弹出来但按钮点不动"。审批需要用户操作面板，这里临时把交互开回来。
      try { global.WpsAiLock?.setInteractiveLive?.(true); } catch (e) {}

      const cleanup = () => {
        els.chatPending.classList.add("hidden");
        els.chatApproveAllBtn.removeEventListener("click", onApprove);
        els.chatRejectAllBtn.removeEventListener("click", onReject);
        // 审批结束，恢复锁定期的交互禁用（后续工具写入仍按原流程走 tempUnlock）
        try { global.WpsAiLock?.setInteractiveLive?.(false); } catch (e) {}
      };
      const onApprove = () => { cleanup(); resolve({ approved: true }); };
      const onReject = () => { cleanup(); resolve({ approved: false, reason: "用户取消执行" }); };
      els.chatApproveAllBtn.addEventListener("click", onApprove);
      els.chatRejectAllBtn.addEventListener("click", onReject);
    });
  }

  async function buildChatApprover() {
    if (currentSettings.operationMode === "direct") return null;

    let pendingBatch = [];
    let pendingPromise = null;
    let pendingResolver = null;

    return async function approveTool(call) {
      if (call?.name === "todo_replace_all" || call?.name === "todo_patch") {
        return { approved: true };
      }
      // 外部 MCP 工具：属于被标记 trusted 的服务则跳过确认（类比 todo 白名单）
      if (typeof call?.name === "string" && call.name.startsWith("mcp__")) {
        const service = call.name.slice(5).split("__")[0];
        const trusted = (currentSettings.mcpClients || []).some((c) => c.name === service && c.trusted);
        if (trusted) return { approved: true };
      }
      pendingBatch.push(call);
      if (!pendingPromise) {
        pendingPromise = new Promise((resolve) => { pendingResolver = resolve; });
        setTimeout(async () => {
          const calls = pendingBatch.slice();
          pendingBatch = [];
          const result = await showPendingApproval(calls);
          pendingResolver(result);
          pendingPromise = null;
          pendingResolver = null;
        }, 0);
      }
      return pendingPromise;
    };
  }

  let currentAbortController = null;
  // 会话统计：轮次 + wall-time 累积；provider 不吐 usage 时用这两个维度让用户知道自己烧了多少
  const sessionStats = { turns: 0, totalMs: 0, lastMs: 0, pendingTurnAt: 0 };
  function formatSessionMs(ms) {
    if (!ms || ms < 1000) return `${ms || 0} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const rest = Math.round(s - m * 60);
    return `${m}m ${rest}s`;
  }
  function updateSessionStatsBadge() {
    const el = els.chatSessionStats;
    if (!el) return;
    if (sessionStats.turns === 0) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.textContent = `${sessionStats.turns} 轮 · ${formatSessionMs(sessionStats.totalMs)}`;
    el.title = `本次会话：${sessionStats.turns} 轮 AI 请求，累计耗时 ${formatSessionMs(sessionStats.totalMs)}。最近一轮 ${formatSessionMs(sessionStats.lastMs)}。`;
  }
  function resetSessionStats() {
    sessionStats.turns = 0;
    sessionStats.totalMs = 0;
    sessionStats.lastMs = 0;
    sessionStats.pendingTurnAt = 0;
    updateSessionStatsBadge();
  }

  function stopChat() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    hideThinking();
    setChatBusy(false);
    // 时间轴：停止提示走 .tl-error（renderErrorMessage），与新布局一致，不再用旧气泡。
    const stopNode = global.WpsAiChatTimeline.renderErrorMessage("（已停止）");
    if (els.chatStream) {
      els.chatStream.appendChild(stopNode);
      els.chatStream.scrollTop = els.chatStream.scrollHeight;
    }
  }

  // ===== 自动重试：网络/5xx/429 等瞬时错误时透明重试，最多 5 次 =====
  const MAX_CHAT_RETRY_ATTEMPTS = 5;

  function isRetryableChatError(error) {
    if (!error) return false;
    if (error.name === "AbortError") return false;
    const msg = String(error?.message || error || "");
    const lower = msg.toLowerCase();
    if (/aborted/i.test(msg)) return false;
    // 4xx 权限/参数类错误不重试（用户得改配置才行）
    if (/请求失败[:：]\s*(400|401|403|404|422)\b/.test(msg)) return false;
    // 网络层
    if (/failed to fetch|networkerror|network error|net::|fetch.*fail|timeout|超时|连接(中断|失败|被|关闭|重置)|connection (lost|reset|refused|closed|aborted)/i.test(lower)) return true;
    // 5xx / 429 / Cloudflare 52x
    if (/请求失败[:：]\s*(429|5\d\d)\b/.test(msg)) return true;
    if (/\b(429|500|502|503|504|520|521|522|524)\b/.test(msg)) return true;
    return false;
  }

  function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      let onAbort;
      const timer = setTimeout(() => {
        try { signal?.removeEventListener?.("abort", onAbort); } catch (e) {}
        resolve();
      }, ms);
      onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      try { signal?.addEventListener?.("abort", onAbort, { once: true }); } catch (e) {}
    });
  }

  // turnOpts.quickAction = { label }：ribbon 快捷指令等发送的固定模板提示词。
  // 展示层把 user 消息折叠成「操作盒子」（只显示按钮文字，点开看完整提示词），
  // 模型收到的内容不变（chatHistory 仍是完整 prompt）。
  async function runChatTurn(userInput, turnOpts = {}) {
    let readOnlySkillTurn = !!turnOpts.skillSummary;
    const quickAction = (turnOpts?.quickAction && String(turnOpts.quickAction.label || "").trim())
      ? { label: String(turnOpts.quickAction.label).trim() }
      : null;
    const appendTurnUserMsg = () => {
      // 时间轴：用户消息走文档流一条 .tl-msg.tl-user（快捷指令折叠成可展开操作盒子）。
      const node = global.WpsAiChatTimeline.renderUserMessage(
        quickAction
          ? { text: userInput, quickAction: { label: quickAction.label, prompt: userInput } }
          : { text: userInput }
      );
      if (els.chatStream) {
        els.chatStream.appendChild(node);
        chatStickToBottom = true; // 新发送：恢复跟随，滚到底显示这条用户消息
        els.chatStream.scrollTop = els.chatStream.scrollHeight;
      }
    };
    // 会话统计：进 turn 记 startAt，出 turn 累计 wall time + turn count；
    // 页面 header 附近有个小指示器（chatSessionStatsBadge）实时更新，用户能看到自己烧了多少。
    const _turnStartAt = Date.now();
    // 修 B10：忙碌时禁止并发启动新一轮（此时 UI 只显示"停止"，用户应先停止当前轮）。
    // 之前"abort 旧轮再起新轮"会让旧轮的 finally 清掉新轮的 controller / 提前解锁文档。
    if (chatBusy || _longRewriteRunning) {
      showMessage("AI 正在处理，请先点「停止」或等待本轮完成。", "info");
      return;
    }

    // 长文改写意图路由：命中「全文/通篇 + 改写/润色…」且当前宿主为 WPS 文字 →
    // 改走长文改写流水线（分节改写 + 预览弹窗 + 双模式落笔），不进普通聊天。
    // 安全阀：这里只生成预览，绝不落笔——真正写回由预览弹窗里的按钮触发。
    if (!quickAction && pendingAttachments.length === 0 && detectLongRewriteIntent(userInput)) {
      if ((currentHostInfo?.host || "") !== "wps") {
        try { currentHostInfo = await global.WpsAiDocument.getHostInfo(); } catch (e) {}
      }
      if ((currentHostInfo?.host || "") === "wps" && global.WpsAiLongRewrite?.run) {
        appendTurnUserMsg();
        chatHistory.push({ role: "user", content: userInput });
        try {
          const Conv = global.WpsAiConversations;
          if (Conv) {
            if (!Conv.getCurrentId?.()) Conv.createNew?.({ docKey: getCurrentDocKey() });
            Conv.syncMessages?.(chatHistory);
          }
        } catch (e) {}
        await runLongRewriteFlow(userInput);
        return;
      }
    }

    // P2-3 本地能力路由：确定性短指令（保存/跳页/插表/撤销/重做）本地直达，
    // 不调模型——零 token 零延迟。宁可漏不可错：整句锚定 + 带附件不路由。
    if (!quickAction && pendingAttachments.length === 0) {
      let localIntent = null;
      try { localIntent = global.WpsAiLocalIntents?.match?.(userInput, currentHostInfo?.host || ""); } catch (e) {}
      if (localIntent) {
        appendTurnUserMsg();
        let replyText;
        try {
          const res = await global.WpsAiLocalIntents.execute(localIntent);
          replyText = res?.message || i18nT("已执行。");
        } catch (e) {
          replyText = `${i18nT("本地执行失败")}：${e?.message || e}`;
        }
        appendChatMsg("assistant", replyText, { label: "AI" });
        chatHistory.push({ role: "user", content: userInput });
        chatHistory.push({ role: "assistant", content: replyText });
        try {
          const Conv = global.WpsAiConversations;
          if (Conv) {
            if (!Conv.getCurrentId?.()) Conv.createNew?.({ docKey: getCurrentDocKey() });
            Conv.syncMessages?.(chatHistory);
          }
        } catch (e) {}
        try { global.WpsAiLog?.log?.("local-intent", { key: localIntent.key, params: localIntent.params }); } catch (e) {}
        return;
      }
    }

    sessionStats.pendingTurnAt = _turnStartAt;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // 「未配置聊天模型」预检查：用户一条都没启用时，registry 会兜底到第一条（默认 Codex），
    // 然后 Codex 因为没 OAuth 抛"请先使用 ChatGPT OAuth 登录"——这条提示对真没配置的新用户
    // 极具误导性。提前自己探一下，给一条清晰的指引。
    try {
      const list = Array.isArray(currentSettings?.chatProviders) ? currentSettings.chatProviders : [];
      const enabledList = list.filter((p) => p?.enabled);
      const isProviderReady = (p) => {
        if (!p) return false;
        if (p.type === "codex") return !!global.WpsAiAuth?.isAuthenticated?.();
        return !!(p.baseUrl && p.apiKey);
      };
      const ready = enabledList.find(isProviderReady);
      if (!ready) {
        appendTurnUserMsg();
        let hint;
        if (enabledList.length === 0) {
          hint = "还没启用任何聊天模型。请打开右上角「设置 → 聊天模型」，选一家供应商（OpenAI / Claude / DeepSeek / Kimi / 通义 / ChatGPT OAuth 等任选其一），填好 Base URL + API Key 后**勾上「启用」**，再发消息。";
        } else {
          const reasons = enabledList.map((p) => {
            const name = p.label || p.id;
            if (p.type === "codex") return `「${name}」：还没用 ChatGPT 账号登录授权（在设置卡片里走 OAuth 4 步流程）`;
            if (!p.baseUrl && !p.apiKey) return `「${name}」：缺 Base URL 和 API Key`;
            if (!p.baseUrl) return `「${name}」：缺 Base URL`;
            if (!p.apiKey) return `「${name}」：缺 API Key`;
            return `「${name}」：配置不完整`;
          });
          hint = "已启用的聊天模型都还没配齐：\n\n" + reasons.map((r) => `- ${r}`).join("\n") + "\n\n请打开右上角「设置 → 聊天模型」补全任意一家。";
        }
        appendChatMsg("assistant", hint, { label: "AI", kind: "err" });
        return;
      }
    } catch (e) { /* 探测失败兜底走原路径，仍由 provider 抛具体错 */ }

    // 文档保存状态预检查：WPS 文档型 host (wps/wpp/et) 下未保存的临时文档，
    // tools/registry.js 在 AI 调修改型工具时会拦截，但那要等 AI 思考 + 至少一轮工具调用才报错——
    // 用户白白等 10-30s 才看到一句「请先 Ctrl-S」。这里 fail-fast 让 user message 一发出去就拒绝。
    try {
      const hi = await global.WpsAiDocument?.getHostInfo?.();
      const isDocHost = hi && ["wps", "wpp", "et"].includes(hi.host);
      if (hi?.host === "wps" && isFormatSkillRequest(userInput)) readOnlySkillTurn = true;
      if (isDocHost && !readOnlySkillTurn) {
        const dp = global.WpsAiBackup?.getCurrentDocPath?.();
        if (!dp) {
          appendTurnUserMsg();
          appendChatMsg(
            "assistant",
            "当前文档尚未保存到磁盘（临时文档），AI 修改类操作会被拒绝。\n\n请先保存到磁盘后再聊（Windows/Linux 用 **Ctrl+S**，macOS 用 **⌘+S**）：所有改动会关联到该文件路径，方便备份与回滚。",
            { label: "AI", kind: "err" }
          );
          return;
        }
      }
    } catch (e) { /* host 探测失败 fallback 到老路径（registry 兜底） */ }

    // 取走本轮附件，准备组装 user message
    const turnAttachments = pendingAttachments.slice();
    clearAttachments();

    // 把文本附件 inline 进 prompt（任何模型都能消化）
    let userPromptText = userInput;
    const textAttachments = turnAttachments.filter((a) => a.kind === "text");
    if (textAttachments.length > 0) {
      const blocks = textAttachments.map((a) => {
        const lang = (a.name.match(/\.([a-z0-9]+)$/i) || [null, ""])[1].toLowerCase();
        return `\n\n[附件：${a.name}]\n\`\`\`${lang}\n${a.textContent}\n\`\`\``;
      });
      userPromptText = userInput + blocks.join("");
    }

    // 图片附件：模型多模态才发，否则提示用户并丢弃
    const imageAttachments = turnAttachments.filter((a) => a.kind === "image");
    const pdfAttachments = turnAttachments.filter((a) => a.kind === "pdf");
    const modelName = els.modelSelect?.value || "";
    const useImages = imageAttachments.length > 0 && isMultimodalModel(modelName);
    const usePdfs = pdfAttachments.length > 0 && isPdfModel(modelName);
    if (imageAttachments.length > 0 && !useImages) {
      showMessage(`当前模型「${modelName}」不支持图片，${imageAttachments.length} 张图片已忽略，仅发送文本。`, "info");
    }
    if (pdfAttachments.length > 0 && !usePdfs) {
      showMessage(`当前模型「${modelName}」不支持 PDF 附件，${pdfAttachments.length} 个 PDF 已忽略。请切到 Claude / GPT-4o / Codex / DeepSeek-V4 等支持 PDF 的模型。`, "info");
    }

    // 构造 user message content：
    //   纯文本             → string
    //   有图片/PDF          → array of parts（image_url / file）
    let userMsgContent;
    if (useImages || usePdfs) {
      userMsgContent = [{ type: "text", text: userPromptText }];
      imageAttachments.forEach((img) => {
        if (useImages) userMsgContent.push({ type: "image_url", image_url: { url: img.dataUrl } });
      });
      pdfAttachments.forEach((pdf) => {
        if (usePdfs) userMsgContent.push({
          type: "file",
          file: { file_data: pdf.dataUrl, filename: pdf.name || "file.pdf" }
        });
      });
    } else {
      userMsgContent = userPromptText;
    }

    setChatBusy(true, { readOnly: readOnlySkillTurn });
    setProgressState("thinking");
    // chat 流里展示用户消息：纯文本走原路，快捷指令折叠成操作盒子，带附件时在文本下方挂 chip 预览
    appendTurnUserMsg();
    if (turnAttachments.length > 0) appendUserAttachmentsPreview(turnAttachments);

    chatHistory.push({ role: "user", content: userMsgContent });
    try {
      const Conv = global.WpsAiConversations;
      if (Conv && !Conv.getCurrentId?.()) {
        Conv.createNew?.({ docKey: getCurrentDocKey() });
      }
    } catch (e) {}

    // 开启新一轮 history turn——之后第一个修改型工具会懒抓文档备份
    try { global.WpsAiHistory?.startTurn?.(userInput); } catch (e) {}

    // 收集本轮所有 UI 事件（user / reasoning / tool_call / tool_result / assistant）
    // 切换历史对话时按这个事件流重布 chat 流，完整还原"应答过程"
    const turnEvents = [{
      type: "user", text: userInput, ts: Date.now(),
      // 快捷指令元数据：历史回放时按「操作盒子」重建，而不是平铺整段模板提示词
      quickAction,
      attachments: turnAttachments.map((a) => ({
        id: a.id, kind: a.kind, name: a.name, size: a.size,
        // 图片附件存 dataUrl 让历史回显能看到缩略图；文本附件不重复存内容
        dataUrl: a.kind === "image" ? a.dataUrl : undefined
      }))
    }];
    const turnEventsV2 = [];
    try {
      turnEventsV2.push(global.WpsAiChatEvents?.userMessageEvent?.(userInput, turnEvents[0].attachments, quickAction) || {
        schema: "lingxi.chat.event.v1",
        type: "message.end",
        role: "user",
        text: userInput,
        attachments: turnEvents[0].attachments,
        quickAction: quickAction || null,
        ts: Date.now()
      });
    } catch (e) {}
    let lastReasoningText = "";
    let reasoningStartTs = 0; // 本段思考开始时间（首个 reasoning_chunk），用于给回放侧算思考耗时

    try {
      // 每轮 chat 前重新探测一次 host，避免用户切换宿主后工具集错位
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
      const allTools = global.WpsAiToolRegistry.listForHost(currentHostInfo.host);
      const formatSkill = readOnlySkillTurn && !turnOpts.skillSummary && currentHostInfo.host === "wps";
      const restrictedSkillTurn = readOnlySkillTurn;
      const model = els.modelSelect.value || global.WpsAiOpenAI.getDefaultModel();
      // 本轮锁定当前 provider 配置：中途切换模型下拉（改全局 activeChatModel）不会污染
      // 在跑的这轮——否则新模型名会被发到旧供应商，报「模型不存在」。切换只影响下一轮。
      const turnConfig = (() => {
        try { return global.WpsAiProviderRegistry?.getActiveConfig?.(); } catch (e) { return undefined; }
      })();

      // 模型工具调用能力检测。命中 denylist（如 DeepSeek R1 / 纯推理模型）→
      //   1) chat 里附一条 ai-err 提示用户「当前模型不支持工具调用」
      //   2) 不传 tools 入参，避免有的 provider 报 400 invalid_function_parameters
      //   3) 同一对话同一模型只提示一次（避免每轮刷屏）
      const activeProviderId = getActiveChatModel().providerId || "";
      const supportsTools = global.WpsAiCapabilities?.getCapabilities?.(model, activeProviderId)?.tools !== false;
      const tools = supportsTools ? (restrictedSkillTurn ? allTools.filter((tool) => tool.name === "save_skill" || (formatSkill && tool.name === "wps_sample_document_formatting")) : allTools) : [];
      if (!supportsTools) {
        const noticeKey = `noToolNotice:${model}`;
        if (!window[noticeKey]) {
          window[noticeKey] = true;
          appendChatMsg(
            "assistant",
            `当前模型「${model}」不支持工具调用（function calling）。AI 无法直接读写文档，只能用自然语言指导你操作。\n\n如果想让 AI 真的改文档，换一个支持工具调用的模型（Claude 系列 / GPT-4o+ / DeepSeek-V3 chat / Qwen / Kimi / GLM 等）。`,
            { label: "AI", kind: "err" }
          );
        }
        plog?.("toolCapability", "supportsTools=false, 跳过 tools 入参", { model });
      }

      // 检测用户本轮输入是否已经显式指定 PPT 风格/视觉关键词。
      // 命中 → 让 AI 走 UI/UX Pro Max 设计自由度，不再注入用户保存的 stylePreset
      //         （锁住色板会让 AI 没法做用户要的 "cyberpunk" / "极简" / "暗黑" 等指定风格）
      // 未命中 → 用 stylePreset（用户已配过整体视觉风格，本次按它统一）
      const userSpecifiedPptStyle = currentHostInfo.host === "wpp"
        && detectPptStyleIntent(userInput);
      if (userSpecifiedPptStyle) {
        plog?.("pptStyleHint", "user input mentions design style → 让位给 UI/UX 技能，跳过 stylePreset 注入");
      }

      // 如果在 PPT 宿主且用户启用了风格预设，把要点写进系统提示
      let stylePresetNote = "";
      if (currentHostInfo.host === "wpp" && currentSettings?.stylePreset?.enabled && !userSpecifiedPptStyle) {
        const sp = currentSettings.stylePreset;
        const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
        const matched = sp.scheme && schemes[sp.scheme];
        const guidelines = global.WpsAiProviderRegistry?.DESIGN_GUIDELINES || [];
        const themeLine = matched
          ? `  · 主题：${matched.label} — ${matched.description}（${matched.design}）`
          : "  · 主题：用户自定义色板";
        const signatureLine = matched?.signatureElement
          ? `  · 标志视觉元素（封面/章节页必须体现）：${matched.signatureElement}`
          : "";
        const layoutLine = matched?.layoutHints
          ? `  · 优先版式组合（直接照做）：${matched.layoutHints}`
          : "";
        stylePresetNote = [
          "用户已启用 PPT 风格预设——本次对话生成 / 修改的所有幻灯片必须保持以下统一样式：",
          themeLine,
          `  · 标题：字体 ${sp.titleFont}，字号 ${sp.titleSize}pt，${sp.titleBold ? "加粗" : "常规"}，颜色 ${sp.titleColor}`,
          `  · 正文：字体 ${sp.bodyFont}，字号 ${sp.bodySize}pt，颜色 ${sp.bodyColor}`,
          `  · 色板：primary=${sp.primaryColor} / secondary=${sp.secondaryColor} / accent=${sp.accentColor} / background=${sp.backgroundColor} / surface=${sp.surfaceColor}`,
          signatureLine,
          layoutLine,
          sp.themeFile ? `  · 主题模板文件：${sp.themeFile}（每页生成完毕后调用 wpp_apply_theme(themePath=该路径) 套用）` : "",
          "",
          "灵犀 PPT 设计宪法（每次配版前自检）：",
          ...guidelines.map((g, i) => `  ${i + 1}. ${g}`),
          "",
          "实践：每次 wpp_add_slide 之后调一次 wpp_apply_style_preset 自动套用字体；如果有自定义文本框（wpp_add_text_box）也按上面的字体字号填；不确定时先调 wpp_get_style_preset 拿完整色板与签名元素再设计。"
        ].filter(Boolean).join("\n");
      }

      // 用户配置的系统提示词（默认是一套"去 AI 味 + 简洁 + 不堆 emoji"的规则）
      const userSystemPrompt = (currentSettings.systemPrompt || "").trim();
      const longTaskTodoNote = [
        "长任务执行规则：当用户请求包含长文、多步骤、批量修改、整篇润色、整套 PPT/文档生成或跨多处处理时，先调用 todo_replace_all 拆成 3-8 个可执行 todo。",
        "每开始一个步骤前调用 todo_patch 把对应 todo 标记为 in_progress；完成后标记为 completed；失败或跳过时标记为 failed/skipped 并写一句简短原因。",
        "todo 是内部进度记录，不要只停留在计划；创建 todo 后继续实际执行用户任务。"
      ].join("\n");
      const currentTurnLongTaskNote = isLikelyLongTask(userPromptText)
        ? "本轮用户请求已被识别为长任务，请先调用 todo_replace_all 进行拆解，再按 todo 顺序执行并持续更新状态。"
        : "";

      // PPT 强制走 HTML 预览流程：所有「生成新幻灯片」类请求都必须先用 wpp_render_html_template
      // 打开预览让用户微调，禁止直接 wpp_add_slide / wpp_apply_template 直写。
      // 例外只有 ① 用户明确说「直接生成不要预览」「批量出 N 页」 ② 编辑/修改现有页（用 wpp_replace_shape_text 等）。
      const spreadsheetReadGuardNote = currentHostInfo.host === "et" ? [
        "WPS 表格事实性回答规则：",
        "用户询问当前表格、工作表、单元格、列含义、数据异常、统计、总结、分析时，必须先调用 et_get_sheet_info 获取 UsedRange 和当前选区，再调用 et_read_range 读取相关区域。",
        "没有工具结果前不能直接回答表格内容；工具结果不足时继续读取，不要猜测或编造单元格、行列、字段、数值。"
      ].join("\n") : "";

      const wppPreviewFirstNote = currentHostInfo.host === "wpp" ? [
        "",
        "【PPT 生成流程强制】",
        "1. 用户要求生成新幻灯片（不论封面/章节/内容/数据/引言）时，**必须**调 wpp_render_html_template（默认 preview=true）走预览流程；不要调 wpp_add_slide + wpp_apply_template / wpp_apply_visual_template / wpp_add_text_box 这类直写工具。",
        "2. 调用前先调一次 wpp_render_html_template(templateName=\"__list\") 拿当前可用模板和布局清单；按用户的页面类型选合适 templateName+layout。",
        "3. 工具返回 { previewOpened: true, ... } 后，告诉用户「已打开预览，请在弹窗里微调字段后点插入」，**本轮不要再调任何幻灯片工具**——等用户在弹窗里确认后插入是自动的，不需要你再做任何事。",
        "4. 用户连续要 N 页（>=3）且明确说「不要每页预览，直接出」时，才传 preview=false 跳过弹窗。",
        "5. 修改已有页面文字（不是生成新页）继续用 wpp_replace_shape_text / wpp_format_shape_text 等；不要走 HTML 模板。",
        "6. 如果 wpp_render_html_template 报「模板不存在」「布局不支持」，给用户解释当前可用模板范围，让用户选最接近的一个，不要 fallback 到直写工具。",
        ""
      ].join("\n") : "";

      // 当 HTML 预览 modal 打开时，把当前 state 注入 system prompt，让 AI 知道用户面前的是什么。
      // 用户对话里说「改成更短的标题」「副标改 X」时，AI 应该再调一次 wpp_render_html_template
      //（同 templateName + layout，data 改新值），modal 会原地更新字段不会弹新窗。
      let htmlPreviewStateNote = "";
      try {
        const st = global.WpsAiHtmlPreview?.getState?.();
        if (st && st.templateName) {
          htmlPreviewStateNote = [
            "",
            "【当前 HTML 预览弹窗状态】（用户正在看一个预览弹窗，你可以再调一次 wpp_render_html_template 用同 templateName+layout 但不同 data 来「修改预览」）",
            `  templateName: ${st.templateName}`,
            `  layout: ${st.layout}`,
            `  data（当前字段值）: ${JSON.stringify(st.data || {}, null, 2)}`,
            st.slideHint ? `  slideHint: 第 ${st.slideHint} 页（用户可点「替换原幻灯片」覆盖该页）` : "",
            "用户提出修改时（如「标题改短」「加副标」「内容多加一条」），保持 templateName/layout 不变，data 字段在当前值基础上 patch，再调一次工具即可——modal 会原地更新不弹新窗。",
            ""
          ].filter(Boolean).join("\n");
        }
      } catch (e) { /* 没开就算了 */ }

      // 启用的技能拼 system prompt block —— async（contentPath 形式的 builtin 要 fetch md）
      const skillsBlock = await buildSkillsPromptBlock({ host: currentHostInfo.host });
      // PPT 设计自由度提示：用户在本轮 prompt 指定了风格时，告诉 AI 大胆按指定风格走，
      // 不要绑死 freeform 默认 padding / 字号映射等套路。
      // 注意：是否提及 UI/UX Pro Max 技能要看它真的是否启用，不能硬编码"已启用"误导 AI
      // 按那套大型设计指令走。skill 没启用时只给通用自由度提示。
      const uiuxSkillEnabled = !!global.WpsAiSkills?.isEnabled?.("builtin-ui-ux-pro-max");
      const pptFreeDesignNote = userSpecifiedPptStyle ? [
        "",
        "【PPT 设计自由度模式】",
        "用户本轮明确指定了视觉风格 —— 你应当**完全按用户提到的风格 / 颜色 / 调性**去设计幻灯片，跳出现有模板的死板布局：",
        "- freeform 布局优先（用 wpp_render_html_template 的 layout=freeform，自己写 html+css）",
        "- 配色、字体、装饰元素都按用户风格挑，**不要绑死本地 stylePreset 色板**",
        uiuxSkillEnabled
          ? "- 参考已启用的「UI/UX Pro Max 设计智能」技能：50+ 风格、161 色板、字体配对、99 UX 准则随手用"
          : "",
        "- 鼓励变化：封面、章节页、内容页**视觉差异要明显**，不要全部用同一个模板套",
        "- 字号映射仍按 1pt=2px (1920×1080 画布) 保持可读性",
        ""
      ].filter(Boolean).join("\n") : "";

      // WPS 文字写文档内容必须用结构化 blocks（不是 markdown 字符串）：wps_insert_text /
      // wps_replace_selection / wps_replace_document 会把 blocks 直接渲染成 Word 原生格式。
      // 注意这条只管「写入文档」这几个工具的参数——跟用户聊天的对话气泡仍然按 markdown 渲染，不受影响。
      const wpsWriteBlocksNote = currentHostInfo.host === "wps" ? [
        "在 WPS 文字写文档内容时（wps_insert_text / wps_replace_selection / wps_replace_document），一律用 blocks 结构化参数，禁止把 markdown 字符串塞进 text：",
        "  · 标题 {type:\"heading\", level:1-6, text}",
        "  · 段落 {type:\"paragraph\", text}，需要加粗/斜体/行内代码时用 {type:\"paragraph\", runs:[{text, bold?, italic?, code?}]}",
        "  · 列表 {type:\"list\", ordered:true/false, items:[...]}",
        "  · 表格 {type:\"table\", header:true, rows:[[...]]}",
        "  · 引用/代码块/空行 {type:\"quote\",text} / {type:\"code\",text} / {type:\"spacer\"}",
        "加粗、斜体一律用 runs 表达，不要在 text 里写 ** 或 * 这类 markdown 语法；完全没有格式的纯文本才用 text 参数快捷插入。",
        "AI 排版功能由专用预览弹窗处理，不要自行拼 blocks 替换全文。（这条规则只约束写入文档的 blocks 参数，跟用户聊天时的对话回复无关，回复仍可以正常用 markdown。）",
        "文档读取结果里若出现 [图片N]/[表格N]/[视频N]/[公式N]/[对象N] 这类占位符，表示该处有不可改写的嵌入对象。改写/扩写/润色时必须把每个占位符作为独立段落原样保留，放在它原本所在的相对位置（前后文对应处），不要改写、翻译、合并或删除占位符本身。"
      ].join("\n") : "";

      // 语言硬约束跟随界面语言（国际化）：英文界面 → 英文回复约束；中文界面维持原有中文硬约束。
      // 国外模型（GPT / Claude / Gemini 等）容易顺着英文习惯回英文，必须在基础 prompt 里钉死，
      // 不能只依赖用户可编辑的 settings.systemPrompt。中文约束里英文再写一遍是给英文系模型的强化提示。
      const uiLangForPrompt = (() => {
        try { return global.WpsAiI18n?.resolvedLang?.() || "zh"; } catch (e) { return "zh"; }
      })();
      const languageConstraint = uiLangForPrompt === "en"
        ? "[Language] Always respond in English — regardless of the language of the user's message, the document, or tool results. Write your internal reasoning / thinking process in English as well. The only exception: when the user explicitly asks for a translation or for content written in another language, the produced content may use the target language, but your explanatory text stays in English."
        : "【语言要求】你的所有回复一律使用简体中文——无论用户用什么语言提问、文档内容是什么语言、工具返回什么语言。思考过程（reasoning / thinking）同样必须用简体中文书写。唯一例外：用户明确要求翻译成某语言或用某语言撰写内容时，产出的正文用目标语言，但你的说明文字仍用中文。IMPORTANT: Always respond in Simplified Chinese (简体中文), and write your internal reasoning / thinking process in Simplified Chinese as well. Never use English, regardless of the language of the user's message, the document, or tool results, unless the user explicitly asks for a translation or for content written in another language.";
      const systemPrompt = [
        uiLangForPrompt === "en"
          ? "You are an AI assistant embedded in WPS Office. You can read and edit the currently open document directly via tools."
          : "你是嵌入 WPS Office 的中文智能助理，可以通过工具直接读写当前打开的文档。",
        languageConstraint,
        `当前宿主：${currentHostInfo.label}（${currentHostInfo.host}）。只调用与当前宿主匹配的工具。`,
        "决策原则：先用 read 类工具了解现状，再用 write/format 类工具修改。每一步告诉用户你做了什么。",
        "能力广度：除了读写文字，你还能做条件格式/数据验证/图表/迷你图/智能表/删重复/分类汇总、批注读写与修订审阅（接受/拒绝）、段落排版/页眉页脚/页面设置/脚注/水印、动画/形状对齐/SmartArt、以及导出PDF/另存/打印等。判断“能不能做”之前先看看可用工具清单，不要凭印象直接回“当前工具不支持”。",
        wpsWriteBlocksNote,
        wppPreviewFirstNote,
        htmlPreviewStateNote,
        stylePresetNote,
        pptFreeDesignNote,
        longTaskTodoNote,
        currentTurnLongTaskNote,
        spreadsheetReadGuardNote,
        "工具失败时分析原因，必要时换实现，不要重复同一种失败调用。",
        "副作用确认：打印（*_print）、另存为（*_save_as）、导出PDF（*_export_pdf）会真实操作打印机或往磁盘写文件，属于不可无声撤销的动作——执行前先跟用户确认意图和目标路径，不要擅自打印、覆盖已有文件或另存到不确定的位置。",
        skillsBlock,
        // 用户配置的提示词放最后，覆盖力度更强
        userSystemPrompt ? "\n--- 用户偏好（优先级高于上述默认规则）---\n" + userSystemPrompt : ""
      ].filter(Boolean).join("\n");

      // 长对话压缩：有摘要时，早期轮次用摘要块替代（拼进 system），只发最近的原文。
      // UI 与存储始终保留全量历史，这里只影响发给模型的内容。
      const historyComp = (() => {
        try { return global.WpsAiConversations?.getCompression?.() || null; } catch (e) { return null; }
      })();
      // P2-4 跨对话记忆：注入本文档最近几个对话的备忘（排除当前对话）
      const memoryBlock = (() => {
        try {
          const M = global.WpsAiChatMemory;
          if (!M) return "";
          const mems = M.listForDoc(getCurrentDocKey(), {
            excludeConvId: global.WpsAiConversations?.getCurrentId?.() || "",
            limit: 3
          });
          return mems.length ? "\n\n" + M.buildBlock(mems, uiLangForPrompt) : "";
        } catch (e) { return ""; }
      })();
      const outgoingSystemPrompt = ((historyComp && global.WpsAiChatCompress)
        ? systemPrompt + "\n\n" + global.WpsAiChatCompress.buildContextBlock(historyComp.summary, uiLangForPrompt)
        : systemPrompt) + memoryBlock;
      const outgoingHistory = (historyComp && historyComp.upTo <= chatHistory.length)
        ? chatHistory.slice(historyComp.upTo)
        : chatHistory;
      const skillOperations = turnOpts.skillSummary
        ? buildSkillOperationSummary(global.WpsAiConversations?.getCurrent?.()?.events || []) : "";
      const messages = [
        { role: "system", content: restrictedSkillTurn ? [languageConstraint, "根据已有信息创建可复用技能，只能使用提供的工具。信息不足时说明不足，不要猜测。", formatSkill ? "格式技能：使用 wps_sample_document_formatting 提取格式，再调用 save_skill；默认优先选区，否则均匀抽样。说明抽样覆盖范围，不要把样本说成全文。只在用户明确要求完整扫描时使用 page 分页；没有完成时明确说明。" : "只根据本次对话历史总结，不读取或修改文档。", skillOperations ? "本次对话中已成功执行的工具及部分格式参数：" + skillOperations : ""].join("\n") : outgoingSystemPrompt },
        ...(restrictedSkillTurn ? buildSkillSummaryHistory(chatHistory) : sanitizeHistoryForModel(outgoingHistory)) // 跨模型安全边界：剥工具结构/特有角色
      ];

      const baseApprover = await buildChatApprover();
      const approver = restrictedSkillTurn ? skillSummaryApprover(baseApprover, formatSkill) : baseApprover;
      let assistantText = "";

      // 本轮开始时间 + 使用的模型 —— 供元信息角标（#3）用
      const turnStartedAt = Date.now();
      const turnModelName = String(model || "").trim();
      const turnProviderInfo = (() => {
        try { return global.WpsAiOpenAI?.getActiveProviderInfo?.() || {}; } catch (e) { return {}; }
      })();
      // 元信息里显示的短模型名（剥 provider/ 前缀，截 24 字）。
      const metaModel = turnModelName.replace(/^[a-z]+\//, "").slice(0, 24) || "AI";

      // 时间轴：本轮 AI 容器句柄（懒建，首个相关事件时才落一个 .tl-msg.tl-assistant）；
      // pendingToolSteps 记录 running 中的工具步骤，tool_result 到达时按名配对（同 buildTurnSteps 的配对规则）。
      let currentTurn = null;
      const pendingToolSteps = [];
      const ensureTurn = () => {
        if (!currentTurn) {
          currentTurn = global.WpsAiChatTimeline.beginAssistantTurn({ meta: { model: metaModel }, expandTools: !!currentSettings.showToolCallLogs });
          if (els.chatStream) els.chatStream.appendChild(currentTurn.node);
        }
        chatFollowBottom();
        return currentTurn;
      };

      // 第一轮请求开始前先把 thinking 占位气泡显示出来
      showThinking("AI 正在思考");

      // 思考强度：模型支持深度思考时把用户选的 level 传下去（off 时不传，等同关闭）
      const thinkingLevel = isThinkingModel(model)
        ? (readThinkingLevel() === "off" ? null : readThinkingLevel())
        : null;

      // 把 runWithTools 的事件处理抽出来，方便包到自动重试循环里
      let eventsFiredThisAttempt = false;
      let lastLoggedAssistantChars = 0;
      let lastLoggedReasoningChars = 0;
      const summarizeStreamEventForConsole = (ev) => {
        try {
          const out = { type: ev?.type || "", model: turnModelName, provider: turnProviderInfo.id || turnProviderInfo.type || "" };
          if (ev?.name) out.name = ev.name;
          if (ev?.args) {
            const argText = JSON.stringify(sanitizeDevLogData(ev.args));
            out.args = argText.length > 800 ? argText.slice(0, 800) + `...(+${argText.length - 800})` : argText;
          }
          if (typeof ev?.delta === "string") {
            out.deltaLength = ev.delta.length;
            out.deltaTail = ev.delta.slice(-160);
          }
          if (typeof ev?.fullText === "string") {
            out.fullTextLength = ev.fullText.length;
            out.fullTextTail = ev.fullText.slice(-240);
          }
          if (typeof ev?.text === "string") {
            out.textLength = ev.text.length;
            out.textTail = ev.text.slice(-240);
          }
          if (ev?.result) {
            const result = ev.result;
            out.resultOk = !!result.ok;
            if (result.error) out.resultError = String(result.error).slice(0, 500);
            const value = result.value;
            if (value && typeof value === "object") {
              out.resultKeys = Object.keys(value).slice(0, 20);
              if (Array.isArray(value.values)) {
                out.valuesShape = [value.values.length, Array.isArray(value.values[0]) ? value.values[0].length : 0];
                out.valuesSample = value.values.slice(0, 3).map((row) => Array.isArray(row) ? row.slice(0, 6) : row);
              }
              if (value.range) out.range = value.range;
              if (value.sheetName || value.sheet) out.sheet = value.sheetName || value.sheet;
              if (value.usedRange) out.usedRange = value.usedRange;
            } else if (value != null) {
              out.resultValue = String(value).slice(0, 500);
            }
          }
          return out;
        } catch (e) {
          return { type: ev?.type || "", summarizeError: e?.message || String(e) };
        }
      };
      const handleStreamEvent = async (ev) => {
        eventsFiredThisAttempt = true;
        const rawEvent = ev;
        try {
          const streamSummary = summarizeStreamEventForConsole(rawEvent);
          console.log("[lingxi-stream]", streamSummary);
          bridgeConsoleLog("stream", streamSummary);
          const shouldPersistStreamLog = (() => {
            if (rawEvent?.type === "assistant_chunk") {
              const len = streamSummary.fullTextLength || 0;
              if (len - lastLoggedAssistantChars < 500) return false;
              lastLoggedAssistantChars = len;
              return true;
            }
            if (rawEvent?.type === "reasoning_chunk") {
              const len = streamSummary.fullTextLength || 0;
              if (len - lastLoggedReasoningChars < 500) return false;
              lastLoggedReasoningChars = len;
              return true;
            }
            return true;
          })();
          if (shouldPersistStreamLog) devLog("stream.event", "chat stream event", streamSummary);
        } catch (e) {}
        try {
          const standardEvents = global.WpsAiChatEvents?.normalizeEvent?.(rawEvent, {
            provider: turnProviderInfo.type || turnProviderInfo.id || "",
            model: turnModelName
          }) || [];
          // 只存「每段一条」的 .end / 工具 / 状态事件；delta（message.delta / reasoning.delta）是「每 chunk 一条」，
          // 仅用于实时流式渲染。回放由 fromEvents 靠 .end 事件（含全文）重建，不需要 delta。
          // 存 delta 会让事件数从每轮几十条暴涨到成百上千 → 撞 appendTurnEventsV2 的 800 上限被 slice(-800)
          // 截断，把靠前的思考/工具事件全丢掉，回放只剩尾部答案（时间轴消失）。
          standardEvents.forEach((event) => {
            if (event && (event.type === "message.delta" || event.type === "reasoning.delta")) return;
            turnEventsV2.push(event);
          });
        } catch (e) {}
        try { ev = global.WpsAiChatEvents?.toLegacyEvent?.(rawEvent) || rawEvent; } catch (e) { ev = rawEvent; }
        switch (ev.type) {
          case "reasoning_chunk":
              // 关闭思考档位时（thinkingLevel 为 null）：像商汤等"总是思考"的模型仍会吐 reasoning，
              // 但既然用户关了思考，就不渲染思考步骤/推理进度，尊重"关闭"。generic「AI 正在思考」点点不受影响。
              if (!thinkingLevel) break;
              // 推理模型的"思考过程"流式输出 → 时间轴当前轮的思考步骤
              hideThinking();
              // 把最近的思考尾段拼到进度文字后面，类似 Claude Code 那种"…正在推理: 最后几个字"
              setProgressState("reasoning", `${(ev.fullText || "").length.toLocaleString()} 字符`);
              ensureTurn().updateReasoning(ev.fullText || "");
              lastReasoningText = ev.fullText || lastReasoningText;
              if (!reasoningStartTs) reasoningStartTs = Date.now();
              break;
            case "reasoning_end":
              // 思考结束（即将出正文或工具调用），把思考步骤收尾（running→ok）
              if (currentTurn) currentTurn.endReasoning();
              setProgressState("thinking");
              if (lastReasoningText) {
                turnEvents.push({
                  type: "reasoning",
                  text: lastReasoningText,
                  ts: Date.now(),
                  elapsedMs: reasoningStartTs ? Date.now() - reasoningStartTs : undefined
                });
                lastReasoningText = "";
                reasoningStartTs = 0;
              }
              break;
            case "assistant_chunk": {
              // 真正答复的 token：移除 thinking；<think> 内联段进思考步骤，可见正文进文本步骤
              hideThinking();
              setProgressState("generating", `${(ev.fullText || "").length.toLocaleString()} 字符`);
              const turn = ensureTurn();
              const { visible, think } = splitVisibleAndThinking(ev.fullText || "");
              if (think && thinkingLevel) turn.updateReasoning(think); // 关闭思考时不渲染内联 <think>
              if (visible) {
                turn.endReasoning(); // 开始出正文即代表思考结束
                turn.setText(visible);
              }
              break;
            }
            case "assistant_text_end":
              if (ev.text) {
                assistantText = ev.text;
                turnEvents.push({
                  type: "assistant",
                  text: ev.text,
                  ts: Date.now(),
                  model: turnModelName,
                  elapsedMs: Date.now() - turnStartedAt
                });
              }
              // 流式回复收尾：定稿文本步骤 + 挂元信息（模型 · 耗时）
              if (currentTurn) {
                const { visible } = splitVisibleAndThinking(ev.text || "");
                currentTurn.finalizeText(visible);
                currentTurn.setMeta({ model: metaModel, elapsedMs: Date.now() - turnStartedAt });
              }
              break;
            case "assistant_text":
              // 非流式 provider 兜底
              hideThinking();
              setProgressState("generating");
              if (ev.text) {
                assistantText = ev.text;
                const turn = ensureTurn();
                const { visible, think } = splitVisibleAndThinking(ev.text);
                if (think && thinkingLevel) { turn.updateReasoning(think); turn.endReasoning(); } // 关闭思考时不渲染内联 <think>
                else turn.endReasoning();
                turn.finalizeText(visible);
                turn.setMeta({ model: metaModel, elapsedMs: Date.now() - turnStartedAt });
                turnEvents.push({
                  type: "assistant",
                  text: ev.text,
                  ts: Date.now(),
                  model: turnModelName,
                  elapsedMs: Date.now() - turnStartedAt
                });
              }
              break;
            case "tool_call":
              hideThinking();
              if (currentTurn) {
                currentTurn.endReasoning();
                // 上一段流式正文若还开着，说明它是切到工具前的"过渡话" → 封存，后续正文另起一步
                currentTurn.sealText();
              }
              // generate_image / todo 有各自的专用面板（imageGenPanel / renderTodoPanel），
              // 不在时间轴里再单独落一个工具步骤，避免重复表达
              if (ev.name !== "generate_image" && ev.name !== "todo_replace_all" && ev.name !== "todo_patch") {
                const turn = ensureTurn();
                const ref = turn.addToolStep(ev.name, ev.args);
                pendingToolSteps.push({ name: ev.name, ref });
                // 「显示工具调用详情」开启：把参数详情直接展开进步骤的 .tl-step-detail（取代旧的独立折叠卡）
                if (currentSettings.showToolCallLogs) turn.expandToolStep(ref);
              }
              setProgressState("tool", friendlyToolName(ev.name));
              // 头部进度条 + imageGenPanel + 工具步骤三处已充分表达"AI 在执行工具"，不再叠 dot-typing 气泡
              turnEvents.push({ type: "tool_call", name: ev.name, args: ev.args, ts: Date.now() });
              break;
            case "tool_result":
              hideThinking();
              if (ev.name === "todo_replace_all" || ev.name === "todo_patch") {
                renderTodoPanel();
              }
              // 与最近一个同名 running 工具步骤配对（同 buildTurnSteps 的配对规则），置 ok/error + 挂 result。
              // generate_image / todo 未建步骤 → 不在 pendingToolSteps 里，自然跳过。
              {
                let idx = -1;
                for (let i = pendingToolSteps.length - 1; i >= 0; i -= 1) {
                  if (pendingToolSteps[i].name === ev.name) { idx = i; break; }
                }
                if (idx >= 0 && currentTurn) {
                  const { ref } = pendingToolSteps.splice(idx, 1)[0];
                  currentTurn.finishToolStep(ref, ev.result);
                  if (currentSettings.showToolCallLogs) currentTurn.expandToolStep(ref);
                }
              }
              if (ev.name === "suggest_quick_actions" && ev.result?.ok) {
                renderSuggestedActions(ev.result.value?.actions || []);
              }
              setProgressState("thinking", `刚完成 ${friendlyToolName(ev.name)}`);
              // 头部进度条已经清楚表达"◆ 思考中 · 刚完成 xxx"，chat stream 不用再叠 dot-typing。
              // 如果下一个事件迟迟不来（罕见），400ms 后再补上气泡，避免"AI 是不是死了"的错觉。
              scheduleDelayedThinking();
              turnEvents.push({ type: "tool_result", name: ev.name, result: ev.result, ts: Date.now() });
              break;
            case "done":
              hideThinking();
              // 收尾：思考步骤收尾即可。收尾文本块本就作为可见文本块留在轨道里，无需再动
              // （新模型里 sealText 只封口当前流式文本块、留其可见，仅在 tool_call 打断时调用）。
              if (currentTurn) {
                currentTurn.endReasoning();
              }
              // 时间轴本身就是本轮汇总（保持展开），不再补折叠汇总卡
              currentTurn = null;
              pendingToolSteps.length = 0;
              setProgressState("done");
              // 半秒后清空进度条文字（避免"完成"一直停在上面），进度条本体由 setChatBusy 收
              setTimeout(() => { setProgressStatus(null); }, 500);
              break;
        }
        try { if (els.chatStream) els.chatStream.scrollTop = els.chatStream.scrollHeight; } catch (e) {}
      };

      // 包一层重试：网络/5xx/429 等瞬时错误时透明重试，最多 MAX_CHAT_RETRY_ATTEMPTS 次。
      // 一旦已经触发过任何流式事件（assistant_chunk / tool_call / …），说明响应已经在路上，
      // 重试会让 UI 出现重复/错位，这种情况下直接抛出让上层处理，不重试。
      let lastChatError = null;
      let chatAttempts = 0;
      for (let attempt = 1; attempt <= MAX_CHAT_RETRY_ATTEMPTS; attempt += 1) {
        chatAttempts = attempt;
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        eventsFiredThisAttempt = false;
        try {
          await global.WpsAiOpenAI.runWithTools({
            model,
            config: turnConfig, // 锁定本轮 provider，中途切模型不污染在跑的这轮
            messages,
            tools,
            signal,
            thinkingLevel,
            maxIterations: restrictedSkillTurn ? Math.min(currentSettings?.maxToolIterations || 50, formatSkill ? 12 : 4) : (currentSettings?.maxToolIterations || 50),
            approveTool: approver || undefined,
            onEvent: handleStreamEvent
          });
          lastChatError = null;
          break;
        } catch (e) {
          lastChatError = e;
          if (e?.name === "AbortError") throw e;
          if (eventsFiredThisAttempt || !isRetryableChatError(e)) throw e;
          if (attempt >= MAX_CHAT_RETRY_ATTEMPTS) {
            throw new Error(`连续重试 ${MAX_CHAT_RETRY_ATTEMPTS} 次仍失败：${e?.message || e}`);
          }
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          const seconds = Math.max(1, Math.round(delay / 1000));
          const reasonText = rateLimitShortReason(e) || String(e?.message || e || "").slice(0, 80);
          showMessage(`AI 请求失败（${reasonText}），${seconds}s 后自动重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`, "info", { duration: Math.max(delay, 3000) });
          setProgressState("retrying", `第 ${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS} 次`);
          await sleepWithSignal(delay, signal);
          setProgressState("thinking");
        }
      }

      if (chatAttempts > 1 && !lastChatError) {
        showMessage(`第 ${chatAttempts} 次重试成功。`, "success");
      }

      hideThinking();

      if (assistantText) {
        chatHistory.push({ role: "assistant", content: assistantText });
      }
      // 模型明确报告全部完成却漏调最后一次 todo_patch 时，按本轮成功结果补齐显示。
      try {
        const conv = global.WpsAiConversations;
        const state = conv?.getConversationTodos?.();
        if (global.WpsAiTodoCompletion?.shouldCompleteRemaining(assistantText, state?.todos, turnEvents)) {
          const id = conv.getCurrentId?.();
          state.todos.forEach((todo) => {
            if (todo.status === "pending" || todo.status === "in_progress") {
              conv.patchConversationTodo?.(id, todo.id, { status: "completed" });
            }
          });
          renderTodoPanel();
        }
      } catch (e) {}
    } catch (error) {
      hideThinking();
      // 用户主动中止时，AbortError 不当成错误展示（已经在 stopChat 里展示过"已停止"）
      const isAbort = error?.name === "AbortError" || /aborted/i.test(error?.message || "");
      if (!isAbort) {
        // 优先把「模型不接受图片/附件」的服务端天书翻译成可行动的中文提示
        const mmFriendly = friendlyMultimodalError(error, { model: modelName, hadImages: useImages, hadPdfs: usePdfs });
        // ⑤ 从错误自我纠正：服务端确认拒绝了多模态内容 → 记下这个模型不支持该模态，
        //   持久化 force-off。下轮 isMultimodalModel/isPdfModel 即返回 false，不再发图/附件，
        //   能力角标也随之消失。纠正名字正则 / models.dev 的假阳性。
        //   注意：只在「多模态」错误时学习，限流等其它友好化不能误关模型的图片/PDF 能力。
        if (mmFriendly) {
          const learnPid = turnConfig?.id || getActiveChatModel().providerId || "";
          if (useImages) setUserCapabilityOverride(learnPid, modelName, "image", false, "learned");
          if (usePdfs) setUserCapabilityOverride(learnPid, modelName, "pdf", false, "learned");
        }
        // 友好化优先级：多模态拒绝 → 限流（每分钟请求超限）→ 原始报错兜底
        const friendly = mmFriendly || friendlyRateLimitError(error);
        // 时间轴：主错误提示走 .tl-error（renderErrorMessage），与新布局一致，不再用旧气泡。
        const errNode = global.WpsAiChatTimeline.renderErrorMessage(friendly || `错误：${error.message || error}`);
        if (els.chatStream) {
          els.chatStream.appendChild(errNode);
          els.chatStream.scrollTop = els.chatStream.scrollHeight;
        }
      }
    } finally {
      hideThinking();
      setChatBusy(false);
      currentAbortController = null;
      // 会话统计：记录本轮耗时 + 增计轮次；页面 badge 实时刷新
      const elapsedMs = sessionStats.pendingTurnAt ? Date.now() - sessionStats.pendingTurnAt : 0;
      sessionStats.pendingTurnAt = 0;
      sessionStats.turns += 1;
      sessionStats.totalMs += elapsedMs;
      sessionStats.lastMs = elapsedMs;
      updateSessionStatsBadge();
      // 每轮结束把 chatHistory + 本轮事件流同步到当前 conversation
      // 写回 conversations。currentId 为空时 lazy createNew，带上当前 docKey
      // 让新对话挂到正确的文件下（docWatcher 在切文件时会先 clearCurrent）
      try {
        const Conv = global.WpsAiConversations;
        if (Conv) {
          if (!Conv.getCurrentId?.()) {
            Conv.createNew?.({ docKey: getCurrentDocKey() });
          }
          Conv.syncMessages?.(chatHistory);
          Conv.appendTurnEvents?.(turnEvents);
          Conv.appendTurnEventsV2?.(turnEventsV2);
          // 每轮结束确定性落盘：mac 的 WPS 关文档时 beforeunload 常不触发，光靠 250ms 防抖 + beforeunload
          // 会把最后一轮 events 丢掉，重开后历史回放就没有时间轴/工具步骤。这里在自然空闲点强制 flush。
          Conv.flush?.();
        }
      } catch (e) {}
      // 长对话后台压缩（fire-and-forget）：超阈值时把早期轮次并进滚动摘要
      try { scheduleHistoryCompression(); } catch (e) {}
      // 弱模型工具调用能力提示：本轮执行过工具，但最终回答却在复述工具（出现工具内部名 /
      // 「已被调用」这类措辞），说明模型没消化工具结果——常见于 7-9B 小模型。给一句可行动建议。
      try { maybeWarnWeakToolModel(turnEvents, assistantText); } catch (e) {}
      // 技能沉淀提示：多轮 + 有实际操作后，提示用户把这轮总结成可复用技能
      try { tallySkillSuggest(turnEvents); } catch (e) {}
    }
  }

  // 纯逻辑（可单测）：本轮是否「执行了工具但最终回答在复述工具而非用数据」。
  // 干净信号：正常回答不会出现工具的 snake_case 内部名（如 et_read_range）；出现即高度可疑。
  // extraToolNames 传入已注册工具名，供工具名被模型原样吐出的情况兜底。
  function detectRestatedToolCall(turnEvents, finalText, extraToolNames) {
    const executed = (turnEvents || []).some((e) => e && (e.type === "tool_call" || e.type === "tool_result"));
    if (!executed) return false;
    const text = String(finalText || "");
    if (!text.trim()) return false;
    const names = new Set();
    (turnEvents || []).forEach((e) => { if (e && e.type === "tool_call" && e.name) names.add(String(e.name)); });
    (extraToolNames || []).forEach((n) => n && names.add(String(n)));
    for (const n of names) {
      if (n.length >= 5 && new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(text)) return true;
    }
    // 复述措辞（工具名可能被模型拆开，措辞作为第二信号）
    return /(已被调用|被调用了|你提到了.{0,12}(工具|调用|_)|has been called|you (?:just )?mentioned|I noticed you mentioned)/i.test(text);
  }

  let _weakToolWarnedAt = 0;
  function maybeWarnWeakToolModel(turnEvents, finalText) {
    let registered = [];
    try { registered = (global.WpsAiToolRegistry?.listAll?.() || []).map((d) => d?.name).filter(Boolean); } catch (e) {}
    if (!detectRestatedToolCall(turnEvents, finalText, registered)) return;
    // 同一分钟只提示一次，避免刷屏
    const now = Date.now();
    if (now - _weakToolWarnedAt < 60000) return;
    _weakToolWarnedAt = now;
    const t = global.WpsAiI18n?.t || ((s) => s);
    appendChatMsg("assistant", t("提示：当前模型已经调用了工具并拿到结果，但没有正确利用工具返回的数据来回答，而是在复述工具调用本身。这通常是模型的工具调用能力不足（常见于 7-9B 小模型）。建议换用工具调用能力更强的模型（如 Qwen2.5-14B 及以上、或云端模型）后重试。"), { label: "AI", kind: "err" });
  }

  // ---------------- 技能沉淀提示 ----------------
  // 多轮对话且其中确实有实际文档操作后，在输入框上方提示用户「要不要把这轮总结成技能」。
  // 每个对话最多提示一次，用户点「总结成技能」或关闭后本对话不再出现；新对话/切换对话时重置。
  const SKILL_SUGGEST_MIN_TURNS = 4;      // 至少完整对话轮数
  const SKILL_SUGGEST_MIN_TOOLTURNS = 2;  // 其中至少几轮真正调用过工具（有实际操作，才值得沉淀）
  let _skillSuggest = { turns: 0, toolTurns: 0, dismissed: false };
  function resetSkillSuggest() {
    _skillSuggest = { turns: 0, toolTurns: 0, dismissed: false };
    if (els.skillSuggestBar) els.skillSuggestBar.classList.add("hidden");
  }
  // 一轮结束时调用：累计轮数 / 有操作的轮数，达到阈值就显示提示条。
  function tallySkillSuggest(turnEvents) {
    _skillSuggest.turns += 1;
    const hadTool = (turnEvents || []).some((e) => e && (e.type === "tool_call" || e.type === "tool_result"));
    if (hadTool) _skillSuggest.toolTurns += 1;
    maybeSuggestSkill();
  }
  function maybeSuggestSkill() {
    const bar = els.skillSuggestBar;
    if (!bar) return;
    const host = currentHostInfo?.host || "";
    const okHost = ["wps", "et", "wpp", "pdf"].includes(host); // save_skill 只在文档型 host 有意义
    const enough = _skillSuggest.turns >= SKILL_SUGGEST_MIN_TURNS
      && _skillSuggest.toolTurns >= SKILL_SUGGEST_MIN_TOOLTURNS;
    const show = okHost && enough && !_skillSuggest.dismissed && !chatBusy;
    bar.classList.toggle("hidden", !show);
  }

  // ---------------- 长对话自动摘要压缩 ----------------
  // 轮末触发：未压缩部分超过阈值（条数/字符）时，把早期消息与旧摘要合并成新摘要，
  // 存到当前对话的 compression 字段。失败静默，下轮自动重试；绝不阻塞聊天主流程。
  let _historyCompressRunning = false;
  async function scheduleHistoryCompression() {
    if (_historyCompressRunning) return;
    const C = global.WpsAiChatCompress;
    const Conv = global.WpsAiConversations;
    if (!C || !Conv?.getCurrentId?.()) return;
    const convId = Conv.getCurrentId();
    const comp = Conv.getCompression?.() || null;
    const p = C.plan(chatHistory, comp);
    if (!p) return;
    _historyCompressRunning = true;
    try {
      const lang = (() => { try { return global.WpsAiI18n?.resolvedLang?.() || "zh"; } catch (e) { return "zh"; } })();
      const msgs = C.buildSummaryMessages(comp?.summary || "", chatHistory.slice(p.start, p.end), lang);
      const raw = await global.WpsAiOpenAI.chatCompletion({
        model: els.modelSelect?.value || undefined,
        messages: msgs,
        temperature: 0.2
      });
      // 摘要上限跟随预算分档（对话越重截得越短）
      const summary = String(raw || "").trim().slice(0, p.budget?.summaryLimit || C.SUMMARY_LIMIT);
      // 显式写回触发时的那个对话（压缩期间用户可能已切换对话，不能写到"当前"上）
      if (summary) {
        Conv.setCompression?.(convId, { summary, upTo: p.end });
        try { global.WpsAiLog?.log?.("chat:history-compressed", { upTo: p.end, summaryChars: summary.length }); } catch (e) {}
      }
    } catch (e) {
      console.warn("[chat] 历史压缩失败（忽略，下轮重试）:", e?.message || e);
    } finally {
      _historyCompressRunning = false;
    }
  }

  // ---------------- Settings actions ----------------

  function saveSettings() {
    readSettingsFromForm();
    persistSettings();
    renderProviderState();
    // 设置变更后静默刷新模型列表（保存配置常常意味着 provider/baseUrl/key 改了）
    refreshModels({ silent: true });
    showMessage("设置已保存。", "success");
  }

  // 测试某条 chatProvider 的连通性（被 card 右侧 ⚡ 图标调用，独立于 header 选中状态）
  // 流程：临时把它设为 activeChatModel → 调 listModels → 缓存 → 提示
  // 测试完后保持选中状态（这样用户可以马上从下拉里挑这家的真实模型）
  async function listChatModelsWithProxyMode(entry, useProxy) {
    const reg = global.WpsAiProviderRegistry;
    const provider = reg?.buildProvider?.(Object.assign({}, entry, { useProxy }));
    if (!provider || typeof provider.listModels !== "function") {
      throw new Error("当前供应商不支持模型列表测试。");
    }
    return provider.listModels();
  }

  async function listChatModelsAutoProxy(entry) {
    if (entry.type === "codex") {
      return { models: await listChatModelsWithProxyMode(entry, entry.useProxy !== false), useProxy: entry.useProxy !== false };
    }
    let proxyError = null;
    try {
      return { models: await listChatModelsWithProxyMode(entry, true), useProxy: true };
    } catch (error) {
      proxyError = error;
    }
    try {
      return { models: await listChatModelsWithProxyMode(entry, false), useProxy: false };
    } catch (directError) {
      directError.proxyError = proxyError;
      throw directError;
    }
  }

  async function testSpecificProvider(entry) {
    if (!entry) return;
    const label = entry.label || entry.id;
    if (!entry.enabled) {
      showMessage(`「${label}」未启用，先勾上「启用」再测。`, "info");
      return;
    }
    if (entry.type !== "codex" && !entry.apiKey) {
      showMessage(`「${label}」缺 API Key。`, "error");
      return;
    }
    // 让 getActiveConfig() 能拿到这条 provider
    setActiveChatModel(entry.id, entry.defaultModel || "");
    setBusy(true);
    showMessage(`正在测试供应商「${label}」...`, "info");
    const startedAt = Date.now();
    try {
      const tested = await listChatModelsAutoProxy(entry);
      const models = tested.models;
      if (entry.type !== "codex") {
        entry.useProxy = tested.useProxy;
        persistSettings();
      }
      const clearedCodexDefault = clearUnavailableCodexDefault(entry, models);
      modelsByProvider[entry.id] = models;
      persistModelsCache();
      const picked = models.includes(entry.defaultModel) ? entry.defaultModel : (models[0] || entry.defaultModel || "");
      if (picked) setActiveChatModel(entry.id, picked);
      populateModelSelector(picked);
      // 更新健康探测记录：⑱ 让用户在卡片上直接看到"最近一次连接成功 / 延迟 XXms"
      recordProviderHealth(entry.id, { ok: true, ms: Date.now() - startedAt, error: null });
      // 重新渲染卡片：让默认模型 input 的 datalist 同步到最新模型列表，用户可以直接下拉选
      try { renderChatProvidersList(); } catch (e) {}
      const preview = models.slice(0, 5).join(" / ") + (models.length > 5 ? ` … (+${models.length - 5})` : "");
      const modelNotice = clearedCodexDefault ? "原默认模型不在列表中，已清空，请重新选择。" : "请在默认模型旁的下拉框中选择。";
      showMessage(`供应商「${label}」连通正常，返回 ${models.length} 个模型：${preview}。${modelNotice}`, "success", { duration: 6000 });
    } catch (error) {
      recordProviderHealth(entry.id, { ok: false, ms: Date.now() - startedAt, error: error?.message || String(error) });
      try { renderChatProvidersList(); } catch (e) {}
      showMessage(`供应商「${label}」测试失败：${error.message || error}`, "error");
    } finally {
      setBusy(false);
      renderProviderState();
    }
  }

  // 老的 testChatConnection（footer 已经移除）保留兼容：测试当前激活的 chatProvider
  async function testChatConnection() {
    readSettingsFromForm();
    persistSettings();
    const activeEntry = global.WpsAiProviderRegistry?.getActiveChatProvider?.(currentSettings);
    if (!activeEntry) {
      showMessage("请先在「聊天模型」里启用至少一个供应商。", "error");
      return;
    }
    await testSpecificProvider(activeEntry);
  }

  // ---------------- Settings import / export ----------------

  function pad2(n) { return String(n).padStart(2, "0"); }

  // ----- 配置导出/导入版本管理 + 敏感字段加密 -----
  //
  // 版本规则：每次"配置字段结构发生不兼容变化"才升大版本号；只是加新字段、改默认值算
  // 向后兼容。当前版本：
  const CONFIG_VERSION = "2.0";

  // 敏感字段（导出时加密、导入时解密）。路径以 "." 分隔
  // 路径里允许 "*" 段，表示"该层是个数组/对象，对所有子项应用"
  const SENSITIVE_PATHS = [
    "providers.openai.apiKey",
    "providers.anthropic.apiKey",
    "imageProvider.apiKey",      // 老版兼容
    "imageProvider.codexApiKey", // 老版兼容
    "imageProviders.*.apiKey",   // 新版多渠道
    "chatProviders.*.apiKey"     // 顺手把 chat 多渠道也覆盖（之前漏了）
  ];

  // 简单 XOR + base64 混淆。**对抗目标：避免明文 API Key 被随手分享时泄露**。
  // 不是真正密码学：任何拿到插件源码的人都能解。可以接受，因为：
  //   - 已经在前端，谁拿到设备数据本来就能 dump localStorage
  //   - 我们只防"用户把配置导出文件直接发到群里/邮件"这种意外
  const ENC_SEED = "lingxi-ai-config-v2-seed";

  function encStr(plain) {
    if (typeof plain !== "string" || !plain) return plain;
    let out = "";
    for (let i = 0; i < plain.length; i += 1) {
      out += String.fromCharCode(plain.charCodeAt(i) ^ ENC_SEED.charCodeAt(i % ENC_SEED.length));
    }
    try {
      return "enc:v1:" + btoa(unescape(encodeURIComponent(out)));
    } catch (e) {
      return plain;
    }
  }

  function decStr(cipher) {
    if (typeof cipher !== "string" || !cipher.startsWith("enc:v1:")) return cipher;
    try {
      const raw = decodeURIComponent(escape(atob(cipher.slice("enc:v1:".length))));
      let out = "";
      for (let i = 0; i < raw.length; i += 1) {
        out += String.fromCharCode(raw.charCodeAt(i) ^ ENC_SEED.charCodeAt(i % ENC_SEED.length));
      }
      return out;
    } catch (e) {
      return cipher;
    }
  }

  function applyToSensitive(obj, transform) {
    const out = JSON.parse(JSON.stringify(obj || {}));
    SENSITIVE_PATHS.forEach((path) => applyPath(out, path.split("."), transform));
    return out;
  }

  // 递归走 path 各段。遇到 "*" 段就 fan-out 到当前层全部子项（数组或对象都支持）。
  // 终止条件：parts 走完，对每个被命中的叶子值跑 transform。
  function applyPath(node, parts, transform) {
    if (!parts.length) return;
    const [head, ...rest] = parts;
    if (head === "*") {
      if (Array.isArray(node)) {
        node.forEach((child) => applyPath(child, rest, transform));
      } else if (node && typeof node === "object") {
        Object.values(node).forEach((child) => applyPath(child, rest, transform));
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    if (rest.length === 0) {
      if (node[head]) node[head] = transform(node[head]);
    } else {
      applyPath(node[head], rest, transform);
    }
  }

  // "1.0" / "0.0" / "2.0" semver-ish 比较：返回 -1 / 0 / 1
  function compareConfigVersion(a, b) {
    const pa = String(a || "0.0").split(".").map((x) => parseInt(x, 10) || 0);
    const pb = String(b || "0.0").split(".").map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i += 1) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  // ============================================================
  // 开发者工具：dev 模式检测 + 两个日志按钮
  //   - 导出预览日志：把 __lingxiDumpLogs 的内容当 txt 下载
  //   - 清空预览日志：__lingxiClearLogs
  // （「打开 JS 调试器」按钮已移除：dev 模式下用 WPS 自带 ribbon 按钮 / 右键菜单更可靠；
  //  生产包默认不带 enable_dev / debug，本就拿不到 DevTools 子系统）
  // ============================================================
  // dev 模式 ↔ 生产模式无法靠 URL 区分（生产安装也走 http://127.0.0.1:3889/wpp/...，
  // 跟 wpsjs debug 撞），改成问 proxy 的 /install-path 拿权威结果 —— 它知道自己是
  // 跟着 build-variants 产出的 plugin-<host>/ 跑（=生产），还是源码目录直接跑（=dev）。
  //
  // 同步路径只用作"显式 dev 信号"的快速通道：?dev=1 / file:// / window.__lingxiForceDevMode。
  // 其它走异步 proxy 查询，结果只用于显示开发者工具区。
  function quickDevSignal() {
    try {
      if (/[?&]dev=1\b/i.test(window.location.search)) return true;
      if (window.location.protocol === "file:") return true;
    } catch (e) {}
    if (window.__lingxiForceDevMode === true) return true;
    return false;
  }

  function setupDevToolsSection() {
    const section = els.devToolsSection;
    if (!section) return;
    // 默认隐藏，proxy 确认是 dev 模式才显示（fail-safe：proxy 不通时也隐藏，
    // 避免生产用户看到开发者工具）
    section.classList.add("hidden");
    const showDevTools = () => {
      section.classList.remove("hidden");
      if (els.devModeBadge) {
        const host = window.location.hostname || "";
        const port = window.location.port || "";
        els.devModeBadge.textContent = (host && port) ? `${host}:${port}` : "dev";
      }
      bindDevToolsButtons();
    };
    if (quickDevSignal()) {
      showDevTools();
      return;
    }
    // 异步问 proxy
    fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/install-path", { method: "GET" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.ok && data.mode === "dev") showDevTools(); })
      .catch(() => { /* proxy 不通 → 保持隐藏 */ });
  }

  // 开发者工具区里所有按钮的事件绑定 —— 从 setupDevToolsSection 抽出来，
  // 只在确认是 dev 模式时才调一次（避免生产模式重复绑/资源浪费）
  function bindDevToolsButtons() {
    // 脚本版本徽章：直接显示当前 app.js 的 SCRIPT_VERSION，方便用户重载后一眼确认是不是新代码
    if (els.devScriptVersionBadge) {
      els.devScriptVersionBadge.textContent = `脚本版本: ${SCRIPT_VERSION}`;
      els.devScriptVersionBadge.title = `当前加载的 app.js 版本：${SCRIPT_VERSION}\n重载插件后看这里能立刻确认新代码已生效。`;
    }
    // 「查看日志」：弹窗显示 localStorage 里的全部预览日志，支持过滤 / 仅 WARN / 复制 / 刷新
    els.viewPreviewLogsBtn?.addEventListener("click", () => {
      openDevLogViewer();
    });
    // 「导出预览日志」：把 localStorage 里的日志当 txt 下载
    els.dumpPreviewLogsBtn?.addEventListener("click", () => {
      try {
        const text = window.__lingxiDumpLogs ? window.__lingxiDumpLogs() : "(logger not loaded)";
        if (!text) { showMessage("暂无日志可导出。", "info"); return; }
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `lingxi-preview-log-${new Date().toISOString().slice(0,19).replace(/[T:]/g,"-")}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showMessage(`已导出 ${text.length} 字符的日志。`, "success");
      } catch (e) {
        showMessage(`导出失败：${e?.message || e}`, "error");
      }
    });
    // 「清空预览日志」
    els.clearPreviewLogsBtn?.addEventListener("click", () => {
      if (!confirm(i18nT("清空所有已积累的预览日志？"))) return;
      try {
        window.__lingxiClearLogs?.();
        showMessage("日志已清空。", "success");
        // 弹窗如果开着，顺手刷新
        if (isAntdDevLogViewerOpen()) {
          refreshAntdDevLogViewer();
        } else if (els.devLogViewerModal && !els.devLogViewerModal.classList.contains("hidden")) {
          renderDevLogViewer();
        }
      } catch (e) { showMessage(`清空失败：${e?.message || e}`, "error"); }
    });
    // ====== 日志查看弹窗的事件 ======
    els.devLogViewerCloseBtn?.addEventListener("click", () => {
      els.devLogViewerModal?.classList.add("hidden");
    });
    els.devLogViewerRefreshBtn?.addEventListener("click", () => renderDevLogViewer());
    els.devLogViewerCopyBtn?.addEventListener("click", async () => {
      const text = els.devLogViewerOutput?.textContent || "";
      if (!text) { showMessage("当前没有可复制的内容。", "info"); return; }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          showMessage(`已复制 ${text.length} 字符。`, "success");
        } else {
          // 回退：选中 + execCommand
          const pre = els.devLogViewerOutput;
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand("copy");
          sel.removeAllRanges();
          showMessage(`已复制 ${text.length} 字符。`, "success");
        }
      } catch (e) { showMessage(`复制失败：${e?.message || e}`, "error"); }
    });
    els.devLogViewerScrollBottomBtn?.addEventListener("click", () => {
      if (els.devLogViewerOutput) els.devLogViewerOutput.scrollTop = els.devLogViewerOutput.scrollHeight;
    });
    // 过滤是即时的，input / change 都触发重渲
    els.devLogViewerFilter?.addEventListener("input", () => renderDevLogViewer({ keepScroll: true }));
    els.devLogViewerWarnOnly?.addEventListener("change", () => renderDevLogViewer({ keepScroll: true }));
    // ESC 关闭弹窗
    els.devLogViewerModal?.addEventListener("click", (ev) => {
      // 点击遮罩（不是内部 modal-card）关闭
      if (ev.target === els.devLogViewerModal) els.devLogViewerModal.classList.add("hidden");
    });
  }

  function openDevLogViewer() {
    if (openAntdDevLogViewer()) return;
    if (!els.devLogViewerModal) return;
    els.devLogViewerModal.classList.remove("hidden");
    renderDevLogViewer();
    // 默认滚到底，看最新的几条
    setTimeout(() => {
      if (els.devLogViewerOutput) els.devLogViewerOutput.scrollTop = els.devLogViewerOutput.scrollHeight;
    }, 0);
  }

  // 从 localStorage 拉日志 → 过滤 → 渲染到 pre 里。filter 关键词不区分大小写；warnOnly 只留 WARN。
  function openAntdDevLogViewer() {
    const modals = global.WpsAiAntdModals;
    if (!modals?.ready || typeof modals.openDevLogViewer !== "function") return false;
    modals.openDevLogViewer({
      store: global.WpsAiStore,
      logKey: PREVIEW_LOG_KEY,
      showMessage
    });
    return true;
  }

  function refreshAntdDevLogViewer() {
    const modals = global.WpsAiAntdModals;
    if (!modals?.ready || typeof modals.refreshDevLogViewer !== "function") return false;
    modals.refreshDevLogViewer();
    return true;
  }

  function isAntdDevLogViewerOpen() {
    const modals = global.WpsAiAntdModals;
    return !!(modals?.ready && typeof modals.isDevLogViewerOpen === "function" && modals.isDevLogViewerOpen());
  }

  function renderDevLogViewer(opts) {
    opts = opts || {};
    const pre = els.devLogViewerOutput;
    const stats = els.devLogViewerStats;
    if (!pre) return;
    const prevScroll = opts.keepScroll ? pre.scrollTop : null;
    let list = [];
    try {
      const raw = global.WpsAiStore.getItem(PREVIEW_LOG_KEY);
      if (raw) list = JSON.parse(raw) || [];
    } catch (e) { /* 解析失败当空 */ }
    const total = list.length;
    const kwRaw = String(els.devLogViewerFilter?.value || "").trim().toLowerCase();
    const warnOnly = !!els.devLogViewerWarnOnly?.checked;
    let filtered = list;
    if (warnOnly) filtered = filtered.filter((e) => e.level === "WARN");
    if (kwRaw) {
      filtered = filtered.filter((e) => {
        const hay = `[${e.level}][${e.where}][${e.tag}] ${e.msg || ""}`.toLowerCase();
        return hay.includes(kwRaw);
      });
    }
    const text = filtered.map((e) => {
      const t = new Date(e.ts).toISOString().slice(11, 23);
      return `${t} [${e.level}][${e.where}][${e.tag}] ${e.msg}`;
    }).join("\n");
    pre.textContent = text || "(无匹配日志)";
    if (stats) {
      stats.textContent = filtered.length === total
        ? `${total} 条`
        : `${filtered.length} / ${total} 条`;
    }
    if (prevScroll != null) pre.scrollTop = prevScroll;
  }

  function exportSettings() {
    // 先把表单状态同步进 currentSettings（用户可能改了没保存就直接导出）
    readSettingsFromForm();
    persistSettings();

    const now = new Date();
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const safeSettings = applyToSensitive(currentSettings, encStr);
    const payload = {
      app: "lingxi-ai",
      version: CONFIG_VERSION,
      encrypted: true,
      encryptedFields: SENSITIVE_PATHS,
      exportedAt: now.toISOString(),
      settings: safeSettings
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lingxi-ai-settings-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);

    showMessage(`已导出当前配置 (v${CONFIG_VERSION})。API Key 已加密。`, "info", { duration: 4500 });
  }

  function applyImportedSettings(parsed) {
    // 接受两种结构：1) 完整封装 { app, version, settings }；2) 直接是 settings 主体
    const isWrapped = parsed && typeof parsed === "object"
      && parsed.settings && typeof parsed.settings === "object";
    const incoming = isWrapped ? parsed.settings : parsed;
    // 包装内有 version 用包装的；没包装就是 "0.0"（最老的无版本号导出）
    const incomingVersion = isWrapped && typeof parsed.version !== "undefined"
      ? String(parsed.version)
      : "0.0";

    if (!incoming || typeof incoming !== "object") {
      throw new Error("文件内容不是合法的配置 JSON。");
    }

    // 版本兼容判断
    const cmp = compareConfigVersion(incomingVersion, CONFIG_VERSION);
    if (cmp > 0) {
      // 导入版本比当前插件新——结构可能有变，弹窗确认
      const proceed = confirm(
        `配置版本不兼容：\n` +
        `  导入文件版本：${incomingVersion}\n` +
        `  当前插件版本：${CONFIG_VERSION}\n\n` +
        `导入文件来自更新的插件版本，部分字段可能识别不了。继续导入？`
      );
      if (!proceed) throw new Error("已取消导入（版本不兼容）。");
    }

    // 解密：要么 wrapper 标 encrypted=true，要么字段以 enc:v1: 开头
    const wantsDecrypt = isWrapped && parsed.encrypted === true;
    const settingsToApply = wantsDecrypt
      ? applyToSensitive(incoming, decStr)
      : applyToSensitive(incoming, (s) => decStr(s));  // 即使没 wrapper 标记也试着按字段前缀解

    // 用注册表的默认值兜底，再用导入的值覆盖（防御未来字段缺失）
    const defaults = global.WpsAiProviderRegistry.DEFAULT_SETTINGS;
    const cloned = JSON.parse(JSON.stringify(defaults));

    if (typeof settingsToApply.activeProvider === "string") cloned.activeProvider = settingsToApply.activeProvider;
    if (typeof settingsToApply.operationMode === "string") cloned.operationMode = settingsToApply.operationMode;
    if (typeof settingsToApply.maxToolIterations === "number") cloned.maxToolIterations = settingsToApply.maxToolIterations;

    if (settingsToApply.providers && typeof settingsToApply.providers === "object") {
      Object.keys(cloned.providers).forEach((key) => {
        if (settingsToApply.providers[key]) {
          cloned.providers[key] = Object.assign({}, cloned.providers[key], settingsToApply.providers[key]);
        }
      });
    }
    // 新版多渠道：直接覆盖整个数组（与 chatProviders 一致）。
    if (Array.isArray(settingsToApply.imageProviders) && settingsToApply.imageProviders.length > 0) {
      cloned.imageProviders = settingsToApply.imageProviders.map((p) => Object.assign({}, p));
    } else if (settingsToApply.imageProvider && typeof settingsToApply.imageProvider === "object") {
      // 老版导出文件兼容：保留老字段，由 loadSettings 下次解析时迁移到 imageProviders
      cloned.imageProvider = Object.assign({}, cloned.imageProvider, settingsToApply.imageProvider);
    }
    if (settingsToApply.stylePreset && typeof settingsToApply.stylePreset === "object") {
      cloned.stylePreset = Object.assign({}, cloned.stylePreset, settingsToApply.stylePreset);
    }
    if (Array.isArray(settingsToApply.mcpClients)) cloned.mcpClients = settingsToApply.mcpClients.map((c) => Object.assign({}, c));

    currentSettings = cloned;
    persistSettings();
    // 走一遍 loadSettings 触发老 imageProvider → imageProviders 迁移（同样适用于 chatProviders）
    currentSettings = global.WpsAiProviderRegistry.loadSettings();
    // 导入的配置里可能带了新的 MCP 服务，立即 reconcile 使其生效，不必等下次启动或手动切换开关
    try { global.WpsAiMcpClient?.reconcile?.(currentSettings.mcpClients || []); } catch (e) { console.warn("[mcp-client] import reconcile 失败", e); }
    applySettingsToForm();
    refreshModels({ silent: true });
    renderProviderState();

    return { incomingVersion };
  }

  function importSettings(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => showMessage("读取文件失败。", "error");
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const info = applyImportedSettings(parsed);
        showMessage(`已从 ${file.name} 导入配置（来源版本 v${info.incomingVersion}）。`, "success");
      } catch (error) {
        showMessage(`导入失败：${error.message || error}`, "error");
      }
    };
    reader.readAsText(file, "utf-8");
  }

  // ---------------- PPT 风格 / 大纲 modal ----------------

  // 12 套主题预设（与 registry.js 的 COLOR_SCHEMES 镜像；前端单独存一份避免跨文件依赖）
  // 与 registry.js 中的 COLOR_SCHEMES 保持同步——配色经过对比度核对，并附设计灵感来源
  const COLOR_SCHEMES = {
    "bold-signal":       { darkMode: false, primaryColor: "#1A1A1A", secondaryColor: "#525252", accentColor: "#FF5722", backgroundColor: "#FAFAFA", surfaceColor: "#F4F4F5", titleColor: "#1A1A1A", bodyColor: "#404040", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "electric-studio":   { darkMode: false, primaryColor: "#2563EB", secondaryColor: "#1E3A8A", accentColor: "#F97316", backgroundColor: "#FFFFFF", surfaceColor: "#F1F5F9", titleColor: "#0F172A", bodyColor: "#475569", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "creative-voltage":  { darkMode: false, primaryColor: "#C2410C", secondaryColor: "#1E40AF", accentColor: "#EAB308", backgroundColor: "#FAF3E7", surfaceColor: "#FCE7C5", titleColor: "#1C1917", bodyColor: "#57534E", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "dark-botanical":    { darkMode: true,  primaryColor: "#2D4A38", secondaryColor: "#4A6B53", accentColor: "#B8916D", backgroundColor: "#0F1A14", surfaceColor: "#1F2D24", titleColor: "#EFE8D7", bodyColor: "#A9B3A4", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "notebook-tabs":     { darkMode: false, primaryColor: "#1E40AF", secondaryColor: "#B91C1C", accentColor: "#B45309", backgroundColor: "#FAFAF2", surfaceColor: "#F5F0DC", titleColor: "#1C1917", bodyColor: "#44403C", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "pastel-geometry":   { darkMode: false, primaryColor: "#8B7CF6", secondaryColor: "#FBA774", accentColor: "#5EEAD4", backgroundColor: "#FFFCF7", surfaceColor: "#F3EEFF", titleColor: "#312E81", bodyColor: "#4F4870", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "split-pastel":      { darkMode: false, primaryColor: "#EC4899", secondaryColor: "#06B6D4", accentColor: "#FACC15", backgroundColor: "#FFFFFF", surfaceColor: "#FFE4ED", titleColor: "#831843", bodyColor: "#4A2A4A", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "vintage-editorial": { darkMode: false, primaryColor: "#5C2A2A", secondaryColor: "#8B6F47", accentColor: "#C8553D", backgroundColor: "#F0E8D6", surfaceColor: "#E0D4BC", titleColor: "#1C0D02", bodyColor: "#3A2E1F", titleFont: "宋体",            bodyFont: "宋体" },
    "neon-cyber":        { darkMode: true,  primaryColor: "#6366F1", secondaryColor: "#8B5CF6", accentColor: "#22D3EE", backgroundColor: "#0A0E1A", surfaceColor: "#131829", titleColor: "#F8FAFC", bodyColor: "#94A3B8", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "terminal-green":    { darkMode: true,  primaryColor: "#4ADE80", secondaryColor: "#FBBF24", accentColor: "#F87171", backgroundColor: "#0D1117", surfaceColor: "#161B22", titleColor: "#E6EDF3", bodyColor: "#8B949E", titleFont: "Consolas",         bodyFont: "Consolas" },
    "swiss-modern":      { darkMode: false, primaryColor: "#000000", secondaryColor: "#525252", accentColor: "#DC2626", backgroundColor: "#FFFFFF", surfaceColor: "#F4F4F5", titleColor: "#000000", bodyColor: "#262626", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "paper-ink":         { darkMode: false, primaryColor: "#1C1917", secondaryColor: "#44403C", accentColor: "#991B1B", backgroundColor: "#F5EDD8", surfaceColor: "#E8DCBF", titleColor: "#1C1917", bodyColor: "#292524", titleFont: "宋体",            bodyFont: "宋体" },
    "8-bit-orbit":           { darkMode: true, primaryColor: "#5EDCF4", secondaryColor: "#F0A6CA", accentColor: "#F4D03F", backgroundColor: "#0A0E27", surfaceColor: "#0F1B3D", titleColor: "#FFFFFF", bodyColor: "#E2D5F2", titleFont: "Tektur", bodyFont: "Chakra Petch" },
    "biennale-yellow":       { darkMode: false, primaryColor: "#F1EE2E", secondaryColor: "#E26B4A", accentColor: "#F0DA7C", backgroundColor: "#E9E5DB", surfaceColor: "#DCD6C4", titleColor: "#1B2566", bodyColor: "#1B2566", titleFont: "Instrument Serif", bodyFont: "Archivo" },
    "block-frame":           { darkMode: false, primaryColor: "#000000", secondaryColor: "#FE90E8", accentColor: "#F7CB46", backgroundColor: "#FFFFFF", surfaceColor: "#FFFDF5", titleColor: "#000000", bodyColor: "#000000", titleFont: "Inter", bodyFont: "Space Grotesk" },
    "blue-professional":     { darkMode: false, primaryColor: "#1E2BFA", secondaryColor: "#111111", accentColor: "#1E2BFA", backgroundColor: "#FDFAE7", surfaceColor: "#FDFAE7", titleColor: "#111111", bodyColor: "#6B6B6B", titleFont: "Space Grotesk", bodyFont: "Inter" },
    "bold-poster":           { darkMode: false, primaryColor: "#D8000F", secondaryColor: "#1C1410", accentColor: "#D8000F", backgroundColor: "#FFFFFF", surfaceColor: "#F5F2EF", titleColor: "#1C1410", bodyColor: "#1C1410", titleFont: "Shrikhand", bodyFont: "Libre Baskerville" },
    "broadside":             { darkMode: true, primaryColor: "#E85D26", secondaryColor: "#F0ECE5", accentColor: "#E85D26", backgroundColor: "#111111", surfaceColor: "#1A1A18", titleColor: "#F0ECE5", bodyColor: "#888880", titleFont: "Barlow", bodyFont: "IBM Plex Mono" },
    "capsule":               { darkMode: false, primaryColor: "#E85D4E", secondaryColor: "#1E1E1E", accentColor: "#C4D94E", backgroundColor: "#F5F5F0", surfaceColor: "#FFFFFF", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Bodoni Moda", bodyFont: "Space Grotesk" },
    "cartesian":             { darkMode: false, primaryColor: "#1A1A1A", secondaryColor: "#8A8178", accentColor: "#B8B0A4", backgroundColor: "#EDE8E0", surfaceColor: "#E2DBD1", titleColor: "#1A1A1A", bodyColor: "#5A5A5A", titleFont: "Playfair Display", bodyFont: "Inter" },
    "cobalt-grid":           { darkMode: false, primaryColor: "#1F2BE0", secondaryColor: "#5560E5", accentColor: "#1F2BE0", backgroundColor: "#F0EBDE", surfaceColor: "#E6E0CE", titleColor: "#1F2BE0", bodyColor: "#1F2BE0", titleFont: "Newsreader", bodyFont: "Hanken Grotesk" },
    "coral":                 { darkMode: true, primaryColor: "#E85D5D", secondaryColor: "#F5F0E8", accentColor: "#E85D5D", backgroundColor: "#1A1A1A", surfaceColor: "#F5F0E8", titleColor: "#F5F0E8", bodyColor: "#B0B0B0", titleFont: "Bebas Neue", bodyFont: "Inter" },
    "creative-mode":         { darkMode: false, primaryColor: "#0F0F0F", secondaryColor: "#1F8A4C", accentColor: "#F06CA8", backgroundColor: "#EFE9D9", surfaceColor: "#E4DCC4", titleColor: "#0F0F0F", bodyColor: "#2A2A2A", titleFont: "Archivo Black", bodyFont: "Space Grotesk" },
    "daisy-days":            { darkMode: false, primaryColor: "#F7C8D4", secondaryColor: "#FDE68A", accentColor: "#D4A5E8", backgroundColor: "#F5F0E6", surfaceColor: "#7ECDC0", titleColor: "#3A2A1A", bodyColor: "#3A2A1A", titleFont: "Fredoka One", bodyFont: "Quicksand" },
    "editorial-forest":      { darkMode: false, primaryColor: "#2E4A2A", secondaryColor: "#E89CB1", accentColor: "#E89CB1", backgroundColor: "#EFE7D4", surfaceColor: "#E6DCC4", titleColor: "#2E4A2A", bodyColor: "#1A1A17", titleFont: "Source Serif 4", bodyFont: "Source Serif 4" },
    "editorial-tri-tone":    { darkMode: false, primaryColor: "#7A1F35", secondaryColor: "#F2B6C6", accentColor: "#F2D86A", backgroundColor: "#F2D86A", surfaceColor: "#F2B6C6", titleColor: "#7A1F35", bodyColor: "#7A1F35", titleFont: "Bricolage Grotesque", bodyFont: "Bricolage Grotesque" },
    "emerald-editorial":     { darkMode: true, primaryColor: "#3CD896", secondaryColor: "#0F1A5C", accentColor: "#F1E9D6", backgroundColor: "#3CD896", surfaceColor: "#2DC684", titleColor: "#0F1A5C", bodyColor: "#0F1A5C", titleFont: "Bodoni Moda", bodyFont: "Manrope" },
    "grove":                 { darkMode: true, primaryColor: "#C8524A", secondaryColor: "#E8E4D6", accentColor: "#C8524A", backgroundColor: "#192B1B", surfaceColor: "#1E3221", titleColor: "#E8E4D6", bodyColor: "#D4CFBF", titleFont: "Playfair Display", bodyFont: "Jost" },
    "long-table":            { darkMode: false, primaryColor: "#B53D2A", secondaryColor: "#8E2D1F", accentColor: "#B53D2A", backgroundColor: "#FAF1E2", surfaceColor: "#F2E5CF", titleColor: "#B53D2A", bodyColor: "#B53D2A", titleFont: "Bricolage Grotesque", bodyFont: "Fraunces" },
    "mat":                   { darkMode: true, primaryColor: "#C07030", secondaryColor: "#EDE6D0", accentColor: "#C07030", backgroundColor: "#232E26", surfaceColor: "#EDE6D0", titleColor: "#F0E8D2", bodyColor: "#F0E8D2", titleFont: "Bricolage Grotesque", bodyFont: "DM Sans" },
    "monochrome":            { darkMode: false, primaryColor: "#1A1A16", secondaryColor: "#5E5E54", accentColor: "#8A8A80", backgroundColor: "#FAFADF", surfaceColor: "#F2F2D2", titleColor: "#1A1A16", bodyColor: "#1A1A16", titleFont: "Lora", bodyFont: "Jost" },
    "neo-grid-bold":         { darkMode: false, primaryColor: "#0A0A0A", secondaryColor: "#8A8A85", accentColor: "#E6FF3D", backgroundColor: "#F5F4EF", surfaceColor: "#ECECE8", titleColor: "#0A0A0A", bodyColor: "#0A0A0A", titleFont: "Space Grotesk", bodyFont: "JetBrains Mono" },
    "peoples-platform":      { darkMode: false, primaryColor: "#2C2CDC", secondaryColor: "#F2A03A", accentColor: "#E83A2A", backgroundColor: "#F5F2EA", surfaceColor: "#F4E9D6", titleColor: "#2C2CDC", bodyColor: "#1A1A1A", titleFont: "Alfa Slab One", bodyFont: "DM Mono" },
    "pin-and-paper":         { darkMode: false, primaryColor: "#1F3A8A", secondaryColor: "#2D4FB8", accentColor: "#C9A66B", backgroundColor: "#EFE56A", surfaceColor: "#F8F1D6", titleColor: "#1F3A8A", bodyColor: "#1F3A8A", titleFont: "Space Grotesk", bodyFont: "DM Mono" },
    "pink-script":           { darkMode: true, primaryColor: "#ED3D8C", secondaryColor: "#FF66A8", accentColor: "#ED3D8C", backgroundColor: "#060507", surfaceColor: "#0F0D11", titleColor: "#F5EDF1", bodyColor: "#F5EDF1", titleFont: "DM Serif Display", bodyFont: "Inter" },
    "playful":               { darkMode: false, primaryColor: "#1A1A1A", secondaryColor: "#E8B88E", accentColor: "#1A1A1A", backgroundColor: "#F0C8A0", surfaceColor: "#F7DEC6", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Syne", bodyFont: "Space Grotesk" },
    "raw-grid":              { darkMode: false, primaryColor: "#0A0A0A", secondaryColor: "#F2D4CF", accentColor: "#E5EDD6", backgroundColor: "#FFFFFF", surfaceColor: "#F5F5F5", titleColor: "#0A0A0A", bodyColor: "#333333", titleFont: "Segoe UI", bodyFont: "Segoe UI" },
    "retro-windows":         { darkMode: false, primaryColor: "#000080", secondaryColor: "#808080", accentColor: "#0000A0", backgroundColor: "#C0C0C0", surfaceColor: "#D4D0C8", titleColor: "#000000", bodyColor: "#222222", titleFont: "Press Start 2P", bodyFont: "MS Sans Serif" },
    "retro-zine":            { darkMode: false, primaryColor: "#008F4D", secondaryColor: "#1A1A1A", accentColor: "#00A85D", backgroundColor: "#C8B99A", surfaceColor: "#F4EFE6", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Bebas Neue", bodyFont: "Space Grotesk" },
    "sakura-chroma":         { darkMode: false, primaryColor: "#E5392A", secondaryColor: "#E54489", accentColor: "#F09131", backgroundColor: "#F1E6CB", surfaceColor: "#E5D6B0", titleColor: "#3A2516", bodyColor: "#3A2516", titleFont: "Big Shoulders Display", bodyFont: "Albert Sans" },
    "scatterbrain":          { darkMode: false, primaryColor: "#FFE066", secondaryColor: "#FFC9C9", accentColor: "#B2F2BB", backgroundColor: "#FFE066", surfaceColor: "#A5D8FF", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Shrikhand", bodyFont: "Zilla Slab" },
    "signal":                { darkMode: true, primaryColor: "#1C2644", secondaryColor: "#F0ECE3", accentColor: "#C8A870", backgroundColor: "#1C2644", surfaceColor: "#F0ECE3", titleColor: "#E2DCD0", bodyColor: "#8A96A8", titleFont: "Source Serif 4", bodyFont: "DM Sans" },
    "soft-editorial":        { darkMode: false, primaryColor: "#2A241B", secondaryColor: "#E1A4C2", accentColor: "#D6DD63", backgroundColor: "#F2EEDF", surfaceColor: "#ECE6D2", titleColor: "#2A241B", bodyColor: "#5C5345", titleFont: "Cormorant Garamond", bodyFont: "Work Sans" },
    "stencil-tablet":        { darkMode: false, primaryColor: "#0A0A0A", secondaryColor: "#A06A3C", accentColor: "#C73B7A", backgroundColor: "#E2DCC9", surfaceColor: "#F4EFE0", titleColor: "#0A0A0A", bodyColor: "#0A0A0A", titleFont: "Stardos Stencil", bodyFont: "Inter" },
    "studio":                { darkMode: true, primaryColor: "#F5D200", secondaryColor: "#F0CC00", accentColor: "#F5D200", backgroundColor: "#1C1C1C", surfaceColor: "#242422", titleColor: "#F5D200", bodyColor: "#F5D200", titleFont: "Barlow", bodyFont: "Barlow" },
    "vellum":                { darkMode: true, primaryColor: "#E8D85C", secondaryColor: "#F5E168", accentColor: "#3A7878", backgroundColor: "#2A3870", surfaceColor: "#343F80", titleColor: "#E8D85C", bodyColor: "#E8D85C", titleFont: "Cormorant Garamond", bodyFont: "DM Sans" },
  };

  function openStylePresetModal() {
    const sp = currentSettings.stylePreset || {};
    els.styleEnabled.checked = !!sp.enabled;
    els.styleTitleFont.value = sp.titleFont || "Microsoft YaHei";
    els.styleTitleSize.value = sp.titleSize || 32;
    els.styleTitleBold.checked = sp.titleBold !== false;
    els.styleTitleColor.value = sp.titleColor || "#1f2329";
    els.styleBodyFont.value = sp.bodyFont || "Microsoft YaHei";
    els.styleBodySize.value = sp.bodySize || 18;
    els.styleBodyColor.value = sp.bodyColor || "#33363c";
    // 兼容老版本保存的 scheme 名（navy/techDark/minimal/warmth），不再支持时回退 custom
    const validSchemes = new Set(Object.keys(COLOR_SCHEMES).concat(["custom"]));
    els.styleScheme.value = validSchemes.has(sp.scheme) ? sp.scheme : "custom";
    els.stylePrimaryColor.value = sp.primaryColor || "#1f3a5f";
    els.styleSecondaryColor.value = sp.secondaryColor || "#3d5a80";
    els.styleAccentColor.value = sp.accentColor || "#ee6c4d";
    els.styleBackgroundColor.value = sp.backgroundColor || "#ffffff";
    els.styleSurfaceColor.value = sp.surfaceColor || "#f5f7fa";
    els.styleThemeFile.value = sp.themeFile || "";
    renderThemeGrid();
    updateSchemePreview(els.styleScheme.value);
    updateLivePreview();
    els.stylePresetModal.classList.remove("hidden");
  }

  // 主题网格：把全部 COLOR_SCHEMES 渲染成迷你幻灯片卡，替代 40+ 项 <select>。
  // 每张卡用主题自己的 background/primary/accent/title/body 颜色画一张缩略图，
  // 用户一眼能看出"这套配出来什么调"。点卡 = 选中 + applyColorScheme + 高亮。
  function renderThemeGrid() {
    const host = els.styleThemeGrid;
    if (!host) return;
    const fullSchemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const currentName = els.styleScheme?.value || "custom";
    host.innerHTML = "";

    // "自定义" 卡放第一位 —— 用 dashed 边框示意"无预设"
    const customCard = document.createElement("button");
    customCard.type = "button";
    customCard.className = "theme-card theme-card-custom" + (currentName === "custom" ? " selected" : "");
    customCard.dataset.scheme = "custom";
    customCard.setAttribute("role", "option");
    customCard.setAttribute("aria-selected", currentName === "custom" ? "true" : "false");
    customCard.innerHTML = `
      <div class="theme-card-thumb theme-card-thumb-custom">
        <span class="theme-card-thumb-glyph">＋</span>
      </div>
      <div class="theme-card-label">自定义</div>
      <div class="theme-card-desc">从字体/配色微调开始</div>
    `;
    customCard.addEventListener("click", () => selectScheme("custom"));
    host.appendChild(customCard);

    // 各内置主题卡
    Object.entries(fullSchemes).forEach(([name, s]) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "theme-card" + (currentName === name ? " selected" : "");
      if (s.darkMode) card.classList.add("theme-card-dark");
      card.dataset.scheme = name;
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", currentName === name ? "true" : "false");
      // 迷你幻灯片缩略图：背景 = backgroundColor；顶部装饰条 = primary；
      // 大字 "Aa" = titleColor + titleFont；副条 = accent；小色块 = secondary/surface
      card.innerHTML = `
        <div class="theme-card-thumb" style="background:${escapeAttr(s.backgroundColor || "#fff")}">
          <div class="theme-card-thumb-bar" style="background:${escapeAttr(s.primaryColor || "#000")}"></div>
          <div class="theme-card-thumb-title" style="color:${escapeAttr(s.titleColor || "#000")};font-family:${escapeAttr(s.titleFont || "sans-serif")}">Aa</div>
          <div class="theme-card-thumb-body" style="color:${escapeAttr(s.bodyColor || "#666")};font-family:${escapeAttr(s.bodyFont || "sans-serif")}">Lingxi</div>
          <div class="theme-card-thumb-accent" style="background:${escapeAttr(s.accentColor || "#f80")}"></div>
          <div class="theme-card-thumb-swatches">
            <span style="background:${escapeAttr(s.secondaryColor || "transparent")}"></span>
            <span style="background:${escapeAttr(s.surfaceColor || "transparent")}"></span>
          </div>
        </div>
        <div class="theme-card-label">${escapeHtml(s.label || name)}</div>
        <div class="theme-card-desc">${escapeHtml((s.description || "").split("·").pop().trim())}</div>
      `;
      card.title = `${s.label || name}\n${s.description || ""}`;
      card.addEventListener("click", () => selectScheme(name));
      host.appendChild(card);
    });
  }

  // 点主题卡 = 选中 + 把该主题的颜色字段写回表单 + 刷新高亮和预览
  function selectScheme(name) {
    els.styleScheme.value = name;
    if (name !== "custom") applyColorScheme(name);
    // 高亮切换
    els.styleThemeGrid?.querySelectorAll(".theme-card").forEach((c) => {
      const sel = c.dataset.scheme === name;
      c.classList.toggle("selected", sel);
      c.setAttribute("aria-selected", sel ? "true" : "false");
    });
    updateSchemePreview(name);
    updateLivePreview();
  }

  // 实时预览：把当前所有颜色/字体写到顶部那个迷你幻灯片上。
  // 任何字段改动都要调一次。
  function updateLivePreview() {
    const slide = els.styleLivePreview?.querySelector(".style-live-slide");
    if (!slide) return;
    const titleEl = slide.querySelector(".style-live-title");
    const bodyEl = slide.querySelector(".style-live-body");
    const accentEl = slide.querySelector(".style-live-accent");
    const chipEl = slide.querySelector(".style-live-chip");
    const bg = els.styleBackgroundColor.value || "#fff";
    const surface = els.styleSurfaceColor.value || "#f5f7fa";
    const primary = els.stylePrimaryColor.value || "#1f3a5f";
    const accent = els.styleAccentColor.value || "#ee6c4d";
    const titleColor = els.styleTitleColor.value || "#1f2329";
    const bodyColor = els.styleBodyColor.value || "#33363c";
    const titleFont = els.styleTitleFont.value || "Microsoft YaHei";
    const bodyFont = els.styleBodyFont.value || "Microsoft YaHei";
    const titleSize = Math.max(8, Math.min(96, parseInt(els.styleTitleSize.value, 10) || 32));
    const bodySize = Math.max(8, Math.min(72, parseInt(els.styleBodySize.value, 10) || 18));
    const titleBold = els.styleTitleBold.checked;

    slide.style.background = bg;
    slide.style.borderColor = primary + "30";
    if (accentEl) accentEl.style.background = primary;
    if (titleEl) {
      titleEl.style.color = titleColor;
      titleEl.style.fontFamily = titleFont;
      // 预览块高度有限，标题字号按比例缩到 1/2，保证大字号也能完整显示
      titleEl.style.fontSize = Math.round(titleSize * 0.55) + "px";
      titleEl.style.fontWeight = titleBold ? "700" : "500";
    }
    if (bodyEl) {
      bodyEl.style.color = bodyColor;
      bodyEl.style.fontFamily = bodyFont;
      bodyEl.style.fontSize = Math.round(bodySize * 0.7) + "px";
    }
    if (chipEl) {
      chipEl.style.background = accent;
      chipEl.style.borderColor = surface;
    }
    if (els.styleLiveMeta) {
      els.styleLiveMeta.textContent = `${titleFont} ${titleSize}pt / ${bodyFont} ${bodySize}pt`;
    }
  }

  function applyColorScheme(name) {
    const scheme = COLOR_SCHEMES[name];
    if (!scheme) return;
    els.stylePrimaryColor.value = scheme.primaryColor;
    els.styleSecondaryColor.value = scheme.secondaryColor;
    els.styleAccentColor.value = scheme.accentColor;
    els.styleBackgroundColor.value = scheme.backgroundColor;
    els.styleSurfaceColor.value = scheme.surfaceColor;
    els.styleTitleColor.value = scheme.titleColor;
    els.styleBodyColor.value = scheme.bodyColor;
    if (scheme.titleFont) els.styleTitleFont.value = scheme.titleFont;
    if (scheme.bodyFont) els.styleBodyFont.value = scheme.bodyFont;
  }

  // 任何颜色字段被手动改动后，scheme 自动切回 custom（避免误以为还是预设）
  // 同时更新主题网格选中态 + 实时预览块
  function markCustomScheme() {
    els.styleScheme.value = "custom";
    updateSchemePreview("custom");
    els.styleThemeGrid?.querySelectorAll(".theme-card").forEach((c) => {
      const sel = c.dataset.scheme === "custom";
      c.classList.toggle("selected", sel);
      c.setAttribute("aria-selected", sel ? "true" : "false");
    });
    updateLivePreview();
  }

  // 主题预览卡：根据选中 scheme 渲染色块 + 签名视觉元素 + 推荐版式。
  // 数据从 global.WpsAiProviderRegistry.COLOR_SCHEMES 取（含 signatureElement / layoutHints），
  // 不依赖本文件局部的 COLOR_SCHEMES 镜像（镜像仅包含 colors/fonts）。
  function updateSchemePreview(name) {
    const card = els.styleSchemePreview;
    if (!card) return;
    if (!name || name === "custom") {
      card.classList.add("hidden");
      return;
    }
    const fullSchemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const s = fullSchemes[name];
    if (!s) {
      card.classList.add("hidden");
      return;
    }
    if (els.styleSchemePreviewLabel) els.styleSchemePreviewLabel.textContent = s.label || name;
    if (els.styleSchemePreviewDesc) els.styleSchemePreviewDesc.textContent = s.description || "";
    if (els.styleSchemePreviewSignature) els.styleSchemePreviewSignature.textContent = s.signatureElement || "（无）";
    if (els.styleSchemePreviewHints) els.styleSchemePreviewHints.textContent = s.layoutHints || "（无）";
    const swatchHost = els.styleSchemePreviewSwatches;
    if (swatchHost) {
      const swatches = [
        ["主色 primary", s.primaryColor],
        ["次色 secondary", s.secondaryColor],
        ["强调 accent", s.accentColor],
        ["底色 background", s.backgroundColor],
        ["卡片 surface", s.surfaceColor]
      ];
      swatchHost.innerHTML = "";
      for (const [title, color] of swatches) {
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = color || "transparent";
        sw.title = `${title}: ${color || "—"}`;
        swatchHost.appendChild(sw);
      }
    }
    card.classList.remove("hidden");
  }

  function closeStylePresetModal() {
    els.stylePresetModal.classList.add("hidden");
  }

  function saveStylePreset(opts) {
    if (!els.styleEnabled) return; // 表单未挂载（独立窗口 init 失败）
    currentSettings.stylePreset = {
      enabled: els.styleEnabled.checked,
      titleFont: els.styleTitleFont.value.trim() || "Microsoft YaHei",
      titleSize: parseInt(els.styleTitleSize.value, 10) || 32,
      titleBold: els.styleTitleBold.checked,
      titleColor: els.styleTitleColor.value || "#1f2329",
      bodyFont: els.styleBodyFont.value.trim() || "Microsoft YaHei",
      bodySize: parseInt(els.styleBodySize.value, 10) || 18,
      bodyColor: els.styleBodyColor.value || "#33363c",
      scheme: els.styleScheme.value || "custom",
      primaryColor: els.stylePrimaryColor.value || "#1f3a5f",
      secondaryColor: els.styleSecondaryColor.value || "#3d5a80",
      accentColor: els.styleAccentColor.value || "#ee6c4d",
      backgroundColor: els.styleBackgroundColor.value || "#ffffff",
      surfaceColor: els.styleSurfaceColor.value || "#f5f7fa",
      themeFile: els.styleThemeFile.value.trim()
    };
    persistSettings();
    if (opts?.silent) return; // X-close 时静默保存，不弹 toast / 不关 modal
    closeStylePresetModal();
    showMessage("PPT 风格预设已保存。下次 AI 生成幻灯片会按此色板和样式。", "success");
  }

  function openOutlineModal() {
    if (!els.outlineText.value) {
      els.outlineText.value = "";
    }
    els.outlineModal.classList.remove("hidden");
    setTimeout(() => els.outlineText.focus(), 50);
  }

  function closeOutlineModal() {
    els.outlineModal.classList.add("hidden");
  }

  // P1-2 大纲自审回路（参考易标 outlineWorkflow）：生成 PPT 前先让模型审一遍大纲
  // ——章节完整性 / 层级清晰度 / 每章要点密度。不合格时按建议补全一轮再投喂生成
  // prompt（只补结构不虚构内容）。审校失败静默回退原大纲，绝不阻塞主流程。
  async function reviewOutlineForDeck(outline) {
    try {
      const sys = [
        "你是 PPT 大纲评审。判断给定大纲是否适合直接生成一份商用 PPT：",
        "1. 章节完整（有主题、有章节、有收尾）；2. 层级清晰（H1 章 + 下挂要点）；3. 每章要点 2-6 条。",
        '只输出 JSON：{"passed":true/false,"suggestions":["问题与改法"],"improvedOutline":"markdown 大纲"}',
        "passed=false 时 improvedOutline 必须给出补全后的完整大纲：保留原大纲全部信息，只做结构化补全（拆层级/补收尾/合并过碎要点），禁止虚构原文没有的实质内容；passed=true 时 improvedOutline 给空字符串。"
      ].join("\n");
      const raw = await global.WpsAiOpenAI.chatCompletion({
        model: els.modelSelect?.value || undefined,
        messages: [{ role: "system", content: sys }, { role: "user", content: outline }],
        temperature: 0.2
      });
      const parsed = parseJsonObjectLoose(raw);
      const improved = String(parsed?.improvedOutline || "").trim();
      // 结构校验兜底：改良稿至少要保住原大纲一半长度，否则视为评审跑偏，弃用
      if (parsed && parsed.passed === false && improved.length >= Math.min(outline.length * 0.5, 200)) {
        try { global.WpsAiLog?.log?.("outline:refined", { suggestions: (parsed.suggestions || []).slice(0, 5) }); } catch (e) {}
        return { outline: improved, refined: true, suggestions: parsed.suggestions || [] };
      }
      return { outline, refined: false, suggestions: [] };
    } catch (e) {
      return { outline, refined: false, suggestions: [] };
    }
  }

  async function generateFromOutline() {
    const rawOutline = els.outlineText.value.trim();
    if (!rawOutline) {
      showMessage("请先输入大纲。", "error");
      return;
    }

    closeOutlineModal();
    activateTab("ai");
    // 自审回路：先审后产
    showMessage("正在审校大纲…", "info");
    const review = await reviewOutlineForDeck(rawOutline);
    const outline = review.outline;
    if (review.refined) {
      showMessage(`大纲已按评审建议补全（${review.suggestions.length} 条建议），开始生成。`, "info", { duration: 5000 });
    }

    const imageGenOn = (currentSettings?.imageProviders || []).some((p) => p && p.enabled);

    const prompt = [
      "【任务】根据下面的大纲，生成一份**正式商用风格**的 PPT。要求高级感版式，使用色板和形状装饰，不是单调的「标题+正文」模板感。",
      "",
      "【大纲】",
      outline,
      "",
      "【关键规则——这些步骤一个都不能漏】",
      "STEP 1. 取参数：调 wpp_get_presentation_info 拿到 slideWidth、slideHeight。",
      "STEP 1b. **必须先调 wpp_get_style_preset 拿到色板**（primaryColor / secondaryColor / accentColor / backgroundColor / surfaceColor），后面所有页都按这套颜色走，绝对不要自己临时编颜色。",
      "",
      "**生成幻灯片的优先策略：用模板，少手工拼**。两套模板可选：",
      "",
      "**方案 A——wpp_apply_template**：纯 PPT 形状拼，文字全可编辑，视觉中等。适合大多数页：",
      "  - 封面 → wpp_apply_template(templateName='cover-split' 或 'cover-band', title=主标题, subtitle=副标题/日期)",
      "  - 章节分隔 → wpp_apply_template(templateName='section-fullbleed', title=H1 标题, chapter='第 X 章')",
      "  - 内容页 → wpp_apply_template(templateName='content-sidebar', title=H2, body=要点用 \\n 分隔)",
      "  - 数据强调 → wpp_apply_template(templateName='stat-hero', number='98%', label=标签, description=描述)",
      "  - 引言 → wpp_apply_template(templateName='quote-block', quote=引文, author=作者)",
      "  - 对比 → wpp_apply_template(templateName='two-column', leftTitle, leftBody, rightTitle, rightBody)",
      "  - 结尾 → wpp_apply_template(templateName='closing-thanks')",
      "",
      "**方案 B——wpp_apply_visual_template**：背景是渲染好的 SVG 图（含渐变/光斑/巨型水印），文字仍是真文本框可编辑。**视觉权重高的页用这个**：",
      "  - 封面（强烈推荐用 B）→ wpp_apply_visual_template(templateName='v-cover-gradient', title, subtitle?)",
      "  - 章节分隔（强烈推荐用 B）→ wpp_apply_visual_template(templateName='v-section-modern', title, chapter='01')",
      "  - 大数字数据页（强烈推荐用 B）→ wpp_apply_visual_template(templateName='v-stat-bigtype', number, label, description?)",
      "  - 现代风格内容页（可选 B）→ wpp_apply_visual_template(templateName='v-content-modern', title, body)",
      "",
      "**选择策略**：封面 / 章节分隔 / 数据强调三类用方案 B（视觉决定第一印象）；普通内容页用方案 A 即可（避免每页都铺图浪费）。",
      "**模板省略 slide 参数会自动追加一张新幻灯片**，一次调用就完成版式+文字。",
      "STEP 2. 封面页：**优先用方案 B** —— wpp_apply_visual_template(templateName='v-cover-gradient', title=主标题, subtitle=副标题或日期)。视觉上比方案 A 更精致。",
      "STEP 3. 目录页：把大纲所有 H1 加序号拼成多行字符串（如 \"1. 项目背景\\n2. 解决方案\\n...\"），调 wpp_apply_template(templateName='content-sidebar', title='目录', body=该字符串)。",
      "STEP 4. 正文页（按大纲遍历），**全部用模板**：",
      "   - 每个 H1 → **方案 B** wpp_apply_visual_template(templateName='v-section-modern', title=H1 标题, chapter='01' 之类两位数字)",
      "   - 该 H1 下每组二级要点 → 方案 A wpp_apply_template(templateName='content-sidebar', title=H2, body=多行要点)",
      "   - 大纲里出现「数字 + 单位」（如 \"用户增长 98%\"）→ **方案 B** wpp_apply_visual_template(templateName='v-stat-bigtype', number='98%', label='用户增长', description='与去年同期相比')",
      "   - 大纲出现「方案 A vs 方案 B」式对比 → 方案 A wpp_apply_template(templateName='two-column', leftTitle=A, leftBody=A 的描述, rightTitle=B, rightBody=B 的描述)",
      "   - 大纲出现明显引用 → 方案 A wpp_apply_template(templateName='quote-block', quote=引文, author=出处)",
      "   - 大纲出现两组及以上数字对比、占比构成、趋势变化、多维度评分 → 该页用 content-sidebar 后**追加** wpp_render_chart 给右半边加图表（chartType 自选 bar/line/donut/radar/gauge/heatmap），左半边正文相应精简",
      "   - 每页正文 ≤ 6 行，超出拆成多页",
      "STEP 5. 结尾页：wpp_apply_template(templateName='closing-thanks')。",
      "STEP 6. **统一字体（不能漏！）**：调一次 wpp_apply_style_preset，**不传任何参数**→对所有幻灯片统一套用字体字号颜色。",
      "STEP 7. **统一动画（不能漏！）**：调一次 wpp_set_slide_transition({ effect: 'fade', speed: 'medium' })，**不传 slide 参数**→对所有页加 fade 切换。",
      "STEP 8. 自检：调 wpp_list_slides 看一遍每页的 textPreview，**确认没有空白页**。如果发现空白或缺失标题的页，立刻 wpp_replace_shape_text / wpp_add_text_box 补救。",
      "",
      "【其他要求】",
      "- 进度汇报：每完成一个 STEP 就简短说一句「STEP X 完成」",
      "- 工具失败：分析返回的 warning 字段或 error，换实现，不重复同一失败调用",
      "- 最后总结：生成了几页、风格是否统一、动画是否加上、有无空白页残留",
      "",
      "现在按 STEP 1 开始。"
    ].join("\n");

    runChatTurn(prompt);
  }

  // P1-3 批注式校对入口：进度走 toast，结果落 Word 批注（非破坏性，不改正文）。
  let _proofreadRunning = false;
  async function runProofreadFlow() {
    const t = global.WpsAiI18n?.t || ((s) => s);
    if (_proofreadRunning) { showMessage(t("校对还在进行中，请稍候。"), "info"); return; }
    if (!global.WpsAiProofread?.run) { showMessage(t("校对模块未加载。"), "error"); return; }
    _proofreadRunning = true;
    setBusy(true);
    showMessage(t("正在校对全文（结果将以批注形式标注）…"), "info", { autoHide: false });
    // P2-1：登记为统一后台任务（进度/日志/停止信号）
    const task = global.WpsAiTaskStore?.add?.({ type: "proofread", title: t("批注校对") }) || null;
    try {
      const result = await global.WpsAiProofread.run({
        model: els.modelSelect?.value || undefined,
        parseJson: parseJsonObjectLoose,
        shouldStop: task ? () => global.WpsAiTaskStore.isStopRequested(task.id) : undefined,
        onProgress: (done, totalChunks) => {
          if (task) global.WpsAiTaskStore.update(task.id, { progress: Math.round(done / totalChunks * 100), log: `校对分块 ${done}/${totalChunks}` });
          if (totalChunks > 1) showMessage(`${t("正在校对全文（结果将以批注形式标注）…")} ${done}/${totalChunks}`, "info", { autoHide: false });
        }
      });
      if (task) {
        if (result.stopped) global.WpsAiTaskStore.update(task.id, { status: "stopped", log: "用户停止" });
        else global.WpsAiTaskStore.finish(task.id);
        global.WpsAiTaskStore.clearStop(task.id);
      }
      if (result.total === 0) {
        showMessage(t("校对完成：未发现明显问题。"), "success", { duration: 6000 });
      } else {
        showMessage(
          `${t("校对完成")}：${result.located}/${result.total} ${t("处问题已加批注")}${result.failed ? `（${result.failed} ${t("块解析失败已跳过")}）` : ""}`,
          "success", { duration: 8000 }
        );
      }
      try { global.WpsAiLog?.log?.("proofread:done", result); } catch (e) {}
    } catch (e) {
      if (task) global.WpsAiTaskStore?.finish?.(task.id, { error: e?.message || String(e) });
      showMessage(`${t("校对失败")}：${e?.message || e}`, "error");
    } finally {
      _proofreadRunning = false;
      setBusy(false);
    }
  }

  // P2-2 合规检查：清单输入 modal + 复用批注基建的核查流水线
  let _complianceRunning = false;
  let complianceBound = false;
  function openComplianceModal() {
    const t = global.WpsAiI18n?.t || ((s) => s);
    if (!global.WpsAiCompliance?.run) { showMessage(t("合规检查模块未加载。"), "error"); return; }
    if (!complianceBound) {
      complianceBound = true;
      els.complianceCloseBtn?.addEventListener("click", () => els.complianceModal?.classList.add("hidden"));
      els.complianceCancelBtn?.addEventListener("click", () => els.complianceModal?.classList.add("hidden"));
      els.complianceModal?.addEventListener("click", (ev) => {
        if (ev.target === els.complianceModal) els.complianceModal.classList.add("hidden");
      });
      els.complianceRunBtn?.addEventListener("click", runComplianceFlow);
    }
    els.complianceModal?.classList.remove("hidden");
    setTimeout(() => els.complianceRulesInput?.focus(), 50);
  }

  async function runComplianceFlow() {
    const t = global.WpsAiI18n?.t || ((s) => s);
    const rules = String(els.complianceRulesInput?.value || "").trim();
    if (!rules) { showMessage(t("请先填写检查清单。"), "error"); return; }
    if (_complianceRunning) { showMessage(t("合规检查还在进行中，请稍候。"), "info"); return; }
    _complianceRunning = true;
    els.complianceModal?.classList.add("hidden");
    setBusy(true);
    showMessage(t("正在按清单核查全文（结果将以批注形式标注）…"), "info", { autoHide: false });
    const task = global.WpsAiTaskStore?.add?.({ type: "compliance", title: t("合规检查") }) || null;
    try {
      const result = await global.WpsAiCompliance.run({
        rulesText: rules,
        model: els.modelSelect?.value || undefined,
        parseJson: parseJsonObjectLoose,
        shouldStop: task ? () => global.WpsAiTaskStore.isStopRequested(task.id) : undefined,
        onProgress: (done, totalChunks) => {
          if (task) global.WpsAiTaskStore.update(task.id, { progress: Math.round(done / totalChunks * 100), log: `核查分块 ${done}/${totalChunks}` });
          if (totalChunks > 1) showMessage(`${t("正在按清单核查全文（结果将以批注形式标注）…")} ${done}/${totalChunks}`, "info", { autoHide: false });
        }
      });
      if (task) {
        if (result.stopped) global.WpsAiTaskStore.update(task.id, { status: "stopped", log: "用户停止" });
        else global.WpsAiTaskStore.finish(task.id);
        global.WpsAiTaskStore.clearStop(task.id);
      }
      if (result.total === 0) {
        showMessage(t("合规检查完成：未发现清单相关问题。"), "success", { duration: 8000 });
      } else {
        const sev = result.bySeverity || {};
        showMessage(
          `${t("合规检查完成")}：${result.located}/${result.total} ${t("处问题已加批注")}（${t("高")} ${sev.high || 0} / ${t("中")} ${sev.medium || 0} / ${t("低")} ${sev.low || 0}）`,
          "success", { duration: 10000 }
        );
      }
      try { global.WpsAiLog?.log?.("compliance:done", result); } catch (e) {}
    } catch (e) {
      if (task) global.WpsAiTaskStore?.finish?.(task.id, { error: e?.message || String(e) });
      showMessage(`${t("合规检查失败")}：${e?.message || e}`, "error");
    } finally {
      _complianceRunning = false;
      setBusy(false);
    }
  }

  // ===== 长文改写（Phase A 集成）=====
  // 分节改写 → 复用排版预览弹窗渲染 → 双模式（预览确认写入 / 直接写入）落笔。
  // 安全阀：run() 只生成 out.results，任何写回都必须由弹窗按钮触发 applyLongRewrite。
  let _longRewriteRunning = false;
  let longRewritePreviewOut = null;
  let longRewriteApplying = false;
  // 结构重排：预览态数据（sections + plan）与落笔并发锁，与改写路径分开管理。
  // longRewritePreviewMode 决定复用的预览弹窗双模式按钮点谁——"structure" 走结构重排，
  // 其它走逐节改写。
  let structurePreviewData = null;
  let structureApplying = false;
  let longRewritePreviewMode = "rewrite";

  async function runLongRewriteFlow(requirement) {
    if (_longRewriteRunning) { showMessage(i18nT("长文改写还在进行中，请稍候。"), "info"); return; }
    if (!global.WpsAiLongRewrite?.run) { showMessage(i18nT("长文改写模块未加载。"), "error"); return; }

    // 结构重排意图分流：命中「调整结构/重新组织/重排/章节顺序/结构调整」→ 先走结构规划
    // （planStructure）拿 plan；plan 非空 → 结构重排预览（书签搬动，破坏性，仅按钮可落笔）；
    // plan 为空 → tryStructureRearrange 返回 false，回退到下面的纯逐节改写路径。
    // 安全阀：本分支只读文档 + 规划 + 建预览，绝不重排——真正搬动只由预览弹窗按钮触发。
    const wantStructure = /(调整结构|重新组织|重排|章节顺序|结构调整)/.test(String(requirement).replace(/\s+/g, ""));
    if (wantStructure
        && global.WpsAiLongRewrite.planStructure
        && global.WpsAiLongRewrite.compileStructureMoves
        && global.WpsAiHostWriter?.reorderSectionsByBookmarks
        && global.WpsAiHostWriter?.readDocumentSections) {
      const handled = await tryStructureRearrange(requirement);
      if (handled) return;
      // handled === false → 未生成结构方案，_longRewriteRunning 已释放，落到纯改写路径。
    }

    _longRewriteRunning = true;
    setBusy(true);
    showMessage(i18nT("正在分节改写全文，请稍候…"), "info", { autoHide: false });
    const task = global.WpsAiTaskStore?.add?.({ type: "long-rewrite", title: "长文改写" }) || null;
    try {
      let title = "";
      try { title = (await global.WpsAiHostWriter?.readDocumentContext?.())?.title || ""; } catch (e) {}
      const out = await global.WpsAiLongRewrite.run({
        model: getSelectedFormatPreviewModel(),   // 复用排版的模型选择
        requirement,
        title,
        parseJson: parseJsonObjectLoose,
        shouldStop: task ? () => global.WpsAiTaskStore.isStopRequested(task.id) : undefined,
        onProgress: (done, total) => {
          if (task) global.WpsAiTaskStore.update(task.id, { progress: total ? Math.round(done / total * 100) : 0, log: `改写 ${done}/${total} 节` });
          if (total > 1) showMessage(`正在分节改写全文… ${done}/${total} 节`, "info", { autoHide: false });
        }
      });
      if (task) {
        if (out.stopped) global.WpsAiTaskStore.update(task.id, { status: "stopped", log: "用户停止" });
        else global.WpsAiTaskStore.finish(task.id);
        global.WpsAiTaskStore.clearStop(task.id);
      }
      const okCount = (out.results || []).filter((r) => r && r.ok).length;
      if (!okCount) {
        showMessage(out.stopped ? "已停止，暂无可写回的章节。" : "本次未生成可写回的改写内容。", out.stopped ? "info" : "error", { duration: 8000 });
        return;
      }
      showMessage(
        `${out.stopped ? "已停止，" : ""}改写完成：成功 ${okCount} 节${out.failed ? `，${out.failed} 节失败保留原文` : ""}。请在预览里确认后写入。`,
        "success", { duration: 8000 }
      );
      openLongRewritePreview(out);
      try { global.WpsAiLog?.log?.("long-rewrite:preview", { sections: (out.sections || []).length, ok: okCount, failed: out.failed, stopped: !!out.stopped }); } catch (e) {}
    } catch (e) {
      if (task) global.WpsAiTaskStore?.finish?.(task.id, { error: e?.message || String(e) });
      showMessage(`长文改写失败：${e?.message || e}`, "error");
    } finally {
      _longRewriteRunning = false;
      setBusy(false);
    }
  }

  // 复用排版预览弹窗（formatPreview*）渲染改写结果：切到「长文改写模式」——
  // 隐藏排版专用侧栏 / 页脚按钮，换上「预览确认写入 / 直接写入」两枚双模式按钮。
  let _longRewriteFooterBound = false;
  function ensureLongRewriteFooter() {
    if (_longRewriteFooterBound) return;
    const footer = els.formatPreviewReplaceBtn?.parentElement;
    if (!footer) return;
    _longRewriteFooterBound = true;
    const directBtn = document.createElement("button");
    directBtn.id = "longRewriteDirectBtn";
    directBtn.type = "button";
    directBtn.className = "ghost-btn compact-btn hidden";
    directBtn.textContent = i18nT("直接写入");
    const confirmBtn = document.createElement("button");
    confirmBtn.id = "longRewriteConfirmBtn";
    confirmBtn.type = "button";
    confirmBtn.className = "primary-btn compact-btn hidden";
    confirmBtn.textContent = i18nT("预览确认写入");
    footer.appendChild(directBtn);
    footer.appendChild(confirmBtn);
    // 两枚都调同一个 apply：确认=用户看完点确认；直接写入=跳过逐节浏览直接落笔。
    // 按当前预览模式分流：结构重排 → applyStructureRearrange（书签搬动，破坏性）；否则 → 逐节改写。
    const dispatchApply = () => {
      if (longRewritePreviewMode === "structure") {
        if (structurePreviewData) applyStructureRearrange(structurePreviewData);
      } else if (longRewritePreviewOut) {
        applyLongRewrite(longRewritePreviewOut);
      }
    };
    directBtn.addEventListener("click", dispatchApply);
    confirmBtn.addEventListener("click", dispatchApply);
  }

  // 切换排版弹窗的「长文改写模式」：on=进入（藏排版控件、显双模式按钮），off=还原（供排版复用）。
  function setLongRewriteMode(on) {
    ensureLongRewriteFooter();
    const side = els.formatPreviewModal?.querySelector(".format-preview-side");
    if (side) side.style.display = on ? "none" : "";
    els.formatPreviewRegenerateBtn?.classList.toggle("hidden", on);
    els.formatPreviewExportBtn?.classList.toggle("hidden", on);
    els.formatPreviewReplaceBtn?.classList.toggle("hidden", on);
    document.getElementById("longRewriteDirectBtn")?.classList.toggle("hidden", !on);
    document.getElementById("longRewriteConfirmBtn")?.classList.toggle("hidden", !on);
    const titleEl = document.getElementById("formatPreviewTitle");
    if (titleEl) titleEl.textContent = on ? i18nT("长文改写预览") : i18nT("AI 排版预览");
    if (!on) { longRewritePreviewOut = null; structurePreviewData = null; longRewritePreviewMode = "rewrite"; }
  }

  function openLongRewritePreview(out) {
    longRewritePreviewOut = out;
    longRewritePreviewMode = "rewrite";
    bindFormatPreviewModal();          // 复用排版弹窗的关闭 / 取消 / Esc 绑定
    if (els.formatPreviewImpact) { els.formatPreviewImpact.innerHTML = ""; els.formatPreviewImpact.classList.add("hidden"); }
    if (els.formatPreviewLoading) els.formatPreviewLoading.classList.add("hidden");
    setLongRewriteMode(true);
    renderLongRewritePreview(out);
    const okCount = (out.results || []).filter((r) => r && r.ok).length;
    if (els.formatPreviewMeta) {
      els.formatPreviewMeta.textContent = `共 ${(out.results || []).length} 节，成功 ${okCount} 节${out.failed ? `，失败 ${out.failed} 节（保留原文）` : ""}${out.stopped ? " · 已停止" : ""}。确认后自底向上写回。`;
    }
    els.formatPreviewModal?.classList.remove("hidden");
  }

  // 把 out.results 逐节渲染进 formatPreviewContent：每节一个小标题（失败节标注），
  // 正文块复用排版的 appendBlockEl（所见即写回效果）。
  function renderLongRewritePreview(out) {
    const container = els.formatPreviewContent;
    if (!container) return;
    container.classList.remove("is-streaming");
    container.innerHTML = "";
    const results = Array.isArray(out?.results) ? out.results : [];
    if (!results.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = i18nT("没有识别到可改写的章节。");
      container.appendChild(empty);
      return;
    }
    results.forEach((r, i) => {
      const head = document.createElement("div");
      const label = r.heading ? String(r.heading) : `第 ${(Number.isInteger(r.index) ? r.index : i) + 1} 节`;
      head.textContent = r.ok ? label : `${label} — 改写失败，保留原文${r.error ? "：" + r.error : ""}`;
      head.style.cssText = "font-weight:600;margin:16px 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(0,0,0,.08);"
        + (r.ok ? "" : "color:#c0392b;");
      container.appendChild(head);
      if (r.ok && Array.isArray(r.blocks) && r.blocks.length) {
        let activeList = null;
        let activeListTag = "";
        const ctx = {
          getActiveList: () => activeList,
          getActiveListTag: () => activeListTag,
          setActiveList: (v, tag) => { activeList = v; activeListTag = tag || ""; },
          closeActiveList: () => { activeList = null; activeListTag = ""; }
        };
        r.blocks.forEach((b) => { try { appendBlockEl(b, ctx); } catch (e) {} });
      }
    });
  }

  // 双模式落笔的统一入口：写前快照 → 自底向上按节写回 → 结果提示 → 收尾关 undo group。
  async function applyLongRewrite(out) {
    if (longRewriteApplying) return;
    const ordered = global.WpsAiLongRewrite.orderResultsForWriteback(out?.results || []);
    if (!ordered.length) { showMessage(i18nT("没有可写回的章节。"), "error"); return; }
    longRewriteApplying = true;
    const confirmBtn = document.getElementById("longRewriteConfirmBtn");
    const directBtn = document.getElementById("longRewriteDirectBtn");
    if (confirmBtn) confirmBtn.disabled = true;
    if (directBtn) directBtn.disabled = true;
    showMessage(i18nT("正在写回文档，请勿操作…"), "info", { autoHide: false });
    let captured = false;
    try {
      try { const snap = await global.WpsAiBackup?.captureCurrentDoc?.(); captured = !!(snap && snap.ok); } catch (e) {}
      const res = await global.WpsAiHostWriter.replaceSectionsInPlace(ordered);
      showMessage(
        `已改写 ${res.replaced} 节${res.failed ? `，${res.failed} 节写回失败保留原文` : ""}。${captured ? "已生成备份，可撤销。" : ""}`,
        res.failed ? "info" : "success", { duration: 8000 }
      );
      try { global.WpsAiLog?.log?.("long-rewrite:apply", { replaced: res.replaced, failed: res.failed, backup: captured }); } catch (e) {}
      closeFormatPreviewModal();
    } catch (e) {
      showMessage(`写回失败：${e?.message || e}`, "error");
    } finally {
      try { global.WpsAiBackup?.endUndoGroup?.(); } catch (e) {}
      longRewriteApplying = false;
      if (confirmBtn) confirmBtn.disabled = false;
      if (directBtn) directBtn.disabled = false;
    }
  }

  // ===== 结构重排（Phase B，书签搬动）=====
  // 只规划 + 预览，绝不落笔。破坏性搬动（reorderSectionsByBookmarks）只从预览弹窗按钮触发
  // 的 applyStructureRearrange 里发生（安全阀，同 applyLongRewrite）。
  //
  // 结构重排不改正文，因此不走昂贵的逐节 run()：这里只 readDocumentSections + splitSections
  // 拿到章节，再 planStructure 出结构方案。返回 true 表示已处理（建了预览或终止），false 表示
  // 未生成方案、需回退到纯逐节改写路径。复用 _longRewriteRunning 作并发锁（同改写路径），
  // 规划阶段占锁，预览打开后即释放（落笔按钮自带 structureApplying 锁）。
  async function tryStructureRearrange(requirement) {
    _longRewriteRunning = true;
    setBusy(true);
    showMessage(i18nT("正在规划章节结构调整…"), "info", { autoHide: false });
    const task = global.WpsAiTaskStore?.add?.({ type: "structure-rearrange", title: "结构重排" }) || null;
    try {
      let segments = [];
      try { ({ segments } = await global.WpsAiHostWriter.readDocumentSections()); } catch (e) { segments = []; }
      const sections = global.WpsAiLongRewrite.splitSections(segments);
      if (!sections.length) {
        if (task) global.WpsAiTaskStore.finish(task.id);
        showMessage(i18nT("未识别到可调整结构的章节。"), "error");
        return true;   // 无章节：别再回退去跑逐节改写
      }
      const outline = global.WpsAiLongRewrite.buildOutline(sections);
      const plan = await global.WpsAiLongRewrite.planStructure({
        model: getSelectedFormatPreviewModel(),
        outline,
        requirement,
        parseJson: parseJsonObjectLoose
      });
      if (task) { global.WpsAiTaskStore.finish(task.id); global.WpsAiTaskStore.clearStop(task.id); }
      if (plan && plan.length) {
        openStructurePreview(sections, plan);
        try { global.WpsAiLog?.log?.("structure-rearrange:preview", { sections: sections.length, plan: plan.length }); } catch (e) {}
        return true;
      }
      // plan 为空 → 回退到逐节改写路径（不阻塞）。
      showMessage(i18nT("未生成结构调整方案，改走逐节改写…"), "info", { duration: 6000 });
      return false;
    } catch (e) {
      if (task) global.WpsAiTaskStore?.finish?.(task.id, { error: e?.message || String(e) });
      showMessage(`结构规划失败：${e?.message || e}`, "error");
      return true;   // 规划出错就停，别再回退跑一遍昂贵改写
    } finally {
      setBusy(false);
      _longRewriteRunning = false;   // 释放并发锁：预览已建 or 即将回退，二者都不该继续占锁
    }
  }

  // 复用长文改写预览弹窗渲染「调整后的章节顺序」。longRewritePreviewMode="structure" 让
  // 弹窗底部两枚双模式按钮点向 applyStructureRearrange。
  function openStructurePreview(sections, plan) {
    structurePreviewData = { sections, plan };
    longRewritePreviewMode = "structure";
    bindFormatPreviewModal();
    if (els.formatPreviewImpact) { els.formatPreviewImpact.innerHTML = ""; els.formatPreviewImpact.classList.add("hidden"); }
    if (els.formatPreviewLoading) els.formatPreviewLoading.classList.add("hidden");
    setLongRewriteMode(true);
    const titleEl = document.getElementById("formatPreviewTitle");
    if (titleEl) titleEl.textContent = i18nT("结构重排预览");
    const moves = global.WpsAiLongRewrite.compileStructureMoves(plan, sections);
    renderStructurePreview(sections, plan, moves);
    if (els.formatPreviewMeta) {
      const dropped = (Array.isArray(plan) ? plan.length : 0) - moves.length;
      els.formatPreviewMeta.textContent =
        `将按新顺序重排 ${moves.length} 节${dropped > 0 ? `（${dropped} 个合并/拆分操作暂不支持，已忽略）` : ""}。`
        + "该操作会删除并重新插入章节区间（破坏性），确认后写入，可撤销（Ctrl+Z）。";
    }
    els.formatPreviewModal?.classList.remove("hidden");
  }

  // 渲染重排预览：先列原顺序，再列目标顺序（标注每节来自原第几节 + 是否移动位置），
  // 让用户看清楚「什么会搬到哪」。moves 来自 compileStructureMoves（已过滤 merge/split）。
  function renderStructurePreview(sections, plan, moves) {
    const container = els.formatPreviewContent;
    if (!container) return;
    container.classList.remove("is-streaming");
    container.innerHTML = "";
    const secList = Array.isArray(sections) ? sections : [];
    const mv = Array.isArray(moves) ? moves.slice().sort((a, b) => (a.targetOrder || 0) - (b.targetOrder || 0)) : [];
    if (!mv.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = i18nT("没有可执行的结构调整。");
      container.appendChild(empty);
      return;
    }
    const labelOf = (sec, idx) => (sec && sec.heading ? String(sec.heading) : `第 ${idx + 1} 节`);
    const mkHead = (text) => {
      const h = document.createElement("div");
      h.textContent = text;
      h.style.cssText = "font-weight:600;margin:16px 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(0,0,0,.08);";
      return h;
    };
    // 原顺序
    container.appendChild(mkHead(i18nT("原章节顺序")));
    const origOl = document.createElement("ol");
    origOl.style.cssText = "margin:0 0 8px;padding-left:22px;color:#555;";
    secList.forEach((sec, idx) => {
      const li = document.createElement("li");
      li.textContent = labelOf(sec, idx);
      origOl.appendChild(li);
    });
    container.appendChild(origOl);
    // 目标顺序（按 targetOrder）——标注来源原节号，位置变化的高亮
    container.appendChild(mkHead(i18nT("调整后顺序（预览，尚未写入）")));
    const newOl = document.createElement("ol");
    newOl.style.cssText = "margin:0;padding-left:22px;";
    mv.forEach((m, newIdx) => {
      // 从 moves 反推原节号：compileStructureMoves 用 name = `lrw_sec_<from>`
      const fromIdx = (() => {
        const mm = /lrw_sec_(\d+)/.exec(String(m.name || ""));
        return mm ? Number(mm[1]) : -1;
      })();
      const sec = fromIdx >= 0 ? secList[fromIdx] : null;
      const li = document.createElement("li");
      const moved = fromIdx !== newIdx;
      li.textContent = `${m.heading || (sec ? labelOf(sec, fromIdx) : `第 ${newIdx + 1} 节`)}`
        + (fromIdx >= 0 ? `（原第 ${fromIdx + 1} 节${moved ? " · 已移动" : ""}）` : "");
      if (moved) li.style.cssText = "color:#1a5fb4;font-weight:600;";
      newOl.appendChild(li);
    });
    container.appendChild(newOl);
    // 被忽略的 merge/split 提示
    const dropped = (Array.isArray(plan) ? plan.length : 0) - mv.length;
    if (dropped > 0) {
      const note = document.createElement("p");
      note.className = "muted";
      note.style.cssText = "margin-top:12px;color:#8a6d00;";
      note.textContent = i18nT("注意：合并/拆分类调整暂不支持整块搬动，本次已忽略，只执行章节移动。");
      container.appendChild(note);
    }
  }

  // 结构重排落笔（双模式统一入口）：写前 captureCurrentDoc() 备份 → 书签搬动 →
  // 按 {reordered, failed, warnings} 如实提示 → 收尾 endUndoGroup。破坏性操作，绝不在
  // failed>0 / 有 warning 时报空成功。
  async function applyStructureRearrange(data) {
    if (structureApplying) return;
    const sections = Array.isArray(data?.sections) ? data.sections : [];
    const plan = Array.isArray(data?.plan) ? data.plan : [];
    const moves = global.WpsAiLongRewrite.compileStructureMoves(plan, sections);
    if (!moves.length) { showMessage(i18nT("没有可执行的结构调整。"), "error"); return; }
    structureApplying = true;
    const confirmBtn = document.getElementById("longRewriteConfirmBtn");
    const directBtn = document.getElementById("longRewriteDirectBtn");
    if (confirmBtn) confirmBtn.disabled = true;
    if (directBtn) directBtn.disabled = true;
    showMessage(i18nT("正在按新顺序重排章节，请勿操作…"), "info", { autoHide: false });
    let captured = false;
    try {
      // 破坏性：先备份再搬动，结果不理想可整组撤销（Ctrl+Z）回到备份。备份失败就直接中止——
      // 绝不能在没有撤销保障的情况下跑这种整节删除+重插的破坏性操作。
      try { const snap = await global.WpsAiBackup?.captureCurrentDoc?.(); captured = !!(snap && snap.ok); } catch (e) {}
      if (!captured) {
        showMessage(i18nT("备份失败，已取消结构重排以免无法撤销"), "error");
        return;
      }
      const res = await global.WpsAiHostWriter.reorderSectionsByBookmarks(moves);
      const reordered = Number(res?.reordered) || 0;
      const failed = Number(res?.failed) || 0;
      const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
      if (failed > 0 || warnings.length) {
        // 如实告警：部分失败 / 非连续覆盖中止 / 书签缺失降级等——不关弹窗，指向撤销。
        const warnText = warnings.slice(0, 3).join("；");
        showMessage(
          `结构重排未完全成功：成功 ${reordered} 节${failed ? `，失败 ${failed} 节` : ""}。`
          + (warnings.length ? `注意：${warnText}${warnings.length > 3 ? "…" : ""} ` : "")
          + (captured ? "如结果不理想，请撤销（Ctrl+Z）回到备份。" : "请检查文档，必要时撤销（Ctrl+Z）。"),
          "info", { duration: 12000 }
        );
      } else if (reordered > 0) {
        showMessage(`已按新顺序重排 ${reordered} 节。${captured ? "已生成备份，可撤销（Ctrl+Z）。" : ""}`, "success", { duration: 8000 });
        closeFormatPreviewModal();
      } else {
        showMessage(`未发生任何重排（成功 0 节）。${captured ? "可撤销（Ctrl+Z）。" : ""}`, "info", { duration: 8000 });
      }
      try { global.WpsAiLog?.log?.("structure-rearrange:apply", { reordered, failed, warnings: warnings.length, backup: captured }); } catch (e) {}
    } catch (e) {
      showMessage(`结构重排失败：${e?.message || e}`, "error");
    } finally {
      try { global.WpsAiBackup?.endUndoGroup?.(); } catch (e) {}
      structureApplying = false;
      if (confirmBtn) confirmBtn.disabled = false;
      if (directBtn) directBtn.disabled = false;
    }
  }

  // ---- 统一 PPT 风格 modal ----

  function openUnifyModal() {
    els.unifyModal.classList.remove("hidden");
    setTimeout(() => els.unifyOutlineText.focus(), 50);
  }

  function closeUnifyModal() {
    els.unifyModal.classList.add("hidden");
  }

  function buildUnifyPrompt(outline, autoImage) {
    const imageGenOn = (currentSettings?.imageProviders || []).some((p) => p && p.enabled);
    const imagesEnabled = autoImage && imageGenOn;
    return [
      "【任务】对**当前已存在的** PPT 进行统一化和高级化处理：套用色板、加装饰、统一字体、按内容判断配图、加切换动画、检查空白页。",
      "",
      "【参考大纲】（用来辅助你理解每页的主题）",
      outline || "（用户未提供，请直接基于幻灯片现有文字判断每页主题）",
      "",
      "【流程：必须按顺序执行】",
      "STEP 1. 调 wpp_get_presentation_info 拿 slideWidth、slideHeight、slideCount。",
      "STEP 1b. **必须调 wpp_get_style_preset 拿色板**（primaryColor / accentColor / backgroundColor / surfaceColor），后面所有装饰都用这套颜色。",
      "STEP 2. 调 wpp_list_slides 拿到每页的 index / title / textPreview / shapeCount / layout / placeholderRole。",
      "STEP 3. 调 wpp_apply_style_preset（不传参数）→ 对所有页统一字体字号颜色。",
      "STEP 3b. **加装饰元素提升高级感**（先看 shapeCount，> 5 的页已装饰过则跳过）：",
      "   - 章节分隔页（layout='sectionHeader' 或 占位符只有标题）：直接 wpp_set_slide_background(slide=N, color=primaryColor)，并把标题文字改成白色大字号",
      "   - 内容页：wpp_add_shape(slide=N, shape='rectangle', left=0, top=0, width=8, height=slideHeight, fillColor=primaryColor) 左侧主色装饰条；标题下方再来一条 wpp_add_shape(rectangle, left=50, top=88, width=60, height=3, fillColor=accentColor)",
      "   - 数据/统计页（textPreview 含百分比或大数字）：可以 wpp_add_shape 加圆形或矩形包裹数字让它更突出",
      "   - 注意：本工具不删除既有形状；只在已有版式上叠加装饰，避免改坏用户原排版",
      "",
      "STEP 3c. **数据可视化图表（重要）**：逐页判断「这页适不适合用图表替代纯文字」。",
      "   - **强烈建议加图表**的情形：textPreview 出现两个或以上数字（销售额对比、季度趋势、市场份额、转化率/完成率等）；列举多组比较数据；对比两个方案的多维度评分；占比构成（30% / 50% / 20%）；时间序列（2021、2022、2023…）。",
      "   - **不要加图表**的情形：纯叙事段落、引言/愿景类、封面 / 目录 / 章节分隔页 / 结尾页、本页已有图表（shape Name 含 chart 或 lingxi-chart）。",
      "   - **图表类型选择**：",
      "     · 几组数据对比（不同公司/产品/时段的同一指标）→ chartType='bar'",
      "     · 时间序列趋势、增长曲线 → chartType='line'",
      "     · 占比构成（部分 vs 整体，加起来=100%）→ chartType='donut'",
      "     · 多维度评分对比（产品/方案的几个维度）→ chartType='radar'",
      "     · 单个完成率 / 达成率 / 健康度 → chartType='gauge'",
      "     · 二维矩阵（行×列 的强度，比如月份×渠道的表现）→ chartType='heatmap'",
      "   - **数据提取**：直接从 textPreview 解析。如果数字不全或含糊，可以**编合理的示意数据**（标注「示意」），别为了硬塞图表瞎编关键业务数字。",
      "   - **调用方式**：先 wpp_render_chart(slide=N, chartType=类型, data=结构化数据, title=简短中文标题)，**靠右半边**（默认就是右侧，不用传 left/top）。然后**适当缩短原文字内容**（如果原本是大段数字罗列，让左半边只留要点），用 wpp_replace_shape_text 改正文。",
      "   - **节制原则**：整个 PPT 加图表的页数 ≤ slideCount * 0.4，避免堆图反而花哨。优先选数据最强、最有「展示价值」的几页。",
      "   - **darkMode**：图表会自动跟随当前色板，不用关心。",
      "",
      imagesEnabled ? [
        "STEP 4. **逐页判断是否需要配图**：",
        "   - **需要配图**的情形（典型）：内容偏抽象（说概念/价值/愿景）、整页全是文字大段落、列举的产品/方案、流程描述。",
        "   - **不需要配图**的情形：封面（已有背景）、目录页、章节分隔页（sectionHeader / titleOnly / title）、Q&A/结尾页、文字已经少且页面有图。",
        "   - 判断方式：结合大纲对应行 + textPreview + layout 综合看。",
        "   - 对每个**需要配图**的页面：",
        "     a. 用一句话英文 prompt 描述与该页主题相关的商业风格图片（抽象/几何/渐变/科技感，避免人脸/Logo/文字）",
        "     b. 调 generate_image(prompt=英文prompt, size='4:3' 或 '16:9' 与页面比例匹配, resolution='2K')",
        "     c. 调 wpp_add_picture(slide=该页号, fileName=URL, left=Math.floor(slideWidth*0.55), top=Math.floor(slideHeight*0.18), width=Math.floor(slideWidth*0.4), height=Math.floor(slideHeight*0.6)) — 把图放在右半边，留出左半边给文字",
        "     d. 每页插图前先报一句「为第 X 页生成配图」",
        "   - 注意：**最多给 60% 的内容页配图**，过度堆图反而花哨。"
      ].join("\n") : "STEP 4. 跳过配图（用户未勾选自动配图，或图像生成未启用）。",
      "",
      "STEP 5. 调 wpp_set_slide_transition({ effect: 'fade', speed: 'medium' })（不传 slide → 全部页加 fade 切换）。",
      "STEP 6. 自检：再调一次 wpp_list_slides，看是否有空白页或缺标题的页。如有，用 wpp_add_text_box / wpp_replace_shape_text 补一下。",
      "",
      "【其他要求】",
      "- 进度汇报：每完成一个 STEP 短报一次，配图过程报每页处理进度",
      "- 不要新建幻灯片（除非自检发现某页确实需要补救）",
      "- 完成后总结：处理了几页 / 加了几张图 / 哪几页改动 / 是否成功统一",
      "",
      "现在按 STEP 1 开始。"
    ].join("\n");
  }

  function executeUnify() {
    const outline = els.unifyOutlineText.value.trim();
    const autoImage = !!els.unifyAutoImage.checked;
    const prompt = buildUnifyPrompt(outline, autoImage);
    closeUnifyModal();
    activateTab("ai");
    runChatTurn(prompt);
  }

  async function extractOutlineToTextarea(targetEl) {
    try {
      const app = await global.WpsAiAddon?.getApplication?.();
      const pres = app?.ActivePresentation;
      if (!pres) throw new Error("未检测到打开的演示文稿。");
      const count = pres.Slides?.Count || 0;
      if (count === 0) throw new Error("当前演示文稿没有幻灯片。");
      const lines = [];
      for (let i = 1; i <= count; i += 1) {
        const slide = pres.Slides.Item(i);
        let title = "";
        const shapes = slide.Shapes;
        const cnt = shapes?.Count || 0;
        for (let j = 1; j <= cnt; j += 1) {
          const sh = shapes.Item(j);
          try {
            if (sh.PlaceholderFormat) {
              const t = sh.PlaceholderFormat.Type;
              if (t === 13 || t === 15 || t === 16) {
                title = String(sh.TextFrame?.TextRange?.Text || "").trim();
                if (title) break;
              }
            }
          } catch (e) {}
        }
        lines.push(`# ${title || "幻灯片 " + i}`);
      }
      targetEl.value = lines.join("\n");
      showMessage(`已从当前 PPT 提取 ${count} 个标题。`, "success");
    } catch (error) {
      showMessage(`提取失败：${error.message || error}`, "error");
    }
  }

  const extractOutlineFromActivePpt = () => extractOutlineToTextarea(els.outlineText);
  const extractOutlineForUnify = () => extractOutlineToTextarea(els.unifyOutlineText);

  // ---------------- 改动记录 (History Tab) ----------------

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeSnapshotHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderSnapshotHtml(snap) {
    if (!snap) return `<pre class="muted">无快照</pre>`;
    if (snap._truncated) return `<pre>${escapeSnapshotHtml(snap._excerpt || "")}\n\n[已截断，原始 ${snap._originalBytes} 字节]</pre>`;
    try {
      return `<pre>${escapeSnapshotHtml(JSON.stringify(snap, null, 2))}</pre>`;
    } catch (e) { return `<pre class="muted">快照不可序列化</pre>`; }
  }

  // 恢复本轮 确认对话框：显示"本轮 AI 做了什么"（entries 简表）+ 会丢失什么，
  // 用户看得清楚再点确认，不再拿肉眼记事对齐"我刚问的那句"。
  function showRestoreTurnPreview(turn, entries) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay restore-preview-overlay";
      const promptText = escapeHtml(turn?.prompt || turn?.userPrompt || "（未记录 prompt）");
      const startedAt = turn?.startedAt ? fmtTime(turn.startedAt) : "—";
      const sorted = (entries || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const listHtml = sorted.length
        ? sorted.map((e) => {
          const statusCls = e.ok ? "ok" : "err";
          const statusTxt = e.ok ? "✓" : "!";
          const target = e.target ? `${escapeHtml(e.target.kind || "")} · ${escapeHtml(e.target.label || "")}` : "—";
          const summary = escapeHtml(e.resultSummary || "");
          const name = escapeHtml(e.friendlyName || e.toolName || "工具");
          return `<li class="restore-preview-entry">
            <span class="restore-preview-status ${statusCls}">${statusTxt}</span>
            <div class="restore-preview-entry-body">
              <div class="restore-preview-entry-row1">
                <span class="restore-preview-entry-name">${name}</span>
                <span class="restore-preview-entry-time">${fmtTime(e.ts)}</span>
              </div>
              <div class="restore-preview-entry-target">${target}</div>
              ${summary ? `<div class="restore-preview-entry-summary">${summary}</div>` : ""}
            </div>
          </li>`;
        }).join("")
        : `<li class="restore-preview-empty">（本轮没有记录到写入型工具调用）</li>`;

      overlay.innerHTML = `
        <div class="modal-card restore-preview-card" role="dialog" aria-modal="true" aria-labelledby="restorePreviewTitle">
          <div class="modal-header">
            <div>
              <h3 id="restorePreviewTitle">恢复本轮？</h3>
              <p class="modal-subtitle">开始于 ${startedAt} · 共 ${sorted.length} 步 AI 改动</p>
            </div>
            <button class="modal-close" type="button" data-role="cancel" title="取消">×</button>
          </div>
          <div class="modal-body restore-preview-body">
            <div class="restore-preview-section">
              <div class="restore-preview-label">本轮 prompt</div>
              <div class="restore-preview-prompt">${promptText}</div>
            </div>
            <div class="restore-preview-section">
              <div class="restore-preview-label">将回滚的 AI 改动</div>
              <ol class="restore-preview-list">${listHtml}</ol>
            </div>
            <div class="restore-preview-warn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 21h20L12 2z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17.5" r="0.5" fill="currentColor"/></svg>
              <span>还会同时回滚本轮之后所有已备份的 AI 轮次，以及未保存的手改。请先备份重要内容。</span>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="ghost-btn compact-btn" data-role="cancel">取消</button>
            <button type="button" class="primary-btn compact-btn restore-preview-confirm" data-role="confirm">确认恢复</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const finish = (v) => {
        overlay.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(v);
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") finish(false);
        else if (ev.key === "Enter" && ev.target?.tagName !== "TEXTAREA") finish(true);
      };
      overlay.addEventListener("click", (ev) => {
        const role = ev.target?.closest?.("[data-role]")?.dataset?.role;
        if (role === "cancel") finish(false);
        else if (role === "confirm") finish(true);
        else if (ev.target === overlay) finish(false);
      });
      overlay.tabIndex = -1;
      overlay.addEventListener("keydown", onKey);
      setTimeout(() => overlay.querySelector(".restore-preview-confirm")?.focus(), 0);
    });
  }

  function renderHistoryEntry(entry) {
    const div = document.createElement("div");
    div.className = "history-entry" + (entry.ok ? "" : " is-error");
    div.dataset.entryId = entry.id;
    const statusCls = entry.ok ? "ok" : "err";
    const statusTxt = entry.ok ? "✓" : "!";
    const targetLine = entry.target ? `${entry.target.kind} · ${entry.target.label}` : "—";

    div.innerHTML = `
      <div class="history-entry-head">
        <span class="history-status ${statusCls}" title="${entry.ok ? "成功" : "失败"}">${statusTxt}</span>
        <span class="history-entry-name">${escapeHtml(entry.friendlyName || entry.toolName)}</span>
        <span class="history-entry-time">${fmtTime(entry.ts)}</span>
      </div>
      <div class="history-entry-target">📍 ${escapeHtml(targetLine)}</div>
      <div class="history-entry-summary">${escapeHtml(entry.resultSummary || "")}</div>
    `;

    div.addEventListener("click", () => openHistoryDetailModal(entry));

    return div;
  }

  function openHistoryDetailModal(entry) {
    if (!els.historyDetailModal || !els.historyDetailBody) return;
    const hasSnapshots = entry.before || entry.after;
    if (els.historyDetailTitle) {
      const status = entry.ok ? "✓" : "!";
      els.historyDetailTitle.textContent = `${status} ${entry.friendlyName || entry.toolName}`;
    }
    els.historyDetailBody.innerHTML = `
      <div class="detail-section">
        <div class="detail-meta">
          <span class="detail-meta-row"><span class="detail-label">时间</span><span>${fmtTime(entry.ts)}</span></span>
          <span class="detail-meta-row"><span class="detail-label">目标</span><span>${escapeHtml(entry.target ? entry.target.kind + " · " + entry.target.label : "—")}</span></span>
          <span class="detail-meta-row"><span class="detail-label">结果</span><span>${escapeHtml(entry.resultSummary || "")}</span></span>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-label">工具 / 入参</div>
        <pre class="detail-pre">${escapeHtml(entry.toolName)}\n${escapeHtml(JSON.stringify(entry.params || {}, null, 2))}</pre>
      </div>
      ${hasSnapshots ? `
        <div class="detail-section">
          <div class="detail-label">改动前 / 改动后</div>
          <div class="history-diff">
            <div class="history-diff-col">
              <span class="detail-label before">改动前</span>
              ${renderSnapshotHtml(entry.before)}
            </div>
            <div class="history-diff-col">
              <span class="detail-label after">改动后</span>
              ${renderSnapshotHtml(entry.after)}
            </div>
          </div>
        </div>
      ` : ""}
      ${entry.error ? `
        <div class="detail-section">
          <div class="detail-label">错误</div>
          <pre class="detail-pre error">${escapeHtml(entry.error)}</pre>
        </div>
      ` : ""}
    `;
    els.historyDetailModal.classList.remove("hidden");
    // scroll body 顶
    els.historyDetailBody.scrollTop = 0;
  }

  function closeHistoryDetailModal() {
    if (!els.historyDetailModal) return;
    els.historyDetailModal.classList.add("hidden");
  }

  // 从 turn 自带 prompt 和实际执行的 entries 派生一个紧凑标题。
  // - chat 流的 prompt 通常是用户原句（可能很长）；ribbon 流是 turnLabel（已经短）
  // - entries 里能拿到 FRIENDLY_NAMES 映射的工具名，比 prompt 更能反映"AI 做了什么"
  // 策略：短 prompt 直接用；长 prompt 或空 prompt 时改用工具友好名拼出来
  function deriveTurnTitle(turn, entries) {
    const history = global.WpsAiHistory;
    const friendly = (toolName) =>
      history?.getFriendlyName?.(toolName) || toolName || "未知操作";
    const promptRaw = (turn?.prompt || "").trim();

    // 1) prompt 短且看着像人工写的标题（≤ 30 字）→ 直接用
    if (promptRaw && promptRaw.length <= 30) return promptRaw;

    // 2) 有 entries → 用工具友好名归并
    if (entries && entries.length > 0) {
      const names = entries.map((e) => friendly(e.toolName));
      const unique = [];
      const seen = new Set();
      names.forEach((n) => { if (!seen.has(n)) { seen.add(n); unique.push(n); } });
      if (unique.length === 1) {
        return entries.length === 1 ? unique[0] : `${unique[0]} ×${entries.length}`;
      }
      if (unique.length <= 3) return unique.join(" · ");
      return `${unique.slice(0, 2).join(" · ")} 等 ${unique.length} 项`;
    }

    // 3) 兜底：把长 prompt 截断
    if (promptRaw) return promptRaw.slice(0, 36) + "…";
    return "（无提示）";
  }

  function renderTurnGroup(turn, entries) {
    const wrapper = document.createElement("div");
    wrapper.className = "history-turn";

    const head = document.createElement("div");
    head.className = "history-turn-head";
    const title = deriveTurnTitle(turn, entries);
    const promptText = escapeHtml(title);
    // 原始 prompt 不同于派生 title 时挂 tooltip，方便用户回看上下文
    const promptTooltip = (turn?.prompt && turn.prompt.trim() !== title)
      ? escapeHtml(turn.prompt) : "";
    const startedAt = turn?.startedAt ? fmtTime(turn.startedAt) : "";
    const restored = !!turn?.restoredAt;
    // 已恢复过的 turn 不再展示"恢复"按钮：再点一次没意义（备份文件已被回滚消费），还会让用户误以为能反复来
    const backupOk = turn?.backup && turn.backup.backupPath && !restored;
    const backupErr = turn?.backup && turn.backup.error;
    const restoredBadge = restored
      ? `<span class="history-turn-restored" title="已于 ${fmtTime(turn.restoredAt)} 回滚到本轮开始前的状态">已恢复 · ${fmtTime(turn.restoredAt)}</span>`
      : "";
    const iconBox = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
    const iconChat = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    const iconRestore = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
    const backupStatus = backupOk
      ? `<span class="history-turn-backup ok" title="${escapeHtml(turn.backup.backupPath)}">${iconBox} 已备份 (${formatSize(turn.backup.size)})</span>`
      : backupErr
        ? `<span class="history-turn-backup err" title="${escapeHtml(backupErr)}">未备份（出错）</span>`
        : `<span class="history-turn-backup muted">未备份</span>`;
    head.innerHTML = `
      <div class="history-turn-meta">
        <span class="history-turn-icon">${iconChat}</span>
        <span class="history-turn-prompt"${promptTooltip ? ` title="${promptTooltip}"` : ""}>${promptText}</span>
        <span class="history-turn-time">${startedAt}</span>
      </div>
      <div class="history-turn-actions">
        ${restoredBadge}
        ${backupStatus}
        ${backupOk ? `<button type="button" class="ghost-btn history-restore-btn">${iconRestore} 恢复本轮</button>` : ""}
      </div>
    `;
    if (restored) wrapper.classList.add("restored");
    wrapper.appendChild(head);

    if (backupOk) {
      head.querySelector(".history-restore-btn").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        // 同步捕获 button —— await 之后 ev.currentTarget 被浏览器清空
        const btn = ev.currentTarget;
        // 用一个能看到"本轮到底做了什么"的 diff 预览替代原生 confirm()。
        // 用户之前只看到"确认恢复吗"，没法判断本轮改动是不是自己不想要的；
        // 现在把 entries 摊开：工具名 + 目标 + 一句结果摘要 + 时间戳。
        const ok = await showRestoreTurnPreview(turn, entries);
        if (!ok) return;
        btn.disabled = true; btn.textContent = "恢复中...";
        try {
          const backup = global.WpsAiBackup;
          if (!backup) throw new Error("WpsAiBackup 未加载");

          // 算 undoSteps：本 turn 在按时间倒序排的"还能撤"的 turn 列表里排第几（0 = 最新）。
          // 排位 + 1 即需要 Application.Undo 几次才能跨过中间的 AI turn 回到本 turn 之前。
          // 这样老 turn 也能走免关文档的 Undo 路径，不再强制走文件层（关闭+重开）。
          // 已被 markTurnRestored 过的 turn 不计入（它们的改动已经被回滚，undo 栈里没东西要走）。
          let undoSteps = 0;
          try {
            const allTurns = global.WpsAiHistory?.listTurns?.() || {};
            const backedUp = Object.values(allTurns)
              .filter((t) => t.backup?.backupPath && t.backup.undoGroup && !t.restoredAt)
              .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
            const idx = backedUp.findIndex((t) => t.id === turn.id);
            undoSteps = idx >= 0 ? idx + 1 : (turn.backup.undoGroup ? 1 : 0);
          } catch (e) { undoSteps = turn.backup.undoGroup ? 1 : 0; }

          const tryUndo = undoSteps > 0;
          const res = await backup.restoreFromBackup(turn.backup.backupPath, turn.backup.docPath, { tryUndo, undoSteps });
          if (res?.ok) {
            let via = "";
            if (res.method === "undo") {
              via = res.undoneCount > 1 ? `(免关文档，撤销 ${res.undoneCount} 步)` : "(免关文档)";
            } else if (res.method === "file") {
              via = "(已重开文档)";
            }
            showMessage(`已恢复到 ${fmtTime(turn.backup.ts)} 的状态 ${via}。${res.warning || ""}`, "success");
            // 级联标记：本 turn 以及所有比它新的 turn 都标为"已恢复"。
            // 原因：多步 Undo / 文件还原都会把 target 之后的全部 AI 改动一并清掉
            // —— 那些 turn 的 backup 已经"对不上"现在的文档状态了，按钮再让点会乱
            // （只标 target 的话，比如撤回 B 后再点 C，会反过来把 A 的 group 撤了）。
            try {
              const allTurns = global.WpsAiHistory?.listTurns?.() || {};
              const cascade = Object.values(allTurns)
                .filter((t) => t.id && !t.restoredAt && (t.startedAt || 0) >= (turn.startedAt || 0));
              cascade.forEach((t) => global.WpsAiHistory?.markTurnRestored?.(t.id));
              // 兜底：万一上面 filter 没把 target 圈进去（缺 startedAt 之类），再补一次
              if (!cascade.some((t) => t.id === turn.id)) {
                global.WpsAiHistory?.markTurnRestored?.(turn.id);
              }
            } catch (e) {
              global.WpsAiHistory?.markTurnRestored?.(turn.id);
            }
          } else {
            showMessage(`恢复失败：${res?.error || "未知错误"}`, "error");
            btn.disabled = false; btn.innerHTML = `${iconRestore} 恢复本轮`;
          }
        } catch (e) {
          showMessage(`恢复失败：${e?.message || e}`, "error");
          btn.disabled = false; btn.textContent = "↶ 恢复本轮";
        }
      });
    }

    // turn 下的 entry 默认折叠：用户视角下一次"对话"是一次操作，不需要把 AI 内部
    // 的每个工具调用都铺开（5 行历史看起来像 5 次操作，造成 badge 数和"做的事"对不上）。
    // 点击 turn head 才展开看详细工具调用流；保留 entry 详情入口，不删功能。
    const sorted = entries.slice().sort((a, b) => a.ts - b.ts);
    const list = document.createElement("div");
    list.className = "history-turn-entries hidden";
    sorted.forEach((e) => list.appendChild(renderHistoryEntry(e)));
    wrapper.appendChild(list);

    // turn 标题角加个折叠角标（展开 / 收起）+ 子条目数
    const entryCountBadge = document.createElement("span");
    entryCountBadge.className = "history-turn-count";
    entryCountBadge.textContent = `${sorted.length} 步`;
    entryCountBadge.title = `本次对话中 AI 调了 ${sorted.length} 次写入型工具，点击展开`;
    head.querySelector(".history-turn-meta")?.appendChild(entryCountBadge);
    head.addEventListener("click", (ev) => {
      // 避开操作按钮的 hover 区
      if (ev.target?.closest?.(".history-turn-actions")) return;
      list.classList.toggle("hidden");
      wrapper.classList.toggle("expanded");
    });
    head.style.cursor = "pointer";

    return wrapper;
  }

  function formatSize(bytes) {
    if (bytes == null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderHistory() {
    const history = global.WpsAiHistory;
    if (!history || !els.historyList) return;

    // 当前文档身份（docId 优先，跨重命名 / Save As 稳定；docPath 兜底）
    const docKey = global.WpsAiBackup?.getCurrentDocKey?.() || { docId: null, docPath: null };
    const currentDocId = docKey.docId;
    const currentDocPath = docKey.docPath;
    const hasCurrentDoc = !!(currentDocId || currentDocPath);
    const filtered = hasCurrentDoc
      ? history.listEntries({ docId: currentDocId, docPath: currentDocPath })
      : [];
    const allEntries = history.listEntries();
    const turns = history.listTurns?.() || {};

    // 计数从"entry 条数"改为"turn 组数"——用户视角下一次对话是一次操作，
    // AI 内部连调几个工具不该被算成几次"改动"。
    // 之前 badge=3 但用户只觉得做了 2 次对话，就是因为某个 turn 内 AI 调了 2 个工具。
    const totalN = allEntries.length;
    const shownN = filtered.length;
    const countTurns = (list) => {
      const set = new Set();
      list.forEach((e) => set.add(e.turnId || "_loose:" + e.id));
      return set.size;
    };
    const totalTurns = countTurns(allEntries);
    const shownTurns = countTurns(filtered);

    if (els.historyCount) {
      // 只显示当前文档的改动数，不再暴露其他文件的累计数
      els.historyCount.textContent = hasCurrentDoc
        ? `共 ${shownTurns} 轮（${shownN} 步）`
        : `共 ${totalTurns} 轮（${totalN} 步）`;
    }
    if (els.historyBadge) {
      const showCount = hasCurrentDoc ? shownTurns : totalTurns;
      els.historyBadge.textContent = showCount > 99 ? "99+" : String(showCount);
      els.historyBadge.classList.toggle("hidden", showCount === 0);
    }
    // 顶部文件信息条：当前文档有身份（path 或 id）才显示
    if (els.historyDocBar && els.historyDocName) {
      if (hasCurrentDoc) {
        const fname = currentDocPath ? currentDocPath.split(/[/\\]/).pop() : `(文档 ${currentDocId.slice(0, 8)}…)`;
        els.historyDocName.textContent = fname;
        // tooltip 里同时展示 path + 短 id，让高级用户能看出走的是 id 还是 path
        const tip = [];
        if (currentDocPath) tip.push(currentDocPath);
        if (currentDocId) tip.push(`docId: ${currentDocId}`);
        els.historyDocName.title = tip.join("\n");
        els.historyDocBar.classList.remove("hidden");
      } else {
        els.historyDocBar.classList.add("hidden");
      }
    }

    if (els.historyEmpty) {
      els.historyEmpty.classList.toggle("hidden", shownN > 0);
      // 空态文案根据是否有当前文档变
      if (!hasCurrentDoc) {
        els.historyEmpty.innerHTML = `
          <p><strong>当前文档尚未保存到磁盘</strong></p>
          <p class="muted">改动记录按文档身份（UUID，跨重命名 / Save As 稳定）分组保存；未保存时暂时按文件路径分组。请先保存文档（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），AI 的操作就会关联到这个具体文档。</p>
        `;
      } else if (shownN === 0) {
        const fname = currentDocPath ? currentDocPath.split(/[/\\]/).pop() : `文档 ${currentDocId.slice(0, 8)}…`;
        els.historyEmpty.innerHTML = `
          <p>当前文件还没有 AI 改动记录</p>
          <p class="muted">文件: ${escapeHtml(fname)}</p>
        `;
      } else {
        // 默认文案，shownN>0 不显示
        els.historyEmpty.innerHTML = "<p>暂无改动记录。让 AI 帮你做点什么,这里就会显示。</p>";
      }
    }

    els.historyList.innerHTML = "";
    if (!hasCurrentDoc || shownN === 0) return;

    const entries = filtered;

    // 按 turnId 分组：无 turnId 的归为 "_loose"
    const groups = new Map();
    entries.forEach((e) => {
      const key = e.turnId || "_loose";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });

    // 排序：turn 按其 startedAt 倒序；loose 放最后
    const turnIds = Array.from(groups.keys()).sort((a, b) => {
      if (a === "_loose") return 1;
      if (b === "_loose") return -1;
      const ta = turns[a]?.startedAt || 0;
      const tb = turns[b]?.startedAt || 0;
      return tb - ta;
    });

    turnIds.forEach((tid) => {
      const turn = tid === "_loose" ? { id: "_loose", prompt: "未归属对话的改动", backup: null } : turns[tid];
      els.historyList.appendChild(renderTurnGroup(turn || { id: tid, prompt: "" }, groups.get(tid)));
    });
  }

  function bindHistory() {
    const history = global.WpsAiHistory;
    if (!history) return;
    history.subscribe(renderHistory);
    if (els.historyClearBtn) {
      els.historyClearBtn.addEventListener("click", () => {
        if (history.size() === 0) return;
        if (!confirm(i18nT("清空全部 {n} 条改动记录？", { n: history.size() }))) return;
        history.clear();
      });
    }
    // 改动记录详情 modal 关闭逻辑：X 按钮 + 点遮罩 + ESC
    if (els.historyDetailCloseBtn) {
      els.historyDetailCloseBtn.addEventListener("click", closeHistoryDetailModal);
    }
    if (els.historyDetailModal) {
      els.historyDetailModal.addEventListener("click", (ev) => {
        if (ev.target === els.historyDetailModal) closeHistoryDetailModal();
      });
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && els.historyDetailModal && !els.historyDetailModal.classList.contains("hidden")) {
        closeHistoryDetailModal();
      }
    });
    renderHistory();
  }

  // ---------------- 生图素材库 ----------------

  const materialPreviewCache = new Map();
  const MATERIAL_ALL_GROUP_ID = "all";
  const MATERIAL_DEFAULT_GROUP_ID = "default";
  let activeMaterialGroupId = MATERIAL_ALL_GROUP_ID;
  let materialSearchText = "";
  let materialProjectFilterValue = "";
  let selectedMaterialIds = new Set();
  let materialLibraryBound = false;
  let materialDialogPollTimer = null;
  let materialPreviewItemId = null;
  let materialInsertBusy = false;

  const MATERIAL_PREVIEW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>';

  function materialPreviewButtonHtml() {
    return `<button class="material-preview-trigger" data-role="preview" type="button" title="放大预览" aria-label="放大预览">${MATERIAL_PREVIEW_ICON}</button>`;
  }

  function materialDisplayUrl(item) {
    return item?.dataUrl || item?.url || "";
  }

  function materialFileName(item) {
    const raw = item?.url || item?.dataUrl || "";
    if (!raw) return "生成图片";
    const dataUrlMatch = raw.match(/^data:image\/([^;]+);/i);
    if (dataUrlMatch) {
      const ext = dataUrlMatch[1].replace("jpeg", "jpg").replace("svg+xml", "svg");
      return `生成图片.${ext || "png"}`;
    }
    try {
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "生成图片");
      }
    } catch (e) {}
    return String(raw).split(/[/\\]/).pop() || "生成图片";
  }

  function materialGroupId(item) {
    return item?.groupId || MATERIAL_DEFAULT_GROUP_ID;
  }

  function materialCanPreviewDirect(url) {
    return /^data:image\//i.test(url) || /^https?:\/\//i.test(url) || /^file:\/\//i.test(url) || /^\.\//.test(url);
  }

  async function ensureMaterialPreview(item) {
    const raw = materialDisplayUrl(item);
    if (!raw) return "";
    if (item.dataUrl || materialCanPreviewDirect(raw)) return raw;
    if (materialPreviewCache.has(raw)) return materialPreviewCache.get(raw);
    try {
      const resp = await fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/load-local-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: raw })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || `load-local-file ${resp.status}`);
      const dataUrl = `data:${payload.mediaType || "image/png"};base64,${payload.base64}`;
      materialPreviewCache.set(raw, dataUrl);
      return dataUrl;
    } catch (e) {
      return "";
    }
  }

  function openMaterialLibraryModal() {
    if (!global.WpsAiMaterialLibrary) {
      showMessage("素材库模块未加载。", "error");
      return;
    }
    renderMaterialLibrary();
    els.materialLibraryModal?.classList.remove("hidden");
  }

  function closeMaterialLibraryModal() {
    if (isMaterialsDialog) {
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.materialLibraryModal?.classList.add("hidden");
  }

  function openMaterialLibraryAsDialog() {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=materials`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        rememberWriterInsertionRange();
        const { w, h } = pickDialogSize(1040, 760, { minW: 760, minH: 560 });
        app.ShowDialog(url, i18nDialogTitle("素材库"), w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        consumeMaterialDialogRequests();
        startMaterialDialogRequestPolling();
        return;
      }
    } catch (e) {
      console.warn("[materials] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    openMaterialLibraryModal();
  }

  function materialMetaText(item) {
    const parts = [];
    if (item.size) parts.push(item.size);
    if (item.resolution) parts.push(item.resolution);
    if (item.model) parts.push(item.model);
    if (item.ts) parts.push(fmtTime(item.ts));
    return parts.join(" · ") || "生成图片";
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function rememberWriterInsertionRange() {
    try {
      const app = global.WpsAiAddon?.getApplicationSync?.();
      const range = app?.Selection?.Range;
      if (!range) return;
      const start = Number(range.Start);
      const end = Number(range.End);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      global.WpsAiWriterInsertionRangeHint = { start, end, ts: Date.now() };
      try { localStorage.setItem("lingxi_writer_insertion_range_hint_v1", JSON.stringify(global.WpsAiWriterInsertionRangeHint)); } catch (e) {}
    } catch (e) {}
  }

  async function prepareWpsDocumentWrite() {
    const app = global.WpsAiAddon?.getApplicationSync?.() || await global.WpsAiAddon?.getApplication?.();
    try { activateWpsApp(app); } catch (e) {}
    await waitMs(180);
    try { activateWpsApp(app); } catch (e) {}
    await waitMs(120);
  }

  async function materialInsertUrl(item) {
    const raw = materialDisplayUrl(item);
    if (!/^https?:\/\//i.test(raw)) return raw;
    try {
      const local = await global.WpsAiImageAssets?.ensureLocalImagePath?.(raw);
      if (!local || local === raw) return raw;
      if (item?.id) {
        const updated = global.WpsAiMaterialLibrary?.update?.(item.id, {
          url: local,
          sourceUrl: item.sourceUrl || raw
        });
        if (updated && materialPreviewItemId === item.id) {
          void openMaterialPreview(updated);
        }
      }
      return local;
    } catch (e) {
      console.warn("[materials] 远程素材本地缓存失败，回退原始 URL:", e?.message || e);
      showMessage("远程图片本地缓存失败，已尝试用原始地址插入。", "info");
      return raw;
    }
  }

  function materialGroups() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib?.listGroups) {
      return [
        { id: MATERIAL_ALL_GROUP_ID, name: "全部", virtual: true, count: lib?.list?.().length || 0 },
        { id: MATERIAL_DEFAULT_GROUP_ID, name: "未分组", count: 0 }
      ];
    }
    return lib.listGroups();
  }

  function materialGroupNameById(groups) {
    const map = new Map();
    groups.forEach((group) => map.set(group.id, group.name));
    return map;
  }

  function syncSelectedMaterials(allEntries) {
    const valid = new Set((allEntries || []).map((item) => item.id));
    selectedMaterialIds = new Set(Array.from(selectedMaterialIds).filter((id) => valid.has(id)));
  }

  function getSelectedMaterials() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib) return [];
    return Array.from(selectedMaterialIds).map((id) => lib.find(id)).filter(Boolean);
  }

  function getMaterialPreviewItem() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib || !materialPreviewItemId) return null;
    return lib.find?.(materialPreviewItemId) || null;
  }

  function setMaterialInsertBusy(isBusy) {
    materialInsertBusy = !!isBusy;
    const selectedCount = getSelectedMaterials().length;
    if (els.materialInsertBtn) {
      els.materialInsertBtn.disabled = materialInsertBusy || selectedCount !== 1;
    }
    if (els.materialPreviewInsertBtn) {
      const previewItem = getMaterialPreviewItem();
      els.materialPreviewInsertBtn.disabled = materialInsertBusy || !materialDisplayUrl(previewItem);
    }
  }

  // 素材预览裁剪状态
  let _cropMode = false;
  let _cropSel = null;      // { x, y, w, h } —— 相对显示图片左上角的像素
  let _cropDragging = false;
  let _cropStart = { x: 0, y: 0 };
  // 画笔编辑状态
  let _brushMode = false;
  let _brushPainting = false;
  let _brushLast = { x: 0, y: 0 };
  let _imgEditAbort = null; // 抠图/重绘进行中的 AbortController，支持取消

  // 素材预览滚轮缩放 + 拖拽平移 + 双击复位
  let _mpZoom = { scale: 1, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0 };
  function applyMaterialPreviewTransform() {
    const img = els.materialPreviewImage;
    const canvas = els.materialBrushCanvas;
    const transform = "translate(" + _mpZoom.tx + "px," + _mpZoom.ty + "px) scale(" + _mpZoom.scale + ")";
    if (!img) return;
    img.style.transform = transform;
    img.style.cursor = _mpZoom.scale > 1 ? (_mpZoom.dragging ? "grabbing" : "grab") : "default";
    if (canvas) {
      canvas.style.transform = transform;
      canvas.style.transformOrigin = "center center";
    }
  }
  function resetMaterialPreviewZoom() {
    _mpZoom = { scale: 1, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0 };
    applyMaterialPreviewTransform();
  }
  function bindMaterialPreviewZoom() {
    const img = els.materialPreviewImage;
    if (!img || img.dataset.zoomBound === "1") return;
    img.dataset.zoomBound = "1";
    img.title = "滚轮缩放 · 拖拽平移 · 双击复位";
    img.style.transformOrigin = "center center";
    img.style.transition = "transform 0.05s ease-out";
    const container = img.parentElement || img;
    try { container.style.overflow = "hidden"; } catch (e) {}
    container.addEventListener("wheel", (ev) => {
      if (img.classList.contains("hidden") || _cropMode) return;
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      const ns = Math.min(8, Math.max(1, _mpZoom.scale * factor));
      if (ns === 1) { _mpZoom.tx = 0; _mpZoom.ty = 0; }
      _mpZoom.scale = ns;
      applyMaterialPreviewTransform();
    }, { passive: false });
    img.addEventListener("mousedown", (ev) => {
      if (_mpZoom.scale <= 1) return;
      ev.preventDefault();
      _mpZoom.dragging = true;
      _mpZoom.sx = ev.clientX - _mpZoom.tx;
      _mpZoom.sy = ev.clientY - _mpZoom.ty;
      applyMaterialPreviewTransform();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!_mpZoom.dragging) return;
      _mpZoom.tx = ev.clientX - _mpZoom.sx;
      _mpZoom.ty = ev.clientY - _mpZoom.sy;
      applyMaterialPreviewTransform();
    });
    window.addEventListener("mouseup", () => {
      if (!_mpZoom.dragging) return;
      _mpZoom.dragging = false;
      applyMaterialPreviewTransform();
    });
    img.addEventListener("dblclick", resetMaterialPreviewZoom);
  }

  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("图片加载失败"));
      im.src = src;
    });
  }
  // 取素材的同源 dataURL（http 图会被 canvas 视为跨域污染，必须先转 dataURL 才能裁剪导出）
  async function getMaterialFullDataUrl(item) {
    const raw = (item && item.dataUrl && /^data:/.test(item.dataUrl)) ? item.dataUrl : materialDisplayUrl(item);
    if (/^data:/.test(raw)) return raw;
    const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
    if (/^https?:\/\//i.test(raw)) {
      const r = await fetch(base + "/fetch-remote-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: raw }) });
      const j = await r.json().catch(() => ({}));
      if (j && j.dataUrl) return j.dataUrl;
      throw new Error("拉取远程图片失败");
    }
    const r = await fetch(base + "/load-local-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: raw }) });
    const j = await r.json().catch(() => ({}));
    if (j && j.base64) return "data:" + (j.mediaType || "image/png") + ";base64," + j.base64;
    throw new Error("读取本地图片失败");
  }

  function updateCropSelBox() {
    const box = els.materialCropOverlay?.querySelector(".material-crop-sel");
    if (!box) return;
    if (!_cropSel || _cropSel.w < 2 || _cropSel.h < 2) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.style.left = _cropSel.x + "px";
    box.style.top = _cropSel.y + "px";
    box.style.width = _cropSel.w + "px";
    box.style.height = _cropSel.h + "px";
  }
  function enterCropMode() {
    const img = els.materialPreviewImage;
    const overlay = els.materialCropOverlay;
    if (!img || !overlay || img.classList.contains("hidden")) { showMessage("图片未加载完成。", "error"); return; }
    resetMaterialPreviewZoom();
    _cropMode = true;
    _cropSel = null;
    // 让裁剪层严格盖住图片显示区域（图片在 stage 里是居中/留白的）
    const stage = overlay.parentElement;
    const ir = img.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    overlay.style.left = (ir.left - sr.left) + "px";
    overlay.style.top = (ir.top - sr.top) + "px";
    overlay.style.width = ir.width + "px";
    overlay.style.height = ir.height + "px";
    overlay.classList.remove("hidden");
    updateCropSelBox();
    els.materialPreviewCropBtn?.classList.add("hidden");
    els.materialCropSaveBtn?.classList.remove("hidden");
    els.materialCropCancelBtn?.classList.remove("hidden");
  }
  function exitCropMode() {
    _cropMode = false;
    _cropDragging = false;
    _cropSel = null;
    els.materialCropOverlay?.classList.add("hidden");
    els.materialPreviewCropBtn?.classList.remove("hidden");
    els.materialCropSaveBtn?.classList.add("hidden");
    els.materialCropCancelBtn?.classList.add("hidden");
  }
  function bindMaterialCrop() {
    const overlay = els.materialCropOverlay;
    if (!overlay || overlay.dataset.cropBound === "1") return;
    overlay.dataset.cropBound = "1";
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    overlay.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const r = overlay.getBoundingClientRect();
      _cropStart = { x: clamp(ev.clientX - r.left, 0, r.width), y: clamp(ev.clientY - r.top, 0, r.height) };
      _cropDragging = true;
      _cropSel = { x: _cropStart.x, y: _cropStart.y, w: 0, h: 0 };
      updateCropSelBox();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!_cropDragging) return;
      const r = overlay.getBoundingClientRect();
      const cx = clamp(ev.clientX - r.left, 0, r.width);
      const cy = clamp(ev.clientY - r.top, 0, r.height);
      _cropSel = {
        x: Math.min(_cropStart.x, cx),
        y: Math.min(_cropStart.y, cy),
        w: Math.abs(cx - _cropStart.x),
        h: Math.abs(cy - _cropStart.y)
      };
      updateCropSelBox();
    });
    window.addEventListener("mouseup", () => { _cropDragging = false; });
  }
  async function cropAndSaveMaterial() {
    const lib = global.WpsAiMaterialLibrary;
    const item = lib?.find?.(materialPreviewItemId);
    if (!lib || !item) { showMessage("素材已失效。", "error"); return; }
    if (!_cropSel || _cropSel.w < 4 || _cropSel.h < 4) { showMessage("请先在图片上框选一块区域。", "error"); return; }
    const btn = els.materialCropSaveBtn;
    const orig = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "处理中…"; }
    try {
      const dataUrl = await getMaterialFullDataUrl(item);
      const img = await loadImageEl(dataUrl);
      const dispRect = els.materialPreviewImage.getBoundingClientRect();
      const scaleX = img.naturalWidth / (dispRect.width || 1);
      const scaleY = img.naturalHeight / (dispRect.height || 1);
      const sx = clampNum(_cropSel.x * scaleX, 0, img.naturalWidth);
      const sy = clampNum(_cropSel.y * scaleY, 0, img.naturalHeight);
      const sw = clampNum(_cropSel.w * scaleX, 1, img.naturalWidth - sx);
      const sh = clampNum(_cropSel.h * scaleY, 1, img.naturalHeight - sy);
      if (sw < 4 || sh < 4) { showMessage("裁剪区域太小。", "error"); return; }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const outDataUrl = canvas.toDataURL("image/png");
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      let stored = null;
      try { const p = await global.WpsAiImageAssets?.ensureLocalImagePath?.(outDataUrl); if (p) stored = { url: p }; } catch (e) {}
      if (!stored) stored = { dataUrl: outDataUrl };
      const entry = lib.add(Object.assign({
        prompt: "裁剪 · " + (item.prompt || item.title || "素材"),
        source: "crop",
        project: settings.currentProject || item.project || "",
        tags: (Array.isArray(item.tags) ? item.tags.slice() : []).concat("裁剪")
      }, stored));
      if (entry) {
        showMessage("已裁剪并存入素材库。", "success");
        activateMaterialPreviewEntry(entry);
        exitCropMode();
        renderMaterialLibrary();
      } else {
        showMessage("存入素材库失败（存储空间不足）。", "error");
      }
    } catch (e) {
      showMessage("裁剪失败：" + (e?.message || e), "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }
  function clampNum(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // 模型出不了透明底时，会把"透明"画成固定的浅灰/白棋盘（马赛克）背景。
  // 这里检测该棋盘并从四周 flood-fill 抠掉 → 真透明；不是棋盘则原样返回。保留 AI 平滑的主体边缘。
  function removeCheckerboardBackground(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { resolve(dataUrl); return; }
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const id = ctx.getImageData(0, 0, w, h);
          const d = id.data;
          const isLightGray = (r, g, b) => (Math.max(r, g, b) - Math.min(r, g, b) <= 24) && ((r + g + b) / 3 >= 150);
          const bucket = (r, g, b) => (r >> 3) + "," + (g >> 3) + "," + (b >> 3);
          const counts = new Map();
          let borderSamples = 0;
          const sample = (x, y) => {
            const i = (y * w + x) * 4;
            if (d[i + 3] < 10) { borderSamples += 1; return; }
            borderSamples += 1;
            if (!isLightGray(d[i], d[i + 1], d[i + 2])) return;
            const k = bucket(d[i], d[i + 1], d[i + 2]);
            counts.set(k, (counts.get(k) || 0) + 1);
          };
          for (let x = 0; x < w; x += 1) { sample(x, 0); sample(x, 1); sample(x, h - 1); sample(x, h - 2); }
          for (let y = 0; y < h; y += 1) { sample(0, y); sample(1, y); sample(w - 1, y); sample(w - 2, y); }
          const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
          const top = sorted.slice(0, 2);
          const topSum = top.reduce((s, e) => s + e[1], 0);
          // 边框需大部分是这 1~2 个浅灰/白（棋盘特征）；否则判定不是棋盘，原样返回
          if (!top.length || topSum < borderSamples * 0.35) { resolve(dataUrl); return; }
          const centers = top.map(([k]) => k.split(",").map((v) => (parseInt(v, 10) << 3) + 4));
          const tol = 28;
          const isChecker = (r, g, b) => centers.some((c2) => Math.abs(r - c2[0]) <= tol && Math.abs(g - c2[1]) <= tol && Math.abs(b - c2[2]) <= tol);
          const visited = new Uint8Array(w * h);
          const stack = [];
          const seed = (x, y) => {
            const p = y * w + x;
            if (visited[p]) return;
            const i = p * 4;
            if (d[i + 3] < 10) { visited[p] = 1; return; }
            if (isChecker(d[i], d[i + 1], d[i + 2])) { visited[p] = 1; stack.push(p); }
          };
          for (let x = 0; x < w; x += 1) { seed(x, 0); seed(x, h - 1); }
          for (let y = 0; y < h; y += 1) { seed(0, y); seed(w - 1, y); }
          while (stack.length) {
            const p = stack.pop();
            const x = p % w, y = (p - x) / w;
            d[p * 4 + 3] = 0;
            const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            for (let k = 0; k < 4; k += 1) {
              const nx = nb[k][0], ny = nb[k][1];
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const np = ny * w + nx;
              if (visited[np]) continue;
              const ni = np * 4;
              if (d[ni + 3] < 10) { visited[np] = 1; continue; }
              if (isChecker(d[ni], d[ni + 1], d[ni + 2])) { visited[np] = 1; stack.push(np); }
            }
          }
          ctx.putImageData(id, 0, 0);
          resolve(c.toDataURL("image/png"));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function localCutoutDataUrlToStored(dataUrl, opts) {
    opts = opts || {};
    if (!global.WpsAiLocalMatting || !global.WpsAiLocalMatting.cutout) {
      throw new Error("本地抠图不可用（模型/运行时未就绪）。");
    }
    const label = opts.label || "本地抠图";
    setEditProgressLabel(label);
    const png = await global.WpsAiLocalMatting.cutout(dataUrl, {
      signal: opts.signal,
      onProgress: (l) => setEditProgressLabel(l)
    });
    let p = null;
    try { p = await global.WpsAiImageAssets?.ensureLocalImagePath?.(png); } catch (e) {}
    return p ? { url: p } : { dataUrl: png };
  }

  async function imageResultToDataUrl(result, signal) {
    if (!result) return "";
    if (result.b64) return "data:image/png;base64," + result.b64;
    const url = String(result.url || "").trim();
    if (!url) return "";
    if (/^data:image\//i.test(url)) return url;
    return await getMaterialFullDataUrl({ url });
  }

  // 把 AI 抠图结果（可能带棋盘底）再走本地 matting，最终入库透明 PNG。
  async function cutoutResultToStored(results, opts) {
    opts = opts || {};
    const r0 = results && results[0];
    if (!r0) throw new Error("抠图未返回可用图片。");
    let dataUrl = await imageResultToDataUrl(r0, opts.signal);
    if (!dataUrl) throw new Error("抠图未返回可用图片。");
    dataUrl = await removeCheckerboardBackground(dataUrl);
    try {
      setEditProgressLabel("本地透明化");
      return await localCutoutDataUrlToStored(dataUrl, {
        signal: opts.signal,
        label: "本地透明化"
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new Error("AI 抠图结果本地透明化失败：" + (e?.message || e));
    }
  }

  // 统一抠图入口：优先本地离线 matting；本地不可用或失败时，回退当前图像渠道的 AI 编辑能力。
  async function cutoutToStored(dataUrl, opts) {
    opts = opts || {};
    const signal = opts.signal;
    if (!opts.forceAi && global.WpsAiLocalMatting && global.WpsAiLocalMatting.isSupported && global.WpsAiLocalMatting.isSupported()) {
      try {
        return await localCutoutDataUrlToStored(dataUrl, { signal, label: "本地抠图" });
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        console.warn("[matting] 本地抠图失败，尝试回退 AI:", e && (e.message || e));
        if (opts.allowAiFallback === false) throw e;
      }
    }
    // —— AI 回退（ToAPI / Codex 桥接由 WpsAiImage.editImage 分发）——
    setEditProgressLabel("AI 抠图");
    const prompt = String(opts.prompt || "").trim()
      || "移除背景，只保留主体，输出透明背景 PNG，主体边缘干净、不要残留背景色。";
    const results = await global.WpsAiImage.editImage({
      imageDataUrl: dataUrl,
      prompt,
      background: "transparent",
      signal
    });
    return await cutoutResultToStored(results, { signal });
  }

  function mergeMaterialTags(baseTags, tags) {
    const lib = global.WpsAiMaterialLibrary;
    const values = (Array.isArray(baseTags) ? baseTags : []).concat(Array.isArray(tags) ? tags : []);
    if (lib?.normalizeTags) return lib.normalizeTags(values);
    const seen = new Set();
    const out = [];
    values.map((t) => String(t == null ? "" : t).trim()).forEach((t) => {
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    });
    return out.slice(0, 12);
  }

  function retagEditedMaterialEntry(entry, opts) {
    opts = opts || {};
    const lib = global.WpsAiMaterialLibrary;
    const tagger = global.WpsAiMaterialTagger;
    if (!entry || !entry.id || !lib || !tagger?.tagImage) return;
    const baseTags = mergeMaterialTags(opts.baseTags || [], []);
    Promise.resolve().then(async () => {
      let dataUrl = String(opts.dataUrl || "").trim();
      if (!dataUrl) {
        try { dataUrl = await getMaterialFullDataUrl(entry); } catch (e) {}
      }
      const url = materialDisplayUrl(entry);
      const tags = await tagger.tagImage(dataUrl ? { dataUrl } : { url });
      if (!tags || !tags.length) return;
      const updated = lib.update?.(entry.id, { tags: mergeMaterialTags(baseTags, tags) });
      if (!updated) return;
      if (materialPreviewItemId === entry.id) void openMaterialPreview(updated);
      renderMaterialLibrary();
    }).catch(() => {});
  }

  // 素材图像编辑（抠图/重绘）的可视进度：预览图上盖一层「XX中 · Ns（可取消）」+ 转圈 + 取消按钮。
  let _editTimer = null;
  let _editT0 = 0, _editLabel = "";
  function startEditProgress(label) {
    const ov = els.materialEditOverlay;
    if (!ov) return;
    const statusEl = ov.querySelector('[data-role="editstatus"]');
    _editLabel = label;
    _editT0 = Date.now();
    ov.classList.remove("hidden");
    const tick = () => { if (statusEl) statusEl.textContent = _editLabel + " · " + Math.round((Date.now() - _editT0) / 1000) + "s"; };
    tick();
    if (_editTimer) clearInterval(_editTimer);
    _editTimer = setInterval(tick, 500);
  }
  // 只换文案、不重置计时（本地抠图会分「加载模型 / 抠图计算」几个阶段）
  function setEditProgressLabel(label) { _editLabel = label; }
  function stopEditProgress() {
    if (_editTimer) { clearInterval(_editTimer); _editTimer = null; }
    els.materialEditOverlay?.classList.add("hidden");
  }

  // 智能抠图：本地优先；需要 AI 回退时走当前图像渠道的编辑接口，AI 结果再本地透明化。
  async function cutoutCurrentMaterial() {
    const btn = els.materialCutoutBtn;
    if (_imgEditAbort) { try { _imgEditAbort.abort(); } catch (e) {} return; } // 运行中再点=取消
    const lib = global.WpsAiMaterialLibrary;
    const item = lib?.find?.(materialPreviewItemId);
    if (!lib || !item) { showMessage("素材已失效。", "error"); return; }
    _imgEditAbort = new AbortController();
    const orig = btn ? btn.textContent : "";
    if (btn) btn.textContent = "取消抠图";
    const imageUI = global.WpsAiImageUI;
    let uiStarted = false;
    try {
      const dataUrl = await getMaterialFullDataUrl(item);
      imageUI?.start?.({ prompt: "抠图（去背景）" });
      startEditProgress("抠图");
      uiStarted = true;
      const stored = await cutoutToStored(dataUrl, { signal: _imgEditAbort.signal, allowAiFallback: true });
      try { imageUI?.done?.(); } catch (e) {}
      uiStarted = false;
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const entry = lib.add(Object.assign({
        prompt: "抠图 · " + (item.prompt || item.title || "素材"),
        source: "cutout",
        project: settings.currentProject || item.project || "",
        tags: (Array.isArray(item.tags) ? item.tags.slice() : []).concat("抠图")
      }, stored));
      if (entry) { showMessage("抠图完成，已存入素材库。", "success"); activateMaterialPreviewEntry(entry); renderMaterialLibrary(); }
      else showMessage("抠图完成但存入失败。", "error");
    } catch (e) {
      const cancelled = e && e.name === "AbortError";
      if (uiStarted) { try { imageUI?.fail?.(cancelled ? "已取消" : (e?.message || String(e))); } catch (e2) {} }
      showMessage(cancelled ? "已取消抠图。" : ("抠图失败：" + (e?.message || e)), cancelled ? "info" : "error");
    } finally {
      stopEditProgress();
      _imgEditAbort = null;
      if (btn) btn.textContent = orig;
    }
  }

  async function localCutoutCurrentMaterial() {
    const btn = els.materialLocalCutoutBtn;
    if (_imgEditAbort) { try { _imgEditAbort.abort(); } catch (e) {} return; }
    const lib = global.WpsAiMaterialLibrary;
    const item = lib?.find?.(materialPreviewItemId);
    if (!lib || !item) { showMessage("素材已失效。", "error"); return; }
    _imgEditAbort = new AbortController();
    const orig = btn ? btn.textContent : "";
    if (btn) btn.textContent = "取消抠图";
    const imageUI = global.WpsAiImageUI;
    let uiStarted = false;
    try {
      const dataUrl = await getMaterialFullDataUrl(item);
      imageUI?.start?.({ prompt: "本地模型抠图" });
      startEditProgress("本地模型抠图");
      uiStarted = true;
      const stored = await localCutoutDataUrlToStored(dataUrl, {
        signal: _imgEditAbort.signal,
        label: "本地模型抠图"
      });
      try { imageUI?.done?.(); } catch (e) {}
      uiStarted = false;
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const entry = lib.add(Object.assign({
        prompt: "本地抠图 · " + (item.prompt || item.title || "素材"),
        source: "cutout",
        project: settings.currentProject || item.project || "",
        tags: (Array.isArray(item.tags) ? item.tags.slice() : []).concat("抠图", "本地模型")
      }, stored));
      if (entry) { showMessage("本地模型抠图完成，已存入素材库。", "success"); activateMaterialPreviewEntry(entry); renderMaterialLibrary(); }
      else showMessage("本地模型抠图完成但存入失败。", "error");
    } catch (e) {
      const cancelled = e && e.name === "AbortError";
      if (uiStarted) { try { imageUI?.fail?.(cancelled ? "已取消" : (e?.message || String(e))); } catch (e2) {} }
      showMessage(cancelled ? "已取消抠图。" : ("本地模型抠图失败：" + (e?.message || e)), cancelled ? "info" : "error");
    } finally {
      stopEditProgress();
      _imgEditAbort = null;
      if (btn) btn.textContent = orig;
    }
  }

  function updateCutoutButtonVisibility() {
    let imageProviderType = "";
    try { imageProviderType = (global.WpsAiProviderRegistry?.getImageConfig?.() || {}).type || "toapis"; } catch (e) {}
    const supportsAiEdit = ["codex-bridge", "toapis", "openai", "openrouter"].includes(imageProviderType);
    const isCodexBridge = imageProviderType === "codex-bridge";
    const localOk = !!(global.WpsAiLocalMatting && global.WpsAiLocalMatting.isSupported && global.WpsAiLocalMatting.isSupported());
    const show = supportsAiEdit || localOk; // 本地抠图不挑渠道，可用即显示
    els.materialCutoutBtn?.classList.toggle("hidden", !show);
    els.materialLocalCutoutBtn?.classList.toggle("hidden", !localOk);
    els.materialBrushEditBtn?.classList.toggle("hidden", !show);
    // 「涂抹处重绘」走当前图像渠道的 AI 编辑能力；纯本地只保留「抠出涂抹主体」
    els.materialBrushInpaintBtn?.classList.toggle("hidden", !supportsAiEdit);
  }

  // ==== 画笔编辑（涂抹 + AI 图片编辑）：局部重绘 / 按涂抹抠图 ====
  function bindMaterialBrush() {
    const canvas = els.materialBrushCanvas;
    if (!canvas || canvas.dataset.brushBound === "1") return;
    canvas.dataset.brushBound = "1";
    const posOf = (ev) => {
      const r = canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * (canvas.width / (r.width || 1)), y: (ev.clientY - r.top) * (canvas.height / (r.height || 1)) };
    };
    const dot = (p) => {
      const ctx = canvas.getContext("2d");
      const size = Number(els.materialBrushSize?.value) || 30;
      ctx.fillStyle = "rgba(255,70,70,0.55)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    };
    const line = (a, b) => {
      const ctx = canvas.getContext("2d");
      const size = Number(els.materialBrushSize?.value) || 30;
      ctx.strokeStyle = "rgba(255,70,70,0.55)";
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    canvas.addEventListener("mousedown", (ev) => {
      if (!_brushMode) return;
      ev.preventDefault();
      _brushPainting = true;
      _brushLast = posOf(ev);
      dot(_brushLast);
    });
    window.addEventListener("mousemove", (ev) => {
      if (!_brushPainting) return;
      const p = posOf(ev);
      line(_brushLast, p);
      dot(p);
      _brushLast = p;
    });
    window.addEventListener("mouseup", () => { _brushPainting = false; });
  }
  function clearBrush() {
    const c = els.materialBrushCanvas;
    if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }
  function enterBrushMode() {
    const img = els.materialPreviewImage;
    const canvas = els.materialBrushCanvas;
    if (!img || !canvas || img.classList.contains("hidden")) { showMessage("图片未加载完成。", "error"); return; }
    resetMaterialPreviewZoom();
    exitCropMode();
    _brushMode = true;
    els.materialPreviewModal?.classList.add("brush-mode");
    els.materialBrushBar?.classList.remove("hidden");
    els.materialPreviewCropBtn?.classList.add("hidden");
    els.materialCutoutBtn?.classList.add("hidden");
    els.materialLocalCutoutBtn?.classList.add("hidden");
    els.materialBrushEditBtn?.classList.add("hidden");
    const stage = canvas.parentElement;
    const ir = img.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    canvas.style.left = (ir.left - sr.left) + "px";
    canvas.style.top = (ir.top - sr.top) + "px";
    canvas.style.width = ir.width + "px";
    canvas.style.height = ir.height + "px";
    canvas.style.transformOrigin = "center center";
    canvas.width = Math.max(1, Math.round(ir.width));
    canvas.height = Math.max(1, Math.round(ir.height));
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    canvas.classList.remove("hidden");
    applyMaterialPreviewTransform();
  }
  function exitBrushMode() {
    _brushMode = false;
    _brushPainting = false;
    els.materialPreviewModal?.classList.remove("brush-mode");
    els.materialBrushCanvas?.classList.add("hidden");
    els.materialBrushBar?.classList.add("hidden");
    els.materialPreviewCropBtn?.classList.remove("hidden");
    updateCutoutButtonVisibility();
  }
  // 由涂抹画布生成 mask：/images/edits 里透明处=要编辑，白/不透明处=保留。
  // invert=true（局部重绘）：涂抹处→透明(编辑)、其余→不透明(保留)。
  // invert=false（抠图）：涂抹处→不透明(保留主体)、其余→透明(去背景)。
  function buildBrushMaskDataUrl(natW, natH, invert) {
    const src = els.materialBrushCanvas;
    const c = document.createElement("canvas");
    c.width = natW; c.height = natH;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0, natW, natH);
    const img = ctx.getImageData(0, 0, natW, natH);
    const d = img.data;
    let painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      const isPaint = d[i + 3] > 10;
      if (isPaint) painted += 1;
      const keep = invert ? !isPaint : isPaint;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = keep ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
    return { dataUrl: c.toDataURL("image/png"), painted };
  }
  // 涂抹处重绘（AI /images/edits，支持取消）
  async function applyBrushInpaint() {
    const btn = els.materialBrushInpaintBtn;
    if (_imgEditAbort) { try { _imgEditAbort.abort(); } catch (e) {} return; } // 运行中再点=取消
    const lib = global.WpsAiMaterialLibrary;
    const item = lib?.find?.(materialPreviewItemId);
    if (!lib || !item) { showMessage("素材已失效。", "error"); return; }
    _imgEditAbort = new AbortController();
    const orig = btn ? btn.textContent : "";
    const imageUI = global.WpsAiImageUI;
    let uiStarted = false;
    try {
      const imageDataUrl = await getMaterialFullDataUrl(item);
      const baseImg = await loadImageEl(imageDataUrl);
      const { dataUrl: maskDataUrl, painted } = buildBrushMaskDataUrl(baseImg.naturalWidth, baseImg.naturalHeight, true);
      if (painted < 20) { showMessage("请先用画笔涂抹要重绘的区域。", "error"); _imgEditAbort = null; return; }
      if (btn) btn.textContent = "取消";
      const prompt = String(els.materialBrushPrompt?.value || "").trim() || "按标注自然重绘涂抹区域，与周围风格、光影、透视保持一致。";
      imageUI?.start?.({ prompt: "局部重绘" });
      startEditProgress("局部重绘");
      uiStarted = true;
      const results = await global.WpsAiImage.editImage({
        imageDataUrl, maskDataUrl, prompt,
        signal: _imgEditAbort.signal,
        onProgress: (info) => { try { imageUI?.update?.(info || {}); } catch (e) {} }
      });
      try { imageUI?.done?.(); } catch (e) {}
      uiStarted = false;
      const url = results && results[0] && results[0].url;
      if (!url) throw new Error("未返回可用图片。");
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const entry = lib.add({
        url,
        prompt: "重绘 · " + (item.prompt || item.title || "素材"),
        source: "inpaint",
        project: settings.currentProject || item.project || "",
        tags: ["重绘"]
      }, { allowDuplicate: true });
      if (entry) { showMessage("局部重绘完成，已存入素材库。", "success"); retagEditedMaterialEntry(entry, { baseTags: ["重绘"] }); activateMaterialPreviewEntry(entry); exitBrushMode(); renderMaterialLibrary(); }
      else showMessage("完成但存入失败。", "error");
    } catch (e) {
      const cancelled = e && e.name === "AbortError";
      if (uiStarted) { try { imageUI?.fail?.(cancelled ? "已取消" : (e?.message || String(e))); } catch (e2) {} }
      showMessage(cancelled ? "已取消重绘。" : ("局部重绘失败：" + (e?.message || e)), cancelled ? "info" : "error");
    } finally {
      stopEditProgress();
      _imgEditAbort = null;
      if (btn) btn.textContent = orig;
    }
  }

  // 涂抹外接框：把画笔涂抹的范围换算到原图像素，得到 { minX,minY,maxX,maxY,painted }。
  function brushPaintedBBox(natW, natH) {
    const bin = document.createElement("canvas");
    bin.width = natW; bin.height = natH;
    const bctx = bin.getContext("2d");
    bctx.drawImage(els.materialBrushCanvas, 0, 0, natW, natH);
    const d = bctx.getImageData(0, 0, natW, natH).data;
    let painted = 0, minX = natW, minY = natH, maxX = 0, maxY = 0;
    for (let y = 0; y < natH; y += 1) {
      for (let x = 0; x < natW; x += 1) {
        if (d[(y * natW + x) * 4 + 3] > 10) {
          painted += 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return { minX, minY, maxX, maxY, painted };
  }

  function closeMaterialCutoutChoice() {
    els.materialCutoutChoiceModal?.classList.add("hidden");
  }
  function openMaterialCutoutChoice() {
    if (els.materialCutoutDescribeInput) els.materialCutoutDescribeInput.value = "";
    els.materialCutoutChoiceModal?.classList.remove("hidden");
    setTimeout(() => { try { els.materialCutoutDescribeInput?.focus?.(); } catch (e) {} }, 0);
  }
  function describedCutoutPrompt(text) {
    const target = String(text || "").trim();
    if (!target) return "";
    return `只保留用户描述的主体：${target}。移除其它所有内容和背景，输出透明背景 PNG。主体边缘干净，不要残留背景色，不要新增物体。`;
  }
  async function runBrushCutoutWithoutSelection(mode) {
    closeMaterialCutoutChoice();
    const description = String(els.materialCutoutDescribeInput?.value || "").trim();
    if (mode === "describe" && !description) {
      showMessage("请描述需要抠出的部分，或选择整张去背景。", "error");
      openMaterialCutoutChoice();
      return;
    }
    const btn = els.materialBrushCutoutBtn;
    if (_imgEditAbort) { try { _imgEditAbort.abort(); } catch (e) {} return; }
    const lib = global.WpsAiMaterialLibrary;
    const item = lib?.find?.(materialPreviewItemId);
    if (!lib || !item) { showMessage("素材已失效。", "error"); return; }
    _imgEditAbort = new AbortController();
    const orig = btn ? btn.textContent : "";
    const imageUI = global.WpsAiImageUI;
    let uiStarted = false;
    try {
      const dataUrl = await getMaterialFullDataUrl(item);
      if (btn) btn.textContent = "取消";
      const prompt = mode === "describe" ? describedCutoutPrompt(description) : "";
      imageUI?.start?.({ prompt: mode === "describe" ? "描述抠图" : "整张去背景" });
      startEditProgress(mode === "describe" ? "描述抠图" : "整张去背景");
      uiStarted = true;
      const stored = await cutoutToStored(dataUrl, {
        signal: _imgEditAbort.signal,
        allowAiFallback: true,
        forceAi: mode === "describe",
        prompt
      });
      try { imageUI?.done?.(); } catch (e) {}
      uiStarted = false;
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const entry = lib.add(Object.assign({
        prompt: (mode === "describe" ? `抠图（${description}） · ` : "抠图 · ") + (item.prompt || item.title || "素材"),
        source: "cutout",
        project: settings.currentProject || item.project || "",
        tags: ["抠图"]
      }, stored), { allowDuplicate: true });
      if (entry) { showMessage("抠图完成，已存入素材库。", "success"); retagEditedMaterialEntry(entry, { baseTags: ["抠图"] }); activateMaterialPreviewEntry(entry); exitBrushMode(); renderMaterialLibrary(); }
      else showMessage("抠图完成但存入失败。", "error");
    } catch (e) {
      const cancelled = e && e.name === "AbortError";
      if (uiStarted) { try { imageUI?.fail?.(cancelled ? "已取消" : (e?.message || String(e))); } catch (e2) {} }
      showMessage(cancelled ? "已取消抠图。" : ("抠图失败：" + (e?.message || e)), cancelled ? "info" : "error");
    } finally {
      stopEditProgress();
      _imgEditAbort = null;
      if (btn) btn.textContent = orig;
    }
  }

  // 抠出涂抹主体：用涂抹范围告诉 AI 要抠哪个主体——按涂抹外接框裁出主体区域，再用 AI 去背景。
  // 这样既是 AI 抠图（智能抠边、透明底），又靠涂抹定位主体，且裁过之后不会整张重新生成。支持取消。
  async function aiBrushCutout() {
    const btn = els.materialBrushCutoutBtn;
    if (_imgEditAbort) { try { _imgEditAbort.abort(); } catch (e) {} return; } // 运行中再点=取消
    const lib = global.WpsAiMaterialLibrary;
    const item = lib?.find?.(materialPreviewItemId);
    if (!lib || !item) { showMessage("素材已失效。", "error"); return; }
    const orig = btn ? btn.textContent : "";
    const imageUI = global.WpsAiImageUI;
    let uiStarted = false;
    try {
      const img = await loadImageEl(await getMaterialFullDataUrl(item));
      const natW = img.naturalWidth;
      const natH = img.naturalHeight;
      const bb = brushPaintedBBox(natW, natH);
      if (bb.painted < 20) { openMaterialCutoutChoice(); return; }
      _imgEditAbort = new AbortController();
      if (btn) btn.textContent = "取消";
      // 裁到涂抹外接框（多留些边，别把主体边缘切掉），再交给 AI 去背景
      const pad = Math.round(Math.max(natW, natH) * 0.06);
      const cx = Math.max(0, bb.minX - pad);
      const cy = Math.max(0, bb.minY - pad);
      const cw = Math.min(natW - cx, (bb.maxX - bb.minX + 1) + pad * 2);
      const ch = Math.min(natH - cy, (bb.maxY - bb.minY + 1) + pad * 2);
      const crop = document.createElement("canvas");
      crop.width = Math.max(1, cw); crop.height = Math.max(1, ch);
      crop.getContext("2d").drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
      const cropDataUrl = crop.toDataURL("image/png");
      imageUI?.start?.({ prompt: "画笔抠图" });
      startEditProgress("画笔抠图");
      uiStarted = true;
      // 涂抹框定主体 → 裁出该区域 → 本地 matting 抠出（本地不可用再回退 AI）
      const stored = await cutoutToStored(cropDataUrl, { signal: _imgEditAbort.signal, allowAiFallback: true });
      try { imageUI?.done?.(); } catch (e) {}
      uiStarted = false;
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const entry = lib.add(Object.assign({
        prompt: "抠图 · " + (item.prompt || item.title || "素材"),
        source: "cutout",
        project: settings.currentProject || item.project || "",
        tags: ["抠图"]
      }, stored), { allowDuplicate: true });
      if (entry) { showMessage("已按涂抹抠出主体，存入素材库。", "success"); retagEditedMaterialEntry(entry, { baseTags: ["抠图"] }); activateMaterialPreviewEntry(entry); exitBrushMode(); renderMaterialLibrary(); }
      else showMessage("抠图完成但存入失败。", "error");
    } catch (e) {
      const cancelled = e && e.name === "AbortError";
      if (uiStarted) { try { imageUI?.fail?.(cancelled ? "已取消" : (e?.message || String(e))); } catch (e2) {} }
      showMessage(cancelled ? "已取消抠图。" : ("抠图失败：" + (e?.message || e)), cancelled ? "info" : "error");
    } finally {
      stopEditProgress();
      _imgEditAbort = null;
      if (btn) btn.textContent = orig;
    }
  }

  function closeMaterialPreview() {
    materialPreviewItemId = null;
    if (_imgEditAbort) { try { _imgEditAbort.abort(); } catch (e) {} }
    stopEditProgress();
    closeMaterialCutoutChoice();
    exitCropMode();
    exitBrushMode();
    resetMaterialPreviewZoom();
    els.materialPreviewModal?.classList.add("hidden");
    if (els.materialPreviewImage) {
      els.materialPreviewImage.removeAttribute("src");
      els.materialPreviewImage.classList.add("hidden");
    }
  }

  async function openMaterialPreview(item) {
    if (!item) return;
    materialPreviewItemId = item.id || null;
    const prompt = item.prompt || item.revisedPrompt || "";
    const rawUrl = materialDisplayUrl(item);
    if (els.materialPreviewPrompt) els.materialPreviewPrompt.textContent = prompt || "未记录提示词";
    if (els.materialPreviewMeta) els.materialPreviewMeta.textContent = materialMetaText(item);
    if (els.materialPreviewUrl) {
      els.materialPreviewUrl.textContent = rawUrl || "未记录图片地址";
      els.materialPreviewUrl.title = rawUrl || "";
    }
    if (els.materialPreviewImage) {
      els.materialPreviewImage.removeAttribute("src");
      els.materialPreviewImage.alt = prompt || "素材预览";
      els.materialPreviewImage.classList.add("hidden");
    }
    if (els.materialPreviewStatus) {
      els.materialPreviewStatus.textContent = "加载中";
      els.materialPreviewStatus.classList.remove("hidden");
    }
    if (els.materialPreviewInsertBtn) els.materialPreviewInsertBtn.disabled = materialInsertBusy || !rawUrl;
    if (els.materialPreviewSaveAsBtn) {
      els.materialPreviewSaveAsBtn.disabled = !rawUrl;
      els.materialPreviewSaveAsBtn.textContent = "另存为";
    }
    if (els.materialPreviewCopyBtn) els.materialPreviewCopyBtn.disabled = !rawUrl;
    els.materialPreviewModal?.classList.remove("hidden");
    bindMaterialPreviewZoom();
    resetMaterialPreviewZoom();
    exitCropMode();
    exitBrushMode();
    // 只有能拿到真实图片（有 url 或 dataUrl）才允许裁剪
    if (els.materialPreviewCropBtn) els.materialPreviewCropBtn.disabled = !materialDisplayUrl(item);
    updateCutoutButtonVisibility();
    if (els.materialCutoutBtn) els.materialCutoutBtn.disabled = !materialDisplayUrl(item);
    if (els.materialLocalCutoutBtn) els.materialLocalCutoutBtn.disabled = !materialDisplayUrl(item);
    if (els.materialBrushEditBtn) els.materialBrushEditBtn.disabled = !materialDisplayUrl(item);

    const previewUrl = await ensureMaterialPreview(item);
    if (materialPreviewItemId !== item.id) return;
    if (!previewUrl) {
      if (els.materialPreviewStatus) els.materialPreviewStatus.textContent = "无法预览";
      return;
    }
    if (els.materialPreviewImage) {
      els.materialPreviewImage.onload = () => {
        if (materialPreviewItemId !== item.id) return;
        els.materialPreviewImage?.classList.remove("hidden");
        els.materialPreviewStatus?.classList.add("hidden");
      };
      els.materialPreviewImage.onerror = () => {
        if (materialPreviewItemId !== item.id) return;
        els.materialPreviewImage?.classList.add("hidden");
        if (els.materialPreviewStatus) {
          els.materialPreviewStatus.textContent = "无法预览";
          els.materialPreviewStatus.classList.remove("hidden");
        }
      };
      els.materialPreviewImage.src = previewUrl;
    }
  }

  function activateMaterialPreviewEntry(entry) {
    if (!entry || !entry.id) return;
    materialPreviewItemId = entry.id;
    void openMaterialPreview(entry);
  }

  function renderMaterialGroups(groups) {
    if (!els.materialGroupList) return;
    els.materialGroupList.innerHTML = "";
    groups.forEach((group) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "material-group-item" + (group.id === activeMaterialGroupId ? " active" : "");
      btn.dataset.groupId = group.id;
      btn.innerHTML = `
        <span class="material-group-name">${escapeHtml(group.name)}</span>
        <span class="material-group-count">${Number(group.count || 0)}</span>
      `;
      btn.addEventListener("click", () => {
        activeMaterialGroupId = group.id;
        selectedMaterialIds.clear();
        renderMaterialLibrary();
      });
      els.materialGroupList.appendChild(btn);
    });
  }

  function renderMaterialToolbar(groups) {
    const selected = getSelectedMaterials();
    const selectedCount = selected.length;
    if (els.materialSelectedCount) {
      els.materialSelectedCount.textContent = selectedCount ? `已选择 ${selectedCount} 张` : "未选择素材";
    }
    if (els.materialMoveGroupSelect) {
      const previous = els.materialMoveGroupSelect.value || MATERIAL_DEFAULT_GROUP_ID;
      els.materialMoveGroupSelect.innerHTML = "";
      groups.filter((group) => !group.virtual).forEach((group) => {
        const option = document.createElement("option");
        option.value = group.id;
        option.textContent = group.name;
        els.materialMoveGroupSelect.appendChild(option);
      });
      const values = new Set(groups.filter((group) => !group.virtual).map((group) => group.id));
      els.materialMoveGroupSelect.value = values.has(previous) ? previous : MATERIAL_DEFAULT_GROUP_ID;
      els.materialMoveGroupSelect.disabled = selectedCount === 0;
    }
    if (els.materialMoveBtn) els.materialMoveBtn.disabled = selectedCount === 0;
    if (els.materialDeleteBtn) els.materialDeleteBtn.disabled = selectedCount === 0;
    if (els.materialInsertBtn) els.materialInsertBtn.disabled = materialInsertBusy || selectedCount !== 1;
    if (els.materialModifyBtn) els.materialModifyBtn.disabled = selectedCount !== 1;
    if (els.materialCopyBtn) els.materialCopyBtn.disabled = selectedCount !== 1;
  }

  function selectMaterial(id, additive) {
    const next = additive ? new Set(selectedMaterialIds) : new Set();
    if (additive && next.has(id)) next.delete(id);
    else next.add(id);
    selectedMaterialIds = next;
    renderMaterialLibrary();
  }

  // 用素材里出现过的项目填充项目筛选下拉，保留当前选择。
  function renderMaterialProjectFilter(allEntries) {
    const sel = els.materialProjectFilter;
    if (!sel) return;
    const projects = Array.from(new Set((allEntries || [])
      .map((e) => (e.project || "").trim())
      .filter(Boolean))).sort();
    const prev = materialProjectFilterValue;
    sel.innerHTML = '<option value="">全部项目</option>' +
      projects.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");
    sel.value = projects.includes(prev) ? prev : "";
    materialProjectFilterValue = sel.value;
  }

  // 读本地图片文件为 dataURL。
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error || new Error("读取失败"));
      fr.readAsDataURL(file);
    });
  }

  // 本地图片导入素材库 + 异步视觉打标。
  // 图片先经本地代理 /upload-image 落盘，素材库只存文件路径（不把整段 base64 塞 localStorage）——
  // 这样大 GIF / 高清图也能导入，不再撞「图片过大或本地存储已满」。代理落盘失败时，仅小图兜底存 dataUrl。
  async function importLocalImages(files) {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib || !files || !files.length) return;
    const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
    const assets = global.WpsAiImageAssets;
    let ok = 0;
    let failed = 0;
    const newItems = []; // { id, dataUrl } —— dataUrl 仅用于随后视觉打标（本地路径不能直接喂视觉模型）
    for (const file of files) {
      if (!/^image\//.test(file.type || "")) continue;
      // 20MB 上限，防超大文件卡住上传（普通 GIF/照片远低于此）
      if (file.size > 20 * 1024 * 1024) { failed += 1; continue; }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (!dataUrl) { failed += 1; continue; }
        // 优先落盘 → 存路径；代理不可用时，仅当 dataUrl 较小（≤1MB）才兜底存 base64，大图放弃。
        let stored = null;
        try {
          const p = await assets?.ensureLocalImagePath?.(dataUrl);
          if (p) stored = { url: p };
        } catch (e) { /* 落盘失败，走兜底 */ }
        if (!stored) {
          if (dataUrl.length <= 1024 * 1024) stored = { dataUrl };
          else { failed += 1; continue; }
        }
        const entry = lib.add(Object.assign({
          prompt: file.name || "",
          source: "local",
          project: settings.currentProject || ""
        }, stored));
        if (entry) { ok += 1; newItems.push({ id: entry.id, dataUrl }); }
        else failed += 1; // add 返回 null = 写入失败
      } catch (e) { failed += 1; }
    }
    renderMaterialLibrary();
    if (ok) {
      showMessage(`已导入 ${ok} 张本地图片${failed ? `，${failed} 张失败（超过 20MB 或代理未启动）` : ""}，正在自动打标…`, failed ? "info" : "success");
    } else {
      showMessage(failed ? `导入失败：${failed} 张（图片超过 20MB，或本地代理未启动）` : "没有可导入的图片。", "error");
      return;
    }
    // 异步视觉打标（best-effort，不阻塞）：用内存里的 dataUrl 走视觉模型（素材条目里存的是路径，不能直接喂）。
    newItems.forEach(({ id, dataUrl }) => {
      const p = global.WpsAiMaterialTagger?.tagImage?.({ dataUrl });
      if (p && typeof p.then === "function") {
        p.then((tags) => {
          if (tags && tags.length) { lib.update(id, { tags }); renderMaterialLibrary(); }
        }).catch(() => {});
      }
    });
  }

  function renderMaterialLibrary() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib || !els.materialLibraryList) return;
    const groups = materialGroups();
    if (!groups.some((group) => group.id === activeMaterialGroupId)) {
      activeMaterialGroupId = MATERIAL_ALL_GROUP_ID;
    }
    const allEntries = lib.list();
    syncSelectedMaterials(allEntries);
    const groupName = materialGroupNameById(groups);
    let entries = lib.list({ groupId: activeMaterialGroupId });
    // 项目筛选下拉：用「当前分组」里出现过的项目填充，和下面按分组过滤的口径一致，
    // 避免选了只存在于别的分组的项目导致结果空且无提示。
    renderMaterialProjectFilter(entries);
    // 文本搜索 + 项目筛选
    const q = (materialSearchText || "").trim().toLowerCase();
    const pf = materialProjectFilterValue || "";
    if (q || pf) {
      entries = entries.filter((it) => {
        if (pf && (it.project || "") !== pf) return false;
        if (q) {
          const hay = [it.prompt, it.revisedPrompt, it.title, it.text, (it.tags || []).join(" "), it.project]
            .join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }
    renderMaterialGroups(groups);
    renderMaterialToolbar(groups);
    els.materialLibraryList.innerHTML = "";
    if (els.materialLibraryEmpty) {
      els.materialLibraryEmpty.innerHTML = allEntries.length
        ? "<p>当前分组暂无素材。选中素材后可用「移动」放入这个分组。</p>"
        : "<p>暂无生图历史。用「AI 生成图片」生成后，会自动保存到这里。</p>";
    }
    els.materialLibraryEmpty?.classList.toggle("hidden", entries.length > 0);
    entries.forEach((item) => {
      const card = document.createElement("article");
      const selected = selectedMaterialIds.has(item.id);
      // 脑图这类宽图用 contain 显示，避免 4:3 缩略图 cover 裁掉两侧看着"不完整"
      card.className = "material-card" + (selected ? " selected" : "") + (item.source === "mindmap" ? " material-card--contain" : "");
      card.dataset.materialId = item.id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-pressed", selected ? "true" : "false");
      const prompt = item.prompt || item.revisedPrompt || "";
      const url = materialDisplayUrl(item);
      card.innerHTML = `
        <div class="material-thumb" data-role="thumb">
          <span class="material-thumb-placeholder">加载中</span>
          ${materialPreviewButtonHtml()}
        </div>
        <div class="material-card-body">
          <div class="material-prompt" title="${escapeAttr(prompt)}">${escapeHtml(prompt || "未记录提示词")}</div>
          <div class="material-meta" title="${escapeAttr(url)}">${escapeHtml(materialMetaText(item))}</div>
          ${(item.tags && item.tags.length) ? `<div class="material-tags">${item.tags.map((t) => `<span class="material-tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
          <span class="material-group-pill">${escapeHtml(groupName.get(materialGroupId(item)) || "未分组")}${item.project ? " · " + escapeHtml(item.project) : ""}</span>
        </div>
      `;
      const thumb = card.querySelector('[data-role="thumb"]');
      ensureMaterialPreview(item).then((previewUrl) => {
        if (!thumb || !previewUrl) {
          if (thumb) thumb.innerHTML = `<span class="material-thumb-placeholder">无法预览</span>${materialPreviewButtonHtml()}`;
          return;
        }
        thumb.innerHTML = `<img src="${escapeAttr(previewUrl)}" alt="${escapeAttr(prompt || "生成图片")}" loading="lazy" />${materialPreviewButtonHtml()}`;
      });
      card.addEventListener("click", (ev) => {
        const previewBtn = ev.target?.closest?.('[data-role="preview"]');
        if (previewBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          openMaterialPreview(item);
          return;
        }
        selectMaterial(item.id, ev.metaKey || ev.ctrlKey || ev.shiftKey);
      });
      card.addEventListener("dblclick", (ev) => {
        if (ev.target?.closest?.('[data-role="preview"]')) return;
        insertSelectedMaterial();
      });
      card.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        selectMaterial(item.id, ev.metaKey || ev.ctrlKey || ev.shiftKey);
      });
      els.materialLibraryList.appendChild(card);
    });
  }

  function materialToolForHost(host, url) {
    if (host === "wps") return { toolName: "wps_insert_image", args: { fileName: url } };
    if (host === "wpp") return { toolName: "wpp_add_picture", args: { fileName: url, left: 80, top: 120, width: 560 } };
    if (host === "et") return { toolName: "et_insert_image", args: { fileName: url, width: 240 } };
    return null;
  }

  async function insertMaterialIntoDocument(item) {
    if (materialInsertBusy) {
      showMessage("图片正在插入，请稍候。", "info", { duration: 2500 });
      return false;
    }
    setMaterialInsertBusy(true);
    try {
      showMessage("正在插入图片到文档，请稍候…", "info", { duration: 8000 });
      const url = await materialInsertUrl(item);
      if (!url) {
        showMessage("这条素材没有可用图片地址。", "error");
        return false;
      }
      const hi = await global.WpsAiDocument?.getHostInfo?.();
      const host = hi?.host || currentHostInfo?.host || "wps";
      const target = materialToolForHost(host, url);
      if (!target) {
        showMessage("素材插入目前支持 WPS 文字、表格和演示。", "error");
        return false;
      }
      await prepareWpsDocumentWrite();
      try { global.WpsAiHistory?.startTurn?.("从素材库插入图片"); } catch (e) {}
      setBusy(true);
      const result = await global.WpsAiToolRegistry?.execute?.(target.toolName, target.args);
      if (result?.ok) {
        showMessage("图片已插入当前文档。", "success");
        closeMaterialLibraryModal();
        renderHistory();
        return true;
      } else {
        showMessage(result?.error || "插入失败。", "error");
      }
    } catch (e) {
      showMessage(e?.message || String(e), "error");
    } finally {
      setBusy(false);
      setMaterialInsertBusy(false);
    }
    return false;
  }

  async function modifyMaterialImage(item) {
    if (!els.chatInput) {
      showMessage("请在主面板执行单图修改。", "error");
      return;
    }
    const prompt = item.prompt || item.revisedPrompt || "";
    const previewUrl = await ensureMaterialPreview(item);
    if (previewUrl) {
      const attachment = {
        id: genAttachId(),
        kind: "image",
        name: materialFileName(item),
        mediaType: previewUrl.match(/^data:([^;]+);/)?.[1] || "image/png",
        dataUrl: previewUrl,
        size: 0,
        sourceMaterialId: item.id
      };
      pendingAttachments = pendingAttachments.filter((a) => a.sourceMaterialId !== item.id);
      pendingAttachments.push(attachment);
      renderAttachments();
    } else {
      showMessage("无法读取这张图片作为参考，已只回填修改指令。", "info");
    }
    const base = prompt ? `原图提示词：${prompt}\n` : "";
    els.chatInput.value = [
      "请基于我附加的这张参考图进行单图修改。",
      base + "修改要求：[在这里描述要修改的内容，比如：保持主体不变，换成蓝色科技风背景，增加柔和光影]",
      "",
      "完成后调用 generate_image 生成新图，并按当前宿主插入到文档中。"
    ].filter(Boolean).join("\n");
    closeMaterialLibraryModal();
    activateTab("ai");
    els.chatInput.focus();
    const start = els.chatInput.value.indexOf("[");
    const end = els.chatInput.value.indexOf("]");
    if (start >= 0 && end > start) els.chatInput.setSelectionRange(start + 1, end);
  }

  function writeMaterialDialogRequest(key, item) {
    try {
      const isInsertRequest = key === MATERIAL_DIALOG_INSERT_KEY;
      const ts = Date.now();
      localStorage.setItem(key, JSON.stringify({
        id: item.id,
        item: {
          id: item.id,
          url: item.url,
          dataUrl: item.dataUrl,
          sourceUrl: item.sourceUrl,
          prompt: item.prompt,
          revisedPrompt: item.revisedPrompt,
          size: item.size,
          resolution: item.resolution,
          model: item.model,
          providerType: item.providerType,
          groupId: item.groupId,
          tags: Array.isArray(item.tags) ? item.tags.slice() : [],
          project: item.project,
          source: item.source,
          kind: item.kind,
          title: item.title,
          text: item.text,
          ts: item.ts
        },
        ts,
        readyAt: ts + 700
      }));
      showMessage(isInsertRequest ? "正在交给主面板插入图片，请稍候…" : "已派给主面板执行。", "info");
      setTimeout(() => { try { if (typeof window.close === "function") window.close(); } catch (e) {} }, isInsertRequest ? 350 : 0);
      return true;
    } catch (e) {
      showMessage(`派发失败：${e?.message || e}`, "error");
      return false;
    }
  }

  async function insertSelectedMaterial() {
    const selected = getSelectedMaterials();
    if (selected.length !== 1) {
      showMessage(selected.length ? "一次只能插入一张素材。" : "请先选择一张素材。", "error");
      return;
    }
    if (isMaterialsDialog) {
      writeMaterialDialogRequest(MATERIAL_DIALOG_INSERT_KEY, selected[0]);
      return;
    }
    await insertMaterialIntoDocument(selected[0]);
  }

  async function modifySelectedMaterial() {
    const selected = getSelectedMaterials();
    if (selected.length !== 1) {
      showMessage(selected.length ? "一次只能修改一张素材。" : "请先选择一张素材。", "error");
      return;
    }
    if (isMaterialsDialog) {
      writeMaterialDialogRequest(MATERIAL_DIALOG_MODIFY_KEY, selected[0]);
      return;
    }
    await modifyMaterialImage(selected[0]);
  }

  async function copySelectedMaterialUrl() {
    const selected = getSelectedMaterials();
    if (selected.length !== 1) {
      showMessage("请先选择一张素材。", "error");
      return;
    }
    const ok = await copyToClipboard(materialDisplayUrl(selected[0]));
    showMessage(ok ? "图片地址已复制。" : "复制失败，请手动复制。", ok ? "success" : "error");
  }

  async function insertPreviewMaterial() {
    const item = getMaterialPreviewItem();
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      closeMaterialPreview();
      renderMaterialLibrary();
      return;
    }
    if (isMaterialsDialog) {
      writeMaterialDialogRequest(MATERIAL_DIALOG_INSERT_KEY, item);
      return;
    }
    const ok = await insertMaterialIntoDocument(item);
    if (ok) closeMaterialPreview();
  }

  async function copyPreviewMaterialUrl() {
    const item = getMaterialPreviewItem();
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      closeMaterialPreview();
      renderMaterialLibrary();
      return;
    }
    const ok = await copyToClipboard(materialDisplayUrl(item));
    showMessage(ok ? "图片地址已复制。" : "复制失败，请手动复制。", ok ? "success" : "error");
  }

  async function savePreviewMaterialAs() {
    const item = getMaterialPreviewItem();
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      closeMaterialPreview();
      renderMaterialLibrary();
      return;
    }
    if (!materialDisplayUrl(item)) {
      showMessage("当前素材没有可保存的图片。", "error");
      return;
    }
    const btn = els.materialPreviewSaveAsBtn;
    const oldText = btn?.textContent || "另存为";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "保存中...";
    }
    try {
      showMessage("正在准备图片并打开另存为窗口...", "info");
      const dataUrl = await getMaterialFullDataUrl(item);
      const resp = await fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/save-local-image-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataUrl,
          suggestedName: materialFileName(item)
        })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || `save-local-image-as ${resp.status}`);
      if (payload.cancelled) {
        showMessage("已取消保存。", "info");
        return;
      }
      showMessage(payload.path ? `图片已保存：${payload.path}` : "图片已保存。", "success");
    } catch (e) {
      showMessage("另存为失败：" + (e?.message || e), "error");
    } finally {
      if (btn) {
        btn.disabled = !materialDisplayUrl(getMaterialPreviewItem());
        btn.textContent = oldText;
      }
    }
  }

  function moveSelectedMaterials() {
    const lib = global.WpsAiMaterialLibrary;
    const ids = Array.from(selectedMaterialIds);
    if (!lib || !ids.length) {
      showMessage("请先选择素材。", "error");
      return;
    }
    const targetGroupId = els.materialMoveGroupSelect?.value || MATERIAL_DEFAULT_GROUP_ID;
    const moved = lib.moveEntries?.(ids, targetGroupId) || 0;
    selectedMaterialIds.clear();
    renderMaterialLibrary();
    showMessage(moved ? `已移动 ${moved} 张素材。` : "没有素材被移动。", moved ? "success" : "info");
  }

  function deleteSelectedMaterials() {
    const lib = global.WpsAiMaterialLibrary;
    const ids = Array.from(selectedMaterialIds);
    if (!lib || !ids.length) {
      showMessage("请先选择素材。", "error");
      return;
    }
    if (!confirm(i18nT("删除选中的 {n} 张素材？", { n: ids.length }))) return;
    ids.forEach((id) => lib.remove(id));
    selectedMaterialIds.clear();
    renderMaterialLibrary();
  }

  function createMaterialGroupFromInput() {
    const lib = global.WpsAiMaterialLibrary;
    const name = els.materialGroupNameInput?.value?.trim() || "";
    if (!lib || !name) {
      showMessage("请输入分组名称。", "error");
      return;
    }
    const group = lib.createGroup?.(name);
    if (!group) {
      showMessage("分组创建失败。", "error");
      return;
    }
    activeMaterialGroupId = group.id;
    if (els.materialGroupNameInput) els.materialGroupNameInput.value = "";
    selectedMaterialIds.clear();
    renderMaterialLibrary();
  }

  function resolveMaterialDialogItem(blob) {
    const lib = global.WpsAiMaterialLibrary;
    if (!blob) return null;
    const found = blob.id ? lib?.find?.(blob.id) : null;
    if (found) return found;
    if (blob.item && (blob.item.url || blob.item.dataUrl)) return blob.item;
    return null;
  }

  async function consumeMaterialDialogRequest(key, handler) {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(key) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let blob = null;
    try { blob = JSON.parse(raw); } catch (e) {}
    if (blob?.readyAt && Date.now() < Number(blob.readyAt)) return false;
    try { localStorage.removeItem(key); } catch (e) {}
    const item = resolveMaterialDialogItem(blob);
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      return false;
    }
    await prepareWpsDocumentWrite();
    await handler(item);
    return true;
  }

  async function consumeMaterialDialogRequests() {
    await consumeMaterialDialogRequest(MATERIAL_DIALOG_INSERT_KEY, insertMaterialIntoDocument);
    await consumeMaterialDialogRequest(MATERIAL_DIALOG_MODIFY_KEY, modifyMaterialImage);
  }

  function startMaterialDialogRequestPolling() {
    if (isAnyDialogWindow()) return;
    if (materialDialogPollTimer) clearInterval(materialDialogPollTimer);
    let ticks = 0;
    materialDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeMaterialDialogRequests();
      if (ticks >= 600) {
        clearInterval(materialDialogPollTimer);
        materialDialogPollTimer = null;
      }
    }, 500);
  }

  function bindMaterialLibrary() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib) return;
    if (materialLibraryBound) return;
    materialLibraryBound = true;
    lib.subscribe(() => {
      if (!els.materialLibraryModal?.classList.contains("hidden")) renderMaterialLibrary();
    });
    els.materialLibraryCloseBtn?.addEventListener("click", closeMaterialLibraryModal);
    els.materialImportBtn?.addEventListener("click", () => els.materialImportInput?.click());
    els.materialImportInput?.addEventListener("change", (ev) => {
      const files = Array.from(ev.target?.files || []);
      ev.target.value = ""; // 允许重复选同一文件
      importLocalImages(files);
    });
    els.materialLibraryRefreshBtn?.addEventListener("click", renderMaterialLibrary);
    els.materialSearchInput?.addEventListener("input", () => {
      materialSearchText = els.materialSearchInput.value || "";
      renderMaterialLibrary();
    });
    els.materialProjectFilter?.addEventListener("change", () => {
      materialProjectFilterValue = els.materialProjectFilter.value || "";
      renderMaterialLibrary();
    });
    els.materialLibraryClearBtn?.addEventListener("click", () => {
      if (!lib.list().length) return;
      if (!confirm(i18nT("清空全部生图素材历史？"))) return;
      lib.clear();
      selectedMaterialIds.clear();
      renderMaterialLibrary();
    });
    els.materialGroupAddBtn?.addEventListener("click", createMaterialGroupFromInput);
    els.materialGroupNameInput?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      createMaterialGroupFromInput();
    });
    els.materialMoveBtn?.addEventListener("click", moveSelectedMaterials);
    els.materialInsertBtn?.addEventListener("click", insertSelectedMaterial);
    els.materialModifyBtn?.addEventListener("click", modifySelectedMaterial);
    els.materialCopyBtn?.addEventListener("click", copySelectedMaterialUrl);
    els.materialDeleteBtn?.addEventListener("click", deleteSelectedMaterials);
    els.materialPreviewCloseBtn?.addEventListener("click", closeMaterialPreview);
    els.materialPreviewInsertBtn?.addEventListener("click", insertPreviewMaterial);
    els.materialPreviewSaveAsBtn?.addEventListener("click", savePreviewMaterialAs);
    els.materialPreviewCopyBtn?.addEventListener("click", copyPreviewMaterialUrl);
    els.materialPreviewCropBtn?.addEventListener("click", enterCropMode);
    els.materialCropSaveBtn?.addEventListener("click", cropAndSaveMaterial);
    els.materialCropCancelBtn?.addEventListener("click", exitCropMode);
    els.materialCutoutBtn?.addEventListener("click", cutoutCurrentMaterial);
    els.materialLocalCutoutBtn?.addEventListener("click", localCutoutCurrentMaterial);
    els.materialEditCancelBtn?.addEventListener("click", () => { if (_imgEditAbort) { try { _imgEditAbort.abort(); } catch (e) {} } });
    els.materialBrushEditBtn?.addEventListener("click", enterBrushMode);
    els.materialBrushCancelBtn?.addEventListener("click", exitBrushMode);
    els.materialBrushClearBtn?.addEventListener("click", clearBrush);
    els.materialBrushInpaintBtn?.addEventListener("click", applyBrushInpaint);
    els.materialBrushCutoutBtn?.addEventListener("click", aiBrushCutout);
    els.materialCutoutChoiceCloseBtn?.addEventListener("click", closeMaterialCutoutChoice);
    els.materialCutoutAllBtn?.addEventListener("click", () => runBrushCutoutWithoutSelection("all"));
    els.materialCutoutDescribeBtn?.addEventListener("click", () => runBrushCutoutWithoutSelection("describe"));
    els.materialCutoutDescribeInput?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || (!ev.metaKey && !ev.ctrlKey)) return;
      ev.preventDefault();
      runBrushCutoutWithoutSelection("describe");
    });
    bindMaterialCrop();
    bindMaterialBrush();
    els.materialLibraryModal?.addEventListener("click", (ev) => {
      if (ev.target === els.materialLibraryModal) closeMaterialLibraryModal();
    });
    els.materialPreviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.materialPreviewModal) closeMaterialPreview();
    });
    els.materialCutoutChoiceModal?.addEventListener("click", (ev) => {
      if (ev.target === els.materialCutoutChoiceModal) closeMaterialCutoutChoice();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (els.materialCutoutChoiceModal && !els.materialCutoutChoiceModal.classList.contains("hidden")) {
        closeMaterialCutoutChoice();
        return;
      }
      if (els.materialPreviewModal && !els.materialPreviewModal.classList.contains("hidden")) {
        closeMaterialPreview();
        return;
      }
      if (els.materialLibraryModal && !els.materialLibraryModal.classList.contains("hidden")) {
        closeMaterialLibraryModal();
      }
    });
  }

  // ---------------- 纯净模式（隐藏工具调用 / reasoning，只看 AI 对话）----------------

  const PURE_MODE_KEY = "lingxi_pure_mode";

  const EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  function applyPureMode(on) {
    document.body.classList.toggle("pure-mode", !!on);
    if (els.pureModeToggle) {
      els.pureModeToggle.classList.toggle("active", !!on);
      const icon = els.pureModeToggle.querySelector(".pure-icon");
      if (icon) {
        icon.dataset.mode = on ? "on" : "off";
        icon.innerHTML = on ? EYE_OFF_SVG : EYE_OPEN_SVG;
      }
      els.pureModeToggle.title = on
        ? "当前为纯净模式：已隐藏工具调用与推理过程。点击切回完整视图。"
        : "纯净模式：隐藏工具调用与推理过程";
    }
  }

  function bindPureMode() {
    if (!els.pureModeToggle) return;
    let on = false;
    try { on = global.WpsAiStore.getItem(PURE_MODE_KEY) === "1"; } catch (e) {}
    applyPureMode(on);

    els.pureModeToggle.addEventListener("click", () => {
      const next = !document.body.classList.contains("pure-mode");
      applyPureMode(next);
      try { global.WpsAiStore.setItem(PURE_MODE_KEY, next ? "1" : "0"); } catch (e) {}
    });
  }

  function bindForceUnlock() {
    if (!els.forceUnlockBtn) return;
    updateForceUnlockVisibility();
    els.forceUnlockBtn.addEventListener("click", () => {
      try { unlockHostDocument(); } catch (e) {}
      let res = null;
      try { res = global.WpsAiLock?.forceUnlock?.(); } catch (e) {}
      updateForceUnlockVisibility();
      const cleared = res && (res.word || res.sheet || res.interactive || res.hadLock);
      if (cleared) {
        const parts = [];
        if (res.word) parts.push("Word 保护");
        if (res.sheet) parts.push("表格保护");
        if (res.interactive) parts.push("交互锁");
        if (!parts.length && res.hadLock) parts.push("内存锁定状态");
        showMessage(`已解除：${parts.join(" / ")}。`, "success");
      } else {
        showMessage("当前没有检测到 AI 残留锁定。如果 WPS 仍提示编辑受限，可能是用户自己设置的密码保护。", "info");
      }
    });
  }

  // ---------------- 多对话管理 ----------------

  // 渲染单条历史消息为简洁文本气泡（不还原工具调用）—— 退路用，没有事件流时使用
  function appendSimpleMessage(role, content) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    appendChatMsg(role, text, { label: role === "user" ? "我" : "AI" });
  }

  // ---- 历史回放：按轮聚合喂给时间轴，和 handleStreamEvent 的实时产出结构对齐 ----
  // user 事件/块起一轮；之后的 reasoning/tool_call/tool_result/assistant/error 攒进 _histTurnBuf，
  // 下一个 user 出现（或整段回放结束）时一次性 buildTurnSteps→renderAssistantTurn。
  // 这样回放和实时（beginAssistantTurn 增量句柄）落到同一个 buildTurnItems（文本块 / run 摘要 / 错误块的
  // 有序交织），文本块与工具/思考 run 按事件顺序穿插，DOM 结构逐字节一致。
  let _histTurnBuf = [];
  let _histTurnMeta = null; // 取本轮最后一条带 model/elapsedMs 的 assistant 事件，渲染成 .tl-meta

  function resetHistoryTurnBuffer() {
    _histTurnBuf = [];
    _histTurnMeta = null;
  }

  // generate_image / todo_replace_all / todo_patch 各有专用面板（imageGenPanel / renderTodoPanel），
  // 实时时间轴不给它们建步骤（见 handleStreamEvent 的 tool_call 分支）；回放同样跳过，避免和当初看到的不一致。
  const HISTORY_HIDDEN_TOOL_NAMES = new Set(["generate_image", "todo_replace_all", "todo_patch"]);

  // 短模型名角标算法，和 live 的 metaModel（runChatTurn 里）保持一致——
  // 存历史时 model 是完整供应商前缀名，回放渲染前统一剥掉。
  function shortModelNameForHistory(model) {
    return String(model || "").trim().replace(/^[a-z]+\//, "").slice(0, 24) || "AI";
  }

  function pushHistoryTurnEvent(ev, meta) {
    _histTurnBuf.push(ev);
    if (meta && (meta.model || Number.isFinite(meta.elapsedMs))) _histTurnMeta = meta;
  }

  // assistant 文本入队前先按 <think> 拆分（存量历史里部分开源思考模型把思考内联进正文，
  // 没走独立 reasoning 事件）。已有独立 reasoning 事件时不重复补——和 live 的
  // assistant_chunk 流式拆分语义对齐（assistant_text_end 不重复拆，因为流式过程里已经把
  // <think> 段拆进思考步骤了）。
  function pushHistoryAssistantEvent(text, meta) {
    const { visible, think } = splitVisibleAndThinking(text || "");
    const hasReasoningAlready = _histTurnBuf.some((e) => e && e.type === "reasoning");
    if (think && !hasReasoningAlready) pushHistoryTurnEvent({ type: "reasoning", text: think });
    pushHistoryTurnEvent({ type: "assistant", text: visible }, meta);
  }

  // 把攒好的一轮渲染成一个 .tl-msg.tl-assistant（buildTurnSteps + renderAssistantTurn，批量路径）。
  function flushHistoryTurn() {
    if (_histTurnBuf.length === 0) { _histTurnMeta = null; return; }
    const steps = global.WpsAiChatTimeline.buildTurnSteps(_histTurnBuf);
    const meta = _histTurnMeta
      ? { model: shortModelNameForHistory(_histTurnMeta.model), elapsedMs: _histTurnMeta.elapsedMs }
      : null;
    resetHistoryTurnBuffer();
    if (steps.length === 0) return;
    // 「显示工具调用详情」开启时，回放的工具步骤也默认展开——与 live 那边 tool_call/tool_result
    // 到达时调 turn.expandToolStep(ref) 保持一致（见 handleStreamEvent 里的两处调用）。
    const node = global.WpsAiChatTimeline.renderAssistantTurn({ steps, meta, expandTools: !!currentSettings.showToolCallLogs });
    if (els.chatStream) els.chatStream.appendChild(node);
  }

  // 一条 user 事件/块 → 落一条 .tl-msg.tl-user（先把上一轮攒的 AI 步骤 flush 出去）；
  // 快捷指令折叠成可展开操作盒子，旧记录按固定提示词反查。
  function appendHistoryUserTurn(text, quickActionMeta, attachments) {
    flushHistoryTurn();
    const qaLabel = inferQuickActionLabel(quickActionMeta, text);
    const node = global.WpsAiChatTimeline.renderUserMessage(
      qaLabel ? { text: text || "", quickAction: { label: qaLabel, prompt: text || "" } } : { text: text || "" }
    );
    if (els.chatStream) els.chatStream.appendChild(node);
    if (attachments && attachments.length) appendUserAttachmentsPreview(attachments);
  }

  function appendHistoryEvent(ev) {
    if (!ev) return;
    switch (ev.type) {
      case "user":
        appendHistoryUserTurn(ev.text, ev.quickAction, ev.attachments);
        break;
      case "reasoning":
        pushHistoryTurnEvent({ type: "reasoning", text: ev.text || "" });
        break;
      case "tool_call":
        if (!HISTORY_HIDDEN_TOOL_NAMES.has(ev.name)) {
          pushHistoryTurnEvent({ type: "tool_call", name: ev.name, args: ev.args });
        }
        break;
      case "tool_result":
        if (!HISTORY_HIDDEN_TOOL_NAMES.has(ev.name)) {
          pushHistoryTurnEvent({ type: "tool_result", name: ev.name, result: ev.result || { ok: false, error: "结果丢失" } });
        }
        break;
      case "assistant":
        pushHistoryAssistantEvent(ev.text || "", { model: ev.model, elapsedMs: ev.elapsedMs });
        break;
    }
  }

  function appendHistoryBlock(block) {
    if (!block) return;
    switch (block.kind) {
      case "text": {
        const role = block.role || "assistant";
        if (role === "user") {
          appendHistoryUserTurn(block.text, block.quickAction, block.attachments);
        } else {
          pushHistoryAssistantEvent(block.text || "", { model: block.model, elapsedMs: block.elapsedMs });
        }
        break;
      }
      case "reasoning":
        pushHistoryTurnEvent({ type: "reasoning", text: block.text || "" });
        break;
      case "tool-call":
        if (!HISTORY_HIDDEN_TOOL_NAMES.has(block.name)) {
          pushHistoryTurnEvent({ type: "tool_call", name: block.name, args: block.args });
        }
        break;
      case "tool-result":
        if (!HISTORY_HIDDEN_TOOL_NAMES.has(block.name)) {
          pushHistoryTurnEvent({ type: "tool_result", name: block.name, result: block.result || { ok: false, error: "结果丢失" } });
        }
        break;
      case "error": {
        const msg = block.error?.message || block.text || "Unknown error";
        pushHistoryTurnEvent({ type: "error", text: `错误：${msg}` });
        break;
      }
      case "status":
        if (block.text) appendChatMsg("assistant", block.text, { label: "AI" });
        break;
      case "source":
      case "file":
      default:
        break;
    }
  }

  function pinChatSessionStats() {
    const stats = els.chatSessionStats;
    const streamWrap = els.chatStream?.closest(".chat-stream-wrap");
    if (stats && streamWrap && stats.parentElement !== streamWrap) {
      stats.classList.add("chat-session-stats-sticky");
      streamWrap.insertBefore(stats, els.chatStream);
    }
  }

  function rebuildChatStreamFromHistory() {
    if (!els.chatStream) return;
    pinChatSessionStats();
    els.chatStream.innerHTML = "";
    resetHistoryTurnBuffer();
    if (els.chatPending) els.chatPending.classList.add("hidden");
    hideSuggestedActions?.();

    // 优先用事件流重放（完整应答过程）；没有则退到只用 messages
    const conv = global.WpsAiConversations?.getCurrent?.();
    const eventsV2 = conv?.eventsV2;
    const events = conv?.events;
    if (Array.isArray(eventsV2) && eventsV2.length > 0 && global.WpsAiChatBlocks?.fromEvents) {
      global.WpsAiChatBlocks.fromEvents(eventsV2).forEach(appendHistoryBlock);
      flushHistoryTurn(); // 收尾：最后一轮 AI 步骤没有被下一个 user 触发 flush，这里补上
    } else if (Array.isArray(events) && events.length > 0) {
      events.forEach(appendHistoryEvent);
      flushHistoryTurn();
    } else {
      // 没有事件流（旧对话，或 events 尚未落盘/加载）：仍走时间轴渲染，保证用户消息靠右、AI 按 markdown
      // 渲染——不再退到裸文本气泡（appendSimpleMessage：无 markdown、不靠右，即用户看到的「错乱」）。
      // 只是没有工具/思考步骤，纯文本仍正确呈现。
      chatHistory.forEach((m) => appendHistoryEvent({
        type: m.role === "user" ? "user" : "assistant",
        text: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      }));
      flushHistoryTurn();
    }
    renderTodoPanel();
  }

  function startNewConversation({ silent } = {}) {
    // P2-4：归档前从当前对话抽一条跨对话记忆（复用压缩摘要，失败不阻塞）
    try { global.WpsAiChatMemory?.captureFromConversation?.(global.WpsAiConversations?.getCurrent?.()); } catch (e) {}
    // 当前对话已经自动 sync 过了；这里只需要清状态 + 开新的
    chatHistory.length = 0;
    if (els.chatStream) els.chatStream.innerHTML = "";
    if (els.chatPending) els.chatPending.classList.add("hidden");
    hideSuggestedActions?.();
    resetSkillSuggest();
    resetSessionStats();
    // 新对话绑定到当前活动文档；切到别的文件就会自动隐藏
    try { global.WpsAiConversations?.createNew?.({ docKey: getCurrentDocKey() }); } catch (e) {}
    renderTodoPanel();
    if (!silent) showMessage("已开始新对话。", "info");
  }

  function switchToConversation(id) {
    const conv = global.WpsAiConversations?.listConversations?.().find((c) => c.id === id);
    if (!conv) return;
    // 把当前的先保存（即使没改也无所谓，syncMessages 会更新 updatedAt）
    try { global.WpsAiConversations.syncMessages(chatHistory); } catch (e) {}
    // 切换并加载（loadAsActive 现在返回 { messages, events }）
    const loaded = global.WpsAiConversations.loadAsActive(id);
    if (!loaded) return;
    const messages = loaded.messages || (Array.isArray(loaded) ? loaded : []);
    chatHistory.length = 0;
    messages.forEach((m) => chatHistory.push({ role: m.role, content: m.content }));
    resetSkillSuggest();
    rebuildChatStreamFromHistory();
    closeConversationsMenu();
    showMessage(`已切换到对话「${conv.title}」`, "info");
  }

  function deleteConversation(id) {
    const conv = global.WpsAiConversations?.listConversations?.().find((c) => c.id === id);
    if (!conv) return;
    if (!confirm(i18nT("确认删除对话「{title}」？此操作不可撤销。", { title: conv.title }))) return;
    const isCurrent = global.WpsAiConversations.getCurrentId?.() === id;
    global.WpsAiConversations.deleteById(id);
    if (isCurrent) {
      // 当前被删了：清屏开新对话
      chatHistory.length = 0;
      if (els.chatStream) els.chatStream.innerHTML = "";
      renderTodoPanel();
    }
    // 不主动关闭菜单，方便连续删
  }

  function escapeHtmlSafe(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderConversationsMenu() {
    if (!els.conversationsMenuList) return;
    // 按当前打开的文件过滤；切到别的文件 / 没打开文件就只显示对应那组对话。
    // 独立历史窗口（isConversationsDialog）拿不到当前文档，docKey 从 URL 的 ?dk= 传入。
    const docKey = isConversationsDialog ? conversationsDialogDocKey() : getCurrentDocKey();
    // legacyDocKey：docKey 是新式 "id:<uuid>" 时把之前按裸路径存的老对话一并算命中并升级
    const legacyDocKey = (!isConversationsDialog && docKey.startsWith("id:")) ? (global.WpsAiBackup?.getCurrentDocPath?.() || "") : "";
    const list = global.WpsAiConversations?.listConversations?.({ docKey, legacyDocKey }) || [];
    const currentId = global.WpsAiConversations?.getCurrentId?.();
    els.conversationsMenuList.innerHTML = "";
    if (list.length === 0) {
      if (els.conversationsMenuEmpty) els.conversationsMenuEmpty.classList.remove("hidden");
      return;
    }
    if (els.conversationsMenuEmpty) els.conversationsMenuEmpty.classList.add("hidden");

    // 按 updatedAt 分三组：今天 / 7 天内 / 7 天前
    const now = Date.now();
    const todayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const sevenAgo = now - 7 * 24 * 3600 * 1000;
    const groups = [
      { label: "今天", items: [] },
      { label: "7 天内", items: [] },
      { label: "7 天前", items: [] }
    ];
    list.forEach((c) => {
      const t = Number(c.updatedAt) || 0;
      if (t >= todayStart) groups[0].items.push(c);
      else if (t >= sevenAgo) groups[1].items.push(c);
      else groups[2].items.push(c);
    });

    const renderItem = (c) => {
      const item = document.createElement("div");
      item.className = "conversation-item" + (c.id === currentId ? " active" : "");
      item.dataset.id = c.id;
      const count = (c.messages || []).filter((m) => m.role === "user").length;
      const time = c.updatedAt ? fmtTime(c.updatedAt) : "";
      item.innerHTML = `
        <div class="conversation-item-main">
          <div class="conversation-item-title">${escapeHtmlSafe(c.title || "新对话")}</div>
          <div class="conversation-item-meta">${count} 轮 · ${escapeHtmlSafe(time)}</div>
        </div>
        <button type="button" class="conversation-item-delete icon-btn" title="删除此对话">×</button>
      `;
      item.querySelector(".conversation-item-main").addEventListener("click", () => {
        // 独立历史窗口：写请求给主窗口加载并关窗；面板内：直接切换
        if (isConversationsDialog) writeConversationsDialogRequest(c.id);
        else switchToConversation(c.id);
      });
      item.querySelector(".conversation-item-delete").addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteConversation(c.id);
        if (isConversationsDialog) renderConversationsMenu(); // 独立窗口无 subscribe，删后手动刷新
      });
      return item;
    };

    groups.forEach((g) => {
      if (!g.items.length) return;
      const head = document.createElement("div");
      head.className = "conversation-group-head";
      head.textContent = g.label;
      els.conversationsMenuList.appendChild(head);
      g.items.forEach((c) => els.conversationsMenuList.appendChild(renderItem(c)));
    });
  }

  function conversationsDialogDocKey() {
    try { const m = /[?&]dk=([^&]*)/.exec(window.location.search); if (m) return decodeURIComponent(m[1]); } catch (e) {}
    return "";
  }

  // 独立历史窗口选中某对话 → 写请求 + 关窗；主窗口负责加载
  function writeConversationsDialogRequest(id) {
    try { localStorage.setItem(CONVERSATIONS_DIALOG_REQUEST_KEY, JSON.stringify({ id: id, ts: Date.now() })); } catch (e) {}
    try { if (typeof window.close === "function") window.close(); } catch (e) {}
  }

  // 主窗口消费独立历史窗口写来的"加载某对话"请求（阻塞式 ShowDialog 关闭后同步调 + storage 事件都会走这里）
  function consumeConversationsDialogRequest() {
    try {
      const raw = localStorage.getItem(CONVERSATIONS_DIALOG_REQUEST_KEY);
      if (!raw) return;
      localStorage.removeItem(CONVERSATIONS_DIALOG_REQUEST_KEY);
      const req = JSON.parse(raw);
      if (req && req.id) switchToConversation(req.id);
    } catch (e) {}
  }

  // 优先用 ShowDialog 开独立系统窗口（脱离面板、浮在文档上）；无 ShowDialog 退回面板内居中弹窗
  function openConversationsAsDialog() {
    try {
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        const base = global.WpsAiAddon?.getUrlPath?.() || "";
        const url = `${base}/taskpane.html?mode=conversations&dk=${encodeURIComponent(getCurrentDocKey())}`;
        const { w, h } = pickDialogSize(460, 640, { minW: 360, minH: 420 });
        app.ShowDialog(url, i18nDialogTitle("历史对话"), w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        consumeConversationsDialogRequest(); // 阻塞式 ShowDialog：关闭后同步读取选择
        return true;
      }
    } catch (e) {
      console.warn("[conversations] ShowDialog 失败，回退 inline modal:", e?.message || e);
    }
    return false;
  }

  function openConversationsMenu() {
    if (openConversationsAsDialog()) return;
    renderConversationsMenu();
    els.conversationsMenu?.classList.remove("hidden");
  }

  function closeConversationsMenu() {
    els.conversationsMenu?.classList.add("hidden");
  }

  function bindConversations() {
    if (els.newConversationBtn) {
      els.newConversationBtn.addEventListener("click", () => startNewConversation());
    }
    if (els.conversationsMenuBtn) {
      els.conversationsMenuBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (els.conversationsMenu?.classList.contains("hidden")) openConversationsMenu();
        else closeConversationsMenu();
      });
    }
    if (els.conversationsMenuClose) {
      els.conversationsMenuClose.addEventListener("click", closeConversationsMenu);
    }
    // 独立弹窗：点遮罩背景关闭（点卡片内不关）
    if (els.conversationsMenu) {
      els.conversationsMenu.addEventListener("click", (ev) => {
        if (ev.target === els.conversationsMenu) closeConversationsMenu();
      });
    }
    // 订阅 conversations 变化以刷新菜单
    global.WpsAiConversations?.subscribe?.(() => {
      renderTodoPanel();
      if (els.conversationsMenu && !els.conversationsMenu.classList.contains("hidden")) {
        renderConversationsMenu();
      }
    });

    // 首次进入：current 对话必须跟当前文档匹配才灌进 chatHistory，否则当成新会话
    try {
      const docKey = getCurrentDocKey();
      const legacyDocKey = docKey.startsWith("id:") ? (global.WpsAiBackup?.getCurrentDocPath?.() || "") : "";
      const current = global.WpsAiConversations?.getCurrentForDoc?.(docKey, legacyDocKey);
      if (current && current.messages && current.messages.length > 0) {
        current.messages.forEach((m) => chatHistory.push({ role: m.role, content: m.content }));
        rebuildChatStreamFromHistory();
      } else {
        // currentId 指向不属于当前文件的旧对话 → 清掉，让下次发消息走 lazy createNew
        try { global.WpsAiConversations?.clearCurrent?.(); } catch (e) {}
        renderTodoPanel();
      }
    } catch (e) {}

    // 启动文档切换监听：每 1.5s 探一次活动文档；变了就保存旧对话 + 开新空会话
    startDocWatcher((newKey, oldKey) => {
      try { global.WpsAiConversations?.syncMessages?.(chatHistory); } catch (e) {}
      // P2-4：切文档归档旧对话时抽记忆
      try { global.WpsAiChatMemory?.captureFromConversation?.(global.WpsAiConversations?.getCurrent?.()); } catch (e) {}
      chatHistory.length = 0;
      if (els.chatStream) els.chatStream.innerHTML = "";
      if (els.chatPending) els.chatPending.classList.add("hidden");
      hideSuggestedActions?.();
      // 新文件 → 看有没有它的现存对话，有就加载、没有就空着等用户发消息时再 createNew
      const conv = global.WpsAiConversations?.getCurrentForDoc?.(newKey);
      if (conv && conv.messages && conv.messages.length > 0) {
        conv.messages.forEach((m) => chatHistory.push({ role: m.role, content: m.content }));
        rebuildChatStreamFromHistory();
      } else {
        // 不主动 createNew —— 等用户真发消息时 syncMessages 触发 lazy 创建（带新 docKey）
        // 这样切到没用过的文件就是真正"全空"，不留空壳对话
        try { global.WpsAiConversations?.clearCurrent?.(); } catch (e) {}
        renderTodoPanel();
      }
      // 通知 UI 刷新历史 / 改动记录角标（这俩本就按 docKey 过滤）
      try { renderConversationsMenu(); } catch (e) {}
      try { renderHistory?.(); } catch (e) {}
      // HTML 模板历史 / 组件库也跟着新文件
      try {
        if (els.htmlPreviewModal && !els.htmlPreviewModal.classList.contains("hidden")) {
          renderHtmlTemplateGallery?.(); updateHtmlPreviewHistoryBadge?.();
        }
      } catch (e) {}
      const fname = newKey ? newKey.split(/[/\\]/).pop() : "新文档（未保存）";
      showMessage(`已切到「${fname}」的会话`, "info");
    });
  }

  // ---------------- Bindings ----------------

  // ShowDialog 原生窗口标题（OS 标题栏）按界面语言拼装。
  // DOM 内的标题有自动翻译兜着，但 ShowDialog 的标题是传给 WPS 的裸字符串，必须在这里翻。
  // 原生 confirm/alert 的文案翻译（原生对话框不是 DOM，自动翻译够不着，必须源头 t()）
  function i18nT(s, params) {
    try {
      const r = global.WpsAiI18n?.t?.(s, params);
      return r == null ? s : r;
    } catch (e) { return s; }
  }

  function i18nDialogTitle(suffix) {
    try {
      const I = global.WpsAiI18n;
      if (I?.resolvedLang?.() === "en") {
        const translated = I.t(suffix);
        if (translated !== suffix) return "Wenxiaozhou · " + translated;
        // 组合后缀（如「更正式预览」「快速润色预览」）：整词没命中时拆掉「预览」再翻
        const m = /^(.+)预览$/.exec(suffix);
        if (m) return "Wenxiaozhou · " + (I.t(m[1]) || m[1]) + " Preview";
        return "Wenxiaozhou · " + suffix;
      }
    } catch (e) {}
    return "文小舟 " + suffix;
  }

  // 界面语言下拉：主面板 bindEvents 和设置 dialog 分支都要绑（设置实际通过 ?mode=settings
  // 独立窗口打开，只绑主面板会导致弹窗里选了没反应——同「+ 新增图像渠道漏绑」的坑）。
  // 切换即热生效：WpsAiI18n.setPref 内部会热套用当前窗口，其它窗口靠 storage 事件同步。
  function bindUiLanguageControl() {
    const sel = els.uiLanguageSelect;
    if (!sel || sel.dataset.langBound === "1") return;
    sel.dataset.langBound = "1";
    try { sel.value = global.WpsAiI18n?.getPref?.() || "auto"; } catch (e) {}
    sel.addEventListener("change", () => {
      try { global.WpsAiI18n?.setPref?.(sel.value); } catch (e) {}
      // 双写进设置 JSON（最可靠的持久化通道，boot 时以它为权威对账）
      try {
        currentSettings.uiLanguage = (sel.value === "zh" || sel.value === "en") ? sel.value : "auto";
        persistSettings();
      } catch (e) {}
      // ribbon 按钮是 WPS 原生控件、label 在 ribbon.xml 里按语言分两份，重启才会重新加载
      try {
        const t = global.WpsAiI18n?.t || ((s) => s);
        showMessage(t("界面语言已切换；Ribbon 按钮文字将在重启 WPS 后切换。"), "info", { duration: 6000 });
      } catch (e) {}
    });
    // 其它窗口切了语言 / 启动对账恢复偏好时，同步下拉显示值
    window.addEventListener("lingxi-lang-changed", (ev) => {
      const p = ev?.detail?.pref;
      if (p && sel.value !== p) sel.value = p;
    });
  }

  function bindRibbonPositionControl() {
    const sel = els.ribbonPositionSelect;
    if (!sel || sel.dataset.positionBound === "1") return;
    sel.dataset.positionBound = "1";
    const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
    const t = (s) => global.WpsAiI18n?.t?.(s) || s;
    fetch(base + "/ribbon-position").then((res) => {
      if (!res.ok) throw new Error("load failed");
      return res.json();
    }).then((data) => {
      sel.value = data.position;
      sel.disabled = false;
    }).catch(() => showMessage(t("无法读取 Ribbon 入口位置，请检查本地服务。"), "error"));
    sel.addEventListener("change", async () => {
      sel.disabled = true;
      try {
        const res = await fetch(base + "/ribbon-position", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: sel.value })
        });
        if (!res.ok) throw new Error("save failed");
        const data = await res.json();
        sel.value = data.position;
        showMessage(t("Ribbon 入口位置已保存，重启 WPS 后生效。"), "info", { duration: 6000 });
        sel.disabled = false;
      } catch (e) {
        showMessage(t("保存 Ribbon 入口位置失败，请检查本地服务并重新打开设置。"), "error");
      }
    });
  }

  function bindEvents() {
    els.providerSelect.addEventListener("change", refreshProviderConfigVisibility);
    els.operationModeSelect.addEventListener("change", () => renderProviderState());
    bindUiLanguageControl();
    bindRibbonPositionControl();
    // 语言热切换后重算 JS 拼接的组合文案（宿主标题/模式提示等自动翻译够不着的）
    window.addEventListener("lingxi-lang-changed", () => {
      try { renderQuickActions(); } catch (e) {}
    });

    els.signInBtn.addEventListener("click", async () => {
      setBusy(true);
      try {
        const url = await global.WpsAiAuth.startLogin();
        showMessage(`已尝试打开授权页。若未弹出，请复制以下链接到浏览器：${url}`, "info");
      } catch (error) {
        showMessage(error.message || String(error), "error");
      } finally { setBusy(false); }
    });

    els.exchangeCodeBtn.addEventListener("click", async () => {
      setBusy(true);
      try {
        await global.WpsAiAuth.exchangeCode(els.authCodeInput.value);
        els.authCodeInput.value = "";
        refreshCodexAuthArea();
        renderProviderState();
        showMessage("登录成功。", "success");
      } catch (error) {
        showMessage(error.message || String(error), "error");
      } finally { setBusy(false); }
    });

    els.signOutBtn.addEventListener("click", () => {
      global.WpsAiAuth.clearAuth();
      refreshCodexAuthArea();
      renderProviderState();
      showMessage("已退出登录。", "info");
    });

    els.saveSettingsBtn.addEventListener("click", saveSettings);
    // 「保存」按钮：只保存不关闭，方便用户配完一个 provider 接着配下一个不被打断
    els.saveSettingsOnlyBtn?.addEventListener("click", saveSettings);

    // 设置 toggle 类 checkbox 自动持久化 —— 之前要点「保存」才生效，用户勾了直接关窗就丢了，
    // 现在 change 立即写 localStorage。presentation.js 用 loadSettings() 读到的就是最新值。
    const autoPersistCheckboxes = [
      "splitLayersOnInsertInput",
      "showToolCallLogsInput",
      "aiFollowHighlightInput",
      "mcpServerEnabledInput",
      "updateAutoCheckInput"
    ];
    autoPersistCheckboxes.forEach((id) => {
      const el = els[id];
      if (!el) return;
      el.addEventListener("change", () => {
        try { readSettingsFromForm(); persistSettings(); } catch (e) {}
      });
    });
    if (els.systemPromptResetBtn) {
      els.systemPromptResetBtn.addEventListener("click", () => {
        const def = global.WpsAiProviderRegistry?.DEFAULT_SYSTEM_PROMPT || "";
        if (!def) return;
        if (els.systemPromptInput.value.trim() && !confirm(i18nT("覆盖当前提示词为默认？"))) return;
        els.systemPromptInput.value = def;
        showMessage("已恢复为默认系统提示词，记得点保存。", "info");
      });
    }
    els.testChatConnBtn.addEventListener("click", testChatConnection);
    if (els.addImageProviderBtn) {
      els.addImageProviderBtn.addEventListener("click", addImageProvider);
    }
    els.refreshModelsBtn.addEventListener("click", refreshModels);

    els.exportSettingsBtn.addEventListener("click", exportSettings);
    els.importSettingsBtn.addEventListener("click", () => els.importSettingsFile.click());
    els.importSettingsFile.addEventListener("change", (ev) => {
      const file = ev.target.files?.[0];
      if (file) importSettings(file);
      ev.target.value = ""; // 允许同名文件重选
    });

    // 开发者工具区：只在 dev 模式可见。dev 模式 = URL 是 127.0.0.1 / localhost / wpsjs debug 端口（3889）
    setupDevToolsSection();

    // 设置入口走 Tab Bar 上的「设置」tab，header 不再单独放 ⚙ 按钮

    els.chatSendBtn.addEventListener("click", async () => {
      const text = els.chatInput.value.trim();
      if (!text) return;
      els.chatInput.value = "";
      // 临时模型：override 存在时把 activeChatModel 临时替换本轮用，发送后自动清 override
      // 复原原值，避免"临时"变成"永久"。
      const savedActive = currentSettings.activeChatModel;
      const usingOverride = _perTurnModelOverride && global.WpsAiProviderRegistry?.encodeActiveChatModel;
      if (usingOverride) {
        currentSettings.activeChatModel = global.WpsAiProviderRegistry.encodeActiveChatModel(
          _perTurnModelOverride.providerId,
          _perTurnModelOverride.modelId
        );
      }
      try {
        await runChatTurn(text);
      } finally {
        if (usingOverride) {
          currentSettings.activeChatModel = savedActive;
          clearPerTurnModelOverride();
        }
      }
    });
    installChatInputContextMenu(els.chatInput);
    // 技能沉淀提示：「总结成技能」→ 直接让 AI 用 save_skill 沉淀本轮操作；「关闭」→ 本对话不再提示
    if (els.skillSuggestBtn) {
      els.skillSuggestBtn.addEventListener("click", () => {
        if (chatBusy) return;
        _skillSuggest.dismissed = true;
        if (els.skillSuggestBar) els.skillSuggestBar.classList.add("hidden");
        runChatTurn("把我们刚才这轮对话里做的操作总结成一个可复用的文小舟技能：起一个简洁的技能名，写清楚适用场景（description，便于以后判断何时套用），再把关键步骤 / 要点 / 坑整理成 content，用 save_skill 保存。只根据对话历史里已经做过的操作来总结：不要重新执行任何工具，不要改动当前文档或表格（尤其不要重跑写入 / 格式 / 边框等修改类操作），这一轮只调用 save_skill 一个工具。", { skillSummary: true });
      });
    }
    if (els.skillSuggestDismissBtn) {
      els.skillSuggestDismissBtn.addEventListener("click", () => {
        _skillSuggest.dismissed = true;
        if (els.skillSuggestBar) els.skillSuggestBar.classList.add("hidden");
      });
    }
    els.chatStopBtn.addEventListener("click", stopChat);
    els.chatInput.addEventListener("keydown", (ev) => {
      // Enter 发送，Shift+Enter 换行；Cmd/Ctrl+Enter 也兼容老快捷键。
      // 中文输入法候选拼字时按 Enter 选词，不要触发发送：isComposing / keyCode 229 都识别一下。
      if (ev.key !== "Enter") return;
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.shiftKey) return; // Shift+Enter 留给原生换行
      ev.preventDefault();
      els.chatSendBtn.click();
    });
    // 「清空」按钮已移除，开新对话走顶部「+ 新对话」入口

    els.suggestedActionsClear.addEventListener("click", hideSuggestedActions);

    // 风格 modal
    els.stylePresetCloseBtn.addEventListener("click", closeStylePresetModal);
    els.styleSaveBtn.addEventListener("click", saveStylePreset);
    // 选了内置色板 → 自动填颜色（hidden <select> 改了也走同一条路径）
    els.styleScheme.addEventListener("change", () => {
      const v = els.styleScheme.value;
      if (v && v !== "custom") applyColorScheme(v);
      updateSchemePreview(v);
      updateLivePreview();
    });
    // 手动改任意颜色 → 切回 custom（避免给人"还是某预设"的误导）
    [
      "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor",
      "styleBackgroundColor", "styleSurfaceColor",
      "styleTitleColor", "styleBodyColor"
    ].forEach((id) => {
      els[id]?.addEventListener("input", markCustomScheme);
    });
    // 字体/字号/加粗变化只刷新实时预览（不切回 custom，因为主题里这些可能是默认值）
    [
      "styleTitleFont", "styleTitleSize", "styleBodyFont", "styleBodySize"
    ].forEach((id) => {
      els[id]?.addEventListener("input", updateLivePreview);
    });
    els.styleTitleBold?.addEventListener("change", updateLivePreview);

    // 大纲 modal
    els.outlineCloseBtn.addEventListener("click", closeOutlineModal);
    els.outlineGenerateBtn.addEventListener("click", generateFromOutline);
    els.outlineExtractBtn.addEventListener("click", extractOutlineFromActivePpt);
    els.outlineClearBtn.addEventListener("click", () => { els.outlineText.value = ""; });

    // 统一风格 modal
    els.unifyCloseBtn.addEventListener("click", closeUnifyModal);
    els.unifyExecuteBtn.addEventListener("click", executeUnify);
    els.unifyExtractBtn.addEventListener("click", extractOutlineForUnify);
    els.unifyClearBtn.addEventListener("click", () => { els.unifyOutlineText.value = ""; });

    // 点击 modal 遮罩层（card 之外）也关闭
    [els.stylePresetModal, els.outlineModal, els.unifyModal].forEach((m) => {
      if (!m) return;
      m.addEventListener("click", (ev) => {
        if (ev.target === m) m.classList.add("hidden");
      });
    });
  }

  // ---------------- Init ----------------

  // Mac WPS 的 TaskPane WebView 在宿主重设 pane 宽度后，window.innerWidth 不一定及时
  // 跟进，导致 body width:100% 只填到初始宽度，pane 右侧露白。这里直接读 innerWidth +
  // 强制 body/html 跟随；前 5 秒每 500ms 兜一次（应对 delayed-200ms 那批后续 resize）。
  // 但浮动模式下我们必须放手：WPS 浮动 CTP 的窗口大小由用户拖边框控制，
  // 这时还硬钉 body.width 会让内容卡死在脱离瞬间的宽度，看上去就是"无法调整大小"。
  function syncPaneWidth(reason) {
    const isFloating = global.WpsAiAddon?.getTaskPaneDockPosition?.() === 4;
    if (isFloating) {
      // 清掉之前的内联强制宽度，让 body { position:absolute; left:0; right:0 } 自然铺满
      document.documentElement.style.width = "";
      if (document.body) document.body.style.width = "";
      return;
    }
    const w = window.innerWidth;
    const cw = document.documentElement.clientWidth;
    const bw = document.body ? document.body.offsetWidth : 0;
    document.documentElement.style.width = w + "px";
    if (document.body) document.body.style.width = w + "px";
    console.log(`[lingxi-ui] syncPaneWidth(${reason}) innerWidth=${w} html=${cw} body=${bw}`);
  }

  function startPaneWidthSync() {
    syncPaneWidth("init");
    window.addEventListener("resize", () => syncPaneWidth("resize"));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      syncPaneWidth(`poll-${ticks}`);
      if (ticks >= 10) clearInterval(timer);
    }, 500);
  }

  // ===== 聊天面板 UX：跳回最新按钮 + 折叠中间轮次 =====
  // 场景：一场长对话滚上去看历史，一旦有新流式内容进来，用户很容易迷失位置。
  // 提供两个开关：（1）浮动"最新"按钮，用户在非底部时才出现；（2）折叠中间轮次，
  // 只保留首轮和末轮，中间用"已折叠 N 条历史消息"占位。
  const CHAT_FOLD_KEY = "wpsAiChatFoldMiddle";
  const CHAT_FOLD_TOGGLE_ENABLED = false;
  const CHAT_JUMP_THRESHOLD = 80;

  function isChatStreamAtBottom() {
    if (!els.chatStream) return true;
    const el = els.chatStream;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_JUMP_THRESHOLD;
  }

  // 流式跟随：贴底时才自动滚到底；用户往上滚（离底 >阈值）就停止跟随，方便边输出边回看历史。
  // scroll 监听里按当前位置更新；发消息 / 点「跳到最新」时重置为 true 恢复跟随。
  let chatStickToBottom = true;
  function chatFollowBottom() {
    if (els.chatStream && chatStickToBottom) els.chatStream.scrollTop = els.chatStream.scrollHeight;
  }

  function updateChatJumpBtnVisibility() {
    if (!els.chatJumpLatest || !els.chatStream) return;
    const hide = isChatStreamAtBottom() || !els.chatStream.children.length;
    els.chatJumpLatest.classList.toggle("hidden", hide);
  }

  function isChatFoldEnabled() {
    if (!CHAT_FOLD_TOGGLE_ENABLED) return false;
    try { return global.WpsAiStore.getItem(CHAT_FOLD_KEY) === "1"; }
    catch (e) { return false; }
  }

  function updateChatFoldToggleUi() {
    if (!els.chatFoldToggle) return;
    els.chatFoldToggle.classList.add("hidden");
    const on = isChatFoldEnabled();
    els.chatFoldToggle.classList.toggle("active", on);
    els.chatFoldToggle.setAttribute("aria-pressed", on ? "true" : "false");
    els.chatFoldToggle.title = on
      ? "折叠中间轮次：已开启（点击关闭）"
      : "折叠中间轮次：只保留首尾对话，中间轮折起来";
  }

  function clearChatFoldState() {
    if (!els.chatStream) return;
    els.chatStream.querySelectorAll(".chat-fold-divider").forEach((n) => n.remove());
    els.chatStream.querySelectorAll("[data-chat-folded='1']").forEach((n) => {
      n.style.display = "";
      n.removeAttribute("data-chat-folded");
    });
  }

  // 折叠策略：识别所有 .chat-msg.user（一条 user 起一个 turn），若 turn 数 ≥ 3，
  // 保留第 1 轮和最后 1 轮，把中间的 DOM 直接 display:none，用一个可展开的 divider 代替。
  function applyChatFoldIfEnabled() {
    if (!els.chatStream) return;
    clearChatFoldState();
    if (!isChatFoldEnabled()) return;
    const children = Array.from(els.chatStream.children);
    const userIdxs = children
      .map((c, i) => (c.classList && c.classList.contains("chat-msg") && c.classList.contains("user")) ? i : -1)
      .filter((i) => i >= 0);
    if (userIdxs.length < 3) return;
    // 折叠范围：从 [第 2 轮的 user] 开始到 [最后一轮 user 前一格] 结束
    const foldStart = userIdxs[1];
    const foldEnd = userIdxs[userIdxs.length - 1] - 1;
    if (foldEnd < foldStart) return;
    let hidden = 0;
    for (let i = foldStart; i <= foldEnd; i += 1) {
      children[i].style.display = "none";
      children[i].dataset.chatFolded = "1";
      hidden += 1;
    }
    const divider = document.createElement("div");
    divider.className = "chat-fold-divider";
    divider.innerHTML = `<span class="chat-fold-divider-text">已折叠 ${hidden} 条历史消息</span><button type="button" class="chat-fold-divider-expand">展开</button>`;
    divider.querySelector(".chat-fold-divider-expand").addEventListener("click", () => {
      try { global.WpsAiStore.setItem(CHAT_FOLD_KEY, "0"); } catch (e) {}
      updateChatFoldToggleUi();
      clearChatFoldState();
      if (els.chatStream) els.chatStream.scrollTop = els.chatStream.scrollHeight;
    });
    children[foldStart].parentNode.insertBefore(divider, children[foldStart]);
  }

  // ---- 诊断包导出 ----
  // 用户遇到问题时一键把"版本 / 设置（脱敏）/ 缓存占用 / SN / 最近日志"打包下载，
  // 直接甩给管理员或提 Bug 反馈，省掉来回问"你版本多少 / 你 SN 多少 / 你 cache 满没"。
  function redactSensitive(obj) {
    if (obj == null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      // 常见敏感字段：全 mask，只保留头尾各 4 位
      if (/apiKey|api_key|password|token|secret|authorization/i.test(k)) {
        const s = String(v || "");
        out[k] = s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "***";
      } else if (typeof v === "object") {
        out[k] = redactSensitive(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  async function exportDiagnosticBundle() {
    setBusy(true);
    try {
      const bundle = {
        exportedAt: new Date().toISOString(),
        scriptVersion: typeof SCRIPT_VERSION !== "undefined" ? SCRIPT_VERSION : "unknown",
        appVersion: (els.aboutVersion?.textContent || "unknown").replace(/^v/, ""),
        deviceSn: (els.aboutDeviceSn?.textContent || "unknown").trim(),
        userAgent: navigator.userAgent,
        location: {
          origin: location.origin,
          pathname: location.pathname
        },
        host: currentHostInfo || null,
        settings: redactSensitive(currentSettings || {}),
        cacheStats: null,
        providerHealth: _providerHealth || {},
        sessionStats: { turns: sessionStats.turns, totalMs: sessionStats.totalMs, lastMs: sessionStats.lastMs },
        recentLogs: null
      };
      // 缓存扫描（尽力而为，失败不阻塞）
      try {
        const mod = global.WpsAiCache;
        if (mod?.scan) {
          const data = await mod.scan();
          bundle.cacheStats = {
            grandTotalBytes: data.grandTotalBytes,
            local: data.local?.groups?.map((g) => ({ label: g.label, bytes: g.bytes, items: g.items.length, safe: g.safe })),
            proxy: data.proxy?.map((b) => ({ label: b.label, bytes: b.bytes, itemCount: b.itemCount, safe: b.safe }))
          };
        }
      } catch (e) { bundle.cacheStatsError = String(e?.message || e); }
      // 最近日志（如果 WpsAiLog 暴露了 ring buffer）
      try {
        const log = global.WpsAiLog;
        if (log?.getRecent) bundle.recentLogs = log.getRecent(200);
        else if (log?.tail) bundle.recentLogs = log.tail(200);
      } catch (e) { bundle.recentLogsError = String(e?.message || e); }

      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `wpsai-diag-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showMessage("诊断包已下载。请把 .json 文件发给管理员。", "success");
    } catch (e) {
      showMessage(`导出诊断包失败：${e?.message || e}`, "error");
    } finally {
      setBusy(false);
    }
  }

  // ---- Provider 健康探测状态（持久化） ----
  // 每次用户点 provider 卡片"测试"按钮或 chat 请求实际用到这条 provider 时，
  // 更新 _providerHealth[id]，卡片头显示状态点：绿=最近连接成功；红=最近失败；
  // 灰=从未测过。用户不用点开卡片就能一眼看出哪条挂了。
  const PROVIDER_HEALTH_KEY = "wpsAiProviderHealthV1";
  let _providerHealth = readProviderHealth();
  function readProviderHealth() {
    try { return JSON.parse(global.WpsAiStore.getItem(PROVIDER_HEALTH_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function writeProviderHealth() {
    try { global.WpsAiStore.setItem(PROVIDER_HEALTH_KEY, JSON.stringify(_providerHealth)); } catch (e) {}
  }
  function recordProviderHealth(id, info) {
    if (!id) return;
    _providerHealth[id] = { at: Date.now(), ok: !!info.ok, ms: info.ms || 0, error: info.error || null };
    writeProviderHealth();
  }
  function providerHealthDotHtml(id) {
    const h = _providerHealth[id];
    if (!h) return `<span class="provider-health-dot unknown" title="尚未测过"></span>`;
    const ago = Date.now() - h.at;
    const agoStr = ago < 60000 ? "刚刚" : ago < 3600000 ? `${Math.round(ago / 60000)}分钟前` : `${Math.round(ago / 3600000)}小时前`;
    if (h.ok) {
      return `<span class="provider-health-dot ok" title="最近连接成功（${agoStr}，${h.ms}ms）"></span>`;
    }
    return `<span class="provider-health-dot err" title="最近连接失败（${agoStr}）：${escapeHtmlSafe(h.error || "")}"></span>`;
  }

  // ---- Settings 搜索：跨面板 label / field / small 文本模糊匹配 ----
  // 用户想找"proxy 端口"要在 6 个 tab 里翻半天。搜索框输入关键字 → 匹配的字段
  // 高亮 + 附近段落展开；侧栏 tab 上显示命中数徽章；空关键字复原视图。
  function setupSettingsSearch() {
    const input = document.getElementById("settingsSearchInput");
    if (!input || input.dataset.bound === "1") return;
    input.dataset.bound = "1";
    let debounceTimer = 0;
    input.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applySettingsSearchFilter, 60);
    });
  }

  function applySettingsSearchFilter() {
    const input = document.getElementById("settingsSearchInput");
    const q = String(input?.value || "").trim().toLowerCase();
    const panels = Array.from(document.querySelectorAll(".settings-panel[data-settings-panel]"));
    const sidebarBtns = Array.from(document.querySelectorAll(".settings-sidebar-btn[data-settings-panel]"));
    // 清掉旧标记
    document.querySelectorAll(".settings-search-hit").forEach((n) => n.classList.remove("settings-search-hit"));
    document.querySelectorAll(".settings-search-count-badge").forEach((n) => n.remove());

    if (!q) {
      // 复原：panel 恢复默认 hidden 逻辑（由侧栏 tab 控制）
      panels.forEach((p) => p.classList.remove("settings-search-empty"));
      sidebarBtns.forEach((b) => b.classList.remove("settings-search-empty"));
      return;
    }

    // 用一段选择器覆盖常见的"字段"元素：label / small / field-tip / p / h3 / button 上的可读文字
    const FIELD_SEL = "label, .field-tip, small, p.muted, h3, .config-card-head, .settings-actions button, .settings-sidebar-btn > span, .settings-subtab-btn";
    let anyHit = false;
    panels.forEach((panel) => {
      const key = panel.dataset.settingsPanel;
      const nodes = Array.from(panel.querySelectorAll(FIELD_SEL));
      let hits = 0;
      nodes.forEach((n) => {
        const txt = (n.textContent || "").toLowerCase();
        if (txt.includes(q)) {
          n.classList.add("settings-search-hit");
          hits += 1;
        }
      });
      panel.classList.toggle("settings-search-empty", hits === 0);
      const btn = sidebarBtns.find((b) => b.dataset.settingsPanel === key);
      if (btn) {
        btn.classList.toggle("settings-search-empty", hits === 0);
        if (hits > 0) {
          const badge = document.createElement("span");
          badge.className = "settings-search-count-badge";
          badge.textContent = String(hits);
          btn.appendChild(badge);
          anyHit = true;
        }
      }
    });
    // 有命中时自动切到第一个有命中的 tab
    if (anyHit) {
      const firstHitBtn = sidebarBtns.find((b) => !b.classList.contains("settings-search-empty") && b.querySelector(".settings-search-count-badge"));
      if (firstHitBtn && !firstHitBtn.classList.contains("active")) firstHitBtn.click();
    }
  }

  // ---- localStorage 写失败可见化 ----
  // 之前所有 setItem catch 都吞掉，用户完全不知道设置 / 历史 / 附件写没写进去。
  // 拦一层：QuotaExceededError 就弹一条可点击的 toast，引导去缓存管理清空间。
  // 用节流窗口避免流式场景瞬间刷屏。
  (function installLocalStorageGuard() {
    if (typeof localStorage === "undefined") return;
    const proto = Object.getPrototypeOf(localStorage);
    const orig = proto?.setItem;
    if (!orig || orig.__wpsai_wrapped) return;
    let lastToastAt = 0;
    function isQuotaError(e) {
      if (!e) return false;
      const name = String(e.name || "");
      const msg = String(e.message || "");
      return name === "QuotaExceededError"
        || name === "NS_ERROR_DOM_QUOTA_REACHED"
        || /quota|exceeded/i.test(msg)
        || (e.code === 22) || (e.code === 1014);
    }
    function wrapped(key, val) {
      try {
        return orig.call(this, key, val);
      } catch (e) {
        if (isQuotaError(e)) {
          const now = Date.now();
          if (now - lastToastAt > 60 * 1000 && typeof showMessage === "function") {
            lastToastAt = now;
            try {
              showMessage("本地存储已满，设置 / 历史 / 缓存可能写不进去。点这里去缓存管理清空间。", "error", {
                autoHide: false,
                duration: 20000,
                onClick: () => { try { openSettingsAsDialog?.("about", "about-update"); } catch (err) {} }
              });
            } catch (err) {}
          }
        }
        throw e;
      }
    }
    wrapped.__wpsai_wrapped = true;
    proto.setItem = wrapped;
  })();

  // ---- Chat 输入 slash 模板 / @ 上下文 ----
  // 用户之前想快速触发常用指令必须打完整长句 or 用 ribbon 按钮；
  // slash 触发弹层给"翻译 / 润色 / 总结"等模板一键填充；
  // @ 触发上下文选择器把"选区 / 全文"内容作为 markdown 引用注入。
  const SLASH_TEMPLATES = [
    { key: "translate", label: "翻译", template: "把下面的内容翻译成中文：\n" },
    { key: "translate-en", label: "翻译 EN", template: "把下面的内容翻译成英文：\n" },
    { key: "polish", label: "润色", template: "请润色下面的内容，让表达更专业流畅，保持原意：\n" },
    { key: "optimize", label: "优化", template: "帮我优化下面的内容（结构 + 措辞 + 逻辑）：\n" },
    { key: "summary", label: "总结", template: "请总结下面的内容，要点式：\n" },
    { key: "continue", label: "续写", template: "接着下面这段往下续写 1-2 段，承接语气：\n" },
    { key: "expand", label: "扩写", template: "把下面的内容扩写得更详细：\n" },
    { key: "shrink", label: "缩写", template: "把下面的内容压缩到一半，保留核心：\n" },
    { key: "rewrite", label: "重写", template: "从不同角度重写下面的内容，保持事实：\n" },
    { key: "check", label: "查错", template: "帮我检查下面内容里的错别字 / 标点 / 语法错误：\n" }
  ];
  const AT_CONTEXTS = [
    { key: "selection", label: "@选区", hint: "把当前选中的文本作为引用" },
    { key: "document",  label: "@全文", hint: "读取整篇文档作为上下文" }
  ];
  let _slashPopupEl = null;

  function closeSlashPopup() {
    if (_slashPopupEl) { _slashPopupEl.remove(); _slashPopupEl = null; }
    document.removeEventListener("click", onDocClickCloseSlash, true);
  }
  function onDocClickCloseSlash(ev) {
    if (!_slashPopupEl) return;
    if (_slashPopupEl.contains(ev.target)) return;
    if (els.chatInput?.contains(ev.target)) return;
    closeSlashPopup();
  }
  function openSlashPopup(kind, filter) {
    closeSlashPopup();
    const source = kind === "at" ? AT_CONTEXTS : SLASH_TEMPLATES;
    const q = String(filter || "").toLowerCase();
    const items = source.filter((s) => !q || s.label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q));
    if (!items.length) return;
    const popup = document.createElement("div");
    popup.className = "chat-slash-popup";
    popup.innerHTML = items.map((it, i) => `
      <div class="chat-slash-item${i === 0 ? " active" : ""}" data-key="${escapeHtmlSafe(it.key)}" data-kind="${kind}">
        <span class="chat-slash-label">${escapeHtmlSafe(it.label)}</span>
        ${it.hint ? `<span class="chat-slash-hint">${escapeHtmlSafe(it.hint)}</span>` : ""}
      </div>`).join("");
    // 定位在输入区上方
    const input = els.chatInput;
    if (input) {
      const r = input.getBoundingClientRect();
      popup.style.position = "fixed";
      popup.style.left = `${Math.max(8, r.left)}px`;
      popup.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
      popup.style.width = `${Math.min(320, r.width)}px`;
    }
    popup.addEventListener("mousedown", (ev) => {
      // mousedown 而不是 click：防止 blur 掉 input 让 selection 丢失
      ev.preventDefault();
      const item = ev.target?.closest?.(".chat-slash-item");
      if (!item) return;
      applySlashChoice(item.dataset.kind, item.dataset.key);
    });
    document.body.appendChild(popup);
    _slashPopupEl = popup;
    setTimeout(() => { document.addEventListener("click", onDocClickCloseSlash, true); }, 0);
  }

  async function applySlashChoice(kind, key) {
    const input = els.chatInput;
    if (!input) { closeSlashPopup(); return; }
    if (kind === "slash") {
      const tpl = SLASH_TEMPLATES.find((s) => s.key === key);
      if (!tpl) { closeSlashPopup(); return; }
      // 移除末尾正在编辑的 "/xxx"
      const val = input.value.replace(/\/[\w\-一-龥]*$/, "");
      input.value = val + tpl.template;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (kind === "at") {
      const ctx = AT_CONTEXTS.find((s) => s.key === key);
      if (!ctx) { closeSlashPopup(); return; }
      // 移除末尾 "@xxx"
      const val = input.value.replace(/@[\w\-一-龥]*$/, "");
      input.value = val;
      // 异步读取上下文
      let text = "";
      try {
        if (ctx.key === "selection") {
          text = await global.WpsAiDocument?.readSelectionText?.() || "";
          if (!text) showMessage("当前没有选中的文本。", "info");
        } else if (ctx.key === "document") {
          text = await global.WpsAiDocument?.readDocumentText?.() || "";
          if (!text) showMessage("当前文档为空或读取失败。", "info");
        }
      } catch (e) { showMessage(`读取上下文失败：${e?.message || e}`, "error"); }
      if (text) {
        // 长文档截断到 4000 字，避免撑爆 prompt
        const clipped = text.length > 4000 ? text.slice(0, 4000) + "\n\n[…截断]" : text;
        input.value = val + "\n> " + clipped.replace(/\n/g, "\n> ") + "\n\n";
      }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    closeSlashPopup();
  }

  function setupChatSlashCommands() {
    const input = els.chatInput;
    if (!input) return;
    input.addEventListener("input", () => {
      const v = input.value;
      // 光标在末尾时才触发，避免用户在正文中打 "/" 也弹
      if (input.selectionStart !== v.length) { closeSlashPopup(); return; }
      // 匹配末尾 "/xxx" 或 "@xxx" ；行内触发也允许（前面有空格 / 换行 / 开头）
      const slashMatch = v.match(/(?:^|\s)\/([\w\-一-龥]*)$/);
      const atMatch = v.match(/(?:^|\s)@([\w\-一-龥]*)$/);
      if (slashMatch) openSlashPopup("slash", slashMatch[1]);
      else if (atMatch) openSlashPopup("at", atMatch[1]);
      else closeSlashPopup();
    });
    input.addEventListener("keydown", (ev) => {
      if (!_slashPopupEl) return;
      if (ev.key === "Escape") { closeSlashPopup(); return; }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const items = Array.from(_slashPopupEl.querySelectorAll(".chat-slash-item"));
        const cur = items.findIndex((it) => it.classList.contains("active"));
        const next = ev.key === "ArrowDown"
          ? Math.min(items.length - 1, cur + 1)
          : Math.max(0, cur - 1);
        items.forEach((it, i) => it.classList.toggle("active", i === next));
        items[next]?.scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        const active = _slashPopupEl.querySelector(".chat-slash-item.active");
        if (active) applySlashChoice(active.dataset.kind, active.dataset.key);
      }
    });
  }

  // ---- 单次对话临时模型 override ----
  // 让用户不改默认设置的情况下，只用别的模型跑本次对话（比如常用 gpt-5-mini，
  // 遇到复杂问题临时切 Claude Sonnet）。发送完自动清 override，回到默认模型。
  let _perTurnModelOverride = null;
  let _modelOverridePickerEl = null;

  function updateModelOverrideBarUi() {
    const bar = els.chatModelOverrideBar;
    if (!bar) return;
    if (_perTurnModelOverride) {
      const label = _perTurnModelOverride.providerLabel
        ? `${_perTurnModelOverride.providerLabel} · ${_perTurnModelOverride.modelId}`
        : _perTurnModelOverride.modelId;
      if (els.chatModelOverrideText) els.chatModelOverrideText.textContent = label;
      bar.classList.remove("hidden");
      if (els.chatModelOverrideBtn) els.chatModelOverrideBtn.classList.add("active");
    } else {
      bar.classList.add("hidden");
      if (els.chatModelOverrideBtn) els.chatModelOverrideBtn.classList.remove("active");
    }
  }

  function clearPerTurnModelOverride() {
    _perTurnModelOverride = null;
    updateModelOverrideBarUi();
  }

  function setPerTurnModelOverride(providerId, modelId, providerLabel) {
    _perTurnModelOverride = { providerId, modelId, providerLabel };
    updateModelOverrideBarUi();
  }

  function closeModelOverridePicker() {
    if (_modelOverridePickerEl) {
      _modelOverridePickerEl.remove();
      _modelOverridePickerEl = null;
    }
    document.removeEventListener("click", onDocClickCloseOverridePicker, true);
  }
  function onDocClickCloseOverridePicker(ev) {
    if (!_modelOverridePickerEl) return;
    if (_modelOverridePickerEl.contains(ev.target)) return;
    if (els.chatModelOverrideBtn?.contains(ev.target)) return;
    closeModelOverridePicker();
  }

  function openModelOverridePicker() {
    if (_modelOverridePickerEl) { closeModelOverridePicker(); return; }
    const items = typeof collectMultiProviderItems === "function" ? collectMultiProviderItems() : [];
    const popup = document.createElement("div");
    popup.className = "chat-model-override-picker";
    if (!items.length) {
      popup.innerHTML = '<div class="chat-model-override-empty">尚未启用任何供应商，去设置里配置。</div>';
    } else {
      const cur = _perTurnModelOverride;
      const byProvider = new Map();
      items.forEach((it) => {
        if (!byProvider.has(it.providerId)) byProvider.set(it.providerId, { label: it.providerLabel, models: [] });
        byProvider.get(it.providerId).models.push(it);
      });
      let html = "";
      byProvider.forEach((group, providerId) => {
        html += `<div class="chat-model-override-group">${escapeHtmlSafe(group.label)}</div>`;
        group.models.forEach((it) => {
          const isSel = cur && cur.providerId === providerId && cur.modelId === it.modelId;
          html += `<div class="chat-model-override-item${isSel ? " selected" : ""}" data-provider-id="${escapeHtmlSafe(providerId)}" data-model-id="${escapeHtmlSafe(it.modelId)}" data-provider-label="${escapeHtmlSafe(group.label)}">${escapeHtmlSafe(it.modelId)}</div>`;
        });
      });
      popup.innerHTML = html;
      popup.addEventListener("click", (ev) => {
        const item = ev.target?.closest?.(".chat-model-override-item");
        if (!item) return;
        setPerTurnModelOverride(item.dataset.providerId, item.dataset.modelId, item.dataset.providerLabel);
        closeModelOverridePicker();
      });
    }
    // 定位在按钮上方（chat 输入区在面板下方）
    const btn = els.chatModelOverrideBtn;
    if (btn) {
      const r = btn.getBoundingClientRect();
      popup.style.position = "fixed";
      popup.style.left = `${Math.max(8, r.left - 4)}px`;
      popup.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
    }
    document.body.appendChild(popup);
    _modelOverridePickerEl = popup;
    // 关闭：Esc + 点击外部
    setTimeout(() => {
      document.addEventListener("click", onDocClickCloseOverridePicker, true);
    }, 0);
  }

  function setupModelOverrideControls() {
    if (!els.chatModelOverrideBtn) return;
    els.chatModelOverrideBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openModelOverridePicker();
    });
    els.chatModelOverrideClearBtn?.addEventListener("click", clearPerTurnModelOverride);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && _modelOverridePickerEl) closeModelOverridePicker();
    });
    updateModelOverrideBarUi();
  }

  function setupChatPanelUx() {
    if (!els.chatStream) return;
    pinChatSessionStats();
    // 跳到最新：滚动时判断是否偏离底部；点击滚到底部
    els.chatStream.addEventListener("scroll", () => {
      chatStickToBottom = isChatStreamAtBottom(); // 用户往上滚→脱离跟随；滚回底部→恢复跟随
      updateChatJumpBtnVisibility();
    });
    if (els.chatJumpLatest) {
      els.chatJumpLatest.addEventListener("click", () => {
        if (!els.chatStream) return;
        chatStickToBottom = true; // 显式跳到底部→恢复跟随
        els.chatStream.scrollTop = els.chatStream.scrollHeight;
        updateChatJumpBtnVisibility();
      });
    }
    // 折叠中间轮次
    if (els.chatFoldToggle) {
      updateChatFoldToggleUi();
      els.chatFoldToggle.addEventListener("click", () => {
        const next = !isChatFoldEnabled();
        try { global.WpsAiStore.setItem(CHAT_FOLD_KEY, next ? "1" : "0"); } catch (e) {}
        updateChatFoldToggleUi();
        applyChatFoldIfEnabled();
        if (els.chatStream) els.chatStream.scrollTop = els.chatStream.scrollHeight;
      });
    }
    // 观察 chatStream 子节点变化：（1）刷新跳最新按钮；（2）折叠已开启时把新一轮折叠状态重算
    let raf = 0;
    const observer = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateChatJumpBtnVisibility();
        if (isChatFoldEnabled()) applyChatFoldIfEnabled();
      });
    });
    observer.observe(els.chatStream, { childList: true });
    updateChatJumpBtnVisibility();
    if (isChatFoldEnabled()) applyChatFoldIfEnabled();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindElements();
    installStartupPasteGuards();
    updateProxyStatusBadge({ scanOnFail: true }).catch(() => {});

    // 修 Task5：先把 WpsAiStore 的内存 Map hydrate 好（sqlite via proxy /kv/all，
    // 否则退化 localStorage），再放行任何读缓存的逻辑（settings/conversations/history/渲染）。
    // 主 TaskPane 和各 ShowDialog（?mode=...）子窗口都会跑到这个 handler，所以这行必须放在
    // mode 分支 / 任何 early return 之前，两边都要先 hydrate 完。
    try { await global.WpsAiStore.init(); } catch (e) { console.warn("[store] init 失败，降级 localStorage:", e && e.message); }
    // conversations.js / history.js 在脚本解析时（早于这里）就已经从空的 WpsAiStore 读过一次缓存了，
    // 上面 init() 完成后 Map 才真正 hydrate 好 —— 这里补读一次，把之前读到的空表换成真实数据。
    try { global.WpsAiConversations && global.WpsAiConversations.reloadFromStore && global.WpsAiConversations.reloadFromStore(); } catch (e) {}
    try { global.WpsAiHistory && global.WpsAiHistory.reloadFromStore && global.WpsAiHistory.reloadFromStore(); } catch (e) {}
    // Task8：modelsByProvider / imageModelsByProvider / _providerHealth 同样在脚本解析时
    // （早于 WpsAiStore.init() 完成）就从空 store 读过一次了，这里补读一次换成真实数据。
    try { const raw = global.WpsAiStore.getItem(MODELS_CACHE_KEY); modelsByProvider = raw ? (JSON.parse(raw) || {}) : {}; } catch (e) {}
    try { const raw = global.WpsAiStore.getItem(IMAGE_MODELS_CACHE_KEY); imageModelsByProvider = raw ? (JSON.parse(raw) || {}) : {}; } catch (e) {}
    // 界面语言偏好对账：WPS 的 localStorage 会丢，SQLite 里的才是权威——store 就绪后恢复并热套用
    try { global.WpsAiI18n?.syncFromStore?.(); } catch (e) {}
    // P2-1 / P2-4：任务与记忆存储同样在 store hydrate 后重灌
    try { global.WpsAiTaskStore?.reloadFromStore?.(); } catch (e) {}
    try { global.WpsAiChatMemory?.reloadFromStore?.(); } catch (e) {}
    // MCP 调用日志：设置窗口早于 store 就绪读到空，hydrate 后重灌
    try { global.WpsAiMcpBridge?.reloadCallLogFromStore?.(); } catch (e) {}
    try { _providerHealth = readProviderHealth(); } catch (e) {}
    // 这三个预览缓存也在 parse 时读进模块变量（早于 init），init 后重灌一遍
    try { loadPreviewChatLogsFromStorage(); } catch (e) {}
    try { loadPickedComponentsFromStorage(); } catch (e) {}
    try { loadUnifiedChatLog(); } catch (e) {}

    if (!document.getElementById("authBadge")) return;

    if (!isSettingsDialog && !isPreviewDialog && !isMaterialsDialog && !isQuickPromptDialog && !isFormatPreviewDialog && !isSelectionPreviewDialog) startPaneWidthSync();

    loadSettings();
    applySettingsToForm();
    // 界面语言最终对账：设置 JSON 是最可靠的持久化通道，以它为权威。
    // localStorage / kv 里的副本丢了（WPS 清 localStorage 等）也能从设置恢复并热套用。
    try {
      const settingsLang = currentSettings?.uiLanguage;
      if ((settingsLang === "zh" || settingsLang === "en" || settingsLang === "auto")
          && settingsLang !== global.WpsAiI18n?.getPref?.()) {
        global.WpsAiI18n?.setPref?.(settingsLang);
      }
    } catch (e) {}
    // 只在主面板（非各类 ShowDialog 弹窗）best-effort 同步一次启用宿主 → publish.xml
    if (!isSettingsDialog && !isPreviewDialog && !isMaterialsDialog && !isQuickPromptDialog
        && !isFormatPreviewDialog && !isSelectionPreviewDialog && !isParallelTranslateDialog) {
      setTimeout(syncEnabledHostsOnBoot, 2500);
    }
    // 必须早于所有 ?mode=... ShowDialog 分支的 early return：
    // 独立弹窗里也有 textarea/input，同样会被 WPS 宿主抢 Cmd/Ctrl 编辑快捷键。
    installWpsFocusRelease();
    setupChatPanelUx();
    setupModelOverrideControls();
    setupChatSlashCommands();
    setupSettingsSearch();

    // 修 #13: 监听同源其他窗口的 cache 清空广播。
    // 主 TaskPane 清空 → dialog 收到 storage 事件 → 把当前 htmlPreviewState.id 置 null（变新建模式），
    // 否则 dialog 上 Save 会去 cache.update(已删除id) 返回 null 再 fallback save，但 chat 日志 key 还指向旧 id。
    window.addEventListener("storage", (ev) => {
      if (ev.key !== "lingxi_html_cache_cleared_at") return;
      if (typeof htmlPreviewState === "undefined" || !htmlPreviewState) return;
      if (!htmlPreviewState.id) return;
      htmlPreviewState.id = null;
      try {
        if (typeof appendPreviewChatMsg === "function") {
          appendPreviewChatMsg("ai-info", "「我的历史」已被清空。当前预览已切换到新建模式，下次保存会作为新条目入库。");
        }
        if (typeof updateHtmlPreviewHistoryBadge === "function") updateHtmlPreviewHistoryBadge();
      } catch (e) {}
    });

    // 监听 dialog 派过来的「待执行插入」任务。两种 key 都听，兼容新旧 dialog 代码：
    //   - PENDING_INSERT_KEY: 最新写法 (commit ba6e7e2+)，dialog 显式写过来
    //   - RESULT_KEY: 老的 dialogOnConfirm 写法，dialog 把 result blob 写过来
    // 不论哪种 key，只要 templateName/layout 在 blob 里 + 不是 cancelled，MAIN 就调 renderAndInsertSlide。
    //
    // 关键点: 这个监听器跑在 MAIN TaskPane 上下文里，不在 ShowDialog 子窗口里，
    // jsapi 拿到的 ActivePresentation / ActiveWindow 都是用户面前真正那个窗口，AddPicture 落到正确的 slide。
    const _pendingInsertHandlerKeys = new Set([
      PREVIEW_DIALOG_PENDING_INSERT_KEY,
      PREVIEW_DIALOG_RESULT_KEY
    ]);
    plog("init", "MAIN registered pending-insert storage listener (keys=" + Array.from(_pendingInsertHandlerKeys).join(",") + ")");
    window.addEventListener("storage", async (ev) => {
      if (!_pendingInsertHandlerKeys.has(ev.key)) return;
      if (!ev.newValue) return;
      // 修 B32：阻塞式 ShowDialog 下同步路径已消费过同一份 RESULT，这里跳过避免二次插入。
      if (ev.key === PREVIEW_DIALOG_RESULT_KEY && ev.newValue === _consumedPreviewResultSig) {
        _consumedPreviewResultSig = "";
        plog("pendingInsert", "RESULT 已被同步路径消费，跳过（去重）");
        return;
      }
      // 只让 MAIN 接，DIALOG/SETTINGS/STYLEPRESET 子窗口忽略（jsapi 在子窗口里不可靠）
      if (isAnyDialogWindow()) return;
      let blob;
      try { blob = JSON.parse(ev.newValue); }
      catch (e) { pwarn("pendingInsert", "JSON parse failed:", e?.message); return; }
      // RESULT_KEY 形态下可能是 {cancelled: true}, 跳过
      if (blob?.cancelled) { plog("pendingInsert", "blob.cancelled=true，跳过"); return; }
      if (!blob?.templateName || !blob?.layout) {
        plog("pendingInsert", "blob 缺 templateName/layout，跳过", { key: ev.key, keys: Object.keys(blob || {}) });
        return;
      }
      plog("pendingInsert", "received from dialog via " + ev.key, {
        templateName: blob.templateName,
        layout: blob.layout,
        intent: blob.intent,
        slideHint: blob.slideHint,
        activeSlideIndex: blob.activeSlideIndex
      });
      try { localStorage.removeItem(ev.key); } catch (e) {}
      const renderAndInsert = global.WpsAiRenderAndInsertSlide;
      if (typeof renderAndInsert !== "function") {
        pwarn("pendingInsert", "WpsAiRenderAndInsertSlide 未注册");
        showMessage("插入失败：插件未完整初始化", "error");
        return;
      }
      const params = {
        templateName: blob.templateName,
        layout: blob.layout,
        data: blob.data || {},
        palette: blob.palette || {},
        intent: blob.intent || "insert"
      };
      if (blob.intent === "replace" && typeof blob.slideHint === "number" && blob.slideHint > 0) {
        params.slide = blob.slideHint;
      } else if (blob.intent === "replace-active" && typeof blob.activeSlideIndex === "number" && blob.activeSlideIndex > 0) {
        params.slide = blob.activeSlideIndex;
        params.intent = "replace";
      }
      // 同 fallback 路径：dialog 端 doConfirm 顶部已经 cache.update 了，下游 saveToCache=true 会重复一条
      const isReplaceLike = params.intent === "replace" || params.intent === "replace-active";
      if (isReplaceLike) params.saveToCache = false;
      plog("pendingInsert", "calling renderAndInsert in MAIN", params);
      try {
        const r = await renderAndInsert(params);
        plog("pendingInsert", "renderAndInsert OK", { slide: r?.slide, layerCount: r?.layerCount });
        const intentLabel = blob.intent === "insert" ? "插入到末尾" : `替换第 ${r?.slide} 页`;
        showMessage(`已${intentLabel}`, "success");
      } catch (e) {
        pwarn("pendingInsert", "renderAndInsert THREW", e?.message || String(e));
        showMessage(`插入失败：${e?.message || e}`, "error");
      }
    });

    window.addEventListener("storage", (ev) => {
      if (ev.key !== MATERIAL_DIALOG_INSERT_KEY && ev.key !== MATERIAL_DIALOG_MODIFY_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeMaterialDialogRequests();
    });

    window.addEventListener("storage", (ev) => {
      if (ev.key !== QUICK_PROMPT_DIALOG_RESULT_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeQuickPromptDialogResult();
    });

    window.addEventListener("storage", (ev) => {
      if (ev.key !== FORMAT_PREVIEW_DIALOG_RESULT_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeFormatPreviewDialogResult();
    });

    window.addEventListener("storage", (ev) => {
      if (ev.key !== SELECTION_PREVIEW_DIALOG_RESULT_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeSelectionPreviewDialogResult();
    });

    // ===== 预览独立窗口模式 =====
    // 跳过主 TaskPane 的所有初始化（chat、host 探测、ribbon），只走预览相关的 init
    if (isPreviewDialog) {
      plog("dialogInit", "preview-dialog window booted, calling bindHtmlPreviewModal");
      bindHtmlPreviewModal();
      // 读 parent 写来的 request → 调 openHtmlPreviewInline 渲染
      let req = null;
      let rawReq = null;
      try {
        rawReq = localStorage.getItem(PREVIEW_DIALOG_REQUEST_KEY);
        if (rawReq) req = JSON.parse(rawReq);
      } catch (e) { pwarn("dialogInit", "JSON parse request FAILED:", e?.message); }
      plog("dialogInit", "request read:",
        req
          ? { templateName: req.templateName, layout: req.layout, hasData: !!req.data, dataKeys: Object.keys(req.data || {}), hasPalette: !!req.palette }
          : `NULL (rawReq=${rawReq ? "non-empty" : "empty"})`
      );
      // dialog 内的 onConfirm：把结果写回 localStorage 然后关窗。
      // 修 #12: dialogOnConfirm 只在用户点按钮时触发；用户点 dialog 标题栏 X 关闭时
      // 不会触发。监听 beforeunload 兜底写一次 cancelled 状态。
      let _resultWritten = false;
      const dialogOnConfirm = (final) => {
        plog("dialogOnConfirm", "called with", final ? "data" : "null");
        const st = htmlPreviewState;
        const result = final
          ? {
              cancelled: false,
              // standalone 路径（没有 tool onConfirm）让 MAIN TaskPane 在 dialog 关掉后自己调
              // renderAndInsertSlide —— 之前在 DIALOG 里直接调 WPS API 会卡在 modal 状态导致
              // AddPicture 静默失败 / slide 看不到图。
              templateName: final.templateName || st?.templateName || null,
              layout: final.layout || st?.layout || null,
              data: final.data || {},
              palette: final.palette || {},
              intent: final.intent || "insert",
              slideHint: typeof st?.slideHint === "number" ? st.slideHint : null,
              activeSlideIndex: typeof final.activeSlideIndex === "number" ? final.activeSlideIndex : null
            }
          : { cancelled: true };
        try { localStorage.setItem(PREVIEW_DIALOG_RESULT_KEY, JSON.stringify(result)); _resultWritten = true; } catch (e) {}
        try { if (typeof window.close === "function") window.close(); } catch (e) {}
      };
      // 暴露给 doConfirm 用：dialog 的 standalone 路径（没有 tool onConfirm）也走这条路
      // 写 RESULT key + close 窗口，由 MAIN 接收 result 后实际调 renderAndInsertSlide
      window.__lingxiDialogConfirm = dialogOnConfirm;
      // 兜底：用户点 X 关 dialog → beforeunload 触发；如果还没写过 result，写 cancelled
      window.addEventListener("beforeunload", () => {
        if (_resultWritten) return;
        try {
          localStorage.setItem(PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({ cancelled: true, viaWindowClose: true }));
        } catch (e) {}
      });
      // 启动渲染
      openHtmlPreviewInline({
        templateName: req?.templateName,
        layout: req?.layout,
        data: req?.data || {},
        palette: req?.palette || {},
        slideHint: req?.slideHint || null,
        // 主 TaskPane 在 ShowDialog 之前抓住的当前选中页号，跟着 IPC 传进来
        activeSlideIndex: typeof req?.activeSlideIndex === "number" ? req.activeSlideIndex : null,
        historyMode: !!req?.historyMode,
        galleryMode: !!req?.galleryMode,
        onConfirm: dialogOnConfirm
      });
      // 关闭按钮 / cancel 按钮 → 也走 dialogOnConfirm(null)
      // closeHtmlPreviewModal 内部已经会 onConfirm(null)，所以走原路即可
      return;  // 跳过下面所有主 TaskPane 初始化
    }

    // 独立素材库窗口：只跑素材库相关 init，插入 / 修改通过 localStorage 派给主 TaskPane 执行
    if (isMaterialsDialog) {
      bindMaterialLibrary();
      openMaterialLibraryModal();
      return;
    }

    // 独立历史对话窗口：只渲染会话列表（按 URL ?dk= 过滤），选中后写 localStorage 派给主 TaskPane 加载并关窗
    if (isConversationsDialog) {
      document.documentElement.classList.add("conversations-mode");
      renderConversationsMenu();
      els.conversationsMenu?.classList.remove("hidden");
      els.conversationsMenuClose?.addEventListener("click", () => { try { window.close(); } catch (e) {} });
      return;
    }

    // 独立 ribbon 快捷输入窗口：只渲染对应表单，确认后把最终 prompt 写回主 TaskPane
    if (isQuickPromptDialog) {
      bindQuickPromptModal();
      let req = null;
      try {
        const raw = localStorage.getItem(QUICK_PROMPT_DIALOG_REQUEST_KEY);
        if (raw) req = JSON.parse(raw);
      } catch (e) {}
      if (req) {
        openQuickPromptInline(req);
      } else {
        showMessage("快捷操作数据已过期，请重新点击 ribbon 按钮。", "error", { autoHide: false });
      }
      window.addEventListener("beforeunload", () => {
        if (quickPromptState && !quickPromptDialogResultWritten) writeQuickPromptDialogResult({ cancelled: true, viaWindowClose: true });
      });
      return;
    }

    if (isFormatPreviewDialog) {
      bindFormatPreviewModal();
      let req = null;
      try {
        const raw = localStorage.getItem(FORMAT_PREVIEW_DIALOG_REQUEST_KEY);
        if (raw) req = JSON.parse(raw);
      } catch (e) {}
      if (req?.text || req?.paragraphs) {
        prepareFormatPreview({ text: req.text || "", paragraphs: req.paragraphs || [], selection: req.selection || null });
      } else {
        els.formatPreviewModal?.classList.remove("hidden");
        showMessage("排版预览数据已过期，请重新点击 ribbon 按钮。", "error", { autoHide: false });
      }
      window.addEventListener("beforeunload", () => {
        if (formatPreviewDialogResultWritten) return;
        try {
          const raw = localStorage.getItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY);
          if (!raw) localStorage.setItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({ ts: Date.now(), cancelled: true, viaWindowClose: true }));
        } catch (e) {}
      });
      return;
    }

    // 独立「对照翻译」窗口：铺满窗口显示语言/范围控件 + 结果区，自身完成提取与流式翻译。
    if (isParallelTranslateDialog) {
      bindParallelTranslateModal();
      let req = null;
      try {
        const raw = localStorage.getItem(PARALLEL_TRANSLATE_DIALOG_REQUEST_KEY);
        if (raw) req = JSON.parse(raw);
      } catch (e) {}
      populateParallelTranslateLangs();
      setParallelTranslateDocPath(req?.docPath || "");
      const modal = els.parallelTranslateModal;
      if (modal) { modal.classList.remove("hidden"); modal.classList.add("pt-fullwindow"); }
      if (!_ptDialogDocPath) showMessage("未读到 PDF 路径。已记录 WPS PDF 路径探测日志，请查看 dev 终端或在控制台执行 __lingxiProbePdfPath()。", "error", { autoHide: false });
      return;
    }

    if (isSelectionPreviewDialog) {
      bindSelectionPreviewModal();
      let req = null;
      try {
        const raw = localStorage.getItem(SELECTION_PREVIEW_DIALOG_REQUEST_KEY);
        if (raw) req = JSON.parse(raw);
      } catch (e) {}
      if (req?.sourceText) {
        openSelectionPreviewInline(req);
      } else {
        els.selectionPreviewModal?.classList.remove("hidden");
        showMessage("选区预览数据已过期，请重新点击 ribbon 按钮。", "error", { autoHide: false });
      }
      window.addEventListener("beforeunload", () => {
        if (selectionPreviewDialogResultWritten) return;
        try {
          const raw = localStorage.getItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY);
          if (!raw) localStorage.setItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({ ts: Date.now(), cancelled: true, viaWindowClose: true }));
        } catch (e) {}
      });
      return;
    }

    // 独立设置窗口：只跑设置相关的 init，跳过 TaskPane 的 chat / host / ribbon 等
    if (isSettingsDialog) {
      bindCollapsibleCards();
      bindSettingsSubtabs();
      loadVersionInfo();
      // sidebar tab 切换 / 预设选单 / 新增 / 关闭
      els.openSettingsModalBtn?.addEventListener("click", () => openSettingsModal("chat"));
      els.settingsModalCloseBtn?.addEventListener("click", () => closeSettingsDialogWindow());
      document.querySelectorAll("[data-close-modal]").forEach((node) => {
        node.addEventListener("click", () => closeSettingsDialogWindow());
      });
      document.querySelectorAll(".settings-sidebar-btn").forEach((btn) => {
        btn.addEventListener("click", () => switchSettingsPanel(btn.dataset.settingsPanel));
      });
      els.addChatProviderBtn?.addEventListener("click", openPresetPicker);
      // 设置 dialog 模式下也要绑「+ 新增图像渠道」—— 之前漏了，按钮点了没反应
      els.addImageProviderBtn?.addEventListener("click", addImageProvider);
      // 界面语言下拉同理：dialog 分支必须自己绑（bindEvents 只在主面板跑）
      bindUiLanguageControl();
      bindRibbonPositionControl();
      // MCP 客户端设置面板也必须在 dialog 分支 init —— #mcpClientAddBtn / #mcpClientList 只存在于
      // 独立设置窗口，主 TaskPane 的 init 在本分支 return 之后才跑，设置窗口根本跑不到 →
      // 之前点「新增 MCP 服务」没有任何反应（与历史上 addImageProviderBtn 同款漏绑 bug）。
      try {
        global.WpsAiMcpClientUI?.init?.({
          getClients: () => currentSettings.mcpClients || [],
          saveClients: (list) => {
            currentSettings.mcpClients = list;
            try { global.WpsAiProviderRegistry.saveSettings(currentSettings); } catch (e) {}
            try { global.WpsAiMcpClient?.reconcile?.(list); } catch (e) {}
          }
        });
      } catch (e) { console.warn("[mcp-client-ui] settings-dialog init 失败", e); }
      // 打开设置即 reconcile 一次：本窗口是独立实例，主面板的 boot reconcile 跑不到它，
      // 不刷新的话已配置的服务卡片会一直显示「未连接」。init 已订阅 onStatusChange → 结果回来自动重渲染。
      try {
        if (Array.isArray(currentSettings.mcpClients) && currentSettings.mcpClients.length) {
          global.WpsAiMcpClient?.reconcile?.(currentSettings.mcpClients);
        }
      } catch (e) {}
      document.querySelectorAll("[data-close-preset-picker]").forEach((node) => {
        node.addEventListener("click", () => closePresetPicker());
      });
      els.saveSettingsBtn?.addEventListener("click", () => {
        readSettingsFromForm();
        persistSettings();
        showMessage("设置已保存。", "success");
        setTimeout(closeSettingsDialogWindow, 300);
      });
      // dialog 模式的「保存」按钮：只持久化不关闭
      els.saveSettingsOnlyBtn?.addEventListener("click", () => {
        readSettingsFromForm();
        persistSettings();
        showMessage("设置已保存。", "success");
      });
      // dialog 模式下 toggle checkbox 也要自动持久化（用户经常 check 完直接关 X 窗口）
      [
        "splitLayersOnInsertInput",
        "showToolCallLogsInput",
        "aiFollowHighlightInput",
        "mcpServerEnabledInput",
        "updateAutoCheckInput"
      ].forEach((id) => {
        const el = els[id];
        if (!el) return;
        el.addEventListener("change", () => {
          try { readSettingsFromForm(); persistSettings(); } catch (e) {}
        });
      });
      // 导出 / 导入配置（程序信息 panel 的两个按钮）—— 之前只在主 TaskPane bindEvents 里绑，
      // 而设置实际只通过 dialog 模式打开，所以这里也得绑一份。
      els.exportSettingsBtn?.addEventListener("click", exportSettings);
      els.importSettingsBtn?.addEventListener("click", () => els.importSettingsFile?.click());
      els.importSettingsFile?.addEventListener("change", (ev) => {
        const file = ev.target.files?.[0];
        if (file) importSettings(file);
        ev.target.value = "";
      });
      // 技能导入按钮
      els.skillImportBtn?.addEventListener("click", () => els.skillImportFile?.click());
      els.skillImportFile?.addEventListener("change", (ev) => {
        const file = ev.target.files?.[0];
        if (file) handleSkillImport(file);
        ev.target.value = "";
      });
      // 刷新云端技能：从 OSS 目录重新拉取
      els.skillCloudRefreshBtn?.addEventListener("click", async () => {
        const btn = els.skillCloudRefreshBtn;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = "刷新中…";
        try {
          const skills = await global.WpsAiSkills?.loadCloud?.();
          renderSkillsList();
          showMessage(`云端技能已刷新（${(skills || []).length} 个）。`, "success");
        } catch (e) {
          showMessage("云端技能刷新失败：" + (e?.message || e), "error");
        } finally {
          btn.disabled = false; btn.textContent = orig;
        }
      });
      // MCP 服务开关：复用现有 setting 持久化 + 同步切 mcp-bridge 的 start/stop
      els.mcpServerEnabledInput?.addEventListener("change", () => {
        const on = !!els.mcpServerEnabledInput.checked;
        currentSettings.mcpServerEnabled = on;
        try { persistSettings(); } catch (e) {}
        try {
          if (on) global.WpsAiMcpBridge?.start?.();
          else global.WpsAiMcpBridge?.stop?.();
        } catch (e) {}
      });
      // 热更新 UI 绑定 + 初次渲染最近一次检查结果
      els.updateCheckNowBtn?.addEventListener("click", manuallyCheckForUpdate);
      els.updateDownloadBtn?.addEventListener("click", downloadAndApplyUpdate);
      els.updateAutoCheckInput?.addEventListener("change", () => {
        currentSettings.updateAutoCheck = !!els.updateAutoCheckInput.checked;
        try { persistSettings(); } catch (e) {}
      });
      try {
        const cached = global.WpsAiUpdater?.getLastCheck?.();
        if (cached?.result) renderUpdateUi(cached.result);
      } catch (e) {}
      // 设备 SN：默认隐藏（避免普通用户在程序信息面板里被一长串字符迷惑），
      // 双击版本号才展开 + 懒拉取。展开后状态记录在 dataset 上，避免重复请求 proxy。
      els.copyDeviceSnBtn?.addEventListener("click", copyDeviceSn);
      els.aboutDeviceSn?.addEventListener("click", copyDeviceSn);
      els.exportDiagBundleBtn?.addEventListener("click", exportDiagnosticBundle);
      // 官网地址：点链接优先走系统默认浏览器（避免 WPS WebView 里就地跳到白屏）
      els.aboutHomepageLink?.addEventListener("click", (ev) => {
        const url = els.aboutHomepageLink.href;
        if (!url) return;
        // WPS 走 Shell.Application ShellExecute / WPS 官方 openUrl；不行退回 target="_blank" 默认行为
        try {
          const app = global.WpsAiAddon?.getApplicationSync?.();
          if (app && typeof app.OpenUrl === "function") {
            app.OpenUrl(url); ev.preventDefault(); return;
          }
        } catch (e) {}
        try {
          if (global.wps?.OpenUrl) { global.wps.OpenUrl(url); ev.preventDefault(); return; }
        } catch (e) {}
        // 兜底：让 target="_blank" 自己走 —— WebView 会试着开外部浏览器
      });
      els.copyHomepageBtn?.addEventListener("click", async () => {
        const url = els.aboutHomepageLink?.href || "https://wps-ai.llteac.cn/";
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
          else {
            const ta = document.createElement("textarea");
            ta.value = url; ta.style.position = "fixed"; ta.style.left = "-9999px";
            document.body.appendChild(ta); ta.select();
            document.execCommand("copy"); document.body.removeChild(ta);
          }
          showMessage("官网地址已复制", "success", { duration: 2000 });
        } catch (e) {
          showMessage(`复制失败：${e?.message || e}`, "error");
        }
      });
      els.aboutVersion?.addEventListener("dblclick", () => {
        const snRow = document.querySelector(".about-device-sn");
        if (!snRow) return;
        snRow.classList.toggle("hidden");
        if (!snRow.classList.contains("hidden") && els.aboutVersion.dataset.snLoaded !== "1") {
          loadAndRenderDeviceSn();
          els.aboutVersion.dataset.snLoaded = "1";
        }
      });

      // 复制配置 JSON
      els.mcpCopyConfigBtn?.addEventListener("click", async () => {
        const text = els.mcpConfigSnippet?.value || "";
        const ok = await copyToClipboard(text);
        if (ok) showMessage("配置已复制到剪贴板", "success");
        else showMessage("复制失败，请手动选中文本", "error");
      });
      // 开发者工具区：默认隐藏，setupDevToolsSection 内部异步问 proxy /install-path 是 dev 才显示
      setupDevToolsSection();
      // 在独立窗口里"打开"就是直接渲染 settings panel + 让 modal 可见
      // （HTML 标签默认带 .hidden，正常模式下由 openSettingsModal 去除；dialog 模式要手动去）
      els.settingsModal?.classList.remove("hidden");
      renderChatProvidersList();
      // 支持 ?panel=about 之类的初始化跳转（外面点了「新版本」徽章会传 about）
      const m = window.location.search.match(/[?&]panel=([^&]+)/);
      const initialPanel = m ? decodeURIComponent(m[1]) : "chat";
      switchSettingsPanel(initialPanel);
      const sub = window.location.search.match(/[?&]subtab=([^&]+)/);
      if (sub) activateSettingsSubtabByName(decodeURIComponent(sub[1]));
      // X 关闭兜底：用户点 WPS 窗口 × 时，把最后未保存的表单写入 localStorage
      window.addEventListener("beforeunload", () => {
        try { readSettingsFromForm(); persistSettings(); } catch (e) {}
      });
      return; // 不跑下面的 TaskPane 初始化逻辑
    }

    // 独立 PPT 风格预设窗口：只跑 stylePreset 相关的 init
    if (isStylePresetDialog) {
      // 风格 modal 的所有事件绑定（跟主 TaskPane bindEvents 里的同一块）
      els.stylePresetCloseBtn?.addEventListener("click", closeStylePresetDialogWindow);
      els.styleSaveBtn?.addEventListener("click", () => {
        saveStylePreset();
        setTimeout(closeStylePresetDialogWindow, 200);
      });
      els.styleScheme?.addEventListener("change", () => {
        const v = els.styleScheme.value;
        if (v && v !== "custom") applyColorScheme(v);
        updateSchemePreview(v);
        updateLivePreview();
      });
      [
        "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor",
        "styleBackgroundColor", "styleSurfaceColor",
        "styleTitleColor", "styleBodyColor"
      ].forEach((id) => {
        els[id]?.addEventListener("input", markCustomScheme);
      });
      [
        "styleTitleFont", "styleTitleSize", "styleBodyFont", "styleBodySize"
      ].forEach((id) => {
        els[id]?.addEventListener("input", updateLivePreview);
      });
      els.styleTitleBold?.addEventListener("change", updateLivePreview);
      // 直接渲染 + 显示
      openStylePresetModal();
      // X 关闭兜底：用户点 WPS 窗口 × 时静默保存当前表单
      window.addEventListener("beforeunload", () => {
        try { saveStylePreset({ silent: true }); } catch (e) {}
      });
      return; // 不跑下面的 TaskPane 初始化逻辑
    }

    bindTabs();
    bindEvents();
    bindHistory();
    bindQuickPromptModal();
    bindMaterialLibrary();
    bindFormatPreviewModal();
    bindSelectionPreviewModal();
    bindPureMode();
    bindForceUnlock();
    bindImageGenPanel();
    bindCachePanel();
    // 启动就跑一次自动清理（内部有 6h 节流，不会每次开都重扫）
    runCacheAutoCleanIfNeeded().catch(() => {});
    bindConversations();
    bindAttachments();
    consumeMaterialDialogRequests();
    consumeQuickPromptDialogResult();
    consumeFormatPreviewDialogResult();
    consumeSelectionPreviewDialogResult();

    renderProviderState();
    // 启动时先按 chatProviders + defaultModel + 已缓存模型列表把下拉填上（即时可见），
    // 再异步从当前 provider 拉真实模型列表刷新缓存；带退避重试避免跟代理冷启动抢跑
    // 先注入用户持久化的能力覆盖（手动改 / 从错误学到），供应商专属，胜过 models.dev
    try { injectPersistedCapabilityOverrides(); } catch (e) {}
    populateModelSelector(els.modelSelect?.value);
    refreshModelsOnBootWithRetry();

    // 远程能力目录（models.dev）：拉取并注入能力 override，摆脱名字正则硬猜。
    // best-effort、异步；完成后重渲下拉让能力角标按更准的数据刷新。失败静默回退正则。
    try {
      global.WpsAiModelsCatalog?.ensureLoaded?.().then((ok) => {
        if (ok) { try { populateModelSelector(els.modelSelect?.value); } catch (e) {} }
      });
    } catch (e) {}

    // 持久化的 MCP 开关：若用户曾开过就自动起来（只在主 TaskPane，不在 settings/preview dialog）
    try {
      if (currentSettings?.mcpServerEnabled) global.WpsAiMcpBridge?.start?.();
    } catch (e) {}

    // MCP Client：启动时连接用户配置的外部 MCP 服务
    try {
      if (global.WpsAiMcpClient && Array.isArray(currentSettings.mcpClients) && currentSettings.mcpClients.length) {
        global.WpsAiMcpClient?.reconcile?.(currentSettings.mcpClients);
      }
    } catch (e) { console.warn("[mcp-client] boot reconcile 失败", e); }

    // MCP Client 设置面板：卡片列表 / 启停开关 / 工具参数查看 / 增删改表单
    try {
      global.WpsAiMcpClientUI?.init?.({
        getClients: () => currentSettings.mcpClients || [],
        saveClients: (list) => {
          currentSettings.mcpClients = list;
          try { global.WpsAiProviderRegistry.saveSettings(currentSettings); } catch (e) {}
          try { global.WpsAiMcpClient?.reconcile?.(list); } catch (e) {}
        }
      });
    } catch (e) { console.warn("[mcp-client-ui] init 失败", e); }

    // 启动时静默检查更新（仅当用户开了「启动时自动检查更新」）
    try { startupAutoCheckUpdate(); } catch (e) {}

    // ⚙ 点击：打开独立的 WPS Dialog 窗口（脱离 TaskPane 宽度限制）
    els.openSettingsModalBtn?.addEventListener("click", () => openSettingsAsDialog());
    els.settingsModalCloseBtn?.addEventListener("click", () => closeSettingsModal());

    // 顶栏「新版本」呼吸徽章：直接跳设置→程序信息，让用户看 changelog + 下载
    els.updateAvailableBadge?.addEventListener("click", () => openSettingsAsDialog("about", "about-update"));
    // 顶栏灰度徽章：同样跳到程序信息，让用户知道自己在灰度通道
    els.canaryHeaderBadge?.addEventListener("click", () => openSettingsAsDialog("about", "about-update"));

    // 停靠/浮动 切换按钮。Mac/Linux 主面板已是浮窗，直接隐藏该按钮（无需脱离/停靠）。
    if (preferFloatingPanel()) els.dockToggleBtn?.classList.add("hidden");
    els.dockToggleBtn?.addEventListener("click", () => {
      const nowFloating = global.WpsAiAddon?.toggleTaskPaneDock?.();
      if (nowFloating == null) {
        showMessage("当前 WPS 版本不支持改 TaskPane 停靠方式。", "error");
        return;
      }
      // 浮动模式：清掉 syncPaneWidth 强制设的内联固定宽度，让 body 用 CSS 100% 跟随
      // 窗口缩放（不然 WPS 改了 pane 尺寸我们也不重排，看上去就是"无法调整大小"）
      if (nowFloating) {
        document.documentElement.style.width = "";
        if (document.body) document.body.style.width = "";
      } else {
        // 切回停靠：立刻按 innerWidth 重新对齐 Mac WPS 的固定宽度模式
        syncPaneWidth("re-dock");
      }
      refreshDockToggleUI();
      showMessage(nowFloating ? "已切到浮动窗口。拖窗口边框调大小，再点一次回到右侧停靠。" : "已停靠到右侧。", "info");
    });
    refreshDockToggleUI();
    bindFloatingResizeHandles();
    document.querySelectorAll("[data-close-modal]").forEach((node) => {
      node.addEventListener("click", () => closeSettingsModal());
    });
    document.querySelectorAll(".settings-sidebar-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchSettingsPanel(btn.dataset.settingsPanel));
    });
    els.addChatProviderBtn?.addEventListener("click", openPresetPicker);
    document.querySelectorAll("[data-close-preset-picker]").forEach((node) => {
      node.addEventListener("click", () => closePresetPicker());
    });
    // Esc 关闭
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (!els.presetPickerModal?.classList.contains("hidden")) { closePresetPicker(); return; }
      if (!els.settingsModal?.classList.contains("hidden")) closeSettingsModal();
    });

    if (!global.wps?.WpsApplication) {
      global.WpsAiAddon?.getAddonApi?.().catch((error) => {
        showMessage(`插件 SDK 初始化失败：${error.message || String(error)}`, "error");
      });
    }

    detectHost();

    // 监听 ribbon 快捷指令（通过 Application.PluginStorage 投递）
    startPendingActionWatcher();
    // 整套 PPT 生成进度（修 #6）
    startFullDeckProgressWatcher();

    // 加载版本号 + 绑定可折叠卡片
    loadVersionInfo();
    updateProxyStatusBadge({ scanOnFail: true }).catch(() => {});
    bindCollapsibleCards();
    bindSettingsSubtabs();

    // 启动能力 chip + 「附加当前 PDF」按钮的初始状态；每 1.5s 复查活动文档变化
    updateCapabilityBadges();
    setInterval(updateAttachActiveBtn, 1500);
  });

  // ============ 缓存管理 UI ============
  //
  // 让用户看到 localStorage + proxy 侧到底攒了多少数据，可按组或单条清。
  // 分组由 WpsAiCache.CATEGORIES 决定；safe=false 的组（历史 / 设置）
  // 用橘色标记，清之前给 confirm。
  async function renderCachePanel() {
    const mod = global.WpsAiCache;
    if (!mod || !els.cacheGroupsList) return;
    els.cacheGroupsList.innerHTML = '<p class="muted" style="font-size:11px;margin:0">扫描中…</p>';
    let data;
    try { data = await mod.scan(); } catch (e) {
      els.cacheGroupsList.innerHTML = `<p class="muted" style="font-size:11px">扫描失败：${escapeHtml(String(e?.message || e))}</p>`;
      return;
    }
    if (els.cacheTotalBadge) els.cacheTotalBadge.textContent = `总计 ${mod.fmtBytes(data.grandTotalBytes)}`;

    const parts = [];
    // localStorage 分组
    for (const g of data.local.groups) {
      const chip = g.safe ? "" : `<span class="cache-group-warn" title="清了会丢历史/设置">谨慎</span>`;
      const rows = g.items.map((it) => {
        const ts = it.updatedAt ? `<span class="cache-item-ts">${fmtTime(it.updatedAt)}</span>` : "";
        return `
          <div class="cache-item" data-key="${escapeHtml(it.key)}">
            <code class="cache-item-key" title="${escapeHtml(it.key)}">${escapeHtml(it.key)}</code>
            ${ts}
            <span class="cache-item-size">${mod.fmtBytes(it.bytes)}</span>
            <button type="button" class="ghost-btn compact-btn cache-item-clear-btn" data-clear-key="${escapeHtml(it.key)}">清除</button>
          </div>`;
      }).join("");
      parts.push(`
        <div class="cache-group ${g.safe ? "" : "cache-group-unsafe"}">
          <div class="cache-group-head">
            <span class="cache-group-label">${escapeHtml(g.label)}</span>
            ${chip}
            <span class="cache-group-size">${mod.fmtBytes(g.bytes)} · ${g.items.length} 项</span>
            <button type="button" class="ghost-btn compact-btn cache-group-clear-btn" data-clear-group="${escapeHtml(g.label)}">清除本组</button>
          </div>
          <div class="cache-group-body">${rows}</div>
        </div>`);
    }
    // proxy 侧 buckets
    if (data.proxy && data.proxy.length) {
      const bucketRows = data.proxy.map((b) => {
        const chip = b.safe ? "" : `<span class="cache-group-warn" title="清了会丢改动记录恢复能力">谨慎</span>`;
        return `
          <div class="cache-item" data-bucket="${escapeHtml(b.name)}">
            <code class="cache-item-key" title="${escapeHtml(b.path || "")}">${escapeHtml(b.label)}</code>
            ${chip}
            <span class="cache-item-size">${mod.fmtBytes(b.bytes)} · ${b.itemCount} 项</span>
            <button type="button" class="ghost-btn compact-btn cache-item-clear-btn" data-clear-bucket="${escapeHtml(b.name)}">清除</button>
          </div>`;
      }).join("");
      parts.push(`
        <div class="cache-group">
          <div class="cache-group-head">
            <span class="cache-group-label">proxy 本地目录</span>
            <span class="cache-group-size">${mod.fmtBytes(data.proxy.reduce((s, b) => s + b.bytes, 0))} · ${data.proxy.length} 项</span>
          </div>
          <div class="cache-group-body">${bucketRows}</div>
        </div>`);
    }
    if (!parts.length) {
      els.cacheGroupsList.innerHTML = '<p class="muted" style="font-size:11px;margin:0">当前没有缓存数据。</p>';
      return;
    }
    els.cacheGroupsList.innerHTML = parts.join("");

    // 绑定单条 / 整组 / proxy 清除按钮
    els.cacheGroupsList.querySelectorAll(".cache-item-clear-btn[data-clear-key]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.clearKey;
        if (!confirm(i18nT("确认清除 {key}？", { key }))) return;
        await mod.clearKey(key);
        await renderCachePanel();
      });
    });
    els.cacheGroupsList.querySelectorAll(".cache-item-clear-btn[data-clear-bucket]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.clearBucket;
        if (!confirm(i18nT("确认清除 proxy 侧 {name} 目录？", { name }))) return;
        const r = await mod.clearProxyBucket(name);
        showMessage(r?.ok ? `已清 ${r.removed} 项` : `清除失败：${r?.error || "未知"}`,
                    r?.ok ? "success" : "error");
        await renderCachePanel();
      });
    });
    els.cacheGroupsList.querySelectorAll(".cache-group-clear-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const label = btn.dataset.clearGroup;
        const cat = mod.CATEGORIES.find((c) => c.label === label);
        const warn = cat && !cat.safe ? "\n\n⚠ 这个组是历史 / 设置数据，清了不能恢复。" : "";
        if (!confirm(`确认清除整组「${label}」？${warn}`)) return;
        await mod.clearGroup(label);
        await renderCachePanel();
      });
    });
  }

  // ---- 缓存自动清理策略 ----
  // 用户之前抱怨：缓存管理只有"手动清"，装了半年不管的话本地会攒到几百 MB。
  // 支持两条规则同时生效：
  //   （1）超龄清理：safe 组里 updatedAt 早于 now - N 天的单项直接删。
  //   （2）过大清理：总占用 > M MB 时，直接执行 clearAllSafe（unsafe 组不动）。
  // 触发时机：TaskPane 启动一次；用户手动点缓存面板"刷新"再来一次；用户改设置后 immediate。
  const CACHE_AUTO_CLEAN_KEY = "wpsAiCacheAutoCleanPolicy";
  const CACHE_AUTO_CLEAN_LAST_RUN_KEY = "wpsAiCacheAutoCleanLastRunAt";
  const CACHE_AUTO_CLEAN_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h：避免每次进面板都跑

  function readCacheAutoCleanPolicy() {
    try {
      const raw = global.WpsAiStore.getItem(CACHE_AUTO_CLEAN_KEY);
      if (!raw) return { enabled: false, maxAgeDays: 30, maxSizeMB: 100 };
      const p = JSON.parse(raw);
      return {
        enabled: !!p.enabled,
        maxAgeDays: Math.max(1, Math.min(365, Number(p.maxAgeDays) || 30)),
        maxSizeMB: Math.max(10, Math.min(10240, Number(p.maxSizeMB) || 100))
      };
    } catch (e) {
      return { enabled: false, maxAgeDays: 30, maxSizeMB: 100 };
    }
  }

  function writeCacheAutoCleanPolicy(p) {
    try { global.WpsAiStore.setItem(CACHE_AUTO_CLEAN_KEY, JSON.stringify(p)); } catch (e) {}
  }

  function setCacheAutoCleanStatus(text, tone) {
    if (!els.cacheAutoCleanStatus) return;
    els.cacheAutoCleanStatus.textContent = text || "";
    els.cacheAutoCleanStatus.className = "cache-auto-clean-status" + (tone ? ` cache-auto-clean-status-${tone}` : "");
  }

  async function runCacheAutoCleanIfNeeded(opts = {}) {
    const mod = global.WpsAiCache;
    if (!mod) return;
    const policy = readCacheAutoCleanPolicy();
    if (!policy.enabled) return;
    if (!opts.force) {
      let lastRun = 0;
      try { lastRun = Number(global.WpsAiStore.getItem(CACHE_AUTO_CLEAN_LAST_RUN_KEY)) || 0; } catch (e) {}
      if (Date.now() - lastRun < CACHE_AUTO_CLEAN_MIN_INTERVAL_MS) return;
    }
    let data;
    try { data = await mod.scan(); } catch (e) { return; }
    const summary = [];
    // 规则 1：过大 → clearAllSafe 一把清
    const maxBytes = policy.maxSizeMB * 1024 * 1024;
    if (data.grandTotalBytes > maxBytes) {
      const r = await mod.clearAllSafe();
      summary.push(`总占用 ${mod.fmtBytes(data.grandTotalBytes)} > ${policy.maxSizeMB}MB，已清 ${r.cleared} 项`);
    } else {
      // 规则 2：单项过龄 → 只删 safe 组里 updatedAt 早于阈值的
      const ageMs = policy.maxAgeDays * 24 * 3600 * 1000;
      const cutoff = Date.now() - ageMs;
      let killed = 0;
      for (const g of data.local.groups) {
        if (!g.safe) continue;
        for (const it of g.items) {
          if (it.updatedAt && it.updatedAt < cutoff) {
            await mod.clearKey(it.key);
            killed += 1;
          }
        }
      }
      if (killed > 0) summary.push(`清理超 ${policy.maxAgeDays} 天未更新的 ${killed} 项 safe 缓存`);
    }
    try { global.WpsAiStore.setItem(CACHE_AUTO_CLEAN_LAST_RUN_KEY, String(Date.now())); } catch (e) {}
    if (summary.length && els.cacheAutoCleanStatus) {
      setCacheAutoCleanStatus(`自动清理已执行：${summary.join("；")}`, "ok");
    }
  }

  function bindCacheAutoCleanUI() {
    const policy = readCacheAutoCleanPolicy();
    if (els.cacheAutoCleanEnabled) els.cacheAutoCleanEnabled.checked = policy.enabled;
    if (els.cacheAutoCleanMaxAge) els.cacheAutoCleanMaxAge.value = String(policy.maxAgeDays);
    if (els.cacheAutoCleanMaxSize) els.cacheAutoCleanMaxSize.value = String(policy.maxSizeMB);

    const commit = async () => {
      const next = {
        enabled: !!els.cacheAutoCleanEnabled?.checked,
        maxAgeDays: Math.max(1, Math.min(365, Number(els.cacheAutoCleanMaxAge?.value) || 30)),
        maxSizeMB: Math.max(10, Math.min(10240, Number(els.cacheAutoCleanMaxSize?.value) || 100))
      };
      writeCacheAutoCleanPolicy(next);
      if (next.enabled) {
        setCacheAutoCleanStatus("策略已保存。将在 6 小时窗口 + 面板刷新时按规则清理。", "muted");
        await runCacheAutoCleanIfNeeded({ force: true });
        await renderCachePanel();
      } else {
        setCacheAutoCleanStatus("自动清理已关闭。", "muted");
      }
    };
    els.cacheAutoCleanEnabled?.addEventListener("change", commit);
    els.cacheAutoCleanMaxAge?.addEventListener("change", commit);
    els.cacheAutoCleanMaxSize?.addEventListener("change", commit);
  }

  function bindCachePanel() {
    bindCacheAutoCleanUI();
    if (els.cacheRefreshBtn) {
      els.cacheRefreshBtn.addEventListener("click", async () => {
        await runCacheAutoCleanIfNeeded();
        await renderCachePanel();
      });
    }
    if (els.cacheClearSafeBtn) {
      els.cacheClearSafeBtn.addEventListener("click", async () => {
        const mod = global.WpsAiCache;
        if (!mod) return;
        if (!confirm("清除所有安全缓存（预览中间态 / 版本检查 / 模型列表 / 运行时探测）？\n\n设置和历史不动。")) return;
        const r = await mod.clearAllSafe();
        showMessage(`已清 ${r.cleared} 项`, "success");
        await renderCachePanel();
      });
    }
  }

  // 拉 package.json 拿到版本号显示在 header 和 about 两处。
  // 带 _ts 时间戳强制 URL 唯一，绕过 WPS WebView2 的磁盘级 HTTP 缓存
  // （fetch cache:"no-store" + 服务端 no-cache header 在 Win 上都不完全管用）。
  async function loadVersionInfo() {
    let v = "—";
    try {
      const resp = await fetch(`./package.json?_ts=${Date.now()}`, { cache: "no-store" });
      if (resp.ok) {
        const pkg = await resp.json();
        if (pkg?.version) v = pkg.version;
      }
    } catch (e) { /* 静默 */ }
    if (els.brandVersion) els.brandVersion.textContent = `v${v}`;
    if (els.aboutVersion) els.aboutVersion.textContent = `v${v}`;
  }

  // ============ 热更新 UI ============
  let _latestManifest = null; // 最近一次 checkForUpdate 返回的 manifest，下载用

  function renderUpdateUi(result, opts) {
    // result = { current, latest, updateAvailable, manifest, checkedAt, channel, canaryReason, deviceSn } | null
    // 顶栏「新版本」呼吸徽章：在主 TaskPane（非 dialog）展示，点了跳设置→程序信息
    if (els.updateAvailableBadge) {
      const showBadge = !!result?.updateAvailable;
      els.updateAvailableBadge.classList.toggle("hidden", !showBadge);
      if (showBadge) {
        els.updateAvailableBadge.title = `发现新版本 v${result.latest}（当前 v${result.current}），点击查看`;
      }
    }
    if (!els.updateStatusBadge) return;
    // 通道徽章一直渲染（即使没检查过也告诉用户当前在哪条通道）
    const channel = result?.channel || "stable";
    if (els.updateChannelBadge) {
      els.updateChannelBadge.textContent = channel === "canary"
        ? (result?.canaryReason === "rollout" ? "canary (rollout)" : "canary (whitelist)")
        : "stable";
      els.updateChannelBadge.className = "badge " + (channel === "canary" ? "badge-warning" : "badge-muted");
      els.updateChannelBadge.title = channel === "canary"
        ? "你的设备 SN 在灰度白名单内或落在 rollout 百分比内，会优先拿到 canary 版本"
        : "你走正式通道。灰度版本在 SN 进白名单后才会拿到";
    }
    // 主头栏灰度提示：canary 用户平时看不到自己在灰度通道，出了问题排障困难；
    // 用 header 徽章明示，点了跳到设置 → 程序信息看详情
    if (els.canaryHeaderBadge) {
      const showCanary = channel === "canary";
      els.canaryHeaderBadge.classList.toggle("hidden", !showCanary);
      if (showCanary) {
        const reason = result?.canaryReason === "rollout" ? "rollout" : "whitelist";
        els.canaryHeaderBadge.title = `你正在使用灰度（canary/${reason}）版本。点击进设置 → 程序信息查看详情 / 回退。`;
      }
    }
    if (!result) {
      els.updateStatusBadge.textContent = "未检查";
      els.updateStatusBadge.className = "badge badge-muted";
      if (els.updateLastCheckedAt) els.updateLastCheckedAt.textContent = "—";
      if (els.updateLatestVersion) els.updateLatestVersion.textContent = "—";
      if (els.updateChangelog) els.updateChangelog.style.display = "none";
      if (els.updateDownloadBtn) els.updateDownloadBtn.style.display = "none";
      return;
    }
    if (els.updateLastCheckedAt) {
      const d = new Date(result.checkedAt);
      els.updateLastCheckedAt.textContent = d.toLocaleString();
    }
    if (els.updateLatestVersion) els.updateLatestVersion.textContent = "v" + (result.latest || "—");
    if (result.updateAvailable) {
      els.updateStatusBadge.textContent = "有新版本";
      els.updateStatusBadge.className = "badge badge-warning";
      _latestManifest = result.manifest;
      if (els.updateChangelog && result.manifest?.changelog) {
        els.updateChangelog.textContent = result.manifest.changelog;
        els.updateChangelog.style.display = "block";
      } else if (els.updateChangelog) {
        els.updateChangelog.style.display = "none";
      }
      if (els.updateDownloadBtn) els.updateDownloadBtn.style.display = "";
    } else {
      els.updateStatusBadge.textContent = "已是最新";
      els.updateStatusBadge.className = "badge badge-success";
      _latestManifest = null;
      if (els.updateChangelog) els.updateChangelog.style.display = "none";
      if (els.updateDownloadBtn) els.updateDownloadBtn.style.display = "none";
    }
  }

  async function manuallyCheckForUpdate() {
    if (!global.WpsAiUpdater) {
      showMessage("热更新模块未加载", "error");
      return;
    }
    if (els.updateCheckNowBtn) els.updateCheckNowBtn.disabled = true;
    try {
      const result = await global.WpsAiUpdater.checkForUpdate({ force: true });
      renderUpdateUi(result);
      if (result.updateAvailable) {
        showMessage(`发现新版本 v${result.latest}（当前 v${result.current}）`, "success");
      } else {
        showMessage(`已是最新（v${result.current}）`, "info");
      }
    } catch (e) {
      showMessage(`检查更新失败：${e?.message || e}`, "error");
    } finally {
      if (els.updateCheckNowBtn) els.updateCheckNowBtn.disabled = false;
    }
  }

  async function downloadAndApplyUpdate() {
    if (!_latestManifest) {
      showMessage("没有可下载的更新（先点检查更新）", "info");
      return;
    }
    if (!confirm(`即将下载并安装 v${_latestManifest.version}。\n\n安装会覆盖当前插件文件，完成后需要重启 WPS 让新版本生效。继续吗？`)) return;
    const btn = els.updateDownloadBtn;
    if (btn) { btn.disabled = true; btn.textContent = "下载中…"; }
    try {
      const r = await global.WpsAiUpdater.downloadAndApply(_latestManifest, (p) => {
        if (btn && p.step === "extract") btn.textContent = "解压中…";
        if (btn && p.step === "done") btn.textContent = "已完成";
      });
      showMessage(r?.message || "更新已安装，请重启 WPS。", "success", { duration: 8000 });
      // 自动开始检查 → 渲染会清掉「有新版本」状态（也可下次启动时清掉）
      try { global.WpsAiUpdater.clearCache(); } catch (e) {}
      // 立即刷 header / about 里的版本号，让用户不用等重启也能看到新版本落地
      // （文件已被覆盖，fetch 加了时间戳能拿到新 package.json）
      try { await loadVersionInfo(); } catch (e) {}
    } catch (e) {
      showMessage(`安装失败：${e?.message || e}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "下载并安装";
        btn.style.display = "none"; // 安装完成隐藏，下次有新版再出现
      }
    }
  }

  // 启动时按设置静默检查（不抛 toast，结果直接渲染到 UI）
  async function startupAutoCheckUpdate() {
    if (!currentSettings?.updateAutoCheck) return;
    if (!global.WpsAiUpdater) return;
    try {
      const result = await global.WpsAiUpdater.checkForUpdate({ force: false });
      renderUpdateUi(result);
      if (result.updateAvailable) {
        // 顶部一条不打扰的提示
        showMessage(`发现新版本 v${result.latest}，可在设置 → 程序信息里查看`, "info", { duration: 6000 });
      }
    } catch (e) {
      plog?.("updater", "auto-check failed:", e?.message);
    }
  }

  // 设备 SN：从 proxy 拿一次后渲染到关于面板，并支持点击 / 按钮复制。
  // 灰度白名单管理员需要这个 SN 才能把当前设备加进 canary 通道。
  async function loadAndRenderDeviceSn() {
    const span = els.aboutDeviceSn;
    if (!span) return;
    const Up = global.WpsAiUpdater;
    if (!Up?.getDeviceSn) { span.textContent = "—"; return; }
    span.textContent = "读取中…";
    span.dataset.sn = "";
    try {
      const sn = await Up.getDeviceSn();
      if (sn) {
        span.textContent = sn;
        span.dataset.sn = sn;
        span.title = `点击复制 · 来源 localStorage 或 proxy /device-sn`;
      } else {
        // 区分原因：先快速 ping 一下 proxy 看是否在线
        const proxyAlive = await fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/mcp/status", { method: "GET" })
          .then((r) => r.ok).catch(() => false);
        span.textContent = proxyAlive ? "(SN 读取失败 · 看 proxy 日志)" : "(代理离线 · 启动 npm run proxy)";
        span.title = proxyAlive
          ? "proxy 在线但 /device-sn 没拿到值。看 proxy 终端 [device-sn] 日志诊断"
          : `本地代理 ${global.WpsAiRuntime?.proxyBase?.() || "127.0.0.1:3890"} 不通。dev 模式下要等 proxy 完全启动，或手动 npm run proxy`;
      }
    } catch (e) {
      span.textContent = "—";
    }
  }
  function copyDeviceSn() {
    const span = els.aboutDeviceSn;
    const sn = span?.dataset?.sn || span?.textContent?.trim();
    if (!sn || sn === "—" || sn === "读取中…" || sn === "(代理离线)") {
      showMessage("SN 还没拿到，稍后再试", "info");
      return;
    }
    // navigator.clipboard 在 WPS WebView 里部分版本不可用，做 fallback
    const ok = (txt) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(txt).then(
          () => showMessage(`已复制 SN：${txt}`, "success"),
          () => fallback(txt)
        );
      } else fallback(txt);
    };
    const fallback = (txt) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
        showMessage(`已复制 SN：${txt}`, "success");
      } catch (e) { showMessage("复制失败，请手动选中文本复制", "error"); }
    };
    ok(sn);
  }

  function bindCollapsibleCards() {
    document.querySelectorAll(".collapsible-card .card-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cardId = btn.getAttribute("data-toggle-card");
        const card = cardId ? document.getElementById(cardId) : btn.closest(".collapsible-card");
        if (!card) return;
        card.classList.toggle("expanded");
      });
    });
  }

  // ---- ribbon 快捷输入弹窗 ----
  let quickPromptState = null;
  let quickPromptBound = false;
  let quickPromptDialogResultWritten = false;
  let quickPromptDialogPollTimer = null;
  let lastQuickPromptResultTs = 0;

  function hydrateQuickPromptPayload(payload) {
    const out = Object.assign({}, payload || {});
    const action = global.WpsAiQuickActions?.findByKey?.(out.host, out.key);
    if (action) {
      if (!out.label) out.label = action.label;
      if (!out.prompt) out.prompt = action.prompt;
      out.prefill = !!(out.prefill || action.prefill);
      out.optionalInput = !!(out.optionalInput || action.optionalInput);
      out.attachActivePdf = !!(out.attachActivePdf || action.attachActivePdf);
    }
    return out;
  }

  function isImageQuickPrompt(payload) {
    return payload?.key === "image";
  }

  function shouldUseMultilineQuickPromptInput(payload) {
    return payload?.host === "pdf" && payload?.key === "qa";
  }

  function extractQuickPromptPlaceholders(prompt) {
    const text = String(prompt || "");
    const result = [];
    // {{...}} 是规范的填空占位符；[...] 向后兼容旧 prompt，
    // 但排除像 [P3] 这类页码/引用标记（PDF 对照翻译/问答 prompt 里的内容示例，不是用户输入）。
    const re = /\{\{([^}]+)\}\}|\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(text))) {
      const isBrace = m[1] != null;
      const label = (isBrace ? m[1] : m[2]).trim();
      if (!isBrace && /^P\d+$/i.test(label)) continue; // 页码标记 [P3]，跳过
      result.push({ raw: m[0], label, index: m.index });
    }
    return result;
  }

  function cleanQuickPromptLabel(text) {
    return String(text || "")
      .replace(/^在这里(?:写|输入|描述|填写)?\s*/i, "")
      .trim() || "补充内容";
  }

  function buildImageQuickPrompt(payload, imagePrompt, insertAtCursor, chosenSize) {
    const host = payload?.host || currentHostInfo?.host || "wps";
    const insertRule = (() => {
      if (!insertAtCursor) {
        return "只调用 generate_image 生成图片，不要调用 wps_insert_image / wpp_add_picture / et_insert_image 等插入工具。generate_image 会自动把结果记录到素材库。";
      }
      if (host === "wpp") {
        return "再用 wpp_add_picture 把拿到的图片 URL 作为 fileName 传进去（建议参数 left=80, top=120, width=560），插入到当前幻灯片的合适位置。";
      }
      if (host === "et") {
        return "再用 et_insert_image 把拿到的图片 URL 作为 fileName 传进去（建议 width=240），插入到当前工作表。";
      }
      return "再用 wps_insert_image 把拿到的图片 URL 作为 fileName 传进去，插入到当前光标位置。";
    })();
    const sizeHint = (chosenSize && String(chosenSize).trim())
      ? `调 generate_image 时 size 必须传「${String(chosenSize).trim()}」（用户本次指定的比例），不要改成别的。`
      : (host === "wpp"
        ? "调 generate_image 时请基于提示词内容自行决定 size：PPT 主图/封面默认 16:9；其它情况按内容判断。除非用户提示词明确写了比例/尺寸，否则不要省略 size。"
        : host === "et"
          ? "调 generate_image 时请基于提示词内容自行决定 size：表格里通常是说明/示意图，默认 4:3 或 1:1；其它情况按内容判断。除非用户提示词明确写了比例/尺寸，否则不要省略 size。"
          : "调 generate_image 时请基于提示词与当前文档语境自行决定 size：封面/章节配图用 16:9，竖向人物/插画用 9:16 或 2:3，方形小图/Logo 用 1:1，正文横向插图用 3:2。除非用户提示词明确写了比例/尺寸，否则不要省略 size。");
    return [
      "请根据下面的生图提示词生成 1 张图片。",
      "",
      "【生图提示词】",
      imagePrompt,
      "",
      "【执行要求】",
      "先调用 generate_image 拿到图片 URL。",
      sizeHint,
      insertRule
    ].join("\n");
  }

  function buildGenericQuickPrompt(payload) {
    const prompt = String(payload?.prompt || "");
    const placeholders = quickPromptState?.placeholders || extractQuickPromptPlaceholders(prompt);
    const optional = !!payload?.optionalInput;
    if (!placeholders.length || placeholders.every((ph) => !ph.raw)) {
      const extra = String(els.quickPromptBody?.querySelector('[data-quick-prompt-index="0"]')?.value || "").trim();
      if (!extra) {
        // optionalInput=true：用户没填补充要求也允许直接发，按原 prompt 走
        if (optional) return prompt;
        throw new Error("请先填写补充要求。");
      }
      return [prompt, "", "补充要求：" + extra].filter(Boolean).join("\n");
    }
    let finalPrompt = prompt;
    for (let i = 0; i < placeholders.length; i += 1) {
      const ph = placeholders[i];
      const input = els.quickPromptBody?.querySelector(`[data-quick-prompt-index="${i}"]`);
      const value = String(input?.value || "").trim();
      if (!value) {
        if (optional) continue; // 占位也允许留空，留原文不替换
        throw new Error(`请先填写「${cleanQuickPromptLabel(ph.label)}」。`);
      }
      finalPrompt = finalPrompt.replace(ph.raw, value);
    }
    return finalPrompt;
  }

  function quickPromptPasteButton(targetId) {
    return `
      <button type="button" class="quick-prompt-paste-btn" data-role="quick-prompt-paste" data-target="${escapeAttr(targetId)}" title="粘贴剪贴板内容" aria-label="粘贴剪贴板内容">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1"/>
        </svg>
      </button>
    `;
  }

  function renderQuickPromptForm(payload) {
    if (!els.quickPromptBody) return;
    const label = payload.label || "快捷操作";
    const optional = !!payload?.optionalInput;
    if (els.quickPromptTitle) els.quickPromptTitle.textContent = label;
    if (els.quickPromptSubtitle) {
      els.quickPromptSubtitle.textContent = isImageQuickPrompt(payload)
        ? "输入生图提示词，生成后可选择是否插入当前位置。"
        : (optional
          ? "可选择补充要求；不填则直接按默认指令执行。"
          : "填写必要内容后会自动发送给 AI。");
    }
    // 「补充要求」可空场景下，把"开始执行"按钮文案改成"直接执行 / 加要求执行"两态——
    // 用 placeholder 自动联动太复杂，直接长一些的提示更直观
    if (els.quickPromptSubmitBtn) {
      els.quickPromptSubmitBtn.textContent = optional ? "开始执行（可不填）" : "开始执行";
    }

    if (isImageQuickPrompt(payload)) {
      const defSize = (currentSettings?.imageSizeOverride) || "";
      const ratios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
      const ratioOpts = ['<option value="">自动（按内容判断）</option>']
        .concat(ratios.map((r) => `<option value="${r}"${defSize === r ? " selected" : ""}>${r}</option>`))
        .join("");
      els.quickPromptBody.innerHTML = `
        <div class="quick-prompt-field">
          <label class="quick-prompt-label" for="quickPromptImageInput">生图提示词</label>
          <div class="quick-prompt-input-wrap">
            <textarea id="quickPromptImageInput" class="quick-prompt-image-input" rows="7" placeholder="例如：科技感的报告封面，深蓝色背景，柔和光影，商务风格"></textarea>
            ${quickPromptPasteButton("quickPromptImageInput")}
          </div>
        </div>
        <div class="quick-prompt-field">
          <label class="quick-prompt-label" for="quickPromptImageSize">图片比例（本次）</label>
          <select id="quickPromptImageSize" class="quick-prompt-image-size">${ratioOpts}</select>
        </div>
        <div class="quick-prompt-options">
          <label class="quick-prompt-option">
            <input id="quickPromptInsertAtCursor" type="checkbox" checked />
            <span>生成后插入到当前位置。不勾选时只生成图片并记录到素材库。</span>
          </label>
        </div>
      `;
      return;
    }

    const placeholders = extractQuickPromptPlaceholders(payload.prompt);
    quickPromptState.placeholders = placeholders;
    if (!placeholders.length) {
      const fieldLabel = optional ? "补充要求（可不填）" : "补充要求";
      const placeholderText = optional
        ? "想加要求就填，比如：续写 3 段 / 偏学术风格 / 围绕 XX 展开。不填就直接执行。"
        : "输入要补充给 AI 的内容";
      els.quickPromptBody.innerHTML = `
        <div class="quick-prompt-field">
          <label class="quick-prompt-label" for="quickPromptInput0">${escapeHtml(fieldLabel)}</label>
          <div class="quick-prompt-input-wrap">
            <textarea id="quickPromptInput0" data-quick-prompt-index="0" class="quick-prompt-text-input" rows="4" placeholder="${escapeAttr(placeholderText)}"></textarea>
            ${quickPromptPasteButton("quickPromptInput0")}
          </div>
        </div>
      `;
      quickPromptState.placeholders = [{ raw: "", label: "补充要求" }];
      return;
    }

    els.quickPromptBody.innerHTML = placeholders.map((ph, i) => {
      const cleanLabel = cleanQuickPromptLabel(ph.label);
      const isShort = cleanLabel.length <= 18 && !/[，。,.\n]/.test(cleanLabel);
      const useMultiline = shouldUseMultilineQuickPromptInput(payload);
      const control = isShort
        ? (useMultiline
          ? `<textarea id="quickPromptInput${i}" data-quick-prompt-index="${i}" class="quick-prompt-text-input" rows="5" placeholder="${escapeAttr(cleanLabel)}"></textarea>`
          : `<input id="quickPromptInput${i}" data-quick-prompt-index="${i}" type="text" placeholder="${escapeAttr(cleanLabel)}" />`)
        : `<textarea id="quickPromptInput${i}" data-quick-prompt-index="${i}" class="quick-prompt-text-input" rows="${useMultiline ? "5" : "3"}" placeholder="${escapeAttr(cleanLabel)}"></textarea>`;
      return `
        <div class="quick-prompt-field">
          <label class="quick-prompt-label" for="quickPromptInput${i}">${escapeHtml(cleanLabel)}</label>
          <div class="quick-prompt-input-wrap">
            ${control}
            ${quickPromptPasteButton(`quickPromptInput${i}`)}
          </div>
        </div>
      `;
    }).join("");
  }

  function focusQuickPromptFirstInput() {
    setTimeout(() => {
      const first = els.quickPromptBody?.querySelector("textarea, input[type='text']");
      first?.focus?.();
    }, 50);
  }

  function openQuickPromptInline(payload) {
    const hydrated = hydrateQuickPromptPayload(payload);
    if (!hydrated.prompt && !isImageQuickPrompt(hydrated)) {
      showMessage("未找到快捷操作指令。", "error", { autoHide: false });
      return false;
    }
    quickPromptState = {
      payload: hydrated,
      placeholders: extractQuickPromptPlaceholders(hydrated.prompt)
    };
    renderQuickPromptForm(hydrated);
    els.quickPromptModal?.classList.remove("hidden");
    focusQuickPromptFirstInput();
    return true;
  }

  function resetQuickPromptStateIfNeeded() {
    if (!isQuickPromptDialog) quickPromptDialogResultWritten = false;
  }

  function closeQuickPromptModal(cancelled = true) {
    if (isQuickPromptDialog && cancelled) {
      writeQuickPromptDialogResult({ cancelled: true });
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.quickPromptModal?.classList.add("hidden");
    quickPromptState = null;
  }

  function writeQuickPromptDialogResult(result) {
    if (!isQuickPromptDialog || quickPromptDialogResultWritten) return;
    quickPromptDialogResultWritten = true;
    const blob = Object.assign({ ts: Date.now() }, result || {});
    try { localStorage.setItem(QUICK_PROMPT_DIALOG_RESULT_KEY, JSON.stringify(blob)); } catch (e) {}
  }

  async function runQuickPromptResult(payload, finalPrompt) {
    const text = String(finalPrompt || "").trim();
    if (!text) return;
    activateTab("ai");
    // 快捷指令来源：聊天流里折叠成操作盒子（只显示按钮文字，可展开看完整提示词）
    const turnOpts = payload?.label ? { quickAction: { label: payload.label } } : {};
    if (payload?.host === "pdf" || payload?.attachActivePdf) {
      await runPdfChatTurn(text, payload?.docPath || null, turnOpts);
      return;
    }
    runChatTurn(text, turnOpts);
  }

  async function submitQuickPrompt() {
    if (!quickPromptState?.payload) return;
    const payload = quickPromptState.payload;
    let finalPrompt = "";
    try {
      if (isImageQuickPrompt(payload)) {
        const imagePrompt = String(els.quickPromptBody?.querySelector("#quickPromptImageInput")?.value || "").trim();
        if (!imagePrompt) throw new Error("请先填写生图提示词。");
        const insertAtCursor = !!els.quickPromptBody?.querySelector("#quickPromptInsertAtCursor")?.checked;
        const chosenSize = String(els.quickPromptBody?.querySelector("#quickPromptImageSize")?.value || "").trim();
        finalPrompt = buildImageQuickPrompt(payload, imagePrompt, insertAtCursor, chosenSize);
      } else {
        finalPrompt = buildGenericQuickPrompt(payload);
      }
    } catch (e) {
      showMessage(e?.message || String(e), "error");
      return;
    }

    if (isQuickPromptDialog) {
      writeQuickPromptDialogResult({ cancelled: false, prompt: finalPrompt, payload });
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("已提交，请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }

    closeQuickPromptModal(false);
    await runQuickPromptResult(payload, finalPrompt);
  }

  function bindQuickPromptModal() {
    if (quickPromptBound) return;
    quickPromptBound = true;
    els.quickPromptSubmitBtn?.addEventListener("click", submitQuickPrompt);
    els.quickPromptCancelBtn?.addEventListener("click", () => closeQuickPromptModal(true));
    els.quickPromptCloseBtn?.addEventListener("click", () => closeQuickPromptModal(true));
    els.quickPromptModal?.addEventListener("click", (ev) => {
      if (ev.target === els.quickPromptModal) closeQuickPromptModal(true);
    });
    els.quickPromptBody?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (!(ev.metaKey || ev.ctrlKey)) return;
      ev.preventDefault();
      submitQuickPrompt();
    });
    els.quickPromptBody?.addEventListener("click", async (ev) => {
      const btn = ev.target?.closest?.('[data-role="quick-prompt-paste"]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const targetId = btn.getAttribute("data-target");
      const target = targetId ? els.quickPromptBody?.querySelector(`#${CSS.escape(targetId)}`) : null;
      await pasteClipboardIntoInput(target);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (els.quickPromptModal && !els.quickPromptModal.classList.contains("hidden")) {
        closeQuickPromptModal(true);
      }
    });
  }

  async function consumeQuickPromptDialogResult() {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(QUICK_PROMPT_DIALOG_RESULT_KEY) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let result = null;
    try { result = JSON.parse(raw); } catch (e) {}
    try { localStorage.removeItem(QUICK_PROMPT_DIALOG_RESULT_KEY); } catch (e) {}
    if (!result || typeof result !== "object") return false;
    if (result.ts && result.ts === lastQuickPromptResultTs) return false;
    lastQuickPromptResultTs = result.ts || Date.now();
    if (result.cancelled) return true;
    if (result.prompt) {
      await runQuickPromptResult(result.payload || {}, result.prompt);
      return true;
    }
    return false;
  }

  function startQuickPromptDialogResultPolling() {
    if (isAnyDialogWindow()) return;
    if (quickPromptDialogPollTimer) clearInterval(quickPromptDialogPollTimer);
    let ticks = 0;
    quickPromptDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeQuickPromptDialogResult();
      if (ticks >= 600) {
        clearInterval(quickPromptDialogPollTimer);
        quickPromptDialogPollTimer = null;
      }
    }, 500);
  }

  async function openQuickPromptAsDialog(payload) {
    const hydrated = hydrateQuickPromptPayload(payload);
    resetQuickPromptStateIfNeeded();
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=quickprompt`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        rememberWriterInsertionRange();
        const request = Object.assign({}, hydrated, { ts: Date.now() });
        try { localStorage.setItem(QUICK_PROMPT_DIALOG_REQUEST_KEY, JSON.stringify(request)); } catch (e) {}
        try { localStorage.removeItem(QUICK_PROMPT_DIALOG_RESULT_KEY); } catch (e) {}
        const { w, h } = pickDialogSize(isImageQuickPrompt(hydrated) ? 620 : 560, isImageQuickPrompt(hydrated) ? 480 : 420, { minW: 480, minH: 360 });
        app.ShowDialog(url, i18nDialogTitle(hydrated.label || "快捷操作"), w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        await consumeQuickPromptDialogResult();
        startQuickPromptDialogResultPolling();
        return true;
      }
    } catch (e) {
      console.warn("[quick-prompt] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    return openQuickPromptInline(hydrated);
  }

  // ---- ribbon 快捷指令消费 ----
  // ribbon 上点了快捷指令后，adapter 会写入 PluginStorage["lingxi_ai_pending_action"]，
  // 这边轮询读取并触发对应 chip 的 prompt（自动发送，等同于在面板里点击该 chip）。
  const PENDING_ACTION_KEY = "lingxi_ai_pending_action";
  let lastConsumedActionTs = 0;

  async function getPluginStorage() {
    try {
      const app = await global.WpsAiAddon?.getApplication?.();
      return app?.PluginStorage || null;
    } catch (e) {
      return null;
    }
  }

  async function consumePendingAction() {
    const storage = await getPluginStorage();
    if (!storage?.getItem) return;
    let raw = "";
    try { raw = storage.getItem(PENDING_ACTION_KEY) || ""; } catch (e) { return; }
    if (!raw) return;

    let payload;
    try { payload = JSON.parse(raw); } catch (e) { payload = null; }
    if (!payload || typeof payload !== "object") {
      try { storage.removeItem?.(PENDING_ACTION_KEY); } catch (e) {}
      return;
    }
    if (payload.ts && payload.ts === lastConsumedActionTs) return;
    lastConsumedActionTs = payload.ts || 0;

    // 标记已消费
    try {
      if (storage.removeItem) storage.removeItem(PENDING_ACTION_KEY);
      else storage.setItem(PENDING_ACTION_KEY, "");
    } catch (e) {}

    // 「文件未保存」早判断：ribbon 触发的 AI 动作在 doc 没存到磁盘或有未保存改动时
    // 直接弹一个独立的提示框（alert）拒绝执行，**不切 Tab、不开弹窗、不在聊天流里留任何痕迹**——
    // 用户的意图是"提示一下就完了，按钮像没点过一样"。
    // 只对 wps/wpp/et 文档型宿主生效；PDF / 未识别宿主不拦。
    // 「PPT 风格预设 / 大纲」这两个纯展示 modal 不需要文档已保存；
    // 「素材库」虽是展示形态，但里面「插入到文档」按钮会写文档，所以也要校验。
    const skipSaveCheck = payload.kind === "open-modal"
      && ["stylePreset", "outline", "parallelTranslate"].includes(payload.modal);
    if (!skipSaveCheck) {
      try {
        const saveState = global.WpsAiBackup?.getCurrentDocSaveState?.();
        if (saveState && !saveState.ok) {
          try { alert(saveState.hint); } catch (e) {}
          return;
        }
      } catch (e) { /* 探测失败兜底不拦，照旧分发 */ }
    }

    // 新增 kind=open-modal：ribbon 上点 PPT 风格 / 大纲生成 PPT 等需要弹窗的动作
    if (payload.kind === "open-modal") {
      activateTab("ai");
      if (payload.modal === "stylePreset") openStylePresetAsDialog();
      else if (payload.modal === "outline") openOutlineModal();
      else if (payload.modal === "unify") openUnifyModal();
      else if (payload.modal === "materialLibrary") openMaterialLibraryAsDialog();
      else if (payload.modal === "parallelTranslate") openParallelTranslateAsDialog(payload.docPath || null);
      return;
    }

    activateTab("ai");

    if (payload.flow === "formatPreview") {
      await openFormatPreviewAsDialog();
      return;
    }

    if (payload.flow === "proofread") {
      await runProofreadFlow();
      return;
    }

    if (payload.flow === "compliance") {
      openComplianceModal();
      return;
    }

    if (payload.flow === "selectionTranslate" || payload.flow === "selectionOptimize") {
      await openSelectionPreviewAsDialog({
        intent: payload.flow === "selectionTranslate" ? "translate" : "optimize",
        targetLanguage: payload.targetLanguage || "简体中文",
        instruction: payload.instruction || ""
      });
      return;
    }

    if (payload.flow === "selectionTone") {
      await openSelectionPreviewAsDialog({
        intent: "tone",
        tone: payload.tone || payload.label || "改写",
        instruction: payload.instruction || ""
      });
      return;
    }

    if (payload.flow === "documentRewrite") {
      await openSelectionPreviewAsDialog({
        intent: "documentRewrite",
        tone: payload.tone || payload.label || "全文润色",
        instruction: payload.instruction || "",
        scope: "document"
      });
      return;
    }

    // prefill 类动作先收集用户输入，再合成为完整指令自动发送。
    if (payload.prefill && payload.prompt) {
      await openQuickPromptAsDialog(payload);
      return;
    }

    // PDF 宿主下的 quick action：走双通道（数字版抽文字给任意模型 / 扫描件回退整文件多模态）
    if ((payload.host === "pdf" || payload.attachActivePdf) && payload.prompt) {
      await runPdfChatTurn(payload.prompt, payload.docPath || null,
        payload.label ? { quickAction: { label: payload.label } } : {});
      return;
    }

    if (payload.flow === "documentReport") {
      await openSelectionPreviewAsDialog({
        intent: "documentReport",
        reportKind: payload.reportKind || "summary",
        tone: payload.tone || payload.label || "文档报告",
        instruction: payload.instruction || "",
        scope: "document"
      });
      return;
    }

    if (payload.prompt) {
      // ribbon 直发的模板提示词：带上按钮文字，聊天流里折叠成操作盒子
      const label = payload.label
        || global.WpsAiQuickActions?.findByKey?.(payload.host, payload.key)?.label
        || "";
      runChatTurn(payload.prompt, label ? { quickAction: { label } } : {});
    }
  }

  // ===== 整套 PPT 生成进度条（修 #6）=====
  // wpp_render_full_deck 在 presentation.js 里实时写 localStorage 的 progress key
  // 主 TaskPane 轮询读取，显示进度条 + 当前页 / 总页数 + 描述
  const FULL_DECK_PROGRESS_KEY = "lingxi_full_deck_progress_v1";
  let _fullDeckProgressTimer = null;
  function pollFullDeckProgress() {
    let p = null;
    try {
      const raw = localStorage.getItem(FULL_DECK_PROGRESS_KEY);
      if (raw) p = JSON.parse(raw);
    } catch (e) {}
    const box = els.fullDeckProgress;
    if (!box) return;
    if (!p || !p.total) {
      box.classList.add("hidden");
      return;
    }
    // 数据陈旧（>2 分钟没更新）认为是死循环遗留，自动清掉
    if (Date.now() - (p.ts || 0) > 120000) {
      try { localStorage.removeItem(FULL_DECK_PROGRESS_KEY); } catch (e) {}
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    if (els.fullDeckProgressCount) {
      els.fullDeckProgressCount.textContent = `${p.current} / ${p.total}`;
    }
    if (els.fullDeckProgressBarFill) {
      const pct = Math.max(0, Math.min(100, (p.current / p.total) * 100));
      els.fullDeckProgressBarFill.style.width = pct.toFixed(1) + "%";
    }
    if (els.fullDeckProgressLabel) {
      els.fullDeckProgressLabel.textContent = p.label || "";
    }
  }
  function startFullDeckProgressWatcher() {
    if (_fullDeckProgressTimer) return;
    _fullDeckProgressTimer = setInterval(pollFullDeckProgress, 500);
    pollFullDeckProgress(); // 立即跑一次
  }

  function startPendingActionWatcher() {
    setTimeout(consumePendingAction, 200);
    setInterval(consumePendingAction, 800);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) consumePendingAction();
    });
  }

  // ===== HTML 模板预览 modal =====
  // wpp_render_html_template 工具调用时打开此 modal；用户可编辑字段后点「插入到幻灯片」
  // 触发真正的渲染+图片插入；可从右上「历史」面板里召回过去生成的页面继续编辑。

  let htmlPreviewState = null;
  let htmlPreviewRenderTimer = null;
  // 预览 iframe scale 计算 + 应用：壳子可能 ResizeObserver 抓变更
  let htmlPreviewResizeObserver = null;
  // 打开 modal 时记录的 TaskPane 原始宽度（用于关闭时恢复）
  let htmlPreviewOrigPaneWidth = null;
  // 期望的 TaskPane 宽度：让预览有视觉冲击力，最小 960
  const HTML_PREVIEW_PANE_WIDTH = 960;

  function tryExpandTaskPaneForPreview() {
    try {
      const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
      if (!pane) return;
      let cur = 0;
      try { cur = Number(pane.Width) || 0; } catch (e) {}
      if (cur && cur < HTML_PREVIEW_PANE_WIDTH) {
        htmlPreviewOrigPaneWidth = cur;
        try { pane.Width = HTML_PREVIEW_PANE_WIDTH; } catch (e) {}
      }
    } catch (e) { /* 不支持就算了 */ }
  }

  function tryRestoreTaskPaneAfterPreview() {
    if (!htmlPreviewOrigPaneWidth) return;
    try {
      const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
      if (pane) {
        try { pane.Width = htmlPreviewOrigPaneWidth; } catch (e) {}
      }
    } catch (e) {}
    htmlPreviewOrigPaneWidth = null;
  }

  // 父窗口直接操作 iframe DOM 渲染图表 / canvas（同源即可，**无需 allow-scripts**）。
  // - 扫 [data-echarts-option] 元素 → echarts.init().setOption()
  // - 扫 canvas[data-canvas-draw] 元素 → new Function 跑代码（运行在父窗口上下文，但操作的是 iframe 内的 canvas）
  // echarts 没加载时静默；canvas 不依赖 echarts，独立工作。
  function bridgeEchartsToFrame(frame) {
    try {
      const doc = frame?.contentDocument;
      if (!doc || !doc.body) return;
      const ec = window.echarts;
      // ===== ECharts =====
      if (ec) {
        const root = doc.documentElement;
        const cs = doc.defaultView ? doc.defaultView.getComputedStyle(root) : null;
        const palette = cs ? [
          (cs.getPropertyValue("--primary") || "#1A6DFF").trim(),
          (cs.getPropertyValue("--accent")  || "#E85D2F").trim(),
          (cs.getPropertyValue("--body-color") || "#475569").trim(),
          (cs.getPropertyValue("--surface") || "#E2E8F0").trim(),
          "#7C5295", "#15803D"
        ] : null;
        doc.querySelectorAll("[data-echarts-option]").forEach((el) => {
          try {
            const opt = JSON.parse(el.getAttribute("data-echarts-option"));
            if (palette && !opt.color) opt.color = palette;
            // 容器无明确尺寸时给 100%
            if (!el.style.width && !el.clientWidth) el.style.width = "100%";
            if (!el.style.height && !el.clientHeight) el.style.height = "100%";
            const chart = ec.init(el, null, { renderer: "svg" });
            chart.setOption(opt);
          } catch (e) { /* 单格失败不阻塞其他 */ }
        });
      }
      // ===== Canvas draw =====（与 echarts 解耦，没 echarts 也能用）
      doc.querySelectorAll("canvas[data-canvas-draw]").forEach((c) => {
        try {
          const w = c.clientWidth, h = c.clientHeight;
          if (w && h) { c.width = w; c.height = h; }
          const ctx = c.getContext("2d");
          const code = c.getAttribute("data-canvas-draw");
          new Function("ctx", "canvas", "w", "h", code)(ctx, c, c.width, c.height);
        } catch (e) {}
      });
    } catch (e) { /* CORS / timing 异常沉默 */ }
  }

  function applyHtmlPreviewScale() {
    const frame = els.htmlPreviewFrame;
    if (!frame) return;
    const inner = frame.parentElement;
    if (!inner) return;
    const sw = inner.clientWidth;
    const sh = inner.clientHeight;
    if (!sw || !sh) {
      const tries = (applyHtmlPreviewScale._tries || 0) + 1;
      if (tries <= 5) {
        applyHtmlPreviewScale._tries = tries;
        setTimeout(applyHtmlPreviewScale, 80);
      } else {
        applyHtmlPreviewScale._tries = 0;
      }
      return;
    }
    applyHtmlPreviewScale._tries = 0;
    const scaleW = sw / 1920;
    const scaleH = sh / 1080;
    // 收缩到 92% 留 8% matt 视觉余量（4 边 4% 各）；编辑器选中边缘元素时按钮也有空间
    const scale = Math.min(scaleW, scaleH, 1) * 0.92;
    frame.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
    frame._lingxiScale = scale;
    // scale 算完顺手刷新标尺刻度
    renderRulers();
  }

  // ===== 画布标尺：PS 风顶/左两条标尺，刻度按 1920×1080 logical 像素 =====
  function renderRulers() {
    const frame = els.htmlPreviewFrame;
    if (!frame) return;
    const inner = frame.parentElement;
    if (!inner || !inner.classList.contains("with-ruler")) return;
    const topRuler = inner.querySelector("#rulerTop");
    const leftRuler = inner.querySelector("#rulerLeft");
    if (!topRuler || !leftRuler) return;
    const scale = frame._lingxiScale || 0.28;
    const innerW = inner.clientWidth;
    const innerH = inner.clientHeight;
    // iframe 实际可见 W/H（缩放后）+ 在 stage-inner 内的左/上偏移（居中）
    const realW = 1920 * scale;
    const realH = 1080 * scale;
    const ifrLeft = (innerW - realW) / 2;
    const ifrTop  = (innerH - realH) / 2;
    // 标尺自己占了 22px 起点
    const RULER_W = 22;
    // ===== Top ruler =====
    // 标尺 DOM 的 left=22px，宽度 = innerW - 22。iframe 的左边缘距离标尺起点 = ifrLeft - 22。
    // 1920 logical px → realW visible px。tick 在标尺内的位置 = (logicalX * scale) + (ifrLeft - 22)。
    const topParts = [];
    const STEP = 50; // 每 50 logical px 一根 tick
    for (let x = 0; x <= 1920; x += STEP) {
      const px = ifrLeft - RULER_W + x * scale;
      // 超出标尺可视区就别画
      if (px < -8 || px > innerW - RULER_W + 8) continue;
      const isMajor = x % 200 === 0;
      const isMedium = !isMajor && x % 100 === 0;
      const cls = isMajor ? "tick major" : (isMedium ? "tick medium" : "tick");
      topParts.push(`<div class="${cls}" style="left:${px}px"></div>`);
      if (isMajor) topParts.push(`<div class="label" style="left:${px}px">${x}</div>`);
    }
    topRuler.innerHTML = topParts.join("");
    // ===== Left ruler =====
    const leftParts = [];
    for (let y = 0; y <= 1080; y += STEP) {
      const py = ifrTop - RULER_W + y * scale;
      if (py < -8 || py > innerH - RULER_W + 8) continue;
      const isMajor = y % 200 === 0;
      const isMedium = !isMajor && y % 100 === 0;
      const cls = isMajor ? "tick major" : (isMedium ? "tick medium" : "tick");
      leftParts.push(`<div class="${cls}" style="top:${py}px"></div>`);
      if (isMajor) leftParts.push(`<div class="label" style="top:${py}px">${y}</div>`);
    }
    leftRuler.innerHTML = leftParts.join("");
  }

  // 中栏 tab 切换：画布 / 属性（HTML+CSS 字段）
  let _centerTabActive = "canvas";
  function switchCenterTab(tab) {
    if (tab !== "canvas" && tab !== "props") return;
    _centerTabActive = tab;
    document.querySelectorAll(".html-preview-center-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.centerTab === tab);
    });
    document.querySelectorAll("[data-center-panel]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.centerPanel !== tab);
    });
    // 切回画布时容器尺寸可能从 0 → 真实值；重新算 scale + 标尺
    if (tab === "canvas") {
      requestAnimationFrame(() => {
        applyHtmlPreviewScale();
      });
    }
  }

  // 标尺显隐：写到 localStorage，下次开预览自动还原
  // 标尺常开 —— UI 上去掉了切换按钮（标尺一直可见，跟 PS / Figma 默认行为一致）
  function applyRulerVisibility(visible) {
    const frame = els.htmlPreviewFrame;
    const inner = frame?.parentElement;
    if (!inner) return;
    inner.classList.add("with-ruler");
    renderRulers();
  }

  function setHtmlPreviewBusy(busy) {
    if (els.htmlPreviewRendering) {
      els.htmlPreviewRendering.classList.toggle("hidden", !busy);
    }
    if (els.htmlPreviewInsertBtn) {
      els.htmlPreviewInsertBtn.disabled = !!busy;
    }
  }

  function renderHtmlPreviewIntoIframe() {
    const st = htmlPreviewState;
    plog("render", "entry; st =", st ? `{${st.templateName}/${st.layout}}` : "NULL");
    if (!st) { pwarn("render", "no state, abort"); return; }
    const HtmlTpl = global.WpsAiHtmlTemplates;
    plog("render", "WpsAiHtmlTemplates module loaded?", !!HtmlTpl, "getTemplate?", typeof HtmlTpl?.getTemplate);
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    plog("render", "template found?", !!tpl, "layoutKeys =", tpl ? Object.keys(tpl.layouts || {}) : "(no tpl)");
    const layoutDef = tpl?.layouts?.[st.layout];
    if (!layoutDef) {
      pwarn("render", `unknown template/layout: ${st.templateName} / ${st.layout}`);
      els.htmlPreviewInfo.textContent = `未知模板 ${st.templateName} / ${st.layout}`;
      return;
    }
    setHtmlPreviewBusy(true);
    let html;
    try {
      html = layoutDef.render(st.data || {}, st.palette || {});
      plog("render", `layout.render returned html len = ${html ? html.length : 0}`);
    } catch (e) {
      pwarn("render", "layout.render THREW:", e?.message || e);
      const msg = String(e?.message || e);
      els.htmlPreviewInfo.textContent = `渲染异常：${msg}`;
      // 在 iframe 里也显示一份，用户不至于看着空白发懵
      try {
        const frame = els.htmlPreviewFrame;
        if (frame) frame.srcdoc = `<!doctype html><html><body style="margin:0;padding:80px;font-family:sans-serif;color:#c00;background:#fff5f5"><h2 style="font-size:48px">渲染异常</h2><pre style="font-size:24px;white-space:pre-wrap;word-break:break-all">${msg.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre><p style="font-size:20px;color:#888">templateName: ${st.templateName} / layout: ${st.layout}</p></body></html>`;
      } catch (_) {}
      setHtmlPreviewBusy(false);
      return;
    }
    if (!html || typeof html !== "string") {
      const msg = `layout ${st.templateName}/${st.layout} 渲染返回空内容`;
      els.htmlPreviewInfo.textContent = msg;
      try {
        const frame = els.htmlPreviewFrame;
        if (frame) frame.srcdoc = `<!doctype html><html><body style="margin:0;padding:80px;font-family:sans-serif;color:#c00"><h2 style="font-size:48px">${msg}</h2></body></html>`;
      } catch (_) {}
      setHtmlPreviewBusy(false);
      return;
    }
    // 强制让每次的 srcdoc 字符串不一样 —— 某些 WebView（WKWebView、旧 WebView2）发现
    // srcdoc 跟上次内容完全相同时不会重新触发 load，导致 AI 生成新内容后预览停在旧画面。
    // 在文档末尾追加一段不影响渲染的注释，每次都唯一。
    const renderTag = `${Date.now().toString(36)}-${(Math.random() * 1e6 | 0).toString(36)}`;
    html += `\n<!-- lingxi-render ${renderTag} -->`;
    // 渲染加固：
    // 渲染策略（主路径换成 document.open/write/close）：
    //   srcdoc 在多数 WPS WebView 里设置后**load 不触发 / 不真正渲染**，是空白预览的根因。
    //   document.open/write/close 是同源同步 DOM API，覆盖率最广、最可靠。
    //   流程：
    //     1. 清掉 srcdoc 属性，防止它干扰 contentDocument
    //     2. doc.open/write/close 把 html 写入 iframe 内
    //     3. 写完即同步 applyScale + bridgeEcharts + setBusy(false)（不再依赖 load 事件）
    //     4. 失败兜底（理论上不会发生）：才用 srcdoc 重试一次
    try {
      const frame = els.htmlPreviewFrame;
      // 清掉旧 listener / timeout，跟之前快速连发的 render 解耦
      if (frame._lastOnLoad) {
        try { frame.removeEventListener("load", frame._lastOnLoad); } catch (e) {}
        frame._lastOnLoad = null;
      }
      if (frame._loadTimeout) {
        clearTimeout(frame._loadTimeout);
        frame._loadTimeout = null;
      }
      // 卸掉 srcdoc 属性，避免它跟 contentDocument 抢渲染
      try { frame.removeAttribute("srcdoc"); } catch (e) {}

      const finishRender = (path) => {
        const innerW = frame.parentElement?.clientWidth;
        const innerH = frame.parentElement?.clientHeight;
        const doc = frame.contentDocument;
        const bodyChildren = doc?.body?.childElementCount;
        const stageEl = doc?.querySelector?.(".stage");
        plog("finishRender", `via=${path}; container=${innerW}x${innerH}; body.children=${bodyChildren}; stage=${!!stageEl}`);
        if (doc) installWpsFocusReleaseForDocument(doc, { force: true });
        applyHtmlPreviewScale();
        plog("finishRender", `applied transform: ${frame.style.transform}`);
        setHtmlPreviewBusy(false);
        if (htmlPreviewState === st) {
          els.htmlPreviewInfo.textContent = `1920 × 1080 · ${st.templateName} / ${st.layout}`;
        }
        bridgeEchartsToFrame(frame);
        if (_editorEnabled && htmlPreviewState === st && st.layout === "freeform") {
          try { enableIframeEditor(); } catch (e) { console.warn("[editor] re-enable failed", e); }
        }
      };

      // 用 document.open/write/close 主动写入（同步生效）
      let written = false;
      let writeErr = null;
      try {
        const doc = frame.contentDocument;
        plog("render", "contentDocument =", !!doc, "iframe.src =", frame.src || "(empty)");
        if (doc) {
          doc.open();
          doc.write(html);
          doc.close();
          written = true;
        }
      } catch (e) { writeErr = e; /* 罕见：跨域 / WebView 限制 */ }
      plog("render", `document.write path: written=${written}` + (writeErr ? ` err=${writeErr.message}` : ""));

      if (written) {
        // 同步路径成功，DOM 已就位；下一帧算 scale + 触发 chart bootstrap
        requestAnimationFrame(() => {
          if (htmlPreviewState !== st) { pwarn("render", "state changed before RAF; abort finishRender"); return; }
          finishRender("doc.write");
        });
      } else {
        // 兜底：回退到 srcdoc，监听 load + 800ms 兜底跑 finishRender
        pwarn("render", "doc.write FAILED — falling back to srcdoc + load event");
        const onLoad = () => {
          plog("render", "srcdoc onLoad fired");
          try { frame.removeEventListener("load", onLoad); } catch (e) {}
          if (frame._loadTimeout) { clearTimeout(frame._loadTimeout); frame._loadTimeout = null; }
          frame._lastOnLoad = null;
          if (htmlPreviewState === st) finishRender("srcdoc-onLoad");
        };
        frame._lastOnLoad = onLoad;
        frame.addEventListener("load", onLoad);
        frame._loadTimeout = setTimeout(() => {
          pwarn("render", "srcdoc onLoad NEVER FIRED in 800ms — running finishRender from timeout");
          try { frame.removeEventListener("load", onLoad); } catch (e) {}
          frame._lastOnLoad = null;
          frame._loadTimeout = null;
          if (htmlPreviewState === st) finishRender("srcdoc-timeout");
        }, 800);
        try { frame.srcdoc = html; plog("render", `srcdoc set, len=${html.length}`); }
        catch (e) {
          pwarn("render", "srcdoc set THREW:", e?.message);
          els.htmlPreviewInfo.textContent = `iframe 写入失败：${e?.message || e}`;
          setHtmlPreviewBusy(false);
        }
      }
    } catch (e) {
      els.htmlPreviewInfo.textContent = `iframe 写入失败：${e?.message || e}`;
      setHtmlPreviewBusy(false);
    }
  }

  function debounceHtmlPreviewRender() {
    if (htmlPreviewRenderTimer) clearTimeout(htmlPreviewRenderTimer);
    htmlPreviewRenderTimer = setTimeout(() => {
      htmlPreviewRenderTimer = null;
      renderHtmlPreviewIntoIframe();
    }, 200);
  }

  // 把字段渲染成 textarea/input；监听 input 事件，写回 state.data，触发去抖预览
  function renderHtmlPreviewFields() {
    const st = htmlPreviewState;
    const host = els.htmlPreviewFields;
    if (!host) return;
    host.innerHTML = "";
    if (!st) return;
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    const layoutDef = tpl?.layouts?.[st.layout];
    const fields = layoutDef?.fields || Object.keys(st.data || {});
    fields.forEach((fieldName) => {
      const label = document.createElement("label");
      label.className = "field";
      const span = document.createElement("span");
      span.textContent = fieldName;
      label.appendChild(span);
      const cur = st.data?.[fieldName] || "";
      // freeform 的 html / css 是大块代码，给加高的 textarea；其他长字段也用 textarea
      const isCodeField = /^(html|css)$/i.test(fieldName);
      const useTextarea = isCodeField
        || String(cur).length > 40
        || String(cur).includes("\n")
        || /body|description|subtitle|items/i.test(fieldName);
      const input = document.createElement(useTextarea ? "textarea" : "input");
      if (!useTextarea) {
        input.type = "text";
      } else {
        input.rows = isCodeField ? 12 : 3;
        if (isCodeField) {
          input.style.fontFamily = "Consolas, 'Microsoft YaHei UI', monospace";
          input.style.fontSize = "11px";
        }
      }
      input.value = cur;
      // 修 B35：设置 data-field-name，persistEditorChangesToState 靠这个选择器把编辑器（拖拽）
      // 改动同步回对应 textarea。之前从不设置该属性 → 选择器永远匹配不到 → 用户在 html 字段
      // 补一个字就用过期整段 html 覆盖 st.data.html，把拖拽改动全回滚。
      input.setAttribute("data-field-name", fieldName);
      input.addEventListener("input", () => {
        st.data = Object.assign({}, st.data, { [fieldName]: input.value });
        debounceHtmlPreviewRender();
      });
      // WPS WebView paste 兜底：手动从 clipboardData 取文本插入。
      // 主要服务 freeform 的 html/css 字段 —— 用户最可能在这里粘贴整段代码。
      input.addEventListener("paste", (ev) => {
        const txt = ev.clipboardData?.getData("text") || "";
        if (!txt) return;
        ev.preventDefault();
        insertAtCursor(ev.currentTarget, txt);
      });
      label.appendChild(input);
      host.appendChild(label);
    });
  }

  // 当前活动文档的稳定 key —— 历史对话 / HTML 模板历史 / 组件库 都按这个关联到文档。
  //   - 优先用 backup.readDocId() 读到的 UUID（跨重命名 / Save As / 跨机同步都稳） → 返回 "id:<uuid>"
  //   - 读不到 UUID（尚未 assign / PDF / 老文档）→ 保留旧行为，返回 backup.getCurrentDocPath()
  //     原样字符串，兼容之前 localStorage 里按裸路径存的老对话
  //   - 没打开文件 → 空串
  function getCurrentDocKey() {
    try {
      const backup = global.WpsAiBackup;
      const id = backup?.readDocId?.();
      if (id) return `id:${id}`;
      const p = backup?.getCurrentDocPath?.();
      return p ? String(p) : "";
    } catch (e) { return ""; }
  }
  global.WpsAiApp = Object.assign(global.WpsAiApp || {}, { getCurrentDocKey });

  let _cachedDocKey = "";
  function refreshCurrentDocKey() {
    try { _cachedDocKey = getCurrentDocKey(); } catch (e) { _cachedDocKey = ""; }
    return _cachedDocKey;
  }

  // 监听文档切换：每 1.5s 探一次当前 docKey；变了就触发 onDocChanged。
  // WPS 没有原生 doc-change 事件，只能轮询。1.5s 是体感"立即响应"的上限。
  let _docWatcherTimer = null;
  let _lastDocKey = "";
  function shouldRebindDocKeyDuringChat(prev, now) {
    if (!chatBusy || !now || now === prev) return false;
    if (now.startsWith("id:") && prev && !prev.startsWith("id:")) return true;
    if (!prev && now) return true;
    return false;
  }

  function rebindCurrentConversationDocKey(now, prev) {
    try {
      if (now?.startsWith?.("id:") && prev) {
        const migrated = global.WpsAiConversations?.getCurrentForDoc?.(now, prev);
        if (migrated) return true;
      }
    } catch (e) {}
    try { return !!global.WpsAiConversations?.rebindCurrentDocKey?.(now); } catch (e) {}
    return false;
  }

  function startDocWatcher(onDocChanged) {
    if (_docWatcherTimer) return;
    _lastDocKey = getCurrentDocKey();
    _cachedDocKey = _lastDocKey;
    _docWatcherTimer = setInterval(() => {
      try {
        const now = getCurrentDocKey();
        if (now !== _lastDocKey) {
          const prev = _lastDocKey;
          _lastDocKey = now;
          _cachedDocKey = now;
          if (shouldRebindDocKeyDuringChat(prev, now) && rebindCurrentConversationDocKey(now, prev)) {
            return;
          }
          try { onDocChanged?.(now, prev); } catch (e) {}
        }
      } catch (e) {}
    }, 1500);
  }

  function updateHtmlPreviewHistoryBadge() {
    try {
      const cache = global.WpsAiHtmlCache;
      const count = cache?.list?.({ docKey: _cachedDocKey })?.length || 0;
      if (els.htmlPreviewHistoryBtn) {
        els.htmlPreviewHistoryBtn.textContent = `历史 (${count})`;
      }
    } catch (e) {}
  }

  function renderHtmlPreviewHistory() {
    const host = els.htmlPreviewHistoryList;
    if (!host) return;
    const cache = global.WpsAiHtmlCache;
    // 历史按当前 PPT 过滤；没有 docKey 标记的 legacy 条目也一并展示（兼容）
    const entries = cache?.list?.({ limit: 20, docKey: _cachedDocKey }) || [];
    host.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "html-preview-history-empty";
      empty.textContent = "暂无历史。生成一次 HTML 模板就会自动保存到这里。";
      host.appendChild(empty);
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "html-preview-history-item";
      const row1 = document.createElement("div");
      row1.className = "row1";
      const tpl = document.createElement("span");
      tpl.className = "tpl";
      tpl.textContent = `${entry.templateName} / ${entry.layout}`;
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = formatHtmlPreviewTs(entry.ts);
      row1.appendChild(tpl);
      row1.appendChild(ts);
      const preview = document.createElement("div");
      preview.className = "preview";
      const firstField = Object.values(entry.data || {})[0] || "";
      preview.textContent = String(firstField).slice(0, 60) || "—";
      item.appendChild(row1);
      item.appendChild(preview);
      item.addEventListener("click", () => {
        // 召回：把 state 替换成历史条目，重新渲染字段 + 预览
        htmlPreviewState = {
          id: entry.id,
          templateName: entry.templateName,
          layout: entry.layout,
          data: Object.assign({}, entry.data || {}),
          palette: Object.assign({}, entry.palette || {}),
          slideHint: entry.slideHint || null,
          onConfirm: htmlPreviewState?.onConfirm || null  // 保留原 onConfirm
        };
        els.htmlPreviewTemplate.textContent = htmlPreviewState.templateName;
        els.htmlPreviewLayout.textContent = htmlPreviewState.layout;
        renderHtmlPreviewFields();
        renderHtmlPreviewIntoIframe();
        updateHtmlPreviewActionButtons();
        // 切到新 slide → 右侧"美化当前预览"chat 也跟着切（清空旧会话）
        resetPreviewChatForState(htmlPreviewState);
        toggleHtmlPreviewHistoryPanel(false);
      });
      host.appendChild(item);
    });
  }

  function formatHtmlPreviewTs(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toggleHtmlPreviewHistoryPanel(show) {
    const panel = els.htmlPreviewHistoryPanel;
    if (!panel) return;
    if (show) {
      // 互斥：开历史就关画廊
      if (els.htmlTemplateGallery && !els.htmlTemplateGallery.classList.contains("hidden")) {
        els.htmlTemplateGallery.classList.add("hidden");
      }
      renderHtmlPreviewHistory();
      panel.classList.remove("hidden");
    } else {
      panel.classList.add("hidden");
    }
  }

  // 根据当前 state 同步「替换当前选中」按钮的显隐
  // 之前还有一个「替换第 N 页」按钮跟着 slideHint 动态显示，跟「替换当前选中」功能重叠且容易混淆，已下掉。
  function updateHtmlPreviewActionButtons() {
    const st = htmlPreviewState;
    const replaceActiveBtn = els.htmlPreviewReplaceActiveBtn;
    const insertBtn = els.htmlPreviewInsertBtn;
    if (!insertBtn) return;
    if (replaceActiveBtn) {
      if (st) replaceActiveBtn.classList.remove("hidden");
      else replaceActiveBtn.classList.add("hidden");
    }
    // 「整页存为组件」/「提取组件」只在 freeform 布局有意义
    const isFreeform = st?.layout === "freeform";
    const saveAsCompBtn = els.htmlPreviewSaveAsCompBtn;
    if (saveAsCompBtn) saveAsCompBtn.classList.toggle("hidden", !isFreeform);
    const extractBtn = els.htmlPreviewExtractCompsBtn;
    if (extractBtn) extractBtn.classList.toggle("hidden", !isFreeform);
    // 「编辑模式」按钮在任何 layout 都显示：非 freeform 时点击会自动把当前渲染结果
    // 转成 freeform（保留视觉）再进入编辑，让用户能拖拽 / 缩放 / 改文字。
    const editModeBtn = els.htmlPreviewEditModeBtn;
    if (editModeBtn) editModeBtn.classList.toggle("hidden", !st);
    // 撤销/重做按钮：只在编辑模式开启时显示（避免无 state 时的干扰）
    const undoBtn = els.htmlPreviewEditUndoBtn;
    const redoBtn = els.htmlPreviewEditRedoBtn;
    if (undoBtn) undoBtn.classList.toggle("hidden", !st || !_editorEnabled);
    if (redoBtn) redoBtn.classList.toggle("hidden", !st || !_editorEnabled);
    // 没 state → 自动退出编辑模式
    if (!st && _editorEnabled) disableIframeEditor();
    // 「选用组件」按钮的角标 = 当前 slide 已选组件数
    updatePickedComponentsCountBadge();
    // standalone（无 onConfirm）模式：是用户从历史召回打开的，需要兜底插入路径
    // 之前 slideN 跟着「替换第 N 页」按钮一起删了，这里重新读一下 st.slideHint
    if (!st?.onConfirm) {
      const slideN = st?.slideHint;
      insertBtn.textContent = slideN ? "插入到末尾（不替换）" : "插入到末尾";
    } else {
      insertBtn.textContent = "插入到幻灯片";
    }
  }

  // 主入口：打开预览 modal。
  // 在主 TaskPane 里：优先用 Application.ShowDialog 弹独立窗口（脱离 pane 宽度限制，体验最好）；
  // 不可用时退回 inline modal（原有行为）。
  // 在 preview-mode 独立窗口里：直接走 inline 行为。
  function openHtmlPreviewModal(opts) {
    opts = opts || {};
    // 修：在打开预览（弹独立 dialog 之前）抓住用户当前选中的幻灯片号。
    // 之后用户点「替换当前选中」时，renderAndInsertSlide 不再依赖
    // ActiveWindow.View.Slide（dialog 关闭后那个状态不可靠 / 偶发指向 slide 1），
    // 改用这里抓到的稳定值。
    try {
      if (typeof opts.activeSlideIndex !== "number") {
        const app = global.WpsAiAddon?.getApplicationSync?.();
        const hasApp = !!app;
        const win = app?.ActiveWindow;
        const view = win?.View;
        const slide = view?.Slide;
        const idx = slide?.SlideIndex;
        plog("captureActiveSlide", {
          hasApp,
          hasWin: !!win,
          hasView: !!view,
          hasSlide: !!slide,
          slideIndex: idx,
          captured: typeof idx === "number" && idx > 0
        });
        if (typeof idx === "number" && idx > 0) opts.activeSlideIndex = idx;
      } else {
        plog("captureActiveSlide", "skipped (opts.activeSlideIndex already set)", opts.activeSlideIndex);
      }
    } catch (e) {
      pwarn("captureActiveSlide", "exception:", e?.message || String(e));
    }
    plog("openHtmlPreviewModal", "called", {
      templateName: opts.templateName, layout: opts.layout,
      hasData: !!opts.data, dataKeys: Object.keys(opts.data || {}),
      hasPalette: !!opts.palette, slideHint: opts.slideHint,
      activeSlideIndex: opts.activeSlideIndex,
      hasOnConfirm: typeof opts.onConfirm === "function"
    });
    if (!isPreviewDialog && !isSettingsDialog) {
      // 在主 TaskPane —— 先试独立窗口
      const ok = tryOpenHtmlPreviewAsDialog(opts);
      plog("openHtmlPreviewModal", "tryDialog result =", ok);
      if (ok) return;
    }
    plog("openHtmlPreviewModal", "→ openHtmlPreviewInline (no dialog or already inside)");
    return openHtmlPreviewInline(opts);
  }

  // 用 ShowDialog 打开独立预览窗口。把 opts 序列化进 localStorage（不能序列化 onConfirm 函数，
  // 用一个 token 在 parent 这边保留 callback，等 dialog 关闭后用结果回填触发）。
  let _pendingHtmlPreviewOnConfirm = null;
  // 把 WPS 主窗口拉回前台。`Application.ShowDialog` 模态退出后，OS 焦点常被切到别的进程。
  // 各家 WPS API 不同，调一遍能找到的全部接口；任何一个生效就行。
  function activateWpsApp(app) {
    if (!app) return;
    // 1. Visible：被设成 false 时主动开启
    try { if (app.Visible === false) app.Visible = true; } catch (e) {}
    // 2. WindowState 被改成最小化(2)时强制恢复到 Normal(1) —— 之前只 prev→prev 自赋值，
    //    若已经是最小化(2) 写回 2 还是最小化，根本拉不回来。这里显式判断 minimized 才覆盖。
    //    各宿主常量：ppWindowMinimized=2 / wdWindowStateMinimize=2 / xlMinimized=-4140
    try {
      const ws = app.WindowState;
      if (ws === 2 || ws === -4140) {
        // ppWindowNormal=1 / wdWindowStateNormal=0 / xlNormal=-4143 —— 设为 1 多数 host 能恢复
        app.WindowState = 1;
      } else if (typeof ws === "number") {
        // 不是最小化时，自赋值触发一下 state 通知，能把宿主推前
        app.WindowState = ws;
      }
    } catch (e) {}
    // 3. Application.Activate() —— 部分 WPP/ET 版本有
    try { if (typeof app.Activate === "function") app.Activate(); } catch (e) {}
    // 4. ActiveWindow.Activate() + WindowState 兜底（窗口级再保险一次）
    try {
      const w = app.ActiveWindow;
      if (w) {
        if (typeof w.Activate === "function") w.Activate();
        try {
          if (w.WindowState === 2 || w.WindowState === -4140) w.WindowState = 1;
        } catch (e) {}
      }
    } catch (e) {}
    // 5. WPP 特有：ActivePresentation / Word 的 ActiveDocument / Excel 的 ActiveWorkbook 上 Activate
    try { const p = app.ActivePresentation; if (p && typeof p.Activate === "function") p.Activate(); } catch (e) {}
    try { const d = app.ActiveDocument; if (d && typeof d.Activate === "function") d.Activate(); } catch (e) {}
    try { const wb = app.ActiveWorkbook; if (wb && typeof wb.Activate === "function") wb.Activate(); } catch (e) {}
    // 6. 通过 window.focus 让 TaskPane（本身寄宿在 WPS 主窗口里）抢回焦点，间接把宿主推前
    try { if (typeof window.focus === "function") window.focus(); } catch (e) {}
  }

  function tryOpenHtmlPreviewAsDialog(opts) {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=preview`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      plog("tryDialog", "url =", url, "app =", !!app, "ShowDialog =", typeof app?.ShowDialog);
      if (!app || typeof app.ShowDialog !== "function") {
        pwarn("tryDialog", "no Application.ShowDialog API → fallback to inline modal");
        return false;
      }
      // 把可序列化的部分写到 localStorage 供 dialog 读
      const request = {
        templateName: opts.templateName || null,
        layout: opts.layout || null,
        data: opts.data || {},
        palette: opts.palette || {},
        slideHint: opts.slideHint || null,
        activeSlideIndex: typeof opts.activeSlideIndex === "number" ? opts.activeSlideIndex : null,
        historyMode: !!opts.historyMode,
        galleryMode: !!opts.galleryMode,
        ts: Date.now()
      };
      plog("tryDialog", "request blob", {
        slideHint: request.slideHint,
        activeSlideIndex: request.activeSlideIndex,
        templateName: request.templateName,
        layout: request.layout
      });
      const requestStr = JSON.stringify(request);
      try { localStorage.setItem(PREVIEW_DIALOG_REQUEST_KEY, requestStr); } catch (e) { pwarn("tryDialog", "localStorage write FAILED:", e?.message); }
      try { localStorage.removeItem(PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
      plog("tryDialog", "wrote request to localStorage, len =", requestStr.length, "tplName =", request.templateName, "layout =", request.layout);
      // 保留 onConfirm 在 parent 这边
      _pendingHtmlPreviewOnConfirm = typeof opts.onConfirm === "function" ? opts.onConfirm : null;
      // 模态调用：第 5 个参数 = true 让 WPS 主窗口阻塞直到 dialog 关闭。
      // 非模态（false）在 WPS 演示下会**立刻返回**，导致下面的 removeItem 在 dialog 还没启动前
      // 就把 REQUEST key 删了，dialog 读到 null → 显示空白占位。
      // dialog 尺寸根据屏幕自适应：1600×1000 在 1366×768 屏上会越界，按屏幕可用区裁剪
      const { w: dW, h: dH } = pickDialogSize(1600, 1000, { minW: 960, minH: 640 });
      plog("tryDialog", "calling app.ShowDialog (modal=true, blocking)... size =", dW, "x", dH);
      app.ShowDialog(url, i18nDialogTitle("预览"), dW, dH, true);
      plog("tryDialog", "ShowDialog returned, activating WPS");
      // dialog 关掉后，WPS 主窗口往往会被系统切到后台 —— 主动让它回到前台。
      // WPS 各版本 / 各宿主 API 不一，把能找到的全都试一遍：
      activateWpsApp(app);
      // dialog 关闭后：读结果，触发 onConfirm
      let result = null;
      try {
        const raw = localStorage.getItem(PREVIEW_DIALOG_RESULT_KEY);
        if (raw) {
          result = JSON.parse(raw);
          // 修 B32：记下本次同步消费的 RESULT，供 storage 监听器去重，避免二次插入。
          _consumedPreviewResultSig = raw;
        }
      } catch (e) {}
      // 注意：**不**在这里删 REQUEST key。原因：在某些 WPS 版本里 ShowDialog 是非阻塞的
      // （写 true 也未必生效），主窗口会立刻继续跑这段代码 —— 此时 dialog 可能还没启动完，
      // 删了 REQUEST 它就读不到了 → 空白预览。让 REQUEST 留在 LS 里，下次新请求会覆盖。
      // RESULT 删掉是安全的：它只在 dialog 关闭后才写，dialog 关闭意味着我们已经读完了。
      try { localStorage.removeItem(PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
      plog("tryDialog", "post-dialog: result =", result ? (result.cancelled ? "cancelled" : "ok") : "null");
      const cb = _pendingHtmlPreviewOnConfirm;
      _pendingHtmlPreviewOnConfirm = null;
      if (cb) {
        // 工具流：调原 onConfirm（tool 自己处理插入）。
        // 关键：用户在「美化当前」可能让 AI 切了 layout（cover → freeform 等），
        // result.templateName / result.layout 是 dialog 关闭时的最新值，必须透传给 onConfirm，
        // 否则 presentation.js 闭包里用旧 layout 渲染 = 用户白美化。
        if (!result || result.cancelled) {
          try { cb(null); } catch (e) {}
        } else {
          try { cb({
            templateName: result.templateName,
            layout: result.layout,
            data: result.data || {},
            palette: result.palette || {},
            intent: result.intent || "insert",
            activeSlideIndex: typeof result.activeSlideIndex === "number" ? result.activeSlideIndex : null
          }); } catch (e) {}
        }
      } else if (result && !result.cancelled && result.templateName && result.layout) {
        // standalone 路径：dialog 没有 tool onConfirm，由 MAIN TaskPane 在这里调 renderAndInsertSlide。
        // 之前 DIALOG 自己调会卡在 modal 状态 → WPS API 偶发静默失败。改在主上下文（dialog 已 close 后）
        // 调就是普通的 jsapi 调用环境。
        plog("tryDialog", "standalone path: MAIN 调 renderAndInsert", {
          intent: result.intent,
          activeSlideIndex: result.activeSlideIndex,
          slideHint: result.slideHint
        });
        const renderAndInsert = global.WpsAiRenderAndInsertSlide;
        if (typeof renderAndInsert !== "function") {
          pwarn("tryDialog", "WpsAiRenderAndInsertSlide 未注册，跳过插入");
          showMessage("插件未完整初始化，无法插入", "error");
        } else {
          const params = {
            templateName: result.templateName,
            layout: result.layout,
            data: result.data || {},
            palette: result.palette || {},
            intent: result.intent || "insert"
          };
          if (result.intent === "replace" && typeof result.slideHint === "number" && result.slideHint > 0) {
            params.slide = result.slideHint;
          } else if (result.intent === "replace-active" && typeof result.activeSlideIndex === "number" && result.activeSlideIndex > 0) {
            params.slide = result.activeSlideIndex;
            params.intent = "replace";
          }
          // 同上：替换不要再 save 新条目（doConfirm 已经 cache.update）
          const isReplaceLike = params.intent === "replace" || params.intent === "replace-active";
          if (isReplaceLike) params.saveToCache = false;
          plog("tryDialog", "MAIN renderAndInsert params", params);
          (async () => {
            try {
              const r = await renderAndInsert(params);
              plog("tryDialog", "MAIN renderAndInsert OK", { slide: r?.slide, layerCount: r?.layerCount });
              showMessage(`已${result.intent === "insert" ? "插入到末尾" : `替换第 ${r?.slide} 页`}（共 ${r?.layerCount || 1} 张图）`, "success");
            } catch (e) {
              pwarn("tryDialog", "MAIN renderAndInsert THREW", e?.message || String(e));
              showMessage(`插入失败：${e?.message || e}`, "error");
            }
          })();
        }
      }
      return true;
    } catch (e) {
      console.warn("[html-preview] ShowDialog 失败，回退到 inline modal:", e?.message || e);
      _pendingHtmlPreviewOnConfirm = null;
      return false;
    }
  }

  // ====== 以下是原 openHtmlPreviewModal 主体，改名 openHtmlPreviewInline ======
  // 「原地更新」：如果 modal 已经打开且当前 state 存在，且新 opts 的 templateName+layout 一致，
  //   **而且 cacheId 也一致**（同一条历史 / 都是未保存），则只 patch data/palette/slideHint 并重渲。
  //   这样 AI 后续调 wpp_render_html_template 想「修改预览」时，效果是字段被更新而不是弹新窗；
  //   而用户点左侧历史里的另一条（同 template/layout 但不同 id）会**正确切换 state**，不会被原地合并。
  function openHtmlPreviewInline(opts) {
    if (!els.htmlPreviewModal) {
      pwarn("openInline", "els.htmlPreviewModal NOT FOUND — bindElements never ran or HTML missing");
      return;
    }
    opts = opts || {};
    plog("openInline", "entry", { templateName: opts.templateName, layout: opts.layout, hasData: !!opts.data });
    // 拉一次当前 PPT 的 docKey —— 历史/组件按它过滤。每次开预览都重新拿，
    // 用户在不同 PPT 之间切换时自动跟着走。
    refreshCurrentDocKey();
    try { renderHtmlTemplateGallery(); updateHtmlPreviewHistoryBadge(); } catch (e) {}

    const isCurrentlyOpen = !els.htmlPreviewModal.classList.contains("hidden");
    const st = htmlPreviewState;
    // 把 null 和 undefined 当成同一种"未保存"身份处理
    const sameCacheId = (opts.cacheId || null) === (st?.id || null);
    if (isCurrentlyOpen && st && opts.templateName === st.templateName && opts.layout === st.layout && sameCacheId) {
      plog("openInline", "→ IN-PLACE MERGE (same slide), opening?", isCurrentlyOpen);
      // 原地更新：合并 data，不动 onConfirm
      st.data = Object.assign({}, st.data, opts.data || {});
      if (opts.palette) st.palette = Object.assign({}, st.palette, opts.palette);
      if (opts.slideHint != null) st.slideHint = opts.slideHint;
      if (typeof opts.onConfirm === "function" && st.onConfirm && st.onConfirm !== opts.onConfirm) {
        try { st.onConfirm(null); } catch (e) {}
        st.onConfirm = opts.onConfirm;
      } else if (typeof opts.onConfirm === "function" && !st.onConfirm) {
        st.onConfirm = opts.onConfirm;
      }
      renderHtmlPreviewFields();
      renderHtmlPreviewIntoIframe();
      updateHtmlPreviewActionButtons();
      renderHtmlTemplateGallery(); // 历史可能产生了新条目，高亮也要更新
      return;
    }

    htmlPreviewState = opts.templateName ? {
      id: opts.cacheId || null,
      templateName: opts.templateName,
      layout: opts.layout,
      data: Object.assign({}, opts.data || {}),
      palette: Object.assign({}, opts.palette || {}),
      slideHint: opts.slideHint || null,
      // 预览打开时**当前选中**的幻灯片号；后续点「替换当前选中」用它定位，
      // 不再依赖 dialog 关闭后可能不准的 ActiveWindow.View.Slide
      activeSlideIndex: typeof opts.activeSlideIndex === "number" ? opts.activeSlideIndex : null,
      onConfirm: typeof opts.onConfirm === "function" ? opts.onConfirm : null
    } : null;
    plog("openInline", "state replaced; htmlPreviewState =", htmlPreviewState ? `{${htmlPreviewState.templateName}/${htmlPreviewState.layout}}` : "null");
    if (htmlPreviewState) {
      els.htmlPreviewTemplate.textContent = htmlPreviewState.templateName;
      els.htmlPreviewLayout.textContent = htmlPreviewState.layout;
      els.htmlPreviewInfo.textContent = "正在渲染…";
    } else {
      els.htmlPreviewTemplate.textContent = "—";
      els.htmlPreviewLayout.textContent = "—";
      els.htmlPreviewInfo.textContent = "从右侧历史里挑一条预览或编辑";
      pwarn("openInline", "state is NULL — request had no templateName. iframe will show placeholder, NOT real slide.");
      if (els.htmlPreviewFrame) els.htmlPreviewFrame.srcdoc = "<!doctype html><html><body style='display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-family:sans-serif'>从历史里选一条开始</body></html>";
    }
    // 切到新 slide → 清空右侧"美化当前预览"chat（同一 slide key 时不动）
    resetPreviewChatForState(htmlPreviewState);
    updateHtmlPreviewHistoryBadge();
    updateHtmlPreviewActionButtons();
    renderHtmlPreviewFields();
    tryExpandTaskPaneForPreview();
    // 画廊永久可见，每次打开/state 切换都刷新（更新 active 高亮）
    renderHtmlTemplateGallery();
    els.htmlPreviewModal.classList.remove("hidden");
    if (opts.historyMode) {
      toggleHtmlPreviewHistoryPanel(true);
    }
    // 等 modal 显示完了再算 scale（否则 inner.clientWidth=0）
    requestAnimationFrame(() => {
      if (htmlPreviewState) renderHtmlPreviewIntoIframe();
      applyHtmlPreviewScale();
      // 监听窗口/弹窗大小变化，重新算 scale
      if (htmlPreviewResizeObserver) htmlPreviewResizeObserver.disconnect();
      try {
        htmlPreviewResizeObserver = new ResizeObserver(applyHtmlPreviewScale);
        if (els.htmlPreviewFrame?.parentElement) {
          htmlPreviewResizeObserver.observe(els.htmlPreviewFrame.parentElement);
        }
      } catch (e) {
        // 老 WebView 没 ResizeObserver，退化到 window resize
        window.addEventListener("resize", applyHtmlPreviewScale);
      }
    });
  }

  function closeHtmlPreviewModal() {
    els.htmlPreviewModal?.classList.add("hidden");
    if (htmlPreviewResizeObserver) {
      htmlPreviewResizeObserver.disconnect();
      htmlPreviewResizeObserver = null;
    }
    tryRestoreTaskPaneAfterPreview();
    // 关 modal **不**清 chat：store 按 slide key 持久化，下次切回同一 slide 还能看到。
    // 只断开当前绑定 + 清 in-flight 的 AI 上下文数组，下次 reset 会重新从 store 回放。
    _previewChatBoundKey = "";
    previewChatHistory.length = 0;
    // 关 modal 也退出编辑模式（清掉 iframe 内的注入痕迹）
    if (_editorEnabled) disableIframeEditor();
    // 用户关闭 = 取消：通知 onConfirm 为 null
    const st = htmlPreviewState;
    htmlPreviewState = null;
    if (st?.onConfirm) {
      try { st.onConfirm(null); } catch (e) {}
    }
  }

  // 模板画廊：列出所有 templates × layouts，每个一张缩略 iframe（按当前色板渲染样例数据）。
  // 点击 → 关闭画廊 + 打开预览 modal 并载入该模板/布局的初始数据。
  function buildSampleData(layoutName) {
    // 用于画廊缩略图与点击后载入的演示用数据
    switch (layoutName) {
      case "cover": return { title: "文小舟\n演示文稿", subtitle: "你的副标题", tag: "2026 KEYNOTE" };
      case "section": return { number: "01", title: "章节标题", footer: "SECTION" };
      case "content": return { title: "核心要点", body: "第一条要点\n第二条要点\n第三条要点", tag: "OVERVIEW", footer: "" };
      case "stat": return { number: "98%", label: "增长率", description: "相较上一周期" };
      case "feature-grid": return {
        title: "我们的四大优势",
        items: "lightbulb|创意驱动|从用户痛点出发\nzap|快速执行|两周交付 MVP\nshield|稳定保障|99.9% SLA\nusers|协作高效|跨职能共建"
      };
      case "quote": return {
        quote: "设计的本质不是好看，\n而是把复杂变得可理解。",
        author: "Dieter Rams",
        role: "Designer"
      };
      case "comparison": return {
        title: "传统方式 vs 文小舟",
        leftIcon: "x-circle",
        leftLabel: "传统方式",
        leftBody: "手工排版耗时\n配色全凭手感\n字体混用混乱\n改一处全页重排",
        rightIcon: "check-circle",
        rightLabel: "文小舟",
        rightBody: "一句话生成\n色板自动统一\n字体白名单约束\n字段独立可微调"
      };
      case "metric-trio": return {
        title: "上季度关键指标",
        items: "trending-up|+247%|增长率|相较上季度\nusers|12.4M|月活|稳定增长\nactivity|99.9%|可用性|过去 30 天"
      };
      default: return {};
    }
  }

  function currentPaletteForPreview() {
    const settings = currentSettings || {};
    const sp = settings.stylePreset || {};
    const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const matched = sp.scheme && schemes[sp.scheme];
    return {
      backgroundColor: sp.backgroundColor || matched?.backgroundColor || "#FFFFFF",
      surfaceColor: sp.surfaceColor || matched?.surfaceColor || "#F4F4F5",
      primaryColor: sp.primaryColor || matched?.primaryColor || "#1A1A1A",
      secondaryColor: sp.secondaryColor || matched?.secondaryColor || "#525252",
      accentColor: sp.accentColor || matched?.accentColor || "#FF5722",
      titleColor: sp.titleColor || matched?.titleColor || "#1A1A1A",
      bodyColor: sp.bodyColor || matched?.bodyColor || "#404040",
      titleFont: sp.titleFont || matched?.titleFont || "Microsoft YaHei",
      bodyFont: sp.bodyFont || matched?.bodyFont || "Microsoft YaHei"
    };
  }

  // 组件缩略图：跟实际插入 PPT 完全一致地渲染（走 studio/freeform 同一条 render）。
  // - 整个 1920×1080 slide 背景可见（palette.backgroundColor 等）
  // - 组件流式定位到 .stage 左上角（覆盖被保存时带的 absolute top/left）
  // - 整张 slide 按 thumb 比例缩放，跟其他模板/历史卡片视觉一致
  function makeComponentThumbHtml(comp, palette) {
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const freeform = HtmlTpl?.getTemplate?.("studio")?.layouts?.freeform;
    // 让组件在 preview 里贴左上角：
    //   - .stage 直接子元素强制 position: static + 清掉 top/left/transform/margin（覆盖原本可能写死的 absolute 偏移）
    //   - .stage 自身改成 flex 列方向 + 顶端对齐 + 左对齐
    //   - 给一点点 padding 防止零像素贴边（视觉留白）
    const previewResetCss = `
      /* preview: 强制组件流式从左上角开始 */
      .stage { padding: 40px !important; display: flex !important; flex-direction: column !important; align-items: flex-start !important; justify-content: flex-start !important; gap: 24px !important; }
      .stage > * { position: static !important; top: auto !important; left: auto !important; right: auto !important; bottom: auto !important; transform: none !important; margin: 0 !important; }
    `;
    if (freeform) {
      try {
        return freeform.render({ html: comp.html || "", css: (comp.css || "") + previewResetCss }, palette || {});
      } catch (e) { /* fall through 老路径兜底 */ }
    }
    // 兜底：freeform 模块未加载时用老的 inline wrapper（保留以防回归）
    const p = palette || {};
    const bg = p.backgroundColor || "#FFFFFF";
    const bodyColor = p.bodyColor || "#404040";
    const bodyFont = (p.bodyFont || "Microsoft YaHei") + ", 'Microsoft YaHei', sans-serif";
    return `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; }
body { background: ${bg}; color: ${bodyColor}; font-family: ${bodyFont}; }
${comp.css || ""}
</style></head><body>${comp.html || ""}</body></html>`;
  }

  // 组件缩略图缩放：iframe 内是 1920×1080 完整 slide，按 thumb 尺寸等比缩放居中
  // —— 跟历史 / 模板缩略卡同一套缩放策略，组件大小比例真实反映在 slide 里的样子。
  function fitComponentThumb(ifr, thumbWrap) {
    try {
      if (!ifr || !thumbWrap) return;
      const cw = thumbWrap.clientWidth;
      const ch = thumbWrap.clientHeight;
      if (!(cw > 0 && ch > 0)) return;
      // iframe 自身必须撑到 1920×1080，否则 transform scale 是基于错误尺寸
      ifr.style.position = "absolute";
      ifr.style.top = "50%";
      ifr.style.left = "50%";
      ifr.style.width = "1920px";
      ifr.style.height = "1080px";
      ifr.style.transformOrigin = "center center";
      const sW = cw / 1920;
      const sH = ch / 1080;
      const scale = Math.min(sW, sH) * 0.99;
      ifr.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
    } catch (e) { /* sandbox/timing 异常沉默 */ }
  }

  // 通用：构造一张画廊缩略卡。卡片本身是 16:9 缩略，meta 文字默认透明 hover 时显示。
  // 内联线性 SVG 垃圾桶图标（lucide trash-2 风格）
  const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  function makeGalleryCard({ html, primaryLabel, secondaryLabel, onClick, isActive, fit, onDelete, deleteHint, extraClass }) {
    const card = document.createElement("div");
    card.className = "html-template-gallery-item"
      + (isActive ? " active" : "")
      + (extraClass ? " " + extraClass : "");
    const thumbHost = document.createElement("div");
    thumbHost.className = "html-template-gallery-thumb" + (fit === "component" ? " component-thumb-fit" : "");
    const ifr = document.createElement("iframe");
    ifr.setAttribute("sandbox", "allow-same-origin");
    thumbHost.appendChild(ifr);

    // 同套渲染策略：用 document.open/write/close 主动写入（绕过 WPS WebView 的 srcdoc 渲染 bug，
    // 比如保存后缩略图不更新就是因为 srcdoc 没真正重渲）。
    const finishScale = () => {
      // 桥接 echarts → 缩略图里的 chart / canvas 也能跑
      try { bridgeEchartsToFrame(ifr); } catch (e) {}
      if (fit === "component") {
        try { fitComponentThumb(ifr, thumbHost); } catch (e) {}
        return;
      }
      try {
        const w = thumbHost.clientWidth;
        const h = thumbHost.clientHeight;
        const sW = w > 0 ? (w / 1920) : 0;
        const sH = h > 0 ? (h / 1080) : 0;
        let scale;
        if (sW > 0 && sH > 0) scale = Math.min(sW, sH) * 0.99;
        else if (sW > 0)     scale = sW * 0.99;
        else                 scale = 0.1;
        ifr.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
      } catch (e) {}
    };

    // iframe 必须先进 DOM 才有 contentDocument。已经 appendChild 过了，可以同步写。
    let written = false;
    try {
      const doc = ifr.contentDocument;
      if (doc) {
        doc.open();
        doc.write(html);
        doc.close();
        written = true;
      }
    } catch (e) { /* 跨域 / WebView 限制 */ }

    if (written) {
      // 同步路径成功；下一帧算 scale（让浏览器先完成布局）
      requestAnimationFrame(finishScale);
    } else {
      // 兜底：srcdoc + load
      try { ifr.srcdoc = html; }
      catch (e) {
        try { ifr.srcdoc = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">渲染失败</body></html>`; }
        catch (_) {}
      }
      ifr.addEventListener("load", finishScale);
      // 兜底兜底：500ms 内还没 load 就强算一次 scale
      setTimeout(() => { if (!ifr._scaled) { ifr._scaled = true; finishScale(); } }, 500);
    }
    const meta = document.createElement("div");
    meta.className = "html-template-gallery-meta";
    const p = document.createElement("span");
    p.className = "tpl-name";
    p.textContent = primaryLabel;
    const s = document.createElement("span");
    s.className = "layout-name";
    s.textContent = secondaryLabel;
    meta.appendChild(p);
    meta.appendChild(s);
    card.appendChild(thumbHost);
    card.appendChild(meta);
    // hover 删除按钮：仅当 onDelete 给了才显示。右上角内嵌；点击时不触发卡片 onClick。
    if (typeof onDelete === "function") {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "html-template-gallery-del";
      del.title = deleteHint || "删除";
      del.innerHTML = TRASH_SVG;
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onDelete(ev);
      });
      card.appendChild(del);
    }
    if (onClick) card.addEventListener("click", onClick);
    return card;
  }

  // 当前选中的画廊 tab：history（我的历史，默认）/ components（组件）/ templates（模板）
  let _galleryActiveTab = "history";
  const GALLERY_TABS = ["history", "components", "templates"];

  // 修 #9: 画廊卡片复用缓存。key = 身份（tab+id），sig = 内容签名（ts/palette/draft）。
  // 同 key 同 sig → 复用现有 iframe DOM，避免每次缓存改动都重建 20 个 iframe（WebView 重渲 html2canvas/echarts 极慢）。
  // 同 key 不同 sig → 重建（内容真的变了）。不同 key → 新建或删除。
  const _galleryCardCache = new Map();

  function setGalleryTab(tab) {
    if (!GALLERY_TABS.includes(tab)) return;
    _galleryActiveTab = tab;
    // 同步 tab 按钮 active 高亮
    document.querySelectorAll(".gallery-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.galleryTab === tab);
    });
    renderHtmlTemplateGallery();
  }

  // 「清空所有」按钮：仅在 history / components tab 显示，按当前 tab 决定清谁
  function updateGalleryFootButton() {
    const foot = els.htmlTemplateGalleryFoot;
    const btn = els.htmlTemplateGalleryClearBtn;
    if (!foot || !btn) return;
    const host = els.htmlTemplateGalleryList;
    const hasItems = !!(host && host.querySelector(".html-template-gallery-item"));
    if (_galleryActiveTab === "history") {
      btn.textContent = "清空所有历史";
      foot.classList.toggle("hidden", !hasItems);
    } else if (_galleryActiveTab === "components") {
      btn.textContent = "清空所有组件";
      foot.classList.toggle("hidden", !hasItems);
    } else {
      foot.classList.add("hidden");
    }
  }

  function clearGalleryActiveTab() {
    if (_galleryActiveTab === "history") {
      if (!confirm("清空「我的历史」全部缓存条目？此操作不可撤销。")) return;
      const cache = global.WpsAiHtmlCache;
      let tries = 0;
      while (tries < 3) {
        const list = cache?.list?.(50) || [];
        if (!list.length) break;
        list.forEach((entry) => { try { cache.remove?.(entry.id); } catch (e) {} });
        tries += 1;
      }
      // 同步把跟历史挂钩的 chat 日志清掉
      try {
        previewChatLogByKey.forEach((_v, k) => {
          if (typeof k === "string" && k.startsWith("id::")) previewChatLogByKey.delete(k);
        });
        savePreviewChatLogsToStorage();
      } catch (e) {}
      if (htmlPreviewState?.id) htmlPreviewState.id = null;
      updateHtmlPreviewHistoryBadge();
    } else if (_galleryActiveTab === "components") {
      if (!confirm("清空全部自定义组件？此操作不可撤销。")) return;
      const comps = global.WpsAiHtmlComponents;
      const list = comps?.list?.() || [];
      list.forEach((c) => { try { comps.remove?.(c.id); } catch (e) {} });
      // 清掉所有 slide 对组件的选用引用
      pickedComponentsByKey.clear();
      savePickedComponentsToStorage();
      updatePickedComponentsCountBadge();
    } else {
      return;
    }
    renderHtmlTemplateGallery();
  }

  function renderHtmlTemplateGallery() {
    const host = els.htmlTemplateGalleryList;
    if (!host) return;
    const HtmlTpl = global.WpsAiHtmlTemplates;
    if (!HtmlTpl?.listTemplates) {
      _galleryCardCache.clear();
      host.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">HTML 模板模块未加载</div>';
      return;
    }
    const palette = currentPaletteForPreview();
    const paletteSig = JSON.stringify(palette);

    // 用当前 state 判断哪张卡是"当前"，高亮蓝边
    const curSt = htmlPreviewState;
    const curTplLayout = curSt ? `${curSt.templateName}::${curSt.layout}::${curSt.id || ""}` : "";

    // desc: 这一帧期望渲染的全部卡描述（顺序即视觉顺序）
    // 每条带 key（身份）+ sig（内容签名）+ isActive/extraClass（轻量样式）+ build（首次创建用）
    const desc = [];
    let emptyMsg = "";

    if (_galleryActiveTab === "components") {
      // ---- Tab：组件库（freeform 抽出的可复用 HTML+CSS 片段；只显示当前 PPT 或无 docKey 的 legacy 组件）----
      const comps = global.WpsAiHtmlComponents?.list?.({ docKey: _cachedDocKey }) || [];
      comps.forEach((comp) => {
        desc.push({
          key: `comp::${comp.id}`,
          sig: `${comp.ts}::${paletteSig}`,
          isActive: false,
          extraClass: "",
          build: () => {
            let html;
            try { html = makeComponentThumbHtml(comp, palette); }
            catch (e) { html = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">${e?.message || e}</body></html>`; }
            return makeGalleryCard({
              html,
              primaryLabel: comp.name,
              secondaryLabel: comp.description || formatHtmlPreviewTs(comp.ts),
              isActive: false,
              fit: "component",
              onClick: () => {
                openHtmlPreviewModal({
                  templateName: "studio",
                  layout: "freeform",
                  data: { html: comp.html, css: comp.css || "" },
                  palette: currentPaletteForPreview()
                });
              },
              deleteHint: `从组件库删除「${comp.name}」`,
              onDelete: () => {
                if (!confirm(`从组件库删除「${comp.name}」？此操作不可撤销。`)) return;
                global.WpsAiHtmlComponents?.remove?.(comp.id);
                pickedComponentsByKey.forEach((arr, k) => {
                  const filtered = arr.filter((x) => x !== comp.id);
                  if (filtered.length !== arr.length) {
                    if (filtered.length) pickedComponentsByKey.set(k, filtered);
                    else pickedComponentsByKey.delete(k);
                  }
                });
                savePickedComponentsToStorage();
                updatePickedComponentsCountBadge();
                renderHtmlTemplateGallery();
              }
            });
          }
        });
      });
      if (!desc.length) emptyMsg = '组件库空空如也。<br>在 freeform 预览底部点「保存为组件」往里加。';
    } else if (_galleryActiveTab === "templates") {
      // ---- Tab：模板 × 布局（用样例数据渲染缩略图）----
      const slugs = HtmlTpl.listTemplates();
      slugs.forEach((slug) => {
        const tpl = HtmlTpl.getTemplate(slug);
        const layouts = HtmlTpl.listLayouts(slug);
        layouts.forEach((layoutName) => {
          const cardKey = `${slug}::${layoutName}::`;
          const isActive = curTplLayout === cardKey;
          desc.push({
            key: `tpl::${slug}::${layoutName}`,
            // 模板缩略图只依赖 palette；palette 变了要重建
            sig: paletteSig,
            isActive,
            extraClass: "",
            build: () => {
              let html;
              try {
                html = tpl.layouts[layoutName].render(buildSampleData(layoutName), palette);
              } catch (e) {
                html = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">${e?.message || e}</body></html>`;
              }
              return makeGalleryCard({
                html,
                primaryLabel: slug,
                secondaryLabel: layoutName,
                isActive,
                onClick: () => {
                  openHtmlPreviewModal({
                    templateName: slug,
                    layout: layoutName,
                    data: buildSampleData(layoutName),
                    palette: currentPaletteForPreview()
                  });
                }
              });
            }
          });
        });
      });
      if (!desc.length) emptyMsg = '暂无可用模板';
    } else {
      // ---- Tab：我的历史（从缓存读；只显示当前 PPT 或无 docKey 的 legacy 历史）----
      const cache = global.WpsAiHtmlCache;
      const entries = cache?.list?.({ limit: 20, docKey: _cachedDocKey }) || [];
      plog("gallery", "history tab; docKey=" + (_cachedDocKey || "(empty)")
        + " entries=" + entries.length
        + " curStateId=" + (curSt?.id || "(none)")
        + " ids=[" + entries.map((e) => e.id).join(",") + "]");
      entries.forEach((entry) => {
        const cardKey = `${entry.templateName}::${entry.layout}::${entry.id}`;
        const isActive = curTplLayout === cardKey;
        desc.push({
          key: `hist::${entry.id}`,
          // 历史卡 sig = ts（保存/编辑后 cache.update 会刷新 ts）+ palette + draft 状态
          sig: `${entry.ts}::${paletteSig}::${entry.draft ? "d" : "n"}`,
          isActive,
          extraClass: entry.draft ? "is-draft" : "",
          build: () => {
            const tpl = HtmlTpl.getTemplate(entry.templateName);
            const layoutDef = tpl?.layouts?.[entry.layout];
            let html;
            if (!layoutDef) {
              html = `<html><body style="padding:20px;font-family:sans-serif;color:#888">模板已下线：${entry.templateName} / ${entry.layout}</body></html>`;
            } else {
              try {
                const effectivePalette = Object.assign({}, palette, entry.palette || {});
                html = layoutDef.render(entry.data || {}, effectivePalette);
              } catch (e) {
                html = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">${e?.message || e}</body></html>`;
              }
            }
            const firstField = Object.values(entry.data || {})[0] || "";
            const primaryLabel = entry.draft
              ? `${entry.templateName} · 草稿`
              : entry.templateName;
            return makeGalleryCard({
              html,
              primaryLabel,
              secondaryLabel: String(firstField).slice(0, 24) || formatHtmlPreviewTs(entry.ts),
              isActive,
              extraClass: entry.draft ? "is-draft" : "",
              onClick: () => {
                openHtmlPreviewModal({
                  cacheId: entry.id,
                  templateName: entry.templateName,
                  layout: entry.layout,
                  data: Object.assign({}, entry.data || {}),
                  palette: Object.assign({}, entry.palette || {}),
                  slideHint: entry.slideHint || null
                });
              },
              deleteHint: "从「我的历史」删除这条",
              onDelete: () => {
                if (!confirm(`从「我的历史」删除这条（${entry.templateName} / ${entry.layout}）？此操作不可撤销。`)) return;
                cache.remove?.(entry.id);
                const key = `id::${entry.id}`;
                if (previewChatLogByKey.has(key)) {
                  previewChatLogByKey.delete(key);
                  savePreviewChatLogsToStorage();
                }
                if (htmlPreviewState?.id === entry.id) htmlPreviewState.id = null;
                updateHtmlPreviewHistoryBadge();
                renderHtmlTemplateGallery();
              }
            });
          }
        });
      });
      if (!desc.length) emptyMsg = '暂无历史。点「保存」入库后会出现在这里。';
    }

    // ---- diff 应用：复用未变的卡，重建变了的卡，删除不再出现的卡 ----
    // 1) 清掉非卡子节点（如上次留下的空态占位 div）
    Array.from(host.children).forEach((child) => {
      if (!child.dataset || !child.dataset.galleryKey) host.removeChild(child);
    });

    // 2) 空列表：清空全部缓存 + 显示空态文案，提前退出
    if (!desc.length) {
      _galleryCardCache.forEach((e) => {
        if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
      });
      _galleryCardCache.clear();
      host.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:12px">${emptyMsg}</div>`;
      updateGalleryFootButton();
      return;
    }

    // 3) 删除已不在 desc 里的缓存卡
    const desiredKeys = new Set(desc.map((d) => d.key));
    Array.from(_galleryCardCache.keys()).forEach((k) => {
      if (!desiredKeys.has(k)) {
        const cached = _galleryCardCache.get(k);
        if (cached && cached.el && cached.el.parentNode) cached.el.parentNode.removeChild(cached.el);
        _galleryCardCache.delete(k);
      }
    });

    // 4) 按 desc 顺序就位：sig 不变 → 仅更新 class；变了 → rebuild
    for (let i = 0; i < desc.length; i++) {
      const d = desc[i];
      let cached = _galleryCardCache.get(d.key);
      if (cached && cached.sig !== d.sig) {
        if (cached.el && cached.el.parentNode) cached.el.parentNode.removeChild(cached.el);
        _galleryCardCache.delete(d.key);
        cached = null;
      }
      let el;
      if (cached) {
        el = cached.el;
        // 仅切换 active / draft class，不重建 iframe
        el.className = "html-template-gallery-item"
          + (d.isActive ? " active" : "")
          + (d.extraClass ? " " + d.extraClass : "");
      } else {
        el = d.build();
        el.dataset.galleryKey = d.key;
        _galleryCardCache.set(d.key, { el, sig: d.sig });
      }
      const cur = host.children[i];
      if (cur !== el) host.insertBefore(el, cur || null);
    }
    // 5) 兜底：移除任何尾部多余节点（理论上 4 步后正好等长）
    while (host.children.length > desc.length) {
      const extra = host.children[host.children.length - 1];
      const k = extra.dataset && extra.dataset.galleryKey;
      if (k) _galleryCardCache.delete(k);
      host.removeChild(extra);
    }

    updateGalleryFootButton();
  }

  // 画廊改成永久可见的侧栏。此函数现在只用来"刷新内容"；保留签名向后兼容。
  function toggleHtmlTemplateGallery(_show) {
    if (!els.htmlTemplateGallery) return;
    renderHtmlTemplateGallery();
  }

  // ===== 独立预览 chat 会话 =====
  // 这是一个隔离的小聊天，**不进主对话历史**，**不调任何 PPT 工具**。
  // 实现：直接调当前 provider 的 streamChat，给一个强约束的 system prompt，要求 AI 只
  // 输出 JSON 描述要更新的字段；解析后直接 patch 到 htmlPreviewState.data，触发 iframe 重渲。
  // 优点：完全隔离 + 简单可控；不依赖 OpenAI tools 协议。
  //
  // 持久化：每个 slide（state key = templateName::layout::id）独立保存自己的对话历史，
  // 切换历史时自动回显。previewChatLogByKey 是真相源；previewChatHistory 是给 AI 的
  // 上下文，等于 previewChatLogByKey[currentKey] 里过滤掉纯展示型条目（如 ai-err、
  // ai-pending）的 {role,content} 序列。

  // 每条记录形状：{ role: "user"|"ai"|"ai-err"|"ai-pending", displayText: string, aiContent?: string }
  // - role: 决定气泡样式（同 appendPreviewChatMsg 的 role 参数）
  // - displayText: 实际显示在气泡里的人类可读文本
  // - aiContent: 仅对要进 AI 上下文的条目（user / ai 成功），用于喂给下一轮 LLM
  const previewChatLogByKey = new Map();
  // 给 AI 用的视图：每次提交前从当前 key 的日志里抽出 {role,content}（role 转 "user"|"assistant"）
  const previewChatHistory = [];

  // Preview 是用 Application.ShowDialog 开的独立 WebView 窗口，关闭再开是全新 JS context，
  // in-memory Map 会丢。把 chat 日志持久化到 localStorage，保证跨 dialog 开关 + 切换历史能回显。
  const PREVIEW_CHAT_LOG_KEY = "lingxi_html_preview_chat_log_v1";
  function loadPreviewChatLogsFromStorage() {
    try {
      const raw = global.WpsAiStore.getItem(PREVIEW_CHAT_LOG_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach((k) => {
          if (Array.isArray(parsed[k])) previewChatLogByKey.set(k, parsed[k]);
        });
      }
    } catch (e) { /* 解析失败就当没有，正常往下走 */ }
  }
  function savePreviewChatLogsToStorage() {
    try {
      const obj = {};
      previewChatLogByKey.forEach((v, k) => { obj[k] = v; });
      global.WpsAiStore.setItem(PREVIEW_CHAT_LOG_KEY, JSON.stringify(obj));
    } catch (e) { /* localStorage 满了/不可用，沉默 */ }
  }
  // 模块加载就立刻读一次，给后续切换历史 + 工具回调一份热数据
  loadPreviewChatLogsFromStorage();

  // 把 text 插入到 textarea/input 当前光标位置；自动触发 input 事件。
  // 给 paste 手动处理用，WPS WebView 部分版本默认 paste 失灵的兜底。
  function insertAtCursor(el, text) {
    if (!el) return;
    const value = el.value || "";
    const start = el.selectionStart != null ? el.selectionStart : value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : value.length;
    el.value = value.slice(0, start) + text + value.slice(end);
    // setRangeText 在某些 WebView 报错，直接改 value + 手动设光标更稳
    const caret = start + text.length;
    try {
      el.selectionStart = caret;
      el.selectionEnd = caret;
    } catch (e) { /* readonly 等场景跳过 */ }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const PREVIEW_CHAT_EMPTY_HTML = '<div class="html-preview-chat-empty">让 AI 帮你改预览：<br>· 改文字 ——「标题改短」「数字换成 73%」<br>· 切排版 ——「换成有图标的网格」「改成大数字版式」<br>· 调配色 ——「换成深色背景」「主色改成蓝色」<br>· 整体美化 ——「美化排版」「更专业」</div>';

  // 把一条消息渲染到聊天框 DOM。不写存储 —— 那是 appendPreviewChatMsg 的事。
  function renderPreviewChatBubble(role, text) {
    const log = els.htmlPreviewChatLog;
    if (!log) return null;
    const empty = log.querySelector(".html-preview-chat-empty");
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = `html-preview-chat-msg ${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  // 给一个 state 算唯一 key（用于 per-slide chat 持久化）
  // - 已保存到缓存（有 id） → 用 id 作为身份，layout 在编辑中变化不影响 chat 归属
  // - 未保存（无 id） → 用 template+layout，保存时 saveHtmlPreviewToCache 会把日志搬到新 id key
  function previewStateKey(st) {
    if (!st) return "";
    if (st.id) return `id::${st.id}`;
    return `unsaved::${st.templateName || ""}::${st.layout || ""}`;
  }

  // 拿当前 key 的存储数组；不存在就建一个
  function currentChatLogStore() {
    const key = _previewChatBoundKey;
    if (!key) return null;
    if (!previewChatLogByKey.has(key)) previewChatLogByKey.set(key, []);
    return previewChatLogByKey.get(key);
  }

  // 写一条消息：渲染到 DOM + 存到当前 key 的日志（pending 不存）+ 同步喂给 AI 上下文
  // aiContent 给 ai 成功气泡用，作为下一轮 LLM 的 assistant content
  function appendPreviewChatMsg(role, text, aiContent) {
    const bubble = renderPreviewChatBubble(role, text);
    if (role === "ai-pending") return bubble; // 临时占位，不持久化也不进 AI 上下文
    const store = currentChatLogStore();
    if (store) {
      store.push({ role, displayText: text, aiContent: aiContent || null });
      savePreviewChatLogsToStorage();
    }
    // 同步 AI 上下文（previewChatHistory）—— user 进、ai 成功的 aiContent 进，
    // ai-err 不进（避免污染上下文）
    if (role === "user") {
      previewChatHistory.push({ role: "user", content: text });
    } else if (role === "ai" && aiContent) {
      previewChatHistory.push({ role: "assistant", content: aiContent });
    }
    return bubble;
  }

  // 把 store 重放到 DOM（切回历史会话时用）+ 同步重建 AI 上下文 previewChatHistory
  function renderPreviewChatFromStore() {
    const log = els.htmlPreviewChatLog;
    if (!log) return;
    log.innerHTML = "";
    previewChatHistory.length = 0;
    const store = currentChatLogStore();
    if (!store || !store.length) {
      log.innerHTML = PREVIEW_CHAT_EMPTY_HTML;
      return;
    }
    store.forEach((entry) => {
      renderPreviewChatBubble(entry.role, entry.displayText);
      // 给 AI 喂上下文：仅 user / ai 成功条目
      if (entry.role === "user") {
        previewChatHistory.push({ role: "user", content: entry.displayText });
      } else if (entry.role === "ai" && entry.aiContent) {
        previewChatHistory.push({ role: "assistant", content: entry.aiContent });
      }
    });
  }

  // 用户点「清空会话」时调：当前 slide 的 chat 全清
  function clearPreviewChatLog() {
    const key = _previewChatBoundKey;
    if (key) {
      previewChatLogByKey.set(key, []);
      savePreviewChatLogsToStorage();
    }
    previewChatHistory.length = 0;
    const log = els.htmlPreviewChatLog;
    if (log) log.innerHTML = PREVIEW_CHAT_EMPTY_HTML;
  }

  // 当前 chat 会话绑定的 state key
  let _previewChatBoundKey = "";
  // state 切到新 slide：先把当前 key 的 chat 留在 Map 里（已经在写时持久化了），
  // 再把新 key 的 chat 回放到 DOM。同 key 直接 return。
  function resetPreviewChatForState(newSt) {
    const key = previewStateKey(newSt);
    if (key === _previewChatBoundKey) return;
    _previewChatBoundKey = key;
    renderPreviewChatFromStore();
  }

  // 调当前 provider 出一次响应。返回累积的 raw 文本。
  async function callProviderForPreviewChat(messages, onToken) {
    const reg = global.WpsAiProviderRegistry;
    if (!reg) throw new Error("provider registry 未加载");
    const config = reg.getActiveChatProvider?.() || reg.getActiveConfig?.();
    if (!config) throw new Error("当前没有可用 provider，先在设置里配一个");
    const provider = reg.buildProvider(config);
    const model = els.modelSelect?.value || config.defaultModel || "gpt-4o-mini";
    let raw = "";
    if (provider.streamChat) {
      await provider.streamChat({
        model,
        messages,
        onToken: (tok) => {
          raw += tok;
          if (onToken) onToken(tok, raw);
        }
      });
    } else if (provider.chat) {
      const resp = await provider.chat({ model, messages });
      raw = typeof resp === "string" ? resp : (resp?.content || resp?.text || JSON.stringify(resp));
      if (onToken) onToken(raw, raw);
    } else {
      throw new Error("当前 provider 不支持 chat 接口");
    }
    return raw;
  }

  // 项目名：每对话由 AI 总结一次，存在对话对象上，获取素材时作为项目标签复用。
  // 替代原来「设置里手填当前项目」。name() 同步读缓存；ensure() 异步生成（一对话一次）。
  const WpsAiProject = (function () {
    const generating = new Set();
    function curConv() {
      try { return global.WpsAiConversations?.getCurrent?.() || null; } catch (e) { return null; }
    }
    function name() {
      const c = curConv();
      return (c && typeof c.projectName === "string") ? c.projectName : "";
    }
    async function ensure() {
      const c = curConv();
      if (!c || !c.id) return "";
      if (c.projectName) return c.projectName;
      if (generating.has(c.id)) return "";
      generating.add(c.id);
      try {
        const userText = (Array.isArray(c.messages) ? c.messages : [])
          .filter((m) => m.role === "user")
          .map((m) => {
            if (typeof m.content === "string") return m.content;
            if (Array.isArray(m.content)) return m.content.filter((x) => x && x.type === "text").map((x) => x.text).join(" ");
            return "";
          })
          .filter(Boolean).slice(0, 4).join("\n").slice(0, 1000);
        if (!userText.trim()) return ""; // 还没有对话内容，不调 AI
        const out = await callProviderForPreviewChat([
          { role: "system", content: "你是项目命名助手。根据用户的任务内容，给这个项目起一个简短中文名称（4-12 字，概括主题，不要标点、引号、书名号，不要任何解释）。只输出名称本身。" },
          { role: "user", content: "任务内容：\n" + userText + "\n\n项目名称：" }
        ]);
        const projectName = String(out || "").trim().split(/\r?\n/)[0].replace(/["'「」《》]/g, "").trim().slice(0, 20);
        if (projectName) global.WpsAiConversations?.setProjectName?.(c.id, projectName);
        return projectName;
      } catch (e) {
        return "";
      } finally {
        generating.delete(c.id);
      }
    }
    return { name, ensure };
  })();
  global.WpsAiProject = WpsAiProject;

  // 解析 AI 的 JSON 输出，宽容处理 markdown 围栏。
  // 修 #11: AI 经常在 JSON patch 前后塞解释文字甚至 `{"看起来像 JSON"}` 的示例，
  // 老路径用 first {/ last } 会把中间无关文本一起 parse 失败。新策略：
  //   1) 优先匹配 markdown 围栏 ```json ... ```
  //   2) 失败：扫描全文，按括号配平找出**所有顶层对象**，挑最长且能 JSON.parse 的那个
  //   3) 全部失败：fallback 到 first {/ last } 老路径（兜底，跟过去行为一致）
  function parsePreviewChatJson(raw) {
    const s = String(raw || "").trim();

    // ① markdown 围栏 — 注意 [\s\S] 避免 . 不匹配换行
    const fenceMatch = s.match(/```(?:json|JSON)?\s*([\s\S]+?)```/);
    if (fenceMatch) {
      const inner = fenceMatch[1].trim();
      try { return JSON.parse(inner); } catch (_) { /* 围栏内不是合法 JSON，往下走 */ }
    }

    // ② 扫描配平花括号，列出所有顶层 {...}
    const candidates = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(s.slice(start, i + 1));
          start = -1;
        } else if (depth < 0) {
          // 不配平就重置
          depth = 0;
          start = -1;
        }
      }
    }
    // 按长度倒序，挑第一个能 parse 的
    candidates.sort((a, b) => b.length - a.length);
    for (const c of candidates) {
      try { return JSON.parse(c); } catch (_) {}
    }

    // ③ 兜底：老路径
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first < 0 || last < 0 || last < first) throw new Error("找不到 JSON 对象");
    return JSON.parse(s.slice(first, last + 1));
  }

  async function submitHtmlPreviewChat() {
    const ta = els.htmlPreviewChatInput;
    if (!ta) return;
    const userText = (ta.value || "").trim();
    if (!userText) return;
    const st = htmlPreviewState;
    if (!st) {
      appendPreviewChatMsg("ai-err", "当前没有预览，无法编辑。");
      return;
    }
    ta.value = "";
    appendPreviewChatMsg("user", userText);

    // 构造焦点 system prompt：让 AI 输出 JSON patch（可改字段值 + 切布局 + 调配色）
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    const fieldList = tpl?.layouts?.[st.layout]?.fields || Object.keys(st.data || {});
    const allLayouts = Object.keys(tpl?.layouts || {});
    // 列出每个布局对应的字段，方便 AI 选 layout 时知道要填什么
    const layoutSchemas = allLayouts.map((name) => {
      const fs = tpl?.layouts?.[name]?.fields || [];
      return `  - ${name}: [${fs.join(", ")}]`;
    }).join("\n");
    const paletteKeys = ["primaryColor", "accentColor", "backgroundColor", "surfaceColor", "titleColor", "bodyColor", "titleFont", "bodyFont"];

    // 用户已经在「PPT 风格设置」里挑过整套视觉风格 —— 把这个 ground truth 喂给 AI，
    // 让它默认锁住这套配色 + 字体，不要每次美化都换风格导致整组 PPT 不统一。
    const sp = currentSettings?.stylePreset || {};
    const presetEnabled = !!sp.enabled;
    const presetPaletteFull = currentPaletteForPreview();
    const presetSchemeName = presetEnabled ? (sp.scheme || "custom") : "（未启用 PPT 风格 → 用当前 state 自带 palette）";
    const styleConsistencyBlock = presetEnabled
      ? [
          `用户的**全局 PPT 风格**：${presetSchemeName}`,
          `全局风格的配色 + 字体（JSON）：${JSON.stringify(presetPaletteFull, null, 2)}`,
          "→ 默认必须用这套配色和字体，整组 PPT 视觉才能保持统一。**禁止**因为一句「美化」就换主题色或换字体。"
        ].join("\n")
      : `（用户未启用全局 PPT 风格设置，可自由配色。当前 state 的 palette: ${JSON.stringify(st.palette || {}, null, 2)}）`;

    // 用户挑选的"必须复用"组件 —— 注入它们的 html/css，让 AI 在新页里复用相同的视觉单元。
    // 整组 PPT 因此能形成"组件层级的一致性"（不是只有色板一致，而是相同的卡片样式 / 数据卡 / 时间轴样式等）。
    // 修 #8: 单组件 html+css 超过 3KB 截断尾部；总长度超 15KB 在 chat 里给警告
    const pickedIds = getPickedComponentIds();
    const pickedComponents = pickedIds.length
      ? (global.WpsAiHtmlComponents?.getMany?.(pickedIds) || [])
      : [];
    const SINGLE_LIMIT = 3000;   // 单个组件 html / css 各上限 3000 字符
    const TOTAL_WARN_LIMIT = 15000; // 总长度超此值给警告
    function truncCode(code, max) {
      const s = String(code || "");
      if (s.length <= max) return s;
      return s.slice(0, max) + `\n/* ... 已截断 ${s.length - max} 字符，仅保留前 ${max}；完整 HTML/CSS 请用 wpp_get_component 查询 */`;
    }
    let pickedTotalLen = 0;
    const componentReuseBlock = pickedComponents.length
      ? [
          `用户**手动选了 ${pickedComponents.length} 个**组件库里的组件，要求 AI 在当前页里复用它们（保持全册 PPT 视觉一致）：`,
          ...pickedComponents.map((c, i) => {
            const htmlSafe = truncCode(c.html, SINGLE_LIMIT);
            const cssSafe = truncCode(c.css, SINGLE_LIMIT);
            pickedTotalLen += htmlSafe.length + cssSafe.length;
            return [
              `\n--- 组件 ${i + 1}: ${c.name} ---`,
              c.description ? `用途说明：${c.description}` : "",
              `HTML：\n${htmlSafe}`,
              cssSafe ? `CSS：\n${cssSafe}` : "（无独立 CSS，复用 stage 默认样式）"
            ].filter(Boolean).join("\n");
          }),
          "\n→ 切到 layout=freeform，把上述组件**逐字符**搬到 freeform 的 html/css 里组合使用；可以多次复用（一个网格里铺多张同款卡），但不要改它们的 class 名 / 样式，否则就失去「复用」的意义。",
          "→ 如果用户当前页的字段已经有内容（title/body 等），把这些内容**填进**复用过来的组件占位里，不要丢；组件外多余的视觉装饰可以自由发挥。"
        ].join("\n")
      : "";
    // 注入长度警告：超 15KB 时 chat 里弹一条 ai-err，让用户知道可能爆 context
    if (pickedTotalLen > TOTAL_WARN_LIMIT) {
      try {
        appendPreviewChatMsg("ai-err",
          `⚠ 选中的 ${pickedComponents.length} 个组件总长度约 ${(pickedTotalLen / 1000).toFixed(1)} KB，` +
          `可能撞到某些模型的 context 上限（如 DeepSeek-V2 32K）。建议精简到 3-5 个核心组件。`
        );
      } catch (e) {}
    }

    const systemPrompt = [
      "你是 HTML 幻灯片预览编辑助手。可以做三件事：①改字段文字 ②切换排版布局（含 freeform 自由设计） ③调整配色。",
      "",
      `当前模板：${st.templateName}`,
      `当前布局：${st.layout}`,
      `当前可编辑字段（严格使用这些 key，区分大小写）：${fieldList.join(", ")}`,
      `当前字段值（JSON）：${JSON.stringify(st.data || {}, null, 2)}`,
      `当前配色（JSON）：${JSON.stringify(st.palette || {}, null, 2)}`,
      "",
      styleConsistencyBlock,
      ...(componentReuseBlock ? ["", componentReuseBlock] : []),
      "",
      `本模板可选的全部布局（key: [必填字段]）：\n${layoutSchemas}`,
      "",
      `配色可用 key：${paletteKeys.join(", ")}；颜色用 #RRGGBB，字体用 CSS font-family 字符串。`,
      "",
      "**只输出一段 raw JSON**，禁止任何解释、寒暄、markdown 围栏。格式：",
      '{"layout": "可选-切到新布局名", "data": {"字段名": "新值", ...}, "palette": {"primaryColor": "#xxxxxx", ...}}',
      "",
      "规则：",
      "1. **必须积极改动**：用户说「美化」「优化」「更好看」「更专业」「换个排版」「太死板了」等模糊指令时，主动做出实质改动 —— 优先考虑切 freeform 自己设计，配上协调的配色。绝对不要返回空对象让用户再说一遍。",
      "2. **切排版时内容必须 1:1 保留**：layout 字段一旦给值，必须把现有 data 里所有非空字段的**原文**完整搬到新布局的对应字段里 —— 只能在字段之间重新分配/合并/拆分，**严禁改写、概括、缩短、补充、删除任何文字**。例如：",
      "   - 原 cover (title=\"项目背景\", subtitle=\"2024 年 Q3 复盘\") → content：必须填 {\"title\": \"项目背景\", \"body\": \"2024 年 Q3 复盘\"}，title 与 subtitle 的原文一字不改。",
      "   - 切 freeform 时：把所有原文（包括 title、subtitle、body、items 里的每一行、tag、footer 等）**全部**渲染到 freeform 的 HTML 里，不能丢任何一句话。",
      "   如果用户明确说「同时把文案改得更精炼」「重写下标题」之类的指令，才可以改写文字；否则一律保留原文。",
      "3. **何时用 freeform**（重点）：现有 8 个固定 layout 表达不下原内容、或用户要求精致 / 商务 / 科技 / 杂志感等设计风格时，**直接切到 layout=freeform**，自己写完整 body HTML + CSS，不要硬塞进 stat / quote 这种小容量布局丢数据。freeform 没有字段 schema 约束，data 只有两个 key：",
      "   - `html`: 完整的 body 内容（不要包 <html>/<head>/<body>，stage 已经是 1920×1080 画布）。所有文本必须 HTML-escape（用实体 &amp; / &lt; / &gt; / &quot;）。",
      "   - `css`: 自定义 CSS（可选）。可用全局 CSS 变量：var(--bg) / var(--surface) / var(--primary) / var(--accent) / var(--title-color) / var(--body-color) / var(--title-font) / var(--body-font)。**所有颜色和字体必须用 CSS 变量引用**，不要在 freeform CSS 里硬编码 #RRGGBB 颜色或具体字体名 —— 用户切换全局 PPT 风格时，写死的颜色不会跟着变，整套幻灯片就花了。",
      "   ⚠ **字号必须匹配 PPT 标准磅值**。画布 1920×1080 = 13.333\" → **1pt = 2px**。AI 在脑子里按 PPT pt 思考，转成 px 写到 CSS 里。常用对照（pt → px）：",
      "      10pt=20px · 12pt=24px · 14pt=28px · 16pt=32px · 18pt=36px · 20pt=40px · 22pt=44px · 24pt=48px · 28pt=56px · 32pt=64px · 36pt=72px · 40pt=80px · 44pt=88px · 54pt=108px · 60pt=120px · 72pt=144px · 88pt=176px · 96pt=192px",
      "   各角色推荐字号（PPT 视觉规范 + 上述映射）：",
      "      | 角色                | PPT pt   | CSS px    | 字重    | 备注 |",
      "      | ------------------- | -------- | --------- | ------- | --- |",
      "      | 封面 hero 标题      | 60-96pt  | 120-192px | 800-900 | 单页主标题 |",
      "      | 章节标题 (slide H1) | 40-54pt  | 80-108px  | 800     | 内容页大标题 |",
      "      | 二级标题 / 副标题   | 28-36pt  | 56-72px   | 700     | |",
      "      | 章节眉签 (eyebrow)  | 14-18pt  | 28-36px   | 700     | letter-spacing 0.16em-0.3em |",
      "      | **正文** (p / li)   | **18-22pt** | **36-44px** | 400-500 | **最低 14pt = 28px** |",
      "      | 卡片描述 / 表格单元 | 16-20pt  | 32-40px   | 400     | |",
      "      | metric 数字 (KPI)   | 60-110pt | 120-220px | 900     | 突出指标 |",
      "      | metric 标签         | 16-22pt  | 32-44px   | 700     | 数字旁边的说明 |",
      "      | 页码 / 脚注 / 来源  | 11-14pt  | 22-28px   | 400-600 | |",
      "      | **绝对底线**        | **10pt** | **20px**  |         | 任何细字也**不能小于这个** |",
      "   line-height：标题 1.0-1.15，正文 1.4-1.6（行距对可读性影响大）。",
      "   freeform 视觉建议：左侧 80px 渐变竖条 / 顶部 4px 渐变条作为视觉标识；标题用 var(--title-font) 粗体；卡片用 var(--surface) 背景 + 1px var(--primary) 8% 透明边框；强调色用 var(--accent)；保持 80-100px 内边距；多卡用 grid grid-template-columns。整体气质：商务、科技、留白克制、对齐严谨（参考 Stripe / Linear / Apple Keynote 风格）。",
      "   **大量使用图表 / 可视化丰富页面**：iframe 已加载 ECharts 5 + 内联 canvas 脚本注入器，AI 应该**多用图表**让幻灯片专业：",
      "     - **ECharts 图表**：写 `<div class=\\\"chart\\\" data-echarts-option='{...JSON...}'></div>`，data-echarts-option 里放完整的 ECharts option JSON（注意是 JSON，不是 JS 对象，所有 key 加双引号，无 trailing comma）。常用：bar / line / pie / radar / gauge / funnel / scatter / treemap / sunburst / gauge。配色不写时自动用 palette 的 [primary, accent, body-color, surface] 系列。容器**必须**有明确宽高（width/height），ECharts 才能渲染。例：左边数据卡 + 右边 ECharts 柱状图比较模块。",
      "     - **Canvas 绘制**（图标 / 箭头 / 自定义图形）：写 `<canvas data-canvas-draw=\\\"...JS 代码...\\\" style=\\\"width:200px;height:100px\\\"></canvas>`。data-canvas-draw 里直接写 ctx 操作（变量名：ctx / canvas / w / h），常用于绘制连接箭头、流程图节点、自定义形状。所有颜色必须取自 CSS 变量：用 `getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()` 拿运行时值。",
      "     - **优先级**：能用 ECharts 数据可视化（柱/线/饼/雷达）就别用纯文字描述；能用 canvas 画箭头/流程节点连线就别用 SVG / 文字符号；图表大于文字。",
      "     - 示例 ECharts data-echarts-option（双引号，JSON 合法）：`{\\\"xAxis\\\":{\\\"type\\\":\\\"category\\\",\\\"data\\\":[\\\"Q1\\\",\\\"Q2\\\",\\\"Q3\\\",\\\"Q4\\\"]},\\\"yAxis\\\":{\\\"type\\\":\\\"value\\\"},\\\"series\\\":[{\\\"type\\\":\\\"bar\\\",\\\"data\\\":[120,200,150,80]}]}`",
      "   **错误示范**（不要这样写）：font-size: 14px / 12px / 16px —— 这只到 PPT 里的 7-8pt，投影时基本看不见。",
      "   **正确示范**：章节标题 font-size: 88px (=44pt PPT H1)、正文 font-size: 40px (=20pt 略大正文)、metric 数字 font-size: 160px (=80pt 巨型)。",
      "4. **切布局时也必须填全新布局的必填字段**：找不到对应原文就用最相近的字段补，宁可拼接，也不要留空导致信息丢失。",
      "5. **不切布局时**：data 只放当前布局可编辑字段里的 key；多行文本用 \\n 换行；数字字段保持字符串类型（如 \"73%\"、\"2580\"）。",
      "6. key 必须**逐字符**来自字段列表（区分大小写）。写错 key 等于这次修改作废。",
      "7. **palette 默认锁死**：用户已经配过全局 PPT 风格的话，**绝对不要**主动改 palette —— 即使用户说「美化」「更专业」也只能在 freeform / 排版 / 字段层面下功夫，配色保持现状。只有用户**显式**说「换主色」「背景改深色」「accentColor 改成蓝色」「换成 xxx 色系」时才动 palette；如果改，就给完整的协调一套（背景/卡片浅、文字/标题深、强调色突出），不要只改一个 key。",
      "8. 真没东西可改时（用户问「这是什么模板」「能改哪些」这种纯问答），才返回 {}，JSON 后**不要**加任何文字。",
      "9. 严格遵守输出格式：第一字符必须是 {，最后字符必须是 }。JSON 内字符串里的换行用 \\n，引号用 \\\"，反斜杠用 \\\\。"
    ].join("\n");

    // user 消息已经在 appendPreviewChatMsg("user", userText) 时进了 previewChatHistory
    const messages = [
      { role: "system", content: systemPrompt },
      ...previewChatHistory
    ];

    const pendingMsg = appendPreviewChatMsg("ai-pending", "AI 正在生成…");
    let raw = "";
    try {
      raw = await callProviderForPreviewChat(messages, (_tok, accumulated) => {
        if (pendingMsg) pendingMsg.textContent = accumulated.slice(-180);
      });
      if (pendingMsg) pendingMsg.remove();
    } catch (e) {
      if (pendingMsg) pendingMsg.remove();
      appendPreviewChatMsg("ai-err", `请求失败：${e?.message || e}`);
      return;
    }

    // 修 B13：AI 请求耗时数秒，期间用户可能关闭预览（htmlPreviewState=null）或切到另一条历史
    // （htmlPreviewState 变成别的 slide）。若不校验就继续，会 null.xxx 抛未处理异常，或把本轮
    // patch 应用到错误的 slide、AI 回复串页。状态已变则丢弃本次结果。
    if (htmlPreviewState !== st) {
      appendPreviewChatMsg("ai-err", "预览已切换或关闭，本次修改已丢弃。");
      return;
    }

    // 解析 JSON 并应用
    let patch;
    try {
      patch = parsePreviewChatJson(raw);
    } catch (e) {
      appendPreviewChatMsg("ai-err", `AI 返回不是合法 JSON：${raw.slice(0, 200)}`);
      return;
    }

    // ---- 1. 布局切换 ----
    // AI 给了 layout 字段：要切换排版。data/fields 按新布局的字段列表来过滤。
    let targetLayout = typeof patch?.layout === "string" ? patch.layout.trim() : "";
    let activeFieldList = fieldList;
    if (targetLayout && targetLayout !== st.layout) {
      // 校验：必须是当前模板存在的 layout（大小写不严格）
      const matched = allLayouts.find((l) => l === targetLayout)
        || allLayouts.find((l) => l.toLowerCase() === targetLayout.toLowerCase())
        || null;
      if (matched) {
        targetLayout = matched;
        activeFieldList = tpl?.layouts?.[matched]?.fields || [];
      } else {
        // 不存在的 layout：忽略切换，保留 data patch
        appendPreviewChatMsg("ai-err", `AI 想切到不存在的布局 "${targetLayout}"，可选：${allLayouts.join(", ")}。\n这次只应用了字段改动。`);
        targetLayout = "";
      }
    } else {
      targetLayout = "";
    }

    // ---- 2. 字段值 patch ----
    // 兼容三种壳：{data: {...}} / {fields: {...}} / 直接 {...} 平铺字段
    let candidate = patch?.data ?? patch?.fields ?? patch;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      candidate = {};
    }
    const lowerMap = {};
    activeFieldList.forEach((k) => { lowerMap[String(k).toLowerCase()] = k; });
    const patchedFields = {};
    const droppedKeys = [];
    const RESERVED = new Set(["data", "fields", "layout", "palette"]);
    Object.keys(candidate).forEach((rawKey) => {
      if (RESERVED.has(rawKey)) return; // 防嵌套壳和顶层字段误入
      const normalized = String(rawKey).trim();
      const mapped = activeFieldList.includes(normalized)
        ? normalized
        : lowerMap[normalized.toLowerCase()] || null;
      if (mapped) {
        patchedFields[mapped] = candidate[rawKey];
      } else {
        droppedKeys.push(rawKey);
      }
    });

    // ---- 3. 配色 patch ----
    const paletteAllowed = new Set(["primaryColor", "accentColor", "backgroundColor", "surfaceColor", "titleColor", "bodyColor", "titleFont", "bodyFont", "secondaryColor"]);
    const palettePatch = {};
    if (patch?.palette && typeof patch.palette === "object" && !Array.isArray(patch.palette)) {
      Object.keys(patch.palette).forEach((k) => {
        if (paletteAllowed.has(k) && patch.palette[k] != null) {
          palettePatch[k] = patch.palette[k];
        }
      });
    }

    const fieldKeys = Object.keys(patchedFields);
    const paletteKeys2 = Object.keys(palettePatch);
    const didLayout = !!targetLayout;
    const didAnything = didLayout || fieldKeys.length > 0 || paletteKeys2.length > 0;

    if (!didAnything) {
      // 给出 AI 原文 + 可用列表，让用户能继续描述
      const preview = String(raw || "").trim().slice(0, 240) || "(空)";
      const lines = ["AI 没做任何修改。"];
      if (droppedKeys.length) lines.push(`收到了不在字段列表里的 key：${droppedKeys.join(", ")}`);
      lines.push(`当前布局可改字段：${fieldList.join(", ")}`);
      lines.push(`可切布局：${allLayouts.join(", ")}`);
      lines.push(`AI 原文：${preview}`);
      appendPreviewChatMsg("ai-err", lines.join("\n"));
      return;
    }

    // 应用 patch：layout > data > palette
    if (didLayout) {
      // 修 #5: 编辑模式下切 layout 之前先确认 —— 用户在 freeform 编辑器里改了一堆元素没保存，
      // chat 让 AI 换 layout 会直接覆盖 DOM 导致改动丢失。先 confirm 一下。
      const fromFreeform = htmlPreviewState.layout === "freeform";
      const targetIsDifferent = targetLayout !== htmlPreviewState.layout;
      if (_editorEnabled && fromFreeform && targetIsDifferent) {
        // 检查当前 iframe 里有没有"在编辑过的痕迹"：transform / 改过 style 的元素，或 stage 内容跟 state.data.html 不一致
        const ifrDoc = els.htmlPreviewFrame?.contentDocument;
        const currentStageHtml = ifrDoc?.querySelector?.(".stage")?.innerHTML || "";
        const stateHtml = htmlPreviewState.data?.html || "";
        const hasUnsavedEdits = currentStageHtml.trim() && currentStageHtml.trim() !== stateHtml.trim();
        if (hasUnsavedEdits) {
          const proceed = window.confirm(
            `当前在编辑模式下，DOM 里有未保存的改动。\n切换排版到「${targetLayout}」会直接覆盖这些改动，无法恢复。\n\n确认要切换吗？\n（建议先点底部「保存」把改动入库，再让 AI 切布局。）`
          );
          if (!proceed) {
            appendPreviewChatMsg("ai-err",
              `已取消切换到 ${targetLayout}，保留当前编辑。\n` +
              `如需切换：先点底部「保存」把当前改动入「我的历史」，再让 AI 切布局。`
            );
            // 跳过 layout 切换，但仍应用 data / palette patch（如果有）
            // 为此 fallback 到 didLayout=false 分支处理
            if (fieldKeys.length) {
              htmlPreviewState.data = Object.assign({}, htmlPreviewState.data, patchedFields);
            }
            if (paletteKeys2.length) {
              htmlPreviewState.palette = Object.assign({}, htmlPreviewState.palette, palettePatch);
            }
            renderHtmlPreviewFields();
            renderHtmlPreviewIntoIframe();
            return;
          }
        }
      }

      // 切布局前先量一下旧布局**可见**字符数 —— 旧布局会渲染哪些字段（fieldList）就量这些字段的总长度。
      // 切完再量新布局可见字符数。如果缩水超过 30% 就警告用户：内容很可能丢失了。
      const measureVisibleChars = (data, fields) => {
        let n = 0;
        (fields || []).forEach((f) => {
          const v = data?.[f];
          if (v != null) n += String(v).length;
        });
        return n;
      };
      const oldVisibleChars = measureVisibleChars(htmlPreviewState.data, fieldList);

      // 切布局：保留旧 data 所有字段（即使新布局不渲染也不丢，切回去还在），AI 给的新值覆盖
      htmlPreviewState.layout = targetLayout;
      htmlPreviewState.data = Object.assign({}, htmlPreviewState.data, patchedFields);
      if (els.htmlPreviewLayout) els.htmlPreviewLayout.textContent = targetLayout;

      // freeform 是用 html 字符串渲染，按 html 长度近似量；其他 layout 按字段长度量
      const newFieldsForMeasure = targetLayout === "freeform"
        ? ["html"]
        : activeFieldList;
      const newVisibleChars = measureVisibleChars(htmlPreviewState.data, newFieldsForMeasure);

      // 内容完整性校验
      if (oldVisibleChars > 0) {
        const ratio = newVisibleChars / oldVisibleChars;
        if (ratio < 0.7 && targetLayout !== "freeform") {
          // 缩水 30%+：很可能丢内容了，强烈建议切 freeform
          appendPreviewChatMsg("ai-err",
            `⚠ 切到 ${targetLayout} 后内容明显缩水（${oldVisibleChars} 字 → ${newVisibleChars} 字，剩 ${Math.round(ratio * 100)}%）。\n` +
            `${targetLayout} 布局容量不够装下原文。建议改用 freeform 让 AI 写自由排版，可以容纳更多内容。\n` +
            `下一句对 AI 说：「换 freeform，把原内容全部保留地重新排版」`
          );
        } else if (ratio < 0.9) {
          // 缩水 10-30%：轻微提示
          appendPreviewChatMsg("ai-err",
            `⚠ 切排版后内容字数变化：${oldVisibleChars} → ${newVisibleChars}（${Math.round(ratio * 100)}%）。如发现内容丢失，可让 AI「把原内容补回，或者换 freeform 重做排版」。`
          );
        }
      }
    } else if (fieldKeys.length) {
      htmlPreviewState.data = Object.assign({}, htmlPreviewState.data, patchedFields);
    }
    if (paletteKeys2.length) {
      htmlPreviewState.palette = Object.assign({}, htmlPreviewState.palette, palettePatch);
    }
    renderHtmlPreviewFields();
    renderHtmlPreviewIntoIframe();
    // AI 切了 layout（freeform ↔ 其他）后，「保存为组件」按钮的可见性要跟着变
    if (didLayout) updateHtmlPreviewActionButtons();

    // 反馈
    const summary = [];
    if (didLayout) summary.push(`切换排版 → ${targetLayout}`);
    if (fieldKeys.length) summary.push(`更新字段：${fieldKeys.join("、")}`);
    if (paletteKeys2.length) summary.push(`调整配色：${paletteKeys2.join("、")}`);
    const tail = droppedKeys.length ? `\n（忽略了不识别的 key：${droppedKeys.join(", ")}）` : "";
    const aiContent = JSON.stringify({
      layout: didLayout ? targetLayout : undefined,
      data: patchedFields,
      palette: palettePatch
    });
    appendPreviewChatMsg("ai", `${summary.join("；")}${tail}`, aiContent);
  }

  // 兜底插入路径：state 没有 onConfirm（用户从历史召回打开、或 onConfirm 已被消费过）时，
  // 直接调模块级 renderAndInsertSlide —— 跟工具主路径走完全同一条管线，**不再**通过
  // tool.handler 重新走一遍工具调用，避免参数解析顺序不一致造成视觉差异（修 #4）。
  // intent: "insert" / "replace"（用 slideHint 目标页） / "replace-active"（用当前选中页）
  async function fallbackInsertFromState(st, intent) {
    const renderAndInsert = global.WpsAiRenderAndInsertSlide;
    if (typeof renderAndInsert !== "function") {
      pwarn("fallbackInsert", "WpsAiRenderAndInsertSlide NOT registered");
      throw new Error("renderAndInsertSlide 共享函数未加载（presentation.js 未初始化？）");
    }
    const params = {
      templateName: st.templateName,
      layout: st.layout,
      data: st.data || {},
      palette: st.palette || {},
      intent: intent || "insert"
    };
    if (intent === "replace" && st.slideHint) {
      params.slide = +st.slideHint;
    } else if (intent === "replace-active") {
      if (typeof st.activeSlideIndex === "number" && st.activeSlideIndex > 0) {
        params.slide = st.activeSlideIndex;
        params.intent = "replace";
      }
    }
    // 替换 / 替换当前选中：doConfirm 顶部已经 cache.update(st.id) 了，这里再 saveToCache=true 会写重复
    // 一条历史。仅"插入到末尾"且没绑定到现有 cache 时才让 renderAndInsertSlide 内部 save 新条目。
    const isReplaceLike = params.intent === "replace" || params.intent === "replace-active";
    if (isReplaceLike || st.id) {
      params.saveToCache = false;
    }
    plog("fallbackInsert", "calling renderAndInsert", {
      origIntent: intent,
      finalIntent: params.intent,
      slide: params.slide,
      activeSlideIndex: st.activeSlideIndex,
      slideHint: st.slideHint
    });
    let result;
    try {
      result = await renderAndInsert(params);
      plog("fallbackInsert", "renderAndInsert returned", {
        slide: result?.slide,
        layerCount: result?.layerCount,
        picturePath: result?.picturePath
      });
    } catch (e) {
      pwarn("fallbackInsert", "renderAndInsert THREW", e?.message || String(e), e?.stack);
      throw e;
    }
    return result;
  }

  async function doConfirm(intent) {
    const st = htmlPreviewState;
    plog("doConfirm", "called", {
      intent,
      hasState: !!st,
      stateId: st?.id,
      slideHint: st?.slideHint,
      activeSlideIndex: st?.activeSlideIndex,
      hasOnConfirm: !!st?.onConfirm,
      templateName: st?.templateName,
      layout: st?.layout
    });
    if (!st) {
      closeHtmlPreviewModal();
      return;
    }
    // 关键修：插入 / 替换前**强制把编辑模式 DOM 序列化回 st.data.html**。
    // 之前只在「保存」按钮里加了这道兜底，但用户大部分时间是直接点「插入到末尾」/「替换当前选中」，
    // 那两条路径走 doConfirm 但完全没调 persist → 用户改动全丢，看到的 PPT 还是 AI 原始生成的版本。
    // persistEditorChangesToState 内部已经判断 st.layout==="freeform" 才操作，非 freeform 直接 return，无副作用。
    try { persistEditorChangesToState(); } catch (e) {}
    setHtmlPreviewBusy(true);
    try {
      // 写缓存
      try {
        if (st.id) {
          global.WpsAiHtmlCache?.update?.(st.id, {
            layout: st.layout,        // "美化当前"切换 layout 后要持久化到 cache，否则历史里召回还是旧 layout
            data: st.data,
            palette: st.palette,
            slideHint: st.slideHint
          });
        } else {
          const saved = global.WpsAiHtmlCache?.save?.({
            templateName: st.templateName,
            layout: st.layout,
            data: st.data,
            palette: st.palette,
            slideHint: st.slideHint,
            docKey: _cachedDocKey || st.docKey || ""
          });
          if (saved) st.id = saved.id;
        }
      } catch (e) { /* 缓存失败不阻塞 */ }

      if (st.onConfirm) {
        // 工具流：onConfirm 走原插入路径；replace / replace-active 由 onConfirm 内部按 intent 处理
        // 把 activeSlideIndex 一并传过去，让 presentation.js 的 onConfirm 能用稳定的页号
        // 关键修：把 templateName + layout 也传过去 —— 用户在「美化当前」里让 AI 切了 layout
        // （cover → freeform 之类）后，原 onConfirm 闭包里的 templateName/layout 是旧值，
        // 插入时还是按旧 layout 渲染，等于把美化结果全丢了。
        const onConfirm = st.onConfirm;
        st.onConfirm = null;
        await onConfirm({
          templateName: st.templateName,
          layout: st.layout,
          data: st.data,
          palette: st.palette,
          intent,
          activeSlideIndex: typeof st.activeSlideIndex === "number" ? st.activeSlideIndex : null
        });
      } else if (isPreviewDialog) {
        // 在独立 dialog 窗口里的 standalone 流：
        // 这个 WPS 版本下 ShowDialog 是**非阻塞**的（modal=true 不生效），
        // MAIN 的 post-dialog 代码在用户点确认之前就已经跑完了，没法接住 result。
        // 改成：① 走 dialogOnConfirm 写一份"待执行"任务到独立的 PENDING key（不是 RESULT），
        //       ② MAIN 端用 storage 事件监听这个 key，触发时调 renderAndInsertSlide。
        // 这样不依赖 ShowDialog 真的阻塞。
        plog("doConfirm", "isPreviewDialog standalone → 写 PENDING_INSERT 给 MAIN 处理");
        const pendingBlob = {
          ts: Date.now(),
          templateName: st.templateName,
          layout: st.layout,
          data: st.data,
          palette: st.palette,
          intent,
          slideHint: typeof st.slideHint === "number" ? st.slideHint : null,
          activeSlideIndex: typeof st.activeSlideIndex === "number" ? st.activeSlideIndex : null
        };
        try { localStorage.setItem(PREVIEW_DIALOG_PENDING_INSERT_KEY, JSON.stringify(pendingBlob)); } catch (e) {}
        // 用 toast 告诉用户已下发（MAIN 真正完成后会 showMessage success/error）
        showMessage("插入任务已派给主面板执行…", "info");
        // 关键修复：之前忘了在 early return 前关「渲染中」徽章，导致用户看到永久"渲染中..."。
        // MAIN 已经接管渲染，dialog 这边的 busy 应该立刻收掉。
        setHtmlPreviewBusy(false);
        return;
      } else {
        // standalone 流，在主 TaskPane 里（inline modal 模式）：直接调工具
        await fallbackInsertFromState(st, intent);
      }
      // 保留预览窗口不关，方便用户继续调字段 / 改排版 / 多次插入。
      // st.onConfirm 已经被消费成 null，下一次按钮点击会走 fallbackInsertFromState（standalone 路径），
      // 效果等同，照样能插入。
      setHtmlPreviewBusy(false);
      // 工具流插完一次后没法再"替换原幻灯片"了（slideHint 已经用过），按钮可见性按 standalone 模式刷新
      updateHtmlPreviewActionButtons();
      // 刷新画廊高亮（cache.id 可能在 doConfirm 头部刚被 save 出来）
      renderHtmlTemplateGallery();
      updateHtmlPreviewHistoryBadge();
      // 显示实际生效的页号——方便用户验证替换是否落到了正确的 slide
      const actualSlide = (intent === "replace-active" && typeof st.activeSlideIndex === "number")
        ? st.activeSlideIndex
        : (intent === "replace" ? st.slideHint : null);
      const successMsg = intent === "replace"
        ? `已替换第 ${actualSlide} 页（预览仍打开，可继续编辑）。`
        : intent === "replace-active"
          ? `已替换当前选中（第 ${actualSlide || "?"} 页，预览仍打开，可继续编辑）。`
          : "已插入到末尾（预览仍打开，可继续编辑）。";
      showMessage(successMsg, "success");
    } catch (e) {
      console.error("[html-preview] 插入失败:", e);
      const verb = intent === "replace" || intent === "replace-active" ? "替换" : "插入";
      showMessage(`${verb}失败：${e?.message || e}`, "error");
      setHtmlPreviewBusy(false);
    }
  }

  function confirmHtmlPreviewInsert() { return doConfirm("insert"); }
  function confirmHtmlPreviewReplace() { return doConfirm("replace"); }
  // 替换 WPS 演示里**当前选中**的那一页（不用 slideHint，用 ActiveWindow.View.Slide）
  function confirmHtmlPreviewReplaceActive() { return doConfirm("replace-active"); }

  // 保存按钮：把当前预览的 state 写回 localStorage 缓存
  //   - state.id 已存在（来自左侧历史 / 之前保存过） → 调 cache.update 覆盖那条
  //   - state.id 为空（AI 工具新生成的，尚未入缓存） → 调 cache.save 新建并把 id 绑回 state
  function saveHtmlPreviewToCache() {
    const st = htmlPreviewState;
    if (!st || !st.templateName || !st.layout) {
      showMessage("当前没有可保存的预览。", "error");
      return;
    }
    const cache = global.WpsAiHtmlCache;
    if (!cache) {
      showMessage("缓存模块未加载，无法保存。", "error");
      return;
    }
    // 关键修：保存前强制把当前 iframe 的 DOM 序列化回 st.data.html。
    // 之前依赖 drag/resize/delete/apply 4 个调用点各自触发 persist，但有些路径漏触发
    // （键盘 nudge、撤销重做、快速 mouseup 没抓到等），保存时 st.data 还是旧的 → 用户感觉"保存没生效"。
    // 这里兜底，无论编辑模式开没开都过一遍：persistEditorChangesToState 内部已经判断了
    // st.layout==="freeform" 才操作，非 freeform 直接 return，无副作用。
    try { persistEditorChangesToState(); } catch (e) {}
    plog("save", "after persist; st.layout=" + st.layout
      + " st.id=" + (st.id || "(none)")
      + " htmlLen=" + String(st.data?.html || "").length
      + " htmlHead=" + String(st.data?.html || "").slice(0, 80).replace(/\n/g, "\\n")
      + " _cachedDocKey=" + (_cachedDocKey || "(empty)"));
    const payload = {
      templateName: st.templateName,
      layout: st.layout,
      data: Object.assign({}, st.data || {}),
      palette: Object.assign({}, st.palette || {}),
      slideHint: st.slideHint || null,
      // 新建保存兜底带上 docKey，避免画廊按当前 PPT 过滤后看不到这条新条目
      // （cache.update 路径不依赖这个字段，会保留原 entry 的 docKey）
      docKey: _cachedDocKey || "",
      // 用户主动点保存 → 一定不是 draft 了
      draft: false
    };
    try {
      const oldKey = previewStateKey(st);
      let action;
      if (st.id) {
        const updated = cache.update(st.id, payload);
        if (updated) {
          action = "覆盖保存";
          plog("save", "cache.update OK id=" + st.id
            + " writtenHtmlLen=" + String(updated.data?.html || "").length
            + " ts=" + updated.ts
            + " docKey=" + (updated.docKey || "(empty)"));
        } else {
          // 老的 id 已被清空 / 找不到，回退成 save 新建
          const saved = cache.save(payload);
          st.id = saved.id;
          action = "新建保存";
          plog("save", "cache.update returned null → fallback save; new id=" + saved.id);
        }
      } else {
        const saved = cache.save(payload);
        st.id = saved.id;
        action = "新建保存";
        plog("save", "cache.save (new) id=" + saved.id
          + " docKey=" + (saved.docKey || "(empty)"));
      }
      // 读回去验证写入有没有真正落地（排查"localStorage 写后又被旁路覆盖"的可能）
      try {
        const verify = cache.get?.(st.id);
        plog("save", "verify cache.get; htmlLen=" + String(verify?.data?.html || "").length
          + " ts=" + verify?.ts
          + " docKey=" + (verify?.docKey || "(empty)")
          + " match=" + (verify?.data?.html === st.data?.html ? "Y" : "N"));
      } catch (e) {}
      // chat 会话的 binding key 跟 state.id 挂钩；新建保存让 id 从空变有值时 key 会变，
      // 要把旧 key 下的 chat 日志**搬到**新 key，下次切回这条历史还能看到原对话。
      const newKey = previewStateKey(st);
      if (newKey !== oldKey && previewChatLogByKey.has(oldKey)) {
        previewChatLogByKey.set(newKey, previewChatLogByKey.get(oldKey));
        previewChatLogByKey.delete(oldKey);
        savePreviewChatLogsToStorage();
      }
      _previewChatBoundKey = newKey;
      // 关键：清掉这条历史在 gallery 里的缓存卡片，让 renderHtmlTemplateGallery
      // 强制重建（不走 sig diff 复用）—— 之前用户报"保存了但历史里那张缩略图没更新"，
      // 多数情况是 sig 算出来一样（ts 同帧没变 / iframe srcdoc 浏览器缓存）卡没重建。
      // 显式清缓存后会用最新 entry.data 重新渲染 iframe srcdoc，缩略图同步。
      try {
        if (_galleryCardCache && st.id) {
          const cardKey = `hist::${st.id}`;
          const cached = _galleryCardCache.get(cardKey);
          if (cached?.el?.parentNode) cached.el.parentNode.removeChild(cached.el);
          _galleryCardCache.delete(cardKey);
        }
      } catch (e) {}
      // 刷新左侧画廊（新条目要立刻显示 + 高亮）和顶部历史角标
      renderHtmlTemplateGallery();
      updateHtmlPreviewHistoryBadge();
      // 视觉反馈：让刚保存的那张卡短暂高亮（蓝边 + 微缩放），让用户一眼看到"那张更新了"
      try {
        const host = els.htmlTemplateGalleryList;
        const card = host?.querySelector(`[data-gallery-key="hist::${st.id}"]`);
        if (card) {
          card.classList.add("just-saved");
          card.scrollIntoView({ block: "nearest", behavior: "smooth" });
          setTimeout(() => { try { card.classList.remove("just-saved"); } catch (e) {} }, 1500);
        }
      } catch (e) {}
      showMessage(`已${action}到「我的历史」`, "success");
    } catch (e) {
      console.error("[html-preview] 保存失败:", e);
      showMessage(`保存失败：${e?.message || e}`, "error");
    }
  }

  // ====== 组件库（freeform 幻灯片的"可复用视觉单元"集合）======
  // 每张 slide 维护一份"用户为这张挑了哪几个组件 id"的选择（持久化 localStorage）。
  // 选择会注入下一轮 chat 的 system prompt，AI 看到这些组件的 html/css 后会在新页里复用。
  const PREVIEW_PICKED_COMPONENTS_KEY = "lingxi_html_preview_picked_components_v1";
  const pickedComponentsByKey = new Map(); // key -> array<componentId>

  function loadPickedComponentsFromStorage() {
    try {
      const raw = global.WpsAiStore.getItem(PREVIEW_PICKED_COMPONENTS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach((k) => {
          if (Array.isArray(parsed[k])) pickedComponentsByKey.set(k, parsed[k]);
        });
      }
    } catch (e) { /* ignore */ }
  }
  function savePickedComponentsToStorage() {
    try {
      const obj = {};
      pickedComponentsByKey.forEach((v, k) => { obj[k] = v; });
      global.WpsAiStore.setItem(PREVIEW_PICKED_COMPONENTS_KEY, JSON.stringify(obj));
    } catch (e) { /* localStorage 满了，沉默 */ }
  }
  loadPickedComponentsFromStorage();

  function getPickedComponentIds() {
    const key = _previewChatBoundKey;
    if (!key) return [];
    return pickedComponentsByKey.get(key) || [];
  }
  function setPickedComponentIds(ids) {
    const key = _previewChatBoundKey;
    if (!key) return;
    if (!ids || !ids.length) pickedComponentsByKey.delete(key);
    else pickedComponentsByKey.set(key, ids);
    savePickedComponentsToStorage();
    updatePickedComponentsCountBadge();
  }
  function updatePickedComponentsCountBadge() {
    const badge = els.htmlPreviewPickComponentsCount;
    if (!badge) return;
    const n = getPickedComponentIds().length;
    badge.textContent = String(n);
    badge.classList.toggle("empty", n === 0);
  }

  // 「保存为组件」按钮：仅 freeform 布局时可用（其他 layout 是 schema 化的，已天然可复用）
  function openSaveAsComponentDialog() {
    const st = htmlPreviewState;
    const overlay = els.htmlPreviewSaveAsCompModal;
    const tip = els.htmlPreviewSaveAsCompTip;
    const confirmBtn = els.htmlPreviewSaveAsCompConfirmBtn;
    if (!overlay) return;
    if (!st) {
      showMessage("当前没有预览，无法保存为组件。", "error");
      return;
    }
    const isFreeform = st.layout === "freeform";
    if (tip) tip.style.color = isFreeform ? "" : "var(--danger, #e11d48)";
    if (confirmBtn) confirmBtn.disabled = !isFreeform;
    // 预填一个可用名字
    if (els.htmlPreviewSaveAsCompName) {
      els.htmlPreviewSaveAsCompName.value = "";
      els.htmlPreviewSaveAsCompName.placeholder = isFreeform
        ? "如：指标卡网格 / 完成清单 / 团队介绍卡"
        : "（非 freeform，无 html/css 可抽取）";
    }
    if (els.htmlPreviewSaveAsCompDesc) els.htmlPreviewSaveAsCompDesc.value = "";
    overlay.classList.remove("hidden");
    if (isFreeform && els.htmlPreviewSaveAsCompName) {
      setTimeout(() => els.htmlPreviewSaveAsCompName.focus(), 0);
    }
  }
  function closeSaveAsComponentDialog() {
    els.htmlPreviewSaveAsCompModal?.classList.add("hidden");
  }
  function confirmSaveAsComponent() {
    const st = htmlPreviewState;
    if (!st || st.layout !== "freeform") {
      showMessage("只有 freeform 布局可以保存为组件。", "error");
      return;
    }
    const name = (els.htmlPreviewSaveAsCompName?.value || "").trim();
    const desc = (els.htmlPreviewSaveAsCompDesc?.value || "").trim();
    if (!name) {
      showMessage("请填写组件名称。", "error");
      els.htmlPreviewSaveAsCompName?.focus();
      return;
    }
    // 编辑器调用时优先用 _editorPendingSaveHtml（选中元素的 outerHTML），否则用整页
    const html = String(_editorPendingSaveHtml != null ? _editorPendingSaveHtml : (st.data?.html || ""));
    const css = String(_editorPendingSaveCss != null ? _editorPendingSaveCss : (st.data?.css || ""));
    _editorPendingSaveHtml = null;
    _editorPendingSaveCss = null;
    if (!html) {
      showMessage("freeform 的 html 字段是空的，无法保存。", "error");
      return;
    }
    // 修 #19: 整页组件入库时检查大小。≥5KB 弹 confirm，让用户主动选择「拆小」还是「继续保存」。
    // 原因：组件被选用时整段 html+css 会注入 system prompt，5KB 是经验阈值（10 个组件 = 50KB，
    // 已经显著挤压上下文）。AI 抽取的"整页存为组件"最容易撞这个雷。
    const totalBytes = html.length + css.length;
    const COMPONENT_WARN = 5000;
    if (totalBytes > COMPONENT_WARN) {
      const kb = (totalBytes / 1024).toFixed(1);
      const ok = confirm(
        `这个组件 html+css 约 ${kb} KB，超过推荐阈值 ${(COMPONENT_WARN / 1024).toFixed(1)} KB。\n\n`
        + `组件被「选用」时会整段注入 AI 上下文，太大会挤压可用 token。\n\n`
        + `建议：先在编辑器里只选中关键区块（用快捷键 1-3 个元素）再保存，而不是整页存。\n\n`
        + `仍要继续保存吗？`
      );
      if (!ok) return;
    }
    try {
      const saved = global.WpsAiHtmlComponents.save({
        name, description: desc, html, css, sourceSlideId: st.id || null,
        docKey: _cachedDocKey || ""
      });
      closeSaveAsComponentDialog();
      showMessage(`组件「${saved.name}」已存入组件库`, "success");
      // 模板/我的历史/组件 三个 tab 共享一个 list 容器；当前在「组件」tab 就重渲
      if (_galleryActiveTab === "components") renderHtmlTemplateGallery();
    } catch (e) {
      console.error("[html-components] save 失败:", e);
      showMessage(`保存失败：${e?.message || e}`, "error");
    }
  }

  // ============================================================
  // 图层编辑模式：在 iframe 里点击元素 → 虚线选中 + 角图标（×删除 / 📦存为组件 / ✏编辑）
  //              鼠标拖元素 = 移动；拖右下角 = 调大小；
  //              ✏ 打开弹窗改文字 / 颜色 / 字号 / 字重。
  // 所有改动同步回 htmlPreviewState.data.html，下次保存/插入就是改后的版本。
  // ============================================================
  let _editorEnabled = false;
  let _editorSelectedEl = null;            // iframe 里当前选中的 DOM 元素（单选）
  let _editorSelOverlay = null;            // 选中态 overlay（虚线框 + 3 角图标 + resize 把手）
  let _editorHoverOverlay = null;          // hover 态 overlay（蓝色半透明蒙版，像浏览器 devtools）
  let _editorDragState = null;             // { mode: "move"|"resize"|"group-move", startX, startY, ... }
  let _editorJustDragged = false;          // 拖完到 click 之间的 1 帧，吃掉那次 click 防止误清选
  // 多选 / 圈选
  let _editorMultiSel = [];                // 多选元素数组（圈选后形成）
  let _editorMultiOverlay = null;          // 多选 union overlay（虚线 + 删除 + 存组件 + 拖动）
  let _editorMarqueeStart = null;          // 圈选起点 {x, y}
  let _editorMarqueeBox = null;            // 圈选过程中的虚线 div
  // 对齐参考线 + 吸附（参考 PS / Figma 的 smart guide）
  let _editorGuideLayer = null;            // iframe 内承载参考线 + 坐标 hint 的 div
  let _editorPosHint = null;               // 拖动时光标边的小坐标徽章
  const SNAP_PX = 6;                       // 吸附阈值（iframe 内 1920×1080 像素）
  const GUIDE_COLOR_STAGE = "#FF3B5C";     // 画布边/中线参考线 = 红
  const GUIDE_COLOR_EL = "#22D3EE";        // 元素对齐参考线 = 青

  const EDITOR_SEL_OVERLAY_ID   = "__lingxi_editor_sel_overlay__";
  const EDITOR_HOVER_OVERLAY_ID = "__lingxi_editor_hover_overlay__";
  const EDITOR_GUIDE_LAYER_ID   = "__lingxi_editor_guides__";
  const EDITOR_POS_HINT_ID      = "__lingxi_editor_poshint__";

  // 判断一个 DOM 节点是不是我们注入的编辑器装饰元素
  function isEditorChromeEl(el) {
    if (!el || !el.closest) return false;
    return !!(
      el.closest(`#${EDITOR_SEL_OVERLAY_ID}`) ||
      el.closest(`#${EDITOR_HOVER_OVERLAY_ID}`) ||
      el.closest(`#${EDITOR_GUIDE_LAYER_ID}`) ||
      el.closest(`#${EDITOR_POS_HINT_ID}`) ||
      el.closest("#__lingxi_editor_multi_overlay__") ||
      el.closest("#__lingxi_editor_marquee__")
    );
  }

  // 用 elementFromPoint 找鼠标真正下方的元素，绕过 overlay 干扰；
  // 编辑模式 CSS 已经强制所有用户内容 pointer-events:auto（哪怕装饰层原本是 none）。
  // 命中 SVG 内部 shape（rect/circle/path 等）时，**上提到 svg 根**，让用户选中整个图形组件而不是单个原子。
  function realElementAt(doc, clientX, clientY) {
    if (!doc?.elementFromPoint) return null;
    const sel = _editorSelOverlay, hov = _editorHoverOverlay;
    const selDisp = sel?.style.display, hovDisp = hov?.style.display;
    if (sel) sel.style.display = "none";
    if (hov) hov.style.display = "none";
    let el = doc.elementFromPoint(clientX, clientY);
    if (sel) sel.style.display = selDisp || "";
    if (hov) hov.style.display = hovDisp || "";
    if (!el || el === doc.documentElement || el === doc.body) return null;
    if (isEditorChromeEl(el)) return null;
    // SVG inner shape（rect/circle/path 等）→ 选整个 SVG 根，PPT 编辑场景更合理
    if (el.tagName && el.tagName.toLowerCase() !== "svg" && el.ownerSVGElement) {
      el = el.ownerSVGElement;
    }
    return el;
  }

  function enableIframeEditor() {
    const ifr = els.htmlPreviewFrame;
    const doc = ifr?.contentDocument;
    plog("editor", "enableIframeEditor: hasIfr=" + !!ifr + " hasDoc=" + !!doc + " hasBody=" + !!doc?.body);
    if (!doc || !doc.body) return;
    // 注入编辑器 CSS（idempotent）—— 把手做大到 96px / 64px font，1920×1080 缩到 0.3 时仍清晰
    if (!doc.getElementById("__lingxi_editor_css")) {
      const style = doc.createElement("style");
      style.id = "__lingxi_editor_css";
      style.textContent = `
        body.__lingxi_editing, body.__lingxi_editing * { cursor: crosshair !important; }
        /* 编辑模式下强制所有用户内容（含装饰层、SVG、被 pointer-events:none 标过的元素）都能被命中。
           我们自己注入的所有"chrome"装饰层都要排除掉，否则它们会用 !important 抢走 pointer-events
           → 用户点击落到装饰层上 → 进 isEditorChromeEl 拦截 → 一直 "chrome el, ignore"。
           特别是 guide layer 占满 1920×1080，第一次拖动后只清 innerHTML 不移除节点，
           会永久挡住所有 mousedown。 */
        body.__lingxi_editing :not(#${EDITOR_SEL_OVERLAY_ID}):not(#${EDITOR_HOVER_OVERLAY_ID}):not(#${EDITOR_GUIDE_LAYER_ID}):not(#${EDITOR_POS_HINT_ID}):not(#__lingxi_editor_marquee__):not(#__lingxi_editor_multi_overlay__) {
          pointer-events: auto !important;
        }
        /* 反向兜底：装饰层本体显式 none（被上面 :not 排除后会用各自 inline / 这条规则的 none） */
        body.__lingxi_editing #${EDITOR_GUIDE_LAYER_ID},
        body.__lingxi_editing #${EDITOR_POS_HINT_ID},
        body.__lingxi_editing #__lingxi_editor_marquee__ {
          pointer-events: none !important;
        }
        /* resize 把手 / 操作按钮的 cursor 用 !important 抢回（顶上面那条 crosshair）。
           八向 resize 显示对应方向箭头；3 个图标按钮显示 pointer；选中框本体（hover/sel overlay 边线）显示 move */
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-handle { cursor: pointer !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-nw,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-se { cursor: nwse-resize !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-ne,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-sw { cursor: nesw-resize !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-n,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-s { cursor: ns-resize !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-e,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-w { cursor: ew-resize !important; }
        /* 被选中元素本身 hover 时改 move 光标（暗示可拖动）—— 用类名标记，selectEditorElement 时挂 */
        body.__lingxi_editing .__lingxi_selected_move { cursor: move !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID},
        body.__lingxi_editing #${EDITOR_HOVER_OVERLAY_ID} { pointer-events: none !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-handle,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize { pointer-events: auto !important; }
        #${EDITOR_HOVER_OVERLAY_ID} {
          position: absolute;
          pointer-events: none;
          z-index: 999998;
          background: rgba(26, 109, 255, 0.15);
          outline: 2px solid #1A6DFF;
          outline-offset: -2px;
          box-sizing: border-box;
          transition: top 0.05s linear, left 0.05s linear, width 0.05s linear, height 0.05s linear;
        }
        #${EDITOR_SEL_OVERLAY_ID} {
          position: absolute;
          pointer-events: none;
          z-index: 999999;
          border: 4px dashed #1A6DFF;
          background: rgba(26, 109, 255, 0.06);
          box-sizing: border-box;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle {
          position: absolute;
          pointer-events: auto;
          background: #1A6DFF;
          color: #fff;
          font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          line-height: 1;
          width: 60px; height: 60px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 8px;
          border: 0;
          cursor: pointer;
          box-shadow: 0 3px 10px rgba(0,0,0,0.3);
          user-select: none;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle:hover { background: #155ad8; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle.danger { background: #e11d48; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle.danger:hover { background: #b91347; }
        /* 线性 SVG 图标：feather 风格，stroke 跟按钮背景的反白色（白） */
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle svg {
          width: 30px; height: 30px;
          stroke: #fff;
          stroke-width: 2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          pointer-events: none; /* SVG 不抢父按钮的 click */
        }
        /* 默认：3 个把手在元素上方外侧，save/edit 贴左侧，del 贴右侧。
           适合较宽元素（≥ 220px）；窄元素会让 edit 和 del 互相挤压重叠（bug 已修，见 narrow 模式）。 */
        #${EDITOR_SEL_OVERLAY_ID} .ed-save   { top: -70px; left: -6px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-edit   { top: -70px; left: 60px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-del    { top: -70px; right: -6px; }
        /* 窄元素模式：3 个把手都左对齐，固定间距，跟元素宽度解耦 ——
           del 不再用 right:-6px 跟元素右边走，避免跟 edit 在窄宽下重叠。
           工具栏总宽 ~196px（60×3 + 8×2 间距），向元素右侧外伸属正常表现。 */
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-narrow .ed-save  { top: -70px; left: -6px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-narrow .ed-edit  { top: -70px; left: 60px; right: auto; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-narrow .ed-del   { top: -70px; left: 130px; right: auto; }
        /* 上面空间不够 → 把把手贴到元素内部顶部，避免被画布上边裁掉 */
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-save   { top: 6px; left: 6px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-edit   { top: 6px; left: 72px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-del    { top: 6px; right: 6px; }
        /* 内嵌 + 窄：把手仍按窄模式左对齐，但 top 改成内嵌的 6px */
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside.ed-handles-narrow .ed-save  { top: 6px; left: 6px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside.ed-handles-narrow .ed-edit  { top: 6px; left: 72px; right: auto; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside.ed-handles-narrow .ed-del   { top: 6px; left: 142px; right: auto; }
        /* 修 #14: 八向 resize 把手。每个方向独立 cursor + 锚点位置。
           角把手 = 圆形（明显 affordance），边把手 = 矩形（边的视觉提示） */
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize {
          position: absolute;
          background: #fff;
          border: 3px solid #1A6DFF;
          pointer-events: auto;
          box-shadow: 0 2px 6px rgba(0,0,0,0.22);
          box-sizing: border-box;
        }
        /* 四个角 */
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-nw,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-ne,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-se,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-sw {
          width: 26px; height: 26px; border-radius: 50%;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-nw { left: -13px; top: -13px; cursor: nwse-resize; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-ne { right: -13px; top: -13px; cursor: nesw-resize; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-se { right: -13px; bottom: -13px; cursor: nwse-resize; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-sw { left: -13px; bottom: -13px; cursor: nesw-resize; }
        /* 四条边的中点 */
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-n,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-s {
          left: 50%; width: 26px; height: 14px; margin-left: -13px;
          border-radius: 4px; cursor: ns-resize;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-e,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-w {
          top: 50%; width: 14px; height: 26px; margin-top: -13px;
          border-radius: 4px; cursor: ew-resize;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-n { top: -7px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-s { bottom: -7px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-w { left: -7px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-e { right: -7px; }
      `;
      doc.head.appendChild(style);
    }
    doc.body.classList.add("__lingxi_editing");
    // 创建两层 overlay
    _editorHoverOverlay = doc.getElementById(EDITOR_HOVER_OVERLAY_ID);
    if (!_editorHoverOverlay) {
      _editorHoverOverlay = doc.createElement("div");
      _editorHoverOverlay.id = EDITOR_HOVER_OVERLAY_ID;
      _editorHoverOverlay.style.display = "none";
      doc.body.appendChild(_editorHoverOverlay);
    }
    // 用 document 而不是 body，确保鼠标 / 点击事件不会被某些子元素的 stopPropagation 吃掉
    doc.addEventListener("mousemove", editorOnDocMouseMove, true);
    doc.addEventListener("mouseleave", editorOnDocMouseLeave, true);
    doc.addEventListener("mousedown", editorOnDocMouseDown, true);
    doc.addEventListener("click", editorOnDocClick, true);
    doc.addEventListener("keydown", editorOnKeyDown, true);
    _editorEnabled = true;
    updateEditModeBtnLabel();
    // 进入编辑模式：把"初始状态"压栈，给第一次操作前留个还原点
    clearEditorUndoStacks();
    pushEditorUndoSnapshot();
    // 撤销/重做按钮可见性跟随编辑模式
    try { updateHtmlPreviewActionButtons(); } catch (e) {}
  }

  // Ctrl/Cmd + Z 撤销；Ctrl/Cmd + Y 或 Ctrl+Shift+Z 重做
  function editorOnKeyDown(ev) {
    if (!_editorEnabled) return;
    const isUndo = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (ev.key === "z" || ev.key === "Z");
    const isRedo = ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || ev.key === "Y"))
      || ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === "z" || ev.key === "Z"));
    if (isUndo) { ev.preventDefault(); editorUndo(); }
    else if (isRedo) { ev.preventDefault(); editorRedo(); }
  }

  function disableIframeEditor() {
    const ifr = els.htmlPreviewFrame;
    const doc = ifr?.contentDocument;
    if (doc) {
      doc.body?.classList.remove("__lingxi_editing");
      doc.removeEventListener("mousemove", editorOnDocMouseMove, true);
      doc.removeEventListener("mouseleave", editorOnDocMouseLeave, true);
      doc.removeEventListener("mousedown", editorOnDocMouseDown, true);
      doc.removeEventListener("click", editorOnDocClick, true);
      doc.removeEventListener("keydown", editorOnKeyDown, true);
    }
    clearEditorSelection();
    clearEditorMultiSelection();
    cleanupMarquee();
    _editorDestroyGuides();
    // 退出编辑模式：清撤销栈，按钮收回 disabled 状态 + 隐藏
    clearEditorUndoStacks();
    try { updateHtmlPreviewActionButtons(); } catch (e) {}
    if (_editorHoverOverlay) {
      try { _editorHoverOverlay.remove(); } catch (e) {}
      _editorHoverOverlay = null;
    }
    _editorEnabled = false;
    updateEditModeBtnLabel();
  }

  function updateEditModeBtnLabel() {
    const btn = els.htmlPreviewEditModeBtn;
    if (!btn) return;
    btn.textContent = _editorEnabled ? "退出编辑" : "编辑模式";
    btn.classList.toggle("active", _editorEnabled);
  }

  function clearEditorSelection() {
    if (_editorSelectedEl) {
      try { _editorSelectedEl.classList.remove("__lingxi_selected_move"); } catch (e) {}
    }
    _editorSelectedEl = null;
    if (_editorSelOverlay) {
      try { _editorSelOverlay.remove(); } catch (e) {}
      _editorSelOverlay = null;
    }
  }

  // ---- Hover：跟随鼠标，蒙版盖在元素上 ----
  function editorOnDocMouseMove(ev) {
    if (!_editorEnabled) return;
    if (_editorDragState) return; // 拖动中不更新 hover
    const doc = (ev.currentTarget && ev.currentTarget.ownerDocument) || ev.target?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    const target = realElementAt(doc, ev.clientX, ev.clientY);
    if (!target) {
      if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
      return;
    }
    positionRectTo(_editorHoverOverlay, target);
    _editorHoverOverlay.style.display = "block";
  }
  function editorOnDocMouseLeave() {
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
  }

  // ---- 点击：选中鼠标下方真实元素 ----
  function editorOnDocClick(ev) {
    if (!_editorEnabled) return;
    if (isEditorChromeEl(ev.target)) return;
    if (_editorJustDragged) { _editorJustDragged = false; ev.preventDefault(); ev.stopPropagation(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    const doc = ev.target?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    const target = realElementAt(doc, ev.clientX, ev.clientY);
    if (!target) { plog("editor", "click: empty → clear selection"); clearEditorSelection(); return; }
    plog("editor", "click: select " + target.tagName + (target.className ? "." + String(target.className).split(" ")[0] : ""));
    selectEditorElement(target);
  }

  // ---- mousedown：
  //   resize 把手 → resize
  //   多选 overlay 上 → 整组拖动
  //   按在单选元素上 → 单元素拖动
  //   按在空白（body / html）上 → 开始圈选 marquee
  function editorOnDocMouseDown(ev) {
    if (!_editorEnabled) { plog("editor", "mousedown: editor disabled, ignore"); return; }
    const action = ev.target?.closest?.("[data-action]")?.dataset?.action;
    if (action === "resize") {
      ev.preventDefault(); ev.stopPropagation();
      const dir = ev.target?.closest?.("[data-resize-dir]")?.dataset?.resizeDir || "se";
      plog("editor", "mousedown: resize dir=" + dir);
      startEditorDrag(ev, "resize", dir);
      return;
    }
    if (action === "multi-move") {
      ev.preventDefault(); ev.stopPropagation();
      plog("editor", "mousedown: multi-move");
      startEditorGroupDrag(ev);
      return;
    }
    if (isEditorChromeEl(ev.target)) { plog("editor", "mousedown: chrome el, ignore"); return; }
    const doc = ev.target?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    const target = realElementAt(doc, ev.clientX, ev.clientY);
    // 单选拖动
    if (_editorSelectedEl && target && (target === _editorSelectedEl || _editorSelectedEl.contains(target))) {
      ev.preventDefault(); ev.stopPropagation();
      plog("editor", "mousedown: move (selected) targetTag=" + (target?.tagName || "(none)"));
      startEditorDrag(ev, "move");
      return;
    }
    // 按在空白处（target = null 表示击中 body / html） → 开始圈选
    if (!target) {
      ev.preventDefault(); ev.stopPropagation();
      plog("editor", "mousedown: empty space → marquee");
      startEditorMarquee(ev, doc);
      return;
    }
    plog("editor", "mousedown: no-op (target=" + target.tagName + " selected=" + (_editorSelectedEl?.tagName || "(none)") + ") — click will select");
  }

  // ---- 圈选 marquee ----
  function startEditorMarquee(ev, doc) {
    if (!doc?.body) return;
    // 先清掉单选 / 多选状态
    clearEditorSelection();
    clearEditorMultiSelection();
    _editorMarqueeStart = { x: ev.clientX, y: ev.clientY, sx: doc.documentElement.scrollLeft || 0, sy: doc.documentElement.scrollTop || 0 };
    // 创建虚线 div
    const box = doc.createElement("div");
    box.id = "__lingxi_editor_marquee__";
    box.style.cssText = [
      "position: absolute",
      "pointer-events: none",
      "z-index: 999997",
      "border: 2px dashed #1A6DFF",
      "background: rgba(26, 109, 255, 0.10)",
      "box-sizing: border-box",
      "left: " + (ev.clientX + _editorMarqueeStart.sx) + "px",
      "top: " + (ev.clientY + _editorMarqueeStart.sy) + "px",
      "width: 0; height: 0"
    ].join(";");
    doc.body.appendChild(box);
    _editorMarqueeBox = box;
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
    doc.addEventListener("mousemove", editorMarqueeMove, true);
    doc.addEventListener("mouseup",   editorMarqueeUp,   true);
  }
  function editorMarqueeMove(ev) {
    if (!_editorMarqueeStart || !_editorMarqueeBox) return;
    const s = _editorMarqueeStart;
    const minX = Math.min(s.x, ev.clientX);
    const minY = Math.min(s.y, ev.clientY);
    const w = Math.abs(ev.clientX - s.x);
    const h = Math.abs(ev.clientY - s.y);
    _editorMarqueeBox.style.left = (minX + s.sx) + "px";
    _editorMarqueeBox.style.top  = (minY + s.sy) + "px";
    _editorMarqueeBox.style.width  = w + "px";
    _editorMarqueeBox.style.height = h + "px";
  }
  function editorMarqueeUp(ev) {
    const s = _editorMarqueeStart;
    const box = _editorMarqueeBox;
    const doc = box?.ownerDocument || ev.target?.ownerDocument;
    if (!s || !box || !doc) { cleanupMarquee(); return; }
    doc.removeEventListener("mousemove", editorMarqueeMove, true);
    doc.removeEventListener("mouseup",   editorMarqueeUp,   true);
    const minX = Math.min(s.x, ev.clientX);
    const minY = Math.min(s.y, ev.clientY);
    const maxX = Math.max(s.x, ev.clientX);
    const maxY = Math.max(s.y, ev.clientY);
    // 移除虚线 div 前先记录矩形
    cleanupMarquee();
    // 鼠标几乎没动 → 当成"点击空白"，啥也不选
    if ((maxX - minX) < 4 && (maxY - minY) < 4) return;
    // 找出 stage 下与圈选矩形**相交**的直接子级元素（不下钻到孙子，避免过度细分）
    const stage = doc.querySelector(".stage") || doc.body;
    const hits = [];
    const rectIntersect = (r) => !(r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY);
    Array.from(stage.children).forEach((child) => {
      if (isEditorChromeEl(child)) return;
      try {
        const r = child.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && rectIntersect(r)) hits.push(child);
      } catch (e) {}
    });
    if (!hits.length) return;
    if (hits.length === 1) {
      // 只圈到 1 个 → 用单选逻辑，体验更好
      selectEditorElement(hits[0]);
      return;
    }
    _editorMultiSel = hits;
    renderMultiSelOverlay();
  }
  function cleanupMarquee() {
    _editorMarqueeStart = null;
    if (_editorMarqueeBox) {
      try { _editorMarqueeBox.remove(); } catch (e) {}
      _editorMarqueeBox = null;
    }
  }
  function clearEditorMultiSelection() {
    _editorMultiSel = [];
    if (_editorMultiOverlay) {
      try { _editorMultiOverlay.remove(); } catch (e) {}
      _editorMultiOverlay = null;
    }
  }

  // 多选 overlay：覆盖在 union bbox 上，有删除 / 存组件 / 拖动 3 个动作
  function renderMultiSelOverlay() {
    if (!_editorMultiSel.length) return;
    const doc = _editorMultiSel[0].ownerDocument;
    if (_editorMultiOverlay) { try { _editorMultiOverlay.remove(); } catch (e) {} }
    // 计算 union rect
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    _editorMultiSel.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left   < minX) minX = r.left;
      if (r.top    < minY) minY = r.top;
      if (r.right  > maxX) maxX = r.right;
      if (r.bottom > maxY) maxY = r.bottom;
    });
    const sx = doc.documentElement.scrollLeft || 0;
    const sy = doc.documentElement.scrollTop  || 0;
    const overlay = doc.createElement("div");
    overlay.id = "__lingxi_editor_multi_overlay__";
    overlay.style.cssText = [
      "position: absolute",
      "z-index: 999999",
      "border: 4px dashed #1A6DFF",
      "background: rgba(26, 109, 255, 0.08)",
      "box-sizing: border-box",
      "left: " + (minX + sx) + "px",
      "top: " + (minY + sy) + "px",
      "width: " + (maxX - minX) + "px",
      "height: " + (maxY - minY) + "px",
      "pointer-events: auto",
      "cursor: move"
    ].join(";");
    overlay.dataset.action = "multi-move";
    overlay.innerHTML =
      '<div style="position:absolute;top:-78px;left:0;display:flex;gap:10px;pointer-events:none">' +
        '<button data-action="multi-save" style="pointer-events:auto;background:#1A6DFF;color:#fff;border:0;border-radius:8px;width:60px;height:60px;font-size:32px;cursor:pointer;font-weight:700;box-shadow:0 3px 10px rgba(0,0,0,0.3)" title="把选中的多个元素整体存为一个组件">📦</button>' +
        '<button data-action="multi-del" style="pointer-events:auto;background:#e11d48;color:#fff;border:0;border-radius:8px;width:60px;height:60px;font-size:44px;cursor:pointer;font-weight:700;box-shadow:0 3px 10px rgba(0,0,0,0.3)" title="删除选中的全部元素">×</button>' +
        '<span style="pointer-events:none;color:#1A6DFF;font-size:24px;font-weight:700;line-height:60px;background:#fff;padding:0 14px;border-radius:8px;box-shadow:0 3px 10px rgba(0,0,0,0.2)">已选 ' + _editorMultiSel.length + ' 个</span>' +
      '</div>';
    doc.body.appendChild(overlay);
    _editorMultiOverlay = overlay;
    overlay.addEventListener("click", (e) => {
      const a = e.target?.dataset?.action;
      if (!a) return;
      e.stopPropagation();
      if (a === "multi-del") multiSelDeleteAll();
      else if (a === "multi-save") multiSelSaveAsComponent();
    }, true);
  }

  function multiSelDeleteAll() {
    if (!confirm(`删除选中的 ${_editorMultiSel.length} 个元素？`)) return;
    pushEditorUndoSnapshot();
    _editorMultiSel.forEach((el) => { try { el.remove(); } catch (e) {} });
    clearEditorMultiSelection();
    persistEditorChangesToState();
  }

  function multiSelSaveAsComponent() {
    if (!_editorMultiSel.length) return;
    const els0 = _editorMultiSel.slice();
    const doc = els0[0].ownerDocument;
    // 用一个 wrapper div 包住所有 outerHTML，保留视觉关系
    const wrapper = `<div class="component-bundle">${els0.map((e) => e.outerHTML).join("\n")}</div>`;
    // 合并 CSS：每个元素的相关规则拿出来，去重
    const seen = new Set();
    let mergedCss = "";
    els0.forEach((el) => {
      const css = extractCssForElement(el, doc);
      css.split("\n").forEach((rule) => {
        const norm = rule.trim();
        if (norm && !seen.has(norm)) { seen.add(norm); mergedCss += rule + "\n"; }
      });
    });
    _editorPendingSaveHtml = wrapper;
    _editorPendingSaveCss = mergedCss;
    openSaveAsComponentDialog();
    if (els.htmlPreviewSaveAsCompName) {
      els.htmlPreviewSaveAsCompName.value = `bundle-${els0[0].tagName.toLowerCase()}-x${els0.length}`;
      els.htmlPreviewSaveAsCompName.select?.();
    }
    if (els.htmlPreviewSaveAsCompDesc) {
      els.htmlPreviewSaveAsCompDesc.value = `从 ${htmlPreviewState?.templateName}/${htmlPreviewState?.layout} 抽出的 ${els0.length} 个元素组合`;
    }
  }

  // 多选拖动：所有元素同时用 transform: translate 平移
  function startEditorGroupDrag(ev) {
    if (!_editorMultiSel.length) return;
    pushEditorUndoSnapshot();
    const states = _editorMultiSel.map((el) => {
      const doc = el.ownerDocument;
      const cs = doc.defaultView.getComputedStyle(el);
      let tx = 0, ty = 0;
      const m = (el.style.transform || cs.transform || "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      if (m) { tx = parseFloat(m[1]); ty = parseFloat(m[2]); }
      return { el, startTx: tx, startTy: ty };
    });
    _editorDragState = {
      mode: "group-move",
      startX: ev.clientX, startY: ev.clientY,
      groupStates: states,
      moved: false
    };
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
    const doc = _editorMultiSel[0].ownerDocument;
    doc.addEventListener("mousemove", editorOnMouseMove, true);
    doc.addEventListener("mouseup",   editorOnMouseUp,   true);
  }

  function selectEditorElement(el) {
    if (!el || el === _editorSelectedEl) return;
    clearEditorSelection();
    _editorSelectedEl = el;
    // 加 move 光标提示，hover 在元素本体上就能看出是"可拖动"
    try { el.classList.add("__lingxi_selected_move"); } catch (e) {}
    const doc = el.ownerDocument;
    if (!doc?.body) return;
    const overlay = doc.createElement("div");
    overlay.id = EDITOR_SEL_OVERLAY_ID;
    // 线性 SVG 图标（feather 风格）：
    //   save  → package（向组件库存）
    //   edit  → edit-3（铅笔）
    //   del   → trash-2
    // SVG 在 iframe 内文档里 — 不能引外部文件路径（同源限制），必须 inline。
    const ICON_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
    const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    const ICON_DEL  = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    overlay.innerHTML =
      `<button class="ed-handle ed-save" data-action="save" title="保存为组件">${ICON_SAVE}</button>` +
      `<button class="ed-handle ed-edit" data-action="edit" title="编辑文字/颜色/字号">${ICON_EDIT}</button>` +
      `<button class="ed-handle ed-del danger" data-action="del" title="删除元素">${ICON_DEL}</button>` +
      // 修 #14: 八向 resize 把手；data-resize-dir 由 startEditorDrag 读
      '<div class="ed-resize ed-resize-nw" data-action="resize" data-resize-dir="nw" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-n"  data-action="resize" data-resize-dir="n"  title="拖动调整高度"></div>' +
      '<div class="ed-resize ed-resize-ne" data-action="resize" data-resize-dir="ne" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-e"  data-action="resize" data-resize-dir="e"  title="拖动调整宽度"></div>' +
      '<div class="ed-resize ed-resize-se" data-action="resize" data-resize-dir="se" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-s"  data-action="resize" data-resize-dir="s"  title="拖动调整高度"></div>' +
      '<div class="ed-resize ed-resize-sw" data-action="resize" data-resize-dir="sw" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-w"  data-action="resize" data-resize-dir="w"  title="拖动调整宽度"></div>';
    doc.body.appendChild(overlay);
    _editorSelOverlay = overlay;
    positionRectTo(overlay, el);
    overlay.addEventListener("click", (e) => {
      // SVG 子元素也可能是 e.target —— 用 closest 走到带 data-action 的祖先
      const handle = e.target?.closest?.("[data-action]");
      const a = handle?.dataset?.action;
      if (!a) return;
      e.stopPropagation();
      if (a === "del") editorDeleteSelected();
      else if (a === "edit") editorOpenEditPopup();
      else if (a === "save") editorSaveSelectedAsComponent();
    }, true);
  }

  // 通用：把 overlay 元素对齐到 targetEl 的 boundingClientRect
  // 当 overlay 是选中态（有 .ed-* 把手）且元素离顶部太近 → 切到 inside 模式让把手贴元素内顶部
  function positionRectTo(overlay, targetEl) {
    if (!overlay || !targetEl) return;
    const r = targetEl.getBoundingClientRect();
    const doc = overlay.ownerDocument;
    const sx = (doc.documentElement.scrollLeft || doc.body.scrollLeft || 0);
    const sy = (doc.documentElement.scrollTop  || doc.body.scrollTop  || 0);
    overlay.style.left   = (r.left + sx) + "px";
    overlay.style.top    = (r.top  + sy) + "px";
    overlay.style.width  = r.width + "px";
    overlay.style.height = r.height + "px";
    // 智能避让：选中态 overlay 才有 ed-* 把手
    if (overlay.id === EDITOR_SEL_OVERLAY_ID) {
      // 元素顶部空间 < 80px（把手 60 + margin）→ 内嵌
      const needAbove = 80;
      const insideMode = r.top < needAbove;
      overlay.classList.toggle("ed-handles-inside", insideMode);
      // 元素宽度 < 220px（3 个 60px 把手 + 间距）→ 启动窄模式：3 个把手左对齐固定间距，
      // 不再让 del 跟着元素右边走，避免跟 edit 在窄宽下重叠遮挡（用户报的 bug）。
      const needWidth = 220;
      const narrowMode = r.width < needWidth;
      overlay.classList.toggle("ed-handles-narrow", narrowMode);
    }
  }
  function positionEditorOverlay() {
    if (_editorSelectedEl && _editorSelOverlay) positionRectTo(_editorSelOverlay, _editorSelectedEl);
  }

  // ========== Smart guides + 吸附（参考 PS / Figma） ==========
  //
  // 设计：拖动期间扫描 stage 内所有元素的 6 个锚点（left/cx/right + top/cy/bottom）
  // 加上画布的 6 个锚点。被拖元素的对应锚点距离任意目标 ≤ SNAP_PX 时吸附到它，
  // 并在 iframe 内画一条参考线（画布=红色，元素对齐=青色）。
  // Shift 临时关闭吸附（跟 Figma 一致）。

  function _editorGetSnapTargets(excludeEls) {
    const frame = els.htmlPreviewFrame;
    const doc = frame?.contentDocument;
    if (!doc) return { xs: [], ys: [] };
    const stage = doc.querySelector(".stage") || doc.body;
    const stageR = stage.getBoundingClientRect();
    const xs = [
      { v: stageR.left,                          kind: "stage" },
      { v: (stageR.left + stageR.right) / 2,     kind: "stage" },
      { v: stageR.right,                         kind: "stage" }
    ];
    const ys = [
      { v: stageR.top,                           kind: "stage" },
      { v: (stageR.top + stageR.bottom) / 2,     kind: "stage" },
      { v: stageR.bottom,                        kind: "stage" }
    ];
    const skip = new Set(excludeEls || []);
    // 只看 stage 的 1 级 + 2 级子元素，避免文字节点把锚点数量打爆（性能 + 视觉清晰度）
    const candidates = [];
    Array.from(stage.children).forEach((c) => {
      if (!isEditorChromeEl(c)) candidates.push(c);
      Array.from(c.children || []).forEach((cc) => {
        if (!isEditorChromeEl(cc)) candidates.push(cc);
      });
    });
    candidates.forEach((el) => {
      if (skip.has(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      xs.push({ v: r.left,                kind: "el", el });
      xs.push({ v: (r.left + r.right)/2,  kind: "el", el });
      xs.push({ v: r.right,               kind: "el", el });
      ys.push({ v: r.top,                 kind: "el", el });
      ys.push({ v: (r.top + r.bottom)/2,  kind: "el", el });
      ys.push({ v: r.bottom,              kind: "el", el });
    });
    return { xs, ys };
  }

  // 对一组"被拖元素锚点"找最近吸附目标，返回 { snap: 像素调整, hits: [{ v, kind }] }
  // anchors 是当前要测的位置数组（如 [left, cx, right] 在水平方向）
  function _editorComputeSnap(anchors, candidates) {
    let best = null;  // { d, delta }
    let hits = [];
    for (const a of anchors) {
      for (const c of candidates) {
        const d = Math.abs(c.v - a);
        if (d > SNAP_PX) continue;
        if (!best || d < best.d - 0.001) {
          best = { d, delta: c.v - a };
          hits = [{ v: c.v, kind: c.kind }];
        } else if (Math.abs(d - best.d) < 0.5) {
          // 同距离的额外吸附点也画线（如左右两条同时对齐）
          if (!hits.some((h) => Math.abs(h.v - c.v) < 0.5)) {
            hits.push({ v: c.v, kind: c.kind });
          }
        }
      }
    }
    return { delta: best ? best.delta : 0, hits };
  }

  function _editorEnsureGuideLayer() {
    const frame = els.htmlPreviewFrame;
    const doc = frame?.contentDocument;
    if (!doc) return null;
    if (_editorGuideLayer && _editorGuideLayer.ownerDocument === doc) return _editorGuideLayer;
    let layer = doc.getElementById(EDITOR_GUIDE_LAYER_ID);
    if (!layer) {
      layer = doc.createElement("div");
      layer.id = EDITOR_GUIDE_LAYER_ID;
      layer.style.cssText = "position:absolute;top:0;left:0;width:1920px;height:1080px;pointer-events:none;z-index:99999998";
      doc.body.appendChild(layer);
    }
    _editorGuideLayer = layer;
    return layer;
  }

  // 画一条参考线。orient: "v"=竖线（按 X 位置）/ "h"=横线
  function _editorDrawGuide(orient, position, kind) {
    const layer = _editorEnsureGuideLayer();
    if (!layer) return;
    const color = kind === "stage" ? GUIDE_COLOR_STAGE : GUIDE_COLOR_EL;
    const line = layer.ownerDocument.createElement("div");
    if (orient === "v") {
      line.style.cssText = `position:absolute;top:0;bottom:0;left:${position}px;width:0;border-left:1px dashed ${color};box-shadow:0 0 0 0.5px ${color}`;
    } else {
      line.style.cssText = `position:absolute;left:0;right:0;top:${position}px;height:0;border-top:1px dashed ${color};box-shadow:0 0 0 0.5px ${color}`;
    }
    layer.appendChild(line);
  }

  function _editorClearGuides() {
    if (_editorGuideLayer) _editorGuideLayer.innerHTML = "";
  }
  function _editorDestroyGuides() {
    if (_editorGuideLayer) { try { _editorGuideLayer.remove(); } catch (e) {} _editorGuideLayer = null; }
    if (_editorPosHint)    { try { _editorPosHint.remove(); }    catch (e) {} _editorPosHint    = null; }
  }

  // 拖动时光标右下角的小坐标提示徽章："w × h · x,y"
  function _editorShowPosHint(x, y, w, h) {
    const frame = els.htmlPreviewFrame;
    const doc = frame?.contentDocument;
    if (!doc) return;
    if (!_editorPosHint) {
      _editorPosHint = doc.createElement("div");
      _editorPosHint.id = EDITOR_POS_HINT_ID;
      _editorPosHint.style.cssText = [
        "position:absolute","z-index:99999999","pointer-events:none",
        "background:#0F172A","color:#fff",
        "padding:6px 12px","border-radius:6px",
        "font:600 18px/1.2 ui-monospace,Menlo,Consolas,monospace",
        "white-space:nowrap","box-shadow:0 4px 12px rgba(0,0,0,0.35)"
      ].join(";");
      doc.body.appendChild(_editorPosHint);
    }
    _editorPosHint.style.left = (x + 12) + "px";
    _editorPosHint.style.top  = (y + 12) + "px";
    _editorPosHint.textContent = `${Math.round(w)} × ${Math.round(h)} · ${Math.round(x)}, ${Math.round(y)}`;
  }

  function startEditorDrag(ev, mode, dir) {
    const el = _editorSelectedEl;
    if (!el) return;
    // 拖 / resize 开始前先快照当前状态进 undo 栈
    pushEditorUndoSnapshot();
    const doc = el.ownerDocument;
    const cs = doc.defaultView.getComputedStyle(el);
    let curTx = 0, curTy = 0;
    const m = (el.style.transform || cs.transform || "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    if (m) { curTx = parseFloat(m[1]); curTy = parseFloat(m[2]); }
    // 快照拖动起点的 bbox + 全部吸附目标。吸附目标排除自己（拖动时不能跟自己对齐）。
    const startBbox = el.getBoundingClientRect();
    const snapTargets = _editorGetSnapTargets([el]);
    _editorDragState = {
      mode,
      // 修 #14: dir 决定哪几个轴受影响（n/s/e/w 任意组合）。move 模式忽略 dir
      dir: dir || "se",
      startX: ev.clientX, startY: ev.clientY,
      startW: parseFloat(cs.width) || el.offsetWidth,
      startH: parseFloat(cs.height) || el.offsetHeight,
      startTx: curTx, startTy: curTy,
      startBbox: { l: startBbox.left, t: startBbox.top, r: startBbox.right, b: startBbox.bottom, w: startBbox.width, h: startBbox.height },
      snapTargets,
      moved: false
    };
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
    _editorEnsureGuideLayer();
    doc.addEventListener("mousemove", editorOnMouseMove, true);
    doc.addEventListener("mouseup",   editorOnMouseUp,   true);
  }

  function editorOnMouseMove(ev) {
    const ds = _editorDragState;
    if (!ds) return;
    const dx = ev.clientX - ds.startX;
    const dy = ev.clientY - ds.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ds.moved = true;
    // 拖动期间持 shift 暂时禁用吸附，跟 Figma/PS 一致
    const snapOn = !ev.shiftKey && ds.snapTargets;

    if (ds.mode === "group-move") {
      // 多选拖动：所有成员同时平移（暂不上吸附；多选 union 锚点意义有限）
      ds.groupStates.forEach((s) => {
        s.el.style.transform = `translate(${s.startTx + dx}px, ${s.startTy + dy}px)`;
      });
      renderMultiSelOverlay();
      return;
    }
    const el = _editorSelectedEl;
    if (!el) return;

    _editorClearGuides();

    if (ds.mode === "move") {
      // 提议 bbox（不含吸附）
      const propL = ds.startBbox.l + dx;
      const propT = ds.startBbox.t + dy;
      const propR = propL + ds.startBbox.w;
      const propB = propT + ds.startBbox.h;
      let snapDx = 0, snapDy = 0;
      let hitsX = [], hitsY = [];
      if (snapOn) {
        const sx = _editorComputeSnap(
          [propL, (propL + propR) / 2, propR],
          ds.snapTargets.xs
        );
        const sy = _editorComputeSnap(
          [propT, (propT + propB) / 2, propB],
          ds.snapTargets.ys
        );
        snapDx = sx.delta;
        snapDy = sy.delta;
        hitsX = sx.hits;
        hitsY = sy.hits;
      }
      el.style.transform = `translate(${ds.startTx + dx + snapDx}px, ${ds.startTy + dy + snapDy}px)`;
      // 画吸附时命中的参考线
      hitsX.forEach((h) => _editorDrawGuide("v", h.v, h.kind));
      hitsY.forEach((h) => _editorDrawGuide("h", h.v, h.kind));
      // 坐标 hint：相对画布 0,0 的 x/y
      const finalL = propL + snapDx;
      const finalT = propT + snapDy;
      const stage = el.ownerDocument.querySelector(".stage");
      const sR = stage?.getBoundingClientRect();
      const relX = sR ? finalL - sR.left : finalL;
      const relY = sR ? finalT - sR.top  : finalT;
      _editorShowPosHint(finalL + ds.startBbox.w, finalT + ds.startBbox.h, ds.startBbox.w, ds.startBbox.h);
      // 顺手在 hint 后塞画布相对坐标
      if (_editorPosHint) {
        _editorPosHint.textContent = `${Math.round(ds.startBbox.w)} × ${Math.round(ds.startBbox.h)} · 画布 ${Math.round(relX)}, ${Math.round(relY)}`;
      }
    } else if (ds.mode === "resize") {
      // 修 #14: dir 里含 e/w 决定宽度改不改 + 是否要反向平移；含 n/s 决定高度
      const dir = ds.dir || "se";
      let newW = ds.startW;
      let newH = ds.startH;
      let dtx = 0, dty = 0;
      if (dir.includes("e")) {
        newW = Math.max(20, ds.startW + dx);
      } else if (dir.includes("w")) {
        newW = Math.max(20, ds.startW - dx);
        dtx = ds.startW - newW;
      }
      if (dir.includes("s")) {
        newH = Math.max(20, ds.startH + dy);
      } else if (dir.includes("n")) {
        newH = Math.max(20, ds.startH - dy);
        dty = ds.startH - newH;
      }
      // 计算 resize 后实际 bbox（基于原 startBbox 修正），然后对正被拖的边吸附
      const propL = ds.startBbox.l + dtx;
      const propT = ds.startBbox.t + dty;
      let propR = propL + newW;
      let propB = propT + newH;
      let propLFinal = propL, propTFinal = propT;
      if (snapOn) {
        // 仅吸附被拖的那条边对应的锚点（se 句柄就吸右下，nw 句柄就吸左上）
        const xAnchors = [];
        if (dir.includes("e")) xAnchors.push(propR);
        if (dir.includes("w")) xAnchors.push(propL);
        const yAnchors = [];
        if (dir.includes("s")) yAnchors.push(propB);
        if (dir.includes("n")) yAnchors.push(propT);
        if (xAnchors.length) {
          const sx = _editorComputeSnap(xAnchors, ds.snapTargets.xs);
          if (sx.delta) {
            if (dir.includes("e")) { newW += sx.delta; propR += sx.delta; }
            else if (dir.includes("w")) {
              // 左边界往右吸 = 减宽 + 整体右移
              newW -= sx.delta; propLFinal += sx.delta; dtx += sx.delta;
            }
          }
          sx.hits.forEach((h) => _editorDrawGuide("v", h.v, h.kind));
        }
        if (yAnchors.length) {
          const sy = _editorComputeSnap(yAnchors, ds.snapTargets.ys);
          if (sy.delta) {
            if (dir.includes("s")) { newH += sy.delta; propB += sy.delta; }
            else if (dir.includes("n")) {
              newH -= sy.delta; propTFinal += sy.delta; dty += sy.delta;
            }
          }
          sy.hits.forEach((h) => _editorDrawGuide("h", h.v, h.kind));
        }
      }
      if (newW !== ds.startW) el.style.width = Math.max(20, newW) + "px";
      if (newH !== ds.startH) el.style.height = Math.max(20, newH) + "px";
      if (dtx || dty) {
        el.style.transform = `translate(${ds.startTx + dtx}px, ${ds.startTy + dty}px)`;
      }
      const stage = el.ownerDocument.querySelector(".stage");
      const sR = stage?.getBoundingClientRect();
      const relX = sR ? propLFinal - sR.left : propLFinal;
      const relY = sR ? propTFinal - sR.top  : propTFinal;
      _editorShowPosHint(propR, propB, newW, newH);
      if (_editorPosHint) {
        _editorPosHint.textContent = `${Math.round(newW)} × ${Math.round(newH)} · 画布 ${Math.round(relX)}, ${Math.round(relY)}`;
      }
    }
    positionEditorOverlay();
  }
  function editorOnMouseUp() {
    const ds = _editorDragState;
    if (!ds) { plog("editor", "mouseup: no drag state (click without drag)"); return; }
    const moved = ds.moved;
    plog("editor", "mouseup: mode=" + ds.mode + " moved=" + moved + " willPersist=" + (moved ? "Y" : "N"));
    _editorDragState = null;
    const el = _editorSelectedEl || (ds.groupStates?.[0]?.el);
    const doc = el?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    if (doc) {
      doc.removeEventListener("mousemove", editorOnMouseMove, true);
      doc.removeEventListener("mouseup",   editorOnMouseUp,   true);
    }
    // 清理参考线 + 坐标 hint（不论是否真的拖动了）
    _editorClearGuides();
    if (_editorPosHint) { try { _editorPosHint.remove(); } catch (e) {} _editorPosHint = null; }
    if (moved) {
      // 拖完后浏览器可能（且仅在距离很小时）派发一次合成 click，我们吃掉避免误清选。
      // 关键：100ms 后自动失效。Chrome 在拖动距离 > ~5px 后压根不发这次 click，
      // 没有 setTimeout 的话 _editorJustDragged 会卡住 true 直到下次用户真的点击 ——
      // 那次真实点击被吃掉 → 用户感觉"拖完后再点别的没反应"。
      _editorJustDragged = true;
      setTimeout(() => { _editorJustDragged = false; }, 100);
      persistEditorChangesToState();
      // bake 完元素 left/top 改了，sel overlay 必须跟着复位到元素新 bbox 上 ——
      // 否则用户按习惯往旧 overlay 位置的 save/edit/del 按钮点，触发 isEditorChromeEl=true
      // → "mousedown: chrome el, ignore" → 用户感觉拖完之后再也点不动了，必须退出再进编辑模式。
      try { positionEditorOverlay(); } catch (e) {}
    }
  }

  // 删除选中元素
  function editorDeleteSelected() {
    const el = _editorSelectedEl;
    if (!el) return;
    pushEditorUndoSnapshot();
    el.remove();
    clearEditorSelection();
    persistEditorChangesToState();
  }

  // 编辑弹窗：填入当前元素的文字 / 颜色 / 字号 / 字重
  function editorOpenEditPopup() {
    const el = _editorSelectedEl;
    if (!el) return;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (els.htmlPreviewEditElTag) {
      els.htmlPreviewEditElTag.textContent = `<${el.tagName.toLowerCase()}>` + (el.className ? ` .${String(el.className).split(" ")[0]}` : "");
    }
    // 文字：只显示直接子文本（不含子元素 HTML），避免误删结构
    if (els.htmlPreviewEditElText) {
      const onlyText = (el.children.length === 0) ? el.textContent : "";
      els.htmlPreviewEditElText.value = onlyText;
      els.htmlPreviewEditElText.disabled = el.children.length > 0;
      els.htmlPreviewEditElText.placeholder = el.children.length > 0
        ? "（这个元素含子元素，不能直接改文字）"
        : "改文字内容";
    }
    if (els.htmlPreviewEditElColor) {
      // 把 rgb(x,y,z) 转 #rrggbb
      els.htmlPreviewEditElColor.value = rgbToHex(cs.color) || "#000000";
    }
    if (els.htmlPreviewEditElSize) {
      els.htmlPreviewEditElSize.value = parseInt(cs.fontSize, 10) || 16;
    }
    if (els.htmlPreviewEditElWeight) {
      els.htmlPreviewEditElWeight.value = "";
    }
    els.htmlPreviewEditElModal?.classList.remove("hidden");
  }
  function editorCloseEditPopup() {
    els.htmlPreviewEditElModal?.classList.add("hidden");
  }
  function editorApplyEditPopup() {
    const el = _editorSelectedEl;
    if (!el) { editorCloseEditPopup(); return; }
    pushEditorUndoSnapshot();
    if (els.htmlPreviewEditElText && !els.htmlPreviewEditElText.disabled) {
      el.textContent = els.htmlPreviewEditElText.value;
    }
    if (els.htmlPreviewEditElColor) el.style.color = els.htmlPreviewEditElColor.value;
    if (els.htmlPreviewEditElSize) {
      const n = parseInt(els.htmlPreviewEditElSize.value, 10);
      if (n > 0) el.style.fontSize = n + "px";
    }
    if (els.htmlPreviewEditElWeight && els.htmlPreviewEditElWeight.value) {
      el.style.fontWeight = els.htmlPreviewEditElWeight.value;
    }
    positionEditorOverlay();
    persistEditorChangesToState();
    editorCloseEditPopup();
  }
  function rgbToHex(rgb) {
    if (!rgb) return null;
    const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const h = (n) => Number(n).toString(16).padStart(2, "0");
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
  }

  // 扫描 iframe 内所有 stylesheet，挑出"跟选中元素子树相关"的 CSS 规则。
  // 判定标准：规则的 selectorText 提到了元素子树用到的某个 class 或 tag 名。
  // 这样存进组件库的 css 既覆盖了视觉，又不会把整页 css 都拖进来。
  function extractCssForElement(el, doc) {
    if (!el || !doc) return "";
    const classes = new Set();
    const tags = new Set();
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      tags.add(node.tagName.toLowerCase());
      if (node.classList) node.classList.forEach((c) => classes.add(c));
      Array.from(node.children || []).forEach(walk);
    };
    walk(el);
    const matched = [];
    const seen = new Set();
    const addRule = (cssText) => {
      if (cssText && !seen.has(cssText)) { seen.add(cssText); matched.push(cssText); }
    };
    const ruleMatches = (rule) => {
      if (!rule) return false;
      // @font-face / @import 等无 selector：直接放进去（字体常被组件依赖）
      if (rule.type === 5 || rule.type === 3) return true; // CSSFontFaceRule / CSSImportRule
      const sel = rule.selectorText || "";
      if (!sel) return false;
      // skip 全局基础 selector 避免污染
      if (/^(\*|html|body|:root)(\s|,|$|\.|>|~)/.test(sel.trim())) return false;
      for (const c of classes) {
        if (sel.includes("." + c)) return true;
      }
      for (const t of tags) {
        // tag 必须在 selector 中作为独立 token 出现
        const re = new RegExp("(^|[\\s,>+~])" + t + "([\\s,.:#\\[]|$)");
        if (re.test(sel)) return true;
      }
      return false;
    };
    const walkRules = (rules) => {
      if (!rules) return;
      for (const rule of rules) {
        if (rule.cssRules /* @media / @supports / @keyframes */) {
          // @keyframes 跟动画名挂钩；scope 内任何 animation-name 引用到才算，但我们保守地全部带进去
          if (rule.type === 7 /* CSSKeyframesRule */) {
            addRule(rule.cssText);
            continue;
          }
          // @media / @supports：递归到子规则
          const inner = [];
          for (const r of rule.cssRules) if (ruleMatches(r)) inner.push(r.cssText);
          if (inner.length) addRule(`${rule.cssText.split("{")[0]}{\n  ${inner.join("\n  ")}\n}`);
        } else if (ruleMatches(rule)) {
          addRule(rule.cssText);
        }
      }
    };
    for (const sheet of doc.styleSheets || []) {
      try { walkRules(sheet.cssRules); }
      catch (e) { /* CORS 受限 stylesheet，跳过 */ }
    }
    return matched.join("\n");
  }

  // 选中元素的 outerHTML 存为组件（打开 save-as-component dialog 预填）
  function editorSaveSelectedAsComponent() {
    const el = _editorSelectedEl;
    if (!el) return;
    const html = el.outerHTML;
    const st = htmlPreviewState;
    if (!st) return;
    // 抽取跟元素相关的 CSS（class + tag 选择器匹配），存到 pending 让 confirmSaveAsComponent 用
    const doc = el.ownerDocument;
    _editorPendingSaveHtml = html;
    _editorPendingSaveCss = extractCssForElement(el, doc);
    openSaveAsComponentDialog();
    // 把 save-as-component name 默认成 element 的第一个 class 名
    if (els.htmlPreviewSaveAsCompName) {
      const firstClass = String(el.className || "").split(" ")[0];
      els.htmlPreviewSaveAsCompName.value = firstClass || el.tagName.toLowerCase();
      els.htmlPreviewSaveAsCompName.select?.();
    }
    if (els.htmlPreviewSaveAsCompDesc) {
      els.htmlPreviewSaveAsCompDesc.value = `从「${st.templateName}/${st.layout}」抽出的 ${el.tagName.toLowerCase()} 组件`;
    }
  }
  let _editorPendingSaveHtml = null;
  let _editorPendingSaveCss = null;

  // 修 #15: 把 transform: translate(...) 烘焙成 position+left+top（或叠加到原 left/top 上）。
  // 原因：拖动/组拖动用的是 transform，DOM 坐标实际没变；如果用户后续用其他工具读 offsetLeft、
  // 或这段 HTML 被复制到另一个上下文，transform 偏移可能被丢/被误读。烘焙后元素的"视觉位置 = DOM 位置"。
  // 策略：
  //   - 元素当前是 absolute/fixed → 解析原 left/top 数值（默认 0），加上 dx/dy 写回，清掉 transform
  //   - 元素是 relative/static → 强制改 relative，新增 left=dx/top=dy（不影响其他元素流式布局，跟 translate 等价）
  function bakeTransformOffsetsIn(scopeEl) {
    if (!scopeEl) return;
    const win = scopeEl.ownerDocument?.defaultView;
    if (!win) return;
    const all = scopeEl.querySelectorAll("[style*='translate']");
    all.forEach((el) => {
      const inline = el.style?.transform || "";
      const m = inline.match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/);
      if (!m) return;
      const dx = parseFloat(m[1]) || 0;
      const dy = parseFloat(m[2]) || 0;
      if (!dx && !dy) {
        // 没位移，单纯清掉空 transform，避免遗留垃圾
        el.style.transform = inline.replace(/translate\([^)]*\)/, "").trim();
        if (!el.style.transform) el.style.removeProperty("transform");
        return;
      }
      const cs = win.getComputedStyle(el);
      const pos = cs.position;
      const isPositioned = pos === "absolute" || pos === "fixed" || pos === "relative" || pos === "sticky";
      // 关键修：base 用 inline 优先，inline 为空时回退到 computed style（含 CSS 类规则）。
      // 之前只读 inline.style.left 永远拿 0，导致首次拖 CSS-positioned 元素时
      // bake 把 left:200px 的元素直接重置到 left:dx（变成 50px 之类），
      // 用户保存后看历史缩略图，元素跑到完全错误位置 = 用户报的"变回原来的样子"。
      const inlineLeft = el.style.left;
      const inlineTop = el.style.top;
      // computed.left 对未定位元素是 "auto"；parseFloat("auto") 返回 NaN，|| 0 落空
      const csLeftPx = parseFloat(cs.left);
      const csTopPx  = parseFloat(cs.top);
      const baseLeft = inlineLeft ? parseFloat(inlineLeft) : (isFinite(csLeftPx) ? csLeftPx : 0);
      const baseTop  = inlineTop  ? parseFloat(inlineTop)  : (isFinite(csTopPx)  ? csTopPx  : 0);
      if (!isPositioned) el.style.position = "relative";
      el.style.left = (baseLeft + dx) + "px";
      el.style.top = (baseTop + dy) + "px";
      // 移除 translate；保留可能存在的其他 transform 函数（如 rotate）
      const restTransform = inline.replace(/translate\([^)]*\)/, "").trim();
      if (restTransform) el.style.transform = restTransform;
      else el.style.removeProperty("transform");
    });
  }

  // ========== 撤销 / 重做（编辑模式）==========
  // 简单 push/pop 栈：每次"实质性编辑"（drag end / resize end / delete / apply popup）
  // 前 pushUndo 当前 stage.innerHTML，撤销 = pop undo 推 redo 还原 DOM。
  // 不录碎屑（mousemove 期间的中间态），所以不会乱炸。栈深 50。
  const EDITOR_UNDO_LIMIT = 50;
  let _editorUndoStack = [];
  let _editorRedoStack = [];
  let _editorSuspendCapture = false; // restoreSnapshot 期间避免再 pushUndo

  function getEditorStageHtml() {
    const doc = els.htmlPreviewFrame?.contentDocument;
    const stage = doc?.querySelector(".stage") || doc?.body;
    return stage ? stage.innerHTML : "";
  }
  function setEditorStageHtml(html) {
    const doc = els.htmlPreviewFrame?.contentDocument;
    const stage = doc?.querySelector(".stage") || doc?.body;
    if (!stage) return;
    // 退出当前选中 / overlay 状态后再写，否则 overlay DOM 会被吃掉
    try { clearEditorSelection(); } catch (e) {}
    try { clearEditorMultiSelection?.(); } catch (e) {}
    stage.innerHTML = html;
  }
  function pushEditorUndoSnapshot() {
    if (_editorSuspendCapture) return;
    if (!htmlPreviewState || htmlPreviewState.layout !== "freeform") return;
    const snap = getEditorStageHtml();
    if (!snap) return;
    // 跟栈顶一样就不重复入（避免 drag 多次相邻同状态污染）
    if (_editorUndoStack.length && _editorUndoStack[_editorUndoStack.length - 1] === snap) return;
    _editorUndoStack.push(snap);
    if (_editorUndoStack.length > EDITOR_UNDO_LIMIT) _editorUndoStack.shift();
    // 一旦有新编辑就清掉 redo（线性编辑，不分支）
    _editorRedoStack = [];
    updateEditorUndoRedoButtons();
  }
  function editorUndo() {
    if (!_editorUndoStack.length) return;
    const current = getEditorStageHtml();
    const prev = _editorUndoStack.pop();
    if (current) _editorRedoStack.push(current);
    _editorSuspendCapture = true;
    try {
      setEditorStageHtml(prev);
      persistEditorChangesToState();
    } finally {
      _editorSuspendCapture = false;
    }
    updateEditorUndoRedoButtons();
  }
  function editorRedo() {
    if (!_editorRedoStack.length) return;
    const current = getEditorStageHtml();
    const next = _editorRedoStack.pop();
    if (current) _editorUndoStack.push(current);
    _editorSuspendCapture = true;
    try {
      setEditorStageHtml(next);
      persistEditorChangesToState();
    } finally {
      _editorSuspendCapture = false;
    }
    updateEditorUndoRedoButtons();
  }
  function updateEditorUndoRedoButtons() {
    if (els.htmlPreviewEditUndoBtn) els.htmlPreviewEditUndoBtn.disabled = _editorUndoStack.length === 0;
    if (els.htmlPreviewEditRedoBtn) els.htmlPreviewEditRedoBtn.disabled = _editorRedoStack.length === 0;
  }
  function clearEditorUndoStacks() {
    _editorUndoStack = [];
    _editorRedoStack = [];
    updateEditorUndoRedoButtons();
  }

  // 把 iframe body 当前 innerHTML（去掉 overlay）序列化回 st.data.html
  function persistEditorChangesToState() {
    const st = htmlPreviewState;
    const ifr = els.htmlPreviewFrame;
    const doc = ifr?.contentDocument;
    if (!st) { plog("persist", "skipped: no state"); return; }
    if (!doc?.body) { plog("persist", "skipped: iframe contentDocument unavailable"); return; }
    if (st.layout !== "freeform") { plog("persist", "skipped: layout=" + st.layout + " (not freeform)"); return; }
    // 找回 .stage 容器（freeform 把 html 包在 .stage 里）—— 直接读 .stage.innerHTML
    const stage = doc.querySelector(".stage") || doc.body;
    // 序列化前先把 transform 烘焙成 left/top，让 HTML 自带正确坐标
    try { bakeTransformOffsetsIn(stage); }
    catch (e) { pwarn("persist", "bakeTransformOffsetsIn threw: " + (e?.message || e)); }
    // sel / hover 两层 overlay 是直接 append 到 doc.body，**不是 .stage 的子节点**，
    // stage.innerHTML 天然不会序列化到它们 —— 之前那段 detach/reattach 既多余又会
    // 顺手清掉 sel overlay 的事件/位置状态，导致第一次拖完后下一次点击没响应。
    const before = String(st.data?.html || "");
    const captured = stage.innerHTML;
    st.data = Object.assign({}, st.data, { html: captured });
    // bake 完元素改了 left/top，sel overlay 的位置要按新的 bbox 重定位
    try { positionEditorOverlay(); } catch (e) {}
    plog("persist", "captured stage.innerHTML"
      + " beforeLen=" + before.length
      + " afterLen=" + captured.length
      + " changed=" + (before === captured ? "N" : "Y")
      + " head=" + captured.slice(0, 80).replace(/\n/g, "\\n"));
    // 同步字段编辑器里 html textarea 的值
    const fieldHostHtml = els.htmlPreviewFields?.querySelector('[data-field-name="html"]');
    if (fieldHostHtml) fieldHostHtml.value = st.data.html;
  }

  function toggleEditMode() {
    if (!htmlPreviewState) return;
    if (_editorEnabled) { disableIframeEditor(); return; }
    // 非 freeform 自动转换：把当前渲染的 HTML/CSS 拍下来塞进 freeform，
    // 之后编辑器随便拖随便改。保留视觉，但失去字段表单（不再能改 title/items 这种结构化字段）。
    if (htmlPreviewState.layout !== "freeform") {
      const ok = convertCurrentLayoutToFreeform();
      if (!ok) {
        showMessage("无法切换到自由编辑模式 —— 当前布局渲染失败，请重试", "error");
        return;
      }
      showMessage("已转为自由编辑模式 —— 可拖动、缩放、改文字。原字段表单不再可用。", "info");
    }
    enableIframeEditor();
    // 一次性提示：操作要点（吸附 / Shift 临时禁用 / Esc 退出选中等）
    if (!global.WpsAiStore.getItem("__lingxi_editor_tips_seen__")) {
      showMessage("拖动会自动吸附（边/中心/对齐 6px 内）。按住 Shift 可临时禁用吸附。", "info");
      try { global.WpsAiStore.setItem("__lingxi_editor_tips_seen__", "1"); } catch (e) {}
    }
  }

  // 把当前 state 的非 freeform layout 渲染结果"展平"成 freeform，让编辑器接管。
  // 实现：调 layoutDef.render 拿完整 HTML doc → DOMParser 解析 → 抽 <style> 内容 + .stage 的 innerHTML
  // → 写回 state.data 为 { html, css }，layout 改成 "freeform"，再 re-render。
  // 不修改用户原 data（保存在 _preFreeformData，给"撤销转换"留口子，目前未实现 UI）。
  function convertCurrentLayoutToFreeform() {
    const st = htmlPreviewState;
    if (!st || st.layout === "freeform") return true;
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    const layoutDef = tpl?.layouts?.[st.layout];
    if (!layoutDef) return false;
    let fullDoc;
    try { fullDoc = layoutDef.render(st.data || {}, st.palette || {}); }
    catch (e) { console.warn("[convert-freeform] render failed:", e); return false; }
    if (!fullDoc || typeof fullDoc !== "string") return false;

    // 解析出 <style> 内容（拼接所有 <style> 块）+ <body> 里 .stage 的 innerHTML
    let cssOut = "";
    let htmlOut = "";
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(fullDoc, "text/html");
      doc.querySelectorAll("style").forEach((s) => { cssOut += s.textContent + "\n"; });
      const stage = doc.querySelector(".stage");
      if (stage) htmlOut = stage.innerHTML;
      else htmlOut = doc.body ? doc.body.innerHTML : "";
    } catch (e) {
      console.warn("[convert-freeform] parse failed:", e);
      // 兜底：用正则粗解（不严谨但能凑合）
      const styleMatch = fullDoc.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
      cssOut = styleMatch ? styleMatch[1] : "";
      const stageMatch = fullDoc.match(/<div class="stage"[^>]*>([\s\S]*)<\/div>\s*<\/body>/i);
      htmlOut = stageMatch ? stageMatch[1] : "";
    }
    if (!htmlOut) return false;

    // 备份原 data 让以后能"还原"
    st._preFreeformData = st.data;
    st._preFreeformLayout = st.layout;
    st.layout = "freeform";
    st.data = { html: htmlOut, css: cssOut };
    // 切换后重渲染 iframe + 字段表单
    renderHtmlPreviewFields();
    renderHtmlPreviewIntoIframe();
    updateHtmlPreviewActionButtons();
    return true;
  }

  // ====== 双 tab 切换：美化当前 / 统一修改 ======
  let _previewChatActiveTab = "current"; // current | unified

  function setPreviewChatTab(tab) {
    if (tab !== "current" && tab !== "unified") return;
    _previewChatActiveTab = tab;
    document.querySelectorAll(".preview-chat-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.chatTab === tab);
    });
    // 切换面板可见性（log + input-row 各有 data-chat-panel 标记）
    document.querySelectorAll("[data-chat-panel]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.chatPanel !== tab);
    });
    // 选用组件 / count badge 只在"当前"tab 下有意义；统一修改改的是全部历史
    if (els.htmlPreviewPickComponentsBtn) {
      els.htmlPreviewPickComponentsBtn.classList.toggle("hidden", tab !== "current");
    }
  }

  // ====== 统一修改"我的历史"全部条目 ======
  // 一条用户指令循环跑全部 history 条目，每条单独跟 AI 通信，拿到 patch 后 cache.update()
  // 持久化在 localStorage 全局一份（不分 slide）
  const UNIFIED_CHAT_LOG_KEY = "lingxi_html_preview_unified_chat_log_v1";
  const unifiedChatLog = []; // [{role, text}]

  function loadUnifiedChatLog() {
    try {
      const raw = global.WpsAiStore.getItem(UNIFIED_CHAT_LOG_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) parsed.forEach((e) => unifiedChatLog.push(e));
    } catch (e) {}
  }
  function saveUnifiedChatLog() {
    try { global.WpsAiStore.setItem(UNIFIED_CHAT_LOG_KEY, JSON.stringify(unifiedChatLog)); }
    catch (e) {}
  }
  loadUnifiedChatLog();

  function appendUnifiedChatMsg(role, text) {
    const log = els.htmlPreviewUnifiedLog;
    if (!log) return null;
    const empty = log.querySelector(".html-preview-chat-empty");
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = `html-preview-chat-msg ${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (role !== "ai-pending") {
      unifiedChatLog.push({ role, text });
      saveUnifiedChatLog();
    }
    return div;
  }
  function renderUnifiedChatLogFromStore() {
    const log = els.htmlPreviewUnifiedLog;
    if (!log) return;
    log.innerHTML = "";
    if (!unifiedChatLog.length) {
      log.innerHTML = '<div class="html-preview-chat-empty">让 AI <b>批量改"我的历史"全部幻灯片</b>：<br>· 全局换色 ——「所有背景换成深海军蓝」<br>· 字体统一 ——「标题字号统一加大到 80px」<br>· 装饰统一 ——「每页顶部加 4px 渐变条」<br>· 风格收敛 ——「整套都更商务一点，去掉花哨装饰」<br><br>⚠ 每条历史都会被 AI 单独处理一次，可能慢；会自动跳过 freeform 之外的固定布局。</div>';
      return;
    }
    unifiedChatLog.forEach((m) => {
      const div = document.createElement("div");
      div.className = `html-preview-chat-msg ${m.role}`;
      div.textContent = m.text;
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }

  function clearUnifiedChatLog() {
    unifiedChatLog.length = 0;
    saveUnifiedChatLog();
    renderUnifiedChatLogFromStore();
  }

  // 给一个 history entry 跑一次 AI 患者，返回 patch 或 null（跳过）
  async function unifiedPatchOne(entry, userInstruction) {
    if (!entry || !entry.templateName || !entry.layout) return null;
    if (entry.layout !== "freeform") {
      // 固定 layout 的 schema 化 data，不能像 freeform 那样自由改 —— 至少配色还能动
      // 只让 AI 输出 palette 部分
      const sysFixed = [
        "你给一张幻灯片做局部美化：**只允许调整 palette（配色 + 字体）**，data 字段不要动（固定 layout schema 不支持自由改）。",
        "",
        `当前模板：${entry.templateName}`,
        `当前布局：${entry.layout}（固定 layout）`,
        `当前 palette：${JSON.stringify(entry.palette || {}, null, 2)}`,
        "",
        "用户指令：" + userInstruction,
        "",
        "**只输出一段 raw JSON**：",
        '{"palette": {"primaryColor": "#xxxxxx", ...}}',
        "",
        "palette 可用 key：primaryColor / accentColor / backgroundColor / surfaceColor / titleColor / bodyColor / titleFont / bodyFont。",
        "如果用户指令跟配色无关（如「字号改大」、「换排版」），返回 `{}`（不改）。",
        "禁止解释、寒暄、markdown 围栏。第一字符必须是 {。"
      ].join("\n");
      let raw;
      try {
        raw = await callProviderForPreviewChat([
          { role: "system", content: sysFixed },
          { role: "user", content: userInstruction }
        ], null);
      } catch (e) { throw new Error(`AI 调用失败：${e?.message || e}`); }
      let patch;
      try {
        let s = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const f = s.indexOf("{"), l = s.lastIndexOf("}");
        patch = JSON.parse(s.slice(f, l + 1));
      } catch (e) { return null; }
      if (!patch?.palette || typeof patch.palette !== "object") return null;
      return { palette: Object.assign({}, entry.palette || {}, patch.palette) };
    }

    // freeform：HTML/CSS 都能动
    const sysFree = [
      "你给一张 freeform 幻灯片做局部美化。**保留原内容（文字 / 数字 / 列表项）一字不动**，只改 HTML 结构 / CSS / palette 来响应用户的统一修改需求。",
      "",
      "你必须输出**一段 raw JSON patch**，可以包含：",
      '  - "html": "新 body HTML"（可选，要改 HTML 时给）',
      '  - "css": "新 CSS"（可选）',
      '  - "palette": { ... }（可选，要换配色时给）',
      "不要修改的字段就不要出现在 JSON 里。",
      "",
      `当前 HTML：\n${String(entry.data?.html || "").slice(0, 8000)}`,
      `\n当前 CSS：\n${String(entry.data?.css || "").slice(0, 4000)}`,
      `\n当前 palette：${JSON.stringify(entry.palette || {}, null, 2)}`,
      "",
      "字号底线：正文 ≥24px、标题 ≥40px。颜色字体必须用 CSS 变量 var(--primary) 等。",
      "**严禁改写文字内容** —— 用户没让你改文案，只让你改视觉。",
      "禁止解释、寒暄、markdown 围栏。第一字符必须是 {，最后字符必须是 }。"
    ].join("\n");
    let raw;
    try {
      raw = await callProviderForPreviewChat([
        { role: "system", content: sysFree },
        { role: "user", content: userInstruction }
      ], null);
    } catch (e) { throw new Error(`AI 调用失败：${e?.message || e}`); }
    let patch;
    try {
      let s = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const f = s.indexOf("{"), l = s.lastIndexOf("}");
      patch = JSON.parse(s.slice(f, l + 1));
    } catch (e) { return null; }
    if (!patch || typeof patch !== "object") return null;
    // 修 B7：prompt 里 html 截到 8000、css 截到 4000。若原文超出该窗口，AI 只看到前半段，
    // 返回的重写版必然缺尾部——此时整体替换会永久丢失尾部内容。超长条目不接受该字段的重写。
    const htmlTooLong = String(entry.data?.html || "").length > 8000;
    const cssTooLong = String(entry.data?.css || "").length > 4000;
    const result = {};
    const acceptHtml = typeof patch.html === "string" && !htmlTooLong;
    const acceptCss = typeof patch.css === "string" && !cssTooLong;
    if (acceptHtml || acceptCss) {
      result.data = Object.assign({}, entry.data || {});
      if (acceptHtml) result.data.html = patch.html;
      if (acceptCss) result.data.css = patch.css;
    }
    if (patch.palette && typeof patch.palette === "object") {
      result.palette = Object.assign({}, entry.palette || {}, patch.palette);
    }
    return Object.keys(result).length ? result : null;
  }

  // 修 #7: 统一修改 chat 状态——加可取消 + 进度条 + 退避重试
  let _unifiedAborted = false;
  function abortUnifiedModifyChat() { _unifiedAborted = true; }

  // 跑一次带退避重试的 unifiedPatchOne。429 / 5xx / network 错误指数退避，最多 3 次。
  async function unifiedPatchOneWithRetry(entry, instruction) {
    const isRateOrTransient = (msg) =>
      /\b(429|5\d\d|rate.?limit|timeout|fetch.*failed|network|ECONN|ETIMEDOUT)\b/i.test(String(msg || ""));
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (_unifiedAborted) throw new Error("用户已取消");
      try {
        return await unifiedPatchOne(entry, instruction);
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        if (!isRateOrTransient(msg) || attempt === 2) throw e;
        // 指数退避：1s → 2s → 4s
        const waitMs = (2 ** attempt) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }

  async function submitUnifiedModifyChat() {
    const ta = els.htmlPreviewUnifiedInput;
    if (!ta) return;
    const instruction = (ta.value || "").trim();
    if (!instruction) return;
    const cache = global.WpsAiHtmlCache;
    if (!cache) {
      appendUnifiedChatMsg("ai-err", "缓存模块未加载。");
      return;
    }
    // 修 B7：只处理当前文档的历史条目（与画廊/历史 UI 的 docKey 过滤保持一致），
    // 否则会连带重写其它 PPT 的历史条目并落盘，UI 上完全不可见。
    const entries = cache.list?.({ docKey: _cachedDocKey }) || [];
    if (!entries.length) {
      appendUnifiedChatMsg("ai-err", "「我的历史」没有当前文档的条目，无可批量修改。");
      return;
    }
    ta.value = "";
    appendUnifiedChatMsg("user", instruction);

    // 修 #7: 进度条 bubble + 停止按钮
    _unifiedAborted = false;
    const pending = appendUnifiedChatMsg("ai-pending", "");
    if (pending) {
      pending.innerHTML =
        `<div class="unified-progress">` +
          `<div class="unified-progress-head">` +
            `<span class="unified-progress-label">开始处理 ${entries.length} 条历史…</span>` +
            `<button type="button" class="unified-progress-stop ghost-btn compact-btn">停止</button>` +
          `</div>` +
          `<div class="unified-progress-bar"><div class="unified-progress-bar-fill"></div></div>` +
        `</div>`;
      pending.querySelector(".unified-progress-stop")?.addEventListener("click", abortUnifiedModifyChat);
    }
    const labelEl = pending?.querySelector(".unified-progress-label");
    const fillEl = pending?.querySelector(".unified-progress-bar-fill");
    const stopBtn = pending?.querySelector(".unified-progress-stop");

    let okCount = 0, skipped = 0, failed = 0;
    const errs = [];
    for (let i = 0; i < entries.length; i++) {
      if (_unifiedAborted) break;
      const e = entries[i];
      if (labelEl) labelEl.textContent = `处理中 ${i + 1}/${entries.length}：${e.templateName} / ${e.layout}`;
      if (fillEl) fillEl.style.width = ((i / entries.length) * 100).toFixed(1) + "%";
      try {
        const patch = await unifiedPatchOneWithRetry(e, instruction);
        if (!patch) { skipped += 1; continue; }
        cache.update(e.id, patch);
        okCount += 1;
      } catch (err) {
        if (_unifiedAborted) break;
        failed += 1;
        errs.push(`${e.templateName}/${e.layout}: ${err?.message || err}`);
      }
    }
    if (fillEl) fillEl.style.width = "100%";
    if (stopBtn) stopBtn.disabled = true;
    if (pending) pending.remove();

    // 当前预览的 slide 如果在历史里，也需要 reload 一下 state 才能看到改动
    if (htmlPreviewState?.id) {
      const refreshed = cache.get?.(htmlPreviewState.id);
      if (refreshed) {
        htmlPreviewState.data = Object.assign({}, refreshed.data || {});
        htmlPreviewState.palette = Object.assign({}, refreshed.palette || {});
        if (refreshed.layout && refreshed.layout !== htmlPreviewState.layout) {
          htmlPreviewState.layout = refreshed.layout;
          if (els.htmlPreviewLayout) els.htmlPreviewLayout.textContent = refreshed.layout;
        }
        renderHtmlPreviewFields();
        renderHtmlPreviewIntoIframe();
      }
    }
    renderHtmlTemplateGallery();
    updateHtmlPreviewHistoryBadge();

    const summary = [`改动 ${okCount} 条`];
    if (skipped) summary.push(`跳过 ${skipped} 条（AI 判定与该指令无关）`);
    if (failed) summary.push(`失败 ${failed} 条`);
    if (_unifiedAborted) summary.push(`已停止（用户取消）`);
    appendUnifiedChatMsg("ai", summary.join("，") + "。" + (errs.length ? "\n失败明细：\n" + errs.slice(0, 3).join("\n") : ""));
    _unifiedAborted = false;
  }

  // 抽取后预览弹窗：列出本次入库的组件（带缩略图 + 复选框）
  // 用户可以"全部保留"（默认）或"删除未勾选"（把没选的从库里 remove 掉）
  let _extractedReviewCurrent = null; // { saved: [], dupExisting, dupBatch, saveErrs }
  function openExtractedComponentsReview(saved, info) {
    const overlay = els.htmlPreviewExtractReviewModal;
    if (!overlay) return;
    _extractedReviewCurrent = { saved, ...info };
    if (els.htmlPreviewExtractReviewTitle) {
      els.htmlPreviewExtractReviewTitle.textContent = `本次抽到 ${saved.length} 个组件`;
    }
    if (els.htmlPreviewExtractReviewSummary) {
      const bits = [];
      if (info.dupExisting?.length) bits.push(`${info.dupExisting.length} 个跟库里重复（已跳过）`);
      if (info.dupBatch?.length) bits.push(`${info.dupBatch.length} 个本批内重复（已跳过）`);
      if (info.saveErrs?.length) bits.push(`${info.saveErrs.length} 个保存失败`);
      els.htmlPreviewExtractReviewSummary.textContent = bits.length ? bits.join("，") : "全部入库成功";
    }
    renderExtractedReviewList(saved);
    overlay.classList.remove("hidden");
  }
  function closeExtractedComponentsReview() {
    els.htmlPreviewExtractReviewModal?.classList.add("hidden");
    _extractedReviewCurrent = null;
  }
  function renderExtractedReviewList(comps) {
    const host = els.htmlPreviewExtractReviewList;
    if (!host) return;
    host.innerHTML = "";
    const palette = currentPaletteForPreview();
    comps.forEach((c) => {
      const card = document.createElement("div");
      card.className = "component-picker-item selected"; // 默认全勾
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "component-picker-item-thumb component-thumb-fit";
      let thumbHtml;
      try { thumbHtml = makeComponentThumbHtml(c, palette); }
      catch (e) { thumbHtml = `<html><body style="color:#c00">${e?.message}</body></html>`; }
      const ifr = document.createElement("iframe");
      ifr.setAttribute("sandbox", "allow-same-origin");
      try { ifr.srcdoc = thumbHtml; } catch (e) {}
      ifr.addEventListener("load", () => { bridgeEchartsToFrame(ifr); fitComponentThumb(ifr, thumbWrap); });
      thumbWrap.appendChild(ifr);
      card.appendChild(thumbWrap);

      const row1 = document.createElement("div");
      row1.className = "component-picker-item-row1";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.compId = c.id;
      const name = document.createElement("span");
      name.className = "component-picker-item-name";
      name.textContent = c.name || c.id;
      row1.appendChild(cb);
      row1.appendChild(name);
      // 单条直接删除：从库里 remove，从当前 review list DOM 中拿掉
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "component-picker-item-del";
      delBtn.title = "从组件库删除这条";
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!confirm(`从组件库删除「${c.name}」？此操作不可撤销。`)) return;
        global.WpsAiHtmlComponents?.remove?.(c.id);
        // 也把所有 slide 对它的选择引用清掉
        pickedComponentsByKey.forEach((arr, k) => {
          const filtered = arr.filter((x) => x !== c.id);
          if (filtered.length !== arr.length) {
            if (filtered.length) pickedComponentsByKey.set(k, filtered);
            else pickedComponentsByKey.delete(k);
          }
        });
        savePickedComponentsToStorage();
        card.remove();
        if (_galleryActiveTab === "components") renderHtmlTemplateGallery();
        // 全部被删了，关掉 review 弹窗
        if (!host.children.length) closeExtractedComponentsReview();
      });
      row1.appendChild(delBtn);
      card.appendChild(row1);
      if (c.description) {
        const desc = document.createElement("div");
        desc.className = "component-picker-item-desc";
        desc.textContent = c.description;
        card.appendChild(desc);
      }
      card.addEventListener("click", (ev) => {
        if (ev.target.tagName === "INPUT" || ev.target === delBtn) return;
        cb.checked = !cb.checked;
        card.classList.toggle("selected", cb.checked);
      });
      cb.addEventListener("change", () => card.classList.toggle("selected", cb.checked));
      host.appendChild(card);
    });
  }
  function discardUncheckedExtracted() {
    if (!_extractedReviewCurrent) return;
    const host = els.htmlPreviewExtractReviewList;
    const compStore = global.WpsAiHtmlComponents;
    let removed = 0;
    host?.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (!cb.checked && cb.dataset.compId) {
        compStore?.remove?.(cb.dataset.compId);
        removed += 1;
      }
    });
    if (_galleryActiveTab === "components") renderHtmlTemplateGallery();
    closeExtractedComponentsReview();
    showMessage(removed ? `已删除 ${removed} 个未勾选组件，其余保留。` : "全部保留。", "success");
  }

  // 「提取组件」按钮：让 AI 把当前 freeform 幻灯片拆成若干可复用组件，每个独立存到组件库
  async function extractComponentsFromCurrentSlide() {
    const st = htmlPreviewState;
    if (!st || st.layout !== "freeform") {
      showMessage("只有 freeform 布局可以提取组件。当前请先切到 freeform 排版。", "error");
      return;
    }
    const html = String(st.data?.html || "").trim();
    const css = String(st.data?.css || "").trim();
    if (!html) {
      showMessage("freeform 的 html 字段是空的，无可提取。", "error");
      return;
    }
    if (!global.WpsAiHtmlComponents) {
      showMessage("组件库模块未加载。", "error");
      return;
    }
    const btn = els.htmlPreviewExtractCompsBtn;
    if (btn) { btn.disabled = true; btn.textContent = "AI 提取中…"; }
    showMessage("AI 正在抽取组件，可能需要 10-30 秒…", "info", { autoHide: false });

    const systemPrompt = [
      "你是 HTML 幻灯片的**组件抽取助手**。我会给你一张幻灯片的 body HTML + CSS。",
      "任务：找出**可复用的视觉单元**，**两类都算**：",
      "  ① 信息组件：指标卡、状态徽章、完成清单项、引言块、章节眉签 + 标题、双栏对比卡、Gantt 条目、团队成员卡 等",
      "  ② 装饰组件：渐变背景条、顶部 4px 装饰线、角落几何装饰、icon 集群、分隔器、徽章圆环、底部水印、纯视觉边框 等",
      "**纯装饰、没有具体含义的视觉元素也要抽出来** —— 这些是整套 PPT 风格统一的关键，复用价值极高。",
      "",
      "每个组件必须满足：",
      "1. **自包含**：HTML + CSS 可以独立挪到其他幻灯片的 freeform 直接渲染，不依赖外部 class / 上下文。",
      "2. **通用**：能装不同内容时用占位符（`{标题}` / `{数字}` / `{描述}`），纯装饰组件不需要占位符（本来就没文字）。**不要写死当前 slide 的具体内容**（如把\"软发 iPark 二期\"写死进 HTML）。",
      "3. **语义化命名**：name 用 kebab-case 描述\"是什么\"，如 metric-card / status-pill / completed-item / quote-pull / section-eyebrow / gradient-top-bar / corner-deco-orange / icon-cluster-row。",
      "4. **描述清晰**：description 一句话说明用途和适用场景（信息组件描述\"装什么内容\"；装饰组件描述\"用在哪里\"）。",
      "5. CSS 只放该组件相关的样式，颜色 / 字体必须用 `var(--primary)` / `var(--accent)` / `var(--title-color)` / `var(--body-color)` / `var(--surface)` / `var(--bg)` / `var(--title-font)` / `var(--body-font)` 等全局变量，不要硬编码 #RRGGBB（包括装饰组件）。",
      "6. 字号要符合 PPT 演示尺寸：正文 ≥24px、标题 ≥40px、metric 数字 80-200px（不含装饰组件）。",
      "",
      "**严格只输出一段 raw JSON 数组**，禁止解释、寒暄、markdown 围栏。格式：",
      '[{"name": "metric-card", "description": "...", "html": "<div class=\\"metric-card\\">...</div>", "css": ".metric-card { ... }"}, ...]',
      "",
      "如果幻灯片真的什么都没有（白底纯文字），返回 `[]`（空数组）—— 但大部分页面都会有装饰元素可抽。",
      "组件之间不要有重叠 —— 一段 HTML 出现在某个组件里，就不要再单独抽成另一个组件。",
      "组件数量建议 3-8 个之间（含装饰），太多反而难复用。"
    ].join("\n");
    const userText = [
      `<!-- BODY HTML -->`,
      html,
      "",
      "<!-- CSS -->",
      css || "(无独立 CSS)"
    ].join("\n");

    let raw = "";
    try {
      raw = await callProviderForPreviewChat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ],
        null // 不需要流式更新 UI
      );
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "提取组件"; }
      showMessage(`AI 调用失败：${e?.message || e}`, "error");
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = "提取组件"; }

    // 解析返回的 JSON 数组（容错 markdown 围栏 / 前后多余文字）
    let arr;
    try {
      let s = String(raw || "").trim();
      s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const first = s.indexOf("[");
      const last = s.lastIndexOf("]");
      if (first < 0 || last < 0 || last < first) throw new Error("找不到 JSON 数组");
      arr = JSON.parse(s.slice(first, last + 1));
    } catch (e) {
      showMessage(`AI 返回不是合法 JSON 数组：${String(raw).slice(0, 200)}`, "error");
      return;
    }
    if (!Array.isArray(arr) || !arr.length) {
      showMessage("AI 没识别出可独立复用的组件（页面可能太简单 / 太特化）。", "info");
      return;
    }

    // 去重：跟库里已存"等价"组件 + 本批次自身重复
    const normalizeForDedup = (h, c) => {
      const n = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      return n(h) + "|||" + n(c);
    };
    const existingHashes = new Set();
    // 去重也按当前 PPT 作用域，跨 PPT 重复不算重复（不同 PPT 内容可以同名同结构）
    (global.WpsAiHtmlComponents.list?.({ docKey: _cachedDocKey }) || []).forEach((c) => {
      existingHashes.add(normalizeForDedup(c.html, c.css));
    });

    const toSave = [], dupExisting = [], dupBatch = [], invalid = [];
    const batchSeen = new Set();
    arr.forEach((c, i) => {
      if (!c || typeof c !== "object") { invalid.push(`#${i + 1}: 不是对象`); return; }
      const name = String(c.name || "").trim();
      const compHtml = String(c.html || "").trim();
      const compCss = String(c.css || "").trim();
      if (!name || !compHtml) { invalid.push(`#${i + 1}: 缺 ${!name ? "name" : "html"}`); return; }
      const hash = normalizeForDedup(compHtml, compCss);
      if (existingHashes.has(hash)) { dupExisting.push(name); return; }
      if (batchSeen.has(hash)) { dupBatch.push(name); return; }
      batchSeen.add(hash);
      toSave.push({ name, description: String(c.description || "").trim(), html: compHtml, css: compCss });
    });

    if (!toSave.length) {
      const summary = [];
      if (dupExisting.length) summary.push(`${dupExisting.length} 个已在库`);
      if (dupBatch.length) summary.push(`${dupBatch.length} 个本批重复`);
      if (invalid.length) summary.push(`${invalid.length} 个格式错`);
      showMessage(`没有新组件入库：${summary.join("，")}`, "info");
      return;
    }

    // 落库
    const saved = [];
    const saveErrs = [];
    toSave.forEach((c) => {
      try {
        const s = global.WpsAiHtmlComponents.save({
          ...c,
          sourceSlideId: st.id || null,
          docKey: _cachedDocKey || ""
        });
        saved.push(s);
      } catch (e) {
        saveErrs.push(`${c.name}: ${e?.message || e}`);
      }
    });

    if (_galleryActiveTab === "components") renderHtmlTemplateGallery();

    if (saved.length) {
      openExtractedComponentsReview(saved, { dupExisting, dupBatch, saveErrs });
    } else {
      showMessage(`组件全部入库失败：${saveErrs.slice(0, 3).join("；")}`, "error");
    }
  }

  // 「选用组件」按钮：弹窗 + 复选框
  function openComponentsPicker() {
    const overlay = els.htmlPreviewComponentsPicker;
    if (!overlay) return;
    renderComponentPickerList();
    overlay.classList.remove("hidden");
  }
  function closeComponentsPicker() {
    els.htmlPreviewComponentsPicker?.classList.add("hidden");
  }
  function renderComponentPickerList() {
    const host = els.htmlPreviewComponentsList;
    if (!host) return;
    host.innerHTML = "";
    const compStore = global.WpsAiHtmlComponents;
    const items = compStore?.list?.() || [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "component-picker-empty";
      empty.innerHTML = "组件库空空如也。<br>在 freeform 预览底部点「保存为组件」往里加。";
      host.appendChild(empty);
      return;
    }
    const picked = new Set(getPickedComponentIds());
    const palette = currentPaletteForPreview();
    items.forEach((c) => {
      const card = document.createElement("div");
      card.className = "component-picker-item" + (picked.has(c.id) ? " selected" : "");
      // 按组件实际尺寸缩放：用 makeComponentThumbHtml + fitComponentThumb
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "component-picker-item-thumb component-thumb-fit";
      let thumbHtml;
      try { thumbHtml = makeComponentThumbHtml(c, palette); }
      catch (e) { thumbHtml = `<html><body style="padding:20px;font-family:sans-serif;color:#c00;font-size:11px">渲染失败：${e?.message || e}</body></html>`; }
      const ifr = document.createElement("iframe");
      ifr.setAttribute("sandbox", "allow-same-origin");
      try { ifr.srcdoc = thumbHtml; } catch (e) {}
      ifr.addEventListener("load", () => { bridgeEchartsToFrame(ifr); fitComponentThumb(ifr, thumbWrap); });
      thumbWrap.appendChild(ifr);
      card.appendChild(thumbWrap);

      const row1 = document.createElement("div");
      row1.className = "component-picker-item-row1";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = picked.has(c.id);
      cb.dataset.compId = c.id;
      const name = document.createElement("span");
      name.className = "component-picker-item-name";
      name.textContent = c.name || c.id;
      row1.appendChild(cb);
      row1.appendChild(name);
      card.appendChild(row1);
      if (c.description) {
        const desc = document.createElement("div");
        desc.className = "component-picker-item-desc";
        desc.textContent = c.description;
        card.appendChild(desc);
      }
      const meta = document.createElement("div");
      meta.className = "component-picker-item-meta";
      const ts = document.createElement("span");
      ts.textContent = formatHtmlPreviewTs(c.ts);
      meta.appendChild(ts);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "component-picker-item-del";
      delBtn.title = "从组件库删除这条";
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!confirm(`从组件库删除「${c.name}」？此操作不可撤销。`)) return;
        compStore.remove(c.id);
        // 也把所有 slide 对它的引用清掉
        pickedComponentsByKey.forEach((arr, k) => {
          const filtered = arr.filter((x) => x !== c.id);
          if (filtered.length !== arr.length) {
            if (filtered.length) pickedComponentsByKey.set(k, filtered);
            else pickedComponentsByKey.delete(k);
          }
        });
        savePickedComponentsToStorage();
        renderComponentPickerList();
        updatePickedComponentsCountBadge();
      });
      meta.appendChild(delBtn);
      card.appendChild(meta);
      // 点整张卡 = 切换勾选
      card.addEventListener("click", (ev) => {
        if (ev.target === delBtn || delBtn.contains(ev.target)) return;
        cb.checked = !cb.checked;
        card.classList.toggle("selected", cb.checked);
      });
      cb.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", () => {
        card.classList.toggle("selected", cb.checked);
      });
      host.appendChild(card);
    });
  }
  function confirmComponentsPicker() {
    const host = els.htmlPreviewComponentsList;
    if (!host) return;
    const ids = Array.from(host.querySelectorAll('input[type="checkbox"]'))
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.compId)
      .filter(Boolean);
    setPickedComponentIds(ids);
    closeComponentsPicker();
    if (ids.length) {
      showMessage(`已选 ${ids.length} 个组件 —— 下一次美化时 AI 会优先复用它们。`, "info");
    }
  }
  function clearComponentsPicker() {
    const host = els.htmlPreviewComponentsList;
    if (!host) return;
    host.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
      cb.closest(".component-picker-item")?.classList.remove("selected");
    });
  }

  function bindHtmlPreviewModal() {
    if (!els.htmlPreviewModal) return;
    // 幂等守卫：dialog 模式下这个函数会被显式调用一次 + IIFE 末尾 setTimeout 再调一次。
    // 不加 guard 会导致所有 click handler 重复绑定（画廊/历史 toggle 互相抵消、插入/发送触发 2 次）。
    if (bindHtmlPreviewModal._bound) return;
    bindHtmlPreviewModal._bound = true;
    els.htmlPreviewCloseBtn?.addEventListener("click", closeHtmlPreviewModal);
    els.htmlPreviewInsertBtn?.addEventListener("click", confirmHtmlPreviewInsert);
    // 注：「替换第 N 页」按钮已下掉，按当前选中替换走 confirmHtmlPreviewReplaceActive
    els.htmlPreviewReplaceActiveBtn?.addEventListener("click", confirmHtmlPreviewReplaceActive);
    els.htmlPreviewSaveBtn?.addEventListener("click", saveHtmlPreviewToCache);
    // 组件库
    els.htmlPreviewSaveAsCompBtn?.addEventListener("click", openSaveAsComponentDialog);
    els.htmlPreviewSaveAsCompCloseBtn?.addEventListener("click", closeSaveAsComponentDialog);
    els.htmlPreviewSaveAsCompConfirmBtn?.addEventListener("click", confirmSaveAsComponent);
    els.htmlPreviewExtractCompsBtn?.addEventListener("click", extractComponentsFromCurrentSlide);
    // 抽取后的预览/审阅弹窗
    els.htmlPreviewExtractReviewCloseBtn?.addEventListener("click", closeExtractedComponentsReview);
    els.htmlPreviewExtractReviewKeepAllBtn?.addEventListener("click", closeExtractedComponentsReview);
    els.htmlPreviewExtractReviewDiscardBtn?.addEventListener("click", discardUncheckedExtracted);
    els.htmlPreviewExtractReviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewExtractReviewModal) closeExtractedComponentsReview();
    });
    // 编辑模式
    els.htmlPreviewEditModeBtn?.addEventListener("click", toggleEditMode);
    // 撤销 / 重做按钮 + Ctrl+Z / Ctrl+Y 快捷键
    els.htmlPreviewEditUndoBtn?.addEventListener("click", editorUndo);
    els.htmlPreviewEditRedoBtn?.addEventListener("click", editorRedo);
    // 中栏 tab：画布 / 属性 切换
    document.querySelectorAll(".html-preview-center-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchCenterTab(btn.dataset.centerTab));
    });
    // 标尺常开：去掉切换按钮后直接挂上，不再读 localStorage
    applyRulerVisibility(true);
    els.htmlPreviewEditElCloseBtn?.addEventListener("click", editorCloseEditPopup);
    els.htmlPreviewEditElCancelBtn?.addEventListener("click", editorCloseEditPopup);
    els.htmlPreviewEditElApplyBtn?.addEventListener("click", editorApplyEditPopup);
    els.htmlPreviewEditElModal?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewEditElModal) editorCloseEditPopup();
    });
    els.htmlPreviewSaveAsCompModal?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewSaveAsCompModal) closeSaveAsComponentDialog();
    });
    els.htmlPreviewPickComponentsBtn?.addEventListener("click", openComponentsPicker);
    els.htmlPreviewPickComponentsCloseBtn?.addEventListener("click", closeComponentsPicker);
    els.htmlPreviewPickComponentsConfirmBtn?.addEventListener("click", confirmComponentsPicker);
    els.htmlPreviewPickComponentsClearBtn?.addEventListener("click", clearComponentsPicker);
    els.htmlPreviewComponentsPicker?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewComponentsPicker) closeComponentsPicker();
    });
    // chat 工具栏的「画廊」按钮：现在 = 打开预览 modal（画廊在 modal 内左侧永久可见）
    els.chatHtmlGalleryBtn?.addEventListener("click", () => {
      openHtmlPreviewModal({});
    });
    // 画廊里直接清空缓存历史：清完就地刷新，「我的历史」区块立刻消失。
    // 一次清不干净（某些 WebView 的 localStorage 写入异步/竞争）就最多重试 3 次。
    // tab 切换：我的历史 / 模板（事件委托到侧栏 head）
    document.querySelectorAll(".gallery-tab").forEach((btn) => {
      btn.addEventListener("click", () => setGalleryTab(btn.dataset.galleryTab));
    });
    // 侧栏底部「清空所有」按钮（按当前 tab 决定清谁）
    els.htmlTemplateGalleryClearBtn?.addEventListener("click", clearGalleryActiveTab);
    // chat 双 tab 切换（美化当前 / 统一修改）
    document.querySelectorAll(".preview-chat-tab").forEach((btn) => {
      btn.addEventListener("click", () => setPreviewChatTab(btn.dataset.chatTab));
    });
    // modal 内 chat 输入
    els.htmlPreviewChatSendBtn?.addEventListener("click", submitHtmlPreviewChat);
    els.htmlPreviewChatInput?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.shiftKey) return;
      ev.preventDefault();
      submitHtmlPreviewChat();
    });
    // 统一修改 chat 输入
    els.htmlPreviewUnifiedSendBtn?.addEventListener("click", submitUnifiedModifyChat);
    els.htmlPreviewUnifiedInput?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.shiftKey) return;
      ev.preventDefault();
      submitUnifiedModifyChat();
    });
    els.htmlPreviewUnifiedInput?.addEventListener("paste", (ev) => {
      const txt = ev.clipboardData?.getData("text") || "";
      if (!txt) return;
      ev.preventDefault();
      insertAtCursor(ev.currentTarget, txt);
    });
    // 启动时回放统一修改 chat
    renderUnifiedChatLogFromStore();
    // 显式 paste 处理：WPS Application.ShowDialog 开的独立 WebView 里，textarea 默认 paste
    // 在部分版本有 bug（剪贴板内容进不来）。手动从 clipboardData 取文本插入到光标位置。
    els.htmlPreviewChatInput?.addEventListener("paste", (ev) => {
      const txt = ev.clipboardData?.getData("text") || "";
      if (!txt) return; // 没拿到文本就让默认行为继续（兜底）
      ev.preventDefault();
      insertAtCursor(ev.currentTarget, txt);
    });
    els.htmlPreviewChatClearBtn?.addEventListener("click", () => {
      // 清当前 active tab 的对话日志
      if (_previewChatActiveTab === "unified") clearUnifiedChatLog();
      else clearPreviewChatLog();
    });
    els.htmlPreviewHistoryBtn?.addEventListener("click", () => {
      const isShown = !els.htmlPreviewHistoryPanel?.classList.contains("hidden");
      toggleHtmlPreviewHistoryPanel(!isShown);
    });
    els.htmlPreviewHistoryCloseBtn?.addEventListener("click", () => toggleHtmlPreviewHistoryPanel(false));
    els.htmlPreviewHistoryClearBtn?.addEventListener("click", () => {
      if (!confirm("清空所有 HTML 模板缓存记录？此操作不可撤销。")) return;
      if (htmlPreviewState?.id) htmlPreviewState.id = null;
      let tries = 0;
      while (tries < 3) {
        global.WpsAiHtmlCache?.clear?.();
        const remaining = global.WpsAiHtmlCache?.list?.() || [];
        if (!remaining.length) break;
        tries += 1;
      }
      renderHtmlPreviewHistory();
      updateHtmlPreviewHistoryBadge();
      // 画廊里有「我的历史」区块，缓存清了也要刷一遍把那些缩略图去掉
      if (els.htmlTemplateGallery && !els.htmlTemplateGallery.classList.contains("hidden")) {
        renderHtmlTemplateGallery();
      }
    });
  }

  // 暴露给工具调用方：global.WpsAiHtmlPreview.open(opts) / getState() / ...
  // ===== 撤销 wpp_render_full_deck 批量插入 =====
  // 按 batchTag 一键删除：① 所有打了同 tag 的 WPS slide ② 缓存里所有同 tag 的 entry
  async function undoFullDeckBatch(batchTag) {
    if (!batchTag) return { ok: false, message: "batchTag 不能为空" };
    const app = global.WpsAiAddon?.getApplicationSync?.();
    const pres = app?.ActivePresentation;
    if (!pres) return { ok: false, message: "拿不到 ActivePresentation" };
    let removedSlides = 0;
    // 倒序删 slide（删 i 后 i+1...n 的 SlideIndex 全部 -1，正序删会跳过）
    try {
      const total = pres.Slides?.Count || 0;
      for (let i = total; i >= 1; i -= 1) {
        try {
          const slide = pres.Slides.Item(i);
          const tag = slide?.Tags?.Item?.("LingxiBatch");
          if (tag === batchTag) {
            slide.Delete();
            removedSlides += 1;
          }
        } catch (e) { /* 单页失败继续 */ }
      }
    } catch (e) {
      console.warn("[undoBatch] 遍历 slide 失败:", e?.message || e);
    }
    // 删缓存里同 tag 的所有 entry
    let removedCacheCount = 0;
    try { removedCacheCount = global.WpsAiHtmlCache?.removeBatch?.(batchTag) || 0; } catch (e) {}
    // 刷画廊（如果预览开着的话）
    try { renderHtmlTemplateGallery(); } catch (e) {}
    try { updateHtmlPreviewHistoryBadge?.(); } catch (e) {}
    return {
      ok: true,
      batchTag,
      removedSlides,
      removedCacheCount,
      message: `已撤销批量插入：删 ${removedSlides} 张 PPT 幻灯片、${removedCacheCount} 条缓存。`
    };
  }

  global.WpsAiHtmlPreview = {
    open: openHtmlPreviewModal,
    close: closeHtmlPreviewModal,
    isOpen: () => !els.htmlPreviewModal?.classList.contains("hidden"),
    // 暴露当前 state 的浅快照（系统 prompt 用，注意不暴露 onConfirm 等内部回调）
    getState: () => {
      const open = !els.htmlPreviewModal?.classList.contains("hidden");
      if (!open || !htmlPreviewState) return null;
      return {
        templateName: htmlPreviewState.templateName,
        layout: htmlPreviewState.layout,
        data: Object.assign({}, htmlPreviewState.data || {}),
        palette: Object.assign({}, htmlPreviewState.palette || {}),
        slideHint: htmlPreviewState.slideHint
      };
    },
    // 撤销 wpp_render_full_deck 批量插入（按 batchTag 删 slide + cache）。供 AI 工具回调 / 用户控制台直调
    undoBatch: undoFullDeckBatch,
    // 列出所有可撤销的 batch（最近优先）：调试 / 后续做 UI 列表
    listBatches: () => global.WpsAiHtmlCache?.listBatches?.() || []
  };

  // 启动时把绑定注册一次（必须在 bindElements 之后）。
  // 通过 DOMContentLoaded 兜底：如果 bindElements 已跑过就直接调；否则等 DOM ready 再调。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(bindHtmlPreviewModal, 0));
  } else {
    setTimeout(bindHtmlPreviewModal, 0);
  }
})(window);
