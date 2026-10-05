import React, { useState, useReducer, useMemo, useEffect, useCallback, useTransition, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import SearchBar from '../components/SearchBar';
import MasonryGrid from '../components/MasonryGrid';
import AppLayout from '../components/AppLayout';
import PaginationControls from '../components/PaginationControls';
import SimplePagination from '../components/SimplePagination';
import LazyImageCard from '../components/LazyImageCard';
import { getPosts, searchTags, getSandboxPosts } from '../api';
import { useTag } from '../contexts/TagContext';
import { tagManager } from '../utils/TagManager';
import { Box, CircularProgress, Typography, Snackbar, Alert, Button } from '@mui/material';
import { ErrorOutline as ErrorIcon, SearchOff as EmptyIcon } from '@mui/icons-material';
import ExcludedTagsModal from '../components/ExcludedTagsModal';
import RelevanceFilterModal from '../components/RelevanceFilterModal';
import ImageSizeModal from '../components/ImageSizeModal';
import { usePhotoSwipe } from '../hooks/usePhotoSwipe';
import { usePostsProcessing } from '../hooks/usePostsProcessing';
import { useToggleLike, POST_LIST_KEY } from '../hooks/useToggleLike';
import CaptionContent from '../components/CaptionContent';
import CharacterInfoBar from '../components/CharacterInfoBar';
import { useTranslation } from 'react-i18next';

// What differs between the main feed and the favorites view.
const SCOPES = {
  all: { liked: null, withFilters: true, enableGrouping: true, fetchTagInfo: true, emptyKey: 'status.noResults' },
  liked: { liked: true, withFilters: false, enableGrouping: true, fetchTagInfo: false, emptyKey: 'status.noFavorites' },
};

const NO_EXCLUDED_TAGS = [];

// Content body extracted so React preserves its identity across renders.
function PostsPageContent({
  isLoading, isError, currentPage, totalPages, perPage, totalPosts,
  sortOption, handleSortChange, handlePageChange, handlePerPageChange,
  onOpenExcludedTags, onOpenRelevanceFilter, excludedCountOnPage,
  relevanceRemovedCount, onOpenImageSize, displayPosts, onImageClick,
  handleNotify, groupMap, columnWidth, isSandbox, sandboxMin,
  sandboxMax, handleClearSandbox, clearSearch, searchQuery, handleRetry, emptyKey, t,
}) {
  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '300px' }}>
        <CircularProgress />
      </Box>
    );
  }
  if (isError) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, py: 8 }}>
        <ErrorIcon sx={{ fontSize: 48, color: 'error.main' }} />
        <Typography color="error">{t('status.loadError')}</Typography>
        <Button variant="outlined" onClick={handleRetry}>{t('actions.retry')}</Button>
      </Box>
    );
  }

  return (
    <>
      <PaginationControls
        currentPage={currentPage}
        totalPages={totalPages}
        perPage={perPage}
        onPageChange={handlePageChange}
        onPerPageChange={handlePerPageChange}
        isLoading={isLoading}
        totalItems={totalPosts}
        sortOption={sortOption}
        onSortChange={handleSortChange}
        onOpenExcludedTags={onOpenExcludedTags}
        onOpenRelevanceFilter={onOpenRelevanceFilter}
        excludedCountOnPage={excludedCountOnPage}
        relevanceRemovedCount={relevanceRemovedCount}
        onOpenImageSize={onOpenImageSize}
        visibleCount={displayPosts.length}
        sandboxMin={isSandbox ? sandboxMin : null}
        sandboxMax={isSandbox ? sandboxMax : null}
        onClearSandbox={handleClearSandbox}
      />
      {displayPosts.length > 0 ? (
        <MasonryGrid
          posts={displayPosts}
          onImageClick={onImageClick}
          LazyImageCard={LazyImageCard}
          isLoading={isLoading}
          onNotify={handleNotify}
          groupMap={groupMap}
          columnWidth={columnWidth}
        />
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, py: 8 }}>
          <EmptyIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
          <Typography color="text.secondary">{t(emptyKey)}</Typography>
          {searchQuery && (
            <Button variant="outlined" size="small" onClick={clearSearch}>{t('actions.clearSearch')}</Button>
          )}
        </Box>
      )}
      <SimplePagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={handlePageChange}
        isLoading={isLoading}
      />
    </>
  );
}

// UI state grouped so one logical update is one render. The search tag lives
// in the URL (?tag=); the page belongs to the query it was set for.
const uiStateInit = () => ({
  currentPage: 1,
  pageQuery: '',
  perPage: 100,
  sortOption: 'id',
  excludedTagsOpen: false,
  relevanceFilterOpen: false,
  imageSizeOpen: false,
  columnWidth: Number(localStorage.getItem('konakore_column_width')) || 260,
  snackbar: { open: false, message: '', severity: 'success' },
});

function uiStateReducer(state, action) {
  switch (action.type) {
    case 'SET_PAGE':
      return { ...state, currentPage: action.page, pageQuery: action.query };
    case 'SET_PER_PAGE':
      return { ...state, perPage: action.perPage, currentPage: 1 };
    case 'SET_SORT':
      return { ...state, sortOption: action.sortOption };
    case 'OPEN_EXCLUDED_TAGS':
      return { ...state, excludedTagsOpen: true };
    case 'CLOSE_EXCLUDED_TAGS':
      return { ...state, excludedTagsOpen: false };
    case 'OPEN_RELEVANCE_FILTER':
      return { ...state, relevanceFilterOpen: true };
    case 'CLOSE_RELEVANCE_FILTER':
      return { ...state, relevanceFilterOpen: false };
    case 'OPEN_IMAGE_SIZE':
      return { ...state, imageSizeOpen: true };
    case 'CLOSE_IMAGE_SIZE':
      return { ...state, imageSizeOpen: false };
    case 'SET_COLUMN_WIDTH':
      return { ...state, columnWidth: action.width };
    case 'NOTIFY':
      return { ...state, snackbar: { open: true, message: action.message, severity: action.severity } };
    case 'CLOSE_SNACKBAR':
      return { ...state, snackbar: { ...state.snackbar, open: false } };
    case 'CLEAR_SANDBOX':
      return { ...state, currentPage: 1 };
    default:
      return state;
  }
}

// Modals group — extracted so the parent stays under the size limit.
function PostsPageModals({
  withFilters, excludedTagsOpen, relevanceFilterOpen, imageSizeOpen, excludedTags,
  handleExcludedTagsChange, excludedCountOnPage, posts, totalPosts,
  relevanceThreshold, handleRelevanceThresholdChange, postScoresMap,
  columnWidth, handleColumnWidthChange, dispatch,
}) {
  return (
    <>
      {withFilters && (
        <>
          <ExcludedTagsModal
            open={excludedTagsOpen}
            onClose={() => dispatch({ type: 'CLOSE_EXCLUDED_TAGS' })}
            excludedTags={excludedTags}
            onExcludedTagsChange={handleExcludedTagsChange}
            excludedCountOnPage={excludedCountOnPage}
          />
          <RelevanceFilterModal
            open={relevanceFilterOpen}
            onClose={() => dispatch({ type: 'CLOSE_RELEVANCE_FILTER' })}
            posts={posts}
            totalPosts={totalPosts}
            threshold={relevanceThreshold}
            onThresholdChange={handleRelevanceThresholdChange}
            postScoresMap={postScoresMap}
          />
        </>
      )}
      <ImageSizeModal
        open={imageSizeOpen}
        onClose={() => dispatch({ type: 'CLOSE_IMAGE_SIZE' })}
        imageMinWidth={columnWidth}
        onImageMinWidthChange={handleColumnWidthChange}
      />
    </>
  );
}

// Data fetching + processing — extracted so the page stays readable.
// All post lists share the POST_LIST_KEY prefix so likes update them in one place.
function usePostsPageData({ scope, searchQuery, currentPage, perPage, sortOption, excludedTags, relevanceThreshold, isSandbox, sandboxMin, sandboxMax }) {
  const { liked, enableGrouping } = SCOPES[scope];

  const feedQuery = useQuery({
    queryKey: [POST_LIST_KEY, scope, 'feed', currentPage, perPage],
    queryFn: () => getPosts(currentPage, perPage, liked),
    enabled: !searchQuery && !isSandbox,
    staleTime: 5 * 60 * 1000,
  });

  const sandboxQuery = useQuery({
    queryKey: [POST_LIST_KEY, scope, 'sandbox', sandboxMin, sandboxMax, currentPage, perPage],
    queryFn: () => getSandboxPosts(sandboxMin, sandboxMax, currentPage, perPage, liked),
    enabled: isSandbox && !searchQuery,
    staleTime: 5 * 60 * 1000,
  });

  const searchQueryResult = useQuery({
    queryKey: [POST_LIST_KEY, scope, 'search', searchQuery, currentPage, perPage],
    queryFn: () => searchTags(searchQuery, currentPage, perPage, liked),
    enabled: !!searchQuery,
  });

  const active = searchQuery ? searchQueryResult : (isSandbox ? sandboxQuery : feedQuery);
  const activeData = active.data;
  const posts = activeData?.posts || [];
  const totalPages = activeData?.pagination?.total_pages || 0;
  const totalPosts = activeData?.pagination?.total_items || 0;

  const postScoresMap = useMemo(() => {
    const map = new Map();
    const sourcePosts = activeData?.posts;
    if (!sourcePosts?.length) return map;
    sourcePosts.forEach(post => {
      if (post.similarity != null) map.set(post.id, post.similarity);
    });
    return map;
  }, [activeData]);

  const {
    postsForGrid,
    displayPosts,
    groupMap,
    excludedCountOnPage,
    relevanceRemovedCount,
  } = usePostsProcessing({
    posts,
    sortOption,
    excludedTags,
    relevanceThreshold,
    postScoresMap,
    enableGrouping,
  });

  return {
    posts, postsForGrid, displayPosts, groupMap,
    excludedCountOnPage, relevanceRemovedCount, postScoresMap,
    isLoading: active.isLoading, isError: active.isError, totalPages, totalPosts,
    refetch: active.refetch,
  };
}

/**
 * Post grid page shared by the main feed (scope="all") and favorites
 * (scope="liked"). Mount with a distinct `key` per scope so UI state resets
 * when switching routes.
 */
const PostsPage = ({ scope = 'all' }) => {
  const { withFilters, fetchTagInfo: shouldFetchTagInfo, emptyKey } = SCOPES[scope];
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [ui, dispatch] = useReducer(uiStateReducer, undefined, uiStateInit);

  // Excluded tags and relevance threshold, restored from tagManager
  const [excludedTags, setExcludedTags] = useState(() => {
    const config = tagManager.getExcludedPostTagsConfig();
    return Array.isArray(config?.tags) ? config.tags : [];
  });
  const [relevanceThreshold, setRelevanceThreshold] = useState(() => {
    const config = tagManager.getRelevanceFilterConfig();
    return Number(config?.threshold) || 0;
  });

  const handleNotify = useCallback(({ message, severity }) => {
    dispatch({ type: 'NOTIFY', message, severity });
  }, []);
  const handleCloseSnackbar = useCallback((_, reason) => {
    if (reason === 'clickaway') return;
    dispatch({ type: 'CLOSE_SNACKBAR' });
  }, []);

  const { mutate: setLiked } = useToggleLike({ onNotify: handleNotify });
  const handleToggleLike = useCallback((post) => {
    setLiked({ postId: post.id, liked: !post.liked });
  }, [setLiked]);

  const {
    fetchTagInfo,
    addTagsToCache,
    extractTagsFromPosts,
    mergeTagsWithCache,
    getTagColors,
    getTagTranslation,
  } = useTag();

  const { perPage, sortOption, excludedTagsOpen, relevanceFilterOpen, imageSizeOpen, columnWidth, snackbar } = ui;
  const searchQuery = searchParams.get('tag') || '';
  const currentPage = ui.pageQuery === searchQuery ? ui.currentPage : 1;

  // Sandbox mode: derived from URL params
  const sandboxMin = searchParams.has('id_min') ? parseInt(searchParams.get('id_min'), 10) : null;
  const sandboxMax = searchParams.has('id_max') ? parseInt(searchParams.get('id_max'), 10) : null;
  const isSandbox = sandboxMin !== null && sandboxMax !== null && !isNaN(sandboxMin) && !isNaN(sandboxMax);

  const handleClearSandbox = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('id_min');
      next.delete('id_max');
      return next;
    }, { replace: true });
    dispatch({ type: 'CLEAR_SANDBOX' });
  }, [setSearchParams]);

  // Fetch and cache tag info when the page changes (main feed only)
  useEffect(() => {
    if (!shouldFetchTagInfo) return undefined;
    const fetchTagInfoData = async () => {
      try {
        await fetchTagInfo(currentPage, perPage, null);
      } catch (error) {
        console.warn('Failed to fetch tag info:', error);
      }
    };
    const timeoutId = setTimeout(fetchTagInfoData, 300);
    return () => clearTimeout(timeoutId);
  }, [shouldFetchTagInfo, currentPage, perPage, fetchTagInfo]);

  const {
    posts, postsForGrid, displayPosts, groupMap,
    excludedCountOnPage, relevanceRemovedCount, postScoresMap,
    isLoading, isError, totalPages, totalPosts, refetch,
  } = usePostsPageData({
    scope, searchQuery, currentPage, perPage, sortOption,
    excludedTags: withFilters ? excludedTags : NO_EXCLUDED_TAGS,
    relevanceThreshold: withFilters ? relevanceThreshold : 0,
    isSandbox, sandboxMin, sandboxMax,
  });

  // --- EVENT HANDLERS ---
  // A new search starts at page 1 (see currentPage) and the default sort.
  const handleSearch = useCallback((query) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (query) next.set('tag', query); else next.delete('tag');
      return next;
    });
    dispatch({ type: 'SET_SORT', sortOption: 'id' });
  }, [setSearchParams]);
  const clearSearch = () => handleSearch('');
  const handleTagClick = handleSearch;

  const handlePageChange = (page) => {
    dispatch({ type: 'SET_PAGE', page, query: searchQuery });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePerPageChange = (newPerPage) => {
    dispatch({ type: 'SET_PER_PAGE', perPage: newPerPage });
  };

  const handleSortChange = (newSortOption) => {
    dispatch({ type: 'SET_SORT', sortOption: newSortOption });
  };

  const handleExcludedTagsChange = (newTags) => {
    setExcludedTags(newTags);
    tagManager.setExcludedPostTagsConfig({ tags: newTags });
  };

  const [, startTransition] = useTransition();
  const handleRelevanceThresholdChange = useCallback((newThreshold) => {
    startTransition(() => {
      setRelevanceThreshold(newThreshold);
      tagManager.setRelevanceFilterConfig({ threshold: newThreshold });
    });
  }, []);

  const handleColumnWidthChange = useCallback((value) => {
    dispatch({ type: 'SET_COLUMN_WIDTH', width: value });
    localStorage.setItem('konakore_column_width', String(value));
  }, []);

  // Tags — sync to cache on change (ref-based dedup, no effect).
  const currentPageTags = useMemo(() => {
    if (!postsForGrid?.length) return [];
    return extractTagsFromPosts(postsForGrid);
  }, [postsForGrid, extractTagsFromPosts]);

  const lastSyncedTagsRef = useRef([]);
  if (currentPageTags.length > 0 && currentPageTags !== lastSyncedTagsRef.current) {
    lastSyncedTagsRef.current = currentPageTags;
    addTagsToCache(currentPageTags);
  }

  const availableTags = useMemo(() => {
    return mergeTagsWithCache(currentPageTags);
  }, [currentPageTags, mergeTagsWithCache]);

  // --- PHOTOSWIPE ---
  const { onImageClick, activePostId, captionContainerRef, closeLightboxAndSearch } = usePhotoSwipe({
    displayPosts,
    groupMap,
    handleTagClick,
    onToggleLike: handleToggleLike,
    posts,
  });

  // Caption post, looked up among all posts including grouped children
  const activePost = useMemo(() => {
    if (!activePostId) return null;
    return postsForGrid.find(p => p.id === activePostId) || null;
  }, [activePostId, postsForGrid]);

  // --- RENDER ---

  return (
    <AppLayout>
      <PostsPageModals
        withFilters={withFilters}
        excludedTagsOpen={excludedTagsOpen}
        relevanceFilterOpen={relevanceFilterOpen}
        imageSizeOpen={imageSizeOpen}
        excludedTags={excludedTags}
        handleExcludedTagsChange={handleExcludedTagsChange}
        excludedCountOnPage={excludedCountOnPage}
        posts={posts}
        totalPosts={totalPosts}
        relevanceThreshold={relevanceThreshold}
        handleRelevanceThresholdChange={handleRelevanceThresholdChange}
        postScoresMap={postScoresMap}
        columnWidth={columnWidth}
        handleColumnWidthChange={handleColumnWidthChange}
        dispatch={dispatch}
      />
      <SearchBar
        onSearch={handleSearch}
        searchQuery={searchQuery}
        onClearSearch={clearSearch}
        totalPosts={totalPosts}
        availableTags={availableTags}
      />
      {searchQuery && <CharacterInfoBar tag={searchQuery} onSelect={handleSearch} />}

      <Box sx={{
        mx: 'auto',
        maxWidth: '100%',
        minWidth: '100%',
        width: '100%',
        overflow: 'visible',
        px: { xs: 1, sm: 2, md: 3 },
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
      }}>
        <PostsPageContent
          isLoading={isLoading}
          isError={isError}
          currentPage={currentPage}
          totalPages={totalPages}
          perPage={perPage}
          totalPosts={totalPosts}
          sortOption={sortOption}
          handleSortChange={handleSortChange}
          handlePageChange={handlePageChange}
          handlePerPageChange={handlePerPageChange}
          onOpenExcludedTags={withFilters ? () => dispatch({ type: 'OPEN_EXCLUDED_TAGS' }) : undefined}
          onOpenRelevanceFilter={withFilters ? () => dispatch({ type: 'OPEN_RELEVANCE_FILTER' }) : undefined}
          excludedCountOnPage={excludedCountOnPage}
          relevanceRemovedCount={relevanceRemovedCount}
          onOpenImageSize={() => dispatch({ type: 'OPEN_IMAGE_SIZE' })}
          displayPosts={displayPosts}
          onImageClick={onImageClick}
          handleNotify={handleNotify}
          groupMap={groupMap}
          columnWidth={columnWidth}
          isSandbox={isSandbox}
          sandboxMin={sandboxMin}
          sandboxMax={sandboxMax}
          handleClearSandbox={handleClearSandbox}
          clearSearch={clearSearch}
          searchQuery={searchQuery}
          handleRetry={refetch}
          emptyKey={emptyKey}
          t={t}
        />
      </Box>

      {/* PhotoSwipe caption via Portal */}
      {activePost && captionContainerRef.current && createPortal(
        <CaptionContent
          post={activePost}
          getTagColors={getTagColors}
          getTagTranslation={getTagTranslation}
          handleTagClick={closeLightboxAndSearch}
        />,
        captionContainerRef.current
      )}

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert onClose={handleCloseSnackbar} severity={snackbar.severity} variant="filled" sx={{ width: '100%' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </AppLayout>
  );
};

export default PostsPage;
