const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const source = fs.readFileSync(path.join(__dirname, "../tools/post-install-windows.bat"), "utf8");
const nodeBlock = source.slice(source.indexOf('set "NODE_EXE='), source.indexOf('echo [post-install] 使用 Node:'));

test("Node fallback message quotes the expanded path inside the batch block", () => {
  const message = nodeBlock.split(/\r?\n/).find((line) => line.includes("[WARN]") && line.includes("%NODE_EXE%"));
  assert.ok(message, "missing fallback message");
  assert.match(message, /"%NODE_EXE%"/);
});

test("Windows cmd parses both Node branches under an (x86) install path", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi (x86) "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const batch = path.join(root, "test.bat");
  fs.writeFileSync(batch, `@echo off\r\nsetlocal\r\nset "INSTALL_DIR=${root}"\r\n${nodeBlock}\r\necho BRANCH_OK\r\nexit /b 0\r\n`);
  const run = () => spawnSync("cmd.exe", ["/d", "/c", batch], {
    encoding: "utf8", env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH }
  });
  let result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /BRANCH_OK/);
  const exe = path.join(root, "plugin", "runtime", "node-win-x64", "node.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "");
  result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /BRANCH_OK/);
});
