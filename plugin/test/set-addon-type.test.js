const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptPath = path.resolve(__dirname, "../tools/set-addon-type.js");

test("set-addon-type updates package.json and manifest.json addonType", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-addon-type-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "lingxi-ai",
    addonType: "pdf",
    version: "1.4.4"
  }, null, 2));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    name: "文小舟",
    addonType: "pdf",
    version: "1.4.4",
    ribbon: "ribbon.xml"
  }, null, 2));

  const result = spawnSync(process.execPath, [scriptPath, "wps"], {
    cwd: dir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).addonType, "wps");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).addonType, "wps");
});
