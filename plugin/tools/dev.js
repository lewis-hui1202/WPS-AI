#!/usr/bin/env node
/**
 * 跨平台并发启动 CORS 代理 + 本地插件静态服务。
 *
 * 替代旧的 bash-only 脚本：
 *   "node tools/proxy-server.js & wpsjs debug; kill %1 2>/dev/null"
 *
 * 在 Windows cmd 上 `&` 是顺序执行而非并发，会导致调试服务永远不启动。
 * 这个脚本统一用 child_process.spawn 并发跑两个进程，Ctrl-C 时一起结束。
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const isWindows = os.platform() === "win32";
const isLinux = os.platform() === "linux";
const isMac = os.platform() === "darwin";
const { cleanMacAuthCache, removeMacDevPublish, removeWindowsDevPublish, sanitizeWindowsPublish, writeMacDevPublish } = require("./dev-publish.js");
const STATIC_PORT = Number(process.env.WPSJS_PORT || process.env.STATIC_PORT) || 3889;
const STATIC_PORT_LADDER_SIZE = Number(process.env.STATIC_PORT_LADDER_SIZE) || 20;

/**
 * 历史上这里会把 jsplugins.xml / publish.xml 里的 debug="code" 和 enable="enable_dev"
 * 静默改掉，目的是藏掉 WPS ribbon 上自动塞进来的「打开JS调试器」按钮。
 *
 * 但这两个属性同时是 WPS DevTools 子系统的总开关 —— 清掉之后 jsapi 的
 * Application.Options.ShowDevTools = true 会变成静默 no-op（设置面板里的
 * 「打开 JS 调试器」按钮也就跟着废了）。
 *
 * 结论：不能两头通吃。优先保留 DevTools 能力，ribbon 上多一个原生按钮可以接受。
 * 这里保留函数桩做兜底（万一历史 patch 已经写花了 xml，恢复一下），但不再
 * 主动清属性。
 */
function suppressDevDebugButton() {
  // no-op：保留 enable_dev / debug 属性，让 WPS DevTools 子系统启用，
  // 设置面板里的「打开 JS 调试器」按钮才能真的弹窗。
  // 原生 ribbon 按钮重复展示但功能正常，dev 环境可接受。
}

function spawnLabeled(label, color, command, args, cwd, extraEnv = {}) {
  // Windows 上 .cmd / .bat 必须 shell:true 才能解析
  const child = spawn(command, args, {
    cwd,
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, extraEnv)
  });

  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  const wire = (stream, target) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        target.write(prefix + line + "\n");
      }
    });
    stream.on("end", () => {
      if (buf) target.write(prefix + buf + "\n");
    });
  };

  wire(child.stdout, process.stdout);
  wire(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    process.stdout.write(prefix + `进程退出 code=${code} signal=${signal}\n`);
  });

  return child;
}

function getAddonType(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8"));
    return pkg.addonType || "wps";
  } catch (error) {
    return "wps";
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createDevPathPrefix() {
  return `/__lingxi_dev_${Date.now().toString(36)}_${process.pid.toString(36)}`;
}

function createDevAddonName(devPathPrefix) {
  const suffix = String(devPathPrefix || createDevPathPrefix())
    .replace(/^\/+/, "")
    .replace(/^__lingxi_dev_/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `lingxi-ai-dev-${suffix || Date.now().toString(36)}`;
}

const MAC_DEV_SNAPSHOT_SKIP = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "runtime",
  "test",
  "skills",
  "dist",
  "dist-permanent"
]);

function shouldCopyMacDevSnapshotEntry(name) {
  return !MAC_DEV_SNAPSHOT_SKIP.has(name);
}

function copyMacDevSnapshotTree(srcRoot, dstRoot) {
  fs.mkdirSync(dstRoot, { recursive: true });
  for (const name of fs.readdirSync(srcRoot)) {
    if (!shouldCopyMacDevSnapshotEntry(name)) continue;
    const srcPath = path.join(srcRoot, name);
    const dstPath = path.join(dstRoot, name);
    const stat = fs.lstatSync(srcPath);
    if (stat.isDirectory()) {
      copyMacDevSnapshotTree(srcPath, dstPath);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, dstPath);
      continue;
    }
    fs.copyFileSync(srcPath, dstPath);
    fs.utimesSync(dstPath, stat.atime, stat.mtime);
  }
}

function createMacDevSnapshotRoot(cwd, devPathPrefix) {
  if (!isMac) return "";
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-dev-snapshot-"));
  copyMacDevSnapshotTree(cwd, snapshotRoot);
  process.stdout.write(`[dev] 已创建 macOS 调试快照目录：${snapshotRoot}（prefix=${devPathPrefix}）。\n`);
  return snapshotRoot;
}

function requestStaticHealth(port, healthPath, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1",
      port,
      path: healthPath,
      timeout: timeoutMs
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({
            statusCode: res.statusCode || 0,
            data: JSON.parse(body)
          });
        } catch (error) {
          reject(new Error(`unexpected static health response: ${res.statusCode || "n/a"}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("static health request timed out")));
    req.on("error", reject);
  });
}

function waitForStaticServer(port, pathPrefix, timeoutMs = 8000, ladderSize = STATIC_PORT_LADDER_SIZE) {
  const startedAt = Date.now();
  const prefix = String(pathPrefix || "").replace(/\/+$/, "");
  const healthPath = `${prefix}/healthz`;
  const ports = Array.from({ length: Math.max(0, ladderSize) + 1 }, (_, index) => port + index);

  return new Promise((resolve, reject) => {
    let lastError = null;
    const retry = (error) => {
      lastError = error || lastError;
      if (Date.now() - startedAt >= timeoutMs) {
        reject(lastError || new Error("static server health check timed out"));
        return;
      }
      setTimeout(attempt, 100);
    };

    const attempt = async () => {
      for (const candidatePort of ports) {
        try {
          const { statusCode, data } = await requestStaticHealth(candidatePort, healthPath);
          try {
            const prefixMatches = !pathPrefix || data.devPathPrefix === pathPrefix;
            if (statusCode === 200 && data.service === "lingxi-ai-static/v1" && prefixMatches) {
              resolve(data);
              return;
            }
          } catch (error) {
            lastError = error;
          }
          lastError = new Error(`unexpected static health response: ${statusCode || "n/a"}`);
        } catch (error) {
          lastError = error;
        }
      }
      retry(lastError);
    };

    attempt();
  });
}

function getLinuxPublishDirs() {
  const home = os.homedir();
  return [
    path.join(home, ".local/share/Kingsoft/wps/jsaddons"),
    path.join(home, ".config/Kingsoft/Office6/jsaddons"),
    path.join(home, ".config/Kingsoft/Office365/jsaddons"),
    path.join(home, ".config/wps365/jsaddons"),
    path.join(home, ".config/Kingsoft/wps-365/jsaddons"),
    path.join(home, ".config/Kingsoft/WPS-365/jsaddons"),
    path.join(home, ".config/WPSOffice/jsaddons"),
    path.join(home, ".config/wps-office/jsaddons"),
    path.join(home, ".config/wps/jsaddons"),
    path.join(home, ".kingsoft/office6/jsaddons"),
    path.join(home, ".kingsoft/Office6/jsaddons"),
    path.join(home, ".linglong/com.wps.office/data/.config/Kingsoft/Office6/jsaddons"),
    path.join(home, "snap/wps-office/current/.config/Kingsoft/Office6/jsaddons"),
    path.join(home, "snap/wps-office-multilang/current/.config/Kingsoft/Office6/jsaddons"),
    path.join(home, ".var/app/com.wps.Office/config/Kingsoft/Office6/jsaddons")
  ];
}

function writeLinuxDebugPublish(cwd, staticPort = STATIC_PORT) {
  if (!isLinux) return;

  const addonType = getAddonType(cwd);
  let name = "lingxi-ai";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8"));
    name = pkg.name || name;
  } catch (error) { /* ignore */ }

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="${escapeXml(name)}" type="${escapeXml(addonType)}" url="http://127.0.0.1:${escapeXml(staticPort)}/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`;

  let count = 0;
  for (const dir of getLinuxPublishDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "publish.xml"), xml);
      count += 1;
    } catch (error) {
      // Some sandboxed package paths may not be writable until the package exists.
    }
  }
  process.stdout.write(`[dev] Linux 调试注册已写入 ${count} 个 jsaddons 候选目录（type=${addonType}，url=http://127.0.0.1:${staticPort}/）。\n`);
}

function writeMacDebugPublish(cwd, devPathPrefix, devAddonName = "", staticPort = STATIC_PORT) {
  if (!isMac) return;

  const addonType = getAddonType(cwd);
  let name = "lingxi-ai";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8"));
    name = pkg.name || name;
  } catch (error) { /* ignore */ }
  name = devAddonName || name;

  const cleaned = cleanMacAuthCache({ name, port: staticPort });
  if (cleaned.entries > 0) {
    process.stdout.write(`[dev] 已清理 WPS 旧插件校验缓存 ${cleaned.entries} 条（${cleaned.files} 个 authaddin.json）。\n`);
  }
  const count = writeMacDevPublish({ addonType, name: devAddonName || name, port: staticPort, pathPrefix: devPathPrefix });
  const url = `http://127.0.0.1:${staticPort}${devPathPrefix}/`;
  process.stdout.write(`[dev] macOS 调试注册已写入 ${count} 个 WPS Container（type=${addonType}，url=${url}）。\n`);
}

function writeWindowsDebugPublish(cwd, port = STATIC_PORT) {
  if (!isWindows) return 0;

  const addonType = getAddonType(cwd);
  let name = "lingxi-ai-dev";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8"));
    name = `${pkg.name || "lingxi-ai"}-dev`;
  } catch (error) { /* ignore */ }

  const appData = process.env.APPDATA;
  if (!appData) {
    process.stderr.write("[dev] APPDATA 不存在，无法写入 Windows WPS publish.xml。\n");
    return 0;
  }
  const dir = path.join(appData, "kingsoft", "wps", "jsaddons");
  const publishPath = path.join(dir, "publish.xml");
  let otherEntries = [];
  try {
    if (fs.existsSync(publishPath)) {
      const raw = fs.readFileSync(publishPath, "utf8");
      otherEntries = raw
        .split(/\r?\n/)
        .filter((line) => /<jspluginonline\b/i.test(line) && !/lingxi-ai-dev|lingxi-ai/i.test(line));
    }
  } catch (error) { /* ignore */ }

  const entry = `  <jspluginonline name="${escapeXml(name)}" type="${escapeXml(addonType)}" url="http://127.0.0.1:${port}/" debug="" enable="enable_dev" install="null"/>`;
  const xml = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<jsplugins>`,
    ...otherEntries,
    entry,
    `</jsplugins>`,
    ``
  ].join("\n");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(publishPath, xml, "utf8");
  process.stdout.write(`[dev] Windows 调试注册已写入 ${publishPath}（type=${addonType}，url=http://127.0.0.1:${port}/）。\n`);
  process.stdout.write("[dev] 未使用 wpsjs 自动拉起宿主；请手动打开/重启 WPS 对应宿主。\n");
  return 1;
}

function resolveWpsjsCommand(cwd) {
  if (!isWindows) return { command: "wpsjs", args: ["debug"], available: true };
  const localCmd = path.join(cwd, "node_modules", ".bin", "wpsjs.cmd");
  if (fs.existsSync(localCmd)) return { command: localCmd, args: ["debug"], available: true };
  // 本地 .bin 没有就找全局 PATH 上的 wpsjs.cmd（用户全局装了 wpsjs CLI 时）。
  // 否则会退到静态调试模式，而静态模式下 WPS 会对 http 主资源做内容校验并失败
  // （控制台报 "Main resource content verification failed"）→ 插件被降级加载：
  // 顶部模型栏填不出、面板一开 ribbon 事件桥就失效。正规 wpsjs debug 是 WPS 信任的调试注册，不做该校验。
  try {
    const found = spawnSync("where", ["wpsjs.cmd"], { encoding: "utf8" });
    if (found.status === 0) {
      const first = String(found.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return { command: first, args: ["debug"], available: true };
    }
  } catch (e) {}
  return { command: "wpsjs.cmd", args: ["debug"], available: false };
}

function pickWindowsDevPorts(cwd) {
  const fallback = {
    staticPort: STATIC_PORT,
    proxyPort: Number(process.env.PROXY_PORT) || 3890
  };
  if (!isWindows) return fallback;

  const canBind = (port) => {
    try {
      const script = [
        "$p=" + Number(port) + ";",
        "try {",
        "  $l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$p);",
        "  $l.Start(); $l.Stop(); exit 0",
        "} catch { exit 1 }"
      ].join(" ");
      const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
        cwd,
        encoding: "utf8",
        windowsHide: true
      });
      return result.status === 0;
    } catch (error) {
      return false;
    }
  };
  const pick = (ports, exclude = new Set()) => {
    for (const port of ports) {
      if (!exclude.has(port) && canBind(port)) return port;
    }
    return null;
  };

  const staticCandidates = Array.from({ length: 21 }, (_, i) => 3889 + i);
  const proxyCandidates = Array.from({ length: 20 }, (_, i) => 3890 + i);
  const staticPort = pick(staticCandidates) || fallback.staticPort;
  const proxyPort = pick(proxyCandidates, new Set([staticPort])) || fallback.proxyPort;
  if (staticPort !== fallback.staticPort || proxyPort !== fallback.proxyPort) {
    process.stdout.write(`[dev] 默认端口被占用，开发端口改用 static=${staticPort} proxy=${proxyPort}。\n`);
  }
  return { staticPort, proxyPort };
}

function firstExistingPath(paths) {
  return paths.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch (error) {
      return false;
    }
  });
}

function getLinuxHostArgs(addonType) {
  if (addonType === "wpp") {
    const template = firstExistingPath([
      "/opt/kingsoft/wps-office/office6/mui/zh_CN/templates/Wpp Default Object/prometheus/newfile_linux.pptx",
      "/opt/kingsoft/wps-office/office6/mui/default/templates/newfile.pptx",
      "/opt/kingsoft/wps-office/office6/asso_template/wps.pptx"
    ]);
    return template ? [template] : [];
  }
  if (addonType === "et") {
    const template = firstExistingPath([
      "/opt/kingsoft/wps-office/office6/mui/zh_CN/templates/newfile.xlsx",
      "/opt/kingsoft/wps-office/office6/mui/default/templates/newfile.xlsx",
      "/opt/kingsoft/wps-office/office6/asso_template/wps.xlsx"
    ]);
    return template ? [template] : [];
  }
  return [];
}

function launchLinuxWpsHost(cwd) {
  if (!isLinux) return null;

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    process.stdout.write("[dev] 未检测到 DISPLAY/WAYLAND_DISPLAY，跳过自动打开 WPS。\n");
    return null;
  }

  const addonType = getAddonType(cwd);
  const commandByHost = {
    wps: "wps",
    et: "et",
    wpp: "wpp",
    pdf: "wpspdf"
  };
  const command = commandByHost[addonType] || "wps";
  const args = getLinuxHostArgs(addonType);

  // Linux 版 wpsjs 只注册调试服务，不负责拉起宿主；这里补齐与 Win/mac 接近的体验。
  // WPS 365 融合模式下空启动 wpp/et 可能落到文字首页，传宿主模板可强制进入目标宿主。
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore"
  });

  child.on("error", (error) => {
    process.stderr.write(`[dev] 自动打开 ${command} 失败：${error.message}。请手动运行 ${command}。\n`);
  });
  child.unref();
  process.stdout.write(`[dev] 已尝试自动打开 Linux WPS 宿主：${command}${args.length ? ` ${args[0]}` : ""}\n`);
  return child;
}

function launchMacWpsHost(cwd) {
  if (!isMac) return null;

  const appPath = "/Applications/wpsoffice.app";
  const child = spawn("open", ["-na", appPath], {
    cwd,
    detached: true,
    stdio: "ignore"
  });

  child.on("error", (error) => {
    process.stderr.write(`[dev] 自动打开 macOS WPS 失败：${error.message}。请手动打开 ${appPath}。\n`);
  });
  child.unref();
  process.stdout.write(`[dev] 已尝试以新实例打开 macOS WPS 宿主：${appPath}\n`);
  return child;
}

const cwd = process.cwd();
const devPathPrefix = isMac ? createDevPathPrefix() : "";
const devAddonName = isMac ? createDevAddonName(devPathPrefix) : "";
const macDevSnapshotRoot = isMac ? createMacDevSnapshotRoot(cwd, devPathPrefix) : "";
const wpsjs = resolveWpsjsCommand(cwd);
const useStaticFallback = isWindows && !wpsjs.available;
if (isWindows && sanitizeWindowsPublish()) {
  // 启动兜底：清掉历史遗留的空壳 publish.xml（<jsplugins></jsplugins>）。否则 wpsjs debug
  // 会因 xml2js 判空 bug 每次把它写空、丢失注册，导致 WPS 一直不显示 ribbon 入口。
  process.stdout.write("[dev] 已清理历史遗留的空 publish.xml（避免 wpsjs 写空自我循环）。\n");
}
const devPorts = pickWindowsDevPorts(cwd);
if (useStaticFallback) {
  writeWindowsDebugPublish(cwd, devPorts.staticPort);
  process.stderr.write("[dev] 未找到 wpsjs.cmd，已切到静态调试模式。若想恢复 wpsjs 自动拉起，请安装 WPS 官方 wpsjs CLI 并加入 PATH。\n");
}

const { pickProxyLauncher } = require("./pick-node.js");
const proxyLauncher = pickProxyLauncher(cwd, "tools/proxy-server.js");
if (proxyLauncher.error) {
  process.stderr.write("[dev] 错误：" + proxyLauncher.error + "\n");
  process.exit(1);
}
const proxy = spawnLabeled(
  "proxy",
  "36", // 青色
  proxyLauncher.nodeBin,
  proxyLauncher.args,
  cwd,
  { PROXY_PORT: String(devPorts.proxyPort) }
);

const useOwnStaticServer = isLinux || isMac;
const hostServer = useOwnStaticServer
  ? spawnLabeled(
      "static",
      "32", // 绿色
	      process.execPath,
	      [path.resolve(cwd, "tools/dev-static-server.js")],
	      cwd,
	      isMac
	        ? { LINGXI_DEV_PATH_PREFIX: devPathPrefix, LINGXI_DEV_ROOT: macDevSnapshotRoot, LINGXI_PROXY_PORT: String(devPorts.proxyPort) }
	        : { LINGXI_PROXY_PORT: String(devPorts.proxyPort) }
	    )
  : useStaticFallback
    ? spawnLabeled(
        "static",
        "32",
        process.execPath,
        [path.resolve(cwd, "tools/dev-static-server.js")],
        cwd,
        { WPSJS_PORT: String(devPorts.staticPort), STATIC_PORT: String(devPorts.staticPort), LINGXI_PROXY_PORT: String(devPorts.proxyPort) }
      )
	  : spawnLabeled(
	      "wpsjs",
	      "32", // 绿色
	      wpsjs.command,
	      wpsjs.args,
	      cwd
	    );

let linuxWpsHost = null;
let macWpsHost = null;
let macDebugPublishRegistered = false;
let resolvedStaticPort = STATIC_PORT;

function cleanupMacDebugPublish() {
  if (!isMac || !macDebugPublishRegistered) return;
  try {
    const publishFiles = removeMacDevPublish({ name: devAddonName, port: resolvedStaticPort });
    const cleaned = cleanMacAuthCache({ name: devAddonName, port: resolvedStaticPort });
    process.stdout.write(`[dev] 已清理 macOS 临时调试注册 ${publishFiles} 个 publish.xml、${cleaned.entries} 条校验缓存。\n`);
  } catch (error) {
    process.stderr.write(`[dev] 清理 macOS 临时调试注册失败：${error.message}\n`);
  }
}

function cleanupWindowsDebugPublish() {
  // 对称补齐 mac 的清理：Windows 无论走 wpsjs debug（写 lingxi-ai）还是静态兜底
  // （写 lingxi-ai-dev），退出时都把 publish.xml 里指向本地 dev 服务的灵犀 online
  // 条目删掉，否则下次打开 WPS 仍会尝试从已停掉的 127.0.0.1 端口加载 → 面板空白。
  // wps/et/wpp/pdf 共用同一个 publish.xml，一次清理覆盖全部宿主。
  if (!isWindows) return;
  try {
    const removed = removeWindowsDevPublish();
    if (removed > 0) {
      process.stdout.write("[dev] 已清理 Windows 临时调试注册（publish.xml 中的灵犀 online 条目）。\n");
    }
  } catch (error) {
    process.stderr.write(`[dev] 清理 Windows 临时调试注册失败：${error.message}\n`);
  }
}

function cleanupMacDevSnapshotRoot() {
  if (!isMac || !macDevSnapshotRoot) return;
  try {
    fs.rmSync(macDevSnapshotRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.stdout.write(`[dev] 已清理 macOS 调试快照目录：${macDevSnapshotRoot}\n`);
  } catch (error) {
    process.stderr.write(`[dev] 清理 macOS 调试快照目录失败：${error.message}\n`);
  }
}

// 保留 DevTools 开关，不再清 debug / enable_dev 属性。
suppressDevDebugButton();

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n[dev] 关闭中（${reason}）...\n`);
  cleanupMacDebugPublish();
  for (const child of [proxy, hostServer, linuxWpsHost, macWpsHost]) {
    if (child && !child.killed) {
      try {
        if (isWindows) {
          // Windows 下 child_process kill 经常无法终止 shell 子进程，强制 taskkill
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
        } else {
          child.kill("SIGTERM");
        }
      } catch (error) { /* ignore */ }
    }
  }
  setTimeout(() => {
    // 等 taskkill 把 wpsjs debug 收掉后再清 publish.xml，避免和它的启动写入相互覆盖。
    cleanupWindowsDebugPublish();
    cleanupMacDevSnapshotRoot();
    process.exit(0);
  }, 800);
}

process.on("SIGINT", () => shutdown("Ctrl-C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 任意子进程崩溃时一起退出，避免端口悬挂
proxy.on("exit", (code) => { if (!shuttingDown && code !== 0) shutdown(`proxy 退出 code=${code}`); });
hostServer.on("exit", (code) => { if (!shuttingDown && code !== 0) shutdown(`${useOwnStaticServer ? "static" : "wpsjs"} 退出 code=${code}`); });

async function registerDebugPublishWhenReady() {
  if (!useOwnStaticServer) return;
  try {
    const staticHealth = await waitForStaticServer(STATIC_PORT, devPathPrefix);
    const staticPort = Number(staticHealth?.port) || STATIC_PORT;
    resolvedStaticPort = staticPort;
    if (isLinux) {
      writeLinuxDebugPublish(cwd, staticPort);
      setTimeout(() => {
        linuxWpsHost = launchLinuxWpsHost(cwd);
      }, 2500);
    }
    if (isMac) {
      writeMacDebugPublish(cwd, devPathPrefix, devAddonName, staticPort);
      macDebugPublishRegistered = true;
      macWpsHost = launchMacWpsHost(cwd);
    }
  } catch (error) {
    process.stderr.write(`[dev] 静态服务未就绪，未写入 WPS 调试注册：${error.message}\n`);
    shutdown("static 未就绪");
  }
}

registerDebugPublishWhenReady();
