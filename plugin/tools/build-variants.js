#!/usr/bin/env node
/**
 * 把 plugin/ 源目录复制成四份宿主变体：plugin-wps / plugin-et / plugin-wpp / plugin-pdf。
 * 每份的差异：
 *   - manifest.json 的 addonType
 *   - ribbon.xml（gen-ribbon.js 已经按 addonType 生成宿主特有快捷按钮）
 *
 * 输出目录由 --out 指定，默认 dist-permanent/。每次会清空目标目录再写。
 *
 * 用法：
 *   node tools/build-variants.js                       # 输出到 ../dist-permanent
 *   node tools/build-variants.js --out C:/foo/bar     # 自定义输出根目录
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HOSTS = ["wps", "et", "wpp", "pdf"];

function parseArgs() {
  const args = process.argv.slice(2);
  let out = path.resolve(ROOT, "..", "dist-permanent");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out" && args[i + 1]) {
      out = path.resolve(args[i + 1]);
      i += 1;
    }
  }
  return { out };
}

// 排除项：源目录里不进打包的内容
const SKIP = new Set([
  "node_modules", "dist", "dist-permanent",
  ".git", ".DS_Store", "__MACOSX",
  // 内置 node 运行时只在 INSTALL_DIR/plugin 那一份就够,变体里不复制(否则 ~150MB×3)
  "runtime",
  // 安装/启动脚本本身不进变体目录（变体只装插件文件）
  "install-windows.bat", "install-mac.sh",
  "install-permanent-windows.bat", "install-permanent-mac.sh",
  "uninstall-permanent-windows.bat", "uninstall-permanent-mac.sh",
  "start-wps.bat", "start-et.bat", "start-wpp.bat", "start-pdf.bat",
  "start-wps.sh", "start-et.sh", "start-wpp.sh", "start-pdf.sh"
]);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  // Windows 上 WPS 进程退出后文件句柄释放有延迟（尤其插件目录），加重试 + 退避
  const maxAttempts = 6;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch (e) {
      if (e.code !== "EBUSY" && e.code !== "EPERM" && e.code !== "ENOTEMPTY") throw e;
      if (i === maxAttempts - 1) {
        const hint = process.platform === "win32"
          ? "\n  → 大概率 WPS / WebView2 还在用这些文件。请完全退出 WPS（任务栏右下角图标右键退出）后重试。"
          : "";
        throw new Error(`无法删除 ${p}（${e.code}）。${hint}`);
      }
      const delay = 500 * (i + 1);
      console.warn(`[build-variants] rmrf 失败（${e.code}），${delay}ms 后第 ${i + 2} 次重试...`);
      const wait = Date.now() + delay;
      while (Date.now() < wait) { /* busy wait, sync 上下文里没法 await */ }
    }
  }
}

function main() {
  const { out } = parseArgs();

  // 先生成一份 ribbon.xml 作 baseline，避免循环里相互覆盖
  const originalAddonType = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).addonType;

  // 不再 rmrf 整个 out（~/.lingxi-ai 可能被运行中的进程 CWD 锁住）。
  // 只确保 out 存在，并对每个变体目录单独 rmrf——这样仅有的需要清的是
  // 变体里的旧 plugin 文件，tools/ 和 server.log 等保留。
  fs.mkdirSync(out, { recursive: true });

  for (const host of HOSTS) {
    const dst = path.join(out, `plugin-${host}`);
    console.log(`[build-variants] ${host} → ${dst}`);

    // 1) 在源目录切到该 host，重新生成 ribbon.xml
    execFileSync(process.execPath, [path.join("tools", "set-addon-type.js"), host], { cwd: ROOT, stdio: "inherit" });
    execFileSync(process.execPath, [path.join("tools", "gen-ribbon.js")], { cwd: ROOT, stdio: "inherit" });

    // 2) 删旧变体目录后整体复制
    rmrf(dst);
    copyTree(ROOT, dst);

    // 3) 修正变体里的 manifest.json：addonType = host
    const manifestPath = path.join(dst, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.addonType = host;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const legacyManifestPath = path.join(dst, "manifest.xml");
    if (fs.existsSync(legacyManifestPath)) {
      const name = manifest.name || "文小舟";
      const description = manifest.description || "文小舟 WPS 加载项";
      fs.writeFileSync(legacyManifestPath, `<?xml version="1.0" encoding="UTF-8"?>
<JsPlugin>
  <ApiVersion>1.0.0</ApiVersion>
  <Name>${name}</Name>
  <Description>${description}</Description>
</JsPlugin>
`, "utf8");
    }
  }

  // 还原原始 addonType + 重建对应 ribbon
  if (originalAddonType && HOSTS.includes(originalAddonType)) {
    execFileSync(process.execPath, [path.join("tools", "set-addon-type.js"), originalAddonType], { cwd: ROOT, stdio: "inherit" });
    execFileSync(process.execPath, [path.join("tools", "gen-ribbon.js")], { cwd: ROOT, stdio: "inherit" });
  }

  console.log(`\n[build-variants] 完成，${HOSTS.length} 份宿主变体输出到：${out}`);
}

main();
