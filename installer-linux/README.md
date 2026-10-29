# 文小舟 Linux Installer

打包 Linux 安装包，产出三种格式，覆盖国产 + 主流发行版：

| 格式 | 适用 |
|---|---|
| `.tar.gz` | 所有发行版通用（含龙芯 / 申威等，需自备 node） |
| `.deb` | Ubuntu / Debian / Deepin / 统信 UOS / 银河麒麟桌面版 / openKylin |
| `.rpm` | Fedora / RHEL / openEuler / Anolis / 银河麒麟服务器版 / 中标麒麟 |

## 打包

```bash
cd installer-linux
bash build.sh                    # 默认 x64，有什么工具就产什么（tar+deb+rpm）
bash build.sh --arch arm64       # 鲲鹏 / 飞腾
bash build.sh --arch loongarch64 # 龙芯（不带内置 node，装时用系统 node）
```

产物在 `dist/`。真正的安装/卸载逻辑在 [plugin/tools/post-install-linux.sh](../plugin/tools/post-install-linux.sh) / [pre-uninstall-linux.sh](../plugin/tools/pre-uninstall-linux.sh)。

> 更早版本的详细发行版兼容矩阵、安装内幕、已知坑等，见 git 历史。

## 用户安装 / 使用 / 排查

面向用户的安装包下载、各发行版安装步骤、常见问题，请访问官网：

👉 **https://wps-ai.llteac.cn/**
