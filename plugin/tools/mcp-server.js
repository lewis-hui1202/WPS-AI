#!/usr/bin/env node
/**
 * 文小舟 WPS MCP 服务 —— 把 WPS plugin 暴露的工具通过 stdio JSON-RPC 协议提供给
 * 外部 agent（Claude Code CLI / Claude Desktop / Cursor 等）使用。
 *
 * 工作流：
 *   stdin (MCP JSON-RPC) → 本进程 → HTTP → proxy-server.js → 长轮询 → WPS plugin → 执行 → 回传
 *
 * 用法（在 Claude Code CLI / Claude Desktop 配置里）：
 *   {
 *     "mcpServers": {
 *       "wps-ai": {
 *         "command": "node",
 *         "args": ["E:/path/to/plugin/tools/mcp-server.js"],
 *         "env": { "WPS_PROXY_PORT": "3890" }   // 可选，默认 3890
 *       }
 *     }
 *   }
 *
 * 前置：
 *   1. 启动 proxy-server.js（node plugin/tools/proxy-server.js）
 *   2. 打开 WPS，启用插件设置里的「MCP 服务」开关
 */

const http = require("http");
const { URL } = require("url");

const PROXY_HOST = process.env.WPS_PROXY_HOST || "127.0.0.1";
const PROXY_PORT = Number(process.env.WPS_PROXY_PORT) || 3890;
const PROXY_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;
// MCP 共享 token：plugin 会生成一次持久化 token，插进 MCP 客户端 config 的 env。
// 我们把它作为 Authorization: Bearer <token> 传给 proxy，未来 proxy 侧强制校验
// 后同机进程也不能未授权调 WPS 工具。老版本 proxy 忽略这个 header 不会 break。
const MCP_TOKEN = process.env.WPS_MCP_TOKEN || "";

// 协议常量
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = {
  name: "lingxi-wps-ai",
  version: "1.0.0"
};

// ====== HTTP 工具 ======
function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(PROXY_BASE + path);
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: (() => {
        const h = data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : {};
        if (MCP_TOKEN) h["Authorization"] = `Bearer ${MCP_TOKEN}`;
        return h;
      })(),
      timeout: 90 * 1000
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { try { req.destroy(); } catch (e) {} reject(new Error("HTTP timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

// ====== MCP JSON-RPC 处理 ======

function writeMessage(msg) {
  // MCP 使用 LSP 风格 framing？不，标准 MCP 走 stdio 时是 newline-delimited JSON
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function makeError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

async function handleRequest(req) {
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      // 返回 server capabilities
      return makeResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {}     // 支持 tools/list 和 tools/call
        },
        serverInfo: SERVER_INFO
      });
    }

    if (method === "notifications/initialized") {
      // 通知，无返回
      return null;
    }

    if (method === "tools/list") {
      const { status, body } = await httpRequest("GET", "/mcp/tools");
      if (status !== 200 || !body?.ok) {
        const err = body?.error || `HTTP ${status}`;
        // plugin 未在线时 list 返回空，不报错（避免 client 把整个 server 标红）
        if (status === 503) {
          return makeResult(id, { tools: [] });
        }
        return makeError(id, -32000, "拉取工具清单失败: " + err);
      }
      const tools = (body.tools || []).map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.parameters || t.inputSchema || { type: "object", properties: {} }
      }));
      return makeResult(id, { tools });
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) return makeError(id, -32602, "缺 name 参数");
      const { status, body } = await httpRequest("POST", "/mcp/call", { name, args });
      if (status !== 200) {
        const err = body?.error || `HTTP ${status}`;
        return makeError(id, -32000, "调用 WPS 工具失败: " + err);
      }
      if (!body?.ok) {
        // tool 执行失败 → MCP 用 isError + text content 返回
        return makeResult(id, {
          isError: true,
          content: [{ type: "text", text: String(body?.error || "执行失败") }]
        });
      }
      // tool 成功 → 把 value 序列化成 text
      const value = body.value;
      const text = typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
      return makeResult(id, {
        content: [{ type: "text", text }]
      });
    }

    // 其他 MCP 方法（resources/* prompts/* 等）暂不支持
    return makeError(id, -32601, `未实现的 MCP 方法: ${method}`);
  } catch (e) {
    return makeError(id, -32603, "内部错误: " + (e?.message || e));
  }
}

// ====== stdin 读取 (newline-delimited JSON) ======

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); }
    catch (e) {
      writeMessage(makeError(null, -32700, "JSON parse error: " + e.message));
      continue;
    }
    handleRequest(req).then((resp) => {
      if (resp) writeMessage(resp);
    }).catch((e) => {
      writeMessage(makeError(req.id || null, -32603, "未捕获错误: " + (e?.message || e)));
    });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// 错误信息全走 stderr，避免污染 stdout（stdout 只允许 JSON-RPC）
process.on("uncaughtException", (e) => {
  process.stderr.write(`[mcp-server] uncaught: ${e?.stack || e}\n`);
});
