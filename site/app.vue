<script setup lang="ts">
// i18n SEO：注入 <html lang>、hreflang alternate（zh / en / x-default）与 canonical。
// 需 nuxt.config i18n.baseUrl 提供绝对域名。
const i18nHead = useLocaleHead({ dir: true, lang: true, seo: true })

// 结构化数据：SoftwareApplication，帮助搜索引擎理解「这是一个免费跨平台软件」并出富摘要。
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: '文小舟 (Wenxiaozhou)',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Windows, macOS, Linux',
  description:
    '嵌入 WPS Office 的 AI 助手：一个 TaskPane 覆盖文字 / 表格 / 演示 / PDF 四端，挂多家大模型（Codex / OpenAI / Anthropic / Gemini / Azure / OpenAI 兼容），AI 通过工具调用直接读写文档。',
  url: 'https://wps-ai.llteac.cn',
  downloadUrl: 'https://wps-ai.llteac.cn/download',
  softwareVersion: '1.4.x',
  inLanguage: ['zh-CN', 'en'],
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' }
}

useHead(() => ({
  htmlAttrs: i18nHead.value.htmlAttrs || {},
  link: i18nHead.value.link || [],
  meta: i18nHead.value.meta || [],
  script: [
    { type: 'application/ld+json', innerHTML: JSON.stringify(jsonLd) }
  ]
}))
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
