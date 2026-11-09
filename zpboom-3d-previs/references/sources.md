# 来源、许可与适用环境

整理者：ZPboom.AI。版本 1.2.0（2026-11-05）；在 Azhen.AI 1.0.0 版（MIT，核查日期 2026-11-03）基础上修改与扩展。本技能把作者实际视频中讲解的预演流程整理为指令、脚本和简化示例，以下 GitHub 项目用于方法研究。星标为本次网页显示约数，不是质量认证或安装量。

| 一手来源 | 本次参考的具体方法 | 本包如何使用 |
| --- | --- | --- |
| [CloudAI-X/threejs-skills](https://github.com/CloudAI-X/threejs-skills)，约3.9k stars；[animation skill](https://github.com/CloudAI-X/threejs-skills/blob/main/skills/threejs-animation/SKILL.md)、[interaction skill](https://github.com/CloudAI-X/threejs-skills/blob/main/skills/threejs-interaction/SKILL.md) | 按时间采样动画、相机交互与版本核对 | 独立实现时间线、参数与修改流程，未复制其技能文本；上游MIT |
| [majidmanzarpour/threejs-game-skills](https://github.com/majidmanzarpour/threejs-game-skills)，约2.7k stars；[QA skill](https://github.com/majidmanzarpour/threejs-game-skills/blob/main/skills/threejs-qa-release/SKILL.md) | 可运行模板、确定性检查与真实画面验证 | 独立实现巡检预演和测试接口，未复制其工程；上游MIT |
| [remotion-dev/skills](https://github.com/remotion-dev/skills)，约6.1k stars | 内容参数化、预览与导出分开 | 仅借鉴通用组织思路，无Remotion依赖；未核实该仓库文本再分发许可，不打包其代码或技能文字 |

实际随包的第三方运行库有两个：[Three.js](https://github.com/mrdoob/three.js) 固定 r160，以及 [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.1.3（MIT，用于封装逐帧导出的 MP4）。官方模块与许可位于 `assets/previs-starter/vendor/`，来源细节见同目录 `SOURCE.txt`。它用于几何预演，不宣称当前最新版或提供最终渲染模型。新写的指令、工具脚本和示例代码按本包 MIT 许可分享，第三方版权原样保留。

## 安装格式

- [Agent Skills 规范](https://agentskills.io/specification)：通用目录使用 `SKILL.md` 的 name/description 及相关资源，本包额外信息放在 metadata。

运行示例需要支持 WebGL2 的现代浏览器，以及能提供本地 HTTP 服务的工具（示例使用 Python 3.9+，无额外 Python 包）。逐帧 MP4 导出依赖浏览器 WebCodecs（VideoEncoder / VideoFrame）和随包的 mp4-muxer 5.1.3（MIT，来源见 `assets/previs-starter/vendor/SOURCE.txt`）；不支持时退回 MediaRecorder WebM。
