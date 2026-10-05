import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Chip, CircularProgress, Typography } from '@mui/material';
import { ErrorOutline as ErrorIcon } from '@mui/icons-material';

import AppLayout from '../components/AppLayout';
import SimplePagination from '../components/SimplePagination';
import { getCharacters } from '../api';
import { useTag } from '../contexts/TagContext';
import CharacterMasonry from '../components/CharacterMasonry';
import { INDEX_PAGE_SIZE, chineseName, listRequest } from '../utils/characters';

/** Character index: a paged, breathing masonry of covers; contract in docs/characters.md, UI. */
export default function CharactersPage() {
  const { t } = useTranslation();
  const { translations } = useTag();
  const [searchParams, setSearchParams] = useSearchParams();
  const { work, page } = listRequest(searchParams);

  const update = (changes) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    return next;
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['characters', work, page],
    queryFn: () => getCharacters({ work, page, limit: INDEX_PAGE_SIZE }),
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
  });
  const characters = data?.characters || [];
  const pagination = data?.pagination;

  return (
    <AppLayout>
      <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, pb: 6, }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', minHeight: 32, mb: 1.5 }}>
          {work && (
            <Chip color="primary" onDelete={() => update({ work: null, page: null })}
              label={`${t('characters.work')}: ${chineseName(work, translations) || work}`} />
          )}
          {pagination && (
            <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {t('characters.total', { count: pagination.total_items.toLocaleString() })}
              {pagination.total_pages > 1 && ` · ${t('pagination.pageInfo', { current: page, total: pagination.total_pages })}`}
            </Typography>
          )}
        </Box>

        {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>}
        {isError && (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, py: 8 }}>
            <ErrorIcon color="error" />
            <Typography color="error">{t('status.loadError')}</Typography>
          </Box>
        )}
        {!isLoading && !isError && characters.length === 0 && (
          <Typography color="text.secondary" sx={{ py: 8, textAlign: 'center' }}>{t('characters.empty')}</Typography>
        )}

        {characters.length > 0 && (
          // Keyed by the data itself: placeholder data from the previous page must not reuse this breath state.
          <CharacterMasonry key={characters.map((c) => c.name).join('|')} characters={characters} translations={translations} />
        )}

        {pagination && (
          <Box sx={{ mt: 3 }}>
            <SimplePagination
              currentPage={page}
              totalPages={pagination.total_pages}
              onPageChange={(p) => { update({ page: p > 1 ? String(p) : null }); window.scrollTo({ top: 0 }); }}
            />
          </Box>
        )}
      </Box>
    </AppLayout>
  );
}
