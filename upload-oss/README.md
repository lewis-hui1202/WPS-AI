# upload-oss

把文小舟 安装包（Windows `.exe` / macOS `.pkg` / `.dmg` / Linux 包）上传到阿里云 OSS，
并把最新版本、下载地址、文件大小写入 `manifest.json`。

## 一次性配置

```bash
cd upload-oss
npm install
cp oss.config.example.js oss.config.js
# 编辑 oss.config.js，填入 region / accessKey / bucket。
# oss.config.js 已被 .gitignore，不会提交。
```

建议在 RAM 控制台单建一个**仅有目标 Bucket 写权限**的子账号，不要用主账号 AK。

## 用法

```bash
# 默认：自动从 installer/dist/ 和 installer-mac/dist/ 扫描产物
npm run upload

# 只想看会上传什么、会改什么，不真的传
npm run upload:dry

# 上传，但不回写 site/utils/release.ts 的兜底下载地址
npm run upload:no-site

# 安装包已经在 OSS 上时，只刷新 manifest.json 里的下载站字段
npm run upload:site -- --version 1.4.0

# 只查看会从 OSS 读取哪些安装包、会更新哪个 manifest，不真正写入
npm run upload:site:dry -- --version 1.4.0

# 显式指定文件
node index.js ../installer/dist/lingxi-ai-1.3.0-setup.exe ../installer-mac/dist/lingxi-ai-1.3.0.pkg

# 覆盖版本号
node index.js -v 1.3.1
```

## 行为

1. **扫描产物**
   - Windows：`installer/dist/*-setup.exe`
   - macOS：`installer-mac/dist/*.{pkg,dmg}`（`.pkg` 优先作为主下载）
2. **分片上传到 OSS**
   - Key 规则：`{pathPrefix}/{version}/{filename}`
   - 默认 1 MB 分片、4 并发，大文件无问题
   - 上传时附 `Cache-Control` + `Content-Disposition: attachment` 头，
     让浏览器把 .exe / .pkg / .dmg 当附件下载
3. **生成并上传 manifest.json**
   - 写入插件热更新字段：`version` / `pluginUrl` / `pluginSize` / `changelog`
   - 写入下载站字段：`downloadVersion` 和 `downloads.{windows,mac,linux-*}.{filename,url,size,available}`
   - 上传到 `manifestKey`，默认是 `wps-ai/manifest.json`
   - 下载站运行时直接读取 `https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/manifest.json`，只改版本/下载包时不用重新打包上传站点
4. **回写下载站兜底链接**
   - 默认仍会修改 [site/utils/release.ts](../site/utils/release.ts) 中由标记
     `// region OSS_URLS_BEGIN` … `// endregion OSS_URLS_END` 包裹的区块
   - 这只是远端 manifest 读取失败时的兜底数据，可用 `--no-site-update` 跳过

## 只刷新下载站 manifest

`npm run upload:site -- --version <ver>` 适合安装包已经通过别的机器/流程上传到 OSS 后，只补写下载站需要的 manifest 数据：

- 不扫描本地 `dist/`
- 不上传安装包
- 不打包或上传 `plugin.zip`
- 不改写 `site/utils/release.ts`
- 会列出 `{pathPrefix}/{version}/` 下已有对象，按文件名生成下载 URL 和真实 size
- 会沿用旧 manifest 的插件热更新字段，避免只刷新下载链接时触发插件自动更新

如果同一个版本分多台机器上传，后执行的 `upload:site` 会保留同版本旧 manifest 里的其他平台下载项；如果版本不同，则不会沿用旧下载项。

## 配置项一览

见 [oss.config.example.js](oss.config.example.js)。关键字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `region` | ✅ | OSS 区域，如 `oss-cn-hangzhou` |
| `accessKeyId` / `accessKeySecret` | ✅ | RAM 子账号 AK |
| `bucket` | ✅ | 目标桶 |
| `endpoint` | ⭕ | 走内网 / 自定义域名时填 |
| `cdnBaseUrl` | ⭕ | 自定义 CDN 域名，写回 site 的 URL 会用它 |
| `pathPrefix` | ⭕ | 桶内路径前缀，默认 `releases` |
| `multipart` | ⭕ | `{ partSize, parallel }` |
| `headers` | ⭕ | 上传时附加 HTTP 头 |

## manifest CORS

下载站是在浏览器里直接 `fetch()` OSS 上的 `manifest.json`，所以主桶必须配置 CORS：

- 来源：线上站点实际 Origin，例如 `https://www.llteac.cn`；如果根域也访问，另加 `https://llteac.cn`
- 本地调试：按端口显式加 `http://localhost:3000`、`http://127.0.0.1:3000`、`http://localhost:4173`、`http://127.0.0.1:4173`
- Methods：`GET`
- Headers / 暴露 Headers：可留空

注意 `*.llteac.cn` 只覆盖子域名，不覆盖 `llteac.cn` 根域；`localhost` / `127.0.0.1` 也需要带协议和端口才能匹配浏览器的 Origin。

## 文件结构

```
upload-oss/
├── package.json              # 仅依赖 ali-oss
├── oss.config.example.js     # 配置模板（进 git）
├── oss.config.js             # 真实配置（不进 git）
├── index.js                  # CLI 入口
├── lib/
│   ├── client.js             # ali-oss 封装：分片上传 + 公网 URL 推算
│   ├── discover.js           # 扫描 installer*/dist 找产物
│   └── update-site.js        # 改写 site/utils/release.ts 标记区块
└── README.md
```

## 与 GitHub Releases 共存

下载站优先使用 OSS 上的 `manifest.json`，读取失败时才使用 `release.ts` 里的 `OSS_URLS` / `OSS_SIZES` 兜底。
所以即便没上 OSS，下载站也能正常跑，只是不会拿到运行时最新下载信息。
