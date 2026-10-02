import {
  SPELL_TYPES, typeByCode, MAX_TIER, BUILTIN_SPELLS, BUILTIN_ENEMIES, ENEMY_FIELDS, PROJ_FIELDS,
  HERDS, MATERIALS, WAND_STATS, WAND_TIERS,
} from './data.js';
import { parseGunActions, parseTranslations, parseEnemyXml, parseProjectileXml } from './importer.js';
import { generateMod, sanitizeModId, sanitizeSpellId } from './generator.js';
import { makeZip } from './zip.js';

// ───────────────────────── helpers ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = (v) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtNum = (v) => (has(v) ? String(Math.round(Number(v) * 1000) / 1000) : '');
const isTextTarget = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

// Numeric input with relative expressions: "*2", "x1.5", "/2", "+=5", "-=5", "150%"; plain numbers are absolute.
export function parseNumInput(str, cur) {
  const s = String(str).trim().replace(',', '.');
  const c = Number(cur) || 0;
  let m;
  if ((m = s.match(/^[*x×]\s*(-?[\d.]+)$/i))) return c * Number(m[1]);
  if ((m = s.match(/^\/\s*(-?[\d.]+)$/))) return Number(m[1]) === 0 ? NaN : c / Number(m[1]);
  if ((m = s.match(/^\+=\s*(-?[\d.]+)$/))) return c + Number(m[1]);
  if ((m = s.match(/^-=\s*(-?[\d.]+)$/))) return c - Number(m[1]);
  if ((m = s.match(/^(-?[\d.]+)\s*%$/))) return c * Number(m[1]) / 100;
  if (/^(inf|∞|infinite|unlimited)$/i.test(s)) return -1;
  return s === '' ? NaN : Number(s);
}

// ───────────────────────── state ─────────────────────────
const LS_PROJECT = 'nmf.project.v1';
const LS_CATALOG = 'nmf.catalog.v1';

const newProject = () => ({
  meta: { name: 'My Noita Mod', id: '', description: '' },
  globals: {}, spellEdits: {}, customSpells: [], wandGen: { tiers: {} }, customWands: [],
  enemyEdits: {}, loadout: { spells: [] },
});
const builtinCatalog = () => ({ source: 'builtin', spells: clone(BUILTIN_SPELLS), enemies: clone(BUILTIN_ENEMIES), projectiles: [] });

let project = Object.assign(newProject(), lsGet(LS_PROJECT) || {});
let catalog = lsGet(LS_CATALOG) || builtinCatalog();
const undoStack = [];
const redoStack = [];
let lastCoalesce = { key: null, t: 0 };
let saveTimer = null;
let savedAt = null;

const ui = {
  view: 'spells',
  sel: { spells: new Set(), custom: new Set(), enemies: new Set() },
  anchor: {}, cursor: {}, visible: {},
  sort: { spells: { key: 'name', dir: 1 }, custom: { key: 'name', dir: 1 }, enemies: { key: 'name', dir: 1 } },
  filter: { spells: { q: '', types: new Set(), modified: false }, custom: { q: '' }, enemies: { q: '', biome: '', modified: false } },
  palette: { q: '', types: new Set(), sel: new Set() },
  wandTab: 'custom', wandTier: 'all', exportFile: null,
  slotSel: { strip: null, idxs: new Set(), anchor: null },
  activeStrip: null,
  clipboard: null,
};

function mutate(fn, coalesceKey) {
  const now = Date.now();
  if (!(coalesceKey && lastCoalesce.key === coalesceKey && now - lastCoalesce.t < 1200)) {
    undoStack.push(JSON.stringify(project));
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
  }
  lastCoalesce = { key: coalesceKey, t: now };
  fn(project);
  tidy();
  scheduleSave();
  render();
}
function undo() {
  if (!undoStack.length) return toast('Nothing to undo');
  redoStack.push(JSON.stringify(project));
  project = JSON.parse(undoStack.pop());
  lastCoalesce = { key: null, t: 0 };
  scheduleSave(); render();
}
function redo() {
  if (!redoStack.length) return toast('Nothing to redo');
  undoStack.push(JSON.stringify(project));
  project = JSON.parse(redoStack.pop());
  lastCoalesce = { key: null, t: 0 };
  scheduleSave(); render();
}
function tidy() {
  const prune = (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (k === 'spawn') continue; // an empty spawn table means "never spawns", keep it
      if (v && typeof v === 'object' && !Array.isArray(v)) { prune(v); if (!Object.keys(v).length) delete o[k]; } else if (!has(v) || v === false) delete o[k];
      else if (Array.isArray(v) && !v.length) delete o[k];
    }
  };
  for (const id of Object.keys(project.spellEdits)) { prune(project.spellEdits[id]); if (!Object.keys(project.spellEdits[id]).length) delete project.spellEdits[id]; }
  for (const f of Object.keys(project.enemyEdits)) {
    const e = project.enemyEdits[f];
    if (e.custom) e.custom = e.custom.filter((c) => c.tag || c.attr || c.value);
    prune(e);
    if (!Object.keys(e).length) delete project.enemyEdits[f];
  }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (lsSet(LS_PROJECT, project)) savedAt = new Date();
    else toast('Could not autosave (browser storage full or blocked). Use Project → Save.', true);
    renderStatus();
  }, 300);
}

// ───────────────────────── lookups ─────────────────────────
const spellIndex = () => new Map(catalog.spells.map((s) => [s.id, s]));
let SPELLS = spellIndex();
const customAsSpells = () => project.customSpells.map((c) => ({ id: sanitizeSpellId(c.id), name: c.name || c.id, type: Number(c.type), custom: true }));
function spellMeta(id) {
  return SPELLS.get(id) || customAsSpells().find((s) => s.id === id) || { id, name: id, type: 5 };
}
const allPaletteSpells = () => [...customAsSpells(), ...catalog.spells];
function projectileList() {
  const set = new Set(catalog.projectiles || []);
  catalog.spells.forEach((s) => s.projectile && set.add(s.projectile));
  return [...set].sort();
}

// ───────────────────────── spell fields ─────────────────────────
const SPELL_FIELDS = [
  { key: 'mana', label: 'Mana cost', edit: 'mana', group: 'Casting' },
  { key: 'max_uses', label: 'Max uses (-1 = ∞)', edit: 'max_uses', group: 'Casting', fmt: (v) => (Number(v) < 0 ? '∞' : v) },
  { key: 'fire_rate_wait', label: 'Cast delay (frames)', delta: 'd_fire_rate_wait', group: 'Casting' },
  { key: 'reload', label: 'Recharge time (frames)', delta: 'd_reload', group: 'Casting' },
  { key: 'spread', label: 'Spread (degrees)', delta: 'd_spread', group: 'Casting' },
  { key: 'd_damage', label: 'Bonus damage (hp)', edit: 'd_damage', base: () => 0, group: 'Casting', hint: 'Added to every projectile this spell fires.' },
  { key: 'speed_mult', label: 'Projectile speed ×', edit: 'speed_mult', base: () => 1, group: 'Casting', step: 0.05 },
  { key: 'price', label: 'Shop price', edit: 'price', group: 'Casting', step: 10 },
  ...PROJ_FIELDS.map((f) => ({ key: 'proj_' + f.key, label: f.label, proj: f.key, group: 'Projectile file' })),
];
const SPELL_FIELD = Object.fromEntries(SPELL_FIELDS.map((f) => [f.key, f]));
const sEdit = (id) => project.spellEdits[id] || {};
function spellBase(s, f) {
  if (f.base) return f.base(s);
  if (f.proj) return s.proj?.[f.proj];
  return s[f.key];
}
function spellGet(s, f) {
  const e = sEdit(s.id);
  if (f.proj) return e.proj?.[f.proj] ?? s.proj?.[f.proj];
  if (f.delta) return (Number(s[f.key]) || 0) + (Number(e[f.delta]) || 0);
  return e[f.edit] ?? spellBase(s, f);
}
function spellIsMod(s, f) {
  const e = sEdit(s.id);
  if (f.proj) return has(e.proj?.[f.proj]);
  if (f.delta) return has(e[f.delta]) && Number(e[f.delta]) !== 0;
  return has(e[f.edit]);
}
function spellSet(p, s, f, v) {
  const e = (p.spellEdits[s.id] ||= {});
  if (f.proj) {
    e.proj ||= {};
    if (!has(v) || v === s.proj?.[f.proj]) delete e.proj[f.proj]; else e.proj[f.proj] = v;
  } else if (f.delta) {
    if (!has(v)) delete e[f.delta]; else e[f.delta] = Math.round((v - (Number(s[f.key]) || 0)) * 1000) / 1000;
  } else if (!has(v) || v === spellBase(s, f)) delete e[f.edit];
  else e[f.edit] = v;
}
const spellSpawn = (s) => sEdit(s.id).spawn || s.spawn || {};
const spellModified = (s) => !!project.spellEdits[s.id];

// ───────────────────────── rendering root ─────────────────────────
const VIEWS = [
  { id: 'spells', label: 'Spells', ico: '✦', sep: 'Edit the game' },
  { id: 'enemies', label: 'Enemies', ico: '☠' },
  { id: 'wands', label: 'Wands', ico: '⚚', drop: true },
  { id: 'globals', label: 'Global tweaks', ico: '⚙' },
  { id: 'custom', label: 'Custom spells', ico: '✚', sep: 'Add content', drop: true },
  { id: 'loadout', label: 'Starting loadout', ico: '⚑', drop: true },
  { id: 'export', label: 'Export mod', ico: '⬇', sep: 'Finish' },
];

function render() {
  const focus = captureFocus();
  const scroll = $('#main .view-body')?.scrollTop;
  const iscroll = $('#inspector').scrollTop;
  SPELLS = spellIndex();
  $('#mod-name').value = project.meta.name || '';
  renderNav();
  const main = $('#main');
  main.innerHTML = '';
  const insp = $('#inspector');
  insp.innerHTML = '';
  ({ spells: viewSpells, custom: viewCustom, enemies: viewEnemies, wands: viewWands, loadout: viewLoadout, globals: viewGlobals, export: viewExport })[ui.view](main, insp);
  if (scroll && $('#main .view-body')) $('#main .view-body').scrollTop = scroll;
  insp.scrollTop = iscroll;
  restoreFocus(focus);
  renderStatus();
  $('#btn-undo').disabled = !undoStack.length;
  $('#btn-redo').disabled = !redoStack.length;
}
function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.dataset?.fid) return null;
  return { fid: a.dataset.fid, start: a.selectionStart, end: a.selectionEnd };
}
function restoreFocus(f) {
  if (!f) return;
  const el = document.querySelector(`[data-fid="${CSS.escape(f.fid)}"]`);
  if (!el) return;
  el.focus();
  try { if (f.start != null) el.setSelectionRange(f.start, f.end); } catch { /* not a text input */ }
}

function navBadge(id) {
  switch (id) {
    case 'spells': return Object.keys(project.spellEdits).length;
    case 'custom': return project.customSpells.length;
    case 'enemies': return Object.keys(project.enemyEdits).length;
    case 'wands': return project.customWands.length + Object.keys(project.wandGen.tiers || {}).filter((t) => Object.keys(project.wandGen.tiers[t] || {}).length).length;
    case 'loadout': return (project.loadout.spells || []).length + project.customWands.filter((w) => w.spawnAtStart).length;
    case 'globals': {
      let n = 0;
      for (const [k, v] of Object.entries(project.globals)) {
        if (k === 'spawnMultByType') n += Object.values(v || {}).filter((x) => has(x) && Number(x) !== 1).length;
        else if (has(v) && v !== 1 && v !== false) n++;
      }
      return n;
    }
    default: return 0;
  }
}
function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = VIEWS.map((v) => {
    const b = navBadge(v.id);
    return `${v.sep ? `<div class="nav-sep">${v.sep}</div>` : ''}<div class="nav-item ${ui.view === v.id ? 'active' : ''}" data-view="${v.id}" ${v.drop ? 'data-drop="1"' : ''} title="${v.drop ? 'Drop spells here' : ''}"><span class="ico">${v.ico}</span>${v.label}${b ? `<span class="badge">${b}</span>` : ''}</div>`;
  }).join('') + `<div class="nav-hint">Tip: drag selected spells onto <b>Wands</b>, <b>Custom spells</b> or <b>Starting loadout</b>. Press <kbd>?</kbd> for shortcuts.</div>`;
}
function renderStatus() {
  const src = catalog.source === 'imported'
    ? `Game data: <b>imported</b> (${catalog.spells.length} spells, ${catalog.enemies.length} creatures)`
    : `Game data: <b>built-in reference</b> (approximate — <a href="#" data-act="import">import yours</a> for exact values)`;
  const selN = ui.sel[ui.view]?.size;
  $('#statusbar').innerHTML = `<span>${src}</span>${selN ? `<span><b>${selN}</b> selected</span>` : ''}<span style="margin-left:auto">${savedAt ? 'Autosaved ' + savedAt.toLocaleTimeString() : 'Autosave on'}</span>`;
}

// ───────────────────────── generic grid ─────────────────────────
// cfg: { name, rows, cols, key(row), modified(row), rowClass(row), onEdit(col, rows, str), draggable, context(e,row) }
function grid(cfg) {
  const { name } = cfg;
  const sort = ui.sort[name];
  const col = cfg.cols.find((c) => c.key === sort.key) || cfg.cols[0];
  const rows = [...cfg.rows].sort((a, b) => {
    const va = col.sort ? col.sort(a) : col.get(a);
    const vb = col.sort ? col.sort(b) : col.get(b);
    if (typeof va === 'number' || typeof vb === 'number') return ((has(va) ? Number(va) : -1e9) - (has(vb) ? Number(vb) : -1e9)) * sort.dir;
    return String(va ?? '').localeCompare(String(vb ?? '')) * sort.dir;
  });
  ui.visible[name] = rows.map(cfg.key);
  const sel = ui.sel[name];
  const head = cfg.cols.map((c) => `<th class="${c.num ? 'num' : ''}" data-sort="${c.key}" title="${esc(c.title || 'Sort')}">${esc(c.label)}${sort.key === c.key ? `<span class="arrow"> ${sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('');
  const body = rows.map((r) => {
    const k = cfg.key(r);
    const isSel = sel.has(k);
    const tds = cfg.cols.map((c) => {
      const cls = [c.num ? 'num' : '', c.dim ? 'dim' : '', c.editable ? 'editable' : '', c.isMod?.(r) ? 'edited' : ''].join(' ');
      const content = c.html ? c.html(r) : esc(c.fmt ? c.fmt(c.get(r), r) : c.get(r) ?? '');
      return `<td class="${cls}" data-col="${c.key}" title="${c.editable ? 'Double-click to edit (applies to all selected rows)' : ''}">${content}</td>`;
    }).join('');
    return `<tr data-key="${esc(k)}" class="${isSel ? 'sel' : ''} ${ui.cursor[name] === k ? 'cursor' : ''} ${cfg.rowClass?.(r) || ''}" ${isSel && cfg.draggable ? 'draggable="true"' : ''}>${tds}</tr>`;
  }).join('');
  const wrap = document.createElement('div');
  wrap.className = 'view-body';
  wrap.tabIndex = 0;
  wrap.dataset.grid = name;
  wrap.innerHTML = rows.length
    ? `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : `<div class="pad muted">${cfg.empty || 'Nothing matches the current filter.'}</div>`;
  const rowByKey = new Map(rows.map((r) => [cfg.key(r), r]));
  let painting = null;
  let suppressClick = false;

  wrap.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      ui.sort[name] = { key: k, dir: sort.key === k ? -sort.dir : (cfg.cols.find((c) => c.key === k)?.num ? -1 : 1) };
      render();
      return;
    }
    const tr = e.target.closest('tr[data-key]');
    if (!tr) { if (e.target === wrap || e.target.classList.contains('pad')) { sel.clear(); refreshSelection(name); } return; }
    if (suppressClick) { suppressClick = false; return; }
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // handled on mousedown
    selectOnly(name, tr.dataset.key);
  });
  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const tr = e.target.closest('tr[data-key]');
    if (!tr || e.target.closest('input')) return;
    wrap.focus({ preventScroll: true });
    const k = tr.dataset.key;
    if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); clickSelect(name, k, e); suppressClick = true; return; }
    if (sel.has(k)) return; // may become a drag of the selection
    e.preventDefault();
    sel.clear(); sel.add(k); ui.anchor[name] = k; ui.cursor[name] = k;
    painting = { start: k };
    refreshSelection(name);
    const move = (ev) => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('tr[data-key]');
      if (!t || !wrap.contains(t)) return;
      const vis = ui.visible[name];
      const a = vis.indexOf(painting.start);
      const b = vis.indexOf(t.dataset.key);
      if (a < 0 || b < 0) return;
      sel.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(vis[i]);
      ui.cursor[name] = t.dataset.key;
      if (a !== b) suppressClick = true;
      refreshSelection(name);
      autoScroll(wrap, ev.clientY);
    };
    const up = () => { painting = null; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  wrap.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td[data-col]');
    const tr = e.target.closest('tr[data-key]');
    if (!td || !tr) return;
    const c = cfg.cols.find((x) => x.key === td.dataset.col);
    if (!c?.editable) { cfg.onOpen?.(rowByKey.get(tr.dataset.key)); return; }
    const row = rowByKey.get(tr.dataset.key);
    const targets = sel.has(tr.dataset.key) ? [...sel].map((k) => rowByKey.get(k)).filter(Boolean) : [row];
    const input = document.createElement('input');
    input.className = 'cell-edit';
    input.value = fmtNum(c.get(row));
    input.placeholder = targets.length > 1 ? `${targets.length} rows` : '';
    td.innerHTML = '';
    td.appendChild(input);
    input.focus(); input.select();
    let done = false;
    const commit = (ok) => {
      if (done) return; done = true;
      if (ok && input.value.trim() !== fmtNum(c.get(row))) cfg.onEdit(c, targets, input.value);
      else render();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit(true);
      if (ev.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
  });
  wrap.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr || !cfg.context) return;
    e.preventDefault();
    if (!sel.has(tr.dataset.key)) selectOnly(name, tr.dataset.key);
    cfg.context(e, [...sel].map((k) => rowByKey.get(k)).filter(Boolean));
  });
  if (cfg.draggable) {
    wrap.addEventListener('dragstart', (e) => {
      const tr = e.target.closest('tr[data-key]');
      if (!tr) return;
      const ids = cfg.dragIds([...sel].map((k) => rowByKey.get(k)).filter(Boolean));
      setDragData(e, { kind: 'spells', ids }, `${ids.length} spell${ids.length > 1 ? 's' : ''}`);
    });
  }
  wrap.addEventListener('keydown', (e) => gridKeys(e, name, cfg, rowByKey));
  return wrap;
}
function autoScroll(el, y) {
  const r = el.getBoundingClientRect();
  if (y < r.top + 30) el.scrollTop -= 12;
  else if (y > r.bottom - 30) el.scrollTop += 12;
}
function selectOnly(name, k) {
  const s = ui.sel[name];
  s.clear(); s.add(k);
  ui.anchor[name] = k; ui.cursor[name] = k;
  refreshSelection(name);
}
function clickSelect(name, k, e) {
  const s = ui.sel[name];
  const vis = ui.visible[name] || [];
  if (e.shiftKey && ui.anchor[name] != null && vis.includes(ui.anchor[name])) {
    if (!(e.ctrlKey || e.metaKey)) s.clear();
    const a = vis.indexOf(ui.anchor[name]);
    const b = vis.indexOf(k);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(vis[i]);
  } else if (e.ctrlKey || e.metaKey) {
    if (s.has(k)) s.delete(k); else s.add(k);
    ui.anchor[name] = k;
  } else { s.clear(); s.add(k); ui.anchor[name] = k; }
  ui.cursor[name] = k;
  refreshSelection(name);
}
// Updates selection visuals without rebuilding the table (keeps scroll + is fast while painting).
function refreshSelection(name) {
  const s = ui.sel[name];
  const draggable = $('#main .view-body')?.dataset.grid === name && ['spells', 'custom'].includes(name);
  $$('#main tr[data-key]').forEach((tr) => {
    const on = s.has(tr.dataset.key);
    tr.classList.toggle('sel', on);
    tr.classList.toggle('cursor', ui.cursor[name] === tr.dataset.key);
    if (draggable) { if (on) tr.setAttribute('draggable', 'true'); else tr.removeAttribute('draggable'); }
  });
  const bar = $('#main .bulkbar');
  if (bar) renderBulkbar(bar, name);
  const insp = $('#inspector');
  const top = insp.scrollTop;
  insp.innerHTML = '';
  ({ spells: inspectSpells, custom: inspectCustom, enemies: inspectEnemies })[name]?.(insp);
  insp.scrollTop = top;
  renderStatus();
}
function gridKeys(e, name, cfg, rowByKey) {
  if (isTextTarget(e.target)) return;
  const vis = ui.visible[name] || [];
  const s = ui.sel[name];
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); vis.forEach((k) => s.add(k)); refreshSelection(name); return; }
  if (e.key === 'Escape') { s.clear(); refreshSelection(name); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const i = vis.indexOf(ui.cursor[name]);
    const n = Math.max(0, Math.min(vis.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    const k = vis[n];
    if (!k) return;
    if (e.shiftKey) { clickSelect(name, k, { shiftKey: true, ctrlKey: false }); } else selectOnly(name, k);
    $(`#main tr[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); $('#inspector input:not([type=checkbox]), #inspector select')?.focus(); return; }
  const rows = [...s].map((k) => rowByKey.get(k)).filter(Boolean);
  if (!rows.length) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); cfg.onDelete?.(rows); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); cfg.onCopy?.(rows); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); cfg.onPaste?.(rows); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); cfg.onDuplicate?.(rows); }
}

// ───────────────────────── drag & drop plumbing ─────────────────────────
const DND_TYPE = 'application/x-noita-forge';
let currentDrag = null; // mirror of the payload (dataTransfer is unreadable during dragover)
function setDragData(e, payload, label) {
  currentDrag = payload;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', (payload.ids || []).join(','));
  const ghost = document.createElement('div');
  ghost.textContent = label;
  ghost.style.cssText = 'position:fixed;top:-100px;left:0;padding:4px 10px;border-radius:6px;background:#8a4fd6;color:#fff;font:600 12px system-ui';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 10, 10);
  setTimeout(() => ghost.remove(), 0);
}
document.addEventListener('dragend', () => { currentDrag = null; $$('.drop-ok').forEach((x) => x.classList.remove('drop-ok')); $$('.insert-mark').forEach((x) => x.remove()); });

// Nav items accept spells.
$('#nav').addEventListener('dragover', (e) => {
  const item = e.target.closest('.nav-item[data-drop]');
  if (!item || currentDrag?.kind !== 'spells') return;
  e.preventDefault();
  $$('.nav-item.drop-ok').forEach((x) => x !== item && x.classList.remove('drop-ok'));
  item.classList.add('drop-ok');
});
$('#nav').addEventListener('dragleave', (e) => e.target.closest?.('.nav-item')?.classList.remove('drop-ok'));
$('#nav').addEventListener('drop', (e) => {
  const item = e.target.closest('.nav-item[data-drop]');
  if (!item || currentDrag?.kind !== 'spells') return;
  e.preventDefault();
  item.classList.remove('drop-ok');
  const ids = currentDrag.ids;
  const v = item.dataset.view;
  if (v === 'loadout') {
    mutate((p) => { p.loadout.spells = [...(p.loadout.spells || []), ...ids]; });
    toast(`Added ${ids.length} spell(s) to the starting loadout`);
  } else if (v === 'wands') {
    mutate((p) => {
      if (!p.customWands.length) p.customWands.push(newWand(p));
      const w = p.customWands[p.customWands.length - 1];
      w.spells = [...(w.spells || []), ...ids];
    });
    toast(`Added ${ids.length} spell(s) to wand "${project.customWands.at(-1).name}"`);
  } else if (v === 'custom') {
    cloneToCustom(ids.map((id) => SPELLS.get(id)).filter(Boolean));
  }
});
$('#nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (item) go(item.dataset.view);
});
function go(view) { ui.view = view; render(); }

// Spell strips (wand slots, loadout) with reorder / cross-strip moves.
const strips = new Map();
function stripEl(id, ids, set, opts = {}) {
  strips.set(id, { get: () => ids, set });
  const el = document.createElement('div');
  el.className = 'strip';
  el.dataset.strip = id;
  el.tabIndex = 0;
  const sel = ui.slotSel.strip === id ? ui.slotSel.idxs : new Set();
  el.innerHTML = ids.length
    ? ids.map((sid, i) => {
      const m = spellMeta(sid);
      return `<span class="slot ${sel.has(i) ? 'sel' : ''}" draggable="true" data-i="${i}" title="${esc(sid)}"><i style="background:${typeByCode(m.type).color}"></i>${esc(m.name)}<span class="x" data-x="${i}" title="Remove">×</span></span>`;
    }).join('')
    : `<span class="placeholder">${esc(opts.placeholder || 'Drag spells here')}</span>`;
  el.addEventListener('click', (e) => {
    ui.activeStrip = id;
    const x = e.target.closest('[data-x]');
    if (x) { const i = Number(x.dataset.x); mutate(() => set(ids.filter((_, j) => j !== i))); ui.slotSel = { strip: null, idxs: new Set() }; return; }
    const chip = e.target.closest('.slot');
    if (!chip) { ui.slotSel = { strip: null, idxs: new Set() }; render(); return; }
    const i = Number(chip.dataset.i);
    const s = ui.slotSel.strip === id ? ui.slotSel.idxs : new Set();
    if (e.shiftKey && ui.slotSel.strip === id && ui.slotSel.anchor != null) {
      for (let j = Math.min(i, ui.slotSel.anchor); j <= Math.max(i, ui.slotSel.anchor); j++) s.add(j);
    } else if (e.ctrlKey || e.metaKey) { if (s.has(i)) s.delete(i); else s.add(i); } else { s.clear(); s.add(i); }
    ui.slotSel = { strip: id, idxs: s, anchor: e.shiftKey ? ui.slotSel.anchor : i };
    render();
    $(`[data-strip="${CSS.escape(id)}"]`)?.focus();
  });
  el.addEventListener('keydown', (e) => {
    if (ui.slotSel.strip !== id) return;
    const idxs = ui.slotSel.idxs;
    if ((e.key === 'Delete' || e.key === 'Backspace') && idxs.size) {
      e.preventDefault();
      mutate(() => set(ids.filter((_, j) => !idxs.has(j))));
      ui.slotSel = { strip: null, idxs: new Set() };
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault(); ui.slotSel = { strip: id, idxs: new Set(ids.map((_, j) => j)) }; render();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && idxs.size) {
      e.preventDefault();
      const dup = ids.filter((_, j) => idxs.has(j));
      mutate(() => set([...ids, ...dup]));
    }
  });
  el.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('.slot');
    if (!chip) return;
    const i = Number(chip.dataset.i);
    if (!(ui.slotSel.strip === id && ui.slotSel.idxs.has(i))) ui.slotSel = { strip: id, idxs: new Set([i]), anchor: i };
    const idxs = [...ui.slotSel.idxs].sort((a, b) => a - b);
    setDragData(e, { kind: 'slots', strip: id, idxs, ids: idxs.map((j) => ids[j]) }, `${idxs.length} spell${idxs.length > 1 ? 's' : ''}`);
  });
  const indexAt = (e) => {
    const chips = $$('.slot', el);
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect();
      if (e.clientY < r.top) return i;
      if (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2) return i;
    }
    return chips.length;
  };
  el.addEventListener('dragover', (e) => {
    if (!currentDrag || !['spells', 'slots'].includes(currentDrag.kind)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = currentDrag.kind === 'slots' && !e.altKey ? 'move' : 'copy';
    el.classList.add('drop-ok');
    const idx = indexAt(e);
    $$('.insert-mark').forEach((m) => m.remove());
    const mark = document.createElement('span');
    mark.className = 'insert-mark';
    const chips = $$('.slot', el);
    if (chips[idx]) el.insertBefore(mark, chips[idx]); else el.appendChild(mark);
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) { el.classList.remove('drop-ok'); $$('.insert-mark', el).forEach((m) => m.remove()); } });
  el.addEventListener('drop', (e) => {
    if (!currentDrag) return;
    e.preventDefault();
    const idx = indexAt(e);
    const d = currentDrag;
    currentDrag = null;
    mutate(() => {
      if (d.kind === 'spells') {
        const next = [...ids]; next.splice(idx, 0, ...d.ids); set(next);
      } else if (d.kind === 'slots') {
        const copy = e.altKey;
        if (d.strip === id && !copy) {
          const moving = d.idxs.map((j) => ids[j]);
          const rest = ids.filter((_, j) => !d.idxs.includes(j));
          const at = idx - d.idxs.filter((j) => j < idx).length;
          rest.splice(at, 0, ...moving);
          set(rest);
          ui.slotSel = { strip: id, idxs: new Set(moving.map((_, k) => at + k)) };
        } else {
          const src = strips.get(d.strip);
          const next = [...ids]; next.splice(idx, 0, ...d.ids); set(next);
          if (src && !copy) src.set(src.get().filter((_, j) => !d.idxs.includes(j)));
          ui.slotSel = { strip: null, idxs: new Set() };
        }
      }
    });
  });
  return el;
}

// Palette (in the inspector) — searchable spell list to drag from.
function paletteEl(title, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'palette';
  const P = ui.palette;
  const q = P.q.toLowerCase();
  const list = allPaletteSpells().filter((s) => (!P.types.size || P.types.has(s.type))
    && (!q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)));
  wrap.innerHTML = `<h3>${esc(title)}</h3><div class="sub">${esc(hint)}</div>
    <input type="search" placeholder="Search spells…" data-fid="palette-q" value="${esc(P.q)}">
    <div class="chips">${SPELL_TYPES.map((t) => `<span class="chip ${P.types.has(t.code) ? 'on' : ''}" data-t="${t.code}"><span class="dot" style="background:${t.color}"></span>${t.label}</span>`).join('')}</div>
    <div class="list" data-palette="1">${list.map((s) => `<span class="slot ${P.sel.has(s.id) ? 'sel' : ''}" draggable="true" data-id="${esc(s.id)}" title="${esc(s.id)}${s.custom ? ' (custom)' : ''}"><i style="background:${typeByCode(s.type).color}"></i>${esc(s.name)}</span>`).join('') || '<span class="muted">No spells</span>'}</div>`;
  $('input', wrap).addEventListener('input', (e) => { P.q = e.target.value; render(); });
  wrap.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-t]');
    if (chip) { const t = Number(chip.dataset.t); if (P.types.has(t)) P.types.delete(t); else P.types.add(t); render(); return; }
    const s = e.target.closest('.slot[data-id]');
    if (!s) return;
    if (e.ctrlKey || e.metaKey) { if (P.sel.has(s.dataset.id)) P.sel.delete(s.dataset.id); else P.sel.add(s.dataset.id); } else { P.sel.clear(); P.sel.add(s.dataset.id); }
    render();
  });
  wrap.addEventListener('dblclick', (e) => {
    const s = e.target.closest('.slot[data-id]');
    if (!s) return;
    const target = strips.get(ui.activeStrip) || strips.values().next().value;
    if (!target) return toast('Create a wand first');
    mutate(() => target.set([...target.get(), s.dataset.id]));
  });
  wrap.addEventListener('dragstart', (e) => {
    const s = e.target.closest('.slot[data-id]');
    if (!s) return;
    if (!P.sel.has(s.dataset.id)) { P.sel.clear(); P.sel.add(s.dataset.id); }
    const ids = [...P.sel];
    setDragData(e, { kind: 'spells', ids }, `${ids.length} spell${ids.length > 1 ? 's' : ''}`);
  });
  // Dropping slots back onto the palette removes them.
  wrap.addEventListener('dragover', (e) => { if (currentDrag?.kind === 'slots') { e.preventDefault(); wrap.classList.add('drop-ok'); } });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-ok'));
  wrap.addEventListener('drop', (e) => {
    if (currentDrag?.kind !== 'slots') return;
    e.preventDefault();
    const d = currentDrag;
    const src = strips.get(d.strip);
    if (src) mutate(() => src.set(src.get().filter((_, j) => !d.idxs.includes(j))));
    ui.slotSel = { strip: null, idxs: new Set() };
  });
  return wrap;
}

// ───────────────────────── inspector field rows ─────────────────────────
// opts: { label, items, get(item), base(item), isMod(item), set(p, item, value|undefined), kind, options, list, step, hint, fid }
function fieldRow(o) {
  const vals = o.items.map(o.get);
  const same = vals.every((v) => String(v ?? '') === String(vals[0] ?? ''));
  const mod = o.items.some((it) => o.isMod?.(it));
  const row = document.createElement('div');
  row.className = 'field' + (mod ? ' mod' : '') + (o.kind === 'textarea' ? ' wide' : '');
  const base = o.base && o.items.length === 1 ? o.base(o.items[0]) : undefined;
  const hint = [o.hint, mod && has(base) ? `Vanilla: ${o.kind === 'bool' ? (base ? 'yes' : 'no') : base}` : ''].filter(Boolean).join(' · ');
  const label = `<label class="${o.kind === 'num' || !o.kind ? 'scrub' : ''}" title="${esc(o.label)}${o.kind === 'num' || !o.kind ? ' — drag left/right to adjust' : ''}">${esc(o.label)}</label>`;
  let input;
  const fid = o.fid || 'f-' + o.label;
  if (o.kind === 'bool') {
    const v = same ? !!vals[0] : false;
    input = `<span><input type="checkbox" data-fid="${esc(fid)}" ${v ? 'checked' : ''}> ${same ? '' : '<span class="muted">mixed</span>'}</span>`;
  } else if (o.kind === 'select') {
    input = `<select data-fid="${esc(fid)}">${same ? '' : '<option value="" selected>— mixed —</option>'}${o.options.map(([v, l]) => `<option value="${esc(v)}" ${same && String(vals[0]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  } else if (o.kind === 'textarea') {
    input = `<textarea rows="5" data-fid="${esc(fid)}" placeholder="${same ? '' : 'mixed'}" spellcheck="false">${same ? esc(vals[0] ?? '') : ''}</textarea>`;
  } else {
    const listAttr = o.list ? `list="dl-${o.list}"` : '';
    input = `<input ${listAttr} data-fid="${esc(fid)}" value="${same ? esc(o.kind === 'text' ? vals[0] ?? '' : fmtNum(vals[0])) : ''}" placeholder="${same ? (has(base) ? fmtNum(base) : '') : 'mixed'}" title="${o.kind === 'text' ? '' : 'Number, or relative: *2  /2  +=5  -=5  150%. Empty = vanilla.'}" spellcheck="false">`;
  }
  row.innerHTML = `${o.kind === 'textarea' ? `<div class="row">${label}<button class="reset" title="Reset to vanilla">↺</button></div>` : label}${input}${o.kind === 'textarea' ? '' : '<button class="reset" title="Reset to vanilla">↺</button>'}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}`;
  const el = $('input,select,textarea', row);
  const commit = (raw) => {
    if (o.kind === 'bool') return mutate((p) => o.items.forEach((it) => o.set(p, it, raw)));
    if (o.kind === 'select') { if (raw === '') return; return mutate((p) => o.items.forEach((it) => o.set(p, it, o.numeric ? Number(raw) : raw))); }
    if (o.kind === 'text' || o.kind === 'textarea') return mutate((p) => o.items.forEach((it) => o.set(p, it, raw === '' ? undefined : raw)));
    if (raw.trim() === '') return mutate((p) => o.items.forEach((it) => o.set(p, it, undefined)));
    const bad = [];
    const next = o.items.map((it) => {
      const cur = o.get(it) ?? o.base?.(it) ?? 0;
      let v = parseNumInput(raw, cur);
      if (Number.isNaN(v)) bad.push(it);
      if (o.int) v = Math.round(v);
      if (o.min != null) v = Math.max(o.min, v);
      return Math.round(v * 1000) / 1000;
    });
    if (bad.length) { toast(`"${raw}" is not a number or expression (try 12, *2, +=5, 150%)`, true); render(); return; }
    mutate((p) => o.items.forEach((it, i) => o.set(p, it, next[i])));
  };
  if (o.kind === 'bool') el.addEventListener('change', () => commit(el.checked));
  else if (o.kind === 'textarea') el.addEventListener('change', () => commit(el.value));
  else {
    el.addEventListener('change', () => commit(el.value));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); render(); }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (o.kind === 'num' || !o.kind)) {
        e.preventDefault();
        const step = (o.step || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        mutate((p) => o.items.forEach((it) => o.set(p, it, Math.round(((Number(o.get(it) ?? o.base?.(it)) || 0) + step) * 1000) / 1000)), 'arrow-' + fid);
      }
    });
  }
  $$('.reset', row).forEach((b) => b.addEventListener('click', () => mutate((p) => o.items.forEach((it) => o.set(p, it, undefined)))));
  const lab = $('label.scrub', row);
  if (lab) {
    lab.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const starts = o.items.map((it) => Number(o.get(it) ?? o.base?.(it)) || 0);
      const step = o.step || (Math.abs(starts[0]) >= 50 ? 1 : Math.abs(starts[0]) >= 2 ? 0.5 : 0.05);
      const key = 'scrub-' + fid + Date.now();
      let last = 0;
      const move = (ev) => {
        const d = Math.round((ev.clientX - x0) / 4) * step;
        if (d === last) return;
        last = d;
        mutate((p) => o.items.forEach((it, i) => {
          let v = Math.round((starts[i] + d) * 1000) / 1000;
          if (o.int) v = Math.round(v);
          if (o.min != null) v = Math.max(o.min, v);
          o.set(p, it, v);
        }), key);
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
      document.body.style.cursor = 'ew-resize';
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  return row;
}
const groupTitle = (t) => { const d = document.createElement('div'); d.className = 'group-title'; d.textContent = t; return d; };
function inspHead(insp, title, sub) {
  insp.insertAdjacentHTML('beforeend', `<h3>${esc(title)}</h3><div class="sub">${esc(sub || '')}</div>`);
}
function buttons(container, defs) {
  const row = document.createElement('div');
  row.className = 'row mt';
  for (const [label, fn, cls] of defs) {
    const b = document.createElement('button');
    b.textContent = label; b.className = 'small ' + (cls || '');
    b.addEventListener('click', fn);
    row.appendChild(b);
  }
  container.appendChild(row);
  return row;
}

// Spawn probability editor: drag across bars to paint, inputs accept expressions.
function spawnEditor(items, getSpawn, setSpawn) {
  const box = document.createElement('div');
  const tiers = [...Array(MAX_TIER + 1).keys()];
  const vals = tiers.map((t) => items.map((it) => Number(getSpawn(it)[t] ?? 0)));
  const scale = Math.max(1, ...vals.flat());
  box.innerHTML = `<div class="tierbox">${tiers.map((t, i) => {
    const v = vals[i];
    const same = v.every((x) => x === v[0]);
    const h = same ? (v[0] / scale) * 100 : (Math.max(...v) / scale) * 100;
    return `<div class="tier"><div class="bar ${same ? '' : 'mixed'}" data-t="${t}" title="Tier ${t}: drag up/down (or across tiers) to paint"><span style="height:${h}%"></span></div><input data-t="${t}" data-fid="spawn-${t}" value="${same ? fmtNum(v[0]) : ''}" placeholder="${same ? '' : '~'}"><small>${t}</small></div>`;
  }).join('')}</div><div class="hint muted" style="font-size:11px;margin-top:4px">Tier ≈ depth: 0 Mines … 6 Temple of the art, 10 = deep/NG+. Paint bars with the mouse.</div>`;
  const apply = (p, t, fn) => items.forEach((it) => {
    const sp = { ...getSpawn(it) };
    const v = Math.max(0, Math.round(fn(Number(sp[t] ?? 0)) * 1000) / 1000);
    if (v > 0) sp[t] = v; else delete sp[t];
    setSpawn(p, it, sp);
  });
  $$('input[data-t]', box).forEach((inp) => inp.addEventListener('change', () => {
    const t = Number(inp.dataset.t);
    if (inp.value.trim() === '') return;
    const test = parseNumInput(inp.value, 1);
    if (Number.isNaN(test)) return toast('Not a number', true);
    mutate((p) => apply(p, t, (cur) => parseNumInput(inp.value, cur)));
  }));
  box.addEventListener('mousedown', (e) => {
    const bar = e.target.closest('.bar');
    if (!bar) return;
    e.preventDefault();
    const key = 'paint' + Date.now();
    const paint = (ev) => {
      const b = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.bar[data-t]');
      if (!b) return;
      const r = b.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (r.bottom - ev.clientY) / r.height));
      const v = Math.round(frac * scale * 20) / 20;
      mutate((p) => apply(p, Number(b.dataset.t), () => v), key);
    };
    paint(e);
    const up = () => { document.removeEventListener('mousemove', paint); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', paint);
    document.addEventListener('mouseup', up);
  });
  return box;
}
function sparkHtml(sp, off) {
  const max = Math.max(1, ...Object.values(sp));
  return `<span class="spark ${off ? 'off' : ''}">${[...Array(MAX_TIER + 1).keys()].map((t) => {
    const v = Number(sp[t] || 0);
    return v > 0 ? `<b style="height:${Math.max(2, (v / max) * 14)}px" title="tier ${t}: ${v}"></b>` : '<b class="z"></b>';
  }).join('')}</span>`;
}

// ───────────────────────── Spells view ─────────────────────────
function viewHead(main, title, extra = '') {
  const head = document.createElement('div');
  head.className = 'view-head';
  head.innerHTML = `<h2>${esc(title)}</h2>${extra}`;
  main.appendChild(head);
  return head;
}
function viewSpells(main, insp) {
  const F = ui.filter.spells;
  const head = viewHead(main, 'Spells', `<input type="search" class="search" placeholder="Search name or ID…  ( / )" data-fid="spells-q" value="${esc(F.q)}">
    <div class="chips">${SPELL_TYPES.map((t) => `<span class="chip ${F.types.has(t.code) ? 'on' : ''}" data-t="${t.code}"><span class="dot" style="background:${t.color}"></span>${t.label}</span>`).join('')}</div>
    <label class="chip ${F.modified ? 'on' : ''}"><input type="checkbox" ${F.modified ? 'checked' : ''} data-mod hidden>Modified only</label>`);
  $('input[type=search]', head).addEventListener('input', (e) => { F.q = e.target.value; render(); });
  head.addEventListener('click', (e) => {
    const c = e.target.closest('.chip[data-t]');
    if (c) { const t = Number(c.dataset.t); if (F.types.has(t)) F.types.delete(t); else F.types.add(t); render(); }
  });
  $('[data-mod]', head).addEventListener('change', (e) => { F.modified = e.target.checked; render(); });
  const bar = document.createElement('div');
  bar.className = 'bulkbar';
  main.appendChild(bar);
  const q = F.q.toLowerCase();
  const rows = catalog.spells.filter((s) => (!F.types.size || F.types.has(s.type)) && (!F.modified || spellModified(s))
    && (!q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)));
  const numCol = (fk, label, extra = {}) => {
    const f = SPELL_FIELD[fk];
    return { key: fk, label, num: true, editable: true, get: (s) => spellGet(s, f), isMod: (s) => spellIsMod(s, f), fmt: f.fmt ? (v) => (has(v) ? f.fmt(v) : '') : (v) => fmtNum(v), field: f, ...extra };
  };
  const cols = [
    { key: 'name', label: 'Name', get: (s) => s.name, html: (s) => `${spellModified(s) ? '<span class="moddot" title="Modified">● </span>' : ''}<span class="${sEdit(s.id).disabled ? 'off' : ''}">${esc(s.name)}</span>` },
    { key: 'id', label: 'ID', get: (s) => s.id, dim: true },
    { key: 'type', label: 'Type', get: (s) => typeByCode(s.type).label, html: (s) => { const t = typeByCode(s.type); return `<span class="typetag"><i style="background:${t.color}"></i>${t.label}</span>`; } },
    numCol('mana', 'Mana'), numCol('max_uses', 'Uses'), numCol('fire_rate_wait', 'Cast delay'), numCol('reload', 'Recharge'),
    numCol('spread', 'Spread'), numCol('d_damage', '+Dmg'), numCol('proj_damage', 'Proj. dmg'), numCol('price', 'Price'),
    { key: 'spawn', label: 'Spawn by tier', get: (s) => Object.values(spellSpawn(s)).reduce((a, b) => a + b, 0), sort: (s) => (sEdit(s.id).disabled ? 0 : Object.values(spellSpawn(s)).reduce((a, b) => a + b, 0)), html: (s) => sparkHtml(spellSpawn(s), sEdit(s.id).disabled), num: false },
  ];
  main.appendChild(grid({
    name: 'spells', rows, cols, key: (s) => s.id, draggable: true, dragIds: (rs) => rs.map((s) => s.id),
    onEdit: (c, targets, str) => editSpellsNumeric(targets, c.field, str),
    onDelete: (rs) => { mutate((p) => rs.forEach((s) => delete p.spellEdits[s.id])); toast(`Reset ${rs.length} spell(s) to vanilla`); },
    onCopy: (rs) => copyEdits('spell', project.spellEdits[rs[0].id]),
    onPaste: (rs) => pasteEdits('spell', rs, (p, s, e) => { p.spellEdits[s.id] = clone(e); }),
    onDuplicate: (rs) => cloneToCustom(rs),
    context: (e, rs) => spellContext(e, rs),
    empty: 'No spells match. Clear the search or filters.',
  }));
  renderBulkbar(bar, 'spells');
  inspectSpells(insp);
}
function editSpellsNumeric(targets, f, str) {
  if (str.trim() === '') return mutate((p) => targets.forEach((s) => spellSet(p, s, f, undefined)));
  const vals = targets.map((s) => parseNumInput(str, spellGet(s, f) ?? 0));
  if (vals.some(Number.isNaN)) { toast('Not a number or expression', true); return render(); }
  mutate((p) => targets.forEach((s, i) => spellSet(p, s, f, Math.round(vals[i] * 1000) / 1000)));
}
function selectedSpells() { return [...ui.sel.spells].map((id) => SPELLS.get(id)).filter(Boolean); }
function renderBulkbar(bar, name) {
  const n = ui.sel[name].size;
  bar.classList.toggle('idle', !n);
  if (!n) {
    bar.innerHTML = '<span class="muted">Click, Shift/Ctrl+click or drag down the list to select · right-click for actions · double-click a number to edit</span>';
    return;
  }
  bar.innerHTML = `<span class="count">${n} selected</span>`;
  const defs = {
    spells: [
      ['Multiply…', () => multiplyDialog(selectedSpells())],
      ['Disable spawning', () => mutate((p) => selectedSpells().forEach((s) => { (p.spellEdits[s.id] ||= {}).disabled = true; }))],
      ['Enable spawning', () => mutate((p) => selectedSpells().forEach((s) => { if (p.spellEdits[s.id]) delete p.spellEdits[s.id].disabled; }))],
      ['Add to loadout', () => { mutate((p) => { p.loadout.spells = [...(p.loadout.spells || []), ...selectedSpells().map((s) => s.id)]; }); toast('Added to starting loadout'); }],
      ['Clone as custom', () => cloneToCustom(selectedSpells())],
      ['Reset to vanilla', () => mutate((p) => selectedSpells().forEach((s) => delete p.spellEdits[s.id])), 'danger'],
    ],
    custom: [
      ['Duplicate', () => duplicateCustom(selectedCustom())],
      ['Add to loadout', () => { mutate((p) => { p.loadout.spells = [...(p.loadout.spells || []), ...selectedCustom().map((c) => sanitizeSpellId(c.id))]; }); toast('Added to starting loadout'); }],
      ['Delete', () => deleteCustom(selectedCustom()), 'danger'],
    ],
    enemies: [
      ['Multiply HP…', () => enemyMultiplyDialog(selectedEnemies())],
      ['Make friendly', () => mutate((p) => selectedEnemies().forEach((en) => { (p.enemyEdits[en.file] ||= {}).herd_id = 'player'; }))],
      ['Reset to vanilla', () => mutate((p) => selectedEnemies().forEach((en) => delete p.enemyEdits[en.file])), 'danger'],
    ],
  }[name] || [];
  for (const [label, fn, cls] of defs) {
    const b = document.createElement('button');
    b.className = 'small ' + (cls || ''); b.textContent = label;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  }
  const clear = document.createElement('button');
  clear.className = 'small ghost'; clear.textContent = 'Clear selection (Esc)';
  clear.addEventListener('click', () => { ui.sel[name].clear(); refreshSelection(name); });
  bar.appendChild(clear);
}
function inspectSpells(insp) {
  const items = selectedSpells();
  if (!items.length) {
    insp.innerHTML = `<div class="empty"><p><b>Select spells to edit them.</b></p><p>Click, <kbd>Shift</kbd>+click, <kbd>Ctrl</kbd>+click, or drag down the list to select many. Edits apply to every selected spell.</p><p>Number fields accept expressions:<br><code>*2</code> <code>/2</code> <code>+=5</code> <code>-=5</code> <code>150%</code></p><p>Drag a field's label left/right to scrub its value.</p></div>`;
    return;
  }
  inspHead(insp, items.length === 1 ? items[0].name : `${items.length} spells`, items.length === 1 ? `${items[0].id} · ${typeByCode(items[0].type).label}` : items.slice(0, 6).map((s) => s.name).join(', ') + (items.length > 6 ? '…' : ''));
  if (items.length === 1 && items[0].description) insp.insertAdjacentHTML('beforeend', `<div class="note">${esc(items[0].description)}</div>`);
  let group = '';
  const anyProj = items.some((s) => s.projectile);
  for (const f of SPELL_FIELDS) {
    if (f.proj && !anyProj) continue;
    if (f.group !== group) {
      group = f.group;
      insp.appendChild(groupTitle(group));
      if (f.proj) {
        const files = [...new Set(items.map((s) => s.projectile).filter(Boolean))];
        insp.insertAdjacentHTML('beforeend', `<div class="note">Edits the projectile file directly${files.length === 1 ? `: <code>${esc(files[0])}</code>` : ` (${files.length} files)`}. Enemies or other spells that shoot the same file are affected too.</div>`);
      }
    }
    const its = f.proj ? items.filter((s) => s.projectile) : items;
    insp.appendChild(fieldRow({
      label: f.label, items: its, kind: 'num', step: f.step, hint: f.hint, fid: 'sp-' + f.key,
      get: (s) => spellGet(s, f), base: (s) => (f.delta ? s[f.key] : spellBase(s, f)), isMod: (s) => spellIsMod(s, f),
      set: (p, s, v) => spellSet(p, s, f, v),
    }));
  }
  insp.appendChild(groupTitle('Spawning'));
  insp.appendChild(fieldRow({
    label: 'Never spawns (disable)', kind: 'bool', items, fid: 'sp-disabled',
    get: (s) => !!sEdit(s.id).disabled, isMod: (s) => !!sEdit(s.id).disabled,
    set: (p, s, v) => { (p.spellEdits[s.id] ||= {}).disabled = v || undefined; },
  }));
  insp.appendChild(spawnEditor(items, spellSpawn, (p, s, sp) => { (p.spellEdits[s.id] ||= {}).spawn = sp; }));
  buttons(insp, [
    ['×0.5', () => mutate((p) => items.forEach((s) => { (p.spellEdits[s.id] ||= {}).spawn = scaleSpawn(spellSpawn(s), 0.5); }))],
    ['×2', () => mutate((p) => items.forEach((s) => { (p.spellEdits[s.id] ||= {}).spawn = scaleSpawn(spellSpawn(s), 2); }))],
    ['All tiers', () => mutate((p) => items.forEach((s) => { const v = Math.max(0.1, ...Object.values(spellSpawn(s))); (p.spellEdits[s.id] ||= {}).spawn = Object.fromEntries([...Array(MAX_TIER + 1).keys()].map((t) => [t, v])); }))],
    ['Reset spawn', () => mutate((p) => items.forEach((s) => { if (p.spellEdits[s.id]) delete p.spellEdits[s.id].spawn; }))],
  ]);
  insp.appendChild(groupTitle('Actions'));
  buttons(insp, [
    ['Copy edits (Ctrl+C)', () => copyEdits('spell', project.spellEdits[items[0].id])],
    ['Paste (Ctrl+V)', () => pasteEdits('spell', items, (p, s, e) => { p.spellEdits[s.id] = clone(e); })],
    ['Clone as custom spell', () => cloneToCustom(items)],
    ['Reset', () => mutate((p) => items.forEach((s) => delete p.spellEdits[s.id])), 'danger'],
  ]);
}
const scaleSpawn = (sp, m) => Object.fromEntries(Object.entries(sp).map(([t, v]) => [t, Math.round(v * m * 1000) / 1000]).filter(([, v]) => v > 0));

function spellContext(e, rs) {
  ctxMenu(e, [
    [`Edit ${rs.length > 1 ? rs.length + ' spells' : rs[0].name}`, () => $('#inspector input')?.focus(), 'Enter'],
    ['Multiply stats…', () => multiplyDialog(rs)],
    null,
    ['Copy edits', () => copyEdits('spell', project.spellEdits[rs[0].id]), 'Ctrl+C'],
    ['Paste edits', () => pasteEdits('spell', rs, (p, s, ed) => { p.spellEdits[s.id] = clone(ed); }), 'Ctrl+V'],
    null,
    ['Disable spawning', () => mutate((p) => rs.forEach((s) => { (p.spellEdits[s.id] ||= {}).disabled = true; }))],
    ['Add to starting loadout', () => mutate((p) => { p.loadout.spells = [...(p.loadout.spells || []), ...rs.map((s) => s.id)]; })],
    ['Add to new wand', () => { mutate((p) => { const w = newWand(p); w.spells = rs.map((s) => s.id); p.customWands.push(w); }); toast('Wand created — see Wands'); }],
    ['Clone as custom spell', () => cloneToCustom(rs), 'Ctrl+D'],
    null,
    ['Reset to vanilla', () => mutate((p) => rs.forEach((s) => delete p.spellEdits[s.id])), 'Del'],
  ]);
}
function multiplyDialog(spells) {
  if (!spells.length) return;
  const opts = SPELL_FIELDS.filter((f) => !f.proj || spells.some((s) => s.projectile));
  modal(`<h2>Multiply stats of ${spells.length} spell(s)</h2>
    <p class="muted">Each spell's current value is multiplied individually. Use the inspector for <code>+=</code>, <code>/</code> or absolute values.</p>
    <div class="row"><select id="mf">${opts.map((f) => `<option value="${f.key}">${esc(f.label)}</option>`).join('')}<option value="__spawn">Spawn chance (all tiers)</option></select>
    × <input id="mv" value="2" style="width:80px"></div>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="mok">Apply</button></div>`);
  $('#mv').select();
  const ok = () => {
    const k = $('#mf').value;
    const m = Number($('#mv').value);
    if (Number.isNaN(m)) return toast('Enter a number', true);
    closeModal();
    if (k === '__spawn') return mutate((p) => spells.forEach((s) => { (p.spellEdits[s.id] ||= {}).spawn = scaleSpawn(spellSpawn(s), m); }));
    const f = SPELL_FIELD[k];
    mutate((p) => spells.forEach((s) => { const cur = spellGet(s, f); if (has(cur)) spellSet(p, s, f, Math.round(Number(cur) * m * 1000) / 1000); }));
  };
  $('#mok').addEventListener('click', ok);
  $('#mv').addEventListener('keydown', (e) => e.key === 'Enter' && ok());
}
function copyEdits(kind, edits) {
  ui.clipboard = { kind, edits: clone(edits || {}) };
  toast(edits ? 'Copied edits — select other rows and press Ctrl+V' : 'Copied (no edits on this row)');
}
function pasteEdits(kind, rows, apply) {
  if (!ui.clipboard || ui.clipboard.kind !== kind) return toast('Nothing to paste — copy a row first (Ctrl+C)', true);
  mutate((p) => rows.forEach((r) => apply(p, r, ui.clipboard.edits)));
  toast(`Pasted onto ${rows.length} row(s)`);
}

// ───────────────────────── Custom spells ─────────────────────────
function newCustomSpell(p, from) {
  let n = p.customSpells.length + 1;
  const ids = new Set(p.customSpells.map((c) => sanitizeSpellId(c.id)));
  while (ids.has(`MY_SPELL_${n}`)) n++;
  return {
    uid: uid(), id: `MY_SPELL_${n}`, name: `My spell ${n}`, description: 'A custom spell', type: 0, mana: 10, max_uses: -1, price: 100,
    spawn: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }, projBase: 'data/entities/projectiles/deck/light_bullet.xml', projCount: 1,
    trigger: 'none', triggerDraws: 1, triggerDelay: 10, fire_rate_wait: 0, reload: 0, spread: 0, damage_add: 0, speed_mult: 1,
    bounces: 0, lifetime_add: 0, explosion_radius: 0, crit_chance: 0, extra_entities: '', draw: '', proj: {}, rawLua: '', sprite: '', spriteData: '',
    ...(from || {}),
  };
}
function cloneToCustom(spells) {
  if (!spells.length) return;
  ui.sel.custom = new Set();
  mutate((p) => {
    for (const s of spells) {
      const e = sEdit(s.id);
      const ids = new Set([...p.customSpells.map((c) => sanitizeSpellId(c.id)), ...SPELLS.keys()]);
      let id = `${s.id}_CUSTOM`;
      let i = 2;
      while (ids.has(id)) id = `${s.id}_CUSTOM_${i++}`;
      const c = newCustomSpell(p, {
        id, name: `${s.name} (custom)`, description: s.description || '', type: s.type,
        mana: e.mana ?? s.mana, max_uses: e.max_uses ?? s.max_uses, price: e.price ?? s.price, spawn: clone(spellSpawn(s)),
        projBase: s.projectile || '', fire_rate_wait: (s.fire_rate_wait || 0) + (e.d_fire_rate_wait || 0),
        reload: (s.reload || 0) + (e.d_reload || 0), spread: (s.spread || 0) + (e.d_spread || 0),
        damage_add: e.d_damage || 0, speed_mult: e.speed_mult ?? 1, proj: clone(e.proj || {}), sprite: s.sprite || '',
        draw: s.type === 3 ? 2 : '',
      });
      p.customSpells.push(c);
      ui.sel.custom.add(c.uid);
    }
  });
  ui.view = 'custom';
  render();
  toast(`Created ${spells.length} custom spell(s). Edit them here.`);
}
const selectedCustom = () => project.customSpells.filter((c) => ui.sel.custom.has(c.uid));
function duplicateCustom(cs) {
  mutate((p) => {
    ui.sel.custom.clear();
    for (const c of cs) {
      const d = { ...clone(c), uid: uid(), id: sanitizeSpellId(c.id) + '_COPY', name: c.name + ' (copy)' };
      p.customSpells.push(d);
      ui.sel.custom.add(d.uid);
    }
  });
}
function deleteCustom(cs) {
  if (!cs.length) return;
  const ids = new Set(cs.map((c) => c.uid));
  mutate((p) => { p.customSpells = p.customSpells.filter((c) => !ids.has(c.uid)); });
  ui.sel.custom.clear();
  render();
  toast(`Deleted ${cs.length} custom spell(s)`, false, undo);
}
const CUSTOM_FIELDS = [
  { k: 'id', label: 'Spell ID', kind: 'text', group: 'Identity', hint: 'Unique, UPPER_CASE. Used by wands and other mods.' },
  { k: 'name', label: 'Name', kind: 'text', group: 'Identity' },
  { k: 'description', label: 'Description', kind: 'text', group: 'Identity' },
  { k: 'type', label: 'Type', kind: 'select', numeric: true, options: SPELL_TYPES.map((t) => [t.code, t.label]), group: 'Identity' },
  { k: 'mana', label: 'Mana cost', group: 'Casting' },
  { k: 'max_uses', label: 'Max uses (-1 = ∞)', group: 'Casting', int: true },
  { k: 'price', label: 'Shop price', group: 'Casting', step: 10 },
  { k: 'fire_rate_wait', label: 'Cast delay (+frames)', group: 'Casting' },
  { k: 'reload', label: 'Recharge (+frames)', group: 'Casting' },
  { k: 'spread', label: 'Spread (+degrees)', group: 'Casting' },
  { k: 'damage_add', label: 'Bonus damage (hp)', group: 'Casting' },
  { k: 'speed_mult', label: 'Projectile speed ×', group: 'Casting', step: 0.05 },
  { k: 'bounces', label: 'Extra bounces', group: 'Casting', int: true },
  { k: 'lifetime_add', label: 'Lifetime (+frames)', group: 'Casting' },
  { k: 'explosion_radius', label: 'Explosion radius (+)', group: 'Casting' },
  { k: 'crit_chance', label: 'Crit chance (+%)', group: 'Casting' },
  { k: 'draw', label: 'Draws extra spells', group: 'Casting', int: true, hint: 'Modifiers usually draw 1, multicasts 2+. Empty = default.' },
  { k: 'extra_entities', label: 'Extra entities (comma list)', kind: 'text', list: 'extras', group: 'Casting', hint: 'Entity files attached to every projectile, e.g. homing.' },
  { k: 'projBase', label: 'Projectile file', kind: 'text', list: 'projectiles', group: 'Projectile' },
  { k: 'projCount', label: 'Projectiles per cast', group: 'Projectile', int: true, min: 1 },
  { k: 'trigger', label: 'Trigger', kind: 'select', options: [['none', 'None'], ['hit', 'On hit (trigger)'], ['timer', 'After time (timer)'], ['death', 'On expire (death trigger)']], group: 'Projectile' },
  { k: 'triggerDraws', label: 'Trigger payload spells', group: 'Projectile', int: true, min: 1 },
  { k: 'triggerDelay', label: 'Timer delay (frames)', group: 'Projectile', int: true, min: 1 },
];
function viewCustom(main, insp) {
  const F = ui.filter.custom;
  const head = viewHead(main, 'Custom spells', `<input type="search" class="search" placeholder="Search…" data-fid="custom-q" value="${esc(F.q)}"><span class="spacer"></span><button id="new-spell" class="primary small">+ New spell</button>`);
  $('input', head).addEventListener('input', (e) => { F.q = e.target.value; render(); });
  $('#new-spell', head).addEventListener('click', () => {
    let c;
    mutate((p) => { c = newCustomSpell(p); p.customSpells.push(c); });
    ui.sel.custom = new Set([c.uid]);
    render();
    $('#inspector [data-fid="cs-name"]')?.select();
  });
  const bar = document.createElement('div');
  bar.className = 'bulkbar';
  main.appendChild(bar);
  const q = F.q.toLowerCase();
  const dupIds = new Set();
  const seen = new Set();
  project.customSpells.forEach((c) => { const id = sanitizeSpellId(c.id); if (seen.has(id) || SPELLS.has(id)) dupIds.add(id); seen.add(id); });
  const rows = project.customSpells.filter((c) => !q || (c.name || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q));
  const numc = (k, label) => ({ key: k, label, num: true, editable: true, get: (c) => c[k], fmt: fmtNum, field: k });
  main.appendChild(grid({
    name: 'custom', rows, key: (c) => c.uid, draggable: true, dragIds: (cs) => cs.map((c) => sanitizeSpellId(c.id)),
    cols: [
      { key: 'name', label: 'Name', get: (c) => c.name },
      { key: 'id', label: 'ID', get: (c) => sanitizeSpellId(c.id), html: (c) => `${esc(sanitizeSpellId(c.id))}${dupIds.has(sanitizeSpellId(c.id)) ? ' <span style="color:var(--danger)" title="ID clashes with another spell">⚠</span>' : ''}`, dim: true },
      { key: 'type', label: 'Type', get: (c) => typeByCode(Number(c.type)).label, html: (c) => { const t = typeByCode(Number(c.type)); return `<span class="typetag"><i style="background:${t.color}"></i>${t.label}</span>`; } },
      numc('mana', 'Mana'), numc('max_uses', 'Uses'), numc('fire_rate_wait', 'Cast delay'), numc('damage_add', '+Dmg'), numc('projCount', 'Count'),
      { key: 'projBase', label: 'Projectile', get: (c) => (c.projBase || '').split('/').pop(), dim: true },
      { key: 'spawn', label: 'Spawn by tier', get: (c) => Object.values(c.spawn || {}).reduce((a, b) => a + b, 0), html: (c) => sparkHtml(c.spawn || {}) },
    ],
    onEdit: (c, targets, str) => {
      const vals = targets.map((t) => parseNumInput(str, t[c.field]));
      if (vals.some(Number.isNaN)) { toast('Not a number', true); return render(); }
      mutate((p) => targets.forEach((t, i) => { const x = p.customSpells.find((y) => y.uid === t.uid); if (x) x[c.field] = vals[i]; }));
    },
    onDelete: deleteCustom,
    onDuplicate: duplicateCustom,
    onCopy: (cs) => { ui.clipboard = { kind: 'custom', edits: clone(cs[0]) }; toast('Copied — Ctrl+V pastes stats onto selected custom spells'); },
    onPaste: (cs) => {
      if (ui.clipboard?.kind !== 'custom') return toast('Copy a custom spell first', true);
      const src = ui.clipboard.edits;
      mutate((p) => cs.forEach((c) => { const x = p.customSpells.find((y) => y.uid === c.uid); Object.assign(x, clone(src), { uid: x.uid, id: x.id, name: x.name }); }));
    },
    context: (e, cs) => ctxMenu(e, [
      ['Duplicate', () => duplicateCustom(cs), 'Ctrl+D'],
      ['Add to starting loadout', () => mutate((p) => { p.loadout.spells = [...(p.loadout.spells || []), ...cs.map((c) => sanitizeSpellId(c.id))]; })],
      ['Add to new wand', () => mutate((p) => { const w = newWand(p); w.spells = cs.map((c) => sanitizeSpellId(c.id)); p.customWands.push(w); })],
      null,
      ['Delete', () => deleteCustom(cs), 'Del'],
    ]),
    empty: 'No custom spells yet. Click “+ New spell”, or select vanilla spells and choose “Clone as custom” (or drag them onto “Custom spells”).',
  }));
  renderBulkbar(bar, 'custom');
  inspectCustom(insp);
}
function inspectCustom(insp) {
  const items = selectedCustom();
  if (!items.length) {
    insp.innerHTML = '<div class="empty"><p><b>Select a custom spell to edit it.</b></p><p>Select several to edit shared fields at once.</p></div>';
    return;
  }
  inspHead(insp, items.length === 1 ? items[0].name : `${items.length} custom spells`, items.length === 1 ? sanitizeSpellId(items[0].id) : '');
  const setter = (k) => (p, it, v) => { const x = p.customSpells.find((y) => y.uid === it.uid); if (x) x[k] = v; };
  let group = '';
  for (const f of CUSTOM_FIELDS) {
    if (items.length > 1 && f.k === 'id') continue;
    if (f.group !== group) { group = f.group; insp.appendChild(groupTitle(group)); }
    insp.appendChild(fieldRow({
      label: f.label, items, kind: f.kind || 'num', options: f.options, numeric: f.numeric, list: f.list, hint: f.hint, step: f.step, int: f.int, min: f.min,
      fid: 'cs-' + f.k, get: (c) => c[f.k], set: setter(f.k),
    }));
  }
  insp.appendChild(groupTitle('Projectile overrides'));
  insp.insertAdjacentHTML('beforeend', '<div class="note">Leave empty to keep the projectile file\'s own values. Set any of these and a new projectile file based on the one above is generated.</div>');
  for (const pf of PROJ_FIELDS) {
    insp.appendChild(fieldRow({
      label: pf.label, items, kind: 'num', fid: 'csp-' + pf.key,
      get: (c) => c.proj?.[pf.key], isMod: (c) => has(c.proj?.[pf.key]),
      set: (p, it, v) => { const x = p.customSpells.find((y) => y.uid === it.uid); x.proj ||= {}; if (has(v)) x.proj[pf.key] = v; else delete x.proj[pf.key]; },
    }));
  }
  insp.appendChild(groupTitle('Icon'));
  const c0 = items[0];
  const sb = document.createElement('div');
  sb.className = 'spritebox';
  sb.innerHTML = `${c0.spriteData ? `<img src="${c0.spriteData}" alt="icon">` : '<img alt="">'}<button class="small" id="sprite-up">Upload PNG (16×16)…</button>${c0.spriteData ? '<button class="small danger" id="sprite-rm">Remove</button>' : ''}`;
  insp.appendChild(sb);
  insp.appendChild(fieldRow({ label: 'Or use game icon path', kind: 'text', items, fid: 'cs-sprite', get: (c) => c.sprite, set: setter('sprite') }));
  $('#sprite-up', sb).addEventListener('click', () => { pendingSprite = items.map((c) => c.uid); $('#file-sprite').click(); });
  $('#sprite-rm', sb)?.addEventListener('click', () => mutate((p) => items.forEach((it) => { p.customSpells.find((y) => y.uid === it.uid).spriteData = ''; })));
  insp.appendChild(groupTitle('Spawning'));
  insp.appendChild(spawnEditor(items, (c) => c.spawn || {}, (p, it, sp) => { p.customSpells.find((y) => y.uid === it.uid).spawn = sp; }));
  insp.appendChild(groupTitle('Advanced'));
  insp.appendChild(fieldRow({
    label: 'Extra Lua in action()', kind: 'textarea', items, fid: 'cs-lua', get: (c) => c.rawLua, set: setter('rawLua'),
    hint: 'Runs when the spell is cast. e.g. c.fire_rate_wait = c.fire_rate_wait - 5, add_projectile("…"), draw_actions(1, true)',
  }));
  buttons(insp, [['Duplicate', () => duplicateCustom(items)], ['Delete', () => deleteCustom(items), 'danger']]);
}
let pendingSprite = null;
$('#file-sprite').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f && pendingSprite) await setSpriteFromFile(f, pendingSprite);
});
async function setSpriteFromFile(file, uids) {
  const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  mutate((p) => uids.forEach((u) => { const x = p.customSpells.find((y) => y.uid === u); if (x) x.spriteData = url; }));
  toast('Icon set');
}

// ───────────────────────── Enemies ─────────────────────────
const eEdit = (file) => project.enemyEdits[file] || {};
const enemyGet = (en, f) => eEdit(en.file)[f.key] ?? en.attrs?.[f.key];
const selectedEnemies = () => catalog.enemies.filter((en) => ui.sel.enemies.has(en.file));
function enemySet(p, en, f, v) {
  const e = (p.enemyEdits[en.file] ||= {});
  if (!has(v) || v === en.attrs?.[f.key]) delete e[f.key]; else e[f.key] = v;
}
function viewEnemies(main, insp) {
  const F = ui.filter.enemies;
  const biomes = [...new Set(catalog.enemies.map((e) => e.biome).filter(Boolean))].sort();
  const head = viewHead(main, 'Enemies', `<input type="search" class="search" placeholder="Search name or file…" data-fid="enemies-q" value="${esc(F.q)}">
    ${biomes.length ? `<select data-biome><option value="">All areas</option>${biomes.map((b) => `<option ${F.biome === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>` : ''}
    <label class="chip ${F.modified ? 'on' : ''}"><input type="checkbox" ${F.modified ? 'checked' : ''} data-mod hidden>Modified only</label>
    <span class="spacer"></span><button class="small" id="add-enemy">+ Add entity file…</button>`);
  $('input[type=search]', head).addEventListener('input', (e) => { F.q = e.target.value; render(); });
  $('[data-biome]', head)?.addEventListener('change', (e) => { F.biome = e.target.value; render(); });
  $('[data-mod]', head).addEventListener('change', (e) => { F.modified = e.target.checked; render(); });
  $('#add-enemy', head).addEventListener('click', () => {
    modal(`<h2>Add an entity file</h2><p class="muted">Any entity XML path from the game data, e.g. <code>data/entities/animals/rat.xml</code>.</p><input id="ef" style="width:100%" placeholder="data/entities/animals/…xml"><div class="actions"><button data-close>Cancel</button><button class="primary" id="eok">Add</button></div>`);
    $('#ef').focus();
    const ok = () => {
      const file = $('#ef').value.trim();
      if (!/\.xml$/.test(file)) return toast('Path must end in .xml', true);
      if (!catalog.enemies.some((e) => e.file === file)) { catalog.enemies.push({ file, name: file.split('/').pop().replace('.xml', ''), biome: 'Custom', attrs: {} }); lsSet(LS_CATALOG, catalog); }
      closeModal(); ui.sel.enemies = new Set([file]); render();
    };
    $('#eok').addEventListener('click', ok);
    $('#ef').addEventListener('keydown', (e) => e.key === 'Enter' && ok());
  });
  const bar = document.createElement('div');
  bar.className = 'bulkbar';
  main.appendChild(bar);
  const q = F.q.toLowerCase();
  const rows = catalog.enemies.filter((en) => (!F.biome || en.biome === F.biome) && (!F.modified || project.enemyEdits[en.file])
    && (!q || en.name.toLowerCase().includes(q) || en.file.toLowerCase().includes(q)));
  const fcol = (key, label) => {
    const f = ENEMY_FIELDS.find((x) => x.key === key);
    return { key, label, num: f.kind === 'num', editable: f.kind !== 'bool', get: (en) => enemyGet(en, f), isMod: (en) => has(eEdit(en.file)[key]), fmt: (v) => (f.kind === 'num' ? fmtNum(v) : v ?? ''), field: f };
  };
  main.appendChild(grid({
    name: 'enemies', rows, key: (en) => en.file,
    cols: [
      { key: 'name', label: 'Name', get: (en) => en.name, html: (en) => `${project.enemyEdits[en.file] ? '<span class="moddot">● </span>' : ''}${esc(en.name)}` },
      { key: 'file', label: 'File', get: (en) => en.file.replace('data/entities/animals/', ''), dim: true },
      { key: 'biome', label: 'Area', get: (en) => en.biome || '', dim: true },
      fcol('hp', 'HP'), fcol('herd_id', 'Faction'), fcol('run_velocity', 'Run speed'), fcol('melee_max', 'Melee dmg'), fcol('detect_x', 'Detect range'),
    ],
    onEdit: (c, targets, str) => {
      const f = c.field;
      if (f.kind === 'text') return mutate((p) => targets.forEach((en) => enemySet(p, en, f, str.trim() || undefined)));
      if (str.trim() === '') return mutate((p) => targets.forEach((en) => enemySet(p, en, f, undefined)));
      const vals = targets.map((en) => parseNumInput(str, enemyGet(en, f) ?? 0));
      if (vals.some(Number.isNaN)) { toast('Not a number', true); return render(); }
      if (str.match(/^[*x×/%]|%$|[+-]=/) && targets.some((en) => !has(enemyGet(en, f)))) toast('Some vanilla values are unknown — import game data for relative edits, or use Global tweaks → enemy HP ×.', true);
      mutate((p) => targets.forEach((en, i) => enemySet(p, en, f, Math.round(vals[i] * 1000) / 1000)));
    },
    onDelete: (rs) => mutate((p) => rs.forEach((en) => delete p.enemyEdits[en.file])),
    onCopy: (rs) => copyEdits('enemy', project.enemyEdits[rs[0].file]),
    onPaste: (rs) => pasteEdits('enemy', rs, (p, en, e) => { p.enemyEdits[en.file] = clone(e); }),
    context: (e, rs) => ctxMenu(e, [
      ['Multiply HP…', () => enemyMultiplyDialog(rs)],
      ['Make friendly (player faction)', () => mutate((p) => rs.forEach((en) => { (p.enemyEdits[en.file] ||= {}).herd_id = 'player'; }))],
      null,
      ['Copy edits', () => copyEdits('enemy', project.enemyEdits[rs[0].file]), 'Ctrl+C'],
      ['Paste edits', () => pasteEdits('enemy', rs, (p, en, ed) => { p.enemyEdits[en.file] = clone(ed); }), 'Ctrl+V'],
      null,
      ['Reset to vanilla', () => mutate((p) => rs.forEach((en) => delete p.enemyEdits[en.file])), 'Del'],
    ]),
  }));
  renderBulkbar(bar, 'enemies');
  inspectEnemies(insp);
}
function inspectEnemies(insp) {
  const items = selectedEnemies();
  if (!items.length) {
    insp.innerHTML = `<div class="empty"><p><b>Select enemies to edit them.</b></p><p>Change health, resistances, faction, speed, attacks — or any XML attribute with custom rows.</p>${catalog.source !== 'imported' ? '<p class="note warn">Vanilla values are unknown until you import game data. Your edits still work; they replace the game\'s values.</p>' : ''}</div>`;
    return;
  }
  inspHead(insp, items.length === 1 ? items[0].name : `${items.length} creatures`, items.length === 1 ? items[0].file : '');
  let group = '';
  for (const f of ENEMY_FIELDS) {
    if (f.group !== group) { group = f.group; insp.appendChild(groupTitle(group)); }
    insp.appendChild(fieldRow({
      label: f.label, items, kind: f.kind, list: f.list, fid: 'en-' + f.key,
      get: (en) => enemyGet(en, f), base: (en) => en.attrs?.[f.key], isMod: (en) => has(eEdit(en.file)[f.key]),
      set: (p, en, v) => enemySet(p, en, f, v),
    }));
  }
  insp.appendChild(groupTitle('Custom XML attributes'));
  insp.insertAdjacentHTML('beforeend', '<div class="note">Set any attribute on any component, e.g. <code>DamageModelComponent</code> · <code>falling_damages</code> · <code>0</code>. Applied to every selected creature.</div>');
  const rowsByKey = new Map();
  items.forEach((en) => (eEdit(en.file).custom || []).forEach((c, i) => {
    const k = `${c.tag}|${c.attr}`;
    if (!rowsByKey.has(k)) rowsByKey.set(k, { tag: c.tag, attr: c.attr, value: c.value, n: 0, i });
    rowsByKey.get(k).n++;
  }));
  const tbl = document.createElement('div');
  for (const r of [...rowsByKey.values(), { tag: '', attr: '', value: '', n: 0, isNew: true }]) {
    const d = document.createElement('div');
    d.className = 'row';
    d.style.marginBottom = '4px';
    d.innerHTML = `<input placeholder="Component / tag" value="${esc(r.tag)}" style="width:42%" list="dl-components"><input placeholder="attribute" value="${esc(r.attr)}" style="width:30%"><input placeholder="value" value="${esc(r.value)}" style="width:16%">${r.isNew ? '' : '<button class="small ghost" title="Remove">×</button>'}`;
    const [ti, ai, vi] = $$('input', d);
    const save = () => {
      const tag = ti.value.trim();
      const attr = ai.value.trim();
      if (r.isNew && (!tag || !attr)) return;
      mutate((p) => items.forEach((en) => {
        const e = (p.enemyEdits[en.file] ||= {});
        e.custom = (e.custom || []).filter((c) => !(c.tag === r.tag && c.attr === r.attr));
        if (tag && attr) e.custom.push({ tag, attr, value: vi.value });
      }));
    };
    [ti, ai, vi].forEach((x) => x.addEventListener('change', save));
    $('button', d)?.addEventListener('click', () => mutate((p) => items.forEach((en) => {
      const e = p.enemyEdits[en.file];
      if (e?.custom) e.custom = e.custom.filter((c) => !(c.tag === r.tag && c.attr === r.attr));
    })));
    tbl.appendChild(d);
  }
  insp.appendChild(tbl);
  buttons(insp, [
    ['Copy edits', () => copyEdits('enemy', project.enemyEdits[items[0].file])],
    ['Paste', () => pasteEdits('enemy', items, (p, en, e) => { p.enemyEdits[en.file] = clone(e); })],
    ['Reset', () => mutate((p) => items.forEach((en) => delete p.enemyEdits[en.file])), 'danger'],
  ]);
}
function enemyMultiplyDialog(ens) {
  const known = ens.filter((en) => has(en.attrs?.hp) || has(eEdit(en.file).hp));
  modal(`<h2>Multiply HP of ${ens.length} creature(s)</h2>
    ${known.length < ens.length ? `<p class="note warn">${ens.length - known.length} creature(s) have unknown vanilla HP (import game data). For those, use Global tweaks → “Enemy HP ×”, which multiplies in-game.</p>` : ''}
    <div class="row">HP × <input id="mv" value="2" style="width:80px"></div>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="mok">Apply</button></div>`);
  $('#mv').select();
  const ok = () => {
    const m = Number($('#mv').value);
    if (Number.isNaN(m)) return;
    closeModal();
    const f = ENEMY_FIELDS[0];
    mutate((p) => known.forEach((en) => enemySet(p, en, f, Math.round(Number(enemyGet(en, f)) * m * 1000) / 1000)));
  };
  $('#mok').addEventListener('click', ok);
  $('#mv').addEventListener('keydown', (e) => e.key === 'Enter' && ok());
}

// ───────────────────────── Wands ─────────────────────────
function newWand(p) {
  return {
    uid: uid(), name: `Wand ${p.customWands.length + 1}`, spawnAtStart: true, mana_max: 600, mana_charge_speed: 250, deck_capacity: 10,
    actions_per_round: 1, reload_time: 20, fire_rate_wait: 8, spread_degrees: 0, speed_multiplier: 1, shuffle: false, spells: [], always: [],
  };
}
function viewWands(main, insp) {
  const head = viewHead(main, 'Wands', `<div class="chips"><span class="chip ${ui.wandTab === 'custom' ? 'on' : ''}" data-tab="custom">Custom wands</span><span class="chip ${ui.wandTab === 'gen' ? 'on' : ''}" data-tab="gen">Random wand generation</span></div><span class="spacer"></span>${ui.wandTab === 'custom' ? '<button class="primary small" id="new-wand">+ New wand</button>' : ''}`);
  head.addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) { ui.wandTab = t.dataset.tab; render(); } });
  $('#new-wand', head)?.addEventListener('click', () => mutate((p) => p.customWands.push(newWand(p))));
  const body = document.createElement('div');
  body.className = 'view-body pad';
  main.appendChild(body);
  strips.clear();
  if (ui.wandTab === 'gen') return wandGen(body, insp);
  if (!project.customWands.length) body.innerHTML = '<div class="muted">No custom wands yet. Click “+ New wand”, or drag spells from the Spells list onto “Wands” in the sidebar.</div>';
  const cards = document.createElement('div');
  cards.className = 'cards';
  project.customWands.forEach((w, wi) => {
    const card = document.createElement('div');
    card.className = 'card';
    const stat = (s) => `<label title="${esc(s.label)}">${esc(s.label)}<input data-k="${s.key}" data-fid="w${wi}-${s.key}" value="${fmtNum(w[s.key])}"></label>`;
    card.innerHTML = `<div class="card-head"><input class="title" data-k="name" data-fid="w${wi}-name" value="${esc(w.name)}"><button class="small ghost" data-act="dup" title="Duplicate">⧉</button><button class="small ghost danger" data-act="del" title="Delete">🗑</button></div>
      <div class="statgrid">${WAND_STATS.map(stat).join('')}<label>Shuffle<input type="checkbox" data-k="shuffle" ${w.shuffle ? 'checked' : ''}></label><label title="Spawn this wand next to the player at the start of a run">Give at start<input type="checkbox" data-k="spawnAtStart" ${w.spawnAtStart ? 'checked' : ''}></label></div>
      <div class="group-title">Spells (${(w.spells || []).length}/${w.deck_capacity})</div><div data-s="spells"></div>
      <div class="group-title">Always cast</div><div data-s="always"></div>`;
    $('[data-s=spells]', card).replaceWith(stripEl(`w-${w.uid}-spells`, w.spells || [], (ids) => { const x = project.customWands.find((y) => y.uid === w.uid); if (x) x.spells = ids; }, { placeholder: 'Drag spells here (from the palette or the Spells list)' }));
    $('[data-s=always]', card).replaceWith(stripEl(`w-${w.uid}-always`, w.always || [], (ids) => { const x = project.customWands.find((y) => y.uid === w.uid); if (x) x.always = ids; }, { placeholder: 'Drag always-cast spells here' }));
    card.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      let v;
      if (e.target.type === 'checkbox') v = e.target.checked;
      else if (k === 'name') v = e.target.value;
      else { v = parseNumInput(e.target.value, w[k]); if (Number.isNaN(v)) { toast('Not a number', true); return render(); } }
      mutate((p) => { p.customWands[wi][k] = v; });
    });
    card.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'del') { mutate((p) => p.customWands.splice(wi, 1)); toast('Wand deleted', false, undo); }
      if (a === 'dup') mutate((p) => p.customWands.splice(wi + 1, 0, { ...clone(w), uid: uid(), name: w.name + ' copy' }));
    });
    cards.appendChild(card);
  });
  body.appendChild(cards);
  if (project.customWands.length) body.insertAdjacentHTML('beforeend', '<div class="note mt">Wands marked “Give at start” appear next to the player when a new run begins. Select chips with click / Ctrl+click / Shift+click, drag to reorder or move between wands (hold Alt to copy), press Delete to remove, or drag them back to the palette.</div>');
  insp.appendChild(paletteEl('Spell palette', 'Drag spells into wand slots. Ctrl+click to pick several. Double-click adds to the last-clicked wand.'));
}
function wandGen(body, insp) {
  const T = project.wandGen.tiers || {};
  const tier = ui.wandTier;
  const r = T[tier] || {};
  const tierLabel = (t) => (t === 'all' ? 'All wands' : `Tier ${t}`);
  body.innerHTML = `<p class="muted" style="margin-top:0">Rules run after the game generates a random wand (shops, chests, world). “All wands” applies first, then the tier rule. Tier ≈ depth (1 Mines … 6 Temple of the art; 10 = late game).</p>
    <div class="tierTabs">${WAND_TIERS.map((t) => `<span class="chip ${tier === t ? 'on' : ''}" data-tier="${t}">${tierLabel(t)}${T[t] && Object.keys(T[t]).length ? ' ●' : ''}</span>`).join('')}</div>
    <table class="rules"><thead><tr><th>Stat</th><th>× Multiply</th><th>+ Add</th><th>Min</th><th>Max</th><th></th></tr></thead><tbody>
    ${WAND_STATS.map((s) => `<tr data-s="${s.key}"><td>${esc(s.label)}</td>${['mult', 'add', 'min', 'max'].map((k) => `<td><input data-k="${k}" data-fid="wg-${tier}-${s.key}-${k}" value="${fmtNum(r[s.key]?.[k])}" placeholder="${k === 'mult' ? '1' : k === 'add' ? '0' : '—'}"></td>`).join('')}<td>${r[s.key] ? '<button class="small ghost" data-clear title="Clear">↺</button>' : ''}</td></tr>`).join('')}
    <tr><td>Shuffle</td><td colspan="4"><select data-shuffle><option value="keep">Keep game's choice</option><option value="never" ${r.shuffle === 'never' ? 'selected' : ''}>Never shuffle</option><option value="always" ${r.shuffle === 'always' ? 'selected' : ''}>Always shuffle</option></select></td><td></td></tr>
    </tbody></table>
    <div class="row mt"><button class="small" data-preset="strong">Preset: stronger wands</button><button class="small" data-preset="noshuffle">Preset: no shuffle anywhere</button><button class="small" data-preset="fast">Preset: fast casting</button><button class="small danger" data-preset="clear">Clear ${esc(tierLabel(tier))}</button></div>`;
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tier]');
    if (t) { ui.wandTier = t.dataset.tier; render(); return; }
    const c = e.target.closest('[data-clear]');
    if (c) { const s = c.closest('tr').dataset.s; mutate((p) => { delete p.wandGen.tiers[tier]?.[s]; }); return; }
    const pr = e.target.closest('[data-preset]')?.dataset.preset;
    if (!pr) return;
    mutate((p) => {
      const tt = (p.wandGen.tiers ||= {});
      if (pr === 'clear') delete tt[tier];
      if (pr === 'strong') tt.all = { ...(tt.all || {}), mana_max: { mult: 1.5 }, mana_charge_speed: { mult: 1.5 }, deck_capacity: { add: 2, max: 26 } };
      if (pr === 'noshuffle') tt.all = { ...(tt.all || {}), shuffle: 'never' };
      if (pr === 'fast') tt.all = { ...(tt.all || {}), fire_rate_wait: { mult: 0.5 }, reload_time: { mult: 0.5 } };
    });
    toast('Preset applied to "All wands"');
  });
  body.addEventListener('change', (e) => {
    if (e.target.matches('[data-shuffle]')) return mutate((p) => { ((p.wandGen.tiers ||= {})[tier] ||= {}).shuffle = e.target.value === 'keep' ? undefined : e.target.value; cleanTier(p, tier); });
    const k = e.target.dataset.k;
    const s = e.target.closest('tr')?.dataset.s;
    if (!k || !s) return;
    const v = e.target.value.trim() === '' ? undefined : Number(e.target.value);
    if (Number.isNaN(v)) { toast('Not a number', true); return render(); }
    mutate((p) => {
      const tr = ((p.wandGen.tiers ||= {})[tier] ||= {});
      const st = (tr[s] ||= {});
      if (v === undefined) delete st[k]; else st[k] = v;
      cleanTier(p, tier);
    });
  });
  insp.innerHTML = `<h3>How generation rules work</h3><div class="sub">Applies to every randomly generated wand.</div>
    <div class="note"><b>× Multiply</b> scales the generated value, <b>+ Add</b> shifts it, then it is clamped to <b>Min/Max</b>.<br><br>Example: capacity × 1, + 2, max 26 → every wand gets two more slots (capped at 26).<br><br>Cast delay and recharge are in frames (60 = 1 second); lower is faster.</div>
    <div class="note">Want a specific wand instead? Use the <b>Custom wands</b> tab.</div>`;
}
function cleanTier(p, tier) {
  const tr = p.wandGen.tiers[tier];
  if (!tr) return;
  for (const k of Object.keys(tr)) {
    if (tr[k] === undefined || (typeof tr[k] === 'object' && !Object.keys(tr[k]).length)) delete tr[k];
  }
  if (!Object.keys(tr).length) delete p.wandGen.tiers[tier];
}

// ───────────────────────── Loadout ─────────────────────────
function viewLoadout(main, insp) {
  viewHead(main, 'Starting loadout');
  const body = document.createElement('div');
  body.className = 'view-body pad';
  main.appendChild(body);
  strips.clear();
  const lo = project.loadout;
  const form = document.createElement('div');
  form.className = 'form';
  const set = (k) => (p, _it, v) => { p.loadout[k] = v; };
  form.appendChild(groupTitle('Player'));
  form.appendChild(fieldRow({ label: 'Starting health (hp)', items: [lo], kind: 'num', fid: 'lo-hp', get: () => lo.hp, isMod: () => has(lo.hp), set: set('hp'), hint: 'Vanilla is 100.', min: 1 }));
  form.appendChild(fieldRow({ label: 'Starting gold', items: [lo], kind: 'num', fid: 'lo-gold', get: () => lo.gold, isMod: () => has(lo.gold), set: set('gold'), int: true, min: 0 }));
  form.appendChild(fieldRow({ label: 'Remove the default starting wands', items: [lo], kind: 'bool', fid: 'lo-rm', get: () => !!lo.removeStartingWands, isMod: () => !!lo.removeStartingWands, set: set('removeStartingWands') }));
  form.appendChild(groupTitle('Starting spells (dropped at your feet)'));
  form.appendChild(stripEl('loadout-spells', lo.spells || [], (ids) => { project.loadout.spells = ids; }, { placeholder: 'Drag spells here from the palette, or drag selected spells onto “Starting loadout” in the sidebar' }));
  form.appendChild(groupTitle('Starting wands'));
  if (!project.customWands.length) form.insertAdjacentHTML('beforeend', '<div class="muted">No custom wands yet — create one in Wands.</div>');
  project.customWands.forEach((w, i) => {
    form.appendChild(fieldRow({
      label: `${w.name} (${(w.spells || []).length} spells)`, items: [w], kind: 'bool', fid: 'lo-w' + i,
      get: () => !!w.spawnAtStart, set: (p, _it, v) => { p.customWands[i].spawnAtStart = v; },
    }));
  });
  buttons(form, [['Open wand editor', () => { ui.view = 'wands'; ui.wandTab = 'custom'; render(); }]]);
  body.appendChild(form);
  insp.appendChild(paletteEl('Spell palette', 'Drag spells into the starting spells area. Double-click to add.'));
  ui.activeStrip ||= 'loadout-spells';
}

// ───────────────────────── Global tweaks ─────────────────────────
function viewGlobals(main) {
  viewHead(main, 'Global tweaks');
  const body = document.createElement('div');
  body.className = 'view-body pad';
  main.appendChild(body);
  const g = project.globals;
  const form = document.createElement('div');
  form.className = 'form';
  const set = (k) => (p, _it, v) => { p.globals[k] = v; };
  const row = (label, k, hint, kind = 'num') => fieldRow({ label, items: [g], kind, fid: 'g-' + k, get: () => g[k], base: () => (kind === 'bool' ? false : 1), isMod: () => has(g[k]) && g[k] !== 1 && g[k] !== false, set: set(k), hint, step: 0.05 });
  form.appendChild(groupTitle('Spells'));
  form.appendChild(row('Mana cost ×', 'manaMult', 'Multiplies every spell\'s mana cost (before per-spell edits).'));
  form.appendChild(row('Shop price ×', 'priceMult'));
  form.appendChild(row('Unlimited uses for every spell', 'unlimitedUses', '', 'bool'));
  form.appendChild(groupTitle('Spawn chance × by spell type'));
  for (const t of SPELL_TYPES) {
    form.appendChild(fieldRow({
      label: t.label, items: [g], kind: 'num', fid: 'g-sp-' + t.code, step: 0.05, base: () => 1,
      get: () => g.spawnMultByType?.[t.code], isMod: () => has(g.spawnMultByType?.[t.code]) && g.spawnMultByType[t.code] !== 1,
      set: (p, _it, v) => { p.globals.spawnMultByType ||= {}; if (has(v)) p.globals.spawnMultByType[t.code] = v; else delete p.globals.spawnMultByType[t.code]; },
    }));
  }
  form.appendChild(groupTitle('Enemies'));
  form.appendChild(row('Enemy HP ×', 'enemyHpMult', 'Multiplies the health of every creature in the list, unless you set its HP explicitly.'));
  body.appendChild(form);
  $('#inspector').innerHTML = '<h3>Global tweaks</h3><div class="sub">Quick, game-wide knobs.</div><div class="note">These multiply the game\'s own values inside Noita, so they work even without imported game data. Per-spell and per-enemy edits take priority.</div>';
}

// ───────────────────────── Export ─────────────────────────
function viewExport(main, insp) {
  viewHead(main, 'Export mod', '<span class="spacer"></span><button class="primary" id="dl">⬇ Download .zip</button>');
  $('#dl').addEventListener('click', exportZip);
  const { files, warnings, modId } = generateMod(project, catalog);
  const body = document.createElement('div');
  body.className = 'view-body pad';
  main.appendChild(body);
  const names = Object.keys(files);
  if (!names.includes(ui.exportFile)) ui.exportFile = `${modId}/init.lua`;
  const content = files[ui.exportFile];
  body.innerHTML = `${warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
    <div class="filetree"><div class="files">${names.map((n) => `<div class="${n === ui.exportFile ? 'on' : ''}" data-f="${esc(n)}">${esc(n)}</div>`).join('')}</div>
    <pre>${typeof content === 'string' ? esc(content) : `(binary file, ${content?.length || 0} bytes)`}</pre></div>`;
  body.addEventListener('click', (e) => { const f = e.target.closest('[data-f]'); if (f) { ui.exportFile = f.dataset.f; render(); } });
  const meta = project.meta;
  insp.appendChild(groupTitle('Mod info'));
  const m = (k, label, hint) => fieldRow({ label, items: [meta], kind: 'text', fid: 'meta-' + k, get: () => meta[k], set: (p, _i, v) => { p.meta[k] = v; }, hint });
  insp.appendChild(m('name', 'Name'));
  insp.appendChild(m('id', 'Folder ID', `Folder name inside Noita/mods. Current: ${modId}`));
  insp.appendChild(m('description', 'Description'));
  insp.insertAdjacentHTML('beforeend', `<div class="group-title">Install</div>
    <ol style="padding-left:18px;margin:0">
      <li>Click <b>Download .zip</b>.</li>
      <li>Extract it into your Noita <code>mods</code> folder<br><span class="muted">(Steam: right-click Noita → Manage → Browse local files)</span> so you have <code>mods/${esc(modId)}/init.lua</code>.</li>
      <li>Start Noita → <b>Mods</b> → enable <b>${esc(meta.name || modId)}</b>.</li>
      <li>Start a <b>new game</b> (spell, wand & enemy changes need a fresh world).</li>
    </ol>
    <div class="note">The generated Lua is plain and commented — open it in any editor to tweak further.</div>`);
}
function exportZip() {
  const { files, modId, warnings } = generateMod(project, catalog);
  const zip = makeZip(files);
  download(new Blob([zip], { type: 'application/zip' }), `${modId}.zip`);
  toast(`Exported ${modId}.zip${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''} — see Export tab)` : ''}`);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ───────────────────────── Import game data ─────────────────────────
function importDialog() {
  modal(`<h2>Import game data</h2>
    <p>Load the real spell & enemy stats from your own copy of Noita so every vanilla value shown is exact.</p>
    <ol>
      <li>Unpack the game's data: run <code>noita_dev.exe</code> from the Noita install folder and use its <b>unpack data</b> option, or use any <code>data.wak</code> extractor.</li>
      <li>Choose (or drag in) the resulting <code>data</code> folder. Only these are read: <code>scripts/gun/gun_actions.lua</code>, <code>translations/common.csv</code>, <code>entities/animals/**</code>, <code>entities/projectiles/**</code>.</li>
    </ol>
    <p class="muted">Nothing is uploaded — files are read locally in your browser.</p>
    <div class="actions"><button data-close>Cancel</button><button id="imp-files">Choose files…</button><button class="primary" id="imp-dir">Choose data folder…</button></div>`);
  $('#imp-dir').addEventListener('click', () => $('#dir-import').click());
  $('#imp-files').addEventListener('click', () => $('#file-import').click());
}
$('#dir-import').addEventListener('change', (e) => { importFiles([...e.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }))); e.target.value = ''; });
$('#file-import').addEventListener('change', (e) => { importFiles([...e.target.files].map((f) => ({ path: f.name, file: f }))); e.target.value = ''; });

const normPath = (p) => {
  const s = p.replace(/\\/g, '/');
  const i = s.lastIndexOf('data/');
  return i >= 0 ? s.slice(i) : s;
};
async function importFiles(list) {
  closeModal();
  const entries = list.map((x) => ({ ...x, norm: normPath(x.path) }));
  const find = (re) => entries.find((x) => re.test(x.norm) || re.test(x.path));
  const gun = find(/gun_actions\.lua$/);
  const trF = find(/translations\/common\.csv$/) || find(/common\.csv$/);
  const animals = entries.filter((x) => /entities\/animals\/.*\.xml$/.test(x.norm));
  const projs = entries.filter((x) => /entities\/projectiles\/.*\.xml$/.test(x.norm));
  if (!gun && !animals.length && !projs.length) return toast('No game data found. Pick the unpacked “data” folder (or gun_actions.lua).', true);
  toast('Reading game data…');
  const translations = trF ? parseTranslations(await trF.file.text()) : {};
  const next = clone(catalog);
  next.source = 'imported';
  let nSpells = 0;
  if (gun) {
    const spells = parseGunActions(await gun.file.text(), translations);
    if (spells.length) { next.spells = spells; nSpells = spells.length; }
  }
  if (projs.length) {
    const byPath = new Map(projs.map((x) => [x.norm, x]));
    next.projectiles = projs.map((x) => x.norm).sort();
    await Promise.all(next.spells.map(async (s) => {
      const x = s.projectile && byPath.get(s.projectile);
      if (x) s.proj = parseProjectileXml(await x.file.text());
    }));
  }
  if (animals.length) {
    const biomeByFile = new Map(BUILTIN_ENEMIES.map((e) => [e.file, e.biome]));
    const parsed = await Promise.all(animals.map(async (x) => parseEnemyXml(await x.file.text(), x.norm, translations)));
    next.enemies = parsed.filter((e) => e.isEnemy).map(({ isEnemy, ...e }) => ({ ...e, biome: biomeByFile.get(e.file) || e.file.split('/').slice(3, -1).join('/') || 'Other' }));
  }
  catalog = next;
  if (!lsSet(LS_CATALOG, catalog)) toast('Imported, but the data is too large to remember after reload.', true);
  render();
  toast(`Imported ${nSpells ? nSpells + ' spells' : 'no spells'}, ${animals.length ? next.enemies.length + ' creatures' : 'no creatures'}${projs.length ? ', ' + projs.length + ' projectile files' : ''}.`);
}

// ───────────────────────── project files ─────────────────────────
function saveProject() {
  download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${sanitizeModId(project.meta.id || project.meta.name)}.noitamod.json`);
}
async function openProjectFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.meta) throw new Error('not a project');
    mutate(() => { project = Object.assign(newProject(), data); });
    toast(`Opened ${file.name}`);
  } catch { toast('That file is not a Noita Mod Forge project', true); }
}
$('#file-open').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openProjectFile(f); });

// Whole-window file drop: folders → import, .json → open, .png → custom spell icon.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropveil').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropveil').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropveil').hidden = true;
  const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      if (/\.(lua|csv|xml|json|png)$/i.test(entry.name)) out.push({ path: path + entry.name, file: await new Promise((res, rej) => entry.file(res, rej)) });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, path + entry.name + '/');
      } while (batch.length);
    }
  };
  if (items.length) { for (const it of items) await walk(it, ''); } else out.push(...[...e.dataTransfer.files].map((f) => ({ path: f.name, file: f })));
  const json = out.find((x) => /\.json$/i.test(x.path));
  const pngs = out.filter((x) => /\.png$/i.test(x.path));
  if (json && out.length === 1) return openProjectFile(json.file);
  if (pngs.length === out.length) {
    if (ui.view === 'custom' && ui.sel.custom.size) return setSpriteFromFile(pngs[0].file, [...ui.sel.custom]);
    return toast('To set a spell icon, select a custom spell first, then drop the PNG.', true);
  }
  importFiles(out);
});

// ───────────────────────── chrome: menus, modal, toasts, keys ─────────────────────────
function toast(msg, err = false, undoFn) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  if (undoFn) {
    const b = document.createElement('button');
    b.className = 'small'; b.textContent = 'Undo';
    b.addEventListener('click', () => { undoFn(); t.remove(); });
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), undoFn ? 6000 : 3200);
}
function modal(html) {
  $('#modal-card').innerHTML = html;
  $('#modal').hidden = false;
  $$('#modal [data-close]').forEach((b) => b.addEventListener('click', closeModal));
}
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
function ctxMenu(e, items) {
  const m = $('#ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (!it) { m.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.innerHTML = `${esc(it[0])}${it[2] ? `<span class="k">${esc(it[2])}</span>` : ''}`;
    b.addEventListener('click', () => { m.hidden = true; it[1](); });
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctxmenu')) $('#ctxmenu').hidden = true;
  if (!e.target.closest('.menu')) $('#project-menu').hidden = true;
});
$('#btn-project').addEventListener('click', () => { $('#project-menu').hidden = !$('#project-menu').hidden; });
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !e.target.closest('#project-menu, #statusbar')) return;
  e.preventDefault();
  $('#project-menu').hidden = true;
  if (act === 'new') {
    if (!confirm('Start a new, empty project? (You can undo this.)')) return;
    mutate(() => { project = newProject(); });
    Object.values(ui.sel).forEach((s) => s.clear());
  }
  if (act === 'open') $('#file-open').click();
  if (act === 'save') saveProject();
  if (act === 'import') importDialog();
  if (act === 'reset-catalog') { catalog = builtinCatalog(); lsSet(LS_CATALOG, catalog); render(); toast('Using built-in reference data'); }
  if (act === 'help') helpDialog();
});
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-export').addEventListener('click', exportZip);
$('#mod-name').addEventListener('change', (e) => mutate((p) => { p.meta.name = e.target.value; }));

function helpDialog() {
  const rows = [
    ['Click / Shift+click / Ctrl+click', 'Select, range-select, toggle'],
    ['Drag down a list', 'Paint-select many rows'],
    ['Drag selected rows', 'Onto Wands, Custom spells or Starting loadout'],
    ['Ctrl+A · Esc', 'Select all visible · clear selection'],
    ['↑ ↓ (Shift)', 'Move (extend) selection'],
    ['Double-click a number cell', 'Edit it for every selected row'],
    ['Enter', 'Jump to the inspector'],
    ['Ctrl+C · Ctrl+V', 'Copy edits from a row · paste onto selection'],
    ['Ctrl+D', 'Clone as custom spell / duplicate'],
    ['Delete', 'Reset selected rows to vanilla (custom: delete)'],
    ['Ctrl+Z · Ctrl+Shift+Z', 'Undo · redo'],
    ['Ctrl+S', 'Export the mod .zip'],
    ['/', 'Search'],
    ['Alt+1 … Alt+7', 'Switch sections'],
    ['In number fields', '12 · *2 · /2 · +=5 · -=5 · 150% · ↑/↓ to step · drag the label to scrub'],
    ['Wand slots', 'Drag to reorder / move; Alt-drag copies; Delete removes'],
  ];
  modal(`<h2>Keyboard & mouse</h2><table class="shortcuts">${rows.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table><div class="actions"><button class="primary" data-close>Got it</button></div>`);
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape' && !$('#modal').hidden) { closeModal(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportZip(); return; }
  if (isTextTarget(e.target)) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.altKey && /^[1-7]$/.test(e.key)) { e.preventDefault(); go(VIEWS[Number(e.key) - 1].id); return; }
  if (e.key === '/' || (mod && e.key.toLowerCase() === 'f')) { const s = $('#main input[type=search]'); if (s) { e.preventDefault(); s.focus(); s.select(); } return; }
  if (e.key === '?') { helpDialog(); return; }
  // Route list shortcuts to the current grid even when it isn't focused.
  const g = $('#main .view-body[data-grid]');
  if (g && document.activeElement !== g && !e.target.closest?.('.strip') && ['ArrowUp', 'ArrowDown', 'Delete', 'Escape'].includes(e.key)) {
    g.focus({ preventScroll: true });
    g.dispatchEvent(new KeyboardEvent('keydown', e));
    e.preventDefault();
  } else if (g && document.activeElement !== g && mod && ['a', 'c', 'v', 'd'].includes(e.key.toLowerCase()) && !e.target.closest?.('.strip')) {
    e.preventDefault();
    g.focus({ preventScroll: true });
    g.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, ctrlKey: true, metaKey: e.metaKey, shiftKey: e.shiftKey }));
  }
});

// Datalists for autocomplete.
function datalists() {
  const mk = (id, vals) => {
    let dl = document.getElementById('dl-' + id);
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'dl-' + id; document.body.appendChild(dl); }
    dl.innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
  };
  mk('projectiles', projectileList());
  mk('herds', HERDS);
  mk('materials', MATERIALS);
  mk('components', ['DamageModelComponent', 'AnimalAIComponent', 'CharacterPlatformingComponent', 'CharacterDataComponent', 'GenomeDataComponent', 'PathFindingComponent', 'SpriteComponent', 'LuaComponent', 'ItemChestComponent', 'damage_multipliers']);
  mk('extras', ['data/entities/misc/homing.xml', 'data/entities/misc/explosive_projectile.xml', 'data/entities/misc/piercing_shot.xml', 'data/entities/misc/electric_charge.xml', 'data/entities/misc/freeze_charge.xml', 'data/entities/misc/fire_trail.xml', 'data/entities/misc/poison_trail.xml']);
}

datalists();
render();
if (!lsGet('nmf.welcomed')) {
  lsSet('nmf.welcomed', true);
  modal(`<h2>Welcome to Noita Mod Forge ✦</h2>
    <p>Build a Noita mod without writing code:</p>
    <ul><li><b>Spells</b> — change mana, uses, cast delay, damage, spawn chance… for one or hundreds of spells at once.</li>
    <li><b>Enemies</b> — health, resistances, faction, speed, attacks, any XML attribute.</li>
    <li><b>Wands</b> — tune random wand generation or design exact wands by dragging spells into slots.</li>
    <li><b>Custom spells</b>, <b>starting loadout</b> and <b>global tweaks</b>.</li></ul>
    <p>When you're done, <b>Export</b> downloads a ready-to-install mod folder.</p>
    <p class="note">Values shown start from built-in reference data. For exact vanilla numbers, <b>Project → Import game data</b>.</p>
    <div class="actions"><button data-close>Explore</button><button class="primary" id="w-imp">Import game data</button></div>`);
  $('#w-imp').addEventListener('click', importDialog);
}
