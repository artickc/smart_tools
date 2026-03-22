/**
 * Smart Grep Tool v7.0 - AI-Native Content Search
 * 
 * Ultra-fast content search with rich context and AI-friendly output.
 * Designed to work intuitively on first attempt by any AI agent.
 * 
 * v7 Improvements:
 * - Batch search: pass patterns[] to search multiple patterns in one call
 * - Each match labeled with its pattern for clear attribution (patternLabel)
 * - Batch summary: per-pattern breakdown (match count + file count)
 * - Logical grouped output: file → lines sorted, each labeled [pattern]
 * - File headers show which patterns hit that file in batch mode
 * 
 * v6 Improvements:
 * - Column numbers shown for every match (L:C format)
 * - All match spans on the same line highlighted (not just first)
 * - Match-length pointer (^^^) under match text when context is enabled
 * - Per-file match count in file headers
 * - ctx.directory used instead of process.cwd() for correct workspace root
 * - Full scan diagnostics (scanned/hidden/excluded/filtered counts)
 * - includeHidden option
 * - Auto-detection of literal vs regex patterns (no false positives on hyphens)
 */
import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"

const DESCRIPTION = `Search file contents - fast, cross-platform grep replacement.

SINGLE SEARCH (pattern required):
  { pattern: "TODO" }                          - Find all TODOs
  { pattern: "async function" }                - Find async functions
  { pattern: "import.*React" }                 - Find React imports (regex)
  { pattern: "useState(", fixedStrings: true } - Literal search

BATCH SEARCH (patterns[] — search multiple patterns at once):
  { patterns: ["TODO", "FIXME", "HACK"] }      - Find all 3 in one call
  { patterns: ["useState", "useEffect"], include: "*.tsx" }
  Returns: grouped by file, each match labeled with which pattern found it,
           plus a summary table showing count per pattern.

OPTIONS:
  path: "src/"           - Directory to search (default: cwd)
  include: "*.ts"        - Only search these files
  exclude: "*.test.ts"   - Skip these files
  contextLines: 2        - Show lines before/after match
  maxResults: 100        - Limit results per pattern (default: 100)
  caseSensitive: true    - Case-sensitive search
  wordBoundary: true     - Match whole words only
  fixedStrings: true     - Treat pattern(s) as literal, not regex
  countOnly: true        - Just count matches`

interface GrepMatch {
  file: string
  line: number
  column: number       // 0-based column of first match on this line
  matchLength: number  // length of matched text (for pointer rendering)
  allColumns: number[] // 0-based columns of ALL matches on this line
  text: string
  beforeContext: string[]
  afterContext: string[]
  patternLabel?: string // which pattern matched this line (batch mode)
}

interface BatchPatternSummary {
  pattern: string
  matchCount: number
  fileCount: number
}

interface ScanStats {
  totalScanned: number
  skippedHidden: number
  skippedExcluded: number
  skippedNoInclude: number
}

interface GrepResult {
  matches: GrepMatch[]
  fileCount: number
  matchCount: number
  truncated: boolean
  scan: ScanStats
  searchPath: string
  patternInfo: string
  batchSummary?: BatchPatternSummary[] // per-pattern breakdown (batch mode only)
  isBatch?: boolean
}

function globToRegex(pattern: string): RegExp {
  let regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\?/g, '.')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
  
  regexStr = regexStr.replace(/\{([^}]+)\}/g, (_, alts) => {
    return '(' + alts.split(',').map((a: string) => a.trim()).join('|') + ')'
  })
  
  return new RegExp('^' + regexStr + '$', 'i')
}

function collectFiles(
  dir: string,
  includePattern: RegExp | null,
  excludePatterns: RegExp[],
  maxFiles: number,
  results: string[],
  baseDir: string,
  stats: ScanStats,
  includeHidden: boolean = false
): void {
  if (results.length >= maxFiles) return
  
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  
  for (const entry of entries) {
    if (results.length >= maxFiles) return
    
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')
    
    // Skip hidden entries (dotfiles/dotdirs) unless includeHidden is set.
    if (!includeHidden && entry.name.startsWith('.')) {
      stats.skippedHidden++
      continue
    }
    
    let excluded = false
    for (const ex of excludePatterns) {
      if (ex.test(entry.name) || ex.test(relativePath)) {
        excluded = true
        break
      }
    }
    if (excluded) {
      stats.skippedExcluded++
      continue
    }
    
    if (entry.isDirectory()) {
      collectFiles(fullPath, includePattern, excludePatterns, maxFiles, results, baseDir, stats, includeHidden)
    } else if (entry.isFile()) {
      if (!includePattern || includePattern.test(relativePath) || includePattern.test(entry.name)) {
        stats.totalScanned++
        results.push(fullPath)
      } else {
        stats.skippedNoInclude++
      }
    }
  }
}

/**
 * Search large files by reading in chunks to avoid memory issues
 */
function searchLargeFile(
  filePath: string,
  searchRegex: RegExp,
  contextLines: number,
  invertMatch: boolean,
  baseDir: string
): GrepMatch[] {
  const matches: GrepMatch[] = []
  const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/')
  
  try {
    const chunkSize = 1024 * 1024
    const fd = fs.openSync(filePath, 'r')
    const fileSize = fs.fstatSync(fd).size
    
    let buffer = new Uint8Array(chunkSize)
    let position = 0
    let lineNumber = 1
    let leftover = ''
    
    while (position < fileSize && matches.length < 100) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, position)
      const chunk = leftover + Buffer.from(buffer.slice(0, bytesRead)).toString('utf8')
      
      if (chunk.includes('\0')) {
        fs.closeSync(fd)
        return matches
      }
      
      const lines = chunk.split('\n')
      leftover = lines.pop() || ''
      
      for (const line of lines) {
        searchRegex.lastIndex = 0
        const isMatch = searchRegex.test(line)
        searchRegex.lastIndex = 0
        
        if ((isMatch && !invertMatch) || (!isMatch && invertMatch)) {
          let firstColumn = 0
          let matchLength = 0
          const allColumns: number[] = []
          if (!invertMatch) {
            let m: RegExpExecArray | null
            searchRegex.lastIndex = 0
            while ((m = searchRegex.exec(line)) !== null) {
              allColumns.push(m.index)
              if (allColumns.length === 1) { firstColumn = m.index; matchLength = m[0].length }
              if (m[0].length === 0) { searchRegex.lastIndex++; break }
            }
            searchRegex.lastIndex = 0
          }
          
          matches.push({
            file: relativePath,
            line: lineNumber,
            column: firstColumn,
            matchLength,
            allColumns,
            text: line.length > 200 ? line.substring(0, 197) + '...' : line,
            beforeContext: [],
            afterContext: []
          })
          
          if (matches.length >= 100) break
        }
        lineNumber++
      }
      
      position += bytesRead
    }
    
    if (leftover && matches.length < 100) {
      searchRegex.lastIndex = 0
      const isMatch = searchRegex.test(leftover)
      searchRegex.lastIndex = 0
      if ((isMatch && !invertMatch) || (!isMatch && invertMatch)) {
        let firstColumn = 0
        let matchLength = 0
        const allColumns: number[] = []
        if (!invertMatch) {
          let m: RegExpExecArray | null
          searchRegex.lastIndex = 0
          while ((m = searchRegex.exec(leftover)) !== null) {
            allColumns.push(m.index)
            if (allColumns.length === 1) { firstColumn = m.index; matchLength = m[0].length }
            if (m[0].length === 0) { searchRegex.lastIndex++; break }
          }
          searchRegex.lastIndex = 0
        }
        matches.push({
          file: relativePath,
          line: lineNumber,
          column: firstColumn,
          matchLength,
          allColumns,
          text: leftover.length > 200 ? leftover.substring(0, 197) + '...' : leftover,
          beforeContext: [],
          afterContext: []
        })
      }
    }
    
    fs.closeSync(fd)
  } catch {
    // Ignore errors for large file search
  }
  
  return matches
}

function searchFile(
  filePath: string,
  searchRegex: RegExp,
  contextLines: number,
  invertMatch: boolean,
  baseDir: string,
  maxFileSize: number = 10 * 1024 * 1024
): GrepMatch[] {
  const matches: GrepMatch[] = []
  
  let fileStats: fs.Stats
  try {
    fileStats = fs.statSync(filePath)
  } catch {
    return matches
  }
  
  if (fileStats.size > maxFileSize) {
    return searchLargeFile(filePath, searchRegex, contextLines, invertMatch, baseDir)
  }
  
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return matches
  }
  
  if (content.includes('\0')) {
    return matches
  }
  
  const lines = content.split('\n')
  const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/')
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Reset lastIndex so global regex works correctly line-by-line
    searchRegex.lastIndex = 0
    const isMatch = searchRegex.test(line)
    searchRegex.lastIndex = 0
    
    if ((isMatch && !invertMatch) || (!isMatch && invertMatch)) {
      const beforeStart = Math.max(0, i - contextLines)
      const afterEnd = Math.min(lines.length - 1, i + contextLines)
      
      const beforeContext = contextLines > 0 ? lines.slice(beforeStart, i) : []
      const afterContext = contextLines > 0 ? lines.slice(i + 1, afterEnd + 1) : []
      
      // Collect ALL match positions on this line
      let firstColumn = 0
      let matchLength = 0
      const allColumns: number[] = []
      
      if (!invertMatch) {
        let m: RegExpExecArray | null
        searchRegex.lastIndex = 0
        while ((m = searchRegex.exec(line)) !== null) {
          allColumns.push(m.index)
          if (allColumns.length === 1) {
            firstColumn = m.index
            matchLength = m[0].length
          }
          // Prevent infinite loop on zero-length matches
          if (m[0].length === 0) { searchRegex.lastIndex++; break }
        }
        searchRegex.lastIndex = 0
      }
      
      matches.push({
        file: relativePath,
        line: i + 1,
        column: firstColumn,
        matchLength,
        allColumns,
        text: line,
        beforeContext,
        afterContext
      })
    }
  }
  
  return matches
}

function renderMatchLine(
  match: GrepMatch,
  showContext: boolean,
  lines: string[],
  isBatch: boolean
): void {
  if (showContext && match.beforeContext.length > 0) {
    for (const ctx of match.beforeContext.slice(-2)) {
      lines.push(`│     │ ${ctx.substring(0, 100)}`)
    }
  }

  const lineNum = String(match.line).padStart(4, ' ')
  const colNum = String(match.column + 1).padStart(3, ' ')  // display as 1-based
  const preview = match.text.length > 100
    ? match.text.substring(0, 97) + '...'
    : match.text
  const multiHint = match.allColumns.length > 1 ? `  ×${match.allColumns.length}` : ''
  // In batch mode, prefix each match with its pattern label
  const patternTag = isBatch && match.patternLabel
    ? `[${match.patternLabel}] `
    : ''
  lines.push(`│L${lineNum}:C${colNum}│ ${patternTag}${preview}${multiHint}`)

  if (showContext && match.matchLength > 0) {
    const indent = '│        │ '
    const pointer = ' '.repeat(match.column) + '^'.repeat(Math.min(match.matchLength, 40))
    lines.push(`${indent}${pointer}`)
  }

  if (showContext && match.afterContext.length > 0) {
    for (const ctx of match.afterContext.slice(0, 2)) {
      lines.push(`│     │ ${ctx.substring(0, 100)}`)
    }
    lines.push(`│     │`)
  }
}

function formatOutput(result: GrepResult, pattern: string, showContext: boolean): string {
  const lines: string[] = []
  const isBatch = result.isBatch === true

  // ── Header ──────────────────────────────────────────────────────────
  if (isBatch && result.batchSummary) {
    const patternList = result.batchSummary.map(s => `"${s.pattern}"`).join(', ')
    lines.push(`🔍 BATCH GREP: ${result.batchSummary.length} patterns — ${patternList}`)
  } else {
    lines.push(`🔍 GREP: "${pattern}" ${result.patternInfo}`)
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  lines.push(`📂 Path:    ${result.searchPath}`)
  lines.push(`📄 Scanned: ${result.scan.totalScanned} files` +
    (result.scan.skippedHidden > 0 ? ` | hidden skipped: ${result.scan.skippedHidden}` : '') +
    (result.scan.skippedExcluded > 0 ? ` | excluded: ${result.scan.skippedExcluded}` : '') +
    (result.scan.skippedNoInclude > 0 ? ` | filtered by include: ${result.scan.skippedNoInclude}` : ''))

  // ── Batch summary table ──────────────────────────────────────────────
  if (isBatch && result.batchSummary) {
    lines.push(`📊 Total:   ${result.matchCount} matches in ${result.fileCount} files${result.truncated ? ' (TRUNCATED)' : ''}`)
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    lines.push(`   Pattern breakdown:`)
    const maxPatLen = Math.max(...result.batchSummary.map(s => s.pattern.length))
    for (const s of result.batchSummary) {
      const pad = ''.padEnd(maxPatLen - s.pattern.length)
      const found = s.matchCount === 0 ? '—  not found' : `${s.matchCount} match${s.matchCount === 1 ? '' : 'es'} in ${s.fileCount} file${s.fileCount === 1 ? '' : 's'}`
      lines.push(`   "${s.pattern}"${pad}  →  ${found}`)
    }
  } else {
    lines.push(`📊 Matches: ${result.matchCount} in ${result.fileCount} files${result.truncated ? ' (TRUNCATED — raise maxResults)' : ''}`)
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  lines.push(``)

  // ── No matches ──────────────────────────────────────────────────────
  if (result.matchCount === 0) {
    lines.push(`No matches found.`)
    lines.push(``)
    if (result.scan.totalScanned === 0) {
      lines.push(`⚠️  Zero files were scanned. Possible causes:`)
      lines.push(`   • Path does not exist or is empty: ${result.searchPath}`)
      lines.push(`   • All files were filtered out by include/exclude patterns`)
      lines.push(`   • The directory only contains hidden (dot-prefixed) entries`)
    }
    lines.push(`💡 Tips:`)
    lines.push(`   • Verify the search path is correct`)
    if (isBatch && result.batchSummary) {
      const firstPat = result.batchSummary[0]?.pattern || 'TODO'
      lines.push(`   • Try: { patterns: ["${firstPat}"], path: ".", fixedStrings: true }`)
    } else {
      lines.push(`   • Try: { pattern: "${pattern}", path: ".", fixedStrings: true }`)
    }
    lines.push(`   • Use include: "*.json" to widen file type coverage`)
    lines.push(`   • Use includeHidden: true to also scan hidden files/dirs`)
    return lines.join('\n')
  }

  // ── Results grouped by file ──────────────────────────────────────────
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of result.matches) {
    const existing = byFile.get(match.file) || []
    existing.push(match)
    byFile.set(match.file, existing)
  }

  for (const [file, fileMatches] of byFile) {
    const fileName = path.basename(file)
    const dirName = path.dirname(file)
    const matchWord = fileMatches.length === 1 ? 'match' : 'matches'

    // In batch mode also show how many distinct patterns hit this file
    let fileHeader = `📁 ${fileName}  (${fileMatches.length} ${matchWord})`
    if (isBatch) {
      const distinctPatterns = [...new Set(fileMatches.map(m => m.patternLabel).filter(Boolean))]
      if (distinctPatterns.length > 1) {
        fileHeader += `  [${distinctPatterns.join(', ')}]`
      } else if (distinctPatterns.length === 1) {
        fileHeader += `  [${distinctPatterns[0]}]`
      }
    }
    lines.push(fileHeader)
    lines.push(`   ${dirName}`)
    lines.push(`┌─────────────────────────────────────────────────`)

    // In batch mode, sort matches by line number for clean reading
    const sorted = isBatch
      ? [...fileMatches].sort((a, b) => a.line - b.line)
      : fileMatches

    for (const match of sorted) {
      renderMatchLine(match, showContext, lines, isBatch)
    }

    lines.push(`└─────────────────────────────────────────────────`)
    lines.push(``)
  }

  return lines.join('\n')
}

export default tool({
  description: DESCRIPTION,
  args: {
    pattern: tool.schema.string().optional().describe(
      "The text or regex pattern to search for. Examples: 'TODO', 'async function', 'import.*from'"
    ),

    patterns: tool.schema.array(tool.schema.string()).optional().describe(
      "Batch mode: array of patterns to search for simultaneously. Each match is labeled with its pattern. " +
      "Returns a summary table (pattern → count) plus all results grouped by file. " +
      "Example: ['TODO', 'FIXME', 'HACK'] or ['useState', 'useEffect']"
    ),
    
    query: tool.schema.string().optional().describe(
      "Natural language query that may contain a search pattern. E.g., 'find all TODO comments'"
    ),
    
    description: tool.schema.string().optional().describe(
      "Alias for pattern. Can contain pattern directly or in 'pattern: X' format."
    ),
    
    path: tool.schema.string().optional().describe(
      "Directory to search in. Defaults to current working directory."
    ),
    include: tool.schema.string().optional().describe(
      "File pattern to include (e.g., '*.ts', '*.{js,jsx}')."
    ),
    exclude: tool.schema.string().optional().describe(
      "File pattern to exclude (e.g., 'node_modules', '*.test.ts')."
    ),
    maxResults: tool.schema.number().optional().describe(
      "Maximum number of results to return. Default: 100."
    ),
    contextLines: tool.schema.number().optional().describe(
      "Number of context lines before and after match. Default: 0."
    ),
    caseSensitive: tool.schema.boolean().optional().describe(
      "Whether search is case-sensitive. Default: false (smart case)."
    ),
    wordBoundary: tool.schema.boolean().optional().describe(
      "Only match whole words (word boundaries). Default: false."
    ),
    fixedStrings: tool.schema.boolean().optional().describe(
      "Treat pattern as literal string, not regex. Default: false."
    ),
    lineRegex: tool.schema.boolean().optional().describe(
      "Only match if entire line matches the pattern. Default: false."
    ),
    invertMatch: tool.schema.boolean().optional().describe(
      "Invert matching - show lines that DON'T match. Default: false."
    ),
    countOnly: tool.schema.boolean().optional().describe(
      "Only return count of matches, not content. Default: false."
    ),
    includeHidden: tool.schema.boolean().optional().describe(
      "Also scan hidden files and directories (those starting with '.'). Default: false."
    ),
  },

  async execute(args, ctx) {
    const rawPath = args.path || ctx.directory
    const searchPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.directory, rawPath)
    const maxResults = args.maxResults || 100
    const contextLines = args.contextLines || 0
    const invertMatch = args.invertMatch || false
    const includeHidden = args.includeHidden || false

    if (!fs.existsSync(searchPath)) {
      throw new Error(`❌ PATH NOT FOUND: ${searchPath}`)
    }

    // baseDir is used for relative path display in output.
    // When path is a file, use its parent directory as baseDir.
    const pathStatForBase = fs.statSync(searchPath)
    const baseDir = pathStatForBase.isFile() ? path.dirname(searchPath) : searchPath

    const excludePatterns: RegExp[] = [/^\.git$/, /^node_modules$/, /^\.DS_Store$/]
    if (args.exclude) excludePatterns.push(globToRegex(args.exclude))
    const includePattern = args.include ? globToRegex(args.include) : null
    const scanStats: ScanStats = { totalScanned: 0, skippedHidden: 0, skippedExcluded: 0, skippedNoInclude: 0 }
    const files: string[] = []

    // When path points directly to a file, search only that file.
    // Otherwise collect files recursively from the directory.
    if (pathStatForBase.isFile()) {
      files.push(searchPath)
      scanStats.totalScanned = 1
    } else {
      collectFiles(searchPath, includePattern, excludePatterns, 5000, files, baseDir, scanStats, includeHidden)
    }

    // ── Helper: compile a single pattern into a RegExp ─────────────────────────
    function buildRegex(pat: string): { regex: RegExp; patternInfo: string } {
      let sp = pat
      const hasRegexMeta = /[.*+?^${}()|[\]\\]/.test(pat)
      const useFixed = args.fixedStrings === true || (args.fixedStrings === undefined && !hasRegexMeta)
      if (useFixed) sp = sp.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
      if (args.wordBoundary) sp = `\\b${sp}\\b`
      if (args.lineRegex) sp = `^${sp}$`
      let flags = 'g'
      if (!args.caseSensitive && pat === pat.toLowerCase()) flags += 'i'
      try {
        return { regex: new RegExp(sp, flags), patternInfo: useFixed ? '(literal)' : '(regex)' }
      } catch (e: any) {
        throw new Error(`❌ INVALID REGEX: "${pat}"\n\n${e.message}\n\n💡 Use fixedStrings: true for literal search`)
      }
    }

    // ────────────────────────────────────────────────────────────────
    // BATCH MODE: patterns[] provided
    // ────────────────────────────────────────────────────────────────
    const batchPatterns = args.patterns && args.patterns.length > 0 ? args.patterns : null

    if (batchPatterns) {
      const compiledPatterns = batchPatterns.map(p => ({
        raw: p.trim().replace(/^["']|["']$/g, ''),
        ...buildRegex(p.trim().replace(/^["']|["']$/g, ''))
      }))

      const allMatches: GrepMatch[] = []
      const batchSummary: BatchPatternSummary[] = []
      let truncated = false

      for (const { raw, regex } of compiledPatterns) {
        const patternMatches: GrepMatch[] = []
        let patTruncated = false

        for (const file of files) {
          if (patternMatches.length >= maxResults) { patTruncated = true; break }
          const fileMatches = searchFile(file, regex, contextLines, invertMatch, baseDir)
          for (const m of fileMatches) {
            if (patternMatches.length >= maxResults) { patTruncated = true; break }
            patternMatches.push({ ...m, patternLabel: raw })
          }
        }

        if (patTruncated) truncated = true
        const fileSet = new Set(patternMatches.map(m => m.file))
        batchSummary.push({ pattern: raw, matchCount: patternMatches.length, fileCount: fileSet.size })
        allMatches.push(...patternMatches)
      }

      if (args.countOnly) {
        const lines: string[] = [
          `🔍 BATCH COUNT: ${batchPatterns.length} patterns`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `📂 Path:    ${searchPath}`,
          `📄 Scanned: ${scanStats.totalScanned} files`,
          ``,
        ]
        const maxLen = Math.max(...batchSummary.map(s => s.pattern.length))
        for (const s of batchSummary) {
          const pad = ''.padEnd(maxLen - s.pattern.length)
          lines.push(`   "${s.pattern}"${pad}  →  ${s.matchCount === 0 ? '— not found' : `${s.matchCount} match${s.matchCount === 1 ? '' : 'es'} in ${s.fileCount} file${s.fileCount === 1 ? '' : 's'}`}`)
        }
        return lines.join('\n')
      }

      const allFiles = new Set(allMatches.map(m => m.file))
      const result: GrepResult = {
        matches: allMatches,
        fileCount: allFiles.size,
        matchCount: allMatches.length,
        truncated,
        scan: scanStats,
        searchPath: baseDir,
        patternInfo: '',
        batchSummary,
        isBatch: true,
      }
      return formatOutput(result, '', contextLines > 0)
    }

    // ────────────────────────────────────────────────────────────────
    // SINGLE MODE: pattern (string)
    // ────────────────────────────────────────────────────────────────
    // INTUITIVE PATTERN EXTRACTION
    // 1. { pattern: "TODO" } - correct way
    // 2. { query: "pattern: TODO" } - natural language in query field
    // 3. { query: "TODO" } - just the pattern in query field
    // 4. { description: "TODO" } - using description alias
    let pattern = args.pattern

    // Try description first (explicit alias)
    if (!pattern || typeof pattern !== 'string' || pattern.trim() === '') {
      const description = (args as any).description
      if (description && typeof description === 'string' && description.trim()) {
        const patternMatch = description.match(/pattern[:\s=]+["']?([^\s"']+)["']?/i)
        pattern = patternMatch ? patternMatch[1] : description.trim()
      }
    }

    // Try query field
    if (!pattern || typeof pattern !== 'string' || pattern.trim() === '') {
      const query = args.query
      if (query && typeof query === 'string') {
        const patternMatch = query.match(/pattern[:\s=]+["']?([^\s"',]+)["']?/i)
        if (patternMatch) {
          pattern = patternMatch[1]
        } else if (query.match(/(?:search|find|grep|look)\s+(?:for\s+)?["']?([^\s"',]+)["']?/i)) {
          const m = query.match(/(?:search|find|grep|look)\s+(?:for\s+)?["']?([^\s"',]+)["']?/i)
          if (m) pattern = m[1]
        } else if (query.trim()) {
          pattern = query.replace(/^(pattern|search|find|grep)[:\s=]+/i, '').trim()
        }
      }
    }

    if (!pattern || typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error(`❌ MISSING REQUIRED PARAMETER: 'pattern' or 'patterns'

You must provide a search pattern.

SINGLE:  smart_grep({ pattern: "TODO" })
BATCH:   smart_grep({ patterns: ["TODO", "FIXME", "HACK"] })
OPTIONS: { include: "*.ts", path: "src/", contextLines: 2 }`)
    }

    pattern = pattern.trim().replace(/^["']|["']$/g, '')

    const { regex: searchRegex, patternInfo } = buildRegex(pattern)

    const allMatches: GrepMatch[] = []
    let truncated = false

    for (const file of files) {
      if (allMatches.length >= maxResults) { truncated = true; break }
      const matches = searchFile(file, searchRegex, contextLines, invertMatch, baseDir)
      for (const match of matches) {
        if (allMatches.length >= maxResults) { truncated = true; break }
        allMatches.push(match)
      }
    }

    if (args.countOnly) {
      const fileSet = new Set(allMatches.map(m => m.file))
      return [
        `🔍 COUNT: "${pattern}" ${patternInfo}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📂 Path:    ${searchPath}`,
        `📄 Scanned: ${scanStats.totalScanned} files`,
        `📊 Matches: ${allMatches.length} in ${fileSet.size} files`,
      ].join('\n')
    }

    const fileSet = new Set(allMatches.map(m => m.file))
    const result: GrepResult = {
      matches: allMatches,
      fileCount: fileSet.size,
      matchCount: allMatches.length,
      truncated,
      scan: scanStats,
      searchPath: baseDir,
      patternInfo,
    }

    return formatOutput(result, pattern, contextLines > 0)
  }
})
