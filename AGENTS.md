# Agent Initialization Guide

This directory is the planning workspace for **Ogra / Ogra Edge**.

When an agent starts work here, follow this initialization sequence before making changes:

1. Read [README.md](README.md) first.
   - It is the navigation file for the directory.
   - It summarizes the current product direction and file roles.

2. Read [ogra-product-handbook.md](ogra-product-handbook.md).
   - This is the highest-priority product and technical guidance document.
   - Treat it as the source of truth for product positioning, scope, architecture, MVP, and non-goals.

3. Use `archive/` only as historical context.
   - Archived files contain earlier assumptions and broader SaaS/platform plans.
   - Do not treat archived documents as current guidance when they conflict with the handbook.

4. Preserve the current naming.
   - Current active name: `Ogra`.
   - Current active edge/runtime name: `Ogra Edge`.
   - Archived files may use `Orga`; do not reintroduce that spelling unless the user explicitly requests a rename.

5. Before editing documents, check current files:
   - `ls -la`
   - `find . -maxdepth 2 -type f | sort`
   - `git status --short --branch`

6. If asked to update direction, update both:
   - [ogra-product-handbook.md](ogra-product-handbook.md) for full guidance.
   - [README.md](README.md) for navigation and current summary.

7. Do not move archived files back to the root unless explicitly requested.

8. Keep new planning docs concise and clearly linked from [README.md](README.md).

## Git Notes

- This directory has been initialized as a git repository.
- Current branch at initialization: `master`.
- At the time this guide was written, there was no initial commit yet.
- Do not assume a clean worktree. Always inspect `git status --short --branch` before edits.
- Do not rename branches, stage files, commit, or push unless the user explicitly asks.
- If the repository branch is later renamed, update both this file and [README.md](README.md).
