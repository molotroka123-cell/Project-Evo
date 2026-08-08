# Три промта для Seedance 2.5

Клип сам по себе в игру не попадёт: движок — Canvas 2D, он рисует спрайты,
а не проигрывает видео. **Ценность ролика в том, что из него нарезаются кадры.**
Поэтому все три промта построены под одно требование: каждый отдельный кадр
должен годиться как игровой ассет.

Отсюда жёсткие условия внутри промтов:
- **камера неподвижна** — иначе объект гуляет по кадру и кадры не сложить в лист;
- **фон ровная магента `#FF00FF`** — тот же хромакей, что у остального арта,
  вырезается тем же `tools/art/cutout.mjs`;
- **движение зациклено** — последний кадр стыкуется с первым, анимация не дёргается;
- **свет и ракурс те же, что у зданий** — сверху-слева 45°, вид три четверти
  сверху с наклоном 65°, иначе новое не ляжет в один ряд со старым.

Что делать с готовым роликом: пришли ссылку или положи в галерею — я нарежу
кадры (`ffmpeg`), прогоню через вырезание фона, соберу спрайт-лист и вставлю
в игру, как уже сделано с 39 зданиями.

---

## Промт 1 — жители: цикл ходьбы

Самое ценное из трёх. Закрывает главную претензию к графике и даёт кадры,
которые лягут прямо в `people.js` вместо процедурных фигурок.

```
Loopable game sprite animation. A single medieval peasant villager walking
in place, seen from an elevated three-quarter top-down angle tilted 65 degrees
from vertical, exactly as in a classic city-builder.

CAMERA IS COMPLETELY STATIC — no pan, no zoom, no orbit, no handheld motion.
The character stays centred in frame and does not travel across it: he walks
on the spot. Full body always inside frame with generous empty margin.

The walk cycle must LOOP SEAMLESSLY: the final frame matches the first frame
so the motion can repeat forever without a jump.

Character: simple brown tunic, leather belt, cloth leg wraps, carrying a wooden
axe over one shoulder. Hand-painted 2.5D strategy-game art style, semi-realistic
historical, saturated natural colours, crisp readable silhouette, no photo texture.

Lighting: warm daylight from the upper left at 45 degrees. Soft ambient occlusion.
No light source visible in frame.

BACKGROUND: every pixel that is not the character is flat solid magenta #FF00FF.
No ground, no floor, no grass, no soil, no shadow cast onto the magenta, no
horizon, no sky, no gradient, no vignette. The character floats and stands on
nothing. Magenta reaches all four corners.

No text, no logo, no watermark, no border, no other characters.
```

**Вариации** — те же слова, меняется только описание персонажа. Дают весь набор:
- `a stone-age hunter in animal furs carrying a spear`
- `a Roman-era farmer in a short tunic carrying a sickle`
- `a medieval soldier in chainmail with a shield and spear`
- `an industrial-era worker in overalls and a flat cap carrying a toolbox`
- `a future-era engineer in a white composite suit carrying a glowing device`

---

## Промт 2 — здания: живой цикл

Даёт то, чего у процедурных спрайтов нет: постройка перестаёт быть статичной
картинкой. Из ролика нарезается короткий цикл, который накладывается поверх
уже готового спрайта здания.

```
Loopable game asset animation. A medieval watermill building with a large
wooden waterwheel, seen from an elevated three-quarter top-down angle tilted
65 degrees from vertical.

CAMERA IS COMPLETELY STATIC — no pan, no zoom, no orbit. The building does not
move, shift or breathe. ONLY these elements animate: the waterwheel turns
steadily, the water falling from it splashes, a small banner on the roof ripples
in the wind, thin smoke drifts from the chimney.

The animation must LOOP SEAMLESSLY: the wheel completes exactly one full
revolution so the last frame matches the first.

Hand-painted 2.5D strategy-game art style, semi-realistic historical, saturated
natural colours, crisp readable silhouette, no photo texture.

Lighting: warm daylight from the upper left at 45 degrees, soft ambient occlusion
in every crevice. No light source visible in frame.

BACKGROUND: every pixel that is not the building is flat solid magenta #FF00FF.
No ground, no floor, no grass, no soil, no water surface, no shadow cast onto
the magenta, no horizon, no sky, no gradient. The building floats and stands on
nothing. Magenta reaches all four corners.

No text, no logo, no watermark, no border, no other objects.
```

**Вариации** — что именно оживает:
- кузница: `the forge fire pulses, sparks fly from the anvil, smoke rises`
- фабрика: `three smokestacks billow dark smoke at different rhythms`
- ферма: `wheat sways in the wind, a windmill sail turns slowly`
- Шпиль: `the cyan energy core pulses, light travels up the crystalline tower`
- порт: `a moored boat rocks gently, ropes sway, a gull circles the mast`

---

## Промт 3 — заставка эпохи

Единственный из трёх, который используется как **видео целиком**, а не
покадрово: короткий ролик на переход между эпохами. Здесь фон не нужен
хромакеем — наоборот, нужна атмосфера.

```
Cinematic time-lapse of a single human settlement growing through history,
filmed from one fixed high vantage point that NEVER moves.

CAMERA IS COMPLETELY STATIC — the exact same framing from first frame to last.
Everything changes inside the frame; the frame itself does not.

The transformation, in one continuous shot: a circle of stone-age hide tents
around a bonfire becomes a bronze-age mudbrick village, then a walled iron-age
hillfort, then a classical marble town with a temple, then a medieval town with
a castle keep, then a smoke-stacked industrial city, then a modern city of glass
towers, and finally a future city with a single slender white crystalline spire
rising at its centre with a cyan glow.

Each era holds for about a second, then dissolves into the next by growth —
new buildings rise where old ones stood, roads widen and pave themselves, the
sky shifts from dawn to noon to industrial haze to clean evening.

Hand-painted 2.5D strategy-game art style, semi-realistic historical, saturated
natural colours, painterly brushwork, atmospheric depth, epic but grounded.

No text, no logo, no watermark, no user interface elements, no people close-ups.
```

Куда пойдёт: заставка при смене эпохи и обложка страницы игры.

---

## Как прислать результат

1. Сгенерируй в Seedance — ролики сами лягут в галерею Higgsfield.
2. Скажи мне «клипы готовы» — я найду их в галерее по этим промтам.
3. Дальше моя работа: нарезка кадров, вырезание фона, сборка листа, вставка
   в игру и проверка скриншотом.

Что важно знать заранее: у первых 42 картинок фон не вырезался у 32 из них —
генератор рисовал траву и небо вопреки промту. С видео риск тот же, поэтому
формулировка про фон в промтах вынесена в отдельный абзац и повторена дважды.
Если в ролике под персонажем окажется земля или тень — кадры не подойдут,
и лучше перегенерировать, чем пытаться вырезать.
