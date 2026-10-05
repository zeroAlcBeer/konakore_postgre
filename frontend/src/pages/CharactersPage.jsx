import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Box, Card, CardActionArea, CardContent, CardMedia, Chip, CircularProgress, Typography,
} from '@mui/material';
import { ErrorOutline as ErrorIcon } from '@mui/icons-material';

import AppLayout from '../components/AppLayout';
import SimplePagination from '../components/SimplePagination';
import { getCharacters } from '../api';
import { useTag } from '../contexts/TagContext';
import { chineseName, coverUrl, gallerySearchPath, listRequest } from '../utils/characters';

const PAGE_SIZE = 24;

function CharacterCard({ character, translations, onWorkClick, t }) {
  const zh = chineseName(character.name, translations);
  const cover = coverUrl(character.cover);
  return (
    <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column' }}>
      <CardActionArea component={RouterLink} to={gallerySearchPath(character.name)}>
        {cover ? (
          <CardMedia component="img" image={cover} alt={character.name} loading="lazy"
            sx={{ aspectRatio: '3 / 2', objectFit: 'cover' }} />
        ) : (
          <Box sx={{ aspectRatio: '3 / 2', bgcolor: 'action.hover' }} />
        )}
        <CardContent sx={{ pb: 1 }}>
          <Typography variant="subtitle1" noWrap title={zh || character.name}>{zh || character.name}</Typography>
          {zh && <Typography variant="caption" color="text.secondary" noWrap component="div">{character.name}</Typography>}
          <Typography variant="body2" color="text.secondary">
            {t('characters.families', { count: character.family_count.toLocaleString() })}
          </Typography>
        </CardContent>
      </CardActionArea>
      {character.work && (
        <Box sx={{ px: 2, pb: 1.5, mt: 'auto' }}>
          <Chip size="small" variant="outlined" onClick={() => onWorkClick(character.work)}
            label={chineseName(character.work, translations) || character.work} />
        </Box>
      )}
    </Card>
  );
}

/** Character index; contract in docs/characters.md, UI. */
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
    queryFn: () => getCharacters({ work, page, limit: PAGE_SIZE }),
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
  });
  const characters = data?.characters || [];
  const pagination = data?.pagination;

  return (
    <AppLayout>
      <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', minHeight: 32 }}>
          {work && (
            <Chip color="primary" onDelete={() => update({ work: null, page: null })}
              label={`${t('characters.work')}: ${chineseName(work, translations) || work}`} />
          )}
          {pagination && (
            <Typography variant="body2" color="text.secondary">
              {t('characters.total', { count: pagination.total_items.toLocaleString() })}
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

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {characters.map((c) => (
            <CharacterCard key={c.name} character={c} translations={translations} t={t}
              onWorkClick={(w) => update({ work: w, page: null })} />
          ))}
        </Box>

        {pagination && (
          <SimplePagination
            currentPage={page}
            totalPages={pagination.total_pages}
            onPageChange={(p) => { update({ page: p > 1 ? String(p) : null }); window.scrollTo({ top: 0 }); }}
          />
        )}
      </Box>
    </AppLayout>
  );
}
