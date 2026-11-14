"""Download a pinned baseline and check offline CPU inference. No training."""
import argparse, hashlib, json, shutil, tarfile, urllib.request
from pathlib import Path
MODEL = "facebook/mask2former-swin-small-ade-semantic"
REVISION = "717a6bb84e96b508536efed40a8718b6a45cd87c"
WEIGHT_SHA = "2533310a1e902580a79e575814f1fa04078a99e2321b9bda7afd4f22bba49189"

def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

def download():
    root = Path("model-package")
    root.mkdir(exist_ok=True)
    for name in ["config.json", "preprocessor_config.json", "model.safetensors", "README.md"]:
        urllib.request.urlretrieve(f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}", root / name)
    assert digest(root / "model.safetensors") == WEIGHT_SHA, "Checkpoint checksum mismatch"
    config = json.loads((root / "config.json").read_text())
    labels = config["id2label"]
    for required in ["wall", "floor", "ceiling"]:
        assert required in labels.values(), required
    (root / "labels.json").write_text(json.dumps(labels, indent=2))
    provenance = {"model": MODEL, "revision": REVISION, "weight_sha256": WEIGHT_SHA,
        "training_status": "upstream pretrained, not fine-tuned on construction dataset",
        "checkpoint_license_metadata": "other",
        "license_status": "Checkpoint-specific commercial rights not confirmed. Upstream source code MIT does not automatically establish weight licensing.",
        "upstream_code_license_url": "https://github.com/facebookresearch/Mask2Former/blob/main/LICENSE"}
    (root / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2))
    shutil.copy(Path(__file__).with_name("README.md"), root / "PROJECT_README.md")
    return root

def predict(root, image, out):
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation
    torch.set_num_threads(2)
    processor = AutoImageProcessor.from_pretrained(root, local_files_only=True, use_fast=False)
    model = Mask2FormerForUniversalSegmentation.from_pretrained(root, local_files_only=True, use_safetensors=True).eval()
    if image:
        im = ImageOps.exif_transpose(Image.open(image)).convert("RGB")
        im.thumbnail((1280, 1280))
    else:
        # Synthetic input verifies execution and dimensions only, never accuracy.
        im = Image.fromarray(np.random.default_rng(42).integers(0, 256, (256, 320, 3), dtype=np.uint8))
    with torch.inference_mode():
        outputs = model(**processor(images=im, return_tensors="pt"))
    assert torch.isfinite(outputs.class_queries_logits).all()
    seg = processor.post_process_semantic_segmentation(outputs, target_sizes=[(im.height, im.width)])[0].cpu().numpy()
    assert seg.shape == (im.height, im.width)
    assert seg.min() >= 0 and seg.max() < len(model.config.id2label)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(seg.astype(np.uint8)).save(out / "semantic-labels.png")
    report = {"check": "offline CPU inference passed", "input": str(image) if image else "synthetic noise: execution check only",
        "accuracy_evaluated": False, "width": im.width, "height": im.height,
        "classes": [{"id": int(k), "label": model.config.id2label[int(k)], "pixels": int((seg == k).sum())} for k in np.unique(seg)]}
    (out / "inference-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--download", action="store_true")
    p.add_argument("--model", default="model-package")
    p.add_argument("--image")
    p.add_argument("--output", default="prediction")
    a = p.parse_args()
    root = download() if a.download else Path(a.model)
    predict(root, a.image, a.output)
    if a.download:
        shutil.copy(Path(a.output) / "inference-report.json", root / "smoke-test.json")
        (root / "SHA256SUMS").write_text("".join(f"{digest(f)}  {f.name}\n" for f in sorted(root.iterdir()) if f.is_file() and f.name != "SHA256SUMS"))
        with tarfile.open("mask2former-interiors-baseline.tar.gz", "w:gz") as tar:
            tar.add(root, arcname="model-package")
