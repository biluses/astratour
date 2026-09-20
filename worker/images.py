"""Decode and normalize untrusted photos in a bounded child process before COLMAP."""
import json
import sys
import warnings
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def normalize(manifest_path: Path) -> None:
    manifest = json.loads(manifest_path.read_text())
    dimensions = None
    for entry in manifest["files"]:
        with Image.open(entry["localPath"]) as source:
            if source.format not in {"JPEG", "PNG"} or getattr(source, "n_frames", 1) != 1:
                raise ValueError("Only still JPEG/PNG images are supported")
            expected = "PNG" if entry["contentType"] == "image/png" else "JPEG"
            if source.format != expected:
                raise ValueError("Image content differs from declared type")
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            if min(image.size) < 256:
                raise ValueError("Input images are too small for reconstruction")
            # One camera/intrinsics model: reject mixed dimensions rather than crop/stretch silently.
            if dimensions is not None and image.size != dimensions:
                raise ValueError("Use photos with consistent resolution and orientation")
            dimensions = image.size
            # A newly encoded RGB image carries no source EXIF, location, profiles or hidden metadata.
            image.save(entry["normalizedPath"], "JPEG", quality=95)


if __name__ == "__main__":
    normalize(Path(sys.argv[1]))
