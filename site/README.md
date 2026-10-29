# 文小舟 下载官网

Nuxt 3 单页下载站，托管在独立 `site/` 目录，**不进 git**（已在根 `.gitignore` 排除）。

## 运行

```bash
cd site
npm install
npm run dev          # http://localhost:3000
```

## 构建

```bash
npm run build        # 先 cleanup，再静态生成 → .output/public（site/dist 是它的软链接）
npm run build:ssr    # SSR 产物 → .output（Node 部署）
```

## 结构

```
site/
├── app.vue                       # 根组件
├── pages/index.vue               # 下载主页（含平台 tab）
├── composables/usePlatform.ts    # SSR + 浏览器 UA 识别
├── composables/useReleaseManifest.ts # 运行时读取 OSS manifest
├── utils/release.ts              # manifest 地址 / 版本号 / 下载链接兜底
├── assets/css/main.css           # WPS 蓝主色风格
├── public/favicon.svg            # 站点图标
└── nuxt.config.ts
```

## 发新版本

正常发布只需要跑 `upload-oss` 上传安装包和 `manifest.json`。
线上站点会在浏览器端读取 `https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/manifest.json`，用里面的 `version` 和 `downloads` 覆盖本地兜底数据。
只有页面样式、文案、交互变了，才需要重新 `npm run build` 并上传站点。

[utils/release.ts](utils/release.ts) 里的 `VERSION` / `OSS_URLS` / `OSS_SIZES` 是 manifest 拉取失败时的兜底值。

## 平台逻辑

- 通过 `User-Agent`（SSR 头 + 浏览器 navigator）自动选 Windows / macOS / Linux tab
- Windows / macOS / Linux 下载链接优先来自 OSS manifest，缺失时展示兜底值或「敬请期待」
- 用户可手动点 tab 切换
