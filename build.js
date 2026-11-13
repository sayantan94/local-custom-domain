'use strict';
// Bundles src/console.{html,js,css} into the single console.html the proxy serves.
// Only needed after editing src/; the built file is committed so users need no install step.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const src = (f) => path.join(__dirname, 'src', f);
const bundle = (entry) =>
  esbuild.buildSync({ entryPoints: [src(entry)], bundle: true, minify: true, format: 'esm', target: 'es2022', write: false }).outputFiles[0].text;

const js = bundle('console.js').replaceAll('</script', '<\\/script');
const css = bundle('console.css').replaceAll('</style', '<\\/style');
const html = fs
  .readFileSync(src('console.html'), 'utf8')
  .replace('/*CSS*/', () => css)
  .replace('/*JS*/', () => js);

fs.writeFileSync(path.join(__dirname, 'console.html'), html);
console.log(`console.html  ${(html.length / 1024).toFixed(0)} KB  (js ${(js.length / 1024).toFixed(0)}, css ${(css.length / 1024).toFixed(0)})`);
