"""Usage: python validate_dataset.py batch*.jsonl [--allow-small]."""
import argparse
import json
from pathlib import Path

from core import load_dataset, read_catalog, prototype_catalog

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("files", nargs="+")
parser.add_argument("--catalog", default=str(Path(__file__).with_name("catalog.json")))
parser.add_argument("--allow-small", action="store_true", help="Fixtures only; not a production dataset")
parser.add_argument("--prototype", action="store_true", help="Validate supplied labels only; report missing labels; not production-ready")
args = parser.parse_args()
catalog, _ = read_catalog(args.catalog)
missing = []
if args.prototype:
    catalog, missing = prototype_catalog(args.files, catalog)
_, summary = load_dataset(args.files, catalog, args.allow_small)
summary.update(prototype=args.prototype, missing_labels=missing)
print(json.dumps(summary, indent=2))
print("PASS: labels, IDs, exact duplicates, group/template leakage and split coverage")
