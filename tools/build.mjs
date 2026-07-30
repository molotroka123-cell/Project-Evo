// tools/build.mjs — сборка однофайлового билда frontier.html из app/.
// Запуск: node tools/build.mjs
// Результат: frontier.html в корне — самодостаточный файл, работает по file:// без сети.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_IN = join(ROOT, 'app', 'index.html');
const ENTRY = join(ROOT, 'app', 'src', 'main.js');
const OUT = join(ROOT, 'frontier.html');
const MARKER = '<script type="module" src="src/main.js"></script>';

const res = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  charset: 'utf8',
  legalComments: 'none',
  minify: false,
  write: false,
});

const js = res.outputFiles[0].text;
const html = readFileSync(HTML_IN, 'utf8');
if (!html.includes(MARKER)) {
  console.error('ОШИБКА: в app/index.html не найдена строка подключения модуля:', MARKER);
  process.exit(1);
}
// </script> внутри строк JS разорвал бы тег — экранируем на всякий случай.
const safeJs = js.replace(/<\/script>/gi, '<\\/script>');
writeFileSync(OUT, html.replace(MARKER, `<script>\n${safeJs}\n</script>`), 'utf8');

const kb = (statSync(OUT).size / 1024).toFixed(0);
console.log(`frontier.html собран: ${kb} КБ (bundle ${(js.length / 1024).toFixed(0)} КБ)`);
