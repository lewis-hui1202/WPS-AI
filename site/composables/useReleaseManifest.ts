import type { DownloadKey, ManifestDownload, ReleaseManifest } from '~/utils/release'
import { MANIFEST_URL, OSS_SIZES, OSS_URLS, VERSION } from '~/utils/release'

const DOWNLOAD_KEYS: DownloadKey[] = [
  'windows',
  'mac',
  'linux-deb-x86_64',
  'linux-rpm-x86_64',
  'linux-tar-x86_64',
  'linux-deb-aarch64',
  'linux-rpm-aarch64',
  'linux-tar-aarch64'
]

const DOWNLOAD_KEY_SET = new Set<string>(DOWNLOAD_KEYS)

// 修 S9：manifest 来自网络（MANIFEST_URL），其字段会被拼进 v-html / href。
// 在信任边界统一净化，避免被篡改的 manifest 注入脚本或 javascript: 链接。
function safeVersion(v: string): string {
  return v.replace(/[^\w.\-+]/g, '')
}
function safeFilename(v: string): string {
  return v.replace(/[^\w.\-+ ]/g, '')
}
function safeUrl(v: string): string {
  // 只允许 http(s) 绝对链接；其余（javascript:/data: 等）一律丢弃。
  return /^https?:\/\//i.test(v) ? v : ''
}

function normalizeDownload(value: unknown): ManifestDownload | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const url = typeof entry.url === 'string' ? safeUrl(entry.url) : ''
  const filename = typeof entry.filename === 'string' ? safeFilename(entry.filename) : ''
  const size = typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0
  const available = typeof entry.available === 'boolean' ? entry.available : !!url
  if (!url && !filename && !size) return null
  return { filename, url, size, available }
}

function normalizeManifest(value: unknown): ReleaseManifest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  let downloads: Partial<Record<DownloadKey, ManifestDownload>> | undefined

  if (raw.downloads && typeof raw.downloads === 'object') {
    downloads = {}
    for (const [key, entry] of Object.entries(raw.downloads as Record<string, unknown>)) {
      if (!DOWNLOAD_KEY_SET.has(key)) continue
      const normalized = normalizeDownload(entry)
      if (normalized) downloads[key as DownloadKey] = normalized
    }
  }

  const version = typeof raw.version === 'string' ? safeVersion(raw.version) : undefined
  const downloadVersion = typeof raw.downloadVersion === 'string' ? safeVersion(raw.downloadVersion) : undefined
  return { version, downloadVersion, downloads }
}

// 按 key 算 fallback 文件名：manifest 还没到货时让 SSR 也能渲染一个合理的名字，
// 客户端 hydration 之后 manifest 来了再覆盖。规则跟 build-manifest.js 写出来的一致。
function fallbackFilename(key: DownloadKey, version: string): string {
  switch (key) {
    case 'windows':            return `lingxi-ai-${version}-setup.exe`
    case 'mac':                return `lingxi-ai-${version}.pkg`
    case 'linux-deb-x86_64':   return `lingxi-ai_${version}_amd64.deb`
    case 'linux-deb-aarch64':  return `lingxi-ai_${version}_arm64.deb`
    case 'linux-rpm-x86_64':   return `lingxi-ai-${version}-1.x86_64.rpm`
    case 'linux-rpm-aarch64':  return `lingxi-ai-${version}-1.aarch64.rpm`
    case 'linux-tar-x86_64':   return `lingxi-ai-${version}-linux-x64.tar.gz`
    case 'linux-tar-aarch64':  return `lingxi-ai-${version}-linux-arm64.tar.gz`
  }
}

export function useReleaseManifest() {
  // 修 S1/S2/S8：改用 useState 而非模块级 ref。模块级 ref 在 SSR（长驻 Node 进程）下会
  // 跨请求共享 → 首个请求把 loaded 置 true 后永不再拉、且状态不进 payload，客户端 hydration
  // 从 null 重新开始 → 版本/文件名闪变（hydration mismatch）。useState 每请求隔离并序列化到
  // payload，客户端直接复用服务端结果，既不污染也不闪变。
  const manifest = useState<ReleaseManifest | null>('release-manifest', () => null)
  const loaded = useState<boolean>('release-manifest-loaded', () => false)
  const error = useState<string | null>('release-manifest-error', () => null)

  async function loadManifest() {
    if (loaded.value) return
    try {
      const response = await fetch(MANIFEST_URL, { cache: 'no-cache' })
      if (!response.ok) throw new Error(`manifest HTTP ${response.status}`)
      const normalized = normalizeManifest(await response.json())
      if (!normalized) throw new Error('manifest 格式无效')
      manifest.value = normalized
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loaded.value = true
    }
  }

  const siteVersion = computed(() => manifest.value?.downloadVersion || manifest.value?.version || VERSION)

  // 一站式读 manifest.downloads[key]：url / filename / size / available 都返回，
  // manifest 缺时退到编译期 OSS_URLS / OSS_SIZES + 按 version 拼出的 fallback 文件名。
  // 这样下载页 UI 不用再自己拼字符串，全走 manifest 数据驱动。
  function downloadInfo(key: DownloadKey): { url: string; filename: string; size: number; available: boolean } {
    const entry = manifest.value?.downloads?.[key]
    const version = siteVersion.value
    const url = entry?.url || OSS_URLS[key] || ''
    const filename = entry?.filename || fallbackFilename(key, version)
    // 修 S6：用 || 而非 ??。normalizeDownload 缺 size 时置 0（不是 undefined），
    // `0 ?? OSS_SIZES` 会得 0 跳过编译期 fallback，UI 显示不出已知体积。
    const size = entry?.size || OSS_SIZES[key] || 0
    const available = entry?.available ?? !!url
    return { url, filename, size, available }
  }

  // 兼容老调用点：只要 url 一个字段时用这个，内部走 downloadInfo。
  function downloadUrl(key: DownloadKey): string {
    return downloadInfo(key).url
  }

  return {
    manifest: readonly(manifest),
    siteVersion,
    loaded: readonly(loaded),
    error: readonly(error),
    loadManifest,
    downloadUrl,
    downloadInfo
  }
}
