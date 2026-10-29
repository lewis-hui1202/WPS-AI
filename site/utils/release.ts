export const VERSION = '1.4.8'
export const RELEASE_PAGE = 'https://github.com/lewis-hui1202/WPS-AI/releases'
export const REPO_URL = 'https://github.com/lewis-hui1202/WPS-AI'
export const MANIFEST_URL = 'https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/manifest.json'

export type DownloadKey = 'windows' | 'mac'
  | 'linux-deb-x86_64' | 'linux-rpm-x86_64' | 'linux-tar-x86_64'
  | 'linux-deb-aarch64' | 'linux-rpm-aarch64' | 'linux-tar-aarch64'

export interface ManifestDownload {
  filename?: string
  url?: string
  size?: number
  available?: boolean
}

export interface ReleaseManifest {
  version?: string
  downloadVersion?: string
  downloads?: Partial<Record<DownloadKey, ManifestDownload>>
}

// 下载地址 / 文件大小的运行时来源是 OSS 上的 manifest.json（见 MANIFEST_URL，由
// useReleaseManifest 在运行时拉取）。下面两个表只是 manifest 拉取失败时的占位兜底：
// 全空 → downloadInfo 的 available=false，前端显示"敬请期待"并保留 GitHub Releases 兜底链接。
// 发布工具 upload-oss 不再把真实 URL / 字节数回写到这里 —— 真实值只写进 manifest.json。
// 需要临时提供离线兜底时，可手动把对应项填成真实 URL / 字节数。
export const OSS_URLS: Record<DownloadKey, string> = {
  windows: '',
  mac: '',
  'linux-deb-x86_64': '',
  'linux-rpm-x86_64': '',
  'linux-tar-x86_64': '',
  'linux-deb-aarch64': '',
  'linux-rpm-aarch64': '',
  'linux-tar-aarch64': ''
}

export const OSS_SIZES: Record<DownloadKey, number> = {
  windows: 0,
  mac: 0,
  'linux-deb-x86_64': 0,
  'linux-rpm-x86_64': 0,
  'linux-tar-x86_64': 0,
  'linux-deb-aarch64': 0,
  'linux-rpm-aarch64': 0,
  'linux-tar-aarch64': 0
}
