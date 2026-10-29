# 文小舟 WPS 插件 RPM 规格文件
#
# 用于 openEuler / Anolis OS / Fedora / RHEL 系
#      银河麒麟 服务器版/桌面版 V10+ (rpm 通道)
#      中标麒麟 NeoKylin
#      统信 UOS 服务器版
#
# build.sh 会自动调用,手动调试:
#   rpmbuild -bb installer-linux/rpm/lingxi-ai.spec \
#     --define "_topdir $PWD/build/rpmbuild" \
#     --define "version 1.3.0" \
#     --define "buildarch x86_64"

Name:           lingxi-ai
Version:        %{version}
Release:        1%{?dist}
Summary:        Wenxiaozhou plugin for WPS Office (文小舟 WPS 插件)
License:        Proprietary
URL:            https://github.com/lewis-hui1202/WPS-AI
Source0:        lingxi-ai-payload-%{version}.tar.gz
BuildArch:      %{buildarch}

# Runtime deps - 都是国产/主流 Linux 都自带的
Requires:       bash
Requires:       coreutils
Requires:       /bin/sh

# 推荐(不强制)有这些,服务保活和探活会更顺
Recommends:     systemd
Recommends:     curl

# payload 里有 node 二进制,不要自动扫它的 .so 依赖塞 Requires(会扫出 libstdc++ ABI 一堆烦人的版本约束)
AutoReqProv:    no
%global __os_install_post %{nil}
%global debug_package %{nil}

%description
文小舟 是 WPS Office 的 AI 助手插件,通过 jsaddons 机制注册到 WPS,
在本机起一个轻量 Node.js 后台服务给四个宿主(wps/et/wpp/pdf)调用。

支持的发行版:
  - 银河麒麟 Kylin V10 桌面版/服务器版
  - 统信 UOS / Deepin
  - openKylin / openEuler / Anolis OS
  - Fedora / RHEL / CentOS Stream
  - 中标麒麟 NeoKylin

支持的架构: x86_64, aarch64(鲲鹏/飞腾 ARM),
            其他国产 CPU(龙芯 loongarch64/申威 sw_64) 需自备系统 Node 18+

%prep
%setup -q -n lingxi-ai-payload

%build
# payload 已构建,无需 build 阶段

%install
# 把 payload 整个搬到 buildroot,保留权限/符号链接
mkdir -p %{buildroot}/opt
cp -a opt/lingxi-ai %{buildroot}/opt/

%files
%defattr(-,root,root,-)
/opt/lingxi-ai

%post
# 文件复制完触发(root 上下文)
# 任务: 找真实登录用户,切过去跑 plugin/tools/post-install-linux.sh

INSTALL_PREFIX="/opt/lingxi-ai"

# ---- 找 GUI 登录用户 ----
TARGET_USER=""

# 1) pkexec / sudo dnf 的原始用户
if [ -z "$TARGET_USER" ] && [ -n "${PKEXEC_UID:-}" ]; then
  TARGET_USER="$(getent passwd "$PKEXEC_UID" 2>/dev/null | cut -d: -f1)"
fi
if [ -z "$TARGET_USER" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  TARGET_USER="$SUDO_USER"
fi

# 2) logname
if [ -z "$TARGET_USER" ] && command -v logname >/dev/null 2>&1; then
  TARGET_USER="$(logname 2>/dev/null || true)"
fi

# 3) who 找当前 tty/seat
if [ -z "$TARGET_USER" ] && command -v who >/dev/null 2>&1; then
  TARGET_USER="$(who | awk 'NR==1{print $1}' 2>/dev/null || true)"
fi

# 4) 兜底:扫 /home/* 找第一个真实用户
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  for h in /home/*; do
    [ -d "$h" ] || continue
    name="$(basename "$h")"
    [ "$name" = "lost+found" ] && continue
    if id "$name" >/dev/null 2>&1; then
      TARGET_USER="$name"
      break
    fi
  done
fi

if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "[lingxi-ai post] 没找到合适的真实用户,跳过用户态配置"
  echo "[lingxi-ai post] 该用户手动跑: bash $INSTALL_PREFIX/plugin/tools/post-install-linux.sh"
  exit 0
fi

TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || echo 0)"

echo "[lingxi-ai post] target_user=$TARGET_USER home=$TARGET_HOME"

# 保险:可执行位
chmod +x "$INSTALL_PREFIX/plugin/tools/post-install-linux.sh" \
         "$INSTALL_PREFIX/plugin/tools/pre-uninstall-linux.sh" 2>/dev/null || true
for f in "$INSTALL_PREFIX/plugin/runtime/node-linux-x64/bin/node" \
         "$INSTALL_PREFIX/plugin/runtime/node-linux-arm64/bin/node"; do
  [ -f "$f" ] && chmod +x "$f" 2>/dev/null || true
done

# 切真实用户跑安装逻辑
sudo -u "$TARGET_USER" -H \
  HOME="$TARGET_HOME" USER="$TARGET_USER" \
  XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
  bash "$INSTALL_PREFIX/plugin/tools/post-install-linux.sh" "$INSTALL_PREFIX" \
  || echo "[lingxi-ai post] post-install-linux.sh 非零退出,详见 $TARGET_HOME/.lingxi-ai/install.log"

exit 0

%preun
# 文件删除前触发(root 上下文)
# $1 == 0 -> 完全卸载, $1 == 1 -> 升级中,不清用户数据
if [ "$1" = "0" ]; then
  INSTALL_PREFIX="/opt/lingxi-ai"
  PRE_UNINSTALL="$INSTALL_PREFIX/plugin/tools/pre-uninstall-linux.sh"

  TARGET_USER=""
  if [ -z "$TARGET_USER" ] && [ -n "${PKEXEC_UID:-}" ]; then
    TARGET_USER="$(getent passwd "$PKEXEC_UID" 2>/dev/null | cut -d: -f1)"
  fi
  if [ -z "$TARGET_USER" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    TARGET_USER="$SUDO_USER"
  fi
  if [ -z "$TARGET_USER" ] && command -v logname >/dev/null 2>&1; then
    TARGET_USER="$(logname 2>/dev/null || true)"
  fi
  if [ -z "$TARGET_USER" ] && command -v who >/dev/null 2>&1; then
    TARGET_USER="$(who | awk 'NR==1{print $1}' 2>/dev/null || true)"
  fi
  if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
    for h in /home/*; do
      [ -d "$h" ] || continue
      name="$(basename "$h")"
      [ "$name" = "lost+found" ] && continue
      if id "$name" >/dev/null 2>&1; then TARGET_USER="$name"; break; fi
    done
  fi

  if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ] && [ -f "$PRE_UNINSTALL" ]; then
    TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
    TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || echo 0)"
    sudo -u "$TARGET_USER" -H \
      HOME="$TARGET_HOME" USER="$TARGET_USER" \
      XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
      bash "$PRE_UNINSTALL" || true
  fi
fi
exit 0

%changelog
* Mon Jun 20 2026 lingxi-ai <noreply@lingxi-ai.local> - %{version}-1
- 加 RPM 包,覆盖银河麒麟/openEuler/Anolis/中标麒麟等
