#!/usr/bin/env bash
# 文小舟 Linux 绿色包安装入口(tar.gz 解压后跑这个)
#
# 用法:
#   tar -xzf lingxi-ai-<version>-linux-<arch>.tar.gz
#   cd lingxi-ai-<version>
#   bash install.sh                      # 装到 ~/.local/share/lingxi-ai(无需 sudo)
#   sudo bash install.sh                 # 装到 /opt/lingxi-ai(系统级)
#   bash install.sh --prefix /custom/dir # 自定义路径
#
# install.sh 只做两件事:
#   1. 把 plugin/ 复制到 INSTALL_PREFIX
#   2. 用真实登录用户调 plugin/tools/post-install-linux.sh,做变体生成/publish.xml/systemd
#
# 真正的安装逻辑都在 plugin/tools/post-install-linux.sh(.deb 也复用同一份)

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 参数 ----
PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | sed '$d'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# 默认 prefix: root 装到 /opt,普通用户装到 ~/.local/share
if [ -z "$PREFIX" ]; then
  if [ "$(id -u)" = "0" ]; then
    PREFIX="/opt/lingxi-ai"
  else
    PREFIX="$HOME/.local/share/lingxi-ai"
  fi
fi

# 真实登录用户:sudo 时 $USER 是 root,要用 SUDO_USER
TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-$HOME}"
TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || id -u)"

echo "============================================="
echo "  文小舟 Linux 安装"
echo "============================================="
echo "  Prefix:       $PREFIX"
echo "  Target user:  $TARGET_USER (uid=$TARGET_UID)"
echo "  Target home:  $TARGET_HOME"
echo "============================================="

# ---- 1. 拷文件 ----
echo
echo "[1/2] 复制 plugin/ 到 $PREFIX ..."
mkdir -p "$PREFIX"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$SCRIPT_DIR/plugin/" "$PREFIX/plugin/"
else
  rm -rf "$PREFIX/plugin"
  mkdir -p "$PREFIX/plugin"
  ( cd "$SCRIPT_DIR/plugin" && tar -cf - . ) | ( cd "$PREFIX/plugin" && tar -xf - )
fi
[ -f "$SCRIPT_DIR/README.md" ]  && cp "$SCRIPT_DIR/README.md"  "$PREFIX/" || true
[ -f "$SCRIPT_DIR/INSTALL.md" ] && cp "$SCRIPT_DIR/INSTALL.md" "$PREFIX/" || true

# Node 二进制可执行位
chmod +x "$PREFIX/plugin/runtime/node-linux-x64/bin/node"   2>/dev/null || true
chmod +x "$PREFIX/plugin/runtime/node-linux-arm64/bin/node" 2>/dev/null || true
chmod +x "$PREFIX/plugin/tools/"*.sh 2>/dev/null || true

# 如果是 sudo 装的,所有权应该是 root,普通用户能读
if [ "$(id -u)" = "0" ]; then
  chown -R root:root "$PREFIX"
  chmod -R a+rX "$PREFIX"
fi

# ---- 2. 用真实用户跑 post-install ----
echo
echo "[2/2] 配置 WPS 加载项 / systemd 用户服务..."
POST_INSTALL="$PREFIX/plugin/tools/post-install-linux.sh"
if [ ! -f "$POST_INSTALL" ]; then
  echo "[X] 找不到 $POST_INSTALL"
  exit 1
fi

if [ "$(id -u)" = "0" ] && [ "$TARGET_USER" != "root" ]; then
  # sudo 上下文:切回真实用户
  sudo -u "$TARGET_USER" -H \
    HOME="$TARGET_HOME" USER="$TARGET_USER" \
    XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
    bash "$POST_INSTALL" "$PREFIX"
else
  bash "$POST_INSTALL" "$PREFIX"
fi

echo
echo "============================================="
echo "  安装完成 🎉"
echo "============================================="
echo "  安装目录: $PREFIX"
echo "  日志:    $TARGET_HOME/.lingxi-ai/install.log"
echo
echo "  下一步:"
echo "    1. 完全退出 WPS"
echo "    2. 重新打开 WPS,顶部会出现「文小舟」标签页"
echo
echo "  卸载: bash $SCRIPT_DIR/uninstall.sh"
echo "       (sudo 装的就 sudo bash uninstall.sh)"
echo "============================================="
