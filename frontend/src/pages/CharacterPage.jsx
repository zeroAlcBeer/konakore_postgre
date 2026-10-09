import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert, Box, Breadcrumbs, CircularProgress, Link, Snackbar, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { ErrorOutline as ErrorIcon, NavigateNext as SeparatorIcon } from '@mui/icons-material';

import AppLayout from '../components/AppLayout';
import CaptionContent from '../components/CaptionContent';
import CharacterInfoBar from '../components/CharacterInfoBar';
import LazyImageCard from '../components/LazyImageCard';
import ImageSizeModal from '../components/ImageSizeModal';
import MasonryGrid from '../components/MasonryGrid';
import PaginationControls from '../components/PaginationControls';
import SimplePagination from '../components/SimplePagination';
import { getCharacter, getPost, searchTags } from '../api';
import { useTag } from '../contexts/TagContext';
import { usePhotoSwipe } from '../hooks/usePhotoSwipe';
import { usePostsProcessing } from '../hooks/usePostsProcessing';
import { POST_LIST_KEY, useToggleLike } from '../hooks/useToggleLike';
import {
  characterPath, characterRequest, chineseName, gallerySearchPath, indexReturnPath,
} from '../utils/characters';

const STALE = 5 * 60 * 1000;
const NO_TAGS = [];
const NO_SCORES = new Map();

/** Family count beside a switch label; blank until known. */
function CountBadge({ count }) {
  if (count == null) return null;
  return (
    <Box component="span" sx={{
      minWidth: 22, px: 0.75, borderRadius: 999, bgcolor: 'action.selected', color: 'text.secondary',
      fontSize: 12, lineHeight: '20px', fontVariantNumeric: 'tabular-nums',
    }}>
      {count.toLocaleString()}
    </Box>
  );
}

const characterQuery = (name) => ({
  queryKey: ['character', name], queryFn: () => getCharacter(name), staleTime: STALE, retry: false,
});

/**
 * One character's page: breadcrumb back to the index, banner, the
 * character's posts with an all / liked switch. Contract: docs/characters.md, UI.
 */
export default function CharacterPage() {
  const { t } = useTranslation();
  const name = useParams()['*'];
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { liked, page } = characterRequest(searchParams);
  const { translations, getTagColors, getTagTranslation } = useTag();

  // The index page this visit started from rides along every move within it.
  const from = indexReturnPath(location.state);

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' });
  const notify = useCallback(({ message, severity }) => setSnackbar({ open: true, message, severity }), []);
  const { mutate: setLiked } = useToggleLike({ onNotify: notify });
  const toggleLike = useCallback((post) => setLiked({ postId: post.id, liked: !post.liked }), [setLiked]);

  // Same toolbar as the gallery, without its relevance filter and tag exclusion.
  const [perPage, setPerPage] = useState(100);
  const [sortOption, setSortOption] = useState('id');
  const [columnWidth, setColumnWidth] = useState(() => Number(localStorage.getItem('konakore_column_width')) || 260);
  const [imageSizeOpen, setImageSizeOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: [POST_LIST_KEY, 'character', name, liked, page, perPage],
    queryFn: () => searchTags(name, page, perPage, liked || null),
    placeholderData: (previous) => previous,
  });
  const posts = useMemo(() => data?.posts || [], [data]);

  // Both switch counts, from one-family pages of each list.
  const countQuery = (likedOnly) => ({
    queryKey: ['character-count', name, likedOnly],
    queryFn: () => searchTags(name, 1, 1, likedOnly || null).then((r) => r.pagination.total_items),
  });
  const { data: allCount } = useQuery(countQuery(false));
  const { data: likedCount } = useQuery(countQuery(true));
  const pagination = data?.pagination;
  const { postsForGrid, displayPosts, groupMap } = usePostsProcessing({
    posts, sortOption, excludedTags: NO_TAGS, postScoresMap: NO_SCORES, enableGrouping: true,
  });

  const update = (changes) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    return next;
  }, { state: location.state });

  const changePage = (p) => { update({ page: p > 1 ? String(p) : null }); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  // A character tag opens its page, any other tag the gallery's search.
  const openTag = useCallback(async (tag) => {
    const isCharacter = await queryClient.fetchQuery(characterQuery(tag)).then(() => true, () => false);
    if (isCharacter) navigate(characterPath(tag), { state: { from } });
    else navigate(gallerySearchPath(tag));
  }, [queryClient, navigate, from]);

  // The cover opened from the banner: a post outside the grid, cached in list
  // shape under POST_LIST_KEY so likes reach it.
  const [coverPostId, setCoverPostId] = useState(null);
  const { data: coverData } = useQuery({
    queryKey: [POST_LIST_KEY, 'cover', coverPostId],
    queryFn: () => getPost(coverPostId).then((post) => ({ posts: [post] })),
    enabled: coverPostId != null,
    staleTime: STALE,
  });
  const coverPost = coverData?.posts[0] || null;

  const lightboxPosts = useMemo(() => (coverPost ? [...posts, coverPost] : posts), [posts, coverPost]);
  const { onImageClick, openPosts, activePostId, captionContainerRef, closeLightboxAndSearch } = usePhotoSwipe({
    displayPosts, groupMap, handleTagClick: openTag, onToggleLike: toggleLike, posts: lightboxPosts, searchTag: name,
  });

  const openCover = useCallback(async (postId) => {
    const cover = await queryClient.fetchQuery({
      queryKey: [POST_LIST_KEY, 'cover', postId],
      queryFn: () => getPost(postId).then((post) => ({ posts: [post] })),
      staleTime: STALE,
    });
    setCoverPostId(postId);
    openPosts(cover.posts);
  }, [queryClient, openPosts]);

  const activePost = useMemo(() => {
    if (!activePostId) return null;
    return postsForGrid.find((p) => p.id === activePostId) || (coverPost?.id === activePostId ? coverPost : null);
  }, [activePostId, postsForGrid, coverPost]);

  const zh = chineseName(name, translations);

  return (
    <AppLayout>
      <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, mb: 1.5 }}>
        <Breadcrumbs separator={<SeparatorIcon fontSize="small" />} aria-label={t('characters.breadcrumb')}>
          <Link component={RouterLink} to={from} underline="hover" color="inherit">{t('characters.allCharacters')}</Link>
          <Typography color="text.primary" aria-current="page">{zh || name}</Typography>
        </Breadcrumbs>
      </Box>

      <CharacterInfoBar
        tag={name}
        onSelect={(peer) => navigate(characterPath(peer), { state: { from } })}
        onOpenCover={openCover}
      />

      <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, pb: 6, display: 'flex', flexDirection: 'column' }}>
        {pagination && (
          <PaginationControls
            currentPage={page} totalPages={pagination.total_pages} onPageChange={changePage}
            perPage={perPage} onPerPageChange={(n) => { setPerPage(n); update({ page: null }); }}
            totalItems={pagination.total_items} visibleCount={displayPosts.length} isLoading={isLoading}
            sortOption={sortOption} onSortChange={setSortOption} withSimilarity={false}
            onOpenImageSize={() => setImageSizeOpen(true)}
            summary={(
              <ToggleButtonGroup
                size="small" exclusive value={liked ? 'liked' : 'all'}
                onChange={(_, value) => value && update({ liked: value === 'liked' ? '1' : null, page: null })}
              >
                <ToggleButton value="all" sx={{ px: 1.5, gap: 1 }}>
                  {t('characters.allPosts')}<CountBadge count={allCount} />
                </ToggleButton>
                <ToggleButton value="liked" sx={{ px: 1.5, gap: 1 }}>
                  {t('characters.likedPosts')}<CountBadge count={likedCount} />
                </ToggleButton>
              </ToggleButtonGroup>
            )}
          />
        )}

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>}
        {isError && (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, py: 8 }}>
            <ErrorIcon color="error" />
            <Typography color="error">{t('status.loadError')}</Typography>
          </Box>
        )}
        {!isLoading && !isError && displayPosts.length === 0 && (
          <Typography color="text.secondary" sx={{ py: 8, textAlign: 'center' }}>
            {t(liked ? 'characters.noLikedPosts' : 'status.noResults')}
          </Typography>
        )}
        {displayPosts.length > 0 && (
          <MasonryGrid
            posts={displayPosts} onImageClick={onImageClick} LazyImageCard={LazyImageCard}
            onNotify={notify} groupMap={groupMap} columnWidth={columnWidth}
          />
        )}
        {pagination && pagination.total_pages > 1 && (
          <SimplePagination currentPage={page} totalPages={pagination.total_pages} onPageChange={changePage} />
        )}
      </Box>

      <ImageSizeModal
        open={imageSizeOpen}
        onClose={() => setImageSizeOpen(false)}
        imageMinWidth={columnWidth}
        onImageMinWidthChange={(value) => { setColumnWidth(value); localStorage.setItem('konakore_column_width', String(value)); }}
      />

      {activePost && captionContainerRef.current && createPortal(
        <CaptionContent
          post={activePost} getTagColors={getTagColors} getTagTranslation={getTagTranslation}
          handleTagClick={closeLightboxAndSearch}
        />,
        captionContainerRef.current,
      )}

      <Snackbar
        open={snackbar.open} autoHideDuration={3000} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        onClose={(_, reason) => reason !== 'clickaway' && setSnackbar((s) => ({ ...s, open: false }))}
      >
        <Alert severity={snackbar.severity} variant="filled" sx={{ width: '100%' }}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </AppLayout>
  );
}
