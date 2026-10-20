// Main application: wires the map, sidebar, settings and export together.

const STORAGE_KEY = "hmps-resource-editor:v2";

const app = {
  states: [],          // from MapData.load
  stateByName: new Map(),
  types: { capped: [], arable: [], discoverable: [] },
  buildingsFromFiles: {}, // building group -> building, read from common/buildings
  sources: new Map(),  // state region file name -> { name, origin, text }, for exporting edited copies
  renderer: null,
  selected: 0,         // selected state index (1-based, 0 = none)
  colourMode: "state", // see colourModes()
  changes: new Map(),  // stateName -> { capped: {}, arable: {}, discovered: {}, undiscovered: {} }
  shownResources: new Map(), // stateName -> Set of "kind:resource" rows added to the panel this session
  settings: structuredClone(Exporter.DEFAULT_SETTINGS),
};

const $ = (id) => document.getElementById(id);

// ---------- Persistence (best-effort; the app works without it) ----------

function saveLocal() {
  try {
    const data = { changes: Object.fromEntries(app.changes), settings: app.settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* storage unavailable */ }
}

function loadLocal() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!data) return;
    if (data.settings) app.settings = Exporter.normalizeSettings(data.settings);
    if (data.changes) app.changes = new Map(Object.entries(data.changes));
  } catch { /* storage unavailable or corrupt */ }
}

// ---------- Buildings ----------

function buildingOf(group) {
  return Exporter.resolveBuilding(group, app.settings, app.buildingsFromFiles).building;
}

function groupOfBuilding(building) {
  const all = [...app.types.capped, ...app.types.arable, ...app.types.discoverable];
  return all.find((g) => buildingOf(g) === building);
}

// ---------- Base values and changes ----------

function discBase(s, r) {
  const d = s.discoverable.filter((x) => x.type === r);
  return {
    discovered: d.reduce((a, x) => a + x.discovered, 0),
    undiscovered: d.reduce((a, x) => a + x.undiscovered, 0),
  };
}

function baseValue(s, kind, r) {
  if (kind === "capped") return s.capped[r] || 0;
  if (kind === "arable") return s.arable.includes(r) ? 1 : 0;
  return discBase(s, r)[kind];
}

function getChange(stateName, kind, r) {
  return app.changes.get(stateName)?.[kind]?.[r] || 0;
}

function value(s, kind, r) {
  return baseValue(s, kind, r) + getChange(s.name, kind, r);
}

// Set the change for one resource. For arable, delta is +1 (add), -1 (remove) or 0.
function setChange(stateName, kind, r, delta) {
  const s = app.stateByName.get(stateName);
  const base = s ? baseValue(s, kind, r) : 0;
  delta = Math.round(Number(delta) || 0);
  if (kind === "arable") delta = Math.max(-base, Math.min(1 - base, delta));
  else if (base + delta < 0) delta = -base; // can't go below zero

  const c = structuredClone(app.changes.get(stateName) || {});
  for (const k of Exporter.KINDS) c[k] ||= {};
  if (delta === 0) delete c[kind][r];
  else c[kind][r] = delta;

  if (Exporter.isEmpty(c)) app.changes.delete(stateName);
  else app.changes.set(stateName, c);

  saveLocal();
  scheduleRedraw();
  renderChangesList();
}

function changeCount() {
  let n = 0;
  for (const c of app.changes.values()) for (const k of Exporter.KINDS) n += Object.keys(c[k] || {}).length;
  return n;
}

// ---------- Colours ----------

function pack([r, g, b]) {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// The colour each good is drawn in at its highest amount. Matched on words in the group name,
// so modded groups like bg_rice_paddies still pick up a sensible colour.
const RESOURCE_COLOURS = [
  ["coal", "#2b2b2b"], ["iron", "#a0442a"], ["lead", "#4f6075"], ["sulfur", "#c9b100"],
  ["gold", "#d49a00"], ["logging", "#2e6b2e"], ["wood", "#2e6b2e"], ["fish", "#1f7f9c"],
  ["whal", "#1f3f73"], ["rubber", "#5b6b1f"], ["oil", "#4a2a5c"], ["wheat", "#c8902c"],
  ["rice", "#7fae3a"], ["maize", "#e0b400"], ["corn", "#e0b400"], ["millet", "#a87f45"],
  ["rye", "#7d5a32"], ["livestock", "#a0522d"], ["ranch", "#a0522d"], ["coffee", "#5c3b25"],
  ["cotton", "#6f8fb5"], ["dye", "#3b3fa0"], ["opium", "#c2185b"], ["tea", "#2f8a4a"],
  ["tobacco", "#8a6d1f"], ["sugar", "#b04a7a"], ["banana", "#d6b400"], ["silk", "#a065c0"],
  ["vineyard", "#7b1e3a"], ["wine", "#7b1e3a"],
];
const ARABLE_LAND_COLOUR = "#4f7f2a";

function isDark() {
  return document.documentElement.dataset.theme !== "light";
}

// On a dark background, very dark colours (coal, oil) are lifted so they stay visible.
function forTheme(rgb) {
  if (!isDark()) return rgb;
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const MIN = 120;
  return lum >= MIN ? rgb : mix(rgb, [255, 255, 255], (MIN - lum) / (255 - lum));
}

function resourceColour(r) {
  const hit = RESOURCE_COLOURS.find(([word]) => r.includes(word));
  return forTheme(hit ? hex(hit[1]) : hslToRgb(hashString(r) % 360, 0.55, 0.38));
}

// Low end of a resource's colour scale: pale in light mode, dim in dark mode
function rampLow(colour) {
  return isDark() ? mix(colour, [34, 38, 44], 0.72) : mix(colour, [255, 255, 255], 0.82);
}

const SEA = [29, 43, 58];
// Striped fill for "none of this"; darker in dark mode so it doesn't glare
let NONE_A = [214, 212, 205];
let NONE_B = [190, 188, 181];

function setThemeColours(light) {
  document.documentElement.dataset.theme = light ? "light" : "dark";
  NONE_A = light ? [214, 212, 205] : [62, 66, 72];
  NONE_B = light ? [190, 188, 181] : [48, 52, 57];
}

function applyTheme(theme) {
  const light = theme === "light";
  setThemeColours(light);
  $("btnTheme").textContent = light ? "Dark mode" : "Light mode";
  try { localStorage.setItem("hmps-resource-editor:theme", light ? "light" : "dark"); } catch { /* storage unavailable */ }
  if (app.renderer) {
    scheduleRedraw();
    renderStatePanel();
  }
}

function setupTheme() {
  applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  $("btnTheme").addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
}
const CHANGED_BORDER = [0, 200, 255];
const SELECTED = [255, 214, 0];

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function prettyResource(r) {
  return r.replace(/^(bg|building)_/, "").replace(/_/g, " ");
}

// All "Colour by" options: { key, group, label, value(state) -> number, colour }
function colourModes() {
  const modes = [{ key: "state", group: "", label: "State" }];
  modes.push({ key: "arable_land", group: "Arable", label: "Arable land", value: (s) => s.arableLand, colour: forTheme(hex(ARABLE_LAND_COLOUR)) });
  for (const r of app.types.arable) {
    modes.push({ key: `arable:${r}`, group: "Arable", label: prettyResource(r),
      value: (s) => (value(s, "arable", r) ? Math.max(s.arableLand, 1) : 0), colour: resourceColour(r), arable: true,
      numberHint: "arable land" });
  }
  for (const r of app.types.capped) {
    modes.push({ key: `capped:${r}`, group: "Capped resources", label: prettyResource(r),
      value: (s) => value(s, "capped", r), colour: resourceColour(r) });
  }
  for (const r of app.types.discoverable) {
    const c = resourceColour(r);
    modes.push({ key: `total:${r}`, group: "Discoverable resources", label: `${prettyResource(r)} (total)`,
      value: (s) => value(s, "discovered", r) + value(s, "undiscovered", r), colour: c,
      number: (s) => `${value(s, "discovered", r)} (${value(s, "undiscovered", r)})`, numberHint: "discovered (undiscovered)" });
    modes.push({ key: `discovered:${r}`, group: "Discoverable resources", label: `${prettyResource(r)} (discovered)`,
      value: (s) => value(s, "discovered", r), colour: c });
    modes.push({ key: `undiscovered:${r}`, group: "Discoverable resources", label: `${prettyResource(r)} (undiscovered)`,
      value: (s) => value(s, "undiscovered", r), colour: c });
  }
  return modes;
}

function currentMode() {
  return colourModes().find((m) => m.key === app.colourMode) || colourModes()[0];
}

// opts.selected: state index to highlight (0 = none). opts.outlineChanges: cyan borders on changed states.
function buildPalettes(mode = currentMode(), opts = { selected: app.selected, outlineChanges: true }) {
  const n = app.states.length + 1;
  const fill = new Uint32Array(n);
  const border = new Uint32Array(n);
  const stripe = new Uint32Array(n);
  fill[0] = border[0] = pack(SEA);

  const values = mode.value ? app.states.map(mode.value) : null;
  const max = values ? Math.max(0, ...values) : 0;
  const low = mode.colour ? rampLow(mode.colour) : null;

  app.states.forEach((s, i) => {
    let rgb;
    if (!values) {
      const h = hashString(s.name);
      rgb = hslToRgb(h % 360, 0.35 + ((h >> 9) % 20) / 100, 0.62 + ((h >> 17) % 14) / 100);
    } else if (values[i] > 0) {
      rgb = mix(low, mode.colour, max > 0 ? Math.sqrt(values[i] / max) : 1);
    } else {
      rgb = NONE_A;
      stripe[i + 1] = pack(i + 1 === opts.selected ? mix(NONE_B, [255, 255, 255], 0.35) : NONE_B);
    }
    const selected = i + 1 === opts.selected;
    if (selected) rgb = mix(rgb, [255, 255, 255], 0.35);
    fill[i + 1] = pack(rgb);
    if (selected) border[i + 1] = pack(SELECTED);
    else if (opts.outlineChanges && app.changes.has(s.name)) border[i + 1] = pack(CHANGED_BORDER);
    else border[i + 1] = pack(mix(rgb, [0, 0, 0], 0.45));
  });

  return { fill, border, stripe, max, mode, low };
}

let redrawPending = false;
function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => {
    redrawPending = false;
    const p = buildPalettes();
    app.renderer.draw(p.fill, p.border, p.stripe);
    renderLegend(p);
    $("changeCount").textContent = changeCount();
  });
}

function rgbCss(c) { return `rgb(${c.join(",")})`; }

function renderLegend({ mode, max, low }) {
  const changed = `<span><span class="swatch" style="background:${rgbCss(CHANGED_BORDER)}"></span> changed</span>`;
  if (!mode.value) {
    $("legend").innerHTML = changed;
    return;
  }
  const none = `<span><span class="swatch" style="background:repeating-linear-gradient(45deg, ${rgbCss(NONE_A)} 0 3px, ${rgbCss(NONE_B)} 3px 6px)"></span> none</span>`;
  const label = mode.arable ? "arable land" : "";
  $("legend").innerHTML = `
    ${none}
    <span>${label ? `${label}: ` : ""}1</span>
    <span class="ramp" style="background:linear-gradient(90deg, ${rgbCss(low)}, ${rgbCss(mode.colour)})"></span>
    <span>${max}</span>
    ${changed}`;
}

// ---------- Sidebar: selected state ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function swatch(r) {
  return `<span class="swatch" style="background:${rgbCss(resourceColour(r))}"></span>`;
}

function stepper(kind, r, shown, cls) {
  return `
    <div class="stepper" data-kind="${kind}" data-res="${esc(r)}">
      <button data-step="-1" title="Shift-click for 5">−</button>
      <input type="number" value="${shown}" class="${cls}" aria-label="${esc(prettyResource(r))} ${kind}">
      <button data-step="1" title="Shift-click for 5">+</button>
    </div>`;
}

function deltaNote(d) {
  if (!d) return "";
  return `<span class="${d > 0 ? "delta-pos" : "delta-neg"}">${d > 0 ? "+" : ""}${d}</span>`;
}

function rowsFor(s, kind, baseKeys) {
  const extra = [...(app.shownResources.get(s.name) || [])]
    .filter((x) => x.startsWith(`${kind}:`)).map((x) => x.slice(kind.length + 1));
  const changed = app.changes.get(s.name);
  const changedKeys = kind === "disc"
    ? [...Object.keys(changed?.discovered || {}), ...Object.keys(changed?.undiscovered || {})]
    : Object.keys(changed?.[kind] || {});
  return [...new Set([...baseKeys, ...changedKeys, ...extra])].sort();
}

function addSelect(id, options) {
  if (!options.length) return "";
  return `
    <div class="add-row">
      <select id="${id}">${options.map((r) => `<option value="${esc(r)}">${esc(prettyResource(r))}</option>`).join("")}</select>
      <button data-add="${id}">Add</button>
    </div>`;
}

function selectState(index, focus) {
  app.selected = index;
  renderStatePanel();
  scheduleRedraw();
  if (focus && index) app.renderer.focus(app.states[index - 1].bbox);
}

function renderStatePanel() {
  const panel = $("statePanel");
  if (!app.selected) {
    panel.innerHTML = `<p class="hint">Click a state on the map, or search for one.</p>`;
    return;
  }
  const s = app.states[app.selected - 1];

  // Capped resources: stepper edits the change
  const capped = rowsFor(s, "capped", Object.keys(s.capped));
  const cappedHtml = capped.map((r) => {
    const base = s.capped[r] || 0;
    const d = getChange(s.name, "capped", r);
    return `
      <tr class="${d ? "changed" : ""}">
        <td>${swatch(r)} ${esc(prettyResource(r))}</td>
        <td class="num">${base}</td>
        <td>${stepper("capped", r, d, d > 0 ? "delta-pos" : d < 0 ? "delta-neg" : "")}</td>
        <td class="num"><strong>${base + d}</strong></td>
      </tr>`;
  }).join("");

  // Arable: a checkbox per arable type in the loaded data
  const arableHtml = app.types.arable.map((r) => {
    const has = !!value(s, "arable", r);
    const d = getChange(s.name, "arable", r);
    const note = d > 0 ? `<span class="delta-pos">added</span>` : d < 0 ? `<span class="delta-neg">removed</span>` : "";
    return `
      <label class="arable-item ${d ? "changed" : ""}">
        <input type="checkbox" data-arable="${esc(r)}" ${has ? "checked" : ""}>
        ${swatch(r)} ${esc(prettyResource(r))} ${note}
      </label>`;
  }).join("");

  // Discoverable: steppers edit the resulting amounts; total is editable too
  const disc = rowsFor(s, "disc", s.discoverable.map((d) => d.type));
  const discHtml = disc.map((r) => {
    const found = value(s, "discovered", r);
    const hidden = value(s, "undiscovered", r);
    const dF = getChange(s.name, "discovered", r);
    const dH = getChange(s.name, "undiscovered", r);
    const base = discBase(s, r);
    return `
      <tr class="${dF || dH ? "changed" : ""}">
        <td>${swatch(r)} ${esc(prettyResource(r))}</td>
        <td>${stepper("discovered", r, found, "")}<div class="sub">was ${base.discovered} ${deltaNote(dF)}</div></td>
        <td>${stepper("undiscovered", r, hidden, "")}<div class="sub">was ${base.undiscovered} ${deltaNote(dH)}</div></td>
        <td>${stepper("total", r, found + hidden, "")}<div class="sub">was ${base.discovered + base.undiscovered}</div></td>
      </tr>`;
  }).join("");

  panel.innerHTML = `
    <h2>${esc(s.name)}</h2>
    <div class="meta">id ${esc(s.id)} · ${s.provinces.length} provinces · ${esc(s.file)}</div>

    <h3>Capped resources</h3>
    ${capped.length ? `
      <table class="res-table">
        <thead><tr><th>Resource</th><th class="num">Base</th><th>Change</th><th class="num">Result</th></tr></thead>
        <tbody>${cappedHtml}</tbody>
      </table>` : `<p class="hint">None.</p>`}
    ${addSelect("addCapped", app.types.capped.filter((r) => !capped.includes(r)))}

    <h3>Arable · ${s.arableLand} arable land</h3>
    ${app.types.arable.length ? `<div class="arable-list">${arableHtml}</div>` : `<p class="hint">No arable resources in the loaded data.</p>`}

    <h3>Discoverable resources</h3>
    ${disc.length ? `
      <table class="res-table disc-table">
        <thead><tr><th>Resource</th><th>Discovered</th><th>Undiscovered</th><th>Total</th></tr></thead>
        <tbody>${discHtml}</tbody>
      </table>` : `<p class="hint">None.</p>`}
    ${addSelect("addDisc", app.types.discoverable.filter((r) => !disc.includes(r)))}

    ${app.changes.has(s.name) ? `<div class="state-actions"><button id="btnResetState">Reset this state</button></div>` : ""}`;

  // Steppers
  panel.querySelectorAll(".stepper").forEach((el) => {
    const { kind, res } = el.dataset;
    const input = el.querySelector("input");
    const apply = (shown) => {
      if (kind === "capped") {
        setChange(s.name, "capped", res, shown);
      } else if (kind === "total") {
        // Setting the total keeps the discovered amount and puts the rest in undiscovered
        const total = Math.max(0, Math.round(Number(shown) || 0));
        const found = Math.min(value(s, "discovered", res), total);
        setChange(s.name, "discovered", res, found - baseValue(s, "discovered", res));
        setChange(s.name, "undiscovered", res, total - found - baseValue(s, "undiscovered", res));
      } else {
        setChange(s.name, kind, res, Math.max(0, Math.round(Number(shown) || 0)) - baseValue(s, kind, res));
      }
      renderStatePanel();
    };
    el.querySelectorAll("button[data-step]").forEach((b) => {
      b.addEventListener("click", (e) => apply(Number(input.value) + Number(b.dataset.step) * (e.shiftKey ? 5 : 1)));
    });
    input.addEventListener("change", () => apply(input.value));
  });

  // Arable checkboxes
  panel.querySelectorAll("input[data-arable]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const r = cb.dataset.arable;
      setChange(s.name, "arable", r, (cb.checked ? 1 : 0) - baseValue(s, "arable", r));
      renderStatePanel();
    });
  });

  // "Add" rows
  panel.querySelectorAll("button[data-add]").forEach((b) => {
    b.addEventListener("click", () => {
      const kind = b.dataset.add === "addCapped" ? "capped" : "disc";
      if (!app.shownResources.has(s.name)) app.shownResources.set(s.name, new Set());
      app.shownResources.get(s.name).add(`${kind}:${$(b.dataset.add).value}`);
      renderStatePanel();
    });
  });

  $("btnResetState")?.addEventListener("click", () => {
    app.changes.delete(s.name);
    saveLocal();
    scheduleRedraw();
    renderChangesList();
    renderStatePanel();
  });
}

// ---------- Sidebar: changes list ----------

function changeBadges(c) {
  const badges = [];
  const num = (d) => `${d > 0 ? "+" : ""}${d}`;
  const cls = (d) => (d > 0 ? "delta-pos" : "delta-neg");
  for (const [r, d] of Object.entries(c.capped || {})) badges.push([cls(d), `${num(d)} ${prettyResource(r)}`]);
  for (const [r, d] of Object.entries(c.arable || {})) badges.push([cls(d), `${d > 0 ? "+" : "−"} ${prettyResource(r)}`]);
  for (const [r, d] of Object.entries(c.discovered || {})) badges.push([cls(d), `${num(d)} ${prettyResource(r)} (discovered)`]);
  for (const [r, d] of Object.entries(c.undiscovered || {})) badges.push([cls(d), `${num(d)} ${prettyResource(r)} (undiscovered)`]);
  return badges.map(([c2, t]) => `<span class="badge ${c2}">${esc(t)}</span>`).join("");
}

function renderChangesList() {
  const list = $("changesList");
  const names = [...app.changes.keys()].sort();
  $("changesSummary").textContent = names.length ? `(${names.length} states)` : "";
  if (!names.length) {
    list.innerHTML = `<p class="hint">No changes yet.</p>`;
    return;
  }
  list.innerHTML = names.map((n) => `
    <div class="change-item" data-state="${esc(n)}">
      <div class="change-name">${esc(n)}${app.stateByName.has(n) ? "" : " ⚠ not on this map"}</div>
      ${changeBadges(app.changes.get(n))}
    </div>`).join("") + `<div class="state-actions"><button id="btnClearAll">Clear all changes</button></div>`;

  list.querySelectorAll(".change-item").forEach((el) => {
    el.addEventListener("click", () => {
      const s = app.stateByName.get(el.dataset.state);
      if (s) selectState(app.states.indexOf(s) + 1, true);
    });
  });
  $("btnClearAll").addEventListener("click", () => {
    if (!confirm("Clear all pending changes?")) return;
    app.changes.clear();
    saveLocal();
    scheduleRedraw();
    renderChangesList();
    renderStatePanel();
  });
}

// ---------- Search ----------

function setupSearch() {
  const input = $("search");
  const results = $("searchResults");
  let matches = [];
  let active = 0;

  function render() {
    results.innerHTML = matches.map((s, i) =>
      `<li class="${i === active ? "active" : ""}" data-i="${i}">${esc(s.name)}</li>`).join("");
  }

  function choose(i) {
    const s = matches[i];
    if (!s) return;
    selectState(app.states.indexOf(s) + 1, true);
    input.value = "";
    matches = [];
    render();
  }

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase().replace(/\s+/g, "_");
    matches = q ? app.states.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 30) : [];
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, matches.length - 1); render(); e.preventDefault(); }
    if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    if (e.key === "Enter") choose(active);
    if (e.key === "Escape") { matches = []; render(); }
  });
  results.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) choose(Number(li.dataset.i));
  });
  input.addEventListener("blur", () => setTimeout(() => { matches = []; render(); }, 150));
}

// ---------- Settings dialog ----------

const TEXT_SETTINGS = ["historyFolder", "historyFileName", "target", "historyTemplate", "stateTemplate",
  "cappedTemplate", "discoveredTemplate", "arableAddTemplate", "arableRemoveTemplate"];

function fillSettingsForm(settings) {
  const form = $("settingsForm");
  for (const k of TEXT_SETTINGS) form.elements[k].value = settings[k] ?? Exporter.DEFAULT_SETTINGS[k];

  const groups = [...new Set([...app.types.capped, ...app.types.arable, ...app.types.discoverable])].sort();
  $("buildingsBody").innerHTML = groups.map((g) => {
    const { building, source } = Exporter.resolveBuilding(g, settings, app.buildingsFromFiles);
    return `<tr><td>${esc(g)}</td><td><input data-group="${esc(g)}" value="${esc(building)}"></td>
      <td class="source ${source === "guessed" ? "check-bad" : ""}">${esc(source)}</td></tr>`;
  }).join("");
}

function readSettingsForm() {
  const form = $("settingsForm");
  const s = structuredClone(app.settings);
  for (const k of TEXT_SETTINGS) s[k] = form.elements[k].value;
  s.buildingOverrides = {};
  $("buildingsBody").querySelectorAll("input").forEach((inp) => {
    const g = inp.dataset.group;
    const auto = Exporter.resolveBuilding(g, { buildingOverrides: {} }, app.buildingsFromFiles).building;
    if (inp.value.trim() && inp.value.trim() !== auto) s.buildingOverrides[g] = inp.value.trim();
  });
  return s;
}

function setupSettings() {
  const dialog = $("settingsDialog");
  $("btnSettings").addEventListener("click", () => {
    fillSettingsForm(app.settings);
    dialog.showModal();
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "save") {
      app.settings = readSettingsForm();
      saveLocal();
    }
  });
  $("btnResetSettings").addEventListener("click", () => fillSettingsForm(structuredClone(Exporter.DEFAULT_SETTINGS)));
}

// ---------- Export / import ----------

const BOM = "﻿"; // UTF-8 with BOM, like the game's own script files

function downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadText(name, text) {
  downloadBlob(name, new Blob([BOM + text], { type: "text/plain;charset=utf-8" }));
}

// Changes that go into the map files (see Exporter.mapKinds), as new values for MapPatch:
// Map(stateName -> { capped: { r: amount }, arable: { r: allowed }, discoverable: { r: { discovered, undiscovered } } })
function mapTargets() {
  const inMap = Exporter.mapKinds(app.settings);
  const targets = new Map();
  for (const [name, c] of app.changes) {
    const s = app.stateByName.get(name);
    if (!s) continue;
    const want = { capped: {}, arable: {}, discoverable: {} };
    if (inMap.includes("capped")) for (const r of Object.keys(c.capped || {})) want.capped[r] = value(s, "capped", r);
    if (inMap.includes("arable")) for (const r of Object.keys(c.arable || {})) want.arable[r] = !!value(s, "arable", r);
    const disc = new Set(Object.keys(c.undiscovered || {}));
    if (inMap.includes("discovered")) for (const r of Object.keys(c.discovered || {})) disc.add(r);
    for (const r of disc) {
      want.discoverable[r] = {
        discovered: inMap.includes("discovered") ? value(s, "discovered", r) : baseValue(s, "discovered", r),
        undiscovered: value(s, "undiscovered", r),
      };
    }
    if (Object.values(want).some((w) => Object.keys(w).length)) targets.set(name, want);
  }
  return targets;
}

// The text of each changed state's block in a patched file, for the preview.
function changedBlocks(text, stateNames) {
  const { root } = PdxParser.parse(text);
  return root
    .filter((e) => e.key && stateNames.includes(e.key) && e.close !== undefined)
    .map((e) => text.slice(e.start, e.close + 1))
    .join("\n\n");
}

function clearMapChanges() {
  const inMap = Exporter.mapKinds(app.settings);
  for (const [name, c] of [...app.changes]) {
    const next = { ...c };
    for (const kind of inMap) next[kind] = {};
    if (Exporter.isEmpty(next)) app.changes.delete(name);
    else app.changes.set(name, next);
  }
  saveLocal();
  scheduleRedraw();
  renderChangesList();
  renderStatePanel();
}

const TARGET_LABELS = {
  all: "everything into the map data files",
  discoverable: "discoverable resources into the map data files, the rest into a history file",
  undiscovered: "only undiscovered amounts into the map data files, the rest into a history file",
};

// e.g. "capped, arable and discoverable changes"
function mapKindsText() {
  const inMap = Exporter.mapKinds(app.settings);
  if (inMap.includes("capped")) return "capped, arable and discoverable changes";
  if (inMap.includes("discovered")) return "discoverable resource changes";
  return "undiscovered amount changes";
}

function setupExport() {
  const dialog = $("exportDialog");
  $("btnExport").addEventListener("click", () => {
    if (!app.changes.size) {
      alert("There are no changes to export yet.");
      return;
    }
    const history = Exporter.generate(app.changes, app.settings, buildingOf);
    const targets = mapTargets();
    const patch = MapPatch.build(app.states, targets, app.sources);
    const historyPath = `${app.settings.historyFolder.replace(/\/+$/, "")}/${history.name}`.replace(/^\/+/, "");

    const guessed = [...new Set([...app.changes.values()].flatMap((c) => ["capped", "arable", "discovered"].flatMap((k) => Object.keys(c[k] || {}))))]
      .filter((g) => Exporter.resolveBuilding(g, app.settings, app.buildingsFromFiles).source === "guessed");
    const warnings = [...history.warnings, ...patch.warnings];
    if (guessed.length) warnings.unshift(`Building names were guessed for ${guessed.join(", ")}. Check them in Output settings, or load common/buildings.`);

    // Everything that can be downloaded: { path, text, preview }
    const outputs = [];
    if (!history.empty) outputs.push({ path: historyPath, text: history.text, preview: history.text });
    for (const f of patch.files) {
      const names = [...targets.keys()].filter((n) => app.stateByName.get(n).file === f.name.toLowerCase());
      outputs.push({
        path: `map_data/state_regions/${f.name}`,
        text: f.text,
        preview: changedBlocks(f.text, names),
        note: `full copy of the ${f.origin === "mod" ? "mod's" : "base game's"} file; preview shows the changed states`,
      });
    }

    $("exportFiles").innerHTML = `
      ${warnings.length ? `<ul class="export-warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <p class="export-target">Writing: <strong>${esc(TARGET_LABELS[app.settings.target] || TARGET_LABELS.discoverable)}</strong>
        (change this in Output settings)</p>
      ${patch.files.length ? `
        <div class="export-note">
          <p>${esc(capitalise(mapKindsText()))} are written into copies of the state region files. Put them in your mod's
          <code>map_data/state_regions</code> folder (replacing any file with the same name).</p>
          <p>Once they're in your mod, reload the tool with the updated mod and clear these changes,
          or they'll be counted twice.</p>
          <button id="btnClearMap">Clear map data changes now</button>
        </div>` : ""}
      ${outputs.length > 1 ? `<p><button id="btnZip" class="primary">Download all (.zip, laid out like a mod folder)</button></p>` : ""}
      ${outputs.map((o, i) => `
        <div class="export-file">
          <header>
            <strong>${esc(o.path)} ${o.note ? `<span class="origin">— ${esc(o.note)}</span>` : ""}</strong>
            <button data-copy="${i}">Copy</button>
            <button data-download="${i}" class="primary">Download</button>
          </header>
          <pre>${esc(o.preview)}</pre>
        </div>`).join("")}`;

    $("exportFiles").querySelectorAll("[data-download]").forEach((b) => {
      const o = outputs[b.dataset.download];
      b.addEventListener("click", () => downloadText(o.path.split("/").pop(), o.text));
    });
    $("exportFiles").querySelectorAll("[data-copy]").forEach((b) => {
      b.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(outputs[b.dataset.copy].text);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Copy failed";
        }
        setTimeout(() => { b.textContent = "Copy"; }, 1500);
      });
    });
    $("btnZip")?.addEventListener("click", () => {
      const enc = new TextEncoder();
      downloadBlob("hmps_resource_export.zip", MapPatch.zip(outputs.map((o) => ({ path: o.path, bytes: enc.encode(BOM + o.text) }))));
    });
    $("btnClearMap")?.addEventListener("click", () => {
      if (!confirm(`Clear the ${mapKindsText()}? Only do this once the exported map files are in your mod.`)) return;
      clearMapChanges();
      dialog.close();
    });
    dialog.showModal();
  });
  $("btnCloseExport").addEventListener("click", () => dialog.close());

  $("btnImport").addEventListener("click", () => $("importInput").click());
  $("importInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const isDiscoverable = (state, group) => {
      const s = app.stateByName.get(state);
      if (s && s.discoverable.some((d) => d.type === group)) return true;
      if (s && group in s.capped) return false;
      return app.types.discoverable.includes(group) && !app.types.capped.includes(group);
    };
    const result = Exporter.importHistory(await file.text(), groupOfBuilding, isDiscoverable);
    if (!result.found) {
      alert("No change_resource_potential, add_resource_potential or remove_resource_potential lines were found inside s:STATE blocks.");
      return;
    }
    const replace = !app.changes.size || confirm(
      `Found ${result.found} changes in ${result.changes.size} states.\n\nOK = replace current changes\nCancel = add them to current changes`);
    if (replace) app.changes.clear();
    for (const [state, c] of result.changes) {
      for (const kind of Exporter.KINDS) {
        for (const [r, d] of Object.entries(c[kind])) {
          setChange(state, kind, r, (kind === "arable" ? 0 : getChange(state, kind, r)) + d);
        }
      }
    }
    renderStatePanel();
    if (result.unknown.length) alert(`Ignored buildings that don't match any resource in the map data: ${result.unknown.join(", ")}`);
  });
}

// ---------- Map images ----------

function capitalise(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function modeTitle(mode) {
  return mode.key === "state" ? "States" : capitalise(mode.label);
}

function modeSubtitle(mode) {
  const parts = [];
  if (mode.group) parts.push(mode.group);
  const n = app.changes.size;
  if (n) parts.push(`includes pending changes in ${n} state${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function fileSlug(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "map";
}

// Run fn with the page temporarily in another theme ("dark", "light" or "current"). fn must be synchronous.
function withTheme(theme, fn) {
  const prev = document.documentElement.dataset.theme;
  if (theme !== "current") setThemeColours(theme === "light");
  try {
    return fn();
  } finally {
    setThemeColours(prev === "light");
  }
}

let fullMapCache = null; // full-size canvas reused between renders
let landGridCache = null;
let labelSpotCache = null;

// For each state, the point inside it furthest from its border, and that distance (in map pixels).
// Uses a two-pass chamfer distance transform over the whole map; computed once per map.
function labelSpots(px) {
  if (labelSpotCache && labelSpotCache.px === px) return labelSpotCache.spots;
  const { width: w, height: h, stateIndex, border } = px;
  const dist = new Uint16Array(w * h);
  const FAR = 65000;
  for (let p = 0; p < dist.length; p++) dist[p] = border[p] || !stateIndex[p] ? 0 : FAR;
  // Forward pass (3 = straight step, 4 = diagonal step)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let d = dist[p];
      if (!d) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { dist[p] = 0; continue; }
      d = Math.min(d, dist[p - 1] + 3, dist[p - w] + 3, dist[p - w - 1] + 4, dist[p - w + 1] + 4);
      dist[p] = d;
    }
  }
  // Backward pass, tracking the deepest distance per state
  const n = app.states.length + 1;
  const maxD = new Uint16Array(n);
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let d = dist[p];
      if (!d) continue;
      d = Math.min(d, dist[p + 1] + 3, dist[p + w] + 3, dist[p + w + 1] + 4, dist[p + w - 1] + 4);
      dist[p] = d;
      if (d > maxD[stateIndex[p]]) maxD[stateIndex[p]] = d;
    }
  }
  // Long or blobby states have many near-deepest points; take the one nearest the state's middle
  const spots = new Array(n).fill(null);
  const best = new Float64Array(n).fill(Infinity);
  const mid = app.states.map((st) => (st.bbox ? [(st.bbox.x0 + st.bbox.x1) / 2, (st.bbox.y0 + st.bbox.y1) / 2] : [0, 0]));
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const st = stateIndex[p];
      if (!st || dist[p] < maxD[st] * 0.85) continue;
      const [mx, my] = mid[st - 1];
      const e = (x - mx) ** 2 + (y - my) ** 2;
      if (e < best[st]) {
        best[st] = e;
        spots[st] = { x, y, r: dist[p] / 3 };
      }
    }
  }
  labelSpotCache = { px, spots };
  return spots;
}

function prettyStateName(name) {
  return name.replace(/^STATE_/, "").toLowerCase().split("_").map(capitalise).join(" ");
}

// Work out where each state's number goes, in image pixels relative to the top of the map.
// Every state with a value gets a label: it's sized to fit inside the state where possible,
// and moved to the nearest free spot (with a leader line back to the state) if it doesn't
// fit or would overlap another label. Smallest states are placed first so they get the spots
// nearest to them. Anything that still can't be placed is returned in `unplaced`.
function planNumbers(measure, mode, { scale, u, font, avoid, W, mapH }) {
  const spots = labelSpots(app.renderer.pixels);
  const floor = 7; // smallest size (px) that's still readable when zoomed in
  const maxSize = 1.4 * u;
  const items = app.states
    .map((s, i) => ({ s, spot: spots[i + 1], v: mode.value(s) }))
    .filter((o) => o.v > 0 && o.spot)
    .sort((a, b) => a.spot.r - b.spot.r);

  // Placed label rectangles, bucketed on a coarse grid for quick overlap checks
  const bucket = Math.max(16, 3 * u);
  const grid = new Map();
  const cellsOf = (r) => {
    const keys = [];
    for (let gx = Math.floor(r.x0 / bucket); gx <= Math.floor(r.x1 / bucket); gx++) {
      for (let gy = Math.floor(r.y0 / bucket); gy <= Math.floor(r.y1 / bucket); gy++) keys.push(`${gx},${gy}`);
    }
    return keys;
  };
  const overlaps = (r) => cellsOf(r).some((k) => (grid.get(k) || []).some((p) =>
    r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0));
  const add = (r) => cellsOf(r).forEach((k) => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(r); });
  if (avoid) add(avoid);

  const labels = [];
  const unplaced = [];
  for (const { s, spot } of items) {
    const text = mode.number ? mode.number(s) : String(mode.value(s));
    measure.font = `700 100px ${font}`;
    const unitW = measure.measureText(text).width / 100;
    const rPx = spot.r * scale;
    const size = Math.max(floor, Math.min(maxSize, (1.8 * rPx) / unitW, 1.5 * rPx));
    const halfW = (unitW * size) / 2 + size * 0.12;
    const halfH = size * 0.58;
    const ax = spot.x * scale;
    const ay = spot.y * scale;

    let found = null;
    const maxRing = 8; // only short moves, so leader lines stay short and readable
    for (let ring = 0; ring <= maxRing && !found; ring++) {
      const dist = ring * size * 0.75;
      const steps = ring === 0 ? 1 : 8 + ring * 2;
      for (let k = 0; k < steps; k++) {
        const angle = (k / steps) * Math.PI * 2;
        const cx = ax + Math.cos(angle) * dist;
        const cy = ay + Math.sin(angle) * dist * 0.7; // prefer moving sideways over up/down
        const r = { x0: cx - halfW, x1: cx + halfW, y0: cy - halfH, y1: cy + halfH };
        if (r.x0 < 0 || r.y0 < 0 || r.x1 > W || r.y1 > mapH) continue;
        if (overlaps(r)) continue;
        found = { cx, cy, r, moved: dist > rPx * 0.6 };
        break;
      }
    }
    if (!found) {
      unplaced.push({ name: prettyStateName(s.name), text });
      continue;
    }
    add(found.r);
    labels.push({ text, size, x: found.cx, y: found.cy, ax, ay, rect: found.r, leader: found.moved });
  }
  return { labels, unplaced };
}

function drawNumbers(ctx, plan, top) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Leader lines first, so the numbers sit on top of them
  for (const l of plan.labels) {
    if (!l.leader) continue;
    const ex = Math.max(l.rect.x0, Math.min(l.ax, l.rect.x1));
    const ey = Math.max(l.rect.y0, Math.min(l.ay, l.rect.y1));
    const w = Math.max(1, l.size * 0.08);
    ctx.beginPath();
    ctx.moveTo(l.ax, top + l.ay);
    ctx.lineTo(ex, top + ey);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.lineWidth = w + 1.5;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(l.ax, top + l.ay, Math.max(1.5, l.size * 0.14), 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const l of plan.labels) {
    ctx.font = `700 ${l.size}px ${'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'}`;
    ctx.lineWidth = Math.max(1, l.size * 0.12);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.strokeText(l.text, l.x, top + l.y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(l.text, l.x, top + l.y);
  }
  ctx.restore();
}

// Coarse grid of the map marking cells that contain any land (any state), with a
// summed-area table so "is there land in this rectangle?" is a constant-time lookup.
function landGrid(px) {
  if (landGridCache && landGridCache.px === px) return landGridCache;
  const cell = Math.max(2, Math.round(px.width / 256));
  const cols = Math.ceil(px.width / cell);
  const rows = Math.ceil(px.height / cell);
  const land = new Uint8Array(cols * rows);
  for (let y = 0, p = 0; y < px.height; y++) {
    const row = ((y / cell) | 0) * cols;
    for (let x = 0; x < px.width; x++, p++) {
      if (px.stateIndex[p]) land[row + ((x / cell) | 0)] = 1;
    }
  }
  const sat = new Int32Array((cols + 1) * (rows + 1));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      sat[(y + 1) * (cols + 1) + x + 1] = land[y * cols + x]
        + sat[y * (cols + 1) + x + 1] + sat[(y + 1) * (cols + 1) + x] - sat[y * (cols + 1) + x];
    }
  }
  landGridCache = { px, cell, cols, rows, sat };
  return landGridCache;
}

// Land cells in a rectangle of cells. With edgesAreLand, any part outside the map counts as land,
// so the edge of the image is treated like a coast.
function landIn(g, x0, y0, x1, y1, edgesAreLand) {
  if (edgesAreLand && (x0 < 0 || y0 < 0 || x1 > g.cols || y1 > g.rows)) return 1;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(g.cols, x1); y1 = Math.min(g.rows, y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  const w = g.cols + 1;
  return g.sat[y1 * w + x1] - g.sat[y0 * w + x1] - g.sat[y1 * w + x0] + g.sat[y0 * w + x0];
}

// Find open sea for a w x h cell block. Widens the required gap to the coast step by step
// and keeps the placement with the biggest gap. Prefers open sea away from the image edges,
// and only uses sea along the edges if there's nowhere else. Returns { x, y } in cells, or null.
function findOpenSea(g, w, h) {
  for (const edgesAreLand of [true, false]) {
    let best = null;
    for (let gap = 1; gap <= 60; gap++) {
      const spots = [];
      for (let y = 1; y + h < g.rows; y++) {
        for (let x = 1; x + w < g.cols; x++) {
          if (!landIn(g, x - gap, y - gap, x + w + gap, y + h + gap, edgesAreLand)) spots.push({ x, y });
        }
      }
      if (!spots.length) break;
      best = spots[spots.length >> 1]; // middle of the most open area
    }
    if (best) return best;
  }
  return null;
}

// placement: "ocean" (find open sea, falling back to above the map) or "top".
// Widths tried by "auto": the first one where every state's number fits is used.
const AUTO_WIDTHS = [4096, 6144, 8192, 12288, 16384];

function autoWidth(mode, px, numbers) {
  if (!numbers || !mode.value) return AUTO_WIDTHS[0];
  const measure = document.createElement("canvas").getContext("2d");
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  for (const W of AUTO_WIDTHS) {
    const scale = W / px.width;
    const plan = planNumbers(measure, mode, { scale, u: W / 100, font, avoid: null, W, mapH: px.height * scale });
    if (!plan.unplaced.length) return W;
  }
  return AUTO_WIDTHS[AUTO_WIDTHS.length - 1];
}

function renderMapImage(mode, { title, subtitle, width, outlineChanges, placement, numbers }) {
  const px = app.renderer.pixels;
  const W = width === "full" ? px.width
    : width === "auto" ? autoWidth(mode, px, numbers)
    : Math.min(Number(width), px.width * 4);
  const scale = W / px.width;

  // The map itself, at full size
  if (!fullMapCache) {
    const c = document.createElement("canvas");
    c.width = px.width;
    c.height = px.height;
    const ctx = c.getContext("2d");
    fullMapCache = { canvas: c, ctx, image: ctx.createImageData(px.width, px.height) };
  }
  const pal = buildPalettes(mode, { selected: 0, outlineChanges });
  const stripeShift = Math.max(1, Math.round(Math.log2(6 / scale))); // stripes about 6px wide in the image
  MapRenderer.paint(px, new Uint32Array(fullMapCache.image.data.buffer), pal.fill, pal.border, pal.stripe, stripeShift);
  fullMapCache.ctx.putImageData(fullMapCache.image, 0, 0);

  // Layout, scaled to the image width
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue("--bg").trim();
  const text = css.getPropertyValue("--text").trim();
  const muted = css.getPropertyValue("--muted").trim();
  const u = W / 100;
  const pad = 2 * u;
  const keySize = 1.2 * u;
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const mapH = Math.round(px.height * scale);
  const keyH = keySize * 4;

  // Title block size for a given text scale
  const measure = document.createElement("canvas").getContext("2d");
  const block = (f) => {
    const titleSize = 2.6 * u * f;
    const subSize = 1.3 * u * f;
    measure.font = `700 ${titleSize}px ${font}`;
    let w = measure.measureText(title).width;
    if (subtitle) {
      measure.font = `400 ${subSize}px ${font}`;
      w = Math.max(w, measure.measureText(subtitle).width);
    }
    return { titleSize, subSize, w, h: titleSize * 1.2 + (subtitle ? subSize * 1.8 : 0) };
  };

  // In the ocean: try the full size first, then smaller, until the title fits in open sea
  let titleAt = null;
  if (placement === "ocean") {
    const g = landGrid(px);
    const cellPx = g.cell * scale;
    for (const f of [1, 0.85, 0.7, 0.55, 0.45]) {
      const b = block(f);
      const spot = findOpenSea(g, Math.ceil(b.w / cellPx), Math.ceil(b.h / cellPx));
      if (spot) {
        titleAt = { ...b, x: spot.x * cellPx, y: spot.y * cellPx };
        break;
      }
    }
  }
  const header = titleAt ? null : block(1);
  const headerH = header ? pad + header.h + pad * 0.7 : 0;

  let plan = null;
  if (numbers && mode.value) {
    const avoid = titleAt ? { x0: titleAt.x, x1: titleAt.x + titleAt.w, y0: titleAt.y, y1: titleAt.y + titleAt.h } : null;
    plan = planNumbers(measure, mode, { scale, u, font, avoid, W, mapH });
  }

  // States whose number didn't fit anywhere on the map are listed under the key
  const listLines = [];
  if (plan && plan.unplaced.length) {
    measure.font = `400 ${keySize}px ${font}`;
    let line = "No room on the map for: ";
    for (const [i, item] of plan.unplaced.entries()) {
      const part = `${item.name} ${item.text}${i < plan.unplaced.length - 1 ? " · " : ""}`;
      if (measure.measureText(line + part).width > W - 2 * pad) {
        listLines.push(line);
        line = "";
      }
      line += part;
    }
    listLines.push(line);
  }
  const listH = listLines.length ? listLines.length * keySize * 1.6 + pad * 0.5 : 0;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Math.round(headerH + mapH + keyH + listH);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const drawTitle = (b, x, y, titleColour, subColour) => {
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = titleColour;
    ctx.font = `700 ${b.titleSize}px ${font}`;
    ctx.fillText(title, x, y + b.titleSize);
    if (subtitle) {
      ctx.fillStyle = subColour;
      ctx.font = `400 ${b.subSize}px ${font}`;
      ctx.fillText(subtitle, x, y + b.titleSize * 1.2 + b.subSize * 1.4);
    }
  };
  if (header) drawTitle(header, pad, pad, text, muted);

  ctx.imageSmoothingEnabled = scale < 1; // smooth when shrinking, keep pixels crisp when enlarging
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(fullMapCache.canvas, 0, headerH, W, mapH);

  // The sea is dark in both themes, so the title over it is always light
  if (titleAt) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = titleAt.titleSize * 0.15;
    drawTitle(titleAt, titleAt.x, titleAt.y, "#eef0f2", "#a9b8c8");
    ctx.restore();
  }

  if (plan) drawNumbers(ctx, plan, headerH);

  // Colour key
  const y = headerH + mapH + keyH / 2;
  const sw = keySize * 1.1;
  let x = pad;
  ctx.font = `400 ${keySize}px ${font}`;
  ctx.textBaseline = "middle";
  const label = (t, colour = text) => {
    ctx.fillStyle = colour;
    ctx.fillText(t, x, y);
    x += ctx.measureText(t).width + keySize * 0.8;
  };
  if (pal.mode.value) {
    // "none" swatch with stripes
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y - sw / 2, sw, sw);
    ctx.clip();
    ctx.fillStyle = rgbCss(NONE_A);
    ctx.fillRect(x, y - sw / 2, sw, sw);
    ctx.strokeStyle = rgbCss(NONE_B);
    ctx.lineWidth = sw / 5;
    for (let d = -sw; d < sw * 2; d += sw / 2.5) {
      ctx.beginPath();
      ctx.moveTo(x + d, y + sw / 2);
      ctx.lineTo(x + d + sw, y - sw / 2);
      ctx.stroke();
    }
    ctx.restore();
    x += sw + keySize * 0.5;
    label("None", muted);
    x += keySize;
    if (pal.mode.arable) label("Arable land:", muted);
    label("1", muted);
    const gw = 14 * u;
    const grad = ctx.createLinearGradient(x, 0, x + gw, 0);
    grad.addColorStop(0, rgbCss(pal.low));
    grad.addColorStop(1, rgbCss(pal.mode.colour));
    ctx.fillStyle = grad;
    ctx.fillRect(x, y - sw / 2, gw, sw);
    x += gw + keySize * 0.6;
    label(String(pal.max), muted);
    x += keySize;
  }
  if (outlineChanges && app.changes.size) {
    ctx.strokeStyle = rgbCss(CHANGED_BORDER);
    ctx.lineWidth = Math.max(2, sw / 6);
    ctx.strokeRect(x, y - sw / 2, sw, sw);
    x += sw + keySize * 0.5;
    label("Pending changes", muted);
    x += keySize;
  }
  if (numbers && pal.mode.numberHint) {
    label(`Numbers: ${pal.mode.numberHint}`, muted);
    x += keySize;
  }
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  ctx.fillText("HMPS Resource Editor", W - pad, y);
  ctx.textAlign = "left";

  listLines.forEach((line, i) => {
    ctx.fillStyle = text;
    ctx.fillText(line, pad, headerH + mapH + keyH + keySize * (0.8 + i * 1.6));
  });

  return canvas;
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't create the image"))), "image/png"));
}

function setupImageExport() {
  const dialog = $("imageDialog");
  const form = $("imageForm");
  const status = $("imageStatus");
  const options = () => ({
    width: form.elements.width.value,
    theme: form.elements.theme.value,
    placement: form.elements.placement.value,
    numbers: form.elements.numbers.checked,
    outlineChanges: form.elements.outlineChanges.checked,
  });
  const busy = (on) => ["btnImageSave", "btnImageAll"].forEach((id) => { $(id).disabled = on; });

  $("btnImage").addEventListener("click", () => {
    const mode = currentMode();
    form.elements.title.value = modeTitle(mode);
    form.elements.subtitle.value = modeSubtitle(mode);
    status.textContent = "";
    status.classList.remove("error");
    dialog.showModal();
  });

  $("btnImageSave").addEventListener("click", async () => {
    const o = options();
    const title = form.elements.title.value.trim() || modeTitle(currentMode());
    busy(true);
    status.textContent = "Drawing…";
    try {
      await new Promise((r) => setTimeout(r, 0));
      const canvas = withTheme(o.theme, () => renderMapImage(currentMode(), { ...o, title, subtitle: form.elements.subtitle.value.trim() }));
      downloadBlob(`${fileSlug(title)}.png`, await canvasToPng(canvas));
      status.textContent = "Saved.";
    } catch (err) {
      console.error(err);
      status.textContent = err.message;
      status.classList.add("error");
    }
    busy(false);
  });

  // Checklist of maps for saving several at once; the selection is remembered between visits
  const PICK_KEY = "hmps-resource-editor:image-picks";
  const savedPicks = () => {
    try { return JSON.parse(localStorage.getItem(PICK_KEY) || "null"); } catch { return null; }
  };
  const picker = $("mapPicker");
  const pickBoxes = () => [...picker.querySelectorAll("input[data-mode]")];
  const updatePicks = () => {
    const boxes = pickBoxes();
    const picked = boxes.filter((b) => b.checked).map((b) => b.dataset.mode);
    $("pickCount").textContent = `${picked.length} of ${boxes.length} selected`;
    $("btnImageAll").disabled = !picked.length;
    picker.querySelectorAll("input[data-group]").forEach((g) => {
      const inGroup = boxes.filter((b) => b.dataset.groupName === g.dataset.group);
      const n = inGroup.filter((b) => b.checked).length;
      g.checked = n === inGroup.length;
      g.indeterminate = n > 0 && n < inGroup.length;
    });
    try { localStorage.setItem(PICK_KEY, JSON.stringify(picked)); } catch { /* storage unavailable */ }
  };

  function buildPicker() {
    const modes = colourModes();
    const saved = savedPicks();
    const isPicked = (m) => (saved ? saved.includes(m.key) : m.key !== "state");
    const groups = [...new Set(modes.map((m) => m.group || "General"))];
    picker.innerHTML = groups.map((g) => `
      <fieldset>
        <label class="group"><input type="checkbox" data-group="${esc(g)}"> ${esc(g)}</label>
        <div class="items">
          ${modes.filter((m) => (m.group || "General") === g).map((m) => `
            <label><input type="checkbox" data-mode="${esc(m.key)}" data-group-name="${esc(g)}" ${isPicked(m) ? "checked" : ""}>
              ${m.colour ? `<span class="swatch" style="background:${rgbCss(m.colour)}"></span>` : ""} ${esc(m.label)}</label>`).join("")}
        </div>
      </fieldset>`).join("");
    picker.querySelectorAll("input[data-group]").forEach((g) => {
      g.addEventListener("change", () => {
        pickBoxes().filter((b) => b.dataset.groupName === g.dataset.group).forEach((b) => { b.checked = g.checked; });
        updatePicks();
      });
    });
    pickBoxes().forEach((b) => b.addEventListener("change", updatePicks));
    updatePicks();
  }

  $("btnImage").addEventListener("click", buildPicker);
  $("btnPickAll").addEventListener("click", () => { pickBoxes().forEach((b) => { b.checked = true; }); updatePicks(); });
  $("btnPickNone").addEventListener("click", () => { pickBoxes().forEach((b) => { b.checked = false; }); updatePicks(); });

  $("btnImageAll").addEventListener("click", async () => {
    const o = options();
    const picked = new Set(pickBoxes().filter((b) => b.checked).map((b) => b.dataset.mode));
    const modes = colourModes().filter((m) => picked.has(m.key));
    const files = [];
    busy(true);
    try {
      for (const [i, mode] of modes.entries()) {
        status.textContent = `Drawing ${i + 1} of ${modes.length}: ${mode.label}…`;
        await new Promise((r) => setTimeout(r, 0)); // let the progress text paint
        const title = modeTitle(mode);
        const canvas = withTheme(o.theme, () => renderMapImage(mode, { ...o, title, subtitle: modeSubtitle(mode) }));
        const bytes = new Uint8Array(await (await canvasToPng(canvas)).arrayBuffer());
        const folder = mode.group ? `${fileSlug(mode.group)}/` : "";
        files.push({ path: `${folder}${fileSlug(title)}.png`, bytes });
      }
      downloadBlob("hmps_resource_maps.zip", MapPatch.zip(files));
      status.textContent = `Saved ${files.length} map${files.length === 1 ? "" : "s"}.`;
    } catch (err) {
      console.error(err);
      status.textContent = err.message;
      status.classList.add("error");
    }
    busy(false);
    updatePicks();
  });
}

// ---------- Setup screen ----------

function setupLoader() {
  let baseFiles = null;
  let modFiles = null;

  function describe(files, statusEl) {
    const { stateFiles, buildingFiles, provinces } = MapData.collectFiles(files);
    statusEl.textContent = `${stateFiles.size} state region files, ${provinces ? "provinces.png found" : "no provinces.png"}, ` +
      `${buildingFiles.size} building files`;
    statusEl.classList.toggle("ok", stateFiles.size > 0 || !!provinces);
  }

  $("baseInput").addEventListener("change", (e) => {
    baseFiles = e.target.files;
    describe(baseFiles, $("baseStatus"));
    $("btnLoad").disabled = false;
  });
  $("modInput").addEventListener("change", (e) => {
    modFiles = e.target.files;
    describe(modFiles, $("modStatus"));
  });

  $("btnLoad").addEventListener("click", async () => {
    const status = $("loadStatus");
    status.classList.remove("error");
    $("btnLoad").disabled = true;
    try {
      const data = await MapData.load(baseFiles, modFiles, (msg) => { status.textContent = msg; });
      startEditor(data);
    } catch (err) {
      console.error(err);
      status.textContent = err.message;
      status.classList.add("error");
      $("btnLoad").disabled = false;
    }
  });
}

function startEditor(data) {
  app.states = data.states;
  app.types = data.types;
  app.buildingsFromFiles = data.buildings;
  app.sources = data.sources;
  app.stateByName = new Map(data.states.map((s) => [s.name, s]));

  $("setup").hidden = true;
  $("main").hidden = false;
  $("mainActions").hidden = false;

  const select = $("colourMode");
  const modes = colourModes();
  const groups = [...new Set(modes.map((m) => m.group))];
  select.innerHTML = groups.map((g) => {
    const opts = modes.filter((m) => m.group === g).map((m) => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join("");
    return g ? `<optgroup label="${esc(g)}">${opts}</optgroup>` : opts;
  }).join("");
  select.addEventListener("change", () => {
    app.colourMode = select.value;
    scheduleRedraw();
  });

  if (data.warnings.length) {
    $("warningsPanel").hidden = false;
    $("warningCount").textContent = data.warnings.length;
    $("warningsList").innerHTML = data.warnings.map((w) => `<li>${esc(w)}</li>`).join("");
  }

  const tooltip = $("tooltip");
  app.renderer = new MapRenderer($("mapContainer"), $("mapCanvas"), data.pixels, {
    onHover(index, x, y) {
      if (!index) { tooltip.hidden = true; return; }
      const s = app.states[index - 1];
      const mode = currentMode();
      let text = s.name;
      if (mode.arable) {
        const [, r] = mode.key.split(":");
        text += ` — ${prettyResource(r)}: ${value(s, "arable", r) ? "yes" : "no"} (${s.arableLand} arable land)`;
      } else if (mode.value) {
        text += ` — ${mode.label}: ${mode.value(s)}`;
      }
      tooltip.textContent = text;
      tooltip.hidden = false;
      tooltip.style.left = `${x + 14}px`;
      tooltip.style.top = `${y + 14}px`;
    },
    onClick(index) {
      selectState(index, false);
    },
  });

  $("zoomIn").addEventListener("click", () => app.renderer.setZoom(app.renderer.zoom * 1.5));
  $("zoomOut").addEventListener("click", () => app.renderer.setZoom(app.renderer.zoom / 1.5));
  $("zoomFit").addEventListener("click", () => app.renderer.fit());

  setupSearch();
  renderChangesList();
  renderStatePanel();
  scheduleRedraw();
  requestAnimationFrame(() => app.renderer.fit());
}

loadLocal();
setupTheme();
setupLoader();
setupSettings();
setupExport();
setupImageExport();
