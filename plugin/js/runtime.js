/**
 * WpsAiRuntime
 *
 * 解决"代理 / 静态服务默认端口被占用，自动切换后前端不知道用哪个端口"的问题。
 *
 * 前提：proxy-server.js 在 EADDRINUSE 时按 +1 自动爬端口梯子；它在 /healthz 返回
 *       { service: "lingxi-ai-proxy/v1", port, pid } 并带响应头 X-Lingxi-Service。
 *
 * 启动顺序：
 *   1. 立刻把 proxyBase 固定成 "http://127.0.0.1:3890"（同步默认值），
 *      保证模块级 const PROXY_BASE = WpsAiRuntime.proxyBase() 这种"加载时就读"的代码能拿到值。
 *   2. 启动时不扫端口、不读取旧缓存端口，避免冷启动被历史端口 / 端口轮询拖慢。
 *   3. 只有默认端口请求失败后，调用 reprobe() 才按 3890..3890+LADDER_SIZE 轮询 /healthz；
 *      命中后更新 proxyBase + 写缓存。
 *
 * 暴露：
 *   WpsAiRuntime.proxyBase()        → "http://127.0.0.1:<resolved port>"
 *   WpsAiRuntime.proxyUrl(path)     → proxyBase + path（自动处理前导 /）
 *   WpsAiRuntime.forwardPrefix()    → proxyBase + "/forward/"
 *   WpsAiRuntime.resolvedPort()     → number
 *   WpsAiRuntime.ready              → Promise<resolvedPort>，默认端口立即 ready
 */
(function attachWpsAiRuntime(global) {
  "use strict";

  const DEFAULT_PORT = 3890;
  const LADDER_SIZE = 20;
  const PROBE_TIMEOUT_MS = 600;
  const SERVICE_SIG = "lingxi-ai-proxy/v1";
  const CACHE_KEY = "lingxi_runtime_proxy_port_v1";

  function injectedProxyPort() {
    try {
      const p = Number(global.__LINGXI_PROXY_PORT__);
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch (e) {
      return null;
    }
  }

  let currentPort = injectedProxyPort() || DEFAULT_PORT;
  let probedOnce = false;
  let probeInFlight = null;

  function buildBase(port) {
    return `http://127.0.0.1:${port}`;
  }

  function hasRequiredFeature(data, options = {}) {
    const required = String(options.requireFeature || "").trim();
    if (!required) return true;
    const features = Array.isArray(data?.features) ? data.features.map((x) => String(x)) : [];
    return features.includes(required);
  }

  async function probePort(port, options = {}) {
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const resp = await fetch(`${buildBase(port)}/healthz`, {
        method: "GET",
        signal: ctrl.signal,
        cache: "no-store"
      });
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => null);
      const sig = resp.headers.get("X-Lingxi-Service") || data?.service || "";
      if (sig !== SERVICE_SIG) return null;
      if (!hasRequiredFeature(data, options)) return null;
      return data && Number.isFinite(Number(data.port)) ? Number(data.port) : port;
    } catch (e) {
      return null;
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  function cachedPort() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      const p = Number(cached?.port);
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch (e) {
      return null;
    }
  }

  function probeCandidates() {
    const ports = [currentPort, DEFAULT_PORT, cachedPort()];
    for (let i = 0; i < LADDER_SIZE; i += 1) ports.push(DEFAULT_PORT + i);
    return Array.from(new Set(ports.filter((p) => Number.isFinite(p) && p > 0)));
  }

  function commitPort(found) {
    if (found !== currentPort) {
      currentPort = found;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ port: found, ts: Date.now() })); } catch (e) {}
    }
    return currentPort;
  }

  async function probeAll(options = {}) {
    const ports = probeCandidates();
    return new Promise((resolve) => {
      let done = false;
      let settled = 0;
      const finishMiss = () => {
        settled += 1;
        if (!done && settled >= ports.length) {
          done = true;
          try { console.warn("[WpsAiRuntime] /healthz 探测失败，保持端口", currentPort, "代理服务可能未启动。"); } catch (e) {}
          probedOnce = true;
          resolve(currentPort);
        }
      };
      ports.forEach((port) => {
        probePort(port, options).then((found) => {
          if (done) return;
          if (found != null) {
            done = true;
            probedOnce = true;
            resolve(commitPort(found));
            return;
          }
          finishMiss();
        }).catch(() => {
          if (!done) finishMiss();
        });
      });
    });
  }

  const readyPromise = Promise.resolve(currentPort);

  function proxyBase() {
    return buildBase(currentPort);
  }
  function proxyUrl(p) {
    const path = String(p || "");
    if (!path) return proxyBase();
    return path.startsWith("/") ? proxyBase() + path : proxyBase() + "/" + path;
  }
  function forwardPrefix() {
    return proxyBase() + "/forward/";
  }
  function resolvedPort() {
    return currentPort;
  }
  function isProbed() {
    return probedOnce;
  }
  async function reprobe(options = {}) {
    // 用户场景：默认端口失败 / proxy 重启后用了新端口，再让 Runtime 重探一次。
    const force = !!options.force || !!options.requireFeature;
    if (force || !probeInFlight) {
      probeInFlight = probeAll(options).finally(() => {
        probeInFlight = null;
      });
    }
    return probeInFlight;
  }

  global.WpsAiRuntime = {
    proxyBase,
    proxyUrl,
    forwardPrefix,
    resolvedPort,
    isProbed,
    reprobe,
    ready: readyPromise
  };
})(window);
