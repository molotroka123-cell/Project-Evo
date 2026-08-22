// tools/source-dump.mjs — склеивает исходники в один текстовый файл, чтобы их
// можно было отдать языковой модели одним куском.
//
// Запуск:
//   node tools/source-dump.mjs            → всё ядро + документы переноса
//   node tools/source-dump.mjs core       → только ядро
//   node tools/source-dump.mjs all        → ядро, рендер, интерфейс, тесты
//
// Зачем отдельно от pack.mjs: тот собирает ZIP для передачи человеку, а модели
// нужен ПЛОСКИЙ ТЕКСТ с понятными границами файлов. ZIP она не откроет.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const mode = (process.argv[2] || 'default').toLowerCase();

const SETS = {
  core:    ['app/src/core'],
  default: ['app/src/core', 'docs/ПЕРЕНОС_В_ДВИЖОК.md'],
  all:     ['app/src/core', 'app/src/render', 'app/src/ui', 'app/tests', 'docs/ПЕРЕНОС_В_ДВИЖОК.md'],
};
const roots = SETS[mode] || SETS.default;

function walk(p, out = []) {
  const abs = join(ROOT, p);
  let st;
  try { st = statSync(abs); } catch { return out; }
  if (st.isFile()) { out.push(p); return out; }
  for (const name of readdirSync(abs).sort()) walk(join(p, name), out);
  return out;
}

const files = [];
for (const r of roots) walk(r, files);
const keep = files.filter(f => ['.js', '.mjs', '.md'].includes(extname(f)));

const parts = [];
let bytes = 0, lines = 0;

// Оглавление впереди: модель должна видеть состав до того, как утонет в коде.
parts.push('# ФРОНТИР — исходники одним файлом\n');
parts.push(`Собрано: ${keep.length} файлов. Набор: «${mode}».\n`);
parts.push('Границы файлов помечены строкой ===== ФАЙЛ: путь =====\n');
parts.push('\n## Состав\n');
for (const f of keep) {
  const n = readFileSync(join(ROOT, f), 'utf8').split('\n').length;
  lines += n;
  parts.push(`- ${f} — ${n} строк`);
}
parts.push('\n');

for (const f of keep) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  bytes += Buffer.byteLength(src);
  parts.push(`\n\n===== ФАЙЛ: ${f} =====\n`);
  parts.push(src);
}

const outPath = join(ROOT, `frontier-source-${mode}.txt`);
const text = parts.join('\n');
writeFileSync(outPath, text, 'utf8');

// Оценка в токенах: для кода примерно 3 байта на токен. Число грубое, но
// отвечает на единственный важный вопрос — влезет ли это в окно модели.
//
// Вердикт печатается ЧЕСТНО, а не бодро. Первая версия писала «окно 1M вмещает
// с запасом» безусловно, и на наборе all это была прямая ложь: там 1.42 млн
// токенов, то есть в миллионное окно набор НЕ ВЛЕЗАЕТ. Инструмент, который
// врёт про свой результат, хуже отсутствующего.
const approxTokens = Math.round(Buffer.byteLength(text) / 3);
const M = approxTokens / 1e6;
const verdict = M <= 0.75 ? 'в окно 1M влезает с запасом'
  : M <= 0.95 ? 'в окно 1M влезает впритык — оставьте место под ответ'
  : `в окно 1M НЕ ВЛЕЗАЕТ (нужно ${M.toFixed(2)}M). Берите набор core или подавайте по частям`;
console.log(`${relative(ROOT, outPath)}`);
console.log(`  файлов: ${keep.length}, строк: ${lines}, размер: ${(Buffer.byteLength(text) / 1024).toFixed(0)} КБ`);
console.log(`  примерно ${(approxTokens / 1000).toFixed(0)} тыс. токенов — ${verdict}`);
