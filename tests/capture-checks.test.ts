import { describe, it, expect } from 'vitest';
import { blurScore, checkDimensions, DARK_WARN_THRESHOLD, findDuplicates, listNames, meanLuminance, needsReencode, summarize,
  UPLOAD_LONG_SIDE_PX, uploadName, uploadSize, type PhotoAnalysis } from '@/lib/capture-checks';
import { MIN_CAPTURE_FILES, RECOMMENDED_CAPTURE_FILES } from '@/lib/contracts';

const photo = (name: string, over: Partial<PhotoAnalysis> = {}): PhotoAnalysis =>
  ({ name, width: 4032, height: 3024, sha256: name, blur: 500, luminance: 120, ...over });

function checkerboard(size: number, cell: number) {
  const gray = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) gray[y * size + x] = ((x / cell | 0) + (y / cell | 0)) % 2 ? 255 : 0;
  return gray;
}
function boxBlur(src: Float32Array, size: number, radius: number) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0, n = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < size && xx >= 0 && xx < size) { sum += src[yy * size + xx]; n++; }
    }
    out[y * size + x] = sum / n;
  }
  return out;
}

describe('Capture checks', () => {
  it('keeps the raised capture minimum and recommendation in sync', () => {
    expect(MIN_CAPTURE_FILES).toBe(40);
    expect(RECOMMENDED_CAPTURE_FILES).toBe(60);
  });

  it('blocks mixed resolutions or orientations and names the odd photos', () => {
    const result = checkDimensions([photo('a.jpg'), photo('b.jpg'), photo('v.jpg', { width: 3024, height: 4032 })]);
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]).toContain('v.jpg');
    expect(result.blocking[0]).not.toContain('a.jpg');
    expect(checkDimensions([photo('a.jpg'), photo('b.jpg')])).toEqual({ blocking: [], warnings: [] });
  });

  it('blocks photos under 720 px short side and warns under 1080 px', () => {
    expect(checkDimensions([photo('tiny.jpg', { width: 960, height: 719 })]).blocking[0]).toContain('tiny.jpg');
    const low = checkDimensions([photo('low.jpg', { width: 1280, height: 720 })]);
    expect(low.blocking).toEqual([]);
    expect(low.warnings[0]).toContain('low.jpg');
  });

  it('groups byte-identical duplicates', () => {
    expect(findDuplicates([photo('a.jpg', { sha256: 'x' }), photo('b.jpg', { sha256: 'x' }), photo('c.jpg')])).toEqual([['a.jpg', 'b.jpg']]);
    expect(summarize([photo('a.jpg', { sha256: 'x' }), photo('b.jpg', { sha256: 'x' })], 1).blocking[0]).toContain('a.jpg = b.jpg');
  });

  it('scores a sharp checkerboard above a blurred copy and a constant image', () => {
    const sharp = checkerboard(64, 8);
    const sharpScore = blurScore(sharp, 64, 64);
    const blurredScore = blurScore(boxBlur(sharp, 64, 3), 64, 64);
    expect(sharpScore).toBeGreaterThan(blurredScore);
    expect(blurredScore).toBeGreaterThan(0);
    expect(blurScore(new Float32Array(64 * 64).fill(128), 64, 64)).toBe(0);
    expect(blurScore(new Uint8Array(4), 2, 2)).toBe(0);
  });

  it('measures mean luminance and warns on dark or blurry photos', () => {
    expect(meanLuminance(new Uint8Array([0, 255, 0, 255]))).toBe(127.5);
    const result = summarize([photo('dark.jpg', { luminance: DARK_WARN_THRESHOLD - 1 }), photo('soft.jpg', { sha256: 's', blur: 1 })], 1);
    expect(result.blocking).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/soft\.jpg.*dark\.jpg/);
  });

  it('reports a dark photo only as dark, not also as blurry', () => {
    const result = summarize([photo('dark.jpg', { luminance: DARK_WARN_THRESHOLD - 1, blur: 1 })]);
    expect(result.warnings.join(' ')).not.toMatch(/desenfocadas: dark\.jpg/);
  });

  it('warns when the count meets the minimum but not the recommendation', () => {
    const photos = (n: number) => Array.from({ length: n }, (_, i) => photo(`p${i}.jpg`));
    expect(summarize(photos(MIN_CAPTURE_FILES)).warnings.join(' ')).toContain(`menos de ${RECOMMENDED_CAPTURE_FILES}`);
    expect(summarize(photos(RECOMMENDED_CAPTURE_FILES)).warnings).toEqual([]);
  });

  it('blocks with the exact number of missing photos below the minimum', () => {
    const result = summarize([photo('a.jpg'), photo('b.jpg', { sha256: 'b' })], 40);
    expect(result.blocking[0]).toBe('Tienes 2 fotos; faltan 38 para el mínimo de 40. Añade fotos de la misma estancia siguiendo la guía.');
    expect(summarize([], 40).blocking).toEqual([]);
  });

  it('warns (never blocks) on files the browser could not analyze and truncates long name lists', () => {
    const result = summarize([{ name: 'broken.png', unreadable: true }], 1);
    expect(result.blocking).toEqual([]);
    expect(result.warnings[0]).toContain('broken.png');
    expect(listNames(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c y 2 más');
  });
});

describe('upload downscale', () => {
  it('fits the long side to the upload size, preserving aspect and orientation', () => {
    expect(UPLOAD_LONG_SIDE_PX).toBe(2048);
    expect(uploadSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(uploadSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(uploadSize(4032, 2268)).toEqual({ width: 2048, height: 1152 });
    expect(uploadSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
  it('passes small JPEGs through and re-encodes large or PNG files', () => {
    expect(needsReencode('image/jpeg', 2048, 1536)).toBe(false);
    expect(needsReencode('image/jpeg', 1600, 1200)).toBe(false);
    expect(needsReencode('image/jpeg', 4032, 3024)).toBe(true);
    expect(needsReencode('image/png', 1600, 1200)).toBe(true);
  });
  it('keeps the base name with a .jpg extension', () => {
    expect(uploadName('IMG_0001.HEIC.jpeg')).toBe('IMG_0001.HEIC.jpg');
    expect(uploadName('salon.png')).toBe('salon.jpg');
    expect(uploadName('foto')).toBe('foto.jpg');
  });
});
