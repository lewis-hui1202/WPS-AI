<script setup lang="ts">
import { RELEASE_PAGE, REPO_URL } from '~/utils/release'

const { siteVersion, downloadInfo, loadManifest } = useReleaseManifest()
// 让 SSR 等 manifest 加载完，首屏 HTML 就带最新的 url / filename / size。
// 失败也无所谓，composable 内部会 fallback 到编译期 OSS_URLS / OSS_SIZES。
await loadManifest().catch(() => {})

const { t } = useI18n()
const { messageList } = useI18nMessages()

useSeoMeta({
  title: () => t('download.head_title'),
  description: () => t('download.lead'),
  ogTitle: () => t('download.head_title'),
  ogDescription: () => t('download.lead'),
  twitterTitle: () => t('download.head_title'),
  twitterDescription: () => t('download.lead')
})

// 修 S4：接入自动平台检测，而不是硬编码 windows。detectPlatform 产出 'mac'/'linux'/'windows'，
// 本页的 tab 用 'macos'，这里做一次映射对齐（否则 mac 访客永远匹配不上，只能看到 Windows tab）。
const { platform: detected } = usePlatform()
const mapPlatform = (p: string) => (p === 'mac' ? 'macos' : p === 'linux' ? 'linux' : 'windows')
const platform = ref(mapPlatform(detected.value))
const linuxArch = ref('x86_64')

// 全部 url / filename / size 走 manifest.downloads；composable 会自动选 manifest 还是 fallback。
const winInfo = computed(() => downloadInfo('windows'))
const macInfo = computed(() => downloadInfo('mac'))
const linuxTarInfo = computed(() => downloadInfo(linuxArch.value === 'x86_64' ? 'linux-tar-x86_64' : 'linux-tar-aarch64'))

const winSetupFile = computed(() => winInfo.value.filename)
const macPkgFile = computed(() => macInfo.value.filename)
const linuxTarFile = computed(() => linuxTarInfo.value.filename)
const winDownloadUrl = computed(() => winInfo.value.url)
const macDownloadUrl = computed(() => macInfo.value.url)
const linuxTarUrl = computed(() => linuxTarInfo.value.url)

const winSteps = computed(() => messageList('download.win_steps'))
const macSteps = computed(() => messageList('download.mac_steps'))
const linuxSteps = computed(() => messageList('download.linux_steps'))
const winReqs = computed(() => messageList('download.win_req'))
const macReqs = computed(() => messageList('download.mac_req'))
const linuxReqs = computed(() => messageList('download.linux_req'))

const linuxFormats = computed(() => {
  const isX86 = linuxArch.value === 'x86_64'
  const deb = downloadInfo(isX86 ? 'linux-deb-x86_64' : 'linux-deb-aarch64')
  const rpm = downloadInfo(isX86 ? 'linux-rpm-x86_64' : 'linux-rpm-aarch64')
  return [
    { fmt: 'deb', url: deb.url, filename: deb.filename, size: deb.size, available: deb.available },
    { fmt: 'rpm', url: rpm.url, filename: rpm.filename, size: rpm.size, available: rpm.available }
  ]
})
</script>

<template>
  <div class="page-download">
    <section class="hero hero-download">
      <div class="container hero-inner" style="grid-template-columns: 1fr; text-align: center;">
        <div class="hero-text" style="max-width: 800px; margin: 0 auto;">
          <div class="badge">
            <Icon name="download" :size="14" /> {{ $t('download.badge_download', { version: siteVersion }) }}
          </div>
          <h1>{{ $t('download.h1') }}</h1>
          <p class="lead">{{ $t('download.lead') }}</p>

          <div class="platform-tabs" style="justify-content: center; margin-top: 32px;">
            <button class="tab" :class="{ active: platform === 'windows' }" @click="platform = 'windows'">
              <Icon name="windows" :size="16" /> Windows
            </button>
            <button class="tab" :class="{ active: platform === 'macos' }" @click="platform = 'macos'">
              <Icon name="apple" :size="16" /> macOS
            </button>
            <button class="tab" :class="{ active: platform === 'linux' }" @click="platform = 'linux'">
              <Icon name="linux" :size="16" /> Linux
            </button>
          </div>

          <div class="download-cards">
            <!-- Windows Card -->
            <div v-if="platform === 'windows'" class="cta-card active">
              <div class="cta-info">
                <div class="cta-filename">{{ winSetupFile }}</div>
                <div class="cta-meta">x86_64 · {{ $t('download.cta_size_note') }}</div>
              </div>
              <a v-if="winInfo.available && winDownloadUrl" :href="winDownloadUrl" class="btn-primary">
                <Icon name="download" :size="18" /> {{ $t('download.btn_download') }}
              </a>
              <span v-else class="btn-primary" style="opacity:.5;pointer-events:none;cursor:default;">
                {{ $t('download.btn_disabled') }}
              </span>
            </div>

            <!-- macOS Card -->
            <div v-if="platform === 'macos'" class="cta-card active">
              <div class="cta-info">
                <div class="cta-filename">{{ macPkgFile }}</div>
                <div class="cta-meta">Universal (Intel + Apple Silicon) · {{ $t('download.cta_size_note') }}</div>
              </div>
              <a v-if="macInfo.available && macDownloadUrl" :href="macDownloadUrl" class="btn-primary">
                <Icon name="download" :size="18" /> {{ $t('download.btn_download') }}
              </a>
              <span v-else class="btn-primary" style="opacity:.5;pointer-events:none;cursor:default;">
                {{ $t('download.btn_disabled') }}
              </span>
            </div>

            <!-- Linux Content -->
            <div v-if="platform === 'linux'" class="linux-container active">
              <div class="linux-head">
                <div class="linux-head-text">
                  <div class="linux-title">{{ $t('download.linux_title') }}</div>
                  <div class="linux-sub">{{ $t('download.linux_sub') }}</div>
                </div>
                <div class="arch-switch">
                  <button class="arch-btn" :class="{ active: linuxArch === 'x86_64' }" @click="linuxArch = 'x86_64'">
                    {{ $t('download.arch_x86') }}
                  </button>
                  <button class="arch-btn" :class="{ active: linuxArch === 'aarch64' }" @click="linuxArch = 'aarch64'">
                    {{ $t('download.arch_arm') }}
                  </button>
                </div>
              </div>

              <div class="linux-grid">
                <div v-for="f in linuxFormats" :key="f.fmt" class="linux-card">
                  <div class="variant-format">.{{ f.fmt }}</div>
                  <div class="variant-cmd">sudo {{ f.fmt === 'deb' ? 'apt' : 'dnf' }} install ./lingxi-ai...</div>
                  <a v-if="f.available && f.url" :href="f.url" class="btn-secondary">
                    <Icon name="download" :size="15" /> {{ $t('download.btn_download') }}
                  </a>
                  <span v-else class="btn-secondary" style="opacity:.5;pointer-events:none;cursor:default;">
                    {{ $t('download.btn_disabled') }}
                  </span>
                </div>
              </div>

              <div class="linux-foot">
                {{ $t('download.linux_foot_1') }}
                <a v-if="linuxTarInfo.available && linuxTarUrl" :href="linuxTarUrl" style="color: var(--wps-blue);">{{ linuxTarFile }}</a>
                <span v-else class="muted">{{ linuxTarFile }}（{{ $t('download.btn_disabled') }}）</span><br />
                <span class="muted">{{ $t('download.linux_foot_2') }} <a :href="RELEASE_PAGE" target="_blank" rel="noopener">GitHub Releases</a></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 安装步骤 & 系统要求 -->
    <section class="container install">
      <div class="install-grid">
        <div class="install-panel">
          <h2><Icon name="terminal" :size="20" /> {{ $t('download.install_title') }}</h2>
          <ol v-if="platform === 'windows'" class="steps">
            <li v-for="(step, idx) in winSteps" :key="idx"><span class="step-num">{{ idx + 1 }}</span> {{ step }}</li>
          </ol>
          <ol v-if="platform === 'macos'" class="steps">
            <li v-for="(step, idx) in macSteps" :key="idx"><span class="step-num">{{ idx + 1 }}</span> {{ step }}</li>
          </ol>
          <ol v-if="platform === 'linux'" class="steps">
            <li v-for="(step, idx) in linuxSteps" :key="idx"><span class="step-num">{{ idx + 1 }}</span> {{ step }}</li>
          </ol>
          <div style="margin-top: 24px;">
            <NuxtLink to="/docs" class="link-more">{{ $t('download.more_docs') }} <Icon name="arrow-right" :size="14" /></NuxtLink>
          </div>
        </div>

        <div class="install-panel">
          <h2><Icon name="server" :size="20" /> {{ $t('download.sys_req_title') }}</h2>
          <ul v-if="platform === 'windows'" class="req">
            <li v-for="(req, idx) in winReqs" :key="idx"><Icon name="check" :size="16" /> <span>{{ req }}</span></li>
          </ul>
          <ul v-if="platform === 'macos'" class="req">
            <li v-for="(req, idx) in macReqs" :key="idx"><Icon name="check" :size="16" /> <span>{{ req }}</span></li>
          </ul>
          <ul v-if="platform === 'linux'" class="req">
            <li v-for="(req, idx) in linuxReqs" :key="idx"><Icon name="check" :size="16" /> <span>{{ req }}</span></li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 已验证的 Linux 发行版表格 -->
    <section v-if="platform === 'linux'" class="container distros">
      <div class="distros-inner">
        <h2>{{ $t('download.distros_title') }}</h2>
        <p class="muted" style="margin-bottom: 24px;">
          {{ $t('download.distros_desc_1') }}<a :href="REPO_URL + '/issues'" target="_blank" rel="noopener">GitHub Issues</a>{{ $t('download.distros_desc_2') }}
        </p>
        <div class="distro-grid">
          <!-- 银河麒麟 -->
          <div class="distro-item">
            <div class="distro-name">银河麒麟桌面版 V10</div>
            <div class="distro-meta">
              <span class="distro-arch">x86_64, aarch64</span>
              <span class="distro-fmt">.deb</span>
            </div>
          </div>
          <!-- 统信 UOS -->
          <div class="distro-item">
            <div class="distro-name">统信 UOS 桌面版 V20</div>
            <div class="distro-meta">
              <span class="distro-arch">x86_64, aarch64</span>
              <span class="distro-fmt">.deb</span>
            </div>
          </div>
          <!-- Ubuntu -->
          <div class="distro-item">
            <div class="distro-name">Ubuntu 20.04+</div>
            <div class="distro-meta">
              <span class="distro-arch">x86_64</span>
              <span class="distro-fmt">.deb</span>
            </div>
          </div>
          <!-- openEuler -->
          <div class="distro-item">
            <div class="distro-name">openEuler 22.03+</div>
            <div class="distro-meta">
              <span class="distro-arch">x86_64, aarch64</span>
              <span class="distro-fmt">.rpm</span>
            </div>
          </div>
          <!-- 银河麒麟服务器 -->
          <div class="distro-item">
            <div class="distro-name">银河麒麟服务器版 V10</div>
            <div class="distro-meta">
              <span class="distro-arch">x86_64, aarch64</span>
              <span class="distro-fmt">.rpm</span>
            </div>
          </div>
          <!-- 中标麒麟 -->
          <div class="distro-item">
            <div class="distro-name">中标麒麟 NeoKylin V7+</div>
            <div class="distro-meta">
              <span class="distro-arch">x86_64, aarch64</span>
              <span class="distro-fmt">.rpm</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
