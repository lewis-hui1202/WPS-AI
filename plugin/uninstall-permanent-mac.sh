#!/usr/bin/env bash
set -e

echo "============================================"
echo "  文小舟 永久卸载（macOS）"
echo "============================================"

TARGET="$HOME/.lingxi-ai"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"

# 1. 卸 LaunchAgent
if [ -f "$LAUNCH_AGENT" ]; then
  launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
  rm -f "$LAUNCH_AGENT"
  echo "[OK] 已删除 LaunchAgent"
fi

# 2. 删 publish.xml
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  pub="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons/publish.xml"
  if [ -f "$pub" ]; then
    rm -f "$pub"
    echo "[OK] 已删除 $pub"
  fi
done

# 3. 删目标目录
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  echo "[OK] 已删除 $TARGET"
fi

echo
echo "卸载完成。重启 WPS 后插件不再加载。"
