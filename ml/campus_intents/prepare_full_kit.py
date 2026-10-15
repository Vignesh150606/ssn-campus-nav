"""Build an ignored self-contained Colab notebook; never publish raw datasets."""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT.parents[1] / 'output/local-nav-check'


def cell(kind, source):
    value = {'cell_type': kind, 'metadata': {}, 'source': source.splitlines(keepends=True)}
    if kind == 'code':
        ast.parse(source)
        value.update(execution_count=None, outputs=[])
    return value


def main():
    names = ['core.py', 'train.py', 'catalog.json', 'validate_dataset.py',
             'build_next_batches.py', 'challenge_examples.py', 'evaluate_challenge.py',
             'phone-test/runtime.mjs', 'phone-test/worker.mjs', 'phone-test/index.html']
    contents = {name: (ROOT / name).read_text(encoding='utf-8') for name in names}
    contents['data/b01.jsonl'] = (ROOT / 'data/b01.jsonl').read_text(encoding='utf-8')
    bootstrap = (
        "from pathlib import Path\nimport os,json,sys,subprocess,zipfile\n"
        "os.environ['OPENBLAS_NUM_THREADS']='2'\nROOT=Path('/content/ssn-full-english-v2')\nROOT.mkdir(exist_ok=True)\n"
        'FILES=json.loads(' + repr(json.dumps(contents)) + ')\n'
        "for name,text in FILES.items():\n    p=ROOT/name\n    p.parent.mkdir(parents=True,exist_ok=True)\n    p.write_text(text,encoding='utf-8')\n"
        "subprocess.run([sys.executable,str(ROOT/'build_next_batches.py')],cwd=ROOT,check=True)\n"
        "DATA=sorted(str(p) for p in (ROOT/'data/english-next').glob('b*.jsonl'))\n"
        "print('Full dataset ready; no external uploads needed.')\n")
    train = (
        "subprocess.run([sys.executable,str(ROOT/'train.py'),*DATA,'--epochs','80','--seed','42','--output',str(ROOT/'model')],cwd=ROOT,check=True)\n"
        "report=json.loads((ROOT/'model/report.json').read_text())\n"
        "print(json.dumps({key:report[key] for key in ['dataset','decision','weight_bytes']},indent=2))\n"
        "print('Synthetic test:',{k:v for k,v in report['test'].items() if k!='per_class'})\n")
    audit = (
        "subprocess.run([sys.executable,str(ROOT/'evaluate_challenge.py'),str(ROOT/'model'),*DATA],cwd=ROOT,check=True)\n"
        "print('Automatic acceptance MUST stay off if its validation gate fails. Phone/student tests remain necessary.')\n"
        "with zipfile.ZipFile(ROOT/'full-campus-model.zip','w',zipfile.ZIP_DEFLATED) as z:\n"
        "    for p in (ROOT/'model').iterdir():\n        if p.is_file():z.write(p,p.name)\n"
        "from google.colab import files\nfiles.download(str(ROOT/'full-campus-model.zip'))\n")
    cells = [cell('markdown', '# Full English-focused campus intent training\n'
                  'Self-contained, from scratch, CPU/NumPy only. No dataset upload widget, API key, GPU, clone or paid service. '
                  'Original b01 is preserved; all 35 new labels are English. These synthetic scores are NOT real-world guarantees. '
                  'A failed confidence gate must not be bypassed. This notebook contains synthetic training examples: keep it local.\n'),
             cell('code', bootstrap), cell('code', train), cell('code', audit)]
    for index, value in enumerate(cells):
        value['id'] = f'full-english-{index}'
    notebook = {'nbformat': 4, 'nbformat_minor': 5, 'cells': cells, 'metadata': {
        'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
        'language_info': {'name': 'python'}, 'colab': {'name': 'Train_Full_Campus_English.ipynb'}}}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / 'Train_Full_Campus_English.ipynb'
    path.write_text(json.dumps(notebook, indent=1, ensure_ascii=False), encoding='utf-8')
    print(path)


if __name__ == '__main__':
    main()
