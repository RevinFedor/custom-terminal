import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const row = fs.readFileSync(path.join(here, '../src/outline/FileOutlineRow.jsx'), 'utf8')

test('rename focuses on actual input mount and selects folder/file names once', () => {
  assert.match(row, /const inputRef = useCallback\(input => \{/)
  assert.match(row, /selectedRenameInputRef\.current === input/)
  assert.match(row, /input\.focus\(\)/)
  assert.match(row, /isFolder \? -1 : input\.value\.lastIndexOf\('\.'\)/)
  assert.match(row, /input\.setSelectionRange\(0, extensionStart\)/)
  assert.match(row, /input\.select\(\)/)
  assert.doesNotMatch(row, /useEffect\(\(\) => \{[\s\S]{0,200}input\.focus/)
})
