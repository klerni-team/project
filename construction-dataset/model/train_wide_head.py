"""Paired comparison of two material heads on identical frozen features."""
import json
import random
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from safetensors.torch import load_file, save_file

from decoder_pilot import fingerprint
from mixed_release_data import pairs, registry
from train_dms import (AutoImageProcessor, IDS, LABELS, Mask2FormerForUniversalSegmentation,
                       MaterialHead, cached, encode, evaluate, sha)

OUT = Path("head-pilot")
EPOCHS = 4
SEED = 20261120
WIDTH = 695


def write(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2))


def get_features(model):
    _, rows, releases = registry(Path("construction-dataset/model/iteration-policy.json"), Path("registry"))
    split = json.loads(Path("resume/split.json").read_text())
    groups = {k: {str(i) for i in ids} for k, ids in split.items()}
    assert sum(map(len, groups.values())) == len(set.union(*groups.values()))
    for key, ids in groups.items():
        assert ids == {str(row["id"]) for row in rows if row["split"] == key}
    train = set(random.Random(SEED).sample(sorted(groups["train"]), 10000))
    val = groups["validation"]
    assert len(val) == 1024
    selected = train | val
    inventory = [(tag, folder, packs, [r for r in entries if str(r["id"]) in selected])
                 for tag, folder, packs, entries in releases]
    processor = AutoImageProcessor.from_pretrained("model-package", local_files_only=True, use_fast=False)
    root = Path("feature-cache")
    root.mkdir()
    paths = {"train": [], "validation": []}
    seen = set()
    hist = np.zeros(len(LABELS), dtype=np.int64)
    rng = np.random.default_rng(SEED)
    for row, photo, mask in pairs(inventory):
        key = str(row["id"])
        assert key not in seen and key in selected
        features, target, valid = encode(row, model, processor, (photo, mask))
        assert len(valid), f"No valid labels: {key}"
        if row["split"] == "train":
            hist += np.bincount(target[valid], minlength=len(LABELS))
            if len(valid) > 320:
                chunks = [rng.choice(valid, 144, replace=False)]
                for label in np.unique(target[valid]):
                    candidates = valid[target[valid] == label]
                    chunks.append(rng.choice(candidates, min(8, len(candidates)), replace=False))
                valid = np.unique(np.concatenate(chunks))
        path = root / f"{len(seen)}.npz"
        np.savez(path, x=features[valid].astype("float16"), y=target[valid].astype("uint8"))
        paths[row["split"]].append(path)
        seen.add(key)
        if len(seen) % 500 == 0:
            print("ENCODED", len(seen), flush=True)
    assert seen == selected and len(paths["train"]) == 10000
    write("split.json", {"train": sorted(train), "validation": sorted(val), "seed": SEED})
    return paths, hist


def widen(small):
    head = MaterialHead()
    head.linear.load_state_dict(small.linear.state_dict())
    head.residual[0].load_state_dict(small.residual[0].state_dict())
    head.residual[1] = nn.Linear(256, WIDTH)
    head.residual[4] = nn.Linear(WIDTH, len(LABELS))
    with torch.no_grad():
        head.residual[1].weight[:128].copy_(small.residual[1].weight)
        head.residual[1].bias[:128].copy_(small.residual[1].bias)
        head.residual[4].weight.zero_()
        head.residual[4].weight[:, :128].copy_(small.residual[4].weight)
        head.residual[4].bias.copy_(small.residual[4].bias)
        probe = torch.randn(64, 256)
        torch.testing.assert_close(head.eval()(probe), small.eval()(probe), atol=1e-5, rtol=1e-5)
    return head


def main():
    OUT.mkdir()
    torch.set_num_threads(2)
    torch.manual_seed(SEED)
    config = json.loads(Path("resume/adapter_config.json").read_text())
    assert config["base_weight_sha256"] == sha("model-package/model.safetensors")
    assert config["material_labels"] == LABELS and config["dms_ids"] == IDS
    model = Mask2FormerForUniversalSegmentation.from_pretrained("model-package", local_files_only=True).requires_grad_(False).eval()
    pixel = model.model.pixel_level_module
    before = [fingerprint(pixel.encoder), fingerprint(pixel.decoder)]
    paths, hist = get_features(model)
    after = [fingerprint(pixel.encoder), fingerprint(pixel.decoder)]
    assert before == after
    del model, pixel
    small = MaterialHead()
    small.load_state_dict(load_file("resume/material-head.safetensors"))
    heads = {"control": small, "wide": widen(small)}
    history, best = {}, {}
    weights = torch.tensor((hist.max() / np.maximum(hist, 1)) ** 0.25, dtype=torch.float32).clamp(max=6)
    for name, head in heads.items():
        torch.manual_seed(SEED)
        opt = torch.optim.AdamW(head.parameters(), lr=0.00002)
        baseline = evaluate(head, cached(paths["validation"]))
        history[name] = [{"epoch": 0, "validation": baseline}]
        best[name] = 0
        target = str(OUT / f"{name}-best.safetensors")
        save_file(head.state_dict(), target)
        for epoch in range(1, EPOCHS + 1):
            head.train()
            order = paths["train"].copy()
            random.Random(SEED + epoch).shuffle(order)
            losses = []
            for i in range(0, len(order), 16):
                samples = list(cached(order[i:i + 16]))
                x = torch.from_numpy(np.concatenate([a for a, b in samples]))
                y = torch.from_numpy(np.concatenate([b for a, b in samples]))
                opt.zero_grad(set_to_none=True)
                loss = F.cross_entropy(head(x), y, weight=weights)
                if not torch.isfinite(loss):
                    raise ValueError("Nonfinite training loss")
                loss.backward()
                opt.step()
                losses.append(loss.item())
            val = evaluate(head, cached(paths["validation"]))
            history[name].append({"epoch": epoch, "train_loss": float(np.mean(losses)), "validation": val})
            if val["material"]["miou"] > history[name][best[name]]["validation"]["material"]["miou"]:
                best[name] = epoch
                save_file(head.state_dict(), target)
            print("EPOCH", name, epoch, val["material"]["miou"], flush=True)
    write("history.json", history)
    write("report.json", {"best_epochs": best, "train": len(paths["train"]), "validation": len(paths["validation"]),
                          "test_evaluated": False, "encoder_sha256": before[0], "decoder_sha256": before[1],
                          "parent": "interiors-trained-44258922982", "base_sha256": config["base_weight_sha256"],
                          "hidden_width": WIDTH, "classes": LABELS,
                          "parameters": {k: sum(p.numel() for p in h.parameters()) for k, h in heads.items()}})
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    for name, records in history.items():
        axes[0].plot(range(1, EPOCHS+1), [r["train_loss"] for r in records[1:]], label=name)
        axes[1].plot([r["validation"]["loss"] for r in records], label=name)
        axes[2].plot([100*r["validation"]["material"]["miou"] for r in records], label=name)
    for ax, label in zip(axes, ["Training loss", "Validation loss", "Validation mIoU (%)"]):
        ax.set(xlabel="Epoch", ylabel=label)
        ax.legend()
    fig.tight_layout()
    fig.savefig(OUT / "learning-curves.png")


if __name__ == "__main__":
    main()
