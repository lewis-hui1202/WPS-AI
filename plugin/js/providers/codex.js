(function attachCodexProvider(global) {
  "use strict";

  const JWT_CLAIM_PATH = "https://api.openai.com/auth";
  // 端口随 WpsAiRuntime 实际探测结果走。每次调用都现拼，不缓存。
  function proxyBase() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }
  // 模型列表按 Codex 客户端版本过滤；0.0.1 会被服务端返回空列表。
  function modelsEndpoint() { return `${proxyBase()}/codex/models?client_version=0.164.0`; }
  function responsesEndpoint() { return `${proxyBase()}/codex/responses?client_version=0.0.1`; }

  function decodeJwtPayload(token) {
    const payload = token.split(".")[1];
    if (!payload) {
      throw new Error("Token 格式异常，无法解析 ChatGPT 账户信息。");
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  }

  async function buildHeaders({ stream = false } = {}) {
    const token = await global.WpsAiAuth.refreshTokenIfNeeded();
    if (!token) {
      throw new Error("请先使用 ChatGPT OAuth 登录。");
    }
    const payload = decodeJwtPayload(token);
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) {
      throw new Error("Token 中缺少 chatgpt_account_id，无法调用 Codex 接口。");
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountId,
      originator: "codex_cli_rs",
      "OpenAI-Beta": "responses=experimental",
      "Content-Type": "application/json"
    };
    if (stream) {
      headers.Accept = "text/event-stream";
    }
    return headers;
  }

  function splitMessages(messages) {
    const systemPrompt = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const inputMessages = messages.filter((m) => m.role !== "system");
    return { systemPrompt, inputMessages };
  }

  // 把 app.js / OpenAI 风格的 part 转成 Responses API 风格
  //   string                                                              → [{type:'input_text', text}]
  //   { type:'text', text }                                               → { type:'input_text', text }
  //   { type:'image_url', image_url:{url}}                                → { type:'input_image', image_url }
  //   { type:'file', file:{file_data:"data:application/pdf;base64,...", filename}} → { type:'input_file', file_data, filename }
  //   { type:'file', file:{file_id}}                                      → { type:'input_file', file_id }
  function normalizeCodexContent(content) {
    if (content == null) return [{ type: "input_text", text: "" }];
    if (typeof content === "string") return [{ type: "input_text", text: content }];
    if (!Array.isArray(content)) return [{ type: "input_text", text: String(content) }];
    return content.map((part) => {
      if (!part || typeof part !== "object") return { type: "input_text", text: String(part) };
      if (part.type === "text") return { type: "input_text", text: part.text || "" };
      if (part.type === "image_url" && part.image_url?.url) {
        return { type: "input_image", image_url: part.image_url.url };
      }
      if (part.type === "file" && part.file) {
        if (part.file.file_id) {
          return { type: "input_file", file_id: part.file.file_id };
        }
        if (part.file.file_data) {
          return {
            type: "input_file",
            filename: part.file.filename || "file.pdf",
            file_data: part.file.file_data
          };
        }
      }
      // 已经是 Responses API 原生形态（input_text / input_image / input_file）：直传
      return part;
    });
  }

  function toResponseInput(messages) {
    return messages.map((m) => ({
      role: m.role,
      content: normalizeCodexContent(m.content)
    }));
  }

  function buildBody({ model, messages, stream }) {
    const { systemPrompt, inputMessages } = splitMessages(messages);
    return {
      model,
      store: false,
      stream,
      instructions: systemPrompt,
      input: toResponseInput(inputMessages),
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true
    };
  }

  function getResponseText(payload) {
    if (payload.output_text) {
      return payload.output_text;
    }
    return (payload.output || [])
      .flatMap((item) => item.content || [])
      .map((c) => c.text || "")
      .join("");
  }

  function fallbackModels() {
    return [
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.1-codex",
      "gpt-5.2"
    ];
  }

  function normalizeModelIds(payload) {
    const source = Array.isArray(payload)
      ? payload
      : payload.models || payload.data || payload.items || [];
    return source
      .map((m) => (typeof m === "string" ? m : m.id || m.slug || m.name))
      .filter((id) => typeof id === "string" && /^(gpt|o\d|chatgpt)/i.test(id))
      .map((id) => id.replace(/^openai-codex\//, "").replace(/^openai\//, ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  function createCodexProvider(config) {
    return {
      type: "codex",
      label: config.label || "Codex (ChatGPT OAuth)",
      defaultModel: config.defaultModel || "gpt-5.1-codex",
      requiresOAuth: true,

      async ensureReady() {
        if (!global.WpsAiAuth?.isAuthenticated()) {
          throw new Error("请先使用 ChatGPT OAuth 登录。");
        }
      },

      async listModels() {
        const response = await fetch(modelsEndpoint(), {
          method: "GET",
          headers: await buildHeaders()
        });
        if (response.status === 401) {
          throw new Error("登录态(Token)已失效，请重新登录。");
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || payload.detail || `获取模型列表失败：${response.status}`);
        }
        const models = normalizeModelIds(payload);
        if (models.length === 0) {
          throw new Error("模型接口返回空列表");
        }
        return models;
      },

      getFallbackModels: fallbackModels,

      async chat({ model, messages }) {
        const response = await fetch(responsesEndpoint(), {
          method: "POST",
          headers: await buildHeaders(),
          body: JSON.stringify(buildBody({ model, messages, stream: false }))
        });
        if (response.status === 401) {
          throw new Error("登录态(Token)已失效，请重新登录。");
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || payload.detail || `请求失败：${response.status}`);
        }
        try {
          const u = payload.usage || payload.response?.usage;
          if (u) global.WpsAiTokenUsage?.record({ provider: config.label || "codex", model, input: u.input_tokens, output: u.output_tokens });
        } catch (e) {}
        return getResponseText(payload);
      },

      async streamChat({ model, messages, onToken }) {
        const response = await fetch(responsesEndpoint(), {
          method: "POST",
          headers: await buildHeaders({ stream: true }),
          body: JSON.stringify(buildBody({ model, messages, stream: true }))
        });
        if (response.status === 401) {
          throw new Error("登录态(Token)已失效，请重新登录。");
        }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error?.message || payload.detail || `请求失败：${response.status}`);
        }
        let fullText = "";
        let completedUsage = null;
        await global.WpsAiSse.readSse(response, (eventType, payload) => {
          if (!payload) return;
          // Responses API 文字增量事件：response.output_text.delta
          const t = eventType || payload.type;
          if (t === "response.output_text.delta") {
            const token = payload.delta || "";
            if (token) {
              fullText += token;
              onToken?.(token, fullText);
            }
            return;
          }
          if (t === "response.completed") {
            const _u = payload.response?.usage;
            if (_u) completedUsage = _u;
            return;
          }
          // 兜底：仅处理真正的旧格式（无类型或非 response.* 事件）。
          // 修 B22：response.output_text.done / reasoning_summary_text.delta /
          // function_call_arguments.delta 等 Responses 事件也带 text/delta 字段，
          // 若在这里 append 会把全文重复一遍或把非正文内容混进来。
          if (typeof t === "string" && t.indexOf("response.") === 0) return;
          const token = payload.delta || payload.text || payload.response?.output_text || "";
          if (typeof token === "string" && token) {
            fullText += token;
            onToken?.(token, fullText);
          }
        });
        try {
          if (completedUsage) global.WpsAiTokenUsage?.record({ provider: config.label || "codex", model, input: completedUsage.input_tokens, output: completedUsage.output_tokens });
        } catch (e) {}
        return fullText;
      },

      /**
       * Responses API 流式 tool-use 循环。
       * 关键事件：
       *   response.output_text.delta            → 文字增量
       *   response.output_item.added            → 新输出项（function_call/message/...）
       *   response.function_call_arguments.delta → 工具参数 JSON 片段（按 item_id 累积）
       *   response.completed                    → 完整 output 数组
       */
      async runWithTools({ model, messages, tools = [], maxIterations = 50, onEvent, approveTool, signal, thinkingLevel }) {
        const { systemPrompt, inputMessages } = splitMessages(messages);
        const inputItems = toResponseInput(inputMessages);
        const toolSpecs = tools.map((def) => global.WpsAiToolRegistry.toCodexToolSpec(def));
        const thinkingParams = global.WpsAiCapabilities?.buildThinkingParams("codex", thinkingLevel, model);

        for (let iter = 0; iter < maxIterations; iter += 1) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const body = {
            model,
            store: false,
            stream: true,
            instructions: systemPrompt,
            input: inputItems,
            text: { verbosity: "medium" },
            include: ["reasoning.encrypted_content"],
            tool_choice: "auto",
            parallel_tool_calls: true
          };
          if (toolSpecs.length > 0) body.tools = toolSpecs;
          if (thinkingParams) Object.assign(body, thinkingParams);

          const response = await fetch(responsesEndpoint(), {
            method: "POST",
            headers: await buildHeaders({ stream: true }),
            body: JSON.stringify(body),
            signal
          });
          if (response.status === 401) {
            throw new Error("登录态(Token)已失效，请重新登录。");
          }
          if (!response.ok) {
            const errPayload = await response.json().catch(() => ({}));
            throw new Error(errPayload.error?.message || errPayload.detail || `请求失败：${response.status}`);
          }

          let fullText = "";
          const fnCallByItemId = {}; // item_id → { call_id, name, argumentsAcc }
          let completedOutput = [];
          let completedUsage = null;

          await global.WpsAiSse.readSse(response, async (eventType, payload) => {
            if (!payload) return;
            const t = eventType || payload.type;

            switch (t) {
              case "response.output_text.delta": {
                if (typeof payload.delta === "string" && payload.delta.length > 0) {
                  fullText += payload.delta;
                  await onEvent?.({ type: "assistant_chunk", delta: payload.delta, fullText });
                }
                break;
              }
              case "response.output_item.added": {
                const item = payload.item;
                if (item?.type === "function_call") {
                  fnCallByItemId[item.id] = {
                    call_id: item.call_id || item.id,
                    name: item.name,
                    argumentsAcc: ""
                  };
                }
                break;
              }
              case "response.function_call_arguments.delta": {
                const slot = fnCallByItemId[payload.item_id];
                if (slot && typeof payload.delta === "string") {
                  slot.argumentsAcc += payload.delta;
                }
                break;
              }
              case "response.completed": {
                const out = payload.response?.output || [];
                completedOutput = out;
                const _u = payload.response?.usage;
                if (_u) completedUsage = _u;
                break;
              }
              default:
                // 忽略其他事件（reasoning.delta、output_item.done 等）
                break;
            }
          });

          try {
            if (completedUsage) global.WpsAiTokenUsage?.record({ provider: config.label || "codex", model, input: completedUsage.input_tokens, output: completedUsage.output_tokens });
          } catch (e) {}

          // 优先用 response.completed 给的完整 output，回填到下一轮输入
          const usedCompleted = completedOutput.length > 0;
          if (usedCompleted) {
            for (const item of completedOutput) inputItems.push(item);
          }

          if (fullText) {
            await onEvent?.({ type: "assistant_text_end", text: fullText });
          }

          // 提取 function_call：优先用 completedOutput，缺失时回退到流累积器
          let functionCalls = completedOutput.filter((it) => it.type === "function_call");
          if (functionCalls.length === 0 && Object.keys(fnCallByItemId).length > 0) {
            functionCalls = Object.values(fnCallByItemId).map((slot) => ({
              call_id: slot.call_id,
              name: slot.name,
              arguments: slot.argumentsAcc
            }));
            // 修 B12：response.completed 缺失时 completedOutput 为空，上面没把 function_call 项
            // 写回 inputItems，但下面会 push function_call_output，形成"孤儿 output" → 下一轮 400。
            // 这里补齐：把本轮 assistant 文本 + 重构出的 function_call 项写回 input，保持配对。
            if (!usedCompleted) {
              if (fullText) {
                inputItems.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: fullText }] });
              }
              for (const fc of functionCalls) {
                inputItems.push({ type: "function_call", call_id: fc.call_id, name: fc.name, arguments: fc.arguments || "" });
              }
            }
          }

          if (functionCalls.length === 0) {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }

          for (const call of functionCalls) {
            // 让出宏任务：连续同步 COM（Excel）下 await 只排微任务，「停止」点击派发不出来。见 openai.js 同注。
            await new Promise((r) => setTimeout(r, 0));
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(call.arguments || "{}"); } catch (e) { parsedArgs = {}; }

            const callId = call.call_id || call.id;
            await onEvent?.({ type: "tool_call", id: callId, name: call.name, args: parsedArgs });

            const decision = approveTool ? await approveTool({ id: callId, name: call.name, args: parsedArgs }) : { approved: true };
            let result;
            if (!decision.approved) {
              result = { ok: false, error: decision.reason || "用户拒绝执行该工具" };
            } else {
              result = await global.WpsAiToolRegistry.execute(call.name, parsedArgs, { signal });
            }
            await onEvent?.({ type: "tool_result", id: callId, name: call.name, result });

            inputItems.push({
              type: "function_call_output",
              call_id: callId,
              output: global.WpsAiToolRegistry.serializeResult(result)
            });
          }
        }

        await onEvent?.({ type: "done", text: "", aborted: true });
        throw new Error(`工具调用循环达到上限（${maxIterations}）。`);
      }
    };
  }

  global.WpsAiProviderRegistry?.register("codex", createCodexProvider);
})(window);
