// Lightweight GLB loader with progress + DRACO support
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const loadingManager = new THREE.LoadingManager();

const gltfLoader = new GLTFLoader(loadingManager);
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
gltfLoader.setDRACOLoader(draco);

export function loadGLB(url, onProgress) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => resolve(gltf),
      (evt) => {
        if (!onProgress) return;
        if (evt && evt.lengthComputable && evt.total > 0) {
          const pct = Math.round((evt.loaded / evt.total) * 100);
          onProgress(pct);
        } else {
          onProgress(null);
        }
      },
      (err) => reject(err)
    );
  });
}

export function disposeObject(obj) {
  obj.traverse?.((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    }
  });
}

