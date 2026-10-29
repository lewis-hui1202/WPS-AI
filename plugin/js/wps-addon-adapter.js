(function attachWpsAddonAdapter(global) {
  "use strict";

  const PREVIEW_LOG_KEY = "lingxi_preview_log_v1";
  const CONSOLE_BRIDGE_KEY = "lingxi_console_bridge_v1";

  function getLogStore() {
    return global.WpsAiStore || global.localStorage || null;
  }

  function installLogConsoleHelpers() {
    if (typeof global.__lingxiDumpLogs !== "function") {
      global.__lingxiDumpLogs = function () {
        try {
          const store = getLogStore();
          const raw = store?.getItem?.(PREVIEW_LOG_KEY);
          const list = raw ? (JSON.parse(raw) || []) : [];
          const text = list.map((e) => {
            const t = new Date(e.ts).toISOString().slice(11, 23);
            return `${t} [${e.level}][${e.where}][${e.tag}] ${e.msg}`;
          }).join("\n");
          console.log(text || "(no logs)");
          return text;
        } catch (e) {
          console.warn("dump failed:", e);
          return "";
        }
      };
    }
    if (typeof global.__lingxiClearLogs !== "function") {
      global.__lingxiClearLogs = function () {
        try {
          const store = getLogStore();
          store?.removeItem?.(PREVIEW_LOG_KEY);
          console.log("logs cleared");
        } catch (e) {
          console.warn("clear failed:", e);
        }
      };
    }
    if (typeof global.__lingxiCopyLogs !== "function") {
      global.__lingxiCopyLogs = async function () {
        const text = global.__lingxiDumpLogs?.() || "";
        try {
          if (global.navigator?.clipboard?.writeText) {
            await global.navigator.clipboard.writeText(text);
            console.log("logs copied to clipboard (" + text.length + " chars)");
          }
        } catch (e) {
          console.warn("copy failed:", e);
        }
        return text;
      };
    }
    if (typeof global.__lingxiDumpBridge !== "function") {
      global.__lingxiDumpBridge = function () {
        try {
          const store = getLogStore();
          const raw = store?.getItem?.(CONSOLE_BRIDGE_KEY) || "";
          console.log(raw || "(no bridge log)");
          return raw;
        } catch (e) {
          console.warn("dump bridge failed:", e);
          return "";
        }
      };
    }
  }

  installLogConsoleHelpers();

  function installConsoleBridgeListener() {
    const seen = new Set();
    let lastRaw = "";
    const printBridge = (raw) => {
      if (!raw) return;
      if (raw === lastRaw) return;
      lastRaw = raw;
      try {
        const entry = JSON.parse(raw);
        if (!entry?.id || seen.has(entry.id)) return;
        seen.add(entry.id);
        if (seen.size > 200) {
          const first = seen.values().next().value;
          seen.delete(first);
        }
        console.log(`[lingxi-bridge][${entry.kind || "log"}]`, entry.payload || {});
      } catch (e) {}
    };
    try {
      const store = getLogStore();
      printBridge(store?.getItem?.(CONSOLE_BRIDGE_KEY));
    } catch (e) {}
    try {
      global.addEventListener?.("storage", (ev) => {
        if (ev?.key === CONSOLE_BRIDGE_KEY) printBridge(ev.newValue);
      });
    } catch (e) {}
    try {
      global.setInterval?.(() => {
        try {
          const store = getLogStore();
          printBridge(store?.getItem?.(CONSOLE_BRIDGE_KEY));
        } catch (e) {}
      }, 500);
    } catch (e) {}
  }

  installConsoleBridgeListener();

  // 存储 TaskPane id 的 PluginStorage 键名。
  // 后缀 _v11：v10 的 80%/[1200,2200] 视觉上确实生效到 965（WPS docked 天花板），
  // 但用户反馈太宽，砍一半到 40%/[600,1100]（即 v9 参数集）。
  // bump 后强制 WPS 下次重建 pane 拿新宽度。
  const TASKPANE_STORAGE_KEY = "lingxi_ai_taskpane_id_v11";

  // 默认 TaskPane 宽度 —— 按当前显示器 40% 自适应：
  //   - 40% 屏幕宽
  //   - 最少 600（笔记本 1366px 屏上保证 header 不被压惨；窄场景靠 CSS @media 适配）
  //   - 最多 1100（4K 屏上再宽就压文档可视区）
  // 常见屏幕对应宽度：1366→600 / 1440→600 / 1920→768 / 2560→1024 / 3840→1100
  // WPS docked 内部上限约 50% 主窗口宽，所以 1920 屏上 768 不会被 clamp，正好生效
  function pickDefaultTaskPaneWidth() {
    const sw = (global.screen && (global.screen.availWidth || global.screen.width)) || 1920;
    return Math.max(600, Math.min(1100, Math.round(sw * 0.4)));
  }

  // 设置 TaskPane 宽度。
  //
  // 观察：用户报告"点完模板画廊（一次 ShowDialog modal）后 pane 变宽了"。
  // 推断：ShowDialog 关闭时 WPS 主窗口会做一次 re-layout，那次 re-layout 它
  // 会重新读 pane.Width 属性应用上去。所以光是首次 set pane.Width 没用，
  // 缺一次"触发 layout"的契机。
  //
  // 现在策略：
  //   1) 立即写一次（多数版本会被 clamp）
  //   2) 50/200/500/1500ms 各重写一次（碰碰运气，部分版本第 N 次会接受）
  //   3) 1000ms 时调一次轻量"无窗 dialog"或回退到 DockPosition 切换，强行触发
  //      WPS re-layout 让属性值生效（如果 ShowDialog 有副作用就用它，没有就用切 dock）
  function applyTaskPaneWidth(pane, width, tag) {
    if (!pane) return;
    const setOnce = (label) => {
      try {
        if ("Width" in pane) {
          pane.Width = width;
          let actual = "n/a";
          try { actual = pane.Width; } catch (e) {}
          console.log(`[wps-ai] (${tag}/${label}) Width=${width} → 读回 ${actual}`);
          return;
        }
      } catch (e) {
        console.warn(`[wps-ai] (${tag}/${label}) 设 Width 失败:`, e?.message || e);
      }
      if (typeof pane.SetWidth === "function") {
        try { pane.SetWidth(width); } catch (e) {}
      }
    };
    setOnce("t0");
    setTimeout(() => setOnce("t+50"), 50);
    setTimeout(() => setOnce("t+200"), 200);
    setTimeout(() => {
      setOnce("t+500");
      // 主动触发一次 WPS layout —— DockPosition 切到同一值，部分版本会重读 Width 属性
      try {
        const cur = pane.DockPosition;
        pane.DockPosition = cur; // 重新赋同值，触发 setter side effect
      } catch (e) {}
      setOnce("after-layout-poke");
    }, 500);
    setTimeout(() => setOnce("t+1500"), 1500);
  }
  // ribbon 点击的快捷指令通过这个 key 传给 taskpane 消费
  const PENDING_ACTION_KEY = "lingxi_ai_pending_action";
  const PARALLEL_TRANSLATE_DIALOG_REQUEST_KEY = "lingxi_parallel_translate_dialog_request_v1";

  function detectHostByApp(app) {
    if (!app) return "unknown";
    // PDF 在 wps 兜底前先判，否则 ActiveDocument 兜底会把 PDF 误判成 wps
    try { if (app.ActivePDF) return "pdf"; } catch (e) {}
    try { if (app.ActivePdf) return "pdf"; } catch (e) {}
    try { if (app.ActivePDFDocument) return "pdf"; } catch (e) {}
    try { if (app.ActiveWorkbook) return "et"; } catch (e) {}
    try { if (app.ActivePresentation) return "wpp"; } catch (e) {}
    try { if (app.ActiveDocument) return "wps"; } catch (e) {}
    try { if (app.Workbooks) return "et"; } catch (e) {}
    try { if (app.Presentations) return "wpp"; } catch (e) {}
    try { if (app.Documents) return "wps"; } catch (e) {}
    return "unknown";
  }

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function pickString(value) {
    return (typeof value === "string" && value.trim()) ? value.trim() : "";
  }

  function isThenable(value) {
    return value && typeof value.then === "function";
  }

  async function resolveMaybe(value) {
    return isThenable(value) ? await value : value;
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

  function normalizeMaybeFileUrl(raw) {
    let value = pickString(raw);
    if (!value) return "";
    if (!/^file:\/\//i.test(value)) return value;
    try {
      const url = new URL(value);
      let pathname = decodeURIComponent(url.pathname || "");
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
      return pathname || value;
    } catch (e) {
      return value.replace(/^file:\/\//i, "");
    }
  }

  const PDF_DOC_KEYS = [
    "ActivePDF", "ActivePdf", "ActivePDFDocument", "ActivePdfDoc",
    "ActiveDocument", "Document", "PDF", "Pdf"
  ];
  const PDF_PATH_KEYS = [
    "FullName", "FullPath", "FilePath", "DocumentPath", "LocalPath",
    "Path", "FolderPath", "Directory", "Dir", "Url", "URL", "Location",
    "SourceFullName", "SourcePath", "FileName", "Name", "Title"
  ];
  const PDF_PATH_METHODS = [
    "GetFullName", "GetFullPath", "GetFilePath", "GetDocumentPath",
    "GetLocalPath", "GetPath", "GetFileName", "GetName", "GetTitle"
  ];
  const PDF_BUILTIN_PROPS = [
    "FullName", "FullPath", "FilePath", "DocumentPath", "Path",
    "FileName", "Name", "Title", "Subject"
  ];

  function isAbsoluteLikePath(value) {
    return /^file:\/\//i.test(value)
      || value.startsWith("/")
      || /^[A-Za-z]:[\\/]/.test(value)
      || /^\\\\/.test(value);
  }

  function joinPathLike(dir, name) {
    const d = pickString(dir);
    const n = pickString(name);
    if (!d || !n) return "";
    if (!isAbsoluteLikePath(d)) return "";
    const sep = d.includes("\\") ? "\\" : "/";
    return d.replace(/[\\/]+$/, "") + sep + n.replace(/^[\\/]+/, "");
  }

  function normalizePdfPathCandidate(raw, carrier) {
    let value = normalizeMaybeFileUrl(raw);
    if (!value) return "";
    if (isAbsoluteLikePath(value) && /\.pdf(?:$|[?#])/i.test(value)) return value;
    const looksLikeDir = isAbsoluteLikePath(value) && (/[\\/]$/.test(value) || !/\.[a-zA-Z0-9]{1,8}$/.test(value));
    if (looksLikeDir && carrier) {
      const name = pickString(carrier.Name) || pickString(carrier.FileName) || pickString(carrier.Title);
      const joined = joinPathLike(value, name);
      if (/\.pdf(?:$|[?#])/i.test(joined)) return joined;
    }
    return "";
  }

  function getActivePdfDocFromApp(app) {
    if (!app) return null;
    for (const key of PDF_DOC_KEYS.slice(0, 4)) {
      try { if (app[key]) return app[key]; } catch (e) {}
    }
    return null;
  }

  async function getActivePdfDocFromAppAsync(app) {
    if (!app) return null;
    for (const key of PDF_DOC_KEYS) {
      try {
        const value = await resolveMaybe(app[key]);
        if (value) return value;
      } catch (e) {}
    }
    try {
      const win = await resolveMaybe(app.ActiveWindow);
      if (win) {
        for (const key of PDF_DOC_KEYS) {
          try {
            const value = await resolveMaybe(win[key]);
            if (value) return value;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return null;
  }

  async function readPdfPathFromCarrier(carrier) {
    if (!carrier) return "";
    for (const key of PDF_PATH_KEYS) {
      try {
        const path = normalizePdfPathCandidate(await resolveMaybe(carrier[key]), carrier);
        if (path) return path;
      } catch (e) {}
    }
    const pathPart = (() => {
      for (const key of ["Path", "DocumentPath", "FolderPath", "Directory", "Dir"]) {
        try {
          const value = normalizeMaybeFileUrl(pickString(carrier[key]));
          if (value) return value;
        } catch (e) {}
      }
      return "";
    })();
    const namePart = (() => {
      for (const key of ["Name", "FileName", "Title"]) {
        try {
          const value = pickString(carrier[key]);
          if (value) return value;
        } catch (e) {}
      }
      return "";
    })();
    const joined = joinPathLike(pathPart, namePart);
    if (/\.pdf(?:$|[?#])/i.test(joined)) return joined;

    for (const key of PDF_PATH_METHODS) {
      try {
        const fn = carrier[key];
        if (typeof fn !== "function") continue;
        const path = normalizePdfPathCandidate(await resolveMaybe(fn.call(carrier)), carrier);
        if (path) return path;
      } catch (e) {}
    }
    try {
      const fn = carrier.BuiltinDocumentProperties;
      if (typeof fn === "function") {
        for (const name of PDF_BUILTIN_PROPS) {
          try {
            const prop = await resolveMaybe(fn.call(carrier, name));
            const raw = prop && typeof prop === "object" ? prop.Value : prop;
            const path = normalizePdfPathCandidate(await resolveMaybe(raw), carrier);
            if (path) return path;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return "";
  }

  function getActivePdfPathFromApp(app) {
    const pdf = getActivePdfDocFromApp(app);
    if (!pdf) return "";
    const direct = normalizePdfPathCandidate(
      pickString(pdf.FullName)
      || pickString(pdf.FullPath)
      || pickString(pdf.FilePath)
      || pickString(pdf.DocumentPath)
      || pickString(pdf.Path),
      pdf
    );
    if (direct) return direct;
    const joined = joinPathLike(pickString(pdf.Path) || pickString(pdf.DocumentPath) || pickString(pdf.FolderPath), pickString(pdf.Name) || pickString(pdf.FileName) || pickString(pdf.Title));
    return /\.pdf(?:$|[?#])/i.test(joined) ? joined : "";
  }

  async function getActivePdfPathFromAppAsync(app) {
    const resolvedApp = await resolveMaybe(app || getApplicationSync());
    const pdf = await getActivePdfDocFromAppAsync(resolvedApp);
    return await readPdfPathFromCarrier(pdf) || await readPdfPathFromCarrier(resolvedApp);
  }

  async function resolvePdfPathForRibbon(app, hint, timeoutMs) {
    const hinted = pickString(hint);
    if (hinted && /\.pdf(?:$|[?#])/i.test(hinted)) return hinted;
    const resolvedApp = await resolveMaybe(app || getApplicationSync() || getApplication());
    let path = await withTimeout(getActivePdfPathFromAppAsync(resolvedApp), timeoutMs || 900, "");
    if (!path) {
      path = await withTimeout(global.WpsAiHostPdf?.getActivePdfPath?.(), timeoutMs || 900, "");
    }
    if (!path) {
      path = await withTimeout(fetchActivePdfPathFromProxy(), timeoutMs || 900, "");
    }
    return pickString(path);
  }

  async function fetchActivePdfPathFromProxy() {
    try {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const resp = await fetch(base + "/active-pdf-path", { method: "GET", cache: "no-store" });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) return "";
      return pickString(payload.path);
    } catch (e) {
      return "";
    }
  }

  function getPdfPathDebugFromApp(app) {
    const pdf = getActivePdfDocFromApp(app);
    const fields = {};
    if (pdf) {
      PDF_PATH_KEYS.forEach((key) => {
        try { fields[key] = pickString(pdf[key]); } catch (e) { fields[key] = `[throw:${e?.message || e}]`; }
      });
    }
    return {
      hasApp: !!app,
      host: detectHostByApp(app),
      hasPdf: !!pdf,
      fields
    };
  }

  function summarizeProbeValue(value) {
    if (value == null) return value;
    if (isThenable(value)) return "[Promise]";
    const type = typeof value;
    if (type === "string") return value.length > 240 ? value.slice(0, 240) + "..." : value;
    if (type === "number" || type === "boolean") return value;
    if (type === "function") return "[Function]";
    try {
      const tag = Object.prototype.toString.call(value);
      return tag || "[Object]";
    } catch (e) {
      return "[Object]";
    }
  }

  async function collectProbeFields(obj, keys) {
    const out = {};
    if (!obj) return out;
    for (const key of keys) {
      try {
        out[key] = summarizeProbeValue(await resolveMaybe(obj[key]));
      } catch (e) {
        out[key] = `[throw:${e?.message || e}]`;
      }
    }
    return out;
  }

  async function probePdfPath(appArg) {
    const app = await resolveMaybe(appArg || getApplicationSync() || getApplication());
    const pdf = await getActivePdfDocFromAppAsync(app);
    const builtin = {};
    if (pdf && typeof pdf.BuiltinDocumentProperties === "function") {
      for (const name of PDF_BUILTIN_PROPS) {
        try {
          const prop = await resolveMaybe(pdf.BuiltinDocumentProperties(name));
          const value = prop && typeof prop === "object" ? await resolveMaybe(prop.Value) : prop;
          builtin[name] = summarizeProbeValue(value);
        } catch (e) {
          builtin[name] = `[throw:${e?.message || e}]`;
        }
      }
    }
    const result = {
      hasApp: !!app,
      host: detectHostByApp(app),
      hasPdf: !!pdf,
      resolvedPath: await getActivePdfPathFromAppAsync(app),
      appFields: await collectProbeFields(app, ["ActivePDF", "ActivePdf", "ActivePDFDocument", "ActivePdfDoc", "ActiveDocument", "ActiveWindow", "Documents", "PDFDocuments", "PdfDocuments", "Windows"]),
      pdfFields: await collectProbeFields(pdf, PDF_PATH_KEYS.concat(["PagesCount", "CurrentPage", "ReadOnly"])),
      builtin
    };
    debugLog("pdfPath.probe", result);
    traceStatic("adapter.pdfPath.probe", result.resolvedPath || JSON.stringify({ host: result.host, hasPdf: result.hasPdf }));
    return result;
  }

  function getRibbonControlId(control) {
    if (typeof control === "string") return control;
    const keys = ["Id", "id", "ID", "Name", "name"];
    for (const key of keys) {
      try {
        let value = control?.[key];
        if (typeof value === "function") value = value.call(control);
        if (value != null && value !== "") return String(value);
      } catch (e) {}
    }
    return "";
  }
  global.__lingxiGetRibbonControlId = getRibbonControlId;

  function getApplicationSync() {
    const candidates = [];
    const push = (label, getter) => {
      try {
        const app = getter();
        if (app) candidates.push({ label, app });
      } catch (e) {}
    };
    push("Application", () => global.Application);
    push("wps.WpsApplication", () => typeof global.wps?.WpsApplication === "function" ? global.wps.WpsApplication() : null);
    push("wps.EtApplication", () => typeof global.wps?.EtApplication === "function" ? global.wps.EtApplication() : null);
    push("wps.WppApplication", () => typeof global.wps?.WppApplication === "function" ? global.wps.WppApplication() : null);
    push("wps.PdfApplication", () => typeof global.wps?.PdfApplication === "function" ? global.wps.PdfApplication() : null);
    push("wps.PDFApplication", () => typeof global.wps?.PDFApplication === "function" ? global.wps.PDFApplication() : null);
    push("wps.KPdfApplication", () => typeof global.wps?.KPdfApplication === "function" ? global.wps.KPdfApplication() : null);
    push("wps.KpdfApplication", () => typeof global.wps?.KpdfApplication === "function" ? global.wps.KpdfApplication() : null);
    push("pdf.Application", () => global.pdf?.Application);
    push("kpdf.Application", () => global.kpdf?.Application);
    push("wps.Application", () => global.wps?.Application);
    for (const item of candidates) {
      if (detectHostByApp(item.app) !== "unknown") return item.app;
    }
    return candidates[0]?.app || null;
  }

  async function getAddonApi() {
    if (typeof global.wps?.WpsApplication === "function") {
      return null;
    }
    const api = global.jssdk?.api || null;
    if (!api) {
      return null;
    }
    if (typeof api.ready === "function") {
      await api.ready();
    }
    return api;
  }

  async function getApplication() {
    const sync = getApplicationSync();
    if (sync) {
      return sync;
    }
    const api = await getAddonApi();
    if (api?.Application) {
      return api.Application;
    }
    return null;
  }

  function getUrlPath() {
    let url = decodeURI(document.location.toString());
    if (url.includes("/")) {
      url = url.substring(0, url.lastIndexOf("/"));
    }
    return url;
  }

  function traceStatic(event, data) {
    try {
      if (typeof global.__lingxiTraceStatic === "function") {
        global.__lingxiTraceStatic(event, data);
        return;
      }
      const img = new Image();
      img.src = `${getUrlPath()}/__lingxi_trace__.gif?event=${encodeURIComponent(event || "")}&data=${encodeURIComponent(data == null ? "" : String(data))}&ts=${Date.now()}`;
    } catch (error) {}
  }

  function debugLog(message, data) {
    try {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const payload = JSON.stringify({
        tag: "wps-addon-adapter",
        message,
        data: data == null ? null : data
      });
      if (global.navigator?.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        global.navigator.sendBeacon(base + "/debug-log", blob);
        return;
      }
      fetch(base + "/debug-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(() => {});
    } catch (error) {}
  }

  function readStorageItem(app, key) {
    try {
      return app?.PluginStorage?.getItem?.(key) || null;
    } catch (error) {
      return null;
    }
  }

  function writeStorageItem(app, key, value) {
    try {
      app?.PluginStorage?.setItem?.(key, value);
    } catch (error) {
      // PluginStorage 不可用时静默忽略
    }
  }

  function clearStorageItem(app, key) {
    try {
      app?.PluginStorage?.removeItem?.(key);
    } catch (error) {
      // 部分版本没有 removeItem，回写空串保持兼容
      writeStorageItem(app, key, "");
    }
  }

  function getTaskPaneHost(app) {
    if (app && (typeof app.CreateTaskPane === "function" || typeof app.CreateTaskpane === "function")) return app;
    const wpsObj = global.wps;
    if (wpsObj && (typeof wpsObj.CreateTaskPane === "function" || typeof wpsObj.CreateTaskpane === "function")) return wpsObj;
    return app || wpsObj || null;
  }

  function createTaskPaneViaHost(host, url) {
    if (!host) return null;
    if (typeof host.CreateTaskPane === "function") return host.CreateTaskPane(url);
    if (typeof host.CreateTaskpane === "function") return host.CreateTaskpane(url);
    return null;
  }

  function getTaskPaneById(host, id) {
    if (!host || !id) return null;
    if (typeof host.GetTaskPane === "function") return host.GetTaskPane(id);
    if (typeof host.GetTaskpane === "function") return host.GetTaskpane(id);
    return null;
  }

  function getTaskPaneEnumHost(app, taskPaneHost) {
    return app?.Enum || taskPaneHost?.Enum || global.wps?.Enum || null;
  }

  // 上一代 storage key（按 TASKPANE_STORAGE_KEY 后缀往前推）。
  // 每次 bump v 后顺手把老 key 对应的 pane 删掉，避免老 pane 用旧宽度还活着。
  const LEGACY_TASKPANE_KEYS = [
    "lingxi_ai_taskpane_id_v10",
    "lingxi_ai_taskpane_id_v9",
    "lingxi_ai_taskpane_id_v8",
    "lingxi_ai_taskpane_id_v7",
    "lingxi_ai_taskpane_id_v6",
    "lingxi_ai_taskpane_id_v5",
    "lingxi_ai_taskpane_id_v4",
    "lingxi_ai_taskpane_id_v3",
    "lingxi_ai_taskpane_id_v2",
    "lingxi_ai_taskpane_id"
  ];

  function cleanupLegacyTaskPanes(app) {
    if (!app || typeof app.GetTaskPane !== "function") return;
    LEGACY_TASKPANE_KEYS.forEach((key) => {
      try {
        const oldId = readStorageItem(app, key);
        if (!oldId) return;
        let oldPane = null;
        try { oldPane = app.GetTaskPane(oldId); } catch (e) {}
        if (oldPane && typeof oldPane.Delete === "function") {
          try {
            oldPane.Delete();
            console.log(`[wps-ai] 清掉孤儿老 pane (${key}=${oldId})`);
          } catch (e) {}
        } else if (oldPane && typeof oldPane.Visible === "boolean") {
          // Delete 不可用时退而求其次：藏起来
          try { oldPane.Visible = false; } catch (e) {}
        }
        clearStorageItem(app, key);
      } catch (e) { /* ignore */ }
    });
  }

  /**
   * 优先使用 CreateTaskPane 在 WPS 内部嵌入面板；不可用时回退到 ShowDialog 弹窗。
   * 二次点击 Ribbon 按钮时切换显隐，而不是重复创建。
   */
  // 判断当前活动文档是不是已保存到磁盘且没有脏改动。
  // 给 ribbon "打开文小舟" 按钮做开 pane 前的早判断；不依赖 TaskPane 是否已经加载。
  // wps/wpp/et 才查；PDF / 没文档识别一律放行。
  function checkActiveDocSavedForAdapter(app) {
    try {
      const host = detectHostByApp(app);
      if (!host || !["wps", "wpp", "et"].includes(host)) return { ok: true };
      let doc = null;
      try {
        if (host === "wps") doc = app.ActiveDocument;
        else if (host === "wpp") doc = app.ActivePresentation;
        else if (host === "et") doc = app.ActiveWorkbook;
      } catch (e) { doc = null; }
      if (!doc) return { ok: true }; // 没识别到活动文档就别拦
      let fullName = "";
      try { fullName = String(doc.FullName || ""); } catch (e) { fullName = ""; }
      let path = "";
      try { path = String(doc.Path || ""); } catch (e) { path = ""; }
      const hasPath = /[/\\]/.test(fullName) || fullName.startsWith("/") || /^[A-Za-z]:/.test(fullName)
        || /[/\\]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path);
      if (!hasPath) {
        return {
          ok: false,
          hint: "当前文档还没保存到磁盘（临时文档）。请先另存为本地文件（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），再打开文小舟。"
        };
      }
      let savedAttr = null;
      try { savedAttr = doc.Saved; } catch (e) { savedAttr = null; }
      if (savedAttr === false) {
        return {
          ok: false,
          hint: "当前文档有未保存的修改。请先保存（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），再打开文小舟（保存后改动才能纳入备份/回滚记录）。"
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: true }; // 探测失败兜底放行
    }
  }

  function toggleTaskPaneWithApp(app) {
    const url = `${getUrlPath()}/taskpane.html`;
    const taskPaneHost = getTaskPaneHost(app);
    traceStatic("adapter.toggleTaskPane.enter", detectHostByApp(app));
    debugLog("toggleTaskPane.enter", {
      url,
      hasApp: !!app,
      hasCreateTaskPane: !!taskPaneHost && (typeof taskPaneHost.CreateTaskPane === "function" || typeof taskPaneHost.CreateTaskpane === "function"),
      taskPaneHost: taskPaneHost === app ? "app" : (taskPaneHost === global.wps ? "wps" : typeof taskPaneHost),
      host: detectHostByApp(app)
    });

    if (taskPaneHost) {
      try {
        const storageHost = app || taskPaneHost;
        const existingId = readStorageItem(storageHost, TASKPANE_STORAGE_KEY);
        let pane = null;

        if (existingId) {
          try {
            pane = getTaskPaneById(taskPaneHost, existingId);
          } catch (error) {
            pane = null;
          }
        }

        if (pane && typeof pane.Visible === "boolean") {
          const wantShow = !pane.Visible;
          // 只在"打开"方向做保存校验；"关闭"方向永远放行
          if (wantShow) {
            const chk = checkActiveDocSavedForAdapter(app);
            if (!chk.ok) {
              debugLog("toggleTaskPane.blocked.unsaved", { existingId, hint: chk.hint });
              try { alert(chk.hint); } catch (e) {}
              return true;
            }
          }
          pane.Visible = wantShow;
          // 每次"显示"时把默认宽度重新写一遍 —— dev 改 pickDefaultTaskPaneWidth 后立刻
          // 生效；生产用户手动 resize 后下次开会被重置，但开发体验优先。
          if (wantShow) {
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "toggle-reshow"); } catch (e) {}
          }
          traceStatic("adapter.toggleTaskPane.reuse", `${existingId || ""}:${wantShow}`);
          debugLog("toggleTaskPane.reuse", {
            existingId,
            visible: pane.Visible,
            wantShow
          });
          return true;
        }

        // 首次创建 pane 也是"打开"方向，同样做保存校验
        const chkCreate = checkActiveDocSavedForAdapter(app);
        if (!chkCreate.ok) {
          debugLog("toggleTaskPane.blocked.create-unsaved", { hint: chkCreate.hint });
          try { alert(chkCreate.hint); } catch (e) {}
          return true;
        }

        // 新 v key 下没找到 pane（首次创建 / 版本 bump 后） → 先清扫历史 v key 下的孤儿 pane
        cleanupLegacyTaskPanes(storageHost);

        // 尝试按照官方最简形式创建
        pane = createTaskPaneViaHost(taskPaneHost, url);
        if (!pane) {
          throw new Error("CreateTaskPane 返回空对象");
        }
        if (pane.ID != null) {
          writeStorageItem(storageHost, TASKPANE_STORAGE_KEY, String(pane.ID));
        }
        
        // msoCTPDockPositionRight 枚举值通常是 2
        try {
          const enumHost = getTaskPaneEnumHost(app, taskPaneHost);
          if (enumHost && enumHost.msoCTPDockPositionRight !== undefined) {
             pane.DockPosition = enumHost.msoCTPDockPositionRight;
          } else {
             pane.DockPosition = 2; 
          }
        } catch (e) {}

        // 设置一次初始宽度即可，去掉延迟覆盖等花式操作，避免干扰原生渲染
        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "creation");
        
        pane.Visible = true;
        traceStatic("adapter.toggleTaskPane.created", pane.ID != null ? String(pane.ID) : "no-id");
        debugLog("toggleTaskPane.created", {
          paneId: pane.ID != null ? String(pane.ID) : "",
          visible: pane.Visible
        });
        return true;
      } catch (error) {
        console.warn("[wps-ai] CreateTaskPane 失败，回退到 ShowDialog：", error);
        traceStatic("adapter.toggleTaskPane.create-failed", error?.message || String(error));
        debugLog("toggleTaskPane.create-failed", {
          message: error?.message || String(error)
        });
        clearStorageItem(app || taskPaneHost, TASKPANE_STORAGE_KEY);
      }
    }

    traceStatic("adapter.toggleTaskPane.fallback-dialog", url);
    debugLog("toggleTaskPane.fallback-dialog", { url });
    return openTaskPaneAsDialogWithApp(app);
  }

  function toggleTaskPane() {
    const app = getApplicationSync();
    if (getTaskPaneHost(app)) return toggleTaskPaneWithApp(app);
    getApplication()
      .then((resolvedApp) => {
        toggleTaskPaneWithApp(resolvedApp);
      })
      .catch(() => {
        openTaskPaneAsDialogWithApp(null);
      });
    return true;
  }

  function openTaskPaneAsDialogWithApp(app) {
    const url = `${getUrlPath()}/taskpane.html?pane=dialog`;
    const title = "文小舟";
    const width = Math.round(420 * (global.devicePixelRatio || 1));
    const height = Math.round(720 * (global.devicePixelRatio || 1));
    // CreateTaskPane 路径已经做过保存校验；这里 fallback 到 ShowDialog 也补一道，避免漏判
    {
      const chk = checkActiveDocSavedForAdapter(app);
      if (!chk.ok) {
        debugLog("openTaskPaneAsDialog.blocked.unsaved", { hint: chk.hint });
        try { alert(chk.hint); } catch (e) {}
        return true;
      }
    }
    if (app && typeof app.ShowDialog === "function") {
      traceStatic("adapter.openDialog.app", url);
      debugLog("openTaskPaneAsDialog.app", { url, width, height });
      app.ShowDialog(url, title, width, height, false);
      return true;
    }
    if (typeof global.wps?.ShowDialog === "function") {
      traceStatic("adapter.openDialog.wps", url);
      debugLog("openTaskPaneAsDialog.wps", { url, width, height });
      global.wps.ShowDialog(url, title, width, height, false);
      return true;
    }
    traceStatic("adapter.openDialog.window", url);
    debugLog("openTaskPaneAsDialog.window-open", { url, width, height });
    global.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  function openTaskPaneAsDialog() {
    const app = getApplicationSync();
    if (app || global.wps) return openTaskPaneAsDialogWithApp(app);
    getApplication()
      .then((resolvedApp) => {
        openTaskPaneAsDialogWithApp(resolvedApp);
      })
      .catch(() => {
        openTaskPaneAsDialogWithApp(null);
      });
    return true;
  }

  function openParallelTranslateDialogWithApp(app, docPath) {
    const normalizedPath = pickString(docPath);
    if (!normalizedPath || !/\.pdf$/i.test(normalizedPath)) {
      traceStatic("adapter.openParallelTranslateDialog.no-path", JSON.stringify(getPdfPathDebugFromApp(app)));
      debugLog("openParallelTranslateDialog.no-path", getPdfPathDebugFromApp(app));
    }
    try {
      localStorage.setItem(PARALLEL_TRANSLATE_DIALOG_REQUEST_KEY, JSON.stringify({
        ts: Date.now(),
        docPath: normalizedPath
      }));
    } catch (e) {}
    const url = `${getUrlPath()}/taskpane.html?mode=paralleltranslate`;
    const title = "文小舟 对照翻译";
    const width = Math.round(900 * (global.devicePixelRatio || 1));
    const height = Math.round(720 * (global.devicePixelRatio || 1));
    if (app && typeof app.ShowDialog === "function") {
      traceStatic("adapter.openParallelTranslateDialog.app", normalizedPath);
      debugLog("openParallelTranslateDialog.app", { url, docPath: normalizedPath, width, height });
      app.ShowDialog(url, title, width, height, true);
      return true;
    }
    if (typeof global.wps?.ShowDialog === "function") {
      traceStatic("adapter.openParallelTranslateDialog.wps", normalizedPath);
      debugLog("openParallelTranslateDialog.wps", { url, docPath: normalizedPath, width, height });
      global.wps.ShowDialog(url, title, width, height, true);
      return true;
    }
    traceStatic("adapter.openParallelTranslateDialog.window", normalizedPath);
    debugLog("openParallelTranslateDialog.window-open", { url, docPath: normalizedPath, width, height });
    global.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  function openParallelTranslateDialogAfterChoose(app) {
    return openParallelTranslateDialogWithApp(app || getApplicationSync(), "");
  }

  function openParallelTranslateDialog(app, docPathHint) {
    const hinted = pickString(docPathHint);
    if (hinted) return openParallelTranslateDialogWithApp(app, hinted);
    Promise.resolve()
      .then(async () => {
        const resolvedApp = await resolveMaybe(app || getApplicationSync() || getApplication());
        const path = await resolvePdfPathForRibbon(resolvedApp, "", 900);
        if (!path) {
          Promise.resolve()
            .then(() => withTimeout(probePdfPath(resolvedApp), 1500, null))
            .catch(() => {});
        }
        openParallelTranslateDialogWithApp(resolvedApp || getApplicationSync(), path || "");
      })
      .catch(async () => {
        Promise.resolve()
          .then(() => withTimeout(probePdfPath(app || getApplicationSync()), 1500, null))
          .catch(() => {});
        openParallelTranslateDialogWithApp(app || getApplicationSync(), "");
      });
    return true;
  }

  function showEntryHint() {
    if (!document.body || document.getElementById("lingxiEntryHint")) {
      return;
    }
    const wrapper = document.createElement("main");
    wrapper.id = "lingxiEntryHint";
    wrapper.style.cssText = "font-family:'Microsoft YaHei UI','Segoe UI',sans-serif;padding:24px;line-height:1.7;color:#1f2329;";
    wrapper.innerHTML = `
      <h1 style="margin:0 0 12px;color:#1a6dff;">文小舟 加载项已启动</h1>
      <p>请在 WPS 顶部功能区查找 <strong>文小舟</strong> 选项卡，然后点击 <strong>打开文小舟</strong>。</p>
      <p>面板会嵌入到 WPS 右侧的任务窗格区域。再次点击同一按钮可以收起面板。</p>
      <button id="lingxiOpenBtn" type="button" style="border:0;border-radius:4px;padding:8px 16px;background:#1a6dff;color:#fff;font-weight:500;cursor:pointer;">直接打开文小舟</button>
    `;
    document.body.appendChild(wrapper);
    document.getElementById("lingxiOpenBtn")?.addEventListener("click", toggleTaskPane);
  }

  function setupRibbon(ribbonUI) {
    const app = getApplicationSync();
    traceStatic("adapter.setupRibbon", detectHostByApp(app));
    debugLog("setupRibbon", {
      hasRibbonUI: !!ribbonUI,
      hasApp: !!app,
      host: detectHostByApp(app)
    });
    if (app && typeof app.ribbonUI !== "object") {
      try { app.ribbonUI = ribbonUI; } catch (error) { /* readonly on some hosts */ }
    }
    if (global.wps && typeof global.wps.ribbonUI !== "object") {
      global.wps.ribbonUI = ribbonUI;
    }
    const targetRibbonUI = app?.ribbonUI || global.wps?.ribbonUI;
    if (targetRibbonUI?.ActivateTab) {
      setTimeout(() => {
        try { targetRibbonUI.ActivateTab("wpsAiTab"); } catch (e) { /* not active doc */ }
      }, 300);
    }
    return true;
  }

  // 当前活动 TaskPane 句柄（已存储 id → 通过 GetTaskPane 取回）。失败返回 null
  function getCurrentTaskPane() {
    const app = getApplicationSync();
    if (!app || typeof app.GetTaskPane !== "function") return null;
    const id = readStorageItem(app, TASKPANE_STORAGE_KEY);
    if (!id) return null;
    try { return app.GetTaskPane(id); } catch (e) { return null; }
  }

  // 读取/设置 TaskPane 的停靠位置。WPS 沿用 MSO 枚举：
  //   0=Left, 1=Top, 2=Right(默认), 3=Bottom, 4=Floating
  function getTaskPaneDockPosition() {
    const pane = getCurrentTaskPane();
    if (!pane) return null;
    try { return Number(pane.DockPosition); } catch (e) { return null; }
  }

  function setTaskPaneDockPosition(dock) {
    const pane = getCurrentTaskPane();
    if (!pane) return false;
    try {
      pane.DockPosition = dock;
      // 切到浮动：给一个看得见 resize handle 的初始尺寸，并居中到屏幕。
      // docked 状态 Width 决定的是固定一侧宽度，不动 Height/Left/Top
      if (dock === 4) {
        const W = 480, H = 720;
        try { if ("Width" in pane) pane.Width = W; } catch (e) {}
        try { if ("Height" in pane) pane.Height = H; } catch (e) {}
        // 屏幕中央：WPS pane.Left/Top 通常是相对桌面的绝对屏幕坐标
        try {
          const sw = (global.screen && global.screen.availWidth) || 1920;
          const sh = (global.screen && global.screen.availHeight) || 1080;
          if ("Left" in pane) pane.Left = Math.max(0, Math.round((sw - W) / 2));
          if ("Top" in pane) pane.Top = Math.max(0, Math.round((sh - H) / 2));
        } catch (e) { /* 不支持 Left/Top 就忍了 */ }
      }
      return true;
    } catch (e) {
      console.warn("[wps-ai] 设 DockPosition 失败:", e?.message || e);
      return false;
    }
  }

  // 浮动模式：用户拖右下抓手时，按屏幕坐标 delta 调 pane.Width/Height
  function resizeFloatingPane(width, height) {
    const pane = getCurrentTaskPane();
    if (!pane) return false;
    try {
      if ("Width" in pane && width > 200) pane.Width = Math.round(width);
      if ("Height" in pane && height > 200) pane.Height = Math.round(height);
      return true;
    } catch (e) { return false; }
  }
  function getFloatingPaneSize() {
    const pane = getCurrentTaskPane();
    if (!pane) return null;
    try { return { width: Number(pane.Width) || 0, height: Number(pane.Height) || 0 }; }
    catch (e) { return null; }
  }

  // 在停靠（右侧）与浮动两种状态间切换。返回新状态：true=floating, false=docked
  function toggleTaskPaneDock() {
    const cur = getTaskPaneDockPosition();
    const next = cur === 4 ? 2 : 4;   // floating(4) ↔ right(2)
    setTaskPaneDockPosition(next);
    return next === 4;
  }

  global.WpsAiAddon = {
    getAddonApi,
    getApplication,
    getApplicationSync,
    getUrlPath,
    toggleTaskPane,
    openTaskPane: toggleTaskPane,
    openTaskPaneAsDialog,
    setupRibbon,
    showEntryHint,
    getCurrentTaskPane,
    getTaskPaneDockPosition,
    setTaskPaneDockPosition,
    toggleTaskPaneDock,
    resizeFloatingPane,
    getFloatingPaneSize,
    getActivePdfPath: getActivePdfPathFromAppAsync,
    probePdfPath
  };
  global.__lingxiProbePdfPath = function __lingxiProbePdfPath() {
    return probePdfPath(getApplicationSync()).then((result) => {
      try { console.log("[lingxi] pdf path probe", result); } catch (e) {}
      return result;
    });
  };

  function handleAddinLoad(ribbonUI) {
    traceStatic("adapter.OnAddinLoad", JSON.stringify({
      hasRibbonUI: !!ribbonUI,
      host: detectHostByApp(getApplicationSync()),
      path: getUrlPath()
    }));
    debugLog("OnAddinLoad", {
      hasRibbonUI: !!ribbonUI
    });
    return setupRibbon(ribbonUI);
  }
  global.__lingxiOnAddinLoad = handleAddinLoad;
  global.OnAddinLoad = function OnAddinLoad(ribbonUI) {
    return handleAddinLoad(ribbonUI);
  };

  // Windows 文字部分版本的 JS 停靠窗格会挡住 Ribbon 的鼠标事件，使用浮窗绕过。
  function preferDialogPaneForHost() {
    try {
      const nav = global.navigator || (typeof navigator !== "undefined" ? navigator : null);
      const s = String((nav && nav.userAgent) || "") + " " + String((nav && nav.platform) || "");
      if (/Windows|Win32|Win64|WOW64/i.test(s)) return detectHostByApp(getApplicationSync()) === "wps";
      return /Mac|Macintosh|Mac OS X|Darwin|Linux|X11|CrOS/i.test(s);
    } catch (e) { return false; }
  }

  function handleRibbonAction(control) {
    const id = getRibbonControlId(control);
    traceStatic("adapter.OnAction", id);
    debugLog("OnAction", { id, controlType: typeof control });
    if (id === "openWpsAiPane") {
      // 使用浮窗规避对应宿主的停靠窗格焦点或功能区点击问题。
      if (preferDialogPaneForHost()) return openTaskPaneAsDialog();
      return toggleTaskPane();
    }

    // 「文档未保存」拦截：在还没 ensureTaskPaneVisible / writeStorageItem 之前判断，
    // 这样 alert 弹出来时 pane 完全不会打开，按钮像没点过一样。
    // 跳过校验的情况：纯展示 modal（stylePreset / outline / materialLibrary），它们不改文档。
    function blockedByUnsaved(skip) {
      if (skip) return false;
      const chk = checkActiveDocSavedForAdapter(getApplicationSync());
      if (!chk.ok) {
        try { alert(chk.hint); } catch (e) {}
        return true;
      }
      return false;
    }

    // PPT 风格按钮 → 打开 style preset modal（纯展示，不需要校验）
    if (id === "lingxiStyleBtn") {
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        kind: "open-modal",
        modal: "stylePreset",
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // 统一风格按钮 → 打开 unify modal（会改 PPT，要校验）
    if (id === "lingxiUnifyBtn") {
      if (blockedByUnsaved(false)) return true;
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        kind: "open-modal",
        modal: "unify",
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // 去 AI 味按钮 → 直接发起一个 PPT 文字改写对话（无 modal，要校验）
    if (id === "lingxiDeAiBtn") {
      if (blockedByUnsaved(false)) return true;
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        host: "wpp",
        key: "deAi",
        prompt: [
          "【任务】对当前 PPT 所有页面的文字执行「去 AI 味」改写：去掉典型的 AI 生成痕迹，让文字读起来像真人写的——简洁、克制、专业。",
          "",
          "【AI 味的典型特征——识别并清除】",
          "- 套话开头：首先 / 其次 / 再次 / 最后 / 综上所述 / 总而言之 / 在此基础上",
          "- 模板句式：「不仅...还...」「通过...来实现...」「为...提供了...的可能」",
          "- 万能修饰：非常 / 极其 / 高度 / 至关重要 / 深度 / 显著 / 创新 / 卓越 / 全方位",
          "- 互联网黑话：赋能 / 抓手 / 闭环 / 打通 / 链路 / 沉淀 / 复盘 / 体感 / 心智 / 颗粒度 / 对齐 / 拉齐",
          "- 列表狂魔：所有内容都强行编号 1/2/3——能改成自然连贯叙述的就改",
          "- 没意义的修饰词：方案「创新」、技术「先进」、效果「显著」、影响「深远」、意义「重大」",
          "- 万能结论：「实现了 X 与 Y 的有机统一」「为 X 注入了新的活力」「开启了 X 的新篇章」",
          "",
          "【流程】",
          "STEP 1. wpp_list_slides 拿整体结构。",
          "STEP 2. 对每页：wpp_read_slide 读所有形状文字。",
          "STEP 3. 逐个非空形状判断是否要改写：",
          "   - 页面标题：通常保留；如果含套话（如「关于...的若干思考」「浅谈...」），改成更直接的标题",
          "   - 正文/要点：重点改写——删套话、缩短句子、去掉万能修饰词、把『赋能/打通』换成普通词",
          "   - 不动：人名、地名、数字、专业术语、组织机构名",
          "STEP 4. 改写原则：",
          "   - 保留原意和事实信息",
          "   - 长句拆短句，主动语态",
          "   - 用具体动词替代抽象动词（『提升』要看上下文换成『提高/加快/优化』）",
          "   - 不要降级到口水化，保持商务/学术/汇报合适的语气",
          "STEP 5. 用 wpp_replace_shape_text 把改写后的文字写回对应形状（slide + shape index）。",
          "STEP 6. 自检：再 wpp_list_slides 看一遍 textPreview。",
          "",
          "【其他要求】",
          "- 进度汇报：每完成一页简短报一次「第 X 页改了 Y 处」",
          "- 完成后总结：处理了几页 / 一共改了多少处 / 哪几页改动最大",
          "",
          "现在开始 STEP 1。"
        ].join("\n"),
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // ribbon 快捷指令：id 形如 "quick.<host>.<key>"
    if (id.startsWith("quick.")) {
      const parts = id.split(".");
      const host = parts[1];
      const key = parts.slice(2).join(".");
      const action = global.WpsAiQuickActions?.findByKey?.(host, key);
      if (!action) return true;

      // 纯展示 modal（stylePreset / outline）不改文档，不需要保存校验。
      // materialLibrary 虽然是"展示"形态，但「插入到文档」按钮会写文档 → 也要校验。
      const displayOnlyModals = ["stylePreset", "outline", "parallelTranslate"];
      const isDisplayOnly = action.modal && displayOnlyModals.includes(action.modal);
      if (blockedByUnsaved(isDisplayOnly)) return true;

      const app = getApplicationSync();

      // 标记了 modal 字段的 chip：开 modal 而不是直接发送 prompt
      if (action.modal) {
        const docPath = (host === "pdf" && action.modal === "parallelTranslate")
          ? (getActivePdfPathFromApp(app) || null)
          : null;
        if (host === "pdf" && action.modal === "parallelTranslate") {
          return openParallelTranslateDialog(app, docPath);
        }
        writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
          kind: "open-modal",
          modal: action.modal,
          host,
          key,
          docPath,
          ts: Date.now()
        }));
        ensureTaskPaneVisible();
        return true;
      }

      // 把 prompt + prefill 标记扔进 PluginStorage，由 taskpane 消费。
      // PDF 场景先短超时取一次本机路径并放进 payload；taskpane 再兜底复查。
      const writePending = (docPath) => {
        writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
          host,
          key,
          label: action.label,
          prompt: action.prompt,
          prefill: !!action.prefill,
          // optionalInput：弹窗里"补充要求"允许留空，留空就只发原 prompt（续写这种"想说就说"的场景）
          optionalInput: !!action.optionalInput,
          flow: action.flow || "",
          // tone / instruction：给 selectionTone 这类带"预设要求"的 flow 用，避免要么在 prompt 里塞要么在 dispatcher 里反查
          tone: action.tone || action.label || "",
          instruction: action.instruction || "",
          // documentReport 用：标识是 summary 还是 mindmap，影响弹窗渲染方式
          reportKind: action.reportKind || "",
          attachActivePdf: !!action.attachActivePdf,
          docPath: pickString(docPath) || null,
          ts: Date.now()
        }));
      };
      if (host === "pdf" || action.attachActivePdf) {
        Promise.resolve()
          .then(async () => {
            const path = await resolvePdfPathForRibbon(app, getActivePdfPathFromApp(app), 900);
            if (!path) {
              Promise.resolve()
                .then(() => withTimeout(probePdfPath(app || getApplicationSync()), 1500, null))
                .catch(() => {});
            }
            writePending(path);
          })
          .catch(() => writePending(""));
      } else {
        writePending("");
      }
      ensureTaskPaneVisible();
      return true;
    }
    return true;
  }
  global.__lingxiOnAction = handleRibbonAction;
  global.OnAction = function OnAction(control) {
    return handleRibbonAction(control);
  };

  // 仅打开（不切换），用在 ribbon 触发动作时
  function ensureTaskPaneVisibleWithApp(app) {
    const url = `${getUrlPath()}/taskpane.html`;
    const taskPaneHost = getTaskPaneHost(app);
    traceStatic("adapter.ensureTaskPaneVisible.enter", detectHostByApp(app));
    debugLog("ensureTaskPaneVisible.enter", {
      url,
      hasApp: !!app,
      hasCreateTaskPane: !!taskPaneHost && (typeof taskPaneHost.CreateTaskPane === "function" || typeof taskPaneHost.CreateTaskpane === "function"),
      taskPaneHost: taskPaneHost === app ? "app" : (taskPaneHost === global.wps ? "wps" : typeof taskPaneHost),
      host: detectHostByApp(app)
    });
    if (preferDialogPaneForHost()) {
      traceStatic("adapter.ensureTaskPaneVisible.prefer-dialog", url);
      debugLog("ensureTaskPaneVisible.prefer-dialog", { url });
      return openTaskPaneAsDialogWithApp(app);
    }
    if (taskPaneHost) {
      const storageHost = app || taskPaneHost;
      const existingId = readStorageItem(storageHost, TASKPANE_STORAGE_KEY);
      if (existingId) {
        try {
          const pane = getTaskPaneById(taskPaneHost, existingId);
          if (pane) {
            if (!pane.Visible) pane.Visible = true;
            // ribbon 触发的 ensureTaskPaneVisible 也重新写默认宽度（同 toggleTaskPane 的考量）
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-reshow"); } catch (e) {}
            traceStatic("adapter.ensureTaskPaneVisible.reuse", existingId);
            debugLog("ensureTaskPaneVisible.reuse", {
              existingId,
              visible: pane.Visible
            });
            return true;
          }
        } catch (e) {}
      }
      // 新建前先清扫历史 v key 下的孤儿 pane
      cleanupLegacyTaskPanes(storageHost);
      try {
        const pane = createTaskPaneViaHost(taskPaneHost, url);
        if (pane?.ID != null) writeStorageItem(storageHost, TASKPANE_STORAGE_KEY, String(pane.ID));
        try {
          const enumHost = getTaskPaneEnumHost(app, taskPaneHost);
          if (enumHost && enumHost.msoCTPDockPositionRight !== undefined) {
             pane.DockPosition = enumHost.msoCTPDockPositionRight;
          } else {
             pane.DockPosition = 2; 
          }
        } catch (e) {}
        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-creation");
        pane.Visible = true;
        traceStatic("adapter.ensureTaskPaneVisible.created", pane?.ID != null ? String(pane.ID) : "no-id");
        debugLog("ensureTaskPaneVisible.created", {
          paneId: pane?.ID != null ? String(pane.ID) : "",
          visible: pane?.Visible
        });
        return true;
      } catch (e) {
        traceStatic("adapter.ensureTaskPaneVisible.create-failed", e?.message || String(e));
        debugLog("ensureTaskPaneVisible.create-failed", {
          message: e?.message || String(e)
        });
        return openTaskPaneAsDialogWithApp(app);
      }
    }
    traceStatic("adapter.ensureTaskPaneVisible.no-create-task-pane", url);
    debugLog("ensureTaskPaneVisible.no-create-task-pane", { url });
    return openTaskPaneAsDialogWithApp(app);
  }

  function ensureTaskPaneVisible() {
    const app = getApplicationSync();
    if (getTaskPaneHost(app)) return ensureTaskPaneVisibleWithApp(app);
    getApplication()
      .then((resolvedApp) => {
        ensureTaskPaneVisibleWithApp(resolvedApp);
      })
      .catch(() => {
        openTaskPaneAsDialogWithApp(null);
      });
    return true;
  }

  // ribbon dynamicMenu 内容：按 category 分组返回 OOXML，每组前用 menuSeparator 加标题
  global.GetQuickMenuContent = function GetQuickMenuContent(_control) {
    const app = getApplicationSync();
    const host = detectHostByApp(app);
    const groups = global.WpsAiQuickActions?.getRibbonGroups?.(host) || [];

    if (groups.length === 0) {
      return `<menu xmlns="http://schemas.microsoft.com/office/2006/01/customui">
        <button id="quickEmpty" label="（当前宿主无可用快捷指令）" enabled="false"/>
      </menu>`;
    }

    const parts = [];
    groups.forEach((g, gi) => {
      // 每组前面插入一条带标题的分隔线（首组不加间距前缀）
      parts.push(`<menuSeparator id="sep_${escapeXml(host)}_${escapeXml(g.category)}_${gi}" title="${escapeXml(g.label)}"/>`);
      g.actions.forEach((act) => {
        const id = `quick.${host}.${act.key}`;
        parts.push(`<button id="${escapeXml(id)}" label="${escapeXml(act.label)}" onAction="OnAction"/>`);
      });
    });

    return `<menu xmlns="http://schemas.microsoft.com/office/2006/01/customui">${parts.join("")}</menu>`;
  };

  function getRibbonImage(control) {
    const id = getRibbonControlId(control);
    const asPng = (path) => String(path || "images/ai.png").replace(/\.svg(?:$|\?)/, (match) => match.replace(".svg", ".png"));
    let resolved = "";
    if (id === "openWpsAiPane") resolved = "images/ai.png";
    else if (id === "lingxiStyleBtn") resolved = "images/icons/palette.png";
    else if (id === "lingxiUnifyBtn") resolved = "images/icons/wand.png";
    else if (id === "lingxiDeAiBtn") resolved = "images/icons/scrub.png";
    // 快捷指令按钮：id 形如 quick.<host>.<key>，按 category 取分类图标
    else if (id.startsWith("quick.")) {
      const parts = id.split(".");
      const host = parts[1];
      const key = parts.slice(2).join(".");
      const action = global.WpsAiQuickActions?.findByKey?.(host, key);
      const cat = action?.category;
      const map = global.WpsAiQuickActions?.CATEGORY_ICON || {};
      resolved = asPng(map[cat]);
    }
    else {
      resolved = "images/ai.png";
    }
    traceStatic("adapter.GetImage", JSON.stringify({ id, resolved }));
    debugLog("GetImage", { id, resolved });
    return resolved;
  }
  global.__lingxiGetImage = getRibbonImage;
  global.GetImage = function GetImage(control) {
    return getRibbonImage(control);
  };

  function getRibbonEnabled(control) {
    const id = getRibbonControlId(control);
    traceStatic("adapter.OnGetEnabled", id);
    return true;
  }
  global.__lingxiOnGetEnabled = getRibbonEnabled;
  global.OnGetEnabled = function OnGetEnabled(control) {
    return getRibbonEnabled(control);
  };

  function getRibbonVisible(control) {
    const id = getRibbonControlId(control);
    traceStatic("adapter.OnGetVisible", id);
    return true;
  }
  global.__lingxiOnGetVisible = getRibbonVisible;
  global.OnGetVisible = function OnGetVisible(control) {
    return getRibbonVisible(control);
  };

  function drainEarlyRibbonQueue() {
    const queue = Array.isArray(global.__lingxiRibbonEarlyQueue)
      ? global.__lingxiRibbonEarlyQueue.splice(0)
      : [];
    global.__lingxiRibbonEarlyQueue = [];
    queue.forEach((item) => {
      if (!item || item.type !== "action") return;
      const control = item.id || item.control;
      if (!control) return;
      try {
        handleRibbonAction(control);
      } catch (e) {
        console.warn("[wps-ai] 回放早期 ribbon 点击失败:", e?.message || e);
      }
    });
  }

  if (global.__lingxiRibbonUI) {
    try {
      handleAddinLoad(global.__lingxiRibbonUI);
    } catch (e) {
      console.warn("[wps-ai] 接管早期 ribbonUI 失败:", e?.message || e);
    }
  }
  drainEarlyRibbonQueue();

  document.addEventListener("DOMContentLoaded", () => {
    if (!/(?:^|\/)taskpane\.html(?:[?#].*)?$/i.test(window.location.pathname)) {
      showEntryHint();
    }
  });
})(window);
