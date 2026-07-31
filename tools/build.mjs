// tools/build.mjs — сборка однофайлового билда frontier.html из app/.
// Запуск: node tools/build.mjs
// Результат: frontier.html в корне — самодостаточный файл, работает по file:// без сети.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_IN = join(ROOT, 'app', 'index.html');
const ENTRY = join(ROOT, 'app', 'src', 'main.js');
const OUT = join(ROOT, 'frontier.html');
const MARKER = '<script type="module" src="src/main.js"></script>';

// --- перепись нарисованного арта -------------------------------------------
// Рендер обязан просить только те спрайты, которые физически есть: каждый
// недостающий файл — красная 404 в консоли, а приёмка требует нуля ошибок.
// Достаточно положить buildings_<id>.png в app/assets/sprites/ и пересобрать.
function refreshArtList() {
  let files = [];
  try { files = readdirSync(join(ROOT, 'app', 'assets', 'sprites')); } catch { /* папки нет — арта нет */ }
  const ids = files
    .filter(f => /^buildings_.+\.png$/i.test(f))
    .map(f => f.replace(/^buildings_/i, '').replace(/\.png$/i, ''))
    .sort();
  const path = join(ROOT, 'app', 'src', 'render', 'artpack_list.js');
  const src = readFileSync(path, 'utf8');

  // Пустая папка НЕ значит «арта нет в игре». Спрайты весят 23 МБ и лежат рядом
  // с опубликованной страницей, а не в репозитории. Если строить список строго
  // по диску, сборка на чистом клоне молча выключает весь нарисованный арт —
  // ровно это и случилось: собранный билд перестал грузить 42 картинки, хотя
  // на сайте они лежат и отдаются. Поэтому при пустой папке берём заявленный
  // MANIFEST: несуществующий файл рендер и так переживает (im.onerror оставляет
  // процедурную отрисовку), а вот молча потерять весь арт — нельзя.
  let list = ids;
  if (!ids.length) {
    const decl = readFileSync(join(ROOT, 'app', 'src', 'render', 'artpack.js'), 'utf8');
    const m = decl.match(/export const MANIFEST = \[([\s\S]*?)\]/);
    if (m) list = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    if (list.length) console.log(`  арт: папка спрайтов пуста, беру MANIFEST — ${list.length} шт.`);
  }

  const line = `export const AVAILABLE = [${list.map(i => `'${i}'`).join(', ')}];`;
  const next = src.replace(/export const AVAILABLE = \[[^\]]*\];/, line);
  if (next !== src) writeFileSync(path, next, 'utf8');
  return list.length;
}
const artCount = refreshArtList();

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
console.log(`frontier.html собран: ${kb} КБ (bundle ${(js.length / 1024).toFixed(0)} КБ) · нарисованных спрайтов: ${artCount}`);
