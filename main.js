import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadGLB, disposeObject } from './lib/assetLoader.js';
import { loadMappingForModelId, indexMapping } from './lib/mappings.js';
import { ImagePool } from './lib/textures.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { buildOriginalColorsMap, applyHueRotation, assignTextureToMesh, STANDARD_INITIAL_COLOR, attachHueShift } from './lib/appearance.js';

const viewport = document.getElementById('viewport');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const PR_MIN = 1.0, PR_MAX = Math.min(1.5, window.devicePixelRatio || 1.5);
let currentPR = PR_MAX;
renderer.setPixelRatio(currentPR);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.appendChild(renderer.domElement);

// ---------- ILUMINAÇÃO ----------
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(2, 3, 4);
scene.add(dirLight);

// ---------- CONTROLES DE CÂMERA ----------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minPolarAngle = THREE.MathUtils.degToRad(55);
controls.maxPolarAngle = THREE.MathUtils.degToRad(90);
controls.autoRotate = false;

function resize() {
  const rect = viewport.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

window.addEventListener('resize', resize);
if ('ResizeObserver' in window) {
  const ro = new ResizeObserver(() => resize());
  ro.observe(viewport);
}
resize();

// ---------- LOOP DE RENDERIZAÇÃO ----------
let animating = false;
let rafId = null;
let lastT = 0;
let smoothedDt = 16.7;
let renderScheduled = false;

function adaptPixelRatio(dt) {
  smoothedDt = smoothedDt * 0.9 + dt * 0.1;
  if (smoothedDt > 24 && currentPR > PR_MIN) {
    currentPR = Math.max(PR_MIN, currentPR - 0.25);
    renderer.setPixelRatio(currentPR);
  } else if (smoothedDt < 17 && currentPR < PR_MAX) {
    currentPR = Math.min(PR_MAX, currentPR + 0.25);
    renderer.setPixelRatio(currentPR);
  }
}

function loop(t) {
  if (!animating) { rafId = null; return; }
  const dt = lastT ? (t - lastT) : 16.7; lastT = t;
  adaptPixelRatio(dt);
  controls.update();
  renderer.render(scene, camera);
  rafId = requestAnimationFrame(loop);
}

function startLoop() {
  if (animating) return;
  animating = true; lastT = 0;
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  animating = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function requestRender() {
  if (animating) return;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderer.render(scene, camera);
  });
}

controls.addEventListener('change', () => { if (!animating) requestRender(); });
controls.addEventListener('start', () => startLoop());
controls.addEventListener('end', () => { if (!controls.autoRotate) setTimeout(() => stopLoop(), 120); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLoop();
  else { requestRender(); }
});

// ---------- ESTADO DE CARREGAMENTO DE MODELOS ----------
let currentModel = null;
let loadToken = 0;
let currentModelId = null;
let mappingIndex = null;
let originalColorMap = null;
let capaMaterialUuids = new Set();
let linhaMaterialUuids = new Set();
const clonedMeshes = new Set();
const imagePool = new ImagePool(renderer);

// ---------- ESTADO DE HDR ----------
const rgbeLoader = new RGBELoader();
const pmremGen = new THREE.PMREMGenerator(renderer);
let currentEnv = { url: null, envMap: null, srcTex: null, envRT: null };
let envIntensity = 1.0;
let envExposure = 1.0;
let envBackground = false;
let envAutoLoaded = false;

// ---------- CATEGORIAS DE ESCALA DE MODELOS ----------
const MODEL_CATEGORY = {
  bike: 'small', motoG: 'small', jetski: 'small', quadriciclo: 'small',
  fusca: 'medium', esportivo: 'medium', hatch: 'medium', sedan: 'medium', ford1929: 'medium', jeep: 'medium',
  kombi: 'large',
  caminhonete: 'xlarge', suv: 'xlarge',
};
const CATEGORY_TARGET_RATIO = {
  small: 0.12,
  medium: 0.16,
  large: 0.20,
  xlarge: 0.24,
};

// ---------- CONFIGURAÇÃO DE CORES ----------
const SWATCH_CONFIG = {
  '#962d28': { sat: 2.00, val: 0.00, hue: 55,  mix: 1.00 },
  '#498551': { sat: 1.20, val: 0.72, hue: 98,  mix: 0.74 },
  '#2c41bd': { sat: 2.00, val: 1.76, hue: 34,  mix: 0.86 },
  '#001f5b': { sat: 0.23, val: 0.00, hue: 34,  mix: 0.33 },
  '#615e60': { sat: 0.0,  val: 1.0,  hue: 0,   mix: 0.0  },
  '#090909': { sat: 0.0,  val: 0.15, hue: 0,   mix: 0.0  },
};

// ---------- CENÁRIO ----------
const SCENARIO_URL = 'assets/cenarios/scifi_stage_gallery_baked_gltf/scene.gltf';
let scenarioRoot = null;

export async function loadModel(url) {
  viewport.setAttribute('aria-busy', 'true');
  const token = ++loadToken;
  viewport.dataset.busy = 'Carregando… 0%';
  try {
    const gltf = await loadGLB(url, (pct) => {
      viewport.dataset.busy = pct == null ? 'Carregando…' : `Carregando… ${pct}%`;
    });
    if (token !== loadToken) {
      if (gltf?.scene) disposeObject(gltf.scene);
      return;
    }
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error('GLTF sem cena válida.');

    if (currentModel) {
      scene.remove(currentModel);
      disposeObject(currentModel);
    }

    currentModel = root;
    scene.add(currentModel);
    camera.position.set(0, 0, 5);
    camera.near = 0.1;
    camera.far = 1000;
    camera.updateProjectionMatrix();
  } catch (err) {
    console.warn('Falha ao carregar modelo:', err);
  } finally {
    viewport.removeAttribute('aria-busy');
    delete viewport.dataset.busy;
  }
}

// ---------- SELEÇÃO DE MODELOS ----------
const modelButtons = document.getElementById('modelButtons');
async function selectModel(id, url) {
  try {
    await loadModel(url);
  } finally {
    currentModelId = id;
    await setupMappingAndUI(id);
  }
}
if (modelButtons) {
  modelButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-url]');
    if (!btn) return;
    modelButtons.querySelectorAll('button').forEach((b) => {
      const active = b === btn;
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('active', active);
    });
    const id = btn.dataset.id;
    const url = btn.dataset.url;
    if (id && url) void selectModel(id, url);
  });
}

async function populateModels() {
  if (!modelButtons) return;
  try {
    const res = await fetch('assets/modelos/manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = await res.json();
    models.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'pt-BR'));
    modelButtons.innerHTML = '';
    for (const m of models) {
      const btn = document.createElement('button');
      btn.className = 'seg-btn';
      btn.textContent = m.name || m.id || 'Modelo';
      btn.dataset.url = m.url;
      if (m.id) btn.dataset.id = m.id;
      btn.setAttribute('aria-pressed', 'false');
      modelButtons.appendChild(btn);
    }
    const preferred = Array.from(modelButtons.querySelectorAll('button'))
      .find((b) => (b.dataset.id || '').toLowerCase() === 'esportivo');
    const toClick = preferred || modelButtons.querySelector('button');
    if (toClick) toClick.click();
  } catch (err) {
    console.warn('Falha ao carregar manifest de modelos:', err);
  }
}
populateModels();

// ---------- REGIÕES DE LOGO ----------
async function populateLogoRegions(modelId) {
  const container = document.getElementById('logoRegions');
  if (!container) return;
  container.innerHTML = '';
  try {
    const mapping = await loadMappingForModelId(modelId);
    const idx = indexMapping(mapping);
    const logoName = idx.detectedMaterials.logo;
    const logoEntry = idx.byMaterialName.get(logoName);
    const meshes = logoEntry?.meshes || [];
    if (!meshes.length) {
      const p = document.createElement('p');
      p.className = 'logo-image-empty';
      p.textContent = 'Nenhuma região carregada.';
      container.appendChild(p);
      return;
    }
    for (const mesh of meshes) {
      const item = document.createElement('div');
      item.className = 'logo-assignment-item';
      const label = document.createElement('label');
      label.className = 'logo-assignment-label';
      label.textContent = mesh.name || 'Região';
      const select = document.createElement('select');
      select.className = 'logo-assignment-select';
      select.dataset.meshName = mesh.name || '';
      const optNone = document.createElement('option');
      optNone.value = '';
      optNone.textContent = '— Nenhuma —';
      select.appendChild(optNone);
      item.appendChild(label);
      item.appendChild(select);
      container.appendChild(item);
    }
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'logo-image-empty';
    p.textContent = 'Falha ao carregar regiões.';
    container.appendChild(p);
  }
}

// ---------- CONFIGURAÇÃO DE MODELO E UI ----------
async function setupMappingAndUI(modelId) {
  const mapping = await loadMappingForModelId(modelId);
  mappingIndex = indexMapping(mapping);

  const names = mappingIndex.detectedMaterials || {};
  originalColorMap = buildOriginalColorsMap(currentModel, names);

  capaMaterialUuids = new Set();
  linhaMaterialUuids = new Set();
  const colorInitUuids = new Set();
  const isBakeLike = (tex) => {
    if (!tex) return false;
    const s = `${tex.name || ''} ${tex?.image?.src || ''}`.toLowerCase();
    return s.includes('bake') || s.includes('esportivo') || s.includes('esport');
  };
  currentModel.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m || !m.name) continue;
      const isCapa = names.capa && m.name === names.capa;
      const isLinha = names.linha && m.name === names.linha;
      if (isCapa) {
        capaMaterialUuids.add(m.uuid);
        if (m.map) {
          attachHueShift(m);
        } else {
          colorInitUuids.add(m.uuid);
        }
      }
      if (isLinha) {
        linhaMaterialUuids.add(m.uuid);
        if (m.map) {
          attachHueShift(m);
        } else {
          colorInitUuids.add(m.uuid);
        }
      }
      if (currentModelId === 'esportivo' && isBakeLike(m.map)) {
        attachHueShift(m);
        capaMaterialUuids.add(m.uuid);
      }
    }
  });

  await populateLogoRegions(modelId);
  wireImageUploadAndSelections();
  wireSwatchHandlers();
  applyEnvToMaterials();
  await scaleModelToScenario(currentModel, modelId).catch((e)=>console.warn('Scale model failed:', e));
  await placeModelOnGround(currentModel).catch((e)=>console.warn('Ground placement failed:', e));
  setControlsTargetToModel(currentModel);
  setControlsDistanceLimitsForModel(currentModel);
  setDefaultCameraOrbitForModel(currentModel);
}

// ---------- HANDLERS DE CORES ----------
function wireSwatchHandlers() {
  const wire = (rowId, groupKey) => {
    const row = document.getElementById(rowId);
    if (!row) return;
    if (row.dataset.wired === '1') return;
    row.dataset.wired = '1';
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-hex]');
      if (!btn) return;
      const hex = btn.dataset.hex;
      row.querySelectorAll('button').forEach((b) => {
        const active = b === btn;
        b.setAttribute('aria-pressed', String(active));
        b.classList.toggle('active', active);
      });
      applyColorChoice(groupKey, hex);
    });
  };
  wire('capaColorSwatches', 'capa');
  wire('lineColorSwatches', 'linhas');
}

function applyColorChoice(groupKey, hex) {
  if (!currentModel || !originalColorMap) return;
  const hexLc = hex.toLowerCase();
  const cfg = SWATCH_CONFIG[hexLc] || { sat: 1.0, val: 1.0 };

  const baseHSL = { h: 0, s: 0, l: 0 };
  STANDARD_INITIAL_COLOR.getHSL(baseHSL);
  const target = new THREE.Color(hexLc);
  const targetHSL = { h: 0, s: 0, l: 0 };
  target.getHSL(targetHSL);
  const deltaDeg = (targetHSL.h - baseHSL.h) * 360;

  const uuids = groupKey === 'capa' ? capaMaterialUuids : linhaMaterialUuids;
  const rotationMap = new Map();
  const extraHue = (groupKey === 'capa' ? (cfg.hue || 0) : 0);
  uuids.forEach((u) => rotationMap.set(u, deltaDeg + extraHue));
  const targetLinear = target.clone();
  if (targetLinear.convertSRGBToLinear) targetLinear.convertSRGBToLinear();
  applyHueRotation(currentModel, rotationMap, originalColorMap, { sat: cfg.sat, val: cfg.val, mix: cfg.mix ?? 0.0, target: targetLinear });
  applyDirectColor(uuids, target);
  requestRender();
}

function applyDirectColor(uuids, color) {
  currentModel.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (uuids.has(m.uuid) && m.color) {
        if (m.userData && m.userData.hueShift) continue;
        m.color.copy(color);
        m.needsUpdate = true;
      }
    }
  });
}

// ---------- UPLOAD E SELEÇÃO DE IMAGENS ----------
function wireImageUploadAndSelections() {
  const input = document.getElementById('pngUpload');
  const list = document.getElementById('logoImageList');
  const regions = document.getElementById('logoRegions');
  if (!input || !list || !regions) return;
  if (input.dataset.wired === '1') {
    const refreshRegionOptions = () => {
      const items = imagePool.list();
      regions.querySelectorAll('select.logo-assignment-select').forEach((sel) => {
        const prev = sel.value;
        sel.innerHTML = '';
        const optNone = document.createElement('option');
        optNone.value = '';
        optNone.textContent = '— Nenhuma —';
        sel.appendChild(optNone);
        for (const it of items) {
          const opt = document.createElement('option');
          opt.value = it.id;
          opt.textContent = it.name;
          sel.appendChild(opt);
        }
        sel.value = prev;
      });
    };
    refreshRegionOptions();
    return;
  }
  input.dataset.wired = '1';

  function refreshImageList() {
    list.innerHTML = '';
    const items = imagePool.list();
    const status = document.getElementById('pngUploadStatus');
  if (!items.length) {
      if (status) status.textContent = 'Nenhum arquivo selecionado';
      const p = document.createElement('p');
      p.className = 'logo-image-empty';
      p.textContent = 'Nenhuma imagem carregada.';
      list.appendChild(p);
      return;
    }
    if (status) status.textContent = `${items.length} imagem(ns) carregada(s)`;
    requestRender();
    for (const it of items) {
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = it.name;
      img.style.width = '100%';
      img.style.aspectRatio = '1/1';
      img.style.objectFit = 'contain';
      img.title = it.name;
      list.appendChild(img);
    }
  }

  function refreshRegionOptions() {
    const items = imagePool.list();
    regions.querySelectorAll('select.logo-assignment-select').forEach((sel) => {
      const prev = sel.value;
      sel.innerHTML = '';
      const optNone = document.createElement('option');
      optNone.value = '';
      optNone.textContent = '— Nenhuma —';
      sel.appendChild(optNone);
      for (const it of items) {
        const opt = document.createElement('option');
        opt.value = it.id;
        opt.textContent = it.name;
        sel.appendChild(opt);
      }
      sel.value = prev;
    });
  }

  input.onchange = async () => {
    const files = Array.from(input.files || []);
    for (const f of files) await imagePool.addFile(f);
    refreshImageList();
    refreshRegionOptions();
    input.value = '';
    requestRender();
  };

  regions.addEventListener('change', (e) => {
    const sel = e.target.closest('select.logo-assignment-select');
    if (!sel) return;
    const meshName = sel.dataset.meshName;
    const imageId = sel.value || null;
    applyRegionAssignment(meshName, imageId).then(() => requestRender()).catch((err) => console.warn('Falha ao aplicar logo:', err));
  });

  refreshImageList();
  refreshRegionOptions();
}

async function applyRegionAssignment(meshName, imageId) {
  if (!currentModel) return;
  const targets = [];
  currentModel.traverse((child) => {
    if (child.isMesh && child.name === meshName) targets.push(child);
  });
  if (!targets.length) return;
  if (!imageId) {
    for (const mesh of targets) {
      let material = mesh.material;
      if (!clonedMeshes.has(mesh.uuid)) {
        const cloned = material.clone();
        mesh.material = cloned;
        material = cloned;
        clonedMeshes.add(mesh.uuid);
      }
      material.map = null;
      material.needsUpdate = true;
    }
    return;
  }
  const item = imagePool.getById(imageId);
  if (!item) return;
  for (const mesh of targets) {
    await assignTextureToMesh(mesh, item.url, { cloneMaterial: true, clonedMeshes });
  }
}

// ---------- HDR ----------
async function populateHdrSelect() {
  const sel = document.getElementById('hdrSelect');
  if (!sel) return;
  sel.innerHTML = '';
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = '— Sem HDR —';
  sel.appendChild(optNone);
  try {
    const res = await fetch('assets/imagens/manifest.json');
    if (res.ok) {
      const items = await res.json();
      for (const it of items) {
        const url = typeof it === 'string' ? it : it.url || it.path || '';
        const name = typeof it === 'string' ? it.split('/').pop() : (it.name || url.split('/').pop());
        if (!url) continue;
        const o = document.createElement('option');
        o.value = url;
        o.textContent = name || url;
        sel.appendChild(o);
      }
    }
    if (sel.options.length === 1) {
      const dirRes = await fetch('assets/imagens/');
      if (dirRes.ok) {
        const text = await dirRes.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const links = Array.from(doc.querySelectorAll('a[href]'));
        const hdrs = links
          .map((a) => a.getAttribute('href'))
          .filter((h) => h && (h.endsWith('.hdr') || h.endsWith('.HDR')));
        const base = 'assets/imagens/';
        for (const file of hdrs) {
          const url = file.startsWith('http') ? file : base + file.replace(/^\//, '');
          const name = url.split('/').pop();
          const o = document.createElement('option');
          o.value = url;
          o.textContent = name;
          sel.appendChild(o);
        }
      }
    }
  } catch (e) {
    console.warn('HDR manifest ausente ou inválido');
  }
  if (!envAutoLoaded) {
    const sel = document.getElementById('hdrSelect');
    if (sel) {
      for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value.endsWith('simple_studio.hdr')) {
          sel.value = sel.options[i].value;
          envAutoLoaded = true;
          await loadHDR(sel.value);
          break;
        }
      }
    }
  }
}

async function loadHDR(url) {
  if (currentEnv.envRT) currentEnv.envRT.dispose();
  if (currentEnv.srcTex) currentEnv.srcTex.dispose();
  currentEnv = { url: null, envMap: null, srcTex: null, envRT: null };
  if (!url) {
    scene.environment = null;
    if (!envBackground) scene.background = null;
    applyEnvToMaterials();
    return;
  }
  viewport.setAttribute('aria-busy', 'true');
  viewport.dataset.busy = 'Carregando HDR…';
  try {
    const tex = await rgbeLoader.loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const envRT = pmremGen.fromEquirectangular(tex);
    const envMap = envRT.texture;
    currentEnv = { url, envMap, srcTex: tex, envRT };
    scene.environment = envMap;
    if (envBackground) scene.background = tex;
    applyEnvToMaterials();
  } catch (e) {
    console.warn('Falha ao carregar HDR', e);
  } finally {
    viewport.removeAttribute('aria-busy');
    delete viewport.dataset.busy;
  }
}

function applyEnvToMaterials() {
  if (!currentModel) return;
  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m || !('envMapIntensity' in m)) continue;
      m.envMapIntensity = envIntensity;
      m.needsUpdate = true;
    }
  });
  renderer.toneMappingExposure = envExposure;
}

function wireHdrControls() {
  const sel = document.getElementById('hdrSelect');
  const bg = document.getElementById('hdrBackgroundToggle');
  const inten = document.getElementById('envIntensity');
  const intenVal = document.getElementById('envIntensityValue');
  const expo = document.getElementById('envExposure');
  const expoVal = document.getElementById('envExposureValue');
  if (!sel || !bg || !inten || !expo) return;
  sel.addEventListener('change', () => loadHDR(sel.value));
  sel.addEventListener('change', () => requestRender());
  bg.addEventListener('change', () => {
    envBackground = bg.checked;
    if (envBackground) scene.background = currentEnv.srcTex || null;
    else scene.background = null;
    requestRender();
  });
  inten.addEventListener('input', () => {
    envIntensity = parseFloat(inten.value);
    intenVal.textContent = envIntensity.toFixed(1);
    applyEnvToMaterials();
    requestRender();
  });
  expo.addEventListener('input', () => {
    envExposure = parseFloat(expo.value);
    expoVal.textContent = envExposure.toFixed(2);
    applyEnvToMaterials();
    requestRender();
  });
}

populateHdrSelect();
wireHdrControls();

// ---------- CONTROLES DE LUZ ----------
function wireLightControls() {
  const amb = document.getElementById('ambientIntensity');
  const ambVal = document.getElementById('ambientIntensityValue');
  const dir = document.getElementById('dirIntensity');
  const dirVal = document.getElementById('dirIntensityValue');
  const ambToggle = document.getElementById('ambientToggle');
  const dirToggle = document.getElementById('dirToggle');
  if (amb) {
    amb.value = String(ambientLight.intensity);
    ambVal && (ambVal.textContent = Number(amb.value).toFixed(1));
    amb.addEventListener('input', () => {
      ambientLight.intensity = parseFloat(amb.value);
      if (ambVal) ambVal.textContent = ambientLight.intensity.toFixed(1);
    });
  }
  if (ambToggle) {
    ambToggle.checked = ambientLight.visible;
    ambToggle.addEventListener('change', () => {
      ambientLight.visible = ambToggle.checked;
    });
  }
  if (dir) {
    dir.value = String(dirLight.intensity);
    dirVal && (dirVal.textContent = Number(dir.value).toFixed(1));
    dir.addEventListener('input', () => {
      dirLight.intensity = parseFloat(dir.value);
      if (dirVal) dirVal.textContent = dirLight.intensity.toFixed(1);
    });
  }
  if (dirToggle) {
    dirToggle.checked = dirLight.visible;
    dirToggle.addEventListener('change', () => {
      dirLight.visible = dirToggle.checked;
    });
  }
}
wireLightControls();

async function loadScenario() {
  if (scenarioRoot) return scenarioRoot;
  viewport.setAttribute('aria-busy', 'true');
  viewport.dataset.busy = 'Carregando cenário…';
  try {
    const gltf = await loadGLB(SCENARIO_URL);
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error('Cenário GLTF sem cena válida');
    scenarioRoot = root;
    scenarioRoot.visible = true;
    scene.add(scenarioRoot);
    requestRender();
    return scenarioRoot;
  } catch (e) {
    console.warn('Falha ao carregar cenário:', e);
    return null;
  } finally {
    viewport.removeAttribute('aria-busy');
    delete viewport.dataset.busy;
  }
}

loadScenario();

// ---------- ESCALA E POSICIONAMENTO DE MODELOS ----------
async function scaleModelToScenario(model, modelId) {
  if (!model) return;
  if (!scenarioRoot) await loadScenario();
  if (!scenarioRoot) return;
  const root = scenarioRoot;
  const sBox = new THREE.Box3().setFromObject(root);
  const sSize = sBox.getSize(new THREE.Vector3());
  const refLen = Math.max(sSize.x, sSize.z);
  if (!isFinite(refLen) || refLen <= 0) return;

  const mBox = new THREE.Box3().setFromObject(model);
  const mSize = mBox.getSize(new THREE.Vector3());
  const mLen = Math.max(mSize.x, mSize.z, mSize.y);
  if (!isFinite(mLen) || mLen <= 0) return;

  const cat = MODEL_CATEGORY[modelId] || 'medium';
  const ratio = CATEGORY_TARGET_RATIO[cat] || CATEGORY_TARGET_RATIO.medium;
  const targetLen = refLen * ratio;
  const scale = targetLen / mLen;
  if (isFinite(scale) && scale > 0) {
    model.scale.setScalar(scale);
  }
}

async function placeModelOnGround(model) {
  if (!model) return;
  if (!scenarioRoot) await loadScenario();
  if (!scenarioRoot) return;
  
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  scenarioRoot.updateMatrixWorld(true);
  
  const mBox = new THREE.Box3().setFromObject(model);
  const mSize = mBox.getSize(new THREE.Vector3());
  const mCenter = mBox.getCenter(new THREE.Vector3());
  
  const scenarioBox = new THREE.Box3().setFromObject(scenarioRoot);
  const scenarioCenter = scenarioBox.getCenter(new THREE.Vector3());
  const scenarioSize = scenarioBox.getSize(new THREE.Vector3());
  
  model.position.x = scenarioCenter.x - mCenter.x;
  model.position.z = scenarioCenter.z - mCenter.z;
  model.updateMatrixWorld(true);
  
  mBox.setFromObject(model);
  const newMinY = mBox.min.y;
  const newCenter = mBox.getCenter(new THREE.Vector3());
  
  const ray = new THREE.Raycaster();
  const startHeight = scenarioBox.max.y + 20;
  
  const sampleCount = 5;
  const xs = [];
  const zs = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = i / (sampleCount - 1);
    xs.push(newCenter.x + (mSize.x * 0.5) * (t * 2 - 1));
    zs.push(newCenter.z + (mSize.z * 0.5) * (t * 2 - 1));
  }
  
  let groundY = Infinity;
  let hitCount = 0;
  const scenarioMidY = (scenarioBox.min.y + scenarioBox.max.y) * 0.5;
  const validHits = [];
  
  for (const x of xs) {
    for (const z of zs) {
      const origin = new THREE.Vector3(x, startHeight, z);
      ray.set(origin, new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObject(scenarioRoot, true);
      
      if (hits && hits.length > 0) {
        hitCount++;
        for (const hit of hits) {
          if (hit.point && hit.point.y <= scenarioMidY) {
            validHits.push(hit.point.y);
            if (hit.point.y < groundY) {
              groundY = hit.point.y;
            }
          }
        }
      }
    }
  }
  
  if (validHits.length === 0) {
    groundY = scenarioBox.min.y;
    
    if (!isFinite(groundY)) {
      groundY = scenarioBox.min.y + scenarioSize.y * 0.1;
    }
  }
  
  const clearance = Math.max(0.03, mSize.y * 0.03);
  const targetBottomY = groundY + clearance;
  
  const deltaY = targetBottomY - newMinY;
  
  if (isFinite(deltaY)) {
    model.position.y += deltaY;
    model.updateMatrixWorld(true);
  } else {
    console.warn('placeModelOnGround: Could not calculate valid deltaY', {
      groundY,
      newMinY,
      targetBottomY,
      deltaY
    });
  }
}

// ---------- CONFIGURAÇÃO DE CÂMERA PARA MODELO ----------
function setControlsTargetToModel(model) {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const targetY = box.min.y + size.y * 0.4;
  controls.target.set(center.x, targetY, center.z);
  controls.update();
}

function setControlsDistanceLimitsForModel(model) {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(0.001, sphere.radius);
  const minD = r * 1.50;
  const maxD = r * 1.70;
  controls.minDistance = minD;
  controls.maxDistance = maxD;
  const toCam = new THREE.Vector3().subVectors(camera.position, controls.target);
  let dist = toCam.length();
  if (!isFinite(dist) || dist === 0) dist = maxD;
  const clamped = THREE.MathUtils.clamp(dist, minD, maxD);
  toCam.setLength(clamped);
  camera.position.copy(controls.target).add(toCam);
  camera.updateProjectionMatrix();
  controls.update();
}

function setDefaultCameraOrbitForModel(model) {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(0.001, sphere.radius);
  const polar = THREE.MathUtils.degToRad(50);
  const azim  = THREE.MathUtils.degToRad(-35);
  const minD = controls.minDistance || r * 1.2;
  const maxD = controls.maxDistance || r * 2.0;
  const d = THREE.MathUtils.clamp(r * 1.6, minD, maxD);
  const sinP = Math.sin(polar);
  const offset = new THREE.Vector3(
    d * sinP * Math.cos(azim),
    d * Math.cos(polar),
    d * sinP * Math.sin(azim)
  );
  camera.position.copy(controls.target).add(offset);
  camera.lookAt(controls.target);
  camera.updateProjectionMatrix();
  controls.update();
}

// ---------- API PÚBLICA ----------
window.MZPrime = {
  loadModel,
  scene,
  camera,
  renderer,
  loadMapping: async (id) => (await import('./lib/mappings.js')).loadMappingForModelId(id),
  indexMapping: async (mapping) => (await import('./lib/mappings.js')).indexMapping(mapping),
  listMaterials: async (mapping) => (await import('./lib/mappings.js')).listMaterials(mapping),
  appearance: async () => await import('./lib/appearance.js'),
  applyColorChoice: (group, hex) => applyColorChoice(group, hex),
};

requestRender();
