import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box } from '@mui/material';

import { chineseName, coverUrl, gallerySearchPath } from '../utils/characters';
import { breatheStep, columnsFor, masonryLayout } from '../utils/masonry';

// Rhythm and motion; the contract is docs/characters.md, UI.
const GAP = 8;
const BREATH_MS = 4000;
const MAX_WIDE = 3;
const TOUCH_HOLD_MS = 10000;
const MOVE_MS = 700;
const EASE = 'cubic-bezier(.22,.7,.2,1)';
const DEFAULT_RATIO = 3 / 2;

const ratioOf = (c) => (c.cover?.width && c.cover?.height ? c.cover.width / c.cover.height : DEFAULT_RATIO);
const pickUniform = (candidates) => candidates[Math.floor(Math.random() * candidates.length)];

function Tile({ character, box, wide, eager, translations, tileRef }) {
  const { t } = useTranslation();
  const name = chineseName(character.name, translations) || character.name;
  const work = character.work ? chineseName(character.work, translations) || character.work : null;
  const cover = coverUrl(character.cover);
  return (
    <Box
      ref={tileRef}
      component={RouterLink}
      to={gallerySearchPath(character.name)}
      aria-label={`${name}，${t('characters.families', { count: character.family_count.toLocaleString() })}`}
      sx={{
        position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h,
        overflow: 'hidden', isolation: 'isolate', borderRadius: '6px', transformOrigin: '0 0',
        bgcolor: 'action.hover', color: '#f1f1f5', textDecoration: 'none',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: '2px' },
        '&::after': {
          content: '""', position: 'absolute', inset: '50% 0 0', zIndex: -1,
          background: 'linear-gradient(to top, rgba(8,8,10,.8), rgba(8,8,10,.3) 60%, rgba(8,8,10,0))',
        },
      }}
    >
      {cover && (
        <Box component="img" src={cover} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async"
          sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: -1 }} />
      )}
      <Box sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, p: wide ? '18px 22px' : '10px 12px', display: 'grid', gap: '1px' }}>
        <Box sx={{
          fontSize: wide ? 'clamp(22px, 2.6vw, 32px)' : '15px', fontWeight: 640, letterSpacing: wide ? '-0.02em' : '-0.01em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 2px rgba(0,0,0,.5)',
        }}>
          {name}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, fontSize: wide ? '14px' : '12.5px', color: '#b4b5bf', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <Box component="span" sx={{ color: '#f1f1f5', opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>
            {t('characters.families', { count: character.family_count.toLocaleString() })}
          </Box>
          {work && <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{work}</Box>}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * The character index's breathing masonry. Mount with a `key` per page so a
 * new page starts with every tile one column wide.
 */
export default function CharacterMasonry({ characters, translations }) {
  const boardRef = useRef(null);
  const tileRefs = useRef([]);
  const fromRects = useRef(null);   // tile rects just before a breath, for FLIP
  const [width, setWidth] = useState(0);
  const [columns, setColumns] = useState(() => columnsFor(window.innerWidth));
  const [breath, setBreath] = useState(() => ({ spans: characters.map(() => 1), enlarged: [] }));

  // Width follows the board itself: scrollbars come and go without a window resize.
  useLayoutEffect(() => {
    const board = boardRef.current;
    const observer = new ResizeObserver(() => {
      setWidth(board.clientWidth);
      setColumns(columnsFor(window.innerWidth));
    });
    observer.observe(board);
    return () => observer.disconnect();
  }, []);

  const ratios = useMemo(() => characters.map(ratioOf), [characters]);
  const layout = useMemo(
    () => (width ? masonryLayout({ ratios, spans: breath.spans, columns, width, gap: GAP }) : null),
    [ratios, breath.spans, columns, width],
  );

  // FLIP: tiles render at their new box; play the move from where they were, with transforms only.
  useLayoutEffect(() => {
    const from = fromRects.current;
    fromRects.current = null;
    if (!from) return;
    tileRefs.current.forEach((el, i) => {
      const a = from[i];
      if (!el || !a) return;
      const b = el.getBoundingClientRect();
      if (Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5) return;
      el.getAnimations().forEach((x) => x.cancel());
      el.animate([
        { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})` },
        { transform: 'none' },
      ], { duration: MOVE_MS, easing: EASE });
    });
  }, [layout]);

  // Breathe every BREATH_MS unless the tab is hidden, a touch just happened, or motion is reduced.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let heldUntil = 0;
    const onTouch = () => { heldUntil = Date.now() + TOUCH_HOLD_MS; };
    const board = boardRef.current;
    board.addEventListener('touchstart', onTouch, { passive: true });
    const id = setInterval(() => {
      if (document.hidden || Date.now() < heldUntil) return;
      fromRects.current = tileRefs.current.map((el) => el?.getBoundingClientRect());
      setBreath((b) => breatheStep({ ...b, max: MAX_WIDE, pick: pickUniform }));
    }, BREATH_MS);
    return () => { clearInterval(id); board.removeEventListener('touchstart', onTouch); };
  }, []);

  return (
    <Box ref={boardRef} sx={{ position: 'relative', height: layout ? layout.height : 0 }}>
      {layout && characters.map((c, i) => (
        <Tile
          key={c.name}
          character={c}
          box={layout.boxes[i]}
          wide={breath.spans[i] > 1}
          eager={i < 12}
          translations={translations}
          tileRef={(el) => { tileRefs.current[i] = el; }}
        />
      ))}
    </Box>
  );
}
