// WpsAiProofread：批注式校对（P1-3，参考察元 spellCheckService 思路）。
//
// 流水线：readDocumentStructure 拿段落（带 start/end 位置）→ 按 ~6000 字符分块 →
// 逐块调模型（JSON：quote 精确摘录 + 类型 + 建议）→ locateQuote 把摘录映射回
// 文档字符区间 → Comments.Add 加 Word 批注精确定位。
//
// 与对话式「AI 检查校对」的区别：错误直接变成文档批注，点批注跳原文，
// 不在聊天里说「第三段有错别字」这种模糊话。非破坏性：只加批注不改正文。
(function attachProofread(global) {
  "use strict";

  const CHUNK_MAX_CHARS = 6000;
  const TYPE_LABELS = { typo: "错别字", grammar: "语病", punctuation: "标点", logic: "逻辑" };

  // 段落清单 → 分块（只取 kind=paragraph 的段，保留 start/end 供定位）
  function buildChunks(segments, maxChars = CHUNK_MAX_CHARS) {
    const chunks = [];
    let cur = [];
    let size = 0;
    (Array.isArray(segments) ? segments : []).forEach((seg) => {
      if (seg && seg.kind && seg.kind !== "paragraph") return;
      const text = String(seg?.text || "").trim();
      if (!text) return;
      if (size + text.length > maxChars && cur.length) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push({ text, start: Number(seg.start) || 0, end: Number(seg.end) || 0 });
      size += text.length;
    });
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  function normalizeForMatch(s) {
    return String(s || "").replace(/\s+/g, "");
  }

  // 把模型摘录的 quote 映射回文档字符区间。精确 indexOf 优先；
  // 空白差异时去空白匹配、退化为整段定位（批注落段首尾，仍可跳转）。
  function locateQuote(items, quote) {
    const q = String(quote || "").trim();
    if (!q) return null;
    for (const it of items) {
      const idx = it.text.indexOf(q);
      if (idx >= 0) return { start: it.start + idx, end: it.start + idx + q.length };
    }
    const nq = normalizeForMatch(q);
    if (!nq) return null;
    for (const it of items) {
      if (normalizeForMatch(it.text).includes(nq)) {
        return { start: it.start, end: Math.max(it.start + 1, it.end - 1) };
      }
    }
    return null;
  }

  function buildChunkMessages(chunkItems, lang) {
    const en = lang === "en";
    const sys = en
      ? 'You are a meticulous Chinese/any-language proofreader. Report ONLY definite issues: typos, grammar errors, punctuation misuse, logical contradictions. Output raw JSON only: {"issues":[{"quote":"exact excerpt from the text (<=40 chars)","type":"typo|grammar|punctuation|logic","suggestion":"fixed text","reason":"why"}]}. quote MUST be copied verbatim from the source. No issues -> {"issues":[]}.'
      : '你是严谨的校对员。只报告确定的问题：错别字、语法错误、标点误用、明显逻辑矛盾；风格偏好不算问题。只输出 raw JSON：{"issues":[{"quote":"原文精确摘录（≤40字）","type":"typo|grammar|punctuation|logic","suggestion":"修改后的文字","reason":"一句话原因"}]}。quote 必须逐字来自原文，禁止转述；没有问题输出 {"issues":[]}。';
    const body = chunkItems.map((it, i) => `[${i}] ${it.text}`).join("\n");
    return [
      { role: "system", content: sys },
      { role: "user", content: body }
    ];
  }

  /**
   * 执行批注式校对。
   * deps：宿主 writer / 模型调用 / JSON 解析 / 进度回调，由 app.js 注入（便于单测替身）。
   * @returns {{ total:number, located:number, failed:number, chunks:number }}
   */
  async function run({ model, onProgress, parseJson, shouldStop } = {}) {
    const W = global.WpsAiHostWriter;
    if (!W?.readDocumentStructure || !W?.addCommentAtRange) throw new Error("当前宿主不支持批注式校对。");
    const structure = await W.readDocumentStructure();
    const chunks = buildChunks(structure?.segments || []);
    if (!chunks.length) throw new Error("当前文档没有可校对的正文。");

    const lang = (() => { try { return global.WpsAiI18n?.resolvedLang?.() || "zh"; } catch (e) { return "zh"; } })();
    let total = 0, located = 0, failed = 0, stopped = false;
    for (let ci = 0; ci < chunks.length; ci += 1) {
      if (shouldStop && shouldStop()) { stopped = true; break; }
      try { onProgress?.(ci + 1, chunks.length); } catch (e) {}
      let issues = [];
      try {
        const raw = await global.WpsAiOpenAI.chatCompletion({
          model: model || undefined,
          messages: buildChunkMessages(chunks[ci], lang),
          temperature: 0.1
        });
        const parsed = (parseJson || JSON.parse)(String(raw || "").trim());
        issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
      } catch (e) {
        failed += 1;
        continue; // 单块失败跳过，不影响其它块
      }
      for (const issue of issues) {
        total += 1;
        const pos = locateQuote(chunks[ci], issue?.quote);
        if (!pos) continue;
        const label = TYPE_LABELS[issue?.type] || "校对";
        const note = `【文小舟 校对 · ${label}】${String(issue?.reason || "").trim()}${issue?.suggestion ? `\n建议：${String(issue.suggestion).trim()}` : ""}`;
        try {
          await W.addCommentAtRange(pos.start, pos.end, note);
          located += 1;
        } catch (e) { /* 单条批注失败继续 */ }
      }
    }
    return { total, located, failed, chunks: chunks.length, stopped };
  }

  global.WpsAiProofread = { run, buildChunks, locateQuote, CHUNK_MAX_CHARS };
})(window);
