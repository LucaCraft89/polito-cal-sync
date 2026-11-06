/**
 * Colour roles for the web UI, generated from one seed (docs/UI.md section 2, decision 024).
 *
 * This is OUR OWN approximation of Material 3 tonal palettes, written from the public description (a
 * palette is a hue and a chroma sampled at tones 0..100; roles pick fixed tones): tone is CIE L*, hue and
 * chroma are CIE LCh(ab), clamped into sRGB by lowering the chroma. It is NOT the Material Color Utilities
 * (HCT / CAM16) algorithm, so the colours are close to Material's, not identical. What the tests guarantee
 * is what matters for users: every text/background pair meets WCAG 2.2 AA in light and dark.
 */

const WHITE = { x: 0.95047, y: 1, z: 1.08883 } as const;

const gammaEncode = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const gammaDecode = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

function labToLinear(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number): number => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const x = WHITE.x * inv(fx);
  const y = WHITE.y * inv(fy);
  const z = WHITE.z * inv(fz);
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

const inGamut = (rgb: [number, number, number]): boolean =>
  rgb.every((c) => c >= -0.0005 && c <= 1.0005);

/** Hex colour of CIE L* `tone`, `hue` in degrees, wanted `chroma` (lowered until it fits sRGB). */
export function tonal(hue: number, chroma: number, tone: number): string {
  if (tone >= 100) return '#ffffff';
  if (tone <= 0) return '#000000';
  const h = (hue * Math.PI) / 180;
  let lo = 0;
  let hi = chroma;
  if (inGamut(labToLinear(tone, hi * Math.cos(h), hi * Math.sin(h)))) lo = hi;
  else {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(labToLinear(tone, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid;
      else hi = mid;
    }
  }
  const lin = labToLinear(tone, lo * Math.cos(h), lo * Math.sin(h));
  return (
    '#' +
    lin
      .map((c) =>
        Math.round(Math.min(1, Math.max(0, gammaEncode(Math.min(1, Math.max(0, c))))) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => gammaDecode(parseInt(hex.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The seed: one blue-violet. Everything else is derived. */
export const SEED = { hue: 262, chroma: 48 } as const;

interface PaletteSpec {
  hue: number;
  chroma: number;
}
const PALETTES: Record<string, PaletteSpec> = {
  primary: SEED,
  secondary: { hue: SEED.hue, chroma: 16 },
  tertiary: { hue: SEED.hue + 60, chroma: 32 },
  neutral: { hue: SEED.hue, chroma: 4 },
  neutralVariant: { hue: SEED.hue, chroma: 8 },
  error: { hue: 25, chroma: 84 },
  success: { hue: 150, chroma: 40 },
  warning: { hue: 75, chroma: 48 },
};

const t = (palette: keyof typeof PALETTES, tone: number): string => {
  const p = PALETTES[palette] as PaletteSpec;
  return tonal(p.hue, p.chroma, tone);
};

export type Roles = Record<string, string>;

/** Role name (kebab-case, used as `--c-<name>`) -> hex, for one scheme. */
export function scheme(dark: boolean): Roles {
  const accent = (name: string, p: keyof typeof PALETTES): Roles =>
    dark
      ? {
          [name]: t(p, 80),
          [`on-${name}`]: t(p, 20),
          [`${name}-container`]: t(p, 30),
          [`on-${name}-container`]: t(p, 90),
        }
      : {
          [name]: t(p, 40),
          [`on-${name}`]: t(p, 100),
          [`${name}-container`]: t(p, 90),
          [`on-${name}-container`]: t(p, 10),
        };
  const n = (tone: number): string => t('neutral', tone);
  const nv = (tone: number): string => t('neutralVariant', tone);
  return {
    ...accent('primary', 'primary'),
    ...accent('secondary', 'secondary'),
    ...accent('tertiary', 'tertiary'),
    ...accent('error', 'error'),
    ...accent('success', 'success'),
    ...accent('warning', 'warning'),
    ...(dark
      ? {
          surface: n(6),
          'surface-dim': n(6),
          'surface-bright': n(24),
          'surface-container-lowest': n(4),
          'surface-container-low': n(10),
          'surface-container': n(12),
          'surface-container-high': n(17),
          'surface-container-highest': n(22),
          'on-surface': n(90),
          'on-surface-variant': nv(80),
          outline: nv(60),
          'outline-variant': nv(30),
          'inverse-surface': n(90),
          'inverse-on-surface': n(20),
          'inverse-primary': t('primary', 40),
          scrim: '#000000',
        }
      : {
          surface: n(98),
          'surface-dim': n(87),
          'surface-bright': n(98),
          'surface-container-lowest': n(100),
          'surface-container-low': n(96),
          'surface-container': n(94),
          'surface-container-high': n(92),
          'surface-container-highest': n(90),
          'on-surface': n(10),
          'on-surface-variant': nv(30),
          outline: nv(50),
          'outline-variant': nv(80),
          'inverse-surface': n(20),
          'inverse-on-surface': n(95),
          'inverse-primary': t('primary', 80),
          scrim: '#000000',
        }),
  };
}

/** Pairs the UI really draws text or controls with: [foreground, background, minimum ratio, why]. */
export const CONTRAST_PAIRS: readonly [string, string, number, string][] = [
  ...['primary', 'secondary', 'tertiary', 'error', 'success', 'warning'].flatMap(
    (a): [string, string, number, string][] => [
      [`on-${a}`, a, 4.5, `text on ${a}`],
      [`on-${a}-container`, `${a}-container`, 4.5, `text on ${a} container`],
    ],
  ),
  ...[
    'surface',
    'surface-dim',
    'surface-container-lowest',
    'surface-container-low',
    'surface-container',
    'surface-container-high',
    'surface-container-highest',
  ].flatMap((s): [string, string, number, string][] => [
    ['on-surface', s, 4.5, `body text on ${s}`],
    ['on-surface-variant', s, 4.5, `secondary text on ${s}`],
    ['outline', s, 3, `control border on ${s}`],
    ['primary', s, 4.5, `link / text button on ${s}`],
    ['error', s, 4.5, `error text on ${s}`],
    ['success', s, 4.5, `status text on ${s}`],
    ['warning', s, 4.5, `status text on ${s}`],
  ]),
  ['inverse-on-surface', 'inverse-surface', 4.5, 'snackbar text'],
  ['inverse-primary', 'inverse-surface', 4.5, 'snackbar action'],
];

/**
 * Spring easing as a CSS `linear()` list: damped harmonic oscillator sampled at `n` points. `damping` < 1
 * overshoots (expressive "spatial" motion), 1 does not (effects).
 */
export function springLinear(damping: number, n = 28): string {
  const w = 14; // natural frequency: settles in about 1 time unit
  const wd = w * Math.sqrt(Math.max(1e-6, 1 - damping * damping));
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const v =
      damping >= 1
        ? 1 - Math.exp(-w * x) * (1 + w * x)
        : 1 -
          Math.exp(-damping * w * x) * (Math.cos(wd * x) + ((damping * w) / wd) * Math.sin(wd * x));
    pts.push(i === n ? '1' : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
  }
  return `linear(${pts.join(', ')})`;
}

const block = (roles: Roles, indent: string): string =>
  Object.entries(roles)
    .map(([k, v]) => `${indent}--c-${k}: ${v};`)
    .join('\n');

/** The whole generated stylesheet (committed as web/assets/tokens.css; a test fails if it drifts). */
export function buildTokensCss(): string {
  const light = scheme(false);
  const dark = scheme(true);
  return `/* GENERATED by scripts/gen-tokens.ts from scripts/palette.ts. Do not edit by hand. */
/* Colour roles follow the Material 3 role names; the palettes are our own approximation (see palette.ts). */

:root {
  color-scheme: light dark;
${block(light, '  ')}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${block(dark, '    ')}
  }
}

:root[data-theme='light'] {
  color-scheme: light;
${block(light, '  ')}
}

:root[data-theme='dark'] {
  color-scheme: dark;
${block(dark, '  ')}
}

:root {
  /* Shape: the Material 3 scale plus the expressive asymmetric shapes. */
  --r-xs: 4px;
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --r-xl: 28px;
  --r-2xl: 40px;
  --r-full: 999px;
  --r-leaf: 28px 6px 28px 6px;
  --r-tab: 28px 28px 6px 6px;

  /* Spacing (4 px grid). */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 24px;
  --s-6: 32px;
  --s-7: 48px;

  /* Type: Roboto Flex (variable weight), then the system font. "-em" tokens are the emphasised variants. */
  --font: 'Roboto Flex', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;

  /* Motion: spring-like curves as linear(); durations are short. */
  --ease-spatial: ${springLinear(0.62)};
  --ease-spatial-calm: ${springLinear(0.85)};
  --ease-effects: cubic-bezier(0.2, 0, 0, 1);
  --dur-short: 150ms;
  --dur-medium: 300ms;
  --dur-long: 500ms;

  /* Elevation as shadow; surfaces also get tone from their container role. */
  --elev-1: 0 1px 2px rgb(0 0 0 / 0.22), 0 1px 3px 1px rgb(0 0 0 / 0.12);
  --elev-2: 0 1px 2px rgb(0 0 0 / 0.22), 0 2px 6px 2px rgb(0 0 0 / 0.14);
  --elev-3: 0 4px 8px 3px rgb(0 0 0 / 0.14), 0 1px 3px rgb(0 0 0 / 0.22);
}
`;
}
