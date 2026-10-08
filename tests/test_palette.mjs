// tests/test_palette.mjs — `shade`, the colour of one year of a series drawn
// year over year.
//
//   * One year, and the middle year of any number, is the palette colour
//     itself, string-equal: the legend swatch is a line on the chart.
//   * The years run lighter to darker, oldest to newest, and keep the hue.
//   * Ten years are ten colours, none fading onto the white page or the
//     black axis text. The floor is 1.5:1 against each: the palette's own
//     lightest entry (#bcbd22) is 2.0:1 on white, so the 3:1 asked of
//     graphics is the palette's to meet, not the ramp's, and 1.5:1 is a
//     line still seen at a glance.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { CASE_COLORS, shade } = await import('../src/ui/palette.ts');

const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

const rgbOf = (hex) => [16, 8, 0].map((shift) => (parseInt(hex.slice(1), 16) >> shift) & 0xff);
/** WCAG relative luminance. */
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Hue in degrees, from the channels. */
function hueOf(hex) {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return null;
  const h = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return (h * 60 + 360) % 360;
}
const ramp = (color, n) => Array.from({ length: n }, (_, i) => shade(color, i, n));
const FLOOR = 1.5;

ok('one year is the palette colour itself, as is the middle year of an odd number', () => {
  for (const color of CASE_COLORS) {
    assert.equal(shade(color, 0, 1), color);
    for (const n of [3, 9]) {
      assert.equal(shade(color, (n - 1) / 2, n), color, `${color}, ${n} years`);
    }
  }
});

ok('an even number of years puts its two middles either side of the colour', () => {
  for (const color of CASE_COLORS) {
    for (const n of [2, 4, 10]) {
      const years = ramp(color, n);
      const [older, newer] = [years[n / 2 - 1], years[n / 2]];
      assert.ok(luminance(older) > luminance(color), `${color}, ${n} years: older lighter`);
      assert.ok(luminance(color) > luminance(newer), `${color}, ${n} years: newer darker`);
    }
    // Two years move equally far: half a step each way, towards white and black.
    const [c, light, dark] = [color, shade(color, 0, 2), shade(color, 1, 2)].map(rgbOf);
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(light[k] - c[k] - (255 - c[k]) * 0.125) <= 0.5, `${color} lighter`);
      assert.ok(Math.abs(c[k] - dark[k] - c[k] * 0.125) <= 0.5, `${color} darker`);
    }
  }
});

ok('the years run lighter to darker, oldest to newest, on one hue', () => {
  for (const color of CASE_COLORS) {
    for (const n of [2, 3, 5, 10]) {
      const years = ramp(color, n);
      for (let i = 1; i < n; i++) {
        assert.ok(
          luminance(years[i]) < luminance(years[i - 1]),
          `${color}: year ${i} of ${n} (${years[i]}) is darker than year ${i - 1} (${years[i - 1]})`,
        );
      }
      const hue = hueOf(color);
      for (const year of years) {
        if (hue === null) assert.equal(hueOf(year), null, `${year} stays grey`);
        else {
          const apart = Math.abs(hueOf(year) - hue);
          assert.ok(Math.min(apart, 360 - apart) < 4, `${year} keeps the hue of ${color}`);
        }
      }
    }
  }
});

ok('ten years are ten colours, none fading onto white or black', () => {
  for (const color of CASE_COLORS) {
    const years = ramp(color, 10);
    assert.equal(new Set(years).size, 10, `${color}: ${years.join(' ')}`);
    for (const year of years) {
      assert.match(year, /^#[0-9a-f]{6}$/);
      assert.ok(contrast(year, '#ffffff') >= FLOOR, `${year} (from ${color}) on white`);
      assert.ok(contrast(year, '#000000') >= FLOOR, `${year} (from ${color}) against black`);
    }
  }
});

ok('the same year of the same series is the same colour every time', () => {
  assert.deepEqual(ramp('#1f77b4', 4), ramp('#1f77b4', 4));
  assert.equal(shade('rebeccapurple', 0, 3), 'rebeccapurple', 'not #rrggbb: untouched');
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n${checks.length} checks passed`);
