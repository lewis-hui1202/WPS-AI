#!/usr/bin/env node
const path = require('path')
const fs = require('fs')

const {
  loadConfig, createClient, buildKey, buildPluginZipKey, buildManifestKey,
  buildPublicUrl, uploadFile, uploadManifest, humanSize
} = require('./lib/client')
const { discoverArtifacts, resolveExplicitFiles, deriveOssKey } = require('./lib/discover')
const { buildPluginZip } = require('./lib/build-plugin-zip')
const { buildManifest } = require('./lib/build-manifest')
const { syncVersions } = require('./lib/sync-versions')
const { archiveOldArtifacts } = require('./lib/archive-old-artifacts')

async function loadPreviousManifestDownloads(client, manifestKey, version) {
  if (!client || !manifestKey) return {}
  try {
    const result = await client.get(manifestKey)
    const content = Buffer.isBuffer(result?.content)
      ? result.content.toString('utf8')
      : String(result?.content || '')
    const manifest = JSON.parse(content)
    const downloadVersion = manifest?.downloadVersion || manifest?.version
    if (downloadVersion !== version) {
      console.log(`  旧 manifest 下载版本为 ${downloadVersion || '(未知)'}，本次为 ${version}，不沿用旧下载项。`)
      return {}
    }
    return manifest && typeof manifest.downloads === 'object' ? manifest.downloads : {}
  } catch (err) {
    const code = err?.code || err?.name || ''
    if (!['NoSuchKey', 'NoSuchObject', 'NoSuchBucketError'].includes(code) && process.env.DEBUG) {
      console.warn(`[upload-oss] 读取旧 manifest 失败，downloads 将只使用本次上传结果：${err.message || err}`)
    }
    return {}
  }
}

async function loadPreviousManifest(client, manifestKey) {
  if (!client || !manifestKey) return null
  try {
    const result = await client.get(manifestKey)
    const content = Buffer.isBuffer(result?.content)
      ? result.content.toString('utf8')
      : String(result?.content || '')
    return JSON.parse(content)
  } catch (err) {
    const code = err?.code || err?.name || ''
    if (!['NoSuchKey', 'NoSuchObject', 'NoSuchBucketError'].includes(code) && process.env.DEBUG) {
      console.warn(`[upload-oss] 读取旧 manifest 失败：${err.message || err}`)
    }
    return null
  }
}

function normalizeOssSize(headResult) {
  const headers = headResult?.res?.headers || headResult?.headers || {}
  return Number(headers['content-length'] || headers['Content-Length'] || headResult?.size) || 0
}

async function listObjectsByPrefix(client, prefix) {
  const objects = []
  let marker = undefined
  while (true) {
    const result = await client.list({ prefix, marker, 'max-keys': 1000 })
    objects.push(...(result.objects || []))
    if (!result.isTruncated) break
    marker = result.nextMarker || result.nextContinuationToken
    if (!marker) break
  }
  return objects
}

function collectPrimaryFromRemoteObjects(cfg, version, objects) {
  const byKey = new Map()
  for (const obj of objects) {
    const filename = path.basename(obj.name || '')
    const platform = filename.endsWith('.exe')
      ? 'windows'
      : (filename.endsWith('.pkg') || filename.endsWith('.dmg') ? 'mac' : 'linux')
    const ossKey = deriveOssKey(filename, platform)
    if (!ossKey) continue
    if (ossKey === 'mac' && byKey.has('mac')) {
      const current = byKey.get('mac')
      if (current.filename.endsWith('.pkg')) continue
    }
    byKey.set(ossKey, {
      filename,
      url: buildPublicUrl(cfg, buildKey(cfg, version, filename)),
      size: Number(obj.size) || 0
    })
  }
  return byKey
}

async function fillRemoteSizes(client, cfg, version, byKey) {
  for (const info of byKey.values()) {
    if (info.size > 0) continue
    try {
      const head = await client.head(buildKey(cfg, version, info.filename))
      info.size = normalizeOssSize(head)
    } catch (err) {
      if (process.env.DEBUG) {
        console.warn(`[upload-oss] 读取 ${info.filename} size 失败：${err.message || err}`)
      }
    }
  }
}

function parseArgs(argv) {
  const opts = {
    configPath: path.resolve(__dirname, 'oss.config.js'),
    version: null,
    files: [],
    dryRun: false,
    skipUpdate: false,        // 跳过 plugin.zip + manifest.json
    onlyUpdate: false,        // 只跑 plugin.zip + manifest.json，不传安装包
    onlySiteManifest: false,  // 只根据 OSS 已有安装包刷新 manifest.downloads
    syncVersion: true,        // 跑前把 release.ts 的 VERSION 同步到 package.json / manifest.json / iss
    checkVersionOnly: false   // 只校验版本一致性，不真改文件（CI 用）
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-update-bundle') opts.skipUpdate = true
    else if (a === '--only-update-bundle') opts.onlyUpdate = true
    else if (a === '--only-site-manifest') {
      opts.onlySiteManifest = true
      opts.onlyUpdate = true
      opts.syncVersion = false
    }
    else if (a === '--no-sync-version') opts.syncVersion = false
    else if (a === '--check-version') { opts.checkVersionOnly = true; opts.syncVersion = false }
    else if (a === '--config') opts.configPath = path.resolve(argv[++i])
    else if (a === '--version' || a === '-v') opts.version = argv[++i]
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (a.startsWith('--')) {
      console.error(`未知参数：${a}`)
      printHelp()
      process.exit(1)
    } else {
      opts.files.push(a)
    }
  }
  return opts
}

function printHelp() {
  console.log(`用法：
  node index.js [files...] [options]

参数：
  files...               要上传的安装包路径（可多个）。不传则自动从
                         installer/dist/ 与 installer-mac/dist/ 扫描。

选项：
  --config <path>        指定配置文件，默认 ./oss.config.js
  --version, -v <ver>    覆盖默认版本号（默认从 site/utils/release.ts 读 VERSION）
  --dry-run              只打印不真正上传 / 不生成 plugin.zip
  --no-update-bundle     跳过 plugin.zip + manifest.json（只传安装包）
  --only-update-bundle   只跑 plugin.zip + manifest.json（不传任何安装包）
  --only-site-manifest   不传安装包/插件包，只根据 OSS 已有安装包刷新 manifest.downloads
  --no-sync-version      跳过把 release.ts 的 VERSION 同步到 package.json / iss / manifest
  --check-version        只校验所有版本号是否跟 release.ts 一致，不动文件（CI 用）
  -h, --help             显示帮助

产物：
  - 安装包      → <pathPrefix>/<version>/lingxi-ai-*.exe / .pkg / .dmg
  - plugin.zip → <pluginPathPrefix>/<version>/plugin.zip   （应用内热更新用）
  - manifest   → <manifestKey>（默认 <parent>/manifest.json，应用启动检查更新拉这个）
`)
}

function detectVersion() {
  const release = path.resolve(__dirname, '..', 'site', 'utils', 'release.ts')
  if (!fs.existsSync(release)) return null
  const m = fs.readFileSync(release, 'utf8').match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

function chromiumRuntimeConfig(cfg, previousManifest) {
  if (cfg && cfg.chromium && typeof cfg.chromium === 'object') return cfg.chromium
  if (previousManifest && previousManifest.chromium && typeof previousManifest.chromium === 'object') {
    return previousManifest.chromium
  }
  return null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = opts.version || detectVersion()
  if (!version) {
    console.error('无法确定版本号。请用 --version <ver> 指定，或确保 site/utils/release.ts 存在 VERSION 常量。')
    process.exit(1)
  }

  console.log(`\n=== 文小舟 安装包上传 (v${version})${opts.dryRun ? ' [dry-run]' : ''}${opts.onlySiteManifest ? ' [manifest-downloads-only]' : ''} ===\n`)

  // ---- 0. 版本号同步：release.ts → package.json / manifest.json / iss ----
  if (opts.checkVersionOnly) {
    const r = syncVersions(version, { check: true })
    console.log('版本一致性检查（不修改文件）：')
    r.unchanged.forEach((l) => console.log(`  ✓ ${l}  = ${version}`))
    r.mismatches.forEach((m) => console.log(`  ✗ ${m.label}  ${m.current} ≠ ${version}`))
    r.missing.forEach((l) => console.log(`  ? ${l}  缺失`))
    process.exit(r.mismatches.length > 0 || r.missing.length > 0 ? 1 : 0)
  }
  // 把 dist/ 里非本版本的旧产物搬到 distback/，避免扫到旧文件一起传
  if (!opts.dryRun && !opts.onlySiteManifest) archiveOldArtifacts(version)

  if (opts.syncVersion) {
    const r = syncVersions(version, { check: opts.dryRun })
    if (r.synced.length > 0) {
      console.log(`版本号已${opts.dryRun ? '[dry-run] 将' : ''}同步到 release.ts 的 v${version}：`)
      r.synced.forEach((s) => console.log(`  ✓ ${s.label}  ${s.from} → ${s.to}`))
    } else if (r.mismatches.length > 0 && opts.dryRun) {
      console.log(`[dry-run] 版本号待同步：`)
      r.mismatches.forEach((m) => console.log(`  ✗ ${m.label}  ${m.current} → ${version}`))
    }
    if (r.missing.length > 0) {
      console.warn(`⚠️ 以下文件未匹配到 version 字段，跳过：${r.missing.join(', ')}`)
    }
    console.log('')
  }

  const cfg = loadConfig(opts.configPath)
  console.log(`桶：${cfg.bucket} (${cfg.region})`)
  console.log(`路径前缀：${cfg.pathPrefix}/${version}/`)
  console.log(`下载域名：${cfg.cdnBaseUrl || `https://${cfg.bucket}.${cfg.region}.aliyuncs.com`}\n`)

  // ---- 1. 安装包：发现 / 上传 ----
  const artifacts = opts.onlyUpdate
    ? []
    : (opts.files.length > 0 ? resolveExplicitFiles(opts.files) : discoverArtifacts())

  if (!opts.onlyUpdate && artifacts.length === 0) {
    console.error('没有发现可上传的安装包。')
    console.error('  - 默认从 dist/ (Windows .exe) 与 installer-mac/dist/ (.pkg/.dmg) 扫描。')
    console.error('  - 也可以直接：node index.js <path-to-installer> ...')
    console.error('  - 只想发热更新包（plugin.zip + manifest）用：--only-update-bundle')
    process.exit(1)
  }

  if (artifacts.length > 0) {
    console.log('待上传安装包：')
    for (const a of artifacts) {
      const tag = a.isPrimary ? '主下载' : '附加'
      console.log(`  [${a.platform}] ${a.filename}  (${tag})`)
    }
    console.log('')
  }

  const client = opts.dryRun && !opts.onlySiteManifest ? null : createClient(cfg)
  // primaryUrls / primarySizes 用 ossKey 直接编址（windows / mac / linux-deb-x86_64 等 8 个）。
  // 由 discover.js 的 deriveOssKey 算出，写进 manifest.json 的 downloads —— 站点运行时从
  // manifest 读取真实 URL / 字节数。不再回写 site/utils/release.ts（该文件只留占位兜底）。
  const primaryUrls = {}
  const primarySizes = {}
  const primaryFiles = {}
  const allUploaded = []

  for (const a of artifacts) {
    const key = buildKey(cfg, version, a.filename)
    let result
    if (opts.dryRun) {
      result = await uploadFile(null, cfg, a.filePath, key, { dryRun: true })
    } else {
      result = await uploadFile(client, cfg, a.filePath, key)
    }
    allUploaded.push({ ...a, ...result })
    // windows / mac：取每个平台的 primary（第一个）
    // linux：每个 format×arch 是独立 ossKey，不存在多选 primary 的问题，按 ossKey 直接收
    if (a.ossKey) {
      if (a.platform === 'linux' || a.isPrimary) {
        primaryUrls[a.ossKey] = result.url
        primarySizes[a.ossKey] = result.size || 0
        primaryFiles[a.ossKey] = a.filename
      }
    }
  }

  if (allUploaded.length > 0) {
    console.log('\n=== 安装包上传结果 ===')
    for (const u of allUploaded) {
      console.log(`  [${u.platform}] ${u.filename}`)
      console.log(`    ${u.url}`)
    }
  }

  // ---- 2. plugin.zip + manifest.json （应用内自动更新）----
  let pluginUploadUrl = ''
  let pluginUploadSize = 0
  let manifestUploadUrl = ''
  if (opts.onlySiteManifest) {
    console.log('\n=== 刷新下载站 manifest.downloads ===')
    const prefix = `${[cfg.pathPrefix, version].filter(Boolean).join('/')}/`
    const manifestKey = buildManifestKey(cfg)
    const manifestUploadUrlPublic = buildPublicUrl(cfg, manifestKey)
    const previousManifest = await loadPreviousManifest(client, manifestKey)
    const previousDownloadVersion = previousManifest?.downloadVersion || previousManifest?.version
    const previousDownloads = previousDownloadVersion === version && typeof previousManifest.downloads === 'object'
      ? previousManifest.downloads
      : {}
    if (previousManifest && previousDownloadVersion !== version) {
      console.log(`  旧 manifest 下载版本为 ${previousDownloadVersion || '(未知)'}，本次为 ${version}，不沿用旧下载项。`)
    }

    const objects = await listObjectsByPrefix(client, prefix)
    const primaryByKey = collectPrimaryFromRemoteObjects(cfg, version, objects)
    await fillRemoteSizes(client, cfg, version, primaryByKey)

    if (primaryByKey.size === 0 && Object.keys(previousDownloads).length === 0) {
      console.error(`  未在 OSS 找到 ${prefix} 下的安装包对象，且无同版本旧 downloads 可保留。`)
      process.exit(1)
    }

    const remoteUrls = {}
    const remoteSizes = {}
    const remoteFiles = {}
    for (const [ossKey, info] of primaryByKey.entries()) {
      remoteUrls[ossKey] = info.url
      remoteSizes[ossKey] = info.size
      remoteFiles[ossKey] = info.filename
      console.log(`  ${ossKey} ← ${info.filename} (${humanSize(info.size)})`)
    }

    if (opts.dryRun) {
      console.log(`  [dry-run] manifest.json → oss://${cfg.bucket}/${manifestKey}`)
      manifestUploadUrl = manifestUploadUrlPublic
      pluginUploadUrl = previousManifest?.pluginUrl || ''
    } else {
      const projectRoot = path.resolve(__dirname, '..')
      const outDir = path.join(projectRoot, 'dist')
      const pluginVersion = previousManifest?.version || version
      const { manifestPath, manifest } = buildManifest({
        version: pluginVersion,
        pluginUrl: previousManifest?.pluginUrl || buildPublicUrl(cfg, buildPluginZipKey(cfg, version)),
        pluginSize: Number(previousManifest?.pluginSize) || 0,
        outDir,
        changelog: previousManifest?.changelog,
        // 保留 canary 灰度块 —— 之前 stable 发布会把 canary 冲掉，白名单用户就再也拿不到灰度版了
        previousCanary: previousManifest?.canary || null,
        chromium: chromiumRuntimeConfig(cfg, previousManifest),
        downloads: {
          urls: remoteUrls,
          sizes: remoteSizes,
          filenames: remoteFiles,
          previous: previousDownloads
        }
      })
      manifest.downloadVersion = version
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
      console.log(`  ✓ 生成 ${path.relative(projectRoot, manifestPath)}（downloads ${Object.keys(manifest.downloads || {}).length} 项）`)
      const r = await uploadManifest(client, cfg, manifestPath, manifestKey)
      manifestUploadUrl = r.url
      pluginUploadUrl = manifest.pluginUrl
    }
  } else if (!opts.skipUpdate) {
    console.log('\n=== 热更新包 (plugin.zip + manifest.json) ===')
    const projectRoot = path.resolve(__dirname, '..')
    const pluginRoot = path.join(projectRoot, 'plugin')
    const outDir = path.join(projectRoot, 'dist')


    const pluginZipKey = buildPluginZipKey(cfg, version)
    const manifestKey = buildManifestKey(cfg)
    // 拉一次完整旧 manifest，同时提取 downloads 和 canary（canary 一定要保留，
    // 否则灰度用户下次探测就掉回 stable）；旧 downloads 只在版本号相同时沿用。
    const previousManifestForUpdate = opts.dryRun ? null : await loadPreviousManifest(client, manifestKey)
    const previousDownloads = (() => {
      if (!previousManifestForUpdate) return {}
      const dv = previousManifestForUpdate.downloadVersion || previousManifestForUpdate.version
      if (dv !== version) {
        console.log(`  旧 manifest 下载版本为 ${dv || '(未知)'}，本次为 ${version}，不沿用旧下载项。`)
        return {}
      }
      return typeof previousManifestForUpdate.downloads === 'object' ? previousManifestForUpdate.downloads : {}
    })()
    const pluginZipPublicUrl = cfg.cdnBaseUrl
      ? `${cfg.cdnBaseUrl}/${pluginZipKey}`
      : `https://${cfg.bucket}.${cfg.region}.aliyuncs.com/${pluginZipKey}`

    if (opts.dryRun) {
      console.log(`  [dry-run] 跳过实际打 plugin.zip，模拟产物`)
      pluginUploadUrl = pluginZipPublicUrl
      pluginUploadSize = 0
    } else {
      console.log(`  打包 ${pluginRoot} → plugin-${version}.zip（排除 node_modules / runtime / .git / 等）...`)
      const zipInfo = buildPluginZip({ pluginRoot, version, outDir })
      console.log(`  ✓ 完成 ${path.relative(projectRoot, zipInfo.zipPath)} (${humanSize(zipInfo.size)})`)
      const r = await uploadFile(client, cfg, zipInfo.zipPath, pluginZipKey)
      pluginUploadUrl = r.url
      pluginUploadSize = r.size
    }

    // 生成 manifest（pluginUrl 指向刚上传的 plugin.zip）
    if (opts.dryRun) {
      console.log(`  [dry-run] manifest.json → oss://${cfg.bucket}/${manifestKey}`)
      console.log(`            version=${version}  pluginUrl=${pluginZipPublicUrl}`)
      manifestUploadUrl = cfg.cdnBaseUrl
        ? `${cfg.cdnBaseUrl}/${manifestKey}`
        : `https://${cfg.bucket}.${cfg.region}.aliyuncs.com/${manifestKey}`
    } else {
      const projectRoot2 = path.resolve(__dirname, '..')
      const outDir2 = path.join(projectRoot2, 'dist')
      const { manifestPath, manifest } = buildManifest({
        version,
        pluginUrl: pluginUploadUrl,
        pluginSize: pluginUploadSize,
        outDir: outDir2,
        previousCanary: previousManifestForUpdate?.canary || null,
        chromium: chromiumRuntimeConfig(cfg, previousManifestForUpdate),
        downloads: {
          urls: primaryUrls,
          sizes: primarySizes,
          filenames: primaryFiles,
          previous: previousDownloads
        }
      })
      console.log(`  ✓ 生成 ${path.relative(projectRoot2, manifestPath)}（changelog ${manifest.changelog.length} 字符，downloads ${Object.keys(manifest.downloads || {}).length} 项）`)
      const r = await uploadManifest(client, cfg, manifestPath, manifestKey)
      manifestUploadUrl = r.url
    }
  } else {
    console.log('\n（已跳过 plugin.zip + manifest.json：--no-update-bundle）')
  }

  // 下载站不再回写：真实下载地址 / 字节数只进 manifest.json，站点运行时读 manifest。
  // site/utils/release.ts 的 OSS_URLS / OSS_SIZES 仅为占位兜底，不由本工具维护。

  // ---- 3. 总结 ----
  if (manifestUploadUrl) {
    console.log('\n=== 应用内自动更新指向 ===')
    console.log(`  manifest:   ${manifestUploadUrl}`)
    console.log(`  plugin.zip: ${pluginUploadUrl}`)
    console.log('  确认 plugin/js/updater.js 里 DEFAULT_MANIFEST_URL 跟上面 manifest 一致。')
  }

  console.log('\n完成。')
}

main().catch((err) => {
  console.error('\n[upload-oss] 失败：', err.message || err)
  if (err.stack && process.env.DEBUG) console.error(err.stack)
  process.exit(1)
})
