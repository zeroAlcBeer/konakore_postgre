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

/** Characters per index page: one lead (3x3), four majors (2x2), 35 minors fill ten six-column rows. */
export const LADDER_PAGE_SIZE = 40;

/** Tile size from the rank within the page; every page opens with its own lead. */
export const ladderTier = (indexOnPage) => (indexOnPage === 0 ? 'lead' : indexOnPage <= 4 ? 'major' : 'minor');

/** What the lightbox's set-as-cover button does for a post with these characters. */
export function coverAction(characters) {
  if (characters.length === 0) return { visible: false };
  if (characters.length > 1) return { visible: true, error: 'multiple' };
  return { visible: true, character: characters[0] };
}
