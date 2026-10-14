"""Dataset and feature contract shared by validation, training and browser tests."""
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

FEATURES = {"bins": 2048, "min_n": 3, "max_n": 5, "max_chars": 200,
            "hash": "fnv1a32-utf8", "normalization": "nfkc-lower-punctuation-whitespace-v1"}
REJECT_LABELS = {"unknown", "out_of_scope"}


def normalize(text):
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"\s+", " ", re.sub(r"[?!.,;:'\"]", " ", text)).strip()[:FEATURES["max_chars"]]


def hash32(text):
    value = 2166136261
    for byte in text.encode("utf-8"):
        value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
    return value


def feature_counts(text, config=FEATURES):
    text = normalize(text)
    counts = Counter()
    if not text:
        return counts
    padded = " " + text + " "
    for n in range(config["min_n"], config["max_n"] + 1):
        for start in range(len(padded) - n + 1):
            counts[hash32("c:" + padded[start:start + n]) % config["bins"]] += 1
    words = text.split()
    for word in words:
        counts[hash32("w:" + word) % config["bins"]] += 1
    for left, right in zip(words, words[1:]):
        counts[hash32("b:" + left + " " + right) % config["bins"]] += 1
    return counts


def read_catalog(path):
    catalog = json.loads(Path(path).read_text(encoding="utf-8"))
    return catalog, [item["label"] for item in catalog["labels"]]


def family_key(text, aliases):
    # Finds identical templates with different campus names/numbers. It cannot
    # prove semantic independence; human-authored testing remains necessary.
    text = normalize(text)
    for alias in aliases:
        text = re.sub(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", "<place>", text)
    return re.sub(r"\d+", "<number>", text)


def prototype_catalog(paths, catalog):
    """Explicit partial-data experiment; never used by full-dataset validation."""
    supplied = {json.loads(line)["label"] for path in paths
                for line in Path(path).read_text(encoding="utf-8-sig").splitlines() if line.strip()}
    missing = [item["label"] for item in catalog["labels"] if item["label"] not in supplied]
    subset = {**catalog, "labels": [item for item in catalog["labels"] if item["label"] in supplied]}
    if len(subset["labels"]) < 2:
        raise ValueError("Prototype needs at least two known labels")
    return subset, missing


def load_dataset(paths, catalog, allow_small=False):
    labels = {item["label"] for item in catalog["labels"]}
    aliases = sorted({normalize(alias) for place in catalog["locations"]
                      for alias in [place["name"], place["id"].replace("-", " "), *place["aliases"]]
                      if len(normalize(alias)) > 2}, key=len, reverse=True)
    rows, identifiers, texts, groups, families = [], set(), {}, {}, {}
    for path in paths:
        for line_number, line in enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSONL") from error
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{line_number}: expected an object")
            for field in ("id", "text", "label", "group", "split", "language"):
                if not isinstance(row.get(field), str) or not row[field].strip():
                    raise ValueError(f"{path}:{line_number}: missing/non-string {field}")
            if len(row["text"]) > FEATURES["max_chars"] or not normalize(row["text"]):
                raise ValueError(f"{row['id']}: text must contain 1..200 characters")
            if row["id"] in identifiers:
                raise ValueError(f"Duplicate id: {row['id']}")
            if row["label"] not in labels or row["split"] not in ("train", "validation", "test"):
                raise ValueError(f"{row['id']}: unknown label or split")
            if row["language"] not in ("en", "tanglish"):
                raise ValueError(f"{row['id']}: language must be en or tanglish")
            key = normalize(row["text"])
            if key in texts:
                raise ValueError(f"Duplicate normalized text: {row['id']} and {texts[key]}")
            if row["group"] in groups and groups[row["group"]] != row["split"]:
                raise ValueError(f"Group leaks across splits: {row['group']}")
            family = family_key(row["text"], aliases)
            if family in families and families[family] != row["split"]:
                raise ValueError(f"Location/number template leaks across splits: {row['id']}")
            identifiers.add(row["id"])
            texts[key], groups[row["group"]], families[family] = row["id"], row["split"], row["split"]
            rows.append(row)
    counts = Counter((row["label"], row["split"]) for row in rows)
    minimums = {"train": 2, "validation": 1, "test": 1} if allow_small else {"train": 60, "validation": 10, "test": 10}
    for label in sorted(labels):
        for split, minimum in minimums.items():
            if counts[label, split] < minimum:
                raise ValueError(f"{label}/{split}: {counts[label, split]} rows; need at least {minimum}")
    summary = {"rows": len(rows), "labels": len(labels),
               "splits": dict(Counter(row["split"] for row in rows)),
               "languages": dict(Counter(row["language"] for row in rows)),
               "groups": len(groups), "allow_small": allow_small,
               "sha256": hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()).hexdigest()}
    return rows, summary


def metrics(truth, predicted, labels, accepted):
    count = len(truth)
    per_class = {}
    for label in labels:
        tp = sum(t == p == label for t, p in zip(truth, predicted))
        fp = sum(t != label and p == label for t, p in zip(truth, predicted))
        fn = sum(t == label and p != label for t, p in zip(truth, predicted))
        per_class[label] = {"support": truth.count(label), "precision": tp / max(1, tp + fp),
                            "recall": tp / max(1, tp + fn), "f1": 2 * tp / max(1, 2 * tp + fp + fn)}
    total_accepted = sum(accepted)
    rejects = sum(t in REJECT_LABELS for t in truth)
    return {"samples": count, "accuracy": sum(t == p for t, p in zip(truth, predicted)) / max(1, count),
            "macro_f1": sum(item["f1"] for item in per_class.values()) / len(labels),
            "coverage": total_accepted / max(1, count),
            "accepted_precision": sum(t == p and a for t, p, a in zip(truth, predicted, accepted)) / max(1, total_accepted),
            "out_of_scope_false_accept_rate": sum(t in REJECT_LABELS and a for t, a in zip(truth, accepted)) / max(1, rejects),
            "per_class": per_class}
