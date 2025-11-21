import * as THREE from 'three';

// Cor base padrão usada para rotação de matiz (corresponde ao app de referência)
// Base atualizada para #626062 (hsl(300deg, 2%, 38%))
export const STANDARD_INITIAL_COLOR = new THREE.Color('#626062');

// Detecta nomes de materiais chave em uma cena com sobrescritas opcionais
// overrides: { logo?: string, capa?: string, linha?: string }
export function detectMaterialNames(root, overrides = {}) {
  const detected = { logo: undefined, capa: undefined, linha: undefined, ...overrides };
  if (detected.logo && detected.capa && detected.linha) return detected;

  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of materials) {
      if (!m || !m.name) continue;
      const n = m.name.toLowerCase();
      if (!detected.logo && n.includes('logo')) detected.logo = m.name;
      if (!detected.capa && (n.includes('capa') || n.includes('cover') || n.includes('body'))) detected.capa = m.name;
      if (!detected.linha && (n.includes('linha') || n.includes('line') || n.includes('stripe'))) detected.linha = m.name;
    }
  });

  return detected;
}

// Constrói um mapa de cores originais para rotação de matiz. Para materiais capa/linha,
// usa a cor base padrão; para outros, usa sua cor atual.
export function buildOriginalColorsMap(root, names = {}) {
  const map = new Map(); // material.uuid -> THREE.Color
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of materials) {
      if (!m || !m.color) continue;
      const isCapa = names.capa && m.name === names.capa;
      const isLinha = names.linha && m.name === names.linha;
      map.set(m.uuid, (isCapa || isLinha) ? STANDARD_INITIAL_COLOR.clone() : m.color.clone());
    }
  });
  return map;
}

// Aplica rotação de matiz (em graus) a materiais indexados por UUID, usando um mapa de cores base
// rotationMap: Map<materialUuid, degrees>
export function applyHueRotation(root, rotationMap, baseColorMap, options = {}) {
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of materials) {
      if (!m || !m.color) continue;
      const deg = rotationMap.get(m.uuid);
      if (deg === undefined) continue;
      // Se o material tem shader hueShift, controla seus uniforms ao invés
      if (m.userData && m.userData.hueShift) {
        if (m.userData.hueShift.uniform) {
          // Inverte o sinal para corresponder à direção de rotação visual observada na base YIQ
          m.userData.hueShift.uniform.value = -deg * Math.PI / 180.0; // radianos
        }
        if (m.userData.hueShift.sat) m.userData.hueShift.sat.value = (typeof options.sat === 'number' ? options.sat : 1.0);
        if (m.userData.hueShift.val) m.userData.hueShift.val.value = (typeof options.val === 'number' ? options.val : 1.0);
        if (m.userData.hueShift.mix) m.userData.hueShift.mix.value = (typeof options.mix === 'number' ? options.mix : 0.0);
        if (m.userData.hueShift.target && options.target) {
          const t = options.target; // THREE.Color em espaço linear ou array
          if (t.isColor) m.userData.hueShift.target.value.copy(t);
          else if (Array.isArray(t)) m.userData.hueShift.target.value.set(t[0], t[1], t[2]);
        }
        m.needsUpdate = true;
        continue;
      }
      const base = baseColorMap.get(m.uuid);
      if (!base) continue;
      const hsl = { h: 0, s: 0, l: 0 };
      base.getHSL(hsl);
      m.color.setHSL((hsl.h + (deg / 360)) % 1, hsl.s, hsl.l);
      m.needsUpdate = true;
    }
  });
}

// Atribui uma textura a uma instância de mesh específica. Opcionalmente clona o material da mesh
// para que outras meshes compartilhando o mesmo material não sejam afetadas.
// Retorna uma Promise que resolve com a THREE.Texture atribuída.
export function assignTextureToMesh(mesh, imageUrl, opts = {}) {
  const { textureLoader = new THREE.TextureLoader(), cloneMaterial = true, clonedMeshes = new Set() } = opts;
  return new Promise((resolve, reject) => {
    if (!mesh || !mesh.isMesh) return reject(new Error('assignTextureToMesh: mesh inválido'));
    let material = mesh.material;
    if (cloneMaterial && !clonedMeshes.has(mesh.uuid)) {
      const cloned = material.clone();
      mesh.material = cloned;
      material = cloned;
      clonedMeshes.add(mesh.uuid);
    }

    textureLoader.load(
      imageUrl,
      (tex) => {
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        // Normalizar para quadrado (contain sem distorcer) quando não for 1:1
        try {
          const img = tex.image;
          if (img && img.width && img.height && img.width !== img.height) {
            const side = Math.max(img.width, img.height); // manter máxima resolução possível
            const canvas = document.createElement('canvas');
            canvas.width = side;
            canvas.height = side;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.clearRect(0, 0, side, side);
              const scale = Math.min(side / img.width, side / img.height);
              const drawW = Math.round(img.width * scale);
              const drawH = Math.round(img.height * scale);
              const dx = Math.floor((side - drawW) / 2);
              const dy = Math.floor((side - drawH) / 2);
              ctx.drawImage(img, dx, dy, drawW, drawH);
              const squareTex = new THREE.Texture(canvas);
              squareTex.flipY = false;
              squareTex.colorSpace = THREE.SRGBColorSpace;
              squareTex.wrapS = THREE.ClampToEdgeWrapping;
              squareTex.wrapT = THREE.ClampToEdgeWrapping;
              squareTex.needsUpdate = true;
              material.map = squareTex;
            } else {
              material.map = tex;
            }
          } else {
            material.map = tex;
          }
        } catch (_) {
          material.map = tex;
        }
        material.transparent = true;
        material.alphaTest = Math.min(material.alphaTest ?? 0.001, 0.1);
        material.needsUpdate = true;
        resolve(tex);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

// Anexa um hook de shader de rotação de matiz a um material MeshStandard/Physical que tem um map
export function attachHueShift(material) {
  if (!material || !material.map || material.userData?.hueShift) return material;
  const uniform = { value: 0.0 };
  const sat = { value: 1.0 };
  const val = { value: 1.0 };
  const mix = { value: 0.0 };
  const target = { value: new THREE.Color(1,1,1) };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHue = uniform;
    shader.uniforms.uSat = sat;
    shader.uniforms.uVal = val;
    shader.uniforms.uMix = mix;
    shader.uniforms.uTarget = target;
    const fn = `
    vec3 hueRotate(vec3 color, float hue) {
      float cosH = cos(hue);
      float sinH = sin(hue);
      // Matriz de rotação baseada em YIQ para RGB
      const mat3 yiq = mat3(
        0.299,  0.587,  0.114,
        0.596, -0.274, -0.322,
        0.212, -0.523,  0.311
      );
      const mat3 i2r = mat3(
        1.0,  0.956,  0.621,
        1.0, -0.272, -0.647,
        1.0, -1.106,  1.703
      );
      vec3 yiqC = yiq * color;
      float Y = yiqC.x;
      float I = yiqC.y;
      float Q = yiqC.z;
      float newI = I * cosH - Q * sinH;
      float newQ = I * sinH + Q * cosH;
      vec3 r = i2r * vec3(Y, newI, newQ);
      return clamp(r, 0.0, 1.0);
    }
    `;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nuniform float uHue;\nuniform float uSat;\nuniform float uVal;\nuniform float uMix;\nuniform vec3 uTarget;\n${fn}`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>\n#ifdef USE_MAP\n  vec3 c = hueRotate(diffuseColor.rgb, uHue);\n  float luma = dot(c, vec3(0.299, 0.587, 0.114));\n  c = mix(vec3(luma), c, uSat);\n  c *= uVal;\n  vec3 colorize = normalize(uTarget) * max(luma, 1e-4);\n  c = mix(c, colorize, clamp(uMix, 0.0, 1.0));\n  diffuseColor.rgb = clamp(c, 0.0, 1.0);\n#endif`
    );
    material.userData.hueShift = { uniform, sat, val, mix, target };
  };
  material.needsUpdate = true;
  return material;
}

// Utilitário: agrupa meshes por seu nome de material atual
export function groupMeshesByMaterialName(root) {
  const map = new Map(); // name -> Mesh[]
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of materials) {
      const name = m?.name || 'Unnamed Material';
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(child);
    }
  });
  return map;
}
