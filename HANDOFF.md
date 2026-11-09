# 交接文档：在新电脑上继续开发 zpboom-3d-previs

> 给接手的 AI 助手（Claude Code）和用户本人看。这份文档只在开发分支 `wip/live-mocap` 里，功能做完、合并回 main 之前删掉。

## 1. 现在做到哪了

- **正式版 v2.7.3** 已发布在 `main` 分支（仓库 https://github.com/zpboom324-star/zpboom-3d-previs ）。安装包 `ZPboom.AI_3D预演导演_v2.7.3.zip` 在原来那台笔记本的「下载」文件夹里，没有发 GitHub Release（发 Release 需要用户自己执行 `gh release create`）。
- **正在开发：实时动捕（摄像头）**，代码在本分支，**写完了但还没完整测试**。

### 实时动捕改了哪些文件（都在 `zpboom-3d-previs/assets/previs-starter/`）

| 文件 | 改动 |
| --- | --- |
| `videomocap.js` | 新增「实时动捕」整块：`startCamera / stopCamera / liveFrame / livePose / liveLoop / startRecording / stopRecording`。逐帧一欧元滤波、前后翻转修正、朝向对准正面；录制时 3 秒倒计时后从「起点」按真实时间走时间线，停止后按工程帧率重新取样，交给原有的视频动捕流程（`buildData`：平滑、踩地、跳起检测；对比回放；起点 / 覆盖方式；加到角色）。摄像头片段没有视频可回放，`drawFrame` 只画骨架，`play()` 用定时器逐帧走。`_test` 里加了 `live / startCamera / stopCamera / startRecording / stopRecording` |
| `app.js` | 新增 `renderMocapShot()`：把正在识别的动作套到角色上，用分镜相机渲染第 t 秒画面画进对话框（录制时看着镜头表演）；`mocapCtx.renderShot`；入口按钮 `mocap-live` 的点击事件 |
| `index.html` | 「角色 · 姿态」页新增按钮「实时动捕：用摄像头跟着时间线表演…」（`#mocap-live`）；视频动捕对话框顶部新增「📷 摄像头实时」（`#mc-cam`）、画面切换（`#mc-view`：左边看镜头画面 / 摄像头 + 骨架）、「● 录制」（`#mc-rec`）、帧率（`#mc-fps`） |
| `styles.css` | 上面几个控件的样式 |

### 已经验证的

- 在笔记本（Intel Mac）上：识别模型用显卡启动成功，实时识别约 20 帧/秒。

### 还没验证的（下一步要做）

1. 打开摄像头后，左右两个画面是否正常：镜头画面里所选角色跟着动、摄像头画面 + 骨架。
2. 「● 录制」：倒计时 → 时间线从起点走 → 停止 / 播到结尾自动停 → 回放 → 「加到角色」→ 关掉对话框按空格播放，角色确实在做录下来的动作。
3. 没认出人、拒绝摄像头权限、没有摄像头时的提示文字。
4. 关闭对话框后摄像头指示灯熄灭（`stopCamera` 有没有把轨道停掉）。
5. 在 Windows + Chrome / Edge 上的帧率。

### 测试方法

- 用浏览器打开工程（必须走本地 HTTP 服务，见下文），**浏览器窗口要可见**。窗口隐藏时页面不能播放摄像头画面，测试会卡在「正在打开摄像头」。
- 没有摄像头、或想用固定素材自动测时，可以在页面控制台里把一段视频画到画布上，再用 `canvas.captureStream(30)` 冒充摄像头：

  ```js
  const fv = document.createElement('video'); fv.src = 'clips/某段素材.mp4'; fv.muted = true; fv.loop = true; await fv.play();
  const fc = Object.assign(document.createElement('canvas'), {width: 1280, height: 720}), fg = fc.getContext('2d');
  (function pump() { fg.drawImage(fv, 0, 0, 1280, 720); requestAnimationFrame(pump); })();
  navigator.mediaDevices.getUserMedia = async () => fc.captureStream(30);
  document.getElementById('mocap-live').click();
  ```

  素材用免费可商用的（比如 Mixkit），**不要用用户自己的视频**。
- 读数值核对：`window.__ZPBOOM_PREVIS__` 的 `seek()`、`point('A.hand_R')`、`getState()`、`mocapModule()._test`。

### 测完之后要做的（发布 v2.7.4）

1. 文档：`zpboom-3d-previs/docs/web-guide.md` 第 13 节加「实时动捕」，README 的「视频动捕」一节、`references/motion-capture.md` 补上；CHANGELOG 加 2.7.4。
2. 版本号：`SKILL.md` 的 `version`、`app.js` 和 `index.html` 里所有 `?v=2.7.3` 改成 `?v=2.7.4`（不改的话用户浏览器会继续用缓存里的旧脚本）。
3. 同步：把仓库里的 `zpboom-3d-previs/` 复制到本机技能目录；用户的预演工程把 `app.js / editor.js / index.html / styles.css / videomocap.js` 换成新模板的（先确认工程里这些文件和旧模板一致，有改动的跳过）。
4. 打包：`python tools/make_package.py 2.7.4`，产物在 `dist/`（已加进 .gitignore）。打包后解压核对：安装 zip 里的技能和仓库一致、清单里的 sha256 全部对得上、扫一遍有没有私人名称。
5. 合并：本分支合并回 `main`、删掉这份 HANDOFF.md、推送。推送和发 Release 属于公开发布，**由用户确认后执行**。

## 2. 用户的固定要求（原电脑上的记忆，不会自动同步，接手时请记住）

- **界面固定**：所有工程都用模板自带的 NLE（剪辑软件）风格界面，不为单个项目重新设计。要改界面就改模板本身，并升级所有工程。
- **新建预演工程前，用一次 AskUserQuestion 问 4 题**（用户已说明的跳过）：人物白膜（精细 / 简化胶囊）、预演画面亮度（明亮可读 / 按分镜影调）、分镜机位与空间冲突（保持空间真实并标注 / 严格按分镜）、做到哪一步（只预演 / + 参考视频 / + 生成交接）。用 `new_project.py --figure --lighting --camera --deliver` 记进 revision-log。
- **动作方式不问**：没说就是方式 1（关键帧），说「动捕 / Mixamo / FBX」才是方式 2。
- **私人内容绝不进公开包或仓库**：用户自己的工程名、角色名（比如之前的几个短片工程）、截图、视频。打包前要扫一遍。
- 下载文件、发帖、推送、发 Release 这类对外操作，先问用户。
- 回复用中文。

## 3. 用户的预演工程

在原来那台 Mac 的 `~/Documents/` 下，一共 5 个（名字不写在这里，这个仓库是公开的）。**这些是私人内容，不在 GitHub 上**，需要用户自己用 U 盘 / 网盘拷到新电脑。工程里有 `tools/build_scene.py` 的，用户在网页里改过并保存以后就不要再运行它（会覆盖网页修改）。

## 4. 在 Windows 台式机上搭环境

1. 安装 **Claude 桌面版**（https://claude.ai/download ），登录同一个账号。
2. 安装 **Git for Windows**（https://git-scm.com/download/win ）和 **GitHub CLI**（https://cli.github.com ，下载 Windows 的 .msi）。
3. 安装 **Python 3**（https://www.python.org/downloads/ ，安装时勾选「Add python.exe to PATH」）。
4. 浏览器用 **Chrome 或 Edge**；接好摄像头。
5. 打开「终端」（PowerShell），依次运行：

   ```powershell
   gh auth login
   cd $HOME\Documents
   git clone https://github.com/zpboom324-star/zpboom-3d-previs.git
   cd zpboom-3d-previs
   git checkout wip/live-mocap
   New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
   Copy-Item -Recurse -Force .\zpboom-3d-previs "$HOME\.claude\skills\"
   ```

6. 在 Claude 桌面版里选 `Documents\zpboom-3d-previs` 这个文件夹开一个新会话，说：

   > 读 HANDOFF.md，继续测试和完成实时动捕。

### Windows 上的小差别

- Python 命令是 `python` 或 `py`，不是 `python3`。
- 打开示范案例：`python -m http.server 8000 --bind 127.0.0.1 --directory "$HOME\.claude\skills\zpboom-3d-previs\assets\previs-starter"`，然后浏览器打开 http://127.0.0.1:8000 。
- 技能目录是 `%USERPROFILE%\.claude\skills\zpboom-3d-previs\`。改了仓库里的技能后，要再复制一次到技能目录，或者让 Claude 帮你同步。
