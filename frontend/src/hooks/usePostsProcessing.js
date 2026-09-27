import { useMemo } from 'react';
import { tagManager } from '../utils/TagManager';

/**
 * Sort helper used by PostsPage
 */
function sortPosts(posts, sortOption) {
  return posts.toSorted((a, b) => {
    switch (sortOption) {
      case 'score':
        return (b.data.score || 0) - (a.data.score || 0);
      case 'id':
        return (b.id || 0) - (a.id || 0);
      case 'similarity':
        // post.similarity comes from the API (cosine to user profile).
        // null (post not embedded yet) sorts to the bottom.
        return (b.similarity ?? 0) - (a.similarity ?? 0);
      case 'file_size':
        return (b.data.file_size || 0) - (a.data.file_size || 0);
      case 'resolution': {
        const aPixels = (a.data.width || 0) * (a.data.height || 0);
        const bPixels = (b.data.width || 0) * (b.data.height || 0);
        return bPixels - aPixels;
      }
      case 'waifu_pillow': {
        const aRatio = (a.data.width || 0) / (a.data.height || 1);
        const bRatio = (b.data.width || 0) / (b.data.height || 1);
        const aIsWaifu = aRatio > 2 ? 1 : 0;
        const bIsWaifu = bRatio > 2 ? 1 : 0;
        if (aIsWaifu !== bIsWaifu) return bIsWaifu - aIsWaifu;
        return bRatio - aRatio;
      }
      case 'shuffle': {
        const seedA = (a.id || 0) * 9301 + 49297;
        const seedB = (b.id || 0) * 9301 + 49297;
        return (seedA % 233280) - (seedB % 233280);
      }
      default:
        return 0;
    }
  });
}

/**
 * 排除标签过滤 — 统计用（按单帖计算，不含组级逻辑）
 */
function filterByExcludedTags(posts, excludedTags) {
  if (!excludedTags.length) return posts;
  return posts.filter(post => {
    const tagsString = tagManager.getPostTagsString(post);
    if (!tagsString) return true;
    const postTags = tagsString.split(' ').filter(Boolean);
    return !excludedTags.some(t => postTags.includes(t));
  });
}

/**
 * 相关度阈值过滤 — 统计用（按单帖计算，不含组级逻辑）
 */
function filterByRelevance(posts, threshold, postScoresMap) {
  if (threshold <= 0 || !postScoresMap.size) return posts;
  return posts.filter(post => (postScoresMap.get(post.id) || 0) >= threshold);
}

/**
 * 帖子分组（parent/child 合并显示）
 * Returns groupMap: parentId → [parent, ...children], and hiddenIds (child ids).
 */
function groupPosts(posts) {
  const childrenByParent = new Map();
  const postById = new Map();

  posts.forEach(post => {
    postById.set(post.id, post);
    const parentId = post.data?.parent_id;
    if (parentId && parentId !== post.id) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(post);
    }
  });

  const hiddenIds = new Set();
  const groupMap = new Map();
  childrenByParent.forEach((children, parentId) => {
    if (postById.has(parentId)) {
      children.forEach(child => hiddenIds.add(child.id));
      groupMap.set(parentId, [postById.get(parentId), ...children]);
    }
  });

  return { groupMap, hiddenIds };
}

/**
 * Apply excluded-tags filter at the GROUP level.
 * A group survives if its parent survives; orphan children are filtered individually.
 */
function filterGroupsByExcludedTags(posts, groupMap, excludedTags) {
  if (!excludedTags.length) return posts;
  const parentIds = new Set(groupMap.keys());
  return posts.filter(post => {
    const isParent = parentIds.has(post.id);
    const isChild = groupMap.has(post.data?.parent_id) &&
      groupMap.get(post.data.parent_id).some(m => m.id === post.id);
    // If this post is a group parent, its filter result governs the whole group.
    // If it's a child, it was already hidden by grouping — keep it only if
    // its parent passed (handled by parent filter below).
    const tagsString = tagManager.getPostTagsString(post);
    if (!tagsString) return true;
    const postTags = tagsString.split(' ').filter(Boolean);
    const passes = !excludedTags.some(t => postTags.includes(t));
    if (isParent) return passes;
    // Non-parent, non-grouped-child: filter individually
    if (!isChild) return passes;
    // Grouped child: only keep if parent passes (so groupMap stays intact)
    const parent = groupMap.get(post.data.parent_id)[0];
    const parentTagsString = tagManager.getPostTagsString(parent);
    if (!parentTagsString) return true;
    const parentTags = parentTagsString.split(' ').filter(Boolean);
    return !excludedTags.some(t => parentTags.includes(t));
  });
}

/**
 * Apply relevance-threshold filter at the GROUP level.
 * A group survives if the MAX score among its members >= threshold;
 * orphan children (parent not in page) are filtered individually.
 */
function filterGroupsByRelevance(posts, groupMap, threshold, postScoresMap) {
  if (threshold <= 0 || !postScoresMap.size) return posts;

  // Pre-compute max score per group
  const groupMaxScore = new Map();
  groupMap.forEach((members, parentId) => {
    const max = Math.max(...members.map(m => postScoresMap.get(m.id) || 0));
    groupMaxScore.set(parentId, max);
  });

  // Build a lookup: childId -> parentId (for grouped children only)
  const childToParent = new Map();
  groupMap.forEach((members, parentId) => {
    members.slice(1).forEach(m => childToParent.set(m.id, parentId));
  });

  return posts.filter(post => {
    const parentId = childToParent.get(post.id);
    if (parentId) {
      // Grouped child — keep if group max score passes
      return groupMaxScore.get(parentId) >= threshold;
    }
    if (groupMap.has(post.id)) {
      // Group parent — keep if group max score passes
      return groupMaxScore.get(post.id) >= threshold;
    }
    // Standalone post (no group) — filter by own score
    return (postScoresMap.get(post.id) || 0) >= threshold;
  });
}

/**
 * 统一的帖子处理 hook
 *
 * @param {Object} options
 * @param {Array}  options.posts            - 原始帖子列表
 * @param {string} options.sortOption       - 排序方式
 * @param {Array}  options.excludedTags     - 排除的标签列表（默认 []）
 * @param {number} options.relevanceThreshold - 相关度阈值（默认 0）
 * @param {Map}    options.postScoresMap    - 帖子相关度分数 Map（默认空 Map）
 * @param {boolean} options.enableGrouping  - 是否启用分组（默认 false）
 */
export function usePostsProcessing({
  posts,
  sortOption,
  excludedTags = [],
  relevanceThreshold = 0,
  postScoresMap = new Map(),
  enableGrouping = false,
}) {
  // 排除标签过滤统计
  const excludedCountOnPage = useMemo(() => {
    if (!posts?.length || !excludedTags.length) return 0;
    return posts.reduce((acc, post) => {
      const tagsString = tagManager.getPostTagsString(post);
      if (!tagsString) return acc;
      const postTags = tagsString.split(' ').filter(Boolean);
      return acc + (excludedTags.some(t => postTags.includes(t)) ? 1 : 0);
    }, 0);
  }, [posts, excludedTags]);

  // 相关度过滤统计
  const relevanceRemovedCount = useMemo(() => {
    if (!posts?.length || relevanceThreshold <= 0 || !postScoresMap.size) return 0;
    let removed = 0;
    posts.forEach(post => {
      if ((postScoresMap.get(post.id) || 0) < relevanceThreshold) removed++;
    });
    return removed;
  }, [posts, relevanceThreshold, postScoresMap]);

  // Pipeline: group -> excluded tags -> relevance -> sort
  // 分组在过滤之前，确保父帖被过滤时整组一起移除，子帖不会成为孤儿。
  const { postsForGrid, displayPosts, groupMap } = useMemo(() => {
    if (!posts.length) return { postsForGrid: posts, displayPosts: posts, groupMap: new Map() };

    // 先分组（在过滤之前，确保父帖子帖同进同出）
    let gm = new Map();
    let hiddenIds = new Set();
    if (enableGrouping) {
      const result = groupPosts(posts);
      gm = result.groupMap;
      hiddenIds = result.hiddenIds;
    }

    // 组级排除标签过滤
    const afterExclude = filterGroupsByExcludedTags(posts, gm, excludedTags);

    // 组级相关度过滤
    const afterRelevance = filterGroupsByRelevance(afterExclude, gm, relevanceThreshold, postScoresMap);

    // 排序
    const sorted = sortPosts(afterRelevance, sortOption);

    // postsForGrid = all posts that survived filtering (including children, for PhotoSwipe)
    // displayPosts = only visible posts (children hidden)
    const dp = enableGrouping
      ? sorted.filter(post => !hiddenIds.has(post.id))
      : sorted;

    return { postsForGrid: sorted, displayPosts: dp, groupMap: gm };
  }, [posts, sortOption, excludedTags, relevanceThreshold, postScoresMap, enableGrouping]);

  return {
    postsForGrid,
    displayPosts,
    groupMap,
    excludedCountOnPage,
    relevanceRemovedCount,
  };
}
