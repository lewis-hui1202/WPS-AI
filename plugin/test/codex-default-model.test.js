const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test("Codex OAuth card offers fetched models while signed in", () => {
  const body = { innerHTML: "", querySelector: () => null };
  const ctx = { global: { WpsAiAuth: { getTokenInfo: () => ({ authenticated: true }) } }, escapeAttr: String, escapeHtml: String, buildModelPickerHtml: (models) => `<select data-role="model-picker">${models.join(",")}</select>` };
  vm.runInNewContext(section("  function renderCodexCardBody(", "  // ---------------- Header status"), ctx);
  ctx.renderCodexCardBody(body, { defaultModel: "gpt-old" }, ["gpt-new"], "提示");
  assert.match(body.innerHTML, /data-role="model-picker"/);
  assert.match(body.innerHTML, /gpt-new/);
});

test("successful Codex test clears and persists an unavailable default while preserving a valid default", async () => {
  const saves = [];
  const ctx = {
    setActiveChatModel: () => {}, setBusy: () => {}, showMessage: () => {},
    listChatModelsAutoProxy: async () => ({ models: ["gpt-new", "gpt-other"] }),
    modelsByProvider: {}, persistModelsCache: () => {}, persistSettings: () => saves.push(entry.defaultModel),
    populateModelSelector: () => {}, recordProviderHealth: () => {}, renderChatProvidersList: () => {}, renderProviderState: () => {}, Date
  };
  const entry = { id: "codex", type: "codex", enabled: true, defaultModel: "gpt-old" };
  vm.runInNewContext(section("  function clearUnavailableCodexDefault(", "  function setModelOptions(") + section("  async function testSpecificProvider(", "  // 老的 testChatConnection"), ctx);
  await ctx.testSpecificProvider(entry);
  assert.equal(entry.defaultModel, "");
  assert.ok(saves.includes(""));
  entry.defaultModel = "gpt-new";
  await ctx.testSpecificProvider(entry);
  assert.equal(entry.defaultModel, "gpt-new");
});

test("refreshing the active Codex model list clears an obsolete default", () => {
  const entry = { id: "codex", type: "codex", defaultModel: "gpt-old" };
  let saved = false;
  const ctx = {
    global: { WpsAiProviderRegistry: { getActiveChatProvider: () => entry } },
    currentSettings: {}, modelsByProvider: {}, persistModelsCache: () => {},
    persistSettings: () => { saved = true; }, populateModelSelector: () => {}
  };
  vm.runInNewContext(section("  function clearUnavailableCodexDefault(", "  // 重新渲染 header 下拉"), ctx);
  ctx.setModelOptions(["gpt-new"], "gpt-old");
  assert.equal(entry.defaultModel, "");
  assert.equal(saved, true);
});
