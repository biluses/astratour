"""Render trained Splatfacto (never input photos), then burn watermarks into pixels.

Imported only inside the GPU container; orchestration tests do not fake this module.
"""
import json
import math
import sys
from pathlib import Path

import torch
from PIL import Image, ImageDraw, ImageFont
from nerfstudio.utils.eval_utils import eval_setup


def viewer_vector(vector):
    """Nerfstudio z-up -> PlayCanvas y-up, matching packaging's Rx(-90)."""
    x, y, z = [float(value) for value in vector]
    return [x, z, -y]


def watermark(rgb: Image.Image, output: Path) -> None:
    rgb.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
    image = rgb.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    # Pillow bundled DejaVu on most Linux hosts; default font still burns a visible tiled watermark.
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", max(16, image.width // 38))
    except OSError:
        font = ImageFont.load_default()
    label = "ASTRATOUR - VISTA PREVIA - REQUIERE PAGO"
    for y in range(20, image.height, max(90, image.height // 4)):
        box = draw.textbbox((0, 0), label, font=font)
        x = max(8, (image.width - box[2]) // 2)
        draw.rectangle((0, y - 8, image.width, y + box[3] + 8), fill=(0, 0, 0, 130))
        draw.text((x, y), label, font=font, fill=(255, 255, 255, 225))
    Image.alpha_composite(image, overlay).convert("RGB").save(output, "JPEG", quality=78)


def render(config_path: Path, manifest_path: Path, output_dir: Path, count: int) -> None:
    manifest = json.loads(manifest_path.read_text())
    image_ids = {entry["frameName"]: entry["id"] for entry in manifest["files"]}
    # Config/checkpoint come exclusively from this worker's ns-train invocation, never from an upload.
    _, pipeline, _, _ = eval_setup(config_path, test_mode="inference")
    dataset = pipeline.datamanager.train_dataset
    cameras = dataset.cameras
    filenames = pipeline.datamanager.train_dataparser_outputs.image_filenames
    selected = sorted({round(i * (len(filenames) - 1) / max(1, count - 1)) for i in range(min(count, len(filenames)))})
    output_dir.mkdir(exist_ok=True)
    previews = []
    pose = None
    with torch.no_grad():
        for index in selected:
            image_id = image_ids[Path(filenames[index]).name]
            camera = cameras[index:index + 1].to(pipeline.device)
            scale = min(1.0, 1280.0 / max(int(camera.width[0]), int(camera.height[0])))
            camera.rescale_output_resolution(scale)
            result = pipeline.model.get_outputs_for_camera(camera)
            pixels = (result["rgb"].clamp(0, 1).detach().cpu().numpy() * 255).astype("uint8")
            output = output_dir / f"{image_id}.jpg"
            watermark(Image.fromarray(pixels), output)
            previews.append({"imageId": image_id, "localPath": str(output)})
            if pose is None:
                matrix = camera.camera_to_worlds[0].detach().cpu().numpy()
                position = matrix[:, 3]
                target = position - matrix[:, 2]
                fov = math.degrees(2 * math.atan(float(camera.height[0]) / (2 * float(camera.fy[0]))))
                pose = {"position": viewer_vector(position), "target": viewer_vector(target), "fov": max(20, min(120, fov))}
    if not previews or pose is None:
        raise RuntimeError("No model renders were generated")
    (output_dir / "manifest.json").write_text(json.dumps({"camera": pose, "previews": previews}))


if __name__ == "__main__":
    render(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]))
