@echo off
REM Build the Wenxiaozhou AI Windows installer.
REM Run from the repository root with: cd installer && build.bat
REM Requirements:
REM   1. Inno Setup Compiler: https://jrsoftware.org/isdl.php
REM   2. Portable Node runtime: cd plugin && node tools\bundle-node.js

setlocal
cd /d "%~dp0"

REM Locate ISCC.exe.
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe"      set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
REM Fix W4: the .iss uses IS 6.3+ directives (x64compatible/autopf/WizardStyle=modern), IS5 cannot compile it.
REM Only fall back to IS5 when no IS6 is found (previously it unconditionally overrode a valid IS6).
if "%ISCC%"=="" if exist "%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe"

if "%ISCC%"=="" (
  echo [X] Inno Setup Compiler ^(ISCC.exe^) was not found.
  echo     Install Inno Setup 6 from https://jrsoftware.org/isdl.php
  pause
  exit /b 1
)

REM Check the bundled Node runtime.
if not exist "..\plugin\runtime\node-win-x64\node.exe" (
  echo [X] Bundled Node runtime is missing: plugin\runtime\node-win-x64\node.exe
  echo     Build it from the plugin directory: node tools\bundle-node.js
  pause
  exit /b 1
)

echo [build] ISCC: %ISCC%
echo [build] Reading version from plugin\package.json...
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "$p=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText('..\plugin\package.json')); Write-Output $p.version"`) do set "PLUGIN_VERSION=%%V"
if "%PLUGIN_VERSION%"=="" (
  echo [X] Could not read version from plugin\package.json.
  pause
  exit /b 1
)
echo [build] Version: %PLUGIN_VERSION%
echo [build] Compiling installer\lingxi-ai.iss...
"%ISCC%" /DMyAppVersion="%PLUGIN_VERSION%" lingxi-ai.iss
if errorlevel 1 (
  echo [X] Installer compilation failed.
  pause
  exit /b 1
)

echo.
echo [build] Done. Output: dist\lingxi-ai-*-setup.exe
pause
