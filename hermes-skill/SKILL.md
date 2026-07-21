---
name: wps-ai
description: "通过 WPS-AI MCP 服务操控 WPS Office 文档——读取、写入、格式化、公文排版。在 Windows Hermes 上配置后，可从 NAS 远程操控 WPS 处理文档。"
version: 1.0.0
author: "天启造价 × 灵犀AI"
---

# WPS-AI Hermes Skill

本技能将 [灵犀AI WPS 插件](https://github.com/lewis-hui1202/WPS-AI) 的 MCP 服务接入 Hermes Agent，实现远程操控 WPS Office 文档。

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

### 1. 安装灵犀AI WPS 插件

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

### 文字处理 (WPS Writer)

| 工具 | 说明 |
|------|------|
| `wps_read_selection` | 读取当前选区文本 |
| `wps_insert_text` | 在光标处插入文本 |
| `wps_replace_selection` | 替换选中文本 |
| `wps_get_full_text` | 获取全文内容 |
| `wps_set_format` | 设置字体/段落格式 |
| `wps_save_as` | 另存为 PDF/DOCX |

### 表格处理 (WPS ET)

| 工具 | 说明 |
|------|------|
| `et_read_range` | 读取指定区域数据 |
| `et_write_range` | 写入数据到指定区域 |
| `et_create_chart` | 创建图表 |

### 公文排版 (政府文档)

```python
# Hermes 调用示例
mcp.invoke("wps_insert_text", {
    "text": "关于铁岭市招标投标建设领域专项整治自查报告",
    "format": {
        "font": "方正小标宋简体",
        "size": 22,
        "align": "center"
    }
})

# 批量格式化
mcp.invoke("wps_set_format", {
    "style": "government_document",
    "options": {
        "title_font": "方正小标宋简体",
        "heading_font": "黑体",
        "body_font": "仿宋_GB2312",
        "line_spacing": 28
    }
})
```

## 使用示例

### 从 Hermes 写入 Word 文档

```
用户: 把以下公文按国标格式写入 WPS：
标题：关于XXX的自查报告
一级标题：一、工作情况
正文：根据XXXX...

Hermes → wps-ai MCP:
  1. wps_insert_text(标题, 方正小标宋 2号 居中)
  2. wps_insert_text(一级标题, 黑体 3号)
  3. wps_insert_text(正文, 仿宋_GB2312 3号, 28磅行距)
  4. wps_set_format(首行缩进2字符)
  5. wps_save_as(PDF)
```

### 从 Hermes 读取 WPS 文档

```
用户: 读一下当前WPS打开的文档内容

Hermes → wps-ai MCP:
  1. wps_get_full_text()
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
