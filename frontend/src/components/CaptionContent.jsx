import React from 'react';
import { Chip, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link as LinkIcon, AspectRatio as SizeIcon, Star as ScoreIcon, DateRange as DateIcon, Storage as FileIcon, Favorite as FavoriteIcon } from '@mui/icons-material';
import { formatFileSize, formatDate } from '../utils/formatters';
import { getImageDimensionsText } from '../utils/imageUtils';

const chipSx = (bg) => ({
  backgroundColor: bg,
  color: '#fff',
  fontWeight: 500,
  fontSize: '12px',
  '& .MuiChip-label': {
    fontWeight: 500,
  }
});

const CaptionContent = ({ post, getTagColors, getTagTranslation, handleTagClick }) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const captionColors = theme.palette.caption || {};

  return (
      <div style={{
        padding: '16px',
        background: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(8px)',
        borderRadius: '12px',
        margin: '8px',
        color: 'white',
        minWidth: '320px'
      }}>
        {/* Tags */}
        <div style={{
          display: 'flex',
          gap: '4px',
          justifyContent: 'center',
          flexWrap: 'wrap',
          maxWidth: '80vw',
          marginBottom: '16px'
        }}>
          {post.data.tags?.split(' ').filter(Boolean).map((tag, tagIndex) => {
            const tagColors = getTagColors(tag);
            const translatedTag = getTagTranslation(tag);
            return (
              <Chip
                key={tagIndex}
                label={translatedTag}
                size="small"
                clickable
                data-tag={tag}
                onClick={(e) => { e.stopPropagation(); handleTagClick(tag); }}
                sx={{
                  fontSize: '12px',
                  height: '24px',
                  cursor: 'pointer',
                  backgroundColor: tagColors.backgroundColor,
                  color: tagColors.color,
                  border: tagColors.border,
                  fontWeight: 400,
                  '&:hover': { backgroundColor: tagColors.hoverColor },
                  '& .MuiChip-label': { px: 1 }
                }}
              />
            );
          })}
        </div>

        {/* Info */}
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          justifyContent: 'center',
          alignItems: 'center'
        }}>
          <Chip
            icon={<LinkIcon sx={{ color: '#fff !important' }} />}
            label={
              <a
                href={`https://konachan.com/post/show/${post.id}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#fff', textDecoration: 'none', fontWeight: 500 }}
              >
                {post.id}
              </a>
            }
            size="small"
            sx={{ ...chipSx(captionColors.link), '&:hover': { opacity: 1 } }}
          />
          <Chip
            icon={<FileIcon sx={{ color: '#fff !important' }} />}
            label={post.data.jpeg_file_size === 0
              ? formatFileSize(post.data.file_size)
              : `${formatFileSize(post.data.jpeg_file_size)} / ${formatFileSize(post.data.file_size)}`
            }
            size="small"
            sx={chipSx(captionColors.file)}
          />
          <Chip
            icon={<SizeIcon sx={{ color: '#fff !important' }} />}
            label={getImageDimensionsText(post.data)}
            size="small"
            sx={chipSx(captionColors.size)}
          />
          <Chip
            icon={<ScoreIcon sx={{ color: '#fff !important' }} />}
            label={post.data.score !== undefined ? post.data.score : 'N/A'}
            size="small"
            sx={chipSx(captionColors.score)}
          />
          <Chip
            icon={<DateIcon sx={{ color: '#fff !important' }} />}
            label={formatDate(post.data.created_at)}
            size="small"
            sx={chipSx(captionColors.date)}
          />
          {post.liked && (
            <Chip
              icon={<FavoriteIcon sx={{ color: '#fff !important' }} />}
              label={t('like.liked')}
              size="small"
              sx={chipSx(captionColors.liked)}
            />
          )}
        </div>
      </div>
  );
};

export default CaptionContent;
