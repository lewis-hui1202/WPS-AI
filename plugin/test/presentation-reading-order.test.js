const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("PPT 文本按页面上从上到下、同行从左到右读取，保留形状编号", () => {
  const orderSource = fs.readFileSync(path.join(__dirname, "../js/hosts/presentation-order.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(orderSource, context);
  const shapes = [
    { index: 1, text: "右侧正文", geometry: { top: 100, left: 300 } },
    { index: 2, text: "左侧正文", geometry: { top: 100, left: 10 } },
    { index: 3, text: "标题", geometry: { top: 20, left: 20 } }
  ];
  const sorted = context.window.WpsAiPresentationOrder.sort(shapes);
  assert.deepEqual(Array.from(sorted, (s) => s.index), [3, 2, 1]);
  assert.deepEqual(Array.from(shapes, (s) => s.index), [1, 2, 3]);
});
