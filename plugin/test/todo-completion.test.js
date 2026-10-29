const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

test("明确全部完成且工具无失败时补齐遗漏的任务进度", () => {
  const { shouldCompleteRemaining } = require(path.join(__dirname, "../js/chat/todo-completion.js"));
  const todos = [{ id: "a", status: "completed" }, { id: "b", status: "pending" }];
  const events = [{ type: "tool_result", name: "wpp_set_notes", result: { ok: true } }];
  assert.equal(shouldCompleteRemaining("已完成，全 29 页均写入成功。", todos, events), true);
  assert.equal(shouldCompleteRemaining("前 28 页完成，第 29 页待处理。", todos, events), false);
  assert.equal(shouldCompleteRemaining("已完成。", todos, [{ type: "tool_result", result: { ok: false } }]), false);
  assert.equal(shouldCompleteRemaining("已完成。", [{ id: "a", status: "failed" }], events), false);
});
