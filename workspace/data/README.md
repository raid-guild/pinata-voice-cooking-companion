# workspace/data

Use this directory for durable application data that should persist across restarts, such as SQLite databases and other user-generated state.

Do not treat this folder as a generic cache bucket.

If the template later needs temporary artifacts or caches, prefer explicit subdirectories such as:
- `workspace/data/cache/`
- `workspace/data/tmp/`
- `workspace/data/generated/`

That keeps durable state separate from disposable files.
