import * as THREE from 'three';

export class ImagePool {
  constructor(renderer) {
    this.renderer = renderer;
    this.items = []; // { id, name, url, texture? }
  }

  async addFile(file) {
    const url = URL.createObjectURL(file);
    const item = { id: crypto.randomUUID?.() || String(Date.now() + Math.random()), name: file.name, url };
    this.items.push(item);
    return item;
  }

  list() { return this.items.slice(); }
  getById(id) { return this.items.find((i) => i.id === id) || null; }
}

