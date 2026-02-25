const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Cache for projects.json (30 second TTL)
let projectsJsonCache = null;
let projectsJsonCacheTime = 0;
const PROJECTS_JSON_CACHE_TTL = 30000;

/**
 * Read and cache ~/.gemini/projects.json
 * @returns {{ projects: Record<string, string> } | null}
 */
function getGeminiProjectsJson() {
  const now = Date.now();
  if (projectsJsonCache && (now - projectsJsonCacheTime) < PROJECTS_JSON_CACHE_TTL) {
    return projectsJsonCache;
  }

  const jsonPath = path.join(os.homedir(), '.gemini', 'projects.json');
  try {
    if (!fs.existsSync(jsonPath)) return null;
    const content = fs.readFileSync(jsonPath, 'utf-8');
    projectsJsonCache = JSON.parse(content);
    projectsJsonCacheTime = now;
    return projectsJsonCache;
  } catch (e) {
    console.error('[gemini-utils] Error reading projects.json:', e.message);
    return null;
  }
}

/**
 * Calculate legacy SHA256 hash for Gemini project directory
 * @param {string} dirPath
 * @returns {string}
 */
function calculateGeminiHash(dirPath) {
  const normalizedPath = path.resolve(dirPath);
  return crypto.createHash('sha256').update(normalizedPath).digest('hex');
}

/**
 * Resolve Gemini project directory: slug-based (v0.30+) with hash fallback (legacy)
 *
 * 1. Reads ~/.gemini/projects.json, finds cwd → slug
 * 2. Checks ~/.gemini/tmp/<slug>/chats/
 * 3. Fallback: SHA256 hash → ~/.gemini/tmp/<hash>/chats/
 * 4. Returns null if nothing found
 *
 * @param {string} cwd - Working directory
 * @returns {{ chatsDir: string, projectDir: string, method: 'slug' | 'hash' } | null}
 */
function resolveGeminiProjectDir(cwd) {
  const normalizedCwd = path.resolve(cwd || os.homedir());

  // 1. Try slug from projects.json
  const projectsJson = getGeminiProjectsJson();
  if (projectsJson && projectsJson.projects) {
    const slug = projectsJson.projects[normalizedCwd];
    if (slug) {
      const projectDir = path.join(os.homedir(), '.gemini', 'tmp', slug);
      const chatsDir = path.join(projectDir, 'chats');
      if (fs.existsSync(chatsDir)) {
        return { chatsDir, projectDir, method: 'slug' };
      }
    }
  }

  // 2. Fallback: SHA256 hash (legacy Gemini < 0.30)
  const dirHash = calculateGeminiHash(normalizedCwd);
  const hashProjectDir = path.join(os.homedir(), '.gemini', 'tmp', dirHash);
  const hashChatsDir = path.join(hashProjectDir, 'chats');
  if (fs.existsSync(hashChatsDir)) {
    return { chatsDir: hashChatsDir, projectDir: hashProjectDir, method: 'hash' };
  }

  return null;
}

/**
 * Find Gemini session file by sessionId.
 * Uses 8-char suffix prefilter for speed, then parses only matching files.
 * If multiple files match (continuation), picks the one with most messages.
 *
 * @param {string} sessionId - Full UUID or short 8-char ID
 * @param {string} chatsDir - Path to chats directory
 * @returns {{ filePath: string, data: object } | null}
 */
function findGeminiSessionFile(sessionId, chatsDir) {
  if (!sessionId || !chatsDir) return null;

  try {
    if (!fs.existsSync(chatsDir)) return null;

    const files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));

    // Short ID prefilter: last 8 chars of UUID match filename suffix
    const shortId = sessionId.length >= 8 ? sessionId.slice(-8) : sessionId;
    const prefiltered = files.filter(f => f.includes(shortId));

    // Search prefiltered first, then all files as fallback
    const searchOrder = prefiltered.length > 0
      ? [...prefiltered, ...files.filter(f => !prefiltered.includes(f))]
      : files;

    let bestMatch = null;
    let bestMessageCount = -1;

    for (const file of searchOrder) {
      try {
        const filePath = path.join(chatsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);

        if (data.sessionId === sessionId) {
          const msgCount = data.messages ? data.messages.length : 0;
          if (msgCount > bestMessageCount) {
            bestMatch = { filePath, data };
            bestMessageCount = msgCount;
          }
        }
      } catch (e) {
        // Ignore parse errors, continue searching
      }

      // If we found a match in prefiltered and exhausted prefiltered files, stop
      if (bestMatch && prefiltered.length > 0 && !prefiltered.includes(searchOrder[searchOrder.indexOf(file) + 1])) {
        break;
      }
    }

    return bestMatch;
  } catch (e) {
    console.error('[gemini-utils] Error finding session file:', e.message);
    return null;
  }
}

/**
 * Invalidate the projects.json cache (e.g., after spawning Gemini which may create a new mapping)
 */
function invalidateProjectsJsonCache() {
  projectsJsonCache = null;
  projectsJsonCacheTime = 0;
}

module.exports = {
  resolveGeminiProjectDir,
  findGeminiSessionFile,
  getGeminiProjectsJson,
  calculateGeminiHash,
  invalidateProjectsJsonCache
};
