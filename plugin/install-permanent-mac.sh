#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  文小舟 WPS 插件 - macOS 永久安装"
echo "============================================"
echo "  会一次性给三个 WPS 应用（文字/表格/演示）注册插件，"
echo "  并通过 LaunchAgent 把后台服务设为登录自启。"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[X] 未检测到 Node.js。请先安装 LTS：https://nodejs.org/zh-cn/"
  exit 1
fi
echo "[OK] Node.js: $(node -v)"

# 升级场景：先停掉可能在跑的旧服务，避免重写文件时撞 LaunchAgent KeepAlive
echo "[..] 停止可能在跑的旧服务（升级模式必需）..."
launchctl unload "$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist" 2>/dev/null || true
pkill -9 -f serve-permanent 2>/dev/null || true
pkill -9 -f proxy-server 2>/dev/null || true
sleep 1
echo "[OK] 旧服务（如有）已停止"

SRC_DIR="$(pwd)"
TARGET="$HOME/.lingxi-ai"
NODE_BIN="$(command -v node)"
LOG="$TARGET/server.log"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"

echo "[..] 源目录: $SRC_DIR"
echo "[..] 目标目录: $TARGET"
echo

# 1. 生成三宿主变体
echo "[1/5] 生成三个宿主变体..."
node tools/build-variants.js --out "$TARGET" --port 3889

# 2. 拷常驻服务脚本
echo "[2/5] 复制常驻服务脚本..."
mkdir -p "$TARGET/tools"
cp "$SRC_DIR/tools/serve-permanent.js" "$TARGET/tools/serve-permanent.js"
cp "$SRC_DIR/tools/proxy-server.js" "$TARGET/tools/proxy-server.js"
echo "[OK] 服务脚本已就位"

# 3. 写 publish.xml 注册三个宿主到两个 Container
echo "[3/5] 写入 WPS 加载项注册（两个 Container 各一份）..."
PUBLISH_XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/>
</jsplugins>
'
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  dir="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons"
  mkdir -p "$dir"
  echo "$PUBLISH_XML" > "$dir/publish.xml"
  echo "[OK] $dir/publish.xml"
done

# 4. 写 LaunchAgent plist
echo "[4/5] 注册登录自启 LaunchAgent..."
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lingxi-ai.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TARGET/tools/serve-permanent.js</string>
    <string>--root</string>
    <string>$TARGET</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
  <key>WorkingDirectory</key>
  <string>$TARGET</string>
</dict>
</plist>
EOF
echo "[OK] $LAUNCH_AGENT"

# 5. 加载 LaunchAgent（如已加载则先卸再加）
echo "[5/5] 启动后台服务..."
launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
launchctl load "$LAUNCH_AGENT"
echo "[OK] 已加载并启动"

echo
echo "============================================"
echo "  永久安装完成！"
echo "============================================"
echo "  后台服务: http://127.0.0.1:3889 / :3890"
echo "  日志: $LOG"
echo
echo "  下一步："
echo "    1. 完全退出 WPS（菜单 → 退出 WPS）"
echo "    2. 重新打开 WPS 文字 / 表格 / 演示，顶部出现「文小舟」"
echo "    3. 重启电脑后服务也会自动跑"
echo
echo "  卸载：./uninstall-permanent-mac.sh"
echo "============================================"
