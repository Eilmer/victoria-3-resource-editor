// End-to-end test: run with NODE_PATH pointing at a playwright install.
//   python3 test/make_testdata.py && NODE_PATH=$(npm root -g) node test/e2e.js [output dir]
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

(async () => {
  const root = path.resolve(__dirname, "..");
  const out = process.argv[2] || __dirname;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", (d) => d.accept());

  await page.goto("file://" + path.join(root, "index.html"));
  await page.setInputFiles("#baseInput", path.join(__dirname, "testdata/base/map_data"));
  await page.setInputFiles("#modInput", path.join(__dirname, "testdata/mod"));
  check("mod folder status", (await page.textContent("#modStatus")).includes("1 building files"), await page.textContent("#modStatus"));
  await page.click("#btnLoad");
  await page.waitForSelector("#main:not([hidden])");
  await page.waitForTimeout(300);

  // Click STATE_ALPHA on the map
  const box = await page.locator("#mapCanvas").boundingBox();
  const zoom = await page.evaluate(() => app.renderer.zoom);
  await page.mouse.click(box.x + 40 * zoom, box.y + 50 * zoom);
  check("click selects ALPHA", (await page.textContent("#statePanel h2")) === "STATE_ALPHA");

  // Capped: +3 coal
  const coal = page.locator('.stepper[data-kind="capped"][data-res="bg_coal_mining"]');
  for (let i = 0; i < 3; i++) await coal.locator('button[data-step="1"]').click();
  // Arable: remove wheat, add rice
  await page.locator('input[data-arable="bg_wheat_farms"]').uncheck();
  await page.locator('input[data-arable="bg_rice_farms"]').check();

  // CHARLIE via search: discoverable edits
  await page.fill("#search", "charlie");
  await page.keyboard.press("Enter");
  check("search selects CHARLIE", (await page.textContent("#statePanel h2")) === "STATE_CHARLIE");
  const oilTotal = page.locator('.stepper[data-kind="total"][data-res="bg_oil_extraction"] input');
  check("oil total starts at 12", (await oilTotal.inputValue()) === "12", await oilTotal.inputValue());
  // Discover 5 oil
  await page.locator('.stepper[data-kind="discovered"][data-res="bg_oil_extraction"] input').fill("5");
  await page.locator('.stepper[data-kind="discovered"][data-res="bg_oil_extraction"] input').dispatchEvent("change");
  // Set rubber total from 10 to 15 -> undiscovered 6 -> 11
  await page.locator('.stepper[data-kind="total"][data-res="bg_rubber"] input').fill("15");
  await page.locator('.stepper[data-kind="total"][data-res="bg_rubber"] input').dispatchEvent("change");
  check("rubber undiscovered becomes 11",
    (await page.locator('.stepper[data-kind="undiscovered"][data-res="bg_rubber"] input').inputValue()) === "11");
  // Remove tea (building name comes from the mod's buildings file)
  await page.locator('input[data-arable="bg_tea_plantations"]').uncheck();

  const changes = await page.evaluate(() => JSON.stringify(Object.fromEntries(app.changes)));
  console.log("changes:", changes);

  // Screenshots of a few colour modes
  for (const mode of ["state", "capped:bg_coal_mining", "arable:bg_rice_farms", "total:bg_oil_extraction"]) {
    await page.selectOption("#colourMode", mode);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(out, `shot-${mode.replace(/[:]/g, "_")}.png`) });
  }

  // Export
  await page.click("#btnExport");
  const paths = await page.$$eval(".export-file header strong", (els) => els.map((e) => e.textContent.trim()));
  console.log("export files:", paths);
  const pres = await page.$$eval(".export-file pre", (els) => els.map((e) => e.textContent));
  const text = pres[0];
  console.log("----\n" + pres.join("\n----\n") + "\n----");
  const warnings = await page.$$eval(".export-warnings li", (els) => els.map((e) => e.textContent));
  console.log("export warnings:", warnings);
  check("history file in history folder", paths[0].startsWith("common/history/global/hmps_resource_changes.txt"), paths[0]);
  check("capped uses change_resource_potential", /change_resource_potential = \{\s+type = building_coal_mine\s+amount = 3/.test(text));
  check("arable add/remove", text.includes("add_resource_potential = building_rice_farm") && text.includes("remove_resource_potential = building_wheat_farm"));
  check("tea uses building from mod files", text.includes("remove_resource_potential = building_tea_plantation"));
  check("discoverable not in history file", !text.includes("building_oil_rig"));
  check("map file exported from mod copy", paths[1]?.startsWith("map_data/state_regions/01_east.txt") && paths[1].includes("mod's"), paths[1]);
  check("oil discovered written to map file", /type = "bg_oil_extraction"\s+undiscovered_amount = 12\s+discovered_amount = 5/.test(pres[1]), pres[1]);
  check("rubber undiscovered written to map file", /type = "bg_rubber"\s+discovered_amount = 4\s+undiscovered_amount = 11/.test(pres[1]));
  check("no warnings except guessed names", warnings.every((w) => w.startsWith("Building names were guessed")), warnings.join("; "));
  await page.screenshot({ path: path.join(out, "shot-export.png") });

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-download="0"]')]);
  const saved = path.join(out, "exported_history.txt");
  await dl.saveAs(saved);
  const bytes = fs.readFileSync(saved);
  check("file has BOM", bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);

  const [zipDl] = await Promise.all([page.waitForEvent("download"), page.click("#btnZip")]);
  const zipPath = path.join(out, "export.zip");
  await zipDl.saveAs(zipPath);
  const listing = require("child_process").execSync(`python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))" ${zipPath}`).toString().trim();
  check("zip is valid and laid out like a mod", listing === "common/history/global/hmps_resource_changes.txt\nmap_data/state_regions/01_east.txt", listing);
  const zipped = require("child_process").execSync(`python3 -c "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('map_data/state_regions/01_east.txt').decode('utf-8-sig'))" ${zipPath}`).toString();
  const original = fs.readFileSync(path.join(__dirname, "testdata/mod/map_data/state_regions/01_east.txt"), "utf-8").replace(/^﻿/, "");
  const diff = zipped.trimEnd().split("\n").filter((l, i, a) => !original.split("\n").includes(l));
  check("zipped map file only differs in the changed lines", JSON.stringify(diff) === JSON.stringify(["        undiscovered_amount = 11", "        discovered_amount = 5"]) ||
    JSON.stringify(diff.sort()) === JSON.stringify(["        discovered_amount = 5", "        undiscovered_amount = 11"].sort()), JSON.stringify(diff));

  // "Clear discoverable changes" keeps the history-file changes
  await page.click("#btnClearMap");
  const afterClear = await page.evaluate(() => Object.fromEntries(app.changes));
  check("clear map changes keeps the rest", !Object.keys(afterClear.STATE_CHARLIE.discovered).length &&
    !Object.keys(afterClear.STATE_CHARLIE.undiscovered).length && afterClear.STATE_CHARLIE.arable.bg_tea_plantations === -1 &&
    afterClear.STATE_ALPHA.capped.bg_coal_mining === 3, JSON.stringify(afterClear));

  // Re-import the history file: capped and arable come back
  await page.click("#btnClearAll");
  await page.setInputFiles("#importInput", saved);
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => Object.fromEntries(app.changes));
  const expected = JSON.parse(changes);
  for (const c of Object.values(expected)) { c.undiscovered = {}; c.discovered = {}; }
  const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort().map(([k, v]) =>
    [k, Object.fromEntries(["arable", "capped", "discovered", "undiscovered"].map((x) => [x, Object.fromEntries(Object.entries(v[x] || {}).sort())]))])));
  check("re-import round trip", norm(back) === norm(expected), `${norm(back)}\n  vs ${norm(expected)}`);

  // Import the hand-written example format
  const handWritten = path.join(out, "handwritten.txt");
  fs.writeFileSync(handWritten, `GLOBAL = {
	s:STATE_BRAVO = {
		change_resource_potential = {
			type = building_sulfur_mine
			amount = 15
		}
	}
	s:STATE_ALPHA = {
			add_resource_potential = building_rice_farm
				remove_resource_potential = building_wheat_farm
		}
}
`);
  await page.click("#btnClearAll");
  await page.setInputFiles("#importInput", handWritten);
  await page.waitForTimeout(200);
  const hw = await page.evaluate(() => Object.fromEntries(app.changes));
  check("hand-written import", hw.STATE_BRAVO?.capped?.bg_sulfur_mining === 15 &&
    hw.STATE_ALPHA?.arable?.bg_rice_farms === 1 && hw.STATE_ALPHA?.arable?.bg_wheat_farms === -1, JSON.stringify(hw));

  // "Everything into the map data files": no history file, capped and arable edits in the state region file
  await page.click("#btnSettings");
  check("target defaults to discoverable", await page.isChecked('#settingsForm input[name="target"][value="discoverable"]'));
  await page.check('#settingsForm input[name="target"][value="all"]');
  await page.screenshot({ path: path.join(out, "shot-settings.png") });
  await page.click('#settingsForm button[value="save"]');
  await page.click("#btnExport");
  const allPaths = await page.$$eval(".export-file header strong", (els) => els.map((e) => e.textContent.trim()));
  const allPres = await page.$$eval(".export-file pre", (els) => els.map((e) => e.textContent));
  console.log("all-in-map files:", allPaths, "\n" + allPres.join("\n----\n"));
  check("no history file when everything goes in map data", allPaths.length === 1 && allPaths[0].startsWith("map_data/state_regions/00_west.txt"), allPaths.join(", "));
  check("export says where changes go", (await page.textContent(".export-target")).includes("everything into the map data files"));
  check("capped written into map file", /capped_resources = \{[^}]*bg_sulfur_mining = 15/.test(allPres[0]), allPres[0]);
  check("arable written into map file", allPres[0].includes(`arable_resources = { "bg_livestock_ranches" "bg_rice_farms" }`), allPres[0]);
  await page.click("#btnClearMap");
  check("clear map changes clears everything in 'all' mode", await page.evaluate(() => app.changes.size) === 0);
  // Back to the default for the rest of the tests
  await page.click("#btnSettings");
  await page.check('#settingsForm input[name="target"][value="discoverable"]');
  await page.click('#settingsForm button[value="save"]');

  // Totals are labelled "discovered (undiscovered)"
  const oilLabel = await page.evaluate(() => colourModes().find((m) => m.key === "total:bg_oil_extraction").number(app.stateByName.get("STATE_CHARLIE")));
  check("total label is discovered (undiscovered)", oilLabel === "0 (12)", oilLabel);
  await page.selectOption("#colourMode", "total:bg_rubber");
  await page.click("#btnImage");
  await page.selectOption('#imageForm [name="width"]', "2048");
  const [rubber] = await Promise.all([page.waitForEvent("download"), page.click("#btnImageSave")]);
  await rubber.saveAs(path.join(out, "rubber-total.png"));
  await page.click('#imageForm button[value="cancel"]');

  // Map images: one PNG, then all maps as a zip
  await page.selectOption("#colourMode", "capped:bg_coal_mining");
  await page.click("#btnImage");
  check("image title prefilled", (await page.inputValue('#imageForm [name="title"]')) === "Coal mining");
  await page.selectOption('#imageForm [name="width"]', "2048");
  const [img] = await Promise.all([page.waitForEvent("download"), page.click("#btnImageSave")]);
  const imgPath = path.join(out, "map-image.png");
  await img.saveAs(imgPath);
  const png = fs.readFileSync(imgPath);
  check("PNG saved with title-sized header", img.suggestedFilename() === "coal_mining.png" && png.readUInt32BE(16) === Math.min(2048, 400 * 4) && png.readUInt32BE(20) > 800, `${img.suggestedFilename()} ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  await page.selectOption('#imageForm [name="theme"]', "light");
  await page.fill('#imageForm [name="title"]', "Oil and coal (light test)");
  const [img2] = await Promise.all([page.waitForEvent("download"), page.click("#btnImageSave")]);
  await img2.saveAs(path.join(out, "map-image-light.png"));
  check("app stays dark after light image", await page.evaluate(() => document.documentElement.dataset.theme) === "dark");
  const zipNames = (file) => require("child_process").execSync(`python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))" ${file}`).toString().trim().split("\n");
  const modeCount = await page.evaluate(() => colourModes().length);
  check("all maps except plain states ticked by default", (await page.textContent("#pickCount")) === `${modeCount - 1} of ${modeCount} selected`, await page.textContent("#pickCount"));
  const [allZip] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#btnImageAll")]);
  await allZip.saveAs(path.join(out, "maps.zip"));
  const names = zipNames(path.join(out, "maps.zip"));
  check("zip has every ticked map", names.length === modeCount - 1 && names.includes("capped_resources/coal_mining.png") &&
    names.includes("discoverable_resources/oil_extraction_total.png"), `${names.length} vs ${modeCount - 1}`);

  // Pick just two maps: one by hand, one whole group
  await page.click("#btnPickNone");
  check("None disables saving", await page.isDisabled("#btnImageAll"));
  await page.check('#mapPicker input[data-mode="capped:bg_sulfur_mining"]');
  await page.check('#mapPicker input[data-group="Arable"]');
  const arableCount = await page.evaluate(() => colourModes().filter((m) => m.group === "Arable").length);
  const [someZip] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#btnImageAll")]);
  await someZip.saveAs(path.join(out, "some-maps.zip"));
  const some = zipNames(path.join(out, "some-maps.zip"));
  console.log("selected zip:", some);
  check("zip has only the selected maps", some.length === arableCount + 1 && some.includes("capped_resources/sulfur_mining.png") &&
    some.every((n) => n.startsWith("arable/") || n === "capped_resources/sulfur_mining.png"), some.join(", "));

  // Selection is remembered when the dialog is reopened
  await page.click('#imageForm button[value="cancel"]');
  await page.click("#btnImage");
  check("selection remembered", (await page.textContent("#pickCount")) === `${arableCount + 1} of ${modeCount} selected`, await page.textContent("#pickCount"));
  await page.screenshot({ path: path.join(out, "shot-image-dialog.png") });
  await page.click('#imageForm button[value="cancel"]');

  check("no page errors", errors.length === 0, errors.join("; "));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
})();
