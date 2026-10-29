/**
 * 文档级备份 + 恢复（per-turn 粒度）。
 *
 * 双层回退策略:
 *   - 优先「内容层」: 用 Application.UndoRecord 把整个 AI turn 分组成一个 undo,
 *     回退时 Application.Undo() 一次撤回整组 → 不关文档,光标/滚动/状态都保留
 *   - 降级「文件层」: 关文档 → proxy 覆盖磁盘文件 → 重开。代价是文档关闭重开,
 *     但能跨多 turn 回退,且对 ET/WPP 这种没 UndoRecord 的宿主兜底
 *
 * 核心 API:
 *   - captureCurrentDoc()  → Save + 文件备份 + 启动 UndoRecord
 *   - endUndoGroup()       → 关掉当前 UndoRecord(turn 结束时调)
 *   - restoreFromBackup(backupPath, targetPath, opts)
 *                            opts.tryUndo=true 时先试 Undo,失败才走关闭重开
 *   - getCurrentDocPath() → 当前活动文档的绝对路径（未保存的新文档返回 null）
 *
 * 与 proxy-server.js 的 /doc-snapshot / /doc-restore 配套使用。
 * 失败一律返回 { ok:false, error }，绝不抛错影响主流程。
 */
(function attachBackup(global) {
  "use strict";

  function proxyBase() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }

  function pickString(value) {
    return value == null ? "" : String(value).trim();
  }

  function firstDocString(doc, keys) {
    for (const key of keys) {
      try {
        const value = pickString(doc?.[key]);
        if (value) return value;
      } catch (e) {}
    }
    return "";
  }

  // ---- 当前应用 / 当前文档抓取 ----

  function getApp() {
    return global.wps?.WpsApplication?.()
      || global.wps?.EtApplication?.()
      || global.wps?.WppApplication?.()
      || global.wps?.PdfApplication?.()
      || global.wps?.PDFApplication?.()
      || global.wps?.KPdfApplication?.()
      || global.wps?.KpdfApplication?.()
      || global.pdf?.Application
      || global.kpdf?.Application
      || global.wps?.Application
      || global.Application
      || null;
  }

  // 按宿主返回 ActiveDocument / ActiveWorkbook / ActivePresentation
  // 同时返回宿主标识，方便后续做 host-specific 调用
  function getActiveDoc() {
    const app = getApp();
    if (!app) return { app: null, doc: null, host: "*" };
    try { if (app.ActiveWorkbook) return { app, doc: app.ActiveWorkbook, host: "et" }; } catch (e) {}
    try { if (app.ActivePresentation) return { app, doc: app.ActivePresentation, host: "wpp" }; } catch (e) {}
    // PDF 宿主：属性命名各版本不一，多试；放在 ActiveDocument 之前，避免 PDF 版本把 PDF 也暴露成 ActiveDocument 时误判为 wps
    try { if (app.ActivePDF) return { app, doc: app.ActivePDF, host: "pdf" }; } catch (e) {}
    try { if (app.ActivePdf) return { app, doc: app.ActivePdf, host: "pdf" }; } catch (e) {}
    try { if (app.ActivePDFDocument) return { app, doc: app.ActivePDFDocument, host: "pdf" }; } catch (e) {}
    try { if (app.ActivePdfDoc) return { app, doc: app.ActivePdfDoc, host: "pdf" }; } catch (e) {}
    try { if (app.ActiveDocument) return { app, doc: app.ActiveDocument, host: "wps" }; } catch (e) {}
    return { app, doc: null, host: "*" };
  }

  // ---- 文档身份 UUID：写进 CustomDocumentProperties，重命名 / 移动 / Save As / 跨机同步都带着走 ----
  //
  // 键名 "LingxiDocId"（跟 Word / ET / WPP 的 CustomDocumentProperties 兼容），值 = UUID。
  // 首次 AI 交互时 assign 一次；后续所有历史 / 快照都用这个 ID 作 primary key，路径做 fallback。
  const DOC_ID_PROP = "LingxiDocId";

  function genUuid() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    // 老 WebView 兜底：cryptographically-weak，但已经够"文档级唯一"
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // 读文档级 CustomDocumentProperties。宿主接口略有不同 —— WPS / Word 的
  // CustomDocumentProperties 是集合，取值一般 CustomDocumentProperties.Item("KeyName").Value
  // 或直接 CustomDocumentProperties("KeyName").Value。都试一遍容错。
  function readDocId() {
    const { doc, host } = getActiveDoc();
    if (!doc || !host || !["wps", "et", "wpp"].includes(host)) return null;
    try {
      const props = doc.CustomDocumentProperties;
      if (!props) return null;
      // 走 Item 索引法：不存在会抛，用来判断缺项
      try {
        const p = props.Item(DOC_ID_PROP);
        if (p && p.Value != null) {
          const v = String(p.Value).trim();
          if (v) return v;
        }
      } catch (e) { /* 不存在 */ }
      // 有些 JS 桥用属性调用式 props(name).Value
      try {
        const p2 = props(DOC_ID_PROP);
        if (p2 && p2.Value != null) {
          const v = String(p2.Value).trim();
          if (v) return v;
        }
      } catch (e) { /* 不存在 */ }
    } catch (e) { /* CustomDocumentProperties 整体不支持 */ }
    return null;
  }

  // 若还没 assign 就写一条 UUID 进去。msoPropertyTypeString = 4（Office 常量）。
  // 只写内存里的 property，不主动 Save —— 让 captureCurrentDoc 里 doc.Save() 帮忙持久化，
  // 避免额外一次盘操作。
  function ensureDocId() {
    const existing = readDocId();
    if (existing) return existing;
    const { doc, host } = getActiveDoc();
    if (!doc || !host || !["wps", "et", "wpp"].includes(host)) return null;
    const uuid = genUuid();
    try {
      const props = doc.CustomDocumentProperties;
      if (!props) return null;
      // Add(Name, LinkToContent, Type, Value)
      // Type=4 = msoPropertyTypeString
      try {
        props.Add(DOC_ID_PROP, false, 4, uuid);
        return uuid;
      } catch (e) {
        // 有的宿主 Add 不认 int type 常量，改试字符串枚举 / 少参
        try { props.Add(DOC_ID_PROP, false, "msoPropertyTypeString", uuid); return uuid; } catch (e2) {}
        try { props.Add(DOC_ID_PROP, uuid); return uuid; } catch (e3) {}
      }
    } catch (e) { /* 不支持就返回 null，历史退回按路径 key */ }
    return null;
  }

  // 一站式返回文档身份：docId 优先（跨重命名 / Save As 稳定），docPath 兜底。
  // key = docId 存在时 = "id:<uuid>"；否则 = "path:<normalized-path>"。
  // 上层比较用 key 做等价判断，就不用再分别 pathsEqual / idsEqual。
  function getCurrentDocKey() {
    const path = getCurrentDocPath();
    const id = readDocId();
    return {
      docId: id || null,
      docPath: path || null,
      // 拼一个字符串 key，UI 侧 filter / index 直接用
      key: id ? `id:${id}` : (path ? `path:${path.replace(/\\/g, "/").toLowerCase()}` : null),
      // 有 id 就是稳定身份；只有路径时"稳定性"要打折
      stable: !!id
    };
  }

  // 当前文档的绝对路径（未保存过的"文档1"返回 null）
  function getCurrentDocPath() {
    const { doc, host } = getActiveDoc();
    if (!doc) return null;
    let fullName = "";
    let p = "";
    let n = "";
    if (host === "pdf") {
      fullName = firstDocString(doc, ["FullName", "FullPath", "FilePath", "DocumentPath", "FileName", "Name"]);
      p = firstDocString(doc, ["Path", "DocumentPath", "FolderPath"]);
      n = firstDocString(doc, ["Name", "FileName", "Title"]);
    } else {
      fullName = firstDocString(doc, ["FullName"]);
      p = firstDocString(doc, ["Path"]);
      n = firstDocString(doc, ["Name"]);
    }

    if (/^file:\/\//i.test(fullName)) {
      try {
        const url = new URL(fullName);
        let pathname = decodeURIComponent(url.pathname || "");
        if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
        fullName = pathname || fullName;
      } catch (e) {
        fullName = fullName.replace(/^file:\/\//i, "");
      }
    }

    // 1) FullName 含路径分隔符即视为绝对路径
    if (/[/\\]/.test(fullName)) return fullName;
    // 2) FullName 已经是个绝对路径但 OS 路径符识别不到（比如 Mac 纯 UNIX 路径已被 1 覆盖；这里兜底）
    if (fullName.startsWith("/") || /^[A-Za-z]:/.test(fullName)) return fullName;
    // 3) 退路：拼 Path + Name；Path 必须看起来像绝对路径
    if (p && n && (/[/\\]/.test(p) || p.startsWith("/") || /^[A-Za-z]:/.test(p))) {
      const sep = p.includes("\\") ? "\\" : "/";
      const tail = p.endsWith("/") || p.endsWith("\\") ? "" : sep;
      return `${p}${tail}${n}`;
    }
    return null;
  }

  // ---- UndoRecord helpers (MSO Word 风格,WPS Writer 也支持;ET/WPP 不支持就 silent fail) ----

  // 标记一个"我们启动了 UndoRecord"的全局位,防止重复 End
  let undoRecordOpen = false;

  function tryStartUndoGroup(app, name) {
    if (!app) return false;
    try {
      const ur = app.UndoRecord;
      if (ur && typeof ur.StartCustomRecord === "function") {
        ur.StartCustomRecord(name || "文小舟 操作");
        undoRecordOpen = true;
        return true;
      }
    } catch (e) { /* 不支持就算了 */ }
    return false;
  }

  function tryEndUndoGroup(app) {
    if (!app) return false;
    try {
      const ur = app.UndoRecord;
      if (ur && typeof ur.EndCustomRecord === "function") {
        ur.EndCustomRecord();
        undoRecordOpen = false;
        return true;
      }
    } catch (e) { /* */ }
    return false;
  }

  function tryUndoOnce(app) {
    if (!app) return false;
    // 各宿主的 Undo 入口不太一样:Writer/ET 多用 Application.Undo,
    // 没有的话退到 doc.Undo 当兜底。
    // 修 B8：Word/WPS 的 Undo() 在撤销栈为空时不抛异常而是返回 False，
    // 必须尊重返回值，否则"什么都没撤"也会被当成恢复成功并落盘。
    try {
      if (typeof app.Undo === "function") {
        const r = app.Undo();
        return r !== false;
      }
    } catch (e) {}
    try {
      const { doc } = getActiveDoc();
      if (doc && typeof doc.Undo === "function") {
        const r = doc.Undo();
        return r !== false;
      }
    } catch (e) {}
    return false;
  }

  // 外部调用:turn 结束时把 UndoRecord 关掉,这样下一次 Undo 一次性撤回整组
  function endUndoGroup() {
    if (!undoRecordOpen) return false;
    const { app } = getActiveDoc();
    return tryEndUndoGroup(app);
  }

  // ---- snapshot ----

  async function captureCurrentDoc() {
    const { app, doc, host } = getActiveDoc();
    if (!doc) return { ok: false, error: "未检测到打开的文档" };

    // 1. 取路径——未保存的新文档没路径，跳过备份
    const docPath = getCurrentDocPath();
    if (!docPath) {
      // 把能拿到的字段也带回去，方便排错
      let fullName = "", p = "", n = "";
      try { fullName = String(doc.FullName || ""); } catch (e) {}
      try { p = String(doc.Path || ""); } catch (e) {}
      try { n = String(doc.Name || ""); } catch (e) {}
      return { ok: false, error: `无法获取文档路径（未保存到磁盘？）。FullName="${fullName}" Path="${p}" Name="${n}"` };
    }

    // 2. 开 UndoRecord(在 Save 之前,这样 Save 不会进 undo 组里 — 不影响)
    //    这一步是"内容层回退"的关键。开成功就标记 undoGroup=true,回退时优先走 Undo。
    const undoGroup = tryStartUndoGroup(app, `文小舟 - ${new Date().toISOString()}`);

    // 3. 补/取文档身份 UUID（写进 CustomDocumentProperties）。
    //    在 Save 之前 assign，Save 会顺手把 property 持久化到 .docx / .xlsx / .pptx 里，
    //    以后重命名 / Save As / 跨机同步都能凭这个 ID 找到历史。
    const docId = ensureDocId();

    // 4. 让 WPS 把文档存盘（不弹保存框）—— 顺带把 UUID 落盘
    try {
      if (typeof doc.Save === "function") doc.Save();
    } catch (e) {
      return { ok: false, error: `Save 失败：${e?.message || e}` };
    }

    // 5. POST 给代理做实际文件复制(作为 Undo 失效场景的兜底)
    try {
      const resp = await fetch(`${proxyBase()}/doc-snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docPath })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, error: `代理返回 ${resp.status}：${text.slice(0, 200)}` };
      }
      const json = await resp.json();
      return {
        ok: true,
        docPath,
        docId,
        host,
        backupPath: json.backupPath,
        size: json.size,
        timestamp: json.timestamp || Date.now(),
        undoGroup
      };
    } catch (e) {
      return { ok: false, error: `代理连不上：${e?.message || e}` };
    }
  }

  // ---- restore ----

  // 双层回退:
  //   0. opts.tryUndo=true 时先试 Application.Undo() 撤回整组改动 → 不关文档,
  //      光标/视图/状态全保留。失败才走文件层。
  //   1. 文件层:关文档 → 代理覆盖磁盘 → 重开。
  async function restoreFromBackup(backupPath, targetPath, opts) {
    opts = opts || {};
    if (!backupPath || !targetPath) return { ok: false, error: "backupPath / targetPath 必填" };

    const { app, doc, host } = getActiveDoc();

    // ---- 0. 先试「内容层」: Application.Undo,不关文档 ----
    // opts.undoSteps: 撤销几步。1 = 撤回最近一组（默认行为，最新 turn 用）；
    // 2+ = 多步撤销，用来跨过中间的 AI turn 回滚到更早的 turn。
    // 每步撤销一个 UndoRecord 组（StartCustomRecord→EndCustomRecord 形成一个 undo 单元）。
    // 注意：用户在 AI turn 之间手动编辑的内容不在这些组里，多步撤销不会把它们一并回滚 ——
    // 这是已知行为，不完美但比每次都关文档强。需要完全对齐磁盘状态时让外层退到文件路径。
    const undoSteps = opts.tryUndo
      ? Math.max(1, Math.floor(opts.undoSteps || 1))
      : 0;
    // 修 B5：Undo 作用在"当前活动文档"上，必须先确认活动文档就是要恢复的目标文档。
    // 否则用户切到别的文档后点恢复，会撤掉并保存错误的文档（双重数据损坏）。
    // 当前文档不是目标时，跳过内容层 Undo，直接走下面的文件层（它会按 targetPath 重开）。
    const curPathForUndo = getCurrentDocPath();
    const undoTargetsMatch = !!curPathForUndo && pathsEqual(curPathForUndo, targetPath);
    if (undoSteps > 0 && app && undoTargetsMatch) {
      tryEndUndoGroup(app);
      let undoneCount = 0;
      for (let i = 0; i < undoSteps; i++) {
        if (tryUndoOnce(app)) undoneCount++;
        else break;
      }
      if (undoneCount === undoSteps) {
        // 把回滚结果存盘，避免用户再做别的操作时 dirty 状态混乱
        try { if (typeof doc?.Save === "function") doc.Save(); } catch (e) {}
        return { ok: true, method: "undo", reopened: false, undoneCount };
      }
      // 没全 undo 完 → 把已撤的尽量 redo 回去再走文件层（避免状态半截）
      if (undoneCount > 0) {
        try {
          for (let i = 0; i < undoneCount; i++) {
            if (typeof app.Redo === "function") app.Redo();
          }
        } catch (e) {}
      }
      // Undo 不支持或没撤够 → 继续走文件层
    }

    // ---- 1. 文件层(降级): 关 → 等句柄释放 → 覆盖 → 重开 ----
    let needReopen = false;
    if (doc) {
      const curPath = getCurrentDocPath();
      if (curPath && pathsEqual(curPath, targetPath)) {
        try {
          // Save=false：丢弃当前未保存改动（用户已确认要回退）
          doc.Close(false);
          needReopen = true;
          // Windows 下 doc.Close 返回不等于文件句柄已释放，给 OS 一点时间。
          // 即便这里没等够，下面 proxy 的 /doc-restore 还有 EPERM 退避重试兜底。
          await new Promise((resolve) => setTimeout(resolve, 400));
        } catch (e) {
          return { ok: false, error: `关闭当前文档失败：${e?.message || e}` };
        }
      }
    }

    // 2. 让代理做文件覆盖
    let restoreErr = null;
    try {
      const resp = await fetch(`${proxyBase()}/doc-restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupPath, targetPath })
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({ error: "" }));
        restoreErr = payload.error || `代理返回 ${resp.status}`;
      }
    } catch (e) {
      restoreErr = `代理连不上：${e?.message || e}`;
    }

    // 3. 重新打开（无论成功失败都要重开，避免把用户文档关掉就不管了）
    let reopened = false;
    if (needReopen && app) {
      try {
        if (host === "wps" && app.Documents?.Open) app.Documents.Open(targetPath);
        else if (host === "et" && app.Workbooks?.Open) app.Workbooks.Open(targetPath);
        else if (host === "wpp" && app.Presentations?.Open) app.Presentations.Open(targetPath);
        else if (app.Documents?.Open) app.Documents.Open(targetPath);
        reopened = true;
      } catch (e) {
        // 重开失败，告诉调用方但不上升为致命
        const reopenWarn = `未能自动重开文档：${e?.message || e}`;
        if (restoreErr) return { ok: false, error: `${restoreErr}（且 ${reopenWarn}）` };
        return { ok: true, method: "file", reopened: false, warning: reopenWarn };
      }
    }

    if (restoreErr) return { ok: false, error: restoreErr, reopened };
    return { ok: true, method: "file", reopened: needReopen };
  }

  function pathsEqual(a, b) {
    if (!a || !b) return false;
    const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return norm(a) === norm(b);
  }

  // 列出某文档已有备份（用于排错 / UI 展示）
  async function listBackups(docPath) {
    if (!docPath) return { ok: false, error: "docPath 必填" };
    try {
      const url = `${proxyBase()}/doc-backups?docPath=${encodeURIComponent(docPath)}`;
      const resp = await fetch(url);
      if (!resp.ok) return { ok: false, error: `${resp.status}` };
      return await resp.json();
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // 当前活动文档的保存状态。给 ribbon / 弹窗触发的 AI 动作做"先保存才让用"的早判断。
  // 返回 { ok, host, hasPath, isDirty, docPath, hint }：
  //   - ok: true 表示已保存到磁盘且没有脏改动（可以放心做 AI 操作）
  //   - hint: ok=false 时给一句给用户看的中文原因
  //   - host=null 表示没识别到 wps/wpp/et 活动文档（如 PDF 或没文档）→ 也算 ok（不拦）
  function getCurrentDocSaveState() {
    const { doc, host } = getActiveDoc();
    if (!doc || !host || !["wps", "wpp", "et"].includes(host)) {
      return { ok: true, host: host || null, hasPath: false, isDirty: false, docPath: null, hint: "" };
    }
    const docPath = getCurrentDocPath();
    const hasPath = !!docPath;
    let savedAttr = null;
    try { savedAttr = doc.Saved; } catch (e) { savedAttr = null; }
    // savedAttr=null 是兼容：部分宿主 / 异常情况下读不到 Saved 字段；这种情况只看路径
    const isDirty = savedAttr === false;
    if (!hasPath) {
      return {
        ok: false,
        host,
        hasPath: false,
        isDirty,
        docPath: null,
        hint: "当前文档还没保存到磁盘（临时文档）。请先保存为本地文件（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），再使用 AI 功能。"
      };
    }
    if (isDirty) {
      return {
        ok: false,
        host,
        hasPath: true,
        isDirty: true,
        docPath,
        hint: "当前文档有未保存的修改。请先保存（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），再使用 AI 功能（保存后改动才能纳入备份/回滚记录）。"
      };
    }
    return { ok: true, host, hasPath: true, isDirty: false, docPath, hint: "" };
  }

  global.WpsAiBackup = {
    captureCurrentDoc,
    endUndoGroup,
    restoreFromBackup,
    getCurrentDocPath,
    getCurrentDocSaveState,
    listBackups,
    // 文档身份（跨重命名 / Save As / 跨机同步稳定）
    readDocId,
    ensureDocId,
    getCurrentDocKey
  };
})(window);
