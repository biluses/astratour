/** Client-side capture checks run before upload. Pure functions plus one browser-only helper (analyzeFile). */
import { MIN_CAPTURE_FILES, RECOMMENDED_CAPTURE_FILES } from '@/lib/contracts';

export const MIN_SHORT_SIDE_PX = 720; // provisional: blocks captures too small for reliable feature matching.
export const RECOMMENDED_SHORT_SIDE_PX = 1080; // provisional
export const ANALYSIS_LONG_SIDE_PX = 512; // luminance and the coarse half of the sharpness ratio use this long side.
export const DETAIL_LONG_SIDE_PX = 1024; // fine half of the sharpness ratio (never upscaled).
// Sharpness = Laplacian variance at 1024 px / at 512 px. Absolute variance varies ~20x between scenes
// (bark vs. an object on a table), the ratio does not: blur removes fine detail first. See docs/CAPTURE.md.
export const BLUR_WARN_THRESHOLD = 0.2;
export const DARK_WARN_THRESHOLD = 40; // provisional: mean luminance, 0-255.

export interface PhotoAnalysis { name: string; width: number; height: number; sha256: string; sharpness: number; luminance: number }
export type CaptureAnalysis = PhotoAnalysis | { name: string; unreadable: true };
export interface CaptureSummary { blocking: string[]; warnings: string[] }
/** `flagged`: indices (into the analysed list) of the photos that cause a per-photo blocking issue. */
export type CaptureChecks = CaptureSummary & { flagged: number[] };

const MAX_LISTED = 3;
export function listNames(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED).join(', ');
  return names.length > MAX_LISTED ? `${shown} y ${names.length - MAX_LISTED} más` : shown;
}

export function checkDimensions(photos: Pick<PhotoAnalysis, 'name' | 'width' | 'height'>[]): CaptureSummary {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const bySize = new Map<string, string[]>();
  for (const p of photos) {
    const key = `${p.width}×${p.height}`;
    bySize.set(key, [...(bySize.get(key) ?? []), p.name]);
  }
  if (bySize.size > 1) {
    // The production worker models a single camera: every photo must share one resolution.
    const groups = [...bySize.entries()].sort((a, b) => b[1].length - a[1].length);
    const odd = groups.slice(1).flatMap(([, names]) => names);
    blocking.push(`Las fotos tienen tamaños distintos (${groups.map(([size]) => size).join(', ')}). No mezcles fotos verticales y horizontales, zoom ni cámaras distintas. Revisa: ${listNames(odd)}.`);
  }
  const shortSide = (p: Pick<PhotoAnalysis, 'width' | 'height'>) => Math.min(p.width, p.height);
  const tooSmall = photos.filter(p => shortSide(p) < MIN_SHORT_SIDE_PX).map(p => p.name);
  const small = photos.filter(p => shortSide(p) >= MIN_SHORT_SIDE_PX && shortSide(p) < RECOMMENDED_SHORT_SIDE_PX).map(p => p.name);
  if (tooSmall.length) blocking.push(`Resolución insuficiente (lado corto inferior a ${MIN_SHORT_SIDE_PX} px): ${listNames(tooSmall)}. Usa los originales a máxima resolución.`);
  if (small.length) warnings.push(`Resolución baja (lado corto inferior a ${RECOMMENDED_SHORT_SIDE_PX} px): ${listNames(small)}. Se recomienda la resolución máxima de la cámara.`);
  return { blocking, warnings };
}

export function findDuplicates(photos: Pick<PhotoAnalysis, 'name' | 'sha256'>[]): string[][] {
  const byHash = new Map<string, string[]>();
  for (const p of photos) byHash.set(p.sha256, [...(byHash.get(p.sha256) ?? []), p.name]);
  return [...byHash.values()].filter(names => names.length > 1);
}

/** Fine-to-coarse detail ratio. A flat image has no detail to judge: report it as sharp, never as blurry. */
export function sharpnessRatio(fine: number, coarse: number): number {
  return coarse > 0 ? fine / coarse : 1;
}

/** Variance of the 4-neighbour Laplacian over interior pixels. Higher means sharper. */
export function blurScore(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += v; sumSq += v * v; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function meanLuminance(gray: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return gray.length ? sum / gray.length : 0;
}

export function summarize(results: CaptureAnalysis[], minimum = MIN_CAPTURE_FILES): CaptureChecks {
  const photos = results.filter((r): r is PhotoAnalysis => !('unreadable' in r));
  const unreadable = results.filter(r => 'unreadable' in r).map(r => r.name);
  const { blocking, warnings } = checkDimensions(photos);
  // Warn only: a browser that cannot decode or measure a photo must not block an otherwise valid capture.
  if (unreadable.length) warnings.unshift(`No se han podido comprobar estas fotos en tu navegador: ${listNames(unreadable)}. Asegúrate de que son JPG o PNG originales.`);
  const duplicates = findDuplicates(photos);
  // The same file picked twice shares its name; "a.jpg = a.jpg" reads as a bug.
  const describe = (group: string[]) => new Set(group).size === 1 ? `${group[0]} (seleccionada ${group.length} veces)` : group.join(' = ');
  if (duplicates.length) blocking.push(`Hay fotos duplicadas (mismo archivo): ${listNames(duplicates.map(describe))}. Quita las copias.`);
  if (results.length && results.length < minimum) blocking.unshift(`Tienes ${results.length} fotos; faltan ${minimum - results.length} para el mínimo de ${minimum}. Añade fotos de la misma estancia siguiendo la guía.`);
  if (results.length >= minimum && results.length < RECOMMENDED_CAPTURE_FILES) warnings.push(`Tienes ${results.length} fotos. Con menos de ${RECOMMENDED_CAPTURE_FILES} por estancia la reconstrucción puede fallar; si puedes, añade más siguiendo la guía.`);
  // Report a dark photo once, as dark: noise and underexposure make its sharpness unreliable.
  const blurry = photos.filter(p => p.sharpness < BLUR_WARN_THRESHOLD && p.luminance >= DARK_WARN_THRESHOLD).map(p => p.name);
  if (blurry.length) warnings.push(`Posiblemente movidas o desenfocadas: ${listNames(blurry)}. Repítelas con el móvil estable.`);
  const dark = photos.filter(p => p.luminance < DARK_WARN_THRESHOLD).map(p => p.name);
  if (dark.length) warnings.push(`Muy oscuras: ${listNames(dark)}. Añade luz o repítelas con iluminación constante.`);
  return { blocking, warnings, flagged: flagBlockingPhotos(results) };
}

/** Same rules as checkDimensions/findDuplicates, by index: odd-size photos (minority sizes), too small, and repeat copies. */
export function flagBlockingPhotos(results: CaptureAnalysis[]): number[] {
  const sizes = new Map<string, number>();
  for (const r of results) if (!('unreadable' in r)) sizes.set(`${r.width}×${r.height}`, (sizes.get(`${r.width}×${r.height}`) ?? 0) + 1);
  const majority = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const seen = new Set<string>();
  const flagged: number[] = [];
  results.forEach((r, i) => {
    if ('unreadable' in r) return;
    const repeated = seen.has(r.sha256);
    seen.add(r.sha256);
    if (repeated || `${r.width}×${r.height}` !== majority || Math.min(r.width, r.height) < MIN_SHORT_SIDE_PX) flagged.push(i);
  });
  return flagged;
}

/** Draws the bitmap with its long side at `longSide` px (never upscaled) and returns luma. */
function grayAt(bitmap: ImageBitmap, longSide: number) {
  const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const context = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h).getContext('2d')
    : Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d');
  if (!context) throw new Error('Canvas 2D unavailable');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, w, h);
  const rgba = context.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return { gray, w, h };
}

/** Browser-only: decodes with EXIF orientation applied and measures 1024 px and 512 px downscaled copies. */
export async function analyzeFile(file: File): Promise<PhotoAnalysis> {
  const [bitmap, digest] = await Promise.all([
    createImageBitmap(file, { imageOrientation: 'from-image' }),
    file.arrayBuffer().then(buffer => crypto.subtle.digest('SHA-256', buffer)),
  ]);
  try {
    const fine = grayAt(bitmap, DETAIL_LONG_SIDE_PX);
    const coarse = grayAt(bitmap, ANALYSIS_LONG_SIDE_PX);
    const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    return { name: file.name, width: bitmap.width, height: bitmap.height, sha256,
      sharpness: sharpnessRatio(blurScore(fine.gray, fine.w, fine.h), blurScore(coarse.gray, coarse.w, coarse.h)),
      luminance: meanLuminance(coarse.gray) };
  } finally { bitmap.close(); }
}
