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
        // Keep the API order: families newest-first by their head, members
        // after it. Re-sorting by id would scatter a family's members.
        return 0;
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
 * Group posts by family (post.family_id from the API; a post without one is
 * its own family). The API pages by family, so a page holds whole families.
 * Returns groupMap: representativeId -> [representative, ...others] for
 * families with 2+ posts on the page, and hiddenIds (the non-representatives).
 * The representative is the family root when present, else the newest member.
 */
function groupPosts(posts) {
  const membersByFamily = new Map();
  posts.forEach(post => {
    const familyId = post.family_id ?? post.id;
    if (!membersByFamily.has(familyId)) membersByFamily.set(familyId, []);
    membersByFamily.get(familyId).push(post);
  });

  const hiddenIds = new Set();
  const groupMap = new Map();
  membersByFamily.forEach((members, familyId) => {
    if (members.length < 2) return;
    const representative = members.find(m => m.id === familyId) || members[0];
    const others = members.filter(m => m !== representative);
    others.forEach(m => hiddenIds.add(m.id));
    groupMap.set(representative.id, [representative, ...others]);
  });

  return { groupMap, hiddenIds };
}

/**
 * Apply excluded-tags filter at the GROUP level.
 * The representative's tags decide for its whole group.
 */
function filterGroupsByExcludedTags(posts, groupMap, excludedTags) {
  if (!excludedTags.length) return posts;
  const passes = (post) => {
    const tagsString = tagManager.getPostTagsString(post);
    if (!tagsString) return true;
    const postTags = tagsString.split(' ').filter(Boolean);
    return !excludedTags.some(t => postTags.includes(t));
  };
  const memberToRepresentative = new Map();
  groupMap.forEach(members => {
    members.forEach(m => memberToRepresentative.set(m.id, members[0]));
  });
  return posts.filter(post => passes(memberToRepresentative.get(post.id) || post));
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
