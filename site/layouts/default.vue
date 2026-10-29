<script setup lang="ts">
import { REPO_URL } from '~/utils/release'

const route = useRoute()
const localePath = useLocalePath()
const switchLocalePath = useSwitchLocalePath()
const { locale } = useI18n()

const isActive = (path: string) => route.path === localePath(path) || route.path === localePath(path) + '/'
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="container topbar-inner">
        <NuxtLink class="brand" :to="localePath('/')">
          <img class="brand-mark" src="/logo.png" alt="文小舟 Logo" />
          <span class="brand-text">
            <span class="brand-name">文小舟</span>
            <span class="brand-sub">{{ $t('nav.brand_sub') }}</span>
          </span>
        </NuxtLink>

        <nav class="nav">
          <NuxtLink :to="localePath('/')" :class="{ active: isActive('/') }">
            <Icon name="home" :size="16" /> {{ $t('nav.home') }}
          </NuxtLink>
          <NuxtLink :to="localePath('/download')" :class="{ active: isActive('/download') }">
            <Icon name="download" :size="16" /> {{ $t('nav.download') }}
          </NuxtLink>
          <NuxtLink :to="localePath('/docs')" :class="{ active: isActive('/docs') }">
            <Icon name="file-text" :size="16" /> {{ $t('nav.docs') }}
          </NuxtLink>
          <NuxtLink :to="localePath('/changelog')" :class="{ active: isActive('/changelog') }">
            <Icon name="clock" :size="16" /> {{ $t('nav.changelog') }}
          </NuxtLink>
        </nav>

        <div class="top-actions">
          <a :href="REPO_URL" target="_blank" rel="noopener" class="top-btn top-btn-dark">
            <Icon name="github" :size="14" />
            <span>{{ $t('nav.github') }}</span>
            <Icon name="external" :size="11" />
          </a>
          <NuxtLink 
            :to="switchLocalePath(locale === 'zh' ? 'en' : 'zh')" 
            class="top-btn lang-switch"
            style="background: var(--bg-soft); color: var(--ink-2); padding: 0 10px;"
          >
            <Icon name="globe" :size="14" />
            <span>{{ locale === 'zh' ? 'EN' : '中' }}</span>
          </NuxtLink>
        </div>
      </div>
    </header>

    <main>
      <slot />
    </main>

    <footer class="footer">
      <div class="container footer-inner">
        <div>{{ $t('footer.copy', { year: new Date().getFullYear() }) }}</div>
        <div class="footer-links">
          <NuxtLink :to="localePath('/download')">{{ $t('nav.download') }}</NuxtLink>
          <NuxtLink :to="localePath('/docs')">{{ $t('nav.docs') }}</NuxtLink>
          <NuxtLink :to="localePath('/changelog')">{{ $t('nav.changelog') }}</NuxtLink>
          <a :href="REPO_URL" target="_blank" rel="noopener">GitHub</a>
        </div>
      </div>
    </footer>
  </div>
</template>
