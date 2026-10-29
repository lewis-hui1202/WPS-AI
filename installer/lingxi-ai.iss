; 文小舟 Windows 安装器 - Inno Setup 5.5+
;
; 用 Inno Setup Compiler 编译:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\lingxi-ai.iss
; 或双击 installer\build.bat（自动找 ISCC.exe）。
;
; 编译前先确保 plugin\runtime\node-win-x64\node.exe 存在
;   cd plugin && node tools\bundle-node.js
;
; 产物：dist\lingxi-ai-1.4.8-setup.exe

#define MyAppName "文小舟"
#define MyAppNameEn "Wenxiaozhou"
; build.bat 会从 plugin/package.json 传入版本；直接运行 ISCC 时保留默认值。
#ifndef MyAppVersion
#define MyAppVersion "1.4.8"
#endif
#define MyAppPublisher "文小舟"
#define MyAppURL "https://github.com/lewis-hui1202/WPS-AI"

[Setup]
AppId={{B2A4E27D-3E5C-4F1A-8C6B-2A1D4F7E0011}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\LingxiAI
; 保留旧 AppId 与安装目录，升级时沿用原安装和用户数据。
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=lingxi-ai-{#MyAppVersion}-setup
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName} {#MyAppVersion}
ChangesAssociations=no
SetupIconFile=wenxiaozhou.ico
UninstallDisplayIcon={app}\wenxiaozhou.ico
DisableDirPage=auto

[Languages]
; ChineseSimplified.isl 是非官方翻译,Inno 6.7.1 默认没装,我们把它放在 installer/ 仓库里一并提交
Name: "chinese"; MessagesFile: "ChineseSimplified.isl"

[Files]
; 插件源码（包含 js / css / html / tools）。排除开发依赖/产物；Windows 包只保留 node-win-x64 运行时。
Source: "..\plugin\*"; DestDir: "{app}\plugin"; Excludes: "node_modules\*,dist\*,dist-permanent\*,test\*,.git\*,*.log,wps-addon-build\*,wps-addon-publish\*,runtime\node-win-x64\node_modules\*,runtime\node-linux-*\*,runtime\node-darwin-*\*,runtime\*.zip,runtime\*.tar.gz,runtime\*.tar.xz,tools\lingxi-launcher.exe"; Flags: ignoreversion recursesubdirs createallsubdirs
; 同步附带的 readme/license 便于卸载界面显示来源
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\INSTALL.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "wenxiaozhou.ico"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; 旧版本的开始菜单卸载入口可能因程序组改名而残留。
Type: files; Name: "{userprograms}\灵犀AI\卸载灵犀AI.lnk"

[Icons]
Name: "{group}\卸载{#MyAppName}"; Filename: "{uninstallexe}"; IconFilename: "{app}\wenxiaozhou.ico"

[Run]
; 装完后执行 post-install 脚本：建 ~/.lingxi-ai 变体、publish.xml、Run 键、起后台服务
Filename: "{app}\plugin\tools\post-install-windows.bat"; Parameters: """{app}"""; Flags: runhidden waituntilterminated; StatusMsg: "正在配置 WPS 加载项与后台服务..."
; 提示用户重启 WPS
Filename: "{app}\README.md"; Description: "查看安装后说明"; Flags: postinstall shellexec skipifsilent unchecked

[UninstallRun]
; 卸载前先停服务 + 清理 publish.xml + ~/.lingxi-ai
Filename: "{app}\plugin\tools\pre-uninstall-windows.bat"; Flags: runhidden waituntilterminated; RunOnceId: "LingxiPreUninstall"

[Code]
function InitializeSetup(): Boolean;
begin
  // 安装前检查 runtime/node-win-x64/node.exe 是否在源目录存在（编译时打包进 .exe）
  // 这里我们用编译时检查代替——如果 ISCC 找不到 runtime/ 文件,编译就会报错,
  // 所以运行时不需要再做安全网。
  Result := True;
end;

procedure StopRunningServices();
var
  ResultCode: Integer;
  StopScript, KillCmd: String;
begin
  // Upgrade path: prefer the previous installed cleanup script. Avoid embedding
  // a long PowerShell process-killer command in the installer.
  StopScript := ExpandConstant('{app}\plugin\tools\stop-lingxi-processes.ps1');
  if FileExists(StopScript) then begin
    KillCmd := '-NoProfile -ExecutionPolicy RemoteSigned -File "' + StopScript + '" -RootDir "' + ExpandConstant('{%USERPROFILE}\.lingxi-ai') + '"';
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), KillCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PublishPath, LogPath, MarkerPath: String;
  MarkerValue: AnsiString;
begin
  // ssInstall 在文件复制之前触发,先杀掉老服务防文件锁
  if CurStep = ssInstall then begin
    StopRunningServices();
  end;

  // ssDone 在 [Run] 跑完之后触发,这时可以检查 post-install 有没有真的写出 publish.xml
  if CurStep = ssDone then begin
    MarkerPath := ExpandConstant('{app}\lingxi-install-target.txt');
    if FileExists(MarkerPath) then begin
      if LoadStringFromFile(MarkerPath, MarkerValue) then begin
        PublishPath := Trim(String(MarkerValue));
      end else begin
        PublishPath := ExpandConstant('{userappdata}\kingsoft\wps\jsaddons\publish.xml');
      end;
    end else begin
      PublishPath := ExpandConstant('{userappdata}\kingsoft\wps\jsaddons\publish.xml');
    end;
    LogPath := ExpandConstant('{%USERPROFILE}\.lingxi-ai\install.log');
    if not FileExists(PublishPath) then begin
      MsgBox(
        'post-install 没能写出 publish.xml,WPS 加载项不会显示「文小舟」。' + #13#10 + #13#10 +
        '日志在:' + #13#10 +
        LogPath + #13#10 + #13#10 +
        '常见原因:杀毒/PowerShell 策略拦了脚本,或 WPS 正在运行占住了目录。请把日志发给维护者。',
        mbError, MB_OK);
    end;
  end;
end;
