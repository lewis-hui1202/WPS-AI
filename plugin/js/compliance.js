// WpsAiCompliance：文档合规检查（P2-2 MVP，参考易标 rejection-check 思路）。
//
// 用户给一份「检查清单」（招标要求 / 合同审查要点 / 内部规范，一行一条），
// AI 按清单逐块核查当前文档，命中问题定位原文加 Word 批注（复用 P1-3 批注基建），
// 按 severity 高/中/低分级。非破坏性：只加批注不改正文。
(function attachCompliance(global) {
  "use strict";

  const SEVERITY_LABELS = { high: "高", medium: "中", low: "低" };

  function buildChunkMessages(rulesText, chunkItems, lang) {
    const en = lang === "en";
    const sys = en
      ? 'You are a compliance reviewer. Check the text against the given checklist. Report ONLY violations or risks you can point to in the text. Output raw JSON: {"issues":[{"quote":"exact excerpt (<=40 chars)","rule":"which checklist item","severity":"high|medium|low","reason":"why it violates","suggestion":"how to fix"}]}. quote MUST be verbatim from the text. No issues -> {"issues":[]}.'
      : '你是合规审查员。按给定检查清单核查正文，只报告能在正文中指出的违规或风险点。只输出 raw JSON：{"issues":[{"quote":"原文精确摘录（≤40字）","rule":"命中清单里哪一条","severity":"high|medium|low","reason":"违规原因","suggestion":"整改建议"}]}。quote 必须逐字来自正文；没有问题输出 {"issues":[]}。';
    const user = [
      (en ? "[Checklist]\n" : "【检查清单】\n") + String(rulesText || "").trim(),
      (en ? "[Text to review]\n" : "【待审正文】\n") + chunkItems.map((it, i) => `[${i}] ${it.text}`).join("\n")
    ].join("\n\n");
    return [
      { role: "system", content: sys },
      { role: "user", content: user }
    ];
  }

  /**
   * 执行合规检查。复用 WpsAiProofread 的分块与定位（同一套段落位置语义）。
   * @returns {{ total, located, failed, chunks, stopped, bySeverity: {high,medium,low} }}
   */
  async function run({ rulesText, model, onProgress, parseJson, shouldStop } = {}) {
    const rules = String(rulesText || "").trim();
    if (!rules) throw new Error("请先填写检查清单。");
    const W = global.WpsAiHostWriter;
    const P = global.WpsAiProofread;
    if (!W?.readDocumentStructure || !W?.addCommentAtRange || !P?.buildChunks || !P?.locateQuote) {
      throw new Error("当前宿主不支持合规检查。");
    }
    const structure = await W.readDocumentStructure();
    const chunks = P.buildChunks(structure?.segments || []);
    if (!chunks.length) throw new Error("当前文档没有可审查的正文。");

    const lang = (() => { try { return global.WpsAiI18n?.resolvedLang?.() || "zh"; } catch (e) { return "zh"; } })();
    let total = 0, located = 0, failed = 0, stopped = false;
    const bySeverity = { high: 0, medium: 0, low: 0 };
    for (let ci = 0; ci < chunks.length; ci += 1) {
      if (shouldStop && shouldStop()) { stopped = true; break; }
      try { onProgress?.(ci + 1, chunks.length); } catch (e) {}
      let issues = [];
      try {
        const raw = await global.WpsAiOpenAI.chatCompletion({
          model: model || undefined,
          messages: buildChunkMessages(rules, chunks[ci], lang),
          temperature: 0.1
        });
        const parsed = (parseJson || JSON.parse)(String(raw || "").trim());
        issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
      } catch (e) {
        failed += 1;
        continue;
      }
      for (const issue of issues) {
        total += 1;
        const sev = ["high", "medium", "low"].includes(issue?.severity) ? issue.severity : "medium";
        bySeverity[sev] += 1;
        const pos = P.locateQuote(chunks[ci], issue?.quote);
        if (!pos) continue;
        const note = [
          `【文小舟 合规 · ${SEVERITY_LABELS[sev]}】`,
          issue?.rule ? `规则：${String(issue.rule).trim()}` : "",
          issue?.reason ? `问题：${String(issue.reason).trim()}` : "",
          issue?.suggestion ? `建议：${String(issue.suggestion).trim()}` : ""
        ].filter(Boolean).join("\n");
        try {
          await W.addCommentAtRange(pos.start, pos.end, note);
          located += 1;
        } catch (e) { /* 单条失败继续 */ }
      }
    }
    return { total, located, failed, chunks: chunks.length, stopped, bySeverity };
  }

  global.WpsAiCompliance = { run, buildChunkMessages, SEVERITY_LABELS };
})(window);
