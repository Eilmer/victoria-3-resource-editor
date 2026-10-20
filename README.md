# HMPS Resource Editor

A browser tool for editing Victoria 3 state resources: capped resources (coal, iron, logging, ...),
arable farms/plantations, and discoverable resources (oil, rubber, gold fields). It reads a map's
`state_regions` and `provinces.png`, shows the map, and exports:

- a history file using `change_resource_potential`, `add_resource_potential` and
  `remove_resource_potential` for capped and arable resources
- edited copies of the state region files for discoverable resources (the game has no effect
  for undiscovered amounts), or for everything if you choose. Only the changed values are
  touched; comments and formatting stay.

**Use it online:** https://eilmer.github.io/victoria-3-resource-editor/ (nothing is uploaded; everything
runs in your browser). Or download the repo and open `index.html`.

## Using it

1. Open `index.html` in Chrome or Edge (just double-click it; no server needed).
2. **Base map data**: pick `Victoria 3/game` (or just `game/map_data`). Picking the whole
   `game` folder also reads `common/buildings`, so building names come from the game files.
3. **Mod folder** (optional): pick your mod's root (or its `map_data`). Its files replace base
   files with the same name. If your mod replaces the whole map, pick it as the base instead.
4. Click a state (or search) and edit:
   - capped resources: − / + (shift-click = 5) or type a number
   - arable: tick or untick each farm / plantation type
   - discoverable: set discovered, undiscovered, or the total (changing the total keeps the
     discovered amount and puts the difference in undiscovered)
5. "Colour by" shows a map of any resource, arable type, or discoverable amount
   (total / discovered / undiscovered). Striped states have none.
6. **Export** gives you the history file and any edited state region files, one at a time or as
   a zip laid out like a mod folder. After copying edited map files into your mod, reload the tool
   with the updated mod and click **Clear map data changes**, or they'd be applied twice.
7. **Save image** saves the current map as a PNG with a title, subtitle and colour key
   (title and subtitle are editable). Tick any number of maps under **Save several maps** to
   save them all at once in a zip; the selection is remembered.
8. **Import history file** reads a history file (from this tool, or written by hand) back in.

Your changes and settings are remembered in the browser between visits.

## Output settings

**Where changes are written** (at the top of Output settings) decides which files Export makes:

- **Everything into the map data files**: capped, arable and discoverable changes are all written
  into copies of the state region files. No history file.
- **Discoverable resources into the map data files** (default): discovered and undiscovered amounts
  go in the map data files; capped and arable changes go in the history file.
- **Only undiscovered amounts into the map data files**: everything else goes in the history file.

The history file's format comes from the templates below that, so you can match the exact
format your mod uses.

State regions use building groups (`bg_wheat_farms`) but the effects need building names
(`building_wheat_farm`). These come from `common/buildings` when it's loaded, otherwise from
built-in defaults or a guess; the settings table shows which, and lets you override them.

## Files

- `js/parser.js`: reads Paradox script files
- `js/mapdata.js`: finds and loads map files, builds the pixel → state lookup
- `js/renderer.js`: draws the map, zoom/pan/click
- `js/exporter.js`: generates and re-imports the history file
- `js/mappatch.js`: edits state region files in place for discoverable resources; zip writer
- `js/app.js`: the user interface
- `test/`: test map generator and browser tests

## Tests

    python3 test/make_testdata.py
    node test/mappatch.test.js
    node test/exporter.test.js
    NODE_PATH=$(npm root -g) node test/e2e.js

## License

MIT. See [LICENSE](LICENSE).
