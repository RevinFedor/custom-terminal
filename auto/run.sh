#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# Noted Terminal Automation Runner
# ═══════════════════════════════════════════════════════════════
#
# Usage:
#   ./run.sh <script>           - Запустить скрипт
#   ./run.sh sandbox/test.js    - Запустить тест из sandbox
#   ./run.sh --kill             - Убить все Electron процессы
#   ./run.sh --help             - Показать справку
#
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_help() {
    echo -e "${CYAN}Noted Terminal Automation Runner${NC}"
    echo ""
    echo "Usage:"
    echo "  ./run.sh <script>           Run a test script"
    echo "  ./run.sh sandbox/test.js    Run a sandbox test"
    echo "  ./run.sh --kill             Kill all Electron processes"
    echo "  ./run.sh --help             Show this help"
    echo ""
    echo "Examples:"
    echo "  ./run.sh sandbox/test-timeline.js"
}

# Check if dev server is running
check_dev_server() {
    if ! curl -s http://localhost:5182 > /dev/null 2>&1; then
        echo -e "${YELLOW}Warning: Dev server not running on :5182${NC}"
        echo -e "Start it with: ${CYAN}npm run dev${NC}"
        exit 1
    fi
    echo -e "${GREEN}Dev server is running${NC}"
}

case "$1" in
    --help|-h)
        print_help
        exit 0
        ;;

    --kill)
        echo -e "${CYAN}Killing Electron processes...${NC}"
        pkill -f "Electron" 2>/dev/null || true
        pkill -f "noted-terminal" 2>/dev/null || true
        echo -e "${GREEN}Done!${NC}"
        exit 0
        ;;

    "")
        print_help
        exit 1
        ;;

    *)
        check_dev_server

        # Resolve script path
        if [[ "$1" == /* ]]; then
            SCRIPT_PATH="$1"
        elif [[ "$1" == sandbox/* ]]; then
            SCRIPT_PATH="$SCRIPT_DIR/$1"
        else
            SCRIPT_PATH="$SCRIPT_DIR/$1"
        fi

        if [[ ! -f "$SCRIPT_PATH" ]]; then
            echo -e "${RED}Error: Script not found: $SCRIPT_PATH${NC}"
            exit 1
        fi

        echo -e "${CYAN}Running: $SCRIPT_PATH${NC}"
        echo ""
        node "$SCRIPT_PATH"
        exit $?
        ;;
esac
