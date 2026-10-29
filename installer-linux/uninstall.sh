#!/usr/bin/env bash
# 文小舟 Linux 一键卸载工具
#
# 自动检测安装方式（dpkg .deb / rpm / tar.gz 绿色包），走对应卸载路径。
#
# 用法:
#   bash uninstall.sh                       # 标准卸载（apt purge 或 rm 安装目录 + 清用户态）
#   sudo bash uninstall.sh                  # 系统级安装（/opt/lingxi-ai）必须 sudo
#   bash uninstall.sh --purge               # 彻底清，不管之前怎么装的：
#                                           #   apt purge + 强制 rm /opt/lingxi-ai + 杀残留进程
#                                           #   + 清所有 WPS jsaddons publish.xml（含 365 路径）
#                                           #   + 清 systemd unit + ~/.lingxi-ai/
#   bash uninstall.sh --prefix /custom/dir  # 自定义安装路径（覆盖自动探测）
#   bash uninstall.sh --keep-files          # 只清用户态/服务，保留 /opt/lingxi-ai
#
# 一行命令（不需要本仓库时）：
#   curl -fsSL <你的 OSS 路径>/uninstall.sh | sudo bash -s -- --purge

set -u

PREFIX=""
KEEP_FILES=0
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)     PREFIX="$2"; shift 2 ;;
    --keep-files) KEEP_FILES=1; shift ;;
    --purge)      PURGE=1; shift ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | sed '$d'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# 检测真实用户（即使用 sudo 跑，cleanup 也要切到原始用户）
TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6 2>/dev/null)"
TARGET_HOME="${TARGET_HOME:-$HOME}"
TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || id -u)"

# 自动探测安装方式
INSTALL_METHOD="none"
DPKG_INSTALLED=0
if command -v dpkg >/dev/null 2>&1 && dpkg -l lingxi-ai >/dev/null 2>&1; then
  DPKG_INSTALLED=1
  INSTALL_METHOD="deb"
fi
RPM_INSTALLED=0
if command -v rpm >/dev/null 2>&1 && rpm -q lingxi-ai >/dev/null 2>&1; then
  RPM_INSTALLED=1
  [ "$INSTALL_METHOD" = "none" ] && INSTALL_METHOD="rpm"
fi

if [ -z "$PREFIX" ]; then
  for cand in /opt/lingxi-ai "$TARGET_HOME/.local/share/lingxi-ai"; do
    if [ -d "$cand" ]; then PREFIX="$cand"; break; fi
  done
fi
# 修 L5：显式分组，避免 `A || B && C && D` 的左结合被误读（原来靠 INSTALL_METHOD 预置成
# "none" 才碰巧对）。
if { [ -z "$INSTALL_METHOD" ] || [ "$INSTALL_METHOD" = "none" ]; } && [ -n "$PREFIX" ]; then
  INSTALL_METHOD="tar"
fi

echo "============================================="
echo "  文小舟 Linux 卸载"
echo "============================================="
echo "  Install 方式:  $INSTALL_METHOD"
echo "  Prefix:        ${PREFIX:-<没找到,只清用户数据>}"
echo "  Target user:   $TARGET_USER (uid=$TARGET_UID, home=$TARGET_HOME)"
[ "$PURGE" = "1" ] && echo "  Mode:          PURGE（彻底清）"
[ "$KEEP_FILES" = "1" ] && echo "  Mode:          --keep-files（保留安装目录）"
echo "============================================="

# ---- Step 1: 跑用户态清理 ----
PRE_UNINSTALL=""
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
for cand in \
  "$PREFIX/plugin/tools/pre-uninstall-linux.sh" \
  "$SELF_DIR/plugin/tools/pre-uninstall-linux.sh" \
  "$SELF_DIR/../plugin/tools/pre-uninstall-linux.sh"; do
  if [ -n "$cand" ] && [ -f "$cand" ]; then PRE_UNINSTALL="$cand"; break; fi
done

if [ -n "$PRE_UNINSTALL" ]; then
  echo "[1/4] 用户态清理: $PRE_UNINSTALL"
  if [ "$(id -u)" = "0" ] && [ "$TARGET_USER" != "root" ]; then
    sudo -u "$TARGET_USER" -H \
      HOME="$TARGET_HOME" USER="$TARGET_USER" \
      XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
      bash "$PRE_UNINSTALL" || true
  else
    bash "$PRE_UNINSTALL" || true
  fi
else
  echo "[1/4] 没找到 pre-uninstall-linux.sh,跳过用户态清理（PURGE 模式下面会兜底）"
fi

# 修 L5：先显式算出"是不是 dpkg 安装的"，避免 `A || B -a C && D` 的优先级歧义把
# DPKG_INSTALLED=1 也 && 门控在第二个 dpkg -l 上，从而可能走错删除分支（apt purge vs rm -rf）。
IS_DPKG=0
if [ "$DPKG_INSTALLED" = "1" ]; then
  IS_DPKG=1
elif [ "$PURGE" = "1" ] && command -v dpkg >/dev/null 2>&1 && dpkg -l lingxi-ai >/dev/null 2>&1; then
  IS_DPKG=1
fi

# ---- Step 2: 按安装方式删系统级文件 ----
if [ "$KEEP_FILES" = "1" ]; then
  echo "[2/4] --keep-files: 保留 $PREFIX"
elif [ "$IS_DPKG" = "1" ]; then
  echo "[2/4] apt purge lingxi-ai ..."
  if [ "$(id -u)" = "0" ]; then
    apt purge -y lingxi-ai 2>&1 | tail -5 || true
  else
    sudo apt purge -y lingxi-ai 2>&1 | tail -5 || true
  fi
elif [ "$RPM_INSTALLED" = "1" ]; then
  echo "[2/4] dnf/rpm 卸载 lingxi-ai ..."
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf remove -y lingxi-ai 2>&1 | tail -5 || true
  else
    sudo rpm -e lingxi-ai 2>&1 | tail -5 || true
  fi
elif [ -n "$PREFIX" ] && [ -d "$PREFIX" ]; then
  echo "[2/4] tar.gz 安装,直接删 $PREFIX ..."
  if [ "$(id -u)" = "0" ] || [ -w "$PREFIX" ]; then
    rm -rf "$PREFIX"
  else
    echo "  [WARN] 没权限删 $PREFIX,需要 sudo 重跑"
  fi
else
  echo "[2/4] 找不到系统级安装记录"
fi

# ---- Step 3: PURGE 模式 - 兜底强制清理（针对老版 prerm 可能漏的） ----
if [ "$PURGE" = "1" ]; then
  echo "[3/4] PURGE 模式:兜底清理残留..."
  # 杀残留进程
  pkill -9 -f serve-permanent 2>/dev/null || true
  pkill -9 -f proxy-server 2>/dev/null || true
  pkill -9 -f mcp-server 2>/dev/null || true

  # 强制 rm /opt/lingxi-ai 万一 apt purge 没干净
  if [ -d /opt/lingxi-ai ]; then
    if [ "$(id -u)" = "0" ]; then
      rm -rf /opt/lingxi-ai && echo "  rm /opt/lingxi-ai"
    else
      sudo rm -rf /opt/lingxi-ai && echo "  sudo rm /opt/lingxi-ai"
    fi
  fi

  # 切到真实用户清用户态（覆盖老 prerm 没清的 WPS365 路径）
  CLEANUP_USER_CMD='
    set +e
    systemctl --user stop lingxi-ai.service 2>/dev/null
    systemctl --user disable lingxi-ai.service 2>/dev/null
    rm -f "$HOME/.config/systemd/user/lingxi-ai.service"
    rm -f "$HOME/.config/systemd/user/default.target.wants/lingxi-ai.service"
    systemctl --user daemon-reload 2>/dev/null
    rm -f "$HOME/.config/autostart/lingxi-ai.desktop"
    rm -rf "$HOME/.lingxi-ai"
    # 撒一遍所有候选 jsaddons 路径删 publish.xml（含 WPS365）
    find "$HOME/.config/Kingsoft" "$HOME/.config/wps-office" "$HOME/.config/wps" \
         "$HOME/.config/wps365" "$HOME/.config/WPSOffice" "$HOME/.kingsoft" \
         "$HOME/.linglong/com.wps.office" \
         "$HOME/snap/wps-office" "$HOME/snap/wps-office-multilang" \
         "$HOME/.var/app/com.wps.Office" \
         -name "publish.xml" -path "*/jsaddons/*" -delete 2>/dev/null
    echo "  用户态残留已清"
  '
  if [ "$(id -u)" = "0" ] && [ "$TARGET_USER" != "root" ]; then
    sudo -u "$TARGET_USER" -H HOME="$TARGET_HOME" USER="$TARGET_USER" bash -c "$CLEANUP_USER_CMD"
  else
    bash -c "$CLEANUP_USER_CMD"
  fi
fi

# ---- Step 4: 友好提示 ----
echo "[4/4] 卸载完成"
echo
echo "============================================="
echo "  下一步:"
echo "    1. 完全退出 WPS（关窗口 + 系统托盘也退）"
echo "       pkill -9 -f 'wps|wpp|et|wpsoffice'"
echo "    2. 重新安装新版 .deb / tar.gz 即可"
echo "============================================="
