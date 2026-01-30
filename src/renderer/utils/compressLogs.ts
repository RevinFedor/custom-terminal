/**
 * Compress logs from clipboard for AI consumption
 * Handles two formats:
 * 1. Grafana logs (with timestamps, stderr duplicates, Fields section)
 * 2. Browser console logs (with stack traces, line numbers)
 */

interface CompressResult {
  success: boolean;
  compressed: string;
  originalLength: number;
  compressedLength: number;
  savings: number;
  message: string;
}

export function compressLogs(input: string): CompressResult {
  const originalLength = input.length;

  if (!input || input.trim().length === 0) {
    return {
      success: false,
      compressed: '',
      originalLength: 0,
      compressedLength: 0,
      savings: 0,
      message: 'Буфер обмена пуст'
    };
  }

  let result = input;

  // Remove clipboard artifacts like [200~
  result = result.replace(/\[\d+~/g, '');

  // Detect format and apply appropriate compression
  const isGrafanaFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/m.test(result) ||
                          /^stderr\s*$/m.test(result) ||
                          /^Fields\s*$/m.test(result);

  const isConsoleFormat = /^\w+\.(tsx?|jsx?|js):\d+/m.test(result) ||
                          /@ \w+\.(tsx?|jsx?|js).*:\d+/m.test(result) ||
                          /WebSocket connection to/i.test(result);

  if (isGrafanaFormat) {
    result = compressGrafanaLogs(result);
  } else if (isConsoleFormat) {
    result = compressConsoleLogs(result);
  } else {
    // Generic compression
    result = compressGeneric(result);
  }

  // Final cleanup
  result = finalCleanup(result);

  const compressedLength = result.length;
  const savings = originalLength - compressedLength;

  if (savings <= 0) {
    return {
      success: false,
      compressed: input,
      originalLength,
      compressedLength: originalLength,
      savings: 0,
      message: 'Логи не найдены или уже сжаты'
    };
  }

  return {
    success: true,
    compressed: result,
    originalLength,
    compressedLength,
    savings,
    message: `Сжато: ${originalLength} → ${compressedLength} (−${savings} символов, ${Math.round((savings / originalLength) * 100)}%)`
  };
}

function compressGrafanaLogs(input: string): string {
  const lines = input.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];

  let skipUntilTimestamp = false;
  let inFieldsSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip Fields section entirely
    if (trimmed === 'Fields') {
      inFieldsSection = true;
      continue;
    }

    // End of Fields section (next timestamp)
    if (inFieldsSection && /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      inFieldsSection = false;
    }

    if (inFieldsSection) {
      continue;
    }

    // Skip standalone "stderr" lines
    if (trimmed === 'stderr') {
      skipUntilTimestamp = true;
      continue;
    }

    // Skip lines that start with "stderr " (duplicate of previous log)
    if (trimmed.startsWith('stderr ')) {
      continue;
    }

    // Skip field key-value pairs (like "compose_project    \nhh-tool")
    if (/^[a-z_]+\s*$/.test(trimmed) && i + 1 < lines.length) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && !nextLine.includes(':') && !/^\d{4}-\d{2}-\d{2}/.test(nextLine)) {
        i++; // Skip next line too
        continue;
      }
    }

    // After stderr, skip until next timestamp
    if (skipUntilTimestamp) {
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        skipUntilTimestamp = false;
      } else {
        continue;
      }
    }

    // Extract just the message part from timestamp lines
    const timestampMatch = trimmed.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+(.+)$/);
    if (timestampMatch) {
      const message = timestampMatch[1];
      // Deduplicate messages
      if (!seen.has(message)) {
        seen.add(message);
        result.push(message);
      }
      continue;
    }

    // Keep other non-empty lines
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result.join('\n');
}

function compressConsoleLogs(input: string): string {
  const lines = input.split('\n');
  const result: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Skip stack trace lines (@ symbol followed by file:line)
    if (/^[@\s]/.test(trimmed) && /\.(tsx?|jsx?|js).*:\d+/.test(trimmed)) {
      continue;
    }

    // Skip function call stack lines
    if (/^\w+\s+@\s+/.test(trimmed)) {
      continue;
    }

    // Skip internal function names from stack traces
    if (/^(createSocket|doOpen|open|_open|SocketWithUpgrade|Socket|Emitter\.emit|onerror|onError|_onError|onClose)\s*@?\s*/.test(trimmed)) {
      continue;
    }

    // Skip anonymous function markers
    if (/^\(анонимная\)/.test(trimmed) || /^\(anonymous\)/.test(trimmed)) {
      continue;
    }

    // Clean up console log format: "File.tsx:123 [Tag] message" -> "[Tag] message"
    let cleaned = trimmed.replace(/^[\w./]+\.(tsx?|jsx?|js):\d+\s+/, '');

    // Remove duplicate object dumps like {searchData: null, ...}
    cleaned = cleaned.replace(/\{[^}]+,\s*…\}/g, '{...}');

    // Deduplicate
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }

  return result.join('\n');
}

function compressGeneric(input: string): string {
  const lines = input.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result.join('\n');
}

function finalCleanup(input: string): string {
  return input
    // Remove multiple empty lines
    .replace(/\n{3,}/g, '\n\n')
    // Remove timing info like +322ms, +13s, +1m at the end of lines
    .replace(/\s+\+\d+m?s?\s*$/gm, '')
    // Trim
    .trim();
}
