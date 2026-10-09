import { describe, expect, it } from 'vitest';
import {
  characterPath, characterRequest, chineseName, coverAction, coverUrl, gallerySearchPath, indexReturnPath, listRequest,
} from './characters';

describe('characterPath', () => {
  it('encodes the name as one path segment', () => {
    expect(characterPath('some_character')).toBe('/characters/some_character');
    expect(characterPath('name_(work/sequel)')).toBe('/characters/name_(work%2Fsequel)');
  });
});

describe('indexReturnPath', () => {
  it('returns to the index page the visit started from', () => {
    expect(indexReturnPath({ from: '/characters?work=some_work&page=2' })).toBe('/characters?work=some_work&page=2');
    expect(indexReturnPath({ from: '/characters' })).toBe('/characters');
  });

  it('falls back to the index for anything else', () => {
    expect(indexReturnPath(null)).toBe('/characters');
    expect(indexReturnPath({ from: '/?tag=x' })).toBe('/characters');
    expect(indexReturnPath({ from: '/characters/some_character' })).toBe('/characters');
  });
});

describe('characterRequest', () => {
  it('reads the liked filter and page', () => {
    expect(characterRequest(new URLSearchParams('liked=1&page=3'))).toEqual({ liked: true, page: 3 });
    expect(characterRequest(new URLSearchParams('page=x'))).toEqual({ liked: false, page: 1 });
  });
});

describe('gallerySearchPath', () => {
  it('opens the gallery on a tag search, encoding the name', () => {
    expect(gallerySearchPath('hatsune_miku')).toBe('/?tag=hatsune_miku');
    expect(gallerySearchPath('a/b (c)&d')).toBe('/?tag=a%2Fb+%28c%29%26d');
  });

  it('reads back as the same tag', () => {
    const name = 'a/b (c)&d';
    expect(new URLSearchParams(gallerySearchPath(name).slice(2)).get('tag')).toBe(name);
  });
});

describe('chineseName', () => {
  it('returns the translation or null', () => {
    const t = { hatsune_miku: '初音未来' };
    expect(chineseName('hatsune_miku', t)).toBe('初音未来');
    expect(chineseName('kagamine_rin', t)).toBeNull();
    expect(chineseName('hatsune_miku', null)).toBeNull();
  });
});

describe('coverUrl', () => {
  it('prefers the sample, falls back to the preview, maps to the proxy', () => {
    expect(coverUrl({ sample_url: 'https://konachan.net/s.jpg', preview_url: 'https://konachan.net/p.jpg' }))
      .toBe('/konachan-proxy/s.jpg');
    expect(coverUrl({ sample_url: null, preview_url: 'https://konachan.com/p.jpg' })).toBe('/konachan-proxy/p.jpg');
    expect(coverUrl(null)).toBeNull();
  });
});

describe('listRequest', () => {
  const params = (s) => new URLSearchParams(s);

  it('reads the work filter and the page', () => {
    expect(listRequest(params('work=vocaloid&page=3'))).toEqual({ work: 'vocaloid', page: 3 });
  });

  it('defaults to no work and page 1 for missing or bad pages', () => {
    expect(listRequest(params(''))).toEqual({ work: null, page: 1 });
    expect(listRequest(params('page=0')).page).toBe(1);
    expect(listRequest(params('page=x')).page).toBe(1);
  });
});

describe('coverAction', () => {
  it('hides the button for posts without characters', () => {
    expect(coverAction([], 'hatsune_miku')).toEqual({ visible: false });
    expect(coverAction([], '')).toEqual({ visible: false });
  });

  it('picks the searched character when the post shows it, group shots included', () => {
    expect(coverAction(['hatsune_miku', 'kagamine_rin'], 'kagamine_rin')).toEqual({ visible: true, character: 'kagamine_rin' });
  });

  it('falls back to the only character', () => {
    expect(coverAction(['hatsune_miku'], '')).toEqual({ visible: true, character: 'hatsune_miku' });
    expect(coverAction(['hatsune_miku'], 'long_hair')).toEqual({ visible: true, character: 'hatsune_miku' });
  });

  it('refuses group shots outside a search for one of them', () => {
    expect(coverAction(['hatsune_miku', 'kagamine_rin'], '')).toEqual({ visible: true, error: 'multiple' });
    expect(coverAction(['hatsune_miku', 'kagamine_rin'], 'long_hair')).toEqual({ visible: true, error: 'multiple' });
  });
});
