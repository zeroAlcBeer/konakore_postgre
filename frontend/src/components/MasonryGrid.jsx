import { useMemo, useCallback } from 'react';
import { MasonryPhotoAlbum } from 'react-photo-album';
import 'react-photo-album/masonry.css';
import { Box } from '@mui/material';
import { getImageUrl } from '../utils/imageUtils';

const MasonryGrid = ({ posts, onImageClick, LazyImageCard, isLoading, onNotify, groupMap, columnWidth = 260 }) => {
  const CardComponent = LazyImageCard;

  const photos = useMemo(() =>
    posts.map(post => ({
      src: getImageUrl(post.data?.preview_url),
      width: post.data?.width || 400,
      height: post.data?.height || 300,
      key: String(post.id),
      _post: post,
    })),
    [posts]
  );

  const columns = useCallback((containerWidth) => {
    return Math.max(1, Math.floor(containerWidth / columnWidth));
  }, [columnWidth]);

  // react-photo-album v3: render.photo receives (props, context)
  // context = { photo, index, width, height }
  const renderPhoto = useCallback((_imgProps, { photo, index, width, height }) => (
    <Box
      key={photo.key}
      sx={{ width, height, overflow: 'visible' }}
    >
      <CardComponent
        post={photo._post}
        index={index}
        onImageClick={onImageClick}
        groupCount={groupMap?.get(photo._post.id)?.length || 0}
        groupMembers={groupMap?.get(photo._post.id) || []}
        onNotify={onNotify}
      />
    </Box>
  ), [CardComponent, onImageClick, groupMap, onNotify]);

  if (!posts.length || isLoading) return null;

  return (
    <Box sx={{ width: '100%', overflow: 'visible', px: { xs: 1, sm: 2 } }}>
      <MasonryPhotoAlbum
        photos={photos}
        columns={columns}
        spacing={16}
        render={{ photo: renderPhoto }}
      />
    </Box>
  );
};

export default MasonryGrid;
