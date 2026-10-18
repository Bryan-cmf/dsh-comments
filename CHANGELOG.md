# Changelog

## 0.6.0

Full rename to `dsh-comments`. Nothing a user presses changes name, but every
internal surface that still said "markup" now says "comments", and existing data
moves with it:

- host data: `~/.dsh/dsh-markup/marks.json` → `~/.dsh/dsh-comments/marks.json`
  (copied once on first read; the old file is left untouched as a backup)
- routes: `/api/dsh-comments/marks` is canonical; the old
  `/api/dsh-markup/marks` stays registered as an alias for older browser halves,
  and the browser retries it once if the new route is missing
- localStorage: `dsh-comments/marks/v1` and `dsh-comments/panel/v1`; the old
  keys are read once and copied forward
- DOM/JS surface: `data-dsh-comments-ui`, `dsh-comments-*` highlights and CSS,
  `__DSH_COMMENTS__` debug handle, `comments-button` / `comments-dock` slot ids,
  and the `CommentsDock` / `CommentsOverlay` / `CommentsRail` component names
- logs now say `[dsh-comments]`

The smoke test seeds the old localStorage key before loading the module and
asserts it was adopted under the new key.

## 0.5.7

- **The floating selection button says "Comments", not "Markup".** It was a
  hard-coded label left over from before the rename; everything else (dock,
  editor title, message header) already said Comments.
- **Removed the hint line from the dock header.** "在上方回覆中劃選文字即可新增點評；
  ⠿ 可拖動排序" pushed the header wider than a phone screen; the drag handle is
  visible on the panel itself, so the hint was redundant. The header row now
  wraps instead of overflowing, and a flexible spacer keeps the sync state and
  buttons right-aligned.
- **Identity is `comments` everywhere a user or a log can see it.** The module
  id was already `dsh-comments`, but the exported plugin name (which appears in
  host logs) was still `markup`.
- Fixed the two stale smoke-test assertions (`dsh-markup` module id, an old type
  chip label) that had been failing since the rename.

## 0.5.6

- Rename the package to `dsh-comments` and declare the `engines.dsh` range.
