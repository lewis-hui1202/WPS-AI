#!/usr/bin/env bash
# 文小舟 macOS 轻量卸载(用户上下文,不动系统目录)
#
# 给手动 .sh 安装路径 + 升级前清旧场景用。dmg 安装的用户应该走
# /Applications/文小舟 卸载.app(它调 installer-mac/uninstall-all.sh
# 一并清掉 /Library/Application Support/LingxiAI 和 pkgutil receipt)。
#
# 直接手跑: bash pre-uninstall-mac.sh

set -u

# 修 T7：空 $HOME 会让 rm -rf "$HOME/.lingxi-ai" 变成 rm -rf "/.lingxi-ai"。空/根家目录退出。
if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  echo "[pre-uninstall] [ERROR] \$HOME 为空或为根，已中止以免误删系统路径。" >&2
  exit 1
fi

TARGET="$HOME/.lingxi-ai"
PLIST="$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"
LOG="$TARGET/uninstall.log"

mkdir -p "$TARGET" 2>/dev/null || true

log() {
  if [ -d "$TARGET" ]; then
    echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2
  else
    echo "[$(date '+%F %T')] $*" >&2
  fi
}

log "==== pre-uninstall-mac 启动 ===="

# 1. 停 LaunchAgent
launchctl bootout "gui/$(id -u)" "$PLIST" >>"$LOG" 2>&1 || true
launchctl unload "$PLIST" >>"$LOG" 2>&1 || true
log "[OK] LaunchAgent 已卸"

# 2. 杀残留进程
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server   >>"$LOG" 2>&1 || true
pkill -9 -f mcp-server     >>"$LOG" 2>&1 || true
pkill -9 -f service-watchdog.sh >>"$LOG" 2>&1 || true

# 3. 删 LaunchAgent plist
if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  log "[OK] 删 $PLIST"
fi

# 4. 删两个 Container 里的 publish.xml
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  pub="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons/publish.xml"
  if [ -f "$pub" ]; then
    # 修 T3：共享清单，只移除 lingxi 条目，保留别家插件。
    others="$(grep -i jspluginonline "$pub" 2>/dev/null | grep -vi lingxi-ai || true)"
    if [ -n "$others" ]; then
      {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        printf '%s\n' '<jsplugins>'
        printf '%s\n' "$others"
        printf '%s\n' '</jsplugins>'
      } > "$pub"
      log "[OK] 保留其它插件，移除 lingxi 条目: $pub"
    else
      rm -f "$pub"
      log "[OK] 删 $pub"
    fi
  fi
done

# 5. 删 ~/.lingxi-ai(变体目录、服务脚本、日志)
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  log "[OK] 删 $TARGET"
fi

log "==== pre-uninstall-mac 完成 ===="
exit 0
