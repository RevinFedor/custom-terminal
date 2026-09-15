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
const navigation = read('WorkspaceNavigationRow.tsx');
const titleBarTools = read('WorkspaceTitleBarTools.tsx');
const globalRunAfter = read('GlobalRunAfterControl.tsx');
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

test('dev runtime is marked by purple DEV, including built file:// E2E launches', () => {
  assert.match(app, /const IS_DEVELOPMENT_RUNTIME = import\.meta\.env\.DEV/);
  assert.match(app, /process\?\.env\?\.NODE_ENV === 'development'/);
  assert.match(app, /data-runtime-environment=\{IS_DEVELOPMENT_RUNTIME \? 'development' : 'production'\}/);
  assert.match(app, /const DEV_PURPLE = '#A855F7'/);
  assert.match(app, /const HOME_RUNTIME_LABEL = IS_DEVELOPMENT_RUNTIME \? 'DEV' : 'Home'/);
  assert.match(app, /<AppHomeGlyph[\s\S]{0,100}\{HOME_RUNTIME_LABEL\}/);
  assert.doesNotMatch(app, />\[DEV\]</);
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
  assert.doesNotMatch(sidebar, /<SidebarToolsRow/);
  assert.match(navigation, /<SidebarToolsRow[\s\S]*?projectId=\{projectId\}/);
  assert.match(navigation, /style=\{\{ width: sidebarWidth \}\}/);
  assert.match(sidebarTools, /export default function SidebarToolsRow\(\{ projectId, presentation = 'workspace', trailingControls \}: SidebarToolsRowProps\)/);
  assert.match(navigation, /trailingControls=\{<GlobalRunAfterControl \/>\}/,
    'глобальный Run After должен жить в том же верхнем ряду, не внутри списка вкладок');
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

test('узкая строка проекта оставляет Историю и Run After компактными', () => {
  assert.doesNotMatch(sidebarTools, /showHistoryLabel|WIDTH_FOR_HISTORY_LABEL/);
  assert.doesNotMatch(sidebarTools, /<span>История<\/span>/);
  assert.match(globalRunAfter, /<GitBranch size=\{13\} \/> run-after · \{activeCount\}/);
});

test('⌘G принадлежит проекту, на который смотрит пользователь', () => {
  // Ряд теперь один и переживает Dashboard, но его directory actions по-прежнему
  // принадлежат exact focused project rather than the center's stale project.
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

test('верхний toolbar остаётся одной строкой и листается обычным wheel', () => {
  const head = titleBarTools.slice(
    titleBarTools.indexOf('data-workspace-titlebar-tools'),
    titleBarTools.indexOf('>\n      <FocusedWorkspaceGitStatus'),
  );
  assert.match(head, /min-w-0 scrollbar-hide/);
  assert.match(head, /overflowX: 'auto'/);
  assert.match(head, /overflowY: 'hidden'/);
  assert.match(head, /whiteSpace: 'nowrap'/);
  assert.match(head, /flexWrap: 'nowrap'/);
  assert.match(head, /scrollWidth <= element\.clientWidth/);
  assert.match(head, /element\.scrollLeft \+= delta/);
  assert.match(read('ResourceUsageButton.tsx'), /whiteSpace: 'nowrap'/);
});

test('проектные tool-строки тоже переводят обычный wheel в горизонтальный scroll', () => {
  assert.match(app, /data-project-tabs-strip[\s\S]*?scrollWidth <= element\.clientWidth/);
  assert.match(sidebarTools, /data-sidebar-tools-row[\s\S]*?scrollWidth <= element\.clientWidth/);
  assert.match(sidebarTools, /whiteSpace: 'nowrap'/);
  assert.match(sidebarTools, /flexWrap: 'nowrap'/);
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

test('полоска Run after стоит ВЫШЕ бокового окна — в ОБЕИХ раскладках', () => {
  // Она перестала отходить в сторону при открытии бокового окна — уступать
  // место окну, которое закрывается одной клавишей, ей нечего. Но на слое ниже
  // это означает не «стоит на месте», а «спряталась под ним».
  //
  // Раскладок две, и раньше проверялась только одиночная: в режиме панелей своя
  // копия полоски осталась под боковым окном той же панели. Правило одно на обе,
  // поэтому и читаются обе — иначе следующая раскладка снова разойдётся молча.
  const zOf = (source, marker) => {
    const at = source.indexOf(marker);
    assert.ok(at > 0, `не найдено: ${marker}`);
    const style = source.slice(at, source.indexOf('/>', at));
    return Number((style.match(/zIndex: (\d+)/) || [])[1]);
  };

  const frame = readRepo('src/renderer/components/Workspace/FloatingTerminalFrame.tsx');
  // Боковой ТЕРМИНАЛ — одна рама на обе раскладки.
  const sideTerminalZ = Number((frame.match(/zIndex: floating \? (\d+)/) || [])[1]);
  assert.ok(Number.isFinite(sideTerminalZ));

  const singleHostZ = zOf(workspace, 'data-workspace-prompt-queue-host');
  assert.ok(
    singleHostZ > sideTerminalZ,
    `одиночный режим: полоска (${singleHostZ}) должна быть выше бокового окна (${sideTerminalZ})`,
  );

  const pane = read('SplitPaneSurface.tsx');
  const paneHostZ = zOf(pane, 'data-split-pane-queue-host');
  // Боковой ЧАТ панели — второй возможный сосед по слоту ⌘]. Открывается тем же
  // жестом, и ответ «кто кого закрывает» обязан быть тем же.
  const paneSideHistoryZ = zOf(pane, 'data-split-pane-side-history');
  assert.ok(
    paneHostZ > sideTerminalZ,
    `режим панелей: полоска (${paneHostZ}) должна быть выше бокового терминала (${sideTerminalZ})`,
  );
  assert.ok(
    paneHostZ > paneSideHistoryZ,
    `режим панелей: полоска (${paneHostZ}) должна быть выше бокового чата (${paneSideHistoryZ})`,
  );

  // Рамка окна панели остаётся выше всего: граница не должна прерываться тем,
  // что внутри неё лежит.
  const chrome = readRepo('src/renderer/components/Workspace/SplitPaneChrome.tsx');
  const frameZ = Number((chrome.match(/SPLIT_PANE_FOCUS_FRAME_Z = (\d+)/) || [])[1]);
  assert.ok(frameZ > paneHostZ, `рамка окна (${frameZ}) должна оставаться выше полоски (${paneHostZ})`);
});

test('кнопки шапки отвечают на курсор — все, а не через одну', () => {
  // Кнопка, которая молчит под курсором, читается как подпись. Соседи по
  // строке при этом подсвечиваются, и разница выглядит поломкой.
  const usage = read('ClaudeUsageButton.tsx');
  assert.match(usage, /\.usage-provider-trigger:not\(\[aria-expanded="true"\]\):hover/);
  const timeline = read('TimelineToolsButton.tsx');
  assert.match(timeline, /onMouseEnter=\{hoverIn\}/);
  assert.match(timeline, /onMouseLeave=\{hoverOut\}/);
  // Кнопка со своим цветом состояния на курсор не отвечает: её подложка уже
  // занята под сообщение о состоянии, подсветка поверх соврала бы.
  assert.match(timeline, /const hoverIn = \(event: React\.MouseEvent<HTMLButtonElement>\) => \{\s*\n\s*if \(active\) return;/);
  const resource = read('ResourceUsageButton.tsx');
  assert.match(resource, /onMouseEnter=\{\(event\) => \{\s*\n\s*if \(open\) return;/);
});

test('кнопки инструментов боковой панели той же меры, что кнопки шапки', () => {
  // Две разные меры кнопки в одном окне читаются как два разных приложения.
  const row = read('SidebarToolsRow.tsx');
  assert.match(row, /height: 26,/);
  assert.match(row, /fontSize: 11,/);
  // Кнопка индекса живёт в том же ряду и обязана совпадать с соседями.
  const semantic = read('SemanticIndexButton.tsx');
  assert.match(semantic, /height: 26,\s*\n\s*minWidth: 26,/);
  // Высота ряда следует за кнопкой, а не наоборот.
  assert.match(layout, /export const SIDEBAR_TOOLS_H = 30;/);
});

test('«Только значок» работает без custom raster через цветную папку', () => {
  const modal = readRepo('src/renderer/components/UI/EditProjectModal.tsx');
  assert.doesNotMatch(modal, /disabled=\{!hasIcon\}|if \(!hasIcon\) return/);
  assert.match(modal, /aria-checked=\{hideName\}/);
  assert.match(modal, /hideName,\s*\n\s*description:/);
  assert.match(modal, /\[editingProject, name, hideName, description, path\]/,
    'close-save must not overwrite the latest icon-only choice with a stale render');
  const db = readRepo('src/main/database.js');
  assert.match(db, /hideName: project\.hide_name === 1,/);
  // Скрыта ПОДПИСЬ, а не имя: оно остаётся в подсказке и в доступности.
  assert.match(app, /function ProjectFolderGlyph/);
  assert.match(app, /data-project-fallback-icon/);
  assert.match(app, /stroke="#A78BFA"/);
  assert.match(app, /title=\{hideProjectName \? projectName : undefined\}/);
  assert.match(app, /<span className="sr-only">\{projectName\}<\/span>/);
});

test('«Запустить» в меню вкладки переиспользует общий запуск агентов', () => {
  // Второй код запуска разошёлся бы с первым на первой же особенности —
  // пометке «resume в пути», авто-имени вкладки, снятии пометки «прервана».
  const tabBar = read('TabBar.tsx');
  assert.match(tabBar, /getHistoryAgentRuntime\(target\.toolType\)/);
  assert.match(tabBar, /runtime\.resume\(\{/);
  assert.match(tabBar, /runtime\.startFresh\?\.\(\{/);
  // Решение «Run или Stop» — чистая функция, общая с кнопкой состояния в
  // переписке по правилу «живое действие вытесняет запуск».
  assert.match(tabBar, /resolveTabMenuRunState\(/);
  const model = readRepo('src/renderer/utils/tabMenuRunAction.mjs');
  assert.match(model, /if \(running > 0\) return \{ kind: 'stop'/);
});
