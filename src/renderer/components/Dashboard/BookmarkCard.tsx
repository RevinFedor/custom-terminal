import React, { useState, useRef } from 'react';
import { Bookmark } from '../../store/useBookmarksStore';
import { HelpCircle, Settings, Plus } from 'lucide-react';
import SmartPopover from '../UI/SmartPopover';

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
  const [showInfo, setShowInfo] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Shorten path for display
  const shortPath = bookmark.path.replace(/^\/Users\/[^/]+/, '~');

  // Show green overlay only when card is hovered but NOT buttons
  const showAddOverlay = isHovered && !isButtonsHovered;

  return (
    <div
      className="group/bookmark"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setIsButtonsHovered(false);
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
          <div className="text-sm text-white truncate font-medium">{bookmark.name}</div>
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

        {/* Right side buttons - vertical stack */}
        <div
          className="flex flex-col border-l border-[#333] w-8 shrink-0 relative"
          onMouseEnter={() => setIsButtonsHovered(true)}
          onMouseLeave={() => setIsButtonsHovered(false)}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Settings Button (Top) */}
          <button
            className="flex-1 flex items-center justify-center text-[#555] hover:text-white hover:bg-white/5 transition-all cursor-pointer border-b border-[#333] rounded-tr-lg"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(bookmark);
            }}
            title="Edit Bookmark"
          >
            <Settings size={13} />
          </button>

          {/* Help Button (Bottom) */}
          <div className="flex-1 flex items-center justify-center">
            <SmartPopover content={bookmark.description || 'No description'} isOpen={showInfo}>
              <button
                className="w-8 h-full flex items-center justify-center text-[#555] hover:text-white hover:bg-white/5 transition-all cursor-pointer rounded-br-lg"
                onMouseEnter={() => setShowInfo(true)}
                onMouseLeave={() => setShowInfo(false)}
              >
                <HelpCircle size={13} />
              </button>
            </SmartPopover>
          </div>
        </div>
      </div>
    </div>
  );
}
