// Character helpers; the UI contract is docs/characters.md.
import { getImageUrl } from './imageUtils';

/** The gallery's tag search, for tags that are not characters. */
export const gallerySearchPath = (name) => `/?${new URLSearchParams({ tag: name })}`;

/** A character's own page. */
export const characterPath = (name) => `/characters/${encodeURIComponent(name)}`;

/**
 * Where the breadcrumb's root leads: the index page (with its page and work
 * filter) the visit started from, carried in the router state as `from`.
 */
export const indexReturnPath = (state) => {
  const from = state?.from;
  return typeof from === 'string' && /^\/characters(\?|$)/.test(from) ? from : '/characters';
};

/** The character page's URL state. */
export function characterRequest(searchParams) {
  const page = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  return { liked: searchParams.get('liked') === '1', page };
}

export const chineseName = (name, translations) => translations?.[name] || null;

export const coverUrl = (cover) => (cover ? getImageUrl(cover.sample_url || cover.preview_url) : null);

/** The character index's URL state as API params. */
export function listRequest(searchParams) {
  const page = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  return { work: searchParams.get('work') || null, page };
}

/** Characters per index page. */
export const INDEX_PAGE_SIZE = 40;

/**
 * What the lightbox's set-as-cover button does for a post with these
 * characters while the gallery searches `searchTag`: the searched character
 * when the post shows it, else the post's only character.
 */
export function coverAction(characters, searchTag) {
  if (characters.length === 0) return { visible: false };
  if (characters.includes(searchTag)) return { visible: true, character: searchTag };
  if (characters.length === 1) return { visible: true, character: characters[0] };
  return { visible: true, error: 'multiple' };
}
