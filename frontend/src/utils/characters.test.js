import { describe, expect, it } from 'vitest';
import { chineseName, coverUrl, gallerySearchPath, listRequest } from './characters';

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
