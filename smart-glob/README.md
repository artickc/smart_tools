# 🧭 smart_glob

High-performance file discovery tool for OpenCode with AI-friendly output and rich filters.

## Why this tool exists

`smart_glob` solves discovery issues in large codebases:

- ❌ Slow recursive search and noisy output
- ❌ Poor filtering by date/size/depth
- ❌ Hard-to-parse results for agents
- ❌ Inconsistent behavior across OS environments

✅ `smart_glob` provides:

- Fast recursive globbing with optional `fastMode`
- Depth, date, size, hidden-file, and directory-only filters
- Multiple output formats (`rich`, `compact`, `json`)
- Better diagnostics and suggestions for invalid paths
- Cross-platform behavior (Windows/macOS/Linux)

## File included

- `smart_glob.ts` — production tool implementation

## Install in OpenCode

1. Copy `smart_glob.ts` to your OpenCode tools folder:

```bash
# Example
cp smart_glob.ts ~/.config/opencode/tools/
```

2. Enable it in `opencode.json`:

```jsonc
{
  "tools": {
    "smart_glob": true
  }
}
```

3. Restart OpenCode.

## Force AI to use only smart tools

To disable default discovery/edit/search tools:

```jsonc
{
  "tools": {
    "smart_edit": true,
    "smart_grep": true,
    "smart_glob": true,

    "edit": false,
    "write": false,
    "grep": false,
    "glob": false
  }
}
```

## Recommended use

- Fast project indexing
- Finding files by extension/pattern/date/size
- Agent-safe discovery in large monorepos

---
Smart file discovery for modern AI coding flows.
