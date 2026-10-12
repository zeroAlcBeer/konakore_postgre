import { describe, expect, it } from 'vitest';
import { postSlide } from './lightbox';

describe('postSlide', () => {
  const post = (data) => ({ id: 7, data: { preview_url: 'https://konachan.net/p.jpg', width: 1920, height: 1080, tags: 'a b', ...data } });

  it('is one lightbox slide for a post, keyed by its id', () => {
    expect(postSlide(post({ sample_url: 'https://konachan.net/s.jpg' }))).toEqual({
      src: '/konachan-proxy/s.jpg', msrc: '/konachan-proxy/p.jpg', w: 1920, h: 1080, alt: 'a b', postId: 7,
    });
  });

  it('falls back from the sample to the jpeg, then the file', () => {
    expect(postSlide(post({ jpeg_url: 'https://konachan.net/j.jpg' })).src).toBe('/konachan-proxy/j.jpg');
    expect(postSlide(post({ file_url: 'https://konachan.net/f.png' })).src).toBe('/konachan-proxy/f.png');
  });
});
