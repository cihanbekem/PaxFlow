// ui/tests/app.tests.js
import { describe, it, expect } from 'vitest';
import { fmt, classForLevel, aggregateTotalPerMinute, barChartSVG } from '../app.js';

describe('ui helpers', () => {
  it('fmt rounds numbers', () => {
    expect(fmt(1.234)).toBe(1.23);
    expect(fmt(2)).toBe(2);
    expect(fmt('x')).toBe('x');
  });

  it('classForLevel maps TR levels to classes', () => {
    expect(classForLevel('YEŞİL')).toBe('green');
    expect(classForLevel('SARI')).toBe('yellow');
    expect(classForLevel('KIRMIZI')).toBe('red');
  });

  it('aggregateTotalPerMinute dedup + sum', () => {
    const latest = [
      { ts_minute: '2025-01-01T10:00:00', checkpoint_id: 'CP1', n_t: 3 },
      { ts_minute: '2025-01-01T10:00:00', checkpoint_id: 'CP1', n_t: 5 }, // aynı ts+cp -> sonuncu kalır
      { ts_minute: '2025-01-01T10:01:00', checkpoint_id: 'CP1', n_t: 2 },
      { ts_minute: '2025-01-01T10:01:00', checkpoint_id: 'CP2', n_t: 4 }, // farklı cp, aynı dakika -> toplanır
    ];
    const res = aggregateTotalPerMinute(latest);
    // son 60 dk kırpması testte etkisiz; sıralı iki kayıt bekleriz
    expect(res.length).toBe(2);
    // 10:00 -> yalnızca son CP1 kaydı (5)
    expect(res[0]).toEqual({ ts: '2025-01-01T10:00:00', count: 5 });
    // 10:01 -> CP1(2)+CP2(4)=6
    expect(res[1]).toEqual({ ts: '2025-01-01T10:01:00', count: 6 });
  });

  it('barChartSVG returns an <svg> string', () => {
    const svg = barChartSVG([{ ts: 't', count: 3 }, { ts: 't2', count: 1 }], 600, 180);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.includes('</svg>')).toBe(true);
  });
});
