const test = require("node:test");
const assert = require("node:assert/strict");
const { applyRibbonPosition, normalizeRibbonPosition } = require("../tools/ribbon-position");

const xml = '<customUI><tab id="wpsAiTab" label="文小舟" insertBeforeMso="TabHome"><group/></tab></customUI>';

test("Ribbon position chooses a safe anchor and defaults to before Home", () => {
  assert.match(applyRibbonPosition(xml, "before-home"), /insertBeforeMso="TabHome"/);
  assert.match(applyRibbonPosition(xml, "after-home"), /insertAfterMso="TabHome"/);
  assert.doesNotMatch(applyRibbonPosition(xml, "end"), /insert(?:Before|After)Mso/);
  assert.equal(applyRibbonPosition(xml, "invalid"), xml);
  assert.equal(normalizeRibbonPosition("invalid"), "before-home");
});

test("position is shared through the local preference file across processes", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-position-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const modulePath = path.join(__dirname, "../tools/ribbon-position.js");
  const run = (code) => execFileSync(process.execPath, ["-e", code, modulePath], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8"
  }).trim();
  assert.equal(run('process.stdout.write(require(process.argv[1]).readRibbonPosition())'), "before-home");
  run('require(process.argv[1]).writeRibbonPosition("after-home")');
  assert.equal(run('process.stdout.write(require(process.argv[1]).readRibbonPosition())'), "after-home");
});
