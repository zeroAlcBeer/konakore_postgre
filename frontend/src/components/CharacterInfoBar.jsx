import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Chip, Typography } from '@mui/material';

import { getCharacter } from '../api';
import { useTag } from '../contexts/TagContext';
import { chineseName } from '../utils/characters';

/**
 * Shown under the gallery search bar when the searched tag is a character;
 * renders nothing otherwise (the lookup 404s) and while it loads.
 * Contract: docs/characters.md, UI.
 */
export default function CharacterInfoBar({ tag, onSelect }) {
  const { t } = useTranslation();
  const { translations } = useTag();
  const { data } = useQuery({
    queryKey: ['character', tag],
    queryFn: () => getCharacter(tag),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  if (!data) return null;
  const zh = chineseName(data.name, translations);

  return (
    <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, mb: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography variant="subtitle1">{zh || data.name}</Typography>
        {zh && <Typography variant="body2" color="text.secondary">{data.name}</Typography>}
        {data.work && (
          <Chip size="small" variant="outlined" clickable component={RouterLink}
            to={`/characters?${new URLSearchParams({ work: data.work })}`}
            label={chineseName(data.work, translations) || data.work} />
        )}
        <Typography variant="body2" color="text.secondary">
          {t('characters.siteFamilies', { count: data.family_count.toLocaleString() })}
        </Typography>
      </Box>
      {data.cooccurring.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">{t('characters.cooccurring')}</Typography>
          {data.cooccurring.map((c) => (
            <Chip key={c.name} size="small" clickable onClick={() => onSelect(c.name)}
              label={`${chineseName(c.name, translations) || c.name} · ${c.family_count}`} />
          ))}
        </Box>
      )}
    </Box>
  );
}
