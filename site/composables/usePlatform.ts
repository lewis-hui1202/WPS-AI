export type Platform = 'windows' | 'mac' | 'linux' | 'unknown'

export function detectPlatform(ua: string): Platform {
  const u = ua.toLowerCase()
  // 修 S3：iOS 设备的 UA 含 "like Mac OS X"，必须先排除 iphone/ipad/ipod，否则会被下面的
  // 'mac os' 判成 mac（桌面下载页对它没意义）。iPad 桌面模式 UA 可能只报 Macintosh，
  // 这种无法可靠区分，归入 mac 可接受。
  if (u.includes('iphone') || u.includes('ipod') || (u.includes('ipad') && !u.includes('macintosh'))) return 'unknown'
  if (u.includes('android')) return 'unknown'
  if (u.includes('windows') || u.includes('win64') || u.includes('win32')) return 'windows'
  if (u.includes('mac os') || u.includes('macintosh') || u.includes('darwin')) return 'mac'
  if (u.includes('linux')) return 'linux'
  return 'unknown'
}

export function usePlatform() {
  const platform = useState<Platform>('platform', () => 'unknown')

  if (import.meta.server) {
    const headers = useRequestHeaders(['user-agent'])
    platform.value = detectPlatform(headers['user-agent'] || '')
  } else {
    platform.value = detectPlatform(navigator.userAgent)
  }

  const setPlatform = (p: Platform) => { platform.value = p }
  return { platform, setPlatform }
}
