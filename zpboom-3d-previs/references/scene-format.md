# scene.json 配置约定（schemaVersion 2 · 统一模板）

模板的 `app.js / index.html / styles.css` 是通用引擎和界面，**新工程只写 `scene.json`，不改这三个文件**。场景几何、灯光、人物体型、姿态、道具、结构动画、特效和声音提示都是数据。检查器会按 scene.json 自动生成字段，镜头按钮按数量自动排列。

单位与时间约定：
- 世界坐标 Y 向上、单位米。
- 人物的 `yaw / pitch / roll / aim / look` 用**弧度**；场景节点的 `rotation`、道具在地面时的 `rotation`、结构 `rigs` 的数值用**度**。
- 角色、道具、结构、特效、提示用**全片秒**；相机关键帧用**镜头内局部秒**。
- 所有关键帧之间线性插值。硬切处如果要瞬移，在切点前后各放一个关键帧（例如 10.499 和 10.5）。

## 顶层结构

```json
{
  "schemaVersion": 2, "title": "片名", "fps": 30, "duration": 15, "aspectRatio": "16:9",
  "world": {"up": "Y", "unit": "meter", "background": "#0b0e12", "exposure": 1.2, "fog": [18, 45],
            "floor": {"size": [30, 22], "color": "#2d2f32", "roughness": 0.95}, "grid": true},
  "lights": [], "set": [], "kinds": {}, "poses": {}, "actors": [], "props": [], "rigs": [], "fx": [], "cues": [], "shots": [],
  "extensions": []
}
```

`aspectRatio` 支持 16:9 / 21:9 / 9:16 / 1:1 / 4:3 / 3:4。导出 MP4 按画幅自动选尺寸：16:9 为 1920×1080，21:9（电影宽银幕）为 2520×1080（浏览器编码器不支持时自动退到 1920×822），9:16 为 1080×1920，1:1 为 1080×1080，4:3 为 1440×1080，3:4 为 1080×1440。

`world.figure` 选人物白膜：`"jointed"`（默认，精细关节白膜）或 `"pill"`（简化胶囊：球头 + 与头同直径、可弯曲的胶囊身体，无四肢无五官，微微悬浮）。只换外形，骨架、关节、IK、道具挂点和所有部位坐标照旧计算，所以动作、接触和导出都不受影响；走、跑、扑、弯腰、倒地时胶囊身体是一根直的（整体随重心前倾、倾倒，底端在骨盆正下方，不随迈步晃），只有下蹲、坐下这类骨盆明显降低、上身仍立着的动作才沿「两脚中点 → 骨盆 → 胸 → 肩」弯曲；身体底端离地约 16 厘米悬浮；头紧贴身体顶端，只留一条细缝。简化胶囊模式下**不画道具**（道具挂点、换手和手部接触照常计算，切回精细白膜就会显示），道具交给提示词和道具图。网页顶栏下拉可一键切换。

`world.whitebox: true` 打开**白膜场景**：场景几何统一成带一点原色倾向的白灰哑光（不受光的黑洞、玻璃、发光体保持原样），人物和道具保留颜色。`world.handheld`（0–3，建议 0.3–0.5）给全片加手持相机漂移，镜头的 `camera.handheld` 可单独覆盖，固定机位写 0。

## lights

`{"type": "hemisphere|directional|point|spot|ambient", "color", "intensity", "ground"(半球光地面色), "position", "target", "distance", "decay", "angle"(度, spot), "penumbra", "shadow": true, "shadowBox"(平行光阴影半宽, 默认 14), "editorOnly": true}`

`editorOnly` 是编辑用的工作光：勾选「网格 / 角色标签」时才亮，干净模式和导出 MP4 时自动关闭。夜景、暗场建议配一盏。

## set：场景几何（数据搭建，不写代码）

节点通用字段：`type, id?, position, rotation(度), scale, color, material, cast, receive, repeat, children, rig, helper`。

| type | 专有字段 |
| --- | --- |
| `box` | `size: [x,y,z]` |
| `cylinder` | `radius` 或 `radiusTop / radiusBottom`，`height`，`segments`，`open` |
| `cone` | `radius, height, segments, open` |
| `sphere` | `radius, segments, thetaLength(度，半球用 90)` |
| `plane` | `size: [w,h]`（默认竖直，地面要 `rotation: [-90,0,0]`） |
| `circle` | `radius, segments`（水洼、地面光斑） |
| `group` | 只用来分组或做转轴，配 `children` |
| `stairs` | `steps, run, rise, width, treadColor, highlight: [{step, color}], railing: {side: 1|-1, height, color}`；沿本地 +X 上升，`position` 是第一级起点（宽度中心） |

- `material`：`{roughness, metalness, emissive, emissiveIntensity, opacity, additive, basic, side: "front|back|double"}`。`basic: true` 表示不受光（纯黑门洞、窗玻璃、灯泡）。
- `repeat`：`{count, step: [dx,dy,dz], alternate: [dx,dy,dz]}`，用来摆一排柱子、栏杆、滚筒、台阶灯；`alternate` 让奇偶项交替左右偏移（脚印）。
- `rig`：`{id, axis: "x|y|z", mode: "rotate|translate", scale, offset}`，把节点的转角（度）或位移（米）绑定到 `rigs[id]` 的时间曲线。同一个 rig 可以绑多个节点，用 `scale` 区分幅度（例如断腿上下两节）。
- `id`：起了 id 的节点可以被引用为 `set.<id>`（特效目标、道具挂点）。
- `helper: true`：只在编辑模式显示（辅助标线等）。

## kinds：人物体型（角色外观由这里决定）

```json
"kinds": {"hero": {"scale": 0.95, "width": 0.92, "body": "#2b7c86", "pants": "#1e2a33", "skin": "#cfa98f", "hair": "#16110f",
                   "boots": "#121315", "vest": "#2a3038", "armL": "normal|mech|stump", "armR": "normal", "eye": "L|R",
                   "eyeColor": "#ff2020", "metal": "#9aa4ae", "forearmR": "#6f6a5a", "pistons": false, "ponytail": false,
                   "build": "neutral|male|female",
                   "style": "dummy|mannequin", "accent": "#2f74d0", "life": 1}}
```

人物默认是**白膜人偶**（`style: "dummy"`，参照专业白膜预演）：球形头悬空，一条弧形长方形眼带（`accent` 色）标出视线；方块躯干是蒙皮的，会随脊柱、扭转和侧倾平滑弯曲，胸前一块 `accent` 色名牌标出胸口朝向；上臂、前臂、大腿、小腿各一节胶囊，不做手脚，关节处留小缝；整个角色用 `body` 一种纯色、哑光。建议每个角色选一种饱和、区分度高的颜色，方便在生成提示词里写“红色人偶 = 某角色”。`style: "mannequin"` 可换回圆润人偶（胶囊四肢、旋转体躯干、球形关节、带鼻子）。`life` 控制全身持续微动的强度（0 关闭，默认 1）。`build` 调体型轮廓：`male` 肩宽胸厚，`female` 肩窄腰细胯宽，默认 `neutral`；`scale` 调身高，`width` 调胖瘦。体型只影响外形，不改变关节位置，所以换体型不会影响走位、IK 接触和道具挂点。

`mech` 是机械臂（带三指、肩部红灯点 `mechLight_L/R`），`stump` 是断臂残肢（这一侧不能 IK、不能持物），`eye` 会生成一颗发光义眼（点 `eye`）。

## actors：角色关键帧（全片秒）

```json
{"id": "A", "label": "角色名 · 道具", "kind": "hero", "color": "#2bc3d0", "keyframes": [
  {"time": 0, "position": [0, 0, 0], "yaw": -1.5708, "pose": "guard", "gait": 0, "pitch": 0, "roll": 0,
   "crouch": 0, "aim": 0, "look": 0, "armL": 1,
   "reachL": {"target": "B.hand_R", "w": 1}, "reachR": {"target": "world", "pos": [1, 1.5, 0], "w": 1}}]}
```

- `yaw=0` 面向 -Z；`-π/2` 面向 +X（画右）；`π/2` 面向 -X（画左）。yaw 按数值线性插值，不会自动取最短转向，需要绕圈时直接写超过 ±π 的值。
- `pose` 取自内置姿态库（见下）或 `poses` 里自定义的姿态；相邻关键帧之间自动过渡。
- `life` 0–3：这一时刻全身微动和呼吸的强度（默认 1；昏迷、死亡、定格写 0，渐弱写递减的值）。
- `gait` 0–1：走跑摆腿；`crouch` 0–1：半蹲低姿（自动下沉重心）；`aim`：持枪俯仰；`look`：抬头（+）/低头（−）。
- `pitch / roll`：整个身体翻转、侧倾（空翻、躺地写 `pitch: π/2`，同时把 position.y 调到约 -0.84，让身体贴地）。
- `armL / armR`：0 隐藏该侧手臂（机械臂脱扣）。数值按阶跃切换，需要在切点前后各放一帧。
- `reachL / reachR`：两骨 IK，让手到达目标，`w` 是 0–1 的混合权重（淡入淡出接触）。目标写 `对象.部位`，或 `world` 加 `pos`（世界坐标，相邻帧之间会插值）。

**人物部位**：`hand_L/R`、`fingers_L/R`、`shoulder_L/R`、`shoulderInner_L/R`、`chest_front`、`chest_back`、`head`、`aim`（胸前持枪点，随 `aim` 俯仰）、`hip`、`foot_L/R`；机械臂另有 `mechLight_L/R`；有 `eye` 的体型才有 `eye`。

**内置姿态**：`stand, guard, aim_ready, run, carry, slash_wind, slash_strike, grab_wrist, throw_turn, thrown_air, lying, crouch_spring, tuck, fire_up, hang_swing, jump_air, land_crouch, brace, smash_wind, smash_hit, stab_pre, stab_lunge, dodge_back, bear_hug, shout, hugged, glance_L, slap, recover, grab_low, run_weapon, flung, slump`。

自定义姿态：`"poses": {"kneel": {"base": "brace", "hipL": 1.5, "kneeL": -2.2, "drop": 0.45}}`。字段有 `drop, spine, neck, neckYaw, shL:[前抬,外展], elL, shR, elR, hipL, kneeL, hipR, kneeR`，单位弧度，drop 单位米。

### 运动会自动变自然（不用多写关键帧）

- **平滑曲线**：角色、相机、结构动画的关键帧之间默认走保形三次曲线，经过关键帧时速度连续、不过冲，停顿前后自动缓入缓出。相邻两帧间隔小于 1 帧（如 10.499 → 10.5）视为硬切瞬移，不做平滑。
- **单段覆盖**：任意关键帧可写 `"ease": "linear"`（这一段匀速，适合机械运动、匀速推轨）或 `"ease": "hold"`（这一段定格到下一帧）。
- **动作先后**：姿态切换时躯干先到位，手臂晚 0.05 秒，头晚 0.08 秒，形成跟随感；硬切处不受影响。
- **自动步态**：`gait` 只表示“这段在走 / 跑”的强度。迈步节奏按实际走过的水平距离计算，快走步子大、慢走步子小、停下就停步；自带身体起伏、胯部摆动、上身与手臂反向摆动。
- **呼吸微动**：站着不动时有轻微呼吸、重心晃动和转头；移动、换姿态、翻滚时自动减弱。
- IK 接触在这些之后计算，所以握枪、扣腕、箍抱、拍肩的贴合不受影响。

### 动作捕捉片段

角色可以写 `clips` 播放动作捕捉（需要顶层 `motions` 列出动作：FBX 文件 `{"id", "file"}`，或视频动捕数据 `{"id", "data"}`，见 motion-capture.md 的「视频动捕」）。字段、动作来源和导出设置见 [动作捕捉片段](motion-capture.md)。

## props：道具（谁拿着、什么时候换手）

```json
{"id": "GUN", "label": "A 的冲锋枪", "kind": "smgTorch", "owner": "A", "options": {}, "keyframes": [
  {"time": 0, "holder": "A.aim", "params": {"trigger": 0}},
  {"time": 12, "holder": "world", "position": [1, 0.05, 2], "rotation": [0, 30, 90]},
  {"time": 20, "holder": "hidden"}]}
```

- `holder`：`对象.部位`（挂到手、持枪点、别的道具上）、`world`（放在地上，相邻两个 world 帧之间位置会插值）或 `hidden`。持有者按阶跃切换。
- `params` 是道具自己的连续参数，相邻帧之间插值。
- `options.grip`：`{"p": [x,y,z], "r": [度]}`，覆盖道具在挂点上的位置和角度。

| kind | options | 道具自身的部位 |
| --- | --- | --- |
| `smgTorch` 冲锋枪 + 下挂手电（真实聚光灯和光束） | `color, light: {color, intensity, distance, angle(度), penumbra, enabled}, beam, beamOpacity`；`params.trigger` 0→1 食指入扳机 | `grip, fore, muzzle` |
| `curvedBlade` 弯刀 | `color, gripColor, curve, length` | `tip` |
| `gearMace` 齿轮武器 | `color` | `head` |
| `detachedArm` 脱开的机械臂 | `color, scale` | — |
| `box` 箱体（托盘、器材箱、外套、摄影机） | `size, color, accent, metalness` | `center` |
| `phone` 手机（屏幕发光，屏幕朝 -Z） | `color, screen`；`params.screen` 0–1 屏幕亮度 | `screen` |
| `rod` 棒状（纸杯、手电、警棍、火把） | `length, radius, color, tip` | `tip` |

**双手持枪**：枪挂在 `A.aim`，角色每个关键帧写 `"reachR": {"target": "GUN.grip", "w": 1}, "reachL": {"target": "GUN.fore", "w": 1}`。

## rigs：结构动画

`{"id": "door1", "label": "正门开角", "keyframes": [{"time": 0, "value": 0}, {"time": 2, "value": 70}, {"time": 15, "value": 70}]}`

rig 必须从 0 秒覆盖到片尾，数值由 set 节点的 `rig` 绑定解释为度（转动）或米（位移）。门、闸门、铁架倒塌、断裂、升降台都用它做。

## fx：特效

| type | 字段 |
| --- | --- |
| `cables` 钢索 | `source`（如 `A.fingers_L`）、`anchors: [[x,y,z]...]`、`fire`（射出）、`anchored`（钉住）、`release`（开始回收）、`released`（收完）、`color` |
| `glow` 发光 / 闪烁 | `target`、`windows: [[开始, 结束]...]`、`rate`（每秒闪烁次数，可选）、`intensity`、`offIntensity`、`color`、`radius`。目标本身是发光体（`eye`、`mechLight_L`）时直接控制它，否则在目标上加一个发光小球。加 `lightIntensity`（可选 `offLightIntensity`、`lightDistance`、`lightDecay`）会在目标上同时开关一盏真实点光源，用来做开灯、布景灯全亮 |
| `sparks` 电火花 | `target, start, end, color, count, size, lightIntensity, seed` |
| `dust` 空气灰尘 | `min, max, count, color, size, opacity, seed` |

## cues 与 shots

- `cues`：`[{"time": 6.6, "label": "声：头顶木地板吱呀"}]`，在编辑画面底部显示 1.2 秒，干净模式和导出时不显示。
- `shots`：`{"id", "label", "start", "end", "action", "camera": {"fov", "keyframes": [{"time"(镜头内), "position", "target"}]}}`。镜头需从 0 开始连续覆盖全片，硬切不跨镜补间。
- 焦段换算成 16:9 的竖直 FOV：28mm≈46°，32mm≈41°，35mm≈38°，40mm≈33°，50mm≈27°，65mm≈21°，75mm≈18°，85mm≈16°。

## 扩展（极少需要）

内置能力确实不够时（车辆、布料、群众等），在工程里写 `extra.js`，并在 scene.json 里写 `"extensions": ["extra.js"]`：

```js
export function setup(api) {
  api.registerSetType('car', (node, group, api) => { /* 用 api.THREE 往 group 里加网格 */ });
  api.registerPropKind('torch', (group, options, reg, api) => { reg('tip', [0, 0.3, 0]); return {update(params) {}}; }, {p: [0, 0, 0], r: [0, 0, 0]});
  api.registerFx('rain', (cfg, api) => ({update(t) {}}));
  api.onDraw((t, api) => {});
}
```

通用能力在两个以上项目里用到时，应合并进模板本身（并更新本文档），不要每个工程各写一份。

## 界面操作

时间线上单击镜头块跳到该镜开头，按住拖动可以拖动播放头。快捷键：空格播放 / 暂停，← → 逐帧，Shift+← → 前后 1 秒，[ ] 上一镜 / 下一镜，Home 回到开头，Esc 退出干净画面。FOV 旁会显示等效焦段。

## 浏览器检查接口

`window.__ZPBOOM_PREVIS__` 提供：
- `seek(秒)`；`renderAt(秒)`：渲染并返回状态；
- `getState()`：角色位置、`hand_L/R`、`head`，道具持有者和世界坐标，rig 数值，特效是否激活；
- `point('A.hand_R')`：任一部位的世界坐标；
- `getConfig()`、`validateConfig(cfg)`、`loadConfig(cfg)`（异步）；
- `view`：镜头与自由观察接口，`state()` 返回视图模式（shot / free / top）、是否显示路径和小窗；`setFree(bool)`、`setTop(bool)`、`focusSelection()`、`nudge(op)`、`splitShot()`、`deleteShot()`。`getState().camera` 永远是分镜相机，`getState().view` 是当前视口。
- `editor`：当场编辑接口，`state()` 返回选中对象 / 选中关键帧 / 是否有未记关键帧的改动 / 是否未保存 / 撤销步数 / 自动关键帧开关；`select('actor'|'prop', id)`、`selectKey(kind, id, index)`、`commitTransform(force)`、`insertKey()`、`deleteKey()`、`copyKey()`、`pasteKey()`、`undo()`、`redo()`、`save()`。
- `exportMp4({download: false})`、`exportBlender({download: false})`（见 [导出 Blender 工程](blender-export.md)）、`setClean(bool)`、`setHelpers(bool)`。

验证接触时先读数值（手与目标距离、道具持有者），再只对关键切点截图确认构图，能省下大量截图。

## 当场编辑（网页里直接改）

- 点画面里的人物、道具或场景物件选中，拖手柄移动（W）/ 旋转（E）/ 缩放（R，只对场景物件）；Esc 取消选择。人物旋转只绕竖直轴（朝向 yaw）。
- **自动关键帧**（N 切换，开关状态记在浏览器里）：开 = 拖动后在播放头处自动记关键帧；关 = 拖动后「记关键帧」按钮会闪，按 K 才记，拖时间轴则放弃。没选中对象时按 K 记当前画面为当前镜头的相机关键帧（自由观察里找好角度也能这样记）。
- 记到哪里：人物 → 角色关键帧（保留当时的姿态、接触等字段，只改位置和朝向）；放在场景里的道具 → 道具关键帧（holder: world）；握在手里的道具 → `options.grip` 握持偏移（静态）；场景物件 → `set` 节点的 position / rotation / scale（静态，重复排列的会一起移动，带结构动画的以新位置为基准）。
- 时间线每个人物、道具、结构动画各一条轨道，相机一条（各镜头的关键帧按全片时间显示）。点关键帧选中并跳到该时间；左右拖动改时间（吸附到整帧，不能越过相邻关键帧）；Delete 删除；Ctrl+C / Ctrl+V 复制到播放头；检查器里改缓动。第一个关键帧固定在 0 秒，需要覆盖全程的轨道（人物、结构、相机）最后一个固定在结尾。
- 撤销 / 重做：Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y），最多 100 步。
- 保存：Ctrl+S 或「保存」。Chrome / Edge 第一次会让你选中工程里的 scene.json，之后直接覆盖；其他浏览器改为下载 scene.json。每次改动都会自动存草稿（浏览器本地），没保存就刷新或关闭，下次打开会提示恢复。

## 镜头与自由观察（网页里直接调）

- **自由观察**：左键拖动环绕，右键或 Shift+左键平移，滚轮推拉，按住右键再按 W/A/S/D 前后左右飞、Q/E 下降上升（Shift 加速），F 聚焦选中对象。拖时间轴、播放时保持在自由观察，不会跳回分镜相机。
- **俯视（T）**：正上方的平面图，拖空白处平移、滚轮缩放；不加雾，并剖掉 2.2 米以上（屋顶、天花板）。可以直接拖人物、道具和相机路径上的点。
- **小窗**：自由观察 / 俯视时右下角显示分镜相机的实际画面。
- **路径**：自由观察 / 俯视时显示当前镜头的相机路径（橙）、看向路径（蓝）和取景框；路径上的圆点是相机关键帧，点中后拖动或输入坐标即改这个关键帧（不受自动关键帧开关影响）。
- **设为镜头机位（K）**：把自由观察里找好的画面记成当前镜头在播放头处的相机关键帧。
- **运镜微调**：推 / 拉 / 升 / 降 / 左移 / 右移 / 左摇 / 右摇 / 上仰 / 下俯，步长细 / 中 / 粗。开着自动关键帧且在分镜相机下时直接写入；否则先切到自由观察预览，满意后「设为镜头机位」。
- **FOV 滑杆**：拖动立即生效、可撤销，旁边显示等效焦距。
- **镜头**：检查器顶部的镜头名称可直接改；「在播放头切分」把当前镜头切成两个，运动基本不变（切点附近误差在毫米级）；「删除此镜」把时间并入相邻镜头，被延长的镜头原有运动不变、延长部分停住；时间线上镜头之间的竖条可拖动改切点，两边镜头原有运动不变。

## 天气 weather（可选）

```json
"weather": {
  "keyframes": [
    {"time": 0, "rain": 0, "overcast": 0.2},
    {"time": 5, "rain": 1, "snow": 0, "fog": 0.3, "wind": 0.5, "windDir": 30, "overcast": 0.85, "wet": 1, "tod": 18}
  ],
  "lightning": [{"time": 5.6}, {"time": 9.2, "intensity": 0.6}]
}
```

- `keyframes`：第一个必须在 0 秒，之后递增；没写的字段用默认值（windDir 默认 30°，tod 默认不启用）。前后关键帧之间平滑过渡，`ease` 同其他关键帧。
  - `rain` / `snow` 0–1：雨丝 + 地面溅水 / 雪花的密度。按时间算，同一时间同一画面；屋顶、桌面等遮挡物下面不下（从高处往下检测）。
  - `fog` 0–1：在原有雾的基础上加浓（没有雾的场景也会加上）。
  - `wind` 0–1、`windDir` 0–360（度，0 = +X 方向，90 = +Z 方向）：雨的斜度和雪的飘移。
  - `overcast` 0–1：阴天，压暗平行光、背景变灰。
  - `wet` 0–1：地面变暗、变光滑（反光）。
  - `tod` 0–24（小时）：时间段，改变平行光的强度和颜色、环境光和背景（黎明 / 黄昏偏暖，夜晚偏蓝暗）。任何一个关键帧写了 tod 才启用；只影响 `lights` 里的平行光 / 半球光 / 环境光，道具上的手电、场景里的点光不受影响。
- `lightning`：闪电时刻，画面闪白两下 + 一盏闪光灯，`intensity` 0–3（默认 1）。可以对准声音提示里的雷声。
- 网页里：检查器「天气」卡片的预设（晴 / 阴 / 小雨 / 大雨 / 雷雨 / 雪 / 大雾）和滑杆都记在播放头处；「在播放头加闪电」；时间线有「天气」轨道（关键帧可拖、删，闪电是黄色竖线）。
- 导出：MP4 里有雨雪、雾、闪电；导出 Blender 时，阴天 / 时间段对灯光的影响和闪电（逐帧强度的灯）都会带过去，雨雪由 blender_setup.py 建成近似的粒子（数量、起止帧、风向一致）。

## 姿态编辑：关节微调 adjust 与手部接触

- 角色关键帧可选 `adjust`：相对姿态库的偏移，前后关键帧之间平滑过渡，**在动作捕捉片段上同样生效**（用来修正动捕）。字段同姿态库：`spine`（前倾）、`neck`（低头为正）、`neckYaw`（转头）、`shL` / `shR`（[前后, 外展]）、`elL` / `elR`（肘）、`hipL` / `hipR`（腿前后）、`kneeL` / `kneeR`（膝）单位弧度，范围 ±3.2；`drop` 整体下沉（米）。例：`{"time": 2, "position": [...], "yaw": 0, "pose": "stand", "adjust": {"spine": 0.3, "shR": [1.05, 0]}}`。
- 网页里：选中角色后，检查器「姿态」卡片可以在播放头处换姿态库姿态、拖 14 个关节滑杆（显示为度）、清除这一帧的微调。
- 手部接触：左手 / 右手各选一个目标（别人的身体部位、道具挂点、`set.` 场景物件），或「固定位置（拖小球）」后在画面里拖黄色小球；力度 0 = 放开。都写进播放头处的 `reachL / reachR`。目标够不着时手会伸到最远处。

## 画幅：工程画幅、此镜画幅、导出画幅

- **工程画幅** `aspectRatio`：顶栏下拉随时切换（可撤销、随 Ctrl+S 保存）。各镜的 `camera.fov` 是竖直视角，切换后高度方向的取景不变，画面变宽或变窄。
- **此镜画幅** `shots[].camera.aspect`（可选，16:9 / 21:9 / 9:16 / 1:1 / 4:3 / 3:4）：这一镜在工程画面里加黑边——比工程宽就上下黑边（保持画面宽度），比工程窄就左右黑边（保持高度）。预览和导出 MP4 都带黑边；导出 Blender 时记在附带数据里，Blender 里各镜仍用同一分辨率。
- **取景参考线**（镜头页）：在画面上叠一个其他画幅的取景框，只是参考，不改工程。
- **导出画幅**：点「导出 MP4」或「导出 Blender」先弹出设置——画幅（跟随工程或任选）、画幅不同时的适配方式、清晰度（720p / 1080p / 4K，按短边算，21:9 1080p 为 2520×1080）。
  - **裁切**：和参考线一致。导出比工程宽 → 画面宽度不变、上下裁掉；比工程窄 → 高度不变、左右裁掉。
  - **扩展**：导出比工程宽 → 高度不变、左右多看到场景；比工程窄 → 宽度不变、上下多看到。
  - 接口：`exportMp4({aspect: '21:9', fit: 'crop' | 'extend', short: 1080, download: false})`，`exportBlender` 同样参数。

## 参考画面：world.lift 与导出画面模式

- `world.lift`（可选，0–1）：参考提亮。网页预览按它提高曝光并补中性光，灯光方向和冷暖不变；「镜头」页滑杆或「自动」设置。故事光照、天气、导出 Blender 不受影响。
- 导出 MP4 的 `mode`：`lit` 原样光照、`lift` 提亮参考（没设 world.lift 时自动算一个）、`flat` 白膜平光、`depth` 深度图。接口 `exportMp4({mode: 'lift'})`；`measureShots()` 返回每镜亮度，`autoLift()` 返回推荐的提亮值。
