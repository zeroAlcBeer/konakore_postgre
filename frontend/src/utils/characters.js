// Character page helpers; the page contract is docs/characters.md.
import { getImageUrl } from './imageUtils';

export const characterPath = (name) => `/characters/${encodeURIComponent(name)}`;

// Hiragana, katakana, CJK ideographs (incl. extension A and compatibility).
export const hasCjk = (text) => /[぀-ヿ㐀-鿿豈-﫿]/.test(text);

export const chineseName = (name, translations) => translations?.[name] || null;

export const coverUrl = (cover) => (cover ? getImageUrl(cover.sample_url || cover.preview_url) : null);

/**
 * Maps the list page's URL state to API params. CJK input never reaches the
 * API (it matches tag names only); it becomes a filter on the loaded page.
 */
export function listRequest(searchParams) {
  const q = (searchParams.get('q') || '').trim();
  const page = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const cjk = hasCjk(q);
  return {
    api: { q: q && !cjk ? q : null, work: searchParams.get('work') || null, page },
    localFilter: cjk ? q : null,
  };
}

export function filterByChinese(characters, query, translations) {
  if (!query) return characters;
  return characters.filter((c) => (chineseName(c.name, translations) || '').includes(query));
}
