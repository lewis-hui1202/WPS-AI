const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const runtimeJs = fs.readFileSync(path.join(__dirname, "../js/runtime.js"), "utf8");

function makeHealthResponse(port, extras = {}) {
  return {
    ok: true,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-lingxi-service" ? "lingxi-ai-proxy/v1" : "";
      }
    },
    async json() {
      return { ok: true, service: "lingxi-ai-proxy/v1", port, ...extras };
    }
  };
}

test("runtime 启动不扫描端口，默认使用 3890", () => {
  const requestedPorts = [];
  const context = {
    window: {},
    localStorage: {
      getItem() { return JSON.stringify({ port: 3999 }); },
      setItem() {}
    },
    fetch(url) {
      requestedPorts.push(Number(new URL(url).port));
      return new Promise(() => {});
    },
    AbortController,
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    console
  };
  context.window = context;

  vm.runInNewContext(runtimeJs, context);

  assert.deepEqual(requestedPorts, []);
  assert.equal(context.WpsAiRuntime.proxyBase(), "http://127.0.0.1:3890");
  assert.equal(context.WpsAiRuntime.resolvedPort(), 3890);
});

test("runtime 启动时优先使用 dev 页面注入的代理端口", () => {
  const requestedPorts = [];
  const context = {
    window: {},
    localStorage: {
      getItem() { return JSON.stringify({ port: 3999 }); },
      setItem() {}
    },
    fetch(url) {
      requestedPorts.push(Number(new URL(url).port));
      return new Promise(() => {});
    },
    AbortController,
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    console
  };
  context.window = context;
  context.__LINGXI_PROXY_PORT__ = 3892;

  vm.runInNewContext(runtimeJs, context);

  assert.deepEqual(requestedPorts, []);
  assert.equal(context.WpsAiRuntime.proxyBase(), "http://127.0.0.1:3892");
  assert.equal(context.WpsAiRuntime.resolvedPort(), 3892);
});

test("runtime 只有 reprobe 时才轮询端口并切到可用端口", async () => {
  const requestedPorts = [];
  const stored = [];
  const context = {
    window: {},
    localStorage: {
      getItem() { return JSON.stringify({ port: 3999 }); },
      setItem(key, value) { stored.push({ key, value }); }
    },
    fetch(url) {
      const port = Number(new URL(url).port);
      requestedPorts.push(port);
      if (port === 3892) return Promise.resolve(makeHealthResponse(3892));
      return Promise.resolve({
        ok: false,
        headers: { get() { return ""; } },
        async json() { return {}; }
      });
    },
    AbortController,
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    console
  };
  context.window = context;

  vm.runInNewContext(runtimeJs, context);

  assert.deepEqual(requestedPorts, []);

  const port = await context.WpsAiRuntime.reprobe();

  assert.equal(port, 3892);
  assert.equal(context.WpsAiRuntime.proxyBase(), "http://127.0.0.1:3892");
  assert.ok(requestedPorts.includes(3890), `should try default port, got ${requestedPorts.join(",")}`);
  assert.ok(requestedPorts.includes(3892), `should probe fallback ports, got ${requestedPorts.join(",")}`);
  assert.ok(stored.some((entry) => entry.key === "lingxi_runtime_proxy_port_v1" && /3892/.test(entry.value)));
});

test("runtime 在跨域响应未暴露标识头时，通过响应内容找到代理", async () => {
  const context = {
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch(url) {
      const port = Number(new URL(url).port);
      return Promise.resolve({
        ok: true,
        headers: { get() { return null; } },
        async json() {
          return port === 3891
            ? { ok: true, service: "lingxi-ai-proxy/v1", port: 3891 }
            : { ok: true, service: "lingxi-ai-static/v1", port };
        }
      });
    },
    AbortController, setTimeout, clearTimeout, Date, console
  };
  context.window = context;
  vm.runInNewContext(runtimeJs, context);
  assert.equal(await context.WpsAiRuntime.reprobe(), 3891);
  assert.equal(context.WpsAiRuntime.proxyBase(), "http://127.0.0.1:3891");
});

test("runtime 能按能力要求跳过旧代理端口", async () => {
  const requestedPorts = [];
  const context = {
    window: {},
    localStorage: {
      getItem() { return null; },
      setItem() {}
    },
    fetch(url) {
      const port = Number(new URL(url).port);
      requestedPorts.push(port);
      if (port === 3890) return Promise.resolve(makeHealthResponse(3890, { features: [] }));
      if (port === 3891) return Promise.resolve(makeHealthResponse(3891, { features: ["active-pdf-path"] }));
      return Promise.resolve({
        ok: false,
        headers: { get() { return ""; } },
        async json() { return {}; }
      });
    },
    AbortController,
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    console
  };
  context.window = context;

  vm.runInNewContext(runtimeJs, context);

  const port = await context.WpsAiRuntime.reprobe({ requireFeature: "active-pdf-path", force: true });

  assert.equal(port, 3891);
  assert.equal(context.WpsAiRuntime.proxyBase(), "http://127.0.0.1:3891");
  assert.deepEqual(requestedPorts.slice(0, 2), [3890, 3891]);
});
