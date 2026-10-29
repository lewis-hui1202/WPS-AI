/**
 * 本地 CORS 代理服务器
 *
 * WPS 加载项的 WebView 遵循浏览器 CORS 策略，而 chatgpt.com/backend-api/*
 * 和 api.openai.com/v1/* 均不允许前端跨域请求。此代理在本地转发请求并注入
 * CORS 响应头，使插件能正常调用远程 API。
 *
 * 路由映射：
 *   /codex/*  → https://chatgpt.com/backend-api/codex/*
 *   /openai/* → https://api.openai.com/v1/*
 *
 * 启动：node tools/proxy-server.js
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { URL, pathToFileURL } = require("url");

// 修 B9：全局兜底。任何路径漏掉的未捕获异常/未处理 rejection 都不该让整个代理进程退出
// （进程一死 AI 功能整体失效且不自愈）。这里只记录、不退出。
process.on("uncaughtException", (err) => {
  console.error("[proxy] uncaughtException（已兜底，不退出进程）:", err?.stack || err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[proxy] unhandledRejection（已兜底）:", reason?.stack || reason?.message || reason);
});

// 修 B19：判断是否为云元数据 / link-local SSRF 目标。只拦这类（169.254.0.0/16、
// fe80::/10、以及各云的 metadata 主机名），不影响本地/局域网自建模型的正常转发。
// 局限：仅对 URL 里直接写的 IP/主机名生效，DNS 解析到 link-local 的 rebinding 不覆盖。
// SSRF 守卫抽到 ./ssrf-guard.js（可单测）。isMetadataSsrfHost 供 /forward 用，
// isBlockedFetchHost 供 AI 可控的 /fetch-web、/image-search 用（更严，含 IPv6 映射/ULA/尾点）。
const { isMetadataSsrfHost, isBlockedFetchHost } = require("./ssrf-guard");
const kvStore = require("./kv-store.js");
const { readSystemClipboardText, writeSystemClipboardText, writeSystemClipboardImage } = require("./clipboard.js");
const { buildRemoteImageHeaders, shouldUseChromiumFallback } = require("./remote-image-fetch");
const { fetchImageWithChromium } = require("./chromium-fetch");
const { searchImages } = require("./image-search");
const { handleMcpcRequest, sharedManager: mcpcManager, sharedTokenGate: mcpcTokenGate } = require("./mcp-client-manager.js");

// 生成图保存目录。放到用户目录下，避免 WPS/macOS 对 /var/folders 临时目录图片 AddPicture 静默失败。
const RENDER_DIR = path.join(os.homedir(), ".lingxi-ai", "render");
try { fs.mkdirSync(RENDER_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const LINGXI_HOME = path.join(os.homedir(), ".lingxi-ai");
const DEBUG_LOG_FILE = path.join(LINGXI_HOME, "debug.log");
try { fs.mkdirSync(LINGXI_HOME, { recursive: true }); } catch (e) { /* ignore */ }

function appendDebugLogLine(line) {
  try {
    fs.appendFileSync(DEBUG_LOG_FILE, line + "\n", "utf8");
  } catch (e) { /* ignore */ }
}

// 文档快照备份根目录：~/.lingxi-ai/backups/
// 每个文档独立子目录：<basename>-<hash6>/，文件名 <ISO 时间>-<ext>
const BACKUPS_ROOT = path.join(os.homedir(), ".lingxi-ai", "backups");
const MAX_BACKUPS_PER_DOC = 20;
try { fs.mkdirSync(BACKUPS_ROOT, { recursive: true }); } catch (e) { /* ignore */ }

// 选择性启用宿主：各平台 WPS 共享插件清单 publish.xml 的候选路径。
// 跟 post-install-*/pre-uninstall-* 的路径表保持一致——改这里记得同步那边。
function publishXmlCandidates() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "kingsoft", "wps", "jsaddons", "publish.xml")];
  }
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml"),
      path.join(home, "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml")
    ];
  }
  // linux：候选目录跟 post-install-linux.sh 的 PUBLISH_DIRS 对齐
  const dirs = [
    ".local/share/Kingsoft/wps/jsaddons",
    ".config/Kingsoft/Office6/jsaddons",
    ".config/Kingsoft/Office365/jsaddons",
    ".config/wps365/jsaddons",
    ".config/Kingsoft/wps-365/jsaddons",
    ".config/Kingsoft/WPS-365/jsaddons",
    ".config/WPSOffice/jsaddons",
    ".config/wps-office/jsaddons",
    ".config/wps/jsaddons",
    ".kingsoft/office6/jsaddons",
    ".kingsoft/Office6/jsaddons",
    ".linglong/com.wps.office/data/.config/Kingsoft/Office6/jsaddons",
    "snap/wps-office/current/.config/Kingsoft/Office6/jsaddons",
    "snap/wps-office-multilang/current/.config/Kingsoft/Office6/jsaddons",
    ".var/app/com.wps.Office/config/Kingsoft/Office6/jsaddons"
  ];
  return dirs.map((d) => path.join(home, d, "publish.xml"));
}

// 用 enabledHosts 重写一个 publish.xml：保留别家厂商条目，只为选中的宿主写 lingxi 条目。
// staticBase 是插件加载的源（如 http://127.0.0.1:3889）。文件不存在返回 false（跳过）。
function rewritePublishXml(filePath, enabledHosts, staticBase) {
  let existing;
  try { existing = fs.readFileSync(filePath, "utf8"); } catch (e) { return false; }
  const entries = existing.match(/<jspluginonline\b[^>]*\/>/gi) || [];
  const others = entries.filter((e) => !/name\s*=\s*"lingxi-ai-/i.test(e)).map((e) => "  " + e.trim());
  const base = String(staticBase || "").replace(/\/+$/, "");
  const VALID = ["wps", "et", "wpp", "pdf"];
  const lingxi = enabledHosts
    .filter((h) => VALID.includes(h))
    .map((h) => `  <jspluginonline name="lingxi-ai-${h}" type="${h}" url="${base}/${h}/" enable="enable" install="null"/>`);
  const body = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<jsplugins>",
    ...others,
    ...lingxi,
    "</jsplugins>"
  ].join("\n") + "\n";
  fs.writeFileSync(filePath, body, "utf8");
  return true;
}

// 服务状态：枚举本机灵犀相关进程（node serve-permanent/proxy-server/mcp-server + launcher），
// 返回 [{ pid, rssBytes, kind }]。best-effort，取不到就返回空数组。
function serviceProcKind(cmd) {
  const s = String(cmd || "").toLowerCase();
  if (s.includes("serve-permanent")) return "静态服务";
  if (s.includes("proxy-server")) return "代理服务";
  if (s.includes("mcp-server")) return "MCP 桥";
  if (s.includes("lingxi-launcher")) return "启动器";
  return "";
}
function collectServiceProcesses() {
  const { spawnSync } = require("child_process");
  const out = [];
  try {
    if (process.platform === "win32") {
      const psScript = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='lingxi-launcher.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.WorkingSetSize)|$($_.CommandLine)\" }";
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], { encoding: "utf8", timeout: 5000, windowsHide: true });
      for (const line of String(r.stdout || "").split(/\r?\n/)) {
        const parts = line.split("|");
        if (parts.length < 3) continue;
        const pid = Number(parts[0]);
        const rss = Number(parts[1]);
        const kind = serviceProcKind(parts.slice(2).join("|"));
        if (pid && kind) out.push({ pid, rssBytes: rss || 0, kind });
      }
    } else {
      const r = spawnSync("ps", ["-A", "-o", "pid=,rss=,args="], { encoding: "utf8", timeout: 5000 });
      for (const line of String(r.stdout || "").split(/\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const rssKb = Number(m[2]);
        const kind = serviceProcKind(m[3]);
        if (pid && kind) out.push({ pid, rssBytes: rssKb * 1024, kind }); // ps 的 rss 单位是 KB
      }
    }
  } catch (e) { /* best-effort */ }
  return out;
}

const PROXY_PORT = Number(process.env.PROXY_PORT) || 3890;
// 端口梯子：偏好端口被占用时按 +1 顺序尝试，最多 PROXY_PORT_LADDER_SIZE 个候选。
// 这个常量也是前端 healthz 探测的爬梯上限——两边对齐才能让前端找到真实端口。
const PROXY_PORT_LADDER_SIZE = Number(process.env.PROXY_PORT_LADDER_SIZE) || 20;
// 服务签名：前端 healthz 探测时用 X-Lingxi-Service 头区分是不是我们的进程。
const PROXY_SERVICE_SIG = "lingxi-ai-proxy/v1";
const PROXY_FEATURES = [
  "active-pdf-path"
];
// 运行时端口落地文件：启动后写入实际监听的端口，给原生侧 / dev launcher 兜底读取。
const RUNTIME_PORT_FILE = path.join(os.homedir(), ".lingxi-ai", "runtime-port.json");
let RESOLVED_PROXY_PORT = PROXY_PORT;

function writeRuntimePortFile() {
  try {
    fs.mkdirSync(path.dirname(RUNTIME_PORT_FILE), { recursive: true });
    fs.writeFileSync(RUNTIME_PORT_FILE, JSON.stringify({
      port: RESOLVED_PROXY_PORT,
      pid: process.pid,
      ts: Date.now()
    }), "utf8");
  } catch (e) {
    console.warn("[proxy] 写入 runtime-port.json 失败:", e.message);
  }
}

// ===== 设备 SN（给灰度白名单匹配用） =====
// 进程内缓存 —— 同一次 proxy 启动只查一次系统命令。
let _deviceSnCache = null;
let _deviceSnSource = ""; // 标记 SN 是哪个来源（用于诊断）
const DEVICE_SN_FILE = path.join(os.homedir(), ".lingxi-ai", "device-sn.json");

function execSafe(cmd, args, timeoutMs = 8000) {
  const { spawnSync } = require("child_process");
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (r.error) {
      console.warn(`[device-sn] spawn ${cmd} failed:`, r.error.code || r.error.message);
      return null;
    }
    if (r.status !== 0) {
      console.warn(`[device-sn] ${cmd} exit ${r.status}:`, String(r.stderr || "").slice(0, 200));
      return null;
    }
    return String(r.stdout || "").trim();
  } catch (e) {
    console.warn(`[device-sn] ${cmd} threw:`, e.message);
    return null;
  }
}

function normalizeSn(s) {
  if (!s) return "";
  // 去掉头尾空白、首行表头（wmic 会输出 "UUID" 标题行）、各种引号
  const lines = String(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 去掉首行表头（如 "UUID" / "SerialNumber"）
  const cand = lines.length > 1 ? lines.slice(1).join(" ") : (lines[0] || "");
  return cand.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
}

async function getDeviceSn() {
  if (_deviceSnCache) return _deviceSnCache;

  // 1) 优先平台原生硬件 ID
  let sn = "";
  if (process.platform === "win32") {
    // 优先 PowerShell Get-CimInstance —— 现代 Windows（10/11）都有，且 Windows 11 22H2+ 已经把 wmic 砍了。
    // 退路：老 Windows（< 10 1809 / 没装 PowerShell）回 wmic。
    sn = normalizeSn(execSafe("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_ComputerSystemProduct).UUID"
    ]));
    if (sn && sn !== "0" && !/^F{8}-F{4}-F{4}-F{4}-F{12}$/i.test(sn)) {
      _deviceSnSource = "powershell-cs-uuid";
    } else {
      sn = normalizeSn(execSafe("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_BIOS).SerialNumber"
      ]));
      if (sn) _deviceSnSource = "powershell-bios-sn";
    }
    // wmic 兜底（老系统）
    if (!sn) {
      sn = normalizeSn(execSafe("wmic", ["csproduct", "get", "uuid"]));
      if (sn && sn !== "0" && !/^F{8}-F{4}-F{4}-F{4}-F{12}$/i.test(sn)) {
        _deviceSnSource = "wmic-csproduct-uuid";
      } else {
        sn = normalizeSn(execSafe("wmic", ["bios", "get", "serialnumber"]));
        if (sn) _deviceSnSource = "wmic-bios-sn";
      }
    }
  } else if (process.platform === "darwin") {
    const raw = execSafe("/bin/sh", ["-c",
      "ioreg -d2 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/{print $4}'"]);
    sn = String(raw || "").trim();
    if (sn) _deviceSnSource = "ioreg-platform-uuid";
  } else {
    // Linux：先 product_uuid（要 root，多数读不到），再 machine-id
    try { sn = fs.readFileSync("/sys/class/dmi/id/product_uuid", "utf8").trim(); _deviceSnSource = "dmi-product-uuid"; } catch (e) {}
    if (!sn) {
      try { sn = fs.readFileSync("/etc/machine-id", "utf8").trim(); _deviceSnSource = "machine-id"; } catch (e) {}
    }
  }

  // 2) 平台命令拿不到 → 用本地文件兜底（首次生成一次随机 UUID 存盘）
  if (!sn) {
    try {
      if (fs.existsSync(DEVICE_SN_FILE)) {
        const j = JSON.parse(fs.readFileSync(DEVICE_SN_FILE, "utf8"));
        if (j?.sn) { sn = j.sn; _deviceSnSource = j.source || "file-fallback"; }
      }
    } catch (e) {}
  }
  if (!sn) {
    sn = crypto.randomUUID();
    _deviceSnSource = "fallback-random";
    try {
      fs.mkdirSync(path.dirname(DEVICE_SN_FILE), { recursive: true });
      fs.writeFileSync(DEVICE_SN_FILE, JSON.stringify({ sn, source: _deviceSnSource, generatedAt: Date.now() }, null, 2));
    } catch (e) { /* 兜底失败：下次还是会生成 —— 不影响主流程 */ }
  }

  _deviceSnCache = sn;
  return sn;
}

// ===== 文档备份辅助函数 =====

function sendJson(res, code, body) {
  setCorsHeaders(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trimDebugValue(value, max = 900) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > max ? raw.slice(0, max) + "..." : raw;
}

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function localImagePathInfo(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error("图片文件不存在: " + resolved);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("路径不是文件: " + resolved);
  if (stat.size <= 0) throw new Error("图片文件为空: " + resolved);
  const ext = path.extname(resolved).toLowerCase();
  const realPath = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  const safePath = ensureSafeRenderPath(realPath, stat, ext);
  const jpegPath = ensureJpegRenderPath(safePath || realPath, stat, ext);
  return { path: resolved, realPath, safePath, jpegPath, size: stat.size, ext, platform: process.platform };
}

function safeBaseName(filePath, ext) {
  const raw = path.basename(filePath, ext || path.extname(filePath));
  return raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "image";
}

function imageMimeToExt(mime) {
  const v = String(mime || "").toLowerCase();
  if (v === "image/jpeg" || v === "image/jpg") return "jpg";
  if (v === "image/svg+xml") return "svg";
  if (v === "image/webp") return "webp";
  if (v === "image/gif") return "gif";
  return "png";
}

function parseImageDataUrlForSave(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|jpg|svg\+xml|webp|gif));base64,([\s\S]+)$/i.exec(String(dataUrl || ""));
  if (!m) throw new Error("invalid image dataUrl");
  const mediaType = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
  const buffer = Buffer.from(String(m[2] || "").replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("图片数据为空");
  return { mediaType, ext: imageMimeToExt(mediaType), buffer };
}

function sanitizeSaveAsFileName(name, ext) {
  const cleanExt = String(ext || "png").replace(/^\./, "") || "png";
  let base = path.basename(String(name || "").replace(/\0/g, ""));
  base = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim();
  if (!base || base === "." || base === "..") base = "lingxi-image";
  if (!path.extname(base)) base += "." + cleanExt;
  return base;
}

function defaultSaveAsDir() {
  const preferred = process.env.LINGXI_SAVE_AS_DIR || path.join(os.homedir(), "Downloads");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (e) {
    try { fs.mkdirSync(os.homedir(), { recursive: true }); } catch (err) {}
    return os.homedir();
  }
}

function ensureSaveAsExtension(filePath, ext) {
  if (path.extname(filePath)) return filePath;
  return filePath + "." + String(ext || "png").replace(/^\./, "");
}

function uniqueFallbackPath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function writeBufferAndSync(filePath, buffer) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const fd = fs.openSync(resolved, "w");
  try {
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    try { fs.fsyncSync(fd); } catch (e) {}
  } finally {
    fs.closeSync(fd);
  }
  return fs.statSync(resolved);
}

function runSaveAsCommand(cmd, args, timeoutMs = 300000) {
  const { spawnSync } = require("child_process");
  try {
    return spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: false });
  } catch (e) {
    return { error: e };
  }
}

function runShortCommand(cmd, args, timeoutMs = 1500) {
  const { spawnSync } = require("child_process");
  try {
    return spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  } catch (e) {
    return { error: e };
  }
}

function extractPdfPathsFromLsof(stdout) {
  const seen = new Set();
  const out = [];
  String(stdout || "").split(/\r?\n/).forEach((line) => {
    const match = line.match(/(\/.*?\.pdf)(?:\s+\([^)]*\))?\s*$/i);
    if (!match) return;
    const filePath = match[1].trim();
    if (!filePath || seen.has(filePath)) return;
    if (!fs.existsSync(filePath)) return;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) return;
      seen.add(filePath);
      out.push({ path: filePath, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
    } catch (e) {}
  });
  out.sort((a, b) => (b.atimeMs || b.mtimeMs || 0) - (a.atimeMs || a.mtimeMs || 0));
  return out;
}

function findActivePdfPathFromOpenFiles() {
  if (process.platform !== "darwin") return { ok: false, error: "当前自动识别仅支持 macOS WPS PDF" };
  const candidates = [
    ["lsof", ["-nP", "-c", "wpsoffice"]],
    ["lsof", ["-nP", "-c", "WPSOffice"]],
    ["lsof", ["-nP", "-c", "wps"]]
  ];
  const errors = [];
  for (const [cmd, args] of candidates) {
    const r = runShortCommand(cmd, args, 1800);
    if (r.error) {
      errors.push(`${cmd}: ${r.error.message || r.error}`);
      continue;
    }
    if (r.status !== 0 && !r.stdout) {
      errors.push(`${cmd} ${args.join(" ")} exit ${r.status}: ${String(r.stderr || "").slice(0, 160)}`);
      continue;
    }
    const paths = extractPdfPathsFromLsof(r.stdout);
    if (paths.length === 1) {
      return { ok: true, path: paths[0].path, candidates: paths, source: `${cmd} ${args.join(" ")}` };
    }
    if (paths.length > 1) {
      return {
        ok: false,
        ambiguous: true,
        candidates: paths,
        source: `${cmd} ${args.join(" ")}`,
        error: "检测到多个 WPS 已打开 PDF，lsof 无法判断当前活动 PDF。"
      };
    }
  }
  return { ok: false, error: errors.join("; ") || "未在 WPS 进程打开文件列表中找到 PDF" };
}

function appleScriptString(value) {
  return JSON.stringify(String(value || ""));
}

function powershellString(value) {
  return "'" + String(value || "").replace(/'/g, "''") + "'";
}

function chooseSaveAsPathMac(defaultDir, suggestedName) {
  const defaultFolder = defaultDir.endsWith(path.sep) ? defaultDir : defaultDir + path.sep;
  const script = [
    `set defaultFileName to ${appleScriptString(suggestedName)}`,
    `set defaultFolder to POSIX file ${appleScriptString(defaultFolder)}`,
    "try",
    '  set chosenFile to choose file name with prompt "保存图片" default name defaultFileName default location defaultFolder',
    "  POSIX path of chosenFile",
    "on error number -128",
    '  ""',
    "end try"
  ].join("\n");
  const r = runSaveAsCommand("/usr/bin/osascript", ["-e", script]);
  if (r.status === 0) {
    const out = String(r.stdout || "").trim();
    return out ? { path: out, dialog: "osascript" } : { cancelled: true, dialog: "osascript" };
  }
  return null;
}

function chooseSaveAsPathWindows(defaultDir, suggestedName) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.SaveFileDialog",
    "$dialog.Title = '保存图片'",
    `$dialog.InitialDirectory = ${powershellString(defaultDir)}`,
    `$dialog.FileName = ${powershellString(suggestedName)}`,
    "$dialog.Filter = '图片文件|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.svg|所有文件|*.*'",
    "$dialog.OverwritePrompt = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }"
  ].join("; ");
  const r = runSaveAsCommand("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script]);
  if (r.status === 0) {
    const out = String(r.stdout || "").trim();
    return out ? { path: out, dialog: "powershell" } : { cancelled: true, dialog: "powershell" };
  }
  return null;
}

function linuxDialogFailedBecauseUnavailable(result) {
  const stderr = String(result?.stderr || "");
  if (result?.error?.code === "ENOENT") return true;
  return /cannot open display|Gtk-WARNING|qt\.qpa|could not connect|not found|failed to open/i.test(stderr);
}

function chooseSaveAsPathLinux(defaultPath) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  const zenity = runSaveAsCommand("zenity", ["--file-selection", "--save", "--confirm-overwrite", "--filename", defaultPath]);
  if (zenity.status === 0) {
    const out = String(zenity.stdout || "").trim();
    return out ? { path: out, dialog: "zenity" } : { cancelled: true, dialog: "zenity" };
  }
  if (zenity.status === 1 && !linuxDialogFailedBecauseUnavailable(zenity)) return { cancelled: true, dialog: "zenity" };

  const kdialog = runSaveAsCommand("kdialog", ["--getsavefilename", defaultPath, "Images (*.png *.jpg *.jpeg *.webp *.gif *.svg)"]);
  if (kdialog.status === 0) {
    const out = String(kdialog.stdout || "").trim();
    return out ? { path: out, dialog: "kdialog" } : { cancelled: true, dialog: "kdialog" };
  }
  if (kdialog.status === 1 && !linuxDialogFailedBecauseUnavailable(kdialog)) return { cancelled: true, dialog: "kdialog" };
  return null;
}

function chooseSaveAsPath(defaultDir, suggestedName) {
  if (process.env.LINGXI_SAVE_AS_DISABLE_DIALOG === "1") return null;
  const defaultPath = path.join(defaultDir, suggestedName);
  if (process.platform === "darwin") return chooseSaveAsPathMac(defaultDir, suggestedName);
  if (process.platform === "win32") return chooseSaveAsPathWindows(defaultDir, suggestedName);
  return chooseSaveAsPathLinux(defaultPath);
}

function isInsideDir(filePath, dir) {
  try {
    const rel = path.relative(dir, filePath);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch (e) {
    return false;
  }
}

function ensureSafeRenderPath(realPath, stat, ext) {
  try {
    const renderRoot = fs.realpathSync.native ? fs.realpathSync.native(RENDER_DIR) : fs.realpathSync(RENDER_DIR);
    if (realPath === renderRoot || isInsideDir(realPath, renderRoot)) return realPath;
  } catch (e) {}
  const suffix = ext || path.extname(realPath) || ".png";
  const hash = crypto
    .createHash("sha256")
    .update(`${realPath}:${stat.size}:${Number(stat.mtimeMs || 0)}`)
    .digest("hex")
    .slice(0, 16);
  const target = path.join(RENDER_DIR, `${safeBaseName(realPath, suffix)}-${hash}${suffix}`);
  try {
    const existing = fs.existsSync(target) ? fs.statSync(target) : null;
    if (!existing || existing.size !== stat.size) {
      fs.copyFileSync(realPath, target);
      const fd = fs.openSync(target, "r");
      try { fs.fsyncSync(fd); } catch (e) {}
      finally { fs.closeSync(fd); }
    }
  } catch (e) {
    throw new Error(`复制图片到稳定目录失败: ${e.message || e}`);
  }
  return target;
}

function ensureJpegRenderPath(inputPath, stat, ext) {
  if (!inputPath || ![".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"].includes(String(ext || "").toLowerCase())) {
    return "";
  }
  if (process.platform !== "darwin") return "";
  const hash = crypto
    .createHash("sha256")
    .update(`${inputPath}:${stat.size}:${Number(stat.mtimeMs || 0)}:jpeg`)
    .digest("hex")
    .slice(0, 16);
  const target = path.join(RENDER_DIR, `${safeBaseName(inputPath, path.extname(inputPath))}-${hash}.jpg`);
  try {
    const existing = fs.existsSync(target) ? fs.statSync(target) : null;
    if (existing && existing.size > 0) return target;
    const { spawnSync } = require("child_process");
    const r = spawnSync("/usr/bin/sips", ["-s", "format", "jpeg", inputPath, "--out", target], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    });
    if (r.error || r.status !== 0) {
      console.warn("[proxy] sips 转 JPEG 失败:", r.error?.message || r.stderr || r.status);
      return "";
    }
    const outStat = fs.statSync(target);
    if (!outStat.isFile() || outStat.size <= 0) return "";
    const fd = fs.openSync(target, "r");
    try { fs.fsyncSync(fd); } catch (e) {}
    finally { fs.closeSync(fd); }
    return target;
  } catch (e) {
    console.warn("[proxy] JPEG 兜底生成失败:", e.message);
    return "";
  }
}

function writeImageHtmlFile(imagePath) {
  const info = localImagePathInfo(imagePath);
  const src = pathToFileURL(info.safePath || info.realPath).href;
  const hash = crypto
    .createHash("sha256")
    .update(`${info.safePath || info.realPath}:${info.size}`)
    .digest("hex")
    .slice(0, 16);
  const htmlPath = path.join(RENDER_DIR, `insert-image-${hash}.html`);
  const html = [
    "<!doctype html>",
    "<html>",
    "<head><meta charset=\"utf-8\"></head>",
    "<body>",
    `<img src="${escapeHtmlAttr(src)}" style="max-width:100%;height:auto;" />`,
    "</body>",
    "</html>"
  ].join("");
  const fd = fs.openSync(htmlPath, "w");
  try {
    fs.writeSync(fd, html, 0, "utf8");
    try { fs.fsyncSync(fd); } catch (e) {}
  } finally {
    fs.closeSync(fd);
  }
  return { htmlPath, imagePath: info.safePath || info.realPath, size: info.size };
}

function imageRtfKind(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "jpegblip";
  if (e === ".png") return "pngblip";
  return "";
}

function pngDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    i += 2;
    while (marker === 0xff && i < buf.length) i += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (i + 2 > buf.length) break;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) };
    }
    i += len;
  }
  return null;
}

function imageDimensions(buf, ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".png") return pngDimensions(buf);
  if (e === ".jpg" || e === ".jpeg") return jpegDimensions(buf);
  return null;
}

function writeImageRtfFile(imagePath) {
  const info = localImagePathInfo(imagePath);
  let embedPath = info.safePath || info.realPath;
  let ext = path.extname(embedPath).toLowerCase();
  let kind = imageRtfKind(ext);
  if (!kind && info.jpegPath) {
    embedPath = info.jpegPath;
    ext = ".jpg";
    kind = "jpegblip";
  }
  if (!kind) throw new Error(`RTF 图片兜底暂不支持此格式：${ext || "unknown"}`);
  const buf = fs.readFileSync(embedPath);
  const dim = imageDimensions(buf, ext);
  const controls = [`\\${kind}`];
  if (dim && dim.width > 0 && dim.height > 0) {
    controls.push(`\\picw${dim.width}`, `\\pich${dim.height}`, `\\picwgoal${Math.round(dim.width * 15)}`, `\\pichgoal${Math.round(dim.height * 15)}`);
  }
  const hex = buf.toString("hex");
  const hash = crypto.createHash("sha256").update(`${embedPath}:${buf.length}:rtf`).digest("hex").slice(0, 16);
  const rtfPath = path.join(RENDER_DIR, `insert-image-${hash}.rtf`);
  const rtf = `{\\rtf1\\ansi\\deff0{\\pict${controls.join("")}\n${hex}\n}}\n`;
  const fd = fs.openSync(rtfPath, "w");
  try {
    fs.writeSync(fd, rtf, 0, "utf8");
    try { fs.fsyncSync(fd); } catch (e) {}
  } finally {
    fs.closeSync(fd);
  }
  return { rtfPath, imagePath: embedPath, size: buf.length, kind, width: dim?.width || null, height: dim?.height || null };
}

function writeHtmlFragmentFile(html) {
  const raw = String(html || "");
  if (!raw.trim()) throw new Error("html 必填");
  if (Buffer.byteLength(raw, "utf8") > 8 * 1024 * 1024) throw new Error("html 过大");
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const htmlPath = path.join(RENDER_DIR, `insert-html-${hash}-${Date.now()}.html`);
  const normalized = /<html[\s>]/i.test(raw)
    ? raw
    : [
        "<!doctype html>",
        "<html>",
        "<head><meta charset=\"utf-8\"></head>",
        /<body[\s>]/i.test(raw) ? raw : `<body>${raw}</body>`,
        "</html>"
      ].join("");
  const fd = fs.openSync(htmlPath, "w");
  try {
    fs.writeSync(fd, normalized, 0, "utf8");
    try { fs.fsyncSync(fd); } catch (e) {}
  } finally {
    fs.closeSync(fd);
  }
  return { htmlPath, size: Buffer.byteLength(normalized, "utf8") };
}

// 给文档生成稳定的备份子目录名：<safe-basename>-<6 位 hash>
// hash 取自完整路径，避免同名文件互相覆盖
function docBackupDir(docPath) {
  const base = path.basename(docPath, path.extname(docPath)).replace(/[^\w一-龥.-]/g, "_").slice(0, 40);
  const hash = crypto.createHash("md5").update(path.resolve(docPath)).digest("hex").slice(0, 6);
  return path.join(BACKUPS_ROOT, `${base}-${hash}`);
}

function ensureDocBackupDir(docPath) {
  const dir = docBackupDir(docPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 砍掉超过 maxKeep 份的旧备份；.pre-restore 这种安全备份 也参与计数但单独 GC
function gcDocBackups(dir, maxKeep) {
  try {
    const entries = fs.readdirSync(dir)
      .filter((n) => !n.includes(".pre-restore"))
      .map((n) => ({ name: n, fp: path.join(dir, n), mt: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    entries.slice(maxKeep).forEach((e) => {
      try { fs.unlinkSync(e.fp); } catch (_) {}
    });
    // .pre-restore 留最近 5 份
    const safety = fs.readdirSync(dir)
      .filter((n) => n.includes(".pre-restore"))
      .map((n) => ({ name: n, fp: path.join(dir, n), mt: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    safety.slice(5).forEach((e) => {
      try { fs.unlinkSync(e.fp); } catch (_) {}
    });
  } catch (e) { /* GC 失败不影响主流程 */ }
}

// NOTE: 路由前缀到远程目标的映射，按匹配优先级排列
const ROUTE_MAP = [
  { prefix: "/codex/", target: "https://chatgpt.com/backend-api/codex/" },
  { prefix: "/openai/", target: "https://api.openai.com/v1/" }
];

// NOTE: 允许透传到远程 API 的请求头，其余由代理过滤
const PASSTHROUGH_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "client_version",
  "user-agent",
  "x-api-key",
  "api-key",            // Azure OpenAI 鉴权头
  "x-goog-api-key",     // Google Gemini 鉴权头
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-beta"
]);

/**
 * 为响应注入 CORS 头，允许 WPS WebView 的跨域请求
 */
function setCorsHeaders(res) {
  const origin = res.req?.headers?.origin || "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  if (origin) res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, chatgpt-account-id, OpenAI-Beta, originator, client_version, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, anthropic-beta"
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, X-Request-Id, X-Lingxi-Service");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * 根据请求路径匹配路由，返回远程目标 URL
 * @param {string} pathname - 请求路径
 * @param {string} search - 查询字符串（含 ? 前缀）
 */
function resolveTarget(pathname, search) {
  // 通用转发：/forward/<urlencoded-base>/<rest> → <decoded-base>/<rest>
  // 用于 OpenAI 兼容端点和 Anthropic Claude 自定义 baseURL。
  const FORWARD_PREFIX = "/forward/";
  if (pathname.startsWith(FORWARD_PREFIX)) {
    const tail = pathname.slice(FORWARD_PREFIX.length);
    const slashIndex = tail.indexOf("/");
    const encodedBase = slashIndex === -1 ? tail : tail.slice(0, slashIndex);
    const rest = slashIndex === -1 ? "" : tail.slice(slashIndex);
    let decodedBase;
    try {
      decodedBase = decodeURIComponent(encodedBase);
    } catch (error) {
      return null;
    }
    if (!/^https?:\/\//i.test(decodedBase)) {
      return null;
    }
    // 修 B19：拦截 SSRF 头号目标——云厂商元数据地址（169.254.169.254 等 link-local）。
    // 注意本代理刻意支持转发到用户本地/局域网自建模型（localhost / 192.168.x 的 Ollama 等），
    // 所以不封普通私网段，只封没有任何合法模型会用、却能窃取云凭证的 link-local/元数据端点。
    try {
      const bh = new URL(decodedBase).hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (isMetadataSsrfHost(bh)) return null;
    } catch (e) { return null; }
    return decodedBase.replace(/\/+$/, "") + rest + (search || "");
  }

  for (const route of ROUTE_MAP) {
    if (pathname.startsWith(route.prefix)) {
      const suffix = pathname.slice(route.prefix.length);
      return route.target + suffix + (search || "");
    }
  }
  return null;
}

/**
 * 过滤请求头，仅保留允许透传的 header
 */
function filterHeaders(rawHeaders) {
  const filtered = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (PASSTHROUGH_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * 读取请求体（用于 POST/PUT 等方法）
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 将请求转发到远程 API 并将响应流式传回客户端
 */
// 单个转发请求的 socket 超时（socket 空闲/无数据收发即触发，收到数据会重置）。
// 这是「首字节/无响应」阶段的上限：连上了但远端一直不回（含推理模型 tool 调用后思考很久）。
// 默认放宽到 300s，可用 LINGXI_FORWARD_TIMEOUT_MS 环境变量覆盖。
const FORWARD_SOCKET_TIMEOUT_MS = Number(process.env.LINGXI_FORWARD_TIMEOUT_MS) || 300 * 1000;

// 本地慢生图异步任务表：taskId → { status:"pending"|"done"|"error", data?, error?, at }
const localImageTasks = new Map();
const LOCAL_IMAGE_MAX_MS = Number(process.env.LINGXI_LOCAL_IMAGE_TIMEOUT_MS) || 20 * 60 * 1000;
// 后台向本地生图服务发请求，收完整响应存进任务表（Node 侧无 WebView 超时限制）
function runLocalImageTask(taskId, url, payload, headers) {
  const transport = url.protocol === "https:" ? https : http;
  const bodyBuf = Buffer.from(JSON.stringify(payload || {}), "utf8");
  const outHeaders = Object.assign({ "Content-Type": "application/json" }, headers || {});
  outHeaders["Content-Length"] = String(bodyBuf.length);
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method: "POST",
    headers: outHeaders
  };
  const finish = (patch) => {
    const t = localImageTasks.get(taskId);
    if (t && t.status === "pending") localImageTasks.set(taskId, Object.assign(t, patch, { doneAt: Date.now() }));
  };
  const reqOut = transport.request(options, (up) => {
    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (up.statusCode >= 200 && up.statusCode < 300) {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { finish({ status: "error", error: "本地生图返回非 JSON：" + raw.slice(0, 200) }); return; }
        finish({ status: "done", data });
      } else {
        finish({ status: "error", error: `本地生图服务 HTTP ${up.statusCode}：${raw.slice(0, 300)}` });
      }
    });
  });
  reqOut.setTimeout(LOCAL_IMAGE_MAX_MS, () => { try { reqOut.destroy(new Error(`本地生图超时（>${LOCAL_IMAGE_MAX_MS / 1000}s）`)); } catch (e) {} });
  reqOut.on("error", (err) => {
    let msg = err && err.message ? err.message : String(err);
    // ECONNRESET：本地生图服务多半崩溃/OOM/被并发压垮了，给指向性提示
    if (err && err.code === "ECONNRESET") {
      msg = "本地生图服务重置了连接（ECONNRESET）——服务可能已崩溃或高负载 OOM。请检查生图服务窗口日志、必要时重启服务（如 Boogu 的 start_api.ps1），并避免同时发起多张生图。";
    }
    finish({ status: "error", error: msg });
  });
  reqOut.write(bodyBuf);
  reqOut.end();
}
// 兜底清理：done 5min 后 / pending 超时后删除，防内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of localImageTasks) {
    if (t.status !== "pending" && t.doneAt && now - t.doneAt > 5 * 60 * 1000) localImageTasks.delete(id);
    else if (t.status === "pending" && now - t.at > LOCAL_IMAGE_MAX_MS + 60 * 1000) localImageTasks.delete(id);
  }
}, 60 * 1000).unref?.();
// 响应一旦开始（拿到 headers / 首个 SSE 块）就证明连接是活的，切到更宽松的「流式空闲」超时：
// 每来一块数据就重置，只有连续这么久没有任何数据才判定挂死。让慢但活着的 SSE 不被误杀。
const FORWARD_STREAM_IDLE_MS = Number(process.env.LINGXI_FORWARD_STREAM_IDLE_MS) || 600 * 1000;

/**
 * 判断 IPv4 是否落在常见 Cloudflare 边缘段。
 * 用于 ECONNRESET 错误归因 —— 落在 CF 段且 TLS 没握成功，几乎 100% 是 JA3 拦截。
 * 段来源：https://www.cloudflare.com/ips-v4
 *   104.16.0.0/12  → 104.16.0.0 ~ 104.31.255.255
 *   104.21.0.0/16  → 含在 /12 内（example.com 解到的 104.21.11.126 就在这）
 *   172.64.0.0/13  → 172.64.0.0 ~ 172.71.255.255
 *   162.158.0.0/15 → 162.158.0.0 ~ 162.159.255.255
 *   188.114.96.0/20
 *   190.93.240.0/20
 *   197.234.240.0/22
 *   198.41.128.0/17 → 198.41.128.0 ~ 198.41.255.255
 *   141.101.64.0/18
 *   108.162.192.0/18
 *   173.245.48.0/20
 *   131.0.72.0/22
 * 这里只判最常见几段，未命中也不致命 —— 仍然给出 "TLS 握手阶段被 RST" 通用提示。
 */
function isCloudflareIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 104 && b >= 16 && b <= 31) return true;            // 104.16.0.0/12
  if (a === 172 && b >= 64 && b <= 71) return true;            // 172.64.0.0/13
  if (a === 162 && (b === 158 || b === 159)) return true;      // 162.158.0.0/15
  if (a === 198 && b === 41) return true;                      // 198.41.128.0/17 近似
  if (a === 141 && b >= 101 && b <= 101) return true;          // 141.101.64.0/18 近似
  if (a === 108 && b === 162) return true;                     // 108.162.192.0/18 近似
  if (a === 173 && b === 245) return true;                     // 173.245.48.0/20 近似
  if (a === 131 && b === 0) return true;                       // 131.0.72.0/22 近似
  if (a === 188 && b === 114) return true;                     // 188.114.96.0/20 近似
  if (a === 190 && b === 93) return true;                      // 190.93.240.0/20 近似
  return false;
}

function proxyRequest(targetUrl, method, headers, body, clientRes, extraOptions = {}) {
  const url = new URL(targetUrl);

  // Content-Length 必须自己算并写回：browser 的 Content-Length 被 PASSTHROUGH 过滤了，
  // Node http.request 不见 Content-Length 会自动用 Transfer-Encoding: chunked 发 body。
  // 很多 OpenAI 兼容中转（Cloudflare 前端 / sub2api 等）严格拒绝 chunked POST，
  // 表现就是建连接后立刻 RST（read ECONNRESET）。
  const outHeaders = Object.assign({}, headers);
  if (body && body.length > 0) {
    outHeaders["Content-Length"] = String(body.length);
  } else {
    delete outHeaders["Content-Length"];
    delete outHeaders["content-length"];
  }

  const options = Object.assign({
    hostname: url.hostname,
    // 协议正确的默认端口：http 走 80、https 走 443。之前一律 || 443 会让 http URL
    // 错连 443 而 ETIMEDOUT。
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers: outHeaders
  }, extraOptions);

  // DEBUG: 打印发送到远端的请求头（修 B14：脱敏，绝不把密钥打进日志）
  {
    const redacted = {};
    for (const k of Object.keys(headers || {})) {
      redacted[k] = /^(authorization|x-api-key|api-key|cookie|proxy-authorization)$/i.test(k)
        ? "***REDACTED***"
        : headers[k];
    }
    console.log(`[proxy] → 请求头:`, JSON.stringify(redacted, null, 2));
  }

  const transport = url.protocol === "https:" ? https : http;
  let timedOut = false;
  // socket 生命周期标记 —— 错误处理时用来区分"TLS 握手阶段被 RST"vs"应用层 RST"，
  // 两种 ECONNRESET 病因和解法完全不同，必须分开提示。
  let tcpConnected = false;
  let tlsHandshakeDone = false;
  let remoteAddress = null;
  const proxyReq = transport.request(options, (proxyRes) => {
    // socket 信息只在收到响应那一刻肯定有
    const sock = proxyRes.socket;
    if (sock) {
      console.log(`[proxy] socket ${sock.remoteAddress}:${sock.remotePort} ALPN=${sock.alpnProtocol || "h1.1"}`);
    }
    // DEBUG: 打印远端响应状态码
    console.log(`[proxy] ← ${targetUrl} 响应: ${proxyRes.statusCode}`);

    // 响应已开始 = 连接证明活着。把激进的首字节超时换成宽松的「流式空闲」超时，
    // 这样慢但活着的 SSE（模型思考久、chunk 间隔大）不会被误判超时。仍保留一个空闲上限防真挂死。
    try { proxyReq.setTimeout(FORWARD_STREAM_IDLE_MS); } catch (e) {}

    setCorsHeaders(clientRes);

    // NOTE: 透传远程 API 的状态码和关键响应头
    clientRes.writeHead(proxyRes.statusCode, {
      "Content-Type": proxyRes.headers["content-type"] || "application/json",
      "Cache-Control": "no-cache",
      ...(proxyRes.headers["x-request-id"] && { "X-Request-Id": proxyRes.headers["x-request-id"] })
    });

    // 修 B9：pipe 不会给 clientRes 注册 error 监听。客户端在 SSE 流中途断开后继续 write
    // 会触发 clientRes 的 error（ECONNRESET/EPIPE/write-after-end），无人监听即未捕获异常
    // → 整个代理进程崩溃。这里显式吞掉写端错误，并在响应体源上出错时收尾。
    clientRes.on("error", (e) => {
      console.warn(`[proxy] 客户端连接写入错误（多为客户端提前断开）: ${e?.message || e}`);
      try { proxyRes.destroy(); } catch (_) {}
    });
    proxyRes.on("error", (e) => {
      console.warn(`[proxy] 上游响应流错误: ${e?.message || e}`);
      try { clientRes.end(); } catch (_) {}
    });

    // DEBUG: 对错误响应，手动读取并记录响应体后再写入客户端
    if (proxyRes.statusCode >= 400) {
      const chunks = [];
      proxyRes.on("data", (chunk) => {
        chunks.push(chunk);
        try { clientRes.write(chunk); } catch (_) {}
      });
      proxyRes.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf-8").slice(0, 500);
        console.log(`[proxy] ← 错误响应体: ${bodyText}`);
        try { clientRes.end(); } catch (_) {}
      });
    } else {
      // 流式透传响应体，支持 SSE
      proxyRes.pipe(clientRes);
    }
  });

  // 显式超时：socket 在首字节前无数据收发就主动断开，配清晰错误体回客户端。
  // 不设这个会用 OS 默认（Windows 约 21s 才能拿到 ETIMEDOUT，期间用户只能干等）。
  //
  // 本地慢生图放宽：Boogu 等本地生图服务是「阻塞同步请求」——发出后 socket 完全空闲，
  // 直到整张图生成完（首次还要加载 22GB 模型）才返回响应头，期间没有任何字节往返，
  // 会撞上首字节超时。对「本地目标 + 生图端点」用更长的首字节上限（默认 20min，
  // 可用 LINGXI_LOCAL_IMAGE_TIMEOUT_MS 覆盖），云端渠道维持原 300s 不变。
  const isLocalHost = /^(127\.|0\.0\.0\.0|localhost$|::1$|\[::1\]$|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(url.hostname || ""));
  const isImageGen = /\/images\/generations\b/.test(String(url.pathname || ""));
  const firstByteTimeout = (isLocalHost && isImageGen)
    ? (Number(process.env.LINGXI_LOCAL_IMAGE_TIMEOUT_MS) || 20 * 60 * 1000)
    : FORWARD_SOCKET_TIMEOUT_MS;
  proxyReq.setTimeout(firstByteTimeout, () => {
    timedOut = true;
    try { proxyReq.destroy(new Error(`socket timeout after ${firstByteTimeout / 1000}s`)); } catch (e) {}
  });

  // socket 生命周期诊断：让 ECONNRESET 时能看清 DNS 解到哪、TCP 是否真连上、TLS 是否真握上
  proxyReq.on("socket", (sock) => {
    sock.on("lookup", (err, address, family, host) => {
      if (err) console.warn(`[proxy] DNS ${host} 解析失败:`, err.message);
      else {
        console.log(`[proxy] DNS ${host} → ${address} (IPv${family})`);
        remoteAddress = address;
      }
    });
    sock.on("connect", () => {
      tcpConnected = true;
      if (sock.remoteAddress) remoteAddress = sock.remoteAddress;
      console.log(`[proxy] TCP 连上 ${sock.remoteAddress}:${sock.remotePort}`);
    });
    sock.on("secureConnect", () => {
      tlsHandshakeDone = true;
      console.log(`[proxy] TLS 握手成功 ${sock.remoteAddress}:${sock.remotePort} ALPN=${sock.alpnProtocol || "(none)"} cipher=${(sock.getCipher?.() || {}).name || "?"}`);
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[proxy] 转发请求失败: ${targetUrl}`, err.message);
    // 网络层常见错误码翻译成可读提示。带上 host 让用户能快速定位 Base URL 是否写错。
    const code = err.code || "";
    const hostHint = `${url.protocol}//${url.hostname}${url.port ? ":" + url.port : ""}`;
    let friendly = err.message;
    if (timedOut || /timeout/i.test(err.message)) {
      friendly = `连接 ${hostHint} 长时间无数据超时。检查 Base URL 是否正确、远端是否在线；若模型思考较久属正常，可调大环境变量 LINGXI_FORWARD_TIMEOUT_MS（首字节，当前 ${FORWARD_SOCKET_TIMEOUT_MS / 1000}s）或 LINGXI_FORWARD_STREAM_IDLE_MS（流式空闲，当前 ${FORWARD_STREAM_IDLE_MS / 1000}s）。`;
    } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      friendly = `DNS 解析失败：${hostHint}。请检查 Base URL 域名拼写。`;
    } else if (code === "ECONNREFUSED") {
      friendly = `连接被拒绝：${hostHint}。远端服务可能没在监听该端口。`;
    } else if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      friendly = `网络不可达：${hostHint}（${code}）。检查防火墙/VPN/代理。`;
    } else if (code === "ECONNRESET" || code === "EPIPE") {
      // 关键分流：HTTPS 场景下，TCP 已连但 TLS 没握成功 == TLS 握手阶段被 RST，
      // 99% 是远端按 TLS 指纹 (JA3) 拒了我们的 Node OpenSSL ClientHello。
      // 这种情况换 baseUrl / 走 IP 直连才有救，重试或换 model/key 都没用，必须明确告知。
      const isHttps = url.protocol === "https:";
      const isTlsStageReset = isHttps && tcpConnected && !tlsHandshakeDone;
      const cfLike = isCloudflareIp(remoteAddress);
      if (isTlsStageReset && cfLike) {
        friendly = `图像服务被 Cloudflare 边缘按 TLS 指纹拦了（远端 IP ${remoteAddress} 属 CF 段，TCP 连上后 TLS 握手就被 RST）。`
          + `这是 CF 边缘 SSL/TLS 终止层做的，跟控制台「防护」开关无关、关不掉。`
          + `解决：把 baseUrl 换到一个不挂 CF 的端点（自建 sub2api、siliconflow、openrouter、或源站 IP+端口直连），或在 WPS 设置里关掉「通过本地 CORS 代理」让浏览器 TLS 栈直连（前提是该端点配了 CORS）。`;
      } else if (isTlsStageReset) {
        friendly = `TCP 已连上 ${remoteAddress || hostHint} 但 TLS 握手被远端 RST（${code}）。`
          + `常见原因：远端按 TLS 指纹拦截（典型 CF/WAF）、SNI 不匹配、或要求客户端证书。`
          + `用 curl/Apifox 直连同一 URL 对照，如果它们能通而代理不通，多半是 TLS 指纹问题，要换 baseUrl。`;
      } else {
        friendly = `远端 ${hostHint} 主动重置了连接（${code}）。常见原因：API Key 无效 / 路径写错 / 中转网关拒绝当前请求 (例如不支持 Transfer-Encoding: chunked)。`;
      }
    } else if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      friendly = `TLS 证书校验失败：${hostHint}（${code}）。`;
    }
    setCorsHeaders(clientRes);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
    }
    try {
      clientRes.end(JSON.stringify({ error: { message: `代理转发失败：${friendly}`, code } }));
    } catch (e) {
      try { clientRes.end(); } catch (_) {}
    }
  });

  // 修 B9：客户端提前断开时取消上游请求，否则到远端的连接会一直挂到 180s 超时才释放，
  // 对永不结束的 SSE 流尤其严重（每次取消都留一条空转连接，高频操作累积泄漏）。
  clientRes.on("close", () => {
    if (!clientRes.writableEnded) {
      try { proxyReq.destroy(); } catch (_) {}
    }
  });

  if (body && body.length > 0) {
    proxyReq.write(body);
  }

  proxyReq.end();
}


// ===== MCP 桥：让外部 agent（Claude Code CLI 等）通过 mcp-server.js 调用 WPS plugin 暴露的工具 =====
// 设计：
//   1. WPS plugin（浏览器侧）POST /mcp/register 上报 tool 清单；之后长轮询 GET /mcp/poll 等任务。
//   2. 外部 MCP bridge（mcp-server.js stdio）POST /mcp/call 投递 call，挂着 res 等结果。
//   3. plugin /mcp/poll 拿到 call → 执行 → POST /mcp/result，proxy 把结果回写给挂着的外部 res。
//
// 仅本机 IPC，不出网；plugin 不在线时外部 /mcp/call 收到 503。
const mcpState = {
  tools: [],                         // 最近一次 plugin 注册的工具清单
  pluginRegisteredAt: 0,             // plugin 上线时间戳（ms）
  pendingCalls: new Map(),           // call_id → { res, ts }，外部投递后挂着等结果
  inboxForPlugin: [],                // plugin /poll 时按 FIFO 出队的 call
  pollerHolds: []                    // plugin 长轮询的 res 列队（一次取一个）
};
const MCP_CALL_TIMEOUT_MS = 60 * 1000;       // 单次 call 等待结果超时
const MCP_POLL_TIMEOUT_MS = 25 * 1000;       // plugin 长轮询超时（< 30s 避免某些反代关连接）
const MCP_PLUGIN_STALE_MS = 60 * 1000;       // 超过这个时间没注册就认为 plugin 下线

function genCallId() {
  return "mc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function pluginAlive() {
  return Date.now() - mcpState.pluginRegisteredAt < MCP_PLUGIN_STALE_MS;
}

// 把一个 call 推给 plugin：若有等待的 poller 立即喂出去；否则塞 inbox 等下次 poll
function dispatchCallToPlugin(call) {
  if (mcpState.pollerHolds.length > 0) {
    const pollerRes = mcpState.pollerHolds.shift();
    try { sendJson(pollerRes, 200, { ok: true, call }); } catch (e) {}
  } else {
    mcpState.inboxForPlugin.push(call);
  }
}

// 周期性 GC：超时的 pendingCalls / 长轮询 / inbox
setInterval(() => {
  const now = Date.now();
  // pending calls 超时
  mcpState.pendingCalls.forEach((entry, id) => {
    if (now - entry.ts > MCP_CALL_TIMEOUT_MS) {
      try { sendJson(entry.res, 504, { ok: false, error: "plugin 未在 60s 内返回结果" }); } catch (e) {}
      mcpState.pendingCalls.delete(id);
    }
  });
  // 长轮询超时：返回空（plugin 收到 204 会立刻发新一轮）
  while (mcpState.pollerHolds.length > 0) {
    const r = mcpState.pollerHolds[0];
    if (now - (r._mcpHoldTs || 0) > MCP_POLL_TIMEOUT_MS) {
      mcpState.pollerHolds.shift();
      try { sendJson(r, 200, { ok: true, call: null }); } catch (e) {}
    } else {
      break; // FIFO，前面没超时后面也没
    }
  }
}, 2000).unref?.();

// 边下边缓存边回传：把 srcUrl 内容同时写入本地缓存(临时 .part → 原子 rename)并回传给客户端。
// 用于本地离线抠图大模型的按需下载——模型不随插件包分发，首次从 OSS 拉、之后走缓存秒开。
// 跟随重定向；客户端中断 / 上游出错 / 大小不符则删临时文件，绝不留残缺缓存。
let _modelDlSeq = 0;
let _localMattingOrt = null;
let _localMattingSessionPromise = null;

function getLocalMattingOrt() {
  if (_localMattingOrt) return _localMattingOrt;
  const ortDir = path.resolve(__dirname, "..", "js", "vendor", "ort-node");
  const ort = require(path.join(ortDir, "ort.node.min.js"));
  ort.env.wasm.wasmPaths = ortDir + path.sep;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = false;
  ort.env.wasm.proxy = false;
  _localMattingOrt = ort;
  return _localMattingOrt;
}

async function ensureModelCached(name, srcUrl) {
  const safeName = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeName) throw new Error("name 必填");
  const dir = path.join(os.homedir(), ".lingxi-ai", "models");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const cachePath = path.join(dir, safeName);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) return cachePath;
  if (!srcUrl) throw new Error("模型未缓存，且未提供下载 url");
  try {
    if (isBlockedFetchHost(new URL(srcUrl).hostname)) throw new Error("禁止的下载地址");
  } catch (e) {
    if (e && e.message === "禁止的下载地址") throw e;
    throw new Error("url 非法");
  }
  await new Promise((resolve, reject) => {
    const tmpPath = cachePath + "." + (_modelDlSeq++) + ".part";
    let lib;
    try { lib = new URL(srcUrl).protocol === "http:" ? http : https; }
    catch (e) { reject(new Error("url 非法")); return; }
    const cleanup = () => { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {} };
    const req = lib.get(srcUrl, { timeout: 60000 }, (up) => {
      const sc = up.statusCode || 0;
      if (sc !== 200) { up.resume(); cleanup(); reject(new Error(`上游下载失败 ${sc}`)); return; }
      const total = Number(up.headers["content-length"] || 0);
      const ws = fs.createWriteStream(tmpPath);
      up.pipe(ws);
      up.on("error", (e) => { cleanup(); reject(e); });
      ws.on("error", (e) => { cleanup(); reject(e); });
      ws.on("finish", () => {
        try {
          if (total && fs.statSync(tmpPath).size !== total) throw new Error("模型下载大小不完整");
          if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) cleanup();
          else fs.renameSync(tmpPath, cachePath);
          resolve();
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
    });
    req.on("error", (e) => { cleanup(); reject(e); });
    req.on("timeout", () => { try { req.destroy(new Error("下载超时")); } catch (e) {} });
  });
  return cachePath;
}

function getLocalMattingSession(modelName, modelUrl) {
  if (_localMattingSessionPromise) return _localMattingSessionPromise;
  _localMattingSessionPromise = (async () => {
    const ort = getLocalMattingOrt();
    const modelPath = await ensureModelCached(modelName, modelUrl);
    const bytes = new Uint8Array(fs.readFileSync(modelPath));
    return await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
  })().catch((e) => { _localMattingSessionPromise = null; throw e; });
  return _localMattingSessionPromise;
}

function decodeFloat32Base64(b64, expectedLength) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (buf.byteLength !== expectedLength * 4) {
    throw new Error(`输入尺寸不匹配：${buf.byteLength} bytes`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, expectedLength);
}

function encodeFloat32Base64(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}

// tmpPath 由调用方给一个"每请求唯一"的临时名，避免并发下载同一模型时互相截断同一个 .part。
function downloadModelStreamThrough(srcUrl, clientRes, cachePath, tmpPath, redirectsLeft = 5) {
  let lib;
  try { lib = new URL(srcUrl).protocol === "http:" ? http : https; }
  catch (e) { if (!clientRes.headersSent) sendJson(clientRes, 400, { error: "url 非法" }); return; }
  const req = lib.get(srcUrl, { timeout: 60000 }, (up) => {
    const sc = up.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(sc) && up.headers.location && redirectsLeft > 0) {
      up.resume();
      let next;
      try { next = new URL(up.headers.location, srcUrl).toString(); }
      catch (e) { if (!clientRes.headersSent) sendJson(clientRes, 502, { error: "重定向地址非法" }); return; }
      try { if (isBlockedFetchHost(new URL(next).hostname)) { if (!clientRes.headersSent) sendJson(clientRes, 403, { error: "重定向到禁止地址" }); return; } } catch (e) {}
      downloadModelStreamThrough(next, clientRes, cachePath, tmpPath, redirectsLeft - 1);
      return;
    }
    if (sc !== 200) { up.resume(); if (!clientRes.headersSent) sendJson(clientRes, 502, { error: `上游下载失败 ${sc}` }); return; }
    const total = up.headers["content-length"];
    const headers = { "Content-Type": "application/octet-stream", "Access-Control-Allow-Origin": "*" };
    if (total) headers["Content-Length"] = total;
    clientRes.writeHead(200, headers);
    let ws = null;
    try { ws = fs.createWriteStream(tmpPath); } catch (e) { ws = null; }
    let failed = false;    // 上游/写盘真出错 → 临时文件作废
    let clientGone = false; // 客户端断了 → 不再往它写，但下载继续、缓存照落
    const cleanupTmp = () => {
      try { if (ws) ws.destroy(); } catch (e) {}
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    };
    up.on("data", (chunk) => {
      const okClient = clientGone ? true : clientRes.write(chunk);
      const okWs = ws ? ws.write(chunk) : true;
      if (okClient && okWs) return;
      up.pause(); // 两个 sink 都要等 drain 后才恢复，避免慢 sink 的内部缓冲无限膨胀
      let pending = 0;
      const resumeIfReady = () => { if (--pending <= 0) { try { up.resume(); } catch (e) {} } };
      if (!okClient) { pending += 1; clientRes.once("drain", resumeIfReady); }
      if (!okWs && ws) { pending += 1; ws.once("drain", resumeIfReady); }
      if (pending === 0) { try { up.resume(); } catch (e) {} }
    });
    up.on("end", () => {
      if (failed) { cleanupTmp(); if (!clientGone) { try { clientRes.end(); } catch (e) {} } return; }
      const finish = () => {
        try {
          if (fs.existsSync(cachePath)) { fs.unlinkSync(tmpPath); } // 并发的另一路已先缓存 → 丢弃本次临时文件
          else if (total && fs.statSync(tmpPath).size !== Number(total)) { fs.unlinkSync(tmpPath); }
          else { fs.renameSync(tmpPath, cachePath); console.log(`[proxy] /model-file 已缓存 ${cachePath}`); }
        } catch (e) { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e2) {} }
        if (!clientGone) { try { clientRes.end(); } catch (e) {} }
      };
      if (ws) ws.end(finish); else finish();
    });
    up.on("error", () => { failed = true; cleanupTmp(); if (!clientGone) { try { clientRes.destroy(); } catch (e) {} } });
    // 客户端断开（WebView 请求超时 / 用户取消 / 关面板 / WPS 退出）不再中断下载。
    // 这个模型 170MB：下到一半就丢弃会导致每次抠图都从零重下、永远收敛不了
    // ——慢网下 WebView 必然先超时，于是每次都在重下同一个模型。
    // 断开后继续把它下完并落盘，下次抠图直接命中缓存秒开。
    clientRes.on("close", () => {
      if (clientRes.writableEnded) return; // 正常收尾
      clientGone = true;
      try { up.resume(); } catch (e) {} // 若正卡在等客户端 drain，这里解除背压继续下
    });
  });
  req.on("error", (e) => { if (!clientRes.headersSent) sendJson(clientRes, 502, { error: e && e.message ? e.message : "下载失败" }); });
  req.on("timeout", () => { try { req.destroy(); } catch (e) {} });
}

// 拉取 models.dev 能力目录 JSON → 落盘缓存 → 回给客户端。跟随重定向；
// 上游/网络/写盘任一失败时，若有旧缓存就回旧的（best-effort），否则 502。
// serveCache() 由调用方给（命中缓存时的回法），失败兜底也复用它。
function fetchModelsCatalog(url, cachePath, clientRes, serveCache, redirectsLeft = 3) {
  const staleOr502 = (msg) => {
    if (clientRes.headersSent) return;
    if (fs.existsSync(cachePath)) { try { serveCache(); return; } catch (e) {} }
    sendJson(clientRes, 502, { ok: false, error: "models.dev 拉取失败" + (msg ? "：" + msg : "") });
  };
  let lib;
  try { lib = new URL(url).protocol === "http:" ? http : https; }
  catch (e) { staleOr502("url 非法"); return; }
  const req = lib.get(url, { timeout: 15000, headers: { "User-Agent": "lingxi-ai" } }, (up) => {
    const sc = up.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(sc) && up.headers.location && redirectsLeft > 0) {
      up.resume();
      let next;
      try { next = new URL(up.headers.location, url).toString(); } catch (e) { staleOr502("重定向非法"); return; }
      fetchModelsCatalog(next, cachePath, clientRes, serveCache, redirectsLeft - 1);
      return;
    }
    if (sc !== 200) { up.resume(); staleOr502("上游 " + sc); return; }
    const tmp = cachePath + "." + Date.now() + ".part";
    let ws;
    try { ws = fs.createWriteStream(tmp); } catch (e) { up.resume(); staleOr502("临时文件"); return; }
    up.pipe(ws);
    up.on("error", () => { try { ws.destroy(); } catch (e) {} try { fs.unlinkSync(tmp); } catch (e) {} staleOr502("下载中断"); });
    ws.on("error", () => { try { fs.unlinkSync(tmp); } catch (e) {} staleOr502("写盘失败"); });
    ws.on("finish", () => {
      try { fs.renameSync(tmp, cachePath); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} staleOr502("落盘失败"); return; }
      if (!clientRes.headersSent) serveCache();
    });
  });
  req.on("error", () => staleOr502("网络失败"));
  req.on("timeout", () => { try { req.destroy(); } catch (e) {} });
}

// PDF 文字提取（数字版 PDF 走文字通道用）。lazy-require pdfjs（只在首次抽取时加载，
// 非 PDF 用户不付出启动成本）。仅用 getTextContent，不需要 canvas 渲染（canvas 的告警可忽略）。
// 按 path+mtime 缓存，避免同文件重复解析。
let _pdfjsLib = null;
function getPdfjs() {
  if (!_pdfjsLib) _pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
  return _pdfjsLib;
}
const _pdfExtractCache = new Map(); // normKey -> { mtimeMs, result }
const PDF_EXTRACT_MAX_BYTES = 150 * 1024 * 1024; // 防 OOM：超大 PDF 直接拒绝
async function extractPdfText(filePath) {
  const st = fs.statSync(filePath);
  if (st.size > PDF_EXTRACT_MAX_BYTES) {
    throw new Error(`PDF 太大（${(st.size / 1048576).toFixed(0)}MB），上限 ${PDF_EXTRACT_MAX_BYTES / 1048576}MB`);
  }
  const key = path.resolve(filePath).toLowerCase(); // 归一化：大小写/分隔符不同的同一文件复用缓存
  const cached = _pdfExtractCache.get(key);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.result;
  const pdfjs = getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pageCount = doc.numPages;
  const pages = [];
  let charCount = 0;
  try {
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // 用 y 坐标重建换行/段落，用 x 间隙补词间空格（有些 PDF 不发独立空格 item，否则会 HelloWorld 粘连）
      let text = "";
      let lastY = null, lastEndX = null;
      for (const it of tc.items) {
        if (typeof it.str !== "string") continue;
        const y = it.transform ? it.transform[5] : null;
        const x = it.transform ? it.transform[4] : null;
        const h = it.height || 10;
        if (lastY !== null && y !== null) {
          const yGap = Math.abs(y - lastY);
          if (yGap > 12) text += "\n\n";       // 段落间距 → 空行
          else if (yGap > 2) text += "\n";     // 普通换行
          else if (lastEndX !== null && x !== null && (x - lastEndX) > h * 0.25 && !/\s$/.test(text)) text += " "; // 同行横向间隙 → 空格
        }
        text += it.str;
        if (it.hasEOL) text += "\n";
        lastY = y;
        lastEndX = (x !== null) ? x + (it.width || 0) : lastEndX;
      }
      text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      pages.push({ page: i, text });
      charCount += text.length;
      try { page.cleanup(); } catch (e) {}
    }
  } finally {
    try { await doc.destroy(); } catch (e) {} // 无论中途是否出错都释放 pdfjs 文档/worker
  }
  // hasText 判据：太少字视为扫描件/无文字层 → 上层回退多模态。扫描件通常抽出 0 字，
  // 阈值取得较宽松，短但真实的数字版 PDF 也能走文字通道（回退多模态只是更贵、非必要）。
  const hasText = charCount >= Math.max(100, pageCount * 15);
  const result = { ok: true, pages, charCount, pageCount, hasText };
  if (_pdfExtractCache.size >= 24) { // 简单容量上限，防长跑内存无限增长
    const oldest = _pdfExtractCache.keys().next().value;
    if (oldest !== undefined) _pdfExtractCache.delete(oldest);
  }
  _pdfExtractCache.set(key, { mtimeMs: st.mtimeMs, result });
  return result;
}

const server = http.createServer(async (req, res) => {
  const { method, url: reqUrl } = req;
  const parsedUrl = new URL(reqUrl, `http://localhost:${PROXY_PORT}`);
  const pathname = parsedUrl.pathname;
  const search = parsedUrl.search;

  // CORS 预检请求直接响应
  if (method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /healthz —— 前端探测自动定位真实端口用：返回服务签名 + 已解析端口 + pid。
  // 前端从 PROXY_PORT 开始按 +1 探一遍 PROXY_PORT_LADDER_SIZE 个端口，第一个带 X-Lingxi-Service 头的就是我们。
  if (pathname === "/healthz" && method === "GET") {
    setCorsHeaders(res);
    res.setHeader("X-Lingxi-Service", PROXY_SERVICE_SIG);
    sendJson(res, 200, {
      ok: true,
      service: PROXY_SERVICE_SIG,
      port: RESOLVED_PROXY_PORT,
      pid: process.pid,
      features: PROXY_FEATURES
    });
    return;
  }

  // ===== MCP 桥路由 =====

  // POST /debug-log —— 插件侧把关键调试日志打到 proxy 终端，避免 WPS WebView 控制台不可见。
  if (pathname === "/debug-log" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const tag = String(json.tag || "plugin");
      const message = String(json.message || "");
      const data = json.data == null ? "" : ` ${trimDebugValue(json.data)}`;
      const line = `[plugin-debug] ${new Date().toISOString()} ${tag}: ${message}${data}`;
      console.log(line);
      appendDebugLogLine(line);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      console.warn("[plugin-debug] 记录失败:", e.message);
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /clipboard/text —— WPS/macOS WebView 可能禁止 navigator.clipboard.readText()。
  // 代理进程在本机 127.0.0.1 上运行，用系统命令读取纯文本剪贴板作为粘贴兜底。
  if (pathname === "/clipboard/text" && method === "GET") {
    setCorsHeaders(res);
    const result = readSystemClipboardText();
    if (!result.ok) {
      sendJson(res, 500, { ok: false, error: result.error || "读取剪贴板失败" });
      return;
    }
    sendJson(res, 200, { ok: true, text: result.text || "" });
    return;
  }

  // POST /clipboard/text —— WPS/macOS WebView 可能禁止 navigator.clipboard.writeText()。
  // 代理进程用系统命令写入纯文本剪贴板，供 Cmd+C/Cmd+X 兜底。
  if (pathname === "/clipboard/text" && method === "POST") {
    setCorsHeaders(res);
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const result = writeSystemClipboardText(String(json.text || ""));
      if (!result.ok) {
        sendJson(res, 500, { ok: false, error: result.error || "写入剪贴板失败" });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  // POST /clipboard/image —— 把本地 PNG/JPEG 写入系统剪贴板，供 WPS Selection.Paste 插图兜底。
  if (pathname === "/clipboard/image" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const filePath = String(json.path || "");
      if (!filePath) {
        sendJson(res, 400, { ok: false, error: "path 必填" });
        return;
      }
      const info = localImagePathInfo(filePath);
      const imagePath = info.safePath || info.realPath;
      const result = writeSystemClipboardImage(imagePath, info.ext);
      if (!result.ok) {
        sendJson(res, 500, { ok: false, error: result.error || "写入图片剪贴板失败" });
        return;
      }
      console.log(`[proxy] /clipboard/image ${filePath} → clipboard image=${imagePath}`);
      sendJson(res, 200, { ok: true, imagePath, size: info.size, ext: info.ext });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  // POST /local-image-info —— 返回本地图片真实路径等信息，供 Writer 避开 macOS /var symlink 等路径坑。
  if (pathname === "/local-image-info" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) {
        sendJson(res, 400, { ok: false, error: "path 必填" });
        return;
      }
      const result = localImagePathInfo(filePath);
      console.log(`[proxy] /local-image-info ${filePath} → real=${result.realPath}; safe=${result.safePath}; jpeg=${result.jpegPath || "-"} (${result.size} bytes)`);
      sendJson(res, 200, { ok: true, path: filePath, ...result });
    } catch (e) {
      console.error("[proxy] /local-image-info 失败:", e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /image-html-file —— 为 Writer Range.InsertFile 生成一个引用本地图片的临时 HTML 文件。
  if (pathname === "/image-html-file" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) {
        sendJson(res, 400, { ok: false, error: "path 必填" });
        return;
      }
      const result = writeImageHtmlFile(filePath);
      console.log(`[proxy] /image-html-file ${filePath} → ${result.htmlPath}; image=${result.imagePath}`);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error("[proxy] /image-html-file 失败:", e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /image-rtf-file —— 为 Writer Range.InsertFile 生成内嵌图片的 RTF 兜底文件。
  if (pathname === "/image-rtf-file" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) {
        sendJson(res, 400, { ok: false, error: "path 必填" });
        return;
      }
      const result = writeImageRtfFile(filePath);
      console.log(`[proxy] /image-rtf-file ${filePath} → ${result.rtfPath}; image=${result.imagePath}`);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error("[proxy] /image-rtf-file 失败:", e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /html-file —— 为 Writer Range.InsertFile 生成一个临时 HTML 文件。
  if (pathname === "/html-file" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const result = writeHtmlFragmentFile(String(json.html || ""));
      console.log(`[proxy] /html-file → ${result.htmlPath} (${result.size} bytes)`);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error("[proxy] /html-file 失败:", e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ===== MCP Client：WPS-AI 作为 client 连接外部 MCP 服务 =====
  // TOFU token 门：plugin 在每次 /mcpc/* 请求上带 Authorization: Bearer <token>。
  // 首个带 token 的请求建立信任并落盘到 ~/.lingxi-ai/mcp-token，此后要求 Bearer 精确匹配，
  // 否则 401——防止恶意网页伪造本地请求驱动本进程 spawn 子进程（本地 RCE）。
  // OPTIONS 预检已在上面的全局处理里提前 return，这里的 method !== "OPTIONS" 只是双重保险。
  if (pathname.startsWith("/mcpc/")) {
    if (method !== "OPTIONS") {
      const gate = mcpcTokenGate.check(req.headers["authorization"]);
      if (!gate.ok) { setCorsHeaders(res); sendJson(res, 401, { ok: false, error: "unauthorized: " + gate.reason }); return; }
    }
    let bodyJson = null;
    if (method === "POST") {
      try { bodyJson = JSON.parse((await readBody(req)).toString("utf8")); }
      catch (e) { sendJson(res, 400, { ok: false, error: "body 非法 JSON" }); return; }
    }
    const out = await handleMcpcRequest(pathname, method, bodyJson, mcpcManager);
    if (out) { setCorsHeaders(res); sendJson(res, out.status, out.body); return; }
  }

  // POST /mcp/register —— WPS plugin 上报最新工具清单（含 description / inputSchema）
  if (pathname === "/mcp/register" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      if (!Array.isArray(json.tools)) {
        sendJson(res, 400, { ok: false, error: "tools 必须是数组" });
        return;
      }
      mcpState.tools = json.tools;
      mcpState.pluginRegisteredAt = Date.now();
      console.log(`[mcp] plugin 注册 ${json.tools.length} 个工具`);
      sendJson(res, 200, { ok: true, count: json.tools.length });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /mcp/poll —— plugin 长轮询。有任务立即返回，没任务挂着直到 25s 超时（GC 兜底）
  if (pathname === "/mcp/poll" && method === "GET") {
    if (mcpState.inboxForPlugin.length > 0) {
      const call = mcpState.inboxForPlugin.shift();
      sendJson(res, 200, { ok: true, call });
    } else {
      res._mcpHoldTs = Date.now();
      mcpState.pollerHolds.push(res);
    }
    return;
  }

  // POST /mcp/result —— plugin 完成 call 后回传结果
  if (pathname === "/mcp/result" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const callId = String(json.callId || "");
      const entry = mcpState.pendingCalls.get(callId);
      if (!entry) {
        sendJson(res, 404, { ok: false, error: "未知 callId（可能已超时清理）" });
        return;
      }
      mcpState.pendingCalls.delete(callId);
      try {
        sendJson(entry.res, 200, {
          ok: !!json.ok,
          value: json.value,
          error: json.error || null
        });
      } catch (e) {}
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /mcp/tools —— 外部 MCP bridge 拉取工具清单。plugin 离线时返回 503
  if (pathname === "/mcp/tools" && method === "GET") {
    if (!pluginAlive()) {
      sendJson(res, 503, { ok: false, error: "WPS plugin 未连接（请确认 WPS 已打开且插件开启了 MCP 服务）" });
      return;
    }
    sendJson(res, 200, { ok: true, tools: mcpState.tools });
    return;
  }

  // POST /mcp/call —— 外部 MCP bridge 投递工具调用，挂着等 plugin 返回结果
  if (pathname === "/mcp/call" && method === "POST") {
    if (!pluginAlive()) {
      sendJson(res, 503, { ok: false, error: "WPS plugin 未连接" });
      return;
    }
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const name = String(json.name || "");
      const args = json.args || {};
      if (!name) {
        sendJson(res, 400, { ok: false, error: "name 必填" });
        return;
      }
      const callId = genCallId();
      mcpState.pendingCalls.set(callId, { res, ts: Date.now() });
      dispatchCallToPlugin({ callId, name, args });
      // 不在这里写 res；等 /mcp/result 来回写或 GC 超时
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /mcp/status —— UI / bridge 都能查：plugin 是否在线 + 工具个数
  if (pathname === "/mcp/status" && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      pluginAlive: pluginAlive(),
      toolCount: mcpState.tools.length,
      registeredAt: mcpState.pluginRegisteredAt || null
    });
    return;
  }

  // POST /upload-image —— 接收 base64 dataUrl（PNG/JPG），落到本地临时文件，返回路径
  if (pathname === "/upload-image" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const dataUrl = String(json.dataUrl || "");
      const m = /^data:(image\/(?:png|jpeg|jpg|svg\+xml|webp|gif));base64,(.+)$/i.exec(dataUrl);
      if (!m) {
        setCorsHeaders(res);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid dataUrl" }));
        return;
      }
      const mime = m[1].toLowerCase();
      const ext = mime.includes("svg") ? "svg"
        : (mime.includes("jpeg") || mime.includes("jpg")) ? "jpg"
        : mime.includes("webp") ? "webp"
        : mime.includes("gif") ? "gif"
        : "png";
      const buf = Buffer.from(m[2], "base64");
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filepath = path.join(RENDER_DIR, filename);
      // open + write + fsync + close, 确保数据真正落盘后再返回路径给 WPS。
      // 之前 writeFileSync 偶发未刷新到磁盘, WPS AddPicture 拿到路径时读到 0 bytes 或空内容,
      // shape 框架建好了但里面没图. 加 fsync 排除这条 race.
      const fd = fs.openSync(filepath, "w");
      try {
        fs.writeSync(fd, buf, 0, buf.length, 0);
        try { fs.fsyncSync(fd); } catch (e) { /* fsync 失败不致命 */ }
      } finally {
        fs.closeSync(fd);
      }
      // verify: 读回 stat 确保大小正确
      const st = fs.statSync(filepath);
      if (st.size !== buf.length) {
        console.warn(`[proxy] /upload-image 大小不匹配: wrote=${buf.length} stat=${st.size}`);
      }
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: filepath, size: buf.length, verifiedSize: st.size }));
      console.log(`[proxy] /upload-image → ${filepath} (${buf.length} bytes, stat=${st.size})`);
    } catch (error) {
      console.error("[proxy] /upload-image 失败:", error.message);
      setCorsHeaders(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // POST /save-local-image-as —— 从素材预览另存为图片。
  // 优先弹系统保存对话框；Linux 无桌面工具/无 DISPLAY 时，用 Node 写到 Downloads 兜底。
  if (pathname === "/save-local-image-as" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const image = parseImageDataUrlForSave(json.dataUrl);
      const defaultDir = defaultSaveAsDir();
      const suggestedName = sanitizeSaveAsFileName(json.suggestedName, image.ext);
      const picked = chooseSaveAsPath(defaultDir, suggestedName);
      if (picked?.cancelled) {
        sendJson(res, 200, { ok: true, cancelled: true, dialog: picked.dialog || "" });
        return;
      }
      const targetPath = picked?.path
        ? ensureSaveAsExtension(picked.path, image.ext)
        : uniqueFallbackPath(path.join(defaultDir, suggestedName));
      const stat = writeBufferAndSync(targetPath, image.buffer);
      console.log(`[proxy] /save-local-image-as → ${targetPath} (${stat.size} bytes${picked?.dialog ? `, ${picked.dialog}` : ", fallback"})`);
      sendJson(res, 200, {
        ok: true,
        cancelled: false,
        path: path.resolve(targetPath),
        size: stat.size,
        mediaType: image.mediaType,
        fallback: !picked?.path,
        dialog: picked?.dialog || ""
      });
    } catch (error) {
      console.error("[proxy] /save-local-image-as 失败:", error.message);
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  // GET /device-sn —— 返回当前设备的稳定唯一标识，给灰度（canary）白名单匹配用。
  // 不依赖网络 / 用户登录，跟着硬件走（重装系统、清空 localStorage 都不变）。
  // 平台命令：
  //   Windows: wmic csproduct get uuid       → 主板 UUID（重装系统不变）
  //            wmic bios get serialnumber    → BIOS 序列号（兜底）
  //   macOS:   ioreg -d2 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}'
  //   Linux:   cat /sys/class/dmi/id/product_uuid（需要 root）/ /etc/machine-id（兜底）
  // 全部失败 → 生成一次性 UUID 存到 ~/.lingxi-ai/device-sn.json，下次直接读这个文件。
  if (pathname === "/device-sn" && method === "GET") {
    try {
      const sn = await getDeviceSn();
      console.log(`[device-sn] → ${sn} (source=${_deviceSnSource})`);
      sendJson(res, 200, { ok: true, sn, source: _deviceSnSource });
    } catch (e) {
      console.error("[device-sn] failed:", e);
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // GET /asset/<相对路径> —— 把 plugin 里 js/vendor/ 下的静态文件（onnxruntime-web 的 wasm、
  // 本地抠图模型 .onnx 等大二进制）通过 http 流式吐出来。前端 WebView 在 file:// 下 fetch 本地
  // 大文件会被 CORS 挡；统一改成从 proxy(3890) 取绝对 URL，两种加载模式（dev file:// / 生产 http）都通。
  // 安全：只允许 js/vendor/ 前缀、禁止 ..，并在 dev(pluginRoot) 与生产(plugin-<host>) 两种布局里找。
  if (pathname.startsWith("/asset/") && method === "GET") {
    try {
      const rel = decodeURIComponent(pathname.slice("/asset/".length)).replace(/\\/g, "/");
      const norm = path.posix.normalize(rel);
      if (norm.startsWith("../") || norm.includes("/../") || !norm.startsWith("js/vendor/")) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      const pluginRoot = path.resolve(__dirname, "..");
      const HOSTS = ["wps", "et", "wpp", "pdf"];
      const candidates = [path.join(pluginRoot, norm)]
        .concat(HOSTS.map((h) => path.join(pluginRoot, `plugin-${h}`, norm)));
      const full = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
      if (!full) { sendJson(res, 404, { ok: false, error: "not found: " + norm }); return; }
      const ext = path.extname(full).toLowerCase();
      const ctype = ext === ".wasm" ? "application/wasm"
        : ext === ".onnx" ? "application/octet-stream"
        : ext === ".js" || ext === ".mjs" ? "text/javascript; charset=utf-8"
        : ext === ".json" ? "application/json; charset=utf-8"
        : "application/octet-stream";
      const size = fs.statSync(full).size;
      res.writeHead(200, {
        "Content-Type": ctype,
        "Content-Length": size,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=31536000, immutable"
      });
      fs.createReadStream(full).on("error", () => { try { res.destroy(); } catch (e) {} }).pipe(res);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // GET /model-file?name=<name>&url=<源URL> —— 本地离线抠图模型的按需下载 + 本地缓存 + 流式回传。
  // 首次：从 url(OSS) 边下边缓存到 ~/.lingxi-ai/models/<name> 边回传（前端可显示真实下载进度）；
  // 之后：命中缓存秒开。模型不随插件包分发，包体保持小。
  if (pathname === "/model-file" && method === "GET") {
    try {
      const name = String(parsedUrl.searchParams.get("name") || "").replace(/[^a-zA-Z0-9._-]/g, "");
      const srcUrl = String(parsedUrl.searchParams.get("url") || "");
      if (!name) { sendJson(res, 400, { error: "name 必填" }); return; }
      const dir = path.join(os.homedir(), ".lingxi-ai", "models");
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      const cachePath = path.join(dir, name);
      if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
        const size = fs.statSync(cachePath).size;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": size,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=31536000, immutable"
        });
        fs.createReadStream(cachePath).on("error", () => { try { res.destroy(); } catch (e) {} }).pipe(res);
        return;
      }
      if (!srcUrl) { sendJson(res, 404, { error: "模型未缓存，且未提供下载 url" }); return; }
      try { if (isBlockedFetchHost(new URL(srcUrl).hostname)) { sendJson(res, 403, { error: "禁止的下载地址" }); return; } }
      catch (e) { sendJson(res, 400, { error: "url 非法" }); return; }
      downloadModelStreamThrough(srcUrl, res, cachePath, cachePath + "." + (_modelDlSeq++) + ".part");
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  // GET /models-catalog —— 远程模型能力目录（models.dev）代理 + 按天磁盘缓存。
  // 前端用它把各家模型的能力（image/pdf/tools/thinking）注入 override，摆脱名字正则硬猜。
  // 缓存新鲜(<24h)直接回；过期则拉取 https://models.dev/api.json 存盘再回；拉取失败回退陈旧缓存。
  if (pathname === "/models-catalog" && method === "GET") {
    try {
      const dir = path.join(os.homedir(), ".lingxi-ai", "cache");
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      const cachePath = path.join(dir, "models-dev.json");
      const TTL_MS = 24 * 3600 * 1000;
      const serveCache = () => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        fs.createReadStream(cachePath).on("error", () => { try { res.destroy(); } catch (e) {} }).pipe(res);
      };
      let fresh = false;
      try {
        const st = fs.statSync(cachePath);
        fresh = st.size > 0 && (Date.now() - st.mtimeMs) < TTL_MS;
      } catch (e) {}
      if (fresh) { serveCache(); return; }
      fetchModelsCatalog("https://models.dev/api.json", cachePath, res, serveCache);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  // POST /local-matting-infer —— WebView 没有 WebAssembly 时，把 isnet ONNX 推理放到本地 Node proxy 执行。
  // 前端仍负责 canvas 预处理/alpha 合成；这里只接收 CHW float32，返回 1024×1024 float32 mask。
  if (pathname === "/local-matting-infer" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const size = Number(json.size) || 1024;
      if (size !== 1024) { sendJson(res, 400, { ok: false, error: "仅支持 size=1024" }); return; }
      const modelName = String(json.modelName || "isnet-general-use.onnx");
      const modelUrl = String(json.modelUrl || "");
      const input = decodeFloat32Base64(json.inputBase64, 3 * size * size);
      const ort = getLocalMattingOrt();
      const session = await getLocalMattingSession(modelName, modelUrl);
      const feeds = {};
      feeds[session.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, size, size]);
      const out = await session.run(feeds);
      const mask = out[session.outputNames[0]].data;
      sendJson(res, 200, {
        ok: true,
        size,
        maskBase64: encodeFloat32Base64(mask),
        runtime: { vendor: "ort-node", wasmFile: "ort-wasm.wasm" }
      });
    } catch (e) {
      console.error("[proxy] /local-matting-infer 失败:", e?.stack || e?.message || e);
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  // ===== SQLite KV 存储（前端 WpsAiStore 用；node:sqlite 不可用一律 503 → 前端降级 localStorage）=====
  if (pathname.startsWith("/kv/")) {
    if (!kvStore.available()) { sendJson(res, 503, { ok: false, error: "node:sqlite 未启用（需 --experimental-sqlite 启动代理）" }); return; }
    try {
      if (pathname === "/kv/all" && method === "GET") { sendJson(res, 200, { ok: true, items: kvStore.getAll() }); return; }
      if (pathname === "/kv/batch" && method === "POST") {
        const body = await readBody(req);
        const json = JSON.parse(body.toString("utf8") || "{}");
        const count = kvStore.batch({ sets: Array.isArray(json.sets) ? json.sets : [], dels: Array.isArray(json.dels) ? json.dels : [] });
        sendJson(res, 200, { ok: true, count });
        return;
      }
      if (pathname === "/kv/merge-list" && method === "POST") {
        const body = await readBody(req);
        const json = JSON.parse(body.toString("utf8") || "{}");
        if (typeof json.key !== "string" || !json.key) { sendJson(res, 400, { ok: false, error: "缺少 key" }); return; }
        const merged = kvStore.mergeList({ key: json.key, items: Array.isArray(json.items) ? json.items : [], idKey: json.idKey || "id", tsKey: json.tsKey });
        sendJson(res, 200, { ok: true, merged });
        return;
      }
      if (pathname === "/kv/merge-object" && method === "POST") {
        const body = await readBody(req);
        const json = JSON.parse(body.toString("utf8") || "{}");
        if (typeof json.key !== "string" || !json.key) { sendJson(res, 400, { ok: false, error: "缺少 key" }); return; }
        const merged = kvStore.mergeObject({ key: json.key, patch: (json.patch && typeof json.patch === "object") ? json.patch : {}, mode: json.mode === "add" ? "add" : "assign" });
        sendJson(res, 200, { ok: true, merged });
        return;
      }
      if (pathname === "/kv/stats" && method === "GET") { sendJson(res, 200, Object.assign({ ok: true }, kvStore.stats())); return; }
      if (pathname === "/kv/clear" && method === "POST") {
        const body = await readBody(req);
        const json = JSON.parse(body.toString("utf8") || "{}");
        const removed = kvStore.clear({ keys: Array.isArray(json.keys) ? json.keys : undefined });
        sendJson(res, 200, { ok: true, removed });
        return;
      }
      sendJson(res, 404, { ok: false, error: "未知 kv 路由: " + pathname });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  // POST /publish/set-hosts —— 选择性启用宿主：按 enabledHosts 重写各平台 publish.xml。
  //   body: { enabledHosts: ["wps","et","wpp","pdf"], staticBase: "http://127.0.0.1:3889" }
  //   保留别家插件条目；重启 WPS 后生效。
  if (pathname === "/publish/set-hosts" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const VALID = ["wps", "et", "wpp", "pdf"];
      const enabledHosts = Array.isArray(json.enabledHosts)
        ? json.enabledHosts.filter((h) => VALID.includes(h))
        : [];
      if (!enabledHosts.length) { sendJson(res, 400, { ok: false, error: "至少要启用一个宿主" }); return; }
      const staticBase = typeof json.staticBase === "string" && /^https?:\/\//i.test(json.staticBase)
        ? json.staticBase
        : ("http://127.0.0.1:" + (Number(process.env.LINGXI_STATIC_PORT || process.env.WPSJS_PORT) || 3889));
      const candidates = publishXmlCandidates();
      const written = [];
      for (const p of candidates) {
        try { if (rewritePublishXml(p, enabledHosts, staticBase)) written.push(p); } catch (e) { /* 单个失败不致命 */ }
      }
      // 一个都不存在 → 在主候选路径创建一份（保证启用一定能生效）
      if (!written.length && candidates.length) {
        const primary = candidates[0];
        try {
          fs.mkdirSync(path.dirname(primary), { recursive: true });
          fs.writeFileSync(primary, "", "utf8");
          if (rewritePublishXml(primary, enabledHosts, staticBase)) written.push(primary);
        } catch (e) { /* ignore */ }
      }
      sendJson(res, 200, { ok: true, enabledHosts, written });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  // ===== 本地慢生图异步化（Boogu 等）=====
  // 问题：Boogu 生成一张图 60-90s（CPU offload），是阻塞同步请求。前端 fetch 走 WebView，
  // mac WKWebView 对「无数据往返」的请求有 ~60s 超时 → 长生成被中断 → 工具报错 → AI 重试
  // → 重复生成。解法：前端毫秒级拿 taskId，代理后台承担长等待（Node 无 WebView 超时限制），
  // 前端轮询结果。只允许本地/私网目标（这个端点专给本地生图服务，防 SSRF 滥用）。
  if (pathname === "/local-image/generate" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const targetUrl = String(json.url || "");
      let u;
      try { u = new URL(targetUrl); } catch (e) { sendJson(res, 400, { ok: false, error: "url 非法" }); return; }
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      // 与 /forward 同策略：只封云元数据 / link-local 这类 SSRF 目标，
      // 允许本地(127/localhost)、局域网(192.168/10/172.16-31)以及用户自建的远端
      // GPU 机（DNS 主机名 / 公网 IP）——Boogu 可能不跑在本机。连通性测试走的是
      // /forward，若这里比 /forward 更严就会出现「测得通、生图被拒」的割裂。
      if (isMetadataSsrfHost(host)) { sendJson(res, 400, { ok: false, error: "禁止的目标（云元数据地址）" }); return; }
      const taskId = "limg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localImageTasks.set(taskId, { status: "pending", at: Date.now() });
      runLocalImageTask(taskId, u, json.payload || {}, json.headers || {}); // 后台跑，不 await
      sendJson(res, 200, { ok: true, taskId });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }
  if (pathname === "/local-image/result" && method === "GET") {
    const taskId = String(parsedUrl.searchParams.get("taskId") || "");
    const t = localImageTasks.get(taskId);
    if (!t) { sendJson(res, 404, { ok: false, error: "未知任务（可能已过期）" }); return; }
    if (t.status === "pending") { sendJson(res, 200, { ok: true, status: "pending", elapsedMs: Date.now() - t.at }); return; }
    if (t.status === "error") { sendJson(res, 200, { ok: true, status: "error", error: t.error }); localImageTasks.delete(taskId); return; }
    sendJson(res, 200, { ok: true, status: "done", data: t.data });
    localImageTasks.delete(taskId);
    return;
  }

  if (pathname === "/ribbon-position" && method === "GET") {
    const { readRibbonPosition } = require("./ribbon-position");
    sendJson(res, 200, { ok: true, position: readRibbonPosition() });
    return;
  }
  if (pathname === "/ribbon-position" && method === "POST") {
    try {
      const json = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!["before-home", "after-home", "end"].includes(json.position)) {
        sendJson(res, 400, { ok: false, error: "无效的 Ribbon 位置" });
        return;
      }
      const { writeRibbonPosition } = require("./ribbon-position");
      sendJson(res, 200, { ok: true, position: writeRibbonPosition(json.position) });
    } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    return;
  }

  // 界面语言侧车文件：静态服务按它决定给 WPS 发中文还是英文 ribbon.xml
  // （部分 WPS 不支持 getLabel 动态回调，label 必须在 xml 里就是目标语言）。
  // 固定路径 ~/.lingxi-ai/ui-lang.txt——static/proxy 进程 cwd 不同也能对上。
  const UI_LANG_FILE = path.join(os.homedir(), ".lingxi-ai", "ui-lang.txt");
  if (pathname === "/ui-lang" && method === "GET") {
    let lang = "zh";
    try { lang = String(fs.readFileSync(UI_LANG_FILE, "utf8")).trim() === "en" ? "en" : "zh"; } catch (e) {}
    sendJson(res, 200, { ok: true, lang });
    return;
  }
  if (pathname === "/ui-lang" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const lang = json.lang === "en" ? "en" : "zh";
      fs.mkdirSync(path.dirname(UI_LANG_FILE), { recursive: true });
      fs.writeFileSync(UI_LANG_FILE, lang, "utf8");
      sendJson(res, 200, { ok: true, lang });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  // P2-6 导出为新 Word 文件：blocks 渲染的 HTML 存成 .doc（Word/WPS 原生可开 HTML-in-.doc），
  // 不动当前文档。落到 ~/Documents/灵犀AI导出/，返回完整路径。零依赖方案。
  if (pathname === "/export-doc" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const html = String(json.html || "");
      if (!html.trim()) { sendJson(res, 400, { ok: false, error: "缺少 html 内容" }); return; }
      const safeName = String(json.fileName || "文小舟导出").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "文小舟导出";
      const dir = path.join(os.homedir(), "Documents", "灵犀AI导出");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      const file = path.join(dir, `${safeName}-${stamp}.doc`);
      const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${safeName}</title></head><body>${html}</body></html>`;
      fs.writeFileSync(file, "﻿" + doc, "utf8");
      sendJson(res, 200, { ok: true, path: file });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
    return;
  }

  // GET /service/status —— 后台服务端口 + 内存占用（设置页展示用）。
  if (pathname === "/service/status" && method === "GET") {
    const self = process.memoryUsage();
    let procs = collectServiceProcesses();
    // 枚举失败兜底：至少报自己（代理进程）的内存
    if (!procs.some((p) => p.pid === process.pid)) {
      procs.push({ pid: process.pid, rssBytes: self.rss, kind: "代理服务" });
    }
    const totalRssBytes = procs.reduce((a, p) => a + (p.rssBytes || 0), 0);
    const staticPort = Number(process.env.LINGXI_STATIC_PORT || process.env.WPSJS_PORT) || null;
    sendJson(res, 200, {
      ok: true,
      ports: { proxy: RESOLVED_PROXY_PORT, static: staticPort },
      self: { pid: process.pid, rssBytes: self.rss, uptimeSec: Math.round(process.uptime()) },
      processes: procs,
      totalRssBytes,
      nodeVersion: process.version
    });
    return;
  }

  // GET /install-path —— 返回 plugin 的本地 FS 路径，给 MCP 配置 / 应用内显示用。
  // dev 模式下 plugin 加载走 http://localhost，前端从 URL 推不出 FS 路径；统一改成问 proxy。
  //   pluginRoot:    proxy-server.js 的上一级（dev = plugin/，生产 = ~/.lingxi-ai/）
  //   mcpServer:     mcp-server.js 绝对路径
  //   hostVariants:  生产模式下的 plugin-wps/-et/-wpp/-pdf 实际存在的目录列表
  if (pathname === "/install-path" && method === "GET") {
    try {
      const pluginRoot = path.resolve(__dirname, "..");
      const mcpCandidates = [
        path.resolve(__dirname, "mcp-server.js"),               // 跟 proxy-server.js 同目录（推荐）
        path.join(pluginRoot, "plugin-wpp", "tools", "mcp-server.js"),  // host 变体兜底
        path.join(pluginRoot, "plugin-wps", "tools", "mcp-server.js"),
        path.join(pluginRoot, "tools", "mcp-server.js")          // dev 模式
      ];
      const mcpServer = mcpCandidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || mcpCandidates[0];
      const HOSTS = ["wps", "et", "wpp", "pdf"];
      const hostVariants = HOSTS
        .map((h) => path.join(pluginRoot, `plugin-${h}`))
        .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
      const mode = hostVariants.length > 0 ? "production" : "dev";
      sendJson(res, 200, { ok: true, pluginRoot, mcpServer, hostVariants, mode });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // ===== 热更新桥（POST /update/manifest, /update/download, /update/apply）=====
  // plugin 侧的 updater.js 调这些端点拿 manifest / 下载 zip / 解压覆盖.
  // 走 proxy 是因为:
  //   1) 绕 CORS (OSS 不允许 file:// 同源)
  //   2) 真正落地需要 fs/path/child_process, plugin WebView 没有
  if (pathname === "/update/manifest" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const url = String(json.url || "").trim();
      if (!url) { sendJson(res, 400, { ok: false, error: "url 必填" }); return; }
      // 简单 GET 拉 manifest. 跟 fetch-remote-image 用相同的下载封装
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const text = await new Promise((resolve, reject) => {
        const r = lib.get(url, { timeout: 15000 }, (resp) => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) { reject(new Error(`HTTP ${resp.statusCode}`)); return; }
          const chunks = [];
          resp.on("data", (c) => chunks.push(c));
          resp.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        r.on("error", reject);
        r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("timeout")); });
      });
      let manifest;
      try { manifest = JSON.parse(text); }
      catch (e) { sendJson(res, 500, { ok: false, error: "manifest 不是合法 JSON: " + e.message }); return; }
      sendJson(res, 200, { ok: true, manifest, fetchedAt: Date.now() });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /update/download —— 下载 plugin.zip 到本地临时目录
  if (pathname === "/update/download" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const url = String(json.url || "").trim();
      const expectedSize = Number(json.expectedSize) || 0;
      if (!url) { sendJson(res, 400, { ok: false, error: "url 必填" }); return; }
      // 下载到 ~/.lingxi-ai/updates/<ts>.zip
      const UPDATE_DIR = path.join(os.homedir(), ".lingxi-ai", "updates");
      fs.mkdirSync(UPDATE_DIR, { recursive: true });
      const zipPath = path.join(UPDATE_DIR, `plugin-${Date.now()}.zip`);
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(zipPath);
        const r = lib.get(url, { timeout: 120 * 1000 }, (resp) => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            try { ws.close(); fs.unlinkSync(zipPath); } catch (e) {}
            reject(new Error(`HTTP ${resp.statusCode}`));
            return;
          }
          resp.pipe(ws);
          ws.on("finish", () => ws.close(resolve));
          ws.on("error", reject);
        });
        r.on("error", reject);
        r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("download timeout")); });
      });
      const st = fs.statSync(zipPath);
      if (expectedSize > 0 && st.size !== expectedSize) {
        // 大小不匹配警告但不失败（manifest 元数据可能不准）
        console.warn(`[proxy] /update/download 大小不匹配: expected=${expectedSize} actual=${st.size}`);
      }
      console.log(`[proxy] /update/download → ${zipPath} (${st.size} bytes)`);
      sendJson(res, 200, { ok: true, zipPath, size: st.size });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /update/apply —— 解压 plugin.zip 覆盖到 plugin/ 目录
  // 早期版本调 PowerShell Expand-Archive / unzip。中文 Windows 上 PowerShell 的
  // 编码 / PATH / 转义太脆弱，错误一旦丢就只剩「解压失败: unknown」。
  // 现在统一走 zip-extract.js 纯 JS 实现（zlib 内置），零依赖、跨平台、错误可读。
  if (pathname === "/update/apply" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const zipPath = String(json.zipPath || "").trim();
      if (!zipPath || !fs.existsSync(zipPath)) {
        sendJson(res, 400, { ok: false, error: "zipPath 不存在: " + zipPath }); return;
      }
      // 目标目录 = 当前 plugin 根（proxy-server.js 在 plugin/tools/, 上一级即 plugin/）
      const pluginRoot = path.resolve(__dirname, "..");
      console.log(`[proxy] /update/apply 解压 ${zipPath} → ${pluginRoot}`);
      // 先解压到临时 sibling 目录，验证有 manifest.json 后再 rsync 过去；失败可回滚
      const tmpExtract = path.join(os.tmpdir(), `lingxi-update-${Date.now()}`);
      fs.mkdirSync(tmpExtract, { recursive: true });
      try {
        const { extractZip } = require("./zip-extract");
        const r = extractZip(zipPath, tmpExtract);
        console.log(`[proxy] /update/apply 解压完成: ${r.fileCount}/${r.entryCount} 文件`);
      } catch (extractErr) {
        try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
        console.error("[proxy] /update/apply 解压失败:", extractErr);
        sendJson(res, 500, { ok: false, error: `解压失败: ${extractErr?.message || String(extractErr)}` });
        return;
      }
      // 解压后的 zip 内层可能直接是 plugin 文件，也可能套了一层 plugin/ 目录
      let sourceRoot = tmpExtract;
      const entries = fs.readdirSync(tmpExtract);
      if (entries.length === 1 && fs.statSync(path.join(tmpExtract, entries[0])).isDirectory()) {
        const inner = path.join(tmpExtract, entries[0]);
        if (fs.existsSync(path.join(inner, "manifest.json")) || fs.existsSync(path.join(inner, "taskpane.html"))) {
          sourceRoot = inner;
        }
      }
      // 不允许覆盖 oss config / settings 等敏感本地文件——zip 不该包含它们，但加白名单兜底
      const KEEP_LOCAL = new Set([".git", "node_modules", "runtime"]);
      let filesReplaced = 0;
      function copyRecursive(src, dst) {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          for (const name of fs.readdirSync(src)) {
            if (KEEP_LOCAL.has(name)) continue;
            copyRecursive(path.join(src, name), path.join(dst, name));
          }
        } else {
          fs.copyFileSync(src, dst);
          filesReplaced += 1;
        }
      }
      // 关键：生产安装的实际加载路径不是 pluginRoot 本身，而是它兄弟目录
      // plugin-wps / plugin-et / plugin-wpp / plugin-pdf（由 post-install 跑 build-variants.js 生成）。
      // serve-permanent.js 把 WPS 的 http://127.0.0.1:3889/<host>/* 映射到 <pluginRoot>/plugin-<host>/。
      // 之前直接 copyRecursive(sourceRoot, pluginRoot) → 文件落在 <pluginRoot>/ 根目录而不是 plugin-<host>/，
      // 用户重启 WPS 后看到的还是老 plugin-<host>/ 里的旧代码。
      //
      // 检测策略：pluginRoot 下有任意 plugin-<host>/ 子目录 → 生产模式 → 同步覆盖所有 host 变体
      // + 把 zip 里的 tools/proxy-server.js / serve-permanent.js 也覆盖到 pluginRoot/tools/（跑这俩的就是它）
      const HOSTS = ["wps", "et", "wpp", "pdf"];
      const hostDirs = HOSTS
        .map((h) => path.join(pluginRoot, `plugin-${h}`))
        .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
      const targets = [];
      if (hostDirs.length > 0) {
        // 生产模式：覆盖每个 plugin-<host>/，再把 tools/* 单独覆盖到 pluginRoot/tools/
        hostDirs.forEach((d) => targets.push({ src: sourceRoot, dst: d, label: path.basename(d) }));
        // tools/ 单独处理：只覆盖 zip 里的 tools/ 到 pluginRoot/tools/（不是整个 sourceRoot）
        const zipTools = path.join(sourceRoot, "tools");
        const targetTools = path.join(pluginRoot, "tools");
        if (fs.existsSync(zipTools) && fs.existsSync(targetTools)) {
          targets.push({ src: zipTools, dst: targetTools, label: "tools/ (服务脚本)" });
        }
        console.log(`[proxy] /update/apply 生产模式，写入 ${targets.length} 个目标目录`);
      } else {
        // dev 模式：单 plugin/ 目录
        targets.push({ src: sourceRoot, dst: pluginRoot, label: "plugin/" });
        console.log(`[proxy] /update/apply dev 模式，写入 ${pluginRoot}`);
      }
      const perTarget = [];
      for (const t of targets) {
        const before = filesReplaced;
        copyRecursive(t.src, t.dst);
        perTarget.push(`${t.label}: ${filesReplaced - before} 文件`);
      }

      // 关键：修回每个 plugin-<host>/manifest.json 的 addonType。
      // zip 里的 manifest.json 通常打包时是 baseline（addonType="wps"），直接 copyRecursive
      // 会把 plugin-et / plugin-wpp / plugin-pdf 的 manifest.json 覆盖成 wps，WPS 加载时
      // 会用错宿主上下文（表格里加载的是文字宿主的 addonType），导致按钮 / TaskPane 表现
      // 跟旧版不一致。这里按目标目录名反推 host 修回来。
      if (hostDirs.length > 0) {
        for (const dir of hostDirs) {
          const host = path.basename(dir).replace(/^plugin-/, "");
          const manifestPath = path.join(dir, "manifest.json");
          try {
            if (fs.existsSync(manifestPath)) {
              const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
              if (m.addonType !== host) {
                m.addonType = host;
                fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n", "utf8");
                console.log(`[proxy] /update/apply 修回 ${manifestPath} addonType → ${host}`);
              }
            }
          } catch (e) {
            console.warn(`[proxy] /update/apply 修 ${manifestPath} addonType 失败：${e?.message || e}`);
          }
        }
      }

      try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
      try { fs.unlinkSync(zipPath); } catch (e) {}
      console.log(`[proxy] /update/apply 完成，覆盖 ${filesReplaced} 个文件（${perTarget.join(" / ")}）`);
      // 关键：proxy 自己刚被覆盖的新代码还在磁盘上，运行中的还是老代码。
      // 用 child_process 起一个临时 shim，shim 等 2 秒（让老 proxy 退干净 + 端口释放）
      // 后再 spawn 真正的 proxy，避免新旧两个进程抢同一端口。
      // Mac/Linux 的 launchd / systemd 本身就会保活；Windows 计划任务是 AtLogOn 触发，
      // proxy 自己退出后没人拉它，所以 Windows 必须靠这条路径接管。
      let restartScheduled = false;
      const myPath = __filename; // 现在已经是新代码的文件路径
      try {
        const { spawn } = require("child_process");
        // shim 用 -e 内联跑：等 2s → spawn 新 proxy → 自己退
        const shim = [
          "setTimeout(() => {",
          "  const { spawn } = require('child_process');",
          `  const c = spawn(process.execPath, [${JSON.stringify(myPath)}], {`,
          "    detached: true, stdio: 'ignore',",
          `    cwd: ${JSON.stringify(path.dirname(myPath))}`,
          "  });",
          "  c.unref();",
          "  process.exit(0);",
          "}, 2000);"
        ].join("\n");
        const child = spawn(process.execPath, ["-e", shim], {
          detached: true,
          stdio: "ignore",
          env: process.env
        });
        child.unref();
        restartScheduled = true;
        console.log(`[proxy] /update/apply 已起 shim (pid=${child.pid})，2s 后 spawn 新 proxy；自己 1500ms 后退出`);
      } catch (e) {
        console.warn(`[proxy] /update/apply 自重启 spawn 失败：${e?.message || e}（继续退出，依赖宿主保活）`);
      }
      sendJson(res, 200, {
        ok: true,
        filesReplaced,
        targets: perTarget,
        restartScheduled,
        message: `更新已写入（${perTarget.join(" / ")}）。后台服务已自动重启加载新代码。请完全退出 WPS 后重新打开让 TaskPane 也用上新版。`
      });
      // 给响应一点时间真正发出去，再让自己退出（Mac/Linux 上 launchd/systemd 会再起一份，
      // Windows 上由刚才 spawn 的 detached child 接管）
      if (restartScheduled) {
        res.on("finish", () => {
          setTimeout(() => {
            console.log("[proxy] 自重启：退出旧进程");
            process.exit(0);
          }, 1500);
        });
      }
    } catch (e) {
      console.error("[proxy] /update/apply 失败:", e);
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /fetch-remote-image —— 服务端下载远程图片 (绕开 WebView 的 CORS) 返回 base64 dataUrl。
  // 给 html2canvas 用：HTML 里 <img src="https://files.toapis.com/..."> 之类远程图片直接 fetch
  // 会被 CORS 拦截 / canvas 标污 → 截不出图。先调这个端点把图下成 dataUrl, 重写 src 再喂给 html2canvas。
  // 入参: { url, ttlMs? }   出参: { ok, dataUrl, contentType, size, cached }
  // 缓存策略: 同 url 在内存 + 磁盘 (RENDER_DIR/remote-cache/) 缓存 6h, 避免重复下载
  const REMOTE_IMAGE_CACHE_DIR = path.join(RENDER_DIR, "remote-cache");
  try { fs.mkdirSync(REMOTE_IMAGE_CACHE_DIR, { recursive: true }); } catch (e) {}
  const _remoteImageMemCache = new Map(); // url → { dataUrl, contentType, size, ts }
  const REMOTE_IMAGE_TTL_MS_DEFAULT = 6 * 60 * 60 * 1000; // 6h
  function urlHash(u) {
    return crypto.createHash("md5").update(u).digest("hex").slice(0, 16);
  }
  function tryReadDiskCache(u) {
    try {
      const hash = urlHash(u);
      const metaPath = path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".json");
      if (!fs.existsSync(metaPath)) return null;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (!meta?.ts || Date.now() - meta.ts > REMOTE_IMAGE_TTL_MS_DEFAULT) return null;
      const binPath = path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".bin");
      if (!fs.existsSync(binPath)) return null;
      const buf = fs.readFileSync(binPath);
      return { dataUrl: `data:${meta.contentType};base64,${buf.toString("base64")}`, contentType: meta.contentType, size: buf.length, ts: meta.ts };
    } catch (e) { return null; }
  }
  function writeDiskCache(u, buf, contentType) {
    try {
      const hash = urlHash(u);
      fs.writeFileSync(path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".bin"), buf);
      fs.writeFileSync(path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".json"), JSON.stringify({ url: u, contentType, ts: Date.now() }));
    } catch (e) { /* 缓存写失败不致命 */ }
  }
  if (pathname === "/fetch-remote-image" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const url = String(json.url || "").trim();
      const referer = String(json.referer || json.pageUrl || "").trim();
      if (!url) { sendJson(res, 400, { error: "url 必填" }); return; }
      if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "仅支持 http/https URL" }); return; }
      // SSRF 守卫：本端点也拉任意调用方给的 URL 并把整包体回传，必须挡内网/环回/元数据。
      try { if (isBlockedFetchHost(new URL(url).hostname)) { sendJson(res, 403, { error: "禁止访问该地址（内网/环回/元数据）" }); return; } } catch (e) { sendJson(res, 400, { error: "URL 非法" }); return; }
      // 1) 内存命中
      let hit = _remoteImageMemCache.get(url);
      if (hit && Date.now() - hit.ts <= REMOTE_IMAGE_TTL_MS_DEFAULT) {
        sendJson(res, 200, { ok: true, dataUrl: hit.dataUrl, contentType: hit.contentType, size: hit.size, cached: "mem" });
        return;
      }
      // 2) 磁盘命中
      hit = tryReadDiskCache(url);
      if (hit) {
        _remoteImageMemCache.set(url, hit);
        sendJson(res, 200, { ok: true, dataUrl: hit.dataUrl, contentType: hit.contentType, size: hit.size, cached: "disk" });
        return;
      }
      // 3) 现拉
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const requestHeaders = buildRemoteImageHeaders(url, { referer });
      let fetchSource = "http";
      const fetchHttpImage = () => new Promise((resolve, reject) => {
        const r = lib.get(url, { timeout: 20000, headers: requestHeaders }, (resp) => {
          // 跟随 3xx 跳一次（不递归）
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            resp.resume();
            let next;
            try { next = new URL(resp.headers.location, url).toString(); } catch (e) { reject(new Error("重定向地址非法")); return; }
            try { if (isBlockedFetchHost(new URL(next).hostname)) { reject(new Error("重定向到禁止地址")); return; } } catch (e) { reject(new Error("重定向地址非法")); return; }
            const nlib = next.startsWith("https:") ? https : http;
            const r2 = nlib.get(next, { timeout: 20000, headers: buildRemoteImageHeaders(next, { referer: requestHeaders.Referer || referer }) }, (resp2) => {
              if (resp2.statusCode < 200 || resp2.statusCode >= 300) {
                resp2.resume();
                reject(new Error(`重定向后 HTTP ${resp2.statusCode}`));
                return;
              }
              const chunks = [];
              resp2.on("data", (c) => chunks.push(c));
              resp2.on("end", () => resolve({ buf: Buffer.concat(chunks), contentType: resp2.headers["content-type"] || "image/png" }));
              resp2.on("error", reject);
            });
            r2.on("error", reject);
            r2.on("timeout", () => { try { r2.destroy(); } catch (e) {} reject(new Error("timeout")); });
            return;
          }
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            reject(new Error(`HTTP ${resp.statusCode}`));
            return;
          }
          const chunks = [];
          resp.on("data", (c) => chunks.push(c));
          resp.on("end", () => resolve({ buf: Buffer.concat(chunks), contentType: resp.headers["content-type"] || "image/png" }));
        });
        r.on("error", reject);
        r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("timeout")); });
      });
      let buf;
      try {
        buf = await fetchHttpImage();
      } catch (httpErr) {
        if (!shouldUseChromiumFallback(httpErr)) throw httpErr;
        console.warn(`[proxy] /fetch-remote-image HTTP 失败，尝试 Chromium 兜底: ${httpErr.message}`);
        const chromium = await fetchImageWithChromium(url, { referer });
        buf = { buf: chromium.buf, contentType: chromium.contentType };
        fetchSource = `chromium:${chromium.source}`;
      }
      const contentType = String(buf.contentType || "image/png").split(";")[0].trim();
      const dataUrl = `data:${contentType};base64,${buf.buf.toString("base64")}`;
      _remoteImageMemCache.set(url, { dataUrl, contentType, size: buf.buf.length, ts: Date.now() });
      writeDiskCache(url, buf.buf, contentType);
      console.log(`[proxy] /fetch-remote-image OK ${url} → ${buf.buf.length} bytes (${contentType}, ${fetchSource})`);
      sendJson(res, 200, { ok: true, dataUrl, contentType, size: buf.buf.length, cached: "fresh", source: fetchSource });
    } catch (e) {
      console.error(`[proxy] /fetch-remote-image 失败: ${e.message}`);
      sendJson(res, 502, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /fetch-web —— 服务端抓取网页并抽成纯文本（网页素材）。入参 {url, maxLen?, offset?, includeLinks?, includeMeta?}
  // 静态抓取（无 headless 浏览器，不执行 JS）；SSRF 守卫；跟随 1 次 3xx；限 2MB / 15s。
  // 分页：从 offset 起取 maxLen 字符，被截断时回 truncated=true + nextOffset。
  if (pathname === "/fetch-web" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const url = String(json.url || "").trim();
      const maxLen = Number(json.maxLen) > 0 ? Number(json.maxLen) : 8000;
      const offset = Number(json.offset) > 0 ? Math.floor(Number(json.offset)) : 0;
      const includeLinks = !!json.includeLinks;
      const includeMeta = !!json.includeMeta;
      if (!url) { sendJson(res, 400, { error: "url 必填" }); return; }
      if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "仅支持 http/https URL" }); return; }
      try { if (isBlockedFetchHost(new URL(url).hostname)) { sendJson(res, 403, { error: "禁止访问该地址（内网/环回/元数据）" }); return; } } catch (e) { sendJson(res, 400, { error: "URL 非法" }); return; }
      const MAX_BYTES = 2 * 1024 * 1024;
      const getOnce = (target, redirectsLeft) => new Promise((resolve, reject) => {
        const lib = target.startsWith("https:") ? https : http;
        const r = lib.get(target, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (compatible; LingxiAI/1.0)" } }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirectsLeft > 0) {
            resp.resume();
            let next;
            try { next = new URL(resp.headers.location, target).toString(); } catch (e) { reject(new Error("重定向地址非法")); return; }
            try { if (isBlockedFetchHost(new URL(next).hostname)) { reject(new Error("重定向到禁止地址")); return; } } catch (e) { reject(new Error("重定向地址非法")); return; }
            resolve(getOnce(next, redirectsLeft - 1));
            return;
          }
          if (resp.statusCode < 200 || resp.statusCode >= 300) { resp.resume(); reject(new Error(`HTTP ${resp.statusCode}`)); return; }
          const chunks = []; let total = 0;
          resp.on("data", (c) => {
            total += c.length;
            // 超过上限：停止并用已收到的部分兜底返回（htmlToText 会再截断），绝不能不 settle 导致挂死。
            if (total > MAX_BYTES) { try { r.destroy(); } catch (e) {} resolve({ buf: Buffer.concat(chunks), finalUrl: target }); return; }
            chunks.push(c);
          });
          resp.on("end", () => resolve({ buf: Buffer.concat(chunks), finalUrl: target }));
          resp.on("error", reject); // 响应流中途出错也要 settle，否则永挂
        });
        r.on("error", reject);
        r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("timeout")); });
      });
      const { buf, finalUrl } = await getOnce(url, 1);
      const html = buf.toString("utf8");
      const { htmlToText, extractLinks, extractMeta } = require("./html-to-text");
      // 先抽全文（不在此处截断），再按 offset+maxLen 分页，支持长页面续读。
      const full = htmlToText(html, Infinity);
      const start = Math.min(offset, full.text.length);
      const text = full.text.slice(start, start + maxLen);
      const end = start + text.length;
      const truncated = end < full.text.length;
      const payload = {
        ok: true, url, finalUrl,
        title: full.title, text,
        truncated,
        nextOffset: truncated ? end : null
      };
      if (includeLinks) payload.links = extractLinks(html, finalUrl, 100);
      if (includeMeta) payload.meta = extractMeta(html);
      sendJson(res, 200, payload);
    } catch (e) {
      console.error(`[proxy] /fetch-web 失败: ${e.message}`);
      sendJson(res, 502, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // GET /image-search?q=&n=&site= —— 联网找图（best-effort keyless）。指定站点时先解析目标网页图片，
  // 再回退搜索引擎且只保留同站点结果，避免把 Pexels 等离站图片误存为指定网站素材。
  if (pathname === "/image-search" && method === "GET") {
    (async () => {
      try {
        const q = String(parsedUrl.searchParams.get("q") || "").trim();
        const site = String(parsedUrl.searchParams.get("site") || "").trim();
        const n = Math.min(30, Math.max(1, parseInt(parsedUrl.searchParams.get("n") || "8", 10) || 8));
        if (!q) { sendJson(res, 400, { ok: false, error: "q 必填" }); return; }
        const found = await searchImages(q, n, { site, guardHost: isBlockedFetchHost });
        sendJson(res, 200, { ok: true, count: found.results.length, results: found.results, source: found.source, site: found.site || "" });
      } catch (e) {
        console.error(`[proxy] /image-search 失败: ${e.message}`);
        sendJson(res, 502, { ok: false, error: e?.message || String(e) });
      }
    })();
    return;
  }

  // POST /load-local-file —— 读取本机文件返回 base64，用于把活动 PDF 当附件喂给大模型
  // 入参：{ path: "...绝对路径..." }
  // 出参：{ ok, base64, name, size, mediaType }
  // 限制：只允许常见可附件类型 + 大小 ≤ 32MB（Anthropic 文档单文件上限）
  if (pathname === "/active-pdf-path" && (method === "GET" || method === "POST")) {
    try {
      const result = findActivePdfPathFromOpenFiles();
      if (!result.ok) {
        sendJson(res, result.ambiguous ? 409 : 404, result);
        return;
      }
      console.log(`[proxy] /active-pdf-path → ${result.path}`);
      sendJson(res, 200, result);
    } catch (error) {
      console.error("[proxy] /active-pdf-path 失败:", error.message);
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === "/load-local-file" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) { sendJson(res, 400, { error: "path 必填" }); return; }
      if (!fs.existsSync(filePath)) { sendJson(res, 404, { error: "文件不存在: " + filePath }); return; }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) { sendJson(res, 400, { error: "路径不是文件" }); return; }
      const MAX_SIZE = 32 * 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        sendJson(res, 413, { error: `文件太大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 32MB` });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const MIME_MAP = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp",
        ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json"
      };
      const mediaType = MIME_MAP[ext];
      if (!mediaType) {
        sendJson(res, 415, { error: `不支持的文件类型：${ext}` });
        return;
      }
      const buf = fs.readFileSync(filePath);
      const base64 = buf.toString("base64");
      const name = path.basename(filePath);
      console.log(`[proxy] /load-local-file ${filePath} → ${stat.size} bytes, ${mediaType}`);
      sendJson(res, 200, { ok: true, base64, name, size: stat.size, mediaType });
    } catch (error) {
      console.error("[proxy] /load-local-file 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /pdf-extract { path } —— 用 pdfjs 逐页抽取 PDF 文字（带页码），返回
  //   { ok, pages:[{page,text}], charCount, pageCount, hasText }
  // 数字版 PDF 走"文字通道"（任意模型可读、便宜、可分块），扫描件 hasText=false → 上层回退多模态。
  if (pathname === "/pdf-extract" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) { sendJson(res, 400, { error: "path 必填" }); return; }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { sendJson(res, 404, { error: "文件不存在: " + filePath }); return; }
      if (!/\.pdf$/i.test(filePath)) { sendJson(res, 400, { error: "不是 PDF 文件" }); return; }
      const result = await extractPdfText(filePath);
      console.log(`[proxy] /pdf-extract ${filePath} → ${result.pageCount} 页, ${result.charCount} 字, hasText=${result.hasText}`);
      sendJson(res, 200, result);
    } catch (error) {
      console.error("[proxy] /pdf-extract 失败:", error && error.message);
      sendJson(res, 500, { error: error && error.message ? error.message : String(error) });
    }
    return;
  }

  // POST /openai-file-upload —— 把 base64 文件上传到 OpenAI Files API，返回 file_id
  // 入参：{ baseUrl, apiKey, base64, filename, purpose }
  // 出参：透传 OpenAI 响应（{ id, object, ... }）
  // OpenAI chat completion 引用 PDF 需要先走 Files API 拿 file_id（不能直接 inline base64）
  if (pathname === "/openai-file-upload" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const baseUrl = String(json.baseUrl || "").replace(/\/+$/, "");
      const apiKey = String(json.apiKey || "");
      const base64 = String(json.base64 || "");
      const filename = String(json.filename || "file.pdf");
      const purpose = String(json.purpose || "user_data");
      if (!baseUrl || !apiKey || !base64) {
        sendJson(res, 400, { error: "baseUrl / apiKey / base64 必填" });
        return;
      }
      const buf = Buffer.from(base64, "base64");
      // multipart/form-data 手搓（不引第三方依赖）
      const boundary = "----LingxiBoundary" + crypto.randomBytes(8).toString("hex");
      const guessMime = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${guessMime}\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      const payload = Buffer.concat([head, buf, tail]);

      const targetUrl = new URL(baseUrl + "/files");
      const transport = targetUrl.protocol === "https:" ? https : http;
      const upstream = transport.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.length
        }
      }, (uRes) => {
        const chunks = [];
        uRes.on("data", (c) => chunks.push(c));
        uRes.on("end", () => {
          setCorsHeaders(res);
          res.writeHead(uRes.statusCode, { "Content-Type": "application/json" });
          res.end(Buffer.concat(chunks).toString("utf8"));
        });
      });
      upstream.on("error", (err) => {
        console.error("[proxy] /openai-file-upload upstream error:", err.message);
        sendJson(res, 502, { error: err.message });
      });
      upstream.write(payload);
      upstream.end();
    } catch (error) {
      console.error("[proxy] /openai-file-upload 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /image-edit —— 服务端 multipart 调 {baseUrl}/images/edits（抠图/图像编辑，OpenAI 兼容）
  // 入参：{ baseUrl, apiKey, model, size?, prompt, imageBase64, imageMime?, maskBase64? }
  // 出参：透传上游 { data: [{ b64_json | url }] }
  if (pathname === "/image-edit" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const baseUrl = String(json.baseUrl || "").replace(/\/+$/, "");
      const apiKey = String(json.apiKey || "");
      const model = String(json.model || "gpt-image-1");
      const prompt = String(json.prompt || "");
      const size = String(json.size || "");
      const imageBase64 = String(json.imageBase64 || "");
      const imageMime = String(json.imageMime || "image/png");
      const maskBase64 = String(json.maskBase64 || "");
      const background = String(json.background || ""); // transparent|opaque|auto（抠图用 transparent 出透明底 PNG）
      if (!baseUrl || !apiKey || !imageBase64 || !prompt) {
        sendJson(res, 400, { error: "baseUrl / apiKey / imageBase64 / prompt 必填" });
        return;
      }
      const boundary = "----LingxiBoundary" + crypto.randomBytes(8).toString("hex");
      const textField = (name, val) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, "utf8");
      const fileField = (name, filename, mime, buf) => Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`, "utf8"),
        buf,
        Buffer.from("\r\n", "utf8")
      ]);
      const parts = [textField("model", model), textField("prompt", prompt), textField("n", "1")];
      if (size) parts.push(textField("size", size));
      if (background) { parts.push(textField("background", background)); parts.push(textField("output_format", "png")); }
      const ext = /jpe?g/i.test(imageMime) ? "jpg" : (/webp/i.test(imageMime) ? "webp" : "png");
      parts.push(fileField("image", "image." + ext, imageMime, Buffer.from(imageBase64, "base64")));
      if (maskBase64) parts.push(fileField("mask", "mask.png", "image/png", Buffer.from(maskBase64, "base64")));
      parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
      const payload = Buffer.concat(parts);

      const targetUrl = new URL(baseUrl + "/images/edits");
      const transport = targetUrl.protocol === "https:" ? https : http;
      const upstream = transport.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.length
        },
        timeout: 180000
      }, (uRes) => {
        const chunks = [];
        uRes.on("data", (c) => chunks.push(c));
        uRes.on("end", () => {
          setCorsHeaders(res);
          res.writeHead(uRes.statusCode, { "Content-Type": "application/json" });
          res.end(Buffer.concat(chunks).toString("utf8"));
        });
      });
      upstream.on("error", (err) => { console.error("[proxy] /image-edit upstream error:", err.message); sendJson(res, 502, { error: err.message }); });
      upstream.on("timeout", () => { try { upstream.destroy(); } catch (e) {} sendJson(res, 504, { error: "抠图请求超时" }); });
      upstream.write(payload);
      upstream.end();
    } catch (error) {
      console.error("[proxy] /image-edit 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /toapis-upload-image —— 服务端 multipart 调 {baseUrl}/uploads/images
  // ToAPI 的图片编辑不再接收 base64，必须先把本地图片上传成公网 URL，再传给 image_urls。
  if (pathname === "/toapis-upload-image" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const baseUrl = String(json.baseUrl || "").replace(/\/+$/, "");
      const apiKey = String(json.apiKey || "");
      const imageBase64 = String(json.imageBase64 || "");
      const imageMime = String(json.imageMime || "image/png");
      const purpose = String(json.purpose || "generation");
      if (!baseUrl || !apiKey || !imageBase64) {
        sendJson(res, 400, { error: "baseUrl / apiKey / imageBase64 必填" });
        return;
      }

      const ext = /jpe?g/i.test(imageMime) ? "jpg"
        : (/webp/i.test(imageMime) ? "webp"
          : (/gif/i.test(imageMime) ? "gif" : "png"));
      const boundary = "----LingxiBoundary" + crypto.randomBytes(8).toString("hex");
      const textField = (name, val) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, "utf8");
      const fileField = (name, filename, mime, buf) => Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`, "utf8"),
        buf,
        Buffer.from("\r\n", "utf8")
      ]);
      const parts = [
        textField("purpose", purpose),
        fileField("file", "image." + ext, imageMime, Buffer.from(imageBase64, "base64")),
        Buffer.from(`--${boundary}--\r\n`, "utf8")
      ];
      const payload = Buffer.concat(parts);

      const targetUrl = new URL(baseUrl + "/uploads/images");
      const transport = targetUrl.protocol === "https:" ? https : http;
      const upstream = transport.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.length
        },
        timeout: 180000
      }, (uRes) => {
        const chunks = [];
        uRes.on("data", (c) => chunks.push(c));
        uRes.on("end", () => {
          setCorsHeaders(res);
          res.writeHead(uRes.statusCode, { "Content-Type": "application/json" });
          res.end(Buffer.concat(chunks).toString("utf8"));
        });
      });
      upstream.on("error", (err) => { console.error("[proxy] /toapis-upload-image upstream error:", err.message); sendJson(res, 502, { error: err.message }); });
      upstream.on("timeout", () => { try { upstream.destroy(); } catch (e) {} sendJson(res, 504, { error: "ToAPI 图片上传超时" }); });
      upstream.write(payload);
      upstream.end();
    } catch (error) {
      console.error("[proxy] /toapis-upload-image 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /doc-snapshot —— 备份指定文档到 backups 目录，返回 backupPath
  if (pathname === "/doc-snapshot" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const docPath = String(json.docPath || "");
      if (!docPath || !fs.existsSync(docPath)) {
        sendJson(res, 400, { error: "docPath 不存在" });
        return;
      }
      const dir = ensureDocBackupDir(docPath);
      const ext = path.extname(docPath) || ".bin";
      const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
      const backupPath = path.join(dir, `${ts}${ext}`);
      fs.copyFileSync(docPath, backupPath);
      const stat = fs.statSync(backupPath);
      gcDocBackups(dir, MAX_BACKUPS_PER_DOC);
      console.log(`[proxy] /doc-snapshot ${docPath} → ${backupPath} (${stat.size} bytes)`);
      sendJson(res, 200, {
        ok: true,
        backupPath,
        size: stat.size,
        timestamp: stat.mtimeMs
      });
    } catch (error) {
      console.error("[proxy] /doc-snapshot 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /doc-restore —— 把备份文件覆盖回原文档路径
  // 关键坑：WPS Excel/Word 关文档后 Windows 释放文件句柄有滞后,前端的 doc.Close()
  // 返回了不代表 OS 锁已释放,直接 copyFileSync 会 EPERM。这里加退避重试。
  // 另外 WeChat 下载的 xwechat_files 目录里的文件可能被 WeChat 自身长期持锁,
  // 重试还失败时给出明确指引而不是堆 Node stack。
  if (pathname === "/doc-restore" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const backupPath = String(json.backupPath || "");
      const targetPath = String(json.targetPath || "");
      if (!backupPath || !fs.existsSync(backupPath)) {
        sendJson(res, 400, { error: "backupPath 不存在" });
        return;
      }
      if (!targetPath) {
        sendJson(res, 400, { error: "targetPath 必填" });
        return;
      }
      const resolvedBackup = path.resolve(backupPath);
      if (!resolvedBackup.startsWith(path.resolve(BACKUPS_ROOT) + path.sep)) {
        sendJson(res, 403, { error: "backupPath 必须位于 backups 根目录下" });
        return;
      }
      // 修 B18：targetPath 完全由请求方控制。restore 只应"覆盖已存在的文档"，
      // 绝不能创建新文件到任意路径（否则可配合 /doc-snapshot 把受控内容落到启动项等位置）。
      // 因此要求 targetPath 已存在、是普通文件、且扩展名是文档类。
      const DOC_EXT = new Set([".doc", ".docx", ".wps", ".xls", ".xlsx", ".et", ".ppt", ".pptx", ".dps", ".pdf"]);
      try {
        const stat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
        if (!stat || !stat.isFile()) {
          sendJson(res, 403, { error: "targetPath 必须是一个已存在的文档文件" });
          return;
        }
      } catch (e) {
        sendJson(res, 403, { error: "targetPath 校验失败" });
        return;
      }
      if (!DOC_EXT.has(path.extname(targetPath).toLowerCase())) {
        sendJson(res, 403, { error: "targetPath 扩展名不是受支持的文档类型" });
        return;
      }

      // 先把当前文件做一份 .pre-restore 备份（也可能 EPERM，吞掉但记日志）
      if (fs.existsSync(targetPath)) {
        try {
          const dir = ensureDocBackupDir(targetPath);
          const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
          const safetyPath = path.join(dir, `${ts}.pre-restore${path.extname(targetPath)}`);
          fs.copyFileSync(targetPath, safetyPath);
        } catch (e) {
          console.warn(`[proxy] /doc-restore .pre-restore 备份失败（不阻断）:`, e.code, e.message);
        }
      }

      // 退避重试：EPERM / EBUSY / EACCES 大概率是文件句柄还没释放
      const delays = [0, 150, 300, 500, 800, 1200];
      let lastErr = null;
      for (let i = 0; i < delays.length; i += 1) {
        if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
        try {
          fs.copyFileSync(backupPath, targetPath);
          console.log(`[proxy] /doc-restore ${backupPath} → ${targetPath}${i > 0 ? ` (第 ${i + 1} 次成功)` : ""}`);
          sendJson(res, 200, { ok: true, retries: i });
          return;
        } catch (e) {
          lastErr = e;
          if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) break;
          console.warn(`[proxy] /doc-restore 第 ${i + 1} 次 ${e.code}，重试`);
        }
      }
      const isLikelyLocked = lastErr && ["EPERM", "EBUSY", "EACCES"].includes(lastErr.code);
      const hint = isLikelyLocked
        ? `文件仍被占用。请先在 WPS 完全关闭这份文档（关掉所有打开它的窗口）再恢复；如果文件位于「微信下载」目录（xwechat_files），需要先在微信里关闭对应聊天窗口的预览。`
        : (lastErr?.message || "未知错误");
      console.error(`[proxy] /doc-restore 最终失败:`, lastErr?.code, lastErr?.message);
      sendJson(res, 500, { error: hint, code: lastErr?.code || "" });
    } catch (error) {
      console.error("[proxy] /doc-restore 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // ===== 缓存管理（GET /cache/stats, POST /cache/clear）=====
  // TaskPane 的"缓存管理"面板用来看 proxy 侧攒了多少备份 / 临时更新文件，
  // 以及一键清理。每个 bucket 是独立目录，label 给中文名方便渲染。
  const CACHE_BUCKETS = {
    backups: {
      label: "文档备份（改动记录恢复用）",
      dir: BACKUPS_ROOT,
      safe: false // 清了就没法回滚老 turn 了
    },
    updates: {
      label: "临时更新包 (plugin.zip)",
      // /update/download 把 zip 落在 os.tmpdir() 下的 lingxi-update-*
      dir: os.tmpdir(),
      pattern: /^lingxi-update-|^lingxi-plugin-update-/,
      safe: true
    }
  };

  function bucketSize(bucket) {
    const dir = bucket.dir;
    if (!fs.existsSync(dir)) return { bytes: 0, itemCount: 0 };
    let bytes = 0, itemCount = 0;
    function walk(p) {
      let st; try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) {
        let entries; try { entries = fs.readdirSync(p); } catch (e) { return; }
        for (const name of entries) {
          if (bucket.pattern && p === dir && !bucket.pattern.test(name)) continue; // 顶层过滤
          walk(path.join(p, name));
        }
      } else if (st.isFile()) {
        bytes += st.size;
        itemCount += 1;
      }
    }
    walk(dir);
    return { bytes, itemCount };
  }

  function bucketClear(bucket) {
    const dir = bucket.dir;
    if (!fs.existsSync(dir)) return { removed: 0 };
    let removed = 0;
    let entries; try { entries = fs.readdirSync(dir); } catch (e) { return { removed: 0 }; }
    for (const name of entries) {
      if (bucket.pattern && !bucket.pattern.test(name)) continue;
      const fp = path.join(dir, name);
      try {
        fs.rmSync(fp, { recursive: true, force: true });
        removed += 1;
      } catch (e) { /* 有文件正在被用就跳过 */ }
    }
    return { removed };
  }

  if (pathname === "/cache/stats" && method === "GET") {
    try {
      const buckets = Object.entries(CACHE_BUCKETS).map(([name, cfg]) => {
        const s = bucketSize(cfg);
        return {
          name,
          label: cfg.label,
          path: cfg.dir,
          bytes: s.bytes,
          itemCount: s.itemCount,
          safe: cfg.safe
        };
      });
      sendJson(res, 200, { ok: true, buckets });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === "/cache/clear" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8") || "{}");
      const name = String(json.name || "");
      const cfg = CACHE_BUCKETS[name];
      if (!cfg) { sendJson(res, 400, { ok: false, error: `未知 bucket: ${name}` }); return; }
      const r = bucketClear(cfg);
      console.log(`[proxy] /cache/clear ${name}: 删了 ${r.removed} 项`);
      sendJson(res, 200, { ok: true, removed: r.removed });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  // GET /doc-backups?docPath=... —— 列出某文档的备份
  if (pathname === "/doc-backups" && method === "GET") {
    try {
      const docPath = parsedUrl.searchParams.get("docPath") || "";
      if (!docPath) { sendJson(res, 400, { error: "docPath 必填" }); return; }
      const dir = docBackupDir(docPath);
      const items = fs.existsSync(dir)
        ? fs.readdirSync(dir)
            .filter((n) => !n.endsWith(".pre-restore") && !n.includes(".pre-restore."))
            .map((n) => {
              const fp = path.join(dir, n);
              const st = fs.statSync(fp);
              return { backupPath: fp, name: n, size: st.size, timestamp: st.mtimeMs };
            })
            .sort((a, b) => b.timestamp - a.timestamp)
        : [];
      sendJson(res, 200, { ok: true, items });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  const targetUrl = resolveTarget(pathname, search);
  if (!targetUrl) {
    setCorsHeaders(res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: `未知路由: ${pathname}。若刚更新过插件，请重启本地代理（重跑 npm run dev:* 或重装/重启后台服务）。常用：/forward/<encoded-base>/*, /upload-image, /save-local-image-as, /image-edit, /toapis-upload-image, /asset/js/vendor/*, /fetch-remote-image, /fetch-web, /image-search, /active-pdf-path, /load-local-file, /doc-snapshot, /doc-restore, /kv/all, /kv/batch, /kv/merge-list, /kv/merge-object, /kv/stats, /kv/clear`
      }
    }));
    return;
  }

  console.log(`[proxy] ${method} ${pathname}${search || ""} → ${targetUrl}`);

  const headers = filterHeaders(req.headers);
  // NOTE: 设置正确的 Host 头，避免远程服务器拒绝请求
  const remoteUrl = new URL(targetUrl);
  headers["Host"] = remoteUrl.host;

  // 自定义端点（/forward/*，主要是 OpenAI 兼容中转 / 图像 sub2api）很多走 Cloudflare 前置 WAF，
  // 看到 WebView UA（"Mozilla/... WPSOffice/..."）会直接 RST。这类端点跟 curl 一样
  // 不需要浏览器 UA，强制改成 curl 风格的 UA 并清掉 Accept-Language 之类不必要字段，
  // 把请求外观对齐到用户在终端测试通过的 curl。
  // 不影响 /codex/* 和 /openai/*：那两条历史路径就需要真实浏览器 UA / 特殊原 header。
  if (pathname.startsWith("/forward/")) {
    // HTTP header 名不区分大小写，但 Node http.request 会把所有 key 当成独立条目
    // 都发出去 —— 之前同时存在 "user-agent: Mozilla..." 和 "User-Agent: curl/..."
    // 上游看到的是 Mozilla 那条。必须先把所有大小写变体都干掉再设。
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === "user-agent" || lk === "accept" || lk === "accept-encoding"
          || lk === "accept-language" || lk === "connection") {
        delete headers[k];
      }
    }
    headers["User-Agent"] = "Apifox/1.0.0 (https://apifox.com)";
    headers["Accept"] = "*/*";
    // 关键：Node http.request 默认 Connection: close。example.com 等 CF 前置 WAF
    // 对 POST + Connection: close 直接 RST，这就是之前换了 UA 还 ECONNRESET 的真因。
    // 显式 keep-alive 后跟成功的 curl 头对齐。
    headers["Connection"] = "keep-alive";
  }

  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(req) : null;

  // /forward/* 端点的 TLS 选项调成尽量贴近 Chrome，让 CF 边缘的 JA3 评分有机会放过。
  // 注意：Node OpenSSL 没法改 TLS 扩展顺序（JA3 真正的核心差异），所以不保证生效；
  // 这是相对低成本的一次性尝试，不行就只能换端点。
  //
  // 背景：
  //   - family: 4    Node 18+ 默认 IPv6 优先，有些 CF 站点 IPv6 路由不健康（TCP 通但应用层 RST）
  //   - ciphers      Chrome TLS 1.3 + 1.2 的 cipher 顺序
  //   - ALPNProtocols  固定 http/1.1：这里用的是 https.request，不能解析 HTTP/2 响应帧。
  //   - ecdhCurve    Chrome 的曲线顺序 X25519 > P-256 > P-384
  //   - minVersion   强制 TLS 1.2 起，避免 OpenSSL 默认握出 TLS 1.0/1.1 被一些 CF 站点拒
  const extraOpts = pathname.startsWith("/forward/") ? {
    family: 4,
    ALPNProtocols: ["http/1.1"],
    ciphers: [
      "TLS_AES_128_GCM_SHA256",
      "TLS_AES_256_GCM_SHA384",
      "TLS_CHACHA20_POLY1305_SHA256",
      "ECDHE-ECDSA-AES128-GCM-SHA256",
      "ECDHE-RSA-AES128-GCM-SHA256",
      "ECDHE-ECDSA-AES256-GCM-SHA384",
      "ECDHE-RSA-AES256-GCM-SHA384",
      "ECDHE-ECDSA-CHACHA20-POLY1305",
      "ECDHE-RSA-CHACHA20-POLY1305",
      "ECDHE-RSA-AES128-SHA",
      "ECDHE-RSA-AES256-SHA",
      "AES128-GCM-SHA256",
      "AES256-GCM-SHA384",
      "AES128-SHA",
      "AES256-SHA"
    ].join(":"),
    ecdhCurve: "X25519:P-256:P-384",
    minVersion: "TLSv1.2"
  } : {};
  proxyRequest(targetUrl, method, headers, body, res, extraOpts);
});

function startProxyListenLadder(port, attemptsLeft) {
  // 关键：listening 的事件监听器也要一并清掉。否则第一次 server.listen(3890, cb1)
  // 在 EADDRINUSE 触发 error 后，cb1（闭包里 port=3890）仍然挂在 once("listening") 上；
  // 递归调 server.listen(3891, cb2) 成功 bind 后，listening 事件会同时触发 cb1 和 cb2，
  // cb1 先跑、用旧的 3890 覆盖 RESOLVED_PROXY_PORT，于是日志里印的是 3890 而不是真实的 3891。
  server.removeAllListeners("error");
  server.removeAllListeners("listening");
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`[proxy] 端口 ${port} 已被占用，自动切到 ${port + 1}（剩 ${attemptsLeft - 1} 次尝试）`);
      startProxyListenLadder(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`[proxy] 监听端口 ${port} 失败：${e.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    RESOLVED_PROXY_PORT = port;
    writeRuntimePortFile();
    const switched = port !== PROXY_PORT;
    console.log(`[proxy] CORS 代理服务器已启动: http://127.0.0.1:${RESOLVED_PROXY_PORT}` + (switched ? `（请求端口 ${PROXY_PORT} 被占用，已自动切换到 ${RESOLVED_PROXY_PORT}）` : ""));
    console.log(`[proxy] 已写入实际端口到 ${RUNTIME_PORT_FILE}`);
    console.log("[proxy] 路由映射:");
    ROUTE_MAP.forEach((route) => {
      console.log(`  ${route.prefix}* → ${route.target}*`);
    });
    console.log("  /forward/<urlencoded-base>/* → <base>/* (通用转发，用于自定义端点)");
    console.log("  GET  /healthz → 服务签名 + 实际端口（前端探测自动定位用）");
    console.log("  POST /debug-log → 插件调试日志写到当前终端");
    console.log("  POST /local-image-info → 本地图片真实路径信息（Writer 插图路径兜底）");
    console.log("  POST /image-html-file → 为 Writer InsertFile 生成本地图片 HTML 兜底文件");
    console.log(`  POST /upload-image → 落地图片到 ${RENDER_DIR}/<random>.png|jpg|svg|webp|gif`);
    console.log("  POST /save-local-image-as → 素材预览图片另存为（系统对话框，Linux 无桌面工具时 Node 写 Downloads 兜底）");
    console.log("  POST /local-matting-infer → 本地 Node 执行 ONNX 抠图推理（无 WebAssembly WebView 兜底）");
    console.log("  POST /toapis-upload-image → 上传 base64 图片到 ToAPI /uploads/images 拿公网 URL");
    console.log(`  POST /fetch-remote-image → 服务端代下 http(s) 图片 (绕开 CORS) 返回 dataUrl, 6h 缓存`);
    console.log("  GET  /active-pdf-path → 自动识别 WPS 当前打开的本机 PDF 路径（macOS lsof 兜底）");
    console.log(`  POST /load-local-file → 读取本机文件 base64（≤32MB，PDF/img/txt 白名单）`);
    console.log(`  POST /openai-file-upload → 上传 base64 到 OpenAI Files API 拿 file_id`);
    console.log(`  POST /doc-snapshot → 备份当前文档到 ${BACKUPS_ROOT}/<doc>/<ts>.<ext>`);
    console.log("  POST /doc-restore → 把备份覆盖回原路径（自动留 .pre-restore 兜底）");
    console.log("  GET  /doc-backups?docPath=... → 列出某文档的所有备份");
    console.log("  --- MCP 桥 ---");
    console.log("  POST /mcp/register → WPS plugin 上报工具清单");
    console.log("  GET  /mcp/poll → plugin 长轮询拿任务（25s 超时）");
    console.log("  POST /mcp/result → plugin 返回 call 结果");
    console.log("  GET  /mcp/tools → 外部 MCP bridge 拿工具清单");
    console.log("  POST /mcp/call → 外部 MCP bridge 投递工具调用");
    console.log("  GET  /mcp/status → 查询 plugin 在线 + 工具数");
  });
}

startProxyListenLadder(PROXY_PORT, PROXY_PORT_LADDER_SIZE);
