// Writes resource changes into copies of the state region files: capped resources,
// arable resources and discoverable resources.
//
// Only the numbers that change are touched: comments, spacing and everything else in the file
// stay exactly as they were, so the exported file is easy to diff against the original.

const MapPatch = (() => {
  // Offset of the start of the line containing pos, if only whitespace comes before pos on it.
  function lineStart(text, pos) {
    let i = pos;
    while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
    return i === 0 || text[i - 1] === "\n" ? i : pos;
  }

  // Offset just past the newline ending the line at pos, if only whitespace follows pos on it.
  function lineEnd(text, pos) {
    let i = pos;
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) i++;
    return i < text.length && text[i] === "\n" ? i + 1 : pos;
  }

  // Indentation of the first entry in a block, or the block's own indentation plus one step.
  function innerIndent(text, entry, step) {
    const first = entry.value.find((e) => e.start !== undefined);
    if (first) {
      const start = lineStart(text, first.start);
      if (start !== first.start) return text.slice(start, first.start);
    }
    const own = lineStart(text, entry.start);
    return (own !== entry.start ? text.slice(own, entry.start) : "") + step;
  }

  // Where to insert new lines inside a block: the start of the line holding its closing brace.
  // Returns { pos, prefix } where prefix is a newline if the brace shares a line with other content.
  function insertPoint(text, entry, nl) {
    const start = lineStart(text, entry.close);
    const ownLine = start === 0 || text[start - 1] === "\n";
    return ownLine ? { pos: start, prefix: "" } : { pos: entry.close, prefix: nl };
  }

  // Add one item inside a block: on its own line if the block spans several lines,
  // otherwise inline before the closing brace (e.g. arable_resources = { "a" "b" }).
  function insertItem(text, block, itemText, ind, nl) {
    const at = insertPoint(text, block, nl);
    if (!at.prefix) return { start: at.pos, end: at.pos, text: `${ind}${itemText}${nl}` };
    const pad = text[block.close - 1] === " " ? `${itemText} ` : ` ${itemText}`;
    return { start: block.close, end: block.close, text: pad };
  }

  // Remove an item: the whole line if it's alone on it, otherwise just the item and the space before it.
  function removeItem(text, start, end) {
    const ls = lineStart(text, start);
    const le = lineEnd(text, end);
    if ((ls === 0 || text[ls - 1] === "\n") && le !== end) return { start: ls, end: le, text: "" };
    let s = start;
    while (s > 0 && (text[s - 1] === " " || text[s - 1] === "\t")) s--;
    return { start: s, end, text: "" };
  }

  // states: loaded states. sources: Map(fileName -> { name, origin, text }).
  // targets: Map(stateName -> {
  //   capped:       { resource: new amount },
  //   arable:       { resource: true (allowed) / false (not allowed) },
  //   discoverable: { resource: { discovered, undiscovered } } })
  // Returns { files: [{ name, origin, text }], warnings }
  function build(states, targets, sources) {
    const warnings = [];
    const editsByFile = new Map();

    for (const s of states) {
      const want = targets.get(s.name);
      if (!want) continue;
      if (s.injectedFrom) {
        warnings.push(`${s.name} is changed by INJECT in ${s.injectedFrom}; edit it by hand`);
        continue;
      }
      const src = sources.get(s.file);
      const text = src.text;
      const nl = text.includes("\r\n") ? "\r\n" : "\n";
      const step = /\n\t/.test(text) ? "\t" : "    ";
      const edits = editsByFile.get(s.file) || [];
      editsByFile.set(s.file, edits);
      const stateInd = innerIndent(text, s.entry, step);
      const findBlock = (key) => s.entry.value.find((e) => e.key === key && Array.isArray(e.value));

      // Capped resources: capped_resources = { building_coal_mine = 10 }
      const capped = Object.entries(want.capped || {}).sort();
      if (capped.length) {
        const block = findBlock("capped_resources");
        if (!block) {
          const lines = capped.filter(([, v]) => v > 0).map(([r, v]) => `${stateInd}${step}${r} = ${v}${nl}`).join("");
          if (lines) {
            const at = insertPoint(text, s.entry, nl);
            edits.push({ start: at.pos, end: at.pos, text: `${at.prefix}${stateInd}capped_resources = {${nl}${lines}${stateInd}}${nl}` });
          }
        } else {
          const ind = innerIndent(text, block, step);
          for (const [r, v] of capped) {
            const e = block.value.find((x) => x.key === r && typeof x.value === "string");
            if (e && v) {
              if (Number(e.value) !== v) edits.push({ start: e.valueStart, end: e.valueEnd, text: String(v) });
            } else if (e && !v) {
              edits.push(removeItem(text, e.start, e.valueEnd));
            } else if (!e && v) {
              edits.push(insertItem(text, block, `${r} = ${v}`, ind, nl));
            }
          }
        }
      }

      // Arable: arable_resources = { "bg_wheat_farms" "bg_rice_farms" }
      const arable = Object.entries(want.arable || {}).sort();
      if (arable.length) {
        const block = findBlock("arable_resources");
        const items = block ? block.value.filter((x) => x.key === undefined && typeof x.value === "string") : [];
        const quoted = !items.length || text[items[0].valueStart] === '"';
        const q = (r) => (quoted ? `"${r}"` : r);
        if (!block) {
          const add = arable.filter(([, on]) => on).map(([r]) => q(r));
          if (add.length) {
            const at = insertPoint(text, s.entry, nl);
            edits.push({ start: at.pos, end: at.pos, text: `${at.prefix}${stateInd}arable_resources = { ${add.join(" ")} }${nl}` });
          }
        } else {
          const ind = innerIndent(text, block, step);
          for (const [r, on] of arable) {
            const item = items.find((x) => x.value === r);
            if (on && !item) edits.push(insertItem(text, block, q(r), ind, nl));
            if (!on && item) edits.push(removeItem(text, item.valueStart, item.valueEnd));
          }
        }
      }

      // Discoverable: resource = { type = "bg_oil_extraction" discovered_amount = 2 undiscovered_amount = 5 }
      for (const [type, amounts] of Object.entries(want.discoverable || {}).sort()) {
        const blocks = s.entry.value.filter((e) => e.key === "resource" && Array.isArray(e.value) &&
          PdxParser.get(e.value, "type") === type);
        if (blocks.length > 1) {
          warnings.push(`${s.name} has ${blocks.length} resource blocks for ${type}; edit it by hand`);
          continue;
        }

        if (!blocks.length) {
          if (!amounts.discovered && !amounts.undiscovered) continue;
          let block = `${stateInd}resource = {${nl}${stateInd}${step}type = "${type}"${nl}`;
          if (amounts.discovered) block += `${stateInd}${step}discovered_amount = ${amounts.discovered}${nl}`;
          if (amounts.undiscovered) block += `${stateInd}${step}undiscovered_amount = ${amounts.undiscovered}${nl}`;
          block += `${stateInd}}${nl}`;
          const at = insertPoint(text, s.entry, nl);
          edits.push({ start: at.pos, end: at.pos, text: at.prefix + block });
          continue;
        }

        const block = blocks[0];
        if (!amounts.discovered && !amounts.undiscovered) {
          // Nothing left: remove the whole resource block
          edits.push({ start: lineStart(text, block.start), end: lineEnd(text, block.close + 1), text: "" });
          continue;
        }

        const ind = innerIndent(text, block, step);
        for (const [key, amount] of [["discovered_amount", amounts.discovered], ["undiscovered_amount", amounts.undiscovered]]) {
          const e = block.value.find((x) => x.key === key && typeof x.value === "string");
          if (e && amount) {
            if (Number(e.value) !== amount) edits.push({ start: e.valueStart, end: e.valueEnd, text: String(amount) });
          } else if (e && !amount) {
            edits.push({ start: lineStart(text, e.start), end: lineEnd(text, e.valueEnd), text: "" });
          } else if (!e && amount) {
            const at = insertPoint(text, block, nl);
            edits.push({ start: at.pos, end: at.pos, text: `${at.prefix}${ind}${key} = ${amount}${nl}` });
          }
        }
      }
    }

    const files = [];
    for (const [fileName, edits] of editsByFile) {
      if (!edits.length) continue;
      let text = sources.get(fileName).text;
      // Apply from the end so earlier offsets stay valid; equal offsets keep their original order
      edits.map((e, i) => ({ ...e, i }))
        .sort((a, b) => b.start - a.start || b.i - a.i)
        .forEach((e) => { text = text.slice(0, e.start) + e.text + text.slice(e.end); });
      const src = sources.get(fileName);
      files.push({ name: src.name, origin: src.origin, text });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { files, warnings };
  }

  // ---------- Minimal zip writer (no compression) ----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ path, bytes: Uint8Array }] -> Blob
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.path);
      const crc = crc32(f.bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint32(14, crc, true);
      local.setUint32(18, f.bytes.length, true);
      local.setUint32(22, f.bytes.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local, name, f.bytes);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, f.bytes.length, true);
      cen.setUint32(24, f.bytes.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen, name);

      offset += 30 + name.length + f.bytes.length;
    }

    const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  return { build, zip };
})();

if (typeof module !== "undefined") module.exports = MapPatch;
