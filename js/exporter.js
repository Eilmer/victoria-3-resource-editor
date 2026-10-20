// Turns the user's resource changes into one Victoria 3 history file, and reads such files back in.
//
// A change set for one state looks like:
//   { capped: { bg_coal_mining: 5 }, arable: { bg_rice_farms: 1, bg_wheat_farms: -1 },
//     discovered: { bg_oil_extraction: 2 }, undiscovered: { bg_oil_extraction: -3 } }
//
// Templates use {placeholders}:
//   history file:  {body}
//   state block:   {state} {lines}
//   change lines:  {state} {resource} {building} {amount}

const Exporter = (() => {
  // Building group (used in state_regions) -> building (used by the effects).
  // Used only when the buildings folder wasn't loaded; the real files always win.
  const DEFAULT_BUILDINGS = {
    bg_coal_mining: "building_coal_mine",
    bg_iron_mining: "building_iron_mine",
    bg_lead_mining: "building_lead_mine",
    bg_sulfur_mining: "building_sulfur_mine",
    bg_gold_mining: "building_gold_mine",
    bg_gold_fields: "building_gold_field",
    bg_logging: "building_logging_camp",
    bg_fishing: "building_fishing_wharf",
    bg_whaling: "building_whaling_station",
    bg_rubber: "building_rubber_plantation",
    bg_oil_extraction: "building_oil_rig",
    bg_livestock_ranches: "building_livestock_ranch",
  };

  const DEFAULT_SETTINGS = {
    historyFolder: "common/history/global",
    historyFileName: "hmps_resource_changes.txt",
    // Where changes are written; see TARGETS. Undiscovered amounts can only go in the map files.
    target: "discoverable",
    historyTemplate: "GLOBAL = {\n{body}}\n",
    stateTemplate: "\ts:{state} = {\n{lines}\t}\n",
    cappedTemplate: "\t\tchange_resource_potential = {\n\t\t\ttype = {building}\n\t\t\tamount = {amount}\n\t\t}\n",
    discoveredTemplate: "\t\tchange_resource_potential = {\n\t\t\ttype = {building}\n\t\t\tamount = {amount}\n\t\t}\n",
    arableAddTemplate: "\t\tadd_resource_potential = {building}\n",
    arableRemoveTemplate: "\t\tremove_resource_potential = {building}\n",
    buildingOverrides: {},
  };

  const KINDS = ["capped", "discovered", "undiscovered", "arable"];

  // Which kinds of change each target writes into the state region (map data) files.
  // Everything else goes into the history file.
  const TARGETS = {
    all: ["capped", "arable", "discovered", "undiscovered"],
    discoverable: ["discovered", "undiscovered"],
    undiscovered: ["undiscovered"],
  };

  function mapKinds(settings) {
    return TARGETS[settings.target] || TARGETS.discoverable;
  }

  // Bring settings saved by older versions up to date.
  function normalizeSettings(saved) {
    const s = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
    if (!saved.target && saved.discoveredTarget) s.target = saved.discoveredTarget === "history" ? "undiscovered" : "discoverable";
    delete s.discoveredTarget;
    return s;
  }

  function fill(template, vars) {
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  // Last-resort guess: bg_wheat_farms -> building_wheat_farm, bg_coal_mining -> building_coal_mine
  function guessBuilding(group) {
    let s = group.replace(/^(bg|building)_/, "");
    s = s.replace(/_mining$/, "_mine")
      .replace(/ranches$/, "ranch")
      .replace(/(farm|plantation|field|camp|mine|wharf|rig|station)s$/, "$1");
    return `building_${s}`;
  }

  // Returns { building, source } for a resource key from the state regions. Newer map data names
  // the building directly (building_gold_mine = 10); older data uses its group (bg_gold_mining).
  function resolveBuilding(group, settings, fromFiles) {
    if (settings.buildingOverrides[group]) return { building: settings.buildingOverrides[group], source: "your setting" };
    if (group.startsWith("building_")) return { building: group, source: "map data" };
    if (fromFiles[group]) return { building: fromFiles[group], source: "buildings files" };
    if (DEFAULT_BUILDINGS[group]) return { building: DEFAULT_BUILDINGS[group], source: "built-in default" };
    return { building: guessBuilding(group), source: "guessed" };
  }

  function isEmpty(change) {
    return KINDS.every((k) => !change[k] || !Object.keys(change[k]).length);
  }

  // changes: Map(stateName -> change set). buildingOf: group -> building name.
  // Changes that belong in the map files (see mapKinds) are left out here; MapPatch writes those.
  // Returns { name, text, empty, warnings }
  function generate(changes, settings, buildingOf) {
    const warnings = [];
    let body = "";

    for (const state of [...changes.keys()].sort()) {
      const c = changes.get(state);
      let lines = "";
      const add = (template, resource, amount, label) => {
        if (!template.trim()) {
          warnings.push(`${state}: ${label} change for ${resource} skipped (its template in Output settings is empty)`);
          return;
        }
        lines += fill(template, { state, resource, building: buildingOf(resource), amount });
      };

      const inMap = mapKinds(settings);
      const entries = (kind) => (inMap.includes(kind) ? [] : Object.entries(c[kind] || {}).sort());
      for (const [r, d] of entries("capped")) add(settings.cappedTemplate, r, d, "capped");
      for (const [r, d] of entries("discovered")) add(settings.discoveredTemplate, r, d, "discovered");
      const arable = entries("arable");
      for (const [r, d] of arable) if (d < 0) add(settings.arableRemoveTemplate, r, d, "arable remove");
      for (const [r, d] of arable) if (d > 0) add(settings.arableAddTemplate, r, d, "arable add");

      if (lines) body += fill(settings.stateTemplate, { state, lines });
    }

    return { name: settings.historyFileName, text: fill(settings.historyTemplate, { body }), empty: !body, warnings };
  }

  // Read a history file (generated by this tool or hand-written) back into changes.
  // Understands change_resource_potential, add_resource_potential and remove_resource_potential
  // inside s:STATE_X scopes. Undiscovered amounts live in the map files, so they're never imported. groupOf: building -> group. isDiscoverable(state, group) decides
  // whether a change_resource_potential is a capped or a discovered change.
  function importHistory(text, groupOf, isDiscoverable) {
    const changes = new Map();
    const unknown = new Set();
    let found = 0;

    function changeFor(state) {
      if (!changes.has(state)) changes.set(state, { capped: {}, arable: {}, discovered: {}, undiscovered: {} });
      return changes.get(state);
    }

    function walk(block, state) {
      for (const e of block) {
        if (e.key && e.key.startsWith("s:") && Array.isArray(e.value)) {
          walk(e.value, e.key.slice(2));
          continue;
        }
        if (state && e.key === "change_resource_potential" && Array.isArray(e.value)) {
          const building = PdxParser.get(e.value, "type");
          const group = groupOf(building);
          if (!group) { unknown.add(building); continue; }
          const kind = isDiscoverable(state, group) ? "discovered" : "capped";
          const c = changeFor(state)[kind];
          c[group] = (c[group] || 0) + Number(PdxParser.get(e.value, "amount") || 0);
          found++;
          continue;
        }
        if (state && (e.key === "add_resource_potential" || e.key === "remove_resource_potential") && typeof e.value === "string") {
          const group = groupOf(e.value);
          if (!group) { unknown.add(e.value); continue; }
          changeFor(state).arable[group] = e.key === "add_resource_potential" ? 1 : -1;
          found++;
          continue;
        }
        if (Array.isArray(e.value)) walk(e.value, state);
      }
    }

    const { root, warnings } = PdxParser.parse(text);
    walk(root, null);
    for (const [state, c] of changes) {
      for (const k of KINDS) for (const r of Object.keys(c[k])) if (c[k][r] === 0) delete c[k][r];
      if (isEmpty(c)) changes.delete(state);
    }
    return { changes, found, unknown: [...unknown], warnings };
  }

  return { DEFAULT_SETTINGS, KINDS, TARGETS, mapKinds, normalizeSettings, generate, importHistory, resolveBuilding, isEmpty };
})();

if (typeof module !== "undefined") module.exports = Exporter;
