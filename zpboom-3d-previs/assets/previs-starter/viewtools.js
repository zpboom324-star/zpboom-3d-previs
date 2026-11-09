/* ZPboom.AI 3D 预演 · 镜头与自由观察（第二期）
   自由观察：左键环绕、右键 / Shift+左键平移、滚轮推拉、按住右键 + WASD/QE 飞行、F 聚焦选中对象；
   俯视平面图；自由观察 / 俯视时右下角显示分镜相机小窗；当前镜头的相机路径、看向路径、取景框，路径上的关键帧点可直接拖；
   运镜微调（推拉 / 横移 / 升降 / 摇 / 俯仰）、FOV 滑杆、「设为镜头机位」；镜头切分 / 删除 / 改名 / 拖动镜头边界。 */
export function initViewTools(ctx) {
  const {THREE, $} = ctx;
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z), UP = V(0, 1, 0);
  const r4 = (n) => Number(n.toFixed(4));

  // ───────── 俯视相机 ─────────
  const topCam = new THREE.OrthographicCamera(-10, 10, 6, -6, .1, 400);
  const top = {center: V(), half: 8};
  const topClip = [new THREE.Plane(V(0, -1, 0), 2.2)]; // 只保留 y < 2.2m
  function updateTop() {
    const a = ctx.camera.aspect || 1.78;
    Object.assign(topCam, {left: -top.half * a, right: top.half * a, top: top.half, bottom: -top.half});
    topCam.position.set(top.center.x, 120, top.center.z); topCam.up.set(0, 0, -1); topCam.lookAt(top.center.x, 0, top.center.z);
    topCam.updateProjectionMatrix(); topCam.updateMatrixWorld();
  }
  updateTop();

  // ───────── 叠加显示：相机路径、看向路径、关键帧点、取景框 ─────────
  const overlay = new THREE.Group(); overlay.userData.editor = true; overlay.visible = false; ctx.scene.add(overlay);
  const pathGroup = new THREE.Group(); overlay.add(pathGroup);
  const frustum = new THREE.CameraHelper(ctx.shotCam); frustum.userData.editor = true;
  frustum.setColors(new THREE.Color(0xff7a58), new THREE.Color(0xff7a58), new THREE.Color(0xffb29e), new THREE.Color(0x6fc1ff), new THREE.Color(0x777777));
  overlay.add(frustum);
  const keyMat = new THREE.MeshBasicMaterial({color: 0xff7a58, depthTest: false, transparent: true}), tgtMat = new THREE.MeshBasicMaterial({color: 0x6fc1ff, depthTest: false, transparent: true});
  const keyGeo = new THREE.SphereGeometry(.07, 14, 10), tgtGeo = new THREE.SphereGeometry(.05, 12, 8);
  let pathSig = '', keyPoints = [];
  function rebuildPath(shot) {
    for (const c of [...pathGroup.children]) { pathGroup.remove(c); c.geometry?.dispose?.(); }
    keyPoints = [];
    const keys = shot.camera.keyframes, len = shot.end - shot.start, n = Math.max(2, Math.ceil(len * 30));
    const sample = (field) => Array.from({length: n + 1}, (_, i) => V(...ctx.smoothSample(keys, len * i / n, field)));
    const line = (pts, color, opacity) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({color, transparent: true, opacity, depthTest: false})); l.renderOrder = 998; pathGroup.add(l); };
    line(sample('position'), 0xff7a58, .95); line(sample('target'), 0x6fc1ff, .7);
    keys.forEach((key, index) => {
      for (const [field, geo, mat] of [['position', keyGeo, keyMat], ['target', tgtGeo, tgtMat]]) {
        const m = new THREE.Mesh(geo, mat); m.position.set(...key[field]); m.renderOrder = 999; m.userData.camKey = {shot, index, field}; pathGroup.add(m); keyPoints.push(m);
      }
    });
  }
  function overlayVisible() { return (ctx.free || ctx.top) && !document.body.classList.contains('clean') && !ctx.busy(); }
  function onDraw(shot) {
    overlay.visible = overlayVisible() && $('show-path').checked;
    if (!overlay.visible) return;
    const sig = shot.id + JSON.stringify(shot.camera.keyframes) + (shot.end - shot.start);
    if (sig !== pathSig) { pathSig = sig; rebuildPath(shot); }
    frustum.update();
    for (const m of keyPoints) { const k = ctx.top ? top.half * .03 / .07 : Math.max(.6, ctx.camera.position.distanceTo(m.position) * .03 / .07); m.scale.setScalar(k); } // 点的屏幕大小基本固定，好点中
  }
  function pick(raycaster) { // 给 editor：点中路径上的关键帧点
    if (!overlay.visible) return null;
    const hit = raycaster.intersectObjects(keyPoints, false)[0]; if (!hit) return null;
    const m = hit.object, {shot, index, field} = m.userData.camKey;
    return {type: 'custom', obj: m, label: `${shot.label} · 相机${field === 'position' ? '位置' : '看向'}关键帧 ${index + 1}`,
      commit(obj) { const key = shot.camera.keyframes[index]; key[field] = obj.position.toArray().map(r4); if (V(...key.position).distanceTo(V(...key.target)) < 1e-4) throw new Error('相机位置不能与看向点重合'); ctx.tangentCache.delete(shot.camera.keyframes); pathSig = ''; }};
  }

  // ───────── 镜头小窗 ─────────
  const pipFrame = $('pip-frame');
  function pipRect() { const r = ctx.canvas.getBoundingClientRect(), w = Math.round(r.width * .3), h = Math.round(w * r.height / r.width); return {x: r.width - w - 10, y: 10, w, h, W: r.width, H: r.height}; }
  function renderPip(renderer, scene, cam) {
    const p = pipRect(), ov = overlay.visible; overlay.visible = false; ctx.editor?.setOverlayVisible(false);
    renderer.setScissorTest(true); renderer.setScissor(p.x, p.y, p.w, p.h); renderer.setViewport(p.x, p.y, p.w, p.h);
    renderer.render(scene, cam);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, p.W, p.H); overlay.visible = ov; ctx.editor?.setOverlayVisible(true);
    Object.assign(pipFrame.style, {right: '10px', bottom: '10px', width: `${p.w}px`, height: `${p.h}px`}); pipFrame.hidden = false;
  }
  const pipOn = () => $('pip').checked && !document.body.classList.contains('clean');
  function syncPipFrame() { pipFrame.hidden = !((ctx.free || ctx.top) && pipOn() && !ctx.busy()); }

  // ───────── 视图模式 ─────────
  function setFree(on, silent = false) {
    if (on && !ctx.free) { ctx.camera.position.copy(ctx.shotCam.position); ctx.camera.quaternion.copy(ctx.shotCam.quaternion); ctx.manualTarget.copy(ctx.shotTarget()); }
    ctx.free = on; if (on) ctx.top = false; else ctx.top = false;
    $('top-view').checked = false; document.body.classList.toggle('free-view', on); document.body.classList.remove('top-view');
    syncPipFrame(); ctx.redraw();
    if (!silent) ctx.status(on ? '自由观察：左键环绕 · 右键或 Shift+左键平移 · 滚轮推拉 · 按住右键 + WASD/QE 飞行 · F 聚焦选中对象；K 或「设为镜头机位」把当前画面记成镜头关键帧' : '已回到分镜相机');
  }
  let freeBeforeTop = false;
  function setTop(on) {
    if (on) {
      freeBeforeTop = ctx.free;
      const sel = ctx.editor?.selectionCenter(); top.center.copy(sel ? sel.center : ctx.shotTarget()); top.center.y = 0; updateTop();
      ctx.top = true; ctx.free = false; document.body.classList.add('top-view'); document.body.classList.remove('free-view');
      ctx.status('俯视平面图：左键拖动空白处平移 · 滚轮缩放 · 可以直接拖人物、道具和相机路径上的点 · 再点一次「俯视」返回');
    } else { ctx.top = false; document.body.classList.remove('top-view'); if (freeBeforeTop) { ctx.free = true; document.body.classList.add('free-view'); } ctx.status(freeBeforeTop ? '已退出俯视图，回到自由观察' : '已退出俯视图'); }
    $('top-view').checked = on; syncPipFrame(); ctx.editor?.onViewChange(); ctx.redraw();
  }
  $('top-view').addEventListener('change', () => setTop($('top-view').checked));
  $('pip').addEventListener('change', () => { syncPipFrame(); ctx.redraw(); });
  $('show-path').addEventListener('change', () => ctx.redraw());

  // ───────── 鼠标键盘操作 ─────────
  let drag = null, fly = null;
  const canvas = ctx.canvas;
  canvas.addEventListener('contextmenu', (e) => { if (ctx.free || ctx.top) e.preventDefault(); });
  canvas.addEventListener('pointerdown', (e) => {
    if (!(ctx.free || ctx.top) || ctx.busy() || ctx.editor?.gizmoActive()) return;
    const pan = e.button === 2 || e.button === 1 || e.shiftKey || ctx.top;
    drag = {x: e.clientX, y: e.clientY, pan, button: e.button}; canvas.setPointerCapture(e.pointerId);
    if (e.button === 2 && ctx.free) startFly();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (ctx.top) { const k = 2 * top.half / canvas.getBoundingClientRect().height; top.center.x -= dx * k; top.center.z -= dy * k; updateTop(); }
    else if (drag.pan) { const cam = ctx.camera, dist = cam.position.distanceTo(ctx.manualTarget), k = dist * .0016, right = V().setFromMatrixColumn(cam.matrixWorld, 0), up = V().setFromMatrixColumn(cam.matrixWorld, 1), d = right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k)); cam.position.add(d); ctx.manualTarget.add(d); }
    else { const cam = ctx.camera, s = new THREE.Spherical().setFromVector3(cam.position.clone().sub(ctx.manualTarget)); s.theta -= dx * .006; s.phi = ctx.clamp(s.phi - dy * .006, .05, Math.PI - .05); cam.position.copy(V().setFromSpherical(s).add(ctx.manualTarget)); cam.up.copy(UP); cam.lookAt(ctx.manualTarget); }
    ctx.camera.updateMatrixWorld(); ctx.requestRender(); ctx.fill();
  });
  const endDrag = () => { drag = null; stopFly(); };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    if (!(ctx.free || ctx.top)) return; e.preventDefault();
    if (ctx.top) { top.half = ctx.clamp(top.half * Math.exp(e.deltaY * .001), 1, 120); updateTop(); }
    else { const cam = ctx.camera, off = cam.position.clone().sub(ctx.manualTarget); off.setLength(ctx.clamp(off.length() * Math.exp(e.deltaY * .001), .2, 150)); cam.position.copy(ctx.manualTarget).add(off); cam.updateMatrixWorld(); ctx.fill(); }
    ctx.requestRender();
  }, {passive: false});
  const held = new Set();
  function startFly() { if (fly) return; let last = performance.now(); const step = (now) => { if (!fly) return; const dt = Math.min(.05, (now - last) / 1000); last = now; if (held.size) { const cam = ctx.camera, fwd = V(); cam.getWorldDirection(fwd); const right = V().crossVectors(fwd, UP).normalize(), d = V(), sp = (held.has('shift') ? 8 : 3) * dt; if (held.has('w')) d.add(fwd); if (held.has('s')) d.sub(fwd); if (held.has('d')) d.add(right); if (held.has('a')) d.sub(right); if (held.has('e')) d.y += 1; if (held.has('q')) d.y -= 1; if (d.lengthSq()) { d.normalize().multiplyScalar(sp); cam.position.add(d); ctx.manualTarget.add(d); cam.updateMatrixWorld(); ctx.requestRender(); ctx.fill(); } } fly = requestAnimationFrame(step); }; fly = requestAnimationFrame(step); }
  function stopFly() { if (fly) cancelAnimationFrame(fly); fly = null; held.clear(); }
  window.addEventListener('keydown', (e) => { // 捕获阶段：飞行时 WASD/QE 不触发编辑快捷键
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (fly && ['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) { held.add(k); e.stopPropagation(); e.preventDefault(); return; }
    if (k === 'f' && !ctx.busy() && !document.body.classList.contains('clean')) { e.stopPropagation(); focusSelection(); }
    if (k === 't' && !ctx.busy() && !document.body.classList.contains('clean')) { e.stopPropagation(); setTop(!ctx.top); }
  }, true);
  window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()), true);
  function focusSelection() {
    const sel = ctx.editor?.selectionCenter(); if (!sel) { ctx.status('先选中一个对象再按 F 聚焦'); return; }
    if (ctx.top) { top.center.set(sel.center.x, 0, sel.center.z); top.half = Math.max(2, sel.size * 2.5); updateTop(); ctx.requestRender(); return; }
    if (!ctx.free) setFree(true, true);
    const cam = ctx.camera, dir = cam.position.clone().sub(ctx.manualTarget).normalize(), dist = Math.max(1.2, sel.size * 2.4);
    ctx.manualTarget.copy(sel.center); cam.position.copy(sel.center).addScaledVector(dir, dist); cam.up.copy(UP); cam.lookAt(sel.center); cam.updateMatrixWorld(); ctx.requestRender(); ctx.fill();
    ctx.status('已聚焦到选中对象（自由观察）');
  }

  // ───────── 运镜微调 / 设为机位 / FOV ─────────
  const STEPS = {s: [.05, .5], m: [.2, 2], l: [.6, 6]};
  function workingPose() {
    if (ctx.free) return {pos: ctx.camera.position.clone(), tgt: ctx.manualTarget.clone()};
    const shot = ctx.shotAt(ctx.time()), lt = ctx.time() - shot.start;
    return {pos: V(...ctx.smoothSample(shot.camera.keyframes, lt, 'position')), tgt: V(...ctx.smoothSample(shot.camera.keyframes, lt, 'target'))};
  }
  function nudge(op) {
    if (ctx.busy()) return;
    if (ctx.top) { ctx.status('俯视图下请切到自由观察或分镜相机再微调'); return; }
    const [d, a] = STEPS[$('nudge-step').value] || STEPS.m, {pos, tgt} = workingPose(), fwd = tgt.clone().sub(pos), dist = fwd.length(); fwd.normalize();
    const right = V().crossVectors(fwd, UP).normalize(), move = V();
    if (op === 'in') move.copy(fwd).multiplyScalar(d); if (op === 'out') move.copy(fwd).multiplyScalar(-d);
    if (op === 'left') move.copy(right).multiplyScalar(-d); if (op === 'right') move.copy(right).multiplyScalar(d);
    if (op === 'up') move.set(0, d, 0); if (op === 'down') move.set(0, -d, 0);
    pos.add(move); tgt.add(move);
    if (['pan-l', 'pan-r', 'tilt-u', 'tilt-d'].includes(op)) {
      const ang = THREE.MathUtils.degToRad(a) * (op === 'pan-l' || op === 'tilt-u' ? 1 : -1), v = tgt.clone().sub(pos);
      if (op.startsWith('pan')) v.applyAxisAngle(UP, ang); else { const nv = v.clone().applyAxisAngle(right, ang); if (Math.abs(nv.clone().normalize().y) < .985) v.copy(nv); }
      tgt.copy(pos).add(v.setLength(dist));
    }
    if (!ctx.free && $('autokey').checked) {
      const shot = ctx.shotAt(ctx.time());
      ctx.editor.edit(`镜头 ${shot.label} 运镜微调`, () => ctx.upsert(shot.camera.keyframes, {time: Number((ctx.time() - shot.start).toFixed(6)), position: pos.toArray().map(r4), target: tgt.toArray().map(r4)}));
      return;
    }
    if (!ctx.free) setFree(true, true);
    const cam = ctx.camera; cam.position.copy(pos); ctx.manualTarget.copy(tgt); cam.up.copy(UP); cam.lookAt(tgt); cam.updateMatrixWorld(); ctx.requestRender(); ctx.fill();
    ctx.status('已在自由观察里调整机位：满意后按 K 或点「设为镜头机位」写进当前镜头（开着自动关键帧时，在分镜相机下微调会直接写入）');
  }
  for (const b of document.querySelectorAll('[data-nudge]')) b.addEventListener('click', () => nudge(b.dataset.nudge));
  $('set-shot-cam').addEventListener('click', () => { if (ctx.top) { ctx.status('俯视图下不能记机位：先切到自由观察找好角度'); return; } ctx.editor.insertCameraKey(); });
  let fovBefore = null;
  const fovMm = (f) => `≈ ${Math.round(12 / Math.tan(ctx.deg(f) / 2))}mm`;
  $('fov-range').addEventListener('input', () => {
    if (ctx.busy()) return; const f = Number($('fov-range').value), shot = ctx.shotAt(ctx.time());
    if (!fovBefore) fovBefore = ctx.editor.beginEdit();
    shot.camera.fov = f; $('fov').value = f; $('fov-mm').textContent = fovMm(f); ctx.redraw();
  });
  $('fov-range').addEventListener('change', () => { if (!fovBefore) return; const shot = ctx.shotAt(ctx.time()); ctx.editor.endEdit(`镜头 ${shot.label} 视角改为 ${shot.camera.fov}°（${fovMm(shot.camera.fov)}）`, fovBefore); fovBefore = null; ctx.status(`镜头 ${shot.label} 视角 ${shot.camera.fov}° ${fovMm(shot.camera.fov)} · Ctrl+Z 撤销`); });

  // ───────── 画幅：此镜画幅（黑边）与取景参考线 ─────────
  $('shot-aspect').addEventListener('change', () => {
    const shot = ctx.shotAt(ctx.time()), v = $('shot-aspect').value;
    ctx.editor.edit(v ? `镜头 ${shot.label} 画幅设为 ${v}` : `镜头 ${shot.label} 画幅跟随工程`, () => { if (v) shot.camera.aspect = v; else delete shot.camera.aspect; });
    ctx.redraw();
  });
  const GUIDE_KEY = 'zpboom-guide';
  try { $('guide-aspect').value = localStorage.getItem(GUIDE_KEY) || ''; } catch { /* 无痕模式 */ }
  function updateGuide() {
    const g = $('guide-aspect').value, el = $('frame-guide');
    if (!g || !ctx.config) { el.hidden = true; return; }
    const pa = ctx.aspectNum(ctx.config.aspectRatio), ga = ctx.aspectNum(g);
    if (Math.abs(pa - ga) < 1e-3) { el.hidden = true; return; }
    const w = ga > pa ? 100 : ga / pa * 100, h = ga > pa ? pa / ga * 100 : 100;
    Object.assign(el.style, {width: `${w}%`, height: `${h}%`, left: `${(100 - w) / 2}%`, top: `${(100 - h) / 2}%`}); $('frame-guide-label').textContent = `${g} 取景`; el.hidden = false;
  }
  $('guide-aspect').addEventListener('change', () => { try { localStorage.setItem(GUIDE_KEY, $('guide-aspect').value); } catch { /* */ } updateGuide(); });

  // ───────── 镜头：切分 / 删除 / 改名 / 拖边界 ─────────
  const minLen = () => 2 / ctx.config.fps, snap = (t) => Math.round(t * ctx.config.fps) / ctx.config.fps;
  const poseAt = (shot, gt) => { const len = shot.end - shot.start, lt = ctx.clamp(gt - shot.start, 0, len); return {position: ctx.smoothSample(shot.camera.keyframes, lt, 'position').map(r4), target: ctx.smoothSample(shot.camera.keyframes, lt, 'target').map(r4)}; };
  function repartition(A, B, boundary, srcA, srcB) { // 按全片时间重新分配两个相邻镜头的相机关键帧，边界处补一帧保持运动不变
    const aKeys = srcA.camera.keyframes.filter((k) => srcA.start + k.time < boundary - 1e-6).map((k) => ({...k, time: Number((srcA.start + k.time - A.start).toFixed(6))}));
    if (boundary > srcA.end + 1e-6) aKeys[aKeys.length - 1] = {...aKeys.at(-1), ease: 'hold'}; // 镜头变长：原最后一帧之后停住，之前的运动完全不变
    aKeys.push({time: Number((boundary - A.start).toFixed(6)), ...poseAt(srcA, boundary)});
    const bKeys = [{time: 0, ...poseAt(srcB, boundary), ...(boundary < srcB.start - 1e-6 ? {ease: 'hold'} : {})}, ...srcB.camera.keyframes.filter((k) => srcB.start + k.time > boundary + 1e-6).map((k) => ({...k, time: Number((srcB.start + k.time - boundary).toFixed(6))}))];
    A.end = boundary; B.start = boundary; A.camera.keyframes = aKeys; B.camera.keyframes = bKeys;
    if (Math.abs(bKeys.at(-1).time - (B.end - B.start)) > 1e-4) bKeys.push({...bKeys.at(-1), time: Number((B.end - B.start).toFixed(6))});
  }
  function uniqueId(base) { const ids = new Set(ctx.config.shots.map((s) => s.id)); for (const ch of 'bcdefghijklmnopqrstuvwxyz') { const id = `${base}${ch}`.slice(0, 40); if (!ids.has(id)) return id; } let n = 2; while (ids.has(`s${n}`)) n++; return `s${n}`; }
  function splitShot() {
    if (ctx.busy()) return; const t = snap(ctx.time()), shot = ctx.shotAt(t), i = ctx.config.shots.indexOf(shot);
    if (t - shot.start < minLen() || shot.end - t < minLen()) { ctx.status('播放头离镜头开头或结尾太近，不能切分'); return; }
    ctx.editor.edit(`在 ${t.toFixed(2)}s 切分镜头 ${shot.label}`, () => {
      const src = JSON.parse(JSON.stringify(shot)), next = JSON.parse(JSON.stringify(shot)); next.id = uniqueId(shot.id); next.label = `${shot.label} · 后段`.slice(0, 80);
      repartition(shot, next, t, src, src); next.end = src.end; ctx.config.shots.splice(i + 1, 0, next);
      if (Math.abs(next.camera.keyframes.at(-1).time - (next.end - next.start)) > 1e-4) next.camera.keyframes.push({...next.camera.keyframes.at(-1), time: Number((next.end - next.start).toFixed(6))});
    });
    ctx.rebuildTimeline(); ctx.redraw();
  }
  function deleteShot() {
    if (ctx.busy()) return; const shots = ctx.config.shots, shot = ctx.shotAt(ctx.time()), i = shots.indexOf(shot);
    if (shots.length < 2) { ctx.status('至少要保留一个镜头'); return; }
    ctx.editor.edit(`删除镜头 ${shot.label}（时间并入相邻镜头）`, () => {
      if (i > 0) { const prev = shots[i - 1], pk = prev.camera.keyframes; prev.end = shot.end; pk.push({...pk.at(-1), time: Number((prev.end - prev.start).toFixed(6))}); delete pk.at(-1).ease; pk[pk.length - 2].ease = 'hold'; }
      else { const next = shots[1], len = shot.end - shot.start; next.camera.keyframes = [{...next.camera.keyframes[0], time: 0, ease: 'hold'}, ...next.camera.keyframes.map((k) => ({...k, time: Number((k.time + len).toFixed(6))}))]; next.start = 0; }
      shots.splice(i, 1);
    });
    ctx.rebuildTimeline(); ctx.redraw();
  }
  $('shot-split').addEventListener('click', splitShot); $('shot-delete').addEventListener('click', deleteShot);
  $('shot-name').addEventListener('change', () => {
    const shot = ctx.shotAt(ctx.time()), v = $('shot-name').value.trim().slice(0, 80);
    if (!v || v === shot.label) { $('shot-name').value = shot.label; return; }
    ctx.editor.edit(`镜头改名为「${v}」`, () => { shot.label = v; }); ctx.rebuildTimeline(); ctx.updateUI(true); $('shot-name').blur();
  });
  $('shot-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('shot-name').blur(); if (e.key === 'Escape') { $('shot-name').value = ctx.shotAt(ctx.time()).label; $('shot-name').blur(); } });
  function decorateShots() { // 在镜头块之间加可拖动的边界
    const shots = ctx.config.shots, dur = ctx.config.duration, host = $('shots');
    for (let i = 0; i < shots.length - 1; i++) {
      const h = document.createElement('i'); h.className = 'shot-edge'; h.style.left = `${shots[i].end / dur * 100}%`; h.title = `拖动改变 ${shots[i].label} / ${shots[i + 1].label} 的切点`;
      h.addEventListener('pointerdown', (e) => edgeDrag(e, i, h)); host.append(h);
    }
  }
  function edgeDrag(e, i, h) {
    e.stopPropagation(); e.preventDefault(); if (ctx.busy()) return;
    const shots = ctx.config.shots, A = shots[i], B = shots[i + 1], srcA = JSON.parse(JSON.stringify(A)), srcB = JSON.parse(JSON.stringify(B)), before = ctx.editor.beginEdit();
    const area = $('timeline-area').getBoundingClientRect(), lo = srcA.start + minLen(), hi = srcB.end - minLen(); let moved = false, cur = srcA.end;
    const move = (ev) => {
      const t = snap(ctx.clamp((ev.clientX - area.left) / area.width * ctx.config.duration, lo, hi)); if (Math.abs(t - cur) < 1e-9) return;
      moved = true; cur = t; repartition(A, B, t, srcA, srcB); ctx.tangentCache.delete(A.camera.keyframes); h.style.left = `${t / ctx.config.duration * 100}%`;
      ctx.status(`切点 ${t.toFixed(2)}s · ${A.label} ${(A.end - A.start).toFixed(2)}s / ${B.label} ${(B.end - B.start).toFixed(2)}s`); ctx.seek(t);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved && Math.abs(cur - srcA.end) > 1e-9) { ctx.editor.endEdit(`切点 ${srcA.end.toFixed(2)}s → ${cur.toFixed(2)}s`, before); ctx.status(`切点 ${srcA.end.toFixed(2)}s → ${cur.toFixed(2)}s · Ctrl+Z 撤销`); } ctx.rebuildTimeline(); ctx.redraw(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  return {
    topCam, topClip, onDraw, pick, renderPip, pipOn, setFree, setTop, focusSelection, nudge, splitShot, deleteShot, decorateShots, repartition,
    onResize() { updateTop(); syncPipFrame(); updateGuide(); },
    onAspect() { updateTop(); updateGuide(); }, updateGuide,
    saveView: () => ({free: ctx.free, top: ctx.top, pos: ctx.camera.position.clone(), quat: ctx.camera.quaternion.clone(), tgt: ctx.manualTarget.clone(), center: top.center.clone(), half: top.half}),
    restoreView(v) { if (!v) return; if (v.top) { top.center.copy(v.center); top.half = v.half; setTop(true); } else if (v.free) { ctx.free = true; document.body.classList.add('free-view'); ctx.camera.position.copy(v.pos); ctx.camera.quaternion.copy(v.quat); ctx.manualTarget.copy(v.tgt); syncPipFrame(); ctx.redraw(); } },
    state: () => ({mode: ctx.top ? 'top' : ctx.free ? 'free' : 'shot', overlay: overlay.visible, keyPoints: keyPoints.length, pip: !pipFrame.hidden, top: {center: top.center.toArray(), half: top.half}}),
  };
}
