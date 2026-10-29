(function attachGeminiProvider(global) {
  "use strict";

  // Google Gemini 原生协议（generativelanguage.googleapis.com）。
  // 流式走 :streamGenerateContent?alt=sse，每个 SSE data 是一个 GenerateContentResponse：
  //   { candidates:[{ content:{ role:"model", parts:[ {text} | {text,thought:true} | {functionCall} ] }, finishReason }], usageMetadata }
  // 鉴权用 x-goog-api-key 头（不是 Bearer）。消息用 contents(role:user/model) + systemInstruction。

  const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

  function proxyForwardPrefix() {
    return (global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/");
  }

  function resolveBase(config) {
    const base = (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    if (config.useProxy === false) return base;
    return proxyForwardPrefix() + encodeURIComponent(base);
  }

  function buildHeaders(config, { stream = false } = {}) {
    if (!config.apiKey) throw new Error("请在设置中填写 Gemini API Key。");
    const headers = {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey
    };
    if (stream) headers.Accept = "text/event-stream";
    return headers;
  }

  // Gemini Schema 只认 OpenAPI 子集，塞进 JSON Schema 里的 $schema / additionalProperties / default /
  // title 等会被 400 拒绝。递归只保留白名单字段。
  const SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "items", "properties", "required", "example"]);
  function sanitizeSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(sanitizeSchema);
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
      if (!SCHEMA_KEYS.has(k)) continue;
      if (k === "properties" && v && typeof v === "object") {
        out.properties = {};
        for (const [pk, pv] of Object.entries(v)) out.properties[pk] = sanitizeSchema(pv);
      } else if (k === "items") {
        out.items = sanitizeSchema(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function toFunctionDeclaration(def) {
    return {
      name: def.name,
      description: def.description || "",
      parameters: sanitizeSchema(def.parameters || { type: "object", properties: {} })
    };
  }

  // 单条消息内容(string / OpenAI 风格数组) → Gemini parts。
  function contentToParts(content) {
    if (content == null) return [{ text: "" }];
    if (typeof content === "string") return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: String(content) }];
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== "object") { parts.push({ text: String(part) }); continue; }
      if (part.type === "text") { parts.push({ text: part.text || "" }); continue; }
      if (part.type === "image_url" && part.image_url?.url) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
        if (m) { parts.push({ inlineData: { mimeType: m[1], data: m[2] } }); continue; }
        // 非 data URL 的图片 Gemini 需要 fileData.fileUri（须先上传），这里降级成文字提示，不阻断对话。
        parts.push({ text: `[图片: ${part.image_url.url}]` }); continue;
      }
      if (part.type === "file" && part.file?.file_data) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(part.file.file_data);
        if (m) { parts.push({ inlineData: { mimeType: m[1], data: m[2] } }); continue; }
      }
      // 已是 Gemini 原生 part：直传
      parts.push(part);
    }
    return parts.length ? parts : [{ text: "" }];
  }

  // OpenAI 风格 messages → { systemInstruction, contents }。role assistant→model；system 抽到 systemInstruction。
  function toGeminiRequest(messages) {
    const systemTexts = [];
    const contents = [];
    for (const m of messages) {
      if (m.role === "system") { systemTexts.push(typeof m.content === "string" ? m.content : ""); continue; }
      const role = m.role === "assistant" ? "model" : "user";
      contents.push({ role, parts: contentToParts(m.content) });
    }
    const systemInstruction = systemTexts.filter(Boolean).length
      ? { parts: [{ text: systemTexts.filter(Boolean).join("\n\n") }] }
      : undefined;
    return { systemInstruction, contents };
  }

  // 从一个（可能是增量的）GenerateContentResponse 里分类各 part。
  //   { texts:[...], thoughts:[...], functionCalls:[{name,args}], finishReason, usage }
  function classifyChunk(payload) {
    const out = { texts: [], thoughts: [], functionCalls: [], finishReason: null, usage: null };
    const cand = payload?.candidates?.[0];
    const parts = cand?.content?.parts || [];
    for (const p of parts) {
      if (p && p.functionCall) {
        out.functionCalls.push({
          name: p.functionCall.name,
          args: p.functionCall.args || {},
          ...(p.functionCall.id != null ? { id: p.functionCall.id } : {})
        });
        continue;
      }
      if (p && typeof p.text === "string") {
        if (p.thought === true) out.thoughts.push(p.text);
        else out.texts.push(p.text);
      }
    }
    if (cand?.finishReason) out.finishReason = cand.finishReason;
    if (payload?.usageMetadata) out.usage = payload.usageMetadata;
    return out;
  }

  function recordUsage(config, model, usage) {
    try {
      if (usage) global.WpsAiTokenUsage?.record({
        provider: config.label || "gemini", model,
        input: usage.promptTokenCount || 0,
        output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
      });
    } catch (e) {}
  }

  function fallbackModels() {
    return ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
  }

  function createGeminiProvider(config) {
    const base = () => resolveBase(config);
    const genUrl = (model, stream) =>
      `${base()}/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;

    function generationConfig(model, temperature, thinkingLevel) {
      const gc = {};
      if (typeof temperature === "number" && Number.isFinite(temperature)) gc.temperature = temperature;
      const tp = global.WpsAiCapabilities?.buildThinkingParams("gemini", thinkingLevel, model);
      if (tp?.thinkingConfig) gc.thinkingConfig = tp.thinkingConfig;
      return Object.keys(gc).length ? gc : undefined;
    }

    return {
      type: "gemini",
      label: config.label || "Google Gemini",
      defaultModel: config.defaultModel || "gemini-2.5-flash",
      requiresOAuth: false,

      async ensureReady() {
        if (!config.apiKey) throw new Error("请在设置中填写 Gemini API Key。");
      },

      async listModels() {
        const response = await fetch(`${base()}/models`, { method: "GET", headers: buildHeaders(config) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || `获取模型列表失败：${response.status}`);
        const models = (payload.models || [])
          .filter((m) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent"))
          .map((m) => String(m.name || "").replace(/^models\//, ""))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        if (models.length === 0) throw new Error("模型接口返回空列表");
        return models;
      },

      getFallbackModels: fallbackModels,

      async chat({ model, messages, temperature }) {
        const { systemInstruction, contents } = toGeminiRequest(messages);
        const body = { contents };
        if (systemInstruction) body.systemInstruction = systemInstruction;
        const gc = generationConfig(model, temperature);
        if (gc) body.generationConfig = gc;
        const response = await fetch(genUrl(model, false), {
          method: "POST", headers: buildHeaders(config), body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || `请求失败：${response.status}`);
        recordUsage(config, model, payload.usageMetadata);
        const c = classifyChunk(payload);
        return c.texts.join("");
      },

      async streamChat({ model, messages, onToken, onActivity, temperature, signal }) {
        const { systemInstruction, contents } = toGeminiRequest(messages);
        const body = { contents };
        if (systemInstruction) body.systemInstruction = systemInstruction;
        const gc = generationConfig(model, temperature, undefined);
        if (gc) body.generationConfig = gc;
        const response = await fetch(genUrl(model, true), {
          method: "POST", headers: buildHeaders(config, { stream: true }), body: JSON.stringify(body), signal
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        let fullText = "";
        let usage = null;
        await global.WpsAiSse.readSse(response, (_eventType, payload) => {
          if (!payload) return;
          const c = classifyChunk(payload);
          for (const th of c.thoughts) onActivity?.(th);
          for (const tx of c.texts) { fullText += tx; onToken?.(tx, fullText); }
          if (c.usage) usage = c.usage;
        });
        recordUsage(config, model, usage);
        return fullText;
      },

      /**
       * Gemini 流式 tool-use 循环。functionCall 由模型在 parts 里整块给出（args 已是对象，不像 OpenAI 要拼 JSON）。
       * 工具结果以 functionResponse part 回填到一个 role:"user" 的 content——Gemini 强制 user/model 交替，
       * 所以 functionResponse 必须放进 user 轮，不能自成一角色。
       */
      async runWithTools({ model, messages, tools = [], maxIterations = 50, onEvent, approveTool, signal, thinkingLevel }) {
        const { systemInstruction, contents } = toGeminiRequest(messages);
        const functionDeclarations = tools.map(toFunctionDeclaration);

        for (let iter = 0; iter < maxIterations; iter += 1) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const body = { contents };
          if (systemInstruction) body.systemInstruction = systemInstruction;
          if (functionDeclarations.length > 0) body.tools = [{ functionDeclarations }];
          const gc = generationConfig(model, undefined, thinkingLevel);
          if (gc) body.generationConfig = gc;

          const response = await fetch(genUrl(model, true), {
            method: "POST", headers: buildHeaders(config, { stream: true }), body: JSON.stringify(body), signal
          });
          if (!response.ok) {
            const errPayload = await response.json().catch(() => ({}));
            throw new Error(errPayload.error?.message || `请求失败：${response.status}`);
          }

          let fullText = "";
          let reasoningText = "";
          const functionCalls = [];
          const modelParts = [];
          let usage = null;

          await global.WpsAiSse.readSse(response, async (_eventType, payload) => {
            if (!payload) return;
            // Gemini 3+ requires thoughtSignature on the original functionCall part
            // in the next request. Keep every streamed model part in order instead
            // of reconstructing calls from name/args and losing their metadata.
            const parts = payload?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) modelParts.push(...parts);
            const c = classifyChunk(payload);
            for (const th of c.thoughts) {
              reasoningText += th;
              await onEvent?.({ type: "reasoning_chunk", delta: th, fullText: reasoningText });
            }
            for (const tx of c.texts) {
              fullText += tx;
              await onEvent?.({ type: "assistant_chunk", delta: tx, fullText });
            }
            for (const fc of c.functionCalls) functionCalls.push(fc);
            if (c.usage) usage = c.usage;
          });

          recordUsage(config, model, usage);

          if (reasoningText) await onEvent?.({ type: "reasoning_end", text: reasoningText });

          // 原样回填模型 parts，包括 thoughtSignature、思考 part 与工具调用顺序。
          if (modelParts.length) contents.push({ role: "model", parts: modelParts });

          if (fullText) await onEvent?.({ type: "assistant_text_end", text: fullText });

          if (functionCalls.length === 0) {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }

          const responseParts = [];
          for (const call of functionCalls) {
            // 让出宏任务：连续同步 COM（Excel）下 await 只排微任务，「停止」点击派发不出来。见 openai.js 同注。
            await new Promise((r) => setTimeout(r, 0));
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const args = call.args || {};
            await onEvent?.({ type: "tool_call", id: call.name, name: call.name, args });

            const decision = approveTool ? await approveTool({ id: call.name, name: call.name, args }) : { approved: true };
            let result;
            if (!decision.approved) {
              result = { ok: false, error: decision.reason || "用户拒绝执行该工具" };
            } else {
              result = await global.WpsAiToolRegistry.execute(call.name, args, { signal });
            }
            await onEvent?.({ type: "tool_result", id: call.name, name: call.name, result });

            responseParts.push({
              functionResponse: {
                name: call.name,
                ...(call.id != null ? { id: call.id } : {}),
                response: { result: global.WpsAiToolRegistry.serializeResult(result) }
              }
            });
          }
          // 所有 functionResponse 放进同一个 user 轮（保持 user/model 交替）
          contents.push({ role: "user", parts: responseParts });
        }

        await onEvent?.({ type: "done", text: "", aborted: true });
        throw new Error(`工具调用循环达到上限（${maxIterations}）。`);
      }
    };
  }

  global.WpsAiProviderRegistry?.register("gemini", createGeminiProvider);
  // 暴露纯函数给单测（不影响运行时）
  global.WpsAiGeminiInternals = { sanitizeSchema, contentToParts, toGeminiRequest, classifyChunk, toFunctionDeclaration };
})(window);
