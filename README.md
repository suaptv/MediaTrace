<p align="center">
  <img src="docs/images/mediatrace-hero.png" alt="MediaTrace 从网页发现视频并投屏到电视" width="100%">
</p>

<h1 align="center">MediaTrace</h1>

<p align="center"><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>

<p align="center">
  在 Safari、Chrome 与 Microsoft Edge 中发现当前网页的视频地址，并推送到局域网 DLNA 设备(比如电视)。
</p>

<p align="center">
  支持 M3U8 · MP4 · FLV · M4S · 网页媒体分片 · 使用DLNA协议将网页中视频地址推送到电视 
</p>

---

## 它能做什么

打开视频网站并开始播放，MediaTrace 会在浏览器工具栏显示发现数量。点击图标即可查看媒体地址、视频时长和直播/点播类型，也可以复制地址或投屏到电视。

```mermaid
flowchart LR
    A[打开网页并播放视频] --> B[MediaTrace 自动发现媒体]
    B --> C[查看或复制视频地址]
    B --> D[选择 DLNA 设备投屏]
```

> **不支持 DRM 网页：** MediaTrace 只展示网页已经访问的普通媒体地址，不支持受 DRM（数字版权管理）保护的视频，也不会绕过 DRM、登录验证或网站访问控制。

## 使用前准备

| 你使用的浏览器 | 需要准备 |
| --- | --- |
| macOS Safari | macOS 12.3 或更高版本、Xcode |
| iPhone / iPad Safari | iOS / iPadOS 15.4 或更高版本、Xcode |
| macOS Chrome | Chrome；使用 DLNA 时还需要安装本地服务 |
| macOS Microsoft Edge | Edge；使用 DLNA 时还需要安装同一个本地服务 |
| Windows Chrome / Edge | Windows 10 1809 或更高版本（推荐 Windows 11）；普通用户使用 Setup 安装包不需要 Visual Studio 或 .NET SDK |

> **Safari 安装必须签名：** macOS、iOS 和 iPadOS 版本都由宿主 App 与 Safari Extension 组成。两个 Target 必须选择同一个有效 Apple Developer Team，并成功签名后，系统才会安装和显示扩展。仅完成编译但没有有效签名时，Safari 设置中可能完全看不到 MediaTrace。

## Chrome 安装

### 1. 加载插件文件夹

1. 在 Chrome 地址栏打开 `chrome://extensions`。
2. 打开右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目文件夹：

   ```text
   ~/Desktop/MediaTrace
   ```

5. 在 MediaTrace 卡片上点击“固定”，让图标显示在浏览器顶部。

以后修改插件代码，只需回到 `chrome://extensions`，点击 MediaTrace 的“重新加载”。

### Microsoft Edge 安装

Edge 直接使用同一个扩展文件夹和构建产物，无需维护另一个版本：

1. 在 Edge 地址栏打开 `edge://extensions`；
2. 打开“开发人员模式”；
3. 点击“加载解压缩的扩展”；
4. 选择 `~/Desktop/MediaTrace`；
5. 将 MediaTrace 固定到 Edge 工具栏。

修改代码后，在 `edge://extensions` 点击“重新加载”。`npm run build:edge` 与 `npm run build:chrome` 会生成同一个兼容 Chromium 的 CRX。

### 2. 安装并签名 SSDP 本地服务

Chrome 扩展自身不能发送 SSDP UDP 多播。如果需要搜索电视或其他 DLNA 设备，必须在这台 Mac 上安装一次 Native Messaging Host。

Chrome 在 macOS 上读取用户级 Native Messaging Host 的目录是：

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
```

Microsoft Edge 对应目录是：

```text
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/
```

MediaTrace 默认生成的注册文件是：

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.mediatrace.json
```

这是 Chrome 原生服务的注册目录，不是“加载已解压的扩展程序”时选择的插件目录。文件夹插件仍应加载项目根目录 `/Users/你的用户名/Desktop/MediaTrace`。

打开“终端”，依次执行：

```bash
cd ~/Desktop/MediaTrace
npm run build:chrome
./scripts/install-chrome-native-host.sh
```

安装脚本会提示输入统一的 Native Host Identifier：

```text
Native Host Identifier [app.mediatrace]:
```

直接回车使用默认值，也可以输入自己的标识，例如 `com.example.mediatrace.nativehost`。自动化安装时可以使用：

```bash
MEDIATRACE_NATIVE_ID=com.example.mediatrace.native \
  ./scripts/install-chrome-native-host.sh
```

脚本会把同一个值同步写入 Chrome 扩展的 `NATIVE_APP_ID`、Host JSON 的 `name` 和文件名，以及原生 App 的 `CFBundleIdentifier`。默认统一使用 `app.mediatrace`。

不要填写 Safari Extension 使用的 `*.Extension` 标识；安装脚本会拒绝这种配置，避免 Chrome Host 与 Safari 扩展共用本地网络权限身份。

默认使用本机 Ad-hoc 签名。如果钥匙串中安装了有效的 Apple Development 或 Developer ID Application 证书，可以指定真实签名身份：

```bash
MEDIATRACE_NATIVE_ID=com.example.mediatrace.native \
MEDIATRACE_CODESIGN_IDENTITY="Developer ID Application: Example Name (TEAMID)" \
  ./scripts/install-chrome-native-host.sh
```

使用 Apple 签发的身份后，`codesign` 输出应包含 Team Identifier，macOS 能更稳定地记录 Native Host 的“本地网络”权限。

确认输入后，脚本会同步更新 `src/background.js` 和项目内 `native-host/Info.plist`，同时生成 Chrome 与 Edge 的 Host JSON，再执行编译与签名。安装后需要重新加载插件，并完全重启正在使用的浏览器。

这两个命令会自动完成：

- 生成或复用 `dist/chrome/mediatrace.pem`，保持 Chrome 扩展 ID 稳定；
- 将 PEM 对应的公钥写入 `manifest.json`，使文件夹加载与 CRX 使用相同的扩展 ID；
- 编译 Swift SSDP 本地服务；
- 使用 macOS `codesign` 为本地服务签名；
- 注册 `app.mediatrace.native` Native Messaging Host；
- 自动把 CRX ID 和当前“文件夹加载”的扩展 ID 加入白名单。

安装完成后，用 `Command + Q` 完全退出 Chrome，再重新打开。

如果 Chrome 尚未把当前配置写入磁盘，也可以把工具栏页面显示的扩展 ID 明确交给安装脚本，无需修改 JSON：

```bash
MEDIATRACE_CHROME_EXTENSION_ID=你的32位扩展ID \
  ./scripts/install-chrome-native-host.sh
```

可以检查 Chrome 是否已经找到注册文件：

```bash
ls -la "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/"
cat "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.mediatrace.json"
```

可以用下面的命令检查签名：

```bash
codesign --verify --deep --strict --verbose=2 \
  "$HOME/Library/Application Support/MediaTrace/MediaTrace Native Host.app"
```

没有错误输出就表示签名验证成功。

> `mediatrace.pem` 是私钥，请勿发送给别人、上传到公开仓库或删除。删除它后重新打包会改变扩展 ID，需要重新安装 Native Host。

### Windows Chrome / Edge 安装

#### 普通用户：使用一键安装包（推荐）

从项目 Releases 下载与电脑架构对应的安装程序：

- 大多数 Intel / AMD 电脑：`MediaTrace-Setup-版本-x64.exe`；
- Windows on Arm 电脑：`MediaTrace-Setup-版本-arm64.exe`。

双击安装程序后，它会自动完成：

- 安装预编译、自包含的 Windows Native Host；
- 生成稳定扩展 ID；
- 注册本机已经安装的 Chrome 和 Microsoft Edge；
- 部署扩展文件并打开浏览器扩展管理页；
- 打开需要加载的 `Extension` 文件夹。

普通用户**不需要安装 Visual Studio、Visual Studio Build Tools、.NET SDK 或 Node.js**。

由于 Chrome/Edge 的安全策略，未上架浏览器商店的扩展不能被第三方 EXE 静默启用。安装结束后只需完成一次浏览器操作：

1. 在自动打开的扩展管理页开启“开发者模式”；
2. 点击“加载已解压的扩展程序”；
3. 选择安装程序已经打开的 `Extension` 文件夹；
4. 完全退出并重新打开浏览器。

若 Windows 防火墙询问网络访问，请允许专用网络，否则可能收不到 SSDP/DLNA 设备响应。

#### Windows 编译环境与最低版本

以下工具只供**项目维护者自行制作 Setup 安装包**使用，普通用户不需要：

- 最低系统：Windows 10 版本 1809（64 位）或 Windows 11；
- 最低 PowerShell：Windows PowerShell 5.1；
- 必需编译环境：[.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) 8.0.100 或更高版本，注意必须安装 **SDK**，仅安装 `.NET Runtime` 不够；
- Visual Studio **不是必需项**：安装脚本直接使用 `dotnet publish` 编译 Native Host；
- 如果希望在 Visual Studio 中打开和编译项目，最低使用 **Visual Studio 2022 17.8**，并安装“.NET 桌面开发”工作负载或单独安装 .NET 8 SDK；
- Visual Studio Build Tools 也不是运行安装脚本的必要条件。若已经安装 Build Tools，仍需确保命令行能够执行 `dotnet --version` 并显示 `8.0.100` 或更高版本。
- 制作 `MediaTrace-Setup.exe` 还需要 Node.js 18+ 与 Inno Setup 6.3+。

维护者生成安装包：

```powershell
.\scripts\build-windows-installer.ps1 -Architecture x64
.\scripts\build-windows-installer.ps1 -Architecture arm64
```

生成结果位于 `dist\windows\`。也可以在 GitHub Actions 中手动运行 **Build Windows Installers**，或推送 `v*` 标签自动生成两个架构的安装包。

在 PowerShell 中确认环境：

```powershell
dotnet --version
$PSVersionTable.PSVersion
```

如果 `dotnet` 命令不存在，或者只安装了 Runtime，请先安装 x64 或 Arm64 架构对应的 .NET 8 SDK，然后重新打开 PowerShell。

1. 仅使用媒体检测和复制地址时，直接在 `chrome://extensions` 或 `edge://extensions` 加载项目根目录即可；
2. 如需 DLNA 搜索、投屏、进度同步和快进同步，先安装上述 .NET 8 SDK；
3. 在项目目录打开 PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-native-host.ps1
```

脚本会自动完成：

- 检测本机已安装的 Chrome 和 Edge，只为实际存在的浏览器写入 Native Messaging 注册；
- 根据系统架构生成 `win-x64` 或 `win-arm64` 单文件 Native Host；
- 生成或复用 `%LOCALAPPDATA%\MediaTrace\mediatrace.pem`，自动把固定公钥写入 `manifest.json`；
- 扫描 Chrome 与 Edge 各个 Profile 中加载的 MediaTrace 扩展 ID；
- 生成 `%LOCALAPPDATA%\MediaTrace\NativeHost\app.mediatrace.json`；
- 如果安装了 Chrome，注册 `HKCU\Software\Google\Chrome\NativeMessagingHosts`；
- 如果安装了 Edge，注册 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts`。

脚本不依赖浏览器必须先写入扩展 ID；即使扫描不到，也会根据本地身份密钥自动生成固定 ID。如果希望同时保留某个旧 ID，也可以明确传入：

```powershell
.\scripts\install-windows-native-host.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
```

首次执行脚本后，`manifest.json` 会获得固定公钥。如果 MediaTrace 此前已经加载，请在扩展管理页面删除旧版本，再重新“加载解压缩的扩展”，确保浏览器采用脚本输出的固定 ID。然后完全退出并重新打开 Chrome/Edge。Windows 防火墙首次询问时允许当前专用网络访问，否则可能无法收到 SSDP 设备响应。卸载命令：

```powershell
.\scripts\uninstall-windows-native-host.ps1
```

Windows 版本支持 SSDP、DLNA 投屏、自定义请求头、电视进度读取和 `REL_TIME` 快进。AirPlay `.local` 地址发现仅在 Apple 平台提供。

## Safari 安装

### 配置自己的 Apple 签名

公开仓库不保存作者的 Team ID 或个人 Bundle Identifier。首次构建前运行：

```bash
./scripts/configure-apple-signing.sh
```

依次输入自己的 Base Bundle Identifier 和 Apple Developer Team ID。脚本会自动配置 iOS/macOS 的 App 与 Extension，共 8 个 Debug/Release 构建配置。两个平台的主体统一使用 Base ID，两个平台的扩展统一使用 `Base ID.Extension`。

也可以无交互执行：

```bash
MEDIATRACE_APPLE_BASE_ID=com.example.mediatrace \
MEDIATRACE_APPLE_TEAM_ID=YOURTEAMID \
  ./scripts/configure-apple-signing.sh
```

准备上传公开仓库前，可以运行：

```bash
./scripts/sanitize-public-project.sh
```

该脚本会清除 Apple Team ID、个人 Bundle Identifier、Chrome PEM/CRX、Xcode 用户数据，并恢复公开项目的通用标识。删除 PEM 后 Chrome 扩展 ID 会改变，请先自行私下备份需要长期复用的密钥。

### 1. 生成 Safari 工程资源

```bash
cd ~/Desktop/MediaTrace
./scripts/build-safari.sh
```

### 2. 在 Xcode 中运行

1. 打开：

   ```text
   safari-project/MediaTrace/MediaTrace.xcodeproj
   ```

2. 在 Xcode 的 Signing & Capabilities 中选择自己的 Team。
3. Mac 选择 `MediaTrace (macOS)`；iPhone/iPad 选择 `MediaTrace (iOS)`。
4. 点击运行按钮安装 MediaTrace。

请分别检查当前平台的宿主 App 和 Extension Target：两者必须使用同一个 Team，并且 Signing 状态不能有红色错误。macOS 与 iOS 是独立 Target，需要分别完成签名设置；其中一个平台的签名不能代替另一个平台。

### 3. 在 Safari 中启用

macOS：

1. 打开 Safari → 设置 → 扩展。
2. 勾选 MediaTrace。
3. 将网站访问权限设置为“所有网站”。

iPhone / iPad：

1. 打开系统设置 → Safari → 扩展 → MediaTrace。
2. 开启“允许扩展”。
3. 将网站权限设置为“允许”。
4. 使用 DLNA 时，在系统“本地网络”设置中允许 MediaTrace。

## 开始使用

1. 打开视频网站并开始播放。
2. 点击浏览器顶部的 MediaTrace 图标。
3. 打开“自动检测”。
4. 刷新网页并继续播放。
5. 在媒体列表中选择操作：

   - “复制地址”：复制 M3U8、MP4、FLV 或其他媒体地址；
   - “投屏”：把当前媒体发送给已选择的 DLNA 设备；
   - “清空”：清除当前网页已经发现的媒体。

插件图标右上角的数字，就是当前页面发现的媒体数量。

## DLNA 投屏

### 使用 AirPlay 广播查找稳定地址

AirPlay 仅作为手动添加 DLNA 设备时的地址查找助手。在“手动添加设备”中点击“从 AirPlay 查找 `.local` 地址”，选择同一台接收设备后，MediaTrace 会按 `http://设备.local:9030/description.xml` 填入 DLNA 地址。已有地址会保留原端口，没有端口时自动补上 `9030`。

设备 IPv4 变化后，Apple 系统仍可通过 `.local` 主机名重新解析；实际投屏继续使用兼容性更好的 DLNA AVTransport 协议。

### 自动搜索设备

> **签名与 SSDP 权限说明：** 自动发现 DLNA 设备需要发送 SSDP UDP 多播，不同平台的要求并不相同。

| 平台 | 自动搜索 DLNA 的要求 |
| --- | --- |
| iOS / iPadOS Safari | App 与 Extension 必须有效签名；还需要向 Apple 申请并获批 `Multicast Networking` 能力，App ID 和 Provisioning Profile 必须实际包含对应 entitlement；同时允许“本地网络”权限。 |
| macOS Safari | App 与 Extension 必须使用同一个有效 Team 正确签名；macOS 不要求 iOS 的受限 Multicast entitlement，但仍需允许“本地网络”访问。 |
| macOS Chrome / Edge | Swift Native Host 必须完成编译、签名和 Native Messaging 注册；扩展 ID 必须在白名单中，并且当前浏览器需要获得“本地网络”权限。 |

仅在 Xcode 工程中写入 entitlement 不代表 iOS 已获得权限。没有 Apple 批准、签名不匹配或 Provisioning Profile 不包含能力时，SSDP 可能返回 `errno 65`、网络不可达或搜索不到设备。

1. 打开插件的“投屏设备”页面。
2. 点击“刷新搜索”。
3. 点击搜索结果中的电视或播放器，将它设为当前设备。
4. 回到媒体列表，点击“投屏”。

Chrome 首次搜索前必须完成上面的“SSDP 本地服务”安装。Safari 会使用 App 内置的原生 SSDP 服务。

对于普通安装和未申请 Apple 多播权限的用户，建议直接使用下面的“手动添加设备”。手动填写设备的 `description.xml` 或 AVTransport Control URL 不依赖 SSDP 多播搜索，通常更稳定。

### 手动添加设备

如果自动搜索不到设备，可以填写设备描述地址，例如：

```text
设备名称：客厅电视
设备地址：http://192.168.0.112:9030/description.xml
```

MediaTrace 会读取 XML，并自动找到真正的 AVTransport Control URL。也可以直接填写已经知道的 Control URL。

添加成功后，设备会立即显示在当前列表中。

### 下一集自动投屏

选中一个设备后打开“下一集投屏”。网页切换到下一集并发现新媒体时，MediaTrace 会继续投屏到当前设备。

## 常见问题

### Chrome 提示 Native Messaging Host 被禁止

重新执行：

```bash
./scripts/install-chrome-native-host.sh
```

然后完全退出并重新打开 Chrome。脚本会重新识别文件夹加载的扩展 ID。

### 搜索不到 DLNA 设备

- 确认电脑、手机和电视连接同一个 Wi-Fi；
- 关闭路由器的 AP 隔离或访客网络隔离；
- 确认 MediaTrace 已获得“本地网络”权限；
- Chrome 用户确认 Native Host 已安装；
- 仍然搜索不到时，可以手动输入设备的 `description.xml`。

iPhone/iPad 如果提示“SSDP 多播网络不可达（en0）”，请确认开发者后台和实际 Provisioning Profile 都包含 `Multicast Networking` entitlement，仅在工程文件中写入 entitlement 不足以获得 iOS 多播权限。修改签名配置后需要从设备删除旧 App，再重新安装并允许“本地网络”。

### iOS、macOS 与 Chrome 的签名区别

- **iOS / iPadOS：** 除有效 Apple 签名外，SSDP 多播还依赖 Apple 批准的 `Multicast Networking` 能力。普通免费签名或未获批的 Provisioning Profile 通常无法完成自动搜索。
- **macOS Safari：** 不需要申请 iOS 的 Multicast entitlement；宿主 App 与 Safari Extension 正确签名并获得“本地网络”权限后即可使用 SSDP。
- **macOS Chrome：** Chrome 不执行 Swift 源码，而是启动已编译、已签名并注册的 Native Host。Host JSON 名称、扩展中的 `NATIVE_APP_ID`、Bundle Identifier 和白名单必须按照安装脚本保持一致。
- **推荐方案：** 如果没有 iOS 多播审批、签名不稳定或系统未授予本地网络权限，使用“手动添加设备”最可靠，也不依赖 SSDP 广播。

### 没有发现视频

- 确认“自动检测”已经打开；
- 打开开关后刷新网页并重新播放；
- 确认扩展拥有当前网站或“所有网站”的访问权限；
- **DRM 加密网页不支持；** Blob/MSE、需要加密授权或使用短时效签名的媒体也可能无法识别、复制或投屏；

## 使用与授权声明

MediaTrace 是一个**免费、仅限非商业用途**的源代码项目。在遵守以下条件的前提下，你可以学习、使用、复制、转载、分发和二次修改本项目：

- 必须保留项目名称、原作者/原项目来源以及本使用与授权声明；
- 修改或转载版本应明确说明已经过修改，不得使他人误认为是官方原始版本；
- 可以免费分享修改后的源代码或安装包，但不得收取软件费用、授权费用或强制捐赠；
- 不得将本项目或其修改版本用于任何直接或间接商业用途；本项目不提供商业使用、商业集成或商业再授权许可；
- 不得将本项目的代码、文档、图片、构建产物、测试数据或修改版本用于人工智能或机器学习的数据训练。

禁止的商业用途包括但不限于：销售软件或服务、付费下载、付费会员功能、广告或流量变现、企业内部商业部署、作为收费产品的组成部分、以本项目提供有偿技术服务，以及通过重新包装或预装获取商业利益。

禁止的 AI 数据用途包括但不限于：模型预训练、继续训练、微调、蒸馏、强化学习、检索语料库、向量化训练集、代码补全训练、模型评测数据集，以及为生成式人工智能或其他机器学习系统收集、复制、抓取、整理或提供本项目内容。仅使用普通工具阅读、搜索、编译或修改本项目，不视为数据训练；但不得将由此取得的项目内容加入任何训练数据集。

本项目按“现状”免费提供，不承诺适销性、特定用途适用性、持续维护或无错误。使用者应自行确认对媒体内容、网站服务、商标及第三方组件拥有合法使用权限，并自行承担使用、修改或分发产生的风险与责任。第三方代码和依赖仍分别适用其原有许可证。

本项目**禁止任何形式的商业使用**，不因署名、转载、修改、免费提供下载或保留本声明而获得商业使用权。无法确定某种使用方式是否属于商业用途时，应视为不被许可并停止使用，不得自行作扩大解释。

任何违反上述非商业限制的使用均超出本项目授权范围，相关复制、修改、分发、部署及衍生使用许可立即终止。项目权利人保留要求停止使用、删除相关副本以及依法追究版权责任的权利。本声明旨在明确授权边界并避免版权和使用许可纠纷。

---

<p align="center">MediaTrace 永久免费 · 允许非商业修改与转载 · 禁止商业使用及 AI 数据训练</p>
