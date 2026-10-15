"""One-time independent *synthetic* audit of an exported model; never tuning."""
import argparse
import json
import hashlib
from pathlib import Path

import numpy as np
from core import metrics, normalize, feature_counts, REJECT_LABELS
from train import vectorize, probabilities, decisions
from challenge_examples import EXAMPLES


def evaluate(folder, training_files):
    folder = Path(folder)
    manifest = json.loads((folder / 'model.json').read_text())
    labels = manifest['labels']
    assert set(EXAMPLES) == set(labels)
    raw = (folder / 'weights.bin').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest['weights']['sha256']
    values = np.frombuffer(raw, dtype='<f4')
    first, count = 2048 * 64, len(labels)
    weights = [values[:first].reshape(2048, 64), values[first:first + 64],
               values[first + 64:first + 64 + 64 * count].reshape(64, count), values[-count:]]
    examples = [{'text': text, 'label': label} for label, texts in EXAMPLES.items() for text in texts]
    seen = {normalize(json.loads(line)['text']) for path in training_files
            for line in Path(path).read_text(encoding='utf-8-sig').splitlines() if line.strip()}
    overlaps = [r['text'] for r in examples if normalize(r['text']) in seen]
    if overlaps:
        raise ValueError(f'Challenge overlaps dataset: {overlaps}')
    policy = manifest['decision']
    probs = probabilities(vectorize(examples), weights)
    predictions, accepted = decisions(probs, labels, policy['confidence'], policy['margin'])
    if not policy['enabled']:
        accepted = [False] * len(examples)
    score = metrics([r['label'] for r in examples], predictions, labels, accepted)
    cases = [{**row, 'predicted': predicted, 'accepted': bool(ok), 'confidence': float(max(prob))}
             for row, predicted, ok, prob in zip(examples, predictions, accepted, probs)]
    result = {'source': 'Separately authored synthetic English challenge; NOT independent student evaluation',
              'sha256': hashlib.sha256(json.dumps(examples, sort_keys=True).encode()).hexdigest(),
              'model_id': manifest['model_id'], 'score': score, 'cases': cases,
              'accepted_wrong': sum(ok and row['label'] != predicted for row, predicted, ok in zip(examples, predictions, accepted)),
              'reject_false_accepts': sum(ok and row['label'] in REJECT_LABELS for row, ok in zip(examples, accepted)),
              'production_ready': False}
    (folder / 'challenge-report.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ['cases', 'score']}, indent=2))
    print(json.dumps({k:v for k,v in score.items() if k != 'per_class'}, indent=2))
    # Broaden cross-language conformance to ALL classes, not just the first 20.
    conformance = []
    for row, prob in zip(examples, probs):
        conformance.append({'text': row['text'], 'label': row['label'], 'counts': dict(feature_counts(row['text'])), 'probabilities': prob.tolist()})
    (folder / 'challenge-conformance.json').write_text(json.dumps(conformance), encoding='utf-8')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder')
    parser.add_argument('training_files', nargs='+')
    args = parser.parse_args()
    evaluate(args.folder, args.training_files)
