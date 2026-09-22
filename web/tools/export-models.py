"""Export the distilled SCENE student to ONNX + int8.

The angle student was exported during the research loop; the scene one never
was -- webbench/models/student*.onnx are BOTH the 5-class angle model at two
quantizations. Scene timings measured against them stay valid (identical
MobileNetV3-small at 224), but the browser client needs the real 4-class head.

Class order is recomputed the same way distill_scene.py derived it:
Counter.most_common() filtered to >=25 examples, which is deterministic for a
fixed teacher-label file.
"""
import json
from collections import Counter
from pathlib import Path

import torch
import torch.nn as nn
from torchvision.models import mobilenet_v3_small

OUT = Path("bench_out")
MODELS = Path("webbench/models")

lab = json.loads((OUT / "scene_teacher_labels.json").read_text())
dist = Counter(v["label"] for v in lab.values())
classes = [c for c, n in dist.most_common() if n >= 25]
print(f"scene classes (index order): {classes}")

m = mobilenet_v3_small(weights=None)
m.classifier[3] = nn.Linear(m.classifier[3].in_features, len(classes))
m.load_state_dict(torch.load(OUT / "scene_student.pt", map_location="cpu"))
m.eval()

fp32 = MODELS / "scene_student.onnx"
torch.onnx.export(
    m, torch.zeros(1, 3, 224, 224), fp32,
    input_names=["input"], output_names=["logits"],
    opset_version=17, dynamo=False,
)
print(f"exported {fp32} ({fp32.stat().st_size/1e6:.2f} MB)")

from onnxruntime.quantization import quantize_dynamic, QuantType
int8 = MODELS / "scene_student_int8.onnx"
quantize_dynamic(fp32, int8, weight_type=QuantType.QUInt8)
print(f"quantized {int8} ({int8.stat().st_size/1e6:.2f} MB)")

(MODELS / "labels.json").write_text(json.dumps({
    "scene": classes,
    "angle": ["front", "front_3q", "side", "rear_3q", "rear"],
}, indent=2))
print("wrote labels.json")
