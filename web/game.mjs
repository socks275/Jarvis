// A complete, dependency-free 3D shooter that Chorus can hand over in one piece.
// Everything runs from a single HTML file: no CDN, no build step, no assets.
// The engine is deliberately small — WebGL 1, flat shading, boxes — so the code
// stays readable enough to edit afterwards.

// A game has to be three-dimensional, asked for, and a shooter rather than a
// design document: "write a shooter game design document" is not a build.
const THREE_D = /\b(?:3d|3-d|fps|first[- ]person|webgl)\b/i;
const FPS = /\b(?:fps|first[- ]person|shooter|webgl)\b/i;
const GAME_NOUN = /\b(?:game|arena|level|doom|quake|raycast\w*)\b/i;
const GAME_ASK = /\b(?:make|build|create|code|write|generate|program|want|need|give)\b/i;
const NOT_A_BUILD = /\b(?:design document|game design|pitch|essay|explain|why|how does)\b/i;

/** True when the message asks for a 3D game or shooter rather than an answer. */
export function isGameRequest(text) {
  const prompt = String(text ?? '').trim();
  if (!prompt || prompt.length > 4000) return false;
  if (!GAME_ASK.test(prompt) || NOT_A_BUILD.test(prompt)) return false;
  // "3d fps in a dungeon" is a build request even without the word "game".
  return THREE_D.test(prompt) && (FPS.test(prompt) || GAME_NOUN.test(prompt));
}

const THEMES = {
  neon: {
    name: 'Neon Arena',
    sky: [0.05, 0.04, 0.09],
    floor: [0.11, 0.1, 0.16],
    wall: [0.24, 0.19, 0.36],
    pillar: [0.33, 0.24, 0.5],
    enemy: [1.0, 0.24, 0.42],
    orb: [1.0, 0.62, 0.2],
    bullet: [0.6, 0.95, 1.0],
    health: [0.35, 0.95, 0.55],
    fog: [0.07, 0.05, 0.12],
    hud: '#8de3ff',
  },
  space: {
    name: 'Orbital Deck',
    sky: [0.02, 0.03, 0.07],
    floor: [0.1, 0.12, 0.17],
    wall: [0.19, 0.24, 0.33],
    pillar: [0.26, 0.33, 0.45],
    enemy: [0.98, 0.35, 0.25],
    orb: [1.0, 0.75, 0.3],
    bullet: [0.65, 1.0, 0.85],
    health: [0.35, 0.95, 0.55],
    fog: [0.03, 0.04, 0.09],
    hud: '#9ff0c8',
  },
  dungeon: {
    name: 'Deep Vault',
    sky: [0.04, 0.03, 0.03],
    floor: [0.13, 0.11, 0.1],
    wall: [0.28, 0.24, 0.21],
    pillar: [0.36, 0.3, 0.25],
    enemy: [0.9, 0.3, 0.2],
    orb: [1.0, 0.6, 0.25],
    bullet: [1.0, 0.9, 0.55],
    health: [0.4, 0.9, 0.45],
    fog: [0.05, 0.04, 0.03],
    hud: '#ffd08a',
  },
  ice: {
    name: 'Frost Line',
    sky: [0.06, 0.09, 0.13],
    floor: [0.14, 0.19, 0.24],
    wall: [0.24, 0.33, 0.42],
    pillar: [0.33, 0.45, 0.55],
    enemy: [0.95, 0.3, 0.35],
    orb: [1.0, 0.8, 0.35],
    bullet: [0.75, 0.95, 1.0],
    health: [0.4, 1.0, 0.75],
    fog: [0.08, 0.12, 0.17],
    hud: '#bfe9ff',
  },
  sand: {
    name: 'Dust Sector',
    sky: [0.09, 0.07, 0.05],
    floor: [0.2, 0.16, 0.11],
    wall: [0.33, 0.27, 0.19],
    pillar: [0.42, 0.35, 0.24],
    enemy: [0.85, 0.25, 0.15],
    orb: [1.0, 0.7, 0.3],
    bullet: [1.0, 0.92, 0.6],
    health: [0.45, 0.9, 0.45],
    fog: [0.11, 0.09, 0.06],
    hud: '#ffd9a0',
  },
};

export const THEME_NAMES = Object.keys(THEMES);

/** The display name of a theme. */
export const themeName = (theme) => (THEMES[theme] ?? THEMES.neon).name;

const DEFAULT_OPTIONS = { arena: 26, playerSpeed: 5.4, sprintSpeed: 8.6, enemySpeed: 1.5, waveSize: 2, spread: 1 };

/**
 * Reads a follow-up such as "add a shotgun" or "make it harder" into engine
 * options, so a game can be changed without regenerating it.
 */
export function gameTweak(text) {
  const prompt = String(text ?? '').trim();
  if (!prompt || prompt.length > 160) return null;
  const tweak = {};
  if (/\bshotgun|spread shot|double barrel\b/i.test(prompt)) tweak.spread = 3;
  if (/\btriple shot|burst\b/i.test(prompt)) tweak.spread = 3;
  if (/\bharder|brutal|nightmare|tougher\b/i.test(prompt)) {
    tweak.enemySpeed = 2.6; tweak.waveSize = 4; tweak.arena = 22;
  } else if (/\beasier|casual|gentler|kinder\b/i.test(prompt)) {
    tweak.enemySpeed = 1.0; tweak.waveSize = 1; tweak.arena = 30;
  }
  if (/\bfaster|quicker|speed (?:it|me) up\b/i.test(prompt)) { tweak.playerSpeed = 8; tweak.sprintSpeed = 12; }
  if (/\bmore enemies|horde|swarm|army\b/i.test(prompt)) tweak.waveSize = 6;
  if (/\bbigger|larger|wider arena|more space\b/i.test(prompt)) tweak.arena = 36;
  if (/\bsmaller|tighter|cramped\b/i.test(prompt)) tweak.arena = 18;
  const theme = pickTheme(prompt);
  if (theme !== 'neon' || /\bneon\b/i.test(prompt)) tweak.theme = theme;
  return Object.keys(tweak).length ? tweak : null;
}

/** Merges a follow-up onto the options a game was built with. */
export const mergeGameOptions = (base, tweak) => ({ ...DEFAULT_OPTIONS, ...base, ...tweak });

/** Picks a palette from the words in the request, defaulting to neon. */
export function pickTheme(text) {
  const prompt = String(text ?? '').toLowerCase();
  if (/space|sci-?fi|station|orbit|alien/.test(prompt)) return 'space';
  if (/dungeon|castle|vault|crypt|horror|zombie/.test(prompt)) return 'dungeon';
  if (/ice|snow|frost|winter/.test(prompt)) return 'ice';
  if (/desert|dust|sand|western|canyon/.test(prompt)) return 'sand';
  return 'neon';
}

const num = (values) => values.map((value) => value.toFixed(3)).join(', ');

/**
 * The whole game as one HTML file. The script avoids template literals so the
 * document can be embedded in a template literal here without escaping games.
 */
export function buildGame(themeOrOptions = 'neon') {
  const options = typeof themeOrOptions === 'string'
    ? mergeGameOptions({}, {})
    : mergeGameOptions(themeOrOptions, {});
  const theme = typeof themeOrOptions === 'string' ? themeOrOptions : (themeOrOptions.theme ?? 'neon');
  const look = THEMES[theme] ?? THEMES.neon;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${look.name} — 3D Shooter</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #07060b; }
  body { font: 15px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f0ff; }
  #gl { display: block; width: 100vw; height: 100vh; cursor: crosshair; }
  #hud { position: fixed; inset: 0; pointer-events: none; }
  .panel { position: absolute; padding: 8px 12px; border-radius: 10px; background: #0d0b14cc; border: 1px solid #ffffff1f; backdrop-filter: blur(6px); }
  #vitals { left: 16px; bottom: 16px; min-width: 190px; }
  #score { right: 16px; top: 16px; text-align: right; }
  #hp-bar { height: 8px; margin-top: 6px; border-radius: 999px; background: #ffffff14; overflow: hidden; }
  #hp-fill { height: 100%; width: 100%; border-radius: 999px; background: linear-gradient(90deg, #ff4d6d, #ffb457); transition: width .12s linear; }
  .label { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; opacity: .62; }
  .value { font-variant-numeric: tabular-nums; font-weight: 650; }
  #crosshair { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; }
  #crosshair::before, #crosshair::after { content: ""; position: absolute; background: #ffffffcc; box-shadow: 0 0 6px #000a; }
  #crosshair::before { left: 50%; top: 0; width: 2px; height: 100%; margin-left: -1px; }
  #crosshair::after { top: 50%; left: 0; height: 2px; width: 100%; margin-top: -1px; }
  #hit { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; opacity: 0; transition: opacity .18s ease; }
  #hit::before, #hit::after { content: ""; position: absolute; inset: 0; margin: auto; width: 26px; height: 2px; background: ${look.hud}; }
  #hit::before { transform: rotate(45deg); } #hit::after { transform: rotate(-45deg); }
  #flash { position: absolute; inset: 0; background: #ff2d55; opacity: 0; transition: opacity .2s ease; }
  #banner { position: absolute; left: 50%; top: 22%; transform: translateX(-50%); text-align: center; font-weight: 700; letter-spacing: .04em; opacity: 0; transition: opacity .3s ease; text-shadow: 0 2px 18px #000b; }
  #overlay { position: fixed; inset: 0; display: grid; place-items: center; background: #07060bd9; backdrop-filter: blur(4px); text-align: center; }
  #overlay[hidden] { display: none; }
  .card { max-width: 460px; padding: 26px 28px; border-radius: 16px; border: 1px solid #ffffff20; background: #100d18f2; box-shadow: 0 24px 80px #000a; }
  h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -.01em; }
  h1 span { color: ${look.hud}; }
  p { margin: 0 0 14px; color: #cfc7e0; }
  kbd { display: inline-block; min-width: 20px; padding: 2px 6px; border-radius: 6px; border: 1px solid #ffffff2e; background: #ffffff0f; font: inherit; font-size: 12px; }
  button { pointer-events: auto; margin-top: 6px; padding: 11px 22px; border: 0; border-radius: 10px; background: ${look.hud}; color: #0a0812; font: inherit; font-weight: 700; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  .keys { display: grid; gap: 6px; margin: 14px 0 4px; font-size: 13px; color: #b9b1cc; }
</style>
</head>
<body>
<canvas id="gl" aria-label="Game view"></canvas>
<div id="hud">
  <div id="flash"></div>
  <div id="crosshair"></div>
  <div id="hit"></div>
  <div id="banner"></div>
  <div class="panel" id="vitals">
    <div class="label">Health</div>
    <div class="value"><span id="hp">100</span> / 100</div>
    <div id="hp-bar"><div id="hp-fill"></div></div>
  </div>
  <div class="panel" id="score">
    <div class="label">Score</div>
    <div class="value" id="score-value">0</div>
    <div class="label" style="margin-top:6px">Wave</div>
    <div class="value" id="wave-value">1</div>
  </div>
</div>
<div id="overlay">
  <div class="card">
    <h1 id="title">${look.name}</h1>
    <p id="subtitle">Hold the arena. Enemies keep coming in waves.</p>
    <div class="keys">
      <div><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> move · <kbd>Shift</kbd> sprint · <kbd>Space</kbd> jump</div>
      <div><kbd>Mouse</kbd> look · <kbd>Click</kbd> fire · <kbd>R</kbd> restart · <kbd>Esc</kbd> release cursor</div>
    </div>
    <button id="start">Click to play</button>
  </div>
</div>
<script>
(function () {
  'use strict';

  var SKY = [${num(look.sky)}];
  var FLOOR = [${num(look.floor)}];
  var WALL = [${num(look.wall)}];
  var PILLAR = [${num(look.pillar)}];
  var ENEMY = [${num(look.enemy)}];
  var ORB = [${num(look.orb)}];
  var BULLET = [${num(look.bullet)}];
  var HEALTH = [${num(look.health)}];
  var FOG = [${num(look.fog)}];

  var canvas = document.getElementById('gl');
  var gl = canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl');
  var overlay = document.getElementById('overlay');
  var startButton = document.getElementById('start');
  var title = document.getElementById('title');
  var subtitle = document.getElementById('subtitle');

  if (!gl) {
    overlay.hidden = false;
    title.textContent = 'WebGL is not available';
    subtitle.textContent = 'This game needs a browser with WebGL enabled.';
    startButton.hidden = true;
    return;
  }

  // ---- matrices -----------------------------------------------------------
  function identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  function multiply(a, b) {
    var out = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }
  function perspective(fov, aspect, near, far) {
    var f = 1 / Math.tan(fov / 2);
    var nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function translation(x, y, z) {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  }
  function scaling(x, y, z) {
    return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
  }
  function rotationX(angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  }
  function rotationY(angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  }

  // ---- shaders ------------------------------------------------------------
  var vertexSource = [
    'attribute vec3 aPosition;',
    'attribute vec3 aNormal;',
    'uniform mat4 uProjection;',
    'uniform mat4 uView;',
    'uniform mat4 uModel;',
    'varying vec3 vNormal;',
    'varying float vDepth;',
    'void main() {',
    '  vec4 world = uModel * vec4(aPosition, 1.0);',
    '  vec4 eye = uView * world;',
    '  vNormal = mat3(uModel) * aNormal;',
    '  vDepth = -eye.z;',
    '  gl_Position = uProjection * eye;',
    '}'
  ].join('\\n');

  var fragmentSource = [
    'precision mediump float;',
    'uniform vec3 uColor;',
    'uniform vec3 uFogColor;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'uniform float uEmissive;',
    'varying vec3 vNormal;',
    'varying float vDepth;',
    'void main() {',
    '  vec3 normal = normalize(vNormal);',
    '  float key = max(dot(normal, normalize(vec3(0.45, 1.0, 0.35))), 0.0);',
    '  float fill = max(dot(normal, normalize(vec3(-0.6, 0.25, -0.5))), 0.0) * 0.35;',
    '  vec3 lit = uColor * (0.34 + 0.76 * key + fill);',
    '  lit = mix(lit, uColor * 1.35, uEmissive);',
    '  float fog = clamp((vDepth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);',
    '  gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);',
    '}'
  ].join('\\n');

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader error');
    return shader;
  }
  var program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link error');
  gl.useProgram(program);

  var locations = {
    position: gl.getAttribLocation(program, 'aPosition'),
    normal: gl.getAttribLocation(program, 'aNormal'),
    projection: gl.getUniformLocation(program, 'uProjection'),
    view: gl.getUniformLocation(program, 'uView'),
    model: gl.getUniformLocation(program, 'uModel'),
    color: gl.getUniformLocation(program, 'uColor'),
    fogColor: gl.getUniformLocation(program, 'uFogColor'),
    fogNear: gl.getUniformLocation(program, 'uFogNear'),
    fogFar: gl.getUniformLocation(program, 'uFogFar'),
    emissive: gl.getUniformLocation(program, 'uEmissive')
  };

  // ---- geometry: one box, drawn everywhere ---------------------------------
  var boxData = (function () {
    var faces = [
      [[0, 0, 1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], // front
      [[0, 0, -1], [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], // back
      [[1, 0, 0], [1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], // right
      [[-1, 0, 0], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], // left
      [[0, 1, 0], [-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], // top
      [[0, -1, 0], [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] // bottom
    ];
    var data = [];
    for (var f = 0; f < faces.length; f++) {
      var normal = faces[f][0];
      var a = faces[f][1], b = faces[f][2], c = faces[f][3], d = faces[f][4];
      var order = [a, b, c, a, c, d];
      for (var i = 0; i < order.length; i++) {
        data.push(order[i][0], order[i][1], order[i][2], normal[0], normal[1], normal[2]);
      }
    }
    return new Float32Array(data);
  })();

  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, boxData, gl.STATIC_DRAW);
  var stride = 6 * 4;
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(locations.normal);
  gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, stride, 12);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  // ---- world --------------------------------------------------------------
  var ARENA = ${options.arena};
  var boxes = [];
  function addBox(x, z, width, depth, height, color, solid) {
    boxes.push({ x: x, z: z, w: width, d: depth, h: height, color: color, solid: solid !== false });
  }
  // Outer walls.
  addBox(0, -ARENA, ARENA * 2 + 2, 1, 6, WALL);
  addBox(0, ARENA, ARENA * 2 + 2, 1, 6, WALL);
  addBox(-ARENA, 0, 1, ARENA * 2 + 2, 6, WALL);
  addBox(ARENA, 0, 1, ARENA * 2 + 2, 6, WALL);
  // Pillars and cover.
  [[-12, -12], [12, -12], [-12, 12], [12, 12]].forEach(function (at) {
    addBox(at[0], at[1], 3.4, 3.4, 7, PILLAR);
  });
  [[-4, -9, 2.2], [7, 6, 3], [-8, 5, 1.4], [9, -3, 2.6], [0, 0, 2]].forEach(function (crate) {
    addBox(crate[0], crate[1], crate[2], crate[2], crate[2] * 1.4, PILLAR);
  });

  function blocked(x, z, radius) {
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (!box.solid) continue;
      var halfW = box.w / 2 + radius;
      var halfD = box.d / 2 + radius;
      if (Math.abs(x - box.x) < halfW && Math.abs(z - box.z) < halfD) return true;
    }
    return false;
  }

  // ---- state --------------------------------------------------------------
  var EYE = 1.68;
  var player = { x: 0, z: -18, yaw: 0, pitch: 0, vy: 0, y: EYE, health: 100, alive: true };
  var enemies = [];
  var bullets = [];
  var orbs = [];
  var pickups = [];
  var score = 0;
  var wave = 0;
  var playing = false;
  var locked = false;
  var lastTime = 0;
  var fireCooldown = 0;
  var hurtFlash = 0;
  var bannerTimer = 0;

  var keys = Object.create(null);
  var hud = {
    hp: document.getElementById('hp'),
    hpFill: document.getElementById('hp-fill'),
    score: document.getElementById('score-value'),
    wave: document.getElementById('wave-value'),
    hit: document.getElementById('hit'),
    flash: document.getElementById('flash'),
    banner: document.getElementById('banner')
  };

  function randomSpot() {
    for (var attempt = 0; attempt < 80; attempt++) {
      var angle = Math.random() * Math.PI * 2;
      var distance = 9 + Math.random() * 13;
      var x = player.x + Math.cos(angle) * distance;
      var z = player.z + Math.sin(angle) * distance;
      if (Math.abs(x) > ARENA - 2 || Math.abs(z) > ARENA - 2) continue;
      if (blocked(x, z, 0.9)) continue;
      return { x: x, z: z };
    }
    return { x: 0, z: 0 };
  }

  function spawnWave() {
    wave += 1;
    var count = ${options.waveSize} + Math.min(8, wave);
    for (var i = 0; i < count; i++) {
      var spot = randomSpot();
      enemies.push({
        x: spot.x, z: spot.z, health: 30 + wave * 6, maxHealth: 30 + wave * 6,
        speed: ${options.enemySpeed} + Math.min(2.4, wave * 0.22), cooldown: 1 + Math.random() * 1.5,
        bob: Math.random() * Math.PI * 2, size: 0.85 + Math.random() * 0.3
      });
    }
    if (wave > 1) showBanner('Wave ' + wave);
    hud.wave.textContent = String(wave);
  }

  function showBanner(text) {
    hud.banner.textContent = text;
    hud.banner.style.opacity = '1';
    bannerTimer = 1.6;
  }

  function reset() {
    player = { x: 0, z: -18, yaw: 0, pitch: 0, vy: 0, y: EYE, health: 100, alive: true };
    enemies = [];
    bullets = [];
    orbs = [];
    pickups = [];
    score = 0;
    wave = 0;
    hurtFlash = 0;
    hud.score.textContent = '0';
    hud.hp.textContent = '100';
    hud.hpFill.style.width = '100%';
    spawnWave();
  }

  function hurt(amount) {
    if (!player.alive) return;
    player.health = Math.max(0, player.health - amount);
    hud.hp.textContent = String(Math.round(player.health));
    hud.hpFill.style.width = player.health + '%';
    hurtFlash = Math.min(0.55, hurtFlash + 0.3);
    if (player.health <= 0) die();
  }

  function die() {
    player.alive = false;
    playing = false;
    document.exitPointerLock && document.exitPointerLock();
    overlay.hidden = false;
    title.textContent = 'You went down';
    subtitle.textContent = 'Score ' + score + ' · reached wave ' + wave + '.';
    startButton.textContent = 'Play again';
  }

  function fire() {
    if (!playing || !player.alive || fireCooldown > 0) return;
    fireCooldown = ${options.spread > 1 ? 0.24 : 0.14};
    var shots = ${options.spread};
    for (var shot = 0; shot < shots; shot++) {
      var yaw = player.yaw + (shot - (shots - 1) / 2) * 0.055;
      var cos = Math.cos(yaw), sin = Math.sin(yaw);
      var dx = -sin * Math.cos(player.pitch);
      var dz = -cos * Math.cos(player.pitch);
      var dy = Math.sin(player.pitch);
      bullets.push({
        x: player.x - sin * 0.5, y: player.y - 0.06, z: player.z - cos * 0.5,
        vx: dx * 42, vy: dy * 42, vz: dz * 42, life: 1.4
      });
    }
    blip(660, 0.05, 0.05);
  }

  // ---- audio (created on the first click, so nothing plays before then) ----
  var audio = null;
  function blip(frequency, duration, volume) {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      var oscillator = audio.createOscillator();
      var gain = audio.createGain();
      oscillator.type = 'square';
      oscillator.frequency.value = frequency;
      gain.gain.value = volume;
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + duration);
    } catch (error) { /* audio is a nicety, never a requirement */ }
  }

  // ---- input --------------------------------------------------------------
  function requestLock() {
    if (canvas.requestPointerLock) canvas.requestPointerLock();
    else if (canvas.mozRequestPointerLock) canvas.mozRequestPointerLock();
  }

  startButton.addEventListener('click', function () {
    overlay.hidden = true;
    if (!player.alive || enemies.length === 0) reset();
    playing = true;
    lastTime = 0;
    requestLock();
  });

  document.addEventListener('pointerlockchange', function () {
    locked = document.pointerLockElement === canvas;
    if (!locked && playing && player.alive) {
      playing = false;
      overlay.hidden = false;
      title.textContent = 'Paused';
      subtitle.textContent = 'Score ' + score + ' · wave ' + wave + '.';
      startButton.textContent = 'Resume';
    }
  });

  canvas.addEventListener('click', function () {
    if (!playing) return;
    if (!locked) requestLock();
    fire();
  });

  document.addEventListener('mousedown', function (event) {
    if (playing && locked && event.button === 0) fire();
  });

  document.addEventListener('mousemove', function (event) {
    if (!locked) return;
    player.yaw -= event.movementX * 0.0022;
    player.pitch = Math.max(-1.35, Math.min(1.35, player.pitch - event.movementY * 0.0022));
  });

  document.addEventListener('keydown', function (event) {
    keys[event.code] = true;
    if (event.code === 'KeyR' && !playing) {
      reset();
      overlay.hidden = false;
      title.textContent = '${look.name}';
      subtitle.textContent = 'Hold the arena. Enemies keep coming in waves.';
      startButton.textContent = 'Click to play';
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(event.code) !== -1) event.preventDefault();
  });
  document.addEventListener('keyup', function (event) { keys[event.code] = false; });
  window.addEventListener('blur', function () { keys = Object.create(null); });

  function resize() {
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- update -------------------------------------------------------------
  function update(delta) {
    fireCooldown = Math.max(0, fireCooldown - delta);
    if (hurtFlash > 0) {
      hurtFlash = Math.max(0, hurtFlash - delta);
      hud.flash.style.opacity = String(hurtFlash);
    }
    if (bannerTimer > 0) {
      bannerTimer -= delta;
      if (bannerTimer <= 0) hud.banner.style.opacity = '0';
    }
    if (!playing || !player.alive) return;

    var speed = (keys.ShiftLeft || keys.ShiftRight ? ${options.sprintSpeed} : ${options.playerSpeed}) * delta;
    var forward = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    var strafe = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    var sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    var moveX = (-sin * forward + cos * strafe) * speed;
    var moveZ = (-cos * forward - sin * strafe) * speed;

    if (moveX && !blocked(player.x + moveX, player.z, 0.42)) player.x += moveX;
    if (moveZ && !blocked(player.x, player.z + moveZ, 0.42)) player.z += moveZ;

    // Jump and gravity keep the view lively without a physics engine.
    if (keys.Space && player.y <= EYE + 0.001) player.vy = 4.6;
    player.vy -= 14 * delta;
    player.y += player.vy * delta;
    if (player.y < EYE) { player.y = EYE; player.vy = 0; }

    // Enemies chase, bump and shoot.
    for (var i = 0; i < enemies.length; i++) {
      var enemy = enemies[i];
      var dx = player.x - enemy.x;
      var dz = player.z - enemy.z;
      var distance = Math.hypot(dx, dz) || 1;
      var step = enemy.speed * delta;
      var nx = enemy.x + (dx / distance) * step;
      var nz = enemy.z + (dz / distance) * step;
      if (!blocked(nx, enemy.z, enemy.size * 0.5)) enemy.x = nx;
      if (!blocked(enemy.x, nz, enemy.size * 0.5)) enemy.z = nz;
      enemy.bob += delta * 3;

      if (distance < enemy.size * 0.5 + 0.9) hurt(16 * delta);

      enemy.cooldown -= delta;
      if (enemy.cooldown <= 0 && distance < 22) {
        enemy.cooldown = Math.max(0.9, 2.6 - wave * 0.12) + Math.random() * 0.7;
        var aimY = Math.atan2(player.y - 1.1, distance);
        orbs.push({
          x: enemy.x, y: 1.05, z: enemy.z,
          vx: (dx / distance) * 9, vy: aimY * 4, vz: (dz / distance) * 9, life: 5
        });
        blip(180, 0.08, 0.03);
      }
    }

    // Player bullets. A shot is a segment, not a point: at 42 units a second a
    // bullet moves further in one frame than an enemy is wide, so a point test
    // would shoot straight through them.
    for (var b = bullets.length - 1; b >= 0; b--) {
      var bullet = bullets[b];
      var fromX = bullet.x, fromY = bullet.y, fromZ = bullet.z;
      bullet.x += bullet.vx * delta;
      bullet.y += bullet.vy * delta;
      bullet.z += bullet.vz * delta;
      bullet.life -= delta;
      var hitSomething = false;
      for (var e = enemies.length - 1; e >= 0; e--) {
        var target = enemies[e];
        var radius = 0.45 + target.size * 0.35;
        if (segmentHits(fromX, fromY, fromZ, bullet.x, bullet.y, bullet.z, target.x, 1.0, target.z, radius)) {
          target.health -= 24;
          hitSomething = true;
          hud.hit.style.opacity = '0.9';
          setTimeout(function () { hud.hit.style.opacity = '0'; }, 90);
          blip(880, 0.04, 0.04);
          if (target.health <= 0) {
            enemies.splice(e, 1);
            score += 10 + wave * 2;
            hud.score.textContent = String(score);
            blip(320, 0.12, 0.05);
            if (Math.random() < 0.34) {
              pickups.push({ x: target.x, z: target.z, spin: 0 });
            }
          }
          break;
        }
      }
      if (hitSomething || bullet.life <= 0 || blocked(bullet.x, bullet.z, 0.05) || bullet.y < 0.05) bullets.splice(b, 1);
    }

    // Enemy orbs.
    for (var o = orbs.length - 1; o >= 0; o--) {
      var orb = orbs[o];
      orb.x += orb.vx * delta;
      orb.y += orb.vy * delta;
      orb.z += orb.vz * delta;
      orb.life -= delta;
      if (segmentHits(orb.x - orb.vx * delta, orb.y - orb.vy * delta, orb.z - orb.vz * delta,
        orb.x, orb.y, orb.z, player.x, player.y - 0.25, player.z, 0.62)) {
        hurt(11);
        orbs.splice(o, 1);
        continue;
      }
      if (orb.life <= 0 || blocked(orb.x, orb.z, 0.05) || orb.y < 0.05) orbs.splice(o, 1);
    }

    // Health pickups.
    for (var p = pickups.length - 1; p >= 0; p--) {
      var pickup = pickups[p];
      pickup.spin += delta * 2;
      if (Math.hypot(player.x - pickup.x, player.z - pickup.z) < 1.2) {
        player.health = Math.min(100, player.health + 25);
        hud.hp.textContent = String(Math.round(player.health));
        hud.hpFill.style.width = player.health + '%';
        pickups.splice(p, 1);
        blip(720, 0.1, 0.05);
      }
    }

    if (!enemies.length) spawnWave();
  }

  // Closest approach of a moving point (a bullet) to a sphere (an enemy).
  function segmentHits(x1, y1, z1, x2, y2, z2, cx, cy, cz, radius) {
    var sx = x2 - x1, sy = y2 - y1, sz = z2 - z1;
    var lengthSquared = sx * sx + sy * sy + sz * sz;
    var t = lengthSquared > 0 ? ((cx - x1) * sx + (cy - y1) * sy + (cz - z1) * sz) / lengthSquared : 0;
    t = Math.max(0, Math.min(1, t));
    var qx = x1 + sx * t - cx, qy = y1 + sy * t - cy, qz = z1 + sz * t - cz;
    return qx * qx + qy * qy + qz * qz <= radius * radius;
  }

  // ---- draw ---------------------------------------------------------------
  function drawBox(x, y, z, width, height, depth, color, emissive) {
    var model = multiply(multiply(translation(x, y, z), rotationY(0)), scaling(width, height, depth));
    gl.uniformMatrix4fv(locations.model, false, new Float32Array(model));
    gl.uniform3f(locations.color, color[0], color[1], color[2]);
    gl.uniform1f(locations.emissive, emissive || 0);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }

  function render() {
    resizeIfNeeded();
    var ratio = canvas.width / Math.max(1, canvas.height);
    gl.clearColor(FOG[0], FOG[1], FOG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    var projection = perspective(Math.PI / 3, ratio, 0.05, 90);
    var view = multiply(
      multiply(rotationX(-player.pitch), rotationY(-player.yaw)),
      translation(-player.x, -player.y, -player.z)
    );
    gl.uniformMatrix4fv(locations.projection, false, new Float32Array(projection));
    gl.uniformMatrix4fv(locations.view, false, new Float32Array(view));
    gl.uniform3f(locations.fogColor, FOG[0], FOG[1], FOG[2]);
    gl.uniform1f(locations.fogNear, 14);
    gl.uniform1f(locations.fogFar, 52);

    // Floor and ceiling slabs.
    drawBox(0, -0.5, 0, ARENA * 2, 1, ARENA * 2, FLOOR, 0);
    drawBox(0, 6.2, 0, ARENA * 2, 0.4, ARENA * 2, WALL, 0);

    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      drawBox(box.x, box.h / 2, box.z, box.w, box.h, box.d, box.color, 0);
    }
    for (var e = 0; e < enemies.length; e++) {
      var enemy = enemies[e];
      var lift = 1.0 + Math.sin(enemy.bob) * 0.08;
      var shade = 0.72 + 0.28 * (enemy.health / enemy.maxHealth);
      drawBox(enemy.x, lift, enemy.z, enemy.size, enemy.size * 1.7, enemy.size,
        [ENEMY[0] * shade, ENEMY[1] * shade, ENEMY[2] * shade], 0.25);
    }
    for (var b = 0; b < bullets.length; b++) {
      var bullet = bullets[b];
      drawBox(bullet.x, bullet.y, bullet.z, 0.12, 0.12, 0.12, BULLET, 1);
    }
    for (var o = 0; o < orbs.length; o++) {
      var orb = orbs[o];
      drawBox(orb.x, orb.y, orb.z, 0.34, 0.34, 0.34, ORB, 0.7);
    }
    for (var p = 0; p < pickups.length; p++) {
      var pickup = pickups[p];
      var bob = 0.85 + Math.sin(pickup.spin) * 0.12;
      drawBox(pickup.x, bob, pickup.z, 0.4, 0.4, 0.4, HEALTH, 0.5);
    }
  }

  var lastWidth = 0, lastHeight = 0;
  function resizeIfNeeded() {
    if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
      lastWidth = canvas.clientWidth;
      lastHeight = canvas.clientHeight;
      resize();
    }
  }

  function frame(now) {
    var delta = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0.016;
    lastTime = now;
    update(delta);
    render();
    requestAnimationFrame(frame);
  }

  reset();
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>
`;
}
