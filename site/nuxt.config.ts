import { VERSION } from './utils/release'

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  ssr: true,
  // Windows 上 Nuxt 默认会把 dev server 绑到 IPv6 `[::1]` 上，但 Edge / Chrome 在
  // localhost 解析时优先走 IPv4，于是浏览器打开 http://localhost:3000 一片白屏。
  // 强制走 IPv4 0.0.0.0 / 127.0.0.1，IPv6 也能正常 reuse loopback。
  devServer: {
    host: '127.0.0.1',
    port: 3000
  },
  // 注：不在这里设 nitro.preset='static' —— 那会让 dev 也走 static preset。
  // `nuxt generate` 命令本身内部会切 nitro 到 static，产物就是 .output/public/
  // 纯静态站（根目录 index.html），可直接丢任何静态托管。
  //
  // 关 appManifest：Nuxt 3.21 + Vite 7 组合下 `#app-manifest` 虚模块解析有 bug
  // （console 一直刷 Pre-transform error）。这个特性只在客户端做版本检测+路由 hash
  // 校验用，咱们站没用到，关了 dev 干净。
  experimental: {
    appManifest: false
  },
  app: {
    buildAssetsDir: `/_nuxt/v${VERSION}/`,
    head: {
      title: '文小舟 · WPS Office 多宿主 AI 助手 · 下载',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content: '文小舟：一个 TaskPane 兼容 WPS 文字 / 表格 / 演示 / PDF 四端，挂多家 AI（Codex / OpenAI / Anthropic / Gemini / Azure / OpenAI 兼容）+ MCP 双向，AI 通过工具调用直接读写文档。'
        },
        // 站点级常量 OG / Twitter（逐页 title/description/url 由各页 useSeoMeta 覆盖）
        { property: 'og:site_name', content: '文小舟 · WPS Office AI 助手' },
        { property: 'og:type', content: 'website' },
        { property: 'og:image', content: 'https://wps-ai.llteac.cn/og-cover.png' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:image', content: 'https://wps-ai.llteac.cn/og-cover.png' }
      ],
      link: [
        { rel: 'icon', type: 'image/png', href: '/logo.png' }
      ]
    }
  },
  css: ['~/assets/css/main.css'],
  modules: ['@nuxtjs/i18n'],
  i18n: {
    // SEO 需要绝对 URL：hreflang alternate / canonical / og:url 都基于它拼。
    baseUrl: 'https://wps-ai.llteac.cn',
    restructureDir: false,
    bundle: {
      optimizeTranslationDirective: false
    },
    locales: [
      // language：ISO 码，useLocaleHead 生成 hreflang alternate 链接必需（v9 由 iso 改名 language）
      { code: 'zh', language: 'zh-CN', file: 'zh.json', name: '简体中文' },
      { code: 'en', language: 'en', file: 'en.json', name: 'English' }
    ],
    lazy: true,
    langDir: 'locales',
    defaultLocale: 'zh',
    strategy: 'prefix_except_default' // 中文保持在 /，英文在 /en
  }
})
