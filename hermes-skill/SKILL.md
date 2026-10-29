---
name: wps-ai
description: "通过 WPS-AI MCP 服务操控 WPS Office 文档——读取、写入、格式化、公文排版。在 Windows Hermes 上配置后，可从 NAS 远程操控 WPS 处理文档。"
version: 1.0.0
author: "天启造价 × 文小舟"
---

# WPS-AI Hermes Skill

本技能将 [文小舟 WPS 插件](https://github.com/lewis-hui1202/WPS-AI) 的 MCP 服务接入 Hermes Agent，实现远程操控 WPS Office 文档。

## 架构

```
Hermes Agent (NAS/本地)
  └── MCP Client (stdio)
      └── mcp-server.js (WPS-AI plugin)
          └── HTTP → proxy-server.js :3890
              └── WPS Plugin (TaskPane)
                  └── WPS JSAPI → 文档读写
```

## 安装

### 1. 安装文小舟 WPS 插件

从 https://github.com/lewis-hui1202/WPS-AI/releases 下载安装包，或：

```bash
git clone https://github.com/lewis-hui1202/WPS-AI.git
cd WPS-AI
npm install
```

### 2. 配置 WPS 插件

- 打开 WPS，启用插件
- 设置 → MCP 服务 → 开启
- 设置 → API Key → 填入 DeepSeek / Claude 等

### 3. 启动 proxy server

```bash
cd WPS-AI/plugin
node tools/proxy-server.js
```

### 4. Hermes MCP 配置

在 Hermes 配置文件 `config.yaml` 中添加：

```yaml
mcp:
  servers:
    wps-ai:
      command: node
      args:
        - "C:/path/to/WPS-AI/plugin/tools/mcp-server.js"
      env:
        WPS_PROXY_PORT: "3890"
```

## 可用工具

> 工具名以插件实际注册为准（`plugin/js/tools/*.js`）。下表为常用子集，完整清单可在 Hermes 里列出 MCP 工具查看。

### 文字处理 (WPS Writer)

| 工具 | 说明 |
|------|------|
| `wps_read_selection` | 读取当前选区文本 |
| `wps_read_document` | 读取文档内容（`mode`：text 全文 / structured 结构化 / outline 大纲；可按段落/标题区间分页） |
| `wps_insert_text` | 在光标处插入内容（`text` 纯文本，或 `blocks` 结构化排版；不接受内联格式，格式另调 format 工具） |
| `wps_replace_selection` | 替换选中内容（`text` / `blocks`） |
| `wps_format_selection` | 字符格式（`bold`/`italic`/`underline`/`fontName`/`fontSize`/`color`/`highlight`） |
| `wps_format_paragraph` | 段落格式（`alignment`/`leftIndent`/`rightIndent`/`firstLineIndent`/`lineSpacing`+`lineSpacingRule`/`spaceBefore`/`spaceAfter`；`scope`=selection/document） |
| `wps_apply_paragraph_style` | 套用命名段落样式（配合 `wps_list_styles`） |
| `wps_save_as` | 另存为 PDF/DOCX（导出 PDF 也可用 `wps_export_pdf`） |

### 表格处理 (WPS ET)

| 工具 | 说明 |
|------|------|
| `et_read_range` | 读取指定区域数据 |
| `et_write_range` | 写入数据到指定区域 |
| `et_insert_chart` | 插入图表（`dataRange` 含表头 + `chartType`：column/bar/line/pie/…） |

### 公文排版 (政府文档)

文小舟 没有 “一键公文预设” 参数；公文格式通过“插入文本 + 分别设置字符/段落格式”组合完成。示例（Hermes 调用）：

```python
# 1) 插入标题文本（不带格式）
mcp.invoke("wps_insert_text", {
    "text": "关于XX专项整治自查报告"
})

# 2) 选中标题后设字符格式：方正小标宋简体、二号(22磅)
mcp.invoke("wps_format_selection", {
    "fontName": "方正小标宋简体",
    "fontSize": 22
})

# 3) 标题段落居中
mcp.invoke("wps_format_paragraph", {
    "alignment": "center"
})

# 正文：仿宋_GB2312 三号(16磅)、28 磅固定行距、首行缩进 2 字符(≈32磅)
mcp.invoke("wps_format_selection", { "fontName": "仿宋_GB2312", "fontSize": 16 })
mcp.invoke("wps_format_paragraph", {
    "scope": "selection",
    "lineSpacing": 28, "lineSpacingRule": "exactly",
    "firstLineIndent": 32
})

# 一级标题：黑体 三号
mcp.invoke("wps_format_selection", { "fontName": "黑体", "fontSize": 16 })
```

## 使用示例

### 从 Hermes 写入 Word 文档

```
用户: 把以下公文按国标格式写入 WPS：
标题：关于XXX的自查报告
一级标题：一、工作情况
正文：根据XXXX...

Hermes → wps-ai MCP:
  1. wps_insert_text(标题) → wps_format_selection(方正小标宋简体,22) + wps_format_paragraph(居中)
  2. wps_insert_text(一级标题) → wps_format_selection(黑体,16)
  3. wps_insert_text(正文) → wps_format_selection(仿宋_GB2312,16)
  4. wps_format_paragraph(lineSpacing:28/exactly, firstLineIndent:32)
  5. wps_save_as(PDF)
```

> 提示：正文若一次性排版整篇，也可用 `wps_insert_text` 传结构化 `blocks`（标题/段落/列表由插件按 Word 原生格式渲染），再对需要的段落补调 format 工具。

### 从 Hermes 读取 WPS 文档

```
用户: 读一下当前WPS打开的文档内容

Hermes → wps-ai MCP:
  1. wps_read_document(mode="text")
  → 返回全文，供 AI 分析/改写/提取
```

## 从 NAS 远程操控

如果需要在 NAS 上的 Hermes 操控 Windows 上的 WPS：

```
1. Windows 上启动 proxy-server.js
2. NAS Hermes 通过 SSH 隧道连到 Windows 的 3890 端口
3. mcp-server.js 在 NAS 本地运行，HTTP 请求转发到 Windows
```

## 注意事项

- WPS 必须保持打开状态
- MCP 服务开关需在插件设置中开启
- 首次使用需生成 MCP token（插件自动处理）
- 支持的 WPS 版本：≥ 2023 冬季更新
