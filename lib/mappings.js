// Helper to load and index per-model mapping JSONs produced from analysis

export async function loadMappingForModelId(id) {
  const path = `mapeamento_dos_modelos/${id}.json`;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Falha ao carregar mapping: ${path} (HTTP ${res.status})`);
  /** @type {{modelName:string, detectedMaterials?:{logo?:string,capa?:string,linha?:string}, materials:Array<any>}} */
  const json = await res.json();
  return json;
}

export function indexMapping(mapping) {
  const byMaterialName = new Map(); // name -> { materialName, materialUuid, meshes: [...] }
  const byMaterialUuid = new Map(); // uuid -> entry
  const meshByUuid = new Map(); // meshUuid -> meshInfo

  for (const item of mapping.materials || []) {
    const entry = {
      materialName: item.name,
      materialUuid: item.uuid,
      type: item.type,
      meshes: item.meshes || [],
    };
    byMaterialName.set(item.name, entry);
    byMaterialUuid.set(item.uuid, entry);
    for (const mesh of item.meshes || []) {
      meshByUuid.set(mesh.uuid, mesh);
    }
  }

  // Also group meshes by original material name (same as mapping structure)
  const meshesByMaterialName = new Map(); // name -> MeshInfo[]
  for (const [name, entry] of byMaterialName) {
    meshesByMaterialName.set(name, entry.meshes || []);
  }

  return {
    detectedMaterials: mapping.detectedMaterials || {},
    byMaterialName,
    byMaterialUuid,
    meshByUuid,
    meshesByMaterialName,
    raw: mapping,
  };
}

export function listMaterials(mapping) {
  return (mapping.materials || []).map((m) => ({ name: m.name, uuid: m.uuid, type: m.type, meshCount: (m.meshes||[]).length }));
}

