const fs = require("fs");
const os = require("os");
const path = require("path");

const positionFile = path.join(os.homedir(), ".lingxi-ai", "ribbon-position.txt");
function normalizeRibbonPosition(value) {
  return ["before-home", "after-home", "end"].includes(value) ? value : "before-home";
}
function readRibbonPosition() {
  try { return normalizeRibbonPosition(fs.readFileSync(positionFile, "utf8").trim()); }
  catch (e) { return "before-home"; }
}
function writeRibbonPosition(value) {
  const position = normalizeRibbonPosition(value);
  fs.mkdirSync(path.dirname(positionFile), { recursive: true });
  fs.writeFileSync(positionFile, position, "utf8");
  return position;
}
function applyRibbonPosition(xml, value) {
  const position = normalizeRibbonPosition(value);
  return xml.replace(/<tab\b[^>]*\bid="wpsAiTab"[^>]*>/, (tag) => {
    const clean = tag.replace(/\s+insert(?:Before|After)Mso="[^"]*"/g, "");
    const anchor = position === "end" ? "" : ` insert${position === "after-home" ? "After" : "Before"}Mso="TabHome"`;
    return clean.replace(/>$/, `${anchor}>`);
  });
}
module.exports = { normalizeRibbonPosition, readRibbonPosition, writeRibbonPosition, applyRibbonPosition };
