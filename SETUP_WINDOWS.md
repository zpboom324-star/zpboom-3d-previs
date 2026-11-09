# 给 Windows 上的 Claude：搭环境并接手 zpboom-3d-previs 开发

> **这份文档是写给你（Claude Code）执行的。** 用户会把这份文档的链接发给你，希望你**自己从头做到尾**，不需要用户操控终端。
> 只有下面标了「⏸ 需要用户」的地方才停下来请用户点一下，其余全部由你执行、检查、出错自己处理。全程用中文和用户交流，每完成一步用一句话报告。

## 背景

用户之前在一台 Intel Mac 上和 Claude 一起开发技能 `zpboom-3d-previs`（3D 网页预演，Three.js）。Mac 太卡，换到这台 Windows 台式机继续。

- 技能仓库（公开）：`https://github.com/zpboom324-star/zpboom-3d-previs`
  - `main`：正式版 v2.7.3
  - `wip/live-mocap`：开发分支，含**还没测试**的「实时动捕（摄像头）」功能，以及交接文档 `HANDOFF.md`
- 用户的预演工程（私有）：`https://github.com/zpboom324-star/zpboom-previs-projects`
  - 里面的工程没有 `vendor/` 运行库（为了上传小），要从技能模板补回来。

---

## 第 1 步：检查并安装软件

用 PowerShell 执行。先检查，已经有的跳过：

```powershell
git --version; gh --version; python --version
```

缺哪个装哪个（用 winget，Windows 10/11 自带）：

```powershell
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
```

⏸ 需要用户：安装时 Windows 可能弹出「是否允许此应用对你的设备进行更改」，请用户点「是」。

装完后在当前会话刷新 PATH，再检查一次：

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
git --version; gh --version; python --version
```

- `python` 打开的是微软商店 → 用 `py` 代替 `python`，或检查 Python 安装时有没有加进 PATH。
- winget 不可用 → 请用户手动从 https://git-scm.com/download/win 、https://cli.github.com 、https://www.python.org/downloads/ （勾选「Add python.exe to PATH」）安装，装完你再继续。

另外确认：电脑上有 **Chrome 或 Edge**；**摄像头已连接**（问用户一句即可）。

## 第 2 步：登录 GitHub

先检查是否已登录：

```powershell
gh auth status
```

没登录就执行：

```powershell
gh auth login --hostname github.com --git-protocol https --web
```

⏸ 需要用户：命令会显示一个一次性验证码（`XXXX-XXXX`）并打开浏览器。把验证码**原样告诉用户**，请用户在打开的网页里粘贴 → Continue → Authorize github。用户说好了以后，再跑 `gh auth status` 确认显示 `Logged in to github.com account zpboom324-star`。

如果你的终端工具没法和这个交互命令配合（卡住、没输出），请用户自己在 PowerShell 里运行上面这条命令，完成后告诉你。

## 第 3 步：下载技能并装进技能目录

```powershell
cd $HOME\Documents
if (-not (Test-Path zpboom-3d-previs)) { git clone https://github.com/zpboom324-star/zpboom-3d-previs.git }
cd zpboom-3d-previs
git fetch; git checkout wip/live-mocap; git pull
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse -Force .\zpboom-3d-previs "$HOME\.claude\skills\"
Test-Path "$HOME\.claude\skills\zpboom-3d-previs\SKILL.md"
```

最后一行应该输出 `True`。

## 第 4 步：下载用户的预演工程并补回运行库

```powershell
cd $HOME\Documents
if (-not (Test-Path zpboom-previs-projects)) { git clone https://github.com/zpboom324-star/zpboom-previs-projects.git }
cd zpboom-previs-projects
Get-ChildItem -Directory | ForEach-Object { Copy-Item -Recurse -Force "$HOME\.claude\skills\zpboom-3d-previs\assets\previs-starter\vendor" $_.FullName }
Get-ChildItem -Directory | ForEach-Object { "$($_.Name): " + (Test-Path "$($_.FullName)\vendor\three.module.js") }
```

每个工程都应该是 `True`。

- 克隆失败、提示仓库不存在 → 说明用户还没在 Mac 上上传工程。告诉用户：「预演工程还没传上来，等你在 Mac 上做完那一步再说；我先继续技能开发。」然后跳过这一步。
- 这些工程是用户的**私人内容**，只放在这个私有仓库和本机，**绝不复制进公开的技能仓库**。

验证能打开（任选一个工程，后台启动服务，用浏览器打开 http://127.0.0.1:8000 看一眼，再停掉服务）：

```powershell
python -m http.server 8000 --bind 127.0.0.1 --directory "<某个工程的完整路径>"
```

## 第 5 步：记住用户的固定要求

把下面几条存进你的记忆（memory），以后的会话都要遵守：

1. **界面固定**：预演工程一律用模板自带的 NLE（剪辑软件）风格界面，不为单个项目重新设计；要改界面就改模板本身并升级所有工程。
2. **新建预演工程前，用一次 AskUserQuestion 问 4 题**（用户已说明的跳过）：人物白膜（精细白膜 / 简化胶囊）、预演画面亮度（明亮可读 / 按分镜影调）、分镜机位与空间冲突（保持空间真实并标注 / 严格按分镜）、这次做到哪一步（只预演 / + 参考视频 / + 生成交接）。
3. **动作方式不问**：没说就是方式 1（关键帧）；说「动捕 / Mixamo / FBX」才是方式 2。
4. **私人内容不进公开包或公开仓库**：用户自己的工程、角色名、截图、视频。打包前扫一遍。
5. 下载文件、推送到 GitHub、发 Release 这类对外操作，**先问用户**。
6. 回复用中文。

## 第 6 步：接手开发

1. 读技能仓库里的 `HANDOFF.md`（`$HOME\Documents\zpboom-3d-previs\HANDOFF.md`），里面有：实时动捕改了哪些文件、已验证 / 未验证的 5 项、测试方法、测完后发布 v2.7.4 的步骤。
2. 用技能模板起一个测试工程（比如复制 `$HOME\.claude\skills\zpboom-3d-previs\assets\previs-starter` 到一个临时文件夹），用本地服务打开，**在你的浏览器面板里**测试实时动捕。
   - ⏸ 需要用户：测试时请用户把浏览器面板显示出来（面板隐藏时页面不能播放摄像头画面）；浏览器第一次问摄像头权限时，请用户点「允许」，并站到摄像头前做几个动作。
   - 没有摄像头时，用 HANDOFF.md 里「用画布冒充摄像头」的方法，素材用免费可商用的视频。
3. 发现问题直接改 `$HOME\Documents\zpboom-3d-previs\zpboom-3d-previs\` 里的代码，改完同步到 `$HOME\.claude\skills\zpboom-3d-previs\` 再测。
4. 全部通过后，按 HANDOFF.md 的「测完之后要做的」完成文档、版本号、打包（`python tools\make_package.py 2.7.4`）。
5. 推送到 GitHub、合并回 main、发 Release 之前，**把要做的事列给用户，等用户同意**。

## 完成后向用户汇报

用几句话说清楚：装了什么、技能和工程放在哪、实时动捕测到什么程度、还剩什么要用户决定。
