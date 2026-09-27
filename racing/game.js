/* ==========================================================================
   APEX RACER — game engine
   Pseudo-3D road racer (segment projection), no dependencies.

   Layout of this file:
     1. helpers          5. rendering        8. audio
     2. config / state   6. scenery draw     9. input
     3. track            7. physics/update  10. HUD + boot loop
     4. sprites
   ========================================================================== */
(() => {
  'use strict';

  /* ===================================================== 1. helpers ==== */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const pctRemaining = (n, total) => (((n % total) + total) % total) / total;
  const accelerate = (v, a, dt) => v + a * dt;
  const easeIn = (a, b, p) => a + (b - a) * p * p;
  const easeInOut = (a, b, p) => a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5);
  const expFog = (d, density) => 1 / Math.pow(Math.E, d * d * density);
  const increase = (start, inc, max) => {
    let r = start + inc;
    while (r >= max) r -= max;
    while (r < 0) r += max;
    return r;
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.round(rand(a, b));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const formatTime = (s) => {
    if (s == null || !isFinite(s)) return '--:--.---';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 1000);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };
  const ordinal = (n) => ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'][n - 1] || `${n}TH`;

  const store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? fallback : v;
      } catch (_) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* file:// or private mode */ } },
  };

  /* ================================================ 2. config / state === */
  const SEG = 200;              // world length of one road segment
  const RUMBLE = 3;             // segments per colour band
  const ROAD_W = 2000;          // half road width (3 lanes -> lane ≈ 1333)
  const LANES = 3;
  const BASE_FOV = 100;         // degrees
  const CAM_H = 1000;           // camera height above road
  const DRAW = 240;             // segments drawn ahead
  const FOG_D = 4.2;
  const CENTRIFUGAL = 0.32;

  const MAX_SPEED = SEG * 60;   // 12000 u/s == 200 units per frame @60fps
  const ACCEL = MAX_SPEED / 5.2;
  const BRAKING = -MAX_SPEED;
  const DECEL = -MAX_SPEED / 5;
  const OFF_DECEL = -MAX_SPEED / 2.2;
  const OFF_LIMIT = MAX_SPEED / 4;

  const LAPS = 3;
  const KM_PER_UNIT = 0.00001;  // display helper: speed -> km/h
  const toKmh = (speed) => Math.round(speed * KM_PER_UNIT * 1000 * 24);
  // tuned so MAX_SPEED ≈ 300 km/h and nitro ≈ 400 km/h

  const CAR_COLORS = [
    { name: 'hot pink', body: '#ff2e88', dark: '#c01e63', glow: '#ff86b8' },
    { name: 'cyan',     body: '#00e5ff', dark: '#0091ad', glow: '#8ff6ff' },
    { name: 'amber',    body: '#ffd166', dark: '#c99b2f', glow: '#ffe9b8' },
    { name: 'violet',   body: '#8b5cf6', dark: '#5f36c4', glow: '#c4b0ff' },
    { name: 'lime',     body: '#8ef05a', dark: '#5cb334', glow: '#d0ffB0' },
    { name: 'white',    body: '#f2f4ff', dark: '#b9bed8', glow: '#ffffff' },
  ];

  const PALETTE = {
    sky: ['#05061c', '#120c3a', '#2d1656', '#48215f'],
    horizon: '#48215f',
    sun: ['#ffe08a', '#ff9f5a', '#ff4f93'],
    ridgeFar: '#2a1757',
    ridgeNear: '#1c1044',
    ground: '#1b1136',
    fog: '#48215f',
    roadLight: { road: '#2e3154', grass: '#20153f', rumble: '#ff2e88', lane: 'rgba(240,244,255,.9)' },
    roadDark:  { road: '#282b4b', grass: '#1a1036', rumble: '#f6f7ff', lane: null },
    roadStart: { road: '#f6f7ff', grass: '#20153f', rumble: '#f6f7ff', lane: null },
  };

  const state = {
    mode: 'menu',            // menu | countdown | racing | paused | finished
    position: 0,             // camera z along the track
    speed: 0,
    playerX: 0,              // -1..1 relative to road half-width
    total: 0,                // total distance travelled this race
    lap: 1,
    lapTime: 0,
    raceTime: 0,
    bestLap: parseFloat(store.get('apexracer.bestlap', '')) || null,
    topSpeed: 0,
    nitro: 100,
    boosting: false,
    countT: 0,
    lastCount: -1,
    invuln: 0,
    shake: 0,
    fov: BASE_FOV,
    cameraDepth: 1 / Math.tan((BASE_FOV / 2) * Math.PI / 180),
    playerZ: 0,
    bgOffset: 0,
    finishPlace: 0,
    finishedAt: 0,
    colorIndex: parseInt(store.get('apexracer.color', '0'), 10) || 0,
    muted: store.get('apexracer.muted', '0') === '1',
  };
  state.playerZ = CAM_H * state.cameraDepth;

  const view = { w: 0, h: 0, dpr: 1 };
  let segments = [];
  let cars = [];
  let trackLength = 0;
  let stars = [];
  let ridgeA = [];
  let ridgeB = [];

  /* =================================================== 3. track ======== */
  const lastY = () => (segments.length === 0 ? 0 : segments[segments.length - 1].p2.world.y);

  const mkPoint = (y, z) => ({ world: { x: 0, y, z }, camera: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } });

  function addSegment(curve, y) {
    const n = segments.length;
    segments.push({
      index: n,
      p1: mkPoint(lastY(), n * SEG),
      p2: mkPoint(y, (n + 1) * SEG),
      curve,
      sprites: [],
      cars: [],
      color: Math.floor(n / RUMBLE) % 2 ? PALETTE.roadDark : PALETTE.roadLight,
      fog: 1,
      clip: 0,
      visible: false,
      looped: false,
    });
  }

  function addRoad(enter, hold, leave, curve, y) {
    const startY = lastY();
    const endY = startY + (y || 0) * SEG;
    const total = enter + hold + leave;
    for (let n = 0; n < enter; n++) addSegment(easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total));
    for (let n = 0; n < hold; n++) addSegment(curve, easeInOut(startY, endY, (enter + n) / total));
    for (let n = 0; n < leave; n++) addSegment(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total));
  }

  const L = { SHORT: 25, MEDIUM: 50, LONG: 100 };
  const H = { NONE: 0, LOW: 20, MEDIUM: 40, HIGH: 60 };
  const C = { NONE: 0, EASY: 2, MEDIUM: 4, HARD: 6 };

  const addStraight = (n = L.MEDIUM) => addRoad(n, n, n, C.NONE, 0);
  const addHill = (n = L.MEDIUM, h = H.MEDIUM) => addRoad(n, n, n, C.NONE, h);
  const addCurve = (n = L.MEDIUM, c = C.MEDIUM, h = H.NONE) => addRoad(n, n, n, c, h);
  const addSCurves = () => {
    addRoad(L.MEDIUM, L.MEDIUM, L.MEDIUM, -C.EASY, H.NONE);
    addRoad(L.MEDIUM, L.MEDIUM, L.MEDIUM, C.MEDIUM, H.LOW);
    addRoad(L.MEDIUM, L.MEDIUM, L.MEDIUM, C.EASY, H.MEDIUM);
    addRoad(L.MEDIUM, L.MEDIUM, L.MEDIUM, -C.MEDIUM, -H.LOW);
    addRoad(L.MEDIUM, L.MEDIUM, L.MEDIUM, -C.EASY, -H.MEDIUM);
  };
  const addRollingHills = (n = L.SHORT, h = H.LOW) => {
    addRoad(n, n, n, C.NONE, h);
    addRoad(n, n, n, C.NONE, -h);
    addRoad(n, n, n, C.EASY, h);
    addRoad(n, n, n, C.NONE, 0);
    addRoad(n, n, n, -C.EASY, h);
    addRoad(n, n, n, C.NONE, -h);
  };
  const addBumps = () => {
    addRoad(10, 10, 10, 0, 5);
    addRoad(10, 10, 10, 0, -2);
    addRoad(10, 10, 10, C.EASY, -5);
    addRoad(10, 10, 10, 0, 8);
    addRoad(10, 10, 10, 0, -4);
    addRoad(10, 10, 10, -C.EASY, 2);
  };

  function buildTrack() {
    segments = [];
    addStraight(L.SHORT);
    addRollingHills();
    addSCurves();
    addCurve(L.MEDIUM, C.MEDIUM, H.LOW);
    addStraight(L.SHORT);
    addRollingHills(L.MEDIUM, H.MEDIUM);
    addCurve(L.LONG, C.MEDIUM, H.MEDIUM);
    addSCurves();
    addHill(L.MEDIUM, H.HIGH);
    addBumps();
    addCurve(L.LONG, C.HARD, H.NONE);
    addStraight(L.SHORT);
    addHill(L.LONG, -H.MEDIUM);
    addSCurves();
    addCurve(L.LONG, -C.MEDIUM, H.LOW);
    addRollingHills(L.SHORT, H.MEDIUM);
    addHill(L.MEDIUM, H.HIGH);
    addStraight(L.MEDIUM);
    addSCurves();
    addCurve(L.LONG, C.MEDIUM, -H.LOW);
    addBumps();
    // bring the loop back to y = 0 so the seam is invisible
    addRoad(L.MEDIUM, L.MEDIUM, L.MEDIUM, C.EASY, -lastY() / SEG);
    // start / finish banding
    for (let n = 0; n < 4; n++) segments[n].color = PALETTE.roadStart;

    trackLength = segments.length * SEG;
    decorateTrack();
  }

  function decorateTrack() {
    for (const s of segments) s.sprites = [];

    // trees along both shoulders
    for (let n = 8; n < segments.length; n += 3) {
      if (Math.random() < 0.55) {
        const side = Math.random() < 0.5 ? -1 : 1;
        segments[n].sprites.push({ kind: 'tree', offset: side * rand(1.35, 3.6) });
      }
    }
    // light poles, alternating sides
    for (let n = 14, i = 0; n < segments.length; n += 22, i++) {
      segments[n].sprites.push({ kind: 'light', offset: (i % 2 ? -1.32 : 1.32) });
    }
    // billboards
    for (let n = 70; n < segments.length; n += 150) {
      const side = Math.random() < 0.5 ? -1 : 1;
      segments[n].sprites.push({ kind: 'board', offset: side * rand(1.7, 2.3) });
    }
    // rocks
    for (let n = 20; n < segments.length; n += 7) {
      if (Math.random() < 0.3) {
        const side = Math.random() < 0.5 ? -1 : 1;
        segments[n].sprites.push({ kind: 'rock', offset: side * rand(1.2, 2.6) });
      }
    }
  }

  const findSegment = (z) => segments[Math.floor(z / SEG) % segments.length];

  /* =================================================== 4. sprites ====== */
  const SPRITES = {
    car:   { w: 520, aspect: 0.74 },
    tree:  { w: 1500, aspect: 1.6 },
    light: { w: 320, aspect: 5.4 },
    board: { w: 1700, aspect: 0.72 },
    rock:  { w: 520, aspect: 0.62 },
  };

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  /** Car seen from behind: x,y = top-left of bounding box. */
  function drawCarShape(c, x, y, w, h, col, isPlayer) {
    if (w < 3) return;
    const px = w / 100; // proportional unit

    // ground shadow
    c.fillStyle = 'rgba(0,0,0,.38)';
    c.beginPath();
    c.ellipse(x + w / 2, y + h * 0.98, w * 0.55, h * 0.14, 0, 0, Math.PI * 2);
    c.fill();

    // wheels
    c.fillStyle = '#0a0a14';
    roundRect(c, x + 2 * px, y + h * 0.55, w * 0.16, h * 0.42, 2 * px); c.fill();
    roundRect(c, x + w - 2 * px - w * 0.16, y + h * 0.55, w * 0.16, h * 0.42, 2 * px); c.fill();

    // lower body
    const g = c.createLinearGradient(x, y + h * 0.4, x, y + h);
    g.addColorStop(0, col.body);
    g.addColorStop(1, col.dark);
    c.fillStyle = g;
    roundRect(c, x + w * 0.04, y + h * 0.42, w * 0.92, h * 0.5, 5 * px); c.fill();

    // cabin
    c.fillStyle = col.dark;
    roundRect(c, x + w * 0.17, y + h * 0.1, w * 0.66, h * 0.42, 5 * px); c.fill();

    // rear window
    const wg = c.createLinearGradient(x, y + h * 0.14, x, y + h * 0.48);
    wg.addColorStop(0, 'rgba(10,14,34,.95)');
    wg.addColorStop(1, 'rgba(60,90,150,.75)');
    c.fillStyle = wg;
    roundRect(c, x + w * 0.22, y + h * 0.15, w * 0.56, h * 0.26, 3 * px); c.fill();

    // roof line highlight
    c.fillStyle = col.body;
    roundRect(c, x + w * 0.17, y + h * 0.08, w * 0.66, h * 0.05, 2 * px); c.fill();

    // tail lights
    const lit = w > 14;
    c.fillStyle = '#ff3b3b';
    roundRect(c, x + w * 0.09, y + h * 0.5, w * 0.24, h * 0.12, 2 * px); c.fill();
    roundRect(c, x + w * 0.67, y + h * 0.5, w * 0.24, h * 0.12, 2 * px); c.fill();
    if (lit) {
      c.globalAlpha *= 0.55;
      c.fillStyle = '#ff6b6b';
      c.beginPath();
      c.ellipse(x + w * 0.21, y + h * 0.56, w * 0.22, h * 0.14, 0, 0, Math.PI * 2);
      c.ellipse(x + w * 0.79, y + h * 0.56, w * 0.22, h * 0.14, 0, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha /= 0.55;
    }

    // bumper + plate
    c.fillStyle = 'rgba(10,10,20,.75)';
    roundRect(c, x + w * 0.06, y + h * 0.78, w * 0.88, h * 0.1, 2 * px); c.fill();

    if (isPlayer && w > 40) {
      // spoiler
      c.fillStyle = '#12121f';
      roundRect(c, x + w * 0.1, y + h * 0.02, w * 0.8, h * 0.05, 2 * px); c.fill();
      c.fillRect(x + w * 0.2, y + h * 0.05, w * 0.04, h * 0.08);
      c.fillRect(x + w * 0.76, y + h * 0.05, w * 0.04, h * 0.08);
    }
  }

  function drawTree(c, x, y, w, h) {
    if (w < 3) return;
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath();
    c.ellipse(x + w / 2, y + h, w * 0.42, h * 0.06, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#33203f';
    c.fillRect(x + w * 0.44, y + h * 0.74, w * 0.12, h * 0.26);
    const tiers = 3;
    for (let i = 0; i < tiers; i++) {
      const p = i / tiers;
      const top = y + h * (0.04 + p * 0.24);
      const halfW = w * (0.24 + p * 0.26);
      const bottom = y + h * (0.5 + p * 0.3);
      c.fillStyle = i === 0 ? '#1e6b5e' : i === 1 ? '#17564c' : '#11423c';
      c.beginPath();
      c.moveTo(x + w / 2, top);
      c.lineTo(x + w / 2 + halfW, bottom);
      c.lineTo(x + w / 2 - halfW, bottom);
      c.closePath();
      c.fill();
    }
    // rim light from the sunset
    c.fillStyle = 'rgba(255,120,160,.35)';
    c.beginPath();
    c.moveTo(x + w / 2, y + h * 0.04);
    c.lineTo(x + w / 2 + w * 0.24, y + h * 0.5);
    c.lineTo(x + w / 2 + w * 0.17, y + h * 0.5);
    c.closePath();
    c.fill();
  }

  function drawRock(c, x, y, w, h) {
    c.fillStyle = 'rgba(0,0,0,.28)';
    c.beginPath();
    c.ellipse(x + w / 2, y + h, w * 0.5, h * 0.16, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#4a3d6b';
    c.beginPath();
    c.moveTo(x + w * 0.05, y + h);
    c.lineTo(x + w * 0.28, y + h * 0.18);
    c.lineTo(x + w * 0.62, y + h * 0.05);
    c.lineTo(x + w * 0.95, y + h * 0.62);
    c.lineTo(x + w * 0.86, y + h);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(255,150,190,.28)';
    c.beginPath();
    c.moveTo(x + w * 0.28, y + h * 0.18);
    c.lineTo(x + w * 0.62, y + h * 0.05);
    c.lineTo(x + w * 0.7, y + h * 0.3);
    c.closePath();
    c.fill();
  }

  function drawLight(c, x, y, w, h) {
    if (h < 8) return;
    const cx = x + w / 2;
    c.fillStyle = '#241a3d';
    c.fillRect(cx - w * 0.09, y + h * 0.16, w * 0.18, h * 0.84);
    c.fillStyle = '#31264f';
    c.fillRect(cx - w * 0.5, y + h * 0.1, w, h * 0.07);
    if (w > 6) {
      const r = w * 1.5;
      const g = c.createRadialGradient(cx, y + h * 0.13, 0, cx, y + h * 0.13, r);
      g.addColorStop(0, 'rgba(255,225,150,.85)');
      g.addColorStop(0.35, 'rgba(255,180,120,.3)');
      g.addColorStop(1, 'rgba(255,160,120,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, y + h * 0.13, r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#ffe9b0';
      c.fillRect(cx - w * 0.34, y + h * 0.11, w * 0.68, h * 0.05);
    }
  }

  const BOARD_TEXT = ['APEX', 'NITRO', 'GP', 'COAST'];

  function drawBoard(c, x, y, w, h, seed) {
    c.fillStyle = '#241a3d';
    c.fillRect(x + w * 0.2, y + h * 0.6, w * 0.05, h * 0.4);
    c.fillRect(x + w * 0.75, y + h * 0.6, w * 0.05, h * 0.4);
    c.fillStyle = '#120c26';
    roundRect(c, x, y, w, h * 0.64, w * 0.03);
    c.fill();
    const g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#00e5ff');
    g.addColorStop(1, '#ff2e88');
    c.fillStyle = g;
    roundRect(c, x + w * 0.02, y + h * 0.03, w * 0.96, h * 0.58, w * 0.025);
    c.fill();
    c.fillStyle = '#0a0a18';
    if (w > 60) {
      c.font = `900 ${h * 0.34}px Orbitron, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(BOARD_TEXT[seed % BOARD_TEXT.length], x + w / 2, y + h * 0.32);
    }
  }

  const SHAPE_FN = { tree: drawTree, rock: drawRock, light: drawLight, board: drawBoard };

  /* ================================================ 5. rendering ======== */
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    canvas.style.width = view.w + 'px';
    canvas.style.height = view.h + 'px';
  }

  function project(p, camX, camY, camZ) {
    p.camera.x = p.world.x - camX;
    p.camera.y = p.world.y - camY;
    p.camera.z = p.world.z - camZ;
    const scale = state.cameraDepth / Math.max(p.camera.z, 1);
    p.screen.scale = scale;
    p.screen.x = Math.round(view.w / 2 + scale * p.camera.x * view.w / 2);
    p.screen.y = Math.round(view.h / 2 - scale * p.camera.y * view.h / 2);
    p.screen.w = Math.round(scale * ROAD_W * view.w / 2);
  }

  function polygon(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  function renderSegment(seg) {
    const { w: width, h: height } = view;
    const a = seg.p1.screen;
    const b = seg.p2.screen;
    const col = seg.color;
    const rumbleW1 = a.w / Math.max(6, 2 * LANES);
    const rumbleW2 = b.w / Math.max(6, 2 * LANES);
    const laneW1 = a.w / Math.max(32, 8 * LANES);
    const laneW2 = b.w / Math.max(32, 8 * LANES);

    // grass
    ctx.fillStyle = col.grass;
    ctx.fillRect(0, b.y, width, a.y - b.y);

    // rumble strips
    polygon(a.x - a.w - rumbleW1, a.y, a.x - a.w, a.y, b.x - b.w, b.y, b.x - b.w - rumbleW2, b.y, col.rumble);
    polygon(a.x + a.w + rumbleW1, a.y, a.x + a.w, a.y, b.x + b.w, b.y, b.x + b.w + rumbleW2, b.y, col.rumble);

    // road
    polygon(a.x - a.w, a.y, a.x + a.w, a.y, b.x + b.w, b.y, b.x - b.w, b.y, col.road);

    // lane markers
    if (col.lane) {
      const lw1 = (a.w * 2) / LANES;
      const lw2 = (b.w * 2) / LANES;
      let lx1 = a.x - a.w + lw1;
      let lx2 = b.x - b.w + lw2;
      for (let lane = 1; lane < LANES; lane++) {
        polygon(lx1 - laneW1 / 2, a.y, lx1 + laneW1 / 2, a.y, lx2 + laneW2 / 2, b.y, lx2 - laneW2 / 2, b.y, col.lane);
        lx1 += lw1;
        lx2 += lw2;
      }
    }

    // fog toward the horizon
    if (seg.fog < 1) {
      ctx.globalAlpha = 1 - seg.fog;
      ctx.fillStyle = PALETTE.fog;
      ctx.fillRect(0, b.y, width, a.y - b.y);
      ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------------------------- scenery / sky ----- */
  function buildScenery() {
    stars = [];
    for (let i = 0; i < 150; i++) {
      stars.push({ x: Math.random(), y: Math.random() * 0.46, r: rand(0.4, 1.7), p: rand(0, Math.PI * 2) });
    }
    ridgeA = [];
    ridgeB = [];
    for (let i = 0; i <= 42; i++) {
      ridgeA.push((Math.abs(Math.sin(i * 0.9) + Math.sin(i * 0.37) * 0.7) / 1.7) * 0.75 + 0.15);
    }
    for (let i = 0; i <= 30; i++) {
      ridgeB.push((Math.abs(Math.sin(i * 1.4 + 2) + Math.sin(i * 0.6)) / 2) * 0.55 + 0.1);
    }
  }

  function drawRidge(pts, baseY, height, offset, color) {
    const ridgeW = view.w * 1.4;
    const step = ridgeW / (pts.length - 1);
    const start = -(((offset % ridgeW) + ridgeW) % ridgeW);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(start, baseY + 60);
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < pts.length; i++) {
        ctx.lineTo(start + k * ridgeW + i * step, baseY - pts[i] * height);
      }
    }
    ctx.lineTo(start + 3 * ridgeW, baseY + 60);
    ctx.closePath();
    ctx.fill();
  }

  function renderBackground(t) {
    const { w, h } = view;
    const horizon = Math.round(h / 2);

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, PALETTE.sky[0]);
    sky.addColorStop(0.5, PALETTE.sky[1]);
    sky.addColorStop(0.82, PALETTE.sky[2]);
    sky.addColorStop(1, PALETTE.sky[3]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon + 1);

    // stars
    ctx.fillStyle = '#ffffff';
    for (const s of stars) {
      const tw = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.0012 + s.p));
      ctx.globalAlpha = tw * (1 - s.y * 1.6);
      ctx.fillRect(((s.x * w - state.bgOffset * 0.05) % w + w) % w, s.y * horizon, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // sun
    const sunR = Math.min(w, h) * 0.16;
    const sunX = w / 2 - state.bgOffset * 0.12;
    const sunY = horizon - sunR * 0.75;
    ctx.save();
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.clip();
    const sg = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
    sg.addColorStop(0, PALETTE.sun[0]);
    sg.addColorStop(0.55, PALETTE.sun[1]);
    sg.addColorStop(1, PALETTE.sun[2]);
    ctx.fillStyle = sg;
    ctx.fillRect(sunX - sunR, sunY - sunR, sunR * 2, sunR * 2);
    // retro stripes
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) {
      const y = sunY + sunR * (0.1 + i * 0.13);
      ctx.fillRect(sunX - sunR, y, sunR * 2, sunR * (0.012 + i * 0.016));
    }
    ctx.restore();

    // glow
    const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 2.6);
    glow.addColorStop(0, 'rgba(255,120,150,.34)');
    glow.addColorStop(1, 'rgba(255,120,150,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sunX - sunR * 3, sunY - sunR * 3, sunR * 6, sunR * 6);

    // mountains
    drawRidge(ridgeA, horizon + 2, Math.min(h * 0.24, 170), state.bgOffset * 0.18, PALETTE.ridgeFar);
    drawRidge(ridgeB, horizon + 4, Math.min(h * 0.16, 110), state.bgOffset * 0.38, PALETTE.ridgeNear);

    // ground plane below horizon
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, horizon, w, h - horizon);
  }

  /* ------------------------------------------------- sprite drawing ---- */
  function drawWorldSprite(kind, scale, screenX, screenY, offsetX, clipY, alpha, extra) {
    const def = SPRITES[kind];
    if (!def) return;
    const dw = scale * def.w * view.w / 2;
    if (dw < 0.7) return;
    const dh = dw * def.aspect;
    const cx = screenX + scale * offsetX * ROAD_W * view.w / 2;
    const x = cx - dw / 2;
    const y = screenY - dh;
    if (y > clipY || y + dh < 0) return;
    const clipH = Math.max(0, y + dh - clipY);
    if (clipH >= dh) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, view.w, Math.max(0, clipY));
    ctx.clip();
    ctx.globalAlpha = alpha;
    if (kind === 'car') drawCarShape(ctx, x, y, dw, dh, extra.color, extra.isPlayer);
    else if (kind === 'board') SHAPE_FN.board(ctx, x, y, dw, dh, extra.seed);
    else SHAPE_FN[kind](ctx, x, y, dw, dh);
    ctx.restore();
  }

  function renderRoad() {
    const base = findSegment(state.position);
    const basePct = pctRemaining(state.position, SEG);
    const playerSeg = findSegment(state.position + state.playerZ);
    const playerPct = pctRemaining(state.position + state.playerZ, SEG);
    const playerY = lerp(playerSeg.p1.world.y, playerSeg.p2.world.y, playerPct);

    let maxy = view.h;
    let x = 0;
    let dx = -(base.curve * basePct);
    const visible = [];

    for (let n = 0; n < DRAW; n++) {
      const seg = segments[(base.index + n) % segments.length];
      seg.looped = seg.index < base.index;
      seg.fog = expFog(n / DRAW, FOG_D);
      seg.clip = maxy;
      const camZ = state.position - (seg.looped ? trackLength : 0);

      project(seg.p1, state.playerX * ROAD_W - x, playerY + CAM_H, camZ);
      project(seg.p2, state.playerX * ROAD_W - x - dx, playerY + CAM_H, camZ);
      x += dx;
      dx += seg.curve;

      if (seg.p1.camera.z <= state.cameraDepth ||
          seg.p2.screen.y >= seg.p1.screen.y ||
          seg.p2.screen.y >= maxy) {
        seg.visible = false;
        continue;
      }
      seg.visible = true;
      renderSegment(seg);
      maxy = seg.p2.screen.y;
      visible.push(seg);
    }

    // sprites & cars, far to near so nearer things paint on top
    for (let n = visible.length - 1; n >= 0; n--) {
      const seg = visible[n];
      const alpha = 0.22 + 0.78 * seg.fog;
      for (const sp of seg.sprites) {
        const scale = seg.p1.screen.scale;
        drawWorldSprite(
          sp.kind, scale, seg.p1.screen.x, seg.p1.screen.y,
          sp.offset, seg.clip, alpha, { seed: seg.index }
        );
      }
      for (const car of seg.cars) {
        const p = pctRemaining(car.z, SEG);
        const scale = lerp(seg.p1.screen.scale, seg.p2.screen.scale, p);
        const sx = lerp(seg.p1.screen.x, seg.p2.screen.x, p);
        const sy = lerp(seg.p1.screen.y, seg.p2.screen.y, p);
        drawWorldSprite('car', scale, sx, sy, car.offset, seg.clip, alpha, {
          color: car.color,
          isPlayer: false,
        });
      }
    }
  }

  function renderPlayer(t) {
    const speedPct = state.speed / MAX_SPEED;
    const w = view.w;
    const h = view.h;
    const scale = 1 / CAM_H;                 // = cameraDepth / playerZ
    const dw = scale * SPRITES.car.w * w / 2 * 1.06;
    const dh = dw * SPRITES.car.aspect;
    const roadY = h / 2 + scale * CAM_H * h / 2;   // ground point under player
    const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const sway = steer * dw * 0.1 + Math.sin(t * 0.012) * speedPct * 2;
    const bounce = Math.sin(t * 0.035) * speedPct * 2.2;
    const x = w / 2 + sway - dw / 2;
    const y = roadY - dh + 6 + bounce;

    // speed dust when off road
    if (Math.abs(state.playerX) > 1 && state.speed > OFF_LIMIT * 0.6) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#c9a06a';
      for (let i = 0; i < 8; i++) {
        const px = w / 2 + rand(-dw * 0.7, dw * 0.7);
        const py = roadY + rand(-4, 14);
        const r = rand(3, 11) * (1 + speedPct);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.save();
    if (state.invuln > 0 && Math.floor(t / 60) % 2 === 0) ctx.globalAlpha = 0.5;
    drawCarShape(ctx, x, y, dw, dh, CAR_COLORS[state.colorIndex], true);
    ctx.restore();

    // nitro flames
    if (state.boosting && state.speed > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const side of [-1, 1]) {
        const fx = w / 2 + side * dw * 0.26;
        const fy = y + dh * 0.9;
        const len = rand(dh * 0.3, dh * 0.62);
        const g = ctx.createLinearGradient(fx, fy, fx, fy + len);
        g.addColorStop(0, 'rgba(255,255,255,.95)');
        g.addColorStop(0.4, 'rgba(0,229,255,.75)');
        g.addColorStop(1, 'rgba(255,46,136,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(fx - dw * 0.09, fy);
        ctx.lineTo(fx + dw * 0.09, fy);
        ctx.lineTo(fx, fy + len);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function renderFx(t) {
    const { w, h } = view;
    const speedPct = state.speed / MAX_SPEED;

    // boost streaks
    if (state.boosting) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(160,240,255,.5)';
      ctx.lineWidth = 2;
      const cx = w / 2;
      const cy = h * 0.55;
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + t * 0.001;
        const r0 = Math.min(w, h) * (0.32 + 0.1 * Math.random());
        const r1 = r0 + Math.min(w, h) * 0.22;
        ctx.globalAlpha = 0.25 + Math.random() * 0.5;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // subtle speed haze at the bottom edge
    if (speedPct > 0.5) {
      const g = ctx.createLinearGradient(0, h * 0.82, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, `rgba(255,255,255,${(speedPct - 0.5) * 0.16})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, h * 0.82, w, h * 0.18);
    }
  }

  function render(t) {
    const shakePx = state.shake * 9;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (shakePx > 0.2) {
      ctx.translate(rand(-shakePx, shakePx), rand(-shakePx, shakePx));
    }
    renderBackground(t);
    renderRoad();
    renderPlayer(t);
    renderFx(t);
  }

  /* ================================================ 6. audio =========== */
  const AudioKit = {
    ctx: null,
    engine: null,
    engGain: null,
    filter: null,
    windGain: null,
    noiseBuf: null,

    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        const master = this.ctx.createGain();
        master.gain.value = 0.55;
        master.connect(this.ctx.destination);
        this.master = master;

        // engine: two detuned saws through a low-pass
        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.value = 500;
        this.engGain = this.ctx.createGain();
        this.engGain.gain.value = 0;
        this.filter.connect(this.engGain);
        this.engGain.connect(master);

        this.engine = this.ctx.createOscillator();
        this.engine.type = 'sawtooth';
        this.engine.frequency.value = 55;
        this.engine.connect(this.filter);
        this.engine.start();

        this.engine2 = this.ctx.createOscillator();
        this.engine2.type = 'square';
        this.engine2.frequency.value = 27;
        this.engine2.connect(this.filter);
        this.engine2.start();

        // wind / road noise
        const len = this.ctx.sampleRate * 2;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        src.loop = true;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 900;
        bp.Q.value = 0.7;
        this.windGain = this.ctx.createGain();
        this.windGain.gain.value = 0;
        src.connect(bp);
        bp.connect(this.windGain);
        this.windGain.connect(master);
        src.start();
      } catch (_) {
        this.ctx = null;
      }
    },

    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },

    update(speedPct, boosting, offroad) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const on = !state.muted;
      const f = 52 + speedPct * 150 + (boosting ? 40 : 0);
      this.engine.frequency.setTargetAtTime(f, now, 0.05);
      this.engine2.frequency.setTargetAtTime(f / 2, now, 0.05);
      this.filter.frequency.setTargetAtTime(420 + speedPct * 2600, now, 0.08);
      this.engGain.gain.setTargetAtTime(on ? 0.035 + speedPct * 0.05 : 0, now, 0.1);
      const wind = on && state.mode === 'racing' ? speedPct * speedPct * (offroad ? 0.16 : 0.075) : 0;
      this.windGain.gain.setTargetAtTime(wind, now, 0.12);
    },

    tone(freq, dur, type = 'sine', vol = 0.16) {
      if (!this.ctx || state.muted) return;
      const t0 = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g);
      g.connect(this.master);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    },

    beep(n) { this.tone(n === 0 ? 880 : 440, 0.18, 'square', 0.2); },
    go() { this.tone(660, 0.5, 'square', 0.22); },

    crash() {
      if (!this.ctx || state.muted || !this.noiseBuf) return;
      const t0 = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t0);
      src.stop(t0 + 0.4);
    },
  };

  /* ================================================ 7. update ========== */
  const input = { gas: false, brake: false, left: false, right: false, boost: false };

  function resetRace() {
    state.position = 0;
    state.speed = 0;
    state.playerX = 0;
    state.total = 0;
    state.lap = 1;
    state.lapTime = 0;
    state.raceTime = 0;
    state.topSpeed = 0;
    state.nitro = 100;
    state.boosting = false;
    state.countT = 0;
    state.lastCount = -1;
    state.invuln = 0;
    state.shake = 0;
    state.finishPlace = 0;
    state.finishedAt = 0;

    cars = [];
    const laneOffsets = [-0.64, 0, 0.64];
    for (let i = 0; i < 5; i++) {
      const color = CAR_COLORS[(i + 1 + state.colorIndex) % CAR_COLORS.length];
      cars.push({
        total: 900 + i * 720,
        z: 0,
        offset: laneOffsets[i % 3],
        baseOffset: laneOffsets[i % 3],
        phase: rand(0, Math.PI * 2),
        speed: 0,
        baseSpeed: rand(0.6, 0.84) * MAX_SPEED,
        color,
      });
      cars[i].z = cars[i].total % trackLength;
    }
    for (const s of segments) s.cars.length = 0;
  }

  function updateCars(dt) {
    const t = performance.now() * 0.001;
    for (const c of cars) {
      let target = c.baseSpeed;
      if (state.mode === 'racing') {
        const gap = state.total - c.total;
        if (gap > 6000) target = c.baseSpeed * 1.14;       // leaders push on
        else if (gap < -9000) target = c.baseSpeed * 0.92;  // and ease off
      } else if (state.mode === 'menu') {
        target = c.baseSpeed * 0.85;
      } else if (state.mode === 'finished') {
        target = c.baseSpeed * 0.5;
      }
      c.speed += (target - c.speed) * Math.min(1, dt * 0.7);
      c.total += c.speed * dt;
      c.z = increase(c.z, c.speed * dt, trackLength);
      c.offset = c.baseOffset + Math.sin(t * 0.5 + c.phase) * 0.1;
    }
    for (const s of segments) s.cars.length = 0;
    for (const c of cars) findSegment(c.z).cars.push(c);
  }

  function playerPlace() {
    let place = 1;
    for (const c of cars) if (c.total > state.total) place++;
    return place;
  }

  function collide(car) {
    if (state.invuln > 0) return;
    state.invuln = 0.7;
    state.speed = Math.max(car.speed * 0.7, state.speed * 0.45);
    state.shake = 1;
    state.playerX += state.playerX < car.offset ? -0.3 : 0.3;
    AudioKit.crash();
  }

  function circularGap(a, b) {
    let d = Math.abs(a - b) % trackLength;
    if (d > trackLength / 2) d = trackLength - d;
    return d;
  }

  function update(dt, t) {
    state.shake = Math.max(0, state.shake - dt * 2.4);
    state.invuln = Math.max(0, state.invuln - dt);

    // field of view punch when boosting
    const targetFov = BASE_FOV + (state.boosting ? 16 : 0) + (state.speed / MAX_SPEED) * 5;
    state.fov += (targetFov - state.fov) * Math.min(1, dt * 5);
    state.cameraDepth = 1 / Math.tan((state.fov / 2) * Math.PI / 180);
    state.playerZ = CAM_H * state.cameraDepth;

    const seg = findSegment(state.position + state.playerZ);
    const speedPct = state.speed / MAX_SPEED;
    const dx = dt * 2.6 * speedPct;

    if (state.mode === 'menu') {
      state.speed += (MAX_SPEED * 0.5 - state.speed) * Math.min(1, dt * 0.8);
      const targetX = clamp(-seg.curve * 0.09, -0.7, 0.7);
      state.playerX += (targetX - state.playerX) * Math.min(1, dt * 1.6);
      state.bgOffset += state.speed * seg.curve * dt * 0.0006;
      const dz = dt * state.speed;
      state.position = increase(state.position, dz, trackLength);
      updateCars(dt);
      AudioKit.update(0.4, false, false);
      return;
    }

    if (state.mode === 'countdown') {
      state.countT += dt;
      const step = Math.floor(state.countT);
      if (step !== state.lastCount) {
        state.lastCount = step;
        if (step < 3) { showCountdown(String(3 - step)); AudioKit.beep(step); }
        else if (step === 3) { showCountdown('GO!'); AudioKit.go(); }
      }
      if (state.countT >= 3) {
        state.mode = 'racing';
        setTimeout(hideCountdown, 600);
      }
      updateCars(0);
      return;
    }

    if (state.mode === 'finished') {
      state.speed = Math.max(0, accelerate(state.speed, DECEL * 2, dt));
      const dz = dt * state.speed;
      state.position = increase(state.position, dz, trackLength);
      state.total += dz;
      updateCars(dt);
      if (!ui.results.hidden && false) { /* handled by timer */ }
      AudioKit.update(speedPct, false, false);
      return;
    }

    if (state.mode !== 'racing') { AudioKit.update(0, false, false); return; }

    /* ---- driving ---- */
    state.raceTime += dt;
    state.lapTime += dt;

    // nitro
    const wantBoost = input.boost && state.nitro > 0 && state.speed > MAX_SPEED * 0.18;
    state.boosting = wantBoost;
    if (wantBoost) state.nitro = Math.max(0, state.nitro - 32 * dt);
    else state.nitro = Math.min(100, state.nitro + 9 * dt);

    if (input.gas) state.speed = accelerate(state.speed, ACCEL * (wantBoost ? 1.8 : 1), dt);
    else state.speed = accelerate(state.speed, DECEL, dt);
    if (input.brake) state.speed = accelerate(state.speed, BRAKING, dt);

    const cap = wantBoost ? MAX_SPEED * 1.32 : MAX_SPEED;
    if (state.speed > cap) state.speed = Math.max(cap, accelerate(state.speed, -MAX_SPEED * 1.4, dt));
    state.speed = clamp(state.speed, 0, MAX_SPEED * 1.35);
    state.topSpeed = Math.max(state.topSpeed, state.speed);

    // steering + centrifugal force
    const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    state.playerX += dx * steer;
    state.playerX -= dx * speedPct * seg.curve * CENTRIFUGAL;

    // off road
    const offRoad = Math.abs(state.playerX) > 1;
    if (offRoad) {
      state.playerX = clamp(state.playerX, -2.4, 2.4);
      if (state.speed > OFF_LIMIT) {
        state.speed = accelerate(state.speed, OFF_DECEL, dt);
        state.shake = Math.min(1, state.shake + dt * 2.2);
      }
    }

    const dz = dt * state.speed;
    state.position = increase(state.position, dz, trackLength);
    state.total += dz;
    state.bgOffset += state.speed * seg.curve * dt * 0.0006;

    updateCars(dt);

    // collisions
    const playerZWorld = (state.position + state.playerZ) % trackLength;
    for (const c of cars) {
      if (circularGap(playerZWorld, c.z) < SEG * 1.1 &&
          Math.abs(state.playerX - c.offset) < 0.3) {
        collide(c);
      }
    }

    // lap bookkeeping
    if (state.total >= state.lap * trackLength) {
      const lapT = state.lapTime;
      if (state.bestLap == null || lapT < state.bestLap) {
        state.bestLap = lapT;
        store.set('apexracer.bestlap', String(lapT));
      }
      state.lapTime = 0;
      state.lap++;
      if (state.lap > LAPS) finishRace();
      else {
        showToast(state.lap === LAPS ? 'FINAL LAP' : `LAP ${state.lap}`);
        AudioKit.tone(520, 0.25, 'square', 0.18);
      }
    }

    AudioKit.update(speedPct, wantBoost, offRoad);
  }

  function startRace() {
    resetRace();
    state.mode = 'countdown';
    AudioKit.init();
    AudioKit.resume();
    ui.menu.hidden = true;
    ui.pause.hidden = true;
    ui.results.hidden = true;
    ui.hud.hidden = false;
    ui.countdown.hidden = false;
    ui.touch.classList.add('active');
    updateHud(true);
  }

  function finishRace() {
    state.mode = 'finished';
    state.finishPlace = playerPlace();
    state.finishedAt = performance.now();
    state.boosting = false;
    AudioKit.tone(700, 0.4, 'square', 0.2);
    setTimeout(() => AudioKit.tone(900, 0.5, 'square', 0.2), 140);
    setTimeout(showResults, 1500);
  }

  function showResults() {
    if (state.mode !== 'finished') return;
    ui.resEyebrow.textContent = state.finishPlace === 1 ? 'CHEQUERED FLAG' : 'RACE COMPLETE';
    ui.resTitle.textContent = ordinal(state.finishPlace) + ' PLACE';
    ui.resTotal.textContent = formatTime(state.raceTime);
    ui.resBest.textContent = formatTime(state.bestLap);
    ui.resTop.textContent = toKmh(state.topSpeed) + ' km/h';
    ui.results.hidden = false;
    ui.hud.hidden = true;
    ui.touch.classList.remove('active');
  }

  function goMenu() {
    state.mode = 'menu';
    ui.menu.hidden = false;
    ui.pause.hidden = true;
    ui.results.hidden = true;
    ui.hud.hidden = true;
    ui.touch.classList.remove('active');
    ui.menuBest.textContent = formatTime(state.bestLap);
  }

  function togglePause(force) {
    if (state.mode === 'racing' || state.mode === 'countdown') {
      state.prevMode = state.mode;
      state.mode = 'paused';
      ui.pause.hidden = false;
      AudioKit.update(0, false, false);
    } else if (state.mode === 'paused' && force !== false) {
      state.mode = state.prevMode || 'racing';
      ui.pause.hidden = true;
      AudioKit.resume();
    }
  }

  /* ================================================== 8. HUD ========== */
  const $ = (id) => document.getElementById(id);
  const ui = {
    hud: $('hud'), menu: $('menu'), pause: $('pause'), results: $('results'),
    countdown: $('countdown'), toast: $('toast'), touch: $('touch'),
    lap: $('lapVal'), pos: $('posVal'), time: $('timeVal'), best: $('bestVal'),
    progress: $('progressFill'), speed: $('speedVal'), gFill: $('gFill'),
    needle: $('needle'), nitro: $('nitroFill'), nitroPct: $('nitroPct'),
    nitroBar: document.querySelector('.nitro-bar'),
    dist: $('distVal'), top: $('topVal'), menuBest: $('menuBest'),
    muteBtn: $('muteBtn'),
    resEyebrow: $('resEyebrow'), resTitle: $('resTitle'),
    resTotal: $('resTotal'), resBest: $('resBest'), resTop: $('resTop'),
  };

  function buildGauge() {
    const g = $('ticks');
    const svgNS = 'http://www.w3.org/2000/svg';
    for (let i = 0; i <= 12; i++) {
      const a = ((135 + (270 * i) / 12) * Math.PI) / 180;
      const inner = i % 3 === 0 ? 47 : 52;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', 80 + Math.cos(a) * inner);
      line.setAttribute('y1', 80 + Math.sin(a) * inner);
      line.setAttribute('x2', 80 + Math.cos(a) * 58);
      line.setAttribute('y2', 80 + Math.sin(a) * 58);
      line.setAttribute('class', 'tick' + (i >= 9 ? ' hot' : ''));
      g.appendChild(line);
    }
  }

  let toastTimer = null;
  function showToast(text) {
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    ui.toast.style.animation = 'none';
    void ui.toast.offsetWidth;
    ui.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 1500);
  }

  function showCountdown(text) {
    ui.countdown.textContent = text;
    ui.countdown.classList.remove('pop');
    void ui.countdown.offsetWidth;
    ui.countdown.classList.add('pop');
  }
  function hideCountdown() { ui.countdown.hidden = true; }

  const hudCache = {};
  function setText(el, key, value) {
    if (hudCache[key] !== value) {
      hudCache[key] = value;
      el.textContent = value;
    }
  }

  function updateHud(force) {
    if (ui.hud.hidden) return;
    const kmh = toKmh(state.speed);
    setText(ui.lap, 'lap', `${Math.min(state.lap, LAPS)}/${LAPS}`);
    setText(ui.pos, 'pos', `${playerPlace()}/${cars.length + 1}`);
    setText(ui.time, 'time', formatTime(state.raceTime));
    setText(ui.best, 'best', formatTime(state.bestLap));
    setText(ui.speed, 'kmh', String(kmh));
    setText(ui.dist, 'dist', (state.total * KM_PER_UNIT * 1000 * 24).toFixed(2));
    setText(ui.top, 'top', String(toKmh(state.topSpeed)));
    setText(ui.nitroPct, 'nitroPct', Math.round(state.nitro) + '%');

    const lapProg = pctRemaining(state.total, trackLength);
    ui.progress.style.width = (lapProg * 100).toFixed(1) + '%';

    const pct = clamp(state.speed / (MAX_SPEED * 1.32), 0, 1);
    ui.gFill.setAttribute('stroke-dasharray', `${(pct * 100).toFixed(1)} 100`);
    ui.gFill.setAttribute('stroke', state.boosting ? '#ff2e88' : '#00e5ff');
    ui.needle.setAttribute('transform', `rotate(${(-135 + pct * 270).toFixed(1)} 80 80)`);

    ui.nitro.style.width = state.nitro.toFixed(0) + '%';
    ui.nitroBar.classList.toggle('active', state.boosting);
    ui.muteBtn.classList.toggle('muted', state.muted);
    ui.muteBtn.textContent = state.muted ? '✕' : '♪';
  }

  /* ================================================== 9. input ========= */
  const KEYMAP = {
    ArrowUp: 'gas', KeyW: 'gas',
    ArrowDown: 'brake', KeyS: 'brake',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'boost',
  };

  window.addEventListener('keydown', (e) => {
    const action = KEYMAP[e.code];
    if (action) {
      input[action] = true;
      e.preventDefault();
    }
    if (e.repeat) return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (state.mode === 'racing' || state.mode === 'countdown' || state.mode === 'paused') togglePause();
      e.preventDefault();
    }
    if (e.code === 'KeyM') toggleMute();
    if (e.code === 'KeyR' && (state.mode === 'racing' || state.mode === 'paused' || state.mode === 'finished')) startRace();
    if (e.code === 'Enter' && state.mode === 'menu') startRace();
  });

  window.addEventListener('keyup', (e) => {
    const action = KEYMAP[e.code];
    if (action) {
      input[action] = false;
      e.preventDefault();
    }
  });

  window.addEventListener('blur', () => {
    for (const k of Object.keys(input)) input[k] = false;
    if (state.mode === 'racing' || state.mode === 'countdown') togglePause();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (state.mode === 'racing' || state.mode === 'countdown')) togglePause();
  });

  function toggleMute() {
    state.muted = !state.muted;
    store.set('apexracer.muted', state.muted ? '1' : '0');
    if (state.muted && AudioKit.engGain) {
      AudioKit.engGain.gain.setTargetAtTime(0, AudioKit.ctx.currentTime, 0.05);
      if (AudioKit.windGain) AudioKit.windGain.gain.setTargetAtTime(0, AudioKit.ctx.currentTime, 0.05);
    }
    updateHud(true);
  }

  // touch controls
  for (const btn of document.querySelectorAll('.tbtn')) {
    const key = btn.dataset.key;
    const on = (e) => { e.preventDefault(); input[key] = true; btn.classList.add('on'); };
    const off = (e) => { e.preventDefault(); input[key] = false; btn.classList.remove('on'); };
    btn.addEventListener('pointerdown', on);
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
    btn.addEventListener('pointerleave', off);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ================================================= 10. boot ========== */
  function buildSwatches() {
    const wrap = $('swatches');
    CAR_COLORS.forEach((col, i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = `radial-gradient(circle at 32% 30%, #fff3, transparent 55%), ${col.body}`;
      b.title = col.name;
      b.setAttribute('aria-label', col.name);
      b.setAttribute('aria-pressed', String(i === state.colorIndex));
      b.addEventListener('click', () => {
        state.colorIndex = i;
        store.set('apexracer.color', String(i));
        for (const el of wrap.children) el.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
      });
      wrap.appendChild(b);
    });
  }

  $('startBtn').addEventListener('click', startRace);
  $('againBtn').addEventListener('click', startRace);
  $('restartBtn').addEventListener('click', startRace);
  $('resumeBtn').addEventListener('click', () => togglePause());
  $('quitBtn').addEventListener('click', goMenu);
  $('menuBtn').addEventListener('click', goMenu);
  $('pauseBtn').addEventListener('click', () => togglePause());
  $('muteBtn').addEventListener('click', toggleMute);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state.mode !== 'paused') update(dt, now);
    render(now);
    updateHud();
    requestAnimationFrame(frame);
  }

  function boot() {
    resize();
    buildScenery();
    buildTrack();
    buildSwatches();
    buildGauge();
    resetRace();
    ui.menuBest.textContent = formatTime(state.bestLap);
    ui.best.textContent = formatTime(state.bestLap);
    ui.muteBtn.classList.toggle('muted', state.muted);
    window.addEventListener('resize', resize);
    requestAnimationFrame(frame);
  }

  boot();
})();
