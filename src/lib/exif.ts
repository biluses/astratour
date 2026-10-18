/**
 * Compass azimuth of a JPEG (EXIF GPS tag 0x0011 GPSImgDirection, degrees clockwise from north), or null.
 * Must run on the original file: the 2048 px re-encode drops EXIF.
 */
export function readAzimuth(buffer: ArrayBuffer): number | null {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xffd8) return null;
    for (let offset = 2; offset + 4 < view.byteLength;) {
      const marker = view.getUint16(offset);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // not a marker, or image data started
      if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) { // "Exif"
        const tiff = offset + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const u16 = (p: number) => view.getUint16(tiff + p, little);
        const u32 = (p: number) => view.getUint32(tiff + p, little);
        const find = (ifd: number, tag: number) => {
          for (let i = 0, n = u16(ifd); i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12;
          return -1;
        };
        const gps = find(u32(4), 0x8825);
        if (gps < 0) return null;
        const entry = find(u32(gps + 8), 0x0011);
        if (entry < 0) return null;
        const value = u32(entry + 8); // RATIONAL: always stored at an offset
        const denominator = u32(value + 4);
        const azimuth = denominator ? u32(value) / denominator : NaN;
        return azimuth >= 0 && azimuth <= 360 ? azimuth : null;
      }
      offset += 2 + view.getUint16(offset + 2);
    }
  } catch { /* Truncated or malformed EXIF: treat as missing. */ }
  return null;
}
