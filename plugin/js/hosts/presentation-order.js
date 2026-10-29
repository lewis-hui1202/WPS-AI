(function (global) {
  "use strict";
  function position(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function sort(items) {
    return items.slice().sort((a, b) => {
      const ay = position(a.geometry?.top);
      const by = position(b.geometry?.top);
      if (ay !== null && by !== null && ay !== by) return ay - by;
      const ax = position(a.geometry?.left);
      const bx = position(b.geometry?.left);
      if (ax !== null && bx !== null && ax !== bx) return ax - bx;
      return a.index - b.index;
    });
  }
  global.WpsAiPresentationOrder = { sort };
  if (typeof module !== "undefined") module.exports = { sort };
})(typeof window !== "undefined" ? window : globalThis);
