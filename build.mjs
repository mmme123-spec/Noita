// Bundles index.html + css + js modules into one self-contained file that works from file://
//   node build.mjs  →  dist/noita-mod-forge.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ORDER = ['data', 'importer', 'generator', 'zip', 'app'];
const modules = ORDER.map((name) => {
  let src = readFileSync(`js/${name}.js`, 'utf8');
  const exportsList = [];
  src = src.replace(/import\s*\{([^}]*)\}\s*from\s*'\.\/(\w+)\.js';/g, (_, names, mod) => `const {${names}} = __m.${mod};`);
  src = src.replace(/^export (async function|function|const|let|class) (\w+)/gm, (_, kw, id) => { exportsList.push(id); return `${kw} ${id}`; });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`Unhandled import/export in ${name}.js`);
  return `__m.${name} = (() => {\n${src}\nreturn { ${exportsList.join(', ')} };\n})();`;
});

const css = readFileSync('css/style.css', 'utf8');
const html = readFileSync('index.html', 'utf8')
  .replace('<link rel="stylesheet" href="css/style.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="js/app.js"></script>', () => `<script>\n"use strict";\nconst __m = {};\n${modules.join('\n\n').replace(/<\/script/gi, '<\\/script')}\n</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/noita-mod-forge.html', html);
console.log(`dist/noita-mod-forge.html (${(html.length / 1024).toFixed(0)} KB)`);
