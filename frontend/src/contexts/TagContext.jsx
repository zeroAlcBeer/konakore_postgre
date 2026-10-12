import React, { createContext, use, useReducer, useEffect, useCallback } from 'react';
import { tagManager } from '../utils/TagManager';

// Context创建
const TagContext = createContext();

// Reducer处理状态变更
const tagReducer = (state, action) => {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'STORAGE_LOADED':
      return { 
        ...state, 
        tags: Array.from(action.payload.tags), 
        tagInfo: action.payload.tagInfo,
        isLoading: false 
      };
    case 'TAGS_ADDED':
      return { 
        ...state, 
        tags: [...new Set([...state.tags, ...action.payload])] 
      };
    case 'TAG_INFO_UPDATED':
      return { 
        ...state, 
        tagInfo: action.payload.tagInfo,
        tags: Array.from(action.payload.tags)
      };
    case 'TRANSLATIONS_LOADED':
      return { ...state, translations: action.payload };
    case 'CACHE_CLEARED':
      return { 
        ...state, 
        tags: [], 
        tagInfo: new Map(), 
        translations: null 
      };
    default:
      return state;
  }
};

// 初始状态
const initialState = {
  tags: [],
  tagInfo: new Map(),
  translations: null,
  isLoading: true
};

/**
 * TagProvider组件 - 为React组件提供标签状态和操作的统一接口
 */
export const TagProvider = ({ children }) => {
  const [state, dispatch] = useReducer(tagReducer, initialState);

  // 初始化：先订阅再加载，否则加载期间发出的事件（如 translations-loaded）会丢失
  useEffect(() => {
    const handleTagManagerUpdate = (event) => {
      switch (event.type) {
        case 'storage-loaded':
          dispatch({ type: 'STORAGE_LOADED', payload: event.data });
          break;
        case 'tags-added':
          dispatch({ type: 'TAGS_ADDED', payload: event.data });
          break;
        case 'tag-info-updated':
          dispatch({ type: 'TAG_INFO_UPDATED', payload: event.data });
          break;
        case 'translations-loaded':
          dispatch({ type: 'TRANSLATIONS_LOADED', payload: event.data });
          break;
        case 'cache-cleared':
          dispatch({ type: 'CACHE_CLEARED' });
          break;
        default:
          break;
      }
    };
    tagManager.subscribe(handleTagManagerUpdate);

    const initializeTags = async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      tagManager.loadFromStorage();
      await tagManager.initTranslation();
      // 翻译可能在订阅之前就已加载（另一个实例先取到了），补发一次
      if (tagManager.state.translations) {
        dispatch({ type: 'TRANSLATIONS_LOADED', payload: tagManager.state.translations });
      }
      dispatch({ type: 'SET_LOADING', payload: false });
    };
    initializeTags();

    return () => tagManager.unsubscribe(handleTagManagerUpdate);
  }, []);

  // 提供给组件的操作方法
  const tagOperations = {
    // 数据获取
    fetchTagInfo: useCallback((page, limit, liked) => 
      tagManager.fetchTagInfo(page, limit, liked), []),
    
    // 标签样式和显示
    getTagColors: useCallback((tagName) => 
      tagManager.getTagColors(tagName), []),
    getTagTranslation: useCallback((tagName) => 
      tagManager.getTagTranslation(tagName), []),
    getTagChinese: useCallback((tagName) => 
      tagManager.getTagChinese(tagName), []),
    getTagInfo: useCallback((tagName) => 
      tagManager.getTagInfo(tagName), []),
    
    // 标签操作
    addTagsToCache: useCallback((tags) => 
      tagManager.addTagsToCache(tags), []),
    extractTagsFromPosts: useCallback((posts) => 
      tagManager.extractTagsFromPosts(posts), []),
    mergeTagsWithCache: useCallback((currentTags) => 
      tagManager.mergeTagsWithCache(currentTags), []),
    getCachedTags: useCallback(() => 
      tagManager.getCachedTags(), []),
    
    // 翻译操作
    translateElements: useCallback(() => 
      tagManager.translateElements(), []),
    refreshTranslations: useCallback(() => 
      tagManager.refreshTranslations(), []),
    
    // 缓存操作
    clearCache: useCallback(() => 
      tagManager.clearCache(), []),
    saveToStorage: useCallback(() => 
      tagManager.saveToStorage(), []),
    loadFromStorage: useCallback(() => 
      tagManager.loadFromStorage(), [])
  };

  const contextValue = {
    // 状态
    ...state,
    
    // 操作方法
    ...tagOperations
  };

  return (
    <TagContext.Provider value={contextValue}>
      {children}
    </TagContext.Provider>
  );
};

/**
 * useTag Hook - 组件使用标签功能的统一接口
 */
export const useTag = () => {
  const context = use(TagContext);
  if (!context) {
    throw new Error('useTag must be used within a TagProvider');
  }
  return context;
};
