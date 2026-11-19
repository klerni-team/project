"""One full CPU epoch updating the pixel decoder and material head together."""
import argparse
import io
import json
from pathlib import Path
import random
import shutil

import numpy as np
from PIL import Image, ImageEnhance, ImageOps
import torch
from torch.nn import functional as F
from safetensors.torch import load_file, save_file
from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation

from decoder_pilot import fingerprint
from mixed_release_data import pairs, registry
from train_dms import IDS, LABELS, MaterialHead, sha, summarize, target_mask

PARTS = 8
BATCH = 4
OUTPUT = Path("joint-output")
PARENT = "interiors-trained-44258922982"


def augment(image, rng):
    if rng.random() < 0.25:
        return image
    if rng.random() < 0.35:
        image = ImageOps.grayscale(image).convert("RGB")
    else:
        image = ImageEnhance.Color(image).enhance(rng.uniform(0.15, 1.2))
    image = ImageEnhance.Contrast(image).enhance(rng.uniform(0.75, 1.25))
    image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.85, 1.15))
    if rng.random() < 0.35:
        rgb = np.asarray(image, dtype=np.float32)
        noise = rng.normal(0, rng.uniform(1, 5), rgb.shape[:2] + (1,))
        image = Image.fromarray(np.clip(rgb + noise, 0, 255).astype(np.uint8))
    return image


def collect(part, split):
    _, rows, releases = registry(Path("construction-dataset/model/iteration-policy.json"), Path("registry"))
    locked = json.loads(Path("resume/split.json").read_text())
    groups = {s: {str(k) for k in ids} for s, ids in locked.items()}
    if sum(map(len, groups.values())) != len(set.union(*groups.values())):
        raise ValueError("Parent split overlap")
    for s, ids in groups.items():
        if ids != {str(r["id"]) for r in rows if r["split"] == s}:
            raise ValueError(f"Manifest differs from the locked {s} split")
    # Keep pack numbering identical across all training partitions.
    inventory = [(tag, folder, packs, [r for r in group if r["split"] == split])
                 for tag, folder, packs, group in releases]
    if split == "validation":
        inventory = [entry for entry in inventory if entry[3]]
    cache = Path("images")
    cache.mkdir()
    files = {}
    for row, jpg, png in pairs(inventory, part if split == "train" else 0, PARTS if split == "train" else 1):
        key = str(row["id"])
        if key not in groups[split] or key in files:
            raise ValueError(f"Unexpected ID {key}")
        with Image.open(io.BytesIO(jpg)) as photo, Image.open(io.BytesIO(png)) as mask:
            if photo.size != mask.size or photo.size != (row["width"], row["height"]) or photo.getexif().get(274, 1) != 1:
                raise ValueError(f"Unaligned pair {key}")
            image = np.asarray(photo.convert("RGB").resize((256, 256), Image.Resampling.BILINEAR))
            native = np.asarray(mask.resize((64, 64), Image.Resampling.NEAREST))
            if native.ndim != 2 or native.max() > 56:
                raise ValueError(f"Invalid target mask {key}")
            target = target_mask(native).astype(np.uint8)
        if (target == 255).all():
            raise ValueError(f"Missing labeled pixels {key}")
        path = cache / f"sample-{len(files)}.npz"
        np.savez(path, x=image, y=target)
        files[key] = path
    if not files or (split == "validation" and set(files) != groups[split]):
        raise ValueError("Incomplete partition")
    return files, groups


def batches(files, keys, transform):
    for i in range(0, len(keys), BATCH):
        images, targets = [], []
        for key in keys[i:i+BATCH]:
            with np.load(files[key]) as sample:
                images.append(transform(Image.fromarray(sample["x"])))
                targets.append(torch.from_numpy(sample["y"].astype(np.int64)))
        yield images, torch.stack(targets)


class Experiment:
    def __init__(self):
        config = json.loads(Path("resume/adapter_config.json").read_text())
        if config["base_weight_sha256"] != sha("model-package/model.safetensors") or config["material_labels"] != LABELS or config["dms_ids"] != IDS:
            raise ValueError("Incompatible parent checkpoint")
        base = Mask2FormerForUniversalSegmentation.from_pretrained("model-package", local_files_only=True)
        self.pixel = base.model.pixel_level_module.eval().requires_grad_(False)
        self.decoder = self.pixel.decoder.requires_grad_(True)
        pilot = json.loads(Path("projection/training-report.json").read_text())
        if pilot["base_weight_sha256"] != config["base_weight_sha256"] or pilot["parent_release"] != PARENT:
            raise ValueError("Incompatible pilot projection")
        self.decoder.mask_projection.load_state_dict(load_file("projection/mask-projection.safetensors"))
        self.head = MaterialHead()
        self.head.load_state_dict(load_file("resume/material-head.safetensors"))
        self.processor = AutoImageProcessor.from_pretrained("model-package", use_fast=False, local_files_only=True)
        self.encoder_hash = fingerprint(self.pixel.encoder)
        if self.encoder_hash != pilot["encoder_sha256_after"]:
            raise ValueError("Encoder differs from the pilot")
        self.opt = torch.optim.AdamW([{"params": self.decoder.parameters(), "lr": 1e-6},
                                      {"params": self.head.parameters(), "lr": 1e-5}], weight_decay=0.01)

    def predict(self, images):
        x = self.processor(images=images, do_resize=False, return_tensors="pt")["pixel_values"]
        # No no_grad around the decoder. Only the encoder has requires_grad=False.
        features = self.pixel(x).decoder_last_hidden_state
        return self.head(features.permute(0, 2, 3, 1)).permute(0, 3, 1, 2)

    def verify_encoder(self):
        if fingerprint(self.pixel.encoder) != self.encoder_hash or any(p.grad is not None for p in self.pixel.encoder.parameters()):
            raise ValueError("Frozen encoder changed")


@torch.no_grad()
def validate(model, files, grayscale=False):
    model.pixel.eval()
    model.head.eval()
    cm = torch.zeros((len(LABELS), len(LABELS)), dtype=torch.long)
    losses = []
    transform = (lambda im: ImageOps.grayscale(im).convert("RGB")) if grayscale else (lambda im: im)
    for images, targets in batches(files, sorted(files), transform):
        logits = model.predict(images)
        pred = logits.argmax(1)
        valid = targets != 255
        labels = targets[valid]
        cm += torch.bincount(labels * len(LABELS) + pred[valid], minlength=cm.numel()).reshape_as(cm)
        loss = F.cross_entropy(logits, targets, ignore_index=255, reduction="none")
        per_image = loss.flatten(1).sum(1) / valid.flatten(1).sum(1)
        losses.extend(per_image.tolist())
    result = summarize(cm, losses)
    result["confusion_matrix_true_by_predicted"] = cm.tolist()
    wallpaper = cm[LABELS.index("wallpaper")]
    result["wallpaper_true_pixels"] = int(wallpaper.sum())
    result["wallpaper_predicted_as"] = dict(zip(LABELS, wallpaper.tolist()))
    return result


def run(stage):
    torch.set_num_threads(2)
    torch.manual_seed(4200 + stage)
    OUTPUT.mkdir()
    model = Experiment()
    if stage == -1:
        sample = Image.fromarray(np.random.default_rng(1).integers(0, 256, (256, 256, 3), dtype=np.uint8))
        model.predict([sample]).square().mean().backward()
        for module in (model.decoder, model.head):
            if not any(p.grad is not None and p.grad.abs().max().item() > 0 for p in module.parameters()):
                raise ValueError("Failed backward pass")
        model.verify_encoder()
        model.opt.zero_grad(set_to_none=True)
        print("JOINT_BACKWARD_OK", flush=True)
    is_train = 0 <= stage < PARTS
    files, groups = collect(stage, "train" if is_train else "validation")
    parent = Path("previous-joint")
    info_file = OUTPUT / "state.json"
    if stage == -1:
        clean = validate(model, files)
        gray = validate(model, files, grayscale=True)
        model.verify_encoder()
        info_file.write_text(json.dumps({"clean_start": clean, "gray_start": gray, "visited": [], "stages": [],
                                         "stage": -1, "encoder_sha256": model.encoder_hash,
                                         "classes": LABELS, "train_target": len(groups["train"]),
                                         "validation_images": len(files)}))
        return
    state = json.loads((parent/"state.json").read_text())
    if state["stage"] != stage-1 or state["encoder_sha256"] != model.encoder_hash:
        raise ValueError("Wrong predecessor")
    if stage > 0:
        model.decoder.load_state_dict(load_file(str(parent/"decoder.safetensors")))
        model.head.load_state_dict(load_file(str(parent/"head.safetensors")))
        if is_train:
            model.opt.load_state_dict(torch.load(parent/"optimizer.pt", map_location="cpu", weights_only=True))
    if is_train:
        if set(state["visited"]) & set(files):
            raise ValueError("Training shard repeated")
        model.pixel.encoder.eval()
        model.decoder.train()
        model.head.train()
        rng = np.random.default_rng(8200+stage)
        keys = list(files)
        random.Random(3200+stage).shuffle(keys)
        losses = []
        for images, targets in batches(files, keys, lambda im: augment(im, rng)):
            model.opt.zero_grad(set_to_none=True)
            loss = F.cross_entropy(model.predict(images), targets, ignore_index=255)
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite train loss")
            loss.backward()
            if not losses:
                # Check that an internal decoder weight and the head really receive gradients.
                gradients = [p.grad for n,p in model.decoder.named_parameters() if "mask_projection" not in n and p.grad is not None]
                if not any(g.abs().max().item()>0 for g in gradients) or not any(p.grad is not None and p.grad.abs().max().item()>0 for p in model.head.parameters()):
                    raise ValueError("Missing decoder or head gradients")
            torch.nn.utils.clip_grad_norm_(list(model.decoder.parameters())+list(model.head.parameters()),1.0,error_if_nonfinite=True)
            model.opt.step()
            losses.append(float(loss.detach()))
            if len(losses)%100==0:
                print("BATCH",stage,len(losses),flush=True)
        state["visited"].extend(keys)
        state["stages"].append({"part":stage,"images":len(keys),"updates":len(losses),"train_loss":float(np.mean(losses))})
        save_file(model.decoder.state_dict(), str(OUTPUT/"decoder.safetensors"))
        save_file(model.head.state_dict(), str(OUTPUT/"head.safetensors"))
        torch.save(model.opt.state_dict(), OUTPUT/"optimizer.pt")
    else:
        if set(state["visited"]) != groups["train"] or len(state["visited"]) != len(groups["train"]):
            raise ValueError("Full training coverage failed")
        clean = validate(model, files)
        gray = validate(model, files, grayscale=True)
        keep = clean["material"]["miou"] > state["clean_start"]["material"]["miou"]
        if keep:
            for name in ("decoder.safetensors","head.safetensors"):
                shutil.copyfile(parent/name, OUTPUT/name)
        else:
            start = Experiment()
            save_file(start.decoder.state_dict(), str(OUTPUT/"decoder.safetensors"))
            save_file(start.head.state_dict(), str(OUTPUT/"head.safetensors"))
        import matplotlib.pyplot as plt
        fig, axes = plt.subplots(1, 2, figsize=(10,4))
        axes[0].plot(range(1, PARTS+1), [part["train_loss"] for part in state["stages"]], marker="o")
        axes[0].set(xlabel="Sequential training partition", ylabel="Mean training loss")
        for label, first, last in [("Color", state["clean_start"], clean), ("Grayscale", state["gray_start"], gray)]:
            axes[1].plot([0, 1], [100 * r["material"]["miou"] for r in (first, last)], marker="o", label=label)
        axes[1].set(xlabel="Completed epochs", ylabel="Validation mIoU (%)", xticks=[0, 1])
        axes[1].legend()
        fig.tight_layout()
        fig.savefig(OUTPUT / "learning-curves.png", dpi=150)
        plt.close(fig)
        state.update(clean_after=clean,gray_after=gray,selected_epoch=int(keep),test_evaluated=False,
                     trained_decoder_parameters=sum(p.numel() for p in model.decoder.parameters()),
                     trained_head_parameters=sum(p.numel() for p in model.head.parameters()),
                     parent_head=PARENT,parent_projection_artifact=14438615454)
    model.verify_encoder()
    state["stage"] = stage
    info_file.write_text(json.dumps(state))
    print("DONE",stage,"train seen",len(state["visited"]),flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("stage",type=int,choices=range(-1,PARTS+1))
    run(parser.parse_args().stage)
