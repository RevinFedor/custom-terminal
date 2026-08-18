// Верх окна стал ОДНОЙ строкой вместо двух.
//
// Раньше под шапкой с проектами шла вторая полоса во всю ширину экрана: файлы
// проекта, история вкладок, VS Code, индекс, ⌘P, Timeline, ресурсы, Docs, Git.
// Она забирала высоту у терминала на каждом экране ради десятка кнопок, при
// этом её левая половина говорила про ОДИН проект — тот же, чей список вкладок
// шёл ниже, а справа от карточек проектов в шапке и так всегда пустовало место.
//
// Разъехалось по хозяевам: кнопки проекта — внутрь боковой панели вкладок, над
// своим списком; кнопки рабочей области — наверх, в шапку.
//
// Правила ниже — про то, что при следующей правке ломается первым: два числа
// высоты, которые обязаны совпадать, и поверхности, которые стоят напротив
// верхней полосы через `position: fixed` и не узнают её высоту из раскладки.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(here, ...parts), 'utf8');
const readRepo = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

const layout = readRepo('src/renderer/constants/layout.ts');
const app = readRepo('src/renderer/App.tsx');
const workspace = read('Workspace.tsx');
const sidebar = read('TabSidebar.tsx');
const sidebarTools = read('SidebarToolsRow.tsx');
const titleBarTools = read('WorkspaceTitleBarTools.tsx');
const statusBar = readRepo('src/renderer/components/StatusBar.tsx');
const helpButton = readRepo('src/renderer/components/UI/HelpButton.tsx');

test('полосы во всю ширину под шапкой больше нет', () => {
  assert.ok(!fs.existsSync(path.join(here, 'ProjectToolbar.tsx')), 'компонент удалён');
  assert.ok(!/ProjectToolbar/.test(workspace), 'рабочая область его больше не рендерит');
  // Высота полосы тоже удалена: оставшаяся константа через месяц начала бы
  // означать пустое место, которого нет.
  assert.ok(!/PROJECT_TOOLBAR_H/.test(layout));
});

test('высота шапки и высота нативной полосы macOS — одно число в двух местах', () => {
  // В этой полосе macOS сам рисует кнопки закрыть/свернуть. Если числа
  // разойдутся, кружки встанут не по центру нашей шапки — а поправить это в
  // вёрстке уже нельзя, они рисуются поверх окна.
  const declared = layout.match(/export const TITLE_BAR_H = (\d+);/);
  assert.ok(declared, 'высота шапки объявлена в constants/layout');
  const main = readRepo('src/main/main.js');
  const overlay = main.match(/titleBarOverlay: \{[\s\S]{0,600}?height: (\d+),/);
  assert.ok(overlay, 'titleBarOverlay задаёт высоту');
  assert.equal(overlay[1], declared[1], 'шапка и нативная полоса разной высоты');
  // Шапка берёт высоту из константы, а не из своего класса: иначе правка
  // константы молча ничего не изменила бы.
  assert.match(app, /height: TITLE_BAR_H,/);
  assert.ok(!/title-bar h-\[40px\]/.test(app), 'жёсткая высота 40 в классе снята');
});

test('поверхности, стоящие напротив верхней полосы, считают её высоту, а не помнят число', () => {
  // Обе открываются поверх окна и не участвуют в обычной раскладке, поэтому
  // единственный способ не наехать на шапку — спросить у общей константы.
  const switcher = read('TabSwitcherOverlay.tsx');
  const projectSwitcher = read('ProjectSwitcherOverlay.tsx');
  assert.match(switcher, /import \{ TOP_STRIP_H \} from '\.\.\/\.\.\/constants\/layout'/);
  assert.match(projectSwitcher, /paddingTop: TOP_STRIP_H,/);
  // Файловый проводник открывается кнопкой из ряда инструментов боковой панели
  // и начинается ПОД этим рядом: панель поверх собственной кнопки читается как
  // «кнопка исчезла».
  assert.match(workspace, /import \{ EXPLORER_TOP_H \}/);
  assert.match(workspace, /top: EXPLORER_TOP_H,/);
  assert.match(layout, /export const EXPLORER_TOP_H = TITLE_BAR_H \+ SIDEBAR_TOOLS_H;/);
});

test('кнопки проекта стоят над списком вкладок ЭТОГО же проекта', () => {
  // Смысл переезда: у кнопок и у списка один хозяин. Если ряд начнёт брать
  // проект из «активного» вместо переданного, в разделённом окне он будет
  // управлять не тем проектом, над которым нарисован.
  assert.match(sidebar, /<SidebarToolsRow projectId=\{projectId\} \/>/);
  assert.match(sidebarTools, /export default function SidebarToolsRow\(\{ projectId \}: SidebarToolsRowProps\)/);
  // Активный проект здесь разрешено только СРАВНИВАТЬ со своим (нужно для
  // хоткея ниже), но не брать из него данные: иначе кнопка над одной панелью
  // отвечала бы за директорию другой.
  for (const hit of sidebarTools.match(/state\.activeProjectId[^\n]*/g) || []) {
    assert.match(hit, /=== projectId/, 'активный проект используется как источник: ' + hit.trim());
  }
  // Директория — у вкладки СВОЕГО проекта, а не у глобально активной.
  assert.match(sidebarTools, /const ownTabId = workspace\?\.activeTabId;/);
  assert.ok(!/getEffectiveTabId\(\)/.test(sidebarTools), 'общая активная вкладка тут не при чём');
  // Кнопки, которых у системного Inbox-проекта быть не должно, скрыты по
  // самому проекту, а не по флагу, переданному сверху.
  assert.match(sidebarTools, /const isSystemProject = isInboxProjectId\(projectId\);/);
});

test('⌘G принадлежит проекту, на который смотрит пользователь', () => {
  // Панелей теперь несколько (по одной на видимый проект), и каждая несёт свой
  // экземпляр ряда. Без этой проверки хоткей открыл бы редактор в директории
  // случайного фонового проекта — того, чей обработчик повесился последним.
  assert.match(sidebarTools, /if \(isSystemProject \|\| !isFocusedProject\) return;/);
  assert.match(sidebarTools, /\(state\.focusedProjectId \|\| state\.activeProjectId\) === projectId/);
});

test('кнопки рабочей области стоят в шапке и только когда рабочая область видна', () => {
  // На Dashboard рабочей области нет; кнопки там управляли бы проектом,
  // которого не видно.
  assert.match(app, /\{view === 'workspace' && <WorkspaceTitleBarTools \/>\}/);
  // Шапка тащит окно за пустое место — кнопки не пустое место.
  assert.match(titleBarTools, /WebkitAppRegion: 'no-drag'/);
  // Всплывающие панели ищут свою опорную полосу по этой метке (Git, расход
  // токенов). Метка переехала вместе с кнопками, поэтому и осталась прежней.
  assert.match(titleBarTools, /data-project-toolbar/);
});

test('строка проектов сжимается и прокручивается, а не выдавливает кнопки', () => {
  // Строка теперь одна на всё: карточки проектов делят её с кнопками справа.
  // Без min-w-0 flex-блок отказывается сжиматься и выпихивает соседей за край
  // окна — это и есть та самая «не помещаются».
  const strip = app.slice(app.indexOf('data-project-tabs-strip'));
  const head = strip.slice(0, strip.indexOf('>'));
  assert.match(head, /min-w-0/);
  assert.match(head, /overflowX: 'auto'/);
  // Полоса прокрутки спрятана: в строке 30px она съела бы пятую часть высоты.
  assert.match(head, /scrollbar-hide/);
  // У карточек есть потолок высоты: отступы настраивает пользователь, и без
  // потолка карточка вылезала бы за край низкой шапки.
  const cardHeights = app.match(/height: `\$\{Math\.min\(PROJECT_CARD_MAX_H/g) || [];
  assert.equal(cardHeights.length, 2, 'потолок и у Home, и у карточек проектов');
});

test('справка уехала вниз и получила подпись', () => {
  // Раньше стояла первой в шапке — на самом видном месте приложения под то,
  // что открывают раз в месяц.
  assert.ok(!/HelpButton/.test(app.slice(app.indexOf('title-bar'))), 'из шапки убрана');
  assert.match(statusBar, /\{onOpenHelp && <HelpButton onOpenHelp=\{onOpenHelp\} \/>\}/);
  // Форма — как у соседей по нижней строке: значок плюс слово, высота 18.
  assert.match(helpButton, /height: 18/);
  assert.match(helpButton, /<span>справка<\/span>/);
  assert.ok(!/h-7 w-7/.test(helpButton), 'квадрат со значком заменён на строку с подписью');
});

test('кнопка индекса в узком ряду показывает состояние, а не все свои числа', () => {
  // Ряд идёт в колонке шириной от 140px. Полные отступы и три числа вытеснили
  // бы соседние кнопки за край; смысл состояний при этом не меняется.
  const semantic = read('SemanticIndexButton.tsx');
  assert.match(semantic, /compact\?: boolean;/);
  assert.match(sidebarTools, /<SemanticIndexButton\s*\n\s*compact/);
  // Отставание — единственное число, ради которого сюда смотрят; оно остаётся
  // в обоих видах.
  assert.match(semantic, /\{outdated > 0 && \(/);
  assert.match(semantic, /\{!compact && <span style=\{\{ color: '#22c55e' \}\}>\{status\.fresh\}<\/span>\}/);
});
