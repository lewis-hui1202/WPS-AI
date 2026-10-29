#!/usr/bin/env bash
# 文小舟 macOS 打包脚本: 产出 dist/lingxi-ai-<version>-mac.dmg
#
# 流程:
#   1. 把 plugin/ 源码 + Mac x64/arm64 内置 Node 运行时收集到 staging/
#   2. pkgbuild  → 组件包 lingxi-ai-component.pkg(含 preinstall/postinstall)
#   3. productbuild → 安装向导 lingxi-ai-installer.pkg(套 distribution.xml + welcome/conclusion)
#   4. hdiutil create → dmg
#   5. (可选)签名: 命令行加 --sign "Developer ID Installer: 你" + 公证 notarytool
#
# 必须在 macOS 上跑(pkgbuild / productbuild / hdiutil 是 mac 自带)。
#
# 用法:
#   cd installer-mac
#   bash build-dmg.sh
#   bash build-dmg.sh --sign "Developer ID Installer: Your Name (TEAMID)"
#   bash build-dmg.sh --version 1.3.0
#
# 输出: dist/lingxi-ai-<version>-mac.dmg
#       dist/lingxi-ai-<version>.pkg   (单独 pkg,部署到 MDM 时用)

set -euo pipefail

# ---- 参数 ----
SIGN_ID=""
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sign)    SIGN_ID="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | sed '$d'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ---- 路径 ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugin"
DIST_DIR="$ROOT_DIR/dist"
STAGING="$SCRIPT_DIR/build/staging"
SCRIPTS_DIR="$SCRIPT_DIR/scripts"
RESOURCES_DIR="$SCRIPT_DIR/resources"
WORK_DIR="$SCRIPT_DIR/build"

PKG_ID="com.lingxi-ai.installer"
# pkg payload 有两个目标,staging 直接按真实路径布局,pkgbuild --install-location 用 /
LIB_DIR_REL="Library/Application Support/LingxiAI"
APP_NAME="文小舟 卸载.app"

# 从 plugin/package.json 拿 version
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$PLUGIN_DIR/package.json').version" 2>/dev/null || echo "0.0.0")"
fi

echo "============================================="
echo "  文小舟 macOS Installer Build"
echo "============================================="
echo "  Version:          $VERSION"
echo "  Sign ID:          ${SIGN_ID:-<unsigned>}"
echo "  Install paths:    /$LIB_DIR_REL/"
echo "                    /Applications/$APP_NAME"
echo "  Output:           $DIST_DIR/lingxi-ai-$VERSION-mac.dmg"
echo "============================================="

# ---- 0. 平台检查 ----
if [ "$(uname)" != "Darwin" ]; then
  echo "[X] 这个脚本必须在 macOS 上跑(需要 pkgbuild / productbuild / hdiutil)"
  exit 1
fi

# ---- 1. 准备 Node 运行时(x64 + arm64 都要) ----
echo
echo "[1/5] 准备内置 Node 运行时(darwin-x64 + darwin-arm64)..."
NODE_X64="$PLUGIN_DIR/runtime/node-darwin-x64/bin/node"
NODE_ARM64="$PLUGIN_DIR/runtime/node-darwin-arm64/bin/node"
echo "  检查并裁剪 darwin-x64 + darwin-arm64..."
(cd "$PLUGIN_DIR" && node tools/bundle-node.js --platform darwin-x64 --platform darwin-arm64)
if [ ! -x "$NODE_X64" ] || [ ! -x "$NODE_ARM64" ]; then
  echo "[X] bundle-node 后还是没找到 Mac node 二进制,看上面的下载错误"
  exit 1
fi
echo "  [OK] x64:   $($NODE_X64 --version)"
echo "  [OK] arm64: $($NODE_ARM64 --version 2>/dev/null || echo '<不能在当前架构上 exec,跳过版本检查>')"

# ---- 2. Staging: 把要进 pkg payload 的文件拷到一个干净目录 ----
echo
echo "[2/5] 准备 staging 目录..."
rm -rf "$WORK_DIR"
LIB_STAGING="$STAGING/$LIB_DIR_REL"
APP_STAGING="$STAGING/Applications/$APP_NAME"
mkdir -p "$LIB_STAGING/plugin"
mkdir -p "$STAGING/Applications"

# 拷 plugin/,排除 node_modules / dist / .DS_Store / 启动脚本(变体也用不上)
rsync -a \
  --exclude='node_modules' \
  --exclude='dist*' \
  --exclude='test' \
  --exclude='wps-addon-build' \
  --exclude='wps-addon-publish' \
  --exclude='.DS_Store' \
  --exclude='__MACOSX' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='install-windows.bat' \
  --exclude='install-permanent-windows.bat' \
  --exclude='uninstall-permanent-windows.bat' \
  --exclude='start-*.bat' \
  --exclude='runtime/node-win-x64' \
  --exclude='runtime/node-linux-x64' \
  --exclude='runtime/node-linux-arm64' \
  "$PLUGIN_DIR/" "$LIB_STAGING/plugin/"

# 拷 README / INSTALL
cp "$ROOT_DIR/README.md"  "$LIB_STAGING/" 2>/dev/null || true
cp "$ROOT_DIR/INSTALL.md" "$LIB_STAGING/" 2>/dev/null || true

chmod +x "$LIB_STAGING/plugin/tools/"*.sh 2>/dev/null || true

# 编卸载工具 .app: osacompile 把 .applescript 编成完整 .app bundle
echo "  osacompile 卸载工具.app..."
osacompile -o "$APP_STAGING" "$SCRIPT_DIR/uninstaller.applescript"
# 把 uninstall-all.sh 塞进 .app 的 Resources(AppleScript 内通过相对路径调它)
cp "$SCRIPT_DIR/uninstall-all.sh" "$APP_STAGING/Contents/Resources/uninstall-all.sh"
chmod +x "$APP_STAGING/Contents/Resources/uninstall-all.sh"

STAGING_SIZE=$(du -sh "$STAGING" | awk '{print $1}')
echo "  Staging 大小: $STAGING_SIZE"

# ---- 3. pkgbuild: 把 staging/ 打成组件包 ----
echo
echo "[3/5] pkgbuild 组件包..."
COMPONENT_PKG="$WORK_DIR/lingxi-ai-component.pkg"

chmod +x "$SCRIPTS_DIR/preinstall" "$SCRIPTS_DIR/postinstall"

# 不传 --install-location,默认 /,staging 内部按真实绝对路径布局
pkgbuild \
  --root "$STAGING" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  "$COMPONENT_PKG"
echo "  [OK] $COMPONENT_PKG"

# ---- 4. productbuild: 套 distribution.xml 生成最终安装向导 ----
echo
echo "[4/5] productbuild 安装向导..."
PRODUCT_PKG="$DIST_DIR/lingxi-ai-$VERSION.pkg"
mkdir -p "$DIST_DIR"

PRODUCTBUILD_ARGS=(
  --distribution "$SCRIPT_DIR/distribution.xml"
  --resources    "$RESOURCES_DIR"
  --package-path "$WORK_DIR"
  "$PRODUCT_PKG"
)
if [ -n "$SIGN_ID" ]; then
  PRODUCTBUILD_ARGS=(--sign "$SIGN_ID" "${PRODUCTBUILD_ARGS[@]}")
fi
productbuild "${PRODUCTBUILD_ARGS[@]}"
echo "  [OK] $PRODUCT_PKG"

# ---- 5. hdiutil: 套个 dmg ----
echo
echo "[5/5] hdiutil dmg..."
DMG_PATH="$DIST_DIR/lingxi-ai-$VERSION-mac.dmg"
DMG_STAGING="$WORK_DIR/dmg"
rm -rf "$DMG_STAGING"
mkdir -p "$DMG_STAGING"

cp "$PRODUCT_PKG" "$DMG_STAGING/文小舟 安装器.pkg"

# 加一个 README 说明(用户打开 dmg 看到的)
cat > "$DMG_STAGING/请先阅读.txt" <<EOF
文小舟 WPS 插件 v$VERSION

安装步骤:
  1. 双击「文小舟 安装器.pkg」,按向导一路下一步
  2. 完全退出 WPS(菜单 → 退出 WPS)
  3. 重新打开 WPS,顶部出现「文小舟」标签页

卸载(一键):
  Spotlight 搜「文小舟 卸载」,或在「应用程序」里双击「文小舟 卸载.app」

文档:
  https://github.com/lewis-hui1202/WPS-AI

注意(未签名版本):
  首次打开 .pkg 会被 Gatekeeper 拦下,提示「无法打开,因为来自身份不明的开发者」。
  右键 .pkg → 打开 → 弹窗里再点「打开」即可。
EOF

# 删掉旧 dmg(hdiutil 不会自动覆盖)
rm -f "$DMG_PATH"

hdiutil create \
  -volname "文小舟 $VERSION" \
  -srcfolder "$DMG_STAGING" \
  -ov \
  -format UDZO \
  -fs HFS+ \
  "$DMG_PATH"

DMG_SIZE=$(du -sh "$DMG_PATH" | awk '{print $1}')
echo "  [OK] $DMG_PATH ($DMG_SIZE)"

# 如果传了签名 ID,签 dmg 本身(productbuild 已签 pkg)
if [ -n "$SIGN_ID" ]; then
  # dmg 的签名要用 codesign(Developer ID Application),不是 Installer
  # 这里只是提示,因为传进来的多半是 Installer 证书。请在 CI 里用对应证书做 codesign + notarytool。
  echo
  echo "[i] pkg 已用 '$SIGN_ID' 签好。"
  echo "    dmg 本身需要用 Developer ID Application 证书 codesign --sign,"
  echo "    再 xcrun notarytool submit 公证 + xcrun stapler staple。"
fi

# 清理 staging(保留 dist/)
rm -rf "$WORK_DIR"

echo
echo "============================================="
echo "  打包完成 🎉"
echo "============================================="
echo "  dmg: $DMG_PATH"
echo "  pkg: $PRODUCT_PKG"
echo
echo "  本地测试:"
echo "    open '$DMG_PATH'"
echo "    # 在弹出的 Finder 里右键 pkg → 打开"
echo "============================================="
