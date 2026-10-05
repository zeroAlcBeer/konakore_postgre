// Masonry for the character index, with tiles that can span two columns.
// Behaviour and bounds: docs/characters.md, UI.

/** Columns by viewport width: 6 from 1200px, 4 from 900px, else 3. */
export const columnsFor = (viewportWidth) => (viewportWidth >= 1200 ? 6 : viewportWidth >= 900 ? 4 : 3);

/**
 * Boxes for tiles in order. A one-column tile goes to the shortest column; a
 * wider one to the lanes that end lowest and closest together. With `even`,
 * before a wide tile lands each lane's tiles since its last alignment line
 * stretch or squeeze (within minBend..maxBend of their own height) to meet on
 * one line, and the bottom edge is levelled the same way, so the masonry has
 * no inner holes. Covers crop, so bent heights do not distort them.
 *
 * @returns {{ boxes: {x:number, y:number, w:number, h:number}[], height: number }}
 */
export function masonryLayout({ ratios, spans, columns, width, gap = 8, even = true, minBend = 0.8, maxBend = 1.25 }) {
  const colW = (width - (columns - 1) * gap) / columns;
  const lanes = Array.from({ length: columns }, () => ({ anchor: 0, seg: [] }));
  const boxes = [];
  const natural = [];
  const end = (c) => {
    const { anchor, seg } = lanes[c];
    if (!seg.length) return anchor;
    const b = boxes[seg.at(-1)];
    return b.y + b.h + gap;
  };
  // Bend lane c's open segment so it ends at `target`; returns where it ends.
  const fit = (c, target) => {
    const { anchor, seg } = lanes[c];
    if (!even || !seg.length) return end(c);
    const sum = seg.reduce((a, i) => a + natural[i], 0);
    const k = Math.min(maxBend, Math.max(minBend, (target - anchor - gap * seg.length) / sum));
    let y = anchor;
    seg.forEach((i) => { boxes[i].y = y; boxes[i].h = natural[i] * k; y += boxes[i].h + gap; });
    return y;
  };

  ratios.forEach((ratio, i) => {
    const s = Math.min(spans[i], columns);
    const w = colW * s + gap * (s - 1);
    natural[i] = w / ratio;
    let best = 0, top = Infinity, score = Infinity;
    for (let c = 0; c + s <= columns; c++) {
      const ends = Array.from({ length: s }, (_, k) => end(c + k));
      const y = Math.max(...ends);
      // For a wide tile also weigh the lanes' difference: it is what the covers must bend to close.
      const sc = s > 1 && even ? y + 2 * (y - Math.min(...ends)) : y;
      if (sc < score - 0.5) { score = sc; top = y; best = c; }
    }
    const x = best * (colW + gap);
    if (s > 1) {
      const wide = Array.from({ length: s }, (_, k) => best + k);
      const target = wide.reduce((a, c) => a + end(c), 0) / s;
      top = Math.max(...wide.map((c) => fit(c, target)));
      boxes[i] = { x, y: top, w, h: natural[i] };
      wide.forEach((c) => { lanes[c] = { anchor: top + natural[i] + gap, seg: [] }; });
    } else {
      boxes[i] = { x, y: top, w, h: natural[i] };
      lanes[best].seg.push(i);
    }
  });

  const floor = lanes.reduce((a, _, c) => a + end(c), 0) / columns;
  const height = Math.max(0, ...lanes.map((_, c) => fit(c, floor))) - gap;
  return { boxes, height: Math.max(0, height) };
}

/**
 * One breath: when `max` tiles are wide, the oldest shrinks back; then one of
 * the other tiles, chosen by `pick(candidates)`, spans two columns.
 */
export function breatheStep({ spans, enlarged, max, pick }) {
  const next = [...spans];
  const order = [...enlarged];
  while (order.length >= max) next[order.shift()] = 1;
  const candidates = next.flatMap((s, i) => (s === 1 ? [i] : []));
  if (candidates.length) {
    const i = pick(candidates);
    next[i] = 2;
    order.push(i);
  }
  return { spans: next, enlarged: order };
}
