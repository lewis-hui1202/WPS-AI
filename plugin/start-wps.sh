#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "启动文小舟（WPS 文字）... 按 Ctrl-C 退出"
npm run dev:wps
