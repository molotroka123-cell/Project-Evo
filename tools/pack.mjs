// tools/pack.mjs — собирает архив для передачи проекта в другой чат.
//
// Запуск: node tools/pack.mjs
// Результат: ФРОНТИР_передача.zip в корне.
//
// Что кладём: исходники игры, однофайловый билд, тесты, инструменты, документы,
// весь арт (исходники и вырезанные спрайты) и скриншоты.
// Что НЕ кладём: node_modules и служебные каталоги — они восстанавливаются
// одной командой и раздувают архив на порядки.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'ФРОНТИР_передача.zip';

// Порядок важен: то, что читают первым, лежит в корне архива.
const INCLUDE = [
  'ПЕРЕДАЧА_КИМИ.md',      // мастер-промт — читать первым
  'КИМИ_К3',               // папка передачи: с чего начать, исходные ТЗ, промты
  'README_ЗАПУСК.md',
  'CHANGELOG.md',
  'frontier.html',          // играбельный билд: двойной клик
  'app',                    // исходники
  'tools',                  // сборка, скриншоты, арт-конвейер, опросник
  'docs',
  'art',                    // сгенерированный арт как есть
  'shots',                  // скриншоты для сверки
  'assets',
  '.gitignore',
];

const EXCLUDE = [
  'node_modules/*', '*/node_modules/*',
  '.git/*', '*/.git/*',
  '*.DS_Store', '*/Temp/*', '*/Library/*',
];

const present = INCLUDE.filter(p => existsSync(join(ROOT, p)));
const missing = INCLUDE.filter(p => !existsSync(join(ROOT, p)));

// Считаем, сколько арта реально уезжает: это первое, что спросит заказчик.
const countPngs = (dir) => {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.(png|jpe?g|webp)$/i.test(e.name)) n++;
    }
  };
  walk(full);
  return n;
};

const raw = countPngs('art/raw');
const sprites = countPngs('app/assets/sprites');
const shots = countPngs('shots');

const args = ['-r', '-q', OUT, ...present, '-x', ...EXCLUDE];
execFileSync('zip', args, { cwd: ROOT, stdio: 'inherit' });

const mb = (statSync(join(ROOT, OUT)).size / 1048576).toFixed(1);
console.log(`\nАрхив собран: ${OUT} — ${mb} МБ`);
console.log(`  вошло: ${present.join(', ')}`);
if (missing.length) console.log(`  отсутствует (пропущено): ${missing.join(', ')}`);
console.log(`\nАрт внутри:`);
console.log(`  art/raw (как из генератора): ${raw} шт.`);
console.log(`  app/assets/sprites (с вырезанным фоном): ${sprites} шт.`);
console.log(`  shots (скриншоты игры): ${shots} шт.`);
if (!raw) {
  console.log('\n  ВНИМАНИЕ: в art/raw пусто. Скачанные из Higgsfield картинки');
  console.log('  надо положить туда — имена перечислены в art/raw/ИМЕНА.md.');
}
