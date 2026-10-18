import { describe, expect, it } from 'vitest';
import { readAzimuth } from '@/lib/exif';

/** Minimal JPEG: SOI, an APP1 Exif segment (IFD0 -> GPS IFD -> optional GPSImgDirection RATIONAL), then SOS. */
function jpeg({ little = true, gps = true, direction = [12345, 100] as [number, number] | null, exif = true } = {}) {
  const tiff = new DataView(new ArrayBuffer(64));
  const u16 = (o: number, v: number) => tiff.setUint16(o, v, little);
  const u32 = (o: number, v: number) => tiff.setUint32(o, v, little);
  u16(0, little ? 0x4949 : 0x4d4d); u16(2, 42); u32(4, 8);
  u16(8, 1); // IFD0 at 8: one entry
  u16(10, gps ? 0x8825 : 0x010f); u16(12, 4); u32(14, 1); u32(18, 26); u32(22, 0);
  u16(26, direction ? 1 : 0); // GPS IFD at 26
  if (direction) {
    u16(28, 0x0011); u16(30, 5); u32(32, 1); u32(36, 44); u32(40, 0);
    u32(44, direction[0]); u32(48, direction[1]);
  }
  const app1 = exif ? [0xff, 0xe1, 0, 2 + 6 + 64, 0x45, 0x78, 0x69, 0x66, 0, 0, ...new Uint8Array(tiff.buffer)] : [];
  return new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xda, 0, 2, 0, 0]).buffer;
}

describe('readAzimuth', () => {
  it('reads GPSImgDirection in little- and big-endian EXIF', () => {
    expect(readAzimuth(jpeg())).toBeCloseTo(123.45);
    expect(readAzimuth(jpeg({ little: false }))).toBeCloseTo(123.45);
  });
  it('returns null when EXIF, GPS or the direction tag is missing', () => {
    expect(readAzimuth(jpeg({ exif: false }))).toBeNull();
    expect(readAzimuth(jpeg({ gps: false }))).toBeNull();
    expect(readAzimuth(jpeg({ direction: null }))).toBeNull();
  });
  it('rejects non-JPEG, truncated and out-of-range input', () => {
    expect(readAzimuth(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull();
    expect(readAzimuth(jpeg().slice(0, 40))).toBeNull();
    expect(readAzimuth(jpeg({ direction: [1, 0] }))).toBeNull();
    expect(readAzimuth(jpeg({ direction: [400, 1] }))).toBeNull();
  });
});
