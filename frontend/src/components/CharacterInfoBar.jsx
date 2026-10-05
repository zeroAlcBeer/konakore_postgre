import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, ButtonBase, IconButton, Typography } from '@mui/material';
import { OpenInFull as OpenCoverIcon } from '@mui/icons-material';

import { getCharacter } from '../api';
import { useTag } from '../contexts/TagContext';
import { chineseName, coverSlide, coverUrl } from '../utils/characters';
import { getImageUrl } from '../utils/imageUtils';

const BANNER_INK = '#f1f1f5';

// The cover alone in the lightbox: a one-slide gallery.
async function openCover(slide) {
  const { default: PhotoSwipe } = await import('photoswipe');
  new PhotoSwipe({ dataSource: [slide], index: 0, bgOpacity: 0.9, showHideAnimationType: 'fade' }).init();
}

/** One co-occurring character: round cover crop, name, shared families. */
function PeerButton({ peer, translations, onSelect }) {
  const avatar = peer.cover?.preview_url ? getImageUrl(peer.cover.preview_url) : null;
  return (
    <ButtonBase
      onClick={() => onSelect(peer.name)}
      sx={{
        flex: 'none', height: 32, pl: '3px', pr: 1.25, gap: 0.75, borderRadius: 999,
        bgcolor: 'action.hover', color: 'text.primary', fontSize: 13, whiteSpace: 'nowrap',
        '&:hover': { bgcolor: 'action.selected' },
        '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: 2 },
      }}
    >
      <Box sx={{ width: 26, height: 26, borderRadius: '50%', overflow: 'hidden', bgcolor: 'background.paper', flex: 'none' }}>
        {avatar && <Box component="img" src={avatar} alt="" loading="lazy" sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      </Box>
      {chineseName(peer.name, translations) || peer.name}
      <Box component="span" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{peer.family_count.toLocaleString()}</Box>
    </ButtonBase>
  );
}

/**
 * Banner under the gallery search bar when the searched tag is a character;
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
  const cover = coverUrl(data.cover);
  const slide = coverSlide(data.cover);

  return (
    <Box sx={{ px: { xs: 1, sm: 2, md: 3 }, mb: 2 }}>
      <Box sx={{
        position: 'relative', height: 'clamp(180px, 20vw, 250px)', borderRadius: '14px', overflow: 'hidden',
        bgcolor: 'background.paper', isolation: 'isolate', color: BANNER_INK,
        '&::after': {
          content: '""', position: 'absolute', inset: 0, zIndex: -1,
          background: 'linear-gradient(90deg, rgba(10,10,12,.9) 0%, rgba(10,10,12,.72) 32%, rgba(10,10,12,.15) 70%, rgba(10,10,12,0) 100%)',
        },
      }}>
        {cover && (
          <Box component="img" src={cover} alt="" sx={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 30%', zIndex: -2,
          }} />
        )}
        {slide && (
          <IconButton
            onClick={() => openCover(slide)}
            aria-label={t('characters.openCover')}
            title={t('characters.openCover')}
            sx={{
              position: 'absolute', top: 12, right: 12, color: BANNER_INK,
              bgcolor: 'rgba(10,10,12,.45)', '&:hover': { bgcolor: 'rgba(10,10,12,.7)' },
            }}
          >
            <OpenCoverIcon fontSize="small" />
          </IconButton>
        )}
        <Box sx={{ position: 'absolute', left: 'clamp(20px, 3vw, 36px)', bottom: 'clamp(18px, 2.4vw, 28px)', maxWidth: 'min(560px, 70%)' }}>
          <Typography component="h2" sx={{
            m: 0, fontSize: 'clamp(28px, 3.2vw, 40px)', fontWeight: 680, letterSpacing: '-0.025em', lineHeight: 1.15,
            textShadow: '0 1px 3px rgba(0,0,0,.4)',
          }}>
            {zh || data.name}
          </Typography>
          {zh && <Typography sx={{ fontSize: 14, color: '#c9c9d2', mt: 0.25 }}>{data.name}</Typography>}
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mt: 1.25, fontSize: 14, color: '#d6d6de' }}>
            {data.work && (
              <Box component={RouterLink} to={`/characters?${new URLSearchParams({ work: data.work })}`} sx={{
                color: BANNER_INK, bgcolor: 'rgba(255,255,255,.12)', borderRadius: 999, px: 1.5, py: '2px', fontSize: 13,
                textDecoration: 'none', '&:hover': { bgcolor: 'rgba(255,255,255,.2)' },
              }}>
                {chineseName(data.work, translations) || data.work}
              </Box>
            )}
            <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {t('characters.siteFamilies', { count: data.family_count.toLocaleString() })}
            </Box>
          </Box>
        </Box>
      </Box>

      {data.cooccurring.length > 0 && (
        <Box sx={{
          display: 'flex', gap: 0.75, mt: 1.25, overflowX: 'auto', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
          maskImage: 'linear-gradient(90deg, #000 94%, transparent)',
        }}>
          {data.cooccurring.map((peer) => (
            <PeerButton key={peer.name} peer={peer} translations={translations} onSelect={onSelect} />
          ))}
        </Box>
      )}
    </Box>
  );
}
