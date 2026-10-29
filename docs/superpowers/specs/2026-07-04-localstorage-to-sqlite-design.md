# 缓存迁移：localStorage → SQLite（proxy）+ 同步存储面板 设计

**Goal:** 把 WPS 插件所有持久化缓存从浏览器 localStorage（~5MB 配额、经常撑爆）迁到本地 SQLite（经现有 Node 代理落盘到 `~/.lingxi-ai/lingxi.db`），彻底消除 QuotaExceeded；各业务模块改动近乎机械替换、不改成 async。

**Architecture:** 新增前端 `WpsAiStore` —— 一个与 localStorage 同款的**同步** KV API，内部维护内存 Map（启动时从 SQLite 批量灌入），读走内存、写改内存并**防抖异步批量回写**代理；代理用 Node 22 内置 `node:sqlite` 存 `~/.lingxi-ai/lingxi.db`。代理不可用时整体优雅退回 localStorage。桌面专用，不考虑移动端。

**Tech Stack:** WPS Office JS 加载项（window IIFE 模块 + Chromium/CEF WebView）、本地 Node 代理（proxy-server.js，内置 Node v22.11）、`node:sqlite`（`--experimental-sqlite`）、node:test。

## Global Constraints

- 仅桌面（Windows/macOS/Linux）；移动端 README 明确不支持，本设计不为其做任何适配。
- 代理用**内置 Node v22.11** 启动，必须带 `--experimental-sqlite`；缺该能力时端点回 503、前端降级 localStorage，绝不崩。
- 业务模块只把 `localStorage.*` 换成 `WpsAiStore.*`，**不得**改成 async、不得改业务逻辑。
- 跨窗 IPC 的 key（弹窗 request/result 等）**保持在 localStorage**，不进本方案。
- 数据库单文件 `~/.lingxi-ai/lingxi.db`，与现有 render/backups 同目录；开 WAL。
- 迁移必须**幂等**、先写 SQLite 成功再清 localStorage，不能丢数据。
- API Key / OAuth 令牌进 SQLite 为明文——与今天 localStorage 明文同级，不额外加密（不在本轮范围）。

---

## 一、现状（为什么做）

- 现在**没有存储抽象层**：30+ 个 key 散落各模块直接 `localStorage.getItem/setItem`（对话、历史、素材库、模板缓存、技能、设置、令牌…）。
- 大容量项（对话 `lingxi_conversations_v1`、历史 `lingxi_history_v1`、模板缓存 `lingxi_html_template_cache_v1`、预览日志等）会撑爆 ~5MB 配额；现有 4 处 QuotaExceeded 兜底只是"砍一半/瘦身重试/弹提示"，治标不治本。
- 代理（`tools/proxy-server.js`）本就是桌面必需的 Node 进程，已在 `~/.lingxi-ai/` 落盘（render/backups/models），天然适合承载 SQLite。

---

## 二、代理侧

### 2.1 KV 存储模块 `tools/kv-store.js`

- 惰性打开 `~/.lingxi-ai/lingxi.db`（`new DatabaseSync(path)`），首次建表：
  ```sql
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  PRAGMA journal_mode=WAL;
  ```
- 导出：`getAll()`、`batch({sets:[{key,value}], dels:[key]})`（单事务）、`stats()`（每 key 的字节数，供缓存 UI）、`clear({keys?})`、`available()`（node:sqlite 是否可用）。
- `require("node:sqlite")` 包 try/catch：不可用时 `available()=false`，所有方法安全降级。

### 2.2 代理路由（proxy-server.js）

- `GET  /kv/all`   → `{ ok, items: { key: value, … } }`（启动批量灌）。
- `POST /kv/batch` → 入参 `{ sets, dels }`，一个事务写完，返回 `{ ok, count }`。
- `GET  /kv/stats` → `{ ok, entries:[{key,bytes}], total }`（缓存管理 UI）。
- `POST /kv/clear` → `{ keys? }`；空则清全部业务缓存。
- node:sqlite 不可用 → 一律 `503 { ok:false, error:"sqlite 未启用" }`（前端据此降级）。

### 2.3 启动参数

- 所有拉起代理的入口都加 `--experimental-sqlite`：`package.json` 的 `proxy` 脚本、`start-wps/et/wpp/pdf.{bat,sh}`、`tools/serve-permanent.js`（若它 spawn node）、`tools/register-task.ps1`、`install-permanent-*`。
- 用**内置 Node**（`runtime/node-win-x64/node.exe` 等）启动，保证版本一致。
- 兜底：即便某入口漏加 flag，端点回 503、前端退回 localStorage，功能不中断（只是没迁移收益）。

---

## 三、前端 `WpsAiStore`（`js/store.js`，最先加载）

### 3.1 API（与 localStorage 同形）

`getItem(key)` / `setItem(key,value)` / `removeItem(key)` / `clear()` / `keys()` + `init()` / `ready`(Promise) / `flush()`。全部同步（除 init/flush）。

### 3.2 内部结构

- `_map: Map<string,string>` 内存权威副本；`_dirty: Set`、`_deleted: Set`；`_backend: "sqlite"|"localStorage"`。
- `getItem` → `_map.get(key) ?? null`。
- `setItem` → `_map.set`; `_dirty.add`; `_deleted.delete`; `scheduleFlush()`。
- `removeItem` → `_map.delete`; `_deleted.add`; `_dirty.delete`; `scheduleFlush()`。
- `scheduleFlush()` → 500ms 防抖；`flush()` 把 `_dirty`/`_deleted` 组成 `/kv/batch` 发出，成功后清集合。`window.beforeunload` 调 `flush({sync:true})`（用 `navigator.sendBeacon` 或同步 XHR 兜底最后一批）。

### 3.3 init 流程

1. `GET /kv/all`（带 ~1.5s 超时）。成功 → `_backend="sqlite"`，用返回项灌 `_map`。
2. 失败/超时 → `_backend="localStorage"`，遍历受管 key 从 localStorage 灌 `_map`（此会话仍写 localStorage、走原 QuotaExceeded 兜底）。
3. **迁移**（仅 backend=sqlite 且未迁移）：SQLite 里没有 `__migrated_v1` 标记时，把 localStorage 里所有**受管 key**（见 §4）批量 `POST /kv/batch` 进 SQLite；确认成功后写 `__migrated_v1=ts`，再**删掉 localStorage 里的大键**（对话/历史/模板缓存/组件/预览日志/素材库…）腾空间；小键可留可删（计划里定清单）。

### 3.4 降级一致性

- backend 在 init 时定死（v1 不做"proxy 中途上线再切换"）。
- backend=localStorage 时，`setItem` 直接写 localStorage（保持今天行为，含 QuotaExceeded 兜底）；backend=sqlite 时**不写 localStorage**（避免再撞配额）。

---

## 四、迁移范围

**进 SQLite（经 WpsAiStore）**：`lingxi_conversations_v1`、`lingxi_current_conversation_v1`、`lingxi_history_v1`、`lingxi_history_turns_v1`、`lingxi_material_library_v1`、`lingxi_skills_user_v1`、`lingxi_skills_enabled_v1`、`lingxi_skills_cloud_v1`、`lingxi_html_template_cache_v1`(KEY 值)、`lingxi_html_components_v1`、`lingxi_html_cache_cleared_at`、`lingxi_token_usage_v1`、`lingxi_doc_report_cache_v1`、`lingxi_mindmap_qa_v1`、`lingxi_models_cache_v1`、`lingxi_image_models_cache_v1`、`lingxi_model_group_collapsed_v1`、`wps_ai_provider_settings_v1`、`lingxi_ai_thinking_level_v1`、`lingxi_pure_mode`、`wpsAiChatFoldMiddle`、`wpsAiProviderHealthV1`、`wpsAiCacheAutoCleanPolicy`、`wpsAiCacheAutoCleanLastRunAt`、`lingxi_preview_log_v1`、`lingxi_html_preview_chat_log_v1`、`lingxi_html_preview_unified_chat_log_v1`、`lingxi_html_preview_picked_components_v1`、`lingxi_device_sn_v1`、`lingxi_updater_last_check_v1`、`wpsAiMcpBridgeToken`、`__lingxi_editor_tips_seen__`、以及 auth.js 的 OAuth 令牌键（`wps_ai_*`）。

**留 localStorage（不动）**：跨窗 IPC —— `lingxi_*_dialog_request_v1/result_v1`（html-preview/quick-prompt/format-preview/selection-preview/parallel-translate）、`lingxi_html_preview_pending_insert_v1`、`lingxi_material_dialog_insert_v1/modify_v1`、`lingxi_full_deck_progress_v1`、`lingxi_writer_insertion_range_hint_v1`、`lingxi_runtime_proxy_port_v1`（端口探测早于 store，且要极早读，留 localStorage）。

**cache.js 缓存管理**：从"扫 localStorage 键分组算大小"改为查 `/kv/stats` 展示、清走 `/kv/clear`（IPC 部分仍扫 localStorage）。

---

## 五、组件与接口清单

- `tools/kv-store.js`：`getAll/batch/stats/clear/available`。
- `tools/proxy-server.js`：`/kv/all`、`/kv/batch`、`/kv/stats`、`/kv/clear` 路由 + 未知路由提示更新。
- 各启动脚本：加 `--experimental-sqlite`。
- `js/store.js`：`WpsAiStore`（挂 window，main.js 首个加载）。
- `main.js` / `app.js`：init 最前 `await WpsAiStore.init()`。
- 受管模块：`conversations.js / history.js / material-library.js / skills.js / token-usage.js / providers/registry.js / auth.js / updater.js / mcp-bridge.js / html-templates/cache.js / html-templates/components.js / runtime.js(部分) / app.js(诸多 key)` —— `localStorage.*` → `WpsAiStore.*`。
- `js/cache.js`：改查 `/kv/stats`、`/kv/clear`。

## 六、错误处理 & 兜底

- node:sqlite 缺失/DB 打不开 → 端点 503 → 前端 backend=localStorage（今天行为）。
- flush 失败（proxy 掉线）→ 保留 dirty 集，下次 setItem/定时重试；beforeunload sendBeacon 兜底。
- 迁移：任一步失败不写 `__migrated_v1`、不删 localStorage，下次重试（幂等）。
- 全局 `installLocalStorageGuard` 保留（IPC 大 payload 仍可能撞配额，属既有行为）。

## 七、测试（node:test）

- `tools/kv-store.js`：建表、set/get/批量事务、stats 字节统计、clear、available=false 降级（用 `:memory:` DB）。
- `js/store.js`：mock `fetch`+`localStorage`，测 Map 读写、dirty/deleted 攒批、防抖 flush 组包、init 两条路径、迁移幂等 + 迁移后清大键、backend=localStorage 时不丢 QuotaExceeded 兜底。

## 八、Out of Scope

- 移动端 / Android。
- API Key/令牌加密（明文，与今天同级）。
- 跨窗 IPC 迁移（仍走 localStorage）。
- 把 KV 拆成结构化多表（v1 用 KV(JSON) 直迁；结构化查询留后续）。
- proxy 中途上线后的会话内 backend 热切换。
