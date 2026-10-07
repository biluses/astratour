/** Client-side capture checks run before upload. Pure functions plus one browser-only helper (analyzeFile). */
import { MIN_CAPTURE_FILES, RECOMMENDED_CAPTURE_FILES } from '@/lib/contracts';

export const MIN_SHORT_SIDE_PX = 720; // provisional: blocks captures too small for reliable feature matching.
export const RECOMMENDED_SHORT_SIDE_PX = 1080; // provisional
export const ANALYSIS_LONG_SIDE_PX = 512; // blur and luminance are measured on images downscaled to this long side.
// Laplacian variance at 512 px long side. Calibrated on 52 real indoor photos: sharp p5 = 88,
// 1 px Gaussian blur p95 = 47. Textureless walls can score low, so this only warns.
export const BLUR_WARN_THRESHOLD = 60;
export const DARK_WARN_THRESHOLD = 40; // provisional: mean luminance, 0-255.
// Uploads are downscaled to this long side. COLMAP SIFT benefits from more detail than the ~1600 px
// the trainer uses; tune later. Set to Infinity to upload JPEG originals untouched (rollback).
export const UPLOAD_LONG_SIDE_PX = 2048;
export const UPLOAD_JPEG_QUALITY = 0.9;

export interface PhotoAnalysis { name: string; width: number; height: number; sha256: string; blur: number; luminance: number }
export type CaptureAnalysis = PhotoAnalysis | { name: string; unreadable: true };
export interface CaptureSummary { blocking: string[]; warnings: string[] }

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

export function summarize(results: CaptureAnalysis[], minimum = MIN_CAPTURE_FILES): CaptureSummary {
  const photos = results.filter((r): r is PhotoAnalysis => !('unreadable' in r));
  const unreadable = results.filter(r => 'unreadable' in r).map(r => r.name);
  const { blocking, warnings } = checkDimensions(photos);
  // Warn only: a browser that cannot decode or measure a photo must not block an otherwise valid capture.
  if (unreadable.length) warnings.unshift(`No se han podido comprobar estas fotos en tu navegador: ${listNames(unreadable)}. Asegúrate de que son JPG o PNG originales.`);
  const duplicates = findDuplicates(photos);
  if (duplicates.length) blocking.push(`Hay fotos duplicadas (mismo archivo): ${listNames(duplicates.map(group => group.join(' = ')))}. Quita las copias.`);
  if (results.length && results.length < minimum) blocking.unshift(`Tienes ${results.length} fotos; faltan ${minimum - results.length} para el mínimo de ${minimum}. Añade fotos de la misma estancia siguiendo la guía.`);
  if (results.length >= minimum && results.length < RECOMMENDED_CAPTURE_FILES) warnings.push(`Tienes ${results.length} fotos. Con menos de ${RECOMMENDED_CAPTURE_FILES} por estancia la reconstrucción puede fallar; si puedes, añade más siguiendo la guía.`);
  // Dark photos also score low on blur; report them once, as dark.
  const blurry = photos.filter(p => p.blur < BLUR_WARN_THRESHOLD && p.luminance >= DARK_WARN_THRESHOLD).map(p => p.name);
  if (blurry.length) warnings.push(`Posiblemente movidas o desenfocadas: ${listNames(blurry)}. Repítelas con el móvil estable.`);
  const dark = photos.filter(p => p.luminance < DARK_WARN_THRESHOLD).map(p => p.name);
  if (dark.length) warnings.push(`Muy oscuras: ${listNames(dark)}. Añade luz o repítelas con iluminación constante.`);
  return { blocking, warnings };
}

/** Deterministic, so every photo from one camera (same oriented size) maps to the same output size. */
export function uploadSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, UPLOAD_LONG_SIDE_PX / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** JPEGs already within the upload size pass through byte-for-byte; everything else is re-encoded as JPEG. */
export function needsReencode(type: string, width: number, height: number): boolean {
  return type !== 'image/jpeg' || Math.max(width, height) > UPLOAD_LONG_SIDE_PX;
}

export function uploadName(name: string): string {
  return `${name.replace(/\.[^.]*$/, '')}.jpg`;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
function context2d(width: number, height: number): Canvas2D {
  const context = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height).getContext('2d')
    : Object.assign(document.createElement('canvas'), { width, height }).getContext('2d');
  if (!context) throw new Error('Canvas 2D unavailable');
  context.imageSmoothingQuality = 'high';
  return context;
}

function toJpeg(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  const options = { type: 'image/jpeg', quality: UPLOAD_JPEG_QUALITY };
  if ('convertToBlob' in canvas) return canvas.convertToBlob(options);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG encode failed')), options.type, options.quality));
}

/**
 * Browser-only: decodes once with EXIF orientation applied, measures a 512 px downscaled copy and
 * prepares the file to upload. Analysis always describes the original (dimensions, SHA-256).
 */
export async function analyzeFile(file: File): Promise<{ analysis: PhotoAnalysis; upload: File }> {
  const [bitmap, digest] = await Promise.all([
    createImageBitmap(file, { imageOrientation: 'from-image' }),
    file.arrayBuffer().then(buffer => crypto.subtle.digest('SHA-256', buffer)),
  ]);
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, ANALYSIS_LONG_SIDE_PX / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const context = context2d(w, h);
    context.drawImage(bitmap, 0, 0, w, h);
    const rgba = context.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const analysis = { name: file.name, width, height, sha256, blur: blurScore(gray, w, h), luminance: meanLuminance(gray) };
    if (!needsReencode(file.type, width, height)) return { analysis, upload: file };
    const target = uploadSize(width, height);
    const output = context2d(target.width, target.height);
    output.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await toJpeg(output.canvas);
    return { analysis, upload: new File([blob], uploadName(file.name), { type: 'image/jpeg', lastModified: file.lastModified }) };
  } finally { bitmap.close(); }
}
