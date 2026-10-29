#!/usr/bin/env bash
# 文小舟 macOS 安装后脚本(用户上下文)
#
# 由 installer-mac/scripts/postinstall (root 上下文) 通过 sudo -u 调起。
# 也可以直接手跑做调试: bash post-install-mac.sh <INSTALL_DIR>
#
# 工作:
#   1. 挑合适架构的内置 Node
#   2. 生成 plugin-wps/-et/-wpp/-pdf 四份宿主变体到 ~/.lingxi-ai/
#   3. 拷服务脚本
#   4. 写 publish.xml 到两个 WPS Container
#   5. 写 LaunchAgent plist 并 launchctl bootstrap 进 gui domain
#   6. 探活端口
#
# 所有输出走日志: ~/.lingxi-ai/install.log

set -u

INSTALL_DIR="${1:-}"
if [ -z "$INSTALL_DIR" ]; then
  # 兜底:脚本如果被直接拷到 ~/.lingxi-ai/ 调用,自身找不到 plugin/runtime
  INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi

# 修 T7：空 $HOME 会让所有 "$HOME/..." 落到根级。空 HOME / 根家目录直接退出。
if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  echo "[post-install] [ERROR] \$HOME 为空或为根，无法安全定位用户目录，已中止。" >&2
  exit 1
fi

TARGET="$HOME/.lingxi-ai"
mkdir -p "$TARGET"
LOG="$TARGET/install.log"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2; }

{
echo
echo "==================================================="
echo " post-install-mac 启动 $(date '+%F %T')"
echo " INSTALL_DIR=$INSTALL_DIR"
echo " TARGET=$TARGET"
echo " HOME=$HOME USER=$USER UID=$(id -u)"
echo "==================================================="
} >>"$LOG" 2>&1

# ---- 1. 挑 Node ----
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  NODE_DIR="$INSTALL_DIR/plugin/runtime/node-darwin-arm64" ;;
  x86_64) NODE_DIR="$INSTALL_DIR/plugin/runtime/node-darwin-x64"   ;;
  *)
    log "[X] 不支持的架构: $ARCH"
    exit 1
    ;;
esac
NODE_BIN="$NODE_DIR/bin/node"

if [ ! -x "$NODE_BIN" ]; then
  log "[WARN] 内置 Node 不在 $NODE_BIN,退到 PATH 上的 node"
  if ! command -v node >/dev/null 2>&1; then
    log "[X] 没找到 Node。请装 LTS: https://nodejs.org/zh-cn/"
    exit 1
  fi
  NODE_BIN="$(command -v node)"
fi
log "[post-install] 使用 Node: $NODE_BIN ($("$NODE_BIN" --version))"

# ---- 2. 停老服务(升级场景) ----
log "[post-install] 停老服务..."
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist" >>"$LOG" 2>&1 || true
launchctl unload "$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist" >>"$LOG" 2>&1 || true
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server   >>"$LOG" 2>&1 || true
pkill -9 -f service-watchdog.sh >>"$LOG" 2>&1 || true
sleep 1

# ---- 2b. 清理覆盖安装遗留的开发依赖/构建产物 ----
log "[post-install] 清理旧安装目录冗余文件..."
PLUGIN_DIR="$INSTALL_DIR/plugin"
if [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR/node_modules" "$PLUGIN_DIR/dist" "$PLUGIN_DIR/dist-permanent" "$PLUGIN_DIR/test" "$PLUGIN_DIR/.git" \
    "$PLUGIN_DIR/wps-addon-build" "$PLUGIN_DIR/wps-addon-publish" \
    "$PLUGIN_DIR/runtime/node-win-x64" "$PLUGIN_DIR/runtime/node-linux-x64" "$PLUGIN_DIR/runtime/node-linux-arm64"
  case "$ARCH" in
    arm64)  rm -rf "$PLUGIN_DIR/runtime/node-darwin-x64" ;;
    x86_64) rm -rf "$PLUGIN_DIR/runtime/node-darwin-arm64" ;;
  esac
  find "$PLUGIN_DIR" -maxdepth 1 -type f -name '*.log' -delete 2>/dev/null || true
  find "$PLUGIN_DIR/runtime" -type f \( -name '*.zip' -o -name '*.tar.gz' -o -name '*.tar.xz' \) -delete 2>/dev/null || true
fi

# ---- 3. 生成三份宿主变体 ----
# NOTE: build-variants.js 生成过程中会原地修改源目录的 package.json（set-addon-type.js），
#       但 postinstall drop 权限后普通用户无法写 /Library/...，会报 EACCES。
#       解决方案：先把整个 plugin/ 复制到用户可写的临时目录，在副本上跑，完成后清理。
log "[post-install] 生成三份宿主变体到 $TARGET..."
PLUGIN_TMP="$TARGET/.plugin-build-tmp"
rm -rf "$PLUGIN_TMP"
cp -R "$INSTALL_DIR/plugin" "$PLUGIN_TMP"

(cd "$PLUGIN_TMP" && "$NODE_BIN" tools/build-variants.js --out "$TARGET") >>"$LOG" 2>&1
BUILD_RC=$?
rm -rf "$PLUGIN_TMP"   # 无论成败都清临时目录

if [ $BUILD_RC -ne 0 ]; then
  log "[X] 生成宿主变体失败,详见 $LOG"
  exit 1
fi

# ---- 4. 拷服务脚本 ----
mkdir -p "$TARGET/tools"
cp "$INSTALL_DIR/plugin/tools/serve-permanent.js" "$TARGET/tools/serve-permanent.js"
cp "$INSTALL_DIR/plugin/tools/ribbon-position.js" "$TARGET/tools/ribbon-position.js"
cp "$INSTALL_DIR/plugin/tools/proxy-server.js"   "$TARGET/tools/proxy-server.js"
cp "$INSTALL_DIR/plugin/tools/mcp-server.js"     "$TARGET/tools/mcp-server.js"
cp "$INSTALL_DIR/plugin/tools/zip-extract.js"    "$TARGET/tools/zip-extract.js"
cp "$INSTALL_DIR/plugin/tools/pick-node.js"      "$TARGET/tools/pick-node.js"
cp "$INSTALL_DIR/plugin/tools/service-watchdog.sh" "$TARGET/tools/service-watchdog.sh"
chmod +x "$TARGET/tools/service-watchdog.sh"
log "[post-install] 服务脚本已就位"

# ---- 5. 写 publish.xml ----
PUBLISH_XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/>
</jsplugins>'
# 修 T3：publish.xml 是 WPS 共享清单，合并写入（保留别家插件），只增删自己的 4 条。
LINGXI_ENTRIES='  <jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/>'
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  dir="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons"
  mkdir -p "$dir"
  pub="$dir/publish.xml"
  others=""
  [ -f "$pub" ] && others="$(grep -i jspluginonline "$pub" 2>/dev/null | grep -vi lingxi-ai || true)"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    printf '%s\n' '<jsplugins>'
    [ -n "$others" ] && printf '%s\n' "$others"
    printf '%s\n' "$LINGXI_ENTRIES"
    printf '%s\n' '</jsplugins>'
  } > "$pub"
  log "[post-install] 写: $pub"
done

# ---- 6. 写 LaunchAgent plist ----
mkdir -p "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lingxi-ai.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TARGET/tools/service-watchdog.sh</string>
    <string>--node</string>
    <string>$NODE_BIN</string>
    <string>--script</string>
    <string>$TARGET/tools/serve-permanent.js</string>
    <string>--root</string>
    <string>$TARGET</string>
    <string>--log</string>
    <string>$TARGET/server.log</string>
    <string>--static-port</string>
    <string>3889</string>
    <string>--proxy-port</string>
    <string>3890</string>
    <string>--idle-seconds</string>
    <string>30</string>
    <string>--start-now</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LINGXI_STATIC_PORT</key>
    <string>3889</string>
    <key>PROXY_PORT</key>
    <string>3890</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$TARGET/server.log</string>
  <key>StandardErrorPath</key>
  <string>$TARGET/server.log</string>
  <key>WorkingDirectory</key>
  <string>$TARGET</string>
</dict>
</plist>
EOF
log "[post-install] LaunchAgent: $PLIST"

# ---- 7. 拉服务 ----
# 优先用 bootstrap(新 launchctl 写法,Mojave+);失败退到 load
if launchctl bootstrap "gui/$(id -u)" "$PLIST" >>"$LOG" 2>&1; then
  log "[post-install] launchctl bootstrap 成功"
else
  log "[post-install] bootstrap 失败,试 legacy load"
  launchctl load "$PLIST" >>"$LOG" 2>&1 || log "[WARN] launchctl load 也失败,需重新登录或重启"
fi

# ---- 8. 探活 ----
sleep 3
if nc -z 127.0.0.1 3889 2>/dev/null; then
  log "[OK] 3889 端口监听中,服务起来了"
else
  log "[WARN] 3889 端口没监听 - server.log 内容:"
  if [ -f "$TARGET/server.log" ]; then
    cat "$TARGET/server.log" >>"$LOG" 2>&1
  else
    log "(server.log 不存在,LaunchAgent 可能没起)"
  fi
fi

# WPS 加载项路由探活
for host in wps et wpp pdf; do
  for file in manifest.json ribbon.xml index.html; do
    url="http://127.0.0.1:3889/$host/$file"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then
      log "[OK] $url -> 200"
    else
      log "[X]  $url -> $code"
    fi
  done
done

log "[post-install] 完成"
exit 0
