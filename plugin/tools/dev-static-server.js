#!/usr/bin/env node
const http = require("http");
const { applyRibbonPosition, readRibbonPosition } = require("./ribbon-position");
const fs = require("fs");
const path = require("path");

const root = path.resolve(process.env.LINGXI_DEV_ROOT || process.cwd());
const port = Number(process.env.WPSJS_PORT || process.env.STATIC_PORT) || 3889;
const proxyPort = Number(process.env.LINGXI_PROXY_PORT || process.env.PROXY_PORT) || null;
const PORT_LADDER_SIZE = Number(process.env.STATIC_PORT_LADDER_SIZE) || 20;
let resolvedPort = port;

function normalizeDevPathPrefix(pathPrefix) {
  const raw = String(pathPrefix || "").trim();
  if (!raw || raw === "/") return "";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/, "");
}

const devPathPrefix = normalizeDevPathPrefix(process.env.LINGXI_DEV_PATH_PREFIX);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    return null;
  }

  if (decoded === "/" || decoded === "") decoded = "/index.html";
  const resolved = path.resolve(root, decoded.replace(/^\/+/, ""));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function stripDevPathPrefix(pathname) {
  if (!devPathPrefix) return pathname;
  if (pathname === devPathPrefix) return "/";
  if (pathname.startsWith(`${devPathPrefix}/`)) {
    return pathname.slice(devPathPrefix.length) || "/";
  }
  return pathname;
}

function logAccess(req, status, extra) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  const ua = String(req.headers["user-agent"] || "-").slice(0, 120);
  const tail = extra ? ` ${extra}` : "";
  console.log(`[static] ${ts} ${req.method} ${req.url} -> ${status}${tail} ua="${ua}"`);
}

function serve(req, res, filePath) {
  fs.stat(filePath, (error, stat) => {
    if (error) {
      setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Not Found: ${req.url}`);
      logAccess(req, 404, `missing=${filePath}`);
      return;
    }

    if (stat.isDirectory()) {
      serve(req, res, path.join(filePath, "index.html"));
      return;
    }

    if (/^ribbon(?:\.en)?\.xml$/i.test(path.basename(filePath))) {
      fs.readFile(filePath, "utf8", (error, xml) => {
        if (error) { setCors(res); res.writeHead(500); res.end(); return; }
        const body = Buffer.from(applyRibbonPosition(xml, readRibbonPosition()), "utf8");
        setCors(res);
        res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" });
        res.end(req.method === "HEAD" ? undefined : body);
      });
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const lastModified = stat.mtime.toUTCString();
    const shouldInjectDevConfig = proxyPort && type.startsWith("text/html") && path.basename(filePath).toLowerCase() === "index.html";
    if (shouldInjectDevConfig) {
      fs.readFile(filePath, "utf8", (readError, raw) => {
        if (readError) {
          setCors(res);
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Internal Server Error");
          logAccess(req, 500, `read-failed=${filePath}`);
          return;
        }
        const configScript = `<script>window.__LINGXI_PROXY_PORT__=${JSON.stringify(proxyPort)};<\/script>`;
        const body = raw.includes("</head>")
          ? raw.replace("</head>", `${configScript}\n  </head>`)
          : `${configScript}\n${raw}`;
        const bodyBuffer = Buffer.from(body, "utf8");
        setCors(res);
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": bodyBuffer.length,
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "Pragma": "no-cache",
          "Expires": "0",
          "Last-Modified": lastModified
        });
        logAccess(req, 200, `bytes=${bodyBuffer.length} file=${filePath} injectedProxyPort=${proxyPort}`);
        if (req.method === "HEAD") res.end();
        else res.end(bodyBuffer);
      });
      return;
    }
    setCors(res);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Last-Modified": lastModified
    });
    logAccess(req, 200, `bytes=${stat.size} file=${filePath}`);

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on("error", (error) => {
      console.error(`[static] 读取文件失败: ${filePath} ${error.message}`);
      if (!res.headersSent) {
        setCors(res);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    });
    req.on("aborted", () => {
      console.warn(`[static] 客户端中断请求: ${req.method} ${req.url}`);
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        console.warn(`[static] 响应提前关闭: ${req.method} ${req.url}`);
      }
    });
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      res.end();
      logAccess(req, 204);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      setCors(res);
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      logAccess(req, 405);
      return;
    }

    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    const requestPath = stripDevPathPrefix(parsed.pathname || "/");
    if (requestPath === "/__lingxi_trace__.gif") {
      setCors(res);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      const event = parsed.searchParams.get("event") || "";
      const data = parsed.searchParams.get("data") || "";
      logAccess(req, 204, `trace=${event}${data ? ` data=${data.slice(0, 160)}` : ""}`);
      return;
    }
    if (requestPath === "/health" || requestPath === "/_health" || requestPath === "/healthz") {
      setCors(res);
      res.setHeader("X-Lingxi-Service", "lingxi-ai-static/v1");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, service: "lingxi-ai-static/v1", port: resolvedPort, root, devPathPrefix, proxyPort }));
      logAccess(req, 200, "healthz");
      return;
    }

    let filePath = safePath(stripDevPathPrefix(parsed.pathname || "/"));
    if (!filePath) {
      setCors(res);
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad path");
      logAccess(req, 400, "bad-path");
      return;
    }

    // 国际化：ribbon.xml 按 ~/.lingxi-ai/ui-lang.txt 切中英版本（同 serve-permanent 逻辑）。
    // 部分 WPS 不支持 getLabel 动态回调，label 必须在 xml 里就是目标语言；重启 WPS 生效。
    if (/(^|[\\/])ribbon\.xml$/i.test(filePath)) {
      try {
        const langFile = path.join(require("os").homedir(), ".lingxi-ai", "ui-lang.txt");
        if (String(fs.readFileSync(langFile, "utf8")).trim() === "en") {
          const enPath = filePath.replace(/ribbon\.xml$/i, "ribbon.en.xml");
          if (fs.existsSync(enPath)) filePath = enPath;
        }
      } catch (e) { /* 侧车文件不存在 = 中文默认 */ }
    }

    serve(req, res, filePath);
  } catch (error) {
    console.error(`[static] 请求处理异常: ${error && (error.stack || error.message)}`);
    try {
      setCors(res);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    } catch (_) {}
  }
});

function startListenLadder(targetPort, attemptsLeft) {
  // 同 proxy-server：listening 监听器也要清，否则递归 listen 时旧闭包会跟着 fire，
  // 把 resolvedPort 覆盖回上一轮的端口，日志/状态对不上。
  server.removeAllListeners("error");
  server.removeAllListeners("listening");
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`[static] 端口 ${targetPort} 已被占用，自动切到 ${targetPort + 1}（剩 ${attemptsLeft - 1} 次尝试）`);
      startListenLadder(targetPort + 1, attemptsLeft - 1);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`[static] 端口梯子（${port}..${port + PORT_LADDER_SIZE}）全占用，启动失败。`);
    } else {
      console.error(`[static] 启动失败：${error.message}`);
    }
    process.exit(1);
  });
  server.listen(targetPort, "127.0.0.1", () => {
    resolvedPort = targetPort;
    const switched = targetPort !== port;
    console.log(`[static] 本地插件服务已启动: http://127.0.0.1:${resolvedPort}` + (switched ? `（请求端口 ${port} 被占用，已自动切换到 ${resolvedPort}）` : ""));
    console.log(`[static] root=${root}`);
    if (devPathPrefix) console.log(`[static] devPathPrefix=${devPathPrefix}`);
  });
}

startListenLadder(port, PORT_LADDER_SIZE);
