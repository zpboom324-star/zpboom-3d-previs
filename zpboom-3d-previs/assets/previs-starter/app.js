import * as THREE from './vendor/three.module.js';
import {Muxer, ArrayBufferTarget} from './vendor/mp4-muxer.mjs';
import {initEditor} from './editor.js?v=2.7.3';
import {initViewTools} from './viewtools.js?v=2.7.3';
import {initWeather, cleanWeather, WEATHER_FIELDS, WEATHER_PRESETS} from './weather.js?v=2.7.3';

/* ZPboom.AI 3D 预演 · 统一引擎（scene.json schemaVersion 2）
   场景几何、灯光、人物体型、姿态、道具、结构动画、特效、声音提示全部写在 scene.json。
   新工程只写数据、不改本文件；确实需要新能力时，用 scene.json 的 extensions 挂一个工程内扩展模块。
   所有运动按时间采样：seek 到同一时间一定得到同一画面。 */

const $ = (id) => document.getElementById(id);
const canvas = $('viewport');
let config, initialConfig, currentTime = 0, playing = false, freeCamera = false;
let previousFrame = performance.now(), recording = null, exporting = null, cameraDirty = false;
let renderer, scene, camera, world, fxGroup, POSES = {};
const actors = new Map(), props = new Map(), points = new Map(), setObjects = new Map(), rigBindings = new Map();
let fxItems = [], editor = null, view = null, weather = null, restoring = false, topView = false;
let shotCam = null; // 分镜相机（导出、小窗、网格都用它）；camera 是视口相机：分镜模式下与它一致，自由观察 / 俯视时独立
const ext = {setTypes: {}, propKinds: {}, fx: {}, onDraw: []}, loadedExtensions = new Set();
const controls = ['play', 'restart', 'record', 'blender'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerp = THREE.MathUtils.lerp, deg = THREE.MathUtils.degToRad;
const finite = (value, label, low = -1000, high = 1000) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error(`${label} 必须是 ${low}～${high} 之间的有限数值`);
  return value;
};
const vector = (value, label, length = 3) => {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${label} 必须包含 ${length} 个数字`);
  return value.map((n) => finite(n, label));
};
const text = (value, label, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 需要 1～${max} 个字符`);
  return value;
};
const id = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) throw new Error(`${label} 只支持字母、数字、下划线和连字符`);
  return value;
};
const color = (value, label = '颜色') => {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${label} 使用 #RRGGBB 格式`);
  return value;
};
const ASPECTS = ['16:9', '21:9', '9:16', '1:1', '4:3', '3:4'];
const aspectNum = (a) => { const [w, h] = String(a).split(':').map(Number); return w / h; };
const REF = /^([A-Za-z0-9_-]{1,40})\.([A-Za-z0-9_]{1,40})$/;
const ref = (value, label) => { if (typeof value !== 'string' || !REF.test(value)) throw new Error(`${label} 写成 对象ID.部位，例如 A.hand_R、GUN.grip、set.door`); return value; };

/* ───────── 姿态库（弧度）─────────
   spine +前屈；neck +低头；neckYaw +向左转头；shL/shR = [前抬, 外展]；el 肘屈；hip +抬腿；knee 负值=屈膝；drop 重心下沉（米，按身高缩放）。
   scene.json 的 poses 可以新增或覆盖，写 base 继承已有姿态。 */
const STAND = {drop: 0, spine: 0, neck: 0, neckYaw: 0, shL: [.1, .12], elL: .2, shR: [.1, .12], elR: .2, hipL: 0, kneeL: 0, hipR: 0, kneeR: 0};
const BUILTIN_POSES = {
  stand: {},
  guard: {drop: .08, spine: .12, shL: [.9, .15], elL: 1.5, shR: [.75, .1], elR: 1.7, hipL: .3, kneeL: -.4, hipR: -.1, kneeR: -.3},
  aim_ready: {spine: .1, shL: [1.2, .1], elL: .6, shR: [1.0, .1], elR: 1.4, hipL: .2, kneeL: -.3, hipR: -.05, kneeR: -.25},
  run: {spine: .3, shL: [.4, .15], elL: 1.4, shR: [.4, .15], elR: 1.4, hipL: .2, kneeL: -.4, hipR: .2, kneeR: -.4},
  carry: {spine: .05, shL: [.15, .12], elL: .3, shR: [.35, .1], elR: .5},
  slash_wind: {spine: -.05, shR: [2.5, .7], elR: .7, shL: [.7, .25], elL: 1.2, hipL: .55, kneeL: -.4, hipR: -.3, kneeR: -.25},
  slash_strike: {spine: .35, drop: .05, shR: [1.25, -.1], elR: .15, shL: [.4, .4], elL: .9, hipL: .7, kneeL: -.6, hipR: -.45, kneeR: -.3},
  grab_wrist: {drop: .15, spine: .2, shL: [1.3, .15], elL: .35, shR: [.8, .15], elR: 1.6, hipL: .4, kneeL: -.6, hipR: -.2, kneeR: -.5},
  throw_turn: {drop: .35, spine: .75, shL: [.7, .35], elL: .4, shR: [.6, .5], elR: .9, hipL: .7, kneeL: -1.1, hipR: .1, kneeR: -.7},
  thrown_air: {spine: -.2, shR: [1.9, .5], elR: .3, shL: [2.5, .9], elL: .4, hipL: .7, kneeL: -.7, hipR: .3, kneeR: -1.0},
  lying: {shL: [.3, .5], elL: .4, shR: [.3, .5], elR: .5, hipL: .15, kneeL: -.25, hipR: .05, kneeR: -.1, neck: -.2},
  crouch_spring: {drop: .42, spine: .55, shL: [.5, .3], elL: .9, shR: [.5, .3], elR: .9, hipL: 1.35, kneeL: -2.0, hipR: 1.3, kneeR: -2.0},
  tuck: {spine: .6, shL: [2.7, .2], elL: .1, shR: [1.0, .4], elR: 1.3, hipL: 1.6, kneeL: -2.2, hipR: 1.5, kneeR: -2.2},
  fire_up: {spine: -.1, shL: [3.0, .1], elL: 0, shR: [.7, .6], elR: 1.0, hipL: .5, kneeL: -.7, hipR: .1, kneeR: -.4},
  hang_swing: {spine: .05, shL: [3.05, .05], elL: .05, shR: [2.2, .35], elR: .5, hipL: .6, kneeL: -.8, hipR: .25, kneeR: -.5},
  jump_air: {spine: .25, shL: [1.2, .9], elL: .5, shR: [1.0, .9], elR: .5, hipL: 1.0, kneeL: -1.3, hipR: .45, kneeR: -.7},
  land_crouch: {drop: .33, spine: .45, shL: [.6, .7], elL: .5, shR: [.4, .6], elR: .6, hipL: 1.1, kneeL: -1.6, hipR: .9, kneeR: -1.4},
  brace: {drop: .2, spine: .25, shL: [.6, .7], elL: .6, shR: [.5, .7], elR: .6, hipL: .6, kneeL: -.9, hipR: .3, kneeR: -.7},
  smash_wind: {spine: -.25, shR: [2.9, .35], elR: 1.0, shL: [.4, .5], elL: 0, hipL: .45, kneeL: -.35, hipR: -.25, kneeR: -.2},
  smash_hit: {drop: .25, spine: .65, shR: [1.0, 0], elR: .1, shL: [.2, .5], elL: 0, hipL: .85, kneeL: -.95, hipR: -.3, kneeR: -.45},
  stab_pre: {drop: .12, spine: .15, shR: [.9, .35], elR: 1.9, shL: [.7, .5], elL: .8, hipL: .7, kneeL: -.6, hipR: -.4, kneeR: -.3},
  stab_lunge: {drop: .2, spine: .3, shR: [1.55, 0], elR: .05, shL: [.4, .7], elL: .6, hipL: 1.0, kneeL: -.95, hipR: -.55, kneeR: -.2},
  dodge_back: {drop: .15, spine: -.65, neck: -.45, shL: [.6, .45], elL: .6, shR: [.5, .5], elR: .7, hipL: .35, kneeL: -.7, hipR: -.1, kneeR: -.45},
  bear_hug: {spine: .2, shL: [1.4, -.3], elL: 1.3, shR: [1.4, -.3], elR: 1.3, hipL: .25, kneeL: -.35, hipR: -.1, kneeR: -.25},
  shout: {spine: .1, neck: -.3, shL: [1.4, -.3], elL: 1.3, shR: [1.4, -.3], elR: 1.3, hipL: .3, kneeL: -.4, hipR: -.1, kneeR: -.3},
  hugged: {drop: .05, spine: .15, shL: [.35, .05], elL: .4, shR: [.5, .1], elR: 1.3, hipL: .2, kneeL: -.35, hipR: -.05, kneeR: -.3},
  glance_L: {drop: .05, spine: .15, neck: .25, neckYaw: .85, shL: [.35, .05], elL: .4, shR: [.5, .1], elR: 1.3, hipL: .2, kneeL: -.35, hipR: -.05, kneeR: -.3},
  slap: {drop: .05, spine: .2, neck: .2, neckYaw: .5, shL: [.35, .05], elL: .4, shR: [1.3, -.6], elR: 1.9, hipL: .2, kneeL: -.4, hipR: -.05, kneeR: -.35},
  recover: {drop: .2, spine: .4, shL: [.6, .4], elL: .6, shR: [.7, .5], elR: 1.2, hipL: .55, kneeL: -.8, hipR: .1, kneeR: -.6},
  grab_low: {drop: .42, spine: 1.0, shR: [1.7, .2], elR: .2, shL: [.3, .5], elL: 0, hipL: 1.1, kneeL: -1.3, hipR: .35, kneeR: -.6},
  run_weapon: {spine: .38, shR: [1.0, .35], elR: .9, shL: [.4, .4], elL: 0, hipL: .25, kneeL: -.5, hipR: .25, kneeR: -.5},
  flung: {spine: -.45, neck: -.3, shL: [1.2, -.25], elL: 1.4, shR: [1.2, -.25], elR: 1.4, hipL: .9, kneeL: -.5, hipR: .8, kneeR: -.4},
  slump: {spine: .15, neck: .35, shL: [.7, .1], elL: 1.3, shR: [.7, .1], elR: 1.3, hipL: 1.5, kneeL: -.25, hipR: 1.45, kneeR: -.2},
};
const POSE_KEYS = Object.keys(STAND);
function buildPoseTable(custom = {}) {
  const table = {};
  for (const [name, pose] of Object.entries(BUILTIN_POSES)) table[name] = {...STAND, ...pose};
  for (const [name, pose] of Object.entries(custom)) {
    id(name, '姿态名称');
    const base = pose.base ? table[pose.base] : STAND;
    if (!base) throw new Error(`姿态 ${name} 的 base ${pose.base} 不存在`);
    const out = {...base};
    for (const key of POSE_KEYS) if (pose[key] !== undefined) out[key] = Array.isArray(STAND[key]) ? vector(pose[key], `姿态 ${name}.${key}`, 2) : finite(pose[key], `姿态 ${name}.${key}`, -10, 10);
    table[name] = out;
  }
  return table;
}

const KIND_DEFAULTS = {style: 'dummy', accent: '#2f74d0', life: 1, scale: 1, width: 1, build: 'neutral', body: '#5b6b7a', pants: '#24292f', skin: '#c9a58b', hair: '#1a1512', boots: '#121315', metal: '#9aa4ae', armL: 'normal', armR: 'normal', eye: null, eyeColor: '#ff2020', pistons: false, ponytail: false, vest: null, forearmL: null, forearmR: null};
const ARM_TYPES = ['normal', 'mech', 'stump'];
const SET_TYPES = ['group', 'box', 'cylinder', 'cone', 'sphere', 'plane', 'circle', 'stairs'];
const LIGHT_TYPES = ['hemisphere', 'directional', 'point', 'spot', 'ambient'];
const FX_TYPES = ['cables', 'glow', 'sparks', 'dust'];
const ACTOR_FIELDS = [['pitch', -20, 20], ['roll', -20, 20], ['gait', 0, 1], ['crouch', 0, 1], ['aim', -1.6, 1.6], ['look', -1.6, 1.6], ['life', 0, 3], ['armL', 0, 1], ['armR', 0, 1]];
function easeOf(value) { if (!['smooth', 'linear', 'hold'].includes(value)) throw new Error('ease 只支持 smooth / linear / hold'); return value; }
function timedKeys(value, length, label, mapper, cover = true) {
  if (!Array.isArray(value) || value.length < (cover ? 2 : 1) || value.length > 4000) throw new Error(`${label} 需要 ${cover ? 2 : 1}～4000 个关键帧`);
  let previous = -1;
  const out = value.map((key) => {
    const time = finite(key.time, `${label} 时间`, 0, length + 1e-6);
    if (time <= previous) throw new Error(`${label} 关键帧时间必须递增且不能重复`);
    previous = time; return {time, ...mapper(key)};
  });
  if (out[0].time > 1e-4) throw new Error(`${label} 第一个关键帧必须在 0 秒`);
  if (cover && Math.abs(out.at(-1).time - length) > 1e-4) throw new Error(`${label} 关键帧必须覆盖 0 到 ${length} 秒`);
  return out;
}
function cleanNode(node, path, rigIds, setIds) {
  if (!node || typeof node !== 'object') throw new Error(`${path} 必须是对象`);
  if (!SET_TYPES.includes(node.type) && !ext.setTypes[node.type]) throw new Error(`${path}.type 未知：${node.type}`);
  const out = {...node};
  if (node.id !== undefined) { id(node.id, `${path}.id`); if (setIds.has(node.id)) throw new Error(`场景节点 id ${node.id} 重复`); setIds.add(node.id); }
  for (const key of ['position', 'rotation', 'scale']) if (node[key] !== undefined) out[key] = vector(node[key], `${path}.${key}`);
  if (node.type === 'box') out.size = vector(node.size, `${path}.size`);
  if (node.type === 'plane') out.size = vector(node.size, `${path}.size`, 2);
  if (['cylinder', 'cone', 'sphere', 'circle'].includes(node.type)) out.radius = finite(node.radius ?? node.radiusBottom, `${path}.radius`, .001, 500);
  if (['cylinder', 'cone'].includes(node.type)) out.height = finite(node.height, `${path}.height`, .001, 500);
  if (node.type === 'stairs') for (const key of ['steps', 'run', 'rise', 'width']) out[key] = finite(node[key], `${path}.${key}`, .001, 500);
  if (node.color !== undefined) color(node.color, `${path}.color`);
  if (node.repeat) out.repeat = {count: finite(node.repeat.count, `${path}.repeat.count`, 1, 500), step: vector(node.repeat.step || [0, 0, 0], `${path}.repeat.step`), alternate: node.repeat.alternate ? vector(node.repeat.alternate, `${path}.repeat.alternate`) : null};
  if (node.rig) {
    if (!rigIds.has(node.rig.id)) throw new Error(`${path}.rig.id ${node.rig.id} 在 rigs 里不存在`);
    if (!['x', 'y', 'z'].includes(node.rig.axis)) throw new Error(`${path}.rig.axis 只支持 x / y / z`);
    out.rig = {id: node.rig.id, axis: node.rig.axis, mode: node.rig.mode === 'translate' ? 'translate' : 'rotate', scale: finite(node.rig.scale ?? 1, 'rig.scale', -100, 100), offset: finite(node.rig.offset ?? 0, 'rig.offset', -1000, 1000)};
  }
  if (node.children) out.children = node.children.map((child, i) => cleanNode(child, `${path}.children[${i}]`, rigIds, setIds));
  return out;
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 2) throw new Error('本模板使用 schemaVersion: 2 的场景配置');
  const duration = finite(raw.duration, '全片时长', 0.5, 600);
  const fps = finite(raw.fps, '帧率', 1, 60);
  if (!Number.isInteger(fps)) throw new Error('帧率使用整数');
  if (!raw.world || raw.world.up !== 'Y' || raw.world.unit !== 'meter') throw new Error('坐标约定必须是 Y 向上，单位 meter');
  const aspectRatio = raw.aspectRatio || '16:9';
  if (!ASPECTS.includes(aspectRatio)) throw new Error(`aspectRatio 支持 ${ASPECTS.join('、')}`);
  const w = raw.world, floor = w.floor || {};
  const clean = {schemaVersion: 2, title: text(raw.title, '项目标题'), fps, duration, aspectRatio,
    world: {up: 'Y', unit: 'meter', background: color(w.background, 'world.background'), exposure: finite(w.exposure ?? 1.2, 'world.exposure', .05, 10), ...(w.lift ? {lift: finite(w.lift, 'world.lift', 0, 1)} : {}),
      fog: w.fog ? vector(w.fog, 'world.fog', 2) : null, whitebox: Boolean(w.whitebox), figure: w.figure === 'pill' ? 'pill' : 'jointed', handheld: finite(w.handheld ?? 0, 'world.handheld', 0, 3), floor: {size: vector(floor.size || [24, 24], 'world.floor.size', 2), color: color(floor.color || '#3a3d40', 'world.floor.color'), roughness: finite(floor.roughness ?? .9, 'floor.roughness', 0, 1)}, grid: w.grid !== false}};
  if (raw.extensions !== undefined) clean.extensions = raw.extensions.map((path) => { if (typeof path !== 'string' || !/^(\.\/)?[\w-][\w./-]*\.js$/.test(path) || path.includes('..')) throw new Error(`扩展路径无效：${path}`); return path; });
  clean.lights = (raw.lights || []).map((light, i) => {
    if (!LIGHT_TYPES.includes(light?.type)) throw new Error(`lights[${i}].type 支持 ${LIGHT_TYPES.join('、')}`);
    const out = {type: light.type, color: color(light.color || '#ffffff', `lights[${i}].color`), intensity: finite(light.intensity ?? 1, `lights[${i}].intensity`, 0, 10000)};
    if (light.ground) out.ground = color(light.ground, `lights[${i}].ground`);
    for (const key of ['position', 'target']) if (light[key]) out[key] = vector(light[key], `lights[${i}].${key}`);
    for (const key of ['distance', 'decay', 'angle', 'penumbra', 'shadowBox']) if (light[key] !== undefined) out[key] = finite(light[key], `lights[${i}].${key}`, 0, 1000);
    if (light.shadow) out.shadow = true; if (light.editorOnly) out.editorOnly = true;
    return out;
  });
  clean.rigs = (raw.rigs || []).map((rig) => ({id: id(rig.id, '结构 ID'), label: text(rig.label || rig.id, '结构名称', 80),
    keyframes: timedKeys(rig.keyframes, duration, `结构 ${rig.id}`, (key) => ({value: finite(key.value, '结构数值', -100000, 100000), ...(key.ease !== undefined ? {ease: easeOf(key.ease)} : {})}))}));
  const rigIds = new Set(clean.rigs.map((rig) => rig.id)), setIds = new Set();
  clean.set = (raw.set || []).map((node, i) => cleanNode(node, `set[${i}]`, rigIds, setIds));
  clean.kinds = {};
  for (const [name, kind] of Object.entries(raw.kinds || {})) {
    id(name, '体型名称'); const out = {...KIND_DEFAULTS};
    for (const key of ['scale', 'width']) if (kind[key] !== undefined) out[key] = finite(kind[key], `kinds.${name}.${key}`, .2, 4);
    for (const key of ['body', 'pants', 'skin', 'hair', 'boots', 'metal', 'eyeColor', 'vest', 'forearmL', 'forearmR']) if (kind[key]) out[key] = color(kind[key], `kinds.${name}.${key}`);
    for (const key of ['armL', 'armR']) if (kind[key]) { if (!ARM_TYPES.includes(kind[key])) throw new Error(`kinds.${name}.${key} 支持 ${ARM_TYPES.join('、')}`); out[key] = kind[key]; }
    if (kind.eye) { if (!['L', 'R'].includes(kind.eye)) throw new Error(`kinds.${name}.eye 只支持 L / R`); out.eye = kind.eye; }
    if (kind.build) { if (!['neutral', 'male', 'female'].includes(kind.build)) throw new Error(`kinds.${name}.build 只支持 neutral / male / female`); out.build = kind.build; }
    if (kind.style) { if (!['dummy', 'mannequin'].includes(kind.style)) throw new Error(`kinds.${name}.style 只支持 dummy / mannequin`); out.style = kind.style; }
    if (kind.accent) out.accent = color(kind.accent, `kinds.${name}.accent`);
    if (kind.life !== undefined) out.life = finite(kind.life, `kinds.${name}.life`, 0, 3);
    out.pistons = Boolean(kind.pistons); out.ponytail = Boolean(kind.ponytail);
    clean.kinds[name] = out;
  }
  clean.poses = raw.poses || {};
  const poseTable = buildPoseTable(clean.poses);
  if (!Array.isArray(raw.actors) || raw.actors.length > 24) throw new Error('actors 需要是 0～24 个角色的数组');
  const owners = new Set();
  clean.actors = raw.actors.map((actor) => {
    const actorId = id(actor.id, '角色 ID'); if (owners.has(actorId)) throw new Error(`ID ${actorId} 重复`); owners.add(actorId);
    if (!clean.kinds[actor.kind]) throw new Error(`角色 ${actorId} 的 kind ${actor.kind} 没有在 kinds 里定义`);
    const keyframes = timedKeys(actor.keyframes, duration, `角色 ${actorId}`, (key) => {
      const out = {position: vector(key.position, '角色位置'), yaw: finite(key.yaw, '角色 yaw', -Math.PI * 100, Math.PI * 100), pose: key.pose ?? 'stand'};
      if (key.ease !== undefined) out.ease = easeOf(key.ease);
      if (!poseTable[out.pose]) throw new Error(`角色 ${actorId} 使用了未知姿态 ${out.pose}`);
      if (key.adjust) { out.adjust = {}; for (const [k, v] of Object.entries(key.adjust)) { if (!POSE_KEYS.includes(k)) throw new Error(`角色 ${actorId} 的 adjust 不支持 ${k}`); out.adjust[k] = Array.isArray(STAND[k]) ? vector(v, `adjust.${k}`, 2).map((n) => finite(n, `adjust.${k}`, -3.2, 3.2)) : finite(v, `adjust.${k}`, -3.2, 3.2); } if (!Object.keys(out.adjust).length) delete out.adjust; }
      for (const [field, low, high] of ACTOR_FIELDS) if (key[field] !== undefined) out[field] = finite(key[field], field, low, high);
      for (const side of ['reachL', 'reachR']) if (key[side]) {
        const world = key[side].target === 'world';
        out[side] = {target: world ? 'world' : ref(key[side].target, side), w: finite(key[side].w, `${side}.w`, 0, 1)};
        if (world) out[side].pos = vector(key[side].pos, `${side}.pos`);
      }
      return out;
    });
    const clips = (actor.clips || []).map((c, i) => {
      const where = `角色 ${actorId} 的 clips[${i}]`;
      if (!(raw.motions || []).some((m) => m.id === c.motion)) throw new Error(`${where}.motion ${c.motion} 没有在 motions 里定义`);
      const out = {motion: c.motion, start: finite(c.start, `${where}.start`, 0, duration), offset: finite(c.offset ?? 0, `${where}.offset`, 0, 100000), speed: finite(c.speed ?? 1, `${where}.speed`, .05, 10),
        weight: finite(c.weight ?? 1, `${where}.weight`, 0, 1), fadeIn: finite(c.fadeIn ?? .25, `${where}.fadeIn`, 0, 10), fadeOut: finite(c.fadeOut ?? .25, `${where}.fadeOut`, 0, 10), loop: Boolean(c.loop), rootMotion: Boolean(c.rootMotion), hold: Boolean(c.hold)};
      if (c.end !== undefined) out.end = finite(c.end, `${where}.end`, out.start, duration);
      if (c.override !== undefined && c.override !== null && c.override !== false) { if (!['pose', 'all'].includes(c.override)) throw new Error(`${where}.override 只能是 pose（覆盖姿态）或 all（完全覆盖）`); out.override = c.override; }
      return out;
    });
    return {id: actorId, label: text(actor.label, '角色名称', 80), kind: actor.kind, color: color(actor.color || '#4fd1e0', '角色标签颜色'), keyframes, ...(clips.length ? {clips} : {})};
  });
  clean.props = (raw.props || []).map((prop) => {
    const propId = id(prop.id, '道具 ID'); if (owners.has(propId)) throw new Error(`ID ${propId} 重复`); owners.add(propId);
    if (!PROP_KINDS[prop.kind] && !ext.propKinds[prop.kind]) throw new Error(`道具 kind 支持 ${[...Object.keys(PROP_KINDS), ...Object.keys(ext.propKinds)].join('、')}`);
    if (!clean.actors.some((actor) => actor.id === prop.owner)) throw new Error(`道具 ${propId} 的 owner 必须是角色 ID`);
    const keyframes = timedKeys(prop.keyframes, duration, `道具 ${propId}`, (key) => {
      const holder = key.holder === 'world' || key.holder === 'hidden' ? key.holder : ref(key.holder, '道具持有者');
      const out = {holder};
      if (holder === 'world') { out.position = vector(key.position, '道具位置'); out.rotation = vector(key.rotation || [0, 0, 0], '道具旋转（度）'); }
      if (key.params) { out.params = {}; for (const [name, value] of Object.entries(key.params)) out.params[name] = finite(value, `道具参数 ${name}`, -10000, 10000); }
      return out;
    }, false);
    return {id: propId, label: text(prop.label || propId, '道具名称', 80), kind: prop.kind, owner: prop.owner, options: prop.options || {}, keyframes};
  });
  clean.fx = (raw.fx || []).map((fx, i) => {
    if (!FX_TYPES.includes(fx?.type) && !ext.fx[fx?.type]) throw new Error(`fx[${i}].type 支持 ${[...FX_TYPES, ...Object.keys(ext.fx)].join('、')}`);
    const out = {...fx};
    for (const key of ['source', 'target']) if (fx[key] !== undefined) out[key] = ref(fx[key], `fx[${i}].${key}`);
    for (const key of ['start', 'end', 'fire', 'anchored', 'release', 'released']) if (fx[key] !== undefined) out[key] = finite(fx[key], `fx[${i}].${key}`, 0, duration);
    if (fx.anchors) out.anchors = fx.anchors.map((a) => vector(a, `fx[${i}].anchors`));
    if (fx.windows) out.windows = fx.windows.map((win) => vector(win, `fx[${i}].windows`, 2));
    for (const key of ['min', 'max']) if (fx[key]) out[key] = vector(fx[key], `fx[${i}].${key}`);
    if (fx.color) color(fx.color, `fx[${i}].color`);
    if (fx.type === 'cables' && !(out.source && out.anchors?.length)) throw new Error(`fx[${i}] 钢索需要 source 和 anchors`);
    if (['glow', 'sparks'].includes(fx.type) && !out.target) throw new Error(`fx[${i}] 需要 target`);
    return out;
  });
  const refs = [];
  for (const actor of clean.actors) for (const key of actor.keyframes) for (const side of ['reachL', 'reachR']) if (key[side] && key[side].target !== 'world') refs.push(key[side].target);
  for (const prop of clean.props) for (const key of prop.keyframes) if (REF.test(key.holder)) refs.push(key.holder);
  for (const fx of clean.fx) for (const key of ['source', 'target']) if (fx[key]) refs.push(fx[key]);
  for (const value of refs) { const owner = value.split('.')[0]; if (owner === 'set' ? !setIds.has(value.split('.')[1]) : !owners.has(owner)) throw new Error(`引用 ${value} 找不到对象 ${owner === 'set' ? value : owner}`); }
  if (!Array.isArray(raw.shots) || !raw.shots.length || raw.shots.length > 200) throw new Error('场景支持 1～200 个镜头');
  let cursor = 0; const shotIds = new Set();
  clean.shots = raw.shots.map((shot) => {
    const shotId = id(shot.id, '镜头 ID'); if (shotIds.has(shotId)) throw new Error('镜头 ID 不能重复'); shotIds.add(shotId);
    const start = finite(shot.start, '镜头开始', 0, duration), end = finite(shot.end, '镜头结束', 0, duration);
    if (end <= start || Math.abs(start - cursor) > 1e-4) throw new Error('镜头需要从 0 开始连续排列，不能重叠或留空');
    cursor = end;
    return {id: shotId, label: text(shot.label, '镜头名称', 80), action: typeof shot.action === 'string' ? shot.action.slice(0, 1000) : '', start, end,
      camera: {fov: finite(shot.camera?.fov, 'FOV', 10, 100), ...(shot.camera?.aspect ? {aspect: ASPECTS.includes(shot.camera.aspect) ? shot.camera.aspect : (() => { throw new Error(`镜头 ${shotId} 的 camera.aspect 支持 ${ASPECTS.join('、')}`); })()} : {}), ...(shot.camera?.handheld !== undefined ? {handheld: finite(shot.camera.handheld, 'camera.handheld', 0, 3)} : {}), keyframes: timedKeys(shot.camera?.keyframes, end - start, `镜头 ${shotId} 相机`, (key) => {
        const out = {position: vector(key.position, '相机位置'), target: vector(key.target, '相机目标')};
        if (key.ease !== undefined) out.ease = easeOf(key.ease);
        if (Math.hypot(...out.position.map((n, i) => n - out.target[i])) < 1e-5) throw new Error('相机位置不能与目标重合');
        return out;
      })}};
  });
  if (Math.abs(cursor - duration) > 1e-4) throw new Error('最后一个镜头必须结束在全片时长');
  clean.motions = (raw.motions || []).map((m, i) => {
    if (m.data !== undefined) { // 视频动捕的动作数据直接存在 scene.json
      const d = m.data; if (d?.format !== 'zpboom-pose' || !Array.isArray(d.points) || !Array.isArray(d.frames) || !d.frames.length || !(d.fps > 0)) throw new Error(`motions[${i}].data 不是有效的视频动捕数据`);
      if (d.frames.some((f) => !Array.isArray(f) || f.length !== d.points.length * 3 || f.some((n) => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error(`motions[${i}].data 的帧数据不完整`);
      if (d.lift !== undefined && (!Array.isArray(d.lift) || d.lift.length !== d.frames.length || d.lift.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 5))) throw new Error(`motions[${i}].data.lift（离地高度）必须是每帧一个 0–5 米的数`);
      return {id: id(m.id, '动作 ID'), data: d, ...(typeof m.label === 'string' ? {label: m.label.slice(0, 80)} : {})};
    }
    if (typeof m.file !== 'string' || !/\.fbx$/i.test(m.file) || /^[a-z]+:|^\/|\.\./i.test(m.file)) throw new Error(`motions[${i}].file 必须是工程内的 .fbx 相对路径`);
    return {id: id(m.id, '动作 ID'), file: m.file, clip: typeof m.clip === 'string' ? text(m.clip, `motions[${i}].clip`, 200) : finite(m.clip ?? 0, `motions[${i}].clip`, 0, 1000)};
  });
  if (new Set(clean.motions.map((m) => m.id)).size !== clean.motions.length) throw new Error('motions 的 id 不能重复');
  clean.cues = (raw.cues || []).slice(0, 500).map((cue) => ({time: finite(cue.time, '提示时间', 0, duration), label: text(cue.label, '提示文字', 120)}));
  const cleanedWeather = cleanWeather(raw.weather, duration, {finite, timedKeys, easeOf}); if (cleanedWeather) clean.weather = cleanedWeather;
  return clean;
}

/* ───────── 材质与几何 ───────── */
const SIDES = {front: THREE.FrontSide, back: THREE.BackSide, double: THREE.DoubleSide};
let materialCache = new Map();
/* 白膜场景：把场景几何统一成带一点原色倾向的白灰哑光，只保留不受光的黑洞、玻璃和发光体 */
const whiten = (c) => '#' + new THREE.Color(c).lerp(new THREE.Color('#ece8e0'), .8).getHexString();
function materialFor(node) {
  const m = node.material || {}, key = JSON.stringify([node.color, m]);
  if (materialCache.has(key)) return materialCache.get(key);
  const white = config?.world.whitebox && !m.basic && !m.emissive;
  const opts = {color: white ? whiten(node.color || '#888888') : node.color || '#888888', side: SIDES[m.side] || THREE.FrontSide};
  if (m.opacity !== undefined) Object.assign(opts, {transparent: true, opacity: m.opacity, depthWrite: m.opacity > .95});
  if (m.additive) Object.assign(opts, {transparent: true, blending: THREE.AdditiveBlending, depthWrite: false});
  const mat = m.basic ? new THREE.MeshBasicMaterial(opts) : new THREE.MeshStandardMaterial({...opts, roughness: white ? .95 : m.roughness ?? .8, metalness: white ? 0 : m.metalness ?? .1, emissive: m.emissive || '#000000', emissiveIntensity: m.emissiveIntensity ?? 1});
  materialCache.set(key, mat); return mat;
}
function mat(value, extra = {}) { return new THREE.MeshStandardMaterial({color: value, roughness: .7, metalness: .15, ...extra}); }
function box(parent, size, position, material, cast = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position); mesh.castShadow = cast; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function disposeGroup(group) {
  group.traverse((object) => { object.geometry?.dispose(); const mats = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []; for (const m of mats) { m.map?.dispose(); m.dispose(); } });
  group.clear();
}
function geometryFor(node) {
  const seg = node.segments ?? (node.type === 'circle' ? 28 : 16);
  switch (node.type) {
    case 'box': return new THREE.BoxGeometry(...node.size);
    case 'cylinder': return new THREE.CylinderGeometry(node.radiusTop ?? node.radius, node.radiusBottom ?? node.radius, node.height, seg, 1, Boolean(node.open));
    case 'cone': return new THREE.ConeGeometry(node.radius, node.height, seg, 1, Boolean(node.open));
    case 'sphere': return new THREE.SphereGeometry(node.radius, Math.max(seg, 12), Math.max(8, Math.round(seg * .7)), 0, Math.PI * 2, 0, node.thetaLength ? deg(node.thetaLength) : Math.PI);
    case 'plane': return new THREE.PlaneGeometry(...node.size);
    case 'circle': return new THREE.CircleGeometry(node.radius, seg);
    default: return null;
  }
}
/* 楼梯：沿本地 +X 上升，position 是第一级起点（宽度中心），用 rotation 改方向 */
function buildStairs(node) {
  const group = new THREE.Group(), body = materialFor(node), {steps, run, rise, width} = node;
  const tread = node.treadColor ? materialFor({color: node.treadColor, material: node.material}) : null;
  const highlight = new Map((node.highlight || []).map((item) => [item.step, materialFor({color: item.color, material: node.material})]));
  const railing = node.railing, railMat = railing ? materialFor({color: railing.color || node.color, material: node.material}) : null, side = railing?.side ?? 1, rz = side * (width / 2 + .03);
  for (let i = 1; i <= steps; i++) {
    const h = i * rise, x = (i - .5) * run;
    box(group, [run, h, width], [x, h / 2, 0], highlight.get(i) || body);
    if (tread) box(group, [run + .02, .025, width + .02], [x, h + .012, 0], tread);
    if (railing) box(group, [.04, railing.height, .04], [x, h + railing.height / 2, rz], railMat);
  }
  if (railing) { const rail = box(group, [Math.hypot(steps * run, steps * rise) + .05, .06, .07], [steps * run / 2, steps * rise / 2 + railing.height + .02, rz], railMat); rail.rotation.z = Math.atan2(rise, run); }
  return group;
}
function bindRig(rig, obj) {
  const base = rig.mode === 'translate' ? obj.position[rig.axis] : obj.rotation[rig.axis];
  if (!rigBindings.has(rig.id)) rigBindings.set(rig.id, []);
  rigBindings.get(rig.id).push({...rig, obj, base});
}
function buildNode(node, parent) {
  const count = node.repeat?.count ?? 1;
  for (let i = 0; i < count; i++) {
    let obj;
    if (node.type === 'group') obj = new THREE.Group();
    else if (node.type === 'stairs') obj = buildStairs(node);
    else if (ext.setTypes[node.type]) { obj = new THREE.Group(); ext.setTypes[node.type](node, obj, api); }
    else { obj = new THREE.Mesh(geometryFor(node), materialFor(node)); const basic = node.material?.basic; obj.castShadow = node.cast ?? !basic; obj.receiveShadow = node.receive ?? !basic; }
    const p = node.position || [0, 0, 0], step = node.repeat?.step || [0, 0, 0], alt = node.repeat?.alternate;
    const repeatOffset = step.map((n, k) => n * i + (alt ? alt[k] * (i % 2 ? 1 : -1) : 0));
    obj.position.set(...p.map((n, k) => n + repeatOffset[k]));
    obj.userData.node = node; obj.userData.repeatOffset = repeatOffset; obj.userData.repeatIndex = i;
    if (node.rotation) obj.rotation.set(...node.rotation.map(deg));
    if (node.scale) obj.scale.set(...node.scale);
    if (node.helper) obj.userData.helper = true;
    parent.add(obj);
    for (const child of node.children || []) buildNode(child, obj);
    if (node.rig) bindRig(node.rig, obj);
    if (node.id && i === 0) { setObjects.set(node.id, obj); points.set(`set.${node.id}`, obj); }
  }
}
function buildWorld() {
  if (world) { disposeGroup(world); scene.remove(world); }
  world = new THREE.Group(); scene.add(world); materialCache = new Map(); rigBindings.clear(); setObjects.clear();
  const w = config.world;
  scene.background = new THREE.Color(w.background); scene.fog = w.fog ? new THREE.Fog(w.background, w.fog[0], w.fog[1]) : null;
  renderer.toneMappingExposure = w.exposure;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(...w.floor.size), new THREE.MeshStandardMaterial({color: w.whitebox ? whiten(w.floor.color) : w.floor.color, roughness: w.whitebox ? .95 : w.floor.roughness, metalness: 0}));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; world.add(floor);
  for (const l of config.lights) {
    let light;
    if (l.type === 'hemisphere') light = new THREE.HemisphereLight(l.color, l.ground || '#222222', l.intensity);
    else if (l.type === 'ambient') light = new THREE.AmbientLight(l.color, l.intensity);
    else if (l.type === 'point') light = new THREE.PointLight(l.color, l.intensity, l.distance ?? 0, l.decay ?? 2);
    else if (l.type === 'spot') light = new THREE.SpotLight(l.color, l.intensity, l.distance ?? 0, deg(l.angle ?? 30), l.penumbra ?? .3, l.decay ?? 2);
    else light = new THREE.DirectionalLight(l.color, l.intensity);
    if (l.position) light.position.set(...l.position);
    if (light.target && l.target) { light.target.position.set(...l.target); world.add(light.target); }
    if (l.shadow && light.shadow) {
      light.castShadow = true; light.shadow.mapSize.set(2048, 2048); light.shadow.normalBias = .03;
      if (l.type === 'directional') { const b = l.shadowBox ?? 14; Object.assign(light.shadow.camera, {left: -b, right: b, top: b, bottom: -b, near: .5, far: 80}); }
    }
    if (l.editorOnly) light.userData.helper = true;
    world.add(light);
  }
  for (const node of config.set) buildNode(node, world);
  if (w.grid) { const size = Math.max(...w.floor.size); const grid = new THREE.GridHelper(size, size, '#4d6675', '#2c3e4a'); grid.position.y = .008; grid.material.transparent = true; grid.material.opacity = .25; grid.userData.helper = true; world.add(grid); }
}

/* ───────── 多关节人物代理（体型来自 scene.json 的 kinds）───────── */
/* 圆润人偶：胶囊四肢 + 旋转体躯干 + 球形关节。关节层级、长度和部位坐标与方块版完全一致，
   所以姿态、IK 接触和道具挂点不受影响；体型用 kinds 的 scale / width / build 控制。 */
const BUILDS = {neutral: {shoulder: 1, waist: .9, hip: 1, chest: 1}, male: {shoulder: 1.08, waist: .92, hip: .95, chest: 1.04}, female: {shoulder: .9, waist: .76, hip: 1.1, chest: .98}};
function limb(parent, radius, length, position, material) { // 胶囊肢体：length 为两端关节之间的距离
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(.001, length - radius), 5, 14), material);
  mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function ball(parent, radius, position, material, scale) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), material);
  mesh.position.set(...position); if (scale) mesh.scale.set(...scale); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function torsoGeometry(build) { // 旋转体轮廓（半径, 高度）：胯 → 腰 → 胸 → 肩 → 颈根
  const b = BUILDS[build] || BUILDS.neutral;
  const profile = [[.001, -.04], [.1 * b.hip, -.035], [.125 * b.hip, .01], [.12 * b.hip, .07], [.115 * b.waist, .16], [.135 * b.chest, .27], [.148 * b.shoulder, .37], [.145 * b.shoulder, .44], [.12 * b.shoulder, .5], [.07, .545], [.001, .56]];
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 28);
}
function labelSprite(actor) {
  const label = document.createElement('canvas'); label.width = 256; label.height = 88;
  const ctx = label.getContext('2d');
  ctx.fillStyle = 'rgba(15,33,45,.92)'; ctx.fillRect(20, 10, 216, 64); ctx.fillStyle = actor.color; ctx.fillRect(20, 10, 5, 64);
  ctx.font = 'bold 35px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#f5fbff'; ctx.fillText(actor.id, 128, 44);
  const texture = new THREE.CanvasTexture(label); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: texture, depthTest: false, transparent: true}));
  sprite.position.set(0, 2.35, 0); sprite.scale.set(.9, .31, 1); sprite.userData.helper = true; return sprite;
}
function mechArmParts(parent, s, metalColor) {
  const metal = mat(metalColor, {metalness: .85, roughness: .3}), dark = mat('#2b3036', {metalness: .6, roughness: .4});
  ball(parent, .075 * s, [0, 0, 0], dark);
  limb(parent, .046 * s, .3 * s, [0, -.15 * s, 0], metal);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.05 * s, .009 * s, 6, 18), dark); ring.rotation.x = Math.PI / 2; ring.position.y = -.09 * s; parent.add(ring);
  return {metal, dark};
}
function mechHand(parent, s, g, y) { // 机械手掌 + 三根指
  ball(parent, .038 * s, [0, y, 0], g.dark, [1.15, .85, .9]);
  for (const fx of [-.024, 0, .024]) limb(parent, .009 * s, .07 * s, [fx * s, y - .055 * s, -.008 * s], g.metal);
}
/* ───────── 白膜人偶（默认造型，参照专业白膜预演）─────────
   球形头悬空、弧形长方形眼带标出视线；立方体躯干（蒙皮，可随脊柱弯曲）胸前一块名牌标出胸口朝向；
   上臂 / 前臂 / 大腿 / 小腿各一节胶囊，不做手脚，关节处留小缝；整个角色一种纯色、哑光。
   关节层级与部位坐标和其他造型一致，所以走位、IK 接触、道具挂点通用。kinds 写 style: "mannequin" 可换回圆润人偶。 */
function bentBox(body, torso, s, w, material) { // 躯干方块：下半随骨盆、上半随胸腔，中间平滑弯曲
  const bw = .38 * s * w, bh = .6 * s, bd = .27 * s, y0 = -.015 * s;
  const geo = new THREE.BoxGeometry(bw, bh, bd, 1, 12, 1); geo.translate(0, y0 + bh / 2, 0);
  const pos = geo.attributes.position, idx = [], wts = [];
  for (let i = 0; i < pos.count; i++) { const u = clamp((pos.getY(i) - y0) / bh, 0, 1), wb = smooth01(clamp((u - .1) / .62, 0, 1)); idx.push(0, 1, 0, 0); wts.push(1 - wb, wb, 0, 0); }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  const lower = new THREE.Bone(), upper = new THREE.Bone(); body.add(lower); torso.add(upper);
  const mesh = new THREE.SkinnedMesh(geo, material); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; body.add(mesh);
  body.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([lower, upper]));
  return {bw, bh, bd, y0};
}
function capsuleBetween(parent, radius, from, to, material) { // 胶囊从关节 from 到 to（只沿 -Y），两端各留一点缝
  const len = Math.abs(to - from), mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(.001, len - 2 * radius), 6, 16), material);
  mesh.position.y = (from + to) / 2; mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function buildDummy(actor) {
  const k = config.kinds[actor.kind], s = k.scale, w = k.width;
  const skin = mat(k.body, {roughness: .88, metalness: 0}), accent = mat(k.accent, {roughness: .7, metalness: 0}), metal = mat(k.metal, {roughness: .45, metalness: .7});
  const root = new THREE.Group(), body = new THREE.Group(); body.position.y = .95 * s; root.add(body);
  const torso = new THREE.Group(); body.add(torso);
  const tb = bentBox(body, torso, s, w, skin);
  if (k.vest) box(torso, [tb.bw * 1.04, tb.bh * .42, tb.bd * 1.06], [0, .38 * s, 0], mat(k.vest, {roughness: .85}));
  box(torso, [tb.bw * .5, tb.bh * .2, .012 * s], [0, .36 * s, -tb.bd * (k.vest ? 1.06 : 1) / 2 - .006 * s], accent, false); // 胸前名牌（有背心时贴在背心外）
  const neck = new THREE.Group(); neck.position.y = .55 * s; torso.add(neck);
  const head = new THREE.Group(); head.position.y = .03 * s; neck.add(head);
  const R = .12 * s, hc = .15 * s;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(R, 28, 20), skin); skull.position.y = hc; skull.castShadow = true; skull.receiveShadow = true; head.add(skull);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.012, R * 1.012, .05 * s, 28, 1, true, Math.PI - .95, 1.9), accent); band.position.y = hc + .012 * s; head.add(band); // 弧形眼带
  if (k.ponytail) { const tail = capsuleBetween(head, .03 * s, 0, -.13 * s, mat(k.hair, {roughness: .8})); tail.position.set(0, hc - .02 * s, R * .95); tail.rotation.x = -.5; }
  const pts = {};
  const point = (name, parent, pos, obj = new THREE.Object3D()) => { obj.position.set(...pos); parent.add(obj); pts[name] = obj; points.set(`${actor.id}.${name}`, obj); return obj; };
  point('head', head, [0, .12 * s, 0]); point('chest_front', torso, [0, .32 * s, -.26 * s]); point('chest_back', torso, [0, .32 * s, .2 * s]);
  point('shoulder_L', torso, [-.24 * s * w, .48 * s, 0]); point('shoulder_R', torso, [.24 * s * w, .48 * s, 0]);
  point('shoulderInner_L', torso, [-.15 * s * w, .44 * s, -.13 * s]); point('shoulderInner_R', torso, [.15 * s * w, .44 * s, -.13 * s]);
  point('aim', torso, [.1 * s, .46 * s, -.06 * s]); point('hip', body, [0, 0, 0]);
  if (k.eye) point('eye', head, [(k.eye === 'L' ? -1 : 1) * .045 * s, hc + .012 * s, -R * 1.02], new THREE.Mesh(new THREE.SphereGeometry(.022 * s, 12, 10), new THREE.MeshStandardMaterial({color: '#200000', emissive: k.eyeColor, emissiveIntensity: 2.2})));
  const arms = {}, L1 = .3 * s, L2 = .3 * s, gap = .012 * s;
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1, type = k[`arm${side}`], limbMat = type === 'mech' ? metal : (k[`forearm${side}`] ? mat(k[`forearm${side}`], {roughness: .5, metalness: .5}) : skin);
    const sh = new THREE.Group(); sh.position.set(sx * .27 * s * w, .48 * s, 0); torso.add(sh);
    const el = new THREE.Group(); el.position.y = -L1; sh.add(el);
    const hand = new THREE.Object3D(); hand.position.y = -L2; el.add(hand);
    if (type === 'stump') {
      capsuleBetween(sh, .058 * s * w, -gap, -.16 * s, skin);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(.026 * s, 10, 8), new THREE.MeshBasicMaterial({color: '#ffb070'})); spark.position.y = -.17 * s; sh.add(spark);
    } else {
      capsuleBetween(sh, .058 * s * w, -gap - .02 * s, -L1 + gap, type === 'mech' ? metal : skin);
      capsuleBetween(el, .052 * s * w, -gap, -L2 + .01 * s, limbMat);
      if (type === 'mech') point(`mechLight_${side}`, sh, [sx * .055 * s, -.03 * s, -.045 * s], new THREE.Mesh(new THREE.SphereGeometry(.024 * s, 12, 10), new THREE.MeshStandardMaterial({color: '#330000', emissive: '#ff1a1a', emissiveIntensity: 0})));
      point(`fingers_${side}`, el, [0, -L2 - .02 * s, 0]);
    }
    point(`hand_${side}`, hand, [0, -.03 * s, 0]);
    arms[side] = {sh, el, hand, L1, L2: L2 + .03 * s, stump: type === 'stump'};
  }
  if (k.pistons) for (const sx of [-1, 1]) { const piston = new THREE.Mesh(new THREE.CylinderGeometry(.02 * s, .02 * s, .36 * s, 10), skin); piston.position.set(sx * .12 * s, .3 * s, tb.bd / 2 + .02 * s); piston.castShadow = true; torso.add(piston); }
  const legs = {};
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const hip = new THREE.Group(); hip.position.set(sx * .1 * s * w, 0, 0); body.add(hip);
    capsuleBetween(hip, .07 * s * w, -.03 * s, -.45 * s + gap, skin);
    const knee = new THREE.Group(); knee.position.y = -.45 * s; hip.add(knee);
    capsuleBetween(knee, .064 * s * w, -gap, -.5 * s, skin);
    point(`foot_${side}`, knee, [0, -.5 * s, -.05 * s]);
    legs[side] = {hip, knee};
  }
  root.add(labelSprite(actor)); scene.add(root);
  actors.set(actor.id, {actor, root, body, torso, neck, head, arms, legs, points: pts, s, gait: buildGait(actor), seed: [...actor.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7) * .0631});
}
function buildHumanoid(actor) { if (config.kinds[actor.kind].style === 'mannequin') buildMannequin(actor); else buildDummy(actor); if (config.world.figure === 'pill') makePill(actors.get(actor.id)); }
/* ───────── 简化胶囊白膜（world.figure: "pill"）─────────
   只换外形、不改动作：骨架、关节、IK、道具挂点全部照旧（四肢照样在算，只是不画）。
   画出来的是一颗球头 + 一条胶囊身体（与头同直径）；下蹲、坐下时身体沿「两脚中点 → 骨盆 → 胸 → 肩」弯折，
   走、跑、扑、弯腰、倒地时是一根直的胶囊（整体随重心前倾、倾倒），只有下蹲、坐下才弯曲；身体底端离地约 16 厘米，悬浮着。
   没有手脚和脸，给视频模型更大的表演空间。 */
const PILL_SEGS = 6;
function makePill(v) {
  if (!v) return;
  const k = config.kinds[v.actor.kind], s = k.scale, r = .14 * s * (k.width || 1);
  const keep = new Set(Object.values(v.points)), drop = [];
  v.root.traverse((o) => { if (o.isMesh && !keep.has(o)) drop.push(o); });
  for (const o of drop) { o.parent.remove(o); o.geometry?.dispose(); }
  const material = mat(k.body, {roughness: .85, metalness: 0}), group = new THREE.Group(); v.root.add(group);
  const add = (geo) => { const m = new THREE.Mesh(geo, material); m.castShadow = true; m.receiveShadow = true; group.add(m); return m; };
  const joints = Array.from({length: PILL_SEGS + 1}, () => add(new THREE.SphereGeometry(r, 24, 14)));
  const links = Array.from({length: PILL_SEGS}, () => add(new THREE.CylinderGeometry(r, r, 1, 24, 1, true)));
  const head = add(new THREE.SphereGeometry(r, 28, 18));
  const mark = (parent, y) => { const o = new THREE.Object3D(); o.position.y = y; parent.add(o); return o; };
  v.pill = {r, hover: .16 * s, joints, links, head, chest: mark(v.torso, .2 * s), top: mark(v.torso, .44 * s), skull: mark(v.head, .15 * s), curve: new THREE.CatmullRomCurve3([0, 1, 2, 3].map(() => new THREE.Vector3()), false, 'centripetal')};
}
const _pbase = new THREE.Vector3(), _pbase2 = new THREE.Vector3(), _pv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _pinv = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pq2 = new THREE.Quaternion(), _pup = new THREE.Vector3(0, 1, 0), _pd = new THREE.Vector3();
function updatePill(v) {
  const p = v.pill, [fl, fr, hip, chest, top] = _pv;
  v.points.foot_L.getWorldPosition(fl); v.points.foot_R.getWorldPosition(fr); v.body.getWorldPosition(hip); p.chest.getWorldPosition(chest); p.top.getWorldPosition(top);
  const mid = _pbase.copy(fl).add(fr).multiplyScalar(.5), minFoot = Math.min(fl.y, fr.y);
  const legUp = clamp((hip.y - mid.y) / Math.max(hip.distanceTo(mid), 1e-4), 0, 1), stand = smooth01(clamp((legUp - .45) / .35, 0, 1));
  const base = _pbase2.set(hip.x, minFoot, hip.z).lerp(mid, 1 - stand);                // 站着、走、跑：底端在骨盆正下方，不随迈步晃；躺下、坐下：底端在两脚中点
  base.addScaledVector(_pd.subVectors(hip, base).normalize(), p.r + p.hover);          // 再往骨盆方向收一个半径 + 悬浮高度
  const upright = Math.abs(_pd.subVectors(top, base).normalize().y);
  const floor = minFoot - .065 * v.s * (1 - upright) + p.r + p.hover;                  // 躺着时脚点在腿的中线上，地面要再低一个腿半径
  // 只有下蹲、坐下这类骨盆明显降低、上身还立着的动作才弯曲；走、跑、扑、弯腰、倒地都是一根直的胶囊
  const crouch = clamp((.8 * .95 * v.s - (hip.y - minFoot)) / (.35 * .95 * v.s), 0, 1);
  const torsoUp = clamp(_pd.subVectors(top, hip).normalize().y, 0, 1), bend = smooth01(crouch) * smooth01(clamp((torsoUp - .3) / .4, 0, 1));
  const pts = p.curve.points; pts[0].copy(base); pts[1].copy(hip); pts[2].copy(chest); pts[3].copy(top);
  for (const q of pts) q.y = Math.max(q.y, floor);                                    // 不陷进地面
  _pinv.copy(v.root.matrixWorld).invert(); v.root.getWorldQuaternion(_pq2).invert();
  const samples = p.joints.map((m, i) => { const u = i / PILL_SEGS, straight = pts[0].clone().lerp(pts[3], u); straight.y = Math.max(straight.y, floor); return bend > .001 ? straight.lerp(p.curve.getPoint(u), bend) : straight; });
  samples.forEach((w, i) => p.joints[i].position.copy(w).applyMatrix4(_pinv));
  for (let i = 0; i < PILL_SEGS; i++) {
    const a = samples[i], b = samples[i + 1], link = p.links[i], len = a.distanceTo(b);
    link.position.copy(a).add(b).multiplyScalar(.5).applyMatrix4(_pinv);
    _pq.setFromUnitVectors(_pup, _pd.subVectors(b, a).normalize()); link.quaternion.copy(_pq2).multiply(_pq);
    link.scale.set(1, Math.max(len, 1e-4), 1);
  }
  const end = samples[PILL_SEGS]; p.skull.getWorldPosition(_pd).sub(end);                // 头紧贴身体顶端：方向跟着脖子和头，距离固定（只留一条细缝）
  if (_pd.lengthSq() < 1e-8) _pd.set(0, 1, 0);
  p.head.position.copy(end).addScaledVector(_pd.normalize(), 2 * p.r + .012 * v.s).applyMatrix4(_pinv);
}
function buildMannequin(actor) {
  const k = config.kinds[actor.kind], s = k.scale, w = k.width, b = BUILDS[k.build] || BUILDS.neutral;
  const bodyMat = mat(k.body, {metalness: .05, roughness: .62}), pants = mat(k.pants, {metalness: 0, roughness: .78}), skin = mat(k.skin, {metalness: 0, roughness: .55}), hair = mat(k.hair, {metalness: 0, roughness: .7}), boots = mat(k.boots, {roughness: .55});
  const root = new THREE.Group(), body = new THREE.Group(); body.position.y = .95 * s; root.add(body);
  ball(body, .16 * s, [0, -.03 * s, 0], pants, [1.08 * w * b.hip, .6, .8]);
  const torso = new THREE.Group(); body.add(torso);
  const chest = new THREE.Mesh(torsoGeometry(k.build), bodyMat); chest.scale.set(1.42 * w * s, s, .78 * s); chest.castShadow = true; chest.receiveShadow = true; torso.add(chest);
  if (k.vest) { const vest = new THREE.Mesh(new THREE.CapsuleGeometry(.15, .12, 5, 18), mat(k.vest, {roughness: .8})); vest.scale.set(1.5 * w * b.shoulder * s, s, .86 * s); vest.position.y = .35 * s; vest.castShadow = true; torso.add(vest); }
  for (const sx of [-1, 1]) ball(torso, .068 * s * Math.max(w, .9), [sx * .25 * s * w * b.shoulder, .47 * s, 0], bodyMat);
  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(.045 * s, .056 * s, .12 * s, 14), skin); neckMesh.position.y = .55 * s; neckMesh.castShadow = true; torso.add(neckMesh);
  const neck = new THREE.Group(); neck.position.y = .55 * s; torso.add(neck);
  const head = new THREE.Group(); head.position.y = .03 * s; neck.add(head);
  ball(head, .12 * s, [0, .12 * s, 0], skin, [.94, 1.08, 1]);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(.124 * s, 22, 14, 0, Math.PI * 2, 0, Math.PI * .5), hair); cap.position.y = .135 * s; cap.rotation.x = .25; cap.scale.set(.96, 1.05, 1.02); head.add(cap);
  if (k.ponytail) { const tail = limb(head, .032 * s, .14 * s, [0, .07 * s, .14 * s], hair); tail.rotation.x = .35; }
  ball(head, .02 * s, [0, .105 * s, -.122 * s], skin, [1, 1.2, 1]); // 鼻子：标出面向
  box(head, [.085 * s, .016 * s, .012 * s], [0, .14 * s, -.11 * s], mat('#2a2a2a')); // 眉眼线
  const pts = {};
  const point = (name, parent, pos, obj = new THREE.Object3D()) => { obj.position.set(...pos); parent.add(obj); pts[name] = obj; points.set(`${actor.id}.${name}`, obj); return obj; };
  point('head', head, [0, .12 * s, 0]); point('chest_front', torso, [0, .32 * s, -.26 * s]); point('chest_back', torso, [0, .32 * s, .2 * s]);
  point('shoulder_L', torso, [-.24 * s * w, .48 * s, 0]); point('shoulder_R', torso, [.24 * s * w, .48 * s, 0]);
  point('shoulderInner_L', torso, [-.15 * s * w, .44 * s, -.13 * s]); point('shoulderInner_R', torso, [.15 * s * w, .44 * s, -.13 * s]);
  point('aim', torso, [.1 * s, .46 * s, -.06 * s]); point('hip', body, [0, 0, 0]);
  if (k.eye) point('eye', head, [(k.eye === 'L' ? -1 : 1) * .045 * s, .13 * s, -.11 * s], new THREE.Mesh(new THREE.SphereGeometry(.022 * s, 12, 10), new THREE.MeshStandardMaterial({color: '#200000', emissive: k.eyeColor, emissiveIntensity: 2.2})));
  const arms = {}, L1 = .3 * s, L2 = .3 * s;
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1, type = k[`arm${side}`], forearmMat = k[`forearm${side}`] ? mat(k[`forearm${side}`], {metalness: .6, roughness: .4}) : bodyMat;
    const sh = new THREE.Group(); sh.position.set(sx * .27 * s * w, .48 * s, 0); torso.add(sh);
    const el = new THREE.Group(); el.position.y = -L1; sh.add(el);
    const hand = new THREE.Object3D(); hand.position.y = -L2; el.add(hand);
    if (type === 'mech') {
      const g = mechArmParts(sh, s, k.metal);
      point(`mechLight_${side}`, sh, [sx * .06 * s, .02 * s, -.03 * s], new THREE.Mesh(new THREE.SphereGeometry(.028 * s, 12, 10), new THREE.MeshStandardMaterial({color: '#330000', emissive: '#ff1a1a', emissiveIntensity: 0})));
      ball(el, .05 * s, [0, 0, 0], g.dark);
      limb(el, .04 * s, .28 * s, [0, -.14 * s, 0], g.metal);
      mechHand(el, s, g, -L2 - .005 * s);
      point(`fingers_${side}`, el, [0, -L2 - .1 * s, -.01 * s]);
    } else if (type === 'stump') {
      limb(sh, .062 * s * w, .14 * s, [0, -.06 * s, 0], bodyMat);
      const capMesh = new THREE.Mesh(new THREE.CylinderGeometry(.064 * s, .056 * s, .04 * s, 14), mat('#3a2a22', {roughness: .9})); capMesh.position.y = -.15 * s; sh.add(capMesh);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(.028 * s, 10, 8), new THREE.MeshBasicMaterial({color: '#ffb070'})); spark.position.y = -.175 * s; sh.add(spark);
    } else {
      limb(sh, .052 * s * w, .3 * s, [0, -.15 * s, 0], bodyMat);
      ball(el, .046 * s * w, [0, 0, 0], forearmMat);
      limb(el, .044 * s * w, .28 * s, [0, -.14 * s, 0], forearmMat);
      ball(hand, .045 * s, [0, -.045 * s, 0], skin, [.8, 1.25, .55]);
      point(`fingers_${side}`, hand, [0, -.08 * s, 0]);
    }
    point(`hand_${side}`, hand, [0, -.03 * s, 0]);
    arms[side] = {sh, el, hand, L1, L2: L2 + .03 * s, stump: type === 'stump'};
  }
  if (k.pistons) for (const sx of [-1, 1]) { const piston = new THREE.Mesh(new THREE.CylinderGeometry(.03, .03, .5, 10), mat('#8d8a7a', {metalness: .8})); piston.position.set(sx * .17 * s, .3 * s, .15 * s); torso.add(piston); }
  const legs = {};
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const hip = new THREE.Group(); hip.position.set(sx * .1 * s * w, 0, 0); body.add(hip);
    limb(hip, .072 * s * w * b.hip, .45 * s, [0, -.225 * s, 0], pants);
    const knee = new THREE.Group(); knee.position.y = -.45 * s; hip.add(knee);
    ball(knee, .06 * s * w, [0, 0, 0], pants);
    limb(knee, .055 * s * w, .43 * s, [0, -.215 * s, 0], pants);
    const foot = limb(knee, .048 * s, .17 * s, [0, -.47 * s, -.055 * s], boots); foot.rotation.x = Math.PI / 2; foot.scale.set(1.05 * Math.max(w, .9), 1, .72);
    point(`foot_${side}`, knee, [0, -.5 * s, -.05 * s]);
    legs[side] = {hip, knee};
  }
  root.add(labelSprite(actor)); scene.add(root);
  actors.set(actor.id, {actor, root, body, torso, neck, head, arms, legs, points: pts, s, gait: buildGait(actor), seed: [...actor.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7) * .0631});
}

/* ───────── 道具库（options 可改颜色、尺寸、灯光）───────── */
const PROP_KINDS = {
  smgTorch(group, o, reg) { // 紧凑型冲锋枪 + 消音器 + 下挂战术手电（真实聚光灯）；params.trigger 0=护圈外 1=入扳机
    const metal = mat(o.color || '#1a1c1f', {metalness: .55, roughness: .45});
    box(group, [.07, .13, .42], [0, 0, -.25], metal); box(group, [.05, .16, .06], [0, -.12, -.2], metal); box(group, [.045, .14, .05], [0, -.12, -.32], metal);
    box(group, [.06, .06, .2], [0, 0, .05], metal); box(group, [.03, .04, .03], [0, .085, -.42], metal);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(.028, .028, .26, 12), metal); can.rotation.x = Math.PI / 2; can.position.set(0, .02, -.59); can.castShadow = true; group.add(can);
    const torch = new THREE.Mesh(new THREE.CylinderGeometry(.022, .022, .13, 12), metal); torch.rotation.x = Math.PI / 2; torch.position.set(0, -.05, -.48); group.add(torch);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(.02, 12), new THREE.MeshBasicMaterial({color: '#fff6e2'})); lens.position.set(0, -.05, -.546); lens.rotation.y = Math.PI; group.add(lens);
    const l = o.light || {}, angle = deg(l.angle ?? 17.2);
    if (l.enabled !== false) {
      const spot = new THREE.SpotLight(l.color || '#ffeed4', l.intensity ?? 55, l.distance ?? 16, angle, l.penumbra ?? .45, l.decay ?? 1.6); spot.position.set(0, -.05, -.55); spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -.0005; spot.shadow.camera.near = .05;
      const target = new THREE.Object3D(); target.position.set(0, -.05, -6); group.add(spot, target); spot.target = target;
      if (o.beam !== false) { const len = 5, geo = new THREE.ConeGeometry(Math.tan(angle) * len, len, 24, 1, true); geo.translate(0, -len / 2, 0);
        const beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color: l.color || '#ffe6c0', transparent: true, opacity: o.beamOpacity ?? .045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide})); beam.rotation.x = Math.PI / 2; beam.position.set(0, -.05, -.55); group.add(beam); }
    }
    const finger = box(group, [.022, .022, .08], [.05, -.04, -.27], mat('#2a2c30'));
    reg('grip', [.02, -.1, -.18]); reg('fore', [-.02, -.06, -.45]); reg('muzzle', [0, .02, -.72]);
    return {update(p) { const t = p.trigger ?? 0; finger.position.set(.05 - .012 * t, -.04 - .05 * t, -.27 + .07 * t); finger.rotation.x = -.9 * t; }};
  },
  curvedBlade(group, o, reg) { // 弯刀：沿手的 -Y 伸出，刃口向前弯
    const metal = mat(o.color || '#d8a637', {metalness: .95, roughness: .22}), grip = mat(o.gripColor || '#2a1a10', {roughness: .8});
    box(group, [.035, .13, .035], [0, -.03, 0], grip); box(group, [.11, .02, .05], [0, -.1, 0], metal);
    const curve = o.curve ?? .45, length = o.length ?? .24;
    for (let i = 0; i < 7; i++) { const t = i / 6, a = t * curve; const seg = box(group, [.012, .08, .05 - t * .03], [0, -.14 - Math.sin(a) * length - t * .05, -(1 - Math.cos(a)) * length], metal); seg.rotation.x = a; }
    reg('tip', [0, -.14 - Math.sin(curve) * length - .05, -(1 - Math.cos(curve)) * length]);
  },
  gearMace(group, o, reg) { // 齿轮武器：手柄 + 齿轮头
    const iron = mat(o.color || '#7d7466', {metalness: .8, roughness: .4}), dark = mat('#3b3732', {metalness: .6, roughness: .5});
    box(group, [.05, .55, .05], [0, -.25, 0], dark);
    const head = new THREE.Group(); head.position.y = -.6; group.add(head);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(.24, .24, .07, 24), iron); disc.rotation.z = Math.PI / 2; disc.castShadow = true; head.add(disc);
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; const tooth = box(head, [.07, .1, .06], [0, Math.cos(a) * .28, Math.sin(a) * .28], iron); tooth.rotation.x = -a; }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.07, .07, .1, 12), dark); hub.rotation.z = Math.PI / 2; head.add(hub);
    reg('head', [0, -.6, 0]);
  },
  detachedArm(group, o) { // 脱开的机械臂（与人偶机械臂同款）
    const s = o.scale ?? .95, g = mechArmParts(group, s, o.color || '#9aa4ae');
    ball(group, .05 * s, [0, -.3 * s, 0], g.dark); limb(group, .04 * s, .28 * s, [0, -.44 * s, 0], g.metal); mechHand(group, s, g, -.605 * s);
  },
  box(group, o, reg) { const size = o.size || [.2, .2, .2]; box(group, size, [0, -size[1] / 2, 0], mat(o.color || '#6c7a86', {metalness: o.metalness ?? .3})); if (o.accent) box(group, [size[0] * .7, .03, size[2] * .5], [0, .01, 0], mat(o.accent, {emissive: o.accent, emissiveIntensity: .4})); reg('center', [0, -size[1] / 2, 0]); },
  phone(group, o, reg) { // 手机：屏幕朝 -Z；params.screen 0–1 控制屏幕亮度
    box(group, [.072, .15, .009], [0, -.075, 0], mat(o.color || '#1b1d21', {metalness: .4, roughness: .35}));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(.064, .136), new THREE.MeshStandardMaterial({color: '#0a0c10', emissive: o.screen || '#cfe6ff', emissiveIntensity: 1.4}));
    screen.position.set(0, -.075, -.0047); screen.rotation.y = Math.PI; group.add(screen); reg('screen', [0, -.075, -.006]);
    return {update(p) { screen.material.emissiveIntensity = 1.4 * clamp(p.screen ?? 1, 0, 1); }};
  },
  rod(group, o, reg) { const length = o.length ?? .45, r = o.radius ?? .05; const rod = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length, 12), mat(o.color || '#a3e86b', {metalness: .4})); rod.position.y = -length / 2 + .1; rod.castShadow = true; group.add(rod);
    if (o.tip) { const tip = new THREE.Mesh(new THREE.SphereGeometry(r * 1.2, 12, 8), mat('#f5ffd6', {emissive: o.tip, emissiveIntensity: .6})); tip.position.y = .12; group.add(tip); } reg('tip', [0, .12, 0]); },
};
const GRIP_DEFAULTS = {phone: {p: [0, .02, -.01], r: [0, 0, 0]}, smgTorch: {p: [0, 0, 0], r: [0, 0, 0]}, curvedBlade: {p: [0, -.02, 0], r: [0, 0, 0]}, gearMace: {p: [0, .05, 0], r: [0, 0, 0]}, detachedArm: {p: [-.22, .02, -.02], r: [0, 0, 101.5]}, box: {p: [0, -.02, 0], r: [0, 0, 0]}, rod: {p: [0, -.05, 0], r: [0, 0, 0]}};
function buildProp(prop) {
  const group = new THREE.Group(); group.name = `prop:${prop.id}`; group.userData.owner = prop.owner;
  const reg = (name, pos) => { const o = new THREE.Object3D(); o.position.set(...pos); group.add(o); points.set(`${prop.id}.${name}`, o); };
  const builder = PROP_KINDS[prop.kind] || ext.propKinds[prop.kind]?.build;
  const handle = builder(group, prop.options, reg, api) || {};
  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const grip = prop.options.grip || ext.propKinds[prop.kind]?.grip || GRIP_DEFAULTS[prop.kind] || {p: [0, 0, 0], r: [0, 0, 0]};
  scene.add(group); props.set(prop.id, {prop, group, holder: null, handle, grip});
}
function resolvePoint(value) { return points.get(value) || null; }

/* ───────── 采样 ───────── */
function interval(keys, t) {
  if (t <= keys[0].time) return [keys[0], keys[0], 0];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i].time) return [keys[i - 1], keys[i], (t - keys[i - 1].time) / (keys[i].time - keys[i - 1].time)];
  return [keys.at(-1), keys.at(-1), 0];
}
/* ───────── 平滑运动 ─────────
   关键帧之间默认用保形三次曲线：经过关键帧时速度连续、不过冲，停顿前后自然缓入缓出。
   相邻关键帧间隔小于 1 帧视为硬切瞬移，不做平滑。关键帧可写 ease："linear"（这一段匀速）或 "hold"（这一段定格到下一帧）。
   姿态切换带先后：躯干先到位，手臂晚 0.05 秒，头晚 0.08 秒。 */
const CUT_GAP = .034, EASES = ['smooth', 'linear', 'hold'];
const POSE_LAG = {core: 0, arms: .05, head: .08};
const POSE_REGION = {drop: 'core', spine: 'core', hipL: 'core', kneeL: 'core', hipR: 'core', kneeR: 'core', shL: 'arms', elL: 'arms', shR: 'arms', elR: 'arms', neck: 'head', neckYaw: 'head'};
const smooth01 = (x) => x * x * (3 - 2 * x);
const tangentCache = new WeakMap();
function tangents(keys, field, fallback) {
  let per = tangentCache.get(keys); if (!per) tangentCache.set(keys, per = new Map());
  if (per.has(field)) return per.get(field);
  const vals = keys.map((k) => { const v = k[field] ?? fallback; return Array.isArray(v) ? v : [v]; });
  const n = keys.length, dims = vals[0].length, m = keys.map(() => new Array(dims).fill(0)), h = [], cut = [];
  for (let i = 0; i < n - 1; i++) { h[i] = keys[i + 1].time - keys[i].time; cut[i] = h[i] < CUT_GAP || (keys[i].ease && keys[i].ease !== 'smooth'); }
  for (let d = 0; d < dims; d++) {
    const slope = h.map((hi, i) => (vals[i + 1][d] - vals[i][d]) / Math.max(hi, 1e-6));
    for (let i = 0; i < n; i++) {
      const L = i > 0 && !cut[i - 1] ? slope[i - 1] : null, R = i < n - 1 && !cut[i] ? slope[i] : null;
      if (L === null || R === null) m[i][d] = L ?? R ?? 0;
      else if (L * R <= 0) m[i][d] = 0;
      else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i][d] = (w1 + w2) / (w1 / L + w2 / R); }
    }
  }
  per.set(field, m); return m;
}
function smoothSample(keys, t, field, fallback) {
  const read = (k) => k[field] ?? fallback;
  if (keys.length === 1 || t <= keys[0].time) return read(keys[0]);
  if (t >= keys.at(-1).time) return read(keys.at(-1));
  let i = 0; while (i < keys.length - 2 && t > keys[i + 1].time) i++;
  const a = keys[i], b = keys[i + 1], va = read(a), vb = read(b), h = b.time - a.time, u = (t - a.time) / h;
  if (a.ease === 'hold') return va;
  const arr = Array.isArray(va), A = arr ? va : [va], B = arr ? vb : [vb];
  let out;
  if (h < CUT_GAP || a.ease === 'linear') out = A.map((n, d) => lerp(n, B[d], u));
  else {
    const m = tangents(keys, field, fallback), u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out = A.map((n, d) => h00 * n + h10 * h * m[i][d] + h01 * B[d] + h11 * h * m[i + 1][d]);
  }
  return arr ? out : out[0];
}
function blendPose(keys, t) {
  const [a, b, r] = interval(keys, Math.max(0, t));
  const e = a.pose === b.pose || a.ease === 'hold' ? 0 : a.ease === 'linear' || b.time - a.time < CUT_GAP ? r : smooth01(r);
  return [POSES[a.pose], POSES[b.pose], e];
}
function sampleActor(keys, t) {
  const [a, b, r] = interval(keys, t);
  const out = {position: smoothSample(keys, t, 'position'), yaw: smoothSample(keys, t, 'yaw', 0)};
  for (const [field] of ACTOR_FIELDS) if (!field.startsWith('arm')) out[field] = smoothSample(keys, t, field, field === 'life' ? 1 : 0);
  out.armL = (r < 1 ? a.armL : b.armL) ?? 1; out.armR = (r < 1 ? a.armR : b.armR) ?? 1;
  let lastCut = 0; for (let i = 0; i < keys.length - 1 && keys[i + 1].time <= t; i++) if (keys[i + 1].time - keys[i].time < CUT_GAP) lastCut = keys[i + 1].time;
  const blends = {}; for (const [region, lag] of Object.entries(POSE_LAG)) blends[region] = blendPose(keys, Math.max(lastCut, t - lag));
  out.pose = {};
  for (const key of POSE_KEYS) { const [pa, pb, e] = blends[POSE_REGION[key]]; out.pose[key] = Array.isArray(pa[key]) ? pa[key].map((n, i) => lerp(n, pb[key][i], e)) : lerp(pa[key], pb[key], e); }
  out.poseName = r < .5 ? a.pose : b.pose; out.poseChanging = a.pose !== b.pose && r > 0 && r < 1;
  // 关节微调（第四期）：关键帧上的 adjust 是相对姿态库的偏移，前后关键帧之间平滑过渡；在动作捕捉片段上同样生效
  if (a.adjust || b.adjust) { const e = a.ease === 'hold' ? 0 : a.ease === 'linear' || b.time - a.time < CUT_GAP ? r : smooth01(r); out.adjust = {};
    for (const k of POSE_KEYS) { const va = a.adjust?.[k] ?? (Array.isArray(STAND[k]) ? [0, 0] : 0), vb = b.adjust?.[k] ?? (Array.isArray(STAND[k]) ? [0, 0] : 0); out.adjust[k] = Array.isArray(va) ? va.map((n, i) => lerp(n, vb[i], e)) : lerp(va, vb, e); } }
  for (const side of ['reachL', 'reachR']) {
    const target = a[side]?.target || b[side]?.target;
    out[side] = target ? {target, w: lerp(a[side]?.w ?? 0, b[side]?.w ?? 0, smooth01(r))} : null;
    if (target === 'world') { const wa = a[side]?.target === 'world' ? a[side] : b[side], wb = b[side]?.target === 'world' ? b[side] : wa; out[side].pos = wa.pos.map((n, i) => lerp(n, wb.pos[i], r)); } // 前后目标不同（固定位置 ↔ 身体部位）时，只用固定位置那一帧的坐标
  }
  return out;
}
function sampleValue(keys, t, field) { return smoothSample(keys, t, field, 0); }
/* 走路节奏按实际走过的水平距离累计（不按时间），所以快走步子大、慢走步子小、停下就停步，脚不打滑 */
/* 走位路线（站位 + 朝向）。完全覆盖（clip.override = "all"）的片段：片段期间停在起点那一刻的位置朝向；片段结束后按正常步速（约 1.3 米/秒，至少 0.5 秒）
   走回原关键帧路线再接上，不会一下子滑回去。步态（迈步节奏）也按这条路线算，所以走回去时腿会迈步。原关键帧数据不改。 */
function actorPath(actor, t) {
  const keys = actor.keyframes; let position = smoothSample(keys, t, 'position'), yaw = smoothSample(keys, t, 'yaw', 0), walking = 0;
  for (const c of actor.clips || []) {
    if (c.override !== 'all' || !motions.get(c.motion)) continue;
    const [s, e0] = clipWindow(c), e = c.hold ? config.duration : e0; if (t < s) continue;
    const p0 = smoothSample(keys, s, 'position'), y0 = smoothSample(keys, s, 'yaw', 0);
    if (t <= e) { position = p0; yaw = y0; continue; }
    const pe = smoothSample(keys, e, 'position'), back = Math.max(.5, Math.hypot(pe[0] - p0[0], pe[2] - p0[2]) / 1.3);
    if (t < e + back) { const x = (t - e) / back, u = smooth01(x); position = position.map((v, i) => p0[i] + (v - p0[i]) * u); yaw = y0 + Math.atan2(Math.sin(yaw - y0), Math.cos(yaw - y0)) * u; walking = Math.max(walking, Math.min(1, x * 5, (1 - x) * 5)); }
  }
  return {position, yaw, walking};
}
function buildGait(actor) {
  const dt = 1 / 60, n = Math.ceil(config.duration / dt) + 1, s = config.kinds[actor.kind].scale;
  const raw = new Float32Array(n), speed = new Float32Array(n), phase = new Float32Array(n);
  let prev = actorPath(actor, 0).position;
  for (let i = 1; i < n; i++) { const p = actorPath(actor, Math.min(config.duration, i * dt)).position; let ds = Math.hypot(p[0] - prev[0], p[2] - prev[2]); if (ds > .3) ds = 0; raw[i] = ds / dt; prev = p; }
  for (let i = 0; i < n; i++) { let sum = 0, c = 0; for (let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 6); j++) { sum += raw[j]; c++; } speed[i] = sum / c; }
  for (let i = 1; i < n; i++) phase[i] = phase[i - 1] + raw[i] * dt / (s * (1.35 + .55 * clamp((speed[i] - 1.6) / 3, 0, 1))) * Math.PI * 2;
  return {phase, speed, dt};
}
function gaitAt(g, t) { const x = clamp(t / g.dt, 0, g.phase.length - 1), i = Math.floor(x), j = Math.min(i + 1, g.phase.length - 1), f = x - i; return [lerp(g.phase[i], g.phase[j], f), lerp(g.speed[i], g.speed[j], f)]; }
function shotAt(t) { return config.shots.find((shot) => t < shot.end - 1e-7) || config.shots.at(-1); }

const DOWN = new THREE.Vector3(0, -1, 0), tA = new THREE.Vector3(), tB = new THREE.Vector3(), mtx = new THREE.Matrix4(), qtmp = new THREE.Quaternion();
/* 平滑的伪随机波动：几组不成整数比的正弦叠加，按时间确定、可重复 */
function wobble(t, seed, k) { return Math.sin(t * (.73 + .19 * k) + seed * 1.7 + k * 2.1) * .6 + Math.sin(t * (1.61 + .23 * k) + seed * .9 + k * 4.3) * .4; }
function applyPose(v, sample) {
  const {root, body, torso, neck, arms, legs, s} = v, p = sample.pose, c = sample.crouch;
  const hipAdd = .9 * c, kneeAdd = -1.6 * c, crouchDrop = .45 * (2 - Math.cos(hipAdd) - Math.cos(hipAdd + kneeAdd));
  const [ph, spd] = gaitAt(v.gait, currentTime), sw = Math.sin(ph), cw = Math.cos(ph);
  const amp = sample.gait * (spd < .05 ? 0 : clamp(.45 + spd * .35, .45, 1.3));
  // 静止时的呼吸、重心微晃和轻微转头；走动、换姿态、翻滚时自动减弱
  const still = clamp(1 - spd / .5, 0, 1) * (sample.poseChanging ? .35 : 1) * (Math.abs(sample.pitch) > .3 ? .2 : 1) * clamp(sample.life ?? 1, 0, 1);
  const tt = currentTime + v.seed, breath = Math.sin(tt * 1.85) * still, sway = Math.sin(tt * 1.23) * still, glance = Math.sin(tt * .86 + 1.3) * still;
  // 全身持续微动（任何时候都有，幅度很小）：让角色永远不是“定格”的，参照专业白膜预演的运动质感
  const keyLife = sample.life, life = (config.kinds[v.actor.kind].life ?? 1) * keyLife * (Math.abs(sample.pitch) > .3 ? .3 : 1), wb = (k) => life * wobble(tt, v.seed, k);
  root.position.set(...sample.position); root.rotation.y = sample.yaw;
  body.position.y = (.95 - p.drop - crouchDrop) * s - .028 * amp * s * (1 - Math.cos(2 * ph)) / 2;
  body.rotation.set(sample.pitch, -.07 * amp * sw, sample.roll + .05 * amp * sw + .012 * sway + .008 * wb(14));
  torso.rotation.set(-(p.spine + .2 * c) - .012 * breath + .018 * wb(1), .15 * amp * sw + .02 * wb(3), .015 * wb(2));
  neck.rotation.set(-p.neck + sample.look + .008 * breath + .02 * wb(4), p.neckYaw + .035 * glance - .15 * amp * sw + .03 * wb(5), 0);
  if (v.points.aim) v.points.aim.rotation.x = sample.aim;
  const set = (arm, sh, el, sx, swing, bend, k) => { arm.sh.rotation.set(sh[0] + swing + .015 * breath + .035 * wb(k), 0, sx * sh[1] + .02 * wb(k + 2)); arm.el.rotation.set(el + bend + .04 * wb(k + 4), 0, 0); };
  set(arms.L, p.shL, p.elL, -1, -.5 * amp * sw, .18 * amp * Math.max(0, -sw), 6);
  set(arms.R, p.shR, p.elR, 1, .5 * amp * sw, .18 * amp * Math.max(0, sw), 7);
  legs.L.hip.rotation.x = p.hipL + hipAdd + .42 * amp * sw + .012 * wb(12); legs.L.knee.rotation.x = p.kneeL + kneeAdd - amp * (.06 + .8 * Math.max(0, cw)) - .015 * life * (1 + wobble(tt, v.seed, 15)) / 2;
  legs.R.hip.rotation.x = p.hipR + hipAdd - .42 * amp * sw + .012 * wb(13); legs.R.knee.rotation.x = p.kneeR + kneeAdd - amp * (.06 + .8 * Math.max(0, -cw)) - .015 * life * (1 + wobble(tt, v.seed, 16)) / 2;
  arms.L.sh.visible = sample.armL >= .5; arms.R.sh.visible = sample.armR >= .5;
}
function applyAdjust(v, a) { // 关节微调叠加在姿态 / 动作片段之上（方向与姿态库字段一致）
  v.body.position.y -= (a.drop || 0) * v.s;
  v.torso.rotation.x -= a.spine || 0; v.neck.rotation.x -= a.neck || 0; v.neck.rotation.y += a.neckYaw || 0;
  for (const [side, sx] of [['L', -1], ['R', 1]]) {
    const arm = v.arms[side], sh = a[`sh${side}`]; if (sh) { arm.sh.rotation.x += sh[0]; arm.sh.rotation.z += sx * sh[1]; }
    arm.el.rotation.x += a[`el${side}`] || 0;
    v.legs[side].hip.rotation.x += a[`hip${side}`] || 0; v.legs[side].knee.rotation.x += a[`knee${side}`] || 0;
  }
}
/* 两骨 IK：让手到达目标点（扣腕 / 箍抱 / 拍肩 / 双手持枪），按权重与姿态混合 */
function solveArm(v, side, targetWorld, weight) {
  const arm = v.arms[side]; if (arm.stump || weight <= 0) return;
  const parent = arm.sh.parent; parent.updateMatrixWorld(true);
  const T = parent.worldToLocal(targetWorld.clone()), S = arm.sh.position.clone(), toT = T.clone().sub(S);
  const L1 = arm.L1, L2 = arm.L2, d = clamp(toT.length(), .05, L1 + L2 - 1e-4), dir = toT.normalize();
  const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const bend = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  const pole = new THREE.Vector3(side === 'L' ? -.5 : .5, -.6, .6).normalize();
  const perp = pole.clone().addScaledVector(dir, -pole.dot(dir)); if (perp.lengthSq() < 1e-6) perp.set(0, 0, 1); perp.normalize();
  const upper = dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(perp, Math.sin(a));
  const target = S.clone().addScaledVector(dir, d), elbow = S.clone().addScaledVector(upper, L1), fore = target.sub(elbow).normalize();
  const yAxis = upper.clone().negate(), fp = fore.clone().addScaledVector(upper, -fore.dot(upper));
  if (fp.lengthSq() < 1e-8) fp.copy(perp).negate(); fp.normalize();
  const zAxis = fp.negate(), xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  qtmp.setFromRotationMatrix(mtx.makeBasis(xAxis, yAxis, zAxis));
  arm.sh.quaternion.slerp(qtmp, weight); arm.el.rotation.x = lerp(arm.el.rotation.x, bend, weight);
}
function placeProps(t) {
  for (const item of props.values()) {
    const {prop, group} = item;
    let key = prop.keyframes[0], next = null;
    for (let i = 0; i < prop.keyframes.length; i++) if (prop.keyframes[i].time <= t + 1e-7) { key = prop.keyframes[i]; next = prop.keyframes[i + 1] || null; }
    const withParams = prop.keyframes.filter((k) => k.params);
    if (item.handle.update && withParams.length) {
      const [a, b, r] = interval(withParams, t), params = {};
      for (const name of new Set([...Object.keys(a.params), ...Object.keys(b.params)])) params[name] = lerp(a.params[name] ?? b.params[name], b.params[name] ?? a.params[name], r);
      item.handle.update(params);
    }
    if (key.holder === 'hidden') { group.visible = false; item.holder = 'hidden'; continue; }
    group.visible = config.world.figure !== 'pill';   // 简化胶囊白膜不画道具（挂点照常计算，手部接触不受影响）
    if (key.holder === 'world') {
      if (item.holder !== 'world') { scene.add(group); item.holder = 'world'; }
      let pos = key.position, rot = key.rotation;
      if (next?.holder === 'world') { const r = (t - key.time) / (next.time - key.time); pos = pos.map((n, i) => lerp(n, next.position[i], r)); rot = rot.map((n, i) => lerp(n, next.rotation[i], r)); }
      group.position.set(...pos); group.rotation.set(...rot.map(deg));
    } else {
      const point = resolvePoint(key.holder);
      if (point && item.holder !== key.holder) { point.add(group); item.holder = key.holder; }
      group.position.set(...item.grip.p); group.rotation.set(...item.grip.r.map(deg));
    }
  }
}
function applyRigs(t) { for (const rig of config.rigs) { const value = sampleValue(rig.keyframes, t, 'value'); for (const b of rigBindings.get(rig.id) || []) { const v = value * b.scale + b.offset; if (b.mode === 'translate') b.obj.position[b.axis] = b.base + v; else b.obj.rotation[b.axis] = b.base + deg(v); } } }

/* ───────── 特效：钢索 / 发光闪烁 / 电火花 / 灰尘 ───────── */
const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
function seeded(seed) { let s = Math.max(1, Math.floor(seed)); return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const FX_BUILDERS = {
  cables(cfg) {
    const lines = cfg.anchors.map(() => { const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({color: cfg.color || '#e8eef5'})); fxGroup.add(line); return line; });
    const heads = cfg.anchors.map(() => { const head = new THREE.Mesh(new THREE.ConeGeometry(.04, .14, 8), mat('#dfe5ea', {metalness: .9, roughness: .25})); fxGroup.add(head); return head; });
    for (const a of cfg.anchors) { const plate = box(fxGroup, [.16, .08, .16], [a[0], a[1] + .04, a[2]], mat('#c9cdd2', {metalness: .9, roughness: .3})); plate.castShadow = false; }
    return {state: () => lines[0].visible, update(t) {
      const src = resolvePoint(cfg.source), on = src && t >= cfg.fire && t < cfg.released;
      lines.forEach((line, i) => {
        line.visible = heads[i].visible = Boolean(on); if (!on) return;
        src.getWorldPosition(tA); tA.x += (i - (lines.length - 1) / 2) * .02;
        const anchor = tB.set(...cfg.anchors[i]);
        const tip = t < cfg.anchored ? tA.clone().lerp(anchor, ease((t - cfg.fire) / (cfg.anchored - cfg.fire))) : t < cfg.release ? anchor.clone() : anchor.clone().lerp(tA, ease((t - cfg.release) / (cfg.released - cfg.release)));
        line.geometry.setFromPoints([tA.clone(), tip]); heads[i].position.copy(tip); heads[i].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(tA).normalize());
      });
    }};
  },
  glow(cfg) { // 目标本身是发光体（义眼、机械臂红灯）就直接控制它；否则在目标上加一个发光小球
    const target = resolvePoint(cfg.target);
    let mesh = target?.isMesh && target.material?.emissive ? target : null;
    if (!mesh && target) { mesh = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius ?? .03, 12, 8), new THREE.MeshStandardMaterial({color: '#111111', emissive: cfg.color || '#ff2020', emissiveIntensity: 0})); target.add(mesh); }
    if (mesh && cfg.color) mesh.material.emissive.set(cfg.color);
    let light = null;   // lightIntensity：同时点亮一盏真实点光源（布景灯全亮、开关灯照亮周围）
    if (target && cfg.lightIntensity) { light = new THREE.PointLight(cfg.color || '#ffffff', 0, cfg.lightDistance ?? 8, cfg.lightDecay ?? 1.5); target.add(light); }
    return {state: () => mesh?.material.emissiveIntensity > 0, update(t) {
      if (!mesh) return;
      const win = (cfg.windows || []).find(([a, b]) => t >= a && t < b);
      const on = win && (!cfg.rate || Math.floor((t - win[0]) * cfg.rate * 2) % 2 === 0);
      mesh.material.emissiveIntensity = on ? (cfg.intensity ?? 3) : (cfg.offIntensity ?? 0);
      if (light) light.intensity = on ? cfg.lightIntensity : (cfg.offLightIntensity ?? 0);
    }};
  },
  sparks(cfg) {
    const rand = seeded(cfg.seed ?? 11), count = cfg.count ?? 90;
    const seeds = Array.from({length: count}, () => [new THREE.Vector3(rand() - .5, rand() * .8 - .2, rand() - .5).normalize(), .6 + rand() * 1.6, rand() * .25]);
    const cloud = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3)), new THREE.PointsMaterial({color: cfg.color || '#1f7dff', size: cfg.size ?? .02, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}));
    const light = new THREE.PointLight(cfg.color || '#5fc0ff', 0, 3, 2); fxGroup.add(cloud, light);
    return {state: () => cloud.visible, update(t) {
      const origin = resolvePoint(cfg.target), active = origin && t >= cfg.start && t < cfg.end;
      cloud.visible = Boolean(active); light.intensity = 0; if (!active) return;
      origin.getWorldPosition(tA); const arr = cloud.geometry.attributes.position.array, age = t - cfg.start;
      seeds.forEach(([dir, speed, delay], i) => { const local = Math.max(0, age - delay) % .3; const p = tA.clone().addScaledVector(dir, speed * local * .8); p.y -= 2 * local * local; arr.set([p.x, p.y, p.z], i * 3); });
      cloud.geometry.attributes.position.needsUpdate = true; light.position.copy(tA); light.intensity = (cfg.lightIntensity ?? 6) + 4 * Math.sin(t * 90);
    }};
  },
  dust(cfg) {
    const rand = seeded(cfg.seed ?? 7), count = cfg.count ?? 2000, min = cfg.min || [-5, .1, -5], max = cfg.max || [5, 3, 5], arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) arr[i * 3 + k] = min[k] + rand() * (max[k] - min[k]);
    fxGroup.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(arr, 3)), new THREE.PointsMaterial({color: cfg.color || '#fff2d8', size: cfg.size ?? .012, transparent: true, opacity: cfg.opacity ?? .55, blending: THREE.AdditiveBlending, depthWrite: false})));
    return {state: () => true, update() {}};
  },
};
function buildFx() {
  if (fxGroup) { disposeGroup(fxGroup); scene.remove(fxGroup); }
  fxGroup = new THREE.Group(); scene.add(fxGroup);
  fxItems = config.fx.map((cfg) => ({cfg, ...(FX_BUILDERS[cfg.type] || ext.fx[cfg.type])(cfg, api)}));
}
function checkRefs() {
  const missing = [];
  const check = (value) => { if (value && value !== 'world' && !resolvePoint(value)) missing.push(value); };
  for (const actor of config.actors) for (const key of actor.keyframes) { if (key.reachL) check(key.reachL.target); if (key.reachR) check(key.reachR.target); }
  for (const prop of config.props) for (const key of prop.keyframes) if (REF.test(key.holder)) check(key.holder);
  for (const fx of config.fx) { check(fx.source); check(fx.target); }
  if (missing.length) throw new Error(`这些部位不存在：${[...new Set(missing)].join('、')}。人物部位有 hand_L/R、fingers_L/R、shoulder_L/R、shoulderInner_L/R、chest_front、chest_back、head、aim、hip、foot_L/R，机械臂还有 mechLight_L/R，有 eye 的体型才有 eye`);
}

function setHelperVisibility() { const visible = $('helpers').checked; scene.traverse((object) => { if (object.userData.helper) object.visible = visible; }); }
/* ───────── 动作捕捉片段（FBX）─────────
   scene.json 的 motions 列出动作文件，角色的 clips 指定“第几秒开始播哪段、从片段第几秒起、速度、淡入淡出”。
   支持 Mixamo 骨骼命名（以及同名或常见别名的 FBX，例如手机视频转动作工具导出的 Mixamo / Humanoid 骨骼）。
   映射方式：骨盆、胸腔、头用“相对绑定姿态的旋转变化”，四肢用“骨段方向对齐”（胶囊四肢没有扭转问题），
   所以源角色是 T 字形还是 A 字形都能对上。片段之后照常叠加 IK 接触（握枪、扣腕、箍抱仍然贴合）。 */
const motions = new Map(); let missingMotions = [];
let FBXLoaderClass = null;
const MOTION_BONES = {
  hips: ['hips', 'pelvis', 'hip'], chest: ['spine2', 'upperchest', 'chest', 'spine1', 'spine'], head: ['head'],
  armL: ['leftarm', 'leftupperarm', 'lupperarm'], foreL: ['leftforearm', 'leftlowerarm', 'lforearm'], handL: ['lefthand', 'lhand'],
  armR: ['rightarm', 'rightupperarm', 'rupperarm'], foreR: ['rightforearm', 'rightlowerarm', 'rforearm'], handR: ['righthand', 'rhand'],
  thighL: ['leftupleg', 'leftupperleg', 'leftthigh', 'lthigh'], shinL: ['leftleg', 'leftlowerleg', 'leftshin', 'lcalf'], footL: ['leftfoot', 'lfoot'],
  thighR: ['rightupleg', 'rightupperleg', 'rightthigh', 'rthigh'], shinR: ['rightleg', 'rightlowerleg', 'rightshin', 'rcalf'], footR: ['rightfoot', 'rfoot'],
};
const REQUIRED_BONES = ['hips', 'chest', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
const boneKey = (name) => name.toLowerCase().replace(/^.*?mixamorig\d*/, '').replace(/[^a-z0-9]/g, '').replace(/^(bip01|armature|character1|skeleton)/, '');
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // 源角色面向 +Z，我们的角色面向 -Z
async function loadMotions(list) {
  missingMotions = [];
  for (const m of list) {
    if (m.data) { if (motions.get(m.id)?.data !== m.data) motions.set(m.id, buildPoseMotion(m.data, 'data')); continue; } // 数据对象换了就重建（很快），改了离地高度等也能生效
    const sig = `${m.file}#${m.clip}`;
    if (motions.get(m.id)?.sig === sig) continue;
    if (!FBXLoaderClass) FBXLoaderClass = (await import('./vendor/addons/loaders/FBXLoader.js')).FBXLoader;
    let root;
    try { root = await new FBXLoaderClass().loadAsync(m.file); }
    catch (error) { motions.delete(m.id); missingMotions.push(`${m.id}（${m.file}）`); console.warn(`动作 ${m.id} 未加载：${error.message || error}`); continue; }
    const clip = typeof m.clip === 'string' ? root.animations.find((a) => a.name === m.clip) : root.animations[m.clip];
    if (!clip) throw new Error(`动作 ${m.id}：文件里没有动画片段 ${m.clip}（共有 ${root.animations.length} 段：${root.animations.map((a) => a.name).join('、') || '无'}）`);
    const byKey = new Map(); root.traverse((o) => { if (o.isBone || o.type === 'Bone') { const key = boneKey(o.name); if (!byKey.has(key)) byKey.set(key, o); } });
    const bones = {}; for (const [k, aliases] of Object.entries(MOTION_BONES)) bones[k] = aliases.map((a) => byKey.get(a)).find(Boolean) || null;
    const missing = REQUIRED_BONES.filter((k) => !bones[k]);
    if (missing.length) throw new Error(`动作 ${m.id}：骨骼对不上，缺 ${missing.join('、')}。请导出 Mixamo 命名的骨骼（文件里的骨骼：${[...byKey.keys()].slice(0, 12).join('、')}…）`);
    root.updateMatrixWorld(true);
    const skinned = []; root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
    const rest = {};
    for (const [k, b] of Object.entries(bones)) {
      if (!b) continue;
      let mw = b.matrixWorld.clone();
      for (const sm of skinned) { const i = sm.skeleton.bones.indexOf(b); if (i >= 0) { mw = sm.bindMatrix.clone().multiply(sm.skeleton.boneInverses[i].clone().invert()); break; } }
      const p = new THREE.Vector3(), q = new THREE.Quaternion(); mw.decompose(p, q, new THREE.Vector3()); rest[k] = {p, q};
    }
    const mixer = new THREE.AnimationMixer(root); mixer.clipAction(clip).play();
    const legLen = rest.hips.p.y - Math.min(rest.footL.p.y, rest.footR.p.y);
    motions.set(m.id, {sig, root, clip, mixer, bones, rest, duration: clip.duration, legLen: legLen > 1e-6 ? legLen : 1});
  }
}
/* 视频动捕数据（zpboom-pose）：每帧 15 个关键点，已换成“Y 向上、面向 +Z、左手在 +X”的源空间（和 Mixamo 一致），以胯中心为原点。
   骨盆 / 胸腔 / 头的朝向由关键点算出（站直面向镜头 = 不旋转），四肢直接用关键点位置，走同一套映射。 */
const POSE_PTS = ['nose', 'earL', 'earR', 'shL', 'shR', 'elL', 'elR', 'wrL', 'wrR', 'hipL', 'hipR', 'knL', 'knR', 'anL', 'anR'];
function buildPoseMotion(d, sig) {
  const idx = Object.fromEntries(d.points.map((n, i) => [n, i])), hipsY = d.frames.map((f) => (f[idx.hipL * 3 + 1] + f[idx.hipR * 3 + 1]) / 2 - Math.min(f[idx.anL * 3 + 1], f[idx.anR * 3 + 1])).sort((a, b) => a - b);
  const standY = hipsY[Math.floor(hipsY.length * .9)] || .9, I = new THREE.Quaternion();
  return {sig, data: d, idx, duration: (d.frames.length - 1) / d.fps, legLen: standY, rest: {hips: {p: new THREE.Vector3(0, standY, 0), q: I}, chest: {q: I}, head: {q: I}}};
}
function basisQ(left, up) { const l = left.clone().normalize(), u = up.clone().addScaledVector(l, -up.dot(l)).normalize(), f = new THREE.Vector3().crossVectors(l, u); return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(l, u, f)); }
function samplePoseMotion(mo, u) {
  const d = mo.data, x = clamp(u * d.fps, 0, d.frames.length - 1), i0 = Math.floor(x), i1 = Math.min(i0 + 1, d.frames.length - 1), r = x - i0;
  const P = {}; for (const [n, k] of Object.entries(mo.idx)) { const a = d.frames[i0], b = d.frames[i1]; P[n] = new THREE.Vector3(lerp(a[k * 3], b[k * 3], r), lerp(a[k * 3 + 1], b[k * 3 + 1], r), lerp(a[k * 3 + 2], b[k * 3 + 2], r)); }
  const ground = Math.min(P.anL.y, P.anR.y); for (const v of Object.values(P)) v.y -= ground;
  const hipC = P.hipL.clone().add(P.hipR).multiplyScalar(.5), shC = P.shL.clone().add(P.shR).multiplyScalar(.5), earC = P.earL.clone().add(P.earR).multiplyScalar(.5), trunk = shC.clone().sub(hipC);
  const headFwd = P.nose.clone().sub(earC), headLeft = P.earL.clone().sub(P.earR), headUp = new THREE.Vector3().crossVectors(headFwd, headLeft.clone().normalize());
  const lift = d.lift ? lerp(d.lift[i0], d.lift[i1], r) : 0; // 跳起时最低那只脚离地多高（米，源视频人的尺度）
  return {lift, hips: {p: new THREE.Vector3(0, hipC.y, 0), q: basisQ(P.hipL.clone().sub(P.hipR), trunk)}, chest: {p: shC, q: basisQ(P.shL.clone().sub(P.shR), trunk)}, head: {p: earC, q: basisQ(headLeft, headUp.lengthSq() > 1e-8 ? headUp : trunk)},
    armL: {p: P.shL}, foreL: {p: P.elL}, handL: {p: P.wrL}, armR: {p: P.shR}, foreR: {p: P.elR}, handR: {p: P.wrR},
    thighL: {p: P.hipL}, shinL: {p: P.knL}, footL: {p: P.anL}, thighR: {p: P.hipR}, shinR: {p: P.knR}, footR: {p: P.anR}};
}
function sampleMotion(mo, u) {
  if (mo.data) return samplePoseMotion(mo, u);
  mo.mixer.setTime(clamp(u, 0, Math.max(0, mo.duration - 1e-4))); mo.root.updateMatrixWorld(true);
  const pose = {};
  for (const [k, b] of Object.entries(mo.bones)) if (b) { const p = new THREE.Vector3(), q = new THREE.Quaternion(); b.matrixWorld.decompose(p, q, new THREE.Vector3()); pose[k] = {p, q}; }
  return pose;
}
const clipStartCache = new WeakMap();
function clipWindow(c) { const mo = motions.get(c.motion); if (!mo) return [c.start, c.end ?? c.start]; return [c.start, c.end ?? (c.loop ? config.duration : c.start + Math.max(0, mo.duration - c.offset) / c.speed)]; }
/* 覆盖型片段（clip.override）：这段时间里原关键帧的手部接触、关节微调让位给动捕；all 时站位和朝向也固定在片段起点那一刻（原地做动作）。
   原关键帧不删，片段之外照常生效；淡入淡出期间按权重过渡。 */
function clipOverride(actor, t) {
  let best = null;
  for (const c of actor.clips || []) {
    if (!c.override || !motions.get(c.motion)) continue;
    const [s, e] = clipWindow(c); if (t < s || (t > e && !c.hold)) continue;
    const tc = Math.min(t, e), w = Math.min(1, c.weight * Math.min(1, c.fadeIn > 0 ? (tc - s) / c.fadeIn : 1, c.fadeOut > 0 && !c.hold ? (e - tc) / c.fadeOut : 1));
    if (w > 0 && (!best || w > best.w)) best = {w, mode: c.override, start: s};
  }
  return best;
}
function overrideSample(actor, sample, ov) {
  const k = 1 - ov.w, out = {...sample};
  for (const key of ['reachL', 'reachR']) if (out[key]) out[key] = {...out[key], w: out[key].w * k};
  if (out.adjust) out.adjust = Object.fromEntries(Object.entries(out.adjust).map(([n, v]) => [n, Array.isArray(v) ? v.map((x) => x * k) : v * k]));
  // 关键帧的高度（腾空、被扔飞、躺下时压低身体）属于原动作，覆盖时一律固定在片段起点那一刻；pose 只保留水平走位和朝向，all 连走位朝向也固定
  if (ov.mode === 'pose') { const y0 = smoothSample(actor.keyframes, ov.start, 'position')[1]; out.position = out.position.map((p, i) => (i === 1 ? p + (y0 - p) * ov.w : p)); }
  else if (ov.preview) { const p0 = smoothSample(actor.keyframes, ov.start, 'position'), y0 = smoothSample(actor.keyframes, ov.start, 'yaw', 0); out.position = p0; out.yaw = y0; } // 预览时片段还没加进去，直接固定在起点
  out.pitch = (out.pitch || 0) * k; out.roll = (out.roll || 0) * k;
  return out;
}
function applyClips(v, actor, t) {
  for (const c of actor.clips || []) {
    const mo = motions.get(c.motion); if (!mo) continue;
    const [start, end] = clipWindow(c); if (t < start || (t > end && !c.hold)) continue;
    const tc = Math.min(t, end), w = c.weight * Math.min(1, c.fadeIn > 0 ? (tc - start) / c.fadeIn : 1, c.fadeOut > 0 && !c.hold ? (end - tc) / c.fadeOut : 1);
    if (w <= 0) continue;
    let u = c.offset + (tc - start) * c.speed; if (c.loop && mo.duration > 0) u %= mo.duration;
    const pose = sampleMotion(mo, u), R = mo.rest, ratio = .9 * v.s / mo.legLen;
    const delta = (k) => FLIP.clone().multiply(pose[k].q.clone().multiply(R[k].q.clone().invert())).multiply(FLIP.clone().invert());
    // 骨盆：朝向变化 + 高度变化（蹲、跳）；rootMotion 时水平位移也带上
    const qBody = delta('hips'); v.body.quaternion.slerp(qBody, w);
    v.body.position.y += (pose.hips.p.y - R.hips.p.y) * ratio * w;
    if (c.rootMotion) {
      if (!clipStartCache.has(c)) clipStartCache.set(c, sampleMotion(mo, c.offset).hips.p.clone());
      const d = pose.hips.p.clone().sub(clipStartCache.get(c)); d.y = 0; d.applyQuaternion(FLIP).multiplyScalar(ratio * w).applyAxisAngle(new THREE.Vector3(0, 1, 0), v.root.rotation.y);
      v.root.position.add(d); if (u !== c.offset) sampleMotion(mo, u);
    }
    // 胸腔、头：相对绑定姿态的旋转变化
    const qChest = delta('chest'); v.torso.quaternion.slerp(v.body.quaternion.clone().invert().multiply(qChest), w);
    if (pose.head) v.neck.quaternion.slerp(qChest.clone().invert().multiply(delta('head')), w);
    // 四肢：让每节胶囊沿源骨段方向
    v.root.updateMatrixWorld(true);
    const rootQ = v.root.getWorldQuaternion(new THREE.Quaternion());
    const aim = (joint, a, b) => {
      if (!pose[a] || !pose[b]) return;
      const dir = pose[b].p.clone().sub(pose[a].p).applyQuaternion(FLIP).applyQuaternion(rootQ);
      const local = dir.applyQuaternion(joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
      joint.quaternion.slerp(new THREE.Quaternion().setFromUnitVectors(DOWN, local), w); joint.updateMatrixWorld(true);
    };
    if (!v.arms.L.stump) { aim(v.arms.L.sh, 'armL', 'foreL'); aim(v.arms.L.el, 'foreL', 'handL'); }
    if (!v.arms.R.stump) { aim(v.arms.R.sh, 'armR', 'foreR'); aim(v.arms.R.el, 'foreR', 'handR'); }
    aim(v.legs.L.hip, 'thighL', 'shinL'); aim(v.legs.L.knee, 'shinL', 'footL');
    aim(v.legs.R.hip, 'thighR', 'shinR'); aim(v.legs.R.knee, 'shinR', 'footR');
    // 视频动捕：源视频人和人偶比例不同、关键帧姿态本身下蹲时高度会叠加，导致穿地 / 悬空。
    // 套完动作后把最低的那只脚贴回角色所站高度（root 的 y，站台子、楼梯时就是台面）；视频里跳起来的帧（data.lift）脚底抬到相应高度。FBX 片段自带高度，不处理。
    if (mo.data) {
      v.root.updateMatrixWorld(true);
      const ground = v.root.getWorldPosition(new THREE.Vector3()).y;
      const low = Math.min(v.points.foot_L.getWorldPosition(new THREE.Vector3()).y, v.points.foot_R.getWorldPosition(new THREE.Vector3()).y);
      v.body.position.y += ground + (pose.lift || 0) * ratio * w - low; v.body.updateMatrixWorld(true); // 淡入淡出时也整段贴地（混合后的姿态本身要踩地），跳起高度随权重淡入淡出
    }
    v.activeClip = c.motion;
  }
}

function draw() {
  const shot = updateScene();
  render();
  $('shot-hud').textContent = shot.label;
  const cues = config.cues.filter((item) => currentTime >= item.time && currentTime < item.time + 1.2).map((item) => item.label);
  $('cue-hud').textContent = cues.join('　|　'); $('cue-hud').hidden = !cues.length;
}
function applyAspectLayout() { // 工程画幅 → 画面框比例（项目里切换画幅也走这里）
  const [wide, high] = config.aspectRatio.split(':').map(Number), ratio = wide / high;
  $('stage').style.aspectRatio = `${wide} / ${high}`;
  document.documentElement.style.setProperty('--ratio', ratio); document.documentElement.style.setProperty('--clean-width', `${ratio * 100}vh`); document.documentElement.style.setProperty('--clean-height', `${100 / ratio}vw`);
  $('scene-chip').textContent = `${config.duration}s · ${config.shots.length} 镜 · 几何代理`; if ($('aspect-select')) $('aspect-select').value = config.aspectRatio; if ($('figure-select')) $('figure-select').value = config.world.figure;
  view?.onAspect?.();
}
/* 画幅换算：outFit 只在导出时设置；镜头的 camera.fov 是按工程画幅定的竖直视角 */
let outFit = null, lastShot = null;
/* 参考画面（给视频模型看）：preview = 编辑预览（按 world.lift 提亮）；lit = 原样光照；lift = 提亮参考；flat = 白膜平光；depth = 深度图 */
let renderMode = 'preview', refFill = null, flatRig = null, depthMat = null, modeSaved = null;
const DARK_LUM = .12, TARGET_LUM = .2;
function liftFor(mode = renderMode) { const l = config.world.lift || 0; return mode === 'preview' ? l : mode === 'lift' ? (l || autoLiftCache || .6) : 0; }
let autoLiftCache = 0;
function buildRefLights() {
  refFill = new THREE.HemisphereLight('#e9eef7', '#3a3c42', 0); refFill.userData.reference = true; scene.add(refFill); // 提亮用的中性补光（只照亮暗部，不改灯光方向）
  flatRig = new THREE.Group(); flatRig.userData.reference = true; flatRig.visible = false;
  const amb = new THREE.AmbientLight('#ffffff', 1.1), head = new THREE.DirectionalLight('#ffffff', 1.5); flatRig.add(amb, head, head.target); flatRig.userData.head = head; scene.add(flatRig);
  depthMat = new THREE.ShaderMaterial({uniforms: {uNear: {value: .3}, uFar: {value: 20}},
    vertexShader: '#include <common>\n#include <skinning_pars_vertex>\nvarying float vViewZ;\nvoid main() {\n#include <skinbase_vertex>\n#include <begin_vertex>\n#include <skinning_vertex>\n#include <project_vertex>\nvViewZ = -mvPosition.z;\n}',
    fragmentShader: 'uniform float uNear; uniform float uFar; varying float vViewZ;\nvoid main() { float t = clamp((vViewZ - uNear) / (uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - pow(t, 0.6)), 1.0); }'});
}
function enterMode(mode) { // 导出前切换画面模式；flat / depth 关掉场景灯、雾、雨雪
  exitMode(); renderMode = mode;
  if (mode !== 'flat' && mode !== 'depth') return;
  const lights = []; scene.traverse((o) => { if (o.isLight && !o.userData.reference && o.parent !== flatRig) { lights.push([o, o.visible]); o.visible = false; } });
  modeSaved = {lights, toneMapping: renderer.toneMapping};
  if (mode === 'flat') flatRig.visible = true;
  if (mode === 'depth') { scene.overrideMaterial = depthMat; renderer.toneMapping = THREE.NoToneMapping; }
}
function exitMode() {
  if (modeSaved) { for (const [o, v] of modeSaved.lights) o.visible = v; renderer.toneMapping = modeSaved.toneMapping; modeSaved = null; }
  scene.overrideMaterial = null; if (flatRig) flatRig.visible = false; renderMode = 'preview';
}
function applyRenderMode() { // 每帧在天气之后调用
  const L = liftFor(); renderer.toneMappingExposure = config.world.exposure * (1 + 1.6 * L); refFill.intensity = 2.4 * L;
  if (renderMode !== 'flat' && renderMode !== 'depth') { if (weather) weather.group.visible = true; return; }
  scene.fog = null; if (weather) weather.group.visible = false; renderer.toneMappingExposure = 1; refFill.intensity = 0;
  if (renderMode === 'flat') { scene.background = new THREE.Color('#3b4048'); const h = flatRig.userData.head; h.position.copy(shotCam.position).add(new THREE.Vector3(.3, .8, 0)); h.target.position.copy(cameraTarget); h.target.updateMatrixWorld(); }
  else { scene.background = new THREE.Color('#000000'); const d = shotCam.position.distanceTo(cameraTarget); depthMat.uniforms.uNear.value = .3; depthMat.uniforms.uFar.value = Math.max(8, d * 2.5 + 4); }
}
async function measureShots(lift = null) { // 每镜中间一帧的平均亮度（0–1，按画面像素）
  const was = {time: currentTime, free: freeCamera, top: topView, helpers: $('helpers').checked, mode: renderMode, lift: config.world.lift};
  freeCamera = false; topView = false; $('helpers').checked = false; setHelperVisibility(); editor?.suspend();
  if (lift !== null) config.world.lift = lift;
  const small = document.createElement('canvas'); small.width = 64; small.height = 36; const g = small.getContext('2d', {willReadFrequently: true}), out = [];
  try {
    for (const shot of config.shots) { // 长镜头取 3 个点，用最暗的
      const len = shot.end - shot.start, fracs = len > 4 ? [.2, .5, .8] : [.5]; let lum = 1;
      for (const f of fracs) {
        currentTime = shot.start + len * f; draw(); g.drawImage(canvas, 0, 0, 64, 36);
        const px = g.getImageData(0, 0, 64, 36).data; let sum = 0; for (let i = 0; i < px.length; i += 4) sum += (.2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]) / 255;
        lum = Math.min(lum, sum / (px.length / 4));
      }
      out.push({id: shot.id, label: shot.label, lum});
    }
  } finally {
    if (lift !== null) { if (was.lift) config.world.lift = was.lift; else delete config.world.lift; }
    freeCamera = was.free; topView = was.top; $('helpers').checked = was.helpers; setHelperVisibility(); if (!document.body.classList.contains('clean')) editor?.resume(); currentTime = was.time; draw(); updateUI(true);
  }
  return out;
}
async function autoLift() { // 找到让所有镜头都够亮的最小提亮值
  let lo = 0, hi = 1, best = 1;
  const ok = async (L) => (await measureShots(L)).every((r) => r.lum >= TARGET_LUM);
  if (await ok(0)) return 0;
  if (!(await ok(1))) return 1;
  for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (await ok(mid)) { best = mid; hi = mid; } else lo = mid; }
  return Math.ceil(best * 20) / 20;
}
function fitFov(f) { // 导出画幅与工程不同时：裁切 = 内切（宽了保宽、窄了保高）；扩展 = 外扩（宽了保高、窄了保宽）
  if (!outFit || Math.abs(outFit.a1 - outFit.a0) < 1e-4) return f;
  const keepWidth = outFit.mode === 'crop' ? outFit.a1 > outFit.a0 : outFit.a1 < outFit.a0;
  return keepWidth ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(deg(f) / 2) * outFit.a0 / outFit.a1)) : f;
}
function sizeFor(aspect, short = 1080) { const a = aspectNum(aspect), even = (n) => Math.max(2, Math.round(n / 8) * 8); return a >= 1 ? [even(short * a), short] : [short, even(short / a)]; }
function renderMasked(cam, sa) { // 这一镜单独的画幅：在画面里加黑边（宽银幕上下黑边 / 竖画幅左右黑边），保持画面宽度或高度不变
  const size = renderer.getSize(new THREE.Vector2()), W = size.x, H = size.y, fa = W / H;
  let w = W, h = H; if (sa > fa) h = W / sa; else w = H * sa;
  const x = (W - w) / 2, y = (H - h) / 2, a0 = cam.aspect, f0 = cam.fov;
  renderer.setScissorTest(true); renderer.setScissor(0, 0, W, H); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.setScissor(x, y, w, h); renderer.setViewport(x, y, w, h);
  cam.aspect = sa; if (sa > fa) cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(deg(f0) / 2) * fa / sa)); cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  cam.aspect = a0; cam.fov = f0; cam.updateProjectionMatrix(); renderer.setViewport(0, 0, W, H); renderer.setScissorTest(false);
}
function viewCam() { return topView && view ? view.topCam : camera; }
function render() { // 主画面 + 自由观察 / 俯视时右下角的镜头小窗
  renderer.setScissorTest(false);
  const sa = !freeCamera && !topView && lastShot?.camera.aspect ? aspectNum(lastShot.camera.aspect) : 0;
  if (sa && Math.abs(sa - camera.aspect) > 1e-3) { renderMasked(camera, sa); }
  else if (topView && view) { // 俯视平面图：不加雾，并剖掉 2.2 米以上（屋顶、天花板），像看平面图
    const fog = scene.fog; scene.fog = null; renderer.clippingPlanes = view.topClip; renderer.render(scene, viewCam()); renderer.clippingPlanes = []; scene.fog = fog;
  } else renderer.render(scene, viewCam());
  if ((freeCamera || topView) && view?.pipOn() && !exporting) view.renderPip(renderer, scene, shotCam);
}
function updateScene() { // 只按 currentTime 摆好人物、道具、结构、特效和相机，不渲染（导出 Blender 逐帧烘焙也用它）
  applyRigs(currentTime);
  const samples = new Map();
  for (const actor of config.actors) { let sample = sampleActor(actor.keyframes, currentTime); if (actor.clips?.some((c) => c.override === 'all')) { const pth = actorPath(actor, currentTime); sample.position = pth.position; sample.yaw = pth.yaw; if (pth.walking && Math.abs(sample.pitch || 0) < .3) sample.gait = Math.max(sample.gait || 0, pth.walking); } /* 走回原路线时迈步（身体直立时） */ const v = actors.get(actor.id), ov = actor.clips?.length && mocapPreview?.actorId !== actor.id ? clipOverride(actor, currentTime) : null; if (ov) sample = overrideSample(actor, sample, ov); else if (mocapPreview?.actorId === actor.id && mocapPreview.override) sample = overrideSample(actor, sample, {w: 1, mode: mocapPreview.override, start: mocapPreview.at, preview: true}); samples.set(actor.id, sample); applyPose(v, sample); v.activeClip = null; if (mocapPreview?.actorId === actor.id) applyClips(v, {clips: [{...PV_CLIP, offset: mocapPreview.u}]}, 0); else if (actor.clips?.length) applyClips(v, actor, currentTime); if (sample.adjust) applyAdjust(v, sample.adjust); }
  placeProps(currentTime); scene.updateMatrixWorld(true);
  for (const actor of config.actors) {
    const visual = actors.get(actor.id), sample = samples.get(actor.id);
    for (const [key, side] of [['reachL', 'L'], ['reachR', 'R']]) {
      const reach = sample[key]; if (!reach || reach.w <= 0) continue;
      if (reach.target === 'world') { solveArm(visual, side, new THREE.Vector3(...reach.pos), reach.w); continue; }
      const point = resolvePoint(reach.target); if (!point) continue;
      point.updateMatrixWorld(true); solveArm(visual, side, point.getWorldPosition(new THREE.Vector3()), reach.w);
    }
    visual.root.updateMatrixWorld(true);
    if (visual.pill) { updatePill(visual); visual.root.updateMatrixWorld(true); }
  }
  scene.updateMatrixWorld(true);
  for (const item of fxItems) item.update(currentTime);
  for (const fn of ext.onDraw) fn(currentTime, api);
  const shot = shotAt(currentTime);
  { // 分镜相机永远按时间线算好；不在自由观察 / 俯视时，视口相机跟它一致
    const lt = currentTime - shot.start; shotCam.position.set(...smoothSample(shot.camera.keyframes, lt, 'position')); cameraTarget.set(...smoothSample(shot.camera.keyframes, lt, 'target'));
    lastShot = shot; shotCam.fov = fitFov(shot.camera.fov); shotCam.aspect = camera.aspect; shotCam.updateProjectionMatrix(); shotCam.up.set(0, 1, 0); shotCam.lookAt(cameraTarget);
    // 手持漂移：world.handheld 为全片默认，镜头 camera.handheld 可单独覆盖（固定机位写 0）
    const hh = shot.camera.handheld ?? config.world.handheld;
    if (hh > 0) { const ht = currentTime * .9 + config.shots.indexOf(shot) * 7.3; shotCam.rotateY(.004 * hh * wobble(ht, 1.3, 1)); shotCam.rotateX(.003 * hh * wobble(ht, 2.1, 2)); shotCam.rotateZ(.0025 * hh * wobble(ht, 3.7, 3)); shotCam.position.addScaledVector(new THREE.Vector3(wobble(ht, 4.1, 4), wobble(ht, 5.3, 5) * .6, wobble(ht, 6.7, 6) * .5), .008 * hh); }
    shotCam.updateMatrixWorld();
    if (!freeCamera && !topView) { camera.position.copy(shotCam.position); camera.quaternion.copy(shotCam.quaternion); camera.fov = shotCam.fov; camera.updateProjectionMatrix(); camera.updateMatrixWorld(); }
  }
  weather?.update(currentTime, viewCam());
  applyRenderMode();
  view?.onDraw(shot);
  editor?.onDraw();
  return shot;
}

/* ───────── 界面（检查器按 scene.json 自动生成字段）───────── */
const manualTarget = new THREE.Vector3(), cameraTarget = new THREE.Vector3();
const FIELD_LABELS = {pitch: ['身体前后翻 pitch', 'rad', .01], roll: ['身体侧倾 roll', 'rad', .01], gait: ['步态摆动 gait', '0–1', .1], crouch: ['半蹲 crouch', '0–1', .05], aim: ['持枪俯仰 aim', 'rad', .01], look: ['抬头 / 低头 look', 'rad', .01]};
function status(message) { $('status').textContent = message; }
function actorFieldsFor(actor) { return Object.keys(FIELD_LABELS).filter((field) => ['pitch', 'gait'].includes(field) || actor.keyframes.some((key) => key[field] !== undefined)); }
function buildActorFields() {
  const actor = config.actors.find((item) => item.id === $('actor-select').value) || config.actors[0], box2 = $('actor-extra'); box2.replaceChildren();
  if (!actor) return;
  const poseLabel = document.createElement('label'); poseLabel.className = 'fov'; poseLabel.textContent = '姿态 pose ';
  const select = document.createElement('select'); select.id = 'actor-pose';
  select.append(...Object.keys(POSES).map((name) => { const o = document.createElement('option'); o.value = name; o.textContent = name; return o; }));
  poseLabel.append(select); box2.append(poseLabel);
  for (const field of actorFieldsFor(actor)) {
    const [label, unit, step] = FIELD_LABELS[field], row = document.createElement('label'); row.className = 'fov'; row.textContent = `${label} `;
    const input = document.createElement('input'); input.type = 'number'; input.step = step; input.required = true; input.id = `actor-${field}`;
    const span = document.createElement('span'); span.textContent = unit; row.append(input, span); box2.append(row);
  }
}
function buildTimeline() {
  const dur = config.duration, pct = (t) => `${t / dur * 100}%`;
  const minor = dur <= 40 ? 1 : dur <= 120 ? 5 : 10, major = dur <= 40 ? 5 : dur <= 120 ? 10 : 30, ticks = [];
  for (let t = 0; t <= dur + 1e-6; t += minor) {
    const tick = document.createElement('i'), isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    tick.className = `tick${isMajor ? ' major' : ''}`; tick.style.left = pct(t);
    if (isMajor && t < dur - minor * .5) { const label = document.createElement('b'); label.textContent = `${t}s`; tick.append(label); }
    ticks.push(tick);
  }
  $('tl-ruler').replaceChildren(...ticks);
  $('shots').replaceChildren(...config.shots.map((shot) => {
    const block = document.createElement('button'); block.type = 'button'; block.className = 'shot-block'; block.dataset.shot = shot.id;
    block.style.left = `calc(${pct(shot.start)} + 1px)`; block.style.width = `calc(${pct(shot.end - shot.start)} - 2px)`; block.title = `${shot.label}\n${shot.start.toFixed(2)}–${shot.end.toFixed(2)}s\n${shot.action || ''}`;
    const title = document.createElement('b'); title.textContent = shot.label;
    const time = document.createElement('small'); time.textContent = `${shot.start.toFixed(2)}–${shot.end.toFixed(2)}s`;
    block.append(title, time); return block;
  }));
  $('tl-cues').replaceChildren(...config.cues.map((cue) => { const mark = document.createElement('i'); mark.className = 'cue-mark'; mark.style.left = pct(cue.time); mark.title = `${cue.time.toFixed(2)}s · ${cue.label}`; return mark; }));
  view?.decorateShots();
}
function buildKeyMarks() { editor?.buildLanes(); }
function buildActorChips() {
  $('actor-chips').replaceChildren(...config.actors.map((actor, i) => {
    const chip = document.createElement('button'); chip.type = 'button'; chip.dataset.actor = actor.id; chip.style.setProperty('--c', actor.color); chip.className = i === 0 ? 'active' : '';
    const dot = document.createElement('i'); chip.append(dot, document.createTextNode(actor.label)); chip.title = actor.label;
    chip.addEventListener('click', () => { $('actor-select').value = actor.id; $('actor-select').dispatchEvent(new Event('change')); });
    return chip;
  }));
  if (!config.actors.length) $('actor-chips').textContent = '本场景没有角色';
}
function updateUI(fill = false) {
  const shot = shotAt(currentTime);
  const frame = Math.round(currentTime * config.fps), totalFrames = Math.round(config.duration * config.fps);
  $('timecode').textContent = currentTime.toFixed(3).padStart(6, '0'); $('timecode-sub').textContent = `/ ${config.duration.toFixed(3)}s`;
  $('frame-hud').textContent = `帧 ${frame} / ${totalFrames}`;
  $('play').innerHTML = `<svg><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`; $('play').title = playing ? '暂停（空格）' : '播放（空格）';
  $('tl-playhead').style.left = `${currentTime / config.duration * 100}%`;
  $('keyframe-time').textContent = `${(currentTime - shot.start).toFixed(3)}s / 镜头内`; if (document.activeElement !== $('shot-name')) $('shot-name').value = shot.label;
  for (const button of $('shots').children) button.classList.toggle('active', button.dataset.shot === shot.id);
  if (fill) fillInspector();
}
function fieldVector(prefix, values) { ['x', 'y', 'z'].forEach((axis, i) => { $(`${prefix}-${axis}`).value = Number(values[i].toFixed(3)); }); }
function readVector(prefix) { return ['x', 'y', 'z'].map((axis) => finite(Number($(`${prefix}-${axis}`).value), prefix)); }
function fillInspector() {
  const shot = shotAt(currentTime), [a, b, r] = interval(shot.camera.keyframes, currentTime - shot.start);
  fieldVector('cam', freeCamera ? camera.position.toArray() : smoothSample(shot.camera.keyframes, currentTime - shot.start, 'position'));
  fieldVector('target', freeCamera ? manualTarget.toArray() : smoothSample(shot.camera.keyframes, currentTime - shot.start, 'target')); $('fov').value = shot.camera.fov; $('fov-range').value = shot.camera.fov; if (document.activeElement !== $('shot-aspect')) $('shot-aspect').value = shot.camera.aspect || ''; if (document.activeElement !== $('lift-range')) $('lift-range').value = config.world.lift || 0; $('lift-v').textContent = `${Math.round((config.world.lift || 0) * 100)}%`; $('fov-mm').textContent = `≈ ${Math.round(12 / Math.tan(deg(shot.camera.fov) / 2))}mm`;
  const actor = config.actors.find((item) => item.id === $('actor-select').value) || config.actors[0];
  if (!actor) { $('keyframe-summary').textContent = '本场景没有角色'; return; }
  const pose = sampleActor(actor.keyframes, currentTime);
  fieldVector('actor', pose.position); $('actor-yaw').value = Number(pose.yaw.toFixed(3));
  if ($('actor-pose')) $('actor-pose').value = pose.poseName;
  for (const field of actorFieldsFor(actor)) $(`actor-${field}`).value = Number(pose[field].toFixed(3));
  $('keyframe-summary').textContent = `相机关键帧：${shot.camera.keyframes.map((key) => key.time.toFixed(2)).join(' / ')}s\n${actor.id} 角色关键帧（当前 ±2 秒）：${actor.keyframes.filter((key) => Math.abs(key.time - currentTime) < 2).map((key) => key.time.toFixed(2)).join(' / ')}s`;
}
function pause() { playing = false; updateUI(); }
function seek(seconds) { if (!config) return; pause(); editor?.onSeek(); currentTime = clamp(finite(seconds, '时间', 0, 600), 0, config.duration); draw(); updateUI(true); }
async function loadExtensions(list = []) {
  for (const path of list) {
    if (typeof path !== 'string' || !/^(\.\/)?[\w-][\w./-]*\.js$/.test(path) || path.includes('..')) throw new Error(`扩展路径无效：${path}`);
    if (loadedExtensions.has(path)) continue;
    const mod = await import(new URL(path, location.href).href);
    if (typeof mod.setup !== 'function') throw new Error(`扩展 ${path} 需要导出 setup(api)`);
    mod.setup(api); loadedExtensions.add(path);
  }
}
async function applyConfig(raw) {
  await loadExtensions(raw?.extensions || []);
  const next = validateConfig(raw);
  for (const visual of actors.values()) { disposeGroup(visual.root); scene.remove(visual.root); } actors.clear();
  for (const item of props.values()) { item.group.parent?.remove(item.group); disposeGroup(item.group); } props.clear(); points.clear();
  await loadMotions(next.motions);
  config = next; POSES = buildPoseTable(config.poses);
  buildWorld(); weather?.capture(); config.actors.forEach(buildHumanoid); config.props.forEach(buildProp); buildFx(); checkRefs(); setHelperVisibility();
  $('project-title').textContent = config.title; document.title = `${config.title} · ZPboom.AI 3D 预演`;
  $('scene-chip').textContent = `${config.aspectRatio} · ${config.duration}s · ${config.shots.length} 镜 · 几何代理`;
  applyAspectLayout();
  buildTimeline();
  $('actor-select').replaceChildren(...config.actors.map((actor) => { const option = document.createElement('option'); option.value = actor.id; option.textContent = actor.label; return option; }));
  buildActorChips(); buildActorFields(); buildKeyMarks();
  controls.forEach((name) => { $(name).disabled = false; }); if (!restoring) editor?.onConfig(); else editor?.buildLanes(); seek(0); resize();
}
function upsert(keys, frame) { tangentCache.delete(keys); const index = keys.findIndex((key) => Math.abs(key.time - frame.time) < .0001); if (index < 0) keys.push(frame); else keys[index] = {...keys[index], ...frame}; keys.sort((a, b) => a.time - b.time); }
function download(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 15000); }
function resize() { if (!renderer || exporting) return; const rect = $('stage').getBoundingClientRect(); renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false); camera.aspect = rect.width / Math.max(1, rect.height); camera.updateProjectionMatrix(); view?.onResize(camera.aspect); if (config) draw(); }
function setClean(value) { const was = document.body.classList.contains('clean'); document.body.classList.toggle('clean', value); if (value && !was) editor?.suspend(); if (!value && was) editor?.resume(); if (value) { $('helpers').checked = false; setHelperVisibility(); } resize(); }

$('camera-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (!config) return; pause();
  try { const shot = shotAt(currentTime), position = readVector('cam'), target = readVector('target');
    if (new THREE.Vector3(...position).distanceTo(new THREE.Vector3(...target)) < 1e-5) throw new Error('相机位置不能与目标重合');
    const fov = finite(Number($('fov').value), 'FOV', 10, 100), before = editor?.beginEdit(); upsert(shot.camera.keyframes, {time: Number((currentTime - shot.start).toFixed(6)), position, target}); shot.camera.fov = fov;
    editor?.endEdit(`镜头 ${shot.label} 写入相机关键帧`, before); draw(); updateUI(true); status('已写入相机关键帧 · Ctrl+Z 撤销 · Ctrl+S 保存');
  } catch (error) { status(error.message); }
});
$('actor-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (!config?.actors.length) return; pause();
  try {
    const actor = config.actors.find((item) => item.id === $('actor-select').value), current = sampleActor(actor.keyframes, currentTime);
    const frame = {time: Number(currentTime.toFixed(6)), position: readVector('actor'), yaw: finite(Number($('actor-yaw').value), 'yaw', -Math.PI * 100, Math.PI * 100), pose: $('actor-pose').value};
    for (const field of actorFieldsFor(actor)) { const [, low, high] = ACTOR_FIELDS.find(([name]) => name === field); frame[field] = finite(Number($(`actor-${field}`).value), field, low, high); }
    for (const field of ['armL', 'armR']) if (actor.keyframes.some((key) => key[field] !== undefined)) frame[field] = current[field];
    for (const side of ['reachL', 'reachR']) if (current[side]?.w > 0) { frame[side] = {target: current[side].target, w: Number(current[side].w.toFixed(3))}; if (current[side].pos) frame[side].pos = current[side].pos.map((n) => Number(n.toFixed(4))); }
    const before = editor?.beginEdit(); upsert(actor.keyframes, frame); actors.get(actor.id).gait = buildGait(actor); editor?.endEdit(`${actor.id} 写入角色关键帧`, before); buildKeyMarks(); draw(); updateUI(true); status(`已写入 ${actor.id} 的角色关键帧（姿态 ${frame.pose}）· Ctrl+Z 撤销 · Ctrl+S 保存`);
  } catch (error) { status(error.message); }
});
$('play').addEventListener('click', () => { if (!config) return; if (currentTime >= config.duration) currentTime = 0; playing = !playing; previousFrame = performance.now(); updateUI(); });
$('restart').addEventListener('click', () => seek(0));
// 时间线：在轨道上按住拖动即可拖动播放头；单击镜头块跳到该镜开头
const area = $('timeline-area'); let scrub = null;
const timeAt = (x) => { const r = area.getBoundingClientRect(); return clamp((x - r.left) / Math.max(1, r.width), 0, 1) * config.duration; };
area.addEventListener('pointerdown', (event) => { if (!config || exporting || recording) return; scrub = {x: event.clientX, moved: false, block: event.target.closest('.shot-block')}; area.setPointerCapture(event.pointerId); if (!scrub.block) seek(timeAt(event.clientX)); });
area.addEventListener('pointermove', (event) => { if (!scrub) return; if (Math.abs(event.clientX - scrub.x) > 3) scrub.moved = true; if (scrub.moved || !scrub.block) seek(timeAt(event.clientX)); });
area.addEventListener('pointerup', () => { if (scrub?.block && !scrub.moved) { const shot = config.shots.find((item) => item.id === scrub.block.dataset.shot); if (shot) seek(shot.start); } scrub = null; });
area.addEventListener('pointercancel', () => { scrub = null; });
const stepFrame = (n) => seek(clamp(Math.round(currentTime * config.fps + n) / config.fps, 0, config.duration));
const stepShot = (dir) => { const shots = config.shots, i = shots.indexOf(shotAt(currentTime)); if (dir < 0) seek(currentTime - shots[i].start > .05 ? shots[i].start : shots[Math.max(0, i - 1)].start); else seek(shots[Math.min(shots.length - 1, i + 1)].start); };
$('prev-frame').addEventListener('click', () => config && stepFrame(-1)); $('next-frame').addEventListener('click', () => config && stepFrame(1));
$('prev-shot').addEventListener('click', () => config && stepShot(-1)); $('next-shot').addEventListener('click', () => config && stepShot(1));
$('fov').addEventListener('input', () => { const fov = Number($('fov').value); if (fov >= 10 && fov <= 100) $('fov-range').value = fov; if (fov > 0 && fov < 180) $('fov-mm').textContent = `≈ ${Math.round(12 / Math.tan(deg(fov) / 2))}mm`; });
$('actor-select').addEventListener('change', () => { buildActorFields(); fillInspector(); buildKeyMarks(); for (const chip of $('actor-chips').children) chip.classList.toggle('active', chip.dataset.actor === $('actor-select').value); });
$('helpers').addEventListener('change', () => { setHelperVisibility(); draw(); });
$('free-camera').addEventListener('change', () => { view?.setFree($('free-camera').checked); });
$('clean').addEventListener('click', () => setClean(true));
document.addEventListener('keydown', (event) => {
  if (recording || exporting || !config) return;
  if (event.key === 'Escape' && document.body.classList.contains('clean')) { setClean(false); return; }
  if (!document.body.classList.contains('clean') && editor?.onKey(event)) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); $('play').click(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const dir = event.key === 'ArrowLeft' ? -1 : 1; if (event.shiftKey) seek(clamp(currentTime + dir, 0, config.duration)); else stepFrame(dir); }
  else if (event.key === '[' || event.key === ']') { event.preventDefault(); stepShot(event.key === '[' ? -1 : 1); }
  else if (event.key === 'Home') { event.preventDefault(); seek(0); }
});
$('export').addEventListener('click', () => { if (config) { download(new Blob([JSON.stringify(config, null, 1) + '\n'], {type: 'application/json'}), 'scene.json'); status('已导出当前配置；覆盖项目内 scene.json 即可保存'); } });
$('import').addEventListener('click', () => $('config-file').click());
$('config-file').addEventListener('change', async () => {
  const file = $('config-file').files[0]; if (!file) return;
  try { if (recording || exporting) throw new Error('请先结束导出再导入'); if (file.size > 8 * 1024 * 1024) throw new Error('配置文件超过 8MB'); await applyConfig(JSON.parse(await file.text())); status('配置已导入'); }
  catch (error) { status(`导入失败：${error.message}`); } finally { $('config-file').value = ''; }
});
$('mocap-open').addEventListener('click', async () => { try { (await import('./videomocap.js?v=2.7.3')).openVideoMocap(mocapCtx); } catch (error) { status(`视频动捕打不开：${error.message}`); } });
$('reset').addEventListener('click', async () => { if (initialConfig && !recording && !exporting) { const before = editor?.beginEdit(); await restoreConfig(clone(initialConfig)); editor?.endEdit('恢复项目配置', before); status('已恢复成打开页面时的 scene.json · Ctrl+Z 可撤销'); } });

// 自由观察 / 俯视的鼠标键盘操作在 viewtools.js

/* ───────── 导出 MP4（逐帧，不掉帧）／后备 WebM ───────── */
function setRecordLabel(label, busy) { $('record-label').textContent = label; $('record').classList.toggle('busy', busy); }
function setRecordingUI(active) { for (const element of document.querySelectorAll('button,input,select')) if (element.id !== 'record') element.disabled = active; }
const EXPORT_SIZES = {'16:9': [1920, 1080], '21:9': [2520, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440]};
async function mp4Size(aspect = config.aspectRatio, short = 1080, bitrate) { // 编码器不支持时逐级缩小（同画幅）
  for (const sh of [short, 1080, 822, 720, 540].filter((n, i, a) => n <= short && a.indexOf(n) === i)) { const size = sizeFor(aspect, sh); if (await pickCodec(...size, config.fps, bitrate || Math.round(16_000_000 * size[0] * size[1] / 2073600))) return size; }
  return null;
}
const exportSize = (aspect = config.aspectRatio, short = 1080) => (short === 1080 && EXPORT_SIZES[aspect]) || sizeFor(aspect, short);
const MP4_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033'];
async function pickCodec(width, height, fps, bitrate) {
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) return null;
  for (const codec of MP4_CODECS) { try { const res = await VideoEncoder.isConfigSupported({codec, width, height, bitrate, framerate: fps}); if (res.supported) return codec; } catch { /* 下一个 */ } }
  return null;
}
async function exportMp4({width, height, aspect, fit = 'crop', short = 1080, mode = 'lit', bitrate, download: save = true} = {}) {
  if (exporting) throw new Error('正在导出中');
  aspect = aspect && ASPECTS.includes(aspect) ? aspect : config.aspectRatio;
  if (!width || !height) [width, height] = (await mp4Size(aspect, short, bitrate)) || sizeFor(aspect, short);
  bitrate ||= Math.round(16_000_000 * (width * height) / (1920 * 1080));
  outFit = {a0: aspectNum(config.aspectRatio), a1: width / height, mode: fit};
  if (mode === 'lift' && !config.world.lift && !autoLiftCache) autoLiftCache = await autoLift() || .4;
  enterMode(['lit', 'lift', 'flat', 'depth'].includes(mode) ? mode : 'lit');
  const fps = config.fps, total = Math.round(config.duration * fps), codec = await pickCodec(width, height, fps, bitrate);
  if (!codec) { outFit = null; exitMode(); throw new Error('当前浏览器不支持 WebCodecs H.264 编码，请用新版 Chrome / Edge / Safari 打开'); }
  pause(); exporting = {cancel: false}; editor?.suspend();
  const before = {time: currentTime, helpers: $('helpers').checked, ratio: renderer.getPixelRatio()};
  const viewBefore = view?.saveView(); view?.setFree(false, true);
  $('helpers').checked = false; setHelperVisibility();
  renderer.setPixelRatio(1); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
  setRecordingUI(true); setRecordLabel('取消导出', true);
  let encodeError = null;
  const muxer = new Muxer({target: new ArrayBufferTarget(), video: {codec: 'avc', width, height, frameRate: fps}, fastStart: 'in-memory'});
  const encoder = new VideoEncoder({output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (error) => { encodeError = error; }});
  encoder.configure({codec, width, height, bitrate, framerate: fps, avc: {format: 'avc'}});
  try {
    for (let i = 0; i < total; i++) {
      if (exporting.cancel) throw new Error('已取消导出'); if (encodeError) throw encodeError;
      currentTime = Math.min(config.duration, i / fps); draw();
      const frame = new VideoFrame(canvas, {timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps)});
      encoder.encode(frame, {keyFrame: i % (fps * 2) === 0}); frame.close();
      while (encoder.encodeQueueSize > 6) await new Promise((resolve) => setTimeout(resolve, 4));
      if (i % 10 === 0) { status(`正在逐帧导出 MP4：${i + 1} / ${total} 帧（${Math.round((i + 1) / total * 100)}%）`); await new Promise((resolve) => setTimeout(resolve, 0)); }
    }
    await encoder.flush(); if (encodeError) throw encodeError;
    muxer.finalize();
    const buffer = muxer.target.buffer, blob = new Blob([buffer], {type: 'video/mp4'});
    if (save) download(blob, `${config.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'previs'}_${width}x${height}_${fps}fps${{lit: '', lift: '_提亮', flat: '_平光', depth: '_深度'}[renderMode] ?? ''}.mp4`);
    status(`已导出 MP4：${total} 帧 · ${width}×${height} · ${fps}fps · ${(blob.size / 1048576).toFixed(1)}MB（逐帧渲染，无掉帧）`);
    return {blob, frames: total, width, height, fps, codec, bytes: blob.size, header: new TextDecoder().decode(new Uint8Array(buffer, 4, 4))};
  } catch (error) { status(`MP4 导出未完成：${error.message}`); throw error; }
  finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch { /* 已关闭 */ }
    exporting = null; setRecordingUI(false); setRecordLabel('导出 MP4', false);
    outFit = null; exitMode(); renderer.setPixelRatio(before.ratio); $('helpers').checked = before.helpers; setHelperVisibility(); if (!document.body.classList.contains('clean')) editor?.resume(); resize(); seek(before.time); view?.restoreView(viewBefore);
  }
}
function stopRecording() { if (recording && recording.recorder.state !== 'inactive') recording.recorder.stop(); }
function recordWebm() {
  const mime = window.MediaRecorder && canvas.captureStream ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type)) : null;
  if (!mime) { status('此浏览器既不支持 MP4 编码也不支持 WebM 录制，请用系统录屏录制干净画面'); return; }
  try {
    seek(0); $('helpers').checked = false; setHelperVisibility(); draw();
    const stream = canvas.captureStream(config.fps), recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 12000000}), chunks = [];
    recording = {recorder, stream}; recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('stop', () => { playing = false; stream.getTracks().forEach((track) => track.stop()); recording = null; setRecordLabel('导出 MP4', false); setRecordingUI(false); download(new Blob(chunks, {type: mime}), 'zpboom-previs.webm'); updateUI(true); status('已导出无声 WebM（实时录制，可能掉帧）'); });
    setRecordingUI(true); setRecordLabel('停止录制', true); status('正在实时录制 WebM，请保持页面在前台'); recorder.start(200); previousFrame = performance.now(); playing = true; updateUI();
  } catch (error) { recording?.stream?.getTracks().forEach((track) => track.stop()); recording = null; setRecordingUI(false); status(`录制未启动：${error.message}`); }
}
/* ───────── 导出 Blender：一个带完整动画的 GLB，再用工程里的 blender_setup.py 生成 .blend ─────────
   按工程帧率逐帧烘焙：人物每个关节、道具（含换手）、结构动画、特效小件都记成关键帧；每个镜头一台相机（含手持漂移）；
   灯光换成独立灯（位置、方向逐帧），灯光强度、发光材质、环境光、背景色、镜头和声音提示写进 GLB 的 extras.zpboom，
   blender_setup.py 读它来设帧率 / 分辨率 / 镜头标记切相机 / 灯光强度 / 世界光。GLB 本身也能直接导进 Maya、C4D、UE。 */
let GLTFExporterClass = null;
const BAKE_UP = new THREE.Vector3(0, 1, 0);
const nameSafe = (value) => String(value).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
function visibleChain(obj) { for (let o = obj; o; o = o.parent) if (!o.visible) return false; return true; }
function bakeChannel(size) { return {size, first: null, prev: null, data: null}; }
function bakePush(ch, i, total, vals, quat = false) {
  if (quat && ch.prev && ch.prev[0] * vals[0] + ch.prev[1] * vals[1] + ch.prev[2] * vals[2] + ch.prev[3] * vals[3] < 0) for (let k = 0; k < 4; k++) vals[k] = -vals[k]; // 四元数保持同号，插值不绕远路
  if (!ch.first) ch.first = vals.slice();
  else if (!ch.data && vals.some((n, k) => Math.abs(n - ch.first[k]) > 1e-6)) { ch.data = new Float32Array(total * ch.size); for (let j = 0; j < i; j++) ch.data.set(ch.first, j * ch.size); }
  if (ch.data) ch.data.set(vals, i * ch.size);
  ch.prev = vals;
}
function bakeRecord() { return {p: bakeChannel(3), q: bakeChannel(4), s: bakeChannel(3), v: bakeChannel(1), ever: false}; }
function compressKeys(values) { // 逐帧数值 → [帧, 值]，去掉恒定段中间的帧；整段不变返回 null
  if (values.every((n) => Math.abs(n - values[0]) < 1e-6)) return null;
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i > 0 && i < values.length - 1 && Math.abs(values[i - 1] - values[i]) < 1e-6 && Math.abs(values[i + 1] - values[i]) < 1e-6) continue;
    out.push([i, Number(values[i].toFixed(4))]);
  }
  return out;
}
function patchGlb(buffer, edit) { // 改写 GLB 的 JSON 块（BIN 块原样保留）
  const view = new DataView(buffer), jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  edit(json);
  let bytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(0x20); padded.set(bytes); bytes = padded;
  const rest = new Uint8Array(buffer, 20 + jsonLength), out = new Uint8Array(20 + bytes.length + rest.length), outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546C67, true); outView.setUint32(4, 2, true); outView.setUint32(8, out.length, true);
  outView.setUint32(12, bytes.length, true); outView.setUint32(16, 0x4E4F534A, true); out.set(bytes, 20); out.set(rest, 20 + bytes.length);
  return out.buffer;
}
async function exportBlender({aspect, fit = 'crop', short = 1080, download: save = true} = {}) {
  if (exporting) throw new Error('正在导出中');
  if (!GLTFExporterClass) ({GLTFExporter: GLTFExporterClass} = await import('./vendor/addons/exporters/GLTFExporter.js'));
  pause(); exporting = {cancel: false}; editor?.suspend();
  const before = {time: currentTime, helpers: $('helpers').checked};
  $('helpers').checked = false; setHelperVisibility();
  setRecordingUI(true); setRecordLabel('取消导出', true);
  aspect = aspect && ASPECTS.includes(aspect) ? aspect : config.aspectRatio;
  const fps = config.fps, total = Math.max(1, Math.round(config.duration * fps)), [width, height] = exportSize(aspect, short);
  outFit = {a0: aspectNum(config.aspectRatio), a1: width / height, mode: fit};
  const undo = [], proxies = [];
  const setTemp = (obj, key, value) => { const old = obj[key]; undo.push(() => { obj[key] = old; }); obj[key] = value; };
  try {
    // 1. 收集要烘焙的节点：道具组按世界坐标（会换手），其他按本地坐标保留层级；灯、灯目标、标签、粒子、钢索线另行处理
    const propGroups = new Set([...props.values()].map((item) => item.group)), lightTargets = new Set();
    scene.traverse((o) => { if (o.isLight && o.target) lightTargets.add(o.target); });
    const nodes = [], lightRecs = [], cableRecs = [], skipped = [], ambient = [];
    const walk = (parent) => {
      for (const child of parent.children) {
        if (propGroups.has(child)) continue;
        if (child.userData.weather || child.userData.reference) { skipped.push(child); continue; } // 雨雪粒子不导出（Blender 脚本另建近似粒子）
        if (child.isLight) { skipped.push(child); if (child.isHemisphereLight || child.isAmbientLight) ambient.push(child); else lightRecs.push({light: child, p: bakeChannel(3), q: bakeChannel(4), I: new Float32Array(total)}); continue; }
        if (lightTargets.has(child) || child.isSprite || child.isPoints) { skipped.push(child); continue; }
        if (child.isLine && !child.isLineSegments && !child.isLineLoop && child.geometry.attributes.position?.count === 2) { skipped.push(child); cableRecs.push({line: child, ...bakeRecord()}); continue; }
        nodes.push({obj: child, world: false, ...bakeRecord()}); walk(child);
      }
    };
    walk(scene); for (const group of propGroups) { nodes.push({obj: group, world: true, ...bakeRecord()}); walk(group); }
    const matRecs = new Map();
    for (const n of nodes) if (n.obj.isMesh) for (const m of [n.obj.material].flat()) if (m?.isMeshStandardMaterial && !matRecs.has(m)) matRecs.set(m, new Float32Array(total));
    const camRecs = new Map(config.shots.map((shot) => [shot.id, {shot, frames: [], p: [], q: []}]));
    // 2. 逐帧烘焙（只摆位不渲染，比导出 MP4 快得多）
    const P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), T = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), M = new THREE.Matrix4();
    for (let i = 0; i < total; i++) {
      if (exporting.cancel) throw new Error('已取消导出');
      currentTime = Math.min(config.duration, i / fps); const shot = updateScene(); scene.updateMatrixWorld(true);
      for (const n of nodes) {
        const o = n.obj; let vis;
        if (n.world) { o.matrixWorld.decompose(P, Q, S); vis = visibleChain(o); } else { P.copy(o.position); Q.copy(o.quaternion); S.copy(o.scale); vis = o.visible; }
        bakePush(n.p, i, total, P.toArray()); bakePush(n.q, i, total, Q.toArray(), true); bakePush(n.s, i, total, S.toArray()); bakePush(n.v, i, total, [vis ? 1 : 0]);
        if (vis) n.ever = true;
      }
      for (const L of lightRecs) {
        const o = L.light; o.getWorldPosition(P);
        if (o.isSpotLight || o.isDirectionalLight) { o.target.getWorldPosition(T); if (T.distanceToSquared(P) < 1e-10) T.set(P.x, P.y - 1, P.z); Q.setFromRotationMatrix(M.lookAt(P, T, BAKE_UP)); } else Q.identity();
        bakePush(L.p, i, total, P.toArray()); bakePush(L.q, i, total, Q.toArray(), true); L.I[i] = visibleChain(o) ? o.intensity : 0;
      }
      for (const C of cableRecs) {
        const o = C.line, pos = o.geometry.attributes.position; A.fromBufferAttribute(pos, 0).applyMatrix4(o.matrixWorld); B.fromBufferAttribute(pos, 1).applyMatrix4(o.matrixWorld);
        const len = A.distanceTo(B), vis = visibleChain(o) && len > 1e-5;
        P.addVectors(A, B).multiplyScalar(.5); if (len > 1e-5) Q.setFromUnitVectors(BAKE_UP, T.subVectors(B, A).normalize()); else Q.identity();
        bakePush(C.p, i, total, P.toArray()); bakePush(C.q, i, total, Q.toArray(), true); bakePush(C.s, i, total, vis ? [1, len, 1] : [0, 0, 0]); bakePush(C.v, i, total, [1]);
        if (vis) C.ever = true;
      }
      for (const [m, values] of matRecs) values[i] = m.emissiveIntensity;
      const cam = camRecs.get(shot.id), q = shotCam.quaternion.toArray(), last = cam.q.at(-1);
      if (last && last[0] * q[0] + last[1] * q[1] + last[2] * q[2] + last[3] * q[3] < 0) for (let k = 0; k < 4; k++) q[k] = -q[k];
      cam.frames.push(i); cam.p.push(shotCam.position.toArray()); cam.q.push(q);
      if (i % 15 === 0) { status(`正在烘焙 Blender 动画：${i + 1} / ${total} 帧（${Math.round((i + 1) / total * 100)}%）`); await new Promise((resolve) => setTimeout(resolve, 0)); }
    }
    // 3. 回到第 0 帧作为静态姿态；道具组挂到场景根（世界坐标轨道），只导出出现过的节点
    currentTime = 0; updateScene(); scene.updateMatrixWorld(true);
    const ambientEntries = ambient.filter(visibleChain).map((l) => ({type: l.isHemisphereLight ? 'hemisphere' : 'ambient', color: l.color.toArray(), ground: l.groundColor?.toArray() || null, intensity: l.intensity})); // 必须在下面隐藏灯之前记
    for (const item of props.values()) { scene.attach(item.group); undo.push(() => { item.holder = null; }); }
    for (const o of skipped) setTemp(o, 'visible', false);
    for (const n of nodes) setTemp(n.obj, 'visible', n.ever);
    const times = Float32Array.from({length: total}, (_, i) => i / fps), tracks = [];
    const addTracks = (obj, rec, frameTimes = times) => {
      if (rec.p.data) tracks.push(new THREE.VectorKeyframeTrack(`${obj.uuid}.position`, frameTimes, rec.p.data));
      if (rec.q.data) tracks.push(new THREE.QuaternionKeyframeTrack(`${obj.uuid}.quaternion`, frameTimes, rec.q.data));
      if (rec.s.data || rec.v.data) { // 隐藏 = 缩放到 0（阶跃），glTF 没有可见性动画
        const out = new Float32Array(total * 3);
        for (let i = 0; i < total; i++) { const vis = rec.v.data ? rec.v.data[i] : rec.v.first[0]; if (vis) out.set(rec.s.data ? rec.s.data.subarray(i * 3, i * 3 + 3) : rec.s.first, i * 3); }
        tracks.push(new THREE.VectorKeyframeTrack(`${obj.uuid}.scale`, frameTimes, out, THREE.InterpolateDiscrete));
      }
    };
    const firstOf = (obj, rec) => { obj.position.fromArray(rec.p.first); obj.quaternion.fromArray(rec.q.first); };
    // 4. 代理对象：独立灯、每镜一台相机、钢索圆柱
    const names = new Map(), used = new Set();
    const lightEntries = [];
    lightRecs.forEach((L, k) => {
      const src = L.light, peak = Math.max(...L.I); if (peak <= 0) return;
      // glTF / Blender 的点光、聚光固定按平方衰减；网页里 decay ≠ 2 的灯按“有效距离一半处亮度相同”补偿强度
      const decay = src.isDirectionalLight ? 2 : src.decay ?? 2, falloff = decay === 2 ? 1 : clamp(Math.pow(src.distance > 0 ? src.distance / 2 : 4, 2 - decay), .25, 4);
      const I0 = (L.I[0] > 0 ? L.I[0] : peak) * falloff;
      const px = src.isSpotLight ? new THREE.SpotLight(src.color, I0, src.distance, src.angle, src.penumbra, src.decay) : src.isDirectionalLight ? new THREE.DirectionalLight(src.color, I0) : new THREE.PointLight(src.color, I0, src.distance, src.decay);
      px.target = null; px.castShadow = src.castShadow; firstOf(px, L);
      let owner = ''; for (let o = src.parent; o; o = o.parent) { const item = [...props.values()].find((it) => it.group === o); if (item) { owner = `${nameSafe(item.prop.id)}_`; break; } if (o === fxGroup) { owner = 'fx_'; break; } }
      const type = src.isSpotLight ? 'spot' : src.isDirectionalLight ? 'sun' : 'point';
      names.set(px, `LIGHT_${owner}${type}_${k + 1}`); scene.add(px); proxies.push(px); addTracks(px, {...L, s: bakeChannel(3), v: bakeChannel(1)});
      lightEntries.push({node: names.get(px), type, color: src.color.toArray(), intensity: I0, keys: compressKeys(Array.from(L.I, (v) => v * falloff)), castShadow: Boolean(src.castShadow), distance: src.distance || 0, decay, falloff, ...(src.isSpotLight ? {angle: src.angle, penumbra: src.penumbra} : {})});
    });
    const shotEntries = [];
    for (const {shot, frames, p, q} of camRecs.values()) {
      if (!frames.length) continue;
      const camFov = fitFov(shot.camera.fov), cam = new THREE.PerspectiveCamera(camFov, width / height, camera.near, camera.far);
      cam.position.fromArray(p[0]); cam.quaternion.fromArray(q[0]); names.set(cam, `CAM_${shot.id}`); scene.add(cam); proxies.push(cam);
      const moving = p.some((v) => v.some((n, k) => Math.abs(n - p[0][k]) > 1e-6)) || q.some((v) => v.some((n, k) => Math.abs(n - q[0][k]) > 1e-6));
      if (moving) { const frameTimes = Float32Array.from(frames, (f) => f / fps); tracks.push(new THREE.VectorKeyframeTrack(`${cam.uuid}.position`, frameTimes, p.flat()), new THREE.QuaternionKeyframeTrack(`${cam.uuid}.quaternion`, frameTimes, q.flat())); }
      shotEntries.push({id: shot.id, label: shot.label, camera: `CAM_${shot.id}`, startFrame: frames[0], endFrame: frames.at(-1), fov: camFov, lens: 12 / Math.tan(deg(camFov) / 2), ...(shot.camera.aspect ? {aspect: shot.camera.aspect} : {}), near: camera.near, far: camera.far});
    }
    cableRecs.forEach((C, k) => {
      if (!C.ever) return;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(.006, .006, 1, 6, 1), new THREE.MeshStandardMaterial({color: C.line.material.color, metalness: .6, roughness: .35}));
      firstOf(mesh, C); mesh.scale.fromArray(C.s.first); names.set(mesh, `FX_cable_${k + 1}`); scene.add(mesh); proxies.push(mesh); addTracks(mesh, C);
    });
    // 5. 节点名：人物关节 / 道具 / 场景节点用可读英文名（Blender 名称限 63 字节），其余按父节点编号
    const known = new Map([[world, 'SET'], [world.children[0], 'FLOOR'], [fxGroup, 'FX']]);
    for (const [sid, obj] of setObjects) known.set(obj, `SET_${sid}`);
    for (const [aid, v] of actors) {
      known.set(v.root, `ACT_${aid}`); for (const part of ['body', 'torso', 'neck', 'head']) if (v[part]) known.set(v[part], `${aid}_${{body: 'hips', torso: 'chest'}[part] || part}`);
      for (const side of ['L', 'R']) { const a = v.arms?.[side], l = v.legs?.[side]; if (a) { known.set(a.sh, `${aid}_upperarm_${side}`); known.set(a.el, `${aid}_forearm_${side}`); known.set(a.hand, `${aid}_hand_${side}`); } if (l) { known.set(l.hip, `${aid}_thigh_${side}`); known.set(l.knee, `${aid}_shin_${side}`); } }
      for (const [pn, obj] of Object.entries(v.points || {})) if (!known.has(obj)) known.set(obj, `${aid}_pt_${pn}`);
    }
    for (const [pid, item] of props) known.set(item.group, `PROP_${pid}`);
    for (const [key, obj] of points) if (!known.has(obj)) known.set(obj, key.startsWith('set.') ? `SET_${key.slice(4)}` : `PROP_${key.replace('.', '_pt_')}`);
    const unique = (base) => { let name = nameSafe(base).slice(0, 56), k = 2; while (used.has(name)) name = `${nameSafe(base).slice(0, 52)}_${k++}`; used.add(name); return name; };
    for (const [obj, name] of names) names.set(obj, unique(name));
    const nameTree = (obj, parentName) => {
      let k = 0;
      for (const child of obj.children) {
        if (!child.visible) continue;
        if (!names.has(child)) names.set(child, unique(known.get(child) || `${parentName ? parentName + '_' : ''}${child.isBone ? 'bone' : child.isSkinnedMesh ? 'skin' : child.isMesh ? 'mesh' : child.isCamera ? 'cam' : 'grp'}${++k}`));
        nameTree(child, names.get(child));
      }
    };
    nameTree(scene, '');
    for (const [obj, name] of names) setTemp(obj, 'name', name);
    // 6. 轨道（只给真正导出的节点；任何一条对不上节点，GLTFExporter 会丢掉整段动画）
    for (const n of nodes) if (n.ever && visibleChain(n.obj)) addTracks(n.obj, n);
    const exported = new Set(); scene.traverse((o) => { if (visibleChain(o)) exported.add(o.uuid); });
    const goodTracks = tracks.filter((track) => exported.has(track.name.slice(0, track.name.lastIndexOf('.'))));
    // 7. 材质命名；会闪的发光材质导出时取最亮值，逐帧强度交给 blender_setup.py
    const matEntries = [], matNames = new Set(), seenMats = new Set();
    scene.traverse((o) => { if (!o.isMesh || !visibleChain(o)) return; for (const m of [o.material].flat()) if (m && !seenMats.has(m)) {
      seenMats.add(m);
      const base = `MAT_${m.color ? m.color.getHexString() : 'x'}${m.isMeshBasicMaterial ? '_unlit' : ''}`; let name = base, k = 2; while (matNames.has(name)) name = `${base}_${k++}`;
      matNames.add(name); setTemp(m, 'name', name);
      const values = matRecs.get(m), keys = values ? compressKeys(Array.from(values)) : null;
      if (keys) { setTemp(m, 'emissiveIntensity', Math.max(...values)); matEntries.push({name, emissive: m.emissive.toArray(), keys}); }
    } });
    const actorEntries = config.actors.map((actor) => ({id: actor.id, label: actor.label, node: `ACT_${actor.id}`}));
    const propEntries = config.props.map((prop) => ({id: prop.id, label: prop.label || prop.id, node: `PROP_${prop.id}`}));
    const data = {version: 1, generator: 'ZPboom.AI 3D 预演', title: config.title, fps, frames: total, duration: config.duration, aspectRatio: aspect, projectAspect: config.aspectRatio, fit, resolution: [width, height],
      exposure: config.world.exposure, toneMapping: 'ACESFilmic', background: scene.background?.isColor ? scene.background.toArray() : [0, 0, 0], fog: config.world.fog || null,
      ambient: ambientEntries,
      weather: weather?.summary() || null, shots: shotEntries, cues: config.cues.map((cue) => ({frame: Math.min(total - 1, Math.round(cue.time * fps)), label: cue.label})), lights: lightEntries, materials: matEntries, actors: actorEntries, props: propEntries};
    // 8. 导出
    status('正在打包 GLB…'); await new Promise((resolve) => setTimeout(resolve, 0));
    const clip = new THREE.AnimationClip('ZPboom_previs', config.duration, goodTracks);
    const glb = await new GLTFExporterClass().parseAsync(scene, {binary: true, trs: true, onlyVisible: true, animations: goodTracks.length ? [clip] : [], maxTextureSize: 2048});
    const buffer = patchGlb(glb, (json) => {
      json.asset.generator = `ZPboom.AI 3D previs · THREE.GLTFExporter r${THREE.REVISION}`; json.extras = {zpboom: data};
      for (const skin of json.skins || []) delete skin.skeleton; // 两块骨骼不在同一条链上，去掉可选的 skeleton 字段
    });
    const blob = new Blob([buffer], {type: 'model/gltf-binary'}), filename = `${config.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'previs'}_blender.glb`;
    if (save) download(blob, filename);
    const summary = {blob, filename, bytes: blob.size, frames: total, fps, tracks: goodTracks.length, droppedTracks: tracks.length - goodTracks.length, shots: shotEntries.length, lights: lightEntries.length, cables: cableRecs.filter((c) => c.ever).length};
    status(`已导出 ${filename}（${(blob.size / 1048576).toFixed(1)}MB · ${total} 帧 · ${shotEntries.length} 台镜头相机 · ${lightEntries.length} 盏灯）。用工程里的 blender_setup.py 在 Blender 中生成 .blend`);
    return summary;
  } catch (error) { status(`Blender 导出未完成：${error.message}`); throw error; }
  finally {
    for (const px of proxies) { scene.remove(px); px.geometry?.dispose(); px.material?.dispose?.(); px.dispose?.(); }
    for (const fn of undo.reverse()) fn();
    exporting = null; setRecordingUI(false); setRecordLabel('导出 MP4', false);
    outFit = null; $('helpers').checked = before.helpers; setHelperVisibility(); if (!document.body.classList.contains('clean')) editor?.resume(); seek(before.time);
  }
}
$('blender').addEventListener('click', () => openExportDialog('blender'));
$('record').addEventListener('click', async () => {
  if (exporting) { exporting.cancel = true; return; }
  if (recording) { stopRecording(); return; }
  openExportDialog('mp4');
});
/* 导出设置：画幅（跟随工程或任选）、适配方式（裁切 / 扩展）、清晰度；MP4 和 Blender 共用 */
let exportTarget = 'mp4';
function updateExportNote() {
  const a = $('ex-aspect').value || config.aspectRatio, [w, h] = sizeFor(a, Number($('ex-short').value)), a0 = aspectNum(config.aspectRatio), a1 = w / h, fit = $('ex-fit').value;
  const same = Math.abs(a1 - a0) < 1e-3, wider = a1 > a0;
  $('ex-fit-row').hidden = same;
  const modeText = exportTarget === 'mp4' ? {lit: '原样光照', lift: `提亮参考（${Math.round(liftFor('lift') * 100)}%）`, flat: '白膜平光', depth: '深度图'}[$('ex-mode').value] + ' · ' : '';
  $('ex-note').textContent = `${modeText}输出 ${w}×${h}（${a}）· 工程画幅 ${config.aspectRatio}` + (same ? '' : fit === 'crop' ? (wider ? ' · 裁切：画面宽度不变、上下裁掉（和「取景参考线」一致）' : ' · 裁切：画面高度不变、左右裁掉（和「取景参考线」一致）') : (wider ? ' · 扩展：画面高度不变、左右多看到场景' : ' · 扩展：画面宽度不变、上下多看到场景'));
}
let lastMeasure = null;
function darkText(rows) { const dark = rows.filter((r) => r.lum < DARK_LUM); return dark.length ? `${dark.length} 个镜头画面过暗：${dark.slice(0, 4).map((r) => `${r.label.split(' ')[0]}（${Math.round(r.lum * 100)}%）`).join('、')}${dark.length > 4 ? ' 等' : ''}` : ''; }
async function refreshDarkness(showInDialog = false) {
  lastMeasure = await measureShots(); const txt = darkText(lastMeasure), darkest = lastMeasure.reduce((a, b) => (b.lum < a.lum ? b : a), lastMeasure[0]);
  $('lift-note').textContent = txt ? `${txt}。视频模型需要看清人物和动作，建议提亮或点「自动」；夜晚等氛围写进生成提示词。` : `最暗的镜头 ${darkest.label.split(' ')[0]} 亮度 ${Math.round(darkest.lum * 100)}%，够看清。`;
  $('lift-note').classList.toggle('warn', Boolean(txt));
  if (showInDialog) { $('ex-dark').hidden = !txt || exportTarget !== 'mp4'; $('ex-dark-text').textContent = txt ? `${txt}（亮度低于 ${Math.round(DARK_LUM * 100)}%）` : ''; }
  return txt;
}
async function setLift(L, label) { const before = editor?.beginEdit(); if (L > 0) config.world.lift = L; else delete config.world.lift; editor?.endEdit(label, before); draw(); updateUI(true); }
$('lift-range').addEventListener('input', () => { if (!liftBefore) liftBefore = editor?.beginEdit(); const v = Number($('lift-range').value); if (v > 0) config.world.lift = v; else delete config.world.lift; $('lift-v').textContent = `${Math.round(v * 100)}%`; draw(); });
let liftBefore = null;
$('lift-range').addEventListener('change', async () => { if (liftBefore) { editor?.endEdit(`参考提亮改为 ${Math.round((config.world.lift || 0) * 100)}%`, liftBefore); liftBefore = null; } await refreshDarkness(); status(`参考提亮 ${Math.round((config.world.lift || 0) * 100)}%（只影响预览和「提亮参考」导出，故事光照不变）· Ctrl+Z 撤销`); });
$('lift-auto').addEventListener('click', async () => { if (exporting) return; status('正在测每个镜头的亮度…'); const L = await autoLift(); await setLift(L, `参考提亮自动设为 ${Math.round(L * 100)}%`); await refreshDarkness(); status(L ? `已自动提亮到 ${Math.round(L * 100)}%，每个镜头都看得清 · Ctrl+Z 撤销` : '每个镜头都够亮，不需要提亮'); });
$('ex-dark-fix').addEventListener('click', async () => { $('ex-dark-text').textContent = '正在计算…'; const L = await autoLift(); await setLift(L, `参考提亮自动设为 ${Math.round(L * 100)}%`); $('ex-mode').value = 'lift'; await refreshDarkness(true); updateExportNote(); });
function openExportDialog(target) {
  if (!config || exporting || recording) return;
  exportTarget = target; $('ex-title').textContent = target === 'mp4' ? '导出 MP4' : '导出 Blender（GLB + blender_setup.py）';
  $('ex-go').textContent = target === 'mp4' ? '开始导出 MP4' : '开始导出 GLB';
  if (!$('ex-aspect').dataset.ready) { $('ex-aspect').replaceChildren(...[['', '跟随工程'], ...ASPECTS.map((a) => [a, a === '21:9' ? '21:9 宽银幕' : a])].map(([v, t]) => Object.assign(document.createElement('option'), {value: v, textContent: t}))); $('ex-aspect').dataset.ready = '1'; }
  $('ex-mode-row').hidden = target !== 'mp4'; $('ex-dark').hidden = true;
  updateExportNote(); $('export-dialog').showModal();
  refreshDarkness(true).then((txt) => { if (target === 'mp4') { $('ex-mode').value = txt || config.world.lift ? 'lift' : 'lit'; updateExportNote(); } });
}
for (const id of ['ex-aspect', 'ex-fit', 'ex-short', 'ex-mode']) $(id).addEventListener('change', updateExportNote);
$('ex-cancel').addEventListener('click', () => $('export-dialog').close());
$('ex-go').addEventListener('click', async () => {
  const opts = {aspect: $('ex-aspect').value || undefined, fit: $('ex-fit').value, short: Number($('ex-short').value), mode: $('ex-mode').value}; $('export-dialog').close();
  if (exportTarget === 'blender') { exportBlender(opts).catch((error) => console.error(error)); return; }
  if (await mp4Size(opts.aspect || config.aspectRatio, opts.short)) { exportMp4(opts).catch(() => {}); return; }
  status('此浏览器不支持逐帧 MP4 编码，改用实时 WebM 录制'); recordWebm();
});
function animate(now) {
  requestAnimationFrame(animate);
  const delta = Math.max(0, (now - previousFrame) / 1000); previousFrame = now;
  if (!config || exporting) return;
  if (playing) {
    currentTime = Math.min(config.duration, currentTime + delta); draw(); updateUI();
    if (currentTime >= config.duration) { playing = false; updateUI(true); if (recording) setTimeout(stopRecording, Math.max(120, 2000 / config.fps)); }
  } else if (cameraDirty) { render(); cameraDirty = false; }
}


/* ───────── 当场编辑：给 editor.js 用的引擎接口 ───────── */
function actorKeyAt(actor, t, overrides = {}) {
  const cur = sampleActor(actor.keyframes, t), r4 = (n) => Number(n.toFixed(4));
  const frame = {time: Number(t.toFixed(6)), position: cur.position.map(r4), yaw: r4(cur.yaw), pose: cur.poseName};
  for (const field of actorFieldsFor(actor)) frame[field] = r4(cur[field]);
  for (const field of ['armL', 'armR']) if (actor.keyframes.some((key) => key[field] !== undefined)) frame[field] = cur[field];
  for (const side of ['reachL', 'reachR']) if (cur[side]?.w > 0) { frame[side] = {target: cur[side].target, w: r4(cur[side].w)}; if (cur[side].pos) frame[side].pos = cur[side].pos.map(r4); }
  return {...frame, ...overrides};
}
function refreshActor(id) { const actor = config.actors.find((a) => a.id === id), v = actors.get(id); if (actor && v) { v.actor = actor; v.gait = buildGait(actor); } }
function keysChanged(keys, lane) { tangentCache.delete(keys); keys.sort((a, b) => a.time - b.time); if (lane?.kind === 'actor') refreshActor(lane.id); }
function rebaseRig(obj) { // 拖动带结构动画的场景物件后，把新位置当作结构动画的基准
  weather?.invalidate(); // 场景物件挪了，雨雪遮挡重新算
  for (const rig of config.rigs) { const value = sampleValue(rig.keyframes, currentTime, 'value');
    for (const b of rigBindings.get(rig.id) || []) if (b.obj === obj) { const v = value * b.scale + b.offset; b.base = b.mode === 'translate' ? obj.position[b.axis] - v : obj.rotation[b.axis] - deg(v); } }
}
async function restoreConfig(snap) {
  const t = currentTime, same = (k) => JSON.stringify(snap[k]) === JSON.stringify(config[k]);
  if (!['set', 'kinds', 'lights', 'world', 'fx', 'motions', 'poses', 'extensions', 'title', 'duration', 'fps', 'aspectRatio'].every(same)) {
    restoring = true; try { await applyConfig(clone(snap)); } finally { restoring = false; } seek(Math.min(t, config.duration)); return;
  }
  for (const k of ['actors', 'props', 'shots', 'rigs', 'cues']) config[k] = clone(snap[k] || []);
  if (snap.weather) config.weather = clone(snap.weather); else delete config.weather;
  for (const actor of config.actors) refreshActor(actor.id);
  for (const prop of config.props) { const item = props.get(prop.id); if (!item) continue; item.prop = prop; item.grip = prop.options.grip || ext.propKinds[prop.kind]?.grip || GRIP_DEFAULTS[prop.kind] || {p: [0, 0, 0], r: [0, 0, 0]}; item.holder = null; }
  buildTimeline(); buildKeyMarks(); seek(t);
}
const viewCtx = {
  THREE, $, canvas, get scene() { return scene; }, get camera() { return camera; }, get shotCam() { return shotCam; }, get config() { return config; }, get editor() { return editor; },
  manualTarget, shotTarget: () => cameraTarget, time: () => currentTime, busy: () => Boolean(exporting || recording), status, shotAt, smoothSample, interval, clamp, deg,
  get free() { return freeCamera; }, set free(v) { freeCamera = v; $('free-camera').checked = v; }, get top() { return topView; }, set top(v) { topView = v; },
  redraw: () => { draw(); updateUI(true); }, requestRender: () => { cameraDirty = true; }, fill: () => fillInspector(), upsert, tangentCache,
  rebuildTimeline: () => { buildTimeline(); buildKeyMarks(); }, seek, updateUI, ASPECTS, aspectNum,
};
/* 视频动捕预览：识别结果先临时套到所选角色上看（不写进工程、不进撤销），满意了再「加到角色」。
   预览期间这个角色只播放预览动作（关键帧位置、姿态照旧），用一台正对角色的预览相机单独渲染：只显示这个角色 + 浅灰地面 + 中性光。 */
const PV_ID = '__mocap_preview__', PV_CLIP = {motion: PV_ID, start: 0, offset: 0, speed: 1, weight: 1, fadeIn: 0, fadeOut: 0, loop: false, rootMotion: false, hold: true};
let mocapPreview = null, pvCam = null, pvStage = null; const PV_BG = new THREE.Color('#eef1f4');
function renderMocapPreview(target, actorId, data, u, opts = {}) {
  const v = actors.get(actorId); if (!v || !data) return null;
  if (mocapPreview?.data !== data || mocapPreview.actorId !== actorId || !motions.has(PV_ID)) { mocapPreview = {actorId, data}; motions.set(PV_ID, buildPoseMotion(data, 'preview')); editor?.suspend(); }
  // 按「起点 + 动作时间」取那一刻的关键帧（站位、手部接触等），并套用所选的覆盖方式，预览和真正加进去的结果一致
  mocapPreview.u = u; mocapPreview.override = opts.override || null; mocapPreview.at = opts.at ?? currentTime;
  const keepTime = currentTime; currentTime = clamp(mocapPreview.at + u, 0, config.duration); try { updateScene(); } finally { currentTime = keepTime; }
  const ground = v.root.getWorldPosition(new THREE.Vector3()), s = v.s;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(v.root.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize(); // 人物正面是本地 -Z
  const dir = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), .45), aim = ground.clone().add(new THREE.Vector3(0, 1.0 * s, 0)); // 头顶上方留出跳起的空间
  pvCam ||= new THREE.PerspectiveCamera(32, 1, .05, 200);
  pvCam.aspect = canvas.width / canvas.height; pvCam.position.copy(aim).addScaledVector(dir, 5.2 * s).add(new THREE.Vector3(0, .2 * s, 0)); pvCam.lookAt(aim); pvCam.updateProjectionMatrix();
  // 只看这个角色：场景里其他东西（墙、柱子、别的角色、场景灯、雾）暂时藏起来，换成浅灰地面 + 中性光，不会被挡住、夜景也看得清
  if (!pvStage) {
    pvStage = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({color: '#d9dde2', roughness: 1})); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    const grid = new THREE.GridHelper(40, 80, '#aab2bb', '#c4cad1'); grid.position.y = .002;
    const sun = new THREE.DirectionalLight('#ffffff', 2.2); sun.position.set(2.5, 6, 3.5); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, {left: -3, right: 3, top: 3, bottom: -3, near: .5, far: 20}); sun.shadow.bias = -.0005;
    pvStage.add(floor, grid, sun, sun.target, new THREE.HemisphereLight('#ffffff', '#9aa3ad', 1.4));
  }
  pvStage.position.set(ground.x, ground.y, ground.z); pvStage.children[2].target.position.set(0, 0, 0);
  const hidden = []; for (const o of scene.children) if (o !== v.root && o.visible) { o.visible = false; hidden.push(o); }
  const was = {fog: scene.fog, bg: scene.background, exp: renderer.toneMappingExposure};
  scene.add(pvStage); scene.fog = null; scene.background = PV_BG; renderer.toneMappingExposure = 1;
  renderer.setScissorTest(false); renderer.render(scene, pvCam);
  scene.remove(pvStage); for (const o of hidden) o.visible = true; scene.fog = was.fog; scene.background = was.bg; renderer.toneMappingExposure = was.exp;
  const g = target.getContext('2d'), ta = target.width / target.height, ca = canvas.width / canvas.height;
  const sw = ca > ta ? canvas.height * ta : canvas.width, sh = ca > ta ? canvas.height : canvas.width / ta;
  g.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, target.width, target.height);
  const low = Math.min(v.points.foot_L.getWorldPosition(new THREE.Vector3()).y, v.points.foot_R.getWorldPosition(new THREE.Vector3()).y);
  return {foot: low - ground.y};
}
function endMocapPreview() { if (!mocapPreview) return; mocapPreview = null; motions.delete(PV_ID); if (!document.body.classList.contains('clean')) editor?.resume(); draw(); }
const mocapCtx = {THREE, $, renderPreview: renderMocapPreview, endPreview: endMocapPreview, clipWindow, get config() { return config; }, get editor() { return editor; }, time: () => currentTime, busy: () => Boolean(exporting || recording), status, POSE_PTS,
  reloadMotions: async () => { await loadMotions(config.motions); for (const a of config.actors) refreshActor(a.id); buildKeyMarks(); draw(); updateUI(true); }};
const weatherApi = {WEATHER_FIELDS, WEATHER_PRESETS, get weather() { return weather; }};
const editorCtx = {
  THREE, $, get scene() { return scene; }, get camera() { return camera; }, canvas, get config() { return config; }, actors, props,
  time: () => currentTime, busy: () => Boolean(exporting || recording), status, clone, upsert, download, validateConfig,
  sampleActor, actorKeyAt, refreshActor, POSE_KEYS, STAND, poses: () => POSES, pointNames: () => [...points.keys()], keysChanged, rebaseRig, restoreConfig, shotAt, clipWindow,
  cameraTarget: () => (freeCamera ? manualTarget : cameraTarget), viewCam, isTop: () => topView, extraPick: (rc) => view?.pick(rc),
  cameraPose: () => { if (freeCamera) return {pos: camera.position.toArray(), target: manualTarget.toArray()}; const shot = shotAt(currentTime), lt = currentTime - shot.start; return {pos: smoothSample(shot.camera.keyframes, lt, 'position'), target: smoothSample(shot.camera.keyframes, lt, 'target')}; }, get shotCam() { return shotCam; }, seek, seekQuiet: (t) => { currentTime = clamp(t, 0, config.duration); draw(); updateUI(true); },
  redraw: () => { draw(); updateUI(true); }, requestRender: () => { cameraDirty = true; }, weatherApi, ASPECTS, aspectNum, applyAspectLayout, resize: () => resize(),
};

/* 扩展模块拿到的接口：在工程里写 extra.js，scene.json 写 "extensions": ["extra.js"] */
const api = {
  THREE, get scene() { return scene; }, get config() { return config; }, point: resolvePoint, material: materialFor, box,
  registerSetType(name, build) { ext.setTypes[name] = build; },
  registerPropKind(name, build, grip) { ext.propKinds[name] = {build, grip}; },
  registerFx(name, build) { ext.fx[name] = build; },
  onDraw(fn) { ext.onDraw.push(fn); },
};

async function init() {
  try {
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true}); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene = new THREE.Scene(); buildRefLights(); weather = initWeather({THREE, scene, get config() { return config; }, world: () => world, smoothSample}); camera = new THREE.PerspectiveCamera(40, 16 / 9, .05, 200); shotCam = new THREE.PerspectiveCamera(40, 16 / 9, .05, 200);
    const response = await fetch('./scene.json', {cache: 'no-store'}); if (!response.ok) throw new Error(`scene.json HTTP ${response.status}`);
    const raw = await response.json(); await applyConfig(clone(raw)); initialConfig = clone(config);
    editor = initEditor(editorCtx); view = initViewTools(viewCtx); buildTimeline(); editor.onConfig(); editor.checkDraft(); resize();
    setTimeout(() => refreshDarkness().then((txt) => { if (txt) status(`${txt}：视频模型需要看清画面，可在「镜头」页点「参考提亮 · 自动」，导出时选「提亮参考」`); }).catch(() => {}), 300);
    new ResizeObserver(resize).observe($('stage')); resize(); requestAnimationFrame(animate); status(missingMotions.length ? `缺少动作文件，暂用关键帧：${missingMotions.join('、')}（放进工程后刷新即可）` : '预演已就绪；点画面里的人物 / 道具 / 场景可直接拖动编辑，Ctrl+S 保存到 scene.json');
    window.__ZPBOOM_PREVIS__ = {
      ready: true, threeRevision: THREE.REVISION, seek,
      renderAt: (seconds) => { seek(seconds); return window.__ZPBOOM_PREVIS__.getState(); },
      getConfig: () => clone(config), validateConfig, loadConfig: async (raw2) => { await applyConfig(raw2); return true; },
      point: (value) => { const p = resolvePoint(value); return p ? p.getWorldPosition(new THREE.Vector3()).toArray().map((n) => Number(n.toFixed(3))) : null; },
      getState: () => ({time: currentTime, duration: config.duration, fps: config.fps, playing, shot: shotAt(currentTime).id, clean: document.body.classList.contains('clean'),
        camera: {position: shotCam.position.toArray(), target: cameraTarget.toArray(), fov: shotCam.fov}, view: {mode: topView ? 'top' : freeCamera ? 'free' : 'shot', position: viewCam().position.toArray()},
        actors: config.actors.map((actor) => { const v = actors.get(actor.id), out = {id: actor.id, position: v.root.position.toArray(), yaw: v.root.rotation.y, armL: v.arms.L.sh.visible, armR: v.arms.R.sh.visible, clip: v.activeClip || null};
          for (const name of ['hand_L', 'hand_R', 'head']) out[name] = v.points[name].getWorldPosition(new THREE.Vector3()).toArray().map((n) => Number(n.toFixed(3)));
          return out; }),
        props: [...props.values()].map(({prop, group, holder}) => ({id: prop.id, owner: prop.owner, holder, visible: group.visible, world: group.getWorldPosition(new THREE.Vector3()).toArray().map((n) => Number(n.toFixed(3)))})),
        rigs: config.rigs.map((rig) => ({id: rig.id, value: sampleValue(rig.keyframes, currentTime, 'value')})),
        fx: fxItems.map((item) => ({type: item.cfg.type, active: Boolean(item.state?.())}))}),
      exportMp4, exportBlender, openExportDialog, measureShots, autoLift, setClean, mocapModule: () => import('./videomocap.js?v=2.7.3'), get mocapCtx() { return mocapCtx; },
      frameInMode: (mode, t) => { const was = $('helpers').checked; $('helpers').checked = false; setHelperVisibility(); editor?.suspend(); enterMode(mode); currentTime = t; draw(); const url = canvas.toDataURL('image/jpeg', .8); exitMode(); $('helpers').checked = was; setHelperVisibility(); editor?.resume(); draw(); return url; }, get editor() { return editor; }, weatherAt: (t) => weather?.sample(t ?? currentTime) || null, get view() { return view; },
      screenOf: (p) => { const v = new THREE.Vector3(...p).project(viewCam()), r = canvas.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }, setHelpers: (visible) => { $('helpers').checked = Boolean(visible); setHelperVisibility(); draw(); }
    };
  } catch (error) { $('error').hidden = false; $('error').textContent = `预演未能启动：${error.message}\n\n请通过本地 HTTP 服务打开，例如：python3 -m http.server 8000。不要直接双击 index.html。浏览器需支持 WebGL。`; status('初始化失败'); console.error(error); }
}
init();
