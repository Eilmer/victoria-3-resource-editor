// Loads map data from folders the user picked: state regions + provinces.png.

const MapData = (() => {
  const STATE_REGION_RE = /(^|\/)state_regions\/[^/]+\.txt$/i;
  const PROVINCES_RE = /(^|\/)provinces\.png$/i;
  const BUILDINGS_RE = /(^|\/)common\/buildings\/[^/]+\.txt$|^buildings\/[^/]+\.txt$/i;

  // Pick out the files we care about from a folder's FileList.
  // Returns { stateFiles: Map(fileName -> File), buildingFiles: Map(fileName -> File), provinces: File | null }
  function collectFiles(fileList) {
    const stateFiles = new Map();
    const buildingFiles = new Map();
    let provinces = null;
    for (const file of fileList) {
      const path = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
      if (STATE_REGION_RE.test(path)) {
        stateFiles.set(file.name.toLowerCase(), file);
      } else if (BUILDINGS_RE.test(path)) {
        buildingFiles.set(file.name.toLowerCase(), file);
      } else if (PROVINCES_RE.test(path)) {
        // Prefer the one inside map_data if there are several
        if (!provinces || /map_data\//i.test(path)) provinces = file;
      }
    }
    return { stateFiles, buildingFiles, provinces };
  }

  // Mod files replace base files with the same name; new mod files are added.
  function mergeSources(base, mod) {
    for (const f of base.stateFiles.values()) f.origin = "base";
    if (mod) for (const f of mod.stateFiles.values()) f.origin = "mod";
    const stateFiles = new Map(base.stateFiles);
    const buildingFiles = new Map(base.buildingFiles);
    let provinces = base.provinces;
    if (mod) {
      for (const [name, file] of mod.stateFiles) stateFiles.set(name, file);
      for (const [name, file] of mod.buildingFiles) buildingFiles.set(name, file);
      if (mod.provinces) provinces = mod.provinces;
    }
    return { stateFiles, buildingFiles, provinces };
  }

  function provinceKey(hex) {
    // "x1A2B3C" -> 0x1A2B3C
    const h = hex.trim().replace(/^x/i, "");
    const n = parseInt(h, 16);
    return Number.isNaN(n) ? null : n;
  }

  function readStateBlock(name, block, fileName) {
    const P = PdxParser;
    const capped = {};
    const cappedBlock = P.get(block, "capped_resources");
    if (Array.isArray(cappedBlock)) {
      for (const e of cappedBlock) {
        if (e.key !== undefined && typeof e.value === "string") capped[e.key] = Number(e.value) || 0;
      }
    }
    const discoverable = P.getAll(block, "resource").filter(Array.isArray).map((r) => ({
      type: P.get(r, "type") || "?",
      discovered: Number(P.get(r, "discovered_amount") || 0),
      undiscovered: Number(P.get(r, "undiscovered_amount") || 0),
    }));
    return {
      name,
      id: P.get(block, "id") || "",
      provinces: P.listValues(P.get(block, "provinces")),
      capped,
      arableLand: Number(P.get(block, "arable_land") || 0),
      arable: P.listValues(P.get(block, "arable_resources")),
      discoverable,
      file: fileName,
    };
  }

  function P_has(block, key) {
    return PdxParser.get(block, key) !== undefined;
  }

  // Building group -> building names, read from common/buildings/*.txt
  async function loadBuildings(buildingFiles, warnings) {
    const byName = new Map();
    for (const fileName of [...buildingFiles.keys()].sort()) {
      const { root, warnings: w } = PdxParser.parse(await buildingFiles.get(fileName).text());
      for (const msg of w) warnings.push(`${fileName}: ${msg}`);
      for (const e of root) {
        if (!Array.isArray(e.value) || !e.key) continue;
        const name = e.key.replace(/^[A-Z_]+:/, "");
        const group = PdxParser.get(e.value, "building_group");
        if (group) byName.set(name, group);
      }
    }
    const groupToBuilding = {};
    for (const [building, group] of byName) {
      if (!(group in groupToBuilding)) groupToBuilding[group] = building;
    }
    return groupToBuilding;
  }

  // Parse all state region files. Later files win when a state is defined twice.
  // sources collects each file's text so it can be edited and exported later.
  async function loadStates(stateFiles, sources, warnings) {
    const byName = new Map();
    const names = [...stateFiles.keys()].sort();
    for (const fileName of names) {
      const file = stateFiles.get(fileName);
      const text = await file.text();
      sources.set(fileName, { name: file.name, origin: file.origin, text });
      const { root, warnings: w } = PdxParser.parse(text);
      for (const msg of w) warnings.push(`${fileName}: ${msg}`);

      for (const entry of root) {
        if (!Array.isArray(entry.value) || !entry.key) continue;
        let key = entry.key;
        let mode = "define";
        const m = key.match(/^(REPLACE|REPLACE_OR_CREATE|INJECT|TRY_INJECT|INJECT_OR_CREATE|TRY_REPLACE):(.+)$/);
        if (m) {
          mode = m[1].includes("INJECT") ? "inject" : "replace";
          key = m[2];
        }
        const state = readStateBlock(key, entry.value, fileName);
        state.entry = entry;

        if (mode === "inject" && byName.has(key)) {
          const old = byName.get(key);
          old.injectedFrom = fileName;
          if (state.provinces.length) old.provinces.push(...state.provinces);
          Object.assign(old.capped, state.capped);
          for (const a of state.arable) if (!old.arable.includes(a)) old.arable.push(a);
          if (P_has(entry.value, "arable_land")) old.arableLand = state.arableLand;
          old.discoverable.push(...state.discoverable);
          continue;
        }
        if (mode === "define" && byName.has(key)) {
          warnings.push(`${key} is defined in both ${byName.get(key).file} and ${fileName}; using ${fileName}`);
        }
        byName.set(key, state);
      }
    }
    return [...byName.values()];
  }

  // Decode provinces.png and build a per-pixel state index (0 = no state, e.g. sea).
  async function buildPixelMap(provincesFile, states, warnings) {
    const bitmap = await createImageBitmap(provincesFile, {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    bitmap.close();

    // province colour -> state index (1-based)
    const colourToState = new Map();
    states.forEach((s, i) => {
      for (const hex of s.provinces) {
        const k = provinceKey(hex);
        if (k === null) continue;
        if (colourToState.has(k) && colourToState.get(k) !== i + 1) {
          warnings.push(`Province ${hex} is listed in both ${states[colourToState.get(k) - 1].name} and ${s.name}`);
        }
        colourToState.set(k, i + 1);
      }
    });

    const stateIndex = new Uint16Array(width * height);
    const bbox = states.map(() => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1, pixels: 0 }));
    let lastColour = -1;
    let lastState = 0;
    for (let p = 0, o = 0; p < stateIndex.length; p++, o += 4) {
      const colour = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
      if (colour !== lastColour) {
        lastColour = colour;
        lastState = colourToState.get(colour) || 0;
      }
      if (lastState) {
        stateIndex[p] = lastState;
        const b = bbox[lastState - 1];
        const x = p % width;
        const y = (p / width) | 0;
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
        b.pixels++;
      }
    }

    // Border mask: pixel whose right or lower neighbour belongs to a different state
    const border = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const p = row + x;
        const s = stateIndex[p];
        if (x + 1 < width && stateIndex[p + 1] !== s) { border[p] = 1; border[p + 1] = 1; }
        if (y + 1 < height && stateIndex[p + width] !== s) { border[p] = 1; border[p + width] = 1; }
      }
    }

    states.forEach((s, i) => {
      s.bbox = bbox[i].pixels ? bbox[i] : null;
      if (!s.bbox && s.provinces.length) warnings.push(`${s.name}: none of its provinces were found in provinces.png`);
    });

    return { width, height, stateIndex, border };
  }

  async function load(baseFiles, modFiles, onProgress) {
    const warnings = [];
    const base = collectFiles(baseFiles);
    const mod = modFiles && modFiles.length ? collectFiles(modFiles) : null;
    const merged = mergeSources(base, mod);

    if (!merged.stateFiles.size) throw new Error("No state_regions/*.txt files found in the chosen folder(s).");
    if (!merged.provinces) throw new Error("No provinces.png found in the chosen folder(s).");

    onProgress?.(`Reading ${merged.stateFiles.size} state region files...`);
    const sources = new Map();
    const states = await loadStates(merged.stateFiles, sources, warnings);
    states.sort((a, b) => a.name.localeCompare(b.name));

    onProgress?.("Reading provinces.png (this can take a few seconds for the full map)...");
    await new Promise((r) => setTimeout(r, 0)); // let the progress text paint
    const pixels = await buildPixelMap(merged.provinces, states, warnings);

    const buildings = merged.buildingFiles.size ? await loadBuildings(merged.buildingFiles, warnings) : {};

    const types = {
      capped: [...new Set(states.flatMap((s) => Object.keys(s.capped)))].sort(),
      arable: [...new Set(states.flatMap((s) => s.arable))].sort(),
      discoverable: [...new Set(states.flatMap((s) => s.discoverable.map((d) => d.type)))].sort(),
    };
    return { states, pixels, types, buildings, sources, warnings };
  }

  return { load, collectFiles, provinceKey };
})();
