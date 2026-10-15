from pathlib import Path
import json

root = Path(__file__).parent
pages = json.loads((root/'report_lines.json').read_text(encoding='utf-8'))
out = Path('output/report-review')
out.mkdir(parents=True,exist_ok=True)
text = ['NUMBERED TEXT REFERENCE FOR THE PROJECT REPORT',
        'PDF page means the page position in the 82-page PDF. Printed page means the number shown in the report.',
        'L numbers identify nonempty extracted text lines, including headings and captions but excluding the standalone page number.',
        'Text inside images is not extracted. Equations and multi-column tables may be split or interleaved; use the named equation/table row and the original PDF for those items.',
        'This is a locator transcript, not a corrected copy; PDF extraction can distort mathematical symbols.']
for page in pages:
    ls=page['lines']
    label='unnumbered cover' if page['page']==1 else ls[0]['text']
    body=ls if page['page']==1 else ls[1:]
    text.append(f'\n=== Printed page {label} | PDF page {page["page"]} ===')
    text += [f'L{i:02}  {line["text"]}' for i,line in enumerate(body,1)]
(out/'Report_numbered_text.txt').write_text('\n'.join(text),encoding='utf-8')
print(out.resolve())
