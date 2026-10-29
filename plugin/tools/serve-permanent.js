#!/usr/bin/env node
/**
 * 永久安装时的常驻服务（无外部依赖，纯 stdlib）。
 *
 * 端口 3889：静态文件服务，路由：
 *   /wps/*  → <root>/plugin-wps/*
 *   /et/*   → <root>/plugin-et/*
 *   /wpp/*  → <root>/plugin-wpp/*
 *   /pdf/*  → <root>/plugin-pdf/*
 *
 * 端口 3890：CORS 代理 + /upload-image。直接由本进程 spawn proxy-server.js 子进程。
 *
 * 用法：
 *   node serve-permanent.js              # root = 此脚本所在目录的 ..
 *   node serve-permanent.js --root <dir> # 显式指定根目录（应包含 plugin-wps/-et/-wpp/-pdf）
 *
 * 退出：Ctrl-C 或 SIGTERM。子代理也会随之退出。
 */

const http = require("http");
const { applyRibbonPosition, readRibbonPosition } = require("./ribbon-position");
const fs = require("fs");
const path = require("path");
const url = require("url");
const os = require("os");
const { spawn } = require("child_process");

const HOST_PREFIXES = new Set(["wps", "et", "wpp", "pdf"]);

function parseArgs() {
  const args = process.argv.slice(2);
  let root = path.resolve(__dirname, "..");
  let staticPort = Number(process.env.LINGXI_STATIC_PORT) || 3889;
  let proxyPort = Number(process.env.PROXY_PORT) || 3890;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) {
      root = path.resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === "--static-port" && args[i + 1]) {
      staticPort = Number(args[i + 1]) || staticPort;
      i += 1;
    } else if (args[i] === "--proxy-port" && args[i + 1]) {
      proxyPort = Number(args[i + 1]) || proxyPort;
      i += 1;
    }
  }
  process.env.LINGXI_STATIC_PORT = String(staticPort);
  process.env.PROXY_PORT = String(proxyPort);
  return { root, staticPort, proxyPort };
}

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
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function safeJoin(rootDir, relPath) {
  // 防止 path traversal：解析后必须仍以 rootDir 为前缀
  const resolved = path.resolve(rootDir, relPath);
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) return null;
  return resolved;
}

function logAccess(req, status, extra) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  const ua = String(req.headers["user-agent"] || "-").slice(0, 80);
  const tail = extra ? ` ${extra}` : "";
  console.log(`[serve] ${ts} ${req.method} ${req.url} → ${status}${tail} ua="${ua}"`);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err) {
      setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Not Found: ${req.url}`);
      logAccess(req, 404, `missing=${filePath}`);
      return;
    }
    if (st.isDirectory()) {
      // 目录：尝试 index.html
      const indexPath = path.join(filePath, "index.html");
      fs.stat(indexPath, (e2, s2) => {
        if (e2 || !s2.isFile()) {
          setCors(res);
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Directory listing forbidden");
        } else {
          serveFile(req, res, indexPath);
        }
      });
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
    const ext = path.extname(filePath).toLowerCase();
    const ctype = MIME[ext] || "application/octet-stream";
    setCors(res);
    // 严格禁止 WebView 缓存——Mac WPS WKWebView 的资源校验对老缓存敏感，
    // 一旦插件文件更新就会报 "Main resource content verification failed"
    res.writeHead(200, {
      "Content-Type": ctype,
      "Content-Length": st.size,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Last-Modified": st.mtime.toUTCString()
    });
    logAccess(req, 200, `bytes=${st.size}`);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function start({ root, staticPort, proxyPort }) {
  const variantDirs = {
    wps: path.join(root, "plugin-wps"),
    et: path.join(root, "plugin-et"),
    wpp: path.join(root, "plugin-wpp"),
    pdf: path.join(root, "plugin-pdf")
  };

  for (const [host, dir] of Object.entries(variantDirs)) {
    if (!fs.existsSync(dir)) {
      console.error(`[serve] ⚠️  缺少 ${dir}（${host} 变体目录）。请先运行 build-variants.js。`);
    }
  }

  const server = http.createServer((req, res) => {
   // 修 T2：整个请求处理包一层 try/catch。任何同步异常若逃逸到 http 回调外会变成
   // uncaughtException 直接杀死这个常驻进程（ONLOGON 任务下要等下次登录才恢复）。
   try {
    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      setCors(res);
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    const parsed = url.parse(req.url || "/");
    // 修 T2：decodeURIComponent 对畸形百分号（/wps/%、/et/%ZZ）抛 URIError。
    // 之前无保护 → 任何扫描器一个坏 URL 就崩掉整个服务。这里兜底返回 400。
    let pathname;
    try {
      pathname = decodeURIComponent(parsed.pathname || "/");
    } catch (e) {
      setCors(res);
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request (malformed URL)");
      return;
    }

    // 健康检查
    if (pathname === "/health" || pathname === "/_health") {
      setCors(res);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, hosts: Object.keys(variantDirs) }));
      return;
    }

    // /wps/, /et/, /wpp/, /pdf/ 前缀路由
    const m = /^\/(wps|et|wpp|pdf)(\/.*)?$/.exec(pathname);
    if (!m) {
      setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("可用前缀: /wps/, /et/, /wpp/, /pdf/, /health");
      logAccess(req, 404, "unknown-prefix");
      return;
    }
    const host = m[1];
    let rel = m[2] || "/";
    if (rel === "/" || rel === "") rel = "/index.html";

    const baseDir = variantDirs[host];
    let target = safeJoin(baseDir, rel.replace(/^\//, ""));
    if (!target) {
      setCors(res);
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad path");
      return;
    }

    // 国际化：ribbon.xml 按 ~/.lingxi-ai/ui-lang.txt 切中英版本。
    // 部分 WPS 不支持 getLabel 动态回调，label 必须在 xml 里就是目标语言；
    // 切语言 → taskpane 调代理 /ui-lang 写侧车文件 → 重启 WPS 后这里发对应文件。
    if (/(^|\/)ribbon\.xml$/i.test(rel)) {
      try {
        const langFile = path.join(os.homedir(), ".lingxi-ai", "ui-lang.txt");
        if (String(fs.readFileSync(langFile, "utf8")).trim() === "en") {
          const enTarget = target.replace(/ribbon\.xml$/i, "ribbon.en.xml");
          if (fs.existsSync(enTarget)) target = enTarget;
        }
      } catch (e) { /* 侧车文件不存在 = 中文默认 */ }
    }

    serveFile(req, res, target);
   } catch (e) {
     console.error(`[serve] 请求处理异常（已兜底）: ${e && e.message}`);
     try { if (!res.headersSent) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); } res.end("Internal Server Error"); } catch (_) {}
   }
  });

  // 修 T2：listen 没有 error 监听时，端口被占（EADDRINUSE，常见于上次实例没退干净）会抛
  // unhandled error 崩进程。这里显式处理并退出（有 orphan 时人为清理更清晰）。
  server.on("error", (err) => {
    console.error(`[serve] 静态服务监听失败: ${err && err.code} ${err && err.message}`);
    // 端口被占用：连同已 spawn 的 proxy 一起收尾，避免留下半死不活的状态。
    try { if (typeof shutdown === "function") shutdown("listen-error"); } catch (_) {}
    process.exit(1);
  });

  server.listen(staticPort, "127.0.0.1", () => {
    console.log(`[serve] 静态服务启动: http://127.0.0.1:${staticPort}`);
    console.log(`[serve] 代理服务首选端口: ${proxyPort}`);
    console.log(`[serve]   /wps/  → ${variantDirs.wps}`);
    console.log(`[serve]   /et/   → ${variantDirs.et}`);
    console.log(`[serve]   /wpp/  → ${variantDirs.wpp}`);
    console.log(`[serve]   /pdf/  → ${variantDirs.pdf}`);
  });

  // 找一份 proxy-server.js（变体目录里都有）
  const proxyCandidates = [
    path.join(variantDirs.wps, "tools", "proxy-server.js"),
    path.join(variantDirs.et, "tools", "proxy-server.js"),
    path.join(variantDirs.wpp, "tools", "proxy-server.js"),
    path.join(__dirname, "proxy-server.js")
  ];
  const proxyScript = proxyCandidates.find((p) => fs.existsSync(p));
  if (!proxyScript) {
    console.error("[serve] 找不到 proxy-server.js，AI 调用和图表会失败");
    return;
  }

  // 选一个支持 node:sqlite 的 node（优先内置 runtime node）。选不出来就报错退出，
  // 不降级到无 SQLite（缓存不允许退回 localStorage）。runtime 在变体根目录下。
  const { pickProxyLauncher } = require("./pick-node.js");
  const proxyLauncher = pickProxyLauncher(path.dirname(path.dirname(proxyScript)), "tools/proxy-server.js");
  if (proxyLauncher.error) {
    console.error("[serve] 错误：" + proxyLauncher.error);
    return;
  }

  let shuttingDown = false;
  let proxy = null;

  const wireProxy = (stream, target) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) target.write(`[proxy] ${line}\n`);
    });
  };

  // 修 #6：proxy 子进程崩了要拉起来（它承载 AI 调用 + 图片上传），否则整个会话静默失效。
  // 用退避 + 上限，避免崩溃风暴（proxy 一起来就崩会打满 CPU）。
  let proxyRestarts = 0;
  let lastProxyStart = 0;
  const spawnProxy = () => {
    if (shuttingDown) return;
    lastProxyStart = Date.now();
    proxy = spawn(proxyLauncher.nodeBin, proxyLauncher.args, {
      cwd: path.dirname(proxyScript),
      stdio: ["ignore", "pipe", "pipe"]
    });
    wireProxy(proxy.stdout, process.stdout);
    wireProxy(proxy.stderr, process.stderr);
    proxy.on("error", (err) => {
      console.error(`[serve] proxy spawn 失败: ${err && err.message}`);
    });
    proxy.on("exit", (code, signal) => {
      console.error(`[serve] proxy 进程退出 code=${code} signal=${signal}`);
      if (shuttingDown) return;
      // 起来后活了 >30s 才算"正常运行过"，把重启计数清零；否则累加，超过 10 次就放弃。
      if (Date.now() - lastProxyStart > 30000) proxyRestarts = 0;
      proxyRestarts += 1;
      if (proxyRestarts > 10) {
        console.error("[serve] proxy 连续重启过多，停止自动拉起（需排查 proxy-server.js）");
        return;
      }
      const delay = Math.min(1000 * proxyRestarts, 10000);
      console.error(`[serve] ${delay}ms 后重启 proxy（第 ${proxyRestarts} 次）...`);
      setTimeout(spawnProxy, delay);
    });
  };
  spawnProxy();

  const killProxy = () => {
    if (proxy && !proxy.killed) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(proxy.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
        } else {
          proxy.kill("SIGTERM");
        }
      } catch (e) { /* ignore */ }
    }
  };

  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[serve] 关闭中（${reason}）...`);
    try { server.close(); } catch (e) {}
    killProxy();
    setTimeout(() => process.exit(0), 800);
  };
  process.on("SIGINT", () => shutdown("Ctrl-C"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // 修 T2：本进程若因未捕获异常/rejection 崩溃，先把 proxy 子进程带走，避免它变成占着
  // 3890 端口的僵尸，导致下次登录起的 proxy 绑不上端口。
  process.on("uncaughtException", (err) => {
    console.error(`[serve] uncaughtException: ${err && (err.stack || err.message)}`);
    killProxy();
    setTimeout(() => process.exit(1), 200);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[serve] unhandledRejection: ${reason && (reason.stack || reason.message || reason)}`);
  });
}

start(parseArgs());
