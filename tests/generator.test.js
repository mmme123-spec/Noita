import { test } from 'node:test';
import assert from 'node:assert/strict';
import luaparse from 'luaparse';
import { generateMod, spawnStrings, sanitizeModId } from '../js/generator.js';
import { BUILTIN_SPELLS, BUILTIN_ENEMIES } from '../js/data.js';
import { parseGunActions, parseTranslations, parseEnemyXml, parseProjectileXml } from '../js/importer.js';

const catalog = { spells: BUILTIN_SPELLS, enemies: BUILTIN_ENEMIES };
const parseLua = (src, name) => {
  try { luaparse.parse(src, { luaVersion: '5.1' }); } catch (e) { assert.fail(`${name}: ${e.message}\n${src}`); }
};

const fullProject = {
  meta: { id: 'My Cool Mod!', name: 'My "Cool" Mod', description: 'a <test>' },
  globals: { manaMult: 0.5, priceMult: 2, unlimitedUses: true, enemyHpMult: 1.5, spawnMultByType: { 2: 3 } },
  spellEdits: {
    LIGHT_BULLET: { mana: 1, max_uses: -1, d_fire_rate_wait: -5, d_damage: 10, speed_mult: 2, spawn: { 0: 5, 3: 1 }, proj: { damage: 50, explosion_radius: 20 } },
    BOMB: { disabled: true },
    DAMAGE: { d_reload: 4, d_spread: -3 },
  },
  customSpells: [
    { id: 'mega bolt', name: 'Mega "bolt"', type: 0, mana: 40, max_uses: 10, price: 300, spawn: { 2: 1, 3: 0.5 }, projBase: 'data/entities/projectiles/deck/bullet.xml', proj: { damage: 100, speed_min: 900, explosion_damage: 30 }, projCount: 3, trigger: 'timer', triggerDraws: 2, fire_rate_wait: 10, spriteData: 'data:image/png;base64,iVBORw0KGgo=' },
    { id: 'SUPER_MOD', name: 'Super modifier', type: 2, mana: 5, damage_add: 25, extra_entities: 'data/entities/misc/homing.xml', rawLua: 'c.bounces = c.bounces + 1' },
  ],
  wandGen: { tiers: { all: { mana_max: { mult: 2 }, deck_capacity: { add: 2, max: 26 }, shuffle: 'never' }, 3: { reload_time: { min: 5 } } } },
  customWands: [{ name: 'Starter', spawnAtStart: true, mana_max: 900, deck_capacity: 3, spells: ['LIGHT_BULLET', 'BOMB'], always: ['BURST_2'] }],
  enemyEdits: {
    'data/entities/animals/zombie.xml': { hp: 100, herd_id: 'player', can_fly: true, dm_fire: 0, custom: [{ tag: 'AnimalAIComponent', attr: 'attack_dash_distance', value: '50' }] },
  },
  loadout: { spells: ['BOMB', 'NUKE'], gold: 1000, hp: 200, removeStartingWands: true },
};

test('generated Lua parses as Lua 5.1', () => {
  const { files, modId, warnings } = generateMod(fullProject, catalog);
  assert.equal(modId, 'my_cool_mod');
  const luaFiles = Object.keys(files).filter((f) => f.endsWith('.lua'));
  assert.ok(luaFiles.length >= 5, luaFiles.join(','));
  for (const f of luaFiles) parseLua(files[f], f);
  assert.ok(files['my_cool_mod/mod.xml'].includes('My &quot;Cool&quot; Mod'));
  assert.ok(files['my_cool_mod/files/projectiles/mega_bolt.xml'].includes('damage="4"'));
  assert.ok(files['my_cool_mod/files/ui_gfx/mega_bolt.png'] instanceof Uint8Array);
  const ga = files['my_cool_mod/files/gun_actions_append.lua'];
  assert.match(ga, /\[ACTION_TYPE_MODIFIER\] = 3/);
  assert.match(ga, /add_projectile_trigger_timer\("mods\/my_cool_mod\/files\/projectiles\/mega_bolt.xml", 10, 2\)/);
  assert.match(ga, /spawn_probability = "0"/);
  const init = files['my_cool_mod/init.lua'];
  assert.match(init, /ModLuaFileAppend\("data\/scripts\/gun\/procedural\/gun_procedural.lua"/);
  assert.match(init, /"DamageModelComponent", "hp", 4 \}/);
  assert.match(init, /data\/entities\/projectiles\/deck\/light_bullet.xml/);
  assert.ok(Array.isArray(warnings));
});

test('empty project still produces a valid mod', () => {
  const { files, warnings } = generateMod({ meta: { name: 'x' } }, catalog);
  parseLua(files['x/init.lua'], 'init');
  assert.ok(warnings.some((w) => /no changes/.test(w)));
});

test('helpers', () => {
  assert.deepEqual(spawnStrings({ 3: 1, 0: 0.5 }), { level: '0,3', prob: '0.5,1' });
  assert.equal(sanitizeModId('  Hello World '), 'hello_world');
});

test('importer parses gun_actions.lua entries', () => {
  const src = `
actions =
{
  {
    id          = "LIGHT_BULLET",
    name        = "$action_light_bullet",
    description = "$actiondesc_light_bullet", -- comment with { brace
    sprite      = "data/ui_gfx/gun_actions/light_bullet.png",
    related_projectiles = {"data/entities/projectiles/deck/light_bullet.xml"},
    type        = ACTION_TYPE_PROJECTILE,
    spawn_level = "0,1,2",
    spawn_probability = "2,1,0.5",
    price = 100,
    mana = 5,
    action = function()
      add_projectile("data/entities/projectiles/deck/light_bullet.xml")
      c.fire_rate_wait = c.fire_rate_wait + 3
      c.screenshake = c.screenshake + 0.5
      c.spread_degrees = c.spread_degrees - 1.0
      local s = "}"
    end,
  },
  {
    id = "RECHARGE", name = "Reduce", type = ACTION_TYPE_MODIFIER, spawn_level = "1", spawn_probability = "1", price = 200, mana = 12, max_uses = 5,
    action = function()
      current_reload_time = current_reload_time - 20
      draw_actions( 1, true )
    end,
  },
}`;
  const tr = parseTranslations('key,en\naction_light_bullet,"Spark bolt, really",x\n');
  const out = parseGunActions(src, tr);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Spark bolt, really');
  assert.equal(out[0].fire_rate_wait, 3);
  assert.equal(out[0].spread, -1);
  assert.deepEqual(out[0].spawn, { 0: 2, 1: 1, 2: 0.5 });
  assert.equal(out[0].projectile, 'data/entities/projectiles/deck/light_bullet.xml');
  assert.equal(out[1].reload, -20);
  assert.equal(out[1].max_uses, 5);
  assert.equal(out[1].type, 2);
});

test('importer parses entity xml', () => {
  const xml = `<Entity name="$animal_zombie" tags="enemy,mortal">
  <Base file="data/entities/base_enemy_basic.xml">
    <DamageModelComponent hp="2" max_hp="2" blood_material="blood">
      <damage_multipliers fire="0.5" />
    </DamageModelComponent>
    <AnimalAIComponent attack_melee_damage_min="0.4" can_fly="0" />
  </Base>
  <GenomeDataComponent herd_id="zombie" />
</Entity>`;
  const e = parseEnemyXml(xml, 'data/entities/animals/zombie.xml', { animal_zombie: 'Zombie' });
  assert.equal(e.name, 'Zombie');
  assert.equal(e.attrs.hp, 50);
  assert.equal(e.attrs.dm_fire, 0.5);
  assert.equal(e.attrs.herd_id, 'zombie');
  assert.equal(e.attrs.melee_min, 10);
  assert.equal(e.attrs.can_fly, false);
  const p = parseProjectileXml('<ProjectileComponent damage="0.12" speed_min="800"><config_explosion explosion_radius="5" damage="1"/></ProjectileComponent>');
  assert.deepEqual(p, { damage: 3, speed_min: 800, explosion_radius: 5, explosion_damage: 25 });
});
