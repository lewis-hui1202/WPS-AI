@echo off
chcp 65001 >nul 2>&1
title 文小舟 永久安装（Windows）

echo ============================================
echo   文小舟 WPS 插件 - Windows 永久安装
echo ============================================
echo   会一次性给三个 WPS 应用（文字/表格/演示）注册插件，
echo   并把后台服务加到登录时自动启动。
echo.

REM --- 检查 Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [X] 未检测到 Node.js。请先安装：https://nodejs.org/zh-cn/
  goto :_lingxi_hold_open
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js: %%v

REM --- 升级场景：先停掉可能在跑的旧服务，避免文件锁占用 ---
echo [..] 停止可能在跑的旧服务（升级模式必需）...
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $myPpid = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $myPpid -and ($_.Name -in 'node.exe','wscript.exe','cmd.exe') -and (($_.CommandLine -like '*\.lingxi-ai\*') -or ($_.ExecutablePath -like '*\.lingxi-ai\*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 2 /nobreak >nul 2>&1
echo [OK] 旧服务（如有）已停止

REM --- 检测 WPS 是否在运行（运行中会锁住插件目录文件，rmrf 会 EBUSY）---
tasklist /FI "IMAGENAME eq wps.exe"       2>nul | find /I "wps.exe"       >nul && goto :_lingxi_wps_running
tasklist /FI "IMAGENAME eq et.exe"        2>nul | find /I "et.exe"        >nul && goto :_lingxi_wps_running
tasklist /FI "IMAGENAME eq wpp.exe"       2>nul | find /I "wpp.exe"       >nul && goto :_lingxi_wps_running
tasklist /FI "IMAGENAME eq wpsoffice.exe" 2>nul | find /I "wpsoffice.exe" >nul && goto :_lingxi_wps_running
echo [OK] 未检测到 WPS 在运行
goto :_lingxi_wps_check_done

:_lingxi_wps_running
echo.
echo [X] 检测到 WPS 还在运行（wps / et / wpp / wpsoffice）。WPS 会锁住插件
echo     目录里的文件，升级时无法删除。请按以下步骤后重新运行此脚本：
echo       1. 任务栏右下角 WPS 图标 -^> 右键 -^> 退出
echo       2. 任务管理器确认 wps.exe / et.exe / wpp.exe 都不在
echo       3. 重新双击 install-permanent-windows.bat
goto :_lingxi_hold_open

:_lingxi_wps_check_done

REM --- 计算源目录与目标目录 ---
set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"
set "TARGET=%USERPROFILE%\.lingxi-ai"

echo [..] 源目录: %SRC_DIR%
echo [..] 目标目录: %TARGET%
echo.

REM --- 1. 生成三宿主变体 ---
echo [1/5] 生成三个宿主变体（plugin-wps / plugin-et / plugin-wpp）...
pushd "%SRC_DIR%"
node tools\build-variants.js --out "%TARGET%"
if errorlevel 1 (
  popd
  echo.
  echo [X] 生成宿主变体失败。可能是某个进程还锁着 %TARGET% 下的文件。
  echo     建议：
  echo       1. 任务管理器找路径 / 命令行含 lingxi-ai 的 node / wscript / cmd 全部结束
  echo       2. 或者重启 Windows 一次释放所有文件句柄
  echo       3. 再重新双击此脚本
  goto :_lingxi_hold_open
)
popd

REM --- 2. 复制服务脚本 ---
echo [2/5] 复制常驻服务脚本...
if not exist "%TARGET%\tools" mkdir "%TARGET%\tools"
copy /Y "%SRC_DIR%\tools\serve-permanent.js" "%TARGET%\tools\serve-permanent.js" >nul
copy /Y "%SRC_DIR%\tools\proxy-server.js" "%TARGET%\tools\proxy-server.js" >nul
echo [OK] 服务脚本已就位

REM --- 3. 写 publish.xml ---
echo [3/5] 写入 WPS 加载项注册...
set "JSADDONS=%APPDATA%\kingsoft\wps\jsaddons"
if not exist "%JSADDONS%" mkdir "%JSADDONS%"
set "PUBLISH=%JSADDONS%\publish.xml"
(
  echo ^<?xml version="1.0" encoding="UTF-8" standalone="yes"?^>
  echo ^<jsplugins^>
  echo   ^<jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/^>
  echo ^</jsplugins^>
) > "%PUBLISH%"
echo [OK] %PUBLISH%

REM --- 4. 生成启动脚本 ---
echo [4/5] 生成启动脚本...
set "RUN_VBS=%TARGET%\run-server-hidden.vbs"
set "DEBUG_BAT=%TARGET%\run-server-debug.bat"
set "WRAPPER_BAT=%TARGET%\start-lingxi-server.bat"

REM 4a. 静默启动 vbs：用 (...) 块写避免 ^>^> 在外层被识别
(
  echo Set ws = CreateObject^("Wscript.Shell"^)
  echo ws.Run "cmd /c node ""%TARGET%\tools\serve-permanent.js"" --root ""%TARGET%"" >> ""%TARGET%\server.log"" 2>&1", 0, False
) > "%RUN_VBS%"
echo [OK] %RUN_VBS%

REM 4b. 带窗口的调试启动脚本
(
  echo @echo off
  echo title 文小舟 后台服务（调试模式）
  echo node "%TARGET%\tools\serve-permanent.js" --root "%TARGET%"
) > "%DEBUG_BAT%"

REM 4c. 一个不带任何参数的小包装 bat，便于注册表 Run 键无空格路径调用
(
  echo @echo off
  echo start "" /B wscript.exe "%%~dp0run-server-hidden.vbs"
  echo exit
) > "%WRAPPER_BAT%"
echo [OK] %WRAPPER_BAT%

REM --- 5. 注册登录自启 ---
echo [5/5] 注册登录时自动启动...

REM 优先用注册表 HKCU Run 键（不需要管理员权限，受用户登录触发）
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI /t REG_SZ /d "\"%WRAPPER_BAT%\"" /f >nul 2>&1
if not errorlevel 1 (
  echo [OK] 已写入 HKCU\...\Run\LingxiAI（下次登录起自动跑）
) else (
  echo [WARN] 注册表写入失败，请手动添加：
  echo        reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v LingxiAI /d "%WRAPPER_BAT%"
)

REM --- 立即起一份后台服务 ---
echo [..] 启动后台服务...
start "" /B wscript.exe "%RUN_VBS%"
echo [OK] 服务已在后台运行

echo.
echo ============================================
echo   永久安装完成！
echo ============================================
echo   后台服务: http://127.0.0.1:3889 / :3890
echo   日志输出: %TARGET%\server.log
echo.
echo   下一步:
echo     1. 重新打开 WPS 文字 / 表格 / 演示，顶部应出现「文小舟」
echo     2. 不需要保留任何终端窗口，服务后台跑
echo.
echo   排错:
echo     - 后台服务日志: %TARGET%\server.log
echo     - 想看实时输出: 双击 %DEBUG_BAT%
echo     - 卸载: 双击 uninstall-permanent-windows.bat
echo ============================================

REM ============ 统一出口：所有路径（成功 / 失败）都跳到这里 ============
REM 保证窗口不会自己关闭，即使 stdin 被吞或用户误按键也不退出。
REM 唯一退出方式：用户点右上角 X。timeout /nobreak 不接受任何输入打断。
:_lingxi_hold_open
echo.
echo 窗口保持打开。请阅读上方输出。要关闭请点窗口右上角的 X。
:_lingxi_hold_open_loop
timeout /t 3600 /nobreak >nul 2>&1
goto :_lingxi_hold_open_loop
