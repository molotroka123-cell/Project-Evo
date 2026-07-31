// tools/art/cutout.mjs — вырезание хромакей-фона из сгенерированного арта.
//
// Запуск: node tools/art/cutout.mjs [папка-с-исходниками] [папка-результата]
// По умолчанию: art/raw → app/assets/sprites
//
// Почему не «убрать все розовые пиксели»: генератор рисует фон не ровным
// #FF00FF, а малиновым градиентом, иногда с нарисованным солнцем или травой.
// Поэтому:
//   1) фон определяется по ТОНУ (magenta/розовый диапазон), а не по точному цвету —
//      это переживает градиент;
//   2) удаляются только пиксели, СВЯЗАННЫЕ с краем кадра (заливка от рамки), —
//      иначе вырезало бы розовые детали внутри самой постройки;
//   3) край субъекта смягчается полупрозрачной каймой, иначе по контуру
//      остаётся розовая обводка, которая в игре бросается в глаза;
//   4) результат обрезается по границам непрозрачного и пишется PNG.
// Файл, где фон не сплошной (трава/небо в кадре), честно помечается как
// непригодный — такие надо перегенерировать, а не «чинить».
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { PNG } from './png.mjs';

const SRC = process.argv[2] || 'art/raw';
const DST = process.argv[3] || 'app/assets/sprites';

// --- фон ли этот пиксель по тону? ---
// magenta/розовый: R и B заметно выше G, при ощутимой насыщенности.
function isBackgroundColor(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 60) return false;                 // почти чёрное — не фон
  const sat = (max - min) / max;
  if (sat < 0.25) return false;               // серое — не фон
  if (g >= r || g >= b) return false;         // зелёный канал должен быть провален
  const rb = Math.min(r, b);
  if (rb - g < 40) return false;              // недостаточный провал зелёного
  // тон в диапазоне пурпур–розовый (примерно 280°…340°)
  const h = hue(r, g, b);
  return h >= 275 && h <= 345;
}

function hue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// Заливка от краёв кадра: помечает связную с рамкой фоновую область.
function floodFromEdges(px, w, h) {
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (bg[i]) return;
    const o = i * 4;
    if (!isBackgroundColor(px[o], px[o + 1], px[o + 2])) return;
    bg[i] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return bg;
}

// Смягчение контура: пиксель субъекта, у которого есть фоновые соседи,
// получает частичную прозрачность и «отмывается» от розового налёта.
function feather(px, bg, w, h) {
  const alpha = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < w * h; i++) if (bg[i]) alpha[i] = 0;
  const src = alpha.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!src[i]) continue;
      let near = 0, total = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        total++;
        if (!src[yy * w + xx]) near++;
      }
      if (near) {
        alpha[i] = Math.round(255 * (1 - near / total));
        // снимаем розовую кайму: подтягиваем зелёный к среднему красного и синего
        const o = i * 4;
        const r = px[o], g = px[o + 1], b = px[o + 2];
        if (g < r && g < b) px[o + 1] = Math.round((g + Math.min(r, b)) / 2);
      }
    }
  }
  return alpha;
}

async function processFile(path, outDir) {
  const png = PNG.decode(await readFile(path));
  const { width: w, height: h, data: px } = png;
  const bg = floodFromEdges(px, w, h);

  let bgCount = 0;
  for (let i = 0; i < w * h; i++) if (bg[i]) bgCount++;
  const bgShare = bgCount / (w * h);

  // Сколько краевых пикселей осталось не-фоном: если много, значит в кадре
  // нарисована трава/небо/солнце и чистого хромакея нет.
  let edgeTotal = 0, edgeBad = 0;
  const checkEdge = (x, y) => { edgeTotal++; if (!bg[y * w + x]) edgeBad++; };
  for (let x = 0; x < w; x++) { checkEdge(x, 0); checkEdge(x, h - 1); }
  for (let y = 0; y < h; y++) { checkEdge(0, y); checkEdge(w - 1, y); }
  const edgeBadShare = edgeBad / edgeTotal;

  const alpha = feather(px, bg, w, h);

  // обрезка по непрозрачному
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { file: basename(path), ok: false, why: 'ничего не осталось после вырезания' };

  const cw = maxX - minX + 1, chh = maxY - minY + 1;
  const out = Buffer.alloc(cw * chh * 4);
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      const si = (y + minY) * w + (x + minX), di = (y * cw + x) * 4, so = si * 4;
      out[di] = px[so]; out[di + 1] = px[so + 1]; out[di + 2] = px[so + 2];
      out[di + 3] = alpha[si];
    }
  }

  const name = basename(path, extname(path)) + '.png';
  await writeFile(join(outDir, name), PNG.encode(out, cw, chh));

  const verdict = edgeBadShare > 0.12
    ? { ok: false, why: `в кадре нарисован фон (трава/небо/солнце): ${(edgeBadShare * 100).toFixed(0)}% рамки не хромакей — перегенерировать` }
    : bgShare < 0.08
      ? { ok: false, why: 'фона почти нет — субъект обрезан краями кадра, перегенерировать' }
      : { ok: true, why: '' };

  return { file: basename(path), out: name, w: cw, h: chh, bgShare, edgeBadShare, ...verdict };
}

const files = (await readdir(SRC).catch(() => [])).filter(f => /\.(png|jpe?g)$/i.test(f));
if (!files.length) {
  console.log(`В «${SRC}» нет картинок. Положи туда сгенерированный арт и запусти снова.`);
  process.exit(0);
}
await mkdir(DST, { recursive: true });

const results = [];
for (const f of files) results.push(await processFile(join(SRC, f), DST));

// Манифест: рендер грузит только то, что здесь перечислено. Грузить наугад
// нельзя — на отсутствующие файлы браузер выдаст 404 в консоль, а приёмка
// требует ноль красных ошибок.
const ids = results
  .filter(r => r.ok && /^buildings_(.+)\.png$/.test(r.out))
  .map(r => r.out.match(/^buildings_(.+)\.png$/)[1])
  .sort();
const manifestPath = new URL('../../app/src/render/artpack.js', import.meta.url);
const src = await readFile(manifestPath, 'utf8');
await writeFile(manifestPath, src.replace(
  /export const MANIFEST = \[[^\]]*\];/,
  `export const MANIFEST = [${ids.map(i => `'${i}'`).join(', ')}];`,
), 'utf8');
console.log(`манифест обновлён: ${ids.length} зданий с нарисованным артом\n`);

const good = results.filter(r => r.ok);
const bad = results.filter(r => !r.ok);
console.log(`Обработано: ${results.length}   годных: ${good.length}   на перегенерацию: ${bad.length}\n`);
for (const r of good) console.log(`  ✓ ${r.file.padEnd(34)} → ${r.out} (${r.w}×${r.h})`);
if (bad.length) {
  console.log('\nТребуют перегенерации:');
  for (const r of bad) console.log(`  ✗ ${r.file.padEnd(34)} ${r.why}`);
}
