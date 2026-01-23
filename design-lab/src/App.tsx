import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Beaker, MessageSquare, StickyNote, FolderKanban, Settings } from 'lucide-react';

// ============================================================================
// МОДУЛИ - Импортируй сюда новые тестовые страницы
// ============================================================================
import ResearchLab from '@modules/research/ResearchLab';
// import NotesLab from '@modules/notes/NotesLab';        // TODO: Раскомментируй когда создашь
// import ProjectsLab from '@modules/projects/ProjectsLab'; // TODO: Раскомментируй когда создашь

// ============================================================================
// КОНФИГУРАЦИЯ НАВИГАЦИИ
// Добавляй новые модули сюда - они автоматически появятся в сайдбаре
// ============================================================================
const NAV_ITEMS = [
  {
    path: '/research',
    label: 'Research Chat',
    icon: MessageSquare,
    description: 'AI чат интерфейс (Gemini)',
  },
  {
    path: '/notes',
    label: 'Notes',
    icon: StickyNote,
    description: 'Заметки проекта',
    disabled: true, // Пока не реализовано
  },
  {
    path: '/projects',
    label: 'Projects',
    icon: FolderKanban,
    description: 'Список проектов',
    disabled: true, // Пока не реализовано
  },
];

// ============================================================================
// НАВИГАЦИОННЫЙ САЙДБАР
// ============================================================================
function Sidebar() {
  return (
    <aside className="w-64 h-full bg-[#1a1a1b] border-r border-[#333] flex flex-col">
      {/* Лого */}
      <div className="p-4 border-b border-[#333]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#a8c7fa]/10 rounded-xl flex items-center justify-center">
            <Beaker size={20} className="text-[#a8c7fa]" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">Design Lab</h1>
            <p className="text-[10px] text-gray-500">UI Testing Environment</p>
          </div>
        </div>
      </div>

      {/* Навигация */}
      <nav className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.disabled ? '#' : item.path}
            onClick={(e) => item.disabled && e.preventDefault()}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] transition-all ${
                item.disabled
                  ? 'text-gray-600 cursor-not-allowed'
                  : isActive
                  ? 'bg-[#a8c7fa]/10 text-[#a8c7fa]'
                  : 'text-gray-400 hover:bg-[#252526] hover:text-white'
              }`
            }
          >
            <item.icon size={18} />
            <div className="flex-1">
              <div className="font-medium">{item.label}</div>
              <div className="text-[10px] text-gray-500">{item.description}</div>
            </div>
            {item.disabled && (
              <span className="text-[9px] px-1.5 py-0.5 bg-[#333] rounded text-gray-500">
                soon
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Футер с настройками */}
      <div className="p-3 border-t border-[#333]">
        <button className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-gray-400 hover:bg-[#252526] hover:text-white transition-all">
          <Settings size={18} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

// ============================================================================
// PLACEHOLDER ДЛЯ НЕРЕАЛИЗОВАННЫХ МОДУЛЕЙ
// ============================================================================
function ComingSoon({ title }: { title: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 bg-[#1e1f20] rounded-2xl flex items-center justify-center border border-[#333]">
          <Beaker size={32} className="text-gray-600" />
        </div>
        <h2 className="text-lg font-semibold text-gray-400 mb-2">{title}</h2>
        <p className="text-sm text-gray-600">Этот модуль ещё не реализован</p>
      </div>
    </div>
  );
}

// ============================================================================
// ГЛАВНЫЙ LAYOUT
// ============================================================================
export default function App() {
  return (
    <div className="h-screen flex bg-[#131314]">
      {/* Боковая панель навигации */}
      <Sidebar />

      {/* Основной контент */}
      <main className="flex-1 overflow-hidden">
        <Routes>
          {/* Редирект с корня на Research */}
          <Route path="/" element={<Navigate to="/research" replace />} />

          {/* ================================================================
              РОУТЫ МОДУЛЕЙ
              Добавляй новые роуты здесь по мере создания модулей
              ================================================================ */}
          <Route path="/research" element={<ResearchLab />} />
          <Route path="/notes" element={<ComingSoon title="Notes Lab" />} />
          <Route path="/projects" element={<ComingSoon title="Projects Lab" />} />

          {/* 404 */}
          <Route path="*" element={<Navigate to="/research" replace />} />
        </Routes>
      </main>
    </div>
  );
}
