# Noita Mod Forge

A browser-based editor for making [Noita](https://noitagame.com/) mods without writing code. Edit spells, enemies,
wands and the starting loadout, then export a mod folder ready to install. Nothing to install; it runs entirely in
your browser.

## Run it

- **Easiest:** open `dist/noita-mod-forge.html` (a single self-contained file) in Chrome, Edge or Firefox.
- **From source:** `npm start`, then open http://localhost:8080. (The source uses ES modules, so it has to be
  served rather than opened from disk.)

After changing the source, run `npm run build` to regenerate `dist/noita-mod-forge.html`, and `npm test` to run the
tests. The tests check that all generated Lua parses as Lua 5.1.

## What you can change

| Section | What you can do |
|---|---|
| **Spells** | Mana, uses, cast delay, recharge, spread, bonus damage, projectile speed, price. Edit the spell's projectile file directly (damage, speed, lifetime, explosion radius and damage, bounces, knockback). Set spawn chance per tier, or turn a spell off entirely. |
| **Enemies** | Health, damage taken per type (projectile, fire, ice, …), faction (for example `player` to make them friendly), aggression, detection range, flying, movement speeds, melee damage, which projectile they shoot and how many. Custom rows let you set **any** XML attribute on any component. |
| **Wands** | *Random generation rules* (multiply, add, min and max for mana, recharge, capacity, cast delay, spread and more, for all wands or per tier, plus shuffle rules). *Custom wands* are built by dragging spells into slots and always-cast slots. |
| **Custom spells** | New spells of any type: projectile with optional count and trigger, timer or death-trigger payload, modifiers, multicasts. Includes projectile overrides, spawn tiers, a custom 16×16 icon, and an "extra Lua" box for anything else. |
| **Starting loadout** | Starting HP and gold, removing the default wands, spells dropped at your feet, and custom wands given at start. |
| **Global tweaks** | Mana cost ×, price ×, unlimited uses, spawn chance × per spell type, enemy HP ×. |

## Editing quickly

- **Multi-select:** click, Shift+click, Ctrl/⌘+click, or **drag down the list** to paint-select. Ctrl+A selects
  everything visible. Every edit applies to all selected rows.
- **Expressions:** number fields accept `*2`, `/2`, `+=5`, `-=5` and `150%`. Each is applied to every selected item's
  own value. Leave a field empty to go back to vanilla.
- **Scrubbing:** drag a field's label left or right, or use ↑/↓ (hold Shift for ×10).
- **Spawn chance:** paint the tier bars with the mouse.
- **Drag and drop:**
  - Drag selected spells onto **Wands**, **Custom spells** or **Starting loadout** in the sidebar.
  - Drag spells from the palette into wand slots. Reorder slots or move them between wands; hold Alt while dragging to copy.
  - Drag a slot back onto the palette to remove it.
  - Drop a game data folder, a project `.json` or an icon PNG anywhere on the window.
- **Spreadsheet-style:** double-click a number cell to edit it (applies to the whole selection). Right-click opens a
  context menu. Ctrl+C / Ctrl+V copies one row's edits onto other rows. Delete resets rows to vanilla.
- **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z). The project autosaves in the browser; use Project → Save to keep a `.json` copy.

Press `?` in the app to see every shortcut.

## Exact vanilla values

The app ships with **approximate** reference data so it works out of the box. Your edits never depend on these
numbers, because the mod only writes the values you change. To see exact values, unpack the game's data (for example
with `noita_dev.exe`'s unpack-data option or a `data.wak` extractor), then use **Project → Import game data** and
pick the `data` folder. It reads `scripts/gun/gun_actions.lua`, `translations/common.csv`, `entities/animals/**` and
`entities/projectiles/**`. The files are read locally and never uploaded.

## Installing the exported mod

1. **Export mod** downloads `<mod_id>.zip`.
2. Extract it into `Noita/mods/` so that `mods/<mod_id>/init.lua` exists.
3. Enable the mod in Noita's **Mods** menu and start a **new game**.

## How the generated mod works

- Spell changes are appended to `data/scripts/gun/gun_actions.lua` with `ModLuaFileAppend`. Absolute values (mana,
  uses, spawn) are set on the action table. Cast delay, recharge, spread, damage and speed are applied by wrapping the
  spell's `action` function.
- Enemy and projectile changes rewrite XML attributes at load time with
  `ModTextFileGetContent`/`ModTextFileSetContent`. If an attribute is missing, it's added to the component, or
  injected as a `<Base>` override.
- Wand generation rules wrap `generate_gun` in `gun_procedural.lua` and adjust the `AbilityComponent` afterwards.
- Custom wands and the starting loadout are set up in `OnPlayerSpawned`, once per run.

The generated Lua is plain and readable, so you can keep editing it by hand.

## Project layout

```
index.html, css/style.css   UI shell
js/app.js                   UI: views, selection, drag & drop, inspector, undo
js/data.js                  built-in reference data and field definitions
js/importer.js              parsers for gun_actions.lua, translations and entity XML
js/generator.js             project → mod files
js/zip.js                   tiny dependency-free zip writer
build.mjs                   bundles everything into dist/noita-mod-forge.html
tests/                      node:test suite (Lua syntax checked with luaparse)
```
