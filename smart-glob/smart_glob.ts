/**
 * Smart Glob Tool v6.0 - AI-Native Filesystem Oracle
 * 
 * v6 Improvements:
 * - fastMode: Skip lineCount, extension summary, directory grouping (3-5× faster)
 * - Time filters: modifiedAfter, modifiedBefore, createdAfter, createdBefore
 * - Lazy stat: Only call fs.stat when actually needed
 * - output: "json" | "compact" | "rich" for different use cases
 * - maxDepth: Prevent runaway deep scans
 * - machine: true for deterministic, minimal-token output
 * - Auto-intent: Smart defaults based on pattern/filters
 */
import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"

const DESCRIPTION = `Find files by glob pattern - fast, cross-platform file discovery.

FLEXIBLE INPUT: Use 'pattern', 'query', or 'description' - all work the same!

USAGE:
  { pattern: "*.ts" }                    - TypeScript files in current dir
  { pattern: "**/*.json" }               - All JSON files recursively
  { pattern: "src/**/*.{js,jsx}" }       - JS/JSX in src folder
  { pattern: "**/*", path: "docs/" }     - All files in docs/

GLOB SYNTAX:
  *        - Match any characters except /
  **       - Match any characters including /
  ?        - Match single character
  {a,b}    - Match a OR b
  [abc]    - Match a, b, or c

OPTIONS:
  path: "src/"           - Directory to search (default: cwd)
  exclude: "*.test.ts"   - Skip these files
  maxResults: 500        - Limit results (default: 500)
  showStats: true        - Show file sizes and dates (default: true)
  includeHidden: true    - Include hidden files (default: false)
  minSize: 1000          - Minimum file size in bytes
  maxSize: 100000        - Maximum file size in bytes
  modifiedWithin: "1w"   - Files modified within period (1d, 1w, 1m, 1y)
  sortBy: "size"         - Sort by: name, size, modified
  dirsOnly: true         - Only return directories
  topLevelOnly: true     - Only return top-level items (no recursion)

v6 NEW OPTIONS:
  fastMode: true         - Skip lineCount, ext summary (3-5× faster, default for AI)
  modifiedAfter: "1d"    - Files modified after date/duration
  modifiedBefore: "2024-01-01" - Files modified before date
  createdAfter: "1w"     - Files created after date/duration  
  createdBefore: "2024-06-01"  - Files created before date
  maxDepth: 3            - Maximum directory depth to scan
  output: "json"         - Output format: "rich" (default), "compact", "json"
  machine: true          - No emojis, ISO timestamps, minimal tokens`

interface FileInfo {
  path: string
  name: string
  dir: string
  ext: string
  size?: number
  mtime?: Date      // Modified time
  ctime?: Date      // Changed time (metadata)
  birthtime?: Date  // Created time (Windows/macOS)
  isDirectory?: boolean
  lineCount?: number
}

interface GlobResult {
  files: FileInfo[]
  totalSize: number
  truncated: boolean
  scannedCount: number  // Total files scanned before filtering
}

interface TimeFilter {
  modifiedAfter?: Date
  modifiedBefore?: Date
  createdAfter?: Date
  createdBefore?: Date
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

function formatDate(date: Date, machine: boolean = false): string {
  if (machine) {
    return date.toISOString()
  }
  
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
  return `${Math.floor(diffDays / 365)}y ago`
}

/**
 * Parse time specification: "1d", "2w", "2024-01-01", or Date
 */
function parseTimeSpec(spec: string | Date): Date | null {
  if (spec instanceof Date) return spec
  if (!spec || typeof spec !== 'string') return null
  
  // Check for duration format: 1d, 2w, 3m, 1y
  const durationMatch = spec.match(/^(\d+)(d|w|m|y)$/i)
  if (durationMatch) {
    const value = parseInt(durationMatch[1])
    const unit = durationMatch[2].toLowerCase()
    const now = new Date()
    
    switch (unit) {
      case 'd': return new Date(now.getTime() - value * 24 * 60 * 60 * 1000)
      case 'w': return new Date(now.getTime() - value * 7 * 24 * 60 * 60 * 1000)
      case 'm': return new Date(now.getTime() - value * 30 * 24 * 60 * 60 * 1000)
      case 'y': return new Date(now.getTime() - value * 365 * 24 * 60 * 60 * 1000)
    }
  }
  
  // Check for ISO date format: 2024-01-01
  const date = new Date(spec)
  if (!isNaN(date.getTime())) {
    return date
  }
  
  return null
}

function globToRegex(pattern: string): RegExp {
  let regexStr = pattern.replace(/\\/g, '/')
  
  // Special case: **/* at the start means "optionally any directories, then any file"
  if (regexStr === '**/*') {
    return new RegExp('^(?:.*/)?[^/]+$', 'i')
  }
  
  // Special case: **/something - match at any depth
  if (regexStr.startsWith('**/')) {
    const rest = regexStr.slice(3)
    const restRegex = globPartToRegex(rest)
    return new RegExp('^(?:.*/)?(?:' + restRegex + ')$', 'i')
  }
  
  regexStr = globPartToRegex(regexStr)
  return new RegExp('^' + regexStr + '$', 'i')
}

function globPartToRegex(pattern: string): string {
  let regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\?/g, '.')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
  
  regexStr = regexStr.replace(/\{([^}]+)\}/g, (_, alts) => {
    return '(' + alts.split(',').map((a: string) => a.trim()).join('|') + ')'
  })
  
  return regexStr
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()
  
  for (let i = 0; i <= bLower.length; i++) matrix[i] = [i]
  for (let j = 0; j <= aLower.length; j++) matrix[0][j] = j
  
  for (let i = 1; i <= bLower.length; i++) {
    for (let j = 1; j <= aLower.length; j++) {
      if (bLower.charAt(i - 1) === aLower.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }
  
  return matrix[bLower.length][aLower.length]
}

function findSimilarPaths(invalidPath: string, maxSuggestions: number = 5): string[] {
  const suggestions: { path: string; score: number }[] = []
  const searchName = path.basename(invalidPath).toLowerCase()
  const parentDir = path.dirname(invalidPath)
  
  function scanDir(dir: string, depth: number = 0): void {
    if (depth > 2) return
    
    try {
      if (!fs.existsSync(dir)) return
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') && entry.name !== '.opencode') continue
        if (entry.name === 'node_modules') continue
        
        const entryLower = entry.name.toLowerCase()
        const fullPath = path.join(dir, entry.name)
        
        if (entryLower.includes(searchName) || searchName.includes(entryLower)) {
          suggestions.push({ path: fullPath, score: 100 - depth * 10 })
        } else {
          const distance = levenshteinDistance(searchName, entryLower)
          const maxLen = Math.max(searchName.length, entryLower.length)
          const similarity = 1 - (distance / maxLen)
          
          if (similarity > 0.4) {
            suggestions.push({ path: fullPath, score: similarity * 80 - depth * 5 })
          }
        }
        
        if (depth < 2) scanDir(fullPath, depth + 1)
      }
    } catch { /* Ignore permission errors */ }
  }
  
  if (fs.existsSync(parentDir)) scanDir(parentDir, 0)
  
  const grandparentDir = path.dirname(parentDir)
  if (!fs.existsSync(parentDir) && fs.existsSync(grandparentDir)) {
    scanDir(grandparentDir, 0)
  }
  
  if (suggestions.length === 0) scanDir(process.cwd(), 0)
  
  suggestions.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const unique: string[] = []
  
  for (const s of suggestions) {
    const normalized = s.path.toLowerCase()
    if (!seen.has(normalized) && unique.length < maxSuggestions) {
      seen.add(normalized)
      unique.push(s.path)
    }
  }
  
  return unique
}

function listSubdirectories(dir: string, maxItems: number = 10): string[] {
  try {
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, maxItems)
      .map(e => e.name)
  } catch { return [] }
}

/**
 * Check if we need to call fs.stat based on options
 */
function needsStat(options: {
  showStats: boolean
  fastMode: boolean
  timeFilter: TimeFilter
  minSize?: number
  maxSize?: number
  sortBy?: string
}): boolean {
  // Always need stat for size/time filters
  if (options.minSize !== undefined || options.maxSize !== undefined) return true
  if (options.timeFilter.modifiedAfter || options.timeFilter.modifiedBefore) return true
  if (options.timeFilter.createdAfter || options.timeFilter.createdBefore) return true
  if (options.sortBy === 'size' || options.sortBy === 'modified') return true
  
  // In fast mode, skip stat unless absolutely necessary
  if (options.fastMode) return false
  
  // Show stats requires stat
  return options.showStats
}

/**
 * Check if file passes time filters
 */
function passesTimeFilter(stats: fs.Stats, filter: TimeFilter): boolean {
  if (filter.modifiedAfter && stats.mtime < filter.modifiedAfter) return false
  if (filter.modifiedBefore && stats.mtime > filter.modifiedBefore) return false
  if (filter.createdAfter) {
    const created = stats.birthtime || stats.ctime
    if (created < filter.createdAfter) return false
  }
  if (filter.createdBefore) {
    const created = stats.birthtime || stats.ctime
    if (created > filter.createdBefore) return false
  }
  return true
}

interface WalkOptions {
  pattern: RegExp
  excludePatterns: RegExp[]
  includeHidden: boolean
  maxResults: number
  baseDir: string
  dirsOnly: boolean
  topLevelOnly: boolean
  maxDepth: number
  needStats: boolean
  fastMode: boolean
  timeFilter: TimeFilter
  minSize?: number
  maxSize?: number
}

interface WalkState {
  results: FileInfo[]
  scannedCount: number
}

function walkDir(
  dir: string,
  options: WalkOptions,
  state: WalkState,
  currentDepth: number = 0
): void {
  if (state.results.length >= options.maxResults) return
  if (currentDepth > options.maxDepth) return
  
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return }
  
  for (const entry of entries) {
    if (state.results.length >= options.maxResults) return
    
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(options.baseDir, fullPath).replace(/\\/g, '/')
    
    if (!options.includeHidden && entry.name.startsWith('.')) continue
    
    // Check exclusions
    let excluded = false
    for (const ex of options.excludePatterns) {
      if (ex.test(entry.name) || ex.test(relativePath)) {
        excluded = true
        break
      }
    }
    if (excluded) continue
    
    state.scannedCount++
    
    if (entry.isDirectory()) {
      // Check if directory matches pattern (for dirsOnly mode)
      if (options.dirsOnly && (options.pattern.test(relativePath) || options.pattern.test(entry.name))) {
        const fileInfo: FileInfo = {
          path: relativePath,
          name: entry.name,
          dir: path.dirname(relativePath) || '.',
          ext: '',
          isDirectory: true
        }
        
        if (options.needStats) {
          try {
            const stats = fs.statSync(fullPath)
            if (!passesTimeFilter(stats, options.timeFilter)) continue
            
            fileInfo.mtime = stats.mtime
            fileInfo.ctime = stats.ctime
            fileInfo.birthtime = stats.birthtime
            fileInfo.size = 0
          } catch { continue }
        }
        
        state.results.push(fileInfo)
      }
      
      // Recurse (unless topLevelOnly)
      if (!options.topLevelOnly) {
        walkDir(fullPath, options, state, currentDepth + 1)
      }
    } else if (entry.isFile() && !options.dirsOnly) {
      if (options.pattern.test(relativePath) || options.pattern.test(entry.name)) {
        const fileInfo: FileInfo = {
          path: relativePath,
          name: entry.name,
          dir: path.dirname(relativePath) || '.',
          ext: path.extname(entry.name).toLowerCase()
        }
        
        if (options.needStats) {
          try {
            const stats = fs.statSync(fullPath)
            
            // Apply time filter
            if (!passesTimeFilter(stats, options.timeFilter)) continue
            
            // Apply size filter
            if (options.minSize !== undefined && stats.size < options.minSize) continue
            if (options.maxSize !== undefined && stats.size > options.maxSize) continue
            
            fileInfo.size = stats.size
            fileInfo.mtime = stats.mtime
            fileInfo.ctime = stats.ctime
            fileInfo.birthtime = stats.birthtime
            
            // Only count lines if not in fast mode and for text files
            if (!options.fastMode) {
              const textExts = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.vue', '.svelte']
              if (stats.size < 5 * 1024 * 1024 && textExts.includes(fileInfo.ext)) {
                try {
                  const content = fs.readFileSync(fullPath, 'utf8')
                  fileInfo.lineCount = content.split('\n').length
                } catch { /* Ignore */ }
              }
            }
          } catch { continue }
        }
        
        state.results.push(fileInfo)
      }
    }
  }
}

function formatOutputRich(result: GlobResult, pattern: string, searchPath: string, showStats: boolean, dirsOnly: boolean, machine: boolean): string {
  const lines: string[] = []
  const emoji = machine ? '' : '📁 '
  const divider = machine ? '---' : '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  
  lines.push(`${emoji}GLOB: "${pattern}"`)
  lines.push(divider)
  
  const itemType = dirsOnly ? 'directories' : 'files'
  const sizeStr = result.totalSize > 0 ? ` (${formatSize(result.totalSize)} total)` : ''
  const truncStr = result.truncated ? ' - TRUNCATED' : ''
  lines.push(`${machine ? '' : '📊 '}${result.files.length} ${itemType} found${sizeStr}${truncStr}`)
  lines.push(`${machine ? '' : '📍 '}Path: ${searchPath}`)
  lines.push(divider)
  lines.push(``)
  
  if (result.files.length === 0) {
    lines.push(`No ${itemType} found matching pattern.`)
    if (!machine) {
      lines.push(``)
      lines.push(`💡 Tips:`)
      lines.push(`   • Use ** for recursive search: "**/*.ts"`)
      lines.push(`   • Use {a,b} for alternatives: "*.{js,ts}"`)
      lines.push(`   • Check path and pattern spelling`)
    }
    return lines.join('\n')
  }
  
  // Group by directory
  const byDir = new Map<string, FileInfo[]>()
  for (const file of result.files) {
    const existing = byDir.get(file.dir) || []
    existing.push(file)
    byDir.set(file.dir, existing)
  }
  
  const sortedDirs = Array.from(byDir.keys()).sort()
  
  for (const dir of sortedDirs) {
    const files = byDir.get(dir)!
    lines.push(`${machine ? '' : '📂 '}${dir}/`)
    
    files.sort((a, b) => a.name.localeCompare(b.name))
    
    for (const file of files) {
      const prefix = file.isDirectory ? (machine ? '[D]' : '📁') : '  '
      if (showStats && !file.isDirectory && file.size !== undefined) {
        const size = formatSize(file.size).padStart(8)
        const modified = file.mtime ? formatDate(file.mtime, machine).padStart(machine ? 24 : 10) : ''.padStart(10)
        const lineInfo = file.lineCount ? `${String(file.lineCount).padStart(5)} lines` : '          '
        lines.push(`${prefix} ${size} ${lineInfo} ${modified}  ${file.name}`)
      } else {
        lines.push(`${prefix} ${file.name}`)
      }
    }
    lines.push(``)
  }
  
  // Extension summary (skip in machine mode or dirsOnly)
  if (!machine && !dirsOnly) {
    const extCounts = new Map<string, { count: number; size: number }>()
    for (const file of result.files) {
      if (file.isDirectory) continue
      const ext = file.ext || '(no ext)'
      const existing = extCounts.get(ext) || { count: 0, size: 0 }
      existing.count++
      existing.size += file.size || 0
      extCounts.set(ext, existing)
    }
    
    if (extCounts.size > 1) {
      lines.push(divider)
      lines.push(`📊 By extension:`)
      
      const sorted = Array.from(extCounts.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
      
      for (const [ext, data] of sorted) {
        lines.push(`   ${ext.padEnd(12)} ${String(data.count).padStart(4)} files  ${formatSize(data.size).padStart(8)}`)
      }
    }
  }
  
  return lines.join('\n')
}

function formatOutputCompact(result: GlobResult): string {
  return result.files.map(f => f.path).join('\n')
}

function formatOutputJson(result: GlobResult): string {
  return JSON.stringify({
    count: result.files.length,
    totalSize: result.totalSize,
    truncated: result.truncated,
    scanned: result.scannedCount,
    files: result.files.map(f => ({
      path: f.path,
      name: f.name,
      ext: f.ext,
      size: f.size,
      mtime: f.mtime?.toISOString(),
      ctime: f.ctime?.toISOString(),
      birthtime: f.birthtime?.toISOString(),
      isDirectory: f.isDirectory,
      lineCount: f.lineCount
    }))
  }, null, 2)
}

function extractPattern(args: Record<string, unknown>): string | null {
  const patternFields = ['pattern', 'query', 'description', 'search', 'glob', 'find']
  
  for (const field of patternFields) {
    const value = args[field]
    if (value && typeof value === 'string' && value.trim()) {
      const cleaned = value.trim()
      
      const embeddedMatch = cleaned.match(/^(?:pattern|query|glob|find)[:\s=]+["']?([^\s"',]+)["']?$/i)
      if (embeddedMatch) return embeddedMatch[1]
      
      if (cleaned.includes('*') || 
          cleaned.includes('?') || 
          cleaned.includes('{') || 
          cleaned.includes('[') ||
          cleaned.includes('.') ||
          /^[\w\-./\\]+$/.test(cleaned)) {
        return cleaned
      }
      
      return cleaned
    }
  }
  
  return null
}

export default tool({
  description: DESCRIPTION,
  args: {
    // PRIMARY - The glob pattern
    pattern: tool.schema.string().optional().describe(
      "The glob pattern to match files. Examples: '*.ts', '**/*.json', 'src/**/*.{js,jsx}'"
    ),
    query: tool.schema.string().optional().describe("Alias for pattern."),
    description: tool.schema.string().optional().describe("Alias for pattern."),
    
    // Core options
    path: tool.schema.string().optional().describe("Directory to search in. Defaults to cwd."),
    exclude: tool.schema.string().optional().describe("Pattern to exclude (e.g., 'node_modules')."),
    maxResults: tool.schema.number().optional().describe("Maximum files to return. Default: 500."),
    includeHidden: tool.schema.boolean().optional().describe("Include hidden files. Default: false."),
    showStats: tool.schema.boolean().optional().describe("Show file sizes and times. Default: true."),
    
    // Size filters
    minSize: tool.schema.number().optional().describe("Minimum file size in bytes."),
    maxSize: tool.schema.number().optional().describe("Maximum file size in bytes."),
    
    // v6: Time filters (high impact)
    modifiedWithin: tool.schema.string().optional().describe("Files modified within period (1d, 1w, 1m, 1y). Legacy."),
    modifiedAfter: tool.schema.string().optional().describe("Files modified after date/duration ('1d', '2024-01-01')."),
    modifiedBefore: tool.schema.string().optional().describe("Files modified before date/duration."),
    createdAfter: tool.schema.string().optional().describe("Files created after date/duration."),
    createdBefore: tool.schema.string().optional().describe("Files created before date/duration."),
    
    // Sorting
    sortBy: tool.schema.string().optional().describe("Sort by: 'name', 'size', 'modified'. Default: 'name'."),
    
    // Type filters
    dirsOnly: tool.schema.boolean().optional().describe("Only return directories. Default: false."),
    filesOnly: tool.schema.boolean().optional().describe("Only return files. Default: true."),
    topLevelOnly: tool.schema.boolean().optional().describe("Only top-level items (no recursion). Default: false."),
    
    // v6: Performance options
    fastMode: tool.schema.boolean().optional().describe("Skip lineCount, ext summary for 3-5× speed. Default: auto."),
    maxDepth: tool.schema.number().optional().describe("Maximum directory depth to scan. Default: 50."),
    
    // v6: Output format
    output: tool.schema.string().optional().describe("Output format: 'rich' (default), 'compact', 'json'."),
    machine: tool.schema.boolean().optional().describe("Machine mode: no emojis, ISO timestamps. Default: false."),
    
    // Path format
    absolutePaths: tool.schema.boolean().optional().describe("Return absolute paths. Default: false."),
  },
  
  async execute(args, ctx) {
    // UNIVERSAL PATTERN EXTRACTION
    const pattern = extractPattern(args as Record<string, unknown>)
    
    if (!pattern) {
      throw new Error(`❌ MISSING REQUIRED PARAMETER: 'pattern'

You must provide a glob pattern. Use ANY of these parameter names:
  • pattern: "*.ts"
  • query: "**/*.json"  
  • description: "src/**/*.{js,jsx}"

USAGE:
  smart_glob({ pattern: "*.ts" })
  smart_glob({ query: "**/*.json" })

GLOB SYNTAX:
  *      - Match any characters except /
  **     - Match any characters including /
  ?      - Match single character
  {a,b}  - Match a OR b`)
    }
    
    const cleanPattern = pattern.trim().replace(/^["']|["']$/g, '')
    const searchPath = args.path || process.cwd()
    const maxResults = args.maxResults || 500
    const showStats = args.showStats !== false
    const includeHidden = args.includeHidden || false
    const dirsOnly = args.dirsOnly || false
    const topLevelOnly = args.topLevelOnly || false
    const maxDepth = args.maxDepth ?? 50
    const machine = args.machine || false
    const output = args.output || 'rich'
    
    // v6: Auto-intent for fastMode
    // Enable fastMode if: time filters used, or explicitly requested, or output is json/compact
    const hasTimeFilter = !!(args.modifiedAfter || args.modifiedBefore || args.createdAfter || args.createdBefore || args.modifiedWithin)
    const fastMode = args.fastMode ?? (hasTimeFilter || output === 'json' || output === 'compact')
    
    // v6: Build time filter
    const timeFilter: TimeFilter = {}
    if (args.modifiedAfter) timeFilter.modifiedAfter = parseTimeSpec(args.modifiedAfter) ?? undefined
    if (args.modifiedBefore) timeFilter.modifiedBefore = parseTimeSpec(args.modifiedBefore) ?? undefined
    if (args.createdAfter) timeFilter.createdAfter = parseTimeSpec(args.createdAfter) ?? undefined
    if (args.createdBefore) timeFilter.createdBefore = parseTimeSpec(args.createdBefore) ?? undefined
    
    // Legacy support: modifiedWithin
    if (args.modifiedWithin && !timeFilter.modifiedAfter) {
      timeFilter.modifiedAfter = parseTimeSpec(args.modifiedWithin) ?? undefined
    }
    
    // PATH VALIDATION WITH SMART SUGGESTIONS
    if (!fs.existsSync(searchPath)) {
      const searchName = path.basename(searchPath)
      const parentDir = path.dirname(searchPath)
      const suggestions = findSimilarPaths(searchPath, 5)
      const availableDirs = fs.existsSync(parentDir) 
        ? listSubdirectories(parentDir, 15)
        : listSubdirectories(process.cwd(), 15)
      
      let errorMsg = `❌ PATH NOT FOUND: ${searchPath}\n\n`
      
      if (suggestions.length > 0) {
        errorMsg += `💡 Did you mean one of these?\n`
        for (const suggestion of suggestions) {
          errorMsg += `   • ${suggestion}\n`
        }
        errorMsg += `\n`
      }
      
      if (availableDirs.length > 0) {
        const parentLabel = fs.existsSync(parentDir) ? parentDir : process.cwd()
        errorMsg += `📂 Available directories in ${parentLabel}:\n`
        errorMsg += `   ${availableDirs.join(', ')}\n\n`
      }
      
      errorMsg += `🔧 Try:\n`
      errorMsg += `   • Check spelling: "${searchName}" vs available directories above\n`
      errorMsg += `   • Use pattern to find: smart_glob({ pattern: "*${searchName}*", dirsOnly: true })\n`
      errorMsg += `   • Search from cwd: smart_glob({ pattern: "**/*${searchName}*" })`
      
      throw new Error(errorMsg)
    }
    
    // Build exclude patterns
    const excludePatterns: RegExp[] = [/^\.git$/, /^node_modules$/, /^\.DS_Store$/]
    if (args.exclude) {
      excludePatterns.push(globToRegex(args.exclude))
    }
    
    const patternRegex = globToRegex(cleanPattern)
    
    // v6: Determine if we need stats
    const statNeeded = needsStat({
      showStats,
      fastMode,
      timeFilter,
      minSize: args.minSize,
      maxSize: args.maxSize,
      sortBy: args.sortBy
    })
    
    // Walk directory tree
    const walkOptions: WalkOptions = {
      pattern: patternRegex,
      excludePatterns,
      includeHidden,
      maxResults: maxResults * 2, // Over-fetch for filtering
      baseDir: searchPath,
      dirsOnly,
      topLevelOnly,
      maxDepth,
      needStats: statNeeded,
      fastMode,
      timeFilter,
      minSize: args.minSize,
      maxSize: args.maxSize
    }
    
    const state: WalkState = { results: [], scannedCount: 0 }
    walkDir(searchPath, walkOptions, state, 0)
    
    let files = state.results
    
    // Sort
    const sortBy = args.sortBy || 'name'
    switch (sortBy) {
      case 'size':
        files.sort((a, b) => (b.size || 0) - (a.size || 0))
        break
      case 'modified':
        files.sort((a, b) => (b.mtime?.getTime() || 0) - (a.mtime?.getTime() || 0))
        break
      default:
        files.sort((a, b) => a.path.localeCompare(b.path))
    }
    
    // Truncate
    const truncated = files.length > maxResults
    files = files.slice(0, maxResults)
    
    // Absolute paths
    if (args.absolutePaths) {
      files = files.map(f => ({
        ...f,
        path: path.join(searchPath, f.path),
        dir: path.join(searchPath, f.dir)
      }))
    }
    
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0)
    
    const result: GlobResult = {
      files,
      totalSize,
      truncated,
      scannedCount: state.scannedCount
    }
    
    // v6: Format based on output option
    switch (output) {
      case 'json':
        return formatOutputJson(result)
      case 'compact':
        return formatOutputCompact(result)
      default:
        return formatOutputRich(result, cleanPattern, searchPath, showStats && !fastMode, dirsOnly, machine)
    }
  }
})
