# 文小舟 Linux 打包用容器
# 在 Mac / Windows 上跑 Linux 包构建：tar.gz + .deb + .rpm 一次出齐
#
# 构建：
#   docker build -t lingxi-ai-linux-build:latest installer-linux/
# 跑：
#   docker run --rm -v "$(pwd)":/work -w /work/installer-linux \
#     lingxi-ai-linux-build:latest \
#     bash build.sh --version 1.4.1 --arch x64
#
# 一般用户直接 npm run build:linux:docker 即可（lib/build-installer.js 包了所有这些）。

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

# 基础工具 + dpkg-deb（.deb 用）+ rpm（.rpm 用，Ubuntu 仓库带 rpmbuild）
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget \
      tar gzip xz-utils rsync sed gawk findutils \
      dpkg dpkg-dev \
      rpm \
      file \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS —— bundle-node.js 跑构建要用
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

WORKDIR /work

# 验证打包工具就位
RUN dpkg-deb --version | head -1 \
    && rpmbuild --version

CMD ["bash"]
