// Parser for Paradox (Jomini) script files, e.g. map_data/state_regions/*.txt
//
// A parsed block is an array of entries. Each entry is one of:
//   { key: "id", op: "=", value: "3000" }          key = value
//   { key: "provinces", op: "=", value: [...] }    key = { ... }  (value is another block)
//   { value: "x1A2B3C" }                           a bare item inside a list, e.g. provinces = { "x1A2B3C" }
//
// Values are kept as strings; callers convert to numbers where needed.
// Entries also record where they are in the source text, so files can be edited in place:
//   start          offset of the key (or bare item)
//   valueStart/End offsets of a plain value, including any quotes
//   open/close     offsets of the "{" and "}" of a block value

const PdxParser = (() => {
  const OPERATORS = ["?=", "<=", ">=", "!=", "==", "=", "<", ">"];

  function tokenize(text) {
    const tokens = [];
    let i = 0;
    const n = text.length;
    let line = 1;

    while (i < n) {
      const c = text[i];

      if (c === "\n") { line++; i++; continue; }
      if (c === " " || c === "\t" || c === "\r" || c === "﻿") { i++; continue; }

      // Comments run to the end of the line
      if (c === "#") {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }

      if (c === "{" || c === "}") {
        tokens.push({ type: c, line, start: i, end: i + 1 });
        i++;
        continue;
      }

      const op = OPERATORS.find((o) => text.startsWith(o, i));
      if (op) {
        tokens.push({ type: "op", value: op, line, start: i, end: i + op.length });
        i += op.length;
        continue;
      }

      if (c === '"') {
        let j = i + 1;
        let s = "";
        while (j < n && text[j] !== '"') {
          if (text[j] === "\\" && j + 1 < n) { s += text[j + 1]; j += 2; continue; }
          if (text[j] === "\n") line++;
          s += text[j];
          j++;
        }
        tokens.push({ type: "word", value: s, quoted: true, line, start: i, end: j + 1 });
        i = j + 1;
        continue;
      }

      // Bare word: runs until whitespace, a brace, an operator start, a quote or a comment
      let j = i;
      while (j < n && !/[\s{}=<>!?"#]/.test(text[j])) j++;
      if (j === i) {
        // Unknown stray character; skip it rather than looping forever
        i++;
        continue;
      }
      tokens.push({ type: "word", value: text.slice(i, j), line, start: i, end: j });
      i = j;
    }
    return tokens;
  }

  function parse(text) {
    const tokens = tokenize(text);
    let pos = 0;
    let lastClose = text.length; // offset of the "}" that ended the most recent block
    const warnings = [];

    function parseBlock(isRoot) {
      const entries = [];
      while (pos < tokens.length) {
        const t = tokens[pos];

        if (t.type === "}") {
          if (isRoot) {
            warnings.push(`Unexpected "}" on line ${t.line}`);
            pos++;
            continue;
          }
          pos++;
          lastClose = t.start;
          return entries;
        }

        if (t.type === "{") {
          // Anonymous block inside a list, e.g. { { ... } { ... } }
          pos++;
          const value = parseBlock(false);
          entries.push({ value, start: t.start, open: t.start, close: lastClose });
          continue;
        }

        if (t.type === "op") {
          warnings.push(`Unexpected "${t.value}" on line ${t.line}`);
          pos++;
          continue;
        }

        // A word: either "key op value" or a bare list item
        const next = tokens[pos + 1];
        if (next && next.type === "op") {
          pos += 2;
          const v = tokens[pos];
          if (!v) {
            warnings.push(`Missing value after "${t.value}" on line ${t.line}`);
            break;
          }
          if (v.type === "{") {
            pos++;
            const value = parseBlock(false);
            entries.push({ key: t.value, op: next.value, value, start: t.start, open: v.start, close: lastClose });
          } else if (v.type === "word") {
            pos++;
            entries.push({ key: t.value, op: next.value, value: v.value, start: t.start, valueStart: v.start, valueEnd: v.end });
          } else {
            warnings.push(`Bad value after "${t.value}" on line ${t.line}`);
          }
        } else {
          pos++;
          entries.push({ value: t.value, start: t.start, valueStart: t.start, valueEnd: t.end });
        }
      }
      if (!isRoot) {
        warnings.push("File ended before a { was closed");
        lastClose = text.length;
      }
      return entries;
    }

    const root = parseBlock(true);
    return { root, warnings };
  }

  // --- Helpers for reading parsed blocks ---

  function get(block, key) {
    if (!Array.isArray(block)) return undefined;
    const e = block.find((x) => x.key === key);
    return e ? e.value : undefined;
  }

  function getAll(block, key) {
    if (!Array.isArray(block)) return [];
    return block.filter((x) => x.key === key).map((x) => x.value);
  }

  // Values of bare list items, e.g. provinces = { "x1" "x2" } -> ["x1", "x2"]
  function listValues(block) {
    if (!Array.isArray(block)) return [];
    return block.filter((x) => x.key === undefined && typeof x.value === "string").map((x) => x.value);
  }

  return { tokenize, parse, get, getAll, listValues };
})();

if (typeof module !== "undefined") module.exports = PdxParser;
