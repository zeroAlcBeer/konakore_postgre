import { describe, expect, it } from 'vitest';
import { breatheStep, columnsFor, masonryLayout } from './masonry';

const GAP = 8;

/** Free height inside the masonry, scanned down each column's centre line. */
function innerHoles({ boxes }, columns, width) {
  const colW = (width - (columns - 1) * GAP) / columns;
  let holes = 0;
  for (let c = 0; c < columns; c++) {
    const cx = c * (colW + GAP) + colW / 2;
    let y = 0;
    for (const b of boxes.filter((b) => b.x <= cx && cx <= b.x + b.w).sort((a, b) => a.y - b.y)) {
      if (b.y - y > 0.5) holes += b.y - y;
      y = b.y + b.h + GAP;
    }
  }
  return holes;
}

function overlaps({ boxes }) {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) n++;
  }
  return n;
}

describe('columnsFor', () => {
  it('uses 4 columns from 1200px, else 3', () => {
    expect([1440, 1200, 1199, 900, 899, 820].map(columnsFor)).toEqual([4, 4, 3, 3, 3, 3]);
  });
});

describe('masonryLayout', () => {
  const width = 3 * 100 + 2 * GAP; // three 100px columns

  it('places single tiles in the shortest column, at their own shape', () => {
    const layout = masonryLayout({ ratios: [2, 1, 1, 2], spans: [1, 1, 1, 1], columns: 3, width, even: false });
    expect(layout.boxes).toEqual([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 108, y: 0, w: 100, h: 100 },
      { x: 216, y: 0, w: 100, h: 100 },
      { x: 0, y: 58, w: 100, h: 50 },
    ]);
    expect(layout.height).toBe(108);
  });

  it('makes a wide tile two columns wide at the same shape', () => {
    const { boxes } = masonryLayout({ ratios: [2], spans: [2], columns: 3, width, even: false });
    expect(boxes[0]).toEqual({ x: 0, y: 0, w: 208, h: 104 });
  });

  // Uneven columns, then a wide tile: without balancing it leaves a hole.
  const uneven = {
    ratios: [2.4, 1.2, 1.5, 1.2, 2.4, 1.5, 1.8, 1.3, 2, 1.6, 1.4, 2.2],
    spans: [1, 1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 1],
    columns: 3,
    width,
  };

  it('leaves holes when balancing is off (the case below is a real one)', () => {
    expect(innerHoles(masonryLayout({ ...uneven, even: false }), 3, width)).toBeGreaterThan(10);
  });

  it('closes inner holes by bending covers within bounds, without overlaps', () => {
    const layout = masonryLayout({ ...uneven, even: true });
    expect(innerHoles(layout, 3, width)).toBeLessThan(1);
    expect(overlaps(layout)).toBe(0);
    layout.boxes.forEach((b, i) => {
      const bend = b.h / (b.w / uneven.ratios[i]);
      expect(bend).toBeGreaterThanOrEqual(0.8 - 1e-9);
      expect(bend).toBeLessThanOrEqual(1.25 + 1e-9);
    });
  });
});

describe('breatheStep', () => {
  const pickFirst = (candidates) => candidates[0];

  it('enlarges a picked tile', () => {
    expect(breatheStep({ spans: [1, 1, 1], enlarged: [], max: 3, pick: pickFirst })).toEqual({ spans: [2, 1, 1], enlarged: [0] });
  });

  it('shrinks the oldest first when at the limit, and never re-picks an enlarged tile', () => {
    const state = { spans: [2, 2, 1, 1], enlarged: [1, 0], max: 2, pick: (c) => c.at(-1) };
    expect(breatheStep(state)).toEqual({ spans: [2, 1, 1, 2], enlarged: [0, 3] });
    const seen = [];
    breatheStep({ spans: [2, 1, 1], enlarged: [0], max: 3, pick: (c) => { seen.push(...c); return c[0]; } });
    expect(seen).toEqual([1, 2]);
  });
});
