<script setup lang="ts">
import { REPO_URL, RELEASE_PAGE } from '~/utils/release'

const { siteVersion, loadManifest } = useReleaseManifest()
// 修 S8：SSR 阶段 await 加载 manifest，让首屏版本徽章直接带最新版本，避免 hydration 后闪变。
await loadManifest().catch(() => {})
const localePath = useLocalePath()
const { messageObjectList } = useI18nMessages()
const { t } = useI18n()

useSeoMeta({
  title: () => t('index.head_title'),
  description: () => t('index.lead'),
  ogTitle: () => t('index.head_title'),
  ogDescription: () => t('index.lead'),
  twitterTitle: () => t('index.head_title'),
  twitterDescription: () => t('index.lead')
})

interface FeatureMessage {
  title: string
  desc: string
}

interface StatMessage {
  num: string
  label: string
  sub: string
}

// features: 从 i18n 取数组
const features = [
  { icon: 'layout' },
  { icon: 'cpu' },
  { icon: 'tool' },
  { icon: 'image' },
  { icon: 'chart' },
  { icon: 'package' }
]

const featureMessages = computed(() => messageObjectList<FeatureMessage>('index.features'))
const stats = computed(() => messageObjectList<StatMessage>('index.stats'))
</script>

<template>
  <section class="hero">
    <div class="container hero-inner">
      <div class="hero-text">
        <div class="badge">
          <Icon name="tag" :size="14" /> {{ $t('index.badge_released', { version: siteVersion }) }}
        </div>

        <h1>
          {{ $t('index.h1_1') }}<br />
          <span class="accent">{{ $t('index.h1_2') }}</span>
        </h1>
        <p class="lead">{{ $t('index.lead') }}</p>
        <p class="rename-notice">{{ $t('index.rename_notice') }}</p>

        <div style="margin-top: 32px; margin-bottom: 24px;">
          <NuxtLink class="btn-primary" :to="localePath('/download')" style="padding: 14px 28px; font-size: 16px;">
            <Icon name="download" :size="18" />
            <span>{{ $t('index.btn_download') }}</span>
          </NuxtLink>
        </div>

        <div class="alt-link">
          {{ $t('index.alt_link_prefix') }} <a :href="RELEASE_PAGE" target="_blank" rel="noopener">{{ $t('index.alt_link_github') }} <Icon name="external" :size="12" /></a>
        </div>
      </div>

      <aside class="hero-shot">
        <div class="window">
          <div class="window-bar">
            <span class="dot red"></span>
            <span class="dot yellow"></span>
            <span class="dot green"></span>
            <span class="window-title">{{ $t('index.window_title') }}</span>
          </div>
          <div class="window-body">
            <div class="msg user">{{ $t('index.msg_user') }}</div>
            <div class="msg ai">
              <div class="msg-head">{{ $t('index.msg_ai_name') }}</div>
              <div>{{ $t('index.msg_ai_status', { tool: 'insert_text' }) }}</div>
              <div class="tool-chip">
                <Icon name="tool" :size="12" /> insert_text
                <Icon name="check" :size="12" />
              </div>
            </div>
            <div class="composer">
              <span class="composer-placeholder">{{ $t('index.composer_placeholder') }}</span>
              <span class="composer-btn">
                <Icon name="send" :size="14" />
              </span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </section>

  <section class="container features">
    <h2>{{ $t('index.features_title') }}</h2>
    <div class="grid">
      <div v-for="(f, i) in features" :key="i" class="feature">
        <div class="f-ico"><Icon :name="f.icon" :size="26" /></div>
        <h3>{{ featureMessages[i]?.title }}</h3>
        <p>{{ featureMessages[i]?.desc }}</p>
      </div>
    </div>
  </section>

  <!-- 社区 & 反馈区块 -->
  <section class="container community">
    <div class="community-inner">
      <div class="community-text">
        <h2>{{ $t('index.community.title') }}</h2>
        <p class="community-lead" v-html="$t('index.community.lead')"></p>
        <ol class="community-steps">
          <li>
            <span class="community-step-num">1</span>
            <span>{{ $t('index.community.step1') }}</span>
          </li>
          <li>
            <span class="community-step-num">2</span>
            <span v-html="$t('index.community.step2')"></span>
          </li>
          <li>
            <span class="community-step-num">3</span>
            <span>{{ $t('index.community.step3') }}</span>
          </li>
        </ol>
      </div>
      <div class="community-qr">
        <div class="community-qr-wrap">
          <img src="/qrcode_for_gh.jpg" alt="QRCode" class="community-qr-img" />
          <p class="community-qr-label">{{ $t('index.community.qr_label') }}</p>
        </div>
      </div>
    </div>
  </section>

  <!-- 底部亮点 strip -->
  <section class="stats-strip">
    <div class="container stats-inner">
      <template v-for="(stat, idx) in stats" :key="idx">
        <div class="stat-item">
          <span class="stat-num">{{ stat.num }}</span>
          <span class="stat-label">{{ stat.label }}<br /><small>{{ stat.sub }}</small></span>
        </div>
        <div v-if="idx < stats.length - 1" class="stat-divider"></div>
      </template>
    </div>
  </section>
</template>
