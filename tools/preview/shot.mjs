// tools/preview/shot.mjs — снимок страницы-стенда спрайтов (для отладки арта).
// Запуск: node tools/preview/shot.mjs people
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8793;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const buf = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(PORT, r));
await mkdir(join(ROOT, 'shots'), { recursive: true });

const name = process.argv[2] || 'people';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 2 });
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/preview/${name}.html`, { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.screenshot({ path: join(ROOT, 'shots', `preview_${name}.png`), fullPage: true });
console.log(`shots/preview_${name}.png  ошибок: ${errs.length}`);
for (const e of errs.slice(0, 8)) console.log('  ! ' + e.slice(0, 300));
await browser.close();
server.close();
