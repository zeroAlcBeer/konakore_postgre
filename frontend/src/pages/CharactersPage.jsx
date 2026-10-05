import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Chip, CircularProgress, Typography } from '@mui/material';
import { ErrorOutline as ErrorIcon } from '@mui/icons-material';

import AppLayout from '../components/AppLayout';
import SimplePagination from '../components/SimplePagination';
import { getCharacters } from '../api';
import { useTag } from '../contexts/TagContext';
import {
  LADDER_PAGE_SIZE, chineseName, coverUrl, gallerySearchPath, ladderTier, listRequest,
} from '../utils/characters';

const GAP = 6;

// Tile spans per tier; rows are a third of a column wider than tall (3:2).
const TIER_SX = {
  lead: { gridColumn: 'span 3', gridRow: { xs: 'span 2', md: 'span 3' }, borderRadius: '6px' },
  major: { gridColumn: 'span 2', gridRow: 'span 2', borderRadius: '5px' },
  minor: {},
};
const NAME_SIZE = { lead: 'clamp(26px, 3vw, 40px)', major: '21px', minor: '15px' };
const CAPTION_PAD = { lead: '22px 26px', major: '14px 18px', minor: '10px 12px' };

function Tile({ character, tier, translations }) {
  const { t } = useTranslation();
  const name = chineseName(character.name, translations) || character.name;
  const work = character.work ? chineseName(character.work, translations) || character.work : null;
  const cover = coverUrl(character.cover);
  return (
    <Box
      component={RouterLink}
      to={gallerySearchPath(character.name)}
      aria-label={`${name}，${t('characters.families', { count: character.family_count.toLocaleString() })}`}
      sx={{
        position: 'relative', overflow: 'hidden', isolation: 'isolate', borderRadius: '4px',
        bgcolor: 'action.hover', color: '#f1f1f5', textDecoration: 'none',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: '2px' },
        '& img': {
          position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: -1,
          opacity: 0, transition: 'opacity 400ms ease-out, transform 7s cubic-bezier(.15,.6,.25,1)',
        },
        '& img.ready': { opacity: 1 },
        '@media (hover: hover)': { '&:hover img': { transform: 'scale(1.06)' } },
        '&::after': {
          content: '""', position: 'absolute', inset: '45% 0 0', zIndex: -1,
          background: 'linear-gradient(to top, rgba(8,8,10,.82), rgba(8,8,10,.38) 55%, rgba(8,8,10,0))',
        },
        '@media (prefers-reduced-motion: reduce)': { '& img': { transition: 'none' } },
        ...TIER_SX[tier],
      }}
    >
      {cover && (
        <img src={cover} alt="" loading={tier === 'minor' ? 'lazy' : 'eager'} decoding="async"
          onLoad={(e) => e.currentTarget.classList.add('ready')} />
      )}
      <Box sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, p: CAPTION_PAD[tier], display: 'grid', gap: '1px' }}>
        <Box sx={{
          fontSize: NAME_SIZE[tier], fontWeight: 640, letterSpacing: tier === 'lead' ? '-0.025em' : '-0.01em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 2px rgba(0,0,0,.5)',
        }}>
          {name}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, fontSize: tier === 'minor' ? '12.5px' : '14px', color: '#b4b5bf', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <Box component="span" sx={{ color: '#f1f1f5', opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>
            {t('characters.families', { count: character.family_count.toLocaleString() })}
          </Box>
          {work && <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{work}</Box>}
        </Box>
      </Box>
    </Box>
  );
}

/** Character index: a paged mosaic of covers; contract in docs/characters.md, UI. */
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
    queryFn: () => getCharacters({ work, page, limit: LADDER_PAGE_SIZE }),
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
  });
  const characters = data?.characters || [];
  const pagination = data?.pagination;

  return (
    <AppLayout>
      <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, pb: 6, containerType: 'inline-size' }}>
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

        <Box sx={{
          '--cols': { xs: 3, md: 4, lg: 6 },
          display: 'grid', gap: `${GAP}px`, gridAutoFlow: 'dense',
          gridTemplateColumns: 'repeat(var(--cols), 1fr)',
          gridAutoRows: `calc((100cqi - (var(--cols) - 1) * ${GAP}px) / var(--cols) * 2 / 3)`,
        }}>
          {characters.map((c, i) => (
            <Tile key={c.name} character={c} tier={ladderTier(i)} translations={translations} />
          ))}
        </Box>

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
