/*
  Spark simulator (client-side only)
  - Canvas-based 2D environment
  - Configurable projectile speed, duration, pierce/fork/chain/split
  - Circular or cone emission
  - Per-cast hit cooldown (0.66s) shared across all projectiles from the same cast and same target
  - Arena variants: circle, square, T-junction

  Coordinates: use world units with dynamic pixel scale.
*/

/* Utility */
const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function randUnit() { return Math.random(); }
function randRange(min, max) { return min + (max - min) * Math.random(); }
function distance(a, b) { const dx = a.x - b.x; const dy = a.y - b.y; return Math.hypot(dx, dy); }

// Returns the earliest fraction t in [0,1] where a moving circle (center p -> p + d) intersects a target circle
// Implemented as ray-circle intersection with the target radius expanded by mover radius already included by caller
function sweptCircleHitT(px, py, dx, dy, cx, cy, R) {
  // Solve |(p + t d) - c|^2 = R^2 => (d·d) t^2 + 2 d·(p-c) t + |p-c|^2 - R^2 = 0
  const mx = px - cx, my = py - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (dx * mx + dy * my);
  const c = mx * mx + my * my - R * R;
  // If starting already inside, treat as immediate hit
  if (c <= 0) return 0;
  if (a === 0) return null; // no movement
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrt = Math.sqrt(disc);
  const t1 = (-b - sqrt) / (2 * a);
  const t2 = (-b + sqrt) / (2 * a);
  // We need the smallest non-negative within [0,1]
  let t = null;
  if (t1 >= 0 && t1 <= 1) t = t1;
  else if (t2 >= 0 && t2 <= 1) t = t2;
  return t;
}

// Closest points between two segments P0->P1 and Q0->Q1
// Returns {sc, tc, px, py, qx, qy, dist}
function closestPointsBetweenSegments(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
  const ux = p1x - p0x, uy = p1y - p0y;
  const vx = q1x - q0x, vy = q1y - q0y;
  const wx = p0x - q0x, wy = p0y - q0y;
  const a = ux * ux + uy * uy;      // |u|^2
  const b = ux * vx + uy * vy;      // u·v
  const c = vx * vx + vy * vy;      // |v|^2
  const d = ux * wx + uy * wy;      // u·w
  const e = vx * wx + vy * wy;      // v·w
  const D = a * c - b * b;
  let sc, sN, sD = D;
  let tc, tN, tD = D;

  const EPS = 1e-9;
  if (D < EPS) {
    // parallel
    sN = 0.0; sD = 1.0; tN = e; tD = c;
  } else {
    sN = (b * e - c * d);
    tN = (a * e - b * d);
    if (sN < 0) { sN = 0; tN = e; tD = c; }
    else if (sN > sD) { sN = sD; tN = e + b; tD = c; }
  }

  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0; else if (-d > a) sN = sD; else { sN = -d; sD = a; }
  } else if (tN > tD) {
    tN = tD;
    if ((-d + b) < 0) sN = 0; else if ((-d + b) > a) sN = sD; else { sN = (-d + b); sD = a; }
  }

  sc = Math.abs(sD) < EPS ? 0 : sN / sD;
  tc = Math.abs(tD) < EPS ? 0 : tN / tD;

  const px = p0x + sc * ux, py = p0y + sc * uy;
  const qx = q0x + tc * vx, qy = q0y + tc * vy;
  const dx = px - qx, dy = py - qy;
  return { sc, tc, px, py, qx, qy, dist: Math.hypot(dx, dy) };
}

/** PoE Spark target cooldown per-cast per-enemy (seconds) */
const PER_CAST_TARGET_COOLDOWN = 0.66;

/** World unit references */
const ARENA_RADIUS_UNITS = 160; // circle arena radius in world units
const BOSS_RADIUS_UNITS = 3;
const CASTER_RADIUS_UNITS = 5;
const PROJ_RADIUS_UNITS = 1.5;

/**
 * Event-driven wander to mimic Spark-like motion:
 * - Continuous micro-jitter (Gaussian) for subtle wiggle
 * - Poisson-distributed heading-change events (~3 Hz)
 * - Mixture of small and larger heading deltas; occasional short bursts (2–3 rapid events)
 */
function gaussian() {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

class Wander {
  constructor() {
    this.t = 0;
    // Event rate ~3 Hz, matching observed low-velocity samples
    this.lambda = 3.0;
    // Probability that an event uses the larger-angle distribution
    this.pLarge = 0.35;
    // Probability to spawn a short burst (1-2 extra events) around the main event
    this.pBurst = 0.25;
    // Angular deltas (radians)
    this.sigmaSmall = 22 * DEG_TO_RAD;  // ~22°
    this.sigmaLarge = 75 * DEG_TO_RAD;  // ~75°
    this.truncSmall = 60 * DEG_TO_RAD;  // cap small at 60°
    this.truncLarge = 120 * DEG_TO_RAD; // cap large at 120°
    // Micro jitter: per sqrt(second)
    this.sigmaMicro = 4 * DEG_TO_RAD;

    this.nextEventAt = this.t + this.sampleExp(this.lambda);
    this.pendingEvents = [];
  }

  sampleExp(rate) { return -Math.log(1 - Math.random()) / rate; }

  sampleTruncatedNormal(sigma, maxAbs) {
    // Centered at 0; accept-reject
    for (let i = 0; i < 8; i++) {
      const x = gaussian() * sigma;
      if (Math.abs(x) <= maxAbs) return x;
    }
    return clamp(gaussian() * sigma, -maxAbs, maxAbs);
  }

  scheduleBurst(anchorTime) {
    const extra = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < extra; i++) {
      const dt = randRange(0.03, 0.12); // ~30–120 ms
      this.pendingEvents.push(anchorTime + dt);
    }
    this.pendingEvents.sort((a, b) => a - b);
  }

  step(angle, dt) {
    this.t += dt;
    // Continuous micro jitter
    angle += gaussian() * this.sigmaMicro * Math.sqrt(Math.max(dt, 0));

    // Process any due events (base or burst)
    while (true) {
      let eventTime = null;
      if (this.pendingEvents.length && this.pendingEvents[0] <= this.t) {
        eventTime = this.pendingEvents.shift();
      } else if (this.t >= this.nextEventAt) {
        eventTime = this.nextEventAt;
        this.nextEventAt = this.t + this.sampleExp(this.lambda);
        if (Math.random() < this.pBurst) this.scheduleBurst(eventTime);
      } else {
        break;
      }

      const useLarge = Math.random() < this.pLarge;
      const sigma = useLarge ? this.sigmaLarge : this.sigmaSmall;
      const trunc = useLarge ? this.truncLarge : this.truncSmall;
      const delta = this.sampleTruncatedNormal(sigma, trunc);
      angle += delta;
    }

    return angle;
  }
}

/** Arena shape base + variants */
class Arena {
  constructor(width, height) { this.width = width; this.height = height; }
  // return {hit:boolean, nx:number, ny:number, reflect:boolean, x:number, y:number}
  collideCircle(x, y, r) { return { hit: false }; }
  draw(ctx) {}
}

class CircleArena extends Arena {
  constructor(width, height, scale) {
    super(width, height);
    const radius = ARENA_RADIUS_UNITS * scale;
    this.center = { x: width / 2, y: height / 2 };
    this.radius = radius;
  }
  collideCircle(x, y, r) {
    const dx = x - this.center.x; const dy = y - this.center.y;
    const dist = Math.hypot(dx, dy);
    const limit = this.radius - r;
    if (dist > limit) {
      const nx = dx / dist; const ny = dy / dist;
      const px = this.center.x + nx * limit;
      const py = this.center.y + ny * limit;
      return { hit: true, nx, ny, reflect: true, x: px, y: py };
    }
    return { hit: false };
  }
  draw(ctx) {
    ctx.save();
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.center.x, this.center.y, this.radius, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }
}

class SquareArena extends Arena {
  constructor(width, height, scale) {
    super(width, height);
    const side = ARENA_RADIUS_UNITS * 2 * scale; // match circle arena diameter
    this.rect = {
      x: (width - side) / 2,
      y: (height - side) / 2,
      w: side,
      h: side,
    };
  }
  collideCircle(x, y, r) {
    const { x: rx, y: ry, w, h } = this.rect;
    let nx = 0, ny = 0, hit = false;
    let px = x, py = y;
    if (x - r < rx) { px = rx + r; nx = -1; hit = true; }
    if (x + r > rx + w) { px = rx + w - r; nx = 1; hit = true; }
    if (y - r < ry) { py = ry + r; ny = -1; hit = true; }
    if (y + r > ry + h) { py = ry + h - r; ny = 1; hit = true; }
    if (!hit) return { hit: false };
    const norm = Math.hypot(nx, ny) || 1;
    return { hit: true, nx: nx / norm, ny: ny / norm, reflect: true, x: px, y: py };
  }
  draw(ctx) {
    const { x, y, w, h } = this.rect;
    ctx.save();
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

class TJunctionArena extends Arena {
  constructor(width, height, scale) {
    super(width, height);
    // Build a hollow T corridor: open connection between vertical stem and horizontal bar
    const cx = width / 2; const cy = height / 2;
    // World units (inner corridor sizes)
    const stemWidthU = 100;
    const stemHeightU = 260;
    const barWidthU = 320;
    const barHeightU = 80;

    const sW = stemWidthU * scale;      // inner stem width
    const sH = stemHeightU * scale;     // stem length
    const bW = barWidthU * scale;       // inner bar width
    const bH = barHeightU * scale;      // inner bar height

    // Connection Y (where stem meets bar, at center of bar vertically)
    const connectY = cy - sH / 2;
    let barCenterY = connectY; // center of bar along Y
    let barTopY = barCenterY - bH / 2;
    let barBotY = barCenterY + bH / 2;

    // Ensure some top margin from screen edge
    const topMargin = 20; // px
    if (barTopY < topMargin) {
      const dy = topMargin - barTopY;
      barTopY += dy; barBotY += dy; barCenterY += dy;
    }

    // Stem vertical walls terminate at bar bottom to leave opening
    const stemLeftX = cx - sW / 2;
    const stemRightX = cx + sW / 2;
    const stemBotY = cy + sH / 2;

    const barLeftX = cx - bW / 2;
    const barRightX = cx + bW / 2;

    // Build segments: two stem sides, stem bottom cap, bar top wall, bar bottom walls left/right (gap at stem), bar end caps
    this.segments = [
      // Stem sides (stop at bar bottom)
      { x1: stemLeftX, y1: barBotY, x2: stemLeftX, y2: stemBotY },
      { x1: stemRightX, y1: barBotY, x2: stemRightX, y2: stemBotY },
      // Stem bottom cap
      { x1: stemLeftX, y1: stemBotY, x2: stemRightX, y2: stemBotY },
      // Bar top wall (continuous)
      { x1: barLeftX, y1: barTopY, x2: barRightX, y2: barTopY },
      // Bar bottom wall split into left and right to leave opening for stem
      { x1: barLeftX, y1: barBotY, x2: stemLeftX, y2: barBotY },
      { x1: stemRightX, y1: barBotY, x2: barRightX, y2: barBotY },
      // Bar end caps
      { x1: barLeftX, y1: barTopY, x2: barLeftX, y2: barBotY },
      { x1: barRightX, y1: barTopY, x2: barRightX, y2: barBotY },
    ];
  }
  // Reflect off segments, simple circle-line collision correction
  collideCircle(x, y, r) {
    for (const s of this.segments) {
      const vx = s.x2 - s.x1; const vy = s.y2 - s.y1;
      const wx = x - s.x1; const wy = y - s.y1;
      const vLen2 = vx * vx + vy * vy;
      const t = clamp((wx * vx + wy * vy) / vLen2, 0, 1);
      const cx = s.x1 + t * vx; const cy = s.y1 + t * vy;
      const dx = x - cx; const dy = y - cy; const d = Math.hypot(dx, dy);
      if (d < r) {
        const nx = dx / (d || 1); const ny = dy / (d || 1);
        return { hit: true, nx, ny, reflect: true, x: cx + nx * r, y: cy + ny * r };
      }
    }
    return { hit: false };
  }
  draw(ctx) {
    ctx.save();
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 4;
    for (const s of this.segments) {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Entities */
class Entity {
  constructor(x, y, r, color) { this.x = x; this.y = y; this.r = r; this.color = color; this.drag = false; }
  draw(ctx) {
    ctx.save();
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }
  contains(px, py) { return Math.hypot(px - this.x, py - this.y) <= this.r; }
}

/** Projectile */
let nextCastId = 1;
class Projectile {
  constructor(config) {
    this.id = Math.random().toString(36).slice(2);
    this.castId = config.castId;
    this.x = config.x;
    this.y = config.y;
    this.vx = Math.cos(config.angle) * config.speed;
    this.vy = Math.sin(config.angle) * config.speed;
    this.speed = config.speed;
    this.angle = config.angle;
    this.radius = PROJ_RADIUS_UNITS * window.__currentScale;
    this.spawnTime = config.now;
    this.duration = config.duration;
    this.casterRef = config.casterRef; // live reference to caster entity (for 150u leash)
    this.wander = new Wander(Math.PI * 2, 0.8);
    this.pierceRemaining = config.pierceCount;
    this.forkRemaining = config.forkTimes;
    this.chainRemaining = config.chainCount;
    this.splitCount = config.splitCount; // number of new projectiles when split triggers
    this.hasSplit = false;
  }
  age(now) { return (now - this.spawnTime) / 1000; }
  isExpired(now) {
    if (this.age(now) > this.duration && this.duration >= 0) return true;
    return false;
  }
  think(dt) {
    // Update direction via wander
    this.angle = this.wander.step(this.angle, dt);
    const vnx = Math.cos(this.angle);
    const vny = Math.sin(this.angle);
    this.vx = vnx * this.speed;
    this.vy = vny * this.speed;
  }
  move(dt) { this.x += this.vx * dt; this.y += this.vy * dt; }
  reflect(nx, ny) {
    // reflect velocity vector over normal
    const vdotn = this.vx * nx + this.vy * ny;
    this.vx = this.vx - 2 * vdotn * nx;
    this.vy = this.vy - 2 * vdotn * ny;
    this.angle = Math.atan2(this.vy, this.vx);
  }
  draw(ctx) {
    ctx.save();
    ctx.fillStyle = '#7cc5ff';
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }
}

/** Simulation */
class Simulation {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.scale = this.computeScale(); // pixels per world unit
    this.lastTime = performance.now();
    this.accum = 0;
    this.fixedDt = 1 / 120; // high fidelity physics
    this.maxTerrainStepPx = 2.0; // CCD safety step for terrain (pixels)

    // Entities (positions in pixels, radii scaled from world units)
    const cx = this.width / 2; const cy = this.height / 2;
    this.caster = new Entity(cx - 40 * this.scale, cy + 30 * this.scale, CASTER_RADIUS_UNITS * this.scale, '#4aa3ff');
    this.boss = new Entity(cx + 30 * this.scale, cy - 30 * this.scale, BOSS_RADIUS_UNITS * this.scale, '#ff6b6b');
    this.casterLeash = true;

    // State
    this.projectiles = [];
    this.running = false;
    this.castAccumulator = 0;
    this.castCooldown = 0; // computed from cast speed
    this.config = this.readConfigFromDOM();
    this.arena = this.createArena(this.config.arenaType);
    // Metrics history for spark charts
    this.metrics = {
      windowSec: 10,
      samples: [], // {t, hitsTotal, hitsPerSec, dps, totalDamage, projAlive}
      lastSampleAt: performance.now(),
      sampleIntervalMs: 200,
    };
    // Apply initial enemy radius from config
    this.boss.r = clamp(this.config.bossRadius || BOSS_RADIUS_UNITS, 0.1, 999) * this.scale;

    // Hit tracking
    this.hitsTotal = 0;
    this.totalDamage = 0;
    this.hitTimestamps = []; // for recent rate window
    this.castTargetLocks = new Map(); // key: castId+targetId -> nextAllowedHitTime

    // Input
    this.dragging = null; // 'caster' | 'boss'
    this.installInput();

    // UI
    this.installUI();

    requestAnimationFrame((t) => this.loop(t));
  }

  computeScale() {
    // Fit the 160u radius circle inside the canvas with some margin
    const diameter = ARENA_RADIUS_UNITS * 2;
    const marginPx = 20;
    const sx = (this.width - marginPx * 2) / diameter;
    const sy = (this.height - marginPx * 2) / diameter;
    return Math.max(0.5, Math.min(sx, sy));
  }

  readConfigFromDOM() {
    const getNum = (id) => Number(document.getElementById(id).value);
    const getSel = (id) => document.getElementById(id).value;
    const castSpeed = getNum('castSpeed');
    return {
      arenaType: getSel('arenaType'),
      avgHit: getNum('avgHit'),
      projSpeed: getNum('projSpeed'), // in world units per second
      projectileCount: getNum('projectileCount'),
      castSpeed,
      castInterval: castSpeed > 0 ? 1 / castSpeed : Infinity,
      duration: getNum('duration'),
      castShape: getSel('castShape'),
      casterFacingDeg: Number(document.getElementById('casterFacingDeg').value),
      coneAngleDeg: 90,
      pierceCount: getNum('pierceCount'),
      forkTimes: getNum('forkTimes'),
      chainCount: getNum('chainCount'),
      splitCount: getNum('splitCount'),
      forkChance: clamp(Number(document.getElementById('forkChance')?.value || 0), 0, 100),
      bossRadius: Number(document.getElementById('bossRadius')?.value || BOSS_RADIUS_UNITS),
    };
  }

  createArena(type) {
    if (type === 'square') return new SquareArena(this.width, this.height, this.scale);
    if (type === 'tjunction') return new TJunctionArena(this.width, this.height, this.scale);
    return new CircleArena(this.width, this.height, this.scale);
  }

  installUI() {
    const ids = [
      'arenaType','avgHit','projSpeed','projectileCount','castSpeed','duration','castShape','casterFacingDeg','pierceCount','forkTimes','chainCount','splitCount','forkChance','bossRadius'
    ];
    for (const id of ids) {
      document.getElementById(id).addEventListener('input', () => {
        this.config = this.readConfigFromDOM();
        this.arena = this.createArena(this.config.arenaType);
        document.getElementById('coneOptions').style.display = this.config.castShape === 'cone' ? 'block' : 'none';
        // live-apply enemy radius
        this.boss.r = clamp(this.config.bossRadius, 0.1, 999) * this.scale;
      });
    }

    document.getElementById('timeScale').addEventListener('change', (e) => {
      const sec = Number(e.target.value);
      this.metrics.windowSec = clamp(sec, 1, 600);
    });

    document.getElementById('startBtn').addEventListener('click', () => { this.running = true; });
    document.getElementById('stopBtn').addEventListener('click', () => { this.running = false; });
    document.getElementById('resetBtn').addEventListener('click', () => { this.reset(); });

    document.getElementById('coneOptions').style.display = this.config.castShape === 'cone' ? 'block' : 'none';
  }

  installInput() {
    const rect = () => this.canvas.getBoundingClientRect();
    const toCanvas = (e) => ({ x: e.clientX - rect().left, y: e.clientY - rect().top });

    this.canvas.addEventListener('mousedown', (e) => {
      const p = toCanvas(e);
      if (this.caster.contains(p.x, p.y)) { this.dragging = 'caster'; this.caster.drag = true; }
      else if (this.boss.contains(p.x, p.y)) { this.dragging = 'boss'; this.boss.drag = true; }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const p = toCanvas(e);
      if (this.dragging === 'caster') { this.caster.x = p.x; this.caster.y = p.y; }
      if (this.dragging === 'boss') { this.boss.x = p.x; this.boss.y = p.y; }
    });
    window.addEventListener('mouseup', () => {
      this.dragging = null; this.caster.drag = false; this.boss.drag = false;
    });
  }

  reset() {
    this.projectiles = [];
    this.hitsTotal = 0;
    this.totalDamage = 0;
    this.hitTimestamps = [];
    this.castTargetLocks.clear();
    nextCastId += 1;
  }

  emitCast(now) {
    const cfg = this.config;
    const count = cfg.projectileCount;
    const angles = [];
    if (cfg.castShape === 'circular') {
      for (let i = 0; i < count; i++) angles.push(randRange(0, TWO_PI));
    } else {
      // Cone centered on caster's facing with configurable angle
      const half = clamp(cfg.coneAngleDeg, 0, 360) * DEG_TO_RAD / 2;
      const facing = (cfg.casterFacingDeg || 0) * DEG_TO_RAD;
      for (let i = 0; i < count; i++) angles.push(facing + randRange(-half, half));
    }
    const castId = nextCastId++;
    for (const angle of angles) {
      this.projectiles.push(new Projectile({
        castId,
        x: this.caster.x,
        y: this.caster.y,
        angle,
        speed: this.config.projSpeed * this.scale, // convert to pixels per second
        now,
        duration: this.config.duration,
        casterRef: this.caster,
        pierceCount: this.config.pierceCount,
        forkTimes: this.config.forkTimes,
        chainCount: this.config.chainCount,
        splitCount: this.config.splitCount,
      }));
    }
  }

  tryApplyHit(proj, now) {
    // Shared cooldown per cast and target
    const targetId = 'boss';
    const key = proj.castId + '|' + targetId;
    const nextOk = this.castTargetLocks.get(key) || 0;
    if (now >= nextOk) {
      this.hitsTotal += 1;
      this.totalDamage += this.config.avgHit;
      this.hitTimestamps.push(now);
      this.castTargetLocks.set(key, now + PER_CAST_TARGET_COOLDOWN * 1000);
      return true;
    }
    return false;
  }

  handleProjectileEnemyCollision(proj, now) {
    // Check circle overlap
    const dx = proj.x - this.boss.x; const dy = proj.y - this.boss.y;
    const d = Math.hypot(dx, dy);
    if (d <= proj.radius + this.boss.r) {
      const hitRegistered = this.tryApplyHit(proj, now);
      if (hitRegistered) {
        // Order of operations: Split -> Pierce -> Fork -> Chain
        // Only one operation may occur per collision.

        // 1) Split (shoot evenly in a circle)
        if (!proj.hasSplit && proj.splitCount > 0) {
          proj.hasSplit = true;
          const n = Math.max(1, proj.splitCount);
          for (let i = 0; i < n; i++) {
            const theta = (i / n) * TWO_PI;
            this.projectiles.push(new Projectile({
              castId: proj.castId,
              x: proj.x,
              y: proj.y,
              angle: theta,
              speed: proj.speed,
              now: performance.now(),
              duration: Math.max(0, proj.duration - proj.age(performance.now())),
              casterRef: this.caster,
              pierceCount: proj.pierceRemaining,
              forkTimes: proj.forkRemaining,
              chainCount: proj.chainRemaining,
              splitCount: 0,
            }));
          }
          // Spark is absorbed on hit unless it pierces; since Split consumed the behavior, absorb original
          return 'remove';
        }

        // 2) Pierce
        if (proj.pierceRemaining > 0) {
          proj.pierceRemaining -= 1;
          // Nudge forward so it doesn't stick on the boss rim
          const nx = dx / (d || 1); const ny = dy / (d || 1);
          proj.x = this.boss.x + nx * (this.boss.r + proj.radius + 0.5);
          return 'keep';
        }

        // 3) Fork
        if (proj.forkRemaining > 0) {
          const base = Math.atan2(proj.vy, proj.vx);
          const forkAngle = 60 * DEG_TO_RAD;
          const childAngles = [base + forkAngle, base - forkAngle];
          if (Math.random() * 100 < this.config.forkChance) childAngles.push(base);
          const nowTs = performance.now();
          for (const a of childAngles) {
            this.projectiles.push(new Projectile({
              castId: proj.castId,
              x: proj.x,
              y: proj.y,
              angle: a,
              speed: proj.speed,
              now: nowTs,
              duration: Math.max(0, proj.duration - proj.age(nowTs)),
              casterRef: this.caster,
              pierceCount: proj.pierceRemaining,
              forkTimes: proj.forkRemaining - 1,
              chainCount: proj.chainRemaining,
              splitCount: 0,
            }));
          }
          // Original projectile is removed on fork
          return 'remove';
        }

        // 4) Chain (requires another enemy; with single boss target, this will have no effect)
        if (proj.chainRemaining > 0) {
          // No other targets -> absorbed
          return 'remove';
        }

        // No remaining behaviors -> absorbed on hit
        return 'remove';
      } else {
        // No hit registered due to per-cast cooldown; pass through without behaviors
      }
    }
    return 'keep';
  }

  attemptBehavioursOnTerrainCollision(proj) {
    // Behaviors (split/pierce/fork/chain) are enemy-only in this sim. Terrain only reflects.
    return 'keep';
  }

  step(dt) {
    const now = performance.now();

    // Emit based on cast speed
    if (this.running) {
      this.castAccumulator += dt;
      while (this.castAccumulator >= this.config.castInterval) {
        this.castAccumulator -= this.config.castInterval;
        this.emitCast(now);
      }
    }

    // Update projectiles with sub-stepped CCD (prevents tunneling at high speeds)
    const survivors = [];
    for (const proj of this.projectiles) {
      if (proj.isExpired(now)) continue;
      proj.think(dt);

      const speed = Math.hypot(proj.vx, proj.vy);
      const totalDist = speed * dt;
      const steps = Math.max(1, Math.ceil(totalDist / this.maxTerrainStepPx));
      const subdt = dt / steps;

      let removed = false;
      for (let s = 0; s < steps && !removed; s++) {
        // CCD vs boss within substep
        const dx = proj.vx * subdt;
        const dy = proj.vy * subdt;
        const R = proj.radius + this.boss.r;
        const tHit = sweptCircleHitT(proj.x, proj.y, dx, dy, this.boss.x, this.boss.y, R);
        if (tHit !== null) {
          proj.x += dx * tHit;
          proj.y += dy * tHit;
          const collisionTimeMs = now + (s * subdt + subdt * tHit) * 1000;
          const enemyRes = this.handleProjectileEnemyCollision(proj, collisionTimeMs);
          if (enemyRes === 'remove') { removed = true; break; }
          const remainFrac = 1 - tHit;
          if (remainFrac > 0) {
            proj.move(subdt * remainFrac);
          }
        } else {
          proj.move(subdt);
        }

        // Terrain collision (reflect). Use swept test against T-junction segments if applicable
        if (this.arena instanceof TJunctionArena) {
          // moving circle vs line segments (swept): approximate by segment-to-segment distance
          const nx = proj.vx * subdt; const ny = proj.vy * subdt;
          const p0x = proj.x - nx, p0y = proj.y - ny;
          const p1x = proj.x, p1y = proj.y;
          for (const seg of this.arena.segments) {
            const cp = closestPointsBetweenSegments(p0x, p0y, p1x, p1y, seg.x1, seg.y1, seg.x2, seg.y2);
            if (cp.dist < proj.radius) {
              // back up slightly and reflect
              const hitT = cp.sc; // along projectile path
              // place at contact point minus small epsilon outward
              const px = p0x + (p1x - p0x) * hitT;
              const py = p0y + (p1y - p0y) * hitT;
              // normal = from closest point on wall to projectile path point
              const wx = cp.px - cp.qx; const wy = cp.py - cp.qy;
              const len = Math.hypot(wx, wy) || 1;
              const nxn = wx / len; const nyn = wy / len;
              proj.x = cp.qx + nxn * proj.radius;
              proj.y = cp.qy + nyn * proj.radius;
              proj.reflect(nxn, nyn);
              break;
            }
          }
        } else {
          const hit = this.arena.collideCircle(proj.x, proj.y, proj.radius);
          if (hit.hit) {
            proj.x = hit.x; proj.y = hit.y;
            if (hit.reflect) proj.reflect(hit.nx, hit.ny);
            const res = this.attemptBehavioursOnTerrainCollision(proj);
            if (res === 'remove') { removed = true; break; }
          }
        }
      }
      if (removed) continue;

      survivors.push(proj);
    }
    this.projectiles = survivors;

    // Cleanup old hit timestamps beyond 5s window
    const windowMs = 5000;
    const cutoff = now - windowMs;
    while (this.hitTimestamps.length && this.hitTimestamps[0] < cutoff) this.hitTimestamps.shift();
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // Arena
    this.arena.draw(ctx);

    // If cone casting, draw facing and 90° cone lines from caster
    if (this.config.castShape === 'cone') {
      const facing = (this.config.casterFacingDeg || 0) * DEG_TO_RAD;
      const half = (90 * DEG_TO_RAD) / 2;
      const r = ARENA_RADIUS_UNITS * this.scale * 0.3; // visual length (cut by ~66%)
      const angles = [facing - half, facing, facing + half];
      ctx.save();
      ctx.strokeStyle = 'rgba(255,209,102,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      for (let i = 0; i < angles.length; i++) {
        const a = angles[i];
        const x2 = this.caster.x + Math.cos(a) * r;
        const y2 = this.caster.y + Math.sin(a) * r;
        ctx.moveTo(this.caster.x, this.caster.y);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Leash radius removed

    // Entities
    this.caster.draw(ctx);
    this.boss.draw(ctx);

    // Projectiles
    for (const p of this.projectiles) p.draw(ctx);

    // Legend
    ctx.save();
    ctx.fillStyle = '#a8b0c0';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system';
    ctx.fillText('Caster', this.caster.x + 12, this.caster.y + 4);
    ctx.fillText('Boss', this.boss.x + 24, this.boss.y + 4);
    ctx.restore();
  }

  updateStats() {
    const hitsPerSec = this.hitTimestamps.length / 5;
    document.getElementById('hitsTotal').textContent = String(this.hitsTotal);
    document.getElementById('hitsPerSec').textContent = hitsPerSec.toFixed(2);
    const dps = hitsPerSec * this.config.avgHit;
    document.getElementById('dps').textContent = dps.toFixed(1);
    document.getElementById('totalDmg').textContent = String(Math.round(this.totalDamage));
    document.getElementById('projAlive').textContent = String(this.projectiles.length);
    this.updateCharts(hitsPerSec, dps);
  }

  updateCharts(hitsPerSec, dps) {
    const now = performance.now();
    if (now - this.metrics.lastSampleAt >= this.metrics.sampleIntervalMs) {
      this.metrics.lastSampleAt = now;
      this.metrics.samples.push({
        t: now,
        hitsTotal: this.hitsTotal,
        hitsPerSec,
        dps,
        totalDamage: this.totalDamage,
        projAlive: this.projectiles.length,
      });
      // drop old samples beyond window
      const cutoff = now - this.metrics.windowSec * 1000;
      while (this.metrics.samples.length && this.metrics.samples[0].t < cutoff) this.metrics.samples.shift();
    }

    const s = this.metrics.samples;
    this.drawSpark('sparkHits', s.map(p => p.hitsTotal));
    this.drawSpark('sparkRate', s.map(p => p.hitsPerSec));
    this.drawSpark('sparkDps', s.map(p => p.dps));
    this.drawSpark('sparkDmg', s.map(p => p.totalDamage));
    this.drawSpark('sparkAlive', s.map(p => p.projAlive));
  }

  drawSpark(canvasId, values) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width; const h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    // grid baseline
    ctx.strokeStyle = '#2a3146';
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();

    if (values.length < 2) { ctx.restore(); return; }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    ctx.strokeStyle = '#7cc5ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1)) * (w - 1);
      const y = h - ((values[i] - min) / span) * (h - 1) - 1;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  loop(t) {
    const now = t;
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp dt to avoid spiral after tab switch
    dt = Math.min(dt, 0.05);
    this.accum += dt;
    while (this.accum >= this.fixedDt) {
      this.step(this.fixedDt);
      this.accum -= this.fixedDt;
    }
    this.draw();
    this.updateStats();
    requestAnimationFrame((t2) => this.loop(t2));
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('canvas');
  // Fit canvas to container size
  const parent = canvas.parentElement;
  const resize = () => {
    const rect = parent.getBoundingClientRect();
    canvas.width = Math.floor(rect.width);
    canvas.height = Math.floor(rect.height);
    // Recreate sim to rescale arenas while preserving entities
    if (window.__sim) {
      const prev = window.__sim;
      const sim = new Simulation(canvas);
      const ratio = sim.scale / prev.scale;
      // propagate scale globally for projectile radius construction
      window.__currentScale = sim.scale;
      // Rescale entities
      sim.caster.x = prev.caster.x * ratio; sim.caster.y = prev.caster.y * ratio;
      sim.boss.x = prev.boss.x * ratio; sim.boss.y = prev.boss.y * ratio;
      // Carry-over projectiles with rescale
      sim.projectiles = prev.projectiles.map(p => {
        p.x *= ratio; p.y *= ratio;
        p.vx *= ratio; p.vy *= ratio;
        p.speed *= ratio;
        p.radius = PROJ_RADIUS_UNITS * sim.scale;
        return p;
      });
      sim.running = prev.running;
      window.__sim = sim;
    }
  };
  window.addEventListener('resize', resize);
  window.__sim = new Simulation(canvas);
  window.__currentScale = window.__sim.scale;
  resize();
});


