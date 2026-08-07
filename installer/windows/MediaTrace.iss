#ifndef SourceRoot
  #error SourceRoot is required
#endif
#ifndef StageRoot
  #error StageRoot is required
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef TargetArch
  #define TargetArch "x64"
#endif

#define AppName "MediaTrace"
#define Publisher "MediaTrace"
#define AppId "{{A60D2692-33B3-48B4-BE54-A891DCBF49CE}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={localappdata}\Programs\MediaTrace
DefaultGroupName=MediaTrace
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#SourceRoot}\dist\windows
OutputBaseFilename=MediaTrace-Setup-{#AppVersion}-{#TargetArch}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
#if TargetArch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Files]
Source: "{#StageRoot}\Extension\*"; DestDir: "{app}\Extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageRoot}\NativeHost\mediatrace-native-host.exe"; DestDir: "{app}\NativeHost"; Flags: ignoreversion
Source: "{#SourceRoot}\scripts\register-windows-installer.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "{#SourceRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\README_EN.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\MediaTrace 扩展文件夹"; Filename: "explorer.exe"; Parameters: """{app}\Extension"""
Name: "{group}\MediaTrace 使用说明"; Filename: "{app}\README.md"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Tools\register-windows-installer.ps1"" -InstallRoot ""{app}"" -OpenExtensions"; StatusMsg: "正在注册 Chrome / Edge Native Host…"; Flags: waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Tools\register-windows-installer.ps1"" -InstallRoot ""{app}"" -Uninstall"; Flags: runhidden waituntilterminated

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    MsgBox('MediaTrace 已安装。' + #13#10 + #13#10 +
      '浏览器安全策略不允许商店外扩展被安装程序静默启用。安装程序会打开扩展管理页和 Extension 文件夹，请开启开发者模式并点击“加载已解压的扩展程序”。' + #13#10 + #13#10 +
      '普通用户不需要安装 Visual Studio 或 .NET SDK。', mbInformation, MB_OK);
end;
