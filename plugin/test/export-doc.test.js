const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("P2-6 导出 Word：proxy 端点 + writer 暴露 blocksToHtml + 预览导出按钮接线", () => {
  const proxy = fs.readFileSync(path.join(ROOT, "tools", "proxy-server.js"), "utf8");
  assert.match(proxy, /"\/export-doc"/);
  assert.match(proxy, /文小舟导出/);
  assert.match(proxy, /urn:schemas-microsoft-com:office:word/); // Word 兼容 HTML 头
  const writer = fs.readFileSync(path.join(ROOT, "js", "hosts", "writer.js"), "utf8");
  assert.match(writer, /blocksToHtml,\s*\/\/ 导出为新 Word 文件/);
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /exportFormatPreviewAsDoc/);
  assert.match(appJs, /\/export-doc/);
  assert.match(appJs, /applyHeadingNumbering\(blocks, numbering\)/); // 导出也带模板编号
  const html = fs.readFileSync(path.join(ROOT, "taskpane.html"), "utf8");
  assert.match(html, /id="formatPreviewExportBtn"/);
});
