// 文小舟 插件热更新
//
// 流程：
//   1. checkForUpdate() —— 走 proxy 拉 manifest（避开 OSS CORS）+ 设备 SN
//   2. 根据 SN 决定走 stable 还是 canary（灰度）通道
//   3. 比较当前版本 vs 目标通道版本（semver）
//   4. 若新版可用 → 调用方决定是否 downloadUpdate + applyUpdate
//   5. applyUpdate 让 proxy 把 plugin.zip 解压到当前插件目录覆盖文件
//   6. 提示用户重启 WPS（WebView 不能 reload JS module 已加载的代码）
//
// manifest.json 形态（OSS 上）：
// {
//   "version": "1.4.0",                                  // stable 通道版本（所有用户默认拿到）
//   "buildTime": 1735000000000,
//   "channel": "stable",
//   "pluginUrl": "https://.../wps-ai/plugin/1.4.0/plugin.zip",
//   "pluginSize": 12345678,
//   "changelog": "fix: ...\nfeat: ...",
//   "minWpsVersion": { "windows": "12.0", "mac": "5.0" },
//
//   // 灰度（可选）：snWhitelist 命中的设备拿到 canary 版本，没命中走 stable
//   "canary": {
//     "version": "1.5.0-beta.1",
//     "pluginUrl": "https://.../wps-ai/plugin/1.5.0-beta.1/plugin.zip",
//     "pluginSize": 13000000,
//     "changelog": "feat(beta): ...",
//     "snWhitelist": [
//       "00000000-0000-0000-0000-AABBCCDDEEFF",            // wmic csproduct uuid 风格
//       "ABCD-EFGH"                                        // BIOS SN 风格也可
//     ],
//     "rolloutPercent": 30                                 // （可选）白名单之外按 SN hash % 100 < 30 也开
//   }
// }
(function attachUpdater(global) {
  "use strict";

  // manifest 默认拉取地址（用户也可以在设置里覆盖到自建 mirror / 内网部署）
  const DEFAULT_MANIFEST_URL = "https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/manifest.json";
  function PROXY_BASE() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }
  // 本地缓存最近一次检查结果（避免 30 分钟内反复打 OSS）
  const LAST_CHECK_KEY = "lingxi_updater_last_check_v1";
  const DEVICE_SN_KEY = "lingxi_device_sn_v1";  // SN 本地缓存（首次从 proxy 拿到后存这）
  const CHECK_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟

  // 加时间戳查询串强制 URL 唯一，绕过 WebView2 磁盘级 HTTP 缓存。
  // 之前只带 fetch cache:"no-cache" + 服务端 no-cache header 在 WPS Windows 上仍会
  // 命中 WebView2 的资源缓存，导致 Word 更新后 Excel 打开仍读到老 package.json 里
  // 的版本号（Excel 的 plugin-et/package.json 磁盘上是新的，但 fetch 给了老数据）。
  function readCurrentVersion() {
    return new Promise((resolve) => {
      fetch(`./package.json?_ts=${Date.now()}`, { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .then((pkg) => resolve(pkg?.version || "0.0.0"))
        .catch(() => resolve("0.0.0"));
    });
  }

  // semver 比较：a > b → 正数；a == b → 0；a < b → 负数
  // 修 B34：必须考虑 prerelease。manifest 用 "1.5.0-beta.1" 这类 canary 版本号，
  // 旧实现忽略 prerelease 会让 beta.1 用户收不到 beta.2、也收不到转正的 1.5.0，永久卡死。
  function parseVer(v) {
    const s = String(v || "0").trim().replace(/^v/i, "").split("+")[0]; // 去掉 build metadata
    const dash = s.indexOf("-");
    const core = dash === -1 ? s : s.slice(0, dash);
    const pre = dash === -1 ? null : s.slice(dash + 1);
    const nums = core.split(".").map((x) => parseInt(x, 10));
    return {
      major: nums[0] || 0, minor: nums[1] || 0, patch: nums[2] || 0,
      pre: pre ? pre.split(".") : null
    };
  }
  function compareVersions(a, b) {
    const va = parseVer(a), vb = parseVer(b);
    if (va.major !== vb.major) return va.major - vb.major;
    if (va.minor !== vb.minor) return va.minor - vb.minor;
    if (va.patch !== vb.patch) return va.patch - vb.patch;
    // major.minor.patch 相等：无 prerelease 的正式版 > 有 prerelease 的预发布版
    if (!va.pre && !vb.pre) return 0;
    if (!va.pre) return 1;
    if (!vb.pre) return -1;
    // 都有 prerelease：逐段比较（纯数字按数值；数字段 < 非数字段；否则字典序）
    const n = Math.max(va.pre.length, vb.pre.length);
    for (let i = 0; i < n; i++) {
      const ai = va.pre[i], bi = vb.pre[i];
      if (ai === undefined) return -1;
      if (bi === undefined) return 1;
      const an = /^\d+$/.test(ai), bn = /^\d+$/.test(bi);
      if (an && bn) {
        const d = parseInt(ai, 10) - parseInt(bi, 10);
        if (d !== 0) return d;
      } else if (an) { return -1; }
      else if (bn) { return 1; }
      else if (ai !== bi) { return ai < bi ? -1 : 1; }
    }
    return 0;
  }

  // 拉 manifest. 走 proxy 的 /update/manifest 端点(代理转发 + 缓存 5min),
  // 直接打 OSS 也行,但 WebView 跨域可能拦.
  async function fetchManifest(manifestUrl) {
    const url = manifestUrl || DEFAULT_MANIFEST_URL;
    try {
      const resp = await fetch(`${PROXY_BASE()}/update/manifest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const json = await resp.json();
      if (!json?.ok) throw new Error(json?.error || "manifest 拉取失败");
      return json.manifest;
    } catch (e) {
      throw new Error(`无法获取版本信息: ${e?.message || e}`);
    }
  }

  // 取设备 SN（硬件级稳定标识，灰度白名单用）。
  // 流程：先查 localStorage 缓存 → 再 fetch proxy /device-sn → 缓存。
  // proxy 不可用时返回 "" 让上层走 stable 通道（fail-open）。
  // dev 模式下 proxy 跟 TaskPane 是并发启动的，TaskPane 可能比 proxy 早就绪，
  // 所以做一次 1.5s + 3s 的退避重试，避免冷启动期间错把"未就绪"当成"代理离线"。
  async function getDeviceSn(opts) {
    const allowRetry = opts?.retry !== false;
    try {
      const cached = global.WpsAiStore.getItem(DEVICE_SN_KEY);
      if (cached) {
        const j = JSON.parse(cached);
        if (j?.sn) return j.sn;
      }
    } catch (e) {}
    // 最多 3 次：立即 + 1500ms 后 + 3000ms 后
    const delays = allowRetry ? [0, 1500, 3000] : [0];
    let lastErr = null;
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      try {
        const resp = await fetch(`${PROXY_BASE()}/device-sn`, { method: "GET" });
        if (!resp.ok) { lastErr = `HTTP ${resp.status}`; continue; }
        const json = await resp.json();
        if (!json?.ok || !json.sn) { lastErr = json?.error || "empty sn"; continue; }
        try {
          global.WpsAiStore.setItem(DEVICE_SN_KEY, JSON.stringify({ sn: json.sn, source: json.source || "", ts: Date.now() }));
        } catch (e) {}
        return json.sn;
      } catch (e) {
        lastErr = e?.message || String(e);
        // fetch 直接抛 = 代理还没起来 / 端口没监听，继续重试
      }
    }
    console.warn("[updater] getDeviceSn failed after retries:", lastErr);
    return "";
  }

  // 32-bit FNV-1a hash（用于 rolloutPercent —— SN hash % 100 < N 即放行）。
  // 不需要密码学强度，只要"同 SN 总是同结果"就行。
  function snHash100(sn) {
    let h = 0x811c9dc5;
    for (let i = 0; i < sn.length; i++) {
      h ^= sn.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h % 100;
  }

  // 选择 channel：deviceSn 进 canary.snWhitelist → "canary"；
  //                进 rolloutPercent 范围 → "canary"；
  //                其它 → "stable"。
  // 返回 { channel, version, pluginUrl, pluginSize, changelog }（已合并到顶层易用形态）
  function pickChannelTarget(manifest, deviceSn) {
    const canary = manifest?.canary;
    const stable = {
      channel: "stable",
      version: manifest?.version || "0.0.0",
      pluginUrl: manifest?.pluginUrl,
      pluginSize: manifest?.pluginSize,
      changelog: manifest?.changelog || ""
    };
    if (!canary || !canary.version || !canary.pluginUrl) return stable;
    const wl = Array.isArray(canary.snWhitelist) ? canary.snWhitelist : [];
    // 大小写不敏感 + 去空白匹配
    const norm = (s) => String(s || "").trim().toLowerCase();
    const sn = norm(deviceSn);
    const inWhitelist = !!sn && wl.some((entry) => norm(entry) === sn);
    let inRollout = false;
    if (!inWhitelist && typeof canary.rolloutPercent === "number" && canary.rolloutPercent > 0 && sn) {
      inRollout = snHash100(sn) < Math.min(100, canary.rolloutPercent);
    }
    if (!inWhitelist && !inRollout) return stable;
    return {
      channel: "canary",
      canaryReason: inWhitelist ? "whitelist" : "rollout",
      version: canary.version,
      pluginUrl: canary.pluginUrl,
      pluginSize: canary.pluginSize,
      changelog: canary.changelog || ""
    };
  }

  async function checkForUpdate(opts) {
    const manifestUrl = opts?.manifestUrl;
    const force = !!opts?.force;
    // 关键：先读当前版本再判缓存。4 个宿主（wps/et/wpp/pdf）在 127.0.0.1:3889 共
    // 用 origin → 共用 localStorage → 如果直接吃缓存，会拿到别的宿主上下文里保存
    // 的 current，Word 里看到的 current 会被 Excel 复用出来（bug：Excel 显示的
    // 是 Word 的版本号）。所以必须先读自己的 current，再校验缓存里的 current 一
    // 致才用缓存；不一致或过期就重刷。
    const current = await readCurrentVersion();
    if (!force) {
      try {
        const cached = JSON.parse(global.WpsAiStore.getItem(LAST_CHECK_KEY) || "null");
        if (cached && Date.now() - cached.ts < CHECK_COOLDOWN_MS && cached.result?.current === current) {
          return cached.result;
        }
      } catch (e) {}
    }
    // 并行拉 manifest + 取 deviceSn（互相独立，不需要串行）
    const [manifest, deviceSn] = await Promise.all([
      fetchManifest(manifestUrl),
      getDeviceSn()
    ]);
    const target = pickChannelTarget(manifest, deviceSn);
    const latest = target.version || "0.0.0";
    const diff = compareVersions(latest, current);
    // 关键：为了让 downloadAndApply 拿到正确的 url/size/version，把 target 字段覆盖
    // 到一个 effective manifest 对象上（保留原 manifest 其它元数据如 buildTime / minWpsVersion）。
    const effectiveManifest = Object.assign({}, manifest, {
      version: target.version,
      pluginUrl: target.pluginUrl,
      pluginSize: target.pluginSize,
      changelog: target.changelog || manifest?.changelog || ""
    });
    const result = {
      current,
      latest,
      updateAvailable: diff > 0,
      checkedAt: Date.now(),
      channel: target.channel,
      canaryReason: target.canaryReason || null,
      deviceSn,
      manifest: effectiveManifest,
      // 原始 manifest 也带上（用户面板想看全量信息）
      rawManifest: manifest
    };
    try {
      global.WpsAiStore.setItem(LAST_CHECK_KEY, JSON.stringify({ ts: Date.now(), result }));
    } catch (e) {}
    return result;
  }

  // 下载 + 解压更新。返回 { ok, restartRequired, message } 让 UI 提示用户重启 WPS。
  async function downloadAndApply(manifest, onProgress) {
    if (!manifest?.pluginUrl) throw new Error("manifest 缺 pluginUrl");
    if (typeof onProgress === "function") onProgress({ step: "download", percent: 0 });
    // 1) proxy 下载 plugin.zip
    let downloadResp;
    try {
      downloadResp = await fetch(`${PROXY_BASE()}/update/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: manifest.pluginUrl, expectedSize: manifest.pluginSize || null })
      });
    } catch (e) {
      throw new Error(`下载失败：${e?.message || e}`);
    }
    if (!downloadResp.ok) {
      const text = await downloadResp.text().catch(() => "");
      throw new Error(`下载失败 ${downloadResp.status}: ${text.slice(0, 200)}`);
    }
    const dl = await downloadResp.json();
    if (!dl?.ok || !dl?.zipPath) throw new Error(dl?.error || "下载未返回 zipPath");
    if (typeof onProgress === "function") onProgress({ step: "extract", percent: 50 });

    // 2) proxy 解压覆盖 plugin 目录
    const applyResp = await fetch(`${PROXY_BASE()}/update/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zipPath: dl.zipPath })
    });
    const ap = await applyResp.json().catch(() => ({}));
    if (!applyResp.ok || !ap?.ok) {
      throw new Error(ap?.error || `apply 失败 ${applyResp.status}`);
    }
    // 应用成功后清缓存：避免下次 30 分钟内检查还是拿到旧的 {current, latest}，
    // 也让 4 个宿主共用的 localStorage 不再吐旧上下文
    try { global.WpsAiStore.removeItem(LAST_CHECK_KEY); } catch (e) {}
    if (typeof onProgress === "function") onProgress({ step: "done", percent: 100 });
    return {
      ok: true,
      restartRequired: true,
      message: ap?.message || "更新已安装，请重启 WPS 让新版本生效。",
      filesReplaced: ap?.filesReplaced || 0
    };
  }

  function getLastCheck() {
    try {
      return JSON.parse(global.WpsAiStore.getItem(LAST_CHECK_KEY) || "null");
    } catch (e) { return null; }
  }

  function clearCache() {
    try { global.WpsAiStore.removeItem(LAST_CHECK_KEY); } catch (e) {}
  }

  global.WpsAiUpdater = {
    readCurrentVersion,
    checkForUpdate,
    downloadAndApply,
    compareVersions,
    getLastCheck,
    clearCache,
    getDeviceSn,
    pickChannelTarget,
    snHash100,
    DEFAULT_MANIFEST_URL,
    CHECK_COOLDOWN_MS
  };
})(window);
