// Turns an editor project into the files of a Noita mod folder.
import { SPELL_TYPES, typeByCode, ENEMY_FIELDS, PROJ_FIELDS, WAND_STATS } from './data.js';

export const luaStr = (s) => '"' + String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
export const xmlEsc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 100000) / 100000);
};
const has = (v) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
const luaKey = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '[' + luaStr(k) + ']');

export function sanitizeModId(s) {
  const id = String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return id || 'my_noita_mod';
}
export const sanitizeSpellId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'CUSTOM_SPELL';

export function spawnStrings(spawn) {
  const tiers = Object.keys(spawn || {}).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (!tiers.length) return { level: '0', prob: '0' };
  return { level: tiers.join(','), prob: tiers.map((t) => num(spawn[t])).join(',') };
}

function luaTable(obj, indent = '  ') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!has(v)) continue;
    let val;
    if (typeof v === 'string') val = luaStr(v);
    else if (typeof v === 'boolean') val = v ? 'true' : 'false';
    else if (Array.isArray(v)) val = '{' + v.map((x) => (typeof x === 'string' ? luaStr(x) : num(x))).join(', ') + '}';
    else if (typeof v === 'object') val = luaTable(v, indent + '  ');
    else val = num(v);
    parts.push(indent + '  ' + luaKey(k) + ' = ' + val + ',');
  }
  return '{\n' + parts.join('\n') + '\n' + indent + '}';
}

const XML_HELPERS = `-- XML patch helpers: edit attributes in game XML before the world loads.
local function lua_escape(s) return (s:gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0")) end
local function fmt(v)
  if type(v) == "boolean" then return v and "1" or "0" end
  if type(v) == "number" and v == math.floor(v) and math.abs(v) < 1e9 then return string.format("%d", v) end
  return tostring(v)
end
local function patch_attrs(attrs, attr, value, op)
  local found = false
  attrs = attrs:gsub("(%s" .. lua_escape(attr) .. "%s*=%s*\\")([^\\"]*)(\\")", function(a, old, b)
    found = true
    if op == "mul" then
      local n = tonumber(old)
      if not n then return a .. old .. b end
      return a .. fmt(n * value) .. b
    end
    return a .. fmt(value) .. b
  end)
  if not found and op ~= "mul" then
    local ins = " " .. attr .. "=\\"" .. fmt(value) .. "\\""
    if attrs:sub(-1) == "/" then attrs = attrs:sub(1, -2) .. ins .. " /" else attrs = attrs .. ins end
  end
  return attrs
end
local NESTED_PARENT = { damage_multipliers = "DamageModelComponent", config_explosion = "ProjectileComponent" }
local function inject(xml, parent, snippet)
  local done = false
  xml = xml:gsub("<" .. lua_escape(parent) .. "([%s/>][^>]*)>", function(attrs)
    if done then return nil end
    done = true
    if attrs:sub(-1) == "/" then return "<" .. parent .. attrs:sub(1, -2) .. ">" .. snippet .. "</" .. parent .. ">" end
    return "<" .. parent .. attrs .. ">" .. snippet
  end)
  if not done then
    xml = xml:gsub("<" .. lua_escape(parent) .. ">", function()
      if done then return nil end
      done = true
      return "<" .. parent .. ">" .. snippet
    end)
  end
  return xml, done
end
local function patch_xml(path, edits)
  local ok, xml = pcall(ModTextFileGetContent, path)
  if not ok or type(xml) ~= "string" or xml == "" then
    print("[MOD_ID] skipped missing file " .. path)
    return
  end
  for _, e in ipairs(edits) do
    local tag, attr, value, op = e[1], e[2], e[3], e[4]
    local hit = false
    xml = xml:gsub("<" .. lua_escape(tag) .. "([%s/][^>]*)>", function(attrs)
      hit = true
      return "<" .. tag .. patch_attrs(attrs, attr, value, op) .. ">"
    end)
    xml = xml:gsub("<" .. lua_escape(tag) .. ">", function()
      hit = true
      return "<" .. tag .. patch_attrs("", attr, value, op) .. ">"
    end)
    if not hit and op ~= "mul" then
      local snippet = "<" .. tag .. " " .. attr .. "=\\"" .. fmt(value) .. "\\" ></" .. tag .. ">"
      local ok2
      xml, ok2 = inject(xml, NESTED_PARENT[tag] or "Base", snippet)
      if not ok2 then print("[MOD_ID] could not add " .. tag .. "." .. attr .. " to " .. path) end
    end
  end
  ModTextFileSetContent(path, xml)
end
`;

function fieldValue(f, v) {
  if (f.kind === 'bool') return v ? 1 : 0;
  if (f.kind === 'text') return String(v);
  return Number(v) / (f.scale || 1);
}
const luaVal = (v) => (typeof v === 'string' ? luaStr(v) : num(v));
const editLine = (tag, attr, v, op) => `{ ${luaStr(tag)}, ${luaStr(attr)}, ${luaVal(v)}${op ? ', ' + luaStr(op) : ''} }`;

export function buildProjectileEdits(projEdits) {
  const out = [];
  for (const f of PROJ_FIELDS) {
    const v = projEdits?.[f.key];
    if (has(v)) out.push([f.tag, f.attr, Number(v) / (f.scale || 1)]);
  }
  return out;
}

function projectileOverrideXml(base, proj) {
  const pc = [];
  const ex = [];
  for (const f of PROJ_FIELDS) {
    const v = proj?.[f.key];
    if (!has(v)) continue;
    const s = `${f.attr}="${num(Number(v) / (f.scale || 1))}"`;
    (f.tag === 'config_explosion' ? ex : pc).push(s);
  }
  const inner = ex.length ? `\n      <config_explosion ${ex.join(' ')} ></config_explosion>\n    ` : '';
  return `<Entity>\n  <Base file="${xmlEsc(base)}">\n    <ProjectileComponent ${pc.join(' ')} >${inner}</ProjectileComponent>\n  </Base>\n</Entity>\n`;
}

function dataUrlToBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function generateMod(project, catalog) {
  const modId = sanitizeModId(project.meta.id || project.meta.name);
  const root = `mods/${modId}/`;
  const files = {};
  const warnings = [];
  const init = [];
  const spellById = new Map(catalog.spells.map((s) => [s.id, s]));

  // ---------- spells ----------
  const spellEditLines = [];
  const projPatches = new Map(); // path -> edits
  const addPatch = (path, edits) => {
    if (!edits.length) return;
    if (!projPatches.has(path)) projPatches.set(path, []);
    projPatches.get(path).push(...edits);
  };
  for (const [id, e] of Object.entries(project.spellEdits || {})) {
    const base = spellById.get(id);
    const out = {};
    if (has(e.mana)) out.mana = Number(e.mana);
    if (has(e.max_uses)) out.max_uses = Number(e.max_uses);
    if (has(e.price)) out.price = Number(e.price);
    if (e.disabled) {
      const sp = spawnStrings(e.spawn || base?.spawn || { 0: 0 });
      out.spawn_level = sp.level;
      out.spawn_probability = sp.level.split(',').map(() => '0').join(',');
    } else if (e.spawn) {
      const sp = spawnStrings(e.spawn);
      out.spawn_level = sp.level;
      out.spawn_probability = sp.prob;
    }
    if (has(e.d_fire_rate_wait) && Number(e.d_fire_rate_wait)) out.d_frw = Number(e.d_fire_rate_wait);
    if (has(e.d_reload) && Number(e.d_reload)) out.d_reload = Number(e.d_reload);
    if (has(e.d_spread) && Number(e.d_spread)) out.d_spread = Number(e.d_spread);
    if (has(e.d_damage) && Number(e.d_damage)) out.d_dmg = Number(e.d_damage) / 25;
    if (has(e.speed_mult) && Number(e.speed_mult) !== 1) out.speed_mult = Number(e.speed_mult);
    if (Object.keys(out).length) spellEditLines.push(`  ${luaKey(id)} = ${luaTable(out, '  ').trimStart()},`);
    const projEdits = buildProjectileEdits(e.proj);
    if (projEdits.length) {
      if (base?.projectile) addPatch(base.projectile, projEdits);
      else warnings.push(`${id}: projectile changes ignored (no known projectile file — import game data or the spell has none).`);
    }
  }

  const g = project.globals || {};
  const typeMults = {};
  for (const t of SPELL_TYPES) {
    const m = g.spawnMultByType?.[t.code];
    if (has(m) && Number(m) !== 1) typeMults[t.key] = Number(m);
  }
  const globalsUsed = (has(g.manaMult) && Number(g.manaMult) !== 1) || (has(g.priceMult) && Number(g.priceMult) !== 1)
    || g.unlimitedUses || Object.keys(typeMults).length;

  const custom = (project.customSpells || []).filter((s) => s.id);
  const customLua = [];
  for (const s of custom) {
    const id = sanitizeSpellId(s.id);
    const t = typeByCode(Number(s.type));
    const sp = spawnStrings(s.spawn);
    let sprite = s.sprite || 'data/ui_gfx/gun_actions/light_bullet.png';
    if (s.spriteData) {
      const p = `files/ui_gfx/${id.toLowerCase()}.png`;
      files[p] = dataUrlToBytes(s.spriteData);
      sprite = root + p;
    }
    let projPath = s.projBase || '';
    const projOverrides = buildProjectileEdits(s.proj);
    if (projPath && projOverrides.length) {
      const p = `files/projectiles/${id.toLowerCase()}.xml`;
      files[p] = projectileOverrideXml(projPath, s.proj);
      projPath = root + p;
    }
    const body = [];
    if (Number(s.fire_rate_wait)) body.push(`c.fire_rate_wait = c.fire_rate_wait + ${num(s.fire_rate_wait)}`);
    if (Number(s.reload)) body.push(`current_reload_time = current_reload_time + ${num(s.reload)}`);
    if (Number(s.spread)) body.push(`c.spread_degrees = c.spread_degrees + ${num(s.spread)}`);
    if (Number(s.damage_add)) body.push(`c.damage_projectile_add = c.damage_projectile_add + ${num(Number(s.damage_add) / 25)}`);
    if (has(s.speed_mult) && Number(s.speed_mult) !== 1) body.push(`c.speed_multiplier = c.speed_multiplier * ${num(s.speed_mult)}`);
    if (Number(s.bounces)) body.push(`c.bounces = c.bounces + ${num(s.bounces)}`);
    if (Number(s.lifetime_add)) body.push(`c.lifetime_add = c.lifetime_add + ${num(s.lifetime_add)}`);
    if (Number(s.explosion_radius)) body.push(`c.explosion_radius = c.explosion_radius + ${num(s.explosion_radius)}`);
    if (Number(s.crit_chance)) body.push(`c.damage_critical_chance = c.damage_critical_chance + ${num(s.crit_chance)}`);
    for (const extra of String(s.extra_entities || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      body.push(`c.extra_entities = c.extra_entities .. ${luaStr(extra + ',')}`);
    }
    const isProj = t.code === 0 || t.code === 1 || t.code === 4 || t.code === 5;
    if (isProj && projPath) {
      const count = Math.max(1, Math.floor(Number(s.projCount) || 1));
      const trig = s.trigger || 'none';
      const draws = Math.max(1, Math.floor(Number(s.triggerDraws) || 1));
      let call;
      if (trig === 'hit') call = `add_projectile_trigger_hit_world(${luaStr(projPath)}, ${draws})`;
      else if (trig === 'timer') call = `add_projectile_trigger_timer(${luaStr(projPath)}, ${Math.max(1, Math.floor(Number(s.triggerDelay) || 10))}, ${draws})`;
      else if (trig === 'death') call = `add_projectile_trigger_death(${luaStr(projPath)}, ${draws})`;
      else call = `add_projectile(${luaStr(projPath)})`;
      body.push(count > 1 ? `for i = 1, ${count} do ${call} end` : call);
    } else if (isProj && !projPath && !s.rawLua) {
      warnings.push(`Custom spell ${id}: no projectile chosen, it will do nothing when cast.`);
    }
    const draw = has(s.draw) ? Math.floor(Number(s.draw)) : (t.code === 2 ? 1 : 0);
    if (draw > 0) body.push(`draw_actions(${draw}, true)`);
    if (s.rawLua) body.push(...String(s.rawLua).split('\n'));
    const fields = [
      `id = ${luaStr(id)}`,
      `name = ${luaStr(s.name || id)}`,
      `description = ${luaStr(s.description || '')}`,
      `sprite = ${luaStr(sprite)}`,
      `type = ${t.key}`,
      `spawn_level = ${luaStr(sp.level)}`,
      `spawn_probability = ${luaStr(sp.prob)}`,
      `price = ${num(s.price ?? 100)}`,
      `mana = ${num(s.mana ?? 10)}`,
    ];
    if (has(s.max_uses) && Number(s.max_uses) >= 0) fields.push(`max_uses = ${num(s.max_uses)}`);
    if (projPath) fields.push(`related_projectiles = { ${luaStr(projPath)} }`);
    customLua.push(`table.insert(actions, {\n  ${fields.join(',\n  ')},\n  action = function()\n${body.map((l) => '    ' + l).join('\n')}\n  end,\n})`);
  }

  if (spellEditLines.length || custom.length || globalsUsed) {
    const L = [`-- Generated by Noita Mod Forge: spell changes for ${modId}`];
    if (globalsUsed) {
      L.push(`local GLOBAL = ${luaTable({
        mana_mult: has(g.manaMult) && Number(g.manaMult) !== 1 ? Number(g.manaMult) : undefined,
        price_mult: has(g.priceMult) && Number(g.priceMult) !== 1 ? Number(g.priceMult) : undefined,
        unlimited_uses: g.unlimitedUses ? true : undefined,
      }, '')}`);
      L.push(`local TYPE_SPAWN_MULT = ${luaTable(Object.fromEntries(Object.entries(typeMults)), '')}`
        .replace(/(\s)(ACTION_TYPE_\w+) = /g, '$1[$2] = '));
      L.push(`local function scale_probs(s, m)
  return (s:gsub("[%d%.]+", function(n) return tostring(tonumber(n) * m) end))
end
for _, a in ipairs(actions) do
  if GLOBAL.mana_mult and a.mana and a.mana > 0 then a.mana = math.floor(a.mana * GLOBAL.mana_mult + 0.5) end
  if GLOBAL.price_mult and a.price then a.price = math.floor(a.price * GLOBAL.price_mult + 0.5) end
  if GLOBAL.unlimited_uses then a.max_uses = nil end
  local m = TYPE_SPAWN_MULT[a.type]
  if m and a.spawn_probability then a.spawn_probability = scale_probs(a.spawn_probability, m) end
end`);
    }
    if (spellEditLines.length) {
      L.push(`local EDITS = {\n${spellEditLines.join('\n')}\n}`);
      L.push(`for _, a in ipairs(actions) do
  local e = EDITS[a.id]
  if e then
    if e.mana then a.mana = e.mana end
    if e.max_uses then
      if e.max_uses < 0 then a.max_uses = nil else a.max_uses = e.max_uses end
    end
    if e.price then a.price = e.price end
    if e.spawn_level then a.spawn_level = e.spawn_level end
    if e.spawn_probability then a.spawn_probability = e.spawn_probability end
    if e.d_frw or e.d_reload or e.d_spread or e.d_dmg or e.speed_mult then
      local orig = a.action
      a.action = function(...)
        if e.d_frw then c.fire_rate_wait = c.fire_rate_wait + e.d_frw end
        if e.d_reload then current_reload_time = current_reload_time + e.d_reload end
        if e.d_spread then c.spread_degrees = c.spread_degrees + e.d_spread end
        if e.d_dmg then c.damage_projectile_add = c.damage_projectile_add + e.d_dmg end
        if e.speed_mult then c.speed_multiplier = c.speed_multiplier * e.speed_mult end
        return orig(...)
      end
    end
  end
end`);
    }
    if (customLua.length) L.push('-- Custom spells', ...customLua);
    files['files/gun_actions_append.lua'] = L.join('\n\n') + '\n';
    init.push(`ModLuaFileAppend("data/scripts/gun/gun_actions.lua", "${root}files/gun_actions_append.lua")`);
  }

  // ---------- enemies ----------
  const enemyBlocks = [];
  const hpMult = has(g.enemyHpMult) && Number(g.enemyHpMult) !== 1 ? Number(g.enemyHpMult) : null;
  const enemyFiles = new Set([...Object.keys(project.enemyEdits || {})]);
  if (hpMult) catalog.enemies.forEach((en) => enemyFiles.add(en.file));
  for (const file of enemyFiles) {
    const e = project.enemyEdits?.[file] || {};
    const lines = [];
    for (const f of ENEMY_FIELDS) {
      const v = e[f.key];
      if (!has(v)) continue;
      const val = fieldValue(f, v);
      lines.push(editLine(f.tag, f.attr, val));
      for (const a of f.also || []) lines.push(editLine(f.tag, a, val));
    }
    if (hpMult && !has(e.hp)) {
      lines.push(editLine('DamageModelComponent', 'hp', hpMult, 'mul'));
      lines.push(editLine('DamageModelComponent', 'max_hp', hpMult, 'mul'));
    }
    for (const c of e.custom || []) {
      if (!c.tag || !c.attr) continue;
      const n = Number(c.value);
      lines.push(editLine(c.tag, c.attr, c.value !== '' && !Number.isNaN(n) ? n : String(c.value ?? '')));
    }
    if (lines.length) enemyBlocks.push(`patch_xml(${luaStr(file)}, {\n  ${lines.join(',\n  ')},\n})`);
  }
  for (const [path, edits] of projPatches) {
    enemyBlocks.push(`patch_xml(${luaStr(path)}, {\n  ${edits.map((e) => editLine(...e)).join(',\n  ')},\n})`);
  }

  // ---------- wand generation ----------
  const rules = {};
  for (const [tier, stats] of Object.entries(project.wandGen?.tiers || {})) {
    const r = {};
    for (const s of WAND_STATS) {
      const x = stats?.[s.key];
      if (!x) continue;
      const o = {};
      if (has(x.mult) && Number(x.mult) !== 1) o.mult = Number(x.mult);
      if (has(x.add) && Number(x.add) !== 0) o.add = Number(x.add);
      if (has(x.min)) o.min = Number(x.min);
      if (has(x.max)) o.max = Number(x.max);
      if (Object.keys(o).length) r[s.key] = o;
    }
    if (stats?.shuffle && stats.shuffle !== 'keep') r.shuffle = stats.shuffle;
    if (Object.keys(r).length) rules[tier] = r;
  }
  if (Object.keys(rules).length) {
    files['files/gun_procedural_append.lua'] = `-- Generated by Noita Mod Forge: wand generation rules for ${modId}
local RULES = ${luaTable(rules, '')}
local STATS = {
${WAND_STATS.map((s) => `  { ${luaStr(s.key)}, ${s.obj ? luaStr(s.obj) : 'nil'}, ${luaStr(s.attr)}, ${s.int} },`).join('\n')}
}
local function get(ac, obj, attr)
  if obj then return ComponentObjectGetValue2(ac, obj, attr) end
  return ComponentGetValue2(ac, attr)
end
local function set(ac, obj, attr, v)
  if obj then ComponentObjectSetValue2(ac, obj, attr, v) else ComponentSetValue2(ac, attr, v) end
end
local function apply(ac, rule)
  if not rule then return end
  for _, s in ipairs(STATS) do
    local r = rule[s[1]]
    if r then
      local v = get(ac, s[2], s[3])
      if type(v) == "number" then
        if r.mult then v = v * r.mult end
        if r.add then v = v + r.add end
        if r.min and v < r.min then v = r.min end
        if r.max and v > r.max then v = r.max end
        if s[4] then v = math.floor(v + 0.5) end
        set(ac, s[2], s[3], v)
      end
    end
  end
  if rule.shuffle == "never" then ComponentObjectSetValue2(ac, "gun_config", "shuffle_deck_when_empty", false) end
  if rule.shuffle == "always" then ComponentObjectSetValue2(ac, "gun_config", "shuffle_deck_when_empty", true) end
end
if type(generate_gun) == "function" then
  local orig_generate_gun = generate_gun
  function generate_gun(cost, level, ...)
    local result = orig_generate_gun(cost, level, ...)
    local entity_id = GetUpdatedEntityID()
    local ac = entity_id and EntityGetFirstComponentIncludingDisabled(entity_id, "AbilityComponent")
    if ac then
      apply(ac, RULES.all)
      apply(ac, RULES[tostring(level)])
      ComponentSetValue2(ac, "mana", ComponentGetValue2(ac, "mana_max"))
    end
    return result
  end
end
`;
    init.push(`ModLuaFileAppend("data/scripts/gun/procedural/gun_procedural.lua", "${root}files/gun_procedural_append.lua")`);
  }

  // ---------- custom wands & loadout ----------
  const wands = (project.customWands || []);
  const startWands = wands.filter((w) => w.spawnAtStart);
  const lo = project.loadout || {};
  const spawnLines = [];
  if (wands.length) {
    files['files/wand_setup.lua'] = `dofile_once("data/scripts/gun/procedural/gun_action_utils.lua")
function ${modId}_setup_wand(wand, cfg)
  if not wand or wand == 0 then return end
  local ac = EntityGetFirstComponentIncludingDisabled(wand, "AbilityComponent")
  if not ac then return end
  for _, child in ipairs(EntityGetAllChildren(wand) or {}) do
    if EntityGetFirstComponentIncludingDisabled(child, "ItemActionComponent") then
      EntityRemoveFromParent(child)
      EntityKill(child)
    end
  end
  for _, id in ipairs(cfg.always or {}) do AddGunActionPermanent(wand, id) end
  for _, id in ipairs(cfg.spells or {}) do AddGunAction(wand, id) end
  ComponentSetValue2(ac, "mana_max", cfg.mana_max)
  ComponentSetValue2(ac, "mana_charge_speed", cfg.mana_charge_speed)
  ComponentSetValue2(ac, "mana", cfg.mana_max)
  ComponentObjectSetValue2(ac, "gun_config", "deck_capacity", cfg.deck_capacity)
  ComponentObjectSetValue2(ac, "gun_config", "actions_per_round", cfg.actions_per_round)
  ComponentObjectSetValue2(ac, "gun_config", "reload_time", cfg.reload_time)
  ComponentObjectSetValue2(ac, "gun_config", "shuffle_deck_when_empty", cfg.shuffle)
  ComponentObjectSetValue2(ac, "gunaction_config", "fire_rate_wait", cfg.fire_rate_wait)
  ComponentObjectSetValue2(ac, "gunaction_config", "spread_degrees", cfg.spread_degrees)
  ComponentObjectSetValue2(ac, "gunaction_config", "speed_multiplier", cfg.speed_multiplier)
  if cfg.name and cfg.name ~= "" then
    ComponentSetValue2(ac, "ui_name", cfg.name)
    local ic = EntityGetFirstComponentIncludingDisabled(wand, "ItemComponent")
    if ic then
      ComponentSetValue2(ic, "item_name", cfg.name)
      ComponentSetValue2(ic, "always_use_item_name_in_ui", true)
    end
  end
end
`;
    wands.forEach((w, i) => {
      const cfg = {
        name: w.name || '', mana_max: Number(w.mana_max ?? 500), mana_charge_speed: Number(w.mana_charge_speed ?? 200),
        deck_capacity: Math.max(1, Math.floor(Number(w.deck_capacity ?? 10))), actions_per_round: Math.max(1, Math.floor(Number(w.actions_per_round ?? 1))),
        reload_time: Math.floor(Number(w.reload_time ?? 20)), fire_rate_wait: Math.floor(Number(w.fire_rate_wait ?? 10)),
        spread_degrees: Number(w.spread_degrees ?? 0), speed_multiplier: Number(w.speed_multiplier ?? 1), shuffle: !!w.shuffle,
        spells: (w.spells || []).filter(Boolean), always: (w.always || []).filter(Boolean),
      };
      if (cfg.spells.length > cfg.deck_capacity) warnings.push(`Wand "${w.name || i + 1}": ${cfg.spells.length} spells but capacity ${cfg.deck_capacity}.`);
      files[`files/wands/wand_${i + 1}.lua`] = `dofile_once("${root}files/wand_setup.lua")
${modId}_setup_wand(GetUpdatedEntityID(), ${luaTable(cfg, '')})
`;
    });
  }
  const startSpells = (lo.spells || []).filter(Boolean);
  const playerTweaks = has(lo.hp) || has(lo.gold);
  if (startWands.length || startSpells.length || playerTweaks || lo.removeStartingWands) {
    spawnLines.push(`function OnPlayerSpawned(player_entity)
  if GameHasFlagRun("${modId}_loadout_given") then return end
  GameAddFlagRun("${modId}_loadout_given")
  local x, y = EntityGetTransform(player_entity)`);
    if (lo.removeStartingWands) {
      spawnLines.push(`  for _, child in ipairs(EntityGetAllChildren(player_entity) or {}) do
    if EntityGetName(child) == "inventory_quick" then
      for _, item in ipairs(EntityGetAllChildren(child) or {}) do
        if EntityHasTag(item, "wand") then EntityKill(item) end
      end
    end
  end`);
    }
    if (has(lo.hp)) {
      spawnLines.push(`  local dm = EntityGetFirstComponent(player_entity, "DamageModelComponent")
  if dm then
    ComponentSetValue2(dm, "max_hp", ${num(Number(lo.hp) / 25)})
    ComponentSetValue2(dm, "hp", ${num(Number(lo.hp) / 25)})
  end`);
    }
    if (has(lo.gold)) {
      spawnLines.push(`  local wallet = EntityGetFirstComponent(player_entity, "WalletComponent")
  if wallet then ComponentSetValue2(wallet, "money", ${Math.floor(Number(lo.gold))}) end`);
    }
    if (startWands.length) {
      wands.forEach((w, i) => {
        if (!w.spawnAtStart) return;
        spawnLines.push(`  do
    local wand = EntityLoad("data/entities/items/wand_level_01.xml", x - 30 + ${(i % 6) * 12}, y - 10)
    EntityAddComponent2(wand, "LuaComponent", {
      script_source_file = "${root}files/wands/wand_${i + 1}.lua",
      execute_every_n_frame = 2,
      execute_times = 1,
      remove_after_executed = true,
    })
  end`);
      });
    }
    if (startSpells.length) {
      spawnLines.push(`  dofile_once("data/scripts/gun/procedural/gun_action_utils.lua")
  pcall(dofile_once, "data/scripts/game_helpers.lua")
  local spells = { ${startSpells.map(luaStr).join(', ')} }
  for i, id in ipairs(spells) do
    local sx, sy = x - 40 + ((i - 1) % 10) * 9, y - 20 - math.floor((i - 1) / 10) * 9
    if CreateItemActionEntity then
      CreateItemActionEntity(id, sx, sy)
    else
      local card = EntityLoad("data/entities/misc/custom_cards/action.xml", sx, sy)
      local iac = EntityGetFirstComponentIncludingDisabled(card, "ItemActionComponent")
      if iac then ComponentSetValue2(iac, "action_id", id) end
    end
  end`);
    }
    spawnLines.push('end');
  }

  const spawnCode = spawnLines.join('\n');

  // ---------- init.lua ----------
  const initParts = [`-- ${project.meta.name || modId}\n-- Generated by Noita Mod Forge. Safe to edit by hand.`];
  if (enemyBlocks.length) initParts.push(XML_HELPERS.replace(/MOD_ID/g, modId), ...enemyBlocks);
  if (init.length) initParts.push(init.join('\n'));
  if (spawnCode) initParts.push(spawnCode);
  if (initParts.length === 1) warnings.push('The mod has no changes yet.');
  files['init.lua'] = initParts.join('\n\n') + '\n';
  files['mod.xml'] = `<Mod\n  name="${xmlEsc(project.meta.name || modId)}"\n  description="${xmlEsc(project.meta.description || 'Made with Noita Mod Forge')}"\n  request_no_api_restrictions="0"\n>\n</Mod>\n`;

  const finalFiles = {};
  for (const [p, c] of Object.entries(files)) finalFiles[`${modId}/${p}`] = c;
  return { modId, files: finalFiles, warnings };
}
