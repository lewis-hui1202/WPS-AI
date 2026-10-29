#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  文小舟 WPS 插件 - macOS 安装脚本"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[X] 未检测到 Node.js。"
  echo "    请先安装 Node.js LTS：https://nodejs.org/zh-cn/"
  exit 1
fi
echo "[OK] Node.js: $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  echo "[X] 未检测到 npm"
  exit 1
fi
echo "[OK] npm: $(npm -v)"

if ! command -v wpsjs >/dev/null 2>&1; then
  echo "[..] 未检测到 wpsjs，正在全局安装..."
  npm install -g wpsjs
fi
echo "[OK] wpsjs 已就绪"

echo
echo "[..] 正在安装项目依赖（npm install）..."
npm install
echo "[OK] 依赖安装完成"

echo
echo "[..] 写入 macOS WPS 加载项配置..."
npm run install:mac-publish
echo "[OK] 配置写入完成"

echo
echo "============================================"
echo "  安装完成！下一步："
echo "============================================"
echo "  1. 启动调试：./start-wps.sh / ./start-et.sh / ./start-wpp.sh"
echo "  2. 完全退出 WPS（菜单 -> 退出 WPS）"
echo "  3. 重新打开 WPS，顶部功能区会出现「文小舟」"
echo "  如「可用加载项」列表为空，请重启 WPS 后再试。"
echo "============================================"
