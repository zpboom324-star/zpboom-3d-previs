#!/usr/bin/env python3
"""Prepare shot-aligned prompts and a clip plan; never upload or generate media."""
import argparse
import json
import math
from pathlib import Path
from validate_scene import load_json, validate_scene


def validate_assets(assets, scene):
    errors = []
    if not isinstance(assets, dict):
        return ['asset-map 必须是 JSON 对象']
    for field in ('characters', 'props', 'environments'):
        if not isinstance(assets.get(field), list) or not all(isinstance(x, dict) for x in assets[field]):
            errors.append(field + ' 必须是对象数组')
    if errors:
        return errors
    actor_ids = {x['id'] for x in scene['actors']}
    chars = assets['characters']
    cids = [x.get('id') for x in chars]
    pids = [x.get('id') for x in assets['props']]
    eids = [x.get('id') for x in assets['environments']]
    for label, ids in [('characters', cids), ('props', pids), ('environments', eids)]:
        if any(not isinstance(x, str) or not x.strip() for x in ids) or len(set(str(x) for x in ids)) != len(ids):
            errors.append(label + ' 存在空 ID 或重复 ID')
    if set(str(x) for x in cids) != actor_ids:
        errors.append('characters 的 ID 须与 scene.actors 一致')
    prop_by_id = {str(x.get('id')): x for x in assets['props']}
    char_by_id = {str(x.get('id')): x for x in chars}
    for actor in chars:
        pid = actor.get('prop_id')
        if pid and (str(pid) not in prop_by_id or prop_by_id[str(pid)].get('owner_id') != actor.get('id')):
            errors.append(f"角色 {actor.get('id')} 的 prop_id 与道具拥有者不匹配")
    for prop in assets['props']:
        owner = str(prop.get('owner_id'))
        if owner not in char_by_id or char_by_id[owner].get('prop_id') != prop.get('id'):
            errors.append(f"道具 {prop.get('id')} 的 owner_id 与角色绑定不匹配")
    refs = [assets.get('reference_video', {})]
    refs += [x.get('appearance_reference', {}) for x in chars]
    refs += [x.get('reference', {}) for x in assets['props'] + assets['environments']]
    for ref in refs:
        if not isinstance(ref, dict) or not isinstance(ref.get('path', ''), str) or not isinstance(ref.get('upload_label', ''), str):
            errors.append('reference 须为包含字符串 path/upload_label 的对象')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene', required=True, type=Path)
    parser.add_argument('--assets', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--segment-seconds', type=float, default=None, help='按完整镜头分组的软性时长目标')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('输出目录已存在，请指定新的版本目录')
    if args.segment_seconds is not None and (not math.isfinite(args.segment_seconds) or args.segment_seconds <= 0):
        parser.error('segment-seconds 必须是有限正数')
    try:
        scene, assets = load_json(args.scene), load_json(args.assets)
        errors, warnings = validate_scene(scene)
        if not errors:
            errors += validate_assets(assets, scene)
    except (OSError, ValueError, TypeError) as exc:
        parser.error(str(exc))
    if errors:
        parser.error('; '.join(errors))
    groups, current = [], []
    for shot in scene['shots']:
        if current and args.segment_seconds:
            current_length = current[-1]['end'] - current[0]['start']
            with_next = shot['end'] - current[0]['start']
            if (with_next > args.segment_seconds + 1e-6
                    and abs(with_next - args.segment_seconds) >= abs(current_length - args.segment_seconds) - 1e-6):
                groups.append(current)
                current = []
        current.append(shot)
        if args.segment_seconds and shot['end'] - shot['start'] > args.segment_seconds + 1e-6:
            warnings.append(f"{shot['id']} 单镜长于规划目标；保留完整镜头，需人工判断是否改分镜")
    if current:
        groups.append(current)
    for index, group in enumerate(groups, 1):
        length = group[-1]['end'] - group[0]['start']
        if args.segment_seconds and length > args.segment_seconds + 1e-6:
            warnings.append(f'第{index}段为{length:g}秒，超过软目标{args.segment_seconds:g}秒以保留完整镜头；提交前核对实际平台时长限制')
    pending, bindings = [], []

    def label(ref, name):
        value = ref.get('upload_label', '').strip()
        if value:
            return value
        pending.append(name)
        return '{{' + name + '｜待绑定实际上传标签}}'

    video_label = label(assets.get('reference_video', {}), '本段预演视频')
    for char in assets['characters']:
        bindings.append(f"角色 {char['id']}（{char.get('name', char['id'])}）外观：" + label(char.get('appearance_reference', {}), char['id']+'人物图'))
    for prop in assets['props']:
        bindings.append(f"道具 {prop['id']}（仅归角色 {prop['owner_id']}）：{prop.get('description', '')}；参考：" + label(prop.get('reference', {}), prop['id']+'道具图'))
    for env in assets['environments']:
        bindings.append(f"场景 {env['id']}（{env.get('name', '')}）：" + label(env.get('reference', {}), env['id']+'场景图'))
    args.output.mkdir(parents=True)
    clip_plan = []
    for index, group in enumerate(groups, 1):
        start, end = group[0]['start'], group[-1]['end']
        file_name = f'{index:02d}-生成提示词.txt'
        lines = [f"【目标】{scene.get('title', '短片')}｜第{index}段｜{end-start:.3f}秒｜{scene.get('aspectRatio', '16:9')}",
                 '风格：待按用户实际要求补充。', '',
                 '【参考视频】' + video_label,
                 f'本段取原预演 {start:.3f}–{end:.3f} 秒；上传前须按此范围裁切，以下时码从本段0秒开始。', '',
                 '【素材绑定】'] + bindings + ['',
                 '【参考边界】参考视频约束镜头顺序、切点、机位和路径、主体相对位置与事件先后；不迁移代理角色的逐帧骨骼、僵硬步频、滑步、关节抽动或简化材质。按最终人物比例和环境重新形成自然表演。',
                 *(['【人物代理】参考视频里的人物是没有四肢和五官的胶囊代理（球头 + 可弯曲胶囊身体），只表示每个角色的位置、朝向、身体倾斜、重心起伏和倒地 / 坐下等大幅度姿态；手臂、腿脚、手部动作和表情全部按提示词与角色设定重新生成，不要把人物画成胶囊或圆柱。参考视频里不显示道具，道具的样子、谁拿着、什么时候换手按提示词和道具参考图生成。'] if (scene.get('world') or {}).get('figure') == 'pill' else []),
                 '人物、服装、专属道具与场景设计按各自图片绑定，不交换角色或道具；不继承图片棚拍背景、展示姿势和原图光线。', '',
                 '【跨段状态】待补充本段起止位置、朝向、持物、门状态和与相邻段的承接；本脚本不自动推断这些剧情状态。', '']
        for shot in group:
            camera = shot['camera']
            first, last = camera['keyframes'][0], camera['keyframes'][-1]
            lines += [f"【{shot['id']}｜{shot['start']-start:.3f}–{shot['end']-start:.3f}秒｜{shot.get('label', '')}】",
                      shot.get('action') or '待补充可观察的事件与动作。',
                      f"相机起点 {first['position']}，终点 {last['position']}；目标由 {first['target']} 到 {last['target']}；垂直FOV {camera['fov']}°。", 
                      '以上坐标用于解释摄影意图；实际画面以本段预演为参考。保留必要遮挡、视差和空间连接。', '']
        lines += ['【声音】按用户需要补充环境声、同期声；未指定时不新增人物台词。', '',
                  '【提交前检查】替换全部待绑定标签，核对本段参考视频范围、身份与道具、动作接触、切点和背景连续性。',
                  '状态：提示词骨架已整理；实际录制、裁切、上传和生成尚需执行。', '']
        (args.output / file_name).write_text('\n'.join(lines), encoding='utf-8')
        clip_plan.append({'part': index, 'source_start': start, 'source_end': end,
                          'duration': end-start, 'shot_ids': [x['id'] for x in group], 'prompt': file_name,
                          'media_status': '待按时间范围实际录制或裁切'})
    plan = {'project': scene.get('title'), 'fps': scene['fps'], 'aspectRatio': scene.get('aspectRatio', '16:9'),
            'binding_complete': not pending, 'pending_labels': pending, 'parts': clip_plan, 'warnings': warnings,
            'status': '仅整理参考资料；未裁切、未上传、未调用视频生成服务'}
    (args.output / 'clip-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    shutil_note = '\n'.join(['# 上传与复查', '', '先实际录制预演，再按 clip-plan.json 裁切。每段提示词中的视频标签应对应本段实际上传文件。', '',
                             '待绑定：'] + ['- '+x for x in pending] + ['',
                             '上传素材只提供设计与摄影参考，仍需检查最终生成的自然动作和角色/道具连续性。',
                             '本包没有上传任何文件或调用任何付费服务。'])
    (args.output / '上传与检查.md').write_text(shutil_note + '\n', encoding='utf-8')
    print(json.dumps({'output': str(args.output.resolve()), **plan}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
