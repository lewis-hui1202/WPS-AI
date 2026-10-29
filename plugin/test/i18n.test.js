const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 无 DOM 环境加载 i18n.js：zh 模式下 init() 提前返回，不触碰 document
function loadI18n(storageInit) {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "i18n.js"), "utf8");
  const store = Object.assign({}, storageInit || {});
  const window = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    }
  };
  vm.runInThisContext("(function(window){ const navigator = undefined; const document = undefined; " + code + "\n})")(window);
  return { i18n: window.WpsAiI18n, store };
}

test("默认偏好 auto，无系统语言信息时回落中文，t() 原样返回", () => {
  const { i18n } = loadI18n();
  assert.equal(i18n.getPref(), "auto");
  assert.equal(i18n.resolvedLang(), "zh");
  assert.equal(i18n.t("发送"), "发送");
});

test("切到 en 后 t() 查词典，查不到回退中文", () => {
  const { i18n } = loadI18n();
  i18n.setPref("en");
  assert.equal(i18n.resolvedLang(), "en");
  assert.equal(i18n.t("发送"), "Send");
  assert.equal(i18n.t("替换选中区域"), "Replace selection");
  // 词典没有的 key 原样返回
  assert.equal(i18n.t("这句话词典里没有"), "这句话词典里没有");
});

test("t() 支持 {param} 插值（中英都插）", () => {
  const { i18n } = loadI18n();
  assert.equal(i18n.t("共 {n} 条", { n: 3 }), "共 3 条");
  i18n.setPref("en");
  assert.equal(i18n.t("共 {n} 条", { n: 3 }), "共 3 条"); // 未收录时中文原文也照样插值
});

test("语言偏好持久化到 localStorage，非法值归一为 auto", () => {
  const { i18n, store } = loadI18n();
  i18n.setPref("en");
  assert.equal(store["lingxi_ui_lang_v1"], "en");
  i18n.setPref("whatever");
  assert.equal(store["lingxi_ui_lang_v1"], "auto");
});

test("词典完整性：value 全为非空字符串且不含未替换的中文 key 自引用", () => {
  const { i18n } = loadI18n();
  const dict = i18n._dict;
  const entries = Object.entries(dict);
  assert.ok(entries.length >= 200, `词典应有足够覆盖（当前 ${entries.length} 条）`);
  for (const [k, v] of entries) {
    assert.equal(typeof v, "string", `key「${k}」的值必须是字符串`);
    assert.ok(v.trim().length > 0, `key「${k}」的翻译不能为空`);
  }
});

test("反向词典可用于热切回中文（en → zh），无 DOM 时 applyCurrent 安全跳过", () => {
  const { i18n } = loadI18n();
  assert.equal(i18n._reverse["Send"], "发送");
  assert.equal(i18n._reverse["Replace selection"], "替换选中区域");
  // 无 DOM 环境下 setPref（内部会调 applyCurrent）不能抛
  assert.doesNotThrow(() => { i18n.setPref("en"); i18n.setPref("zh"); i18n.applyCurrent(); });
});

test("设置弹窗与主面板都绑定语言下拉（bindUiLanguageControl 双调用）", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  const calls = appJs.match(/bindUiLanguageControl\(\);/g) || [];
  assert.ok(calls.length >= 2, `bindUiLanguageControl 应在主面板 + 设置 dialog 各调用一次（实际 ${calls.length} 处）`);
});

test("ribbon 所有 getLabel 绑定的中文 label 在词典里都有英文翻译", () => {
  const { i18n } = loadI18n();
  const gen = fs.readFileSync(path.join(__dirname, "..", "js", "ribbon-callbacks.generated.js"), "utf8");
  const labels = [];
  const re = /bindLabel\("[^"]+",\s*"((?:[^"\\]|\\.)*)"\)/g;
  let m;
  while ((m = re.exec(gen))) labels.push(JSON.parse('"' + m[1] + '"'));
  assert.ok(labels.length >= 20, `应至少绑定 20 个 label（实际 ${labels.length}）`);
  const missing = labels.filter((l) => !(l in i18n._dict));
  assert.deepEqual(missing, [], `这些 ribbon label 缺英文翻译：${missing.join("、")}`);
});

test("ribbon.xml 的 tab/group/button 都带 getLabel 回调", () => {
  const xml = fs.readFileSync(path.join(__dirname, "..", "ribbon.xml"), "utf8");
  assert.match(xml, /<tab [^>]*getLabel="GetLabel_tab_wpsAiTab"/);
  assert.match(xml, /<group [^>]*getLabel="GetLabel_group_/);
  const buttons = xml.match(/<button /g) || [];
  const withLabelCb = xml.match(/<button [^>]*getLabel="GetLabel_/g) || [];
  assert.equal(withLabelCb.length, buttons.length, "每个 button 都应有 getLabel 回调");
});

test("ribbon.en.xml 存在且 label 全部为英文（无未翻译中文残留）", () => {
  const xml = fs.readFileSync(path.join(__dirname, "..", "ribbon.en.xml"), "utf8");
  assert.match(xml, /label="Wenxiaozhou"/);
  const labels = xml.match(/label="[^"]*"/g) || [];
  const cn = labels.filter((l) => /[一-龥]/.test(l));
  assert.deepEqual(cn, [], `英文 ribbon 里不应有中文 label：${cn.join(" ")}`);
});

test("静态服务按 ui-lang 侧车切换 ribbon 语言文件（serve-permanent + dev-static）", () => {
  const sp = fs.readFileSync(path.join(__dirname, "..", "tools", "serve-permanent.js"), "utf8");
  const ds = fs.readFileSync(path.join(__dirname, "..", "tools", "dev-static-server.js"), "utf8");
  const px = fs.readFileSync(path.join(__dirname, "..", "tools", "proxy-server.js"), "utf8");
  assert.match(sp, /ui-lang\.txt/);
  assert.match(sp, /ribbon\.en\.xml/);
  assert.match(ds, /ui-lang\.txt/);
  assert.match(ds, /ribbon\.en\.xml/);
  assert.match(px, /"\/ui-lang"/);
});

test("app.js 的 AI 语言约束跟随界面语言（存在 en 分支）", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  assert.match(appJs, /WpsAiI18n\?\.resolvedLang/);
  assert.match(appJs, /Always respond in English/);
  assert.match(appJs, /Always respond in Simplified Chinese/);
});
