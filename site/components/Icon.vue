<script setup lang="ts">
defineProps<{ name: string; size?: number | string }>()
</script>

<template>
  <svg
    class="icon"
    :width="size || 20"
    :height="size || 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'windows'">
      <rect x="3" y="4" width="8" height="8" />
      <rect x="13" y="4" width="8" height="8" />
      <rect x="3" y="14" width="8" height="8" />
      <rect x="13" y="14" width="8" height="8" />
    </template>

    <template v-else-if="name === 'globe'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </template>

    <template v-else-if="name === 'apple'">
      <path d="M16.5 12c0-2 1.6-3 1.6-3a3.5 3.5 0 0 0-2.8-1.6c-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.7-.7-1.4 0-2.7.8-3.4 2.1-1.5 2.5-.4 6.2 1 8.2.7 1 1.5 2 2.6 2 1.1 0 1.5-.7 2.8-.7 1.3 0 1.6.7 2.8.7 1.1 0 1.9-1 2.6-2a9 9 0 0 0 1.2-2.4c-2.7-1-2.7-3.3-2.7-3.3z" />
      <path d="M13 5c.4-.5 1-1.3 1-2-.9 0-1.9.6-2.4 1.2-.4.5-1 1.4-.9 2.2 1 .1 2-.5 2.3-1.4z" />
    </template>

    <template v-else-if="name === 'linux'">
      <ellipse cx="12" cy="13" rx="5" ry="7" />
      <circle cx="10" cy="11" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="14" cy="11" r="0.7" fill="currentColor" stroke="none" />
      <path d="M11 14c.5.4 1.5.4 2 0" />
      <path d="M8 19c-1 .5-2 1.5-2.5 2.5" />
      <path d="M16 19c1 .5 2 1.5 2.5 2.5" />
      <path d="M10 5.5c0-1 .5-2 2-2s2 1 2 2" />
    </template>

    <template v-else-if="name === 'download'">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </template>

    <template v-else-if="name === 'github'">
      <path d="M9 19c-4 1.5-4-2-6-2.5" />
      <path d="M15 22v-3.5a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6a4.7 4.7 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.4 0C5.9 1.4 4.8 1.7 4.8 1.7a4.3 4.3 0 0 0-.1 3.2A4.7 4.7 0 0 0 3.4 8.2c0 4.6 2.8 5.6 5.5 6a3 3 0 0 0-.9 2.3V22" />
    </template>

    <template v-else-if="name === 'file-text'">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
      <path d="M9 9h2" />
    </template>

    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </template>

    <template v-else-if="name === 'alert'">
      <path d="M10.3 3.7L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </template>

    <template v-else-if="name === 'arrow-right'">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </template>

    <template v-else-if="name === 'check'">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </template>

    <template v-else-if="name === 'send'">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </template>

    <template v-else-if="name === 'tool'">
      <path d="M14.7 6.3a4 4 0 0 0 5.4 5.4l-7.4 7.4a2 2 0 0 1-2.8-2.8z" />
      <path d="M3 21l6-6" />
    </template>

    <template v-else-if="name === 'cpu'">
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </template>

    <template v-else-if="name === 'layout'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M14 4v16" />
      <path d="M3 10h11" />
    </template>

    <template v-else-if="name === 'image'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M21 16l-5-5-9 9" />
    </template>

    <template v-else-if="name === 'file-pdf'">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8 14h1.5a1.2 1.2 0 1 1 0 2.5H8z" />
      <path d="M8 14v5" />
      <path d="M12.5 14h1.5a2 2 0 0 1 0 4h-1.5z" />
      <path d="M16.5 14h2.5" />
      <path d="M16.5 14v5" />
      <path d="M16.5 16.5h2" />
    </template>

    <template v-else-if="name === 'sparkles'">
      <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />
      <path d="M19 16l.7 1.8L21.5 18l-1.8.7L19 20.5l-.7-1.8L16.5 18l1.8-.7z" />
      <path d="M5 4l.5 1.3L7 6l-1.5.5L5 8l-.5-1.5L3 6l1.5-.7z" />
    </template>

    <template v-else-if="name === 'chart'">
      <path d="M3 21h18" />
      <rect x="6" y="12" width="3" height="6" />
      <rect x="11" y="8" width="3" height="10" />
      <rect x="16" y="4" width="3" height="14" />
    </template>

    <template v-else-if="name === 'package'">
      <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
      <path d="M3 7l9 4 9-4" />
      <path d="M12 11v10" />
    </template>

    <template v-else-if="name === 'external'">
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
    </template>

    <template v-else-if="name === 'menu'">
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </template>

    <template v-else-if="name === 'chevron-right'">
      <path d="M9 6l6 6-6 6" />
    </template>

    <template v-else-if="name === 'tag'">
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="8" cy="8" r="1.3" />
    </template>

    <template v-else-if="name === 'home'">
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </template>
  </svg>
</template>

<style scoped>
.icon { display: inline-block; vertical-align: -0.18em; flex-shrink: 0; }
</style>
