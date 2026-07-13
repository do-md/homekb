/**
 * Image-reference resolution for note Markdown — implements the contract in
 * docs/ARCHITECTURE.md "Image references in notes (rendering contract)".
 *
 * Notes reference images with standard relative paths from the note file
 * (default layout: `notes/` and `assets/` are siblings under the data root),
 * e.g. a note `sub/foo.md` writes `../../assets/images/bar.png`.
 *
 * The resolution happens against a *virtual data root* (notes live under
 * `notes/`), so it works identically in all connection modes and regardless
 * of where notes_dir physically points on the home machine.
 */

/** Srcs that are never asset refs and must be embedded untouched. */
export function isExternalSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/**
 * Resolve an image src found in a note's Markdown to an asset path relative
 * to `~/.homekb/assets/` (e.g. `images/bar.png`), or null when the src is not
 * a valid asset reference (external URL, escapes the root, points outside
 * `assets/`, malformed).
 *
 * @param notePath the note's path relative to the notes root (e.g. `sub/foo.md`)
 * @param src the raw image src from the Markdown
 */
export function resolveAssetRef(notePath: string, src: string): string | null {
  if (!src || isExternalSrc(src)) return null;
  // Strip query/fragment (editors sometimes append `#center` etc.); decode
  // percent-encoding so `my%20pic.png` matches the on-disk name.
  let cleaned = src.split(/[?#]/)[0];
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    return null;
  }
  if (!cleaned || cleaned.startsWith("/") || cleaned.includes("\\") || cleaned.includes("\0")) {
    return null;
  }

  // Virtual root: the note sits at notes/<notePath>; resolve src against its directory.
  const noteDir = ["notes", ...notePath.split("/").slice(0, -1)];
  const stack = [...noteDir];
  for (const seg of cleaned.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null; // escapes the virtual data root
      stack.pop();
    } else {
      stack.push(seg);
    }
  }

  // Only paths landing under assets/ are served; anything else is not an asset.
  if (stack.length < 2 || stack[0] !== "assets") return null;
  return stack.slice(1).join("/");
}
