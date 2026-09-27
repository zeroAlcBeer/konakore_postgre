import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Card, CardMedia, IconButton, Box, Skeleton, Fade, Grow } from '@mui/material';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import ImageNotSupportedIcon from '@mui/icons-material/ImageNotSupported';
import { useInView } from 'react-intersection-observer';
import { useToggleLike } from '../hooks/useToggleLike';
import { getImageUrl } from '../utils/imageUtils';
import { connectivityService } from '../utils/ConnectivityService';

const EMPTY_MEMBERS = [];

// Image load state — grouped so one logical update is one render.
const imageStateInit = () => ({ loaded: false, error: false, shouldLoad: false });

function imageStateReducer(state, action) {
  switch (action.type) {
    case 'ENTER_VIEW':
      return state.shouldLoad ? state : { ...state, shouldLoad: true };
    case 'LOADED':
      return { ...state, loaded: true, error: false };
    case 'ERROR':
      return { ...state, loaded: false, error: true };
    case 'RESET':
      return imageStateInit();
    case 'RETRY':
      return { loaded: false, error: false, shouldLoad: false };
    case 'RETRY_CONFIRM':
      return { loaded: false, error: false, shouldLoad: true };
    default:
      return state;
  }
}

// Error / offline placeholder — extracted so the parent stays readable.
function ImageError({ isOffline }) {
  return (
    <Grow in={true} timeout={400}>
      <Box
        sx={{
          width: '100%',
          height: '100%',
          minHeight: 200,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'grey.800',
          color: 'grey.500',
          cursor: 'default',
          textAlign: 'center',
          px: 2,
          gap: 1
        }}
      >
        {isOffline ? (
          <CloudOffIcon sx={{ fontSize: 52, color: 'grey.500' }} />
        ) : (
          <ImageNotSupportedIcon sx={{ fontSize: 52, color: 'grey.500' }} />
        )}
      </Box>
    </Grow>
  );
}

// Like button — extracted so the parent stays readable.
function LikeButton({ isLiked, isPending, onClick }) {
  return (
    <Fade in={true} timeout={800}>
      <Box
        sx={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          backgroundColor: 'rgba(0, 0, 0, 0.4)',
          borderRadius: '50%',
        }}
      >
        <IconButton
          aria-label="add to favorites"
          onClick={onClick}
          disabled={isPending}
          size="small"
          sx={{
            minWidth: 44,
            minHeight: 44,
            transition: 'transform 0.2s ease',
            '&:hover': {
              transform: 'scale(1.1)',
            }
          }}
        >
          {isLiked ? (
            <FavoriteIcon sx={{ color: 'red' }} fontSize="inherit" />
          ) : (
            <FavoriteBorderIcon sx={{ color: 'white' }} fontSize="inherit" />
          )}
        </IconButton>
      </Box>
    </Fade>
  );
}

const LazyImageCard = ({ post, index, onImageClick, onNotify, groupCount, groupMembers = EMPTY_MEMBERS }) => {
  const [imageState, dispatch] = useReducer(imageStateReducer, undefined, imageStateInit);
  const [isOffline, setIsOffline] = useState(() => !connectivityService.isOnline);
  const [hovered, setHovered] = useState(false);
  const imgRef = useRef(null);

  // 懒加载监听
  const { ref, inView } = useInView({
    threshold: 0,
    rootMargin: '600px 0px'
  });

  // 进入视口即加载
  useEffect(() => {
    if (inView) dispatch({ type: 'ENTER_VIEW' });
  }, [inView]);

  // 缓存命中时 onLoad 可能在 React 挂载前就触发了，用 img.complete 兜底
  useEffect(() => {
    if (
      imageState.shouldLoad &&
      !imageState.loaded &&
      !imageState.error &&
      imgRef.current?.complete &&
      imgRef.current.naturalWidth > 0
    ) {
      dispatch({ type: 'LOADED' });
    }
  }, [imageState.shouldLoad, imageState.loaded, imageState.error]);

  // 监听连通性服务
  useEffect(() => {
    const handleConnectivityChange = (online) => {
      setIsOffline(!online);

      // 如果网络恢复，且当前图片处于错误状态，且在视野内，则重试
      if (online && imageState.error && inView) {
        console.log(`Network restored, retrying image for post ${post.id}`);
        dispatch({ type: 'RETRY' });
        setTimeout(() => dispatch({ type: 'RETRY_CONFIRM' }), 50);
      }
    };

    const unsubscribe = connectivityService.subscribe(handleConnectivityChange);
    return unsubscribe;
  }, [imageState.error, inView, post.id]);

  // 重置图片状态当 post id 变化（ref-based prev comparison, no effect）
  const prevPostIdRef = useRef(post.id);
  if (post.id !== prevPostIdRef.current) {
    prevPostIdRef.current = post.id;
    dispatch({ type: 'RESET' });
  }

  const handleImageLoad = () => dispatch({ type: 'LOADED' });

  const handleImageError = () => {
    console.warn(`Image load failed for post ${post.id}`);
    dispatch({ type: 'ERROR' });
    connectivityService.reportFailure();
  };

  // Liked state comes from the query cache via props; the hook updates it.
  const { mutate: setLiked, isPending: likePending } = useToggleLike({ onNotify });

  const handleLike = (e) => {
    e.stopPropagation();
    setLiked({ postId: post.id, liked: !post.liked });
  };

  const imageUrl = getImageUrl(post.data?.preview_url);

  // --- Stacked card visual ---
  // Rest: 1 back layer (first child) tilted behind the main image.
  // Hover: all children fan out to the right with increasing rotation,
  // revealing how many items are in the group.
  const isGrouped = groupCount > 1 && groupMembers.length > 1;
  const children = isGrouped ? groupMembers.slice(1) : []; // exclude parent (members[0])
  const PEEK = 7;

  return (
    <>
      <Card
        ref={ref}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        sx={{
          position: 'relative',
          cursor: 'pointer',
          lineHeight: 0,
          overflow: 'visible',
          // Lift above sibling cards when hovered so fan-out isn't clipped by neighbors
          zIndex: hovered ? 100 : 'auto',
          aspectRatio: post.data?.width && post.data?.height
            ? `${post.data.width} / ${post.data.height}`
            : '4 / 3'
        }}
      >
        {/* Back layers: at rest only the first child; on hover all children fan out */}
        {isGrouped && children.map((child, k) => {
          const childUrl = getImageUrl(child.data?.preview_url);
          // Rest: only k=0 is visible (depth 1), others hidden at same position
          // Hover: all fan out with increasing offset + rotation
          const restX = PEEK;
          const restY = PEEK * 0.6;
          const restRot = 2;
          const hoverX = 24 + k * 26;
          const hoverY = 4 + k * 3;
          const hoverRot = -6 - k * 9;
          const x = hovered ? hoverX : restX;
          const y = hovered ? hoverY : restY;
          const rot = hovered ? hoverRot : restRot;
          const shadow = hovered
            ? '0 8px 20px rgba(0,0,0,0.55)'
            : '0 4px 10px rgba(0,0,0,0.5)';
          return (
            <Box
              key={`stack-${child.id}`}
              onClick={(e) => { e.stopPropagation(); onImageClick(index); }}
              sx={{
                position: 'absolute',
                top: y,
                left: x,
                right: -x,
                bottom: -y,
                borderRadius: '8px',
                overflow: 'hidden',
                boxShadow: shadow,
                transform: `rotate(${rot}deg)`,
                // At rest behind main image; on hover above main image so fan-out floats on top
                zIndex: hovered ? 30 + k : 5 + k,
                backgroundColor: 'grey.900',
                transition: 'transform 0.28s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.28s ease, opacity 0.2s ease, z-index 0s',
                // At rest, hide all but the first back layer
                opacity: (!hovered && k > 0) ? 0 : 1,
                pointerEvents: hovered ? 'auto' : (k === 0 ? 'auto' : 'none'),
              }}
            >
              <Box
                component="img"
                src={childUrl}
                alt={child.data?.tags || 'grouped image'}
                loading="lazy"
                sx={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
              />
            </Box>
          );
        })}

        {/* Main image surface */}
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: isGrouped ? PEEK : 0,
            bottom: isGrouped ? PEEK * 0.6 : 0,
            overflow: 'hidden',
            borderRadius: '8px',
            boxShadow: '0 6px 16px rgba(0,0,0,0.6)',
            zIndex: 20,
            // Unified hover: tilt to rotate(1deg); rest: grouped tilts -1deg, others flat
            transform: hovered ? 'rotate(1deg)' : (isGrouped ? 'rotate(-1deg)' : 'none'),
            transition: 'transform 0.28s cubic-bezier(0.34,1.56,0.64,1)',
          }}
        >
          {imageState.shouldLoad ? (
            <>
              {/* img 始终正常布局占位，Skeleton 绝对定位覆盖其上 */}
              {!imageState.error && (
                <CardMedia
                  ref={imgRef}
                  component="img"
                  decoding="async"
                  image={imageUrl}
                  alt={post.data?.tags || 'Post image'}
                  onClick={() => onImageClick(index)}
                  onLoad={handleImageLoad}
                  onError={handleImageError}
                  sx={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    opacity: imageState.loaded ? 1 : 0,
                    cursor: 'pointer',
                    transition: 'opacity 0.3s ease',
                    '@media (prefers-reduced-motion: reduce)': {
                      transition: 'none',
                    },
                  }}
                />
              )}

              {(!imageState.loaded && !imageState.error) && (
                <Skeleton
                  variant="rectangular"
                  animation="wave"
                  sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                  }}
                />
              )}

              {imageState.error && <ImageError isOffline={isOffline} />}

              {imageState.loaded && (
                <LikeButton
                  isLiked={post.liked}
                  isPending={likePending}
                  onClick={handleLike}
                />
              )}

              {/* 分组数量 badge */}
              {groupCount > 1 && imageState.loaded && (
                <Fade in={true} timeout={800}>
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 8,
                      left: 8,
                      backgroundColor: 'rgba(255, 160, 0, 0.9)',
                      color: '#fff',
                      borderRadius: '12px',
                      px: 1,
                      py: 0.25,
                      fontSize: '12px',
                      fontWeight: 700,
                      lineHeight: 1.4,
                      fontFamily: 'inherit',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                    }}
                  >
                    {groupCount}
                  </Box>
                </Fade>
              )}
            </>
          ) : (
            <Skeleton
              variant="rectangular"
              width="100%"
              height="100%"
              animation="wave"
            />
          )}
        </Box>
      </Card>
    </>
  );
};

export default LazyImageCard;
