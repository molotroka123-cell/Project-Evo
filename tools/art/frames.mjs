// tools/art/frames.mjs — нарезка кадров из видео БЕЗ ffmpeg.
//
// Запуск: node tools/art/frames.mjs <видео.mp4> <папка-результата> [кадров]
//
// Зачем так: ffmpeg в этом окружении нет, а Chromium есть — и он умеет
// декодировать mp4. Открываем видео в headless-браузере, перематываем на
// нужные метки времени, рисуем кадр в canvas и забираем PNG. Получается тот же
// результат, что дал бы `ffmpeg -vf fps=...`, только средствами, которые в
// системе уже стоят.
//
// Кадры дальше идут в обычный конвейер: tools/art/cutout.mjs вырежет хромакей,
// сборка с ключом --embed-art вошьёт спрайты в игру.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createServer } from 'node:http';

const [, , src, outDir = 'art/frames', nRaw = '16'] = process.argv;
if (!src) {
  console.error('Укажите видео: node tools/art/frames.mjs <видео.mp4> [папка] [кадров]');
  process.exit(1);
}
const N = Math.max(2, Math.min(64, parseInt(nRaw, 10) || 16));
const file = resolve(src);
const out = resolve(outDir);
await mkdir(out, { recursive: true });

// Отдаём видео по http, а не file://: страница живёт на about:blank, и файловый
// origin ей недоступен — видео молча не грузится.
const bytes = await readFile(file);
const server = createServer((req, res) => {
  // Видео — только по своему адресу. Первая версия отдавала mp4 на ЛЮБОЙ
  // запрос, включая саму страницу, и браузер вечно ждал HTML.
  if (req.url.startsWith('/v.mp4')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'Accept-Ranges': 'none' });
    res.end(bytes);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><body></body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/page`).catch(() => {});

// Страница-обёртка: видео + канвас, оба на том же origin, что и файл.
await page.setContent(`
  <video id="v" src="http://127.0.0.1:${port}/v.mp4" muted preload="auto"></video>
  <canvas id="c"></canvas>
`);

const meta = await page.evaluate(() => new Promise((res, rej) => {
  const v = document.getElementById('v');
  const done = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
  if (v.readyState >= 2) return done();
  v.onloadeddata = done;
  v.onerror = () => rej(new Error('видео не открылось'));
  setTimeout(() => rej(new Error('таймаут загрузки видео')), 30000);
}));

console.log(`${basename(file)}: ${meta.w}x${meta.h}, ${meta.d.toFixed(2)} с → ${N} кадров`);

for (let i = 0; i < N; i++) {
  // Первый и последний кадр берём с отступом: на самых краях кодек часто
  // отдаёт мусор или чёрный кадр.
  const t = meta.d * (0.02 + 0.96 * (i / (N - 1)));
  const dataUrl = await page.evaluate(async (time) => {
    const v = document.getElementById('v');
    await new Promise((res) => {
      const ok = () => { v.removeEventListener('seeked', ok); res(); };
      v.addEventListener('seeked', ok);
      v.currentTime = time;
    });
    const c = document.getElementById('c');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c.toDataURL('image/png');
  }, t);

  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const name = `${basename(file).replace(/\.[^.]+$/, '')}_${String(i).padStart(2, '0')}.png`;
  await writeFile(resolve(out, name), buf);
  process.stdout.write(`\r  кадр ${i + 1}/${N}`);
}

console.log(`\nГотово: ${out}`);
await browser.close();
server.close();
