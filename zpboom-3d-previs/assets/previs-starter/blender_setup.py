# -*- coding: utf-8 -*-
"""ZPboom.AI 3D 预演 → Blender 工程（.blend）

网页右上角点「导出 Blender」，浏览器会下载 <标题>_blender.glb。然后任选一种方式：

  1) Blender 界面里（最简单）
     打开 Blender → 顶部切到「Scripting / 脚本」工作区 → 文本编辑器里「打开」本文件 → 点 ▶ 运行。
     脚本会在本文件所在文件夹、「下载」、「桌面」里找最新的 *_blender.glb，导进一个新场景，
     并在 GLB 旁边保存同名 .blend（已存在就另存为 _v2、_v3…，不会覆盖你改过的工程）。

  2) 命令行（不打开界面）
     blender -b -P blender_setup.py -- <标题>_blender.glb [输出.blend]
     macOS 上 blender 是 /Applications/Blender.app/Contents/MacOS/Blender

  3) 只检查 GLB 内容（不需要 Blender）
     python3 blender_setup.py --check <标题>_blender.glb

脚本做的事：导入 GLB（人物关节、道具、场景、每镜一台相机、灯光与全部逐帧动画）→ 帧率 / 帧范围 / 分辨率 →
时间线按镜头打标记并绑定相机（播放时自动切镜）→ 声音提示也打成标记 → 灯光强度按网页的物理单位换算、闪烁逐帧还原 →
发光材质闪烁 → 背景色和环境光做成世界光 → 曝光与色彩管理 → 按 人物 / 道具 / 场景 / 相机 / 灯光 / 特效 分集合 → 打包贴图并保存。
需要 Blender 3.6 或更新版本（自带 glTF 导入插件）。
"""
import glob
import json
import math
import os
import struct
import sys

FOUR_PI = 4.0 * math.pi


# ───────── 读 GLB（纯 Python，不依赖 Blender）─────────
def read_glb_json(path):
    with open(path, 'rb') as f:
        magic, _version, _length = struct.unpack('<4sII', f.read(12))
        if magic != b'glTF':
            raise ValueError('不是 GLB 文件：%s' % path)
        chunk_len, chunk_type = struct.unpack('<II', f.read(8))
        if chunk_type != 0x4E4F534A:
            raise ValueError('GLB 缺少 JSON 块')
        return json.loads(f.read(chunk_len).decode('utf-8'))


def load_plan(path):
    gltf = read_glb_json(path)
    plan = (gltf.get('extras') or {}).get('zpboom')
    if not plan:
        raise ValueError('这个 GLB 不是 ZPboom.AI 预演「导出 Blender」生成的（缺少 extras.zpboom）')
    return gltf, plan


def clip_bytes(text, limit=63):
    """Blender 名称最多 63 字节（UTF-8），中文一个字 3 字节。"""
    return text.encode('utf-8')[:limit].decode('utf-8', 'ignore')


def summary_lines(gltf, plan):
    fps, frames = plan['fps'], plan['frames']
    anim = (gltf.get('animations') or [{}])[0]
    lines = [
        '标题：%s' % plan.get('title'),
        '帧率 %s fps · %s 帧（%.2f 秒）· 画幅 %s · 分辨率 %d×%d' % (fps, frames, frames / fps, plan.get('aspectRatio'), plan['resolution'][0], plan['resolution'][1]),
        '节点 %d · 网格 %d · 材质 %d · 骨骼蒙皮 %d · 动画通道 %d' % (len(gltf.get('nodes', [])), len(gltf.get('meshes', [])), len(gltf.get('materials', [])), len(gltf.get('skins', [])), len(anim.get('channels', []))),
        '人物：%s' % '、'.join('%s(%s)' % (a['label'], a['id']) for a in plan.get('actors', [])),
        '道具：%s' % ('、'.join(p['id'] for p in plan.get('props', [])) or '无'),
        '镜头 %d 个：' % len(plan['shots']),
    ]
    for s in plan['shots']:
        lines.append('  %-6s 帧 %4d–%-4d  %5.1f° ≈ %4.1fmm  %s' % (s['id'], s['startFrame'], s['endFrame'], s['fov'], s['lens'], s['label']))
    lines.append('灯光 %d 盏（%d 盏有逐帧强度）· 发光材质动画 %d 个 · 声音提示 %d 个 · 环境光 %d 个' % (
        len(plan['lights']), sum(1 for l in plan['lights'] if l.get('keys')), len(plan['materials']), len(plan['cues']), len(plan['ambient'])))
    if plan.get('weather'):
        f = plan['weather']['fields']
        lines.append('天气：雨最大 %d%% · 雪最大 %d%% · 雾最大 %d%% · 闪电 %d 道' % (max(f['rain']) * 100, max(f['snow']) * 100, max(f['fog']) * 100, len(plan['weather']['lightning'])))
    return lines


# ───────── 找文件 ─────────
def script_args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def candidate_dirs(bpy):
    dirs = []
    here = globals().get('__file__')
    if here and os.path.isfile(here):
        dirs.append(os.path.dirname(os.path.abspath(here)))
    for text in bpy.data.texts:
        if text.filepath and 'blender_setup' in os.path.basename(text.filepath):
            dirs.append(os.path.dirname(bpy.path.abspath(text.filepath)))
    dirs += [os.getcwd(), os.path.expanduser('~/Downloads'), os.path.expanduser('~/Desktop')]
    out = []
    for d in dirs:
        if d and os.path.isdir(d) and d not in out:
            out.append(d)
    return out


def find_latest_glb(bpy):
    found = []
    for d in candidate_dirs(bpy):
        found += glob.glob(os.path.join(d, '*_blender.glb'))
    if not found:
        raise FileNotFoundError('没找到 *_blender.glb：请先在预演网页点「导出 Blender」，把 GLB 放到本脚本旁边或「下载」文件夹；'
                                '或用命令行：blender -b -P blender_setup.py -- 你的文件.glb')
    return max(found, key=os.path.getmtime)


def default_out(glb):
    stem = os.path.splitext(glb)[0]
    if stem.endswith('_blender'):
        stem = stem[:-len('_blender')]
    out, k = stem + '.blend', 2
    while os.path.exists(out):
        out, k = '%s_v%d.blend' % (stem, k), k + 1
    return out


# ───────── Blender 部分 ─────────
def iter_fcurves(id_data):
    """兼容 Blender 3.6–5.x：旧版 action.fcurves，4.4+ 分层动作 layers/strips/channelbags。"""
    ad = getattr(id_data, 'animation_data', None)
    action = ad.action if ad else None
    if not action:
        return
    try:
        for fc in action.fcurves:
            yield fc
        return
    except AttributeError:
        pass
    for layer in getattr(action, 'layers', []):
        for strip in layer.strips:
            for bag in getattr(strip, 'channelbags', []):
                for fc in bag.fcurves:
                    yield fc


def set_linear(id_data):
    for fc in iter_fcurves(id_data):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'


def find_obj(scene, name, kind=None):
    exact = [o for o in scene.objects if o.name == name and (kind is None or o.type == kind)]
    if exact:
        return exact[0]
    loose = [o for o in scene.objects if o.name.split('.')[0] == name and (kind is None or o.type == kind)]
    return loose[0] if loose else None


def find_mat(bpy, name):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    for m in bpy.data.materials:
        if m.name.split('.')[0] == name:
            return m
    return None


def try_set(obj, attr, values):
    for v in values:
        try:
            setattr(obj, attr, v)
            return v
        except (TypeError, AttributeError, ValueError):
            continue
    return None


def import_glb(bpy, path):
    if not hasattr(bpy.ops.import_scene, 'gltf'):
        raise RuntimeError('Blender 的 glTF 导入插件没有启用：编辑 → 偏好设置 → 插件，启用「Import-Export: glTF 2.0 format」')
    for extra in ({'export_import_convert_lighting_mode': 'COMPAT'}, {}):
        try:
            return bpy.ops.import_scene.gltf(filepath=path, **extra)
        except TypeError:
            continue
    raise RuntimeError('glTF 导入失败')


def top_ancestor(obj):
    while obj.parent:
        obj = obj.parent
    return obj


def build_world(bpy, scene, plan):
    world = bpy.data.worlds.new('ZPboom 世界光')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nodes, links = nt.nodes, nt.links
    nodes.clear()
    out = nodes.new('ShaderNodeOutputWorld')
    out.location = (600, 0)
    # 相机直接看到的背景 = 网页 scene.background
    bg_cam = nodes.new('ShaderNodeBackground')
    bg_cam.location = (200, -160)
    bg_cam.inputs['Color'].default_value = tuple(plan['background'][:3]) + (1.0,)
    bg_cam.inputs['Strength'].default_value = 1.0
    # 照亮物体的环境光 = 网页的半球光 / 环境光（换算：均匀环境亮度 = 照度 / π）
    sky, ground = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    for a in plan['ambient']:
        k = a['intensity'] / math.pi
        g = a['ground'] if a['type'] == 'hemisphere' and a.get('ground') else a['color']
        for i in range(3):
            sky[i] += a['color'][i] * k
            ground[i] += g[i] * k
    bg_amb = nodes.new('ShaderNodeBackground')
    bg_amb.location = (200, 120)
    bg_amb.inputs['Strength'].default_value = 1.0
    if sky == ground:
        bg_amb.inputs['Color'].default_value = tuple(sky) + (1.0,)
    else:  # 半球光：下方地面色 → 上方天空色
        coord = nodes.new('ShaderNodeTexCoord')
        coord.location = (-600, 120)
        sep = nodes.new('ShaderNodeSeparateXYZ')
        sep.location = (-400, 120)
        remap = nodes.new('ShaderNodeMapRange')
        remap.location = (-220, 120)
        remap.inputs['From Min'].default_value = -1.0
        remap.inputs['From Max'].default_value = 1.0
        ramp = nodes.new('ShaderNodeValToRGB')
        ramp.location = (-40, 120)
        ramp.color_ramp.elements[0].color = tuple(ground) + (1.0,)
        ramp.color_ramp.elements[1].color = tuple(sky) + (1.0,)
        links.new(coord.outputs['Generated'], sep.inputs[0])
        links.new(sep.outputs['Z'], remap.inputs['Value'])
        links.new(remap.outputs['Result'], ramp.inputs['Fac'])
        links.new(ramp.outputs['Color'], bg_amb.inputs['Color'])
    path = nodes.new('ShaderNodeLightPath')
    path.location = (200, 380)
    mix = nodes.new('ShaderNodeMixShader')
    mix.location = (420, 0)
    links.new(path.outputs['Is Camera Ray'], mix.inputs[0])
    links.new(bg_amb.outputs['Background'], mix.inputs[1])
    links.new(bg_cam.outputs['Background'], mix.inputs[2])
    links.new(mix.outputs['Shader'], out.inputs['Surface'])
    if plan.get('fog'):  # 网页的线性雾：记到雾场（Mist）设置里，合成时可用
        near, far = plan['fog'][:2]
        world.mist_settings.start = near
        world.mist_settings.depth = max(0.01, far - near)
        world.mist_settings.falloff = 'LINEAR'


def build_weather(bpy, scene, plan, f0):
    """网页的雨 / 雪 → Blender 粒子（近似：数量、开始结束帧、风向跟网页一致，雨丝样子不会完全一样）。闪电已经是一盏有逐帧强度的灯。"""
    w = plan.get('weather')
    if not w:
        return []
    fields, fps, made = w['fields'], float(plan['fps']), []
    floor = find_obj(scene, 'FLOOR')
    cx, cy, sx, sy = 0.0, 0.0, 20.0, 20.0
    if floor:
        cx, cy = floor.matrix_world.translation.x, floor.matrix_world.translation.y
        sx, sy = max(4.0, floor.dimensions.x), max(4.0, floor.dimensions.y)
    top = 10.0
    wind = sum(fields['wind']) / max(1, len(fields['wind']))
    wdir = math.radians(sum(fields['windDir']) / max(1, len(fields['windDir'])))
    wx, wy = math.cos(wdir) * wind, -math.sin(wdir) * wind  # 网页 X/Z → Blender X/-Y
    col = bpy.data.collections.new('天气 Weather')
    scene.collection.children.link(col)
    for kind, label, speed, count, size in (('rain', '雨', 9.0, 24000, (.006, .006, .3)), ('snow', '雪', .9, 14000, None)):
        vals = fields.get(kind) or []
        active = [i for i, v in enumerate(vals) if v > .05]
        if not active:
            continue
        mesh = bpy.data.meshes.new('ZP_%s_drop' % kind)
        vel = (wx * speed * (.55 if size else 1.6), wy * speed * (.55 if size else 1.6), -speed)
        if size:  # 雨丝：细长方块，方向（下落 + 风的斜度）直接做进网格，粒子不旋转
            import bmesh
            from mathutils import Matrix, Vector
            bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
            rot = Vector((0, 0, -1)).rotation_difference(Vector(vel).normalized()).to_matrix().to_4x4()
            bmesh.ops.transform(bm, matrix=rot @ Matrix.Diagonal((*size, 1.0)), verts=bm.verts); bm.to_mesh(mesh); bm.free()
        else:  # 雪：小八面体
            verts = [(.02, 0, 0), (-.02, 0, 0), (0, .02, 0), (0, -.02, 0), (0, 0, .02), (0, 0, -.02)]
            faces = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]
            mesh.from_pydata(verts, [], faces)
        drop = bpy.data.objects.new('ZP_%s_drop' % kind, mesh)
        drop.location = (cx, cy, -1000)  # 放远处：只当粒子形状
        mat = bpy.data.materials.new('ZP_%s' % kind); mat.diffuse_color = (.75, .82, .9, 1) if size else (1, 1, 1, 1)
        mesh.materials.append(mat)
        col.objects.link(drop)
        bpy.ops.mesh.primitive_plane_add(size=1.0, location=(cx, cy, top))
        emitter = bpy.context.active_object
        emitter.name = 'ZP_%s_emitter' % kind
        emitter.scale = (sx, sy, 1)
        for c in list(emitter.users_collection):
            c.objects.unlink(emitter)
        col.objects.link(emitter)
        mod = emitter.modifiers.new('ZP_%s' % kind, 'PARTICLE_SYSTEM')
        st = mod.particle_system.settings
        st.count = int(count * max(vals[i] for i in active) * min(1.0, (active[-1] - active[0] + 1) / fps / 10 + .3))
        st.frame_start, st.frame_end = f0 + active[0] - top / speed * fps, f0 + active[-1]
        st.lifetime = top / speed * fps + 2
        st.emit_from = 'FACE'; st.normal_factor = 0.0
        st.object_align_factor = vel
        st.effector_weights.gravity = 0.0
        if not size:
            st.brownian_factor = .3
        st.render_type = 'OBJECT'; st.instance_object = drop; st.particle_size = 1.0
        try:
            st.use_rotations = False
        except AttributeError:
            pass
        emitter.show_instancer_for_render = False; emitter.show_instancer_for_viewport = False
        made.append('%s %d 粒（第 %d–%d 帧）' % (label, st.count, f0 + active[0], f0 + active[-1]))
    return made


def organize(bpy, scene):
    groups = [('人物 Actors', 'ACT_'), ('道具 Props', 'PROP_'), ('相机 Cameras', 'CAM_'), ('灯光 Lights', 'LIGHT_'), ('特效 FX', 'FX'), ('天气 Weather', 'ZP_'), ('场景 Set', '')]
    cols = {}
    for label, _ in groups:
        col = bpy.data.collections.new(label)
        scene.collection.children.link(col)
        cols[label] = col
    for obj in list(scene.objects):
        if any(c.name.startswith('glTF_not_exported') for c in obj.users_collection):
            continue  # 导入插件自己的辅助物体（骨骼显示用的 Icosphere），留在它不渲染的集合里
        top = top_ancestor(obj).name
        label = next(l for l, prefix in groups if top.startswith(prefix))
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        cols[label].objects.link(obj)
        if obj.type == 'ARMATURE' and not obj.name.endswith('_rig'):
            obj.name = clip_bytes('%s_rig' % top, 63)
    for label, col in cols.items():
        if not col.objects:
            bpy.data.collections.remove(col)
    for col in bpy.data.collections:
        if col.name.startswith('glTF_not_exported'):
            col.hide_viewport = col.hide_render = True  # 视图里也不显示那几个骨骼形状球


def drop_startup_scene(bpy, keep):
    """界面模式下，如果当前是没保存过的默认文件（只有立方体 / 灯 / 相机），把默认场景删掉，免得混进工程。"""
    if bpy.data.filepath:
        return
    for sc in list(bpy.data.scenes):
        if sc is keep:
            continue
        if {o.name for o in sc.objects} <= {'Cube', 'Light', 'Camera'}:
            for o in list(sc.objects):
                bpy.data.objects.remove(o)
            bpy.data.scenes.remove(sc)


def build(bpy, glb, out):
    gltf, plan = load_plan(glb)
    fps, frames = plan['fps'], int(plan['frames'])
    title = plan.get('title') or 'ZPboom previs'
    if bpy.app.background:
        bpy.ops.wm.read_homefile(use_empty=True)
        scene = bpy.context.scene
        scene.name = clip_bytes(title)
    else:
        scene = bpy.data.scenes.new(clip_bytes(title))
        bpy.context.window.scene = scene
    # 先设帧率再导入：glTF 导入按当前帧率把秒换成帧
    scene.render.fps = max(1, int(round(fps)))
    scene.render.fps_base = scene.render.fps / float(fps)
    scene.unit_settings.system = 'METRIC'
    before = set(bpy.data.actions)
    import_glb(bpy, glb)
    actions = [a for a in bpy.data.actions if a not in before]
    f0 = int(round(min(a.frame_range[0] for a in actions))) if actions else 0  # 网页 0 秒对应的帧
    scene.frame_start, scene.frame_end, scene.frame_current = f0, f0 + frames - 1, f0

    r = scene.render
    r.resolution_x, r.resolution_y = int(plan['resolution'][0]), int(plan['resolution'][1])
    r.resolution_percentage = 100
    try_set(r, 'engine', ['BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'])
    vs = scene.view_settings
    try_set(vs, 'view_transform', ['AgX', 'Filmic'])
    try_set(vs, 'look', ['AgX - Medium High Contrast', 'Medium High Contrast'])
    exposure = plan.get('exposure') or 1.0
    vs.exposure = math.log2(exposure) if exposure > 0 else 0.0

    # 镜头：每镜一台相机，传感器按竖直 24mm（和网页里的「≈ mm」一致），时间线标记绑定相机自动切镜
    scene.timeline_markers.clear()
    first_cam = None
    for shot in plan['shots']:
        obj = find_obj(scene, shot['camera'], 'CAMERA')
        if not obj:
            print('[ZPboom] 找不到相机 %s，跳过' % shot['camera'])
            continue
        cam = obj.data
        cam.name = obj.name
        cam.sensor_fit = 'VERTICAL'
        cam.sensor_height, cam.sensor_width = 24.0, 36.0
        cam.lens_unit = 'MILLIMETERS'
        cam.lens = shot['lens']
        cam.clip_start, cam.clip_end = shot['near'], shot['far']
        cam.display_size = 0.3
        obj['zpboom_shot'] = clip_bytes(shot['label'], 120)
        marker = scene.timeline_markers.new(clip_bytes('%s %s' % (shot['id'], shot['label'])), frame=f0 + int(shot['startFrame']))
        marker.camera = obj
        first_cam = first_cam or obj
    if first_cam:
        scene.camera = first_cam
    for cue in plan['cues']:
        scene.timeline_markers.new(clip_bytes('♪ ' + cue['label']), frame=f0 + int(cue['frame']))

    # 灯光：网页（three.js 物理单位）点光 / 聚光的强度 I → Blender 功率 4πI 瓦；平行光照度直接等于 Blender 太阳强度
    for e in plan['lights']:
        obj = find_obj(scene, e['node'], 'LIGHT')
        if not obj:
            print('[ZPboom] 找不到灯 %s，跳过' % e['node'])
            continue
        light = obj.data
        to_blender = (lambda v: v) if e['type'] == 'sun' else (lambda v: v * FOUR_PI)
        light.color = tuple(e['color'][:3])
        light.energy = to_blender(e['intensity'])
        light.use_shadow = bool(e.get('castShadow'))
        if e['type'] == 'spot':
            light.spot_size = min(math.pi, 2.0 * e['angle'])
            light.spot_blend = max(0.0, min(1.0, e.get('penumbra', 0.0)))
        if e['type'] != 'sun':
            light.shadow_soft_size = 0.05
            if e.get('distance'):
                try:
                    light.use_custom_distance = True
                    light.cutoff_distance = e['distance']
                except AttributeError:
                    pass
        if e.get('keys'):
            for frame, value in e['keys']:
                light.energy = to_blender(value)
                light.keyframe_insert('energy', frame=f0 + int(frame))
            set_linear(light)

    # 发光材质的闪烁（义眼、机械臂红灯等）
    for e in plan['materials']:
        mat = find_mat(bpy, e['name'])
        if not mat or not mat.use_nodes:
            continue
        sockets = [n.inputs.get('Emission Strength') for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED']
        sockets += [n.inputs.get('Strength') for n in mat.node_tree.nodes if n.type == 'EMISSION']
        sockets = [s for s in sockets if s is not None]
        if not sockets:
            continue
        for frame, value in e['keys']:
            for s in sockets:
                s.default_value = value
                s.keyframe_insert('default_value', frame=f0 + int(frame))
        set_linear(mat.node_tree)

    build_world(bpy, scene, plan)
    organize(bpy, scene)
    try:
        weather_made = build_weather(bpy, scene, plan, f0)
    except Exception as error:  # noqa
        weather_made = ['天气粒子没建成：%s' % error]
    scene['zpboom_title'] = clip_bytes(title, 120)
    scene['zpboom_source'] = os.path.basename(glb)
    for screen in bpy.data.screens:  # 打开工程就是镜头视角、材质预览
        for area in screen.areas:
            if area.type != 'VIEW_3D':
                continue
            for space in area.spaces:
                if space.type == 'VIEW_3D':
                    try:
                        space.region_3d.view_perspective = 'CAMERA'
                        space.shading.type = 'MATERIAL'
                    except (AttributeError, TypeError):
                        pass
    if not bpy.app.background:
        drop_startup_scene(bpy, scene)
    try:
        bpy.ops.file.pack_all()
    except RuntimeError:
        pass
    if bpy.app.background or not bpy.data.filepath:
        bpy.ops.wm.save_as_mainfile(filepath=out)
    else:  # 你正开着别的工程：另存一份，不改你当前文件的路径
        bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    lines = summary_lines(gltf, plan) + (['天气：' + '；'.join(weather_made)] if weather_made else []) + ['时间线：第 %d–%d 帧（网页 0 秒 = 第 %d 帧）' % (scene.frame_start, scene.frame_end, f0), '已保存：%s' % out]
    print('\n[ZPboom] ' + '\n[ZPboom] '.join(lines))
    if not bpy.app.background:
        def draw(self, _context):
            for line in lines[-3:]:
                self.layout.label(text=line)
        bpy.context.window_manager.popup_menu(draw, title='ZPboom.AI 预演已导入 Blender', icon='INFO')
    return out


def main_blender(bpy):
    args = script_args()
    glb = os.path.abspath(os.path.expanduser(args[0])) if args else find_latest_glb(bpy)
    if not os.path.isfile(glb):
        raise FileNotFoundError('找不到 GLB：%s' % glb)
    out = os.path.abspath(os.path.expanduser(args[1])) if len(args) > 1 else default_out(glb)
    print('[ZPboom] 导入 %s' % glb)
    build(bpy, glb, out)


def main_cli(argv):
    if len(argv) >= 2 and argv[0] == '--check':
        gltf, plan = load_plan(argv[1])
        print('\n'.join(summary_lines(gltf, plan)))
        return 0
    print(__doc__)
    return 1


try:
    import bpy  # noqa: E402  在 Blender 里运行时才有
except ImportError:
    bpy = None

if bpy is not None:
    main_blender(bpy)
elif __name__ == '__main__':
    sys.exit(main_cli(sys.argv[1:]))
