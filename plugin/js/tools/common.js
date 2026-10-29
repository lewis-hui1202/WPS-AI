(function attachCommonTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  function IMAGE_PROXY_BASE() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }

  async function postJson(url, body) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(payload.error || `${url} ${resp.status}`);
    }
    return payload;
  }

  async function uploadImageDataUrl(dataUrl) {
    const payload = await postJson(`${IMAGE_PROXY_BASE()}/upload-image`, { dataUrl });
    if (!payload.path) throw new Error("/upload-image 未返回本地文件路径");
    return payload.path;
  }

  function fileUrlToPath(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "file:") return raw;
      let p = decodeURIComponent(url.pathname || "");
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return p || raw;
    } catch (e) {
      return raw.replace(/^file:\/\//i, "");
    }
  }

  async function ensureLocalImagePath(fileName) {
    const raw = String(fileName || "").trim();
    if (!raw) throw new Error("缺少图片路径 fileName。");
    if (/^data:image\//i.test(raw)) {
      return uploadImageDataUrl(raw);
    }
    if (/^https?:\/\//i.test(raw)) {
      const fetched = await postJson(`${IMAGE_PROXY_BASE()}/fetch-remote-image`, { url: raw });
      if (!fetched.dataUrl) throw new Error("/fetch-remote-image 未返回 dataUrl");
      return uploadImageDataUrl(fetched.dataUrl);
    }
    if (/^file:\/\//i.test(raw)) {
      return fileUrlToPath(raw);
    }
    return raw;
  }

  global.WpsAiImageAssets = Object.assign({}, global.WpsAiImageAssets || {}, {
    ensureLocalImagePath
  });

  registry.registerTool({
    name: "get_host_info",
    hosts: ["*"],
    description: "查询当前 WPS 宿主类型（wps=文字 / et=表格 / wpp=演示 / pdf=PDF）以及活动文档名称。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const info = await global.WpsAiDocument.getHostInfo();
      const app = await global.WpsAiDocument.getApplication();
      let docName = null;
      try {
        if (app?.ActiveWorkbook) docName = app.ActiveWorkbook.Name;
        else if (app?.ActivePresentation) docName = app.ActivePresentation.Name;
        else if (app?.ActivePDF) docName = app.ActivePDF.Name || app.ActivePDF.FileName;
        else if (app?.ActivePdf) docName = app.ActivePdf.Name || app.ActivePdf.FileName;
        else if (app?.ActiveDocument) docName = app.ActiveDocument.Name;
      } catch (e) { /* ignore */ }
      return { host: info.host, label: info.label, document: docName };
    }
  });

  registry.registerTool({
    name: "reveal_location",
    hosts: ["wps", "et", "wpp"],
    description: "把用户的视线引导到文档的某个位置：滚动到该处并高亮/选中，让用户看到你正在关注或操作的区域。不修改文档内容。按当前宿主传对应参数——Word 文字传 findText（要定位的原文片段），Excel 表格传 range（单元格区域），PPT 演示传 slide（幻灯片序号）。适合：操作前先让用户看清目标位置，或纯阅读时引导用户查看某段。",
    parameters: {
      type: "object",
      properties: {
        findText: { type: "string", description: "Word 文字文档：要定位并高亮的原文片段（尽量精确、20 字以内的连续原文）。" },
        range: { type: "string", description: "Excel 表格：要定位的单元格区域，如 A1 或 A1:C3。" },
        sheet: { type: "string", description: "Excel 表格：工作表名，留空表示当前工作表。" },
        slide: { type: "integer", description: "PPT 演示：要跳转到的幻灯片序号（从 1 起）。" }
      }
    },
    handler: async ({ findText, range, sheet, slide } = {}) => {
      if (!global.WpsAiFollow?.revealLocation) throw new Error("定位模块未加载。");
      const info = await global.WpsAiDocument.getHostInfo();
      const host = info?.host || "";
      return global.WpsAiFollow.revealLocation(host, { findText, range, sheet, slide });
    }
  });

  registry.registerTool({
    name: "suggest_quick_actions",
    hosts: ["*"],
    description: "向用户推荐一组当前文档场景下可执行的快捷操作。actions 中每一条会被渲染成一个按钮，用户点击后会自动以你给出的 prompt 作为下一条用户消息发送给你。请确保 prompt 是自洽的、明确指定要调用哪些工具完成什么。",
    parameters: {
      type: "object",
      required: ["actions"],
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            required: ["label", "prompt"],
            properties: {
              label: { type: "string", description: "按钮上显示的简短标签，控制在 12 个汉字以内" },
              prompt: { type: "string", description: "用户点击后将作为下一条消息发送的完整指令" }
            }
          }
        }
      }
    },
    handler: async ({ actions }) => {
      const cleaned = (actions || [])
        .filter((a) => a && typeof a.label === "string" && typeof a.prompt === "string")
        .map((a) => ({ label: a.label.trim(), prompt: a.prompt.trim() }))
        .filter((a) => a.label && a.prompt);
      // UI 层会监听 tool_result 事件、读取 value.actions 把它们渲染成按钮
      return { count: cleaned.length, actions: cleaned };
    }
  });

  // 技能：改成「AI 显式调用」模式（渐进式披露）。system prompt 里只列技能名+简介，
  // AI 判断某个技能匹配当前任务时调本工具加载它的完整指引，再照做。好处：省 token + 时间轴里单独成一步计数。
  registry.registerTool({
    name: "use_skill",
    hosts: ["wps", "et", "wpp", "pdf"],
    description: "加载并应用一个技能(skill)的完整指引。当任务匹配系统提示「可用技能」清单里的某个技能时调用：name 传技能名，工具返回该技能的详细指引，你据此执行。不匹配就别调。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "技能名（见系统提示的可用技能清单）" } }
    },
    handler: async ({ name } = {}) => {
      const Skills = global.WpsAiSkills;
      if (!Skills || typeof Skills.getEnabledSkills !== "function") throw new Error("技能模块未加载。");
      const enabled = Skills.getEnabledSkills() || [];
      const want = String(name == null ? "" : name).trim();
      const skill = enabled.find((s) => s.name === want)
        || enabled.find((s) => String(s.name).trim() === want)
        || enabled.find((s) => String(s.name).trim().toLowerCase() === want.toLowerCase());
      if (!skill) {
        const names = enabled.map((s) => s.name).join(" / ");
        throw new Error(`没有启用的技能叫「${want}」。当前可用技能：${names || "（无）"}`);
      }
      const content = await Skills.loadContent(skill);
      if (!content) throw new Error(`技能「${skill.name}」内容为空或加载失败。`);
      return { skill: skill.name, description: skill.description || "", content };
    }
  });

  // 把当前这套操作沉淀成技能 / 持续优化技能：同名用户技能→更新，否则新建，保存后自动启用。
  registry.registerTool({
    name: "save_skill",
    hosts: ["wps", "et", "wpp", "pdf"],
    description: "把当前这套有用的操作 / 做法沉淀成一个可复用的文小舟技能，或优化已有技能。用户说「把刚才的操作总结成技能」「记住这个做法」「优化 XX 技能」时调用。name=技能名（已有同名用户技能则更新它=持续优化）；description=一句话说明什么场景用（写清楚，你以后靠它判断何时 use_skill）；content=详细做法指引（markdown：步骤 / 要点 / 坑 / 关键参数）。只保存技能内容，不执行任何文档操作、不改动当前文档，保存后自动启用。",
    parameters: {
      type: "object",
      required: ["name", "content"],
      properties: {
        name: { type: "string", description: "技能名；已存在同名用户技能则更新（优化）它" },
        description: { type: "string", description: "一句话：什么场景用这个技能" },
        content: { type: "string", description: "详细做法指引（markdown）" }
      }
    },
    handler: async ({ name, description, content } = {}) => {
      const Skills = global.WpsAiSkills;
      if (!Skills || typeof Skills.addUser !== "function") throw new Error("技能模块未加载。");
      const nm = String(name == null ? "" : name).trim();
      if (!nm) throw new Error("需要技能名 name。");
      if (!String(content == null ? "" : content).trim()) throw new Error("需要技能内容 content。");
      // 已有同名「用户技能」→ 更新（优化）；内置 / 云端技能不覆盖，另存为新用户技能。
      const existing = (Skills.list ? Skills.list() : []).find((s) => s && !s.builtin && String(s.name).trim() === nm);
      let saved = null, action = "created";
      if (existing && typeof Skills.updateUser === "function") {
        saved = Skills.updateUser(existing.id, { name: nm, description, content });
        if (saved) action = "updated";
      }
      if (!saved) saved = Skills.addUser({ name: nm, description: description || "", content });
      try { if (Skills.setEnabled) Skills.setEnabled(saved.id, true); } catch (e) {}
      return { action, id: saved.id, name: saved.name, enabled: true };
    }
  });
})(window);
