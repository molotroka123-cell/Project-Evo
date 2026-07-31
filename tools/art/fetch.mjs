// tools/art/fetch.mjs — забирает готовые генерации из выгрузки Higgsfield и
// раскладывает их под именами зданий из игры.
//
// Запуск: node tools/art/fetch.mjs <файл-выгрузки.json> [папка]
// Файл-выгрузка — это JSON, который отдаёт show_generations.
//
// Сопоставление идёт по тексту промта: в prompts.json у каждого ассета лежит
// свой Subject, он же попадает в промт генерации. Совпадение по нему надёжнее,
// чем по порядку или времени — заказчик генерит вразнобой и с повторами.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || 'art/raw';
if (!SRC) { console.error('укажи файл выгрузки show_generations'); process.exit(1); }

const dump = JSON.parse(await readFile(SRC, 'utf8'));
const prompts = JSON.parse(await readFile(new URL('./prompts.json', import.meta.url), 'utf8'));

// Subject из нашего промта — то, что стоит между "Subject: " и следующим блоком.
function subjectOf(p) {
  const m = /Subject: (.*?)(?: BACKGROUND| Background:|$)/s.exec(p || '');
  return (m ? m[1] : p || '').trim().toLowerCase();
}
const wanted = prompts.map(p => ({ ...p, subj: subjectOf(p.prompt) }));

await mkdir(OUT, { recursive: true });
const chosen = new Map();   // file → {url, createdAt}

for (const it of dump.items || []) {
  if (it.status !== 'completed') continue;
  const url = it.results && (it.results.rawUrl || it.results.minUrl);
  if (!url) continue;
  const subj = subjectOf((it.params || {}).prompt);
  if (!subj) continue;
  // ищем ассет, чей Subject целиком содержится в промте генерации
  const hit = wanted.find(w => w.subj && subj.startsWith(w.subj.slice(0, 60)));
  if (!hit) continue;
  const prev = chosen.get(hit.file);
  // при повторных генерациях берём самую свежую
  if (!prev || (it.createdAt || 0) > prev.createdAt) {
    chosen.set(hit.file, { url, createdAt: it.createdAt || 0, id: hit.id });
  }
}

console.log(`сопоставлено ассетов: ${chosen.size}`);
let ok = 0, fail = 0;
for (const [file, info] of chosen) {
  const name = file.replace(/\//g, '_');
  try {
    const res = await fetch(info.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await writeFile(join(OUT, name), Buffer.from(await res.arrayBuffer()));
    console.log(`  ✓ ${info.id} ${name}`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${info.id} ${name} — ${e.message}`);
    fail++;
  }
}
console.log(`\nскачано: ${ok}, ошибок: ${fail}`);

const missing = prompts.filter(p => !chosen.has(p.file));
console.log(`ещё не сгенерировано: ${missing.length} из ${prompts.length}`);
