#!/usr/bin/env bash
# 文小舟 Linux 卸载脚本(用户上下文)
#
# 调用入口:
#   - tar.gz 绿色包:  uninstall.sh 直接 bash 调
#   - .deb:          debian/prerm 通过 sudo -u <real-user> bash 调
#   - 手跑:          bash pre-uninstall-linux.sh
#
# 工作:
#   1. 停 + disable systemd --user 单元
#   2. 杀残留 node 进程
#   3. 删 systemd 单元 / autostart .desktop
#   4. 删所有已知 WPS Linux jsaddons 路径下的 publish.xml
#   5. 删 ~/.lingxi-ai

set -u

# 修 T7：set -u 只挡"未设"，不挡"空串"。sudo -u 未 sanitize env 时 $HOME 可能为空，
# 后面 rm -rf "$HOME/.lingxi-ai" 会变成 rm -rf "/.lingxi-ai"。空 HOME / root 家目录直接退出。
if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  echo "[pre-uninstall] [ERROR] \$HOME 为空或为根，无法安全定位用户目录，已中止。" >&2
  exit 1
fi

TARGET="$HOME/.lingxi-ai"
LOG="$TARGET/uninstall.log"

mkdir -p "$TARGET" 2>/dev/null || true

log() {
  if [ -d "$TARGET" ]; then
    echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2
  else
    echo "[$(date '+%F %T')] $*" >&2
  fi
}

log "==== pre-uninstall-linux 启动 ===="

# 1. 停 systemd --user 单元
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop lingxi-ai.service    >>"$LOG" 2>&1 || true
  systemctl --user disable lingxi-ai.service >>"$LOG" 2>&1 || true
  log "[OK] systemd 单元已 stop+disable"
fi

# 1b. 撤销安装时设的 enable-linger（对称还原；单元已删就无东西可保活，不撤是残留的系统状态）
if command -v loginctl >/dev/null 2>&1; then
  loginctl disable-linger "$USER" >>"$LOG" 2>&1 || true
  log "[OK] loginctl disable-linger $USER"
fi

# 2. 杀残留 node 进程
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server    >>"$LOG" 2>&1 || true
pkill -9 -f mcp-server      >>"$LOG" 2>&1 || true
pkill -9 -f service-watchdog.sh >>"$LOG" 2>&1 || true
sleep 1

# 3. 删 systemd 单元文件 / autostart 入口
UNIT="$HOME/.config/systemd/user/lingxi-ai.service"
if [ -f "$UNIT" ]; then
  rm -f "$UNIT"
  log "[OK] 删 $UNIT"
  command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >>"$LOG" 2>&1 || true
fi

DESKTOP="$HOME/.config/autostart/lingxi-ai.desktop"
if [ -f "$DESKTOP" ]; then
  rm -f "$DESKTOP"
  log "[OK] 删 $DESKTOP"
fi

# 4. 删所有 WPS jsaddons 路径下的 publish.xml
# 跟 post-install-linux.sh 的 PUBLISH_DIRS 保持一致 - 改一个记得改两个
PUBLISH_DIRS=(
  "$HOME/.local/share/Kingsoft/wps/jsaddons"
  "$HOME/.config/Kingsoft/Office6/jsaddons"
  # WPS 365 候选
  "$HOME/.config/Kingsoft/Office365/jsaddons"
  "$HOME/.config/wps365/jsaddons"
  "$HOME/.config/Kingsoft/wps-365/jsaddons"
  "$HOME/.config/Kingsoft/WPS-365/jsaddons"
  "$HOME/.config/WPSOffice/jsaddons"
  # 国产 / snap / flatpak
  "$HOME/.config/wps-office/jsaddons"
  "$HOME/.config/wps/jsaddons"
  "$HOME/.kingsoft/office6/jsaddons"
  "$HOME/.kingsoft/Office6/jsaddons"
  "$HOME/.linglong/com.wps.office/data/.config/Kingsoft/Office6/jsaddons"
  "$HOME/snap/wps-office/current/.config/Kingsoft/Office6/jsaddons"
  "$HOME/snap/wps-office-multilang/current/.config/Kingsoft/Office6/jsaddons"
  "$HOME/.var/app/com.wps.Office/config/Kingsoft/Office6/jsaddons"
)
for dir in "${PUBLISH_DIRS[@]}"; do
  pub="$dir/publish.xml"
  if [ -f "$pub" ]; then
    # 修 T3：publish.xml 是共享清单，只移除 lingxi 条目，保留别家插件；无别家条目才删整文件。
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

# 5. 删 ~/.lingxi-ai(变体、服务脚本、日志)
# 修 T7：TARGET 由 $HOME 拼出，sudo -u 未 sanitize env 时 $HOME 可能为空 → TARGET="/.lingxi-ai"。
# 加一道防线：TARGET 必须以 /home 或 /root 或 /Users 下的真实目录结尾，且非根级路径。
if [ -n "$TARGET" ] && [ "$TARGET" != "/.lingxi-ai" ] && [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  log "[OK] 删 $TARGET"
fi

log "==== pre-uninstall-linux 完成 ===="
exit 0
