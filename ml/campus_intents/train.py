"""CPU training from scratch. NumPy only; no pretrained weights or live APIs."""
import argparse
import hashlib
import json
import os
import shutil
import time
import zipfile
from pathlib import Path

os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
import numpy as np  # noqa: E402

from core import FEATURES, REJECT_LABELS, feature_counts, load_dataset, metrics, read_catalog, prototype_catalog  # noqa: E402


def vectorize(rows):
    x = np.zeros((len(rows), FEATURES["bins"]), dtype=np.float32)
    for index, row in enumerate(rows):
        for bucket, count in feature_counts(row["text"]).items():
            x[index, bucket] = np.log1p(count)
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)


def probabilities(x, weights):
    w1, b1, w2, b2 = weights
    logits = np.maximum(0, x @ w1 + b1) @ w2 + b2
    exp = np.exp(logits - logits.max(axis=1, keepdims=True))
    return exp / exp.sum(axis=1, keepdims=True)


def loss_and_gradients(x, y, weights):
    w1, b1, w2, b2 = weights
    z = x @ w1 + b1
    hidden = np.maximum(0, z)
    logits = hidden @ w2 + b2
    exp = np.exp(logits - logits.max(axis=1, keepdims=True))
    probs = exp / exp.sum(axis=1, keepdims=True)
    loss = -np.log(np.maximum(probs[np.arange(len(y)), y], 1e-12)).mean()
    delta = probs.copy()
    delta[np.arange(len(y)), y] -= 1
    delta /= len(y)
    dh = (delta @ w2.T) * (z > 0)
    return float(loss), [x.T @ dh, dh.sum(axis=0), hidden.T @ delta, delta.sum(axis=0)]


def decisions(probs, labels, confidence, margin):
    order = np.argsort(-probs, axis=1, kind="stable")
    top, runner = order[:, 0], order[:, 1]
    accepted = [(labels[t] not in REJECT_LABELS and float(probs[i, t]) >= confidence
                 and float(probs[i, t] - probs[i, r]) >= margin) for i, (t, r) in enumerate(zip(top, runner))]
    return [labels[i] for i in top], accepted


def calibrate(probs, truth, labels):
    # Validation only. Test labels must never choose thresholds or weights.
    # No negative examples means rejection reliability was not measured.
    if not REJECT_LABELS.issubset(set(truth)):
        predicted, accepted = decisions(probs, labels, 1.01, 1.01)
        return {"enabled": False, "confidence": 1.01, "margin": 1.01}, metrics(truth, predicted, labels, accepted)
    best = None
    for confidence in (0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95):
        for margin in (0.05, 0.10, 0.15, 0.20):
            predicted, accepted = decisions(probs, labels, confidence, margin)
            score = metrics(truth, predicted, labels, accepted)
            if sum(accepted) >= 10 and score["accepted_precision"] >= 0.97 and score["out_of_scope_false_accept_rate"] <= 0.02:
                if best is None or score["coverage"] > best[2]["coverage"]:
                    best = (confidence, margin, score)
    if best is None:
        predicted, accepted = decisions(probs, labels, 1.01, 1.01)
        return {"enabled": False, "confidence": 1.01, "margin": 1.01}, metrics(truth, predicted, labels, accepted)
    return {"enabled": True, "confidence": best[0], "margin": best[1]}, best[2]


def train(args):
    root = Path(__file__).resolve().parent
    catalog, labels = read_catalog(root / "catalog.json")
    missing = []
    if getattr(args, "prototype", False):
        # Explicit subset experiment: retain the normal count/leakage checks.
        catalog, missing = prototype_catalog(args.files, catalog)
        labels = [item["label"] for item in catalog["labels"]]
    rows, summary = load_dataset(args.files, catalog, args.allow_small)
    summary.update(prototype=getattr(args, "prototype", False), missing_labels=missing)
    groups = {split: [row for row in rows if row["split"] == split] for split in ("train", "validation", "test")}
    features = {split: vectorize(data) for split, data in groups.items()}
    targets = {split: np.array([labels.index(row["label"]) for row in data]) for split, data in groups.items()}
    rng = np.random.default_rng(args.seed)
    weights = [(rng.standard_normal((FEATURES["bins"], 64)) * np.sqrt(2 / FEATURES["bins"])).astype(np.float32),
               np.zeros(64, dtype=np.float32), (rng.standard_normal((64, len(labels))) * np.sqrt(2 / 64)).astype(np.float32),
               np.zeros(len(labels), dtype=np.float32)]
    first, second = [np.zeros_like(w) for w in weights], [np.zeros_like(w) for w in weights]
    best, best_loss, stale, step = None, float("inf"), 0, 0
    history, started = [], time.monotonic()
    for epoch in range(args.epochs):
        order = rng.permutation(len(groups["train"]))
        for start in range(0, len(order), 64):
            batch = order[start:start + 64]
            _, grads = loss_and_gradients(features["train"][batch], targets["train"][batch], weights)
            step += 1
            for index, (weight, grad) in enumerate(zip(weights, grads)):
                first[index] = 0.9 * first[index] + 0.1 * grad
                second[index] = 0.999 * second[index] + 0.001 * grad * grad
                update = (first[index] / (1 - 0.9 ** step)) / (np.sqrt(second[index] / (1 - 0.999 ** step)) + 1e-8)
                weight -= 0.002 * (update + (0.0001 * weight if index in (0, 2) else 0))
        val = probabilities(features["validation"], weights)
        val_loss = float(-np.log(np.maximum(val[np.arange(len(val)), targets["validation"]], 1e-12)).mean())
        if not np.isfinite(val_loss):
            raise ValueError("Training diverged; no model exported")
        history.append({"epoch": epoch + 1, "validation_loss": val_loss})
        print(f"Epoch {epoch + 1}: validation loss {val_loss:.4f}", flush=True)
        if val_loss < best_loss - 0.0001:
            best_loss, best, stale = val_loss, [w.copy() for w in weights], 0
        else:
            stale += 1
            if stale >= 7:
                break
    weights = best
    val_probs = probabilities(features["validation"], weights)
    policy, validation = calibrate(val_probs, [r["label"] for r in groups["validation"]], labels)
    if getattr(args, "prototype", False):
        policy = {"enabled": False, "confidence": 1.01, "margin": 1.01}
        predicted, accepted = decisions(val_probs, labels, 1.01, 1.01)
        validation = metrics([r["label"] for r in groups["validation"]], predicted, labels, accepted)
    test_probs = probabilities(features["test"], weights)
    predicted, accepted = decisions(test_probs, labels, policy["confidence"], policy["margin"])
    test = metrics([r["label"] for r in groups["test"]], predicted, labels, accepted)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    binary = b"".join(w.astype("<f4").tobytes() for w in weights)
    if len(binary) > 1_000_000:
        raise ValueError("Model exceeds the 1 MB weight budget")
    (output / "weights.bin").write_bytes(binary)
    sha = hashlib.sha256(binary).hexdigest()
    model = {"schema": 1, "model_id": "campus-" + sha[:12], "features": FEATURES, "hidden": 64,
             "labels": labels, "weights": {"file": "weights.bin", "bytes": len(binary), "sha256": sha},
             "decision": policy, "training": {"seed": args.seed, "dataset_sha256": summary["sha256"], "from_scratch": True,
                                             "prototype": summary["prototype"], "missing_labels": missing},
             "approved_for_production": False}
    report = {"dataset": summary, "validation": validation, "test": test, "history": history,
              "seconds": time.monotonic() - started, "numpy_version": np.__version__, "weight_bytes": len(binary),
              "decision": policy, "production_ready": False,
              "remaining": ["Review synthetic labels and obtain independently written student questions.",
                            "Benchmark on actual Android/iOS phones alongside map navigation.",
                            "Do not execute actions from a label without entity/context validation."]}
    for name, value in (("model.json", model), ("report.json", report), ("catalog.json", catalog)):
        (output / name).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    cases = []
    for text in [r["text"] for r in groups["test"][:20]] + ["", "ECE 302", "food enga iruku?", "Ｄｏｎ’ｔ stop navigation", "தமிழ்"]:
        probs = probabilities(vectorize([{"text": text}]), weights)[0]
        cases.append({"text": text, "probabilities": probs.tolist(), "counts": dict(feature_counts(text))})
    (output / "conformance.json").write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8")
    for source in (root / "phone-test").iterdir():
        shutil.copy2(source, output / source.name)
    archive = output.parent / "model_bundle.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for file in output.iterdir():
            if file.is_file():
                bundle.write(file, file.name)
    print(json.dumps({"test_accuracy": test["accuracy"], "macro_f1": test["macro_f1"],
                      "accepted_precision": test["accepted_precision"], "coverage": test["coverage"],
                      "model_enabled": policy["enabled"], "weight_bytes": len(binary), "bundle": str(archive)}, indent=2))
    return model, report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+")
    parser.add_argument("--output", default="trained_model")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--allow-small", action="store_true", help="Fixture smoke tests only")
    parser.add_argument("--prototype", action="store_true", help="Train supplied labels only; disable acceptance; never a production model")
    arguments = parser.parse_args()
    if not 1 <= arguments.epochs <= 200:
        parser.error("--epochs must be between 1 and 200")
    train(arguments)
