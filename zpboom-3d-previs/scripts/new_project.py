#!/usr/bin/env python3
"""Create a new, local-only editable previs project from the unified template without overwriting files."""
import argparse
import json
import math
import shutil
from pathlib import Path
from validate_scene import load_json, validate_scene

MOTION_LABELS = {'keyframe': '方式 1 · 关键帧直接做', 'mixed': '方式 2 · 混合（关键帧 + 动捕）'}
MIXED_README = '''把动作捕捉文件（.fbx）放在这个文件夹，然后在 scene.json 里：
1. 顶层 motions 写 {"id": "dying", "file": "motions/Dying.fbx"}；
2. 角色的 clips 写 {"motion": "dying", "start": 2.0, "offset": 0, "speed": 1, "fadeIn": 0.2, "fadeOut": 0.2}。

Mixamo 下载设置：Format = FBX Binary，Skin = Without Skin，Frames per Second = 30，Keyframe Reduction = none；
走路、跑步类勾选 In Place。文件还没放进来时，页面会先用关键帧代替，放进来刷新即可。
详细字段见技能包 references/motion-capture.md。
'''
TIME_KEYS = {'time', 'start', 'end', 'fire', 'anchored', 'release', 'released'}


KICKOFF_LABELS = {
    'lighting': {'readable': '明亮可读，夜景 / 低调光写进生成提示词', 'mood': '按分镜影调做暗（导出时用「提亮参考」）'},
    'camera': {'space': '保持空间真实，机位就近调整，偏离处写进 storyboard.md', 'storyboard': '严格按分镜机位，必要时改场景尺寸'},
    'deliver': {'previs': '只做预演，看过再决定下一步', 'video': '预演 + 导出参考视频', 'handoff': '预演 + 参考视频 + 生成交接'},
}
FIGURE_LABELS = {'jointed': '精细白膜（关节人偶）', 'pill': '简化胶囊（球头 + 胶囊身体，走跑笔直、蹲坐才弯，无四肢，不显示道具）'}


def scale_times(obj, k):
    """把示例里的所有时码（角色/道具/结构/特效/提示/镜头/相机局部时间）按同一比例缩放。"""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in TIME_KEYS and isinstance(value, (int, float)) and not isinstance(value, bool):
                obj[key] = round(value * k, 9)
            elif key == 'windows' and isinstance(value, list):
                obj[key] = [[round(a * k, 9), round(b * k, 9)] for a, b in value]
            else:
                scale_times(value, k)
    elif isinstance(obj, list):
        for item in obj:
            scale_times(item, k)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--title', default='我的3D预演')
    parser.add_argument('--duration', type=float, default=15)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--aspect', default='16:9', choices=['16:9', '21:9', '9:16', '1:1', '4:3', '3:4'], help='画幅；21:9 为电影宽银幕')
    parser.add_argument('--empty', action='store_true', help='只保留界面和引擎，scene.json 写成空场景（之后整份替换）')
    parser.add_argument('--figure', choices=['jointed', 'pill'], default='jointed',
                        help='人物白膜：jointed = 精细关节白膜（四肢、眼带，动作看得清）；pill = 简化胶囊白膜（球头 + 可弯曲胶囊身体、无四肢，给视频模型更大发挥空间）。网页顶栏可随时一键切换')
    parser.add_argument('--lighting', choices=['readable', 'mood'], default='readable', help='预演画面亮度：readable = 明亮可读、影调写进提示词；mood = 按分镜影调做暗')
    parser.add_argument('--camera', choices=['space', 'storyboard'], default='space', help='分镜机位和空间冲突时：space = 保持空间真实、机位就近调整并标注；storyboard = 严格按分镜机位、必要时改场景尺寸')
    parser.add_argument('--deliver', choices=['previs', 'video', 'handoff'], default='previs', help='做到哪一步：previs = 只做预演；video = 加导出参考视频；handoff = 再加生成交接')
    parser.add_argument('--motion', choices=['keyframe', 'mixed'], default='keyframe',
                        help='动作方式：keyframe = 方式 1 关键帧直接做（快速、最省 token）；mixed = 方式 2 关键帧 + 动捕片段（建好 motions/ 文件夹）')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('输出目录已存在，请使用新的项目目录，避免覆盖已有工程')
    if not math.isfinite(args.duration) or args.duration <= 0:
        parser.error('duration 应为有限正数')
    starter = Path(__file__).resolve().parents[1] / 'assets' / 'previs-starter'
    if not (starter / 'index.html').is_file():
        parser.error('缺少随包的 assets/previs-starter，请重新获取完整技能包')
    scene = load_json(starter / 'scene.json')
    scale_times(scene, args.duration / scene['duration'])
    scene.update(title=args.title, duration=args.duration, fps=args.fps, aspectRatio=args.aspect)
    scene.setdefault('world', {})['figure'] = args.figure
    if args.empty:
        scene.update(set=[], kinds={}, actors=[], props=[], rigs=[], fx=[], cues=[])
        scene['shots'] = [{'id': 's01', 'label': '01', 'start': 0, 'end': args.duration, 'action': '待补充分镜事件',
                           'camera': {'fov': 40, 'keyframes': [{'time': 0, 'position': [6, 3, 8], 'target': [0, 1, 0]},
                                                                {'time': args.duration, 'position': [6, 3, 8], 'target': [0, 1, 0]}]}}]
    errors, warnings = validate_scene(scene)
    if errors:
        parser.error('; '.join(errors))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(starter, args.output)
    (args.output / 'scene.json').write_text(json.dumps(scene, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    motion_label = MOTION_LABELS[args.motion]
    figure_label = FIGURE_LABELS[args.figure]
    kickoff = [f'- 人物白膜：{figure_label}', f'- 画面亮度：{KICKOFF_LABELS["lighting"][args.lighting]}', f'- 机位与空间冲突：{KICKOFF_LABELS["camera"][args.camera]}',
               f'- 交付范围：{KICKOFF_LABELS["deliver"][args.deliver]}', f'- 动作方式：{motion_label}']
    if args.motion == 'mixed':
        (args.output / 'motions').mkdir(exist_ok=True)
        (args.output / 'motions' / '放动作文件说明.txt').write_text(MIXED_README, encoding='utf-8')
    characters, props = [], []
    for actor in scene['actors']:
        owned = [p for p in scene.get('props', []) if p.get('owner') == actor['id']]
        characters.append({'id': actor['id'], 'name': actor.get('label', actor['id']),
                           'appearance_reference': {'path': '', 'upload_label': ''}, 'prop_id': owned[0]['id'] if owned else ''})
        if owned:
            p = owned[0]
            props.append({'id': p['id'], 'owner_id': actor['id'], 'description': p.get('label', p['id']),
                          'reference': {'path': '', 'upload_label': ''}})
    assets = {'version': 1, 'reference_video': {'path': '', 'upload_label': ''},
              'characters': characters, 'props': props,
              'environments': [{'id': 'ENV01', 'name': '示例场景（请替换为实际场景）', 'reference': {'path': '', 'upload_label': ''}}]}
    (args.output / 'asset-map.json').write_text(json.dumps(assets, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines = ['# ' + args.title, '', '当前为模板示例，须按用户分镜改写 scene.json 后再使用。', '',
             f'时长 {args.duration:g} 秒；{args.fps}fps；画幅 {args.aspect}；动作方式：{motion_label}；人物白膜：{figure_label}。', '']
    for shot in scene['shots']:
        lines += [f"## {shot['id']} | {shot['start']:.3f}–{shot['end']:.3f}s", '', shot.get('action', '待补充分镜事件'), '']
    (args.output / 'storyboard.md').write_text('\n'.join(lines), encoding='utf-8')
    (args.output / 'revision-log.md').write_text(f'# 修改记录\n\n动作方式：{motion_label}（之后修改沿用；要换方式时在这里记一笔）\n人物白膜：{figure_label}（网页顶栏可一键切换，只换外形不改动作）\n\n## 开工确认（之后修改一律沿用；用户改口时更新这里）\n\n' + '\n'.join(kickoff) + '\n\nv01：从 ZPboom 统一模板初始化，尚未适配用户分镜。\n\n后续每版记录：镜头/时码、改动参数、检查点与结果。\n', encoding='utf-8')
    print(json.dumps({'project': str(args.output.resolve()), 'status': '已创建可运行工程；按分镜改写 scene.json 即可，无需改 app.js / index.html', 'motion': motion_label, 'figure': figure_label, 'kickoff': kickoff,
                      'warnings': warnings, 'start': '在项目目录运行 python3 -m http.server 8000 --bind 127.0.0.1'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
