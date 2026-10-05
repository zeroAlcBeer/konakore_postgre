import { describe, expect, it } from 'vitest';
import {
  characterPath, chineseName, coverUrl, filterByChinese, hasCjk, listRequest,
} from './characters';

describe('characterPath', () => {
  it('encodes the tag name as one path segment', () => {
    expect(characterPath('saber_(fate)')).toBe('/characters/saber_(fate)');
    expect(characterPath('a/b')).toBe('/characters/a%2Fb');
  });
});

describe('hasCjk', () => {
  it('detects Chinese and Japanese characters', () => {
    expect(hasCjk('初音')).toBe(true);
    expect(hasCjk('ミク')).toBe(true);
    expect(hasCjk('miku 初')).toBe(true);
    expect(hasCjk('hatsune_miku')).toBe(false);
    expect(hasCjk('')).toBe(false);
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

  it('sends Latin input as q', () => {
    expect(listRequest(params('q=%20miku%20&page=2'))).toEqual({ api: { q: 'miku', work: null, page: 2 }, localFilter: null });
  });

  it('keeps CJK input out of the request and filters locally', () => {
    expect(listRequest(params('q=初音&work=vocaloid'))).toEqual({ api: { q: null, work: 'vocaloid', page: 1 }, localFilter: '初音' });
  });

  it('defaults to page 1 for missing or bad pages', () => {
    expect(listRequest(params('')).api).toEqual({ q: null, work: null, page: 1 });
    expect(listRequest(params('page=0')).api.page).toBe(1);
    expect(listRequest(params('page=x')).api.page).toBe(1);
  });
});

describe('filterByChinese', () => {
  const characters = [{ name: 'hatsune_miku' }, { name: 'kagamine_rin' }, { name: 'untranslated' }];
  const t = { hatsune_miku: '初音未来', kagamine_rin: '镜音铃' };

  it('keeps characters whose Chinese name contains the query', () => {
    expect(filterByChinese(characters, '初音', t).map((c) => c.name)).toEqual(['hatsune_miku']);
  });

  it('returns everything without a query', () => {
    expect(filterByChinese(characters, null, t)).toBe(characters);
  });
});
