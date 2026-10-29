const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");

function hostFor(paragraphs, selection) {
  const document = { Content: { Paragraphs: paragraphs } };
  const window = { Application: { ActiveDocument: document, Selection: selection }, WpsAiLog: { log() {} } };
  const ctx = { window, setTimeout, DOMException, console };
  vm.runInNewContext(fs.readFileSync(path.join(root, "js/hosts/writer.js"), "utf8"), ctx);
  return window.WpsAiHostWriter;
}
function fakeParagraphs(count) {
  const visits = [];
  return { Count: count, visits, Item(i) { visits.push(i); return { Style: { NameLocal: "正文" }, Range: { Font: { Name: "宋体", Size: 12 }, ParagraphFormat: { Alignment: 0, LineSpacing: 18 } } }; } };
}

test("format sampling is bounded, covers the document and does not read text", async () => {
  const paras = fakeParagraphs(10000);
  const host = hostFor(paras, { Range: { Start: 0, End: 0 } });
  const result = await host.sampleDocumentFormatting({ maxParagraphs: 20 });
  assert.equal(result.scope, "document");
  assert.equal(result.samples.length, 20);
  assert.equal(paras.visits.length, 20);
  assert.equal(paras.visits[0], 1);
  assert.equal(paras.visits.at(-1), 10000);
  assert.equal(result.samples[0].fontName, "宋体");
  assert.equal(result.samples[0].fontSize, 12);
});

test("format sampling uses the selected range and can be cancelled between batches", async () => {
  const paras = fakeParagraphs(1000);
  const selected = fakeParagraphs(100);
  const host = hostFor(paras, { Range: { Start: 1, End: 20, Paragraphs: selected } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(host.sampleDocumentFormatting({ maxParagraphs: 50, signal: controller.signal }), { name: "AbortError" });
  assert.equal(paras.visits.length, 0);
  assert.ok(selected.visits.length < 50);
});

test("skill summary uses bounded text history and rejects unrelated tool calls", async () => {
  const src = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  const start = src.indexOf("  function buildSkillSummaryHistory(");
  const end = src.indexOf("  // 复用：图标按钮", start);
  assert.ok(start >= 0 && end > start);
  const ctx = {};
  vm.runInNewContext(src.slice(start, end), ctx);
  const messages = ctx.buildSkillSummaryHistory([{ role: "user", content: "a".repeat(100000) }, { role: "user", content: "生成技能" }]);
  assert.ok(JSON.stringify(messages).length < 22000);
  assert.equal(messages.at(-1).content, "生成技能");
  const approve = ctx.skillSummaryApprover(null);
  assert.equal((await approve({ name: "wps_format_paragraph" })).approved, false);
  assert.equal((await approve({ name: "save_skill" })).approved, true);
});

test("document format skill requests use the restricted sampling tool policy", async () => {
  const src = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  const start = src.indexOf("  function buildSkillSummaryHistory(");
  const end = src.indexOf("  // 复用：图标按钮", start);
  const ctx = {};
  vm.runInNewContext(src.slice(start, end), ctx);
  assert.equal(ctx.isFormatSkillRequest("请读取当前文档格式并创建自定义技能"), true);
  assert.equal(ctx.isFormatSkillRequest("请修改文档格式"), false);
  const approve = ctx.skillSummaryApprover(null, true);
  assert.equal((await approve({ name: "wps_sample_document_formatting" })).approved, true);
  assert.equal((await approve({ name: "wps_read_document" })).approved, false);
});

test("format page scanning reports a resumable cursor", async () => {
  const paras = fakeParagraphs(200);
  const result = await hostFor(paras, null).sampleDocumentFormatting({ scope: "document", mode: "page", offset: 90, maxParagraphs: 15 });
  assert.equal(result.nextOffset, 105);
  assert.equal(paras.visits[0], 91);
  assert.equal(paras.visits.at(-1), 105);
});

test("read-only skill turns keep the document editable while showing progress", () => {
  const src = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  const start = src.indexOf("  function setChatBusy(");
  const end = src.indexOf("  // ===== 文档锁定", start);
  let locks = 0;
  let revisions = 0;
  const ctx = { els: {}, currentHostInfo: { host: "wps" }, currentSettings: {}, lockHostDocument: () => { locks++; }, unlockHostDocument: () => {}, applyReviseTurn: () => { revisions++; }, updateReviseActions: () => {}, setProgressStatus: () => {}, chatBusy: false, readOnlyChatTurn: false };
  vm.runInNewContext(src.slice(start, end), ctx);
  ctx.setChatBusy(true, { readOnly: true });
  ctx.setChatBusy(false);
  assert.equal(locks, 0);
  assert.equal(revisions, 0);
});

test("format tool passes cancellation to the read-only host sampler", async () => {
  const definitions = [];
  let options;
  const window = {
    WpsAiToolRegistry: { registerTool: (definition) => definitions.push(definition) },
    WpsAiHostWriter: { sampleDocumentFormatting: async (args) => { options = args; return { scope: "document" }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "js/tools/writer.js"), "utf8"), { window, console });
  const tool = definitions.find((definition) => definition.name === "wps_sample_document_formatting");
  assert.ok(tool);
  const signal = new AbortController().signal;
  assert.equal((await tool.handler({ scope: "document", maxParagraphs: 5 }, { signal })).scope, "document");
  assert.equal(options.signal, signal);
  assert.equal(options.maxParagraphs, 5);
});

test("skill summary includes only bounded successful formatting actions from the current conversation", () => {
  const src = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  const start = src.indexOf("  function buildSkillSummaryHistory(");
  const end = src.indexOf("  // 复用：图标按钮", start);
  const ctx = {};
  vm.runInNewContext(src.slice(start, end), ctx);
  const text = ctx.buildSkillOperationSummary([
    { type: "tool_call", name: "wps_format_selection", args: { font: "宋体", size: 12, text: "私密正文" } },
    { type: "tool_result", name: "wps_format_selection", result: { ok: true } },
    { type: "tool_call", name: "wps_format_paragraph", args: { alignment: "center" } },
    { type: "tool_result", name: "wps_format_paragraph", result: { ok: false } }
  ]);
  assert.match(text, /宋体/);
  assert.doesNotMatch(text, /私密正文|wps_format_paragraph/);
});
