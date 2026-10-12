import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { likePost, unlikePost } from '../api';

// Every query that holds a page of posts starts with this key, so one cache
// write reaches every view (feed, sandbox, search, favorites). The React Query
// cache is the only copy of a post's liked state on the client.
export const POST_LIST_KEY = 'post-list';

// Queries whose numbers depend on the liked set.
const LIKE_DEPENDENT_KEYS = [['stats-overview'], ['user-preferences'], ['character-count']];

function setLikedInPostLists(queryClient, postId, liked) {
  queryClient.setQueriesData({ queryKey: [POST_LIST_KEY] }, (data) => {
    if (!data?.posts?.some(p => p.id === postId)) return data;
    return { ...data, posts: data.posts.map(p => (p.id === postId ? { ...p, liked } : p)) };
  });
}

/**
 * The single like/unlike path for cards and the lightbox.
 * Call `mutate({ postId, liked })` with the desired new state.
 */
export function useToggleLike({ onNotify } = {}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: ({ postId, liked }) => (liked ? likePost(postId) : unlikePost(postId)),
    onMutate: async ({ postId, liked }) => {
      // Keep an in-flight fetch from overwriting the optimistic value.
      await queryClient.cancelQueries({ queryKey: [POST_LIST_KEY] });
      setLikedInPostLists(queryClient, postId, liked);
    },
    onSuccess: (data, { liked }) => {
      onNotify?.({
        message: data?.message || (liked ? t('like.added') : t('like.removed')),
        severity: 'success',
      });
    },
    onError: (error, { postId, liked }) => {
      console.error('Toggle like error:', error);
      setLikedInPostLists(queryClient, postId, !liked);
      onNotify?.({ message: t('like.failed'), severity: 'error' });
    },
    onSettled: () => {
      // Visible lists already show the new state; mark every list stale so
      // membership (a newly liked post in favorites) is refetched when a list
      // is shown next, without refetching every cached page right now.
      queryClient.invalidateQueries({ queryKey: [POST_LIST_KEY], refetchType: 'none' });
      LIKE_DEPENDENT_KEYS.forEach(queryKey => queryClient.invalidateQueries({ queryKey }));
    },
  });
}
