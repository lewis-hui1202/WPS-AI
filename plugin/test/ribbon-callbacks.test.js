const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const adapterJs = fs.readFileSync(path.join(__dirname, "../js/wps-addon-adapter.js"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const genRibbonJs = fs.readFileSync(path.join(__dirname, "../tools/gen-ribbon.js"), "utf8");
const genRibbon = require("../tools/gen-ribbon.js");
const quickActions = genRibbon.loadQuickActions();
const pdfRibbonXml = genRibbon.buildRibbon("pdf", quickActions);
const wpsRibbonXml = genRibbon.buildRibbon("wps", quickActions);

function loadAdapter(overrides = {}) {
  const calls = {};
  const storage = new Map();
  const pane = { ID: "pane-1", Visible: false, DockPosition: 0, Width: 0 };
  const app = {
    Enum: { msoCTPDockPositionRight: 2 },
    PluginStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    CreateTaskPane(url) {
      calls.taskPaneUrl = url;
      return pane;
    },
    GetTaskPane() {
      return pane;
    }
  };
  const sandbox = {
    window: null,
    document: {
      location: { toString: () => "http://127.0.0.1:3889/index.html" },
      addEventListener() {}
    },
    localStorage: {
      getItem(key) { return storage.get(`ls:${key}`) || null; },
      setItem(key, value) { storage.set(`ls:${key}`, String(value)); },
      removeItem(key) { storage.delete(`ls:${key}`); }
    },
    screen: { availWidth: 1440, width: 1440 },
    URL,
    Application: app,
    WpsAiQuickActions: {
      CATEGORY_ICON: { document: "images/icons/document.svg" },
      findByKey(host, key) {
        if (host === "pdf" && key === "summary") return { category: "document" };
        return null;
      }
    },
    setTimeout() { return 1; },
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} }
  };
  Object.assign(sandbox, overrides);
  sandbox.window = sandbox;
  vm.runInNewContext(adapterJs, sandbox);
  return { sandbox, calls, pane, storage };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("ribbon 回调从 control.Id/id/ID 等字段兼容读取按钮 id", () => {
  assert.match(adapterJs, /function\s+getRibbonControlId\s*\(/, "需要集中兼容不同 WPS 宿主的 control id 字段");
  assert.match(adapterJs, /\["Id",\s*"id",\s*"ID"/);
  assert.match(adapterJs, /const id = getRibbonControlId\(control\)/, "OnAction/GetImage 应统一走兼容读取");
});

test("PDF ribbon 回调使用小写 control.id 时仍能显示图标并响应点击", () => {
  const { sandbox, calls, pane } = loadAdapter();

  assert.equal(sandbox.GetImage({ id: "quick.pdf.summary" }), "images/icons/document.png");

  sandbox.OnAction({ id: "openWpsAiPane" });

  assert.equal(calls.taskPaneUrl, "http://127.0.0.1:3889/taskpane.html");
  assert.equal(pane.Visible, true);
});

test("PDF ribbon 能通过 wps.PdfApplication 获取宿主 Application", () => {
  const pdfPane = { ID: "pdf-pane", Visible: false, DockPosition: 0, Width: 0 };
  const calls = {};
  const pdfApp = {
    PluginStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    CreateTaskPane(url) {
      calls.taskPaneUrl = url;
      return pdfPane;
    }
  };
  const { sandbox } = loadAdapter({
    Application: null,
    wps: {
      PdfApplication() { return pdfApp; }
    }
  });

  sandbox.OnAction({ id: "openWpsAiPane" });

  assert.equal(calls.taskPaneUrl, "http://127.0.0.1:3889/taskpane.html");
  assert.equal(pdfPane.Visible, true);
});

test("PDF ribbon 能回退到 wps 全局 CreateTaskpane 打开右侧任务窗格", () => {
  const globalPane = { ID: "global-pane", Visible: false, DockPosition: 0, Width: 0 };
  const calls = {};
  const { sandbox } = loadAdapter({
    Application: null,
    wps: {
      CreateTaskpane(url) {
        calls.taskPaneUrl = url;
        return globalPane;
      },
      GetTaskpane() {
        return globalPane;
      }
    }
  });

  sandbox.OnAction({ id: "openWpsAiPane" });

  assert.equal(calls.taskPaneUrl, "http://127.0.0.1:3889/taskpane.html");
  assert.equal(globalPane.Visible, true);
});

test("mac/linux 主入口弹窗 URL 带 pane=dialog 以隐藏停靠切换按钮", () => {
  const { sandbox, calls } = loadAdapter({
    navigator: { userAgent: "Mac OS X", platform: "MacIntel" },
    Application: {
      PluginStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      ShowDialog(url, title, width, height, modal) {
        calls.showDialog = { url, title, width, height, modal };
      }
    }
  });

  sandbox.OnAction({ id: "openWpsAiPane" });

  assert.equal(calls.showDialog.url, "http://127.0.0.1:3889/taskpane.html?pane=dialog");
  assert.equal(calls.showDialog.modal, false);
});

test("mac/linux ribbon 快捷生图也打开 dialog 而不是右侧 TaskPane", () => {
  const { sandbox, calls, storage } = loadAdapter({
    navigator: { userAgent: "Mac OS X", platform: "MacIntel" },
    Application: {
      PluginStorage: {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
      },
      CreateTaskPane(url) {
        calls.taskPaneUrl = url;
        return { ID: "pane-1", Visible: false, DockPosition: 0, Width: 0 };
      },
      ShowDialog(url, title, width, height, modal) {
        calls.showDialog = { url, title, width, height, modal };
      }
    },
    WpsAiQuickActions: {
      CATEGORY_ICON: { image: "images/icons/image.svg" },
      findByKey(host, key) {
        if (host === "wps" && key === "image") return { category: "image", label: "AI 生成图片", prompt: "生成图片", prefill: true };
        return null;
      }
    }
  });

  sandbox.OnAction({ id: "quick.wps.image" });

  const pending = JSON.parse(storage.get("lingxi_ai_pending_action"));
  assert.equal(pending.key, "image");
  assert.equal(calls.taskPaneUrl, undefined);
  assert.equal(calls.showDialog.url, "http://127.0.0.1:3889/taskpane.html?pane=dialog");
});

test("Windows WPS 文字打开主面板时使用浮窗，避免停靠窗格导致功能区卡死", () => {
  const calls = {};
  const { sandbox } = loadAdapter({
    navigator: { userAgent: "Windows NT 10.0", platform: "Win32" },
    Application: {
      ActiveDocument: { FullName: "C:\\test\\example.docx", Saved: true },
      CreateTaskPane() { calls.created = true; },
      ShowDialog(url, title, width, height, modal) { calls.dialog = { url, modal }; }
    }
  });
  sandbox.OnAction("openWpsAiPane");
  assert.equal(calls.created, undefined);
  assert.equal(calls.dialog.url, "http://127.0.0.1:3889/taskpane.html?pane=dialog");
  assert.equal(calls.dialog.modal, false);
});

test("浮窗不使用停靠窗格的顶部留白", () => {
  assert.match(appJs, /isNativeWindowsPane[\s\S]{0,400}!.*pane.*dialog/);
});

test("PDF 对照翻译在缺少 ShowDialog 时会直接 window.open 最终 dialog", async () => {
  const { sandbox, storage } = loadAdapter({
    Application: {
      ActivePDF: { FilePath: "/tmp/manual.pdf" },
      PluginStorage: {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
      },
      CreateTaskPane() {
        return { ID: "pane-1", Visible: false, DockPosition: 0, Width: 0 };
      },
      GetTaskPane() {
        return null;
      }
    },
    open(url, target, features) {
      storage.set("windowOpen", JSON.stringify({ url, target, features }));
    },
    WpsAiQuickActions: {
      CATEGORY_ICON: { translate: "images/icons/translate.svg" },
      findByKey(host, key) {
        if (host === "pdf" && key === "parallelTranslate") {
          return { category: "translate", modal: "parallelTranslate", label: "对照翻译" };
        }
        return null;
      }
    }
  });

  sandbox.OnAction({ id: "quick.pdf.parallelTranslate" });
  await flushPromises();

  const opened = JSON.parse(storage.get("windowOpen"));
  assert.equal(opened.url, "http://127.0.0.1:3889/taskpane.html?mode=paralleltranslate");
  const req = JSON.parse(storage.get("ls:lingxi_parallel_translate_dialog_request_v1"));
  assert.equal(req.docPath, "/tmp/manual.pdf");
  assert.equal(storage.get("lingxi_ai_pending_action"), undefined);
});

test("PDF 对照翻译直接打开最终 dialog，并把 docPath 写入 localStorage 请求", async () => {
  const { sandbox, calls, storage } = loadAdapter({
    Application: {
      ActivePDF: { FilePath: "/tmp/direct.pdf" },
      PluginStorage: {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
      },
      ShowDialog(url, title, width, height, modal) {
        calls.showDialog = { url, title, width, height, modal };
      }
    },
    WpsAiQuickActions: {
      CATEGORY_ICON: { translate: "images/icons/translate.svg" },
      findByKey(host, key) {
        if (host === "pdf" && key === "parallelTranslate") {
          return { category: "translate", modal: "parallelTranslate", label: "对照翻译" };
        }
        return null;
      }
    }
  });

  sandbox.OnAction({ id: "quick.pdf.parallelTranslate" });
  await flushPromises();

  assert.equal(calls.showDialog.url, "http://127.0.0.1:3889/taskpane.html?mode=paralleltranslate");
  assert.equal(calls.showDialog.title, "文小舟 对照翻译");
  assert.equal(calls.showDialog.modal, true);
  const req = JSON.parse(storage.get("ls:lingxi_parallel_translate_dialog_request_v1"));
  assert.equal(req.docPath, "/tmp/direct.pdf");
  assert.equal(storage.get("lingxi_ai_pending_action"), undefined);
});

test("PDF 对照翻译在宿主不暴露路径时仍会打开 dialog，并写入空路径用于显示诊断错误", async () => {
  const { sandbox, calls, storage } = loadAdapter({
    Application: {
      ActivePDF: {},
      PluginStorage: {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
      },
      ShowDialog(url, title, width, height, modal) {
        calls.showDialog = { url, title, width, height, modal };
      }
    },
    WpsAiQuickActions: {
      CATEGORY_ICON: { translate: "images/icons/translate.svg" },
      findByKey(host, key) {
        if (host === "pdf" && key === "parallelTranslate") {
          return { category: "translate", modal: "parallelTranslate", label: "对照翻译" };
        }
        return null;
      }
    }
  });

  sandbox.OnAction({ id: "quick.pdf.parallelTranslate" });
  await flushPromises();

  assert.equal(calls.showDialog.url, "http://127.0.0.1:3889/taskpane.html?mode=paralleltranslate");
  assert.equal(calls.showDialog.title, "文小舟 对照翻译");
  const req = JSON.parse(storage.get("ls:lingxi_parallel_translate_dialog_request_v1"));
  assert.equal(req.docPath, "");
});

test("PDF 对照翻译能绕过 unknown Application，改用 wps.PdfApplication 读取路径", async () => {
  const { sandbox, calls, storage } = loadAdapter({
    Application: {},
    wps: {
      PdfApplication() {
        return {
          ActivePDF: { FilePath: "/tmp/from-pdf-app.pdf" },
          ShowDialog(url, title, width, height, modal) {
            calls.showDialog = { url, title, width, height, modal };
          }
        };
      }
    },
    WpsAiQuickActions: {
      CATEGORY_ICON: { translate: "images/icons/translate.svg" },
      findByKey(host, key) {
        if (host === "pdf" && key === "parallelTranslate") {
          return { category: "translate", modal: "parallelTranslate", label: "对照翻译" };
        }
        return null;
      }
    }
  });

  sandbox.OnAction({ id: "quick.pdf.parallelTranslate" });
  await flushPromises();

  assert.equal(calls.showDialog.url, "http://127.0.0.1:3889/taskpane.html?mode=paralleltranslate");
  const req = JSON.parse(storage.get("ls:lingxi_parallel_translate_dialog_request_v1"));
  assert.equal(req.docPath, "/tmp/from-pdf-app.pdf");
});

test("PDF 对照翻译路径探测卡住时仍会打开 dialog", async () => {
  const { sandbox, calls, storage } = loadAdapter({
    setTimeout,
    clearTimeout,
    Application: {
      ActivePDF: new Promise(() => {}),
      PluginStorage: {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
      },
      ShowDialog(url, title, width, height, modal) {
        calls.showDialog = { url, title, width, height, modal };
      }
    },
    WpsAiQuickActions: {
      CATEGORY_ICON: { translate: "images/icons/translate.svg" },
      findByKey(host, key) {
        if (host === "pdf" && key === "parallelTranslate") {
          return { category: "translate", modal: "parallelTranslate", label: "对照翻译" };
        }
        return null;
      }
    }
  });

  sandbox.OnAction({ id: "quick.pdf.parallelTranslate" });
  await new Promise((resolve) => setTimeout(resolve, 950));
  await flushPromises();

  assert.equal(calls.showDialog.url, "http://127.0.0.1:3889/taskpane.html?mode=paralleltranslate");
  const req = JSON.parse(storage.get("ls:lingxi_parallel_translate_dialog_request_v1"));
  assert.equal(req.docPath, "");
});

test("PDF 全文总结 pending action 会携带 ribbon 侧解析出的 docPath", async () => {
  const { sandbox, storage } = loadAdapter({
    Application: {
      ActivePDF: { FilePath: "/tmp/summary.pdf" },
      PluginStorage: {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
      },
      CreateTaskPane() {
        return { ID: "pane-1", Visible: false, DockPosition: 0, Width: 0 };
      },
      GetTaskPane() {
        return null;
      }
    },
    WpsAiQuickActions: {
      CATEGORY_ICON: { document: "images/icons/document.svg" },
      findByKey(host, key) {
        if (host === "pdf" && key === "summary") {
          return { category: "document", label: "全文总结", prompt: "总结 PDF", attachActivePdf: true };
        }
        return null;
      }
    }
  });

  sandbox.OnAction({ id: "quick.pdf.summary" });
  await flushPromises();

  const pending = JSON.parse(storage.get("lingxi_ai_pending_action"));
  assert.equal(pending.docPath, "/tmp/summary.pdf");
  assert.equal(pending.attachActivePdf, true);
});

test("taskpane 消费 PDF 对照翻译动作时会复用 ribbon 传入的 docPath", () => {
  assert.match(appJs, /async function openParallelTranslateAsDialog\(docPathHint\)/);
  assert.match(appJs, /if \(!docPath\)\s*\{\s*try \{ docPath = global\.WpsAiBackup\?\.getCurrentDocPath\?\.\(\); \} catch \(e\) \{\}\s*\}/);
  assert.match(appJs, /payload\.modal === "parallelTranslate"\) openParallelTranslateAsDialog\(payload\.docPath \|\| null\)/);
});

test("taskpane 消费 PDF 快捷动作时优先走 PDF 通道，避免落入普通文档流程", () => {
  const pdfBranch = appJs.indexOf('if ((payload.host === "pdf" || payload.attachActivePdf) && payload.prompt)');
  const documentReportBranch = appJs.indexOf('if (payload.flow === "documentReport")');
  assert.notEqual(pdfBranch, -1, "需要有 PDF 快捷动作消费分支");
  assert.notEqual(documentReportBranch, -1, "需要保留普通文档报告分支");
  assert.ok(pdfBranch < documentReportBranch, "PDF 分支必须排在 documentReport 之前");
});

test("AI 面板能识别 PDF 宿主而不是显示未知宿主文案", () => {
  assert.match(appJs, /pdf:\s*\{\s*title:\s*"WPS PDF 助手"/);
  assert.doesNotMatch(appJs, /未识别到 WPS 宿主，请在 WPS 文字 \/ 表格 \/ 演示 中打开本插件"/);
});

test("入口页在 main.js 加载前注册 ribbon 回调壳", () => {
  assert.match(indexHtml, /__lingxiRibbonEarlyQueue/, "入口页需要先保存早到的 ribbon 点击");
  assert.match(indexHtml, /window\.OnAction\s*=\s*function/, "入口页需要提前暴露 OnAction");
  assert.match(indexHtml, /window\.GetImage\s*=\s*function/, "入口页需要提前暴露 GetImage");
  assert.match(indexHtml, /__lingxiBindRibbonAction/, "入口页需要支持生成的独立按钮回调");
  assert.match(indexHtml, /ribbon-callbacks\.generated\.js/, "入口页需要先加载生成的 ribbon 回调绑定脚本");
  assert.match(indexHtml, /images\/ai\.png/, "GetImage 早期兜底要返回 PDF ribbon 可显示的默认图标");
});

test("GetImage 返回相对图标路径，避免 mac WPS 把绝对 URL 当相对路径再拼一次", () => {
  const { sandbox } = loadAdapter({
    WpsAiQuickActions: {
      CATEGORY_ICON: {
        document: "images/icons/document.svg",
        translate: "images/icons/translate.svg"
      },
      findByKey(host, key) {
        if (host === "wps" && key === "translate") return { category: "translate" };
        if (host === "pdf" && key === "summary") return { category: "document" };
        return null;
      }
    }
  });
  assert.equal(sandbox.GetImage({ id: "openWpsAiPane" }), "images/ai.png");
  assert.equal(sandbox.GetImage({ id: "quick.wps.translate" }), "images/icons/translate.png");
  assert.doesNotMatch(sandbox.GetImage({ id: "quick.pdf.summary" }), /^https?:\/\//);
  assert.doesNotMatch(indexHtml, /new URL\("images\/ai\.png"/);
});

test("ribbon 生成器为每个按钮输出独立的 onAction / getImage 回调名", () => {
  assert.match(genRibbonJs, /function actionCallbackName/);
  assert.match(genRibbonJs, /function imageCallbackName/);
  assert.match(genRibbonJs, /ribbon-callbacks\.generated\.js/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, "../ribbon.xml"), "utf8"),
    /onAction="OnAction"\s+getImage="GetImage"/,
    "ribbon.xml 不应再让所有按钮共用一个 control 参数解析链"
  );
});

test("仓库默认 ribbon 保持 WPS 文字按钮，避免 mac Word 加载到 PDF ribbon", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  const ribbonXml = fs.readFileSync(path.join(__dirname, "../ribbon.xml"), "utf8");
  assert.equal(pkg.addonType, "wps");
  assert.equal(manifest.addonType, "wps");
  assert.match(ribbonXml, /id="quick\.wps\.helpWrite"/);
  assert.match(ribbonXml, /id="quick\.wps\.polish"/);
  assert.match(ribbonXml, /id="quick\.wps\.translate"/);
  assert.doesNotMatch(ribbonXml, /id="quick\.pdf\./);
  assert.match(wpsRibbonXml, /id="quick\.wps\.helpWrite"[^>]*image="images\/icons\/writing\.png"/);
});

test("PDF ribbon 按钮带静态 PNG image，兼容不拉取 getImage 路径的 PDF 宿主", () => {
  assert.match(pdfRibbonXml, /id="openWpsAiPane"[^>]*image="images\/ai\.png"/);
  assert.match(pdfRibbonXml, /id="quick\.pdf\.parallelTranslate"[^>]*image="images\/icons\/translate\.png"/);
  assert.match(pdfRibbonXml, /id="quick\.pdf\.summary"[^>]*image="images\/icons\/document\.png"/);
  assert.match(pdfRibbonXml, /id="quick\.pdf\.qa"[^>]*image="images\/icons\/document\.png"/);
  assert.match(pdfRibbonXml, /id="quick\.pdf\.suggest"[^>]*image="images\/icons\/wand\.png"/);
  assert.match(genRibbonJs, /function buttonAttrs/, "静态 image 属性应由生成器统一输出");
});

test("PDF ribbon 返回的 PNG 图标资源存在", () => {
  const expected = [
    "images/ai.png",
    "images/icons/brush.png",
    "images/icons/check.png",
    "images/icons/document.png",
    "images/icons/edit.png",
    "images/icons/image.png",
    "images/icons/palette.png",
    "images/icons/polish.png",
    "images/icons/scrub.png",
    "images/icons/slides.png",
    "images/icons/table.png",
    "images/icons/translate.png",
    "images/icons/wand.png",
    "images/icons/writing.png"
  ];
  for (const relativePath of expected) {
    assert.equal(
      fs.existsSync(path.join(__dirname, "..", relativePath)),
      true,
      `${relativePath} should exist`
    );
  }
});

test("adapter 接管入口页回调壳并回放早到的 ribbon 点击", () => {
  assert.match(adapterJs, /__lingxiOnAction/, "adapter 应注册 OnAction delegate 供入口壳调用");
  assert.match(adapterJs, /__lingxiGetImage/, "adapter 应注册 GetImage delegate 供入口壳调用");
  assert.match(adapterJs, /function\s+drainEarlyRibbonQueue\s*\(/, "adapter 加载后应处理入口页暂存的点击");
});

test("adapter 加载后会执行入口页缓存的 ribbon 点击", () => {
  const { calls, pane, sandbox } = loadAdapter({
    __lingxiRibbonEarlyQueue: [{ type: "action", id: "openWpsAiPane", ts: 1 }]
  });

  assert.equal(calls.taskPaneUrl, "http://127.0.0.1:3889/taskpane.html");
  assert.equal(pane.Visible, true);
  assert.deepEqual(sandbox.__lingxiRibbonEarlyQueue, []);
});
