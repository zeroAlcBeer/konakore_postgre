import React, { useState } from 'react';
import { Box, Pagination, Typography, Select, MenuItem, FormControl, InputLabel, TextField, Button, Stack, IconButton, Tooltip, Badge } from '@mui/material';
import { FilterAlt as FilterAltIcon, AutoAwesome as AutoAwesomeIcon, PhotoSizeSelectLarge as ImageSizeIcon } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';

const PaginationControls = ({
  currentPage,
  totalPages,
  onPageChange,
  perPage,
  onPerPageChange,
  totalItems,
  visibleCount,
  isLoading = false,
  sortOption,
  onSortChange,
  onOpenExcludedTags,
  onOpenRelevanceFilter,
  excludedCountOnPage = 0,
  relevanceRemovedCount = 0,
  onOpenImageSize,
  sandboxMin,
  sandboxMax,
  onClearSandbox,
  withSimilarity = true,
  summary,
}) => {
  const { t } = useTranslation();
  const [jumpToPage, setJumpToPage] = useState('');

  const showPagination = totalPages > 1;

  const handleJumpToPage = () => {
    const pageNumber = parseInt(jumpToPage, 10);
    if (pageNumber >= 1 && pageNumber <= totalPages) {
      onPageChange(pageNumber);
      setJumpToPage('');
    }
  };

  const handleInputKeyPress = (event) => {
    if (event.key === 'Enter') handleJumpToPage();
  };

  const handleInputChange = (event) => {
    const value = event.target.value;
    if (value === '' || /^\d+$/.test(value)) setJumpToPage(value);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', mt: 4, mb: 2, gap: 2 }}>
      <Box sx={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {summary ?? (
          <Typography variant="body2" color="text.secondary">
            {t('pagination.showing', {
              visible: visibleCount != null ? visibleCount : Math.min(perPage, totalItems - (currentPage - 1) * perPage),
              loaded: Math.min(perPage, totalItems - (currentPage - 1) * perPage),
              total: totalItems.toLocaleString(),
            })}
          </Typography>
          )}
          {sandboxMin != null && sandboxMax != null && (
            <Typography
              variant="body2"
              component="span"
              sx={{
                color: 'primary.main',
                display: 'inline-flex', alignItems: 'center', gap: 0.5,
              }}
            >
              · {t('pagination.sandboxRange', { min: sandboxMin.toLocaleString(), max: sandboxMax.toLocaleString() })}
              {onClearSandbox && (
                <Box
                  component="span"
                  onClick={onClearSandbox}
                  sx={{
                    cursor: 'pointer', ml: 0.5,
                    fontSize: 14, lineHeight: 1,
                    color: 'text.disabled',
                    '&:hover': { color: 'error.main' },
                  }}
                >
                  ✕
                </Box>
              )}
            </Typography>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          {showPagination && (
            <Pagination
              count={totalPages}
              page={currentPage}
              onChange={(event, value) => onPageChange(value)}
              disabled={isLoading}
              color="primary"
              showFirstButton
              showLastButton
              siblingCount={1}
              boundaryCount={1}
            />
          )}

          {showPagination && (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary">{t('pagination.jumpTo')}</Typography>
              <TextField
                size="small"
                value={jumpToPage}
                onChange={handleInputChange}
                onKeyPress={handleInputKeyPress}
                placeholder={t('pagination.page')}
                disabled={isLoading}
                sx={{ width: '70px', '& .MuiOutlinedInput-root': { height: '32px' } }}
                inputProps={{ min: 1, max: totalPages, style: { textAlign: 'center' } }}
              />
              <Button
                size="small"
                variant="outlined"
                onClick={handleJumpToPage}
                disabled={isLoading || !jumpToPage || parseInt(jumpToPage, 10) < 1 || parseInt(jumpToPage, 10) > totalPages}
                sx={{ minWidth: '50px', height: '32px' }}
              >
                {t('pagination.jump')}
              </Button>
            </Stack>
          )}
        </Box>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'flex-end', gap: 2, flexWrap: 'wrap' }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>{t('pagination.perPage')}</InputLabel>
          <Select value={perPage} label={t('pagination.perPage')} onChange={(e) => onPerPageChange(Number(e.target.value))} disabled={isLoading}>
            <MenuItem value={100}>{t('pagination.items', { count: 100 })}</MenuItem>
            <MenuItem value={200}>{t('pagination.items', { count: 200 })}</MenuItem>
            <MenuItem value={300}>{t('pagination.items', { count: 300 })}</MenuItem>
          </Select>
        </FormControl>

        {sortOption && onSortChange && (
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>{t('sort.label')}</InputLabel>
            <Select value={sortOption} label={t('sort.label')} onChange={(e) => onSortChange(e.target.value)} disabled={isLoading}>
              <MenuItem value="score">{t('sort.score')}</MenuItem>
              <MenuItem value="id">{t('sort.id')}</MenuItem>
              {withSimilarity && <MenuItem value="similarity">{t('sort.similarity')}</MenuItem>}
              <MenuItem value="file_size">{t('sort.fileSize')}</MenuItem>
              <MenuItem value="resolution">{t('sort.resolution')}</MenuItem>
              <MenuItem value="waifu_pillow">{t('sort.wideFirst')}</MenuItem>
              <MenuItem value="shuffle">{t('sort.shuffle')}</MenuItem>
            </Select>
          </FormControl>
        )}

        {Boolean(onOpenImageSize) && (
          <Tooltip title={t('grid.sizeTooltip')}>
            <IconButton onClick={onOpenImageSize} size="small" aria-label="image size">
              <ImageSizeIcon />
            </IconButton>
          </Tooltip>
        )}

        {Boolean(onOpenRelevanceFilter) && (
          <Tooltip title={relevanceRemovedCount > 0 ? t('filter.relevanceFilterTooltip', { count: relevanceRemovedCount }) : t('filter.relevanceFilterTooltipDefault')}>
            <IconButton onClick={onOpenRelevanceFilter} size="small" aria-label="relevance filter">
              <Badge badgeContent={relevanceRemovedCount > 0 ? relevanceRemovedCount : null} color="error" max={999}>
                <AutoAwesomeIcon />
              </Badge>
            </IconButton>
          </Tooltip>
        )}

        {Boolean(onOpenExcludedTags) && (
          <Tooltip title={excludedCountOnPage > 0 ? t('filter.excludedTagsTooltip', { count: excludedCountOnPage }) : t('filter.excludedTagsTooltipDefault')}>
            <IconButton onClick={onOpenExcludedTags} size="small" aria-label="excluded tags filter">
              <Badge badgeContent={excludedCountOnPage > 0 ? excludedCountOnPage : null} color="warning" max={999}>
                <FilterAltIcon />
              </Badge>
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
};

export default PaginationControls;
