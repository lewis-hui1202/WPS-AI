# 文小舟 macOS Installer

打包 macOS 安装包，产出 `lingxi-ai-<version>-mac.dmg`（内含 `.pkg`，双击走系统安装向导）。

## 打包

**必须在 macOS 上跑**（pkgbuild / productbuild / hdiutil 都是 Mac 自带），最低 macOS 10.15。

```bash
cd installer-mac
bash build-dmg.sh
```

首次会自动拉 darwin-x64 + darwin-arm64 两份内置 Node。产物：
- `dist/lingxi-ai-<version>-mac.dmg` —— 给用户的
- `dist/lingxi-ai-<version>.pkg` —— MDM / CI 部署用

发布前建议签名 + 公证（Developer ID）。真正的安装/卸载逻辑在 [plugin/tools/post-install-mac.sh](../plugin/tools/post-install-mac.sh) / [pre-uninstall-mac.sh](../plugin/tools/pre-uninstall-mac.sh) 与 [uninstall-all.sh](uninstall-all.sh)。

> 更早版本的详细安装内幕、签名/公证命令、已知坑等，见 git 历史。

## 用户安装 / 使用 / 排查

面向用户的安装包下载、安装步骤、常见问题，请访问官网：

👉 **https://wps-ai.llteac.cn/**
