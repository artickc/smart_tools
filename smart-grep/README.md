# 🔎 smart_grep

Fast, resilient content search tool for OpenCode with practical defaults and better matching behavior.

## Why this tool exists

`smart_grep` addresses common grep pain points in agent workflows:

- ❌ Regex/literal confusion causing failed searches
- ❌ Weak output structure for AI parsing
- ❌ Bad performance on large files
- ❌ Unclear errors for invalid patterns/paths

✅ `smart_grep` gives you:

- Fast cross-platform search with smart defaults
- Literal or regex matching (plus auto-detection for literals)
- Context lines, include/exclude filters, count mode
- Better handling for large files
- AI-friendly grouped output

## File included

- `smart_grep.ts` — production tool implementation

## Install in OpenCode

1. Copy `smart_grep.ts` to your OpenCode tools folder:

```bash
# Example
cp smart_grep.ts ~/.config/opencode/tools/
```

2. Enable it in `opencode.json`:

```jsonc
{
  "tools": {
    "smart_grep": true
  }
}
```

3. Restart OpenCode.

## Force AI to use only smart tools

Disable default grep/glob/edit stack and keep only smart tools:

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

- Code pattern hunting across big repos
- Search + context for refactoring
- Faster diagnostics during bug investigation

---
Pragmatic search built for AI + humans.
