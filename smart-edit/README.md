# ⚡ smart_edit

Universal file operations tool for OpenCode — designed to replace fragmented edit/write flows with one robust API.

## Why this tool exists

`smart_edit` solves common agent + developer pain points:

- ❌ Multiple tools for one job (`edit`, `write`, `patch`, folder creation)
- ❌ Fragile string replacement errors without good diagnostics
- ❌ Slow multi-file changes when edits are done one-by-one
- ❌ Unsafe delete workflows

✅ `smart_edit` gives you:

- One tool for **create / edit / batch / insert / delete**
- Rich error output with suggestions and context
- Batch operations across many files in one call
- Fuzzy matching for whitespace-sensitive edits
- Safe delete (moves to trash)

## File included

- `smart_edit.ts` — production tool implementation

## Install in OpenCode

1. Copy `smart_edit.ts` to your OpenCode tools folder:

```bash
# Example
cp smart_edit.ts ~/.config/opencode/tools/
```

2. Enable it in `opencode.json`:

```jsonc
{
  "tools": {
    "smart_edit": true
  }
}
```

3. Restart OpenCode.

## Force AI to use only smart tools

If you want AI to always use smart tools and never legacy ones:

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

> You can also reinforce this in `AGENTS.md` by explicitly saying: “Always use smart_edit/smart_grep/smart_glob only.”

## Recommended use

- Single file or multi-file refactors
- Batch updates across codebase
- Safe cleanup/delete workflows

---
Built for fast, reliable AI-native editing workflows.
