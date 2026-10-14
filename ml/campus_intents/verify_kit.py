"""Local functional smoke test only. Fixture accuracy is NOT model quality."""
import ast
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from core import feature_counts, load_dataset, normalize, read_catalog, prototype_catalog
from train import loss_and_gradients, calibrate

ROOT = Path(__file__).resolve().parent
catalog, labels = read_catalog(ROOT / "catalog.json")
assert len(labels) == len(set(labels)) == 39
assert normalize("  ＣＳＥ ３０２?! ") == "cse 302"
assert feature_counts("") == {}

# Finite differences catch mistakes in the from-scratch neural gradients.
rng = np.random.default_rng(123)
x = rng.random((3, 5))
y = np.array([0, 1, 0])
weights = [rng.random((5, 4)), rng.random(4), rng.random((4, 2)), rng.random(2)]
loss, gradients = loss_and_gradients(x, y, weights)
for index, weight in enumerate(weights):
    for offset in (0, weight.size - 1):
        original = weight.flat[offset]
        weight.flat[offset] = original + 1e-6
        plus, _ = loss_and_gradients(x, y, weights)
        weight.flat[offset] = original - 1e-6
        minus, _ = loss_and_gradients(x, y, weights)
        weight.flat[offset] = original
        assert abs((plus - minus) / 2e-6 - gradients[index].flat[offset]) < 1e-6
for _ in range(100):
    _, gradients = loss_and_gradients(x, y, weights)
    for weight, gradient in zip(weights, gradients):
        weight -= 0.1 * gradient
assert loss_and_gradients(x, y, weights)[0] < loss
print("PASS: from-scratch neural gradients and learning sanity")

# Perfect positive-only accuracy cannot justify enabling unknown rejection.
policy, _ = calibrate(np.array([[0.99, 0.01]] * 20), ['greeting'] * 20, ['greeting', 'building_finder'])
assert policy['enabled'] is False
print('PASS: missing negative validation labels disable model acceptance')

rows = []
for index, label in enumerate(labels):
    for split, prefix, count in [("train", "learning exercise", 2), ("validation", "checking generalization", 1), ("test", "independent trial", 1)]:
        for number in range(count):
            rows.append({"id": f"fixture-{index}-{split}-{number}", "text": f"{prefix} {label} variant {chr(97 + number)}",
                         "label": label, "group": f"fixture-{index}-{split}", "split": split, "language": "en"})
scratch = ROOT.parents[1] / "output/local-nav-check"
scratch.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=scratch) as directory:
    folder = Path(directory)
    dataset = folder / "fixture.jsonl"
    def write(values):
        dataset.write_text("\n".join(json.dumps(row) for row in values), encoding="utf-8")
    write(rows)
    _, summary = load_dataset([dataset], catalog, allow_small=True)
    assert summary["rows"] == 156
    try:
        load_dataset([dataset], catalog)
    except ValueError as error:
        assert "need at least" in str(error)
    else:
        raise AssertionError("Tiny fixture must fail real dataset minimums")
    for kind in ("duplicate", "group", "template"):
        bad = [dict(row) for row in rows]
        if kind == "duplicate":
            bad[2]["text"] = bad[0]["text"].upper()
        elif kind == "group":
            bad[2]["group"] = bad[0]["group"]
        else:
            bad[0]["text"], bad[2]["text"] = "locate the cse block", "locate the ece block"
        write(bad)
        try:
            load_dataset([dataset], catalog, allow_small=True)
        except ValueError:
            pass
        else:
            raise AssertionError(f"{kind} leakage was accepted")
    write(rows)
    partial = [row for row in rows if row['label'] in labels[:4]]
    write(partial)
    subset, missing = prototype_catalog([dataset], catalog)
    assert len(missing) == 35
    assert load_dataset([dataset], subset, allow_small=True)[1]['labels'] == 4
    try:
        load_dataset([dataset], catalog, allow_small=True)
    except ValueError:
        pass
    else:
        raise AssertionError('Partial dataset silently accepted as complete')
    write(rows)
    print("PASS: complete catalog, JSONL validation, tiny-data rejection and duplicate/group/template leakage rejection")
    output = folder / "trained_model"
    subprocess.run([sys.executable, str(ROOT / "train.py"), str(dataset), "--allow-small", "--epochs", "2", "--output", str(output)], check=True)
    report = json.loads((output / "report.json").read_text())
    model = json.loads((output / "model.json").read_text())
    assert report["dataset"]["allow_small"] and report["production_ready"] is False
    assert model["approved_for_production"] is False and report["weight_bytes"] < 1_000_000
    subprocess.run(["node", str(ROOT / "verify_runtime.mjs"), str(output)], check=True)
    # Preserve only a clearly named smoke artifact for browser verification.
    import shutil
    saved = scratch / "campus-ml-smoke-model"
    saved.mkdir(exist_ok=True)
    for file in output.iterdir():
        shutil.copy2(file, saved / file.name)

notebook = json.loads((ROOT / "Train_Campus_Intents.ipynb").read_text(encoding="utf-8"))
assert notebook["nbformat"] == 4
for cell in notebook["cells"]:
    if cell["cell_type"] == "code":
        ast.parse("".join(cell["source"]))
bootstrap = "".join(notebook["cells"][1]["source"])
expression = next(line.removeprefix("FILES=json.loads(").removesuffix(")") for line in bootstrap.splitlines() if line.startswith("FILES=json.loads("))
embedded = json.loads(ast.literal_eval(expression))
for name, text in embedded.items():
    assert text == (ROOT / name).read_text(encoding="utf-8"), f"Regenerate stale notebook: {name}"
print("PASS: notebook code cells parse; embedded training/browser sources match files")
print("SMOKE TEST ONLY: no Claude dataset, real model accuracy, Colab execution or phone performance has been verified.")
