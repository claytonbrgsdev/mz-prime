import * as THREE from 'three';
// Camera controls/post-processing removed to keep camera config zeroed
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
// Adaptive pixel ratio for smoother performance
const PR_MIN = 1.0, PR_MAX = Math.min(1.5, window.devicePixelRatio || 1.5);
let currentPR = PR_MAX;
renderer.setPixelRatio(currentPR);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.appendChild(renderer.domElement);

// Lights (controllable): Ambient + Directional
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(2, 3, 4);
scene.add(dirLight);

// Re-enable essential OrbitControls (no special camera presets)
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
// Limit vertical orbit: allow roughly from near-horizon (0°) up to ~75° above
controls.minPolarAngle = THREE.MathUtils.degToRad(15); // avoid perfect top-down
controls.maxPolarAngle = THREE.MathUtils.degToRad(90); // do not go below the car
// Auto-rotate (enabled by default, slightly faster)
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6; // gentle orbit speed

function resize() {
  const rect = viewport.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

window.addEventListener('resize', resize);
// Also observe container resizes (sidebar collapse, CSS changes, etc.)
if ('ResizeObserver' in window) {
  const ro = new ResizeObserver(() => resize());
  ro.observe(viewport);
}
resize();
// Render-on-demand loop with optional continuous animation
let animating = false;
let rafId = null;
let lastT = 0;
let smoothedDt = 16.7;
let renderScheduled = false;

function adaptPixelRatio(dt) {
  // Exponential moving average of frame time
  smoothedDt = smoothedDt * 0.9 + dt * 0.1;
  // If too slow, reduce pixel ratio; if fast, increase, within bounds
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
  else { if (controls.autoRotate) startLoop(); requestRender(); }
});

// GLB loading state
let currentModel = null;
let loadToken = 0;
let currentModelId = null;
let mappingIndex = null;
let originalColorMap = null; // Map<materialUuid, Color>
let capaMaterialUuids = new Set();
let linhaMaterialUuids = new Set();
const clonedMeshes = new Set();
const imagePool = new ImagePool(renderer);

// HDR environment state
const rgbeLoader = new RGBELoader();
const pmremGen = new THREE.PMREMGenerator(renderer);
let currentEnv = { url: null, envMap: null, srcTex: null, envRT: null };
let envIntensity = 1.0;
let envExposure = 1.0;
let envBackground = false;
let envAutoLoaded = false;

// Model scaling categories relative to scenario
const MODEL_CATEGORY = {
  bike: 'small', motoG: 'small', jetski: 'small', quadriciclo: 'small',
  fusca: 'medium', esportivo: 'medium', hatch: 'medium', sedan: 'medium', ford1929: 'medium', jeep: 'medium',
  kombi: 'large',
  caminhonete: 'xlarge', suv: 'xlarge',
};
const CATEGORY_TARGET_RATIO = { // target length as fraction of scenario reference length
  small: 0.22,
  medium: 0.30,
  large: 0.36,
  xlarge: 0.42,
};

// Swatch config (shader parameters for CAPA map-based materials)
const SWATCH_CONFIG = {
  '#962d28': { sat: 2.00, val: 0.00, hue: 55,  mix: 1.00 }, // vermelho (ajuste fino do screenshot)
  '#498551': { sat: 1.60, val: 1.00, hue: 87,  mix: 0.63 }, // verde
  '#2c41bd': { sat: 2.00, val: 1.76, hue: 34,  mix: 0.86 }, // azul royal (ajuste fino do screenshot)
  '#001f5b': { sat: 0.23, val: 0.00, hue: 34,  mix: 0.33 }, // azul marinho (ajuste fino do screenshot)
  '#615e60': { sat: 0.0,  val: 1.0,  hue: 0,   mix: 0.0  }, // cinza
  '#090909': { sat: 0.0,  val: 0.15, hue: 0,   mix: 0.0  }, // preto
};

// Scenario state
const SCENARIO_URL = 'assets/cenarios/white-room.glb';
let scenarioRoot = null; // THREE.Object3D
let scenarioLoaded = false;

export async function loadModel(url) {
  // Mark viewport busy for basic feedback
  viewport.setAttribute('aria-busy', 'true');
  const token = ++loadToken;
  viewport.dataset.busy = 'Carregando… 0%';
  try {
    const gltf = await loadGLB(url, (pct) => {
      viewport.dataset.busy = pct == null ? 'Carregando…' : `Carregando… ${pct}%`;
    });
    // If a newer request was made, discard this one (avoid race conditions)
    if (token !== loadToken) {
      if (gltf?.scene) disposeObject(gltf.scene);
      return;
    }
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error('GLTF sem cena válida.');

    // Replace current
    if (currentModel) {
      scene.remove(currentModel);
      disposeObject(currentModel);
    }

    currentModel = root;
    scene.add(currentModel);
    // Keep camera config zeroed; use a simple default
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

// Delegate clicks for any future buttons with data-url
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
    // Update pressed state and active class
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

// Build model buttons from a manifest, then auto-select the first
async function populateModels() {
  if (!modelButtons) return;
  try {
    const res = await fetch('assets/modelos/manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    /** @type {{id:string,name:string,url:string}[]} */
    const models = await res.json();
    // Ordena alfabeticamente por nome (pt-BR)
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
    // Seleciona Esportivo por padrão; se não existir, cai no primeiro
    const preferred = Array.from(modelButtons.querySelectorAll('button'))
      .find((b) => (b.dataset.id || '').toLowerCase() === 'esportivo');
    const toClick = preferred || modelButtons.querySelector('button');
    if (toClick) toClick.click();
  } catch (err) {
    console.warn('Falha ao carregar manifest de modelos:', err);
  }
}
populateModels();

// Build dynamic logo regions UI from mapping for the selected model
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
    // Build a select per mesh region (no image options yet)
    for (const mesh of meshes) {
      const item = document.createElement('div');
      item.className = 'logo-assignment-item';
      const label = document.createElement('label');
      label.className = 'logo-assignment-label';
      label.textContent = mesh.name || 'Região';
      const select = document.createElement('select');
      select.className = 'logo-assignment-select';
      // Use mesh name as identifier; UUIDs are not stable between sessions
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

// After a model is loaded, prepare mapping info, base colors and wire UI hooks
async function setupMappingAndUI(modelId) {
  // 1) Load mapping and store indices
  const mapping = await loadMappingForModelId(modelId);
  mappingIndex = indexMapping(mapping);

  // 2) Build color base map for hue rotation
  const names = mappingIndex.detectedMaterials || {};
  originalColorMap = buildOriginalColorsMap(currentModel, names);

  // 3) Collect uuid lists for capa/linha, and attach hue-shift shader when using texture maps (e.g., esportivo)
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
      // Esportivo: ensure bake texture also hue-rotates as CAPA
      if (currentModelId === 'esportivo' && isBakeLike(m.map)) {
        attachHueShift(m);
        capaMaterialUuids.add(m.uuid);
      }
    }
  });

  // 3.1) Do not alter original materials on load; keep model's default bake/colors

  // 4) Populate regions UI and wire image upload + selects
  await populateLogoRegions(modelId);
  wireImageUploadAndSelections();
  wireSwatchHandlers();
  // ensure env intensity is applied to this model materials
  applyEnvToMaterials();
  // 5) Scale model relative to scenario
  await scaleModelToScenario(currentModel, modelId).catch((e)=>console.warn('Scale model failed:', e));
  await placeModelOnGround(currentModel).catch((e)=>console.warn('Ground placement failed:', e));
  setControlsTargetToModel(currentModel);
  setControlsDistanceLimitsForModel(currentModel);
  setDefaultCameraOrbitForModel(currentModel);
  // Do not apply any color presets on load; user will choose swatches
}

// Map swatch hex -> behavior: either rotation (colored) or neutral (set S=0)
function wireSwatchHandlers() {
  const wire = (rowId, groupKey) => {
    const row = document.getElementById(rowId);
    if (!row) return;
    if (row.dataset.wired === '1') return; // avoid duplicate handlers
    row.dataset.wired = '1';
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-hex]');
      if (!btn) return;
      const hex = btn.dataset.hex;
      // Toggle UI state
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
  // Shader-driven materials (map) will use hue+sat+val; others will get color set directly after
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

// Image upload + populate region selects + assign textures on change
function wireImageUploadAndSelections() {
  const input = document.getElementById('pngUpload');
  const list = document.getElementById('logoImageList');
  const regions = document.getElementById('logoRegions');
  if (!input || !list || !regions) return;
  if (input.dataset.wired === '1') {
    // Still refresh options for newly created selects
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
      // Keep first option (Nenhuma)
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

  // Assign texture when user picks an image for a region
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
  // Find all meshes with the given name (some models may have duplicates per side)
  const targets = [];
  currentModel.traverse((child) => {
    if (child.isMesh && child.name === meshName) targets.push(child);
  });
  if (!targets.length) return;
  if (!imageId) {
    // Clear texture on all matching meshes
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

// ---------- HDR ENVIRONMENT ----------
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
        // Accept either {name,url} or string path
        const url = typeof it === 'string' ? it : it.url || it.path || '';
        const name = typeof it === 'string' ? it.split('/').pop() : (it.name || url.split('/').pop());
        if (!url) continue;
        const o = document.createElement('option');
        o.value = url;
        o.textContent = name || url;
        sel.appendChild(o);
      }
    }
    // Fallback: if no HDRs from manifest, try directory listing
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
  // Auto-select and load default HDR once
  const def = 'assets/imagens/msichll.hdr';
  if (!envAutoLoaded) {
    const sel = document.getElementById('hdrSelect');
    if (sel) {
      for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value.endsWith('msichll.hdr')) {
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
  // cleanup existing
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

// ---------- LIGHT CONTROLS ----------
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

// ---------- SCENARIO (optional) ----------
async function ensureScenarioLoaded() {
  if (scenarioLoaded && scenarioRoot) return scenarioRoot;
  viewport.setAttribute('aria-busy', 'true');
  viewport.dataset.busy = 'Carregando cenário…';
  try {
    const gltf = await loadGLB(SCENARIO_URL);
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error('Cenário GLB sem cena válida');
    scenarioRoot = root;
    scenarioRoot.visible = false;
    scene.add(scenarioRoot);
    scenarioLoaded = true;
    return scenarioRoot;
  } finally {
    viewport.removeAttribute('aria-busy');
    delete viewport.dataset.busy;
  }
}

async function setScenarioEnabled(enabled) {
  if (!enabled) {
    if (scenarioRoot) scenarioRoot.visible = false;
    return;
  }
  const root = await ensureScenarioLoaded();
  root.visible = true;
}

function wireScenarioToggle() {
  const t = document.getElementById('scenarioToggle');
  if (!t) return;
  t.checked = false; // default off
  t.addEventListener('change', () => setScenarioEnabled(t.checked));
}
wireScenarioToggle();

async function scaleModelToScenario(model, modelId) {
  if (!model) return;
  const root = await ensureScenarioLoaded();
  // Compute reference length from scenario (use max of X/Z)
  const sBox = new THREE.Box3().setFromObject(root);
  const sSize = sBox.getSize(new THREE.Vector3());
  const refLen = Math.max(sSize.x, sSize.z);
  if (!isFinite(refLen) || refLen <= 0) return;

  // Model current size
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
  const root = await ensureScenarioLoaded();
  // Update matrices
  model.updateWorldMatrix(true, true);
  root.updateWorldMatrix(true, true);
  // Compute model footprint
  const mBox = new THREE.Box3().setFromObject(model);
  const mSize = mBox.getSize(new THREE.Vector3());
  const minY = mBox.min.y;
  const originY = minY + Math.max(0.05, mSize.y * 0.05); // a bit above the bottom of model
  const xs = [mBox.min.x, (mBox.min.x + mBox.max.x) * 0.5, mBox.max.x];
  const zs = [mBox.min.z, (mBox.min.z + mBox.max.z) * 0.5, mBox.max.z];
  const ray = new THREE.Raycaster();
  let groundY = -Infinity;
  for (const x of xs) {
    for (const z of zs) {
      const origin = new THREE.Vector3(x, originY, z);
      ray.set(origin, new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObject(scenarioRoot, true);
      if (hits && hits.length) {
        // take the first hit below origin; prefer highest y
        for (const h of hits) {
          if (h.point && h.point.y <= originY) {
            if (h.point.y > groundY) groundY = h.point.y;
            break;
          }
        }
      }
    }
  }
  if (!isFinite(groundY) || groundY === -Infinity) {
    // Fallback to scenario bbox min (top may be slightly above; we add small epsilon)
    const sBox = new THREE.Box3().setFromObject(scenarioRoot);
    groundY = sBox.min.y + 0.01;
  }
  const clearance = Math.max(0.005, mSize.y * 0.01);
  const deltaY = (groundY + clearance) - minY;
  if (isFinite(deltaY)) {
    model.position.y += deltaY;
    model.updateMatrixWorld();
  }
}

function setControlsTargetToModel(model) {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Aim roughly at 40% of the height to feel natural and constrain polar limits properly
  const targetY = box.min.y + size.y * 0.4;
  controls.target.set(center.x, targetY, center.z);
  controls.update();
}

function setControlsDistanceLimitsForModel(model) {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(0.001, sphere.radius);
  // Choose limits relative to model size
  const minD = r * 1.20; // afasta o limite de zoom-in
  const maxD = r * 2.00; // reduz um pouco o zoom-out máximo
  controls.minDistance = minD;
  controls.maxDistance = maxD;
  // Clamp current distance to the new range
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
  // Choose a pleasant diagonal view
  const polar = THREE.MathUtils.degToRad(50);   // tilt down ~50°
  const azim  = THREE.MathUtils.degToRad(-35);  // rotate around target ~-35°
  // Use mid distance inside limits
  const minD = controls.minDistance || r * 1.2;
  const maxD = controls.maxDistance || r * 2.0;
  const d = THREE.MathUtils.clamp(r * 1.6, minD, maxD);
  // Convert spherical to Cartesian offset (Y is up)
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

// ---------- Auto-rotate wiring ----------
function wireAutoRotate() {
  const btn = document.getElementById('toggleAutoRotateBtn');
  if (!btn) return;
  const apply = (enabled) => {
    controls.autoRotate = !!enabled;
    btn.setAttribute('aria-pressed', String(!!enabled));
    btn.textContent = enabled ? 'Parar rotação' : 'Girar câmera';
  };
  // initialize state from current controls
  apply(controls.autoRotate);
  btn.addEventListener('click', () => {
    apply(!controls.autoRotate);
    if (controls.autoRotate) startLoop(); else stopLoop();
  });
}
wireAutoRotate();

// (Removed) shader fine‑tune UI; presets from SWATCH_CONFIG are applied directly.

// Expose small API for manual testing in console
window.MZPrime = {
  loadModel,
  scene,
  camera,
  renderer,
  // Lazy helpers for upcoming logic; do not apply anything automatically
  loadMapping: async (id) => (await import('./lib/mappings.js')).loadMappingForModelId(id),
  indexMapping: async (mapping) => (await import('./lib/mappings.js')).indexMapping(mapping),
  listMaterials: async (mapping) => (await import('./lib/mappings.js')).listMaterials(mapping),
  appearance: async () => await import('./lib/appearance.js'),
  applyColorChoice: (group, hex) => applyColorChoice(group, hex),
};

// Start loop if autoRotate; otherwise render once
if (controls.autoRotate) startLoop(); else requestRender();
