"""Train the browser's scene classifier on the library's own filing.

The first student was distilled from raw CLIP labels and inherited
CLIP's cabin-versus-detail confusion (measured 2026-09-23: 72% on the
library's exteriors, a quarter called "detail", confident when wrong).
The command line's full cascade files every photo it keeps, so the
library IS the better teacher:

  images/exterior/NN.jpg with a cutout        -> exterior (a body shot)
  images/exterior/NN.jpg without one, wheels  -> detail   (a close-up)
  images/interior/NN.jpg                      -> interior (anything cabin)

"marketing" has no examples on disk (the CLI drops those), so the new
head has three classes; a banner lands in detail and the cutout gates
keep it out of the stills either way. Held out by vehicle folder, not
by photo, so a gallery's near-duplicates cannot leak.

  .venv/bin/python web/tools/train-scene.py [--library ~/Documents/listings] [--epochs 8]

Writes web/public/models/scene.onnx (fp32: int8 breaks these heads, see
web/README.md) and updates labels.json's scene order, which the browser
reads; config.js carries the file's byte count for the download meter.
"""
from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms as T
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

REPO = Path(__file__).resolve().parents[2]
MODELS = REPO / "web" / "public" / "models"
CLASSES = ["interior", "exterior", "detail"]
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]


def gather(library: Path) -> list[tuple[Path, int, str]]:
    rows = []
    for ext_dir in library.glob("*/*/images/exterior"):
        vehicle = ext_dir.parent.parent.name
        cuts = {p.stem for p in (ext_dir / "cutout").glob("*.png")} if (ext_dir / "cutout").is_dir() else set()
        for f in ext_dir.glob("*.jpg"):
            rows.append((f, CLASSES.index("exterior" if f.stem in cuts else "detail"), vehicle))
        int_dir = ext_dir.parent / "interior"
        if int_dir.is_dir():
            for f in int_dir.glob("*.jpg"):
                rows.append((f, CLASSES.index("interior"), vehicle))
    return rows


class Photos(Dataset):
    def __init__(self, rows, train):
        self.rows = rows
        # The browser stretches the photo to a 224 square (imageio.resizeTo),
        # so the eval transform stretches too and training crops are
        # stretched back to the same square.
        self.tf = T.Compose([
            T.RandomResizedCrop((224, 224), scale=(0.55, 1.0), ratio=(0.7, 1.45)),
            T.RandomHorizontalFlip(),
            T.ColorJitter(0.3, 0.3, 0.2, 0.03),
            T.ToTensor(), T.Normalize(MEAN, STD),
        ]) if train else T.Compose([T.Resize((224, 224)), T.ToTensor(), T.Normalize(MEAN, STD)])

    def __len__(self): return len(self.rows)

    def __getitem__(self, i):
        f, y, _ = self.rows[i]
        try:
            im = Image.open(f).convert("RGB")
        except Exception:
            im = Image.new("RGB", (224, 224))
        return self.tf(im), y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", default=str(Path.home() / "Documents" / "listings"))
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--holdout", type=float, default=0.1)
    ap.add_argument("--check", nargs="*", default=[], help="extra photos to print predictions for")
    ap.add_argument("--export-only", action="store_true", help="export models/scene_student.pt without training")
    args = ap.parse_args()
    random.seed(7); torch.manual_seed(7)
    if args.export_only:
        model = mobilenet_v3_small(weights=None)
        model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(CLASSES))
        model.load_state_dict(torch.load(MODELS / "scene_student.pt", map_location="cpu"))
        export(model, args.check)
        return

    rows = gather(Path(args.library).expanduser())
    vehicles = sorted({v for _, _, v in rows})
    random.shuffle(vehicles)
    held = set(vehicles[: max(1, int(len(vehicles) * args.holdout))])
    train = [r for r in rows if r[2] not in held]
    val = [r for r in rows if r[2] in held]
    print(f"{len(rows)} photos from {len(vehicles)} vehicles; train {len(train)}, val {len(val)} ({len(held)} vehicles held out)")
    print("train classes:", {CLASSES[k]: n for k, n in sorted(Counter(y for _, y, _ in train).items())})

    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(CLASSES))
    model.to(dev)
    counts = Counter(y for _, y, _ in train)
    weights = torch.tensor([len(train) / (len(CLASSES) * counts[k]) for k in range(len(CLASSES))], dtype=torch.float32, device=dev)
    loss_fn = nn.CrossEntropyLoss(weight=weights, label_smoothing=0.05)
    opt = torch.optim.AdamW(model.parameters(), lr=4e-4, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=4e-4, total_steps=args.epochs * ((len(train) + args.batch - 1) // args.batch))
    dl = DataLoader(Photos(train, True), batch_size=args.batch, shuffle=True, num_workers=6, drop_last=False, persistent_workers=True)
    dv = DataLoader(Photos(val, False), batch_size=args.batch, shuffle=False, num_workers=4)

    def evaluate():
        model.eval(); conf = np.zeros((len(CLASSES), len(CLASSES)), dtype=int)
        with torch.no_grad():
            for x, y in dv:
                pred = model(x.to(dev)).argmax(1).cpu().numpy()
                for t, p in zip(y.numpy(), pred): conf[t, p] += 1
        acc = np.trace(conf) / max(1, conf.sum())
        return acc, conf

    for epoch in range(args.epochs):
        model.train(); total = 0.0; n = 0
        for x, y in dl:
            x, y = x.to(dev), y.to(dev)
            opt.zero_grad(); loss = loss_fn(model(x), y); loss.backward(); opt.step(); sched.step()
            total += loss.item() * len(y); n += len(y)
        acc, conf = evaluate()
        print(f"epoch {epoch + 1}/{args.epochs}: loss {total / n:.3f}, held-out accuracy {acc:.3f}")
    print("held-out confusion (rows truth, cols predicted; order", CLASSES, "):")
    print(conf)
    per = {CLASSES[k]: f"{conf[k, k] / max(1, conf[k].sum()):.3f}" for k in range(len(CLASSES))}
    print("per-class recall:", per)

    export(model, args.check)


def export(model, check):
    model.eval().cpu()
    # fp32 on purpose: int8 breaks these MobileNetV3 heads (web/README.md,
    # "Why the classifiers are fp32"). The checkpoint is kept beside it.
    torch.save(model.state_dict(), MODELS / "scene_student.pt")
    out = MODELS / "scene.onnx"
    torch.onnx.export(model, torch.zeros(1, 3, 224, 224), out, input_names=["input"], output_names=["logits"], opset_version=17, dynamo=False)
    labels = json.loads((MODELS / "labels.json").read_text())
    labels["scene"] = CLASSES
    (MODELS / "labels.json").write_text(json.dumps(labels, indent=2) + "\n")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB) and labels.json")
    if check:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
        tf = T.Compose([T.Resize((224, 224)), T.ToTensor(), T.Normalize(MEAN, STD)])
        for f in check:
            x = tf(Image.open(f).convert("RGB")).numpy()[None]
            z = sess.run(None, {"input": x})[0][0]; p = np.exp(z - z.max()); p /= p.sum()
            print(f"  {Path(f).name}: {CLASSES[int(p.argmax())]} {p.max():.2f}")


if __name__ == "__main__":
    main()
