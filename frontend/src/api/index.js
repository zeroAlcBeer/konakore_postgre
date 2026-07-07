import axios from 'axios';

const apiClient = axios.create({
  baseURL: '/api',
});

export const getPosts = async (page = 1, limit = 100, liked = null, likedArtists = null) => {
  const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() });
  if (liked !== null) {
    params.append('liked', liked.toString());
  }
  if (likedArtists !== null) {
    params.append('liked_artists', likedArtists.toString());
  }
  const response = await apiClient.get(`/v1/posts?${params}`);
  return response.data;
};

export const getTags = async (page = 1, limit = 100, liked = null) => {
  const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() });
  if (liked !== null) {
    params.append('liked', liked.toString());
  }
  const response = await apiClient.get(`/v1/tags?${params}`);
  return response.data.tags;
};

export const searchTags = async (query, page = 1, pageSize = 100, liked = null) => {
  const requestBody = { 
    query: query, 
    page: page,
    pageSize: pageSize
  };
  if (liked !== null) {
    requestBody.liked = liked;
  }
  const response = await apiClient.post('/v1/tags:search', requestBody);
  return response.data;
};

const likePost = async (postId) => {
  const response = await apiClient.post(`/v1/posts/${postId}:like`);
  return response.data;
};

const unlikePost = async (postId) => {
  const response = await apiClient.post(`/v1/posts/${postId}:unlike`);
  return response.data;
};

// 保留旧的 toggleLike 函数以保持向后兼容，但内部实现需要先获取当前状态
export const toggleLike = async (postId, currentLikeState) => {
  if (currentLikeState) {
    return await unlikePost(postId);
  } else {
    return await likePost(postId);
  }
};

export const getUserPreferences = async () => {
  const response = await apiClient.get('/v1/users/me/preferences');
  return response.data;
};

export const getStatsOverview = async () => {
  const response = await apiClient.get('/v1/stats/overview');
  return response.data;
};

const getPageForId = async (id, limit, liked = null) => {
  const params = new URLSearchParams({ id: id.toString(), limit: limit.toString() });
  if (liked !== null) params.append('liked', liked.toString());
  const response = await apiClient.get(`/v1/posts/page-for-id?${params}`);
  return response.data;
};

export const getSandboxPosts = async (idMin, idMax, page = 1, limit = 100, liked = null) => {
  const params = new URLSearchParams({
    id_min: idMin.toString(),
    id_max: idMax.toString(),
    page: page.toString(),
    limit: limit.toString(),
  });
  if (liked !== null) params.append('liked', liked.toString());
  const response = await apiClient.get(`/v1/posts/sandbox?${params}`);
  return response.data;
};

export const getStatsDistribution = async (idMin, idMax) => {
  const params = new URLSearchParams();
  if (idMin != null) params.append('id_min', idMin.toString());
  if (idMax != null) params.append('id_max', idMax.toString());
  const response = await apiClient.get(`/v1/stats/distribution?${params}`);
  return response.data;
};

export const getTasks = async () => {
  const response = await apiClient.get('/v1/tasks');
  return response.data;
};
