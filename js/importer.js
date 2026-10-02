// Parsers for extracted Noita game data (gun_actions.lua, translation CSV, entity XML).
// Pure string functions so they can run in the browser and under Node tests.
import { parseSpawn, typeByKey, ENEMY_FIELDS, PROJ_FIELDS } from './data.js';

// Splits the top-level entries of `actions = { {...}, {...} }`, skipping strings & comments.
export function splitActionEntries(src) {
  const start = src.search(/actions\s*=\s*\{/);
  if (start < 0) return [];
  let i = src.indexOf('{', start) + 1;
  const entries = [];
  let depth = 1;
  let entryStart = -1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '-' && src[i + 1] === '-') {
      const long = src.slice(i + 2).match(/^\[(=*)\[/);
      if (long) {
        const close = ']' + long[1] + ']';
        const end = src.indexOf(close, i + 2 + long[0].length);
        i = end < 0 ? src.length : end + close.length;
      } else {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? src.length : nl + 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (ch === '[') {
      const long = src.slice(i).match(/^\[(=*)\[/);
      if (long) {
        const close = ']' + long[1] + ']';
        const end = src.indexOf(close, i + long[0].length);
        i = end < 0 ? src.length : end + close.length;
        continue;
      }
    }
    if (ch === '{') {
      if (depth === 1) entryStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 1 && entryStart >= 0) { entries.push(src.slice(entryStart, i + 1)); entryStart = -1; }
    }
    i++;
  }
  return entries;
}

const strField = (body, k) => {
  const m = body.match(new RegExp('(?:^|[\\s,{])' + k + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : undefined;
};
const numField = (body, k) => {
  const m = body.match(new RegExp('(?:^|[\\s,{])' + k + '\\s*=\\s*(-?[\\d.]+)'));
  return m ? Number(m[1]) : undefined;
};
const deltaIn = (fn, lhs) => {
  // matches e.g. `c.fire_rate_wait = c.fire_rate_wait + 10` or `- 5`
  const esc = lhs.replace(/\./g, '\\.');
  const m = fn.match(new RegExp(esc + '\\s*=\\s*' + esc + '\\s*([+-])\\s*([\\d.]+)'));
  return m ? (m[1] === '-' ? -1 : 1) * Number(m[2]) : 0;
};

export function parseGunActions(src, translations = {}) {
  const spells = [];
  for (const body of splitActionEntries(src)) {
    const id = strField(body, 'id');
    if (!id) continue;
    const typeM = body.match(/type\s*=\s*(ACTION_TYPE_\w+)/);
    const fnIdx = body.search(/action\s*=\s*function/);
    const fn = fnIdx >= 0 ? body.slice(fnIdx) : '';
    const header = fnIdx >= 0 ? body.slice(0, fnIdx) : body;
    const rel = header.match(/related_projectiles\s*=\s*\{\s*"([^"]+)"/);
    const addProj = fn.match(/add_projectile(?:_trigger_\w+)?\s*\(\s*"([^"]+)"/);
    const rawName = strField(header, 'name') || id;
    const rawDesc = strField(header, 'description') || '';
    spells.push({
      id,
      name: tr(rawName, translations),
      description: tr(rawDesc, translations),
      type: typeM ? (typeByKey(typeM[1])?.code ?? 5) : 5,
      mana: numField(header, 'mana') ?? 0,
      max_uses: numField(header, 'max_uses') ?? -1,
      price: numField(header, 'price') ?? 0,
      spawn: parseSpawn(strField(header, 'spawn_level'), strField(header, 'spawn_probability')),
      sprite: strField(header, 'sprite') || '',
      fire_rate_wait: deltaIn(fn, 'c.fire_rate_wait'),
      reload: deltaIn(fn, 'current_reload_time'),
      spread: deltaIn(fn, 'c.spread_degrees'),
      projectile: rel ? rel[1] : addProj ? addProj[1] : null,
      proj: null,
    });
  }
  return spells;
}

export function tr(key, translations) {
  if (key && key.startsWith('$')) return translations[key.slice(1)] || key;
  return key;
}

// data/translations/common.csv: key,en,...  (fields may be quoted)
export function parseTranslations(csv) {
  const out = {};
  for (const line of csv.split(/\r?\n/)) {
    if (!line) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length && cells.length < 2; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
    }
    if (cells.length < 2) cells.push(cur);
    if (cells[0] && cells[1]) out[cells[0]] = cells[1];
  }
  return out;
}

// Returns the attribute value of the first <tag ...> that has it.
export function xmlAttr(xml, tag, attr) {
  const re = new RegExp('<' + tag + '(\\s[^>]*)?>', 'g');
  let m;
  while ((m = re.exec(xml))) {
    const a = (m[1] || '').match(new RegExp('\\s' + attr + '\\s*=\\s*"([^"]*)"'));
    if (a) return a[1];
  }
  return undefined;
}

function readFields(xml, fields) {
  const out = {};
  for (const f of fields) {
    const v = xmlAttr(xml, f.tag, f.attr);
    if (v === undefined) continue;
    if (f.kind === 'text') out[f.key] = v;
    else if (f.kind === 'bool') out[f.key] = v === '1' || v === 'true';
    else { const n = Number(v); if (!Number.isNaN(n)) out[f.key] = round(n * (f.scale || 1)); }
  }
  return out;
}

export const round = (n) => Math.round(n * 1000) / 1000;

export function parseProjectileXml(xml) {
  return readFields(xml, PROJ_FIELDS.map((f) => ({ ...f, kind: 'num' })));
}

export function parseEnemyXml(xml, file, translations = {}) {
  const nameM = xml.match(/<Entity[^>]*\sname\s*=\s*"([^"]*)"/);
  const base = file.split('/').pop().replace(/\.xml$/, '');
  const name = nameM ? tr(nameM[1], translations) : base;
  const isEnemy = /DamageModelComponent/.test(xml) && /(AnimalAIComponent|enemy|mortal)/.test(xml);
  return {
    file, name: name.startsWith('$') ? base : name, biome: '', isEnemy, attrs: readFields(xml, ENEMY_FIELDS),
  };
}
