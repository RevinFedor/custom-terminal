import React, { useState, useRef } from 'react';
import {
  FileText,
  Pencil,
  Terminal as TermIcon,
  FileOutput,
  Search,
  Brain,
  Loader,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Zap,
  GitFork,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────

interface Step {
  tool: 'read' | 'edit' | 'bash' | 'write' | 'grep' | 'glob' | 'thinking';
  target: string;
  result?: string;
  isLoading?: boolean;
  detail?: string;
}

interface UserMessage {
  id: string;
  role: 'user';
  time: string;
  content: string;
}

interface AssistantMessage {
  id: string;
  role: 'assistant';
  time: string;
  duration?: string;
  steps: Step[];
  content: string;
  isStreaming?: boolean;
}

type ChatMessage = UserMessage | AssistantMessage;

interface Separator {
  id: string;
  type: 'compact' | 'fork' | 'plan';
  label: string;
}

type Entry =
  | ({ kind: 'message' } & ChatMessage)
  | ({ kind: 'separator' } & Separator);

// ─── Mock Data ───────────────────────────────────────────────────

const MOCK_ENTRIES: Entry[] = [
  // Turn 1 — Implement spectral index processing (from real JSONL session)
  {
    kind: 'message',
    id: 'u1',
    role: 'user',
    time: '20:01',
    content:
      'Implement the following plan: Постобработка мультиспектральных TIFF \u2014 расчёт спектральных индексов. NodeODM выдаёт мультиспектральный GeoTIFF (10-11 bands). Бэкенд хардкодит spectralTypes = [\'rgb\'] и генерит тайлы только для RGB. Фронтенд отправляет выбранные типы (NDVI, VARI, INFRARED), они сохраняются в БД, но не используются при обработке.',
  },
  {
    kind: 'message',
    id: 'a1',
    role: 'assistant',
    time: '20:01',
    duration: '12м 40с',
    steps: [
      {
        tool: 'thinking',
        target: 'Нужно прочитать все referenced knowledge файлы из architecture.md и main-feature.md...',
        detail: 'Now I need to read all referenced knowledge files from architecture.md and main-feature.md, plus the feature file for drone processing.\n\nFrom architecture.md:\n- knowledge/fix-node-25-buffer.md\n\nFrom main-feature.md:\n- features/drone-processing.md\n- knowledge/fact-odm-multispectral.md\n- knowledge/axenta-details.md\n\nLet me read all of them, plus the source files I need to modify.',
      },
      {
        tool: 'read',
        target: 'drone-queue.processor.ts',
        result: '687 строк',
        detail: "// src/drone-processing/processors/drone-queue.processor.ts\n\nimport { Processor, Process } from '@nestjs/bull';\nimport { Job } from 'bull';\nimport { Injectable, Logger } from '@nestjs/common';\nimport { PrismaService } from '@/prisma/prisma.service';\nimport { StorageService } from '@/storage/storage.service';\nimport { NodeOdmClientService } from '../services/node-odm-client.service';\nimport { ImageProcessingService } from '../services/image-processing.service';\nimport { ProcessingStatus } from '@prisma/client';\nimport * as path from 'path';\nimport * as fs from 'fs';\nimport * as unzipper from 'unzipper';\nimport { mkdirp } from 'mkdirp';\nimport { rm } from 'fs/promises';",
      },
      {
        tool: 'read',
        target: 'image-processing.service.ts',
        result: '412 строк',
      },
      {
        tool: 'read',
        target: 'FieldDroneCreator.tsx',
        result: '380 строк',
      },
      {
        tool: 'thinking',
        target: 'Прочитал все файлы. Нужно реализовать 4 изменения: Python-скрипт, методы в сервисе, процессор, фронтенд...',
        detail: "I've read all the required files. Now let me create the task list and start implementing.\n\nI need to implement four changes:\n1. Create Python script for spectral calculations (rasterio windowed reads)\n2. Add processSpectralIndex() + generateTilesFromTiff() to image-processing.service.ts\n3. Replace hardcoded spectralTypes=['rgb'] with dynamic read from DB in drone-queue.processor.ts\n4. Fix closure bug in FieldDroneCreator.tsx where uploadFiles captures stale params",
      },
      {
        tool: 'bash',
        target: 'ls scripts/',
        result: '\u2713 success',
        detail: "assign-fields-to-sites.ts\nborder-gdal.py\ncheck-axenta-suffixes.ts\ncheck-gaps.ts\ncheck-track-coords.ts\ncompare-resource.ts\ndebug-search-works.ts\ndetailed-compare.ts\nemulate-detect-works.ts\nexport-axenta-data.ts\nexport-csv.ts\nexport-excel.ts\nfind-resource.ts\ninit-db.sql\nmake_border.py\nmigrate-units.ts",
      },
      {
        tool: 'write',
        target: 'scripts/calculate_spectral.py',
        result: 'новый файл',
        detail: '#!/usr/bin/env python3\n"""\ncalculate_spectral.py \u2014 \u0420\u0430\u0441\u0447\u0451\u0442 \u0441\u043f\u0435\u043a\u0442\u0440\u0430\u043b\u044c\u043d\u044b\u0445 \u0438\u043d\u0434\u0435\u043a\u0441\u043e\u0432 \u0438\u0437 \u043c\u0443\u043b\u044c\u0442\u0438\u0441\u043f\u0435\u043a\u0442\u0440\u0430\u043b\u044c\u043d\u043e\u0433\u043e GeoTIFF.\n\n\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u0435:\n    python3 calculate_spectral.py <input.tif> <output.tif> --index=NDVI\n\n\u041f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043c\u044b\u0435 \u0438\u043d\u0434\u0435\u043a\u0441\u044b: NDVI, VARI, INFRARED, RED, NDRE, GNDVI, SAVI, EVI\n\nMicasense default band order: B=1, G=2, R=3, NIR=4, RE=5\nWindowed reads (1024x1024) \u0434\u043b\u044f \u044d\u043a\u043e\u043d\u043e\u043c\u0438\u0438 RAM (~100 \u041c\u0411 \u043d\u0430 2-8 \u0413\u0411 \u0444\u0430\u0439\u043b\u0430\u0445).\n"""\n\nimport sys\nimport argparse\nimport numpy as np\nimport rasterio\nfrom rasterio.windows import Window\nfrom rasterio.transform import from_bounds',
      },
      {
        tool: 'edit',
        target: 'image-processing.service.ts',
        result: '+48 \u22124',
        detail: "   /**\n-   * \u0420\u0435\u043a\u0443\u0440\u0441\u0438\u0432\u043d\u0430\u044f \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u043f\u0430\u043f\u043a\u0438 \u0441 \u0442\u0430\u0439\u043b\u0430\u043c\u0438 \u0432 \u0445\u0440\u0430\u043d\u0438\u043b\u0438\u0449\u0435\n-   * \u0411\u0443\u0434\u0435\u0442 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c\u0441\u044f DroneService \u0434\u043b\u044f \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438 \u0432 S3\n-   */\n+   * \u0420\u0430\u0441\u0447\u0451\u0442 \u0441\u043f\u0435\u043a\u0442\u0440\u0430\u043b\u044c\u043d\u043e\u0433\u043e \u0438\u043d\u0434\u0435\u043a\u0441\u0430 \u0447\u0435\u0440\u0435\u0437 Python-\u0441\u043a\u0440\u0438\u043f\u0442\n+   */\n+  async processSpectralIndex(\n+    sourceTiffPath: string,\n+    outputTiffPath: string,\n+    indexType: string,\n+  ): Promise<string> {\n+    const isDev = this.configService.get<string>('IS_DEV') === 'true';\n+    const pythonPath = isDev\n+      ? '/opt/homebrew/bin/python3'\n+      : '/usr/bin/python3';\n+    const scriptPath = isDev\n+      ? path.join('scripts', 'calculate_spectral.py')\n+      : path.join(process.cwd(), 'scripts', 'calculate_spectral.py');",
      },
      {
        tool: 'edit',
        target: 'drone-queue.processor.ts',
        result: '+52 \u221210',
        detail: "      // 2. \u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043a\u0430 \u0441\u043f\u0435\u043a\u0442\u0440\u0430\u043b\u044c\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445\n-      const spectralTypes = ['rgb']; // \u0412 \u0431\u0443\u0434\u0443\u0449\u0435\u043c: ['rgb', 'ndvi', 'infrared', 'vari']\n-      const spectralImages: string[] = [];\n-\n-      // 3. \u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u0442\u0430\u0439\u043b\u043e\u0432 \u0432 S3 \u0434\u043b\u044f \u043a\u0430\u0436\u0434\u043e\u0433\u043e \u0441\u043f\u0435\u043a\u0442\u0440\u0430\n+      const droneMetadata = await this.prisma.fieldDroneMetadata.findUnique({\n+        where: { id: droneMetadataId },\n+      });\n+\n+      const params = (droneMetadata.parameters as Record<string, any>) || {};\n+      const spectralTypes: string[] = (params.spectralTypes || ['RGB']).map(\n+        (t: string) => t.toLowerCase(),\n+      );\n+\n+      // \u0413\u0430\u0440\u0430\u043d\u0442\u0438\u0440\u0443\u0435\u043c \u0447\u0442\u043e RGB \u0432\u0441\u0435\u0433\u0434\u0430 \u043f\u0435\u0440\u0432\u044b\u0439\n+      if (!spectralTypes.includes('rgb')) {\n+        spectralTypes.unshift('rgb');\n+      }",
      },
      {
        tool: 'bash',
        target: 'python3 -c "import rasterio; print(rasterio.__version__)"',
        result: '\u2713 success',
        detail: "1.5.0",
      },
    ],
    content:
      'Реализовано: Python-скрипт calculate_spectral.py (8 индексов, windowed reads), два новых метода в image-processing.service.ts, замена хардкода spectralTypes на динамическое чтение из БД, фикс closure-бага в FieldDroneCreator.tsx.',
  },

  // Turn 2 — Debug: WebSocket progress stuck at 5%
  {
    kind: 'message',
    id: 'u2',
    role: 'user',
    time: '20:14',
    content:
      'Влоги идут, но почему-то в Progressive у меня до сих пор вот такая штука в WebSocket отображается. Проверь, как работает Progressive. Прогресс: 5%, Статус: Загружаем данные...',
  },
  {
    kind: 'message',
    id: 'a2',
    role: 'assistant',
    time: '20:14',
    duration: '4м 55с',
    steps: [
      {
        tool: 'thinking',
        target: 'Прогресс застрял на 5% с "Загружаем данные..." \u2014 нужно трассировать WebSocket цепочку...',
        detail: 'The user is saying that the processing is running but the WebSocket progress is stuck at 5% with "Загружаем данные..." message. The logs show the download is happening (50 MB downloaded), but the progress isn\'t being updated properly via WebSocket.\n\nThe issue might be that the WebSocket progress messages aren\'t getting through, or the frontend is using stale defaults instead of actual data from the backend.',
      },
      {
        tool: 'read',
        target: 'drone-monitoring.service.ts',
        result: '245 строк',
      },
      {
        tool: 'read',
        target: 'drone-progress.gateway.ts',
        result: '89 строк',
      },
      {
        tool: 'grep',
        target: '"Загружаем данные"',
        result: '0 совпадений',
        detail: "(no results found in backend codebase)",
      },
      {
        tool: 'thinking',
        target: '"Загружаем данные..." НЕ найдена в бэкенде! Значит это дефолт на фронтенде...',
        detail: 'Hmm, "Загружаем данные..." is NOT found anywhere in the codebase! So this must be coming from the frontend as a default or initial value. Let me search more broadly.',
      },
      {
        tool: 'grep',
        target: '"Загружаем" в agrofield_front/',
        result: '7 совпадений',
        detail: "agrofield_front/src/shared/lib/hooks/useDroneWebSocket.ts:20:        stage: '\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u0434\u0430\u043d\u043d\u044b\u0435...',\nagrofield_front/src/features/drone-operations/ui/FieldDroneRetry.tsx:220:                console.log('\ud83d\udccd \u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c GCP \u0444\u0430\u0439\u043b:', gcpFile.name);\nagrofield_front/src/shared/model/uiSlice.ts:8:// \u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u043d\u0430\u0447\u0430\u043b\u044c\u043d\u043e\u0435 \u0441\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435 \u0438\u0437 localStorage\nagrofield_front/src/features/fullscreen-viewers/ui/SentinelFullscreenModal.tsx:647:        // \u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435 \u043d\u0430 \u043a\u0430\u0440\u0442\u0443\nagrofield_front/src/shared/ui/crop-select.tsx:28:  // \u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u043a\u0443\u043b\u044c\u0442\u0443\u0440\u044b \u0438\u0437 API",
      },
      {
        tool: 'read',
        target: 'useDroneWebSocket.ts',
        result: '72 строки',
        detail: "import { useEffect, useRef, useState } from 'react';\nimport { io, Socket } from 'socket.io-client';\nimport config from '@/shared/lib/config';\nconst WEBSOCKET_URL = config.WEBSOCKET_URL || '';\n\ninterface DroneProgressData {\n    progress: number;\n    stage: string;\n}\n\ninterface UseDroneWebSocketOptions {\n    onStatusUpdate?: (data: any) => void;\n    onComplete?: (data: any) => void;\n    onConnectionError?: (error: any) => void;\n}\n\nexport function useDroneWebSocket(droneMetadataId: string, options?: UseDroneWebSocketOptions) {\n    const [progressData, setProgressData] = useState<DroneProgressData>({\n        progress: 0,\n        stage: '\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u0434\u0430\u043d\u043d\u044b\u0435...',",
      },
      {
        tool: 'read',
        target: 'DroneFullProgress.tsx',
        result: '103 строки',
        detail: "// DroneFullProgress.tsx\nimport React, { useState, useEffect } from 'react';\nimport { ProcessingStatus } from '@/shared/types/drone';\nimport { ProgressLoader } from '@/features/upload-progress/ui/ProgressLoader';\nimport { useDroneWebSocket } from '@/shared/lib/hooks/useDroneWebSocket';\nimport { useGetWebSocketProgressQuery } from '@/entities/field/api/droneApi';\n\ninterface DroneFullProgressProps {\n    droneMetadataId: string;\n    onStatusChange?: (status: ProcessingStatus) => void;\n    onComplete?: () => void;\n    className?: string;\n    showOnlyWhenProcessing?: boolean;\n}",
      },
      {
        tool: 'thinking',
        target: 'Нашёл баг! progressData.stage всегда "Загружаем данные..." (truthy) \u2014 fallback на DB не срабатывает',
        detail: 'Now I understand the full picture:\n\n1. WebSocket default: useDroneWebSocket starts with { progress: 0, stage: \'Загружаем данные...\' }\n2. DroneFullProgress line 78: currentStage = progressData.stage || ...fallback...\n\nThe bug: progressData.stage is ALWAYS "Загружаем данные..." (truthy string), so the fallback to DB status NEVER executes. The progress logic has the same problem \u2014 it only checks > 0, but WebSocket starts at 0, so it immediately falls back to DB. But stage doesn\'t.',
      },
      {
        tool: 'edit',
        target: 'DroneFullProgress.tsx',
        result: '+5 \u22122',
        detail: "-    const currentProgress = progressData.progress > 0 ? progressData.progress : !isLoadingStatusFromDB ? droneStatusFromDB?.progress || 0 : 0;\n-\n-    const currentStage = progressData.stage || (!isLoadingStatusFromDB ? droneStatusFromDB?.stage || '\u041e\u0436\u0438\u0434\u0430\u043d\u0438\u0435...' : '\u041e\u0436\u0438\u0434\u0430\u043d\u0438\u0435...');\n+    // WebSocket \u0434\u043e\u0441\u0442\u0430\u0432\u0438\u043b \u0440\u0435\u0430\u043b\u044c\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u0442\u043e\u043b\u044c\u043a\u043e \u0435\u0441\u043b\u0438 progress > 0\n+    const wsHasData = progressData.progress > 0;\n+    const dbProgress = !isLoadingStatusFromDB ? droneStatusFromDB?.progress || 0 : 0;\n+    const dbStage = !isLoadingStatusFromDB ? droneStatusFromDB?.stage || '\u041e\u0436\u0438\u0434\u0430\u043d\u0438\u0435...' : '\u041e\u0436\u0438\u0434\u0430\u043d\u0438\u0435...';\n+\n+    const currentProgress = wsHasData ? progressData.progress : dbProgress;\n+    const currentStage = wsHasData ? progressData.stage : dbStage;",
      },
    ],
    content:
      'Нашёл баг. progressData.stage всегда равен "Загружаем данные..." (начальное значение хука) \u2014 это truthy строка, поэтому fallback на droneStatusFromDB?.stage никогда не срабатывал. Фикс: синхронизировал логику stage с progress через флаг wsHasData.',
  },

  // Compact separator
  {
    kind: 'separator',
    id: 'sep-1',
    type: 'compact',
    label: '/compact \u2014 18.7k токенов',
  },

  // Turn 3 — Short follow-up (streaming)
  {
    kind: 'message',
    id: 'u3',
    role: 'user',
    time: '20:20',
    content:
      'Обнови документацию drone-processing.md \u2014 добавь таблицу поддерживаемых спектральных индексов.',
  },
  {
    kind: 'message',
    id: 'a3',
    role: 'assistant',
    time: '20:20',
    isStreaming: true,
    steps: [
      {
        tool: 'read',
        target: 'docs/features/drone-processing.md',
        result: '156 строк',
      },
      { tool: 'edit', target: 'docs/features/drone-processing.md', isLoading: true },
    ],
    content:
      'Обновляю документацию \u2014 добавляю таблицу индексов с формулами и band mapping для Micasense...',
  },

  // Plan separator
  {
    kind: 'separator',
    id: 'sep-3',
    type: 'plan',
    label: 'ПЛАН (Clear Context)',
  },

  // Turn 4 — After plan, short turn
  {
    kind: 'message',
    id: 'u4',
    role: 'user',
    time: '20:25',
    content: 'Проверь что rasterio корректно установлен и скрипт парсится без ошибок.',
  },
  {
    kind: 'message',
    id: 'a4',
    role: 'assistant',
    time: '20:25',
    duration: '0м 35с',
    steps: [
      {
        tool: 'bash',
        target: 'python3 -c "import rasterio; print(rasterio.__version__)"',
        result: '\u2713 success',
        detail: "1.5.0",
      },
      {
        tool: 'bash',
        target: 'python3 scripts/calculate_spectral.py --help',
        result: '\u2713 success',
        detail: "usage: calculate_spectral.py [-h] --index INDEX input output\n\nCalculate spectral index from multispectral GeoTIFF.\n\npositional arguments:\n  input          Input multispectral GeoTIFF path\n  output         Output single-band GeoTIFF path\n\noptions:\n  -h, --help     show this help message and exit\n  --index INDEX  Spectral index: NDVI, VARI, INFRARED, RED, NDRE, GNDVI, SAVI, EVI",
      },
    ],
    content:
      'rasterio 1.5.0 установлен, скрипт парсится без ошибок. --help выводит все 8 поддерживаемых индексов.',
  },
];

// ─── Tool Config ─────────────────────────────────────────────────

const TOOL_CONFIG: Record<
  Step['tool'],
  {
    icon: React.ReactNode;
    color: string;
    label: string;
  }
> = {
  read: {
    icon: <FileText size={12} />,
    color: '#8b9eb3',
    label: 'Read',
  },
  edit: {
    icon: <Pencil size={12} />,
    color: '#e5a93d',
    label: 'Edit',
  },
  bash: {
    icon: <TermIcon size={12} />,
    color: '#4ade80',
    label: 'Bash',
  },
  write: {
    icon: <FileOutput size={12} />,
    color: '#60a5fa',
    label: 'Write',
  },
  grep: {
    icon: <Search size={12} />,
    color: '#8b9eb3',
    label: 'Grep',
  },
  glob: {
    icon: <Search size={12} />,
    color: '#8b9eb3',
    label: 'Glob',
  },
  thinking: {
    icon: <Brain size={12} />,
    color: '#555555',
    label: 'Thinking',
  },
};

// ─── Step Detail Panel Component ─────────────────────────────────

function StepDetailPanel({ step }: { step: Step }) {
  if (!step.detail) return null;

  const config = TOOL_CONFIG[step.tool];
  const isThinking = step.tool === 'thinking';
  const isEdit = step.tool === 'edit';
  const isCode = !isThinking; // read, edit, bash, write, grep, glob

  const renderDiffLine = (line: string, idx: number) => {
    if (line.startsWith('+')) {
      return (
        <div
          key={idx}
          style={{
            backgroundColor: 'rgba(74,222,128,0.1)',
            color: '#4ade80',
          }}
          className="px-2"
        >
          {line}
        </div>
      );
    }
    if (line.startsWith('-')) {
      return (
        <div
          key={idx}
          style={{
            backgroundColor: 'rgba(239,68,68,0.1)',
            color: '#f87171',
          }}
          className="px-2"
        >
          {line}
        </div>
      );
    }
    if (line.startsWith('@')) {
      return (
        <div key={idx} style={{ color: '#60a5fa' }} className="px-2">
          {line}
        </div>
      );
    }
    return (
      <div key={idx} style={{ color: '#666' }} className="px-2">
        {line}
      </div>
    );
  };

  const renderReadLines = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, idx) => (
      <div key={idx} className="flex">
        <span
          className="flex-shrink-0 text-right select-none pr-3"
          style={{
            color: 'rgba(255,255,255,0.15)',
            minWidth: '32px',
            userSelect: 'none',
          }}
        >
          {idx + 1}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>{line}</span>
      </div>
    ));
  };

  return (
    <div
      className="ml-6 overflow-hidden"
      style={{
        borderLeft: `2px solid ${config.color}`,
        borderRadius: '0 0 6px 6px',
      }}
    >
      <div
        className="overflow-y-auto"
        style={{
          maxHeight: '200px',
          backgroundColor: isThinking ? '#0a0a0a' : 'rgba(0,0,0,0.3)',
          padding: '12px',
          fontSize: '12px',
          lineHeight: '1.5',
          fontFamily: isCode ? "'SF Mono', 'Fira Code', 'Consolas', monospace" : 'inherit',
          fontStyle: isThinking ? 'italic' : 'normal',
          color: isThinking ? '#777' : 'rgba(255,255,255,0.5)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {isThinking && step.detail}

        {isEdit && (
          <div style={{ whiteSpace: 'pre', fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace" }}>
            {step.detail.split('\n').map((line, idx) => renderDiffLine(line, idx))}
          </div>
        )}

        {(step.tool === 'read' || step.tool === 'write') && (
          <div style={{ whiteSpace: 'pre', fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace" }}>
            {renderReadLines(step.detail)}
          </div>
        )}

        {(step.tool === 'bash') && (
          <div style={{ whiteSpace: 'pre', fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace", color: 'rgba(255,255,255,0.45)' }}>
            {step.detail}
          </div>
        )}

        {(step.tool === 'grep' || step.tool === 'glob') && (
          <div style={{ whiteSpace: 'pre', fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace", color: 'rgba(255,255,255,0.45)' }}>
            {step.detail}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step Row Component ──────────────────────────────────────────

function StepRow({ step, isLast, isStreaming, defaultOpen }: { step: Step; isLast: boolean; isStreaming?: boolean; defaultOpen?: boolean }) {
  const [detailExpanded, setDetailExpanded] = useState(defaultOpen ?? false);
  const config = TOOL_CONFIG[step.tool];
  const isThinking = step.tool === 'thinking';
  const showSpinner = isLast && isStreaming && step.isLoading;
  const hasDetail = !!step.detail;

  const handleClick = () => {
    if (hasDetail) {
      setDetailExpanded(!detailExpanded);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-[5px] px-2.5 group/step ${hasDetail ? 'cursor-pointer hover:bg-white/[0.02]' : ''}`}
        style={{
          opacity: isThinking ? 0.5 : 0.85,
          transition: 'background-color 150ms',
        }}
        onClick={handleClick}
      >
        {/* Icon */}
        <span
          className="flex-shrink-0 flex items-center justify-center w-[18px] h-[18px] rounded"
          style={{
            color: config.color,
            backgroundColor: `${config.color}12`,
          }}
        >
          {showSpinner ? (
            <Loader size={12} className="animate-spin" style={{ color: config.color }} />
          ) : (
            config.icon
          )}
        </span>

        {/* Tool name */}
        <span
          className="flex-shrink-0 font-semibold"
          style={{
            fontSize: '12px',
            color: config.color,
            minWidth: isThinking ? 'auto' : '36px',
          }}
        >
          {config.label}
        </span>

        {/* Target */}
        <span
          className="truncate"
          style={{
            fontSize: '12px',
            color: isThinking ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)',
            fontStyle: isThinking ? 'italic' : 'normal',
          }}
          title={step.target}
        >
          {isThinking
            ? step.target.length > 50
              ? step.target.slice(0, 50) + '...'
              : step.target
            : step.target}
        </span>

        {/* Result */}
        {step.result && (
          <span
            className="flex-shrink-0 ml-auto text-right"
            style={{
              fontSize: '11px',
              color: 'rgba(255,255,255,0.25)',
            }}
          >
            {step.result}
          </span>
        )}

        {/* Loading indicator for last step */}
        {showSpinner && !step.result && (
          <span className="flex-shrink-0 ml-auto flex items-center gap-1" style={{ fontSize: '11px', color: '#60a5fa' }}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          </span>
        )}

        {/* Chevron for expandable detail */}
        {hasDetail && (
          <span
            className="flex-shrink-0 flex items-center"
            style={{ color: 'rgba(255,255,255,0.15)', marginLeft: step.result || (showSpinner && !step.result) ? '8px' : 'auto' }}
          >
            {detailExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </div>

      {/* Expanded detail panel */}
      {detailExpanded && hasDetail && <StepDetailPanel step={step} />}
    </div>
  );
}

// ─── Collapsed Steps Summary ─────────────────────────────────────

function StepsCollapsedSummary({ steps }: { steps: Step[] }) {
  // Count non-thinking tools
  const toolCounts: Partial<Record<Step['tool'], number>> = {};
  for (const s of steps) {
    if (s.tool === 'thinking') continue;
    toolCounts[s.tool] = (toolCounts[s.tool] || 0) + 1;
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {Object.entries(toolCounts).map(([tool, count]) => {
        const config = TOOL_CONFIG[tool as Step['tool']];
        return (
          <span
            key={tool}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded"
            style={{
              fontSize: '11px',
              color: config.color,
              backgroundColor: `${config.color}12`,
            }}
          >
            {config.icon}
            <span className="font-medium">
              {config.label}{(count as number) > 1 ? ` \u00d7${count}` : ''}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// ─── Steps Block Component ───────────────────────────────────────

function StepsBlock({
  steps,
  isExpanded,
  onToggle,
  isStreaming,
  defaultOpenSteps,
}: {
  steps: Step[];
  isExpanded: boolean;
  onToggle: () => void;
  isStreaming?: boolean;
  defaultOpenSteps?: boolean;
}) {
  const nonThinkingCount = steps.filter((s) => s.tool !== 'thinking').length;

  return (
    <div
      className="rounded-md mt-2 mb-2 overflow-hidden"
      style={{
        backgroundColor: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-2.5 py-[6px] cursor-pointer hover:bg-white/[0.02] transition-colors"
        style={{ fontSize: '11px' }}
      >
        <span className="text-white/25 flex-shrink-0">
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className="font-medium text-white/35 flex-shrink-0">
          Шаги ({nonThinkingCount})
        </span>

        {/* Collapsed inline summary */}
        {!isExpanded && (
          <span className="ml-1">
            <StepsCollapsedSummary steps={steps} />
          </span>
        )}

        {isStreaming && (
          <span className="ml-auto flex items-center gap-1.5 text-blue-400">
            <Loader size={11} className="animate-spin" />
          </span>
        )}
      </button>

      {/* Expanded steps list */}
      {isExpanded && (
        <div
          className="border-t"
          style={{ borderColor: 'rgba(255,255,255,0.04)' }}
        >
          {steps.map((step, i) => (
            <StepRow
              key={i}
              step={step}
              isLast={i === steps.length - 1}
              isStreaming={isStreaming}
              defaultOpen={defaultOpenSteps && (step.tool === 'edit' || step.tool === 'write')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── User Message Component ──────────────────────────────────────

function UserMessageCard({ msg }: { msg: UserMessage }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="group px-4 py-3.5"
      style={{ backgroundColor: 'rgba(255,255,255,0.025)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="text-[12px] font-semibold tracking-wide"
          style={{ color: '#c8d0da' }}
        >
          ТЫ
        </span>
        <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.2)' }}>
          {msg.time}
        </span>
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/10 text-white/25 hover:text-white/60 cursor-pointer ml-auto"
          title="Копировать"
        >
          {copied ? (
            <Check size={13} className="text-green-400" />
          ) : (
            <Copy size={13} />
          )}
        </button>
      </div>

      {/* Content */}
      <div
        className="text-[13px] leading-[1.6]"
        style={{ color: 'rgba(255,255,255,0.9)' }}
      >
        {msg.content}
      </div>
    </div>
  );
}

// ─── Assistant Message Component ─────────────────────────────────

function AssistantMessageCard({
  msg,
  defaultExpanded,
  isFirst,
}: {
  msg: AssistantMessage;
  defaultExpanded: boolean;
  isFirst?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group px-4 py-3.5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span
          className="text-[12px] font-semibold tracking-wide"
          style={{ color: '#a78bfa' }}
        >
          CLAUDE
        </span>
        <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.2)' }}>
          {msg.time}
        </span>

        {msg.isStreaming && (
          <span className="flex items-center gap-1.5 text-[11px] text-blue-400">
            <Loader size={11} className="animate-spin" />
            <span>работает...</span>
          </span>
        )}

        {msg.duration && (
          <span
            className="text-[11px] ml-auto"
            style={{ color: 'rgba(255,255,255,0.15)' }}
          >
            {msg.duration}
          </span>
        )}

        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/10 text-white/25 hover:text-white/60 cursor-pointer ml-auto"
          title="Копировать"
        >
          {copied ? (
            <Check size={13} className="text-green-400" />
          ) : (
            <Copy size={13} />
          )}
        </button>
      </div>

      {/* Steps block */}
      {msg.steps.length > 0 && (
        <StepsBlock
          steps={msg.steps}
          isExpanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          isStreaming={msg.isStreaming}
          defaultOpenSteps={isFirst}
        />
      )}

      {/* Final text content */}
      <div
        className="text-[13px] leading-[1.6] mt-1"
        style={{ color: 'rgba(255,255,255,0.75)' }}
      >
        {msg.content}
        {msg.isStreaming && (
          <span
            className="inline-block w-[2px] h-[14px] ml-0.5 align-text-bottom animate-pulse"
            style={{ backgroundColor: '#a78bfa' }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Separator Component ─────────────────────────────────────────

const SEPARATOR_CONFIG = {
  compact: {
    border: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.05)',
    text: '#f59e0b',
    icon: <Zap size={13} />,
  },
  fork: {
    border: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.05)',
    text: '#3b82f6',
    icon: <GitFork size={13} />,
  },
  plan: {
    border: '#48968c',
    bg: 'rgba(72, 150, 140, 0.05)',
    text: '#48968c',
    icon: <Brain size={13} />,
  },
};

function SeparatorLine({ type, label }: { type: Separator['type']; label: string }) {
  const c = SEPARATOR_CONFIG[type];

  return (
    <div
      className="flex items-center gap-3 py-3 px-4 my-0.5"
      style={{ backgroundColor: c.bg }}
    >
      <div
        className="flex-1 h-[1px]"
        style={{ backgroundColor: c.border, opacity: 0.3 }}
      />
      <div
        className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider whitespace-nowrap"
        style={{ color: c.text }}
      >
        {c.icon}
        {label}
      </div>
      <div
        className="flex-1 h-[1px]"
        style={{ backgroundColor: c.border, opacity: 0.3 }}
      />
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export default function ChatHistory() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Track which assistant message index we're on (for default expand logic)
  let assistantIndex = 0;

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowScrollDown(scrollTop < scrollHeight - clientHeight - 100);
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  };

  const messageCount = MOCK_ENTRIES.filter((e) => e.kind === 'message').length;

  return (
    <div
      className="flex h-screen bg-[#0A0A0A] text-[#E0E0E0]"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
    >
      {/* ──── Left: Terminal placeholder ──── */}
      <div className="flex-1 flex flex-col bg-[#0D0D0D] border-r border-[#1A1A1A] min-w-0">
        {/* Terminal header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#1A1A1A] flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
            <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <div className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>
          <span className="text-[11px] text-[#444] font-mono ml-2">
            zsh {'\u2014'} ~/vs-code/agrotech/uav
          </span>
        </div>

        {/* Terminal body */}
        <div className="flex-1 p-4 overflow-y-auto text-[13px] leading-relaxed font-mono">
          <div className="text-green-500/60 mb-1">
            <span className="text-blue-400/40">~/vs-code/agrotech/uav</span>{' '}
            <span className="text-green-500/60">{'>'}</span>{' '}
            <span className="text-white/40">claude</span>
          </div>
          <div className="text-[#333] mt-2 mb-1">
            {'\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E'}
          </div>
          <div className="text-[#444]">
            {'\u2502'}{'  '}
            <span className="text-purple-400/60">Claude Code</span>{' '}
            <span className="text-white/20">v2.1.0</span>
            {'  (opus-4)     \u2502'}
          </div>
          <div className="text-[#333] mb-3">
            {'\u256E\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F'}
          </div>

          <div className="mt-3 text-white/40">
            <span className="text-white/20">{'>'}</span> Implement plan: Постобработка мультиспектральных TIFF
          </div>
          <div className="mt-3 space-y-0.5">
            <div className="text-[#555]">
              <span className="text-blue-400/40">{'\u25CF'}</span> Reading drone-queue.processor.ts...
            </div>
            <div className="text-[#555]">
              <span className="text-blue-400/40">{'\u25CF'}</span> Writing calculate_spectral.py...
            </div>
            <div className="text-[#555]">
              <span className="text-yellow-400/40">{'\u25CF'}</span> Editing image-processing.service.ts...
            </div>
            <div className="text-[#555]">
              <span className="text-yellow-400/40">{'\u25CF'}</span> Editing drone-queue.processor.ts...
            </div>
            <div className="text-[#555]">
              <span className="text-green-400/40">{'\u25CF'}</span> Running python3 -c "import rasterio"...
            </div>
          </div>
          <div className="mt-3 text-white/25 text-[12px]">
            Python-скрипт + 2 метода в сервисе + замена хардкода spectralTypes.
          </div>

          <div className="mt-5 text-white/40">
            <span className="text-white/20">{'>'}</span> Прогресс застрял на 5%. Проверь WebSocket
          </div>
          <div className="mt-3 space-y-0.5">
            <div className="text-[#555]">
              <span className="text-[#8b9eb3]/40">{'\u25CF'}</span> Grep: "Загружаем данные" (0 matches)
            </div>
            <div className="text-[#555]">
              <span className="text-[#8b9eb3]/40">{'\u25CF'}</span> Grep: "Загружаем" (7 matches)
            </div>
            <div className="text-[#555]">
              <span className="text-blue-400/40">{'\u25CF'}</span> Reading useDroneWebSocket.ts...
            </div>
            <div className="text-[#555]">
              <span className="text-blue-400/40">{'\u25CF'}</span> Reading DroneFullProgress.tsx...
            </div>
            <div className="text-[#555]">
              <span className="text-yellow-400/40">{'\u25CF'}</span> Editing DroneFullProgress.tsx...
            </div>
          </div>
          <div className="mt-3 text-white/25 text-[12px]">
            Баг: stage всегда truthy "Загружаем данные..." — fallback на DB не срабатывал.
          </div>

          <div className="mt-5 text-yellow-500/30 text-[11px]">
            --- /compact ---
          </div>

          <div className="mt-5 text-white/40">
            <span className="text-white/20">{'>'}</span> Обнови документацию drone-processing.md
          </div>
          <div className="mt-3 space-y-0.5">
            <div className="text-[#555]">
              <span className="text-blue-400/40">{'\u25CF'}</span> Reading drone-processing.md...
            </div>
            <div className="text-[#555] flex items-center gap-1.5">
              <span className="text-yellow-400/40">{'\u25CF'}</span> Editing drone-processing.md...
              <Loader size={11} className="animate-spin text-blue-400/40" />
            </div>
          </div>

          {/* Filler lines for scroll */}
          {Array.from({ length: 15 }, (_, i) => (
            <div key={i} className="text-[#1a1a1a] mt-1 text-[11px]">
              ~
            </div>
          ))}
        </div>
      </div>

      {/* ──── Resizer ──── */}
      <div
        className="w-[5px] bg-[#111] hover:bg-blue-500/30 transition-colors cursor-col-resize flex-shrink-0"
        title="Потянуть для изменения ширины"
      />

      {/* ──── Right: Chat History Panel ──── */}
      <div
        className="flex flex-col relative flex-shrink-0"
        style={{ width: '420px', backgroundColor: '#0c0c0c' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[#1A1A1A] flex-shrink-0">
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-[12px] font-medium text-white/50 uppercase tracking-wider">
            История диалога
          </span>
          <span className="text-[11px] text-white/20 ml-auto">
            {messageCount} сообщ.
          </span>
        </div>

        {/* Message list */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto chat-history-scroll"
        >
          <div className="flex flex-col">
            {MOCK_ENTRIES.map((entry, idx) => {
              if (entry.kind === 'separator') {
                return (
                  <SeparatorLine
                    key={entry.id}
                    type={entry.type}
                    label={entry.label}
                  />
                );
              }

              // Add extra spacing before user messages that follow an assistant message (new turn pair)
              const prevEntry = idx > 0 ? MOCK_ENTRIES[idx - 1] : null;
              const isNewTurn =
                entry.role === 'user' &&
                prevEntry &&
                (prevEntry.kind === 'message' && prevEntry.role === 'assistant');

              if (entry.role === 'user') {
                return (
                  <div key={entry.id}>
                    {isNewTurn && (
                      <div
                        className="h-[1px] mx-4 my-2"
                        style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}
                      />
                    )}
                    <UserMessageCard msg={entry as UserMessage} />
                  </div>
                );
              }

              // Assistant message - track index for default expand
              const currentIdx = assistantIndex++;
              const defaultExpanded = currentIdx < 2 || !!(entry as AssistantMessage).isStreaming;

              return (
                <div
                  key={entry.id}
                  className="border-t"
                  style={{ borderColor: 'rgba(255,255,255,0.04)' }}
                >
                  <AssistantMessageCard
                    msg={entry as AssistantMessage}
                    defaultExpanded={defaultExpanded}
                    isFirst={currentIdx === 0}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Scroll to bottom button */}
        {showScrollDown && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-14 right-4 w-8 h-8 rounded-full bg-[#1A1A1A] border border-[#333] flex items-center justify-center text-white/50 hover:text-white hover:border-[#555] transition-all shadow-lg cursor-pointer z-10"
          >
            <ChevronDown size={16} />
          </button>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[#1A1A1A] flex-shrink-0 text-[11px] text-white/20 font-mono">
          <span>opus-4</span>
          <span style={{ color: 'rgba(255,255,255,0.1)' }}>{'\u00B7'}</span>
          <span style={{ color: 'rgba(255,255,255,0.13)' }}>a023-d7ce</span>
          <span className="ml-auto">20:01 {'\u2014'} 20:25</span>
        </div>
      </div>

      {/* Scrollbar styles */}
      <style>{`
        .chat-history-scroll::-webkit-scrollbar {
          width: 4px;
        }
        .chat-history-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .chat-history-scroll::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.06);
          border-radius: 2px;
        }
        .chat-history-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.12);
        }
      `}</style>
    </div>
  );
}
