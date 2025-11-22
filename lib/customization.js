/**
 * API de Customização de Veículos - MZ Prime
 * 
 * Este módulo concentra a lógica de customização de veículos (capa, linhas, logos).
 * Projetado para integração com qualquer frontend, sem dependências de UI/DOM.
 * 
 * @module lib/customization
 */

import * as THREE from 'three';
import { loadGLB, disposeObject } from './assetLoader.js';
import { loadMappingForModelId, indexMapping } from './mappings.js';
import { ImagePool } from './textures.js';
import { buildOriginalColorsMap, applyHueRotation, assignTextureToMesh, STANDARD_INITIAL_COLOR, attachHueShift } from './appearance.js';

/**
 * Configuração de cores disponíveis com parâmetros de ajuste
 */
const SWATCH_CONFIG = {
  '#962d28': { sat: 2.00, val: 0.00, hue: 55,  mix: 1.00 },  // Vermelho
  '#498551': { sat: 1.20, val: 0.72, hue: 98,  mix: 0.74 },  // Verde musgo
  '#2c41bd': { sat: 2.00, val: 1.76, hue: 34,  mix: 0.86 },  // Azul royal
  '#001f5b': { sat: 0.23, val: 0.00, hue: 34,  mix: 0.33 },  // Azul marinho
  '#615e60': { sat: 0.0,  val: 1.0,  hue: 0,   mix: 0.0  },  // Cinza
  '#090909': { sat: 0.0,  val: 0.15, hue: 0,   mix: 0.0  },  // Preto
};

/**
 * Classe principal para gerenciar customização de veículos
 */
export class VehicleCustomization {
  /**
   * @param {THREE.Scene} scene - Cena Three.js onde os modelos serão adicionados
   * @param {THREE.WebGLRenderer} renderer - Renderer Three.js (necessário para ImagePool)
   * @param {Function} onRenderRequest - Callback opcional chamado quando uma renderização é necessária
   */
  constructor(scene, renderer, onRenderRequest = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.onRenderRequest = onRenderRequest || (() => {});

    // Estado interno
    this.currentModel = null;
    this.currentModelId = null;
    this.loadToken = 0;
    this.mappingIndex = null;
    this.originalColorMap = null;
    this.capaMaterialUuids = new Set();
    this.linhaMaterialUuids = new Set();
    this.clonedMeshes = new Set();
    this.imagePool = new ImagePool(renderer);
  }

  /**
   * Lista os modelos disponíveis no manifest
   * @param {string} manifestUrl - URL do manifest JSON (padrão: 'assets/modelos/manifest.json')
   * @returns {Promise<Array<{id: string, name: string, url: string}>>}
   */
  async listAvailableModels(manifestUrl = 'assets/modelos/manifest.json') {
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const models = await res.json();
      return models.sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '', 'pt-BR'));
    } catch (err) {
      console.warn('Falha ao carregar manifest de modelos:', err);
      return [];
    }
  }

  /**
   * Carrega um modelo de veículo na cena
   * @param {string} modelId - ID do modelo (ex: 'esportivo', 'fusca')
   * @param {string} modelUrl - URL do arquivo GLB/GLTF
   * @param {Function} onProgress - Callback opcional de progresso (pct) => {}
   * @returns {Promise<{modelId: string, model: THREE.Object3D, regions: Array<{name: string, meshName: string}>}>}
   */
  async loadModel(modelId, modelUrl, onProgress = null) {
    const token = ++this.loadToken;
    
    try {
      // Carrega o modelo 3D
      const gltf = await loadGLB(modelUrl, (pct) => {
        if (onProgress) onProgress(pct == null ? null : Math.round(pct));
      });

      // Verifica se ainda é a operação atual
      if (token !== this.loadToken) {
        if (gltf?.scene) disposeObject(gltf.scene);
        return null;
      }

      const root = gltf.scene || gltf.scenes?.[0];
      if (!root) throw new Error('GLTF sem cena válida.');

      // Remove modelo anterior se existir
      if (this.currentModel) {
        this.scene.remove(this.currentModel);
        disposeObject(this.currentModel);
      }

      // Adiciona novo modelo à cena
      this.currentModel = root;
      this.currentModelId = modelId;
      this.scene.add(this.currentModel);
      this.clonedMeshes.clear();

      // Carrega mapeamento e configura materiais
      await this._setupModelMapping(modelId);

      // Obtém regiões de logo disponíveis
      const regions = this._getLogoRegions();

      return {
        modelId,
        model: this.currentModel,
        regions,
      };
    } catch (err) {
      console.warn('Falha ao carregar modelo:', err);
      throw err;
    }
  }

  /**
   * Configura o mapeamento de materiais para o modelo atual
   * @private
   */
  async _setupModelMapping(modelId) {
    const mapping = await loadMappingForModelId(modelId);
    this.mappingIndex = indexMapping(mapping);

    const names = this.mappingIndex.detectedMaterials || {};
    this.originalColorMap = buildOriginalColorsMap(this.currentModel, names);

    // Identifica materiais de capa e linha
    this.capaMaterialUuids = new Set();
    this.linhaMaterialUuids = new Set();
    
    const isBakeLike = (tex) => {
      if (!tex) return false;
      const s = `${tex.name || ''} ${tex?.image?.src || ''}`.toLowerCase();
      return s.includes('bake') || s.includes('esportivo') || s.includes('esport');
    };

    this.currentModel.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (!m || !m.name) continue;
        const isCapa = names.capa && m.name === names.capa;
        const isLinha = names.linha && m.name === names.linha;
        
        if (isCapa) {
          this.capaMaterialUuids.add(m.uuid);
          if (m.map) {
            attachHueShift(m);
          }
        }
        if (isLinha) {
          this.linhaMaterialUuids.add(m.uuid);
          if (m.map) {
            attachHueShift(m);
          }
        }
        // Caso especial para modelo esportivo
        if (modelId === 'esportivo' && isBakeLike(m.map)) {
          attachHueShift(m);
          this.capaMaterialUuids.add(m.uuid);
        }
      }
    });
  }

  /**
   * Obtém as regiões de logo disponíveis para o modelo atual
   * @private
   * @returns {Array<{name: string, meshName: string}>}
   */
  _getLogoRegions() {
    if (!this.mappingIndex) return [];
    
    const logoName = this.mappingIndex.detectedMaterials?.logo;
    if (!logoName) return [];

    const logoEntry = this.mappingIndex.byMaterialName.get(logoName);
    const meshes = logoEntry?.meshes || [];
    
    return meshes.map((mesh) => ({
      name: mesh.name || 'Região',
      meshName: mesh.name || '',
    }));
  }

  /**
   * Aplica uma cor à capa do veículo
   * @param {string} hexColor - Cor em formato hexadecimal (ex: '#962d28')
   * @returns {void}
   */
  setCapaColor(hexColor) {
    this._applyColorChoice('capa', hexColor);
  }

  /**
   * Aplica uma cor às linhas de costura do veículo
   * @param {string} hexColor - Cor em formato hexadecimal (ex: '#090909')
   * @returns {void}
   */
  setLinhaColor(hexColor) {
    this._applyColorChoice('linhas', hexColor);
  }

  /**
   * Aplica uma escolha de cor (capa ou linhas)
   * @private
   */
  _applyColorChoice(groupKey, hex) {
    if (!this.currentModel || !this.originalColorMap) {
      console.warn('Nenhum modelo carregado');
      return;
    }

    const hexLc = hex.toLowerCase();
    const cfg = SWATCH_CONFIG[hexLc] || { sat: 1.0, val: 1.0, hue: 0, mix: 0.0 };

    // Calcula rotação de matiz baseada na cor alvo
    const baseHSL = { h: 0, s: 0, l: 0 };
    STANDARD_INITIAL_COLOR.getHSL(baseHSL);
    const target = new THREE.Color(hexLc);
    const targetHSL = { h: 0, s: 0, l: 0 };
    target.getHSL(targetHSL);
    const deltaDeg = (targetHSL.h - baseHSL.h) * 360;

    // Seleciona materiais corretos
    const uuids = groupKey === 'capa' ? this.capaMaterialUuids : this.linhaMaterialUuids;
    if (uuids.size === 0) {
      console.warn(`Nenhum material de ${groupKey} encontrado no modelo atual`);
      return;
    }

    // Aplica rotação de matiz
    const rotationMap = new Map();
    const extraHue = (groupKey === 'capa' ? (cfg.hue || 0) : 0);
    uuids.forEach((u) => rotationMap.set(u, deltaDeg + extraHue));
    
    const targetLinear = target.clone();
    if (targetLinear.convertSRGBToLinear) targetLinear.convertSRGBToLinear();
    
    applyHueRotation(this.currentModel, rotationMap, this.originalColorMap, {
      sat: cfg.sat,
      val: cfg.val,
      mix: cfg.mix ?? 0.0,
      target: targetLinear
    });

    // Aplica cor direta para materiais sem textura
    this._applyDirectColor(uuids, target);
    
    this.onRenderRequest();
  }

  /**
   * Aplica cor diretamente a materiais sem textura
   * @private
   */
  _applyDirectColor(uuids, color) {
    this.currentModel.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (uuids.has(m.uuid) && m.color) {
          // Ignora materiais com shader hueShift (eles já foram tratados)
          if (m.userData && m.userData.hueShift) continue;
          m.color.copy(color);
          m.needsUpdate = true;
        }
      }
    });
  }

  /**
   * Obtém as cores disponíveis para capa e linhas
   * @returns {Array<{hex: string, name: string}>}
   */
  getAvailableColors() {
    return [
      { hex: '#090909', name: 'Preto' },
      { hex: '#615e60', name: 'Cinza' },
      { hex: '#498551', name: 'Verde musgo' },
      { hex: '#2c41bd', name: 'Azul royal' },
      { hex: '#001f5b', name: 'Azul marinho' },
      { hex: '#962d28', name: 'Vermelho' },
    ];
  }

  /**
   * Adiciona uma imagem ao pool de logos disponíveis
   * @param {File} file - Arquivo de imagem (PNG recomendado)
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async addLogoImage(file) {
    const item = await this.imagePool.addFile(file);
    this.onRenderRequest();
    return item;
  }

  /**
   * Adiciona múltiplas imagens ao pool de logos
   * @param {Array<File>} files - Array de arquivos de imagem
   * @returns {Promise<Array<{id: string, name: string, url: string}>>}
   */
  async addLogoImages(files) {
    const items = [];
    for (const file of files) {
      const item = await this.imagePool.addFile(file);
      items.push(item);
    }
    this.onRenderRequest();
    return items;
  }

  /**
   * Lista todas as imagens de logo carregadas
   * @returns {Array<{id: string, name: string, url: string}>}
   */
  listLogoImages() {
    return this.imagePool.list();
  }

  /**
   * Obtém uma imagem de logo por ID
   * @param {string} imageId - ID da imagem
   * @returns {{id: string, name: string, url: string} | null}
   */
  getLogoImage(imageId) {
    return this.imagePool.getById(imageId);
  }

  /**
   * Remove uma imagem do pool de logos (opcional, para limpeza de memória)
   * @param {string} imageId - ID da imagem a remover
   * @returns {boolean} - true se removido, false se não encontrado
   */
  removeLogoImage(imageId) {
    const index = this.imagePool.items.findIndex(item => item.id === imageId);
    if (index === -1) return false;
    
    const item = this.imagePool.items[index];
    if (item.url && item.url.startsWith('blob:')) {
      URL.revokeObjectURL(item.url);
    }
    
    this.imagePool.items.splice(index, 1);
    return true;
  }

  /**
   * Obtém as regiões de logo disponíveis para o modelo atual
   * @returns {Array<{name: string, meshName: string}>}
   */
  getLogoRegions() {
    return this._getLogoRegions();
  }

  /**
   * Aplica uma imagem de logo a uma região específica do veículo
   * @param {string} meshName - Nome da mesh/região (obtido via getLogoRegions())
   * @param {string|null} imageId - ID da imagem de logo (ou null para remover)
   * @returns {Promise<void>}
   */
  async assignLogoToRegion(meshName, imageId) {
    if (!this.currentModel) {
      console.warn('Nenhum modelo carregado');
      return;
    }

    // Encontra todas as meshes com o nome especificado
    const targets = [];
    this.currentModel.traverse((child) => {
      if (child.isMesh && child.name === meshName) {
        targets.push(child);
      }
    });

    if (!targets.length) {
      console.warn(`Nenhuma região encontrada com o nome: ${meshName}`);
      return;
    }

    // Remove logo se imageId for null
    if (!imageId) {
      for (const mesh of targets) {
        let material = mesh.material;
        if (!this.clonedMeshes.has(mesh.uuid)) {
          const cloned = material.clone();
          mesh.material = cloned;
          material = cloned;
          this.clonedMeshes.add(mesh.uuid);
        }
        material.map = null;
        material.needsUpdate = true;
      }
      this.onRenderRequest();
      return;
    }

    // Aplica logo
    const item = this.imagePool.getById(imageId);
    if (!item) {
      console.warn(`Imagem de logo não encontrada: ${imageId}`);
      return;
    }

    for (const mesh of targets) {
      await assignTextureToMesh(mesh, item.url, {
        cloneMaterial: true,
        clonedMeshes: this.clonedMeshes
      });
    }

    this.onRenderRequest();
  }

  /**
   * Obtém informações sobre o modelo atual
   * @returns {{modelId: string | null, model: THREE.Object3D | null, regions: Array}}
   */
  getCurrentModelInfo() {
    return {
      modelId: this.currentModelId,
      model: this.currentModel,
      regions: this._getLogoRegions(),
    };
  }

  /**
   * Limpa recursos (dispose do modelo, revoga URLs de blob, etc.)
   */
  dispose() {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      disposeObject(this.currentModel);
      this.currentModel = null;
    }

    // Limpa imagens do pool
    for (const item of this.imagePool.list()) {
      if (item.url && item.url.startsWith('blob:')) {
        URL.revokeObjectURL(item.url);
      }
    }
    this.imagePool.items = [];

    // Limpa estado
    this.currentModelId = null;
    this.mappingIndex = null;
    this.originalColorMap = null;
    this.capaMaterialUuids.clear();
    this.linhaMaterialUuids.clear();
    this.clonedMeshes.clear();
  }
}

