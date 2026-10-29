const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Codex model listing advertises a supported client version and reads model slugs", async () => {
  let factory;
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
  const sandbox = {
    window: {
      WpsAiAuth: { refreshTokenIfNeeded: async () => `header.${payload}.signature` },
      WpsAiProviderRegistry: { register: (_type, fn) => { factory = fn; } }
    },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    escape, decodeURIComponent,
    fetch: async (url) => {
      const version = new URL(url).searchParams.get("client_version");
      const models = version === "0.164.0" ? [{ slug: "gpt-6-sol" }, { slug: "gpt-6.1-sol" }] : [];
      return { ok: true, status: 200, json: async () => ({ models }) };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/providers/codex.js"), "utf8"), sandbox);
  assert.deepEqual(Array.from(await factory({}).listModels()), ["gpt-6-sol", "gpt-6.1-sol"]);
});
