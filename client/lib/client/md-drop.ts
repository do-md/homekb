/**
 * Pure classification helpers for the global Markdown drag-import
 * (features/kb/components/global-md-drop.tsx): drop a `.md` file anywhere in
 * the app and it becomes a new library note via plain `kb.create` — no new
 * protocol surface (docs/ARCHITECTURE.md "Markdown file import").
 *
 * Kept DOM-free (structural parameter types only) so the rules are unit-testable.
 */

/** Recognized Markdown filename extensions (import targets). */
const MD_EXT = /\.(md|markdown)$/i;

/** MIME types some platforms attach to Markdown files (often just ""). */
const MD_TYPES = new Set(["text/markdown", "text/x-markdown"]);

/**
 * Per-file import cap. Notes are text — anything bigger than this is almost
 * certainly not a note, and the RPC channel (relay tunnel) is not an asset pipe.
 */
export const MD_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Strict drop-time check: is this dropped file a Markdown document? */
export function isMarkdownFile(f: { name: string; type: string }): boolean {
  return MD_EXT.test(f.name) || MD_TYPES.has(f.type);
}

/**
 * Title for an imported file = the filename stem: the import keeps the file's
 * identity (`foo.md` → note titled "foo"), and the engine's create_note only
 * falls back to H1 / first line when the explicit title is empty. May return
 * "" (e.g. a bare ".md") — pass `undefined` to kb.create in that case.
 */
export function importTitleFromFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  return base.replace(MD_EXT, "").trim();
}

/**
 * Drag-time guess: does this drag plausibly carry a Markdown file? File *names*
 * are unreadable mid-drag (items expose only kind/type), so this is
 * deliberately loose — any non-image file qualifies; the strict per-file check
 * happens at drop time. Image-only drags return false so the overlay never
 * competes with the editor's image paste/drop bridge.
 */
export function dragLooksImportable(dt: {
  types: ReadonlyArray<string>;
  items?: ArrayLike<{ kind: string; type: string }> | null;
} | null): boolean {
  if (!dt || !dt.types.includes("Files")) return false;
  const items = Array.from(dt.items ?? []);
  // Some browsers hide items mid-drag — stay permissive, validate on drop.
  if (!items.length) return true;
  return items.some((i) => i.kind === "file" && !i.type.startsWith("image/"));
}
