(function (global) {
  "use strict";
  function shouldCompleteRemaining(answer, todos, events) {
    const text = String(answer || "");
    if (!/(已完成|全部完成|均已完成|全部写入成功|全部写入了)/.test(text)) return false;
    if (/(未完成|待处理|尚未|失败|部分完成|未成功|还需|剩余)/.test(text)) return false;
    if (!Array.isArray(todos) || !todos.some((t) => t.status === "pending" || t.status === "in_progress")) return false;
    if (todos.some((t) => t.status === "failed")) return false;
    if (!(events || []).some((e) => e.type === "tool_result" && e.result?.ok === true)) return false;
    if ((events || []).some((e) => e.type === "tool_result" && e.result?.ok === false)) return false;
    return true;
  }
  global.WpsAiTodoCompletion = { shouldCompleteRemaining };
  if (typeof module !== "undefined") module.exports = { shouldCompleteRemaining };
})(typeof window !== "undefined" ? window : globalThis);
