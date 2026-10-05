// Character helpers; the UI contract is docs/characters.md.
import { getImageUrl } from './imageUtils';

/** The gallery's tag search: the one URL for a character's posts. */
export const gallerySearchPath = (name) => `/?${new URLSearchParams({ tag: name })}`;

export const chineseName = (name, translations) => translations?.[name] || null;

export const coverUrl = (cover) => (cover ? getImageUrl(cover.sample_url || cover.preview_url) : null);

/** The character index's URL state as API params. */
export function listRequest(searchParams) {
  const page = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  return { work: searchParams.get('work') || null, page };
}
