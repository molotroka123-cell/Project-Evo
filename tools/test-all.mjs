// tools/test-all.mjs — прогоняет все наборы тестов и даёт один сводный итог.
//
// Запуск: npm test
//
// Зачем: наборов уже 17, у каждого свой формат последней строки (исторически
// их писали разные агенты). Ручной обход «запусти семнадцать команд и сложи
// числа глазами» — это способ не заметить упавший тест. Здесь единый выход
// и ненулевой код возврата, если упало хоть что-то.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'app/tests');

// Наборы печатают итог по-разному: «=== 18 OK / 0 FAIL ===», «Итого: 13 прошло,
// 0 упало», «ВСЁ ЗЕЛЁНОЕ: 27 пройдено, 0 провалено».
//
// Первая версия просто брала два первых числа из хвоста — и насчитала «4548
// проверок, 122 падения» на полностью зелёном прогоне, потому что цеплялась за
// числа из обычных строк отчёта («3000 дней», «500 маршрутов»). Поэтому здесь
// только явные шаблоны итоговой строки, и ни одного «возьмём что попалось».
// ВНИМАНИЕ про `\w`: в JS он значит [A-Za-z0-9_] и кириллицу НЕ ловит. Первая
// версия шаблонов писала «прош\w*» и молча не находила ни одного русского итога.
// Поэтому здесь явные кириллические классы.
const RU = '[а-яё]*';
const PATTERNS = [
  /===\s*(\d+)\s*OK\s*\/\s*(\d+)\s*FAIL\s*===/i,
  new RegExp(`Итого:\\s*(\\d+)\\s*прош${RU},\\s*(\\d+)\\s*упал${RU}`, 'i'),
  new RegExp(`(?:Итого|ВСЁ ЗЕЛЁНОЕ):\\s*(\\d+)\\s*пройден${RU},\\s*(\\d+)\\s*провален${RU}`, 'i'),
  /ИТОГО:\s*(\d+)\s*passed,\s*(\d+)\s*failed/i,
];

function parseTail(out) {
  // Идём с конца: итог печатается последним, а по пути могут встретиться
  // промежуточные строки того же вида.
  const lines = out.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const re of PATTERNS) {
      const m = lines[i].match(re);
      if (m) return { ok: +m[1], fail: +m[2] };
    }
  }
  return null;
}

const files = readdirSync(DIR).filter(f => f.endsWith('.mjs')).sort();
let totalOk = 0, totalFail = 0;
const broken = [];

for (const f of files) {
  let out = '', code = 0;
  try {
    out = execFileSync('node', [join(DIR, f)], { encoding: 'utf8', cwd: ROOT });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 1;
  }
  const r = parseTail(out);
  if (!r) {
    broken.push(f);
    console.log(`  ${f.padEnd(24)} ??? не разобрал итог`);
    continue;
  }
  totalOk += r.ok; totalFail += r.fail;
  const mark = r.fail || code ? 'УПАЛ' : 'ok';
  console.log(`  ${f.padEnd(24)} ${String(r.ok).padStart(3)} прошло, ${r.fail} упало   ${mark}`);
  if (code && !r.fail) broken.push(f);   // ненулевой выход при нулевых падениях — тоже беда
}

console.log(`\nНаборов: ${files.length}   Проверок: ${totalOk + totalFail}   Прошло: ${totalOk}   Упало: ${totalFail}`);
if (broken.length) console.log(`Не разобраны или упали молча: ${broken.join(', ')}`);

const bad = totalFail > 0 || broken.length > 0;
console.log(bad ? '\nЕСТЬ ПАДЕНИЯ' : '\nВСЁ ЗЕЛЁНОЕ');
process.exit(bad ? 1 : 0);
