(function attachChatTimeline(global) {
  "use strict";

  function stepStatusFromResult(result) {
    return (result && result.ok === false) ? "error" : "ok";
  }

  // turnEvents（app.js 累積的一輪事件）→ 有序步骤模型（扁平、不分组）。
  // tool_call 建 running 步骤；同名 tool_result 回填最近一个该名 running 步骤的状态+结果。
  // reasoning/assistant/error 直接映射成对应 kind。有序交织（文本块 vs 过程运行段）交给 buildTurnItems。
  function buildTurnSteps(turnEvents) {
    const steps = [];
    for (const ev of (turnEvents || [])) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "reasoning") {
        steps.push({ kind: "reasoning", status: "ok", text: ev.text || "", elapsedMs: ev.elapsedMs });
      } else if (ev.type === "tool_call") {
        steps.push({ kind: "tool", name: ev.name, status: "running", args: ev.args, _callTs: ev.ts });
      } else if (ev.type === "tool_result") {
        let hit = null;
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].kind === "tool" && steps[i].name === ev.name && steps[i].status === "running") { hit = steps[i]; break; }
        }
        if (hit) {
          hit.status = stepStatusFromResult(ev.result);
          hit.result = ev.result;
          // 工具耗时：tool_result.ts - tool_call.ts（回放侧）；两端 ts 缺失则不显示
          if (Number.isFinite(ev.ts) && Number.isFinite(hit._callTs)) hit.elapsedMs = ev.ts - hit._callTs;
        }
        else steps.push({ kind: "tool", name: ev.name, status: stepStatusFromResult(ev.result), result: ev.result });
      } else if (ev.type === "assistant") {
        steps.push({ kind: "text", status: "ok", text: ev.text || "" });
      } else if (ev.type === "error") {
        steps.push({ kind: "error", status: "error", text: ev.text || ev.message || "" });
      }
    }
    return steps;
  }

  // 一轮的「有序交织」模型（NO hoisting / NO 单条顶部摘要 / NO 过程-答案拆分）：
  // 顺着扁平步骤走，产出一串 item——三种 kind：
  //   - text：每条 assistant 正文（叙述与收尾结论一视同仁）各自成块。
  //   - run ：极大连续「工具 + 思考」段（只有 text/error 能打断它；思考折进 run，不打断）。
  //   - error：错误单独成块，且打断当前 run。
  // 关键：[tool][reasoning][tool] → 一个 run（2 个工具，思考折进去），不是两个「调用了 1 个工具」。
  // text/error 把 run 封口，之后的工具/思考另起一个新 run。
  // live（beginAssistantTurn）与 replay（renderAssistantTurn）都收敛到这同一份 item 列表 → DOM 一致。
  function buildTurnItems(steps) {
    const items = [];
    let run = null;
    for (const s of (steps || [])) {
      if (!s) continue;
      if (s.kind === "tool" || s.kind === "reasoning") {
        if (!run) { run = { kind: "run", items: [] }; items.push(run); }
        run.items.push(s);
      } else if (s.kind === "text") {
        // 空/空白正文（模型调工具前什么都没说）：整步跳过——不打断 run，也不建空文本块。
        // 与 live 的 setText/finalizeText 保持同一判定，确保 [tool][EMPTY-text][tool] 两路都合并成一个 run。
        if (String(s.text || "").trim() === "") continue;
        run = null;
        items.push({ kind: "text", status: "ok", text: s.text || "" });
      } else if (s.kind === "error") {
        run = null;
        items.push({ kind: "error", status: "error", text: s.text || "" });
      }
    }
    return items;
  }

  function toolCountOf(list) {
    let n = 0;
    for (const s of (list || [])) if (s.kind === "tool") n += 1;
    return n;
  }

  // 一批工具的整体状态：任一 error → error；否则任一 running → running；否则 ok。
  // run 摘要的状态点只由工具决定（思考不影响状态），live 与 replay 共用。
  function groupStatusOf(tools) {
    let anyError = false, anyRunning = false;
    for (const t of (tools || [])) {
      if (t.status === "error") anyError = true;
      else if (t.status === "running") anyRunning = true;
    }
    return anyError ? "error" : (anyRunning ? "running" : "ok");
  }

  function runStatus(items) {
    const tools = [];
    for (const s of (items || [])) if (s.kind === "tool") tools.push(s);
    return groupStatusOf(tools);
  }

  // 工具分类：mcp__ 前缀 → MCP 客户端工具；skill 前缀 → 技能；其余 → 普通工具。
  // 让「调用了 N 个工具」拆成「调用了 X 个工具 · Y 个技能 · Z 个 MCP」，各归各计数。
  function toolCategory(name) {
    const n = String(name || "");
    if (n.indexOf("mcp__") === 0) return "mcp";
    if (n === "use_skill" || n === "invoke_skill" || /^skill[_.:]|__skill__/i.test(n)) return "skill";
    return "tool";
  }
  function countByCategory(items) {
    const c = { tool: 0, skill: 0, mcp: 0 };
    for (const s of (items || [])) if (s.kind === "tool") c[toolCategory(s.name)] += 1;
    return c;
  }
  // 工具行显示名：use_skill → 「技能：<技能名>」；mcp__svc__tool → 「tool @svc」；其余原样。
  function toolDisplayName(tool) {
    const n = String((tool && tool.name) || "");
    if (n === "use_skill" || n === "invoke_skill") {
      const sk = tool && tool.args && tool.args.name;
      return sk ? (i18nText("技能") + "：" + sk) : i18nText("调用技能");
    }
    if (n === "save_skill") {
      const sk = tool && tool.args && tool.args.name;
      return i18nText("保存技能") + (sk ? "：" + sk : "");
    }
    if (n.indexOf("mcp__") === 0) {
      const rest = n.slice(5);
      const i = rest.indexOf("__");
      return i > 0 ? (rest.slice(i + 2) + " @" + rest.slice(0, i)) : rest;
    }
    return n;
  }

  // run 摘要收起头的文案：有调用 → 「调用了 X 个工具 · Y 个技能 · Z 个 MCP」（只列非零，含折进来的思考不计数）；
  // 否则（纯思考 run）→ 「思考过程」。
  function runLabel(items) {
    const c = countByCategory(items);
    if (c.tool + c.skill + c.mcp > 0) return toolGroupLabel(items);
    return i18nText("思考过程");
  }
  // run 收起头图标：有调用 → 工具图标；纯思考 → 灯泡（思考）图标。
  function runIconSvg(items) {
    const c = countByCategory(items);
    return (c.tool + c.skill + c.mcp > 0) ? TOOL_ICON_SVG : THINKING_ICON_SVG;
  }

  // 线性图标（stroke=currentColor，无 emoji/无色块）。
  const THINKING_ICON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 13h3.6M6.7 14.5h2.6"/><path d="M8 1.6a4.4 4.4 0 0 0-2.7 7.9c.5.4.9.9.9 1.5h3.6c0-.6.4-1.1.9-1.5A4.4 4.4 0 0 0 8 1.6Z"/></svg>';
  const TOOL_ICON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.1 2.2a3 3 0 0 0-3.6 3.9L2.4 11.2a1.3 1.3 0 0 0 1.9 1.9l5.1-5.1a3 3 0 0 0 3.9-3.6l-1.9 1.9-1.4-.4-.4-1.4 1.6-1.9Z"/></svg>';
  const STEP_ICON_SVG = THINKING_ICON_SVG; // 兼容旧引用

  // 事件在真实浏览器里用 addEventListener；测试用的最小 document stub 没有这个方法，
  // 静默跳过即可——本任务只保证结构正确，交互由真实 DOM 环境负责。
  function on(el, evt, handler) {
    if (el && typeof el.addEventListener === "function") el.addEventListener(evt, handler);
  }

  function safeStringify(v) {
    if (v === undefined) return "";
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }

  function formatMeta(meta) {
    const m = meta || {};
    const parts = [];
    if (m.model) parts.push(String(m.model));
    if (Number.isFinite(m.elapsedMs)) parts.push((m.elapsedMs / 1000).toFixed(1) + "s");
    return parts.join(" · ");
  }

  // 单步耗时展示：0.1s 精度（与轮 meta 同款）。非法/负值 → 空串（不显示）。
  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    return (ms / 1000).toFixed(1) + "s";
  }

  function stepDetailText(step) {
    if (step.kind === "reasoning") return step.text || "";
    const parts = [];
    if (step.args !== undefined) parts.push("args: " + safeStringify(step.args));
    if (step.result !== undefined) parts.push("result: " + safeStringify(step.result));
    return parts.join("\n");
  }

  // 动态中文文案走 WpsAiI18n.t（DICT_EN 已配词条）；无 i18n 环境（单测）时退化成原文。
  // i18n 覆盖率正则只扫 `.textContent = "…"` / showMessage() 等字面量赋值，扫不到这里的函数入参，
  // 所以「思考过程」「调用了 {n} 个工具」均已手动在 js/i18n.js 的 DICT_EN 补齐。
  function i18nText(zh, vars) {
    const I18N = global.WpsAiI18n;
    if (I18N && typeof I18N.t === "function") return I18N.t(zh, vars);
    // 无 i18n 环境（单测）：仍手动把 {var} 插值掉，避免文案里残留 {parts}/{n}
    let s = zh;
    if (vars) for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
    return s;
  }

  // 工具计数文案：按类别拆分「调用了 X 个工具 · Y 个技能 · Z 个 MCP」，只列非零项。
  function toolGroupLabel(items) {
    const c = countByCategory(items);
    const parts = [];
    if (c.tool) parts.push(i18nText("{n} 个工具", { n: c.tool }));
    if (c.skill) parts.push(i18nText("{n} 个技能", { n: c.skill }));
    if (c.mcp) parts.push(i18nText("{n} 个 MCP 工具", { n: c.mcp }));
    return i18nText("调用了 {parts}", { parts: parts.join(" · ") });
  }

  // run 摘要展开体里的单行：一个工具（名称 + 状态点 + args/result 详情）。
  function makeToolRow(tool) {
    const doc = document;
    const row = doc.createElement("div");
    row.className = "tl-tool-row";

    const head = doc.createElement("div");
    head.className = "tl-tool-row-head";

    const ic = doc.createElement("span");
    ic.className = "tl-step-icon tl-row-icon";
    ic.innerHTML = TOOL_ICON_SVG;
    head.appendChild(ic);

    const name = doc.createElement("span");
    name.className = "tl-step-name";
    name.textContent = toolDisplayName(tool);
    head.appendChild(name);

    const durTxt = fmtDur(tool.elapsedMs);
    if (durTxt) {
      const dur = doc.createElement("span");
      dur.className = "tl-step-dur";
      dur.textContent = durTxt;
      head.appendChild(dur);
    }

    const status = doc.createElement("span");
    status.className = "tl-step-status tl-step-status-" + (tool.status || "ok");
    head.appendChild(status);

    row.appendChild(head);

    const detail = doc.createElement("div");
    detail.className = "tl-tool-row-detail";
    detail.textContent = stepDetailText(tool);
    row.appendChild(detail);

    return { row: row, statusEl: status, detailEl: detail };
  }

  // 定稿 assistant 正文/中间叙述按 markdown 渲染（复用全 app 信任的 WpsAiMarkdown.renderToHtml
  // 已消毒输出）。markdown-render.js 在 timeline.js 之前加载；缺失时降级纯文本。
  // 批量/回放与实时定稿共用它，保证 live==replay 的正文 DOM 一致。绝不注入 renderToHtml 之外的裸 innerHTML。
  function renderFinalText(el, text) {
    const md = global.WpsAiMarkdown;
    if (md && typeof md.renderToHtml === "function") {
      el.innerHTML = md.renderToHtml(text || "");
    } else {
      el.textContent = text || "";
    }
  }

  function toggleHidden(node) {
    const hidden = typeof node.hasAttribute === "function" ? node.hasAttribute("hidden") : true;
    if (hidden) {
      if (typeof node.removeAttribute === "function") node.removeAttribute("hidden");
    } else {
      node.setAttribute("hidden", "");
    }
  }

  // run 摘要展开体里的一项，按原始顺序渲染（run 只含 tool / reasoning）：
  // - tool     → 复用 makeToolRow（名称/状态/args/result，textContent）
  // - reasoning→ 思考文本（textContent）
  function renderRunItem(item) {
    const doc = document;
    if (item.kind === "tool") return makeToolRow(item).row;
    if (item.kind === "reasoning") {
      const d = doc.createElement("div");
      d.className = "tl-proc-reasoning";
      const hd = doc.createElement("div");
      hd.className = "tl-proc-reasoning-head";
      const ic = doc.createElement("span");
      ic.className = "tl-step-icon tl-row-icon";
      ic.innerHTML = THINKING_ICON_SVG; // 思考图标
      hd.appendChild(ic);
      const lbl = doc.createElement("span");
      lbl.className = "tl-proc-reasoning-label";
      lbl.textContent = i18nText("思考过程");
      hd.appendChild(lbl);
      const durTxt = fmtDur(item.elapsedMs);
      if (durTxt) {
        const dur = doc.createElement("span");
        dur.className = "tl-step-dur";
        dur.textContent = durTxt;
        hd.appendChild(dur);
      }
      d.appendChild(hd);
      const body = doc.createElement("div");
      body.className = "tl-proc-reasoning-text";
      body.textContent = item.text || "";
      d.appendChild(body);
      return d;
    }
    // 理论上 run 里不会有其它 kind；兜底成纯文本，绝不注入裸 innerHTML。
    const d = doc.createElement("div");
    d.className = "tl-proc-text";
    d.textContent = item.text || "";
    return d;
  }

  // run 摘要：一段极大连续「工具 + 思考」聚成一行 .tl-step.tl-step-process（收起头 data-expandable=1）
  // + 初始隐藏的 .tl-step-detail（内含按原始顺序的每一项）。批量回放与实时增量都经此构造，
  // 保证 live==replay 的 run 摘要 DOM 一致。expandTools 对应「显示工具调用详情」默认展开。
  function buildRunSummary(items, expandTools) {
    const doc = document;
    const list = items || [];
    const el = doc.createElement("div");
    el.className = "tl-step tl-step-process";
    el.setAttribute("data-expandable", "1");

    const head = doc.createElement("div");
    head.className = "tl-step-head";

    const icon = doc.createElement("span");
    icon.className = "tl-step-icon";
    icon.innerHTML = runIconSvg(list); // 有调用→工具图标；纯思考→思考图标
    head.appendChild(icon);

    const nameEl = doc.createElement("span");
    nameEl.className = "tl-step-name";
    nameEl.textContent = runLabel(list);
    head.appendChild(nameEl);

    // 收起行也显示这一段的总耗时（各工具/思考耗时之和），不用展开就能看到。
    // 放独立 span（非 .tl-step-name），railItems 只比 label/status/计数，不影响 live==replay。
    const totalMs = list.reduce((a, s) => a + (Number.isFinite(s.elapsedMs) ? s.elapsedMs : 0), 0);
    const totalTxt = totalMs > 0 ? fmtDur(totalMs) : "";
    if (totalTxt) {
      const dur = doc.createElement("span");
      dur.className = "tl-step-dur";
      dur.textContent = totalTxt;
      head.appendChild(dur);
    }

    const statusEl = doc.createElement("span");
    statusEl.className = "tl-step-status tl-step-status-" + runStatus(list);
    head.appendChild(statusEl);

    el.appendChild(head);

    const detail = doc.createElement("div");
    detail.className = "tl-step-detail";
    detail.setAttribute("hidden", "");
    for (const item of list) detail.appendChild(renderRunItem(item));
    el.appendChild(detail);

    on(head, "click", () => { toggleHidden(detail); });

    // 「显示工具调用详情」：run 详情默认展开（live 与 replay 走同一分支，保持 DOM 一致）。
    if (expandTools && typeof detail.removeAttribute === "function") detail.removeAttribute("hidden");

    return el;
  }

  // 文本块：一个 .tl-step.tl-text，assistant markdown → renderFinalText。叙述与收尾结论共用它。
  function renderTextBlock(step) {
    const doc = document;
    const el = doc.createElement("div");
    el.className = "tl-step tl-text";
    renderFinalText(el, step.text || "");
    return el;
  }

  // 错误块（轮内、独立成块）：一个 .tl-step.tl-error，textContent（不注入裸 innerHTML）。
  function renderErrorBlock(item) {
    const doc = document;
    const el = doc.createElement("div");
    el.className = "tl-step tl-error";
    el.textContent = (item && item.text) || "";
    return el;
  }

  // 用户块：文档流一条 .tl-msg.tl-user；quickAction 时渲成一行可展开的操作盒子。
  function renderUserMessage(opts) {
    const o = opts || {};
    const doc = document;
    const wrap = doc.createElement("div");
    wrap.className = "tl-msg tl-user";
    // 这条消息的原始文本，供气泡内「复制 / 填回输入框」按钮取用（app.js 事件委托读取）
    wrap.setAttribute("data-msg-text", o.text || (o.quickAction && o.quickAction.prompt) || "");

    const label = doc.createElement("div");
    label.className = "tl-label";
    label.textContent = "你";
    wrap.appendChild(label);

    // 消息内顶部操作：复制这条 / 把这条填回聊天输入框
    const actions = doc.createElement("div");
    actions.className = "tl-user-actions";
    const mkAct = (act, title, svg) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "tl-user-act";
      b.setAttribute("data-user-act", act);
      b.title = title;
      b.innerHTML = svg;
      return b;
    };
    actions.appendChild(mkAct("copy", "复制这条消息", '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'));
    actions.appendChild(mkAct("refill", "把这条消息填回输入框", '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/></svg>'));
    wrap.appendChild(actions);

    const body = doc.createElement("div");
    body.className = "tl-body";

    if (o.quickAction && o.quickAction.label) {
      wrap.setAttribute("data-quickaction", "1");

      const row = doc.createElement("div");
      row.className = "tl-quickaction-row";

      const toggle = doc.createElement("button");
      toggle.className = "tl-quickaction-toggle";
      toggle.textContent = o.quickAction.label;
      row.appendChild(toggle);

      const detail = doc.createElement("div");
      detail.className = "tl-quickaction-detail";
      detail.textContent = o.quickAction.prompt || "";
      detail.setAttribute("hidden", "");
      row.appendChild(detail);

      on(toggle, "click", () => { toggleHidden(detail); });

      body.appendChild(row);
    } else {
      body.textContent = o.text || "";
    }

    wrap.appendChild(body);
    return wrap;
  }

  // AI 块外壳：.tl-msg.tl-assistant + 元信息 + 空 .tl-rail。
  // 批量渲染（renderAssistantTurn）与实时增量渲染（beginAssistantTurn）共用同一个外壳构造，
  // 保证「实时流式」与「历史回放」产出的 DOM 结构一致。轨道里按事件顺序交织若干文本块 / run 摘要 / 错误块。
  function buildAssistantShell(meta) {
    const doc = document;
    const wrap = doc.createElement("div");
    wrap.className = "tl-msg tl-assistant";

    const label = doc.createElement("div");
    label.className = "tl-label";
    label.textContent = "文小舟";
    wrap.appendChild(label);

    const metaEl = doc.createElement("div");
    metaEl.className = "tl-meta";
    metaEl.textContent = formatMeta(meta);
    wrap.appendChild(metaEl);

    const rail = doc.createElement("div");
    rail.className = "tl-rail";
    wrap.appendChild(rail);

    return { wrap: wrap, metaEl: metaEl, rail: rail };
  }

  // 展开一个 run 摘要节点的展开体（去掉 hidden）。
  function setStepExpanded(node) {
    const d = node && typeof node.querySelector === "function" ? node.querySelector(".tl-step-detail") : null;
    if (d && typeof d.removeAttribute === "function") d.removeAttribute("hidden");
  }

  // 把一串 item 依序渲进轨道（text→文本块，run→run 摘要，error→错误块）。
  // 批量回放与实时增量收尾都用它，保证同一 item 列表 → 同一 DOM。
  function appendItem(rail, item, expandTools) {
    if (item.kind === "text") return rail.appendChild(renderTextBlock(item));
    if (item.kind === "error") return rail.appendChild(renderErrorBlock(item));
    return rail.appendChild(buildRunSummary(item.items || [], expandTools));
  }

  // AI 块（批量）：从完整 steps 一次性构建，供历史回放用。
  // steps 为扁平有序步骤（buildTurnSteps 产出）；这里做 buildTurnItems → 有序交织的文本块 / run 摘要 / 错误块，
  // 与 live 的 beginAssistantTurn 收敛到同一结构。expandTools 对应「显示工具调用详情」。
  function renderAssistantTurn(opts) {
    const o = opts || {};
    const shell = buildAssistantShell(o.meta);
    const items = buildTurnItems(o.steps || []);
    for (const item of items) appendItem(shell.rail, item, !!o.expandTools);
    return shell.wrap;
  }

  // AI 块（增量）：先建空外壳，返回一组把「一个流式事件」映射成「节点操作」的方法。
  //
  // 收敛策略（保证 live==replay）：维护「当前打开的 run」和「当前打开的文本块」，二者互斥地作为轨道尾巴：
  // - 工具 / 思考 → 若有打开的文本块先封口（留在轨道里可见），再折进当前 run（无则新建 run，appendChild 到尾部）。
  //   思考折进 run 不打断它；只有文本 / 错误能封口一个 run。
  // - 文本 → 封口当前 run（run 节点留在轨道里），再流式进一个新的文本块。
  // - 错误 → 封口 run 与文本块，独立追加一个错误块。
  // 每次 run 结构变化就用 buildRunSummary 从该 run 的 items 整体重建其节点（replaceChild），
  // 与 replay 走同一构造函数 → 逐字节一致。轨道里的元素永远按事件顺序追加，无需 insertBefore。
  function beginAssistantTurn(opts) {
    const o = opts || {};
    const shell = buildAssistantShell(o.meta);
    const rail = shell.rail;
    let expandProc = !!o.expandTools; // 「显示工具调用详情」→ run 详情默认展开

    let openRun = null;         // 当前打开的 run：{ items:[], node }
    let openReasoning = null;   // 当前打开的（流式）思考项（openRun.items 里的引用）
    let textStep = null;        // 当前文本块步骤 { kind:"text", text }
    let textNode = null;        // 当前文本块 DOM 节点（流式/定稿）

    // 流式实时 markdown 预览：每来一段增量就按 markdown 重渲染，但节流到 ~100ms/次，
    // 避免每帧解析 + 重排富文本卡顿。半截 markdown（未闭合的 ``` / ** / 表格）renderToHtml
    // 会按已有内容尽力渲染，闭合后自动纠正——实时预览可接受的短暂抖动。
    let _liveRenderTs = 0;
    let _liveRenderTimer = null;
    // setTimeout/clearTimeout 在纯逻辑测试沙箱里可能不存在——不可用时退化为同步渲染，
    // 既保证 live==replay 的最终 DOM 一致，生产环境里照常节流。
    const _hasTimer = (typeof setTimeout === "function") && (typeof clearTimeout === "function");
    function clearLiveRender() { if (_liveRenderTimer) { clearTimeout(_liveRenderTimer); _liveRenderTimer = null; } }
    function flushLiveRender() {
      if (!textNode || !textStep) return;
      _liveRenderTs = Date.now();
      renderFinalText(textNode, textStep.text || "");
    }
    function scheduleLiveRender() {
      if (_liveRenderTimer) return; // 已排了尾随渲染
      const wait = 100 - (Date.now() - _liveRenderTs);
      if (wait <= 0 || !_hasTimer) { flushLiveRender(); return; }
      _liveRenderTimer = setTimeout(() => { _liveRenderTimer = null; flushLiveRender(); }, wait);
    }

    // 从 run.items 整体重建其摘要节点（与 replay 同一构造函数）。首次为 appendChild，之后 replaceChild。
    function rebuildRun(run) {
      const fresh = buildRunSummary(run.items, expandProc);
      if (run.node && typeof rail.replaceChild === "function") rail.replaceChild(fresh, run.node);
      else rail.appendChild(fresh);
      run.node = fresh;
    }

    // 封口当前文本块：定稿成 markdown（若还只是流式纯文本），留在轨道里可见，清掉「当前文本块」指针。
    function closeText() {
      if (textStep) {
        clearLiveRender();
        if (textNode) renderFinalText(textNode, textStep.text || "");
        textStep = null;
        textNode = null;
      }
    }

    // 封口当前 run：节点已在轨道里且已渲染，只需清掉「当前 run」指针，后续工具/思考另起新 run。
    function closeRun() {
      openRun = null;
      openReasoning = null;
    }

    function ensureRun() {
      if (!openRun) openRun = { items: [], node: null };
    }

    function ensureTextNode() {
      if (!textStep) {
        textStep = { kind: "text", status: "ok", text: "" };
        textNode = renderTextBlock(textStep);
        rail.appendChild(textNode);
      }
    }

    // reasoning_chunk / 内联 <think>：整段（累积）文本刷进当前思考项，思考折进当前 run。
    // 思考前若有打开的文本块，先封口它（文本打断 → 之后的工具/思考另起 run）。
    function updateReasoning(fullText) {
      closeText();
      ensureRun();
      if (!openReasoning) {
        openReasoning = { kind: "reasoning", status: "running", text: "", _startTs: Date.now() };
        openRun.items.push(openReasoning);
      }
      openReasoning.text = fullText || "";
      rebuildRun(openRun);
    }
    // reasoning_end / 开始出正文：把思考项收尾（running→ok）。注意——不封口 run，
    // 后续工具仍折进同一 run（[tool][reasoning][tool] = 一个 run）。之后再来思考另起一项。
    function endReasoning() {
      if (!openReasoning) return;
      openReasoning.status = "ok";
      if (Number.isFinite(openReasoning._startTs)) openReasoning.elapsedMs = Date.now() - openReasoning._startTs;
      openReasoning = null;
      if (openRun) rebuildRun(openRun);
    }
    // tool_call：追加一个 running 工具项，折进当前 run（无则新建）。返回步骤引用（带回指其 run）。
    function addToolStep(name, args) {
      closeText();
      ensureRun();
      const tool = { kind: "tool", status: "running", name: name, args: args, _run: openRun, _startTs: Date.now() };
      openRun.items.push(tool);
      openReasoning = null; // 工具打断思考流（下一段思考另起一项，但仍在同一 run 内）
      rebuildRun(openRun);
      return tool;
    }
    // 「显示工具调用详情」：展开当前 run 详情（与批量回放的 expandTools 走同一构造分支）。
    function expandToolStep(ref) {
      expandProc = true;
      const run = (ref && ref._run) || openRun;
      if (run && run.node) setStepExpanded(run.node);
    }
    // tool_result：把该工具行置 ok/error + 挂 result，并重建其所属 run（刷新计数/状态）。
    function finishToolStep(ref, result) {
      if (!ref) return;
      ref.status = stepStatusFromResult(result);
      ref.result = result;
      if (Number.isFinite(ref._startTs)) ref.elapsedMs = Date.now() - ref._startTs;
      const run = ref._run || openRun;
      if (run) rebuildRun(run);
    }
    // assistant_chunk：把（累积的可见）正文刷进文本块。文本打断 run → 先封口当前 run。
    // 流式中间态按 markdown 实时预览（scheduleLiveRender 节流到 ~100ms/次）。
    // 空/空白（累积文本还没出字，或模型调工具前什么都没说）：整次调用是 no-op——不封口 run，
    // 不建空文本节点，留着 run 等后面的工具折进来。与 buildTurnItems 的空文本判定保持一致（live==replay）。
    // 累积文本第一次变成非空的那一次才真正封口 run + 建文本节点；之后每次都是同一节点上刷新内容。
    function setText(fullText) {
      const t = fullText || "";
      if (t.trim() === "") return;
      closeRun();
      ensureTextNode();
      textStep.text = t;
      scheduleLiveRender(); // 实时 markdown 预览（节流），替代旧的纯 textContent
    }
    // assistant_text_end/assistant_text：定稿当前文本块（按 markdown 渲染，与批量/回放同一函数）。
    // 空/空白正文同样是全 no-op：不封口 run、不建/不留空节点（对应的 setText 早已是 no-op，run 仍开着）。
    function finalizeText(fullText) {
      const t = fullText || "";
      if (t.trim() === "") return;
      closeRun();
      ensureTextNode();
      textStep.text = t;
      clearLiveRender();
      renderFinalText(textNode, t);
    }
    // tool_call 打断前：把当前流式文本块封口留在轨道里（新模型里文本永远可见，不再降级进过程）。
    function sealText() {
      closeText();
    }
    function addError(text) {
      closeText();
      closeRun();
      const node = renderErrorBlock({ kind: "error", text: text || "" });
      rail.appendChild(node);
      return node;
    }
    function setMeta(meta) {
      shell.metaEl.textContent = formatMeta(meta);
    }

    return {
      node: shell.wrap,
      rail: rail,
      updateReasoning: updateReasoning,
      endReasoning: endReasoning,
      addToolStep: addToolStep,
      expandToolStep: expandToolStep,
      finishToolStep: finishToolStep,
      setText: setText,
      finalizeText: finalizeText,
      sealText: sealText,
      addError: addError,
      setMeta: setMeta
    };
  }

  // 文档流红条：出错提示（顶层消息，与轮内错误块 renderErrorBlock 区分）。
  function renderErrorMessage(text) {
    const doc = document;
    const el = doc.createElement("div");
    el.className = "tl-msg tl-error";
    el.textContent = text || "";
    return el;
  }

  global.WpsAiChatTimeline = {
    buildTurnSteps,
    buildTurnItems,
    stepStatusFromResult,
    buildRunSummary,
    renderUserMessage,
    renderAssistantTurn,
    beginAssistantTurn,
    renderErrorMessage
  };
})(window);
