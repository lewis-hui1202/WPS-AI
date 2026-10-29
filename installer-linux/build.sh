#!/usr/bin/env bash
# 文小舟 Linux 打包脚本: 产出
#   - dist/lingxi-ai-<version>-linux-<arch>.tar.gz   绿色包,带 install.sh/uninstall.sh,所有发行版通用
#   - dist/lingxi-ai_<version>_<deb-arch>.deb        Debian/Ubuntu/Deepin/UOS/openKylin/银河麒麟桌面版
#   - dist/lingxi-ai-<version>-1.<rpm-arch>.rpm      openEuler/Anolis/Fedora/RHEL/银河麒麟服务器/中标麒麟
#
# 流程:
#   1. 准备内置 Node(plugin/runtime/node-linux-<arch>)
#   2. Staging: plugin/ + post-install-linux.sh + pre-uninstall-linux.sh + install.sh + uninstall.sh
#   3. 按 --format 产 tar.gz / deb / rpm
#
# 用法:
#   cd installer-linux
#   bash build.sh                              # 默认 x64,产 tar+deb+rpm(有什么工具就产什么)
#   bash build.sh --arch arm64                 # arm64 (鲲鹏/飞腾)
#   bash build.sh --format tar                 # 只产 tar.gz
#   bash build.sh --format deb,rpm             # 只产 deb 和 rpm
#   bash build.sh --version 1.3.0
#
# 国产架构(loongarch64/sw_64/mips64el):
#   - tar.gz 仍可用,但不会带内置 node(Node.js 官方 dist 不出预编译)
#   - 安装时 post-install-linux.sh 会自动退到系统 PATH 上的 node
#   - 用 --arch native --no-bundle-node 跳过内置 node 下载步骤
#
# 必须在 Linux 上跑(或 macOS + GNU coreutils + dpkg/rpm; Windows 上用 WSL)。

set -euo pipefail

# ---- 参数 ----
VERSION=""
ARCH="x64"
FORMAT="all"        # tar, deb, rpm, all, 或逗号分隔组合
BUNDLE_NODE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version)      VERSION="$2"; shift 2 ;;
    --arch)         ARCH="$2"; shift 2 ;;
    --format)       FORMAT="$2"; shift 2 ;;
    --skip-deb)     FORMAT="${FORMAT//deb,/}"; FORMAT="${FORMAT//,deb/}"; [ "$FORMAT" = "deb" ] && FORMAT="tar"; shift ;;
    --skip-rpm)     FORMAT="${FORMAT//rpm,/}"; FORMAT="${FORMAT//,rpm/}"; [ "$FORMAT" = "rpm" ] && FORMAT="tar"; shift ;;
    --no-bundle-node) BUNDLE_NODE=0; shift ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | sed '$d'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# format 展开
WANT_TAR=0; WANT_DEB=0; WANT_RPM=0
case "$FORMAT" in
  all) WANT_TAR=1; WANT_DEB=1; WANT_RPM=1 ;;
  *)
    IFS=',' read -ra FMTS <<< "$FORMAT"
    for f in "${FMTS[@]}"; do
      case "$f" in
        tar|tarball|tgz) WANT_TAR=1 ;;
        deb)             WANT_DEB=1 ;;
        rpm)             WANT_RPM=1 ;;
        *) echo "未知 --format: $f (支持 tar/deb/rpm/all)"; exit 1 ;;
      esac
    done
    ;;
esac

# ---- 路径 ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugin"
DIST_DIR="$ROOT_DIR/dist"
WORK_DIR="$SCRIPT_DIR/build"
STAGING="$WORK_DIR/staging"

PKG_NAME="lingxi-ai"

# ---- 架构归一化 ----
# Linux 包管理器命名很乱:同一个 ARM64 在 deb 叫 arm64,在 rpm 叫 aarch64,在 node dist 叫 arm64
case "$ARCH" in
  x64|amd64|x86_64)
    ARCH_NORM="x64"
    DEB_ARCH="amd64"
    RPM_ARCH="x86_64"
    NODE_DIR_NAME="node-linux-x64"
    ;;
  arm64|aarch64)
    ARCH_NORM="arm64"
    DEB_ARCH="arm64"
    RPM_ARCH="aarch64"
    NODE_DIR_NAME="node-linux-arm64"
    ;;
  loongarch64|loong64)
    # 龙芯(Loongnix/UOS 龙芯版/麒麟龙芯版)
    ARCH_NORM="loongarch64"
    DEB_ARCH="loong64"        # 修 L7：Debian 的规范移植架构名是 loong64，写 loongarch64 会被 apt/dpkg 拒装
    RPM_ARCH="loongarch64"
    NODE_DIR_NAME=""        # 不带内置 node
    BUNDLE_NODE=0
    echo "[i] 龙芯架构: 不打包内置 Node,安装时依赖系统 node 18+"
    ;;
  sw_64|sw64)
    ARCH_NORM="sw_64"
    DEB_ARCH="sw_64"
    RPM_ARCH="sw_64"
    NODE_DIR_NAME=""
    BUNDLE_NODE=0
    echo "[i] 申威架构: 不打包内置 Node,安装时依赖系统 node 18+"
    ;;
  mips64el|mips64)
    ARCH_NORM="mips64el"
    DEB_ARCH="mips64el"
    RPM_ARCH="mips64el"
    NODE_DIR_NAME=""
    BUNDLE_NODE=0
    echo "[i] 旧龙芯 mips64el: 不打包内置 Node,安装时依赖系统 node 18+"
    ;;
  *)
    echo "[X] 不支持的架构: $ARCH (允许 x64/arm64/loongarch64/sw_64/mips64el)"
    exit 1
    ;;
esac

# 从 plugin/package.json 拿 version
if [ -z "$VERSION" ]; then
  if command -v node >/dev/null 2>&1; then
    VERSION="$(node -p "require('$PLUGIN_DIR/package.json').version" 2>/dev/null || echo "")"
  fi
  if [ -z "$VERSION" ]; then
    VERSION="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$PLUGIN_DIR/package.json" | head -n 1)"
  fi
  VERSION="${VERSION:-0.0.0}"
fi

TARBALL_NAME="${PKG_NAME}-${VERSION}-linux-${ARCH_NORM}.tar.gz"
DEB_NAME="${PKG_NAME}_${VERSION}_${DEB_ARCH}.deb"
RPM_NAME="${PKG_NAME}-${VERSION}-1.${RPM_ARCH}.rpm"

echo "============================================="
echo "  文小舟 Linux Installer Build"
echo "============================================="
echo "  Version:     $VERSION"
echo "  Arch:        $ARCH_NORM (deb=$DEB_ARCH rpm=$RPM_ARCH)"
echo "  Bundle Node: $([ "$BUNDLE_NODE" = "1" ] && echo "yes ($NODE_DIR_NAME)" || echo "no (用系统 node)")"
echo "  Formats:     $([ "$WANT_TAR" = "1" ] && echo -n "tar ")$([ "$WANT_DEB" = "1" ] && echo -n "deb ")$([ "$WANT_RPM" = "1" ] && echo -n "rpm")"
echo "  Output:"
[ "$WANT_TAR" = "1" ] && echo "    $DIST_DIR/$TARBALL_NAME"
[ "$WANT_DEB" = "1" ] && echo "    $DIST_DIR/$DEB_NAME (若有 dpkg-deb)"
[ "$WANT_RPM" = "1" ] && echo "    $DIST_DIR/$RPM_NAME (若有 rpmbuild)"
echo "============================================="

# ---- 1. 准备 Node 运行时 ----
if [ "$BUNDLE_NODE" = "1" ]; then
  echo
  echo "[1/4] 准备内置 Node 运行时($NODE_DIR_NAME)..."
  NODE_BIN="$PLUGIN_DIR/runtime/$NODE_DIR_NAME/bin/node"
  if ! command -v node >/dev/null 2>&1; then
    echo "[X] 当前机器没装 node,无法跑 bundle-node.js"
    echo "    先装 Node LTS 用来跑构建工具,再重试"
    exit 1
  fi
  echo "  检查并裁剪 $NODE_DIR_NAME..."
  ( cd "$PLUGIN_DIR" && node tools/bundle-node.js --platform "${NODE_DIR_NAME#node-}" ) || {
    echo "[X] bundle-node.js 失败,看上面输出"
    exit 1
  }
  if [ ! -f "$NODE_BIN" ]; then
    echo "[X] 还是没找到 $NODE_BIN,手动跑: cd plugin && node tools/bundle-node.js --all"
    exit 1
  fi
  echo "  [OK] $NODE_BIN"
else
  echo
  echo "[1/4] 跳过内置 Node 打包($ARCH_NORM 走系统 node)"
fi

# ---- 2. Staging ----
echo
echo "[2/4] 准备 staging 目录..."
rm -rf "$WORK_DIR"
mkdir -p "$STAGING/plugin"

# 排除其他平台的 runtime,只留当前 linux 架构
RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='dist*'
  --exclude='test'
  --exclude='wps-addon-build'
  --exclude='wps-addon-publish'
  --exclude='.DS_Store'
  --exclude='__MACOSX'
  --exclude='.git'
  --exclude='*.log'
  --exclude='install-windows.bat'
  --exclude='install-permanent-windows.bat'
  --exclude='uninstall-permanent-windows.bat'
  --exclude='start-*.bat'
  --exclude='runtime/node-win-x64'
  --exclude='runtime/node-darwin-x64'
  --exclude='runtime/node-darwin-arm64'
)
# 只留当前架构的 linux node;其他全排除
for other in node-linux-x64 node-linux-arm64; do
  if [ "$other" != "$NODE_DIR_NAME" ]; then
    RSYNC_EXCLUDES+=(--exclude="runtime/$other")
  fi
done
if [ "$BUNDLE_NODE" = "0" ]; then
  # 国产架构:整个 runtime 不要
  RSYNC_EXCLUDES+=(--exclude='runtime/node-linux-x64')
  RSYNC_EXCLUDES+=(--exclude='runtime/node-linux-arm64')
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a "${RSYNC_EXCLUDES[@]}" "$PLUGIN_DIR/" "$STAGING/plugin/"
else
  # 退路:tar(rsync 在精简 docker 镜像可能没有)
  TAR_EXCLUDES=()
  for x in "${RSYNC_EXCLUDES[@]}"; do
    case "$x" in --exclude=*) TAR_EXCLUDES+=("--exclude=${x#--exclude=}") ;; esac
  done
  ( cd "$PLUGIN_DIR" && tar "${TAR_EXCLUDES[@]}" -cf - . ) | ( cd "$STAGING/plugin" && tar -xf - )
fi

# README / INSTALL
cp "$ROOT_DIR/README.md"  "$STAGING/" 2>/dev/null || true
cp "$ROOT_DIR/INSTALL.md" "$STAGING/" 2>/dev/null || true

# 可执行位
chmod +x "$STAGING/plugin/tools/"*.sh 2>/dev/null || true
[ -n "$NODE_DIR_NAME" ] && chmod +x "$STAGING/plugin/runtime/$NODE_DIR_NAME/bin/node" 2>/dev/null || true

# tar.gz 的入口
cp "$SCRIPT_DIR/install.sh"   "$STAGING/install.sh"
cp "$SCRIPT_DIR/uninstall.sh" "$STAGING/uninstall.sh"
chmod +x "$STAGING/install.sh" "$STAGING/uninstall.sh"

STAGING_SIZE=$(du -sh "$STAGING" | awk '{print $1}')
echo "  Staging 大小: $STAGING_SIZE"

# ---- 3. tar.gz ----
mkdir -p "$DIST_DIR"
TARBALL_PATH="$DIST_DIR/$TARBALL_NAME"

if [ "$WANT_TAR" = "1" ]; then
  echo
  echo "[3/4] 打 tar.gz..."
  rm -f "$TARBALL_PATH"

  TOP_DIR="${PKG_NAME}-${VERSION}"
  TOP_STAGING="$WORK_DIR/$TOP_DIR"
  cp -a "$STAGING" "$TOP_STAGING"

  ( cd "$WORK_DIR" && tar -czf "$TARBALL_PATH" "$TOP_DIR" )
  rm -rf "$TOP_STAGING"
  TARBALL_SIZE=$(du -sh "$TARBALL_PATH" | awk '{print $1}')
  echo "  [OK] $TARBALL_PATH ($TARBALL_SIZE)"
else
  echo
  echo "[3/4] 跳过 tar.gz(--format 未包含 tar)"
fi

# ---- 4. .deb + .rpm ----
DEB_PATH="$DIST_DIR/$DEB_NAME"
RPM_PATH="$DIST_DIR/$RPM_NAME"

# .deb
if [ "$WANT_DEB" = "1" ]; then
  if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo
    echo "[4a]  没找到 dpkg-deb,跳过 .deb"
    echo "      Ubuntu/Debian: sudo apt install dpkg"
    echo "      Fedora/RHEL:   sudo dnf install dpkg"
    echo "      Mac:           brew install dpkg"
  else
    echo
    echo "[4a]  打 .deb..."

    DEB_ROOT="$WORK_DIR/deb-root"
    rm -rf "$DEB_ROOT"
    mkdir -p "$DEB_ROOT/DEBIAN"
    mkdir -p "$DEB_ROOT/opt/lingxi-ai"

    if command -v rsync >/dev/null 2>&1; then
      # 排除 install.sh（apt 自己装无需它），但 uninstall.sh 要保留 ——
      # 用户可以 sudo bash /opt/lingxi-ai/uninstall.sh --purge 一键彻底清
      rsync -a --exclude='install.sh' "$STAGING/" "$DEB_ROOT/opt/lingxi-ai/"
    else
      ( cd "$STAGING" && tar --exclude='install.sh' -cf - . ) \
        | ( cd "$DEB_ROOT/opt/lingxi-ai" && tar -xf - )
    fi
    chmod +x "$DEB_ROOT/opt/lingxi-ai/uninstall.sh" 2>/dev/null || true

    INSTALLED_SIZE_KB=$(du -sk "$DEB_ROOT/opt/lingxi-ai" | awk '{print $1}')

    cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $VERSION
Section: utils
Priority: optional
Architecture: $DEB_ARCH
Maintainer: lingxi-ai <noreply@lingxi-ai.local>
Installed-Size: $INSTALLED_SIZE_KB
Depends: coreutils
Recommends: systemd, curl
Homepage: https://github.com/lewis-hui1202/WPS-AI
Description: Wenxiaozhou plugin for WPS Office (Linux)
 文小舟 WPS 插件,运行本地后台服务给 WPS 加载项调用,
 安装后自动注册 jsaddons 并通过 systemd --user 单元保活。
 .
 支持 Ubuntu/Debian/Deepin/统信 UOS/银河麒麟桌面版/openKylin。
EOF

    cp "$SCRIPT_DIR/debian/postinst" "$DEB_ROOT/DEBIAN/postinst"
    cp "$SCRIPT_DIR/debian/prerm"    "$DEB_ROOT/DEBIAN/prerm"
    chmod 0755 "$DEB_ROOT/DEBIAN/postinst" "$DEB_ROOT/DEBIAN/prerm"

    rm -f "$DEB_PATH"
    dpkg-deb --root-owner-group --build "$DEB_ROOT" "$DEB_PATH"
    DEB_SIZE=$(du -sh "$DEB_PATH" | awk '{print $1}')
    echo "  [OK] $DEB_PATH ($DEB_SIZE)"
  fi
fi

# .rpm —— 平台优先级：Mac 走 fpm（rpmbuild 在 Mac 上 brew 版不支持跨平台 build）；
# Linux 走 rpmbuild（更原生，spec 文件直接用）。两个都没就跳过 + 提示。
if [ "$WANT_RPM" = "1" ]; then
  IS_MAC=0
  [ "$(uname -s)" = "Darwin" ] && IS_MAC=1
  HAS_FPM=0
  HAS_RPMBUILD=0
  command -v fpm >/dev/null 2>&1 && HAS_FPM=1
  command -v rpmbuild >/dev/null 2>&1 && HAS_RPMBUILD=1

  # 选打包工具：Mac 强制 fpm（brew rpm 跨平台 build 走不通）；Linux 优先 rpmbuild
  USE_TOOL=""
  if [ "$IS_MAC" = "1" ]; then
    [ "$HAS_FPM" = "1" ] && USE_TOOL="fpm"
  else
    if [ "$HAS_RPMBUILD" = "1" ]; then USE_TOOL="rpmbuild"
    elif [ "$HAS_FPM" = "1" ]; then USE_TOOL="fpm"
    fi
  fi

  if [ -z "$USE_TOOL" ]; then
    echo
    echo "[4b]  跳过 .rpm: 缺打包工具"
    if [ "$IS_MAC" = "1" ]; then
      echo "      Mac 推荐用 fpm（brew rpm 不支持跨平台 build .rpm）："
      echo "        brew install fpm"
      echo "      或在 Linux/Docker 里跑这个脚本。"
    else
      echo "      openEuler/Anolis/Fedora/RHEL: sudo dnf install rpm-build"
      echo "      Ubuntu/Debian:                 sudo apt install rpm  或  sudo gem install fpm"
    fi
  else
    echo
    echo "[4b]  打 .rpm（使用 ${USE_TOOL}）..."

    # 准备 payload —— 两条路径共用
    PAYLOAD_DIR="$WORK_DIR/lingxi-ai-payload"
    rm -rf "$PAYLOAD_DIR"
    mkdir -p "$PAYLOAD_DIR/opt/lingxi-ai"
    if command -v rsync >/dev/null 2>&1; then
      # uninstall.sh 留着，方便用户 sudo bash /opt/lingxi-ai/uninstall.sh --purge 一键清
      rsync -a --exclude='install.sh' "$STAGING/" "$PAYLOAD_DIR/opt/lingxi-ai/"
    else
      ( cd "$STAGING" && tar --exclude='install.sh' -cf - . ) \
        | ( cd "$PAYLOAD_DIR/opt/lingxi-ai" && tar -xf - )
    fi

    rm -f "$RPM_PATH"

    if [ "$USE_TOOL" = "fpm" ]; then
      # 验证 fpm 是 jordansissel/fpm (Ruby gem)。Mac 上常见 PATH 有别的同名 fpm
      # (Fortran Package Manager / FreeBSD Ports Manager 等)，--help 不带 -s 选项。
      # Ruby fpm --version 输出形如 "1.15.1"；其它 fpm 的输出不会是 semver。
      FPM_PATH="$(command -v fpm)"
      FPM_VER="$("$FPM_PATH" --version 2>&1 | head -n1 | tr -d '\r')"
      if ! echo "$FPM_VER" | grep -qE '^[0-9]+\.[0-9]+(\.[0-9]+)?$'; then
        echo "[X] '$FPM_PATH' 不是 https://github.com/jordansissel/fpm（Ruby gem 打包工具）"
        echo "    fpm --version 输出: $FPM_VER"
        echo "    'fpm --help | head -3' 输出:"
        "$FPM_PATH" --help 2>&1 | head -3 | sed 's/^/      /'
        echo
        echo "    踩坑提示：brew 上的 'fpm' formula 实际是 Fortran Package Manager（同名不同物）。"
        echo "    jordansissel 那个 fpm 是 Ruby gem，不在 brew 里。两条装法选一："
        echo
        echo "    方案 1：用 Ruby gem 装（推荐）"
        echo "      brew install ruby                          # 装 brew 版 Ruby（自带的 macOS Ruby 已弃用）"
        echo "      \$(brew --prefix ruby)/bin/gem install fpm   # 用 brew Ruby 装 fpm gem"
        echo "      # 然后把 brew ruby 的 bin 加进 PATH，比如 zsh："
        echo "      #   echo 'export PATH=\"\$(brew --prefix ruby)/bin:\$PATH\"' >> ~/.zshrc"
        echo
        echo "    方案 2：换 nfpm（Go 写的 fpm 替代，brew install 不冲突）"
        echo "      brew install nfpm"
        echo "      （但本脚本暂未接入 nfpm；选这条要等支持）"
        echo
        echo "    装完用 'which fpm' 和 'fpm --version' 确认指向 Ruby 那版（输出 semver）后重跑。"
        exit 1
      fi
      echo "  fpm: $FPM_PATH (v$FPM_VER)"

      # 从 spec 抽 %post / %preun 内容写到 temp 脚本，给 fpm --after-install / --before-remove 用
      FPM_SCRIPTS="$WORK_DIR/fpm-scripts"
      mkdir -p "$FPM_SCRIPTS"
      POST_SH="$FPM_SCRIPTS/after-install.sh"
      PREUN_SH="$FPM_SCRIPTS/before-remove.sh"
      {
        echo "#!/bin/bash"
        # 抓 %post 到下一个 %xxx 标题之间，不含两端标题
        sed -n '/^%post$/,/^%[a-z]/{/^%[a-z]/d;p;}' "$SCRIPT_DIR/rpm/lingxi-ai.spec"
      } > "$POST_SH"
      {
        echo "#!/bin/bash"
        sed -n '/^%preun$/,/^%[a-z]/{/^%[a-z]/d;p;}' "$SCRIPT_DIR/rpm/lingxi-ai.spec"
      } > "$PREUN_SH"
      chmod +x "$POST_SH" "$PREUN_SH"

      # Mac 上 fpm 走 rpmbuild 后端时容易踩 rpmrc/平台不识别问题（exit code 为空），
      # 但 tar.gz / deb 已经产好，这里改成软失败：警告 + 给 Docker 备选方案，不中断整轮构建。
      set +e
      fpm -s dir -t rpm --force \
        --name "$PKG_NAME" \
        --version "$VERSION" \
        --iteration "1" \
        --architecture "$RPM_ARCH" \
        --prefix /opt/lingxi-ai \
        --description "Wenxiaozhou plugin for WPS Office (文小舟 WPS 插件)" \
        --license "Proprietary" \
        --url "https://github.com/lewis-hui1202/WPS-AI" \
        --maintainer "lingxi-ai <noreply@lingxi-ai.local>" \
        --depends coreutils \
        --rpm-auto-add-directories \
        --no-rpm-autoreqprov \
        --rpm-os linux \
        --after-install "$POST_SH" \
        --before-remove "$PREUN_SH" \
        -C "$PAYLOAD_DIR/opt/lingxi-ai" \
        -p "$RPM_PATH" \
        .
      FPM_STATUS=$?
      set -e
      if [ "$FPM_STATUS" != "0" ]; then
        echo
        echo "⚠️  [4b] fpm 打 .rpm 失败（exit=$FPM_STATUS）。tar.gz / deb 不受影响。"
        if [ "$IS_MAC" = "1" ]; then
          echo "    Mac 上 fpm 调 rpmbuild 经常踩 rpmrc 跨平台不识别的坑（brew 版 rpm 默认只认 Darwin 架构）。"
          echo "    推荐改走 Docker 容器路径，tar.gz/deb/rpm 一次出齐："
          echo "      cd upload-oss && npm run build:linux:docker"
          echo "    （首次会自动 docker build 镜像，约 2-5 分钟）"
        else
          echo "    检查 rpmbuild 报错日志；或换用 rpmbuild 直接打：apt 上 sudo apt install rpm。"
        fi
        rm -f "$RPM_PATH"
      fi
    else
      # ---- rpmbuild 路径 (Linux 原生) ----
      RPM_TOP="$WORK_DIR/rpmbuild"
      rm -rf "$RPM_TOP"
      mkdir -p "$RPM_TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
      ( cd "$WORK_DIR" && tar -czf "$RPM_TOP/SOURCES/lingxi-ai-payload-$VERSION.tar.gz" lingxi-ai-payload )
      cp "$SCRIPT_DIR/rpm/lingxi-ai.spec" "$RPM_TOP/SPECS/lingxi-ai.spec"
      set +e
      rpmbuild -bb "$RPM_TOP/SPECS/lingxi-ai.spec" \
        --define "_topdir $RPM_TOP" \
        --define "version $VERSION" \
        --define "buildarch $RPM_ARCH" \
        --target "$RPM_ARCH"
      RPMBUILD_STATUS=$?
      set -e
      if [ "$RPMBUILD_STATUS" != "0" ]; then
        echo
        echo "⚠️  [4b] rpmbuild 失败（exit=$RPMBUILD_STATUS）。tar.gz / deb 不受影响。"
        echo "    看上面 rpmbuild 报错；常见原因：缺 BuildRequires、spec 写错、跨平台 build。"
        rm -f "$RPM_PATH"
      else
        BUILT_RPM="$(find "$RPM_TOP/RPMS" -name '*.rpm' | head -n 1)"
        if [ -z "$BUILT_RPM" ]; then
          echo "⚠️  [4b] rpmbuild 跑完没找到 rpm 产物，跳过。"
        else
          cp "$BUILT_RPM" "$RPM_PATH"
        fi
      fi
    fi

    if [ -f "$RPM_PATH" ]; then
      RPM_SIZE=$(du -sh "$RPM_PATH" | awk '{print $1}')
      echo "  [OK] $RPM_PATH ($RPM_SIZE)"
    fi
  fi
fi

# 清 staging(保留 dist/)
rm -rf "$WORK_DIR"

echo
echo "============================================="
echo "  打包完成 🎉"
echo "============================================="
[ -f "$TARBALL_PATH" ] && echo "  tar.gz: $TARBALL_PATH"
[ -f "$DEB_PATH" ]     && echo "  deb:    $DEB_PATH"
[ -f "$RPM_PATH" ]     && echo "  rpm:    $RPM_PATH"
echo
echo "  本地测试:"
[ -f "$TARBALL_PATH" ] && {
  echo "    # tarball(任意发行版):"
  echo "    tar -xzf '$TARBALL_PATH' && cd ${PKG_NAME}-${VERSION} && bash install.sh"
  echo
}
[ -f "$DEB_PATH" ] && {
  echo "    # Ubuntu/Debian/Deepin/UOS/银河麒麟桌面版:"
  echo "    sudo dpkg -i '$DEB_PATH'"
  echo
}
[ -f "$RPM_PATH" ] && {
  echo "    # openEuler/Anolis/Fedora/RHEL/银河麒麟服务器/中标麒麟:"
  echo "    sudo dnf install '$RPM_PATH'   # 或 sudo yum install ..."
  echo
}
echo "============================================="
