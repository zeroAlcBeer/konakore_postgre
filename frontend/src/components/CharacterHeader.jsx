import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Chip, Typography } from '@mui/material';

import { getCharacter } from '../api';
import { useTag } from '../contexts/TagContext';
import { characterPath, chineseName, coverUrl } from '../utils/characters';

/** Header of the character page (docs/characters.md, UI). */
export default function CharacterHeader({ name }) {
  const { t } = useTranslation();
  const { translations } = useTag();
  const { data } = useQuery({
    queryKey: ['character', name],
    queryFn: () => getCharacter(name),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const zh = chineseName(name, translations);
  const cover = coverUrl(data?.cover);

  return (
    <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, mb: 2, display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {cover && (
        <Box component="img" src={cover} alt={name}
          sx={{ width: { xs: '100%', sm: 360 }, aspectRatio: '3 / 2', objectFit: 'cover', borderRadius: 1 }} />
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: '1 1 280px' }}>
        <Typography variant="h5">{zh || name}</Typography>
        {zh && <Typography variant="body2" color="text.secondary">{name}</Typography>}
        {data && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            {data.work && (
              <Chip size="small" variant="outlined" clickable component={RouterLink}
                to={`/characters?work=${encodeURIComponent(data.work)}`}
                label={chineseName(data.work, translations) || data.work} />
            )}
            <Typography variant="body2" color="text.secondary">
              {t('characters.families', { count: data.family_count.toLocaleString() })}
            </Typography>
          </Box>
        )}
        {data?.cooccurring?.length > 0 && (
          <>
            <Typography variant="overline" color="text.secondary" sx={{ mt: 1 }}>{t('characters.cooccurring')}</Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {data.cooccurring.map((c) => (
                <Chip key={c.name} size="small" clickable component={RouterLink} to={characterPath(c.name)}
                  label={`${chineseName(c.name, translations) || c.name} · ${c.family_count}`} />
              ))}
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
