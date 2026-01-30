import React, { useState, useRef } from 'react';
import { Bookmark } from '../../store/useBookmarksStore';
import { HelpCircle, MoreVertical, Pencil, Trash2, Plus } from 'lucide-react';

interface BookmarkCardProps {
  bookmark: Bookmark;
  onCreateProject: (bookmark: Bookmark) => void;
  onEdit: (bookmark: Bookmark) => void;
  onDelete: (bookmark: Bookmark) => void;
}

export default function BookmarkCard({
  bookmark,
  onCreateProject,
  onEdit,
  onDelete
}: BookmarkCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isButtonsHovered, setIsButtonsHovered] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Shorten path for display
  const shortPath = bookmark.path.replace(/^\/Users\/[^/]+/, '~');

  // Manual Bounds Check: reset hover if click is outside card bounds
  const handleBackdropClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    setIsButtonsHovered(false);

    // Check if cursor is outside card bounds
    if (cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      const isOutside =
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom;

      if (isOutside) {
        setIsHovered(false);
      }
    }
  };

  // Show green overlay only when card is hovered but NOT buttons
  const showAddOverlay = isHovered && !isButtonsHovered && !showMenu;

  return (
    <div
      className="group/bookmark"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setIsButtonsHovered(false);
        setShowMenu(false);
      }}
    >
      {/* Main Card */}
      <div
        ref={cardRef}
        className="relative flex items-stretch rounded-lg border border-[#333] bg-[#1a1a1a] cursor-pointer transition-all duration-150 hover:border-[#555]"
        onClick={() => onCreateProject(bookmark)}
      >
        {/* Content */}
        <div
          className="flex-1 min-w-0 px-2.5 py-1.5 transition-opacity duration-150"
          style={{ opacity: showAddOverlay ? 0 : 1 }}
          title={bookmark.path}
        >
          <div className="text-sm text-white truncate">{bookmark.name}</div>
          <div className="text-[10px] text-[#666] truncate">{shortPath}</div>
        </div>

        {/* Add Project overlay text */}
        {showAddOverlay && (
          <div
            className="absolute inset-0 flex items-center justify-center gap-2 rounded-lg pointer-events-none"
            style={{ backgroundColor: 'rgba(74, 222, 128, 0.1)' }}
          >
            <Plus size={14} className="text-green-400" />
            <span className="text-sm text-green-400 font-medium">Add Project</span>
          </div>
        )}

        {/* Right side buttons - stretch full height */}
        <div
          className="flex items-stretch self-stretch"
          onMouseEnter={() => setIsButtonsHovered(true)}
          onMouseLeave={() => setIsButtonsHovered(false)}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Info button - only render if description exists */}
          {bookmark.description && (
            <span className="relative group/info flex items-stretch">
              <button
                className="px-2 flex items-center text-[#666] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <HelpCircle size={14} />
              </button>

              {/* Genie tooltip */}
              <div className="absolute right-full top-1/2 -translate-y-1/2 pr-2 pointer-events-none z-50">
                <div
                  className="origin-right opacity-0 translate-x-4 scale-x-0 scale-y-[0.85]
                    group-hover/info:opacity-100 group-hover/info:translate-x-0
                    group-hover/info:scale-x-100 group-hover/info:scale-y-100
                    transition-all duration-200 ease-out
                    bg-[#252525] border border-[#444] p-3 rounded-lg shadow-xl
                    w-64 max-w-[calc(100vw-2rem)]"
                >
                  <p className="text-xs text-[#ccc] whitespace-pre-wrap">{bookmark.description}</p>
                </div>
              </div>
            </span>
          )}

          {/* Menu button */}
          <div className="relative flex items-stretch">
            <button
              className="px-2 flex items-center text-[#666] hover:text-white hover:bg-white/10 rounded-r-lg transition-colors cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
            >
              <MoreVertical size={14} />
            </button>

            {/* Dropdown menu */}
            {showMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={handleBackdropClick}
                />
                <div
                  className="absolute right-0 top-full mt-1 bg-[#252525] border border-[#444] rounded-lg shadow-xl py-1 min-w-[120px] z-50"
                >
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      setIsButtonsHovered(false);
                      setIsHovered(false);
                      onEdit(bookmark);
                    }}
                  >
                    <Pencil size={12} />
                    Edit
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      setIsButtonsHovered(false);
                      setIsHovered(false);
                      onDelete(bookmark);
                    }}
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
