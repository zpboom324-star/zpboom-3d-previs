#!/usr/bin/env python3
"""Validate a ZPboom previs scene.json (schemaVersion 2): time, cameras, identities and references.

结构检查只能发现时码、引用和格式错误；网页加载时还会做完整校验，画面仍需实际查看。
"""
import argparse
import json
import math
import re
from pathlib import Path

ID = re.compile(r'[A-Za-z0-9_-]{1,40}')
REF = re.compile(r'([A-Za-z0-9_-]{1,40})\.([A-Za-z0-9_]{1,40})')
SET_TYPES = {'group', 'box', 'cylinder', 'cone', 'sphere', 'plane', 'circle', 'stairs'}
PROP_KINDS = {'smgTorch', 'curvedBlade', 'gearMace', 'detachedArm', 'box', 'rod', 'phone'}
FX_TYPES = {'cables', 'glow', 'sparks', 'dust'}
LIGHT_TYPES = {'hemisphere', 'directional', 'point', 'spot', 'ambient'}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


BUILTIN_POSES = {'stand', 'guard', 'aim_ready', 'run', 'carry', 'slash_wind', 'slash_strike', 'grab_wrist', 'throw_turn', 'thrown_air', 'lying', 'crouch_spring', 'tuck', 'fire_up', 'hang_swing', 'jump_air', 'land_crouch', 'brace', 'smash_wind', 'smash_hit', 'stab_pre', 'stab_lunge', 'dodge_back', 'bear_hug', 'shout', 'hugged', 'glance_L', 'slap', 'recover', 'grab_low', 'run_weapon', 'flung', 'slump'}  # 与 app.js 的 BUILTIN_POSES 保持一致


def validate_scene(scene):
    errors, warnings = [], []
    if not isinstance(scene, dict):
        return ['scene 必须是 JSON 对象'], []
    if scene.get('schemaVersion') != 2:
        errors.append('schemaVersion 必须为 2（ZPboom 统一模板）')
    duration = scene.get('duration')
    if not number(duration) or not 0.5 <= duration <= 600:
        return errors + ['duration 必须在 0.5–600 秒之间'], warnings
    if not isinstance(scene.get('title'), str) or not 1 <= len(scene['title'].strip()) <= 120:
        errors.append('title 必须为 1–120 字符')
    fps = scene.get('fps')
    if not isinstance(fps, int) or isinstance(fps, bool) or not 1 <= fps <= 60:
        errors.append('fps 必须是 1–60 整数')
        fps = 30
    if scene.get('aspectRatio', '16:9') not in ('16:9', '21:9', '9:16', '1:1', '4:3', '3:4'):
        errors.append('aspectRatio 支持 16:9、21:9、9:16、1:1、4:3、3:4')
    world = scene.get('world', {})
    if not isinstance(world, dict) or world.get('up') != 'Y' or world.get('unit') != 'meter':
        errors.append('world 必须是 Y-up、meter')
    if isinstance(world, dict) and world.get('figure', 'jointed') not in ('jointed', 'pill'):
        errors.append('world.figure 只支持 jointed（精细白膜）/ pill（简化胶囊）')
    extensions = scene.get('extensions', [])
    if not isinstance(extensions, list) or any(not isinstance(p, str) or not p.endswith('.js') or '..' in p for p in extensions):
        errors.append('extensions 必须是工程内 .js 相对路径列表')

    def vector(value, label, length=3):
        ok = isinstance(value, list) and len(value) == length and all(number(x) and -1000 <= x <= 1000 for x in value)
        if not ok:
            errors.append(f'{label} 必须包含 {length} 个有限数字')
        return ok

    def keyframes(frames, end, label, check, cover=True):
        if not isinstance(frames, list) or not (2 if cover else 1) <= len(frames) <= 4000:
            errors.append(f'{label} 需要 {2 if cover else 1}–4000 个关键帧')
            return
        last, times = -1, []
        for index, frame in enumerate(frames):
            where = f'{label}[{index}]'
            if not isinstance(frame, dict):
                errors.append(where + ' 必须是对象')
                continue
            time = frame.get('time')
            if not number(time) or time < 0 or time > end + 1e-6 or time <= last:
                errors.append(where + ' 时间须递增且在本时间域内')
            else:
                last = time
                times.append(time)
            check(frame, where)
        if times and (abs(times[0]) > 1e-6 or (cover and abs(times[-1] - end) > 1e-6)):
            errors.append(label + (' 须从 0 覆盖到该时间域终点' if cover else ' 第一个关键帧须在 0 秒'))

    rigs = scene.get('rigs', [])
    rig_ids = set()
    for rig in rigs if isinstance(rigs, list) else []:
        rid = rig.get('id')
        if not isinstance(rid, str) or not ID.fullmatch(rid) or rid in rig_ids:
            errors.append(f'rigs id {rid} 为空或重复')
        rig_ids.add(rid)
        keyframes(rig.get('keyframes'), duration, f'结构 {rid}', lambda f, w: number(f.get('value')) or errors.append(w + '.value 必须是数字'))

    set_ids, node_count = set(), [0]

    def check_node(node, path):
        node_count[0] += 1
        if not isinstance(node, dict) or node.get('type') not in SET_TYPES:
            warnings.append(f'{path}.type {node.get("type") if isinstance(node, dict) else node} 不是内置类型（若来自 extensions 可忽略）')
            return
        if 'id' in node:
            if not isinstance(node['id'], str) or not ID.fullmatch(node['id']) or node['id'] in set_ids:
                errors.append(f'{path}.id 无效或重复')
            set_ids.add(node.get('id'))
        for key in ('position', 'rotation', 'scale'):
            if key in node:
                vector(node[key], f'{path}.{key}')
        if node['type'] == 'box':
            vector(node.get('size'), f'{path}.size')
        if node['type'] == 'plane':
            vector(node.get('size'), f'{path}.size', 2)
        if node.get('rig') and node['rig'].get('id') not in rig_ids:
            errors.append(f'{path}.rig.id {node["rig"].get("id")} 不在 rigs 里')
        for i, child in enumerate(node.get('children', [])):
            check_node(child, f'{path}.children[{i}]')

    for i, node in enumerate(scene.get('set', [])):
        check_node(node, f'set[{i}]')
    if node_count[0] > 5000:
        warnings.append(f'场景节点 {node_count[0]} 个，较多，注意网页性能')
    for i, light in enumerate(scene.get('lights', [])):
        if not isinstance(light, dict) or light.get('type') not in LIGHT_TYPES:
            errors.append(f'lights[{i}].type 无效')

    kinds = scene.get('kinds', {})
    if not isinstance(kinds, dict):
        errors.append('kinds 必须是对象')
        kinds = {}
    for name, kind in kinds.items():
        for side in ('armL', 'armR'):
            if kind.get(side, 'normal') not in ('normal', 'mech', 'stump'):
                errors.append(f'kinds.{name}.{side} 只支持 normal / mech / stump')

    owners = set()
    actors = scene.get('actors')
    if not isinstance(actors, list) or len(actors) > 24:
        errors.append('actors 须为 0–24 个角色的数组')
        actors = []
    refs = []
    for index, actor in enumerate(actors):
        aid = actor.get('id') if isinstance(actor, dict) else None
        if not isinstance(aid, str) or not ID.fullmatch(aid) or aid in owners:
            errors.append(f'actors[{index}].id 为空或重复')
            continue
        owners.add(aid)
        if not isinstance(actor.get('label'), str) or not 1 <= len(actor['label'].strip()) <= 80:
            errors.append(f'角色 {aid} 的 label 必须为 1–80 字符')
        if actor.get('kind') not in kinds:
            errors.append(f'角色 {aid} 的 kind 没有在 kinds 里定义')

        def check_actor(frame, where):
            pose = frame.get('pose', 'stand')
            if pose not in BUILTIN_POSES and pose not in (scene.get('poses') or {}):
                errors.append(f'{where}.pose 用了不存在的姿态「{pose}」（走路不需要 walk 姿态：位置在动就会自动迈步；可用的内置姿态见 scene-format.md）')
            vector(frame.get('position'), where + '.position')
            if not number(frame.get('yaw')) or abs(frame['yaw']) > math.pi * 100:
                errors.append(where + '.yaw 必须是有限弧度数')
            adjust = frame.get('adjust')  # 关节微调（第四期）：相对姿态库的偏移，弧度（drop 为米）
            if adjust is not None:
                pairs = {'shL', 'shR'}
                singles = {'drop', 'spine', 'neck', 'neckYaw', 'elL', 'elR', 'hipL', 'kneeL', 'hipR', 'kneeR'}
                if not isinstance(adjust, dict):
                    errors.append(where + '.adjust 必须是对象')
                else:
                    for k, v in adjust.items():
                        if k in pairs:
                            if not (isinstance(v, list) and len(v) == 2 and all(number(n) and abs(n) <= 3.2 for n in v)):
                                errors.append(f'{where}.adjust.{k} 必须是两个 -3.2–3.2 之间的数')
                        elif k in singles:
                            if not number(v) or abs(v) > 3.2:
                                errors.append(f'{where}.adjust.{k} 必须在 -3.2–3.2 之间')
                        else:
                            errors.append(f'{where}.adjust 不支持 {k}')
            for side in ('reachL', 'reachR'):
                reach = frame.get(side)
                if reach:
                    if reach.get('target') == 'world':
                        vector(reach.get('pos'), f'{where}.{side}.pos')
                    else:
                        refs.append((reach.get('target'), f'{where}.{side}'))
        keyframes(actor.get('keyframes'), duration, f'角色 {aid} 全局关键帧', check_actor)

    motion_ids = set()
    for index, m in enumerate(scene.get('motions', []) or []):
        if not isinstance(m, dict) or not isinstance(m.get('id'), str) or m['id'] in motion_ids:
            errors.append(f'motions[{index}].id 为空或重复')
            continue
        motion_ids.add(m['id'])
        if 'data' in m:  # 视频动捕：动作数据直接存在 scene.json
            d = m['data']
            if not isinstance(d, dict) or d.get('format') != 'zpboom-pose' or not isinstance(d.get('points'), list) or not isinstance(d.get('frames'), list) or not d['frames'] or not number(d.get('fps')) or d['fps'] <= 0:
                errors.append(f'motions[{index}].data 不是有效的视频动捕数据')
            elif any(not isinstance(fr, list) or len(fr) != len(d['points']) * 3 or not all(number(n) for n in fr) for fr in d['frames']):
                errors.append(f'motions[{index}].data 的帧数据不完整')
            elif 'lift' in d and (not isinstance(d['lift'], list) or len(d['lift']) != len(d['frames']) or not all(number(n) and 0 <= n <= 5 for n in d['lift'])):
                errors.append(f'motions[{index}].data.lift（离地高度）必须是每帧一个 0–5 米的数')
            continue
        f = m.get('file')
        if not isinstance(f, str) or not f.lower().endswith('.fbx') or f.startswith('/') or '..' in f or '://' in f:
            errors.append(f'motions[{index}].file 必须是工程内的 .fbx 相对路径')
    for actor in actors:
        for i, c in enumerate(actor.get('clips', []) or []):
            if c.get('motion') not in motion_ids:
                errors.append(f"角色 {actor.get('id')} 的 clips[{i}].motion 没有在 motions 里定义")
            if not number(c.get('start')) or not 0 <= c['start'] <= duration:
                errors.append(f"角色 {actor.get('id')} 的 clips[{i}].start 超出时长")
            if c.get('override') not in (None, False, 'pose', 'all'):
                errors.append(f"角色 {actor.get('id')} 的 clips[{i}].override 只能是 pose（覆盖姿态）或 all（完全覆盖）")
    for index, prop in enumerate(scene.get('props', [])):
        pid = prop.get('id')
        if not isinstance(pid, str) or not ID.fullmatch(pid) or pid in owners:
            errors.append(f'props[{index}].id 为空或与其他对象重复')
            continue
        owners.add(pid)
        if prop.get('kind') not in PROP_KINDS:
            warnings.append(f'道具 {pid} 的 kind {prop.get("kind")} 不是内置类型（若来自 extensions 可忽略）')
        if prop.get('owner') not in {a.get('id') for a in actors}:
            errors.append(f'道具 {pid} 的 owner 必须是角色 ID')

        def check_prop(frame, where):
            holder = frame.get('holder')
            if holder == 'world':
                vector(frame.get('position'), where + '.position')
            elif holder != 'hidden':
                refs.append((holder, where + '.holder'))
        keyframes(prop.get('keyframes'), duration, f'道具 {pid}', check_prop, cover=False)

    for index, fx in enumerate(scene.get('fx', [])):
        if fx.get('type') not in FX_TYPES:
            warnings.append(f'fx[{index}].type {fx.get("type")} 不是内置类型（若来自 extensions 可忽略）')
        for key in ('source', 'target'):
            if key in fx:
                refs.append((fx[key], f'fx[{index}].{key}'))
        for key in ('start', 'end', 'fire', 'anchored', 'release', 'released'):
            if key in fx and (not number(fx[key]) or not 0 <= fx[key] <= duration):
                errors.append(f'fx[{index}].{key} 超出时长')

    for value, where in refs:
        match = REF.fullmatch(value) if isinstance(value, str) else None
        if not match:
            errors.append(f'{where} 引用格式应为 对象ID.部位')
        elif match.group(1) == 'set':
            if match.group(2) not in set_ids:
                errors.append(f'{where} 引用的场景节点 {match.group(2)} 不存在')
        elif match.group(1) not in owners:
            errors.append(f'{where} 引用的对象 {match.group(1)} 不存在')

    shots = scene.get('shots')
    if not isinstance(shots, list) or not 1 <= len(shots) <= 200:
        return errors + ['shots 须包含 1–200 个镜头'], warnings
    previous, shot_ids = 0, set()
    for index, shot in enumerate(shots):
        sid = shot.get('id') if isinstance(shot, dict) else None
        if not isinstance(sid, str) or not ID.fullmatch(sid) or sid in shot_ids:
            errors.append(f'shots[{index}].id 为空或重复')
            continue
        shot_ids.add(sid)
        if not isinstance(shot.get('label'), str) or not 1 <= len(shot['label'].strip()) <= 80:
            errors.append(f'镜头 {sid} 的 label 必须为 1–80 字符')
        start, end = shot.get('start'), shot.get('end')
        if not number(start) or not number(end) or end <= start:
            errors.append(f'镜头 {sid} start/end 无效')
            continue
        if abs(start - previous) > 1e-6:
            errors.append(f'镜头 {sid} 与前镜之间存在空白或重叠')
        previous = end
        for time in (start, end):
            if abs(time * fps - round(time * fps)) > 0.005:
                warnings.append(f'镜头 {sid} 时码 {time} 未对齐 {fps}fps 帧边界')
        camera = shot.get('camera', {})
        if not number(camera.get('fov')) or not 10 <= camera['fov'] <= 100:
            errors.append(f'镜头 {sid} fov 须为 10–100 度')

        def check_cam(frame, where):
            if vector(frame.get('position'), where + '.position') and vector(frame.get('target'), where + '.target'):
                if sum((a - b) ** 2 for a, b in zip(frame['position'], frame['target'])) < 1e-10:
                    errors.append(where + ' 相机位置不能等于目标点')
        keyframes(camera.get('keyframes'), end - start, f'镜头 {sid} 局部相机关键帧', check_cam)
        if camera.get('aspect') is not None and camera['aspect'] not in ('16:9', '21:9', '9:16', '1:1', '4:3', '3:4'):
            errors.append(f'镜头 {sid} 的 camera.aspect 支持 16:9、21:9、9:16、1:1、4:3、3:4')
        if not isinstance(shot.get('action'), str) or not shot['action'].strip():
            warnings.append(f'镜头 {sid} 缺少 action 说明，生成交接时需补写')
    if abs(previous - duration) > 1e-6:
        errors.append('最后一镜须结束于 duration')
    lift = (scene.get('world') or {}).get('lift')
    if lift is not None and (not number(lift) or not 0 <= lift <= 1):
        errors.append('world.lift（参考提亮）必须在 0–1 之间')
    weather = scene.get('weather')
    if weather is not None:  # 天气（第三期）：keyframes 首帧在 0 秒、时间递增；各字段在范围内；lightning 时间在全片内
        ranges = {'rain': (0, 1), 'snow': (0, 1), 'fog': (0, 1), 'wind': (0, 1), 'windDir': (0, 360), 'overcast': (0, 1), 'wet': (0, 1), 'tod': (0, 24)}
        if not isinstance(weather, dict):
            errors.append('weather 必须是对象')
        else:
            keys = weather.get('keyframes') or []
            last = -1
            for i, k in enumerate(keys):
                t = k.get('time') if isinstance(k, dict) else None
                if not number(t) or not 0 <= t <= duration + 1e-6 or t <= last:
                    errors.append(f'weather.keyframes[{i}].time 必须递增且在 0–duration 内'); break
                last = t
                for f, (lo, hi) in ranges.items():
                    if f in k and (not number(k[f]) or not lo <= k[f] <= hi):
                        errors.append(f'weather.keyframes[{i}].{f} 必须在 {lo}–{hi} 之间')
                if 'ease' in k and k['ease'] not in ('smooth', 'linear', 'hold'):
                    errors.append(f'weather.keyframes[{i}].ease 只支持 smooth / linear / hold')
            if keys and number(keys[0].get('time')) and keys[0]['time'] > 1e-4:
                errors.append('weather 第一个关键帧必须在 0 秒')
            for i, l in enumerate(weather.get('lightning') or []):
                if not isinstance(l, dict) or not number(l.get('time')) or not 0 <= l['time'] <= duration:
                    errors.append(f'weather.lightning[{i}].time 必须在 0–duration 内')
    return errors, warnings


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'), parse_constant=lambda x: (_ for _ in ()).throw(ValueError('JSON 不允许 ' + x)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scene', type=Path)
    args = parser.parse_args()
    try:
        errors, warnings = validate_scene(load_json(args.scene))
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        errors, warnings = [str(exc)], []
    print(json.dumps({'valid': not errors, 'errors': errors, 'warnings': warnings,
                      'scope': '配置结构检查；网页加载时还会完整校验，画面仍需实际查看'}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
