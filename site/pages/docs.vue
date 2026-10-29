<script setup lang="ts">
const { siteVersion, downloadInfo, loadManifest } = useReleaseManifest()
await loadManifest().catch(() => {})
const { t } = useI18n()
const { messageList, messageObjectList } = useI18nMessages()

interface DocMode {
  name: string
  tag: string
  suit: string
  desc: string
}

interface LinuxFormatMessage {
  target: string
}

interface RequirementMessage {
  item: string
  note: string
}

interface FaqMessage {
  q: string
  a: string
}

useSeoMeta({
  title: () => t('docs.head_title', { version: siteVersion.value }),
  description: () => t('docs.lead'),
  ogTitle: () => t('docs.head_title', { version: siteVersion.value }),
  ogDescription: () => t('docs.lead'),
  twitterTitle: () => t('docs.head_title', { version: siteVersion.value }),
  twitterDescription: () => t('docs.lead')
})

// 安装步骤里的文件名从 manifest 拿，跟下载按钮保持一致。
// devZip 是开发包，manifest 里不发，保留按 version 拼。
const winSetupFile = computed(() => downloadInfo('windows').filename)
const macPkgFile = computed(() => downloadInfo('mac').filename)
const devZipFile = computed(() => `lingxi-ai-${siteVersion.value}.zip`)
const modes = computed(() => messageObjectList<DocMode>('docs.modes'))
const linuxFormatMessages = computed(() => messageObjectList<LinuxFormatMessage>('docs.linux_formats'))
const requirementMessages = computed(() => messageObjectList<RequirementMessage>('docs.reqs'))
const winSteps = computed(() => messageList('docs.win_steps', { file: winSetupFile.value }))
const macSteps = computed(() => messageList('docs.mac_steps', { file: macPkgFile.value }))
const linuxSteps = computed(() => messageList('docs.linux_steps'))
const debugWinSteps = computed(() => messageList('docs.debug_win_steps', { file: devZipFile.value }))
const debugMacSteps = computed(() => messageList('docs.debug_mac_steps'))
const debugLinuxSteps = computed(() => messageList('docs.debug_linux_steps'))
const faqs = computed(() => messageObjectList<FaqMessage>('docs.faqs'))

const sections = computed(() => [
  { id: 'overview', label: t('docs.sections.overview') },
  { id: 'windows', label: t('docs.sections.windows') },
  { id: 'macos', label: t('docs.sections.macos') },
  { id: 'linux', label: t('docs.sections.linux') },
  { id: 'requirements', label: t('docs.sections.requirements') },
  { id: 'debug', label: t('docs.sections.debug') },
  { id: 'faq', label: t('docs.sections.faq') }
])

const linuxFormats = computed(() => [
  {
    fmt: '.deb',
    target: linuxFormatMessages.value[0]?.target || '',
    cmd: `sudo dpkg -i ./lingxi-ai_${siteVersion.value}_amd64.deb`,
    uninstall: 'sudo apt remove lingxi-ai'
  },
  {
    fmt: '.rpm',
    target: linuxFormatMessages.value[1]?.target || '',
    cmd: `sudo dnf install ./lingxi-ai-${siteVersion.value}-1.x86_64.rpm`,
    uninstall: 'sudo dnf remove lingxi-ai'
  },
  {
    fmt: '.tar.gz',
    target: linuxFormatMessages.value[2]?.target || '',
    cmd: `tar -xzf lingxi-ai-${siteVersion.value}-linux-x64.tar.gz\ncd lingxi-ai-${siteVersion.value}\nbash install.sh        # 装到 ~/.local/share/lingxi-ai\n# 或:\nsudo bash install.sh   # 装到 /opt/lingxi-ai`,
    uninstall: 'bash ~/.local/share/lingxi-ai/uninstall.sh   # 或 sudo bash /opt/lingxi-ai/uninstall.sh'
  }
])

const requirements = computed(() => [
  { item: requirementMessages.value[0]?.item || '', gui: true, manual: true, note: requirementMessages.value[0]?.note || '' },
  { item: requirementMessages.value[1]?.item || '', gui: false, manual: true, note: requirementMessages.value[1]?.note || '' },
  { item: requirementMessages.value[2]?.item || '', gui: false, manual: false, note: requirementMessages.value[2]?.note || '' },
  { item: requirementMessages.value[3]?.item || '', gui: false, manual: true, note: requirementMessages.value[3]?.note || '' }
])
</script>

<template>
  <section class="doc-hero">
    <div class="container">
      <div class="doc-badge">
        <Icon name="file-text" :size="14" /> {{ $t('docs.badge', { version: siteVersion }) }}
      </div>
      <h1>{{ $t('docs.h1') }}</h1>
      <p class="lead">{{ $t('docs.lead') }}</p>
    </div>
  </section>

  <div class="container doc-layout">
    <aside class="toc">
      <div class="toc-title"><Icon name="menu" :size="14" /> {{ $t('docs.toc_title') }}</div>
      <ul>
        <li v-for="s in sections" :key="s.id">
          <a :href="`#${s.id}`">
            <Icon name="chevron-right" :size="12" />
            {{ s.label }}
          </a>
        </li>
      </ul>
    </aside>

    <article class="doc-body">
      <section id="overview" class="doc-section">
        <h2>{{ $t('docs.sections.overview') }}</h2>
        <div class="mode-grid">
          <div v-for="(m, i) in modes" :key="i" class="mode-card">
            <div class="mode-head">
              <h3>{{ m.name }}</h3>
              <span class="mode-tag">{{ m.tag }}</span>
            </div>
            <div class="mode-suit">{{ $t('docs.mode_suit_prefix') }}{{ m.suit }}</div>
            <p>{{ m.desc }}</p>
          </div>
        </div>
        <div class="callout">
          <Icon name="alert" :size="18" />
          <div>{{ $t('docs.callout_overview') }}</div>
        </div>
      </section>

      <section id="windows" class="doc-section">
        <h2><Icon name="windows" :size="22" /> {{ $t('docs.sections.windows') }}</h2>
        <p class="muted">{{ $t('docs.recommend_gui') }}</p>
        <ol class="step-list">
          <li v-for="(s, i) in winSteps" :key="i">
            <span class="step-num">{{ i + 1 }}</span>
            <span>{{ s }}</span>
          </li>
        </ol>
        <div class="info-blocks">
          <div class="info-block">
            <h4>{{ $t('docs.info_win_uninstall_title') }}</h4>
            <p>{{ $t('docs.info_win_uninstall_desc') }}</p>
          </div>
          <div class="info-block">
            <h4>{{ $t('docs.info_win_upgrade_title') }}</h4>
            <p>{{ $t('docs.info_win_upgrade_desc') }}</p>
          </div>
        </div>
      </section>

      <section id="macos" class="doc-section">
        <h2><Icon name="apple" :size="22" /> {{ $t('docs.sections.macos') }}</h2>
        <p class="muted">{{ $t('docs.recommend_pkg') }}</p>
        <ol class="step-list">
          <li v-for="(s, i) in macSteps" :key="i">
            <span class="step-num">{{ i + 1 }}</span>
            <span>{{ s }}</span>
          </li>
        </ol>
        <div class="info-blocks">
          <div class="info-block">
            <h4>{{ $t('docs.info_mac_uninstall_title') }}</h4>
            <p v-html="$t('docs.info_mac_uninstall_desc')"></p>
          </div>
          <div class="info-block">
            <h4>{{ $t('docs.info_mac_upgrade_title') }}</h4>
            <p>{{ $t('docs.info_mac_upgrade_desc') }}</p>
          </div>
        </div>
      </section>

      <section id="linux" class="doc-section">
        <h2><Icon name="linux" :size="22" /> {{ $t('docs.sections.linux') }}</h2>
        <p class="muted">{{ $t('docs.linux_intro') }}</p>

        <div class="linux-fmt-grid">
          <div v-for="f in linuxFormats" :key="f.fmt" class="linux-fmt-card">
            <div class="linux-fmt-head">
              <span class="linux-fmt-name">{{ f.fmt }}</span>
            </div>
            <div class="linux-fmt-target">{{ f.target }}</div>
            <pre class="linux-fmt-cmd"><code>{{ f.cmd }}</code></pre>
            <div class="linux-fmt-uninstall">
              <span class="muted">{{ $t('docs.linux_uninstall_label') }}</span>
              <code>{{ f.uninstall }}</code>
            </div>
          </div>
        </div>

        <h3 style="margin-top: 24px;">{{ $t('docs.linux_install_happens') }}</h3>
        <ol class="step-list">
          <li v-for="(s, i) in linuxSteps" :key="i">
            <span class="step-num">{{ i + 1 }}</span>
            <span>{{ s }}</span>
          </li>
        </ol>

        <div class="info-blocks">
          <div class="info-block">
            <h4>{{ $t('docs.linux_info_arch_title') }}</h4>
            <p v-html="$t('docs.linux_info_arch_desc')"></p>
          </div>
          <div class="info-block">
            <h4>{{ $t('docs.linux_info_upg_title') }}</h4>
            <p v-html="$t('docs.linux_info_upg_desc')"></p>
          </div>
          <div class="info-block">
            <h4>{{ $t('docs.linux_info_verify_title') }}</h4>
            <pre class="linux-fmt-cmd" style="margin: 8px 0 0;"><code>systemctl --user status lingxi-ai
curl -s http://127.0.0.1:3889/wps/manifest.json
ls ~/.config/Kingsoft/Office6/jsaddons/publish.xml</code></pre>
          </div>
        </div>
      </section>

      <section id="requirements" class="doc-section">
        <h2>{{ $t('docs.sections.requirements') }}</h2>
        <div class="req-table">
          <div class="req-row req-head">
            <div>{{ $t('docs.req_col1') }}</div>
            <div>{{ $t('docs.req_col2') }}</div>
            <div>{{ $t('docs.req_col3') }}</div>
            <div>{{ $t('docs.req_col4') }}</div>
          </div>
          <div v-for="(r, idx) in requirements" :key="idx" class="req-row">
            <div><strong>{{ r.item }}</strong></div>
            <div>
              <Icon v-if="r.gui" name="check" :size="16" class="ok" />
              <span v-else class="muted">{{ $t('docs.req_builtin') }}</span>
            </div>
            <div>
              <Icon v-if="r.manual" name="check" :size="16" class="ok" />
            </div>
            <div class="muted-text">{{ r.note }}</div>
          </div>
        </div>
      </section>

      <section id="debug" class="doc-section">
        <h2>{{ $t('docs.sections.debug') }}</h2>
        <p>{{ $t('docs.debug_intro') }}</p>

        <h3><Icon name="windows" :size="18" /> {{ $t('docs.debug_win') }}</h3>
        <ol class="step-list">
          <li v-for="(s, i) in debugWinSteps" :key="i">
            <span class="step-num">{{ i + 1 }}</span>
            <span v-html="s"></span>
          </li>
        </ol>

        <h3><Icon name="apple" :size="18" /> {{ $t('docs.debug_mac') }}</h3>
        <ol class="step-list">
          <li v-for="(s, i) in debugMacSteps" :key="i">
            <span class="step-num">{{ i + 1 }}</span>
            <span v-html="s"></span>
          </li>
        </ol>

        <h3><Icon name="linux" :size="18" /> {{ $t('docs.debug_linux') }}</h3>
        <ol class="step-list">
          <li v-for="(s, i) in debugLinuxSteps" :key="i">
            <span class="step-num">{{ i + 1 }}</span>
            <span v-html="s"></span>
          </li>
        </ol>
      </section>

      <section id="faq" class="doc-section">
        <h2>{{ $t('docs.sections.faq') }}</h2>
        <div class="faq-list">
          <details v-for="(f, i) in faqs" :key="i" class="faq">
            <summary>
              <Icon name="chevron-right" :size="14" />
              <span>{{ f.q }}</span>
            </summary>
            <div class="faq-body">{{ f.a }}</div>
          </details>
        </div>
      </section>
    </article>
  </div>
</template>
