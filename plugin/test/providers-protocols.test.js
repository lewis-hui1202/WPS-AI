const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 加载 gemini.js（IIFE），拿到暴露给测试的纯函数 WpsAiGeminiInternals。
function loadGemini() {
  const context = { window: {}, console };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "gemini.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiGeminiInternals;
}

test("Gemini classifyChunk：区分正文 / 思考(thought:true) / functionCall", () => {
  const G = loadGemini();
  const c = G.classifyChunk({
    candidates: [{
      content: { role: "model", parts: [
        { text: "答案" },
        { text: "我在想", thought: true },
        { functionCall: { name: "wps_read_document", args: { scope: "all" } } }
      ] },
      finishReason: "STOP"
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 }
  });
  assert.deepEqual(c.texts, ["答案"]);
  assert.deepEqual(c.thoughts, ["我在想"]);
  assert.deepEqual(c.functionCalls, [{ name: "wps_read_document", args: { scope: "all" } }]);
  assert.equal(c.finishReason, "STOP");
  assert.equal(c.usage.promptTokenCount, 10);
});

test("Gemini 工具续轮原样回传 functionCall 所在 part 的 thoughtSignature", async () => {
  const requests = [];
  const chunks = [
    [{ candidates: [{ content: { role: "model", parts: [
      { text: "读取文档", thought: true },
      { functionCall: { name: "wps_read_document", args: { scope: "all" }, id: "call-1" }, thoughtSignature: "signed-token" },
      { functionCall: { name: "wps_read_document", args: { scope: "summary" } } }
    ] } }] }],
    [{ candidates: [{ content: { role: "model", parts: [{ text: "已完成" }] }, finishReason: "STOP" }] }]
  ];
  let provider;
  const context = {
    console,
    setTimeout,
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, iteration: requests.length - 1 };
    },
    window: {
      WpsAiProviderRegistry: { register: (_type, factory) => { provider = factory({ apiKey: "test-key", useProxy: false }); } },
      WpsAiSse: { readSse: async (response, onChunk) => {
        for (const chunk of chunks[response.iteration]) await onChunk("message", chunk);
      } },
      WpsAiToolRegistry: {
        execute: async () => ({ ok: true }),
        serializeResult: (result) => result
      }
    }
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "providers", "gemini.js"), "utf8"), context);
  await provider.runWithTools({
    model: "gemini-3.8-flash", messages: [{ role: "user", content: "总结全文" }],
    tools: [{ name: "wps_read_document", parameters: { type: "object" } }]
  });
  assert.equal(requests.length, 2);
  const modelTurn = requests[1].contents[1];
  assert.equal(modelTurn.role, "model");
  assert.deepEqual(modelTurn.parts, chunks[0][0].candidates[0].content.parts);
  assert.equal(requests[1].contents[2].parts.length, 2);
  assert.equal(requests[1].contents[2].parts[0].functionResponse.id, "call-1");
});

test("Gemini classifyChunk：空/无 candidates 不炸", () => {
  const G = loadGemini();
  const c = G.classifyChunk({});
  assert.deepEqual(c.texts, []);
  assert.deepEqual(c.thoughts, []);
  assert.deepEqual(c.functionCalls, []);
  assert.equal(c.finishReason, null);
});

test("Gemini toGeminiRequest：system 抽到 systemInstruction，assistant→model", () => {
  const G = loadGemini();
  const r = G.toGeminiRequest([
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "在" }
  ]);
  assert.equal(r.systemInstruction.parts[0].text, "你是助手");
  assert.deepEqual(r.contents, [
    { role: "user", parts: [{ text: "你好" }] },
    { role: "model", parts: [{ text: "在" }] }
  ]);
});

test("Gemini toGeminiRequest：无 system 时 systemInstruction 为 undefined", () => {
  const G = loadGemini();
  const r = G.toGeminiRequest([{ role: "user", content: "hi" }]);
  assert.equal(r.systemInstruction, undefined);
});

test("Gemini sanitizeSchema：剥掉 $schema/additionalProperties/default/title 等非法字段", () => {
  const G = loadGemini();
  const s = G.sanitizeSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    title: "X",
    properties: {
      a: { type: "string", description: "字段a", default: "x" },
      b: { type: "array", items: { type: "number", minimum: 0 } }
    },
    required: ["a"]
  });
  assert.deepEqual(s, {
    type: "object",
    properties: {
      a: { type: "string", description: "字段a" },
      b: { type: "array", items: { type: "number" } }
    },
    required: ["a"]
  });
});

test("Gemini contentToParts：字符串 / 文本part / 图片 data URL → inlineData", () => {
  const G = loadGemini();
  assert.deepEqual(G.contentToParts("hello"), [{ text: "hello" }]);
  assert.deepEqual(
    G.contentToParts([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }
    ]),
    [{ text: "看图" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }]
  );
});

test("Gemini contentToParts：非 data URL 图片降级成文字，不阻断", () => {
  const G = loadGemini();
  const parts = G.contentToParts([{ type: "image_url", image_url: { url: "https://x/y.png" } }]);
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /https:\/\/x\/y\.png/);
});

test("Gemini toFunctionDeclaration：name/description 保留，parameters 过 sanitize", () => {
  const G = loadGemini();
  const d = G.toFunctionDeclaration({
    name: "et_read_range",
    description: "读区域",
    parameters: { type: "object", $schema: "x", properties: { range: { type: "string" } } }
  });
  assert.equal(d.name, "et_read_range");
  assert.equal(d.description, "读区域");
  assert.deepEqual(d.parameters, { type: "object", properties: { range: { type: "string" } } });
});

// ---- 各 provider 文件加载即自注册对应 type（同时验证无加载期报错） ----
function loadProviderCapturingTypes(relPath) {
  const registered = [];
  const context = {
    window: {},
    console,
    // 各 provider 加载时会用到的可选全局，给最小 stub
  };
  context.window.window = context.window;
  context.window.WpsAiProviderRegistry = { register: (type) => registered.push(type) };
  context.window.WpsAiCapabilities = { buildThinkingParams: () => null };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", relPath), "utf8");
  vm.runInContext(code, context);
  return registered;
}

test("provider 自注册：gemini.js 注册 gemini", () => {
  assert.deepEqual(loadProviderCapturingTypes("gemini.js"), ["gemini"]);
});

test("provider 自注册：openai-responses.js 注册 openai-responses", () => {
  assert.deepEqual(loadProviderCapturingTypes("openai-responses.js"), ["openai-responses"]);
});

test("provider 自注册：openai.js 同时注册 openai 和 azure", () => {
  const types = loadProviderCapturingTypes("openai.js");
  assert.ok(types.includes("openai"), "应注册 openai");
  assert.ok(types.includes("azure"), "应注册 azure");
});

test("capabilities.buildThinkingParams：gemini→thinkingConfig，openai-responses→reasoning.effort", () => {
  const context = { window: {}, console };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "capabilities.js"), "utf8");
  vm.runInContext(code, context);
  const cap = context.window.WpsAiCapabilities;
  // 用一个"像思考模型"的名字，确保 supportsThinking 放行
  const gem = cap.buildThinkingParams("gemini", "high", "gemini-2.5-pro");
  assert.ok(gem && gem.thinkingConfig && gem.thinkingConfig.includeThoughts === true, "gemini 应给 thinkingConfig");
  const resp = cap.buildThinkingParams("openai-responses", "low", "o4-mini");
  assert.ok(resp && resp.reasoning && resp.reasoning.effort === "low", "responses 应给 reasoning.effort");
});
