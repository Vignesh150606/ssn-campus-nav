from pathlib import Path
import json
import pdfplumber

out = Path(__file__).parent
sources = {
    'report': Path(r'D:\Downloads\B18_EEE_Project_Report_Phase1_Final_Polished (1) (1) (1) (1).pdf'),
    'guidelines': Path(r'D:\Downloads\Guidelines-UG Project Report_183713e8bf892765a3bc6bbcfc83d0b0.pdf'),
}
for name, src in sources.items():
    data = []
    chunks = []
    with pdfplumber.open(src) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            lines = page.extract_text_lines(layout=False, strip=True)
            record = {'page': i, 'width': page.width, 'height': page.height,
                      'lines': [{'n': n, 'text': l['text'], 'top': l['top'], 'bottom': l['bottom'], 'x0': l['x0'], 'x1': l['x1']} for n,l in enumerate(lines,1)],
                      'fonts': sorted(set((c['fontname'], round(c['size'],2)) for c in page.chars)),
                      'images': len(page.images)}
            data.append(record)
            chunks.append(f'\n=== PDF PAGE {i} ({page.width} x {page.height}) ===\n' + '\n'.join(f"{l['n']:02}: {l['text']}" for l in record['lines']))
    (out / f'{name}_lines.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
    (out / f'{name}_lines.txt').write_text('\n'.join(chunks), encoding='utf-8')
    print(name, len(data), 'pages')
