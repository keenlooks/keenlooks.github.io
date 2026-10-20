# Vendored third-party code in this directory

| File | Library | Version | Licence | Source |
|---|---|---|---|---|
| `marked.min.js` | marked (Markdown parser) | 12.0.1 | MIT (see `LICENSE.md`) | npm tarball `https://registry.npmjs.org/marked/-/marked-12.0.1.tgz`, file `package/marked.min.js`, unmodified |

Tarball integrity (npm `dist.integrity`, re-checked on download 2026-10-20):
`sha512-Y1/V2yafOcOdWQCX0XpAKXzDakPOpn6U0YLxTJs3cww6VxOzZV1BTOOYWLvH3gX38cq+iLwljHHTnMtlDfg01Q==`

Used by `assets/js/chat-widget.js` to render the chat assistant's Markdown replies. It replaces the
earlier unpinned load from cdn.jsdelivr.net. The widget escapes raw HTML in the Markdown and passes
the result through a small tag and attribute allowlist before it reaches the page; when this file
fails to load, replies are shown as plain text.
