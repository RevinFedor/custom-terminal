#!/bin/bash

# Playwright Test Runner for Noted Terminal
# Quick shortcuts for common testing scenarios

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Noted Terminal - Playwright Test Runner${NC}\n"

# Function to show menu
show_menu() {
  echo "Choose an option:"
  echo "  1) Run all tests (headless)"
  echo "  2) Run tests with visible browser (headed)"
  echo "  3) Run tests in debug mode (step-by-step)"
  echo "  4) Run specific test file"
  echo "  5) Show last test report"
  echo "  6) Clean test results"
  echo "  0) Exit"
  echo ""
}

# Function to run tests
run_tests() {
  local mode=$1
  echo -e "${YELLOW}Running tests in ${mode} mode...${NC}\n"

  case $mode in
    "headless")
      npx playwright test
      ;;
    "headed")
      npx playwright test --headed
      ;;
    "debug")
      npx playwright test --debug
      ;;
    "specific")
      echo -e "${BLUE}Available test files:${NC}"
      ls -1 tests/*.spec.ts
      echo ""
      read -p "Enter test file name: " testfile
      npx playwright test "tests/${testfile}"
      ;;
  esac

  if [ $? -eq 0 ]; then
    echo -e "\n${GREEN}✅ Tests completed successfully!${NC}"
    echo -e "${BLUE}📊 View detailed report: npm run test:report${NC}"
  else
    echo -e "\n${RED}❌ Some tests failed. Check the report for details.${NC}"
  fi
}

# Function to show report
show_report() {
  echo -e "${BLUE}Opening test report...${NC}"
  npx playwright show-report results/playwright-report
}

# Function to clean results
clean_results() {
  echo -e "${YELLOW}Cleaning test results...${NC}"
  rm -rf results/playwright-report
  rm -rf results/test-artifacts
  rm -f results/*.png
  rm -f results/test-logs.txt
  echo -e "${GREEN}✅ Results cleaned${NC}"
}

# Main loop
while true; do
  show_menu
  read -p "Enter your choice: " choice

  case $choice in
    1)
      run_tests "headless"
      ;;
    2)
      run_tests "headed"
      ;;
    3)
      run_tests "debug"
      ;;
    4)
      run_tests "specific"
      ;;
    5)
      show_report
      ;;
    6)
      clean_results
      ;;
    0)
      echo -e "${GREEN}Bye!${NC}"
      exit 0
      ;;
    *)
      echo -e "${RED}Invalid option. Try again.${NC}\n"
      ;;
  esac

  echo ""
  read -p "Press Enter to continue..."
  echo ""
done
