/* ZPboom.AI 3D 预演 · 视频动捕（本机识别）
   选一段手机拍的视频 → MediaPipe 姿态识别逐帧找出头、肩、肘、腕、胯、膝、踝（三维，单位米）→ 去抖动 → 存成 scene.json 里的动作数据，
   加到角色的播放头处，和 FBX 动捕片段一样播放、调速、淡入淡出、叠加姿态微调和手部接触。视频只在本页处理，不上传。 */
const MP = {nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28};
const LINES = [['shL', 'shR'], ['shL', 'elL'], ['elL', 'wrL'], ['shR', 'elR'], ['elR', 'wrR'], ['shL', 'hipL'], ['shR', 'hipR'], ['hipL', 'hipR'], ['hipL', 'knL'], ['knL', 'anL'], ['hipR', 'knR'], ['knR', 'anR'], ['nose', 'earL'], ['nose', 'earR']];
let modelName = 'full', loadedModel = null, landmarker = null, delegate = null, tsBase = 0, wired = false, ctx = null, state = null;
// MediaPipe 0.10.35 在 Safari 18 里推理会崩（Aborted()，GPU / CPU、画布 / ImageData 都试过）：打开对话框时提示改用 Chrome / Edge。
// 其他浏览器先试 GPU，出错自动换 CPU 重来
const IS_SAFARI = /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
const $ = (id) => document.getElementById(id);

async function ensureModel(say, forceCpu = false) {
  modelName = $('mc-heavy')?.checked ? 'heavy' : 'full'; // 精细识别：pose_landmarker_heavy，复杂动作（摔倒、打斗、地板动作）少认错几帧，慢 2–4 倍
  if (landmarker && loadedModel === modelName && !(forceCpu && delegate === 'GPU')) return landmarker;
  if (landmarker) { try { landmarker.close(); } catch {} landmarker = null; }
  say(modelName === 'heavy' ? '正在载入精细识别模型（约 30 MB，第一次稍慢）…' : '正在载入识别模型（第一次约需几秒）…');
  const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
  const files = await vision.FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm', location.href).href);
  const opts = (delegate) => ({baseOptions: {modelAssetPath: new URL(`./vendor/mediapipe/pose_landmarker_${modelName}.task`, location.href).href, delegate}, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5});
  if (!forceCpu && !IS_SAFARI) { try { landmarker = await vision.PoseLandmarker.createFromOptions(files, opts('GPU')); delegate = 'GPU'; loadedModel = modelName; return landmarker; } catch {} }
  landmarker = await vision.PoseLandmarker.createFromOptions(files, opts('CPU')); delegate = 'CPU'; loadedModel = modelName;
  return landmarker;
}
async function primeVideo(v) { // Safari 的视频没播放过时画面是黑的：静音播一下再停，让它解码出画面
  if (v.dataset.primed) return; try { await v.play(); v.pause(); } catch {} v.dataset.primed = '1';
}
function isBlank(g, cv) { const d = g.getImageData(0, 0, cv.width, cv.height).data; let m = 0; for (let i = 0; i < d.length; i += 4 * 997) m = Math.max(m, d[i], d[i + 1], d[i + 2]); return m < 8; }
const seek = (v, t) => new Promise((resolve) => { if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) { resolve(); return; } v.addEventListener('seeked', () => resolve(), {once: true}); v.currentTime = t; });

function drawFrame(frame, cv = $('mc-canvas')) {
  const g = cv.getContext('2d'), v = $('mc-video'), noVideo = state?.source === 'camera' && (!live.running || live.hold);   // 摄像头片段录完后没有画面，只画骨架
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  const vw = noVideo ? state.vw : v.videoWidth, vh = noVideo ? state.vh : v.videoHeight; if (!vw) return;
  const s = Math.min(cv.width / vw, cv.height / vh), w = vw * s, h = vh * s, x0 = (cv.width - w) / 2, y0 = (cv.height - h) / 2;
  if (noVideo) { g.fillStyle = '#15181b'; g.fillRect(x0, y0, w, h); } else g.drawImage(v, x0, y0, w, h);
  const img = frame?.img; if (!img) return;
  const P = (n) => [x0 + img[MP[n]].x * w, y0 + img[MP[n]].y * h];
  g.lineWidth = 3; g.lineCap = 'round';
  for (const [a, b] of LINES) { g.strokeStyle = a.endsWith('L') || b.endsWith('L') ? (a.endsWith('R') || b.endsWith('R') ? '#7ee787' : '#ff6b6b') : '#6aa8ff'; const [ax, ay] = P(a), [bx, by] = P(b); g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); }
  g.fillStyle = '#ffd166'; for (const n of Object.keys(MP)) { const [px, py] = P(n); g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill(); }
}

async function analyze() {
  const v = $('mc-video'); if (!v.src) { say('先选一段视频'); return; }
  let lm = await ensureModel(say); const fps = ctx.config.fps, t0 = Math.max(0, Number($('mc-start').value) || 0), t1 = Math.min(v.duration, Number($('mc-end').value) || v.duration);
  if (!(t1 > t0)) { say('截取的结束时间要大于开始时间'); return; }
  const n = Math.max(2, Math.floor((t1 - t0) * fps) + 1), frames = [];
  stopPlay(); ctx.endPreview?.(); state.preview = null; $('mc-play').disabled = true;
  $('mc-run').disabled = $('mc-add').disabled = true; state.cancel = false;
  const startMs = performance.now();
  await primeVideo(v);
  // 先画到自己的画布再识别：Safari 直接读 <video> 容易拿到黑帧；长边缩到 1280 以内，速度更稳
  const sc = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight)), scratch = Object.assign(document.createElement('canvas'), {width: Math.round(v.videoWidth * sc), height: Math.round(v.videoHeight * sc)}), sg = scratch.getContext('2d', {willReadFrequently: true});
  let retried = false, blank = 0;
  for (let i = 0; i < n; i++) {
    if (state.cancel) break;
    const t = Math.min(t1, t0 + i / fps); await seek(v, t);
    if (Math.abs(v.currentTime - t) > .25) { $('mc-run').disabled = false; say('视频跳不到指定时间（这个文件不支持跳转），识别会全是同一帧。请用「选择视频…」从本机选文件，或把视频转成普通 MP4 再试'); return; }
    sg.drawImage(v, 0, 0, scratch.width, scratch.height);
    if (i < 3 && isBlank(sg, scratch)) blank++;
    tsBase += 1000 / fps; let res;
    try { res = lm.detectForVideo(scratch, Math.round(tsBase)); }
    catch (e) { // 识别模型崩了（多见于 GPU 模式）：换 CPU 重建模型，从这一帧重来一次
      if (retried) throw e; retried = true; landmarker = null; say('识别模型出错，正在换成兼容模式重试…'); lm = await ensureModel(say, true); tsBase += 1000; res = lm.detectForVideo(scratch, Math.round(tsBase)); }
    const world = res.worldLandmarks?.[0], img = res.landmarks?.[0];
    const ok = Boolean(world && img) && [MP.shL, MP.shR, MP.hipL, MP.hipR].every((k) => (img[k].visibility ?? 1) > .3);
    frames.push(ok ? {t, img, world: Object.fromEntries(Object.entries(MP).map(([k, j]) => [k, [world[j].x, -world[j].y, -world[j].z]]))} : {t, img: img || null, world: null});
    if (i % 3 === 0 || i === n - 1) { drawFrame(frames.at(-1)); say(`识别中 ${i + 1} / ${n} 帧（${Math.round((i + 1) / n * 100)}%）`); await new Promise((r) => setTimeout(r, 0)); }
  }
  $('mc-run').disabled = false;
  const good = frames.filter((f) => f.world).length;
  if (blank >= 3 && !good) { say('浏览器没有给出视频画面（读到的全是黑帧）。请刷新页面后重试；仍不行请换 Chrome / Edge 打开'); return; }
  state.frames = frames; state.fps = fps; state.range = [t0, t1]; state.vw = v.videoWidth; state.vh = v.videoHeight;
  $('mc-scrub').max = String(frames.length - 1); $('mc-scrub').value = '0'; $('mc-scrub').disabled = false;
  if (good < Math.max(2, frames.length * .5)) { say(`只有 ${good} / ${frames.length} 帧认出了人，太少了：请换一段全身入画、光线更好的视频`); return; }
  $('mc-add').disabled = false; $('mc-play').disabled = false; await showIndex(0, true); updateFit();
  say(`识别完成${loadedModel === 'heavy' ? '（精细识别）' : ''}：${good} / ${frames.length} 帧认出了人（${((performance.now() - startMs) / 1000).toFixed(1)} 秒）。右边是套到「${$('mc-actor').selectedOptions[0]?.textContent || '角色'}」上的预览（还没放进工程）：点「对比播放」或拖滑杆对照检查，满意了再「加到角色」。${state.feetUnclear ? '注意：脚没拍全或看不清，跳起高度没开启（只贴地）；要做跳跃请拍到完整的双脚。' : ''}`);
}

function oneEuro(series, fps, minCutoff, beta = .4, dCutoff = 1) { // 去抖动：慢动作多平滑，快动作少延迟
  const alpha = (cut) => { const tau = 1 / (2 * Math.PI * cut), te = 1 / fps; return 1 / (1 + tau / te); };
  let xPrev = series[0], dPrev = 0; return series.map((x, i) => { if (i === 0) return x; const d = (x - xPrev) * fps, dHat = dPrev + alpha(dCutoff) * (d - dPrev), cut = minCutoff + beta * Math.abs(dHat), xHat = xPrev + alpha(cut) * (x - xPrev); xPrev = xHat; dPrev = dHat; return xHat; });
}
/* 离地高度（跳起）：识别出的三维关键点以胯为原点，整个人上下移动的信息在里面没有，所以从画面里找回来。
   手机固定时，脚落地那一刻脚踝在画面上停住、并且是附近一段时间里最低的位置 → 这些「踩地帧」连成地面线（人走近走远，地面线跟着变）；
   两次踩地之间最低那只脚高出地面线的距离，按身体在画面里的像素长度换算成米，就是这一帧的离地高度。走路时总有一只脚踩着，算出来是 0。 */
function computeLift(F, fps, W, H) {
  const n = F.length, good = F.map((f, i) => (f.world && f.img ? i : -1)).filter((i) => i >= 0);
  if (!W || !H || good.length < Math.max(4, n * .5)) return null;
  // 脚要看得清才能算跳：脚踝置信度低或贴着画面下边（脚没拍全）时，模型是在猜脚的位置，会把滑步、交叉步误判成跳。
  // 整段有超过 15% 的帧脚看不清 → 这段不算跳起（只贴地）；否则看不清的单帧按着地处理。
  const footOk = (f) => Math.min(f.img[MP.anL].visibility ?? 1, f.img[MP.anR].visibility ?? 1) >= .7 && Math.max(f.img[MP.anL].y, f.img[MP.anR].y) < .95;
  if (good.filter((i) => footOk(F[i])).length < good.length * .85) return null;
  const fill = (vals) => { const out = new Array(n); let g = 0; for (let i = 0; i < n; i++) { while (g < good.length - 1 && good[g + 1] <= i) g++; const a = good[g], b = good[Math.min(g + 1, good.length - 1)]; out[i] = i <= good[0] ? vals[good[0]] : i >= good.at(-1) ? vals[good.at(-1)] : vals[a] + (vals[b] - vals[a]) * (i - a) / Math.max(1, b - a); } return out; };
  const px = (f, k) => [f.img[MP[k]].x * W, f.img[MP[k]].y * H], d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const mid = (a, b) => a.map((v, c) => (v + b[c]) / 2), raw = {aLy: [], aRy: [], aLx: [], aRx: [], mpp: []};
  for (const i of good) { const f = F[i], w = f.world, segs = [['hipL', 'knL'], ['knL', 'anL'], ['hipR', 'knR'], ['knR', 'anR']];
    const L3 = segs.reduce((s, [a, b]) => s + d3(w[a], w[b]), 0) + d3(mid(w.shL, w.shR), mid(w.hipL, w.hipR)), L2 = segs.reduce((s, [a, b]) => s + d2(px(f, a), px(f, b)), 0) + d2(mid(px(f, 'shL'), px(f, 'shR')), mid(px(f, 'hipL'), px(f, 'hipR')));
    raw.mpp[i] = L2 > 1 ? L3 / L2 : NaN; [raw.aLx[i], raw.aLy[i]] = px(f, 'anL'); [raw.aRx[i], raw.aRy[i]] = px(f, 'anR'); }
  const ok = good.filter((i) => Number.isFinite(raw.mpp[i])); if (ok.length < 4) return null; for (const i of good) if (!Number.isFinite(raw.mpp[i])) raw.mpp[i] = raw.mpp[ok[0]];
  const ma = (a, r) => a.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { s += a[j]; c++; } return s / c; });
  const aLy = ma(fill(raw.aLy), 1), aRy = ma(fill(raw.aRy), 1), aLx = ma(fill(raw.aLx), 1), aRx = ma(fill(raw.aRx), 1), mppAll = fill(raw.mpp);
  const win = (r, fn) => Array.from({length: n}, (_, i) => fn(i, Math.max(0, i - r), Math.min(n - 1, i + r)));
  // 米 / 像素：身体朝镜头倾斜时画面里会变短（数值偏大），取前后 1 秒里偏小的那四分之一
  const mpp = win(Math.round(fps), (i, a, b) => { const s = mppAll.slice(a, b + 1).sort((x, y) => x - y); return s[Math.floor(s.length * .25)]; });
  const low = aLy.map((y, i) => Math.max(y, aRy[i])), r4 = Math.max(2, Math.round(.4 * fps)), winLow = win(r4, (i, a, b) => Math.max(...low.slice(a, b + 1)));
  const speed = (X, Y, i) => { const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); return Math.hypot(X[b] - X[a], Y[b] - Y[a]) / Math.max(1, b - a) * fps * mpp[i]; };
  const floorAt = [];
  for (let i = 0; i < n; i++) { let best = -Infinity;
    for (const [X, Y] of [[aLx, aLy], [aRx, aRy]]) if (speed(X, Y, i) < .4 && (winLow[i] - Y[i]) * mpp[i] < .06) best = Math.max(best, Y[i]);
    if (best > -Infinity) floorAt.push([i, best]); }
  if (!floorAt.length) return null;
  const floor = new Array(n); let k = 0;
  for (let i = 0; i < n; i++) { while (k < floorAt.length - 1 && floorAt[k + 1][0] <= i) k++; const [ia, ya] = floorAt[k], [ib, yb] = floorAt[Math.min(k + 1, floorAt.length - 1)]; floor[i] = i <= floorAt[0][0] ? floorAt[0][1] : i >= floorAt.at(-1)[0] ? floorAt.at(-1)[1] : ya + (yb - ya) * (i - ia) / Math.max(1, ib - ia); }
  const h = low.map((y, i) => (F[i].img && footOk(F[i]) ? Math.max(0, (floor[i] - y) * mpp[i]) : 0));
  // 只保留真正离地的段落：至少 3 帧高于 5 厘米；段落两头延伸到 1 厘米处，起跳落地不跳变
  const lift = new Array(n).fill(0);
  for (let i = 0; i < n;) { if (h[i] <= .05) { i++; continue; } let j = i; while (j < n && h[j] > .05) j++;
    if (j - i >= 3) { let a = i, b = j - 1; while (a > 0 && h[a - 1] > .01) a--; while (b < n - 1 && h[b + 1] > .01) b++; for (let q = a; q <= b; q++) lift[q] = Math.min(2, h[q]); }
    i = j; }
  if (!lift.some((v) => v > 0)) return lift.map(() => 0);
  const fwd = oneEuro(lift, fps, 3), bwd = oneEuro([...lift].reverse(), fps, 3).reverse(); // 正反各滤一遍再平均，不滞后
  return fwd.map((v, i) => Number(Math.max(0, (v + bwd[i]) / 2).toFixed(3)));
}
function buildData() {
  const F = state.frames, names = ctx.POSE_PTS, n = F.length;
  // 没认出人的帧：用前后认出的帧插值
  const idxs = F.map((f, i) => (f.world ? i : -1)).filter((i) => i >= 0);
  const pts = F.map((f, i) => {
    if (f.world) return f.world;
    const prev = idxs.filter((j) => j < i).at(-1), next = idxs.find((j) => j > i);
    if (prev === undefined) return F[next].world; if (next === undefined) return F[prev].world;
    const r = (i - prev) / (next - prev); return Object.fromEntries(names.map((k) => [k, F[prev].world[k].map((v, c) => v + (F[next].world[k][c] - v) * r)]));
  });
  // 前后翻转修正：单目识别偶尔把“正对镜头”当成“背对镜头”（左右标签互换、深度反向），表现为朝向在一帧内跳近 180°。
  // 每帧比较“原样”和“左右互换 + 深度取反”两种解释，选和上一帧朝向更连贯的那个。
  const PAIRS = [['earL', 'earR'], ['shL', 'shR'], ['elL', 'elR'], ['wrL', 'wrR'], ['hipL', 'hipR'], ['knL', 'knR'], ['anL', 'anR']];
  const yawOf = (p) => Math.atan2(p.hipL[2] - p.hipR[2] + p.shL[2] - p.shR[2], p.hipL[0] - p.hipR[0] + p.shL[0] - p.shR[0]);
  const flipOf = (p) => { const q = {}; for (const k of names) q[k] = [p[k][0], p[k][1], -p[k][2]]; for (const [a, b] of PAIRS) [q[a], q[b]] = [q[b], q[a]]; return q; };
  const wrapA = (x) => Math.atan2(Math.sin(x), Math.cos(x)); let prevYaw = yawOf(pts[0]), flips = 0;
  for (let i = 1; i < pts.length; i++) { const alt = flipOf(pts[i]), d0 = Math.abs(wrapA(yawOf(pts[i]) - prevYaw)), d1 = Math.abs(wrapA(yawOf(alt) - prevYaw)); if (d1 + .5 < d0) { pts[i] = alt; flips++; } prevYaw = yawOf(pts[i]); }
  state.flips = flips;
  const smooth = Number($('mc-smooth').value), minCutoff = 6 * Math.pow(1 - smooth, 2) + .25;
  const out = pts.map(() => ({}));
  for (const k of names) for (let c = 0; c < 3; c++) { const s = oneEuro(pts.map((p) => p[k][c]), state.fps, minCutoff); s.forEach((v, i) => { (out[i][k] ||= [0, 0, 0])[c] = v; }); }
  if ($('mc-face').checked) { // 让第一帧的骨盆朝向正对前方（之后的转身保留）
    const p = out[0], left = [p.hipL[0] - p.hipR[0], p.hipL[2] - p.hipR[2]], yaw = Math.atan2(-left[1], left[0]); // 左右胯连线转到 +X
    const c = Math.cos(-yaw), s2 = Math.sin(-yaw);
    for (const f of out) for (const k of names) { const [x, y, z] = f[k]; f[k] = [x * c + z * s2, y, -x * s2 + z * c]; }
  }
  const lift = computeLift(F, state.fps, state.vw, state.vh); state.jumps = lift ? lift.filter((v, i) => v > .05 && !(lift[i - 1] > .05)).length : 0; state.feetUnclear = !lift;
  return {format: 'zpboom-pose', version: 2, fps: state.fps, points: names, frames: out.map((f) => names.flatMap((k) => f[k].map((v) => Number(v.toFixed(4))))), ...(lift ? {lift} : {}),
    source: {video: state.name, ...(state.source === 'camera' ? {camera: true} : {}), flipsFixed: state.flips || 0, start: Number(state.range[0].toFixed(3)), end: Number(state.range[1].toFixed(3)), detected: `${F.filter((f) => f.world).length}/${n}`, model: `MediaPipe pose_landmarker_${loadedModel || modelName}`, smooth, jumps: state.jumps}};
}
/* 起点：动作从工程的第几秒开始。打开对话框时填当前播放头，之后保持不变（连续给几个人加时都从同一秒开始），可改、可一键设 0 秒 / 播放头。
   动作超出工程结尾的部分播不到，提前提示，避免「只播了 1.4 秒」这种情况。 */
const motionSecs = () => (state?.frames ? (state.frames.length - 1) / state.fps : 0);
const fmt = (x) => Number(x.toFixed(2));
function fitInfo() {
  const end = ctx.config.duration, start = Math.max(0, Number($('mc-at').value) || 0), dur = motionSecs(), play = Math.max(0, Math.min(dur, end - start));
  return {end, start, dur, play, cut: dur - play};
}
function updateFit() {
  const el = $('mc-fit'); if (!el) return; if (!state?.frames) { el.textContent = ''; el.classList.remove('warn'); return; }
  const {end, start, dur, play, cut} = fitInfo();
  el.classList.toggle('warn', cut > .05);
  el.textContent = start >= end ? `起点 ${fmt(start)} 秒已经超过工程结尾（${end} 秒），加进去也播不到：请把起点调早。`
    : cut > .05 ? `动作 ${fmt(dur)} 秒，从 ${fmt(start)} 秒开始只能播 ${fmt(play)} 秒（工程在 ${end} 秒结束，后面 ${fmt(cut)} 秒播不到）。把起点调早，或让 Claude 延长工程时长。`
    : `动作 ${fmt(dur)} 秒：从 ${fmt(start)} 秒播到 ${fmt(start + dur)} 秒（工程 ${end} 秒）。`;
  if (start < end) el.textContent += overlapNote(start, start + play);
}
function overlapNote(a, b) { // 这段时间里所选角色原来有什么，以及按当前「原有动作」选项会怎么处理
  const actor = ctx.config.actors.find((x) => x.id === $('mc-actor').value); if (!actor) return '';
  const clips = (actor.clips || []).filter((c) => { const [s, e] = ctx.clipWindow(c); return s < b && e > a; }).length;
  const keys = actor.keyframes.filter((k) => k.time >= a - .01 && k.time <= b + .01), extra = keys.filter((k) => k.reachL || k.reachR || k.adjust).length;
  if (!clips && !keys.length) return ' 这段时间该角色没有其他动作。';
  const has = [clips && `${clips} 个动作片段`, keys.length && `${keys.length} 个关键帧${extra ? `（${extra} 个带手部接触 / 微调）` : ''}`].filter(Boolean).join('、'), mode = $('mc-mode').value;
  return ` 这段时间原有 ${has}：` + (mode === 'all' ? '完全覆盖——原动作、手部接触、微调都不生效，重叠的片段会裁掉，站位朝向固定在起点（原关键帧保留，片段外照常）。' : mode === 'pose' ? '覆盖姿态——原动作、手部接触、微调都不生效，重叠的片段会裁掉，站位朝向仍按关键帧（原关键帧保留，片段外照常）。' : '叠加——原关键帧的手部接触、微调、走位和重叠片段仍会生效；要替换请选「覆盖」。');
}
async function addToActor() {
  const actorId = $('mc-actor').value, cfg = ctx.config, actor = cfg.actors.find((a) => a.id === actorId); if (!actor || !state.frames) return;
  let id = ($('mc-name').value.trim() || 'video_mocap').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'video_mocap';
  const base = id; let k = 2; while ((cfg.motions || []).some((m) => m.id === id)) id = `${base}_${k++}`;
  stopPlay(); ctx.endPreview?.();
  const {end, start: at, play} = fitInfo(); if (at >= end) { say(`起点 ${fmt(at)} 秒已经超过工程结尾（${end} 秒），没有加：请把起点调早。`); return; }
  const data = buildData(), start = Number(at.toFixed(3)), dur = (data.frames.length - 1) / data.fps, cut = dur - play;
  ctx.editor.edit(`视频动捕「${id}」加到 ${actor.id} 的 ${start.toFixed(2)}s（${dur.toFixed(1)} 秒）`, () => {
    cfg.motions = [...(cfg.motions || []), {id, label: state.name.slice(0, 80), data}];
    const mode = $('mc-mode').value, b = start + play; let trimmed = 0;
    if (mode) { // 覆盖：重叠的旧片段让出这段时间（之前的截到起点，之后的从结尾接着播，整段在里面的删掉）
      const kept = [];
      for (const c of actor.clips || []) {
        const [s, e] = ctx.clipWindow(c); if (e <= start || s >= b) { kept.push(c); continue; } trimmed++;
        if (s < start) kept.push({...c, end: Number(start.toFixed(3)), hold: false});
        if (e > b) kept.push({...c, start: Number(b.toFixed(3)), offset: Number((c.offset + Math.max(0, b - c.start) * c.speed).toFixed(3)), fadeIn: Math.min(c.fadeIn ?? .2, .2)});
      }
      actor.clips = kept;
    }
    state.trimmed = trimmed;
    actor.clips = [...(actor.clips || []), {motion: id, start, offset: 0, speed: 1, weight: 1, fadeIn: .2, fadeOut: .2, loop: false, rootMotion: false, hold: false, ...(mode ? {override: mode} : {})}];
  });
  await ctx.reloadMotions();
  say(`已加到 ${actor.label}：从 ${start.toFixed(2)}s 开始播放 ${play.toFixed(1)} 秒${cut > .05 ? `（动作共 ${dur.toFixed(1)} 秒，超出工程结尾的 ${cut.toFixed(1)} 秒播不到）` : ''}${state.jumps ? `，认出 ${state.jumps} 次跳起（双脚离地）` : ''}${state.feetUnclear ? '（脚没拍全或看不清，跳起高度没开启，只贴地）' : ''}${$('mc-mode').value ? `；${$('mc-mode').value === 'all' ? '完全覆盖' : '覆盖姿态'}这段时间的原动作${state.trimmed ? `，裁掉了 ${state.trimmed} 个重叠片段` : ''}` : ''}。关掉对话框按空格看效果；不满意 Ctrl+Z 撤销。`);
  ctx.status(`视频动捕「${id}」已加到 ${actor.id} · Ctrl+S 保存 · Ctrl+Z 撤销`);
}
function say(text) { $('mc-status').textContent = text; }

/* 对比预览：左边原视频 + 骨架，右边把当前识别结果（按现在的平滑 / 朝向设置）临时套到所选角色上，两边同一帧。 */
function previewData() {
  const key = `${$('mc-smooth').value}|${$('mc-face').checked}`;
  if (!state.preview || state.preview.frames !== state.frames || state.preview.key !== key) state.preview = {frames: state.frames, key, data: buildData()};
  return state.preview.data;
}
function label(g, text, x, y, color = '#fff') { g.font = '600 15px system-ui, sans-serif'; const w = g.measureText(text).width; g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x - 6, y - 17, w + 12, 24); g.fillStyle = color; g.fillText(text, x, y); }
function renderIndex(i) {
  const F = state.frames, f = F[i], data = previewData(), lift = data.lift?.[i] ?? 0, air = lift > .05;
  drawFrame(f); const g = $('mc-canvas').getContext('2d');
  label(g, f?.world ? (air ? `腾空 ${Math.round(lift * 100)} cm` : '着地') : '这一帧没认出人（用前后帧补）', 14, 28, f?.world ? (air ? '#ffd166' : '#fff') : '#ff8a8a');
  const pv = $('mc-preview'), actorId = $('mc-actor').value, res = ctx.renderPreview?.(pv, actorId, data, i / data.fps, {override: $('mc-mode').value || null, at: fitInfo().start});
  if (res) label(pv.getContext('2d'), `白膜预览 · 脚底离地 ${Math.max(0, Math.round(res.foot * 100))} cm`, 12, pv.height - 14); // 放底部，不挡角色名牌
  $('mc-frame').textContent = `${f.t.toFixed(2)}s · ${i + 1}/${F.length}`;
}
async function showIndex(i, doSeek) { if (!state?.frames) return; const f = state.frames[i]; if (doSeek && state.source !== 'camera') await seek($('mc-video'), f.t); renderIndex(i); }
function currentIndex() { return Number($('mc-scrub').value) || 0; }
function play() {
  if (!state?.frames || state.playing) return;
  if (state.source === 'camera') { // 摄像头片段：没有视频可放，按工程帧率逐帧走
    const n = state.frames.length; state.playing = true; $('mc-play').textContent = '❚❚ 暂停'; let i = currentIndex() >= n - 1 ? 0 : currentIndex();
    const tick = () => { if (!state.playing) return; $('mc-scrub').value = String(i); renderIndex(i); i = (i + 1) % n; state.raf = setTimeout(tick, 1000 / state.fps); };
    tick(); return;
  }
  const v = $('mc-video'), [t0, t1] = state.range, n = state.frames.length; state.playing = true; $('mc-play').textContent = '❚❚ 暂停';
  v.currentTime = state.frames[currentIndex() >= n - 1 ? 0 : currentIndex()].t; v.play().catch(() => {});
  const step = () => {
    if (!state.playing) return;
    if (v.ended || v.currentTime >= t1 - 1e-3) { v.currentTime = t0; v.play().catch(() => {}); }
    const i = Math.max(0, Math.min(n - 1, Math.round((v.currentTime - t0) * state.fps))); $('mc-scrub').value = String(i); renderIndex(i);
    state.raf = setTimeout(step, 1000 / Math.min(60, state.fps)); // 用定时器而不是 requestAnimationFrame：窗口在后台时也按视频帧率走
  };
  state.raf = setTimeout(step, 0);
}
function stopPlay() { if (!state?.playing) return; state.playing = false; clearTimeout(state.raf); if (state.source !== 'camera') $('mc-video').pause(); $('mc-play').textContent = '▶ 对比播放'; }
function togglePlay() { if (state?.playing) stopPlay(); else play(); }
function refreshPreview() { if (!state?.frames || state.playing) return; renderIndex(currentIndex()); }


/* ───────── 实时动捕（摄像头）─────────
   打开摄像头 → 每一帧识别 → 实时去抖动 → 套到所选角色上：左边可以看镜头画面（其他角色、机位照常），右边看摄像头 + 骨架。
   「录制」：3 秒倒计时后从「起点」开始按真实时间走时间线，你跟着画面表演；停止后把录到的帧按工程帧率重新取样，
   交给和视频动捕完全相同的流程（前后翻转修正、平滑、朝向、自动踩地、跳起检测、对比回放、起点 / 覆盖方式、加到角色）。画面只在本页处理，不上传、不保存。 */
const live = {stream: null, running: false, hold: false, rec: null, countdown: 0, fps: 0, last: 0, filt: null, prevYaw: null, yaw0: null, scratch: null, takes: 0, token: 0, opening: false};
const LR_PAIRS = [['earL', 'earR'], ['shL', 'shR'], ['elL', 'elR'], ['wrL', 'wrR'], ['hipL', 'hipR'], ['knL', 'knR'], ['anL', 'anR']];
const yawOfPts = (p) => Math.atan2(p.hipL[2] - p.hipR[2] + p.shL[2] - p.shR[2], p.hipL[0] - p.hipR[0] + p.shL[0] - p.shR[0]);
const wrapAng = (x) => Math.atan2(Math.sin(x), Math.cos(x));
function flipPts(p) { const q = {}; for (const k of Object.keys(p)) q[k] = [p[k][0], p[k][1], -p[k][2]]; for (const [a, b] of LR_PAIRS) [q[a], q[b]] = [q[b], q[a]]; return q; }
function euro(minCutoff, beta = .4, dCutoff = 1) { // 一欧元滤波（逐帧版）：慢动作多平滑，快动作少延迟
  let x0 = null, d0 = 0; const a = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut) / dt);
  return (x, dt) => { if (x0 === null) { x0 = x; return x; } const d = (x - x0) / dt, dh = d0 + a(dCutoff, dt) * (d - d0), xh = x0 + a(minCutoff + beta * Math.abs(dh), dt) * (x - x0); x0 = xh; d0 = dh; return xh; };
}
function setLiveUI(on) {
  $('mc-live').hidden = !on; $('mc-run').hidden = on; $('mc-cam').textContent = on ? '📷 摄像头已开' : '📷 摄像头实时'; $('mc-cam').disabled = on;
  for (const id of ['mc-start', 'mc-end']) $(id).disabled = on;
  if (on) $('mc-file-name').textContent = '摄像头（实时，不保存画面）';
}
function cameraError(e) {
  const msg = String(e?.name || e?.message || e); stopCamera(); setLiveUI(false);
  say(/NotAllowed|Permission/i.test(msg) ? '浏览器没有拿到摄像头权限：点地址栏左边的摄像头图标，改成「允许」，再点「📷 摄像头实时」。'
    : /NotFound|Overconstrained/i.test(msg) ? '没有找到摄像头：确认电脑有摄像头（或外接摄像头已插好），并且没有被别的软件占用。'
    : /Aborted|kGpuService/.test(msg) ? `识别模型在这个浏览器里崩溃了${IS_SAFARI ? '（Safari 已知问题）' : ''}：请用 Chrome 或 Edge 打开。` : `摄像头打不开：${e?.message || msg}`);
  console.error(e);
}
async function startCamera() {
  if (live.running || live.opening) return;   // 正在打开时再点一次不重复申请（否则前一路摄像头没人关）
  if (IS_SAFARI) { say('Safari 里识别模型会崩溃，实时动捕请用 Chrome 或 Edge 打开。'); return; }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器不支持摄像头（需要用 http://127.0.0.1 或 localhost 打开）');
  stopPlay(); ctx.endPreview?.();
  say('正在打开摄像头（浏览器会问是否允许，请点「允许」）…');
  // 等权限 / 载入模型期间对话框可能被关掉：stopCamera 会让 token 变化，拿到的摄像头立即关掉，不在后台偷偷开着
  const token = ++live.token, stale = () => token !== live.token || !$('mocap-dialog').open;
  live.opening = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({video: {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}}, audio: false});
    if (stale()) { for (const t of stream.getTracks()) t.stop(); return; }
    const v = $('mc-video'); if (v.src) { URL.revokeObjectURL(v.src); v.removeAttribute('src'); }
    v.srcObject = stream; live.stream = stream; await v.play();
    await ensureModel(say);
    if (stale()) { stopCamera(); return; }
  } finally { live.opening = false; }
  const v = $('mc-video');
  state = {name: 'camera', frames: null, source: 'camera'}; $('mc-add').disabled = $('mc-play').disabled = $('mc-scrub').disabled = true; $('mc-frame').textContent = ''; $('mc-fit').textContent = '';
  Object.assign(live, {running: true, hold: false, rec: null, countdown: 0, fps: 0, last: 0, filt: null, prevYaw: null, yaw0: null});
  setLiveUI(true); $('mc-rec').textContent = '● 录制'; $('mc-rec').classList.remove('on');
  say(`摄像头已打开（${v.videoWidth}×${v.videoHeight}，识别用${delegate === 'GPU' ? '显卡' : 'CPU'}）。站到全身都能入画的位置（笔记本摄像头一般要 2.5–3 米），人偶会跟着你动。准备好了点「● 录制」：3 秒倒计时后工程从「起点」开始播放，你跟着画面表演。`);
  liveLoop();
}
function stopCamera() {
  live.token++;
  if (live.stream) for (const t of live.stream.getTracks()) t.stop();
  live.stream = null; live.running = false; live.rec = null; live.countdown = 0;
  const v = $('mc-video'); if (v.srcObject) { v.pause(); v.srcObject = null; }
}
function liveFrame(v) {
  const sc = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));   // 实时只取 640 宽来识别，速度更稳
  live.scratch ||= document.createElement('canvas'); const cv = live.scratch, g = cv.getContext('2d', {willReadFrequently: true});
  if (cv.width !== Math.round(v.videoWidth * sc)) { cv.width = Math.round(v.videoWidth * sc); cv.height = Math.round(v.videoHeight * sc); }
  g.drawImage(v, 0, 0, cv.width, cv.height);
  const now = performance.now(); tsBase = Math.max(tsBase + 1, now);
  const res = landmarker.detectForVideo(cv, Math.round(tsBase)), world = res.worldLandmarks?.[0], img = res.landmarks?.[0];
  const ok = Boolean(world && img) && [MP.shL, MP.shR, MP.hipL, MP.hipR].every((k) => (img[k].visibility ?? 1) > .3);
  return {now, img: img || null, world: ok ? Object.fromEntries(Object.entries(MP).map(([k, j]) => [k, [world[j].x, -world[j].y, -world[j].z]])) : null};
}
function livePose(world, dt) { // 实时去抖动 + 前后翻转修正 + 朝向对准正面，得到这一帧套到人偶上的点
  let p = world; const y = yawOfPts(p);
  if (live.prevYaw !== null) { const alt = flipPts(p); if (Math.abs(wrapAng(yawOfPts(alt) - live.prevYaw)) + .5 < Math.abs(wrapAng(y - live.prevYaw))) p = alt; }
  live.prevYaw = yawOfPts(p);
  const smooth = Number($('mc-smooth').value) * .7, minCutoff = 6 * Math.pow(1 - smooth, 2) + .4;   // 实时比录完后少平滑一点，跟手
  if (!live.filt || live.filt.cut !== minCutoff) live.filt = {cut: minCutoff, f: {}};
  const out = {};
  for (const k of ctx.POSE_PTS) out[k] = p[k].map((v, c) => (live.filt.f[k + c] ||= euro(minCutoff))(v, dt));
  if ($('mc-face').checked) {
    if (live.yaw0 === null) { const left = [out.hipL[0] - out.hipR[0], out.hipL[2] - out.hipR[2]]; live.yaw0 = Math.atan2(-left[1], left[0]); }
    const c = Math.cos(-live.yaw0), s2 = Math.sin(-live.yaw0); for (const k of ctx.POSE_PTS) { const [x, yy, z] = out[k]; out[k] = [x * c + z * s2, yy, -x * s2 + z * c]; }
  }
  return {format: 'zpboom-pose', version: 2, fps: ctx.config.fps, points: ctx.POSE_PTS, frames: [ctx.POSE_PTS.flatMap((k) => out[k])]};
}
function overlay(cv, lines) { const g = cv.getContext('2d'); lines.forEach(([text, color], i) => label(g, text, 14, 28 + i * 30, color)); }
function liveLoop() {
  if (!live.running) return;
  // 优先等摄像头的下一帧；但浏览器不刷新画面时（窗口被挡住、面板在后台）这个回调可能 1 秒才来一次，所以 150 ms 没来就用定时器接着跑，录制不会只剩几帧
  const v = $('mc-video'), next = () => {
    if (!live.running) return;
    if (!v.requestVideoFrameCallback || document.hidden) { setTimeout(liveLoop, 16); return; }
    let done = false, timer = 0; const id = v.requestVideoFrameCallback(() => { if (done) return; done = true; clearTimeout(timer); liveLoop(); });
    timer = setTimeout(() => { if (done) return; done = true; v.cancelVideoFrameCallback?.(id); liveLoop(); }, 150);
  };
  if (live.hold || v.readyState < 2) { next(); return; }
  let f; try { f = liveFrame(v); } catch (e) { cameraError(e); return; }
  const dt = live.last ? Math.min(.25, (f.now - live.last) / 1000) : 1 / 30; live.last = f.now;
  live.fps = live.fps ? live.fps * .9 + (1 / dt) * .1 : 1 / dt; $('mc-fps').textContent = `${live.fps.toFixed(0)} 帧/秒`;
  const at = Math.max(0, Number($('mc-at').value) || 0), end = ctx.config.duration, actorId = $('mc-actor').value;
  let t = ctx.time(), recLine = null;
  if (live.countdown) { const left = Math.ceil((live.countdown - f.now) / 1000); if (left <= 0) { live.countdown = 0; live.rec = {at, start: f.now, raw: []}; $('mc-rec').textContent = '■ 停止'; } else { recLine = [`${left}`, '#ffd166']; t = at; } }
  if (live.rec) { const el = (f.now - live.rec.start) / 1000; t = at + el; live.rec.raw.push({t: el, img: f.img, world: f.world}); recLine = [`● 录制中 ${el.toFixed(1)} 秒 · 工程 ${t.toFixed(2)} / ${end} 秒`, '#ff6b6b']; if (t >= end) { stopRecording(); return; } }
  const data = f.world ? livePose(f.world, dt) : null, override = $('mc-mode').value || null, view = $('mc-view').value;
  const big = $('mc-canvas'), small = $('mc-preview');
  if (view === 'shot' && data) { ctx.renderShot(big, actorId, data, t, {override, at: live.rec ? live.rec.at : at}); drawFrame({img: f.img}, small); }
  else { drawFrame({img: f.img}, big); if (data) ctx.renderPreview(small, actorId, data, 0, {override, at: t}); else { const g = small.getContext('2d'); g.fillStyle = '#1b1e22'; g.fillRect(0, 0, small.width, small.height); } }
  overlay(view === 'shot' && data ? big : big, [f.world ? ['认出人了', '#7ee787'] : ['没认出人：请让全身完整入画', '#ff8a8a'], ...(recLine ? [recLine] : [])]);
  next();
}
function startRecording() {
  if (!live.running) return;
  stopPlay(); live.hold = false; state = {name: 'camera', frames: null, source: 'camera'}; $('mc-add').disabled = $('mc-play').disabled = $('mc-scrub').disabled = true; $('mc-fit').textContent = '';
  live.countdown = performance.now() + 3000; live.rec = null; $('mc-rec').textContent = '■ 取消'; $('mc-rec').classList.add('on');
  say(`3 秒后开始录：工程从 ${fmt(Math.max(0, Number($('mc-at').value) || 0))} 秒开始播放，跟着画面表演；再点「■ 停止」结束（播到工程结尾会自动停）。`);
}
function stopRecording() {
  $('mc-rec').classList.remove('on'); $('mc-rec').textContent = '● 重新录制';
  if (live.countdown && !live.rec) { live.countdown = 0; say('已取消录制。'); return; }
  const rec = live.rec; live.rec = null; live.countdown = 0; if (!rec || rec.raw.length < 3) { say('录得太短了，再录一次。'); return; }
  // 摄像头的帧率不固定：按工程帧率重新取样（取时间最近的一帧，隔得太远就当没认出人，后面会用前后帧补）
  const fps = ctx.config.fps, raw = rec.raw, dur = raw.at(-1).t, n = Math.max(2, Math.floor(dur * fps) + 1), frames = []; let j = 0;
  for (let i = 0; i < n; i++) { const t = i / fps; while (j < raw.length - 1 && Math.abs(raw[j + 1].t - t) <= Math.abs(raw[j].t - t)) j++; const r = raw[j]; frames.push(Math.abs(r.t - t) <= .12 ? {t, img: r.img, world: r.world} : {t, img: null, world: null}); }
  const v = $('mc-video'), good = frames.filter((f) => f.world).length; live.takes++;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  state = {name: `camera_${stamp}`, frames, fps, range: [0, dur], vw: v.videoWidth, vh: v.videoHeight, source: 'camera'};
  live.hold = true;    // 停下实时画面，换成回放这一条
  $('mc-at').value = fmt(rec.at); $('mc-name').value = state.name;
  $('mc-scrub').max = String(frames.length - 1); $('mc-scrub').value = '0'; $('mc-scrub').disabled = false;
  if (good < Math.max(2, frames.length * .5)) { say(`只有 ${good} / ${frames.length} 帧认出了人，太少了：退远一点让全身入画、把灯打亮，再「● 重新录制」。`); return; }
  $('mc-add').disabled = false; $('mc-play').disabled = false; renderIndex(0); updateFit();
  say(`录好了：${dur.toFixed(1)} 秒，${good} / ${frames.length} 帧认出了人（摄像头平均 ${live.fps.toFixed(0)} 帧/秒）。右边是套到角色上的样子（还没放进工程）：点「对比播放」检查，满意了「加到角色」，不满意「● 重新录制」。${state.feetUnclear ? '脚没拍全，跳起高度没开启（只贴地）。' : ''}`);
}

function wire() {
  if (wired) return; wired = true;
  $('mc-pick').addEventListener('click', () => $('mc-file').click());
  $('mc-file').addEventListener('change', () => {
    const f = $('mc-file').files[0]; if (!f) return;
    stopCamera(); setLiveUI(false);
    const v = $('mc-video'); if (v.src) URL.revokeObjectURL(v.src);
    stopPlay(); ctx.endPreview?.(); $('mc-preview').getContext('2d').clearRect(0, 0, 405, 405); $('mc-frame').textContent = ''; $('mc-fit').textContent = '';
    state = {name: f.name, frames: null}; delete v.dataset.primed; v.src = URL.createObjectURL(f); $('mc-file-name').textContent = f.name; $('mc-add').disabled = true; $('mc-scrub').disabled = true; $('mc-play').disabled = true;
    v.addEventListener('loadeddata', async () => { await primeVideo(v); $('mc-start').value = 0; $('mc-end').value = Number(v.duration.toFixed(2)); $('mc-name').value = f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'video_mocap'; await seek(v, 0); drawFrame(null); say(`视频 ${v.videoWidth}×${v.videoHeight}，${v.duration.toFixed(1)} 秒。可以先截取一段，再点「识别动作」。`); }, {once: true});
  });
  $('mc-run').addEventListener('click', () => analyze().catch((e) => { $('mc-run').disabled = false; landmarker = null; const msg = String(e?.message || e);
    say(/Aborted|kGpuService/.test(msg) ? `识别模型在这个浏览器里崩溃了${IS_SAFARI ? '（Safari 已知问题）' : ''}：请用 Chrome 或 Edge 打开 ${location.href.split('#')[0]} 再做视频动捕。` : `识别失败：${msg}`); console.error(e); }));
  $('mc-add').addEventListener('click', () => addToActor().catch((e) => say(`没加上：${e.message || e}`)));
  $('mc-scrub').addEventListener('input', async () => { if (!state?.frames) return; stopPlay(); await showIndex(currentIndex(), true); });
  $('mc-play').addEventListener('click', togglePlay);
  $('mc-at-zero').addEventListener('click', () => { $('mc-at').value = 0; updateFit(); refreshPreview(); });
  $('mc-at-head').addEventListener('click', () => { $('mc-at').value = fmt(ctx.time()); updateFit(); refreshPreview(); });
  for (const id of ['mc-smooth', 'mc-face', 'mc-actor', 'mc-mode', 'mc-at']) $(id).addEventListener('input', () => { updateFit(); refreshPreview(); });
  $('mocap-dialog').addEventListener('keydown', (e) => { if (live.running && !live.hold) return; if (e.code !== 'Space' || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox' || $('mc-play').disabled) return; e.preventDefault(); e.stopPropagation(); togglePlay(); });
  $('mocap-dialog').addEventListener('close', () => { stopPlay(); stopCamera(); ctx.endPreview?.(); });
  $('mc-cam').addEventListener('click', () => startCamera().catch(cameraError));
  $('mc-rec').addEventListener('click', () => (live.rec || live.countdown ? stopRecording() : startRecording()));
  // 关闭按钮和 Esc 当场关摄像头，不只靠 close 事件（close 事件是异步派发的，页面在后台时可能迟迟不来）
  $('mocap-dialog').addEventListener('cancel', () => { stopPlay(); stopCamera(); });
  $('mc-close').addEventListener('click', () => { if (state) state.cancel = true; stopPlay(); stopCamera(); $('mocap-dialog').close(); }); // close 事件里停止预览
}
export function openVideoMocap(c, opts = {}) {
  ctx = c; wire(); state ||= {frames: null};
  $('mc-at').value = fmt(c.time()); 
  const sel = $('mc-actor'), cur = c.editor?.state().selection;
  sel.replaceChildren(...c.config.actors.map((a) => Object.assign(document.createElement('option'), {value: a.id, textContent: a.label})));
  if (cur?.type === 'actor') sel.value = cur.id;
  updateFit();
  if (IS_SAFARI) say(`提示：Safari 里识别模型会崩溃（实测 Safari 18），视频动捕请用 Chrome 或 Edge 打开 ${location.href.split('#')[0]}。其他功能 Safari 都能正常用。`);
  else if (!$('mc-video').src && !opts.live) say('选一段手机拍的视频：手机固定不动、全身完整入画、光线充足、尽量只有一个人。正面或斜 45° 拍最准。也可以点「📷 摄像头实时」直接用电脑摄像头。');
  $('mocap-dialog').showModal();
  if (opts.live && !IS_SAFARI) startCamera().catch(cameraError);
}
export const _test = {live: () => live, startCamera, stopCamera, startRecording, stopRecording, delegate: () => delegate, model: () => loadedModel, analyze, buildData, computeLift, showIndex, play, stopPlay, addToActor, ensureModel, state: () => state, setVideoUrl: (url, name) => new Promise((resolve) => { wire(); const v = $('mc-video'); state = {name, frames: null}; delete v.dataset.primed; v.src = url; v.addEventListener('loadeddata', async () => { $('mc-start').value = 0; $('mc-end').value = Number(v.duration.toFixed(2)); $('mc-name').value = name; await seek(v, 0); resolve(v.duration); }, {once: true}); })};
