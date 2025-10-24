import * as THREE from 'three';

// Standard base color used for hue rotation (matches the reference app)
// Updated base to Azul #0033A0 as specified
export const STANDARD_INITIAL_COLOR = new THREE.Color('#0033A0');

// Detect key material names in a scene with optional overrides
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

// Build a map of original colors for hue rotation. For capa/linha materials,
// use the standard base color; for others, use their current color.
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

// Apply hue rotation (in degrees) to materials keyed by UUID, using a base color map
// rotationMap: Map<materialUuid, degrees>
export function applyHueRotation(root, rotationMap, baseColorMap) {
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of materials) {
      if (!m || !m.color) continue;
      const deg = rotationMap.get(m.uuid);
      if (deg === undefined) continue;
      // If material has hueShift shader, drive its uniform instead
      if (m.userData && m.userData.hueShift && m.userData.hueShift.uniform) {
        m.userData.hueShift.uniform.value = deg * Math.PI / 180.0; // radians
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

// Assign a texture to a specific mesh instance. Optionally clones the mesh's material
// so that other meshes sharing the same material are unaffected.
// Returns a Promise that resolves with the assigned THREE.Texture.
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
        material.map = tex;
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

// Attach a hue-rotation shader hook to a MeshStandard/Physical material that has a map
export function attachHueShift(material) {
  if (!material || !material.map || material.userData?.hueShift) return material;
  const uniform = { value: 0.0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHue = uniform;
    const fn = `
    vec3 hueRotate(vec3 color, float hue) {
      float cosH = cos(hue);
      float sinH = sin(hue);
      // YIQ-based rotation matrix for RGB
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
      `#include <common>\nuniform float uHue;\n${fn}`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>\n#ifdef USE_MAP\n  diffuseColor.rgb = hueRotate(diffuseColor.rgb, uHue);\n#endif`
    );
    material.userData.hueShift = { uniform };
  };
  material.needsUpdate = true;
  return material;
}

// Utility: group meshes by their current material name
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
