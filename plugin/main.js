// 参考 wpsjs_demo：index.html 作为 WPS 加载项入口，仅加载 main.js；业务脚本由 main.js 统一装载。
(function loadWpsAiScripts() {
  "use strict";

  (function installWpsNamespaceFallback(global) {
    function patchWpsApi(api) {
      if (!api || (typeof api !== "object" && typeof api !== "function")) return api;
      ["WrapCallbackArg", "JS2Variant", "Variant2JS"].forEach((name) => {
        if (typeof api[name] === "function") return;
        try {
          Object.defineProperty(api, name, {
            configurable: true,
            enumerable: false,
            writable: true,
            value(value) {
              return value;
            }
          });
        } catch (error) {
          try {
            api[name] = function identityVariantBridge(value) {
              return value;
            };
          } catch (e) {}
        }
      });
      return api;
    }

    const fallback = patchWpsApi({});
    if ("wps" in global) {
      try {
        if (global.wps == null) {
          global.wps = fallback;
        } else {
          patchWpsApi(global.wps);
        }
      } catch (error) {}
      return;
    }
    try {
      Object.defineProperty(global, "wps", {
        configurable: true,
        enumerable: true,
        get() {
          return fallback;
        },
        set(value) {
          Object.defineProperty(global, "wps", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: patchWpsApi(value)
          });
        }
      });
    } catch (error) {
      global.wps = fallback;
    }
  })(window);

  const isTaskpanePage = /(?:^|\/)taskpane\.html(?:[?#].*)?$/i.test(window.location.pathname);

  // 加载顺序很重要：
  // 0. runtime.js: 端口探测 + WpsAiRuntime.proxyBase()（其他模块/provider 顶层会立刻读它）
  // 0.5. store.js: sqlite/localStorage 兼容存取层，依赖 runtime.proxyBase()；
  //      必须排在 runtime 之后、auth 等一切读缓存的受管模块之前 —— boot 时
  //      app.js 会先 await WpsAiStore.init() 再放行后续读取。
  // 1. auth.js: OAuth/Token
  // 2. providers/registry.js: 必须在各 provider 注册之前
  // 3. providers/sse.js: SSE 工具
  // 4. providers/*: 各 provider 实现，调用 registry.register
  // 5. openai.js: 上层 facade，依赖 registry
  // 6. wps-addon-adapter.js + wps.js: WPS 文档桥接
  // 7. app.js: 业务 UI（仅 taskpane 页面）
  const scripts = [
    "js/vendor/vue/vue.global.prod.js",
    "js/vendor/dayjs/dayjs.min.js",
    "js/vendor/dayjs/advancedFormat.js",
    "js/vendor/dayjs/customParseFormat.js",
    "js/vendor/dayjs/localeData.js",
    "js/vendor/dayjs/quarterOfYear.js",
    "js/vendor/dayjs/weekOfYear.js",
    "js/vendor/dayjs/weekYear.js",
    "js/vendor/dayjs/weekday.js",
    "js/vendor/ant-design-vue/antd.min.js",
    "js/antd-modals.js",
    "js/i18n.js",   // 国际化：语言偏好 + zh→en 词典 + 英文模式自动 DOM 翻译（要尽量早，静态 UI 首屏即翻）
    "js/runtime.js",
    "js/store.js",
    "js/auth.js",
    "js/providers/registry.js",
    "js/providers/capabilities.js",
    "js/providers/models-catalog.js", // 远程能力目录（models.dev）→ 注入能力 override，摆脱名字正则硬猜
    "js/providers/sse.js",
    "js/providers/codex.js",
    "js/providers/openai.js",
    "js/providers/anthropic.js",
    "js/providers/gemini.js",           // Gemini 原生协议
    "js/providers/openai-responses.js", // 通用 OpenAI Responses（API Key 版，非 codex OAuth）
    "js/providers/image.js",
    "js/openai.js",
    "js/quick-actions.js",
    "js/wps-addon-adapter.js",
    "js/markdown-to-word.js",
    "js/preserve-objects.js", // 嵌入对象保留：占位符渲染 / 分区 / 映射（纯函数），须在 hosts/writer.js 前加载
    "js/markdown-render.js",
    "js/mindmap.js", // 文档脑图：markdown 大纲 → echarts tree 数据
    "js/hosts/writer.js",
    "js/hosts/spreadsheet.js",
    "js/hosts/presentation-order.js",
    "js/hosts/presentation.js",
    "js/hosts/pdf.js",
    "js/wps.js",
    // 方案 B：frontend-slides 风格 HTML 模板 → 图片插入 PPT
    // vendor（html2canvas / echarts）改为懒加载：真正需要 HTML 模板渲染时
    // renderer.js 会 await WpsAiLazyVendor.ensure() 动态注入，冷启动 -500KB
    "js/lazy-vendor.js",
    "js/html-templates/cache.js",
    "js/html-templates/components.js",
    "js/html-templates/renderer.js",
    "js/html-templates/templates/studio.js",
    // 改动记录：依赖 wps.js / hosts/*，要在 tools/registry.js 之前加载，
    // 这样 registry.execute() hook 进去时 WpsAiHistory / WpsAiSnapshot 已可用
    "js/doc-lock.js",   // AI 工作期间锁住文档不让用户编辑
    "js/backup.js",     // 文档级备份（per-turn 快照恢复），被 history.js 使用
    "js/history.js",
    "js/material-library.js", // 生图素材库：记录 generate_image 历史，供 ribbon「素材库」打开
    "js/material-tagger.js", // 素材内容打标（LLM，文本/视觉），依赖 material-library + providers
    "js/local-matting.js", // 本地离线抠图（onnxruntime-web + isnet 模型），发丝级软 alpha，无需联网/供应商
    "js/snapshot.js",
    "js/idle-persist.js",   // 高频持久化 idle 错峰（P0-3）——要在 conversations.js 之前
    "js/task-store.js",     // 后台长任务统一抽象（P2-1）：状态/进度/日志/停止信号
    "js/conversations.js",  // 多对话管理（新建 / 切换 / 历史）
    "js/chat/memory.js",    // 跨对话记忆（P2-4）：对话归档抽记忆，新对话按文档注入
    "js/chat/events.js",
    "js/chat/blocks.js",
    "js/chat/compress.js", // 长对话自动摘要压缩（纯逻辑；app.js 轮末调用）
    "js/chat/history-sanitize.js", // 跨模型安全边界：出站历史剥工具结构/特有角色
    "js/chat/todo-completion.js",
    "js/chat/timeline.js",   // 聊天时间轴渲染（文档流 + 步骤轨道）

    "js/token-usage.js",
    "js/skills.js",         // 技能（内置 + 用户导入，按需拼到 system prompt）
    "js/updater.js",        // 热更新（拉 manifest / 下载 zip / 解压覆盖）
    "js/cache.js",          // 缓存管理：扫 localStorage + proxy 侧目录大小，可选择性清
    "js/image-error-classifier.js", // 生图错误归因分类器（纯逻辑，无 DOM 依赖）
    "js/edit-shortcuts.js", // WPS 宿主快捷键兜底：粘贴等编辑键优先进入 WebView 输入框
    "js/mcp-bridge.js",     // MCP 服务桥：把 WPS 工具暴露给外部 agent (Claude Code CLI 等)
    "js/follow-highlight.js", // AI 操作跟随提示：修改型工具成功后滚动/选中改动位置（registry.execute 调用）
    "js/format-templates.js", // AI 排版模板：内置（合同/公文/论文等）+ 自定义样式模板
    "js/format-risk.js",      // AI 排版段落风险画像（P0-1）：结构敏感段落打标防拆
    "js/long-rewrite.js",     // 长文改写：切节纯逻辑
    "js/proofread.js",        // 批注式校对（P1-3）：错误定位成 Word 批注
    "js/local-intents.js",    // 本地能力路由（P2-3）：确定性短指令不过模型
    "js/compliance.js",       // 文档合规检查（P2-2）：按清单核查 + 分级批注
    // 工具注册表 + 各宿主工具实现（依赖 wps.js 的 WpsAiDocument 与 hosts/*）
    "js/tools/read-utils.js", // 读取类工具共享的分页/范围纯函数，需在各 tools/* 之前
    "js/tools/registry.js",
    "js/mcp-client.js",       // MCP Client：连接外部 MCP 服务，把其工具注册进 registry
    "js/tools/common.js",
    "js/tools/todos.js",
    "js/tools/spreadsheet.js",
    "js/tools/writer.js",
    "js/tools/deck-staging.js",
    "js/tools/materials.js",
    "js/tools/web.js",
    "js/tools/presentation.js",
    "js/tools/pdf.js",
    "js/tools/image.js",
    "js/mcp-client-ui.js"    // MCP Client 设置面板
  ];

  if (isTaskpanePage) {
    scripts.push("js/app.js");
  }

  const cacheBust = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname)
    ? `?v=${Date.now()}`
    : "";

  scripts.forEach((src) => {
    document.write(`<script type="text/javascript" src="${src}${cacheBust}"><\/script>`);
  });
})();
