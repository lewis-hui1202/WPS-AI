#!/usr/bin/env node
// 三端安装包打包入口，npm run build:win / build:mac / build:linux 调它。
//
// 流程：
//   1. 跑 syncVersions —— 把 release.ts 的 VERSION 写到 package.json / manifest.json / iss
//   2. 检查目标平台对应的 portable Node 是否就绪；缺就跑 plugin/tools/bundle-node.js 下载
//   3. 调对应原生构建脚本：
//        win   → ISCC.exe + installer/lingxi-ai.iss            产物 dist/lingxi-ai-<v>-setup.exe
//        mac   → bash installer-mac/build-dmg.sh                产物 dist/lingxi-ai-<v>-mac.dmg
//        linux → bash installer-linux/build.sh [--arch x64]     产物 dist/lingxi-ai-*-{tar.gz,deb,rpm}
//
// 用法：
//   node lib/build-installer.js win
//   node lib/build-installer.js mac
//   node lib/build-installer.js linux               # 默认 x64 全格式
//   node lib/build-installer.js linux --arch arm64

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const { syncVersions } = require('./sync-versions')
const { archiveOldArtifacts } = require('./archive-old-artifacts')

function readReleaseVersion() {
  const fp = path.join(ROOT, 'site', 'utils', 'release.ts')
  const m = fs.readFileSync(fp, 'utf8').match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
  if (!m) throw new Error('site/utils/release.ts 里找不到 VERSION')
  return m[1]
}

// 检查并按需补齐 plugin/runtime/node-<platform>/<binary>
// 缺就跑 plugin/tools/bundle-node.js 下载对应平台的 portable Node
function ensureNodeRuntime(platforms) {
  const map = {
    'win-x64':      { dir: 'node-win-x64',      probe: 'node.exe' },
    'darwin-x64':   { dir: 'node-darwin-x64',   probe: 'bin/node' },
    'darwin-arm64': { dir: 'node-darwin-arm64', probe: 'bin/node' },
    'linux-x64':    { dir: 'node-linux-x64',    probe: 'bin/node' },
    'linux-arm64':  { dir: 'node-linux-arm64',  probe: 'bin/node' }
  }
  const missing = []
  for (const p of platforms) {
    const cfg = map[p]
    if (!cfg) throw new Error(`不支持的平台 key：${p}`)
    const probe = path.join(ROOT, 'plugin', 'runtime', cfg.dir, cfg.probe)
    if (!fs.existsSync(probe)) missing.push(p)
  }
  if (missing.length === 0) return
  console.log(`[build] 缺少内置 Node 运行时：${missing.join(', ')}，调 bundle-node.js 下载...`)
  for (const p of missing) {
    const r = spawnSync(process.execPath, [
      path.join('tools', 'bundle-node.js'),
      '--platform', p
    ], { cwd: path.join(ROOT, 'plugin'), stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`bundle-node.js 下载 ${p} 失败`)
  }
}

function findISCC() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 5', 'ISCC.exe')
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

function buildWin(version) {
  if (process.platform !== 'win32') {
    console.error('[build:win] 必须在 Windows 上跑（依赖 Inno Setup ISCC.exe）')
    process.exit(1)
  }
  const iscc = findISCC()
  if (!iscc) {
    console.error('[build:win] 找不到 ISCC.exe。装 Inno Setup 6: https://jrsoftware.org/isdl.php')
    process.exit(1)
  }
  ensureNodeRuntime(['win-x64'])
  archiveOldArtifacts(version)
  console.log(`[build:win] ISCC: ${iscc}`)
  const issPath = path.join(ROOT, 'installer', 'lingxi-ai.iss')
  const r = spawnSync(iscc, [issPath], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
  console.log(`[build:win] ✓ dist/lingxi-ai-${version}-setup.exe`)
}

function buildMac(version) {
  if (process.platform !== 'darwin') {
    console.error('[build:mac] 必须在 macOS 上跑（依赖 pkgbuild / productbuild / hdiutil）')
    process.exit(1)
  }
  ensureNodeRuntime(['darwin-x64', 'darwin-arm64'])
  archiveOldArtifacts(version)
  const script = path.join(ROOT, 'installer-mac', 'build-dmg.sh')
  const r = spawnSync('bash', [script, '--version', version], {
    stdio: 'inherit',
    cwd: path.dirname(script)
  })
  if (r.status !== 0) process.exit(r.status || 1)
  console.log(`[build:mac] ✓ dist/lingxi-ai-${version}-mac.dmg / dist/lingxi-ai-${version}.pkg`)
}

// 跨架构容器预检：在 x86 主机上跑 arm64 镜像（或反过来）要靠 QEMU binfmt 模拟，
// 否则容器里连 bash 都起不来，报 "exec /usr/bin/bash: exec format error"。
// Docker Desktop 本该自带 QEMU，但 WSL2 后端 / 重启后 binfmt_misc 里的 qemu handler
// 会丢失。这里在跑目标容器前主动确认并按需注册，避免每次重启后手动补装。
//
// 注册是写进运行时内核 binfmt_misc 的，重启后失效——所以放在每次构建前做（幂等、命中即秒过）。
function ensureBinfmt(dockerPlatform) {
  const targetArch = dockerPlatform === 'linux/arm64' ? 'arm64' : 'amd64'

  // Docker 守护进程的原生架构。x86_64→amd64，aarch64→arm64。
  const info = spawnSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' })
  const hostArchRaw = (info.stdout || '').trim()
  const hostArch = /aarch64|arm64/.test(hostArchRaw) ? 'arm64' : 'amd64'

  // 原生架构，不需要模拟
  if (targetArch === hostArch) return

  // 查当前已注册的 handler；命中就跳过（避免每次都跑 --privileged 容器）
  const probe = spawnSync('docker', ['run', '--rm', '--privileged', 'tonistiigi/binfmt'], { encoding: 'utf8' })
  if (probe.status === 0 && new RegExp(`"linux/${targetArch}"`).test(probe.stdout || '')) {
    return // 已就绪
  }

  console.log(`[build:linux:docker] 主机是 ${hostArch}，要跑 ${targetArch} 容器——注册 QEMU ${targetArch} 模拟器...`)
  const install = spawnSync('docker', [
    'run', '--rm', '--privileged', 'tonistiigi/binfmt', '--install', targetArch
  ], { stdio: 'inherit' })
  if (install.status !== 0) {
    console.error(`[build:linux:docker] 注册 QEMU ${targetArch} 模拟器失败。手动执行：`)
    console.error(`   docker run --rm --privileged tonistiigi/binfmt --install ${targetArch}`)
    console.error('   若仍失败，确认 Docker Desktop 已勾选 "Use containerd" / 或重启 Docker Desktop 后重试。')
    process.exit(install.status || 1)
  }
}

// Docker 路径：把 build.sh 丢进 ubuntu:22.04 容器（带 dpkg-deb + rpmbuild + node 20），
// 输出 tar.gz / deb / rpm 三件套。Mac/Windows 上想全平台出 Linux 包就走这条。
function buildLinuxDocker(version, extraArgs) {
  const docker = spawnSync('docker', ['--version'], { stdio: 'ignore' })
  if (docker.status !== 0) {
    console.error('[build:linux:docker] 找不到 docker。装 Docker Desktop 或 Colima：')
    console.error('   Mac:     brew install --cask docker   或   brew install colima docker && colima start')
    console.error('   Windows: https://www.docker.com/products/docker-desktop/')
    process.exit(1)
  }

  // 目标架构 → Docker --platform 映射。Apple Silicon 上 Docker Desktop 默认起 ARM64 容器，
  // 容器里的 rpmbuild 没法跨 arch 打包（会报 "No compatible architectures found for build"），
  // 必须强制 --platform 跟构建目标对齐才能正常出 .rpm。
  const arch = (() => {
    const i = extraArgs.indexOf('--arch')
    return i >= 0 && extraArgs[i + 1] ? extraArgs[i + 1] : 'x64'
  })()
  // The packaging tools can emit arm64 archives from an amd64 builder.
  // Avoid executing arm64 userspace through QEMU on x86_64 Docker Desktop.
  const dockerPlatform = 'linux/amd64'

  // 镜像 tag 带 platform 后缀，免得 amd64 / arm64 镜像互相覆盖
  const imageTag = 'lingxi-ai-linux-build:amd64'
  const dockerCtx = path.join(ROOT, 'installer-linux')

  // 跨架构模拟必须在「docker build」之前就绪：build 的 RUN 步骤也在目标架构容器里跑，
  // 缺 QEMU 一样会报 "exec format error"。原生架构直接返回、零开销。
  // The builder is always amd64, so QEMU/binfmt registration is unnecessary.

  // 镜像不存在就 build（带 --platform 强制对齐架构）
  const inspect = spawnSync('docker', ['image', 'inspect', imageTag], { stdio: 'ignore' })
  if (inspect.status !== 0) {
    console.log(`[build:linux:docker] 镜像 ${imageTag} 不在，docker build 一下（首次约 2-5 分钟）...`)
    const b = spawnSync('docker', [
      'build', '--platform', dockerPlatform, '-t', imageTag, dockerCtx
    ], { stdio: 'inherit' })
    if (b.status !== 0) {
      console.error('[build:linux:docker] docker build 失败')
      process.exit(b.status || 1)
    }
  }

  // 镜像里没必要再下 portable Node —— build.sh 自己会调 bundle-node.js 下载到 plugin/runtime/
  // 这一步在容器里跑，下下来的 node-linux-x64 / arm64 会通过 volume 同步回宿主机
  archiveOldArtifacts(version)

  // -v 把整个仓库挂进 /work，容器内 /work/installer-linux/build.sh 直接跑
  // --user 让产物 ownership 跟宿主机一致（Mac/Linux），Windows 上 uid/gid 概念不通就跳
  const userArgs = process.platform === 'win32' ? [] : ['--user', `${process.getuid()}:${process.getgid()}`]
  const cmd = ['run', '--rm',
    '--platform', dockerPlatform,
    ...userArgs,
    '-v', `${ROOT}:/work`,
    '-w', '/work/installer-linux',
    imageTag,
    'bash', 'build.sh', '--version', version, ...extraArgs
  ]
  console.log(`[build:linux:docker] docker ${cmd.join(' ')}`)
  const r = spawnSync('docker', cmd, { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)

  // 报告实际产物（build.sh 里 .rpm 是软失败，可能没产出）
  const distDir = path.join(ROOT, 'dist')
  const archNorm = arch === 'arm64' ? 'arm64' : 'x64'
  const debArch = arch === 'arm64' ? 'arm64' : 'amd64'
  const rpmArch = arch === 'arm64' ? 'aarch64' : 'x86_64'
  const want = [
    { label: 'tar.gz', file: `lingxi-ai-${version}-linux-${archNorm}.tar.gz` },
    { label: 'deb',    file: `lingxi-ai_${version}_${debArch}.deb` },
    { label: 'rpm',    file: `lingxi-ai-${version}-1.${rpmArch}.rpm` }
  ]
  const got = want.filter((w) => fs.existsSync(path.join(distDir, w.file)))
  const missing = want.filter((w) => !fs.existsSync(path.join(distDir, w.file)))
  console.log(`[build:linux:docker] ✓ 产物: ${got.map((g) => g.label).join(', ') || '(无)'}`)
  if (missing.length > 0) {
    console.log(`[build:linux:docker] ⚠ 缺: ${missing.map((m) => m.label).join(', ')}（看上面构建日志）`)
  }
}

function buildLinux(version, extraArgs) {
  // --docker 标志：走容器路径（Mac/Windows 上想要 tar+deb+rpm 全产出就用这条）
  const dockerIdx = extraArgs.indexOf('--docker')
  if (dockerIdx >= 0) {
    extraArgs.splice(dockerIdx, 1)
    return buildLinuxDocker(version, extraArgs)
  }

  if (process.platform === 'win32') {
    console.error('[build:linux] Windows 上原生跑不了（依赖 dpkg-deb / rpmbuild）。')
    console.error('   选一条：')
    console.error('     - npm run build:linux:docker     # 走 Docker 容器，推荐')
    console.error('     - WSL 里跑 npm run build:linux   # 走原生')
    process.exit(1)
  }
  // arch 默认 x64，可通过 --arch 覆盖
  const arch = (() => {
    const i = extraArgs.indexOf('--arch')
    return i >= 0 && extraArgs[i + 1] ? extraArgs[i + 1] : 'x64'
  })()
  const platKey = arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  ensureNodeRuntime([platKey])
  archiveOldArtifacts(version)

  // Pre-flight：检查打包工具。注意 Mac 上 brew rpm 跨平台 build 不通（rpmrc 默认
  // 只识 Darwin 架构），所以 Mac 上 .rpm 必须走 fpm。Linux 上优先 rpmbuild + dpkg-deb。
  const has = (cmd) => spawnSync('command', ['-v', cmd], { shell: true }).status === 0
  const hasDpkg = has('dpkg-deb')
  const hasRpmbuild = has('rpmbuild')
  const hasFpm  = has('fpm')
  const canDeb = hasDpkg
  // Mac 上只信 fpm 打 rpm；Linux 上 rpmbuild / fpm 任一即可
  const canRpm = process.platform === 'darwin' ? hasFpm : (hasRpmbuild || hasFpm)

  if (!canDeb || !canRpm) {
    console.log('')
    console.log('⚠️  [build:linux] 缺工具，对应格式会被跳过：')
    if (!canDeb) console.log('     - .deb 需要 dpkg-deb')
    if (!canRpm) console.log(`     - .rpm 需要 ${process.platform === 'darwin' ? 'fpm (Mac 上 brew rpm 跨平台 build 走不通)' : 'rpmbuild 或 fpm'}`)
    console.log('')
    if (process.platform === 'darwin') {
      console.log('   Mac 装齐（需要 Homebrew）：')
      if (!canDeb) console.log('     brew install dpkg')
      if (!canRpm) {
        console.log('     # ⚠️ brew 上的 fpm 是 Fortran Package Manager（同名不同物），别装错')
        console.log('     brew install ruby')
        console.log('     $(brew --prefix ruby)/bin/gem install fpm')
        console.log('     # 加 brew ruby 到 PATH（zsh）：echo \'export PATH="$(brew --prefix ruby)/bin:$PATH"\' >> ~/.zshrc')
      }
    } else {
      console.log('   Linux 装齐：')
      if (!canDeb) console.log('     sudo apt install dpkg-dev   # Debian/Ubuntu')
      if (!canRpm) console.log('     sudo dnf install rpm-build  # Fedora/openEuler/Anolis  或  sudo apt install rpm  # Debian/Ubuntu  或  sudo gem install fpm')
    }
    console.log('   装完重跑 npm run build:linux 即可。')
    console.log('   坚持跑下去会只产 tar.gz（依然可分发，国产发行版能用）。')
    console.log('')
  }

  const script = path.join(ROOT, 'installer-linux', 'build.sh')
  const r = spawnSync('bash', [script, '--version', version, ...extraArgs], {
    stdio: 'inherit',
    cwd: path.dirname(script)
  })
  if (r.status !== 0) process.exit(r.status || 1)
  console.log(`[build:linux] ✓ dist/lingxi-ai-${version}-linux-${arch} (.tar.gz${canDeb ? ' / .deb' : ''}${canRpm ? ' / .rpm' : ''})`)
}

function main() {
  const argv = process.argv.slice(2)
  const target = argv[0]
  const rest = argv.slice(1)
  if (!['win', 'mac', 'linux'].includes(target)) {
    console.error('用法：node lib/build-installer.js <win|mac|linux> [extra args]')
    process.exit(1)
  }

  // 同步版本号（release.ts → package.json / manifest.json / iss）
  const version = readReleaseVersion()
  console.log(`\n=== build:${target} v${version} ===\n`)
  const r = syncVersions(version, { check: false })
  if (r.synced.length > 0) {
    console.log('版本号同步：')
    r.synced.forEach((s) => console.log(`  ✓ ${s.label}  ${s.from} → ${s.to}`))
    console.log('')
  }
  if (r.missing.length > 0) {
    console.warn(`⚠️ 未匹配 version 字段：${r.missing.join(', ')}`)
  }

  if (target === 'win')   buildWin(version)
  if (target === 'mac')   buildMac(version)
  if (target === 'linux') buildLinux(version, rest)
}

main()
