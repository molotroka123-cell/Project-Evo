// core/systems/laws.js — Свод законов (U29), цепочки событий (U31), хроника (U32).
// Чистый модуль: без DOM, без импорта чего-либо, кроме core/data.js. Ничего не
// мутирует, кроме собственного state; вся случайность — через переданный rng.
//
// ЗАЧЕМ ИМЕННО ТАК.
//
// U29. Закон — это не подарок, а правило. Разовая выдача ресурсов забывается за
// три дня; множитель к экономике игрок чувствует до конца партии. Поэтому у
// каждого варианта закона нет поля «дай 200 золота» — есть только множители
// (gather, knowledge, industry…) и плоская добавка к счастью. Выбор необратим:
// функции отмены здесь нет и не будет — в этом вся драма. Раз в эпоху, один
// закон, две двери, обе закрываются за спиной.
//
// U31. Цепочка — это событие с памятью. Данными описаны звенья и переходы между
// ними; выбор игрока в первом звене решает, какое звено придёт через год и
// придёт ли вообще. Ветка выбирается броском rng В МОМЕНТ ПЛАНИРОВАНИЯ и сразу
// ложится в state — значит, партия воспроизводима от сида, а сейв не «переиграет»
// уже решённую судьбу беженца.
//
// U32. Хроника ведётся сама. observe() каждый день сравнивает срез мира со своим
// предыдущим срезом и пишет только то, что игрок будет вспоминать: эпохи, вехи
// населения, обвалы, войны, отбитые набеги, чудеса, принятые законы, развязки
// цепочек. Мелочи остаются в обычном логе — летопись должна читаться, а не
// пролистываться.
//
// ═══════════════════════════ INTEGRATION ═══════════════════════════
// 1) simulation.js, рядом с прочими импортами:
//      import * as Laws from './systems/laws.js';
//
// 2) constructor(), рядом с прочим состоянием (например, после this.market):
//      this.laws = Laws.createLaws();
//
// 3) Единый контекст. Удобно завести один метод рядом с happiness():
//      lawsCtx() {
//        return {
//          day: this.day, era: this.eraIndex, eraDay: this.eraDay,
//          pop: this.villagers.length, housingCap: this.housingCap(),
//          happy: this._happy ?? 50, res: this.res, buildings: this.doneBuildings(),
//          techs: this.techs, wars: this.wars, repelled: this.repelled,
//          soldiers: this.army.soldiers, spireStage: this.spire ? this.spire.stage : 0,
//          factionName: (fid) => { const f = this.faction(fid); return f ? f.def.name : fid; },
//        };
//      }
//
// 4) МНОЖИТЕЛИ ЗАКОНОВ.
//    globalMult(kind), последняя строка перед `return mult;`:
//      mult *= Laws.lawMult(this.laws, kind);      // gather/gold/industry/army/knowledge
//    produceAt(), в ветке фермы (после множителя мельницы):
//      if (b.id === 'farm') mult *= Laws.lawMult(this.laws, 'farm');
//    happiness(), рядом с `h += this._happyBonus || 0;`:
//      h += Laws.lawHappy(this.laws);
//    buildDays(), перед `return`:
//      days /= Laws.lawMult(this.laws, 'build');
//    onNewDay(), блок «рождения», после расчёта chance:
//      chance *= Laws.lawMult(this.laws, 'growth');
//    trainSoldier(), при проверке и списании цены:
//      const k = Laws.lawMult(this.laws, 'trainCost');   // цена бойца
//    onNewDay(), содержание армии:
//      const up = Laws.lawMult(this.laws, 'upkeep');
//      this.res.food -= upkeep * ARMY_UPKEEP.food * up;
//    medicineMult(), перед return:  m *= Laws.lawMult(this.laws, 'medicine');
//    marketRate(), перед return:    rate *= Laws.lawMult(this.laws, 'market');
//    onNewDay(), караваны:          gold *= Laws.lawMult(this.laws, 'caravan');
//    techCost(), перед return:      cost = Math.ceil(cost * Laws.lawMult(this.laws, 'techCost'));
//    resolveRaid(), сила врага:     enemy = Math.round(enemy * Laws.lawMult(this.laws, 'raid'));
//    rollEvent(), вес «плохих» событий (риск беспорядков):
//      const w = e.w * (BAD_EVENTS.has(e.id) ? Laws.lawMult(this.laws, 'unrest') : 1);
//    Ни один вызов не обязателен по отдельности: без него закон просто не влияет
//    на эту сторону жизни. Множитель для незнакомого kind всегда равен 1.
//
// 5) ПРЕДЛОЖЕНИЕ ЗАКОНА. onNewDay(), рядом с блоком событий:
//      if (!this.pendingLaw && !this.pendingEvent) {
//        const off = Laws.openLaw(this.laws, this.lawsCtx());
//        if (off) { this.pendingLaw = off; this.addLog(`§ Свод законов: ${off.ru}`, 'warn'); }
//      }
//    HUD рисует off.ru / off.text и две кнопки off.options[i].ru с подсказкой
//    options[i].summary (готовая русская строка эффектов). По нажатию:
//      adoptLaw(key) {
//        const r = Laws.adoptLaw(this.laws, key, this.lawsCtx());
//        if (!r.ok) return r;
//        this.pendingLaw = null;
//        if (r.rel) for (const f of this.factions) this.adjustRel(f.id, r.rel, 'Новый закон');
//        for (const c of r.chronicle) this.addChronicle(c.text);
//        this.addLog(r.log, 'good');
//        return r;
//      }
//
// 6) ЦЕПОЧКИ. onNewDay(), сразу после существующего блока событий:
//      if (!this.pendingEvent) {
//        const ctx = this.lawsCtx();
//        const ev = Laws.takeDueChain(this.laws, ctx, this.rng)
//                || Laws.rollChainStart(this.laws, ctx, this.rng);
//        if (ev) {
//          this.fireEvent(ev);                       // событие с choice ляжет в pendingEvent
//          if (!ev.choice) for (const t of Laws.applyExtras(ev.extra, this)) this.addLog(t.text, t.type);
//          for (const c of (ev.chronicle || [])) this.addChronicle(c.text);
//        }
//      }
//    resolveEvent(choiceKey), в самом конце (после applyEffect и addLog):
//      if (e.chain) {
//        const r = Laws.afterChoice(this.laws, e, opt.key || choiceKey, this.lawsCtx(), this.rng);
//        for (const t of Laws.applyExtras(opt.extra, this)) this.addLog(t.text, t.type);
//        for (const c of r.chronicle) this.addChronicle(c.text);
//        if (r.log) this.addLog(r.log);
//      }
//    ВАЖНО: takeDueChain снимает звено с очереди, поэтому его нельзя звать, когда
//    pendingEvent занят — продолжение просто потеряется.
//    applyExtras нужен потому, что applyEffect ядра не умеет 🪵/🪨/бойцов и
//    отношения; всё остальное (happy, pop, gold, food, plague, damageBuilding…)
//    цепочки пишут в effect обычным языком EVENT_DEFS.
//
// 7) ХРОНИКА. onNewDay(), последней строкой:
//      for (const e of Laws.observe(this.laws, this.lawsCtx())) this.addChronicle(e.text);
//    Экран победы и панель летописи читают уже готовое:
//      Laws.chronicleText(this.laws)            — вся партия одним текстом
//      Laws.chronicleEntries(this.laws, { kind: 'loss' })  — только потери
//      Laws.chronicleStats(this.laws)           — счётчики для итогов
//
// 8) СЕЙВ. serialize():   laws: Laws.serializeLaws(this.laws),
//    deserialize():       sim.laws = Laws.deserializeLaws(data.laws);
//    Старый сейв без поля грузится: вернётся чистое состояние, законы можно
//    будет принять заново начиная с текущей эпохи.
// ═══════════════════════════════════════════════════════════════════

import { ERAS, BUILDINGS } from '../data.js';

// ---------- Настройки ----------
// Закон не сваливается на голову в первый же день эпохи: сперва пусть игрок
// увидит, чем новая эпоха отличается от прошлой, и только потом решает.
export const LAW_DELAY_DAYS = 8;
export const LAW_FIRST_DAY = 14;

// Цепочки редки нарочно: их ценность в том, что игрок помнит каждую.
export const CHAIN_START_CHANCE = 0.02;
export const CHAIN_COOLDOWN = 25;
export const CHAIN_MAX_ACTIVE = 2;

export const CHRONICLE_MAX = 500;

// Вехи населения, которые стоит помнить.
export const POP_MILESTONES = [10, 25, 50, 75, 100, 150, 200, 300, 500];
// Обвал: население упало на треть от прошлого пика — это уже история, а не убыль.
export const COLLAPSE_RATIO = 0.67;
// Здания, постройка которых достойна летописи.
export const LANDMARKS = ['temple', 'castle', 'university', 'observatory', 'media_tower',
  'hospital', 'airport', 'npp', 'ai_core', 'fusion_reactor', 'spaceport', 'spire'];

// ---------- Словарь множителей ----------
// good: 'up' — чем больше, тем лучше; 'down' — наоборот. Нужен, чтобы автоматом
// подсветить вариант в интерфейсе и не писать текст эффектов руками.
export const LAW_KINDS = {
  gather:    { ru: 'добыча',                 good: 'up' },
  farm:      { ru: 'урожай ферм',            good: 'up' },
  knowledge: { ru: 'знания',                 good: 'up' },
  gold:      { ru: 'золото',                 good: 'up' },
  industry:  { ru: 'промышленность',         good: 'up' },
  army:      { ru: 'сила армии',             good: 'up' },
  build:     { ru: 'скорость стройки',       good: 'up' },
  growth:    { ru: 'рождаемость',            good: 'up' },
  market:    { ru: 'выручка рынка',          good: 'up' },
  caravan:   { ru: 'доход караванов',        good: 'up' },
  trainCost: { ru: 'цена бойца',             good: 'down' },
  upkeep:    { ru: 'содержание армии',       good: 'down' },
  medicine:  { ru: 'смертность от болезней', good: 'down' },
  techCost:  { ru: 'цена исследований',      good: 'down' },
  raid:      { ru: 'сила набегов',           good: 'down' },
  unrest:    { ru: 'риск беспорядков',       good: 'down' },
};

// ---------- U29. Свод законов ----------
// Один закон на эпоху. Если для эпохи описано несколько — берётся первый, чьё
// условие when выполнено; последний в списке всегда без условия и служит
// запасным. Новый закон добавляется одной записью, менять код не нужно.
export const LAWS = [
  {
    id: 'hearth', era: 0, ru: 'Право первого куска',
    text: 'Добычи мало, ртов много. У костра ждут решения: кому мясо достаётся первым?',
    options: [
      { key: 'a', ru: 'Детям и матерям', flags: ['hearth_children'], happy: 5,
        mult: { growth: 1.25, gather: 0.93 },
        text: 'Слабых кормим первыми. Охотник уйдёт в лес голодным, зато племя растёт.',
        chronicle: 'Принято право первого куска: сначала едят дети и матери.' },
      { key: 'b', ru: 'Тому, кто добыл', flags: ['hearth_hunters'], happy: -3,
        mult: { gather: 1.15, growth: 0.85 },
        text: 'Кто принёс — тот и ест. Сытый охотник принесёт вдвое, а дети потерпят.',
        chronicle: 'Принято право первого куска: первым ест добытчик.' },
    ],
  },
  {
    id: 'ore_hands', era: 1, ru: 'Устав о руде и руках',
    text: 'Горны требуют угля, таблички — учеников. Куда девать подрастающих детей?',
    options: [
      { key: 'a', ru: 'Дети — к горну', flags: ['child_labor'], happy: -8,
        mult: { gather: 1.18, industry: 1.12, growth: 0.9 },
        text: 'Мехи качать много ума не надо. Руды станет больше, детства — меньше.',
        chronicle: 'Устав о руде и руках: дети встали к горнам.' },
      { key: 'b', ru: 'Дети — к глиняной табличке', flags: ['schools'], happy: 6,
        mult: { knowledge: 1.25, gather: 0.95 },
        text: 'Пусть учатся считать зерно и звёзды. Рудник подождёт одно поколение.',
        chronicle: 'Устав о руде и руках: при храме открыта школа для детей.' },
    ],
  },
  {
    id: 'sword_oath', era: 2, ru: 'Клятва меча', when: { building: 'barracks' },
    text: 'Казарма стоит, оружие есть. Вопрос один: у кого оно будет храниться?',
    options: [
      { key: 'a', ru: 'Оружие в каждом доме', flags: ['militia'], happy: 4,
        mult: { army: 1.12, raid: 0.9, gather: 0.95 },
        text: 'Каждый хозяин — сам себе дружинник. На сборы уходит рабочее время, зато чужие обходят нас стороной.',
        chronicle: 'Клятва меча: копьё держат в каждом доме.' },
      { key: 'b', ru: 'Дружина при вожде', flags: ['retinue'], happy: -6,
        mult: { army: 1.25, trainCost: 0.8 },
        text: 'Оружие — только у людей вождя. Войско сильнее и дешевле, народ — тише и злее.',
        chronicle: 'Клятва меча: оружие отдано под руку вождя.' },
    ],
  },
  {
    id: 'strangers', era: 2, ru: 'Закон о чужаках',
    text: 'К частоколу всё чаще выходят пришлые: беглые, торговцы, погорельцы. Пускать?',
    options: [
      { key: 'a', ru: 'Двери открыты', flags: ['open_gates'], happy: 0, rel: 8,
        mult: { growth: 1.15, gold: 1.1, unrest: 1.15 },
        text: 'Чужак сегодня — работник завтра. Народу и денег прибудет, спокойствия — нет.',
        chronicle: 'Закон о чужаках: ворота открыты для пришлых.' },
      { key: 'b', ru: 'За частокол — только своих', flags: ['closed_gates'], happy: 5, rel: -8,
        mult: { growth: 0.9, raid: 0.9, unrest: 0.85 },
        text: 'Свои среди своих. Тихо, безопасно и очень медленно.',
        chronicle: 'Закон о чужаках: пришлых больше не пускают за частокол.' },
    ],
  },
  {
    id: 'assembly', era: 3, ru: 'Слово площади',
    text: 'Поселение выросло, и решения кострища больше не хватает. Кто теперь говорит за всех?',
    options: [
      { key: 'a', ru: 'Народное собрание', flags: ['assembly'], happy: 8,
        mult: { knowledge: 1.1, unrest: 0.85, build: 0.9 },
        text: 'Каждый свободный имеет голос. Спорят долго, зато потом делают охотно.',
        chronicle: 'Слово площади: учреждено народное собрание.' },
      { key: 'b', ru: 'Совет старейшин', flags: ['council'], happy: -5,
        mult: { build: 1.15, gold: 1.12 },
        text: 'Решают семеро, остальные исполняют. Быстро, прибыльно и без лишних разговоров.',
        chronicle: 'Слово площади: власть отдана совету старейшин.' },
    ],
  },
  {
    id: 'tithe', era: 4, ru: 'Десятина',
    text: 'Каждый десятый сноп идёт не в свой амбар. Осталось решить, в чей.',
    options: [
      { key: 'a', ru: 'Десятина храму', flags: ['faith'], happy: 10,
        mult: { growth: 1.1, medicine: 0.95, knowledge: 0.85 },
        text: 'Храм кормит нищих, хоронит мёртвых и утешает живых. Спорить с небом никто не станет.',
        chronicle: 'Десятина отдана храму: вера стала опорой государства.' },
      { key: 'b', ru: 'Десятина школярам', flags: ['scholars'], happy: -6,
        mult: { knowledge: 1.3, techCost: 0.95 },
        text: 'Зерно уходит переписчикам и счётчикам. Проповедники недовольны, книги — растут.',
        chronicle: 'Десятина отдана школярам: книги важнее свечей.' },
    ],
  },
  {
    id: 'press', era: 5, ru: 'Указ о печатном слове',
    text: 'Станок печатает быстрее, чем совет успевает читать. Печатать ли всё подряд?',
    options: [
      { key: 'a', ru: 'Печатай что хочешь', flags: ['free_press'], happy: 5,
        mult: { knowledge: 1.25, unrest: 1.25, gold: 0.97 },
        text: 'Свободный лист учит и подстрекает одинаково хорошо.',
        chronicle: 'Указ о печатном слове: печать объявлена свободной.' },
      { key: 'b', ru: 'Ни листа без цензора', flags: ['censorship'], happy: -4,
        mult: { gold: 1.15, unrest: 0.6, knowledge: 0.9 },
        text: 'Каждая страница через контору. Тихо, доходно и глупеем медленно, но верно.',
        chronicle: 'Указ о печатном слове: введена цензура.' },
    ],
  },
  {
    id: 'land_reform', era: 6, ru: 'Земельный передел', when: { minPop: 60, noBuilding: 'factory' },
    text: 'Полей много, хозяев мало. Общинники стоят у крыльца с прошением.',
    options: [
      { key: 'a', ru: 'Земля тем, кто её пашет', flags: ['land_to_tillers'], happy: 6,
        mult: { farm: 1.25, gold: 0.9 },
        text: 'Своя борозда родит лучше барской. Казна недосчитается оброка.',
        chronicle: 'Земельный передел: поля отданы тем, кто их пашет.' },
      { key: 'b', ru: 'Земля остаётся за родами', flags: ['landlords'], happy: -5,
        mult: { gold: 1.2, farm: 0.95 },
        text: 'Старые роды платят в казну исправно. Пашущие остаются при своём — то есть ни при чём.',
        chronicle: 'Земельный передел отклонён: земля осталась за старыми родами.' },
    ],
  },
  {
    id: 'factory', era: 6, ru: 'Фабричный устав',
    text: 'Трубы дымят круглые сутки, а мастеровые падают у станков. Сколько длится смена?',
    options: [
      { key: 'a', ru: 'Четырнадцать часов', flags: ['long_shift'], happy: -12,
        mult: { industry: 1.25, gather: 1.1, growth: 0.9 },
        text: 'Станок не устаёт — значит, и человек потерпит. План будет выполнен.',
        chronicle: 'Фабричный устав: смена в четырнадцать часов.' },
      { key: 'b', ru: 'Десять часов и выходной', flags: ['short_shift'], happy: 9,
        mult: { growth: 1.15, industry: 0.92 },
        text: 'Отдохнувший работник живёт дольше и рожает детей. Хозяева считают убытки.',
        chronicle: 'Фабричный устав: смена в десять часов и выходной день.' },
    ],
  },
  {
    id: 'conscription', era: 7, ru: 'Закон о всеобщей повинности',
    text: 'Восемнадцать лет — возраст, когда государство впервые о тебе вспоминает. Куда позвать?',
    options: [
      { key: 'a', ru: 'Всеобщий призыв', flags: ['conscription'], happy: -6,
        mult: { army: 1.3, trainCost: 0.7, knowledge: 0.9 },
        text: 'Два года в казарме проходит каждый. Армия огромна, аудитории пусты.',
        chronicle: 'Введён всеобщий воинский призыв.' },
      { key: 'b', ru: 'Всеобщая школа', flags: ['universal_school'], happy: 4,
        mult: { knowledge: 1.3, growth: 1.05, army: 0.85 },
        text: 'Одиннадцать лет за партой проходит каждый. Полки придётся набирать охотой.',
        chronicle: 'Введено всеобщее школьное образование.' },
    ],
  },
  {
    id: 'net', era: 8, ru: 'Закон о сети',
    text: 'Провода знают о людях больше, чем соседи. Кому доверить это знание?',
    options: [
      { key: 'a', ru: 'Тайна переписки', flags: ['privacy'], happy: 8,
        mult: { knowledge: 1.12, unrest: 0.9, gold: 0.95 },
        text: 'Никто не читает чужих писем. Даже когда очень хочется и очень нужно.',
        chronicle: 'Закон о сети: тайна переписки объявлена неприкосновенной.' },
      { key: 'b', ru: 'Всевидящий надзор', flags: ['surveillance'], happy: -11,
        mult: { gold: 1.2, unrest: 0.45, raid: 0.85 },
        text: 'Видно всё и всех. Беспорядки гаснут, не начавшись, вместе с желанием говорить.',
        chronicle: 'Закон о сети: введён тотальный надзор.' },
    ],
  },
  {
    id: 'mind', era: 9, ru: 'Хартия разума',
    text: 'Машина считает лучше совета и не спит. Оставить ли за ней последнее слово?',
    options: [
      { key: 'a', ru: 'Решает совет машин', flags: ['machine_rule'], happy: -9,
        mult: { industry: 1.3, knowledge: 1.2, build: 1.15, growth: 0.95 },
        text: 'Ошибок меньше, спорить не с кем. Люди привыкают быть исполнителями.',
        chronicle: 'Хартия разума: решения переданы совету машин.' },
      { key: 'b', ru: 'Последнее слово — за человеком', flags: ['human_rule'], happy: 12,
        mult: { growth: 1.12, unrest: 0.8, industry: 0.95 },
        text: 'Машина советует, подпись ставит человек. Медленнее, дороже и всё ещё наше.',
        chronicle: 'Хартия разума: последнее слово оставлено за человеком.' },
    ],
  },
];

// ---------- U31. Цепочки событий ----------
// Звено: text + choice (две двери) либо auto (последствие без выбора).
// next — куда и через сколько дней ведёт дверь: [{ link, inDays:[min,max], w }].
// Пустой next завершает цепочку. Год в игре — сто дней, отсюда и сроки.
// effect говорит на языке EVENT_DEFS (его понимает applyEffect ядра),
// extra — то, чего в applyEffect нет: 🪵🪨 бойцы и отношения.
export const CHAINS = [
  {
    id: 'refugee', ru: 'Беженец', w: 10, first: 'arrive',
    start: { cond: { minEra: 0, minPop: 6 } },
    links: {
      arrive: {
        text: 'У частокола стоит человек с узлом за плечами. Говорит, его деревню сожгли, и просит хлеба и угол.',
        choice: {
          a: { ru: 'Впустить и накормить (20🍞)', cost: { food: 20 }, effect: { pop: 1, happy: 3 },
            chronicle: 'Принят беженец — накормили и дали угол.',
            next: [{ link: 'caravan', w: 6, inDays: [90, 140] }, { link: 'betray', w: 4, inDays: [60, 110] }] },
          b: { ru: 'Прогнать', effect: { happy: -4 },
            chronicle: 'Беженца прогнали от ворот.',
            next: [{ link: 'rumor', w: 1, inDays: [40, 80] }] },
        },
      },
      caravan: {
        text: 'Тот беженец вернулся — и не один. За ним идёт караван родни с солью, шкурами и мешочком золота: «Долг помню».',
        effect: { gold: 120, food: 60, happy: 4 }, extra: { rel: 6 },
        chronicle: 'Спасённый беженец привёл караван — долг вернулся сторицей.',
      },
      betray: {
        text: 'Приютыш исчез ночью вместе с ключом от амбара. Наутро в лесу видели чужие костры.',
        choice: {
          a: { ru: 'Снарядить погоню (25🪙)', cost: { gold: 25 }, effect: { foodPct: -0.1, happy: 2 },
            chronicle: 'Вора догнали — вернули почти всё украденное.' },
          b: { ru: 'Пусть подавится', effect: { foodPct: -0.25, happy: -5 },
            chronicle: 'Приютый беженец обобрал амбар и ушёл безнаказанным.' },
        },
      },
      rumor: {
        text: 'Молва разнесла по округе: у нас гонят голодных от ворот. Соседи запомнили.',
        effect: { happy: -3 }, extra: { rel: -8 },
        chronicle: 'О нас пошла дурная слава: голодных гонят от ворот.',
      },
    },
  },
  {
    id: 'apprentice', ru: 'Мальчишка у кузни', w: 8, first: 'boy',
    start: { cond: { minEra: 1, building: 'smithy' } },
    links: {
      boy: {
        text: 'Пацан третий день торчит у кузни и бесплатно таскает уголь. Просится в ученики — говорит, руки помнят сами.',
        choice: {
          a: { ru: 'Взять в ученики (30🍞)', cost: { food: 30 },
            chronicle: 'Мальчишку взяли учеником в кузню.',
            next: [{ link: 'master', w: 7, inDays: [140, 200] }, { link: 'runaway', w: 3, inDays: [30, 60] }] },
          b: { ru: 'Гнать — работать надо, а не глазеть', effect: { happy: -2 },
            chronicle: 'Мальчишку прогнали от кузни.',
            next: [{ link: 'grudge', w: 1, inDays: [90, 150] }] },
        },
      },
      master: {
        text: 'Тот мальчишка вырос и сам стал мастером. Его клеймо на топорах узнают за три перехода.',
        effect: { knowledge: 150, happy: 4 }, extra: { stone: 80 },
        chronicle: 'Ученик кузнеца стал мастером — его клеймо знают далеко за холмами.',
      },
      runaway: {
        text: 'Ученик сбежал, прихватив инструмент и запас железа. Кузнец ходит чернее угля.',
        effect: { happy: -3 }, extra: { stone: -25 },
        chronicle: 'Ученик сбежал из кузни, унеся инструмент.',
      },
      grudge: {
        text: 'Тот пацан выучился у соседей и теперь кует им наконечники. За наши заказы просит втрое.',
        effect: { gold: -30, happy: -2 }, extra: { rel: -5 },
        chronicle: 'Прогнанный мальчишка выучился у соседей и кует теперь против нас.',
      },
    },
  },
  {
    id: 'expedition', ru: 'Дальний поход', w: 7, first: 'send',
    start: { cond: { minEra: 2, minPop: 12 } },
    links: {
      send: {
        text: 'Старый охотник клянётся: за хребтом лежит долина с солёными озёрами и брошенным городом. Просит людей и припасов.',
        choice: {
          a: { ru: 'Снарядить разведку (40🍞 25🪙)', cost: { food: 40, gold: 25 },
            chronicle: 'За хребет ушла разведка.',
            next: [{ link: 'lost', w: 5, inDays: [20, 35] }, { link: 'found', w: 5, inDays: [25, 40] }] },
          b: { ru: 'Некому ходить за хребты', effect: { happy: -2 },
            chronicle: 'Поход за хребет отменён: людей не нашлось.' },
        },
      },
      lost: {
        text: 'Разведка не вернулась в срок. Кто-то видел дым на перевале — а может, и не дым.',
        choice: {
          a: { ru: 'Послать спасательный отряд (30🍞)', cost: { food: 30 },
            chronicle: 'За пропавшей разведкой ушёл спасательный отряд.',
            next: [{ link: 'found', w: 6, inDays: [12, 25] }, { link: 'grave', w: 4, inDays: [12, 25] }] },
          b: { ru: 'Ждать у ворот', effect: { happy: -3 },
            chronicle: 'Пропавшую разведку решили ждать у ворот.',
            next: [{ link: 'grave', w: 7, inDays: [30, 50] }, { link: 'found', w: 3, inDays: [40, 60] }] },
        },
      },
      found: {
        text: 'Разведка вернулась — обмороженная, злая и с картой. Долина есть. Соль есть. И брошенный город тоже.',
        effect: { knowledge: 200, gold: 80, happy: 6 },
        chronicle: 'Разведка вернулась с картой солёной долины.',
      },
      grave: {
        text: 'Их нашли весной, всех вместе, у самого перевала. Имена высекли на камне у кострища.',
        effect: { happy: -8 },
        chronicle: 'Дальний поход не вернулся: имена высечены на камне у кострища.',
      },
    },
  },
  {
    id: 'debt', ru: 'Ссуда Гильдии', w: 7, first: 'offer',
    start: { cond: { minEra: 2, tech: 'trade' } },
    links: {
      offer: {
        text: 'Приказчик Гильдии кладёт на стол кошель: сто пятьдесят золотом сейчас, двести двадцать через год. Подпись — вот здесь.',
        choice: {
          a: { ru: 'Взять деньги (+150🪙)', effect: { gold: 150 },
            chronicle: 'Взята ссуда Гильдии: 150🪙 под 220🪙 через год.',
            next: [{ link: 'collect', w: 1, inDays: [100, 105] }] },
          b: { ru: 'Обойдёмся своими', effect: { happy: 1 },
            chronicle: 'От ссуды Гильдии отказались.' },
        },
      },
      collect: {
        text: 'Год прошёл. Тот же приказчик молча положил на стол ту же бумагу. Двести двадцать.',
        choice: {
          a: { ru: 'Заплатить (220🪙)', cost: { gold: 220 }, effect: { happy: 2 }, extra: { rel: 12 },
            chronicle: 'Долг Гильдии выплачен день в день.',
            next: [{ link: 'partners', w: 1, inDays: [50, 80] }] },
          b: { ru: 'Пусть судятся', effect: { happy: -5 }, extra: { rel: -20 },
            chronicle: 'Долг Гильдии не выплачен.',
            next: [{ link: 'boycott', w: 1, inDays: [8, 15] }] },
        },
      },
      partners: {
        text: 'Гильдия числит нас в надёжных должниках. Караваны идут чаще, а цены нам называют другие.',
        effect: { gold: 100, happy: 3 }, extra: { rel: 8 },
        chronicle: 'Гильдия признала нас надёжным партнёром.',
      },
      boycott: {
        text: 'Караваны обходят нас стороной. На рынке шепчут, что с нами дел не имеют.',
        effect: { goldPct: -0.2, happy: -4 }, extra: { rel: -10 },
        chronicle: 'Гильдия объявила нам бойкот: караваны обходят стороной.',
      },
    },
  },
  {
    id: 'comet', ru: 'Хвостатая звезда', w: 8, first: 'sign',
    start: { cond: { minEra: 1 } },
    links: {
      sign: {
        text: 'Над горизонтом встала звезда с хвостом. Старики говорят — к беде, молодые — к великой удаче. Спорят до хрипоты.',
        choice: {
          a: { ru: 'Задобрить небо пиром (60🍞)', cost: { food: 60 }, effect: { happy: 8 },
            chronicle: 'В честь хвостатой звезды устроен пир.',
            next: [{ link: 'blessing', w: 6, inDays: [40, 70] }, { link: 'mock', w: 4, inDays: [40, 70] }] },
          b: { ru: 'Записать путь звезды', effect: { knowledge: 60 },
            chronicle: 'Путь хвостатой звезды записан на табличках.',
            next: [{ link: 'science', w: 7, inDays: [50, 90] }, { link: 'mock', w: 3, inDays: [50, 90] }] },
        },
      },
      blessing: {
        text: 'Год выдался щедрым: зерно стоит стеной, скот отелился дружно. Все помнят, чей это был пир.',
        effect: { foodPct: 0.2, happy: 5 },
        chronicle: 'После пира в честь звезды год выдался щедрым.',
      },
      science: {
        text: 'Табличка со звёздным путём пригодилась: счёт дней стал точнее, а сев — вовремя.',
        effect: { knowledge: 250, happy: 2 },
        chronicle: 'Наблюдения за кометой дали точный счёт дней.',
      },
      mock: {
        text: 'Звезда ушла за край неба, и ничего не случилось. Над теми, кто пугался, посмеиваются до сих пор.',
        effect: { happy: -3 },
        chronicle: 'Хвостатая звезда ушла, не принеся ни беды, ни удачи.',
      },
    },
  },
  {
    id: 'defector', ru: 'Перебежчик', w: 6, first: 'come',
    start: { cond: { minEra: 2, atWar: true } },
    links: {
      come: {
        text: 'К воротам вышел человек в чужих доспехах. Говорит, что был у них сотником, и что за ним придут.',
        choice: {
          a: { ru: 'Укрыть', effect: { happy: 2 },
            chronicle: 'Вражеский сотник укрыт в поселении.',
            next: [{ link: 'sworn', w: 6, inDays: [15, 30] }, { link: 'raid', w: 4, inDays: [10, 25] }] },
          b: { ru: 'Выдать своим (+60🪙)', effect: { gold: 60 }, extra: { rel: 15 },
            chronicle: 'Перебежчик выдан обратно — за него заплатили золотом.',
            next: [{ link: 'shame', w: 1, inDays: [30, 60] }] },
        },
      },
      sworn: {
        text: 'Сотник привёл своих: три десятка людей, которым дома тоже стало нечего терять. Присягнули у кострища.',
        effect: { happy: 4 }, extra: { soldiers: 3 },
        chronicle: 'Перебежчик привёл своих людей и присягнул нам.',
      },
      raid: {
        text: 'За перебежчиком пришли ночью. Его не нашли — зато сожгли то, что подвернулось под руку.',
        effect: { damageBuilding: 1, happy: -5 },
        chronicle: 'За укрытого перебежчика поплатились сожжённым зданием.',
      },
      shame: {
        text: 'Люди помнят, как мы отдали человека на верную смерть за горсть золота. Помнят и молчат.',
        effect: { happy: -6 },
        chronicle: 'Выдача перебежчика легла на поселение позором.',
      },
    },
  },
];

const LAW_BY_ID = Object.fromEntries(LAWS.map(l => [l.id, l]));
const CHAIN_BY_ID = Object.fromEntries(CHAINS.map(c => [c.id, c]));

// ---------- Состояние ----------
export function createLaws() {
  return {
    laws: { adopted: {}, order: [], offered: null },
    chains: { pending: [], active: {}, done: [], history: [], cooldown: CHAIN_COOLDOWN },
    chronicle: [],
    watch: null,   // срез мира для observe(); заполняется первым же вызовом
  };
}

export function serializeLaws(state) {
  const s = state || createLaws();
  return {
    laws: { adopted: { ...s.laws.adopted }, order: s.laws.order.map(o => ({ ...o })), offered: s.laws.offered ? { ...s.laws.offered } : null },
    chains: {
      pending: s.chains.pending.map(p => ({ ...p })),
      active: JSON.parse(JSON.stringify(s.chains.active)),
      done: [...s.chains.done],
      history: s.chains.history.slice(-60).map(h => ({ ...h })),
      cooldown: s.chains.cooldown,
    },
    chronicle: s.chronicle.map(e => ({ ...e })),
    watch: s.watch ? JSON.parse(JSON.stringify(s.watch)) : null,
  };
}

export function deserializeLaws(data) {
  const s = createLaws();
  if (!data || typeof data !== 'object') return s;
  const L = data.laws || {};
  // Принимаем только законы и варианты, которые существуют в таблице: правка
  // LAWS не должна ронять старый сейв на несуществующем ключе.
  for (const [id, key] of Object.entries(L.adopted || {})) {
    if (optionOf(id, key)) s.laws.adopted[id] = key;
  }
  s.laws.order = (L.order || []).filter(o => o && s.laws.adopted[o.id] === o.key).map(o => ({ ...o }));
  s.laws.offered = L.offered && LAW_BY_ID[L.offered.id] ? { ...L.offered } : null;
  const C = data.chains || {};
  s.chains.pending = (C.pending || []).filter(p => p && linkOf(p.chain, p.link)).map(p => ({ ...p }));
  s.chains.active = {};
  for (const [id, v] of Object.entries(C.active || {})) if (CHAIN_BY_ID[id]) s.chains.active[id] = { ...v };
  s.chains.done = (C.done || []).filter(id => CHAIN_BY_ID[id]);
  s.chains.history = (C.history || []).slice(-60).map(h => ({ ...h }));
  s.chains.cooldown = Number.isFinite(C.cooldown) ? C.cooldown : CHAIN_COOLDOWN;
  s.chronicle = Array.isArray(data.chronicle) ? data.chronicle.slice(-CHRONICLE_MAX).map(e => ({ ...e })) : [];
  s.watch = data.watch ? JSON.parse(JSON.stringify(data.watch)) : null;
  return s;
}

// ---------- Контекст ----------
// Ядро отдаёт Set техов и объекты зданий, тесты и HUD — массивы строк.
// Модуль обязан переваривать оба варианта, поэтому вход всегда через readCtx.
function readCtx(ctx) {
  const o = ctx || {};
  if (o.__lawsCtx) return o;
  const ids = [];
  for (const b of (o.buildings || o.builtIds || [])) {
    if (typeof b === 'string') { ids.push(b); continue; }
    if (!b || !b.id) continue;
    if (b.done === false || b.destroyed) continue;
    ids.push(b.id);
  }
  const idSet = new Set(ids);
  const techs = o.techs;
  const hasTech = (id) => !techs ? false
    : (typeof techs.has === 'function' ? techs.has(id) : (Array.isArray(techs) && techs.includes(id)));
  const res = o.res || {};
  const villagers = Array.isArray(o.villagers) ? o.villagers : null;
  const pop = Math.max(0, Math.round(num(o.pop, villagers ? villagers.length : 0)));
  const wars = Array.isArray(o.wars) ? o.wars : [];
  return {
    __lawsCtx: true,
    day: Math.max(0, Math.round(num(o.day, 0))),
    era: clamp(Math.round(num(o.era, 0)), 0, ERAS.length - 1),
    eraDay: Math.max(0, Math.round(num(o.eraDay, 0))),
    pop, housingCap: num(o.housingCap, ids.reduce((a, id) => a + ((BUILDINGS[id] && BUILDINGS[id].housing) || 0), 0)),
    happy: num(o.happy, 50), res,
    gold: num(res.gold, 0), food: num(res.food, 0),
    ids, hasTech, hasBuilding: (id) => idSet.has(id),
    wars, atWar: wars.length > 0,
    repelled: Math.max(0, Math.round(num(o.repelled, 0))),
    soldiers: Math.max(0, Math.round(num(o.soldiers, 0))),
    spireStage: Math.max(0, Math.round(num(o.spireStage, 0))),
    factionName: typeof o.factionName === 'function' ? o.factionName : ((f) => String(f)),
  };
}

// Условия — маленький язык данных. Незнакомые ключи игнорируются: так таблицу
// можно расширять, не трогая этот разбор.
function condOk(cond, c) {
  if (!cond) return true;
  if (cond.minEra != null && c.era < cond.minEra) return false;
  if (cond.maxEra != null && c.era > cond.maxEra) return false;
  if (cond.minDay != null && c.day < cond.minDay) return false;
  if (cond.minPop != null && c.pop < cond.minPop) return false;
  if (cond.maxPop != null && c.pop > cond.maxPop) return false;
  if (cond.tech && !c.hasTech(cond.tech)) return false;
  if (cond.noTech && c.hasTech(cond.noTech)) return false;
  if (cond.building && !c.hasBuilding(cond.building)) return false;
  if (cond.noBuilding && c.hasBuilding(cond.noBuilding)) return false;
  if (cond.atWar === true && !c.atWar) return false;
  if (cond.atWar === false && c.atWar) return false;
  if (cond.happyBelow != null && c.happy >= cond.happyBelow) return false;
  if (cond.happyAbove != null && c.happy <= cond.happyAbove) return false;
  if (cond.minGold != null && c.gold < cond.minGold) return false;
  if (cond.minRepelled != null && c.repelled < cond.minRepelled) return false;
  if (cond.freeHousing === true && c.pop >= c.housingCap) return false;
  return true;
}

// ---------- U29: выбор и принятие закона ----------

// Какой закон полагается этой эпохе. Первый подходящий по when, иначе — тот,
// у кого условия нет вовсе.
export function lawForEra(era, ctx) {
  const c = readCtx(ctx);
  const list = LAWS.filter(l => l.era === era);
  for (const l of list) if (l.when && condOk(l.when, c)) return l;
  for (const l of list) if (!l.when) return l;
  return null;
}

// Пора ли предлагать закон. Чистая функция: ничего не меняет.
export function lawDue(state, ctx) {
  const s = state || createLaws();
  const c = readCtx(ctx);
  if (c.day < LAW_FIRST_DAY) return null;
  if (c.eraDay < LAW_DELAY_DAYS) return null;
  if (eraLawAdopted(s, c.era)) return null;
  const law = lawForEra(c.era, c);
  if (!law || s.laws.adopted[law.id]) return null;
  return law;
}

// Открыть свод: помечает закон как предложенный (чтобы вариант не менялся,
// пока игрок думает) и отдаёт готовую презентацию для интерфейса.
export function openLaw(state, ctx) {
  const s = state || createLaws();
  const c = readCtx(ctx);
  if (s.laws.offered) {
    const prev = LAW_BY_ID[s.laws.offered.id];
    if (prev && !s.laws.adopted[prev.id]) return presentLaw(prev);
    s.laws.offered = null;   // закон успели принять другим путём — предложение снимаем
    return null;
  }
  const law = lawDue(s, c);
  if (!law) return null;
  s.laws.offered = { id: law.id, day: c.day, era: c.era };
  return presentLaw(law);
}

export function presentLaw(law) {
  return {
    id: law.id, ru: law.ru, era: law.era, eraRu: ERAS[law.era].ru, text: law.text,
    options: law.options.map(o => ({
      key: o.key, ru: o.ru, text: o.text,
      summary: describeEffects(o), effects: effectList(o),
    })),
  };
}

// Принятие. Необратимо: повторный вызов для того же закона отклоняется, и
// функции «отменить закон» в модуле нет намеренно.
export function adoptLaw(state, key, ctx) {
  const s = state || createLaws();
  const c = readCtx(ctx);
  const law = (s.laws.offered && LAW_BY_ID[s.laws.offered.id]) || lawDue(s, c);
  if (!law) return { ok: false, reason: 'Сейчас нечего принимать' };
  if (s.laws.adopted[law.id]) return { ok: false, reason: `«${law.ru}» уже принят — закон не переписывают` };
  const opt = law.options.find(o => o.key === key);
  if (!opt) return { ok: false, reason: 'Такого варианта нет' };
  s.laws.adopted[law.id] = opt.key;
  s.laws.order.push({ id: law.id, key: opt.key, day: c.day, era: c.era });
  s.laws.offered = null;
  const entry = record(s, {
    day: c.day, era: c.era, kind: 'law', weight: 3, icon: '§',
    text: `${opt.chronicle} (${law.ru}: ${opt.ru})`,
  });
  return {
    ok: true, law: law.id, ru: law.ru, option: opt.key, optionRu: opt.ru,
    summary: describeEffects(opt), happy: opt.happy || 0, rel: opt.rel || 0,
    flags: [...(opt.flags || [])], chronicle: [entry],
    log: `§ Закон принят — ${law.ru}: ${opt.ru}. ${describeEffects(opt)}`,
  };
}

export function eraLawAdopted(state, era) {
  const s = state || createLaws();
  return LAWS.some(l => l.era === era && s.laws.adopted[l.id]);
}

// ---------- U29: действие законов ----------

// Произведение множителей всех принятых законов по одному виду.
// Неизвестный kind всегда даёт 1 — ядро может звать лишнее без опаски.
export function lawMult(state, kind) {
  const s = state || createLaws();
  let m = 1;
  for (const [id, key] of Object.entries(s.laws.adopted)) {
    const o = optionOf(id, key);
    if (o && o.mult && o.mult[kind]) m *= o.mult[kind];
  }
  return m;
}

// Плоская добавка к счастью: суммируется, а не перемножается.
export function lawHappy(state) {
  const s = state || createLaws();
  let h = 0;
  for (const [id, key] of Object.entries(s.laws.adopted)) {
    const o = optionOf(id, key);
    if (o && o.happy) h += o.happy;
  }
  return Math.round(h);
}

export function lawFlags(state) {
  const s = state || createLaws();
  const out = [];
  for (const [id, key] of Object.entries(s.laws.adopted)) {
    const o = optionOf(id, key);
    if (o && o.flags) out.push(...o.flags);
  }
  return out;
}

export function lawFlag(state, flag) { return lawFlags(state).includes(flag); }

// Свод для интерфейса: что принято, когда и чем это обернулось.
export function adoptedLaws(state) {
  const s = state || createLaws();
  return s.laws.order.map(o => {
    const law = LAW_BY_ID[o.id];
    const opt = optionOf(o.id, o.key);
    return {
      id: o.id, ru: law ? law.ru : o.id, era: o.era, eraRu: ERAS[o.era] ? ERAS[o.era].ru : '—',
      day: o.day, optionRu: opt ? opt.ru : o.key, summary: opt ? describeEffects(opt) : '',
    };
  });
}

export function effectList(opt) {
  const out = [];
  for (const [kind, v] of Object.entries(opt.mult || {})) {
    const k = LAW_KINDS[kind];
    if (!k) continue;
    const pct = Math.round((v - 1) * 100);
    if (!pct) continue;
    out.push({ kind, ru: k.ru, pct, good: (pct > 0) === (k.good === 'up') });
  }
  if (opt.happy) out.push({ kind: 'happy', ru: 'счастье', flat: opt.happy, good: opt.happy > 0 });
  if (opt.rel) out.push({ kind: 'rel', ru: 'отношения с соседями', flat: opt.rel, good: opt.rel > 0 });
  return out;
}

// Человеческая строка эффектов — чтобы в интерфейсе не писать её руками
// для каждого закона и не забыть обновить при правке чисел.
export function describeEffects(opt) {
  const parts = effectList(opt).map(e => e.pct != null
    ? `${e.ru} ${sign(e.pct)}%`
    : `${e.ru} ${sign(e.flat)}`);
  return parts.length ? parts.join(', ') : 'без прямых последствий';
}

// ---------- U31: цепочки ----------

// Событие-презентация в том же виде, что EVENT_DEFS: ядро умеет их показывать
// и разрешать без единой правки. Поле chain — метка для afterChoice.
export function chainEvent(chainId, linkId) {
  const chain = CHAIN_BY_ID[chainId];
  const link = linkOf(chainId, linkId);
  if (!chain || !link) return null;
  const ev = {
    id: `chain:${chainId}:${linkId}`, ru: chain.ru, text: link.text,
    chain: { id: chainId, link: linkId },
  };
  if (link.choice) {
    ev.choice = {};
    for (const k of Object.keys(link.choice)) {
      const o = link.choice[k];
      ev.choice[k] = { key: k, ru: o.ru, cost: o.cost, effect: o.effect || {}, extra: o.extra || null };
    }
  } else {
    ev.effect = link.effect || {};
    ev.extra = link.extra || null;
  }
  return ev;
}

// Старт новой цепочки. Зовётся раз в день; редкость и кулдаун — здесь, чтобы
// ядру не пришлось помнить лишних чисел.
export function rollChainStart(state, ctx, rng) {
  const s = state || createLaws();
  const c = readCtx(ctx);
  if (s.chains.cooldown > 0) { s.chains.cooldown--; return null; }
  if (Object.keys(s.chains.active).length >= CHAIN_MAX_ACTIVE) return null;
  if (rng && !rng.chance(CHAIN_START_CHANCE)) return null;
  const pool = CHAINS.filter(ch => !s.chains.active[ch.id] && !s.chains.done.includes(ch.id)
    && condOk(ch.start && ch.start.cond, c));
  if (!pool.length) return null;
  const chain = weightedPick(pool, rng);
  s.chains.active[chain.id] = { link: chain.first, since: c.day, steps: 0 };
  s.chains.cooldown = CHAIN_COOLDOWN;
  return chainEvent(chain.id, chain.first);
}

// Пришёл ли срок у отложенного звена. Звено снимается с очереди, поэтому звать
// можно только тогда, когда ядро готово показать событие.
export function takeDueChain(state, ctx, rng) {
  const s = state || createLaws();
  const c = readCtx(ctx);
  const i = s.chains.pending.findIndex(p => p.day <= c.day);
  if (i < 0) return null;
  const p = s.chains.pending.splice(i, 1)[0];
  const ev = chainEvent(p.chain, p.link);
  if (!ev) return null;
  const act = s.chains.active[p.chain] || (s.chains.active[p.chain] = { link: p.link, since: c.day, steps: 0 });
  act.link = p.link; act.steps++;
  // Звено без выбора — это уже развязка: сразу пишем её в летопись и, если
  // продолжение предусмотрено, ставим следующее в очередь.
  if (!ev.choice) {
    const link = linkOf(p.chain, p.link);
    ev.chronicle = [];
    if (link.chronicle) {
      ev.chronicle.push(record(s, {
        day: c.day, era: c.era, kind: 'chain', weight: 2, icon: '❧', text: link.chronicle,
      }));
    }
    s.chains.history.push({ chain: p.chain, link: p.link, key: null, day: c.day });
    schedule(s, p.chain, link.next, c.day, rng);
  }
  return ev;
}

// Вызывается после того, как ядро применило выбор игрока. Планирует
// продолжение и возвращает записи для летописи.
export function afterChoice(state, ev, key, ctx, rng) {
  const s = state || createLaws();
  const c = readCtx(ctx);
  const out = { chronicle: [], log: '', next: null };
  if (!ev || !ev.chain) return out;
  const link = linkOf(ev.chain.id, ev.chain.link);
  const opt = link && link.choice ? link.choice[key] : null;
  if (!opt) return out;
  s.chains.history.push({ chain: ev.chain.id, link: ev.chain.link, key, day: c.day });
  if (opt.chronicle) {
    out.chronicle.push(record(s, {
      day: c.day, era: c.era, kind: 'chain', weight: 2, icon: '❧', text: opt.chronicle,
    }));
  }
  const planned = schedule(s, ev.chain.id, opt.next, c.day, rng);
  if (planned) {
    out.next = planned;
    out.log = 'У этой истории будет продолжение.';
  }
  return out;
}

// Ветка выбирается здесь и сразу ложится в state: сейв не переиграет уже
// решённую судьбу, а партия остаётся воспроизводимой от сида.
function schedule(state, chainId, next, day, rng) {
  if (!next || !next.length) { finishChain(state, chainId); return null; }
  const pick = weightedPick(next, rng);
  const span = pick.inDays || [30, 60];
  const delay = rng ? rng.int(span[0], span[1]) : Math.round((span[0] + span[1]) / 2);
  const item = { chain: chainId, link: pick.link, day: day + delay };
  state.chains.pending.push(item);
  return item;
}

function finishChain(state, chainId) {
  delete state.chains.active[chainId];
  if (!state.chains.done.includes(chainId)) state.chains.done.push(chainId);
}

// Ресурсы и отношения, которых нет в applyEffect ядра.
// target — сам Simulation или любой объект вида { res, resCap, army, adjustRel }.
export function applyExtras(extra, target) {
  const out = [];
  if (!extra || !target) return out;
  const res = target.res || {};
  const cap = target.resCap || {};
  for (const r of ['wood', 'stone', 'food', 'steel', 'gold', 'knowledge']) {
    if (!extra[r]) continue;
    const before = num(res[r], 0);
    const after = clamp(before + extra[r], 0, num(cap[r], Infinity));
    res[r] = after;
    const d = Math.round(after - before);
    if (d) out.push({ text: `${d > 0 ? 'Прибыло' : 'Убыло'}: ${Math.abs(d)} ${resIcon(r)}`, type: d > 0 ? 'good' : 'warn' });
  }
  if (extra.soldiers && target.army) {
    target.army.soldiers = Math.max(0, (target.army.soldiers || 0) + extra.soldiers);
    out.push({
      text: extra.soldiers > 0 ? `К войску прибавилось бойцов: ${extra.soldiers}.` : `Войско потеряло бойцов: ${Math.abs(extra.soldiers)}.`,
      type: extra.soldiers > 0 ? 'good' : 'bad',
    });
  }
  if (extra.rel && typeof target.adjustRel === 'function' && Array.isArray(target.factions)) {
    for (const f of target.factions) target.adjustRel(f.id, extra.rel, 'Слухи о наших делах');
    out.push({ text: `Соседи это заметили: отношения ${sign(extra.rel)}.`, type: extra.rel > 0 ? 'good' : 'warn' });
  }
  return out;
}

// Что сейчас в работе — для подсказки в интерфейсе.
export function chainStatus(state) {
  const s = state || createLaws();
  return Object.keys(s.chains.active).map(id => {
    const p = s.chains.pending.find(q => q.chain === id);
    return {
      id, ru: CHAIN_BY_ID[id] ? CHAIN_BY_ID[id].ru : id,
      link: s.chains.active[id].link,
      waitingUntil: p ? p.day : null,
      text: p ? 'История ещё не закончена.' : 'Ждём вашего решения.',
    };
  });
}

// ---------- U32: хроника ----------

export function record(state, entry) {
  const s = state || createLaws();
  const e = {
    day: Math.max(0, Math.round(num(entry.day, 0))),
    era: clamp(Math.round(num(entry.era, 0)), 0, ERAS.length - 1),
    kind: entry.kind || 'note',
    weight: clamp(Math.round(num(entry.weight, 1)), 1, 3),
    icon: entry.icon || '·',
    text: String(entry.text || '').trim(),
  };
  if (!e.text) return null;
  s.chronicle.push(e);
  // Летопись обязана дочитываться до конца, поэтому у неё есть потолок. Первыми
  // уходят самые старые и самые проходные записи — важное остаётся.
  if (s.chronicle.length > CHRONICLE_MAX) {
    const idx = s.chronicle.findIndex(x => x.weight === 1);
    s.chronicle.splice(idx >= 0 ? idx : 0, 1);
  }
  return e;
}

// Ежедневный обход: сравниваем срез мира с прошлым и пишем только заметное.
export function observe(state, ctx) {
  const s = state || createLaws();
  const c = readCtx(ctx);
  const out = [];
  const w = s.watch || (s.watch = {
    era: c.era, pop: c.pop, popPeak: c.pop, milestones: [], landmarks: [],
    repelled: c.repelled, wars: [], soldiers: c.soldiers, spireStage: c.spireStage, day: c.day,
  });
  const add = (kind, weight, icon, text) => { const e = record(s, { day: c.day, era: c.era, kind, weight, icon, text }); if (e) out.push(e); };

  if (c.era > w.era) {
    add('era', 3, '⌛', `Наступила эпоха: ${ERAS[c.era].ru} (${ERAS[c.era].years}). Население ${c.pop}.`);
    w.era = c.era;
  }
  // Вехи населения: каждую отмечаем один раз за партию.
  for (const m of POP_MILESTONES) {
    if (c.pop >= m && !w.milestones.includes(m)) {
      w.milestones.push(m);
      add('growth', 2, '☗', `Население достигло ${m} — поселение растёт.`);
    }
  }
  // Обвал: треть народа от пика. Это не «умер житель», это память на всю партию.
  if (w.popPeak >= 10 && c.pop <= Math.floor(w.popPeak * COLLAPSE_RATIO) && c.pop < w.pop) {
    add('loss', 3, '☠', `Тяжёлые дни: население упало с ${w.popPeak} до ${c.pop}.`);
    w.popPeak = c.pop;
  }
  w.popPeak = Math.max(w.popPeak, c.pop);
  w.pop = c.pop;

  for (const id of LANDMARKS) {
    if (c.hasBuilding(id) && !w.landmarks.includes(id)) {
      w.landmarks.push(id);
      const b = BUILDINGS[id];
      add('wonder', 2, '⌂', `Построено: ${b ? b.name : id}.`);
    }
  }
  if (c.repelled > w.repelled) {
    add('war', 2, '⚔', `Набег отбит (всего отбито: ${c.repelled}).`);
    w.repelled = c.repelled;
  }
  // Войны: и начало, и конец — обе записи нужны, чтобы летопись читалась.
  const nowWars = c.wars.map(x => (typeof x === 'string' ? x : (x && (x.fid || x.id)))).filter(Boolean);
  for (const fid of nowWars) {
    if (!w.wars.includes(fid)) add('war', 3, '⚔', `Началась война: ${c.factionName(fid)}.`);
  }
  for (const fid of w.wars) {
    if (!nowWars.includes(fid)) add('war', 3, '☮', `Война окончена: ${c.factionName(fid)}.`);
  }
  w.wars = nowWars;
  // Армия сгорела дотла — отдельная строка: это то, что игрок запомнит.
  if (w.soldiers >= 5 && c.soldiers === 0) add('loss', 3, '☠', `Войско погибло целиком (было ${w.soldiers}).`);
  w.soldiers = c.soldiers;
  if (c.spireStage > w.spireStage) {
    add('wonder', 3, '▲', `Шпиль Цивилизации: завершена стадия ${c.spireStage} из 5.`);
    w.spireStage = c.spireStage;
  }
  w.day = c.day;
  return out;
}

export function chronicleEntries(state, filter) {
  const s = state || createLaws();
  const f = filter || {};
  return s.chronicle.filter(e => {
    if (f.kind && e.kind !== f.kind) return false;
    if (f.era != null && e.era !== f.era) return false;
    if (f.minWeight != null && e.weight < f.minWeight) return false;
    return true;
  }).map(e => ({ ...e }));
}

// Вся партия одним текстом: заголовок эпохи, под ним дни. Именно это читают на
// экране победы и в панели летописи.
export function chronicleText(state, filter) {
  const list = chronicleEntries(state, filter);
  if (!list.length) return 'Летопись пока пуста.';
  const out = [];
  let era = -1;
  for (const e of list) {
    if (e.era !== era) {
      era = e.era;
      out.push(`— ${ERAS[era].ru} (${ERAS[era].years}) —`);
    }
    out.push(`День ${e.day}. ${e.icon} ${e.text}`);
  }
  return out.join('\n');
}

export function chronicleStats(state) {
  const s = state || createLaws();
  const byKind = {};
  for (const e of s.chronicle) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return {
    total: s.chronicle.length, byKind,
    laws: s.laws.order.length,
    chainsFinished: s.chains.done.length,
    chainsRunning: Object.keys(s.chains.active).length,
    firstDay: s.chronicle.length ? s.chronicle[0].day : 0,
    lastDay: s.chronicle.length ? s.chronicle[s.chronicle.length - 1].day : 0,
  };
}

// ---------- Внутреннее ----------
function optionOf(lawId, key) {
  const l = LAW_BY_ID[lawId];
  return l ? l.options.find(o => o.key === key) || null : null;
}

function linkOf(chainId, linkId) {
  const c = CHAIN_BY_ID[chainId];
  return c && c.links[linkId] ? c.links[linkId] : null;
}

function weightedPick(list, rng) {
  let total = 0;
  for (const it of list) total += Math.max(0, num(it.w, 1));
  if (total <= 0) return list[0];
  let r = rng ? rng.range(0, total) : total / 2;
  for (const it of list) {
    r -= Math.max(0, num(it.w, 1));
    if (r <= 0) return it;
  }
  return list[list.length - 1];
}

function resIcon(r) {
  return { food: '🍞', wood: '🪵', stone: '🪨', steel: '⚙️', gold: '🪙', knowledge: '📜' }[r] || r;
}

function sign(v) { return `${v > 0 ? '+' : '−'}${Math.abs(v)}`; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
