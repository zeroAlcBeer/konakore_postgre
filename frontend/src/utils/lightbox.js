import { getImageUrl } from './imageUtils';

/** One PhotoSwipe slide for a post; the lightbox finds the post again by `postId`. */
export const postSlide = (post) => ({
  src: getImageUrl(post.data?.sample_url || post.data?.jpeg_url || post.data?.file_url),
  msrc: getImageUrl(post.data?.preview_url),
  w: post.data.width,
  h: post.data.height,
  alt: post.data.tags,
  postId: post.id,
});
