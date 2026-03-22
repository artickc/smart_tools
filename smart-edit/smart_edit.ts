/**
 * Smart Edit Tool v6.0 - Universal File & Folder Operations
 * 
 * One tool for ALL file system write operations:
 * - Create new files with content
 * - Create directories (nested)
 * - Edit existing files (single/multi-edit)
 * - Insert content after/before anchor text
 * - Delete files and folders
 * - Batch operations across multiple files
 * 
 * Features:
 * - Parallel I/O for multi-file operations
 * - Atomic per-file (all edits succeed or file unchanged)
 * - Rich error context for AI self-correction
 * - Fuzzy matching suggestions on failure
 * - Auto-creates parent directories
 * - Context preview after successful edits
 * - Safe delete (moves to trash, not permanent)
 */
import { tool } from "@opencode-ai/plugin"
import * as Diff from "diff"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import trash from "trash"

const DESCRIPTION = `Universal file operations tool - create, edit, and organize files.

MODES (detected automatically based on parameters):

1. CREATE FILE - New file with content:
   { filePath: "src/new.ts", content: "// new file content" }

2. CREATE DIRECTORY - Create folder(s):
   { directory: "src/components/ui" }
   { directories: ["src/models", "src/views", "src/services"] }

3. SIMPLE EDIT - Single replacement in existing file:
   { filePath: "app.ts", oldString: "old", newString: "new" }

4. MULTI-EDIT - Multiple replacements in one file:
   { filePath: "app.ts", edits: [
       { oldString: "old1", newString: "new1" },
       { oldString: "old2", newString: "new2" }
   ]}

5. BATCH - Operations across multiple files:
   { files: [
       { filePath: "a.ts", content: "new file" },
       { filePath: "b.ts", edits: [{ oldString: "x", newString: "y" }] }
   ]}

OPTIONS:
- dryRun: Preview changes without writing
- createParentDirs: Auto-create parent directories (default: true)
- overwrite: Allow overwriting existing files in create mode (default: false)
- showContext: Show context lines around edit location (default: 3)
- fuzzyMatch: Ignore whitespace differences when matching (default: false)

6. INSERT AFTER - Add content after anchor:
   { filePath: "app.ts", insertAfter: "// END IMPORTS", content: "import x;" }

7. INSERT BEFORE - Add content before anchor:
   { filePath: "app.ts", insertBefore: "export default", content: "// Component" }

8. DELETE FILE - Move a single file to trash:
   { delete: "src/old-file.ts" }

9. DELETE DIRECTORY - Move a folder to trash:
   { delete: "src/old-folder" }

10. BATCH DELETE - Move multiple files/folders to trash:
    { deleteItems: ["file1.ts", "folder1", "file2.js"] }

11. INSERT AT LINE/COL - Insert at a specific cursor position (VS Code Ln/Col style):
    { filePath: "app.ts", lineNumber: 93, col: 24, content: "text" }   // inline at column
    { filePath: "app.ts", lineNumber: 93, content: "// new line" }      // new line(s) before that line`

// ============================================================================
// TYPES
// ============================================================================

interface EditOperation {
  oldString: string
  newString: string
  replaceAll?: boolean
  fuzzyMatch?: boolean
}

interface FileSpec {
  filePath: string
  content?: string        // For creating new files
  edits?: EditOperation[] // For editing existing files
}

interface OperationResult {
  path: string
  operation: 'created' | 'edited' | 'mkdir' | 'skipped' | 'failed' | 'inserted' | 'deleted'
  success: boolean
  message: string
  additions?: number
  deletions?: number
  editCount?: number
  context?: string  // Context preview around the edit
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalize string for fuzzy matching (collapses all whitespace to single spaces)
 */
function normalizeForFuzzyMatch(str: string): string {
  return str.replace(/\s+/g, ' ').trim()
}

/**
 * Show character codes for debugging escape sequences
 */
function showCharCodes(str: string, maxChars: number = 50): string {
  const preview = str.substring(0, maxChars)
  const codes = Array.from(preview).map(c => {
    const code = c.charCodeAt(0)
    if (c === '\\') return '[\\\\]'  // Show backslash clearly
    if (c === '\n') return '[\\n]'
    if (c === '\r') return '[\\r]'
    if (c === '\t') return '[\\t]'
    if (code < 32 || code > 126) return `[\\x${code.toString(16).padStart(2, '0')}]`
    return c
  }).join('')
  return codes + (str.length > maxChars ? '...' : '')
}

function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  
  const getBigrams = (s: string) => {
    const bigrams = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const bigram = s.substring(i, i + 2)
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1)
    }
    return bigrams
  }
  
  const aBigrams = getBigrams(a)
  const bBigrams = getBigrams(b)
  
  let matches = 0
  for (const [bigram, count] of aBigrams) {
    matches += Math.min(count, bBigrams.get(bigram) || 0)
  }
  
  return (2 * matches) / (a.length + b.length - 2)
}

function findSimilarStrings(content: string, target: string, maxSuggestions = 2): string[] {
  const targetLines = target.split('\n')
  const contentLines = content.split('\n')
  const suggestions: { text: string; score: number; lineNum: number }[] = []
  
  const firstTargetLine = targetLines.find(l => l.trim().length > 0)?.trim() || ''
  if (!firstTargetLine) return []
  
  // Search for similar blocks in the content
  for (let i = 0; i < contentLines.length; i++) {
    const trimmed = contentLines[i].trim()
    
    // Check if this line might be the start of a similar block
    if (trimmed.length > 10 && (
        trimmed.includes(firstTargetLine.substring(0, Math.min(20, firstTargetLine.length))) ||
        firstTargetLine.includes(trimmed.substring(0, Math.min(20, trimmed.length))))) {
      
      // Extract a context window of similar size to target
      const contextEnd = Math.min(i + targetLines.length + 2, contentLines.length)
      const context = contentLines.slice(i, contextEnd).join('\n')
      const score = stringSimilarity(target, context)
      
      if (score > 0.3) {
        suggestions.push({ text: context, score, lineNum: i + 1 })
      }
    }
  }
  
  // Return top suggestions with proper formatting
  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map(s => {
      const lines = s.text.split('\n').slice(0, 5)
      const formatted = lines.map(line => {
        // Escape backslashes for display
        const escaped = line.replace(/\\/g, '\\\\')
        return escaped.length > 80 ? escaped.substring(0, 77) + '...' : escaped
      }).join('\n')
      return `[Line ${s.lineNum}] (${Math.round(s.score * 100)}% match):\n${formatted}`
    })
}

function buildErrorMessage(
  filePath: string,
  oldString: string,
  content: string,
  editIndex: number,
  fuzzyMatch: boolean = false
): string {
  const fileName = path.basename(filePath)
  const lines: string[] = []
  
  lines.push(`❌ ${fileName} - Edit #${editIndex + 1} FAILED`)
  lines.push(``)
  
  const oldLines = oldString.split('\n')
  lines.push(`🔍 Searched for (${oldLines.length} lines):`)
  const preview = oldLines.slice(0, 5).map(l => `  │ ${l.substring(0, 60)}${l.length > 60 ? '...' : ''}`).join('\n')
  lines.push(preview)
  if (oldLines.length > 5) lines.push(`  │ ... +${oldLines.length - 5} more lines`)
  
  lines.push(``)
  
  // Show character codes for first line to help debug escaping issues
  if (oldLines[0]) {
    lines.push(`🔬 First line char codes: ${showCharCodes(oldLines[0], 80)}`)
    lines.push(``)
  }
  
  // Diagnostics
  const normalizedOld = oldString.replace(/\s+/g, ' ').trim()
  const normalizedContent = content.replace(/\s+/g, ' ')
  
  if (normalizedContent.includes(normalizedOld)) {
    lines.push(`⚠️  WHITESPACE ISSUE: Content exists but whitespace differs`)
    lines.push(`💡 TIP: Use fuzzyMatch: true to ignore whitespace differences`)
  } else if (content.toLowerCase().includes(oldString.toLowerCase())) {
    lines.push(`⚠️  CASE ISSUE: Content exists with different casing`)
  } else {
    const firstLine = oldLines[0]?.trim()
    if (firstLine && content.includes(firstLine)) {
      const idx = content.indexOf(firstLine)
      const lineNum = content.substring(0, idx).split('\n').length
      lines.push(`⚠️  PARTIAL MATCH: First line found at line ${lineNum}, but full block differs`)
    }
  }
  
  if (fuzzyMatch) {
    lines.push(`ℹ️  Fuzzy match mode: ON (whitespace normalized)`)
  }
  
  // Similar content
  const suggestions = findSimilarStrings(content, oldString, 1)
  if (suggestions.length > 0) {
    lines.push(``)
    lines.push(`💡 Did you mean:`)
    lines.push(suggestions[0])
  }
  
  // File preview
  const contentLines = content.split('\n')
  lines.push(``)
  lines.push(`📄 FILE PREVIEW (first 20 lines):`)
  for (let i = 0; i < Math.min(20, contentLines.length); i++) {
    const lineNum = String(i + 1).padStart(4, ' ')
    const linePreview = contentLines[i].length > 60 
      ? contentLines[i].substring(0, 57) + '...' 
      : contentLines[i]
    lines.push(`  ${lineNum}│ ${linePreview}`)
  }
  if (contentLines.length > 20) lines.push(`  ... +${contentLines.length - 20} more lines`)
  
  lines.push(``)
  lines.push(`💡 TIPS: Read file fresh, copy EXACT text, use smaller blocks`)
  
  return lines.join('\n')
}

/**
 * Generate context preview around a position in the file
 */
function generateContextPreview(
  content: string,
  position: number,
  contextLines: number = 3
): string {
  const lines = content.split('\n')
  let charCount = 0
  let targetLine = 0
  
  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1 // +1 for newline
    if (charCount > position) {
      targetLine = i
      break
    }
  }
  
  const startLine = Math.max(0, targetLine - contextLines)
  const endLine = Math.min(lines.length - 1, targetLine + contextLines)
  
  const preview: string[] = []
  for (let i = startLine; i <= endLine; i++) {
    const lineNum = String(i + 1).padStart(4, ' ')
    const marker = i === targetLine ? '→' : ' '
    const linePreview = lines[i].length > 70 
      ? lines[i].substring(0, 67) + '...' 
      : lines[i]
    preview.push(`${marker}${lineNum}│ ${linePreview}`)
  }
  
  return preview.join('\n')
}

/**
 * Insert content after an anchor string
 */
async function insertAfterAnchor(
  filePath: string,
  anchor: string,
  content: string,
  dryRun: boolean,
  showContext: number
): Promise<OperationResult> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath)
  
  let fileContent: string
  try {
    fileContent = await fs.readFile(absolutePath, 'utf8')
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {
        path: filePath,
        operation: 'failed',
        success: false,
        message: `❌ FILE NOT FOUND: ${filePath}`
      }
    }
    return {
      path: filePath,
      operation: 'failed',
      success: false,
      message: `❌ READ ERROR: ${error.message}`
    }
  }
  
  const anchorIndex = fileContent.indexOf(anchor)
  if (anchorIndex === -1) {
    return {
      path: filePath,
      operation: 'failed',
      success: false,
      message: `❌ ANCHOR NOT FOUND: "${anchor.substring(0, 50)}${anchor.length > 50 ? '...' : ''}"`
    }
  }
  
  const insertPosition = anchorIndex + anchor.length
  const newContent = fileContent.substring(0, insertPosition) + content + fileContent.substring(insertPosition)
  
  if (!dryRun) {
    await fs.writeFile(absolutePath, newContent, 'utf8')
  }
  
  const addedLines = content.split('\n').length - 1
  const prefix = dryRun ? '🔍' : '✅'
  const contextPreview = showContext > 0 ? '\n\n' + generateContextPreview(newContent, insertPosition, showContext) : ''
  
  return {
    path: filePath,
    operation: 'inserted',
    success: true,
    message: `${prefix} ${path.basename(filePath)} +${addedLines} lines (inserted after anchor)${contextPreview}`,
    additions: addedLines,
    context: contextPreview
  }
}

/**
 * Insert content before an anchor string
 */
async function insertBeforeAnchor(
  filePath: string,
  anchor: string,
  content: string,
  dryRun: boolean,
  showContext: number
): Promise<OperationResult> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath)
  
  let fileContent: string
  try {
    fileContent = await fs.readFile(absolutePath, 'utf8')
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {
        path: filePath,
        operation: 'failed',
        success: false,
        message: `❌ FILE NOT FOUND: ${filePath}`
      }
    }
    return {
      path: filePath,
      operation: 'failed',
      success: false,
      message: `❌ READ ERROR: ${error.message}`
    }
  }
  
  const anchorIndex = fileContent.indexOf(anchor)
  if (anchorIndex === -1) {
    return {
      path: filePath,
      operation: 'failed',
      success: false,
      message: `❌ ANCHOR NOT FOUND: "${anchor.substring(0, 50)}${anchor.length > 50 ? '...' : ''}"`
    }
  }
  
  const newContent = fileContent.substring(0, anchorIndex) + content + fileContent.substring(anchorIndex)
  
  if (!dryRun) {
    await fs.writeFile(absolutePath, newContent, 'utf8')
  }
  
  const addedLines = content.split('\n').length - 1
  const prefix = dryRun ? '🔍' : '✅'
  const contextPreview = showContext > 0 ? '\n\n' + generateContextPreview(newContent, anchorIndex, showContext) : ''
  
  return {
    path: filePath,
    operation: 'inserted',
    success: true,
    message: `${prefix} ${path.basename(filePath)} +${addedLines} lines (inserted before anchor)${contextPreview}`,
    additions: addedLines,
    context: contextPreview
  }
}

/**
 * Insert content at a specific line number and optional column.
 * lineNumber is 1-based (matching VS Code Ln display).
 * col is 1-based; omit or pass 0 to insert new line(s) before the target line.
 */
async function insertAtLineCol(
  filePath: string,
  lineNumber: number,
  col: number | undefined,
  content: string,
  dryRun: boolean,
  showContext: number
): Promise<OperationResult> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath)

  let fileContent: string
  try {
    fileContent = await fs.readFile(absolutePath, 'utf8')
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {
        path: filePath,
        operation: 'failed',
        success: false,
        message: `❌ FILE NOT FOUND: ${filePath}`
      }
    }
    return {
      path: filePath,
      operation: 'failed',
      success: false,
      message: `❌ READ ERROR: ${error.message}`
    }
  }

  const lines = fileContent.split('\n')
  const totalLines = lines.length

  if (lineNumber < 1 || lineNumber > totalLines + 1) {
    return {
      path: filePath,
      operation: 'failed',
      success: false,
      message: `❌ LINE OUT OF RANGE: line ${lineNumber} requested, file has ${totalLines} lines (valid: 1–${totalLines + 1})`
    }
  }

  const lineIndex = lineNumber - 1 // convert to 0-based
  let insertPosition: number
  let addedLines: number

  if (!col) {
    // No column → insert content as new line(s) before lineNumber
    const contentLines = content.split('\n')
    lines.splice(lineIndex, 0, ...contentLines)
    insertPosition = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0)
    addedLines = contentLines.length
  } else {
    // Column provided → split the target line and insert inline
    const targetLine = lines[lineIndex] ?? ''
    const colIndex = Math.max(0, Math.min(col - 1, targetLine.length)) // 0-based, clamped
    lines[lineIndex] = targetLine.substring(0, colIndex) + content + targetLine.substring(colIndex)
    insertPosition = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0) + colIndex
    addedLines = content.split('\n').length - 1
  }

  const newContent = lines.join('\n')

  if (!dryRun) {
    await fs.writeFile(absolutePath, newContent, 'utf8')
  }

  const prefix = dryRun ? '🔍' : '✅'
  const insertDesc = col
    ? `inline at Ln ${lineNumber}, Col ${col}`
    : `as ${content.split('\n').length} new line(s) before Ln ${lineNumber}`
  const contextPreview = showContext > 0 ? '\n\n' + generateContextPreview(newContent, insertPosition, showContext) : ''

  return {
    path: filePath,
    operation: 'inserted',
    success: true,
    message: `${prefix} ${path.basename(filePath)} +${addedLines} lines (inserted ${insertDesc})${contextPreview}`,
    additions: addedLines,
    context: contextPreview
  }
}

// ============================================================================
// CORE OPERATIONS
// ============================================================================

async function createDirectory(
  dirPath: string,
  dryRun: boolean
): Promise<OperationResult> {
  const absolutePath = path.isAbsolute(dirPath)
    ? dirPath
    : path.resolve(process.cwd(), dirPath)
  
  try {
    if (fsSync.existsSync(absolutePath)) {
      return {
        path: dirPath,
        operation: 'skipped',
        success: true,
        message: `⏭️  ${dirPath} - Directory already exists`
      }
    }
    
    if (!dryRun) {
      await fs.mkdir(absolutePath, { recursive: true })
    }
    
    const prefix = dryRun ? '🔍' : '📁'
    return {
      path: dirPath,
      operation: 'mkdir',
      success: true,
      message: `${prefix} ${dirPath} - Created directory`
    }
  } catch (error: any) {
    return {
      path: dirPath,
      operation: 'failed',
      success: false,
      message: `❌ ${dirPath} - Failed to create directory: ${error.message}`
    }
  }
}

/**
 * Delete a file or directory (moves to trash)
 */
async function deleteItem(
  itemPath: string,
  dryRun: boolean
): Promise<OperationResult> {
  const absolutePath = path.isAbsolute(itemPath)
    ? itemPath
    : path.resolve(process.cwd(), itemPath)
  
  try {
    // Check if item exists
    if (!fsSync.existsSync(absolutePath)) {
      return {
        path: itemPath,
        operation: 'skipped',
        success: true,
        message: `⏭️  ${itemPath} - Already deleted (not found)`
      }
    }
    
    // Get stats to determine type
    const stats = await fs.stat(absolutePath)
    const isDirectory = stats.isDirectory()
    const itemType = isDirectory ? 'directory' : 'file'
    
    if (!dryRun) {
      // Move to trash instead of permanent delete
      await trash(absolutePath)
    }
    
    const prefix = dryRun ? '🔍' : '🗑️'
    return {
      path: itemPath,
      operation: 'deleted',
      success: true,
      message: `${prefix} ${itemPath} - Moved ${itemType} to trash`
    }
  } catch (error: any) {
    return {
      path: itemPath,
      operation: 'failed',
      success: false,
      message: `❌ ${itemPath} - Failed to trash: ${error.message}`
    }
  }
}


async function createFile(
  filePath: string,
  content: string,
  overwrite: boolean,
  createParentDirs: boolean,
  dryRun: boolean
): Promise<OperationResult> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath)
  
  try {
    // Check if file exists
    if (fsSync.existsSync(absolutePath) && !overwrite) {
      return {
        path: filePath,
        operation: 'failed',
        success: false,
        message: `❌ ${filePath} - File already exists (use overwrite: true to replace)`
      }
    }
    
    // Create parent directories if needed
    const parentDir = path.dirname(absolutePath)
    if (createParentDirs && !fsSync.existsSync(parentDir)) {
      if (!dryRun) {
        await fs.mkdir(parentDir, { recursive: true })
      }
    }
    
    const lineCount = content.split('\n').length
    
    if (!dryRun) {
      await fs.writeFile(absolutePath, content, 'utf8')
    }
    
    const prefix = dryRun ? '🔍' : '✨'
    return {
      path: filePath,
      operation: 'created',
      success: true,
      message: `${prefix} ${path.basename(filePath)} - Created (${lineCount} lines)`,
      additions: lineCount
    }
  } catch (error: any) {
    return {
      path: filePath,
      operation: 'failed',
      success: false,
      message: `❌ ${filePath} - Failed to create: ${error.message}`
    }
  }
}

async function editFile(
  spec: FileSpec,
  dryRun: boolean,
  showContext: number = 0,
  globalFuzzyMatch: boolean = false
): Promise<OperationResult> {
  const absolutePath = path.isAbsolute(spec.filePath)
    ? spec.filePath
    : path.resolve(process.cwd(), spec.filePath)
  
  // Read file
  let content: string
  let originalLineEnding: string = '\n'  // Default to LF
  try {
    content = await fs.readFile(absolutePath, 'utf8')
    // Detect line ending style
    if (content.includes('\r\n')) {
      originalLineEnding = '\r\n'
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {
        path: spec.filePath,
        operation: 'failed',
        success: false,
        message: `❌ FILE NOT FOUND: ${spec.filePath}\n\n💡 Use 'content' parameter to create new files`
      }
    }
    return {
      path: spec.filePath,
      operation: 'failed',
      success: false,
      message: `❌ READ ERROR: ${error.message}`
    }
  }
  
  const edits = spec.edits || []
  
  // Normalize content to LF for consistent matching
  const normalizedContent = content.replace(/\r\n/g, '\n')
  
  // Apply all edits sequentially
  let currentContent = normalizedContent
  let totalAdditions = 0
  let totalDeletions = 0
  let editCount = 0
  
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    
    // Determine if fuzzy matching should be used (per-edit override or global setting)
    const useFuzzyMatch = edit.fuzzyMatch !== undefined ? edit.fuzzyMatch : globalFuzzyMatch
    
    // Normalize oldString to LF for matching
    const normalizedOldString = edit.oldString.replace(/\r\n/g, '\n')
    
    // Try to find the match
    let matchIndex = -1
    let matchLength = normalizedOldString.length
    
    if (useFuzzyMatch) {
      // Fuzzy match: normalize whitespace in both strings
      const fuzzyOld = normalizeForFuzzyMatch(normalizedOldString)
      const contentLines = currentContent.split('\n')
      
      // Try to find a fuzzy match by checking windows of lines
      const oldLineCount = normalizedOldString.split('\n').length
      
      for (let lineStart = 0; lineStart <= contentLines.length - oldLineCount; lineStart++) {
        const windowLines = contentLines.slice(lineStart, lineStart + oldLineCount)
        const window = windowLines.join('\n')
        const fuzzyWindow = normalizeForFuzzyMatch(window)
        
        if (fuzzyWindow === fuzzyOld) {
          // Found a fuzzy match - calculate actual position
          matchIndex = contentLines.slice(0, lineStart).join('\n').length + (lineStart > 0 ? 1 : 0)
          matchLength = window.length
          break
        }
      }
    } else {
      // Exact match
      matchIndex = currentContent.indexOf(normalizedOldString)
    }
    
    if (matchIndex === -1) {
      return {
        path: spec.filePath,
        operation: 'failed',
        success: false,
        message: buildErrorMessage(spec.filePath, normalizedOldString, currentContent, i, useFuzzyMatch)
      }
    }
    
    // Normalize newString to LF
    const normalizedNewString = edit.newString.replace(/\r\n/g, '\n')
    
    let newContent: string
    
    if (edit.replaceAll) {
      if (useFuzzyMatch) {
        // For replaceAll with fuzzy match, we need to find all fuzzy matches
        // This is complex, so for now we'll just do the first match and warn
        editCount += 1
        newContent = currentContent.substring(0, matchIndex) +
                     normalizedNewString +
                     currentContent.substring(matchIndex + matchLength)
      } else {
        const regex = new RegExp(escapeRegex(normalizedOldString), 'g')
        const matches = currentContent.match(regex)
        editCount += matches ? matches.length : 0
        newContent = currentContent.replace(regex, normalizedNewString)
      }
    } else {
      editCount += 1
      newContent = currentContent.substring(0, matchIndex) +
                   normalizedNewString +
                   currentContent.substring(matchIndex + matchLength)
    }
    
    // Count changes
    for (const change of Diff.diffLines(currentContent, newContent)) {
      if (change.added) totalAdditions += change.count || 0
      if (change.removed) totalDeletions += change.count || 0
    }
    
    currentContent = newContent
  }
  
  // No changes?
  if (currentContent === normalizedContent) {
    return {
      path: spec.filePath,
      operation: 'skipped',
      success: true,
      message: `⏭️  ${path.basename(spec.filePath)} - No changes (already matches)`
    }
  }
  
  // Restore original line endings if file used CRLF
  let finalContent = currentContent
  if (originalLineEnding === '\r\n') {
    finalContent = currentContent.replace(/\n/g, '\r\n')
  }
  
  // Write file
  if (!dryRun) {
    await fs.writeFile(absolutePath, finalContent, 'utf8')
  }
  
  const prefix = dryRun ? '🔍' : '✅'
  
  // Generate diff preview for dry run or context
  let diffPreview = ''
  if (dryRun || showContext > 0) {
    const changes = Diff.diffLines(normalizedContent, currentContent)
    const diffLines: string[] = []
    let lineNum = 1
    
    for (const change of changes) {
      const lines = change.value.split('\n').filter((_, i, arr) => i < arr.length - 1 || change.value.slice(-1) !== '\n')
      
      if (change.added) {
        for (const line of lines) {
          diffLines.push(`+${String(lineNum).padStart(4, ' ')}│ ${line.substring(0, 80)}`)
          lineNum++
        }
      } else if (change.removed) {
        for (const line of lines) {
          diffLines.push(`-    │ ${line.substring(0, 80)}`)
        }
      } else {
        // Context lines - show first and last few
        if (lines.length <= showContext * 2 + 2) {
          for (const line of lines) {
            diffLines.push(` ${String(lineNum).padStart(4, ' ')}│ ${line.substring(0, 80)}`)
            lineNum++
          }
        } else {
          // Show first few
          for (let i = 0; i < showContext; i++) {
            diffLines.push(` ${String(lineNum).padStart(4, ' ')}│ ${lines[i].substring(0, 80)}`)
            lineNum++
          }
          diffLines.push(`     │ ... ${lines.length - showContext * 2} unchanged lines ...`)
          lineNum += lines.length - showContext * 2
          // Show last few
          for (let i = lines.length - showContext; i < lines.length; i++) {
            diffLines.push(` ${String(lineNum).padStart(4, ' ')}│ ${lines[i].substring(0, 80)}`)
            lineNum++
          }
        }
      }
    }
    
    if (diffLines.length > 0 && diffLines.length <= 50) {
      diffPreview = '\n\n' + diffLines.join('\n')
    } else if (diffLines.length > 50) {
      diffPreview = '\n\n' + diffLines.slice(0, 50).join('\n') + `\n... +${diffLines.length - 50} more lines`
    }
  }
  
  return {
    path: spec.filePath,
    operation: 'edited',
    success: true,
    message: `${prefix} ${path.basename(spec.filePath)} −${totalDeletions} +${totalAdditions} (${editCount} edit${editCount > 1 ? 's' : ''})${diffPreview}`,
    additions: totalAdditions,
    deletions: totalDeletions,
    editCount
  }
}

async function processFileSpec(
  spec: FileSpec,
  overwrite: boolean,
  createParentDirs: boolean,
  dryRun: boolean,
  fuzzyMatch: boolean = false
): Promise<OperationResult> {
  // If content is provided, it's a create operation
  if (spec.content !== undefined) {
    return createFile(spec.filePath, spec.content, overwrite, createParentDirs, dryRun)
  }
  
  // Otherwise it's an edit operation
  return editFile(spec, dryRun, 0, fuzzyMatch)
}

// ============================================================================
// MAIN TOOL
// ============================================================================

export default tool({
  description: DESCRIPTION,
  args: {
    // Single file path (for simple operations)
    filePath: tool.schema.string().optional().describe(
      "Path to file. For creating: provide with 'content'. For editing: provide with 'oldString'/'newString' or 'edits[]'."
    ),
    
    // Create file mode
    content: tool.schema.string().optional().describe(
      "Content for new file. Use with 'filePath' to create a new file."
    ),
    
    // Simple edit mode
    oldString: tool.schema.string().optional().describe(
      "Text to find and replace. Use with 'filePath' and 'newString'."
    ),
    newString: tool.schema.string().optional().describe(
      "Replacement text. Use with 'filePath' and 'oldString'."
    ),
    replaceAll: tool.schema.boolean().optional().describe(
      "Replace all occurrences, not just the first. Default: false."
    ),
    
    // Multi-edit mode
    edits: tool.schema.array(
      tool.schema.object({
        oldString: tool.schema.string(),
        newString: tool.schema.string(),
        replaceAll: tool.schema.boolean().optional(),
        fuzzyMatch: tool.schema.boolean().optional()
      })
    ).optional().describe(
      "Array of edits for single file. Use with 'filePath'."
    ),
    
    // Directory creation
    directory: tool.schema.string().optional().describe(
      "Single directory path to create (with parent dirs)."
    ),
    directories: tool.schema.array(
      tool.schema.string()
    ).optional().describe(
      "Array of directory paths to create."
    ),
    
    // Batch mode
    files: tool.schema.array(
      tool.schema.object({
        filePath: tool.schema.string(),
        content: tool.schema.string().optional(),
        edits: tool.schema.array(
          tool.schema.object({
            oldString: tool.schema.string(),
            newString: tool.schema.string(),
            replaceAll: tool.schema.boolean().optional(),
            fuzzyMatch: tool.schema.boolean().optional()
          })
        ).optional()
      })
    ).optional().describe(
      "Array of file operations for batch mode. Each can be create (with content) or edit (with edits)."
    ),
    
    // Insert modes
    insertAfter: tool.schema.string().optional().describe(
      "Anchor text to insert content AFTER. Use with 'filePath' and 'content'."
    ),
    insertBefore: tool.schema.string().optional().describe(
      "Anchor text to insert content BEFORE. Use with 'filePath' and 'content'."
    ),
    lineNumber: tool.schema.number().optional().describe(
      "1-based line number for positional insert (VS Code Ln value). Use with 'filePath' and 'content'. If 'col' is also given, inserts inline at that column; otherwise inserts new line(s) before this line."
    ),
    col: tool.schema.number().optional().describe(
      "1-based column number for inline insert (VS Code Col value). Use with 'filePath', 'lineNumber', and 'content'. Omit to insert as new line(s) before the target line."
    ),
    
    // Delete modes
    delete: tool.schema.string().optional().describe(
      "Path to file or folder to move to trash. Safe - can be restored from recycle bin."
    ),
    deleteItems: tool.schema.array(
      tool.schema.string()
    ).optional().describe(
      "Array of file/folder paths to move to trash. All are processed in parallel."
    ),
    
    // Common options
    dryRun: tool.schema.boolean().optional().describe(
      "Preview without writing. Default: false."
    ),
    overwrite: tool.schema.boolean().optional().describe(
      "Allow overwriting existing files in create mode. Default: false."
    ),
    createParentDirs: tool.schema.boolean().optional().describe(
      "Auto-create parent directories. Default: true."
    ),
    stopOnError: tool.schema.boolean().optional().describe(
      "Stop on first error in batch mode. Default: false."
    ),
    showContext: tool.schema.number().optional().describe(
      "Number of context lines to show around edits. Default: 0 (disabled)."
    ),
    fuzzyMatch: tool.schema.boolean().optional().describe(
      "Ignore whitespace differences when matching oldString. Useful for template literals and formatted code. Default: false."
    )
  },
  
  async execute(args, ctx) {
    const dryRun = args.dryRun || false
    const overwrite = args.overwrite || false
    const createParentDirs = args.createParentDirs !== false
    const stopOnError = args.stopOnError || false
    const showContext = args.showContext || 0
    const fuzzyMatch = args.fuzzyMatch || false
    const startTime = Date.now()
    
    const results: OperationResult[] = []
    
    // ========================================================================
    // MODE 1: Directory creation
    // ========================================================================
    if (args.directory || (args.directories && args.directories.length > 0)) {
      const dirs = args.directories || (args.directory ? [args.directory] : [])
      
      for (const dir of dirs) {
        const result = await createDirectory(dir, dryRun)
        results.push(result)
        if (!result.success && stopOnError) break
      }
    }
    
    // ========================================================================
    // MODE 2: Insert after anchor (filePath + insertAfter + content)
    // ========================================================================
    else if (args.filePath && args.insertAfter && args.content !== undefined) {
      const result = await insertAfterAnchor(args.filePath, args.insertAfter, args.content, dryRun, showContext)
      results.push(result)
    }
    
    // ========================================================================
    // MODE 3: Insert before anchor (filePath + insertBefore + content)
    // ========================================================================
    else if (args.filePath && args.insertBefore && args.content !== undefined) {
      const result = await insertBeforeAnchor(args.filePath, args.insertBefore, args.content, dryRun, showContext)
      results.push(result)
    }
    
    // ========================================================================
    // MODE 3b: Insert at line/col (filePath + lineNumber + content)
    // ========================================================================
    else if (args.filePath && args.lineNumber !== undefined && args.content !== undefined) {
      const result = await insertAtLineCol(args.filePath, args.lineNumber, args.col, args.content, dryRun, showContext)
      results.push(result)
    }

    // ========================================================================
    // MODE 4: Batch mode (files array)
    // ========================================================================
    else if (args.files && args.files.length > 0) {
      if (stopOnError) {
        for (const spec of args.files) {
          const result = await processFileSpec(spec, overwrite, createParentDirs, dryRun, fuzzyMatch)
          results.push(result)
          if (!result.success) break
        }
      } else {
        const promises = args.files.map(spec => 
          processFileSpec(spec, overwrite, createParentDirs, dryRun, fuzzyMatch)
        )
        results.push(...await Promise.all(promises))
      }
    }
    
    // ========================================================================
    // MODE 5: Single file create (filePath + content)
    // ========================================================================
    else if (args.filePath && args.content !== undefined) {
      const result = await createFile(args.filePath, args.content, overwrite, createParentDirs, dryRun)
      results.push(result)
    }
    
    // ========================================================================
    // MODE 6: Multi-edit (filePath + edits[])
    // ========================================================================
    else if (args.filePath && args.edits && args.edits.length > 0) {
      const result = await editFile({ filePath: args.filePath, edits: args.edits }, dryRun, showContext, fuzzyMatch)
      results.push(result)
    }
    
    // ========================================================================
    // MODE 7: Simple edit (filePath + oldString + newString)
    // ========================================================================
    else if (args.filePath && args.oldString !== undefined && args.newString !== undefined) {
      const result = await editFile({
        filePath: args.filePath,
        edits: [{
          oldString: args.oldString,
          newString: args.newString,
          replaceAll: args.replaceAll
        }]
      }, dryRun, showContext, fuzzyMatch)
      results.push(result)
    }
    
    // ========================================================================
    // MODE 8: Delete single file/folder (delete)
    // ========================================================================
    else if (args.delete) {
      const result = await deleteItem(args.delete, dryRun)
      results.push(result)
    }
    
    // ========================================================================
    // MODE 9: Batch delete (deleteItems array)
    // ========================================================================
    else if (args.deleteItems && args.deleteItems.length > 0) {
      if (stopOnError) {
        for (const item of args.deleteItems) {
          const result = await deleteItem(item, dryRun)
          results.push(result)
          if (!result.success) break
        }
      } else {
        const promises = args.deleteItems.map(item => deleteItem(item, dryRun))
        results.push(...await Promise.all(promises))
      }
    }
    
    // ========================================================================
    // INVALID PARAMETERS
    // ========================================================================
    else {
      return `❌ INVALID PARAMETERS — no recognised parameter combination was provided.

Required groups (pick ONE):

  📄 CREATE FILE        filePath + content
  📁 CREATE DIRECTORY   directory  OR  directories[]
  ✏️  SIMPLE EDIT        filePath + oldString + newString
  ✏️  MULTI-EDIT         filePath + edits[]
  📦 BATCH              files[]
  ➕ INSERT AFTER        filePath + insertAfter + content
  ➕ INSERT BEFORE       filePath + insertBefore + content
  📍 INSERT AT LINE/COL  filePath + lineNumber + content  (+ optional col)
  🗑️  DELETE             delete  OR  deleteItems[]

Examples:

  { filePath: "src/app.ts", content: "// new file" }
  { filePath: "src/app.ts", oldString: "foo", newString: "bar" }
  { filePath: "src/app.ts", lineNumber: 93, col: 24, content: "text" }
  { filePath: "src/app.ts", lineNumber: 93, content: "// new line" }
  { delete: "src/old.ts" }

Received keys: ${Object.keys(args).filter(k => (args as any)[k] !== undefined).join(', ') || '(none)'}`
    }
    
    const elapsed = Date.now() - startTime
    
    // ========================================================================
    // FORMAT OUTPUT
    // ========================================================================
    
    // Simple output for single operation success
    if (results.length === 1 && results[0].success) {
      return results[0].message
    }
    
    // Detailed output for batch or errors
    const successCount = results.filter(r => r.success).length
    const failCount = results.length - successCount
    const totalAdditions = results.reduce((sum, r) => sum + (r.additions || 0), 0)
    const totalDeletions = results.reduce((sum, r) => sum + (r.deletions || 0), 0)
    const totalEdits = results.reduce((sum, r) => sum + (r.editCount || 0), 0)
    
    const lines: string[] = []
    const prefix = dryRun ? '🔍 DRY RUN' : '📝 SMART EDIT'
    
    lines.push(`${prefix} (${elapsed}ms)`)
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    lines.push(`✅ ${successCount} succeeded  ❌ ${failCount} failed  📁 ${results.length} operations`)
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    lines.push(``)
    
    for (const result of results) {
      lines.push(result.message)
      if (!result.success) lines.push(``)
    }
    
    if (successCount > 0 && results.length > 1 && (totalAdditions > 0 || totalDeletions > 0)) {
      lines.push(``)
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      lines.push(`TOTAL: −${totalDeletions} +${totalAdditions} lines across ${totalEdits} edits`)
    }
    
    return lines.join('\n')
  }
})
