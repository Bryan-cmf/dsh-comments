# Changelog

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
