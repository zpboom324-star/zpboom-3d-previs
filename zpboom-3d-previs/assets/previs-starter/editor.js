/* ZPboom.AI 3D 预演 · 当场编辑（第一期）
   画面里点选人物 / 道具 / 场景物件 → 移动 / 旋转 / 缩放手柄；自动关键帧可开关（关闭时按 K 才记）；
   时间线每个对象一条关键帧轨道（点选、拖动改时间、删除、复制粘贴、缓动）；撤销 / 重做；Ctrl+S 直接保存 scene.json；自动草稿。
   只通过 ctx 读写引擎，界面风格沿用模板。 */
import {TransformControls} from './vendor/addons/controls/TransformControls.js';

export function initEditor(ctx) {
  const {THREE, $} = ctx;
  const DRAFT_KEY = `zpboom-draft:${location.pathname}`, AUTOKEY_KEY = 'zpboom-autokey';
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let selection = null, selKey = null, pending = null, clipboard = null, suspended = false, dirty = false, fileHandle = null;
  let mode = 'translate', dragStart = null, gizmoDragging = false, lastDragEnd = 0;
  const undoStack = [], redoStack = [];
  const store = {get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 无痕模式 */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* */ } }};

  // ───────── 手柄与选中框 ─────────
  const gizmo = new TransformControls(ctx.viewCam(), ctx.canvas);
  gizmo.setSize(.8); gizmo.userData.editor = true;
  const bounds3 = new THREE.Box3(), box = new THREE.Box3Helper(bounds3, 0xff5a36); box.userData.editor = true; box.material.depthTest = false; box.material.transparent = true; box.renderOrder = 999; box.visible = false;
  box.setFromObject = (root) => { // 只框实体网格，不框名字标签等辅助物体
    bounds3.makeEmpty(); root.updateWorldMatrix(true, true);
    root.traverse((o) => { if (!(o.isMesh || o.isSkinnedMesh) || !o.visible) return; for (let p = o; p && p !== root.parent; p = p.parent) if (p.userData.helper || !p.visible) return; bounds3.expandByObject(o, true); });
    if (bounds3.isEmpty()) bounds3.setFromCenterAndSize(root.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(.3, .3, .3));
  };
  ctx.scene.add(gizmo, box);
  gizmo.addEventListener('dragging-changed', (e) => { gizmoDragging = e.value; if (e.value) dragStart = snapshotTransform(); else { lastDragEnd = performance.now(); commitTransform(false); } });
  gizmo.addEventListener('objectChange', () => { if (selection) box.setFromObject(selection.obj); ctx.requestRender(); fillSelected(); });
  gizmo.addEventListener('change', () => ctx.requestRender());

  $('autokey').checked = store.get(AUTOKEY_KEY) === '1';
  $('autokey').addEventListener('change', () => { store.set(AUTOKEY_KEY, $('autokey').checked ? '1' : '0'); ctx.status($('autokey').checked ? '自动关键帧：开（拖动后在播放头处自动记关键帧）' : '自动关键帧：关（拖动后按 K 或「记关键帧」才保存）'); });

  // ───────── 检查器分页 ─────────
  const TAB_KEY = 'zpboom-insp-tab';
  function showTab(name) { $('inspector').dataset.active = name; for (const b of document.querySelectorAll('[data-tab-btn]')) b.classList.toggle('active', b.dataset.tabBtn === name); store.set(TAB_KEY, name); }
  for (const b of document.querySelectorAll('[data-tab-btn]')) b.addEventListener('click', () => showTab(b.dataset.tabBtn));
  showTab(store.get(TAB_KEY) || 'object');
  // 角色卡片里点人物标签 = 在画面里选中这个人物（姿态卡片跟着切换）
  $('actor-select').addEventListener('change', () => { const id = $('actor-select').value, v = ctx.actors.get(id); if (v && !(selection?.type === 'actor' && selection.id === id)) select(targetFrom(v.root)); });
  // 轨道名字列和轨道区同步上下滚动
  $('tl-keys').addEventListener('scroll', () => { $('lane-labels').scrollTop = $('tl-keys').scrollTop; });
  $('lane-labels').addEventListener('scroll', () => { $('tl-keys').scrollTop = $('lane-labels').scrollTop; });

  // ───────── 工程画幅：顶栏下拉，可撤销 ─────────
  $('aspect-select').addEventListener('change', () => {
    const v = $('aspect-select').value, prev = ctx.config.aspectRatio; if (v === prev || ctx.busy()) { $('aspect-select').value = prev; return; }
    const before = ctx.clone(ctx.config); ctx.config.aspectRatio = v;
    undoStack.push({label: `工程画幅 ${prev} → ${v}`, config: before}); redoStack.length = 0; markDirty();
    ctx.applyAspectLayout(); ctx.resize(); ctx.status(`工程画幅改为 ${v}：各镜的竖直视角不变，画面变宽 / 变窄 · Ctrl+Z 撤销 · 导出时还可以另选画幅`);
  });

  // ───────── 人物白膜造型：顶栏下拉，可撤销（只换外形，动作、IK、道具挂点不变）─────────
  $('figure-select').addEventListener('change', async () => {
    const v = $('figure-select').value, prev = ctx.config.world.figure || 'jointed'; if (v === prev || ctx.busy()) { $('figure-select').value = prev; return; }
    const before = ctx.clone(ctx.config), next = ctx.clone(ctx.config); next.world.figure = v;
    await ctx.restoreConfig(next);
    undoStack.push({label: `人物白膜 ${prev === 'pill' ? '简化胶囊' : '精细白膜'} → ${v === 'pill' ? '简化胶囊' : '精细白膜'}`, config: before}); redoStack.length = 0; markDirty();
    ctx.status(v === 'pill' ? '人物换成简化胶囊白膜：球头 + 可弯曲胶囊身体，动作不变 · Ctrl+Z 撤销' : '人物换回精细关节白膜 · Ctrl+Z 撤销');
  });

  // ───────── 选择 ─────────
  function targetFrom(object) {
    const config = ctx.config;
    for (let o = object; o; o = o.parent) {
      if (o.userData.helper || o.userData.editor) return null;
      for (const [id, v] of ctx.actors) if (v.root === o) return {type: 'actor', id, obj: o, label: config.actors.find((a) => a.id === id)?.label || id};
      for (const [id, item] of ctx.props) if (item.group === o) return {type: 'prop', id, obj: o, label: item.prop.label || id};
    }
    let pick = null;
    for (let o = object; o; o = o.parent) if (o.userData.node) { if (!pick) pick = o; if (o.userData.node.id) { pick = o; break; } }
    return pick ? {type: 'set', obj: pick, node: pick.userData.node, label: pick.userData.node.id || pick.userData.node.type} : null;
  }
  function select(target) {
    if (selection?.dispose && selection !== target) selection.dispose();
    selection = target; selKey = null; pending = null; $('insert-key').classList.remove('pending');
    if (!target || suspended) { gizmo.detach(); box.visible = false; }
    else { gizmo.attach(target.obj); box.setFromObject(target.obj); box.visible = true; applyMode(); }
    if (target?.type === 'actor' || target?.type === 'prop') showTab('object'); else if (target?.type === 'custom' && target.obj.userData.camKey) showTab('camera');
    if (target?.type === 'actor' && $('actor-select').value !== target.id) { $('actor-select').value = target.id; $('actor-select').dispatchEvent(new Event('change')); }
    fillSelected(); buildLanes(); fillPose(true); ctx.requestRender();
  }
  function applyMode() {
    if (!selection) return;
    let m = mode;
    if (selection.type === 'custom') m = 'translate';
    if (m === 'scale' && selection.type !== 'set') m = 'translate';
    gizmo.setMode(m);
    const yawOnly = selection.type === 'actor' && m === 'rotate';
    gizmo.showX = !yawOnly; gizmo.showZ = !yawOnly; gizmo.showY = true;
    gizmo.setSpace(selection.type === 'prop' && heldProp(selection.id) ? 'local' : 'world');
    for (const b of document.querySelectorAll('.edit-tools [data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
  }
  function setMode(next) { mode = next; applyMode(); ctx.requestRender(); }
  for (const b of document.querySelectorAll('.edit-tools [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('deselect').addEventListener('click', () => select(null));

  let down = null;
  ctx.canvas.addEventListener('pointerdown', (e) => { down = e.button === 0 ? {x: e.clientX, y: e.clientY} : null; gizmo.camera = ctx.viewCam(); });
  ctx.canvas.addEventListener('pointerup', (e) => {
    if (!down || suspended || ctx.busy() || gizmoDragging || performance.now() - lastDragEnd < 150) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (moved > 4 || gizmo.axis) return;
    const r = ctx.canvas.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.viewCam());
    const extra = ctx.extraPick?.(raycaster); if (extra) { select(extra); return; }
    const hits = raycaster.intersectObjects(ctx.scene.children.filter((o) => !o.userData.editor), true).filter((h) => (h.object.isMesh || h.object.isSkinnedMesh) && visibleChain(h.object));
    for (const h of hits) { const t = targetFrom(h.object); if (t) { select(t); return; } }
    select(null);
  });
  const visibleChain = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  const heldProp = (id) => { const item = ctx.props.get(id); return item && item.holder && item.holder !== 'world' && item.holder !== 'hidden'; };

  // ───────── 提交改动（拖动结束 / 数值面板 / K）─────────
  function snapshotTransform() { const o = selection?.obj; return o ? {p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone()} : null; }
  function yawOf(q, near) { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q); let y = Math.atan2(f.x, f.z); while (y - near > Math.PI) y -= Math.PI * 2; while (y - near < -Math.PI) y += Math.PI * 2; return y; }
  const r4 = (n) => Number(n.toFixed(4)), degs = (e) => [e.x, e.y, e.z].map((n) => r4(THREE.MathUtils.radToDeg(n)));
  function commitTransform(force) {
    if (!selection) return;
    const sel = selection, o = sel.obj, t = ctx.time();
    if (sel.type === 'custom') { edit(sel.label, () => sel.commit(o)); return; }
    if (sel.type === 'set') { // 场景物件是静态摆放，直接改
      edit(`移动场景物件 ${sel.label}`, () => {
        const off = o.userData.repeatOffset || [0, 0, 0];
        sel.node.position = o.position.toArray().map((n, k) => r4(n - off[k]));
        sel.node.rotation = degs(o.rotation); sel.node.scale = o.scale.toArray().map(r4);
        if (sel.node.scale.every((n) => Math.abs(n - 1) < 1e-6)) delete sel.node.scale;
        if (sel.node.rotation.every((n) => Math.abs(n) < 1e-6)) delete sel.node.rotation;
        ctx.rebaseRig(o);
      }, {redraw: false});
      return;
    }
    if (sel.type === 'prop' && heldProp(sel.id)) { // 握在手里：改握持偏移（静态）
      edit(`调整 ${sel.label} 的握持偏移`, () => { const item = ctx.props.get(sel.id); item.prop.options = {...item.prop.options, grip: {p: o.position.toArray().map(r4), r: degs(o.rotation)}}; item.grip = item.prop.options.grip; });
      return;
    }
    const apply = () => {
      if (sel.type === 'actor') {
        const actor = ctx.config.actors.find((a) => a.id === sel.id), cur = ctx.sampleActor(actor.keyframes, t);
        ctx.upsert(actor.keyframes, ctx.actorKeyAt(actor, t, {position: o.position.toArray().map(r4), yaw: r4(yawOf(o.quaternion, cur.yaw))}));
        ctx.refreshActor(actor.id);
      } else {
        const prop = ctx.config.props.find((p) => p.id === sel.id);
        ctx.upsert(prop.keyframes, {time: Number(t.toFixed(6)), holder: 'world', position: o.position.toArray().map(r4), rotation: degs(o.rotation)});
      }
    };
    if (force || $('autokey').checked) { pending = null; $('insert-key').classList.remove('pending'); edit(`${sel.label} 在 ${t.toFixed(2)}s 记关键帧`, apply); }
    else { pending = {apply, label: sel.label}; $('insert-key').classList.add('pending'); ctx.status(`${sel.label} 已移动但还没记关键帧：按 K 或点「记关键帧」保存；拖时间轴会放弃这次改动`); }
  }
  function insertKey() {
    if (ctx.busy()) return;
    if (pending) { const p = pending; pending = null; $('insert-key').classList.remove('pending'); edit(`${p.label} 在 ${ctx.time().toFixed(2)}s 记关键帧`, p.apply); return; }
    if (selection && selection.type !== 'set') { commitTransform(true); return; }
    // 没选中对象：把当前画面（含自由观察）记成当前镜头的相机关键帧
    insertCameraKey();
  }
  function insertCameraKey() {
    if (ctx.busy()) return;
    if (ctx.isTop()) { ctx.status('俯视图下不能记机位：先切到自由观察找好角度'); return; }
    const shot = ctx.shotAt(ctx.time()), pose = ctx.cameraPose(), pos = pose.pos.map(r4), target = pose.target.map(r4);
    edit(`镜头 ${shot.label} 在 ${ctx.time().toFixed(2)}s 记相机关键帧`, () => ctx.upsert(shot.camera.keyframes, {time: Number((ctx.time() - shot.start).toFixed(6)), position: pos, target}));
  }
  $('insert-key').addEventListener('click', insertKey);

  // ───────── 撤销 / 重做 / 脏标记 / 草稿 ─────────
  function edit(label, fn, {redraw = true} = {}) {
    const before = ctx.clone(ctx.config);
    try { fn(); } catch (error) { ctx.status(`没有改动：${error.message}`); return false; }
    undoStack.push({label, config: before}); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0;
    markDirty(); buildLanes(); if (redraw) ctx.redraw(); else { if (selection) box.setFromObject(selection.obj); ctx.requestRender(); }
    fillSelected(); ctx.status(`${label} · Ctrl+Z 撤销 · Ctrl+S 保存`); return true;
  }
  async function undoRedo(from, to, word) {
    if (!from.length || ctx.busy()) { ctx.status(`没有可${word}的操作`); return; }
    const step = from.pop(); to.push({label: step.label, config: ctx.clone(ctx.config)});
    const keepSel = selection && {type: selection.type, id: selection.id, node: selection.node};
    const tab = $('inspector').dataset.active;
    select(null); await ctx.restoreConfig(step.config); markDirty();
    if (keepSel && (keepSel.type === 'actor' || keepSel.type === 'prop')) { const obj = keepSel.type === 'actor' ? ctx.actors.get(keepSel.id)?.root : ctx.props.get(keepSel.id)?.group; if (obj) select(targetFrom(obj)); }
    showTab(tab); buildLanes(); ctx.status(`已${word}：${step.label}`);
  }
  const undo = () => undoRedo(undoStack, redoStack, '撤销'), redo = () => undoRedo(redoStack, undoStack, '重做');
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
  let draftTimer = null;
  function markDirty() {
    dirty = true; document.body.classList.add('dirty'); $('save').classList.add('dirty');
    clearTimeout(draftTimer); draftTimer = setTimeout(() => store.set(DRAFT_KEY, JSON.stringify({savedAt: Date.now(), title: ctx.config.title, config: ctx.config})), 400);
  }
  function markClean() { dirty = false; document.body.classList.remove('dirty'); $('save').classList.remove('dirty'); clearTimeout(draftTimer); store.del(DRAFT_KEY); }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  async function save() {
    if (ctx.busy()) return;
    const text = JSON.stringify(ctx.config, null, 1) + '\n';
    try { ctx.validateConfig(JSON.parse(text)); } catch (error) { ctx.status(`配置有误，没有保存：${error.message}`); return; }
    if (window.showSaveFilePicker) {
      try {
        if (!fileHandle) fileHandle = await window.showSaveFilePicker({suggestedName: 'scene.json', types: [{description: 'ZPboom 预演配置', accept: {'application/json': ['.json']}}]});
        const w = await fileHandle.createWritable(); await w.write(text); await w.close();
        markClean(); ctx.status(`已保存到 ${fileHandle.name}（之后 Ctrl+S 直接覆盖这个文件）`); return;
      } catch (error) { if (error.name === 'AbortError') { ctx.status('已取消保存'); return; } fileHandle = null; ctx.status(`无法直接写文件（${error.message}），改为下载 scene.json`); }
    }
    ctx.download(new Blob([text], {type: 'application/json'}), 'scene.json'); markClean();
    ctx.status('已下载 scene.json：用它覆盖工程里的同名文件（这个浏览器不支持直接写文件，建议用 Chrome / Edge）');
  }
  $('save').addEventListener('click', save);

  function checkDraft() {
    const raw = store.get(DRAFT_KEY); if (!raw) return;
    let draft; try { draft = JSON.parse(raw); } catch { store.del(DRAFT_KEY); return; }
    if (!draft?.config || JSON.stringify(draft.config) === JSON.stringify(ctx.config)) { store.del(DRAFT_KEY); return; }
    $('draft-time').textContent = new Date(draft.savedAt).toLocaleString(); $('draft-bar').hidden = false;
    $('draft-restore').onclick = async () => { $('draft-bar').hidden = true; try { undoStack.push({label: '恢复草稿前', config: ctx.clone(ctx.config)}); await ctx.restoreConfig(draft.config); markDirty(); buildLanes(); ctx.status('已恢复未保存的草稿；Ctrl+S 保存到 scene.json'); } catch (error) { ctx.status(`草稿无法恢复：${error.message}`); } };
    $('draft-discard').onclick = () => { $('draft-bar').hidden = true; store.del(DRAFT_KEY); ctx.status('已丢弃草稿'); };
  }

  // ───────── 时间线关键帧轨道 ─────────
  function lanes() {
    const c = ctx.config, out = [];
    for (const a of c.actors) out.push({kind: 'actor', id: a.id, label: a.label, color: a.color, keys: a.keyframes, start: 0, end: c.duration, cover: true});
    for (const p of c.props) out.push({kind: 'prop', id: p.id, label: p.label || p.id, keys: p.keyframes, start: 0, end: c.duration, cover: false});
    for (const r of c.rigs) out.push({kind: 'rig', id: r.id, label: r.label || r.id, keys: r.keyframes, start: 0, end: c.duration, cover: true});
    if (c.weather?.keyframes?.length) out.push({kind: 'weather', id: 'weather', label: '天气', color: '#9fb4c8', keys: c.weather.keyframes, start: 0, end: c.duration, cover: false});
    out.push({kind: 'camera', id: 'camera', label: '相机', multi: c.shots.map((s) => ({shot: s, keys: s.camera.keyframes, start: s.start, end: s.end}))});
    return out;
  }
  function laneSelected(l) { return selection && ((l.kind === 'actor' && selection.type === 'actor' && selection.id === l.id) || (l.kind === 'prop' && selection.type === 'prop' && selection.id === l.id)); }
  function buildLanes() {
    const c = ctx.config; if (!c) return;
    const dur = c.duration, labels = [], rows = [];
    for (const l of lanes()) {
      const lab = document.createElement('button'); lab.type = 'button'; lab.className = 'lane-label'; lab.textContent = l.label.split(' · ')[0]; lab.title = l.label;
      if (l.color) lab.style.setProperty('--c', l.color);
      lab.classList.toggle('active', laneSelected(l));
      lab.addEventListener('click', () => { if (l.kind === 'actor') select(targetFrom(ctx.actors.get(l.id).root)); else if (l.kind === 'prop') { const item = ctx.props.get(l.id); if (item.group.visible) select(targetFrom(item.group)); else ctx.status(`${l.label} 此刻是隐藏的，拖到它出现的时间再选`); } });
      labels.push(lab);
      const row = document.createElement('div'); row.className = 'lane'; row.classList.toggle('active', laneSelected(l));
      const groups = l.multi || [{keys: l.keys, start: l.start, end: l.end}];
      for (const g of groups) {
        if (l.kind === 'actor') for (const clip of c.actors.find((a) => a.id === l.id).clips || []) { const [a, b] = ctx.clipWindow(clip), bar = document.createElement('i'); bar.className = 'clip-span'; bar.style.left = `${a / dur * 100}%`; bar.style.width = `${(b - a) / dur * 100}%`; bar.title = `动作片段 ${clip.motion} · ${a.toFixed(2)}–${b.toFixed(2)}s`; row.append(bar); }
        g.keys.forEach((key, idx) => {
          const at = (l.multi ? g.start : 0) + key.time, mark = document.createElement('i'); mark.className = 'key-mark';
          if (l.color) mark.style.setProperty('--c', l.color);
          mark.style.left = `${at / dur * 100}%`;
          mark.title = `${l.label} · ${at.toFixed(2)}s${key.pose ? ' · ' + key.pose : ''}${key.holder ? ' · ' + key.holder : ''}${key.ease ? ' · ' + key.ease : ''}`;
          if (selKey && selKey.key === key) mark.classList.add('selected');
          mark.addEventListener('pointerdown', (e) => startKeyDrag(e, l, g, idx, mark));
          row.append(mark);
        });
        if (l.kind === 'weather') for (const bolt of c.weather.lightning || []) { const b = document.createElement('i'); b.className = 'bolt-mark'; b.style.left = `${bolt.time / dur * 100}%`; b.title = `闪电 · ${bolt.time.toFixed(2)}s`; b.addEventListener('pointerdown', (e) => { e.stopPropagation(); ctx.seek(bolt.time); }); row.append(b); }
      }
      rows.push(row);
    }
    $('lane-labels').replaceChildren(...labels); $('tl-keys').replaceChildren(...rows);
  }
  function keyBounds(g, idx, cover) {
    const keys = g.keys, len = g.end - g.start, step = 1 / ctx.config.fps;
    if (idx === 0) return null; // 第一个关键帧固定在 0
    if (cover && idx === keys.length - 1) return null; // 必须覆盖到结尾
    return [keys[idx - 1].time + step, idx < keys.length - 1 ? keys[idx + 1].time - step : len];
  }
  function startKeyDrag(e, l, g, idx, mark) {
    e.stopPropagation(); e.preventDefault(); if (ctx.busy()) return;
    const key = g.keys[idx]; selKey = {lane: l, group: g, key}; buildLanesSoon();
    if (l.kind === 'actor' || l.kind === 'prop') { const obj = l.kind === 'actor' ? ctx.actors.get(l.id).root : ctx.props.get(l.id).group; if (!laneSelected(l) && obj.visible !== false) { selection = targetFrom(obj); gizmo.attach(obj); box.visible = true; applyMode(); } }
    const offset = l.multi ? g.start : 0, bounds = keyBounds(g, idx, l.cover ?? true), area = $('timeline-area').getBoundingClientRect(), x0 = e.clientX, t0 = key.time;
    let moved = false, before = null;
    let warned = false;
    const move = (ev) => {
      if (!bounds) { if (!warned && Math.abs(ev.clientX - x0) >= 3) { warned = true; ctx.status((l.cover ?? true) ? '第一个和最后一个关键帧固定在开头和结尾，不能拖动' : '第一个关键帧固定在 0 秒，不能拖动'); } return; }
      const dt = (ev.clientX - x0) / area.width * ctx.config.duration;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) { moved = true; before = ctx.clone(ctx.config); }
      const fps = ctx.config.fps; key.time = Math.min(bounds[1], Math.max(bounds[0], Math.round((t0 + dt) * fps) / fps));
      mark.style.left = `${(offset + key.time) / ctx.config.duration * 100}%`; ctx.keysChanged(g.keys, l); ctx.seekQuiet(offset + key.time);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved && key.time !== t0) { undoStack.push({label: `移动关键帧 ${l.label}`, config: before}); redoStack.length = 0; markDirty(); ctx.status(`${l.label} 关键帧 ${(offset + t0).toFixed(2)}s → ${(offset + key.time).toFixed(2)}s · Ctrl+Z 撤销`); }
      else if (!warned) ctx.seek(offset + key.time);
      buildLanes(); fillSelected();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  let laneTimer = null; const buildLanesSoon = () => { cancelAnimationFrame(laneTimer); laneTimer = requestAnimationFrame(() => { buildLanes(); fillSelected(); }); };
  function deleteKey() {
    if (!selKey) { ctx.status('先在时间线上点选一个关键帧'); return; }
    const {lane, group, key} = selKey, idx = group.keys.indexOf(key), cover = lane.cover ?? true;
    if (idx === 0 || (cover && idx === group.keys.length - 1) || group.keys.length <= (cover ? 2 : 1)) { ctx.status('第一个关键帧（和必须覆盖结尾的最后一个）不能删除'); return; }
    if (edit(`删除 ${lane.label} 的关键帧`, () => { group.keys.splice(idx, 1); ctx.keysChanged(group.keys, lane); })) selKey = null;
    buildLanes(); fillSelected();
  }
  function copyKey() { if (!selKey) { ctx.status('先点选一个关键帧再复制'); return; } clipboard = {lane: selKey.lane, group: selKey.group, key: ctx.clone(selKey.key)}; ctx.status(`已复制 ${selKey.lane.label} 的关键帧；拖到目标时间按 Ctrl+V 粘贴`); }
  function pasteKey() {
    if (!clipboard) { ctx.status('还没有复制关键帧'); return; }
    const {lane, key} = clipboard, t = ctx.time();
    let group = clipboard.group;
    if (lane.multi) { group = lanes().find((l) => l.kind === 'camera').multi.find((g) => t >= g.start - 1e-6 && t < g.end + 1e-6); }
    else group = lanes().find((l) => l.kind === lane.kind && l.id === lane.id);
    if (!group) return;
    const local = Number((t - (lane.multi ? group.start : 0)).toFixed(6));
    edit(`粘贴 ${lane.label} 的关键帧到 ${t.toFixed(2)}s`, () => { ctx.upsert(group.keys, {...ctx.clone(key), time: local}); ctx.keysChanged(group.keys, lane); });
  }

  // ───────── 检查器：选中对象 / 选中关键帧 ─────────
  function fillSelected() {
    const card = $('selection-card');
    if (!selection && !selKey) { card.classList.add('empty'); $('sel-title').textContent = '未选中'; return; }
    card.classList.remove('empty');
    $('sel-title').textContent = selection ? (selection.type === 'custom' ? selection.label : `${{actor: '角色', prop: '道具', set: '场景'}[selection.type]} · ${selection.label}`) : selKey.lane.label;
    $('sel-rot-row').hidden = selection?.type === 'custom';
    $('sel-transform').hidden = !selection;
    if (selection) {
      const o = selection.obj, held = selection.type === 'prop' && heldProp(selection.id);
      ['x', 'y', 'z'].forEach((a, i) => { $(`sel-p${a}`).value = r4(o.position.toArray()[i]); });
      const r2 = (n) => Number(n.toFixed(2)), rot = degs(o.rotation).map(r2), yawDeg = r2(THREE.MathUtils.radToDeg(yawOf(o.quaternion, 0)));
      ['x', 'y', 'z'].forEach((a, i) => { $(`sel-r${a}`).value = selection.type === 'actor' ? (a === 'y' ? yawDeg : 0) : rot[i]; $(`sel-r${a}`).disabled = selection.type === 'actor' && a !== 'y'; });
      $('sel-scale-row').hidden = selection.type !== 'set';
      if (selection.type === 'set') ['x', 'y', 'z'].forEach((a, i) => { $(`sel-s${a}`).value = r4(o.scale.toArray()[i]); });
      $('sel-note').textContent = selection.type === 'custom' ? '相机路径上的关键帧点：拖动或输入坐标即改这个关键帧（不受自动关键帧开关影响）。' : selection.type === 'set' ? '场景物件是静态摆放：改动立即生效（重复排列的物体会一起移动）。' : held ? '道具正握在手里：这里改的是握持偏移，对整段握持都生效。' : selection.type === 'actor' ? '位置和朝向记在播放头处的角色关键帧；角度单位是度。' : '道具放在场景里：位置和角度记在播放头处的关键帧。';
    }
    $('sel-key').hidden = !selKey;
    if (selKey) { const at = (selKey.lane.multi ? selKey.group.start : 0) + selKey.key.time; $('sel-key-time').textContent = `${at.toFixed(3)}s`; $('sel-key-ease').value = selKey.key.ease || 'smooth'; }
  }
  $('sel-apply').addEventListener('click', () => {
    if (!selection || ctx.busy()) return;
    const o = selection.obj, read = (p) => ['x', 'y', 'z'].map((a) => Number($(`sel-${p}${a}`).value));
    const p = read('p'), r = read('r'); if ([...p, ...r].some((n) => !Number.isFinite(n))) { ctx.status('数值无效'); return; }
    o.position.set(...p);
    if (selection.type === 'actor') o.rotation.set(0, THREE.MathUtils.degToRad(r[1]), 0); else if (selection.type !== 'custom') o.rotation.set(...r.map(THREE.MathUtils.degToRad));
    if (selection.type === 'set') { const s = read('s'); if (s.some((n) => !(n > 0))) { ctx.status('缩放必须大于 0'); return; } o.scale.set(...s); }
    commitTransform(true);
  });
  $('sel-key-ease').addEventListener('change', () => {
    if (!selKey) return; const v = $('sel-key-ease').value, {lane, group, key} = selKey;
    edit(`${lane.label} 关键帧缓动改为 ${v}`, () => { if (v === 'smooth') delete key.ease; else key.ease = v; ctx.keysChanged(group.keys, lane); });
  });
  $('sel-key-delete').addEventListener('click', deleteKey);


  // ───────── 天气（第三期）─────────
  const W = ctx.weatherApi, WF = Object.keys(W.WEATHER_FIELDS).filter((f) => f !== 'tod');
  const WLABEL = {rain: '雨', snow: '雪', fog: '雾', wind: '风力', windDir: '风向', overcast: '阴天', wet: '地面湿'};
  function weatherKeyAt(t, overrides = {}) {
    const smp = W.weather.sample(t), k = {time: Number(t.toFixed(6))};
    for (const f of WF) k[f] = r4(smp ? smp[f] : W.WEATHER_FIELDS[f][2]);
    if (smp?.useTod) k.tod = r4(smp.tod);
    return {...k, ...overrides};
  }
  function ensureWeather() {
    const c = ctx.config; c.weather ||= {keyframes: [], lightning: []}; c.weather.keyframes ||= []; c.weather.lightning ||= [];
    if (!c.weather.keyframes.length || c.weather.keyframes[0].time > 1e-6) c.weather.keyframes.unshift({time: 0, ...Object.fromEntries(WF.map((f) => [f, W.WEATHER_FIELDS[f][2]]))});
    return c.weather;
  }
  const weatherChanged = () => { ctx.keysChanged(ctx.config.weather.keyframes, {kind: 'weather'}); };
  let wBefore = null;
  for (const f of WF) {
    const input = $(`w-${f}`);
    input.addEventListener('input', () => {
      if (ctx.busy()) return; if (!wBefore) wBefore = ctx.clone(ctx.config);
      const w = ensureWeather(), v = Number(input.value); ctx.upsert(w.keyframes, weatherKeyAt(ctx.time(), {[f]: v})); weatherChanged(); ctx.redraw(); fillWeather(true);
    });
    input.addEventListener('change', () => { if (!wBefore) return; undoStack.push({label: `天气 ${WLABEL[f]} 在 ${ctx.time().toFixed(2)}s 改为 ${input.value}`, config: wBefore}); redoStack.length = 0; wBefore = null; markDirty(); buildLanes(); ctx.status(`天气「${WLABEL[f]}」记在 ${ctx.time().toFixed(2)}s · Ctrl+Z 撤销`); });
  }
  $('w-tod').addEventListener('change', () => {
    const v = $('w-tod').value;
    edit(v === '' ? '关闭时间段（恢复原始光线）' : `时间段在 ${ctx.time().toFixed(2)}s 设为 ${$('w-tod').selectedOptions[0].textContent}`, () => {
      const w = ensureWeather();
      if (v === '') { for (const k of w.keyframes) delete k.tod; }
      else { const h = Number(v); if (!w.keyframes.some((k) => k.tod !== undefined)) for (const k of w.keyframes) k.tod = h; ctx.upsert(w.keyframes, weatherKeyAt(ctx.time(), {tod: h})); }
      weatherChanged();
    });
  });
  for (const b of document.querySelectorAll('[data-weather]')) b.addEventListener('click', () => {
    const p = W.WEATHER_PRESETS[b.dataset.weather], t = ctx.time();
    edit(`天气「${p.label}」记在 ${t.toFixed(2)}s`, () => {
      const w = ensureWeather(), fields = Object.fromEntries(WF.filter((f) => p[f] !== undefined).map((f) => [f, p[f]]));
      ctx.upsert(w.keyframes, weatherKeyAt(t, fields)); weatherChanged();
      if (p.lightning) { w.lightning.push({time: Number(Math.min(ctx.config.duration, t + .6).toFixed(3))}); w.lightning.sort((a, b2) => a.time - b2.time); }
    });
  });
  $('w-bolt').addEventListener('click', () => { const t = Number(ctx.time().toFixed(3)); edit(`在 ${t.toFixed(2)}s 加一道闪电`, () => { const w = ensureWeather(); w.lightning.push({time: t}); w.lightning.sort((a, b) => a.time - b.time); }); });
  $('w-clear').addEventListener('click', () => { if (!ctx.config.weather) { ctx.status('本工程还没有天气'); return; } edit('清除全部天气', () => { delete ctx.config.weather; }); });
  let boltSig = null;
  function fillWeather(force = false) {
    const smp = W.weather?.sample(ctx.time()), active = document.activeElement;
    for (const f of WF) { const input = $(`w-${f}`), v = smp ? smp[f] : W.WEATHER_FIELDS[f][2]; if (force || active !== input) input.value = v; $(`w-${f}-v`).textContent = f === 'windDir' ? `${Math.round(v)}°` : `${Math.round(v * 100)}%`; }
    if (active !== $('w-tod')) { const h = smp?.useTod ? smp.tod : null, opts = [...$('w-tod').options].map((o) => o.value).filter(Boolean).map(Number); $('w-tod').value = h === null ? '' : String(opts.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a), opts[0])); }
    const bolts = ctx.config.weather?.lightning || [], sig = JSON.stringify(bolts);
    if (sig !== boltSig) { boltSig = sig; $('w-bolts').replaceChildren(...bolts.map((bolt, i) => { const chip = document.createElement('span'); chip.className = 'bolt-chip'; const go = document.createElement('button'); go.type = 'button'; go.textContent = `⚡ ${bolt.time.toFixed(2)}s`; go.addEventListener('click', () => ctx.seek(bolt.time)); const del = document.createElement('button'); del.type = 'button'; del.textContent = '×'; del.title = '删除这道闪电'; del.addEventListener('click', () => edit(`删除 ${bolt.time.toFixed(2)}s 的闪电`, () => { ctx.config.weather.lightning.splice(i, 1); })); chip.append(go, del); return chip; })); }
    $('weather-state').textContent = smp ? `雨 ${Math.round(smp.rain * 100)}% · 雪 ${Math.round(smp.snow * 100)}% · 雾 ${Math.round(smp.fog * 100)}%` : '未设置';
  }


  // ───────── 姿态（第四期）：姿态库、关节微调、手部接触 ─────────
  const JOINTS = [['spine', null, '脊柱前倾'], ['neck', null, '低头 / 抬头'], ['neckYaw', null, '转头'], ['shL', 0, '左臂前后'], ['shL', 1, '左臂外展'], ['elL', null, '左肘弯曲'],
    ['shR', 0, '右臂前后'], ['shR', 1, '右臂外展'], ['elR', null, '右肘弯曲'], ['hipL', null, '左腿前后'], ['kneeL', null, '左膝'], ['hipR', null, '右腿前后'], ['kneeR', null, '右膝'], ['drop', null, '整体下沉']];
  const jid = (f, i) => `adj-${f}${i ?? ''}`;
  $('pose-joints').replaceChildren(...JOINTS.map(([f, i, label]) => {
    const row = document.createElement('label'); row.className = 'wrow';
    const name = document.createElement('span'); name.textContent = label;
    const input = document.createElement('input'); input.type = 'range'; input.id = jid(f, i);
    if (f === 'drop') Object.assign(input, {min: -.3, max: .6, step: .01}); else Object.assign(input, {min: -90, max: 90, step: 1});
    const em = document.createElement('em'); em.id = `${jid(f, i)}-v`; row.append(name, input, em); return row;
  }));
  const curActor = () => (selection?.type === 'actor' ? ctx.config.actors.find((a) => a.id === selection.id) : null);
  const zeroAdj = (k) => (Array.isArray(ctx.STAND[k]) ? [0, 0] : 0);
  function writeActorKey(actor, overrides) { ctx.upsert(actor.keyframes, ctx.actorKeyAt(actor, ctx.time(), overrides)); ctx.refreshActor(actor.id); }
  function currentAdjust(actor) { const a = ctx.sampleActor(actor.keyframes, ctx.time()).adjust || {}; const out = {}; for (const k of ctx.POSE_KEYS) { const v = a[k] ?? zeroAdj(k); if (Array.isArray(v) ? v.some((n) => Math.abs(n) > 1e-4) : Math.abs(v) > 1e-4) out[k] = Array.isArray(v) ? v.map(r4) : r4(v); } return out; }
  let pBefore = null;
  for (const [f, i, label] of JOINTS) {
    const input = $(jid(f, i));
    input.addEventListener('input', () => {
      const actor = curActor(); if (!actor || ctx.busy()) return; if (!pBefore) pBefore = ctx.clone(ctx.config);
      const adj = currentAdjust(actor), raw = Number(input.value), v = f === 'drop' ? raw : THREE.MathUtils.degToRad(raw);
      if (i === null) adj[f] = r4(v); else { const arr = adj[f] ? [...adj[f]] : [0, 0]; arr[i] = r4(v); adj[f] = arr; }
      writeActorKey(actor, {adjust: adj}); ctx.redraw(); fillPose(true);
    });
    input.addEventListener('change', () => { if (!pBefore) return; undoStack.push({label: `${curActor()?.id} 在 ${ctx.time().toFixed(2)}s 微调「${label}」`, config: pBefore}); redoStack.length = 0; pBefore = null; markDirty(); buildLanes(); ctx.status(`关节微调「${label}」记在 ${ctx.time().toFixed(2)}s 的角色关键帧 · Ctrl+Z 撤销`); });
  }
  $('pose-reset').addEventListener('click', () => { const actor = curActor(); if (!actor) return; edit(`${actor.id} 清除 ${ctx.time().toFixed(2)}s 的关节微调`, () => { writeActorKey(actor, {}); const k = actor.keyframes.find((x) => Math.abs(x.time - ctx.time()) < 1e-4); if (k) delete k.adjust; }); });
  $('pose-lib').addEventListener('change', () => { const actor = curActor(); if (!actor) return; const name = $('pose-lib').value; edit(`${actor.id} 在 ${ctx.time().toFixed(2)}s 换成姿态 ${name}`, () => writeActorKey(actor, {pose: name})); });
  // 手部接触：选目标（对方身体部位 / 道具挂点 / 场景物件）或「拖动位置」
  for (const side of ['L', 'R']) {
    const sel = $(`reach-${side}`), w = $(`reach-${side}-w`), key = `reach${side}`;
    sel.addEventListener('change', () => {
      const actor = curActor(); if (!actor) return; const v = sel.value;
      edit(`${actor.id} ${side === 'L' ? '左' : '右'}手 ${v ? `接触 ${v === 'world' ? '固定位置' : v}` : '放开'}（${ctx.time().toFixed(2)}s）`, () => {
        if (!v) writeActorKey(actor, {[key]: {target: (ctx.sampleActor(actor.keyframes, ctx.time())[key]?.target) || `${actor.id}.hip`, w: 0}});
        else if (v === 'world') { const hand = ctx.actors.get(actor.id).points[`hand_${side}`].getWorldPosition(new THREE.Vector3()); writeActorKey(actor, {[key]: {target: 'world', pos: hand.toArray().map(r4), w: 1}}); }
        else writeActorKey(actor, {[key]: {target: v, w: Number(w.value) || 1}});
      });
      if (v === 'world') dragHand(side);
    });
    w.addEventListener('change', () => {
      const actor = curActor(); if (!actor) return; const cur = ctx.sampleActor(actor.keyframes, ctx.time())[key]; if (!cur?.target) { ctx.status('先选一个接触目标'); return; }
      edit(`${actor.id} ${side === 'L' ? '左' : '右'}手接触力度 ${w.value}`, () => writeActorKey(actor, {[key]: {...cur, w: Number(w.value)}}));
    });
    $(`reach-${side}-drag`).addEventListener('click', () => dragHand(side));
  }
  function dragHand(side) {
    const actor = curActor(); if (!actor) { ctx.status('先选中一个角色'); return; }
    const v = ctx.actors.get(actor.id), key = `reach${side}`, ball = new THREE.Mesh(new THREE.SphereGeometry(.05, 16, 12), new THREE.MeshBasicMaterial({color: 0xffd166, depthTest: false, transparent: true}));
    ball.renderOrder = 999; ball.userData.editor = true; v.points[`hand_${side}`].getWorldPosition(ball.position); ctx.scene.add(ball);
    const actorId = actor.id;
    select({type: 'custom', obj: ball, label: `${actor.label} · ${side === 'L' ? '左' : '右'}手位置`, dispose() { ctx.scene.remove(ball); ball.geometry.dispose(); ball.material.dispose(); },
      commit(obj) { const a = ctx.config.actors.find((x) => x.id === actorId); writeActorKey(a, {[key]: {target: 'world', pos: obj.position.toArray().map(r4), w: 1}}); }});
    ctx.status('拖黄色小球把手放到想要的位置（记在播放头处的角色关键帧，Esc 结束）');
  }
  let pointSig = '';
  function fillPose(force = false) {
    const actor = curActor(), card = $('pose-card'); card.classList.toggle('empty', !actor);
    if (!actor) { $('pose-title').textContent = '先选中一个角色'; return; }
    const smp = ctx.sampleActor(actor.keyframes, ctx.time()), adj = smp.adjust || {}, active = document.activeElement;
    $('pose-title').textContent = `${actor.label} · ${ctx.time().toFixed(2)}s`;
    const names = Object.keys(ctx.poses()); if ($('pose-lib').options.length !== names.length) $('pose-lib').replaceChildren(...names.map((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; return o; }));
    if (active !== $('pose-lib')) $('pose-lib').value = smp.poseName;
    for (const [f, i] of JOINTS) { const input = $(jid(f, i)), raw = i === null ? (adj[f] ?? 0) : (adj[f]?.[i] ?? 0), v = f === 'drop' ? raw : THREE.MathUtils.radToDeg(raw); if (force || active !== input) input.value = v; $(`${jid(f, i)}-v`).textContent = f === 'drop' ? `${v.toFixed(2)}m` : `${Math.round(v)}°`; }
    const pts = ctx.pointNames().filter((n) => !n.startsWith(`${actor.id}.`)).sort(), sig = actor.id + pts.join();
    if (sig !== pointSig) { pointSig = sig; for (const side of ['L', 'R']) $(`reach-${side}`).replaceChildren(...[['', '不接触'], ['world', '固定位置（拖小球）'], ...pts.map((n) => [n, n])].map(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; })); }
    for (const side of ['L', 'R']) { const r = smp[`reach${side}`], sel = $(`reach-${side}`); if (active !== sel) { const val = r && r.w > .02 ? r.target : ''; if (val && ![...sel.options].some((o) => o.value === val)) sel.append(Object.assign(document.createElement('option'), {value: val, textContent: val})); sel.value = val; } if (active !== $(`reach-${side}-w`)) $(`reach-${side}-w`).value = r ? r.w : 1; }
    $('pose-clip').hidden = !ctx.actors.get(actor.id).activeClip; $('pose-clip').textContent = `此刻在播放动作片段「${ctx.actors.get(actor.id).activeClip || ''}」：微调会叠加在片段之上，用来修正动捕。`;
  }

  // ───────── 快捷键（由 app.js 转来）─────────
  function onKey(e) {
    const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (mod && k === 's') { e.preventDefault(); save(); return true; }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return false;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return true; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return true; }
    if (mod && k === 'c') { copyKey(); return true; }
    if (mod && k === 'v') { e.preventDefault(); pasteKey(); return true; }
    if (mod) return false;
    if (k === 'w') { setMode('translate'); return true; }
    if (k === 'e') { setMode('rotate'); return true; }
    if (k === 'r') { setMode('scale'); return true; }
    if (k === 'k') { insertKey(); return true; }
    if (k === 'n') { $('autokey').click(); return true; }
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteKey(); return true; }
    if (k === 'escape' && (selection || selKey)) { select(null); return true; }
    return false;
  }

  return {
    onKey, buildLanes, checkDraft, showTab,
    gizmoActive: () => Boolean(gizmo.axis) || gizmoDragging,
    onConfig() { select(null); undoStack.length = 0; redoStack.length = 0; buildLanes(); fillWeather(true); },
    onSeek() { if (pending) { pending = null; $('insert-key').classList.remove('pending'); ctx.status('未记关键帧的移动已放弃'); } if (selection) box.setFromObject(selection.obj); },
    onDraw() { fillWeather(); fillPose(); gizmo.camera = ctx.viewCam(); if (selection?.type === 'custom' && !selection.obj.parent) select(null); if (selection && box.visible) box.setFromObject(selection.obj); },
    onViewChange() { gizmo.camera = ctx.viewCam(); if (selection?.type === 'custom') select(null); },
    setOverlayVisible(v) { gizmo.visible = v && Boolean(gizmo.object); box.visible = v && Boolean(selection) && !suspended; },
    selectionCenter() { if (!selection) return null; box.setFromObject(selection.obj); const c = bounds3.getCenter(new THREE.Vector3()), sz = bounds3.getSize(new THREE.Vector3()); return {center: c, size: Math.max(sz.x, sz.y, sz.z, .3)}; },
    insertCameraKey, edit,
    beginEdit: () => ctx.clone(ctx.config),
    endEdit(label, before) { undoStack.push({label, config: before}); redoStack.length = 0; markDirty(); buildLanes(); },
    suspend() { suspended = true; gizmo.detach(); box.visible = false; ctx.scene.remove(gizmo, box); },
    resume() { suspended = false; ctx.scene.add(gizmo, box); if (selection) { gizmo.attach(selection.obj); box.visible = true; applyMode(); } },
    state: () => ({selection: selection && {type: selection.type, id: selection.id, label: selection.label}, selKey: selKey && {lane: selKey.lane.label, time: selKey.key.time}, pending: Boolean(pending), dirty, undo: undoStack.length, redo: redoStack.length, autokey: $('autokey').checked, mode}),
    select: (type, id) => select(type === 'actor' ? targetFrom(ctx.actors.get(id).root) : type === 'prop' ? targetFrom(ctx.props.get(id).group) : null),
    selectedObject: () => selection?.obj || null, // 供检查脚本使用
    dragHand, fillPose,
    commitTransform, insertKey, undo, redo, deleteKey, copyKey, pasteKey, save, setMode,
    selectKey(kind, id, index) { const l = lanes().find((x) => x.kind === kind && x.id === id); const g = l.multi ? l.multi[0] : l; selKey = {lane: l, group: g, key: g.keys[index]}; buildLanes(); fillSelected(); },
  };
}
