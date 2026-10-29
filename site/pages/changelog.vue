<script setup lang="ts">
const { t } = useI18n()
const { messageObjectList } = useI18nMessages()

interface ChangelogSection {
  type: string
  items: string[]
}

interface ChangelogRelease {
  version: string
  date: string
  tag?: string
  summary: string
  rename_fixes?: string[]
  sections: ChangelogSection[]
}

useSeoMeta({
  title: () => t('changelog.head_title'),
  description: () => t('changelog.lead'),
  ogTitle: () => t('changelog.head_title'),
  ogDescription: () => t('changelog.lead'),
  twitterTitle: () => t('changelog.head_title'),
  twitterDescription: () => t('changelog.lead')
})

const changelog = computed(() => messageObjectList<ChangelogRelease>('changelog.releases'))
</script>

<template>
  <div class="container changelog-wrap">
    <div class="hero-text" style="text-align: center; margin-bottom: 64px;">
      <div class="badge">
        <Icon name="clock" :size="14" /> {{ $t('changelog.badge') }}
      </div>
      <h1 style="font-size: 32px; margin-bottom: 16px;">{{ $t('changelog.h1') }}</h1>
      <p class="lead" style="max-width: 600px; margin: 0 auto;">{{ $t('changelog.lead') }}</p>
    </div>

    <div class="timeline">
      <div v-for="release in changelog" :key="release.version" class="release">
        <div class="version-dot"></div>
        <div class="release-head">
          <h2>v{{ release.version }}</h2>
          <span v-if="release.tag === 'latest'" class="ver-tag latest">{{ $t('changelog.latest') }}</span>
          <span v-if="release.tag === 'beta'" class="ver-tag beta">{{ $t('changelog.beta') }}</span>
          <span class="muted" style="margin-left: auto;">{{ release.date }}</span>
        </div>
        <p class="release-summary">{{ release.summary }}</p>

        <div v-if="release.rename_fixes?.length" class="release-section">
          <h3>{{ $t('changelog.sections.fixes') }}</h3>
          <ul>
            <li v-for="(item, idx) in release.rename_fixes" :key="`rename-fix-${idx}`">
              <Icon name="check" :size="14" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <div v-for="(sec, sIdx) in release.sections" :key="sIdx" class="release-section">
          <h3>{{ $t('changelog.sections.' + sec.type) }}</h3>
          <ul>
            <li v-for="(item, idx) in sec.items" :key="idx">
              <Icon name="check" :size="14" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
