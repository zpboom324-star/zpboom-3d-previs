/* ZPboom.AI 3D 预演 · 天气系统（第三期）
   scene.json 的 weather：keyframes 写雨 / 雪 / 雾 / 风 / 风向 / 阴天 / 地面湿 / 时间（小时），lightning 写闪电时刻。
   雨丝、溅水、雪花都按时间算（不是实时模拟），同一时间一定是同一画面，逐帧导出稳定；
   阴天、时间、闪电改的是场景里的平行光 / 半球光 / 环境光和背景色，道具上的手电等实际光源不受影响。 */
export const WEATHER_FIELDS = {rain: [0, 1, 0], snow: [0, 1, 0], fog: [0, 1, 0], wind: [0, 1, 0], windDir: [0, 360, 30], overcast: [0, 1, 0], wet: [0, 1, 0], tod: [0, 24, 12]};
export const WEATHER_PRESETS = {
  clear: {label: '晴', rain: 0, snow: 0, fog: 0, wind: .1, overcast: 0, wet: 0},
  cloudy: {label: '阴', rain: 0, snow: 0, fog: .15, wind: .2, overcast: .7, wet: 0},
  drizzle: {label: '小雨', rain: .3, snow: 0, fog: .1, wind: .2, overcast: .6, wet: .5},
  storm: {label: '大雨', rain: 1, snow: 0, fog: .3, wind: .5, overcast: .85, wet: 1},
  thunder: {label: '雷雨', rain: 1, snow: 0, fog: .3, wind: .6, overcast: .9, wet: 1, lightning: true},
  snow: {label: '雪', rain: 0, snow: .8, fog: .2, wind: .15, overcast: .6, wet: 0},
  mist: {label: '大雾', rain: 0, snow: 0, fog: .85, wind: 0, overcast: .5, wet: .2},
};

export function initWeather(ctx) {
  const {THREE} = ctx;
  const group = new THREE.Group(); group.name = 'weather'; group.userData.weather = true; ctx.scene.add(group);
  const rand = (seed) => { let s = Math.max(1, Math.floor(seed)); return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  const wrap = (v, size) => ((v % size) + size) % size;

  // 雨丝：LineSegments，每滴两个点
  const RAIN = 7000, RS = 26, RH = 12;
  const rainSeed = []; { const r = rand(101); for (let i = 0; i < RAIN; i++) rainSeed.push([r() * RS, r() * RS, r(), .85 + r() * .3]); }
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN * 6), 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({color: 0xbfd0e0, transparent: true, opacity: .5, depthWrite: false}));
  rain.frustumCulled = false; rain.userData.weather = true; group.add(rain);
  // 地面溅水
  const SPL = 1600, SS = 18;
  const splSeed = []; { const r = rand(202); for (let i = 0; i < SPL; i++) splSeed.push([r() * SS, r() * SS, r()]); }
  const splGeo = new THREE.BufferGeometry(); splGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPL * 3), 3));
  const splash = new THREE.Points(splGeo, new THREE.PointsMaterial({color: 0xdfe8f0, size: .035, transparent: true, opacity: .7, depthWrite: false}));
  splash.frustumCulled = false; splash.userData.weather = true; group.add(splash);
  // 雪花
  const SNOW = 6000, NS = 22, NH = 10;
  const snowSeed = []; { const r = rand(303); for (let i = 0; i < SNOW; i++) snowSeed.push([r() * NS, r() * NS, r(), r() * 6.28, .7 + r() * .6]); }
  const snowGeo = new THREE.BufferGeometry(); snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW * 3), 3));
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({color: 0xffffff, size: .035, transparent: true, opacity: .9, depthWrite: false}));
  snow.frustumCulled = false; snow.userData.weather = true; group.add(snow);
  // 闪电光
  const flash = new THREE.DirectionalLight(0xd6e4ff, 0); flash.position.set(4, 20, 6); flash.name = 'lightning'; ctx.scene.add(flash); // 放在场景根：导出 Blender 时作为一盏有逐帧强度的灯

  let base = null;
  // 遮挡：每 0.5 米一格，从高处往下打一条射线，碰到的第一个场景物件（地面除外）就是这一格的“顶”，雨雪落到顶以下就不画（屋里、桌子底下不下雨）
  const roofCache = new Map(), ray = new THREE.Raycaster(), DOWNV = new THREE.Vector3(0, -1, 0); let roofTargets = null;
  function roofAt(x, z) {
    const key = `${Math.round(x * 2)},${Math.round(z * 2)}`; let y = roofCache.get(key);
    if (y !== undefined) return y;
    if (!roofTargets) { roofTargets = []; const floor = ctx.world().children[0]; ctx.world().traverse((o) => { if (o.isMesh && o !== floor && !o.userData.helper && o.visible && !(o.material?.transparent && o.material.opacity < .5)) roofTargets.push(o); }); }
    ray.set(new THREE.Vector3(Math.round(x * 2) / 2, 80, Math.round(z * 2) / 2), DOWNV); ray.far = 200;
    const hit = ray.intersectObjects(roofTargets, false)[0]; y = hit && hit.point.y > .05 ? hit.point.y : -Infinity;
    if (roofCache.size > 60000) roofCache.clear(); roofCache.set(key, y); return y;
  }
  function invalidate() { roofCache.clear(); roofTargets = null; }
  function capture() { // 每次重建场景后记下原始灯光 / 背景 / 雾 / 地面
    invalidate();
    const cfg = ctx.config, lights = [];
    ctx.world().traverse((o) => { if (o.isLight && !o.userData.helper && (o.isDirectionalLight || o.isHemisphereLight || o.isAmbientLight)) lights.push({o, color: o.color.clone(), ground: o.groundColor?.clone(), intensity: o.intensity}); });
    const floor = ctx.world().children[0];
    base = {lights, bg: ctx.scene.background?.isColor ? ctx.scene.background.clone() : new THREE.Color(0x000000), fog: cfg.world.fog ? [...cfg.world.fog] : null,
      floor: floor?.material ? {mat: floor.material, color: floor.material.color.clone(), rough: floor.material.roughness, metal: floor.material.metalness} : null};
  }
  const has = () => Boolean(ctx.config?.weather?.keyframes?.length);
  function sample(t) {
    const w = ctx.config.weather, out = {};
    for (const [k, [, , def]] of Object.entries(WEATHER_FIELDS)) out[k] = has() ? ctx.smoothSample(w.keyframes, t, k, def) : def;
    out.useTod = has() && w.keyframes.some((k) => k.tod !== undefined);
    out.flash = 0;
    for (const l of w?.lightning || []) { const d = t - l.time; if (d >= 0 && d < .45) { const e = d < .07 ? 1 : d < .13 ? .25 : d < .2 ? .85 : Math.max(0, 1 - (d - .2) / .25) * .5; out.flash = Math.max(out.flash, e * (l.intensity ?? 1)); } }
    return out;
  }
  function todTint(h) { // 太阳高度 → 光强倍数、光色、背景色倍数
    const elev = Math.sin((h - 6) / 12 * Math.PI), warm = new THREE.Color(1, .62, .38), night = new THREE.Color(.45, .55, .85);
    if (elev <= 0) return {sun: .1, sky: .22, color: night, bg: new THREE.Color(.08, .1, .2)};
    const k = Math.min(1, elev / .45), color = warm.clone().lerp(new THREE.Color(1, 1, 1), k);
    return {sun: .2 + .8 * Math.sqrt(elev), sky: .35 + .65 * elev, color, bg: new THREE.Color(1, .55, .42).lerp(new THREE.Color(1, 1, 1), k)};
  }
  function update(t, cam) {
    if (!base) capture();
    const on = has(), w = on ? sample(t) : null;
    rain.visible = splash.visible = snow.visible = false; flash.intensity = 0;
    // 恢复原始值
    for (const b of base.lights) { b.o.color.copy(b.color); if (b.ground) b.o.groundColor.copy(b.ground); b.o.intensity = b.intensity; }
    if (ctx.scene.background?.isColor) ctx.scene.background.copy(base.bg);
    if (base.floor) { base.floor.mat.color.copy(base.floor.color); base.floor.mat.roughness = base.floor.rough; base.floor.mat.metalness = base.floor.metal; }
    if (!on) { if (base.fog) { ctx.scene.fog ||= new THREE.Fog(base.bg, base.fog[0], base.fog[1]); ctx.scene.fog.near = base.fog[0]; ctx.scene.fog.far = base.fog[1]; ctx.scene.fog.color.copy(base.bg); } else ctx.scene.fog = null; return null; }
    // 光：阴天 + 时间 + 闪电
    const tint = w.useTod ? todTint(w.tod) : {sun: 1, sky: 1, color: new THREE.Color(1, 1, 1), bg: new THREE.Color(1, 1, 1)};
    for (const b of base.lights) {
      if (b.o.isDirectionalLight) { b.o.intensity = b.intensity * tint.sun * (1 - .75 * w.overcast); b.o.color.multiply(tint.color); }
      else { b.o.intensity = b.intensity * tint.sky * (1 + .25 * w.overcast); }
    }
    const bg = ctx.scene.background?.isColor ? ctx.scene.background : null;
    if (bg) { bg.multiply(tint.bg); const grey = (bg.r + bg.g + bg.b) / 3; bg.lerp(new THREE.Color(grey, grey, grey * 1.05), w.overcast * .6); if (w.flash) bg.lerp(new THREE.Color(.75, .8, .95), w.flash * .55); }
    flash.intensity = w.flash * 7;
    // 雾
    const bgc = bg ? bg.clone() : new THREE.Color(.5, .5, .5);
    if (w.fog > .001 || base.fog) {
      const n0 = base.fog ? base.fog[0] : 40, f0 = base.fog ? base.fog[1] : 120;
      ctx.scene.fog ||= new THREE.Fog(bgc, n0, f0);
      ctx.scene.fog.near = THREE.MathUtils.lerp(n0, .5, w.fog); ctx.scene.fog.far = THREE.MathUtils.lerp(f0, 9, Math.pow(w.fog, .8)); ctx.scene.fog.color.copy(bgc);
    } else ctx.scene.fog = null;
    // 地面湿
    if (base.floor && w.wet > .001) { base.floor.mat.color.multiplyScalar(1 - .35 * w.wet); base.floor.mat.roughness = THREE.MathUtils.lerp(base.floor.rough, .12, w.wet); base.floor.mat.metalness = THREE.MathUtils.lerp(base.floor.metal, .25, w.wet); }
    // 风
    const wr = THREE.MathUtils.degToRad(w.windDir), wind = new THREE.Vector3(Math.cos(wr), 0, Math.sin(wr)).multiplyScalar(w.wind);
    const cx = cam.position.x, cz = cam.position.z;
    if (w.rain > .001) {
      const n = Math.round(RAIN * w.rain), arr = rainGeo.attributes.position.array, slant = .55, len = .38;
      for (let i = 0; i < n; i++) {
        const [sx, sz, ph, sp] = rainSeed[i], fall = wrap(t * 9 * sp + ph * RH, RH), y = RH - fall;
        const x = cx - RS / 2 + wrap(sx - cx + RS / 2 + wind.x * fall * slant, RS), z = cz - RS / 2 + wrap(sz - cz + RS / 2 + wind.z * fall * slant, RS);
        if (y < roofAt(x, z)) { arr[i * 6 + 1] = arr[i * 6 + 4] = -999; continue; }
        arr[i * 6] = x; arr[i * 6 + 1] = y; arr[i * 6 + 2] = z; arr[i * 6 + 3] = x - wind.x * len * slant; arr[i * 6 + 4] = y + len; arr[i * 6 + 5] = z - wind.z * len * slant;
      }
      rainGeo.setDrawRange(0, n * 2); rainGeo.attributes.position.needsUpdate = true; rain.visible = true;
      const sn = Math.round(SPL * w.rain), sa = splGeo.attributes.position.array;
      for (let i = 0; i < sn; i++) { const [sx, sz, ph] = splSeed[i], x = cx - SS / 2 + wrap(sx - cx + SS / 2, SS), z = cz - SS / 2 + wrap(sz - cz + SS / 2, SS), active = wrap(t * 2.3 + ph, 1) < .12 && roofAt(x, z) === -Infinity; sa[i * 3] = x; sa[i * 3 + 1] = active ? .02 : -999; sa[i * 3 + 2] = z; }
      splGeo.setDrawRange(0, sn); splGeo.attributes.position.needsUpdate = true; splash.visible = true;
    }
    if (w.snow > .001) {
      const n = Math.round(SNOW * w.snow), arr = snowGeo.attributes.position.array;
      for (let i = 0; i < n; i++) {
        const [sx, sz, ph, wob, sp] = snowSeed[i], fall = wrap(t * .9 * sp + ph * NH, NH), y = NH - fall, drift = Math.sin(t * 1.3 + wob) * .35;
        const x = cx - NS / 2 + wrap(sx - cx + NS / 2 + wind.x * fall * 1.6 + drift, NS), z = cz - NS / 2 + wrap(sz - cz + NS / 2 + wind.z * fall * 1.6 + Math.cos(t * 1.1 + wob) * .3, NS);
        arr[i * 3] = x; arr[i * 3 + 1] = y < roofAt(x, z) ? -999 : y; arr[i * 3 + 2] = z;
      }
      snowGeo.setDrawRange(0, n); snowGeo.attributes.position.needsUpdate = true; snow.visible = true;
    }
    return w;
  }
  function summary() { // 给导出 Blender 用
    if (!has()) return null;
    const cfg = ctx.config, n = Math.max(2, Math.round(cfg.duration * cfg.fps)), fields = {};
    for (const k of ['rain', 'snow', 'fog', 'wind', 'windDir', 'overcast', 'wet']) fields[k] = Array.from({length: n}, (_, i) => Number(ctx.smoothSample(cfg.weather.keyframes, i / cfg.fps, k, WEATHER_FIELDS[k][2]).toFixed(3)));
    return {fields, lightning: (cfg.weather.lightning || []).map((l) => ({frame: Math.round(l.time * cfg.fps), intensity: l.intensity ?? 1}))};
  }
  return {group, capture, update, invalidate, sample: (t) => (has() ? sample(t) : null), summary, has};
}

export function cleanWeather(raw, duration, helpers) {
  if (!raw) return undefined;
  const {finite, timedKeys, easeOf} = helpers, out = {};
  if (raw.keyframes) out.keyframes = timedKeys(raw.keyframes, duration, '天气', (key) => {
    const k = {};
    for (const [f, [lo, hi]] of Object.entries(WEATHER_FIELDS)) if (key[f] !== undefined) k[f] = finite(key[f], `天气 ${f}`, lo, hi);
    if (key.ease !== undefined) k.ease = easeOf(key.ease);
    return k;
  }, false);
  out.lightning = (raw.lightning || []).slice(0, 200).map((l) => ({time: finite(l.time, '闪电时间', 0, duration), ...(l.intensity !== undefined ? {intensity: finite(l.intensity, '闪电强度', 0, 3)} : {})})).sort((a, b) => a.time - b.time);
  return out;
}
