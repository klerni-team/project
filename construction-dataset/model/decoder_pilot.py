"""CPU pilot updating the material path's final Mask2Former pixel decoder projection."""
import hashlib
import json
import random
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F
from safetensors.torch import load_file, save_file

from mixed_release_data import pairs, registry
from train_dms import (AutoImageProcessor, LABELS, MaterialHead, Mask2FormerForUniversalSegmentation,
                       encode, evaluate, sha)

ROOT = Path("decoder-pilot")
PARENT = "interiors-trained-44258922982"
SOURCE = "materials-dms-43685792992"


def write_json(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2))


def fingerprint(module):
    digest = hashlib.sha256()
    for name, value in module.state_dict().items():
        digest.update(name.encode())
        digest.update(value.detach().contiguous().numpy().tobytes())
    return digest.hexdigest()


def select_examples():
    _, _, releases = registry(Path("construction-dataset/model/iteration-policy.json"), Path("registry"))
    locked = json.loads(Path("resume/split.json").read_text())
    tag, folder, packs, rows = next(item for item in releases if item[0] == SOURCE)
    eligible = [r for r in rows if r["split"] == "train" and r["training_eligible"]]
    known_train = set(locked["train"])
    if not all(r["id"] in known_train for r in eligible):
        raise ValueError("Train IDs disagree with parent split")
    train = random.Random(42).sample(eligible, 1024)
    val = [r for r in rows if r["split"] == "validation" and r["evaluation_eligible"]]
    ids = {r["id"] for r in train}
    if set(locked["validation"]) != {r["id"] for r in val} or ids.intersection(locked["test"] + locked["validation"]):
        raise ValueError("Evaluation split changed or leaked into training")
    write_json("split.json", {"train": [r["id"] for r in train], "validation": locked["validation"]})
    return [(tag, folder, packs, train + val)]


class ProjectedHead(torch.nn.Module):
    def __init__(self, projection, head):
        super().__init__()
        self.projection = projection
        self.head = head

    def forward(self, x):
        y = F.linear(x, self.projection.weight[:, :, 0, 0], self.projection.bias)
        return self.head(y)


def main():
    torch.set_num_threads(2)
    torch.manual_seed(42)
    rng = np.random.default_rng(42)
    ROOT.mkdir()
    cache = Path("pilot-features")
    cache.mkdir()
    releases = select_examples()
    config = json.loads(Path("resume/adapter_config.json").read_text())
    if config["base_weight_sha256"] != sha("model-package/model.safetensors") or config["material_labels"] != LABELS:
        raise ValueError("Material head and base checkpoint disagree")
    base = Mask2FormerForUniversalSegmentation.from_pretrained("model-package", local_files_only=True).eval()
    base.requires_grad_(False)
    pixel = base.model.pixel_level_module
    projection = pixel.decoder.mask_projection
    if projection.kernel_size != (1, 1) or projection.groups != 1:
        raise ValueError("Expected the original pointwise projection")
    original_encoder = fingerprint(pixel.encoder)
    original_projection = fingerprint(projection)
    head = MaterialHead().eval().requires_grad_(False)
    head.load_state_dict(load_file("resume/material-head.safetensors"))
    net = ProjectedHead(projection, head).eval()
    inputs = []
    hook = projection.register_forward_pre_hook(lambda module, args: inputs.append(args[0].detach()))
    processor = AutoImageProcessor.from_pretrained("model-package", local_files_only=True, use_fast=False)
    groups = {"train": [], "validation": []}
    excluded = []
    try:
        for row, image, mask in pairs(releases):
            inputs.clear()
            original, labels, valid = encode(row, base, processor, (image, mask))
            if not len(valid):
                if row["split"] == "validation":
                    raise ValueError("Missing validation labels")
                excluded.append(row["id"])
                continue
            if row["split"] == "train" and len(valid) > 320:
                valid = rng.choice(valid, 320, replace=False)
            features = inputs.pop()[0].flatten(1).T[valid].contiguous()
            if not groups[row["split"]]:
                expected = torch.from_numpy(original[valid])
                actual = F.linear(features, projection.weight.flatten(1), projection.bias)
                torch.testing.assert_close(actual, expected, atol=2e-5, rtol=1e-4)
            path = cache / (str(row["id"]) + ".npz")
            np.savez(path, x=features.numpy(), y=labels[valid].astype(np.uint8))
            groups[row["split"]].append(path)
    finally:
        hook.remove()
    def items(paths):
        for path in paths:
            with np.load(path) as data:
                yield torch.from_numpy(data["x"]), torch.from_numpy(data["y"]).long()

    initial = evaluate(net, items(groups["validation"]))
    best = initial
    best_epoch = 0
    target = ROOT / "mask-projection.safetensors"
    save_file(projection.state_dict(), str(target))
    projection.requires_grad_(True)
    optimizer = torch.optim.AdamW(projection.parameters(), lr=0.00001, weight_decay=0.0)
    history = []
    for epoch in range(1, 4):
        rng.shuffle(groups["train"])
        losses = []
        for x, y in items(groups["train"]):
            optimizer.zero_grad(set_to_none=True)
            loss = F.cross_entropy(net(x), y)
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(projection.parameters(), 1.0)
            optimizer.step()
            losses.append(loss.item())
        if fingerprint(projection) == original_projection:
            raise ValueError("Projection failed to update")
        val = evaluate(net, items(groups["validation"]))
        history.append({"epoch": epoch, "train_loss": float(np.mean(losses)), "validation": val})
        if val["material"]["miou"] > best["material"]["miou"]:
            best, best_epoch = val, epoch
            save_file(projection.state_dict(), str(target))
        write_json("history.json", history)
        print("EPOCH", epoch, val["material"]["miou"], flush=True)
    encoder_after = fingerprint(pixel.encoder)
    if encoder_after != original_encoder:
        raise ValueError("Encoder state changed")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    axes[0].plot([1,2,3], [h["train_loss"] for h in history], label="Train")
    axes[0].plot(range(4), [initial["loss"]] + [h["validation"]["loss"] for h in history], label="Validation")
    axes[0].set_ylabel("Cross-entropy")
    axes[0].legend()
    axes[1].plot(range(4), [100*v["material"]["miou"] for v in [initial]+[h["validation"] for h in history]])
    axes[1].set_ylabel("Validation mIoU (%)")
    for ax in axes:
        ax.set_xlabel("Epoch")
    fig.tight_layout()
    fig.savefig(ROOT / "learning-curves.png")
    plt.close(fig)
    write_json("training-report.json", {"parent_release": PARENT, "train_source": SOURCE,
               "train_images": len(groups["train"]), "validation_images": len(groups["validation"]),
               "excluded_train_ids": excluded, "epochs": len(history), "best_epoch": best_epoch,
               "initial_validation": initial, "best_validation": best, "test_evaluated": False,
               "trainable_module": "model.pixel_level_module.decoder.mask_projection",
               "trainable_parameters": sum(p.numel() for p in projection.parameters()),
               "encoder_sha256_before": original_encoder, "encoder_sha256_after": encoder_after,
               "material_head": "frozen; use parent material head with this projection",
               "base_weight_sha256": config["base_weight_sha256"]})


if __name__ == "__main__":
    main()
