import { useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';
import PhotoSwipeFullscreen from '../utils/photoswipe-fullscreen.esm';
import { registerCoverButton } from '../utils/pswpCoverButton';
import { postSlide } from '../utils/lightbox';

const HEART_PATH = 'M16 28.5l-1.8-1.6C7.4 20.8 3 16.8 3 12c0-3.9 3.1-7 7-7 2.2 0 4.3 1 5.6 2.7L16 8l.4-.3C17.7 6 19.8 5 22 5c3.9 0 7 3.1 7 7 0 4.8-4.4 8.8-11.2 14.9L16 28.5z';

// Paint the lightbox heart from the given liked state.
function paintLikeButton(pswp, liked) {
  const button = pswp?.element?.querySelector('.pswp__button--like');
  if (!button) return;
  const fgPath = button.querySelector('svg path:not(.pswp__icn-shadow)');
  if (fgPath) {
    fgPath.setAttribute('fill', liked ? '#f44336' : 'var(--pswp-icon-color, #fff)');
  }
}

/**
 * PhotoSwipe lightbox hook，封装初始化、slideshow、like 按钮、caption（Portal）、分组浏览。
 *
 * @param {Object} options
 * @param {Array} options.displayPosts - 网格中实际显示的帖子（分组后）
 * @param {Array} options.allPosts - 全部帖子（含被分组隐藏的）
 * @param {Map}   options.groupMap - parentId → [group members]，可选
 * @param {Function} options.handleTagClick - 点击 caption 中 tag 的回调
 * @param {Function} options.onToggleLike - (post) => void; flips post.liked
 * @param {Array}  options.posts - posts from the query cache (source of liked state)
 * @param {string} options.searchTag - the open character page's tag (else the gallery's search tag); picks a group shot's cover character
 */
export function usePhotoSwipe({
  displayPosts,
  // allPosts — kept in API for future use
  groupMap,
  handleTagClick,
  onToggleLike,
  posts,
  searchTag,
}) {
  const queryClientRef = useRef(useQueryClient());
  const lightboxRef = useRef(null);
  const slideshowRef = useRef({ interval: null, isPlaying: false });
  const groupMapRef = useRef(null);
  // Flattened dataSource = each parent followed by its grouped children,
  // so the whole page (children included) forms ONE PhotoSwipe gallery.
  const postIdToIndexRef = useRef(null);
  const gridDataSourceRef = useRef([]);   // the grid's gallery, restored after openPosts
  const postsRef = useRef([]);
  const onToggleLikeRef = useRef(onToggleLike);
  const handleTagClickRef = useRef(handleTagClick);
  const searchTagRef = useRef(searchTag);

  // Portal 状态：当前激活的 postId 和 caption 容器 DOM 节点
  const [activePostId, setActivePostId] = useState(null);
  const captionContainerRef = useRef(null);

  // 同步 refs
  useEffect(() => { groupMapRef.current = groupMap || new Map(); }, [groupMap]);
  useEffect(() => { onToggleLikeRef.current = onToggleLike; }, [onToggleLike]);
  useEffect(() => { handleTagClickRef.current = handleTagClick; }, [handleTagClick]);
  useEffect(() => { searchTagRef.current = searchTag; }, [searchTag]);

  // Repaint the open lightbox's heart whenever the cached posts change
  // (a like from any path lands in the cache, not in the DOM).
  useEffect(() => {
    postsRef.current = posts;
    const pswp = lightboxRef.current?.pswp;
    const postId = pswp?.currSlide?.data?.postId;
    if (!postId) return;
    const post = posts.find(p => p.id === postId);
    paintLikeButton(pswp, post?.liked || false);
  }, [posts]);

  // Lazy-init refs that need object allocation (avoid rebuilding every render).
  if (groupMapRef.current === null) groupMapRef.current = new Map();
  if (postIdToIndexRef.current === null) postIdToIndexRef.current = new Map();

  // PhotoSwipe 初始化（仅一次）
  useEffect(() => {
    const slideshowState = slideshowRef.current;
    const SLIDESHOW_DELAY = 3000;

    const lightbox = new PhotoSwipeLightbox({
      pswpModule: () => import('photoswipe'),
      showHideAnimationType: 'fade',
      bgOpacity: 0.8,
      dataSource: [],
    });

    new PhotoSwipeFullscreen(lightbox);

    // --- Slideshow ---
    const startSlideshow = (pswp) => {
      if (slideshowState.interval) {
        clearInterval(slideshowState.interval);
        slideshowState.interval = null;
      }
      if (slideshowState.isPlaying) return;

      slideshowState.isPlaying = true;
      updateSlideshowButton(pswp, true);

      slideshowState.interval = setInterval(() => {
        const numItems = pswp.getNumItems();
        if (pswp.currIndex === numItems - 1) {
          if (pswp.options.loop) {
            pswp.next();
          } else {
            stopSlideshow(pswp);
          }
        } else {
          pswp.next();
        }
      }, SLIDESHOW_DELAY);
    };

    const stopSlideshow = (pswp) => {
      if (!slideshowState.isPlaying) return;
      slideshowState.isPlaying = false;
      updateSlideshowButton(pswp, false);
      if (slideshowState.interval) {
        clearInterval(slideshowState.interval);
        slideshowState.interval = null;
      }
    };

    const toggleSlideshowFn = (pswp) => {
      if (slideshowState.isPlaying) stopSlideshow(pswp);
      else startSlideshow(pswp);
    };

    const updateSlideshowButton = (pswp, playing) => {
      const button = pswp.element?.querySelector('.pswp__button--slideshow');
      if (!button) return;
      button.classList.toggle('pswp__button--playing', playing);
      button.setAttribute('aria-pressed', playing ? 'true' : 'false');
      const svg = button.querySelector('svg');
      if (svg) {
        if (playing) {
          svg.innerHTML = `
            <rect x="11" y="8" width="3" height="16" class="pswp__icn-shadow"/>
            <rect x="18" y="8" width="3" height="16" class="pswp__icn-shadow"/>
            <rect x="11" y="8" width="3" height="16"/>
            <rect x="18" y="8" width="3" height="16"/>`;
        } else {
          svg.innerHTML = `
            <path d="M12 8 L24 16 L12 24 Z" class="pswp__icn-shadow"/>
            <path d="M12 8 L24 16 L12 24 Z"/>`;
        }
      }
    };

    // --- UI Registration ---
    lightbox.on('uiRegister', () => {
      const { pswp } = lightbox;

      // Slideshow button
      pswp.ui.registerElement({
        name: 'slideshow-button',
        className: 'pswp__button--slideshow',
        order: 8,
        isButton: true,
        html: `<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 32 32" width="32" height="32">
          <path d="M12 8 L24 16 L12 24 Z" class="pswp__icn-shadow"/>
          <path d="M12 8 L24 16 L12 24 Z"/>
        </svg>`,
        title: 'Toggle Slideshow',
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleSlideshowFn(pswp);
          return false;
        }
      });

      // Like button
      pswp.ui.registerElement({
        name: 'like-button',
        className: 'pswp__button--like',
        order: 7,
        isButton: true,
        html: `<svg aria-hidden="true" class="pswp__icn" viewBox="0 0 32 32" width="32" height="32">
          <path d="${HEART_PATH}" class="pswp__icn-shadow"/>
          <path d="${HEART_PATH}"/>
        </svg>`,
        title: 'Toggle Like',
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const postId = pswp.currSlide?.data?.postId;
          if (!postId) return false;

          const post = postsRef.current.find(p => p.id === postId);
          if (post) onToggleLikeRef.current(post);

          return false;
        }
      });

      // Set-as-cover; a new pick shows on the character index and info bar.
      registerCoverButton(pswp, {
        getSearchTag: () => searchTagRef.current,
        onCoverSet: (name) => {
          queryClientRef.current.invalidateQueries({ queryKey: ['characters'] });
          queryClientRef.current.invalidateQueries({ queryKey: ['character', name] });
        },
      });

      // Update like button on slide change
      pswp.on('change', () => {
        const postId = pswp.currSlide?.data?.postId;
        if (!postId) return;
        const post = postsRef.current.find(p => p.id === postId);
        paintLikeButton(pswp, post?.liked || false);
      });

      // Caption container (auto-hide: desktop hot zone + mobile tap toggle)
      // Content is rendered via React Portal from the parent component
      pswp.ui.registerElement({
        name: 'custom-caption',
        order: 9,
        isButton: false,
        appendTo: 'root',
        html: '',
        onInit: (el, pswp) => {
          el.style.cssText = `
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%) translateY(20px);
            z-index: 1000;
            max-width: 90vw;
            opacity: 0;
            transition: opacity 0.3s ease, transform 0.3s ease;
            pointer-events: none;
          `;

          // 保存 caption 容器引用，供 Portal 使用
          captionContainerRef.current = el;

          const showCaption = () => {
            el.style.opacity = '1';
            el.style.transform = 'translateX(-50%) translateY(0)';
            el.style.pointerEvents = 'auto';
          };
          const hideCaption = () => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(-50%) translateY(20px)';
            el.style.pointerEvents = 'none';
          };

          // Desktop: mouse hot zone + auto-show on open/change
          let hideTimer = null;
          let inHotZone = false;
          const HOT_ZONE_HEIGHT = 120;
          const HIDE_DELAY = 1500;

          const scheduleHide = () => {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { hideCaption(); hideTimer = null; }, HIDE_DELAY);
          };

          const handleMouseMove = (e) => {
            if (e.clientY > window.innerHeight - HOT_ZONE_HEIGHT) {
              inHotZone = true;
              if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
              showCaption();
            } else {
              inHotZone = false;
              if (!hideTimer) scheduleHide();
            }
          };

          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

          if (!isTouchDevice) {
            pswp.element.addEventListener('mousemove', handleMouseMove);
          } else {
            const observer = new MutationObserver(() => {
              if (pswp.element.classList.contains('pswp--ui-visible')) {
                showCaption();
              } else {
                hideCaption();
              }
            });
            observer.observe(pswp.element, { attributes: true, attributeFilter: ['class'] });
            pswp.on('close', () => observer.disconnect());
          }

          pswp.on('close', () => {
            if (!isTouchDevice) {
              pswp.element.removeEventListener('mousemove', handleMouseMove);
            }
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
          });

          // Show caption on open and slide change, auto-hide if mouse not in hot zone
          pswp.on('change', () => {
            const postId = pswp.currSlide?.data?.postId || null;
            setActivePostId(postId);
            showCaption();
            if (!isTouchDevice && !inHotZone) scheduleHide();
          });
          setTimeout(() => pswp.dispatch('change'), 50);
        },
      });

      // Clear activePostId on close
      pswp.on('close', () => {
        setActivePostId(null);
        captionContainerRef.current = null;
      });

      // Pause slideshow on drag
      pswp.on('pointerMove', (e) => {
        if (e.originalEvent && slideshowState.isPlaying) {
          stopSlideshow(pswp);
        }
      });

      // Spacebar toggle
      pswp.on('keydown', (e) => {
        if (e.originalEvent.key === ' ' || e.originalEvent.code === 'Space') {
          e.originalEvent.preventDefault();
          toggleSlideshowFn(pswp);
        }
      });

      // Close cleanup
      pswp.on('close', () => {
        stopSlideshow(pswp);
      });
    });

    // openPosts swaps in its own slides; the grid's gallery comes back once that lightbox is gone.
    lightbox.on('destroy', () => { lightbox.options.dataSource = gridDataSourceRef.current; });

    lightbox.init();
    lightboxRef.current = lightbox;
    window.currentLightbox = lightbox;

    return () => {
      if (slideshowState.interval) {
        clearInterval(slideshowState.interval);
        slideshowState.interval = null;
        slideshowState.isPlaying = false;
      }
      if (lightboxRef.current) {
        lightboxRef.current.destroy();
        lightboxRef.current = null;
      }
      window.currentLightbox = null;
      captionContainerRef.current = null;
    };
  }, []); // eslint-disable-line react-doctor/exhaustive-deps

  // Sync dataSource when displayPosts / groupMap change.
  // Build a flattened gallery: for each displayed (parent) post, append it
  // and then its grouped children immediately after, so everything lives in
  // a single PhotoSwipe gallery instead of isolated per-group sessions.
  useEffect(() => {
    if (!lightboxRef.current || displayPosts.length === 0) return;

    const gm = groupMapRef.current;
    const dataSource = [];
    const indexMap = new Map();

    const pushPost = (post) => {
      indexMap.set(post.id, dataSource.length);
      dataSource.push(postSlide(post));
    };

    displayPosts.forEach(post => {
      pushPost(post);
      const members = gm.get(post.id);
      // members[0] is the parent itself; append only the remaining children.
      if (members && members.length > 1) {
        for (let i = 1; i < members.length; i++) pushPost(members[i]);
      }
    });

    gridDataSourceRef.current = dataSource;
    if (!lightboxRef.current.pswp) lightboxRef.current.options.dataSource = dataSource;
    postIdToIndexRef.current = indexMap;
  }, [displayPosts, groupMap]);

  // onImageClick — open the single shared gallery at the clicked post's
  // flattened index. Children are already in the same dataSource, so no
  // dataSource swapping is needed anymore.
  const onImageClick = useCallback((index) => {
    const lightbox = window.currentLightbox;
    if (!lightbox) return;

    const clickedPost = displayPosts[index];
    if (!clickedPost) return;

    const targetIndex = postIdToIndexRef.current.get(clickedPost.id);
    lightbox.loadAndOpen(targetIndex != null ? targetIndex : index);
  }, [displayPosts]);

  // Open the lightbox on just these posts (e.g. a character's cover), with every
  // lightbox tool; the posts must also be in `posts` so caption and like find them.
  const openPosts = useCallback((list) => {
    const lightbox = window.currentLightbox;
    if (!lightbox || !list.length) return;
    lightbox.options.dataSource = list.map(postSlide);
    lightbox.loadAndOpen(0);
  }, []);

  // 关闭 PhotoSwipe 并触发 tag 搜索
  const closeLightboxAndSearch = useCallback((tag) => {
    const lightbox = window.currentLightbox;
    if (lightbox?.pswp) {
      lightbox.pswp.close();
    }
    setTimeout(() => handleTagClick(tag), 100);
  }, [handleTagClick]);

  return {
    onImageClick,
    openPosts,
    activePostId,
    captionContainerRef,
    closeLightboxAndSearch,
  };
}
